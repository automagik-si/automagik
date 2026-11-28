# RFC 0049: Skills for Bots

| Field | Value |
|---|---|
| Status | Accepted (2026-11-24: the owner's decisions and the lead's rulings in #2074) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none for this RFC (docs only). Deliveries: plugin (3.N.P) for bots-dsh and acp-dsh and their pt-BR strings; herdr (pack and am) for delivery 5b |
| Created | 2026-11-24 |

## Summary

The person keeps one account-wide library of skills in Settings → Skills and creates a skill by
link, by uploaded file, by pasted text or from a whole folder with scripts and references. Every
skill passes an extensive local security check before it can be used; the result is pinned to the
SHA-256 of the exact content checked, and any new content (an edit, a link update, a replaced
file) needs a new check. A model-assisted review on a different model adds its findings on top,
but the local check stays the gate: the review can never pass what the check blocks. Each Bot's
Settings gets a Skills section with an **Add skill** button that opens a select over the library;
the Bot then sees the names and descriptions of its active skills and loads one when it needs it,
or when the person writes `/<name>`. A skill wins over an agent's own slash command of the same
name, except a closed list of reserved app and agent control commands, which no skill may be
named. Workers a Bot starts on this machine inherit its active skills. A skill never grants a
permission: scripts and calls run only with what the Bot already has.

## Motivation

The owner asked for Skills for Bots on 2026-11-24 and decided its shape the same day. The code
already has most of the object and none of the reach:

- A capability of kind `skill` is a name, a description and a text, kept in the shared library
  `state.capabilities.items` and attached per Bot through `bot.capabilities`
  (`apps/bots-dsh/src/host/capabilities.js:8,121-170,236-248`). It has no size cap
  (`:169`), no source, no hash and no check; a person's manual save skips the secret scan that
  learned skills pass (`apps/bots-dsh/src/host/learning.js:150-151`).
- The per-Bot card is one switch per library item and renders nothing when the library is empty
  (`apps/bots-dsh/src/client/capability-settings.js:214-226`), which is why the owner's Bot Settings
  shows Instructions directly followed by Tools
  (`apps/bots-dsh/src/client/bot-settings.js:397-401`). A switch per library item does not scale to
  a long library.
- Delivery works only for DSH-native Bots: a skill is registered per Agent with
  `c.skills.register` (`capabilities.js:493-499`). An ACP prompt keeps only the person's,
  retry and handoff rows (`apps/acp-dsh/src/host/adapter.js:222-235`), so DSH's skill catalog
  never reaches Claude Code or Codex; native-tools mode also drops DSH's `skill` tool
  (`apps/acp-dsh/src/host/backchannel.js:62-67`); Antigravity, omp and Hermes get neither a
  bridge nor the Bot's identity text (`apps/acp-dsh/src/host/identity.js:3`).
- Workers inherit nothing: `start_task` Sessions are not owned Sessions, because `taskOwners` is
  filled only from automation runs (`apps/bots-dsh/src/host/store.js:934-940`), DSH subagent
  Sessions are outside the capability reconcile, and am workers "get no briefing"
  (`herdr/mods/am-sidebar/workers.js:732-733`).

The research behind this RFC compared every agent's skill format and recommends one delivery path
for all agents (a bounded catalog plus bodies on demand) over installing into each CLI's own skill
folders, which are per vendor and not per Bot (`apps/acp-dsh/src/host/cli-homes.js:24-26`).

## Design

### What a skill is here

A skill is a folder whose root holds `SKILL.md`: YAML frontmatter with `name` and `description`,
then a Markdown body, the open Agent Skills format. It may hold `scripts/`, `references/`,
`assets/` and other plain files. A text skill is a folder with only `SKILL.md`. The library item
stays a capability of kind `skill` (so packs, `attach_capability` and the learning path keep
working) and gains a source, a content hash, a check result and a file list.

- **Name.** The capability rule stays: lowercase letters, digits and single hyphens, at most 32
  characters, starting with a letter (`capabilities.js:8,28-32`). An imported skill whose
  `name` is longer or different is offered an editable name in the preview.
- **Reserved names.** A skill may not take the name of a reserved app or agent control command
  (the list is under "Use"). The name rule refuses it at creation, on every way in (Link, File,
  Text, Folder, a rename in Edit, and a Bot's `save_capability`), with the reason, as the rule
  already refuses connector ids (`capabilities.js:24-32`). So no skill and no control command can
  share a name.
- **Description.** Required, at most 1,024 characters (the standard's limit). The catalog shows
  at most 300 of them.
- **Limits (decided).** `SKILL.md` at most 64 KiB; at most 256 files, 1 MiB per file and 5 MiB in
  total; relative paths of at most 200 bytes and 8 levels; regular files only; the catalog at most
  8,000 characters (under "Use").
- **Separate from agent-native skills.** These skills have nothing to do with Claude Code's,
  Codex's or Antigravity's own skill folders. The app never writes into those folders, so the
  Codex OFF check (`apps/acp-dsh/src/host/codex-native.js:104-111`) and the shared CLI homes do
  not touch them.

### The account library: Settings → Skills

A new page, `skills`, in the Settings dialog's page list
(`apps/bots-dsh/src/shared/settings-pages.js:6-12`), next to Capabilities, in the existing section,
card, row, select and button styles. It lists every library skill with its name, description,
source, check state and the Bots that use it. "New skill" offers four ways in, as one select:

- **Link.** An HTTPS link to a raw `SKILL.md`, a GitHub file or folder link (resolved to the raw
  file, or the folder's archive, at a commit SHA), or a direct `.zip` / `.tar.gz` download.
  Public links only: the fetch carries no token, cookie or sign-in, and a link that answers only
  with one (a private repository, a signed-in page) is refused with a pointer to File or Folder.
  Private links that need a token are not part of this RFC.
- **File.** One `SKILL.md` or `.md` file, or one `.zip` / `.tar.gz` holding a skill folder.
- **Text.** A field opens when Text is chosen; with name and description fields beside it, or
  frontmatter parsed from the paste.
- **Folder.** A folder picker; the files are sent to the host as one upload and rebuilt there.

Every way ends in the same **preview** before anything is stored: the name (editable), the
description, the full `SKILL.md`, the file tree, what the skill uses (below), the check's
findings, and the model review's findings or its state ("Review running", "Review did not
finish", "No second model available") (below). The host keeps the received bytes in a staging
folder (`<team home>/skills/.staging/<token>/`, removed after 30 minutes or at save); Save stores
exactly those bytes and never fetches or reads the source again. Only the person saves through
this page (owner-only endpoints).

**What a skill uses** is shown on its row and in every preview, read by the check from the files:

- **Tools:** the tools the text names and any declared `allowed-tools` (shown, never honoured).
- **Scripts:** every file under `scripts/` or with a shebang, with its interpreter and size.
- **Endpoints:** every URL and host the files name.
- **Secrets:** With no target Bot, list the skill's declared key names without a lookup or mark.
  In an owner view with a selected Bot, check only those names at display time. Show
  'Not set for this Bot' when neither that Bot's secret scope nor an active connector env/header
  that resolves for that Bot supplies the key. Return only the name and mark. The status does not
  affect the pinned verdict.

Skills are shared: any Bot may use any library skill once it is added to that Bot. Creating a
skill never attaches it to a Bot.

### The security check

A host module (`skill-check.js`), the gate, runs locally, offline and deterministically over every
file: no network, no model call, no outside service. It returns a verdict, **block**, **warn** or
**pass**, and findings with a file, a line, a rule and a short reason; a secret value is never
shown, only its kind and place.

| Area | Blocks | Warns |
|---|---|---|
| Structure | a missing or unparsable `SKILL.md`, no description, a path with `..`, an absolute path, a link, a device or other non-regular file, a duplicate path, a size or count over the limits, malformed UTF-8 in a text file | a name changed to fit the rule; files outside the usual folders |
| Secrets | a credential shape or key-like value in any text file (`credentialShapes`, `apps/bots-dsh/src/host/redact.js:77`; `looksLikeKey` and `looksSecret`, `apps/bots-dsh/src/host/memory-entries.js:200,221`) | none (see Secrets under "What a skill uses" above. The status does not affect the pinned verdict) |
| Prompt injection | invisible or bidirectional control characters in instruction text; text that tells the agent to turn off approvals, raise its own level, hide what it does from the person, or read credential locations and send them out | text that tells the agent to ignore earlier instructions, take another identity, or treat the skill as above the person; long encoded blobs in instruction text |
| Dangerous commands | piping a download into a shell, reverse shells, disk or home wipes, writing to boot or system folders, reading browser or agent credential stores | `sudo`, recursive deletes, installing packages, changing crontab, shell start files or services |
| External endpoints | URLs with embedded credentials or tokens; loopback, private, link-local and cloud-metadata addresses | every other endpoint, listed |
| Scripts and binaries | executable binaries (ELF, Mach-O, PE), obfuscated scripts (decode-then-eval) | every script, listed with its interpreter |
| Fields that run or grant | — | `allowed-tools`, `hooks`, `` !`cmd` `` and other grant-or-run fields: listed and ignored |

- **Block** disables Save and Apply. **Warn** needs the person to tick "I reviewed these
  warnings" in the preview; the tick is recorded with the hash. **Pass** saves directly.
- **Pinned by hash.** The hash is SHA-256 over a manifest of every file, sorted by path, one line
  each: path, size and the file's own SHA-256. The stored files, the check result and any accepted
  warnings all carry that hash. Every skill is delivered only while its stored hash equals its
  checked hash. A skill is delivered only while its verdict is not block, except a Bot-created
  skill, which is report-only ("Bot-created skills", below).
- **New content, new check.** An edit, a link update, a replaced file or folder makes a new hash,
  and the new content is checked before it is stored. Renaming a skill or editing its description
  changes `SKILL.md`, so it is checked too.
- **New checker, new check.** The result records the checker's version. When the version
  changes, the host checks every library skill again at start; one that now blocks is suspended
  (not delivered) and marked in the library and on each Bot that uses it. A Bot-created skill is
  never suspended by a recheck: its new findings show on its library row and it stays delivered.
- **Checker 3 → 4.** Moving the Windows reserved-name rule into its own fingerprinted file keeps
  role edits out of the Skills fingerprint. Clean skills with verified reviews stay available.
  A skill with an accepted gate warning or model review finding is held until its owner opens and
  confirms it again. The host rechecks the same bytes and reuses the verified review with zero
  model calls. Reads leave the library bytes alone. On rollback to checker 3, skills confirmed
  under 4 need confirmation again. Clean reviewed skills and valid checker 3 acceptances carry over.
- **Existing text skills at the upgrade (decided).** Each capability of kind `skill` saved before
  this RFC is moved once at load: its text is written as `SKILL.md`, hashed and checked. One that
  passes or warns keeps working (a warning is accepted on the person's behalf only for that
  moved hash, and the row says so); one that blocks is suspended, with a notice on its library row
  and on each Bot that uses it, and the person fixes it by editing (a new hash, a new check).
- **Bot-created skills (decided).** The business rule that Bots may create skills
  (`save_capability`) stands, so a Bot's save is hashed, checked and reviewed in report-only
  mode: findings show in the library, marked "Saved by a Bot", and the Bot's save is never
  refused for a finding. The exception applies in three places, and only there:
  - **Delivery:** a block does not withhold it; it is delivered to every Bot it is active on, so
    existing Bot use is kept.
  - **Recheck:** a new checker version never suspends it; its findings are updated.
  - **Activation:** before a person activates it on a Bot (Add skill), the gate's and the model
    review's findings show and the person confirms once when there are findings; the person's
    Add skill refuses one the gate blocks, with the reason.

  Enforcing the check on Bot saves is the rule owner's call, later. Two rules stay mandatory for
  every skill, a Bot's save included: hash integrity (a skill is delivered only while its stored
  hash equals its checked hash) and the name rule, reserved names included, which refuses a Bot's
  save as it does today. Every new or edited skill must also meet the size limits before save. An
  oversized Bot save returns the reason, so the Bot can shorten it and retry. The one-time move
  preserves existing skills.
- The check is a filter, not a proof: it catches known shapes. The boundary that holds is that a
  skill never widens a Bot's permissions (below).

### The model review

On top of the gate, a model reads the skill as a second, independent reviewer. The local check
above stays the **gate**: only its verdict decides block, warn or pass.

- **When.** After the gate, for each new content hash: a new skill (any way in), an edit, a
  replace, a link update before Apply, a Bot's save, and each existing skill moved at the
  upgrade (once, for its moved hash). Content the gate blocks is not sent for review (nothing the
  review says can unblock it). A new checker version re-runs the gate, not the review.
- **A different model, when one is available.** The reviewer is the model the person already
  uses for work beside the chats, picked once by the existing background-model selection: the
  background model chosen in Settings (`prefs.backgroundModel`), else DSH's default background
  pick (`apps/bots-dsh/src/host/models.js:451-464`). When the background reviewer is unavailable,
  the whole review restarts on the first Main Bot's model. The background model is
  **available** for the review when it answers beside the chats (not an ACP agent and not a remote
  Hermes, `models.js:454,466`) and it needs no missing key (`needsKey` false). The author's model
  is recorded at save for a Bot's save and a learned skill (the saving Bot's model); a skill the
  person brings by Link, File, Text or Folder has no known author model. When the selected model
  is not available, or it is the known author's model, there is no review call: the gate runs
  alone and the person is told, in the preview, on the library row and before Add skill: "No
  second model is available to review this skill; only the local check ran." The record keeps
  `review.status` `none`.
- **A fresh call, no Session of a Bot.** The review is one history-less model call with no
  tools, made the way the memory review already asks a model (`oneShot`,
  `apps/bots-dsh/src/host/memory.js:1478-1555`): no Bot identity, no chat history, no memory, no
  MCP servers, no files, no shell, no Bot Session opened or written. It runs in the host, one
  review at a time.
- **What it reads.** A fixed English review prompt and the skill's own content only: `SKILL.md`
  and its other text files, each with its path, in path order, up to 256 KiB in all (beyond that
  the review says which files it did not read); binary files by path and size only. Never the
  gate's findings, another skill, the person's chats, memory, secrets, settings or any other file.
  Instructions to the agent that will use the skill are content; only text that speaks to the reviewer or this review,
  or tries to shape its verdict, is reported as prompt injection (a hard block).
- **Where the content goes.** Only to the provider of that model, under the person's own key or
  sign-in, as any background job already sends its input. This is one of the two occasions when
  skill content reaches a model provider; the other is a Bot's use ("Storage and privacy"). Nothing
  goes to an Automagik service. The prompt and the answer are not logged; only the result is stored.
- **Output.** JSON, validated against a fixed shape: `{"findings":[{"file","line","area",
  "severity","reason"}]}` where `area` is one of the gate's areas (structure, secrets, prompt
  injection, dangerous commands, external endpoints, scripts and binaries, fields that run or
  grant) or `other`, `severity` is `high`, `medium` or `low`, `reason` at most 300 characters,
  at most 50 findings, and a secret's value never quoted (a finding that quotes a key-like value
  has its reason replaced by its kind). An empty list is "No concerns found". An answer that does
  not fit the shape, a refusal, a provider error or 120 seconds without an answer is
  `review.status` `failed`: the person sees "The model review did not finish; only the local
  check applies", and the gate's verdict stands.
