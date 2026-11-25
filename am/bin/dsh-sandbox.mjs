#!/usr/bin/env node
// The install/check helper for the dsh-sandbox profile row (apps/dsh-sandbox, issue #631).
//
// `install` writes (or replaces) one managed block in a DSH profile's cordis.patch.yml, carries
// the absolute wrapper path and the failure signature, backs up the file it changes and writes
// atomically. `check` reads only and says whether that block is there exactly once and matches
// the wrapper. The pack runs this helper at enablement; nothing here is run against a live
// profile by the tests, which pass a temporary one (README.md, "Rollout").
//
// No dependencies, like the wrapper: the block is generated here and compared byte for byte,
// so a hand-altered row fails check instead of being silently accepted.
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Every line the helper prints starts with this (not a runner failure signature). */
export const MSG_PREFIX = 'dsh-sandbox: ';
/** The managed block's markers: exactly one pair belongs in a profile. */
export const BEGIN = '# dsh-sandbox begin';
export const END = '# dsh-sandbox end';
/** The profile snippet's placeholder, substituted by `install` only. */
export const PLACEHOLDER = '{{WRAPPER}}';
/** The wrapper's failure signature, kept in sync with bin/hc-socket-mask.mjs. */
export const FAILURE_SIGNATURE = 'hc-socket-mask: ';
/**
 * The wrapper's own word before its profile args: the stable folder whose data parent it mounts.
 */
export const PACK_ROOT_FLAG = '--pack-root';

/** A YAML single-quoted scalar: the only quoting a path or signature here needs. */
export function yamlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** The managed block for an absolute wrapper path, byte for byte. */
export function sandboxBlock(wrapper, packRoot = null) {
  const runner = packRoot === null
    ? `[${yamlQuote(wrapper)}]`
    : `[${yamlQuote(wrapper)}, ${yamlQuote(PACK_ROOT_FLAG)}, ${yamlQuote(packRoot)}]`;
  return [
    BEGIN,
    '- id: sandbox',
    '  config:',
    `    runnerCommand: ${runner}`,
    `    runnerFailureSignatures: [${yamlQuote(FAILURE_SIGNATURE)}]`,
    END,
  ].join('\n');
}

/** The profile the pack installs into: $DSH_HOME/profiles/dsh-tui/cordis.patch.yml. */
export function defaultProfile(env = process.env) {
  const home = env.DSH_HOME || (env.HOME ? join(env.HOME, '.dsh') : homedir());
  if (!home) throw new Error('neither DSH_HOME nor HOME is set: pass --profile');
  return resolve(join(home, 'profiles', 'dsh-tui', 'cordis.patch.yml'));
}

/** The wrapper path as written, requiring it to be absolute (a relative path is refused). */
export function requireAbsoluteWrapper(wrapper) {
  if (!wrapper) throw new Error('--wrapper is required');
  if (!isAbsolute(wrapper)) {
    throw new Error(`the wrapper path must be absolute: ${wrapper}`);
  }
  return wrapper;
}

/** The wrapper's absolute path, requiring an executable regular file (install only). */
export function resolveWrapper(wrapper) {
  const path = requireAbsoluteWrapper(wrapper);
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new Error(`the wrapper ${path} does not exist`);
  }
  if (!info.isFile()) throw new Error(`the wrapper ${path} is not a regular file`);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`the wrapper ${path} is not executable`);
  }
  return path;
}

/** Where the markers are: the exact lines, so a hand-edited marker is not a managed block. */
export function findManaged(text) {
  const lines = text.split('\n');
  const begins = [];
  const ends = [];
  lines.forEach((line, index) => {
    const trimmed = line.trimEnd();
    if (trimmed === BEGIN) begins.push(index);
    else if (trimmed === END) ends.push(index);
  });
  return { lines, begins, ends };
}

/** The one line describing a malformed or duplicated marker set, or null when it is well formed. */
export function markerProblem(text) {
  const { begins, ends } = findManaged(text);
  if (begins.length === 0 && ends.length === 0) {
    return 'the profile has no managed dsh-sandbox block';
  }
  if (begins.length !== 1 || ends.length !== 1) {
    return `the profile has ${begins.length} begin and ${ends.length} end markers; `
      + 'keep exactly one block';
  }
  if (begins[0] > ends[0]) return 'the dsh-sandbox end marker comes before its begin marker';
  return null;
}

/**
 * The DSH template's `[]` with a trailing YAML comment: at column 0, a space or tab before the
 * `#`, and the comment (group 1, `#` included) runs to the line end. No CR anywhere.
 */
