// Learning from work. After a long turn a Bot's chat is marked for review. When the
// team has been idle for a while, and at most every few hours, one background pass
// reads what was said since the last pass and asks whether it taught a skill worth
// keeping or a lasting project rule. Most work teaches nothing, so most passes
// propose nothing. A proposal waits as a card in the Bot's chat until approved, and
// declined changes are remembered so the same idea does not come back.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { replaceFile } from './files.js'
import { looksLikeKey, looksSecret, writtenIn } from './memory.js'
import { CONNECTOR_IDS, validateCapabilityName } from './capabilities.js'
import { credentialShapes } from './redact.js'
import { refusal } from './refusal.js'
import { skillRefusal } from './skill-keys.js'
import { skillHashId } from './skill-store.js'

export const LEARNING = {
  minTurnMs: 3 * 60_000,
  idleMs: 10 * 60_000,
  intervalMs: 12 * 60 * 60_000,
  tickMs: 60_000,
  readMs: 15_000,
  textMax: 24_000,
  userTextMax: 8_000,
  userLineMax: 2_000,
  botLineMax: 1_200,
  learnedMax: 5,
  descriptionMax: 300,
  contentMax: 8_000,
  declinedMax: 20,
  agentsFileMax: 16_000,
  agentsEditMax: 400,
}

const CLIPPED = ' […]'
const clip = (text, max) => (text.length > max ? text.slice(0, max) + CLIPPED : text)
export const hashOf = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)

