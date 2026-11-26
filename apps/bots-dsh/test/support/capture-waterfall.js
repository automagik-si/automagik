import { Context } from '@deepseek-ai/cordis'

// Keep the fixture's services, but use Cordis to order and dispatch this event.
export function captureWaterfall(ctx, event) {
  const dispatch = new Context()
  const on = ctx.on
  ctx.on = (name, listener, options) => name === event
    ? dispatch.on(name, listener, options)
    : on(name, listener, options)
  ctx.effect(() => () => dispatch.fiber.dispose(), `test waterfall: ${event}`)
  return dispatch
}
