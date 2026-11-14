#!/usr/bin/env bun
/**
 * The knowledge pack: the public documentation of the automagik-si GitHub organisation, as one
 * folder the cx Support Bot's answer bots read (and are confined to). The host installs it at
 * /srv/knowledge and rebuilds it daily with a timer that runs this one command, from a checkout
 * of this repository:
 *
 *   bun scripts/knowledge-pack.ts build --out /srv/knowledge
 *
 * Options: --out <dir> (default /srv/knowledge), --org <name> (default automagik-si). --api and
 * --archive point the two reads at another server (the tests' local fake); they default to
 * https://api.github.com and https://codeload.github.com.
 *
 * Public only, by construction: every read is unauthenticated. The org's public repository
 * listing, then each repository's public tarball at the head of its default branch. No token is
 * read from the environment or from the gh CLI, and no request carries one, so a private
 * repository cannot be reached; a read GitHub refuses (401, 403, 404, a rate limit) fails the
 * build. A listing entry that is not public also fails it.
 *
 * Archived repositories and forks are skipped. From each repository the pack takes, by an
 * allow-list of paths and extensions (nothing else is ever written):
 *   - the top-level README (README, or README[.<lang>].md|mdx|markdown|txt|rst);
 *   - docs/**: .md, .mdx, .txt;
 *   - in the `docs` repository, every .md and .mdx.
 * Never a path with a dot-folder or dot-file segment, nor node_modules; never a symlink, a file
 * with a NUL byte (binary) or one over 2 MiB. Issues, PRs, wikis and discussions are never read.
 * A repository that yields no file is left out.
 *
 * Each file is written to <out>/<repo>/<path> with a short stamp first: the repository, the path,
 * the full commit sha and its public github.com blob URL at that commit (the link the bot quotes).
 * <out>/manifest.json lists every file (repo, path, commit, url, bytes, sha256), each repository's
 * commit and counts, and the totals. Nothing holds a time: two builds of the same commits are
 * byte-identical.
 *
 * Built into a temporary folder beside <out>, then checked with the repository's privacy rules
 * (herdr/scripts/privacy-check.mjs: home paths, private names, personal emails, credentials,
 * database files) over every file of the pack. Any hit prints `file:line: rule` and fails the
 * build. Only a clean pack replaces the old one: the old folder is renamed aside, the new one
 * renamed in (both on the same filesystem), and the old one removed. A failed run removes its
 * temporary folder and leaves the old pack as it was. An existing <out> that is neither empty nor
 * a pack (no manifest.json of this kind) is never replaced.
 *
 * Exit: 0 built, 1 failed (old pack kept), 2 usage.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { denyMatcher, fileText, loadList, scan } from '../herdr/scripts/privacy-check.mjs';

export const KIND = 'automagik-knowledge-pack';
export const DEFAULTS = {
  out: '/srv/knowledge',
  org: 'automagik-si',
  api: 'https://api.github.com',
  archive: 'https://codeload.github.com',
};
const MAX_FILE = 2 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9._-]+$/;

export type Repo = { name: string; branch: string };
export type Entry = { repo: string; path: string; commit: string; url: string; bytes: number; sha256: string };
export type Manifest = {
  kind: typeof KIND;
  schemaVersion: 1;
  org: string;
  totals: { files: number; bytes: number; repos: number };
  repos: { name: string; commit: string; files: number; bytes: number }[];
  files: Entry[];
};
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type Options = { out?: string; org?: string; api?: string; archive?: string; fetch?: Fetch; log?: (line: string) => void };

/** A plain byte-wise order, the same on every machine and locale. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const README = /^README(?:\.[A-Za-z0-9-]+)?\.(?:md|mdx|markdown|txt|rst)$/i;
const DOCS_EXT = /\.(?:md|mdx|txt)$/i;
const MARKDOWN = /\.(?:md|mdx)$/i;

/** Whether `path` (repo-relative, forward slashes) of repository `repo` goes into the pack. */
export function allowed(repo: string, path: string): boolean {
  const parts = path.split('/');
  if (parts.some((p) => !p || p.startsWith('.') || p === 'node_modules')) return false;
  if (parts.length === 1 && (parts[0] === 'README' || README.test(parts[0]))) return true;
  if (parts[0] === 'docs' && parts.length > 1 && DOCS_EXT.test(path)) return true;
  return repo === 'docs' && MARKDOWN.test(path);
}

