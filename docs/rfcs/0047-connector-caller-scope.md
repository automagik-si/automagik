# RFC 0047: Connectors follow their caller: a saved key's Bot scope and the per-Bot switch in every Session

| Field | Value |
|---|---|
| Status | Accepted (2026-11-21, by the owner's delegate: Q1-Q7 decided, each the recommended option, see Decided; none merged; #1322) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none for this RFC (docs only). Deliveries: plugin (3.N.P), bots-dsh and its pt-BR strings |
| Created | 2026-11-21 |

> Accepted by the owner's delegate on 2026-11-21 while the owner is away; the owner may amend on
> return.

## Summary

Two promises the Bot team makes about connectors hold for every call, from every kind of Session.
A saved key's "for these Bots" scope decides which Bots and Sessions a connector may use that key
for, including a connector the person added by hand or imported, whose one mount the whole team
shares. A Bot's connector switch, once turned off, keeps that connector away from everything the
Bot runs: its own chat, its group seats, its tasks, the children those start and its scheduled
Sessions. Both are decided in the host when the call runs, from the current saved state, by one
owner resolver, and a call whose caller or state cannot be established is refused.

## Motivation

#1322 (the DS Bot v0.3.6 follow-ups) asks for these two guarantees. Each one spans the Secrets
store, the connector mounts, the tool masks, the scheduler and every window that holds the team,
so this RFC sets one design for both rather than a rule per path, and names the tests that prove
it.

## Design

### One owner for every Session

The host gets one function that answers "on whose behalf does this Session act?" with exactly one
of: a Bot, the person (no Bot), or *ambiguous* with the set of Bots it could be. The connector mask,
connector dispatch, the Mailbox and the scheduler all call it; none keeps its own rule.

- **A Bot's own chat, a group seat, a subscription task:** the Bot the team recorded for it.
- **A task a Bot starts:** the Bot recorded as the task's origin.
- **A child Session:** its parent's owner, followed up the lineage to the first recorded owner. A
  parent that is not loaded is read from its persisted record.
- **A scheduled Session:** the Bot that created the schedule, recorded with the schedule and copied
  onto each delivery's receipt, whatever form the delivery takes (a fresh Session, an existing one,
  a once or a recurring run). A delivery whose owner cannot be singled out keeps its candidate Bots
  on the receipt, so later checks still see them.
- **A Bot-runner turn (RFC 0038):** the Bot the turn runs as.
- **The person:** only a lineage whose every link reads cleanly and reaches no Bot.
- **Ambiguous:** any lineage with a link that cannot be read, or a receipt naming several
  candidates. An ambiguous Session gets a connector only if every candidate may use it.

Any Session kind added later registers its owner with this function; until it does, it resolves
as ambiguous.

### The per-Bot switch at the list and at the call

The switch is applied twice. The tool list a Session sees hides a switched-off connector's tools
(the mask), and every connector call is admitted again when it runs: tools, resource list, read and
template requests, Mailbox reads, sends and attachment downloads. Admission is bound to the provider
the connector's mount registered, never to a server name, so another provider with the same name is
neither blocked nor admitted by it. Reapplying the mask is idempotent and its restrictions are
released with the Session.

### A saved key's scope at a shared mount

A connector is mounted once for the team. Each mount records the saved keys its configuration
references (headers, environment values, sign-in tokens) and the version of each it resolved.

- **Admission.** A call through a mount is admitted only when the caller's owner may use every key
  the mount carries: a key for every Bot, a key whose Bot list names the owner, or a Session-only
  key whose Session is the caller's. An ambiguous owner needs every candidate admitted. A caller
  outside a key's scope does not see the connector's tools and is refused at the call with a note
  that names the key and says the person can widen its scope in Settings.
- **Change.** A mount is superseded the moment a key it carries changes scope, value or provider,
  or is deleted: it takes no further call once it is revoked, and the next call
  remounts from the current keys. Every credential-bearing transport start (first connect,
  reconnect, retry, respawn) resolves keys afresh and is admitted like a call.
- **Vault keys** (RFC 0034) follow the same scope; their own availability checks still apply.

### Keys a connector owns

A key a connector creates for itself (by import, by sign-in or by the add dialog) is recorded as
owned by that connector's instance: an identity minted when the connector is added and never reused.
Ownership is that record, never a matching name or connector id. An owned key with an empty Bot
list serves its own connector's mount and nothing else. The exception ends the first time the person
gives the key a Bot or Session scope, and it does not come back if that list later empties. Removing
the connector removes the keys it owns; an add, import or removal that touches keys is journalled in
the team's home first, so an interrupted one is finished or rolled back by the next writer, and a
retry deletes only the exact key identity it journalled. A connector added later under the same id
is a new instance and owns nothing of the old one's.

An import never selects an existing saved key on its own: a reference in an imported file becomes a
saved key only when the person picks the key and the field in the import preview.

### Fresh state at the call

The switch and the scope are read from the current saved team state and Secrets when a call or a
transport start is admitted, in whichever window holds the call, not from a window's cache. A store
that cannot be read, a team state that disappears after it was seen, or a Secrets file whose last
write left it invalid refuses connector calls until it reads cleanly again; a successful save clears
that refusal.

## Contracts introduced

| Contract | Rule for existing installs |
|---|---|
| A connector's instance identity in its saved record | Minted on first load for connectors that have none. |
| A saved key's owner record (connector id and instance) | New field. A key without one is no connector's own; see Q7 for keys an older import made. |
| The schedule's originating Bot and a receipt's owner or candidates | Written on the next save; a receipt without them resolves as ambiguous. |
| A pending-operation journal for connector key changes, in the team's home | New file; absent means nothing pending. |
| Refusal notes: "outside this key's scope" and "this connector is turned off for this Bot" | New Bot-facing text in English and pt-BR. |

