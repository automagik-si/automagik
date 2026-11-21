# Vault for DeepSeek Harness

Install and enable `@automagik/vault-dsh` from the Automagik market. Install Bitwarden CLI
2026.10.1 or a later 2026.10 patch separately and sign in on the host. For Vaultwarden or a
self-hosted Bitwarden server, set the server with `bw config server` before signing in.

Use a CLI account with a master password. Password login and API key login both work when
the account can unlock with its master password. Key Connector and SSO accounts without
a master password cannot unlock through this plugin.

In the Bot team's Settings › Secrets, unlock the vault and use **Add a vault key** to map an
item field and choose which Bots may ask for it. Each use requires approval of the exact
shell command. The plugin supports login username, login password, notes and unique
hidden or text custom fields. Read access covers a single configured CLI account.

The master password goes to the unlock child through its environment. The plugin keeps
the returned session key in memory and locks after the configured idle time
(`idleLockMinutes`, 5 minutes by default, from the last unlock or successful read).
**Lock**, disabling the plugin and a planned desktop quit drop the key and lock an owned
session. Bitwarden CLI manages its own account and local vault data.

Each approved read forces a sync before retrieving the selected field. The exact network
failures in [RFC 0034](../../docs/rfcs/0034-vault-plugin-bitwarden-first.md) permit a stale
read from the CLI's local vault. Other sync failures refuse the read and lock the session.

## 1Password service accounts

Install 1Password CLI 2.39.0 or a later 2.x version on the host. Give a service account read
access to the vaults it needs. In local Settings › Secrets, select **1Password** under **Vault**
and enter the service account token. The picker groups items by vault and identifies fields
with duplicate labels by section.

The token lives in plugin memory and is passed through the environment of authenticated
`op` children. Every authenticated command disables the CLI cache. **Clear token**, idle lock,
disabling the plugin and quitting clear the token. Enter it again after restarting. If the CLI
cannot read the current value, the request is refused. 1Password service accounts are
available on hosts where `op` runs, except Automagik Cloud.

The team uses a single vault provider and connection. Remove the existing mappings before
switching. Before rolling back to an older Bot team plugin, remove 1Password mappings so the
older host can read the mapping file. Delivery 2b covers shell delivery.

## HashiCorp Vault KV

Install a stable Vault CLI 2.0, 2.1 or 2.2 release. In local Settings › Secrets › Vault,
select **HashiCorp Vault** and enter the server address, token and optional namespace.
Use HTTPS. HTTP is available for loopback at `127.0.0.1`, `[::1]` or `localhost`.
Automagik Cloud does not support this provider.

Enter a KV v1 or v2 mount to browse its folders and choose a field. The plugin checks
the exact mount before each item read or listing. The token needs access to that
mount preflight and the relevant read and list paths. With no mapping, connect tries
the mount table and tolerates a policy denial there. Values are read fresh and field
selection happens inside the adapter. Use the Vault server directly or a non-caching
Vault Proxy that forwards the supplied token. Caching Vault Proxies are unsupported
and cannot be detected. HTTPS uses the OS trust store. Forward proxies, custom CAs
and redirects are unsupported.

The endpoint and token live in memory until lock, idle expiry, a provider switch,
disable or quit. Each authenticated CLI child receives them through its environment.
The plugin gives each child an isolated home and removes its empty private directory
after the child exits. Vault paths appear in transient CLI arguments and may appear
in Vault's own audit. Same-user processes can inspect a running CLI's arguments and
environment. Automagik saves the reference and a hash of the canonical
endpoint and namespace in `vault-sources.json`. Reconnect to the same endpoint and
namespace after a restart to use those mappings. A different endpoint or namespace
invalidates pending approvals and grants. Remove the HashiCorp Vault mappings before
rolling back to an older Bot team plugin.

To check the transport against a local copy of the Vault CLI, set `VAULT_REAL_BIN`
to the binary and run `hashicorp-vault-cli.test.js`. The test uses an in-process
loopback responder.

## Secret Service (GNOME Keyring)

On Linux, select **Secret Service (GNOME Keyring)** in local Settings › Secrets › Vault
and choose **Unlock**. This opens Automagik’s access without a password. Manage the actual
keyring lock in GNOME. The picker shows locked collections without their items. Select an
item from an unlocked collection and save the mapping. An item can still lock after the
plugin gate opens. Automagik Cloud, KeePassXC and KWallet are outside this delivery.

The gate monitors the session bus and its Secret Service owner. An owner change, a bus
disconnect or change of identity, **Lock**, idle expiry, a provider switch, disable or quit
closes the gate and invalidates approvals. A successful field read renews the same idle
timer. Reference changes require a new mapping. Before rolling back to a Bot team version
that predates this provider, remove all Secret Service mappings.

