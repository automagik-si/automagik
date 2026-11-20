# RFC 0002: Browser Group 1 completion

| Field | Value |
|---|---|
| Status | In delivery (delivery 1 (3a): #1190, with #1230, #1501 and #1737; delivery 3 (3c), cookie storage: the browser keeps the sign-ins and Automagik's `cookies.json` is deleted; delivery 2 (3b) split on 2026-11-20 by the owner's delegate: 2a, browser navigation and request policy on launched Chrome, and 2b, the remaining hosts and cases, open; delivery 4 (3d) open; #103, #121 and #127 predate the RFC) |
| Milestone | 1. Safe browser and everyday fixes |
| Lanes | plugin (3.N.P) |
| Created | 2026-10-30 |

## Summary

Group 1 gives each Bot a browser built into the app. Two of its three parts have shipped: the
in-app browser (#121) and the agent cursor (#127). This RFC splits the third part into four
small slices, 3a to 3d. Each one carries its own decisive test. Slice 3a goes first because it
closes a security gap.

## Motivation

The third part was planned as one PR covering a host, a policy, a storage change and a script
sandbox. That is too large to review or revert. Every merge to `dev` is a release, so a release
must never contain half of a security change. Each slice below is safe on its own.

## Design

### 3a. Script worker that keeps the approval gate

- The `script` backend (tool `browser_exec`) runs its body in a fresh context inside a worker
  thread. No host object enters the context. Helpers send their calls to the host as messages.
- The worker has a hard time limit. The host terminates it at the limit, whatever the script
  is doing.
- The approval gate is handed to every helper call explicitly. A gated action (post, upload,
  download, delete) asks through today's card.
- With no gate in scope, a gated action is refused. The gate fails closed.
- The worker move and the gate hand-off ship in the same PR. No release may contain one
  without the other.

### 3b. Navigation and request policy

- Non-web schemes, and Automagik's own local server, are refused in every mode.
- The refusal also covers frames and workers that a page starts.
- Inside a run that may submit without asking, loopback and private hosts are refused for the
  whole run. Outside such runs, a Bot keeps today's reach to a project's local dev server.
- The policy lives in the plugin and works the same on both hosts (the app and launched Chrome).

### 3c. Cookie storage

- Sign-ins live only in the browser's own storage: the per-Bot partition in the app, or the
  profile folder for launched Chrome. Automagik keeps no cookie file of its own.
- Automagik does not change any cookie's lifetime.
- On first open after the update, an old `cookies.json` is deleted. A site that keeps its
  sign-in only in a session cookie asks the user to sign in again once. The release notes say so.
- Deleting a Bot deletes its browser data and its run traces. Trace files get a size and age cap.

### 3d. Launched-Chrome host

- With no app bridge (the DSH command line, a headless Linux host, or the app closed), the same
  executor drives a Chrome it launches on the Bot's profile folder.
- The same policy, gates and restore rules apply as in the app.

## Contracts introduced

- Tool `browser_exec` and plugin id `script` keep their names. Existing Bots keep working.
- Per-Bot browser data stays under the team's home, `browser-profiles/<botId>`. No path moves.
- `cookies.json` is removed. Compatibility: a one-time sign-in loss for session-cookie sites;
  persistent sign-ins carry over through the browser's own storage.
- Run traces: one file per run, under the team's home, capped in size and age.

## Deliveries

1. **3a, script worker and gate.** Lane: plugin. Check: one test where a helper inside the
   worker attempts a post and reaches the approval card; with the card rejected, nothing is
   sent. The same test covers a script that tries to reach host objects and a script that never
   yields; both are stopped and the host keeps answering. Rollback: revert restores the previous
   backend; no data changes.
2. **3b, navigation and request policy.** Lane: plugin. Check: one test that a non-web scheme
   and the local server are refused from a page, a cross-origin frame and a worker, and that a
   local dev server still opens outside a run. Rollback: revert; no data changes.
   Amended 2026-11-20 (approved by the owner's delegate): split in two. **2a.** Browser
   navigation and request policy on launched Chrome: the check above on that host. **2b.**
   Browser navigation and request policy, the remaining hosts and cases, including the run
   rule. 2b keeps this delivery's check and rollback.
3. **3c, cookie storage.** Lane: plugin. Check: after first open no cookie file exists, a
   persistent sign-in survives a restart, and deleting a Bot removes its folders. Rollback: the
   deleted file does not come back; affected users sign in again.
4. **3d, launched-Chrome host.** Lane: plugin. Check: a smoke run on a headless Linux host
   opens a page, survives a killed browser and restores the Bot's tabs. Rollback: revert; the
   app host is unaffected.

Order: 3a, then 3b, 3c and 3d. No other browser feature work merges before 3a.

## Open questions

1. **One submit, two possible cards.** Inside a run, a labelled submit can be checked at the
   click and again as a request. Which one asks? Recommended: inside a run the request-level
   check is the only one that asks; the click-level check defers to it. On the run's approved
   site, a same-site submit in a free run raises no card. Outside runs, today's click check stays.
2. **Owner decisions for a Bot whose level never asks.** A Bot at Full access never sees
   approval cards, so a site approval or a repair candidate would be rejected with no owner
   input. Recommended: these are owner decisions, not tool approvals. They always go to
   Automagik's own owner surfaces (the Bot's page or the group card), whatever the Bot's level.
   Any automatic rejection shows the owner a notice.
3. **Should 3c ride with 3a?** Recommended: no. Keep it a separate slice, merged right after 3a,
   so each has its own test and rollback.
4. **Trace caps.** Recommended: keep the last 50 runs or 30 days per Bot, whichever is smaller.

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: none.
- Merged changes that cite this RFC: #203 (last merged 2026-11-03).

## Links

- #121 in-app browser, #127 agent cursor
- #136 approvals UX (owner surfaces for approvals)
- [0001](0001-roadmap-and-milestones.md) for the title-only rule on security gaps
