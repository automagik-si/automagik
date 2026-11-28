# RFC 0053: Decisions

| Field | Value |
|---|---|
| Status | Proposed |
| Milestone | none |
| Lanes | Docs only for this RFC. Deliveries use the plugin lane (3.N.P), with desktop deliveries for DSH profile and install wiring. |
| Created | 2026-11-28 |

## Summary

An owner can turn on **Route messages to who they concern** for a group chat. For a plain
message, one decision scores which Bots the message concerns. The group calls the selected
members and shows how it chose them. Explicit mentions work without a decision provider. The
owner can inspect a result and call a member the decision missed.

Teams give Bots a shared goal and memory and give a named leader responsibility for the
members' work. The team handle reaches its leader in a group chat. The team record and
positions come from [RFC 0050](https://github.com/automagik-dev/automagik/pull/2176).
[RFC 0051](https://github.com/automagik-dev/automagik/pull/2175) covers visible threads and
Orchestrator. [RFC 0052](https://github.com/automagik-dev/automagik/pull/2174) covers voice.
These proposals are the integration sequence. The Decisions contracts, service and adapters
can be written in isolation once this RFC is accepted.

## Motivation

Today a plain group message can wake the admin or the whole group, depending on the room
mode. The sender has to name each relevant Bot to avoid interrupting everyone else. A
single, inspectable decision lets the sender delegate that choice and correct a missed call.

## Group routing

Only the owner can opt a group in, including through the host API. Existing and new groups
start with routing off, and a room without `room.route` keeps its existing admin or everyone
mode. The switch takes effect immediately. When enabled, the group settings show the
selected data destination or that the provider is unavailable, and disable the mode control.
Turning routing on with no provider ready asks for confirmation. Turning it off stops new
routing requests and prevents pending decisions from starting Bot turns.

The host resolves explicit `@name`, `@all`, and `@team` mentions first. A Bot can receive an
explicit call within the existing group rules even when the provider is down. A team mention
that cannot reach its leader still counts as an explicit mention. It posts a notice and
never becomes an implicit model-routed call. System messages and goal and progress posts
keep their existing dispatch rules. An ordinary Bot post in a routed group calls only
named recipients, including a reachable `@team` representative. An ordinary Bot post
cannot broadcast to `@all`.

For an eligible plain user message the host calls `decide()` once with the
`group-routing/1` rubric and one multi-select question, `concerns`. A message concerns a
member when it asks for their work or answer, or gives them information they need to act
on. Passing references and small talk are insufficient. The host treats the message and
context as evidence for this rubric. Provider output can select only eligible current
group members and grants no tool, role or data permission.

The host sorts candidates at or above `tau` (τ) by decreasing probability and starts up
to `k` together. A successful decision with no qualifying member leaves the message posted
with a nobody mark. An unavailable provider or invalid result leaves it posted with a
failure mark. Both outcomes wake nobody. A decision in progress keeps a live round open.
When buffered user posts fold into one turn, the last post is the one scored. The host
rechecks current group membership and the routing switch before calling the selected Bots.

### Marks and the route card

Marks appear next to the message time. Routed members show an avatar, faded below the
display-only `sure` threshold. While deciding, the mark shows progress. After a result,
`◌` means nobody was called and `⊘` means routing failed. Q5 proposes how `tau0` (τ₀)
changes the opacity of `◌`. One combined progress tick reflects the slots, in order of
precedence: running, failed, needs you, stopped, done. A pass contributes no tick.

The read-only route card shows each candidate's probability against τ, slot status,
question and member description, provider, model, latency, attempts, and a short failure
reason when applicable. The card distinguishes uncalibrated results and possible provider
truncation. **That was for {name}** calls a current member for the original posted message
and supplies a positive human judgment when that member has a recorded score. A member
who passed has **Call {name} again**. Both actions append an overturn to the record. An
unscored correction can still call a member. The host checks the caller, room, route and
current membership before starting a turn. A stale or inaccessible target is refused.

The group book `group-<roomId>` appends UI records with `kind: 'route'` and
`event: 'decided' | 'slot' | 'overturn'`. A `decided` event links the message sequence
and optional DSH message id to a decision id, outcome, sanitized rubric and options, scores,
thresholds and routed member ids. `slot` and `overturn` events carry the route id, member id
and time, with a status for slot events. Route events stay outside the conversational
sequence, room log, search, `read_group_chat` and Bot context.

## Decisions service

The Bot team ships the DSH-level `ctx.decisions` service and separately registered adapters as
`./decisions` and `./decisions-providers`. The service is independent of the Bot host. A
decision asks typed questions about bounded state and yields probabilities and structured
outcomes. The first purposes are `group-routing` and the fixed, synthetic `settings-test`.
`registerPurpose` is available for later consumers. Voice turn-end, voice relevance and
approval triage require their own RFC amendments.

| Question kind | Input and normalized answer |
|---|---|
| `yes-no` | Question id and instructions, with optional yes/no criteria. Returns `p`, the probability of yes. |
| `choice` | Two to 255 option ids with optional descriptions. Returns the chosen id and a probability per option. |
| `multi-select` | One to 64 option ids with optional descriptions. Expands to an independent yes/no question per option in the same batch, then returns an id-to-probability map. |
| `score` | Two to ten ordered rubric levels. Returns a bounded numeric score and a probability per level. The codec accounts for the endpoint's score semantics. |

Every question carries an id and instructions. Every answer repeats its id and kind.
Choice and score can carry provider confidence separately from probabilities. A request has
`{ purpose, rubricVersion, state, questions, deadlineMs, signal?, subject? }`. State is text,
a JSON object or a JSON array. Change the rubric version when the question instructions
change. `subject: { book, ref }` is a local ledger reference. The deadline covers credential
lookup, queueing, calls and retry delays, and accepts 50–30,000 ms.

- `register(provider)` and `registerPurpose(spec)` return disposers.
  `listProviders()`, `snapshot()` and `follow(signal)` expose catalog, readiness and
  health. `configure(patch)` saves the live `decisions` profile selection, provider
  configuration and per-purpose settings. `settings(purpose)` reads the resolved settings.
- `decide(request)` and `test(selection?, signal?)` return a discriminated outcome.
  Both outcomes carry `decisionId`, `latencyMs` and `attempts`. `ok` carries the provider
  id, protocol, requested and answered model, typed answers, calibration flag, optional
  usage and possible truncation. `unavailable` carries a reason and optional provider,
  model, HTTP status and retry timing. A malformed service request raises a validation
  error before ledger or network activity. Provider errors return an unavailable outcome
  without raw response bodies.
- `recordExposure(decisionId, { questionId, option })` appends a confirmed router start
  for a scored recipient. `label(decisionId, label: DecisionLabel)` appends a typed label.
  `evaluation(purpose, { sinceMs }?)` returns decision counts, failure reasons, latency,
  label coverage and the cohort statistics below.

The owner explicitly selects one provider and one model in **Settings → Decisions**.
**None** is the initial selection. The catalog's presets describe protocol, endpoint,
credential reference, model hints, limits and privacy. Merely registering one sends
nothing. The group switch independently authorizes routing for that group. Settings also
show key state, test the chosen configuration with synthetic text, and edit purpose
thresholds. Changing who receives routing data requires an explicit owner selection.
The selection identifies the recipient and the applicable terms. If terms are unknown
or unverified, the owner acknowledges that before confirming the selection.

There is no fallback provider, model, word matcher or shadow request. A missing selection,
unregistered provider, missing model or missing or rejected key stops before a request.
The service retries only 429 or 529 on the same provider and model, at most three total
attempts within the original deadline. It honors `Retry-After` when enough time remains,
and otherwise uses jittered backoff when the header is absent. Each provider has an
eight-call concurrency cap, a breaker that opens after five consecutive counted failures,
a 30-second cooldown and a single half-open probe. Auth failures mark the credential
rejected until the credential changes and leave the breaker alone. Cancellation, timeout,
busy, quota, refusal and malformed answers are distinct outcomes. A repeated identical
request is evaluated again. Caching and in-flight deduplication are deferred.

### Provider catalog and codecs

These are proposed presets. Model ids are examples of supported selections. The endpoint
references document wire compatibility. Delivery must establish the applicable model's
limits with fixtures and distinguish inferred limits from documented ones.

| Preset id | Protocol | Endpoint and model | DSH credential reference |
|---|---|---|---|
| `typesafe-jev` | System One | `https://api.typesafe.ai/v1/systemone`, e.g. `jev-latest`. Pin a version to evaluate thresholds against a stable model. [TypeSafe API](https://docs.typesafe.ai/api/system-one) | `TYPESAFE_API_KEY` (Bearer) |
| `openrouter-s1` | System One | `https://openrouter.ai/api/v1/systemone`, e.g. `typesafe/jev-1.14`. [OpenRouter System One schema](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request.md) | `OPENROUTER_API_KEY` (Bearer) |
| `celeris-s1` | System One | `https://inference.celeris.ai/celeris-1-decision/v1/systemone`, `celeris-1.1-decision`. [Celeris Decisions](https://docs.celeris.ai/decisions.md) | `CELERIS_API_KEY` (Bearer) |
| `cloudflare-clef` | System One in a Workers AI response envelope | `https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef` or the `clef-flash` model path. The body selects the corresponding `clef` or `clef-flash`. [Clef](https://developers.cloudflare.com/workers-ai/models/clef/), [Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) | `CLOUDFLARE_API_TOKEN` (Bearer). The account id is non-secret configuration. |
| `gemini-decision` | System One question shape, Gemini input | `https://generativelanguage.googleapis.com/v1beta/decisions`, `gemini-decision-1`. [Gemini Decisions API](https://aistudio.google.com/docs/decisions-api.md) | `GEMINI_API_KEY` (`x-goog-api-key`) |
| `openai-luna` | OpenAI Decisions | `https://api.openai.com/v1/decisions`, `gpt-6-luna`. [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) | `OPENAI_API_KEY` (Bearer) |
| `celeris-oai` | OpenAI Decisions | `https://inference.celeris.ai/celeris-1-decision/v1/decisions`, `celeris-1.1-decision`. [Celeris Decisions](https://docs.celeris.ai/decisions.md#openai-decisions-api) | `CELERIS_API_KEY` (Bearer) |
| `llm-structured` | Structured output | One explicitly selected DSH `provider/model` route, available while `ctx.llm` is present. Returns uncalibrated probabilities. | Selected model route's own credential |

- **System One** encodes `{ model, state, questions }` with a keyed question map of
  `noul`, `choice` and `score` questions. The codec matches keyed answers and reads `noul`
  as the yes probability. Gemini uses `input` and the codec accepts its documented
  0.01–0.99 yes/no range. Cloudflare unwraps the REST `result`, handles REST failure and
  reports possible truncation when the request approaches the selected model's context
  limit. The model pages list 65,536 tokens for Clef and 24,576 for Clef-flash.
- **OpenAI Decisions** encodes a named `questions[]` array of `predicate`, `choice` and
  `score` items with choices or levels where appropriate. It matches `answers[]` by name
  and converts probability arrays to keyed maps. OpenAI accepts JSON state as an
  `input_json` part in a user message. The Celeris adapter uses string `input` and
  serializes structured state. Celeris support for `input_json` is unverified.
- **Structured output** uses a dedicated decision request on the selected DSH route, with
  a bounded state and one typed `answer` output. It runs without group relay context
  or ordinary Bot tools. The host validates the result using the same rules.

The codecs require one answer per expanded question, a matching kind, known choices and
complete probability maps. All probabilities must be finite and within the codec's
documented range. Choice and score distributions must sum to one within 0.02. Independent
multi-select probabilities have no sum constraint. A refusal, missing or extra answer,
or invalid probability fails the whole decision. Provider options and returned model or
usage values are normalized before appearing in the UI or ledger.

### Credentials and what leaves the machine

Keys resolve for the selected request through `ctx.credentials`. Only the owner can
set or unset a known writable reference. The settings API returns key state such as
configured, writable, source and masked display. Credential values are write-only at
that boundary and never appear in decision payloads, logs, ledger, errors or UI responses.
The selected provider receives its key in the authentication header. If Decisions and
Models use the same credential reference, Settings names both consumers next to the
shared key and shows that rotation or removal affects both.

Automatic routing sends only the rubric and candidate options, the current group name,
the latest message (up to 4,000 characters), up to eight preceding lines from that
group (up to 400 characters each, with speakers), candidate member cards, and
attachment counts. The Bot host redacts credential-shaped strings across outgoing text
before capping fields. The service caps serialized state at 16,000 characters. Files,
filenames, attachment links and contents, image readings, audio, tool input and output,
other chats, Bot instructions, memory and stored secrets are excluded. Credential
redaction matches known shapes. The remaining free text may still contain sensitive
information.

The outgoing and saved member card uses a closed field list. A non-private Bot supplies
its display name, display title, bare availability (`idle` or `working`), and an optional
public `bot.handles` line written and saved by the owner. `working` means the room's members can
already see the Bot working in a turn in this room or in a thread started here. Work
in the Bot's own chat, another room or team, or a call contributes no availability
signal. If there is no visible work, the value is `idle`. A private Bot supplies its
display name and title only. Q3 proposes a limit of 140 characters and omits blank
handles. Role lists, task and other group names, paths and work updates stay outside
the card. The local book reference and credential reference stay on the host.

| Recipient of routing input | Documented data handling |
|---|---|
| TypeSafe directly | TypeSafe says it does not train Jev on customer inputs or outputs. It offers opt-in zero data retention (ZDR) and publishes no fixed standard retention period. [TypeSafe data handling](https://help.typesafe.ai/articles/5974925716) |
| OpenRouter and TypeSafe upstream | The proposed preset pins the TypeSafe upstream, disables provider fallback with `allow_fallbacks: false`, and requests `zdr: true` and `data_collection: 'deny'` on System One. Delivery verifies the request and verifies that account settings permit only the named, eligible recipient, including exclusion of Safety Retention endpoints. When the restriction cannot be established, the preset stays unavailable. OpenRouter's own logging settings and terms also apply. [System One schema](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request.md), [ZDR and Safety Retention](https://openrouter.ai/docs/guides/features/zdr), [OpenRouter terms](https://openrouter.ai/terms/) |
| Celeris directly, either codec | Celeris documents keeping request and billing metadata and sampling prompts and responses for troubleshooting and model improvement after removing detected personal information. It offers a Console opt-out for sampling. A Decisions-specific retention period and a ZDR guarantee are unknown. [Celeris data handling](https://docs.celeris.ai/security) |
| Cloudflare Workers AI directly | Cloudflare documents ZDR for standard stateless inference and no training on customer content, subject to the documented exceptions and metadata policy. The proposed preset uses Workers AI directly. [Cloudflare data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/) |
| Google Gemini API directly | General Gemini API terms distinguish unpaid and paid use and include regional exceptions. Paid content is excluded from product improvement and may be logged for a limited safety period. Decisions-specific retention and ZDR are unverified. [Gemini API terms](https://aistudio.google.com/docs/terms) |
| OpenAI directly | OpenAI documents ZDR eligibility for Decisions and excludes API content from training by default, with an opt-in to share. Eligibility and active data controls depend on the customer. [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions#data-handling), [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data) |
| Selected DSH model route | The selected route and its intermediaries receive the decision input. Data terms depend on that route. A route is eligible only if it can dispatch to the selected destination without model or provider fallback. |

### Calibration

The local append-only ledger lives at
`<AUTOMAGIK_HOME>/decisions/ledger/<YYYY-MM>.jsonl`. Versioned decision records store ids,
timestamps, provider and model, rubric version, sizes, a SHA-256 digest of the capped
request, normalized scores, latency, attempts and failure codes. Label and exposure
records link a decision and question to an option where applicable. Raw state,
instructions, message excerpts, keys and provider bodies stay out of the ledger. The
90-day retention policy drops a monthly file when all its records are past retention.
Pruning runs at startup and daily. Group-book route cards are separate local UI records.

`DecisionLabel` combines `{ questionId, option? }` with one of these typed variants.
The service rejects any other combination and the host checks who supplied the label.

| `source` | `value` | `strength` | Admission |
|---|---|---|---|
| `overturn` | `true` | `hard` | Owner-authorized correction with a score for the member. |
| `user` | `true` or `false` | `hard` | Reserved for an explicit RFC-approved human action. This proposal defers that action and its write route. |
| `answered` | `true` | `soft` | Bot answer from a confirmed scored router start. |
| `passed` | `false` | `soft` | Bot pass from a confirmed scored router start. |

Scored exposure requires the router to actually start a recipient with a recorded score.
A planned call, an explicit mention and a call started by an overturn contribute no
router exposure. Unscored corrections still carry out the routing action and stay
outside calibration. Silence, passes and someone else's overturn supply no human negative.

Evaluation joins scores, labels and confirmed exposures on the decision, question and
option ids. Count each key once per population using its latest valid label. Partition
by purpose, provider, answered model and rubric version. Human coverage is the number
of scored options with explicit human judgments divided by all scored options. Behavior
coverage is the number of exposed options with an answer or pass divided by all scored
options the router actually started. Report both denominators, distinct decisions with
human judgments, distinct exposed decisions, distinct decisions with observations,
unlabeled counts, decision failures and p50/p95 latency. Missing,
expired and unscored records contribute no inferred judgments. The synthetic Settings
test is excluded from routing evaluation.

Reliability bins and Brier use only scored human judgments from a cohort with both
human signs. Until both signs exist, report counts and coverage. Suggest τ and its F1
only when that same cohort meets the documented sample sufficiency criteria for
**both** signs. Since the current user action supplies only positives, it cannot produce
a suggestion by itself. The owner edits settings manually to change a threshold.

## Teams and positions

A team is a named set of Bots. RFC 0050 owns the `state.teams` record and validation,
including stable `t-<uuid>` ids, the
40-character name limit, handle rules and the 2,000-character notice limit. A missing
teams record reads as empty. A group can optionally belong to a team through
`room.teamId`. A named leader must be a current member. When that member is removed
from the team or the Bot is deleted, the same state update clears `leaderId` to null
unless it appoints another eligible member. Null resolves to the current chief of staff.
Leadership is a position with powers independent of attached product roles and group
administration.

Saved posts retain team ids. The host, mention picker and rendered bubble use the same
mention parser, which preserves code, links and references as literal text.
`@team` in a group reaches the named leader, or the chief if the team has no named
leader, only when that Bot is a member of the group. Otherwise the team mention calls
nobody and posts one notice. Other valid mentions in the same message are handled normally.

The owner and chief can create or delete a team and change its name, handle or leader.
The chief or current leader can maintain the team's membership, notice, goal and memory.
Members can read the goal and team memory. A chief or the relevant leader can create a
team-owned group. Settings → Teams and the sidebar's Teams block expose teams, leaders,
membership, groups, goals and memory. The owner uses the protected Settings routes.
Bots exercise their powers through the host tools and current position checks.

A leader assigns and follows up through `@name` and `message_bot`. Anyone who can send a
team mention can ask the leader to take the assignment. A leader can use `stop_bot` for
**any work of a current member of any team they lead**, including work for another team
when the Bot is a member of both. The host checks current leadership and membership at
each action. A former leader or a leader whose target left the team loses that grant
immediately, unless another current team relationship independently grants it.
Read access is checked independently for every affected Session. If any stopped work
is outside the leader's read scope, return only **Stopped N items of {name}**. Titles,
ids, room names, transcripts and follow-up replies from unreadable work stay outside
the result and follow-up path. Apply the same read checks to errors and asynchronous
acknowledgments. The stopped work's own place and the member receive a notice naming
who stopped it. `list_threads` follows RFC 0051's read scope and omits work the leader
cannot read.

| Host tool | Input and effect |
|---|---|
| `create_team` | `{ name, handle?, leader?, members?, notice? }` creates a team under the chief's authority. |
| `update_team` | `{ team, name?, handle?, leader?, add_members?, remove_members?, notice? }` resolves the target by id, name or handle and checks authority for each field. |
| `delete_team` | `{ team }` resolves the target under the chief's authority. Groups keep their history, `room.teamId` clears, and team memory is archived. |
| `create_group` | The existing input gains optional `team` for the chief or that team's leader. |
| `group_goal` | `{ group?, team?, action, … }` requires exactly one target. Team goals reuse the existing goal ledger and archive. |
| `remember` | Adds scope `team:<handle>`, resolving to `{ kind: 'teamOf', teamId }` and `teams/<safeId>` under the memory root. The instance `team` scope and folder stay available. |

## Contracts introduced

The host derives authority from the caller. The Decisions settings endpoints are
owner-scoped. Configuration changes, writes, tests and evaluation requests are refused
for read-only callers. Route card reads respect room access. Overturns are owner-only.

| Channel route or view | Input and result |
|---|---|
| `decisions-catalog` | Reads `{ snapshot, shared }`. The snapshot has provider and key metadata, selection, purpose settings, health and readiness. |
| `decisions-configure` | `{ providerId?, model?, providerConfig?, purposes? }` → `{ snapshot }`. A null selection clears it. |
| `decisions-key` | `{ ref, value? }` → `{ key }` metadata. Omitted `value` unsets the reference. |
| `decisions-test` | `{ providerId?, model? }` → typed outcome for the canned test. Explicit selection is required. |
| `decisions-eval` | `{ purpose, sinceMs? }` → the purpose's evaluation with cohort coverage and optional suggestion. |
| `update-room` | Extends the room update with `{ id, route?: boolean, teamId?: string \| null }`. The owner sets routing and room ownership through Settings. |
| `route-card` | `{ roomId, routeId }` → authorized route detail and member slot status. |
| `route-overturn` | `{ roomId, routeId, botId }` → confirmation after the user action is admitted and queued. |
| Live `routes` | Per room, compact marks keyed by message sequence and mapped from DSH message ids. Keeps the last 50 marks per room and fetches card detail on demand. |
| `create-team`, `update-team`, `delete-team` | Owner Settings writes. Create takes `{ name, handle?, leader?, members?, notice? }`, update takes `{ id, ...patch }`, and delete takes `{ id }`. The roster's `teams` view supplies team records with leader and member names and group ids. |

## Open questions

Status stays Proposed pending owner acceptance. Fable concurred on the named-only Bot
post rule, shared credential notice, owner-saved handles, `sure` and the τ₀ mark.
The remaining numeric defaults and the feedback and team authority choices below
await rulings.

1. **Q1. Which members can a Bot's ordinary post call in a routed group?** Recommend
   named recipients only. Without a named recipient the post calls nobody.
2. **Q2. Should Decisions reuse the credential reference already used in Models?**
   Recommend reusing the same reference where it matches, with a visible **Shared with
   Models** note naming Models and Decisions. Setting, rotating or removing it affects both.
3. **Q3. How should the member card describe what a Bot handles?** Recommend a public,
   owner-saved, optional one-line `handles` field of at most 140 characters. Omit the
   line when the user leaves the field empty. A Bot write needs a separate authorization
   decision and has no route in this proposal.
4. **Q4. What numeric purpose defaults should Settings offer?** Recommend the values in
   the table below as review inputs. Fable concurred on `sure = 0.8` for avatar opacity.
   The other values await rulings. Test fixtures carry their own values.
5. **Q5. What should τ₀ mean when nobody is called?** Recommend solid `◌` when every
   score is below τ₀, and faded `◌` when at least one is in [τ₀, τ). Both mean no
   member was called and neither changes selection.

| Purpose | Proposed `tau` | Proposed `k` | Proposed `tau0` | Proposed `deadlineMs` | Proposed `sure` |
|---|---:|---:|---:|---:|---:|
| `group-routing` | 0.5 | 3 | 0.2 | 2500 | 0.8 |
| `settings-test` | 0.5 | 1 | 0.2 | 5000 | 0.8 |

- **Negative human feedback.** Recommend deferring a negative-label action and
  its write authority. `route-overturn` supplies the positive path for a scored member.
  Calibration may report coverage while the cohort lacks qualifying judgments of both signs.
- **Group deletion (RFC 0050 Q3).** Should the responsible group member be allowed
  to delete their group, or should deletion be reserved for the owner, chief and
  relevant leader? Recommend allowing the responsible member, as RFC 0050 proposes.
  Keep current group deletion admission until the question is resolved. Team deletion
  keeps its groups and confers no separate group deletion authority.
- **Private team members (RFC 0050 Q4).** Recommend excluding private Bots from both
  team membership and leadership. Supporting them would require deciding who can see
  membership and when a team mention can reach them. Resolve this before team admission ships.

## Proposed deliveries and acceptance

Owner acceptance gates implementation. After acceptance, author deliveries 1–3 in
isolated worktrees while the prerequisite RFCs advance. Contracts and ledger feed the service.
Adapters can use the reviewed service interface before its integration. Sequence the
two desktop install-field changes in delivery order and keep any earlier merge inert.
Integrate Settings and the shared host and client changes in deliveries 4–9 on the
merged RFC 0050–0052 bases, with voice delivery clear. The voice dependency is shared
files and bundles. Team deliveries depend on RFC 0050's chief, positions and
`state.teams`. Keep user-visible releases in prerequisite order and hold routing behind
its per-group switch throughout. Run the integrated lane gates and installed acceptance
checks on the combined head. DSH profile and package install changes use the desktop
lane. The remaining implementation uses the plugin lane.

| Delivery and lane | Acceptance | Rollback |
|---|---|---|
| 1. Decision contracts, purposes and ledger · plugin | Fixtures prove state and keys stay out of ledger rows, expired months are pruned, and invalid labels fail admission. Verify exact denominators, latest valid labels, scored starts and unscored corrections. One-class samples show coverage only. Sufficient two-class human fixtures show metrics and a suggestion for that cohort without applying it. | Stop ledger writes. Saved local rows remain subject to the retention policy when the service next runs. |
| 2. Decisions service and profile wiring · desktop | Fake providers prove that unset, failing and disposed selections never send to a second provider, that identical requests call twice, and that queueing, retries, cancellation and the breaker observe the service limits. | Remove the service profile entry and stop new decisions. Prior network requests have already crossed the boundary. |
| 3. Provider adapters and profile wiring · desktop | Each codec encodes and decodes first-party fixtures and rejects refusals, wrong kinds, missing or extra answers and invalid probabilities. Check Gemini's range, Cloudflare truncation, fixed recipients, credential headers and absence of credentials in errors. | Remove the adapter entry. Registered selections become unavailable and previous provider requests remain subject to their terms. |
| 4. Decisions settings · plugin | Prove explicit selection, acknowledgment of unknown terms, owner-only writes, write-only keys, synthetic test and per-purpose settings. Check that an evaluation result cannot apply its suggestion. | Remove the Settings surface. The saved choice and credentials can be managed before rollback. |
| 5. Routing host · plugin | Test owner opt-in, zero decisions for explicit mentions, one decision for eligible plain messages, and no wake on failure, no match, opt-out or membership removal. Test the serialized card allowlist and show that visible room work changes availability while hidden threads, other rooms and calls cannot. Prove route events stay out of Bot context and only scored router starts admit behavioral labels. | Disable routing per group or revert dispatch to the room's existing mode. Posted chat history and past requests persist. |
| 6. Routing marks, card and group switch · plugin | Verify main and mid-round views, slot ticks, view-only cards and a scored overturn that calls a current member and records a positive human judgment. An unscored correction calls the member without adding a calibration sample. Check zh and pt-BR strings and rebuilt bundles. | Turn off routing before reverting the Settings and marks UI. Stored route records and calls already made persist. |
| 7. Team state, tools, goals and memory · plugin | In `team-powers`, stop a dual member's other-team work and check the count-only result, follow-up read scope and notices. Verify `list_threads` hides the unreadable work. Repeat after member removal, leader replacement and deletion, with and without an independent grant. Verify chief resolution, the approved group-delete and private-Bot rules, and team deletion preserving groups while clearing ownership and archiving memory. | Remove team tool grants. Saved team goals, memory and group history remain on disk. |
| 8. Team mentions · plugin | Verify leader and chief resolution, an unreachable leader, handle collisions, stored team ids, and agreement between the host and the client. | Remove team mention dispatch. Saved posts remain readable. |
| 9. Teams settings and sidebar · plugin | Verify the owner can manage teams, attach groups and reach the team goal and memory from Settings. Check the sidebar, zh and pt-BR strings and rebuilt bundles. | Remove the Teams UI. The host retains team records and their access rules. |
