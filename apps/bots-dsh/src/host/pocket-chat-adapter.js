// The Session Controller adapter for Pocket chat (#517), imported only when the runtime has the
// methods (pocket-chat.js hasSessionApi). It speaks DSH 0.2.2-rc.2's Host Remote shapes
// (@deepseek-ai/dsh-api-session-controller lib/types/index.d.ts:166-215, types.d.ts:332-372, 386-473
// and 578-592) and imports no DSH package: the controller is the plugin's injected service.
//
// Every request names an ordinary Session address (`kind: 'session'`), never a subagent address.
// Reads: follow, events, state, observeState. Writes (RFC 0015's amendment), present only when the
// controller has them: one queued prompt with the phone's request id, and a cancel of the active
// turn. RFC 0033 prompts can cite staged image receipts. Nothing here calls updateQueue,
// steers a turn or raises a Remote event.

/** @param {any} controller  `ctx.sessionController` */
export function createAdapter(controller) {
  const address = sessionId => ({ kind: 'session', sessionId })
  return {
    // A passive follow (no `activate`), without the Web client's assistant frames.
    follow: (sessionId, signal) => controller.follow({ address: address(sessionId) }, signal),
    events: (sessionId, { beforeSeq, maxMessages } = {}, signal) => controller.events({
      address: address(sessionId),
      ...(Number.isSafeInteger(beforeSeq) ? { beforeSeq } : {}),
      ...(Number.isSafeInteger(maxMessages) ? { maxMessages } : {}),
    }, signal),
    state: (sessionId, signal) => controller.state({ sessionId }, signal),
    observeState: (sessionId, signal) => controller.observeState({ sessionId }, signal),
    ...(typeof controller.prompt === 'function' && typeof controller.cancel === 'function'
      ? {
          supportsReceipts: true,
          // `queue`, never `steer`: a phone message never redirects a running turn.
          prompt: (sessionId, { requestId, text, receipts }, signal) => {
            const content = receipts
              ? [...(text ? [{ type: 'text', text }] : []), ...receipts.map(receiptId => ({ type: 'file', receiptId }))]
              : [{ type: 'text', text }]
            return controller.prompt({ requestId, sessionId, mode: 'queue', content }, signal)
          },
          cancel: sessionId => controller.cancel({ sessionId }),
        }
      : {}),
  }
}
