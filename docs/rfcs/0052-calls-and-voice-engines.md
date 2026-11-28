# RFC 0052: Calls and voice engines

| Field | Value |
|---|---|
| Status | Accepted |
| Milestone | none |
| Lanes | plugin (3.N.P) for Automagik delivery |
| Created | 2026-11-28 |

The owner's delegated acceptance is recorded on 2026-11-28 and takes effect on merge.

## Summary

Call one Bot from its own chat and follow the conversation in a Voice tab beside it. Automagik owns the call controls, chat handoffs, the Bot's speech tools and the per-Bot voice record. A local engine owns audio and the live voice model. urs is the first proposed engine for `automagik-call/1`.

## Motivation

The browser's voice chat and the urs plugin provide separate paths for talking to a Bot. A call needs one place to follow the conversation, see work handed to the Bot and hear the result. The voice agent can handle small talk, hand work to the Bot without filling its chat with the transcript, and carry the person's call preferences into the next call.

## Design

### Voice and the call

- Keep role id `voice-mouth` and display it as **Voice**. The proposed bots-dsh registry role declares `engine: { transport: 'unix', path: '~/.soundbar/automagik-call.sock', protocol: 'automagik-call/1' }` and `capabilities: ['call-engine']`. The planned RFC 0050 adds `call-engine` to RFC 0037 contract 8.
- A Bot is eligible when its current registry Voice attachment has the owner's per-Bot `call-engine` grant. The grant is absent by default and belongs to Voice's own attachment. The host checks that attachment and grant on each operation. The client reads `roleRuntimeByRole[botId]['voice-mouth']`. Keep `roleRuntime[botId]` as the legacy first-package view for existing clients. That projection cannot establish Voice eligibility. The `prefs.roles` switch gates catalog pins only.
- The only call setting is **Answers soundbar calls** (`answers-soundbar`, a team-scoped boolean toggle, default off). The host refuses a second enabled Bot for the team and names the current one. The value is advertised in `hello` only. Incoming soundbar calls and the wake word are deferred.
- Show the call button in the eligible Bot's own chat. It becomes the native red hang-up during the call. The right-pane Voice tab shows both waveforms, streaming text from both sides, handoffs linked to their thread, past calls and an opt-in Debug view. One active call row sits below the Bot in the left menu. Deliver the tab and gated button before retiring plain browser voice chat. Keep dictation and move the composer's Enter-to-send ref off `.bt-voice` to an element that always renders.
- The Voice tools take only `{ text }`, a string of 1–2,000 characters. `speak` sends `say` in `exact` mode through the hub's configured speech path with a `Playback` hold over live audio. `tell` sends `say` in `rephrase` mode. `note` adds silent context. During delegated work, the voice agent may give a short acknowledgement before reporting idle. Its other speech during that work comes from the Bot's tools. A written reply does not become speech by itself. After hang-up the Bot can post the result in its chat and use an exact `say` with `callId: null`, subject to the engine's local speak policy and quiet hours. `tell` and `note` require an active call.

### Voice upgrade

Existing catalog Voice pins and their `audio-out` grant keep speaking through the legacy `ctx.speak` path until the owner consents to the upgrade. A catalog pin stays inert while `prefs.roles === false`. Refuse conversion in that state and leave the pin inert. Resolve the shared `voice-mouth` id by stored pin source. For a pin that predates the source field, validate its package identity from the existing attachment metadata. A catalog pin uses the legacy package and a registry pin uses the new definition. Only one definition supplies `speak` for the attachment.

At cutover, use the existing per-Bot grant screen for the owner's explicit consent to `call-engine` and conversion of the matching catalog pin. The old `audio-out` grant carries no `call-engine` authority. Back up the attachment, replace it in its existing position once after consent, and load the same registry attachment on restart. Preserve unrelated attachments, grants, settings and learned preferences. Exercise rollback on a copied profile by restoring the old pin and matching legacy runtime and engine, retaining unrelated state.

### Handoff into the Bot's own chat

Each accepted `handoff` creates exactly one plain-text, voice-tagged user message in the connected Bot's current own chat. The message starts with `Voice call · handoff {n} · HH:MM` and includes guidance to answer through the Voice tools. The existing grant authorizes the brief. `/1` sends only the brief until the owner accepts an explicit excerpt selection signal. The host suppresses excerpts received before that approval.

