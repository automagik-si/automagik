#!/usr/bin/env bun
/**
 * Automagik's one version: the repository, the Bot team, the welcome, the desktop app and
 * the herdr pack (herdr/package.json and the pack's own mods/am-sidebar/VERSION), am (am/VERSION, RFC 0012) and the meter
 * crate (meter/usagemeter's Cargo.toml and Cargo.lock, RFC 0017) all carry it. Each release is 3.N (semver 3.N.0, tagged v3.N.0), N one above the highest release
 * tag, numbers compared as numbers, as Tactu numbers its v1.N: above every Omni desktop build
 * (2.YYMMDD.N, from automagik-dev/omni-desktop), so an installed app updates into this one.
 * Until the first release the repository carries 3.0.0, which is never released. The calendar
 * tags of the first releases (v3.YYMMDD.N, 2026-10-23 and 24) are not release tags.
 *
 *   bun scripts/version.ts check            every field carries the root version; exit 1 when not
 *   bun scripts/version.ts set <version>    write it everywhere
 *   bun scripts/version.ts next             the next release: 3.(highest v3.N.0 + 1).0, 3.1.0 first
 *   bun scripts/version.ts code [<version>] Pocket's Android versionCode for it (the root version by default)
 *
 * A plugin-only merge is released as a patch on the newest 3.N instead (scripts/lane.ts next-patch).
 *
 * Pocket (apps/pocket/android) builds its versionCode from the version: major·1 000 000 + minor·1 000
 * + patch, so 3.57.0 is 3057000. Minor and patch are therefore at most 999 (3.1000.0 would be 4.0.0's
 * code): a version above that is refused here, so the release workflow, which sets the version through
 * this file, refuses it too. Bump the next part up instead (docs/rfcs/0011, "Pocket").
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dir, '..');
export const MAJOR = 3;
// A release: 3.N.0, or a plugin-only patch on it, 3.N.P (scripts/lane.ts). N and P are at most
// three digits, 999, so Pocket's versionCode stays one number per version (see versionCode) and a
// calendar tag's 3.YYMMDD.N is never taken for one.
export const VERSION = /^3\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
/** The highest minor and patch: Pocket's versionCode gives each 1 000 values. */
export const MAX_PART = 999;
/** A release tag: `v3.N.0`, N a whole number without leading zeros. */
export const RELEASE_TAG = /^v3\.(0|[1-9]\d*)\.0$/;

/**
 * Every file and JSON path that carries the version. An empty path is a plain-text file that holds
 * the version alone, on one line (the herdr pack's VERSION, which its updater reads).
 */
export const FIELDS: { file: string; path: string[] }[] = [
  { file: 'package.json', path: ['version'] },
  { file: 'apps/bots-dsh/package.json', path: ['version'] },
  { file: 'apps/welcome-dsh/package.json', path: ['version'] },
  { file: 'apps/locale-pt-br-dsh/package.json', path: ['version'] },
  { file: 'apps/acp-dsh/package.json', path: ['version'] },
  { file: 'apps/multiuser-dsh/package.json', path: ['version'] },
  { file: 'apps/vault-dsh/package.json', path: ['version'] },
  { file: 'apps/automagik-pets/package.json', path: ['version'] },
  { file: 'apps/desktop/package.json', path: ['version'] },
  { file: 'apps/desktop/package-lock.json', path: ['version'] },
  { file: 'apps/desktop/package-lock.json', path: ['packages', '', 'version'] },
  { file: 'herdr/package.json', path: ['version'] },
  { file: 'herdr/mods/am-sidebar/VERSION', path: [] },
  { file: 'am/VERSION', path: [] },
];

/**
 * The Rust crates that carry the version (RFC 0017, "Version"): `[package] version` in each one's
 * Cargo.toml, and its own `[[package]]` entry in its Cargo.lock, which CI builds with --locked.
 * Each is one line, rewritten in place; every other byte of both files stays as it is.
 */
export const CRATES: { dir: string; name: string }[] = [{ dir: 'meter/usagemeter', name: 'usagemeter' }];
/** Every file a crate's version is in, for copies and listings. */
export const crateFiles = () => CRATES.flatMap(({ dir }) => [`${dir}/Cargo.toml`, `${dir}/Cargo.lock`]);

const CARGO_VERSION = /^version = "([^"]*)"$/;

/**
 * The index of the line holding a crate's version, or -1: in a Cargo.toml the first `version = "…"`
 * of `[package]`; in a Cargo.lock the one of the `[[package]]` whose `name` is the crate's (the
 * lock's own top-level `version = 4` sits in no table and never matches). A crate entry that ends
 * with no version line is -1 too, so the next entry's version is never taken for the crate's.
 */
