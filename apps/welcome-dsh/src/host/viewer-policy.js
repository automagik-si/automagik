// Welcome uses POST for reads as well. Only the reads listed here can run without
// the mounted viewer. A sign-in poll can carry a provider's device code.
const READS = new Set([
  'state', 'ais', 'providers', 'companion', 'companion-image',
  'omni-plugins', 'genie-plugin', 'unfold-plugin', 'bot-type', 'migrate-status',
])

export const needsViewer = endpoint => !READS.has(endpoint)