After approval, append only masked excerpts that the accepted signal authorizes for this handoff and whose text matches a relevant, finalized utterance in the current call. Omit excerpts with no authorization or matching final, including unfinished, wrong-call, stale or unrelated selections. The presence of the `excerpts` field alone conveys no authority. The host never fills in excerpts from recent finals or posts the raw transcript or small talk automatically. The message is at most 8,000 characters with header and labels. Retain the brief before spending the remaining space on excerpts.

The host sends as the person through the existing user-prompt path, with `requestId: call:<callId>:<handoffId>` and `mode: 'steer'` if the Bot is mid-turn, or `mode: 'queue'` when idle. Retransmission with the same ID produces no second message. Stale handoffs cannot write to chat. A handoff conveys user input under the Bot's existing permissions and switches.

Open one `call-handoff` thread on call start using the planned RFC 0051 thread record in `state.threads`. Its id is `call:<callId>`, its Session and parent Session are the Bot's own chat, and its parent Bot and sole initial member are that Bot. Anchor it to the call and attach each successful handoff by its request ID, with the brief as progress. An Orchestrator can delegate from the handoff through its usual tools. End the call thread with the call. The thread reporter skips this kind so the Bot's chat turn cannot send a `thread-done` report back to itself.

## Contracts introduced

### Local transport and IDs

The host is the sole socket client. It opens one connection per eligible Bot to the fixed `~/.soundbar/automagik-call.sock`. The urs hub's `reserve_call` admits one active call across the new and legacy interfaces. A second start while occupied is `busy`. A missing engine is offline. A hub using a different `SOUNDBAR_HOME` is not found at the declared path. Connecting or retrying leaves chat and dictation usable without an engine. Tests use a temporary home and fake socket, or a socket pair and null audio.

Each frame is one closed JSON object with a string `type`, encoded as UTF-8 and terminated by LF. All structured objects in the tables are closed, including nested objects and array entries. `debug.data` is an explicitly opaque JSON value. The entire serialized frame in either direction is at most **65,536 bytes**, including the envelope, keys, quotes, separators, escapes and the final LF. This limit applies to `start` and `context` too. Both sides validate the complete frame before writing. On receive, count raw bytes across chunks. Reject a frame as soon as it cannot fit its LF and decode each complete frame separately. Invalid UTF-8, bad JSON, extra fields, missing required fields, invalid field values, unknown types and oversize frames are `bad-message` violations and close the connection. The engine sends a fatal connection-level `error` where possible before closing on a malformed host frame. The host reports the same code locally and closes on a malformed engine frame.

The host mints a lowercase UUID v4 for `callId` in `start` and a UUID for each `say.id`. The engine mints `handoff.id` as `h-<seq>` once per call handoff and reuses it on retransmission. A transcript has a stable `utteranceId` derived from the engine's transcript `itemId`. Handoff IDs and transcript IDs use `^[A-Za-z0-9_-]{1,64}$` and identify one handoff or utterance within the call. The final's `itemId` is the record's dedupe key together with `callId`. `spoken` echoes the `say.id` and its call scope, including `null` for post-call speech.

`hello` is the first frame and `ready` selects the protocol within 5 s. A failed negotiation closes with fatal `unsupported-protocol`. Reconnect with backoff of 1, 2, 4 seconds up to 30 seconds. After a toggle change, reconnect with the latest value in `hello` once the affected connection is idle. A call in progress continues. The first `state` confirms a start within 10 s, after which the host ends an unconfirmed start with `timeout`. EOF ends the call with `engine`, and outstanding speech resolves as `dropped` on end or connection loss. There is no heartbeat or automatic `say` retry. A refused `say` returns `spoken` with `outcome: 'refused'` and a reason.

The host waits up to 20 s after writing `say` for a matching `spoken`. On expiry, the tool returns the host-only outcome `unconfirmed` with “The voice engine has not confirmed delivery.” A long exact line may still be playing. The voice record marks delivery unconfirmed. A later matching `spoken` updates only the record for the original Bot, call scope and `say.id`, provided the record is still active. It cannot change the returned tool result or trigger replay. A retry is the Bot's own new `speak` with a new ID.

`?` marks an omittable field. All other fields are required, with `null` allowed only where shown. String lengths below count Unicode scalar values. Fields without a separate size bound are still subject to the frame byte limit, which applies even when every field meets its own bound. `side` is `person` or `agent`. A breaking change gets a protocol string such as `automagik-call/2` in `hello.protocols`.

