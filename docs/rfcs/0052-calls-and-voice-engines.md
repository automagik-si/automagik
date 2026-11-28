# RFC 0052: Calls and voice engines

| Field | Value |
|---|---|
| Status | Proposed |
| Milestone | none |
| Lanes | plugin (3.N.P) for Automagik delivery |
| Created | 2026-11-28 |

## Summary

Call one Bot from its own chat and follow the conversation in a Voice tab beside it. Automagik owns the call controls, chat handoffs, the Bot's speech tools and the per-Bot voice record. A local engine owns audio and the live voice model. urs is the first proposed engine for `automagik-call/1`.

## Motivation

The browser's voice chat and the urs plugin provide separate paths for talking to a Bot. A call needs one place to follow the conversation, see work handed to the Bot and hear the result. The voice agent can handle small talk, hand work to the Bot without filling its chat with the transcript, and carry the person's call preferences into the next call.

## Design

### Voice and the call

- Keep role id `voice-mouth` and display it as **Voice**. The proposed bots-dsh registry role declares `engine: { transport: 'unix', path: '~/.soundbar/automagik-call.sock', protocol: 'automagik-call/1' }` and `capabilities: ['call-engine']`. The planned RFC 0050 adds `call-engine` to RFC 0037 contract 8. Existing `audio-out` grants do not grant calls. An old pinned Voice / Mouth `ctx.speak` refuses and tells the owner to detach and reattach Voice.
- A Bot is eligible while roles are enabled and it has the current registry Voice attachment and its owner's per-Bot `call-engine` grant. The only call setting is **Answers soundbar calls** (`answers-soundbar`, a team-scoped boolean toggle, default off). The host refuses a second enabled Bot for the team and names the current one. The value is advertised in `hello` only. Incoming soundbar calls and the wake word are deferred.
- Show the call button in the eligible Bot's own chat. It becomes the native red hang-up during the call. The right-pane Voice tab shows both waveforms, streaming text from both sides, handoffs linked to their thread, past calls and an opt-in Debug view. One active call row sits below the Bot in the left menu. Deliver the tab and gated button before retiring plain browser voice chat. Keep dictation and move the composer's Enter-to-send ref off `.bt-voice` to an element that always renders.
- The Voice tools take only `{ text }`, a string of 1–2,000 characters. `speak` sends `say` in `exact` mode through the hub's configured speech path with a `Playback` hold over live audio. `tell` sends `say` in `rephrase` mode. `note` adds silent context. During delegated work, the voice agent may give a short acknowledgement before reporting idle. Its other speech during that work comes from the Bot's tools. A written reply does not become speech by itself. After hang-up the Bot can post the result in its chat and use an exact `say` with `callId: null`, subject to the engine's local speak policy and quiet hours. `tell` and `note` require an active call.

### Handoff into the Bot's own chat

Each accepted `handoff` creates exactly one plain-text, voice-tagged user message in the connected Bot's current own chat. The message starts with `Voice call · handoff {n} · HH:MM`, includes the guidance to answer through the Voice tools and contains one brief plus only explicitly selected excerpts relevant to that request. The optional wire field `transcript` carries those excerpts. If it is absent or empty, the message contains the brief alone with the header and guidance. The host never fills in excerpts from recent finals or posts the raw transcript or small talk automatically. The complete message is at most 8,000 characters, including its header and labels. Retain the brief before spending the remaining space on excerpts.

The host sends as the person through the existing user-prompt path, with `requestId: call:<callId>:<handoffId>` and `mode: 'steer'` if the Bot is mid-turn, or `mode: 'queue'` when idle. Retransmission with the same ID produces no second message. Stale handoffs cannot write to chat. A handoff conveys user input under the Bot's existing permissions and switches.

Open one `call-handoff` thread on call start using the planned RFC 0051 thread record in `state.threads`. Its id is `call:<callId>`, its Session and parent Session are the Bot's own chat, and its parent Bot and sole initial member are that Bot. Anchor it to the call and attach each successful handoff by its request ID, with the brief as progress. An Orchestrator can delegate from the handoff through its usual tools. End the call thread with the call. The thread reporter skips this kind so the Bot's chat turn cannot send a `thread-done` report back to itself.

## Contracts introduced

### Local transport and IDs

