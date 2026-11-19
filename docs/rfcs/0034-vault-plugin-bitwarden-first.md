# RFC 0034: Vault plugin, Bitwarden first

| Field | Value |
|---|---|
| Status | Queued |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P), desktop (3.N) |
| Created | 2026-11-19 |
| Amended | 2026-11-19: the review's blocking findings — the 300-second freshness rule, the command-bound approval, the dual-name refusal — and its other gaps, as rules with numbers |

## Summary

Propose an optional Vault plugin, `@automagik/vault-dsh`, that makes a password manager a
**source** for a Bot's secret instead of another place the value is copied to. A Bot still asks
`request_secret` by name and uses `$DSH_SECRET_<NAME>`; the value is read from the vault when an
approved command needs it and is not saved by Automagik. Bitwarden's `bw` is first, read-only,
and the Bot team keeps every authorization decision. The owner has not read this proposal; the
numbered questions below decide it. The issue calls it RFC 0033, but 0033 is
[Attachments from Pocket](0033-attachments-from-pocket.md), so this is 0034.

The contract is stated as rules with numbers, not as intentions: a read needs a successful
`bw sync` and a 300-second bound on `lastSync`; an approval names one exact command and covers
one execution for 10 minutes; and a name that two stores define is unavailable from both.

## Motivation

The person who runs a team already keeps its credentials in a password manager. When a Bot needs
one, today the person types the value into the Bot's card. That makes a second copy in
`<team home>/secrets.json` (mode 0600) and in the Bot team's process
(`apps/bots-dsh/src/host/secrets.js:609`, `:729`). The Bot asks with `request_secret` and sees only
the variable name; `list_secrets` lists names and scopes, never values (`:1048`, `:1109`). Masking
replaces the value and its JSON-escaped and URL-encoded forms on tool results and model requests
(`:1139`, `:1153`, `:124-136`); it does not cover base64, hex, split or reversed forms, and a
command that sends the value out has already done so before its result is masked (`:1139`).

What today's handling does not do:

- **Revocation and lock.** Deleting or rotating the item does nothing to the copy in a file or a
  running shell; Automagik cannot tell the vault changed, and no vault lock stands behind a saved
  value.
- **Item-level access.** Scope is every Bot, a list of them, or one Session for a mounted
  capability (`secrets.js:40-43`), not one item and one field. Every secret a Bot may use goes
  into every shell call it makes, not only the command that names it (`secrets.js:1166`).
- **One source of truth.** The person maintains the vault and the card separately, so the vault's
  2FA, audit and lock do not apply to the copy.
- **Least privilege for non-shell consumers.** MCP capabilities, the GitHub connector and Remote
  Hermes read through a synchronous, unscoped `rt.secretValue` (`secrets.js:1230`); they cannot
  ask for one item for one destination.
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
| Bitwarden transport | (a) Wrap the installed `bw` CLI: login, unlock, 2FA, SSO and Vaultwarden through `bw config server` already work; it parses CLI output, trusts third-party code, needs the vault's whole session key in the child's environment for the read (the exposure below), and a Bot with a shell could run the same CLI. (b) Speak the Vault Management API: no local CLI, but its public contract is organizational, not a personal vault, and it needs more credential and crypto handling. (c) Use Bitwarden Secrets Manager (`bws`): machine accounts and least privilege, but a separate paid product for organizations. | **(a) first**; (c) next; (b) only if a stable personal-vault API appears |
| A local `bw serve` | (a) `bw serve`: a loopback HTTP API avoids parsing CLI text, but it is a listener that stays up holding a session-key server and must be supervised. (b) The installed `bw` CLI: no listener, one short-lived child per read, at the cost of parsing its text. | **(b)**; `bw serve` loses on the no-listener rule below and buys nothing for freshness |
| Where values live at rest | (a) Nowhere outside the vault: no value cache, and the session key exists only in the plugin's memory. (b) An in-memory value cache with a TTL: fewer reads, wider exposure. (c) The OS keychain for the session key: survives a restart, but turns "unlock" into "already open" and adds a platform store. | **(a)**; no value cache; no keychain in the first cut |
| Locked vault | (a) Refuse, name the lock, and let the person unlock in Settings, then retry. (b) Ask for the master password in the Bot's chat: the Bot and the chat see it. (c) Use a cached value. | **(a)**; never (b) or (c) |
| Offline vault | (a) Refuse unless the last successful `bw sync` is within 300 seconds, with the exact sentence below: the local cache is never the authority. (b) Read `bw`'s local encrypted cache whenever it is unlocked: it works offline, and it also serves a deleted or rotated item forever. | **(a)**; there is no default-off cache option in the first cut |
| A name in both stores | (a) The typed value wins: the vault's revocation silently stops applying. (b) The vault mapping wins: a hand-edit or a stale mapping can shadow a typed secret. (c) Refuse the name in both directions and serve neither value. | **(c)** |
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
exactly as now. Both stores are keyed by name — `secrets.json` is a `Map` (`secrets.js:615`,
`:698`) and `vault-sources.json` is an object — so the plugin adds a second keyed store, never a
source order.

