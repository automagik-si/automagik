// Official role packages come from Git blobs and use a fixed ustar/stored-deflate encoding.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSha256, parseRoleJson, plainObject, ROLE_EVIDENCE_LIMITS, roleDescription, roleName, validCapabilities,
} from '../apps/bots-dsh/src/host/role-catalog.js';
import { validateRoleManifest } from '../apps/bots-dsh/src/host/role-package.js';
import { MAX_ROLE_BYTES, MAX_ROLE_FILE_SIZE, MAX_ROLE_FILES, readRoleTar } from '../apps/bots-dsh/src/host/role-tar.js';
import { isPackageRoleId, isRoleVersion } from '../apps/bots-dsh/src/shared/roles.js';

const ROLE_ROOT = 'apps/bots-dsh/roles';
const PREFIX = 'automagik-role-';
const BLOCK = 512;
const TAR_RECORD = 10240;
const DEFLATE_BLOCK = 65535;
const [MAX_PACKAGE] = ROLE_EVIDENCE_LIMITS;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const compareNames = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const filename = (id: string, version: string) => `${PREFIX}${id}-${version}.tgz`;
const checksumLine = (name: string, digest: string) => `${digest}  ${name}\n`;

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 40 * 1024 * 1024 });
}

type RoleSource = Map<string, string>;
type RoleFiles = Map<string, Buffer>;

function sources(root: string, sha: string, neverShipped: (path: string) => boolean) {
  const roles = new Map<string, RoleSource>();
  // Include tree objects to refuse even an empty nested directory.
  const listing = utf8.decode(git(root, 'ls-tree', '-r', '-t', '-z', sha, '--', ROLE_ROOT));
  for (const item of listing.split('\0').filter(Boolean)) {
    const tab = item.indexOf('\t');
    const [mode, type, oid] = item.slice(0, tab).split(' ');
    const path = item.slice(tab + 1);
    if (type === 'tree' && (path === ROLE_ROOT || ROLE_ROOT.startsWith(`${path}/`))) continue;
    if (!path.startsWith(`${ROLE_ROOT}/`)) throw new Error(`${path}: expected the role source directory`);
    const [id, file, ...nested] = path.slice(ROLE_ROOT.length + 1).split('/');
    if (!isPackageRoleId(id) || neverShipped(`${ROLE_ROOT}/${id}/role.json`)) {
      throw new Error(`${path}: invalid or never-shipped role id`);
    }
    if (!file && type === 'tree') {
      roles.set(id, new Map());
      continue;
    }
    if (!file || nested.length || type !== 'blob' || !['100644', '100755'].includes(mode) || neverShipped(path)) {
      throw new Error(`${path}: expected a regular role file directly inside its role directory`);
    }
    const role = roles.get(id);
    if (!role) throw new Error(`${path}: missing role directory`);
    role.set(file, oid);
  }
  return roles;
}

function readLayout<T>(files: Map<string, T>, bytes: Buffer | undefined, label: string) {
  let manifest;
  try {
    if (!bytes) throw new Error('missing');
    manifest = parseRoleJson(bytes);
  } catch {
    throw new Error(`${label}: missing or invalid UTF-8 JSON in role.json`);
  }
  if (!plainObject(manifest) || files.size !== 3
      || new Set(['role.json', manifest.entry, manifest.prompt]).size !== 3
      || ![manifest.entry, manifest.prompt].every(file => typeof file === 'string' && files.has(file))) {
    throw new Error(`${label}: expected exactly role.json and its named entry and prompt files`);
  }
  return manifest;
}