#### Automagik → engine

| `type` | Fields and bounds | Behavior |
|---|---|---|
| `hello` | `protocols: ["automagik-call/1"]`, `bot: { id: string, name: string }` (name ≤60), `answersSoundbar: boolean`, `client: { name: "automagik-bots-dsh", version: string }` | Once per connection. |
| `start` | `callId`, `origin: "desktop"`, `bot: { id, name }` (matches `hello`), `language: string` (BCP 47), `context: CallContext`, `ringId?: string` (reserved) | Starts one call. |
| `say` | `id`, `callId: UUID or null`, `mode: "exact"` or `"rephrase"`, `text: string` (1–2,000) | `null` allows only `exact`. Answers with `spoken`. |
| `note` | `callId`, `text: string` (1–2,000) | Silent context. |
| `status` | `callId`, `kind` and exactly the fields of the selected variant below | Only for the active call. |
| `end` | `callId`, `reason: "hangup"`, `"revoked"`, `"detached"`, `"shutdown"` or `"timeout"` | The host ends the call locally on send. `detached` means Voice was detached. `revoked` means the grant was withdrawn or the Bot lost eligibility. |
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
| `handoff` | `callId`, `id` (handoff ID), `brief: string` (1–4,000), `excerpts?: { utteranceId, text: string }[]` | Brief only until the selection signal is approved. The legacy `transcript` field is an extra field and closes the connection with `bad-message`. |
| `spoken` | `id` (of the `say`), `callId: UUID or null`, `outcome: "spoken"`, `"interrupted"`, `"dropped"` or `"refused"`, `reason?: string` (≤200) | A refusal requires `reason`. |
| `reseed` | `callId`, `why: "session-ended"` or `"dropped"` | Requests context for a replacement live session on the same call. |
| `error` | `callId?`, `code: "unsupported-protocol"`, `"busy"`, `"no-audio"`, `"bad-message"`, `"unknown-call"` or `"internal"`, `message: string` (≤500), `fatal: boolean` | Fatal errors with `callId` end that call. Other fatal errors close the connection. |
| `debug` | `callId?`, `kind: string` (≤40), `data: JSON value` (≤8 KiB serialized) | Only exposed in the authorized Debug view. |
| `ended` | `callId`, `reason: "hangup"`, `"engine"`, `"error"` or `"timeout"` | Terminal event for the matching call. |
| `ring` | `ringId: string`, `source: "soundbar"` | Reserved. `/1` ignores it apart from optional debug metadata. |

A valid frame for an unknown call cannot mutate call state. The engine can refuse unknown-call commands with `unknown-call`. The host discards stale engine events and unmatched speech outcomes. A matching late `spoken` follows the record-only rule above. The structured `start.context`, combined `level` and `hello.protocols` replace the earlier array context, per-side levels and `hello.version` from the call-engine draft. The engine sends `reseed` and the host supplies `context`.

### Voice context and retention

`CallContext` is a closed object with these required fields. `start.context` seeds a call. On `reseed` the host rebuilds it with the current call's finals eligible for the recap and sets `opening: null`. The engine uses `opening` for a new call when present. Reseeding resumes the same call without a second greeting.

| Field | Shape and bounds |
|---|---|
| `instructions` | String ≤12,000 characters, built from the fixed host voice persona, Bot identity and eligible `voice` preferences. |
| `memory` | String array with ≤60 entries, ≤300 characters each and ≤8,000 characters total. Only the Bot's own `MEMORY.md` facts. Together with `voice` preferences in `instructions`, the same entry and aggregate memory caps apply. |
| `recap` | `{ part, note, items, older, now }`. `part` is a positive integer. `note` is a string ≤8,000 characters or `null`. `items` has ≤120 `{ role, text }` objects with `role` equal to `user`, `assistant` or `context` and text ≤2,000 characters each. `older` is a non-negative count of raw lines left out. `now` is a string ≤600 characters or `null`, for open handoffs and undelivered results. |
| `opening` | String ≤600 characters or `null`. |

Build and mask a copy of the context, apply the field caps and serialize the actual `start` or `context` envelope to UTF-8 with LF. A valid 65,536-byte frame fits as is. If oversized, in order, drop oldest `recap.items` and increase `recap.older` for the omitted lines, drop trailing `memory` entries, then shorten text in `recap.note`, `instructions`, `recap.now` and `opening`, in that order. Shorten at Unicode code-point boundaries and reserialize after each change to count escapes and envelope bytes. Stop as soon as the complete frame fits.

