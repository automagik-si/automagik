# RFC 0037: One Bot; roles make the difference

| Field | Value |
|---|---|
| Status | Accepted (2026-11-19, approved by the owner's delegate: one Bot, roles make the difference; the P1-P6 order as written; Q1-Q10 answered with this RFC's own recommendations, see Answers; no delivery merged) |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P) |
| Created | 2026-11-19 |

## Summary

Automagik stops making a new Bot kind the way it adds a product. There is one Bot
implementation: one record, one runtime, and the person's settings decide the model, the
permission level, the folder, the shell, the channels, the memory and the Sessions. The
differences a person installs are **roles**.

A role is a package that adds a bounded set of parts to exactly one Bot: tools, one prompt
part, its UI rows, its own settings and the capabilities it asks the person to grant. It cannot
change what makes a Bot a Bot: not its model, permission, shell, folder, channels, memory,
Sessions or Main Bot powers, and not its name or look. It cannot add another role.

Roles are the unit of the marketplace: a Roles section on the Apps page, install once, attach to
one Bot, detach first, uninstall second. The first product is Voice / Mouth, built on the voice
chat the app already has. The order is P1 (one Bot and the Role picker, as the step-1 design
has it), P2 (the package and its record), P3 (the shop and the picker), P4 (Voice / Mouth), P5
(the isolated runtime for community roles) and P6 (Genie becomes an ordinary role package).

This RFC is documentation. It ships no code and cuts no release; the implementation is a
separate wish. The design work in #1572 settled the screens; the mock itself is preserved on
`feat/roles-dev-mock-preserved` and is not part of this RFC's diff. The mock's `?mock=roles` is
a preview URL parameter (an alias for `?mock=bazaar`) that opens that branch's mock page; it is
not a product setting, and `dev` has no roles setting: the team-level one is introduced in P1.

## Motivation

A product that wants its own identity, tools or rules adds a Bot kind today. The team's crew
kinds are `omni`, `genie` and `unfold` (`apps/bots-dsh/src/host/roster.js:33`), and each one is
tied to a DSH plugin (`apps/bots-dsh/src/host/installed.js:18`): when that plugin is missing or
switched off, the team reports the Bot as not installed, with that reason
(`installed.js:2-9`). The kind is then read in the host and drawn in the client: the shell
recovery whitelist (`parts.js:2438`), Genie's prompt exception (`prompt.js:48`), the clay art
(`src/client/clay-art.js:78`), a plugin-owned model menu (`host-models.js`), and the client's marks and
badges.

That costs more than it returns:

- **A kind is a product fork.** A feature that is really a tool, a prompt part or a settings
  row has to re-create identity, surface, checks and lifecycle as a new Bot. The team carries
  each fork's special cases in both the host and the browser.
- **A kind is coarse.** A person who writes launch posts cannot add Genie's wish-granting to
  the Bot they already have; they create a second Bot with its own name, Session, memory and
  folder. The work moves to the product instead of the product coming to the work.
- **A kind is a plugin, not a product.** Uninstalling or switching off the plugin makes the
  Bot read as "not installed", although its Session and its history are still there. The
  person's unit of ownership is the Bot, not the plugin.
- **Kinds accumulate.** `unfold` is still a known kind after Unfold left the repository
  (RFC 0020); it is a compatibility record the team still has to name and check. Nothing in
  the pattern retires a kind.
- **The marketplace has no unit for this.** It sells apps and DSH plugins. "A way of working
  that one Bot can take on" has no package, no price, no install and no attach.

The step-1 design in #1572 showed the alternative on an ordinary Bot: a Role picker beside the
Bot's role line, and Genie's wish rows under that Bot's row when the role is on, with no second
Bot and no new kind. This RFC records that shape as the plan.

## Design

### The decision

**One Bot; roles make the difference.** Five rules follow from it:

1. **One implementation for the team's Bots.** Every Bot the person creates is the same record
   and the same runtime. The model, permission, folder, shell, channels, memory and Sessions are
   that Bot's settings; no product changes them. The Main Bot stays a team-level power, not a
   product. The remaining crew kinds (`omni`, `unfold`) are compatibility records converted by a
   later RFC (Out of scope).
2. **A role adds, never changes.** A role may add tools, one prompt part, UI rows, its own
   settings and declared capabilities. It may not change the Bot's kind, model, route,
   permission, shell, folder, channels, memory, Sessions or Main Bot powers, nor its name,
   colour or avatar.
3. **One role per Bot through P6.** `bot.roles` is a list so composition can be decided later
   without a data migration, but P1-P6 attach at most one role. The first case that would ask
   for two is Genie plus Voice / Mouth; Q1 holds that decision.
