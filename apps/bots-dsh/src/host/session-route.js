// A route is readable only when both names are present after trimming.
export function readableRoute(config) {
  const provider = typeof config?.provider === 'string' ? config.provider.trim() : ''
  const model = typeof config?.model === 'string' ? config.model.trim() : ''
  return provider && model ? { ...config, provider, model } : null
}
