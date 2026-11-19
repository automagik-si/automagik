// The member wall's spelling table: every way of spelling a path down the side, the four ways
// a member uses a path across (read, list, search, skill load), each cell decided through DSH's
// real tools on a real cordis context. Imported by member-wall-spelling.test.js, and run by it
// as a script on a case-insensitive disk (`node member-wall-spelling-cells.mjs <dir>` prints
// the cells as JSON).
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as toolSearch from '@deepseek-ai/dsh-tool-fs-search'
import MemberWallFileSystem from '../src/host/member-wall/fs.js'
import { sessionScope } from '../src/host/member-wall/principals.js'

export const CANARY = 'held-canary 7f3a'
const NFC = 'café', NFD = 'café'

// The layout: an owner folder, a data folder (denied), a member area, and a shared root holding
// a denied folder (`held`, `café`) and a workspace-style link that points two levels up.
export function layout(root) {
  const at = {
    root, owner: join(root, 'owner'), data: join(root, 'dsh-home'), members: join(root, 'members'),
    ana: join(root, 'members', 'ana'), anabel: join(root, 'members', 'anabel'), shared: join(root, 'shared'),
  }
  const file = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
  for (const dir of [at.owner, at.data, join(at.ana, 'sub'), at.anabel, at.shared]) mkdirSync(dir, { recursive: true })
  for (const dir of [at.owner, at.data, join(at.shared, 'held'), join(at.shared, NFC), join(at.shared, 'vault'), at.anabel]) {
    file(join(dir, 'f.txt'), `${CANARY}\n`)
    file(join(dir, 'skill', 'SKILL.md'), `---\nname: s\ndescription: s\n---\n${CANARY}\n`)
  }
  for (const dir of [join(at.ana, 'sub'), join(at.shared, 'team'), join(at.shared, 'proj', 'packages', 'pkg')]) {
    file(join(dir, 'f.txt'), 'own canary\n')
    file(join(dir, 'skill', 'SKILL.md'), '---\nname: s\ndescription: s\n---\nown canary\n')
  }
  symlinkSync(at.owner, join(at.ana, 'owner-dir'))
  // A denied root configured as a link to the real folder.
  at.vaultLink = join(root, 'vault-link')
  symlinkSync(join(at.shared, 'vault'), at.vaultLink)
  // A denied root that does not exist when DSH starts.
  at.later = join(at.shared, 'later')
  symlinkSync(join(at.ana, 'sub'), join(at.ana, 'own-dir'))
  mkdirSync(join(at.shared, 'proj', 'node_modules', '@team'), { recursive: true })
  symlinkSync('../../packages/pkg', join(at.shared, 'proj', 'node_modules', '@team', 'pkg'))
  at.principals = join(root, 'principals.json')
  writeFileSync(at.principals, JSON.stringify({ version: 1, sessions: { 'session-ana': 'member:ana' } }))
  chmodSync(at.principals, 0o600)
  return at
}

// [row, denied folder spelled that way, the member's own folder spelled that way]. Each folder
// holds f.txt and skill/SKILL.md.
export const ROWS = at => {
  const pkg = join(at.shared, 'proj', 'node_modules', '@team', 'pkg')
  return [
    ['a link to a folder', join(at.ana, 'owner-dir'), join(at.ana, 'own-dir')],
    ['a link inside a shared root, then up', `${pkg}/../../../../dsh-home`, `${pkg}/../pkg`],
    ['another letter case', join(at.shared, 'HELD'), join(at.shared, 'TEAM')],
    ['a trailing slash', `${at.owner}/`, `${join(at.ana, 'sub')}/`],
    ['dot-dot', `${at.ana}/../../owner`, `${at.ana}/sub/../sub`],
    ['a doubled slash', `${at.root}//owner`, `${at.ana}//sub`],
    ['composed and decomposed accents', join(at.shared, NFD), join(at.shared, 'team')],
    ['a name that starts like the member', at.anabel, join(at.ana, 'sub')],
    ['a path that does not exist yet', join(at.owner, 'new'), join(at.ana, 'new')],
    ['a denied root configured as a link: its real folder', join(at.shared, 'vault'), join(at.shared, 'team')],
    ['a denied root configured as a link: through the link', at.vaultLink, join(at.ana, 'own-dir')],
  ]
}

