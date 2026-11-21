# RFC 0029: The PR Reviewer bot

| Field | Value |
|---|---|
| Status | In delivery (delivery 2 merged: ci.yml's merge_group trigger and the CI result job; delivery 3 in part: the merge rules as code (.github/pr-reviewer.json, scripts/pr-reviewer/rules.ts), the bot itself waits on delivery 1's App; delivery 1 waits on the owner registering the App and the release environment; the rest of 3 and 4-6 open; amendment of 2026-11-20 approved by the owner's delegate on 2026-11-20 (#991): the parts of D3, D4 and D5 that need neither the App nor the ruleset split off as D3a, D3b, D4a and D5a, with points D1 and D5 must also cover; approved by the owner's delegate on 2026-11-19; answers: Q1-Q8, 2026-11-10, by the owner, PR #1010; Q9, 2026-11-19, by the owner's delegate, the RFC's recommended option; Q10-Q12, 2026-11-20, by the owner's delegate, option (a) each: a separate proof repository, a 30-day public-read token for the dry run, the ruleset as a disabled template; no question open) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none (docs here; every delivery is under `.github/`, `scripts/` or top-level `*.md` such as `AGENTS.md`, which never ship, so none cuts a release) |
| Created | 2026-11-10 |

## Summary

Every pull request against `dev` is reviewed by one bot as soon as it opens, re-reviewed on every
push and every answer, and merged by GitHub's merge queue when the bot approves. The author never
merges, and the repository refuses a merge without the bot's pass from anyone but the owner. This
RFC decides how that holds: the bot speaks through one GitHub App, Automagik Genie, which can
approve the PRs the `automagik-genie` user account opens and post a check no other account can
forge, and which also makes the release's pushes; a new ruleset on `dev` requires that check and
the merge queue, with only the App and the owner on its bypass list; merges stay serial and wait
for the previous release run to finish green; billing-path PRs and held PRs are reviewed but
never merged without the owner. It also places today's Reviewer, Tester (now the Dogfooder),
Fixer and Integrator lanes behind the bot, fixes the verdict format, and says what happens when
the bot is down.

The RFC is docs only. It creates no App, changes no ruleset and edits no workflow.

## Two names that look alike

Both carry the Genie's name; they are different GitHub identities, and this RFC always says which.

- **The App**: the GitHub App named **Automagik Genie**. On GitHub it acts as
  **`automagik-genie[bot]`** (the `[bot]` suffix is how GitHub shows an App). It reviews,
  approves, posts the `pr-reviewer` check and makes the release's pushes. It is new.
- **The user account**: **`automagik-genie`**, the existing machine user (no `[bot]`). The team's
  bots open their PRs under it. It never approves and is on no bypass list.

## Motivation

On 2026-11-10 five PRs (#961, #962, #965, #967, #972) were merged into `dev` by their author with
no review, and each started a release run (`.github/workflows/release.yml` starts one on every
push to `dev`; #962's failed). Nothing in the repository stops that today:

- **`dev` has no review rule.** Its only ruleset, "dev and main: no force push or deletion",
  forbids force pushes and deletion and nothing else; branch protection is not set. Any account
  with write access can merge any PR, green or not.
- **Serial merging is a habit, not a rule.** The team waits for the previous release run before
  the next merge (a merge during a cut makes that cut lose its push, #668, still open), and checks
  that a PR's CI postdates the last `dev` merge in the same part. Both live in a helper outside the
  repository and in people's memory. `ci.yml` runs with `cancel-in-progress: true` on the group
  `ci-${{ github.ref }}`, so two merges seconds apart cancel the first one's `dev` CI: on
  2026-11-10 three of eight `dev` CI runs in under an hour were cancelled that way.
- **Review is a relay.** A Reviewer and a Tester seat give verdicts, the Orchestrator merges, the
  Integrator watches releases and re-runs CI. A team member who is not a bot has to know all of
  that to land a change. The owner's words: no contributor should have to merge their own work.

## Decided by the owner, 2026-11-10 (#991)

1. One event-driven PR Reviewer bot. On every PR opened against `dev` it reviews at once; no one
   has to ask. It works for PRs from any team member, not only the bots.
2. It leaves comments on what must be fixed, including where the PR does not follow the RFC
   system (missing RFC, wrong status, a decision the RFC does not cover).
3. It reads PR comments, replies, and re-reviews on every new push or answer.
4. It opens and closes issues itself, coordinating with the PM bot.
5. When it approves, the PR merges automatically. The author never merges.
6. Its approval is the second approver `dev` requires.
7. Billing, ledger, payments, grants and quote-signing PRs keep the owner's own review
   (`docs/rfcs/0025-cloud-economics.md`, "The review rule (Decided 3)"); so do PRs labelled
   `do not merge` or `blocked`, and anything the owner holds.

## Answers, by the owner, 2026-11-10 (PR #1010)

- **Q1. Identity:** a GitHub App, named **Automagik Genie** ((a)).
- **Q2. One App, not two:** the same App reviews, approves and makes the release's pushes. What it
  may do and how its keys are kept are in (a).
- **Q3. Bypass:** the owner's own GitHub account is on the bypass list and can always bypass.
- **Q4. Owner-review scope:** the list in (g): billing paths, the reviewer's own files, the two
  workflows that push, and the public-key lists.
- **Q5. Outsiders:** a PR from an account without write access is reviewed by reading only, and
  merges only when a team member also approves its head.
- **Q6. The Tester is renamed the Dogfooder,** and its pass carries visible proof (a screenshot or
  equivalent) of the PR's own change being exercised ((e)).
- **Q7. Shadow:** one day and five PRs (D3).
- **Q8. Merge method:** squash.

## Answers, by the owner's delegate, 2026-11-19

On 2026-11-19 the delegate approved the RFC and took its recommendation for the only open question.

- **Q9. Proof images** (where they live amended on 2026-11-20 by Q10: a separate proof
  repository, not this one): the App uploads each image as an asset of a rolling `review-proof`
  prerelease (never Latest, holding nothing else, like `pocket-lane`) and links it from its
  review and its check run; the bot deletes a PR's images 30 days after it merges or closes.
  Not committed to a branch, where an image would stay in the history for good. Uploading and
  deleting an asset needs contents write; both keep to (a): the bot service's own tokens stay
  contents read.

## Design

### (a) Identity: one GitHub App, Automagik Genie

Most bot PRs are opened by the user account `automagik-genie`, and GitHub never lets an account
approve its own PR. A required status check set with that user account's token would not close
the gate either: any account with write access can post a commit status with the same name, and
a ruleset can pin a required check only to a GitHub App, never to a user's token. The App
(`automagik-genie[bot]`) is a second identity: it can approve the user account's PRs, and its
`pr-reviewer` check is pinned in the ruleset to the App's id, so a status from anyone else does
not count.

**Registering it.** GitHub refuses an App name that equals an existing account unless it is the
registering account's own. "Automagik Genie" becomes `automagik-genie`, the user account's login,
so the App is registered while signed in as the user account `automagik-genie`, installable on
any account, then its ownership is transferred to the `automagik-si` organisation, so the
organisation's owners, not whoever holds the user account's login, control its keys. It is then
set to install on its owner only, and installed on this repository only.

**What the App may do** (repository permissions; no organisation permissions):

| Permission | Level | Why |
|---|---|---|
| Metadata | read | required by GitHub |
| Contents | read and write | read code; the release's pushes and release assets |
| Pull requests | read and write | reviews, comments, labels on PRs, enqueueing |
| Checks | read and write | the `pr-reviewer` check run |
| Commit statuses | read | read other checks' results |
| Issues | read and write | opening and closing issues ((j)) |
| Actions | read | the state of Release and Follow Omni runs ((d)) |
| Merge queues | read and write | only if GitHub requires it to enqueue (D1 records the least set) |

It has no Workflows permission, so it cannot push a change to a file under `.github/workflows/`;
no Administration, so it cannot edit a ruleset or the repository's settings; no Secrets or
Environments. It subscribes to no webhook events (the bot polls, (b)).

**Which refs it pushes.** A GitHub App's permissions are not per branch; the rulesets bound it.
The release's three pushes use it: the version commit and tag (`release.yml`'s `cut` job, one
atomic push of `dev` and `v<version>`), the market index listing (the `list` job) and the
`omni.json` bump (`follow-omni.yml`). The App is on the new ruleset's bypass list for `dev`
((c)); the tag ruleset still forbids moving or deleting a `v3` tag and the `dev and main` ruleset
still forbids force pushes, for the App too. `main`'s fast-forward keeps the workflow token, since
the new ruleset does not cover `main`. The bot service itself never pushes: every token it mints
for its own work is requested with contents read only (an installation token can be narrowed to
fewer permissions when it is minted); only the release jobs mint one with contents write.

**How its keys are kept.** One App, two private keys (an App may hold several, each revoked on
its own in the App's settings):

- **The release key** is a secret of a `release` environment whose deployment rule allows `dev`
  only. Only a job that names that environment and runs on `dev` can read it; a run on any other
  ref fails at the environment. Repository admins can replace the secret but not read it back.
- **The bot's key** sits on the team's machine, readable only by the bot's service user, never in
  a worktree, an environment dump or a log.
- **Rotation:** a new key is generated and put in place before the old one is deleted, every
  90 days, when a seat holding it changes, and at once on any suspected leak. Generating a key is
  an organisation owner's action. Neither key is ever printed or committed.

The bypass belongs to the App, not to a key: whoever holds either key can push to `dev` past the
ruleset. (a)'s narrowed tokens and the watch in (k) limit and reveal that; they do not remove it.

### (b) Trigger: a poll as the source of truth

The bot is a long-running team service on the team's own machine, beside the review seats. It
does not wait for events; every 60 seconds it asks GitHub, in one GraphQL call, for the open PRs
against `dev` (number, head sha, author, draft state, labels, comments since its last cursor) and
the merge queue's entries, and acts on what changed:

- a new head sha: it posts the `pr-reviewer` check run `in_progress` on that sha ("review
  queued") within that poll, and starts a review;
- a new comment by the author or a team member: it reads it and replies, and re-reviews when the
  answer changes a finding;
- a draft: no review until it is marked ready; the check says "draft".

**Why a poll, not a webhook or an Action.** A webhook needs a public endpoint reaching a private
machine: a new trust boundary, and missed deliveries still need a reconcile. A review run inside
Actions needs `pull_request_target` with secrets on untrusted code in a public repository, and
the review seats run on the team's own subscriptions, not on API keys in Actions. A poll is
level-triggered: a missed minute is caught by the next, and a restart picks up every open PR.
Two calls a minute are far inside an App's hourly API budget. A webhook to a relay that only
wakes the poll early can come later without changing anything here.

Any author works the same way. A PR from an account without write access (a fork) is reviewed by
reading only: the bot runs none of its code on the team's machine, and the PR merges only once a
team member also approves that head (Q5).

### (c) The ruleset on `dev`

A new active ruleset, "dev: reviewed merges only", targets `dev` beside the existing one:

- **Require a pull request:** one approval; dismiss stale approvals on push; require approval of
  the most recent push. The App's approval is the second approver of decision 6.
- **Require status checks:** `pr-reviewer`, pinned to the App as its source, and `CI result`,
  pinned to GitHub Actions (a new aggregate job, (f)). Not "up to date with `dev`": the queue tests
  the merged result instead.
- **Require the merge queue** ((d)).
- **Bypass list, always mode:** the App (`automagik-genie[bot]`), for the release's pushes, and
  the owner's own GitHub account (Q3). No other user, team or role, and never the user account
  `automagik-genie`. If GitHub does not take a single user on a ruleset's bypass list, the owner's
  entry is a team whose only member is the owner; changing its members is an organisation owner's
  action.

**The release's pushes move to the App first.** Today `release.yml` (the `cut` job's
`git push -q --atomic origin HEAD:refs/heads/dev`, the `list` job's index push) and
`follow-omni.yml` (the bump) push to `dev` with the workflow token (`github.token`); the new
ruleset refuses those. Putting GitHub Actions on the bypass list instead would let any workflow
run with a write token push to `dev`, including one a writer adds on their own branch. So those
pushes take an App token from the `release` environment ((a)).

GitHub starts no run for a push made with the workflow token (`release.yml` relies on that, "The
workflow's own pushes ... start no run"), but it does for an App's push. The `cut` job and
`ci.yml` therefore skip a push whose actor is the App: without the skip, a release commit would
start a second cut, and its CI run would cancel the merge's own `dev` CI (the shared `ci-` group).

**The owner's bypass** skips the review, the queue and the release wait. When a PR merges, or
`dev` moves, without coming through the queue or a release push, the bot notices on its next
poll, says so on the PR, and gives it an after-the-fact review.

### (d) Merge order: the merge queue, one at a time, after the release is green

GitHub's merge queue (this repository is public and owned by an organisation, where the queue is
available), squash only (Q8), one PR per group, one group building at a time. On a SHIP the bot
enqueues the PR; nobody else needs to. A writer may also press "merge when ready", but the queue
admits a PR only once its required checks pass, that is after the SHIP, so that button is never
a way around the review. The queue then:

- builds the PR on top of the current `dev` and runs CI there (`merge_group`), so the CI that
  admits a merge always postdates the current `dev`: the stale-CI rule holds by construction,
  where today it is checked by hand;
- merges one PR at a time, so no two merges land seconds apart.

The wait for the release is the bot's part. On each merge group the bot posts its own
`pr-reviewer` check, and completes it only when the PR's SHIP still stands at its head, no Release
or Follow Omni run is queued or running (Follow Omni calls the release as a reusable workflow, so
the Release list alone misses it), and the newest Release run's jobs all ended green or skipped,
the lane jobs included. While a release runs, the check stays in progress. The queue's check
timeout is set to 120 minutes (GitHub's default is 60); a PR that waits longer is dropped, and the
bot puts it back once the release is green. When a release run fails, the bot tells the
Integrator once.

**Rejected: the bot merging through the API under its own lock.** The App is on the bypass list
for the release's pushes, so such a merge would skip every rule, and the bot service would need a
contents-write token it otherwise never holds ((a)). The queue keeps every merge condition in
GitHub. Its cost is CI twice per PR (on the PR and on its group) and a `merge_group` trigger in
`ci.yml`.

**History imports** (RFC 0011, "Importing a repository with its history") need a true merge,
which the squash-only queue cannot make: the owner makes that one merge through his bypass.

### (e) The review, and today's lanes

Each review runs in a fresh folder of the exact head sha, never in the author's worktree.

- **Docs-only PRs** (every changed path under `docs/` or a top-level `*.md`): one Reviewer pass.
- **Code PRs:** a Reviewer pass and a Dogfooder pass on the same head, at the same time, by two
  independent agents. SHIP needs both.

**The Dogfooder pass** (the Tester, renamed, Q6) runs the part's gate from `AGENTS.md` through
the shared gate lock, names a mutant it expects the tests to kill, and exercises the PR's own
change for real, then shows it:

- **something drawn** (the desktop app, the pack's sidebar, Pocket, a page): a screenshot of the
  changed screen in the state the PR changes, beside the same screen at the base when the change
  is a difference;
- **a command** (am, a script, the herdr CLI): the commands run and their output, as text;
- **no surface of its own** (a library, a CI step): the command that drives the changed path,
  its output, and the run link when it ran on CI.

The proof must show this PR's change, not a launch that would look the same without it; a pass
without it is not a SHIP. It runs in scratch homes and test servers, under the repository's rules
(never against a live Herdr install, never on the owner's own machine). Text proofs go through
the privacy check like every post; a screenshot cannot be scanned that way, so it is taken only
with placeholder names and data, and the Reviewer pass looks at each image before it is posted.
Where images are kept is Q9's answer: a rolling `review-proof` prerelease.

This is today's merge rule (2026-11-10: docs on one Reviewer verdict, code on Reviewer and Tester
in parallel) moved inside the bot. The lanes become:

| Lane today | With the bot |
|---|---|
| Reviewer | The bot's Reviewer pass. Its verdicts reach the PR only through the bot. |
| Tester | Renamed the Dogfooder: the bot's Dogfooder pass on code PRs, with its proof. |
| Fixer | Unchanged: after a FIX-FIRST on a PR the user account `automagik-genie` opened, the squad hands it the finding. On a person's PR the author fixes. The bot never pushes to a PR branch. |
| Integrator | Keeps watching release runs and owns CI re-runs; the bot asks it once when a check failed for an infrastructure reason. It stops merging. |
| Orchestrator | Keeps squad order and owner asks. It stops merging. |

### (f) Gates

The bot's check on a PR head passes only when all of these hold:

- its own verdict on that head is SHIP;
- every other check run and status on that head is success, skipped or neutral (the bot reads
  them all, not a fixed list, so a new job is covered the day it is added); commit messages
  included (`commitlint.yml`);
- the PR targets `dev`, is not a draft, and carries none of the hold labels ((g));
- for an owner-review PR, the owner has approved that same head;
- for a PR from an account without write access, a team member has approved that same head.

`ci.yml` gains a `merge_group` trigger and one `CI result` job that needs every other job and
fails when any of them failed or was cancelled. The ruleset names only `CI result` and
`pr-reviewer`, so a job added to `ci.yml` never needs a ruleset edit.

### (g) What it never merges on its own

A committed list, `.github/pr-reviewer.json`, names the owner-review paths and the hold labels:

- **Owner-review paths (Q4):** every billing path of RFC 0025's Decided 3 (the ledger, the
  payment adapter, grants, quote signing, margins) as it lands; the reviewer's own files and that
  list; `release.yml` and `follow-omni.yml`; and every public-key list (`plugin-lane/keys.json`,
  `meter/usagemeter/meter-keys.json`, `herdr/mods/am-sidebar/pack-keys.json`, `am/am-keys.json`
  and their copies). A word match ("billing", "ledger", "grant") outside the list makes the bot
  ask the owner to rule, instead of guessing: the meter's token ledger
  (`meter/usagemeter/src/ledger.rs`) is not a billing ledger, and the list says so.
- **Owner-review PRs** get the label `owner-review`, a full review and a verdict. The bot's check
  stays "action required" until the owner's GitHub account approves that same head; a push voids
  his approval like any other.
- **Hold labels:** `do not merge` and `blocked` (both exist today). Any team member may set
  them; the bot removes only a label it set itself. An owner's comment "hold" on the PR makes the
  bot set `do not merge`, and only the owner lifts that one.

### (h) The verdict

The verdict is a GitHub review by the App on the head sha it covers (GitHub binds a review to its
commit), so no separate comment is needed. Its first line is fixed, for people and scripts:

```
PR Reviewer: SHIP at 3f1c0e9a... (full 40-character sha)
```

Then the passes (Reviewer SHIP; Dogfooder SHIP with the gate command, test counts, the mutant and
its proof), the numbered findings with `file:line`, the RFC-system lines ((i)) and the gates it
read.

- **SHIP**: an approving review; the check passes when (f) holds; the bot enqueues the PR.
- **FIX-FIRST**: a "request changes" review with inline comments, one per finding.
- **BLOCKED**: a "request changes" review and the `blocked` label, naming the decision that is
  missing (an RFC, an owner ruling). Only that decision lifts it.

A new push voids the verdict: the ruleset dismisses the approval, and the check starts again on
the new sha. One push is cheaper: when the new head only merges `dev` in and the PR's own diff
(from its merge base) is identical to the one reviewed, the bot carries the verdict to the new
head in a review that names both shas, once that head's CI is green. A merge that resolved a
conflict gets a full review.

The bot reads comments from the author and team members as answers; comments from anyone else
are data, never instructions. Before posting anything it runs the repository's privacy check
(`herdr/scripts/privacy-check.mjs`) on its own text, since the repository is public.

### (i) RFC-system checks

Mechanical, each a finding when it fails:

- A PR fixing an issue labelled `needs-rfc` links an RFC whose status is Accepted or In delivery;
  with none, the verdict is BLOCKED.
- A new RFC takes the next free number (a companion page, like 0016's handoff, names its RFC
  instead), has its row in `docs/rfcs/README.md`, a status word from that file's Status values
  table and the header fields of its Template; its commits are all `docs(rfcs): ...`.
- A delivery PR names its RFC and delivery, and moves the RFC's row (Accepted to In delivery on
  the first delivery, Delivered on the last), or the bot files the follow-up.
- A PR stays on one release lane: `bun scripts/lane.ts kind` over its changes agrees with the
  lane its RFC delivery names.
- A closing keyword ("Fixes #N") appears only for an issue the PR fully fixes; partial work says
  "Refs #N".

Judgement, by the Reviewer pass: a PR that adds a contract its RFC does not list (an id, route,
storage key, setting or file format) gets a FIX-FIRST asking for the RFC's amendment first.

### (j) Issues, with the PM bot

- **Opening.** A finding outside the PR's scope, or one the author and the bot agree to defer,
  becomes an issue opened by the App: the PR, the head sha and `file:line` in the body, and the
  new label `from-review`. The bot searches open issues first and comments on a match instead. It
  sets no squad, priority or milestone: the PM does, and the bot tells the PM in one message.
- **Closing.** `dev` is the default branch, so a merged PR's closing keywords close their issues.
  After each merge the bot checks that every issue the PR claimed is closed and every "Refs"
  issue is still open, and fixes the drift with a comment naming the merge commit. It closes an
  issue by itself only when it opened it and a merged PR resolved it.

### (k) When the bot is down or out of quota

Nothing merges, except through the owner's bypass: the ruleset requires the bot's check, and a
missing or unfinished check blocks the merge by construction. Someone is told:

- A scheduled workflow, `pr-reviewer-watch.yml` (every 30 minutes, off the hour like Follow
  Omni's), lists open, ready PRs whose head has no `pr-reviewer` check, or one in progress for
  more than 60 minutes outside a release wait. If any, it opens or updates one issue, "PR
  Reviewer is not answering", labelled `squad:lead`; the bot closes it when it catches up. The
  same watch opens an issue for any `dev` commit pushed by the App that is not a
  `chore(release): ...` commit (the App's only pushes, (a)). The watch runs on the workflow token,
  with read access and the right to write issues; it never holds the App's key.
- When a review seat is out of quota, the check says "waiting: reviewer out of quota until
  <time>" and the bot tells the Orchestrator. It may move a pass to another model the team lists
  for that pass; it never skips a pass to SHIP sooner.

### Until it exists

Every PR merged without review, the five above included, gets an after-the-fact review with its
verdict on the PR. Today's merge rule stays in force until delivery 5.

## Contracts introduced

- **The App, Automagik Genie** (`automagik-genie[bot]`), owned by the `automagik-si` organisation
  and installed on this repository only, with the permissions in (a). Distinct from the user
  account `automagik-genie`, which keeps opening the team bots' PRs. Uninstalling the App undoes
  it (and, after D1, stops the release's pushes until they return to the workflow token).
- **The ruleset** "dev: reviewed merges only" and the merge queue on `dev`. The existing rulesets
  stay as they are.
- **The check names** `pr-reviewer` (the App's, on PR heads and merge groups) and `CI result`
  (`ci.yml`'s aggregate job).
- **The verdict's first line,** `PR Reviewer: <SHIP|FIX-FIRST|BLOCKED> at <sha>`.
- **`.github/pr-reviewer.json`**: owner-review paths, the word-match exceptions, hold labels,
  the models each pass may use.
- **Labels** `owner-review` and `from-review` (new); `do not merge` and `blocked` (kept).
- **The `release` environment** (deployment rule `dev` only) holding the App's release key.
- **The rolling `review-proof` prerelease** (Q9): proof images only, never Latest; a PR's images
  deleted 30 days after it merges or closes.
- **`pr-reviewer-watch.yml`**, the watch.
- **The bot's code** under `scripts/pr-reviewer/` (Bun, the repository's tooling rule).
- **The role name** Dogfooder, replacing Tester.

No install changes: `.github/`, `scripts/` and top-level `*.md` are in `NEVER_SHIPPED`
(`scripts/lane.ts`), so `bun scripts/lane.ts ships <last tag>` says no for every delivery.

## Threat model

- **The App's keys.** Either key can approve and pass any PR that is not owner-review, and push
  to `dev` past the ruleset (the App is on the bypass list). The release key is readable only by
  `release`-environment jobs on `dev`; the bot's key only by the bot's service user. The bot's
  own tokens are minted without contents write, and the watch reports any App push that is not a
  release commit. A leak is undone by deleting that key in the App's settings; the other key keeps
  working.
- **The user account `automagik-genie`** gains nothing: it is not on the bypass list, its
  approvals do not satisfy the `pr-reviewer` check, and once the App is the organisation's it
  cannot make the App's keys.
- **The owner's bypass** is a standing path around every rule, by his decision (Q3). Its use is
  visible: the bot reviews any such merge after the fact.
- **Prompt injection through a PR** (its text, code or comments telling the bot to SHIP). The
  model decides the findings; the merge conditions in (f) and (g) are code, not the model: checks,
  labels, owner-review paths and approvals. Comments from accounts without write access are data.
  A fork's code never runs on the team's machine.
- **A writer working around the rule**: a direct merge is refused; a forged `pr-reviewer` status
  does not count (pinned to the App); a workflow on a branch cannot push to `dev` (Actions is not
  on the bypass list) or read the release key; the App cannot push workflow files; editing the
  reviewer, its list or the release path needs the owner's approval.
- **Undo:** the owner sets the ruleset to disabled, and `dev` is back to today in one step.

## Deliveries

Each delivery is one PR against `dev`; none cuts a release.

**D1. The App, and the release's pushes on it.** The owner registers Automagik Genie as in (a)
(signed in as the user account `automagik-genie`, then transferred to the organisation), with the
permissions in (a), and creates the `release` environment; both keys go straight into their
places, never printed. `release.yml`'s `cut` and `list` jobs and `follow-omni.yml`'s bump push
with an App token; the `cut` job and `ci.yml` skip a push by the App.
- *Check:* the App's settings show the organisation as owner and exactly the permissions in (a);
  its actions show as `automagik-genie[bot]`, never as the user account. The next release cuts,
  tags and lists as before; its own pushes start no second cut and no `ci.yml` run (both skips
  tested); a dispatch of `release.yml` on another ref fails at the environment.
- *Rollback:* revert; the pushes go back to `github.token`.

**D2. CI ready for the queue.** `ci.yml` gains `merge_group` and the `CI result` job.
- *Check:* `CI result` shows on every PR; a scratch PR with one failing test shows it failed;
  cancelling one job shows it failed.
- *Rollback:* revert; nothing requires the check yet.

**D3. The bot in shadow.** The bot polls, posts its check (not required yet), reviews with the
Reviewer and Dogfooder passes, posts verdicts in the format of (h), runs the (i) checks and opens
issues with the PM, beside today's Reviewer and Tester. The shadow lasts one day and at least
five PRs (Q7).
- *Check:* #991's first two acceptance items: a PR opened by a team member, with no further
  action, gets a review within 5 minutes; a fixing push gets a re-review unasked. Every code-PR
  SHIP carries a Dogfooder proof of that PR's change. The bot's verdicts are tallied against the
  human-run pair's on the same heads.
- *Rollback:* stop the service; the check is not required, so nothing waits on it.

**D4. The watch.** `pr-reviewer-watch.yml`.
- *Check:* with the bot stopped for 70 minutes on a scratch PR, the issue opens; on restart the
  bot reviews it and closes the issue. Run over a fixture list of `dev` commits, the watch
  reports a non-release commit by the App and passes a release commit.
- *Rollback:* revert.

**D5. The switch.** The owner activates the ruleset and the queue (squash only, one at a time,
check timeout 120 minutes); the bot enqueues on SHIP and gates merge groups on the release.
- *Check:* #991's last three items: two SHIP PRs at once merge one after the other, the second
  only after the first's release run is all green; a write-access team member's `gh pr merge` on
  a SHIP PR is refused, and so is a forged `pr-reviewer` status and a merge by the user account
  `automagik-genie`; an owner-review PR is reviewed and waits until the owner approves its head.
  The App's approval counts as the required one. The bypass list shows exactly the App and the
  owner's account (or his one-member team).
- *Rollback:* the owner disables the ruleset; merges work as today.

**D6. The old path retires.** `AGENTS.md` says PRs merge through the queue and names the
Dogfooder; the Orchestrator and the Integrator stop merging; the outside merge helper is retired.
- *Check:* every PR merged in the week after D5 was merged by the queue, or is named as an owner
  bypass with its after-the-fact review.
- *Rollback:* revert the text; the ruleset still holds.

## Amendment: what moves before the App (2026-11-20, proposed, #991)

Status: Accepted, approved by the owner's delegate on 2026-11-20 with option (a) for Q10-Q12
(below); the RFC stays In delivery. It moves no owner step and adds no merge path. Q1-Q8 stand;
Q10's answer amends Q9 (where the images live) and (a) (the App installed on one more
repository). It splits off the parts of D3, D4 and D5 that need
neither the App nor the ruleset, records what D1 and D5 must also cover, and asks Q10-Q12.

### Where it stands (reviewed on dev 3e58d9d57)

- **Merged.** D2 (#1775): `ci.yml` runs on a `dev` merge group and has the `CI result` job
  (`.github/workflows/ci.yml:1981`), kept complete by `scripts/ci-result.test.ts`. D3 in part
  (#1786): `.github/pr-reviewer.json` and `scripts/pr-reviewer/rules.ts` (`classify`,
  `verdictLine` and `parseVerdictLine`, `fromReviews`, `gate`), with tests; nothing runs them.
  The five unreviewed merges each carry an after-the-fact verdict as a comment on their PR:
  [#961](https://github.com/automagik-si/automagik/pull/961#issuecomment-6779340923),
  [#962](https://github.com/automagik-si/automagik/pull/962#issuecomment-6779341291),
  [#965](https://github.com/automagik-si/automagik/pull/965#issuecomment-6779341778),
  [#967](https://github.com/automagik-si/automagik/pull/967#issuecomment-6779342334),
  [#972](https://github.com/automagik-si/automagik/pull/972#issuecomment-6779342898).
- **Changed since the Motivation.** `ci.yml` now cancels only pull-request runs
  (`ci.yml:38-40`), so a running `dev` CI finishes; a pending one can still be replaced by a newer
  run in the same group. A cut whose `dev` moved re-decides the lane and re-cuts on the new tip a
  bounded number of times (`scripts/release-cut.sh:426`, `release.yml:93-96`, #668, still open).
  What the queue still owes is (d)'s serial order: the next merge only after the previous release
  run, its lane jobs included, ended green. The missing review rule is unchanged.
- **Waiting on the owner.** D1: register the App as in (a) and create the `release` environment
  with the App's release key. D5: activate the ruleset and the merge queue. Every acceptance item
  of #991 sits behind one of the two.

### What D1 and D5 must also cover

- **D1: the App's own pushes still create runs.** GitHub has no actor filter on a `push` trigger,
  and a completed Release run on `dev` fires Follow Omni's `workflow_run` trigger
  (`follow-omni.yml:61-64`) even when every job skipped. So a push by the App creates a Release
  run, a CI run and then a Follow Omni run; D1 makes each of them do no work (the `cut`, CI's jobs
  and Follow Omni's jobs skip for an App push, or for the Release run one started), puts each in
  a concurrency group of its own, so it never replaces a pending genuine run in `ci-<ref>` or
  `follow-omni` (`follow-omni.yml:90`), and keeps the no-op Release run out of (d)'s "newest
  Release run ended green". Its tests show that a pending genuine CI run and a pending genuine
  Follow Omni run survive an App push, that Follow Omni's reusable Release call still runs, and
  that a push by the user account, a pull request and a merge group run as today. D1's check
  reads "its own pushes start no second cut and no work in `ci.yml` or Follow Omni" instead of
  "no `ci.yml` run". `main`'s fast-forward (`release.yml:1219`) keeps the workflow token.
  The skips and the token switch land together in D1, after the App exists, and never dormant
  behind a variable: running a job that names an environment that does not exist makes GitHub
  create it with no protection rule and no secret. The owner checks the `release` environment's
  `dev`-only rule before placing the key.
- **(k) corrected: the App's pushes are three.** Follow Omni's bump is committed as
  `chore(desktop): carry Omni <version>` (`follow-omni.yml:329`), not `chore(release): ...`. The
  watch tells a release push from any other App push by the run that pushed it (the workflow,
  the run's head and the commit it pushed), never by the commit subject alone.
- **D5: a cancelled leg on the merge group.** From D2: a matrix leg cancelled without its run being
  cancelled can leave its parent job's result `success`, so `CI result` passes it. The queue tests
  the merge group's sha, while the SHIP belongs to the PR head, and `gate` binds both its verdict
  and its results to one sha and keeps only the newest check per App and name
  (`scripts/pr-reviewer/rules.ts:255-279`). So the bot's check on a merge group is two checks:
  the SHIP and the approvals still stand on the PR's current head (`gate` on that head); and the
  group, read as the queue's entry for that head, has every expected job and matrix leg of its CI
  run ending in success, each leg's effective result being its newest across all the run's
  attempts (every page read), so a rerun of the aggregate alone never covers a leg cancelled in
  an earlier attempt. A skipped leg fails on a group (`ci.yml` lets only a pull request skip an
  unchanged area). Missing or partial evidence waits. D5's check adds: an ordinary green group
  merges; a leg cancelled on a scratch merge group stops that merge even when its parent job
  reports success, and still stops it after a rerun of `CI result` alone; a skipped group leg
  stops it; a group whose jobs are not all read waits.

### The split

Each part is one PR against `dev` under `scripts/` or `.github/`, so none cuts a release; each
names its delivery. All of them change the reviewer's own files, which (g) puts under the
owner's review (`.github/pr-reviewer.json`'s `reviewer` list, which D5a extends to
`.github/rulesets/**`); until D5 nothing enforces that list, so each PR says so and asks for the
owner's approval on its head, under today's merge rule.

**D3a. The review engine, offline** (part of D3). `scripts/pr-reviewer/` gains, as pure code over
a GitHub port with a fake in the tests:
- the poll as a reducer: the last state and one snapshot (open PRs against `dev`, head shas,
  drafts, labels, author permission, head repository, comments since the cursor, queue entries)
  in, (b)'s actions out (start a review, re-review, reply, "draft", carry a verdict); a field the
  snapshot could not read, and a connection whose pages were not all followed, is unknown and
  leads to waiting, never to a pass;
- every mechanical check of (i): a PR fixing a `needs-rfc` issue links an RFC that is Accepted or
  In delivery, else BLOCKED; a new RFC's number against `dev` and the open PRs (a companion page
  names its RFC instead), its README row, status word, Template header fields and
  `docs(rfcs): ...` commits; a delivery PR names its RFC and delivery and moves the RFC's row, or
  the bot drafts the follow-up; the lane, read from trusted lane code over the PR's own diff,
  `ships` first and `kind` only for a change that ships (a bare `kind` answers `full` with
  no tag to compare, `scripts/lane.ts:695`); a closing keyword only for a fully fixed issue;
- (h)'s verdict composer, the carry-over included: the new head is a merge commit whose first
  parent is the reviewed head and whose other parent is on `dev`, the PR's own diff from its merge
  base is identical to the one reviewed, no conflict was resolved, and the new head's CI is green;
  anything else (pending or failed CI, a rewritten or reset head with the same diff) gets a full
  review;
- (j)'s issue drafts: search before opening, the body with PR, head sha and `file:line`;
- the wiring of a snapshot into `gate` ((f)) on a PR's head, and the merge-group verifier of
  "What D1 and D5 must also cover" on the queue's sha.

The engine and its rules are loaded from a trusted revision (the deployed one), never from a PR's
head. The only real adapter it adds reads; it holds no token of its own.
- *Check:* the tests run every (b) transition, each (i) check on a passing and a failing fixture,
  the carry-over on an identical diff with green, pending and failed CI, on a conflict-resolving
  merge and on a rewritten head with the same diff and green CI (full review), and recorded
  snapshots replayed end to end, including a truncated page and a field denied to the token.
- *Rollback:* revert; nothing runs it.

**D3b. The dry run** (part of D3; after D3a and Q11). The engine runs on the team's machine
against the real open PRs and writes each verdict to a local ledger instead of GitHub; nothing is
posted. The passes follow (e) for each exact head: one Reviewer pass on a docs-only PR; on a code
PR both passes, independent, with the part's gate from `AGENTS.md` through `scripts/capped-run`
and cargo only under its build-host rule. A PR's code runs only when its head repository is this
repository and its author's write access was read and confirmed; a PR from a fork (a writer's
fork included) or with either value unknown is reviewed by reading only. The read token is held
by the poller, never by a pass. The ledger is tallied against the human Reviewer and Dogfooder verdicts
on the same heads, the comparison D3 asks for; a ledger entry is never approval evidence. It does
not count toward Q7's shadow (one day and five PRs, verdicts posted on GitHub), which still runs
on the App after D1: a review within 5 minutes and a re-review without being asked show only on
the PR.
- *Check:* five PRs in the ledger with the passes (e) gives them beside the human verdicts, each
  marked complete only when every page of the poll was read; a writer's fork in the ledger read
  only; the token shown as public read only, expiring.
- *Rollback:* stop it and revoke its token; it wrote nothing on GitHub.

**D4a. The watch's logic, offline** (part of D4). The watch's decisions as code in
`scripts/pr-reviewer/` with D4's fixture list: an open, ready PR whose head has no `pr-reviewer`
check, or one in progress for over 60 minutes outside a release wait; an App push to `dev` that
the pushing run does not show to be the cut, the index listing or Follow Omni's bump. No workflow
file: `pr-reviewer-watch.yml`, with its issue-write permission and schedule, lands in D4 after
the App; before the App every open PR lacks the check and a live run would open the issue at
once.
- *Check:* the fixtures, including each of the three release pushes passing and a hand-made App
  commit with a `chore(release): ...` subject from no release run failing.
- *Rollback:* revert.

**D5a. The ruleset as a template** (part of D5; Q12). The ruleset of (c) and the queue of (d)
committed as one file, `.github/rulesets/dev-reviewed-merges.json`, in the shape GitHub's ruleset
import takes, `enforcement` `disabled`, with the App's id and the owner's bypass entry as named
placeholders. Its tests check: target `dev` only; one approval, stale approvals dismissed,
approval of the latest push; `pr-reviewer` pinned to the App's id and `CI result` to GitHub
Actions; squash only, one PR per group and one group building at a time, a 120-minute check
timeout; exactly two bypass actors, both `always`. A read-only script compares the live ruleset
with the file; a field the token cannot read (GitHub shows bypass actors only to an account that
can edit the ruleset, and a ruleset export leaves them out) is reported as unverified, for the
owner to check by eye. At D5 the owner fills in the two ids, imports the file, checks it and sets
it active; the script then compares against `active`.
- *Check:* the file's tests; after D5, the script reports no difference and lists what it could
  not verify.
- *Rollback:* revert; the file changes nothing on GitHub.

**Order.** D3a, D4a and D5a in any order; D3b after D3a, and only if Q11's answer is (a), which
is the owner's leave to run it. After the owner: D1 (with the points above), D3's shadow on the App, D4's workflow, D5, D6, as above.

### Questions for the owner (recommended first)

- **Q10. Where proof images are uploaded.** Q9 puts them on a rolling `review-proof` prerelease of
  this repository. An upload needs contents write; a contents-write token on this repository can
  push to `dev` past the ruleset, since the App is on its bypass list; and section (a) keeps every
  token the bot service mints at contents read. No option changes what the bot's key itself can
  mint ((a), "The bypass belongs to the App, not to a key").
  (a) Amend Q9 and (a): a separate public repository in the organisation holding only proof
  images, with its own rolling `review-proof` prerelease and Q9's 30-day deletion; the App is
  also installed there. (a)'s rule that only the release jobs mint a contents-write token gains
  one exception: the bot's uploader, a step of the service apart from both passes, mints a
  contents-write token for each upload or deletion, for the proof repository's id only (an
  installation token can be limited to some of the installation's repositories); every token for
  this repository stays contents read. The uploader posts only an image the Reviewer pass looked
  at for that PR head, names the PR and head in the asset, and checks the release it touches; the
  passes never hold a token. Creating that repository and installing the App on it are the
  owner's actions.
  (b) Text proofs only until a later design for images: a drawn change's Dogfooder pass has no
  image, so the bot withholds SHIP on it (Q6); such a PR lands only through the owner's bypass
  (Q3), reviewed after the fact like any bypass.
- **Q11. The dry run's credential.** (a) A fine-grained token of the user account
  `automagik-genie` with public-repository read-only access and an expiry of 30 days, made for the
  dry run alone and revoked when it ends; nothing is posted; choosing it is the owner's leave to
  run D3b. (b) No live dry run: D3b is dropped, recorded snapshots are replayed in D3a's tests
  only, and the comparison waits for the shadow on the App.
- **Q12. The ruleset's form.** (a) A disabled template committed now and a read-only drift
  check (D5a), the owner filling in the ids and importing it at D5. (b) The owner sets it by hand
  from (c)'s text at D5, as the RFC says today.

None of Q10-Q12 blocks D1 or D5; Q10 blocks only the image half of the Dogfooder's proof in D3.

### Answers, by the owner's delegate, 2026-11-20

On 2026-11-20 the delegate approved the amendment with option (a) for each question.

- **Q10. Proof images:** (a). A separate public repository in the organisation holds only proof
  images, with its own rolling `review-proof` prerelease and Q9's 30-day deletion; the App is
  also installed there, and upload tokens are minted for that repository only. Every token for
  this repository stays contents read. Creating the repository and installing the App on it stay
  the owner's actions.
- **Q11. The dry run's credential:** (a). A fine-grained token of the user account
  `automagik-genie` with public-repository read-only access and a 30-day expiry; nothing is
  posted. The owner's delegate makes it when D3b starts and revokes it when it ends; no one else
  makes it, asks for it or reads it.
- **Q12. The ruleset's form:** (a). A disabled import template and a read-only drift check
  (D5a); the owner fills in the ids, imports it and sets it active at D5.

## Open questions

Q1-Q8 were answered by the owner on 2026-11-10 and Q9 by the owner's delegate on 2026-11-19,
above; Q10-Q12, the amendment's, by the owner's delegate on 2026-11-20. None is open.

## Links

- **Issue:** #991 (the direction and its acceptance items). Unreviewed merges: #961, #962, #965,
  #967, #972. The cut race: #668. This RFC's PR and the owner's answers: #1010.
- **RFCs:** [0001](0001-roadmap-and-milestones.md) docs never ship;
  [0011](0011-monorepo-parts-and-releases.md) parts, lanes and history imports;
  [0025](0025-cloud-economics.md) the billing review rule (Decided 3).
- **Files:** `.github/workflows/release.yml` (the `cut` and `list` jobs, the `release-cut`
  concurrency group), `.github/workflows/follow-omni.yml` (the bump push, the release call),
  `.github/workflows/ci.yml` (its concurrency group), `.github/workflows/commitlint.yml`,
  `scripts/lane.ts` (`kind`, `ships`, `NEVER_SHIPPED`), `herdr/scripts/privacy-check.mjs`,
  `docs/rfcs/README.md` (status values, template), `AGENTS.md`.
