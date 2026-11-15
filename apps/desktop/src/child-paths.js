import { fileURLToPath } from 'node:url'

export const CLOSE_INHERITED = fileURLToPath(
  new URL('./close-inherited-preload.cjs', import.meta.url),
)
export const DETACH_CLEAN = fileURLToPath(new URL('./detach-clean.cjs', import.meta.url))
