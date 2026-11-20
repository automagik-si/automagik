# RFC 0024 amendment, delivery R0: the evidence record

| Field | Value |
|---|---|
| Issue | #1426 (Refs) |
| RFC | [0024](../rfcs/0024-automagik-cloud.md), "Amendment (2026-11-20)", delivery R0 |
| Written | 2026-11-20 |
| Lane | docs (no release) |
| Status | The three questions answered; one gap (a real personal or team Claude sign-in) left to R2's fakes and the app |

Delivery R0 asks three things before R2: what Claude Code's `auth status --json` prints about the
organisation, what Codex's app-server `account/read` returns (its fields, its `planType` values,
whether it names a workspace), and how the reservation directory's set-group-id and sticky bits
behave. Rule kept throughout: **no real sign-in and no credential store was read.** Codex's protocol
was generated with an empty `CODEX_HOME`; Claude Code's answer was read from the program's own
`auth status` code, not by running it against a signed-in home; the directory was tried in a
scratch folder.

## 1. Claude Code: is `orgId` printed?

**Answer.** Yes, for a subscription sign-in, whenever the stored sign-in carries an organisation.
Claude Code 2.1.329 builds the `auth status --json` object as follows (its bundled code, read as
text, paraphrased):

- always: `loggedIn`, `authMethod`, `apiProvider`, and `apiKeySource` when a key is in use;
- `authMethod === "claude.ai"` (a subscription sign-in): `email` (the account's email address),
  `orgId` (the stored account's organisation UUID), `orgName`, `subscriptionType`, and a newer
  `planTier`. Each is `null` when the stored account lacks it;
- a key made by `/login` (`authMethod === "api_key"` from a managed key): `email`, `orgId`,
  `orgName`, no subscription;
- a gateway: `email` only.

**What this settles.** The organisation is the stored account's own UUID, printed beside the email
for every `claude.ai` sign-in, so (m)'s evidence (`orgId` + email) is available on current CLIs. An
`orgId` of `null` is possible (an account stored without an organisation, or an older CLI); (m)
already makes that read not reservable and ambiguous at the check.

**Unknown.** Whether a personal (Pro, Max) account always has an organisation UUID was not observed,
because that needs a real sign-in. Anthropic's model gives every account an organisation, so it is
expected; if it is ever `null`, the account is simply not reservable (the safe side). R2 tests
both shapes with fixtures; the app test of R3 shows the real one.

**Also seen.** `planTier` is new and is not used as evidence (a plan change is not another account).

## 2. Codex: what `account/read` returns

**Answer.** Codex 0.170.0's app-server protocol (`codex app-server generate-json-schema`, file
`v2/GetAccountResponse.json`) answers `{ account, requiresOpenaiAuth, userId? }`, where `account` is
one of:

| `type` | Fields |
|---|---|
| `apiKey` | none |
| `chatgpt` | `email` (string or null), `planType` (required), `workspaceName` (the selected workspace's display name, when available) |
| `amazonBedrock` | `usesCodexManagedCredentials` |
| `gcp` | none |

`userId` is the ChatGPT user id, when available. `planType` is one of: `free`, `go`, `plus`, `pro`,
`prolite`, `promax`, `team`, `self_serve_business_prolite`, `self_serve_business_usage_based`,
`business`, `ent26`, `enterprise_cbp_automation`, `enterprise_cbp_usage_based`, `enterprise`, `edu`,
`edu_plus`, `edu_pro`, `sci`, `sci_plus`, `unknown`.

**Does it name a workspace?** Only by display name. `workspaceName` can change and need not be
unique, so it cannot be identity: a renamed workspace would read as another account and slip past
its reservation. The ChatGPT account id that would identify the workspace appears only in the
protocol's routing type, not in `account/read`'s answer; the account id in Codex's own auth file is
a credential store and is never read. `userId` names the person, not the workspace.

**What this changes.** (m)'s plan classes become the full list (the RFC's table now points here):

| Class | `planType` values |
|---|---|
| `personal` | `free`, `go`, `plus`, `pro`, `prolite`, `promax` |
| `workspace` | `team`, `business`, `self_serve_business_prolite`, `self_serve_business_usage_based`, `enterprise`, `ent26`, `enterprise_cbp_automation`, `enterprise_cbp_usage_based`, `edu`, `edu_plus`, `edu_pro` |
| `unknown` | `unknown`, `sci`, `sci_plus`, and any value not listed here (a newer Codex) |

An `unknown` class is not reservable and matches either class at the check, as (m) says. An `email`
of `null` is not reservable. `workspaceName` and `userId` are not evidence; a stable workspace id in
`account/read` would become one (additive). `amazonBedrock` and `gcp` are not subscriptions: not
reservable, never refused.

## 3. The directory: set-group-id and sticky

**Answer (Linux, tried; macOS, documented).**

- `inode(7)`: on a directory, the sticky bit means a file in it can be renamed or deleted only by
  the file's owner, the directory's owner or a privileged process; the set-group-id bit makes files
  created there take the directory's group, and new subdirectories inherit the bit.
- Tried in a scratch folder: **`mkdir -m 3770` leaves `1770`** (the kernel drops set-group-id from
  `mkdir`'s mode for this case), while `mkdir` then `chmod 3770`, or `install -d -m 3770`, gives
  `drwxrws--T` (`3770`). The setup command must set the mode after creating the folder.
- An exclusive create (`wx`) or a hard link onto an existing name fails with `EEXIST`; a process may
  replace its own file by rename. A file created with mode `0640` keeps it only when the umask allows:
  under a umask of `077` it becomes `0600` and the group cannot read it, so **writers set `0640` on
  the open descriptor** (`fchmod`), as R1 does for `0600`.
- macOS (BSD) documents the same sticky rule (`sticky(7)`), and BSD semantics already give every new
  file its directory's group, so set-group-id is harmless there. Not tried on a Mac here.
- Not tried here: a second OS user (no root on this host). R4's acceptance keeps the two-user test
  where CI can make users, else a recorded manual run.

## What R2 and R4 take from this

- R2: Claude evidence as (m) says; Codex classes from section 2's table; `email: null` and the
  `unknown` class not reservable; `workspaceName` and `userId` ignored as identity.
- R4: the setup command creates the folder, then sets `3770` and the group; every reservation file
  is created exclusively and given `0640` on its descriptor; `key` likewise.
