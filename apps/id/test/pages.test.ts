// The owner's pages (pages/sign-in.html, pages/consent.html) against PAGES-CONTRACT.md.
//
// Three layers:
//  1. Files: same-origin only, no inline code, only the contract's endpoints, nothing stored
//     or logged. Always runs.
//  2. A real Chromium on the real Worker (Miniflare, D1, the pages as its static assets) with
//     a virtual authenticator: create a passkey, sign in, allow, cancel, and the WhatsApp
//     message, sent to the service as its own receiver gets it.
//  3. Every state of both pages with the service's answers scripted, each checked for its
//     words, console errors, the calls it made and sideways overflow at 390 and 320 wide.
//
// Layers 2 and 3 need playwright-core (a dev dependency here) and a Chromium
// (`node node_modules/playwright-core/cli.js install chromium`); without one they are skipped,
// unless ID_PAGES_BROWSER=required, as CI sets it. ID_PAGES_CHROME names another Chromium.
// ID_PAGES_SHOTS=<folder> also writes a picture of every state at 1440 and 390, light and
// dark (and at 320, light), with an INDEX.md and a recording of the WhatsApp flow at phone
// width; ID_PAGES_ONLY=<text,text> keeps the states whose name holds one.
import { afterAll, describe, expect, test } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clientSeedSQL } from '../scripts/client-seed';

const CONTRACT = [
  '/api/id/config', '/api/auth/get-session', '/api/auth/sign-out',
  '/api/auth/oauth2/public-client-prelogin', '/api/auth/oauth2/continue', '/api/auth/oauth2/consent',
  '/api/auth/passkey/generate-authenticate-options', '/api/auth/passkey/verify-authentication',
  '/api/auth/passkey/generate-register-options', '/api/auth/passkey/verify-registration',
  '/api/auth/whatsapp/start', '/api/auth/whatsapp/status',
];
const PAGES = ['sign-in', 'consent'] as const;
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const read = (name: string) => readFile(resolve('pages', name), 'utf8');

