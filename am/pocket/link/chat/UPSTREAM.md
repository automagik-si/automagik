# Upstream: Orca

Parts of this folder are ported from [Orca](https://github.com/stablyai/orca) (MIT, © 2026 Lovecast
Inc.; its notice is `LICENSE-upstream`, repeated in `herdr/NOTICE`). The folder is Apache-2.0 as a
derived work. RFC 0015 (`docs/rfcs/0015-live-chat-projection.md`, D31) decided what is taken.

**Commit:** `e1dfc022bd9fb9c49ea831f65d631f4c21405edb`. Its parent `ec3a707` is where the research
read these files; `e1dfc022` changes none of them, so the blob ids below are the same at both.

We own the copies. Nothing fetches Orca, in CI or at runtime. An upstream fix is pulled by hand, as
a herdr patch, when a decoder breaks on a new agent version or Orca fixes something we hit: diff the
upstream file's blob against the id here, port the change, and update the row.

## Files

TypeScript became JavaScript with JSDoc types; the code is otherwise as upstream unless the
"Changed" column says so. Each of our files names its upstream paths in its header.

| Ours | Upstream path | Blob | Changed |
|---|---|---|---|
| `decode-claude.js` | `src/main/native-chat/transcript-line-decoders-claude.ts` | `8dc8ad2c9b9b12b5c35e53ab2ec1fa6cbc1fed6f` | Stop-hook row through `claudeStopHookFeedbackBlock` (below) |
| `decode-codex.js` | `src/main/native-chat/transcript-line-decoders-codex.ts` | `09c975ce3850d0722756826021edb9250f8a4623` | — |
| `decode-omp.js` | `src/main/native-chat/transcript-line-decoders-omp.ts` | `ce6903a8587d4d86041a16e341f5a06b0aa22cad` | — |
| `decode-shared.js` | `src/main/ai-vault/session-scanner-record-value.ts` | `bd2c9b6326d576fd4a219452eac864b55305ab46` | — |
| | `src/main/ai-vault/session-scanner-values.ts` | `bb98084db41e227e068b6c2ed62799267d86b27b` | Only `timestampMs`, `parseJsonObject`, `extractString`; each decoder's private `parseTimestamp` shared here |
| | `src/main/native-chat/transcript-record-blocks.ts` | `1ccb0b2c431d7ce2430f418223e1e7559c1bc36e` | — |
| | `src/shared/claude-pasted-content.ts` | `32c06438e0ffdbfe82d7e0db7fdde45239165818` | — |
| | `src/shared/claude-bash-input.ts` | `da0c839429f4cf04134c77f38ed33f8ede8e83f6` | — |
| | `src/main/native-chat/transcript-turn-markers.ts` | `96d43748b6b20a75e3a393789a1d8eb2a2de5abe` | — |
| | `src/main/claude/claude-stop-hook-feedback.ts` | `c889a15bf022db2f4a21ece958a1545809e0d441` | `claudeStopHookFeedbackRow`, folded with the two below into `claudeStopHookFeedbackBlock`, which returns the text block directly |
| | `src/shared/agent-session/journal/agent-session-hook-outcome.ts` | `15b273912094d2d6271654b0dff1fcb347e09e77` | Only `hookOutcomeRowBody` for `sent-back` |
| | `src/shared/agent-session/view/structured-agent-session-status-block.ts` | `8574f59886c7de5140d5a55c373eb84784d87b7c` | Failure, stop and provider-frame fields left out: a Stop-hook row never has them |
| | `src/shared/native-chat/transcript/native-chat-image-transcript-markers.ts` | `da994b9f5ccf4f8c3aa37d3faf51430a01aea93c` | Only `imageSourcePathFromText` |
| | `src/shared/native-chat/native-chat-notice.ts` | `efab1e443ac45faae313ed8a79867f27657e3b76` | Only `NATIVE_CHAT_NOTICE_COPY.compaction` |
| | `src/shared/image-data-uri.ts` | `2fb5f5d126b28113c39f4cec4c175f530b9d93db` | Only `buildImageDataUri`, without Orca's oversized-raster check (our clients never decode an image by themselves) |
| `types.js` | `src/shared/native-chat/native-chat-types.ts` | `aff3425fe4e78a32e0155df833618ac1b00b0b02` | Only what the decoders produce, plus sources, roles, turn lifecycle, session status and the block guards; structured-session fields left out |
| | `src/shared/agent-status-types.ts` | `fd8a36c6ec7f40f48f05b144c07ea6578ecbea5a` | Only `AGENT_STATUS_STATES` and `AgentType` |
| | `src/shared/agent-session/agent-session-context-usage.ts` | `bab83a0a12eaf44f8c28968d3172792f9ff51cc6` | Only `AgentSessionTokenUsage` |
| `paste.js` | `src/shared/native-chat/input/native-chat-paste-bytes.ts` | `7b9cd53f5f719a233c96b7a7b23d281a5c5b4696` | Image-path paste left out |
| | `src/shared/terminal-bracketed-paste-text.ts` | `425dcbd8d5853d3cf7213b770bc15695f16445d7` | — |
| | `src/shared/terminal-input.ts` | `bdaa410d04b6f0c64e1f764d142f50df8dd2b62f` | Only `getTerminalInputByteLength`, measured with `Buffer.byteLength` |
| `answer.js` | `src/shared/native-chat/native-chat-agent-support.ts` | `4220a883a31cd8afcccdb7632a76e30938e1fdc1` | Only the predicates the engine uses and `resolveNativeChatTranscriptAgent`; Orca's TUI agent list left out. `approvalKeys` (ours) maps its bytes to herdr-core key names |
| | `src/shared/native-chat/input/native-chat-approval-envelope.ts` | `1a979c9af0b8b1ce55bb4b30e507e5e8a7c442de` | — (read by delivery 8's hook) |
| | `src/shared/native-chat/input/native-chat-answer-stepping.ts` | `849698260ea58a211d517d2c3710b6fe680e411a` | `scheduleNativeChatAnswer` takes the timers to use |
| `screen.js` | `src/renderer/src/components/native-chat/native-chat-scrape-fallback.ts` | `d40db3b76c0b713d9a1cbeb9c2434328be82e1d4` | `screenMessages` added (ours): herdr-core's `terminal.read` in |

Tests ported to `node:test` (cases that exercise Orca code not taken are left out; fixtures are our
own, synthetic):

| Ours | Upstream path | Blob |
|---|---|---|
| `paste.test.mjs` | `src/shared/native-chat/input/native-chat-paste-bytes.test.ts` | `bb7c5cad6701dec09793584b8937becff83eec1e` |
| `decode-omp.test.mjs` | `src/main/native-chat/transcript-line-decoders.omp.test.ts` | `4fc0f03e1ab881dff540c12e5a7afada21691d3a` |
| `answer.test.mjs` | `src/shared/native-chat/input/native-chat-approval-envelope.test.ts` | `48c21300b2af750a14b22d8a52cd8d1734fd2415` |
| `decode-claude.test.mjs` | `src/main/native-chat/transcript-line-decoders-claude-control-bytes.test.ts` | `404c3b403ce5317ddda7cae671fb45ac099f2037` |
| | `src/main/native-chat/transcript-line-decoders-claude-image-companion.test.ts` | `0e6e66413093d30779ac1883ffc32cd0fad22a96` |
| | `src/main/native-chat/transcript-line-decoders-claude-pasted-content.test.ts` | `84dc3c68ed1455be4bd7975c22057de6ad9f6879` |
| | `src/main/native-chat/transcript-line-decoders-claude-queued-prompt.test.ts` | `543d923f84551cafecb18b053c41ce16821218c3` |
| | `src/main/native-chat/transcript-line-decoders-claude-stop-hook.test.ts` | `733baa0602bec79dd40f3fbd3f6553b1690bb179` |

`decode-codex.test.mjs` and `screen.test.mjs` are ours: Orca has no direct test of those files.

## Ours, not Orca's

`folder-rule.js` (the transcript folder rule, t2x5's), `cleanChatText` in `paste.js` (RFC 0015's
cleaning rule), the RFC's row model in `types.js`, and the engine's read side (delivery 3a):
`hc.js` (the seam to herdr-core), `find.js`, `tail.js`, `status.js`, `rows.js`, `projection.js`,
with `fake-hc.mjs` for tests; and its write side (delivery 3b): `dialog.js`, `approve.js`,
`input.js`, `engine.js`. The folder rule's cases live in
`herdr/test/fixtures/transcript-folder-rule.json`, shared with am-sidebar's copy of the rule.
