# RFC 0034: Vault plugin, Bitwarden first

| Field | Value |
|---|---|
| Status | Approved |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P), desktop (3.N) |
| Created | 2026-11-19 |
| Amended | 2026-11-19: the review's blocking findings — the freshness rule, the command-bound approval, the dual-name refusal — and its other gaps, as rules with numbers. Re-amended the same day: the vault Allow path, the sync gate, Bot-safe refusals, the always-read sources file, and a grant bound to command, shell and folder. Q1-Q12 decided the same day: Q6 from #1668, the other eleven as recommended; the #1668 contract pins `bw` 2026.10.1 and tolerates only its network-failure allowlist |

> Approved by Guga's delegation while the owner is away (19/11); the owner may amend on return.

## Summary

Propose an optional Vault plugin, `@automagik/vault-dsh`, that makes a password manager a
**source** for a Bot's secret instead of another place the value is copied to. A Bot still asks
`request_secret` by name and uses `$DSH_SECRET_<NAME>`; the value is read from the vault when an
approved command needs it and is not saved by Automagik. Bitwarden's `bw` is first, read-only,
and the Bot team keeps every authorization decision. The owner's delegate approved it on
2026-11-19 and answered every numbered question below as recommended; no question is open. The
issue calls it RFC 0033, but 0033 is
[Attachments from Pocket](0033-attachments-from-pocket.md), so this is 0034.

The contract is stated as rules with numbers, not as intentions: a read's gate is a `bw sync`
that just succeeded; only a message from the pinned `bw` version's network allowlist is
tolerated as `stale`, and every other failure refuses and locks. An approval names one exact
command, shell and folder, and covers one execution for 10 minutes. A name that two stores define
is unavailable from both, and `bots-dsh` reads the mapping file even with the plugin off.

## Motivation

The person who runs a team already keeps its credentials in a password manager. When a Bot needs
one, today the person types the value into the Bot's card. That makes a second copy in
`<team home>/secrets.json` (mode 0600) and in the Bot team's process (the `Map` at
`apps/bots-dsh/src/host/secrets.js:614`, the `value` at `:700`, the snapshot write at `:729`).
The Bot asks with `request_secret` and sees only the variable name; `list_secrets` lists names
and scopes, never values (`:1048`, `:1109`). Masking
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

The decision was whether a password manager becomes a secret source, and under which boundary and
first manager. The owner's delegate chose (b) below on 2026-11-19, as recommended: an optional
plugin, Bitwarden `bw` first, read-only, with `bots-dsh` keeping authorization.

| Decision | Options and trade-offs | Recommended |
|---|---|---|
| Is a vault a source at all? | (a) No: no new trust boundary, but the copy stays. (b) An optional plugin: the boundary exists only where installed; one more plugin to install, update and audit. (c) Build it into `bots-dsh`: every team gets it, but every install carries vault code and cannot turn the boundary off cleanly. | **(b)** |
| Bitwarden transport | (a) Wrap the installed `bw` CLI: login, unlock, 2FA, SSO and Vaultwarden through `bw config server` already work; it parses CLI output, trusts third-party code, needs the vault's whole session key in the child's environment for the read (the exposure below), and a Bot with a shell could run the same CLI. (b) Speak the Vault Management API: no local CLI, but its public contract is organizational, not a personal vault, and it needs more credential and crypto handling. (c) Use Bitwarden Secrets Manager (`bws`): machine accounts and least privilege, but a separate paid product for organizations. | **(a) first**; (c) next; (b) only if a stable personal-vault API appears |
| A local `bw serve` | (a) `bw serve`: a loopback HTTP API avoids parsing CLI text, but it is a listener that stays up holding a session-key server and must be supervised. (b) The installed `bw` CLI: no listener, one short-lived child per invocation, at the cost of parsing its text. | **(b)**; `bw serve` loses on the no-listener rule below and buys nothing for freshness |
| Where values live at rest | (a) Nowhere outside the vault: no value cache, and the session key exists only in the plugin's memory. (b) An in-memory value cache with a TTL: fewer reads, wider exposure. (c) The OS keychain for the session key: survives a restart, but turns "unlock" into "already open" and adds a platform store. | **(a)**; no value cache; no keychain in the first cut |
| Locked vault | (a) Refuse, name the lock, and let the person unlock in Settings, then retry. (b) Ask for the master password in the Bot's chat: the Bot and the chat see it. (c) Use a cached value. | **(a)**; never (b) or (c) |
| Offline vault | (a) Refuse unless a `bw sync` just succeeded, or the failure is one of the recognized network failures of the pinned `bw` version; the local cache is never the authority. (b) Read `bw`'s local encrypted cache whenever it is unlocked: it works offline, and it also serves a deleted or rotated item forever. | **(a)**; there is no default-off cache option in the first cut |
| A revoked session | (a) Trust `bw status`'s `unlocked`: the local vault still decrypts, so a recognized network failure can still serve the old value. (b) Make `bw sync` the gate and treat an auth failure as decisive: refuse and `bw lock` regardless of `lastSync`. | **(b)** |
| A name in both stores | (a) The typed value wins: the vault's revocation silently stops applying. (b) The vault mapping wins: a hand-edit or an outdated mapping can shadow a typed secret. (c) Refuse the name in both directions and serve neither value. | **(c)** |
| Bot on a machine without the vault | (a) Unavailable, with a reason; the person can install the plugin or map a typed secret explicitly. (b) Fall back to a stored value: that recreates the copy. (c) Queue the read: a command must not run with a value that arrives later. | **(a)**; never (b) or (c) |