export function cargoVersionLine(lines: string[], kind: 'toml' | 'lock', name: string): number {
  let table = '';
  let named = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*\[/.test(line)) {
      if (named) return -1;
      table = line.trim();
      continue;
    }
    if (kind === 'lock' && table === '[[package]]' && line === `name = "${name}"`) named = true;
    if (!CARGO_VERSION.test(line)) continue;
    if (kind === 'toml' ? table === '[package]' : table === '[[package]]' && named) return index;
  }
  return -1;
}

/** Each crate's two version fields, as `file`, the line's `index` (-1 when missing) and its `value`. */
function crateFields(root: string) {
  return CRATES.flatMap(({ dir, name }) => (['toml', 'lock'] as const).map((kind) => {
    const file = `${dir}/Cargo.${kind}`;
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    const index = cargoVersionLine(lines, kind, name);
    const label = kind === 'toml' ? 'package.version' : `package[${name}].version`;
    return { file, kind, name, lines, index, label, value: index < 0 ? undefined : CARGO_VERSION.exec(lines[index])?.[1] };
  }));
}

const read = (root: string, file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const at = (value: unknown, path: string[]) =>
  path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);

/** The fields that do not carry `version`, as `file:path = value`. */
export function drift(version: string, root = ROOT): string[] {
  return [
    ...FIELDS.flatMap(({ file, path }) => {
      const value = path.length === 0 ? readFileSync(join(root, file), 'utf8').trim() : at(read(root, file), path);
      return value === version ? [] : [`${file}:${path.join('.') || '.'} = ${String(value)}`];
    }),
    ...crateFields(root).flatMap(({ file, label, value }) => (value === version ? [] : [`${file}:${label} = ${String(value)}`])),
  ];
}

/** Refuses a version whose minor or patch is over 999, which Pocket's versionCode can't tell apart. */
function guard(version: string): void {
  const parts = /^\d+\.(\d+)\.(\d+)$/.exec(version);
  if (parts && (Number(parts[1]) > MAX_PART || Number(parts[2]) > MAX_PART)) {
    throw new Error(`not a version: ${version} (minor and patch stop at ${MAX_PART}, Pocket's versionCode; bump the next part up)`);
  }
}

/** Pocket's Android versionCode: major·1 000 000 + minor·1 000 + patch, one per version. */
export function versionCode(version: string): number {
  guard(version);
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!parts) throw new Error(`not a version: ${version}`);
  return Number(parts[1]) * 1_000_000 + Number(parts[2]) * 1_000 + Number(parts[3]);
}

export function setVersion(version: string, root = ROOT): void {
  guard(version);
  if (!VERSION.test(version)) throw new Error(`not a version: ${version} (want ${MAJOR}.N.P)`);
  // Every crate's version line is found before any file is written, so a missing one changes nothing.
  const crates = crateFields(root);
  const missing = crates.find(({ index }) => index < 0);
  if (missing) throw new Error(`version: no ${missing.label} line in ${missing.file}`);
  for (const file of new Set(FIELDS.map((field) => field.file))) {
    if (FIELDS.some((field) => field.file === file && field.path.length === 0)) {
      writeFileSync(join(root, file), `${version}\n`);
      continue;
    }
    const json = read(root, file);
    for (const field of FIELDS.filter((candidate) => candidate.file === file)) {
      const parent = at(json, field.path.slice(0, -1)) as Record<string, unknown>;
      parent[field.path.at(-1) as string] = version;
    }
    writeFileSync(join(root, file), `${JSON.stringify(json, null, 2)}\n`);
  }
  for (const { file, lines, index } of crates) {
    lines[index] = `version = "${version}"`;
    writeFileSync(join(root, file), lines.join('\n'));
  }
}

/** The release after the highest `v3.N.0` in `tags` (3.1.0 when there is none); others are ignored. */
export function nextVersion(tags: string[]): string {
  const taken = tags.map((tag) => RELEASE_TAG.exec(tag)?.[1]).filter((n): n is string => n !== undefined).map(Number)
    // A calendar tag (v3.YYMMDD.0) is not a release.
    .filter((n) => n <= MAX_PART);
  const next = `${MAJOR}.${Math.max(0, ...taken) + 1}.0`;
  guard(next);
  return next;
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2);
  const root = read(ROOT, 'package.json').version as string;
  if (command === 'check') {
    const problems = drift(root);
    for (const problem of problems) console.error(`version: ${problem}, not ${root}`);
    if (problems.length > 0) process.exit(1);
    console.log(`version: ${root} everywhere`);
  } else if (command === 'set' && arg) {
    setVersion(arg);
    console.log(`version: ${arg}`);
  } else if (command === 'next') {
    const tags = execFileSync('git', ['tag', '--list', `v${MAJOR}.*`], { cwd: ROOT, encoding: 'utf8' }).split('\n');
    console.log(nextVersion(tags));
  } else if (command === 'code') {
    console.log(versionCode(arg ?? root));
  } else {
    console.error('usage: bun scripts/version.ts check | set <version> | next | code [<version>]');
    process.exit(2);
  }
}