4. **Install, attach, detach and uninstall are four different acts.** Installing a package
   touches no Bot. Attaching writes the Bot's role. Detaching removes what the role added but
   keeps its data. Uninstalling removes the package only after it is detached.
5. **Official first.** In P1-P4 only Automagik's reviewed roles run. A community role is
   listed, labelled and not installable until P5 gives it an isolated runtime. A signature
   proves where a package came from; it does not make a stranger's code safe in the host.

### What a role is

A role package is a release artifact: a tarball, its sha256, and a reviewed manifest. The
manifest, `role.json`, declares:

- `id`, a lowercase slug that is also the folder name;
- `name`, `version` (semver) and `publisher`;
- `entry`, one host module, the only code the package may run;
- `prompt`, one text file: the role's one prompt part;
- `tools`, the tool names it registers and their definitions;
- `settings`, the fields it shows in the Bot's settings, drawn by the host from known kinds;
- `ui`, the rows it adds, from the host's known row types;
- `capabilities`, from the host's closed list, each one the person grants separately.

One prompt part means one part inside the Bot's existing `bot-identity` section, added where
the other plugins' parts already go: after the Bot's own instructions, beside the Main Bot's
rules and the team's rules (`prompt.js:68-95`). It is marked as the role's and cannot replace
the identity line or the Bot's instructions, add a second system prompt or write the Main Bot's
rules.

Its tools are registered on the role's own fiber and disposed when the role is detached. They
are ordinary team tools, so the Bot's permission level, folder, shell flag, deny lists and
approval cards apply to them exactly as they apply to the team's own tools. A role that needs a
shell is refused on a Bot that has none; a role cannot ask for a wider level.

Its UI rows are host-drawn from known types: the same `botChildren`, `botSettings` and
`toolCards` outlets other parts use. A role supplies data, never HTML. That keeps the surface,
the theme and the accessible behaviour one implementation.

Its settings are per Bot and live in the role's data folder, not in `state.json`. Detaching or
uninstalling the package does not delete them; a reinstall finds them again.

A role is **not**:

- a DSH plugin, which is installed into DSH and can affect the host outside one Bot;
- an MCP capability, which is a connection mounted into one Session;
- a skill, which is instructions the model reads;
- a second agent runtime, model route or model menu;
- a Bot kind, a group role or a channel;
- a way for a Bot to install or attach anything.

### What changes for Bots

| Part | Today | With roles |
|---|---|---|
| Record | `kind` selects a crew product; a missing plugin makes the Bot read as not installed | `state.json`'s `kind` stays a stored compatibility field; new Bots get no crew kind; `bot.roles` carries the product |
| Model | a crew kind may own its menu through its plugin | a role never sets the model or route; a plugin-owned model menu stays a separate extension point, not a role |
| Permission, shell, folder | the Bot's own settings | unchanged; every role part is fenced by them, and a role cannot request a change |
| Channels | the team's and the Bot's links | unchanged; a role cannot add a channel or route a message |
| Memory, Sessions | the Bot's own chat, memory and work Sessions | unchanged; a role never opens a Session of its own |
| Main Bot | a team-level power | unchanged; a role cannot request it, and it is not a product |
| Name, look | the person's | unchanged; a role may add a small tag beside the name, never a rename or a new avatar |
| Role label | `bot.role`, the person's short free-text line | unchanged and never read as the product; the attachment is the separate `bot.roles` |
| Prompt | the team's rules and the Bot's instructions | the same, plus one role part inside `bot-identity` |
| Tools | the team's tools and the host's grants | the same, plus the role's tools while attached |
| Surface | kind-specific marks and rows | a role tag, the role's rows and its settings card, all host-drawn |
| Data | `state.json` and the team home | the same, plus the role's own data folder under the team home |

A team with no roles sees no change. A DSH Bot of kind `genie` is read as the built-in Genie role
from P1 and keeps its wishes, its Session and its memory; P6 is the delivery that writes the
role and retires the kind. A Herdr-exposed Bot keeps its roster record and takes no role in
P1-P6 (see "Herdr's `.herdr` roster"). The free-text `bot.role` label is kept exactly as it is
on `dev`: the new roles never read or write it, and the two are never converted into each other.
It is not migrated or superseded in P1-P6; only the product name "Role" is new.

### Role assignment

**Install** is a team act. The shop reads the official catalog, the host verifies the package's
sha256 against the signed index, and the install record is written under `state.roles`. Nothing
a Bot can see changes. A tampered package, a version not in the index or an unknown capability
is refused before a byte is written into the team home.

