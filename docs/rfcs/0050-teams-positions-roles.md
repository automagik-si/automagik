# RFC 0050: Teams, positions and roles

| Field | Value |
|---|---|
| Status | Proposed |
| Milestone | none (ships outside the five milestones) |
| Lanes | none for this RFC (docs only). W1 plugin (3.N.P), desktop (3.N) for Solver packaging and release tooling |
| Created | 2026-11-27 |

## Summary

Give each instance one chief of staff. A team may appoint its own leader, and a group chat can belong to a team or stand on its own. A Bot gains abilities by stacking roles. Its owner controls Terminal, Files and Computer use independently of those roles.

## Motivation and scope

The Main Bot currently combines instance administration, the landing chat, task admission and Omni operation. Crew kinds tie abilities to Bot records. Solver adds a separate creation flow and review machinery. W1 replaces these paths with positions, a role registry and per-Bot controls while preserving existing conversations, memory and permission boundaries.

W1 delivers the chief, stackable roles, the switches and Solver retirement. W2 adds visible work threads and Orchestrator tools. W3 delivers the registry Voice provider and call engine. W4 adds team management, routing and calibration. Community role isolation stays with [RFC 0037 P5](0037-roles-not-types.md#p5---the-stranger-gate).

### Decision record

The IDs below refer to decisions informing the proposal. The positions and delivery sequence below carry their final form.

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

**Chief of staff.** The owner assigns one Bot. The crown and landing chat follow that Bot. Only the owner and chief may hire or fire Bots, change another Bot's team-managed configuration, read every group and, in W2, every thread subject to caller access, and write instance memory. Team formation arrives in W4. The chief cannot be made private or deleted while holding the position. Assigning another Bot transfers the position in one write and refreshes access. The owner's settings control role attachments and access switches independently. The first Bot bootstrapped becomes chief.

**Team leader (W4).** The owner or chief may appoint a team member. If no leader is named, the chief leads the team. A leader may assign and follow up on work, manage the team's membership, notice, goal and memory, and read and manage its groups. A leader may stop **any work of a member**, including work outside that team's groups. The host checks current membership and caller authority. Leadership grants no access to an unrelated group's transcript or tools.

## Teams and group chats

W1 reserves an empty `state.teams` and read helpers. W4 fills it through `create_team`, `update_team` and `delete_team`. A team record holds `id`, `name`, `handle`, `leaderId`, `members`, optional `notice` and `goal`, and `createdAt` and `createdBy`. Use a stable `t-<uuid>` ID. Names use the existing Bot name rules and are at most 40 characters. Handles match `^[a-z0-9][a-z0-9-]{0,30}$` and are unique across teams, Bot names and reserved mentions or sender names. Notices are at most 2,000 characters. The named leader must be a member, and members must be live principals. A Bot can belong to several teams.

`@team` resolves to the leader, or the chief when there is no named leader. In a group chat, it wakes that Bot only if it is a member of the chat. Otherwise the message stays posted with an explanation. The chief forms or deletes teams and controls their identity and leader. The leader and chief manage team memory under `<memory root>/teams/<safeId(teamId)>/`; members can read it. The existing instance-memory directory and the stored scope `team` keep their meaning. `group_goal` uses the existing goal ledger and takes either one team or one group. Deleting a team clears its groups' `room.teamId` and archives team memory, keeping the groups and their history.

Any Bot or admitted person may create a group chat within the caller's existing authority. `room.admin` remains the stored field for its **responsible member**. The responsible member manages the group. The chief can post into any group, and a leader can post into a group of the team they lead, with or without group membership. The chief or relevant leader may associate a group with a team through `room.teamId`. Group membership is explicit. Existing groups keep their members and admin and remain teamless on upgrade. W4 owns routed rounds and decision marks.

## Roles

The host uses `rt.hooks.role(def)` and the client uses `omni.roles.register(def)`. Definitions come from bots-dsh, official-lane plugins or the existing signed role catalog. One registry resolves all three sources. Built-in and plugin roles attach without a package install. Package roles retain their existing signature, pin and trust rules. The host displays an attachment whose provider is missing and withholds its tools and grants until it resolves.

A Bot stores an ordered `bot.roles[]` of `{ id, version, attachedAt, grants, source? }`. Each active attachment contributes one prompt part in attachment order, its own settings and UI, and its tools. The tool set is a union. If two attachments would export the same tool name, refuse the new attachment with the name and the role that owns it, leaving the Bot unchanged. An identical attach is idempotent. Grants are per attachment and count only when a current provider declares the capability. Detach by role ID affects only that attachment. Stacking reads existing pins in place. The registry imposes neither a numeric cap nor a manifest `conflicts` field.

`hasRole` queries effective membership. The host masks role-owned tools unless the speaking Bot has the role and applies ordinary permission and tool guards on execution. `prefs.roles` may gate catalog roles but cannot disable a position or any available core role. A role can add its own abilities and cannot write another role's grants, a position, a Bot's switches, model, permission, folder, look, channels or memory.

| Core role | Contract |
|---|---|
| Orchestrator | bots-dsh registers `orchestrator` with `task-start`, `route-policy` and an empty tool list in W1. Its prompt leads the conversation, assigns work to a fitting member or helper, follows up, checks results and reports. Existing `start_task` enforces the grants, including route policy for a named model, under the existing task and shell checks. W2 adds `delegate` and thread tools and moves grant enforcement to that entry point. |
| Omni | Omni's plugins provide Omni channel tools, subscriptions and canvas access through the role. On the new path, `hasRole` replaces Main or crew-kind tests. The holder follows the owner's switches. Linking and channel grants remain separate from role attachment. |
| Genie | Genie's official plugin provides `grant_wish`, wish rows and role rules. Wishes, Sessions and stored looks stay with the Bot. Keep the old Genie exclusivity check only for the legacy carrier while compatibility is needed. |
| Voice | W1 keeps the existing `voice-mouth` package pins, `speak`, settings and grants functional, including beside new attachments. W3 supplies the registry Voice implementation and moves those pins through a compatible upgrade, preserving the public `voice-mouth` ID. Voice declares `call-engine` in addition to its existing `audio-out` path. The proof of all four real providers on one Bot belongs to W3. |

## Per-Bot switches and scheduling

| Setting | Stored field and effect |
|---|---|
| **Terminal** | `bot.shell`. Default on. Turning it off removes shell access and shell launchers. |
| **Files** | `bot.files`. Default on. Turning it off removes file reads, writes, edits and searches, including image reads. `bot.filesMirror` records only the file-tool names added to `denyTools` for an older reader. Turning Files on removes only those additions. |
| **Computer use** | `bot.computer.level` and allowed apps in `bot.computer.apps`. Levels are off (default), view, background and foreground. Controls refer to operating apps on screen. |
| **Denied tools** | `bot.denyTools`, the advanced list beside the switches, folder and permission level. Preserve the owner's existing denies. |

Only the owner may change these settings through `update-bot` with `{ id, switches: { terminal?, files?, computerUse? }, apps? }`. The host validates the patch and refuses Bot and plugin writes. A migration may write these settings only to carry forward the Bot's prior effective restrictions. Restrictions apply in the Bot's own chat, group Sessions, tasks and subagent children. On models where native tools can be switched, role holders follow these controls and the existing ACP eligibility checks. `managed` remains for Unfold and pre-migration kinds. The host keeps the existing restrictions for shared contexts where applicable and refuses any switch claim it cannot enforce on a route.

A switch-off Bot or a Bot with a custom denied-tools list keeps `schedule_create` and `schedule_edit`. It may use `this_session` in any verified Session in its lineage, including a group, task or subagent Session. `new` and `new_once` are refused. A fresh Session cannot be assumed to inherit the Bot's complete sandbox. Revoke or pause already armed fresh deliveries when a restriction takes effect, keep their records and keep the unsafe-delivery hold. Missing lineage fails closed. A refusal should say which target remains available.

## Contracts and upgrades

- **Positions.** Team state keeps its schema version. `chiefId: string | null` is the position. `positions` is absent or 0 before conversion, 1 during compatibility, and 2 after cleanup. `positionsFrom` holds the prior live ordered `mainBotIds`, original kinds by Bot ID and a timestamp. No team is created by migration.
- **Routes and compatibility.** `set-chief { id }` and MCP `set_chief` set the position. `set-main` remains an alias with the existing payload, and the MCP alias `set_main` is deprecated during compatibility. The view's `mainBotId` and per-Bot `main` report the chief. The persisted `mainBotIds` and legacy `rt.isMain` mirror the chief first, then other live former Mains without duplicates. Keep the old rules hook alias and read `kind: 'omni'` and `kind: 'genie'` for one release and through the plugin transition. No new Bot needs these crew kinds.
- **Registry.** At compatibility cleanup both home-registry readers project `main` from `chiefId`, using legacy `mainBotIds` for older data. An explicit null chief is valid. `identity` uses stored `kind` first, then Genie or Omni attachment metadata when the migrated kind has gone. Repo main and Herdr seat `kind: "main"` retain their meanings. `role-detach { id, role? }` adds the role selector to the existing owner route. The view reports `roleRuntime[botId][roleId]` and `roleProviders`.
- **Backup before writes.** The lock holder takes an exclusive copy of the original `state.json` as `state.json.pre-positions-<pluginVersion>` before the first persisted position migration. Reuse an existing backup only if its bytes match. If Solver retirement is a later write, first take a separate exclusive copy of the then-current state. A copy failure or conflicting backup leaves the state and migration marker untouched, warns and retries on a later load. A reader without the write lock cannot persist a migration.
- **Position migration.** Use the first live legacy Main as chief when one has yet to be assigned. Give live former Mains Orchestrator with their legacy task-start and route-policy authority. Give Omni-linked Mains and Omni-kind Bots the Omni role. An unlinked Omni-kind Bot also gets Orchestrator with `task-start` so it can still start tasks. Give Genie-kind Bots Genie and preserve their look. Preserve existing attachments and valid grants. For Bots previously stripped by Omni, set Terminal and Files off and keep the other previously stripped tools denied, including subagent, workflow, job, todo and working-directory tools. Preserve custom denies and keep scheduling within verified lineage. A position migration may record an attachment before a provider loads, using unresolved metadata until the provider registers. Until its provider and equivalent guards are active, retain the applicable legacy behavior and avoid exposing the pin as an active grant.
- **Solver retirement.** Land the Orchestrator provider first. Keep Solver confinement and review guards active for unmigrated records, including on a direct upgrade that skips intermediate releases. Retire those guards for a record only when its backed-up migration commits. Keep legacy task admission where needed until the equivalent grant is active. Scan every attachment, regardless of source or array position. Replace a Solver pin in place with an Orchestrator pin and carry only grants the new provider declares. If Orchestrator already exists, keep its position and metadata, union eligible Solver grants into it and remove only the Solver entries. Multiple Solver pins still produce exactly one Orchestrator. Keep unrelated roles, their relative order, settings and grants. Recognize pending Solver attachments and legacy written Solver methods, clear only known generated instructions and guard fields, and preserve user text, reviewers, work and history. Commit `solverRetired: 1` with the conversion. Remove the dialog, review mark, `solver_progress` and Solver package through the delivery sequence below. Keep session lineage as `sessionPolicyOf`, the `solverPolicy` compatibility getter for ACP identity, and the shared chosen-model identity helper.
- **Rollback.** Restore the matching backup under the state lock for a full record rollback. `positionsFrom` can restore kinds and Main ordering when only position metadata needs reversal. It does not reconstruct retired Solver fields, grants or switch edits. Keep Sessions, memory and wish records in place. A full state restore reverts state edits made after the snapshot, so take an intervening state copy before restoring.

## Authority and release order

The host authorizes each request using the actual caller and speaking Bot. Positions, team membership, role grants and switch restrictions are checked on use. A Bot turn initiated by a restricted caller remains subject to that caller's intersection even when the Bot holds a position. The chief is owner-only by default, may be individually allowlisted, and cannot use workspace-wide mode. Cloud adds person principals using the verified issuer and subject from [RFC 0038](0038-cloud-multiuser-caller-principal.md) and can then admit people as members or leaders. Self-hosted team membership accepts Bot IDs and refuses person principals until Cloud admission is delivered under [RFC 0024](0024-automagik-cloud.md).

Every merge must be green and safe to release from `dev` on its named lane. Land affected tests, imports, locale strings and generated bundles with their change. Keep old entry points and guards until their replacement is active. Combine dependent edits in the same PR or stage them behind the working path when a split would make an intermediate ship unsafe. A later tests-only repair or an assumption that no release cuts between merges cannot satisfy this rule.

| Delivery | Lane, acceptance and rollback |
|---|---|
| 1. Chief and compatibility views | Plugin. Test backup failure and retry, old Main data, one chief, blocked private/delete changes, aliases, access and the crown and landing. Keep legacy behavior where the role or switch path is still pending. Roll back with the mirror or the state backup. |
| 2. Registry and Orchestrator provider | Plugin. Check stacked prompts, tool clashes, isolated grants and settings, a missing provider, and the existing Voice package. Test `start_task` admission with and without grants. Retain legacy admission until the matching migrated attachments can serve it. Roll back to the compatibility path with the pins retained. |
| 3. Switches and Solver migration | Plugin. Check each switch and custom denies across lineage, fresh-target refusal, armed schedule pauses, a backup failure before writes, and ACP identity. Test Solver in a mixed role list with a preceding package, an already attached Orchestrator, legacy pending pins and custom instructions, then reload and rerun with unchanged state and one Orchestrator. Co-land guard retirement with the migration it depends on. Roll back with the matching backup. |
| 4. Solver catalog and packaging | Desktop. After no Bot needs Solver, remove it from the bundle and catalog. Check a direct upgrade from a released state that still pins Solver, the release stamp on an empty bundled-role list, and that the catalog still includes Voice / Mouth. Revert packaging independently of stored-state rollback. Record the released bots-dsh R1 version and SHA before plugins raise their peer floors. |
| 5. Omni and Genie providers | Their respective plugin releases, after bots-dsh R1. Raise each bots-dsh peer floor to the recorded R1 version. Feature-detect `rt.hooks.role` and `rt.hasRole` and test the old path without those APIs. Omni removes plugin-side stripping and task-start refusal on the new path only after host enforcement is effective. Test role attach/detach and legacy behavior in both repos. Roll back through the retained kinds, mirror and old plugin paths. |
| 6. Compatibility cleanup | Later desktop delivery after W1, after Omni and Genie have shipped their role providers and at least one compatible release has been available. Test both home-registry readers on old and new state before removing the `mainBotIds` mirror, legacy role metadata/exclusivity, and migrated Omni/Genie kinds at `positions: 2`. Keep the public `set-main` route alias. Roll back with a compatible reader or saved state. |

The Omni RFC 0001 amendment travels with W1 Group 15's Omni PR and its RFC gate. It replaces “the Omni Bot's tool set” with “a Bot with the Omni role”. W1 Automagik implementation waits for owner acceptance of this proposal. Each implementation PR records its base and passes its affected tests and release-lane checks.

## Open questions

1. **Solver characters.** Make Solver-only characters ordinary, or remove them? **Recommend ordinary.** Existing avatar selections keep their art and new Bots can pick it.
2. **Linking Omni later.** Attach Omni only to the selected Bot, or also attach it automatically to the chief? **Recommend the selected Bot only.** Linking is an explicit choice, and the chief keeps its existing roles.
3. **Deleting a group chat.** Allow its responsible member to delete it, or reserve deletion for the owner, chief and relevant leader? **Recommend allowing the responsible member.** They already manage the group's membership and settings. This is a W4 decision.
4. **Private team members.** Forbid private Bots from serving as leader or member, or support them with additional visibility rules? **Recommend forbidding both.** Membership is visible to the team, and leadership and member mentions need reachable Bots. This is a W4 decision.

## Related RFCs

[Roles and their proposed amendments](0037-roles-not-types.md), [Solver retirement](0048-the-solver.md), [ACP and native tools](0003-model-routes-and-acp.md), [shared registry](0014-shared-bot-registry.md), [Pocket Bot management](0036-bot-management-from-pocket.md), [caller principal](0038-cloud-multiuser-caller-principal.md), [Cloud](0024-automagik-cloud.md), [Pocket group chats](0040-group-chats-in-pocket.md) and [sandboxed Bots](0044-sandboxed-bots-core-scope.md).
