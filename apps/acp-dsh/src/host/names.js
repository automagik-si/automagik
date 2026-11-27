// Names that cross a process or a provider boundary, kept in one module so the bridge, the
// back-channel and the adapter cannot drift apart on them (RFC 0003, amendment, "The bridge").
// The server name is a contract: a Claude Code allow rule reads `mcp__dsh__*`.
export const BRIDGE_NAME = 'dsh'
export const HISTORY_TOOL_NAME = 'read_own_chat'
export const agyBridgeName = tool => `mcp_${BRIDGE_NAME}_${tool}`
export const ompBridgeName = tool => `mcp__${BRIDGE_NAME}_${tool}`
export const AGY_SKILL_TOOL = agyBridgeName('load_skill')
export const CREDENTIAL_ENV = 'DSH_BRIDGE_CREDENTIAL'
export const URL_ENV = 'DSH_BRIDGE_URL'
// The source marker of the tool-call block every bridge call adds as its v4 advertisement. It
// keeps that block out of provider history: the surface replaces it, and replay skips it.
export const SYNTHETIC_KIND = 'acp-bridge'

/** The structured tool name an MCP server's tool gets in the agent. */
export const mcpName = (server, tool) => `mcp__${server}__${tool}`

/** Whether a structured tool name belongs to the bridge. */
export const isBridgeName = (name, server = BRIDGE_NAME) => typeof name === 'string' && name.startsWith(`mcp__${server}__`)

// The failure code of a turn an agent refused because its CLI is not signed in (ACP's
// `auth_required`). The Bot team reads it by name: such a turn never moves to a fallback model
// and asks for a sign-in instead (bots-dsh, fallback.js and models.js).
export const MODEL_ACCESS_REQUIRED = 'MODEL_ACCESS_REQUIRED'
// The failure code of a turn the host stopped from outside the app: its agent process got the
// host's SIGTERM, or the agent cancelled its own prompt while the DSH turn was still live. The
// Bot team reads it by name (bots-dsh resume.js): the work was cut while running, so it is
// resumed after the restart instead of being marked failed.
export const AGENT_INTERRUPTED = 'AGENT_INTERRUPTED'
// ACP's `auth_required` error (RequestError.authRequired in the SDK): JSON-RPC -32000, whose
// message starts "Authentication required". -32000 alone is any server error.
const AUTH_REQUIRED_CODE = -32000

/** Whether an error an agent raised says its CLI must sign in first. */
export const isAuthRequired = error => error?.code === AUTH_REQUIRED_CODE && /^authentication required/i.test(String(error?.message ?? ''))