### The shape and the seam

`apps/vault-dsh` is a DSH host plugin, installed from the market and turned on in Settings ›
Plugins. "Vault" here means a password manager, not HashiCorp Vault, which is one later adapter.
It provides one service, `secretSources`, with one adapter per manager. An adapter can unlock,
lock, report status, list items for the person's picker, and read exactly one field (or the item
transiently where the CLI has no field command, with only the mapped field leaving the adapter).
It can read; it cannot grant.

`bots-dsh` injects it (`ctx.inject(['secretSources'])`, as it does `acpAgents`) and keeps
`request_secret`, `list_secrets`, scope, cards, masking and the audit. It never asks the plugin to
list or search the vault for a Bot, and never passes a Bot's argument as the item reference.
Without the plugin the service is absent: a vault-backed name is unavailable, and an unmapped
name behaves exactly as now. `bots-dsh` still reads `vault-sources.json` when the plugin is
absent, so a mapped name never falls back to a typed value (One name, one source). Both stores
are keyed by name — `secrets.json` is a `Map` (`secrets.js:614`, `:698`) and
`vault-sources.json` is an object — so the plugin adds a second keyed store, never a source
order.

The plugin never reads `<team home>/secrets.json`, writes a value, or puts a session key in
`ctx.credentials`: that is the profile's model-key store, a file in the profile, where a session
key must not be.

### How a value reaches a Bot (just in time)

1. The Bot's identity comes from the execution (Session, Bot, chat, turn), never its arguments.
2. The name already maps to a source, mapped by the person; a Bot cannot create a mapping or name
   a provider, item or field.
3. `bots-dsh` checks the grant: this secret, this Bot, this Session, the exact command's digest,
   this shell and this folder, one use. A vault-backed name has no standing use grant, so the
   check is always "ask first".
4. The person approves in the Bot's own chat. The card names the Bot, secret, purpose, provider,
   item, field, the exact command, the shell and the folder. The Allow button calls
   `secret-allow`; for a vault-backed name it takes the vault branch below, which issues the
   grant and writes the audit row. The only grant in the first cut is **allow once for that
   command, in that shell and folder, in that Session, one execution**, expiring 10 minutes
   after the approval (Q3, Q11).
5. Only then does the adapter read that one field, after the grant, in this order: `bw --version`
   (5 s) gates the pinned 2026.10.1 line; `bw status` (5 s) is a pre-check that refuses a locked
   or unauthenticated vault; `bw sync` (10 s) is the gate and must succeed; `bw get` reads the
   field. A sync that fails only with a message in the pinned version's network allowlist is
   tolerated as `stale`; every other failure refuses and runs `bw lock`. No other field leaves the
   adapter; where the CLI has no field command it reads the item transiently and selects the
   mapped field.
6. The grant check and the digest comparison run in the shell tool's `tools/execute` pre-hook,
   which can await: a match lets the adapter read and caches the value for that tool call only,
   keyed by `callId`; a mismatch cancels the grant and reads nothing. The synchronous shell
   resolver then returns only that call's cached value. The value enters masking before the
   command starts and goes only into that execution's environment. There is no process-wide
   environment and no value in the next call. The command that receives the value must equal the
   approved command, shell and folder (the digest check below); a different one gets no value.
7. The command runs; tool results and the next model request are masked as today.
8. `bots-dsh` writes one audit row and drops the value from masking when the turn ends, at most
   15 minutes after the read. The plugin keeps no value cache; a second use asks again.

### The approval and what it binds

The card is the boundary, so the thing it approves has to exist before the card is shown. That is
the one Bot-facing tool change in this RFC, and it is additive (Q11): **`request_secret` gains
two optional strings, `command` and `shell`**. A vault-backed name requires both; a typed name
ignores both. No new tool, no rename, no other argument changed. The person's existing Allow
endpoint also gains a vault branch, below; that is a host endpoint change, not a Bot-visible one.

- **What the Bot passes.** `command` is the exact text the Bot intends to run, as it will run it:
  one string, at most 4,000 characters, newlines preserved. `shell` is the tool that will run it:
  `bash` or `pwsh`. The folder is not a tool argument: it is the Session's committed working
  directory when the card is shown. `bots-dsh` stores the command, its digest, the shell and that
  folder on the request row; the card shows the command verbatim, in a code block, not escaped or
  summarised, with the shell and folder above it. A request for a vault-backed name without
  `command` or `shell` is refused with `Name the exact command and shell you will run: <name>
  comes from a vault and is approved per command.` and shows no card; a command over 4,000
  characters is refused with `The command is longer than 4,000 characters; shorten it and ask
  again.`
- **What the person approves.** This Bot, this secret name, this exact command text, this shell,
  this folder, in this chat, once. Not a scope, not a family of commands, not a shell session.
  The card renders provider, item and field from `vault-sources.json`; the request row never
  carries them. Those three are rendered on the person's client from the mapping; they are not
  stored on the request row, in the model context or in the session transcript. The command,
  shell and folder are stored on the row so the card can show them; the command is the Bot's own
  argument and the folder is the Session's.
