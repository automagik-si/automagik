---
title: "Four tabs: Home, Team, Code, Settings"
type: decision
status: Implemented
created: 2026-11-07
updated: 2026-11-10
pr: "automagik-dev/automagik#664"
tags: [decisions, navigation, teams, home]
---
# Four tabs: Home, Team, Code, Settings

The bottom bar has four tabs, Home, Team, Code and Settings, and the app opens on Team. They
replace the five tabs and the Settings gear, and this note replaces [Teams v1](teams-v1.md)'s tab
list, its needs-you deck and its progress strip. The deck returns on Home (below); its Team
placement and the progress strip do not.

## Decision

- Owner, 2026-11-07 (relayed by t3q1, wish `pocket-four-tabs`, decision D3): the phone has four
  tabs. Team is the default; Home is the needs-you cockpit, with spend as a chip.
- Owner, 2026-11-07 (relayed by the Mobile Captain): this step changes the structure only. The
  bar keeps its current look; no mobile UX guidance is applied until the owner names the guidance.
- Owner, 2026-11-10 (picked from the 10 Nov UX gap review, gap A): the swipe-to-answer deck
  returns, on **Home**. It reads Home's own Needs you list, the list its count tiles and cards
  use, not the Team bubbles. It opens from the needs-you count tile and the **Review** bar. A row
  with a Bot chat and no terminal gets an "Open chat" card in this first cut. Answers go through
  the same path as the terminal's answer buttons.
- What moved, so nothing is lost:

  | Before | Now |
  |---|---|
  | Today | **Home**, unchanged: Needs you, then Done, with Working and Idle under **Everything else**; the counts and the spend tile on top; the needs-you badge |
  | Teams | **Team**, one bubble per project ([Team bubbles](team-bubbles.md)), still the default and where Back goes |
  | Projects, Tasks | **Code**: Spaces (the desktop's tree, Tasks as a filter) and By repository |
  | Machines, the gear | **Settings**, with the machines and pairing first |

- Replaces in [Teams v1](teams-v1.md):
  - its tab list (five tabs plus a gear);
  - the needs-you deck and the progress strip on Teams. Home takes needs-you;
    [Team bubbles](team-bubbles.md) removed them from Team.

## Current state

- Tabs, the default and Back: `android/app/src/main/java/ai/namastex/automagik/Nav.kt`
  (`TABS`, `HOME = TEAM`, `back`, `barShown`, `badge`). Tested in `NavTest`.
- The bar: `PocketTabs`, `android/app/src/main/java/ai/namastex/automagik/MainActivity.kt:277`.
  Home carries the agents that need you (Today's badge), Team the bots that need you.
- Home is `OverviewScreen` with no space (`MainActivity.kt:404`), the spend tile `SpendCount`
  (`MainActivity.kt:450`). `ProjectsTest.homeShowsTodaysCountsAndCarriesItsBadge` checks its counts.
- Home's needs-you deck (`DeckScreen.kt:76`): one card per entry of Home's own Needs you list, the
  list its count tile, badge and cards use (`Teams.deckCards`, `Teams.kt:355`). Right is Yes, left is
  No, up opens the terminal; the same three buttons sit under the card, with the YES/NO stamps as the
  card leans. The header counts the cards left. Only terminal entries become cards: every chat row
  (`c.chat != null`, `Teams.deckAnswerable`, `Teams.kt:412`) stays out. `Teams.deckView` (`Teams.kt:378`) and `Teams.swipe` (`Teams.kt:433`) hold the end state
  and the gesture rule; `Teams.deckAfterSelection` (`Teams.kt:425`) keeps the deck through a card's
  Back and closes it for any other selection. Home's needs-you count and badge use
  `Projects.Pulse.homeNeedsYou`, every blocked row; chat rows stay listed with "In chat" or
  "On computer" but are not deck cards. When no terminal card is left, the deck lists them with an
  **Open chat** button instead of All clear.
  `PocketApp` owns the open state
  (`MainActivity.kt:128`), and Home's needs-you count tile and **Review** bar open it
  (`MainActivity.kt:444`, `:473`), so a later "Answer all" button opens the same screen. A card's
  terminal keeps the deck's answers on the way Back, and a disconnected machine's requests
  show the offline end. The last answer shows All clear ("You answered N requests. Your bots are
  back to work."), the bot hops once, and **Back to Home** closes the deck.
  Tested in `TeamsTest` and `HomeChatsTest`.
- Code (wish group 3), the desktop's Herdr window made mobile:
  - The spaces and bots tree (`Sidebar.rows`, drawn by `sidebarRows`) places each project's bots under
    its first space, grouped as the desktop groups them: the main bot, then categories in
    `bots.json` order, each one's bots by rank, members under their lead (`BotTree`, a port of
    am-sidebar `rows.js` `buildTree`). A bot's pane is not listed again as a plain agent.
  - It is Code's Spaces view and the terminal's drawer (the menu button), both `SpacesTree` in
    `ProjectScreens.kt`. Its Tasks pill (`Sidebar.only`) keeps the agents on a task branch: the
    Tasks view is gone.
  - The terminal is the main view, with its Chat tab and Show terminal. The agent strip lists the
    space's agents in the tree's order (`Sidebar.strip`), and a sideways swipe on the chat or on the
    terminal's bars goes to the next or previous one in the space (`Sidebar.neighbour`).
  - Tested in `CodeTreeTest`, against the desktop's own recorded fixture
    (`herdr/test/fixtures/sidebar/owner-2026-11-02.json` and its golden).
- Settings: `SettingsScreen` starts with `MachinesSection`
  (`android/app/src/main/java/ai/namastex/automagik/Screens.kt:92`, `:162`). **+** in its top bar
  pairs a machine.

## Open questions

1. Which mobile UX guidance applies to the bar and the tabs (targets, safe areas, the keyboard)?
   — the owner.
2. Swiping on the terminal's own screen (not only its bars) would need the terminal view to give
   up horizontal drags; left out until the UX guidance says how it should feel. — the owner.

## Related

- [Teams v1](teams-v1.md), the tab list this replaces.
- [Using Automagik Pocket](../guides/using.md), "Tabs".
