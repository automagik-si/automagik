import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The composer's model cell (src/client/composer-pack-cells.js) tells the model menu whether
// the chat on screen is the Bot's current part: only that part shows the running model.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { packModelCell } from './src/client/composer-pack-cells.js'",
      "export { registerComposerPack, composerPacks } from './src/client/extend.js'",
      "export { BUILTIN_PACKS } from './src/client/composer-packs.js'",
      "export { ModelMenu } from './src/client/model-menu.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const element = (type, props, ...children) => ({ type, props: props ?? {}, children })
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') {
      return {
        createElement: element, Fragment: 'Fragment',
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {}, useRef: () => ({ current: null }), useMemo: fn => fn(), useCallback: fn => fn,
      }
    }
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { packModelCell, registerComposerPack, BUILTIN_PACKS, ModelMenu } = module.exports
for (const pack of BUILTIN_PACKS) registerComposerPack(pack)

const bot = { id: 'bot-1', sessionId: 'part-2', name: 'Test Bot', model: 'deepseek-official/deepseek-v4', runningModel: 'deepseek-official/deepseek-flash' }
const roster = { ready: true, bots: [bot], byId: { [bot.id]: bot, 'part-2': bot, 'part-1': bot }, roomsById: {}, models: [] }
const env = { registrants: () => [] }
const menuOf = sessionId => packModelCell(env)({ sessionId, useRoster: pick => pick(roster), actions: {} })?.children[0]

test('the composer model cell marks only the Bot\'s current part as running', () => {
  const current = menuOf('part-2')
  assert.equal(current.type, ModelMenu)
  assert.equal(current.props.running, true)
  assert.equal(current.props.bar, true)
  const earlier = menuOf('part-1')
  assert.equal(earlier.type, ModelMenu)
  assert.equal(earlier.props.running, false)
})
