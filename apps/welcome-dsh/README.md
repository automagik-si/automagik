# Omni AI for DSH

`@automagik/welcome-dsh` is the first thing a DeepSeek Harness (DSH) shows with Omni
installed: the Omni octopus says hello, then helps you connect an AI. It adds no provider
code. Every sign-in it offers is one DSH 0.2.1-rc.4 already ships, and every route it
writes goes through DSH's own settings and credential store.

## What it does

Two steps on DSH's `settings.onboarding` slot, shown once each on a fresh start (a new
chat with nothing in it), ahead of DSH's own steps:

| Step | Order | What it shows |
|---|---|---|
| `omni-welcome` | −300 | The octopus, a typewriter speech bubble and a glitch, on a starfield. |
| `omni-connect-ai` | −200 | Connect AI: one switch per AI, Continue and Skip. |

The Omni channels plugin (`@automagik/omni-channels-dsh`) adds `omni-connect` (−250) between them when it
is installed. DSH's `welcome-notice` (−100) and `deepseek-official` (0) follow.

Each step draws its own modal and makes `#root` inert while it shows. When you finish or
skip a step, the plugin records it in its own settings entry, `omni-ai`, in three live
fields (`welcomeDone`, `connectAiDone`, `connectOmniSkipped`), so the step does not come
back after a restart. A step whose flag is already set completes without showing.

Connect AI is a list of switches, and several can be on. What this computer already has
comes first, under **Found on this computer**: a key in DSH's store
or in the environment, a sign-in DSH already holds, Claude Code or Codex signed in, a
CLIProxyAPI route, Ollama answering on `127.0.0.1:11434`. **Add another** shows four more, then the rest on demand. Continue
needs one AI really on; Skip finishes the step either way.

Flipping a switch on turns on what is set up, or opens its setup in the row: a key field,
the provider's own sign-in in DSH, or, for a provider that takes both (Grok), a choice of the
sign-in or a key. Claude and ChatGPT sign in only through their CLIs (Claude Code, Codex; see
below): their setup offers the CLI's **Sign in**, and for Claude an Anthropic API key. Off
stops using an AI and keeps its key, sign-in or account:

| Kind | On | Off |
|---|---|---|
| Key | writes the pi-ai route that names the key | removes the route; the key stays |
| Sign-in | the route is written once the sign-in succeeds; with no sign-in, a key the row also takes | removes the route; the sign-in and the key stay |
| Claude, ChatGPT | signed in to the CLI: turns on acp-dsh's `claude` or `codex` switch; else (Claude) the Anthropic key's route | turns that switch off, for every Bot on that agent, and removes the key's route; the CLI's sign-in and the key stay |
| CLIProxyAPI | the gateway form writes its route | removes the route; the key stays |
| Ollama | lists its models into a local OpenAI-compatible route | removes the route |
| dsh-subscriptions | shows the vendor's models again | hides them in that plugin's picker settings; the account stays |

DeepSeek is DSH's own route: its row turns on with a key or a DeepSeek account, and its key
is removed in Settings → Models. Every other provider DSH knows stays one link away, in
Settings → Models.

Continue gives the companion and the Omni Bot their model. Both are made without one, so
joining the team sends nothing anywhere; once Connect AI finishes with an AI on, each gets
the team's default model and its held greeting goes out, without a further click. With no
model that can run (Skip, or only a provider that still needs its key), they keep waiting
and their chats offer the ways to set one up.

### The team step and the preload

The team step (`omni-team`) asks who joins the companion's team: Omni and Genie, each a card
with what it starts with. Omni's card starts asleep; its power button installs what a plain
DSH lacks (below), then looks for an Omni to connect. Genie has no DSH plugin yet, and
says so; it can still be added to the team.

The Automagik desktop app passes the product it was opened for (`omni desktop` →
`--preload=omni`, `genie desktop` → `--preload=genie`) to DSH as `AUTOMAGIK_PRELOAD`, which
`state` reports as `preload` (`src/host/preload.js`; anything but `omni`, `genie` or
`unfold` is none). That card comes first and starts chosen: Omni's powers on by itself, through the
same box and steps as a press, and Remove still sends it back to sleep; Genie's starts on
the team. The other card stays to add, then or later. Without a preload Omni comes first
and nothing is chosen. Opening the team step on purpose skips the preload power-on.