describe('pages: files', () => {
  test('the page script calls only endpoints the page contract names', async () => {
    const contract = await readFile('PAGES-CONTRACT.md', 'utf8');
    for (const path of CONTRACT) expect(contract, path).toContain(path);
    const script = await read('id.js');
    const called = [...script.matchAll(/['"`](\/api\/[^'"`?]*)/g)].map(match => match[1]);
    expect(called.length).toBeGreaterThan(8);
    for (const path of called) expect(CONTRACT, path).toContain(path);
    // The only other address it builds is the sign-in page, with the query as it came.
    const others = [...script.matchAll(/['"`](\/[a-z][^'"`\s]*)/g)].map(match => match[1])
      .filter(path => !path.startsWith('/api/'));
    expect([...new Set(others)]).toEqual(['/sign-in?${oauthQuery}']);
  });

  test('the page script stores nothing, logs nothing and writes no markup', async () => {
    const script = await read('id.js');
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'console.',
      'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function',
      'redirect_uri', 'http://', 'https://']) {
      expect(script.includes(banned), banned).toBe(false);
    }
  });

  test('pages load only files of their own, with no inline script or style', async () => {
    const css = await read('id.css');
    const loaded = new Set<string>();
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)/g)) loaded.add(match[1]);
    expect(css.includes('@import')).toBe(false);
    for (const page of PAGES) {
      const html = await read(`${page}.html`);
      expect(html, page).toContain(`<body data-page="${page}">`);
      expect(html, page).toMatch(/Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'/);
      expect(html.match(/<script\b[^>]*>/g), page).toEqual(['<script src="/id.js" defer>']);
      expect(/<style\b|\sstyle=|\son[a-z]+=|javascript:/i.test(html), page).toBe(false);
      expect(/type="(email|password)"|autocomplete="[^"]*(email|password)/i.test(html), page).toBe(false);
      // Nothing is typed on these pages: no phone number, no code.
      expect(/<(input|textarea|select|form)\b/i.test(html), page).toBe(false);
      for (const match of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) loaded.add(match[1]);
    }
    expect(loaded.size).toBeGreaterThan(5);
    for (const path of loaded) {
      expect(path.startsWith('/') && !path.startsWith('//'), path).toBe(true);
      expect(existsSync(resolve('pages', path.slice(1))), path).toBe(true);
    }
  });

  // Without this the browser layers below skip in CI and nobody notices.
  test('Genie is the approved whole figure, and no head-only Genie file is left', async () => {
    const strip = await readFile(resolve('pages/assets/genie-faces.webp'));
    const approved = '9df7083cca4a14afc804875b87d9f9cdd18c032f725084f2424434e502bac926';
    expect(createHash('sha256').update(strip).digest('hex')).toBe(approved);
    // Seven cells of 192 x 208 side by side; a lossless WebP holds its size in its header.
    expect(strip.toString('latin1', 0, 4) + strip.toString('latin1', 8, 16)).toBe('RIFFWEBPVP8L');
    const bits = strip.readUInt32LE(21);
    expect([(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1]).toEqual([7 * 192, 208]);
    // The folder holds this one Genie file and nothing else that could be an older one.
    expect((await readdir(resolve('pages/assets'))).sort()).toEqual([
      'LICENSES.md', 'OFL-DMSans.txt', 'OFL-Manrope.txt', 'automagik-lockup-three-colours-cream-header.svg',
      'automagik-lockup-three-colours-ink-header.svg', 'dm-sans-latin.woff2', 'genie-faces.webp', 'icon.png',
      'manrope-latin.woff2', 'omni-faces.webp',
    ]);
    const notes = await read('assets/LICENSES.md');
    expect(notes).toContain(`SHA-256 \`${approved}\``);
    expect(notes).toContain('The earlier head-only Genie is retired and no file of it is left here.');
    const css = await read('id.css');
    expect(css).toContain('[data-who="genie"] .pet,[data-who="omni"] .pal{aspect-ratio:192/208;background-image:url("/assets/genie-faces.webp")}');
    expect([...css.matchAll(/genie[\w-]*\.(?:webp|png|svg)/g)].map(match => match[0])).toEqual(['genie-faces.webp']);
  });

  test('the logo is the approved set\'s lockup, unchanged, on both pages, and the old capitals are gone', async () => {
    const notes = await read('assets/LICENSES.md');
    const files = ['automagik-lockup-three-colours-ink-header.svg', 'automagik-lockup-three-colours-cream-header.svg'];
    // Each file is the set's, byte for byte: its digest is the one recorded beside its source.
    const pinned = new Map([...notes.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map(match => [match[1], match[3]]));
    expect([...pinned.keys()]).toEqual(files);
    for (const [file, colour] of [[files[0], '#3c3049'], [files[1], '#f3e9dd']]) {
      const svg = await readFile(resolve('pages/assets', file));
      expect(createHash('sha256').update(svg).digest('hex'), file).toBe(pinned.get(file));
      // One box for both, the letters' tone in the file's colour, and nothing that could load
      // or run. What the file draws is pinned only by its digest, so a newer set is a file swap.
      const text = svg.toString('utf8');
      expect(text.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -186 1632.34 264" role="img" aria-label="Automagik" color="${colour}">`), file).toBe(true);
      expect(/<script|<foreignObject|<image|<text|href=|url\((?!#)/i.test(text), file).toBe(false);
    }
    // One picture on each page: ink letters on the light page, cream on the dark one.
    const logo = '<header class="brand"><picture><source media="(prefers-color-scheme: dark)" srcset="/assets/automagik-lockup-three-colours-cream-header.svg">'
      + '<img src="/assets/automagik-lockup-three-colours-ink-header.svg" width="1632" height="264" alt="Automagik"></picture></header>';
    for (const page of PAGES) {
      const html = await read(`${page}.html`);
      expect(html.split(logo).length, page).toBe(2);
      expect(html.match(/<(?:img|source|picture)\b/g), page).toEqual(['<picture', '<source', '<img']);
      expect(/wordmark/i.test(html), page).toBe(false);
    }
    expect(existsSync(resolve('pages/assets/wordmark.webp'))).toBe(false);
    // Sized by the triskle's height as on the site (32 px in a wide window, 26 on a phone,
    // 23 under 360 px), and no rule draws on the logo.
    const css = await read('id.css');
    expect(css).toContain('.brand{--mark:26px;order:-1;display:flex;justify-content:center}\n.brand picture{display:contents}\n.brand img{display:block;width:auto;height:calc(var(--mark)*264/222)}\n');
    expect([...css.matchAll(/\n\s*\.brand\{--mark:(\d+)px/g)].map(match => Number(match[1]))).toEqual([26, 23, 32]);
    for (const [rule] of css.matchAll(/[^{}]*\.brand[^{}]*\{[^}]*\}/g)) expect(/filter|shadow|stroke|opacity|transform|scale|rotate|animation|transition|background|object-/.test(rule), rule).toBe(false);
    expect(/wordmark/i.test(css)).toBe(false);
  });

  test('the CI job runs the browser tests', async () => {
    const workflow = await readFile(resolve('..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('\n  id:\n'), workflow.indexOf('\n  privacy:\n'));
    expect(job).toContain('working-directory: apps/id');
    expect(job).toMatch(/\n {6}ID_PAGES_BROWSER: required\n/);
    expect(job).toMatch(/playwright-core\/cli\.js install --with-deps chromium/);
    expect(job.indexOf('install --with-deps chromium')).toBeLessThan(job.indexOf('bun run test'));
  });
});

// ---- A browser and a local service ---------------------------------------------------
const required = process.env.ID_PAGES_BROWSER === 'required';
const shots = process.env.ID_PAGES_SHOTS ? resolve(process.env.ID_PAGES_SHOTS) : '';
const only = (process.env.ID_PAGES_ONLY ?? '').split(',').filter(Boolean);
let browser: any;
let browserTried = false;
let browserError: unknown;
let root = '';
let bundle = '';
const worlds: Miniflare[] = [];

async function chromium(): Promise<any> {
  if (browserTried) {
    if (required && browserError) throw browserError;
    return browser;
  }
  browserTried = true;
  try {
    const library = 'playwright-core';
    const { chromium: engine } = await import(/* @vite-ignore */ library);
    browser = await engine.launch({
      executablePath: process.env.ID_PAGES_CHROME || process.env.LANDING_CHROME || undefined,
      args: ['--no-sandbox'],
    });
  } catch (error) {
    browserError = error;
    if (required) throw error;
    browser = null;
  }
  return browser;
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

// The real Worker with the real pages as its static assets, on a local port. `localhost` is
// a secure context, so passkeys work as they do on the deployed origin.
async function world(options: { whatsapp?: boolean } = {}) {
  if (!bundle) {
    await mkdir('.wrangler', { recursive: true });
    root = await mkdtemp('.wrangler/test-pages-');
    bundle = resolve(root, 'worker.mjs');
    await build({
      entryPoints: ['src/index.ts'], outfile: bundle, bundle: true, format: 'esm',
      platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker'],
      external: ['node:*', 'cloudflare:*'], logLevel: 'silent',
    });
  }
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const mf = new Miniflare({
    modules: [{ type: 'ESModule', path: bundle }],
    compatibilityDate: '2025-11-18', compatibilityFlags: ['nodejs_compat'],
    host: '127.0.0.1', port,
    d1Databases: { DB: 'pages-test-identity' }, d1Persist: resolve(await mkdtemp(`${root}/db-`)),
    assets: {
      directory: resolve('pages'), binding: 'PAGES',
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      assetConfig: { html_handling: 'none' },
    },
    outboundService: async () => { throw new Error('Unexpected outbound network request'); },
    bindings: {
      BETTER_AUTH_URL: origin,
      // Local runs only: a passkey for localhost works on localhost and nowhere else.
      PASSKEY_RP_ID: 'localhost',
      BETTER_AUTH_SECRET: 'test-only-auth-secret-placeholder-never-deployed',
      // The service's own test values: with both set, it offers WhatsApp.
      ...(options.whatsapp ? { WHATSAPP_RECEIVING_NUMBER: RECEIVING, OMNI_INBOUND_TOKEN: INBOUND_TOKEN } : {}),
    },
  });
  worlds.push(mf);
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const file of ['migrations/0001_auth.sql', 'migrations/0002_whatsapp.sql']) {
    const migration = await readFile(file, 'utf8');
    for (const sql of migration.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  for (const sql of clientSeedSQL(digest('test-only-cloud-client-secret-never-deployed')).split(';').filter(Boolean)) {
    await db.prepare(sql).run();
  }
  await db.prepare(`INSERT INTO oauthClient
    (id, clientId, name, applicationType, tokenEndpointAuthMethod, redirectUris,
     scopes, grantTypes, responseTypes, skipConsent, requirePKCE)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    'test-third-party', 'test-third-party', 'Example third party', 'web', 'none',
    JSON.stringify(['https://third.example.com/callback']),
    JSON.stringify(['openid', 'profile']), JSON.stringify(['authorization_code']),
    JSON.stringify(['code']), 0, 1,
  ).run();
  // A message as the service's receiver gets it from WhatsApp: server to server, never from
  // a page. The answer is the reply the sender gets, or null when the service stays silent.
  const send = async (from: string, text: string): Promise<string | null> => {
    const response = await fetch(`${origin}/api/omni/inbound`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INBOUND_TOKEN}`, 'x-omni-event-id': randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: Date.now(), payload: { from, externalId: randomUUID(), content: { text } } }),
    });
    return response.status === 200 ? ((await response.json()) as { reply: string }).reply : null;
  };
  return { origin, send };
}
const RECEIVING = '15555550100';
const INBOUND_TOKEN = 'test-only-inbound-token-placeholder-not-deployed';

afterAll(async () => {
  await browser?.close();
  await Promise.all(worlds.map(mf => mf.dispose()));
  if (root) await rm(root, { recursive: true, force: true });
});

// What a page did: console errors, script errors and every request it made.
function watch(page: any) {
  const seen = { errors: [] as string[], requests: [] as string[] };
  page.on('console', (message: any) => {
    if (message.type() === 'error') seen.errors.push(`${message.text()} ${message.location()?.url ?? ''}`);
  });
  page.on('pageerror', (error: Error) => seen.errors.push(`pageerror ${error.message}`));
  page.on('request', (request: any) => seen.requests.push(`${request.method()} ${request.url()}`));
  return seen;
}
// Every request stays on the service's origin and is a page, one of its files or a contract
// endpoint. `exits` are the addresses the service itself sent the browser to.
function expectOnlyContract(seen: { requests: string[] }, origin: string, exits: string[] = []) {
  for (const entry of seen.requests) {
    const raw = entry.slice(entry.indexOf(' ') + 1);
    if (exits.some(exit => raw.startsWith(exit))) continue;
    const url = new URL(raw);
    expect(url.origin, entry).toBe(origin);
    const fine = url.pathname === '/sign-in' || url.pathname === '/consent' || url.pathname === '/id.css' ||
      url.pathname === '/id.js' || url.pathname.startsWith('/assets/') || CONTRACT.includes(url.pathname);
    expect(fine, entry).toBe(true);
  }
}
// The browser reports a refused call as a console error; nothing else may be one.
function expectErrors(seen: { errors: string[] }, refusedCalls = 0) {
  const other = seen.errors.filter(error => !/^Failed to load resource/.test(error));
  expect(other).toEqual([]);
  expect(seen.errors.length, seen.errors.join('\n')).toBe(refusedCalls);
}
const heading = (page: any) => page.locator('#title').innerText().then((text: string) => text.replace(/\s+/g, ' ').trim());
const said = (page: any) => page.locator('#say').innerText().then((text: string) => text.replace(/\u00a0/g, ' '));
const view = (page: any) => page.locator('#card [data-view]:not([hidden])').getAttribute('data-view');
const onPhone = (page: any): Promise<boolean> => page.evaluate(`matchMedia('(hover: none) and (pointer: coarse)').matches`);

// ---- The QR code, read back the way a phone's camera would ---------------------------
// From the module grid to the text: the format word, the fixed marks, the mask, the block
// layout and every check word are verified against the standard, not against the page.
function readCode(grid: boolean[][]): { text: string; version: number; mask: number } {
  const size = grid.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) throw new Error(`QR size ${size}`);
  const at = (x: number, y: number) => (grid[y][x] ? 1 : 0);
  const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const second: number[][] = [];
  for (let i = 0; i < 8; i++) second.push([size - 1 - i, 8]);
  for (let i = 0; i < 7; i++) second.push([8, size - 7 + i]);
  const word = (spots: number[][]) => spots.reduce((value, [x, y], i) => value | at(x, y) << i, 0);
  const format = word(first) ^ 0x5412;
  if (format !== (word(second) ^ 0x5412)) throw new Error('QR format copies differ');
  let rest = format;
  for (let i = 14; i >= 10; i--) if (rest >> i & 1) rest ^= 0x537 << (i - 10);
  if (rest !== 0) throw new Error('QR format check');
  if (!at(8, size - 8)) throw new Error('QR dark module');
  if (format >> 13 !== 0) throw new Error('QR level is not M');
  const mask = format >> 10 & 7;
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8) || x === 6 || y === 6) fixed[y][x] = true;
    if (version >= 7 && ((x >= size - 11 && y < 6) || (y >= size - 11 && x < 6))) fixed[y][x] = true;
  }
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    const step = Math.ceil((size - 13) / (count * 2 - 2)) * 2;
    const centres = [6];
    for (let i = count - 2; i >= 0; i--) centres.push(size - 7 - i * step);
    for (const cy of centres) for (const cx of centres) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        fixed[cy + dy][cx + dx] = true;
        if (grid[cy + dy][cx + dx] !== (Math.max(Math.abs(dx), Math.abs(dy)) !== 1)) throw new Error('QR alignment mark');
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    if (grid[6][i] !== (i % 2 === 0) || grid[i][6] !== (i % 2 === 0)) throw new Error('QR timing');
  }
  for (const [fx, fy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
      if (grid[fy + dy][fx + dx] !== (Math.max(Math.abs(dx - 3), Math.abs(dy - 3)) !== 2)) throw new Error('QR finder');
    }
  }
  if (version >= 7) {
    let value = 0;
    for (let i = 0; i < 18; i++) {
      const bit = at(size - 11 + i % 3, Math.floor(i / 3));
      if (bit !== at(Math.floor(i / 3), size - 11 + i % 3)) throw new Error('QR version copies differ');
      value |= bit << i;
    }
    let left = value;
    for (let i = 17; i >= 12; i--) if (left >> i & 1) left ^= 0x1f25 << (i - 12);
    if (value >> 12 !== version || left !== 0) throw new Error('QR version word');
  }
  // The standard's masks, by row i and column j.
  const masked = [
    (i: number, j: number) => (i + j) % 2 === 0, (i: number) => i % 2 === 0, (_: number, j: number) => j % 3 === 0,
    (i: number, j: number) => (i + j) % 3 === 0, (i: number, j: number) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i: number, j: number) => (i * j) % 2 + (i * j) % 3 === 0, (i: number, j: number) => ((i * j) % 2 + (i * j) % 3) % 2 === 0,
    (i: number, j: number) => ((i + j) % 2 + (i * j) % 3) % 2 === 0,
  ][mask];
  const bits: number[] = [];
  let up = true;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column--;
    for (let n = 0; n < size; n++) {
      const y = up ? size - 1 - n : n;
      for (const x of [column, column - 1]) if (!fixed[y][x]) bits.push(at(x, y) ^ (masked(y, x) ? 1 : 0));
    }
    up = !up;
  }
  const words: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  // Level M: the data words of each block, and the check words every block carries.
  const layout: [number[], number][] = [[[], 0], [[16], 10], [[28], 16], [[44], 26], [[32, 32], 18], [[43, 43], 24],
    [[27, 27, 27, 27], 16], [[31, 31, 31, 31], 18], [[38, 38, 39, 39], 22], [[36, 36, 36, 37, 37], 22], [[43, 43, 43, 43, 44], 26]];
  const [sizes, checks] = layout[version];
  if (words.length !== sizes.reduce((sum, n) => sum + n + checks, 0)) throw new Error(`QR has ${words.length} words`);
  const blocks: number[][] = sizes.map(() => []);
  let next = 0;
  for (let i = 0; i < Math.max(...sizes); i++) sizes.forEach((n, b) => { if (i < n) blocks[b].push(words[next++]); });
  for (let i = 0; i < checks; i++) blocks.forEach(block => block.push(words[next++]));
  // Every block is a multiple of the generator: all its syndromes are zero.
  const exp: number[] = [];
  const log: number[] = [];
  for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (const block of blocks) {
    for (let k = 0; k < checks; k++) {
      let sum = 0;
      block.forEach((value, j) => { if (value) sum ^= exp[(log[value] + k * (block.length - 1 - j)) % 255]; });
      if (sum !== 0) throw new Error('QR check words');
    }
  }
  const stream = blocks.flatMap((block, b) => block.slice(0, sizes[b])).map(value => value.toString(2).padStart(8, '0')).join('');
  if (stream.slice(0, 4) !== '0100') throw new Error('QR mode');
  const wide = version < 10 ? 8 : 16;
  const length = parseInt(stream.slice(4, 4 + wide), 2);
  const bytes: number[] = [];
  for (let i = 0; i < length; i++) bytes.push(parseInt(stream.slice(4 + wide + i * 8, 12 + wide + i * 8), 2));
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)), version, mask };
}
// The picture of the code on the page, pixel by pixel: dark modules on a light ground, in
// either colour scheme, or a camera would not read it.
async function scanned(page: any): Promise<string> {
  const picture: Buffer = await page.locator('#qr-code').screenshot();
  const reader = await page.context().newPage();
  const rows: string[] = await reader.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(picture.toString('base64'))}), c => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const pen = new OffscreenCanvas(image.width, image.height).getContext('2d');
    pen.drawImage(image, 0, 0);
    const { data, width, height } = pen.getImageData(0, 0, image.width, image.height);
    const rows = [];
    for (let y = 0; y < height; y++) {
      let row = '';
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        row += (data[at] * 299 + data[at + 1] * 587 + data[at + 2] * 114) / 1000 < 128 ? '1' : '0';
      }
      rows.push(row);
    }
    return rows;
  })()`);
  await reader.close();
  const inked = rows.map((row, y) => ({ y, from: row.indexOf('1'), to: row.lastIndexOf('1') })).filter(row => row.from >= 0);
  expect(inked.length, 'the code is drawn').toBeGreaterThan(20);
  const top = inked[0].y;
  const bottom = inked[inked.length - 1].y;
  const left = Math.min(...inked.map(row => row.from));
  const right = Math.max(...inked.map(row => row.to));
  // The first dark run of the top row is the corner mark's edge, seven modules: the code's
  // size is the one a QR code can have (21, 25, ... 57) that fits that best.
  const module = rows[top].slice(left).indexOf('0') / 7;
  const size = [21, 25, 29, 33, 37, 41, 45, 49, 53, 57]
    .reduce((best, n) => (Math.abs((right - left + 1) / n - module) < Math.abs((right - left + 1) / best - module) ? n : best));
  expect(Math.abs((bottom - top) - (right - left)), 'the code is square').toBeLessThanOrEqual(1);
  // Light all round it, at least two modules, inside the picture.
  expect(Math.min(top, left, rows.length - 1 - bottom, rows[0].length - 1 - right), 'quiet zone').toBeGreaterThanOrEqual(Math.floor(module * 2) - 1);
  const pitch = (right - left + 1) / size;
  const grid = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) =>
    rows[Math.floor(top + (y + 0.5) * pitch)][Math.floor(left + (x + 0.5) * pitch)] === '1'));
  return readCode(grid).text;
}

describe('pages: the real Worker and its static files', () => {
  test('a page answers only at its own address; its .html file is never served directly', async () => {
    const { origin } = await world();
    for (const page of PAGES) {
      const served = await fetch(`${origin}/${page}?state=opaque`);
      expect(served.status, page).toBe(200);
      expect(await served.text(), page).toBe(await read(`${page}.html`));
      expect(served.headers.get('x-frame-options'), page).toBe('DENY');
      expect(served.headers.get('referrer-policy'), page).toBe('no-referrer');
      expect(served.headers.get('cache-control'), page).toBe('no-store');
      for (const direct of [`/${page}.html`, `/${page}.html?state=opaque`, `/${page}%2Ehtml`,
        `/${page}.HTML`, `/${page}.html/`]) {
        const response = await fetch(`${origin}${direct}`, { redirect: 'manual' });
        expect(response.status, direct).toBe(404);
        expect(await response.text(), direct).toBe('Not found');
      }
    }
    for (const file of ['/id.css', '/id.js', '/assets/genie-faces.webp', '/assets/omni-faces.webp', '/assets/manrope-latin.woff2']) {
      expect((await fetch(`${origin}${file}`)).status, file).toBe(200);
    }
  });
});

// The exact policy PAGES-CONTRACT.md names; every answer carries it and the others.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; " +
  "base-uri 'none'; object-src 'none'";
function secured(response: Response, label: string) {
  expect(response.headers.get('x-content-type-options'), label).toBe('nosniff');
  expect(response.headers.get('strict-transport-security'), label).toBe('max-age=31536000; includeSubDomains');
  expect(response.headers.get('referrer-policy'), label).toBe('no-referrer');
  expect(response.headers.get('x-frame-options'), label).toBe('DENY');
  const csp = response.headers.get('content-security-policy');
  expect(csp, label).toBe(CSP);
  expect(/unsafe-/i.test(csp ?? ''), label).toBe(false);
}

describe('security headers', () => {
  test('security headers on every answer: pages, files, .html, API, well-known, unknown', async () => {
    const { origin } = await world();
    const routes: [string, RequestInit, number][] = [
      ['/sign-in?state=opaque', {}, 200], ['/consent', {}, 200],
      ['/id.css', {}, 200], ['/id.js', {}, 200], ['/assets/genie-faces.webp', {}, 200],
      ['/assets/manrope-latin.woff2', {}, 200], ['/assets/automagik-lockup-three-colours-ink-header.svg', {}, 200],
      ['/sign-in.html', {}, 404], ['/consent.html', {}, 404], ['/assets/missing.png', {}, 404],
      ['/api/auth/get-session', {}, 200], ['/api/auth/jwks', {}, 200], ['/api/id/config', {}, 200],
      ['/api/auth/list-sessions', {}, 401],
      ['/api/auth/revoke-session', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'unknown' }) }, 401],
      ['/api/auth/revoke-sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{}' }, 401],
      ['/api/auth/oauth2/register', { method: 'POST' }, 404],
      ['/.well-known/openid-configuration', {}, 200],
      ['/.well-known/oauth-authorization-server/api/auth', {}, 200],
      ['/no-such-page', {}, 404], ['/api/no-such-route', {}, 404],
    ];
    for (const [path, init, status] of routes) {
      // HEAD as well where the static files answer it; Better Auth answers HEAD with 404.
      const head = !init.method && !path.startsWith('/api/') && !path.startsWith('/.well-known/');
      for (const method of [init.method ?? 'GET', ...(head ? ['HEAD'] : [])]) {
        const response = await fetch(`${origin}${path}`, { ...init, method, redirect: 'manual' });
        await response.arrayBuffer();
        expect(response.status, `${method} ${path}`).toBe(status);
        secured(response, `${method} ${path}`);
      }
    }
    // The pages keep their own no-store and their HTML type.
    for (const page of PAGES) {
      const response = await fetch(`${origin}/${page}`);
      expect(response.headers.get('content-type'), page).toMatch(/^text\/html/);
      expect(response.headers.get('cache-control'), page).toBe('no-store');
      expect(await response.text(), page).toBe(await read(`${page}.html`));
    }
  });

  test('security headers keep Better Auth redirects and cookies as they were', async () => {
    const { origin } = await world();
    const query = new URLSearchParams({
      client_id: 'automagik-desktop', redirect_uri: 'http://127.0.0.1:53001/callback', response_type: 'code',
      scope: 'openid profile', state: 'test-state', nonce: 'test-nonce',
      code_challenge: digest('a'.repeat(64)), code_challenge_method: 'S256',
    });
    const response = await fetch(`${origin}/api/auth/oauth2/authorize?${query}`, { redirect: 'manual' });
    // Better Auth answers with a Location or with {redirect, url}; either still points at the page.
    const body = await response.text();
    const target = response.headers.get('location') ?? JSON.parse(body).url;
    expect([200, 302]).toContain(response.status);
    expect(new URL(target, origin).pathname).toBe('/sign-in');
    expect(new URL(target, origin).searchParams.get('state')).toBe('test-state');
    secured(response, 'authorize');
    // A passkey ceremony sets its challenge cookie; it arrives intact beside the headers.
    const options = await fetch(`${origin}/api/auth/passkey/generate-authenticate-options`, {
      headers: { origin },
    });
    expect(options.status).toBe(200);
    expect(options.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(options.headers.getSetCookie().join('\n')).toMatch(/HttpOnly/i);
    secured(options, 'passkey options');
  });

  test('the pages\' own meta policy is no looser than the header policy', async () => {
    for (const page of PAGES) {
      const html = await read(`${page}.html`);
      const meta = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
      expect(/unsafe-/i.test(meta), page).toBe(false);
      for (const directive of ["script-src 'self'", "style-src 'self'", "default-src 'none'"]) {
        expect(meta, page).toContain(directive);
      }
    }
  });
});

describe('pages: a real browser on the real Worker', () => {
  const authorize = (origin: string, overrides: Record<string, string> = {}) => `${origin}/api/auth/oauth2/authorize?` +
    new URLSearchParams({
      client_id: 'automagik-desktop', redirect_uri: 'http://127.0.0.1:53001/callback', response_type: 'code',
      scope: 'openid profile', state: 'test-state', nonce: 'test-nonce',
      code_challenge: digest('a'.repeat(64)), code_challenge_method: 'S256', ...overrides,
    });
  const third = { client_id: 'test-third-party', redirect_uri: 'https://third.example.com/callback' };
  const exits = ['http://127.0.0.1:53001/callback', 'https://third.example.com/callback'];

  async function visitor(origin: string, address: string, device: Record<string, unknown> = {}, pause = 0) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'cf-connecting-ip': address }, ...device,
    });
    const page = await context.newPage();
    // The products' own callbacks are not part of this service: answer them here.
    for (const exit of exits) {
      await page.route(`${exit}**`, async (route: any) => {
        if (pause) await new Promise(done => setTimeout(done, pause));
        await route.fulfill({ contentType: 'text/plain', body: 'product' });
      });
    }
    const devtools = await context.newCDPSession(page);
    await devtools.send('WebAuthn.enable');
    await devtools.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    const seen = watch(page);
    const enter = [`GET ${origin}/api/auth/oauth2/authorize`];
    const check = (refusedCalls = 0) => {
      expectOnlyContract({ requests: seen.requests.filter(entry => !enter.some(start => entry.startsWith(start))) }, origin, exits);
      expectErrors(seen, refusedCalls);
      seen.errors.length = 0;
      seen.requests.length = 0;
    };
    const landed = async (exit: string) => {
      await page.waitForURL((url: URL) => url.href.startsWith(exit));
      return new URL(page.url()).searchParams;
    };
    return { context, page, check, landed };
  }

  test('signed-in Create a passkey creates a fresh account and revokes the original session', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin } = await world();
    const { context, page, check, landed } = await visitor(origin, '192.0.2.25');
    try {
      await page.goto(`${origin}/sign-in`);
      await page.locator('#create-passkey').click();
      await page.locator('#sign-out').waitFor();
      const original = await (await context.request.get(`${origin}/api/auth/get-session`)).json();
      expect(original.user.id).toBeTruthy();
      const originalCookie = (await context.cookies(origin))
        .map((cookie: { name: string; value: string }) => `${cookie.name}=${cookie.value}`).join('; ');
      const readOriginal = () => fetch(`${origin}/api/auth/get-session`, { headers: { cookie: originalCookie } });
      expect((await (await readOriginal()).json() as any).user.id).toBe(original.user.id);
      check();

      await page.goto(authorize(origin, { prompt: 'login' }));
      await page.locator('#create-passkey').click();
      expect((await landed(exits[0])).get('code')).toBeTruthy();
      const current = await (await context.request.get(`${origin}/api/auth/get-session`)).json();
      expect(current.user.id).not.toBe(original.user.id);
      // A replacement cookie alone would leave the original session replayable.
      expect((await (await readOriginal()).json()) === null).toBe(true);
      check();
    } finally {
      await context.close();
    }
  }, 60000);

  test('passkey account, sign-in, allow, cancel and the ways back in', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin } = await world();
    const { context, page, check, landed } = await visitor(origin, '192.0.2.21');

    // New here: the product's name is the verified one, and one tap makes the account.
    await page.goto(authorize(origin));
    await page.locator('#create-passkey').waitFor();
    expect(new URL(page.url()).pathname).toBe('/sign-in');
    expect(await heading(page)).toBe('Sign in to Automagik desktop');
    expect(await page.locator('#whatsapp-offer').isHidden()).toBe(true);
    await page.locator('#create-passkey').click();
    let back = await landed(exits[0]);
    expect(back.get('code')).toBeTruthy();
    expect(back.get('state')).toBe('test-state');
    check();

    // Back another day: the same passkey signs in.
    await context.clearCookies();
    await page.goto(authorize(origin));
    await page.locator('#use-passkey').click();
    back = await landed(exits[0]);
    expect(back.get('code')).toBeTruthy();
    check();

    // A product that is not ours asks first: its verified name, what it will see, Allow.
    await page.goto(authorize(origin, third));
    await page.locator('#allow').waitFor();
    expect(new URL(page.url()).pathname).toBe('/consent');
    expect(await heading(page)).toBe('Allow Example third party?');
    expect(await page.locator('#asks strong').allInnerTexts()).toEqual(['Know it’s you', 'See your profile']);
    await page.locator('#allow').click();
    back = await landed(exits[1]);
    expect(back.get('code')).toBeTruthy();
    check();

    // Cancel sends the product a refusal, never a code.
    await page.goto(authorize(origin, { ...third, prompt: 'consent' }));
    await page.locator('#deny').click();
    back = await landed(exits[1]);
    expect(back.get('error')).toBe('access_denied');
    expect(back.has('code')).toBe(false);
    check();

    // The sign-in ran out while the question was open: nothing is sent, sign in again, answer.
    await page.goto(authorize(origin, { ...third, prompt: 'consent' }));
    await page.locator('#allow').waitFor();
    await context.clearCookies();
    await page.reload();
    await page.locator('#sign-in-again').waitFor();
    expect(await heading(page)).toBe('Sign in again');
    await page.locator('#sign-in-again').click();
    await page.locator('#use-passkey').click();
    await page.locator('#allow').click();
    back = await landed(exits[1]);
    expect(back.get('code')).toBeTruthy();
    check();

    // Asked for a fresh sign-in: the passkey is asked again even though a session exists.
    await page.goto(authorize(origin, { prompt: 'login' }));
    await page.locator('#use-passkey').waitFor();
    expect(await view(page)).toBe('passkey');
    await page.locator('#use-passkey').click();
    expect((await landed(exits[0])).get('code')).toBeTruthy();
    check();

    // Asked to create: the new account comes first and resumes with `created`.
    await page.goto(authorize(origin, { prompt: 'create' }));
    await page.locator('#create-passkey').waitFor();
    expect(await heading(page)).toBe('Create your account for Automagik desktop');
    expect(await page.locator('#card .button.primary:visible').innerText()).toBe('Create a passkey');
    await page.locator('#create-passkey').click();
    expect((await landed(exits[0])).get('code')).toBeTruthy();
    check();

    // Signed in elsewhere meanwhile: carry on with one tap, or pick another account.
    await context.clearCookies();
    await page.goto(authorize(origin));
    await page.locator('#use-passkey').waitFor();
    const request = page.url();
    await page.goto(`${origin}/sign-in`);
    await page.locator('#use-passkey').click();
    await page.locator('#sign-out').waitFor();
    expect(await heading(page)).toBe('You’re signed in');
    await page.goto(request);
    await page.locator('#continue').waitFor();
    expect(await heading(page)).toBe('Continue to Automagik desktop');
    await page.locator('#continue').click();
    expect((await landed(exits[0])).get('code')).toBeTruthy();
    await page.goto(request);
    await page.locator('#switch').click();
    await page.locator('#use-passkey').waitFor();
    expect(await heading(page)).toBe('Sign in to Automagik desktop');
    await page.locator('#use-passkey').click();
    expect((await landed(exits[0])).get('code')).toBeTruthy();
    check();

    // No product asked: signed in, nowhere invented to go, and a way out.
    await page.goto(`${origin}/sign-in`);
    await page.locator('#sign-out').click();
    await page.locator('#use-passkey').waitFor();
    expect(await said(page)).toBe('Signed out.');
    expect(await heading(page)).toBe('Sign in to Automagik');
    check();

    // A changed request is refused by the service; the page says so and offers no way on.
    await page.goto(request.replace('test-state', 'changed-state'));
    await page.locator('[data-view="stop"]:not([hidden])').waitFor();
    expect(await heading(page)).toBe('This link has expired');
    expect(await page.locator('#card button:visible').count()).toBe(0);
    check(1);
    await context.close();
  }, 120000);

  // The WhatsApp way in, with the service's own test settings: the page shows the message,
  // the person sends it from their phone, and only then does the page sign in.
  const begin = async (page: any) => {
    await page.locator('#use-whatsapp').click();
    await page.locator('[data-view="whatsapp"]:not([hidden])').waitFor();
    const code: string = await page.locator('#wa-code').innerText();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const link: string = await page.locator('#open-whatsapp').getAttribute('href');
    expect(link).toBe(`https://wa.me/${RECEIVING}?text=Sign%20in%20to%20Automagik%3A%20${code}`);
    expect(await page.locator('#card input').count()).toBe(0);
    return { code, link, message: new URL(link).searchParams.get('text') ?? '' };
  };

  test('WhatsApp: the person sends the message, the page waits and signs in', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin, send } = await world({ whatsapp: true });
    const { context, page, check, landed } = await visitor(origin, '192.0.2.31');

    // Offered under the passkey, which stays the main action.
    await page.goto(authorize(origin));
    await page.locator('#use-whatsapp').waitFor();
    expect(await page.locator('#card .button.primary:visible').innerText()).toBe('Continue with a passkey');
    let { code, link, message } = await begin(page);
    expect(message).toBe(`Sign in to Automagik: ${code}`);
    // On a desk the phone scans the very link the button holds.
    expect(await onPhone(page)).toBe(false);
    expect(await scanned(page)).toBe(link);

    // Opening or scanning proves nothing, and neither does someone else's code.
    await page.waitForTimeout(2600);
    const other = (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
    expect(await send('15555550127', `Sign in to Automagik: ${other}`)).toBe(null);
    await page.waitForTimeout(2600);
    expect(await view(page)).toBe('whatsapp');
    expect(await heading(page)).toBe('Sign in to Automagik desktop');

    // The message, sent: the page signs in by itself and goes back to the product.
    expect(await send('15555550127', message)).toBe('Done. Go back to your browser to finish signing in to Automagik desktop.');
    let back = await landed(exits[0]);
    expect(back.get('code')).toBeTruthy();
    expect(back.get('state')).toBe('test-state');
    check();

    // No product asked: the same proof signs in and stays, with a way out.
    await context.clearCookies();
    await page.goto(`${origin}/sign-in`);
    ({ code, link, message } = await begin(page));
    expect(await send('15555550127', message)).toBe('Done. Go back to your browser to finish signing in to Automagik.');
    await page.locator('#sign-out').waitFor();
    expect(await heading(page)).toBe('You’re signed in');
    // A used message is worth nothing a second time.
    expect(await send('15555550127', message)).toBe(null);
    check();

    // Asked to create: a new sender gets a new account and resumes with `created`.
    await page.goto(authorize(origin, { prompt: 'create' }));
    await page.locator('#use-whatsapp').waitFor();
    expect(await heading(page)).toBe('Create your account for Automagik desktop');
    ({ message } = await begin(page));
    expect(await send('15555550128', message)).toBeTruthy();
    expect((await landed(exits[0])).get('code')).toBeTruthy();
    check();
    await context.close();
  }, 120000);

  test('WhatsApp on a phone: a button opens it, and there is no code to scan', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin, send } = await world({ whatsapp: true });
    const { context, page, check, landed } = await visitor(origin, '192.0.2.32', { hasTouch: true, isMobile: true });
    await page.goto(authorize(origin));
    await page.locator('#use-whatsapp').waitFor();
    const { message } = await begin(page);
    expect(await onPhone(page)).toBe(true);
    expect(await page.locator('#qr').isHidden()).toBe(true);
    expect(await page.locator('#card .button.primary:visible').innerText()).toBe('Open WhatsApp');
    expect(await send('15555550129', message)).toBeTruthy();
    expect((await landed(exits[0])).get('code')).toBeTruthy();
    check();
    await context.close();
  }, 60000);

  test.runIf(shots)('a recording of the WhatsApp flow at phone width', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin, send } = await world({ whatsapp: true });
    await mkdir(shots, { recursive: true });
    const { context, page, landed } = await visitor(origin, '192.0.2.33', {
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
      recordVideo: { dir: await mkdtemp(`${root}/video-`), size: { width: 390, height: 844 } },
    }, 2200);
    await page.goto(authorize(origin));
    await page.locator('#use-whatsapp').waitFor();
    await page.waitForTimeout(2200);
    const { message } = await begin(page);
    // The person is in WhatsApp now, pressing send; the page waits.
    await page.waitForTimeout(5200);
    expect(await send('15555550130', message)).toBeTruthy();
    await landed(exits[0]);
    await page.waitForTimeout(600);
    await context.close();
    await page.video().saveAs(resolve(shots, 'whatsapp-flow-390.webm'));
  }, 120000);
});

