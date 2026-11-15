# @automagik/bots-dsh

Omni for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): a team of long-lived Bots that talk to you, to each other and in group chats, with Omni as the Main Bot. With the Omni channels plugin, Omni also operates your Omni channels, chats and automations inside dsh; with the Omni canvas plugin, it shows what it found as live views in the chat (see [Three plugins](#three-plugins)). It is built on [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) (Apache-2.0, see `VENDORED.md`).

> Labs release. Features, tools and the saved data format can still change.

The dsh versions it supports are the range in `engines.dsh` in its [`package.json`](package.json); dsh checks that range and does not load the plugin on a version outside it.

**Your own dsh stays yours.** Installed into an existing dsh, the team keeps its files in `$AUTOMAGIK_HOME/bots` (`~/.automagik/bots`), keeps the key of the Omni it is linked to in its own file there, uses its own route (`/api/omni-ui`), plugin id (`omni-ui`) and browser-storage prefix (`omni-ui:`), overrides no other plugin's configuration, and checks for no updates. It can run beside upstream DS Bot.

## Three plugins

Omni for dsh is three packages. This one is the team; the other two sit on it and add Omni's own parts. Install all three to have everything; the team works alone.

| Package | Folder | Row id | What it adds |
|---|---|---|---|
| `@automagik/bots-dsh` (this one) | `apps/bots-dsh` | `omni-ui` | The Bot team and its surface: Bots, group chats, settings, themes, interface copy, memory, secrets, usage, scheduled tasks, the Bot browser, updates, diagnostics, the `POST /api/omni-ui` route, and the `web-search` plugin |
| `@automagik/omni-channels-dsh` | [`apps/omni-channels-dsh` in Omni](https://github.com/automagik-si/omni/tree/dev/apps/omni-channels-dsh#readme) | `omni-channels` | The link to an Omni (pairing, `omni.json`), the Channels page and chats, Omni's tools for the platform (and the shell and file tools a Main Bot loses for them), the events Omni listens to, automations and their board, Omni's operator rules, and the onboarding step Connect Omni (`omni-connect`) |
| `@automagik/omni-canvas-dsh` | [`apps/omni-canvas-dsh` in Omni](https://github.com/automagik-si/omni/tree/dev/apps/omni-canvas-dsh#readme) | `omni-canvas` | `show_canvas`, the canvas check, the canvas language in Omni's rules, and the renderer that draws canvases in the chat (OpenUI and zod live only here) |

How they fit:

- **Host**: this plugin provides its runtime as the `omniTeam` service. The channels plugin injects it, installs its modules on a runtime whose prototype is the team's, and provides that one as `omniChannels`; the canvas plugin injects both and sits on the channels runtime. Each plugin's tools, listeners and effects stay on its own fiber, and it adds to the team only through `rt.hooks` (`src/host/extend.js`): `endpoint(name, fn, { read })` for the `/api/omni-ui` route, `view(fn)` and `live(fn)` for the state answers, `sessionOwner(fn)` for the team Bot and optional label of an external run Session, and `mainRules(fn, { order })` for a part of the Main Bot's rules, which stay inside the one `bot-identity` section. A plugin that runs a Bot kind on its own engine, not on a DSH model, owns that kind's model menu with `botModels(kind, { snapshot, pick, refresh })` (`src/host/host-models.js` has the shape): the team then never selects a DSH model for those Bots (their settings and `list_bots` name what the plugin says answers), their menu lists only the plugin's entries (each with where a message goes, the one picked and the one answering now) and levels, and only you pick; a Bot's `update_bot` with a model or level is refused. Without a registration the team answers as before. Each hook returns its disposer, so turning a plugin off takes what it added with it. Five more parts of the runtime are for other plugins:
  - `rt.resumable.register({ id, sessions, onResume })` hands the team's one restart pass (`src/host/resume.js`) the plain Sessions a plugin owns: `sessions()` names them when the pass runs, `onResume({ sessionId })` runs right before the team posts a resume to one of them (whoever found it), and the registration returns its disposer. Every resume post carries `source.resumed === true`.
  - `rt.resumesDone` is one promise per start that never rejects: `{ resumed, resent }` after the pass, `{ readOnly, resumed: [], resent: [] }` on a host that only reads the team, `{ failed, resumed, resent }` when it threw or stopped. `resumed` lists every Session the pass resumed, `resent` every Session it sent dropped messages again.
  - `rt.noteStop(sessionId, { why, tool, callId, text })` notes a permission stop for the person; `rt.teamOwnerOf(sessionId, agent)` resolves the team Bot and place, including a subagent's parent. Plugins can feature-detect both. Reasons are `never`, `unavailable`, `tool`, `level`, `address`, `review`, `sandbox` and `rule`; external grants and guards use `rule`.
  - `rt.dshBots`: `list()` gives `[{ id, name, workDir, profile }]` (`null`: the team workspace, DSH's default preset), `createSession(botId, { title, firstMessage })` gives `{ sessionId }` in that DSH bot's folder with its preset, and `onChange(fn)` calls `fn(list)` when the list changes and returns its disposer.
  - `rt.mountCapability(sessionId, name, grant)` and `rt.unmountCapability(sessionId, name)` mount one MCP capability into one plain Session the plugin owns, and only there ([A capability for one Session](#a-capability-for-one-session)).
- **Browser**: this plugin's `client.js` exports `omni`: the host call, the interface copy (`t`, `addStrings`), the Bot surface's registries (`toolCards`, `nav`, `badges`, `botChildren`, `headerButtons`, `sidebarTools`, `botSettings`, `onShell`, `setCanvasRenderer`, `registerComposerPack`), the running surface (`face`) and a few UI pieces (`ui`). The other plugins name `@automagik/bots-dsh/client` in `dsh.client.external`, so dsh loads this bundle first and hands them the same module instance: one dictionary, one roster, one set of registries.
- **Composer**: a Bot's composer changes with the model it runs on (`src/client/composer-packs.js`). Every Bot's chat shows the model that Bot runs on in its own model menu, which saves to that Bot alone: with thinking levels when the model has them, and on an agent over ACP (`acp-claude`, `acp-codex`) with the levels the agent offers for that model, or without any when it offers none. On a Bot whose plugin owns its model menu, it shows that menu. A group chat, where each member runs on its own model, and a Bot still waiting for its model show none. The plan cell and the activity and usage docks stay Omni's in every pack. Other plugins add a pack with `omni.registerComposerPack({ id, order, match(provider, target), available(env), cells: { permission, model }, hostFor })`.
- **Data**: all three keep the team's one `state.json` and its lock (automations ride it); `omni.json` is the channels plugin's, in the same folder.
- **Upgrading from one package**: a team linked to an Omni whose dsh has only this plugin shows a card in the sidebar footer that points to the plugin market for the channels plugin.

## Features

- **Long-lived Bots**: each Bot is a dsh Session in the "DS Bot" workspace, with its own name, role, instructions and model.
- **Working folders**: a Bot can work in a folder you choose instead of the team workspace, and a group chat can set one folder for all its members there. Pick it in the Bot's settings or details panel or in the group's settings, or ask a Bot (`update_bot`, `update_group`). After a change, the chat goes on in a fresh part that starts in the new folder. When a Bot sets a folder outside the team workspace, or adds a Bot to a group that works in one, it asks for your approval if those Bots can only write in their folder. Folders that hold dsh data (`$DSH_HOME`, the team's data) are refused. The team workspace itself moves in Settings > General > Locations; Bots and groups that work there go on in a fresh part in the new folder, and the old folder keeps its files.
- **Permission presets**: each Bot runs with its own dsh permission preset (Read only, Workspace or Full access), set in its details panel. A group chat can run all its members with one preset there, in place of their own: turn on **Same for every member** under Permissions in the group's settings. A new Bot starts with the team default, set under Permissions in Settings > Bots. Work a Bot opens never runs wider than the conversation that opens it. A task (`start_task`, a Genie wish) runs at the narrower of its own level and the level that conversation runs at when it starts it, such as a chat lowered with `/permission` or a read-only automation run. A Bot made with `create_bot` starts at the narrowest of its creator's level, that conversation's and its group's, and never gets a tool its creator does not have. A fresh Session a Bot's scheduled task opens starts no wider than that Bot. While a task you scheduled yourself also opens fresh Sessions, DeepSeek Harness does not say which task a fresh Session is for, so those keep the level they start with. A level that cannot be read or compared gives the narrowest one offered. What you start yourself is as before. While DSH's experimental Auto review plugin is on, **Auto review** is a preset too, marked Experimental and confirmed once when picked. Where Auto cannot hold (the plugin is off, or DSH refuses it), the Bot or group runs as Workspace and says so; a chat whose Session was left on Auto opens again once Auto review is back on. When DSH stops offering a saved level (an upgrade renames or drops it), the level stays saved and is not rewritten: a conversation that already runs is lowered to the narrowest level DSH still offers when that is known to allow less than what it has, and is otherwise left as it is; nothing new starts (a task, a greeting, a first turn in a group) until a level is picked or DSH offers the saved one again. Details and Settings → Feedback say which of these happened. Only you set permissions; Bots cannot change them.

  Auto works as Workspace on every supported route. Codex uses its own reviewer and Claude Code uses its `auto` mode. API Bots use their own model in a separate request for sandbox escalations; a granted step can leave the sandbox. Hermes, Antigravity and omp use the team's background model and are offered Auto only while one is available. Their own tools run outside DSH's sandbox.
  For bridged Codex and Claude Code, the team's background model decides DSH tool calls. If the CLI asks for permission, the rest of that prompt's bridge calls reach the person. Without a background model, bridge calls reach the person. Hard-to-undo steps and the rest of a turn after three consecutive refusals or ten total refusals always reach the person when Automagik judges. Plugin, folder and website approvals remain with the person. A request the judge decides never shows as a card, on the computer or on Pocket; only one it passes on does. A model failure asks; it never allows. Only the person turns Auto on. API marks bind the exact model; native agent marks bind their route. Bots outside Auto keep their existing behavior.

  **Auto** is Workspace plus a saved mark, chosen only by you after a confirmation in Details,
  the composer menu or the chat's permission card; the question names who decides for that Bot.
  Every message reaching the Bot's current chat counts, including another Bot's or a schedule's.
  Auto needs Workspace in the Session and this host holding the team;
  otherwise the saved choice says **Runs as Workspace here**. Picking any level, Workspace again
  included, ends Auto and its agent sessions; route and model changes clear it too.
  Deny lists coexist with Auto: changing one keeps the mark, moves the permission revision
  and ends agent sessions and outstanding grants. DSH refuses native/API and bridged denied
  calls whatever the judge says. Unbridged CLI built-ins and team agents’ own tools were
  never covered at Workspace either; they need to use DSH’s bridge for the deny to reach them.
  Tasks and Bots opened from that chat while Auto counts there inherit it; an inherited task
  counts only while the opener's mark and permission revision match. Groups, Settings and the
  team default offer no Auto row.
- **Permission stops**: a stopped step shows in the sidebar and Live rail, beside its tool call or in its group round, and on a working task card. Stops outside the visible conversation get a system notification where notifications are already allowed; a child or late group stop also notifies when that conversation cannot draw it. Pocket shows an English hint at the end of an own-chat turn. Stops live in memory and are lost on restart. The first stop per reason and turn also adds one diagnostics line in Settings → Feedback. A refusal nobody answered tells the Bot so, Auto review's final denial gives its reason, a subagent's unasked refusals reach its parent, and a coding CLI's held turn answers in the interface language.
- **Subagents**: in-process children of Read only, Workspace and Auto review Bots keep that level with approval prompts on, without changing their captured sandbox. Their asks appear above the composer of the Bot's chat or task (open it from the task card), or in the group member card; the sidebar, Live rail and notifications also show that they wait. Children keep DSH's refusal, shown as a permission stop, when their Bot runs at Full access, with approval prompts off, or at a custom or unknown level; when the Bot's level changed while the child was being created; when a resumed child has its prompts off; and when they belong to an automation run, a plugin Session, an earlier part or an ended task. An ask nothing here can answer is cancelled and noted as a stop. The phone does not show child asks.
- **Hard steps and repeated refusals**: at Read only, Workspace and DSH Auto review,
  recursive deletes, force pushes, remote branch deletes, hard resets and cleans,
  infrastructure destroys, database drops, file-tool deletes and deleting a Bot or group,
  secret files/token commands, external messages, shared or ambiguous pushes, and deletes
  outside the Bot’s folder ask the person when the existing tool gate allows them. Children follow the same check.
  Read-only team lookups such as `recall` do not ask just because their arguments mention a hard step.
  Auto also asks about these steps inside its Workspace boundary; its judge keeps its own counts.
  Plugins classify external senders through `rt.stepHooks.sendsOutside(fn)`; a failed hook asks.
  Ordinary example env files, public SSH keys, feature-branch pushes with an explicit
  destination and local file deletes stay out of the added list; a bare `git push` or a
  destination of `HEAD` asks. Exact boundaries are in RFC 0031’s #1092 amendment.
  The judge’s deadline covers model lookup too; grants bind arguments. `rt.autoAuditRows()`
  exposes its last 200 decisions without arguments, including allows, outside the failures list.
  After three consecutive automatic refusals or ten in a turn, the next refusal asks
  “Let it keep working?” Allow once only lets work continue: nothing refused runs.
  Reject stops the Bot for that turn. If approvals are off or no chat, group seat or working
  task can show the question, work stops with a reason and an automatic-stop notification
  when that host hook is available. Full access is unchanged.
  Unbridged Claude Code gets session-only ask rules for expressible hard steps at every
  asking level, removed by restarting its session across Full access. Bridged Claude has no
  Bash of its own: its DSH calls use the checks above. Codex's own tools are excluded:
  prompt rules under its Full access `never` policy refuse instead of asking, rules have no
  per-session path, and its `agent` mode sends prompt rules to its reviewer, not the person.
  This is an unmet dependency: Codex built-ins run without `session/request_permission`.
  Enforcing the list needs a mandatory per-session ask policy before its reviewer or a blocking
  pre-execution request with tool, arguments and cwd. Claude wildcard rules cannot express
  outside-folder deletes or ambiguous push targets either; those need a bridge or richer policy.

- **Bots work together**: `message_bot` sends a message to another Bot, `create_bot`, `update_bot` and `delete_bot` add, set up and remove Bots (including a profile photo from a local image file or a data URL), and `ask_user` asks you a question without blocking the other Bots. `show_view` draws a card in a Bot's own chat — text, metrics, tables, progress, choices, confirmations and short forms; an interactive card waits for your answer.
- **Group chats**: members speak one at a time, and each one reads the latest messages first. A message can `@Name` a member to pass the turn on; type `@` to pick one from a list. **+ → Reference a chat** adds another Bot's chat to a message as context, and in a group the members who answer get it. A member with nothing new to add stays quiet (`[PASS]`). Each member has its own hidden Session per group, so a group never reads a Bot's private chat.
- **Roles and permissions**:

  | Who | Can do |
  |---|---|
  | You | Everything |
  | Main Bot (there can be more than one) | Manage every group; change and delete Bots |
  | Group admin | Manage its own group only (name, notice, members, reply mode) |
  | Member | Speak in the group, `@` another member, and post into its groups from outside them |

- **Scheduled tasks and restricted Bots**: a Bot with a deny list cannot create or
  edit a scheduled task, because a `new` or `new_once` target opens a Session no deny
  layer binds; the tasks it already armed are paused and their record stays. A
  delivery no team lineage can bind is refused while such a task cannot be paused;
  when the pause lands, dsh is asked to drive again and the refused delivery goes
  through. A reminder due during the boot window, before the team has loaded, is
  refused the same way and lands once the team loads.
- **Long chats stay inside the model's window**: dsh's own compaction never runs on a Bot's Session. When a turn ends past the check line (a share of the model's context window), a small separate model call, the context steward, reads the latest messages of the chat and decides once. If the work is still under way, the chat is condensed in place into a checkpoint: a handoff summary plus your recent messages word for word. If the work has reached a stopping point, the Bot writes a handoff note and continues in a new part. Either way you still see one chat, with no marker. Earlier parts and condensed messages stay searchable in a full-text index (`node:sqlite` FTS5) through `read_own_chat`. These side calls (steward, note, checkpoint) never go to an agent over ACP (Claude Code, Codex): they run on the team's background model, and a Bot with no model that answers beside its agent skips them, says so once in the log, and past the hard line continues in a new part that carries its latest messages word for word, without a model call. Switching a Bot from an agent to an API model measures the chat against that model's own switch threshold (computed as DSH's compaction does) before DSH checks it: below it nothing happens; above it, the chat is condensed into a checkpoint only when you picked a background model in Settings and the chat fits that model (it is the one charged), and otherwise the Bot continues in a new part with the latest messages that fit, no note and no model call. The part it leaves is archived only once the new part's first answer comes from the chosen model; if that first call fails, the Bot goes back to the part it left. No message is deleted either way.
- **Memory**: each Bot keeps notes across all its conversations, each group chat keeps its own for its members, and the team shares one more. See [Memory](#memory).
- **Web search**: see [Web search](#web-search).
- **Bot browser**: each Bot drives a browser of its own: it opens pages, clicks, types, uploads and downloads. Posting, uploading, downloading and deleting ask you first, and payments always come back to you. See [Bot browser](#bot-browser).
- **Side chat**: ask a Bot about its work while it runs, in the side panel (`/side`, or `/btw` as before), without stopping its turn or adding to its chat. Nothing runs to answer.
- **Images**: for a model that cannot read images, a vision model first turns the image into text.
- **Secrets**: a Bot asks for an API key or token with a card in its own chat and never sees the value. See [Secrets](#secrets).
- **Usage**: Settings → Usage shows token usage by time (24 hours to 12 months, or days picked on a calendar), by Bot and by model, with a page for each Bot and each model. Calls that a Session logs are read from the logs, so older chats count too. Calls that leave no log (checkpoints, handoff notes, the steward, image readings, dsh titles and compaction) are counted while they stream, from the time the plugin runs. Legacy aggregates can omit provider fields; they do not claim a cross-provider cache percentage. Tokens only, no cost.
- **Official right sidebar**: every Bot chat can open Live as a tab in DSH's own pane, rather than a second fixed rail. DSH owns its collapse, focus, docking and narrow-screen behavior. Existing Browser, side-chat and plugin routes remain available.
- **Advanced Bot**: Bot Settings has a per-Bot switch, initially off and saved across parts and restarts. It reveals supported native session controls, Context and Stats without changing identity, permissions, model access or context policy. Models and permissions remain managed by the canonical Bot controls. Ordinary DSH keeps its native conversation surface.
- **Advanced Context**: shows current part/checkpoint boundaries, measured or estimated usage and effective usable/check/hard windows. Per-Bot check threshold and recent-message carry budget override host defaults (80% and 16,384 tokens); the 95% hard safety threshold is protected and effective carry is additionally capped by the check line. **Checkpoint now** requires an idle, loaded own-chat Session and condenses that same Session through Bot maintenance; stale, running, cancelled or read-only requests fail rather than bypass the native guard. **Start new part** is separate, confirmed and carries nothing from the old part. Native manual Bot compaction remains unavailable, with an explanation. Automatic memory review has separate own-chat controls/status and no guaranteed ordering with compaction; a host-wide off setting cannot be overridden.
- **Advanced Stats**: read-only last-request, last-turn, current-Session and Bot-total scopes show input/output/cache read/cache write, logical calls, recorded attempts and retries where reported. Session drilldown is limited to that Bot's own-chat parts; Bot totals partition group, task/child and tagged memory/steward/checkpoint/handoff overhead without adding overlapping scopes together. Unlinked overhead is not guessed into a request or turn. Missing is **Unknown**, not zero; legacy provenance cannot be reconstructed. Cache ratios are token-weighted within compatible, explicitly identified provider normalization, with their prompt-token denominator displayed; providers are never averaged together. Refresh may update the derived ledger but never runs a model or changes a Session. Partial history is labeled. No cost, timing, task-success or native-DSH effectiveness comparison is inferred.
- **DSH bots**: New… → New DSH bot creates a native DSH identity with a name, project folder and preset, and immediately adds team membership: the native DSH conversation UI and tooling stay available alongside roster, messages, groups and browser access. It has the same final shape as adopting an existing DSH bot, with one sidebar row and a retained original registration. Membership failure fails creation and cleans up the new registration and Session. If archival or required persistence is unavailable, a durable pending-creation registration retains ownership and tool restrictions, stays hidden from both rosters, and retries cleanup on the next load (including restart). The error reports pending cleanup; it never reports successful standalone creation. Cleanup waits for an operation-bound terminal receipt in `agent-creations/<UUID>.json`, published atomically by the allocation's producer only after native creation settles—even if that producer lost the team lock or was disposed. This receipt contains only operation and Session IDs plus outcome, grants no team-write or archival authority, and is removed after durable membership or cleanup. Missing/invalid receipts (including a hard kill before publication or receipt persistence failure) retain hidden pending ownership rather than guessing that an absent Session cannot appear later; back up `agent-creations/` with the team file while creation is pending. Cleanup is claimed durably before archival so an old producer cannot re-adopt an archived Session. DSH archival and the team file are not atomic: a failed post-archive save can temporarily retain a pending reference to an archived Session, which idempotent retry removes. For compatibility, legacy `add-agent` callers without `teamMember: true` and `rt.dshBots` keep the standalone DSH registration/session contract (no team tools); the UI explicitly opts into membership. A Bot's one-off work (`start_task`) runs under that Bot and reports back when its first turn ends.
- **Adopting a DSH bot**: **Adopt as Bot** adds team membership without replacing the DSH identity, native conversation surface, preset, avatar or capabilities. The newest Session becomes its team chat and earlier Sessions remain readable parts; nothing is renamed or recreated. `list_bots`, messages, groups, capabilities and tasks become available. Fresh parts, group member Sessions and tasks inherit its preset. The original DSH registration stays saved with an `adoptedBotId` reference, but is hidden from the standalone roster to avoid duplicate rows.
  - **Rollback**: the local `POST /api/omni-ui` endpoint `agent-bot-rollback`, payload `{ "agentId": "<original DSH id>" }`, removes only the added membership and restores the original registration and team-tool restrictions. It does not archive Sessions. Remove Main Bot/group roles first; rollback refuses new parts or tasks rather than discarding new team history. Ordinary Bot deletion refuses adopted registrations; roll back first. A failed adoption/rollback save restores the pre-operation records. This cannot reconstruct identities already removed by the older destructive implementation: those require the original registration from a backup and verified preset/avatar information; no identity is inferred from a Bot's name.
- **Make it yours**: name, role, instructions, model and look (20 characters and 12 colors, or a photo from the ones you added) for each Bot. An adopted DSH identity wears DSH's blue whale until it has a look of its own; ordinary Bots retain their identity-derived defaults and a Genie keeps its genie-clay pet; a theme, an accent color and an avatar animation level (quiet, normal or lively) for the team. A pinned Bot or group chat shows a small pushpin in the sidebar. Settings has these pages: General (look), Bots (Main Bots and each Bot's settings), Group chats (each group's settings), Connectors, Capabilities, Scheduled tasks, Usage, Secrets, Feedback and About DS Bot (versions, updates and links).

## Install

The [project page](../../README.md#install) has the full steps for dsh Desktop and dsh Web. In short:

- dsh Desktop: Settings → Plugins → add a `.tgz` of this package (`npm pack` in this folder).
- Command line: `dsh plugin --profile web add /path/to/automagik-bots-dsh-<version>.tgz`.
- Or skip dsh setup entirely: the Automagik desktop app ([`apps/desktop`](../desktop/README.md), `omni desktop` from Omni's CLI) ships dsh with this plugin on a home of its own.

To work on the plugins from a checkout, add them to a dsh profile as linked dependencies and bundles (the channels and canvas plugins are optional):

```json
{
  "dependencies": {
    "@automagik/bots-dsh": "link:/path/to/apps/bots-dsh",
    "@automagik/omni-channels-dsh": "link:/path/to/omni/apps/omni-channels-dsh",
    "@automagik/omni-canvas-dsh": "link:/path/to/omni/apps/omni-canvas-dsh"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@automagik/bots-dsh", "@automagik/omni-channels-dsh", "@automagik/omni-canvas-dsh"] } }
}
```

Run `pnpm install` in the profile folder, then start dsh from the deepseek-harness repository:

```sh
pnpm -s dsh --profile web --no-open
```

The first time the team opens, the plugin creates a Main Bot called Omni.

**Upgrading from the `ds-bot` builds of the Omni UI**: earlier builds were named `ds-bot` with the plugin id `bot` and kept the team in `~/.dsh/bot`. Replace `ds-bot` with `@automagik/bots-dsh` in the profile, and set `importHome: ~/.dsh/bot` once (see [Configuration](#configuration)) to copy that team into `~/.omni/ui`; the old folder is left as it was. Browser settings saved under `ds-bot:` are not carried over, because DS Bot uses the same names.

## Connect to an Omni

This needs the Omni channels plugin. On the Channels page, type the address of an Omni (for example `omni.example.com`) and choose **Get a code**. Omni answers with a short code and the WhatsApp number of its pairing channel; send the code to yourself from that WhatsApp ("Message yourself"; **Open WhatsApp** or the QR opens the chat with the code typed). The page goes live as soon as the code arrives. The Omni must have pairing turned on (`OMNI_PAIRING_ENABLED=true` and a pairing instance on the server).

The key Omni mints is saved in `~/.automagik/bots/omni.json` (readable by you only), with the scopes the server gives paired keys and an expiry; it never reaches the browser. Delete that file to disconnect; revoke the key in Omni to cut it off from the server side. A profile can still name an Omni the older way, with `omni.url` in this plugin's config (or the channels plugin's) and the `OMNI_API_KEY` credential in dsh's store; a saved link wins over both.

## Configuration

Options go in the profile's `cordis.patch.yml`, under the `omni-ui` entry. All of them are optional.

```yaml
- id: omni-ui
  name: '@automagik/bots-dsh'
  config:
    workspace: /path/to/workspace   # where the Bots work; default <home>/workspace
    home: /path/to/team-data       # where the team is saved; default $AUTOMAGIK_BOTS_HOME, else $AUTOMAGIK_HOME/bots (~/.automagik/bots)
    importHome: ~/.dsh/bot          # copy a team saved there into home once, when home has none
    checkRatio: 0.8                 # share of the model's usable window where the steward decides
    browser: true                   # force the browser panel and read_browser on or off; default both in dsh Desktop, the panel alone in the Automagik app
    browserPlugin: refs             # the browser each Bot drives: refs (default), script or task; false turns it off
    browserExecutablePath: /usr/bin/google-chrome   # the browser it launches; default the first Chrome, Edge, Chromium or Brave found
    browserHeadless: false          # default: headless only on Linux without a display
    memory: true                    # false turns memory off: no memory tools, section or panel
    memoryReview: true              # false leaves memory to the Bots' own remember calls
    fallback: true                  # false lets a failed model end the turn instead of moving it to the fallback
    fallbackModel: deepseek-official/deepseek-flash   # where a failed turn moves; default the team's default model
    diagnosticsFile: false          # keep the error log in memory only; default <home>/logs/diagnostics.jsonl
    updateCheck: false              # the package's own patch sets false: nothing is checked or installed
    updateRegistry: https://registry.example/   # ask only this npm registry for updates
    github: false                   # hide the GitHub connector; default shown in Connectors
    appManifest:                    # the web app's name; default Automagik, false keeps DSH's own
      name: Automagik
      short_name: Automagik
      theme_color: '#1a1a2e'        # optional, a #hex color (also background_color)
      icon: /absolute/path/icon.svg # optional, an .svg or .png; default the Automagik app icon
```

**The web app's name**: DSH's page calls itself "DeepSeek Harness", in its manifest (what a browser shows when you install the page as an app) and in its `<title>`. With this plugin it is "Automagik": the plugin serves `/manifest.webmanifest` (`application/manifest+json`, DSH's own fields with these names) ahead of DSH's static file, the icon at `/omni-ui/app-icon.png` (or `.svg`), and puts `name` in the page's `<title>`. The icon is the Automagik app icon (`apps/desktop/assets/icon.png`) at 512 px. `appManifest` names the app otherwise; `appManifest: false` keeps DSH's name and icon. A value it can't use (no `name` or `short_name`, a color that isn't `#hex`, an icon that isn't an absolute `.svg` or `.png` path it can read) is refused with a line in the diagnostics, and the page stays "Automagik".

**Updates**: when a window opens, DS Bot asks where it was installed from for a newer release: the npm registry (the one the DSH plugin manager installs from, then its fallbacks), or the latest GitHub release for a `github:…#vX.Y.Z` install. A newer version shows a cloud button at the top right of the sidebar; **Update** reinstalls DS Bot through the DSH plugin manager, and the new version runs from the next DSH start. A linked or local checkout is never offered an update. Settings → About DS Bot shows the same state, with **Check for updates** to ask again at once.

The same card can carry DSH itself: a DS Bot release may name the DSH release it was verified against (`dsBot.verifiedDsh` in its `package.json`), and only that version is offered — running something newer is a downgrade offer too. A release that names no version offers no DSH update. A DSH installed from npm is swapped by `npm install -g @deepseek-ai/dsh@<version>`. DSH Desktop installs the newest release its own updater finds, so the card shows DSH there only when that release is the verified one, and **Open updates** opens the app's update panel. A release may raise the floor with `dsBot.minBot`: until the bot itself is that new, the DSH row waits.

## Models

Model providers are set up with dsh's `llm-pi-ai` plugin in `cordis.patch.yml`. Every Bot runs on one model of its own, from the models DSH serves. A new team's first Main Bot has none, and holds its greeting until it has one. With `@automagik/welcome-dsh`, finishing Connect AI with an AI on gives it (and the Omni Bot) the team's default model, and the greeting goes out then. Otherwise its chat offers that model with one press to start and a "change" link to the model menu; with no model that can run, the card offers ways to set one up. The team's default model is DSH's default model when it is served and its provider has its key, else the first model that can run (a provider's `default` alias after the models it names). While a chat holds only the greeting, one line under it names the model and its provider, with "change". Of the Claude models pi-ai serves on `anthropic`, the menus offer each family's newest (Opus, Sonnet, Haiku, Fable); the older versions and dated snapshots stay served, so a Bot already on one keeps it and its menu still shows it. The Create Bot form starts on the DSH default model. The Bot's details panel and settings (or a Main Bot's `update_bot`) change it; a Bot whose model is no longer served shows the card again. A team saved by an older version keeps the model each Bot last ran on.

**Background model**: the jobs that run beside the chats use one model of the team's, never the Bot's agent: memory review and the memory panel, and, for a chat on an agent over ACP (`acp-claude`, `acp-codex`), the steward's call and the part's note and checkpoint. An agent answers only in its own chat, so it cannot take those. Other chats keep their own model for these, so the provider serves their prefix from cache. The model is the team's pick in Settings → Bots → Background jobs (`prefs.backgroundModel`, any model DSH serves that is not an agent), else DSH's default model (DeepSeek, unless the person chose another there) when it can run, else the first account connected here. A memory call that fails on it is tried once more on the Bot's own model, when that one is not an agent. DSH's own session titles and compaction summaries pick their model in DSH's config (`session-title-llm`'s `provider` and `model`, `compaction-basic`'s `summarizationProvider` and `summarizationModel`); those fields are not live settings, so this setting does not reach them.

**Claude on ACP**: Claude Code came back through `@automagik/acp-dsh`. Once per team, a Bot that ran
on the retired Claude Code plugin and is still on the pi-ai Claude model it was moved to takes
`acp-claude` on the same family (`opus`, `sonnet`, `haiku`), keeping its Session and history. It
moves only when the ACP plugin's `dshTools` bridge is on (its absent default is on for Claude), a
live bridge probe on this machine passes (cached per adapter version, retried after ten minutes or
the next start), its adapter is installed, its CLI is signed in, and its route lists that model; a
Bot the person has changed since, or whose model the route does not list, stays where it is. The
sign-in is the CLI's own answer, asked again on every pass: an installed-but-signed-out Claude moves
nothing, and after signing in the Bots move on the next pass (a settings or adapter change) or the
next DSH start, with no separate action. The move records the model and thinking level the Bot had
and carries that level onto the agent's own effort setting where the agent offers it, by the same
id or a unique display name: Claude Code's levels are low, medium, high, xhigh and max, and
Codex's are low, medium, high, xhigh, max and ultra, per model (ultra has no pi-ai counterpart,
so no Bot level maps to it). With `dshTools` off nothing moves onto
the route, as on 2026-11-03: a Bot already moved goes back to exactly that model and level, and so
does one whose route disappears (the plugin, the agent setting or its CLI). The off flip is heard
live through `acp-dsh/dsh-tools-changed`, not only at the next start, and turning it on again moves
the team once more. That live reverse needs the ACP plugin loaded to announce the flip: with the
plugin absent when the route disappears, the same reverse runs at the next start, where the route
reads gone, so a move is never stranded. A Bot the person changed after the move keeps their pick,
never overwritten by the rollback. When the agent offers no level matching the Bot's, the Bot keeps
its setting in the team and the agent runs on its own; when the Session has a turn behind it, the
ACP plugin notes in the chat what could not cross. On an ACP route the Bot's team
tools reach it over the same per-session bridge: `post_to_group`, `message_bot` and the rest are
offered, and every call asks DSH's approval under the Bot's level before it runs. On **Auto**, the
bridge gives auto-review the call: an allowed call runs, a denied one is refused with
`AUTO_REVIEW_DENIED`, and a reviewer that cannot decide refuses with `AUTO_REVIEW_FAILED`; the call
never runs silently.

**One sign-in per subscription**: a Claude or ChatGPT plan signs in only through its own CLI (Claude Code, Codex). Once per team, per route (`subscriptionCliMoved`), a Bot on a plan through DSH moves to that CLI's route over ACP: pi-ai's `openai-codex` (the ChatGPT sign-in) to `acp-codex`, and pi-ai's `anthropic` to `acp-claude` only when it runs on the Claude Pro or Max sign-in: DSH's settings show that route with no `apiKeyEnv`, DSH's credential store holds pi-ai's `llm-pi-ai/anthropic` record as a sign-in grant (its kind, never its value), and no `ANTHROPIC_API_KEY` is found. The target is the same model id when the agent lists it, for Claude else the same family (`opus`, `sonnet`, `haiku`), else the agent's `default`. A Bot on an API key (`anthropic` on any key, `openai`, any other route) never moves, and a route whose settings or credentials cannot be read is left alone. The move waits for three things: the CLI's route registered (the agent on in acp-dsh), its catalog read (until acp-dsh's probe answers, Codex lists only its `default`), and the CLI signed in, as acp-dsh's `inspect` says. A pass that lacks one moves no one and marks nothing: the Bots keep answering on the route they are on, and the Bot's settings say "This Bot stays on <model> until <CLI> is signed in" (or "is ready"). It looks again on the next adapter or settings change, when acp-dsh announces a sign-in (`acp-dsh/login-ready`, after any model the person chose with that sign-in is applied), at the next start, and on a timer: the catalog each minute; a sign-in that could not be read after 1, 5 and 30 minutes, then only when an event asks (an event neither uses up one of those three looks nor starts them over; a definite answer does); a CLI that says it is signed out every 10 minutes, so a sign-in done in a terminal is found. A team with no Bot on the route is marked done with nothing asked of the CLI. The Bot keeps its Session, history and thinking level, and a record of what it had (`subscriptionMoved`: `from` with the model and level, the `target`, and `confirmed` once it is; for Codex also the `previousModel` it had and its `previousTarget`, when that was not its model); `previousModel` follows the same mapping, so no switch goes back to a plan route, and a Bot whose `previousModel` alone moved to Codex gets a `previousOnly` record. The team keeps when the Codex route moved (`subscriptionMovedAt`).

**The way back, for Codex only**: a Bot the move took goes back to exactly the model and `previousModel` it had, and the route's flag is cleared so the move runs again later, in two cases. Codex is gone: turned off, its service or row absent, or its CLI install failed, read at the first pass after a start, or read gone again a minute after it was first read, so the burst of events one settings write sets off is one reading (a CLI that is missing or installing is not gone; this read is acp-dsh's `status()`, which runs no CLI). Or Codex says it is signed out and the Bot's record is not `confirmed`: a record is confirmed by an answer on its target in the Bot's own chat since the move (read at the next pass), or by a ready pass more than six minutes after the move (acp-dsh keeps a "signed in" answer for five). A Bot the person re-pointed since keeps their pick, also when the pick lands while a pass is asking the CLI, and a level they changed is kept. A `previousModel` still on Codex goes back with the model, so no switch back to Codex stays pending. Nothing goes back unless `openai-codex` is still registered and DSH still holds its ChatGPT grant; without them the Bot stays on Codex, whose chat asks for the sign-in. This is a deliberate exception to "a plan runs Bots only through its CLI": a restored Bot runs on `openai-codex` (it keeps that model through edits that leave the model alone, and cannot be picked back onto it) until Codex is signed in. Claude has no such exception: the ACP rollback (`acpMoved`, dshTools off or the route gone) never puts a Bot back on the `anthropic` sign-in route, and that Bot stays on `acp-claude`.

| A team v3.109.1 or later already moved | What happens |
| --- | --- |
| Codex signed in | Nothing changes. Its records are confirmed at the first pass; from then on only a Codex that is gone moves them back. |
| Codex signed out, the ChatGPT grant and route still in DSH | Repaired at the first pass: the Bots go back to `openai-codex/<model>`, and move again after a Codex sign-in. |
| Codex signed out, the grant or route gone | Left on `acp-codex`; the chat's sign-in card is the way forward. Logged once. |
| Sign-in unknown | Nothing, until a pass reads a definite answer. |
| A Bot on `acp-codex` with no record | Never touched: it cannot be told from a person's pick. |

A restore clears the route's flag, so a desktop app rolled back to a version before this gate (v3.109.1 to v3.114.0) moves the restored Bots to Codex again, signed in or not; the team file reads the same both ways.

No credential is read or copied between programs. The background model is not moved: an agent never answers beside the chats.

**The model menu** lists only what is set up, as connection, then model, then thinking level: a provider whose key is stored, an agent whose CLI is signed in, and a DSH sign-in other than Claude's or ChatGPT's that is stored. A connection is named by its brand and how it connects: "DeepSeek", "Anthropic · API key", "OpenAI · API key", "Claude Code", "Codex"; two connections that would read the same also show their route id. DSH's own Claude Pro/Max or ChatGPT sign-in route is never offered (the catalog marks it `covered`), nor is a model whose key or sign-in is missing (`needsKey`, `needsSignIn`). The model a Bot is on stays shown even when it cannot run, marked unavailable, and a new Bot never starts on one: the team's default skips them, and DSH's default on a covered plan route is read as the same model on that plan's CLI. The jobs beside the chats keep their own rule (the background model above).

**Images**: `generate_image` draws with an OpenAI API key (the Images API) exactly as before; without one, through the Codex CLI on its own ChatGPT sign-in (acp-dsh's `generateImage`, a one-off Codex session with a per-draw permission profile using Codex's image tool), so a ChatGPT plan draws with no DSH sign-in. A ChatGPT grant an earlier version stored through DSH's `openai-codex` sign-in is read last, only so a person who signed in that way keeps drawing; Automagik no longer offers that sign-in. Nothing reads or copies the CLI's sign-in. A Bot on an agent (Codex) can also make an image with the agent's own tool: acp-dsh hands its PNG, from the call's own update, to the Bot team's keeper (`acpAgents.keepImages`), the chat shows it in the same image card, it is saved in the same images folder, and the agent's link to its own local copy leaves the reply. While any image is made (either path), the card is Omni painting: Omni's clay art with no card behind it, swaying, its face changing every 0.9 s, four dabs of the theme's colours around it, and "Painting your image…" with the seconds so far; a partial image, then the finished one, fades in where Omni was. With reduced motion Omni stands still and the dabs are gone. A call that fails or is stopped says the image was not made, and why.

**Codex image security (#870).** Each one-off draw requests scratch-only reads through a fresh
permission profile. Codex's filesystem helper adds runtime read grants, so this is containment,
not a scratch-only read boundary: images in permitted runtime directories remain readable.
Automagik sends prompt text and has no pre-read hook for Codex's image-input paths. The
[ACP image security notes](../acp-dsh/README.md#images-through-codex) list the platform grants,
pinned sources and test limits; native macOS/Windows and signed-in per-turn enforcement remain
untested here. #870 remains open. The scratch folder and config are removed afterwards.
An adapter that lacks the mode or rejects it falls back to `read-only`, logs one warning and
marks the result internally as not isolated. The owner keeps this fallback enabled with the
file disclosure risk accepted: an injected request could use a readable local image as input
and return its contents in a picture shown in chat. A Codex Bot's own image tool in ordinary
chat is outside the per-draw profile and retains that risk under its chat permissions.

An OpenAI API key routes `generate_image` through the Images API instead of its one-off
Codex session. Prompt text still reaches the model; keep secrets out of it. A Bot running on
Codex can still use its own image tool despite that key. Use a different Bot model or turn
Codex off to avoid that route. Avoid sending untrusted outside text to Codex drawing; prompt
review is not a file access control. See the
[ACP image security notes](../acp-dsh/README.md#images-through-codex).

**Fallback**: when a Bot's model fails a request and nothing earlier answers it (DSH's own retries of the same model, or a move to a fresh part for a full or stuck chat), the step runs again on the fallback model: `fallbackModel`, else the team's default model (DeepSeek's, out of the box). The rest of that turn stays there, and a notice in the chat says which model failed and why; the next turn is back on the Bot's own model. A full context, a stop, and a fallback that fails too end the turn as before. It covers every Session of the team: a Bot's chat, a group seat, a task.

**Model changes**: a new model is checked, put on the Bot's Sessions, and only then saved; a model that cannot run now (Claude Code or Codex turned off, still installing, or signed out, asked through acp-dsh's read-only `inspect`) or a selection DSH turns down refuses the whole change, with nothing written. `previousModel` is the last model that answered in the Bot's chat (a model that only started a call is never recorded), kept through a change until the new one's first answer. If that switch fails on its first turn because the new model cannot run the conversation (`MODEL_SWITCH_COMPACTION_FAILED`, `MODEL_ACCESS_REQUIRED` from a signed-out agent, or a route whose provider is not configured), or the fresh part it opened fails its first call with nothing else to answer it (a failure the fallback answers keeps the switch, unless the fallback fails too), the Bot goes back to `previousModel`, Session selection included, and nothing runs again on its own. A signed-out agent never moves to the fallback model; any other agent failure does, with its notice, which opens the fallback turn once the failed one has ended. The fallback never changes the Bot's model. The Bot's settings say what its model really did: switching and not answered yet, failed and back on the previous model, or in need of a sign-in. "Answered" comes only from an answer whose source is that model, never from the pick or a started request (state answer `work.models`, and the `model-state` read with whether the model can run now).

**Signing in to Claude Code or Codex**: a Bot whose agent is signed out is signed in to from a transient row at the end of its chat (`src/client/cli-login.js`). It shows only after an explicit entry: picking that agent's model in the chat's picker, Sign in under the refused model in the Bot's settings, or Sign in in the welcome's Connect AI or its Claude Code and Codex page, which opens the selected Bot's chat, else the Main Bot's, through the bridge `Symbol.for('automagik.cli-login')`. It never opens by itself, except to restore a live attempt in the Bot that opened it. The row offers Sign in and Not now; then the link to open on any device, with its expiry, and Codex's device code to type there or a masked field for the code Claude shows after you authorize. While that field shows, the message box keeps its draft but takes no edit, and the model picker stays usable. When the CLI confirms, the row says so and goes by itself after about three seconds; a model the entry chose is then applied to that Bot only, if it is still your latest choice, and if it cannot be used the row says why for a few seconds and the Bot stays on its model. A failure or an expiry leaves one line with Try again and Close; a DSH restart during the attempt says so. The attempt itself lives in acp-dsh, so a reload, a second window or another Bot gets it back without cancelling it; only Cancel, which asks first (naming the Bot that opened it when that is another), or the expiry ends it. The endpoints are `cli-login-start`, `-current`, `-status`, `-answer`, `-cancel` and `-connections` on the team's route, which DSH answers only for its owner. A Claude code shown on this page is refused in the message box afterwards, and the host refuses to send, deliver or step any message that carries one, so it never reaches a Session, a draft, storage, a log or a model. Nothing of the sign-in stays in the chat; the only persisted row is acp-dsh's "Switching to X", which belongs to the model change.

**Separate Bot accounts (#869)**: Claude Code and Codex each have a Bot CLI home per installation,
shared by its teams and images, separate from the terminal. An upgrade keeps Bot models and
history and asks for a fresh sign-in inside the app; old terminal consent is not carried.
Signed-out Bots pause with a sign-in action. Codex never silently restores its legacy plan route
or draws with an old ChatGPT grant while its Bot account is signed out. Explicit image API keys
keep their own path. Bot settings show Bot and terminal identities (read-only, when reported),
label their separation, and offer Sign in, Switch account and Sign out. The latter two stop
running work before changing only Bot credentials. A failed logout stays paused for retry;
another app instance sharing that vendor home must be closed before an account change.
The owner-only endpoints add `cli-login-switch` and `cli-login-signout`; account details never
enter team state, messages, tools, model calls or logs. The earlier confirm step still covers an
existing account in the Bot's own CLI home. Terminal user settings are not imported; RFC 0003's
isolation amendment records the settings migration.

**Agents' tools and history**: what Claude Code and Codex see follows acp-dsh's `dshTools` (its README has the table): with it absent, both get the chat's history as a redacted replay, Claude Code gets the team's tools over the bridge, and Codex keeps only its own tools; the team's tools on Codex need an explicit `dshTools: true`.

- Give every model a `contextWindow`. DS Bot takes its lines from it: the usable window is the window minus the reply reserve (`maxTokens`), the hard line is 95% of that, and the check line is `checkRatio` of it. A model without `contextWindow` gets the adapter's default (262,144 tokens for `llm-pi-ai`), which may be wrong for that model; a model that reports no window at all counts as 500,000.
- To send images, the provider needs `defaultInput: [ text, image ]`.
- Keep API keys out of the repository. Use dsh's own key storage or environment variables.

## Memory

A Bot remembers what should last beyond one conversation: your preferences, decisions, corrections and facts it should not ask again. Memory is plain Markdown in the [Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) format: one entry per line, ending in `[source: …; added: …]`.

After each turn, a memory review reads what is new in the conversation and keeps, updates or removes entries itself, so memory does not depend on the Bot deciding to call `remember`. A Bot's own chat is reviewed by its model into its own memory; a group chat is reviewed once for the whole group, by the admin's model (or the first member's), into the group memory only. It keeps only what you say, writes entries in your language, and refuses keys, passwords and ID numbers.

- **Three scopes**: each Bot has its own memory; each group chat has a group memory, which its members read in that group only (not in their own chats, and not in other groups); and the team memory is read by every Bot. A Bot writes its own, and any member writes its group's memory from the group. Main Bots and group admins (of any group) also write the team memory; a Main Bot can read and change another Bot's memory when you ask.
- **Tools**: `remember` saves an entry or replaces one (`replace`), `forget` removes one, and `recall` searches every entry, reads a topic whole, or lists what is saved. In a Bot's own chat they use its own memory by default; in a group chat, the group memory (`scope: "own"` for the Bot's own). The Bot adds the source (a part anchor such as `part 2 #1234`, which `read_own_chat` opens, or the group and the time) and the date; a Bot that writes for others is named with `by:`.
- **Files**: `MEMORY.md` holds what every conversation needs, and details go in topic files linked from its `## Index` as `[[topic]]`.
- **In the prompt**: the Bot's own and the team's `MEMORY.md` go into the Bot's system prompt, and in a group Session the group's after them. The section is frozen when a Session starts, so the provider's prompt cache holds; a change shows from the next part or checkpoint, and `recall` finds it at once.
- **Fixed sizes**: an entry has at most 300 characters, a `MEMORY.md` 4,000, a topic 16,000, and a scope 40 topics. A save past a limit fails and says how to make room.
- **Safety**: memory is data, not instructions. An entry that looks like a key or token is refused, and a Bot is told not to save what a web page, file or tool result asks it to remember.
- **History**: files change in place, and `journal.jsonl` keeps every change with the line before and after. When a Bot or a group chat is deleted, its memory moves to `archive/`.

**The memory panel**: the details panel of a Bot, and of a group chat, has a Memory row with the entry count; Manage opens the memory panel. A Bot's panel shows its own memory and the team memory; a group's shows the group memory.

- **Memory summary**: a model writes a short summary in prose from every entry, in the interface language: the Bot's, or for a group its admin's. It is written again when the entries change, and the ⋯ menu can regenerate it.
- **All entries**: the ⋯ menu lists every entry by scope and topic, with its date and author, and the size of each `MEMORY.md`. Remove takes two clicks.
- **Ask or update**: ask what the Bot remembers, or tell it what to add, correct or remove. One model call answers from the entries only, and its changes go through the same checks as the tools.
- A line in the chat ("Memory updated") shows when a Bot changes memory and opens the panel. When memory changes in the background, the capsule at the top of the chat (the Bot's, or the group's) stretches to say "Memory updated" for a moment; clicking it opens the memory panel.

A read-only dsh (see [Data and backups](#data-and-backups)) shows memory but cannot change it.

## Web search

The package includes a second plugin, `@automagik/bots-dsh/web-search`. It registers the search provider `auto`. The package's own `cordis.patch.yml` does not insert it, so installing Omni leaves your dsh's search settings alone; the Omni desktop app's profile inserts it and makes it the default. To use it in your own dsh, add both rows to your profile patch:

```yaml
- insert:
    - id: web-search-auto
      name: '@automagik/bots-dsh/web-search'
- id: web
  config:
    searchProvider: auto
    fetchProvider: http
```

Each search goes in this order:

1. If the profile names another `searchProvider`, that one is used.
2. The current model route's own search, with that route's key and host. The plugin knows the Anthropic Messages, OpenAI Responses and Gemini protocols, and a few search APIs (Ollama, Kimi, Zhipu, MiMo). Add more with `searchApis`.
3. A fallback without a key: the public result pages of Bing and DuckDuckGo.
4. If nothing works, the search fails and tells the model not to guess addresses.

Each result starts with a `Search backend: …` line that names the path it took.

**Turning `auto` off**: the `web` row still names `auto` when you turn off only the `web-search-auto` row (in the sidebar's Plugins page or with `disabled: true` in a profile patch). Then `web_search` fails in every session, Bot or not, with `WEB_PROVIDER_CONFIGURED_MISSING` (`configured web provider "auto" is not registered`). When you turn that row off, also name another `searchProvider` for the `web` row in the profile's `cordis.patch.yml`. The override replaces the row's whole config, so restate `fetchProvider`:

```yaml
- id: web-search-auto
  name: '@automagik/bots-dsh/web-search'
  disabled: true
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

Another plugin can also set the search provider while dsh runs, after the profile patch. When you turn such a plugin off, check this setting again.

**Web fetch**: the app and server profiles leave DSH's local `web-fetch-http` provider on.
`web_fetch` uses the same address lists as the Bot browser (Settings → Browser → Address
lists); with both lists empty, localhost, LAN and tailnet URLs are fetched by default. A
deny entry wins over an allow entry, and a non-empty allow list limits fetches to those
targets too. The lists are shared with the Bot browser, so changing them cannot turn
`web_fetch` off; only the profile's `web-fetch-http` row with `disabled: true` does.
With both lists empty, prompt-injected channel text can still reach localhost services
(#521); add a deny entry or disable that row.

## Bot browser

Every Bot has a browser of its own, on by default (`browserPlugin: false` turns it off). It is the Chrome, Edge, Chromium or Brave already on this computer, driven through `playwright-core`: nothing is downloaded. Without one, a Bot that needs a browser says so and asks you to install Chrome.

- **A profile per Bot**, in `browser-profiles/<id>/`: its sign-ins and cookies stay between runs and belong to that Bot only. Deleting a Bot deletes its profile.
- **Tabs come back**: the Bot's open tabs (address and title) are saved there as they change and reopen at its next browser call after a crash or a restart. A browser that went away (closed, crashed) opens again at that call.
- **What a Bot does**: `browser_open`, `browser_snapshot` (the page as an accessibility tree, each element with a ref), `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_upload`, `browser_tabs`, `browser_back` and `browser_screenshot`. Page content is treated as data, never as instructions.
- **What asks you first**: posting, uploading, downloading and deleting, each through dsh's approval. A delete needs a second, confirmed click. Settings → Browser lets a Bot do some of these on a site for an hour, until the end of the day, for 7 days or for good. Card fields are never typed, and a payment always goes back to you.
- **Address lists**: every address opens by default, including localhost, LAN and tailnet
  targets. Settings → Browser → Address lists holds this profile's deny list and allow list.
  A deny entry always wins; when the allow list is not empty, only matching targets open.
  An entry is an IPv4 or IPv6 address, a CIDR range, or a hostname (`example.com` covers
  its subdomains; `*.example.com` is accepted). The same lists apply to `web_fetch`.
  Clear both to allow everything. A hostname rule matches the URL's hostname only and
  performs no DNS lookup. An IP/CIDR rule can be defeated by DNS rebinding: the check
  resolves the name, and the browser resolves it again when it connects, so a hostile
  name can answer an allowed address at check time and a denied one at connect time.
  If the check's DNS resolution fails, an IP deny rule cannot match, so the request is
  allowed (fail-open) unless the allow list is non-empty and the target is not on it.
  These lists are about the address a Bot opens, not a firewall for the page's
  subresources.
- **Files**: downloads go to the Bot's working folder or the team folder; uploads come only from those.
- **Handing over**: for a sign-in, a payment or a check, the Bot calls `browser_handoff` and a card in its chat asks you to take over, skip, or say you are done. While you hold the browser, its tools refuse; the window is a normal browser window on your screen.
- **The window**: on macOS and Windows, and on Linux with a display, the browser opens as a window you can watch. On Linux without a display it runs headless (`browserHeadless`).
- **In the Automagik app** the Bot's browser is inside the app instead: the globe button in its chat header opens the same tabs the Bot drives, in a panel you can watch and take over. Its sign-ins stay in the app's own storage for that Bot; `read_browser` is not offered there, since the Bot reads its pages with its own browser tools.

### Browser panel (dsh Desktop)

In dsh Desktop, a Bot's chat header also has a globe button. It opens that Bot's browser panel, a page you steer, and the `read_browser` tool reads it.

- **One partition per Bot** (`bot:<id>`), kept in memory by dsh Desktop.
- **The Bot can read the page**: `read_browser` reads the page's DOM, not a screenshot. The text becomes Markdown with headings, nested lists, tables, code blocks and quotes. Links and form controls are marked `[#n]` in place and listed below with their targets and values. The tool also reads the text you selected. Long pages are read in parts (`from`).
  - It reads open Shadow DOM (with `<slot>`) and same-origin iframes up to 3 levels deep.
  - It reads only what is visible: `display:none`, `visibility:hidden`, zero-height and closed `<details>` content is skipped.
  - It never reads the values of password, credit card (`autocomplete="cc-*"`) or one-time code fields.
  - Limits: 400,000 characters, 150,000 nodes, 5,000 rows per table, 3,000 links and controls, 1.5 seconds. A cut result says so.
  - It cannot read cross-origin iframes (one line with the address), closed shadow roots, canvas content (online editors, maps), or text in CSS `::before` / `::after`. On pages that render on demand, only the rendered part is read.
- **Addresses**: http and https only. localhost and LAN addresses are allowed; cloud metadata addresses (such as `169.254.x.x`) and dsh's own ports are not.
- The browser panel and the details drawer share the right column; opening one closes the other. Switching chats switches the panel to that Bot.

The Automagik desktop app and dsh Web have no browser panel and no `read_browser`; their Bots use the browser above.

## Secrets

When a Bot needs an API key, token or password, it calls `request_secret`, and a secret card shows in its own chat. The Bot never sees the value.

- **Fill in**: the field hides what you type, is not part of a form and is not autofilled. Choose "All Bots" or "Only this Bot" and select Save. A value must have at least 4 characters (a 4-digit PIN works). A value of 8 characters or more is hidden wherever it appears; a shorter one only where no letter or digit touches it, so ordinary words stay intact.
- **Allow**: if the secret is already saved but this Bot is not allowed to use it, the card only asks whether to allow it. You can also replace the value there.
- **Use**: the value goes into the Bot's shell environment as `DSH_SECRET_<NAME>` (`$DSH_SECRET_NAME` in bash, `$env:DSH_SECRET_NAME` in PowerShell). `list_secrets` lists the names a Bot can use. An MCP capability can also take `$DSH_SECRET_<NAME>` in its env, its headers and its URL (path or query); in the URL the value is URL-encoded. Use headers when the server accepts them.
- **Masking**: before a tool result is saved and before each request goes to the model, every copy of a secret value is replaced with `[secret:<NAME>]`.
- **Manage**: Settings → Secrets lists every secret by name, purpose, the Bot that asked and the last use. You can change who may use it, replace the value, delete it or add one. Deleting a Bot removes it from every secret.
- **Storage**: `<DSH_HOME>/bot/secrets.json`, file mode 600, written atomically. Values are never in `state.json` or logs.

Limits:

- On Windows, the file mode has no effect; the file is protected by your user folder only.
- Only exact copies of a value are masked. A Bot that encodes, splits or reverses a value can still print it. Do not give important secrets to a Bot you do not trust.
- On a page that is not HTTPS (for example dsh Web opened over http on a LAN), the value crosses the network in clear text. The card warns you.
- Group chats show no cards; a Bot asks in its own chat.

### A capability for one Session

Another plugin can mount one MCP capability from Settings → Capabilities into one plain Session it owns, such as a thread it keeps for one person, and only there. A secret that capability uses is then scoped to that one Session. The mount goes through the same path as a Bot's. It takes only a capability the person last saved in Settings → Capabilities: one a Bot made or changed is refused, and a live mount whose capability a Bot changes stops until the person saves it there again.

- **`rt.mountCapability(sessionId, name, grant)`** resolves to `{ sessionId, name, state, error?, toolPrefix }`. `grant` is `{ secrets: [NAME, …] }`: exactly the secrets the capability uses as `$DSH_SECRET_<NAME>` (its args, env, URL or headers), or none. `state` is `ready`, `connecting` (still connecting after 15 seconds; it goes on in the background), `needs-approval` (a stdio server not yet approved) or `error` (with `error`, secrets masked). Every tool of the mount is named `mcp__<name>__…` (`toolPrefix`) and is registered in that Session's Agent scope only, so no other Session lists or runs it; a plugin that restricts the Session's tools adds these names to what it allows. Calling it again with the same arguments changes nothing.
- **The secret**: save it for no Bot (Settings → Secrets, Chosen Bots with none picked). The first mount scopes it to its Session and saves that scope in `secrets.json` (`session`, beside an empty Bot list). From then on it never resolves for a Bot (shell, Bot capabilities, the capability check) or for another Session; it is never offered to a Bot: not in `list_secrets` or a shell's declared variables, a Bot that names it in `request_secret` is told it cannot have it, no card can allow or fill it, a capability a Bot saves cannot use it (a Bot's save may use only keys saved for that Bot), and Add in Settings cannot give it to Bots. A new value keeps the scope. Choosing Bots for it under Who may use it ends the scope. Its value is masked as `[secret:<NAME>]` in every tool result and model request, as any secret's is.
- **Refused** (an error with code `bot/refused` and a message for the person): a Session that belongs to a Bot (its own chat, a group, a task or run, an earlier part, or a subagent of one); a name that is no capability or not an MCP server; a capability last saved by a Bot; a grant that leaves out a secret the capability uses, or names one it does not use; a secret that is missing, held, usable by any Bot, or scoped to another Session; a Session DSH cannot resolve; and, on a dsh that only reads the team, a secret not yet scoped to this Session.
- **Lifetime**: a mount lives in memory until `rt.unmountCapability`, until the Session closes (DSH disposes it), until its capability is deleted, or until dsh restarts; a restart restores none. While it lives, each new Agent of the Session (a clear, a compaction) gets it before its first step. Mount again whenever you prepare the Session. The secret's scope is saved apart, so after a restart or a close it still belongs to that Session alone. A version of this plugin from before this change that rewrites `secrets.json` drops that scope: the key then reads as no Bot's, and after the next upgrade the first Session that mounts it takes it.
- **`rt.unmountCapability(sessionId, name)`** ends the mount (its tools leave the Session; a stdio server stops) and the saved scope of the secrets the capability uses, with or without a live mount; for a capability that is gone, each secret still scoped to that Session that no saved capability and no live mount there still use. It resolves to `true` when a mount or a scope ended, `false` when there was nothing.

## Data and backups

The plugin saves its data in `config.home`. Without it, the folder is `$AUTOMAGIK_BOTS_HOME`, else `bots` in `$AUTOMAGIK_HOME`, which is `~/.automagik` when not set. It writes nothing of its own under `DSH_HOME`; the Bots' Sessions are dsh Sessions, and dsh keeps those.

| System | Default folder |
|---|---|
| Linux, macOS | `~/.automagik/bots/` |
| Windows (WSL) | `~/.automagik/bots/` inside the WSL distribution |

- To move the team's data, set `AUTOMAGIK_HOME` or `AUTOMAGIK_BOTS_HOME`, or `home` in the configuration (see [Configuration](#configuration)).

Files in `ui/`:

| File | Content |
|---|---|
| `state.json` | The team: Bots, groups, Bot-to-Bot messages, preferences and open questions. A long message keeps only its first 2,000 characters here; all of it is in the Session it went to. |
| `group-lines/` | Long group lines, up to the 20,000 characters a member reads, one file per line; each is removed when its line leaves the group's latest 60 lines or the group is deleted |
| `state.lock` | The dsh that is using this data (pid and host), its mtime bumped as a heartbeat. It is removed when that dsh exits; a leftover whose heartbeat has stopped is taken over by the next dsh to load. |
| `chat-index.sqlite` | Full-text index of older chat parts (`read_own_chat`); rebuilt if deleted |
| `usage.sqlite` | Token counts for the Usage page; rebuilt from the Session logs if deleted, losing only the calls outside the logs and the names of deleted Bots |
| `memory/` | Memory (see [Memory](#memory)): `pending.json` holds a save in progress, so an interrupted one is finished at the next start; `bots/<id>/`, `groups/<id>/` and `team/` (`MEMORY.md` and topics), `journal.jsonl` (every change), `snapshots/` (the section each Session froze), `summaries/` (the panel's summary; safe to delete), `reviewed.json` (how far the memory review has read) and `archive/` (deleted Bots and group chats) |
| `ocr.json` | Cache of image text; safe to delete |
| `side/` | Side chats, one file per Bot; `btw/` keeps the asides of earlier versions, read only |
| `avatars/` | The photos added for Bots to wear (up to 500), with `index.json` |
| `handoff-results/` | Whole results of delegated work longer than `state.json` keeps, until the work is answered |
| `browser-profiles/` | Each Bot's browser profile: its sign-ins and cookies. Treat backups of it like passwords. |
| `browser-downloads/` | A folder per Bot that its browser may also upload from |
| `update.json` | Left by an update that reinstalled the plugin, for the start that follows it |
| `workspace` | The team workspace: the working folder of every Bot without one of its own (`config.workspace` changes it) |
| `secrets.json` | Saved secrets. Treat backups of it like passwords. |
| `omni.json` | The Omni this UI is linked to (kept by the channels plugin): its URL and the key pairing minted (0600). Treat backups of it like passwords. |
| `logs/diagnostics.jsonl` | Recent errors and warnings, with keys, tokens, saved secrets and the home folder removed. It moves to `diagnostics.jsonl.1` past 1 MB. Safe to delete. |

The chats themselves are dsh Sessions and are not in `bot/`: they are in `~/.dsh/sessions/`. dsh keeps its workspace list in `~/.dsh/storages/workspace.json` and profiles (with model settings) in `~/.dsh/profiles/`. dsh Desktop keeps each Bot's browser partition in memory only, so its logins are not saved. The desktop app saves them with its own window data, not in the data location, and clears a Bot's when the Bot is deleted.

**Back up and restore**

1. Quit dsh completely (both the Web server and Desktop), so `state.json` is current.
2. Copy all of `~/.dsh/` (at least `bot/`, `sessions/` and `storages/`). A copy of `bot/` alone loses the chats.
3. To restore, quit dsh, put the folder back in the same place, then start dsh.

**Move to another computer**: `state.json` has no absolute paths except the working folders you set for Bots and groups, but dsh's `storages/workspace.json` and the Session folder names contain the workspace's absolute path. If the path is the same on the new computer, copy the folder. If it is different (another user name or system), it is not yet tested whether dsh finds the old Sessions.

**dsh Web and Desktop at the same time**: by default both use the same `~/.dsh`. The dsh that loads the team first takes `bot/state.lock` and can change the team. The other one is read-only: it shows the team and follows changes to the file, but refuses changes (`bot/read-only`, "open in another dsh"), and its Bots cannot start new Sessions. When the first one exits, the other one takes over on its next request. To change the team from both at once, give one of them a different `DSH_HOME` (two separate teams).

## Development

You need Node 24 (DSH and the tests run on it), Bun (installs), pnpm and a deepseek-harness checkout with its dependencies installed, next to this repository (`../deepseek-harness`, or set `DSH_HARNESS`). The Desktop test bench also needs `xvfb-run` and `ffmpeg`. Web screenshots need Chrome or Chromium (`CHROME_BIN`; by default `google-chrome` or `chromium`).

```sh
bun install                              # esbuild, for the client build
bun run build                            # src/client → client.js
bun run test                             # unit tests
bun run lint                             # oxlint from the dsh repository (.oxlintrc.json)
dev/bench.sh dev 3100 8800 start         # Web test bench: mock model + dsh Web, data in ../.dsh-test-dev
dev/desktop-linux/desktop.sh dev start   # Desktop test bench: mock model + dsh Desktop in Xvfb
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3101 8801 reset && node dev/smoke.mjs smoke 3101
dev/check.sh                             # all checks (see below)
```

- `client.js` is built from `src/client/` and committed, so `link:` and Git installs need no build. Do not edit `client.js` by hand; `bun run test` checks that it matches the source. After a change in `src/client/`, run `bun run build` and reload the page. After a change in `index.js` or `src/host/`, restart dsh.
- **Web test bench** `dev/bench.sh <name> <web port> <mock port> [start|stop|reset|status]`: the profile links this plugin and the channels and canvas plugins from an Omni checkout (`OMNI_CHECKOUT`, default `../../../omni`: its `apps/omni-channels-dsh` and `apps/omni-canvas-dsh`); a scripted mock model (`dev/mock-llm.mjs`, no real tokens; its commands are listed at the top of the file) and a dsh Web server. Data goes in `../.dsh-test-<name>/`; `reset` clears the team and Sessions first. The login address with its token is in `../.dsh-test-<name>/web.log`.
- **Desktop test bench** `dev/desktop-linux/desktop.sh <name> [start|stop|reset|status]`: dsh does not run Desktop on Linux; `launch.mts` runs the unpackaged Desktop in Xvfb. The first start downloads Electron and a Linux runtime (a few minutes). `start` returns when the team shows in a 1400×860 window.
- **All checks** `dev/check.sh [--skip steps] [--only steps] [--out dir]`: `unit`, `build`, `lint` (each in this plugin and in the channels and canvas plugins), `smoke`, `web` (screenshots of the sidebar, a chat, a group, Bot settings, the Bots page and group settings) and `desktop` (the same screenshots, then the Bot browser checks). It stops everything it started. On failure it names the step and its log and exits non-zero. A full run takes about 3 minutes after the first download.
- **Ports**: every script takes `SLOT=n` (0-9, default 0) so that several people or sessions on one machine do not collide: Web bench `31n0` and mock `88n0`, smoke `31n1` and `88n1`, Desktop mock `88n2`, and so on. A Desktop uses about 1 GB of memory; stop it when you are done.
- **Real models** (these cost tokens): `dev/steward-eval.mjs` sends hand-written conversation endings through the context steward's own prompt to an OpenAI-compatible route (or, with `--api messages`, an Anthropic Messages route such as DeepSeek's official one) and checks each decision. `dev/llm-tap.mjs <port> <upstream base URL> <log.jsonl> [body dir]` is a logging pass-through for either format: point a provider's `baseURL` at it, and it writes one JSON line per call (steward, checkpoint, handoff note or main turn, the Bot's name, token usage, the answer, and where the request first differs from the same Bot's previous one, which is what a provider's cache can reuse; never headers). With a body dir it also saves every request body. Each file explains its use at the top.
- **Screenshots**: `dev/ui-shots.mjs` works for both apps (`desktop <dsh repo> <dir> <renderer port>` or `web <dsh repo> <dir> <bench name> <web port>`).
- `bun run test` (Node runs the tests, as it runs DSH) loads the `@deepseek-ai/*` packages from the deepseek-harness checkout, else from `dev/harness` (`bun run harness`). The channels and canvas plugins' tests also load this plugin's `index.js`, `test/fake-ctx.js` and committed `client.js` from this folder, to compose the team with their own runtimes.

## Layout

| Path | Purpose |
|---|---|
| `index.js` | Host entry: installs the `src/host/` modules in order and provides the runtime as `omniTeam` |
| `src/host/` | Host: team and storage (`roster`, `store`), tools (`tools`), turns and delivery (`turns`, `delivery`), group chats (`groups`), chat parts, the context steward and the index (`parts`, `steward`, `chat-index`), image text (`images`), secrets (`secrets`), Bot browser (`browser`), the hooks other Omni plugins add through (`extend`), the `POST api/omni-ui` route (`channel`), the web app's name and icon (`app-manifest`, `app-icon.png`) |
| `src/client/` | Browser source: sidebar, chat header, transcript cells, panels and dialogs, themes, Bot browser panel, the registries other Omni plugins add to (`extend`) and the canvas slot they draw into (`canvas-slot`, `canvas-text`) |
| `client.js` | Built from `src/client/` by `scripts/build-client.mjs` (esbuild); committed |
| `src/script-child/` | Source of the process a `browser_exec` script runs in: a QuickJS interpreter (WebAssembly) and the two functions it is given; `pins.json` holds the interpreter's version and the sha256 of each of its files |
| `src/host/browser/script-child.js` | Built from `src/script-child/` and the pinned interpreter by `scripts/build-script-child.mjs` (esbuild) as one file; committed |
| `web-search.js` | The `auto` search provider; independent of the team code |
| `test/` | Unit tests and fixtures |
| `dev/characters.mjs` | Builds the characters (small 3D models traced to outlines) into the `CHARACTERS` table in `src/client/characters.js` |
| `dev/` | Mock model, test benches, smoke test, Desktop scripts, real-model tools (steward evaluation, logging pass-through) |

## License

[Apache-2.0](LICENSE)

### Remote Hermes (first delivery, #1070)

**Remote Hermes** is its own route after Native, ACP and Herdr, identified by the original
Hermes girl mark (upstream MIT notice in `NOTICE`). Local Hermes continues to use ACP.
The route is off by default. Clicking it without a saved connection opens setup; a saved
working connection opens its remembered profile in one click. Crossing harnesses still uses the
conversation/handoff confirmation.

Setup is three things: **choose a computer, Connect, chat.**

- **Choose a computer** lists the `Host` entries of the user's SSH config (an `Include` is
  followed when there is one; wildcard and negated patterns are never offered), with the hosts
  in `known_hosts` collapsed under them. Typing a host or config name stays possible. Picking or
  typing another computer starts from that computer's own SSH defaults.
- **Connect** signs in with the system SSH client and the user's SSH config/agent, finds the
  Hermes already installed there, starts its own `hermes serve` and opens the chat. Progress is
  shown as it happens. There is no route choice, address step or test step.
- **A profile is asked for only when Hermes has more than one.** The picker opens on the one
  Hermes runs as (then its active one, then the first). With one profile the chat opens at once.
- Everything optional is behind **More** (Bot settings → Remote Hermes → More, or **More
  options** on a failure): another user, port, identity-file path, Hermes executable path or
  Hermes home (its data folder), and a Hermes reached by its **Remote address** over HTTPS (reverse-proxy path prefix
  included) with its session token, or the dashboard's user and password. That password is
  used for the sign-in only and is never saved.
- **Pair Hermes Bot** (Bot settings → Remote Hermes) binds one Bot's own chat to that
  profile's existing Bot Chat: see [`docs/hermes-bot-pairing.md`](../../docs/hermes-bot-pairing.md).
  A paired chat opens the same way: no approval setting is read or waited for.

Remote Hermes connects to whatever profile and approval setting that Hermes has, and never
changes a Hermes setting. The only refusals are real failures, each with what went wrong and
its one fix in one line; the step that stopped, the exit code and the last lines are behind
**Details**:

- the computer cannot be reached, or SSH could not sign in. Key authentication must already
  work; SSH passwords and interactive key passphrases are not accepted.
- a host this computer has never seen: its key type and SHA256 fingerprint are shown, and
  **Trust this host** saves exactly that key to the user's known hosts (as `accept-new` would)
  and connects. A changed host key is always refused: the user checks it in a terminal.
  Host-key checks are never weakened, and private keys are never uploaded, copied or stored.
- Hermes is missing, stopped while starting, was not ready in time, reported no port, or did
  not accept the one-time token; the tunnel did not open; a forward from the SSH config is busy.
- Hermes is too old. Before it starts anything, the start script reads `hermes --version`. A
  release older than the minimum (below) gets **Update Hermes on `<host>` to v… or newer**,
  with the release found there and the update command for that install kind (`hermes update`,
  the Docker image, the Termux package, or Nix). A build that names no release is reported as
  that, never guessed.
- the Hermes sign-in (token, or user and password) was not accepted.

A failed connection also leaves one line in the diagnostics log (Settings → Feedback): the
step, the kind, the time it took and the last SSH and Hermes lines. The line names no one: the
host as typed, the remote user, the host name and every IP address are replaced by `<alias>`,
`<user>`, `<host>` and `<ip>`, and tokens, key material, fingerprints and home folders are
removed. Only the person's own screen shows the host and what SSH said. Cancel closes pending
connection resources. Editing a draft does not silently disconnect an unrelated active chat.

SSH requires an existing supported Hermes installation, its working runtime and provider setup,
an SSH server, a POSIX shell and Python 3 on the remote computer, and a usable local SSH client.
The connection launches an isolated `hermes serve` on remote loopback and forwards it to an
OS-assigned local loopback port. It supervises the owned remote process and tunnel and stops
both when the connection ends or the plugin/app quits, with the same bounded deadlines as the
chat. This does not prove unrelated remote children were killed. Missing Hermes is an error;
setup never installs software on the remote computer.

The connection record stores mode, address or SSH overrides, chosen profile, discovered models,
and a credential reference. Tokens and authenticated session credentials live only in the
existing mode-0600 Bot secret store, with no Bot scope; saved values are never echoed. An SSH
identity path is a reference to the user's file, not a copy of its contents. Passwords and key
bytes are never persisted. Test credentials stay in a bounded transient draft until save/cancel.
The chat socket opens the way Hermes itself accepts each sign-in. A session token (a saved
token, or the one-time token of an SSH connection) opens `/api/ws?token=…` with no subprotocol,
as Hermes Desktop does: Hermes mints no ticket for a session token. A password sign-in keeps
its cookies out of every address: the transport mints a one-use ticket at
`POST /api/auth/ws-ticket`, then offers `hermes-gateway-ticket.<ticket>` beside the stable
`hermes-gateway-v1` WebSocket subprotocol. The address that holds a token goes to the socket
and nowhere else: it is never kept, and a `token=`, `ticket=` or `internal=` query is removed
from every row, error and diagnostics line. Streamed chat text is masked as one stream, not
frame by frame: a secret cut between two frames (inside a known credential, inside `?token=`
or inside the value after it, a bearer or a gateway ticket) is held until the next frame, so
no row shows a part of it. No credential enters command arguments or prompts.
The SSH-generated session credential travels over the encrypted channel, not SSH's argv. On
the remote computer it is written once, mode 0600, to the folder `hermes serve` reads it from
(`~/.hermes/desktop-ssh/<random>/`, mode 0700), and Hermes removes it after reading.

The oldest Hermes release that works is **v0.21.5** (`minimumRelease` in
`src/host/hermes-contract.json`, the one place that names it): the first release with Desktop
contract 8. v0.21.4 speaks contract 7 and gets the update screen. A newer contract that still
answers is not an error. A Hermes whose sessions are owned by a gateway (canonical authority)
cannot be used by this route and says so, with its one fix: connect to a Hermes started with
`hermes serve`.

**Approvals are Hermes's own.** No approval setting is required, read or waited for. A Hermes
that approves on its own (yolo, or its allow rules) simply runs its tools. When Hermes asks,
its question is shown in the chat and the person's answer is sent back: nothing answers yes or
no for them, at any chat level, and no deadline answers either. A level that asks (Read only,
Workspace, Auto review) shows the chat's approval card. A level that never asks (Full access
included) has no such card, so the question appears as a chat question with **Allow once** and
**Deny**. The question closes when Hermes withdraws it, the chat stops or the connection is
lost. Automagik's local sandbox does not constrain the remote computer. Distinct remote
approval boundaries are follow-up [#1084](https://github.com/automagik-si/automagik/issues/1084).
Other server requests (including secret/sudo/clarification) receive an unsupported-method error
in this delivery.

Text, remote tool cards, Stop and resume share the DSH chat. Stored/runtime session IDs and any
returned admission ID are saved. An ambiguous submit is never sent again automatically, and
never falls back to another model. **Connection lost; remote outcome unknown** requires
**Reconnect and reconcile** in setup. That action only reads: it never answers a pending
approval. It shows an authoritative snapshot when replay has a gap. Returning to the chat can
resume the existing remote turn and its DSH approvals; that message is explicitly not submitted
as a new prompt. Review the recovered result before sending a new turn. Stop requests interrupt,
waits up to five seconds for terminal confirmation, then detaches; background remote children
may continue. Startup and control waits are 60 and 15 seconds.

There is no DSH team-tool bridge: `message_bot`, `list_bots`, `create_bot`, `request_secret`,
DSH memory and schedules are unavailable remotely. Crossing routes uses the existing new
conversation and handoff confirmation. Model changes within this route use `--session` and do
not carry history across harnesses. A handoff note needs a configured native background model.

**Every Hermes release needs a contract review before updating this adapter.** The tested source
is [the generated OpenRPC contract at the pinned upstream commit](https://github.com/NousResearch/hermes-agent/blob/3bcd071226d3d605a2bb3b4f3933e7d583e189d6/apps/shared/src/gateway-contract.openrpc.json).
`src/host/hermes-contract.json` pins its full normalized digest and the transitive schemas of
all methods, events and server requests this delivery consumes. Download that generated file
for the proposed release into scratch, review its upstream diff, and run:

```sh
node scripts/hermes-contract.mjs <downloaded-generated-contract>
```

Any change exits nonzero and names the changed surfaces. Do not update the pin solely to make
the check pass: rerun the disposable fixtures against the reviewed shapes. At run time only a
contract older than 8 is refused; the checker is what reviews a newer one before this adapter
names it. The checker is offline and never contacts a Hermes instance.

The minimum release and the socket rule above were proven against real Hermes installs in
throwaway homes (v0.21.4, v0.21.5, v0.22.7, v0.23.0, v0.23.1 and the pinned commit), with the
start script run on the same machine and a stand-in model on loopback: no SSH, no other
computer, no provider key. Repeat that for a new minimum; the fixtures alone cannot show what
a real Hermes accepts.

## Agent access (MCP)

In **Settings → Agent access**, name the agent and choose **Create key**. Copy the key
immediately; it is shown once. Keep it private: it grants the instance owner's space reads and
Bot/group administration rights, including conversation text. **Revoke** asks first, then stops
new calls at once, including existing MCP clients. An action already admitted may finish. The
page lists each key with the day it was created and its last use, shows the address with an
example setup under **Connect an agent**, and keeps an **Access log** of recent allowed and
refused calls: the key's name, what it did, the target, the time, and configuration changes as
before and after lines. The log filters by key; **Refresh** loads new activity. Normal team
views show the edits too. In the protocol and in the files below, a key is an agent token.

Each space serves MCP over Streamable HTTP, using JSON responses rather than an SSE subscription.
The standalone listener starts when the first token is created and resumes on restart while an
active token exists. It defaults to `127.0.0.1` and an OS-selected port, shown in Settings.
Set the `omni-ui` plugin's `agentAccessHost` to the IP of the owner's private interface and
`agentAccessPort` to an unused local port for direct access from another machine. Local, RFC1918,
tailnet/CGNAT, IPv6 private and link-local addresses are accepted; public and wildcard bindings
are refused. The plugin opens no public port by default. Use a trusted private network or TLS
termination; the bearer token authenticates the agent but does not encrypt plain HTTP.

Claude Code can use this project `.mcp.json` configuration (replace the placeholders):

```json
{
  "mcpServers": {
    "automagik": {
      "type": "http",
      "url": "http://<PRIVATE_INSTANCE_ADDRESS>:<MCP_PORT>/mcp",
      "headers": {
        "Authorization": "Bearer ${AUTOMAGIK_AGENT_TOKEN}"
      }
    }
  }
}
```

Set `AUTOMAGIK_AGENT_TOKEN` in the agent's environment from your private token store. Keep the
actual token out of checked-in configuration, URLs, command arguments and logs. The listener
accepts bearer headers only, rejects URL queries, and rate limits failed authentication.
Browser Origin headers are refused by default. `agentAccessOrigins` may list exact HTTP/HTTPS
origins for clients that send one; it never enables credentialed browser CORS.

On a web instance behind the session gate, use
`https://<SPACE_ORIGIN>/api/omni-mcp` in the same client configuration. The gate forwards only
that literal path to the plugin's token-authenticated MCP route. It carries the bearer on that
hop, injects its own DSH credential, and drops browser cookies and identity/forwarding headers.
Missing, wrong or revoked agent tokens cannot use the path, even with a valid browser session.
Queries, aliases, WebSocket upgrades and all other routes keep the ordinary session gate.
Gate Host/origin/cross-site rejections happen before MCP and use the gate's existing audit.
Every request reaching MCP, including token refusals, appears in the owner's Access log.
Web-gate clients must omit Origin; DSH accepts the internal cookie-authenticated hop that way.
No separate public MCP listener or web session is needed. This path also supports future hosted
spaces without changing the token protocol.

An SSH tunnel remains an alternative when only local binding is wanted:

```sh
ssh -N -L <LOCAL_PORT>:127.0.0.1:<INSTANCE_MCP_PORT> <SSH_USER>@<INSTANCE_SSH_HOST>
```

Use `http://127.0.0.1:<LOCAL_PORT>/mcp` in the client configuration, with the same bearer header.
For a container, the SSH endpoint must share the instance's network namespace.

Read tools list/get Bots with role, instructions, model, effort, permission, folder and status;
list/get groups and membership; list/get Bot and group conversations with running/waiting/idle
state and last known activity; read text messages, safe settings, recent event metadata, and
the recent audit window. Lists accept `offset` and `limit` (1–100, default 50) and return
`nextOffset`. `read_messages` takes `id`, optional opaque `cursor`, and `limit`, returning
`nextCursor`. Bot messages reuse the app's chat paging across earlier parts; group messages
are newest first. Event activity covers up to 1,000 events seen since startup; an unknown last
activity is `null`. No arbitrary native Session or attachment is addressable through these tools.

Admin tools create/update/delete Bots and groups, edit instructions, model, effort and permission,
manage membership, and set Main Bot. Creation uses the team's default permission; `update_bot`
sets an explicit level through the same validator as Settings. Secret values, shell, files,
plugin installation and token management are absent from the MCP tool surface. Stored secret
values and agent token strings are redacted from all MCP responses and audit records.

Tokens live only as hashes in private `agent-tokens.json` beside the team. `agent-audit.jsonl`
keeps token name, tool, target, outcome and time for reads/writes; configuration writes also
record changed-field before/after values. Message bodies and read results never enter the audit.
Settings and `read_audit` expose up to the latest 200 complete records within the last 256 KiB.
A `started` write with no completion was interrupted; check the configuration before retrying.