**Attach** is a Bot act by the person. The Bot's Role picker lists installed roles only. Picking
one writes `bot.roles` with the role's id, the exact version, the attach time and an empty grant
list. The role's tools and rows appear, and its prompt part joins the next turn. A group chat
uses each member's own role; there is no group role. A Herdr-exposed Bot is not an attach
target: it has no Role picker and `role-attach` refuses it (see "Herdr's `.herdr` roster").

**Detach** removes the role's tools at once and its prompt part and rows from the next turn; a
turn already running finishes under the role it started with. The grants go with the
attachment. The role's settings and data stay.

**Uninstall** is refused while the role is attached. Once detached it removes the package files
and the install record; the role's per-Bot data stays until an explicit delete, which P1-P6 do
not offer.

Only the person installs, attaches, detaches and uninstalls. No Bot tool exists for any of the
four in P1-P6: a Bot may ask in its chat, and the card that follows is the person's. A Bot
cannot attach a role to itself or to another Bot, and a role cannot add a second role.

Attaching pins a version. A newer package in the catalog does not move a Bot that already has
the role: the shop shows the update, and the person detaches and attaches again (or, later, an
explicit update action). This is Q3.

### Herdr's `.herdr` roster

Some Bots live in Herdr's project roster, `<project>/.herdr/bots.json`, not in the team's
`state.json`. RFC 0014 keeps that file at version 1, read and written in place (its "The legacy
file" and "Contracts introduced"), and a Herdr-exposed Bot is never written to `state.json` (its
"Herdr Bots in Automagik"). Its `kind` is Herdr's seat, `main` or `member`
(`herdr/mods/am-sidebar/model.js:14-15`; an unknown value is left out at `:188`), not one of the
team's crew kinds. Its `role` is the free-text briefing line
(`herdr/mods/am-sidebar/model.js:36-37`), the same `role` field the plan keeps as the `bot.role`
label and never reads as the product. This section is the plan's answer for that record.

- **P1-P6 write no role there.** A role is DSH host code with a prompt part, tools and host-drawn
  rows, served on a DSH Bot's turns (see "What a role is"). A Herdr-exposed Bot has no DSH
  Session: its chat in Automagik is a projection of its live Herdr agent, and its tools run in
  that agent under its own settings (RFC 0014, "Herdr Bots in Automagik"). So there is no DSH
  turn to run the role in, and the roster is the Bot's only record: in P1-P6 a role has no place
  for an exposed Bot, in the roster or in `state.json`. The Role picker is not shown on an exposed
  Bot, `role-attach` refuses it with that reason, and no `bot.roles` entry is written. This is a
  limit of P1-P6, not a hidden half-feature.
- **The roster is read and written in place, as RFC 0014 says.** Herdr starts an edit from the
  text it read, refuses the write if that text changed, and renames the new text into place (RFC
  0014, "Writes under one lock"); P1-P6 add no write. Today's version 1 file is converted to the
  version 2 repo file by RFC 0014's delivery 4; after that conversion the Bot's record is still
  the repo file's, never `state.json`. Neither file gets a `roles` key from this plan.
- **The roster's `kind` is a seat, not a role.** `main` and `member` stay Herdr's seat: Herdr
  reads them as its main and member seats, and RFC 0014 carries `kind: "main"` into the version 2
  file's `main` field. They are not mapped to a role, not converted to a crew kind and not
  retired. P6's Genie conversion applies to DSH Bots; a roster carries no crew kind to convert. A
  Herdr-exposed main Bot is still an exposed Bot: it takes no role in P1-P6, and Q2's "a role may
  be attached to a Main Bot" means a DSH team Main Bot.
- **Consistency with `state.json`'s roles is by record, not by copy.** Each Bot lives in exactly
  one file (RFC 0014, Q1). The Bots in `state.json` carry `bot.roles`, resolved against the
  install records in `state.roles`; a roster Bot has neither, and no role data folder is keyed by
  its id. `state.prefs.roles` is the team-level switch for the DSH team (contract 11); it does
  not reach Herdr. Installing a team role changes no roster, and attaching one changes no roster
  either, because attach refuses an exposed Bot.
- **A later RFC owns roles for exposed Bots.** If an exposed Bot is to host a role, that RFC first
  decides the runtime (a DSH Session or a Herdr-side role host). It then writes the attachment in
  the Bot's own record — the version 1 roster before RFC 0014's delivery 4, the version 2 repo
  file after it — in place under that file's rule, never in `state.json`. A repo file arrives with
  a clone and its text is untrusted (RFC 0014, Threat model), so the attachment would still be
  the person's act on this computer, never a field a clone can vouch for. P1-P6 add no such
  field.