### Product choices

- The owner’s process name, executable basename and PID start time check compatibility
  with GNOME Keyring. This trusts the person’s desktop bus and the backing store GNOME
  opens. Same-user processes are inside that trust boundary.
- The saved reference is the canonical item path, exact creation time and the first
  32 hex characters of SHA-256 over the sorted attribute pairs. The path can contain a
  collection name. It is stored in `vault-sources.json`. Picker handles expire with
  the listing or gate. The plugin fetches attributes for a selection when saving it.
  The unkeyed digest can confirm guesses about predictable attributes.
- The reference detects changes before and after each read. Secret Service has no atomic
  conditional read. A replacement may enter the adapter’s memory, then be erased and
  refused if the post-check detects a change. A restored item with the same path,
  creation time and attributes is treated as the same item.
- Values use the DH-AES encrypted session. Labels and attributes are ordinary D-Bus
  property replies outside that session. Access uses the explicitly supplied session
  bus address, via one Unix endpoint. Closing the plugin gate leaves the desktop
  keyring’s OS permissions and lock state as they were.
- Reads accept `text/plain` in fatal UTF-8, preserving whitespace and a BOM and
  refusing NUL. A wire byte array is limited to 64 KiB. The Bot team applies its
  existing secret-value rules.

The required private-keyring acceptance test is
`VAULT_SS_REAL=1 node --import ./test/harness-resolve.mjs --test test/secret-service-real.test.js`.
Run it with Node 24.9 and the extracted AppImage runtime with `ELECTRON_RUN_AS_NODE=1`.
It requires a private Unix socket, `dbus-daemon`, `gnome-keyring-daemon` and
`/usr/bin/python3` with the D-Bus and libsecret bindings.

## Proton Pass

Install Proton Pass CLI 2.7.1 and create a personal access token with read access to a
vault. In local Settings › Secrets › Vault › Proton Pass, choose **Set token**. The token
is used once to sign in and is dropped after login. The CLI keeps its encrypted session
in a private temporary folder with a memory-only key. On Windows the folder relies on
the per-user temporary directory's access controls.

**Lock**, idle lock, a provider switch, disabling the plugin and quitting remove the
session. The plugin also locks at most 110 minutes after login starts, before Proton's
two-hour session expiry. Enter the token again after the vault locks.

The picker lists items shared through a vault, and only built-in fields can be mapped.
Custom fields and grants for individually shared items are unsupported. Agent tokens
are unsupported. The adapter supplies no reason, so the CLI refuses reads for sessions
it classifies as agent sessions. A token the CLI classifies as an ordinary personal
access token reads like one. Proton may record reads in its Business read report.
Forward proxies are unsupported. Proton Pass is unavailable in Automagik Cloud.

## Bitwarden Secrets Manager machine accounts

Install `bws` 2.x on the host. In local Settings › Secrets › Vault, choose **Bitwarden
Secrets Manager**, enter the server (`us`, `eu`, or a self-hosted HTTPS base URL) and
select **Set token**. Use a machine account scoped to the projects it needs. The picker
lists projects first and lets you choose a project's keys.

The token is saved in the host user's keychain. After a restart or lock, select **Unlock**
to activate it again. **Clear token** deletes the saved credential and locks the adapter.
Settings sends the displayed connection label with Clear. A provider-only request requires
an active Secrets Manager connection or a mapping to identify the saved item.
Setting a fresh token for the same connection replaces its saved server and token. The
adapter confirms the saved record before activating the replacement. With two DSH processes
on one profile, a Clear in one does not end the other's in-memory session. That session
ends at its idle lock, an explicit lock, or quit. Remote and Pocket clients cannot change
or unlock the credential. Cloud support is deferred.

With `bws` 2.1.0, HTTP 401 and HTTP 400 with an `invalid_client` or `invalid_grant`
error lock the adapter. The CLI reports identity and item API errors in the same
format, so D4c classifies a 404 from `bws secret get` as unavailable and leaves the
adapter unlocked. The adapter never classifies a `bws` diagnostic as revoked.

macOS uses the login keychain's default ACL, which trusts `/usr/bin/security`. A
same-user process can use that executable to read the credential while the login keychain
is unlocked, including between CLI calls. Removing that trust would require prompting
on reads. Linux and WSL use the local login session's Secret Service through `secret-tool`.
Windows uses the current user's Credential Manager.

Before rolling back, remove Bitwarden Secrets Manager mappings and clear the saved token
while this version is still installed. Older Bot team versions reject the mapping file
when it contains a Bitwarden Secrets Manager row.

## macOS Keychain

