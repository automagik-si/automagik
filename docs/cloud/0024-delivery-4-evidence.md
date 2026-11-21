# RFC 0024 delivery 4 evidence

| Field | Value |
|---|---|
| Issue | #912 (Refs) |
| RFC | [0024](../rfcs/0024-automagik-cloud.md#deliveries), delivery 4 |
| Written | 2026-11-21 |
| Lane | docs and tests (no release) |
| Status | Delivery 4 remains open. Every repository-provable line has a test, with U10/U11 still open. |

## Test receipts

The gate's Cloud tests use an in-process fake Cloud service. The fixtures use reserved `.invalid`
names, loopback and keys generated per run. P14 uses two temporary homes, each with its own agent
token, direct MCP listener and gate backed by a fake DSH upstream. Each gate binds on a separate
OS-assigned loopback port and receives its own logical origin as a pinned `Host` header. Both
fixtures use owner-only mode.

| Test | Commit | Node | Command | Result |
|---|---|---|---|---|
| The gate's Cloud tests, `server/test/gate-cloud.test.mjs` | `5bab65c75fda7306699ea5b66fb9800c0589b1c4` | 24.9.0 | the first command below | 41/41 passed |
| P14, in `apps/bots-dsh/test/agent-access.test.js` | `5bab65c75fda7306699ea5b66fb9800c0589b1c4` with this change | 24.9.0 | the second command below | the file's 23/23 passed, P14 among them |

Both ran one file at a time from the repository root through the repository's wrapper:
`scripts/capped-run -- node --test server/test/gate-cloud.test.mjs`, and
`scripts/capped-run -- bash -c "cd apps/bots-dsh && node ../../scripts/test-guard.mjs --import ./test/harness-resolve.mjs --test test/agent-access.test.js"`.

## Delivery 4 checks and acceptance

| Check or acceptance line | Evidence | Test or open work |
|---|---|---|
| A's Cloud workspace token is refused by B | Proven here against the fake Cloud | B refuses a validly signed token for A on audience. In the paired fixture, the fake refuses A's code when B asks to exchange it, and B's own verifier refuses A's token while A accepts it. [“a token for another workspace is refused even with a valid signature”](../../server/test/gate-cloud.test.mjs#L237), [“workspace A's open code is refused at workspace B, by the Cloud service and by B”](../../server/test/gate-cloud.test.mjs#L250) |
| A's MCP agent token is refused by B (U14) | Repository (P14) | Each own-token control must return `200` and a `result.tools` array. Each cross-home request must return `401` and append one unknown-token refusal to the receiving home's audit. The test checks both directions on `/mcp` and `/api/omni-mcp`, and checks both audits for absence of both raw credentials. [“P14: one workspace's agent token is refused at another's listener and gate origin”](../../apps/bots-dsh/test/agent-access.test.js#L578) |
| Session lifetime and five-minute bound | Proven here against the fake Cloud | The original session ends by token expiry and within five minutes. The v2 path rechecks the role and issues a session of at most five minutes. These bounds use the gate's injected clock. [“the gate session ends with the workspace token and renewal never extends it”](../../server/test/gate-cloud.test.mjs#L403), [“a v2 renewal rechecks the role and issues a session of at most five minutes”](../../server/test/gate-cloud.test.mjs#L896) |
| Immediate refusal after a signed removal call | Proven here against the fake Cloud | Once the gate receives the signed call, the removed person's existing session and a new open with a test-minted token receive `401`. The other person's session still works. [“a signed revocation call drops that person's sessions and refuses a new open”](../../server/test/gate-cloud.test.mjs#L615) |
| Poll fallback | Proven here against the fake Cloud | The gate fetches a test-supplied signed list and drops the affected sessions. The test uses a shortened poll interval. [“the poll fallback drops sessions from a signed list”](../../server/test/gate-cloud.test.mjs#L705) |
| Renewal refusal after removal or a role change | Proven here against the fake Cloud | The gate refuses v2 renewal on a test-supplied denial or a signed answer carrying a role without access. A session dropped by a signed removal call also fails renewal. [“a renewal is refused after a revocation or when the role no longer grants access”](../../server/test/gate-cloud.test.mjs#L1026) |
| `role_lowered` drops sessions | Proven here against the fake Cloud | The gate drops sessions that existed at the call's effective time. Sessions created later survive that call. A later open is judged by its own token's roles. Owner-only mode rejects member and guest tokens. The scope of “every session” and the operational effects of removal remain open in U10/U11. [“role_lowered drops only the sessions that existed at its effective time”](../../server/test/gate-cloud.test.mjs#L688), [“Cloud workspaces stay owner-only: members and guests are refused, unknown roles ignored”](../../server/test/gate-cloud.test.mjs#L430) |
| Rail tile, single-use code and server exchange | Proven here against the fake Cloud for the gate path | The gate exchanges the code server-to-server, refuses a replay it has already seen, and refuses token-bearing URLs. The fake refuses a used code when a fresh gate asks for it. The tile handoff and real Cloud single-use behavior remain open. [“a rail open code becomes a gate session; the token never leaves the server”](../../server/test/gate-cloud.test.mjs#L214), [“a replayed open code is refused by the gate and by the Cloud service”](../../server/test/gate-cloud.test.mjs#L306), [“a code or token in a URL, a token in a header and a token in the form are refused”](../../server/test/gate-cloud.test.mjs#L325) |
| Fresh sign-in after removal and real Cloud operations | Cloud service only | C3.2 and C3.3 remain open. A deployed A/B sign-in must exercise real minting, exchange, renewal, and the revocation sender. Fresh sign-in after removal needs a mint refusal from Cloud. See U6–U11 and U16. [Isolation review](0024-isolation-review.md#3-where-isolation-rests-on-something-unverified) |
| Restore opens with the same Bots and chats | VM/Cloud only | C4.2 needs a backup and restore drill on the workspace VM and volume from C4.1. See U1. [Isolation review](0024-isolation-review.md#u1-the-per-workspace-vm-volume-and-network-blocking) |
| Private network, build host and other workspaces are unreachable from inside | VM/Cloud only | Run the VM probes with their positive controls and record them privately. See U1/U2 and P1–P6. [Isolation review](0024-isolation-review.md#5-the-probes-c43-must-run) |
| Workspace node is separate from the build host, and no agent account has `incus-admin` or root-equivalent access | VM/Cloud only | P11 records the account's groups and capabilities. Node identity requires a private host comparison. See U3. [Isolation review](0024-isolation-review.md#u3-the-node-is-not-the-build-host-no-root-equal-group-blocking) |
| Image digest comes from the release record | VM/Cloud only | Compare the digest running on the workspace VM with the digest in the release's own record. See U1 and I16. [Isolation review](0024-isolation-review.md#4-what-must-be-true-before-this-gate-can-be-called-done) |

The isolation review counts one repository probe (P14), eleven VM/Cloud probes (P1–P8 and
P11–P13), and two probes without a source of proof today (P9 and P10). See U4/U5 and U13 for the
remaining secret, limits and origin evidence. [Isolation review](0024-isolation-review.md#5-the-probes-c43-must-run)

## What a fake cannot prove

The fake implements the contract as understood by the gate. Interoperability needs a joint run
once C3.3 is available. The five-minute bound uses injected gate time. Delivery time for signed
calls and lists on a deployed network remains unmeasured.

C3.2, C3.3, C4.1 and C4.2, a private record naming the hosts, and the owner's sign-off remain
open for C4.3.
