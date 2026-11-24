// History callers also need the model and reasoning effort to keep a whole route.
export const routeFields = config => ({
  provider: typeof config?.provider === 'string' ? config.provider.trim() : undefined,
  ...(typeof config?.model === 'string' ? { model: config.model.trim() } : {}),
  ...(config?.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
})

export const readableRoute = route => Boolean(route.provider && route.model)
