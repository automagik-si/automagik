# Vault (Bitwarden) for DeepSeek Harness

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

The host-only `secretSources` v1 service provides `status`, `unlock`, `lock`, `read`,
`listItems` and `prepareQuit`. Run `bun run harness` to install the pinned test harness
and `bun run test` to run the fake-CLI tests.