The minimum context is `{ instructions: '', memory: [], recap: { part, note: null, items: [], older, now: null }, opening: null }`, with `part`, the updated `older`, identifiers and required envelope metadata preserved. Apply this order even when the initial recap has no items. If the minimum frame is still invalid or oversized, refuse the start or end the call on failed reseed without a partial write. Wire fitting leaves the stored voice record and memory intact.

The voice organ keeps `record.jsonl` (append-only) and `parts.json` (atomic replace) at `<team home>/voice/<safeId(botId)>/`, both mode `0600`. Reserve the literal `archive` path. If a legacy Bot's `safeId` resolves to `archive`, use a collision-free escaped storage key and preserve its public Bot ID. Record masked finals, briefs with their request IDs, Bot `speak`/`tell`/`note` text and delivery, and call boundary metadata. Deduplicate finals by `(callId, itemId)`. The live pane's transcript and replay buffer are transient, for the call plus 60 s. Partials are display state only. Levels, partials and debug entries never enter the durable record, and the engine logs counts and timings without transcript text.

After a call ends, write a handoff-style voice note only if raw lines since the previous part exceed the 6,000-token budget. Retry a note with missing headings once and use the previous note with the `recent` fallback when the backlog requires closing the part after failure. Queue the existing memory review once per call, with cursor `voice:<botId>`, and skip its model call when there is no new user line. Keep lasting call preferences in the Bot's own `voice` topic, visible and editable through Memory. The next call receives those preferences and the bounded recap, so a correction can carry across calls.

### Owner routes and live stream

Use the existing owner/device admission at `POST /api/omni-ui` and its read-only checks. Scope all reads and mutations to the requested Bot and authenticated owner. A request's Bot, Session or call ID cannot supply authority.

| Op | Request fields | Result |
|---|---|---|
| `call-start` | `sessionId: string`, the Bot's current own chat Session | `{ ok: true, callId }`. A group or unrelated Session is refused with `bot/invalid`. |
| `call-end` | `botId: string`, `callId` | `{ ok: true, ended: boolean }`. Idempotent and scoped to the matching Bot and call. |
| `voice-history` | `botId: string`, `before?: number`, `limit: number` (≤100) | `{ items, cursor: number or null, parts: [{ number, at, note }] }`, newest entries first. |
| `voice-archive` | `botId: string` | `{ ok: true }` after archiving the active voice history. |

Label `voice-archive` **Archive voice history** in every locale. Serialize the move to `<team home>/voice/archive/<id>-<iso>/` with record and parts writes. The active history and recap start fresh. The per-Bot record sequence never resets. The next record entry continues above both the old record sequence and the review cursor so the first new user line is eligible for review. Pending work from the archived record cannot write into the fresh record or advance the review cursor. The pane's live stream continues until hang-up. Existing chat briefs and separately learned `voice` preferences remain in place. The archived files stay on disk with no expiry and are excluded from context, review and egress. This RFC introduces no retention or deletion path for them. Bot deletion follows the existing memory-scope archival path.

Retire the legacy `voice-pane`, `voice-wait` and `voice-spoken` operations on `POST /api/omni-ui` in Group 11, after the verified whole call on the newly delivered path.

`GET /api/omni-ui/call/stream?bot=<id>[&debug=1]` requires the existing same-origin event-stream and owner-viewer admission. An unknown or ineligible Bot returns 404. Streams are rechecked on revocation and closed when the viewer or Bot is no longer eligible.

| SSE event | Data |
|---|---|
| `snapshot` | `{ botId, engine, call, transcript, partials, handoffs, seq }`. `call` is the current summary or `null`. `transcript` contains up to 200 finals `{ side, utteranceId, text, final, at }`. `partials` has the current `person` and `agent` display values. `handoffs` entries contain `{ id, brief, delivery, at }`. |
| `call` | `{ seq, type, ... }`, with `type` one of `state`, `partial`, `final`, `handoff`, `say`, `status`. |
| `level` | `{ person, agent }`, without an SSE id. |
| `ended` | `{ seq, callId, reason }`. |
| `debug` | `{ seq, dir: "in" or "out", line }` only with `debug=1`. Expose masked diagnostic lines to the authorized viewer, omitting level and partial samples and sensitive context payloads. |

