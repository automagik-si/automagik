---
title: "Privacy policy"
type: policy
created: 2026-11-01
updated: 2026-11-20
tags: [privacy, policy, play]
---
# Automagik Pocket privacy policy

Effective 2026-11-06. Applies to the Android app **Automagik Pocket** (app ID
`ai.namastex.automagik`), published from
[automagik-si/automagik](https://github.com/automagik-si/automagik/tree/dev/apps/pocket) (`apps/pocket/`;
before 2026-11, [automagik-si/automagik-pocket](https://github.com/automagik-si/automagik-pocket)).

## In short

- The app connects your phone to **your own computers**. We run no server for it and have no
  account system.
- **No analytics, no ads, no tracking.** The app contains no analytics or advertising library.
- The only other services it contacts: **GitHub**, to check for updates in the GitHub APK, and **n0's iroh
  services**: relays, which carry Pocket Link traffic they cannot read, and an address lookup,
  where the phone and the Pocket Link bridge on your computer each publish their public key and
  the n0 relay they currently use (no IP addresses).
- What it keeps stays on the phone, is not backed up, and is deleted when you uninstall.

## What the app handles, and where it goes

| Data | Where it goes | Why |
|---|---|---|
| Terminal screens, agent status, messages and replies you type or speak | Only between the phone and your machine | This is what the app is for |
| Chat: an agent's transcript (its messages, tool calls with their input and output, approvals, questions and token counts) and the Automagik Bots' chats, including the type and size of the images and the name and size of the files in a Bot's messages, sent by Pocket Link's chat route ([RFC 0015](../../../docs/rfcs/0015-live-chat-projection.md)) | Only between the phone and your machine. Kept in memory while the chat is open (the receipts of requests answered while the phone was away included), dropped when you leave it. While Home or Team shows, the list of the Bots' chats (each one's name, state, whether it is shown and, while it waits on a question or an approval, the request's text) is read every 30 seconds and kept in memory only, with what the phone saw of each chat's state between two readings and, for a request it saw answered, who answered and what (the Home row's Done line). Never written to the phone's storage, never logged, never sent anywhere else | To show an agent as a chat beside its terminal. Tool output can hold secrets such as tokens; it is the same text the terminal already shows the phone, and it is not redacted |
| What you type or speak, approve, deny or stop in an Automagik Bot's chat, when that computer's Pocket Link says it takes the phone's writes ([RFC 0015](../../../docs/rfcs/0015-live-chat-projection.md), Amendments, 2026-11-07) | Sent over Pocket Link to that computer's Automagik (DSH), and nowhere else: a message becomes your prompt in the Bot's current chat, recorded in that chat as yours; an approval or a question's answer settles that one request; Stop cancels the running turn. The computer records your phone's name with an approval you answer. Nothing of it is kept on the phone or logged | So you can talk to your Bots and answer their approvals from the phone. Only for the Bots the computer shows: a project's after its yes in Herdr or Automagik, and the global Bots, the Main Bot included. Allow for the whole session stays on the computer. Remove the phone in Pocket Link to end its writes within 2 seconds |
| Pictures you send in an Automagik Bot's chat, when that computer's Pocket Link and Automagik offer images ([RFC 0033](../../../docs/rfcs/0033-attachments-from-pocket.md)) | Android's photo picker (or, on phones without it, the system file picker) gives the app only the pictures you choose; the app asks no photos or storage permission. For each picture the app makes a new PNG, JPEG or WebP copy on the phone from its pixels only, at most 2048 pixels on its long side: the original's file name, location, camera details and other metadata are not in it, and an animated picture becomes its first frame. Pocket sends over Pocket Link to that computer's Automagik (DSH), and nowhere else: each copy's bytes, type and length, your caption, and random ids the phone makes for the message and each upload; never the phone's name. On the computer, DSH stores the image and smaller copies of it, and they stay like an image attached on the computer: ending the chat or removing the phone does not delete them. Once the message is sent, the Bot's tools may copy the image into the project (`.automagik/bots/<botId>/uploads` or `.automagik/uploads/`), and the computer gives the message to the Bot's model as it does an image attached there, so the model provider configured on that computer receives it then. For 24 hours the computer keeps upload and message records (a hash of the phone's key, the ids, a hash of the caption, sizes and times). The upload records enforce the phone's daily limit of 128 images and 256 MiB. The message records cover the newest 64 messages per phone. Retry may deliver a recorded message to the Bot for the first time, and the computer prevents duplicate delivery. An upload not used in a message within 15 minutes is forgotten and can no longer be named, but a picture DSH already staged for an unsent message stays on the computer until that chat ends. Removing the phone in Pocket Link stops its uploads within 2 seconds. On the phone the copies are kept in memory only until the message is sent or dropped (leaving the chat, or Android ending the app, drops them): Pocket makes no lasting copy, never writes them to its storage and never logs them; your original stays where it was. | So you can show a Bot a screenshot or photo from the phone. Only on the Bots' chats that take the phone's writes; never a terminal chat. |
| Images in an Automagik Bot's chat (yours, or ones attached on the computer) | The chat shows each image's type and size. The picture shows only after you tap **Show**: the phone then asks that computer for a small copy of that one image (at most 512 pixels and 128 KiB) over Pocket Link. Kept in memory while the chat shows it (a few at a time), dropped when the chat reconnects or you leave it; never written to the phone's storage, never logged. Other attachments show only their name and size and are never loaded. | To see what was sent without loading every image |
| An Automagik Bot's memory, when that computer's Pocket Link and Automagik offer it ([RFC 0036](../../../docs/rfcs/0036-bot-management-from-pocket.md)) | Read from that computer when you open Memory in the Bot's chat: the Bot's own entries (text, topic, dates, pinned and expired marks). Kept in memory only while Memory is open, on its own connection that closes with it; never written to the phone's storage, never logged, and hidden from screenshots and the recent-apps preview. Text you add or edit, with the edited entry's id and revision, goes to that computer's Automagik and nowhere else; the computer saves it in the Bot's memory, marked as added from Pocket. A change the computer accepted stays there even if the phone never gets the answer. | So you can read and correct a Bot's memory from the phone. Only a project Bot the computer shows and that is not private: never the Main Bot or global Bots, team or group memory, or another Bot's. Remove the phone in Pocket Link to end it: access ends within about 2 seconds while the bridge runs normally. |
| An Automagik Bot's scheduled tasks, when that computer's Pocket Link and Automagik offer them ([RFC 0036](../../../docs/rfcs/0036-bot-management-from-pocket.md)) | Read from that computer when you open Schedules in the Bot's chat: each of the Bot's own tasks' name, state and timing, never its prompt or where it runs. Kept in memory only while Schedules is open, on its own connection that closes with it; never written to the phone's storage, never logged, and hidden from screenshots and the recent-apps preview. Pause, Resume and a new name you type go to that computer's Automagik with the task's id and revision, and nowhere else; the computer saves the change and tells the Bot's chats, as a change made on the computer does. A change the computer accepted stays there even if the phone never gets the answer. | So you can pause, resume and rename a Bot's tasks from the phone. Only a project Bot the computer shows, private ones included; never the Main Bot or global Bots. Remove the phone in Pocket Link to end it: access ends within about 2 seconds while the bridge runs normally. |
| An Automagik Bot's settings, when that computer's Pocket Link and Automagik offer them ([RFC 0036](../../../docs/rfcs/0036-bot-management-from-pocket.md)) | Tap the Bot's name in its chat to read its name, saved, applied and running model, effort, model list and level from that computer. Settings data stays in memory for the open dialog on its own connection and is cleared when you close it, leave the chat, background the app or lose access. The dialogs are hidden from screenshots and the recent-apps preview. Effort is received and kept in memory without being displayed. New names and model choices go only to that computer with the Bot's address and revision. The computer saves accepted changes and adds a Diagnostics note with the Bot id and the kind of change, without the name or model. Teams separately caches Bot names. | To rename a project Bot the computer shows, choose one of its available models and see its level. The level changes on the computer. |
| Paired machine details: name, session name, the desktop's Pocket Link ticket | Stays on the phone in one record encrypted with a key held in Android Keystore. A plain copy in app storage excluded from backup can remain until migration and cleanup succeed. Saves can stay plain when the app cannot create the first sealed record. Machine names also appear in the Teams cache and folded-machines setting. | To reconnect |
| Machines saved over SSH by an older version: name, hostname, SSH user, port, session name, host key fingerprint | Stays on the phone and is never used to connect; deleted when you pair that computer with QR or remove it | So the card can ask you to pair it again ([RFC 0008](rfcs/0008-drop-ssh.md)) |
| The phone's make and model (for example "Pixel 8") | Sent once to the desktop you pair with | So the desktop can name the paired phone. The desktop lists it beside a fingerprint of the phone's Pocket Link public key, which it already has, so two phones with the same name can be told apart |
| Folder git status, origin remote URL and Herdr desktop program icons | Read from your machine; the git answers stay in memory, icons cached on the phone | To draw the spaces tree like the desktop, and to group spaces into projects and branches into tasks |
| Usage meter summary: token counts and estimated $ per repository, branch, model and hour (the `herdr-meter` document, if you run the meter) | Read from your own machines and kept in memory; never written, never sent anywhere else | To show spend on Home and Code |
| Space Row stats in that document (merges with their PR/MR links, time to merge, first pass, $ and tokens per model, per bot) and bot and category names from each project's `.herdr/bots.json` | Read from your own machines and kept in memory; never written, never sent anywhere else | To show each space's stats line and its bots' cards, as the desktop sidebar does |
| Teams: each project's bots from its `.herdr/bots.json` (id, name, main or member, look), their live state, Herdr's space icons and colours (`shared.json` and its `space-icons/` images) and the bots' pets (`~/.automagik/bots/pets`) | Read from your own machines, never written there. A copy of the projects, bots and their last known state, the space images and the pets stays on the phone | So Teams opens at once, and offline, as you last saw it |
| Update check (GitHub APK only, app version in the request) | GitHub | To offer a newer release |

Nothing else is collected. We, the developers, receive none of this data.

## Network connections

1. **Your machines over Pocket Link.** iroh connections, end-to-end encrypted, dialled by public
   key. When no direct path exists, the encrypted traffic passes through relay servers run by n0
   (the iroh project). Relays forward the encrypted bytes; they can't read them, though they do
   see the network addresses involved. The phone and the Pocket Link bridge on your computer each
   publish their public key and the n0 relay they currently use to n0's address lookup, iroh's
   default, so the phone finds the computer after its IP address changes. No IP addresses are
   published, though n0's servers see the address each request comes from.
2. **GitHub.** When the GitHub APK opens (at most every 15 minutes), every 6 hours while it or **Watch in
   background** runs, and when you tap **Settings → About → Check for updates**, the app downloads
   `latest.json` from this repo's rolling `pocket-lane` release. When a newer version is out it downloads
   the APK from GitHub too: on its own on Wi-Fi with **Install updates automatically** on, otherwise
   when you tap **Install**. GitHub sees your IP address and a User-Agent with the app version. The
   check itself can't be turned off in the current version. Google Play manages updates for
   copies installed from the Play Store.
3. **Web links.** A link you tap in a terminal opens in your browser. In a chat, a link shows its
   address and opens only after you tap it and confirm. The chat loads nothing on its own. To see
   an image in a Bot's chat, tap **Show**. Pocket then reads a small copy from your computer over
   Pocket Link. Pocket loads nothing in a chat from the web and displays HTML as plain text.

## What is stored on the phone

- Your saved machines and settings, including the `app_lock` preference.
- The phone's Pocket Link (iroh) key stays in app storage that Android never backs up.
  The app encrypts it with an AES key held in Android Keystore that cannot be exported.
  The app decrypts the Pocket Link key into memory to connect. On the first start after
  updating, the app wraps an older plain key and deletes the plain copy once the encrypted
  copy is safely written and verified. If the encrypted copy can't be written or read, the
  existing plain key stays in that storage and the app retries wrapping it on each start.
  The app keeps a new key plain in the same storage if Keystore is unavailable or sealing
  fails before the encrypted file is put in place. It retries wrapping that key on each start.
- Only if you used SSH in an older version: that version's SSH key, in the same storage. The app
  deletes it once no machine saved over SSH is left.
- Cached program icons, and a downloaded update until it installs.
- Nothing of the pictures you send in a chat: their copies stay in memory only.
- The Teams tab's copy, in an SQLite database: projects, bots and their last known state, and today's
  most agents working at once, which the phone counts itself; plus the space images and pets copied
  from your machines. Each reading of a machine replaces that machine's part.
- The last crash report, if the app crashed (below).

App backup and device-to-device transfer are turned off for all of it. Uninstalling the app deletes
it all, including the keys. There is no way to export the private keys.

## Crash reports

If the app crashes, it saves one report on the phone: app version, Android version, phone make
and model, the time, and the error's stack trace. It holds no keys and no saved settings; an error message in the
stack trace can still name things such as a machine.

Nothing is sent automatically. On the next launch the app says it closed unexpectedly; **Report**
opens **Settings → About**, where you can **Copy report**, **Share** it (Android's share sheet: you
choose the app and the recipient), or **Clear** it.

## Microphone

Used only when you tap the microphone in the chat composer, the terminal composer, or the side-button
assistant panel. The app uses Android's `SpeechRecognizer`, which hands the audio to the phone's
**default speech recognition service** (chosen in Android's settings, often Google's). That service
turns it into text, and the app puts the text in the message box for you to send. The app itself
never records or stores audio. Whether the audio leaves the phone depends on that service and its
own privacy policy.

## Camera

Used only while you scan a Pocket Link QR code. The bundled scanner (ZXing) reads the code on the
phone. No picture is stored or sent. Sending pictures in a chat uses the photo picker, never the camera.

## Notifications and the lock screen

- With **Lock Automagik** off, notifications show what an agent asks or finished, so their text comes from your machines.
- **Answer from the lock screen** is off by default. While it's off, notifications are marked
  private, so Android hides their text on a secure lock screen, and replying or using the side-button panel asks you to unlock first. If you
  turn it on, anyone holding your locked phone can read and answer agents.
- Turn on **Settings → Alerts → Lock Automagik** to authenticate when the app starts and after
  60 seconds off screen. Alerts then show generic text. Open Automagik to answer, including
  through the side-button panel after unlocking the phone. Android hides app thumbnails in
  Recents, and on API 26–32 it also blocks screenshots and screen sharing. Android handles
  your fingerprint, face and screen lock. If you remove your screen lock, set one again to
  unlock Automagik. If you cannot set one, clear Automagik's storage and pair again. Clearing
  storage removes the app's local data. [RFC 0010](rfcs/0010-app-lock.md)

## Permissions

| Permission | Why |
|---|---|
| Internet | Connect to your machines, n0's Pocket Link relays and address lookup, and GitHub for updates |
| Notifications | Alert you when an agent needs you or finishes |
| Biometric (use fingerprint or face) | Ask Android to authenticate when you use the optional app lock |
| Foreground service (special use) | **Watch in background**: keep connections open while you're away, with a "Watching" notification you can stop |
| Run at startup | **Watch in background**: after the phone restarts and you unlock it, reconnect the machines it was watching, only if watching was on ([RFC 0007](rfcs/0007-watch-after-reboot.md)) |
| Microphone | Speak a message in the chat or terminal composer, or in the side-button panel |
| Camera | Scan the pairing QR code (added by the ZXing scanner library) |
| Install packages, update without asking again (GitHub APK only) | Install updates from GitHub releases; Android asks once |
| Network state | Check that the phone is online before dictation and the link; in the GitHub APK, download automatic updates only on Wi-Fi and other unmetered networks |

Picking pictures to send uses Android's photo picker (or the system file picker on phones without it),
which needs no permission: the app sees only what you pick.

## Children

The app is a developer tool and is not directed at children.

## Changes

Changes to this policy are made in this file, and its history is public in the repo.

## Contact

Open an issue on [GitHub](https://github.com/automagik-si/automagik/issues). For a
security problem, use private reporting as described in [SECURITY.md](../SECURITY.md).