function ustar(files: RoleFiles) {
  const entries = [...files].sort(([a], [b]) => compareNames(a, b));
  const padded = (length: number) => Math.ceil(length / BLOCK) * BLOCK;
  const length = entries.reduce((sum, [, bytes]) => sum + BLOCK + padded(bytes.length), 2 * BLOCK);
  const tarLength = Math.ceil(length / TAR_RECORD) * TAR_RECORD;
  if (entries.length > MAX_ROLE_FILES || tarLength > MAX_ROLE_BYTES) throw new Error('role archive exceeds the tar limits');
  const tar = Buffer.alloc(tarLength);
  let offset = 0;
  for (const [file, bytes] of entries) {
    const name = Buffer.from(`package/${file}`);
    if (name.length > 100) throw new Error(`${file}: ustar name exceeds 100 bytes`);
    if (bytes.length > MAX_ROLE_FILE_SIZE) throw new Error(`${file}: exceeds the role tar entry size limit`);
    const header = tar.subarray(offset, offset + BLOCK);
    name.copy(header);
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.fill(32, 148, 156);
    header.write('0', 156, 'ascii');
    header.write('ustar\x0000', 257, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    bytes.copy(tar, offset + BLOCK);
    offset += BLOCK + padded(bytes.length);
  }
  return tar;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc;
});

function gzip(tar: Buffer) {
  const blocks = Math.max(1, Math.ceil(tar.length / DEFLATE_BLOCK));
  const size = 10 + 5 * blocks + tar.length + 8;
  if (size > MAX_PACKAGE) throw new Error('role package exceeds the 16 MiB size limit');
  const bytes = Buffer.alloc(size);
  bytes.set([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]);
  let crc = 0xffffffff;
  for (const byte of tar) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  let offset = 10;
  for (let block = 0; block < blocks; block++) {
    const start = block * DEFLATE_BLOCK;
    const length = Math.min(DEFLATE_BLOCK, tar.length - start);
    bytes[offset] = Number(block === blocks - 1);
    bytes.writeUInt16LE(length, offset + 1);
    bytes.writeUInt16LE(length ^ 0xffff, offset + 3);
    tar.copy(bytes, offset + 5, start, start + length);
    offset += 5 + length;
  }
  bytes.writeUInt32LE((crc ^ 0xffffffff) >>> 0, offset);
  bytes.writeUInt32LE(tar.length >>> 0, offset + 4);
  return bytes;
}

type RoleEntry = {
  id: string;
  version: string;
  name: string;
  publisher: 'automagik';
  official: true;
  sha256: string;
  size: number;
  capabilities: string[];
  source: string;
  description?: string;
  tools: string[];
};

function describe(bytes: Buffer, name: string, release: string): RoleEntry {
  const files: RoleFiles = readRoleTar(bytes);
  const { id, version, publisher, capabilities, description } = readLayout(files, files.get('role.json'), name);
  if (!isPackageRoleId(id) || !isRoleVersion(version) || publisher !== 'automagik' || !validCapabilities(capabilities)) {
    throw new Error(`${name}: invalid id, version, publisher or capabilities`);
  }
  if (name !== filename(id, version)) throw new Error(`${name}: filename does not match its role manifest`);
  if (description !== undefined && !roleDescription(description)) throw new Error(`${name}: invalid role description (at most 200 characters)`);
  const { declarations } = validateRoleManifest(files, { id, version, publisher, capabilities });
  return {
    id, version, name: declarations.name, publisher, official: true, sha256: sha256(bytes),
    size: bytes.length, capabilities, source: release + name,
    ...(description === undefined ? {} : { description }), tools: declarations.tools,
  };
}

/** A signed predecessor can lend versions only after its rows pass the consumer's admission rules. */
export function predecessorRoles(rows: unknown[], release: string, releaseVersion: string) {
  if (!isRoleVersion(releaseVersion)) throw new Error('roles.json: invalid predecessor catalog version');
  const roles = new Map<string, { version: string; sha256: string }>();
  const [releaseMajor, releaseMinor, releasePatch] = releaseVersion.split('.').map(Number);
  for (const raw of rows) {
    const entry = raw as RoleEntry;
    if (!plainObject(entry) || !isPackageRoleId(entry.id) || !isRoleVersion(entry.version) || !isSha256(entry.sha256)
        || entry.official !== true || entry.publisher !== 'automagik' || !roleName(entry.name)
        || !validCapabilities(entry.capabilities) || !Number.isInteger(entry.size) || entry.size < 1 || entry.size > MAX_PACKAGE
        || entry.source !== release + filename(entry.id, entry.version)) {
      throw new Error('roles.json: invalid predecessor role entry');
    }
    const [major, minor, patch] = entry.version.split('.').map(Number);
    if ((major - releaseMajor || minor - releaseMinor || patch - releasePatch) > 0) {
      throw new Error(`roles.json: predecessor role ${entry.id} version ${entry.version} exceeds catalog version ${releaseVersion}`);
    }
    if (roles.has(entry.id)) throw new Error(`roles.json: duplicate predecessor role ${entry.id}`);
    roles.set(entry.id, { version: entry.version, sha256: entry.sha256.toLowerCase() });
  }
  return roles;
}

