# RFC 0015: Live chat projection

| Field | Value |
|---|---|
| Status | In delivery (deliveries 1-5: #267, #273, #280, #282, #286, #574; later work: #523, #655, #670, #675, #680; 6-8 unconfirmed; every question answered; amended 2026-11-07: writes on DSH chats, global Bots included; amended 2026-11-19 by [RFC 0036](0036-bot-management-from-pocket.md): Bot management from Pocket, approved by the owner's delegate) |
| Milestone | none (ships outside the five milestones) |
| Lanes | herdr (3.N.P, Pocket Link included), plugin (3.N.P), pocket (3.N.P, [RFC 0011](0011-monorepo-parts-and-releases.md)) |
| Created | 2026-11-03 |

## Summary

A Herdr code Bot is one live agent in a terminal. This RFC makes that same agent a chat in every
other window: the Automagik window and the phone show its turns, approvals and status, and what
the person types there goes into the terminal as keys. Nothing new runs the agent; the chat is a
projection of the terminal, read from the agent's own transcript first, then herdr-core's
status, then the screen. It decides where the projection's code lives (JavaScript beside Pocket
Link, D32), what we take from Orca (MIT, D31) and how it is credited, how a transcript is found
and kept inside the agent's own folders, how text, approvals and interrupts are typed, and the
phone's new Pocket Link route. RFC 0014's deliveries 8 and 9 build on it.

## Motivation

The owner decided one conversation per Bot, seen from every window (D29), and two chat backends
(D30): work Bots keep DSH's structured (ACP) sessions; Herdr's code Bots stay terminal agents
and get a live chat view. Today:

- The Automagik window cannot show a Herdr agent at all; RFC 0014 lists exposed Bots but leaves
  their chat to this RFC ([0014](0014-shared-bot-registry.md) "Herdr Bots in Automagik").
- The phone shows a Herdr terminal as a terminal. Pocket Link pipes each paired phone's stream
  straight into `hc connect` (`herdr/mods/pocket-link/bridge/bridge.mjs:102-132`), and the app
  speaks herdr-core's API through it (`apps/pocket/.../CoreClient.kt:27-100`: `terminal.attach`,
  `terminal.send`, `terminal.keys`, `terminal.read`, `file.read`). A long agent turn on a phone is
  a small screen of scrolling text.
- Herdr already ties a Claude session to its terminal, but only for panes it briefs. The briefing
  hook reads `session_id` and `transcript_path` from Claude Code's hook input, appends a
  `session` row with both to `<app home>/automagik-herdr/workers.jsonl`, and sets the terminal's
  `agent.session` label (`herdr/mods/am-sidebar/briefing.mjs:182-200`, `workers.js:304-334`). The
  transcript path never leaves this computer's ledger, and the hook runs only in panes Start or
  Attach set up, on the one Mac that has the pack's hooks (t22n's note; #206).

Orca (`github.com/stablyai/orca` at `e1dfc022`, MIT, © 2026 Lovecast Inc.) already shows
terminal agents as chat. The research note (`bot-chat-backend/orca-research-2026-11-03.md`) cites
its files at `ec3a707`; that is `e1dfc022`'s parent, and `e1dfc022` changes no file this RFC
takes or cites (it touches Orca's hook server and usage code), so the line numbers hold. This RFC
pins `e1dfc022`, as 0014 and the decision log do.

## Decided and proposed

Decided by the owner (handoff `bot-system-unification.md`):

- **D29: one live agent, every window.** An exposed Bot's chat in Automagik is the same live
  Herdr agent the terminal shows; Code shows the same session as a terminal.
- **Q19 (D29): Orca's way, drafts held.** The transcript file, found through our own briefing
  hook's `transcript_path`, is the source of truth; hc gives status and does the sends (a
  bracketed paste, then Enter as its own write). A half-typed terminal draft is never wiped: the
  message is held, with Send now. Not Orca's hook format or server, not ACP.
- **D30: two backends.** Herdr code Bots: the live projection, transcript tail > hooks > screen
  text; input and approvals as terminal keys; "user won't even know"; show terminal is always
  available. Automagik work Bots: structured DSH (ACP) sessions, unchanged by this RFC.
- **D31: vendor Orca's MIT code with attribution.** Its transcript decoders, the paste and Enter
  sequence, the approval envelope and key map, and the types. We own the copies afterwards.
- **D32: where it lives.** JavaScript in `herdr/`, next to Pocket Link (Node); the Automagik
  window imports the same module; the phone (Kotlin) only renders. Not usagemeter, not a new Rust
  daemon.

Required by t2x5's review of RFC 0014 (its Threat model, "The chat projection"): rows render as
text or sanitized markdown only; `transcript_path` is accepted only inside the agent's own
transcript folders, here and through `hc file read --on`; pasted text loses `ESC[200~`,
`ESC[201~` and every other control sequence; the briefing hook passes the transcript path on.

Decided by the owner on this RFC (2026-11-03, relayed by t2ws), each as recommended:

- **Q1: where the module lives.** Source in `herdr/mods/pocket-link/chat/`, so a copied Pocket
  Link carries what its bridge runs; a byte-equal copy in `apps/bots-dsh/src/host/live-chat/`,
  checked by both gates; a change ships herdr first, then the plugin.
