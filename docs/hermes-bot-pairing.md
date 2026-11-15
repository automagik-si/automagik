# Pair an existing Hermes Bot

A Hermes Bot is a profile, not a working directory. Its forever-chat is the session
with the exact title `Bot Chat`. Automagik resolves that title again when opening;
it does not pin a physical compression segment, create a replacement chat, copy
credentials, or overwrite Hermes's instructions/model.

## Herdr

The command is `am`; `automagik-herdr` still works as an alias for `am`.

In Create/Edit, choose Hermes and fill **Pair an existing Hermes Bot** with the
absolute Hermes data folder and exact profile name on the machine running the pane.
For the root profile, explicitly choose `default`. Leave both empty for the existing
unpaired behavior. The equivalent command is:

```sh
am edit <bot> --agent hermes --no-model \
  --hermes-home /srv/agents/research --hermes-profile research
```

Start and Restart set `HERMES_HOME` and the explicit profile, then run
`hermes --profile research --tui --continue 'Bot Chat'`. No create-if-missing or
latest-session fallback is used. An absent chat must be set up in Hermes first.
The selected Herdr machine remains the execution location; a project folder does
not select a different Hermes backend.

A paired seat does not receive an ephemeral system-prompt replacement. Fresh,
agent/model swap and template restarts refuse while paired. Task workers do not
inherit their lead's forever-chat. To unpair without deleting any Hermes data:

```sh
am edit <bot> --no-hermes
```

Duplicate home/profile pairs are rejected within a project roster. This is not a
cross-machine distributed lock: separate registries and path aliases are not proven
unique. Hermes remains responsible for its own concurrent session admission.

## Automagik DSH

Use Settings → Remote Hermes to connect: choose the computer, Connect; a profile is
asked for only when Hermes has several. Under **More**, Through SSH also accepts an
explicit **Hermes home** (an existing absolute data folder); executable path and data
home are separate fields. The owned server and its one-shot token
use that home, never an inherited profile or another user's default home.

First choose the Remote Hermes route in the intended Bot's chat, then select that
existing Automagik Bot in **Pair Hermes Bot**. Pairing refuses a Bot still set to
another provider rather than silently changing its model. Pairing verifies the
selected profile's existing `Bot Chat` without sending a prompt. Use the Remote
Hermes route in that Bot's chat. Its own-chat segments reuse one remote identity;
other Bots, groups and tasks are refused rather than sharing its private context.
Choose **Not paired** before changing the binding. Pending/uncertain turns must be
reconciled first. Unpairing preserves reconciliation history and remote data.

Canonical lookup is strict: missing, ambiguous, wrong-title and wrong-profile
responses fail closed. It never recovers by making an untitled session. A changed
canonical owner during an uncertain submission is refused for manual reconciliation.
Existing non-paired connections keep their prior session behavior.

### Protocol boundary

This builds on the Remote Hermes standalone Desktop-contract-8 transport. It uses
`session.list` with `title: "Bot Chat"`, then resumes its returned compression tip.
The newer `hermes-gateway-v1` canonical-authority protocol is still explicitly
unsupported by that transport; pairing does not pretend the two dialects are the
same. This change does not add Automagik team tools to Hermes or migrate profiles.

Upstream reference: https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode
