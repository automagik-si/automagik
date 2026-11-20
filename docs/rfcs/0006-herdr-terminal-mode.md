# RFC 0006: Herdr terminal mode

| Field | Value |
|---|---|
| Status | Superseded (D27: herdr-app as the code window, RFC 0013; its Workers section, a herdr subagents provider for DSH, is replaced by [RFC 0028](0028-code-workers.md), Accepted 2026-11-19) |
| Milestone | not scheduled |
| Lanes | plugin (3.N.P), desktop (3.N) for the pinned binary |
| Created | 2026-10-30 |

## Summary

A chat kind that is a full terminal, with no HTML message box. A Bot can run as a terminal: its
agent command line runs in a Herdr terminal. Each such Bot gets a mirrored space in Herdr's app,
named after it, in the same folder. Task workers can run as Herdr terminals through DSH's
subagents seam. It is off by default and starts as a read-only prototype.

## Motivation

Some people prefer to work in a terminal. Herdr's core (`hc`) keeps terminals alive across
window closes and restarts, and Herdr's app shows them natively. Running a Bot's agent there
gives a terminal that survives the app, and the same session is visible in both places.

## Design

### The chat kind

- Kind `herdr`, with no input box (RFC 0004). The chat area is a terminal view attached to the
  Bot's Herdr terminal. Typing goes to the terminal, not to a DSH turn.
- The Bot's DSH Session stays: its sidebar row, tasks and history. The terminal is its view.
- The view observes by default. Taking control is an explicit click. Clipboard writes from the
  terminal are blocked, and paste asks first.

### Mirrored spaces

- Herdr's app keeps its layout in a core document. Automagik writes its own spaces there.
- Each Bot on Herdr gets one space, named after the Bot, in the Bot's folder. It has a
  "<Bot> · main" tab and one tab for each of the Bot's other chats.
- Automagik's space ids carry a fixed prefix. Spaces without the prefix belong to the user and
  are never read for writing, changed or removed.
- Every write is versioned. On a version conflict Automagik re-reads, reapplies its own spaces
  once, and stops with a visible error if it conflicts again.
- Terminals Automagik creates carry labels with the Bot id, and Automagik acts only on
  terminals with its labels.

### Workers

- A DSH subagents provider named `herdr`. A task worker runs as a Herdr terminal with a native
  subagent card and cancellation.
- Turn ends come from the program's own status reports, not from reading the screen.
- Core notes typed into a parent terminal are turned off for Automagik's terminals.

### The binary

- A pinned `hc` binary ships in the desktop runtime, checked against its published SHA-256 sums.
  Self-update is off for it.
- If the user's own core runs a compatible version, Automagik connects to it so the spaces show
  in their app. Automagik never stops, restarts or updates the user's core.
- Otherwise Automagik starts its own core session from the pinned binary, and mirrored spaces
  are skipped.

## Contracts introduced

- Kind id `herdr` (RFC 0004).
- Space id prefix `automagik:` and terminal label `automagik.bot=<botId>` in the user's core.
  Compatibility: new. Removing the feature removes only prefixed spaces and labelled terminals.
- Subagents provider id `herdr`.
- Plugin id `@automagik/herdr-dsh`, storage prefix `herdr-dsh`, if the open question below
  picks a separate plugin.

## Threat model

- **Who can reach it.** Herdr's core has no API authentication. Any process running as the user
  that can open its socket can run commands, read files and control terminals. Every same-user
  process is already inside that boundary.
- **The relay.** The browser never touches the socket. The plugin's host side talks to the core
  and relays terminal bytes over DSH's authenticated plugin routes. The socket is never
  forwarded or exposed on a port.
- **Web instances.** The relay is off on web instances until web sign-in (RFC 0008) ships and
  is reviewed. A terminal relay there would be a shell on the network.
- **Levels.** Any terminal action that runs a command or changes files goes through the Bot's
  level.
- **The user's spaces.** Writes touch only prefixed spaces, with versioned writes.
- **Supply chain.** The binary is pinned by version and SHA-256, with a review per bump.
- **Undo.** Off by default. Turning it off detaches views, removes prefixed spaces and leaves
  the user's own spaces and terminals alone.

## Deliveries

1. **Read-only prototype.** Observe a labelled terminal in a view beside Chat. Lane: plugin,
   hidden behind a setting that is off. Check: the view attaches, resizes and reattaches after a
   DSH restart; no write reaches the core. Rollback: revert.
2. **Pinned binary.** Lane: desktop. Check: the build fails on a hash mismatch. Rollback: the
   next release drops it.
3. **Herdr chat kind with control.** Lane: plugin. Check: a Bot's agent runs in its terminal,
   and a command needing approval at the Bot's level asks first. Rollback: revert; terminals keep
   running in the core.
4. **Mirrored spaces.** Lane: plugin. Check: a space per Bot appears in Herdr's app; a user
   space edited at the same time is unchanged. Rollback: revert, then prefixed spaces are removed.
5. **Workers as a subagents provider.** Lane: plugin. Check: a worker runs as a terminal, ends
   with a status report and is cancellable from its card. Rollback: revert; workers use DSH's
   default provider.

## Open questions

1. **Pin a 0.1.x core at all?** Herdr's core is new and labelled preview. Recommended: build the
   read-only prototype now; ship nothing beyond it until the protocol has held for about a month
   or reached 0.2.
2. **Separate plugin or inside the Bot team?** Recommended: a separate plugin, so it stays off
   by default, carries its own terminal bundle and does not grow the Bot team's `client.js`.
3. **No Herdr app on the machine.** Recommended: workers and the chat kind still work on
   Automagik's own core session; mirrored spaces need the user's core and are skipped.
4. **Who reviews a binary bump?** Recommended: the same review as any pinned add-on.

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: #250.
- Merged changes that cite this RFC: none yet.

## Links

- [0004](0004-composer-chat-kinds.md) chat kinds, [0003](0003-model-routes-and-acp.md) routes,
  [0008](0008-platform-and-web-instances.md) web sign-in
