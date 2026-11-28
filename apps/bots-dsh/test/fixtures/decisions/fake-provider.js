import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REF = 'FAKE_DECISIONS_KEY'
export const KEY = 'synthetic-decisions-credential'
export const model = 'fake/model'
export const routing = (overrides = {}) => ({
  purpose: 'group-routing', rubricVersion: 'group-routing/1', state: 'synthetic routing state',
  questions: [{ kind: 'multi-select', id: 'concerns', instructions: 'Who needs to act?',
    options: [{ id: 'a', description: 'Build maintainer' }, { id: 'b', description: 'Docs maintainer' }] }],
  deadlineMs: 1000, ...overrides,
})
export const answer = (call, p = 0.8) => ({
  answeredModel: call.model, answers: call.questions.map(({ id, kind }) => ({ id, kind, p })),
})

export function fakeProvider({ id = 'fake', info, evaluate = answer } = {}) {
  const calls = []
  const provider = {
    info: {
      id, name: id, vendor: 'Fake', endpoint: 'https://fixture.invalid/decisions', protocol: 'system-one',
      location: 'cloud', models: [{ id: model }], limits: { maxQuestions: 64, maxOptions: 255, maxLevels: 10 },
      yesNoRange: [0, 1], calibrated: true, stateTruncation: 'rejects',
      privacy: { zdr: 'default', training: 'no', docs: 'https://fixture.invalid/privacy' }, ...info,
    },
    async evaluate(call, key, signal) {
      calls.push({ call, key, signal })
      return evaluate === answer ? answer(call) : evaluate(call, key, signal)
    },
  }
  return { provider, calls }
}

export async function mount(t, config = {}, credentials) {
  const root = new Context()
  const dir = mkdtempSync(join(tmpdir(), 'bot-decisions-'))
  t.after(async () => {
    await root.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  if (credentials) root.provide('credentials', credentials)
  const writes = []
  const presentations = new Map()
  await root.plugin(Loader, {})
  root.provide('settings', {
    configure(policy, owner) {
      presentations.set(owner.entry.options.id, policy)
      return () => { presentations.delete(owner.entry.options.id) }
    },
    async update(id, patch) {
      writes.push({ id, patch: structuredClone(patch) })
      const raw = root.loader.resolve(id).options.config
      const config = { ...raw, ...patch, providerConfig: { ...raw.providerConfig, ...patch.providerConfig },
        purposes: { ...raw.purposes, ...patch.purposes } }
      await root.loader.update(id, { config })
    },
  })
  await root.loader.create({ id: 'decisions', name: new URL('../../../decisions.js', import.meta.url).href,
    config: { ledger: { dir }, ...config } })
  await root.loader.await()
  const decisions = root.get('decisions')
  const files = () => Object.fromEntries(readdirSync(dir).sort().map(file => [file, readFileSync(join(dir, file), 'utf8')]))
  const rows = () => Object.values(files()).flatMap(data => data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
  return { decisions, root, dir, writes, presentations, rows, files }
}
