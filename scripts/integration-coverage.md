# Integration coverage

`integration-groups.json` is the contract. Required groups run through
`node scripts/integration-gate.mjs run <id> --out <dir>` with exact test, pass and top-level counts.
Any skip, todo, failure, cancellation, missing environment prerequisite or incomplete file fails.
The gate verifies each file's runner events against its own end-of-file summary; console output
and the runner's global summary cannot prove coverage. `select` only describes a group and is
never passed to the runner.

| Status | Meaning |
| --- | --- |
| required | Gated with exact counts and complete results for every file. |
| unprovisioned | Uncovered in PR CI until provisioned, not claimed. |
| optional | Intentional skip, not coverage. |
| prerequisite-enforced | Fails without its prerequisite; this gate does not verify counts. |

Current coverage:

| Groups | Job / status |
| --- | --- |
| acp-image-read | Image-read helper job: required, 7 tests, 7 passes, 1 top-level test. |
| acp-image-codex | Plugin job: unprovisioned. |
| acp-image-lock-native | Plugin job: unprovisioned; Linux/macOS, reads need Linux with bwrap. |
| acp-session-files-native | Plugin job: unprovisioned. |
| acp-real-adapters-codex | Plugin job: unprovisioned. |
| acp-real-adapters-claude | Plugin job: unprovisioned. |
| id-pages-browser | ID job: prerequisite-enforced only when ID_PAGES_BROWSER=required. |
| bots-chrome-layout | Bot plugin job: prerequisite-enforced only when CI is set. |
| bots-electron-wall | Bot plugin job: prerequisite-enforced only when CI is set. |
| acp-image-read | ACP plugin job: optional. |
| pets-chromium-parity | Pets job: optional. |

PR CI installs no codex-acp / Claude Code for the unprovisioned groups. The scheduled
`acp-drift.yml` installs the newest adapters daily and greps for some of these cases.
`acp-compat.json` contains compatibility records, not install pins. Real-adapter tests can pass
while reporting that their bridge checks did not run (`real-adapters.test.js:119`), so their pass
count alone would not prove bridge coverage.

To add a required group, add its files, environment prerequisites, required job and exact
`expect` counts to the manifest. Add a job step running `integration-gate.mjs run <id> --out <dir>`,
then a `summary --job "<job>" --verdict <dir>/verdict.json` step and an artifact upload for the
ledger, console log and verdict. The summary reports unknown counts when no verdict is available;
non-required rows show environment presence as observed in the summary process.

`bun test scripts` checks the gate and its contract.
