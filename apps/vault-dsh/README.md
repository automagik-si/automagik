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
Automagik Cloud does not support this provider. Proton Pass and OS keychain
providers are deferred. Secret Service support for Linux and KeePassXC needs a
D-Bus client that can use one connection for the session and secret retrieval.

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

The host-only `secretSources` v1 service provides `status`, `unlock`, `lock`, `read`,
`listItems` and `prepareQuit`. The `providers` property lists supported providers.
HashiCorp Vault also exposes `listFields` for the host picker.
`status()` defaults to Bitwarden, and `status({ provider })` checks the named provider.
Run `bun run harness` to install the pinned test harness and `bun run test` to run the
fake-CLI tests.