- **Effect.** The review never passes what the gate blocks, and its findings never turn a block
  into anything else. On a skill the person brings or edits, its findings show before Save, and
  any `high` or `medium` finding joins the gate's warnings under the same "I reviewed these
  warnings" tick, recorded with the hash. On a Bot-created skill it reports only and never
  blocks the Bot's save or asks for a tick there (the business rule). In every case its findings
  and its state show again **before the person activates a skill** (Add skill on a Bot; for a
  Bot-created skill the gate's findings show too, "Bot-created skills") and **before the person
  applies an update** (Apply); Add skill and Apply wait while a review of that hash is still
  running (at most its 120 seconds).
- **Cost.** One model call per new content hash, billed to the person's own plan or key of the
  reviewing model, with the input capped at 256 KiB and the output at the memory review's budget.
  The same hash is never reviewed twice. Reviews of Bot saves are queued behind the person's and
  limited to 20 a day per Bot; beyond that the row says "Not reviewed: daily review limit".

### Updates and removal

- **Check for update** (link skills only, a manual button on the library row): the host fetches
  the link again. Same hash: "Up to date", with the time. A new hash: the new content is checked,
  and the person sees what changed (files added, removed and changed; a text diff of `SKILL.md`
  and other changed text files; the gate's and the model review's new and gone findings; new
  endpoints and scripts called out) and which Bots use the skill. Apply pins the new hash;
  Cancel changes nothing. There is no periodic or silent refresh.
- **Replace from file or folder** and **Edit** (text skills) go through the same check and
  diff.
- **Apply time.** A DSH-native Bot uses the new content from its next request (the reconcile
  already remounts edited content, `capabilities.js:486-499`). An ACP Bot uses it from its next
  Session, because the catalog lives in the identity text and a change restarts the agent's
  Session as a role change already does (`apps/acp-dsh/src/host/adapter.js:1657-1661`).
- **Remove from a Bot** (on the Bot's Skills section) detaches it; the library keeps it.
  **Delete** (in the library) detaches it from every Bot and every pack (as
  `capabilityDelete` does today, `capabilities.js:194-205`) and removes its folder. Text a model
  already read stays in that conversation.

### Per Bot: Skills and Add skill

The Bot's Settings (the panel the gear in Details opens) gets a **Skills** card where
`BotCapabilitiesCard` sits today, between Instructions and Tools (`bot-settings.js:400`), in the
existing card, row and button styles; it is always shown, also when the library is empty.

- It lists the Bot's active skills, each with its description as the hint, its check state, and
  a **Remove** button.
- **Add skill** opens a select over the library skills not yet active on this Bot; picking one makes
  it active (the existing `bot-capability` endpoint). Before it is made active, the skill's model
  review findings, or the line saying no second model reviewed it, show beside the pick; the person
  confirms once when there are findings. For a Bot-created skill the gate's findings show there too,
  and one the gate blocks cannot be added by the person (the reason is shown); the Bots that already
  use it keep it ("Bot-created skills"). The button stays to add more. With an empty library, the
  select shows one line that opens Settings → Skills.
- There is no on/off list of the whole library. The Capabilities card keeps its switches for
  MCP servers and packs only; skills leave it.
- A skill that is suspended (blocked by a newer checker) shows why; a Bot-created skill is never
  suspended, and its block shows as a finding; a skill with scripts on a Bot
  whose shell access is off shows "Its scripts need shell access".
- Where the Bot's route gets no delivery yet (the table below), the card says so in one line. A
  Hermes Bot's card says: "Skills do not reach this model yet."
- A skill whose name a newer app version reserved (below) says: "This name is now reserved for
  the /<name> command. Rename the skill in Settings → Skills to use /<name> for it."

### Use: catalog, loading and `/name`

- **Catalog.** A Bot sees its active skills' names and descriptions (at most 300 characters
  each, 8,000 characters in all; above that only names, and Add skill refuses once names alone
  pass the cap). The catalog says: when a task matches a skill, or the person names one, load it
  before acting.
- **Loading.** The body is read on demand, through DSH's `skill` tool where the route has it,
  else by reading the skill's `SKILL.md` from its read-only folder with the agent's own file
  tool. References and scripts are read or run from that folder when the body says so.
- **omp with its native tools off.** That omp can only chat ([RFC 0048](0048-the-solver.md)), so it
  reads no folder. There the host supplies the selected skill's content as text in the turn: a skill
  the person selects with `/<name>` arrives as its `SKILL.md` body in the marked block (below).
  Files beside `SKILL.md` are out of reach in that mode. The person's native-tools setting is kept:
  delivery never turns omp's native tools on or off.
- **Forcing.** `/<name>` at the start of the person's message loads that active skill before the
  turn on every route that has delivery. On ACP routes the host replaces the leading `/<name>`
  with the skill's body in a marked block, so the agent never reads it as one of its own slash
  commands; a `/<word>` that names no active skill passes through unchanged. "Use the skill
  <name>", in any language, is the catalog's rule, followed by the model.
- **A skill wins over an agent's own slash command, except the reserved ones.** When an active
  skill and an agent's own slash command share a name, `/<name>` loads the skill. The exception is
  a closed list of app and agent control commands, which always reach their command and which no
  skill may be named (refused at creation, "What a skill is here"):

  | Reserved name | Whose command, where the code names it |
  |---|---|
  | `side`, `btw` | the app's Side chat (`apps/bots-dsh/src/client/side-model.js:10`) |
  | `login` | the app's sign-in from the chat (`apps/bots-dsh/src/client/login-command.js:40`); omp's `/login` (`apps/acp-dsh/src/host/agents.js:262`) |
  | `model`, `auth` | DSH's sign-in and model choice (`herdr/mods/am-sidebar/dshTui.mjs:7`, `apps/desktop/README.md:74`); Claude Code's `/model` |
  | `setup` | DSH's first-run guide (`herdr/mods/am-sidebar/dshTui.mjs:766`) |
  | `permission` | DSH's permission level ([`docs/rfcs/0031-auto-permission-level.md:327`](0031-auto-permission-level.md#L327)) |
  | `feedback` | DSH's feedback (`apps/bots-dsh/src/client/privacy.js:24`) |
  | `compact` | DSH's and Claude Code's compaction ([`docs/rfcs/0023-dsh-upstream-agent-context-and-chat-rows.md:113`](0023-dsh-upstream-agent-context-and-chat-rows.md#L113), `apps/bots-dsh/src/host/live-chat/decode-claude.test.mjs:172`) |
  | `clear`, `resume` | Claude Code's new and resumed session ([`docs/rfcs/0015-live-chat-projection.md:198`](0015-live-chat-projection.md#L198), [`docs/rfcs/0021-meter-attribution.md:140`](0021-meter-attribution.md#L140)) |
  | `restart` | Claude Code's restart (`herdr/README.md:403`) |
  | `help` | every agent's and DSH's help (named by the business rule) |

  The list is closed and versioned in the code: one exported constant beside the name rule
  (`RESERVED_COMMAND_NAMES` with `RESERVED_COMMANDS_VERSION`, next to `CONNECTOR_IDS` in
  `apps/bots-dsh/src/host/capabilities.js`), with a test that fails on any change that does not
  raise the version. A name is added only by a code change, when an app or agent control
  command is found that the list misses. When a release reserves a name an existing skill
  already has, that skill keeps its catalog entry and loads when the Bot or "use the skill"
  asks for it, `/<name>` reaches the command, and its library row and each Bot card ask the
  person to rename it.
- **Every created skill** can be used this way once it is active on the Bot.

### How a skill reaches each route

| Route | Catalog | Body and files | Delivery |
|---|---|---|---|
| DSH native | DSH's skill catalog (`c.skills.register`) | DSH `skill` tool; files read from the read-only folder | 1 (folders and `/name` checked on the pinned DSH) |
| Claude Code, Codex (ACP), bridge on | identity text (`identity.js`) | the bridge's `skill` tool | 2 |
| Claude Code, Codex (ACP), native tools on | identity text | the agent's own read tool on the read-only folder | 2 |
| Antigravity (ACP) | a preamble block (`apps/acp-dsh/src/host/acp.js:301-305` already sends a preamble where no append exists) | the agent's own read tool | 3 |
| omp (ACP), native tools on | a preamble block | omp's own read tool on the read-only folder | 3 |
| omp (ACP), native tools off (chat only) | a preamble block | the host supplies the selected skill's `SKILL.md` text in the turn; no folder read by the agent | 3 |
| `start_task` Sessions and DSH subagents | as their own route above | as above | 4 |
| am and code workers on this machine | appended to the worker's task text | read-only folder | 5 |
| Hermes Bots | none | none | parked (decided): the standing no-Hermes-work rule; the Bot card says skills do not reach this model |
| Linked machines | none | none | parked: later, as the owner decided |

The list of Antigravity versions proven to load Automatic skills with Native tools off starts empty, so Automatic loading currently needs Native tools on.

The read-only folder is added to the Bot's read scope where one is enforced
(`apps/bots-dsh/src/host/read-scope-provider.js`) and to the read grants of restricted agent
profiles (as the Codex profile already grants its own skills folder,
`apps/acp-dsh/src/host/codex-chat-profiles.js:81`).

### Workers inherit

At launch the host resolves the worker's Bot and takes a snapshot of its active skills: the
names and pinned hashes, never its MCP servers, credentials or role grants. The worker gets the
same catalog and read access to exactly those folders, and keeps its own permissions. A retry or
resume keeps its snapshot; a new worker takes the Bot's current set. Removing a skill stops
future loads only.

- **Delivery 4:** `start_task` Sessions become owned by their opener for skills (from
  `state.tasks[sessionId].from`, `apps/bots-dsh/src/host/agents.js:936-950`), and DSH subagent
  Sessions follow their parent by lineage (`apps/bots-dsh/src/host/bot-sessions.js:6-39`).
  Native subagents inside Claude Code or Codex are told by the catalog to pass the skill's folder
  in the task; this is best effort and is said so in the card.
- **Delivery 5:** am workers whose Bot is a Bot of this machine's team, and
  [RFC 0028](0028-code-workers.md) code workers when `code_start` ships, get the catalog
  appended to their task text (where am already appends fixed lines,
  `herdr/mods/am-sidebar/workers.js:737-767`, copied to `am/workers.js`).
- **Herdr-only bots (decided).** They have no skills until the shared registry can carry them,
  which is its own RFC: the registry never carries `capabilities`
  (`apps/bots-dsh/src/shared/registry.js:51-55`). Workers inherit only from Bots of this
  machine's team.

### Scripts, tools and keys

- A skill grants nothing. Scripts run only through the Bot's own shell tool, under its approval
  level, its denied tools and its read scope; with shell access off they cannot run. Stored files
  never carry an executable bit; the body names the interpreter (`node`, `python3`, `bash`).
- Declared `allowed-tools`, hooks and inline commands are never honoured.
- A skill names an API key only as `$DSH_SECRET_<NAME>`. A typed secret-card value reaches every
  shell call made by a Bot in scope. The host resolves connector credentials for that connector's
  environment or headers. Skills do not depend on #1271. If neither route supplies the key, the
  status reads "Not set for this Bot" and the command gets no value.
  A typed key in a skill blocks it.
- The current business rule that Bots may create skills (`save_capability`,
  `apps/bots-dsh/src/host/tools.js:1545-1572`) is not changed. Their saves are hashed, checked
  and reviewed too, in report-only mode: the findings show in the library, marked "Saved by a
  Bot"; nothing is refused for a finding (see "Bot-created skills"). A learned skill the person
  approves is a person's save.

### Storage and privacy

- Each skill's files live at `<team home>/skills/<name>/<hash>/`, written once, files 0444 and
  folders 0555; the record lives in `state.json` beside today's capability. `state.json` no
  longer carries skill bodies, so the whole-file save stays small.
- The gate check stays local: it runs on the machine and sends nothing. Skill content reaches a
  model provider on two occasions only: the model review, to the background provider and, if the
  background reviewer is unavailable, to the first Main Bot's model provider; and a Bot's use,
  to the provider of that Bot's model
  (its catalog of names and descriptions, and each body or file the Bot loads, as any other
  context). Besides those, only the link fetch goes out, to the link's own host: credential-free,
  HTTPS only, public addresses only (checked on the address actually connected, reusing
  `apps/bots-dsh/src/host/browser/address-policy.js`), each redirect hop re-admitted (at most 3), a
  10-second timeout and a streamed 5 MiB cap (the pattern of
  `apps/bots-dsh/src/host/bounded-get.js:8-40`).
- Skill bodies are in the owner's view only. Caller and member views, the shared Bot registry,
  Pocket and logs never carry them. Logs never carry raw skill text or pastes.

## Contracts introduced

- **Settings page id `skills`** in `SETTINGS_PAGES`; `show_settings` can open it.
- **Stored fields on a capability of kind `skill`:** `hash`; `source` (`kind`: `link`, `file`,
  `text`, `folder`, `bot` or `learned`, with `url`, `ref`, `revision`, `fileName` and
  `fetchedAt` where they apply); `files` (path, size, SHA-256, script mark); `uses` (tools,
  scripts, endpoints, secrets); `check` (`version`, `hash`, `verdict`, `findings`,
  `checkedAt`); `review` (`hash`, `model`, `status`: `done`, `failed`, `none` or `limited`,
  `findings` in the review's output shape, `at`); `authorModel` (a Bot's save and a learned
  skill only); `accepted` (`hash`, `at`); `suspended` (`true` or absent). `content` stays for
  older readers until the move below is done. Compatibility: an item without them is moved at
  load: its text is written as `SKILL.md`, hashed, checked and reviewed ("Existing text skills
  at the upgrade").
- **Reserved command names** `RESERVED_COMMAND_NAMES` and `RESERVED_COMMANDS_VERSION` in
  `apps/bots-dsh/src/host/capabilities.js`, beside `CONNECTOR_IDS` and read by
  `validateCapabilityName`; a closed, versioned list (under "Use"). A reserved name is refused
  at creation with this exact text: `The name "<name>" is reserved for the /<name> command of
  the app or an agent. Choose another name.`
- **The model review's output shape** `{"findings":[{"file","line","area","severity","reason"}]}`
  and its fixed English prompt, versioned with the review (`review.model` records the model).
- **Folder** `<team home>/skills/`, with `.staging/` inside it.
- **Owner-only endpoints** `skill-preview` (link, file, text or folder in; findings, uses and a
  staging token out; nothing stored; the model review runs after it and its result is read with
  `skill-review` by staging token or hash), `skill-save`, `skill-update-check`,
  `skill-update-apply`, `skill-replace` and `skill-delete`, each listed in the caller-endpoint
  inventory. Attaching and removing keep `bot-capability`.
- **Identity block** `<available_skills>` in acp-dsh's identity text (delivery 2) and preamble
  (delivery 3); a change in it starts a new agent Session at the next turn.
- **The `/<name>` rewrite** on ACP prompts (delivery 2), never for a reserved name.
- **Worker snapshot** `<team home>/skills/.bots/<botId>.json` (names, hashes, folders), written by
  bots-dsh and read by am (delivery 5), read-only to workers. The leading dot keeps it apart from
  skill folders: no skill name can be `.bots`.
- The check's rule ids and its version are internal; findings shown to the person are English
  with zh and pt-BR strings.

## Threat model

New trust boundaries: content from the internet (link), from the person's disk (file, folder) and
from a paste, all turned into instructions a Bot follows.

- **Who reaches it.** Only the person, through owner-only endpoints in their own window. A Bot
  keeps only today's `save_capability` and `attach_capability`.
- **Prompt injection.** By design a skill is instructions. The check blocks known hostile shapes
  and lists the rest; the preview shows the full text; reviewed text never grants a tool, a
  folder or a level.
- **Secrets.** Key shapes block. A skill names a key only as `$DSH_SECRET_<NAME>`. Until a vault
  delivery ships, the existing secret card or connector env/header routes supply the value. Skills
  do not depend on #1271. When neither route supplies it, the status reads "Not set for this Bot"
  and the command gets no value. A shell command can therefore read a card value even when the
  skill never names that key. Vault's per-execution grant does not apply to typed card values.
- **A second opinion, never a gate.** The model review reads the skill's content only, in a
  history-less call with no tools, so an injected skill cannot act through it: it can at worst
  write wrong findings. It cannot pass what the gate blocks, and its output is checked against a
  fixed shape. A hostile skill that talks the reviewer into "No concerns found" still meets the
  gate. Its content reaches only the provider of the person's own reviewing model, and a key the
  gate missed would reach it too, as it would reach any Bot that loads the skill.
- **Name clashes.** A skill can never hide a reserved control command: the name is refused at
  creation and `/<reserved>` always reaches its command, so a skill cannot take over `/clear`,
  `/compact`, `/model`, `/permission` or the like.
- **SSRF and fetch abuse.** The fetch is the host's own, never the Bot's tools, under the rules
  in "Storage and privacy".
- **Archive and folder escape, zip bombs.** Paths, links, counts and expanded bytes are checked
  before anything is written outside the staging folder, as
  `apps/bots-dsh/src/host/role-tar.js:5-18` does for roles.
- **Changed after approval.** The pinned hash is what runs; a link update needs the person's
  Apply; Save uses the staged bytes (no fetch between preview and save).
- **Scripts.** They run only under the Bot's shell, level and approvals; no executable bit.
- **Undo.** Remove the skill from the Bot, or delete it from the library; reverting a release
  removes the page and the section, and the library records stay in `state.json`.

## Deliveries

All plugin lane (3.N.P) unless named. Each delivery ships only when its parity rows pass on every
route it names.

1. **D1, the library and Add skill.** a) the skill record, content-addressed store and move of
   today's text skills; b) the security check (the gate), pinned by hash, and the model review
   on a different model; c) Settings → Skills with Text and File, and the reserved-name refusal
   at creation; d) Folder and archives; e) Link and Check for update; f) the Bot's Skills section
   with Add skill (showing the review's findings), Remove and `/name` on DSH-native Bots, folder
   files readable there. Acceptance: on the installed app, a skill made each of the four ways is
   checked, reviewed, previewed and saved; a key in it blocks whatever the review says; with no
   second model available the preview says only the local check ran; a skill named `compact` is
   refused with the reason; a DSH-native Bot with it active loads it on a matching task and on
   `/<name>`; an update shows its diff and the review's findings and needs Apply. Rollback:
   reverting removes the page and the section; stored folders and records stay and are ignored.
2. **D2, Claude Code and Codex.** The catalog in the identity text, bodies through the bridge
   or the read-only folder in native-tools mode, the `/<name>` rewrite. Acceptance: two Bots with
   different marker skills; each loads its own marker on both tool modes and cannot reach the
   other's. Rollback: the identity text loses the block.
3. **D3, Antigravity and omp.** The catalog as a preamble block; folder reads on Antigravity and on
   omp with native tools on; on omp with native tools off, the host supplies the selected skill's
   text in the turn. Acceptance: two Bots with different marker skills, on Antigravity and on omp in
   both tool modes. On Antigravity and on omp with native tools on, each loads its own marker from
   its folder and cannot reach the other's. On omp with native tools off, `/<name>` puts its own
   marker skill's text in the turn, the agent reads no folder, the other Bot's skill never reaches
   it, and the person's native-tools setting is unchanged. Rollback: no preamble block.
4. **D4, Bot-started Sessions.** `start_task` Sessions and DSH subagents inherit. Acceptance: a
   task and a subagent of a Bot load its marker skill; another Bot's task cannot. Rollback: tasks
   lose the skills again.
5. **D5, workers on this machine.** a) bots-dsh writes the worker snapshot (plugin lane);
   b) am appends the catalog to a worker's task (herdr lane, the pack's `workers.js`, am's copy
   through `scripts/am-copies.mjs`). Code workers join when
   [RFC 0028](0028-code-workers.md)'s `code_start` ships.
   Acceptance: an am worker of a Bot loads its marker skill. Rollback: workers get no catalog.

