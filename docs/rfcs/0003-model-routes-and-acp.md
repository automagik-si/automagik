# RFC 0003: Model routes and ACP

| Field | Value |
|---|---|
| Status | In delivery (deliveries 1-4, 6 and 7: #187, #189, #537, #557, #558, #559, #563, #569, #585, #594; 5 (Gemini) open; amended 2026-11-06, 2026-11-08, 2026-11-09 and 2026-11-10; delivery 7's replay at a harness change to be replaced by [RFC 0030](0030-code-mode-in-the-app.md)'s handoff note, owner 2026-11-10, its Q7) |
| Milestone | 2. One message box (route descriptor); 3. Other agents in the same chat (ACP) |
| Lanes | plugin (3.N.P), desktop (3.N) |
| Created | 2026-10-30 |

## Summary

A model choice has two parts: the **Harness** that runs the loop, and how it is **Connected by**.
This RFC fixes the ids for both as a public contract, and adds our own lean ACP plugin as the
official way to run agents other than DeepSeek. Every route is an equal choice. Routes nobody
picks are retired later.

## Motivation

Today there are two ways to reach a model: DSH's own providers, and plans and keys through
pi-ai, Claude among them (a Claude Pro or Max sign-in, or an Anthropic API key). A third, Claude
through the Claude Code plugin (dsh-oh-my-claude), was removed (see Retired below). Each was added on its own, and the
picker shows provider ids, not what runs the work. ACP (Agent Client Protocol) is one protocol
for many agents. Community ACP plugins were reviewed; none passes DSH's own tools to the agent,
so a Bot on one would lose its team tools.

## Design

### Route descriptor

Every model entry gets a descriptor `{ harness, connectedBy }`, derived from its provider id.

| `connectedBy` id | Meaning | Provider ids today |
|---|---|---|
| `native` | DSH's own provider, signed in with a key or DSH's own sign-in | DSH's built-in ids |
| `pi-ai` | A plan through pi-ai (dsh-subscriptions) | pi-ai route ids |
| `claude-code-plugin` | Retired: the Claude Code plugin (dsh-oh-my-claude), no longer shipped | `claude-code`, `claude-code-<box>` (none served) |
| `acp` | An agent over ACP, through our plugin | `acp-<agent>` |

`harness` ids: `dsh`, `claude-code`, `codex`, `gemini`, and later `herdr` (RFC 0006).

- No ACP provider id may start with `claude-code`. The Bot team reads those ids as the retired
  Claude Code plugin's and moves them (below). ACP ids are `acp-claude`, `acp-codex`, `acp-gemini`.
- The descriptor is computed, never stored in place of a Session's model reference.
- The picker (RFC 0004) shows Harness and Connected by as rows under the model.

### The ACP plugin

- **Agents as DSH models.** Each configured agent is a provider route. A Bot or a chat picks it
  like any model. DSH keeps the Session, history and sidebar.
- **DSH tool cards and approvals.** The agent's tool calls render as DSH tool cards. Every call
  the agent asks permission for goes through DSH's approval dialog under the Session's level
  (what the agent's own settings already allow does not ask; see the Session's level below),
  except `mcp__dsh__*` while `dshTools` is on: acp-dsh answers that ACP request itself and the
  bridge raises the one DSH approval (Amendments, "One dialog per call"). How, for the agent's
  own tools: each call it makes ends the model step with a call to `acp_tool`, a mirror tool
  registered in that agent's scope only. DSH writes those `tool/call` and `tool/result` rows and
  draws the card from the call's ACP kind (terminal, diff, generic); the mirror tool waits for
  the agent's call to finish and, when the agent asks permission, asks DSH's approval service and
  hands the agent the answer. A DSH tool call is not a mirror call: the bridge is the MCP server,
  so the bridge writes the `tool/call`/`tool/result` rows and DSH draws the single card from
  them; the call never reaches the mirror, and acp-dsh draws no card for that ACP call. On
  `acp-claude`, acp-dsh matches it by the structured MCP tool name (`mcp__dsh__<tool>`, the name
  Claude Code sends in `session/request_permission`), never by the display title. On
  `acp-codex` the spike gives no structured name for the call at all (the only
  `mcp__<server>__<tool>` name it saw was inside Claude Code's permission request, which Auto
  never sends), so matching there is unsupported until delivery 6 proves a structured name in
  its tool call; until then acp-dsh draws no card from the ACP call and the bridge's rows are the
  single record. DSH's side requests on an ACP route (a title, a summary) are refused at the
  `llm/stream` waterfall, so they never reach the agent as prompts.
- **The team's tools over MCP.** A Bot's team tools reach the agent through an MCP server the
  plugin hands to the agent per session. It exposes only the tools the Bot's level allows.
  (Amended, 2026-11-06: that bridge carries the Session's whole preset tool set, the team's tools
  included; it ships behind `dshTools` (absent means the per-agent default; see Amendments.)
- **The person's own CLI, the newest adapter.** (Amended, owner decision D17.) An agent is offered
  only when its CLI is installed (`claude`, `codex`, found on PATH or where their installers put
  them); it runs that CLI, which the person signs in to and which updates itself. Between DSH and
  the CLI sits the agent's ACP adapter (`@agentclientprotocol/claude-agent-acp`,
  `@agentclientprotocol/codex-acp`; the `@zed-industries` names are deprecated), at its newest
  npm release: installed in the background at DSH's start and once a day after, into
  `$AUTOMAGIK_HOME/acp/adapters`, into a fresh folder renamed into place only when complete,
  without install scripts or optional dependencies (the CLIs the adapters bundle). The install
  uses the desktop app's own pnpm 10 (`AUTOMAGIK_PNPM`), never a newer pnpm the person has
  (pnpm 12 installs the bundled CLIs anyway: about 700 MB for the two), else npm; an install
  that still pulls in a bundled CLI's platform package is refused. Nothing is downloaded when a
  Session starts: no `npx`. An agent lists its model only once its adapter is installed, so
  nothing can pick it before it can answer; a Session already on it says the adapter is being
  installed, with the last install error when there is one.
- **The Session's level, as the agent's own mode.** Before each prompt the plugin sets the agent's
  ACP session mode from the Session's level (its sandbox as DSH's sandbox-policy service resolves
  it, the deployment default included): Claude Code in Manual is Claude Code's `default` mode,
  whatever default mode the person's own Claude Code settings name; Codex in its sandbox matching
  DSH's (`read-only`, `workspace-write`), except for the confirmed Bot Auto mode in the amendment below. DSH's Auto review is Claude Code's `auto` and Codex's `agent`.
  Full access is `bypassPermissions` and `agent-full-access`, and any ask that still comes is
  allowed, as DSH allows its own tools there. An agent that does not offer the strict mode
  (`default`; `read-only` or `workspace-write`) fails the turn; one that lacks a permissive mode
  gets the strict one instead.
- **Claude Code keeps the person's own settings.** (Owner decision, 2026-11-03. Superseded for
  tools and approvals while `dshTools` is on, 2026-11-06: see Amendments, delivery 6. Their
  CLAUDE.md, MCP servers and hooks keep working; what changes is that the agent runs DSH's tool
  set, and DSH approves each DSH tool call.) With `dshTools` off (the kill switch), the Claude
  adapter loads the person's Claude Code settings (user, project and local), and Claude Code asks
  DSH only for what those leave as "ask": in Manual, a call the person's allow rules or saved
  "always allow" rules permit, or a PreToolUse or PermissionRequest hook approves, runs with no
  DSH dialog; a call they deny is denied. With `dshTools` on, the same rules still answer Claude
  Code's own `session/request_permission`: they stop Claude Code asking, and still cannot skip
  the bridge's DSH approval, which every DSH tool call raises (Amendments, "Approval"). Their
  CLAUDE.md and hooks keep working in both states; their MCP servers keep working in both.
- **Resume.** Use the agent's own session load when it offers one; otherwise start fresh and say so.

### Retired: the Claude Code plugin

The desktop profile no longer ships dsh-oh-my-claude or pins its fork (owner, 2026-11-02, D16
and D17). Claude runs on pi-ai's `anthropic` route until `acp-claude` ships.