- **What the grant binds.** `{name, botId, sessionId, commandDigest, shell, workdir, issuedAt}`,
  in `bots-dsh` memory and in the audit (never the command text), valid 10 minutes and one
  execution. `commandDigest` is `SHA-256` of the UTF-8 bytes of
  `JSON.stringify({v: 1, tool: <shell>, workdir: <resolved absolute folder>, command: <text>})`:
  one canonical string, so a newline in the command or the folder cannot be read two ways.
  `shell` and `workdir` come from the execution (`execution.name` and the Session's
  `workingDirectory`); `workdir` is resolved before hashing, and a shell call that passes its own
  `workdir` is refused for a vault-backed name (the Bot can `cd` in the command instead, which is
  in the digest). Equal digest: the adapter reads, the value enters that environment, and the
  grant is consumed. Different or absent: no value, the grant is canceled and consumed, and the
  Bot is told `The approved command, shell or folder was different; ask again.` One approval
  therefore buys one attempt — the next shell call by that Bot in that Session — matching or not.
- **What the digest does not carry.** The environment is not bound: the secret's own variable
  name is fixed by the name, an inline assignment such as `TOKEN=... ./sync.sh` is already in the
  command text, and the rest of the ambient environment is the Session's, not the program's
  identity; binding it would put values the person cannot see on the card. The first cut's shell
  tools take one command string, so there is no argument list to bind; a later tool that takes an
  argv array is bound as an ordered field in the same digest and shown on the card. `timeoutMs`
  and the background flag are not bound: they do not change which program runs.
- **What it does not bind.** What the command does after it starts. The command can read the value
  and send it anywhere; masking is a safety net, not a boundary. The person reads the command on
  the card; that is the decision.
- **The vault Allow.** The card's Allow button and its `secret-allow` call are unchanged
  (`apps/bots-dsh/src/client/secret-card.js:123`, `team-actions.js:235`); the branch is in the
  handler. That handler (`apps/bots-dsh/src/host/secrets.js:904-907`) today refuses a name that is
  not in `secrets.json` (`:906-907`). The vault branch is additive: when the request names a
  mapping and no typed secret, `secret-allow` writes no value and no scope entry, verifies the
  request is an allow with a command and shell, the Bot is still in the mapping's scope, and the
  service is present, then issues the one-execution grant above and writes the audit row. A name
  in neither store keeps the current refusal. This cannot widen what a Bot can read: it adds no
  `secrets.json` entry and no scope, the name's mapping is still the only source, the grant is one
  name/one Bot/one Session/one digest/shell/folder, and the first resolution consumes it whether
  it matches or not. The Bot never calls this endpoint; it is the person's authenticated browser
  route.
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
- That card's Allow takes the `secret-allow` vault branch: no `secrets.json` entry and no scope
  change, one grant for the command, shell and folder the card named. A typed name is unchanged:
  its allow card still adds that Bot to the secret's scope, the value still reaches every shell
  call it makes, and no command is bound.
- If the vault is locked, the card says so and offers the person the unlock in Settings. The Bot
  gets a note and no value, and no grant is issued.
- `list_secrets` shows the name, purpose, scope, and one availability word: available, locked or
  unavailable (a name defined twice and a mapped name with the plugin off read unavailable).
  `stale` is a read result, never an availability word. It never shows the provider, item, field,
  reference or value.
- The Bot may read exactly the one value, in the one approved execution. It cannot list, search,
  export, read another field, write, unlock, change scope, or supply a vault reference.
- The first cut reaches the shell only, through `$DSH_SECRET_<NAME>`. MCP capabilities, the
  GitHub connector, Remote Hermes and persistent shells come later, bound to a destination and a
  config revision, as delivery 5.
- Cards appear only in the Bot's own chat; a group chat cannot approve, as today.

### Freshness, offline and revocation

`bw get` does not ask the server: it reads the unlocked local vault, which is only as new as the
last `bw sync`. `bw status` reports `status` (`unlocked`, `locked` or `unauthenticated`) and the
persisted `lastSync` (ISO-8601), but neither proves the session is still valid: a revoked CLI
session can keep decrypting the local vault. The version is checked first; status is a fast
pre-check; the sync is the gate. The rules, in order:

- **Version gate first (5 s).** The first child of a read is `bw --version` with a 5-second
  timeout. The first cut accepts the 2026.10 line at `2026.10.1` or later
  (`>= 2026.10.1`, `< 2026.11.0`). Any other version refuses before any status or sync with
  `The installed Bitwarden CLI is not the version this vault plugin supports; nothing was read.
  Install Bitwarden CLI 2026.10.1 and ask again.`, drops the session key and runs `bw lock`. The
  version is pinned because the classifier below recognizes that build's messages; a newer `bw`
  is refused until this RFC names it and its messages, so an upgrade cannot widen what is
  tolerated in silence. 2026.10.1 was the current stable line when this RFC's contract was
  written; the 2026.11.0 cut shipped on this RFC's date, and a minimum cannot be a build released
  the same day, so the first cut pins the 2026.10 line. The commands and flags this RFC uses
  (`--version`, `status`, `sync`, `get`, `lock`, `config server`) are all present in 2026.10.1.
- **Status is a pre-check only (5 s).** `bw status` runs with a 5-second timeout. `locked` or
  `unauthenticated` refuses as locked without a sync. A status that fails, times out or cannot
  be read refuses with `The vault did not answer; nothing was read. Ask again when it is
  available.` `unlocked` proves only that the local vault can be decrypted; it does not prove the
  session.
- **Sync is the gate (10 s).** `bw sync` runs with `BW_RESPONSE=true` and a 10-second timeout.
  Success means the local vault is current as of now, and the read proceeds to `bw get`; no
  `lastSync` arithmetic is needed. A read is never served from a cache the plugin kept; it keeps
  none. A sync the plugin kills at the timeout prints no message, so it is an unrecognized
  failure and refuses.
