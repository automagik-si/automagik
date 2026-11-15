// Plain helpers for the Create Bot form, kept free of React so tests can load them.

export function freshBotName(roster, base = 'New Bot') {
  const taken = new Set(roster.bots.map(bot => bot.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  while (taken.has(`${base.toLowerCase()} ${index}`)) index += 1
  return `${base} ${index}`
}

// The form starts on the DSH default model when it is served, else the first one that is set
// up (a key, a sign-in or a signed-in agent; never a route a CLI covers). With
// none set up the form starts on no model.
const setUp = model => !model.needsKey && !model.needsSignIn && !model.covered && !model.needsAccount
export function startModel(roster) {
  const models = (roster.models ?? []).filter(setUp)
  return (models.find(model => model.ref === roster.defaultModel) ?? models.find(model => model.superseded !== true) ?? models[0])?.ref ?? ''
}

// The model is always sent: the host fixes it on the Bot at creation.
export function createPayload({ name, look, image, model, effort, brief, role, instructions }) {
  const payload = { name, color: look.color, avatar: image ? { shape: look.shape, image } : { shape: look.shape } }
  if (model) payload.model = model
  if (effort !== undefined) payload.effort = effort
  if (brief) payload.brief = brief
  if (role?.trim()) payload.role = role.trim()
  if (instructions?.trim()) payload.instructions = instructions.trim()
  return payload
}
