// am-quota's switch: the one thing the panel changes for Codex — which account the local client
// uses.
//
// Extracted from the panel so the flow itself, not only the shell it runs, is exercised by
// `node --test`: `exec`, `readTextFile`, `writeTextFile` and `unlink` are injected, and the flow
// answers with what it wrote (a label and a fingerprint — never a token) or throws the one line
// the panel shows.
//
// The order is deliberate: download → translate → private payload → write the file → answer.
// Claude has no writer here: a Claude login is never downloaded from the proxy or installed, and
// nothing here calls `security` (#453, docs/local-logins.md). A Claude switch only changes which
// login signed in on this Mac new launches use.
import * as fs from "fs/promises";
import { credentialTarget, problems, TARGETS, tokenIdentity } from "./translate.js";
import { installScript, payload as credentialPayload, payloadDir, payloadPath, prepareScript } from "./write.js";

const message = (err) => String(err?.message ?? err);

/** A credential body that is not JSON is reported by name: the text itself holds tokens. */
const parseCredential = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("the proxy's credential response was not JSON");
  }
};

/** `~` for the home folder, so a message names a file without a person's full path. */
const displayPath = (file, home) => (file.startsWith(home) ? `~${file.slice(home.length)}` : file);

/**
 * Installs one proxy credential into the client that owns that provider. Everything sensitive
 * happens in files the shell reads: the token never enters argv, a log, a notify or shared state.
 *
 * `exec` is the runtime's `exec` (or a test's); `readTextFile`/`writeTextFile` have the runtime's
 * `(path, text, before)` shape, where `before: null` means create-only.
 */
export async function install({ api, provider, account, ...rest }) {
  if (!TARGETS[provider]) throw new Error("no writer for that provider");
  const credential = parseCredential(await api.credential(account?.name));
  const missing = problems(provider, credential);
  if (missing.length) throw new Error(missing.join("; "));
  return place({ provider, body: credentialPayload(provider, credential), ...rest });
}

/**
 * Puts one client-shaped credential body in place: the client's own file, through a private
 * payload, backed up, 0600 and an atomic rename. The body is never logged, and the answer is a
 * label and a fingerprint.
 */
export async function place({ provider, body, home, appHome, env = {}, exec, writeTextFile, unlink = (p) => fs.unlink(p), fence, installFenced }) {
  const target = TARGETS[provider];
  if (!target) throw new Error("no writer for that provider");
  let scratch = null;
  try {
    const plan = credentialTarget(provider, { home, env });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // The payload file holds tokens for a moment: the folder is 0700 before it exists, the file
    // is 0600 the instant `writeTextFile` creates it, and it is removed on every path — the
    // script's `rm`, its EXIT trap, and the finally below, whichever comes first.
    const dir = payloadDir(appHome);
    scratch = payloadPath(appHome, provider, stamp);
    const prep = await exec("sh", ["-c", prepareScript(), "sh", dir, scratch]);
    if (prep.code !== 0) throw new Error("could not prepare a private file for the credential");

    await writeTextFile(scratch, body, null);   // created by this call (the folder is 0700)
    const tight = await exec("chmod", ["600", scratch]);
    if (tight.code !== 0) throw new Error("could not restrict the credential payload file");

    // Backup, then 0600, then an atomic rename — never a partial credential on disk.
    if (fence) await fence(body);
    if (installFenced) await installFenced(stamp);
    else {
      const done = await exec("sh", ["-c", installScript(stamp), "sh", scratch, plan.file]);
      if (done.code !== 0) throw new Error(`could not write ${displayPath(plan.file, home)}: ${(done.stderr || done.stdout).trim().slice(0, 120)}`);
    }

    return { label: target.label, fingerprint: tokenIdentity(provider, body) };
  } catch (err) {
    throw new Error(message(err));
  } finally {
    if (scratch) await unlink(scratch).catch(() => {});
  }
}
