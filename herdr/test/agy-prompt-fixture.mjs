// Synthetic shapes for the matcher's own rules; the captured screens are `capture(name)`.
import { readFileSync } from "node:fs";
export const capture = (name) => readFileSync(new URL(`./fixtures/agy-prompts/1.5.16/${name}`, import.meta.url), "utf8");

export const TRUST = "SYNTHETIC trust this folder?";
export const ACCESS = "SYNTHETIC allow file access outside the workspace to";
export const CHOICES = ["1. SYNTHETIC yes", "❯ 2. SYNTHETIC no"];
export const FOOTER = "SYNTHETIC enter to confirm";
export const SYNTHETIC = [
  { kind: "folder-trust", question: /^SYNTHETIC trust this folder\?$/,
    after: [/^❯? ?1\. SYNTHETIC yes$/, /^❯? ?2\. SYNTHETIC no$/] },
  { kind: "file-access", question: /^SYNTHETIC allow file access outside the workspace to \S+\?$/,
    after: [/^❯ Allow once$/, /^SYNTHETIC enter to confirm$/] },
];
export const trustScreen = [TRUST, ...CHOICES].join("\n");
export const fileQuestion = (path = "synthetic/path") => ACCESS + " " + path + "?";
export const fileScreen = (path) => [fileQuestion(path), "❯ Allow once", FOOTER].join("\n");
