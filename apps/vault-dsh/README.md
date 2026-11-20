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

The host-only `secretSources` v1 service provides `status`, `unlock`, `lock`, `read`,
`listItems` and `prepareQuit`. The `providers` property lists supported providers.
`status()` defaults to Bitwarden, and `status({ provider })` checks the named provider.
Run `bun run harness` to install the pinned test harness and `bun run test` to run the
fake-CLI tests.
