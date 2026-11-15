# Português (`@automagik/locale-pt-br-dsh`)

Brazilian Portuguese for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). DSH 0.2.2 ships Portuguese itself, as **Português** (`pt`); this client plugin adds the part DSH does not carry — the Bot team's own `omni-ui` strings — under that same entry. It adds no language: Settings › General › Language keeps exactly **one** Portuguese row, DSH's.

Supported runtime: **DSH 0.2.2-rc.2 or later** (`engines.dsh` is `>=0.2.2-rc.2 <0.3.0-0`). Earlier DSH series have no `pt` to register under; this pack requires rc.2 or later.

## One Portuguese entry

The pack used to add its own **Português (Brasil)** entry with a corrected copy of four DSH namespaces (date order, thousands separator, the plan hint and several mistranslations). A pack cannot override a namespace DSH already registers for `pt` — the second registration throws (`locale namespace "<ns>" already has locale "pt"`) — so those corrections required a second language, and therefore a second Portuguese row in the picker.

That row is gone. The Language list shows DSH's **Português** alone, and DSH's `pt` copy serves the DSH screens. The pack's own strings are the Bot team's, and they belong to the Bot team's namespace: DSH does not have `omni-ui`.

## What it carries

| Namespace | Keys | Why |
|---|---|---|
| `omni-ui` | all | The Bot team's namespace (`@automagik/bots-dsh`), which DSH does not have; registered under `pt` |

`omni-ui` holds every Bot team key. A few keep their English text on purpose: brand and product names (`Omni`, `DSH`, `Automagik`, `DeepSeek`, `Claude`, `Codex`, `ChatGPT`, `OpenAI`, `Anthropic`, `Google`, `GitHub`, `Namastex`, `Kimi`, `WeChat`, `WeCom`, `DingTalk`, `Feishu`, `MCP`, `API`), code-like strings (`cookies.txt, JSON, storageState`, `MEMORY.md`, `GITHUB_TOKEN`, `~/.codex/pets`, `#rrggbb`, `@Name`, `/side`, `/feedback`), words Brazilian Portuguese uses unchanged (`Chat`, `Bots`, `Plugins`, `Admin`, `Site`, `Terminal`, `Endpoint`, `Feedback`, `Skill`, `status`, `tokens`, `Pets`, `Chats`, `Design`, `Beta`, `Cc`), and strings that are only a value (`{count}`, `{n}h`, `1 item`, `{percent}%`, `{label}: {version}`). `test/coverage.test.js` requires every Bot key to have an entry and at least 95% of them to differ from the English text.

A plugin from outside this repository can add its own words to `omni-ui` through the Bot team's `addStrings`. `scripts/copy-check.mjs` lists in `OMNI_PLUGIN_STRINGS` a recorded fixture of the keys each one adds (their English text), under `test/fixtures/`: today `unfold-session-strings.json`, the model-menu messages of Unfold's session plugin, recorded at the hand-over commit when it left with the Unfold plugins (RFC 0020). Those keys are checked and covered like the Bot team's. The Bot team words a host message with any language pack's entry for it.

The welcome (`@automagik/welcome-dsh`) keeps its own copy in its `welcome.team` namespace and registers it under DSH's `pt` as well, so the onboarding reads in Portuguese with this pack installed.

## Upgrading from the old pack, and removing it

A profile that installed the pack before 0.2.2 has an older copy that registered a **pt-BR** language and its dictionaries. DSH replaces a plugin in place: when it loads this version it unloads the old one first, whose language and dictionary effects are disposed with it. This client adds no language at all, so it cannot leave a second Portuguese row behind; while the old copy is still mounted, it does not register over the dictionary the old copy holds (it waits for that copy's disposer), so nothing throws on a duplicate locale registration.

A language choice saved as `pt-BR` under the old pack is an exact id to DSH's locale runtime, and DSH's entry is `pt`. On load the pack rewrites the stored choice through the runtime's only preference write (`setLocale`), before the choice is read, so a team that picked **Português (Brasil)** opens in Portuguese instead of falling back to English. A browser or home that never picked a language is left alone.

To stop shipping the Bot team's strings, remove the plugin: `dsh plugin --profile <profile> remove @automagik/locale-pt-br-dsh` (or Settings › Plugins, then the Plugins page, which manages what the list only shows). DSH's own **Português** entry and everything DSH translates stay; only `omni-ui` falls back to its English text, and a saved `pt` choice keeps resolving.

## Install

1. Add the Automagik market to DSH's plugin market ([marketplace/README.md](../../marketplace/README.md) has the URL).
2. Install **Português (Brasil)** — the market title of this pack. If DSH asks for a restart, restart it.
3. Pick **Português** in Settings › General › Language (DSH's entry), or open DSH in a browser set to Portuguese.

The client declares `inject: ['locale']` and loads in DSH's first boot phase (`immediately`). The host half does nothing. It needs no settings.

## Develop

```sh
bun run harness      # the pinned DSH release the tests and the linter run against
bun run build        # client.js from src/client; commit it with the sources
bun run test         # on Node: a fake locale service, then DSH's own LocaleRuntime
bun run lint
node scripts/copy-check.mjs     # every pt-BR text against its English text and the copy rules
```

`src/client/locales/pt-BR/omni-ui.json` is keyed by the Bot team's English text. The copy check rejects a key the Bot team no longer has and every `{placeholder}` that does not match its English text. Its rules: Brazilian Portuguese, gender-neutral for the person, no article before Unfold, "clique" for a click, and "ambiente isolado" for a sandbox.