- **Only a recognized network failure is tolerated as `stale`.** The classifier reads the
  `Syncing failed: <message>` value from the `BW_RESPONSE` JSON and accepts exactly the network
  messages of 2026.10.1 below; it then audits `result: stale` and proceeds to `bw get`. The age of
  `lastSync` does not gate the read: the kind of failure is the criterion, not the clock.
- **Every other failure refuses and locks.** An auth failure (not logged in, an invalid or
  expired session key, 401/403, a decryption/MAC error), a 5xx, a TLS or certificate error, a
  proxy-auth error, a changed or unreadable output format, a version outside the range, any other
  `Syncing failed:` message, and a plugin kill all refuse before any `bw get` with
  `The vault is locked or the session is no longer valid. Unlock it in Settings › Vault and ask
  again; nothing was read.`, drop the session key, run `bw lock`, and audit `result: locked` for
  a recognized auth failure or `result: refused` for any other. A recent `lastSync` is not
  evidence that the session is live.
- **What "offline" means.** Offline is not a separate mode and not a clock: it is exactly a
  `bw sync` failure whose message is in the network allowlist below. Any other failure is not
  "offline" and is never tolerated. The allowlist and the version range are not settable in the
  first cut, and option (b) in the table above (always read the local cache) is not shipped.

**The network allowlist, at 2026.10.1.** The CLI prints `Syncing failed: ` and then node-fetch
2.7.0's `FetchError` text. The shapes below are the part after `Syncing failed: FetchError: `;
the classifier accepts only these, anchored at both ends, with the URL and the address or host
allowed to vary:

- `request to <url> failed, reason: getaddrinfo ENOTFOUND <host>`
- `request to <url> failed, reason: getaddrinfo EAI_AGAIN <host>`
- `request to <url> failed, reason: getaddrinfo EAI_FAIL <host>`
- `request to <url> failed, reason: connect ECONNREFUSED <address>`
- `request to <url> failed, reason: connect ETIMEDOUT <address>`
- `request to <url> failed, reason: connect EHOSTUNREACH <address>`
- `request to <url> failed, reason: connect ENETUNREACH <address>`
- `request to <url> failed, reason: connect ENETDOWN <address>`
- `request to <url> failed, reason: connect ECONNRESET <address>`
- `request to <url> failed, reason: read ETIMEDOUT`
- `request to <url> failed, reason: read ECONNRESET`
- `request to <url> failed, reason: write EPIPE`
- `request to <url> failed, reason: socket hang up`
- `request to <url> failed, reason: Client network socket disconnected before secure TLS connection was established`

A `FetchError` with any other reason — a certificate, proxy-auth or HTTP-status message, or an
unparseable body — is not in the allowlist and refuses and locks. The classifier never matches a
bare `ENOTFOUND` or `timeout` substring, and never treats a non-`FetchError` message or a value
it cannot parse as network.

**Where the classifier lives and how it is tested.** It is a pure function in
`apps/vault-dsh/src/bw/classify.js`, called by the adapter between the sync child and the read.
It takes only the observed version, the child's exit code and the decoded `BW_RESPONSE`
stdout/stderr, returns `ok`, `stale-network`, `auth` or `unknown`, and performs no I/O and no
logging. `apps/vault-dsh/test/classify.test.js` forges both classes without a real vault:
table-driven fixtures of the exact strings above (recorded from `bw` 2026.10.1) plus auth, 5xx,
TLS, truncated JSON and unknown text, all passed as text. The delivery 3 adapter test also puts a
fake `bw` on `PATH` that prints a fixture and exits 1, so the refusal, the `bw lock` call and the
audit row are proven with temp homes and a fake clock. No test needs a vault account, a server or
a real `bw`.

- **A revoked session between two reads.** Every read syncs, so the first read after a revocation
  gets the auth failure, refuses and locks; no value is served. A revocation that lands after a
  successful sync but before that read's `bw get` cannot be seen by that read: the value was
  current at sync time, and the next read refuses. The residual window is one read, not a clock.
- **A locked vault is checked first.** `bw status` reports `locked` or `unauthenticated`; the read
  then refuses as locked (`The vault is locked. Unlock it in Settings › Vault and ask again;
  nothing was read.`) and never syncs while the status says the vault is locked or unauthenticated.

**Revocation.** The freshness rule is what makes a revocation visible; it is not a retraction.
What each revocation means:

| Revoked in the vault | Next use | What it cannot do |
|---|---|---|
| Item deleted | With a successful sync, the read finds no item: refuse with `The value for <name> is not in the vault; nothing was read.`, audit `result: revoked`. The person's Secrets row says "item not found". A tolerated stale read can serve the pre-deletion value until the next successful sync. | Delete a value a command already read. |
| Field renamed or removed | With a successful sync, refuse with `The value for <name> is not available from the vault; nothing was read.` The person's Secrets row names the item and field; the Bot's message never does. A tolerated stale read can serve the old field's value until the next successful sync. | Same. |
| Value rotated | With a successful sync, the new value is served, and only it; there is no plugin cache holding the old one. A tolerated stale read after a recognized network failure can serve the pre-rotation value until the next successful sync, with `result: stale`. | Change a Bot's context, a file the Bot wrote, or a process started before the rotation. |
| Session revoked or the account disabled | The next `bw sync` fails authentication; the read refuses as locked or unauthenticated regardless of `lastSync`, the plugin drops its session key and runs `bw lock`, audit `result: locked`. | Revoke a value already delivered. |
| Mapping deleted, or the Bot removed from its scope | The name no longer resolves for that Bot, and no card can grant it. | Same. |
| Plugin turned off or uninstalled | Every vault-backed name is unavailable; `bots-dsh` still reads `vault-sources.json`, so a mapped name never resolves from `secrets.json` (One name, one source). | Same. |