No route, plugin id or storage prefix changes.

## Threat model

- **What is protected.** A saved key reaches a connector's server only on behalf of a Bot or
  Session its scope names. A connector a Bot has switched off serves nothing that Bot runs.
- **Who decides.** Only the person, in Settings: a key's scope, a Bot's switch, an import's mapping.
  No Bot, import file, schedule or older window widens either.
- **How it is enforced.** In the host, at the call and at every transport start, from current saved
  state, through one owner resolver. The tool list is a convenience, not the boundary.
- **Doubt.** An unreadable store, an unresolvable owner or a superseded mount refuses; it never
  falls back to the team's default.
- **Undo.** Widening a key's scope or turning the switch back on takes effect on the next call.
  Reverting the plugin returns the older checks; journalled key changes already finished stay done.

## Deliveries

1. **This RFC.** Docs only. *Check:* its file and its index row. *Rollback:* remove both.
2. **One owner resolver** (plugin). The resolver above, the schedule's originating Bot and receipt
   owners, and the mask using it. *Check:* one table-driven test turns a connector off for Bot A
   and asserts its tools are hidden in A's own chat, a group seat, a subscription task, a task A
   started, a child two levels down with its parent unloaded, a fresh and an existing scheduled
   delivery, a recurring delivery with two candidates, and a Bot-runner turn; Bot B with the switch
   on keeps the tools in each (control); the person's own Session keeps them; repeated mask passes
   and Session teardown leave no restriction behind. *Rollback:* the older per-kind owner lookups.
3. **Admission at the call, from fresh state** (plugin). The switch checked at every connector
   tool, resource request, Mailbox action and transport start, bound to the mount's provider, and
   read from current saved state. *Check:* two runtimes over one team home: the writer turns the
   switch off and the reader's next tool call, resource read, Mailbox read and reconnect are each
   refused; a same-name provider in another scope is unaffected (control); a team state removed
   after load and an invalid Secrets file both refuse, and a later good save admits again.
   *Rollback:* the list-only switch.
4. **Owned keys** (plugin). Instance identity, owner records, the journal, removal of owned keys,
   the import preview's explicit mapping, and the repair action of Q7. *Check:* an owned empty-scope
   key serves its connector; only the key the owner saved for that connector counts; restricting then
   emptying a key's list does not restore the exception; remove then re-add under the same id owns
   nothing old; a failed add and an interrupted removal, each with a restart, end with no stray key
   and the replacement key intact; an import never maps a reference without the person's pick; an
   older import's key is offered the repair and keeps its connector's id and switches.
   *Rollback:* owner records stay in the file and are ignored by the older plugin.
5. **Bot scope at the shared mount** (plugin). Mount key records, admission by scope, supersession
   on change. *Check:* a key for Bot A only: A's call runs and B's is refused with the note; a
   Session-only key admits that Session alone; narrowing the scope or deleting the key mid-turn
   refuses the next call and the next reconnect before the old mount is gone; an owned import still
   works for every Bot; a vault-backed key follows the same scope. *Rollback:* keys are not
   rewritten; the older plugin's admission returns.

Deliveries 2 and 3 cover the switch, 4 and 5 the scope; 4 ships before 5 so no working connector
loses its key at 5's merge.

## Decided (owner's delegate, 2026-11-21)

Each question decided by the owner's delegate, 2026-11-21, recommended option. The owner may amend
on return.

1. **How a shared mount honours a key's scope.** (a) One mount per connector, admitting each call
   against every key it carries; (b) a mount per Bot; (c) refuse any restricted key in a connector.
   **(a)**: one process per connector, as now, and a Bot outside the scope simply cannot call it.
   (b) multiplies processes and sign-ins for no extra guarantee; (c) removes a choice people make.
2. **Which keys a connector may use with an empty Bot list.** (a) Only keys recorded as owned by
   that connector's instance; (b) any key whose name the connector generated; (c) none, all keys
   need a Bot list. **(a)**: a name is not ownership. (c) would make every import ask for a scope.
3. **Where the switch and the scope are enforced.** (a) At the tool list and again at every call
   and transport start; (b) the tool list only; (c) the call only. **(a)**: the call is the
   boundary; the list keeps a Bot from planning with a tool it cannot use.
4. **Owner of a Session.** (a) One lineage-aware resolver used everywhere, with recorded owners for
   tasks and schedules; (b) a check per Session kind. **(a)**: a new kind cannot be forgotten.
5. **An owner that cannot be singled out.** (a) Admit only if every candidate Bot may; (b) admit;
   (c) refuse every connector. **(a)**: never wider than the narrowest candidate, and the person's
   own Sessions are not blocked by a Bot's switch.
6. **State across windows.** (a) Read current saved state at each admission, refuse when unreadable;
   (b) push invalidation between windows; (c) a short cache. **(a)**: the stores already exist and
   are cheap to read; (b) and (c) leave a window between a change and its effect.
7. **Keys an older import created without an owner record.** (a) Not usable by an empty-scope rule;
   Settings offers "Reconnect credential", which makes a fresh owned key and keeps the connector's
   id, switches and read-only mark, or the person gives the key a scope; (b) adopt them by matching
   name. **(a)**, for Decided 2's reason; delivery 4 ships the action before delivery 5 needs it.

## Links

- Issue: #1322; its other items are plain fixes (#2010, #2011, #2017), and #2018 closes it.
- RFCs: [0034](0034-vault-plugin-bitwarden-first.md) (vault-backed keys),
  [0038](0038-cloud-multiuser-caller-principal.md) (Bot-runner turns, the caller principal),
  [0039](0039-person-scoped-approval-grants.md) (owners of tasks, chat parts and group Sessions).
