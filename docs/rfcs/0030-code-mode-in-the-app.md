# RFC 0030: Code mode inside the Automagik app

| Field | Value |
|---|---|
| Status | In delivery (accepted by the owner's delegate on 2026-11-19, issue #1007; Q1-Q14 answered with this RFC's own recommendations, see Answers; delivery 0 met on 2026-11-19, when the owner's delegate approved RFC 0022's revision; amended 2026-11-20: what moves now and what waits, approved by the owner's delegate on 2026-11-20, Q15-Q23 answered with the amendment's recommendations; Q18 narrowed by the owner's delegate on 2026-11-21 (the Code side in a gated browser needs member admission on and RFC 0038 delivery 3); five decisions of the owner's delegate on 2026-11-21, each the recommended option (Q19's Add and Remove login, RFC 0022 delivery B's drawing, 6b moved to RFC 0022 delivery H, Pocket Link as its own part, 6a's Bots with no CLI start path), see Decisions (2026-11-21); what has merged is in that amendment's inventory, see Amendment (2026-11-20); owner's direction 2026-11-10; replaces RFC 0013's D27; amends RFC 0003's live switching at a harness change; Decided 10 (the route) by the owner 2026-11-10; amended 2026-11-23 by the owner (#2061): switching agents in a Bot's own chat carries the conversation, which supersedes Q7a's refusal and the #2025 decision (a), see Handoff note) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none here (docs); plugin (3.N.P) for bots-dsh; desktop (3.N) only if the preload must change; the server image; herdr (3.N.P) for the pack's fix-only period, the `am mailbox send` verb (the pack's CLI is its source; `am/` gets it as a byte copy) and the retirement notice; am (3.N.P) for those copies |
| Created | 2026-11-10 |
| Replaces | [RFC 0013](0013-work-code-switch.md)'s D27 ("Code is the real herdr-app window, glue only") |
| Builds on | [RFC 0022](0022-desktop-chat-view.md)'s 2026-11-10 revision (merged in #1009, approved 2026-11-19: Team and Code, the left bar, humanized bots); [RFC 0028](0028-code-workers.md) (merged in #1008: Code workers); [RFC 0023](0023-dsh-upstream-agent-context-and-chat-rows.md) (the session terminal field) |

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

   **2026-11-20, Q7a B-min amendment.** The host refuses an explicit harness pick in a Bot's
   own chat with history. Use New conversation, then pick the route. Pause an active goal
   first. A chat with nothing said can take the route in place.

   **2026-11-23, the owner's #2061 amendment.** A harness change in a Bot's own chat carries the
   conversation over in place and is never refused for history. The host opens a new part on the
   picked route that starts with a handoff (a summary and the latest messages); the new agent reads
   the rest of the chat through `read_own_chat`; the chat stays one conversation with a
   "Switched to <agent>" line. History now crosses harnesses, visibly. This supersedes the Q7a
   paragraph above, except on a Hermes route (Handoff note).
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

The [2026-11-20 Q7a B-min amendment](#decided) to Decided 6 supersedes the crossing and
confirmation described in Decided 10.

The owner's 2026-11-23 amendment to Decided 6 (#2061) brings back the crossing of Decided 10
with the conversation carried. An idle chat switches at once, with no question. While a reply
is running the selector asks first, because the pick stops that reply: "This stops the current
reply and continues on <agent>." (Switch, Cancel); the host asks the same question when the
selector did not see the reply.

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
| **Resize** | Code mode never resizes a terminal, typing included (Q15, 2026-11-20, as RFC 0022's revision says): a view keeps the terminal's own grid and fits it by font size, so the app never reflows a terminal someone uses in herdr-app or on the phone. |
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
  as the tree's explicit New action, on this computer only (delivery 6a; Q17, 2026-11-20); a
  row's click still runs nothing.

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
| Crossing | A route change | On a Hermes route, before confirmation the selector says "Changing the route requires a new conversation if this one has history." Elsewhere an idle chat switches at once. While a reply runs, the selector asks "This stops the current reply and continues on <agent>." (Switch, Cancel). A model change inside one harness keeps the conversation. An agent change inside ACP or Herdr is Q14. |

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

#### Switching agents carries the conversation (the owner, 2026-11-23, #2061)

An explicit route or agent pick in a Bot's own chat (`switch-route`, or `update-bot` with a model on
another harness) never refuses because the chat has history. Native, Claude Code, Codex, omp and
Antigravity, both directions. A part with nothing said still takes the route in place, as before.
Otherwise:

1. If a reply is running, the host asks first: without `stopReply: true` it answers `bot/refused`
   with reason `reply-running` and changes nothing; the selector then asks "This stops the current
   reply and continues on <agent>." (Switch, Cancel), and Switch sends the pick again with
   `stopReply: true`. The check and the start of the switch run in one step, so a reply cannot start
   between them unseen.
2. The host answers at once (`status: 'switching'`) and starts a switch job on the current part.
   From that moment the chat's composer is locked, and every step the old part starts is taken over
   before the model is called; its input waits for the new part. Pocket, Bot-to-Bot messages, group
   relays, schedules, channels and steering all enter through the old part's inbox, so they wait the
   same way. A reply stopped with `stopReply` continues on the new agent at once, with no new
   message, also after a restart.
3. The summary is written by the outgoing agent, which already holds the conversation: a native
   model on its own route, an agent over ACP in a turn of its own chat that the chat does not show.
   Never by another model. If it cannot write one within 45 seconds, the new agent gets no summary:
   the latest messages and the history tool only. A summary never blocks or refuses the switch.
4. A fresh part is created, the picked route is selected on it and checked, and the handoff package
   (the summary, the latest messages word for word, where the rest is) is put into it before
   anything can reach it. Only then does it become the Bot's chat, in one save with the Bot's new
   model. The input that waited follows the package.
5. The chat shows the earlier parts above the new one as one conversation; the line between them
   reads "Switched to <agent>".
6. The new agent reads any earlier message with `read_own_chat` (this Bot's own chat only,
   read-only, paged). Claude Code and Codex reach it over the `dsh` bridge, a native model as a DSH
   tool, omp and Antigravity over a one-tool `dsh-history` bridge (RFC 0003).
   **2026-11-26 amendment (#2061 D2d).** omp and Antigravity share the existing `dsh` bridge,
   whose restricted allowlist can contain `load_skill` and `read_own_chat` as eligibility permits.
   Antigravity offers history with Native tools ON. With Native tools OFF, history stays silently
   unavailable and the handoff note still reaches the fresh part. Hermes keeps
   `needs-new-conversation`.
7. If the switch cannot finish within 120 seconds, or the new route is not served, not signed in or
   not allowed, the Bot stays on its part and model, its input goes back in order, the lock ends,
   and the model line says "<model> could not take over this conversation. This Bot stays on
   <kept>." Until the new part's first real answer the old part is kept, so a first call that fails
   goes back the same way. A time-boxed Auto grant ends at the pick and stays ended. A Bot that
   denies `acp_tool` is not moved onto, or back to, an agent that runs its own tools (#2026): the
   switch, or its way back, stops with that reason.
8. The new part starts its first turn at the commit, so the chat never shows a part with no turn
   (DSH draws one as a blank home, whose composer is disabled for a Bot outside every workspace). A
   handoff with nothing to answer is acknowledged by the Bot team itself, with no model call and no
   row beyond the "Switched to" line; a stopped reply is answered at once. If that turn cannot
   start, the switch goes back as in 7. After a restart, a part that cannot start is tried again at
   most 3 times or for 2 minutes from the first try, whichever comes first, with the composer locked
   meanwhile; then the Bot goes back to the agent it came from with the line of 7. Where there is no
   way back, it stays on the new agent, the handoff runs once more, and the line names the new
   agent on both sides.
9. A handoff package for an agent over ACP is at most 58,000 characters, under acp-dsh's
   60,000-character replay clip, on every path that opens a part on one: the oldest carried lines
   are left out first, so the newest messages and the closing line arrive, and a summary too long
   for it is not carried. With acp-dsh's kill switch (`dshTools: false`) the package still reaches
   the agent, as plain text ahead of the person's words in the part's first prompt, once;
   `read_own_chat` does not, because the kill switch turns DSH's tool bridge off.

Only the person moves a Bot to another agent when its chat has history. `update_bot` from a Bot is
refused ("Only the person moves <name> to another agent. Use propose_bot_change so the person can
apply it."); the person's Apply on that proposal is a pick like any other.

A Bot's group conversations follow its switch, each with its own fenced switch and handoff: an idle
one at once, a busy one at its next step (that step's messages go with it and its turn goes on on
the new agent), never by stopping a group reply. The person's pick starts it: the own chat's switch
when it moves, or its change in place when nothing was said there; a model applied at start or by
failover moves no group. A group conversation an earlier pick left on its agent follows the next
one. The summary is the outgoing agent's, as above, or none; never the team's background model. An
agent over ACP writes it in a turn of the group conversation that the group never sees: nothing
of it is posted while it runs or at its end, and it counts in no round. The package is the group
variant (the latest lines only) with the reason "the user switched you from <old> to <new>; in this
group you are <new> now", capped for an agent over ACP as in 9. Each group shows "<name> switched
to <agent>" once, a line members do not read. A follow that does not move, or whose first call
fails, leaves that conversation on its agent (never changed in place) and writes nothing on the
Bot's model line; it tries once more at its next step, and after a second failure waits for the
Bot's next pick. After a restart the bound of 8 applies to a group part too, and its way back is
the group's own route. The group's own Session does not move, and Hermes routes never follow.
(Delivery 4b, second PR.)

On the few ways back that cannot run a reply the switch stopped (the chat changed meanwhile, the
old part cannot be loaded, or the handoff cannot run again where there is no way back), a Bot that
was waiting for that reply gets one final answer saying the model call failed, as any failed turn
gives it.

Why a plugin fence is enough here (Q7a's two gaps): the new route is selected only on a Session no
surface can reach yet, its handoff is in it before it becomes reachable, and the old Session's steps
are taken over whatever DSH admits; the moved input uses the path every part move already uses
(`forward`, `restore`, the `switching` marker). The in-place change on a populated Session,
automatic moves, the rest of Q7b, the rest of Q7c and durable receipts for every part move still
wait on DSH (RFC 0045 section 5).

Permissions do not change with the switch. The part takes the Bot's level, deny list and shell rule;
Full access means the new harness's own mode; the per-Bot native tools switch and Read only apply to
the new agent as to any part.

This supersedes the #2025 decision (a) (2026-11-22). That decision kept a Session whose history a
failover had moved across harnesses on that harness, because history did not cross harnesses.
History now crosses harnesses, visibly, through the handoff and `read_own_chat`. The person's next
pick of a model on another harness takes the switch above. Failover still never crosses a harness,
and still makes no automatic move.

Hermes routes (Remote Hermes, and Hermes over ACP) are excluded: a crossing to or from one keeps the
Q7a refusal below and its copy, pending the owner's word (Hermes work is paused).

#### Q7a (2026-11-20), superseded on 2026-11-23 except on a Hermes route

Q7a replaces the explicit own-chat route change that opened a new part with a handoff and
transcript. For picks that reach the history decision, a crossing pick with history returns
`bot/refused` with reason `needs-new-conversation` and keeps the original selection. A hookless
host keeps its earlier `handoff unavailable` refusal for ordinary history. Use New conversation,
then pick the route again. If the Bot has an active goal, pause it before New conversation.

For this decision, every derived user message counts except the team kickoff, the exact
fresh opening for the current part, and the following source kinds: `runtime-context`,
`working-directory`, `time-context`, `tmux-context`, `agent-instructions`, `skill-catalog`,
`plan-mode`, `ds-bot-time-context`, and `ds-bot-memory-recall`. The DSH route-selection notice
is excluded by its text framing. A Bot-team fallback notice counts even though it shares
the `model-selection` source kind. Bot memory belongs to the Bot on every harness. Rollover and
edited openings, goal rounds, and every other user message count. A part with nothing said
takes the existing in-place path.

RFC 0003 still describes the DSH tool bridge, same-harness replay and the records of
Sessions that crossed earlier. Q7a leaves the in-place path's races, effort, rollback and
default fallbacks, automatic moves, the kickoff exclusion, and other route writers (Q7c)
owed. New conversation starts on the current route, so a Full access Bot whose CLI cannot
start a fresh Session needs that route restored or an access level that allows another
route. A managed history-free move onto the selected route belongs to the pending-input
delivery.

Failover never crosses a harness (2026-11-21). A failed request always holds the person's
request. So when the fallback model runs on another harness than the request that failed (a
local CLI the team carries counts as its own harness), the Bot team takes no fallback. The turn
fails with its own error, as before. The conversation records one notice of why no other model
answered; like the Full access notice it is a context line, shown in Advanced mode. No fallback
is taken, and no notice is written, in two more cases: when another selection on another harness
was made meanwhile, and on a Session that may not run a coding CLI. A fallback turn whose step
DSH fixes on another harness drops its fallback notice. A fallback on the same harness is
unchanged, and the Full access rule for a coding CLI still comes first. The rest (Q7b, the other
writers of Q7c, and the pending-input delivery) waits on DSH. A plugin check cannot be bound to
the moment DSH records a selection, and input that moves between parts has no durable receipt.
The ask is section 5 of RFC 0045, a proposal not yet merged.

The turn after a fallback turn is back on the Bot's own route, also after a restart. A Session
that a fallback moved to another harness before 2026-11-21 keeps its route until the person
picks a model or starts a New conversation. Since 2026-11-23 (#2061) that pick carries the
conversation (above).

### Mod by mod

| Mod (`herdr/mods/`) | What it does today | After the move |
|---|---|---|
| `am-sidebar` | Spaces, the bot and worker rows, the briefing hook, the guard, the updater, the CLI (`bin/`) | **Splits.** Rows become the team tree (bots-dsh). The CLI, the briefing (`briefing.mjs`), the guard (`hcGuard.mjs`, `hcProxy.mjs`, `guard/`), the ledgers and the meter install path stay shared and move to `am/` as their source (today `am/` holds byte copies). The updater ends with the pack. |
| `am-automations` | Scheduled agent prompts through the `herdr-automations` CLI and the vendored scheduler (`herdr/scheduler/`, pinned in `scheduler.js`) | **A page in the app**, still driving the same CLI with `--json`; the scheduler stays a shared install through `am` (#220). The Bot team's own schedules (`client/schedules.js`) stay separate (Q10). |
| `am-quota` | The Accounts panel: which account the local agent clients use, through the account proxy | **A page in the app's settings**, beside the Models page (`client/providers-page.js`). The Claude login switches through RFC 0043's locked `set-login` (delivery 5b); this computer's Codex and proxy switch stays the panel's until an amendment to RFC 0043's Q5 moves it to one locked CLI writer (Q23, 2026-11-20). Shared CLI code lives in the pack's source and `am`'s byte copy until delivery 8 moves the source to `am/`. |
| `am-new-menu` | Start a bot or worker from a menu | **The tree's New**, on this computer, in delivery 6a (Q17, 2026-11-20); starting on a linked machine is deferred. |
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

**What ends:** herdr-app as part of Automagik's install (once Pocket Link runs without it, Q20,
2026-11-20), the pack's UI mods, its layout and its
updater (the herdr lane's pack pointer).

### The pack after the move

**Recommended:**

1. **Fix-only from this RFC's acceptance** until the pack's last release (2, as Q19 set it on
   2026-11-20): security and breakage fixes on the herdr lane as today; no new features in
   the pack's UI.
2. **One last pack release** once deliveries 1 and 2 as shipped (the take-over left out), 5 and 6a
   are in one stable release, and the Accounts page carries RFC 0043's per-machine view, the plan's
   preview, approval and apply, and its retries (Q19, 2026-11-20). Its update notice says Code now
   lives in the Automagik app, with a link. Installed packs keep working; nothing switches them off
   remotely, and the pack never deletes data. The herdr-lane pointer is signed one last time; no
   field is added to it (a new field is an RFC 0011 change).
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
  herdr-app and the pack; herdr-app leaves it only once Pocket Link runs without it (Q20,
  2026-11-20).
- **Delivery 8 (shared Bots) stands for its desktop and plugin parts:** one Bot id in both
  places, a Bot with a live pane is shown. Its herdr part (the Work button sends its pane's Bot)
  ends with `am-footer`.
- RFC 0013's Status names this RFC; its Decided 1-7 stand while herdr-app is installed.

### The image

**Recommended:** the server image (`server/Dockerfile`) gains what Code mode needs and nothing
about where it runs:

- **herdr-core**, pinned by version and sha256 the way `apps/desktop/wslc/Dockerfile` already
  pins its `hc`, never through an installer that resolves "latest".
- **`am`** of the image's own release, pinned and checked against that release's `.sha256`
  (Q22, 2026-11-20; #1869): the rolling am-lane signature names only the newest version.
- **The agent CLIs** (Claude Code, Codex, ...) come from DSH's CLI store, which installs their
  current versions into the volume in the background at every boot, with integrity checks;
  `AUTOMAGIK_CLI_INSTALL=off` skips it. None is baked in, so the image stays one size for
  everyone (Q21, 2026-11-20; #1869).
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
- `switch-route` and `update-bot` take `stopReply`; for a populated own chat `switch-route`
  answers `status: 'switching'` and moves it to a new part with a handoff (2026-11-23, #2061);
  without `stopReply` while a reply runs it returns `bot/refused` with reason `reply-running` and
  changes nothing; a crossing to or from a Hermes route still returns reason
  `needs-new-conversation`; `update_bot` from a Bot refuses a crossing with history. A Bot's model
  state (`work.models[botId]`) carries `switching: { to, since }` while it runs and reports a
  failed switch as `MODEL_SWITCH_COMPACTION_FAILED` with `ref` and `kept` (as
  `MODEL_OWN_TOOLS_DENIED` when the Bot denies `acp_tool` and the switch, or its way back, would
  run an agent's own tools); a part segment carries `switchedTo`; an earlier page and its divider
  carry `switchedTo`; `read_own_chat` takes `before`; acp-dsh's one-tool `dsh-history` bridge
  (D2). The 2026-11-26 [handoff note amendment](#handoff-note) records the shared `dsh` bridge.
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
| A populated own chat crosses through the model picker | Q7a refuses the pick before selecting a route or starting a switch (2026-11-20; since 2026-11-23 only on a Hermes route) |
| A prompt reaches the old agent while a switch runs | The switch job takes over every step of the old part before the model is called and moves its input behind the handoff; the composer is locked; the new route is selected, and the handoff put in, only on a part no surface can reach yet; a running reply is stopped only with the person's consent (`stopReply`) (Handoff note, 2026-11-23) |
| The new agent reads beyond its own chat | `read_own_chat` reads only the asking Session's Bot's own chat; `dsh-history` (D2, not in D1) will list and run that one tool; secrets and credential shapes are masked in its output and in the handoff. See the 2026-11-26 [handoff note amendment](#handoff-note) for the shared `dsh` bridge. |
| A Bot moves its chat's history to another vendor without the person | `update_bot` refuses a crossing with history; only the person's pick or Apply on `propose_bot_change` switches (Handoff note, 2026-11-23) |
| The summary reaches a model the person did not pick | the outgoing agent writes it (its own route, or a hidden turn in its own chat); no background model; none at all past 45 seconds |
| A watching view reflows a terminal someone is using | The app never resizes a terminal, watching or typing (Q15, 2026-11-20) |
| A terminal on a linked machine is reached before its link is scoped | Linked machines are view-only and unlisted until delivery H (RFC 0022 (k)) |

## Deliveries

Each is one PR on one lane. Two tracks run in parallel:

- **The selector track:** delivery 4 (issue #1016, an overdue build ask of the owner's) runs
  after Q13 and Q14 only. It needs nothing from deliveries 0-3, Q1-Q3, #1009 or RFC 0028: it
  changes the model menu, and Q7a adds the populated own-chat refusal. The track attaches to no
  terminal.
- **The Code track:** 0, 1, 2, 3a, 3b, then 5, 6, 7 and 8; since the 2026-11-20 amendment, 5 and
  6a may land before 3, in the order of its What moves now.

Every test uses temp homes, fake ledgers and a herdr-core started for the test, never a live
Herdr install.

0. **Owner's answers** to Q1-Q3 (the conflicts with #1009) and RFC 0022's revision approved.
   *Acceptance:* this RFC's Status records them; no build on the Code track before. Delivery 4
   is not held by it.
   *Status, 2026-11-19:* met. Q1-Q3 are answered (Answers), and the owner's delegate approved
   RFC 0022's revision the same day (its Answers). Deliveries 1 and 2 shipped parts before it
   (#1391, #1394).
1. **The flip, end to end, on this computer** (plugin; after RFC 0022's delivery B, the bar). The
   first slice. In Code mode the tree lists this computer's projects, bots and workers from the
   registry and the two ledgers; a click renders that terminal live in the right pane, view-only;
   the flip back shows the human-facing bot's DSH chat, which never moved. The desktop app first;
   the browser half needs RFC 0024 delivery 2's gate and, behind it, a proof bound to each
   request of the claimed owner's passkey session (Q18, 2026-11-20, an amendment to RFC 0038);
   in the gate's Access mode the Code side stays off in a browser. The owner's delegate decided on
   2026-11-21 that the browser half also requires member admission on and RFC 0038 delivery 3's
   readiness; with member admission off, and in Cloud mode, it stays off (RFC 0038's amendment of
   2026-11-21).
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
   - 3a (herdr): `am mailbox send` in the pack's CLI (in `am/` if delivery 8 has moved the CLI's
     source there), with its terminal stamp, released only when 3b is ready (Q16, 2026-11-20).
     *Acceptance:* the herdr gate, and `node scripts/am-copies.mjs --check` passes with `am/`'s copy
     regenerated by `--write`, never edited by hand.
   - 3b (plugin): the orchestrator as a lead worker, the mailbox follower, the two row kinds.
   *Check:* an `answer` with a known request id reaches the Genie's Session once across a crash,
   and once after a host restart for a row written while the host was down; an unknown id, an
   unknown kind and a report are refused and stay out of the chat; a row posted from any terminal
   but the lead's, or without a stamp, is refused; an `<hc>` tag in a row is quoted; the
   orchestrator starts its own workers, while the Genie's `code_send` and `code_read` on those
   workers are refused by the grant. *Rollback:* a release without the mailbox; the orchestrator
   keeps its terminal.
4. **Route, then model, and the Q7a refusal** (plugin, selector issue #1016, after Q13
   and Q14, approved by the owner in a running build with light and dark screenshots).
   *Check:* the routes list Native, ACP, Herdr in that order and each bot type lists the
   routes Q13 gives it (a DSH bot lists Native only). A crossing asks for confirmation.
   A populated own chat refuses the pick, keeps its selection, and shows the guidance in
   the recovery card. After New conversation a crossing can apply in place while the
   fresh part contains only the opening and context listed above. A same-harness model
   change keeps the conversation. The DSH tool bridge and same-harness replay follow
   RFC 0003. Pending input and the other writers are later deliveries.
   *Rollback:* revert the selector and refusal to the preceding release.

   Delivery 4b (2026-11-23, #2061, the owner): a populated own chat crosses with its
   conversation (Handoff note). *Check:* Claude Code -> Codex, Codex -> a native model, native
   -> Claude Code, and omp and Antigravity where available, each keep one conversation with the
   composer locked during the switch, the "Switched to" line, an answer from the handoff and an
   earlier message read through `read_own_chat`; no switch is refused for history. A Bot's group
   conversation with history follows the switch with its own handoff and shows '<name> switched
   to <agent>' (second PR): its next reply comes from the new agent, which can say the group's
   last topic, and nothing of the outgoing agent's summary turn shows in the group.
5. **Automations and Accounts as pages** (plugin; any shared code it needs moves through the
   pack's source and `am-copies`, as in 3a). *Check:* the page lists, adds and
   removes an automation through the `herdr-automations` CLI's `--json`, and a quota switch
   written from the page reads back from the CLI. *Rollback:* the pack's panels stay.
6. **Start from the tree** (amended 2026-11-20, Q17: 6a on this computer, without #206, as the
   Amendment's What moves now, 6, specifies; starting on a linked machine is deferred). The New menu
   moves in. Global Bots and Bots only in a v2 registry are listed with Start disabled until the
   CLI starts them (RFC 0014; Decisions (2026-11-21), 5). *Check:* a start from the tree writes
   the attach ledger the same way the CLI does.
   *Rollback:* the tree reads only.
7. **Code mode in the image** (server image and plugin; after RFC 0024 delivery 2). herdr-core,
   `am`, agent CLIs enabled into the volume, sign-in. *Check:* before the claim no terminal is
   shown; after it a fresh image signs an agent in, starts the Genie and shows its orchestrator's
   terminal in a browser; the secrecy scan finds no credential in the image. The automated part
   uses a fake agent CLI; the real sign-in is a manual step, on a test account of the tester's
   own, and no account is named in the repository.
   *Rollback:* an image without herdr-core; Team works as today.
8. **The pack's last release and retirement** (herdr, then a removal PR; amended 2026-11-20, Q19:
   once The pack after the move, 2, holds). The notice, the last pointer, the shared parts' source
   moved to `am/`, RFC 0013 deliveries 7 and 8 re-scoped. *Check:* the herdr gate on the last
   release; the notice's text names the Automagik app and its link; the last pointer's sequence is
   higher than the one before and it adds no field (`scripts/herdr-lane.ts`'s own refusals); a pack
   installed in a temp home keeps working after the last release; the am gate with `am/` as the
   source; `scripts/entries.mjs --check` after the folders leave. *Rollback:* revert the removal;
   the pack keeps its fix-only lane.

Linked machines come after RFC 0022's delivery H, as a delivery of that RFC widened by its Q16,
not of this one. 6b, starting on a linked machine, is tracked there too (Decisions
(2026-11-21), 3).

## Amendment (2026-11-20): what moves now, and what waits

Approved by the owner's delegate on 2026-11-20, with every recommendation (Q15-Q23; see Answers
(2026-11-20) below). It keeps the current inventory of this RFC's deliveries, orders what
is left, names each piece outside this repository that holds one, and asks Q15-Q23 (below).
"The marked window" below is the desktop window #1788 marks: Electron keeps a secret and DSH
gets only its digest, so no other browser or tool reaches what it gates.

**What it changes.** Apart from the answers:

- The Code track's order ("0, 1, 2, 3a, 3b, then 5, 6, 7 and 8", Deliveries): 5 and 6a may
  land before 3, because 3 waits on herdr-core and they do not.
- Delivery 5 splits into 5a, 5b and 5c, and 5b switches through RFC 0043's `set-login` instead
  of the `am-quota` row's `write.js` and `lock.js` path (Mod by mod).
- Delivery 6 splits into 6a and 6b; 6a adds an explicit New action to the tree and a local-only
  start path to the CLI (Team tree's "Read, never run" holds for rows).
- Deliveries that span two lanes ship as one PR per lane, in order, as 3a and 3b do.
- The Lanes field's desktop line also covers a change in Electron's main process (What moves
  now, 7), not only the preload.
- CLI changes that come with a delivery here (6a's local-only start path, 3a's verb) land where
  the CLI's source is at the time: the pack's CLI on the herdr lane with `am/`'s generated
  copies, or `am/` once delivery 8 has moved the source there. The pack's UI stays fix-only.

Each answer changed text above it, applied on 2026-11-20 and marked there with its number:

- Q15: the Resize row and the Threat model's resize row.
- Q16 (a): delivery 3 keeps its prerequisites; 3a is released only with 3b.
- Q17 (a): the "after #206" left Team tree, the Mod by mod row for `am-new-menu` and delivery 6.
- Q18: delivery 1's browser half.
- Q19: The pack after the move, 1 and 2.
- Q20 (a): "What ends: herdr-app as part of Automagik's install" and the RFC 0013 delivery 7
  bullet, which wait for Pocket Link to run without herdr-app.
- Q21: Q5's answer and The image's agent CLI line.
- Q22: The image's `am` line.
- Q23: the Mod by mod row for `am-quota`.

Q16 (a), Q17 (a) and Q18 (a) are the answers given, so delivery 3 keeps its order and 6a moves now.

### Where delivery stands

| Delivery | Merged | Left |
|---|---|---|
| 0 | met 2026-11-19 | nothing |
| 1 | the desktop half: #1391, #1779, #1788 (the flip, the window marker, no core spawn) | the browser half (1b) |
| 2 | typing #1394; the watching-size rule and four panes #1810 | "Typing elsewhere" with a click to take over (no resize while typing, as shipped, is Q15's answer) |
| 3a, 3b | nothing (RFC 0028's durable wake log, its 0b, is merged: #1827) | all |
| 4 | the selector #1025; Q13's route policy #1822; Q7a #1863; failover never crosses a harness (Q7c's first writer, Handoff note) | Q7b, the note-only rule for a Bot's turns as a group member; the rest of Q7c, the other route writers (migrations, a pinned route, reopen) with the in-place path's races, effort, rollback, default fallbacks and automatic moves (Handoff note); the pending-input delivery for the in-place and automatic moves (the explicit own-chat crossing with history ships as 4b, #2061). All three wait on DSH (What waits) |
| 5 | 5a, the Automations page: #1817 | run now, history, edit, pause and resume on that page; 5b (the Claude login); 5c (Codex and the account proxy) |
| 6 | nothing | all |
| 7 | the image half of the base: #1869 carries herdr-core 0.1.18 pinned by version and sha256, `am` pinned to the release's content and checked against its `.sha256`, and DSH's CLI store installing Claude Code and Codex in the background (`server/README.md`) | 1b; the end-to-end check, which also needs delivery 3's orchestrator (#1869's provisioning is kept: Q21, Q22) |
| 8 | nothing | all |

### What moves now

Each needs nothing from another repository. In this order:

1. **The owed wording, docs only.** RFC 0028 gains the `lead` worker kind (Q8's answer), in its
   own PR. RFC 0028's Words rows for "Code" (still herdr-app) and "Code mode" (still the chat
   view's switch to xterm), its line that workers get no rows of their own, and RFC 0022's uses of
   "Code mode" change to Q9's answer and RFC 0022's Q15 answer, with no change to either RFC's
   design. Delivery 3b is built on the lead kind's text, so it is settled before the grant exists.
2. **Delivery 4's remainder** (plugin): failover never crossing a harness moved (2026-11-21).
   Q7b, the rest of Q7c and the pending-input delivery wait on DSH (What waits). Hermes stays
   out while it is frozen.
3. **Delivery 5a's remainder** (plugin), through the scheduler CLI's own verbs
   (`herdr/scheduler/main.go`, its usage text), from the owner's marked window only, as 5a:
   history with `history --json`; edit with `put --original <name>`; pause and resume with
   `pause` and `resume`, read back from `list --json`; run now with `run <name> --bg`. That verb
   prints nothing and its exit status only says the run was started, so the click stays
   "requested": the CLI gives no run id that ties a history row to it, and a scheduled run of the
   same automation, or a run recorded as skipped, may be the next row. Beside it the page shows
   the automation's newest history row with its trigger and status, as history, never as this
   click's result.
4. **Delivery 5b, on RFC 0043's writer** (plugin). RFC 0043's deliveries 1 (#1901) and 2 (#1914)
   are merged: `am accounts here` reads, and one locked `set-login` writer switches. 5b's first plan
   added a second writer, and its review found that it could erase a panel edit; so 5b adds none.
   Its page reads through `accounts here` and switches through `set-login`, both with `--json`, and
   passes the snapshot it showed, so a conflict keeps the other edit and is read again. It switches
   only where RFC 0043's writer qualification holds for that app home
   (`herdr/mods/am-sidebar/accountsWrite.js`, `writerQualified`: the CLI writes through
   `set-login`, and the panel is off or absent, or on and confirmed writing through it too);
   elsewhere it shows why and changes nothing. *Check:* in a marked desktop window with a fake
   `claude`, a switch reads back from the CLI; an enabled older panel beside a newer CLI refuses
   the switch; a standalone CLI with no panel switches; an unmarked browser gets nothing.
5. **Delivery 5c, the read half** (plugin): the page shows this computer's Codex account read-only,
   from the default `CODEX_HOME`. The proxy's state needs its management key, which the panel takes
   from Herdr's environment or the proxy's own key file; the page shows it as "unknown" until the
   amendment Q23 asks for settles which process supplies that key. Moving the switch itself waits
   for that amendment (Q23). Copying Codex credentials to linked machines is not part of 5c: it
   stays RFC 0043's delivery 3, behind its qualified transport and the owner's trial.
6. **Delivery 6a: start from the tree, on this computer** (plugin; Q17 answered). #206's last open
   point (`am` on a linked machine) goes to RFC 0012's Fleet delivery and does not change the
   start path, the attach ledger's rows or `whois --json`. The tree gets an explicit **New**
   action; a row's click stays read-only. New runs the pack's CLI from the host, from the marked
   window only, on a start path that is local only: it lands on this computer's own core (the
   local holder) and consults no linked terminal, while keeping the CLI's duplicate-seat check.
   Today an explicit local holder still reads every connected ledger binding, linked ones
   included (`holderForStart` calling `holderView` in the pack's CLI,
   `herdr/mods/am-sidebar/bin/automagik-herdr.mjs`), so 6a adds that local-only path there
   first (herdr lane). The attach ledger is
   written by the CLI itself. *Check:* against a fake `hc` with a two-holder pool and a connected
   linked binding, a start from the tree writes the same ledger row as the CLI on the local holder
   and makes zero calls toward the linked machine; an unmarked window starts nothing.
   Global Bots and Bots only in a v2 registry are listed with Start disabled until the CLI starts
   them (RFC 0014): the CLI reads only a project's v1 `.herdr/bots.json`, and a folderless global
   Bot has no CLI project (Decisions (2026-11-21), 5).
7. **Fixes left by #1788** that need nothing outside: the pack's `coreSocket.mjs` discovery gaps
   (`HC_SOCKET` first, a `config.toml` socket, session names with spaces, lock paths without
   `.sock`), a herdr fix under the pack's fix-only rule; opening a registry Bot's own Herdr space
   from a Code row while herdr-app is installed (Q2), a desktop change as well as a plugin one,
   because Electron resolves a Bot only from the Bot team's `state.json`
   (`apps/desktop/src/herdr-space.js`) and needs a trusted registry lookup. *Check:* a Bot that
   exists only in the registry opens its own space.

### What waits, and on what

| Item | Waits on | Whose |
|---|---|---|
| Delivery 4's remainder: Q7c beyond failover, the in-place and automatic moves' pending input, and the rest of Q7b (not 4b's explicit crossing, which a plugin fence covers for the own chat and its group conversations, Handoff note) | A DSH fence that records a model selection only if no input was admitted and no turn started since the host read the Session (a revision checked inside DSH's admission lock), and input that keeps the part it was meant for and moves with a durable receipt. Three plugin-only review rounds (2026-11-21) found both missing: DSH's `selectModel` awaits before it records the selection, and text prompts are admitted outside that lock. Asked in section 5 of RFC 0045, a proposal not yet merged | DSH (another repository) |
| 3b, the Genie's two seats and the follower | RFC 0028's delivery 0, the grant, then its delivery 1 (the worker tools); the lead kind (above). The grant is herdr-core's, filed from #628 and #631 (both open) | herdr-core (another repository) |
| 3a, `am mailbox send` | 3b (Q16) | herdr-core, through 3b |
| The mailbox for a DSH Bot that runs in a terminal | RFC 0023's session terminal field (The Genie's two seats and the mailbox); until DSH ships it, the mailbox reaches app-hosted Sessions only | DSH (another repository) |
| 2's take-over from another typer | a signal from herdr-core that says which client is typing into a terminal. Until then a refused take stays "Typing elsewhere · view only" | herdr-core |
| 1b, the browser half | RFC 0022's delivery B (paused for scheduling, not for its design; its drawing is the current bar's design, decided by the owner's delegate on 2026-11-21, Decisions (2026-11-21), 2); and the owner proof behind the gate that Q18 set (RFC 0038's amendment of 2026-11-21, which, by the owner's delegate's decision of 2026-11-21, also requires member admission on and RFC 0038 delivery 3's readiness). The gate is in the image (`server/gate*.mjs`) and RFC 0038's delivery 1 (#1892) checks its caller assertion, but only for members and guests; the owner reaches DSH through the stock app's fallback (`apps/multiuser-dsh/README.md`), so the core bridge cannot yet tell the claimed owner from any browser | this repository (B, an RFC 0038 amendment, then the plugin) |
| 7, Code mode in the image | 1b; delivery 3 for its end-to-end check (Q21 and Q22 keep #1869's provisioning) | herdr-core (through delivery 3), then this repository |
| 5c's switch | an amendment to RFC 0043's Q5 (Q23) | this repository |
| 6b, starting on a linked machine | deferred (Q17): RFC 0022's delivery H allows a shown terminal's view and input but refuses `run`, `exec` and file writes on a link, and H's own scoping is upstream in herdr-core. Tracked under RFC 0022 delivery H (Q16), not a gate for #1007; a start scope on a link is designed as an amendment to H once herdr-core ships its scoping (Decisions (2026-11-21), 3) | herdr-core, then RFC 0022 |
| 8, the pack's retirement | Q19's condition: 1, 2 as shipped, 5 (the panel's Add and Remove login on the page included, through `set-login`: Decisions (2026-11-21), 1) and 6a in one stable release, with 5c's switch (Q23) and an amendment to RFC 0043 that moves a plan's apply and its retries off the pack; removing herdr-app from Automagik's install waits for Pocket Link to run without it (Q20), as its own Pocket-owned part (Decisions (2026-11-21), 4) | this repository, then Pocket |
| A linked Claude bot's per-turn briefing | `am` on the linked machine, RFC 0012's Fleet delivery (its amendment is #1932). Not a gate for any delivery here (Q17) | this repository |

### Questions for the owner (2026-11-20)

The recommended option comes first. All were answered the same day (Answers (2026-11-20)).

15. **Who sets a terminal's size while the person types in the app?**
    (a, recommended) Nobody in the app: Code mode never resizes, typing included, as RFC 0022's
    approved revision says ("Size: Code mode never resizes the pane") and #1394 and #1810 ship.
    The Resize row above and the Threat model's resize row are amended to say so.
    (b) The typing client sets it, as the Resize row says today: RFC 0022's revision is amended
    and delivery 2 sends a resize while the person types, which reflows the terminal for
    herdr-app and the phone.
16. **When `am mailbox send` (3a) ships.** Either way, a send that succeeds means the row is
    queued for the follower's checks. The follower admits a row only from the lead's terminal and
    only of an allowed kind: an `answer` must carry a request id the Genie sent; a `question`
    needs none. An admitted row is delivered once, within RFC 0028's durable wake log, whose
    limits still apply (a row older than 7 days, or one whose two resends are spent, is dropped
    and logged, not sent again).
    (a, recommended) With its reader: 3a is released only once 3b, RFC 0028's delivery 1 and the
    lead kind are ready.
    (b) Now. Until 3b creates a lead, no row can come from a lead's terminal, so every row
    written before then is refused when the follower starts; nothing posted early reaches the
    Genie.
17. **Starting from the tree.**
    (a, recommended) 6a (this computer) now, without #206, whose last point goes to RFC 0012;
    starting on a linked machine is deferred, and the tree on a linked machine stays read-only.
    (b) 6a now, and a separately scoped start capability on a link is designed: an amendment to
    RFC 0022's delivery H, which today refuses `run`, and a scope herdr-core must grant.
    (c) Delivery 6 keeps waiting for #206's last point.
18. **How the core bridge knows the gated owner (1b).**
    (a, recommended) In the gate's claim and passkey mode, every request to the Code side's routes
    carries a proof bound to that request and to the owner's own passkey session, whether member
    admission is on or off. An admin, a request with no verified caller and a direct browser
    request outside the gate are refused. In the gate's Access mode every allowlisted address gets
    the same owner principal (`server/README.md`), so one person cannot be told from another, and
    the Code side stays off in a browser there. Designed as an amendment to RFC 0038, with no DSH
    change. *Check:* a second allowlisted Access address is refused.
    (b) As (a), and in Access mode every allowlisted address may use the Code side for the
    instance's own terminals only, as the instance already treats each of them as the owner. This
    amends condition 1 of RFC 0022's (l) for instance-local terminals; a linked machine's seats
    keep all four of (l)'s conditions and delivery H.
    (c) Wait for DSH's own authentication hook upstream (RFC 0024's Decided 21).
19. **When the pack's last release goes (delivery 8).** The pack stays fix-only until then.
    Under every option, packs already installed keep their panels and keep working (The pack after
    the move, 2); a fresh install after retirement gets no pack, so it has only the app's pages and
    the CLI (which already starts bots and switches the Claude login); and if the last release
    goes before 3a, `am mailbox send` lands in `am/`, the CLI's source from delivery 8. Delivery
    1b is not required by any option: the desktop app is the replacement.
    (a, recommended) After deliveries 1 and 2 as shipped (the take-over left out), 5 (5c's switch
    included, under Q23) and 6a are in one stable release, and the Accounts page also carries
    what the panel gained from RFC 0043 (the per-machine view, the plan's preview and approval,
    apply, retries). Today a plan's apply refuses without an enabled `am-quota` folder and the
    sidebar runs its retries, so this option includes moving both off the pack. *Check:* on a
    fresh install with no pack, a plan applies from the page and a failed machine is retried.
    (b) The same, without RFC 0043's plan on the page: a fresh install keeps the Claude and Codex
    switches of this computer, and loses a plan's apply and its retries, which need the pack.
    (c) After delivery 2's typing and four panes are in a stable release, before 5 and 6: a fresh
    install starts bots and switches the Claude login only through the CLI, and has no Codex or
    proxy switch, no plan apply and no retries until those land.
    (d) Today's rule (The pack after the move, 1 and 2, read strictly): after all of delivery 2,
    the take-over included, which waits on herdr-core; until then the pack stays fix-only and a
    fresh install still gets it.
20. **Removing herdr-app from Automagik's install.** Q11 leaves Pocket Link's host to Pocket.
    (a, recommended) herdr-app leaves the install only once Pocket Link runs without it; until
    then the install keeps herdr-app with no pack UI.
    (b) herdr-app leaves the install at delivery 8; a person who uses Pocket keeps or installs
    herdr-app on their own until Pocket's answer.
21. **The image's agent CLIs, after #1869.** Q5 answered "installed into the volume on first
    enable, none baked into the image"; #1869 ships DSH's CLI store, which installs the current
    Claude Code and Codex in the background under `$AUTOMAGIK_HOME/acp/clis`, with integrity
    checks, and `AUTOMAGIK_CLI_INSTALL=off` to skip it.
    (a, recommended) Keep #1869's store. None is baked into the image, which was Q5's reason. This
    gives up the pin and the install-on-enable rule: the store installs npm's current versions in
    the background at every boot. Q5's answer and The image's agent CLI line are amended to say so.
    (b) Rework delivery 7 to Q5's letter: pinned versions, installed only when the person enables
    an agent.
22. **How the image trusts `am`.** The image's line above says `am` comes "from its signed lane";
    #1869 pins the release's own `am` and checks it against that release's `.sha256`, because the
    rolling am-lane signature names only the newest version and cannot vouch for an older pin
    (`server/README.md`).
    (a, recommended) Keep #1869's check; The image's `am` line is amended to say the image takes
    the `am` of its own release, checked by sha256.
    (b) Check the image's `am` against the signed am-lane pointer at build time, which works only
    while the image's version is the pointer's.
23. **The local Codex and proxy switch's writer (5c).** RFC 0043's Q5 keeps this computer's
    switch in the panel, where Herdr supplies `CODEX_HOME` and the proxy's management key.
    (a, recommended) It stays the panel's until an amendment to RFC 0043's Q5 moves it to one
    locked CLI writer, says how that writer gets the same home and key as the panel, and keeps one
    writer during the move (an older panel refused, as for `set-login`); 5c's page reads only
    until then.
    (b) 5c moves the switch now, under this RFC instead of RFC 0043, with the same three
    conditions defined here: the host process that supplies `CODEX_HOME` and the proxy key, one
    locked CLI writer, and an older panel refused during the move.

### Answers (2026-11-20)

The owner's delegate approved this amendment on 2026-11-20 and answered every question with its
recommended option:

15. **Q15:** Code mode never resizes a terminal, typing included; the Resize row and the Threat
    model's row say so.
16. **Q16:** `am mailbox send` (3a) ships with its reader: 3b, RFC 0028's delivery 1 and the lead
    kind ready.
17. **Q17:** 6a (this computer) now, without #206, whose last point goes to RFC 0012 (#1932);
    starting on a linked machine is deferred, and the tree on a linked machine stays read-only.
18. **Q18:** in the gate's claim and passkey mode, every request to the Code side's routes carries
    a proof bound to that request and to the owner's passkey session, whether member admission is
    on or off; an admin, a request with no verified caller and a direct browser request outside
    the gate are refused; in Access mode the Code side stays off in a browser. Designed as an
    amendment to RFC 0038, with no DSH change.
    *Narrowed by the owner's delegate on 2026-11-21:* this decision replaces "whether member
    admission is on or off". The Code side in a gated browser requires member admission on and RFC
    0038 delivery 3's readiness, and it is off otherwise, as in Access and in Cloud mode, until a
    later amendment (RFC 0038, Amendment (2026-11-21)).
19. **Q19:** the pack's last release goes once one stable release carries delivery 1 (the desktop
    half), delivery 2 as shipped (the take-over left out), all of 5 (5c's switch included) and 6a,
    and the Accounts page carries RFC 0043's per-machine view, the plan's preview, approval and
    apply, and its retries, with apply and retries moved off the pack. Installed packs keep their
    panels.
    *Clarified by the owner's delegate on 2026-11-21:* "all of 5" includes the panel's Add and
    Remove login on the Accounts page, through RFC 0043's `set-login` (Decisions (2026-11-21), 1).
20. **Q20:** herdr-app leaves Automagik's install only once Pocket Link runs without it; until
    then a fresh install after the pack's retirement keeps herdr-app with no pack UI.
    *Followed by the owner's delegate on 2026-11-21:* Pocket Link runs without herdr-app as its
    own Pocket-owned part (Decisions (2026-11-21), 4); Q20's condition is unchanged.
21. **Q21:** the image keeps #1869's CLI store, which installs npm's current versions in the
    background at every boot; no agent CLI is baked into the image. Q5's answer and The image say
    so.
22. **Q22:** the image keeps #1869's `am`, its own release's, checked by sha256.
23. **Q23:** this computer's Codex and proxy switch stays the panel's until an amendment to RFC
    0043's Q5 moves it to one locked CLI writer that gets the same `CODEX_HOME` and proxy key as
    the panel, with an older panel refused during the move; 5c's page reads only until then.

### Decisions (2026-11-21)

The five points the 2026-11-20 amendment left with the owner. The owner's delegate decided each
on 2026-11-21 with its recommended option; none changes a design above, and each changed text is
marked there with this section's number. None touches a private key, Play, real data or money.

1. **D8's gate: Add and Remove login.** Q19's "all of 5" includes Add and Remove login on the
   Accounts page, through RFC 0043's `set-login`; decided by the owner's delegate, 2026-11-21,
   recommended option. The panel's sign-in probe runs before `--add`, so a fresh install with no
   pack loses nothing the panel had. Q19's answer and What waits, 8, say so.
2. **RFC 0022 delivery B's drawing (1b).** RFC 0022 delivery B's drawing is the current bar's
   design (existing components and docs/brand tokens, no new visual item); decided by the owner's
   delegate, 2026-11-21, recommended option. B's behaviour follows (i) as approved on 2026-11-19.
   RFC 0022's delivery B and Status record it; What waits, 1b, no longer waits on the owner. 1b
   still needs RFC 0038 delivery 7's proof and delivery 3's readiness with member admission on.
3. **6b, starting on a linked machine.** 6b stays deferred and moves to RFC 0022 delivery H, out
   of #1007; decided by the owner's delegate, 2026-11-21, recommended option. H keeps refusing
   `run`, `exec` and file writes on a link; once herdr-core ships H's scoping, a start scope on a
   link is designed as an amendment to H, under RFC 0022. What waits, 6b, and RFC 0022's delivery
   H say so.
4. **Pocket Link without herdr-app (Q11, Q20).** Pocket Link runs without herdr-app as its own
   Pocket-owned part, installed and started by `am`, paired with `am pocket pair` (RFC 0012's
   proposal), specified in a Pocket RFC and an RFC 0012 amendment; herdr-app stays in the install
   until it ships; decided by the owner's delegate, 2026-11-21, recommended option. The Pocket RFC
   ([RFC 0046](0046-pocket-link-without-herdr-app.md)) and the RFC 0012 amendment follow in their
   own pull request; Q11's and Q20's answers are
   unchanged.
5. **6a's Bots with no CLI start path.** 6a PR 2 lists global and v2-only Bots with Start
   disabled and their reasons; each is enabled by its own CLI start path later; decided by the
   owner's delegate, 2026-11-21, recommended option. A global Bot with no folder (RFC 0014) and a
   Bot only in a v2 registry, which the CLI does not read yet (RFC 0014 delivery 2), each get a
   herdr-lane CLI start path, then a small plugin change enables its rows. Delivery 6 and What
   moves now, 6, say so.

## Amendment (2026-11-23): four later deliveries

A read of this RFC against its deliveries on 2026-11-23 found four pieces of its design that no
delivery names: none is in deliveries 0-8, in the 2026-11-20 amendment or in Decisions
(2026-11-21), and none is built. This amendment names each as a later delivery, L1-L4, so every
piece of Code mode still to build has a named delivery. It changes no design, no order and no
condition above; Q19's condition for the pack's last release stays as answered. The lines are
this file's at this amendment.

| Later delivery | Scope | Source in this RFC | Schedule |
|---|---|---|---|
| L1, the Markdown view | A terminal's printed `.md` paths open in the app's own Markdown view | Mod by mod, the `am-markdown` row (line 335) | not scheduled |
| L2, the header's counts | The machine, branch and agent counts show in the tree's header | Mod by mod, the `am-status` row (line 332) | not scheduled |
| L3, the phone dot | The phone dot shows in the tree's header, read from Pocket Link's published state | Mod by mod, the `am-footer` row (line 333) | not scheduled |
| L4, the mailbox for a DSH Bot in a terminal | Delivery 3's mailbox reaches a DSH Bot that runs in a terminal (a dsh-tui seat): the bridge finds its Session from the session terminal field (RFC 0023, section 4), once DSH ships that field | The Genie's two seats and the mailbox, its last bullet (lines 247-250); What waits, the mailbox row (line 655) | not scheduled |

## Answers (2026-11-19)

The owner's delegate accepted this RFC on 2026-11-19 (issue #1007) and answered every open
question with this RFC's own recommendation. The answers restate those recommendations.
Q7a amends the crossing rule in Q7 and Q14.

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
   image. Amended 2026-11-20 (Q21): DSH's CLI store installs npm's current versions into the
   volume in the background at every boot; none is baked in.
6. **Q6:** the Community entry is never opened, and `herdr/` stops being its folder when the pack
   is retired.
7. **Q7:** Sessions that already crossed harnesses keep their records. Q7a removes
   `switchRoute`'s managed history-carrying switch for a populated own chat. Use
   **New conversation**, then pick the route again. Pause an active goal before New conversation.
   An own chat with nothing said can change in place as defined under Handoff note.
   `dshTools` and same-harness replay follow RFC 0003. The limitations and later work
   listed under Handoff note remain owed. Amended 2026-11-23 (#2061): the managed
   history-carrying switch is back for an explicit pick, with a handoff and `read_own_chat`
   (Handoff note); Hermes routes keep the refusal. A Bot's group conversations follow that pick
   (Handoff note).
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
14. **Q14:** an agent change inside ACP or Herdr counts as a route change under Decided 6.
    A model change inside one agent keeps the conversation. Since 2026-11-23 (#2061) an agent
    change keeps the conversation through a handoff (Handoff note).

From this acceptance the pack is fix-only (The pack after the move, 1): security and breakage
fixes on the herdr lane as today, no new features in its UI, until deliveries 1 and 2 are in a
stable release. Amended 2026-11-20 (Q19): until the pack's last release, as The pack after the
move, 2, now sets it.

## Open questions

Answered on 2026-11-19. Q7 and Q14 reflect the Q7a amendment. Q1-Q3 were conflicts with
#1009 (RFC 0022's revision), then an open pull request. Q8-Q9 were conflicts with #1008
(RFC 0028), also open then. Q7 concerns RFC 0003.

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
7. **Sessions that already crossed harnesses under RFC 0003's replay.** Keep their records.
   For the next explicit crossing pick in a Bot's own chat, use the Q7 answer above.
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
14. **An agent change inside a route** (Claude Code to Codex, both ACP). Each agent is its
    own harness, so the change follows Decided 6. A model change inside one agent keeps the
    conversation.

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