The plugin never reads `<team home>/secrets.json`, writes a value, or puts a session key in
`ctx.credentials`: that is the profile's model-key store, a file in the profile, where a session
key must not be.

### How a value reaches a Bot (just in time)

1. The Bot's identity comes from the execution (Session, Bot, chat, turn), never its arguments.
2. The name already maps to a source, mapped by the person; a Bot cannot create a mapping or name
   a provider, item or field.
3. `bots-dsh` checks the grant: this secret, this Bot, this Session, the exact command's digest,
   one use. A vault-backed name has no standing use grant, so the check is always "ask first".
4. The person approves in the Bot's own chat. The card names the Bot, secret, purpose, provider,
   item, field and exact command. The only grant in the first cut is **allow once for that
   command, in that Session, one execution**, expiring 10 minutes after the approval (Q3, Q11).
5. Only then does the adapter read that one field, in this order: `bw status` reports `unlocked`;
   `bw sync` runs (10-second timeout); `lastSync` is within 300 seconds; `bw get` reads the one
   field. It reads no other field or item.
6. The value enters masking before the command is prepared and goes only into that execution's
   environment. The shell resolver is synchronous today, so the read finishes first; there is no
   process-wide environment and no value in the next call. The command that receives the value
   must equal the approved command (the digest check below); a different command gets no value.
7. The command runs; tool results and the next model request are masked as today.
8. `bots-dsh` writes one audit row and drops the value from masking when the turn ends, at most
   15 minutes after the read. The plugin keeps no value cache; a second use asks again.

### The approval and what it binds

The card is the boundary, so the thing it approves has to exist before the card is shown. That is
the one surface change in this RFC, and it is additive (Q11): **`request_secret` gains one
optional `command` string**. A vault-backed name requires it; a typed name ignores it. No new
tool, no rename, no other argument changed.

- **What the plugin passes.** The exact text of the command the Bot intends to run, as the Bot
  will run it: one string, at most 4,000 characters, newlines preserved. `bots-dsh` stores it on
  the request row with a digest — `kind: 'allow'`, `command`, `commandDigest` (SHA-256 of the
  UTF-8 text) — and shows it on the card verbatim, in a code block, not escaped or summarised. A
  request for a vault-backed name without `command` is refused with `Name the exact command you
  will run: <name> comes from a vault and is approved per command.` and shows no card.
- **What the person approves.** This Bot, this secret name, this exact command text, in this chat,
  once. Not a scope, not a family of commands, not a shell session. The card renders provider,
  item and field from `vault-sources.json`; the request row never carries them.
- **What the grant binds.** `{name, botId, sessionId, commandDigest, issuedAt}`, in `bots-dsh`
  memory and in the audit (never the command text), valid 10 minutes and one execution. The shell
  path already receives the command (`resolveEnv` reads `execution.arguments.command`,
  `secrets.js:1166-1170`); for a vault-backed name it hashes that exact text and compares. Equal:
  the adapter reads and the value enters that environment; the grant is consumed. Not equal, or
  absent: no value, the grant is canceled and consumed, and the Bot is told `The approved command
  was different; ask again.` One approval therefore buys one attempt, matching or not.
- **What it does not bind.** What the command does after it starts. The command can read the value
  and send it anywhere; masking is a safety net, not a boundary. The person reads the command on
  the card; that is the decision.
- **Wait and retry.** Showing a card ends the Bot's turn, as today (`secrets.js:1101`). A note
  arrives when the person answers: allowed, denied, or a locked vault. On an allow, the Bot runs
  the same command in a new turn, inside the 10-minute grant. A different command, a denied card
  or an expired grant needs a new `request_secret`; the card is never reused.

### The surface a Bot sees

