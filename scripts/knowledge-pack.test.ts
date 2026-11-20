import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  allowed, build, EXCLUDED_FOLDERS, EXCLUDED_WORDS, hasLiteral, KIND, branches, PLACEHOLDERS_PATH, placeholderTest, privacyHits, readTar, sourceUrl, stamp, stem,
  type Manifest, type Placeholder,
} from './knowledge-pack';

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
    // Excluded folders, wherever they sit; the home path inside one would be a privacy hit.
    'docs/_internal/notes.md': `# Internal\n\n${['', 'home', 'ana'].join('/')}\n`,
    'docs/plans/p.md': '# Plan\n',
    'docs/x/research/r.md': '# Research\n',
    'docs/runbooks/x.md': '# Runbook\n',
    'docs/incident-response/i.md': '# Incident\n',
    'docs/rfcs/0001.md': '# RFC\n',
    'docs/design/d.md': '# Design\n',
    'docs/brand/components/Button/README.md': '# Button\n',
    'docs/brand/README.md': '# Brand\n',
    'docs/design.md': '# Design notes\n',
    // Excluded words, as a folder or a word of the file name's stem, in any case.
    'docs/cloud/0024-delivery-0-evidence.md': `# Evidence\n\n${['', 'home', 'ana'].join('/')}\n`,
    'docs/API/Internal.md': '# Internal API\n',
    'docs/Deployment/x.md': '# Deploy\n',
    'docs/dogfood-report.md': '# Dogfood\n',
    'docs/RFCs/0002.md': '# RFC\n',
  },
};
const DOCS: FakeRepo = {
  name: 'docs',
  branch: 'main',
  commit: C2,
  files: { 'intro.md': '# Intro\n', 'genie/_internal/cli.mdx': '# CLI\n', 'guides/setup.mdx': '# Setup\n', 'mint.json': '{}\n', 'robots.txt': 'User-agent: *\n', '.github/PULL_REQUEST_TEMPLATE.md': '# PR\n' },
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

/**
 * The work a case started, so cleanup can wait for it. A case that times out leaves its build
 * running; every promise here is observed from the moment it starts and awaited in afterEach, so
 * its rejection cannot arrive unhandled in the next case.
 */
const inFlight = new Set<Promise<unknown>>();
function track<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  void work.then(() => inFlight.delete(work), () => inFlight.delete(work));
  return work;
}
afterEach(async () => {
  // The body of a case that timed out keeps running: a loop, not one snapshot, also settles the
  // work it starts after the deadline. `track` empties the set as each promise settles.
  while (inFlight.size) await Promise.allSettled([...inFlight]);
});

/** A heavy case's deadline: a pack build is a few ms idle, seconds on a loaded host. */
const SLOW_CASE_MS = 30_000;

type CaseOutcome = { state: 'done' } | { state: 'failed'; error: unknown } | { state: 'deadline' };

/**
 * Runs a case's work under its own deadline. The work is tracked and its rejection observed even
 * when it outlives the case, and the case fails at the deadline rather than at Bun's per-test
 * timeout: a timed-out case may leave work running, never an unhandled rejection for the next case.
 */
async function runCase(ms: number, body: () => Promise<void>): Promise<CaseOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<CaseOutcome>((resolve) => { timer = setTimeout(() => resolve({ state: 'deadline' }), ms); });
  const settled = track(body()).then(
    () => ({ state: 'done' }) as CaseOutcome,
    (error) => ({ state: 'failed', error }) as CaseOutcome,
  );
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A test whose real work may pass Bun's 5 s default; it fails at its own deadline instead. */
const slowTest = (name: string, body: () => Promise<void>, ms = SLOW_CASE_MS) =>
  test(name, async () => {
    const outcome = await runCase(ms, body);
    if (outcome.state === 'deadline') throw new Error(`${name}: still running after ${ms} ms`);
    if (outcome.state === 'failed') throw outcome.error;
  }, ms + 10_000);

/** Every file under `dir`, relative, sorted. */
function files(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}
const snapshot = (dir: string) => Object.fromEntries(files(dir).map((f) => [f, readFileSync(join(dir, f)).toString('base64')]));