// The answer of the review's model: one JSON object, perhaps in a code fence.
export function parseJson(text) {
  const raw = String(text ?? '').trim()
  // A skill's content may hold code fences of its own, so read the whole answer first
  // and fall back to a fenced block only when that fails.
  const fenced = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(raw)?.[1]
  for (const candidate of [raw, fenced]) {
    if (candidate === undefined) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end < start) continue
    try {
      const value = JSON.parse(candidate.slice(start, end + 1))
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {}
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The skill review.

export function skillSystem() {
  return [
    'You review a stretch of finished work by an AI Bot and decide whether it taught a skill worth keeping.',
    'A skill is a short document that a future Bot loads when a task of the same class comes up. Strong models already do most tasks well without one, so a weak or narrow skill only adds noise. Most work teaches nothing new: answer "none" unless every test below passes.',
    '',
    'Tests:',
    '1. Reusable: tasks of this class will come up again in later, different work. A rule that only fits this task, file, bug, or pull request fails.',
    '2. Missing knowledge: it gives constraints or context that a capable model does not have or gets wrong: requirements and corrections the user stated, project or tool conventions found by trial and error, pitfalls that cost time, how this user wants the result checked or delivered. General know-how fails, and so does anything that reading the code or the docs shows at once.',
    '3. Earned: the work shows it. The user asked for it or corrected the Bot, or a non-obvious way was found after one that failed. Never invent rules the work did not show.',
    '4. Not covered: no listed skill already says it. When a learned skill of this Bot covers the class, update that skill instead of making a new one. Also update a learned skill that the work showed to be wrong, outdated, or missing a step.',
    '',
    'Never put in a skill: one-off facts, task progress, file lists, dates, version, pull request or issue numbers, pasted errors or logs, facts about the user that are not about how to work (memory keeps those), or keys, passwords, and tokens.',
    'Write rules that stand alone, not the story of this work: a reason says why the rule matters, never when or how it was broken ("the user corrected this before", "version 1.2 missed it"). Examples must be general: do not name the files, functions, values, or fixes that this work happened to touch, not even as an example, and write a placeholder such as `<file>:<line>` instead; name something only when the rule is about it, such as a check the user wants run.',
    '',
    'Form:',
    '- name: the class of task, lowercase letters, digits, and single hyphens, 32 characters at most, e.g. "release-checks", never "fix-login-bug".',
    '- description: one sentence, 200 characters at most, that says when to use the skill. Be concrete about the trigger.',
    '- content: Markdown, 600 words at most. The rules as short imperative lines, each with a brief reason when it is not obvious; numbered steps only where order matters; how to check the work is done. Keep what is still true when you update, and remove what the work showed to be wrong.',
    '',
    'Answer with one JSON object only, one of:',
    '{"action":"none","reason":"<one sentence>"}',
    '{"action":"create","name":"…","description":"…","content":"…","why":"<one sentence: what in this work shows the skill is needed>"}',
    '{"action":"update","name":"<a learned skill listed>","description":"…","content":"<the whole new content>","why":"<one sentence>"}',
  ].join('\n')
}

// `learned`: this Bot's learned skills, in full. `library`: every other skill on the
// team, by name and description. `declined`: proposals the user turned down.
export function skillRequest({ bot, lines, learned = [], library = [], declined = [], language, limit = LEARNING.learnedMax }) {
  const parts = [`The Bot: ${bot.name}${bot.role ? `, ${bot.role}` : ''}.`]
  parts.push(learned.length === 0
    ? 'This Bot has no learned skills yet.'
    : `This Bot's learned skills (${learned.length} of ${limit}${learned.length >= limit ? '; at the limit, only update one' : ''}):\n${learned.map(skill => `<skill name="${skill.name}">\ndescription: ${skill.description}\n${skill.content}\n</skill>`).join('\n')}`)
  if (library.length > 0) parts.push(`Other skills on the team:\n${library.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')}`)
  if (declined.length > 0) parts.push(`Proposals the user declined. Do not propose them again unless this work shows something new:\n${declined.map(entry => `- ${entry.name}: ${entry.description}`).join('\n')}`)
  if (language) parts.push(`Write the description and the content in ${language}.`)
  parts.push(`The work, oldest first ("User:" lines are the user's own words):\n<work>\n${lines.join('\n')}\n</work>`)
  return parts.join('\n\n')
}

export function agentsSystem() {
  return [
    'You review a stretch of finished work that AI Bots did in one project folder, and decide whether the project\'s AGENTS.md should change.',
    'Every agent that works in this folder reads AGENTS.md at the start of every task. So each line costs attention on every task: a file that is short and current helps; a long or stale one hurts. Most work should change nothing: answer "none" unless a change passes every test below.',
    '',
    'What belongs in AGENTS.md:',
    '- How the user wants agents to work here: requirements, rules, and corrections the user stated, especially ones the user had to repeat.',
    '- How the user wants to be talked to: language, length, format, what to report.',
    '- Things to always do and never do in this project, with a short reason when it is not obvious.',
    '- Project facts an agent needs on almost every task and cannot see at once from the code: the command that checks the work, a folder that must not be touched, a step that must come before a commit or a push.',
    '',
    'Tests for each change:',
    '1. Almost every task: the rule matters to most future work in this folder, not to one kind of task. A procedure for one kind of task belongs in a skill, not here.',
    '2. Earned: the work shows it. The user said it, or repeated it, or corrected an agent, or the same problem came back. Never invent rules the work did not show.',
    '3. Not obvious: a capable agent would not do it anyway, and reading the code or the docs does not show it at once.',
    '4. Lasting: still true next month. Never add task progress, plans, dates, versions, pull request or issue numbers, file lists, pasted errors or logs, or keys, passwords, and tokens.',
    '5. Not already said: if the file already says it, change nothing; if the file says it unclearly or partly, replace that line instead of adding one.',
    'Keep credentials out of every edit field, including quoted old text, add anchors, and reasons.',
    '',
    'Also remove or fix lines the work shows to be wrong or outdated, such as a rule the user reversed, and merge lines that say the same thing. Do not remove a line only because this work did not use it. Keep the user\'s own words and the file\'s language and style; do not rewrite lines that are fine.',
    '',
    'Answer with one JSON object only, one of:',
    '{"action":"none","reason":"<one sentence>"}',
    '{"action":"edit","edits":[<1 to 3 edits>]}',
    'Each edit is one of:',
    '{"op":"add","after":"<an exact whole line of the file to add below, or empty for the end>","text":"<the new line or lines>","why":"<one sentence: what in this work shows it>"}',
    '{"op":"replace","old":"<exact text of the file, one or more whole lines>","text":"<the new text>","why":"…"}',
    '{"op":"remove","old":"<exact text of the file, one or more whole lines>","why":"…"}',
    'Write new lines in the form the file already uses, such as "- " bullets under the right heading.',
  ].join('\n')
}

// The folder, its AGENTS.md, declined edits, and work.
export function agentsRequest({ folder, current, lines, declined = [], language }) {
  const parts = [`Project folder: ${folder}`]
  parts.push(current === undefined ? 'There is no AGENTS.md yet.' : `Current AGENTS.md:\n\`\`\`md\n${current}\n\`\`\``)
  const turnedDown = declined.filter(entry => entry.kind === 'agents' && entry.folder === folder)
    .flatMap(entry => entry.edits ?? [])
    .map(edit => `- ${edit.op}: ${clip(edit.text || edit.old || '', 200)}`)
  if (turnedDown.length > 0) parts.push(`Changes the user turned down before; do not propose them again:\n${turnedDown.join('\n')}`)
  if (language) parts.push(`The user writes in ${language}.`)
  parts.push(`The work, oldest first:\n${lines.join('\n')}`)
  return parts.join('\n\n')
}

// What keeps a proposal from the user, or undefined when it may be shown.
// `skills`: the team's skills by name; `learned`: names this Bot learned.
// Skills often talk about code such as `password == input`; read keys everywhere, but
// password wording only outside code.
const holdsSecret = text => looksLikeKey(text) || looksSecret(text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' '))
const holdsCredential = text => credentialShapes(text) !== text || holdsSecret(text)

const textOf = value => typeof value === 'string' ? value : ''
const lineBlock = value => value.split(/\r?\n/)
const occurrences = (lines, block) => {
  const found = []
  for (let at = 0; at <= lines.length - block.length; at += 1) {
    if (block.every((line, index) => lines[at + index] === line)) found.push(at)
  }
  return found
}

export function withoutReviewedAgentsRecords(records, reviewedOrders) {
  const reviewed = new Set(reviewedOrders)
  return records.filter(record => !reviewed.has(record.order))
}

export function applyEdits(current, edits) {
  let text = current ?? ''
  let newline = text.includes('\r\n') ? '\r\n' : '\n'
  let trailing = text.endsWith('\n')
  let lines = text === '' ? [] : text.split(/\r?\n/)
  if (trailing) lines.pop()
  for (const edit of edits) {
    if (!['add', 'replace', 'remove'].includes(edit.op)) throw new Error('unknown edit operation')
    if (edit.op === 'add') {
      const added = lineBlock(textOf(edit.text))
      const after = textOf(edit.after)
      if (current === undefined && after !== '') throw new Error('a new AGENTS.md can only add at the end')
      if (!text) {
        lines = added
        trailing = true
      } else if (!after) {
        lines.push(...added)
        trailing = true
      } else {
        const positions = occurrences(lines, [after])
        if (positions.length !== 1) throw new Error('the add anchor must occur once as a whole line')
        const at = positions[0]
        lines.splice(at + 1, 0, ...added)
      }
    } else {
      const old = lineBlock(textOf(edit.old))
      if (current === undefined) throw new Error('a new AGENTS.md can only add lines')
      const positions = occurrences(lines, old)
      if (positions.length !== 1) throw new Error('the old text must occur once as whole lines')
      const at = positions[0]
      const replacement = edit.op === 'replace' ? lineBlock(textOf(edit.text)) : []
      lines.splice(at, old.length, ...replacement)
    }
    text = lines.join(newline) + (trailing && lines.length > 0 ? newline : '')
    newline = text.includes('\r\n') ? '\r\n' : '\n'
    trailing = text.endsWith('\n')
    lines = text === '' ? [] : text.split(/\r?\n/)
    if (trailing) lines.pop()
  }
  return text
}

// The review's answer as a proposal. A single edit written as the answer itself, with
// its operation as the action, is that edit; a replacement with no text removes; lines
// one edit names that stand apart in the file, each once, are one edit each.
export function agentsAnswer(reply, current) {
  let answer = parseJson(reply)
  if (['add', 'replace', 'remove'].includes(answer?.action)) {
    const { action, ...edit } = answer
    answer = { action: 'edit', edits: [{ op: action, ...edit }] }
  }
  if (!Array.isArray(answer?.edits)) return answer
  const lines = lineBlock(current ?? '')
  const apart = edit => {
    if (edit?.op !== 'replace' && edit?.op !== 'remove') return [edit]
    const old = lineBlock(textOf(edit.old))
    const text = lineBlock(textOf(edit.text))
    if (old.length < 2 || occurrences(lines, old).length > 0 || old.some(line => occurrences(lines, [line]).length !== 1)) return [edit]
    if (edit.op === 'replace' && text.length !== old.length) return [edit]
    return old.map((line, index) => ({ ...edit, old: line, ...(edit.op === 'replace' ? { text: text[index] } : {}) }))
  }
  const removes = edit => {
    const { text, ...rest } = edit
    return { ...rest, op: 'remove' }
  }
  const edits = answer.edits.map(edit => edit?.op === 'replace' && textOf(edit.text).trim() === '' ? removes(edit) : edit)
  return { ...answer, edits: edits.flatMap(apart) }
}

export function agentsProblem(proposal, current) {
  if (proposal === undefined) return 'the answer is not a JSON object'
  if (proposal.action === 'none') return undefined
  if (proposal.action !== 'edit') return `unknown action ${String(proposal.action)}`
  if (!Array.isArray(proposal.edits) || proposal.edits.length < 1 || proposal.edits.length > 3) return 'an edit needs 1 to 3 changes'
  const initial = current ?? ''
  let result = initial
  for (const edit of proposal.edits) {
    if (!edit || !['add', 'replace', 'remove'].includes(edit.op)) return 'unknown edit operation'
    const text = textOf(edit.text)
    const old = textOf(edit.old)
    const after = textOf(edit.after)
    const why = textOf(edit.why)
    if (why.trim() === '') return 'each edit needs a reason'
    if (edit.op !== 'remove' && text === '') return 'an add or replacement needs text'
    if (text.length > LEARNING.agentsEditMax) return `edit text must have at most ${LEARNING.agentsEditMax} characters`
    if ([text, old, after, why].some(holdsCredential)) return 'it looks like it holds a secret'
    if (/#\d{2,}|\b\d{4}-\d{2}-\d{2}\b|\bv\d+\.\d+/u.test(text)) return 'the edit contains a task number, date, or version'
    const lines = lineBlock(result)
    if (edit.op === 'add') {
      if (typeof edit.after !== 'string') return 'an add needs an anchor'
      if (current === undefined && after !== '') return 'a new AGENTS.md can only add at the end'
      if (after !== '' && (after.includes('\n') || occurrences(lines, [after]).length !== 1)) return 'the add anchor must be one exact whole line'
    } else {
      if (current === undefined) return 'a new AGENTS.md can only add lines'
      if (old === '' || old.startsWith('\n') || old.endsWith('\n') || occurrences(lines, lineBlock(old)).length !== 1) return 'the old text must occur exactly once as whole lines'
    }
    result = applyEdits(result, [edit])
  }
  if (result.length > Math.max(initial.length + 800, 4_000)) return 'the resulting AGENTS.md is too large'
  if (result === initial) return 'the edits change nothing'
  return undefined
}

export function skillProblem(proposal, { skills, learned, limit = LEARNING.learnedMax }) {
  if (proposal === undefined) return 'the answer is not a JSON object'
  const { action } = proposal
  if (action === 'none') return undefined
  if (action !== 'create' && action !== 'update') return `unknown action ${String(action)}`
  let name
  try {
    name = validateCapabilityName(proposal.name, CONNECTOR_IDS, { kind: 'skill', creating: action === 'create' })
  } catch (error) {
    return error.message
  }
  const description = typeof proposal.description === 'string' ? proposal.description.trim() : ''
  const content = typeof proposal.content === 'string' ? proposal.content.trim() : ''
  const why = typeof proposal.why === 'string' ? proposal.why.trim() : ''
  if (description === '' || description.length > LEARNING.descriptionMax) return `the description must have 1 to ${LEARNING.descriptionMax} characters`
  if (content === '' || content.length > LEARNING.contentMax) return `the content must have 1 to ${LEARNING.contentMax} characters`
  if (holdsSecret(description) || holdsSecret(content) || holdsSecret(why)) return 'it looks like it holds a secret'
  const existing = Object.hasOwn(skills, name) ? skills[name] : undefined
  if (action === 'create') {
    if (existing !== undefined) return `${name} already exists`
    if (learned.length >= limit) return `the Bot already keeps ${limit} learned skills`
  } else {
    if (existing === undefined || existing.kind !== 'skill' || !learned.includes(name)) return `${name} is not a learned skill of this Bot`
    if (existing.content?.trim() === content && existing.description?.trim() === description) return 'the update changes nothing'
  }
  return undefined
}

// ---------------------------------------------------------------------------

export function install(rt) {
  const { ctx, config, home, state } = rt
  const settings = { ...LEARNING, ...(config.learningTimes ?? {}) }
  const on = config.learning !== false && config.memory !== false
  const root = join(home, 'learning')
  const path = join(root, 'state.json')
  const privateOwner = id => id !== undefined && (rt.isPrivate(id) || (state.privateArchives ?? []).some(bot => bot.id === id))
  const privateProposal = proposal => privateOwner(proposal.botId) || proposal.contributors?.some(privateOwner)
  const hasContributors = ({ contributors }) => Array.isArray(contributors)
    && contributors.length > 0 && contributors.every(id => typeof id === 'string' && id !== '')
  const checkPublic = proposal => {
    if (privateProposal(proposal)) throw refusal("A private Bot's learning proposal cannot be applied.")
  }
  const savedSecret = text => rt.redactSecretsAnywhere(text) !== text
  const redactLine = text => {
    const shaped = credentialShapes(text)
    // Check the original for saved values, as a shape could mask just part of one.
    if (!savedSecret(text) && !holdsSecret(shaped)) return shaped
    return `${/^(?:User|You): /.exec(text)?.[0] ?? ''}[hidden]`
  }
  const sensitiveText = value => typeof value === 'string' && (holdsCredential(value) || savedSecret(value))
  const sensitiveSkill = ({ name, description, content, why, previous } = {}) =>
    [name, description, content, why, previous?.description, previous?.content].some(sensitiveText)
  const sensitiveCard = card => card.kind === 'agents'
    ? [card.folder, card.path, card.content].some(sensitiveText)
      || card.edits?.some(({ text, old, after, why }) => [text, old, after, why].some(sensitiveText))
    : sensitiveSkill(card)
  const safeRecords = (records, discardClipped = false) => records.filter(record => (
    typeof record.text === 'string' && !(discardClipped && record.text.endsWith(CLIPPED))
  )).map(record => {
    const text = redactLine(record.text)
    return text === record.text ? record : { ...record, text }
  })

  function scrubContent(store, { loading = false, discardClipped = false } = {}) {
    let changed = false
    for (const [folder, group] of Object.entries(store.agentsPending)) {
      const previous = group.records ?? []
      const records = safeRecords(previous, discardClipped)
      if (records.length === 0 && group.recoverAt === undefined) {
        delete store.agentsPending[folder]
        changed = true
      } else if (records.length !== previous.length || records.some((record, index) => record !== previous[index])) {
        group.records = records
        changed = true
      }
    }
    for (const [id, proposal] of Object.entries(store.proposals)) {
      const unknown = loading && proposal.kind === 'agents' && !hasContributors(proposal)
      const sensitive = sensitiveCard(proposal)
      if (!unknown && !sensitive) continue
      // The old writer already consumed the reviewed work. Recover it from public
      // source Sessions without rewinding skill cursors.
      if (unknown && !sensitive && Number.isFinite(proposal.at)) {
        const group = store.agentsPending[proposal.folder] ??= { botId: proposal.botId, records: [] }
        group.recoverAt = proposal.at
      }
      delete store.proposals[id]
      changed = true
    }
    for (const [id, proposal] of Object.entries(store.settled)) {
      if (!sensitiveCard(proposal)) continue
      delete store.settled[id]
      changed = true
    }
    const declined = store.declined.filter(entry => !sensitiveCard(entry))
    if (declined.length === store.declined.length) return changed
    store.declined = declined
    return true
  }
  // `pending`: Bot id → chats with a long turn since the last pass. `agentsPending`:
  // folder → queued work waiting for AGENTS.md review. `cursors`: newest line read.
  // `proposals`: waiting for the user, by id. `settled`: answered ones, by id, with
  // the outcome; their cards stay in the chat part they were answered in.
  // `learned`: skill names learned by Bot.
  let saved
  let cleanupRevision = 0
  let writtenCleanup = 0
  const needsCleanup = () => cleanupRevision !== writtenCleanup
  const data = ({ secretsLoaded = false } = {}) => {
    // The secret store installs its redactor synchronously and can call back into data().
    if (saved === undefined && !secretsLoaded) void rt.loadSecrets()
    if (saved !== undefined) return saved
    try {
      const store = JSON.parse(readFileSync(path, 'utf8'))
      if (store === null || typeof store !== 'object' || Array.isArray(store)) throw new TypeError('Invalid learning state')
      saved = store
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const reason = error?.code ?? error?.name ?? 'error'
        throw refusal(`Could not read the learning state (${reason})`)
      }
      saved = {}
    }
    saved.pending ??= {}
    saved.cursors ??= {}
    saved.proposals ??= {}
    saved.settled ??= {}
    saved.declined ??= []
    saved.learned ??= {}
    saved.agentsPending ??= {}
    // The old writer clipped before redacting, and the secret store can change
    // while the host is down. A clipped line may now hold an unrecognizable prefix.
    if (scrubContent(saved, { loading: true, discardClipped: true })) {
      cleanupRevision += 1
      if (!secretsLoaded) void persist(true)
    }
    return saved
  }
  let stopped = false
  let writing = Promise.resolve()
  const persist = (cleanupOnly = false) => {
    if (stopped || rt.readOnly() !== undefined) return writing
    const attempt = writing.then(async () => {
      if (rt.readOnly() !== undefined || (cleanupOnly && !needsCleanup())) return
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      const contents = JSON.stringify(data(), null, 1)
      const revision = cleanupRevision
      try {
        await writeFile(temp, contents, 'utf8')
        await replaceFile(temp, path)
        writtenCleanup = revision
      } finally {
        await unlink(temp).catch(() => {})
      }
    })
    // Keep the write queue usable after a failure and let cleanup callers see it.
    writing = attempt.catch(error => rt.warn('omni-ui: saving the learning state failed: %s', error?.message ?? error))
    return cleanupOnly || needsCleanup() ? attempt : writing
  }

  let secretChange = 0
  const secretsChanged = rt.secretsChanged
  rt.secretsChanged = () => {
    secretChange += 1
    let failed
    try {
      if (saved === undefined) data({ secretsLoaded: true })
      else if (scrubContent(saved, { discardClipped: true })) cleanupRevision += 1
    } catch (error) {
      failed = Promise.reject(error)
      // A refresh can update the redactor without waiting for learning cleanup.
      void failed.catch(() => {})
    }
    secretsChanged?.()
    return failed ?? (needsCleanup() ? persist(true) : undefined)
  }

  function clearFolder(store, folder) {
    let changed = Object.hasOwn(store.agentsPending, folder)
    delete store.agentsPending[folder]
    for (const cards of [store.proposals, store.settled]) {
      for (const [id, card] of Object.entries(cards)) {
        if (card.kind !== 'agents' || card.folder !== folder) continue
        delete cards[id]
        changed = true
      }
    }
    const declined = store.declined.filter(entry => entry.kind !== 'agents' || entry.folder !== folder)
    if (declined.length !== store.declined.length) {
      store.declined = declined
      changed = true
    }
    if (changed) cleanupRevision += 1
  }

  const privateFolder = async (folder, file = join(folder, 'AGENTS.md')) => (
    await rt.privatePathOwner(folder) ?? await rt.privatePathOwner(file)
  )
  async function prepareLearning() {
    const store = data()
    const folders = new Set(Object.keys(store.agentsPending))
    for (const entry of [...Object.values(store.proposals), ...Object.values(store.settled), ...store.declined]) {
      if (entry.kind === 'agents') folders.add(entry.folder)
    }
    for (const folder of folders) {
      if (await privateFolder(folder)) clearFolder(store, folder)
    }
    await (needsCleanup() ? persist(true) : writing)
  }

  // A turn in a Bot's own chat that ran long marks the chat for the next pass.
  const started = new Map()
  const noted = new Map()
  let lastActivity = Date.now()
  ctx.on('agent/status', ({ agent, status }) => {
    if (stopped) return
    const id = agent?.id
    if (id === undefined || !rt.isBotSession(id)) return
    lastActivity = Date.now()
    if (status !== 'idle') {
      if (!started.has(id)) started.set(id, Date.now())
      return
    }
    const since = started.get(id)
    started.delete(id)
    const botId = rt.chatOwners.get(id)
    if (since === undefined || botId === undefined || privateOwner(botId) || Date.now() - since < settings.minTurnMs) return
    try {
      const pending = data().pending
      pending[botId] = [...new Set([...(pending[botId] ?? []), id])]
      noted.set(id, (noted.get(id) ?? 0) + 1)
      void persist().catch(() => {})
    } catch (error) {
      rt.warn('omni-ui: marking a chat for learning failed: %s', error?.message ?? error)
    }
  })

  // After the text budget, keep scanning to the cursor for user corrections.
  async function linesSince(sessionId, recovery) {
    const cursor = recovery === undefined ? data().cursors[sessionId] : undefined
    const keptRecords = []
    const userRecords = []
    let used = 0
    let userUsed = 0
    let overBudget = false
    let through
    for await (const line of rt.partLines(sessionId, AbortSignal.timeout(settings.readMs), { pages: Infinity })) {
      if (recovery !== undefined && (line.seq > recovery.through || !Number.isFinite(line.time) || line.time > recovery.at)) continue
      through ??= line.seq
      if (cursor !== undefined && line.seq <= cursor) break
      const text = clip(redactLine(line.text), line.who === 'user' ? settings.userLineMax : settings.botLineMax)
      if (!overBudget && used + text.length <= settings.textMax) {
        keptRecords.push({ text, time: line.time })
        used += text.length
        continue
      }
      overBudget = true
      if (text.startsWith('User: ') && userUsed + text.length <= settings.userTextMax) {
        userRecords.push({ text, time: line.time })
        userUsed += text.length
      }
    }
    return { work: [...keptRecords, ...userRecords].reverse(), through }
  }

  const skillsOf = () => Object.fromEntries(Object.entries(state.capabilities?.items ?? {}).filter(([, item]) => item.kind === 'skill'))
  const learnedOf = bot => (data().learned[bot.id] ?? []).filter(name => skillsOf()[name] !== undefined && (bot.capabilities ?? []).includes(name))
  const waitingFor = botId => Object.values(data().proposals).filter(entry => entry.botId === botId)

  const staleReview = () => Object.assign(new Error('The learning review inputs changed'), { code: 'bot/stale' })
  const checkReview = (bot, secrets) => {
    // The store replaces Bot objects on every reload, so a review is stale only when its Bot is gone or private.
    if (stopped || rt.botOf(bot.id) === undefined || privateOwner(bot.id) || secretChange !== secrets) throw staleReview()
  }

  async function reviewSkill(bot, lines) {
    await rt.skillsReady()
    const secrets = secretChange
    const learned = learnedOf(bot)
    const skills = Object.fromEntries(Object.entries(skillsOf()).map(([name, item]) => {
      const text = rt.skillModelText(name)
      return [name, text ? { name, kind: 'skill', hash: text.hash, description: text.description, content: text.body } : { name, kind: item.kind }]
    }))
    const library = Object.values(skills).filter(item => item.hash && !learned.includes(item.name))
    const text = skillRequest({
      bot,
      lines,
      learned: learned.map(name => skills[name]).filter(item => item?.hash),
      library,
      declined: data().declined.filter(entry => entry.kind !== 'agents' && entry.botId === bot.id),
      language: writtenIn(lines.filter(line => line.startsWith('User: ')).map(line => line.slice(6)), rt.uiLanguage?.()),
      limit: settings.learnedMax,
    })
    const check = () => checkReview(bot, secrets)
    let authorModel
    const reply = await rt.botShot(bot, skillSystem(), text, { sessionId: rt.chatOf(bot.id), kind: 'memory' }, {
      check, answered: ref => { authorModel = ref },
    })
    check()
    const proposal = parseJson(reply)
    if (sensitiveSkill(proposal)) {
      rt.warn('omni-ui: the skill review of %s proposed content containing a secret', bot.name)
      return undefined
    }
    const problem = skillProblem(proposal, { skills, learned, limit: settings.learnedMax })
    if (problem !== undefined) {
      rt.warn('omni-ui: the skill review of %s proposed nothing usable: %s', bot.name, problem)
      return undefined
    }
    if (proposal.action === 'none') return undefined
    const name = proposal.name.trim()
    const previous = proposal.action === 'update' ? skills[name] : undefined
    if (previous && !previous.hash) return undefined
    return {
      id: randomUUID(),
      kind: 'skill',
      action: proposal.action,
      botId: bot.id,
      at: Date.now(),
      name,
      description: proposal.description.trim(),
      content: proposal.content.trim(),
      why: typeof proposal.why === 'string' ? clip(proposal.why.trim(), 300) : '',
      ...(authorModel ? { authorModel } : {}),
      ...(previous ? {
        previous: { description: previous.description, content: previous.content },
        skillBase: { v: 1, hash: previous.hash },
      } : {}),
    }
  }

  async function reviewAgents(bot, { folder, file, current, lines, group, contributors }) {
    const secrets = secretChange
    const language = writtenIn(lines.filter(line => line.startsWith('User: ')).map(line => line.slice(6)), rt.uiLanguage?.())
    const store = data()
    const declined = store.declined.filter(entry => entry.kind === 'agents' && entry.folder === folder
      && hasContributors(entry) && !privateProposal(entry))
    const request = agentsRequest({ folder, current, lines, declined, language })
    let privacy
    const prepare = async () => {
      // The path lookup yields. Reject its result if the protected regions changed.
      privacy = rt.privatePathsKey()
      if (!await privateFolder(folder, file)) return
      clearFolder(store, folder)
      throw staleReview()
    }
    const check = () => {
      checkReview(bot, secrets)
      if (store.agentsPending[folder] !== group || contributors.some(privateOwner)
        || declined.some(privateProposal) || privacy !== rt.privatePathsKey()) throw staleReview()
    }
    const reply = await rt.botShot(bot, agentsSystem(), request, { sessionId: rt.chatOf(bot.id), kind: 'memory' }, { prepare, check })
    check()
    const answer = agentsAnswer(reply, current)
    if (answer === undefined || answer === null || typeof answer !== 'object') throw new Error('the answer is not a JSON object')
    const problem = agentsProblem(answer, current)
    if (problem !== undefined) {
      if (answer?.action !== 'none') rt.warn('omni-ui: the AGENTS.md review of %s proposed nothing usable: %s', bot.name, problem)
      return undefined
    }
    if (answer.action === 'none') return undefined
    const edits = answer.edits.map(({ op, text, old, after, why }) => ({
      op, text: textOf(text), old: textOf(old), why: textOf(why), ...(op === 'add' ? { after } : {}),
    }))
    const content = applyEdits(current, edits)
    if (edits.some(({ text, old, after, why }) => [text, old, textOf(after), why].some(savedSecret))
      || savedSecret(content) || holdsCredential(content)) {
      rt.warn('omni-ui: the AGENTS.md review of %s proposed content containing a secret', bot.name)
      return undefined
    }
    return {
      id: randomUUID(),
      kind: 'agents',
      botId: bot.id,
      at: Date.now(),
      folder,
      path: join(folder, 'AGENTS.md'),
      base: hashOf(current ?? ''),
      exists: current !== undefined,
      edits,
      content,
    }
  }

  const exists = async path => {
    try { await access(path); return true } catch { return false }
  }
  async function agentsFile(path) {
    try {
      const content = await readFile(path, 'utf8')
      return content.length <= LEARNING.agentsFileMax ? content : undefined
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  function queueAgentsWork(folder, bot, records) {
    if (records.length === 0) return
    const queue = data().agentsPending[folder] ??= { botId: bot.id, records: [] }
    if (rt.botOf(queue.botId) === undefined) queue.botId = bot.id
    queue.records ??= []
    let order = queue.records.reduce((max, item) => Math.max(max, item.order ?? 0), -1) + 1
    for (const item of records) queue.records.push({ botId: bot.id, text: item.text, time: item.time, order: order++ })
    const max = settings.textMax + settings.userTextMax
    let size = queue.records.reduce((sum, item) => sum + item.text.length, 0)
    const removed = new Set()
    const oldest = [...queue.records].sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.order - b.order)
    for (const item of oldest) {
      if (size <= max) break
      if (item.text.startsWith('User: ')) continue
      removed.add(item)
      size -= item.text.length
    }
    for (const item of oldest) {
      if (size <= max) break
      if (!item.text.startsWith('User: ')) continue
      removed.add(item)
      size -= item.text.length
    }
    if (removed.size > 0) queue.records = queue.records.filter(item => !removed.has(item))
    if (queue.records.length === 0 && queue.recoverAt === undefined) delete data().agentsPending[folder]
  }

  async function recoverAgentsWork(store, folder, group) {
    const ownBotOf = sessionId => {
      const past = rt.pastOwners.get(sessionId)
      return rt.chatOwners.get(sessionId) ?? (past?.roomId === undefined ? past?.botId : undefined)
    }
    const read = []
    const secrets = secretChange
    let unavailable
    for (const [sessionId, through] of Object.entries(store.cursors)) {
      const botId = ownBotOf(sessionId)
      if (!Number.isFinite(through) || botId === undefined || privateOwner(botId) || rt.botOf(botId) === undefined) continue
      try {
        const { session } = await rt.resolveAgent(sessionId)
        const reported = rt.reportedFolder(session)
        if (!reported || await rt.real(reported) !== folder || privateOwner(botId)) continue
        const { work } = await linesSince(sessionId, { through, at: group.recoverAt })
        if (work.length > 0) read.push({ sessionId, botId, work })
      } catch (error) { unavailable = error }
    }
    const privacy = rt.privatePathsKey()
    if (await privateFolder(folder)) clearFolder(store, folder)
    if (stopped || store.agentsPending[folder] !== group || secrets !== secretChange || privacy !== rt.privatePathsKey()) return
    if (read.length === 0 && unavailable !== undefined) throw unavailable
    for (const { sessionId, botId, work } of read) {
      const bot = rt.botOf(botId)
      if (bot !== undefined && ownBotOf(sessionId) === botId && !privateOwner(botId)) {
        queueAgentsWork(folder, bot, safeRecords(work))
      }
    }
    delete group.recoverAt
  }

  // One pass over every Bot with a long turn since the last one. A Bot with a
  // proposal still waiting is skipped: its chat is read again in the next pass.
  let running
  async function run() {
    if (stopped) return 0
    if (running) return running
    running = (async () => {
      await prepareLearning()
      if (stopped) return 0
      const store = data()
      store.lastRun = Date.now()
      let made = 0
      for (const [botId, pendingSessions] of Object.entries(store.pending)) {
        if (stopped) break
        const bot = rt.botOf(botId)
        const isPrivate = privateOwner(botId)
        if (bot === undefined || isPrivate) {
          delete store.pending[botId]
          if (isPrivate) cleanupRevision += 1
          continue
        }
        if (waitingFor(botId).length > 0) continue
        const sessions = [...pendingSessions]
        const notedAtStart = new Map(sessions.map(sessionId => [sessionId, noted.get(sessionId)]))
        try {
          const read = []
          const secretsAtRead = secretChange
          for (const sessionId of sessions) read.push({ sessionId, ...await linesSince(sessionId) })
          if (stopped) return made
          const lines = safeRecords(read.flatMap(entry => entry.work), secretsAtRead !== secretChange).map(record => record.text)
          const proposal = lines.length === 0 || privateOwner(botId) ? undefined : await reviewSkill(bot, lines)
          if (stopped) return made
          if (proposal !== undefined && !privateOwner(botId) && !sensitiveSkill(proposal)) {
            store.proposals[proposal.id] = proposal
            made += 1
          }
          if (config.agentsMd !== false) {
            for (const entry of read) {
              try {
                const agent = await rt.resolveAgent(entry.sessionId)
                const reported = rt.sessionFolder(agent.session)
                if (!reported) continue
                const folder = await rt.real(reported)
                try { await rt.workFolder(folder) } catch { continue }
                if (!await exists(join(folder, '.git')) && !await exists(join(folder, 'AGENTS.md'))) continue
                if (await privateFolder(folder)) {
                  clearFolder(store, folder)
                  continue
                }
                if (!privateOwner(botId)) queueAgentsWork(folder, bot, safeRecords(entry.work, secretsAtRead !== secretChange))
              } catch (error) {
                rt.warn('omni-ui: the AGENTS.md folder lookup for %s failed: %s', entry.sessionId, error?.message ?? error)
              }
            }
          }
          for (const entry of read) if (entry.through !== undefined) store.cursors[entry.sessionId] = entry.through
          const remaining = (store.pending[botId] ?? []).filter(sessionId =>
            !notedAtStart.has(sessionId) || noted.get(sessionId) !== notedAtStart.get(sessionId))
          if (remaining.length === 0) delete store.pending[botId]
          else store.pending[botId] = remaining
        } catch (error) {
          if (error?.code !== 'bot/stale') rt.warn('omni-ui: the learning review of %s failed: %s', bot.name, error?.message ?? error)
          continue
        }
      }
      if (config.agentsMd !== false) {
        for (const [folder, group] of Object.entries(store.agentsPending)) {
          if (stopped) break
          if (group.recoverAt !== undefined) {
            try { await recoverAgentsWork(store, folder, group) } catch (error) {
              rt.warn('omni-ui: recovering the AGENTS.md review of %s failed: %s', folder, error?.message ?? error)
              continue
            }
            if (stopped || store.agentsPending[folder] !== group || group.recoverAt !== undefined) continue
          }
          const records = group.records ?? []
          group.records = records.filter(item => !privateOwner(item.botId ?? group.botId))
          if (group.records.length !== records.length) cleanupRevision += 1
          if (group.records.length === 0) {
            delete store.agentsPending[folder]
            continue
          }
          let bot = privateOwner(group.botId) ? undefined : rt.botOf(group.botId)
          if (bot === undefined) {
            const contributor = group.records.find(item => rt.botOf(item.botId) !== undefined)
            if (contributor === undefined) {
              delete store.agentsPending[folder]
              continue
            }
            group.botId = contributor.botId
            bot = rt.botOf(group.botId)
          }
          if (Object.values(store.proposals).some(entry => entry.kind === 'agents' && entry.folder === folder)) continue
          try {
            const file = await rt.realBeyond(join(folder, 'AGENTS.md'))
            if (await privateFolder(folder, file)) {
              clearFolder(store, folder)
              continue
            }
            const current = await agentsFile(file)
            if (stopped) return made
            if (current === undefined && await exists(file)) continue
            if (await privateFolder(folder, file)) {
              clearFolder(store, folder)
              continue
            }
            if (stopped || store.agentsPending[folder] !== group) continue
            if (current !== undefined && (holdsCredential(current) || savedSecret(current))) continue
            if (privateOwner(bot.id)) continue
            group.records = safeRecords(group.records)
            const reviewRecords = group.records.filter(item => !privateOwner(item.botId ?? group.botId))
            const reviewedOrders = reviewRecords.map(item => item.order)
            const contributors = [...new Set(reviewRecords.map(item => item.botId ?? group.botId))]
            const lines = []
            let used = 0
            let userUsed = 0
            let overBudget = false
            for (const item of reviewRecords.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.order - b.order)) {
              if (!overBudget && used + item.text.length <= settings.textMax) {
                lines.push(item.text)
                used += item.text.length
                continue
              }
              overBudget = true
              if (item.text.startsWith('User: ') && userUsed + item.text.length <= settings.userTextMax) {
                lines.push(item.text)
                userUsed += item.text.length
              }
            }
            if (lines.length === 0) continue
            const proposal = await reviewAgents(bot, { folder, file, current, lines, group, contributors })
            if (stopped) return made
            if (await privateFolder(folder, file)) {
              clearFolder(store, folder)
              continue
            }
            if (stopped || store.agentsPending[folder] !== group || privateOwner(bot.id) || contributors.some(privateOwner)) continue
            if (proposal !== undefined && sensitiveCard(proposal)) continue
            if (proposal !== undefined) {
              store.proposals[proposal.id] = { ...proposal, contributors }
              made += 1
            }
            const queue = store.agentsPending[folder]
            if (queue) {
              queue.records = withoutReviewedAgentsRecords(queue.records ?? [], reviewedOrders)
              if (queue.records.length === 0) delete store.agentsPending[folder]
            }
          } catch (error) {
            if (error?.code !== 'bot/stale') rt.warn('omni-ui: the AGENTS.md review of %s failed: %s', folder, error?.message ?? error)
          }
        }
      }
      await persist()
      return made
    })().finally(() => { running = undefined })
    return running
  }

  const due = () => {
    if (stopped) return false
    const store = data()
    const hasPending = Object.values(store.pending).some(sessions => sessions.length > 0)
      || (config.agentsMd !== false && Object.values(store.agentsPending).some(queue => queue.recoverAt !== undefined || queue.records?.length > 0))
    if (!hasPending || rt.readOnly() !== undefined) return false
    if (Object.keys(rt.workView()).length > 0 || Date.now() - lastActivity < settings.idleMs) return false
    return store.lastRun === undefined || Date.now() - store.lastRun >= settings.intervalMs
  }
  ctx.effect(() => {
    const timer = on ? setInterval(() => {
      void Promise.resolve().then(() => { if (due()) return run() })
        .catch(error => rt.warn('omni-ui: learning pass failed: %s', error?.message ?? error))
    }, settings.tickMs) : undefined
    timer?.unref?.()
    return () => {
      stopped = true
      clearInterval(timer)
      // A new host may take over after disposal; finish only writes already queued.
      return writing
    }
  }, 'omni-ui: learning')

  if (!on) {
    const view = () => ({})
    rt.learnedSkillNames = () => new Set(Object.values(data().learned).flat())
  Object.assign(rt, { prepareLearning, learningView: view, learningSettledView: view, learningEndpoint: async () => { throw refusal('Learning is turned off on this host') }, learningRun: async () => 0 })
    return
  }

  // The user's answer to a card.
  async function answer({ id, approve }) {
    const store = data()
    const proposal = Object.hasOwn(store.proposals, id) ? store.proposals[id] : undefined
    const stale = () => Object.assign(new Error('This proposal is no longer open'), { code: 'bot/stale' })
    if (proposal === undefined) throw stale()
    const checkOpen = () => {
      if (store.proposals[id] !== proposal) throw stale()
    }
    const checkAgentsAccess = async () => {
      if (await privateFolder(proposal.folder, proposal.path)) {
        clearFolder(store, proposal.folder)
        await persist()
        throw refusal("This folder belongs to a private Bot, so its learning proposal was removed.")
      }
      checkOpen()
    }
    if (proposal.kind === 'agents') await checkAgentsAccess()
    // The answered card stays where it was, read-only, with how it ended. A waiting
    // card shows in the Bot's current chat part, so that is where it stays.
    const settle = (outcome) => {
      checkOpen()
      delete store.proposals[id]
      const { saved: _saved, savedHash: _savedHash, ...kept } = proposal
      store.settled[id] = { ...kept, sessionId: rt.chatOf(proposal.botId), outcome, settledAt: Date.now() }
    }
    if (approve !== true) {
      settle('declined')
      const decline = proposal.kind === 'agents'
        ? { kind: 'agents', folder: proposal.folder, contributors: proposal.contributors,
            edits: proposal.edits.map(({ op, text, old }) => ({ op, text, old })), at: Date.now() }
        : { botId: proposal.botId, name: proposal.name, description: proposal.description, at: Date.now() }
      if (proposal.kind !== 'agents' || !privateProposal(proposal)) store.declined = [...store.declined, decline].slice(-settings.declinedMax)
      await persist()
      return { applied: false }
    }
    // A failed approval keeps the card, so the user can still decline it.
    if (proposal.kind === 'agents') {
      checkPublic(proposal)
      await applyAgents(proposal, checkAgentsAccess)
    } else {
      const admit = item => {
        checkOpen()
        checkPublic(proposal)
        if (sensitiveSkill(proposal) || sensitiveSkill(item)) throw refusal('This proposal contains a secret.')
      }
      if ((proposal.action === 'update' && (proposal.skillBase?.v !== 1 || !skillHashId(proposal.skillBase.hash)))
        || (proposal.action === 'create' && proposal.saved && !skillHashId(proposal.savedHash))) {
        checkOpen()
        delete store.proposals[id]
        await persist()
        throw skillRefusal('proposal-stale')
      }
      await applySkill(proposal, admit)
    }
    settle('approved')
    await persist()
    return { applied: true }
  }

  const agentsApplying = new Map()
  async function applyAgents(proposal, checkAgentsAccess) {
    const path = proposal.path
    const previous = agentsApplying.get(path) ?? Promise.resolve()
    let release
    const lock = new Promise(resolve => { release = resolve })
    const queued = previous.catch(() => {}).then(() => lock)
    agentsApplying.set(path, queued)
    await previous.catch(() => {})
    try {
      const folder = await rt.real(proposal.folder)
      await rt.workFolder(folder)
      if (join(folder, 'AGENTS.md') !== path) throw refusal('AGENTS.md changed since this was proposed')
      await checkAgentsAccess()
      const readCurrent = async () => {
        try { return await readFile(path, 'utf8') } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          return undefined
        }
      }
      const checkCurrent = current => {
        const existsNow = current !== undefined
        if (existsNow !== proposal.exists || hashOf(current ?? '') !== proposal.base) {
          throw refusal('AGENTS.md changed since this was proposed')
        }
      }
      checkCurrent(await readCurrent())
      await checkAgentsAccess()
      checkPublic(proposal)
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, proposal.content, 'utf8')
        checkCurrent(await readCurrent())
        await checkAgentsAccess()
        checkPublic(proposal)
        await replaceFile(temp, path, async () => {
          await checkAgentsAccess()
          checkPublic(proposal)
        })
      } finally {
        await unlink(temp).catch(() => {})
      }
    } finally {
      release()
      if (agentsApplying.get(path) === queued) agentsApplying.delete(path)
    }
  }

  async function applySkill(proposal, admit) {
    admit()
    const bot = rt.botOf(proposal.botId)
    if (bot === undefined) throw refusal('The Bot that learned this skill is gone')
    const current = skillsOf()[proposal.name]
    const store = data()
    const options = {
      botId: bot.id, ui: false, admit, via: 'learning-card', authorModel: proposal.authorModel, team: rt.teamGeneration(),
    }
    if (proposal.action === 'create') {
      if (proposal.saved) {
        if (current === undefined || current.hash !== proposal.savedHash) {
          throw refusal(`${proposal.name} changed since this was proposed`)
        }
        store.learned[bot.id] = [...new Set([...(store.learned[bot.id] ?? []), current.name])]
        await persist()
      } else {
        if (current !== undefined) throw refusal(`A skill named ${proposal.name} exists now`)
        const item = await rt.capabilitySave({ name: proposal.name, kind: 'skill', description: proposal.description, content: proposal.content }, { ...options, op: 'create' })
        admit()
        proposal.saved = true
        proposal.savedHash = item.hash
        store.learned[bot.id] = [...new Set([...(store.learned[bot.id] ?? []), item.name])]
        await persist()
      }
    } else if (proposal.action === 'update') {
      const item = await rt.capabilitySave({ name: proposal.name, kind: 'skill', description: proposal.description, content: proposal.content }, { ...options, op: 'edit', base: proposal.skillBase.hash })
      admit()
      store.learned[bot.id] = [...new Set([...(store.learned[bot.id] ?? []), item.name])]
      await persist()
    }
    if (!(bot.capabilities ?? []).includes(proposal.name)) {
      admit()
      await rt.capabilityEndpoint('bot-capability', { botId: bot.id, name: proposal.name, attached: true })
    }
  }

  async function learningEndpoint(endpoint, body) {
    if (endpoint === 'learning-answer') return answer({ id: String(body.id ?? ''), approve: body.approve === true })
    throw new Error(`Unknown endpoint ${endpoint}`)
  }

  async function removeLearned(name) {
    const learned = data().learned
    const deleted = String(name ?? '')
    for (const [botId, names] of Object.entries(learned)) {
      learned[botId] = (Array.isArray(names) ? names : []).filter(entry => entry !== deleted)
    }
    await persist()
  }

  // Per Bot, its proposals waiting for the user.
  const learningView = () => {
    const byBot = {}
    for (const entry of Object.values(data().proposals)) (byBot[entry.botId] ??= []).push(entry)
    return byBot
  }
  // Per Bot, the answered proposals of its current chat part.
  const learningSettledView = () => {
    const byBot = {}
    for (const entry of Object.values(data().settled)) {
      if (rt.botOf(entry.botId) !== undefined && entry.sessionId === rt.chatOf(entry.botId)) (byBot[entry.botId] ??= []).push(entry)
    }
    return byBot
  }

  const capabilityDelete = rt.capabilityDelete
  rt.capabilityDelete = async (...args) => {
    const result = await capabilityDelete(...args)
    await removeLearned(args[0])
    return result
  }
  const capabilityEndpoint = rt.capabilityEndpoint
  rt.capabilityEndpoint = async (endpoint, body, ...args) => {
    const result = await capabilityEndpoint(endpoint, body, ...args)
    if (endpoint === 'capability-delete') await removeLearned(body?.name)
    return result
  }

  rt.learnedSkillNames = () => new Set(Object.values(data().learned).flat())
  Object.assign(rt, { prepareLearning, learningView, learningSettledView, learningEndpoint, learningRun: run })
}