`request_secret` and `list_secrets` keep their names and stay owned by `bots-dsh`; `request_secret`
changes only as described above. The Vault plugin registers **no Bot tool**: no `vault_*`, no
`bw_*`, no `op_*`. A Bot reaches a vault-backed secret only through a name the person already
mapped.

- `request_secret` on a vault-backed name always shows an **allow** card — never a fill card, and
  never the "already saved" shortcut — even when the mapping lists the Bot. The mapping's `scope`
  decides who may ask; it is not a use grant. A Bot outside it is refused before any card.
- For a typed name nothing changes: its allow card still adds that Bot to the secret's scope
  (`secret-allow`), the value still reaches every shell call it makes, and no command is bound.
- If the vault is locked, the card says so and offers the person the unlock in Settings; if the
  last sync is already beyond the 300-second bound, the card warns that the next use will refuse.
  The Bot gets a note and no value, and no grant is issued.
- `list_secrets` shows the name, purpose, scope, and one availability word: available, locked or
  unavailable (a stale connection and a name defined twice both read unavailable). It never shows
  the provider, item, field, reference or value.
- The Bot may read exactly the one value, in the one approved execution. It cannot list, search,
  export, read another field, write, unlock, change scope, or supply a vault reference.
- The first cut reaches the shell only, through `$DSH_SECRET_<NAME>`. MCP capabilities, the
  GitHub connector, Remote Hermes and persistent shells come later, bound to a destination and a
  config revision, as delivery 5.
- Cards appear only in the Bot's own chat; a group chat cannot approve, as today.

### Freshness, offline and revocation

`bw get` does not ask the server: it reads the unlocked local vault, which is only as new as the
last `bw sync`, and `bw status` reports that instant as `lastSync` (ISO-8601). "Refuse offline" is
therefore a rule about that instant, not about the network. The rule, in numbers:

- **Sync before every read.** With the vault unlocked, after the person's approval, the plugin
  runs `bw sync` with a 10-second timeout and then `bw status` (5-second timeout). A read is
  never served from a cache the plugin kept; it keeps none.
- **Freshness bound: 300 seconds.** A read may hand over the value only when
  `now - lastSync ≤ 300 s`, using the instant `bw status` reports after the sync attempt. A
  successful sync makes it 0 seconds old, so the normal path is a fresh read.
- **A failed sync inside the bound is tolerated; outside it, it refuses.** If `bw sync` fails
  (offline, server unreachable, a 5xx), the read proceeds only when the last successful sync is
  within 300 seconds, and the audit row records `result: stale`. If `lastSync` is older than that,
  absent or unreadable, the read refuses before any `bw get`, with exactly:
  > The vault was last synced <n> minutes ago, over the 5-minute limit. Nothing was read.
  > Connect this computer to the vault and try again; the next use syncs again.
  The Bot gets that sentence and no value; the grant is canceled and consumed, and the card is
  marked "refused: vault stale".
- **What "offline" means.** Offline is not a separate mode: it is exactly `bw sync` failing with
  `lastSync` beyond 300 seconds. The bound is not settable in the first cut, and option (b) in the
  table above (always read the local cache) is not shipped. Q6 confirms the bound.
- **A locked vault is checked first.** `bw status` reports `locked` or `unauthenticated`; the read
  then refuses as locked (`The vault is locked. Unlock it in Settings › Vault and ask again;
  nothing was read.`) and never syncs with a stale session key.

**Revocation.** The freshness bound is what makes a revocation visible; it is not a retraction.
What each revocation means:

| Revoked in the vault | Next use, with the bound held | What it cannot do |
|---|---|---|
| Item deleted | The sync succeeds and the read finds no item: refuse with `Vault item <item> is gone; nothing was read.`, audit `result: revoked`. The mapping stays and the Secrets page marks the row "item not found". | Delete a value a command already read. |
| Field renamed or removed | Refuse with `Vault item <item> has no field <field>; nothing was read.` | Same. |
| Value rotated | The new value is served, and only it; there is no plugin cache holding the old one. | Change a Bot's context, a file the Bot wrote, or a process started before the rotation. |
| Session revoked or the account disabled | `bw status` no longer reports `unlocked`; the read refuses as locked or unauthenticated, the plugin drops its session key and runs `bw lock`. | Revoke a value already delivered. |
| Mapping deleted, or the Bot removed from its scope | The name no longer resolves for that Bot, and no card can grant it. | Same. |
| Plugin turned off or uninstalled | Every vault-backed name is unavailable; there is no typed fallback (`secrets.js:1230` reads only `secrets.json`). | Same. |