The host is the sole socket client. It opens one connection per eligible Bot to the fixed `~/.soundbar/automagik-call.sock`. A call reserves the audio place for one Bot. A second start while occupied is `busy`. A missing engine is offline. A hub using a different `SOUNDBAR_HOME` is not found at the declared path. Connecting or retrying leaves chat and dictation usable without an engine. Tests use a temporary home and fake socket, or a socket pair and null audio.

Each frame is one closed JSON object with a string `type`, encoded as UTF-8 and terminated by LF. The entire serialized frame in either direction is at most **65,536 bytes**, including the envelope, keys, quotes, separators, escapes and the final LF. This limit applies to `start` and `context` too. Both sides validate before writing and cap input before parsing. Invalid UTF-8, bad JSON, extra fields, missing required fields, invalid field values, unknown types and oversize frames are `bad-message` violations and close the connection. The engine sends a fatal connection-level `error` where possible before closing on a malformed host frame. The host reports the same code locally and closes on a malformed engine frame.

The host mints a lowercase UUID v4 for `callId` in `start` and a UUID for each `say.id`. The engine mints `handoff.id` as `h-<seq>` once per call handoff and reuses it on retransmission. A transcript has a stable `utteranceId` derived from the engine's transcript `itemId`. Handoff IDs and transcript IDs use `^[A-Za-z0-9_-]{1,64}$` and identify one handoff or utterance within the call. The final's `itemId` is the record's dedupe key together with `callId`. `spoken` echoes the `say.id` and its call scope, including `null` for post-call speech.

`hello` is the first frame and `ready` selects the protocol within 5 s. A failed negotiation closes with fatal `unsupported-protocol`. Reconnect with backoff of 1, 2, 4 seconds up to 30 seconds. A toggle change reconnects and sends a fresh `hello`. The first `state` confirms a start within 10 s, after which the host ends an unconfirmed start with `timeout`. EOF ends the call with `engine`, and outstanding speech resolves as `dropped` on end or connection loss. There is no heartbeat or automatic `say` retry. A refused `say` returns `spoken` with `outcome: 'refused'` and a reason. The host waits up to 20 s for `spoken`.

`?` marks an omittable field. All other fields are required, with `null` allowed only where shown. String lengths below count Unicode scalar values. Fields without a separate size bound are still subject to the frame byte limit, which applies even when every field meets its own bound. `side` is `person` or `agent`. A breaking change gets a protocol string such as `automagik-call/2` in `hello.protocols`.

#### Automagik → engine

| `type` | Fields and bounds | Behavior |
|---|---|---|
| `hello` | `protocols: ["automagik-call/1"]`, `bot: { id: string, name: string }` (name ≤60), `answersSoundbar: boolean`, `client: { name: "automagik-bots-dsh", version: string }` | Once per connection. |
| `start` | `callId`, `origin: "desktop"`, `bot: { id, name }` (matches `hello`), `language: string` (BCP 47), `context: CallContext`, `ringId?: string` (reserved) | Starts one call. |
| `say` | `id`, `callId: UUID or null`, `mode: "exact"` or `"rephrase"`, `text: string` (1–2,000) | `null` allows only `exact`. Answers with `spoken`. |
| `note` | `callId`, `text: string` (1–2,000) | Silent context. |
| `status` | `callId`, `kind` and exactly the fields of the selected variant below | Only for the active call. |
| `end` | `callId`, `reason: "hangup"`, `"revoked"`, `"detached"`, `"shutdown"` or `"timeout"` | The host ends the call locally on send. |
| `context` | `callId`, `context: CallContext` | Host reply to `reseed` for that active call. |

| `status.kind` | Additional fields |
|---|---|
| `turn` | `state: "started"` or `"ended"`. `outcome: "done"`, `"failed"` or `"stopped"` is required for `ended` and absent for `started`. |
| `tool` | `name: string`. Coalesce to ≤4 per second. Skip `speak`, `tell` and `note`. |
| `task` | `taskId: string`, `title: string` (≤120), `state: "working"`, `"done"`, `"failed"` or `"stopped"`. The task must originate from this Bot. |
| `handoff` | `handoffId`, `delivery: "queued"`, `"steered"` or `"refused"`. |

Forward turn and tool status from the Bot's own chat and task status for its own tasks. The status fields carry metadata only. Tool arguments, results and task output stay in Automagik.