Unfold's card is shown only in Unfold's own Automagik instance. Anywhere else the team step has
no Unfold card and `unfold-plugin-install` is refused, so the welcome installs no `unfold-*`
plugin. Unfold's own Automagik instance starts DSH with `AUTOMAGIK_HOST=unfold` or
`AUTOMAGIK_PRELOAD=unfold` (either one names it: `src/host/host.js`, the same rule as the Bot
team's and the Unfold Bot's). There Unfold's card comes first and is on the team from the start,
because the Unfold Bot is the instance's Main Bot, so the companion step is done (Unfold leads)
and no other Bot is made. `state` reports it as `host`, and Omni and Genie come with the
instance: Omni's card offers no new Omni of its own, and Genie's names the command line the
instance brought instead of the line that installs one.

When **Install Omni here** finds that npm cannot install the Omni this Automagik pins
(npm has an older version, the version is unpublished, the install failed, or systemd is
unavailable), the card says why and falls back to GitHub when needed. Without systemd,
the installer can also use npm when the version is available there. The card shows
Check, Download, Build, Install and Connect alongside the installer output, then connects
to Omni. Powering Omni off requests cancellation. If the install step is already underway,
it finishes that step. Reloading the team step picks up a running install and connects
on success. Apps shows the same install progress and offers **Power Omni on** to connect
after a successful install. See
[Installing Omni from GitHub](#installing-omni-from-github) for the host's checks.

### Power in each Bot's settings

Where the Bot team runs, the welcome puts each built-in Bot's power in that Bot's own
settings, through the Bot team's `botSettings` registry: `@automagik/bots-dsh/client` is in
`dsh.client.external` and in the build's `external`, and is looked up only when the plugin
applies, so a DSH without the Bot team gets no card and no error. A card titled Power shows
that Bot's state and one switch: Omni powers on or off, and Genie and Unfold stay on once
their Bot joins the team, as their boxes in the team step hold them. The card uses the Bot
team's own `Card`, `Row` and `SwitchRow`, the team step's state words (`On · Connected`,
`Powered off`, `Installing Genie · 2 of 3 · Bot team`), and the shared power store
(`src/client/power-store.js`), so a power-on keeps going when the settings page closes. A read-only
team gets the state line only. The card is registered for the Bot kinds `omni`, `genie` and
`unfold`; a Bot of any other kind gets no card.

A built-in Bot that is not installed has no settings page, so install does not move with
the power. The Bot team's Apps page (Settings → Apps, Automagik official) installs it in
one click: the Omni and Genie rows' Install runs the team step's own power-on
(`omni-plugins-install`, `genie-plugin-install`) in place, through the Bot team's
`officialInstall` registry, and the row shows the install's step and place. Opening the
page reads `omni-plugins` and `genie-plugin` once and picks up an install the host is
already running (a reload, another window); it never starts one. Nothing installs
without a click. The team step (`omni-team`) keeps Omni's and Genie's cards, and a DSH's
Plugins page installs the plugin directly. The old sidebar button is gone.

The team step follows the DSH language. Its copy is the `welcome.team` namespace
(`src/client/i18n.js`): the keys are the English text, registered in English and in Brazilian
Portuguese (`pt-BR`), and the rows the host sends are read through it too. A language pack that
adds `pt-BR` to DSH turns the step Portuguese; it registers no `welcome.team` dictionary of its
own, since DSH takes one per namespace and language. The other steps are English only.

### What the power button installs

The Bot team (`@automagik/bots-dsh`) is this repository's, at this plugin's version: from
the source this plugin came from, pointed at `apps/bots-dsh` (the same commit, or a linked
checkout), else that release's tarball. A release tarball is installed only after every
one about to be installed matches the `lane.json` on the same release, signed with a key
the plugin carries (`src/host/lane-keys.json`, a copy of `plugin-lane/keys.json`): the lane
for this version, each tarball's size, sha256 and sha512. One that does not match, or a
release without a signed lane, stops the install before anything is installed; the checked
tarballs are kept, 0600, under `<AUTOMAGIK_HOME>/welcome/tarballs`, where the profile
installs them from. A DSH that has the team under its former name,
`@automagik/omni-dsh`, has the team: it is switched on, not installed over. Omni's channels
and canvases (`@automagik/omni-channels-dsh`, `@automagik/omni-canvas-dsh`) install from one
commit in Omni's repository. `follow-omni.yml` keeps `automagik.omni` and the desktop app's
pin at the newest Omni release on GitHub; when npm lacks that release's Omni server, the welcome
builds it from GitHub (below, "Installing Omni from GitHub").
On a fresh install the welcome compares that pin with Omni's signed plugin lane. It picks
the newest candidate that works with this DSH, the Bot team, and an Omni server it can install:
the latest on npm, or the pinned release built from GitHub.
If no candidate pairs with the server, it picks the newest one compatible with DSH and the Bot
team. With one Omni plugin already installed, it looks for a candidate with that exact plugin
version. The shared pin is the fallback.
Genie installs from its signed lane when the plugin is compatible and at least as new as
`automagik.genie`, its fallback pin. Both lanes are checked with their publishers' public keys,
and the welcome records their installed sequences in `<AUTOMAGIK_HOME>/welcome/lanes.json`.

### One way to each AI

| AI | Through | Not offered |
|---|---|---|
| Claude | Claude Code's own sign-in (acp-dsh's `acp-claude`), or an Anthropic API key on pi-ai's `anthropic` route (`ANTHROPIC_API_KEY`) | DSH's Claude Pro/Max sign-in (`llm-pi-ai/anthropic`) |
| ChatGPT | Codex's own sign-in (acp-dsh's `acp-codex`) | DSH's ChatGPT sign-in (`openai-codex`) as a chat route |
| Kimi | DSH's sign-in (`kimi-coding`) | dsh-subscriptions' `kimi` |
| Copilot | DSH's sign-in (`github-copilot`) | dsh-subscriptions' `copilot` |
| Grok | DSH's sign-in (`xai`), or an `XAI_API_KEY` | dsh-subscriptions' `grok` |
| DeepSeek | DSH's key or account | pi-ai's `deepseek` route |
| Ollama | a local pi-ai route | dsh-subscriptions' `ollama` |

