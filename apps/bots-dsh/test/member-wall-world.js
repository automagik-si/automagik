// The member wall's test world: a real cordis context with DSH's real file, search and skill
// tools, the read fence, and (when asked) the tool list. Shared by the member-wall tests.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFs from '@deepseek-ai/dsh-skill-filesystem'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as toolSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import MemberWallFileSystem from '../src/host/member-wall/fs.js'
import * as memberTools from '../src/host/member-wall/tools.js'

export const CANARY = 'OWNER-ONLY canary 7f3a'
// A 1x1 PNG.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

export function layout() {
  const root = mkdtempSync(join(tmpdir(), 'member-wall-'))
  const owner = join(root, 'owner')
  const members = join(root, 'members')
  const ana = join(members, 'ana')
  const shared = join(root, 'shared')
  const dshHome = join(root, 'dsh-home')
  for (const dir of [owner, ana, join(members, 'bo'), shared, dshHome]) mkdirSync(dir, { recursive: true })
  const skill = (dir, name) => {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${name === 'owner-notes' ? CANARY : 'ana body'}\n`)
  }
  writeFileSync(join(owner, 'secret.txt'), `${CANARY}\n`)
  writeFileSync(join(owner, 'secret.png'), PNG)
  skill(join(owner, 'skills'), 'owner-notes')
  writeFileSync(join(ana, 'notes.txt'), 'ana canary\n')
  writeFileSync(join(ana, 'pic.png'), PNG)
  skill(join(ana, 'skills'), 'ana-notes')
  writeFileSync(join(members, 'bo', 'bo.txt'), 'bo canary\n')
  writeFileSync(join(shared, 'team.txt'), 'shared canary\n')
  mkdirSync(join(shared, 'held'))
  writeFileSync(join(shared, 'held', 'held.txt'), `${CANARY}\n`)
  symlinkSync(join(owner, 'secret.txt'), join(ana, 'link.txt'))
  symlinkSync(owner, join(ana, 'owner-dir'))
  const principals = join(root, 'principals.json')
  const record = (sessions, mode = 0o600) => {
    writeFileSync(principals, JSON.stringify({ version: 1, sessions }))
    chmodSync(principals, mode)
  }
  record({ 'session-owner': 'owner', 'session-ana': 'member:ana' })
  return { root, owner, members, ana, shared, dshHome, principals, record }
}

export async function world(t, places, { members = true, skillTool = true, tools } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(native)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: places.ana, additionalWritableRoots: [] }),
  })
  provideWorkingDirectoryFixture(ctx, places.ana)
  // The tool list loads first, as an earlier profile row would; its `tools` config is merged in.
  if (tools !== undefined) await ctx.plugin(memberTools, { members, principalsFile: places.principals, ...tools })
  await ctx.plugin(MemberWallFileSystem, {
    cwd: places.ana,
    members,
    principalsFile: places.principals,
    membersRoot: places.members,
    sharedReadRoots: [places.shared],
    denyReadRoots: [places.dshHome, join(places.shared, 'held')],
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(skillFs, {
    includeDefaultRoots: false, dshHome: places.dshHome, agentsHome: places.dshHome, watch: false,
    customSkillDirs: [join(places.owner, 'skills'), join(places.ana, 'skills')],
  })
  ctx.provide('agents', { list: () => [], get: () => undefined })
  // Stand-ins for the image path: a route that takes images and an attachment store.
  ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) })
  ctx.provide('attachments', {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1 << 20, maxMessageImageBytes: 1 << 20 },
    saveImage: async ({ data, mediaType }) => ({ attachmentId: 'a1', mediaType, bytes: data.length, width: 1, height: 1 }),
  })
  await ctx.plugin(toolFs, {})
  await ctx.plugin(toolSearch, { sampleOverCapGlobResults: false })
  if (skillTool) await ctx.plugin(toolSkill, {})
  await new Promise(resolve => setTimeout(resolve, 0))
  for (const name of ['fs', 'tools', 'skills', 'subprocess']) assert.ok(ctx.get(name), `${name} is mounted`)
  return ctx
}

// The shape of a dsh-agent Agent: its id is its session's id.
export const agentFor = (sessionId, cwd) => ({
  id: sessionId,
  options: { provider: 'test', model: 'test' },
  session: { id: sessionId, header: { cwd }, requestHeader: () => undefined },
})

export async function call(ctx, sessionId, cwd, name, args) {
  const agent = agentFor(sessionId, cwd)
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, signal })
  try {
    const batch = await ctx.tools.execute({ calls: [{ id: 'c1', name, arguments: args }], agent, signal, toolSet })
    const { result } = batch.results[0]
    return { error: result.isError === true, text: JSON.stringify(result) }
  } finally {
    toolSet.dispose?.()
  }
}

// Refused by the wall itself, not by some other failure on the way: to a member a path out of
// its reach looks absent (the same path reads for the owner, so it is there), a search over it
// is refused, and a skill out of its reach is not listed for it, so it reads as unknown.
export const refused = (out, label, wall = /not found|outside the files this member may search/) => {
  assert.equal(out.error, true, `${label}: refused`)
  assert.match(out.text, wall, `${label}: by the wall (${out.text.slice(0, 300)})`)
  assert.doesNotMatch(out.text, /7f3a/, `${label}: no owner content`)
}
export const allowed = (out, label, pattern) => {
  assert.equal(out.error, false, `${label}: allowed (${out.text.slice(0, 300)})`)
  if (pattern) assert.match(out.text, pattern, label)
}