#### Engine → Automagik

| `type` | Fields and bounds | Behavior |
|---|---|---|
| `ready` | `protocol: "automagik-call/1"`, `engine: { name: string, version: string }`, `available: boolean` | Answers `hello`. Availability reports whether the engine can take a call. |
| `state` | `callId`, `state: "connecting"`, `"listening"`, `"thinking"`, `"speaking"` or `"muted"` | First state confirms the start. |
| `level` | `callId`, `person: number`, `agent: number`, each finite RMS in [0, 1] | At least 70 ms between combined samples (≤15 Hz). Never logged or retained. |
| `partial` | `callId`, `side`, `utteranceId`, `text: string` (≤2,000) | Replaces the displayed partial for the utterance. |
| `final` | `callId`, `side`, `utteranceId`, `text: string` (≤2,000), `itemId`, `interrupted?: true` | Closes the utterance and supplies the permanent record's dedupe ID. |
| `handoff` | `callId`, `id` (handoff ID), `brief: string` (1–4,000), `transcript?: { side, text: string }[]` (≤8,000 text characters total) | `transcript` is an explicit selection of relevant excerpts. |
| `spoken` | `id` (of the `say`), `callId: UUID or null`, `outcome: "spoken"`, `"interrupted"`, `"dropped"` or `"refused"`, `reason?: string` (≤200) | A refusal requires `reason`. |
| `reseed` | `callId`, `why: "session-ended"` or `"dropped"` | Requests context for a replacement live session on the same call. |
| `error` | `callId?`, `code: "unsupported-protocol"`, `"busy"`, `"no-audio"`, `"bad-message"`, `"unknown-call"` or `"internal"`, `message: string` (≤500), `fatal: boolean` | Fatal errors with `callId` end that call. Other fatal errors close the connection. |
| `debug` | `callId?`, `kind: string` (≤40), `data: JSON value` (≤8 KiB serialized) | Only exposed in the authorized Debug view. |
| `ended` | `callId`, `reason: "hangup"`, `"engine"`, `"error"` or `"timeout"` | Terminal event for the matching call. |
| `ring` | `ringId: string`, `source: "soundbar"` | Reserved. `/1` ignores it apart from optional debug metadata. |

A valid frame for an unknown call cannot mutate call state. The engine can refuse unknown-call commands with `unknown-call`. The host ignores stale engine events and unmatched speech outcomes. The structured `start.context`, combined `level` and `hello.protocols` replace the earlier array context, per-side levels and `hello.version` from the call-engine draft. The engine sends `reseed` and the host supplies `context`.

### Voice context and retention

`CallContext` is a closed object with these required fields. `start.context` seeds a call. On `reseed` the host rebuilds it with the current call's finals eligible for the recap. The engine uses `opening` for a new call when present. Reseeding resumes the same call without a second greeting.

| Field | Shape and bounds |
|---|---|
| `instructions` | String ≤12,000 characters, built from the fixed host voice persona, Bot identity and eligible `voice` preferences. |
| `memory` | String array with ≤60 entries, ≤300 characters each and ≤8,000 characters total. Only the Bot's own `MEMORY.md` facts. Together with `voice` preferences in `instructions`, the same entry and aggregate memory caps apply. |
| `recap` | `{ part, note, items, older, now }`. `part` is a positive integer. `note` is a string ≤8,000 characters or `null`. `items` has ≤120 `{ role, text }` objects with `role` equal to `user`, `assistant` or `context` and text ≤2,000 characters each. `older` is a non-negative count of raw lines left out. `now` is a string ≤600 characters or `null`, for open handoffs and undelivered results. |
| `opening` | String ≤600 characters or `null`. |

Build and mask the candidate context, apply its field caps, then measure the actual serialized UTF-8 frame with LF. If it is too large, remove recap items oldest first, even down to `items: []`, updating `older` for omitted raw lines. If the empty recap still exceeds the byte budget, trim the note by Unicode character boundaries, then drop trailing memory entries and lower-priority preferences, then trim the optional `now` and `opening` text. Use `null` for omitted optional text and reserialize after truncation, accounting for JSON escapes and the actual envelope each time. Preserve the fixed persona and required fields. If the minimum frame still cannot fit, refuse the start or end the call on failed reseed without sending an oversize frame. Use the same algorithm for both frame types. Wire truncation leaves the stored voice record and memory intact.