const EMPTY_FLOW_COMMENT = /^\[\][ \t]+(#[^\r\n]*)$/;
/** A blank line or a full-line comment: only spaces or tabs before the `#`, no CR anywhere. */
const BLANK_OR_COMMENT = /^[ \t]*(?:#[^\r\n]*)?$/;

/**
 * The commented template's line, or null. It must be the only content line, with no existing
 * managed markers, so neither the surrounding YAML nor an existing block changes its meaning.
 */
function commentedTemplateLine(lines) {
  const at = lines.findIndex((line) => EMPTY_FLOW_COMMENT.test(line));
  if (at === -1) return null;
  return lines.every((line, index) => index === at
    || (BLANK_OR_COMMENT.test(line) && ![BEGIN, END].includes(line.trimEnd()))) ? at : null;
}

/**
 * The layer's top-level shape, without a YAML parser: comments and blank lines are skipped, so
 * only indentation and the first character of each content line count. This is a top-level
 * shape check, not YAML validation: an indented continuation line is accepted unparsed, and the
 * managed row is generated here. Returns `{ shape, line }`: 'empty' (comments/blank only), the
 * lone '[]' ('empty-flow', line set; also `[] # comment` at column 0 when every other line is
 * blank or a full-line comment other than a managed marker) or a block array ('block-array').
 * Throws a clear error for a mapping, a scalar, a flow array with entries or a '[]' mixed with
 * other content, an indented '[]' inside a block array included.
 */
export function layerShape(text) {
  const commented = commentedTemplateLine(text.split('\n'));
  if (commented !== null) return { shape: 'empty-flow', line: commented };
  const content = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    content.push({ index, trimmed, indented: /^[ \t]/.test(line) });
  });
  if (content.length === 0) return { shape: 'empty', line: null };
  const emptyFlow = content.filter((entry) => entry.trimmed === '[]');
  if (emptyFlow.length > 0 && content.length > 1) {
    throw new Error(`the profile layer has a top-level [] with other content at line `
      + `${emptyFlow[0].index + 1}: the result would not be one YAML array`);
  }
  if (emptyFlow.length === 1) return { shape: 'empty-flow', line: emptyFlow[0].index };
  const [first] = content;
  if (first.indented) {
    throw new Error(`the profile layer is not a top-level list: line ${first.index + 1} is `
      + 'indented; refusing to guess its shape');
  }
  if (first.trimmed.startsWith('[')) {
    throw new Error(`the profile layer is a flow array with entries at line ${first.index + 1}: `
      + 'only a top-level block array is supported');
  }
  if (!first.trimmed.startsWith('-')) {
    throw new Error(`the profile layer is a top-level mapping or scalar at line `
      + `${first.index + 1}: only a block array (or the lone []) can take the managed row`);
  }
  for (const entry of content.slice(1)) {
    if (!entry.indented && !entry.trimmed.startsWith('-')) {
      throw new Error(`the profile layer has top-level content that is not a list item at line `
        + `${entry.index + 1}: refusing to mix a block item into it`);
    }
  }
  return { shape: 'block-array', line: null };
}

const withFinalNewline = (text) => (text.endsWith('\n') ? text : `${text}\n`);

