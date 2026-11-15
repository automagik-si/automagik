#!/usr/bin/env bun
// Runner-only: normal Bun packing with hooks disabled, bound to the actual clean checkout.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pluginNames, releasePlugins } from './release-plugins';
import { CHECKOUT_PACKAGES, CHECKOUT_REPOSITORY, CHILD, checkoutFile, regularPath, sha256, verifyCheckoutDirectory } from '../server/checkout-input.mjs';

const ROOT = resolve(import.meta.dir, '..');
const blobHash = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** All outputs are owned temporary files; the CLI alone copies verified inputs into the context. */
export function packCheckout({ root = ROOT, event, revision }: { root?: string; event: string; revision: string }) {
  if (event !== 'pull_request' || !/^[0-9a-f]{40}$/.test(revision)) throw new Error('packing requires pull_request and full checkout revision');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const paths = ['package.json', ...Object.values(CHECKOUT_PACKAGES)] as string[];
  const clean = () => {
    if (git('rev-parse', 'HEAD').trim() !== revision) throw new Error('requested revision is not checkout HEAD');
    if (git('diff', '--no-ext-diff', '--name-only', 'HEAD', '--', ...paths).trim()) throw new Error('dirty checkout source');
  };
  clean();
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('invalid root version');
  const names = Object.keys(CHECKOUT_PACKAGES);
  if (JSON.stringify(pluginNames(root)) !== JSON.stringify(names)) throw new Error('unexpected plugin identities');
  const tree = new Map(git('ls-tree', '-rz', 'HEAD', '--', ...paths).split('\0').filter(Boolean).map((entry) => {
    const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error('unexpected checkout tree entry');
    return [match[3], { mode: match[1], hash: match[2] }];
  }));
  const staging = mkdtempSync(join(tmpdir(), 'automagik-checkout-'));
  const dir = join(staging, 'checkout-input');
  mkdirSync(dir);
  try {
    for (const [name, folder] of Object.entries(CHECKOUT_PACKAGES)) {
      regularPath(join(root, folder), true);
      regularPath(join(root, folder, 'package.json'));
      const pkg = JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8'));
      if (pkg.name !== name || pkg.version !== version) throw new Error('fixed package name/folder/version mismatch');
      execFileSync(process.execPath, ['pm', 'pack', '--ignore-scripts', '--destination', dir], {
        cwd: join(root, folder), stdio: ['ignore', 'pipe', 'pipe'],
      });
      const archive = join(dir, checkoutFile(name, version));
      regularPath(archive);
      const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trimEnd().split('\n');
      const unique = new Set();
      for (const member of members) {
        if (!/^package\/(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+\/?$/.test(member) || member.split('/').some((p) => p === '..' || p === '.') || unique.has(member)) throw new Error('invalid/duplicate packed path');
        unique.add(member);
      }
      // Refuse links/devices before extraction, including any packable untracked/ignored file.
      const types = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trimEnd().split('\n');
      if (types.some((line) => !['-', 'd'].includes(line[0]))) throw new Error('packed members must be regular files/directories');
      const unpacked = join(staging, name.slice(1).replace('/', '-'));
      mkdirSync(unpacked);
      execFileSync('tar', ['-xzf', archive, '-C', unpacked, '--no-same-owner', '--no-same-permissions']);
      for (const member of members) {
        const file = join(unpacked, member);
        if (lstatSync(file).isDirectory()) continue;
        const source = `${folder}/${member.slice('package/'.length)}`;
        const tracked = tree.get(source);
        if (!tracked || !/^100(644|755)$/.test(tracked.mode) || blobHash(readFileSync(file)) !== tracked.hash) throw new Error(`packed bytes are not HEAD: ${source}`);
        regularPath(join(root, source));
        if (blobHash(readFileSync(join(root, source))) !== tracked.hash) throw new Error(`source changed during pack: ${source}`);
      }
    }
    const child = readFileSync(join(root, CHILD));
    if (blobHash(child) !== tree.get(CHILD)?.hash) throw new Error('child is not the committed input');
    const packedChild = readFileSync(join(staging, 'automagik-bots-dsh/package/src/host/browser/script-child.js'));
    if (!packedChild.equals(child)) throw new Error('packed child differs from checkout');
    writeFileSync(join(dir, 'plugins.json'), `${JSON.stringify(releasePlugins(version, revision, dir, names), null, 2)}\n`);
    const files = readdirSync(dir).sort();
    writeFileSync(join(dir, 'PLUGINS.SHA256SUMS'), files.map((file) => `${sha256(readFileSync(join(dir, file)))}  ${file}\n`).join(''));
    const manifest = sha256(readFileSync(join(dir, 'plugins.json')));
    verifyCheckoutDirectory(dir, { kind: 'checkout', event, revision, version, manifest, repository: CHECKOUT_REPOSITORY });
    clean();
    return { staging, dir, version, revision, manifest, child: sha256(child) };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  let packed;
  try {
    const [event, revision] = process.argv.slice(2);
    if (process.argv.length !== 4) throw new Error('usage: bun scripts/server-checkout.ts pull_request <checkout SHA>');
    packed = packCheckout({ event, revision });
    regularPath(join(ROOT, 'server'), true);
    const target = join(ROOT, 'server/checkout-input');
    mkdirSync(target); // An existing/stale input directory is never reused or overwritten.
    try {
      // The directory is exclusively ours; copy its verified assets, not the directory onto itself.
      for (const file of readdirSync(packed.dir)) {
        cpSync(join(packed.dir, file), join(target, file), { errorOnExist: true, force: false });
      }
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `manifest=${packed.manifest}\nchild=${packed.child}\nrevision=${packed.revision}\n`);
      console.log(`checkout inputs: ${packed.revision} manifest=${packed.manifest} child=${packed.child}`);
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      throw error;
    }
  } finally {
    if (packed) rmSync(packed.staging, { recursive: true, force: true });
  }
}
