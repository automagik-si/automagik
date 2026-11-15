# Automagik RFCs

An RFC here is a short design for one open decision surface: something that needs a decision
before code, sets a public contract, or adds a trust boundary. Work that is already scoped as an
issue ships as a plain fix and needs no RFC.

## Status values

| Status | Meaning |
|---|---|
| Queued | Written, not yet in delivery. Its open questions wait for the owner. |
| Accepted | Scheduled by the owner, with no delivery merged yet. Its deliveries are filed in milestone order. |
| In delivery | Accepted, with some deliveries merged and the rest still open. A question left open is answered before the delivery it blocks. |
| Delivered | Every delivery merged. The RFC is kept as the record of the design. |
| Proposal-only | A proposal to another project; nothing ships in this repository. |
| Parked | Not scheduled. It keeps its number and can be picked up again. |
| Superseded | Replaced by a later RFC or owner decision, named in its Status. Kept as the record. |

## Process

1. An RFC lands as docs only. Every commit in the PR is typed `docs(rfcs): ...`, so the merge
   cuts no release (see [0001](0001-roadmap-and-milestones.md)).
2. The owner schedules it and answers the questions that block it. The RFC moves to Accepted,
   and to In delivery when its first delivery merges.
3. Each delivery becomes one issue under an outcome-named milestone, and one PR that closes it.
   A delivery is small, complete for users at merge (or hidden behind a setting), and on one
   release lane: plugin-only (3.N.P) or desktop (3.N). A PR never mixes the two.
4. When the last delivery merges, the RFC moves to Delivered.

Security gaps are named by title only until their fix merges. Details go to a private advisory.

## Index