- **Profiles.** An app update takes the plugin out of a profile an earlier build installed
  (`RETIRED` in `apps/desktop/src/dsh.js`): its folder, dependency, bundle and patch rows.
- **Bots.** Once per team (`claudeCodeMoved` in state.json), a Bot on a `claude-code*` model
  moves to the closest pi-ai Claude model (`apps/bots-dsh/src/host/claude-models.js`): an alias
  to its family's newest, a version to the nearest one pi-ai serves, `default` to Opus. The old
  ref stays on the Bot as `claudeCodeModel`. Sessions and their history stay. Moving those Bots
  on to `acp-claude` waits for delivery 4: until the team's tools reach the agent over MCP, a Bot
  on `acp-claude` would lose them (posting to its group, reading the group chat, recall).
- **Auto.** The fork's last build started a new Claude session in Claude Code's own `auto`
  mode; it shipped only in the broken 3.53.0 to 3.54.1, and the team's Claude Bots ran on full
  access, so nobody depends on it. On pi-ai, a Bot's level is DSH's preset, Auto included. The
  ACP Claude adapter should map a Session's Auto to Claude Code's `auto` permission mode, never
  to `bypassPermissions`.

### Decided

- The first ACP delivery carries Claude Code and Codex together (owner, 2026-10-30).
- Adapters are not pinned: always the newest release, running the person's own CLI (owner, D17,
  2026-11). This replaces the pinned-adapter rule and answers open question 1.
- acp-dsh is on by default in the desktop profile (owner, D17, 2026-11).
- Claude Code over ACP keeps the person's own Claude Code settings, allow rules and hooks
  included (owner, 2026-11-03. Reversed for tools and approvals, 2026-11-06: an ACP agent runs
  DSH's tool set and DSH approves every DSH tool call; see Amendments. The person's CLAUDE.md,
  their own MCP servers and their hooks keep working).
