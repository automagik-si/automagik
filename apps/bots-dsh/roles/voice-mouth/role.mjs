export function install(api) {
  api.registerTool('speak', ({ text }, ctx) => {
    if (!ctx.granted('audio-out')) throw new Error('Voice / Mouth may not speak until you allow it on the Bot’s role card.')
    return ctx.speak(text)
  })
}
