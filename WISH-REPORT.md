# Wish report — a team Bot inherits the DSH default preset

- **PR:** https://github.com/automagik-si/automagik/pull/1438
- **Branch:** `wish/bot-de-equipe-deve-herdar-o-preset-padra`
- **Base:** `origin/dev` (`d5c630f893fbb2f319093b5cdc48a60631eb23e7`)
- **Repo:** `/mnt/ai/automagik` (worked in the wish worktree only)

## Change in one line

Before: a Bot created by `create_bot` or the Create Bot form always got
`agentPreset: 'standard'`; after: its own Session asks for no preset and inherits the
DSH default, while group Sessions keep `standard`.

## What changed

- `apps/bots-dsh/src/host/roster.js`
  - `botPreset(profile, { group = false })`: with no explicit profile, a non-group
    Session now returns `{}` (DSH default); a group Session still pins `standard`
    when DSH serves it.
  - `createSession(title, { dir, profile, group })` passes the group flag through.
  - `buildRoom` creates the group's relay Session with `group: true`.
- `apps/bots-dsh/src/host/groups.js`
  - A member's group Session is created with `group: true`.
- `apps/bots-dsh/src/host/parts.js`
  - A fresh part keeps the preset of the conversation it continues: `group: true`
    when the part belongs to a group chat, DSH default for a Bot's own chat.
- `apps/bots-dsh/test/agent-preset.test.js`
  - The Red test and two group regression tests (see below).

The UI path already behaved this way: `apps/bots-dsh/src/host/agents.js` passes
`agentPreset: agent.profile`, and an undefined profile becomes DSH's default.

## Decision on the `standard` pin

**The pin stays for group Sessions. The Bot's own Session no longer uses it.**

Why the pin exists: under the PTC preset (DSH Desktop's default) a model may call only
`run_code`. A group chat's Session is handed a synthesized `group_relay` call; PTC
rejects that direct call as an unknown tool, so the group never relays. That is
Fei2411/DS-Bot#37, fixed upstream in
[71d4b5ca](https://github.com/Fei2411/DS-Bot/commit/71d4b5ca887534522572831423d90acc9ed657e4)
("New Bot chats, group Sessions and conversation parts are now created with the
standard preset when DSH serves it"). The same commit kept a `run_code`
compatibility branch for groups made before the fix (`src/host/groups.js`, "Only for a
group made under the PTC preset") and notes that such a round is bound by the DSH
program time limit. The pin keeps new group Sessions on the direct path. That blanket
pin also covered new Bot chats, which is the behavior this wish changes: a Bot's own
chat is not a group relay Session, so it can inherit the default without touching
group relay.

Because a Session keeps the preset it is made with, I did not remove the default pin
globally. I applied the DSH default at the place that was actually wrong: the Bot's
own Session, which is not a group relay Session. Group relay behavior is unchanged and
covered by the new group tests.

What DSH's default is: the Web bundle's `agent-preset-registry` default is `standard`;
DSH Desktop defaults to `ptc`. Leaving `agentPreset` out therefore means "whatever
this DSH instance is configured to use", including a user-selected default, rather
than hard-coding one of them.

## Red test first

Added to `apps/bots-dsh/test/agent-preset.test.js`:

```js
test('a Bot\'s own Session inherits DSH\'s default preset', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'ptc' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  await rt.createBot({ name: 'Editor', role: 'Editor', instructions: 'Edit.', pickModel: true })
  assert.deepEqual(created, [{ workspaceId: 'w1' }])
})
```

Real failure before the fix:

```
✖ a Bot's own Session inherits DSH's default preset (46.813116ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    [
      {
  +     agentPreset: 'standard',
        workspaceId: 'w1'
      }
    ]

      at TestContext.<anonymous> (…/apps/bots-dsh/test/agent-preset.test.js:89:10)
      actual: [ { workspaceId: 'w1', agentPreset: 'standard' } ],
      expected: [ { workspaceId: 'w1' } ],
test-guard: complete run: plan 1..12, 12 top-level results, 12 tests (11 pass, 1 fail, 0 cancelled, 0 skipped, 0 todo), 1 files
```

Group regression tests added in the same file:

- `a group Session keeps the standard preset so group_relay stays directly callable`
  calls the real `createRoom` with presets `[{ id: 'ptc' }, { id: 'standard' }]` and
  asserts the created request is `[{ workspaceId: 'w1', agentPreset: 'standard' }]`.
- `without a usable standard preset a group Session keeps DSH's default` covers no
  `agentPresets` service, only `ptc`, and a broken `standard`.

Both passed before and after the fix; they protect the pin while the Bot path changes.

## Commands and real output (after the fix)

From `apps/bots-dsh`, as the repository's AGENTS.md/check script does:

```
$ bun run test
...
ℹ tests 5384
ℹ suites 23
ℹ pass 5236
ℹ fail 0
ℹ cancelled 0
ℹ skipped 148
ℹ todo 0
ℹ duration_ms 183427.759137
test-guard: complete run: plan 1..5223, 5223 top-level results, 5384 tests (5236 pass, 0 fail, 0 cancelled, 148 skipped, 0 todo), 391 files
```

```
$ bun run lint
...
Found 137 warnings and 0 errors.
Finished in 59ms on 849 files with 97 rules using 32 threads.
```

Changed files alone: `0 errors`; the only two warnings shown are pre-existing
`unicorn(no-useless-spread)` warnings in `src/host/groups.js` outside the changed lines.

```
$ node dev/harness/node_modules/oxlint/bin/oxlint -c .oxlintrc.json \
    src/host/roster.js src/host/groups.js src/host/parts.js test/agent-preset.test.js
Found 2 warnings and 0 errors.
Finished in 23ms on 4 files with 97 rules using 32 threads.
```

## PR checks

- `Conventional commits` is **red**: `a8cccc813 has a line over 100 characters` and
  `22d8ad569 has a line over 100 characters`. The subjects follow the convention; one
  body paragraph in each commit is longer than the check's 100-character limit. Per the
  wish, I did not amend or force-push, so the check stays red and is recorded here.
- The remaining checks were still running when this report was written; the local
  package suite and lint above are green. `bots-dsh (plugin tests)` is the relevant CI
  job to watch on the PR.

## Worktree note

The provided worktree was seeded from the wrong repository: its `origin` pointed at a
template whose only commit was an empty `26d6b8bf "Genie starts here"` commit, so the
project files were absent, and `26d6b8bfe620` does not exist in
`/mnt/ai/automagik`. I repointed `origin` at
`https://github.com/automagik-si/automagik.git` and rebuilt the branch at the real
`origin/dev` (`d5c630f8`) before making changes. No file outside this worktree was
modified, and nothing was merged.

## Open items

- The Conventional commits check stays red by instruction; fixing it would require
  rewriting the already-pushed commit.
- The `run_code` relay fallback for legacy PTC group Sessions remains; this change
  does not remove it.
