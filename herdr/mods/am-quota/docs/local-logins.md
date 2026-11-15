# Claude logins signed in on this Mac (#453): design note

Status: **built.** The launch side and section 9 (#499): every Claude launch route reads the record,
and the Claude download, install and Keychain paths are gone. The panel (sections 3 to 7, this
build): `logins.js` and the Claude card. The checks marked **UNVERIFIED** below need the real
`claude` binary, which the build never ran; they are the owner checklist of the panel's PR. #453,
#424. Owner decisions of 2026-11-06:
- the copy test is dropped;
- Claude reaches a machine only through that machine's own Anthropic sign-in, one per account it
  needs;
- a Claude login is never copied from the proxy, which keeps its logins for quota reading only;
- Codex stays as it is;
- a second Claude login exists **on the Mac only**.

For Claude on the Mac, this note supersedes what `DESIGN.md` and `RECIPE.md` say about Claude
accounts being added on the proxy and installed from it. Those files change in the build PR, not
here. Codex's card, its proxy download and its `auth.json` write are out of scope and stay
byte-identical.

## The constraint

**No two places may hold the same grant.** A grant is one sign-in's token chain. Anthropic rotates
the refresh token on use, so two holders of one chain sign each other out. This was seen on
2026-11-06 at 00:09Z: the proxy renewed an account the panel had copied into the Mac's Keychain,
and every Claude pane on the default login stopped that minute. So:

- every login on the Mac comes from its own `claude auth login`, run by the person;
- a switch only changes **which existing login new Claude launches use**. It never copies, moves,
  merges or restores a credential, and it never writes the Keychain;
- the panel never reads a token or a Claude Keychain item, never writes a Claude Keychain item,
  never runs a login or a logout, and never downloads a Claude credential from the proxy.

## 1. Where each login lives

Two logins, **A** and **B**, one per account.

| | Login A (signed in today) | Login B (the second sign-in) |
|---|---|---|
| Config folder | `~/.claude` | **`$HOME/.claude-2`**, absolute |
| Global state file | `~/.claude.json` | `$HOME/.claude-2/.claude.json` |
| `CLAUDE_CONFIG_DIR` | **unset** | `$HOME/.claude-2`, expanded |
| macOS Keychain service (measured) | `Claude Code-credentials` | `Claude Code-credentials-<h>` |

**The Keychain names are MEASURED, not documented.** The docs only say that with
`CLAUDE_CONFIG_DIR` the CLI "keys the macOS Keychain entry to that directory too, so a session
with a different `CLAUDE_CONFIG_DIR` reads a different entry" (code.claude.com, authentication,
"Credential management"). The names in the table were measured on CLI 2.1.316 (`DESIGN.md`, "A
`CLAUDE_CONFIG_DIR` has its own Keychain item"). There, `<h>` is the first 8 hex digits of the
SHA-256 of the folder path exactly as passed. **Nothing in this design depends on those names.**
The build never computes, reads or writes a Claude Keychain item. The names are here only so a
person can recognize the items in Keychain Access, and a CLI that renames them changes nothing.

**The form rule.** The documented part is that the entry is keyed to the folder, and the
measurement shows the folder is taken as given. So the sign-in and every launch pass the identical
string: absolute, `$HOME` expanded by the shell, no `~`, no trailing slash, no symlinked parent.
Any other spelling may name another entry, and then the CLI says "not logged in" for a login that
exists. A record entry whose folder is not in that form is rejected, and Claude starts on login
A with a warning (section 2).

Login A stays where it is. Nothing is migrated: moving A into a folder of its own would mean
copying its grant (forbidden) or signing in again for no gain. A is chosen by launching with the
variable **unset**, never with `CLAUDE_CONFIG_DIR=$HOME/.claude`. A set variable keys a separate
entry, so pointing it at the default folder would name a third, empty login.

Further accounts, if ever needed, take the next number: `$HOME/.claude-3` and so on. A slot name
is never derived from an email.

## 2. How a switch chooses the login for new Claude launches

**One record, read at launch.** The record is `<app home>/claude-logins.json`. Only the panel
writes it, and the bot CLI reads it:

```json
{ "use": "2", "logins": [ { "id": "2", "dir": "/home/you/.claude-2" } ] }
```

- `use` is `"default"` (login A) or a listed `id`. The default login is implicit and never listed.
- The record lives at the app home's top level, not under `data/am-quota/`. The CLI reads it and
  am-quota ships switched off, so the CLI must not depend on another mod's private folder.
- A switch is one atomic write of `use` (`writeTextFile` with the snapshot it replaces). It
  touches no credential, so there is nothing to back up or put back.

**Claude launches only.** The CLI reads the record only when the agent it is about to start is
Claude Code (`agentKeyOfArgv`, or `templateAgent` for a template, gives `claude`). Codex and every
other agent never read it. A missing, corrupt or unreadable record can never stop, delay or warn
on a non-Claude launch, and the read sits in the Claude branch where its failure is caught.

**What the record does to a Claude launch:**

| Record | The Claude agent starts as |
|---|---|
| no file, or `use: "default"` | `/usr/bin/env -u CLAUDE_CONFIG_DIR PATH=… claude …` |
| `use: "<id>"`, its folder valid | `/usr/bin/env PATH=… CLAUDE_CONFIG_DIR=<dir> claude …` |
| corrupt or unreadable, unknown `id`, folder missing or not in the form rule | **on login A**, plus a warning |

**The choice for a bad record: login A with a visible warning, never a refusal.** A bad record
must not stop every Claude bot on the Mac. The cost is that a bot may run on the account the
person switched away from. That is recoverable, and a stopped fleet is not. The warning is in the
launch's own output ("claude-logins.json: <problem>; started on the default login"). The panel
shows it as one red line naming the problem and offers no switch until the record is fixed. The
CLI never repairs or rewrites the record.

**Every Claude launch route reads it,** at the moment of that launch:

| Route | Where its argv is built | How the login words go on |
|---|---|---|
| `am start` (`automagik-herdr` is an alias) | `startArgs` (`launchArgs.js`) | its `env` words, after `-u` when A |
| `restart` of a bot (and the panel's Restart, below) | `startArgs`, after `paneCommand` (`restart.js`) strips the old prefix | the same |
| `restart --tree`: each helper run again | `helperArgs` (`restart.js`), also printed by `byHand` | the same words before the helper's argv, or before `sh -c` for a template helper |
| a worker (`am worker`) | `workerArgs` (`workers.js`) | the same words, after `PATH=` |
| a **template** worker | `workerArgs` with `template`: today `hc run … <template> <task>`, which takes no environment | see below |
| the Accounts panel's background Restart | `cliRun` (`am-quota/main.js`) runs `am restart` in an hc terminal | none of its own: the CLI it runs reads the record. `CLI_ENV` never carries `CLAUDE_CONFIG_DIR` |

**Template workers.** `hc run <template>` takes no environment, so a template's pane would get
herdr-core's environment, whatever login that names. When `templateAgent` says a template runs
Claude, the build starts it the way Restart already re-runs a template pane:

- the template's `command` from `hc templates --json`, run as `/usr/bin/env <login words> sh -c
  <command>` with the task passed as hc passes it;
- the template label kept, so later restarts and listings still see a template worker.

If the template's command can't be read, the worker is refused with that reason, as it is today
for a template hc doesn't list. A template that does not run Claude starts unchanged.

`am/` carries byte-equal copies of the CLI files (`scripts/am-copies.mjs`), so `am` follows the
change with a resync. No route is changed elsewhere.

**Every place that parses a launch argv must learn `-u NAME`.** Each assumes the prefix is
`/usr/bin/env PATH=… NAME=value…`:

- `programAt` (`models.js`): it skips words starting with `-` after `env` and then expects
  `NAME=value`. With `env -u CLAUDE_CONFIG_DIR …` it stops at `CLAUDE_CONFIG_DIR` and takes that
  for the program, which is **wrong** and must be fixed in the build. Everything built on it reads
  launch argvs through it: `agentArgv`, `agentKeyOfArgv`, `withBriefing`, `briefingFileOf` and
  the model and flag readers in `models.js`.
- `paneCommand` (`restart.js`): it requires `argv[1]` to start with `PATH=` before it strips the
  prefix. An `-u` first would leave the prefix in, and Restart would run `env` as the agent.
- `restartPlan` and the helper plan (`restart.js`, around `paneCommand`): they take
  `agentKeyOfArgv(launch.argv)` of what `paneCommand` returns.
- The CLI's uses in `automagik-herdr.mjs` (`agentKeyOfArgv`/`unwrapKeep` on argvs at the restart,
  tree and seat checks), and the copies in `am/`.

Readers of `foreground.argv` (the process in front, after `env` has exec'd the agent) see no
prefix and are unaffected: `agentInForeground`, `unwrapKeep` on foreground, `briefing.mjs`, and
Pocket Link's `chat/find.js`. The build's tests feed every parser above both prefix forms.

Out of scope, by design:

- a `claude` typed into an ordinary terminal, an automation (`am-automations`), or a template run
  by hand with `hc run`: these get whatever environment they start in, which is login A unless
  something sets the variable;
- launches on linked machines (`--machine`) never get the login words: each host has one login;
- per-bot pinning to a login (not asked for).

Not used:
- `launchctl setenv`: it is machine-wide, reaches every app, and going back to A needs an unset
  that nothing guarantees;
- a `claude` wrapper on `PATH`;
- swapping folders by symlink: one rename away from two folders naming one entry.

## 3. Running bots

A running Claude process keeps the environment it started with: its folder, its credential and its
account. It refreshes its own grant where its login keeps it. Nothing the switch does can sign it
out.

After a switch, the banner lists the Claude bots on another login than the one now chosen and
offers **Restart N bots** through the existing restart flow (#433). A pane's login comes from its
**launch** argv (`hc get`'s `argv`, not `foreground.argv`), by **value**: the word
`CLAUDE_CONFIG_DIR=<dir>` names login `<dir>`. Panes on login A also carry `CLAUDE_CONFIG_DIR`, as
the pair `-u CLAUDE_CONFIG_DIR`, so the presence of the name says nothing. Only an assignment's
value names B, and `-u` names A.

| Launch argv | Login |
|---|---|
| `CLAUDE_CONFIG_DIR=<dir>` with `<dir>` equal to a listed folder | that login |
| `CLAUDE_CONFIG_DIR=<dir>`, not a listed folder | "unknown login", listed with its folder |
| `-u CLAUDE_CONFIG_DIR` | login A |
| neither (started before the build, or outside the pack) | "started before logins were tracked", listed with that reason |
| no argv from hc | listed with that reason |

This replaces the `since` (start time) split for Claude.

Each restart resumes its conversation under the new login, because the transcripts are shared
(section 4). If resuming fails, the bot starts a new conversation and goes into the banner's
existing "Started on a new conversation" list.

## 4. Settings, MCP config and history across the two folders

For each item in `~/.claude`, the test is one question: **does the account own or sync it, or
does the person own it on this Mac?** What the account owns stays per login. What the person owns
here is linked from B into A's folder, but only where something needs it shared. The docs say that
with `CLAUDE_CONFIG_DIR` "every `~/.claude` path … lives under that directory instead. The same
applies to `.claude.json`" (code.claude.com, "Explore the .claude directory").

**Shared, by symlink from `$HOME/.claude-2` into `~/.claude`:**

| Item | Why shared |
|---|---|
| `projects/` | Transcripts and per-folder memory, kept by folder on this Mac, not by account. Resume needs it: `--resume <id>` searches the active folder's projects. So does the chat projection: `transcriptFolder.mjs` and Pocket Link's `chat/folder-rule.js` accept only a real path inside `~/.claude/projects`, and B's transcripts resolve there through the link. |
| `file-history/` | File checkpoints, kept by session id. They go with `projects/`, so a resumed session keeps its rewind points. |
| `settings.json` | The person's own settings on this Mac (hooks, status line, permissions). No account sync is documented. Section 5 checks it for anything that would override the switch. |
| `CLAUDE.md` | The person's own instructions on this Mac. No account sync is documented. |
| `agents/`, `commands/` | Files the person wrote on this Mac. No account sync is documented. If the build finds the CLI syncs either one per account, it moves to the per-login list. |

**Per login, never shared:**

| Item | Why |
|---|---|
| the credential | Each folder has its own entry, and no `.credentials.json` may exist in either folder. |
| `.claude.json` | The account record (who is signed in), onboarding, folder trust, and the user-scope MCP servers (`claude mcp add --scope user` writes there). Linking it would label B's grant with A's account. |
| `skills/`, `plugins/` | Each account syncs its own. A shared folder would mix the two accounts' copies. `enabledPlugins` in the shared `settings.json` may then name a plugin B hasn't installed. The CLI handles that as for any missing plugin, and B installs its own. |
| MCP OAuth sign-ins | Kept with the login, so each login authorizes an MCP server on its own. That keeps those grants out of two places as well. |
| `history.jsonl` | Prompt recall. Nothing in the pack needs it shared, so it stays per login. |
| anything else the CLI creates in B | Caches and session state, kept as B's own. |

User-scope MCP servers are therefore per login. Add one to both logins, or keep it project-scoped
in the repository's `.mcp.json`, which both logins read.

**Known cost of B's fresh `.claude.json`:** the first `claude` run under B can show onboarding,
and the first launch in each project folder can ask whether to trust it. A bot pane stopped on
that question looks stuck. The build pre-answers nothing: the panel says, on each other login's
row, "The first launch under login 2 needs one answer in its pane". **UNVERIFIED:** that the
question appears, and that one answer per folder is all it takes.

**To verify, on scratch folders (no sign-in needed).** The build ran no real `claude`, so each is
still open; the panel's PR carries the commands:
- **UNVERIFIED:** `.claude.json` is created inside `CLAUDE_CONFIG_DIR`;
- **UNVERIFIED:** resume follows the `projects` link;
- **UNVERIFIED:** the CLI does not replace a linked `settings.json` or `CLAUDE.md` with a real file by
  rename (the panel names one that did, below);
- **UNVERIFIED:** `claude auth status` reports a `CLAUDE_CONFIG_DIR` set in settings `env` through
  `configDirectory` (section 5).

The linked folders are safe from this, because a rename inside a linked folder lands in the real
folder. Only the two linked files are exposed. The panel checks both, and names a link that
turned into a file ("settings.json in login 2 is no longer shared", or the same for
`CLAUDE.md`). It never repairs the link by copying.

The docs' caveat about keeping Console sign-ins apart across folders applies to Console sign-ins
without an API key. It does not apply to claude.ai logins, which is what both of these are.

## 5. When settings or the environment override the switch

The choice of folder can be beaten in two ways:
- **the folder itself is moved:** a `CLAUDE_CONFIG_DIR` set by user settings (`env` in
  `settings.json`), by managed settings, or by the environment the pane starts in;
- **the credential is beaten:** a credential variable or helper outranks a sign-in. Examples are
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `apiKeyHelper`, and a
  third-party provider switch. Each can come from the environment, user settings or managed
  settings.

**How the build detects it:** per login, the panel runs `claude auth status` in that login's own
launch environment, through exec, with the same `-u` or assignment words a launch would get. It
runs the claude a launch would run, with the PATH a launch gives its pane: the CLI says where
(`am launch-path claude`). Each check is bounded at 10 s, and the logins are looked
at side by side, one round at a time. A login whose check didn't answer says so and gets no **Use**. That
the CLI applies every settings layer before it answers is **inferred**, not documented. The
build's scratch-folder checks (section 4) confirm it. Its JSON carries `configDirectory` and
`authMethod`. Only those two fields and the account's identity are read; the rest of the output
is ignored and never logged.
- **UNVERIFIED:** the CLI applies every settings layer before it answers (the scratch check above).
- **UNVERIFIED:** `claude auth status` prints JSON with `loggedIn`, `email`, `authMethod` and
  `configDirectory`, and exits 1 when not signed in. Output the panel can't read gives "claude auth
  status gave no answer the panel can read" and no **Use**, never a guess.
- **UNVERIFIED:** what `authMethod` says for an API key, a token variable or a third-party provider.
  The panel reads its words (`key`, `token`, a provider's name); anything else but `claude.ai` is
  named as it is, and the login gets no **Use**.

**What the panel shows:**
- `configDirectory` differs from the login's folder: one red line, "settings move login 2 to
  another folder: switching can't choose it". The login gets no **Use** button.
- `authMethod` is not `claude.ai`: one amber line naming the method in plain words ("an API key
  outranks this sign-in", "a token variable outranks this sign-in", "a third-party provider is
  set"). The login gets no **Use** button, and quota for it reads "not this sign-in's".
- A credential variable present in Herdr's own environment: the panel tests whether it is set
  (`printenv NAME >/dev/null`), never its value, and says which one is set.

**Gap, stated:** panes start in herdr-core's environment, which can differ from Herdr's. A
variable set only there is not seen by the panel's check. The launch's own output (the CLI's
warning, section 2) is where such a case shows first.

## 6. What the panel shows

The Claude card lists **the logins signed in on this Mac**, not the proxy's accounts.

- **Who each login is:** `claude auth status` as in section 5, read-only. It exits 1 when the
  login is not signed in, and no token is printed or seen. If its JSON carries no email, the
  email comes from that folder's `.claude.json` account record, as a last resort. That file can
  hold secrets elsewhere (an MCP server's `env`), so the panel takes the one email field and never
  logs, shows or keeps the rest. Read on open, after a switch, on ↻, and at most every five
  minutes. **UNVERIFIED:** the field is `oauthAccount.emailAddress`.
- **Rows:** one per login, shown by email.
  - Each row is matched by email to the proxy's quota rows, for the bar and the policy's
    projection. `policy.choose` runs over the local logins only.
  - The login in `use` gets the pill, and the others get **Use**.
  - A login the proxy doesn't list reads "usage not tracked".
  - A login that is not signed in reads **Sign in again**, with the command and no button.
- **A proxy account with no login on this Mac** is listed under "On your CLIProxyAPI, not signed
  in here", with the sign-in steps for a new slot and **no** button. It can never be installed.
- **Gone:**
  - "changed outside this panel" and "no longer installed", the fingerprint badge for Claude.
    Claude's refresh token rotates on every CLI refresh, so that badge could only mislead;
  - the banner line "This Mac now shares that sign-in with <proxy>": nothing is shared.

## 7. Adding or removing an account

**Add** (by hand; the panel shows the steps and never runs them):

1. Make the next slot's folder and its links, as in "The second sign-in" below.
2. Sign in from a terminal.
3. Press **Add login** in the panel. It records `{id, dir}` after checking the form rule and that
   `claude auth status` says signed in. The panel offers the next free slot, `$HOME/.claude-<n>`.

**Remove:**

1. If the login is the one in `use`, switch to another first. The panel offers no **Remove** on the
   login in use, and refuses while the login is still signed in (step 3 first).
2. Restart or stop the bots still on it. The panel refuses while a pane's launch argv names its
   folder by value (every live pane `hc ls` lists; a trailing slash or a link spelling the same
   folder counts), or names an unmatched folder under the home folder, because a logout ends their
   sign-in.
3. In a terminal, run `CLAUDE_CONFIG_DIR="$HOME/.claude-<n>" claude auth logout`. The CLI removes
   its own credential; the panel does not touch the Keychain. At the press of **Remove**, the
   panel asks `claude auth status` of that login again and goes ahead only when its JSON says
   `loggedIn: false`; a crash, output it can't read or no answer refuses, saying so.
4. Press **Remove login** in the panel to drop the record.

Deleting the folder is optional and done by hand. `rm` on a link removes the link, never
`~/.claude`'s files. B's transcripts were always in A's folder through the `projects` link, and
they stay there.

Login A is never removed through the panel.

## 8. What the proxy is still used for

For Claude, the proxy is used to read quota and nothing else: `…/v1/quotas` and the credential
listing's emails, to draw each local login's bar and run the projection.

- Quota belongs to the account, not the grant. So the proxy's own sign-in to an account, a
  separate grant made on the proxy, reports the same windows the Mac's login spends.
- The Claude path never calls `…/credentials/download`. The build adds a test that fails if it
  does.
- The 00:09Z failure cannot recur: the proxy's grant and the Mac's are different chains.

## 9. What leaves today's Claude switch

From `am-quota`, in the build PR (Codex untouched):

- the Claude download and install: `install()`/`place()` for `provider: "claude"`, `toClaude`,
  the Claude rule in `problems()`, and the Keychain and file target in `TARGETS.claude`;
- every Claude Keychain path: `keychainScript`, `keychainBackupScript`, `keychainRestoreScript`,
  `keychainReadScript`, `keychainService`, `mergeCredentialItem`, `KEYCHAIN_BYTES`, the backup and
  put-back logic in `switch.js`, and the profile `.credentials.json` write;
- `readIdentity` and `installedIdentity` for Claude;
- the shared-sign-in banner line, and the refresh-token sections of `DESIGN.md` and `RECIPE.md`;
- the Claude cases in the `am-quota-switch` and `am-quota-translate` tests. They are replaced by
  tests showing that the Claude path never reaches `security` or the download, using a shim that
  fails the test if it is called;
- the `claude` entry in `active.json`: ignored on read, dropped at the next write.

Kept:
- `sweepScript`, which also removes any `keychain-claude-*.hex` an interrupted old switch left;
- `itemText` and `hexToUtf8`, for the Codex identity;
- the whole restart flow.

Nothing is deleted from the Keychain by the build. Login A's item now holds the person's own
sign-in: the copy the old panel put there was replaced by a sign-in on 2026-11-06. An
`am-quota saved: …` item from older versions stays until removed by hand, as `DESIGN.md` already
says.

## 10. Rollback

- **Before the build:** nothing to roll back. Login B is an ordinary sign-in, and step 3 of
  "Remove" undoes it.
- **After the build, if new launches misbehave:** set `use` to `"default"`, or delete
  `claude-logins.json`. Every new Claude launch is then on login A, as today. Running bots keep
  their login until restarted.
- **If the CLI change itself is broken:** ship a fix-forward herdr patch that makes the CLI skip
  the record, so Claude launches with `-u CLAUDE_CONFIG_DIR` and nothing else changes. The pack
  never downgrades through its pointer (AGENTS.md), so a rollback is a new release, not an older
  version.
- **A rollback never brings back the proxy-to-Keychain write.** Reverting the build PR whole
  would reintroduce the Claude install. A revert keeps section 9's removals and reverts only the
  launch change.
- In no case does anything in the Keychain need restoring, because the panel never wrote it.

## The second sign-in (the Mac, before the build)

This can happen now. It creates login B and changes nothing for login A or for running bots.

**Before anything:** do not press Switch or Use on the Accounts panel's Claude card until the build ships. Work in Terminal on the Mac's own desktop, not over ssh and not in an hc terminal. In the Mac's default browser, open claude.ai and make sure it is signed in to the second account, signing the other account out there if needed.

**Step 1.** Make the folder and the links. Paste this as one block:

```sh
D="$HOME/.claude-2"; printf '%s\n' "$D"
if [ -e "$D" ]; then echo "STOP: $D already exists"; else mkdir -m 700 "$D" && for f in projects file-history settings.json CLAUDE.md agents commands; do if [ -e "$HOME/.claude/$f" ]; then ln -s "$HOME/.claude/$f" "$D/$f"; else echo "skipped $f, not in ~/.claude"; fi; done; ls -la "$D"; fi
```

Check the output:
- The first line must start with `/Users/` and must not end in `/`.
- If it printed `STOP`, do not go on. Ask first.
- Otherwise, the listing should show only links, and only to `~/.claude`.

**Step 2.** Sign in. Paste this only after step 1 went well, with the second account's address in place of `SECOND_ACCOUNT_EMAIL`. Finish the sign-in in the browser.

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-2" claude auth login --email 'SECOND_ACCOUNT_EMAIL'
```

**Step 3.** Check both logins. Both commands are read-only.

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-2" claude auth status
claude auth status
```

What to expect:
- The first should show `configDirectory` as the new folder and `authMethod` as `claude.ai`.
- The second is login A, unchanged.

**Afterwards:**
- Do not copy `~/.claude`.
- Do not link `.claude.json`, `skills` or `plugins`.
- Do not set `CLAUDE_CONFIG_DIR` in a shell profile.
- Do not start Claude sessions under the second login until the build ships.

## Acceptance for the build (from #453)

- A Claude switch changes only `use`. A test with a `security` shim and a fake proxy proves the
  Claude path makes no Keychain call and no credential download.
- Every route in section 2 (start, restart, `--tree` helpers, workers, template workers, the
  panel's Restart) puts `-u CLAUDE_CONFIG_DIR` or `CLAUDE_CONFIG_DIR=<dir>` on, per the record.
- A bad record starts Claude on login A with the warning. Codex and other agents never read the
  record. Tests use temp homes only.
- Every launch-argv parser in section 2 reads both prefix forms; `programAt` is fixed.
- The banner matches panes to logins by value.
- Settings or environment overrides are shown as in section 5.
- The panel lists local logins, matches quota by email, and offers no button for a proxy account
  without a local login.
- No emails, usernames or machine names in code, tests or docs.
