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
 * Never a path with a dot-folder or dot-file segment, nor node_modules; never a path with an
 * excluded folder anywhere in it (EXCLUDED_FOLDERS: _internal, plans, research, runbooks,
 * incident-response, rfcs, design, brand/components), nor one with a folder or a file-name stem
 * of an excluded word (EXCLUDED_WORDS: evidence, perf, performance, deployment, migration,
 * internal, dogfood). Internal notes, not knowledge for the people the bot answers. Both match
 * whatever the letter case. A stem is the file name without its last extension, and it matches
 * when one of its words (split at -, _ and .) is an excluded word: `migration.md`,
 * `0024-delivery-0-evidence.md`, `dogfood-report.md`. Never a symlink, a file with a NUL byte
 * (binary) or one over 2 MiB. Issues, PRs, wikis and discussions are never read.
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
 * build, except one the pack's own placeholder list names (scripts/knowledge-pack-placeholders.json:
 * documentation placeholders and the org's public role contacts, each an exact match or an
 * anchored pattern for the email or home-path rule only; a pattern that matches empty text, has no
 * literal part, leaves an address's local part or a home's name to a wildcard, or matches unrelated
 * text is refused at load, so no entry can waive a whole rule).
 * That list is the pack's alone: it never goes into the repository's privacy list, and it never
 * names a person's name, home or address. Only a clean pack replaces the old one: the old folder is renamed aside, the new one
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

/**
 * Folders left out wherever they sit in a path, whatever the case; a two-part entry matches two
 * folders in a row. A file of the same name is kept (`docs/design.md`).
 */
export const EXCLUDED_FOLDERS = ['_internal', 'plans', 'research', 'runbooks', 'incident-response', 'rfcs', 'design', 'brand/components'];
/**
 * Words left out as a folder anywhere in a path, or as a word of the file name's stem (the name
 * without its last extension, split at -, _ and .), whatever the case.
 */
export const EXCLUDED_WORDS = ['evidence', 'perf', 'performance', 'deployment', 'migration', 'internal', 'dogfood'];
const excludedFolder = (folders: string[]) =>
  EXCLUDED_FOLDERS.some((entry) => {
    const want = entry.split('/');
    return folders.some((_, i) => want.every((w, j) => folders[i + j] === w));
  });
/** A file name's stem: the name without its last extension (`a.b.md` is `a.b`). */
export const stem = (name: string) => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name);
const excludedWord = (folders: string[], name: string) =>
  folders.some((f) => EXCLUDED_WORDS.includes(f)) || stem(name).split(/[-_.]/).some((w) => EXCLUDED_WORDS.includes(w));

/** Whether `path` (repo-relative, forward slashes) of repository `repo` goes into the pack. */
export function allowed(repo: string, path: string): boolean {
  const parts = path.split('/');
  if (parts.some((p) => !p || p.startsWith('.') || p === 'node_modules')) return false;
  const lower = parts.map((p) => p.toLowerCase());
  if (excludedFolder(lower.slice(0, -1)) || excludedWord(lower.slice(0, -1), lower[lower.length - 1])) return false;
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

export const PLACEHOLDERS_PATH = join(import.meta.dir, 'knowledge-pack-placeholders.json');
/** The rules a placeholder may pass: never a private name, a secret or a database file. */
const PLACEHOLDER_RULES = ['email', 'home-path'];
export type Placeholder = { rule: string; match?: string; pattern?: string; why: string };

/**
 * Whether a pattern holds a literal character: one outside a class, a group's syntax, a quantifier
 * or an anchor, and not a class escape (\d, \w, \s and their capitals). `\.` and `\u0040` count.
 */
export function hasLiteral(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[++i];
      if (next === undefined) return false;
      if (!'dDwWsSbB'.includes(next)) return true;
      continue;
    }
    if (c === '[') {
      for (i++; i < pattern.length && pattern[i] !== ']'; i++) if (pattern[i] === '\\') i++;
      continue;
    }
    if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close !== -1 && /^\{\d*(?:,\d*)?\}$/.test(pattern.slice(i, close + 1))) { i = close; continue; }
      return true;
    }
    if (c === '(' && pattern[i + 1] === '?') {
      // A group's head: (?: (?= (?! (?<= (?<! or (?<name>.
      const head = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(pattern.slice(i));
      if (head) { i += head[0].length - 1; continue; }
    }
    if ('^$.|()*+?'.includes(c)) continue;
    return true;
  }
  return false;
}