Count `seq` per call. Use `<callId>:<seq>` as the SSE id for replayable events. Resume with `Last-Event-ID` only if it identifies a retained event in the current 400-event per-call ring. A cursor from another call, an expired cursor or a missing cursor gets a snapshot. Keep levels outside the ring and partials only as current display state. Coalesce partials to 10 Hz and drop levels under backpressure. Keep the most recent 500 debug lines in transient memory when enabled. Send `: keepalive` every 20 s. Use a 64-event high-water mark and close a slow stream when `desiredSize < -256`. The existing `live()` view adds `calls`, keyed by Bot id with `{ engine, call?, answersSoundbar }`. `engine` is `offline`, `connecting` or `ready`. `call` carries `{ callId, state, startedAt }`.

## Threat model

- **Who can connect.** Only a role registered by bots-dsh itself can declare an engine. The resolved path must be under the real home and at most 103 bytes. Verify the parent chain up to home is not group- or world-writable, and the final component is a Unix socket of the current user, never a symlink. Recheck on every connect. The urs socket is mode `0600` in its `0700` home. The grant card shows the address and explains that the engine can send messages as the person, including a steer during a turn.
- **Who can act.** The host binds the connection to the Bot in `hello` and resolves its own chat when accepting a handoff. The `ctx.call` binding is exclusive to approved Voice tool invocations and uses the acting Bot and its current grant, attachment and abort signal, including when that Bot acts in a group Session. Tool arguments cannot choose a Bot or call. Detaching Voice sends `end{reason:'detached'}` for an active call. Withdrawing `call-engine` or otherwise losing eligibility sends `end{reason:'revoked'}`. Both immediately end the call, stop new inputs and outputs, close that Bot's connection and cancel pending tool work. There is no reconnect or backoff while ineligible. The host can connect again only after reattachment or regrant as applicable and current eligibility is restored. Data already sent and chat messages already delivered remain where they landed.
- **What crosses the boundary.** The grant card names the engine and provider and describes audio, the call language, the fixed voice persona, Bot identity, its own memory facts and `voice` preferences, masked voice notes and recent call lines, briefs and speech-tool text. It discloses call and handoff identifiers and delivery status, turn status, tool names, and task IDs, titles and status. Automagik masks allowed text before persistence and again before egress, including status text. The engine receives only the bound call's data. General Bot instructions, other chat text, team/group and other-topic memory, tool arguments, task output and credentials stay out. Render engine-supplied text as plain text. The proposed urs sidecar uses OpenAI live via Pipecat 1.16.0 `ClientDelegation`, explicitly sets `store: false` and resolves its own provider credential without passing it through Automagik or the call protocol.

## Deliveries

Implementation starts after this RFC merges. Automagik integration waits for W1 and W2 to merge. Stage breaking changes on integration branches and run the full gates on the matching candidates before delivery. For QA, the owner removes `urs-automagik` 0.1.4 from the authorized disposable candidate profile before proving the new path. Use a copied profile to exercise the legacy Voice upgrade, the new grant and rollback. The merge of this RFC does not authorize touching an installed owner profile.

Deliver in this order. First ship the urs hub with both interfaces, then Automagik Group 10. The owner then uninstalls `urs-automagik` from the target profile and verifies one whole call with the matching releases. Uninstall is an owner action and is never part of migration or automatic update. Until that whole call is verified, rollback is reinstalling the old plugin. Keep the legacy hub interface and browser voice path available for that rollback. Only after the verified call do Groups 11 and 12 retire their respective legacy paths in separate cleanup.

