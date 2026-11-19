# RFC 0030: Code mode inside the Automagik app

| Field | Value |
|---|---|
| Status | In delivery (accepted by the owner's delegate on 2026-11-19, issue #1007; Q1-Q14 answered with this RFC's own recommendations, see Answers; merged: delivery 4's selector (#1025, issue #1016), delivery 1's desktop half (#1391), delivery 2's typing (#1394); delivery 0 waits only on the owner's approval of RFC 0022's revision; owner's direction 2026-11-10; replaces RFC 0013's D27; amends RFC 0003's live switching at a harness change; Decided 10 (the route) by the owner 2026-11-10) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none here (docs); plugin (3.N.P) for bots-dsh; desktop (3.N) only if the preload must change; the server image; herdr (3.N.P) for the pack's fix-only period, the `am mailbox send` verb (the pack's CLI is its source; `am/` gets it as a byte copy) and the retirement notice; am (3.N.P) for those copies |
| Created | 2026-11-10 |
| Replaces | [RFC 0013](0013-work-code-switch.md)'s D27 ("Code is the real herdr-app window, glue only") |
| Builds on | [RFC 0022](0022-desktop-chat-view.md)'s 2026-11-10 revision (merged in #1009, still Proposed there: Team and Code, the left bar, humanized bots); [RFC 0028](0028-code-workers.md) (merged in #1008: Code workers); [RFC 0023](0023-dsh-upstream-agent-context-and-chat-rows.md) (the session terminal field) |

## Summary

Automagik's Code side stops being a second application. Today Code is herdr-app, a separate
window that RFC 0013 brings forward from a Work / Code switch, dressed by the Automagik Herdr
pack's mods. After this RFC, the Automagik app draws Code itself: in Code mode its left menu lists
the coding team and its right pane renders that team's herdr-core terminals, in the desktop app
and in a browser alike. herdr-core stays the backend for terminals and terminal orchestration,
with `am` as today. The pack's sidebar and mods become parts of a DSH plugin, then the pack is
retired.

The owner decided the direction (Decided, copied from the issue). This RFC answers each design
point the issue lists with a recommendation, names where it meets the two RFCs it builds on (RFC
0028, #1008, and RFC 0022's revision, #1009, both open pull requests when it was written), and
lists the real conflicts as questions; all were answered on 2026-11-19 (Answers).

## Motivation

- **Two applications cost twice.** The Code side today is a Herdr window plus ten mods in
  `herdr/mods/` (`am-sidebar`, `am-automations`, `am-quota`, `am-footer`, `am-tabs`,
  `am-new-menu`, `am-status`, `am-markdown`, `am-mods`, and Pocket's `pocket-link`), each with
  its own UI written against Herdr's mod runtime, beside the Bot team's own sidebar in
  `apps/bots-dsh/src/client/sidebar.js`. The owner will not keep two applications.
- **D27 was a cost call, not a technical wall.** RFC 0013 rejected one window because it meant
  rebuilding Herdr's UI (Alternatives, "code mode lite"). The spike it cites drew live xterm.js
  terminals on herdr-core's attach stream inside the Electron window with a key-to-echo p50 of
  0.6 ms and about 8 MB/s; what made it expensive was rebuilding herdr-app's spaces, tabs, splits,
  layouts and every mod. This RFC keeps the cheap half (terminals on herdr-core) and drops the
  expensive half (Herdr's window model): the app draws a team tree and terminals, not Herdr.
- **The container image has no window.** Automagik ships as one container image as well as the
  desktop app (Decided 9). Today's image (`server/Dockerfile`, the automagik-web profile) carries
  no herdr-core and no herdr-app, so Code does not exist there at all. A Code mode drawn by a DSH
  plugin works in a browser the same way it works in Electron.
- **The pieces exist.** herdr-core already serves terminals to clients other than herdr-app:
  Pocket attaches to them (`CoreClient.kt` and `TerminalScreen.kt` in
  `apps/pocket/android/app/src/main/java/ai/namastex/automagik/`). The welcome already ships
  xterm.js (`@xterm/xterm` 6.0.0 in `apps/welcome-dsh/package.json`, drawn in
  `apps/welcome-dsh/src/client/terminal.js`). The team's
  state is already in files the pack and `am` share: the attach ledger
  (`herdr/mods/am-sidebar/attach.js`, `<app home>/automagik-herdr/attach.jsonl`), the workers
  ledger (`herdr/mods/am-sidebar/workers.js`, `<app home>/automagik-herdr/workers.jsonl`) and the
  Bot registry (`apps/bots-dsh/src/shared/registry.js`, RFC 0014). The bar that lists it is
  already designed as a model in RFC 0022's revision (i).

## Decided

Copied word for word from issue #1007, "Decided by the owner" (2026-11-10 brainstorm):

1. **Four bot types.**
   - **Automagik**: DSH harness. A model the person has no API key for runs through ACP.
   - **Omni**: DSH harness, same rule.
   - **DSH**: raw DSH with no Automagik makeup, any model DSH supports, native harness only.
   - **Genie**: the coding type. A human-facing bot in Work, and a hidden team working on herdr-core.
2. **Native DSH runs other models too** once the person adds an API key. ACP is the route for a model
   used through that agent's own sign-in.
3. **Genie is two seats.** The human-facing bot runs on DSH and talks only to the person. A hidden
   orchestrator in a herdr-core terminal takes the team's reports and merge questions. Only answers to
   the bot's own requests and questions for the person cross into the person's chat.
4. **The flip.** In Code mode the left menu becomes the coding team and the right pane renders their
   herdr-core terminals, inside the Automagik app. The human-facing bot's pane is the real DSH chat in
   both modes. Every other seat keeps its agent's own native terminal (native Claude Code stays as it is).
5. **No Automagik TUI.** dsh-tui is not reworked into a parity TUI.
6. **Harness change = new conversation with a handoff note.** No history is carried across harnesses.
7. **The model selector is harness first, then model**, so the person sees a cross-harness choice. The
   owner has a mockup for this that was never applied (to be attached).
8. **One application.** The pack's sidebar and mods move into DSH plugins. herdr-core stays as the
   backend for terminals and terminal orchestration, with the `am` command line as today.
9. **Automagik ships as one container image** as well as the desktop app, so Code mode must work in a
   browser with no desktop window.

Decided by the owner after the issue was filed, 2026-11-10 (issue #1007's comment "the selector's
first level is the route", relayed by the orchestrator):

10. **The selector's first level is the route**, in this order: **Native** (the DSH harness, with
    every model DSH supports, other providers once an API key is added); **ACP** (every supported
    ACP agent as a choice: Claude Code, Codex, Hermes, Antigravity, omp and any added later, each
    with its own models); **Herdr** (the agent's own native terminal on herdr-core). The model
    comes second, listed under the chosen route. Changing the route is the cross-harness move: it
    starts a new conversation with a handoff note (Decided 6), and the selector says so before the
    person confirms. Changing only the model inside a route does not.

## Words

RFC 0028 (#1008) fixes three senses of "Code". This RFC changes the first two, because the
owner's Decided 4 and 9 use "Code mode" for the whole app's Code side:

| Word | Meaning after this RFC | Before |
|---|---|---|
| **Code** | The coding side of the Automagik app: the team tree on the left, terminals on the right | herdr-app, opened from the Code card (RFC 0013) |
| **Code mode** | The app while it shows its Code side (the owner's words, Decided 4 and 9) | RFC 0022's switch of one chat pane to xterm on the same terminal; this RFC calls that the **terminal face** (RFC 0022 Decided 2's own heading) |
| **Code worker** | A terminal a Bot started through RFC 0028's tools, unchanged | unchanged |
| **The flip** | Switching the app between Team (RFC 0022 (h); "Work" in the issue) and Code | the Work / Code switch raising herdr-app |
| **Route** | The selector's first level: Native, ACP or Herdr (Decided 10) | "connection" in today's model menu |
| **Harness** | What runs the conversation: DSH on the Native route, one agent on the ACP or Herdr route | "connection" in today's model menu |

RFC 0028's Words table and RFC 0022's use of "Code mode" need the same change; see Q9.

## Design

### Where it lives

One plugin, the Bot team (`apps/bots-dsh`), because it already owns the left bar, the Work /
Code switch (`apps/bots-dsh/src/client/work-code-switch.js`) and, after RFC 0022, the live-chat
engine copy (`apps/bots-dsh/src/host/live-chat/`). Its host gets one new part, the **core
bridge**: the only code in Automagik that attaches to herdr-core terminals for a person to see.
The Genie bot type itself stays the Genie plugin's (`genie-dsh`, from the public Genie
repository, `apps/welcome-dsh/package.json`; one Genie per repository, `client/genie-new.js`);
the tree and the terminals are the Bot team's, so every bot type shares them.
The page never talks to herdr-core directly, in Electron or in a browser, so both run one code
path.

The core bridge follows RFC 0022 (f) and RFC 0028's grant rules:

- It serves the window that shows Code mode, and nothing else: no tool, automation or Bot reaches
  it (RFC 0022 (f)). It is not RFC 0028's grant and holds none of that grant's credential.
- It does not read the mailbox. That is a separate host part, the **mailbox follower** (below),
  which attaches to no terminal and so needs no window.
- It reaches this computer's herdr-core only, until RFC 0022's delivery H scopes a machine link
  (RFC 0022 (k)). In the image it reaches the image's own herdr-core.
- In a browser it is reachable only behind RFC 0024 delivery 2's gate (the claim and passkeys),
  the same condition RFC 0022 (l) sets for any seat shown on an instance.

### Terminal renderer

**Recommended:** xterm.js, the pinned `@xterm/xterm` the welcome already ships, in the page; the
core bridge in the host attaches to herdr-core and relays the stream to the page over the
plugin's own route.

| Concern | Recommendation |
|---|---|
| **Attach** | One herdr-core attach per terminal on screen, opened by the core bridge when the terminal is shown and closed when it leaves the screen. A terminal off screen keeps no attach: its row's status comes from herdr-core's status and events, as the bar's rows do (RFC 0022 (i)). |
| **Transport to the page** | The plugin's own route, one stream per shown terminal. Whether DSH's plugin routes carry a socket upgrade is checked in delivery 1; the fallback is a server-sent output stream plus one input call per keystroke batch. The bots-dsh host has no socket route today (Pocket's is a local Unix socket, `apps/bots-dsh/src/host/pocket-socket.js`), so this is new. |
| **Input** | Typed keys go to the shown terminal as herdr-core input, only after the person clicks into it (focus is explicit, never on hover or on open). RFC 0014's Q19 holds: nothing wipes a half-typed draft in a terminal. |
| **What is view-only** | (1) Terminals on linked machines, until delivery H. (2) Every terminal in a browser before the gate. (3) A terminal another client is typing into right now, shown with "Typing elsewhere" and a click to take over. Everything else in the tree is typeable, as in herdr-app today: Decided 4 keeps each seat in its agent's own native terminal, and the person answers approval dialogs there (RFC 0022 Decided 6, RFC 0028 "Approvals"). |
| **The orchestrator's terminal** | Typeable, with a one-line note above it: "You are typing to the team's orchestrator directly; Genie will not see this." Q4 asks the owner whether it should be view-only instead. |
| **Resize** | Only the client the person is typing in sets the terminal's size; a view that is only watching fits the terminal into its box and never resizes it, so the app never reflows a terminal someone uses in herdr-app or on the phone. Delivery 1 checks how herdr-core's attach treats a watching client's size; if it cannot avoid a resize, that is filed upstream before delivery 2. |
| **Scrollback** | On open, the history herdr-core keeps for the terminal (the screen and history RFC 0028's `code_read` returns), then the live stream; xterm.js keeps its own buffer while the terminal stays on screen. No scrollback is written to the Bot team's home. |
| **Many terminals** | The right pane shows one terminal by default and up to four side by side when the person picks them; there is no layout editor, no saved layout and no tabs (D27's no-rebuild survives in that narrow sense). Four is the cap because the spike measured about 300 MB more memory for two busy panes. |
| **Electron and browser** | Identical: the page is DSH's page in both. The desktop adds nothing for terminals; the only desktop change would be if the preload must expose a new capability, which delivery 1 aims to avoid. |

### Team tree

**Recommended:** RFC 0022 revision (i)'s Code side, as written there, is the team tree. This RFC
adds one thing to its rows, the Genie's orchestrator marked and listed first in its project
(Leads and workers, below), and changes what a click opens on the right: the terminal in this
app's pane, not herdr-app's window.

- **Sources.** The registry (`apps/bots-dsh/src/shared/registry.js`; a project has exactly one main
  bot, `registry.js:313-314`) and `shown[]`; the attach ledger (which terminal plays which bot);
  the workers ledger (which workers a bot started, under it); herdr-core's status for each
  terminal. The same files the pack reads, read the same way, with the same fold (`foldAttach`)
  from the one source the pack and `am` already share (`am/` holds byte-equal copies, checked by
  `node scripts/am-copies.mjs --check`); the plugin imports that source, never a rewrite.
  Nothing new is stored.
- **Leads and workers.** A project's main bot first, then its other bots, each with its workers
  folded under it, as (i) lists. The Genie's hidden orchestrator (Decided 3) is the lead of its
  project's coding team and is listed first under that project, marked "orchestrator".
- **Status.** herdr-core's status words, the ones (i) uses: "working", "needs you", "idle", "not
  running". "Needs you" sorts the row up and counts on the Code side's switch, as the Code card
  counts today (RFC 0013's states table).
- **Read, never run**, as (i) says: no row starts, stops or restarts a bot or a worker in the
  first slices. Starting from the tree is the pack's New menu (`herdr/mods/am-new-menu`) moving in
  (delivery 6), after #206.

### The human-facing pane

Decided 4: the human-facing bot's pane is the real DSH chat in both modes. So in Code mode the
person's Genie stays where it is, the DSH chat, and the right pane beside or instead of it shows
the team's terminals. The flip changes the left list and what the right pane can show; it never
starts, resumes or sends anything (RFC 0022 (h): two ways in, never two sessions).

Because Decided 5 rules out an Automagik TUI, the human-facing bot has no terminal face: RFC
0022's terminal face switch (Decided 2) is shown only for a bot that runs in a terminal (a
seat), and hidden for a DSH Bot. RFC 0014's universal Bot amendment (a Herdr face through `dsh-tui
--resume`) keeps working for whoever uses it from herdr-app, but the app does not draw it.

### The Genie's two seats and the mailbox

Decided 3 makes the Genie two seats: a DSH Bot that talks only to the person, and a hidden
orchestrator in a herdr-core terminal that takes the team's reports and merge questions.

**Recommended:** the person-facing Genie reaches its orchestrator with RFC 0028's tools, and the
orchestrator reaches the Genie through a **mailbox**, not through every turn end.

- **Genie → orchestrator.** The orchestrator is a Code worker of the Genie Bot, started with
  `code_start` from an owner-kept template and carrying `automagik.bot=<genieId>`, so RFC 0028's
  grant reaches it and nothing else. The Genie asks it for work with `code_send`. The
  orchestrator's own workers are its children in herdr-core, started by the orchestrator, and do
  not carry the Genie's label: the grant never reaches them, so the Genie cannot type into the
  team.
- **The orchestrator is a long-lived worker.** RFC 0028's cleanup (a finished worker removed after
  24 hours) and its wake-on-every-turn-end do not fit a seat that runs for days. This RFC asks
  RFC 0028 for a second worker kind, **lead**: never cleaned up while its Bot exists, counted
  outside the per-Bot cap, woken only by the mailbox, and a `code_send` to it while it works
  is held by the host until the lead's turn ends, then sent with `send --if idle`, instead of
  being refused (Q8). (`hc send --wait` is not that: it waits for the turn the send starts.)
- **Orchestrator → Genie: the mailbox.** The orchestrator posts with one `am` verb (`am mailbox
  send`), which appends one row to `<app home>/automagik-herdr/mailbox.jsonl`, beside the two
  ledgers and in their format (one JSON object per line, one append each, the workers ledger's
  file mode). The verb lands in the pack's CLI (`herdr/mods/am-sidebar/bin/`, herdr lane), the
  CLI's source until delivery 8, and reaches `am/` only as its byte copy (`node
  scripts/am-copies.mjs --write`, then `--check`); `am/`'s copy is never edited by hand.
- **Only the orchestrator's terminal may post.** Any process of the person's account can run the
  verb or append to the file, so a row's `bot` field proves nothing. `am mailbox send` stamps the
  row with the terminal it runs in (`HC_TERMINAL_ID`) and that terminal's core id, and the
  follower accepts a row only when that terminal is the Genie's lead worker, as the Genie's
  worker record and herdr-core's labels (`automagik.bot`, `automagik.worker`) name it. A row
  from any other terminal, or with no stamp, is refused and logged. The stamp ties a row to a
  terminal but is not a proof against a same-account process that forges the variable; delivery
  3 also checks whether the host can hand the lead a per-start mailbox token at `code_start`
  that a row must carry, and records the residual risk if it cannot.
- **Who reads it: the mailbox follower.** A host part of the Bot team, apart from the core
  bridge: it runs whenever the Bot team's host runs (the desktop app open, with or without a
  window, or the image's server), reads only the mailbox file, and writes only into the Genie's
  Session through RFC 0028's durable wake log, so a crash resends once and never twice. Each row
  carries an `id`; the follower keeps the last id it delivered, so rows written while the host
  was not running are delivered, once, when it starts.
- **What may reach the person's chat.** Only two kinds of row, and the plugin refuses any other:
  - `answer`: a reply to a request the Genie made, carrying that request's id. A row whose id
    the Genie never sent is dropped and logged.
  - `question`: a question for the person, which the Genie shows as a question card.
  Reports, merge questions, worker status and anything else the team says stay in the
  orchestrator's terminal, visible in Code mode.
- **A row is data.** It reaches the Genie framed as a message from its orchestrator, never as the
  person's words or a system message; an `<hc>` tag or text claiming to be the person inside it is
  quoted, not obeyed (RFC 0028 "A report is data"). RFC 0022 Decided 8 refuses a typed message
  with a tag, because the person's words would read as a bot's; a row is already framed as the
  orchestrator's data, so it is kept and its tag quoted rather than refused.
- **RFC 0023's session terminal field** is what lets the same mailbox reach a DSH Bot that runs in
  a terminal (a dsh-tui seat): the field names the terminal, so the bridge finds the Session from
  it. The app-hosted Genie has no terminal and is addressed by its Session id. Until DSH ships
  the field, the mailbox reaches app-hosted Sessions only.

This shape is close to one RFC 0022 rejected; see Q1.

### The selector: route, then model

Decided 7 and 10. Today's model menu groups models by connection, a provider's brand and how it
is connected (`apps/bots-dsh/src/client/model-menu.js:15-21`, `connectionOf`), and a
plugin-owned menu lists only what that plugin gives (`host-model-menu.js`). The new selector,
described as a model, not a drawing:

| Step | Lists | Rule |
|---|---|---|
| 1. Route | **Native**, **ACP**, **Herdr**, always in that order | The bot type limits which routes show (Q13). A route with nothing set up says what it needs ("Add an API key", "Sign in", "Set up herdr-core") instead of hiding. |
| 2. Agent (ACP and Herdr only) | Every supported agent: Claude Code, Codex, Hermes, Antigravity, omp and any added later (RFC 0003, #973), each with its sign-in state | An agent that is not signed in shows "Sign in" (RFC 0003's sign-in from the Bot's chat). Native has no agent step. |
| 3. Model | The chosen route's, and agent's, models: on Native every model DSH supports, marked "needs an API key" where the key is missing (Decided 2); on ACP the models the agent's own sign-in gives; on Herdr the models the agent's terminal takes at launch, as the pack's worker settings pass them today (`herdr/mods/am-sidebar/models.js`) | A model that cannot run is marked, never picked silently (`model-menu.js`'s rule, kept). |
| Crossing | A route change | The selector says so before the person confirms: "Changing the route starts a new conversation; the bot writes a handoff note first" (Decided 6 and 10). A model change inside a route keeps the conversation. An agent change inside ACP or Herdr is Q14. |

What each route means for the pane: on Native and ACP the conversation is a DSH Session, so its
pane is the DSH chat (Decided 4); on Herdr the conversation runs in the agent's native terminal
on herdr-core, so its pane is that terminal in Code mode, and on Team RFC 0022's view of it.
Whether a bot the person chats with may take the Herdr route is Q13.

**How it is approved** (owner, 2026-11-10, issue #1016), in place of Decided 7's mockup "to be
attached": no mockup is attached. Only in the real app, in the actual
chat: a build the owner can open and click through, with light and dark screenshots from the
running app on the PR, checked against the app's own theme before he is asked. No mockup page,
no standalone HTML, no drawing. Issue #1016 is the selector's delivery (this RFC's delivery 4,
the selector part); it builds the selector so a route can be hidden per bot type, which Q13
then fills in. Until the Herdr route works, the PR says how that route is shown meanwhile and
the owner rules on it at approval, so no control ships that does nothing.

### Handoff note

Decided 6: a harness change is a new conversation with a handoff note, and no history crosses.

**Recommended:**

- **Who writes it.** The old harness, asked by the plugin with a fixed prompt at the moment of the
  switch: goal, decisions made, open work, files touched, what the person asked last. If the old
  harness cannot answer (signed out, quota, error), the plugin writes a plain note from the
  Session's own record instead: the last request, open tasks and the files named, with no model
  call. The note is never longer than a set cap (proposed: 4,000 characters).
- **Redaction.** It passes the same redactor RFC 0003's live switching uses
  (`apps/bots-dsh/src/host/secrets.js`, `diagnostics.js`) before it is stored or sent.
- **Where it lives.** In the Bot team's home, in the old Session's folder, as one Markdown file
  named by the new Session's id; never in a repository. Both Sessions link it: the old one ends
  with "Continued in a new conversation", the new one starts with a handoff card.
- **How the new harness receives it.** As the new conversation's first message, framed as a note
  from the previous conversation (not the person's words, not a system message), shown to the
  person as a card they can open before their first message is sent. The person may delete it
  from the card; then nothing crosses at all.
- **What changes in RFC 0003.** Only replay at a harness change: its delivery 7 (live switching,
  the transcript replayed into the target) is replaced there by this note. Nothing else in RFC
  0003 changes. `dshTools` is not touched, and its kill switch (`false`, RFC 0003 "Replay
  independent of the bridge") is never used for this, since it would also take the DSH tool
  bridge off agent routes. Replay without a harness change stays as RFC 0003's 2026-11-08
  amendment has it: a new agent session in a chat that already has answers (a restart), a live
  session resumed after the chat answered elsewhere, and a Bot part's handoff package. Q7 asks
  what happens to Sessions that already crossed.

### Mod by mod

| Mod (`herdr/mods/`) | What it does today | After the move |
|---|---|---|
| `am-sidebar` | Spaces, the bot and worker rows, the briefing hook, the guard, the updater, the CLI (`bin/`) | **Splits.** Rows become the team tree (bots-dsh). The CLI, the briefing (`briefing.mjs`), the guard (`hcGuard.mjs`, `hcProxy.mjs`, `guard/`), the ledgers and the meter install path stay shared and move to `am/` as their source (today `am/` holds byte copies). The updater ends with the pack. |
| `am-automations` | Scheduled agent prompts through the `herdr-automations` CLI and the vendored scheduler (`herdr/scheduler/`, pinned in `scheduler.js`) | **A page in the app**, still driving the same CLI with `--json`; the scheduler stays a shared install through `am` (#220). The Bot team's own schedules (`client/schedules.js`) stay separate (Q10). |
| `am-quota` | The Accounts panel: which account the local agent clients use, through the account proxy | **A page in the app's settings**, beside the Models page (`client/providers-page.js`); its write path (`write.js`, `lock.js`) is shared by the CLI and the page through the pack's source and `am`'s byte copy until delivery 8 moves the source to `am/`. |
| `am-new-menu` | Start a bot or worker from a menu | **The tree's New**, after #206 (the tree runs nothing before then). |
| `am-status` | Herdr's status bar plus the pack's version and update state | **Ends.** The machine, branch and agent counts show in the tree's header; the update state is the app's own (`client/desktop-update.js`). |
| `am-footer` | The rail: Work button, Automations, Accounts, the phone dot | **Ends.** The Work button is the flip itself; Automations and Accounts are pages; the phone dot moves to the tree's header, read from Pocket Link's published state as today. |
| `am-tabs` | Tab names in Herdr | **Ends.** The app has no tabs (D27's no-rebuild, narrow sense). |
| `am-markdown` | Opens Markdown files a terminal printed | **Later.** A terminal's printed `.md` paths open in the app's own Markdown view; not in the first slices. |
| `am-mods` | Herdr app mod manager and the Community index | **Ends.** DSH has its own plugin manager. |
| Layout (`herdr-layout/`) | The pack's herdr.dev layout entry | **Ends** with the pack; the app has no layouts. |
| `pocket-link` | Pocket's desktop side: the phone's bridge and chat engine | **Pocket's answer, not this RFC's** (AGENTS: Pocket Link belongs to Pocket, never in `PACK_MODS`). Recommended to Pocket: its bridge (`herdr/mods/pocket-link/bridge/`) runs as a service `am` starts, not as a herdr-app mod, so it survives herdr-app leaving; its chat engine stays the source the app copies (RFC 0022 Decided). See Q11. |

**What stays shared:** the registry, the attach and workers ledgers and their folder
`<app home>/automagik-herdr/` (a public contract: installed teams keep their data there, so it
is never renamed even though herdr-app's home stops being the reason for the name), the
`automagik-herdr` CLI and `am`, the briefing hook, the guard, and herdr-core.

**What ends:** herdr-app as part of Automagik's install, the pack's UI mods, its layout and its
updater (the herdr lane's pack pointer).

### The pack after the move

**Recommended:**

1. **Fix-only from this RFC's acceptance** until the app's Code mode ships (deliveries 1 and 2 in
   a stable release): security and breakage fixes on the herdr lane as today; no new features in
   the pack's UI.
2. **One last pack release** after the app's Code mode ships. Its update notice says Code now
   lives in the Automagik app, with a link. Installed packs keep working; nothing switches them
   off remotely, and the pack never deletes data. The herdr-lane pointer is signed one last time;
   no field is added to it (a new field is an RFC 0011 change).
3. **Then retired.** The pack's UI folders leave the repository; the shared parts already live
   in `am/` (Mod by mod). Pocket Link stays where Pocket puts it.
4. **The Community entry.** AGENTS.md says no `herdr-mod` or `herdr-layout` topic is added until
   the owner opens the listing, and it is not open. Recommended: it is never opened, and `herdr/`
   stops being the entry's folder when the pack is retired (Q6).

### RFC 0013

- **D27 is replaced** by this RFC (Decided 8 and the issue's title). Replaced: "Two windows, one
  product, glue only", "Code is herdr-app, used exactly as today with its mods", and "Nothing in
  Herdr is rebuilt" as a ban on drawing terminals in the app. Kept in a narrow sense: the app does
  not rebuild herdr-app's spaces, tabs, splits or layouts.
- **Deliveries 1-6 stand** until deliveries 1 and 2 here ship in a stable release: the switch
  keeps raising herdr-app for people who use it, then is replaced by the flip.
- **Delivery 7 (one install) stands, re-scoped:** the code set installs herdr-core and `am`, not
  herdr-app and the pack.
- **Delivery 8 (shared Bots) stands for its desktop and plugin parts:** one Bot id in both
  places, a Bot with a live pane is shown. Its herdr part (the Work button sends its pane's Bot)
  ends with `am-footer`.
- RFC 0013's Status names this RFC; its Decided 1-7 stand while herdr-app is installed.

### The image

**Recommended:** the server image (`server/Dockerfile`) gains what Code mode needs and nothing
about where it runs:

- **herdr-core**, pinned by version and sha256 the way `apps/desktop/wslc/Dockerfile` already
  pins its `hc`, never through an installer that resolves "latest".
- **`am`** from its signed lane, the same tarball every release attaches.
- **The agent CLIs** the person enables (Claude Code, Codex, ...), each pinned like the desktop's
  required CLIs (RFC 0003, 2026-11-08), installed into the volume on first enable, not baked in,
  so the image stays one size for everyone.
- **Sign-in.** Each agent signs in with its own sign-in flow, started from the Bot's chat (RFC
  0003's sign-in from the Bot's chat) or in a terminal in Code mode; credentials land in the
  instance's data volume, never in the image. The image's secrecy scan (`server/secrecy.mjs`)
  keeps refusing any credential in the image.
- **Before the gate,** Code mode is off in the image: no terminal is shown in a browser until RFC
  0024 delivery 2 is in (RFC 0022 (l), condition 1).
- No host, address, port or account belongs in this repository; the image's deployment stays in
  the private notes RFC 0024 names.

## What does not change

- RFC 0022's decided parts, and its revision's (h) to (l) as written in #1009, except where Q1
  to Q3 ask the owner.
- RFC 0028's tools, grant, wake loop, caps and threat model; this RFC asks it for one worker kind
  (Q8) and one word (Q9).
- RFC 0014's registry, `shown[]`, D29 on the Team side, and D30's two backends.
- herdr-core, `hc` and `am`'s existing commands; `am` gains one verb, `am mailbox send`. Every
  seat other than the human-facing bot keeps its agent's native terminal (Decided 4).

## Contracts introduced

- The core bridge's route in bots-dsh (stream and input per shown terminal). New, owner-only,
  window-only.
- `am mailbox send` and `<app home>/automagik-herdr/mailbox.jsonl` (rows: `v`, `id`, `kind`
  `answer` or `question`, `bot`, `request` for an answer, `text`, `terminal` and `core` stamped by
  the verb, `at`). New.
- A handoff note file per crossed Session, and the handoff message kind in a Session. New.
- RFC 0028's worker kind `lead`, if Q8 is yes. An amendment to RFC 0028.
- No new plugin id or storage prefix; `<app home>/automagik-herdr/` is kept.

## Threat model

| Threat | Mitigation |
|---|---|
| A Bot reaches the person's terminals through the core bridge | The bridge serves the window only, is never a tool, and holds no RFC 0028 grant; Bots' shells keep delivery H's masks |
| A browser visitor types into the team's terminals | Code mode is off in the image until RFC 0024 delivery 2's gate; owner-only after it |
| The orchestrator floods or steers the person through the Genie | Only `answer` (to a request the Genie made) and `question` rows cross; a row is data, tags quoted |
| Another local process posts to the mailbox as the orchestrator | `am` stamps the posting terminal; the follower accepts only the Genie's lead terminal; the per-start token if delivery 3 finds it possible, else the residual is recorded |
| The Genie types into the team behind the orchestrator | The grant reaches only the orchestrator's terminal; its children carry no Genie label |
| A secret crosses in a handoff note | RFC 0003's redactor runs before the note is stored or sent; the person can delete the note |
| A watching view reflows a terminal someone is using | Only the typing client resizes; a watching view letterboxes |
| A terminal on a linked machine is reached before its link is scoped | Linked machines are view-only and unlisted until delivery H (RFC 0022 (k)) |

## Deliveries

Each is one PR on one lane. Two tracks run in parallel:

- **The selector track:** delivery 4 (issue #1016, an overdue build ask of the owner's) runs
  after Q13 and Q14 only. It needs nothing from deliveries 0-3, Q1-Q3, #1009 or RFC 0028: it
  changes the model menu and adds the handoff note, and attaches to no terminal.
- **The Code track:** 0, 1, 2, 3a, 3b, then 5, 6, 7 and 8.

Every test uses temp homes, fake ledgers and a herdr-core started for the test, never a live
Herdr install.

0. **Owner's answers** to Q1-Q3 (the conflicts with #1009) and RFC 0022's revision approved.
   *Acceptance:* this RFC's Status records them; no build on the Code track before. Delivery 4
   is not held by it.
   *Status, 2026-11-19:* Q1-Q3 are answered (Answers). RFC 0022's revision is merged (#1009) but
   its own Status still says the owner has not read it, so this delivery stays open until the
   owner approves it. Deliveries 1 and 2 shipped parts before it (#1391, #1394).
1. **The flip, end to end, on this computer** (plugin; after RFC 0022's delivery B, the bar). The
   first slice. In Code mode the tree lists this computer's projects, bots and workers from the
   registry and the two ledgers; a click renders that terminal live in the right pane, view-only;
   the flip back shows the human-facing bot's DSH chat, which never moved. The desktop app first;
   the browser half needs RFC 0024 delivery 2's gate and ships only once that is in.
   *Acceptance:* the flip starts, resumes and sends nothing; no row runs anything; linked
   machines are not listed; the transport question (socket or streamed output) is answered;
   without the gate, a browser shows no terminal.
   *Check:* a test core with two terminals and fake ledgers: the tree lists both under the right
   bot, a click attaches one and closing the pane detaches it; output typed into the terminal by
   the test appears in the view. *Rollback:* a plugin release with today's switch.
2. **Input, resize, scrollback, many terminals** (plugin). Typing after a click into the
   terminal, "Typing elsewhere", the watching-size rule, history on open, up to four side by side.
   *Check:* keys reach the terminal only after focus; a watching view never changes the
   terminal's size; a fifth pick is refused with the four named. *Rollback:* back to view-only.
3. **The Genie's two seats and the mailbox** (after RFC 0028 deliveries 0 and 1, and Q1 and Q8),
   two PRs:
   - 3a (herdr): `am mailbox send` in the pack's CLI, with its terminal stamp. *Acceptance:* the
     herdr gate, and `node scripts/am-copies.mjs --check` passes with `am/`'s copy regenerated by
     `--write`, never edited by hand.
   - 3b (plugin): the orchestrator as a lead worker, the mailbox follower, the two row kinds.
   *Check:* an `answer` with a known request id reaches the Genie's Session once across a crash,
   and once after a host restart for a row written while the host was down; an unknown id, an
   unknown kind and a report are refused and stay out of the chat; a row posted from any terminal
   but the lead's, or without a stamp, is refused; an `<hc>` tag in a row is quoted; the
   orchestrator starts its own workers, while the Genie's `code_send` and `code_read` on those
   workers are refused by the grant. *Rollback:* a release without the mailbox; the orchestrator
   keeps its terminal.
4. **Route, then model, and the handoff note** (plugin; the selector is issue #1016; after Q13
   and Q14, approved by the owner in a running build with light and dark screenshots).
   *Check:* the routes list Native, ACP, Herdr in that order; each bot type lists only the
   routes Q13 gives it (a DSH bot: Native only); a route change warns before the person
   confirms; the note is written by the old harness, falls back to the plain note when
   the old harness fails, is redacted (a saved secret in the transcript never appears in it),
   and the new conversation starts with it as a card; a model change inside a route keeps the
   conversation; the DSH tool bridge is still on for agent routes, and a restart inside one
   harness still replays the chat as RFC 0003 has it. *Rollback:* today's menu and RFC 0003's
   replay.
5. **Automations and Accounts as pages** (plugin; any shared code it needs moves through the
   pack's source and `am-copies`, as in 3a). *Check:* the page lists, adds and
   removes an automation through the `herdr-automations` CLI's `--json`, and a quota switch
   written from the page reads back from the CLI. *Rollback:* the pack's panels stay.
6. **Start from the tree** (plugin; after #206). The New menu moves in. *Check:* a start from the
   tree writes the attach ledger the same way the CLI does. *Rollback:* the tree reads only.
7. **Code mode in the image** (server image and plugin; after RFC 0024 delivery 2). herdr-core,
   `am`, agent CLIs enabled into the volume, sign-in. *Check:* before the claim no terminal is
   shown; after it a fresh image signs an agent in, starts the Genie and shows its orchestrator's
   terminal in a browser; the secrecy scan finds no credential in the image. The automated part
   uses a fake agent CLI; the real sign-in is a manual step, on a test account of the tester's
   own, and no account is named in the repository.
   *Rollback:* an image without herdr-core; Team works as today.
8. **The pack's last release and retirement** (herdr, then a removal PR; after delivery 2 has
   shipped in a stable release). The notice, the last pointer, the shared parts' source moved to
   `am/`, RFC 0013 deliveries 7 and 8 re-scoped. *Check:* the herdr gate on the last release; the
   notice's text names the Automagik app and its link; the last pointer's sequence is higher than
   the one before and it adds no field (`scripts/herdr-lane.ts`'s own refusals); a pack installed
   in a temp home keeps working after the last release; the am gate with `am/` as the source;
   `scripts/entries.mjs --check` after the folders leave.
   *Rollback:* revert the removal; the pack keeps its fix-only lane.

Linked machines come after RFC 0022's delivery H, as a delivery of that RFC widened by its Q16,
not of this one.

## Answers (2026-11-19)

The owner's delegate accepted this RFC on 2026-11-19 (issue #1007) and answered every open
question with this RFC's own recommendation. Each answer is that recommendation, restated; the
questions below stay as they were asked.

1. **Q1:** Decided 3 governs the Genie product. RFC 0022's rejection of a separate Genie bot, and
   its revision's (j), stay for the team's own seats (Chat, the General Orchestrator) until the
   owner moves them to a Genie; the mailbox's two-kind rule answers the rejection's reason. Owed:
   RFC 0022 is amended to say so. This answer does not approve RFC 0022's revision.
2. **Q2:** RFC 0022 (h)'s "D27 holds" reads as "Herdr's spaces, tabs, splits and layouts are never
   rebuilt", which this RFC keeps. The herdr-app link on a Code row stays while herdr-app is
   installed and goes with the pack (delivery 8).
3. **Q3:** both stand, for different bots: a Genie's human-facing bot is a DSH Bot from its first
   day; an existing seat shown on Team stays a view (RFC 0022 1L) until the owner moves it.
4. **Q4:** the orchestrator's terminal is typeable, with the one-line note above it (Terminal
   renderer).
5. **Q5:** the image's agent CLIs install into the volume on first enable; none is baked into the
   image.
6. **Q6:** the Community entry is never opened, and `herdr/` stops being its folder when the pack
   is retired.
7. **Q7:** Sessions that already crossed harnesses keep their record as it is; the next crossing
   uses the handoff note; from delivery 4 on, replay stops at a harness change only, and
   `dshTools` and same-harness replay stay as RFC 0003 has them. Owed in delivery 4: on a
   harness change, send only the redacted handoff note; a crossing today (#1025) still sends
   earlier and latest messages to the new conversation (`apps/bots-dsh/src/host/parts.js`, the
   handoff package).
8. **Q8:** yes. RFC 0028 gains a worker kind `lead`: long-lived, outside the cap, woken only by
   the mailbox, and a send to it while it works is held until its turn ends, then sent, rather
   than refused. It is an amendment to RFC 0028 in its own PR. Owed: that amendment.
9. **Q9:** the owner's sense wins: "Code" and "Code mode" mean the app's Code side, and one pane's
   xterm face is the terminal face. This RFC merged last (#1017, after #1008 and #1009). Owed:
   RFC 0028's Words table and RFC 0022's "Code mode" wording updated to match, with no change to
   their design.
10. **Q10:** two systems on two pages for now: the pack's automations and the Bot team's schedules.
    Merging them needs its own RFC.
11. **Q11:** Pocket decides. This RFC's recommendation to Pocket stands as written: Pocket Link's
    bridge runs as a service `am` starts, so it no longer needs herdr-app. Nothing here moves
    Pocket Link.
12. **Q12:** one plugin: the core bridge stays in bots-dsh's host, beside RFC 0022's live-chat
    engine.
13. **Q13:** the table as recommended: Automagik and Omni take Native and ACP; DSH takes Native
    only; a Genie's human-facing bot takes Native and ACP; a Genie's team seats (the orchestrator
    and its workers) take Herdr only. Herdr is not offered for a bot the person chats with;
    revisit once RFC 0022's delivery 1L ships. Owed in delivery 4: the selector's per-bot-type
    route policy (#1025) applies this table to the three routes it covers, telling a Genie's
    human-facing bot from its team seats; which bots may take RFC 0003's fourth route (Remote
    Hermes, 2026-11-11) is outside Q13.
14. **Q14:** an agent change inside ACP or Herdr counts as a route change: a new conversation with
    a handoff note. Only a model change inside one agent keeps the conversation.

From this acceptance the pack is fix-only (The pack after the move, 1): security and breakage
fixes on the herdr lane as today, no new features in its UI, until deliveries 1 and 2 are in a
stable release.

## Open questions

Answered on 2026-11-19 (Answers, above); kept as asked. Each has a recommendation. Q1-Q3 were
real conflicts with #1009 (RFC 0022's revision), then an open pull request; Q8-Q9 with #1008
(RFC 0028), then open too; Q7 with RFC 0003.

1. **The Genie's two seats vs RFC 0022's rejection.** RFC 0022 rejected "a separate DSH Genie
   bot as the owner's interface, delegating to Chat through hc", because a second agent would
   stand between the owner and the bot that runs the team; #1009's (j) and Q12 keep that
   (a project's humanized bot is its main bot, not a new bot talking for it). Decided 3 here is
   that shape, for the Genie type. Recommended: Decided 3 governs the Genie product; RFC 0022's
   rejection and #1009's (j) stay for the team's own seats (Chat, the General Orchestrator)
   until the owner moves them to a Genie, and the mailbox's two-kind rule is the answer to the
   rejection's reason. #1009 is amended to say so.
2. **"D27 holds" in #1009 (h).** #1009 says D27 holds and herdr-app stays one click away from
   every Code row. This RFC replaces D27. Recommended: #1009's (h) is read as "Herdr's spaces,
   tabs, splits and layouts are never rebuilt", which this RFC keeps; the herdr-app link on a
   Code row stays while herdr-app is installed and goes with the pack (delivery 8).
3. **The human-facing pane vs #1009's humanized bots as views.** #1009 (j) makes a project's
   humanized bot a view of its Claude Code seat, "a view first, a move later". Decided 4 here
   makes the human-facing bot a real DSH chat. Recommended: both stand, for different bots: a
   Genie's human-facing bot is a DSH Bot from its first day; an existing seat shown on Team
   stays a view (#1009 1L) until the owner moves it.
4. **Typing into the orchestrator.** Typeable with a note (recommended), or view-only so every
   word goes through the Genie?
5. **The image's agent CLIs.** Installed into the volume on first enable (recommended), or baked
   into the image for a faster first start?
6. **The Community entry.** Never opened, and `herdr/` stops being its folder at retirement
   (recommended), or opened for the fix-only period?
7. **Sessions that already crossed harnesses under RFC 0003's replay.** Recommended: they keep
   their record as it is; the next crossing uses the handoff note; from delivery 4 on, replay stops
   at a harness change only, and `dshTools` and same-harness replay stay as RFC 0003 has them.
8. **A lead worker kind in RFC 0028.** Long-lived, outside the cap, woken only by the mailbox,
   and a send to it while it works is held until its turn ends, then sent, rather than refused.
   Recommended: yes, as an amendment to RFC 0028 in its own PR, so #1008 is not blocked.
9. **The words "Code" and "Code mode".** #1008's Words table defines Code as herdr-app, and
   RFC 0022 (with #1009's (i)) uses "Code mode" for one pane's xterm face, while the owner's
   Decided 4 and 9 use "Code mode" for the app's whole Code side. Recommended: the owner's sense
   wins; one pane's xterm face is called the terminal face; whichever of #1008, #1009 and this RFC
   merges last updates the other two's wording, with no change to their design.
10. **One scheduler or two.** The pack's automations and the Bot team's schedules stay two
    systems on two pages (recommended for now), or merge later in their own RFC?
11. **Pocket Link's host.** Pocket decides; recommended to Pocket: a service `am` starts, so it no
    longer needs herdr-app.
12. **One plugin or two.** The core bridge in bots-dsh's host (recommended, beside RFC 0022's
    live-chat engine), or a separate plugin so the attach reach sits in its own process?
13. **Which bot types may use which route, and Herdr for a chat bot** (the open point of
    Decided 10's comment). Recommended:

    | Bot type | Native | ACP | Herdr |
    |---|---|---|---|
    | Automagik | yes | yes | no |
    | Omni | yes | yes | no |
    | DSH | yes | no | no |
    | Genie, the human-facing bot | yes | yes | no |
    | Genie, the team seats (the orchestrator and its workers) | no | no | yes |

    The DSH and team-seat rows follow the comment itself (a DSH bot is Native only; Genie's team
    seats are Herdr), and the Automagik and Omni rows follow Decided 1 (DSH harness, ACP for a
    model with no key). Herdr is offered only for team seats, not for a bot the person chats
    with: a chat bot on Herdr would be a seat whose chat is RFC 0022's rendered view, which #1009
    keeps for the team's existing seats ("a view first"), and it would break Decided 4's rule
    that the human-facing pane is the real DSH chat. Revisit once RFC 0022's delivery 1L ships.
14. **An agent change inside a route** (Claude Code to Codex, both ACP). Recommended: it counts
    as a route change, a new conversation with a handoff note, because each agent is its own
    harness and Decided 6 carries no history across harnesses; only a model change inside one
    agent keeps the conversation.

## Links

- Issue #1007 (the owner's direction); #1008 (RFC 0028) and #1009 (RFC 0022's revision), both merged.
- RFCs: [0003](0003-model-routes-and-acp.md) (live switching, sign-in from the chat),
  [0011](0011-monorepo-parts-and-releases.md) (lanes, the pack pointer),
  [0012](0012-am-cli-and-parts.md) (`am`), [0013](0013-work-code-switch.md) (D27, deliveries
  7 and 8, the spike in Alternatives), [0014](0014-shared-bot-registry.md) (registry, D29, D30,
  Q19, universal Bots), [0022](0022-desktop-chat-view.md) ((f), Decided 2, 6, 8, delivery H),
  [0023](0023-dsh-upstream-agent-context-and-chat-rows.md) (the session terminal field),
  [0024](0024-automagik-cloud.md) (delivery 2, the gate),
  [0028](0028-code-workers.md) (Code workers).
- Issues and PRs: #1016 (the selector's delivery), #206 (remote starts), #220 (scheduler
  install), #628 and #631 (scoped core access), #973 (more native-ACP agents), herdr-core#122
  (conditional keys).
- Code: `herdr/mods/` (every mod above), `herdr/mods/am-sidebar/attach.js`, `workers.js`,
  `herdr/mods/am-automations/scheduler.js`, `herdr/scheduler/`, `herdr-layout/`;
  `apps/bots-dsh/src/client/` (`sidebar.js`, `work-code-switch.js`, `model-menu.js`,
  `host-model-menu.js`, `providers-page.js`, `schedules.js`, `desktop-update.js`),
  `apps/bots-dsh/src/host/` (`pocket-socket.js`, `secrets.js`, `diagnostics.js`),
  `apps/bots-dsh/src/shared/registry.js`; `apps/welcome-dsh/src/client/terminal.js`;
  `apps/desktop/src/herdr.js`; `apps/desktop/wslc/Dockerfile`; `server/Dockerfile`,
  `server/secrecy.mjs`; `apps/pocket/android/app/src/main/java/ai/namastex/automagik/`
  (`CoreClient.kt`, `TerminalScreen.kt`).
