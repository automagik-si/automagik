// A net around a test's wait for an event that must arrive. The awaited state is the proof;
// this bound only turns an event that never comes into a failing test, in seconds, instead of
// a file that waits until a job's outer cap ends it. `where` names the file and row, `what`
// names the event, so the failure log says which event never arrived and where to look.
//
// 10 s: the guarded rows finish in single-digit ms unloaded (discover's ordering row: 164 ms
// unloaded and 183 ms under 31 busy processes; the dead row: 61-64 ms; the held-answer row and
// the proxy's terminal.list answer: a few ms), and the slowest converted row in this PR under
// 96 busy processes took 2.2 s. Ten seconds is a wide margin over load, not a timing
// assertion: no row's pass/fail may depend on this number.
export const EVENT_NET_MS = 10_000;

/**
 * `promise`, or a rejection naming `what` and `where` once `ms` passes.
 * The timer is cleared when the event arrives, so a passing test leaves no timer behind.
 */
export function bounded(promise, what, { ms = EVENT_NET_MS, where = "this test" } = {}) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${where}: ${what} did not arrive within ${ms} ms; a test that waits for an event must fail, not hang`)), ms);
  });
  return Promise.race([Promise.resolve(promise), expired]).finally(() => clearTimeout(timer));
}
