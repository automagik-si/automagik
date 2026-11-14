import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { allowed, build, KIND, readTar, sourceUrl, stamp, type Manifest } from './knowledge-pack';

// A fake GitHub on a local port: the org listing and each repository's tarball, as git archive
// makes it (a pax global header naming the commit, then the files under one top folder).

const paxRecord = (key: string, value: string) => {
  const rest = ` ${key}=${value}\n`;
  let n = rest.length + String(rest.length).length;
  if (String(n).length > String(rest.length).length) n += 1;
  return `${n}${rest}`;
};
function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.fill(0x20, 148, 156);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const block = (body: Buffer) => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
function tarball(top: string, commit: string, files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  const global = Buffer.from(paxRecord('comment', commit));
  parts.push(header('pax_global_header', global.length, 'g'), block(global));
  parts.push(header(`${top}/`, 0, '5'));
  for (const [path, body] of Object.entries(files)) {
    const bytes = Buffer.from(body);
    parts.push(header(`${top}/${path}`, bytes.length, '0'), block(bytes));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const C3 = 'c'.repeat(40);

type FakeRepo = { name: string; branch: string; commit: string; files: Record<string, string | Buffer>; archived?: boolean; fork?: boolean; private?: boolean };
const GENIE: FakeRepo = {
  name: 'genie',
  branch: 'main',
  commit: C1,
  files: {
    'README.md': '# Genie\n\nThe front door.\n',
    'README.pt-BR.md': '# Genie\n\nA porta da frente.\n',
    'docs/guide.md': '# Guide\n\nStart here.\n',
    'docs/notes.txt': 'plain notes\n',
    'docs/sub/deep.mdx': '# Deep\n',
    'docs/config.yaml': 'key: value\n',
    'docs/settings.json': '{}\n',
    'docs/.env': 'SECRET=1\n',
    'docs/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    'docs/blob.txt': Buffer.from([0x61, 0, 0x62]),
    'docs/run.ts': 'export {};\n',
    '.env': 'TOKEN=1\n',
    '.env.example': 'TOKEN=\n',
    'config.toml': 'a = 1\n',
    'src/index.ts': 'export const x = 1;\n',
    'examples/guide.md': '# Not docs\n',
    'CONTRIBUTING.md': '# Contributing\n',
  },
};
const DOCS: FakeRepo = {
  name: 'docs',
  branch: 'main',
  commit: C2,
  files: { 'intro.md': '# Intro\n', 'guides/setup.mdx': '# Setup\n', 'mint.json': '{}\n', 'robots.txt': 'User-agent: *\n', '.github/PULL_REQUEST_TEMPLATE.md': '# PR\n' },
};
const OMNI: FakeRepo = { name: 'omni', branch: 'dev/next', commit: C3, files: { 'README': 'Omni\n', 'src/a.ts': '' } };
const OTHERS: FakeRepo[] = [
  { name: 'old', branch: 'main', commit: C1, archived: true, files: { 'README.md': '# Old\n' } },
  { name: 'forked', branch: 'main', commit: C1, fork: true, files: { 'README.md': '# Fork\n' } },
  { name: 'codeonly', branch: 'main', commit: C1, files: { 'src/main.rs': 'fn main() {}\n', 'Cargo.toml': '' } },
];

function fakeGitHub(initial: FakeRepo[]) {
  let repos = initial;
  const seen: { path: string; authorization: string | null }[] = [];
  const failures = new Map<string, number>();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, authorization: req.headers.get('authorization') });
      if (failures.has(url.pathname)) return new Response('no', { status: failures.get(url.pathname) });
      if (url.pathname === '/orgs/automagik-si/repos') {
        return Response.json(repos.map((r) => ({
          name: r.name,
          default_branch: r.branch,
          archived: !!r.archived,
          fork: !!r.fork,
          private: !!r.private,
          visibility: r.private ? 'private' : 'public',
        })));
      }
      for (const r of repos) {
        if (url.pathname === `/automagik-si/${r.name}/tar.gz/refs/heads/${r.branch}`) {
          return new Response(tarball(`${r.name}-${r.branch.replace('/', '-')}`, r.commit, r.files));
        }
      }
      return new Response('not found', { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    server,
    seen,
    failures,
    set: (next: FakeRepo[]) => { repos = next; },
    opts: { api: base, archive: base, org: 'automagik-si' },
  };
}

const ALL = [GENIE, DOCS, OMNI, ...OTHERS];
const gh = fakeGitHub(ALL);
afterAll(() => gh.server.stop(true));
const scratch = mkdtempSync(join(tmpdir(), 'knowledge-pack-'));
let n = 0;
const freshOut = () => join(scratch, `run-${++n}`, 'knowledge');

/** Every file under `dir`, relative, sorted. */
function files(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}
const snapshot = (dir: string) => Object.fromEntries(files(dir).map((f) => [f, readFileSync(join(dir, f)).toString('base64')]));

describe('the knowledge pack', () => {
  test('the allow-list takes READMEs and docs, never env, config, code, binaries or other paths', async () => {
    const out = freshOut();
    await build({ ...gh.opts, out });
    expect(files(out)).toEqual([
      'docs/guides/setup.mdx',
      'docs/intro.md',
      'genie/README.md',
      'genie/README.pt-BR.md',
      'genie/docs/guide.md',
      'genie/docs/notes.txt',
      'genie/docs/sub/deep.mdx',
      'manifest.json',
      'omni/README',
    ]);
  });

  test('allowed() is an allow-list of paths and extensions', () => {
    for (const path of ['README.md', 'README', 'readme.mdx', 'README.pt-BR.md', 'docs/a.md', 'docs/x/y.mdx', 'docs/n.txt']) {
      expect([path, allowed('genie', path)]).toEqual([path, true]);
    }
    for (const path of [
      '.env', '.env.local', 'docs/.env', 'docs/.secret/a.md', 'config.json', 'docs/a.json', 'docs/a.yaml', 'docs/a.yml',
      'docs/a.toml', 'docs/a.ini', 'docs/a.ts', 'docs/a.png', 'src/a.md', 'examples/README.md', 'CHANGELOG.md',
      'README.json', 'README.sh', 'sub/docs/a.md', 'docs', 'node_modules/x/README.md', 'docs/node_modules/a.md',
    ]) {
      expect([path, allowed('genie', path)]).toEqual([path, false]);
    }
    expect(allowed('docs', 'guides/a.md')).toBe(true);
    expect(allowed('docs', 'guides/a.mdx')).toBe(true);
    expect(allowed('docs', 'robots.txt')).toBe(false);
    expect(allowed('docs', 'mint.json')).toBe(false);
    expect(allowed('docs', '.github/a.md')).toBe(false);
  });

  test('each file carries its stamp, and the manifest lists every file with its size, sha256 and totals', async () => {
    const out = freshOut();
    const m = await build({ ...gh.opts, out });
    const guide = readFileSync(join(out, 'genie/docs/guide.md'), 'utf8');
    const url = `https://github.com/automagik-si/genie/blob/${C1}/docs/guide.md`;
    expect(guide).toBe(`<!-- automagik knowledge pack\nrepo: automagik-si/genie\npath: docs/guide.md\ncommit: ${C1}\nurl: ${url}\n-->\n\n# Guide\n\nStart here.\n`);
    expect(stamp('automagik-si', 'genie', C1, 'docs/guide.md')).toBe(guide.slice(0, guide.indexOf('# Guide')));
    expect(sourceUrl('automagik-si', 'docs', C2, 'a b/c#d.md')).toBe(`https://github.com/automagik-si/docs/blob/${C2}/a%20b/c%23d.md`);

    const manifest: Manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest).toEqual(m);
    expect(manifest.kind).toBe(KIND);
    expect(manifest.files.map((f) => `${f.repo}/${f.path}`)).toEqual(files(out).filter((f) => f !== 'manifest.json'));
    for (const f of manifest.files) {
      const body = readFileSync(join(out, f.repo, f.path));
      expect(f.bytes).toBe(body.length);
      expect(f.sha256).toBe(createHash('sha256').update(body).digest('hex'));
      expect(f.url).toBe(sourceUrl('automagik-si', f.repo, f.commit, f.path));
    }
    expect(manifest.files.find((f) => f.repo === 'omni')).toMatchObject({ path: 'README', commit: C3 });
    expect(manifest.repos).toEqual([
      { name: 'docs', commit: C2, files: 2, bytes: expect.any(Number) },
      { name: 'genie', commit: C1, files: 5, bytes: expect.any(Number) },
      { name: 'omni', commit: C3, files: 1, bytes: expect.any(Number) },
    ]);
    expect(manifest.totals).toEqual({ files: 8, bytes: manifest.files.reduce((s, f) => s + f.bytes, 0), repos: 3 });
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  test('two builds of the same commits are byte-identical, and a rebuild replaces the pack in place', async () => {
    const a = freshOut();
    const b = freshOut();
    await build({ ...gh.opts, out: a });
    await build({ ...gh.opts, out: b });
    expect(snapshot(b)).toEqual(snapshot(a));
    await build({ ...gh.opts, out: a });
    expect(snapshot(a)).toEqual(snapshot(b));
    expect(readdirSync(join(a, '..'))).toEqual(['knowledge']);
  });

  test('a privacy hit fails the build, prints file:line: rule, and keeps the old pack', async () => {
    const out = freshOut();
    await build({ ...gh.opts, out });
    const before = snapshot(out);
    const home = ['', 'home', 'ana', 'notes'].join('/');
    gh.set([{ ...GENIE, commit: C2, files: { ...GENIE.files, 'docs/guide.md': `# Guide\n\nsee ${home}\n` } }, DOCS, OMNI]);
    try {
      const error = await build({ ...gh.opts, out }).then(() => null, (e) => e);
      expect(error?.message).toMatch(/privacy check: 1 hit/);
      expect(error.hits).toEqual(['genie/docs/guide.md:10: home-path']);
    } finally {
      gh.set(ALL);
    }
    expect(snapshot(out)).toEqual(before);
    expect(readdirSync(join(out, '..'))).toEqual(['knowledge']);
  });

  test('a read GitHub refuses fails the build and keeps the old pack', async () => {
    const out = freshOut();
    await build({ ...gh.opts, out });
    const before = snapshot(out);
    gh.failures.set('/automagik-si/omni/tar.gz/refs/heads/dev/next', 401);
    try {
      await expect(build({ ...gh.opts, out })).rejects.toThrow(/HTTP 401; the pack reads public data only, with no token/);
    } finally {
      gh.failures.clear();
    }
    expect(snapshot(out)).toEqual(before);
    expect(readdirSync(join(out, '..'))).toEqual(['knowledge']);
  });

  test('a listing entry that is not public fails the build', async () => {
    gh.set([...ALL, { name: 'secret', branch: 'main', commit: C1, private: true, files: { 'README.md': '# s\n' } }]);
    try {
      await expect(build({ ...gh.opts, out: freshOut() })).rejects.toThrow(/secret is not public/);
    } finally {
      gh.set(ALL);
    }
  });

  test('a folder that is not a pack is never replaced', async () => {
    const out = freshOut();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'mine\n');
    await expect(build({ ...gh.opts, out })).rejects.toThrow(/is not a knowledge pack/);
    expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('mine\n');
  });

  test('a token in the environment goes unused: no request carries credentials', async () => {
    const out = freshOut();
    gh.seen.length = 0;
    const env = { ...process.env, GH_TOKEN: 'test-token-not-real', GITHUB_TOKEN: 'test-token-not-real' };
    const args = ['build', '--out', out, '--api', gh.opts.api, '--archive', gh.opts.archive];
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'knowledge-pack.ts'), ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/knowledge pack: 8 file\(s\), \d+ bytes, 3 repo\(s\); privacy check clean/);
    expect(existsSync(join(out, 'manifest.json'))).toBe(true);
    expect(gh.seen.length).toBeGreaterThan(1);
    expect(gh.seen.filter((s) => s.authorization !== null)).toEqual([]);
    expect(readFileSync(join(import.meta.dir, 'knowledge-pack.ts'), 'utf8')).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|authorization|\bgh auth\b/i);
  });

  test('readTar refuses a corrupt header', () => {
    const tar = Buffer.from(tarball('x-main', C1, { 'README.md': 'x' }));
    const raw = Bun.gunzipSync(tar);
    const bad = Buffer.from(raw);
    bad[0] ^= 1;
    expect(() => readTar(bad)).toThrow(/checksum/);
    expect(readTar(Buffer.from(raw))).toMatchObject({ comment: C1, files: [{ path: 'x-main/README.md' }] });
  });
});