A Bot that already holds a value — in its context, in a file it wrote, in a process it started —
keeps it: the plugin's boundary is the read, not the Bot's later copies. The person's remedy is to
rotate the credential in the vault, revoke the vault session, delete the mapping and, if the Bot
wrote it to disk, delete the file. The lock timer narrows the window; the network-only allowlist
keeps a non-network failure from being read as offline; they do not close it.

**Masking life.** A value read from the vault joins the redactor before the approved command
starts and leaves it when the turn ends or 15 minutes after the read, whichever comes first.
Until then it is masked exactly like a typed secret, with the same floor and the same limits
(base64, hex, split and reversed forms are not covered). A later, unrelated output that quotes it
is not masked; that is why a value is not kept in the redactor for the life of the process.

### One name, one source

A name is exclusive across the two stores. `secrets.json` is an array on disk and a `Map` in the
process (`secrets.js:614`, `:698`); a hand-edit can repeat a name in the array and the `Map` keeps
the last entry. That is one store's duplicate, not a cross-store one, and it is not covered by
this rule. `vault-sources.json` is an object keyed by name. The rule:

- **Always read, even with the plugin off.** `bots-dsh` reads `vault-sources.json` itself, with
  the same synchronous read that loads `secrets.json` (`secrets.js:650-654`), at start and on
  each reload, whether `secretSources` is present or not. The cost is one extra small synchronous
  read per secrets load; there is no plugin call, no `bw`, no new dependency. An absent file means
  no mappings, exactly as today. A file that exists but cannot be read or parsed is not "no
  mappings": while it is broken, every secret resolution refuses with `The vault mapping file
  could not be read; no secret can be used until it is fixed.` so a corrupt file cannot silently
  re-enable a typed value.
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
  restored backup), every consumer reads the same reserved-name set: `resolveEnv`
  (`secrets.js:1166-1181`), `rt.secretValue` (`:1230`), `canUseSecret`/`canUseSecretInSession`
  (`:1231-1232`), `canUseInSession` (`:42-43`), `sessionSecretNames` (`:997-999`),
  `secretsView`/`list_secrets` (`:852`, `:1120`), and the card/`request_secret` and `secret-allow`
  paths. A dual name yields neither value anywhere; `list_secrets` shows `unavailable: this name
  is defined both in secrets.json and in vault-sources.json`. No vault read is attempted for it.
  A mapped name with no typed entry never resolves from `secrets.json`, and the plugin being
  absent does not change that.
- **What the person sees.** The Secrets page row is marked `defined twice`, names both sources and
  offers to delete one of them; the Bot sees unavailable, and a `request_secret` for it is refused
  rather than carded.
- **Older host.** An older `bots-dsh` ignores `vault-sources.json`: no vault value appears. If a
  collision already exists in its files, that older host serves the typed value as today; the
  exclusion is the newer host's rule, and an older host cannot be fixed from here.
- **Implementable with today's shape.** Both stores are keyed by name and read by one process, so
  the check is a set intersection at load and at each write; neither file's version or fields
  change. Today there is no source order to preserve — `resolveEnv` iterates the single `secrets`
  map and `rt.secretValue` reads the same map — so the rule adds a refusal, not a reordering.
  Delivery 2 carries it, including the plugin-off test.

### Lock, cache and quit

The value cache is zero by default. The vault locks after an idle time the person sets, default
5 minutes (Q4) and at most 8 hours, and when the app quits or the plugin is turned off. On lock the
plugin drops the session key and runs `bw lock`. The next use says the vault is locked; only the
person unlocks. Unlock credentials are typed into the host's Settings, never into a Bot's chat,
and never travel over a plain-HTTP page off loopback.

**The session key's exposure.** `bw` takes the session key through `BW_SESSION` or `--session`.
The plugin passes it only as `BW_SESSION` in the environment of each short-lived `bw` child it
runs — one child per invocation, so `bw --version`, `bw status`, `bw sync` and `bw get` are four
children, and `bw lock` runs without it — never in argv, never in a temp file, never in DSH's own
environment, never in the profile or `ctx.credentials`, never in a Bot shell's declared variables.
Each child's environment exposes the key for that child's run (and until it exits); the plugin
starts no long-lived process. A same-user process can read a child's environment
(`/proc/<pid>/environ`, `ps eww`) or its memory while it runs, and a Bot's shell is such a
process. The boundary is that no file, log, session, diagnostics or audit ever holds the key —
not that no same-user process can read it while a child runs.

### Boundaries

- **Never logged, never in the profile, a session, diagnostics or the audit:** the value, the
  session key or API token, the master password, the item reference and path, the field, the
  connection label, and raw manager output. An error is reduced to a code before it is shown or
  logged. The audit holds a command digest, never the command text.
- **Bot-facing refusals carry the secret name only.** A deleted item, a renamed field and a
  revoked session each answer the Bot with the name it asked for and a generic reason; the item,
  field, connection and manager output stay in the person's Settings view. A tolerated `stale`
  read is not a refusal: it returns the value and audits `stale`. A refusal returned to the Bot is
  part of its session, so it is written to the same boundary as a value.
- **The person must approve:** the mapping (name to provider, item and field, with whose Bots may
  ask), the unlock, each use (allow once, for the named command, shell and folder), turning the
  plugin on, and a new connection. A Bot can never approve any of these.
- **No listener:** the plugin never runs `bw serve` or any HTTP server, opens no port, and calls
  only the manager's own CLI or API.
- **No typed fallback:** turning the plugin off, uninstalling it, losing the vault, going offline
  or a name defined twice makes vault-backed names unavailable. `bots-dsh` still reads
  `vault-sources.json`, so a mapped name never resolves from `secrets.json`; the plugin never
  converts one into a stored value. The person must map a typed secret under another name if they
  want one, and an unmapped typed name behaves exactly as now.
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
  Q10.
- **ACP routes:** the Bot's DSH shell path is unchanged; a value reaches only that execution, not
  an agent's own built-in shell.
- A route that cannot be supported in a delivery is named in that delivery and approved by the
  owner; it is never left out silently.

## Contracts introduced

- `@automagik/vault-dsh` (`apps/vault-dsh`), an optional market plugin. It adds no package
  dependency and bundles no manager CLI. The person installs `bw`; the plugin pins the 2026.10
  line and never updates it.
- Service `secretSources`, version 1: status, unlock, lock, a read of one field (or the item
  transiently, with only the field leaving), and a person-only item list for the picker. `status`
  resolves to `{state: 'unlocked'|'locked'|'unauthenticated', lastSync?: number}`; a read is
  `version (5 s gate) → status (5 s pre-check) → sync (10 s gate) → a stale allowance only on a
  message in the pinned version's network allowlist → one field`. Unlock input comes from the
  host's Settings, never from a model message. A Bot-facing list or read-all is not part of the
  service.