/** Append the managed block after an empty/comments-only layer or an existing block array. */
function appendBlock(text, block) {
  const separator = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${separator}${block}\n`;
}

/**
 * Replace the one managed block, replace the DSH template's lone `[]`, or append the block to
 * an empty/comments-only layer or an existing block array. The result is checked again so the
 * helper never writes a layer that is not one top-level block array.
 */
export function applyBlock(text, block) {
  const { lines, begins, ends } = findManaged(text);
  const shape = layerShape(text);
  let next;
  if (begins.length === 0 && ends.length === 0 && shape.shape === 'empty') {
    next = text.trim() === '' ? `${block}\n` : appendBlock(text, block);
  } else if (begins.length === 0 && ends.length === 0 && shape.shape === 'empty-flow') {
    const [, comment] = EMPTY_FLOW_COMMENT.exec(lines[shape.line]) ?? [];
    // A comment that reads as a marker keeps one leading space: it never becomes a marker.
    const reserved = comment !== undefined && [BEGIN, END].includes(comment.trimEnd());
    const kept = comment === undefined ? [] : [reserved ? ` ${comment}` : comment];
    lines.splice(shape.line, 1, ...kept, ...block.split('\n'));
    next = withFinalNewline(lines.join('\n'));
  } else if (begins.length === 0 && ends.length === 0) {
    next = appendBlock(text, block);
  } else {
    const problem = markerProblem(text);
    if (problem) throw new Error(problem);
    lines.splice(begins[0], ends[0] - begins[0] + 1, ...block.split('\n'));
    next = withFinalNewline(lines.join('\n'));
  }
  const nextProblem = markerProblem(next);
  if (nextProblem) throw new Error(`${nextProblem}; refusing to write`);
  if (layerShape(next).shape !== 'block-array') {
    throw new Error('the profile layer would not be one top-level block array; refusing to write');
  }
  return next;
}

const modeOf = (path) => {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o644;
  }
};

/** Write `content` through a sibling temp file and a rename: a reader never sees half a row. */
export function atomicWrite(path, content, mode = 0o644) {
  const tmp = join(dirname(path),
    `.${basename(path)}.dsh-sandbox-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

const stampOf = (date) => date.toISOString().replace(/[:.]/g, '-');

/** `<profile>.dsh-sandbox-backup-<timestamp>`, suffixed if that instant is already taken. */
export function backupPath(profile, date = new Date()) {
  const base = `${profile}.dsh-sandbox-backup-${stampOf(date)}`;
  if (!existsSync(base)) return base;
  for (let count = 1; ; count += 1) {
    const candidate = `${base}-${count}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Install (or re-install) the managed row. Returns the resolved paths, whether the profile
 * changed and the backup taken. Idempotent: an identical block is a no-op (no backup, no write).
 */
export function installRow({ profile, wrapper, packRoot = null, now = new Date() }) {
  const wrapperPath = resolveWrapper(wrapper);
  const path = resolve(profile);
  let originalBytes = null;
  try {
    originalBytes = readFileSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const original = originalBytes?.toString('utf8') ?? null;
  if (original !== null) {
    const commented = commentedTemplateLine(original.split('\n'));
    if (commented !== null && !originalBytes.equals(Buffer.from(original, 'utf8'))) {
      // Keep the original refusal if decoding lost any bytes from the commented template.
      throw new Error(`the profile layer is a flow array with entries at line ${commented + 1}: `
        + 'only a top-level block array is supported');
    }
  }
  const block = sandboxBlock(wrapperPath, packRoot);
  const next = original === null ? `${block}\n` : applyBlock(original, block);
  if (original !== null && next === original) {
    return { profile: path, wrapper: wrapperPath, changed: false, backup: null };
  }
  mkdirSync(dirname(path), { recursive: true });
  const mode = modeOf(path);
  let backup = null;
  if (original !== null) {
    backup = backupPath(path, now);
    writeFileSync(backup, original, { mode });
    chmodSync(backup, mode);
  }
  atomicWrite(path, next, mode);
  return { profile: path, wrapper: wrapperPath, changed: true, backup };
}

/** Check the installed row without writing. `ok` false carries one clear reason. */
export function checkRow({ profile, wrapper, packRoot = null }) {
  const path = resolve(profile);
  let wrapperPath;
  try {
    wrapperPath = requireAbsoluteWrapper(wrapper);
  } catch (error) {
    return { ok: false, message: error.message };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, message: `the profile ${path} does not exist or cannot be read` };
  }
  try {
    layerShape(text);
  } catch (error) {
    return { ok: false, message: `${error.message} (${path})` };
  }
  const problem = markerProblem(text);
  if (problem) return { ok: false, message: `${problem} (${path})` };
  const { lines, begins, ends } = findManaged(text);
  const actual = lines.slice(begins[0], ends[0] + 1).join('\n');
  if (actual !== sandboxBlock(wrapperPath, packRoot)) {
    return {
      ok: false,
      message: `the managed block in ${path} is not the row for ${wrapperPath} `
        + '(altered row or a different wrapper path)',
    };
  }
  return { ok: true, message: `the sandbox row in ${path} matches ${wrapperPath}` };
}

/** The command line's flags: --profile (defaulted) and --wrapper (required). */
export function parseArgs(argv, env = process.env) {
  const command = argv[0];
  if (command !== 'install' && command !== 'check') {
    return { error: `unknown command: ${command ?? '(none)'}` };
  }
  let profile;
  let wrapper;
  let packRoot = null;
  for (let at = 1; at < argv.length; at += 1) {
    const flag = argv[at];
    if (flag === '--profile' && argv[at + 1]) profile = argv[(at += 1)];
    else if (flag === '--wrapper' && argv[at + 1]) wrapper = argv[(at += 1)];
    else if (flag === '--pack-root' && argv[at + 1]) packRoot = argv[(at += 1)];
    else return { error: `unknown or incomplete argument: ${flag}` };
  }
  if (!wrapper) return { error: '--wrapper is required' };
  try {
    profile ??= defaultProfile(env);
  } catch (error) {
    return { error: error.message };
  }
  return { command, profile, wrapper, packRoot };
}

const USAGE = [
  'usage: dsh-sandbox install [--profile <path>] --wrapper <absolute path> [--pack-root <dir>]',
  '       dsh-sandbox check   [--profile <path>] --wrapper <absolute path> [--pack-root <dir>]',
  '--profile defaults to $DSH_HOME/profiles/dsh-tui/cordis.patch.yml ($DSH_HOME is ~/.dsh)',
  '--pack-root: the stable execution folder; the wrapper mounts its data parent read-only',
].join('\n');

/** Run the CLI and return its exit code; the CLI guard at the bottom applies it. */
export function main(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  const parsed = parseArgs(argv, env);
  if (parsed.error) {
    process.stderr.write(`${MSG_PREFIX}${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  try {
    if (parsed.command === 'install') {
      const result = installRow({ profile: parsed.profile, wrapper: parsed.wrapper, packRoot: parsed.packRoot });
      const detail = !result.changed
        ? 'already current'
        : result.backup ? `backup ${result.backup}` : 'new profile';
      process.stdout.write(
        `${MSG_PREFIX}installed the sandbox row in ${result.profile} (${detail})\n`,
      );
      return 0;
    }
    const result = checkRow({ profile: parsed.profile, wrapper: parsed.wrapper, packRoot: parsed.packRoot });
    if (!result.ok) {
      process.stderr.write(`${MSG_PREFIX}${result.message}\n`);
      return 1;
    }
    process.stdout.write(`${MSG_PREFIX}${result.message}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${MSG_PREFIX}${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
