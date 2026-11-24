// The Settings > Bot model picker's wiring, apart from the form so a test can hold the
// crossing decision: a saved Bot sends a crossing to switchRoute, never an in-place updateBot;
// it asks only while a reply runs; a same-route pick still updates the Bot's model.
export function settingsModelPicker({ bot, roster, actions, run, onFailure = () => () => {} }) {
  const pickModel = ref => run(actions.updateBot(bot.id, { model: ref }).catch(onFailure(ref)))
  // `sending` ({ stopReply: true }): the person's Switch on the running question. A reply the
  // menu did not see running goes back to the menu, which asks (reason reply-running).
  const pickRoute = (ref, patch = {}, sending) => Promise.resolve(sending === undefined
    ? actions.switchRoute(bot.id, ref, patch) : actions.switchRoute(bot.id, ref, patch, sending))
    .then(value => run(Promise.resolve(value)), (error) => {
      if (error?.reason === 'reply-running' && sending?.stopReply !== true) throw error
      return run(Promise.reject(error).catch(onFailure(ref)))
    })
  const pick = (ref, { routeChange = false, effort } = {}, sending) => (routeChange
    ? pickRoute(ref, effort === undefined ? {} : { effort }, sending)
    : (ref !== (bot.model ?? bot.appliedModel) || !bot.model ? pickModel(ref) : undefined))
  return { bot, roster, actions, run, saved: true, onPick: pick }
}
