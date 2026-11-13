# @automagik/acp-dsh

Agents other than DSH's own, as DeepSeek Harness models, over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The design is
[RFC 0003](../../docs/rfcs/0003-model-routes-and-acp.md).

- **Agents as DSH models.** Each agent is a provider route (`acp-<agent>`) whose models are the
  agent's own (Claude Code's Opus, Sonnet, Haiku…; Codex's GPT models), each with the reasoning
  efforts the agent offers for it. A chat or a Bot picks one like any model. DSH keeps the
  Session, its history and the sidebar.
- **The agent's own models and efforts.** They are read from the agent over ACP: its session
  config options of category `model` and `thought_level`. A probe starts the adapter, opens a
  session it never prompts (no turn, no tokens), reads the models, then picks each one to read
  its efforts, since an agent rebuilds that list per model. The result is kept in
  `$AUTOMAGIK_HOME/acp/catalog/<route>.json`, so the next start lists it at once while a new probe
  runs; a new adapter release probes again. Before any probe has answered, a short list stands
  in (Claude Code: `default`, `opus`, `sonnet`, `haiku` at low, medium or high effort; Codex:
  `default`). The model `default` is always listed: it is whatever the agent's own settings
  choose. An effort's default is the person's own setting for that model.
- **The Session's model and effort, before each prompt.** The agent's session is put on the
  Session's model, then its effort (the model first: the efforts are that model's). No effort
  leaves the agent's own. A model or effort the agent does not offer fails the turn, naming what
  it offers.
- **DSH tool cards and approvals.** With `dshTools` off (the kill switch), the agent runs its own
  tools. Each tool call it makes ends the model step with a call to `acp_tool`, a tool registered
  in that agent's scope only. DSH writes the `tool/call` and `tool/result` rows and draws the
  card (a terminal for a command, a diff for an edit, the generic card otherwise). When the agent
  asks permission for the call, `acp_tool` asks DSH's approval service
  (`approval/asked`, `approval/decided`) and gives the agent DSH's answer. On DSH's Auto
  review level that answer is the review. A call the reviewer allowed, or that the person
  allowed in the dialog the reviewer raised, gets `allow_once` for the agent's first question
  about it, with no second dialog; this holds in a subagent child too. These still ask as before:
  a later question, a call the agent changed after its review (in its question or after it), an
  agent that offers no `allow_once`, and a level that changed since the call.