- **The `bw` version and its network allowlist are a contract.** The first cut accepts
  `>= 2026.10.1` and `< 2026.11.0`; any other version refuses and locks. Only the 2026.10.1
  messages listed under "Freshness, offline and revocation" may yield `stale`; every other
  failure, including an auth failure, an unknown message, a 5xx and a TLS or certificate error,
  refuses and locks. The classifier is `apps/vault-dsh/src/bw/classify.js`, a pure function over
  the version, the exit code and the decoded `BW_RESPONSE` output. A new `bw` line is refused
  until an RFC amendment names it and its messages; it never widens the allowlist by itself. This
  is the #1668 contract.
- `<team home>/vault-sources.json`, mode 0600, version 1, keyed by name with one row per name:
  name, provider, connection label, item, field, scope, purpose, requester and timestamps. No
  value, ever. `bots-dsh` owns and reads it, not the plugin, and always reads it, with or without
  the service; `secret-source-set` writes it. `scope` says which Bots may **ask**; it is not a use
  grant. The connection is a label; `bw config server` owns the server address, so Automagik
  stores no host. One connection label only in the first cut.
- `secrets.json` is unchanged (version 1: each entry's name, value, purpose, scope, Session,
  requester and timestamps; `secrets.js:614`, `:698-708`). No reference is added. A name here is
  exclusive with `vault-sources.json`; neither store's value is served for a dual name. An older
  `bots-dsh` ignores `vault-sources.json`: no vault value appears, and if a collision already
  exists that older host serves the typed value as today. Restoring the newer plugin restores the
  mappings, and nothing is converted.
- A Session-scoped secret (`secrets.js:38-43`) stays outside the first cut: it is never a Bot's
  and reaches no shell (`:1191`), and a vault mapping is refused for a name `secrets.json` holds
  scoped to a Session.
- **`request_secret`, changed additively:** it gains the optional `command` and `shell` arguments
  above, both required for a vault-backed name and both ignored for a typed one. Two optional
  strings; no new tool, no rename, no other argument, note or return value changed. The owner's
  delegate approved this Bot-facing change in Q11 (2026-11-19); delivery 2 carries it.
- **`secret-allow`, changed additively:** the existing handler (`secrets.js:904-907`) gains the
  vault branch that issues the one-execution grant and writes the audit row; it adds no value and
  no scope. It is not a new endpoint and the Bot cannot call it. Approved in Q11 (2026-11-19).
- The secret-request row gains `command`, `commandDigest`, `shell` and `workdir`, and never gains
  the provider, item, field or connection. The command is the Bot's own tool-call argument and the
  shell is its new argument, both already in the session transcript; the folder is the Session's.
  The card renders provider, item and field from `vault-sources.json`; they are never stored in
  the session or the model context.
- The existing `POST /api/omni-ui` route (the browser session cookie) gains `secret-source-set`,
  `secret-source-clear`, `vault-unlock`, `vault-lock` and `vault-status`; `secret-source-set` and
  the `vault-*` calls are refused when `secretSources` is absent, while `secret-source-clear`
  works without it so a person can remove a mapping while the plugin is off. Older clients ignore
  them; the source row appears only when the service is present.
- Unchanged: `DSH_SECRET_<NAME>`, `list_secrets`, scope and cards. Newly removed from every Bot
  shell and MCP environment: `BW_SESSION`, `BWS_ACCESS_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`,
  `VAULT_TOKEN` and every adapter's unlock variable.
- `<team home>/vault-audit.jsonl`, mode 0600, bounded and rotated: time, secret name, Bot id,
  consumer kind, command digest, decision, result. `result` is one of `ok`, `stale`, `revoked`,
  `locked`, `refused`. No value, reference, field, connection, raw command or command text.
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
  That first release is a desktop release (3.N): its changed paths include
  `apps/desktop/src/lane.js`, which is not a plugin path (`scripts/lane.ts`'s `kindOf` gives a
  plugin patch only for `apps/<plugin>/`), so a plugin-list change outside `apps/<plugin>/` makes
  it 3.N. The market index is `neverShipped` and is not the reason. It is market-only by default,
  not in the desktop profile's preinstalled bundles.

## Threat model

