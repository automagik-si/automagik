---
rfc: "0009"
title: "The phone's Pocket Link key wrapped by Android Keystore"
status: Draft
created: 2026-11-19
pr: ""
---
# RFC 0009 — The phone's Pocket Link key wrapped by Android Keystore

## Summary

Wrap the phone's Pocket Link secret key with an AES key held in Android Keystore. On the first
start after an update, wrap the existing key bytes so paired desktops keep recognising the
phone. The app decrypts the Pocket Link key into memory to connect.

## Motivation

Protect the phone's identity at rest. A desktop admits terminal and chat connections by the
phone's key, so keeping that identity through the upgrade preserves existing pairings.
`herdr/mods/pocket-link/bridge/guard.mjs:196`

## Current state

Before #244, the endpoint read the phone's 32-byte iroh key from `iroh.key` in
`noBackupFilesDir` and generated one whenever the file was absent.
`android/app/src/main/java/ai/namastex/automagik/IrohLink.kt:73` (before this change)

## Design

- Keep `iroh.key.sealed` in the same no-backup directory. Each write gets a fresh random alias
  and a non-exportable AES-256 key in Android Keystore. AES-GCM uses a provider-generated
  12-byte IV and a 16-byte tag. The frame stores version 1, the alias length and alias
  (`pocket-key-` plus 16 lowercase hex digits), the IV length and IV, and the 32-byte ciphertext
  with its tag. Reads are bounded and the entire frame is validated before looking up the alias.
- Stage the encrypted bytes in `iroh.key.tmp`, sync the file, and read and decrypt it to verify
  the original bytes. Publish it by rename and sync the directory before removing the plain
  file. Startup runs migration on a background thread and retries while a plain key remains.
- Use a valid plain key if both records exist. Retire the plain file only after the sealed
  copy opens to the same bytes and its directory entry is synced. Keep both when they
  disagree or the sealed record can't be read. A valid sealed key can still be used when the
  plain file is unreadable, and the unreadable file stays in place.
- Only pairing can generate a key, and it needs both records to be absent. Reconnecting with
  both records absent asks the user to pair. When records exist and none can be read, the app
  reports a read error and preserves them.

**Proposed by the implementing agent**

- Keep a newly generated key plain in no-backup app storage when Keystore is unavailable or
  sealing fails before the encrypted file is renamed into place. Once the sealed file exists,
  the app writes no plaintext fallback. If wrapping or verifying an existing plain key fails,
  keep using that key and retry on startup.
- Ask the user to retry a key read error. If it persists, clearing Automagik's storage in
  Android settings and pairing again recovers from a permanently unusable key. Clearing
  storage also removes the app's other local data. The app never replaces an existing identity
  automatically.

### Saved machines

- Seal the whole saved list in `hosts.sealed` in no-backup storage. Use the dedicated
  `pocket-hosts` alias and a fresh AES-GCM IV for each write. Reuse the key across frequent
  list updates, while phone identity writes use a fresh alias. Generate the host key only
  when both the alias and sealed record are absent. Keep the alias on read or write failure.
  `android/app/src/main/java/ai/namastex/automagik/HostSeal.kt:17`
  `android/app/src/main/java/ai/namastex/automagik/HostSeal.kt:47`
- Migrate the exact UTF-8 preference bytes, including fields this version does not use.
  Keep the original copy if it exceeds 1 MiB or migration fails. Allow plain saves if sealing
  fails before the first sealed record exists. Once present, the sealed record takes precedence.
  If it cannot be validated, block saves and retry the read before offering or starting pairing.
  `android/app/src/main/java/ai/namastex/automagik/HostStore.kt:29`
  `android/app/src/main/java/ai/namastex/automagik/HostStore.kt:40`
  `android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt:301`
