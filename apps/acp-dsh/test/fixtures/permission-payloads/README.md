# Permission payloads of real agents

What a real agent sent in `session/request_permission`, and the tool updates around it, kept so
the code that answers those questions is checked against the real shapes and not against a guess
(A0 of the ACP permission study; `test/permission-payloads.test.js` reads these files).

| File | Agent | How it was captured |
|---|---|---|
| `codex-acp-2.6.0.json` | Codex 0.167.0 through `@agentclientprotocol/codex-acp` 2.6.0 | One real turn per case through `AgentRun`, each question answered `reject_once`, so nothing asked for ran. The working folder is replaced by `/workspace`. |

Claude Code is not captured yet: it needs a signed-in Claude Code, and until then Claude Code stays
off Auto (RFC 0031, question 5, decided by the owner's delegate on 2026-11-21). A scripted local
model is not a substitute: it cannot show whether the CLI really entered `auto`. A capture pins the
CLI, adapter, model and tool surface, runs isolated with synthetic files, and records the requested
and effective mode and any fallback notice beside the fields below.

## What the Codex capture shows

One capture of one version (Codex 0.167.0, codex-acp 2.6.0): what it shows holds for that pair,
and a new capture may differ.

- **An ordinary question carried the command as its title**, the same title as the call's own
  `tool_call` update, and the same `toolCallId`. It had no title of its own ("Run command?").
- **The network case shows a failure followed by a retry under a new id.** Codex first ran the
  command as one call, which failed; it then opened a second call with a new `toolCallId`, the
  same title and the same `rawInput`, and asked about that one. The payload does not say what
  the retry would run under, and nothing in the question tells it from an ordinary one: no
  extra field, no `_meta`, no different option.
- **All three questions offered these option kinds:** `allow_once`, `allow_always` ("don't ask
  again for commands that start with …") and `reject_once`.
- **Neither `agent`-mode turn requested permission.** In the case that touches a path outside
  the workspace, Codex's own reviewer (a `think` call titled "Guardian Review") reported the
  command approved, and the command's call completed, with no `session/request_permission`.

Not in the data, only how it was captured: every question was answered `reject_once`, and the
file the approved `agent`-mode command made was removed afterwards.

## Capturing again

Run one turn per case through `AgentRun` with the adapter from `dev/install-adapters.mjs`, wrap
`run.onPermission` to record the params and answer `reject_once`, record every `tool_call` and
`tool_call_update`, and replace the working folder's path. Keep prompts free of anything personal.