/** One top-level branch of a pattern, as `branches` reads it. */
export type Branch = { anchored: boolean; exact: boolean; prefix: string; suffix: string };

/**
 * A pattern's top-level branches. Each says whether it starts with ^ and ends with $, whether it
 * is literal throughout (one exact text), and the literal text it starts and ends with. Escapes
 * read as their character (`\.`, `\/`, `@`); class escapes, classes, groups, `.` and anchors
 * are not literal, nor is a character under a quantifier.
 */
export function branches(pattern: string): Branch[] {
  type Token = { lit: string | null; raw: string };
  const all: Token[][] = [[]];
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const tokens = all[all.length - 1];
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[++i] ?? '';
      const width = next === 'u' ? 4 : next === 'x' ? 2 : 0;
      const hex = width ? new RegExp(`^[0-9A-Fa-f]{${width}}`).exec(pattern.slice(i + 1)) : null;
      if (hex) { tokens.push({ lit: String.fromCharCode(parseInt(hex[0], 16)), raw: '\\' }); i += width; continue; }
      const control: Record<string, string> = { n: '\n', r: '\r', t: '\t' };
      tokens.push({ lit: 'dDwWsSbB'.includes(next) ? null : (control[next] ?? next), raw: '\\' });
      continue;
    }
    if (c === '[') {
      for (i++; i < pattern.length && pattern[i] !== ']'; i++) if (pattern[i] === '\\') i++;
      tokens.push({ lit: null, raw: '[' });
      continue;
    }
    const brace = c === '{' ? /^\{\d*(?:,\d*)?\}/.exec(pattern.slice(i))?.[0] : undefined;
    if ('*+?'.includes(c) || brace) {
      // The quantified character is not literal, and neither is the quantifier.
      if (tokens.length) tokens[tokens.length - 1].lit = null;
      tokens.push({ lit: null, raw: c });
      if (brace) i += brace.length - 1;
      continue;
    }
    if (c === '|' && depth === 0) { all.push([]); continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    tokens.push({ lit: '^$.|()'.includes(c) ? null : c, raw: c });
  }
  return all.map((tokens) => {
    const anchored = tokens[0]?.raw === '^' && tokens[tokens.length - 1]?.raw === '$';
    const body = anchored ? tokens.slice(1, -1) : tokens;
    const lead = body.findIndex((t) => t.lit === null);
    if (lead === -1) return { anchored, exact: true, prefix: body.map((t) => t.lit).join(''), suffix: '' };
    const tail = body.findLastIndex((t) => t.lit === null);
    return { anchored, exact: false, prefix: body.slice(0, lead).map((t) => t.lit).join(''), suffix: body.slice(tail + 1).map((t) => t.lit).join('') };
  });
}

/**
 * What a branch that is not one exact text must start with, as literal text, per rule: an
 * address's whole local part and the at sign; a home's root, whole name and a separator. So no
 * wildcard reaches the part of the hit that names a person.
 */