- **DSH's own tools over the bridge (`dshTools`).** On, the agent gets the Session's preset tool
  set (standard, or cordis in creator mode) over one stdio MCP server per ACP session, named
  `dsh` and spawned by the adapter with that session's arguments. The bridge has no port; it
  reaches this plugin over a loopback back-channel with a per-session credential
  (`DSH_BRIDGE_CREDENTIAL`), which binds a request to its Session and is revoked with the
  bridge. Every DSH tool call is approved in DSH under the Session's level before it runs,
  whatever the agent's own allow rules or hooks say, and the bridge writes the `tool/call` and
  `tool/result` rows the chat shows. `acp-claude` runs with its built-in tools off
  (`_meta.disableBuiltInTools`); a structured call that is not an MCP name is recorded as
  `plugin:acp-dsh/toolset-drift` and its turn is cancelled — the detector runs at every session
  start, and it detects and cancels because the update arrives after the call began.
  `acp-codex` has no such switch, so it is bridged only with an explicit `dshTools: true`;
  absent or `false` means no bridge and its built-ins stay its own tool set. Until a structured
  name is proven in its tool calls, it draws no ACP card for an MCP call. The person's
  own MCP servers load beside the bridge with their own tools and sign-ins: DSH hands the session
  only the `dsh` bridge, so any other `mcp__<server>__<tool>` is the CLI's own user-scope config
  (claude-agent-acp merges the person's settings MCP servers into the session), it passes the
  drift allowlist by design, and DSH's Auto review does not gate it: the agent's own rules and
  sign-in govern that call. A tool-list change
  (a preset or level change) is announced on `acp-claude` and arrives through `session/fork`
  plus `session/close` on `acp-codex`; a bridge that never lists its tools fails the turn
  (`acp_bridge_missing`) before the prompt. **Auto:** DSH's Auto preset is full access's sandbox
  with asks answered by auto-review. A bridge call adds one marked, tool-only assistant block:
  the advertisement the Session format requires before its tool/call row, which the reviewer
  reads too, and which is removed from the surface once the call settles and never replayed to
  another provider; the reviewer sees the bridge tool, its redacted arguments and its schema
  before the body runs. A denial is `AUTO_REVIEW_DENIED`, a failed reviewer refuses with
  `AUTO_REVIEW_FAILED`, a review past its deadline is `AUTO_REVIEW_TIMEOUT`, and the call never
  runs. A call that comes between two steps of a turn while the agent's prompt is still running
  (after a `step/end`, before the next `step/start`) waits for the next step, at most 30 s, and is
  recorded and reviewed there; it ends with no rows if the turn ends, its caller goes away, the
  bridge is revoked or the turn is stopped (#969). Otherwise a Manual or Full call with no open
  step is `BRIDGE_NO_STEP` (Auto: `AUTO_REVIEW_NO_STEP`); one whose advertisement or
  call row cannot be written is `BRIDGE_RECORD_FAILED`, and the call does not run. The rows' call
  id is the agent's own `_meta.callId` only when it is 1 to 128 characters of `A-Z a-z 0-9 _ . : -`
  and does not start with `acp_` (the mirror's ids); otherwise the plugin mints `bridge_<16 hex>`
  and logs the replacement. **Codex's MCP approvals.** With `dshTools` on, `acp-codex`'s MCP calls
  get no mirror card (it gives them no structured name), so a `session/request_permission` Codex
  sends for one (codex-acp's MCP tool approval) is answered at once: allow once for the `dsh`
  server (the bridge's own approval is the one dialog), the agent's reject option for any other
  or unnamed server, which is logged (#969). **A call that
  outlives its step (#957).** The agent runs its calls in parallel, and the bridge puts no
  deadline on one (a long wait, a slow command and an open approval dialog are legitimate), so
  DSH can end the step a call was recorded in while it still runs. The write guard below then
  closes it before the `step/end` row and drops its late result; the agent still gets the real
  answer. Each call has its own abort controller: Stop, the end of its turn and a caller that
  went away (an MCP `notifications/cancelled`, a closed request) stop that call as
  `BRIDGE_CANCELLED` and keep the bridge. A call whose `tool/call` row cannot be written is
  answered with DSH's own not-started row, and a bridge revoked with a call in flight keeps
  the guard until that call is over. The reviewer
  goes to the same non-agent side model as a Session title. Manual asks (one dialog), Full
  access does not. A Session that moves between providers carries its transcript
  redacted at each crossing — the replay out to an agent, and the transcript handed back to a
  native provider — and each crossing writes a provider-boundary row the chat shows,
  "Switching to X": it is written before the reply and claims no answer, since the call can
  still fail after it. An agent whose CLI is signed out (ACP's `auth_required`, when its session
  opens or on a prompt) fails the turn as `MODEL_ACCESS_REQUIRED`, not `ACP_AGENT`. The
  reasoning effort the Session ran on crosses with it, both ways, when the target model offers
  that level (matched by id, else by name), replacing the target default DSH records on a model
  change; an effort DSH itself defaulted is not carried. The agents' levels are their own
  `thought_level` ids: Claude Code lists low, medium, high, xhigh and max, and Codex lists low,
  medium, high, xhigh, max and ultra, per model. A target with no reasoning levels, without
  that one, or whose levels cannot be read writes a notice row saying so and runs on its own.
  A switch back before the agent has answered drops the agent's chosen level; the native
  target's own default applies.
- **Only the chat reaches the agent.** DSH's side requests on an ACP route never become
  prompts. At the `llm/stream` waterfall a Session title (`purpose: session-title`) goes to a
  model that answers on its own, without the agent's effort. That is the first model the team
  can reach: DSH's default model (`agentDefaultModel`) when it is not an agent; else a
  `sideModel` the person chose; else each configured non-agent route in turn (its first model,
  at most eight); and only then the built-in DeepSeek Flash fallback. A credential or
  missing-route failure on one candidate moves to the next, so a team without a DeepSeek key
  reviews and titles on the model it does have; only no answer at all refuses. Auto review
  (`purpose: auto-review`) takes the same route, with its messages redacted first. Every other
  side request on an ACP route, a compaction summary included, is refused (`UNSUPPORTED`): it
  would carry the agent's whole chat to another provider, and the agent manages its own context.
  Sessions on any other route are left alone.
- **A switch onto an agent passes DSH's compaction guard.** `compaction-basic` prices every model
  switch on the destination's context window, which an agent does not declare, so a switch onto
  an agent in a Session with a request header used to fail with `MODEL_SWITCH_COMPACTION_FAILED`.
  This plugin wraps the engine's `compactPressure` (`src/host/pressure.js`, the method's only
  Automagik owner): an agent destination needs no compaction, every other destination goes to the
  engine unchanged. The wrapper is adopted when an agent is created and on its requests (a
  reloaded compaction plugin is a new engine), delegates to whatever is below it at call time, and
  on dispose unwinds only when it is on top. The method is private to `compaction-basic`; a guard
  test pins it, and a DSH flag for it is proposed upstream (RFC 0023). A switch *off* an agent is
  the destination's own business: for a Bot, the Bot team decides before the guard (its README,
  "Long chats").
- **Host only.** No browser half, so the plugin cannot stop the web UI from loading. With no
  agent CLI installed it registers no route. The welcome draws its setup from the `acpAgents`
  service below.
- **The Session's level, as the agent's own mode.** Before each prompt the agent's ACP session
  mode follows the Session: Manual is Claude Code's `default` mode, whatever default mode its
  own settings name; Codex runs in the sandbox that matches DSH's. DSH Auto review is Claude Code's `auto`
  and Codex's `agent`; it is the preset's identity, never just its sandbox and ask, so a custom
  preset with the same knobs keeps Manual (and the bridge's own approval). Full access lets every
  call through, as it does DSH's own tools. An agent that does not offer the strict mode fails
  the turn instead of running in its own default.
  A Workspace Session on unbridged Codex can instead take `agent` when the Bot team's
  `ownMode` answerer returns exactly `true` twice, before the prompt. After that agent session
  has attempted the own mode, any Workspace prompt that does not take it re-sends and confirms
  strict `workspace-write` (or its chat profile below), even if cached; refusal ends the agent
  session and fails the turn.
  Sessions that never attempt the own mode keep the usual mode cache and failure handling.
  Auto never requests `bypassPermissions` or
  `agent-full-access`. Codex's own reviewer decides those steps, based on the
  [Codex 0.167.0 capture](test/fixtures/permission-payloads/README.md); later versions may
  decide differently. Any approval Codex still requests goes to the person.
- **An agent that stops answering never holds the chat.** Its start (`initialize`,
  `session/new`, the bridge's first list) has 60 seconds, and each request after that and
  before a prompt (a model, an effort, a mode, a fork, a close) has 15. Past the deadline, or
  on Stop, the agent's process and its bridge are ended and the turn says what happened. A
  start that hangs is usually a CLI waiting for the person (a first-run question, a keychain
  dialog, an update), so that message says to open it once in a terminal. Stop ends the turn
  at once and gives the agent 5 seconds to end its prompt, because `session/cancel` is only a
  notification. An agent that ignores it is ended, and the next message starts a new agent
  session with the chat replayed to it (with `dshTools: false`, the new-session notice
  instead). A message sent while the agent is still on its last prompt waits those 5 seconds,
  then gets a new session in the same turn. Ending an agent ends what it started too (the
  command behind a stuck tool call): the agent leads its own process group, which is asked to
  end and killed 3 seconds later if any of it is left; on Windows its process tree is killed.
- **Claude Code keeps the person's own settings.** It loads their Claude Code settings (user,
  project and local) and asks DSH only for what those leave as "ask". A call their allow rules,
  saved "always allow" rules or PreToolUse/PermissionRequest hooks approve runs with no DSH
  dialog. This is the owner's decision (RFC 0003, Decided).

## Agents

Unbridged Claude Code receives per-session ask rules for recursive deletion, destructive Git,
infrastructure and database shell commands at every asking level. These explicit rules also
ask in Claude's auto mode. They are never written to a CLI home and are absent at Full access,
where explicit ask rules would otherwise still ask. Crossing Full access restarts the unbridged
Claude session with the chat replayed, adding or removing the rules; staying at a level reuses it.
Bridged Claude has its built-in tools disabled, so DSH checks its calls instead.

Codex's own tools are excluded: prompt rules under Full access (`approval_policy = never`)
refuse rather than ask, its session-flags configuration has no rules folder, and in `agent`
mode prompt rules reach Codex's reviewer rather than the person. Replacing its entire reviewer
policy or changing codex-acp needs a separate owner decision.

| Route | Agent | Runs | Adapter (newest release) |
|---|---|---|---|
| `acp-claude` | Claude Code | managed or existing `claude` (`CLAUDE_CODE_EXECUTABLE`) | `@agentclientprotocol/claude-agent-acp` |
| `acp-codex` | Codex | managed or existing `codex` (`CODEX_PATH`) | `@agentclientprotocol/codex-acp` |
| `acp-hermes` | Hermes | existing `hermes`, started as `hermes acp` | none: the CLI is the ACP server |
| `acp-antigravity` | Antigravity | existing `agy`, started as `agy acp` | none: the CLI is the ACP server |
| `acp-omp` | omp | existing `omp`, started as `omp acp` | none: the CLI is the ACP server |
| `acp-fake` | `dev/fake-agent.mjs`, set as `fakeAgent` | Node | none; tests only |

An agent is offered when its managed CLI is ready, or an existing CLI is on PATH or where its
installer puts it (`~/.local/bin`, `/opt/homebrew/bin`, …). The settings `claude: false` or `codex: false` take one away;
`hermes`, `antigravity` and `omp` are off until set to `true` (below). They are
live settings: switching one (from the welcome's Connect AI, its Settings page *Claude Code and
Codex*, or the plugin's own settings form) offers or withdraws the agent at once, with no
restart, and a connector that lands puts its model in the picker the same way
(`llm/adapters-updated`).

### Native-ACP agents: Hermes, Antigravity, omp

These three speak ACP themselves, so there is no adapter package and nothing is installed for
them: the plugin starts the CLI it finds with `acp` (`src/host/agents.js`, `launch`). What
differs from Claude Code and Codex:

- **Off until turned on.** `hermes`, `antigravity` and `omp` are live settings that default to
  `false`. Turning one on is the person's word that Automagik may use the sign-in that CLI
  already has on this computer, shared with their terminal. No account is read for them (none
  of the three has a command that names one), so the account record and its confirm step
  (below) stay Claude Code's and Codex's.
- **Never installed by Automagik.** A CLI that is not here is listed as missing with its
  install page (`cli.state: 'missing'`, `connector.state: 'no-cli'`), never hidden and never
  "installing". Once found, the connector reads `ready` with `native: true`.
- **Sign-in in a terminal.** There is no sign-in from a Bot's chat: `loginStart` refuses with
  `acp-login/terminal` and the command (`hermes acp --setup`, `agy acp --login`, `omp login`),
  and a signed-out turn fails as `MODEL_ACCESS_REQUIRED` naming the same command. Whether the
  agent is signed in is what its own ACP session said: `true` when the session the model read
  opens, `false` on ACP's `auth_required`. That read runs when the CLI changes and once a day,
  and again when the person asks (`refresh()`) while it is not signed in; no other check opens
  a session, because each of these agents keeps every session it opens in its own history.
  A session that opens does not prove a provider key works: a turn that then answers
  `auth_required` reads as signed out at once.
- **Models.** Antigravity offers its models and efforts as config options, as the adapters do.
  Hermes offers them only as the session's own list (`models` in the `session/new` answer,
  switched with `session/set_model`); the plugin reads that list when the agent has no model
  option. omp offers no model list over ACP: it is one model, `default`, its own setting.
- **The level.** Each is put in its own `default` mode before every prompt, whatever the
  Session's level, and what it asks is answered by DSH's approval under that level. Its own
  permission settings still decide what it asks about. One that does not offer `default`
  fails the turn. A table agent with no mode for DSH's level would say so once in the chat.
- **No DSH tool bridge.** DSH's tools do not reach them, even with `dshTools: true`: their
  tool naming over ACP is not proven the way Claude Code's was, and an unrecognised bridge
  call would draw two cards and ask twice. They keep their own tools; the transcript replay on
  a model switch reaches them like any agent.

`dshTools` (live, no schema default) is the bridge, its DSH approval, the drift detector and live
switching above. Absent means the per-agent default: `acp-claude` bridges because its adapter can
drop its own built-in tools; `acp-codex` does not, because it cannot. Codex is bridged only with
an explicit `true`; absent or `false` means no bridge, and Codex keeps its own built-in tools as
its only tool set. An explicit `false` is the kill switch for Claude too: the 2026-11-03
behaviour, where each agent keeps its own tools and its own approvals. The key is public and
stays writable through
DSH's settings service or the profile patch, but it is hidden from settings forms (`.hidden()`):
it is a rollback lever, not a preference. Flipping it either way ends the running agent sessions
and revokes their bridges at once; the DSH Session keeps its transcript and the next turn starts
afresh under the new setting. A flip is also announced on the plugin context as
`acp-dsh/dsh-tools-changed` with `{ on }`: DSH delivers `loader/volatile-update` only to the
plugin whose config changed, so another plugin would never see this one. The Bot team watches
that event, so turning the switch off moves its Claude Bots back at once, and turning it on moves
them again. A listener that throws is logged as a warning; the flip itself and its ended sessions
still hold, and the Bot team reverses at its next start (the route reads off or gone). The default
moves Claude Bots once per team to `acp-claude` (the Bot team's README,
"Claude on ACP"); the bridge probe in `bridge()` still gates the move.

The transcript replay is independent of the bridge: only an explicit `false` turns it off.

| `dshTools` | Claude Code: tools | Claude Code: replay | Codex: tools | Codex: replay |
|---|---|---|---|---|
| absent | DSH bridge, its own off | yes | its own only | yes |
| `true` | DSH bridge | yes | DSH bridge and its own | yes |
| `false` | its own only | no | its own only | no |

So with `dshTools` absent Codex sees the chat but not the team's tools; those need an explicit
`true` (two tool sets). A replay reaches an agent in each of these cases, redacted and capped at
120,000 characters, the oldest messages dropped first with a marker: a move from another
provider (with its "Switching to X" row); a new agent session in a chat that already has answers
(after a restart, or a session a crossing or a flip ended), with no row since the chat stayed on
that agent; and a live session resumed after the chat answered elsewhere (a move off Codex keeps
its session), which gets only the turns it missed, from its own last answer on, with the row. A
Bot part's handoff package (a relay marked `handoff`) is carried as the record it is: in the
part's first turn it stays in the prompt beside the person's words, and once the Bot team has
answered that turn itself, the next new session gets it in the replay. Both pass the redactor.
With `false`, an agent sees only its own session, and a new one in a chat with answers writes the
"does not see this chat's earlier messages" row instead.

`sideModel` (`{ provider, model }`, default `deepseek-official/deepseek-flash`, live) is the
model a side request tries after DSH's default model. An explicit value the person chose is tried
before the configured non-agent routes (each in turn, its first model); the default DeepSeek
Flash is tried last, so a team without a DeepSeek key titles and reviews on the model it does
have. An agent route set here is ignored, and a credential or missing-route failure falls
through to the next candidate.

## The `acpAgents` service

A settings page reads the agents through this host service; the plugin stays host only.

| Method | Does |
|---|---|
| `status()` | Each agent: `{ id, key, name, on, cli: { found, installUrl, signInHint?, state, managed, version?, error?, diagnostic?, logPath?, updating? }, connector: { state, native?, version?, error?, diagnostic?, logPath?, updating?, startError?, previous?, rolledBack? }, signedIn?, signInCheck?, consent?, model: { provider, id, name, listed }, restartNeeded }`. CLI state is `missing`, `installing`, `failed` or `ready`; connector state is `off`, `no-cli`, `installing`, `failed` or `ready`. `connector.previous` is the release a failed start goes back to, while it is on disk; `connector.rolledBack` is `{ from, to, at, reason }` while a release that failed to start is held back. `connector.startError` is the short reason an installed connector's last start failed, until a session opens or Retry reinstalls it; a connector being reinstalled reads `installing`. A failed connector install always carries `error`; `diagnostic` (the end of the installer's output) and `logPath` (the file it was written to, shown from the home folder) are optional, as for a failed CLI install. `signedIn` is absent while the sign-in is unknown; `signInCheck` then says why the last check of the CLI's status command could not tell: `timeout` (the CLI was ended after 8 seconds) or `unreadable` (it could not be run, or answered something this does not read). Neither field: nothing is known of a check (none has run yet, or the agent has no status command: a native agent's sign-in comes from its own ACP session). Errors are redacted. Spawns nothing. |
| `inspect(id)` | One agent's `status()` row with a fresh sign-in check, for a Bot about to be put on it. Asks that CLI's sign-in status only; installs, enables and starts nothing. Simultaneous checks share one probe. An answer stands for 3 seconds, and a confirmed sign-in for 5 minutes, since the check starts the whole CLI; `refresh()` clears it, and so does the agent itself saying it is signed out (ACP `auth_required`). Undefined for an id that is no agent here. |
| `refresh()` | Looks for the CLIs again (one installed after DSH started is offered now), then asks each CLI whether it is signed in (`claude auth status --json`, of which only `loggedIn` is read; `codex login status`, by its exit code). No agent turn. |
| `retry(id)` | Retries the required CLI and its connector, and answers at once. A connector whose last start or install failed, or that is missing, is reinstalled at the release in use (below); else the connector is checked for a newer release. Does not turn its model switch on. |
| `loginStart(id, { label? })` | Starts the CLI's own sign-in (`src/host/login.js`), or answers the attempt already at work for that agent. Codex: a device code through `codex app-server`; Claude Code: `claude auth login --claudeai`, whose link must ask for the manual code (`code=true`). Only the official authorization pages are relayed. `label` names the view that opened it (a Bot id), for a cancel confirmation; it is not an access check. An attempt that fails writes one line to the host log: a fixed class (no CLI found, no sign-in link in time, unsupported sign-in link, the CLI exited, the CLI could not be started, the CLI did not confirm the sign-in, device-code login is not enabled, device sign-in did not start, or unknown), where the attempt stood, how the CLI ended, and the version the CLI had when the attempt started. Never what the CLI printed. |
| `loginCurrent(id)` | The attempt at work for that agent, from any view, or undefined. Never starts or cancels one. |
| `loginStatus(id, attemptId)` / `loginAnswer(id, attemptId, value)` / `loginCancel(id, attemptId)` | Reads an attempt (an ended one stays readable for 60 seconds), sends Claude's pasted `code#state` to the CLI (which then has 90 seconds to confirm), or ends it. |
| `loginTextMatches(text)` | Whether a text carries a Claude sign-in state shown in the last 24 hours. Only a boolean: the states are kept as keyed hashes in memory. |
| `loginActive()` | How many attempts are starting or waiting. |
| `account(id, { fresh? })` | For the DSH owner's views only: `{ id, signedIn?, consent?, ref?, account?: { kind: 'account' \| 'key', email?, org?, plan? }, notice? }`. Who the CLI is signed in as, read from the CLI itself (below); never on a `status()` or `inspect()` row, in a log or in an event. `ref` names the account read and goes back with `accountConfirm`. |
| `accountConfirm(id, { ref? })` | The person's word that the app may use the account this CLI is signed in to. Asks the CLI again, records the consent and announces `acp-dsh/login-ready`. Another account than `ref` is refused (`acp-account/changed`); a signed-out CLI too (`acp-account/signed-out`). |
| `accountNoticed(id)` | The one-time notice of a vendor carried through an upgrade was shown. |
| `imageAccess()` | `{ ready, signedIn?, reason?, unsupported? }`: whether Codex can draw an image now, on its own ChatGPT sign-in (Codex on, its CLI found, its connector installed, `codex login status` says signed in; an unknown sign-in is asked once; the person confirmed its account, else `reason: 'account'`; the image run's checks hold for this Codex, else not ready, with `reason`: `unsupported` (and `unsupported: true`), `config` or `unreadable`). Reads no credential and starts no sign-in. |
| `generateImage({ prompt, size?, quality?, background?, signal?, timeoutMs? })` | Draws one image with the Codex CLI (`src/host/image.js`) and resolves `{ base64, mimeType: 'image/png' }`. Refusals carry an `acp/image-*` code (`signed-out`, `usage-limit`, `timeout`, `unavailable`, `failed`, `stopped`, `refused`) and a message to show as it is. |
| `keepImages(keeper)` | Where an image an agent makes in a chat is kept, so the chat can show it (`src/host/agent-image.js`). `keeper` is `{ start?({ callId, sessionId, via }), keep({ callId, sessionId, base64, mimeType, via }) -> Promise<{ file }>, fail?({ callId, sessionId, error }) }`; one at a time, and the call returns its disposer. The Bot team registers its images folder. |
| `ownMode(answer)` | Registers one answerer for an unbridged Workspace Session's own mode. Only exact `true` within two seconds counts, twice per prompt. Returns a disposer for that registration; competing registrations disable own mode permanently. |
| `ownModeOf(provider)` | `{ mode, bridged, answerer }` for a provider offering its own mode, otherwise undefined. |
| `ownModeIn(sessionId)` | Whether that Session is busy on a prompt in its own mode. |
| `holdTurns(gate)` | A veto on agent turns, for a plugin that must keep an agent from acting in a Session (the Bot team: a Session whose permission level could not be set). `gate({ sessionId, agent, provider })` is asked before every model step on an agent's route and again right before a turn's prompt is sent; it answers undefined to let the Session go, or the sentence the step answers with. It can only refuse: a gate that throws, takes longer than ten seconds, or answers anything else holds the Session with a fixed sentence, and a held Session's agent session is ended. Several plugins may register: any refusal wins, and the returned disposer removes only its own gate. With none registered nothing is asked. |
| `endSession(sessionId, why?)` | Ends one Session's agent session now, a turn under way included: the agent's process is stopped, its bridge credential revoked, and the step answers `why`. The DSH Session and its transcript stay; the next turn starts a fresh agent session, which takes its permission mode again. Answers whether one was live. |
| `bridge()` | `{ on, probesPass }`: whether `dshTools` is on, and whether a real probe on this machine passes — the per-session bridge gets a fresh credential, answers MCP `initialize` and `tools/list`, and lists at least one tool. A success is cached per installed adapter version; a failure is retried after ten minutes or the next app start. A missing adapter or a failed probe says no. The Bot team reads it before its one-time move of Claude Bots onto `acp-claude`, so no Bot moves onto a route whose bridge cannot work. |

**Separate Bot CLI homes (#869).** Claude Code and Codex each use a private home under the
installation's ACP data, shared by its teams and image runs. Managed and discovered CLIs use
that same environment for sign-in, status, account reads, adapters, model probes and images.
`HOME`, Windows profile/app-data directories, XDG directories, `CLAUDE_CONFIG_DIR` and
`CODEX_HOME` point there. Inherited authentication, provider and config overrides are masked.
No credential file is read, copied or linked by Automagik; each CLI owns its Bot credentials.
CLI `--version` probes use this vendor environment too; package installation keeps its separate
package-manager environment.

An upgrade retains Bot models and DSH history, but requires a fresh in-app sign-in. Old shared
consent is not carried. Signed-out or paused Bot work refuses with `MODEL_ACCESS_REQUIRED`,
without a fallback model. Codex images do not use a legacy ChatGPT grant while signed out.
Bot settings label Bot and terminal accounts separately; the terminal comparison is a read-only
CLI account query; Automagik requests no login, logout or token refresh for that comparison.
Missing identity is shown as unknown.

`authScope: 'isolated'` identifies the service and Claude/Codex status rows. `accountSignOut(id)`
and `accountSwitch(id, { label? })` use the Bot environment. They block admission, stop
starting/live chat, model-probe, image and login processes, wait for termination, then ask the
CLI to log out and verify it is signed out. Credential-store separation relies on the vendor
assumptions below. Switch starts a new isolated login afterward.
Generation checks prevent work delayed across a switch from starting on the next account.
`imageAccess()` includes `accountGeneration` when ready; callers pass that ticket to
`generateImage({ accountGeneration, ... })` so even a switch between those two calls refuses
the old drawing request. A missing/reloading ACP service never authorizes legacy image billing.
A failed logout stays paused until the owner retries. Authentication changes hold an installation
lock; close other app instances registered on that vendor home before changing accounts.
Automatic app-crash recovery is Unix-only and requires proof that the recorded login group
ended. On Windows, a dead app's login record stays blocked, even if an old Job nonce exists;
Windows crash recovery is the owner's Reset Bot sign-in action, followed by fresh sign-in.
Automatic Windows recovery is deferred to
[follow-up #1076](https://github.com/automagik-si/automagik/issues/1076).
The normal Windows sign-in and stop path still waits for its live supervisor's empty-Job proof.
A dead app PID alone never clears ownership. Dead recovery claimants can be reclaimed under
installation-level serialization after the lock owner and applicable proof are revalidated.
`accountRecovery(id)` reports `{ required }` per vendor without running its CLI. Cold Bot settings
keep a recovery row for a blocked vendor while the other vendor remains usable.
The owner-confirmed `accountReset(id)` pauses admission and stops known work, then selects a
fresh, empty, uniquely named vendor home and requires fresh in-app sign-in. It never logs out,
copies credentials from, renames or reuses the previous physical folder. Pending, damaged and
legacy ownership evidence stays there: even a surviving old process writes only to that old
generation. Abandoned folders are removed on later starts only after exit evidence is verified;
unproved folders, including Windows crash records, remain retained. Mutexes and app registrations
live outside replaceable homes.
Launches also check the installation's selected generation, so changing an old folder's local
version or pause marker cannot revive a captured launch. Bot models and DSH history stay intact.
Bot CLI user settings start empty; project settings still load from the working folder.
Account details stay on owner-only routes, never in state, transcripts, model calls or logs.

**Credential-store assumptions and missing live checks.** Claude's documented macOS Keychain
entry is namespaced by `CLAUDE_CONFIG_DIR`; Codex's current OS-keyring implementation derives
its key from `CODEX_HOME`. Separate directories rely on those namespaces remaining distinct in
the installed vendor versions. Fake-store/process tests do not prove the live credential paths.
Two checks remain open on #869:

- Real macOS, two accounts: sign in, switch and sign out inside the app for both vendors, and
  verify the terminal login remains intact throughout.
- Codex's OS-keyring-backed auth path, with separate Bot and terminal homes, through the same
  sign-in/switch/sign-out sequence (not only the `auth.json` file path).

See [Claude authentication](https://code.claude.com/docs/en/authentication) and
[Codex auth storage](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)
for those upstream namespace contracts.

**Settings migration:** terminal user settings, hooks, MCP servers, skills and CLI sessions are
not automatically imported. Project settings still load in chat work; account/status/login
commands and catalog probes run in the private home. Configure Bot user settings separately.
RFC 0003's isolation amendment explicitly supersedes its earlier global-settings promise.
Native-ACP agents keep their existing opt-in terminal-sharing contract.

The account record in the isolated root stores per-install HMAC digests, never an email,
organisation, plan, token or key. If it cannot be saved, a new connector waits in `failed`
state with its reason and Retry; an already installed connector can still update. Account
identity comes from the CLI's status, not a credential file. A CLI that does not report an
identity is shown as unknown.

<a id="images-through-codex"></a>

**Images through Codex.** `generateImage` is a one-off codex-acp session that asks Codex's
built-in image tool for one picture (owner decision D-g). Each draw gets an empty scratch
folder, no MCP servers and no bridge. Before the checks, it writes an owner-only
`.codex/config.toml` there with a fresh, unpredictable permission profile and that profile as
`default_permissions`. Its filesystem rules deny `:root` and allow only `:workspace_roots`
to be read. It has no network table, `extends` or `:minimal` roots. After `session/new`, the
run selects `permission-profile:<id>` and waits for the adapter to acknowledge it before
sending the prompt. This is containment, **not a scratch-only read boundary**: Codex's
filesystem helper adds runtime read grants even though our config omits them. Images in
those runtime directories remain readable by design; see the platform list and pinned sources
below. The folder and its config are removed afterwards.
`CODEX_HOME` is the Bot's isolated Codex home, supplied by `cli-homes.js`; the terminal's config
is never written. The tool overrides still go through codex-acp's `CODEX_CONFIG`.

If the adapter does not offer the profile mode or rejects its selection, drawing continues
in `read-only` mode under the owner's current policy (`ALLOW_IMAGE_READ_ONLY_FALLBACK`). One
`warn` line names the reason without private details, and the result is marked internally as
not isolated. There is no UI change. A passing `imageAccess()` check means drawing is available;
it does not establish that this draw can select a profile. The internal `isolated=true` flag
means the adapter acknowledged the profile, not that image reads are scratch-only.

**Input ownership.** `drawImage` sends only prompt text. It accepts no local image-input path,
registers no ACP filesystem-read callback, and receives no pre-read image-tool arguments.
Codex selects and reads `referenced_image_paths` inside its own helper. There is therefore no
adapter-controlled input path on which to enforce realpath containment or reject symlink
components. `imageOf` consumes inline output bytes only; it never opens `savedPath` or resource
links. Checking reported output paths after a tool runs would not prevent its input reads.
A future path-input API must check realpath containment within the per-draw scratch and reject
symlink components before reading. That API does not exist here. **#870 remains open.**

**Chat images.** On Linux and macOS, a Codex Bot at Read only or Workspace now prefers the
app-owned `automagik-read-<hex>` or `automagik-workspace-<hex>` permission profile in its
isolated home; the chat spawn writes them and keeps the person's other lines in that file.
- **What they allow.** The chat workspace, project roots, Codex's runtime read grants, that
  home's skills and the layout of Codex's own executable (Linux's sandbox re-runs it for every
  command, and its `codex-path` holds Codex's `rg`; for npm's launcher, the native package it
  starts). Workspace also writes in the workspace, `/tmp` and `$TMPDIR`. Reads outside those
  grants stay denied unless supported exact-file session consent below authorizes them.
  Ordinary tool approvals do not add filesystem grants. This covers Codex's own `view_image`
  and `image_gen` local inputs in chat, through the step's sandbox in Codex 0.167.
- **When they are used.** Only after `codex sandbox -P <profile> -- true` passed with the chat's
  environment (once per executable); otherwise, and for an executable that does not resolve,
  the chat keeps the legacy modes. The home's `default_permissions` stays Codex's own
  `:read-only`: a legacy read-only turn takes its reads from the default profile.
- **Ids.** Per-home random ids keep a project's config from extending the profiles while the id
  stays unknown. An Auto or Full access chat in the same home can read that home's
  `config.toml`, and so could plant a matching project config for later chats.

**Outside image files: explicit chat-session consent.** In a managed Codex chat using a strict
Read only or Workspace profile, a structured `request_permissions` request for exact regular
image files can ask **Allow for this chat session** or **Reject** through DSH's person-answer
questions. The card names every canonical path and the session duration. Tool approval
policies, Auto review and native Allow once cannot create this authorization. Directories,
writes, network access and ambiguous requests are refused by this flow.

Allowing ends the current turn and cancels the native permission request. **Send a new message
asking to open the image.** The approval click does not open it, retry the interrupted task or
start a replacement process. The next genuine user message waits for bounded old-process,
bridge and mirror-result drain, rechecks the file identities, then starts the authorized
process. A failed stop, startup or exact profile acknowledgement sends no granted prompt.

The filesystem overlay exists only in that process's `CODEX_CONFIG`: it copies the strict base
and adds the approved canonical files as reads. It selects the current spawn's already-offered
random per-home managed profile id and requires acknowledgement, with no legacy fallback for
a granted read. The id is metadata, not authorization, and is not a fresh session id. No
approved path is written to the shared home config. Another chat using the same id gets its
ordinary base. Auto, Full, effective agent-own mode, catalogs and one-off drawing keep their
ordinary configuration; the base's workspace, temporary, minimal and runtime allowances stay
unchanged. This adds no attachment or runtime roots.

Authority belongs to that live root chat and is revoked on Stop, level/route changes (including
away and back), agent/chat/provider/account/plugin teardown, native request invalidation or
failed activation. Revocation retires a process holding the overlay. Reopened transcripts,
forks and other chats cannot recover it. New files need new consent; siblings are not implied.
The grant is path-based read authority, not an immutable byte snapshot: realpath/stat checks
at consent and activation do not eliminate later filesystem races. The per-home naming and
project-config limitations above still apply.

`test/session-files-native.test.js` records credential-free Linux evidence on Codex 0.169.0
and codex-acp 2.6.0 with a fixed loopback SSE peer: exact approved PNG bytes on the next user
turn, sibling/sentinel denial, concurrent same-home/id process isolation, fresh-base denial
after revocation and shared-config byte equality. It is opt-in via `AUTOMAGIK_TEST_CODEX` and
`AUTOMAGIK_TEST_CODEX_ACP`; `AUTOMAGIK_REQUIRE_SESSION_FILE_TEST=1` refuses absent prerequisites.
`AUTOMAGIK_TEST_SESSION_FILE_ROOT` optionally confines its disposable fixtures. This proves
the tested Read only flow, not Workspace `/tmp` denial, other versions/platforms or observed
application acceptance. Unsupported ordinary sessions retain their existing base behavior;
they cannot fall back to another mode to activate a session-file grant.

**Security warning (#870): full-disk reads remain in the legacy fallback.** Auto keeps `agent`:
codex-acp 2.6.0 gives profile modes one reviewer per session. Full access is unrestricted by
design. Windows keeps legacy modes, as do older adapters or a config that cannot offer the
profiles. Those modes and the one-off drawing fallback can read wherever the OS user can;
an injected request could put a local file's contents into a picture shown in chat. Files in
`/tmp` and `$TMPDIR` remain readable at Workspace, and no native macOS run is recorded.
Tool checks and permission refusals alone do not prevent these reads. Prompt text itself is
outside the file boundary and still reaches the model.

To avoid `generate_image`'s one-off Codex session, configure an OpenAI API key for the Images
API, or turn Codex off in the agent settings. Keep secrets out of the prompt. A Bot running
on Codex can still invoke its own image tool even with an API key configured. Use a different
Bot model or turn Codex off to avoid that route. Avoid forwarding untrusted channel messages
or other outside text into Codex drawing requests. Prompt review cannot enforce a file boundary.

Codex has no allow-list of tools. The following checks limit its other tools and refuse a run
when a check does not hold; Codex's profile plus runtime grants supply filesystem containment:

- **The checks, before anything starts.** The Codex the run would start is asked, through
  codex-acp's `cli` passthrough and with the run's own overrides: its MCP servers
  (`mcp list --json`, names only), its features (`features list`) and the tools it would offer
  the model (`debug prompt-input`). Nothing is sent to a model, and nothing of the answers is
  kept or logged but names. The checks read the Bot's isolated Codex home, signed in or not, as
  the session will, and run in the session's own scratch folder with the trust codex-acp gives
  it. Together they have 40 seconds; a stop from the caller ends them, and a command that
  hangs is killed with the Codex it started.
  - `shell_tool` and `view_image` must be listed, not removed, and off; `image_generation` must
    be on.
  - Every tool offered must be on a fixed list (`IMAGE_TOOLS_ALLOWED`, `IMAGE_NESTED_ALLOWED`)
    or be the image tool. A command tool, image viewing, an MCP tool, a tool this version does
    not know, an item of an unknown kind or no tool block at all stops the draw.
  - An `Invalid configuration` line on check stderr stops the draw, even if Codex exits
    successfully and uses defaults.
  - The list must be in the form this code knows. A tool of an unknown kind or with a field it
    does not know stops the draw. So does a tool `exec` reaches that is not written as Codex
    0.167 writes it (one `declare const tools: { name(…) }` block per tool, one tool per block,
    under a heading of its name), and an `exec` that names none.
  - The offered-tools check supplements the feature checks: Codex takes a `features.<name>` it
    does not know without a word, and several names change nothing in the tools a current
    Codex offers. Neither check establishes read isolation.
- **What is turned off.** The two features above; the other tool sources the installed Codex
  lists (`IMAGE_FEATURES_ALSO_OFF`: a name it does not list, or lists as removed, is never
  sent); web search; each of the person's own MCP servers by name; Codex's bundled skills and
  the person's own by name. This reduces tool sources; it does not restrict the image tool's
  file inputs.
- **One object.** The session's `CODEX_CONFIG` and the checks' `-c` arguments are built from
  the same overrides (`imageOverrides`, `configArgs`).
- **During the turn.** Every permission the agent asks is cancelled (codex-acp asks none for
  an image), and one that is not about the image call refuses the draw. The image comes back
  only when the turn has ended with exactly one call reported, the image call: any other call
  (a command, a read, a patch, a sub-agent, a tool), or a second image call, before or after
  the image, cancels the turn and refuses the draw (`refused`).
- **The image.** The PNG is taken from that call's own content (an ACP image block) or its
  `rawOutput.result`; the file Codex saves under its home (`savedPath`) is never opened. It is
  refused when it is not a PNG or is over 12 MiB.
- **The end.** The session is closed and the process ended when the turn ends, the caller stops
  it, or 120 seconds pass. Neither the prompt nor what the agent says is logged or kept.

A check that does not hold answers `acp/image-unavailable`, with what the person can do: update
Automagik or add an OpenAI key (this Codex does not take the lockdown), fix Codex's config file
(Codex could not load it), or try again (the check itself broke). One `warn` log line names the
feature or tool; the message shown does not. `imageAccess` makes the same check, remembered per
Codex and adapter for five minutes, and answers `{ ready: false, signedIn: true, reason }` when
it does not hold (`reason`: `unsupported`, with `unsupported: true`; `config`; `unreadable`), so
the Bot team goes on to its next image source, or says which it was. Only a check that ran out
of time leaves Codex ready. A draw always makes its own check.

**Security notes: containment limits and accepted fallback risk (#870).**

- **The image tool's own input in the fallback (risk accepted).** A prompt injection can
  ask Codex to use a readable local image file as input and return its contents in chat.
  codex-acp reports the image call without its arguments. No feature switch disables that
  input. In `read-only` mode codex-acp sends a full-disk `readOnly` policy on every turn;
  `CODEX_CONFIG` cannot narrow it. The per-draw profile mode instead sends the profile id
  on every turn. Codex's image accessor uses a sandboxed helper, whose runtime grants widen
  the profile's requested read boundary. The owner chose to keep the fallback enabled when
  that mode is unavailable or rejected; that decision does not establish scratch-only reads.
  Ordinary chat images (`agent-image.js`) use the chat profiles above at Read only and
  Workspace when offered. Signed-in enforcement on the actual per-turn path still needs
  verification in the app.
- **A tool that is offered and not reported.** Codex 0.167 keeps some tools on whatever the
  switches say: its `exec` JavaScript isolate, `wait`, its questions to the person, sub-agents,
  patches (which ask first, and are cancelled) and MCP resource listing (no server is on). Not
  every tool run is reported by codex-acp, so the model can compute inside the turn unseen.
  Codex describes the isolate as having no file system, network or environment, and no tool it
  reaches reads a file; that is Codex's word, checked here only by the list of tools. A tool
  Codex adds later fails the check by name; a tool it defers and does not describe would not.
- **What the model already holds.** It is in reach of a drawing either way: the prompt, the
  Bot's isolated Codex instructions and memories, and the run's own context (the date, the
  scratch path).
- **Tools that only show when signed in.** The automated tests see a signed-out Codex. The
  image tool, and anything else Codex offers only to a signed-in person, is first seen by the
  checks on the person's machine: an unknown one stops the draw there, by name in the log.
- **The Bot's Codex setup.** Instructions, memories and hooks in the Bot's isolated Codex home
  still load. Terminal user settings are not imported. The run uses the isolated environment.
- **After the fact.** A refusal comes when a call is reported, after it ran: it keeps the image
  from coming back, it does not undo a read.
- **The per-thread path.** The checks read Codex's command line (`-c`); the session gets the
  same overrides per thread, through codex-acp, which adds a rule of its own that turns one
  more skill off. That Codex honours them there the same way is tested only up to the sign-in
  (`test/image-codex.test.js`); past it needs a signed-in Codex, in the app.
- **codex-acp's own log.** codex-acp writes the config it is started with to its log file, so
  the names of the person's MCP servers and skills, and the scratch path, are there too.
- **The caller.** A prompt built from an outside message is still the way in. The Bot team
  shows the returned image in the chat it was asked from.

Follow-ups (#870 remains open): a pre-read image-input boundary inside Codex, signed-in
per-turn enforcement tests on each backend, and asking Codex for a switch for `exec`.

`test/image-codex.test.js` runs these checks against a real Codex and codex-acp in a throwaway
home (never signed in, no model request). It is skipped unless `AUTOMAGIK_TEST_CODEX_ACP`
(codex-acp's `dist/index.js`) and `AUTOMAGIK_TEST_CODEX` (a Codex executable) are set. The ordinary
plugin CI job installs neither; run it by hand when the installed Codex or codex-acp changes. At
runtime, an unknown required feature or an unrecognised offered tool refuses the draw.
Passing those checks does not prove that an image cannot contain locally read content.

**Runtime read grants (pinned source audit).** The source paths and line numbers below are
relative to `codex-rs/` at [Codex 0.167.1's commit][image-codex-source]
(`0a94398fa60c4fac0e7659e4213a0a36e613dd46`). `ext/image-generation/src/tool.rs:639-653`
reads inputs through the environment filesystem. `exec-server/src/fs_sandbox.rs:101-142,
235-272` adds `:minimal`, the Codex helper executable, and a distinct Linux sandbox executable
when present. These grants are allowed, not rejected by our profile.

- **Linux (bubblewrap):** `/bin`, `/sbin`, `/usr`, `/etc`, `/lib`, `/lib64`, `/nix/store`,
  `/run/current-system/sw` (`linux-sandbox/src/bwrap.rs:48-62`), plus helper executables.
- **macOS (Seatbelt):** helper executables and the platform runtime allowlist, including
  `/Library/Apple`, `/Library/Filesystems/NetFSPlugins`, `/Library/Preferences`, `/usr/lib`,
  `/usr/share`, `/var/db`, `/private/var/db`; system frameworks under `/System/Library`,
  `/System/iOSSupport/System/Library` and `/Library/Apple/System/Library`; `/Library/Apple/usr/lib`,
  `/etc`, `/private/etc`, `/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`, `/usr/libexec`,
  `/opt/homebrew/lib`, `/usr/local/lib`, and listed system files/device handles. The complete
  rules (including metadata-only allowances) are in
  `sandboxing/src/seatbelt_read_only_platform_defaults.sbpl:1-188`; these are broader than
  just executable loading; the policy also honours granted app-sandbox read extensions.
  No native macOS enforcement run is recorded here.
- **Windows:** helper executables; elevated setup's platform roots are `C:\Windows`,
  `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`, plus its legacy helper-bin
  directory when applicable (`windows-sandbox-rs/src/setup.rs:73-78,582-589,623-651`).
  The unelevated restricted-token backend refuses split/deny-read restrictions
  (`sandboxing/src/windows.rs:110-132`). Helpers refuse an unavailable sandbox
  (`exec-server/src/fs_sandbox.rs:160-170`). No native Windows enforcement run is recorded;
  neither a mode acknowledgement nor a backend refusal proves cross-platform isolation.

The adapter forwards the profile id and runtime workspace roots per turn in
`src/CodexAcpClient.ts:1386-1424` at [codex-acp 2.6.0's commit][image-adapter-source]
(`f3208913693bd4d5171d6c6b9be5ec1ff96c6431`). That forwarding is source evidence, not an
end-to-end read test. These pins describe the audited versions, not an installation pin.

**Image read evidence.** `test/image-read.test.js` invokes the native Codex filesystem helper
(`--codex-run-as-fs-helper`, `fs/readFile`) under `codex sandbox`. It uses the production
`imageProfile` and explicitly appends the helper runtime grants above, because the sandbox CLI
alone does not add them. The test reads real PNG bytes: inside allowed; outside, symlink leaf,
symlink directory and parent traversal denied; runtime-directory PNG allowed byte for byte.
An unsandboxed helper control first proves the outside canary is readable. A startup failure
cannot count as a denied read. No account, credentials or model request is used.

Set `AUTOMAGIK_TEST_CODEX` to the native executable and `AUTOMAGIK_TEST_CODEX_RUNTIME_IMAGE`
to a public PNG under a runtime read root, then run `node --test test/image-read.test.js` from
this plugin. Use a scratch `TMPDIR` outside the runtime roots. The ordinary plugin suite skips
this test without those variables. CI's `acp-dsh (real Codex image reads)` job downloads the
checksum-verified native Codex 0.167.1 and its bubblewrap runtime. It runs
`node scripts/image-read-gate.mjs`, which requires a complete TAP plan, exactly seven passing
tests, and zero failures, cancellations, skips or todos. Missing configuration also fails.
`test/image-read-gate.test.js` proves skipped, todo and missing coverage fail despite Node's
zero exit code. The helper tests use public PNG canaries and no sign-in.
The test supports Linux/macOS invocation; Windows is explicitly skipped outside that job.
The recorded local run used Linux Codex 0.167.0, not the audited 0.167.1 binary. It proves helper
reads under a reconstructed policy, not automatic grant injection, ACP per-turn propagation,
or the authenticated image-tool path. Those integration checks still need a real signed-in
Codex on each supported backend; green CI does not establish them.

[image-codex-source]: https://github.com/openai/codex/tree/0a94398fa60c4fac0e7659e4213a0a36e613dd46
[image-adapter-source]:
  https://github.com/agentclientprotocol/codex-acp/tree/f3208913693bd4d5171d6c6b9be5ec1ff96c6431

**Images an agent makes in a chat.** A chat on an agent can ask it for a picture, and Codex then
uses its own image tool (an `other` call titled "Image generation"). The mirror call carries
`image: true` from the call's first sight, so the chat draws its image card at once and the
keeper's `start` lets that card count the wait. When the call ends, its PNG is taken from the
call's own update (an ACP image block, or the image call's `rawOutput.result`; the same for any
agent's call that answers with an image block, as Claude Code could) and handed to the keeper;
the call's result names the kept file (`Image generated and saved as <file>.`) and never the
agent's saved path or the image's bytes. The file under the agent's home is never opened. A call
that fails, is stopped, answers with something that is not a PNG, or has no keeper ends with its
reason, and the card says the image was not made. The agent's reply then links the image by the
local path it saved it at; that link (a markdown image or link to a local path in a
`generated_images` folder, or to a path the agent's image call reported) and any bare such path
leave the text as it streams, before DSH writes it, so neither the chat, the stored reply nor a
later replay carries it. Other links are left as the agent wrote them.

**Images in tool results.** A DSH tool that answers with an image (a Bot's `browser_screenshot`,
a read of a picture) keeps it when the bridge hands the call to the agent: the back-channel reads
the durable attachment and answers the agent's MCP call with ACP image content
(`{ type: 'image', data, mimeType }`), beside the text it already carried; an inline image block
passes through as the base64 it already is, never encoded twice, when it is `image/png`,
`image/jpeg`, `image/gif` or `image/webp` and at most 5 MiB decoded; anything else becomes a
one-line text placeholder saying why. So does an attachment the store has not read in time:
the reads of one result have 10 seconds together (after a read of 9, the next has 1), the read
still running then is aborted and the ones after it are not started. An image nested deeper
than the result's content (inside a resource, say) is reported with the same placeholder and
never sent; the search for those reads 16 levels and 20 000 values, plain fields only (never
bytes, and no field computed on reading is followed), and a result
it could not read to its end says so in one more line (so does a text-only result that large).
For a nested image and for an attachment's reference, a placeholder repeats the media type
only when it is a plain `type/subtype`. The agent's own call that answers with an image keeps the
same picture in its mirror result, stored once in DSH's attachment store as
`{ type: 'image', attachment }`, so the chat's card, the stored result and a later replay show it;
with no attachment store mounted the call keeps its text result rather than writing inline base64
into the log. Text and resource results keep the single text block they had.

The switches are not the service's: a page writes them in the `acp-dsh` settings entry
through DSH's settings service (the welcome does, `src/host/acp.js` there).

**Sign-in attempts.** One per agent, Claude Code and Codex independently, owned by this host; a
page is only a view of one, and reading it (a second window, a reload, another Bot) never cancels
it. Only an explicit cancel, the expiry, a failure or the plugin's disposal ends it. The expiry is
the provider's when its answer reports one (at most an hour), otherwise ten minutes from the link
shown; the CLI has 45 seconds to print its link. The CLI keeps its own credentials: no model,
transcript, tool or credential store is involved, and no link, code or state is logged. A sign-in
the CLI confirms is recorded only for the executable that confirmed it and announced as
`acp-dsh/login-ready` (the Bot team applies the model the person chose); the number at work is
announced as `acp-dsh/login-active` (the welcome's busy file adds it, so the app's automatic
restarts wait). These methods are not tools and not listed by `status()`; the only caller is the
Bot team's owner-only route (its README, "Signing in to Claude Code or Codex").

### Required desktop CLIs

The desktop installs Claude Code and Codex automatically on first startup and after updates,
including in existing profiles and with either model switch off. Five seconds after every ACP
start, it resolves the official packages' stable `latest` releases and installs anything missing
or older. The same check runs after any plugin installation/update and every fifteen minutes,
even when a previous check found no update. Lifecycle checks bypass the recent-check cache;
simultaneous triggers queue one fresh check after an active download. App and desktop plugin-lane
updates restart DSH, so they also perform a fresh check. Standalone DSH keeps using its existing
tools. No login, API key or onboarding reset is part of installation, and no model preference,
setting or credential is rewritten.

The desktop's bundled pnpm installs `@anthropic-ai/claude-code` and `@openai/codex` with their
native platform packages under `$AUTOMAGIK_HOME/acp/clis`. Dependency scripts are disabled,
registry tarball integrity is checked and the binary must pass `--version` before its staging
folder is published. Linux glibc/musl, macOS and Windows x64/ARM64 layouts are supported; an
Apple Silicon Mac running the desktop through Rosetta uses ARM64 binaries.

A current or newer user CLI is reused. An older global installation stays untouched while
Automagik installs its own newer copy. An existing CLI whose version cannot be determined stays
untouched while Automagik selects a verified managed release instead of claiming it is current.
Completed managed versions never downgrade and remain available to sessions already using them.
Managed Claude's own updater is disabled; Automagik owns this copy's updates. Settings,
credentials and global command links remain untouched. Local versions are compared before the
registry request, so an offline restart keeps the newest verified local copy.

A failed download preserves the working version, records a redacted diagnostic in CLI status
and retries at the next check or through the existing `retry(id)` service. Stopping ACP cancels
its downloads and removes incomplete staging folders. Official distribution references:
[Claude Code setup](https://code.claude.com/docs/en/setup),
[Codex CLI](https://developers.openai.com/codex/cli).

The adapters are not pinned (RFC 0003, amended): an adapter that lags its CLI breaks first.
They install in the background at DSH's start and once a day after,
with the desktop app's own pnpm (`AUTOMAGIK_PNPM`, never the person's) or else npm, into
`$AUTOMAGIK_HOME/acp/adapters/<package>/<version>`. An install goes to a fresh folder renamed into
place when complete, without install scripts or optional dependencies (the CLIs the adapters
bundle); an install that pulls in a bundled CLI's platform package anyway is refused. The
version an install replaces stays on disk, for a Session still on it, until the next successful
check (about a day), whether or not it finds something newer; while it is still the way back
for an unproven release it stays longer (below). Nothing is downloaded when a Session starts.

npm is asked for a newer release once the last check is 20 hours old, by a timer that runs
every 4 hours: at least once a day. A new release must start before it replaces the one in
use. In its fresh folder it is spawned the way a Session would spawn it and asked
`initialize`, nothing more (`src/host/handshake.js`): it must answer within 20 seconds, on the
protocol version the library speaks. One that fails is removed, the connector in use stays
(the last-known-good), and that version is not tried again for 3 days; a newer release is
tried at once. One that passes is still unproven until it has opened a session: until then the
release before it stays on disk, and a session start that fails on it (anything but a missing
sign-in or a missing bridge) goes back to that release and tries the start once more, so the
turn is not lost. A newer release that lands while the one in use is still unproven keeps the
same way back: the last release that opened a session stays on disk until a newer one has, and a
release gone back to is proven only if it had opened a session before. Both cases are logged and recorded in `current.json` (`bad`, `rolledBack`),
and `status()` shows them while the failed version is held back. A first install has nothing
to go back to: it is used even when its check fails, and the log says so.
An install still running when DSH quits is killed with everything it started and its folder
removed; one a killed DSH left behind is removed at the next start.
Until the first install lands, the agent lists no model; a Session already on it says the
adapter is being installed, with the last install error.

**Repair (#970).** A connector folder can be damaged while its entry script is still there. Retry
reinstalls the release in use (npm is not asked) into a fresh folder, asks it `initialize`, and
only then selects it: `current.json` names the new folder (`dir`, `<version>_r<time>`; `previousDir`
for the way back). The folder it moved off is never deleted or renamed while a Session may still
run it: it is listed in `retired` and kept for one check window (20 hours), as a replaced release
is. A repair that fails leaves everything as it was, records the failure, and never holds the
release back. A session start that dies because Node could not find a module in the connector's
own folder (the "Cannot find module/package" line or the first file of the require stack, never
another program's frames), with no release to go back to, starts that repair by itself once per
release per run, and the turn says so.

**Lockfile (#970).** Each install records the lockfile its package manager wrote
(`pnpm-lock.yaml`, or `package-lock.json` for npm) in
`$AUTOMAGIK_HOME/acp/adapters/.locks/<package>/<version>/`, before the start check, so a release held back keeps it. A later install of the same release (a
repair, a held-back release tried again) copies it in and installs frozen: `pnpm install
--frozen-lockfile --prefer-offline`, or `npm ci --prefer-offline`. With the packages already in the
package manager's store this needs no network. An install from before this change uses the
lockfile in its own version folder. A new release resolves fresh and records its own. A frozen
install that fails (not a quit or a timeout) resolves afresh once and records the new lockfile, so
an app update whose pnpm cannot read an old lockfile does not stop Retry for good. Lockfiles of
releases no longer kept are removed.

**No network at the first start (#970).** The check for the newest release is a request to
npm. When it gets no answer (a name that does not resolve, a refused or dropped connection,
the check's own 15-second deadline: a closed list of connection failures) and the connector
is not installed yet, the install is tried again by itself after 1, 5, 15 and 60 minutes, then
by the regular check. One failed check is one step, whoever waited on it; a retry installs
only while the agent is on, its CLI found and its connector still missing. An answer npm did
give (any status), any other install failure and a connector that is installed are not retried
sooner. What `status()` and a turn say of the failure is unchanged (the installer's own
words); a plain sentence for it belongs to the settings page and its translations.

## Check it

```sh
bun install && bun run harness
bun run test          # the adapter against the fake agent over real stdio
bun run lint
node dev/dsh-check.mjs   # one dsh headless turn on acp-fake (fake-small, high effort) in a temporary DSH home
node dev/dsh-check.mjs --agent claude   # the same on your own Claude Code (a few tokens)
node dev/dsh-check.mjs --agent codex    # the same on your own Codex (a few tokens)
```

`dev/dsh-check.mjs` installs the plugin the way DSH installs any plugin and reads the Session
log: the agent's text, a `tool/call` of `acp_tool` with its `tool/result`, and the
`approval/asked` and `approval/decided` pair for that call.

### The ACP library, and a log that always loads

The plugin speaks ACP through `@agentclientprotocol/sdk`, pinned to one exact version, on its
`/unstable` entry (stable ACP v1, plus `session/fork` and the session updates newer adapters
send). The agent's `initialize` answer is compared with the protocol version the library
speaks: an agent that answers another one does not start, and the failure says whether to
update Automagik or the connector.

**The write-time guard** (`src/host/write-guard.js`). DSH's Session reader refuses a whole
conversation for one bad step, and the bridge writes its rows beside DSH's own loop. While a
bridge serves a Session, every row written on it passes the guard first, which keeps the same
books as the reader. A `step/end` or `turn/end` over a call with no result closes the call
first (as superseded, or cancelled at a turn's end; DSH's own not-started repair for a call
that never started) and hides its advertisement; a result for a call that is not open, or
stamped with a step that has ended, is not written; a call with no advertisement is refused.
At a step or turn's end the guard also hides an advertisement left by an earlier turn once
all its calls have results, recording the repair as `advertisement-hidden`.
Each repair leaves a log line and a `plugin:acp-dsh/write-guard` record in the Session.

`test/sequence-fuzz.test.js` drives random interleavings of calls, results, cancellations,
overlapping calls and step and turn ends through the real back-channel on a real Session, and
loads the log with the pinned reader after every move. `FUZZ_SEED` and `FUZZ_RUNS` replay one
seed or widen the search.

**Drift.** `node scripts/acp-drift.mjs` fails when the pin is more than one minor behind npm's
latest, and names each adapter that moved past `dev/acp-compat.json`, the record of the SDK and
adapter versions the suite last passed against (`--record` writes it, after the suite and the
real-adapter tests passed). The `ACP drift` workflow runs it daily and opens an issue on drift;
every pull request checks the record against the pin.

The same workflow has two more daily jobs. `adapters` installs the newest adapters and CLIs
from npm (`node dev/install-adapters.mjs <folder>` does the adapters' half anywhere) and runs
the suite with the real-adapter tests on and a wider fuzz; a red run opens an issue. `bump-check`
runs when the pin is behind npm at all: it moves the pin and the lockfile on `dev`, runs lint,
the suite and the real-adapter tests, and records the versions, with a read-only token and no
credentials on disk. `bump-push`, which runs no package code, then pushes `bot/acp-sdk-<v>`
with the pin, that lockfile and that record, and opens or updates an issue that names the
branch and the results: Actions may not open pull requests in this repository, so a person
opens it. Any failure opens or comments on one bump issue. It never merges.

`test/real-adapters.test.js` starts the real adapters with this client in a throwaway home
(never signed in, no model request): the handshake, the session start or its `auth_required`,
the bridge's first tool list, and Codex's fork and close. It is skipped unless
`AUTOMAGIK_TEST_CLAUDE_ACP` and `AUTOMAGIK_TEST_CLAUDE`, or `AUTOMAGIK_TEST_CODEX_ACP` and
`AUTOMAGIK_TEST_CODEX`, name an adapter's `dist/index.js` and its CLI.

## Contracts

The plugin id `@automagik/acp-dsh`, the row id and storage prefix `acp-dsh`, the provider ids
`acp-<agent>` (never `claude-code*`, which the Bot team reads as the Claude Code plugin) and the
tool name `acp_tool` are public: Sessions keep them.


### Auto on every route

`acpAgents.ownMode` can request Claude Code's `auto` mode or Codex's `agent` mode, including bridged sessions. Two exact `true` answers are required before a prompt. Strict sessions retain their existing mode handling.

A bridge approval carries `bridgeCall: { agentAsked }`. This is false at the start of each prompt and becomes true when a CLI in its own mode asks permission. A judge may set `bridgeCall.judged = { reason }` when rejecting; the bridge reports `Auto's judge refused <tool>: <reason>.` without attributing it to the person. A mirror approval carries `mirrorCall: { title, kind, input, allowOnce }`, plus `locations` when the call has some, captured from the current permission request immediately before asking. It is plain JSON: DSH passes an approval it does not answer on to its remote approval card only as lossless JSON, so no member is ever `undefined`. A judge may set `mirrorCall.judged = { reason }` when rejecting; the call's result then reads `Auto's judge refused <title>: <reason>.` and the agent gets its own reject option. Only an offered `allow_once` permits an automatic one-shot decision. The person's answer retains the existing `allow_always` fallback.

Codex review events are counted per prompt. When an own-mode prompt ends after three consecutive or ten total refusals, or immediately after a refusal without subsequent activity, an `acp-session` notice with `stop: 'refusals'` explains that replying can continue; refused steps stay refused. The turn finishes as `stop`. Strict prompts keep their existing ending.

Auto and tool deny lists coexist. A list change keeps the mark, moves the permission revision,
ends the agent sessions and drops outstanding Auto grants. DSH's executor guard refuses denied
native/API and bridged calls whatever the judge says. Unbridged built-ins and team agents' own
tools were never covered at Workspace either; they must use DSH's bridge for a deny to reach them.

At asking levels, Automagik's never-auto list covers the existing destructive steps plus secret
files/token commands, external messages (including plugin `sendsOutside` hooks), shared or
ambiguous pushes and deletes outside the Bot's folder. Claude Code receives the expressible
part as session-only ask rules. Outside-folder deletes and ambiguous push targets cannot be
expressed as Claude wildcard rules; enforcing them needs a bridge or richer agent policy.
See [RFC 0031's #1092 amendment](../../docs/rfcs/0031-auto-permission-level.md#amendment-2026-11-13-1092)
for exact boundaries and negative controls.

Unmet dependency: Codex in `agent` mode runs built-ins on its own reviewer's word without
`session/request_permission` ([capture](test/fixtures/permission-payloads/README.md)). Automagik
cannot check those steps before they run. Codex/codex-acp needs a mandatory per-session ask
policy before its reviewer, or a blocking pre-execution request with tool, arguments and cwd.
Until then, that reviewer is Auto's only check for Codex built-ins.