The voice organ keeps `record.jsonl` (append-only) and `parts.json` (atomic replace) at `<team home>/voice/<safeId(botId)>/`, both mode `0600`. Record masked finals, briefs with their request IDs, Bot `speak`/`tell`/`note` text and delivery, and call boundary metadata. Deduplicate finals by `(callId, itemId)`. The live pane's transcript and replay buffer are transient, for the call plus 60 s. Partials are display state only. Levels, partials and debug entries never enter the durable record, and the engine logs counts and timings without transcript text.

After a call ends, write a handoff-style voice note only if raw lines since the previous part exceed the 6,000-token budget. Retry a note with missing headings once and use the previous note with the `recent` fallback when the backlog requires closing the part after failure. Queue the existing memory review once per call, with cursor `voice:<botId>`, and skip its model call when there is no new user line. Keep lasting call preferences in the Bot's own `voice` topic, visible and editable through Memory. The next call receives those preferences and the bounded recap, so a correction can carry across calls.

### Owner routes and live stream

Use the existing owner/device admission at `POST /api/omni-ui` and its read-only checks. Scope all reads and mutations to the requested Bot and authenticated owner. A request's Bot, Session or call ID cannot supply authority.

| Op | Request fields | Result |
|---|---|---|
| `call-start` | `sessionId: string`, the Bot's current own chat Session | `{ ok: true, callId }`. A group or unrelated Session is refused with `bot/invalid`. |
| `call-end` | `botId: string`, `callId` | `{ ok: true, ended: boolean }`. Idempotent and scoped to the matching Bot and call. |
| `voice-history` | `botId: string`, `before?: number`, `limit: number` (≤100) | `{ items, cursor: number or null, parts: [{ number, at, note }] }`, newest entries first. |
| `voice-forget` | `botId: string` | `{ ok: true }` after archiving the active voice history. |

Label `voice-forget` **Archive voice history**. Move the record and parts to `<team home>/voice/archive/<id>-<iso>/` and clear the active history and its use in future context. Start the next history with a fresh review cursor or continue the record sequence above the old cursor so the next call is eligible for review. Archiving leaves the existing chat briefs and separately learned `voice` preferences in place. Bot deletion also archives the record and clears its voice review cursor as part of deleting the Bot's memory scope.

`GET /api/omni-ui/call/stream?bot=<id>[&debug=1]` requires the existing same-origin event-stream and owner-viewer admission. An unknown or ineligible Bot returns 404. Streams are rechecked on revocation and closed when the viewer or Bot is no longer eligible.

| SSE event | Data |
|---|---|
| `snapshot` | `{ botId, engine, call, transcript, partials, handoffs, seq }`. `call` is the current summary or `null`. `transcript` contains up to 200 finals `{ side, utteranceId, text, final, at }`. `partials` has the current `person` and `agent` display values. `handoffs` entries contain `{ id, brief, delivery, at }`. |
| `call` | `{ seq, type, ... }`, with `type` one of `state`, `partial`, `final`, `handoff`, `say`, `status`. |
| `level` | `{ person, agent }`, without an SSE id. |
| `ended` | `{ seq, callId, reason }`. |
| `debug` | `{ seq, dir: "in" or "out", line }` only with `debug=1`. Expose masked diagnostic lines to the authorized viewer, omitting level and partial samples and sensitive context payloads. |

Resume with `Last-Event-ID` from the 400-event per-call replay ring when the cursor is available, otherwise send a snapshot. Keep levels outside the ring and partials only as current display state. Coalesce partials to 10 Hz and drop levels under backpressure. Keep the most recent 500 debug lines in transient memory when enabled. Send `: keepalive` every 20 s. Use a 64-event high-water mark and close a slow stream when `desiredSize < -256`. The existing `live()` view adds `calls`, keyed by Bot id with `{ engine, call?, answersSoundbar }`. `engine` is `offline`, `connecting` or `ready`; `call` carries `{ callId, state, startedAt }`.

## Threat model