- An ACP agent runs the same DSH tool set as a vanilla Session, built from the Session's preset,
  over a per-session stdio MCP bridge; every DSH tool call is approved by DSH, whatever the
  agent's own rules say; the agent's built-in tools are off where its adapter has a switch
  (owner, 2026-11-06, #516). Both ship behind `dshTools`, whose absent default is per agent (the
  default flipped, see Amendments, "Default and kill switch"); live switching carries history
  each way, redacted, with a visible provider-boundary notice (owner, 2026-11-06, #516). The
  council behind this: [dsh-022-council.md](../research/dsh-022-council.md).

### Per-teammate models (status note)

Agent Teams teammates can run on their own model. The runtime patch shipped in #130: it is
applied at build time, checked against an exact DSH version and file hashes, and stops the build
on a mismatch. A follow-up adds a check that no profile-local copy shadows the patched one. A
proposal to DeepSeek is drafted and waits for the owner's approval before it is posted. The
patch is removed in the release whose DSH carries the change.

## Contracts introduced

- `connectedBy` and `harness` ids above. Compatibility: derived from existing provider ids, so
  every existing Session and Bot keeps its model.
- Provider ids `acp-<agent>`. New; no collision with `claude-code*`.
- Tool name `acp_tool` and its arguments `{ id, title, kind, input, locations?, diffs? }`. New;
  Session logs keep them.
- Plugin id `@automagik/acp-dsh` in `apps/acp-dsh`, storage prefix `acp-dsh`. New. It joins the
  one-version list and the release loop.
- The adapter packages by exact name, `@agentclientprotocol/claude-agent-acp` and
  `@agentclientprotocol/codex-acp`, at their newest release (no pin list; amended, D17).
- Settings `claude` and `codex` (on unless set off) and the install folder
  `$AUTOMAGIK_HOME/acp/adapters`.
- The bridge (amended, 2026-11-06): one stdio MCP server per ACP session, named `dsh`, passed in
  that session's `session/new` `mcpServers` as `{ name, command, args, env }`, `env` a list of
  `{ name, value }`. The bridge itself never listens on a port. It reaches DSH over a per-session
  back-channel to acp-dsh, authenticated with `DSH_BRIDGE_CREDENTIAL`: a per-session, unguessable
  value minted by acp-dsh at spawn and passed only in that bridge's `env`. It binds a request to
  its Session and is revoked when that bridge exits; a fork mints a new one. It is not a boundary
  against same-user code: third-party code running as the person can read the bridge's
  environment. What holds regardless is server-side: the credential carries no approval, and
  every DSH tool call enters DSH's approval service keyed to the Session. It offers the Session's
  preset's tools, filtered by the Session's level, and answers every DSH tool call through DSH's
  approval service. Its failure is the turn's: a bridge the adapter skipped (a same-named server
  in the person's Codex config) fails the turn instead of running with half a tool set.
- Setting `dshTools` (absent means the per-agent default; false is the kill switch): the bridge
  and live
  switching. Off is the 2026-11-03 behaviour: each agent keeps its own tools and its own
  approvals.
- The provider-boundary row: a Session-log row that names the provider a turn came from or went
  to, so a switch is visible in the chat.

## Threat model

Each bullet names the `dshTools` state it describes; `dshTools` is absent by default, which
means the per-agent default (Contracts).

- **Who can reach it.** The agent is third-party code running as the user, with its own tools.
  With `dshTools` on, the MCP bridge also hands it DSH's tools (amended, 2026-11-06); with it
  off, the agent keeps its own tools and its own approvals, as on 2026-11-03.
- **What it can do.** (`dshTools` on, amended 2026-11-06.) DSH's tools come back through the
  bridge and every one of their calls is approved by DSH under the Session's level, whatever the
  agent's own allow rules, hooks or mode say. The agent's own tools are off on `acp-claude`; on
  `acp-codex` they stay, so a Codex turn can still run its own file and shell tools under the
  Codex sandbox the level sets. If the agent offers no strict mode, the turn fails rather than
  run in the agent's own default. (`dshTools` off.) The agent runs and approves its own tools;
  nothing of DSH's is handed over MCP.
- **Authentication.** The agent command comes only from host-side settings, never from a client
  route. (`dshTools` on.) Two legs: the adapter→bridge leg is the stdio contract decided
  2026-11-06 — the adapter spawns the bridge with the session's own arguments, the bridge holds
  no listen socket (no port, so no address another process on the machine can reach) and dies
  with the adapter. "Nothing on the machine can address it" is true of this leg only: the
  bridge→DSH leg is a per-session back-channel that has an address by construction. Its
  credential `DSH_BRIDGE_CREDENTIAL` binds a request to its Session and is revoked with the
  bridge; it is not a boundary against third-party code running as the person, which can read the
  bridge's environment (Amendments, "The bridge"). The boundary that does not depend on it is
  server-side: the credential cannot approve, and DSH's approval service owns every DSH tool call
  for the Session. The stdio leg's transport is spiked; the credential-bearing back-channel shipped
  (#537), and delivery 6 probes both refusals (Deliveries, 6). (`dshTools` off.) No
  bridge exists, so neither leg does.
- **Credentials.** Stored with mode 0600 or in the OS keychain. Never returned to the client.
- **Supply chain (amended, D17).** Adapters are not pinned. What that costs: a second publisher,
  the `@agentclientprotocol` npm organisation, joins a boundary that already holds Anthropic's and
  OpenAI's own CLI update channels, and its releases reach installed apps within a day with no
  review of ours. A bad or hijacked publish runs as the person, with what the agent CLI can
  already reach (their files, their sign-ins). What still holds: the exact package names, npm's
  integrity check of every tarball, no install scripts, no optional dependencies, nothing fetched
  at spawn, and an install that fails leaves the previous adapter in place. Since #958 the same
  holds for a release that installs and then does not start: it is asked `initialize` before it
  replaces the one in use and is kept out for three days when it fails, and one that fails its
  first session start goes back to the release before it (`apps/acp-dsh/src/host/install.js`).
  That covers a release that cannot start, not one that starts and misbehaves. The exact names cover
  only the two adapters: their dependency tree (the agent SDKs, JSON-RPC and process helpers) is
  resolved fresh for each new release. Since #970 the lockfile that resolution produced is kept,
  and a reinstall of the same release (a repair from Retry, a held-back release tried again)
  installs it frozen; a frozen install that fails resolves afresh once. Also new: the adapter
  carries its own copy of the agent's SDK (`claude-agent-acp` pins `@anthropic-ai/claude-agent-sdk`)
  and drives whatever CLI the person has, so the two can drift apart; nobody owns that pairing,
  and a mismatch shows as a failed turn, not a silent one. Turning `claude` or `codex` off in the
  plugin's settings removes that agent and its updates.
- **Undo.** The plugin is on by default in the desktop profile and offers an agent only when its
  CLI is installed. Turning it off removes its routes; Sessions on an ACP route fall back to the
  Bot's previous model.

## Deliveries

1. **Route descriptor.** Lane: plugin. Check: every model in the picker carries a descriptor,
   and existing Sessions resolve unchanged. Rollback: revert; nothing stored.
2. **ACP plugin skeleton.** New plugin, off by default, one fake agent for tests. Lane: plugin
   (not yet in the desktop profile). Check: a Session on the fake agent streams text, shows a
   tool card and asks through DSH's dialog. Rollback: revert.
3. **Claude Code and Codex via ACP, together.** The person's own CLIs through the newest
   adapters, installed in the background; plugin in the profile, on by default. Lane: desktop.
   Check: a new Claude Code session and a new Codex session from the DSH UI each run a tool call
   after approval (`apps/acp-dsh/dev/dsh-check.mjs --agent claude|codex` runs the same on a real
   DSH, headless). Rollback: the next
   release drops them; the Claude Code plugin route is untouched.
4. **Bots' tools over MCP.** The bridge's first slice: the team's tools reach the agent over the
   same per-session bridge delivery 6 completes. Lane: plugin, behind `dshTools`, on unless
   explicitly false. Check: with the setting on, a Bot on `acp-claude` posts to its group
   through a team tool, and a tool above its level is not offered. The back-channel is probed
   here, not only in delivery 6: a team-tool call raises `approval/asked` before it runs, a
   request without
   `DSH_BRIDGE_CREDENTIAL` is refused, one Session's credential is refused for another, and a
   fork revokes the old one. A build whose bridge cannot pass those is not offered under
   `dshTools`. With it, once per team, a Bot that ran on the Claude Code plugin
   (`claudeCodeModel`) and is still on the pi-ai model it was moved to goes to `acp-claude`, only
   where that route lists its model (adapter installed) and a live per-adapter-version bridge
   probe (a fresh credential, MCP `initialize` and `tools/list`) passes.
   Rollback: revert; the Bot is chat-only on ACP.
5. **Gemini.** Native ACP through the person's own Gemini CLI, with no connector adapter.
   Lane: desktop. Check: one session runs a tool call after approval. Rollback: the next
   release drops it.
6. **DSH's tools over the bridge** (amended, 2026-11-06). One stdio MCP bridge per ACP session,
   built from the Session's preset (`standard`, or `cordis` in creator mode) and filtered by the
   Session's level; every DSH tool call is approved by DSH; the agent's built-in tools are off
   where its adapter has a switch; its tool list refreshes on a preset or level change. Lane:
   plugin, behind `dshTools`, whose absent default is per agent. Built on the DSH 0.2.2 branch
   (`feat/dsh-022-upgrade`)
   and rebased onto `dev` once that merges. Check: on `acp-claude`, an approval is asked for a DSH
   tool call the agent makes, an always-allow `mcp__*` rule in the person's Claude Code settings
   cannot skip it, exactly one DSH dialog appears for that call in Manual, a tool above the level
   is not offered, and the agent's own tools are absent — probed with a **shell** tool, not only
   a file write, because `tools: []` also removes Bash in the adapter (read from its bundle); on
   `acp-codex` the same approval holds for DSH tools, the source session is `session/close`d after
   `session/fork` (its `session/close` support is unproven until this check), a preset change
   refreshes the offered DSH tools by that fork, and the turn says the agent's own tools stay.
   The bridge credential is probed too: a request without `DSH_BRIDGE_CREDENTIAL` is refused, one
   Session's credential is refused for another, a fork revokes the old one, and a credential
   alone cannot approve (the approval is server-side). The runtime detector for adapter drift is
   an allowlist, not a denylist: with `dshTools` on, every structured tool name the agent uses
   must be an MCP name — `mcp__dsh__<tool>` for the bridge, or `mcp__<server>__<tool>` for a
   server the session was given; any other structured name (a built-in file or shell tool, which
   `tools: []` should have removed) is drift. On the first non-MCP tool call the plugin records
   `acp_toolset_drift` and calls `session/cancel` on that same trace. It DETECTS and CANCELS; it
   does NOT prevent that first call: the handler runs after the call started, and in Auto or Full
   access there is no `request_permission` to deny. A bridge that never completes
   `initialize`+`tools/list` over the back-channel fails the turn with `acp_bridge_missing`
   before the prompt runs. The check runs at EVERY session start, not only at delivery 6's start
   or in CI: every spike fact is tied to adapter versions that update themselves (D17). Rollback:
   turn the setting off (the 2026-11-03 behaviour).
7. **Live switching** (amended, 2026-11-06). A Session moves between providers with its history,
   each way: the transcript is replayed (redacted) into the target, and what the agent streams is
   written back into the Session's log. Lane: plugin, behind `dshTools`. Check: a Session moves
   DSH → `acp-claude` → DSH with its transcript intact; a stored secret in that transcript never
   appears in an outbound prompt; a provider-boundary row shows at each crossing. Rollback:
   turn the setting off; the Session keeps the transcript it already has.

Delivery 1 is in milestone 2 (One message box), because the picker needs it. Deliveries 2 to 7
are milestone 3 (Other agents in the same chat).

## Open questions

1. **How are adapters delivered?** Decided (D17): not pinned; the newest release, installed in the
   background into Automagik's home, running the person's own CLI. install.sh (RFC 0008) needs
   nothing for it.
2. **When is a route retired?** Recommended: after two months with no Session on it in the
   team's own installs and no user report; announce it one release ahead.
3. **Separate plugin or inside the Bot team?** Decided: a separate plugin, `@automagik/acp-dsh`
   (D17), on by default in the desktop profile.

## Amendments

### RFC 0003 (model routes and ACP): DSH's tool set on ACP routes, and live switching

Owner decision (2026-11-06, tracker #516), on the council's recommendation
([dsh-022-council.md](../research/dsh-022-council.md)): **an ACP agent runs the same DSH tool set
as a vanilla Session, and DSH approves every DSH tool call.** This reverses the 2026-11-03
decision for tools and approvals (Design's "Claude Code keeps the person's own settings" bullet
and Threat model's "What it can do"), not for the person's CLAUDE.md, hooks or MCP servers. The
transport was spiked before this text was written, not the bridge→DSH leg:
[acp-dsh-tools-spike.md](../research/acp-dsh-tools-spike.md).

Auto review of a bridge call — the synthetic reviewer block, the side-model route, the redaction
and the fail-closed codes — is designed in
[acp-dsh-auto-bridge-review.md](../research/acp-dsh-auto-bridge-review.md).

**The tool set.** For DSH's tools, a Session on an ACP route is offered exactly what the same
Session on `dsh` would be offered: the tools the Session's preset registers (`standard`;
`cordis` when the Session is in creator mode, DSH's `cordis` agent preset), filtered by the
Session's level as DSH's sandbox policy resolves it. Nothing DSH's preset does not grant is
added through the bridge. The person's own MCP servers are not DSH's tools: they load beside the
bridge (see **The person's own MCP servers**), so the agent may hold more than a vanilla Session
because of them. An agent whose adapter cannot be held to DSH's set is still offered the bridge;
what it keeps of its own is named under **The agent's own tools** below.

**The bridge.** One stdio MCP server per ACP session, spawned by the adapter with that session's
own arguments, named `dsh`. Two legs, one credential story:

- **Adapter→bridge (stdio, decided 2026-11-06).** Both adapters spawn their servers themselves,
  so the bridge is a child of the adapter with no listen socket: the only way in is the adapter's
  own stdio pipe. "Nothing on the machine can address it" is true of this leg only — no port, no
  address. The spike proves the transport (a per-session stdio server, spawned with the
  session's own env, no port), not this leg with DSH behind it.
- **Bridge→DSH (the back-channel, shipped #537).** The bridge is the adapter's child, not
  DSH's, so it cannot inherit a pipe from DSH. It reaches DSH over a per-session back-channel to
  acp-dsh, authenticated with `DSH_BRIDGE_CREDENTIAL`: a per-session, unguessable value minted by
  acp-dsh at spawn and passed only in that bridge's `session/new` `env`. DSH accepts a request
  only with the value minted for that Session; it refuses a missing or another Session's value.
  The credential is revoked when that bridge exits, and a fork mints a new one. It is not a
  boundary against same-user code: a process running as the person can read the bridge's
  environment and reuse the value. The boundary that does not depend on it is server-side: the
  credential has no approval, every DSH tool call enters DSH's approval service under the
  Session's level, and a call waits for the person exactly as DSH's own tools do. Delivery 6
  probes the refusal without the credential, the revocation on fork, and that a credential alone
  cannot approve. The spike's server was an echo with no DSH link, so no part of this leg ran.

Each call arrives with the ACP session it belongs to; the bridge resolves it to DSH's Session and
refuses any other. The name is a contract, because a Claude Code allow rule reads `mcp__dsh__*`.
`codex-acp` skips a requested server whose name the person's own Codex config already defines, so
the bridge confirms it was started and fails the turn when it was not, instead of running with
half a tool set.

**Approval.** Every DSH tool call asks DSH's approval service (`approval/request`) under the
Session's level before it runs, and hands the agent DSH's answer; a refusal is an error to the
agent. The agent's own rules cannot lift it: an entry in the person's Claude Code settings that
always allows `mcp__*`, or a hook that approves it, stops Claude Code asking, never the bridge.
Delivery 6's test is exactly that: with such a rule saved, a DSH tool call still raises
`approval/asked` in the Session log and waits for the person. `session/request_permission` is not
the DSH approval: the spike shows the agent's own mode answers it (a session started in Claude
Code's `auto` mode ran an MCP tool call with no permission request at all).

**One dialog per call, in Manual.** The ACP-layer dialog is not the DSH approval and must not
double it. In Manual the spike shows Claude Code asking `session/request_permission` for an
`mcp__` tool. The plugin's rule: for `mcp__dsh__*`, acp-dsh answers that request itself with
`allow-once` and raises no DSH dialog from it — the bridge's `approval/request` is the one dialog
the person sees. For any other `mcp__` tool (a person's own server), the agent's own mode and
rules decide whether the request exists at all, and acp-dsh forwards it to DSH's dialog as it
does today (read from `acp.js`); the bridge never sees that call, so there is one dialog there
too.

**The agent's own tools.** `acp-claude`: off, by `session/new` `_meta.disableBuiltInTools: true`
(the adapter's legacy shorthand for `_meta.claudeCode.options.tools: []`), which the spike shows
leaves the MCP tools working and removes the built-in file tools; that `tools: []` also removes
Bash is read from the adapter bundle, not exercised, which is why delivery 6 probes a shell tool.
`acp-codex`: the adapter has no such switch, so Codex's own tools stay; the level still bounds
them through Codex's sandbox mode, and DSH's tools on that route are still DSH-approved. Two tool
sets on `acp-codex` is the one place "one tool set" is not reached, and it is a limit of the
adapter, not of this decision.

**The person's own MCP servers.** They keep working: the bridge joins the session's server list
instead of replacing it, so the servers from Claude Code's settings and Codex's config load as
before, with their own tools and their own sign-ins. Their calls are the agent's own: the bridge
never sees them, so DSH's approval service does not gate them; the agent's mode and rules do (the
ACP request above).

**Refreshing the tool list.** On a preset or level change the bridge re-announces its tools
(`notifications/tools/list_changed`) and serves the new list. The rule is ordering, not a settle
delay: the spike's inference (arrival times, not an instrumented gate) is that `session/new` took
~3.55 s, and a `list_changed` before the answer (2 s and 3 s after server start) produced no
re-list, while one after it (4 s) did. The rule to verify: the tools must be listed before
`session/new` answers; acp-dsh is the side that sees that answer, so acp-dsh tells the bridge over
the back-channel, and the bridge holds its first announcement until then; if no `tools/list`
follows, it re-announces on the next turn.
`session/resume`/`session/load` was not spiked; treat it as the same ordering until delivery 6
confirms it.
`acp-codex` ignores `list_changed` and also ignores a new server list on `session/resume`; there
the plugin forks the ACP session (`session/fork`), which the spike shows returns a new session id
and starts the new bridge. The spike did not show the fork closing the source session, so the
plugin closes it (`session/close`) and its bridge; delivery 6 proves the close and that a Session
never holds two bridges. `acp-codex`'s support for `session/close` is unproven (the spike never
called it), so the fork path stays behind that proof. That the fork continues the same
conversation is not evidenced by the spike; delivery 6 must prove it before the fork counts as a
refresh.

**Live switching.** DSH keeps the record. A Session moving to an agent has its transcript replayed
into `session/prompt` content, in order; moving back, what the agent streamed is written into the
log with its tool calls keeping their cards. Before any text crosses, it passes the redactor: the
Bot team's secret store for a Bot's Session (`apps/bots-dsh/src/host/secrets.js`), and the
credential shapes the Bot team's diagnostics already mask otherwise
(`apps/bots-dsh/src/host/diagnostics.js`). A stored secret's value never reaches an outbound
prompt; the test is a saved secret sitting in the transcript. Each crossing writes a
provider-boundary row into the Session log ("Claude Code via acp-claude", "DSH"), so the chat
shows who answered, not only a log file.

**Setting and order.** Deliveries 4, 6 and 7 shipped behind `dshTools`, off unless set, until
the owner tried them; off is the 2026-11-03 behaviour and the rollback. The default flipped to on
later (below, "Default and kill switch"), where an explicit false is the kill switch. Delivery 4
is the bridge's
first slice, so it carries the same back-channel probes (above) before it is offered. The build
branches from the DSH 0.2.2 branch (`feat/dsh-022-upgrade`) and is rebased onto `dev` once that
merges; nothing of it is built in the docs PR that carries this amendment. This amendment is the
design correction that unblocks Lane D's build: no Lane D code (deliveries 4, 6 and 7) merges
before it lands.

**Default and kill switch (2026-11-06, later).** `dshTools` has no schema default: absent means the
per-agent default, on for an adapter that can drop its own built-in tools (`acp-claude`) and off for
one that cannot (`acp-codex`), from the desktop trial (refs #516/#559/#580). The key is unchanged
and stays public; an explicit true bridges Codex too, and an explicit false is the kill switch and
keeps the 2026-11-03 behaviour. The field is hidden from settings forms: it is a rollback lever, not
a preference, and remains writable through DSH's settings service and the profile patch. The flip
moves Claude Bots to `acp-claude` once per team (the Bot team's move, below), so it lands only after
#559 and #580's #585 are in a released build and the desktop trial passes. The one-time move
requires the route's CLI to be signed in as well as ready, so an installed-but-signed-out Claude
moves nothing and no Bot lands on a dead route; the team stays unmarked, and a later sign-in moves
it on the next pass (a settings or adapter change) or the next start. Auto review no longer depends
on a DeepSeek key: the reviewer resolves to a model the team can reach (DSH's default when it is not
an agent, an explicitly chosen side model, each configured non-agent route in turn, then the
built-in DeepSeek fallback) and falls through on a credential or missing-route failure, so a team
with only a Claude login reviews on that model. It fails closed only when no candidate answers. Auto
is the preset's identity, never its `ask` + `danger-full-access` bundle: a custom preset with the
same knobs has no reviewer, so the bridge keeps its own approval. Flipping the setting ends the
running agent sessions and revokes their bridges at once; the Session keeps its transcript. Codex is
bridged only with an explicit `true`; absent or `false` means no bridge, and its built-ins stay its
own tool set.

**Replay independent of the bridge (2026-11-08).** The transcript replay no longer follows the
bridge: absent or `true` replays to both agents, and only an explicit `false` (the kill switch)
keeps the 2026-11-03 path, where an agent sees only its own session.

| `dshTools` | Claude Code: tools | Claude Code: replay | Codex: tools | Codex: replay |
|---|---|---|---|---|
| absent | DSH bridge | yes | its own only | yes |
| `true` | DSH bridge | yes | DSH bridge and its own | yes |
| `false` | its own only | no | its own only | no |

With the key absent, Codex therefore sees the chat but not the team's tools, which still need an
explicit `true`. Beyond a move from another provider, three cases now replay, under the same
redactor and 120,000-character cap: a new agent session in a chat that already has answers (a
restart, or a session a crossing or a flip ended), with no boundary row since the chat did not
change provider; a live session resumed after the chat answered elsewhere (a move off Codex keeps
its session), which gets the turns it missed, from its own last answer on, and the move back writes
its "Switching to X" row, so Codex → API → Codex loses nothing; and a Bot part's handoff package
(the Bot team's relay marked `handoff`), which stays in the part's first prompt beside the
person's words and is carried in the replay once the Bot team has answered that first turn itself.
A move off Claude Code still ends its session (and bridge), and the new session on the way back
gets the chat; the agent's own context beyond the replay cap is the accepted cost.

## Amendment: Bots on Claude Code and Codex, switching and sign-in (2026-11-09)

What the Bot team and acp-dsh do so a Bot can move onto and off an agent, say honestly what the
switch did, and sign in to the agent's CLI from the Bot's chat. Plugin-only (acp-dsh, bots-dsh,
welcome-dsh, locale-pt-br-dsh); the DSH pieces this works around are proposed upstream in
[0023](0023-dsh-upstream-agent-context-and-chat-rows.md).

**The switch guard on an agent route.** DSH's compaction engine (`compaction-basic`) prices every
model switch with `compactPressure` on the destination's request header and needs that model's
context window. An agent declares none (it keeps its own context), so every switch onto an agent in
a Session that already had a request header failed with `MODEL_SWITCH_COMPACTION_FAILED`. acp-dsh
now answers "no compaction needed" for an agent destination and leaves every other destination to
the engine (`apps/acp-dsh/src/host/pressure.js`). acp-dsh is the method's only Automagik owner; the
wrapper delegates to whatever is below it at call time and, on dispose, unwinds only when it is on
top. The method is private to `compaction-basic`, so a guard test pins it. An agent gets the chat
as the bounded, redacted replay above instead.

**Off an agent, onto an API model (the Bot team).** Before DSH's guard runs, the Bot team measures
the chat against the destination's own switch threshold, computed as `compaction-basic` does
(`apps/bots-dsh/src/host/parts.js`). Below it nothing happens. Above it, the chat is condensed into
a checkpoint only when the team chose a background model in Settings (`prefs.backgroundModel`) and
the chat fits that model, which is the one charged; the automatic background pick never starts a
paid call without that choice. Otherwise the Bot continues in a new part that carries the latest
messages that fit, with no handoff note and no model call. The part it leaves is archived only
after the new part's first answer from the chosen model; if that first call fails, the Bot goes back
to it. A team with no model that answers beside its agents skips the steward, the note and the
checkpoint (it says so once in the log) and, past the hard line, continues in a new part the same
way. A switch between two agents needs none of this.

**A switch that fails goes back.** The Bot keeps the last model that answered in its chat as
`previousModel` (a model that only started a call is never recorded) until the new one answers. A
new model is checked (an agent that is off, installing or signed out is refused, asked through
acp-dsh's read-only `inspect`, whose confirmed sign-in stands for five minutes and is dropped by
the agent's own `auth_required`), put on the Bot's Sessions, and only then saved; a refusal writes
nothing. A first turn that fails with `MODEL_SWITCH_COMPACTION_FAILED`, `MODEL_ACCESS_REQUIRED` or
pi-ai's "Provider is not configured", or a new part whose first call fails with nothing else to
answer it (a failure the fallback model answers keeps the switch unless the fallback fails too),
puts the Bot back on `previousModel`, Session selection included, and nothing runs again on its
own. A signed-out agent
(ACP's `auth_required`) fails the turn as `MODEL_ACCESS_REQUIRED`, never `ACP_AGENT`, so it never
moves to the fallback model; the fallback never changes the Bot's model.

**No row claims an answer.** The provider-boundary row (Live switching, above) is written before
the reply, and the call can still fail after it, so it now reads "Switching to X (provider)",
never "Now answered by X". Whether X answered is derived, never stored as a claim: from the next
assistant message whose source is X. The Bot's settings show that state (switching and not answered
yet, failed and back on the previous model, or in need of a sign-in).

**Sign-in from the Bot's chat.** A signed-out agent is signed in to from a transient row at the end
of the Bot's chat, shown only after an explicit entry (picking that agent's model in the chat's
picker, the Sign in button in the Bot's settings, or the welcome's Sign in) and, in the Bot that
opened it, to restore a live attempt. The CLI runs its own sign-in: a link to open on any device,
then Codex's device code to type there, or Claude's code to paste back in the row's own field. The
attempt lives in acp-dsh (`src/host/login.js`), one per agent, Claude Code and Codex independently;
any view of the DSH owner reads it back and reading never cancels it. The Bot team's
`cli-login-*` endpoints are on its owner-only route, so a share viewer or a shared remote access
gets 403. The expiry is the provider's when its answer reports one, otherwise the app's ten minutes
from the link shown. A desktop parent sets exactly `AUTOMAGIK_BUSY_PROTOCOL=2`; Welcome splits
actual running agents from active sign-ins only when ACP also exposes structured login activity
and restart preparation. Older combinations retain the combined running count. An unreadable or
malformed modern activity reading is untrusted, never idle. Waiting sign-ins alone do not hold
modern automatic plugin updates or raise a quit warning; actual running agents still do.
Claude's submitted answer or a CLI completion starts one absolute confirmation deadline of at
most 90 seconds, shared by answering and confirming. A silent Claude CLI fails at that deadline,
even if a later authentication check could succeed; no last query starts at expiry. Expiry
invalidates completion authority before stopping its existing controller. Late account reads
cannot grant consent, resume work, announce readiness or apply a model after expiry, replacement,
Reset, disposal or restart. Persisted ownership still requires the existing full-tree exit proof.
Automatic eligibility and the pre-stop recheck share one nonrenewing 90-second budget per actual
DSH child and staged publisher/sequence/target bytes, shortened by an earlier valid writer
deadline. New attempts, snapshots and malformed or future confirmation metadata cannot renew it.
A deadline wake uses ordinary eligibility, including current-run busy validation, actual agents,
focus/typing, settings, trials and downloads. Manual Force, Restart, install and quit retain the
existing bounded preparation and gain no confirmation wait. While Claude's code step shows, the native editor takes no edit and
keeps its draft; acp-dsh keeps keyed hashes of the Claude states it showed for a day, and the Bot
team refuses to send, deliver or step a message that carries one. When the CLI confirms, the row
says so and goes by itself after about three seconds, leaving nothing; a model the explicit
entry named is then applied to that Bot only, if it is still the latest choice. Nothing of the
sign-in reaches a draft, storage or a model call, and the team's send endpoints, its deliveries,
a group's running round and Pocket refuse a pasted code before anything records it. One residual
risk stays: a message sent from DSH's own composer is admitted by DSH's session controller, which
writes it to the Session's record (`agent/inbox/spliced`) before any plugin hook can look at it.
The page refuses such a send only for a state that page showed; after a reload, or in a window
that never showed the link, a pasted code reaches that record, and the Bot's step then drops it
before any model call or transcript row. DSH 0.2.2 has no hook before a prompt is admitted; one
is proposed upstream ([0023](0023-dsh-upstream-agent-context-and-chat-rows.md), section 3). This uses DSH's rendered chat
attributes, since DSH 0.2.2 has no slot for a client row in the transcript: the risk is recorded,
and the slot is proposed upstream (0023).

## Amendment: one sign-in per subscription, and a menu of what is set up (2026-11-09)

Owner decisions D-a to D-h of the CLI Bots round. Plugin-only (acp-dsh, bots-dsh, welcome-dsh,
locale-pt-br-dsh).

**Subscriptions through their CLIs.** A Claude Pro/Max or ChatGPT plan signs in only through the
CLI Automagik installs, Claude Code or Codex, in the Bot chat's sign-in row (above). The welcome's
Claude and ChatGPT rows are those CLIs: their **Sign in** opens the same row, their switch is
acp-dsh's own `claude` or `codex` setting, so turning one off turns that agent off for every Bot
(D-f). Connect AI has no Coding agents block of its own (Settings keeps one), and its sign-in
endpoints refuse pi-ai's `anthropic` and `openai-codex`: nothing in Automagik starts DSH's own
plan sign-in for them. API keys keep their routes and forms unchanged (D-b): an Anthropic key on
pi-ai's `anthropic` route with `apiKeyEnv`, an OpenAI key on `openai`.

**Moving plan Bots.** Once per team and route, a Bot on a plan through DSH (pi-ai's
`openai-codex`, or `anthropic` with no `apiKeyEnv` on the Claude sign-in grant) moves to
`acp-codex` or `acp-claude` on the closest model the agent lists (same id, else for Claude the
same family, else `default`), keeping its Session and level (bots-dsh `subscription-move.js`).
Key-based Bots never move, no credential is read or copied between programs, and a signed-out CLI
asks for its sign-in in the chat. Only then does the welcome unset DSH's old plan route; the
sign-in record is never deleted. dsh-subscriptions 0.7.21-omni.1 ships no `claude` or `codex`, so
bots-dsh no longer counts those ids as plan routes (`SUBSCRIPTION_ROUTES`).

**The model menu.** It lists only what is set up, as connection, model, then level: a provider
with its key, an agent whose CLI is signed in, another provider's stored DSH sign-in. Connections
read "DeepSeek", "Anthropic · API key", "OpenAI · API key", "Claude Code", "Codex"; two that would
read the same add their route id. A covered plan route (`covered`), a missing key (`needsKey`) or
a missing sign-in (`needsSignIn`) is never offered; a Bot's current model stays shown, marked
unavailable, and a new Bot's default skips all three. The jobs beside the chats keep their own
model rule (D-g).

**Images through Codex.** `generate_image` and the companion's drawing use an OpenAI API key as
before; without one, the Codex CLI on its own ChatGPT sign-in (acp-dsh `generateImage`, a one-off
session with a per-draw permission profile using Codex's image tool). A ChatGPT grant stored by an earlier version's DSH
sign-in is read last. CLI auto-updates stay on (D-h).

**Image read boundary (#870).** Each draw writes an owner-only project config in its scratch
folder with a fresh permission profile and `default_permissions`. It denies `:root`, reads
only `:workspace_roots`, and has no network table, `extends` or `:minimal`. The adapter must
offer and acknowledge `permission-profile:<id>` before the prompt. This is containment, not a
scratch-only read boundary: Codex adds `:minimal` and helper-executable read grants, with
platform runtime roots. Images there remain readable. Automagik passes only prompt text and
has no pre-read hook for Codex's image-input paths; output bytes are inline, never opened from
`savedPath`. No adapter-controlled input path exists to validate. The [security notes and
pinned source lines][codex-image-security] list Linux, macOS and Windows grants and the real
helper read tests. Those tests reconstruct the helper policy; they do not prove the signed-in
ACP image-tool path. **#870 remains open.** Feature and offered-tool checks stay in place,
and each required switch is read under the session's whole config and proven by its effect
before the draw; a switch Codex lists but silently ignores refuses the draw.
An `Invalid configuration` warning fails a pre-session check.
The run uses the Bot's isolated Codex home and removes the scratch config with the folder.

**Accepted image security risk (owner decision, 2026-11-11).** If the profile mode is absent
or rejected, drawing continues in `read-only` with one warning and an internal not-isolated
result. That fallback still sends a full-disk `readOnly` policy each turn: an injected request
could return a readable local image in the picture. The owner keeps this fallback enabled.
A Codex Bot's ordinary chat image tool (`agent-image.js`) is outside this per-draw profile
and retains the risk under its chat permissions. Signed-in enforcement on the actual
per-turn adapter path still needs verification in the app.

An OpenAI API key avoids `generate_image`'s one-off Codex session by using the Images API;
the API still receives the prompt. Prompt text is outside the file boundary. A Bot running
on Codex can still invoke its own image tool despite that key. Use a different Bot model or
turn Codex off to avoid that route. Avoid routing untrusted outside text into Codex drawings;
post-call refusals cannot undo a read, and prompt review is not a file access control.
See the [user warning and security notes][codex-image-security].

[codex-image-security]: ../../apps/acp-dsh/README.md#images-through-codex

## Amendment: required desktop CLIs (2026-11-08)

Claude Code and Codex are required desktop components. On every activation and after any plugin
installation/update, the ACP host checks both official stable releases and installs missing or
older tools, independently of their model switches and onboarding state. App and desktop plugin
lane updates restart DSH and receive the same startup check. A current or newer user CLI is reused;
an older global CLI is left untouched and replaced for Automagik's use by a managed copy. Standalone DSH retains its
existing-CLI behavior. Installation does not authenticate, change models or rewrite user settings.

The desktop's bundled pnpm installs the official native platform packages into
`$AUTOMAGIK_HOME/acp/clis`, separately from its adapters. Registry integrity, disabled install
scripts and a successful native `--version` check precede atomic publication. Completed version
directories are immutable and retained for running sessions. Managed Claude's updater is disabled;
Automagik checks these copies at startup, plugin updates and every fifteen minutes without
downgrading them. Lifecycle triggers bypass the recent-check cache; triggers during an active
download queue one fresh registry check afterward. A user CLI whose version cannot be verified
stays untouched while Automagik uses a verified managed release instead of treating it as current.
Failures preserve any working copy, expose redacted diagnostics through CLI status and retry at
the next check or the existing `retry(id)` service. Shutdown cancels incomplete installations.

This amends D17's desktop CLI ownership only. Adapter installation, authentication, model
selection, the conversation UI and the existing model-enable switches keep their own contracts.

## Amendment: native-ACP agents (2026-11-10)

Owner ask (#959): offer the agents that speak ACP themselves beside Claude Code and Codex.
Hermes (`hermes acp`), Antigravity (`agy acp`) and omp (`omp acp`) each answer ACP `initialize`
and `session/new` from their own CLI, so the agent table takes a second kind of row: a CLI and
its ACP arguments instead of an adapter package (`acp-hermes`, `acp-antigravity`, `acp-omp`).
This amends "The person's own CLI, the newest adapter" for these rows only.

- **Nothing is installed.** No adapter, and the CLI is never one of the required desktop CLIs:
  an agent whose CLI is missing is listed with its install page, not hidden.
- **Off by default; the switch is the person's word.** Each has its own live setting
  (`hermes`, `antigravity`, `omp`), default off. Their sign-in is the CLI's own, shared with the
  person's terminal, and no command of theirs names one account, so the per-account record of
  #869 cannot cover them: turning the agent on is the consent. Claude Code and Codex keep
  their record and confirm step unchanged.
- **Sign-in is the agent's own answer.** There is no sign-in from a Bot's chat for them; the
  person signs in in a terminal with the agent's own command, which a signed-out turn and the
  settings row name. Signed in means the agent's ACP session opened; ACP's `auth_required`
  means signed out. That is read with the model list (when the CLI changes, daily, and on the
  person's "check again" while not signed in), never by a check of its own, because these
  agents keep every session they open in their history.
- **Models from the agent's session.** Config options when it offers them (Antigravity), else
  the session's own model list and `session/set_model` (Hermes), else one `default` model (omp).
- **The level.** Each is put in its `default` mode, the one that asks, and DSH's approval
  answers under the Session's level. The agent's own permission settings still decide what it
  asks about. A row with no known mode says once in the chat that the level is not applied.
- **No DSH tool bridge yet.** `dshTools` does not reach a native row, even set to `true`, until
  that agent's tool naming over ACP is proven as Claude Code's was in delivery 6.

Open, tracked on #958: the sequence fuzz test and the daily handshake run should cover these
three CLIs before their switches default to on.

## Amendment: remote Hermes first delivery (2026-11-11, #1070)

The owner's GO adds **Remote Hermes** as a fourth route, after Native, ACP and Herdr. This
amends the three-route selector approved in #1016. Local Hermes remains `acp-hermes`;
remote Hermes is `hermes-remote`, a native `hermes serve` JSON-RPC/WebSocket adapter,
never an ACP SDK transport. Crossing to or from it starts a new conversation with the
existing handoff flow (#1007); changing only its model keeps that conversation.

One connection, off by default, holds a remote HTTPS address (path prefixes allowed) or SSH
connection settings, a profile, Bot-secret reference and discovered models. The standing credential is in the mode-0600 Bot secret store with no
Bot scope. A one-use ticket is minted over HTTPS and offered as a WebSocket subprotocol;
neither credential is put in a URL, CLI argument or prompt. Wire failures are fixed
sentences; transient tickets and saved credentials are removed from visible rows too.

This delivery accepts standalone Desktop contract **8**, with server-request approvals.
After `gateway.ready`, `client.capabilities` advertises `server_requests: true` before
session calls. Canonical authority and other versions are refused before a prompt. The
generated OpenRPC pin and the release-diff command are documented in bots-dsh's README.
Each permission question goes through DSH's level: Full access answers `once`, restrictive
no-ask answers `deny`, and Manual asks DSH. The remote profile must already use manual
approvals; Automagik never changes its global approval setting. DSH's local sandbox does
not constrain remote tools.

The chat shows text and remote tool cards. It records stored/runtime session IDs and any
admission ID, persists submit intent before sending, and never retries an uncertain submit.
A disconnect says **Connection lost; remote outcome unknown**. Reconnect resumes the stored
session and reads an authoritative snapshot and replay watermark; a replay gap replaces
deltas with the snapshot. Stop requests interruption and gives it five seconds to settle;
its acknowledgment does not prove remote children stopped. Start/control deadlines are
60/15 seconds, matching #1006.

The menu and setup name the absent DSH team tools: `message_bot`, `list_bots`, `create_bot`,
`request_secret`, memory and schedules. Hermes keeps its own remote tools. An authenticated
team-tool bridge, canonical authority and additional connections remain later deliveries.
Selector approval remains in the real app, with sample-data screenshots.

### Approved connection wizard build

The Remote Hermes route uses the original upstream girl mark, with its MIT notice retained.
With nothing configured, its click opens **Connection → Details → Test → Profile → Ready**.
Remote address accepts a session token or the instance's own dashboard user/password sign-in;
the password is used once and never saved. Test reports progress, success and actionable errors;
Profile lists that instance's available profiles and saves the chosen identity with the connection.
Later route clicks connect to that remembered profile in one click. Settings retains its dedicated
Remote Hermes page for editing and reconciliation.

Through SSH accepts a host/config alias and optional user, port, identity-file reference and
Hermes path. It uses the system client's existing config/agent and key authentication only.
Unknown or changed host keys stop with terminal-connection guidance; no accept-new or disabled
host-key checks are permitted. Private key material and passwords are never copied or stored.
The remote needs SSH, a POSIX shell, Python 3 and an already installed compatible Hermes/runtime
with provider setup. Blank executable path means auto-detect; setup never installs Hermes.
It launches an owned isolated server on remote loopback, forwards to an OS-assigned local
loopback port, and supervises teardown of that server and tunnel on connection end/app shutdown.
The start/control/cancel limits stay 60/15/5 seconds, and cleanup does not claim all remote
children were killed. Tokens are sent through the encrypted channel, never in SSH arguments.

Only references to saved token/session credentials enter the connection record; secret values
remain in the existing Bot store. Transient tests expire and are closed on cancel/replacement.
Saving is explicit and remains off until the tested profile is accepted. This wizard changes
setup and connection ownership; it preserves the standalone contract pin, approval levels,
replay/epoch fencing, durable submit identities and uncertainty handling above.

In this delivery, Read only and Workspace each ask before answering a Hermes approval question;
their different local file settings do not enforce a remote workspace. Auto review also asks
the person for Hermes questions rather than sending them through the model reviewer. Full access
answers yes once. Distinct remote refusal/allow boundaries are tracked separately in #1084.

## Amendment: separate Bot CLI accounts (#869)

Owner decision (2026-11-11): **isolate**, option 1 of
[the design note](https://github.com/automagik-si/automagik/issues/869#issuecomment-6797000812).
Claude Code and Codex each get their own CLI home per Automagik installation, shared by that
installation's teams and image runs. A discovered CLI and a managed CLI use the same Bot home.
Sign-in, status, account reads, adapters, model probes and images use the same environment.
Neither credentials nor authentication settings are copied from the terminal. CLI updates and
the public provider ids keep their existing contracts. Native-ACP agents keep their explicit
opt-in terminal-sharing contract above; this decision covers Claude Code and Codex only.

**Settings amendment.** This supersedes the user-global settings promise in Design and Decided
for these two agents: terminal user settings, hooks, MCP servers, skills, sessions and environment
overrides are not automatically imported. A separate home is necessary because authentication
can also come from helpers, environment variables and stores outside the CLI's main config file.
Project settings still load for chat work in the Bot's working folder. The person can configure
the Bot's own user settings separately; Automagik does not copy or link credential-bearing files.
The DSH tool bridge, approvals and transcript replay contracts stay as described above.

**Upgrade.** Existing Bot models, histories and Sessions stay. Old terminal-account consent is
not carried into the new home. The person signs in once more inside the app; affected work waits
with a sign-in action. A signed-out isolated Bot never restores a legacy plan route or uses an
old ChatGPT image grant to keep working. Explicitly configured image API keys retain their own
path. Terminal-login preservation relies on the vendor credential-store assumptions below.

**Owner account controls.** Bot settings show the Bot identity and a read-only terminal identity
when the vendor reports it, clearly labelled as separate. Account data stays on owner-only
endpoints, never in team state, model calls, transcripts or logs. Switch and Sign out block new
work, end starting/live chats, images, model probes and login attempts, and wait for process
termination before the CLI changes credentials in the Bot environment. A failed or unverified
logout leaves
work paused until an explicit retry. Installation locks serialize authentication changes; when
another live or unknown app instance has registered the same vendor home, close it before changing
accounts. Complete versioned registrations and mutation claims are staged privately and published
atomically before admission. Synchronous bounded birth-identity checks distinguish a matching app
from a reused PID: Linux uses boot UUID and kernel start ticks, macOS UTC `ps` lstart (whole-second
collisions remain blocking), and Windows .NET UTC ticks as a decimal string. Errors, damaged
metadata and matching/frozen owners stay blocked. Only fresh ESRCH or a comparable birth mismatch,
with exact pathname identity/bytes/nonce revalidation, permits removal. No heartbeat age grants
ownership. Live legacy registrations cannot distinguish PID reuse and remain conservative;
legacy markers that lack login-tree evidence are retained.
Launches capture an account generation so delayed work cannot start under a later account.

**Crash recovery and owner Reset.** Automatic app-crash recovery is Unix-only and requires the
recorded login group's exit proof. Windows app death leaves its login record blocked, even if
an old Job nonce exists: Windows crash recovery is by owner Reset followed by fresh sign-in.
Automatic Windows recovery is deferred to
[follow-up #1076](https://github.com/automagik-si/automagik/issues/1076).
The normal Windows sign-in and stop path still waits for its live supervisor's empty-Job proof.
A short installation-level mutex uses unique process claims, so a claimant's own crash does not
permanently hold recovery. Lock owner and applicable evidence are revalidated under that mutex.
Startup and begin share the same proved-dead changing-lock recovery. Login-tree evidence is
checked first and immediately before removal, with exact owner/claim/identity revalidation.
Recovery durably establishes `paused` before removing the dead lock, including a crash before
the original pause write; physical generation and version stay unchanged. Startup never resumes
work or starts sign-in. App birth identity is not detached-login-tree exit proof.

Pending-before-spawn, damaged and legacy evidence cannot supply that proof. Cold owner settings
show recovery per vendor and offer an explicitly confirmed Reset Bot sign-in. Beside that unchanged
control, Sign in again uses the same confirmation and internally awaits Reset, invalidates old
provider rows/polls, then awaits a fresh ordinary open and starts only a current offer. Bot,
provider, model and operation checks fence every continuation; existing accounts still ask for
confirmation and active attempts use ordinary joining. The public open bridge stays boolean.
Both owner RPCs retain isolated-home, generation and restart checks; this composition is not an
atomic transaction and promises no automatic chat-row restoration. Reset pauses
admission and stops known work before selecting a fresh empty home generation and forgetting
old account consent. It requires fresh in-app sign-in, preserves Bot models and history, and
does not log out or copy the old account. Bot CLI user settings also start empty; project
settings still load from the workspace. The previous physical folder and its unproved records
remain at their original path: it is never renamed and reused. A surviving vendor process can
write only to the abandoned generation. The retired folder stays readable at its bound path: its
`RETIRED.json` holds the disposition, and later starts remove nothing until the measurement
side's complete post-last-write scan with the root frozen, its retirement record, and the
session-absorption receipt hold; a `KEEP` file in the home opts out. Unproved generations,
including Windows crash records, stay retained. Both serialization and
app registrations sit outside the
replaceable home. Captured launches check the installation's current-generation pointer as well
as local version markers; delayed account reads and image tickets are invalidated by Reset.

**Storage assumptions and unfinished live validation.** This design relies on Claude's
config-directory-namespaced macOS Keychain entry and Codex's `CODEX_HOME`-namespaced OS-keyring
key. Current vendor documentation/source supports those assumptions; fake stores and process
tests do not prove the installed CLIs' live credential behavior. #869 remains open for both:

1. A real two-account macOS sign-in/switch/sign-out sequence for Claude and Codex, verifying the
   terminal login stays intact at every step.
2. The Codex OS-keyring-backed path with distinct Bot and terminal homes through those actions,
   in addition to the file-backed `auth.json` path.

Vendor storage contracts:
[Claude authentication](https://code.claude.com/docs/en/authentication),
[Codex auth storage](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)
(the CLI owns these stores).

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: #855, #868, #869, #870.
- Merged changes that cite this RFC: #186, #187, #189, #349, #520, #522, #537, #557, #559, #569 (last merged 2026-11-06).

## Links

- #130 per-teammate models (runtime patch)
- [0004](0004-composer-chat-kinds.md) picker, [0006](0006-herdr-terminal-mode.md) Herdr harness
- Amendment evidence: [acp-dsh-tools-spike.md](../research/acp-dsh-tools-spike.md) (adapters'
  `mcpServers`, `list_changed`, fork); [dsh-022-council.md](../research/dsh-022-council.md) (the
  council behind the 2026-11-06 decision).

## Amendment: Auto on Codex (RFC 0031, 2026-11-11)

A Bot's Auto choice stores Workspace plus `permissionAuto: 'acp-codex'`. Its DSH Sessions
remain Workspace. Only unbridged Codex may take its own `agent` mode, after two exact,
bounded `true` answers from the team's sole `acpAgents.ownMode` answerer. Otherwise strict
`workspace-write` is re-sent and confirmed before the prompt; refusal ends the agent session.
Auto never maps to `bypassPermissions` or `agent-full-access`, and approvals that Codex asks
still reach the person. These claims rest on the Codex 0.167.0 capture; later versions may
review differently. DSH Auto review and every other provider's modes stay as they were.

Every message reaching the Bot's own current chat counts, including another Bot's and a
schedule's (question 2: b). Ending Auto ends its agent sessions (question 3: yes). A task
started from that chat while on Auto counts while the opener's mark and revision match;
a new Bot created there inherits only when the opener actually runs in Codex's own mode.
This narrows the no-inheritance and unscheduled-tasks statements of RFC 0031. Today own-mode
Codex has no bridge and no team tools, so these creation paths are unreachable there;
fake-acp tests cover the inheritance contract, and opened work runs as Workspace.


## Amendment: Auto on every route (RFC 0031, 2026-11-11)

Auto runs at Workspace. Codex uses its own reviewer; Claude Code uses its `auto` mode. Both can take their own mode while bridged. API Bots decide sandbox escalations through their own model in a separate, tool-free compaction request. Hermes, Antigravity and omp use the team's background model and require one to offer Auto. A bridged call keeps its dialog or the background model decides it; a CLI permission question sends the remaining bridge calls of that prompt to the person.

API marks bind the exact provider/model; own-mode and team marks bind the agent route. Only the person enables Auto. Current chat ownership or explicit inherited task records, revision, Workspace, and route must still match when a decision returns. Grants bind one call, tool and escalation reason and are consumed once. A failure or missing model asks the person. Model decisions never widen saved permissions or answer as the person.

Automagik's judge asks the person for hard-to-undo steps and after three consecutive or ten total denials in a turn. It reads bounded requests and tool calls, never tool results or file contents, and identifies task instructions as another Bot's requests. Oversized arguments are not truncated into an allow. Mirror decisions use the current permission input and require an actual `allow_once` option; a refusal names the judge in the call's result. Plugin, folder and website asks remain with the person. Background-model identity is logged only in host diagnostics; permission diagnostics expose fixed judge categories.

Codex's reviewer is a single CLI switch; global rules or reviewer policy would also change other Bots. No CLI home is written. Codex review counts can produce a refusal-stop notice, but the actual denial-limit ending and Claude Code auto mode still need captures. The host notice and tool result remain English like their neighbors. The permission questions explain that an allowed API escalation and native-agent tools may change files outside the Bot's folder. Existing Codex wording remains unchanged.

RFC 0031 follow-up: rule 5 is per mark, with exact API models; rule 6 no longer refuses bridges. Questions 4 and 5 are answered by the own model/background model split and explicit failure-to-person behavior. The threat model's bridged-dialog statement gains “or the background model decides it”. “Not scheduled” is narrowed: any request reaching a counting chat may lead to a judged step; schedules themselves are not treated as the person's requests. RFC 0031's text remains for its owner.

### Bot identity on ACP (amended 2026-11-14, #1269)

Claude Code and Codex receive only the owning Bot's name, role and instructions through a
Session-scoped reader. They never receive the native DSH system prompt through this channel.
Delivery works with or without the DSH tools bridge. Remote Hermes gets no identity through
this channel; it uses its own profile instructions.

When the agent advertises `sessionCapabilities.systemPrompt`, a fresh session receives that
identity in `systemPrompt` with `mode: 'append'`, after the agent's own system instructions.
It extends those instructions and never replaces them. A tool-refresh fork carries the same
identity snapshot. Without that capability, identity is prepended once to the first prompt,
before replay and user content.
That fallback has user-message precedence, not system-level precedence.

Edits do not restart a running session. The existing profile-edit notice carries changes there,
with its existing self-edit exceptions; each fresh session reads the current profile. A preserved
unbridged Codex session returning from a native route still keeps its original identity snapshot.
Repository-file consent in RFC 0014 is unchanged.


### Image edits (2026-11-15)

Pending the owner's OK (D1). `generate_image` may edit one picture the person uploaded in the
Bot's own chat, across its durable parts, including compacted and offloaded image blocks.
Names, sha256 prefixes and paths are selectors of verified attachment references, never
filesystem authority. Ambiguity refuses before reading; group uploads and team-generated
pictures remain outside this phase. The original is unchanged and the result is a new image
in the same chat card.

The OpenAI-key edit uses the Images edits endpoint and its own model; drawing is unchanged.
Codex edits use `acpAgents.editImage`, with the same account-generation and availability
checks as drawing, strict base64, PNG/JPEG/WebP magic checks and a 12 MiB limit. Legacy
ChatGPT grants cannot edit; older ACP services must update or use an OpenAI key.

For edits, the Image read boundary's text-only-input statement gains this exception:
bots-dsh reads the person's verified upload from DSH's store and acp-dsh passes it inline
when image prompts are supported and writes a 0400 copy in the per-draw scratch. No read
root is added. Only an acknowledged per-draw profile permits an edit; fallback refuses it
(D3's recommended default). The scratch and input copy are removed afterwards. Codex still
selects its image-tool paths without an adapter pre-read hook; acknowledgement is not proof
of scratch-only reads, and #870 remains open. Real-app acceptance must demonstrate that
Codex preserves the reference picture's distinctive shapes and text before this ships.