A pi-ai route still on DSH's own sign-in for Claude or ChatGPT (`openai-codex`, or `anthropic`
naming no key while DSH holds its Claude sign-in) is a duplicate of the CLI: the row says
*Also connected through DSH sign-in*, and once the CLI can answer, turning the row on (or
**Use only this**) removes that route, but only after the Bot team (bots-dsh's `omniTeam`,
`moveSubscriptionBots`) has moved the Bots on it to the CLI's route. While any Bot (its model,
or the model a pending switch goes back to) or the team's background jobs still run on it, or
the team cannot be read, the route stays and stays listed. Only the route: the sign-in record
stays, and so does any route that names a key. `signin-start` (and the other `signin-*`
endpoints) refuse `anthropic` and `openai-codex`: nothing here starts DSH's own Claude or
ChatGPT plan sign-in. Images and the companion's drawing on a ChatGPT plan go through Codex's
own sign-in (acp-dsh's `generateImage`); an `openai-codex` record an earlier version stored is
read as a last resort only when acp-dsh answers normally and declares a shared auth scope.
An OpenAI API key given to the app draws as before; one only inherited from the environment
does not (#869). dsh-subscriptions no longer ships `claude` or `codex` (0.7.21-omni.1), so
nothing stands for them.

The route earlier versions added for DSH's Claude sign-in did not retry a 429 (`retryPolicy`
without `RATE_LIMIT`). A route on an API key keeps DSH's default retries, also one such a
sign-in made before the key: saving the key drops the sign-in's policy (a policy set by hand
stays).

dsh-subscriptions keeps the vendors nothing else reaches (Cursor, Kiro, GLM, Qwen,
Perplexity, JetBrains, Cody, Replit and the rest). When an AI is turned on, the other ways
it is connected stop showing: their models are hidden, and no account or stored sign-in is
deleted. A row says when its AI is also
connected another way.

### Claude Code and Codex

