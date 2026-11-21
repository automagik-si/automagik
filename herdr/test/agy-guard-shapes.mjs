// Synthetic Antigravity shapes for the hc guard's tests (RFC 0042 delivery 2), and the --import
// hook that arms a stable copy's agyPrompt.js with them in a child process only: the copy's bytes
// stay the installed ones. Synthetic only: the real wording comes from delivery 0's captures.
import { SYNTHETIC } from "./agy-prompt-fixture.mjs";

export const GUARD_APP = "synthetic-agy";
/** A shape pendingDialog does not answer (no question mark, numbered choice or footer word). */
export const QUIET = { kind: "file-access", question: /^SYNTHETIC quiet request about \S+$/,
  after: [/^SYNTHETIC quiet choice$/] };
export const quietScreen = (path = "synthetic/path") => `SYNTHETIC quiet request about ${path}\nSYNTHETIC quiet choice`;
export const GUARD_SHAPES = Object.freeze([...SYNTHETIC, QUIET]);
export const GUARD_APPS = Object.freeze([GUARD_APP]);

/**
 * The source of a node --import hook: the module at `target` (a file URL, the realpath of a
 * stable copy's agyPrompt.js) is served as a wrapper over the real file (`?real`) that keeps
 * every export and fills AGY_SHAPES, AGY_APPS and the two functions' defaults with these.
 */
export function agyHookSource(target) {
  const real = `${target}?real`;
  const wrapper = [
    `export * from ${JSON.stringify(real)};`,
    `import { agyPromptOf as match, agyCandidate as candidate } from ${JSON.stringify(real)};`,
    `import { GUARD_SHAPES, GUARD_APPS } from ${JSON.stringify(import.meta.url)};`,
    "export const AGY_SHAPES = GUARD_SHAPES;",
    "export const AGY_APPS = GUARD_APPS;",
    "export const agyPromptOf = (text, shapes = AGY_SHAPES) => match(text, shapes);",
    "export const agyCandidate = (record, apps = AGY_APPS) => candidate(record, apps);",
  ].join("\n");
  return 'import { registerHooks } from "node:module";\n'
    + `const target = ${JSON.stringify(target)};\n`
    + `const wrapper = ${JSON.stringify(wrapper)};\n`
    + "registerHooks({ load(url, context, nextLoad) {\n"
    + '  return url === target ? { format: "module", source: wrapper, shortCircuit: true } : nextLoad(url, context);\n'
    + "} });\n";
}