- Sync the staging file, decrypt it to verify the bytes, replace the record by rename, then
  validate the visible record and sync the directory before removing the preference. Retry
  a failed preference cleanup on a later save or process start. Report pairing as saved only
  after the write succeeds. Wait for a durable write before evicting Teams entries for a
  removed machine or retiring an unused SSH key.
  `android/app/src/main/java/ai/namastex/automagik/HostStore.kt:56`
  `android/app/src/main/java/ai/namastex/automagik/HostStore.kt:86`
  `android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt:263`
  `android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt:558`

### Verification

- Run the Pocket build, tests and lint in the monorepo's Pocket CI job. JVM tests cover frame
  validation, record selection, migration and failures before and after publication.
  Robolectric API 35 covers Keystore being unavailable.
- In disposable fork CI, run the real adapter on API 26 and API 35. Install the dev APK and
  plant a known 32-byte `iroh.key` in no-backup storage via `run-as`. Update in place with the
  branch APK using the same app ID and debug signature. Launch MainActivity and wait with a
  timeout for startup alone to remove the plain file and publish the sealed one. In an
  instrumented check, load with `create = false` and compare both the returned bytes and the
  derived iroh public key with the expected values. Force-stop and relaunch, then repeat the
  checks, including startup and byte equality of the sealed file.
- On each emulator, remove the wrapping alias with `KeyStore.deleteEntry(alias)` in one case
  and flip a tag byte in another. Confirm that opening throws in each case and that loading
  leaves the existing record intact.
- On disposable API 26 and 35 emulators, plant a plain saved list with a test ticket in the
  dev APK, update in place and launch. Verify the cards, the sealed record without the plain
  ticket and the preference cleanup. Restart without a rewrite, remove the SSH card (its old
  key goes after the save), then remove the last card and restart (an empty sealed list).

### Next

- **Next → [App lock](0010-app-lock.md).** Decide when to require authentication and how to
  protect Assist, notifications and Recents.

## Decisions

- Owner, 2026-11-19: start #244 now, in the normal pull-request flow (relayed by the issue-queue
  coordinator; the issue had said track, don't start yet).

## Alternatives considered

| Alternative | Trade-off |
|---|---|
| Authentication-bound key | Reconnecting and Watch would depend on a recent user authentication. |
| Unlocked-device key | Connecting while the screen is locked would require a separate policy. |
| Jetpack Security | The deprecated encryption APIs would add a dependency. |
| Require StrongBox | Phones without StrongBox could not wrap their keys. |
| One fixed alias | Reusing the alias could invalidate an existing sealed record during key generation. |
| Automatic regeneration | Replaces the identity recognised by paired desktops after a key read failure. |
| No plaintext fallback | Pairing would fail on phones that cannot write a sealed key. |
| Seal the ticket only | Leaves other connection details plain and requires field-level migration. |
| Fresh alias per saved-list write | Accumulates keys during regular updates or requires separate alias cleanup. |

## Open questions

1. Accept the plain fallback in no-backup storage? — the owner.
   **Proposed:** Keep the fallback in no-backup storage so pairing works if Keystore is unavailable.
2. Keep clearing app storage and pairing again as the recovery path, or add a “new phone key”
   action that preserves other app data? — the owner.
   **Proposed:** Clear app storage and pair again. Use this deliberate recovery path for a rare failure.
3. When should the future app lock time out? — the owner.
   **Proposed:** Require authentication at each process start and after 60 seconds off screen.
4. Which notification actions should take precedence over the app lock? — the owner.
   **Proposed:** While the app lock is enabled, post generic alerts and require opening Automagik
   to answer. Refuse stale notification actions.
5. How should the app handle Recents below API 33? — the owner.
   **Proposed:** Use `FLAG_SECURE` on API 26–32. This keeps content out of Recents and also blocks
   screenshots and screen sharing. On API 33 and later, omit only the Recents screenshot.
6. Which saved machine fields and tickets should be sealed? — the owner.
   **Proposed:** Seal the whole saved list, including tickets, addresses and linked names.

## Related

- #244
- [RFC 0003 — Pocket Link pairing](0003-pocket-link-pairing.md)
- [RFC 0007 — Watch after reboot](0007-watch-after-reboot.md)
- [Privacy policy](../privacy.md)