The trust boundary is the DSH host process, not the Bot. The person unlocks; the plugin holds the
session key; `bots-dsh` authorizes; the Bot gets one value in one approved execution. Settings
endpoints are on the authenticated browser route, the approval comes from the owner's chat, a
grant is bound to one command, shell and folder and one execution, and there is no network
listener.

- **Prompt injection or a compromised Bot.** A request gives no authority. The approval is the
  boundary: it names the exact command, shell and folder, and covers one execution; a different
  one resolves to no value and consumes the grant. If the person approves a command that sends the
  value out, the Bot can leak it; masking is a safety net, not a boundary. A Bot that
  base64-encodes, hex-encodes, splits or reverses a value can still leak it: the redactor builds
  only the value, its JSON-escaped forms and its URL-encoded forms (`secrets.js:124-136`).
  Only OS isolation or the sandbox ([RFC 0010](0010-desktop-sandbox.md)) stops same-user
  processes.
- **A Bot running the manager CLI itself.** Unlock variables are removed from every Bot shell and
  MCP environment, and Auto treats `bw get`, `bws secret get`, `pass-cli item view|run`,
  `keepassxc-cli show`, `secret-tool lookup` and `op run|inject` as secret reads, as it already
  treats `op read` and `vault kv get` (`apps/bots-dsh/src/host/auto-judge.js:68`). A CLI with no
  session is locked; the plugin never accepts a master password from a model.
- **A shared machine, and the session key.** Another OS user cannot read a 0600 file or another
  user's process memory, but a same-user process can read both — including a `bw` child's
  `BW_SESSION` while that child runs. The lock timer narrows the window, and a separate OS account
  or the sandbox is the real boundary. The mapping file names items, sensitive even without
  values.
- **A stolen machine or session key.** The session key is memory-only and dies with the process
  or the lock. A stolen key can read what that vault account can until the session is revoked;
  scoped accounts and the lock limit it. Revoke the vault session, rotate the credential, and
  delete the mapping. A value already read and approved cannot be taken back.
- **Stale reads and revocation.** `bw get` serves the local vault, so `bw sync` is the gate: an
  auth failure refuses and locks at once, and only a message in the pinned version's network
  allowlist is tolerated, audited `stale`; every other failure refuses and locks. A revocation
  this machine has not synced is not visible: a tolerated stale read can serve the pre-revocation
  value until the next successful sync. The allowlist is what keeps a non-network failure from
  being mistaken for offline. A successful sync makes a deleted or rotated item visible; a
  revoked session fails the sync. A value a Bot already holds is not retractable: rotate the
  credential.
- **A name in two stores.** A dual name is refused from both stores, and `bots-dsh` reads the
  mapping file even with the plugin off, so a hand-edited typed secret cannot shadow a vault
  mapping and a mapping cannot silently replace a typed secret. There is no precedence rule to
  exploit and no value comparison to probe.
- **Masking floors.** A vault value below 4 characters is refused before use, so it cannot be
  injected unmaskable; the typed store's floor and held behaviour are unchanged.
- **A compromised plugin or `bw`.** Either can read what the session key can and exfiltrate it.
  The plugin cannot grant access; it is optional, reviewed, on the signed plugin lane and pinned
  in the market. `bw` is third-party code the person installs; a malicious update is a
  supply-chain risk. The first cut trusts both as much as the DSH host.
- **Logs and errors.** The manager is asked for one field where its CLI offers one (`bw get
  password`, `bw get username`) and for the item where it does not; `bw get item` returns the
  whole item, which the adapter reads transiently, selects the mapped field from and drops, so
  only that field leaves the plugin. A refusal to the Bot is reduced to the secret name and a
  generic reason; the manager's output is reduced to a code, and the audit holds no value or
  reference. A Bot's printed output is masked before it is saved or sent to the model, but a
  command that already sent the value out has already leaked it.
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
2. **Source seam in `bots-dsh`** (plugin, 3.N.P). The `tools/execute` pre-read and the synchronous,
   scoped resolve; `vault-sources.json` and its always-on load, also with the plugin absent; the
   command+shell+folder grant, the additive `request_secret.command` and `shell` (Q11) and the
   `secret-allow` vault branch; the dual-name exclusion; the 4-character floor; the one-execution
   shell path; masking before use; the audit; a "from a vault" row on the existing Secrets page.
   It does nothing without the plugin except the unavailability of mapped names. *Check:* with no
   plugin, the existing Secrets tests and behavior are unchanged for unmapped names; with a fake
   adapter, the Allow issues a grant and writes no `secrets.json` entry; only the named command,
   shell and folder resolves; a different command, shell or folder gets no value and cancels the
   grant; the same name in both stores is unavailable from both with the plugin absent too, and
   each write refuses it; a mapped name with the plugin absent has no typed fallback; a 3-character
   vault value refuses; a locked or absent source refuses. *Rollback:* turn the setting off;
   mappings remain and no value is stored.