/** A path's public github.com URL at `commit`. */
export const sourceUrl = (org: string, repo: string, commit: string, path: string) =>
  `https://github.com/${org}/${repo}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** The stamp written before a file's own bytes. */
export const stamp = (org: string, repo: string, commit: string, path: string) =>
  [
    '<!-- automagik knowledge pack',
    `repo: ${org}/${repo}`,
    `path: ${path}`,
    `commit: ${commit}`,
    `url: ${sourceUrl(org, repo, commit, path)}`,
    '-->',
    '',
    '',
  ].join('\n');

const cString = (b: Buffer) => {
  const nul = b.indexOf(0);
  return b.toString('utf8', 0, nul === -1 ? b.length : nul);
};
const octal = (b: Buffer) => {
  if (b[0] & 0x80) throw new Error('tar: base-256 sizes are not supported');
  const text = cString(b).trim();
  return text ? Number.parseInt(text, 8) : 0;
};
/** pax records: `<len> <key>=<value>\n`. */
function pax(b: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let o = 0; o < b.length;) {
    const sp = b.indexOf(0x20, o);
    if (sp === -1) break;
    const len = Number.parseInt(b.toString('utf8', o, sp), 10);
    if (!(len > 0)) break;
    const record = b.toString('utf8', sp + 1, o + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    o += len;
  }
  return out;
}

/**
 * A tar archive's regular files `{ path, body }` and its pax global `comment` (git archive puts
 * the commit sha there). Paths keep their top folder. Every header's checksum is checked.
 */
export function readTar(tar: Buffer): { comment?: string; files: { path: string; body: Buffer }[] } {
  const files: { path: string; body: Buffer }[] = [];
  let comment: string | undefined;
  let longName: string | undefined;
  let local: Record<string, string> = {};
  for (let o = 0; o + 512 <= tar.length;) {
    const h = tar.subarray(o, o + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== octal(h.subarray(148, 156))) throw new Error(`tar: bad header checksum at byte ${o}`);
    const type = String.fromCharCode(h[156] || 0x30);
    const size = local.size !== undefined ? Number(local.size) : octal(h.subarray(124, 136));
    const body = tar.subarray(o + 512, o + 512 + size);
    if (body.length !== size) throw new Error('tar: truncated');
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') { comment = pax(body).comment ?? comment; continue; }
    if (type === 'x') { local = pax(body); continue; }
    if (type === 'L') { longName = cString(body); continue; }
    const prefix = cString(h.subarray(345, 500));
    const name = local.path ?? longName ?? (prefix ? `${prefix}/${cString(h.subarray(0, 100))}` : cString(h.subarray(0, 100)));
    local = {};
    longName = undefined;
    if (type === '0' || type === '7') files.push({ path: name, body: Buffer.from(body) });
  }
  return { comment, files };
}

/** GET `url` with no credentials; anything but 200 fails the build. */
async function get(fetcher: Fetch, url: string, accept: string): Promise<Response> {
  const res = await fetcher(url, {
    headers: { accept, 'user-agent': 'automagik-knowledge-pack' },
    redirect: 'follow',
    signal: AbortSignal.timeout(600_000),
  });
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 429) {
    throw new Error(`${url}: HTTP ${res.status}; the pack reads public data only, with no token`);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/** The org's public repositories, minus archived ones and forks, by name. */
export async function listRepos(o: Required<Pick<Options, 'org' | 'api'>> & { fetch: Fetch }): Promise<{ repos: Repo[]; skipped: string[] }> {
  const repos: Repo[] = [];
  const skipped: string[] = [];
  for (let page = 1; ; page++) {
    const url = `${o.api}/orgs/${encodeURIComponent(o.org)}/repos?type=public&per_page=100&page=${page}`;
    const list = await (await get(o.fetch, url, 'application/vnd.github+json')).json();
    if (!Array.isArray(list)) throw new Error(`${url}: not a repository list`);
    for (const r of list) {
      if (typeof r?.name !== 'string' || !NAME.test(r.name) || r.name === '.' || r.name === '..') {
        throw new Error(`listing: unexpected repository name ${JSON.stringify(r?.name)}`);
      }
      if (r.private !== false || (r.visibility !== undefined && r.visibility !== 'public')) {
        throw new Error(`listing: ${r.name} is not public`);
      }
      if (r.archived || r.fork) { skipped.push(`${r.name} (${r.archived ? 'archived' : 'fork'})`); continue; }
      if (typeof r.default_branch !== 'string' || !r.default_branch) throw new Error(`listing: ${r.name} has no default branch`);
      repos.push({ name: r.name, branch: r.default_branch });
    }
    if (list.length < 100) break;
  }
  repos.sort((a, b) => byText(a.name, b.name));
  return { repos, skipped: skipped.sort(byText) };
}

/** One repository's allowed files at the head of its default branch, and that commit. */
export async function fetchRepo(o: Required<Pick<Options, 'org' | 'archive'>> & { fetch: Fetch }, repo: Repo) {
  const ref = repo.branch.split('/').map(encodeURIComponent).join('/');
  const url = `${o.archive}/${encodeURIComponent(o.org)}/${encodeURIComponent(repo.name)}/tar.gz/refs/heads/${ref}`;
  const tgz = Buffer.from(await (await get(o.fetch, url, 'application/x-gzip')).arrayBuffer());
  const { comment, files } = readTar(gunzipSync(tgz));
  if (!comment || !SHA.test(comment)) throw new Error(`${repo.name}: the tarball names no commit`);
  const kept: { path: string; body: Buffer }[] = [];
  for (const f of files) {
    const path = f.path.split('/').slice(1).join('/');
    if (!path || !allowed(repo.name, path)) continue;
    if (f.body.length > MAX_FILE || f.body.includes(0)) continue;
    kept.push({ path, body: f.body });
  }
  kept.sort((a, b) => byText(a.path, b.path));
  return { commit: comment, files: kept };
}

/** Every file under `dir`, relative, forward slashes, sorted. */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out.sort(byText);
}

/**
 * The privacy rules over every file of a folder outside git: `file:line: rule` per hit. The
 * list's per-file allowed text names this repository's files, not the pack's, so it is not used.
 */
export function privacyHits(dir: string): string[] {
  const list = { ...loadList(), lines: [] };
  const denied = denyMatcher(list.deny);
  const hits: string[] = [];
  for (const file of walk(dir)) {
    for (const h of scan(file, fileText(readFileSync(join(dir, file))), list, denied, '\0')) hits.push(`${h.file}:${h.line}: ${h.rule}`);
  }
  return hits;
}

/** Whether `out` may be replaced: absent, an empty folder, or a pack this script made. */
function replaceable(out: string): boolean {
  if (!existsSync(out)) return true;
  if (!lstatSync(out).isDirectory()) return false;
  if (readdirSync(out).length === 0) return true;
  try {
    return JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).kind === KIND;
  } catch {
    return false;
  }
}

/** Puts the built folder `tmp` at `out`; on a failed rename the old pack goes back. */
function swapIn(tmp: string, out: string) {
  if (!existsSync(out)) { renameSync(tmp, out); return; }
  const old = `${tmp}.old`;
  renameSync(out, old);
  try {
    renameSync(tmp, out);
  } catch (error) {
    renameSync(old, out);
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
}

export class BuildError extends Error {
  constructor(message: string, readonly hits: string[] = []) { super(message); }
}

/** Builds the pack and puts it at `out`; returns its manifest. Throws, leaving `out` as it was. */
export async function build(opts: Options = {}): Promise<Manifest> {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as typeof DEFAULTS & Options;
  const fetcher: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const log = o.log ?? (() => {});
  const out = resolve(o.out);
  if (!replaceable(out)) throw new BuildError(`${out} exists and is not a knowledge pack; refusing to replace it`);
  mkdirSync(dirname(out), { recursive: true });
  const tmp = mkdtempSync(join(dirname(out), `.${basename(out)}.build-`));
  try {
    const { repos, skipped } = await listRepos({ org: o.org, api: o.api, fetch: fetcher });
    for (const s of skipped) log(`skip ${s}`);
    const files: Entry[] = [];
    const perRepo: Manifest['repos'] = [];
    for (const repo of repos) {
      const { commit, files: kept } = await fetchRepo({ org: o.org, archive: o.archive, fetch: fetcher }, repo);
      if (!kept.length) { log(`skip ${repo.name} (no README or docs)`); continue; }
      let bytes = 0;
      for (const f of kept) {
        const body = Buffer.concat([Buffer.from(stamp(o.org, repo.name, commit, f.path)), f.body]);
        const dest = join(tmp, repo.name, f.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, body, { mode: 0o644 });
        const entry = {
          repo: repo.name,
          path: f.path,
          commit,
          url: sourceUrl(o.org, repo.name, commit, f.path),
          bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
        };
        files.push(entry);
        bytes += body.length;
      }
      perRepo.push({ name: repo.name, commit, files: kept.length, bytes });
    }
    const manifest: Manifest = {
      kind: KIND,
      schemaVersion: 1,
      org: o.org,
      totals: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), repos: perRepo.length },
      repos: perRepo,
      files,
    };
    writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    const hits = privacyHits(tmp);
    if (hits.length) throw new BuildError(`privacy check: ${hits.length} hit(s); the old pack is kept`, hits);
    swapIn(tmp, out);
    return manifest;
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

function usage(): never {
  console.error('usage: bun scripts/knowledge-pack.ts build [--out <dir>] [--org <name>] [--api <url>] [--archive <url>]');
  process.exit(2);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'build') usage();
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    if (!['out', 'org', 'api', 'archive'].includes(key) || rest[i + 1] === undefined) usage();
    opts[key] = rest[i + 1];
  }
  try {
    const m = await build({ ...opts, log: (line) => console.log(line) });
    for (const r of m.repos) console.log(`${r.name}: ${r.files} file(s), ${r.bytes} bytes at ${r.commit}`);
    console.log(`knowledge pack: ${m.totals.files} file(s), ${m.totals.bytes} bytes, ${m.totals.repos} repo(s); privacy check clean`);
  } catch (error) {
    for (const hit of (error as BuildError).hits ?? []) console.error(hit);
    console.error(`knowledge pack: not built: ${(error as Error).message}`);
    process.exit(1);
  }
}
