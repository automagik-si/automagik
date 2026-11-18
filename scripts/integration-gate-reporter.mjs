/**
 * Runner events for integration-gate.mjs, without test stdout or diagnostics. Apache-2.0.
 * These fields are available on Node 22.7 and 24.9; only per-file summaries prove completion.
 */
const recorded = new Set(["test:pass", "test:fail", "test:plan", "test:summary"]);

export default async function* integrationGateReporter(source) {
  for await (const { type, data } of source) {
    if (!recorded.has(type)) continue;
    const row = {
      type,
      file: data.file,
      name: data.name,
      nesting: data.nesting,
      skip: data.skip,
      todo: data.todo,
      counts: data.counts,
      success: data.success,
    };
    if (type === "test:fail") {
      const error = data.details?.error;
      row.error = String(error?.message ?? "test failed").split("\n")[0].slice(0, 300);
      // Node separates cancelled results from failures in summary counts.
      row.failureType = error?.failureType;
    }
    yield `${JSON.stringify(row)}\n`;
  }
}