In local Settings › Secrets › Vault, choose **macOS Keychain** and select **Unlock**.
This opens the plugin gate without a password. The gate closes after the configured idle
time, on Lock, when switching providers, when disabling the plugin or when quitting.
Only a successful read renews the idle time. You can approve from Pocket, and you can
open the gate only in local Settings. This provider is available on macOS outside
Automagik Cloud.

Use **Add a vault key**, enter the exact **Service** and **Account**, and select **Find**.
The picker checks one generic-password item in your login keychain
(`~/Library/Keychains/login.keychain-db` in your system account's home). The connection
label is `login-keychain`. Recreating an item with the same service and account in the
same keychain counts as a rotation. Apple Passwords and iCloud Keychain are outside
this integration.

The plugin gate is the vault lock for approvals. While the gate is open, **Allow**
records approval and issues one grant even if the macOS keychain is locked. If macOS
refuses a later read, the adapter refuses it too. Part 2b, which would deliver the value
to the approved shell, is held. macOS may ask on this Mac. Choose **Allow**, not
**Always Allow**. Always Allow would let any `security` call, including a Bot's shell,
read the item without asking. A read is refused at the 30-second deadline if nobody answers.

The adapter calls the system `/usr/bin/security` with both path arguments bound to the
login keychain. It checks the reported keychain before releasing any value. The tool
has already attempted the read when the adapter checks the header. A rejected header
prevents delivery. The adapter drops stdout after checking its first line and drops
stderr after parsing the password record. Child output is capped at 4 MiB. The strings
live in plugin memory until garbage collection.

## Windows Credential Manager

In local Settings › Secrets › Vault, choose **Windows Credential Manager** and select
**Unlock**. The unlock probes the reader without accessing the store. If it fails to
start, Settings offers **Retry**. The plugin gate closes after idle time, explicit Lock,
switching providers, plugin disposal or a read deadline. Only a successful value read
renews idle time. Approval checks the gate and issues one command-bound grant. Part 2b
holds delivery to the approved shell.

In **Add a vault key**, enter the exact **Target** and select **Find**. The picker makes
one native read and copies no secret from the record. Its optional user name is display
metadata. Cards show the saved target with its original spelling. The fixed
`current-user` connection resolves the target case-insensitively in the current token's
logon-session credential set. Two logon sessions of the same user can have different
sets. A copied mapping resolves in the reader's set. Replacing a credential under the
same target, including its user name, counts as a rotation. Generic credentials with
session, local machine or enterprise persistence are supported. The
`automagik-vault:` namespace is reserved for Automagik. There is no enumeration or
writing. Domain credentials, Web Credentials and certificates are outside this provider.

Passwords are decoded as strict UTF-16LE text, the Windows convention. Leading BOM
and whitespace are preserved. Empty, malformed or NUL-containing values are refused.
Bytes from a UTF-8 or arbitrary binary writer can decode as different UTF-16LE text
or be refused. The RFC's four-character use floor applies independently of decoding.

The reader is available on x64 Windows outside Automagik Cloud when both Windows root
variables name `C:\Windows` and the fixed Windows PowerShell 5.1 and taskkill binaries
exist there. The fixed-root check relies on those paths and environment values. An
administrator or someone who controls the boot configuration and can substitute a
different Windows tree could substitute the read result. The reader respects execution
policy and AMSI. The child's environment contains SystemRoot, windir, PATH, TEMP and
TMP. Node or Windows may add HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, USERDOMAIN,
USERNAME, USERPROFILE or NODE_V8_COVERAGE. PowerShell initializes PSModulePath and
PATHEXT before compilation and the script clears both before passing control to the reader.
Compiler scratch is private to the invocation under the plugin's profile data folder.
The probe has a 30-second deadline and reads have 15 seconds. Cancellation and deadlines
trigger separately bounded process-tree cleanup when the child is still running.
Quit reports unconfirmed cleanups. The invocation’s scratch folder can remain in that case.

The target and value use private pipes. The privacy checks cover Automagik-controlled
files, diagnostics, audit and judge payloads, and PowerShell transcripts in the native
test. Windows' own credential-access auditing, such as Security event 5379, can record
the target and stays enabled. Programs running as the same Windows user can call the OS
API outside the plugin gate. Credential Guard supplies no per-read confirmation for these
generic credentials.

The host-only `secretSources` v1 service provides `status`, `unlock`, `lock`, `read`,
`listItems` and `prepareQuit`. The `providers` property lists supported providers.
HashiCorp Vault also exposes `listFields` for the host picker. Secret Service exposes
`resolveHandle` and `itemDetail` for the host. Secret Service, macOS Keychain and Windows Credential Manager
expose `providerBinding` for gate generation checks.
`status()` defaults to Bitwarden, and `status({ provider })` checks the named provider.
Run `bun run harness` to install the pinned test harness and `bun run test` to run the
fake-CLI tests.