A Bot that already holds a value — in its context, in a file it wrote, in a process it started —
keeps it: the plugin's boundary is the read, not the Bot's later copies. The person's remedy is to
rotate the credential in the vault, revoke the vault session, delete the mapping and, if the Bot
wrote it to disk, delete the file. The lock timer and the 300-second bound narrow the window; they
do not close it.

**Masking life.** A value read from the vault joins the redactor before the approved command
starts and leaves it when the turn ends or 15 minutes after the read, whichever comes first.
Until then it is masked exactly like a typed secret, with the same floor and the same limits
(base64, hex, split and reversed forms are not covered). A later, unrelated output that quotes it
is not masked; that is why a value is not kept in the redactor for the life of the process.

### One name, one source

A name is exclusive across the two stores. `secrets.json` cannot hold two entries for one name —
it is a `Map` keyed by name (`secrets.js:615`, `:698`) — and `vault-sources.json` cannot either —
it is an object keyed by name. The only possible duplicate is the same name in both files. The
rule:

- **No precedence, in either direction.** Not last-one-wins, not file order, not "the typed value
  is the fallback", not "the vault wins". A dual name is unavailable to every consumer, and the
  two values are not compared — comparing them would mean reading the vault for a name whose
  authority is exactly what is in doubt.
- **At write, the second definition is refused.** `secret-source-set` for a name `secrets.json`
  holds (any scope, a Session included) refuses with `The name <name> is already a typed secret.
  Delete it in Settings › Secrets first, or map the vault item under another name.` and writes
  nothing. `secret-set` for a name `vault-sources.json` maps refuses with `The name <name> is
  mapped to a vault item. A typed value cannot share it; delete the mapping first or use another
  name.` and writes nothing. The same check runs on a mapping edit and when a mapping file is
  restored.
- **At read, a dual name is dead.** If both files hold the name (a hand-edit, a downgrade, a
  restored backup), `resolveEnv` (`secrets.js:1166-1181`) hands out neither value for it,
  `rt.secretValue` (`:1230`) and the Session path (`canUseInSession`, `:42-43`) return nothing, and
  `list_secrets` shows `unavailable: this name is defined both in secrets.json and in
  vault-sources.json`. No vault read is attempted for it.
- **What the person sees.** The Secrets page row is marked `defined twice`, names both sources and
  offers to delete one of them; the Bot sees unavailable, and a `request_secret` for it is refused
  rather than carded.
- **Older host.** An older `bots-dsh` ignores `vault-sources.json`; if a collision already exists,
  that host serves the typed value as today. The exclusion is the newer host's rule: it refuses a
  dual name when it loads the files, before it serves anything.
- **Implementable with today's shape.** Both stores are keyed by name and read by one process, so
  the check is a set intersection at load and at each write; neither file's version or fields
  change. Today there is no source order to preserve — `resolveEnv` iterates the single `secrets`
  map and `rt.secretValue` reads the same map — so the rule adds a refusal, not a reordering.
  Delivery 2 carries it.

### Lock, cache and quit

The value cache is zero by default. The vault locks after an idle time the person sets, default
5–15 minutes and at most 8 hours, and when the app quits or the plugin is turned off. On lock the
plugin drops the session key and runs `bw lock`. The next use says the vault is locked; only the
person unlocks. Unlock credentials are typed into the host's Settings, never into a Bot's chat,
and never travel over a plain-HTTP page off loopback.

**The session key's exposure.** `bw` takes the session key through `BW_SESSION` or `--session`.
The plugin passes it only as `BW_SESSION` in the environment of the one short-lived `bw` child
that performs a read — never in argv, never in a temp file, never in DSH's own environment, never
in the profile or `ctx.credentials`, never in a Bot shell's declared variables. A same-user
process can read that child's environment (`/proc/<pid>/environ`, `ps eww`) or its memory while it
runs, and a Bot's shell is such a process. The boundary is that no file, log, session, diagnostics
or audit ever holds the key — not that no same-user process can read it while a read runs.

### Boundaries

- **Never logged, never in the profile, a session, diagnostics or the audit:** the value, the
  session key or API token, the master password, the item reference and path, the field, the
  connection label, and raw manager output. An error is reduced to a code before it is shown or
  logged. The audit holds a command digest, never the command text.
