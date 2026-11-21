# RFC 0045: DSH upstream: authored input, a caller-scoped turn and a drain

| Field | Value |
|---|---|
| Status | Proposal-only (a proposal to DSH; nothing ships here) |
| Milestone | none (a proposal to DSH; nothing ships here) |
| Lanes | none for this RFC (docs only); plugin (3.N.P) for each removal once DSH ships the piece |
| Created | 2026-11-20 |

## Summary

Five extension points we would ask DeepSeek Harness (DSH) to add, so that a person who is not the
owner can send a prompt to a shared Session and DSH itself proves who wrote each input, which
Session it was admitted for, and that nothing the person may not see or do runs in their turn. The
first four come from RFC 0038 delivery 5e (#1928): members and guests prompt a shared Bot; the
fifth from RFC 0030 delivery 4's remainder (#1007): a conversation's history never crosses a
harness.

1. **Authored input.** DSH stamps every inbox message with the author of the Peer that admitted
   it, keeps that author through every move of the message, and asks the host one question,
   `authorize`, before every model request it makes for a Session, whatever its purpose.
2. **A caller-scoped turn.** A turn whose initiating input is not the owner's runs under a scope
   the host gives for that author: DSH applies it in the final tool guard, to the model route, to
   continuations and to subagents, and passes the turn's author to `llm/stream`.
3. **A drain.** One call atomically removes matching input from every inbox position, cancels the
   matching turns and resolves once they have settled and the removal is durable.
4. **A route that owns its tools or context.** A provider can say that its model keeps its own
   tools or its own context (an agent over ACP), so DSH refuses a scoped turn on it.
5. **A route change bound to a Session revision.** DSH records a model selection only if nothing was
   admitted since the host looked, keeps each input's origin part, and forwards input with a durable
   receipt, so a host can change a conversation's route without carrying history or pending input to
   another harness (RFC 0030, Q7).

Each one removes plugin machinery that three review rounds of a plugin-only design could not make
complete (RFC 0038, "Deliveries for this amendment", 5e). This RFC is the proposal only: it names
the DSH code it would touch, what we would remove when each piece lands, and the questions for
DSH's maintainers. It sets no Automagik contract. Delivery 5e does not wait for it: until DSH ships
these pieces, 5e can only use one certified route built from what DSH already offers (see "What a
plugin can do on DSH 0.2.2-rc.2"), with the residuals listed there.

Every `dsh-*` file is the pinned DSH's (0.2.2-rc.2), under `node_modules/@deepseek-ai/`; `L:` is
the package's `lib/index.js`.

## Motivation

RFC 0038's amendment of 2026-11-20 decides that, with multiuser on, every human input to a shared
Bot's Session carries a verified author; that a member's or guest's queued or continuing work never
reaches a model step or a tool once their access ends; that a member-started turn's model request
holds no content they cannot see; and that the Bot's tools are checked against the person who
started the turn. DSH 0.2.2-rc.2 provides part of what that needs, and the rest is DSH's to own.

**What DSH already provides.**

- `session/prompt` records the calling Peer's principal on the message's `source`
  (`dsh-api-session-controller` L:4150-4156), only for a non-owner Peer: `principalOf` answers
  nothing for the owner (`dsh-typert-protocol` L:294-297). The principal is fixed at Peer creation
  by host code; no wire field sets it.
- The gateway decides each non-owner call, with its validated arguments, by the policy of the
  principal's kind (`dsh-api-gateway` L:1206-1220); a policy condition sees `args`.
- Every in-process model call through DSH's `llm` service, a prepared call's included, goes
  through the `llm/stream` waterfall (`dsh-llm` L:2502-2508, `dsh-llm/src/index.ts:1014-1030`),
  whose options may carry `sessionId` and `purpose`; both are optional
  (`dsh-llm/src/types.ts:595-606`). An adapter can still post more than once inside one call (the
  DeepSeek adapter retries after a stale image-file mapping,
  `dsh-llm-deepseek/src/adapter.ts:105-162`).
- `agent/pre-step` runs once per loop step, also on a continuation step with no new message, and a
  `reject` ends the turn (`dsh-agent-loop` L:755-761); `agent/request` runs once per request
  attempt, retries included (L:1007-1014).
- The final tool guard is monotonic: "guards have no allow result, so listener ordering cannot
  turn a denial back into permission" (`dsh-tools/src/contracts.ts:402-410`).

**What it does not.**

1. **The owner has no author.** Owners and admins share DSH's owner Peer; DSH records no person on
   its prompts, so two admins' posts look the same, and an owner's prompt looks the same as input
   that trusted host code queued (schedules, jobs, headless, the ACP server and the JSON-RPC SDK
   queue input with no principal too).
2. **An author does not survive every move.** A queue edit replaces the content and keeps the
   original `source`, principal included (`dsh-api-session-controller` L:1034-1041): the edited
   text runs under the first author. A pre-step `reject` drops the claimed messages; only a
   listener can put them back (`dsh-goal-round-driver` re-prepends the other claimed messages,
   `src/index.ts:135-141`), and a message a plugin forwards to another Session gets a fresh id
   with the old source. `agent/inbox/inserted` and `claimed` are notifications: the splice is
   already recorded when a plugin hears of it, and `claimed` carries no placement.
3. **No author reaches a model request.** `llm/stream`'s options carry no principal and no turn;
   a continuation step, a compaction summary, a session title or an auto-review request has no
   author. `dsh-experimental-liveshare`, the one reader of `source.principal` (L:8137-8156),
   keeps whether a viewer started the turn in memory (`noteViewerTurn`, L:8033-8042) because
   continuation steps carry no message, and it reads only `source.kind === 'user'`, so a viewer's
   `retry` is not attributed. A session title is scheduled as background work after the turn's
   message (`dsh-session-title`), so it can run after the turn that caused it has ended.
4. **Not every model request passes a decision a plugin owns.** Pressure compaction makes its
   summary request inside its own `agent/pre-step` listener, before it calls `next()`
   (`dsh-compaction-basic` L:839-851); the model-switch guard and overflow compaction run in
   `agent/request` and `agent/request-error`. Waterfall order is registration order adjusted only
   by `prepend`, with no priority, so no plugin listener on `agent/pre-step` or `llm/stream` is
   guaranteed the last word.
5. **No drain.** `inbox.clear()` is two splices, next-step then next-turn (`dsh-agent-loop`
   L:92-96); `session/cancel` keeps the inbox (`dsh-api-session-controller` L:1067); disposing
   a ready agent clears it (`dsh-agent-loop` L:1498-1500).
   Nothing removes matching input from every position, cancels the matching turns and tells the
   caller when both are settled.
6. **No route says it owns its tools or context.** Resolved model info extends the catalog's
   metadata with the context window, default tokens, reasoning and system-prompt and tool update
   hints (`dsh-llm/src/types.ts:369-384, 453-465`); nothing says who runs the tools. An agent route
   (acp-dsh's native-tools mode keeps the agent's own tools and a live process across turns) looks
   like any other model to DSH.
7. **The request a plugin sees is not the payload that leaves.** Tool declarations and tool
   history travel beside `messages` and are projected after the waterfall
   (`dsh-llm/src/index.ts:1125-1137`); the DeepSeek adapter then adds request extensions
   (`dsh-llm-deepseek/src/request-extensions.ts:28-42`), among them `dsh_session_log`, which
   uploads the Session's log when enabled (`dsh-session-log-deepseek/src/index.ts:196-225`; it has
   an exclusion hook); and a required runtime context (the working directory's absolute path) is
   restored on every attempt even when a listener left it out
   (`dsh-working-directory/src/index.ts:109-129`). A plugin cannot certify the final body.

## Design

Names are suggestions for DSH's maintainers to change. Each piece is the smallest addition that
removes one part of the plugin's machinery.

### 1. Authored input, enforced by DSH

```ts
// On every inbox message; set by DSH from the admitting Peer, never by a payload.
interface MessageAuthor {
  kind: 'owner' | 'principal' | 'host'
  principal?: RemotePrincipal        // the admitting Peer's, for kind 'principal'
  identity?: string                  // an opaque host assertion handed over with this invocation
                                     // (one owner Peer serves every admin's browser, so it is per call)
  admission: string                  // an opaque id the host gave at admission (one person can hold
                                     // two sessions with different roles)
  target: SessionId                  // the Session the input was admitted for
  admittedAt: number
}
// One host decision, asked by DSH before ANY model request it makes for a Session.
type AuthorizeInput = (request: {
  sessionId: SessionId
  origin: { kind: 'turn'; turn: number; step: number; attempt: number }
        | { kind: 'background'; work: 'maintenance' | 'title' | 'review' | 'memory' | (string & {});
            causedBy?: { turn: number } }                     // absent: no known cause, decided as such
  turnAuthor?: MessageAuthor         // the author of the initiating input of the turn that caused it
  inputs: { messageId: MessageId; author: MessageAuthor; destination: SessionId }[]
  payload: { system: string; contexts: string[]; tools: ToolDeclaration[] }  // the final body's
                                     // model-visible parts, after every projection and extension
}) => 'allow' | { quarantine: MessageId[] } | 'refuse' | Promise<...>
```

- DSH stamps `author` at admission (`session/prompt`, `followup`, `steer`, `inject`, card replies,
  queue inserts, subagent prompts) and keeps it through claims, restores, held re-inserts, restarts
  and forwards. Trusted host code that queues input stamps `kind: 'host'`.
- A queue edit or a steer move by a Peer other than the author re-stamps that Peer as the author,
  or is refused, as DSH prefers; it never keeps the old author on new text.
- An invocation on the owner Peer may carry a host-verified identity (`identity`), handed over by
  the host code that serves it, so two admins' posts through one owner Peer get two authors.
- DSH calls `authorize` before every model request of the Session, whatever its purpose, and
  before any model-visible effect of it: each step and continuation, each attempt (an adapter's
  internal re-post included), every compaction (pressure, switch, overflow, `/compact`), the
  session title and auto-review; background work carries the turn that caused it, or says it has
  none. The decision sees the final payload (system, contexts, tool declarations) after every
  projection and request extension, and nothing is added after it.
  `quarantine` removes the named inputs durably and emits an event with them; `refuse` ends the
  step as a `reject` does; a throw or a timeout is `refuse`.
- One registration per host (like `registerPolicy`, unique per non-owner principal kind), so no
  listener order can bypass it. While a host that registered it has none (a reload), DSH refuses
  model requests on the Sessions that took authored input.

**What we remove.** The plugin's admission record (an in-memory map from message id to session,
digest and family, minted at dispatch and bound to one inserted occurrence), its content digests
and edit detection, the fixture of every source kind and its class, the positive check of a
request's blocks, the refusal of unattributed input on a shared Bot at the
pre-step, and the `llm/stream` and `agent/request` checks that stand in for `authorize`.

### 2. A caller-scoped turn

```ts
interface TurnScope {
  tools(call: Readonly<ToolExecution>): string | undefined   // a denial reason, or nothing
  route(selection: { provider: string; model: string; info: ModelInfo; registration: string }): boolean
}
// Asked once when a turn starts whose initiating input has a verified human author (an owner
// invocation with an `identity` included); 'host' input and an owner without one are unscoped.
type ScopeFor = (author: MessageAuthor, sessionId: SessionId) => TurnScope | undefined
```

- Every authenticated human's turn is scoped, an admin's included (its identity is the
  invocation's, § 1), so a demotion reaches it.
- DSH applies `tools` in the final `tools.guard` of every tool execution of that turn and of the
  subagents it starts. The guard runs at preparation, so a tool with an effect later (a card, a
  post) also gets an `authorizeEffect(call)` it awaits right before that effect; an external
  subagent provider that cannot enforce the scope is refused. DSH refuses, before the request, a
  model route for which `route` is false; a withdrawn scope cancels the turn, its sibling calls,
  its children and its streams, and the host's invalidation is how a scope is withdrawn.
- `undefined` from `ScopeFor` refuses the turn. DSH asks `authorize` again before each
  continuation and before each tool batch; a refusal ends the turn with no further output
  streamed.
- DSH puts the turn's author on `llm/stream`'s options (`turnAuthor`), so a middleware that adds
  context can leave it out of a scoped turn.
- A scoped turn is not resumed after a restart; DSH settles it as cut off.

**What we remove.** The plugin's caller-turn record and its inflight note, the default-deny
listener that stands in for the scope, the list of certified providers, the stops at continuation
and on a relay joining a caller turn, and the separate rule that a restart never continues a
member's turn.

### 3. A drain

```ts
agent.drain(match: (message: Message, author: MessageAuthor) => boolean):
  Promise<{ removed: Message[]; cancelled: number }>
```

- Matching is by message author and by the frozen author and ancestry of each running turn, so a
  turn already claimed with no pending input, and its descendants, are found.
- First a barrier: admissions already in flight finish or fail, and new ones matching are refused
  until the drain resolves and afterwards for as long as the host keeps the barrier. Then it
  removes matching input from every inbox position (next step, next turn, pending re-inserts) in
  one durable splice, cancels the running turns whose `turnAuthor` matches and their descendants,
  and resolves only after they settle and the removal is written. A drain interrupted by a restart
  resumes before startup recovery.
- Input the host holds outside DSH (a plugin's held or update records) stays the host's to drain:
  DSH calls a host callback inside the barrier and waits for it, so that input is quarantined
  before anything is released.
- A host-wide form (`drainAll(match)`) covers cold Sessions without resuming each.

**What we remove.** The plugin's drain latch, its inventory of Sessions that ever took authored
input, its wait and cancel loop, and the quarantine of whatever a drain missed.

### 4. A route that owns its tools or context

```ts
// The model info DSH already resolves, two optional fields more (§ 1 of RFC 0023 asked for the first).
interface ModelInfo {
  contextManagedByProvider?: true   // the provider keeps its own context
  toolsManagedByProvider?: true     // the provider runs its own tools outside DSH's pipeline
  scopeSafe?: true                  // the provider affirms: one request per authorize, DSH's
                                    // tool pipeline only, no context of its own
}
```

- A scoped turn (§ 2) runs only on a model whose provider affirms `scopeSafe` and whose `route`
  check passes; `scopeSafe` loses to either managed flag; an unmodified provider is not
  scope-safe. The answer is bound to the Session and to the prepared registration that will
  dispatch, and an adapter that posts again inside one call asks `authorize` again first. A
  provider whose behaviour depends on the Session (acp-dsh's native-tools mode) answers per
  Session.
- acp-dsh would set the fields in its provider's model resolution.

**What we remove.** The plugin's pinned list of adapters a member turn may use.

### 5. A route change bound to a Session revision, and input bound to its part

From RFC 0030 (Code mode in the app), Decided 6 and Answers Q7: a conversation's history never
crosses a harness (DSH's own tools, or an agent over ACP such as Claude Code or Codex). The Bot
team refuses that crossing when the person picks a new route for a chat that has history (Q7a,
#1863). It cannot enforce the same rule for the other writers — failover, migrations, a reopened
part, automatic rollovers, a group member's Session — or for input pending during a managed move.
Three review rounds of a plugin-only design (#1007, 2026-11-21) found the same two gaps every
time.

```ts
// A selection that DSH records only if nothing was admitted since the host looked.
interface SessionRevision { readonly sessionId: string; readonly seq: number }   // durable, monotonic
controller.revisionOf(sessionId): SessionRevision      // bumps on every admitted input or turn start
controller.selectModel(request & { ifRevision?: SessionRevision }):
  Promise<{ selected: ModelSelection } | { refused: 'revision-changed', revision: SessionRevision }>

// Input that keeps the part it was meant for, with a durable receipt when it moves.
interface MessageOrigin { readonly sessionId: string; readonly exchangeId?: string; readonly cardCallId?: string }
agent.forward(messages: Message[], to: SessionId, opts: { receiptKey: string }):
  Promise<{ delivered: string[]; alreadyDelivered: string[] }>   // idempotent across restarts
```

- **The fence.** `selectModel` with `ifRevision` checks the revision and records the selection
  inside the same admission lock that prompt, steer, followup and the inbox use, after
  `requireModel` and `resolveCallConfig` have resolved, so no input is admitted and no turn starts
  between the check and the write. Today `selectModel` awaits agent resolution, model validation
  and call-config resolution before the selection is recorded, and text prompts are admitted
  outside `serializeImageAdmission` (`dsh-api-session-controller/src/commands.ts:166-168, 386`: a
  prompt without an image is admitted without it), so a turn can start on the old route after any
  host check. A refused selection changes nothing, and the host reads the history again.
- **Input bound to its part.** Every inbox message keeps a `MessageOrigin`: the Session it was
  admitted for and, where it answers something (a question card, a browser handoff, a reply to
  another Bot), the exchange or call it answers. A host can ask DSH to hold input whose origin is
  not the current part instead of running it on another route, and to list input claimed by a step
  (pre-step batches) without losing it.
- **Durable forwarding.** `forward` writes each moved message to the destination and retires it
  from the source in one durable step keyed by `receiptKey`. A restart after delivery and before
  the source removal does not deliver it twice, and a message without an `exchangeId` is still
  found.
- A host-wide form of the fence (`drainAll` in § 3 already has the barrier) lets a host apply one
  route change to several Sessions of one Bot (its own chat and its group Sessions) and see which
  of them were refused.

**What we remove.** In the Bot team (apps/bots-dsh):
- the single history read in `switchRoute`'s in-place path, and the "conversation changed or is
  busy" re-check around it (`parts.js`);
- the plan for a per-Session route hold that the Bot-wide `model`/`appliedModel` pair cannot
  express;
- the forwarding's inbox-based deduplication (`parts.js` `forward`);
- the sign-in-code drop on forwarded input, which becomes a check on the input's origin
  (`cli-login.js`). With the fence and origins, RFC 0030 delivery 4's remainder (Q7b, Q7c beyond
  failover, and the managed history-free move with its pending input) can be built as plugin work.

## What a plugin can do on DSH 0.2.2-rc.2

Delivery 5e may also start from one certified route (RFC 0038). On the pinned DSH that route has
to be narrow, because the hooks above see a request but not its origin: a Bot on one pinned native
adapter; a part in a mode where every turn, the owner's too, takes text and answers with text and
the Bot's question and view cards only (no memory, recall, images, drawing, compaction or
automatic title); an affirmative mark minted at `agent/request` for each attempt the plugin
authorized and required at `llm/stream`, which refuses everything else on that Bot's Sessions; a
positive check of the actual request's blocks against that small set; admission minted by bots-dsh
and bound to one inserted message; tools fenced in the final `tools.guard` and the card tools
rechecked at their effect; a drain from the principals DSH records; and every other route refusing
member prompts. Two adversarial reviews of a plan for it (2026-11-20, #1928) still found open
boundaries (the final body, the order between a decision and its effect, background work that
outlives its turn, the drain's inventory), so it is not certified yet. What only DSH can close
stays a residual of that route, and the narrowing itself is the cost each piece above would lift:

- **Listener order.** The checks hold while every `llm/stream`, `agent/request` and
  `agent/pre-step` listener outside them either calls `next()` or answers without a model call.
  Plugins are trusted code the owner installed (RFC 0038); a plugin that calls a model outside DSH's
  `llm` service is outside any check. Closed by § 1's single registration.
- **The owner's native composer.** The owner Peer has no author, so a shared Bot takes owner posts
  only through the Bot UI's composer (an owner path the gate signs), and refuses an unattributed
  post at the step. The refused text stays in the Session's `agent/inbox/spliced` event. Closed by
  § 1's per-invocation `identity`.
- **Queue edits.** An edit keeps the first author, so the plugin refuses edited authored input
  instead of re-attributing it. Closed by § 1's re-stamping.
- **Atomic removal.** The drain removes input one occurrence at a time and relies on a latch so
  that nothing it misses reaches a model step. Closed by § 3.
- **The final body.** The plugin checks the messages it sees at `llm/stream`; tool declarations,
  request extensions and required contexts are added later, so the route pins the profile
  (extensions excluded for those Sessions, the required context replaced). Closed by § 1's
  `payload`.
- **Route ownership.** The plugin pins the adapter registrations a member turn may use. Closed by
  § 4.
- **Background requests.** Titles, compaction and recovery are switched off in that mode because
  their requests carry no origin. Lifted by § 1's origins.

## What does not change

- Nothing here asks DSH to know about Bots, members, gates or Automagik's roles: the host decides
  `authorize` and the scope; DSH only asks at the right moments and keeps the author.
- The owner's own Sessions, and every Session of a host that registers no `authorize`, behave as
  today.
- RFC 0038's policy stays multiuser-dsh's; the `automagik` principal kind and its roles stay ours.
- Nothing here goes to DSH's maintainers without the owner's OK.

## Open questions

1. Would DSH stamp the author on the message (a new field beside `source`) or extend `source`,
   whose kinds plugins augment today?
2. On a queue edit by another Peer, would DSH rather re-stamp the editor or refuse the edit?
3. Is one `authorize` per model request acceptable on the hot path, or should DSH cache an `allow`
   for the rest of a step until the host invalidates it?
4. Should `quarantine` keep the input in a durable side list DSH owns (with an event), or hand it
   to the host and forget it?
5. Would DSH accept a per-invocation identity on the owner Peer, or prefer a distinct verified
   Peer for each admin?
6. Is the route marker one field on the model, or one on the provider (RFC 0023 question 1)?
7. Where does this go first: an issue on DSH's tracker, a patch in the desktop's runtime patches
   (a desktop release, RFC 0011), or both?
8. Is the revision one counter per Session (input and turn starts), or should it also cover a
   selection made through DSH's own composer picker, so the host learns of it?

## Tracking

- Issue #1928 (RFC 0038 delivery 5e), Refs #1373.
- Issue #1007 (RFC 0030 delivery 4's remainder: Q7b, Q7c, pending input).

## Links

- [0038](0038-cloud-multiuser-caller-principal.md), "Amendment (2026-11-20): delivery 5 specified":
  the rules this would enforce, delivery 5e and questions 5-9.
- [0023](0023-dsh-upstream-agent-context-and-chat-rows.md): the form of this proposal, and § 1's
  provider-managed context flag that § 4 extends.
- [0024](0024-automagik-cloud.md) (f): per-message authorship.
- [0030](0030-code-mode-in-the-app.md), Decided 6, Handoff note, Answers Q7: § 5.