// ---- Every state, with the service's answers scripted -------------------------------
// `json` may be a function, called when the answer is made; a list of replies is given in
// turn, the last one again for every call after it.
type Reply = { status?: number; json?: unknown; body?: string; headers?: Record<string, string>; hang?: true; drop?: true };
interface Scene {
  name: string;
  page: typeof PAGES[number];
  query?: string;
  api?: Record<string, Reply | Reply[]>;
  passkey?: 'pending' | 'cancel' | 'ok' | 'none';
  act?: (page: any) => Promise<void>;
  title: string;
  say: string;
  /** What the host says instead where the device is a phone. */
  sayOnPhone?: string;
  view: string;
  refused?: number;
  more?: (page: any, calls: Call[]) => Promise<void>;
}
interface Call { path: string; method: string; search: string; body: string }
const request = (scope: string, extra = '') => `client_id=automagik-cloud&redirect_uri=https%3A%2F%2Fcloud.example.com` +
  `%2Fauth%2Fcallback&response_type=code&scope=${scope}&state=opaque&code_challenge=stub&code_challenge_method=S256` +
  `${extra}&exp=1893456000&ba_iat=1&ba_param=client_id&ba_param=scope&sig=stub`;
const cloud = request('openid+profile');
const account = { session: { id: 'session', userId: 'user' }, user: { id: 'user', name: 'Automagik user' } };
const options = { challenge: 'c3R1Yg', rpId: 'localhost', userVerification: 'required' };
const makeOptions = {
  challenge: 'c3R1Yg', rp: { id: 'localhost', name: 'Automagik ID' },
  user: { id: 'dXNlcg', name: 'Automagik user', displayName: 'Automagik user' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
};
const whatsappOn = { '/api/id/config': { json: { phoneEnabled: false, whatsappEnabled: true } } };
const link = (code: string) => `https://wa.me/15555550100?text=Sign%20in%20to%20Automagik%3A%20${code}`;
const message = (code: string): Reply => ({ json: () => ({ url: link(code), code, expiresAt: Date.now() + 300000 }) });
const pending: Reply = { json: { status: 'pending' } };
const START = '/api/auth/whatsapp/start';
const STATUS = '/api/auth/whatsapp/status';
const waiting = { ...whatsappOn, [START]: message('K7M2QX'), [STATUS]: pending };
const toWaiting = async (page: any, button = '#use-whatsapp') => {
  await page.locator(button).click();
  await page.locator('[data-view="whatsapp"]:not([hidden])').waitFor();
};
const made = (calls: Call[], path: string) => calls.filter(call => call.path === path);
const scanLine = 'Scan the code with your phone, then press send in WhatsApp. I’ll wait right here.';
const openLine = 'Open WhatsApp and press send. I’ll wait right here.';
const ranOut = 'That code ran out. Start again for a new one.';
const passkeyLine = 'A passkey is your fingerprint, face or screen lock. No password.';

const scenes: Scene[] = [
  { name: 'sign-in-01-loading', page: 'sign-in', query: cloud,
    api: { '/api/auth/oauth2/public-client-prelogin': { hang: true } },
    title: 'Sign in', say: 'One moment…', view: 'loading' },
  { name: 'sign-in-02-passkey', page: 'sign-in', query: cloud,
    title: 'Sign in to Automagik Cloud', say: passkeyLine, view: 'passkey',
    more: async (page) => { expect(await page.locator('#whatsapp-offer').isHidden()).toBe(true); } },
  { name: 'sign-in-03-passkey-with-whatsapp-on', page: 'sign-in', query: cloud, api: whatsappOn,
    title: 'Sign in to Automagik Cloud', say: passkeyLine, view: 'passkey',
    more: async (page) => {
      // Offered, under the passkey: the passkey stays the main action.
      expect(await page.locator('#card .button:visible').allInnerTexts()).toEqual(['Continue with a passkey', 'New here? Create a passkey', 'Use WhatsApp']);
      expect(await page.locator('#card .button.primary:visible').allInnerTexts()).toEqual(['Continue with a passkey']);
    } },
  { name: 'sign-in-04-passkey-prompt-open', page: 'sign-in', query: cloud, passkey: 'pending',
    api: { '/api/auth/passkey/generate-authenticate-options': { json: options } },
    act: page => page.locator('#use-passkey').click(),
    title: 'Sign in to Automagik Cloud', say: 'Follow the prompt on your device.', view: 'passkey',
    more: async (page) => {
      expect(await page.locator('#use-passkey').innerText()).toBe('Waiting for your passkey…');
      expect(await page.locator('#create-passkey').isDisabled()).toBe(true);
    } },
  { name: 'sign-in-05-passkey-cancelled', page: 'sign-in', query: cloud, passkey: 'cancel',
    api: { '/api/auth/passkey/generate-authenticate-options': { json: options } },
    act: page => page.locator('#use-passkey').click(),
    title: 'Sign in to Automagik Cloud', say: 'Cancelled. Try again whenever you’re ready.', view: 'passkey',
    more: async (page) => { expect(await page.locator('#use-passkey').isEnabled()).toBe(true); } },
  { name: 'sign-in-06-passkey-failed', page: 'sign-in', query: cloud, passkey: 'ok', refused: 1,
    api: {
      '/api/auth/passkey/generate-authenticate-options': { json: options },
      '/api/auth/passkey/verify-authentication': { status: 401, json: { code: 'AUTHENTICATION_FAILED', message: '<b>raw</b>' } },
    },
    act: page => page.locator('#use-passkey').click(),
    title: 'Sign in to Automagik Cloud', say: 'That passkey didn’t work here. Try again, or create a new one.', view: 'passkey' },
  { name: 'sign-in-07-passkey-not-saved', page: 'sign-in', query: cloud, passkey: 'ok', refused: 1,
    api: {
      '/api/auth/passkey/generate-register-options': { json: makeOptions },
      '/api/auth/passkey/verify-registration': { status: 400, json: { code: 'FAILED_TO_VERIFY_REGISTRATION' } },
    },
    act: page => page.locator('#create-passkey').click(),
    title: 'Sign in to Automagik Cloud', say: 'The passkey wasn’t saved. Try again.', view: 'passkey' },
  { name: 'sign-in-08-no-passkeys-in-this-browser', page: 'sign-in', query: cloud, passkey: 'none',
    title: 'Sign in to Automagik Cloud', say: 'This browser can’t use passkeys.', view: 'stop',
    more: async (page) => { expect(await page.locator('#card button:visible').count()).toBe(0); } },
  { name: 'sign-in-09-account-created', page: 'sign-in', query: cloud, passkey: 'ok',
    api: {
      '/api/auth/passkey/generate-register-options': { json: makeOptions },
      '/api/auth/passkey/verify-registration': { json: { id: 'passkey', ...account } },
      '/api/auth/oauth2/continue': { hang: true },
    },
    act: page => page.locator('#create-passkey').click(),
    title: 'You’re signed in', say: 'Passkey saved. You’re in!', view: 'going',
    more: async (page) => { expect(await page.locator('#going-text').innerText()).toBe('Taking you back to Automagik Cloud…'); } },
  { name: 'sign-in-10-going-back-to-the-product', page: 'sign-in', query: cloud, passkey: 'ok',
    api: {
      '/api/auth/passkey/generate-authenticate-options': { json: options },
      '/api/auth/passkey/verify-authentication': { json: account },
      '/api/auth/oauth2/continue': { hang: true },
    },
    act: page => page.locator('#use-passkey').click(),
    title: 'You’re signed in', say: 'You’re in!', view: 'going' },
  { name: 'sign-in-11-signed-in-no-product', page: 'sign-in', passkey: 'ok',
    api: {
      '/api/auth/passkey/generate-authenticate-options': { json: options },
      '/api/auth/passkey/verify-authentication': { json: account },
    },
    act: page => page.locator('#use-passkey').click(),
    title: 'You’re signed in', say: 'You’re in!', view: 'done' },
  { name: 'sign-in-12-already-signed-in', page: 'sign-in', query: cloud,
    api: { '/api/auth/get-session': { json: account } },
    title: 'Continue to Automagik Cloud', say: 'You’re already signed in on this browser.', view: 'session' },
  { name: 'sign-in-13-asked-to-create', page: 'sign-in', query: request('openid+profile', '&prompt=create'),
    title: 'Create your account for Automagik Cloud', say: passkeyLine, view: 'passkey',
    more: async (page) => {
      expect(await page.locator('#card .button:visible').allInnerTexts()).toEqual(['Create a passkey', 'I have a passkey']);
    } },
  { name: 'sign-in-14-too-many-tries', page: 'sign-in', query: cloud, passkey: 'ok',
    api: { '/api/auth/passkey/generate-authenticate-options': { status: 429, json: { message: 'slow down' }, headers: { 'X-Retry-After': '42' } } },
    act: page => page.locator('#use-passkey').click(), refused: 1,
    title: 'Sign in to Automagik Cloud', say: 'Too many tries. Take a short break.', view: 'passkey',
    more: async (page) => {
      expect(await page.locator('#passkey-wait').innerText()).toMatch(/^Try again in 4[12] s$/);
      expect(await page.locator('#use-passkey').isDisabled()).toBe(true);
    } },
  { name: 'sign-in-15-no-connection-on-a-tap', page: 'sign-in', query: cloud, passkey: 'ok',
    api: { '/api/auth/passkey/generate-authenticate-options': { drop: true } },
    act: page => page.locator('#use-passkey').click(), refused: 1,
    title: 'Sign in to Automagik Cloud', say: 'Can’t reach Automagik. Check your connection.', view: 'passkey',
    more: async (page) => { expect(await page.locator('#use-passkey').isEnabled()).toBe(true); } },
  { name: 'sign-in-16-no-connection-on-load', page: 'sign-in', query: cloud, refused: 1,
    api: { '/api/auth/oauth2/public-client-prelogin': { drop: true } },
    title: 'Sign in', say: 'Can’t reach Automagik. Check your connection.', view: 'retry' },
  { name: 'sign-in-17-service-error', page: 'sign-in', query: cloud, refused: 1,
    api: { '/api/auth/oauth2/public-client-prelogin': { status: 500, body: '<h1>raw error page</h1>' } },
    title: 'Sign in', say: 'Something went wrong on our side.', view: 'retry',
    more: async (page) => { expect(await page.locator('body').innerText()).not.toContain('raw error page'); } },
  { name: 'sign-in-18-request-expired-or-changed', page: 'sign-in', query: cloud, refused: 1,
    api: { '/api/auth/oauth2/public-client-prelogin': { status: 400, json: { error: 'invalid_request', error_description: '<i>raw</i>' } } },
    title: 'This link has expired', say: 'Let’s start over.', view: 'stop',
    more: async (page) => { expect(await page.locator('#card button:visible').count()).toBe(0); } },
  { name: 'sign-in-19-whatsapp-starting', page: 'sign-in', query: cloud,
    api: { ...whatsappOn, [START]: { hang: true } },
    act: page => page.locator('#use-whatsapp').click(),
    title: 'Sign in to Automagik Cloud', say: 'Getting your message ready…', view: 'passkey',
    more: async (page) => {
      expect(await page.locator('#use-whatsapp').innerText()).toBe('Starting…');
      expect(await page.locator('#use-passkey').isDisabled()).toBe(true);
    } },
  { name: 'sign-in-20-whatsapp-waiting-for-the-message', page: 'sign-in', query: cloud, api: waiting,
    act: page => toWaiting(page),
    title: 'Sign in to Automagik Cloud', say: scanLine, sayOnPhone: openLine, view: 'whatsapp',
    more: async (page, calls) => {
      // The message and its code are shown; nothing is typed here and nothing is sent for them.
      expect(await page.locator('#wa-words').innerText()).toBe('Sign in to Automagik:');
      expect(await page.locator('#wa-code').innerText()).toBe('K7M2QX');
      expect(await page.locator('#card input').count()).toBe(0);
      expect(await page.locator('.steps li').allInnerTexts()).toContain('Press send. Nothing is sent for you.');
      expect(await page.locator('#wa-left').innerText()).toMatch(/^Waiting for your message · [45]:\d\d$/);
      const open = page.locator('#open-whatsapp');
      expect(await open.getAttribute('href')).toBe(link('K7M2QX'));
      expect(await open.getAttribute('rel')).toBe('noopener noreferrer');
      if (await onPhone(page)) {
        // On a phone: a button, and no code to scan with the phone it is on.
        expect(await page.locator('#qr').isHidden()).toBe(true);
        expect(await page.locator('#card .button.primary:visible').allInnerTexts()).toEqual(['Open WhatsApp']);
        expect(await page.locator('#wa-step-open').innerText()).toBe('Open WhatsApp with the button below.');
      } else {
        // On a desk: the code the phone scans is the same link, in either colour scheme.
        expect(await scanned(page)).toBe(link('K7M2QX'));
        await page.emulateMedia({ colorScheme: 'dark' });
        expect(await scanned(page)).toBe(link('K7M2QX'));
        await page.emulateMedia({ colorScheme: 'light' });
        expect(await page.locator('#card .button:visible').allInnerTexts()).toEqual(['Open WhatsApp on this computer']);
        expect(await page.locator('#wa-step-open').innerText()).toBe('Scan the code with your phone’s camera.');
      }
      // The request goes with the start; the asking is a bare GET, again and again.
      expect(made(calls, START).map(call => call.body)).toEqual([JSON.stringify({ oauth_query: cloud })]);
      await expect.poll(() => made(calls, STATUS).length, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
      expect(made(calls, STATUS).every(call => call.method === 'GET' && call.search === '' && call.body === '')).toBe(true);
    } },
  { name: 'sign-in-21-whatsapp-code-ran-out', page: 'sign-in', query: cloud,
    api: { ...waiting, [STATUS]: [pending, { json: { status: 'expired' } }] },
    act: page => toWaiting(page),
    title: 'Sign in to Automagik Cloud', say: ranOut, view: 'offer',
    more: async (page, calls) => {
      expect(await page.locator('#card .button:visible').allInnerTexts()).toEqual(['Start again']);
      expect(await page.evaluate('document.activeElement.id')).toBe('start-whatsapp');
      expect(await page.locator('#offer-passkey').isVisible()).toBe(true);
      expect(await page.locator('body').innerText()).not.toContain('K7M2QX');
      // It stops asking once the code is gone.
      const asked = made(calls, STATUS).length;
      await page.waitForTimeout(2600);
      expect(made(calls, STATUS).length).toBe(asked);
    } },
  { name: 'sign-in-22-whatsapp-started-again', page: 'sign-in', query: cloud,
    api: { ...whatsappOn, [START]: [message('K7M2QX'), message('R4T9WB')], [STATUS]: [pending, { json: { status: 'expired' } }, pending] },
    act: async (page) => {
      await toWaiting(page);
      await page.locator('[data-view="offer"]:not([hidden])').waitFor();
      await toWaiting(page, '#start-whatsapp');
    },
    title: 'Sign in to Automagik Cloud', say: scanLine, sayOnPhone: openLine, view: 'whatsapp',
    more: async (page, calls) => {
      // A new start, a new message: the old link and code are never used again.
      expect(made(calls, START)).toHaveLength(2);
      expect(await page.locator('#wa-code').innerText()).toBe('R4T9WB');
      expect(await page.locator('#open-whatsapp').getAttribute('href')).toBe(link('R4T9WB'));
      if (!(await onPhone(page))) expect(await scanned(page)).toBe(link('R4T9WB'));
    } },
  { name: 'sign-in-23-whatsapp-signed-in-going-back', page: 'sign-in', query: cloud,
    api: { ...waiting, [STATUS]: [pending, { json: { redirect: true, url: 'https://cloud.example.com/auth/callback?code=stub&state=opaque' } }] },
    act: page => toWaiting(page),
    title: 'You’re signed in', say: 'You’re in!', view: 'going',
    more: async (page, calls) => {
      expect(await page.locator('#going-text').innerText()).toBe('Taking you back to Automagik Cloud…');
      const asked = made(calls, STATUS).length;
      await page.waitForTimeout(2600);
      expect(made(calls, STATUS).length).toBe(asked);
    } },
  { name: 'sign-in-24-whatsapp-signed-in-no-product', page: 'sign-in',
    api: { ...waiting, [STATUS]: [pending, { json: { status: 'verified', user: { id: 'user', name: 'Automagik user' } } }] },
    act: page => toWaiting(page),
    title: 'You’re signed in', say: 'You’re in!', view: 'done',
    more: async (page, calls) => { expect(made(calls, START).map(call => call.body)).toEqual(['{}']); } },
  { name: 'sign-in-25-whatsapp-asked-to-create', page: 'sign-in', query: request('openid+profile', '&prompt=create'),
    api: { ...waiting, [STATUS]: { json: { status: 'verified', user: { id: 'user', name: 'Automagik user' } } },
      '/api/auth/oauth2/continue': { hang: true } },
    act: page => page.locator('#use-whatsapp').click(),
    title: 'You’re signed in', say: 'You’re in!', view: 'going',
    more: async (page, calls) => {
      // The request stays out of the start and comes back with `created`.
      expect(made(calls, START).map(call => call.body)).toEqual(['{}']);
      expect(made(calls, '/api/auth/oauth2/continue').map(call => call.body))
        .toEqual([JSON.stringify({ oauth_query: request('openid+profile', '&prompt=create'), created: true })]);
    } },
  { name: 'sign-in-26-whatsapp-too-many-starts', page: 'sign-in', query: cloud, refused: 1,
    api: { ...whatsappOn, [START]: { status: 429, json: {}, headers: { 'X-Retry-After': '42' } } },
    act: page => page.locator('#use-whatsapp').click(),
    title: 'Sign in to Automagik Cloud', say: 'Too many tries. Take a short break.', view: 'passkey',
    more: async (page) => {
      expect(await page.locator('#passkey-wait').innerText()).toMatch(/^Try again in 4[12] s$/);
      expect(await page.locator('#use-whatsapp').isDisabled()).toBe(true);
    } },
  { name: 'sign-in-27-whatsapp-asked-to-slow-down', page: 'sign-in', query: cloud, refused: 1,
    api: { ...waiting, [STATUS]: [{ status: 429, json: {}, headers: { 'X-Retry-After': '30' } }, pending] },
    act: page => toWaiting(page),
    title: 'Sign in to Automagik Cloud', say: 'Checking a little slower for a moment.', view: 'whatsapp',
    more: async (page, calls) => {
      // The message is still good; the page waits out the pause before it asks again.
      expect(await page.locator('#wa-code').innerText()).toBe('K7M2QX');
      await page.waitForTimeout(2600);
      expect(made(calls, STATUS)).toHaveLength(1);
    } },
  { name: 'sign-in-28-whatsapp-no-connection-while-waiting', page: 'sign-in', query: cloud, refused: 1,
    api: { ...waiting, [STATUS]: [{ drop: true }, pending] },
    act: page => toWaiting(page),
    title: 'Sign in to Automagik Cloud', say: 'Can’t reach Automagik. Check your connection.', view: 'whatsapp',
    more: async (page) => {
      // It keeps trying, and says so when the service answers again.
      await expect.poll(() => said(page), { timeout: 8000 }).toBe(await onPhone(page) ? openLine : scanLine);
      expect(await page.locator('#wa-code').innerText()).toBe('K7M2QX');
    } },
  { name: 'sign-in-29-whatsapp-request-refused', page: 'sign-in', query: cloud, refused: 1,
    api: { ...waiting, [STATUS]: { status: 403, body: 'Forbidden' } },
    act: page => page.locator('#use-whatsapp').click(),
    title: 'This link has expired', say: 'Let’s start over.', view: 'stop',
    more: async (page) => { expect(await page.locator('#card .button:visible').count()).toBe(0); } },
  { name: 'sign-in-30-whatsapp-request-expired-or-changed', page: 'sign-in', query: cloud, refused: 2,
    api: { ...whatsappOn, [START]: { status: 400, json: { code: 'INVALID_REQUEST', message: '<b>raw</b>' } },
      '/api/auth/oauth2/public-client-prelogin': [
        { json: { client_id: 'automagik-cloud', client_name: 'Automagik Cloud' } },
        { status: 400, json: { error: 'invalid_request' } }] },
    act: page => page.locator('#use-whatsapp').click(),
    title: 'This link has expired', say: 'Let’s start over.', view: 'stop' },
  { name: 'sign-in-31-whatsapp-answer-not-a-link', page: 'sign-in', query: cloud,
    api: { ...whatsappOn, [START]: { json: { url: 'javascript:alert(1)', code: 'K7M2QX', expiresAt: 1893456000000 } } },
    act: page => page.locator('#use-whatsapp').click(),
    title: 'Sign in to Automagik Cloud', say: 'Something went wrong on our side.', view: 'passkey',
    more: async (page, calls) => {
      // Only a secure web link is ever put behind the button or in the code.
      expect(await page.locator('#open-whatsapp').getAttribute('href')).toBe(null);
      expect(await page.locator('#qr-code path').count()).toBe(0);
      expect(made(calls, STATUS)).toHaveLength(0);
    } },
  { name: 'sign-in-32-whatsapp-back-to-the-passkey', page: 'sign-in', query: cloud, api: waiting,
    act: async (page) => { await toWaiting(page); await page.locator('#leave-whatsapp').click(); },
    title: 'Sign in to Automagik Cloud', say: passkeyLine, view: 'passkey',
    more: async (page, calls) => {
      // Leaving stops the asking.
      await page.waitForTimeout(300);
      const asked = made(calls, STATUS).length;
      await page.waitForTimeout(2600);
      expect(made(calls, STATUS).length).toBe(asked);
      expect(await page.locator('#use-whatsapp').isEnabled()).toBe(true);
    } },
  { name: 'sign-in-33-whatsapp-only-browser', page: 'sign-in', query: cloud, passkey: 'none', api: whatsappOn,
    title: 'Sign in to Automagik Cloud', say: 'This browser can’t use passkeys. Use WhatsApp.', view: 'offer',
    more: async (page) => {
      expect(await page.locator('#card .button:visible').allInnerTexts()).toEqual(['Use WhatsApp']);
      expect(await page.locator('#offer-passkey').isHidden()).toBe(true);
    } },
  { name: 'sign-in-34-whatsapp-only-browser-waiting', page: 'sign-in', query: cloud, passkey: 'none', api: waiting,
    act: page => toWaiting(page, '#start-whatsapp'),
    title: 'Sign in to Automagik Cloud', say: scanLine, sayOnPhone: openLine, view: 'whatsapp',
    more: async (page) => { expect(await page.locator('#leave-whatsapp').isHidden()).toBe(true); } },

  { name: 'consent-01-checking', page: 'consent', query: request('openid+profile+offline_access'),
    api: { '/api/auth/oauth2/public-client-prelogin': { hang: true }, '/api/auth/get-session': { json: account } },
    title: 'Allow access', say: 'One moment…', view: 'loading' },
  { name: 'consent-02-ask', page: 'consent', query: request('openid+profile+offline_access'),
    api: { '/api/auth/get-session': { json: account } },
    title: 'Allow Automagik Cloud?', say: 'Automagik Cloud never sees your passkey.', view: 'ask',
    more: async (page) => {
      expect(await page.locator('#asks strong').allInnerTexts()).toEqual(['Know it’s you', 'See your profile', 'Stay connected']);
    } },
  { name: 'consent-03-ask-other-scopes-and-claims', page: 'consent',
    query: request('openid+files.read', `&claims=${encodeURIComponent('{"userinfo":{"name":null,"picture":null}}')}`),
    api: {
      '/api/auth/get-session': { json: account },
      '/api/auth/oauth2/public-client-prelogin': { json: { client_id: 'automagik-cloud', client_name: 'Example third party' } },
    },
    title: 'Allow Example third party?', say: 'Example third party never sees your passkey.', view: 'ask',
    more: async (page) => {
      expect(await page.locator('#asks li').allInnerTexts().then((rows: string[]) => rows.map(row => row.replace(/\s+/g, ' ').trim())))
        .toEqual(['Know it’s you Your Automagik ID', 'files.read Other access this app asks for', 'Extra details name, picture']);
    } },
  { name: 'consent-04-allowing', page: 'consent', query: request('openid+profile'),
    api: { '/api/auth/get-session': { json: account }, '/api/auth/oauth2/consent': { hang: true } },
    act: page => page.locator('#allow').click(),
    title: 'Allow Automagik Cloud?', say: 'Automagik Cloud never sees your passkey.', view: 'ask',
    more: async (page) => {
      expect(await page.locator('#allow').innerText()).toBe('Allowing…');
      expect(await page.locator('#deny').isDisabled()).toBe(true);
    } },
  { name: 'consent-05-going-back-to-the-product', page: 'consent', query: request('openid+profile'),
    api: { '/api/auth/get-session': { json: account },
      '/api/auth/oauth2/consent': { json: { redirect: true, url: 'https://cloud.example.com/auth/callback?code=stub&state=opaque' } } },
    act: page => page.locator('#allow').click(),
    title: 'Allowed', say: 'Done!', view: 'going',
    more: async (page) => { expect(await page.locator('#going-text').innerText()).toBe('Taking you back to Automagik Cloud…'); } },
  { name: 'consent-06-sign-in-ran-out', page: 'consent', query: request('openid+profile'),
    title: 'Sign in again', say: 'Your sign-in timed out.', view: 'expired',
    more: async (page) => { expect(await page.locator('#card button:visible').allInnerTexts()).toEqual(['Sign in']); } },
  { name: 'consent-07-request-expired-or-changed', page: 'consent', query: request('openid+profile'), refused: 1,
    api: { '/api/auth/get-session': { json: account },
      '/api/auth/oauth2/public-client-prelogin': { status: 400, json: { error: 'invalid_signature' } } },
    title: 'This link has expired', say: 'Let’s start over.', view: 'stop' },
  { name: 'consent-08-not-allowed', page: 'consent', query: request('openid+profile'), refused: 1,
    api: { '/api/auth/get-session': { json: account },
      '/api/auth/oauth2/consent': { status: 403, json: { error: 'access_denied', error_description: '<i>raw</i>' } } },
    act: page => page.locator('#allow').click(),
    title: 'Not allowed', say: 'This account can’t allow that.', view: 'stop' },
  { name: 'consent-09-too-many-tries', page: 'consent', query: request('openid+profile'), refused: 1,
    api: { '/api/auth/get-session': { json: account },
      '/api/auth/oauth2/consent': { status: 429, json: {}, headers: { 'X-Retry-After': '30' } } },
    act: page => page.locator('#allow').click(),
    title: 'Allow Automagik Cloud?', say: 'Too many tries. Take a short break.', view: 'ask',
    more: async (page) => {
      expect(await page.locator('#ask-wait').innerText()).toMatch(/^Try again in (30|29) s$/);
      expect(await page.locator('#allow').isDisabled()).toBe(true);
    } },
  { name: 'consent-10-no-connection', page: 'consent', query: request('openid+profile'), refused: 1,
    api: { '/api/auth/get-session': { json: account }, '/api/auth/oauth2/consent': { drop: true } },
    act: page => page.locator('#deny').click(),
    title: 'Allow Automagik Cloud?', say: 'Can’t reach Automagik. Check your connection.', view: 'ask',
    more: async (page) => { expect(await page.locator('#allow').isEnabled()).toBe(true); } },
  { name: 'consent-11-no-connection-on-load', page: 'consent', query: request('openid+profile'), refused: 2,
    api: { '/api/auth/get-session': { drop: true }, '/api/auth/oauth2/public-client-prelogin': { drop: true } },
    title: 'Allow access', say: 'Can’t reach Automagik. Check your connection.', view: 'retry' },
];

// The browser's own passkey prompt cannot be pictured, so each state scripts its outcome.
const authenticator = (mode: string) => `(() => {
  const mode = ${JSON.stringify(mode)};
  if (mode === 'none') { delete window.PublicKeyCredential; return; }
  const credential = { toJSON: () => ({ id: 'stub', rawId: 'stub', type: 'public-key', response: {}, clientExtensionResults: {} }) };
  const answer = () => mode === 'pending' ? new Promise(() => {}) :
    mode === 'cancel' ? Promise.reject(new DOMException('The request was cancelled.', 'NotAllowedError')) :
    Promise.resolve(credential);
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: answer, create: answer } });
})()`;

async function stage(context: any, origin: string, scene: Scene, phone = false) {
  const page = await context.newPage();
  const calls: Call[] = [];
  const turns: Record<string, number> = {};
  await page.addInitScript(authenticator(scene.passkey ?? 'pending'));
  const healthy: Record<string, Reply> = {
    '/api/id/config': { json: { phoneEnabled: false, whatsappEnabled: false } },
    '/api/auth/get-session': { json: null },
    '/api/auth/oauth2/public-client-prelogin': { json: { client_id: 'automagik-cloud', client_name: 'Automagik Cloud' } },
  };
  await page.route(`${origin}/api/**`, (route: any) => {
    const { pathname: path, search } = new URL(route.request().url());
    calls.push({ path, method: route.request().method(), search, body: route.request().postData() ?? '' });
    const scripted = scene.api?.[path] ?? healthy[path] ?? { status: 500, body: 'not scripted' };
    const turn = turns[path] = (turns[path] ?? 0) + 1;
    const reply = Array.isArray(scripted) ? scripted[Math.min(turn, scripted.length) - 1] : scripted;
    if (reply.hang) return undefined;
    if (reply.drop) return route.abort('failed');
    const json = typeof reply.json === 'function' ? reply.json() : reply.json;
    return route.fulfill({
      status: reply.status ?? 200, headers: reply.headers,
      contentType: reply.body === undefined ? 'application/json' : 'text/html',
      body: reply.body ?? JSON.stringify(json ?? null),
    });
  });
  // The product's callback is not this service: answer with no content, so the browser
  // stays on the page and its last state can be seen.
  await page.route('https://cloud.example.com/**', (route: any) => route.fulfill({ status: 204 }));
  const seen = watch(page);
  await page.goto(`${origin}/${scene.page}${scene.query ? `?${scene.query}` : ''}`);
  if (scene.view !== 'loading') await page.locator('#card[aria-busy="false"]').waitFor();
  await scene.act?.(page);
  // The pointer leaves the card, so no button is pictured or measured under it.
  await page.mouse.move(1, 1);
  await page.locator(`#card [data-view="${scene.view}"]:not([hidden])`).waitFor();
  await expect.poll(() => said(page), { timeout: 10000 }).toBe((phone && scene.sayOnPhone) || scene.say);
  await page.evaluate('document.fonts.ready.then(() => true)');
  return { page, seen, calls };
}

describe('pages: every state', () => {
  const chosen = scenes.filter(scene => !only.length || only.some(part => scene.name.includes(part)));

  test('each state says what it should, with no console error and only contract calls', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin } = await world();
    // Every state in a desk browser's narrow window; the WhatsApp states again on a phone,
    // where a button takes the place of the code to scan.
    for (const phone of [false, true]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, ...(phone ? { hasTouch: true, isMobile: true } : {}),
      });
      for (const scene of chosen.filter(scene => !phone || scene.name.includes('whatsapp'))) {
        const label = `${scene.name}${phone ? ' on a phone' : ''}`;
        const { page, seen, calls } = await stage(context, origin, scene, phone);
        expect(await onPhone(page), label).toBe(phone);
        expect(await heading(page), label).toBe(scene.title);
        expect(await view(page), label).toBe(scene.view);
        await scene.more?.(page, calls);
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 700 });
          const overflow = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
          expect(overflow, `${label} at ${width}`).toBeLessThanOrEqual(0);
          const clipped = await page.evaluate(`[...document.querySelectorAll('#card .button, #card .link, #card h1, #say, #wa-code')]
            .filter(node => node.offsetParent && node.scrollWidth > node.clientWidth + 1).map(node => node.id)`);
          expect(clipped, `${label} at ${width}`).toEqual([]);
        }
        expectOnlyContract(seen, origin, ['https://cloud.example.com/auth/callback']);
        expectErrors(seen, scene.refused ?? 0);
        await page.close();
      }
      await context.close();
    }
  }, 600000);

  test('layout: the letter\'s label on one line beside the code, a fixed step under the logo on a phone, the whole Genie in front of the card', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin } = await world();
    const named = (name: string) => scenes.find(scene => scene.name === name)!;
    const host = `(() => {
      const logo = document.querySelector('.brand').getBoundingClientRect(), scene = document.querySelector('#scene');
      const pet = document.querySelector('#pet').getBoundingClientRect(), card = document.querySelector('#card').getBoundingClientRect();
      const front = document.elementFromPoint(pet.left + pet.width / 2, card.top + 2);
      return {
        step: scene.getBoundingClientRect().top - logo.bottom, who: scene.dataset.who, art: getComputedStyle(document.querySelector('#pet')).backgroundImage,
        pet: [Math.round(pet.width), Math.round(pet.height)], over: pet.bottom - card.top, clear: pet.top >= logo.bottom, front: front ? front.id : '',
      };
    })()`;
    // A desk browser: the code to scan with the letter beside it, the label on one line; in
    // a window too narrow for the pair, the letter goes under the code.
    // No motion here: the host's breathing would change the sizes measured.
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const waiting = await stage(desk, origin, named('sign-in-20-whatsapp-waiting-for-the-message'));
    for (const [width, beside] of [[1440, true], [700, true], [480, true], [479, false], [390, false]] as const) {
      await waiting.page.setViewportSize({ width, height: 900 });
      const letter = await waiting.page.evaluate(`(() => {
        const label = document.querySelector('.letter-label'), range = document.createRange(); range.selectNodeContents(label);
        const code = document.querySelector('#qr').getBoundingClientRect(), box = document.querySelector('.letter').getBoundingClientRect();
        return {
          lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size, shown: code.width >= 148,
          beside: box.left >= code.right && box.top < code.bottom && box.bottom > code.top, under: box.top >= code.bottom,
        };
      })()`);
      expect(letter, `the letter at ${width}`).toEqual({ lines: 1, shown: true, beside, under: !beside });
    }
    await waiting.page.close();
    // There Genie is centred with the card; it is the whole figure, in front of the card.
    const wide = await stage(desk, origin, named('sign-in-02-passkey'));
    const centred = await wide.page.evaluate(host) as any;
    expect([centred.who, centred.pet, centred.front, centred.clear]).toEqual(['genie', [150, 163], 'pet', true]);
    expect(centred.art).toContain('/assets/genie-faces.webp');
    expect(centred.step).toBeGreaterThan(44);
    await wide.page.close();
    await desk.close();
    // A phone: the host and the card start the same short step under the logo in every
    // state that fits the screen, and Genie's tail ends over the card's edge, in front.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
    const steps: number[] = [];
    for (const name of ['sign-in-01-loading', 'sign-in-02-passkey', 'sign-in-06-passkey-failed', 'consent-02-ask']) {
      const { page } = await stage(phone, origin, named(name), true);
      const place = await page.evaluate(host) as any;
      expect([place.who, place.pet, place.front, place.clear], name).toEqual(['genie', [132, 143], 'pet', true]);
      expect(place.art, name).toContain('/assets/genie-faces.webp');
      expect(place.over, name).toBeGreaterThan(0);
      expect(place.over, name).toBeLessThanOrEqual(14);
      expect(place.step, name).toBeGreaterThanOrEqual(12);
      expect(place.step, name).toBeLessThanOrEqual(44);
      steps.push(place.step);
      await page.close();
    }
    for (const step of steps) expect(step).toBeCloseTo(steps[0], 1);
    await phone.close();
  }, 120000);

  test('the logo: the set\'s file for the theme, drawn unstretched at the site\'s sizes, centred, on both pages', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin } = await world();
    const named = (name: string) => scenes.find(scene => scene.name === name)!;
    const measure = `(async () => {
      const image = document.querySelector('.brand img'); await image.decode();
      const box = image.getBoundingClientRect(), style = getComputedStyle(image);
      return {
        file: image.currentSrc.split('/').pop(), drawn: image.naturalWidth > 0, name: image.alt, size: [box.width, box.height],
        off: box.left + box.width / 2 - innerWidth / 2, top: box.top, over: document.documentElement.scrollWidth - innerWidth,
        effects: [style.filter, style.opacity, style.transform].join(' '), pictures: document.images.length,
      };
    })()`;
    for (const colorScheme of ['light', 'dark'] as const) {
      for (const [width, height, mark] of [[1440, 900, 32], [390, 844, 26], [320, 700, 23]] as const) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce' });
        for (const name of ['sign-in-02-passkey', 'consent-02-ask']) {
          const label = `${name} ${colorScheme} ${width}`;
          const { page } = await stage(context, origin, named(name));
          const logo = await page.evaluate(measure) as any;
          expect([logo.file, logo.drawn, logo.name, logo.pictures], label).toEqual([`automagik-lockup-three-colours-${colorScheme === 'dark' ? 'cream' : 'ink'}-header.svg`, true, 'Automagik', 1]);
          expect(Math.abs(logo.size[1] - mark * 264 / 222), label).toBeLessThanOrEqual(0.6);
          expect(Math.abs(logo.size[0] - mark * 1632.34 / 222), label).toBeLessThanOrEqual(0.6);
          expect(Math.abs(logo.off), label).toBeLessThanOrEqual(1);
          expect(logo.top, label).toBeGreaterThanOrEqual(0);
          expect(logo.over, label).toBeLessThanOrEqual(0);
          expect(logo.effects, label).toBe('none 1 none');
          await page.close();
        }
        await context.close();
      }
    }
  }, 180000);

  test('a framed page shows nothing and calls nothing', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin } = await world();
    const context = await browser.newContext();
    const page = await context.newPage();
    const seen = watch(page);
    // The Worker's own answer says DENY, so the browser refuses to frame it. A host that
    // lost that header is played here by the same files without it: the script hides them.
    for (const name of PAGES) {
      const body = await read(`${name}.html`);
      await page.route(`${origin}/bare/${name}?*`, (route: any) => route.fulfill({ contentType: 'text/html', body }));
    }
    await page.route(`${origin}/host`, (route: any) => route.fulfill({
      contentType: 'text/html',
      body: PAGES.map(name => `<iframe src="/${name}?${cloud}"></iframe><iframe src="/bare/${name}?${cloud}"></iframe>`).join(''),
    }));
    await page.goto(`${origin}/host`);
    await page.waitForLoadState('networkidle');
    const frames = page.frames().slice(1);
    expect(frames).toHaveLength(4);
    let refused = 0;
    let hidden = 0;
    for (const frame of frames) {
      if (new URL(frame.url()).pathname.startsWith('/bare/')) {
        expect(await frame.locator('#card').count(), frame.url()).toBe(1);
        expect(await frame.evaluate('document.documentElement.hidden'), frame.url()).toBe(true);
        hidden++;
      } else {
        expect(await frame.locator('#card').count(), frame.url()).toBe(0);
        refused++;
      }
    }
    expect([refused, hidden]).toEqual([2, 2]);
    expect(seen.requests.filter(entry => entry.includes(`${origin}/id.js`))).toHaveLength(2);
    expect(seen.requests.filter(entry => entry.includes('/api/'))).toEqual([]);
    await context.close();
  }, 60000);

  test.runIf(shots)('pictures of every state at 1440 and 390, light and dark', async ({ skip }) => {
    if (!(await chromium())) return skip();
    const { origin } = await world();
    await mkdir(shots, { recursive: true });
    const sizes = [
      { width: 1440, height: 900, scale: 1, schemes: ['light', 'dark'] },
      { width: 390, height: 844, scale: 2, schemes: ['light', 'dark'] },
      { width: 320, height: 568, scale: 2, schemes: ['light'] },
    ];
    for (const size of sizes) {
      for (const scheme of size.schemes) {
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale,
          colorScheme: scheme, hasTouch: size.width < 700, isMobile: size.width < 700,
        });
        for (const scene of chosen) {
          const { page } = await stage(context, origin, scene, size.width < 700);
          await page.waitForTimeout(350);
          await page.screenshot({ path: resolve(shots, `${scene.name}-${size.width}-${scheme}.png`), fullPage: size.width === 320 });
          await page.close();
        }
        await context.close();
      }
    }
    const rows = chosen.map(scene => `| ${scene.name} | ${scene.title} | ${scene.say}${scene.sayOnPhone ? ` On a phone: ${scene.sayOnPhone}` : ''} | ` +
      sizes.flatMap(size => size.schemes.map(scheme =>
        `[${size.width} ${scheme}](${scene.name}-${size.width}-${scheme}.png)`)).join(' · ') + ' |');
    await writeFile(resolve(shots, 'INDEX.md'), [
      '# Automagik ID pages: every state', '',
      'Made by `ID_PAGES_SHOTS=<this folder> bun run test -- pages` in `apps/id`: the real pages, served by the',
      'real Worker, in Chromium. The service\'s answers and the browser\'s passkey prompt are scripted per state',
      '(the prompt itself belongs to the browser and cannot be pictured). 1440 x 900 at 1x; 390 x 844 and',
      '320 x 568 at 2x. The 390 and 320 pictures are a phone (touch): there the WhatsApp states show a button;',
      'at 1440 they show the code a phone scans. Genie hosts the passkey and consent states, Omni the WhatsApp ones.', '',
      '`whatsapp-flow-390.webm` is a recording of the WhatsApp flow at phone width on the real Worker with the',
      'service\'s test settings: Use WhatsApp, the message and its code, the wait while the person sends it from',
      'their phone (the test posts that message to the service\'s receiver, as WhatsApp would), then signed in',
      'and back to the product (a stand-in page).', '',
      '| State | Heading | The host says | Pictures |', '|---|---|---|---|', ...rows, '',
    ].join('\n'));
  }, 900000);
});