### The marketplace

The Apps page gains a **Roles** section between Automagik's official rows and the upstream
connector catalog, with a **Roles** chip beside the existing categories. Official roles come
first; a community role carries a Community tag and an Install button that is off with the P5
reason. Search and the existing category chips work across the section; P1-P6 add no new page,
route or navigation entry.

Opening a role shows its package card: publisher, version, sha256, what it adds, the grants it
asks for, and what it may not change. The card also says where the role runs (P2-P4: in the Bot
team; P5: in the isolated runtime). The Install button is on the card and on the row; Uninstall
is disabled while the role is attached, with the reason.

The official catalog is part of the bots-dsh release, not a live service and not an npm
package. A role artifact is attached to the release as `automagik-role-<id>-<version>.tgz` with
its `.sha256`, and the release's signed index names the id, version, publisher, sha256 and
source. An install therefore fetches the artifact from that release; if it cannot, it says so
and changes nothing. P1-P4 ship no ratings, reviews,
prices, paid roles or hosted registry; a community index is part of P5's design.

## Trust boundary

A role is host code. In P2-P4 it runs in the Bot team's own process, with the Bot's fences, and
it can do anything its tools can do under that Bot's permission. The controls, stated as
limits:

- **Review, not a badge.** Only Automagik's reviewed packages run in P2-P4. A signature proves
  the artifact is the one that was reviewed; it does not make unreviewed code safe.
- **The package is verified before it is written.** The sha256 comes from the signed index, the
  id is validated as a slug, and every path is derived from the validated id and version, never
  from a manifest path. An unknown capability or a malformed manifest refuses the package.
- **The Bot's fences stay.** A role's tools go through the same level, folder, shell, deny-list
  and approval checks as the team's tools. A role cannot raise a level, add a shell, leave the
  folder, add a channel, read another Bot's Session or become a Main Bot.
- **Herdr's roster is not a role surface.** A repo file arrives with a clone, so its text is
  untrusted (RFC 0014, Threat model): its `look` (after conversion, `identity`) sets the look
  only, the person's per-project yes is what brings a Bot in, and P1-P6 read no role from
  `.herdr/bots.json`. An exposed Bot has no DSH Session and its tools run in its Herdr agent (RFC
  0014, "Herdr Bots in Automagik"), so even the person cannot attach a role to it in P1-P6; the
  picker is not shown and `role-attach` refuses it. A later RFC's roster attachment would still
  be the person's act on this computer, never a field a clone can vouch for.
- **Capabilities are separate, named and person-granted.** `audio-out` (speak through the
  person's voice pane), `task-start` (start a wish or task, at the narrower of the Bot's and the
  caller's level), `route-policy` (choose the route for work it starts, within the Bot's
  settings) and `history-read` (read the chat or group history it is attached to). None of them
  widens the Bot's permission, and each is recorded on the attachment. A role cannot grant
  itself one.
- **The UI is the host's.** A role cannot draw arbitrary HTML or add a page; the host draws only
  known row and setting types. A compromised official role can still lie in its own text, which
  is a review question, not a surface one.
- **The acts are the person's.** Install, attach, detach and uninstall are admin actions on the
  existing route, refused in read-only mode, and available to no Bot tool.
- **Undo is local and complete for what a role added.** Detach removes its tools, prompt part,
  rows and grants; uninstall removes the package; the Bot's own record, model, permission,
  folder, memory and Sessions are untouched. The role's data is kept on purpose; deleting it is
  a separate, explicit act that P1-P6 do not ship.

Residual risk, plainly: an official role is as trusted as the Bot team. It can read what the
Bot can read and act through the tools it is given. P2-P4 do not sandbox it from the team's
process, and this RFC does not claim they do. That is why community roles wait for P5.

## Out of scope

- Making `omni` or `unfold` roles; converting the remaining crew kinds is a later RFC. This plan
  converts Genie only, in P6.
- Plugin-owned model menus and Bots a plugin runs on its own engine (`host-models.js`). That
  extension point stays; it is not a role.
- More than one role on a Bot, group roles, or a role that changes how a group or a channel
  behaves.
- Running community code in the host, a community index, ratings, reviews, payments, revenue
  share or a hosted marketplace.
- A Bot installing, attaching or detaching a role, or a marketplace in which Bots buy from each
  other.
