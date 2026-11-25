export const CHOOSE_CONCRETE = 'Choose a specific model for the Solver and its reviewer.'
export const CHOOSE_DIFFERENT = 'Choose a different model for the reviewer.'
export const REVIEWER_MODEL_CHOICE = 'Choose a specific model in the reviewer’s Details to verify its reviews.'

// LA-2 compares the underlying model across provider routes.
export function concreteModel(provider, model) {
  if (typeof model !== 'string') return undefined
  const slug = model.trim().toLowerCase().split(provider === 'acp-hermes' ? /[:/]/ : '/').at(-1)
  if (!slug || slug.endsWith('-latest') || /^(?:default|auto|latest|unknown|opus|sonnet|haiku|fable)(?:plan)?(?:\[1m\])?$/.test(slug)) return undefined
  // Friendly CLI model choices cannot prove a model identity.
  if (provider.startsWith('acp-') && !/^(?:claude|gpt|o[1-9]|gemini|deepseek|qwen|llama|mistral|grok)[.-][a-z0-9.-]*\d[a-z0-9.\[\]-]*$/.test(slug)) return undefined
  return slug.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')
    .replace(/^claude-(\d+-\d+)-(opus|sonnet|haiku)$/, 'claude-$2-$1')
}

export const RESULT_UNVERIFIED = Object.freeze({
  model: 'The reviewer’s effective model could not be verified.',
  same: 'The reviewer used the same model as the Solver.',
  verdict: 'The reviewer did not give a strict verdict.',
})

export const unverifiedReason = reason => typeof reason === 'string' && Object.hasOwn(RESULT_UNVERIFIED, reason) ? reason : undefined
export const unverifiedNotice = reason => unverifiedReason(reason)
  ? `[Automagik: RESULT review is unverified. ${RESULT_UNVERIFIED[reason]} Keep this request unmarked Done.]` : undefined

// Host feedback is its own input block. Keep the reviewer’s original message for
// records and rebuild the block only while the matching request still owns it.
export function originalReviewContent(message) {
  const { content, source } = message
  const notice = unverifiedNotice(source?.reviewFeedback)
  const tail = content?.at(-1)
  return notice && tail?.type === 'text' && tail.text === notice ? content.slice(0, -1) : content
}
