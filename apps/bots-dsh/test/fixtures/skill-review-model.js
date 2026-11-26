export const CLEAN_REVIEW = '{"findings":[],"overflow":false}'

export const assembledReview = (answer = CLEAN_REVIEW, kind = 'stop') => ({
  finish: { kind },
  observedFinish: { kind },
  blocks: () => [{ type: 'text', text: answer }],
})

// Other features exercise their own model paths. Their Skills setup uses a
// clean, isolated reviewer, leaving the fixture's usual dispatch available.
export function stubSkillReviewer(rt) {
  rt.skillReviewModel = async () => 'fixture-review/standard'
  const assemble = rt.assembleLlm
  rt.assembleLlm = (request, options) => request.tools?.length === 0 && request.system?.startsWith('Review the supplied skill')
    ? Promise.resolve(assembledReview()) : assemble?.(request, options)
}
