// The flag the web self-update preview lives behind (issue 1540): the page is opened with
// `?mock-1540`, or with `#mock-1540`, and the preview and the layout that shows it appear.
//
// #1546 owns the preview and reads this same flag in self-update-mock.js (`MOCK_FLAG` and the
// check at the top of `installSelfUpdateMock`). The layout cannot import that module: it carries
// the preview's CSS, its DOM mount and its timers, and it only exists on #1546's branch, so the
// bar would fail to load until that PR lands. This is the smallest form of the same predicate,
// with the same name and the same expression; when both have landed, one can import the other.
export const MOCK_FLAG = 'mock-1540'

/** Whether this page was opened with `?mock-1540` (or `#mock-1540`). Read at render time. */
export function mock1540On(location = globalThis.location) {
  const search = typeof location?.search === 'string' ? location.search : ''
  const hash = typeof location?.hash === 'string' ? location.hash : ''
  return new RegExp(`(?:[?&])${MOCK_FLAG}(?:=|&|$)`).test(search) || hash.includes(MOCK_FLAG)
}