With [`@automagik/acp-dsh`](../acp-dsh) in the DSH, Connect AI's Claude and ChatGPT rows are
these CLIs, and DSH's Settings (and the Bot team's) have a **Claude Code and Codex** page with
a row for each agent. Connect AI has no section of its own for them. Without acp-dsh, Claude
takes only its API key, ChatGPT is not offered a sign-in, and the Settings page says the ACP
agents plugin is not running. Each Settings row says (and a Connect AI row shows the same lines
while its CLI is missing, installing or failed, or signed in but not answering yet):

- for Hermes, Antigravity and omp (acp-dsh's native-ACP agents, off until switched on): the
  same row without a connector line, with what switching it on means while it is off, and with
  the terminal command that signs in instead of a Bot's chat (`hermes acp --setup`,
  `agy acp --login`, `omp login`); Automagik never installs these CLIs;
- whether the agent's CLI (`claude`, `codex`) is on this computer, as acp-dsh's own store has
  it: installing or updating it by itself, failed with its error and **Retry**, or found with
  its version; with its install link and **Check again** when it is missing;
- whether the CLI is signed in, as the CLI itself says (`claude auth status`, `codex login
  status`; only yes or no is read). Signed out, the row has **Sign in**. When the app shares
  the CLI's sign-in, it also shows the terminal command (`claude auth login`, `codex login`).
  When the app uses an isolated sign-in, use **Sign in** in a Bot's chat. Not checked yet, it
  says so; a check that timed out or could not tell says that instead; both with **Check again**;
- the connector acp-dsh installs in the background: installing, failed with its last error and
  **Retry**, or ready with its version;
- once ready and signed in, *Ready: pick Claude Code in the model picker*. The model appears
  without a restart; a DSH that has not loaded acp-dsh's routes says to restart instead.

**Sign in** (in Connect AI, **Sign in to Claude Code** or **Sign in to Codex**) opens the sign-in row in a Bot's chat (the selected Bot, or else the Main Bot), through
the Bot team's bridge (`Symbol.for('automagik.cli-login')`, [`@automagik/bots-dsh`](../bots-dsh)).
The row in the chat runs the CLI's own sign-in: a link to open on any device, then Codex's code
to type there or Claude's code to paste back in that row. This page only opens the chat: it starts
no sign-in, picks no model and never sees a link, a code or a credential. In Connect AI the step
steps aside while the chat is in front (a small **Back to setup** brings it back) and is not
completed by it; Settings closes its panel. If no Bot chat is available, isolated sign-in asks
you to set up a Bot first. With a shared sign-in, the row gives the terminal command. While a
sign-in waits, the busy file (`src/host/busy.js`, `AUTOMAGIK_BUSY_FILE`) counts it, so an
automatic plugin update does not restart DSH in the middle of it.

The switch is acp-dsh's own `claude` or `codex` setting, written through DSH's settings service,
and Connect AI's Claude and ChatGPT switches are that same setting: off there is off for every
Bot on that agent. An agent that can answer (CLI found, switched on, connector ready, no restart
pending, signed in) is an AI on: its row is on, it counts for Continue and for `aiConnected`.
A signed-out or still-installing CLI does not. Their copy is in the `welcome.team` namespace, in
English and pt-BR.

### Subscription sign-ins and vendor terms

A sign-in with a consumer plan is **personal use under the vendor's terms**: check that
provider's terms before you use a personal plan for work.

## Install into a raw DSH

The plugin needs DSH `>=0.2.1-rc.2 <0.3.0`. Add the Automagik marketplace index to DSH's
plugin market ([marketplace/README.md](../../marketplace/README.md) has the URL and the
steps) and install `@automagik/welcome-dsh` from it. DSH asks before it installs, then
applies the bundle patch (`cordis.patch.yml`), which adds one row, `id: omni-ai`, and
changes nothing else.

Restart DSH and start a new chat to see the octopus.

## The CLIProxyAPI route

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) serves an OpenAI-compatible
API for the providers you sign into on it. The form asks for its address (for example
`http://localhost:8317/v1`; an address without a path gets `/v1`) and its API key. On
Connect, the host:

1. Checks the address is `http://` or `https://`, with no user name, query or fragment.
2. Lists the gateway's models with `GET {baseURL}/models` and `Authorization: Bearer <key>`,
   without following redirects. An empty list refuses the save.