- **Who can connect.** Only a role registered by bots-dsh itself can declare an engine. The resolved path must be under the real home and at most 103 bytes. Verify the parent chain up to home is not group- or world-writable, and the final component is a Unix socket of the current user, never a symlink. Recheck on every connect. The urs socket is mode `0600` in its `0700` home. The grant card shows the address and explains that the engine can send messages as the person, including a steer during a turn.
- **Who can act.** The host binds the connection to the Bot in `hello` and resolves its own chat when accepting a handoff. The `ctx.call` binding is exclusive to approved Voice tool invocations and uses the acting Bot and its current grant, attachment and abort signal, including when that Bot acts in a group Session. Tool arguments cannot choose a Bot or call. Detaching Voice or revoking the grant stops new inputs and outputs immediately, sends `end` with `reason: 'revoked'` if a call is running, closes the socket, cancels pending tool work and prevents reconnect until eligibility returns. Data the engine already received and messages already delivered to the Bot's chat cannot be recalled by revocation.
- **What crosses the boundary.** The grant card names the engine and provider and describes audio, the fixed voice persona, Bot identity, its own memory facts and `voice` preferences, masked voice notes and recent call lines, briefs and speech-tool text. Automagik masks allowed text before persistence and again before egress, including status text. The engine receives only the bound call's data. General Bot instructions, other chat text, team/group and other-topic memory, tool arguments, task output and credentials stay out. Render engine-supplied text as plain text. The proposed urs sidecar uses OpenAI live via Pipecat 1.16.0 `ClientDelegation`, explicitly sets `store: false` and resolves its own provider credential without passing it through Automagik or the call protocol.

## Deliveries

These are proposed slices. Owner acceptance of this RFC precedes implementation. Automagik's implementation depends on the delivered role registry and thread contracts.

| Slice | Lane | Acceptance check | Rollback |
|---|---|---|---|
| 1. Engine and duplex feasibility | urs | Prove seeded `ClientDelegation` with a fake Automagik, first offline without provider setup, then in an owner-authorized isolated live run. Check acknowledgement before idle and absence of the fallback line. Record a separate `soundbar aec-check` receipt. A failed spike stops dependent work for the owner's decision. | Keep half duplex and the existing call path. |
| 2. Voice grant, record and call host | plugin (3.N.P) | Fake-engine tests cover path and actor refusal, grant revocation, UTF-8 limits at 65,536 and 65,537 bytes, JSON escaping, empty recaps, stable IDs, one selected handoff message and thread, SSE resume, and next-call context and preferences. | Revert the new call path. Previously delivered chat messages and saved records may still exist. |
| 3. urs engine and audio | urs | Socket-pair and null-output tests exercise protocol, EOF and exact speech. After a passing AEC receipt, enable `SOUNDBAR_CALL_DUPLEX=full` only on built-in macOS output with capture and playback sharing `VoiceProcessingIO`. Default to half duplex, including unproven routes such as Bluetooth. | Return to half duplex by removing the full-duplex setting. |
| 4. Call view and browser voice retirement | plugin (3.N.P) | Replay a fake stream for the Voice tab, links and red hang-up. Keep dictation and Enter-to-send. | Restore the previous browser voice path. |
| 5. urs legacy retirement and live proof | urs | Remove the obsolete plugin and admin socket. An owner-present isolated proof after uninstalling `urs-automagik` 0.1.4 records UI, interruption, post-call speech and continuity across two calls. | Revert the engine cutover. The installed legacy plugin has its own owner-controlled lifecycle. |

## Open questions

- Approve this wire contract and grant boundary for delivery. Recommendation: keep the single fixed local engine and per-Bot opt-in described here, and defer inbound soundbar and remote engines.
- Enable full duplex after the AEC spike. Recommendation: require the passing receipt and built-in output before enabling it. Keep half duplex on every other route.

## Links

- [RFC 0037, One Bot; roles make the difference](0037-roles-not-types.md), especially contract 8.
- Planned RFC 0050, *Teams, positions and roles*, supplies the registry and capability amendment. Planned RFC 0051, *Threads and the Orchestrator*, supplies the thread record and reserved `call-handoff` kind. Both are design dependencies pending approval and delivery.
- W3 design decisions 13–19 and acceptance checks (`old #5.1`) carry forward the host-owned call and engine (`old #7.2`), the browser cutover (`old #8.2`), voice continuity (`old #31.1` and `old #33.1`) and the live voice and echo-cancellation choices (`old #4.1`–`#4.3`).