export async function world(at) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(native)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: at.ana, additionalWritableRoots: [] }),
  })
  provideWorkingDirectoryFixture(ctx, at.ana)
  await ctx.plugin(MemberWallFileSystem, {
    cwd: at.ana, members: true, principalsFile: at.principals, membersRoot: at.members,
    sharedReadRoots: [at.shared], denyReadRoots: [at.data, join(at.shared, 'held'), join(at.shared, NFC), at.vaultLink, at.later],
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(toolFs, {})
  await ctx.plugin(toolSearch, { sampleOverCapGlobResults: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  return ctx
}

const agent = cwd => ({ id: 'session-ana', options: {}, session: { id: 'session-ana', header: { cwd }, requestHeader: () => undefined } })

async function tool(ctx, at, name, args) {
  const a = agent(at.ana)
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent: a, signal })
  try {
    const { result } = (await ctx.tools.execute({ calls: [{ id: 'c', name, arguments: args }], agent: a, signal, toolSet })).results[0]
    return result
  } finally {
    toolSet.dispose?.()
  }
}

// One cell. The verdict is the wall's own: for search the real grep tool's policy, for the rest
// the fence's decision on that path in the member's session. The real call is made too, and its
// output must never hold the denied canary.
const pathFor = (column, folder) => column === 'list' ? folder
  : `${folder.replace(/\/+$/, '')}/${column === 'read' ? 'f.txt' : 'skill/SKILL.md'}`

async function cell(ctx, at, column, folder) {
  if (column === 'search') {
    const text = JSON.stringify(await tool(ctx, at, 'grep', { pattern: 'canary', path: folder }))
    return { use: !/outside the files this member may search/.test(text), leaked: /7f3a/.test(text) }
  }
  if (column === 'read') {
    const text = JSON.stringify(await tool(ctx, at, 'read', { file_path: pathFor(column, folder) }))
    const use = await sessionScope.run({ sessionId: 'session-ana' }, () => ctx.fs.open(pathFor(column, folder), at.ana))
    return { use, leaked: /7f3a/.test(text) }
  }
  return sessionScope.run({ sessionId: 'session-ana' }, async () => {
    const path = pathFor(column, folder)
    let text = ''
    try {
      const target = await ctx.fs.resolve(path, { cwd: at.ana })
      text = column === 'list' ? JSON.stringify(await ctx.fs.listDir(target)) : await ctx.fs.readText(target)
    } catch {}
    return { use: ctx.fs.open(path, at.ana), leaked: /7f3a/.test(text) }
  })
}

// A search rooted at the shared root, spelled as configured and in another case: refused, since
// a denied folder lies below it. Its team folder below, in either case, has none: allowed.
export async function searchesByCase(ctx, at) {
  const grep = async path => {
    const text = JSON.stringify(await tool(ctx, at, 'grep', { pattern: 'canary', path }))
    return /7f3a/.test(text) ? 'LEAKED' : /outside the files this member may search/.test(text) ? 'refused' : 'allowed'
  }
  const upper = join(at.root, 'SHARED')
  return {
    shared: await grep(at.shared), sharedOtherCase: await grep(upper),
    team: await grep(join(at.shared, 'team')), teamOtherCase: await grep(join(upper, 'TEAM')),
  }
}

// A denied root made after DSH started, then deleted and made again: denied each time, for a
// read, a listing, a skill load and a search, read on each call and never cached at start.
export async function lateRoot(ctx, at) {
  const make = () => {
    rmSync(at.later, { recursive: true, force: true })
    mkdirSync(join(at.later, 'skill'), { recursive: true })
    writeFileSync(join(at.later, 'f.txt'), `${CANARY}\n`)
    writeFileSync(join(at.later, 'skill', 'SKILL.md'), `---\nname: s\ndescription: s\n---\n${CANARY}\n`)
  }
  const round = async () => {
    const out = {}
    for (const column of COLUMNS) {
      const c = await cell(ctx, at, column, at.later)
      out[column] = c.leaked ? 'LEAKED' : c.use ? 'allowed' : 'looks absent'
    }
    return out
  }
  make()
  const made = await round()
  make()
  return { made, remade: await round() }
}

export const COLUMNS = ['read', 'list', 'search', 'skill load']

export async function cells(root) {
  const at = layout(root)
  const ctx = await world(at)
  try {
    const out = []
    for (const [row, denied, own] of ROWS(at)) {
      for (const column of COLUMNS) {
        const d = await cell(ctx, at, column, denied)
        const o = await cell(ctx, at, column, own)
        const word = c => c.leaked ? 'LEAKED' : c.use ? 'allowed' : 'looks absent'
        out.push({ row, column, denied: word(d), own: word(o) })
      }
    }
    return { table: out, searches: await searchesByCase(ctx, at), late: await lateRoot(ctx, at) }
  } finally {
    await ctx.fiber.dispose()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(JSON.stringify(await cells(process.argv[2])) + '\n')
  process.exit(0)
}