- Roles on Herdr-exposed Bots, and any role write into `.herdr/bots.json` or the version 2 repo
  file. RFC 0014 keeps the version 1 roster read and written in place until its delivery 4
  converts it, and an exposed Bot is never in `state.json`; an exposed Bot has no DSH Session to
  run the role in, and P1-P6 add no field to the roster. A later RFC decides the runtime and the
  attachment's place.
- Cloud sync, cross-machine install, or roles as a Cloud entitlement.
- Roles on a linked machine's roster or a remote Bot. P1-P6 write roles only on this computer;
  RFC 0014's remote reads and `hc` links carry no role install or attachment.
- Replacing DSH plugins, MCP capabilities or skills with roles.
- A role authoring kit inside the app.
- Migrating existing team Bots other than Genie, or changing any Bot's model, permission,
  folder, memory or Sessions as part of this plan.
- Shipping the design mock. It is a design record, not a product surface.

## Migration

- **The record is additive.** A DSH Bot gains `bot.roles`; nothing existing is renamed or
  removed. Teams with no roles behave exactly as before. An older plugin ignores the new keys and
  keeps them in `state.json`, so a downgrade loses the role's parts but not the Bot or its data.
- **Kind is read, not rewritten.** In P1-P5 a DSH Bot with `kind: 'genie'` is shown and served as
  the built-in Genie role. `kind` stays on the record and no automatic write happens. `omni` and
  `unfold` are left exactly as they are. Herdr's roster has a different `kind` (next bullet).
- **Herdr's roster keeps its `kind` and gains no role in P1-P6.** `<project>/.herdr/bots.json`
  stays version 1, read and written in place (RFC 0014), and a Herdr-exposed Bot is never written
  to `state.json` (RFC 0014, "Kept apart from DSH's team"). Its `kind` is Herdr's seat, `main` or
  `member` (`herdr/mods/am-sidebar/model.js:15`; an unknown value is left out at `:188`), not the
  crew `kind`; it is kept as an input, never mapped to a role and never retired. P1-P6 write no
  `roles` key there, so a downgrade changes nothing in the roster: its `kind`, `role`,
  instructions and look stay as they are. A Herdr Bot's `role` stays the same kind of free-text
  label as `bot.role`, never a product Role. Attaching a role to an exposed Bot is a later RFC's
  work (Out of scope).
- **Genie's Session, memory and wishes do not move.** The role uses the same tool and the same
  wish rows; attaching it to an ordinary Bot adds them there, and the Genie Bot keeps its own.
- **P6 is the one rewrite of `state.json`.** It writes the Genie attachment
  (`{ id: 'genie', version, ... }`) and keeps `kind` for one release where both are read, after a
  backup of the team's `state.json`. A rollback restores `kind` and the previous record; the
  package stays installed and the wishes stay in their records.
- **A missing package is visible, not fatal.** If the installed files are gone, the attachment
  shows as broken, its tools do not load, and nothing else changes. The person can reinstall the
  same version or detach. No automatic uninstall, no automatic role change.
- **A newer catalog version never moves an attached Bot.** The attachment pins the version it
  was attached at. Updating is an explicit act (Q3).
- **Disks and paths.** Packages live under `<team home>/roles/<id>/<version>/`; role data lives
  under `<team home>/roles/data/<bot id>/<role id>/`. The team home is unchanged
  (`$AUTOMAGIK_HOME/bots`). Paths come from validated ids and versions, never from manifest
  text.

## Contracts introduced

1. **`state.json`: `bots[].role` is untouched.** It is the person's short free-text label, as
   today, and no read or write of the product treats it as an attachment. The new field is
   `bot.roles`; the two are never converted into each other.
2. **`state.json`: `bots[].roles`.** A list of attachments, at most one through P6:
   `{ id, version, attachedAt, grants }`. Absent means none. It is additive; an older plugin
   ignores it and its own save keeps it. Detaching removes the entry; uninstalling the package
   does not touch the Bot's own fields.
3. **`state.json`: `roles`.** The team's install records, keyed by role id:
   `{ id, version, publisher, sha256, installedAt, source }`. Absent means none installed. Only
   install and uninstall write it. An older plugin keeps it as an unknown key.
4. **`role.json`.** The package manifest described above. `id` is
   `^[a-z0-9][a-z0-9-]{0,40}$`; `version` is semver; `publisher` is a name, not a trust claim;
   `capabilities` must all be from the host's closed list. An unknown required field or
   capability refuses the package; unknown optional fields are ignored with a warning in the
   install result.
5. **Role paths.** `<team home>/roles/<id>/<version>/` for the package and
   `<team home>/roles/data/<bot id>/<role id>/` for its per-Bot data. The team home and its lock
   are unchanged. No new route, plugin id or browser-storage prefix.
