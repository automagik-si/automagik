// The SDK feature inventory: every method, session update and capability the pinned
// `@agentclientprotocol/sdk` defines, read from its runtime exports (`methods` and the generated
// zod schemas of both the stable and the unstable entry), never from a hand-kept list. Each item
// says whether the stable schema has it. dev/acp-features.json is the plugin's decision for each
// one; test/acp-features.test.js fails on an item with no decision, on a decision for an item
// the SDK no longer has, and on a client capability sent that is not an implemented row.
//
//   node scripts/acp-features.mjs          print the inventory with each decision
//   node scripts/acp-features.mjs --json   the same, as JSON
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = resolve(import.meta.dirname, '..')
export const POLICY_PATH = join(PLUGIN, 'dev', 'acp-features.json')

const unwrap = (schema) => {
  let s = schema
  while (s?._zod?.def?.innerType !== undefined) s = s._zod.def.innerType
  return s
}
const shapeKeys = schema => Object.keys(unwrap(schema)?._zod?.def?.shape ?? {}).filter(key => key !== '_meta')

function updateKinds(z) {
  const kinds = new Set()
  const walk = (schema) => {
    const def = unwrap(schema)?._zod?.def
    if (def === undefined) return
    if (def.type === 'union') def.options.forEach(walk)
    else if (def.type === 'intersection') { walk(def.left); walk(def.right) }
    else if (def.type === 'object' && def.shape.sessionUpdate !== undefined) {
      const literal = unwrap(def.shape.sessionUpdate)._zod.def
      kinds.add(literal.values?.[0] ?? literal.value)
    }
  }
  walk(z.zSessionUpdate)
  return kinds
}

const methodNames = (tree, prefix) => Object.values(tree).flatMap(value => (typeof value === 'string' ? [`${prefix}:${value}`] : methodNames(value, prefix)))

// The capability objects a peer advertises, and where each sits.
const CAPABILITIES = [
  ['client-capability', 'zClientCapabilities'],
  ['client-capability:session', 'zClientSessionCapabilities'],
  ['client-capability:elicitation', 'zElicitationCapabilities'],
  ['agent-capability', 'zAgentCapabilities'],
  ['agent-capability:sessionCapabilities', 'zSessionCapabilities'],
  ['agent-capability:promptCapabilities', 'zPromptCapabilities'],
  ['agent-capability:mcpCapabilities', 'zMcpCapabilities'],
  ['agent-capability:auth', 'zAgentAuthCapabilities'],
]

/** The inventory of the SDK installed beside this plugin: `{ sdk, items: [{ id, stable }] }`. */
export async function inventory() {
  // The package exports no package.json: its root is found from its main entry.
  const require = createRequire(join(PLUGIN, 'package.json'))
  let root = dirname(require.resolve('@agentclientprotocol/sdk'))
  while (!root.endsWith(join('@agentclientprotocol', 'sdk'))) root = dirname(root)
  const sdk = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const load = path => import(pathToFileURL(join(root, path)).href)
  const [stableZod, unstableZod, stableAcp, unstableAcp] = await Promise.all([
    load('dist/v1/schema/zod.gen.js'), load('dist/v1/unstable/schema/zod.gen.js'),
    import('@agentclientprotocol/sdk'), import('@agentclientprotocol/sdk/unstable'),
  ])
  const items = new Map()
  const add = (id, stable) => items.set(id, { id, stable: (items.get(id)?.stable ?? false) || stable })
  for (const [acp, stable] of [[unstableAcp, false], [stableAcp, true]]) {
    for (const id of methodNames(acp.methods.agent, 'method:agent')) add(id, stable)
    for (const id of methodNames(acp.methods.client, 'method:client')) add(id, stable)
    for (const id of methodNames(acp.methods.protocol ?? {}, 'method:protocol')) add(id, stable)
  }
  for (const [z, stable] of [[unstableZod, false], [stableZod, true]]) {
    for (const kind of updateKinds(z)) add(`update:${kind}`, stable)
    for (const [prefix, name] of CAPABILITIES) for (const key of shapeKeys(z[name])) add(`${prefix}.${key}`.replace(/^([a-z-]+)\./, '$1:'), stable)
    for (const key of shapeKeys(z.zPromptResponse)) add(`prompt-response:${key}`, stable)
  }
  return { sdk, items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}

export const readPolicy = (path = POLICY_PATH) => JSON.parse(readFileSync(path, 'utf8'))

/** The client capability object the implemented `client-capability:*` rows make. */
export function implementedClientCapabilities(policy) {
  const out = {}
  for (const [id, row] of Object.entries(policy.features)) {
    if (row.status !== 'implemented' || !id.startsWith('client-capability:')) continue
    const path = id.slice('client-capability:'.length).split('.')
    let at = out
    for (const part of path.slice(0, -1)) at = (at[part] ??= {})
    at[path.at(-1)] ??= {}
  }
  return out
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { sdk, items } = await inventory()
  const policy = readPolicy()
  const rows = items.map(item => ({ ...item, ...(policy.features[item.id] ?? { status: 'NO DECISION' }) }))
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ sdk, rows }, null, 2)}\n`)
  else for (const row of rows) console.log(`${row.stable ? 'stable  ' : 'unstable'} ${row.status.padEnd(14)} ${row.id}`)
}