- **Q2: Send now appends.** The held message is pasted after the terminal's half-typed draft and
  both are sent as one message. The chat warns first ("Sends your half-typed terminal text with
  it"); nothing is cleared or retyped.
- **Q3: every Claude pane, on a yes.** Herdr offers once "Show every Claude pane as a chat"; on
  yes the pack adds a label-only hook to the person's Claude user settings.
- **Q4: no redaction in this RFC.** Rows are never stored on the phone or logged.
- **Q5: the approval source is a hook where it runs.** D30's middle source is hooks: a
  `PermissionRequest` hook hands the engine the pending tool and its input, in the hooks Start
  and Attach write and in Q3's one-time offer (delivery 8). Elsewhere (no hook yet, linked
  machines before #206) approvals fall back to the screen under the guards in "Input".
  herdr-core's status stays the gate either way.

See [RFC 0014](0014-shared-bot-registry.md), Amendments (2026-11-07): D30 does not cover a
universal Bot. Its runtime is a DSH Session on `acp-claude`, so this projection never
runs for it: its Herdr face is a pane on that DSH Session, not a projected Claude pane.

Everything else in Design is this RFC's proposal. No question is open.

## Design

### One agent, three windows

The agent runs in a herdr-core terminal, as today. Three windows look at it:

- **The terminal** (Herdr, or `hc attach`): the agent itself. Nothing changes there.
- **The Automagik window**: the bots-dsh host imports the projection module and serves the chat
  to its client (RFC 0014 delivery 9).
- **The phone**: Pocket Link's bridge runs the same module and serves the chat over a new route
  (below). The app renders rows and sends the person's actions; it parses no transcript.

The module is one engine per watched terminal, shared by every client that watches it in that
process. It holds no state on disk: everything it shows can be read again from the transcript,
herdr-core and the screen.

### Where the code lives

The module is plain JavaScript (ES modules, no dependencies, no build), so it runs as it is in
the bridge and in the DSH host. Its floor is the bridge's Node (`bridge/package.json`, `>=20.3`).

- **Source:** `herdr/mods/pocket-link/chat/`, beside the bridge, so a copied Pocket Link carries
  it (Pocket Link ships as its folder; README "Update"). It is Pocket's, like the rest of the
  folder: on the herdr lane, never in the pack's `PACK_MODS`, tested by `ci.yml`'s `pocket-link`
  job. The folder has no `main.js` or `layouts/`, so it is not a Herdr entry
  (`scripts/entries.mjs --check`).
- **The Automagik window's copy:** `apps/bots-dsh/src/host/live-chat/`, byte-equal, checked by
  both gates (the pattern 0014 Q15 set for `registry.js`). A change ships herdr first, then the
  plugin (decided, Q1).

### What we take from Orca (D31)

Ported from TypeScript to JavaScript with JSDoc types, behaviour unchanged, each file's header
naming its upstream path:

| Ours (`chat/`) | Orca at `e1dfc022` |
|---|---|
| `decode-claude.js`, `decode-codex.js`, `decode-omp.js` | `src/main/native-chat/transcript-line-decoders-{claude,codex,omp}.ts` |
| `types.js` (rows, turn lifecycle, session status, sources) | `src/shared/native-chat/native-chat-types.ts`, `src/shared/agent-status-types.ts` (the parts used) |
| `paste.js` (sanitize, bracket framing, separate submit) | `src/shared/native-chat/input/native-chat-paste-bytes.ts` |
| `answer.js` (approval envelope, key map, paced steps) | `src/shared/native-chat/input/native-chat-{approval-envelope,answer-stepping}.ts`, `native-chat-agent-support.ts` |
| `screen.js` (ANSI-free screen reading) | `src/renderer/src/components/native-chat/native-chat-scrape-fallback.ts` |

Their tests come too, as `node --test` fixtures. Not taken: Orca's hook server and its hook
event format (D31; `main/devin/hook-service.ts`), its Electron and React code, its mobile app and
relay, and its structured-session runtime.

- **Credit.** Orca's MIT copyright and permission notice go verbatim in
  `chat/LICENSE-upstream`; the folder stays Apache-2.0 as a derived work, as `herdr/NOTICE`
  already does for other vendored mods. `herdr/NOTICE` gains an entry naming the files and the
  commit; `apps/bots-dsh/NOTICE` gains the same for its copy.
- **Upstream.** `chat/UPSTREAM.md` keeps the commit and, per file, the upstream path and blob id
  it came from. We own the copies (D31): an upstream fix is pulled by hand, as a herdr patch, when
  a decoder breaks on a new agent version or Orca fixes something we hit. Nothing fetches Orca in
  CI.

### Finding a terminal's transcript

The engine picks the agent from `hc get`'s `status.app` (Claude Code reports `claude-code`), else
the program in `argv`. Claude, Codex and omp have decoders; any other agent is screen only.

The transcript of terminal `t`, first match wins:

1. **The `agent.transcript` label** (new; delivery 2). The briefing hook already holds
   `transcript_path` when it ties the session; it sets this label beside `agent.session`. Today
   it ties only when the session id changes (`workers.js:324-334`), so the rule widens: it also
   ties when `agent.transcript` is missing or differs, and a pane labelled before the update gets
   the new label at its next prompt. A label is readable through `hc get` on any machine, which
   the ledger is not.
2. **The workers ledger's last `session` row** for `t` with a `transcript`, on this computer
   (`inspect.js:43` reads it the same way).
3. **Derived from `agent.session`.** Claude: `.claude/projects/<cwd slug>/<session>.jsonl`.
   Codex and omp name files by date, so they need 1 or 2.
4. **Discovered, this computer only.** A pane with no label (t22n: plain `hc run … claude` panes
   have none): the newest transcript in the agent's folder for the pane's `cwd`, written after the
   pane started. Used only when exactly one candidate fits; two panes in one folder are never
   guessed between, and a pane whose start time herdr-core does not give is not guessed for. Orca
   looks in the same folders (`src/main/native-chat/session-file-resolver.ts:35-40`). Its limit:
   only panes herdr-core lists count as a second pane, so a Claude started outside Herdr in the
   same folder can be taken for the pane's own; labels (deliveries 2 and 6) close this.
5. **None.** The chat is screen only (see "Unlabeled panes and other machines").

**The folder rule** (t2x5). A path from any of these is used only if it is inside the agent's own
transcript folder: `.claude/projects/`, `.codex/sessions/` or `.omp/agent/sessions/` (omp's
default, `omp-session-root.ts` in Orca), under the
home of the machine the terminal runs on, and ends in `.jsonl`. On this computer the path is
resolved (`realpath`) before the check, so a symlink out of the folder is refused. For a terminal
on another machine the check is textual only, since `realpath` runs only here: the path is made
home-relative, must have no `..` or empty segment, and is read as that relative path with
`hc file read --on <machine>`. The engine always passes `on` from the terminal's own address
(`<machine>/tN`), never from a path or label, and sets no `cwd`, so the base is that machine's
home as `file.read` defines it. A symlink inside a remote agent folder is followed; that folder is
written by the same account as the agent. `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and omp's XDG
folder are not followed in this RFC; such a pane is screen only. A refused path is logged once,
by its folder, never its contents.

### Tailing

- **This computer:** `fs.watch` on the file plus a one-second poll, reading from the last byte
  offset, holding a partial last line until its newline. Orca does the same
  (`transcript-watch.ts:48,66`).
- **Another machine:** `file.read` with `offset` (lines) while a client watches: every 2 s while
  the agent is working, every 10 s when idle. `file.read` stops at 8 MB, so a backfill reads by
  `limit` pages.
- **A new session in the same pane** (the label changes, or `/clear`): the old transcript's rows
  stay, a divider says "new session", and tailing moves to the new file.
- **The first write can lag** (Orca, `transcript-watch.ts:48`: "First flush may take minutes").
  Until rows arrive, the screen and status fill the turn.

### Status and hooks

Orca's middle source is its own hook server. We have herdr-core instead, which every machine
runs: `events.subscribe` on the terminal gives `status.state` (`idle`, `working`, `done`,
`blocked`, `error`), `status.kind` while blocked (`permission`, `question`, `auth`), `status.msg`
and `turn`; `terminal.send` refuses a blocked program. That is the status row, the "working"
indicator, the turn boundary and the gate for approval buttons. The status is the program's own
report, so it is a gate, not proof of what the dialog asks. The briefing hook's facts (session,
transcript) arrive as labels. Where it is installed, a `PermissionRequest` hook names the
pending tool and its input (decided, Q5; delivery 8).

### Screen fallback

`terminal.read` gives the screen as text. The per-agent screen reader finds three things:

- **the input row**, to see whether a half-typed draft sits there (see "Input");
- **a dialog** (an approval, a question, a picker), with its options;
- **the visible turn**, when there is no transcript yet.

Screen rows are marked "from the screen", are replaced as the screen changes rather than
appended, and are dropped once transcript rows cover their turn. They are never kept.

### Ranking and dedupe

Sources rank transcript 3, status 2, screen 1 (Orca, `native-chat-types.ts:24-32`). Within one
turn (a user message to the next `idle`), a row from a higher source replaces a lower one of the
same kind. A message sent from a chat shows at once as "sending" and is matched to the
transcript's user row by its sanitized text in that turn; if none comes, it stays marked "not in
the transcript yet".

### The row model

Every row: `id`, `turn`, `at`, `source` (`transcript`, `status`, `screen`), `kind`, and the kind's
fields. The `id` is `<segment>:<line>.<block>` (amended in delivery 3a; first drafted as the
transcript's own id, else `<file>:<line>`): a segment is one transcript file of the pane, numbered
from 1 in each engine process, so ids are ordered and never carry a path. A restarted bridge
numbers again, so a client's cursor gets `reset` and the latest page ("Reconnect"). Screen rows are
`screen:<n>`, replaced as the screen changes. Turns are counted within the rows the engine read;
rows a backfill reads from before them count back (0, -1, ...). The kinds:

- `text`: `role` (`user` or `assistant`), `text` (markdown);
- `tool-call`: `tool`, `summary`, `input` (a short preview);
- `tool-result`: `call` (the tool-call row's id), `ok`, `output` (a preview);
- `approval`: `tool`, `summary`, `choices` (`allow`, `allow-always` when the key map has it,
  `deny`), `open` (still on screen);
- `question`: `prompt`, `options`, `multi`, `answerable` (false where the agent cannot be answered
  by keys, below), `call` (the open call it answers) and `open`;
- `status`: `state`, `msg`;
- `tokens`: `input`, `output`, `cache`, `context` when the transcript records them (Orca's
  `AgentSessionTokenUsage`, no prices).

**Rendering, both clients** (t2x5). Text is shown as text or as markdown through a sanitizer:
raw HTML is shown as text, never rendered; no image or other remote resource loads by itself (an
image is a link the person taps); links show their target. Control characters and ANSI codes are
removed before display. Tool output is monospace and collapsed.

### Input

What the person does in a chat becomes keys in the same terminal. The engine never answers
anything on its own (0014 Threat model).

- **Text.** First the text is cleaned (t2x5): `ESC[200~` and `ESC[201~` removed, then every
  other escape sequence, every C0 control but newline and tab, DEL and C1 controls; CRLF becomes
  LF. Empty after cleaning: refused. Then:
  1. **Draft check** (Q19). The screen's input row is read. If it holds text the person typed in
     the terminal, the message is **held**: the chat shows it with "The terminal has a half-typed
     message" and **Send now**. A held message goes by itself once the input row is empty (part
     of Q2's accepted recommendation). The draft is never cleared, unlike Orca. **Send now**
     (decided, Q2) pastes the message after the draft and sends both as one message; the chat
     warns first ("Sends your half-typed terminal text with it"). Nothing is cleared or retyped.
  2. **Send.** `terminal.send`: herdr-core pastes the text, waits until nobody has typed for about
     3 s (keys pressed meanwhile are held, then delivered), and presses Enter. Where an agent
     needs Orca's framing instead (a bracketed paste for multi-line text, Enter as its own write
     500 ms later, `native-chat-paste-bytes.ts:20-33`, `native-chat-answer-stepping.ts:1`),
     `paste.js` writes those bytes on an attached stream; delivery 3's checks decide per agent.
  3. **While working.** Claude takes a message mid-turn as a queued prompt (Orca decodes it,
     `transcript-line-decoders-claude-queued-prompt.test.ts`); it shows as "queued". Other agents'
     messages wait for `idle` unless delivery 3's checks show they queue too.
  4. **Blocked.** A send that herdr-core answers `blocked` (a dialog is open) is not forced: the
     message waits, and the dialog shows as an approval or question row.
- **Approvals.** The key map comes from Orca: allow is `1` for Claude and Codex, deny is `esc`
  (`native-chat-approval-envelope.ts:38-45`, `native-chat-agent-support.ts:66`). Text on the
  screen can be anyone's (a tool's output can print a fake dialog), so an approval row gets
  buttons only when all of these hold (t2x5):
  1. herdr-core reports `blocked` with kind `permission` (or `question` for a question row);
  2. the dialog is read only from the bottom of the screen, the rows around the cursor, never from
     scrollback or the middle of the screen;
  3. the transcript has exactly one open tool call (no result yet) with the dialog's tool; with
     none, or with several open at once (parallel calls), there are no buttons. The row shows
     that call's input from the transcript, never the screen's summary, so the person approves
     what the agent actually asked to run. An agent with no transcript yet gets the dialog with
     "Answer in the terminal" and no buttons.
  Allow-always is offered only when the agent's key map has it at a fixed key; a number read from
  the screen is never pressed. Just before pressing, all three are checked again; if one fails,
  nothing is pressed and the chat says the question changed. Where the `PermissionRequest` hook
  runs (decided, Q5), its payload names the tool and replaces guard 3; guards 1 and 2 still
  apply.
- **Questions and pickers.** Paced key steps, one body and one Enter per answer, 500 ms apart
  plus 500 ms to let the next question draw (`native-chat-answer-stepping.ts`). Each step checks
  the screen first and stops at a mismatch with "Finish in the terminal". omp's questions cannot
  be answered by keys (`native-chat-agent-support.ts:41`): the row shows the question with "Answer
  in the terminal". Claude Code's AskUserQuestion (probed on 2.1.319; `chat/question.js`) gets
  options only for one open call asking one question; every key is its own send, 500 ms apart: a
  single-select is the option's digit alone (`choice` `"2"`), free text is digit N+1 then the text
  and Enter (`choice` `"other"` with `text`), a multi-select is each digit, Right, then Enter
  (`choice` `"1,3"`). Codex and OpenCode step too, but their keys were never recorded: "Answer in
  the terminal".
- **Interrupt.** `terminal.interrupt`: esc when the program reports status, else ctrl+c, and it
  never escalates. Never a second esc for Claude or Codex, which read esc esc as rewind
  (`native-chat-agent-support.ts:46`).
- **Show terminal.** Always one tap away, in both clients: the Automagik window opens Code on the
  pane (RFC 0013), the phone opens its terminal view on the same terminal.

### The phone: a chat route in Pocket Link

herdr-core is upstream Rust; chat methods cannot go into it. The bridge serves them itself, on a
second ALPN beside the session one:

- **`herdr-pocket/chat/1`**, in `bridge.mjs`'s `routes`, admitted by the same paired-key check as
  `herdr-pocket/1` (`devices.json`, `guard.mjs:acceptOne`), untimed once its header is in. Before
  pairing it is refused before anything is read, like the session route. A removed phone's chat
  sessions end with its terminal ones (`revoke`).
- **Wire.** The same framing the app already speaks to herdr-core (`hello` with
  `generation: 1, framed: true`, JSON-RPC on channel 0, streams on their own channels with
  credit), so `CoreClient.kt` is reused. `hello` also answers `chat: 1`.
- **Methods.** `chat.list` (live terminals with a decoder or a screen reader: terminal, machine,
  agent, title, status, and whether the chat is from the transcript or the screen);
  `chat.subscribe {terminal, after?}` (a stream of row, status, draft and dialog events);
  `chat.backfill {terminal, before, limit}`; `chat.send {terminal, text, id}` (answers `sent`,
  `queued`, `held` or `refused` with a reason); `chat.sendHeld` and `chat.cancelHeld`
  `{terminal, id}`; `chat.answer {terminal, row, choice, text?}` (`text`: a question's free text only); `chat.interrupt {terminal}`.
  (Amended, 2026-11-07: on a `dsh:<botId>` chat, send, answer and interrupt stop being
  refusals where the bridge's `hello` says `dshWrite: true`; see Amendments.)
- **Limits.** A row's text is cut at 64 KiB and a tool output preview at 8 KiB, each with "open
  in terminal"; a backfill page is at most 200 rows and 1 MiB; a send at most 32 KiB; at most 8
  subscriptions per connection. The connection caps in `guard.mjs` (`MAX_OPEN`, `MAX_PENDING`,
  `HANDSHAKE_MS`, `MAX_LINE`) apply unchanged.
- **Reconnect.** A cursor names the segment and the row. The bridge keeps the last 500 rows of
  each watched terminal in memory, while a phone watches and 10 minutes after. A resubscribe with
  `after` gets what it missed; a cursor the bridge no longer has (it restarted) gets `reset` and
  the latest page. A message the phone sent and did not see answered is never sent again
  silently: the phone shows it as "maybe not sent" with Retry.
- **An older bridge** refuses the ALPN: the phone shows "Update Pocket Link on this computer for
  chat" and the terminal view as today. Nothing updates Pocket Link by itself (its README,
  "Update"), so this case lasts.
- **Other machines.** The phone pairs with one computer's bridge; that bridge reaches linked
  machines through hc, as the terminal view does.

### Unlabeled panes and other machines (t22n)

Two gaps today: plain `hc run … claude` panes have no `agent.session` label, and the hook that
sets it runs only on the computer with the pack's hooks.

- **This computer, unlabeled.** Discovery (step 4 above). When discovery cannot decide, the chat
  is screen only, until the person says yes to the label-only hook for every Claude pane
  (decided, Q3; delivery 6).
- **Linked machines, until #206 installs the pack there.** A pane with both labels (set by
  something else, such as a Bot started from here) is tailed through `hc file read --on`. A pane
  without them is screen only: discovery needs a folder listing, and `file.read` cannot list,
  and the module runs no programs on other machines.
- **What the chat shows meanwhile.** The turns the screen shows, marked "live from the screen",
  a line saying "History appears when this pane's transcript is found", status from herdr-core,
  approvals and questions from the screen, and Show terminal. Sending, approving and interrupting
  work the same.

### What stays different from the terminal

Orca's own list of gaps (research note, "Parity gaps") and our answer:

| Gap | Our answer |
|---|---|
| The first transcript write can lag minutes | Screen and status fill the turn; a sent message shows at once as "sending" |
| omp questions cannot be answered by keys | Shown with "Answer in the terminal" |
| Pickers are paced key steps, timing-sensitive | Orca's pacing, a screen check before each step, stop at a mismatch |
| esc esc rewinds Claude and Codex | Interrupt sends one esc; `terminal.interrupt` never escalates |
| Key maps follow each agent's TUI version | A dialog the screen reader does not recognize gets no buttons, only "Answer in the terminal" |
| TUI-only screens (menus, `/` pickers, plan toggles) | Typed commands go as text; interactive menus open the terminal |
| Image paste | Not in this RFC; `terminal.put` can carry it later |
| Unlabeled and remote panes | Screen only until labelled (above) |
| Orca moved new chats to structured sessions | Our work Bots already are (D30); code Bots stay live by decision |

## Contracts introduced

- **`agent.transcript`**, a new terminal label, set by the briefing hook next to `agent.session`.
  Old packs never set it; readers fall back to the ledger. The attach ledger and
  `whois --json` (`bots.attach-ledger@1`, `bots.whois-json@1`) do not change; the workers
  ledger's `session` row already carries `transcript` and does not change.
- **`herdr-pocket/chat/1`**, a new ALPN on Pocket Link's endpoint, with `chat.*` methods and
  wire version 1. Older phones never dial it; older bridges refuse it and the phone falls back.
  A change to its methods' meaning is a new ALPN version.
- **`herdr/mods/pocket-link/chat/`** and its copy **`apps/bots-dsh/src/host/live-chat/`**, with
  `LICENSE-upstream` and `UPSTREAM.md`. New.
- **The transcript folders**: `.claude/projects/`, `.codex/sessions/`, `.omp/agent/sessions/`
  under a machine's home. Widening the list is a change to this RFC.
- **`docs/privacy.md` in Pocket**: the app now receives agent transcripts (delivery 5).

## Threat model

- **Who can reach it.** Only paired phones, through Pocket Link's existing gate (pairing code,
  `devices.json`, `guard.mjs`); unchanged. In the Automagik window, only the person's own DSH
  host. A paired phone already has the whole `hc connect` API, including `terminal.attach`,
  `terminal.keys` and `file.read`: the chat route gives it a better view of what it can already
  read and type, and no new reach.
- **Who can call the engine.** The DSH host also runs plugins, tools and automations. The
  engine's send, answer and interrupt calls are reachable only from the chat route bots-dsh serves
  to the person's own window, and on the phone only from `chat.*` on a paired connection. They are
  never registered as a DSH tool, never given to an automation or another plugin, and refused
  without a client that watches that terminal. Each carries the action the person took: the
  message they wrote, or the id of an open approval or question row the engine itself raised.
  (Amended, 2026-11-07: the same rule for writes on DSH chats, through the owner-only
  socket; see Amendments, "Threat model".)
- **The per-project yes** (0014 Threat model, item 3). It lives in 0014's `shown[]`, keyed by
  (machine, project). This RFC adds nothing to it and reads no repo file: a chat opens only for a
  Bot already shown under that yes, or a terminal the person opens.
- **What it can read.** Transcripts of live terminals' agents, through the folder rule. The rule
  is against a bad label, hook payload or ledger row pointing a chat at another file (`~/.ssh`),
  not against the phone. Labels are free-form and any program in a terminal can set them, so the
  label is never trusted more than the rule allows.
- **What it can send.** Text, through the cleaner and the draft check; mapped approval and answer
  keys under the guards in "Input"; interrupt. Only on the person's action in a client, enforced
  as in "Who can call the engine". (Amended, 2026-11-07: on a DSH chat also a prompt, a
  cancel and one answer to a DSH request; see Amendments, "Threat model".)
- **Rendering.** Transcript text is written by the agent and by whatever it read (web pages,
  files, tool output). It is shown as text or sanitized markdown, with no HTML and no remote load
  by itself, so a page the agent read cannot run in, or call home from, either window.
- **Secrets in transcripts.** Tool output can hold tokens and keys. The phone keeps rows in
  memory only, never on disk; the bridge and the DSH host never log row text. No redaction in
  this RFC (decided, Q4): the rows are text a paired phone can already read from the terminal.
- **Undo.** Remove the phone in Pocket Link (its sessions end within 2 s), turn the bridge off,
  or revert the deliveries; nothing is stored that needs cleaning.

## Failure modes

- A transcript line that does not parse is skipped; the turn falls back to the screen.
- A decoder that falls behind a new agent version shows screen rows and keeps Show terminal; the
  fix is a herdr patch.
- A machine that stops answering: the chat keeps the last rows, greyed, says the machine is
  offline (as 0014 "Other machines"), and refuses to send. Nothing is queued for later.
- The bridge restarts: phones reconnect with their cursor and get `reset` and the latest page.

## Deliveries

1. **The module: decoders, types, cleaner, folder rule** (herdr). `chat/` with the Orca ports
   and their tests, `LICENSE-upstream`, `UPSTREAM.md`, the `herdr/NOTICE` entry, and the
   `pocket-link` job running `chat/*.test.mjs`. Nothing imports it yet. *Check:* the job; Claude,
   Codex and omp fixture lines decode to rows; `ESC[200~` inside a message is gone after
   cleaning; `~/.ssh/id_ed25519`, `../` and a symlink out of `.claude/projects` are refused.
   *Rollback:* revert in a later herdr patch; nothing uses it.
2. **The transcript label** (herdr, t22n; RFC 0014 delivery 8's "the briefing hook passes the
   agent's `transcript_path` on"). `joinSession` also sets `agent.transcript`, only for a path
   the folder rule accepts, and `sessionChange` also fires when that label is missing or stale.
   One PR with 0014's delivery 8, or before it. *Check:* the herdr gate; after one prompt in a
   new bot pane, `hc get` shows both labels; a pane that had `agent.session` before the update
   gets `agent.transcript` at its next prompt, with no second ledger row for the same session; a
   hook input naming a path outside the folders sets no `agent.transcript`. *Rollback:* a
   reverting pack (the pointer never downgrades); labels already set stay and are harmless.
3. **The engine** (herdr). Transcript finding, tailing (here and `--on`), status, screen reading,
   ranking, the row model, input with the draft hold, approvals, pickers, interrupt, all behind
   one API both clients call. *Check:* tests against a fake `hc` and temp homes (never a live
   Herdr): a held draft is never cleared; a stale approval presses nothing; a fake dialog printed
   mid-screen, or shown while status is not `blocked`, gets no buttons; a dialog whose tool has
   no open call, or two open calls, in the transcript gets no buttons; the approval row shows the
   transcript's input, not the screen's; a call with no watching client is refused; a
   remote tail reads by offset with `on` from the address; per agent, a multi-line message arrives
   as one message in a recorded fake terminal. Recorded from Claude, Codex and omp: each reports
   `blocked` with kind `permission` at an approval; an agent that does not gets no approval
   buttons (it fails safe, "Answer in the terminal"), and the delivery's PR names which agents
   those are. *Rollback:* revert; nothing calls it until 4 or 0014's 9.
4. **The chat route** (herdr, Pocket Link). `herdr-pocket/chat/1` in `bridge.mjs`, the limits,
   cursors, and README's "Update" note. *Check:* `guard.test.mjs` gains: an unpaired key is closed
   before its header is read, a removed phone's chat session ends; a fake hc behind the route
   answers `chat.list` and streams rows. *Rollback:* copy the older mod (nothing updates Pocket
   Link by itself); phones fall back to the terminal view.
5. **The phone's chat view** (pocket, after 4). A Chat tab on an agent terminal: rows, approvals,
   held messages with Send now, interrupt, Show terminal; `docs/privacy.md` says transcripts now
   reach the phone and stay in memory, and Pocket's RFC index (`apps/pocket/docs/rfcs/README.md`)
   links this RFC, as Pocket's AGENTS.md asks for a contract change. *Check:* the Gradle gate; unit
   tests render `<img src=…>` and `<script>` as text and load nothing; on a paired phone, a
   Claude pane's turn shows as chat and an approval answered there lands in the terminal.
   *Rollback:* a later release hides the tab (never a lower versionCode); the terminal view is
   unchanged.
6. **Every Claude pane on this computer** (herdr, t22n; decided, Q3). Herdr offers once "Show
   every Claude pane as a chat"; on yes the pack adds a hook to the person's Claude user settings
   that only sets `agent.session` and `agent.transcript` (no briefing, no output, fail-open).
   *Check:* the herdr gate; after a yes, a plain `hc run … claude` pane gets both labels after
   its first prompt; saying no installs nothing, and the offer does not come back. Delivery 8
   adds the approval hook to this offer (Q5). *Rollback:* a reverting pack removes the hook it
   added and nothing else.
7. **Linked machines** (herdr, after #206). Where the pack's hooks run on a linked machine, its
   panes get both labels and are tailed through `hc file read --on`. *Check:* a labelled remote
   pane's chat shows transcript rows; a remote path outside the folders is refused. *Rollback:* a
   reverting pack; remote panes go back to screen only.
8. **The approval hook** (herdr, t22n, after 2; decided, Q5). A `PermissionRequest` hook
   beside the briefing hook in the settings Start and Attach write, and in Q3's offer, handing the
   engine the pending tool and its input. *Check:* the herdr gate; a Claude approval shows its tool
   from the hook; a fake dialog printed by a tool gets no buttons; a pane without the hook keeps
   (a)'s guards. *Rollback:* a reverting pack removes the hook; approvals fall back to (a).

**With RFC 0014.** 0014's delivery 8 carries this RFC's delivery 2 (or follows it). 0014's
delivery 9 (one conversation in the Automagik window) needs deliveries 1-3 here, not 4-5, and
copies the module into bots-dsh; its check for a live pane on a linked machine also needs
delivery 7. Its check gains the window's half of "Rendering, both clients": a row holding
`<img src=…>` and `<script>` renders as text in the Automagik window and loads nothing. The phone
(5) needs 4. Linked machines (7) need #206, as 0014's delivery 7 does.

## Open questions

No open questions. The owner answered all five on 2026-11-03, each as recommended (see Decided);
they stay below as the record.

1. **Where the module sits, and how the Automagik window gets it.** *Decided, as recommended:*
   source in `herdr/mods/pocket-link/chat/` (it ships with a copied Pocket Link, which the bridge
   needs), a byte-equal copy in `apps/bots-dsh/src/host/live-chat/` checked by both gates, herdr
   first. The other way, a folder of its own such as `herdr/live-chat/`, would need a second copy
   inside Pocket Link for the bridge to run it.
2. **What Send now does with the terminal's draft** (Q19 says held and never wiped).
   *Decided, as recommended:* the message is pasted after the draft and both are sent as one
   message; the chat says so before the tap ("Sends your half-typed terminal text with it").
   Nothing is cleared or retyped. Without a tap, the held message goes once the input row is
   empty (also part of the recommendation the owner accepted).
3. **Plain Claude panes.** *Decided, as recommended:* the pack offers once, in Herdr, "Show every
   Claude pane as a chat", and on yes adds a small hook to the person's Claude user settings that
   only sets `agent.session` and `agent.transcript` (no briefing, no output, fail-open). Until
   then, such panes use discovery or the screen.
4. **Secrets in transcripts.** *Decided, as recommended:* no redaction in this RFC. The rows are
   the same text a paired phone can already read from the terminal; they are never written to
   disk on the phone or logged by the bridge or the host. Revisit if chat rows are ever stored or
   sent anywhere new.
5. **Where approval rows come from** (t2x5; D30's middle source is hooks). Either way, buttons
   need herdr-core's `blocked` with kind `permission`, and the dialog is read only around the
   cursor.
   - (a) **Screen only, with the guards** in "Input". Nothing new in anyone's Claude settings; it
     works the same in every pane and on linked machines before #206. But what the dialog asks is
     still read from the screen, so it breaks when a TUI changes its dialog, needs a transcript
     tool call to match. A fake dialog can at most answer the one real open call, whose input
     the row shows from the transcript.
   - (b) **A `PermissionRequest` hook** that hands the engine the pending tool and its input
     (D30's middle source, Orca's way, `native-chat-approval-envelope.ts`). The agent names the
     tool itself, so printed text cannot fake it, and a TUI redesign does not break it. But it runs
     only where the hook is installed (bot panes; plain panes after Q3's yes; linked machines
     after #206), and it is one more hook in the person's settings. Code the agent runs can still
     forge what the hook leaves behind, as it can labels.
   *Decided, as recommended:* (b) where it runs, folded into the hooks Start and Attach already
   write and into Q3's one-time offer, with (a)'s guards as the fallback everywhere else
   (delivery 8, after delivery 2).

## Amendments

### RFC 0015 (live chat projection): writes on `dsh:<botId>` chats

**Accepted by the owner, 2026-11-07, with global Bots writable under the same limits.**

Signed on PR #663 after the threat-model review by t2x5 and Reviewer t37n (wish
`pocket-four-tabs`, Group 0b). Group 4 builds it; its code starts only after this PR merges.

Owner decision D1 (wish `pocket-four-tabs`): **a paired phone can send, interrupt and approve in
the team's DSH chats.** This reverses the read-only rule for `dsh:<botId>` chats: today the
bridge refuses `chat.send`, `chat.interrupt`, `chat.answer`, `chat.sendHeld` and
`chat.cancelHeld` on them (`herdr/mods/pocket-link/bridge/dsh-source.mjs:6-8`, `refusedDsh`), the
socket answers every write `read-only` (`apps/bots-dsh/src/host/pocket-socket.js:7-9`), and
bots-dsh never opens DSH's owner event stream `$events`
(`apps/bots-dsh/src/host/pocket-chat.js:5-9`). Herdr terminals' chats (Design, "Input") do not
change. `chat.sendHeld` and `chat.cancelHeld` stay refused on a DSH chat: a DSH Session has no
half-typed terminal draft, so nothing is ever held.

#### The socket's write methods

The socket (`<team home>/pocket/chat.sock`) gains three methods. Each names the `channel` of a
subscription the same connection opened (as `backfill` does today), never a bare terminal, so a
write is bound to a chat someone is watching. Answers use the shapes `chat.*` already returns,
so `dsh-source.mjs` forwards them unchanged.

| Socket method | From the phone | Into DSH (Session Controller, DSH 0.2.2; Group 4 confirms each call) |
|---|---|---|
| `send {channel, text, id}` | `chat.send {terminal, text, id}` | a prompt (`SessionPromptRequest`) on the Bot's current chat Session, `mode: 'queue'`, `requestId` from the phone's `id` |
| `interrupt {channel}` | `chat.interrupt {terminal}` | a cancel of the active turn (`SessionCancelRequest`) |
| `answer {channel, row, choice, text?}` | `chat.answer {terminal, row, choice, text?}` | the result of the open approval or question named by `row` (below) |

- **send.** The text goes through the same cleaner as a terminal send (Design, "Input": paste
  markers, escape sequences, C0 but newline and tab, DEL, C1; CRLF to LF); empty after cleaning
  is refused. Answers: `sent` when no turn runs, `queued` when one does (DSH queues it, as
  Claude's queued prompt shows today), `refused` with a reason. Never `held`. `steer` is not
  used: a phone message never redirects a running turn. **Retry dedupe** (required): bots-dsh
  keeps the last 64 phone `id`s per followed Session in memory, and also looks the `id` up in
  the Session log where DSH lets it (Open question 2). A `send` whose `id` it finds is answered
  `sent` and not prompted again. The guarantee is conditional: while bots-dsh keeps running, a
  Retry on "maybe not sent" (Phone route, "Reconnect") never sends a message twice. After a
  bots-dsh restart the memory is gone, so it holds only if the log lookup works; until Group 4
  proves that, a Retry after `reset` warns "This may send it twice".
- **interrupt.** Cancels the running turn; with no turn running it answers `sent` and does
  nothing. It never escalates and never repeats.
- **answer.** `row` must name the approval or question that is open now in the Session this
  `channel` follows, as the socket raised it for that Session. Having been sent once is not
  enough: a new channel's snapshot re-sends the open rows, so the socket checks `row` at answer
  time against that Session's current open request, never against what a channel was shown. A
  row of another Session is refused `not-watching`; a row settled meanwhile `settled`; a row
  replaced by a newer request `changed`. `choice` is `allow` (this one call), `deny`, or one of a
  question's options. **Allow for session stays on the computer:** it is a grant for every later
  matching call in that Session, not one call, so the phone never offers it and the socket
  refuses it from the phone, even where DSH offers it. (Wish Group 5 lists it on the phone;
  that needs a later amendment.) The bridge adds `by`, the paired phone's name from
  `devices.json`, which the phone does not set. Anything else is refused.
- **text** (a question's free text only). `text` is allowed only with `choice: "other"` on an
  open **single-select** question row, the rule terminal chats use (`chat/question.js:103-107`).
  It must be one line (no CR or LF), pass the same cleaner as a `send` unchanged (text the
  cleaner would alter is refused, never silently rewritten), and be at most `SEND_TEXT_MAX`
  (32 KiB) in UTF-8 bytes. It is then forwarded to DSH unchanged, as that question's answer.
  Refused: `text` on an approval row, `text-on-approval`; `text` on a multi-select question,
  with any `choice` but `"other"`, or `"other"` without `text`, `invalid`; `text` with a line
  break or that the cleaner would change, `invalid`; `text` empty or blank, `empty`; `text`
  over 32 KiB, `too-long`. On Retry the phone resends the same `row`, `choice` and `text`. It
  stays one answer to a question DSH raised: never a prompt, never a message in the Session.
- **Refusal reasons.** `read-only` (a socket or bridge without writes), `not-watching`,
  `not-shown` (the per-project yes, below), `settled` (with the receipt), `changed` (the row is
  no longer the open one: "The question changed"), `invalid` (an answer's `choice` or `text`
  the row does not allow, above), `text-on-approval`, `empty`, `rate` (Limits), `too-long`,
  `busy`, `offline`.

#### Approvals on the phone, and the race

- **How the approval reaches the phone.** bots-dsh opens `$events` as one more owner client,
  the stream the computer's window already answers approvals from. A pending approval or
  question of a Session it follows for a watching phone becomes an approval or question row
  (`pocket-chat.js:125-126` today makes the read-only one) with `answerable: true`, the tool, its
  input from DSH's request (cut at 8 KiB), and the choices DSH offers but allow for session
  (below). The row id is DSH's id for
  that request, so both windows name the same thing.
- **Who wins: the first answer.** DSH settles each request once; the first answer to arrive,
  from the computer or the phone, is the one applied. bots-dsh never answers on its own: no
  default, no timeout answer. A waterfall it does not carry to a phone it passes on at once, so
  it never holds up the computer. One it carries and has not answered never delays another
  client's answer either: the computer's answer applies at once, as it does today.
- **The other side closes with a receipt.** DSH's `cancel` frame names only the request, not
  who answered or how, so every receipt comes from bots-dsh's own record, the settled entry
  (below), never from the frame:
  - *The phone answered first.* bots-dsh sent that result itself, so it records where (the
    bridge's `by`), what (the choice) and when (the time DSH accepted it). DSH withdraws the
    computer's dialog (its `cancel` frame). The Automagik window's chat shows "Answered on the
    phone (*phone name*): Allow, 14:02", read from that entry, if bots-dsh's window code can draw
    a line in that chat (Open question 4). Until that is proven, the computer's dialog just
    closes; the receipt is the phone's and the settled entry's.
  - *The computer answered first.* bots-dsh sent no result and gets DSH's `cancel`. Where is
    known by elimination: the answer did not come through the socket, so the phone shows
    "Answered on the computer" (any other owner client counts as the computer). What is read
    from the Session's log (the tool ran, or was denied) when DSH records it there, and is left
    out when it does not; the receipt never guesses an outcome. When is the time bots-dsh saw
    the `cancel`. The card closes through the `open: false` row `pocket-chat.js:291` already
    emits.
  - A phone answer that arrives second is refused `settled` and carries the same receipt. The
    receipt never names more of the input than the row already showed.
- **Withdrawn.** A request DSH cancels itself (the turn was interrupted, the Session stopped)
  closes on both sides as "No longer needed", with no answer.

#### Settled requests on reconnect

A phone can be away while its card is answered. Orca's answer (sweep note `sweep-orca.md:256`;
`claude-settled-permission-requests.js`): keep the last settled ids beside the status.

- Per followed Session, bots-dsh keeps the **last 16 settled requests**: id, outcome, where it
  was answered, when. Memory only, never on disk, dropped with the Session's follow.
- A `subscribe` snapshot carries the open approval (as today) and `settled: [...]`. The phone
  closes every card whose id is in `settled`, with its receipt. A card that is neither open nor
  in `settled` (older than the last 16, or the plugin restarted) closes as "Closed while you
  were away", with no outcome claimed.
- An answer the phone sent and did not see answered is never resent silently. Retry sends the
  same `row`, `choice` and `text`; a request settled meanwhile answers `settled` with its receipt.

#### Limits

The chat route's limits stand (Phone route, "Limits": 32 KiB a send, 8 subscriptions a
connection, `guard.mjs` caps), and the socket's (`pocket-socket.js:22-26`: 64 KiB a line, 4
connections, 8 subscriptions, 4 MiB unsent). New:

- one write in flight per phone and chat; a second gets `busy`;
- a rate cap per paired phone, across all its connections and chats, counted by the bridge
  and again by the socket: at most 20 writes a minute, and at most one `interrupt` per chat
  every 5 s; past either, `rate`. The cap bounds a send-and-cancel loop; it does not stop a
  stolen phone. Removing the phone (writes end within 2 s) is what stops it;
- an `answer` only for the request open now in the channel's own Session, checked at answer
  time (see **answer** above);
- an answer's `text` only for a single-select question's `"other"`, one line, unchanged by the
  cleaner, at most 32 KiB in bytes (see **text** above), counted in the same 20 writes a minute;
- a `send` only to the Bot's current chat Session, never a group, task, archived or subagent
  Session (the same set `pocket-chat.js:10-11` follows today);
- at most 16 settled requests kept per Session (above).

#### How the phone learns a bridge accepts writes

Both peers ship apart (plugin, then Pocket Link copied by hand, then the app), so each side
finds out what the other accepts, and fails closed to read-only.

- **Socket to bridge.** A bridge that wants writes says so in its `hello`
  (`{write: 1}`). A socket with writes answers that `hello` with `readOnly: false, write: 1` and
  the write methods in `methods`; to a `hello` without it, it answers exactly as today
  (`protocol: 1, readOnly: true`) and refuses writes on that connection. So an older bridge,
  which drops any socket that is not `readOnly: true` (`dsh-source.mjs:143`), keeps reading
  DSH chats from a newer plugin, and a newer bridge on an older plugin sees `readOnly: true`
  and stays read-only.
- **Bridge to phone.** The `herdr-pocket/chat/1` `hello` answer (`chat.mjs:174`) gains
  `dshWrite: true` when the bridge has a socket that answered `write: 1`, and `chatStart: true`
  later, for starting a chat (wish Group 5; its method is specified with that group). A phone
  that sees no `dshWrite` keeps the DSH chat read-only, "Answer on the computer", as today.
- **Why a flag, not `chat/2`.** This RFC makes a change in a method's meaning a new ALPN version
  (Phone route; Contracts introduced). The methods' meaning does not change: `chat.send`,
  `chat.interrupt` and `chat.answer` keep their parameters and their set of answers (`refused`
  with a reason is already one), and what they do on a Herdr terminal is untouched. What changes
  is which chats accept them, and a chat that does not still answers `refused`. That is a
  capability, and `hello` already carries capabilities (`chat: 1`, `credit`, `limits`).
- **An older phone on a newer bridge stays read-only.** It refuses DSH writes itself before
  sending (`ChatClient.kt:11-13`), and it never reads `dshWrite`.

#### Threat model (grows "Who can call the engine" and "What it can send")

- **Who can reach the socket: unchanged.** The socket stays owner-only: folder 0700, socket
  0600 (`pocket-socket.js:2-3`), and the bridge uses it only after `ownerOnly`
  (`dsh-source.mjs`, #523, #548). Never a TCP port. Another account on the computer reaches no
  write.
- **Who can call a write.** Only `chat.*` on a paired `herdr-pocket/chat/1` connection, for a
  terminal that same connection subscribes to (the bridge checks it; the socket checks the
  channel). An unpaired key is closed before its header is read, as today. The writes are
  served by the socket alone: they are never registered as a DSH tool, never given to an
  automation, a Bot or another plugin, and no Session can call them. The DSH host also runs
  plugins, tools and automations (as for the terminal engine): none of them reaches these
  methods.
- **Removing the phone ends its writes within 2 s.** The bridge's `revoke` runs every 2 s
  (`bridge.mjs:213`) and on forget (`bridge.mjs:195`); it ends the phone's chat sessions, which
  unsubscribes their channels, and the socket refuses a write on a closed channel. A write the
  phone sent before that is either already in DSH (a prompt accepted, an approval settled) or
  dropped; nothing of that phone's is queued for later.
- **What it can send: grows.** Before: text, mapped keys and interrupt into Herdr terminals.
  Now also, on a DSH chat: a prompt to the Bot's current chat Session, a cancel of its running
  turn, and one answer to a request DSH raised: allow for that one call, deny, or a question's
  option, or a single-select question's free text (`"other"`, one line, already clean, at most
  32 KiB, forwarded unchanged), never allow for session; never free text to an approval. At
  most 20 writes a minute per phone (Limits). Only on the person's action on the phone; the
  engine and the plugin never answer by themselves.
- **Who the log says sent it.** DSH writes a caller's `principal` only for a caller other than
  the owner (`dsh-api-session-controller` types, `user-rpc` source), and the phone acts as the
  owner, so a phone prompt is logged as the owner's. Its `requestId` starts `pocket-` so the
  Session log tells phone prompts apart (Open question 2).
- **A stolen paired phone, before and after.** Before: it read transcripts and typed into
  Herdr terminals (the whole `hc connect` API, "Who can reach it"). Now also: it can prompt the
  team's project Bots shown under a yes and the global Bots, the Main Bot included; stop their
  turns; and approve or deny their tool calls one call at a time, at the level DSH's sandbox
  gives that Session, at up to 20 writes a minute; and it sees each request's input. It cannot
  grant allow for session, pick a project without the yes, start a Bot, write a Bot's level,
  change its other settings beyond what RFC 0036 allows, or reach the socket. Amended
  2026-11-19 by [RFC 0036](0036-bot-management-from-pocket.md) (Decided): through that RFC's
  separately negotiated management capability, a phone may also list a shown project Bot's
  scheduled tasks without their prompts and pause, resume or rename them, change its name and
  model (a model write can clear Auto), and read, edit and add its own memory when it is not
  private; global Bots are not managed, and every other limit here stands. Undo as before:
  remove the phone in Pocket Link (its writes end within 2 s), or turn the bridge off.
- **The per-project yes still gates the chat** (0014 Threat model, item 3; `shown[]`). A DSH
  chat of a Bot whose project has no entry in the home file's `shown[]` is listed with
  `shown: false`; `subscribe` and every write on it are refused `not-shown`, by the socket and
  again by the bridge. A Team bubble for that project shows "Show in Automagik first" and opens
  no DSH chat. Pairing never counts as the yes, and no `chat.*` method or socket method writes
  `shown[]`: the yes is given only in Herdr or Automagik.
- **Global Bots are writable from the phone, under the same limits** (owner decision at
  signing, 2026-11-07: "include Main Bot"). Global Bots (`project: null`, the Main Bot
  included) need no project yes to be shown (0014), and they are the team's widest Bots. The
  phone may send, interrupt and answer on them under every rule above, with no exception: the
  owner-only socket; a paired connection subscribed to that chat; 20 writes a minute and one
  interrupt per chat every 5 s per phone; approvals one call at a time, never allow for
  session; writes end within 2 s of removing the phone; the phone acts as the owner, and its
  prompts carry a `pocket-` request id. The `shown[]` gate above still applies to project Bots
  only. What this accepts: a paired or stolen phone can prompt, stop and approve one call at a
  time on the Main Bot, with no project yes in between; removing the phone is the undo.
- **Privacy.** What the person types or approves on the phone now goes to the computer's DSH.
  Group 4's pocket PR says so in `apps/pocket/docs/privacy.md` in the same PR (Pocket's
  AGENTS.md); this text changes nothing on the phone yet.

#### Deliveries (wish Group 4; one PR a lane, in this order)

1. **Plugin.** `pocket-socket.js` and `pocket-chat.js`: the write methods, the `$events` client,
   the race rule, the 16 settled requests, the `hello` handshake, the `shown[]` gate. *Check:* a
   write on an unwatched channel is refused; a write is not callable as a tool or by an
   automation; an approval answered on the computer closes the phone's card with its receipt; a
   phone answer that comes second gets `settled`; a `hello` without `write` gets today's answer
   and no writes; a write on a global Bot (the Main Bot) is served under the same limits, with
   no project yes; a project Bot without its yes gets `not-shown`; allow for session from the
   phone is refused; the 21st write in a minute gets `rate`; a Retry with a known `id` prompts
   nothing; a single-select question's `"other"` text reaches DSH byte-for-byte as that
   question's answer; `text` on an approval gets `text-on-approval`; `text` on a multi-select
   question, with another `choice`, with a line break or that the cleaner would change gets
   `invalid`; empty `text` gets `empty`; `text` over 32 KiB gets `too-long`; a Retry resends the
   same `text`.
   *Rollback:* a release without the methods; bridges see `readOnly: true`.
2. **Pocket Link** (herdr, copied by hand with the owner's OK). `dsh-source.mjs` asks for writes,
   forwards them only to a socket that answered `write: 1`, refuses otherwise as today, and
   `chat.mjs` answers `dshWrite`. *Check:* the `pocket-link` job; a removed phone's writes end
   within 2 s; an old read-only socket still refuses writes. *Rollback:* copy the older mod.
3. **Pocket.** `ChatClient.kt` sends DSH writes only when `dshWrite` is set; cards with receipts;
   "maybe not sent" with Retry; `privacy.md`. *Check:* the Gradle gate; on a paired phone, a
   message reaches the desktop DSH chat, an approval answered there runs the tool, interrupt
   stops the turn. *Rollback:* a later release hides the writes (never a lower versionCode).

#### Open questions (Group 4 answers each before its plugin PR)

1. **The exact approval call, DSH 0.2.2.** Can a plugin be an in-process `$events` client, and
   does DSH settle a request once when two clients answer it (one result applied, the other
   client sent `cancel`)? And when one client answers while another still holds the request
   unanswered, does the answer apply at once? The host has the first-answer rule for plugin
   activations (`claimRequest`, "first answer wins", `dsh-cordis-host-runner` registry types);
   this amendment needs it for tool approvals and questions. The types read here are the
   harness's `0.2.1-rc.3`. If any answer is no, Group 4 stops and this section comes back for
   review; the race rule does not change.
2. **Does DSH accept a `requestId` that starts `pocket-`**, and can bots-dsh find one in the
   Session log for the Retry dedupe? If not, bots-dsh keeps the phone's ids in memory per
   Session, and the log does not tell phone prompts apart.
3. **The bot id.** Whether the id bots-dsh serves as `dsh:<botId>` is the registry id for every
   Bot (wish Group 2's check) decides how the `shown[]` gate finds a Bot's project.
4. **The receipt in the Automagik window.** DSH's `cancel` carries no answerer, so the window's
   "Answered on the phone" line can only come from bots-dsh's settled entry. Can bots-dsh's
   window code draw that line in the chat where DSH's dialog was? If not, the computer shows no
   receipt (its dialog closes), and the race rule does not change. A second point for the same
   check: whether DSH's Session log records an approval's outcome, which the phone's "Answered on
   the computer" receipt reads.

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: #852.
- Merged changes that cite this RFC: #253, #267, #273, #280, #282, #286, #296, #523, #574, #655, #663, #666, #670, #674, #675, #680, #740, #744, #748, #847 (last merged 2026-11-09).

## Links

- Handoff: `bot-system-unification.md` (D29-D32);
  `bot-chat-backend/orca-research-2026-11-03.md` (Orca, with file and line evidence); t22n's note
  on the label and the hook (`t22n-note-d30-chat-projection.md`).
- RFCs: [0014](0014-shared-bot-registry.md) Herdr Bots in Automagik, Threat model, deliveries 8
  and 9 (draft PR #236); [0013](0013-work-code-switch.md) Code on a pane;
  [0011](0011-monorepo-parts-and-releases.md) the herdr and pocket lanes;
  [0003](0003-model-routes-and-acp.md) the structured (ACP) chats work Bots keep.
- Code: `herdr/mods/pocket-link/bridge/{bridge,guard,pairing}.mjs`, `README.md`;
  `herdr/mods/am-sidebar/{briefing.mjs,workers.js,inspect.js,restart.js}`;
  `apps/pocket/android/app/src/main/java/ai/namastex/automagik/CoreClient.kt`; herdr-core's API
  (`hc schema`: `terminal.send`, `terminal.keys`, `terminal.interrupt`, `terminal.read`,
  `file.read`, `events.subscribe`).
- Orca: `github.com/stablyai/orca` at `e1dfc022` (MIT, © 2026 Lovecast Inc.).
- Issues: #206 (linked machines).
