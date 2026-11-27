export const CHOOSE_CONCRETE = 'Choose a specific model for the Solver and its reviewer.'
export const CHOOSE_DIFFERENT = 'Choose a different model for the reviewer.'
const CLAUDE_PINS = Object.freeze({
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-2',
  haiku: 'claude-haiku-5-5',
})

// The chosen route identifies a review. Dispatch still uses the original ref.
export function chosenIdentity(provider, model) {
  const agent = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  const id = typeof model === 'string' ? model.trim().toLowerCase().replace(/\[1m\]$/, '') : ''
  if (!agent || agent.includes('/') || !id) return undefined
  const chosen = agent === 'acp-claude' && Object.hasOwn(CLAUDE_PINS, id) ? CLAUDE_PINS[id] : id
  return `${agent}/${chosen}`
}

export function chosenIdentityOf(ref) {
  const slash = typeof ref === 'string' ? ref.indexOf('/') : -1
  if (slash > 0) return chosenIdentity(ref.slice(0, slash), ref.slice(slash + 1))
}

const MODEL_UNVERIFIED = 'The reviewer’s effective model could not be verified.'
export const RESULT_UNVERIFIED = Object.freeze({
  model: MODEL_UNVERIFIED,
  held: MODEL_UNVERIFIED,
  same: 'The reviewer used the same model as the Solver.',
  verdict: 'The reviewer did not give a strict verdict.',
  images: 'The result has pictures and the reviewer could not see them.',
})

export const unverifiedReason = reason => typeof reason === 'string' && Object.hasOwn(RESULT_UNVERIFIED, reason) ? reason : undefined
export const RESULT_IMAGES_UNVERIFIED = Object.freeze({
  unseen: RESULT_UNVERIFIED.images,
  lost: 'The reviewer’s answering turn lost the result pictures. Ask for a fresh RESULT review with the pictures.',
  missing: 'The result pictures were not all carried. Ask for a fresh RESULT review with the pictures.',
})
export const unverifiedText = (reason, imagesWhy) => reason === 'images' && Object.hasOwn(RESULT_IMAGES_UNVERIFIED, imagesWhy)
  ? RESULT_IMAGES_UNVERIFIED[imagesWhy] : RESULT_UNVERIFIED[reason]
export const unverifiedNotice = (reason, imagesWhy) => unverifiedReason(reason)
  ? `[Automagik: RESULT review is unverified. ${unverifiedText(reason, imagesWhy)} Keep this request unmarked Done.`
    + (reason === 'held' ? ' Ask the designated reviewer once more on the same checked work.]' : ']')
  : undefined

// Host feedback is its own input block. Keep the reviewer’s original message for
// records and rebuild the block only while the matching request still owns it.
export function originalReviewContent(message) {
  const { content, source } = message
  const notice = unverifiedNotice(source?.reviewFeedback, source?.reviewImagesWhy)
  const tail = content?.at(-1)
  return notice && tail?.type === 'text' && tail.text === notice ? content.slice(0, -1) : content
}
