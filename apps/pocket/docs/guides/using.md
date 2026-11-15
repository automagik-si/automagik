---
title: "Using Automagik Pocket"
type: guide
created: 2026-11-01
updated: 2026-11-07
tags: [guide, users]
---
# Using Automagik Pocket

Everything the [README](../../README.md) keeps short. Install and first connection are there.

## Machines

- Pair several machines, rename them later, and connect with one tap from the start screen.
  Pairing a machine saves it and connects straight away.
- **Pocket Link:** the phone dials the desktop by its public key over iroh. The connection is
  direct on the same network or through hole punching, and otherwise through n0's public relays.
  It is end-to-end encrypted either way. No port is opened on the computer. Removing the phone in
  the desktop's Pocket Link dialog refuses its new connections; the bridge checks its list every
  2 seconds and then closes that phone's open sessions. Agents the phone started keep running on
  the computer. The QR scanner is bundled, so it works without Google Play services; the app asks
  for the camera the first time.
- **No SSH.** The app no longer connects over SSH ([RFC 0008](../rfcs/0008-drop-ssh.md)). A
  machine saved over SSH in an older version stays in **Settings → Machines**, greyed, with one button:
  **Pair with QR**. It opens the scanner; scan that computer's Pocket Link code and the old entry
  goes once it pairs. If that desktop wasn't paired yet, its new card takes the entry's place and
  keeps its core session; if it was, its existing card stays as it was. A cancelled or failed scan
  leaves the entry as it was. The phone can't tell whether the code is from the same computer, so
  scan the right one. Pairing from **Pair with Herdr desktop** leaves the old entry; remove it by
  hand. Once no SSH machine is left, the app deletes the SSH
  key older versions made.

## Tabs

The bottom bar has four tabs: **Home**, **Team**, **Code** and **Settings**
([decision](../decisions/four-tabs.md)). The app opens on Team. The bar hides while a terminal is
open, and Back from a terminal returns to the tab you opened it from. Back on any other tab goes to
Team.

- **Home** lists the agents that need you first, then the ones that finished, across every
  connected machine; **Everything else** shows the working and idle ones. The counts at the top are
  needs you, working, machines connected and, once a usage meter reports, spent today. Its tab
  shows how many requests need you, including ones waiting in a Bot chat. Tap the needs-you count or
  the **Review** bar to open the swipe deck: one card per waiting agent; swipe right for Yes, left
  for No, up to open its terminal. A request waiting in a Bot chat stays in the list and says
  "In chat" or "On computer", but it is not a deck card. Opening a card and coming Back returns to the deck. After the last
  answer, **All clear** says how many requests you answered, and **Back to Home** closes the deck. If
  Bot-chat requests still wait, the deck lists each one with an **Open chat** button instead of All clear.
- **Team** shows each project's bots with their pets. Its tab shows how many bots need you.
- **Code → By repository** has one card per git repository. Spaces in the same repository, like a
  squad's worktrees, share one card. A folder that isn't a repository is a project of its own. Tap
  a card for its tasks, spaces and agents.
- **Code → Spaces** is Herdr desktop's sidebar: spaces, their agents, git branch tails and
  nested worktrees, with the desktop's own program icons. Each project's bots sit under its first
  space as the desktop groups them: the main bot, then its categories, members under their lead.
  **Tasks** on top keeps only the agents working on a branch (not `main`, `master` or `dev`).
- Open an agent and its terminal fills the screen. **☰** opens the same tree as a drawer; the strip
  of names under the tabs, or a sideways swipe on the chat or on the terminal's bars, moves to the
  next or previous agent of the space.
- **Settings** starts with your machines, with **Pair with Herdr desktop**, then the display,
  alerts and About.