6. **The four admin actions.** `role-install` and `role-uninstall` (team), `role-attach` and
   `role-detach` (one Bot), on the existing `POST /api/omni-ui` route, with the same person-only
   admission as the other admin actions and refused in read-only mode. The host resolves the
   version and sha256 from its signed catalog; a payload cannot name its own sha256 or source.
   Exception (RFC 0048 delivery 2): a role whose package ships inside the Bot team plugin
   (`solver`) installs from that copy when no install exists, recorded with `source: 'bundled'`.
   It declares no tools, settings or capabilities. The host authenticates its content against the
   plugin-owned digest for its installing version on every load.
7. **The state answer.** The existing `state` answer adds the catalog plus the installed
   records, and each Bot's `roles`. A client that does not know the fields ignores them; the
   Bot's own fields do not change shape.
8. **Capabilities.** `audio-out`, `task-start`, `route-policy`, `history-read`: declared by the
   package, granted one by one by the person, recorded on the attachment, removed by detach. A
   capability never widens the Bot's permission, folder, shell, channels, memory or Sessions.
   RFC 0048 delivery 3 enforces `task-start` and `route-policy` at `start_task`. A verified
   bundled role uses the running plugin's capability list for that role ID.
   Under [RFC 0051](0051-threads-and-the-orchestrator.md), `task-start` is
   enforced at `delegate` (helper and member) and at the `start_task` alias.
   `route-policy` is required to name a model for a helper.
9. **Kind stays a stored field.** `state.json`'s `kind: 'genie'` is read as the built-in role from
   P1 and as the installed package from P6. No product may add a new crew kind; a role is the
   extension point. Herdr's roster has its own seat `kind` (contract 12), which is not a crew
   kind.
10. **Release artifacts.** An official role is `automagik-role-<id>-<version>.tgz` plus its
    `.sha256`, attached to the release; the signed `roles.json` on that release names it.
    Its `<version>` is the release in which the package's bytes last changed; a later release
    attaches the same bytes under its own tag, so an unchanged role keeps its version and its sha256.
    Nothing is published to npm.
    A `bundled` install uses the version of the plugin that installed it. Identical content can
    have different installed versions. The shop's update badge uses the signed catalog version
    comparison.

    **Alternative considered.** Stamping every release's version would show an update on every
    plugin release and block fresh attachments after a plugin upgrade and restart.
11. **The roles setting.** `state.json: prefs.roles` is a team-level boolean introduced in P1,
    on by default: the one switch the deliveries reuse. It gates the Role picker and tag (P1),
    the temporary install action (P2) and the Roles section and chip (P3). It is not a Bot
    setting, not `bot.role`, not `bots[].roles` and not the install records in `roles`. It does
    not reach Herdr's roster; an exposed Bot has no Role picker (contract 12).
