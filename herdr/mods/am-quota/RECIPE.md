# am-quota

**Accounts** keeps your bots working when a plan hits its limit: it shows how long the Claude
Code or Codex account this computer uses will last, and moves the tool to another account on your
own CLIProxyAPI before it runs out. A personal tool for people who run one; Codex accounts are
added on the proxy (sign in there), never on this computer.

**Claude is not switched from the proxy any more (#453).** Copying a proxy login into the Mac's
Keychain made the proxy and the Mac sign each other out, and the switch would overwrite the Mac's
own sign-in. The Claude card lists the Claude logins signed in on this Mac, each by its own
`claude auth login` (`docs/local-logins.md`), and **Use** picks which one new Claude launches get:
one write of `<app home>/claude-logins.json`, which this panel alone writes and the bot CLI reads at
each Claude launch. The proxy only gives each login's usage, matched by email. Nothing here reads,
writes or deletes a Claude Keychain item or credential, runs a sign-in, or downloads a Claude
credential.

CLIProxyAPI: <https://github.com/router-for-me/CLIProxyAPI>.

**It ships switched off**, footer tab included: a fresh install puts it in
`<app home>/mods-disabled/am-quota`, where Herdr does not load it. To turn it on, open the **Mods**
panel (the puzzle tab in the footer), find *Automagik Accounts* and switch it on; the footer's
**Accounts** tab then appears and opens the panel. Switching it off again hides both. An install that
already has it keeps its state through updates, on or off (`OFF_BY_DEFAULT` in
`am-sidebar/release.js`; `am install herdr.am-quota` also switches it on).

## Setup

The panel reads two files and does not create either of them:

- **`~/.config/herdr-app/cliproxy.json`** (or `$HERDR_APP_HOME/cliproxy.json` when that variable
  moves the app home):

  ```json
  { "url": "https://proxy.example.com", "name": "lab" }
  ```

  `url` is the CLIProxyAPI base URL, `https` (plain `http` is accepted only for `localhost` /
  `127.0.0.1`). No trailing slash needed; a path prefix is fine. `name` is optional: what the panel
  calls your proxy ("Accounts come from your CLIProxyAPI, lab"). Without it the panel uses the
  URL's host.
- **`~/.config/cliproxyapi/mgmt.key`** — the management key as plain text, one line, mode `0600`:

  ```sh
  install -m 600 /dev/null ~/.config/cliproxyapi/mgmt.key
  printf '%s\n' '<the management key>' > ~/.config/cliproxyapi/mgmt.key
  ```

  Or set **`CLIPROXY_MGMT_KEY`** in the environment Herdr itself runs in; the variable wins over the
  file. The key is only ever read — it is not written to a log, a notify, shared state or a command
  line.

Without `cliproxy.json` the panel says what it is for and how to set it up, and reads nothing.

## What you see

A card filling its block: **Accounts**, "Keeps your bots working when a plan hits its limit" and
`↻`; a **Claude Code / Codex** switch, one tool at a time, each with a dot (green: the account in
use lasts until it resets; amber: it is running out or can't be used; grey: not managed or not
tracked). For the tool picked, in order:

1. **The account in use on this computer**, as `email · plan` (Claude's listing has no plan, so its
   accounts show the email alone), never the credential's file name. A pill (`In use`, `Running
   out`, `Can't be used`), its window bar and `N% used of this week · resets Thu 09:00`, and one
   sentence: **Lasts until it resets**, or **At this pace it runs out in about N h, before it
   resets** (policy's projection; for the first minute, before there are two readings, it says it
   is measuring the pace).
2. **One button when the policy says switch** (Codex): `Switch to <email>`, with the reason underneath
   (`12% used · resets in 6 h · resets soonest, so none of its hours go to waste`). Bots already
   running stay on the old account until restarted; the panel offers that right after the switch.
3. **The tool's other accounts on the proxy**: `email · plan`, a bar, `N% used`, the reset, a
   **Switch** button (Codex), and `next` on the one the rule would move to next. An account the quota
   extension reports no window for says **usage not tracked** and has no bar; one that needs a new
   sign-in or is disabled says so and has no button.
4. A footer: "Accounts come from your CLIProxyAPI, <name>. To add one, sign in to it there." and
   **Open <name>**, which opens the proxy's base URL (without userinfo or query) in the browser.

**Claude Code** (#453, `docs/local-logins.md` sections 2 to 7) is the same card over the logins on
this Mac instead of the proxy's accounts: the login new launches use, then one row per login by
email, with its usage from the proxy account of that email ("usage not tracked" when there is
none), **Use** on another signed-in login, and **Remove** on one not in use. A login that is not
signed in shows **Sign in again** and the command, never a button that runs it. Settings or a
variable that outranks a login, and a linked `settings.json` or `CLAUDE.md` that became a file of its
own, are said on its row. A proxy account with no login here is listed under "On your CLIProxyAPI,
not signed in here" with no button. **Add login <n>** records the next slot once its folder and
sign-in, made by hand, check out. A `claude-logins.json` that launches can't follow is one red line
naming the problem, and nothing is offered until it is fixed. After **Use**, the banner lists the
Claude bots whose launch argv names another login, by value, with **Restart N bots**.

**Not managed**: when no account is recorded for the tool, or the login on this computer changed
since the panel installed it, or the recorded account is no longer on the proxy, the card says so
(`No account from <name>`, `Changed outside this panel`, …) with a grey `Not managed` pill, and the
button reads `Use <email>`: the account the rule would pick.

**Just switched**: a banner, "<tool> is now on <email>", then the bots still on the old account and
**Restart N bots** (see *After a switch*). `×` closes it.

Colours are semantic only: green lasts, amber runs out; a suggestion is the one accent button,
never red. Red is kept for errors (a failed read or switch).

## How it behaves

- **Reading**: `cliproxy.json`'s `url` + `$CLIPROXY_MGMT_KEY` or `~/.config/cliproxyapi/mgmt.key`
  make the client; then `…/v1/quotas` joined with `/v8/management/credentials` (`proxy.js`).
  Refresh on open, every 60 s while the panel is drawn, and on `↻`. A poll that a newer one has
  overtaken is dropped, and a hidden panel does not poll. The management key rides only in the
  `Authorization` header.
- **Deciding**: `policy.choose` per provider, with this panel's record of what it installed as the
  active account (none while the tool is not managed: the verdict is then the account to start on). The burn rate comes from the last two polls (`prev` per account and window, dropped
  when the window resets). Projected exhaustion before the reset, the soonest-resetting account with
  headroom wins, near-reset (15 min) held, no reserve, providers never mix, fixed tie-break.
  One switch at a time: a second click while one runs is refused.
- **Switching** (`Switch` or `Use`): `GET …/credentials/download?name=<file>` → translate → write:
  - Codex: `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`; `OPENAI_API_KEY: null`,
    `auth_mode: "chatgpt"`, `last_refresh`, `tokens{…}`), previous file kept as
    `auth.json.bak-<stamp>`;
  - Claude: nothing. A Claude login is never downloaded or installed (#453); its **Use** writes
    only `claude-logins.json`'s `use`, with the snapshot it replaces.
  Written through `sh`: the payload lives in a `0700` folder, is `0600`d the moment it exists, and
  becomes the real file by `mv` (atomic rename); the token is read from a file by the shell, so it
  never appears in `argv`, a log, a notify, shared state or an error message. Backups are pruned to
  the three newest. The scratch file is deleted afterwards, success or failure.
- A failed `active.json` write is shown as an error.
- **After a switch**: the panel records `<provider> → <credential name + token fingerprint>` in
  `data/am-quota/active.json` (an older record naming a saved login, `saved:<name>`, reads as not
  managed, and a `claude` entry an older version wrote is ignored and dropped at the next write). New client runs use the new account; ones already running keep the old one — that is
  the client's behaviour, not a defect. So the banner lists the bots still on the old account:
  `am ls --all --json` (run as the sidebar runs it, through
  `mods/am-sidebar/bin/run.sh`), the running bots whose agent is that tool and whose pane started
  (`since`) before the switch. If any of them has no start time the panel can't split them
  reliably: it lists every running bot of that tool and says so. **Restart N bots** asks for a
  second press within five seconds, then runs `am restart <bot> --project <project>`
  for each, one at a time (each resumes its conversation), each in an hc terminal of its own
  rather than through Herdr's `exec`, so Herdr's 30 s limit on a mod's programs can't end a
  restart part-way. The panel follows that terminal to its end, reads what the CLI answered, and
  names any bot it refused, with the
  CLI's reason: a new pane that exited before its agent was up says what its agent printed last
  (codex's `modelProviderNotConfigured`, say). A Codex thread codex refuses with
  `modelProviderNotConfigured` can't be resumed: that bot starts on a new conversation, listed with
  the old thread's id. A bot mid-turn is
  refused rather than forced and shown as busy, with **Restart <bot> when idle**: one `hc wait` at
  a time on its pane, a few at most, then one restart once its pane is done or idle. How long that
  can run depends on Herdr: released versions cut each wait at 30 s, about 2 minutes in all; one
  with `exec`'s `timeout` waits up to 30 minutes. If it gives up, the panel says how long it
  really waited. A bot with helpers that would end with its pane needs no second press: once its
  helpers are done or idle the panel restarts it with them, waiting first for any still working
  (those panes only, the same way) and reading them all again just before the restart. A pane or
  helper waiting for an answer, a pane gone, one hc can't read, a helper in error or with helpers
  of its own, or a helper with an agent that reports no status: no restart, and the bot stays
  listed with why. A plain program reports no status and doesn't hold the restart up. Pressing the button while it waits cancels;
  the panel keeps the wait in memory only, so a reload drops it. Any number of helpers restart
  this way. A restart whose terminal ends or goes with no answer says it may have stopped part-way
  and what to check; one still running after about 5 minutes (40 s more per helper) is named with
  its terminal, and pressing again starts no second restart of that bot while it runs. The
  restart's terminal (labelled `am-quota.restart=<bot>`, removed by hc once it ends) leaves its
  answer in `data/am-quota/runs/` of the app home; files there older than a day go at the next
  restart. That terminal starts in herdr-core's environment, so the CLI gets Herdr's own `PATH`,
  `HOME`, `NVM_DIR`, `VIRTUAL_ENV` and `HERMES_HOME`, and finds node and the agents as it did
  before. The panel never names a CLI flag:
  a refusal is shown without the clause that offers one. Without the sidebar mod there is no CLI: the banner says to run
  `am restart <bot>` instead.

## Built from

`main.js` (the panel, drawing what `view.js` says), `view.js` (each tool's card, the proxy's
name and the bots a switch left behind, as plain data; pure), `policy.js` (the decision, pure), `proxy.js` (the reader and the per-window
samples, pure), `translate.js` (Codex's proxy credential → its `auth.json`, fingerprints; pure),
`write.js` (the shell that writes; pure),
`switch.js` (the install flow, with its shell and files injected so it is tested end to end),
`lock.js` (one switch at a time), `mod.json` (`place: none`), `LICENSE`, `DESIGN.md` (endpoints,
writers, secret rules), and tests for every module in the repository's `test/`.

Herdr API: `exec`, `theme`, `appHome`, `home`, `readTextFile`, `writeTextFile`, `window`,
`fs/promises`; the runtime's `fetch`. Programs: `sh`, `open` (`xdg-open` on Linux) for Open, and
the sidebar's `bin/automagik-herdr` launcher, the file behind `am` (`automagik-herdr` still works as an alias). Never `security`.

## Watch out

- **It writes real Codex credentials.** That is its purpose; the old file is always kept as a dated
  backup, and no token is ever logged. A
  switch affects **new** client runs only.
- **`login status` / `auth status` are shallow** — a garbage token reported "logged in". The panel
  therefore reports what it *wrote*, not that the account *works*; a verification request is a
  separate, quota-spending action, and is not wired yet.
- Codex's `auth.json` expects a nested `tokens` object while the proxy's file is flat; `translate.js`
  is the only place that knows the mapping, and the tests pin it.
- `CODEX_HOME` is honoured: the panel writes where Codex would read.
- A provider with no window is shown but never suggested (nothing to project).
- The proxy's quota extension (`cpa-quota-api-extension`) supplies the windows, Claude's
  (`seven_day`) as well as Codex's; without it the panel still lists accounts, each reading `usage
  not tracked`, with an amber line saying the proxy sent no usage and no advice. No bar is faked.

## Done when

`herdr-app check mods/am-quota` passes; the panel lists both providers' accounts with their windows;
a Codex Switch rewrites its file with a backup and a 0600 permission, and the next `codex` run is
on the chosen account; the Claude card lists this Mac's logins and its Use changes only `claude-logins.json`; the banner names the bots still on the old one and Restart moves them; no token
appears in any log, notify or state.