Parked, one line each: Hermes Bots (the standing no-Hermes-work rule); workers on linked machines
(later, by the owner's decision); private links that need a token; Herdr-only bots (their own
RFC); nothing here needs DSH, herdr-core or another repository.

## Decisions

Ruled by the lead on 2026-11-24; each is folded into the Design above.

1. **Existing text skills at the upgrade:** moved and checked once; one that blocks is suspended
   with a notice, and the person fixes it by editing.
2. **Bot-created skills:** checked and reviewed in report-only mode, as the current business
   rule stands; enforcing it is the rule owner's call, later.
3. **Hermes Bots:** stay parked; their Skills card says skills do not reach this model.
4. **Skill names and slash commands:** a skill wins over an agent's own slash command, except a
   closed, versioned list of reserved app and agent control commands, and a skill with a reserved
   name is refused at creation with the reason.
5. **Private links that need a token:** not in this RFC; public links only.
6. **Model-assisted review:** added on top of the local deterministic check, which stays the
   gate; it runs as a fresh call on a different model when one is available (else the gate alone,
   and the person is told), shows its findings before activation or Apply, never passes what the
   gate blocks, and only reports on Bot-created skills.
7. **Herdr-only bots:** no skills until the shared registry can carry them (its own RFC); workers
   inherit only from Bots of this machine's team.
