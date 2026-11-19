# RFC 0034: Vault plugin, Bitwarden first

| Field | Value |
|---|---|
| Status | Queued |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P), desktop (3.N) |
| Created | 2026-11-19 |

## Summary

Propose an optional Vault plugin, `@automagik/vault-dsh`, that makes a password manager a
**source** for a Bot's secret instead of another place the value is copied to. A Bot still asks
`request_secret` by name and uses `$DSH_SECRET_<NAME>`; the value is read from the vault when an
approved command needs it and is not saved by Automagik. Bitwarden's `bw` is first, read-only,
and the Bot team keeps every authorization decision. The owner has not read this proposal; the
numbered questions below decide it. The issue calls it RFC 0033, but 0033 is
[Attachments from Pocket](0033-attachments-from-pocket.md), so this is 0034.

## Motivation

The person who runs a team already keeps its credentials in a password manager. When a Bot needs
one, today the person types the value into the Bot's card. That makes a second copy in
`<team home>/secrets.json` (mode 0600) and in the Bot team's process
(`apps/bots-dsh/src/host/secrets.js:609`, `:729`). The Bot asks with `request_secret` and sees only
the variable name; `list_secrets` lists names and scopes, never values (`:1048`, `:1109`). Masking
replaces exact copies on tool results and model requests (`:1139`, `:1153`), and the README says
it does not cover encoded, split or reversed values, or a shell that sends one out.

What today's handling does not do:

- **Revocation and lock.** Deleting or rotating the item does nothing to the copy in a file or a
  running shell; Automagik cannot tell the vault changed, and no vault lock stands behind a saved
  value.
- **Item-level access.** Scope is every Bot or a list of them (`secrets.js:40`), not one item and
  one field. Every secret a Bot may use goes into every shell call it makes, not only the command
  that names it (`secrets.js:1166`).
- **One source of truth.** The person maintains the vault and the card separately, so the vault's
  2FA, audit and lock do not apply to the copy.
- **Least privilege for non-shell consumers.** MCP capabilities, the GitHub connector and Remote
  Hermes read through a synchronous, unscoped `rt.secretValue`; they cannot ask for one item for
  one destination.
- **A safe default without the vault.** Today the copy is the fallback; a vault-backed secret must
  fail closed instead.

It serves the person or team that wants one place to revoke a credential, and a Bot that needs a
named credential for one command. It is not a way for a Bot to browse a vault, and it does not
replace DSH's `ctx.credentials`, the profile's model-key store (`apps/welcome-dsh/README.md:229`,
`:258`).

## Design

### The decision, and the options

The decision is whether a password manager becomes a secret source, and under which boundary and
first manager. The recommendation is (b) below: an optional plugin, Bitwarden `bw` first,
read-only, with `bots-dsh` keeping authorization.

| Decision | Options and trade-offs | Recommended |
|---|---|---|
| Is a vault a source at all? | (a) No: no new trust boundary, but the copy stays. (b) An optional plugin: the boundary exists only where installed; one more plugin to install, update and audit. (c) Build it into `bots-dsh`: every team gets it, but every install carries vault code and cannot turn the boundary off cleanly. | **(b)** |
| Bitwarden transport | (a) Wrap the installed `bw` CLI: login, unlock, 2FA, SSO and Vaultwarden through `bw config server` already work; it parses CLI output, trusts third-party code, and a Bot with a shell could run the same CLI. (b) Speak the Vault Management API: no local CLI, but its public contract is organizational, not a personal vault, and it needs more credential and crypto handling. (c) Use Bitwarden Secrets Manager (`bws`): machine accounts and least privilege, but a separate paid product for organizations. | **(a) first**; (c) next; (b) only if a stable personal-vault API appears |
| Where values live at rest | (a) Nowhere outside the vault: no value cache, and the session key exists only in the plugin's memory. (b) An in-memory value cache with a TTL: fewer reads, wider exposure. (c) The OS keychain for the session key: survives a restart, but turns "unlock" into "already open" and adds a platform store. | **(a)**; no value cache; no keychain in the first cut |
| Locked vault | (a) Refuse, name the lock, and let the person unlock in Settings, then retry. (b) Ask for the master password in the Bot's chat: the Bot and the chat see it. (c) Use a cached value. | **(a)**; never (b) or (c) |
| Offline vault | (a) Refuse: a stale or revoked value is worse than no value. (b) Read `bw`'s local encrypted cache while unlocked: works offline, but may serve a value the vault no longer authorizes. | **(a) first**; (b) only as an explicit, default-off setting with a staleness bound, later |
| Bot on a machine without the vault | (a) Unavailable, with a reason; the person can install the plugin or map a typed secret explicitly. (b) Fall back to a stored value: that recreates the copy. (c) Queue the read: a command must not run with a value that arrives later. | **(a)**; never (b) or (c) |