const PINNED: Record<string, { re: RegExp; what: string }> = {
  email: { re: /^[^@]+@/, what: 'its whole local part and the at sign' },
  'home-path': { re: /^(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+[\\/]/, what: 'its whole home name' },
};

/**
 * Text a placeholder pattern must not match, all fixed so the same list always loads the same
 * way: unrelated words, a hit of each rule's shape, and the pattern's own literal ends around a
 * plain word (so a pinned local part at any domain, or a pinned home with anything under it, is
 * refused).
 */
function probes(pattern: string): string[] {
  // Addresses and homes are joined from parts, so the repository's own privacy scan reads none.
  const address = (local: string, domain: string) => [local, domain].join('@');
  const home = (name: string) => ['', 'home', name].join('/');
  const users = (name: string) => ['', 'Users', name].join('/');
  const fixed = [
    ' ', 'x', 'hello world', 'zq7#kP!', '\n', 'k3v9x2m7q', 'k3v9x2m7q p4n8w1z6r',
    address('q8v2m', 'rk4t.io'), address('omni', 'rk4t.io'), address('k3v9x2m7q', 'p4n8w1z6r.com'),
    home('q8v2m'), users('q8v2m'), home('k3v9x2m7q'), users('k3v9x2m7q'),
  ];
  const fillers = ['a', 'name', 'user', 'q8v2m', 'k3v9x2m7q'];
  const ends = branches(pattern).filter((b) => !b.exact).flatMap(({ prefix, suffix }) => fillers.map((w) => prefix + w + suffix));
  return [...fixed, ...ends];
}

/**
 * The pack's placeholder list, checked: each entry names the email or home-path rule, a why, and
 * either an exact `match` or a `pattern` anchored with ^ and $. A pattern is refused when it
 * matches empty text, has no literal part, has a branch not anchored with ^ and $, has a branch
 * that leaves the person's part of a hit to a wildcard (an address's local part and at sign, a
 * home's name: `PINNED`), or matches unrelated text (`probes`): a placeholder may pass one text,
 * never a whole rule. The checks are fixed, so a list loads or is refused the same way every run.
 * Returns a test for one hit.
 */
export function placeholderTest(entries: Placeholder[]): (hit: { rule: string; match: string }) => boolean {
  if (!Array.isArray(entries)) throw new Error('placeholders: the list must be an array');
  const tests = entries.map((e, i) => {
    const at = `placeholders[${i}]`;
    if (!PLACEHOLDER_RULES.includes(e?.rule)) throw new Error(`${at}: rule must be one of ${PLACEHOLDER_RULES.join(', ')}`);
    if (typeof e.why !== 'string' || !e.why) throw new Error(`${at}: needs a why`);
    if ((e.match === undefined) === (e.pattern === undefined)) throw new Error(`${at}: needs one of match or pattern`);
    if (e.match !== undefined) {
      if (typeof e.match !== 'string' || !e.match) throw new Error(`${at}: match must be a non-empty string`);
      return (h: { rule: string; match: string }) => h.rule === e.rule && h.match === e.match;
    }
    if (typeof e.pattern !== 'string' || !e.pattern.startsWith('^') || !e.pattern.endsWith('$')) {
      throw new Error(`${at}: pattern must be anchored with ^ and $`);
    }
    const re = new RegExp(e.pattern);
    if (re.test('')) throw new Error(`${at}: pattern ${e.pattern} matches empty text`);
    if (!hasLiteral(e.pattern)) throw new Error(`${at}: pattern ${e.pattern} has no literal part`);
    const parts = branches(e.pattern);
    if (parts.some((b) => !b.anchored)) throw new Error(`${at}: pattern ${e.pattern}: each branch must be anchored with ^ and $`);
    const pin = PINNED[e.rule];
    if (parts.some((b) => !b.exact && !pin.re.test(b.prefix))) {
      throw new Error(`${at}: pattern ${e.pattern} must carry ${pin.what} as literal text`);
    }
    const loose = probes(e.pattern).find((p) => re.test(p));
    if (loose !== undefined) throw new Error(`${at}: pattern ${e.pattern} matches unrelated text (${JSON.stringify(loose)})`);
    return (h: { rule: string; match: string }) => h.rule === e.rule && re.test(h.match);
  });
  return (hit) => tests.some((t) => t(hit));
}

/**
 * The privacy rules over every file of a folder outside git: `file:line: rule` per hit, minus the
 * pack's placeholders. The repository list's per-file allowed text names this repository's
 * files, not the pack's, so it is not used.
 */
export function privacyHits(dir: string, placeholders: Placeholder[] = JSON.parse(readFileSync(PLACEHOLDERS_PATH, 'utf8')).placeholders): string[] {
  const list = { ...loadList(), lines: [] };
  const denied = denyMatcher(list.deny);
  const isPlaceholder = placeholderTest(placeholders);
  const hits: string[] = [];
  for (const file of walk(dir)) {
    for (const h of scan(file, fileText(readFileSync(join(dir, file))), list, denied, '\0')) {
      if (!isPlaceholder(h)) hits.push(`${h.file}:${h.line}: ${h.rule}`);
    }
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