12. **The Herdr roster is closed to roles in P1-P6.** `<project>/.herdr/bots.json` stays version
    1, read and written in place (RFC 0014); no `roles` key is written there, and no Herdr-exposed
    Bot is written to `state.json`. Herdr's `kind` is `main` or `member`, a seat, not a crew kind
    or a role; it is kept. The Role picker, `role-attach` and `role-detach` do not apply to an
    exposed Bot. A later RFC that gives one a role writes the attachment in that Bot's own record
    (the version 1 roster, or the version 2 repo file after RFC 0014's delivery 4), in place, and
    never in `state.json`.

## Deliveries

Each delivery is plugin-only (3.N.P), is complete for its users at merge (or hidden behind the
team-level roles setting that P1 introduces), and leaves every Bot's own settings untouched. The
roles setting is a team-level flag in `state.prefs`, not a Bot setting and not the free-text
`bot.role` label; `dev` has neither the flag nor a roles group in Bot settings. The acceptance
check to build for each delivery is the one test or observation that proves it; the rollback
says what a revert does.

### P1 - one Bot, one Role picker (unchanged)

The step-1 design as it stands: a Bot carries `bot.roles` (empty on an old Genie Bot, whose
`kind` still reads as the built-in role); the Role picker sits beside its role line; the
built-in Genie role is served through that path, with its `grant_wish` tool, its wish rows, its
rules and the role tag. No package, no install, no shop.

P1 also introduces the roles setting: one team-level boolean, `state.prefs.roles`, in the same
`state.json` as `prefs.theme` and `prefs.permission`, on by default. It is new in P1, not an
existing setting on `dev`, and it is not a Bot setting. It gates the picker and the role tag in
P1, the temporary install action in P2, and the Roles section and chip in P3.

- **Acceptance:** an ordinary Bot shows Role: none and keeps its model, permission, folder and
  Session; a Genie Bot still grants a wish and draws its wish rows; setting the role to none
  removes the rows and the tool and changes nothing else. One host test to build covers both.
- **Rollback:** the role display and the picker are additive; turning roles off returns every
  Bot to its kind's current behaviour. No data is rewritten.

### P2 - the package and its record

The role package and `state.roles`: install from the signed index, verify the sha256, validate
the id and capabilities, write the files under the team home, record the install. No shop yet;
while the P1 roles setting (`state.prefs.roles`) is on, a temporary install action appears in a
Roles card in the Bot's settings, for testing.

- **Acceptance:** a package whose bytes do not match the sha256, a version not in the index, or
  an unknown capability is refused and leaves no files; a good package installs, records id,
  version, publisher and sha256, and adds no tool to any Bot until it is attached. A reinstall of
  the same version is idempotent.
- **Rollback:** remove the install record and the package folder; no Bot changed, so nothing to
  undo on a Bot.

### P3 - the shop and the picker

The Roles section on the Apps page, the Roles chip, the package card, search, install from the
row and the card, the picker that lists installed roles, attach and detach, the role tag on the
Bot's row and in its settings, Uninstall disabled while attached.

- **Acceptance:** the #1572 flow on a real team: install Voice / Mouth, attach it to an ordinary
  Bot, see the tag and the card, detach, uninstall; a community row is listed, labelled, and its
  Install button is off with the P5 reason. The flow leaves an unrelated Bot byte-identical in
  `state.json`.
- **Rollback:** hide the Roles section and the chip with the P1 roles setting
  (`state.prefs.roles`); installed packages and attachments stay in the state, and the picker
  goes on working if it was already in use.

### P4 - Voice / Mouth

The first product, on the voice chat the app already has: one prompt part, the `speak` tool,
per-Bot voice settings (voice and speed) and the `audio-out` grant. No files, shell, channels or
network. It is first because it is small and visible and exercises the whole path: package,
install, attach, prompt part, tool, settings, grant and row.

- **Acceptance:** after the person grants `audio-out`, `speak` reads a reply through the
  person's open voice pane; refusing the grant refuses the call without speaking; on an app or
  Bot with no voice pane, `speak` is refused with a reason and nothing is spoken; detach removes
  `speak` and the card and keeps the voice settings. The role's package declares no capability
  other than `audio-out`.
- **Rollback:** uninstall the package after detaching it. The Bot keeps its model, permission,
  folder, memory and Session; only the role's parts go.

### P5 - the stranger gate

The isolated runtime for community roles: one process per role and Bot, no host imports, a
declared capability API over a narrow channel, no network unless a capability grants it, the
Bot's folder as the only default filesystem, and a process that is killed on detach. The
community catalog is off by default; an official role may also use the runtime.

- **Acceptance:** a hostile test role cannot read outside its granted folder, cannot open a
  socket, cannot call another Bot's tools and cannot survive a detach; a role that exceeds its
  grants is stopped and reported to the person; official roles in the host are unaffected by the
  runtime being off.
- **Rollback:** turn the community catalog and the runtime off; the host returns to official
  roles only, and any running role process is stopped. Attachments stay as records.

### P6 - Genie becomes a role

Genie becomes an official role package built from the Genie project's release (not copied into
bots-dsh), installed and attached like any other: `grant_wish`, the wish rows, Genie's rules and
its chat suggestions. New Genie Bots are ordinary Bots with the role; the `genie` kind stops
being created and is migrated.

- **Acceptance:** a Bot with the Genie role grants a wish exactly as a Genie Bot does today,
  including the wish rows and the task level rule; a team with an old `kind: 'genie'` migrates
  with its wishes and Session intact; an ordinary Bot without the role has no wish rows and no
  `grant_wish`; detaching removes both. The migration test to build reads a state file written
  by the previous release.
- **Rollback:** restore `kind` from the record and leave the package installed; the Bot keeps
  its Session and wishes. The role's tools are the same, so a rollback changes the record, not
  the work.

## Open questions

1. **More than one role per Bot?** **Recommend one through P6.** `bot.roles` is a list, so a
   later decision needs no migration. The first real case is Genie plus Voice / Mouth; allowing
   two now means deciding how two prompt parts, two settings cards and two grant sets compose
   before a product needs it.
2. **Is the Main Bot a role?** **Recommend no.** It is a team-level power, not a product. A role
   may be attached to a Main Bot, but it cannot grant or remove that power.