### The shape and the seam

`apps/vault-dsh` is a DSH host plugin, installed from the market and turned on in Settings ›
Plugins. "Vault" here means a password manager, not HashiCorp Vault, which is one later adapter.
It provides one service, `secretSources`, with one adapter per manager. An adapter can unlock,
lock, report status, list items for the person's picker, and read exactly one field. It can read;
it cannot grant.

`bots-dsh` injects it (`ctx.inject(['secretSources'])`, as it does `acpAgents`) and keeps
`request_secret`, `list_secrets`, scope, cards, masking and the audit. It never asks the plugin to
list or search the vault for a Bot, and never passes a Bot's argument as the item reference.
Without the plugin the service is absent and the Secrets page, cards, tools and shells behave
exactly as now.

The plugin never reads `<team home>/secrets.json`, writes a value, or puts a session key in
`ctx.credentials`: that is the profile's model-key store, a file in the profile, where a session
key must not be.

### How a value reaches a Bot (just in time)

1. The Bot's identity comes from the execution (Session, Bot, chat, turn), never its arguments.
2. The name already maps to a source, mapped by the person; a Bot cannot create a mapping or name
   a provider, item or field.
3. `bots-dsh` checks the grant: this secret, this Bot, this consumer (exact command or destination
   and config revision), one use.
4. The person approves in the Bot's own chat. The card names the Bot, secret, purpose, provider,
   item, field and exact command or destination. The default is **allow once**; a timed or
   standing per-Bot grant is an explicit choice.
5. Only then does the adapter read that one field. It checks the connection is unlocked and the
   item exists, and reads no other field or item.
6. The value enters masking before the command is prepared and goes only into that execution's
   environment. The shell resolver is synchronous today, so the read finishes first; there is no
   process-wide environment and no value in the next call.
7. The command runs; tool results and the next model request are masked as today.
8. `bots-dsh` writes one audit row and drops the value. The plugin keeps no value cache; a second
   use asks again.

### The surface a Bot sees

`request_secret` and `list_secrets` keep their names and stay owned by `bots-dsh`. The Vault
plugin registers **no Bot tool**: no `vault_*`, no `bw_*`, no `op_*`. A Bot reaches a vault-backed
secret only through a name the person already mapped.

- `request_secret` on a vault-backed name shows an **allow** card, not a fill card. If the vault
  is locked, the card says so and offers the person the unlock in Settings; the Bot gets a note
  and no value.
- `list_secrets` shows the name, purpose, scope, and one availability word: available, locked or
  unavailable. It never shows the provider, item, field, reference or value.
- The Bot may read exactly the one value, in the one approved execution. It cannot list, search,
  export, read another field, write, unlock, change scope, or supply a vault reference.
- The first cut reaches the shell only, through `$DSH_SECRET_<NAME>`. MCP capabilities, the
  GitHub connector, Remote Hermes and persistent shells come later, bound to a destination and a
  config revision, as delivery 5.
- Cards appear only in the Bot's own chat; a group chat cannot approve, as today.

### Boundaries

- **Never logged, never in the profile, a session, diagnostics or the audit:** the value, the
  session key or API token, the master password, the item reference and path, the field, the
  connection label, and raw manager output. An error is reduced to a code before it is shown or
  logged.