- **The person must approve:** the mapping (name to provider, item and field, with whose Bots may
  ask), the unlock, each use (allow once, for the named command), turning the plugin on, and a new
  connection. A Bot can never approve any of these.
- **No listener:** the plugin never runs `bw serve` or any HTTP server, opens no port, and calls
  only the manager's own CLI or API.
- **No typed fallback:** turning the plugin off, uninstalling it, losing the vault, going offline
  or a name defined twice makes vault-backed names unavailable. The plugin never converts one into
  a stored value; the person must map a typed secret explicitly if they want one.
- **One connection in the first cut.** `vault-sources.json` carries a connection label, but the
  first cut accepts exactly one connection; a second is refused with `The first cut supports one
  Bitwarden connection.` A second account or server needs its own `bw` data directory and session,
  which is a later delivery (Q12).
- **One release lane per delivery**, per [RFC 0011](0011-monorepo-parts-and-releases.md). Delivery
  3 is the desktop release (3.N) and says why.

### Routes

- **macOS, Windows native and Linux:** the person installs `bw`; the plugin runs where DSH runs,
  so the CLI must be on that same computer. A Windows-native DSH cannot see a CLI installed only
  in a WSL guest, and the reverse.
- **WSL (RFC 0016):** DSH and `bw` live in the guest; the Windows-side `bw` is not used.
- **Sandboxed Bots (RFC 0010):** the read happens on the host, outside the Bot's sandbox, and only
  the value enters the approved command.
- **Pocket and remote:** the person may approve; they never unlock from the phone. Unlocking is a
  host-side Settings action.
- **Cloud:** service accounts only (`bws`), never a person's master password or personal vault.
  The `bws` access token has no store in the first cut (no keychain); it must live in the Cloud
  profile's secure storage with its own rotation and revocation, so Cloud waits for that. This is
  question 10.
- **ACP routes:** the Bot's DSH shell path is unchanged; a value reaches only that execution, not
  an agent's own built-in shell.
- A route that cannot be supported in a delivery is named in that delivery and approved by the
  owner; it is never left out silently.

## Contracts introduced

- `@automagik/vault-dsh` (`apps/vault-dsh`), an optional market plugin. It adds no package
  dependency and bundles no manager CLI. The person installs `bw`; the plugin names a minimum
  version and never updates it.
- Service `secretSources`, version 1: status, unlock, lock, a read of one field, and a person-only
  item list for the picker. `status` resolves to `{state: 'unlocked'|'locked'|'unauthenticated',
  lastSync?: number}`; a read is `status → sync (10 s) → 300-second bound → one field`. Unlock
  input comes from the host's Settings, never from a model message. A Bot-facing list or read-all
  is not part of the service.
- `<team home>/vault-sources.json`, mode 0600, version 1, keyed by name with one row per name:
  name, provider, connection label, item, field, scope, purpose, requester and timestamps. No
  value, ever. `scope` says which Bots may **ask**; it is not a use grant. The connection is a
  label; `bw config server` owns the server address, so Automagik stores no host. One connection
  label only in the first cut.
- `secrets.json` is unchanged (version 1: each entry's name, value, purpose, scope, Session,
  requester and timestamps; `secrets.js:613`, `:698-708`). No reference is added. A name here is
  exclusive with `vault-sources.json`; neither store's value is served for a dual name. An older
  `bots-dsh` ignores `vault-sources.json`: its vault names are then unavailable and no value
  appears. Restoring the newer plugin restores the mappings, and nothing is converted.
- A Session-scoped secret (`secrets.js:38-43`) stays outside the first cut: it is never a Bot's
  and reaches no shell (`:1191`), and a vault mapping is refused for a name `secrets.json` holds
  scoped to a Session.
- **`request_secret`, changed additively:** it gains the optional `command` argument above,
  required for a vault-backed name and ignored for a typed one. One optional string; no new tool,
  no rename, no other argument, note or return value changed. The owner is asked to approve this
  Bot-facing change in Q11; delivery 2 carries it.
- The secret-request row gains `command` and `commandDigest`, and never gains the provider, item,
  field or connection. The command text is the Bot's own tool-call argument, already in the
  session transcript, so storing it adds no disclosure; the card renders provider, item and field
  from `vault-sources.json` when it is shown.
- The existing `POST /api/omni-ui` route (the browser session cookie) gains `secret-source-set`,
  `secret-source-clear`, `vault-unlock`, `vault-lock` and `vault-status`; they are refused when
  `secretSources` is absent. Older clients ignore them; the source row appears only when the
  service is present.