export function packRoleSources({ root, dir, version, sha, release, neverShipped, predecessor = new Map() }: {
  root: string; dir: string; version: string; sha: string; release: string;
  neverShipped: (path: string) => boolean; predecessor?: ReturnType<typeof predecessorRoles>;
}) {
  if (!isRoleVersion(version)) throw new Error('pack-roles: invalid release version');
  const roles = sources(root, sha, neverShipped);
  const packed: RoleEntry[] = [];
  const written: string[] = [];
  try {
    for (const [id, source] of [...roles].sort(([a], [b]) => compareNames(a, b))) {
      const roleJson = source.get('role.json');
      const manifest = readLayout(source, roleJson === undefined ? undefined : git(root, 'cat-file', 'blob', roleJson), id);
      if (manifest.id !== id) throw new Error(`${id}: role manifest id must equal its folder`);
      const files: RoleFiles = new Map([
        [manifest.entry, git(root, 'cat-file', 'blob', source.get(manifest.entry)!)],
        [manifest.prompt, git(root, 'cat-file', 'blob', source.get(manifest.prompt)!)],
      ]);
      const archive = (stamp: string) => {
        files.set('role.json', Buffer.from(JSON.stringify({ ...manifest, version: stamp }, null, 2) + '\n'));
        return gzip(ustar(files));
      };
      const prior = predecessor.get(id);
      let stamp = prior?.version ?? version;
      let bytes = archive(stamp);
      if (prior && sha256(bytes) !== prior.sha256) {
        stamp = version;
        bytes = archive(stamp);
      }
      const name = filename(id, stamp);
      const entry = describe(bytes, name, release);
      mkdirSync(dir, { recursive: true });
      for (const [file, contents] of [[name, bytes], [`${name}.sha256`, checksumLine(name, entry.sha256)]] as const) {
        const target = join(dir, file);
        writeFileSync(target, contents, { flag: 'wx' });
        written.push(target);
      }
      packed.push(entry);
    }
  } catch (error) {
    for (const file of written) rmSync(file, { force: true });
    throw error;
  }
  return packed;
}

function readArtifact(dir: string, name: string, limit: number) {
  const path = join(dir, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit) throw new Error(`${name}: expected a regular role artifact within its size limit`);
  return readFileSync(path);
}

/** Derive the catalog from the staged artifacts and account for every matching directory entry. */
export function readPackedRoles(dir: string, names: string[], release: string) {
  const pending = new Set(names);
  const roles = new Map<string, RoleEntry>();
  for (const name of names.filter(name => name.endsWith('.tgz'))) {
    const sidecar = `${name}.sha256`;
    if (!pending.has(sidecar)) throw new Error(`${name}: missing .sha256 sidecar`);
    const entry = describe(readArtifact(dir, name, MAX_PACKAGE), name, release);
    if (readArtifact(dir, sidecar, 256).toString('utf8') !== checksumLine(name, entry.sha256)) {
      throw new Error(`${sidecar}: checksum does not match the tarball`);
    }
    if (roles.has(entry.id)) throw new Error(`roles.json: duplicate role ${entry.id}`);
    roles.set(entry.id, entry);
    pending.delete(name);
    pending.delete(sidecar);
  }
  if (pending.size) throw new Error(`roles.json: extra or orphan role artifact: ${[...pending].join(', ')}`);
  return [...roles.values()].sort((a, b) => compareNames(a.id, b.id));
}