| Slice | Lane | Acceptance check | Rollback |
|---|---|---|---|
| 1. Engine and duplex feasibility | urs | Prove seeded `ClientDelegation` with a fake Automagik offline without provider setup, then in an owner-authorized isolated live run. Check acknowledgement before idle and absence of the fallback line. Pass `soundbar aec-check` only on built-in output with ERLE ≥20 dB, processed chirp correlation <0.3 and residual ≤6 dB above the noise floor. Record both receipts. A failed spike stops dependent work for the owner's decision. | Keep half duplex and the existing call path. |
| 2. Voice grant, record and call host | plugin (3.N.P) | Fake-engine tests cover the two end reasons, reconnect gating, toggle changes during a call, path and actor refusal, a late `spoken`, and whole-frame limits on both start and reseed. Golden cases include 65,536-byte acceptance, 65,537-byte trimming in order, four-byte characters, escaping, empty recap and minimum-envelope refusal without a partial write. Exercise two handoffs with small talk between them, stable IDs, one thread, a `bad-message` close for legacy `transcript`, suppression before approval and omission of excerpts without matching same-call finals. Check SSE replay, archive and Voice memory. | Revert the new path. Existing chat messages and saved records remain. |
| 3. Parallel urs engine and audio | urs | Group 5 adds `automagik-call/1` beside `ctl.sock` and `bridge.rs` and keeps the legacy path intact. Prove one shared reservation, framing, EOF and exact speech with socket pairs and null output. After a passing AEC receipt, `SOUNDBAR_CALL_DUPLEX=full` uses shared `VoiceProcessingIO` capture and playback only on built-in macOS output. Half duplex remains the default and covers unproven routes. A device change mid-call ends the call like a capture fault. | Keep the legacy interface available. Remove the full-duplex setting to return to half duplex. |
| 4. Call view and integrated proof | plugin (3.N.P) | Group 10 proves the tab, hang-up and thread links. On the disposable candidate profile record the plugin list, exact versions and screenshots. Show pre-W1 catalog Voice speaking before and after the W1 upgrade, explicit consent for W3 registry Voice, copied-profile rollback and a Bot with Genie, Orchestrator, Omni and Voice attached together. Show their distinct prompts, tools and grants, and a handoff delegated by Orchestrator. Show unshared small talk in the pane and Voice preferences after archive. | Reinstall the old plugin if it was removed. The old hub and browser paths remain available. |
| 5. Owner cutover and whole-call receipt | Coordinated release | After the hub and Group 10 ship, the owner uninstalls the old plugin on the target profile. Verify one whole call with a deliberate interruption and no self-interruption, post-hang-up speech and continuity on the next call. Record stage timings from mic acceptance and session start through first audio, the person's turn, handoff, Bot turn end, first spoken line, hang-up and post-hang-up speech. Record the plugin list and exact installed versions. | Reinstall the old plugin until the whole call is verified. |
| 6. Browser voice cleanup | plugin (3.N.P) | Group 11 retires the old browser voice UI and its three route operations after the whole-call receipt. Check dictation and Enter-to-send. | Restore the previous browser voice release if needed. |
| 7. urs legacy cleanup | urs | Group 12 removes `ctl.sock`, `bridge.rs` and the legacy plugin source after the whole-call receipt. Record the installed evidence in the urs delivery receipt. | Restore the matching legacy hub and plugin if rollback is needed after cleanup. |

## Answers (2026-11-28)

These decisions are recorded under the owner's delegated authority and take effect when this RFC merges.

- **Voice eligibility and upgrade.** The registry role reads its own grant. Catalog Voice keeps the legacy path while enabled and converts in place only with the owner's explicit consent. Catalog opt-out stays inert through upgrade.
- **Protocol and handoffs.** The 65,536-byte limit covers the entire frame. `/1` delivers a brief alone. Excerpt sharing requires a later decision on selection authority.
- **History.** The owner action is `voice-archive`. Archiving clears current history and recap while retaining files, learned preferences and the monotonic sequence.
- **Call lifecycle.** Detach and revoke close the connection with distinct reasons. Speech confirmation timeout returns `unconfirmed`. Late confirmation can update the record only.
- **Release and duplex.** Keep both hub interfaces through the verified whole call. Follow the delivery order and owner-controlled uninstall above. Half duplex remains the default and full duplex requires qualifying evidence on a built-in output.

## Open questions

- **Excerpt selection.** Decide what signal and interface authorize an excerpt. The recommendation is an authenticated owner confirmation for a text selection from finalized utterances for one handoff on the current call. The existing call grant and model selection alone confer no excerpt authority. Leave sharing disabled until that decision is recorded.

## Links

- [RFC 0037, One Bot; roles make the difference](0037-roles-not-types.md), especially contract 8.
- Planned RFC 0050, *Teams, positions and roles*, supplies the registry and capability amendment. Planned RFC 0051, *Threads and the Orchestrator*, supplies the thread record and reserved `call-handoff` kind. Both are design dependencies pending approval and delivery.
- W3 design decisions 13–19 and acceptance checks (`old #5.1`) carry forward the host-owned call and engine (`old #7.2`), the browser cutover (`old #8.2`), voice continuity (`old #31.1` and `old #33.1`) and the live voice and echo-cancellation choices (`old #4.1`–`#4.3`).
