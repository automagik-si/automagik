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

// A field's own schema under its wrappers (optional, nullable, default, and the SDK's
// defaultOnError catch or pipe).
const unwrap = (schema) => {
  let s = schema
  for (;;) {
    const def = s?._zod?.def
    if (def?.innerType !== undefined) s = def.innerType
    else if (def?.type === 'pipe' && def.in !== undefined) s = def.in?._zod?.def?.type === 'transform' ? def.out : def.in
    else return s
  }
}
const shapeKeys = schema => Object.keys(unwrap(schema)?._zod?.def?.shape ?? {}).filter(key => key !== '_meta')

/**
 * Every capability under `root`, at any depth: `[id, type]`, where type is what the peer sends
 * for it (`object`: `{}` turns it on; `boolean`; `record`). A nested object is walked too, so a
 * capability inside one (fs.readTextFile, auth.terminal, elicitation.url) has its own decision.
 */
function capabilityIds(root, prefix) {
  const out = []
  const walk = (schema, path) => {
    const def = unwrap(schema)?._zod?.def
    for (const key of Object.keys(def?.shape ?? {})) {
      if (key === '_meta') continue
      const field = unwrap(def.shape[key])
      const type = field?._zod?.def?.type
      const id = `${prefix}:${[...path, key].join('.')}`
      out.push([id, type === 'boolean' ? 'boolean' : type === 'object' ? 'object' : type ?? 'unknown'])
      if (type === 'object') walk(field, [...path, key])
    }
  }
  walk(root, [])
  return out
}

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

// The capability objects a peer advertises: each walked from its root, at every depth.
const CAPABILITY_ROOTS = [['client-capability', 'zClientCapabilities'], ['agent-capability', 'zAgentCapabilities']]

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
  const add = (id, stable, type) => items.set(id, { id, stable: (items.get(id)?.stable ?? false) || stable, ...(type ?? items.get(id)?.type) === undefined ? {} : { type: type ?? items.get(id)?.type } })
  for (const [acp, stable] of [[unstableAcp, false], [stableAcp, true]]) {
    for (const id of methodNames(acp.methods.agent, 'method:agent')) add(id, stable)
    for (const id of methodNames(acp.methods.client, 'method:client')) add(id, stable)
    for (const id of methodNames(acp.methods.protocol ?? {}, 'method:protocol')) add(id, stable)
  }
  for (const [z, stable] of [[unstableZod, false], [stableZod, true]]) {
    for (const kind of updateKinds(z)) add(`update:${kind}`, stable)
    for (const [prefix, name] of CAPABILITY_ROOTS) for (const [id, type] of capabilityIds(z[name], prefix)) add(id, stable, type)
    for (const key of shapeKeys(z.zPromptResponse)) add(`prompt-response:${key}`, stable)
  }
  return { sdk, items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}

export const readPolicy = (path = POLICY_PATH) => JSON.parse(readFileSync(path, 'utf8'))

/**
 * The client capability object the implemented `client-capability:*` rows make: `{}` for an
 * object capability, `true` for a boolean one (`types`: id -> type, from the inventory).
 */
export function implementedClientCapabilities(policy, types = new Map()) {
  const out = {}
  for (const [id, row] of Object.entries(policy.features)) {
    if (row.status !== 'implemented' || !id.startsWith('client-capability:')) continue
    const path = id.slice('client-capability:'.length).split('.')
    let at = out
    for (const part of path.slice(0, -1)) at = (at[part] ??= {})
    at[path.at(-1)] ??= types.get(id) === 'boolean' ? true : {}
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