- Unchanged: `DSH_SECRET_<NAME>`, `list_secrets`, scope and cards. Newly removed from every Bot
  shell and MCP environment: `BW_SESSION`, `BWS_ACCESS_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`,
  `VAULT_TOKEN` and every adapter's unlock variable.
- `<team home>/vault-audit.jsonl`, mode 0600, bounded and rotated: time, secret name, Bot id,
  consumer kind, command digest, decision, result. `result` is one of `ok`, `stale`,
  `stale-refused`, `revoked`, `locked`, `refused`. No value, reference, field, connection, raw
  command or command text.
- **Masking floor.** A vault field shorter than 4 characters is never used, exactly as a typed
  value below `MIN_VALUE` is held (`secrets.js:22`, `:53`), with `The vault value for <name> is
  shorter than 4 characters, so it cannot be masked; nothing was read.` A 4–7 character value is
  masked only where it stands alone (`WHOLE_VALUE`, `:23`), as today.
- **Windows.** On Windows the 0600 mode has no effect on `vault-sources.json` or
  `vault-audit.jsonl`; both are protected by the user's profile folder, as `secrets.json` is
  (`apps/bots-dsh/README.md`, Limits).
- No new release lane. A vault change after the first release is a plugin patch (3.N.P). The first
  release adds `apps/vault-dsh` to the plugin lists (`scripts/lane.ts`, `scripts/version.ts`, the
  release and CI plugin loops, `apps/desktop/src/lane.js`) and to `marketplace/automagik.json`.
  That first release is a desktop release (3.N): its changed paths include the market index and
  the desktop lane list, which `scripts/lane.ts`'s `kindOf` does not treat as plugin paths (a
  plugin patch changes only `apps/<plugin>/`). It is market-only by default, not in the desktop
  profile's preinstalled bundles.

## Threat model

The trust boundary is the DSH host process, not the Bot. The person unlocks; the plugin holds the
session key; `bots-dsh` authorizes; the Bot gets one value in one approved execution. Settings
endpoints are on the authenticated browser route, the approval comes from the owner's chat, a
grant is bound to one command and one execution, and there is no network listener.

- **Prompt injection or a compromised Bot.** A request gives no authority. The approval is the
  boundary: it names the exact command, and covers one execution; a different command resolves to
  no value and consumes the grant. If the person approves a command that sends the value out, the
  Bot can leak it; masking is a safety net, not a boundary. A Bot that base64-encodes,
  hex-encodes, splits or reverses a value can still leak it: the redactor builds only the value,
  its JSON-escaped forms and its URL-encoded forms (`secrets.js:124-136`).
  Only OS isolation or the sandbox ([RFC 0010](0010-desktop-sandbox.md)) stops same-user
  processes.
- **A Bot running the manager CLI itself.** Unlock variables are removed from every Bot shell and
  MCP environment, and Auto treats `bw get`, `bws secret get`, `pass-cli item view|run`,
  `keepassxc-cli show`, `secret-tool lookup` and `op run|inject` as secret reads, as it already
  treats `op read` and `vault kv get` (`apps/bots-dsh/src/host/auto-judge.js:68`). A CLI with no
  session is locked; the plugin never accepts a master password from a model.
- **A shared machine, and the session key.** Another OS user cannot read a 0600 file or another
  user's process memory, but a same-user process can read both — including the `bw` child's
  `BW_SESSION` while a read runs. The lock timer narrows the window, and a separate OS account or
  the sandbox is the real boundary. The mapping file names items, sensitive even without values.
- **A stolen machine or session key.** The session key is memory-only and dies with the process
  or the lock. A stolen key can read what that vault account can until the session is revoked;
  scoped accounts and the lock limit it. Revoke the vault session, rotate the credential, and
  delete the mapping. A value already read and approved cannot be taken back.
- **Stale reads and revocation.** `bw get` serves the local vault, so the 300-second bound is the
  only thing that makes a deleted, rotated or revoked item visible; without it the CLI would
  serve the last sync forever. The bound refuses rather than serving, and a revoked item refuses
  and audits `revoked`. A value a Bot already holds is not retractable: rotate the credential.
- **A name in two stores.** A dual name is refused from both stores, so a hand-edited typed secret
  cannot shadow a vault mapping and a mapping cannot silently replace a typed secret. There is no
  precedence rule to exploit and no value comparison to probe.
