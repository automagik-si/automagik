// Welcome uses POST for reads as well. New actions require a viewer unless
// they only read status and are listed here.
const READS = new Set([
  'state', 'ais', 'providers', 'signin-status', 'companion', 'companion-image',
  'omni-plugins', 'genie-plugin', 'unfold-plugin', 'bot-type', 'migrate-status',
])

export const needsViewer = endpoint => !READS.has(endpoint)
