// The flag the web self-update preview lives behind (issue 1540): the page is opened with
// `?mock-1540`, or with `#mock-1540`, and the preview and the layout that shows it appear.
//
// The preview and the sidebar layout both import this predicate.
export const MOCK_FLAG = 'mock-1540'

/** Whether this page was opened with `?mock-1540` (or `#mock-1540`). Read at render time. */
export function mock1540On(location = globalThis.location) {
  const search = typeof location?.search === 'string' ? location.search : ''
  const hash = typeof location?.hash === 'string' ? location.hash : ''
  // A query parameter of its own: `?next=/x?mock-1540` names only `next`, so it does not count.
  return search.replace(/^\?/, '').split('&').some(part => part.split('=')[0] === MOCK_FLAG)
    || new RegExp(`(?:^#|&)${MOCK_FLAG}(?:=|&|$)`).test(hash)
}