3. **`apps/vault-dsh`, Bitwarden `bw`, read-only by reference** (desktop, 3.N — one lane). Unlock
   in Settings, the idle lock, the item picker, the approval card, and the freshness rule
   (`bw --version` gate → `bw status` pre-check → `bw sync` gate → one read). Vaultwarden's
   `bw config server` flow gets its own fake-`bw` case. This is the desktop release from the
   plugin lists, plus its market listing. *Check:* the acceptance list in #1271, with a fake `bw`
   on `PATH`, a fake clock and temp homes: the value and the session key are absent from every
   file and log; the reference, item and field are absent from `secrets.json`, the profile,
   sessions, diagnostics and the audit (they appear only in `vault-sources.json` and the person's
   card/Settings view, never in a Bot session or the model transcript); `BW_SESSION` reaches only
   each `bw` child's environment, never its argv; a `bw sync` that fails authentication with a
   recent `lastSync` refuses, drops the key and runs `bw lock`, audit `locked`; a `bw --version`
   outside `2026.10.1`–`< 2026.11.0`, a 5xx, a TLS error, an unknown `Syncing failed:` message, a
   truncated `BW_RESPONSE` and a plugin timeout each refuse and run `bw lock`; the classifier's
   forged fixtures prove the allowlisted network messages serve and audit `stale` while every
   non-listed message refuses; a tolerated stale read can serve the pre-revocation value until
   the next successful sync; a deleted item and a missing field each refuse with a message that
   contains only the secret name and a generic reason, and audit `revoked`; a rotated value serves
   the new one; another Bot, a group, a denied card and a locked vault each refuse with an audit
   row; `bw lock` runs after the idle lock; turning the plugin off makes the name unavailable and
   still refuses a typed fallback. *Rollback:* turn off or remove the plugin; mappings remain and
   no value is converted.
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

## Decided questions

The twelve questions this RFC asked are decided (2026-11-19): Q6 is the owner's decision on
#1668, and the other eleven carry the recommended answer the owner's delegate approved. Q4 takes
the conservative end of its recommended range, 5 minutes. No question is open.

1. **Transport for the first cut.** **Decided: the installed `bw` CLI**; the Management API does
   not enter now, because the CLI reaches Bitwarden cloud, self-hosted and Vaultwarden through the
   person's existing login, while the API is not a stable personal-vault contract. `bws` follows
   as the least-privilege route in delivery 4, and `bw serve` is rejected for the listener.
2. **First use: shell or MCP?** **Decided: the shell command first**, because most Bot work runs
   there and the grant can name the exact command and shell. The MCP destination route is safer
   but needs the mount rework in delivery 5. Q11 is yes, so the shell grant has its command and
   shell to bind.
3. **Default approval: once, session or standing?** **Decided: allow once only**, for the named
   command, shell and folder, 10 minutes, one execution. A session or standing grant waits for
   its own contract: a record, a revoke in Settings, an audit on issue, use and revoke, and a
   delivery of its own.
4. **Idle lock time.** **Decided: 5 minutes by default**, the conservative end of the recommended
   5–15-minute range, person-set, with an 8-hour maximum, because a longer lock weakens revocation
   and a much shorter one makes a Bot fail often.
5. **Where the mapping lives.** **Decided: the separate 0600 `vault-sources.json`**, not a
   `source` field in `secrets.json`, because #1271 requires the reference to stay out of
   `secrets.json` and an older `bots-dsh` cannot turn it into a stored value.
6. **A machine without the vault, and an offline vault.** **Decided: unavailable with a reason**,
   never a typed fallback and never a queued read; a successful `bw sync` is the gate, only a
   recognized network failure from the pinned `bw` 2026.10 line is tolerated as `stale`, and every
   other failure refuses and locks (#1668). The network allowlist, the version range and the
   classifier's tests are in "Freshness, offline and revocation"; the kind of failure decides,
   not the clock.
7. **Typed secrets and every shell.** **Decided: yes, later and behind a per-team switch first**,
   because it changes existing teams' behavior and needs its own rollback.
8. **Vault writes.** **Decided: never in this RFC**, because writes need an owner rule, their own
   audit and a separate RFC.
9. **#384, the machine's `gh` login.** **Decided: keep it separate**, because it is ambient
   credentials with no item and no vault approval; the same seam can serve it later. #384 was
   closed with that decision on 2026-11-19.
10. **Cloud and remote routes.** **Decided: `bws` service accounts only in Cloud**, and approve
    but never unlock from Pocket or remote; a person's personal vault never opens in Cloud. Cloud
    waits for the secure storage with its own rotation and revocation and stays out of the first
    cut.
11. **May `request_secret` gain `command` and `shell`, and may `secret-allow` issue a vault
    grant?** **Decided: yes.** `command` and `shell` are the only way the card can name the
    command and shell the Bot will use; both are additive, so an older host and every typed
    caller keep working, and the `secret-allow` vault branch adds no value and no scope.
12. **More than one vault connection?** **Decided: one in the first cut**, because a second
    account or server needs its own `bw` data directory and session; a later delivery adds
    per-connection directories and a picker.

Three rules are contracts, not questions, because there is no safe alternative to write: a name
in both stores is unavailable from both (no precedence, no fallback); `bots-dsh` reads
`vault-sources.json` even with the plugin off (so a mapped name never falls back); and the session
key is limited by the same-user boundary (there is no "never seen" claim).

Q2 and Q5 restate what the design already fixes. Both were answered as recommended, so delivery 3's
acceptance and the Contracts above stand as written.

## Links

- #1271: the request, current state and acceptance list. The issue calls this RFC 0033; 0033 is
  now [Attachments from Pocket](0033-attachments-from-pocket.md).
- #384: reuse the machine's `gh` login, kept separate by Q9.
- [RFC 0010](0010-desktop-sandbox.md): the sandbox and the deferred secrets broker, which this
  RFC does not replace.
- [RFC 0011](0011-monorepo-parts-and-releases.md): parts, lanes and the plugin patch.
- [RFC 0016](0016-windows-wslc.md): the WSL route.
- [RFC 0031](0031-auto-permission-level.md): Auto's secret reads, extended in delivery 1.
- [Bot team secrets](../../apps/bots-dsh/README.md#secrets): today's cards, masking and limits.