- **The person must approve:** the mapping (name to provider, item and field, with its scope), the
  unlock, each use (default once), turning the plugin on, and a new connection. A Bot can never
  approve any of these.
- **No listener:** the plugin never runs `bw serve` or any HTTP server, opens no port, and calls
  only the manager's own CLI or API.
- **No typed fallback:** turning the plugin off, uninstalling it, losing the vault or going
  offline makes vault-backed names unavailable. The plugin never converts one into a stored
  value; the person must map a typed secret explicitly if they want one.

### Lock, cache and quit

The value cache is zero by default. The vault locks after an idle time the person sets, default
5–15 minutes and at most 8 hours, and when the app quits or the plugin is turned off. On lock the
plugin drops the session key and runs `bw lock`. The next use says the vault is locked; only the
person unlocks. Unlock credentials are typed into the host's Settings, never into a Bot's chat,
and never travel over a plain-HTTP page off loopback.

### Routes

- **macOS, Windows native and Linux:** the person installs `bw`; the plugin runs where DSH runs,
  so the CLI must be on that same computer. A Windows-native DSH cannot see a CLI installed only
  in a WSL guest, and the reverse.
- **WSL (RFC 0016):** DSH and `bw` live in the guest; the Windows-side `bw` is not used.
- **Sandboxed Bots (RFC 0010):** the read happens on the host, outside the Bot's sandbox, and only
  the value enters the approved command.
- **Pocket and remote:** the person may approve; they never unlock from the phone. Unlocking is
  a host-side Settings action.
- **Cloud:** service accounts only (`bws`), never a person's master password or personal vault.
  This is question 10.
- **ACP routes:** the Bot's DSH shell path is unchanged; a value reaches only that execution, not
  an agent's own built-in shell.
- A route that cannot be supported in a delivery is named in that delivery and approved by the
  owner; it is never left out silently.

## Contracts introduced

- `@automagik/vault-dsh` (`apps/vault-dsh`), an optional market plugin. It adds no package
  dependency and bundles no manager CLI. The person installs `bw`; the plugin names a minimum
  version and never updates it.
- Service `secretSources`, version 1: status, unlock, lock, a read of one field, and a person-only
  item list for the picker. Unlock input comes from the host's Settings, never from a model
  message. A Bot-facing list or read-all is not part of the service.
- `<team home>/vault-sources.json`, mode 0600, version 1: name, provider, connection label, item,
  field, scope, purpose, requester and timestamps. No value, ever. The connection is a label;
  `bw config server` owns the server address, so Automagik stores no host.
- `secrets.json` is unchanged (version 1, values only). An older `bots-dsh` ignores
  `vault-sources.json`: its vault names are then unavailable and no value appears. Restoring the
  newer plugin restores the mappings, and nothing is converted.
- The existing `POST /api/omni-ui` route (the browser session cookie) gains `secret-source-set`,
  `secret-source-clear`, `vault-unlock`, `vault-lock` and `vault-status`; they are refused when
  `secretSources` is absent. Older clients ignore them; the source row appears only when the
  service is present.
- Unchanged: `DSH_SECRET_<NAME>`, `request_secret`, `list_secrets`, scope and cards. Newly
  removed from every Bot shell and MCP environment: `BW_SESSION`, `BWS_ACCESS_TOKEN`,
  `OP_SERVICE_ACCOUNT_TOKEN`, `VAULT_TOKEN` and every adapter's unlock variable.
- `<team home>/vault-audit.jsonl`, mode 0600, bounded and rotated: time, secret name, Bot id,
  consumer kind and digest, decision, result. No value, reference, field, connection or raw
  command.
- No new release lane. A vault change after the first release is a plugin patch (3.N.P). The first
  release adds `apps/vault-dsh` to the plugin lists (`scripts/lane.ts`, `scripts/version.ts`, the
  release and CI plugin loops, `apps/desktop/src/lane.js`) and to `marketplace/automagik.json`,
  so that first release is a desktop release (3.N), per
  [RFC 0011](0011-monorepo-parts-and-releases.md). It is market-only by default, not in the
  desktop profile's preinstalled bundles.

## Threat model

