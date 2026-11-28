# RFC 0050: Teams, positions and roles

| Field | Value |
|---|---|
| Status | Accepted (2026-11-28, by the owner's delegate, effective on merge) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none for this RFC (docs only). W1 plugin (3.N.P), desktop (3.N) for Solver packaging and release tooling |
| Created | 2026-11-27 |

## Summary

Give each instance one chief of staff. A team may appoint its own leader, and a group chat can belong to a
team or stand on its own. A Bot gains abilities by stacking roles. Its owner controls Terminal, Files and
Computer use independently of those roles.

## Motivation and scope

The Main Bot currently combines instance administration, the landing chat, task admission and Omni operation.
Crew kinds tie abilities to Bot records. Solver adds a separate creation flow and review machinery. W1
replaces these paths with positions, a role registry and per-Bot controls while preserving existing
conversations, memory and permission boundaries.

W1 delivers the chief, stackable roles, the switches and Solver retirement. W2 adds visible work threads and
Orchestrator tools. W3 delivers the registry Voice provider and call engine. W4 adds team management, routing
and calibration. Community role isolation stays with [RFC 0037
P5](0037-roles-not-types.md#p5---the-stranger-gate).

### Decision record

The IDs below refer to decisions informing the proposal. The positions and delivery sequence below carry their
final form.

| Decision | Direction |
|---|---|
| R17-1, R17-2, R17-3, R17-4 | The Orchestrator keeps its base tools. Give team leadership an explicit position and assign computer access per Bot. A named leader is optional, with the chief taking the lead by default. |
| R19-1, R19-2 | The Bot wearing the crown acts for the instance. Team leaders act for assembled teams. The later R35-3 settles how existing Mains upgrade. |
| R21-1, R21-2, R21-3, R21-4 | Settings control access per Bot. Keep teams, conversations and routing in one design. A decision model selects who a plain group message concerns, and explicit mentions route directly. |
| R23-1, R23-2, R23-3 | Decisions use the message, recent group lines and member cards. A message can remain posted without waking anyone. Any admitted participant can create a group chat. |
| R25-1, R25-2, R25-3, R25-4 | Show delegated work under its originating message and in the sidebar. Teams are named sets of members with leadership. Call the shared conversation a “group chat”. Design for people now and deliver their admission with Cloud. |
| R27-1, R27-2, R27-3, R27-4 | Use “chief of staff” for the instance position, with hire, fire, formation and broad read powers. Team leaders assign, follow up and manage goals and memory. Routing uses a provider-neutral decision service. |
| R29-1, R29-2, R29-3 | Assign chief and leader as positions. Surface Bot-to-Bot exchanges as threads. Orchestrator, Genie, Omni and Voice are the four core roles. |
| R31-1, R31-2, R31-3 | Give one Bot at a time a durable voice. The Orchestrator leads the conversation and delegates the work to a fitting member in a thread. |
| R33-1, R33-2, R33-3, R33-4 | Keep durable voice context per Bot and pass handoffs to the Bot. Decision providers are selected explicitly, with no preset or fallback. Routing takes effect on enable and leaves inspectable marks. |
| R35-1, R35-2, R35-3, R35-4 | Use marks with member avatars and enable routing per group, off by default. The first live Main becomes chief. Other Mains carry abilities through roles. Teamless groups remain valid. |
| R37-1, R37-2 | Record the model and sequence delivery as roles, threads, voice, then decisions and teams. |
| R1-1, R1-2, R1-3, R1-4 | Use one registry for first-party and plugin roles. Name the three Bot switches separately and preserve scheduling and task admission as described below. Deliver calibration with W4 under RFC 0053. A team leader can stop any work of a member. |

## Positions

**Chief of staff.** The owner assigns one Bot. The crown and landing chat follow that Bot. Only the owner and
chief may hire or fire Bots, change another Bot's team-managed configuration, read every group and, in W2,
every thread subject to caller access, and write instance memory. Team formation arrives in W4. The chief
cannot be made private or deleted while holding the position. Assigning another Bot transfers the position in
one write and refreshes access. The owner's settings control role attachments and access switches
independently. The first eligible Bot in an empty team becomes chief in the same durable write that creates
it. A private Bot cannot take the position, and an active chief can be removed only by a valid replacement. A
null chief represents an empty or pre-bootstrap record. A missing chief on an existing migrated roster is an
authority fault, not a bootstrap request.

**Compatibility authority.** Group 2 publishes the chief readers and state while the old host callers still
apply legacy admission. Group 3 moves the instance authority checks together to `rt.isChief` backed by
committed `chiefId`. This covers the chief prompt, hiring and firing, cross-Bot updates and capabilities,
broad group reads and posting, stopping Bots, instance memory and chief-only private-Bot operations. Existing
responsible-member and caller-limited paths keep their own checks. After this cutover, handing over the
position immediately removes the previous chief's chief-only powers. Secondary former Mains lose those powers
at cutover even if a shipped plugin still sees them in the mirror. They retain only independent explicit role
grants and any proven unnamed task authority migrated to Orchestrator. Group 3 shows an upgrade notice naming
the current chief and each affected former Main in the release that changes the powers. `rt.isMain`,
`mainBotIds` and the old rules hook are compatibility inputs for shipped consumers, including old Omni. They
do not authorize instance actions after Group 3.

**Team leader (W4).** The owner or chief may appoint a team member. If no leader is named, the chief leads the
team. A leader may assign and follow up on work, manage the team's membership, notice, goal and memory, and
read and manage its groups. A leader may stop **any work of a member**, including work outside that team's
groups. The host checks current membership and caller authority. Leadership grants no access to an unrelated
group's transcript or tools. A private Bot cannot become a leader or team member, and an assigned leader or
member cannot become private until explicitly removed from every applicable team. Refuse the incompatible
change without silently removing membership or transferring leadership.

## Teams and group chats

W1 reserves an empty `state.teams` and read helpers. W4 fills it through `create_team`, `update_team` and
`delete_team`. A team record holds `id`, `name`, `handle`, `leaderId`, `members`, optional `notice` and
`goal`, and `createdAt` and `createdBy`. Use a stable `t-<uuid>` ID. Names use the existing Bot name rules and
are at most 40 characters. Handles match `^[a-z0-9][a-z0-9-]{0,30}$` and are unique across teams, Bot names
and reserved mentions or sender names. Notices are at most 2,000 characters. The named leader must be a
member, and members must be live principals. A Bot can belong to several teams.

`@team` resolves to the leader, or the chief when there is no named leader. In a group chat, it wakes that Bot
only if it is a member of the chat. Otherwise the message stays posted with an explanation. The chief forms or
deletes teams and controls their identity and leader. The leader and chief manage team memory under `<memory
root>/teams/<safeId(teamId)>/`; members can read it. The existing instance-memory directory and the stored
scope `team` keep their meaning. `group_goal` uses the existing goal ledger and takes either one team or one
group. Deleting a team clears its groups' `room.teamId` and archives team memory, keeping the groups and their
history.

Any Bot or admitted person may create a group chat within the caller's existing authority. `room.admin`
remains the stored field for its **responsible member**. The responsible member manages the group and can
delete it after explicit confirmation. The chief, owner and responsible member may act subject to their
existing caller checks. In W4 the relevant leader also has the team-owned group path. Ordinary group
membership does not confer deletion authority. The chief can post into any group, and a leader can post into a
group of the team they lead, with or without group membership. The chief or relevant leader may associate a
group with a team through `room.teamId`. Group membership is explicit. Existing groups keep their members and
admin and remain teamless on upgrade. W4 owns routed rounds and decision marks.

## Roles

The host uses `rt.hooks.role(def)` and the client uses `omni.roles.register(def)`. Definitions come from
bots-dsh, official-lane plugins or the existing signed role catalog. One registry resolves all three sources.
Built-in and plugin roles attach without a package install. Package roles retain their existing signature, pin
and trust rules. The host displays an attachment whose provider is missing and withholds its tools and grants
until it resolves.

A Bot stores an ordered `bot.roles[]` of `{ id, version, attachedAt, grants, source? }`. Each active
attachment contributes one prompt part in attachment order, its own settings and UI, and its tools. The tool
set is a union. If two attachments would export the same tool name, refuse the new attachment with the name
and the role that owns it, leaving the Bot unchanged. An identical attach is idempotent. Grants are per
attachment and count only when a current provider declares the capability. Grant and settings writes target
the role ID and current attachment identity. Detach by role ID affects only that attachment. The old
omitted-ID route retains its package-first behavior. Stacking reads existing pins in place and appends new
pins. It preserves their order, including when legacy kinds convert. The registry imposes neither a numeric
cap nor a manifest `conflicts` field.

`hasRole` queries effective membership. The host masks role-owned tools unless the speaking Bot has the role
and applies ordinary permission and tool guards on execution. `prefs.roles` keeps its existing catalog
behavior, including for W1's Voice / Mouth pin. It cannot disable a position or an active registered core
role. A role can add its own abilities and cannot write another role's grants, a position, a Bot's switches,
model, permission, folder, look, channels or memory.

| Core role | Contract |
|---|---|
| Orchestrator | bots-dsh registers `orchestrator` with `task-start`, `route-policy` and an empty tool list in W1. Its prompt leads the conversation, assigns work to a fitting member or helper, follows up, checks results and reports. The W1 prompt uses the existing `start_task` and result callback. Group 6 registers the provider while legacy admission still works. Group 6B switches to committed `task-start` grants after conversion, with `route-policy` also required for a named model. Existing task, shell and caller checks still apply. W2 adds `delegate`, thread tools and their prompt. |
| Omni | Omni's plugins provide Omni channel tools, subscriptions and canvas access through the role. On the certified path, `hasRole` replaces Main or crew-kind tests. The holder follows the owner's switches. On a new link, show all three switches for the selected Bot, with Terminal and Files initially off. Attach Omni and apply the selected settings only when the owner confirms. Cancelling preserves its existing settings. Preserve other Bots' roles and settings, including the chief's. Channel grants still require their own admission. |
| Genie | Genie's official plugin provides `grant_wish`, wish rows and role rules. Wishes, Sessions and stored looks stay with the Bot. Keep the old Genie exclusivity check only for the legacy carrier while compatibility is needed. An explicit legacy detach stays detached when the provider registers. |
| Voice | W1 keeps the existing `voice-mouth` package pins, `speak`, settings and grants functional, including beside new attachments. W3 supplies the registry Voice implementation and upgrades each pin with owner consent, preserving the public `voice-mouth` ID. When `prefs.roles` is false, the existing catalog pin remains inert and the conversion refuses until the owner enables catalog roles. A registered Voice attachment uses its own `call-engine` grant for calls. An existing `audio-out` grant does not grant `call-engine`. The proof of all four real providers on one Bot belongs to W3. |

## Per-Bot switches and scheduling

| Setting | Stored field and effect |
|---|---|
| **Terminal** | `bot.shell`. Default on. Turning it off removes shell access and shell launchers. |
| **Files** | `bot.files`. Default on. Turning it off removes file reads, writes, edits and searches, including image reads. `bot.filesMirror` records only the file-tool names added to `denyTools` for an older reader. Turning Files on removes only those additions. |
| **Computer use** | `bot.computer.level` and allowed apps in `bot.computer.apps`. Levels are off (default), view, background and foreground. Controls refer to operating apps on screen. |
| **Denied tools** | `bot.denyTools`, the advanced list beside the switches, folder and permission level. Preserve the owner's existing denies. |

Only the owner may change these settings through `update-bot` with `{ id, switches: { terminal?, files?,
computerUse? }, apps? }`. The host validates the patch and refuses Bot and plugin writes. A migration may
write these settings only to carry forward the Bot's prior effective restrictions. Restrictions apply in the
Bot's own chat, group Sessions, tasks, automation and verified subagent children. On models where native tools
can be switched, role holders follow these controls and the existing ACP eligibility checks. `managed` remains
for Unfold and pre-migration kinds. The host keeps the existing restrictions for shared contexts where
applicable and refuses any switch claim it cannot enforce on a route. While an old linked Omni provider still
strips tools, show the effective restriction and refuse any enabling update that provider would override.

For Bot Sessions governed by the Bot team, setting all three switches on does not grant a fresh schedule
target. The host resolves the effective target on both `schedule_create` and `schedule_edit`, including an
omitted target or a partial edit to an existing schedule. The available target is `this_session` in verified
lineage, including a group, task, automation or verified subagent Session. Refuse `new` and `new_once`. A Bot
with a switch off or custom denials keeps the schedule tools, subject to the owner’s explicit tool denials and
existing caller limits. Sessions of a native DSH Bot (`kind: "dsh"`) retain the existing exception and tool policy. A fresh
Session cannot be assumed to inherit the Bot's complete sandbox. Use this policy for admission and delivery,
including load, reassignment and restart, before revoking or pausing any Bot's armed entries with an unsafe
target. Keep their records and the unsafe-delivery hold. Unknown, conflicting or cross-Bot lineage fails
closed. A refusal should say which target remains available.

## Contracts and upgrades

### Positions, compatibility reads and writes

The positions fields extend the team record. `chiefId: string | null` names the position and `positions` is absent or
0 before conversion, 1 during compatibility and 2 after separate cleanup. `positionsFrom` records the original
live Main ordering, kinds by Bot ID, migration timestamp and the exact source backup digest. Write it once as
immutable diagnostic evidence. Recovery uses the backup bytes. Keep the chief and the chief-first `mainBotIds`
mirror in one durable write. Retain current live legacy membership without rebuilding it from `positionsFrom`,
so an explicit secondary demotion survives reload. The compatibility `rt.isMain` reads that mirror. Keep
`mainRules` and the Omni/Genie kind reads through W1 and the installed plugin transition.

`set-chief { id }` and MCP `set_chief { id }` are owner-only. Notify existing access listeners after
persisting a change. `set-main` and MCP `set_main` continue to accept `{ id, main, primary, replace }`:

| Legacy request | Result |
|---|---|
| `main: true, primary: true` or replacing the active chief | Transfer the position and update the mirror atomically. A replacement names a live current mirror entry. |
| `main: true`, with neither primary nor replacement | Keep or add compatibility membership only, subject to the old-provider check. Grant no position, role or capability. Empty-team bootstrap is a separate owner write. |
| Replace a secondary | Update that compatibility slot without transferring the position, subject to the same compatibility check. |
| `main: false` | Remove only a secondary compatibility entry. Refuse removal of the active chief without replacement. An already absent entry is a no-op. |

Private or deleted candidates and Bot-authored changes are refused. A command that would change old Omni
authority must pass the handoff rule below. New and legacy UI payloads expose the chief and compatibility view
separately. `chiefId` and the per-Bot `chief` flag are authoritative for new position UI. `mainBotId` points
to the chief, and `mainBotIds` and legacy membership flags continue to serve their compatibility callers. A
mismatched mirror or missing chief on nonempty migrated state submitted by an old writer preserves the bytes
and holds authority with an owner-visible reason. Do not remigrate from the old mirror. Offer one recovery
action: pick the intended chief again. On that owner write, recheck source generation and compatibility under
the lock and recommit the chief and mirror together through the backup path. Reactivate after durably
committing the repaired authority.

The host publishes `roleRuntimeByRole[botId][roleId]` and `roleProviders` additively. Keep the old
`roleRuntime[botId]` projection through the `positions: 2` transition. It supplies the first valid package
card, with the existing legacy-kind fallback when no such card exists. New clients prefer the per-role view
and can read the old view from an older host. `role-attach`, `role-grant`, `role-settings` and
`role-settings-set` keep their payloads. `role-detach { id, role? }` adds an optional selector.

In the separate cleanup both home-registry readers project `main` from the chief, using `mainBotIds` only for
legacy input without `chiefId`. An explicit null chief does not use that fallback. `identity` uses stored
`kind` first, then Genie or Omni attachment metadata when that migrated kind has gone. Repo main and Herdr
seat `kind: "main"` retain their meanings.

### Durable migration and recovery

- **Backup before writes.** Take an exclusive, private-mode copy of the original encoded `state.json` bytes
  under the store write lock before the first stacked write, position migration or staged Solver write. Take a
  matching copy again for a later migration write if its source changed. Use
  `state.json.pre-positions-<pluginVersion>` or `state.json.pre-solver-<pluginVersion>` for the corresponding
  migration. Reuse an existing backup only when its bytes match. Preserve a differing file and create a
  digest-qualified copy of the current source. Sync the backup file and parent directory, recheck the lock and
  source generation, then publish state and its marker together through the durable write path. A new unsaved
  team has no source to back up. On a backup or commit failure in Groups 13A or 2, retain the working legacy
  path. From Group 10A on, hold team execution until the durable activation succeeds. A stale or unavailable
  writer cannot publish changed authority. Show the owner the reason for failure or hold and retry on the next
  load under the current writer. A reader with an uncommitted snapshot cannot advertise migrated authority.
- **Positions and restrictions.** Group 12A lands switch and scheduling enforcement before Group 2 writes
  migrated switches. Select the first still-live legacy Main when no chief has been assigned. Add missing
  Orchestrator to eligible former Mains or Omni-kind Bots, Omni to formerly linked operators and Omni-kind
  Bots, and Genie to eligible Genie-kind Bots. Append new pins while preserving existing eligibility,
  settings, grants, order, custom art and detach choices. Give a default-art Genie its stored look. Keep
  `voice-mouth`, its settings and its grants. The scheduler policy is already active when the switch writes
  commit. Apply the same compatibility rules on later writes and on old-client creates after `positions: 1`.
  For a registry create, verify that the provider can serve the effective role before persisting the Bot and
  attachment in one admitted write. Keep the compatible legacy entry and kind fallback for supported older
  providers. A late legacy create follows the same checks and cannot widen authority.
- **Saved Omni linkage.** Determine linked operators from the saved link at load, using the configured
  `omni.url` or profile `omni.json` and the shipped Main/kind selector. The live `omniLinked()` predicate can
  be false before registration. Recheck linkage and the committed generation at first use, and hold affected
  authority when linkage is unknown. Persist Terminal and Files off for previously stripped Bots before
  allowing the provider handoff. Preserve their effective Computer use and native-tools restrictions and all
  other mandatory denials from the installed plugin, including subagent, workflow, job, todo and
  working-directory tools. Check the exact list against the released pair. Retain every owner denial and track
  which file entries the Files mirror adds. If the old deny list cannot represent mandatory entries and the
  Files mirror together, refuse that write with a specific diagnostic. Preserve the existing denies and the
  working compatibility path while it exists. The activation release holds the affected team if it cannot
  commit an enforceable state. An owner retry reads the current saved restrictions and completes only when all
  required entries can be represented. The released legacy Omni strip list can leave image reads visible. W1's
  Files-off setting covers image reads as well and can narrow that access. Owner-written image denials stay in
  force. Show an existing pin whose provider is unavailable as missing and withhold its grants. During
  migration, write a new attachment only when a shipped provider or compatible host adapter can serve it
  under the committed policy. Otherwise retain the compatible legacy entry and recheck on registration.
- **Provider handoff.** New Omni channels and canvas use `rt.omniRolePolicyReady(botId)` to check a compatible
  registered provider and current committed host policy for that Bot. It is independent of role membership and
  false at startup until proven, or after authority is lost. A certified Bot without Omni receives no legacy
  operator fallback. Unavailable authority holds execution. A supported old pair or a pair awaiting
  certification keeps the effective legacy restrictions and per-chat admission. A chief change never attaches
  Omni. While the old linked channels/canvas pair is installed, refuse an authority-changing chief handoff
  through either owner route and refuse a secondary add or replacement that would confer old Omni operator
  authority. A change that preserves the effective operator set can proceed. Known operators keep operating.
  Tell the owner to update Omni or unlink before retrying a refused handoff. Once the compatible provider
  controls admission, the chief and operator selections can change independently. Test both paths with the
  actual pinned channels and canvas pair.
- **Task authority.** Keep legacy unnamed task admission until Group 6B can persist proven effective authority
  and cut over. Preserve existing valid named-model grants and existing withheld decisions. A former Main or
  unlinked Omni Bot gets only `task-start` from legacy status, and only if an unnamed call would have cleared
  the old effective gate. The released host bypasses the role grant check on an unnamed legacy start.
  An ungranted role on a Main can therefore coexist with effective unnamed admission. Preserve that
  role's withheld decision on conversion. In the release where access changes, notify the owner of
  every Bot whose released unnamed admission is withheld, identify `task-start` and link its grant
  control. Existing shell or caller restrictions and the linked provider's refusal still apply. Carry `route-policy` only from a role entry that already grants
  it. Keep the old linked provider's refusal until its certified replacement. Removing the refusal does not
  synthesize or revive a grant. Reconcile Bots created between `positions: 1` and cutover, and revalidate
  current attachments, provenance, permissions and model choices before dispatch. Later reloads cannot
  synthesize or restore legacy grants.
- **Solver stage and activation.** Register Orchestrator before Group 13A scans the raw attachment array,
  before any first-package projection or deduplication. Test Solver at any index and alongside real Voice and
  existing Orchestrator pins. Replace the first Solver slot when creating an Orchestrator. If Orchestrator
  already exists, retain its order, identity, version, settings and other fields, and remove only the Solver
  pins. Preserve unrelated records and their relative order, including malformed entries where the original
  representation permits it. Carry only `task-start` and `route-policy` from a single Solver pin. For several
  Solver pins, or Solver and an existing Orchestrator, grant a capability only if every recorded decision
  grants it. An empty list is a withholding decision. Historical Main authority cannot override an existing
  Orchestrator withholding. A waiting or marker-only record can get an ungranted pin when no Orchestrator
  exists and leaves an independent existing decision in place. Record the pre-merge decisions in the stage for
  exact recovery. The upgrade notice identifies each Bot and capability withheld by the intersection and
  points the owner to the role's grant control. This migration rule is separate from the runtime's union of
  grants across active roles. Recognize exact historical methods. Clear only known generated instructions and
  retired fields, and keep user text, reviewers, works and history. An unmapped permission shape holds for
  diagnosis.
- **Guards and saved work.** Group 13A commits `solverMigrationV1` as a stage while the legacy roles and
  guards remain active. Group 10A recomputes a stale stage under the lock and commits canonical roles and
  `solverRetired: 1` together before it removes live Solver enforcement. On a direct or skipped-version
  upgrade, complete both needed migrations before exposing their authority. This release holds tool, task,
  group, automation, schedule and native execution on uncommitted state, while keeping read-only diagnostics
  available. Recheck on reload, takeover, external replacement and reclaim. Rerunning committed state is
  byte-stable with one Orchestrator and no new grant. Keep session-lineage enforcement as `sessionPolicyOf`,
  the ACP `solverPolicy` identity getter, and the shared chosen-model identity helpers. Preserve delivered
  results and history without replay. Keep undelivered held results and their attachments recoverable in the
  old record. Disable automatic dispatch from the retired path. Resume recovery only through a later explicit
  owner write after verifying the current permissions, originating Session and existing delivery record.
  Preserve a held result when those checks cannot prove a safe destination.
- **Downgrade.** Before enabling the first incompatible write, prove that the old writer refuses it and
  automatic supervisor rollback restores a matching pre-update snapshot. Exercise plain and encrypted
  profiles. An older supported writer may continue using a home only while its format and authority remain
  compatible. Group 3A adds no incompatible state. The old host can recognize one package entry. A stacked Bot may show its package roles as
  missing on that reader and must never be written by it. Before rollout keep the complete isolated pre-W1
  snapshot. Stop both writers, preserve the migrated home and restore a separate copy of the compatible
  snapshot with its matching key store, profile data and add-ons before starting the older host. Restore
  matching migration backups under the state lock for record recovery. `positionsFrom` cannot undo the extra
  Omni denies, switch mirrors, grants, retired Solver fields or later edits. Keep Sessions, memory and wishes
  with the matching profile. Newer writes remain in the preserved migrated home.

## Authority and release order

The host authorizes each request using the actual caller and speaking Bot. Positions, team membership, role
grants and switch restrictions are checked on use. A Bot turn initiated by a restricted caller remains subject
to that caller's intersection even when the Bot holds a position. The chief is owner-only by default, may be
individually allowlisted, and cannot use workspace-wide mode. Cloud adds person principals using the verified
issuer and subject from [RFC 0038](0038-cloud-multiuser-caller-principal.md) and can then admit people as
members or leaders. Self-hosted team membership accepts Bot IDs and refuses person principals until Cloud
admission is delivered under [RFC 0024](0024-automagik-cloud.md).

Every merge must be green and safe to release from `dev` on its named lane. Land affected tests, imports,
locale strings and generated bundles with their change. Keep old entry points and guards until their
replacement is active. Combine dependent edits in the same PR or stage them behind the working path when a
split would make an intermediate ship unsafe. A later tests-only repair or an assumption that no release cuts
between merges cannot satisfy this rule.

### W1 merge and release sequence

Each numbered group below is a separate merge and must pass with its immediate predecessor and the supported
older installations. An additive release keeps existing consumers working. Any group changing a saved record
must prove downgrade using the snapshot recovery above. Keep the migration readers and compatibility aliases
until their separately authorized removal.

| Groups in order | Lane and acceptance |
|---|---|
| **1** | Docs only. This RFC is Accepted when it merges. Implementation starts after that merge. Verify the no-shipping classification for this PR's diff. |
| **3A → 5A → 5B → 6** | Plugin. Land the additive rules hook, host registry with both views, client registry and then Orchestrator provider. Check old/new client and host combinations, per-pin grants and settings, clashes, stock Voice with its actual `speak` and `audio-out`, and old Solver and task admission. |
| **12A → 13A → 2 → 3** | Plugin. First enforce the switches, universal lineage scheduling and native policy under the old guards. Stage Solver conversion with exact backups, then commit positions with the saved-link bridge. Move all chief callers together. Check failed writes, sync, lock loss, stale reads, mixed-role and repeat upgrades, old-Omni tool restrictions, and that former Mains lose chief powers. |
| **4 → 7 → 12B → 8A** | Plugin. Move the UI and onboarding to the chief, expose the effective switches and retire new Solver creation and attachment. Test both legacy and new commands, the crown and landing, the old plugin's enabling refusals, localized labels and the still-active Solver guard and settings. |
| **10A → 8B → 9A → 9B → 10B → 11A → 11B → 13B → 6B** | Plugin. Commit canonical Solver migration before disabling execution guards. Retire remaining Solver UI, then make Solver characters ordinary while preserving existing looks. Remove obsolete notices and guard modules after callers migrate. Preserve model identity and saved results before deleting review-mark and progress code. Remove old writers and then switch task entry points to committed grants. Co-land each change with all former imports, fixtures, locale keys, bundles and surviving safety tests it affects. Reopen saved results and mixed-role profiles without duplicate delivery or new authority. |
| **14** | Full desktop release because the bots-dsh package file list changes. Remove the Solver package and signed catalog entry, keep Voice / Mouth and the empty bundle stamp valid, and prove skipped-version upgrades and installed artifacts. This published W1 host is the downstream floor. |
| **15A → 15 → 16 in Omni, 17 in Genie** | Separate downstream plugin releases, after the published Group 14 receipt. Raise each peer floor to its recorded version. Land Omni's dual-reading canvas before changing channels authorizations, then move the client. Genie can proceed independently from the same host receipt. Use the policy certificate before removing old trims and task refusal. Cover registered, missing, unready and legacy providers, plus the applicable older and new channels/canvas pairs. |
| **18, separate follow-up** | Desktop. After the supported provider floors and an installed upgrade are proven, separately approve cleanup to `positions: 2`. Test both home-registry readers and a backed-up, idempotent upgrade before deleting the mirror, legacy kind projection and migrated Omni/Genie kinds. Preserve the public `set-main` route alias. |

Record the base, candidate and actual lane using the release workflow's tag selection. Require green checks
before each shipping merge and a released artifact receipt before merging a dependent group. For an automatic
cut, record the release run, merge and tag SHA, selected version and lane. Verify the signed plugin manifest,
bots-dsh archive hash and installed version. Group 14 also verifies signed role catalog coverage and desktop
completion. A superseded cut requires a successor receipt containing its merge. A source merge or peer floor
alone does not prove installed compatibility.

Record the desktop release that pins and ships the new Omni provider and test that installed combination,
including channels and canvas. Record the supported Genie add-on release and pin. Replay fresh, direct,
intermediate and preceding supported profile saves in isolation with the actual released provider versions.
Include signed Voice, explicitly detached Genie, linked and unlinked Omni, earlier scheduling rows and
constructed mixed Solver orders and grants. Check migration backup bytes against the input and include the
archived single-role downgrade profile. Keep W1 integrated acceptance pending until these installed
combinations pass. The Omni RFC 0001 amendment travels with Group 15's Omni PR and its RFC gate, replacing
“the Omni Bot's tool set” with “a Bot with the Omni role”.

## Answers (2026-11-28)

The owner's delegate agreed to the following answers, effective with this RFC.

1. Solver-only characters become ordinary characters. Stored avatar selections keep their art.
2. A later Omni link shows Terminal and Files initially off and attaches the role only to the selected
   Bot after the owner confirms the three switches. The chief and other Bots keep their roles.
3. A responsible member can delete a group after explicit confirmation. Ordinary members do not gain deletion
   authority.
4. A private Bot cannot join or lead a team, and a team member or leader cannot become private until the
   conflicting membership is explicitly removed. No automatic removal.
5. W1 keeps existing Voice / Mouth working. W3 owns the consented registry upgrade and installed proof of
   stacking all four real roles. The legacy `set-main` alias stays available. Group 18 remains separately
   authorized work.

The delegate also agreed to the compatibility, grant and recovery conditions above. Before implementation,
record the exact review head and CI outcomes on the RFC PR. Approval of these decisions does not establish
that an implementation, published artifact or provider pairing passed its gate.

## Related RFCs

[Roles and their proposed amendments](0037-roles-not-types.md), [Solver retirement](0048-the-solver.md), [ACP
and native tools](0003-model-routes-and-acp.md), [shared registry](0014-shared-bot-registry.md), [Pocket Bot
management](0036-bot-management-from-pocket.md), [caller principal](0038-cloud-multiuser-caller-principal.md),
[Cloud](0024-automagik-cloud.md), [Pocket group chats](0040-group-chats-in-pocket.md) and [sandboxed
Bots](0044-sandboxed-bots-core-scope.md).