3. **Do attachments pin a version?** **Recommend yes.** A Bot stays on the version it was
   attached at; updating is an explicit act. The alternative, following the catalog, would let a
   release change a Bot's tools without the person acting.
4. **Where does role data live, and what does uninstall keep?** **Recommend the role's data
   folder under the team home, kept on detach and uninstall.** A delete action comes later, with
   its own confirmation; deleting on uninstall would lose the person's voice settings or notes
   by accident.
5. **Who may install and attach?** **Recommend the person only.** A Bot may ask in its chat; the
   card is the person's, like a permission or a secret approval. No Bot tool for install,
   attach, detach or uninstall in P1-P6. An exposed Herdr Bot is not an attach target at all in
   these deliveries (Design, "Herdr's `.herdr` roster").
6. **What may run before P5?** **Recommend official Automagik roles only.** "Vetted publisher"
   is a review with a named owner, not a badge; until that review exists, a community role is
   listed and not installable. A signature without a review is not enough for host code.
7. **What is P5's runtime?** **Recommend one separate process per role and Bot, with a declared
   capability API and no host imports.** A container per role costs start-up and a platform
   story; DSH's own sandbox does not yet bound a plugin's host code. The process is the smallest
   boundary that can be enforced and killed on detach.
8. **Where does the official catalog come from?** **Recommend a signed `roles.json` on each
   release, beside the role artifacts, using the plugin lane's key.** It reuses the lane's
   existing trust path and adds no service; a separately hosted index is a Cloud question, not a
   plugin one.
9. **What is the product word?** **Recommend "role" in the UI and "role package" in docs.** The
   Bot's existing free-text `bot.role` label keeps its field and is shown as the Bot's
   description; "Role" names the product. The working name "agents bazaar" describes the shop,
   not the product, and "agent" already means something else in DSH. The Apps page section is
   "Roles".
10. **Do Omni and Unfold follow Genie into roles?** **Recommend a separate RFC after P6.** Omni
    is the Main Bot's product and Unfold has left the repository; converting either here would
    widen the trust and migration work without proving the role path first.

## Answers (2026-11-19)

The owner's delegate approved this RFC on 2026-11-19: the direction (one Bot, roles make the
difference), the deliveries in the order P1 to P6, and an answer to every open question. Each
answer is the recommendation the question itself makes, restated; every question had one, so
none needed a fallback. The questions above stay as they were asked.

1. **Q1, more than one role per Bot:** one role per Bot through P6. `bot.roles` stays a list,
   so allowing more later needs no migration; how two roles compose is decided when a product
   needs it.
2. **Q2, is the Main Bot a role:** no. It stays a team-level power; a role may be attached to a
   Main Bot but cannot grant or remove that power.
3. **Q3, do attachments pin a version:** yes. A Bot stays on the version it was attached at, and
   updating is an explicit act by the person.
4. **Q4, role data and uninstall:** the role's data folder lives under the team home and is kept
   on detach and on uninstall. A delete action comes later, with its own confirmation.
5. **Q5, who may install and attach:** the person only. A Bot may ask in its chat; there is no
   Bot tool for install, attach, detach or uninstall in P1-P6, and an exposed Herdr Bot is not an
   attach target in these deliveries.
6. **Q6, what may run before P5:** official Automagik roles only. A community role is listed and
   not installable until P5 and a named-owner review exist; a signature alone is not enough for
   host code.
7. **Q7, P5's runtime:** one separate process per role and Bot, with a declared capability API
   and no host imports, killed on detach.
8. **Q8, the official catalog:** a signed `roles.json` on each release, beside the role
   artifacts, signed with the plugin lane's key. No separately hosted index.
9. **Q9, the product word:** "role" in the UI and "role package" in docs; the Apps page section
   is "Roles". The free-text `bot.role` label keeps its field and is shown as the Bot's
   description.
10. **Q10, Omni and Unfold:** not in this RFC. Whether either follows Genie into roles is a
    separate RFC after P6.

## Links

- #1572: the design work and the mock that settled the shop, the package card and the Role
  picker. The mock is preserved on `feat/roles-dev-mock-preserved` and is not part of this
  RFC's diff.
- [The Bot team](../../apps/bots-dsh/README.md): Bots, kinds, permissions and the one
  `bot-identity` section.
- [RFC 0011](0011-monorepo-parts-and-releases.md): parts, lanes and the plugin patch this plan
  ships on.
- [RFC 0014](0014-shared-bot-registry.md): the Bot record and the team's state.
- [RFC 0020](0020-unfold-plugins-leave.md): why `unfold` remains a kind and is not part of this
  plan.