The trust boundary is the DSH host process, not the Bot. The person unlocks; the plugin holds the
session key; `bots-dsh` authorizes; the Bot gets one value in one approved execution. Settings
endpoints are on the authenticated browser route, the approval comes from the owner's chat, a
grant is bound to one execution, and there is no network listener.

- **Prompt injection or a compromised Bot.** A request gives no authority. The approval is the
  boundary: it names the exact command or destination, and covers one execution. If the person
  approves a command that sends the value out, the Bot can leak it; masking is a safety net, not a
  boundary. A Bot that encodes, splits or reverses a value can still leak it, as the README says.
  Only OS isolation or the sandbox ([RFC 0010](0010-desktop-sandbox.md)) stops same-user
  processes.
- **A Bot running the manager CLI itself.** Unlock variables are removed from every Bot shell and
  MCP environment, and Auto treats `bw get`, `bws secret get`, `pass-cli item view|run`,
  `keepassxc-cli show`, `secret-tool lookup` and `op run|inject` as secret reads, as it already
  treats `op read` and `vault kv get` (`apps/bots-dsh/src/host/auto-judge.js:68`). A CLI with no
  session is locked; the plugin never accepts a master password from a model.
- **A shared machine.** Another OS user cannot read a 0600 file or another user's process memory,
  but a same-user process can read both. The lock timer narrows the window, and a separate OS
  account or the sandbox is the real boundary. The mapping file names items, sensitive even
  without values.
- **A stolen machine or session key.** The session key is memory-only and dies with the process
  or the lock. A stolen key can read what that vault account can until the session is revoked;
  scoped accounts and the lock limit it. Revoke the vault session, rotate the credential, and
  delete the mapping. A value already read and approved cannot be taken back.
- **A compromised plugin or `bw`.** Either can read what the session key can and exfiltrate it.
  The plugin cannot grant access; it is optional, reviewed, on the signed plugin lane and pinned
  in the market. `bw` is third-party code the person installs; a malicious update is a
  supply-chain risk. The first cut trusts both as much as the DSH host.
- **Logs and errors.** The manager is never asked for a whole item when one field is needed, its
  output is reduced to a code, and the audit holds no value or reference. A Bot's printed output
  is masked before it is saved or sent to the model, but a command that already sent the value out
  has already leaked it.
- **Undo.** Lock the vault, turn the plugin off, delete the mapping, remove the Bot from the
  scope, and revoke the vault session. What cannot be undone: a value a command already read and
  forwarded, a process that still holds it, and the vault's own audit of the read.

## Deliveries

0. **Docs only.** This RFC and its index row. *Lane:* none. *Check:* the index row matches the
   file, every commit is `docs(rfcs):`, and `Refs #1271` is in the commit body. *Rollback:*
   revert the docs.
1. **Hardening, independent of the plugin** (plugin, 3.N.P, `bots-dsh`). Add the manager CLI
   commands above to Auto's secret reads, and remove every adapter's unlock variable from Bot
   shells and MCP environments. *Check:* a test proves `BW_SESSION` is absent from a Bot shell,
   and Auto asks on `bw get`. *Rollback:* revert; nothing is stored.
2. **Source seam in `bots-dsh`** (plugin, 3.N.P). An async, scoped resolve; `vault-sources.json`;
   the one-execution shell path; masking before use; the audit; a "from a vault" row on the
   existing Secrets page. It does nothing without the plugin. *Check:* with no plugin, the
   existing Secrets tests and behavior are unchanged; with a fake adapter, only the naming
   command resolves, and a locked or absent source refuses. *Rollback:* turn the setting off;
   mappings remain and no value is stored.
3. **`apps/vault-dsh`, Bitwarden `bw`, read-only by reference** (plugin, then desktop for the
   first release). Unlock in Settings, the idle lock, the item picker, and the approval card.
   Vaultwarden's `bw config server` flow gets its own fake-`bw` case. This is the desktop release
   from the plugin lists, plus its market listing. *Check:* the acceptance list in #1271, with a
   fake `bw` on `PATH` and temp homes: the value and session key are absent from every file and
   log, and the reference is absent from `secrets.json`, the profile, sessions, diagnostics and
   the audit (it appears only in `vault-sources.json`); another Bot, a group, a denied card and a
   locked vault each refuse with an audit row; `BW_SESSION` is absent; `bw lock` runs after the
   idle lock; turning the plugin off makes the name unavailable. *Rollback:* turn off or remove
   the plugin; mappings remain and no value is converted.
