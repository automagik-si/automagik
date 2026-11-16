// The Code side's renderer seam, free of React and the DOM: the chunk's name and the one load
// the body triggers. Kept apart so app-start behaviour is testable in Node, and so the main
// bundle never imports the pane or xterm.

/** The one chunk the pane lives in, beside client.js in the package. */
export const PANE_CHUNK = './client.pane.js'

let paneLoading = null

/**
 * Ask the DSH module loader for the pane's chunk. The loader's `require.async` is handed to the
 * bundle factory (build-client.mjs installs it as `globalThis.__dshChunk`). Resolves the chunk's
 * exports; a failed load is forgotten so a later press can try again.
 */
export function loadPane() {
  const load = globalThis.__dshChunk
  if (typeof load !== 'function') return Promise.reject(new Error('the client chunk loader is missing'))
  paneLoading ??= Promise.resolve(load(PANE_CHUNK)).catch((error) => {
    paneLoading = null
    throw error
  })
  return paneLoading
}