- **Masking floors.** A vault value below 4 characters is refused before use, so it cannot be
  injected unmaskable; the typed store's floor and held behaviour are unchanged.
- **A compromised plugin or `bw`.** Either can read what the session key can and exfiltrate it.
  The plugin cannot grant access; it is optional, reviewed, on the signed plugin lane and pinned
  in the market. `bw` is third-party code the person installs; a malicious update is a
  supply-chain risk. The first cut trusts both as much as the DSH host.
- **Logs and errors.** The manager is asked for one field where its CLI offers one (`bw get
  password`, `bw get username`) and for the item where it does not, with the plugin selecting the
  mapped field and no other field leaving the plugin; its output is reduced to a code, and the
  audit holds no value or reference. A Bot's printed output is masked before it is saved or sent
  to the model, but a command that already sent the value out has already leaked it.
- **Undo.** Lock the vault, turn the plugin off, delete the mapping, remove the Bot from the
  scope, and revoke the vault session. What cannot be undone: a value a command already read and
  forwarded, a process that still holds it, a Bot's own copy, and the vault's own audit of the
  read.

## Deliveries

Each delivery is on one release lane, per [RFC 0011](0011-monorepo-parts-and-releases.md).

0. **Docs only.** This RFC and its index row. *Lane:* none. *Check:* the index row matches the
   file, every commit is `docs(rfcs):`, and `Refs #1271` is in the commit body. *Rollback:*
   revert the docs.
1. **Hardening, independent of the plugin** (plugin, 3.N.P, `bots-dsh`). Add the manager CLI
   commands above to Auto's secret reads, and remove every adapter's unlock variable from Bot
   shells and MCP environments. *Check:* a test proves `BW_SESSION` is absent from a Bot shell and
   from the `bw` child's argv, and Auto asks on `bw get`. *Rollback:* revert; nothing is stored.
2. **Source seam in `bots-dsh`** (plugin, 3.N.P). An async, scoped resolve; `vault-sources.json`;
   the command-bound grant and the additive `request_secret.command` (Q11); the dual-name
   exclusion; the 4-character floor; the one-execution shell path; masking before use; the audit;
   a "from a vault" row on the existing Secrets page. It does nothing without the plugin.
   *Check:* with no plugin, the existing Secrets tests and behavior are unchanged; with a fake
   adapter, only the naming command resolves; a different command gets no value and cancels the
   grant; the same name in both stores is unavailable from both, and each write refuses it; a
   3-character vault value refuses; a locked or absent source refuses. *Rollback:* turn the
   setting off; mappings remain and no value is stored.
3. **`apps/vault-dsh`, Bitwarden `bw`, read-only by reference** (desktop, 3.N — one lane). Unlock
   in Settings, the idle lock, the item picker, the approval card, and the freshness rule
   (`bw status` → `bw sync` 10 s → 300-second bound → one read). Vaultwarden's `bw config server`
   flow gets its own fake-`bw` case. This is the desktop release from the plugin lists, plus its
   market listing. *Check:* the acceptance list in #1271, with a fake `bw` on `PATH`, a fake
   clock and temp homes: the value and the session key are absent from every file and log; the
   reference, item and field are absent from `secrets.json`, the profile, sessions, diagnostics
   and the audit (they appear only in `vault-sources.json`); `BW_SESSION` reaches only the `bw`
   child's environment, never its argv; `lastSync` over 300 seconds refuses with the sentence and
   reads nothing; a failed sync inside the bound serves and audits `stale`; a deleted item
   refuses and audits `revoked`; a rotated value serves the new one; another Bot, a group, a
   denied card and a locked vault each refuse with an audit row; `bw lock` runs after the idle
   lock; turning the plugin off makes the name unavailable. *Rollback:* turn off or remove the
   plugin; mappings remain and no value is converted.
4. **1Password, then Secrets Manager** (plugin, 3.N.P). Service accounts first, then the desktop
   app integration; `bws` machine accounts second. A `bws` access token is kept in the OS keychain
   where the platform has one, and the adapter is unshipped where it does not. *Check:* fake `op`
   and `bws`, least-privilege reads, refusal when the account cannot see the item, and the token
   absent from every file and log. *Rollback:* remove that adapter; other sources keep working.