| # | Title | Status | Milestone |
|---|---|---|---|
| [0001](0001-roadmap-and-milestones.md) | Roadmap and milestones | In delivery (delivery 3 only: `docs/` never ships; deliveries 1 and 2 not done) | n/a (process) |
| [0002](0002-browser-group-1-completion.md) | Browser Group 1 completion | Accepted (unverified: no delivery PR found; #103, #121 and #127 predate the RFC) | 1. Safe browser and everyday fixes |
| [0003](0003-model-routes-and-acp.md) | Model routes and ACP | In delivery (deliveries 1-4, 6 and 7: #187, #189, #537, #557, #558, #559, #563, #569, #585, #594; 5 open; amended 2026-11-06: DSH's tool set on ACP routes and live switching; 2026-11-08: required desktop CLIs, replay independent of the bridge; 2026-11-09: Bots switching onto and off agents, sign-in from the Bot's chat, one sign-in per subscription and a menu of what is set up; research: [ACP tools spike](../research/acp-dsh-tools-spike.md), [council note](../research/dsh-022-council.md); 2026-11-10: delivery 7's replay at a harness change to be replaced by [0030](0030-code-mode-in-the-app.md)'s handoff note) | 2 (route descriptor), 3. Other agents in the same chat |
| [0004](0004-composer-chat-kinds.md) | Composer and chat kinds | Accepted (unverified: no delivery PR found; only #187, the picker's prerequisite, merged) | 2. One message box |
| [0005](0005-workspace-and-genie-projects.md) | Workspace and Genie projects | Queued (no delivery PR found) | 4. Projects in one place (Publish not scheduled) |
| [0006](0006-herdr-terminal-mode.md) | Herdr terminal mode | Superseded (D27: herdr-app as the code window, RFC 0013; its Workers section, a herdr subagents provider for DSH, is replaced by [0028](0028-code-workers.md), Draft) | not scheduled |
| [0007](0007-desktop-speed.md) | Desktop speed | In delivery (delivery 2: #184; delivery 4 in part: #179; slices 1, 3, 5 and 6 not found) | 1 (marks, stable port), 5. The app opens fast |
| [0008](0008-platform-and-web-instances.md) | Platform and web instances | Queued (amended 2026-11-09 by [0024](0024-automagik-cloud.md), #866: web sign-in, the desktop client, questions 2, 6, 7 and the threat model) | not scheduled |
| [0009](0009-personal-customization.md) | Personal customization | Queued (no delivery PR found) | after 2 (proposed: Make it yours) |
| [0010](0010-desktop-sandbox.md) | Desktop sandbox and supervision | Queued (answers: D19; question 2 open; only the RFC: #188) | not scheduled |
| [0011](0011-monorepo-parts-and-releases.md) | Monorepo parts and releases | Accepted (process in use; delivery unverified: open work #207 and #215; #250 Play flavor deferred to Pocket; #190, #203 and #210 merged 2026-11-03; the owner OKd one version and the jump) | n/a (process) |
| [0012](0012-am-cli-and-parts.md) | am, one CLI and parts | In delivery (deliveries 1-2: #254, #258, #263; 3-10 not found; answers: D35) | none (ships outside the five milestones) |
| [0013](0013-work-code-switch.md) | The work and code switch | In delivery (deliveries 1-6: #211, #237, #238, #259, #265, #272; 7 (one install) and 8 (shared Bots) open; D27 replaced 2026-11-10 by [0030](0030-code-mode-in-the-app.md), Queued) | none (ships outside the five milestones) |
| [0014](0014-shared-bot-registry.md) | Shared Bot registry | In delivery (delivery 1: #260; universal-Bot amendment: #666, #670, #674, #684; 2-9 unconfirmed) | none (ships outside the five milestones) |
| [0015](0015-live-chat-projection.md) | Live chat projection | In delivery (deliveries 1-5: #267, #273, #280, #282, #286, #574; later work: #523, #655, #670, #675, #680; 6-8 unconfirmed; amended 2026-11-07: writes on DSH chats, global Bots included) | none (ships outside the five milestones) |
| [0016](0016-windows-wslc.md) | Windows on a Linux sandbox (WSL containers) | In delivery (delivery 2: #349; the Windows build turned off by #284; 3-6 open; accepted 2026-11-04, by the owner; answers: D38, D39, Q1-Q9) | not scheduled |
| [0017](0017-usagemeter-crate.md) | usagemeter in the monorepo | In delivery (deliveries 1, 2, 4, 5 and 6: #751, #783, #822, #834, #836, #838; deliveries 3, 7, 8 and 9 open; answers: Q1-Q6 and Q8, 2026-11-08; question 7 open) | none (ships outside the five milestones) |
| [0018](0018-meter-query-contract.md) | The meter query contract | In delivery (M0-M1: #764, #806, #814; M2, M4 and M5 not merged; M3's evidence table landed with RFC 0021's #875) | none (ships outside the five milestones) |
| [0019](0019-gitlab-mirror.md) | The GitLab mirror | Queued (answers: 1-11, 2026-11-09; GitLab canonical, the switch gated on G1-G8; only the RFC: #791; deliveries 0-1 unverified) | none (ships outside the five milestones) |
| [0020](0020-unfold-plugins-leave.md) | Unfold plugins leave Automagik | Delivered (2026-11-09: #790; hand-over #780, commit d0453789; Unfold's prerelease unfold-dsh-v3.108.7, weunfold/unfold#3; removal #854, commit 14b8fc50; answers: Q1-Q5, 2026-11-09; no question open) | none (ships outside the five milestones) |
| [0021](0021-meter-attribution.md) | Meter attribution | In delivery (deliveries 1-6: #817, #825, #827, #835, #875; #849 closed, carried by #875; delivery 7 (reaching machines) met on one machine, accepted by the owner 2026-11-12, #1115; 8 open until #1126 explains and repairs the backfill's rollup total change (reported in #1114; cause fixed by #1127); Q1-Q6 answered by Chat 2026-11-09, Decided 5 and 6 reopened by the owner 2026-11-10; amended by [0026](0026-bot-tag-coverage.md): Decided 5 and 6) | none (ships outside the five milestones) |
| [0022](0022-desktop-chat-view.md) | The desktop chat is a view of the main bot | Queued (answers: Q1-Q8, 2026-11-09; Q2 by the owner, the rest by Chat, Q6 re-decided and Decided 9 (H before phase 1) after review; only the RFC: #847; amended by RFC 0028 (Draft): Code workers on a host-side grant beside delivery H, the rejection kept; revised 2026-11-10: Team and Code, the left bar, humanized bots, before #631, the owner's instance, Proposed (owner not yet read), Q9-Q17 open; amends 0024 (f)) | none (ships outside the five milestones) |
| [0023](0023-dsh-upstream-agent-context-and-chat-rows.md) | DSH upstream: agent context, a chat tail slot, a draft hook and a session terminal field | Proposal-only (a proposal to DSH; nothing ships here) | none (a proposal to DSH; nothing ships here) |
| [0024](0024-automagik-cloud.md) | Automagik Cloud: two identity models, workspaces and the rail | Accepted (2026-11-10, by the owner; council 2026-11-09: proceed with conditions, folded in; owner's answers: identity and billing, 2026-11-09; isolation, identity stand-up, hosting, the goal and Q18, 2026-11-10; Chat: Decided 19-25, 2026-11-09; amended by [0025](0025-cloud-economics.md): Q8, D14, (g); (f)'s machine-link rule: amendment proposed by [0022](0022-desktop-chat-view.md)'s (l), Q17, 2026-11-10; Invitations by project accepted by the owner, 2026-11-12, Decided 27) | none (ships outside the five milestones) |
| [0025](0025-cloud-economics.md) | Automagik Cloud economics: billing, managed tokens and agentic payments | Accepted (2026-11-10, by the owner; council 2026-11-09: revise, conditions folded in; owner's decisions 2026-11-09; Chat: legal review scope, 2026-11-09; amends RFC 0024) | none (ships outside the five milestones) |
| [0026](0026-bot-tag-coverage.md) | Bot-tag coverage | Queued (amends RFC 0021: Decided 5 and 6) | none (ships outside the five milestones) |
| [0027](0027-automagik-site-and-readme.md) | README, launch film and automagik.si | Accepted (2026-11-10, by the owner: the story, the site base and the 2026-11-16 deadline; Q1-Q4 answered 2026-11-10, Q5 open; D1-D4 and D3b open; M1/M2 folded) | none (ships outside the five milestones) |
| [0028](0028-code-workers.md) | Code workers: a DSH Bot delegates to agents in Herdr | Proposed (owner not yet read; owner's direction 2026-11-10: keep RFC 0022's view, and let any DSH Bot delegate under a scoped grant; replaces 0006's Workers section; amends 0022) | none (ships outside the five milestones) |
| [0029](0029-pr-reviewer-bot.md) | The PR Reviewer bot | Proposed (owner not yet read; answers: Q1-Q8, 2026-11-10, by the owner, #1010: one GitHub App, Automagik Genie, reviews and makes the release pushes; the owner can bypass; the Tester is renamed the Dogfooder; Q9 open) | none (ships outside the five milestones) |
| [0030](0030-code-mode-in-the-app.md) | Code mode inside the Automagik app | Proposed (owner not yet read; owner's direction 2026-11-10, #1007: the app draws the coding team and its herdr-core terminals, the pack's mods become DSH plugins; replaces 0013's D27; amends 0003's live switching at a harness change; Decided 10, the selector's route, 2026-11-10; Q1-Q14 open) | none (ships outside the five milestones) |
| [0031](0031-auto-permission-level.md) | Auto, a permission level where a model decides each step | Queued (amends RFC 0003 with its delivery 2; numbers 0028 to 0030 are taken by open pull requests) | none (ships outside the five milestones) |
| [0032](0032-automagik-id.md) | Automagik ID | In delivery (delivery 1 authorized by the owner; replaces RFC 0024's identity-provider sections) | none (independent Worker deployment) |
| [0033](0033-attachments-from-pocket.md) | Attachments from Pocket | Queued (amends RFC 0015's chat route: attachments; owner not yet read) | none (ships outside the five milestones) |

Milestones, in the owner's order:

1. Safe browser and everyday fixes
2. One message box
3. Other agents in the same chat
4. Projects in one place
5. The app opens fast

Personal customization (0009) is scheduled after milestone 2; it stays Queued until then. Every
other RFC follows the state in its row above, and an open question is answered before the
delivery it blocks.
Milestones and one issue per delivery are created after the PR that lands these RFCs merges.

### Fixes without an RFC

These ship as plain issue fixes in milestone 1, "Safe browser and everyday fixes".

| Issue | Fix |
|---|---|
| #120 | Task workers start at the Bot's level (see below). |
| #88, #91 | The composer's two-row layout and the queue dock overlap. 0004 builds on it. |
| #153 | The model dock crash. It ships before 0004's picker slice. |
| #141 | Drafts lost when the localhost origin changes. 0007's stable port (#184) keeps the origin when the port is free; the issue stays open for a composer store that does not depend on the origin. |

**Task workers start at the Bot's level (#120).** Today a task session starts at a fixed level,
not at its Bot's. The fix starts a worker or a wish at `min(requested level, Bot's level)`. A
caller can lower the level but never raise it. A worker never starts at Full access unless the
owner chose Full access for that Bot. When a level that never asks rejects an approval on its
own, the owner sees a notice; it is not dropped silently. If the Genie plugin passes its own
level when it starts a task, the matching change in the Genie repository is tracked by a linking
issue (see 0001).

## Template

Copy this into `NNNN-short-name.md`. Keep it to about 60-150 lines.

```markdown
# RFC NNNN: Title

| Field | Value |
|---|---|
| Status | Queued |
| Milestone | outcome name |
| Lanes | plugin (3.N.P), desktop (3.N) |
| Created | YYYY-MM-DD |

## Summary
Two to four sentences: what changes for users, and what it decides.

## Motivation
The problem, who has it, and the issues it links.

## Design
What is built. Plain sentences, no code dumps.

## Contracts introduced
Every public id, route, path and storage key this RFC creates or changes.
For each one, the compatibility rule for existing installs.

## Threat model
Required when the RFC adds a trust boundary. Who can reach it, what it can do,
how it is authenticated, and how to undo it.

## Deliveries
Numbered slices. Each one says:
- release lane: plugin-only (3.N.P) or desktop (3.N);
- acceptance check: the one test or observation that proves it;
- rollback: what reverting the release does, and what it cannot undo.

## Open questions
Each question with a recommended answer.

## Links
Issues, PRs and other RFCs.
```
