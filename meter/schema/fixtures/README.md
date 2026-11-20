# herdr-meter v2 fixtures

These synthetic fixtures are shared by the Rust schema test and Pocket's Spend and SpaceFeed
tests. Other readers, including genie, can use them from a pinned commit of this repository.

| Fixture | Schema | Spend | SpaceFeed |
| --- | --- | --- | --- |
| `full.json` | Valid | Report, 220 tokens, USD 2, 20 unpriced tokens in each window | Null |
| `cut.json` | Valid | Report, 320 tokens, USD 3, 20 unpriced tokens in each window. Retained projects contribute USD 2 and `projects_other` contributes USD 1. `tasks_other` carries USD 3 of overlapping usage and sets `tasksCut` to true. | Null |
| `space.json` | Valid | Report, same totals as `full.json` | Version 1 feed, seven merges for `/work/example-project`, a null model cost and a bot's USD 0.00 spend |
| `first-import.json` | Valid | Report, same totals as `full.json` and `complete == false` | Null |
| `bad-version.json` | Invalid | Unsupported, version 3 | Null |
| `bad-kind.json` | Invalid | Unsupported, version 2 with a different kind | Null |

Each refusal changes exactly one discriminator from `full.json`. Each document without
`space` yields a null SpaceFeed.

The tests remove `generatedAt` from `full.json` in memory and check that the schema rejects it
and Spend returns Unsupported. The schema test checks deletion of every unconditional field.
Spend accepts missing `projects`, `machine`, and `complete` with defaults, so the schema test
covers those deletions. Both readers return equal results after the tests add an unknown root
`future_field` to `space.json`, and the extended fixture still validates.

The root `truncated` is an array, empty on an uncut summary. `space.truncated` is a boolean.
Timestamp patterns check the UTC form with seconds or three fractional digits. `daily.from`
uses the calendar-date form.