5. **Async consumers** (plugin, 3.N.P). MCP capabilities, the GitHub connector, Remote Hermes and
   persistent shells, with the grant bound to the destination and its config revision. It reuses
   the existing Session scope (`canUseInSession`, `secrets.js:42-43`) as the nearest seam: a
   destination's Session receives a source-scoped secret only through it, with the destination
   and its revision bound on top. *Check:* a changed destination or config revision refuses; the
   sync shell path is unchanged. *Rollback:* revert; the shell path still works.
6. **Other managers** (plugin, 3.N.P). Proton Pass, HashiCorp Vault, OS keychains, and KeePassXC
   through its Secret Service integration. *Check:* a fake CLI per manager, and the same refusal
   and audit cases. *Rollback:* remove that adapter.

Vault writes are not a delivery. They need an owner rule and a later RFC.

## Open questions

1. **Transport for the first cut.** Wrap the installed `bw` CLI, or speak the Vault Management
   API? **Recommend the CLI**, because it reaches Bitwarden cloud, self-hosted and Vaultwarden
   through the person's existing login, and the API is not a stable personal-vault contract. Add
   `bws` as the least-privilege route in delivery 4. `bw serve` is rejected for the listener.
2. **First use: shell or MCP?** **Recommend the shell command first**, because most Bot work runs
   there and the grant can name the exact command. The MCP destination route is safer but needs
   the mount rework in delivery 5. If the owner answers against Q11, this answer changes with
   it: without a command on the approval, the shell first cut has nothing to bind.
3. **Default approval: once, session or standing?** The first cut ships **allow once only**, for
   the named command, 10 minutes, one execution. Should a timed or standing grant be added later?
   **Recommend not before it has a contract**: a standing grant needs a record (bot, name, command
   digest or destination, issuedAt, ttl ≤ 24 h), a revoke in Settings, an audit row on issue, use
   and revoke, and a delivery of its own. Until then, allow once is the only grant.
4. **Idle lock time.** **Recommend 5–15 minutes by default**, person-set, with an 8-hour maximum.
   A longer lock weakens revocation; a much shorter one makes a Bot fail often.
5. **Where the mapping lives.** **Recommend the separate 0600 `vault-sources.json`**, not a
   `source` field in `secrets.json`. It satisfies #1271's rule that the reference never appears in
   `secrets.json`, and an older `bots-dsh` cannot drop it into a value store.
6. **A machine without the vault, and an offline vault.** **Recommend unavailable with a reason**,
   never a typed fallback and never a queued read; an offline vault refuses when the last
   successful `bw sync` is over 300 seconds old, as the freshness rule says. Confirm the
   300-second bound.
7. **Typed secrets and every shell.** Should typed secrets also reach only the command that names
   them? **Recommend yes, later and behind a per-team switch first**, because it changes existing
   teams' behavior and needs its own rollback.
8. **Vault writes.** **Recommend never in this RFC.** Writes need an owner rule, their own audit
   and a separate RFC.
9. **#384, the machine's `gh` login.** **Recommend keeping it separate.** It is ambient
   credentials with no item and no vault approval; the same seam can serve it later.
10. **Cloud and remote routes.** **Recommend `bws` service accounts only in Cloud**, and approve
    but never unlock from Pocket or remote. A person's personal vault never opens in Cloud. The
    `bws` access token has no store in the first cut; it needs the Cloud profile's secure storage
    with its own rotation and revocation, so **recommend Cloud waits** for that and stays out of
    the first cut.
11. **May `request_secret` gain an optional `command`?** **Recommend yes.** It is the only way the
    card can name a command the Bot will actually run: one optional string, required for a
    vault-backed name, ignored for a typed one, no new tool, no rename, no other argument. Without
    it the RFC would have to drop "the card names the exact command" and say the person approves
    only a name, which binds no consumer. The owner is asked because it is a Bot-facing tool
    surface; it is additive, so an older host and every typed caller keep working.
12. **More than one vault connection?** **Recommend one in the first cut.** A second account or
    server needs its own `bw` data directory and session, and the plugin's one-connection refusal
    is honest until that exists; a later delivery adds per-connection directories and a picker.
    Answering yes now moves the mapping file and delivery 3's acceptance.

Two rules are contracts, not questions, because there is no safe alternative to write: a name in
both stores is unavailable from both (no precedence, no fallback), and the session key is limited
by the same-user boundary (there is no "never seen" claim). An owner answer against either would
reopen the boundary, not tune it.

Q2 and Q5 restate what the design already fixes; an answer against them moves delivery 3's
acceptance and the Contracts above, so the owner should say so before delivery 3 is filed.

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