describe('the knowledge pack', () => {
  slowTest('the allow-list takes READMEs and docs, never env, config, code, binaries or other paths', async () => {
    const out = freshOut();
    await build({ ...gh.opts, out });
    expect(files(out)).toEqual([
      'docs/guides/setup.mdx',
      'docs/intro.md',
      'genie/README.md',
      'genie/README.pt-BR.md',
      'genie/docs/brand/README.md',
      'genie/docs/design.md',
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

  test('each excluded folder is left out wherever it sits; a file of that name is not a folder', () => {
    for (const folder of EXCLUDED_FOLDERS) {
      for (const path of [`docs/${folder}/a.md`, `docs/x/${folder}/y/a.mdx`]) expect([path, allowed('genie', path)]).toEqual([path, false]);
      expect(allowed('docs', `genie/${folder}/a.md`)).toBe(false);
    }
    expect(allowed('genie', 'docs/brand/README.md')).toBe(true);
    expect(allowed('genie', 'docs/components/a.md')).toBe(true);
    expect(allowed('genie', 'docs/design.md')).toBe(true);
    expect(allowed('genie', 'docs/rfcs.md')).toBe(true);
  });

  test('excluded folders match whatever the letter case', () => {
    for (const path of ['docs/RFCs/a.md', 'docs/Plans/a.md', 'docs/_INTERNAL/a.md', 'docs/Brand/Components/a.md', 'docs/x/Incident-Response/a.md']) {
      expect([path, allowed('genie', path)]).toEqual([path, false]);
    }
    expect(allowed('docs', 'Design/a.mdx')).toBe(false);
  });

  test('an excluded word as a folder, or as a word of the file-name stem, is left out in any case', () => {
    expect(EXCLUDED_WORDS).toEqual(['evidence', 'perf', 'performance', 'deployment', 'migration', 'internal', 'dogfood']);
    // The stem is the name without its last extension.
    expect([stem('a.md'), stem('a.b.mdx'), stem('README'), stem('x-evidence.md')]).toEqual(['a', 'a.b', 'README', 'x-evidence']);
    for (const word of EXCLUDED_WORDS) {
      for (const path of [`docs/${word}/a.md`, `docs/x/${word.toUpperCase()}/a.md`, `docs/${word}.md`, `docs/x/0001-${word}.md`,
        `docs/${word}-notes.md`, `docs/a-${word}-b.mdx`, `docs/a_${word}.txt`, `docs/${word[0].toUpperCase()}${word.slice(1)}.md`]) {
        expect([path, allowed('genie', path)]).toEqual([path, false]);
      }
      expect([word, allowed('docs', `guides/${word}.mdx`)]).toEqual([word, false]);
    }
    // The cases named by the ruling.
    for (const path of ['docs/cloud/0024-delivery-0-evidence.md', 'docs/meter/0021-d7-d8-evidence.md', 'docs/api/internal.md',
      'docs/deployment/x.md', 'docs/migration/plan.md', 'docs/performance/x.md', 'docs/perf/x.md', 'docs/dogfood-report.md']) {
      expect([path, allowed('genie', path)]).toEqual([path, false]);
    }
    expect(allowed('docs', 'cloud/0024-delivery-0-evidence.md')).toBe(false);
    // Ordinary product pages, and near words that are not an excluded word, are kept.
    for (const path of ['docs/guide.md', 'docs/getting-started.md', 'docs/cloud/overview.md', 'docs/api/reference.md', 'docs/deploy.md',
      'docs/internals.md', 'docs/migrations.md', 'docs/evidently.md', 'docs/performer.md', 'docs/dogfooding.md', 'docs/self-hosting/install.md']) {
      expect([path, allowed('genie', path)]).toEqual([path, true]);
    }
    expect(allowed('genie', 'README.md')).toBe(true);
    expect(allowed('docs', 'guides/setup.mdx')).toBe(true);
  });

  slowTest('each file carries its stamp, and the manifest lists every file with its size, sha256 and totals', async () => {
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
      { name: 'genie', commit: C1, files: 7, bytes: expect.any(Number) },
      { name: 'omni', commit: C3, files: 1, bytes: expect.any(Number) },
    ]);
    expect(manifest.totals).toEqual({ files: 10, bytes: manifest.files.reduce((s, f) => s + f.bytes, 0), repos: 3 });
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  slowTest('two builds of the same commits are byte-identical, and a rebuild replaces the pack in place', async () => {
    const a = freshOut();
    const b = freshOut();
    await build({ ...gh.opts, out: a });
    await build({ ...gh.opts, out: b });
    expect(snapshot(b)).toEqual(snapshot(a));
    await build({ ...gh.opts, out: a });
    expect(snapshot(a)).toEqual(snapshot(b));
    expect(readdirSync(join(a, '..'))).toEqual(['knowledge']);
  });

  slowTest('a privacy hit fails the build, prints file:line: rule, and keeps the old pack', async () => {
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

  // One build over one repository: the guide is the only pack input this case reads, and building
  // the whole fake org twice was the work that outlasted a five-second timeout under load.
  slowTest('pack placeholders pass; a real-looking personal email or home path still fails', async () => {
    const at = (local: string, domain: string) => `${local}@${domain}`;
    const home = (name: string) => `/${'home'}/${name}`;
    const withGuide = (text: string) => [{ ...GENIE, files: { ...GENIE.files, 'docs/guide.md': text } }];
    const placeholders = [at('you', 'gmail.com'), at('5511999999999', 's.whatsapp.net'), at('120363123456789', 'g.us'),
      at('omni', '2.YYMMDD'), at('git', 'github.com'), at('dpo', 'namastex.ai'), `${home('user')}/x`, `${home('genie')}/.claude`, home('automagik')];
    gh.set(withGuide(`# Guide\n\n${placeholders.join('\n')}\n`));
    try {
      await build({ ...gh.opts, out: freshOut() });
    } finally {
      gh.set(ALL);
    }
    // A tool address outside the three listed ones is a hit too. privacyHits is the check the
    // build runs; one file gives the same answer without a second build.
    const personal = [at('ana.souza', 'gmail.com'), at('xyou', 'gmail.com'), at('5511987654321', 's.whatsapp.net'), at('support', 'github.com'),
      home('username'), home('ana')];
    const dir = join(scratch, `placeholders-${++n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'guide.md'), `# Guide\n\n${personal.join('\n')}\n`);
    expect(privacyHits(dir)).toEqual([
      'guide.md:3: email',
      'guide.md:4: email',
      'guide.md:5: email',
      'guide.md:6: email',
      'guide.md:7: home-path',
      'guide.md:8: home-path',
    ]);
  }, 60_000);

  test('the placeholder list is checked: email or home-path only, a why, an exact match or an anchored pattern', () => {
    const shipped = JSON.parse(readFileSync(PLACEHOLDERS_PATH, 'utf8')).placeholders;
    expect(() => placeholderTest(shipped)).not.toThrow();
    expect(new Set(shipped.map((e: { rule: string }) => e.rule))).toEqual(new Set(['email', 'home-path']));
    for (const rule of ['private-name', 'secret', 'db-file']) {
      expect(() => placeholderTest([{ rule, match: 'x', why: 'w' }])).toThrow(/rule must be one of email, home-path/);
    }
    expect(() => placeholderTest([{ rule: 'email', match: 'x', why: '' }])).toThrow(/needs a why/);
    expect(() => placeholderTest([{ rule: 'email', match: 'x', pattern: '^x$', why: 'w' }])).toThrow(/one of match or pattern/);
    expect(() => placeholderTest([{ rule: 'email', pattern: 'x', why: 'w' }])).toThrow(/anchored/);
    const at = String.fromCharCode(64);
    const pass = placeholderTest([{ rule: 'email', pattern: `^omni${at}v[0-9]+$`, why: 'w' }, { rule: 'home-path', match: 'h', why: 'w' }]);
    expect(pass({ rule: 'email', match: `omni${at}v1` })).toBe(true);
    expect(pass({ rule: 'email', match: `omni${at}v1x` })).toBe(false);
    expect(pass({ rule: 'email', match: 'h' })).toBe(false);
    expect(pass({ rule: 'home-path', match: 'h' })).toBe(true);
    expect(pass({ rule: 'home-path', match: `omni${at}v1` })).toBe(false);
    expect(pass({ rule: 'secret', match: `omni${at}v1` })).toBe(false);
  });

  test('a placeholder pattern that matches empty text, has no literal part or matches unrelated text is refused', () => {
    const load = (pattern: string, rule = 'email') => () => placeholderTest([{ rule, pattern, why: 'w' }]);
    for (const pattern of ['^$', '^.*$', '^(?:x)?$', '^[\\s\\S]*$', '^\\w*$', '^(?:omni@.*)?$']) expect(load(pattern)).toThrow(/matches empty text/);
    for (const pattern of ['^.+$', '^[\\s\\S]+$', '^\\S+$', '^(?:.)+$', '^\\w+\\s?\\d*$', '^[a-z0-9@./]+$', '^.{1,}$']) {
      expect(load(pattern)).toThrow(/has no literal part/);
    }
    // A pinned local part or home name is not enough: the rest must not take a plain word.
    const at = String.fromCharCode(64);
    const home = ['', 'home', ''].join('/');
    for (const pattern of [`^omni${at}.*$`, `^you${at}[a-z]+$`, `^you${at}.+\\.com$`]) expect(load(pattern)).toThrow(/matches unrelated text/);
    for (const pattern of [`^${home}user/.*$`, `^${home}user/[a-z]+$`]) expect(load(pattern, 'home-path')).toThrow(/matches unrelated text/);
    // What counts as a literal part.
    expect(['^x$', '^\\.$', '^\\u0040$', '^a{2}$', '^[0-9]+b$'].map(hasLiteral)).toEqual([true, true, true, true, true]);
    expect(['^.*$', '^[abc]+$', '^\\d{2,4}$', '^(?:\\s|\\S)+$', '^(?<n>.)\\b$'].map(hasLiteral)).toEqual([false, false, false, false, false]);
    // A narrow pattern still loads and passes only its own text.
    const omni = placeholderTest([{ rule: 'email', pattern: `^omni${at}[0-9]+\\.[0-9A-Za-z]+$`, why: 'w' }]);
    expect(omni({ rule: 'email', match: `omni${at}2.251115` })).toBe(true);
    expect(omni({ rule: 'email', match: `omni${at}example.io` })).toBe(false);
  });

  test('a pattern must carry an address\'s whole local part and at sign, or a home\'s whole name, as literal text', () => {
    const load = (pattern: string, rule = 'email') => () => placeholderTest([{ rule, pattern, why: 'w' }]);
    const at = String.fromCharCode(64);
    const home = ['', 'home', ''].join('/');
    const LOCAL = /must carry its whole local part and the at sign as literal text/;
    const NAME = /must carry its whole home name as literal text/;
    const email = [
      // The brief's cases: one letter and a wildcard, any .net text, any lowercase address, any
      // local part at a fixed domain.
      '^a.*$', '^.*.net$', `^[a-z]+${at}[a-z]+\\.[a-z]+$`, `^[a-z]+${at}company\\.com$`, `^.+${at}s\\.whatsapp\\.net$`,
      // Any first.last at a fixed domain, and any hyphenated address.
      `^[a-z]+\\.[a-z]+${at}gmail\\.com$`, `^.+-.+${at}.+$`,
      // One letter, a digit and a wildcard; a wildcard around a literal, on both sides or in a group.
      '^a[0-9].*$', '^.*omni.*$', `^(?:.*${at}gmail\\.com)$`, `^(?:omni|you)${at}x\\.com$`,
      // A local part that demands a digit, a dot, a dash, an underscore or a capital.
      `^[a-z]+[0-9]+${at}gmail\\.com$`, `^.*[0-9]${at}gmail\\.com$`, `^[a-z]+\\.[a-z]+${at}x\\.com$`,
      `^[a-z]+-[a-z]+${at}x\\.com$`, `^[a-z]+_[a-z]+${at}[a-z]+\\.com$`, `^[A-Z][a-z]+${at}x\\.com$`,
      // A pinned prefix that stops short of the at sign, or an at sign under a quantifier.
      `^you[a-z]*${at}x\\.com$`, `^you${at}?x\\.com$`, `^you[${at}]x\\.com$`,
      // Each letter alone or beside a word: the rule needs no probe of that letter.
      ...[...'abcdefghijklmnopqrstuvwxyz'].flatMap((c) => [`^${c}.+$`, `^.+${c}$`, `^(?:x|${c}.*)$`]),
    ];
    const homes = [
      `^${home}[a-z]+$`, `^${home}[a-z]+/.*$`, `^${home}[a-z]+\\.[a-z]+$`, `^${home}[a-z]+_[a-z]+$`, `^${home}[a-z]+[0-9]+$`,
      `^${home}user[0-9]*$`, `^${home}(?:user|genie)$`, `^(?:/Users|/home)/user$`, `^.*${home}user$`,
    ];
    // The same answer on every load: no probe is random.
    for (let run = 0; run < 20; run++) {
      for (const pattern of email) expect(load(pattern)).toThrow(LOCAL);
      for (const pattern of homes) expect(load(pattern, 'home-path')).toThrow(NAME);
    }
    // Each branch is checked on its own, and must be anchored at both ends.
    expect(load(`^omni${at}1\\.0$|^b.*$`)).toThrow(LOCAL);
    // Only the anchoring check stops this one: its open branch pins a local part and passes every
    // probe, yet would pass another address that ends the same way.
    const open = `^zz9$|you${at}x\\.com$`;
    expect(new RegExp(open).test(`me.you${at}x.com`)).toBe(true);
    expect(load(open)).toThrow(/each branch must be anchored/);
    expect(load(`^x$|you${at}.*$`)).toThrow(/each branch must be anchored/);
    expect(load(`^you${at}x\\.com|^me${at}x\\.com$`)).toThrow(/each branch must be anchored/);
    // The branches a pattern is read by, escapes as their character.
    expect(branches(`^omni\\u0040[0-9]+\\.[0-9A-Za-z]+$`)).toEqual([{ anchored: true, exact: false, prefix: `omni${at}`, suffix: '' }]);
    expect(branches('^.*\\.net$')).toEqual([{ anchored: true, exact: false, prefix: '', suffix: '.net' }]);
    expect(branches(`^ab{2}c$|^x\\u0040y$`)).toEqual([
      { anchored: true, exact: false, prefix: 'a', suffix: 'c' },
      { anchored: true, exact: true, prefix: `x${at}y`, suffix: '' },
    ]);
    // The real list still loads, and narrow patterns still load and pass only their own text.
    const shipped: Placeholder[] = JSON.parse(readFileSync(PLACEHOLDERS_PATH, 'utf8')).placeholders;
    expect(() => placeholderTest(shipped)).not.toThrow();
    expect(placeholderTest(shipped)({ rule: 'email', match: `omni${at}2.251115` })).toBe(true);
    const narrow = [`^you${at}x\\.com$|^omni${at}[0-9]+\\.[0-9A-Za-z]+$`, `^you${at}x\\.com$|^me${at}x\\.com$`, `^omni${at}v[0-9]+$`];
    for (const pattern of narrow) expect(load(pattern)).not.toThrow();
    expect(load(`^${home}user$`, 'home-path')).not.toThrow();
    expect(load(`^${home}user/docs/notes$`, 'home-path')).not.toThrow();
    // A pinned local part or home name is not enough: the domain, and the path below the name,
    // must be literal text too, the omni version forms aside. Each branch is checked on its own.
    const DOMAIN = /must carry its whole domain as literal text/;
    for (const pattern of [
      `^a${at}[0-9]$`, `^you${at}[a-z]+\\.[a-z]+$`, `^omni${at}[a-z]+\\.[a-z]+$`, `^you${at}x\\.com$|^you${at}[a-z]+\\.[a-z]+$`,
    ]) expect(load(pattern)).toThrow(DOMAIN);
    expect(load(`^${home}user/[a-z]+/[a-z]+$`, 'home-path')).toThrow(/must carry the path below its home name as literal text/);
    const two = placeholderTest([{ rule: 'email', pattern: narrow[1], why: 'w' }]);
    expect([`you${at}x.com`, `me${at}x.com`, `them${at}x.com`].map((match) => two({ rule: 'email', match }))).toEqual([true, true, false]);
  });

  test('every shipped placeholder is one of the ruled kinds, and none names a person, a home or a personal address', () => {
    const shipped: Placeholder[] = JSON.parse(readFileSync(PLACEHOLDERS_PATH, 'utf8')).placeholders;
    const at = String.fromCharCode(64);
    const split = (text: string) => { const i = text.lastIndexOf(at); return [text.slice(0, i), text.slice(i + 1)]; };
    // Example addresses: a placeholder word or one letter, at a placeholder domain or a one-letter one.
    const EXAMPLE_LOCAL = /^(?:[a-z]|you|your|seu|me|user|personal|work|alice|bob|engineering)$/;
    const EXAMPLE_DOMAIN = /^(?:[a-z]\.com|gmail\.com|company\.com|email\.com|yourdomain\.com)$/;
    // Example WhatsApp JIDs: country 55 + area 11 or a 120363 group prefix, then 9s, 0s or a counting run.
    const RUN = '01234567890123456789';
    const fakeDigits = (d: string) => d === '...' || d === 'xxx' || /^9+$/.test(d) || /^0+$/.test(d) || (d.length > 0 && RUN.includes(d));
    const exampleJid = (local: string, domain: string) =>
      (domain === 's.whatsapp.net' || domain === 'g.us') &&
      local.split('-').every((part) => [/^5511/, /^120363/, /^/].some((prefix) => fakeDigits(part.replace(prefix, ''))));
    const ROLE = /^(?:privacidade|dpo|security)$/;
    const ORG = /^namastex\.(?:ai|io)$/;
    const HOMES = ['user', 'genie', 'automagik'].map((n) => ['', 'home', n].join('/'));
    // Public service and tool addresses: exactly these three, exact matches only. A new one needs Chat's word.
    const TOOLS = [['git', 'github.com'], ['actions', 'github.com'], ['security', 'npmjs.com']].map(([l, d]) => `${l}${at}${d}`);
    const kind = (e: Placeholder): string | null => {
      if (e.rule === 'home-path') return e.match !== undefined && HOMES.includes(e.match) ? 'generic home' : null;
      if (e.rule !== 'email') return null;
      if (e.pattern !== undefined) {
        // Only omni@<version> may be a pattern: a pattern of any other kind (a tool address included) is refused.
        const re = new RegExp(e.pattern);
        const omni = e.pattern.startsWith(`^omni${at}`) && re.test(`omni${at}2.251115`) && !re.test(`omni${at}rk4t.io`);
        return omni ? 'omni version' : null;
      }
      if (e.match !== undefined && TOOLS.includes(e.match)) return 'public service or tool address';
      const [local, domain] = split(e.match ?? '');
      if (EXAMPLE_LOCAL.test(local) && EXAMPLE_DOMAIN.test(domain)) return 'example address';
      if (exampleJid(local, domain)) return 'example WhatsApp JID';
      if (ROLE.test(local) && ORG.test(domain)) return 'org role contact';
      return null;
    };
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.map((e) => [e.match ?? e.pattern, kind(e)]).filter(([, k]) => k === null)).toEqual([]);
    expect(new Set(shipped.map(kind))).toEqual(
      new Set(['example address', 'example WhatsApp JID', 'generic home', 'omni version', 'org role contact', 'public service or tool address']),
    );
    expect(shipped.filter((e) => kind(e) === 'public service or tool address').map((e) => e.match).sort()).toEqual([...TOOLS].sort());
    // The kinds' own edges: a real-looking number, another home, a personal or tool address fail.
    const no = (e: Partial<Placeholder>) => expect([e, kind({ why: 'w', ...e } as Placeholder)]).toEqual([e, null]);
    no({ rule: 'email', match: `5511987654321${at}s.whatsapp.net` });
    no({ rule: 'email', match: `ana.souza${at}gmail.com` });
    no({ rule: 'email', match: `support${at}github.com` });
    no({ rule: 'email', match: `security${at}github.com` });
    // A tool address is an exact match bound to the email rule: as a pattern, or under another rule, it is refused.
    no({ rule: 'email', pattern: `^git${at}github\\.com$` });
    no({ rule: 'email', pattern: `^actions${at}github\\.com$` });
    no({ rule: 'home-path', match: `git${at}github.com` });
    no({ rule: 'home-path', match: ['', 'home', 'ana'].join('/') });
    no({ rule: 'email', pattern: `^omni${at}.+$` });
    no({ rule: 'email', pattern: `^you${at}gmail\\.com$` });
  });

  test('a pattern placeholder is bound to its rule: a hit under another rule whose text matches it still fails', () => {
    const dir = join(scratch, `rule-bound-${++n}`);
    mkdirSync(dir, { recursive: true });
    const token = `${'gh'}p_${'A1'.repeat(18)}`;
    writeFileSync(join(dir, 'a.md'), `# A\n\n${['', 'home', 'ana'].join('/')}\n${token}\n`);
    const hits = ['a.md:3: home-path', 'a.md:4: secret'];
    expect(privacyHits(dir, [])).toEqual(hits);
    // Email-rule patterns whose text covers each hit's match let neither through.
    const broad = [{ rule: 'email', pattern: `^${['', 'home', 'ana'].join('/')}$`, why: 'w' }, { rule: 'email', pattern: `^${token}$`, why: 'w' }];
    expect(privacyHits(dir, broad)).toEqual(hits);
    // The same patterns under the hit's own rule do pass it.
    expect(privacyHits(dir, [{ ...broad[0], rule: 'home-path' }])).toEqual(['a.md:4: secret']);
  });

  slowTest('a read GitHub refuses fails the build and keeps the old pack', async () => {
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

  slowTest('a listing entry that is not public fails the build', async () => {
    gh.set([...ALL, { name: 'secret', branch: 'main', commit: C1, private: true, files: { 'README.md': '# s\n' } }]);
    try {
      await expect(build({ ...gh.opts, out: freshOut() })).rejects.toThrow(/secret is not public/);
    } finally {
      gh.set(ALL);
    }
  });

  slowTest('a folder that is not a pack is never replaced', async () => {
    const out = freshOut();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'mine\n');
    await expect(build({ ...gh.opts, out })).rejects.toThrow(/is not a knowledge pack/);
    expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('mine\n');
  });

  slowTest('a token in the environment goes unused: no request carries credentials', async () => {
    const out = freshOut();
    gh.seen.length = 0;
    const env = { ...process.env, GH_TOKEN: 'test-token-not-real', GITHUB_TOKEN: 'test-token-not-real' };
    const args = ['build', '--out', out, '--api', gh.opts.api, '--archive', gh.opts.archive];
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'knowledge-pack.ts'), ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/knowledge pack: 10 file\(s\), \d+ bytes, 3 repo\(s\); privacy check clean/);
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

// The guard the heavy cases use, in the two states a leak needs: a case whose deadline passes
// while its work is still running, then the following case, which sees that work settled by
// cleanup. Without the afterEach await, the second case starts with the work still in flight and
// fails; without the tracked, observed rejection, the run reports an unhandled rejection between
// the two.
describe('a case that times out', () => {
  let late: 'pending' | 'rejected' = 'pending';

  test('abandons its work at the deadline, and that work rejects afterwards', async () => {
    const outcome = await runCase(20, async () => {
      await new Promise<never>((_, reject) => {
        setTimeout(() => {
          late = 'rejected';
          reject(new Error('late rejection from the timed-out case'));
        }, 200);
      });
    });
    expect(outcome).toEqual({ state: 'deadline' });
  });

  test('the following case is green: cleanup settled the work before it started', () => {
    expect([inFlight.size, late]).toEqual([0, 'rejected']);
  });
});