8. **Limits:** 64 KiB `SKILL.md`, 256 files, 1 MiB per file, 5 MiB in all, an 8,000-character
   catalog.

Amendment (2026-11-24): keys are supplied through the existing secret card or connector env/header
routes until a vault delivery ships; Skills do not depend on #1271.

## Links

[RFC 0003](0003-model-routes-and-acp.md) (model routes and ACP),
[RFC 0014](0014-shared-bot-registry.md) (shared Bot registry),
[RFC 0028](0028-code-workers.md) (code workers),
[RFC 0034](0034-vault-plugin-bitwarden-first.md) (Vault) and #1271,
[RFC 0037](0037-roles-not-types.md) (roles),
[RFC 0043](0043-accounts-across-linked-machines.md) (linked machines).

## Amendments (2026-11-24, R49-1..R49-5)

- R49-1 ("The model review", "A different model"): the existing background-model selection is used
  once; when that model is unavailable or is the known author's, there is no review call,
  `review.status` is `none`, the gate runs alone and the person is told with the existing notice.
  The fallback to "the next available model in DSH's default order" is gone.
- R49-2 ("The security check" and "Per Bot: Skills and Add skill"): the Bot-created exception is
  stated for delivery (a block does not withhold it), recheck (never suspended) and activation (the
  gate's and the review's findings show before a person activates it; the person's Add skill refuses
  a blocked one); existing Bot use is kept; hash integrity and the reserved-name rule stay mandatory
  for every skill.
- R49-3 ("Use", "How a skill reaches each route", "Deliveries" D3): the omp row is split by tool
  mode; with native tools off the host supplies the selected skill's text in the turn and the agent
  reads no folder; the person's native-tools setting is kept; D3's acceptance names both modes.
- R49-4 ("Scripts, tools and keys", "Threat model"): skills name keys only as `$DSH_SECRET_<NAME>`.
  The existing secret card or connector env/header routes supply the value until a vault delivery
  ships. Skills do not depend on #1271. The status reads "Not set for this Bot" when neither route
  supplies the key, and a typed key in a skill blocks it.
- R49-5 ("Storage and privacy", "The model review"): the gate check stays local; skill content
  reaches a model provider on two named occasions only, the background review and a Bot's use.

- R49D-1 (2026-11-24): the Secrets row and check table use "Not set for this Bot" when neither
  route supplies the key. The status does not affect the pinned verdict.
- R49D-2 (2026-11-24): the size limits are mandatory before save for every new or edited skill, Bot
  saves included.
