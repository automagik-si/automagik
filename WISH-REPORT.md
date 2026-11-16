# WISH-REPORT — Deleting a Bot or group from the sidebar asks first

- **PR:** https://github.com/automagik-si/automagik/pull/1452 — base `dev`, head `wish/excluir-bot-grupo-do-sidebar-deve-pedir`, no merge.
- **Base:** `dev` @ `4fac7057` (v3.149.4).
- **Commit:** `fix(bots-dsh): ask before deleting a Bot or group from the sidebar menu`.

## Behavior change (before -> after)

Before: one click on **Delete** / **Delete group** in the sidebar context menu deleted the Bot
or group immediately. After: the first click only asks, renaming the item to **Delete {name}?**,
and the second click deletes; Escape, a click outside, or picking another item closes the menu
and cancels, and the ask lapses after 4s.

Host behavior and what a delete does are unchanged; this is only the confirmation step in the UI.

## What changed

- `apps/bots-dsh/src/client/context-menu.js` — a `useConfirmStep()` used by the Bot/group
  **Delete** item and by the DSH bot menu's **Remove {name}** (it archives every Session it owns
  and drops the record, so it is equally destructive); the menu stays open on the asking click
  and closes before the confirmed action runs, exactly as every item did before.
- `apps/bots-dsh/src/client/i18n.js` — Chinese entries for the two new labels (`Remove {name}?`,
  `Remove Tasks?`); `Delete {name}?` already existed.
- `apps/bots-dsh/client.js` — rebuilt with `node scripts/build-client.mjs` (committed bundle).
- `apps/bots-dsh/test/context-menu-delete-confirm.test.js` — new test: Bot delete, group delete,
  confirmation cancelled by closing/reopening the menu, and the DSH bot Remove.
- `apps/bots-dsh/test/context-menu-adoption.test.js` — its stub `useState` is now stateful so a
  second render sees the click's state; the Remove case clicks twice, as the UI now requires.
- `apps/locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json` and its `client.js` — the pack
  translates every omni-ui key the Bot team renders, so the two new labels ship in pt-BR too.

## Red first (before the fix)

```
$ cd apps/bots-dsh
$ node --import ./test/harness-resolve.mjs --test --test-timeout=120000 \
    test/context-menu-delete-confirm.test.js
✖ the sidebar Delete asks before it deletes a Bot (10.792823ms)
✖ the sidebar Delete asks before it deletes a group (2.540101ms)
✖ a menu that closes and reopens asks again instead of remembering the confirmation (2.67412ms)
✖ the DSH bot menu asks before it removes the bot and archives its Sessions (2.461782ms)
ℹ tests 4
ℹ pass 0
ℹ fail 4

✖ failing tests:

test at test/context-menu-delete-confirm.test.js:98:1
✖ the sidebar Delete asks before it deletes a Bot (10.792823ms)
  AssertionError [ERR_ASSERTION]: the first click only asks, it does not delete
  + actual - expected

  + [
  +   'close',
  +   [
  +     'deleteBot',
  +     'bot1'
  +   ]
  + ]
  - []
```

The single click really called `deleteBot('bot1')`. Same shape for `deleteRoom` and
`removeAgent`.

## Green (after the fix, on the rebased branch)

```
$ cd apps/bots-dsh
$ bun run test
# exit 0
ℹ tests 5400
ℹ pass 5252
ℹ fail 0
ℹ cancelled 0
ℹ skipped 148
ℹ duration_ms 31344.696885
test-guard: complete run: plan 1..5239, 5239 top-level results, 5400 tests
(5252 pass, 0 fail, 0 cancelled, 148 skipped, 0 todo), 393 files

$ bun run lint
# exit 0
Found 137 warnings and 0 errors.
Finished in 39ms on 851 files with 97 rules using 32 threads.

$ node scripts/build-client.mjs --check
# exit 0
```

The pt-BR pack's own gate (its `runtime.test.js` needs the DSH harness):

```
$ cd apps/locale-pt-br-dsh
$ DSH_HARNESS=$(cd ../bots-dsh/dev/harness && pwd) node --test "test/*.test.js"
# exit 0
ℹ tests 22
ℹ pass 22
ℹ fail 0

$ node scripts/build-client.mjs --check
# exit 0
```

The 137 lint warnings are pre-existing in untouched files; the new and changed files are
warning-free.

## Provisioning note (only deviation)

The assigned worktree arrived as an empty placeholder: its base commit `26d6b8bf` ("Genie starts
here") has zero files, and its `origin` was a local mirror whose `dev` is that same empty commit
(no `apps/` at all). The wish's repository is the automagik monorepo and its base is `origin/dev`,
so the branch was rebuilt on the real `origin/dev` (`a380fb498`, then rebased onto the current
`dev` `4fac7057` when it advanced during the work). Nothing else was touched: no other branch was
pushed or merged, and `dev` is unchanged.

## CI

The first CI run on the fix caught a gate the package suite does not cover: `locale-pt-br-dsh
(plugin tests)` failed because every omni-ui key the Bot team renders needs pt-BR text.

```
✖ every omni-ui key the Bot team renders has its pt-BR text
  AssertionError [ERR_ASSERTION]: a Bot string with no pt-BR text stays in English
  + actual - expected
  + [ 'Remove Tasks?', 'Remove {name}?' ]
  - []
```

Fixed by the pt-BR dictionary and bundle above; the locale pack's 22 tests pass locally. The
commit subject (72 chars) and this file's lines are inside the 100-character limit the
Conventional commits job enforces.

The run on `1460db7e` is green, including `bots-dsh (plugin tests)`, `locale-pt-br-dsh
(plugin tests)` and `Conventional commits`; the PR is `OPEN` and `MERGEABLE`.

## Open

- Nothing merged. This report's own commit is docs-only; it is covered by the same CI gate.
