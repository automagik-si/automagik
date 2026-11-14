# RFC 0033: Attachments from Pocket

| Field | Value |
|---|---|
| Status | Queued |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P), herdr (Pocket Link), pocket |
| Created | 2026-11-14 |

## Summary

Propose sending images from Pocket to a DSH chat through the desktop's upload admission.
The phone would show attachment rows, upload progress and explicit Retry, with previews on tap.
This proposes an amendment to RFC 0015's chat route and DSH-write amendment; the owner has not
yet read it. Formats, caps and compatibility below are proposals, not accepted decisions.

## Motivation

#1272 reports that Genie cannot open the person's images. Desktop attachments now reach every
route (#1273, #1274, #1282); the phone still sends text only. The desktop opens DSH's own file
input (`apps/bots-dsh/src/client/composer.js:173`), and ACP tests cover admitted images and files
(`apps/acp-dsh/test/upload-content.test.js:68`,
`apps/acp-dsh/test/upload-content.test.js:606`). The phone's boundaries are:

- The composer calls `vm.chatSend(draft)`:
  `apps/pocket/android/app/src/main/java/ai/namastex/automagik/ChatScreen.kt:215`.
- The ViewModel creates a text message and calls `link.send`:
  `apps/pocket/android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt:1171`.
- The client sends `chat.send {terminal,text,id}`:
  `apps/pocket/android/app/src/main/java/ai/namastex/automagik/ChatClient.kt:104`.
- The bridge validates text and forwards `{text,id}` to the DSH source's socket send:
  `herdr/mods/pocket-link/bridge/chat.mjs:228`,
  `herdr/mods/pocket-link/bridge/dsh-source.mjs:323`.
- bots-dsh cleans text and prompts the watched Session; its adapter queues one text block:
  `apps/bots-dsh/src/host/pocket-chat.js:573`,
  `apps/bots-dsh/src/host/pocket-chat-adapter.js:27`.

The projection drops nontext content; an image-only user message makes no row. Tools, status
and tokens have separate rows (`apps/bots-dsh/src/host/pocket-chat.js:134`,
`apps/bots-dsh/src/host/pocket-chat.js:153`).

## Design

### Reuse DSH admission

Propose DSH chats first. Terminal image paste stays separate, as RFC 0015 deferred it
(`docs/rfcs/0015-live-chat-projection.md:380`). Propose system pickers and no camera capture.

The inspected local harness confirms these package APIs; this was not a running desktop check:

- The composer calls `ctx.fileUpload.uploadImage(sessionId,file,mediaType,name,signal,onProgress)`
  or `ctx.fileUpload.upload(sessionId,file,name,signal,onProgress)`:
  `@deepseek-ai/dsh-client-ui-conversation` (`lib/client.js`).
- Blob uploads use `POST /api/session/uploadFileBinary` with `sessionId`, `name` and optional
  `mediaType` query fields, and `application/octet-stream`. `mediaType` selects image admission:
  `@deepseek-ai/dsh-client-file-upload` (`lib/client.js`, `lib/index.js`).
- Host `fileUploads.uploadImageStream` normalizes and stores images; `uploadStream` streams files.
  Both mint Session-bound receipts: `@deepseek-ai/dsh-client-file-upload` (`lib/index.js`).
  Both images and files can enter a prompt as `{type:'file',receiptId}`:
  `@deepseek-ai/dsh-client-ui-conversation` (`lib/client.js`).

Propose delegating to `fileUploads.uploadImageStream({sessionId,data,mediaType,name,signal})`,
then `uploadStream` for later document support. These signatures are verified in
`@deepseek-ai/dsh-client-file-upload` (`lib/types/index.d.ts`); the socket integration is new.
Resolve the Session from the watched channel. Do not let the phone name a desktop path or make
the bridge write the store or call desktop HTTP. Repository fixtures use the real DSH store and
controller, reject foreign-Session receipts, and commit image/file blocks
(`apps/acp-dsh/test/support/upload-admission.js:46`,
`apps/acp-dsh/test/upload-content.test.js:76`, `apps/acp-dsh/test/upload-content.test.js:95`).

ACP already copies verified store bytes into `.automagik/uploads/<digest>/<name>`
(`apps/acp-dsh/src/host/upload-files.js:27`, `apps/acp-dsh/src/host/upload-files.js:127`).
Tests check exact bytes and mode `0444`; copy failures keep a fallback file handle, so agent
access is not unconditional (`apps/acp-dsh/test/upload-content.test.js:606`,
`apps/acp-dsh/test/upload-content.test.js:619`). Propose reusing that path after admission.

### Bound both transports

Current phone limits are 32 KiB UTF-8 send text, 256 KiB frame payload, 16 concurrent requests,
8 subscriptions, 256 KiB subscription credit, 2 MiB queued subscription data and 4 MiB unsent
connection data (`herdr/mods/pocket-link/bridge/chat.mjs:25`). The admission guard has a 10 s
handshake, 16 pending connections, 4 pending per address, 64 open and a 4096-byte header-line
constant (`herdr/mods/pocket-link/bridge/guard.mjs:7`). The DSH socket separately limits lines
to 64 KiB, connections to 4, subscriptions to 8, writes to 20/minute/device and one write in
flight per phone/chat (`apps/bots-dsh/src/host/pocket-socket.js:32`,
`apps/bots-dsh/src/host/pocket-socket.js:54`).

Propose `chat.attach` to open a bounded upload channel with receiver credit, finish and cancel.
Existing credit controls outbound subscription events; inbound upload credit needs its own
specification (`herdr/mods/pocket-link/bridge/chat.mjs:182`). Propose socket begin/chunk/finish
methods, with 24 KiB raw chunks encoded for NDJSON and acknowledged before the next chunk.
Keep the socket line limit; account upload bytes separately from prompt-write rate.

Propose 8 MiB/file, 4 files and 16 MiB/message, one active upload/device and 32 MiB outstanding
per device across connections. Use the minimum of Pocket and DSH limits. Decoded pixels,
timeouts and server-wide quotas need measured bounds before delivery 1; these caps need approval.
Propose PNG/JPEG/WebP first; reject SVG, HTML and unsupported formats. DSH's inspected allowlist
also has GIF (`@deepseek-ai/dsh-attachment-local`, `lib/index.js`), as does ACP
(`apps/acp-dsh/src/host/upload-content.js:12`). Later documents would use explicit MIME types.

### Send, retry and read

Propose optional text plus ordered receipt parts through `controller.prompt`, `mode:'queue'`.
Allow attachment-only messages. Reject foreign or expired receipts; bind each upload to the
paired device, watched channel and original Session as well as DSH's receipt ownership.
Propose stable message and upload IDs with an immutable manifest. A lost acknowledgement stays
"Maybe not sent" until explicit Retry with the same request ID; text Retry already keeps its ID
(`apps/pocket/android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt:1184`).

Check prior prompt acceptance before requiring receipts again. DSH deduplicates before receipt
resolution (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js`), and retires receipts after
queue/history observation (`@deepseek-ai/dsh-client-file-upload`, `lib/index.js`). Propose refusing
retry into a replacement Session; require a new explicit send instead of silently retargeting.

Propose ordered text/image/file blocks with durable references and legacy text fallback rows.
Propose an authenticated read method naming channel, row and block, with Session membership
checked by the server. Read DSH storage and stream a bounded thumbnail on tap, without phone
disk caching. `attachments.readImage(ref,signal)` is verified in
`@deepseek-ai/dsh-attachment-local` (`lib/index.js`); thumbnail generation is **unverified**.

## Contracts introduced

All method names and limits here are proposed. The proposed RFC 0015 amendment covers message
and row shapes, attachment transport and limits, rendering, privacy and its DSH-write amendment:
`docs/rfcs/0015-live-chat-projection.md:254`, `docs/rfcs/0015-live-chat-projection.md:331`,
`docs/rfcs/0015-live-chat-projection.md:577`. Write it into 0015 only after owner acceptance.

- Retain `herdr-pocket/chat/1`; negotiate `attachments:1`, methods, MIME types and effective caps
  at both handshakes. This explicitly proposes amending 0015's new-ALPN rule for changed method
  meanings (`docs/rfcs/0015-live-chat-projection.md:390`), beyond its existing write negotiation
  (`docs/rfcs/0015-live-chat-projection.md:689`). Without negotiation, keep text-only semantics.
- Add `chat.attach`, upload channel finish/cancel, socket begin/chunk/finish and authenticated
  attachment reads. Extend negotiated sends with receipt parts and rows with ordered blocks.
  Final schemas, method names and credit rules remain to be specified before delivery 1.
- Keep old phone/new bridge text behavior and fallback rows. A new phone/old bridge offers no
  attachments and names the computer component needing an update. A new bridge/old bots-dsh
  advertises no DSH attachments, even with `dshWrite`. Reconnect renegotiates; never silently
  strip attachments. Independent peer upgrades are established in
  `docs/rfcs/0015-live-chat-projection.md:691`.

Propose no release, feed or signing change to RFC 0011. Pocket Link stays on herdr and Android
on pocket (`docs/rfcs/0011-monorepo-parts-and-releases.md:288`,
`docs/rfcs/0011-monorepo-parts-and-releases.md:301`). No new public filesystem path is proposed.

## Threat model

Propose preserving paired-key admission and subscribed-channel authority for uploads, sends and
reads. RFC 0015 admits only paired connections subscribed to that chat and ends writes within
2 s of revocation (`docs/rfcs/0015-live-chat-projection.md:720`). Project visibility remains a
separate yes; pairing does not grant it (`docs/rfcs/0015-live-chat-projection.md:751`).
Propose cancelling unfinished uploads when a device is revoked, a channel closes, visibility
ends or its Session changes. Removing access cannot undo data already admitted on the desktop.

Propose enforcing per-device caps across connections and bounded server-wide work, including
decoded image memory. A paired or stolen phone must not exhaust disk or memory by uploading.
Accept bytes, never phone-supplied desktop paths or arbitrary URL reads. Sanitize display names;
do not log attachment content or names, including in errors. Reject references outside the
authorized Session, even if a caller knows their IDs.

Pocket promises memory-only chat data (`apps/pocket/docs/privacy.md:31`), no automatic chat image
loads (`apps/pocket/docs/privacy.md:59`) and camera use only for pairing
(`apps/pocket/docs/privacy.md:97`). Propose memory-only previews and tap-to-load reads, with no
camera capture initially. The pocket delivery would update `privacy.md` in the same PR to name
picker bytes and display names sent to the computer, desktop persistence and workspace copies,
retention/cleanup, and authenticated thumbnail reads. It would keep the phone-memory, explicit
load and pairing-only camera promises. This follows `apps/pocket/AGENTS.md:43`.

## Deliveries

Proposed order: plugin, Pocket Link, Pocket, as in the DSH-write rollout
(`docs/rfcs/0015-live-chat-projection.md:771`). Each delivery would be one lane PR, hidden until
its peers negotiate support. Owner answers precede any delivery they block.

0. **Docs only.** This RFC and both indexes; precise proposed amendment to 0015.
   *Check:* citations verified and owner blockers recorded. *Rollback:* revert proposal docs.
1. **Plugin (3.N.P).** Gated socket admission, receipt sends, attachment rows and authorized
   thumbnail reads. *Check:* real DSH admission fixtures reject foreign Session/device receipts,
   prove bounded memory and interruption cleanup, and retry once after acknowledgement loss.
   *Rollback:* remove the capability; already admitted desktop data remains.
2. **Herdr (Pocket Link).** Upload channels, socket chunks, capability intersection and cleanup
   on revocation. *Check:* slow peers and over-limit input stay bounded, revocation ends uploads,
   and old bots-dsh exposes no attachments. *Rollback:* withdraw capability or copy prior bridge;
   preserve text. Previously admitted desktop data remains.
3. **Pocket.** Picker, progress/cancel, attachment-only sends, blocks/thumbnails and explicit Retry;
   privacy changes in the same PR. *Check:* Android gate and all staggered-version cases above,
   including reconnect without retargeting. *Rollback:* a later APK hides attachments;
   desktop copies remain.
4. **Later, separate PRs on all three lanes.** Explicit documents, then broader files or camera
   capture only if approved. *Check:* each negotiated type passes admission and privacy checks.
   *Rollback:* withdraw each capability independently; already admitted data remains.

## Open questions

1. DSH chats only first? **Recommend yes**, with terminal attachments deferred.
2. PNG/JPEG/WebP, then TXT/PDF? **Recommend yes**; defer GIF, archives, audio and video.
3. Accept the proposed byte/file/device caps? **Recommend them as starting bounds**, subject to
   phone/host memory measurements. Set decoded-pixel, timeout and server-wide quotas before
   delivery 1; exact values remain open.
4. How long may unreferenced uploads remain, and who removes workspace copies? **Recommend
   explicit cleanup rules before delivery 1**, including cancelled uploads already stored by DSH.
5. Tap-to-load thumbnails and no persistent phone cache? **Recommend yes**; verify or specify a
   bounded thumbnail generation API before delivery 1. Its availability remains unverified.
6. Refuse retry into a replacement Session? **Recommend yes**; require a new explicit send.
7. Allow additive attachment negotiation under chat/1? **Recommend yes**, with the explicit
   amendment to 0015. Specify schemas, method names and inbound credit rules before delivery 1.

## Links

- #1272: Genie cannot open the person's images; desktop work: #1273, #1274, #1282.
- [RFC 0015](0015-live-chat-projection.md): proposed amendment to chat and DSH writes.
- [RFC 0011](0011-monorepo-parts-and-releases.md): release lanes, unchanged.
- [Pocket RFC index](../../apps/pocket/docs/rfcs/README.md).
- [Pocket privacy](../../apps/pocket/docs/privacy.md): changes with the pocket delivery.