- Spend appears once the [usage meter](#spend) runs on a machine.
- Space names, tab order and splits come from the desktop's `herdr-app` document, including
  machines that a core forwards.
- Pull down on the list to refresh or retry. A dropped connection shows **Reconnect**.
- Tap **+** (**New terminal**) in the top bar to start a shell or a command. From a space, it opens
  as a new tab that the desktop shows too.
- Leaving a terminal or closing the app never stops the program on the computer.
- **Settings → About → Explore the interface with sample data** shows a labelled demo without a
  machine.

## Spend

The Automagik usage meter ([usagemeter](https://github.com/automagik-si/usagemeter)) counts the
tokens your coding agents use on each machine and publishes a small `herdr-meter` summary there.
The Automagik Herdr pack installs it; Pocket Link doesn't.
The app reads that summary from each machine you're connected to and sums it. It never writes it. With no meter on any machine,
**Code → By repository** shows one hint and no numbers.

- **Home:** **spent today**, from local midnight, across every reporting machine.
- **Code → By repository:** each repository's $ over the last 24 hours, plus its average $ per task, task count
  and active hours per task over 30 days. A chart shows today's $ by hour for all projects together,
  because the meter's hourly series isn't split by project.
- **A project:** pick **24h**, **7d** or **30d** to see its tasks, cost per task (untasked work
  excluded), $ spent with tokens and the share read from cache, active hours per task, and its
  tasks by spend, finished ones included.

What the numbers mean:

- Every $ is an **API-equivalent estimate at list price**, not an amount billed. The price
  table's date is in the footnote. A harness that reports its own $ (omp) counts as reported.
- **$ —** means the meter has tokens but no price for that model. Tokens still count.
- **≥ $x** is a lower bound. Either some tokens have no price, or some data is missing: the meter
  started counting inside the window, or it cut detail to keep its summary small.
- **—** means no reporting machine has usage for it.
- A task is a repository and branch. Work on a trunk branch, or with no branch, is untasked.
  **Active hours** count the hours with any usage, not wall-clock time.
- 24h, 7d and 30d end at each machine's last update.
- The line above the numbers names the machines that aren't counted: "2 of 3 machines reporting
  · build-box data 3 h old · no meter on laptop". A machine whose summary is from a newer meter
  than the app understands says **update the app or the meter**. Totals never drop a machine
  silently.

## Terminals

- An agent opens full screen. Tap **…** at the top right for navigation, tabs, the keyboard and the
  message composer. Android Back returns to the list.
- Scroll back to see history; new output doesn't move you. Tap **↓ Latest** to follow live output
  again. In full-screen programs, swipes scroll the program itself.
- **Keyboard button:** raw terminal input. **Chat button:** the composer. A composed message is
  kept as a draft until the core confirms the send, and it respects the core's protection for an
  agent that is waiting on a prompt. Answer interactive prompts with the keyboard and key row.
- **Key row:** Esc, sticky **Ctrl** and **Alt** (for the next key), Tab, Shift+Tab, arrows,
  Enter, Ctrl+C, Home/End, Page Up/Down, common symbols and Paste. Arrows and paging repeat while
  held. Cursor keys and paste follow the program's modes.
- Pinch with two fingers to change the text size, or set it in **Settings**. It's remembered.
- **Full color** (default) draws the terminal with a bundled, offline xterm.js. **Native text**, in
  Settings, draws the core's screen as plain text: no colours, up to 500 lines of shell history. The
  app switches to it on its own if the colour view fails.
- Web links in a terminal open in your browser.

## Chat

- On a Claude, Codex or omp terminal, tap **Chat** (in **…**, or in the bar under the terminal) to see
  the agent as a chat: its messages, tool calls (tap one to see its input or output) and status.
  **Show terminal** goes back. It needs a Pocket Link with the chat route; an older one says
  "Update Pocket Link on this computer for chat" and the terminal works as before.
- **Approvals** show **Allow** (and **Always allow** where the agent has it) and **Deny** only when
  the dialog is really open in the terminal; anything else says "Answer in the terminal".
- **Messages** you send are typed into the terminal. If the terminal has a half-typed message, yours
  waits with **Send now** (it sends your half-typed text with it) and **Cancel**; it also goes on its
  own once the input line is empty. A message the phone never heard back about shows **Maybe not
  sent** with **Retry**, which never types it twice.
- **Interrupt** stops the agent's turn, once, as Esc or Ctrl+C would.
- **Bot chats** (Settings → Machines, on a connected computer) lists the Automagik Bots' chats and
  says what the phone can do there: **Writable** when the bridge advertises phone writes (send,
  answer approvals and questions, interrupt), **Read only** with the reason when it does not.
- Chat text is plain text: HTML shows as the characters it is, nothing loads by itself, and a link
  opens only when you tap it and confirm. Rows stay in memory and are dropped when you leave the chat.

## Alerts

- **Needs you** and **Done** are Android notifications, one per agent, in the app too. The agent
  on screen only sounds when it needs you.
- Tap one to open the agent. It goes away once the agent is answered elsewhere, starts working
  again, or you open it.
- **Reply** types into the agent; the result shows in the notification.
- When an agent asks for permission, the notification has **Yes** and **No**, and **Always** between
  them when the prompt offers "don't ask again" (Claude Code, Codex). The text says what Always
  covers. With Always there, Reply makes room: tap the notification to type. Never a mode change
  such as auto mode or "allow all edits". When it asks a question, up to three of its answers. A
  button re-reads the agent first and presses keys only if the same question is still on screen;
  otherwise it says so and sends nothing.
- Above the terminal, the same permission shows **Yes**, **Always allow** and **No**.
- **Settings → Alerts:** sounds, Needs you and Done on or off, and **Answer from the lock screen**
  (off by default; see [privacy](../privacy.md)).

## Watch in background

- On by default. While a machine is connected, a "Watching N machines" notification keeps the
  connections open. **Stop** there disconnects.
- A dropped connection comes back on its own.
- After the phone restarts, the watch comes back once you unlock the phone, with the machines it
  was watching. Not if watching was off, and not after **Force
  stop** in Android's app settings: open the app once to start again. Some phones' battery
  settings (for example Samsung's sleeping apps) can keep it from starting.
- In the background the app checks for changes less often and skips git checks.

## Side-button assistant

1. **Settings → Alerts → Side button assistant → Set up**, and make Automagik the phone's digital
   assistant.
2. Hold the side button, or use the assistant gesture: a panel opens over any screen, the lock
   screen too, with the agents that need you, then finished ones, and a message box.
3. Type, or tap the microphone to speak.

With **Answer from the lock screen** off, the panel asks you to unlock first. If the side button
stops opening it, for example after reinstalling, set the assistant again.

## Updates

- The app looks for a new version when it opens (at most every 15 minutes) and every 6 hours while
  it or **Watch in background** runs. **Settings → About → Check for updates** looks now.
- **Install updates automatically** (Settings → About, on by default): on Android 12 and newer the
  new version downloads on Wi-Fi or another unmetered network, its SHA-256 is checked against the
  release, and Android installs it without asking.
- It never installs under you. While a terminal is open on screen it waits; on any other screen it
  waits until the app has been left untouched for 10 minutes. Leave the app or turn the screen off
  and it installs at once.
- Android closes the app to update it. A quiet notification in the **Updates** channel then says
  **Updated to X** with the release's first note, and Settings → About shows the same line.
- If **Watch in background** was holding connections, the new version reconnects those machines
  on its own, whether the update came from GitHub or Google Play.
- When Android won't install silently, a notification says **Automagik X is ready**, once per
  version. Tap **Install** to open Settings and Android's confirm prompt. This happens on Android
  11 and older, on a phone plan, with the switch off, until Automagik may install apps (the first
  tap asks), and when Android asks to confirm (for example when another app store owns the app's
  updates).

## Limits in detail

- The Pocket Link bridge runs as a LaunchAgent on macOS or a systemd user service on Linux.
- Connections live in the app; with Watch in background they stay open in a foreground service.
  After an update or a phone restart they come back on their own. After Android stops the
  service or the app is force-stopped, open the app and connect again.
- Only computers running Herdr desktop with the Pocket Link mod can be reached; there is no SSH.
- The app reads the desktop's layout. It doesn't edit, rename or delete it, and doesn't run
  desktop mods.
- Kitty images and Windows win32-input-mode aren't supported.
- herdr-core gives the last active viewer control of a terminal's size, so opening it on the phone
  can resize it on the desktop.
- The phone's keys are in app storage that is never backed up. There's no key backup.