3. Stores the key with `ctx.credentials.set('OMNI_AI_CLIPROXY_API_KEY', key)`.
4. Writes the route into pi-ai's settings entry with
   `ctx.settings.update('llm-pi-ai', patch, revision)`, the revision read from
   `ctx.settings.describe()`:

   ```yaml
   providers:
     cliproxy:
       displayName: CLIProxyAPI
       api: openai-completions
       baseURL: http://localhost:8317/v1
       apiKeyEnv: OMNI_AI_CLIPROXY_API_KEY
       models:
         - { id: <model id>, name: <model id> }
   ```

The key never enters a settings file, a reply or a log: the route names it by the
env-shaped credential reference, which DSH resolves for each request. Saving again
replaces this route's model list and keeps every other route. Use `https://` for a
gateway that is not on your own machine, since the key travels with each request.

The shape was read from DSH 0.2.1-rc.2:

- `dsh-llm-pi-ai`: `Config = z.object({ providers: z.dict(profile).default({}).volatile() })`,
  where a profile has `apiKeyEnv` (a credential reference), `displayName`, `api`, `baseURL`
  and `models: [{ id, name, … }]`. Its README: a route pi-ai does not ship needs `api`,
  `baseURL` and a non-empty `models` list. The base bundle mounts it as entry `llm-pi-ai`.
- `dsh-settings`: `update(ns, patch, expectedRevision)` deep-merges plain objects and
  replaces arrays, so other routes stay and this route's `models` is replaced.
- `dsh-credentials`: a reference matches `/^[A-Za-z_][A-Za-z0-9_]*$/`.

## Host endpoint

`POST /api/omni-ai` with `{ endpoint, payload }`, answered `{ ok: true, value }` or
`{ ok: false, error: { code, message } }`:

| Endpoint | Payload | Does |
|---|---|---|
| `state` | none | The flags; `deepseek` (a `DEEPSEEK_API_KEY` or a DeepSeek account sign-in is stored); `piAiRoutes`; `aiConnected`; `preload` (`omni`, `genie`, `unfold` or null); `host` (`unfold`, only when set); `machine` (`{ os, remoteHint? }`: the OS family DSH runs on, `macos`, `windows`, `linux` or `other`, and `remoteHint: true` when DSH was launched over SSH; never the hostname, user or home). |
| `done` | `{ stepId, connected? }` | Sets the flag for `omni-welcome`, `omni-connect-ai` or `omni-connect`. Connect AI's Continue sends `connected: true`: the companion and the Omni Bot, made without a model, then get the team's default model (DSH's default model when it is served and has its key, else the first model that can run), and their held greetings go out. Skip sets nothing. |
| `cliproxy` | `{ baseURL, apiKey }` | The route above; answers `{ route, baseURL, models }`. |
| `ais` | none | Every row: `{ id, name, via, kind, ready, on, found, signIn?, keyUrl?, needs?, duplicates? }`, and dsh-subscriptions' accounts and hidden vendors. Names and states only. |
| `ai-switch` | `{ id, on }` | Turns a row that is set up on or off (table above). |
| `ai-dedupe` | `{ id }` | Stops the other ways that row's AI is connected. |
| `ai-subscription` | `{ provider, on }` | Shows or hides a dsh-subscriptions vendor's models. |
| `provider-key`, `signin-*` | see `src/host/providers.js` | A key, or a sign-in run through DSH's authorization service. |
| `omni-plugins` | none | The Omni plugins (`@automagik/bots-dsh`, `@automagik/omni-channels-dsh`, `-canvas-dsh`): each one's version and whether it is installed, `ready` once they run here, the plugin install in progress, and the local Omni installer job in `server`. |
| `omni-plugins-install` | none | Installs the missing ones in order through DSH's plugin manager. The Bot team comes from this plugin's sibling source or checked release tarball. Omni's plugins come from the release chosen above. Switches on installed plugins that are off. |
| `genie-plugin-install` | none | Installs the Bot team if needed, then installs Genie from its signed lane or its pin. Switches on installed plugins that are off. |
| `omni-server-check` | `{ version, fallback?: true }` | Checks the version named by the card's installer command on its npm registry. With `fallback: true`, reports whether the local installer can take over and the pinned GitHub release it can use. |
| `omni-github-install` | `{ version, reason, exitCode? }` | Starts the local Omni install or returns the running job. The host checks which source is usable. |
| `omni-github-status`, `omni-github-cancel` | `{ id? }` | Reads the current or named job, or requests cancellation. Once Omni's installer starts, it runs to completion. |
| `omni-github-ack` | `{ id }` | Claims a completed job once so a single card connects to the new Omni. |
| `acp` | `{ refresh? }` | Claude Code and Codex, from acp-dsh's `acpAgents` service: `{ available, agents: [{ id, key, name, on, cli: { found, installUrl?, state?, version?, updating?, error?, diagnostic?, logPath? }, connector: { state, version?, error? }, signedIn?, signInCheck?, listed, restartNeeded }] }`. `signInCheck` is `timeout` or `unreadable`: why the last check could not tell, only while `signedIn` is absent. `refresh` looks for the CLIs again and asks each whether it is signed in. `{ available: false }` without acp-dsh. |
| `acp-switch` | `{ id, on }` | Writes acp-dsh's `claude` or `codex` setting in the entry its service names (`settingsEntry`, else `acp-dsh`) at the revision `describe()` gave. |
| `acp-retry` | `{ id }` | Starts a failed connector install again. |
| `acp-install` | `{ id }` | Installs a CLI acp-dsh installs only on the person's click (Antigravity, `cli.install: 'manual'`) through its `installCli`, while the agent is on; answers at once with the install under way. Refused while off, or by an acp-dsh without `installCli`. Needs the owner viewer like `acp-switch`. |
| `bot-type` | `{ type: 'omni' }` | What the Omni Bot starts with, as groups: model and thinking (DSH's default), plugins with versions, tool groups with their switches, skills, folder and permissions. |

The host declares `inject: ['settings', 'credentials', 'connection']`; `connection` serves
the route. It reads DSH's `llm`, `authorization`, `pluginManager`, `agentDefaultModel`, `tools`, `skills`
and `permissionPresets` services when they are there, and acp-dsh's `acpAgents`.

### Installing Omni from GitHub

Omni's own Connect card uses the welcome's install check for **Set it up** and **Update and connect**. When it uses the GitHub install job, the terminal shows the install source and progress, then connects to the sandbox when it is ready.

The welcome can build the Omni release pinned in its package manifest when the version offered by npm is behind, unpublished, or the npm terminal install fails. Without a usable service session, the welcome runs the installer itself. It uses npm when the requested version is published and at least as new as the pin. The GitHub route requires the pin to be at least as new as the requested version. An image with the Omni supervisor installs into a fresh sandbox and lets the supervisor start it. An interrupted image install can resume in the same sandbox at the same version. An existing supervised sandbox stays in place.

The welcome checks that the GitHub tag resolves to the pinned commit and that its commit API names the pinned Git tree. It streams and verifies the commit archive against that tree before extraction. It verifies the Bun zip and executable against pinned SHA-256 hashes. The build installs dependencies with lifecycle scripts disabled, then runs Omni's pinned build and pack scripts with an allowlisted environment and scratch home.

The Omni root is `OMNI_HOME` or `~/.omni`. It holds the sandbox in `sandbox/`, Bun in `automagik-bun/`, and the packaged CLI in `packages/`. The installer removes its temporary checkout under `automagik-build/` after the build and install processes stop. The image publishes `sandbox/automagik-supervised.json` after a successful install so the supervisor can start the sandbox. On desktop, Omni can adopt an existing sandbox once its process has stopped. Omni starts at login when the desktop has a usable login service and starts its own detached supervisor on Linux without one. Omni manages cleanup inside the sandbox home.

DSH, Bots and Omni share the workspace identity. Omni's build scripts can read files accessible to that user. The local installer is unavailable in multiuser mode and in Unfold's instance. The channels plugin runs its own Bun probe when it prepares a terminal install. Omni's inner runtime install drops proxy settings, so a proxy-only network can block that step. The build and embedded runtime were exercised on Linux x64 with glibc.

## Develop

```sh
bun install          # esbuild, for the client bundle
bun run harness      # the pinned DSH release the tests and the linter run against
bun run test         # on Node, as DSH runs
bun run lint
bun run build        # rewrites client.js; commit it
node scripts/build-client.mjs --check
```

`client.js` is generated from `src/client` and committed, so git and `link:` installs need
no build step.