4. **1Password, then Secrets Manager** (plugin, 3.N.P). Service accounts first, then the desktop
   app integration; `bws` machine accounts second. *Check:* fake `op` and `bws`, least-privilege
   reads, refusal when the account cannot see the item. *Rollback:* remove that adapter; other
   sources keep working.
5. **Async consumers** (plugin, 3.N.P). MCP capabilities, the GitHub connector, Remote Hermes and
   persistent shells, with the grant bound to the destination and its config revision. *Check:* a
   changed destination or config revision refuses; the sync shell path is unchanged. *Rollback:*
   revert; the shell path still works.
6. **Other managers** (plugin, 3.N.P). Proton Pass, HashiCorp Vault, OS keychains, and KeePassXC
   through its Secret Service integration. *Check:* a fake CLI per manager, and the same refusal
   and audit cases. *Rollback:* remove that adapter.

Vault writes are not a delivery. They need an owner rule and a later RFC.

## Open questions

1. **Transport for the first cut.** Wrap the installed `bw` CLI, or speak the Vault Management
   API? **Recommend the CLI**, because it reaches Bitwarden cloud, self-hosted and Vaultwarden
   through the person's existing login, and the API is not a stable personal-vault contract. Add
   `bws` as the least-privilege route in delivery 4.
2. **First use: shell or MCP?** **Recommend the shell command first**, because most Bot work runs
   there and the grant can name the exact command. The MCP destination route is safer but needs
   the mount rework in delivery 5.
3. **Default approval: once, session or standing?** **Recommend allow once**. A standing grant
   should be a separate, explicit choice, and a session grant should expire with the Session.
4. **Idle lock time.** **Recommend 5–15 minutes by default**, person-set, with an 8-hour maximum.
   A longer lock weakens revocation; a much shorter one makes a Bot fail often.
5. **Where the mapping lives.** **Recommend the separate 0600 `vault-sources.json`**, not a
   `source` field in `secrets.json`. It satisfies #1271's rule that the reference never appears in
   `secrets.json`, and an older `bots-dsh` cannot drop it into a value store.
6. **A machine without the vault, and an offline vault.** **Recommend unavailable with a reason**,
   never a typed fallback and never a queued read. The person can install the plugin or map a
   typed secret explicitly.
7. **Typed secrets and every shell.** Should typed secrets also reach only the command that names
   them? **Recommend yes, later and behind a per-team switch first**, because it changes existing
   teams' behavior and needs its own rollback.
8. **Vault writes.** **Recommend never in this RFC.** Writes need an owner rule, their own audit
   and a separate RFC.
9. **#384, the machine's `gh` login.** **Recommend keeping it separate.** It is ambient
   credentials with no item and no vault approval; the same seam can serve it later.
10. **Cloud and remote routes.** **Recommend `bws` service accounts only in Cloud**, and approve
    but never unlock from Pocket or remote. A person's personal vault never opens in Cloud.

## Links

- #1271: the request, current state and acceptance list. The issue calls this RFC 0033; 0033 is
  now [Attachments from Pocket](0033-attachments-from-pocket.md).
- #384: reuse the machine's `gh` login, kept separate by question 9.
- [RFC 0010](0010-desktop-sandbox.md): the sandbox and the deferred secrets broker, which this
  RFC does not replace.
- [RFC 0011](0011-monorepo-parts-and-releases.md): parts, lanes and the plugin patch.
- [RFC 0016](0016-windows-wslc.md): the WSL route.
- [RFC 0031](0031-auto-permission-level.md): Auto's secret reads, extended in delivery 1.
- [Bot team secrets](../../apps/bots-dsh/README.md#secrets): today's cards, masking and limits.
