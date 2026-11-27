// Team tools: the roster, bot-to-bot messages, group chat settings and posts, and the
// question and view cards. Group rounds and reading chats are in groups.js.
import { SKILL_TOOL, skillTool } from './skill-library-call.js'
import { randomUUID } from 'node:crypto'
import { createEditInput } from './image-input.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readAvatar } from './avatar.js'
import { COLORS, EXTRA_COLORS, LONG_HEAD, MESSAGE_INLINE_MAX, ROOM_MODES, SOURCE_KIND } from './constants.js'
import { within, workingDirectoryCd } from './folders.js'
import { absoluteLinks } from './links.js'
import { NAME_MAX } from './requests.js'
import { headOf, unquote } from './text.js'
import { mentionSpans } from '../shared/mentions.js'
import { BUILTIN_ROLES, genieDetached } from '../shared/roles.js'
import { checkShownView, showViewDescription, showViewParameters } from 'deep-view/core'
import { SHOWABLE_PAGES, isShowablePage } from '../shared/settings-pages.js'
import { PROPOSAL_FIELDS, proposalLine } from '../shared/proposals.js'
import { ROLE_MAX } from '../shared/bot-profile.js'
import { isGuardGroupRefusal, refusal } from './refusal.js'
import { registerTrustedTool } from './tool-registrations.js'
import { deniesAcpTool } from '../shared/own-tools.js'
import { REVIEW_AFTER_CHECKS, verdictFirstLine } from '../shared/solver-method.js'

export const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export function questionOptions(options) {
  return (Array.isArray(options) ? options : [])
    .map(option => (typeof option === 'string' ? { label: option } : option ?? {}))
    .map(option => ({
      label: String(option.label ?? '').trim(),
      ...(option.description ? { description: String(option.description).trim() } : {}),
    }))
    .filter(option => option.label !== '')
    .slice(0, 6)
}

// A message_bot call that sent nothing answers with this object rather than a string, so
// the chat can tell a refusal from a delivery without reading the words. `text` is what
// the Bot reads; `sent` and `reason` are the presentation signal. A delivery keeps its
// string, and its text is unchanged.
const messageOutput = {
  schema: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          sent: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
        },
      },
    ],
  },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : value.text }],
  presentationMeta: (_args, value) => (typeof value === 'string'
    ? { sent: true }
    : { sent: value.sent === true, reason: value.reason }),
}
const refusedMessage = reason => ({ text: reason, sent: false, reason })

async function reviewPictureReceipt(rt, agent, sessionId) {
  const unknown = 'Pictures count only if the reviewer\'s answering turn receives them. Otherwise the RESULT stays unverified.'
  let route
  try {
    route = typeof agent.model?.current === 'function' ? agent.model.current() : agent.session?.requestHeader?.()?.config
  } catch { return unknown }
  const { provider, model } = route ?? {}
  if (typeof provider !== 'string' || provider === '') return unknown
  const unseen = 'The reviewer cannot see pictures on this route. A RESULT SHIP will stay unverified if its answering turn cannot see the pictures.'
  if (!provider.startsWith('acp-')) {
    return await rt.readsImagesStrict?.(provider, model) ? '' : unseen
  }
  let capability
  try { capability = rt.ctx.get?.('acpAgents')?.promptImageCapability?.(sessionId, provider) } catch {}
  if (capability === true) return 'The reviewer\'s ACP agent accepts pictures on this route. A RESULT SHIP stays unverified if its answering turn does not receive them.'
  if (capability === false) return unseen
  return unknown
}

export const GROUP_REF = { type: 'string', required: true, description: 'Exact group chat name from list_bots' }
const BLOCKING_QUESTION_TOOL = 'ask_user_question'
// A Bot's own chat runs DSH's goal: the loop the team asked for is this one, and
// create_goal/update_goal are how the Bot reports its round and finishes. A group
// Session hides them, because Omni has its own group goals.
const GOAL_TOOLS = ['create_goal', 'update_goal', 'get_goal']
// Bots keep DSH's subagents and teammates here, so upstream's delegation group is not hidden.
// restrict() refuses a whole list when one name is registered in the Agent's own
// scope, so each group is masked on its own.
const QUESTION_TOOL_GROUP = [BLOCKING_QUESTION_TOOL]
const GROUP_HIDDEN_TOOL_GROUPS = [[BLOCKING_QUESTION_TOOL, ...GOAL_TOOLS]]
const GOAL_REFUSAL = 'A group Session does not run /goal: set the group\'s goal with Set a goal in its + menu, or with the group_goal tool.'
// DSH 0.2.2's schedule tools can deliver to a new Session, which is outside the team and
// has no Bot; a Bot's tasks deliver to its own chat, which Omni moves on with each part.
const SCHEDULE_TARGET_TOOLS = ['schedule_create', 'schedule_edit']
const SCHEDULE_TARGET_REFUSAL = 'A Bot’s scheduled tasks run in its own chat. Use target "this_session".'
const MODE_PARAM = {
  type: 'string',
  enum: ROOM_MODES,
  description: '"everyone": every member answers a plain message in turn, admin first. "admin" (the default): a plain message goes to the admin, who calls others with @Name. @mentions always choose who answers.',
}
const WORK_DIR_PARAM = { type: 'string', description: 'Full path of the folder to work in, where commands and file tools start. Only when the user asks for it' }
const SECTION_PARAM = { type: 'string', description: 'Sidebar section name to group Bots and group chats that work on the same project together; creates the section if it does not exist' }
const AVATAR_PARAM = {
  type: 'string',
  description: 'Profile picture: a local image path (a relative path starts in your working folder) or a data URL. PNG, JPEG, WebP, or GIF; square, 256x256 recommended, up to 120 KB. Images are not resized.',
}
// The tools a Bot never gets: absent from its surface on every Session it speaks from — its
// chat, group Sessions, earlier parts, task runs — and refused by the executor if a call
// reaches it anyway. A name this DSH does not serve refuses the save, so a typo cannot leave
// the tool the person meant to remove on the Bot.
const DENY_TOOLS_PARAM = {
  type: 'array',
  items: { type: 'string' },
  description: 'Tools this Bot never gets, by exact name and case '
    + '(for example omni_send, bash, write): a hard read-only list enforced on every Session '
    + 'of the Bot, not an instruction. '
    + 'A name this DSH does not serve refuses the save. '
    + 'Any non-empty list also denies schedule_create and schedule_edit, whose fresh-Session '
    + 'targets no Bot lineage could bind. '
    + 'An existing Bot\'s list changes only through the user\'s settings: no Bot can set or clear '
    + 'its own, and no Main Bot can set it for another Bot.',
}

export function install(rt) {
  // A Session a group owns (a member's Session there, or the group's own) shows no goal
  // tools: its rounds would run where nobody answers them and its goal is Omni's own.
  const groupSessionOf = id => id !== undefined
    && (rt.groupOwners?.has?.(id) === true || rt.roomOf(id) !== undefined)
  const hiddenToolGroupsOf = id => (groupSessionOf(id) ? GROUP_HIDDEN_TOOL_GROUPS : [QUESTION_TOOL_GROUP])
  const hiddenToolsOf = id => hiddenToolGroupsOf(id).flat()
  // The guidance DSH writes into the prompt for the hidden tools. A group Session also
  // drops the goal section itself, since it hides the whole loop.
  const hiddenSectionsOf = id => new Set([
    ...hiddenToolsOf(id).map(name => `tool:${name}`),
    ...(groupSessionOf(id) ? ['tool:goal'] : []),
  ])
  const { ctx, state } = rt

  const callerBot = (exec) => rt.botOf(rt.selfOf(exec.agent?.id))
  const solverCaller = exec => {
    const sessionId = exec.agent?.id ?? exec.agent?.session?.id
    const bot = rt.botOfSession?.(sessionId, exec.agent)
    return { bot, own: bot !== undefined && rt.ownChatLineage?.(sessionId, exec.agent, bot) === true }
  }
  // Only the Bot's own chat and its group Sessions take the role mask and guard.
  // Genie itself refuses calls from task runs, subagents and fresh schedule Sessions.
  const roleBotOf = id => (rt.chatOwners?.has(id) || rt.groupOwners?.has(id) ? rt.botOf(rt.selfOf(id)) : undefined)
  const withheldRoleTools = bot => (genieDetached(bot, state.prefs) ? BUILTIN_ROLES.genie.tools : [])
  const callerRoom = (exec) => {
    const roomId = rt.groupOwners.get(exec.agent?.id)?.roomId
    return roomId ? { fromRoomId: roomId } : {}
  }

  const sectionNameOf = id => (state.sections ?? []).find(sec => sec.id === id)?.name

  const roomLine = (room, self) => {
    const members = room.members.map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${bot.id === room.admin ? ' (admin)' : ''}${bot.id === self ? ' (you)' : ''}`)
    const section = sectionNameOf(room.sectionId)
    const parts = [
      `members: ${members.join(', ')}`,
      section ? `section: ${section}` : '',
      room.mode === 'admin' && room.admin ? 'plain messages go to the admin first' : 'every member replies in turn',
      room.notice ? `notice: ${room.notice.split('\n')[0].slice(0, 100)}` : '',
      room.workDir ? `members work in ${room.workDir} here` : '',
      room.permission ? `members work with the ${room.permission} permissions here` : '',
      room.goal !== undefined ? `goal: "${room.goal.title}" (${room.goal.status}${room.goal.status === 'active' || room.goal.status === 'paused' ? `, stage ${Math.min(room.goal.current + 1, room.goal.stages.length)}/${room.goal.stages.length}` : ''})` : '',
    ].filter(Boolean)
    return `- "${room.name}" — ${parts.join('; ')}`
  }
  // Main Bots see every group; other Bots see the groups they are in.
  const visibleRooms = self => Object.values(state.rooms).filter(room => rt.isMain(self) || room.members.includes(self))

  rt.teamTools.push(defineTool({
    name: 'list_bots',
    description: 'List every Bot on the user\'s team with its role, what it does and what it is doing right now, and the group chats you can see.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      await rt.refreshInstallation?.({ force: true })
      const self = rt.selfOf(exec.agent?.id)
      const lines = Object.values(state.bots).map(bot => {
        // A private Bot is only named to the others: not what it does, where, or what now.
        if (bot.private === true && bot.id !== self) return `- ${bot.name} (${[bot.role, 'private Bot, closed to other Bots'].filter(Boolean).join(', ')})`
        // A Bot whose model its plugin owns answers with what that plugin says, not a DSH model.
        const hosted = rt.hostOwned?.(bot) === true
        const model = hosted ? undefined : bot.appliedModel ?? bot.model
        const answering = hosted ? rt.hostAnsweringOf?.(bot) : undefined
        const denied = Array.isArray(bot.denyTools) && bot.denyTools.length > 0 ? `denies ${bot.denyTools.join(', ')}` : ''
        const section = sectionNameOf(bot.sectionId)
        const tags = [bot.role, section ? `section "${section}"` : '', model ? `model ${model}` : '', answering ? `answers with ${answering}` : '', bot.workDir ? `works in ${bot.workDir}` : '', denied, rt.isMain(bot.id) ? 'Main Bot' : '', bot.private === true ? 'private' : '', bot.id === self ? 'you' : ''].filter(Boolean).join(', ')
        const job = bot.instructions ? ` — ${bot.instructions.split('\n')[0].slice(0, 120)}` : ''
        const now = bot.id === self ? '' : `\n  now: ${rt.statusOf(bot.id)}`
        return `- ${bot.name}${tags ? ` (${tags})` : ''}${job}${now}`
      })
      if (lines.length === 0) return 'No Bots yet.'
      const rooms = visibleRooms(self)
      return [
        'Bots:',
        ...lines,
        '',
        rooms.length === 0 ? 'Group chats: none you can see.' : 'Group chats:',
        ...rooms.map(room => roomLine(room, self)),
      ].join('\n')
    },
  }))

  // Sessions a Bot is running in right now: its own chat plus each group Session
  // with a live turn. An idle Bot reports just its own chat.
  const activeSessions = (botId) => {
    const running = [...new Set([rt.chatOf(botId), ...rt.groupSessionsOf(botId)])]
      .filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
    return { running, idle: running.length === 0 }
  }
  const whereOf = (sessionId) => {
    const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
    return room ? `group "${room.name}"` : 'its own chat'
  }
  // A Bot request still in the inbox: no step or turn has taken it out yet.
  const unreadRequest = (agent, senderId, toUser) => {
    for (const [message, steered] of [...(agent.inbox?.nextStep ?? []).map(message => [message, true]), ...(agent.inbox?.nextTurn ?? []).map(message => [message, false])]) {
      const source = message.source
      if (source?.kind === SOURCE_KIND && source.role === 'request' && source.senderSessionId === senderId
        && (source.audience === 'user') === toUser && !source.deferred && !source.resumed) return { message, steered }
    }
    return undefined
  }
  // A message's own words and files, without its header line.
  const bodyOf = (message) => {
    const content = Array.isArray(message.content) ? message.content : []
    const first = content.find(block => block?.type === 'text')?.text ?? ''
    return { text: first.slice(first.indexOf('\n') + 1), images: content.filter(block => block?.type === 'image' && block.attachment !== undefined).map(block => block.attachment), files: content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment) }
  }

  // A tool that throws shows as failed in the chat, instead of as sent or stopped.
  const refuse = (message) => { throw new Error(message) }

  // The works (handoffs.js) the calling turn does: what it answers, and the requests
  // that joined it.
  const worksOf = (exec) => {
    const turn = rt.live.get(exec.agent?.id)
    return [rt.workOf(turn?.info), ...(turn?.joined ?? []).map(joined => rt.workOf(joined.info))].filter(Boolean)
  }
  const tooLong = text => `Not sent: the message has ${text.length} characters, more than ${MESSAGE_INLINE_MAX}, and this DeepSeek Harness cannot send it as a file. Write it to a file in your working folder and send its path instead.`

  // Work for a group stays in it: from a group Session, message_bot calls a member there
  // exactly as an "@Name" line would, and never reaches a Bot outside the group.
  const groupRefusal = (room, sender, target) => {
    if (room.members.includes(target.id)) return undefined
    const add = rt.isMain(sender.id) || rt.isAdminOf(room, sender.id) ? ', or add it yourself with update_group first' : ''
    return `Not sent: ${target.name} is not in "${room.name}", and work for this group stays in it. Ask the user to add ${target.name} to the group${add}.`
  }

  const callInGroup = async (exec, room, sender, target, message) => {
    const call = `@${target.name}`
    await rt.roomStepText(exec.agent.id, rt.live.get(exec.agent.id)?.info, message.startsWith(call) ? message : `${call} ${message}`, false)
    return `Called ${target.name} in "${room.name}" with your message, as writing "${call}" there does: it works on it in the group, and you answer its result there. Nothing went to its own chat.`
  }

  // The Bots each Session's post_to_group called by name in its current turn, so that
  // turn does not also send them the same work in their own chats.
  const calledInPosts = new Map()
  const turnOf = exec => rt.live.get(exec.agent?.id)?.turn

  rt.teamTools.push(defineTool({
    name: 'solver_progress',
    description: 'Record progress in your own Solver chat. Use status for the active request ID, plan for agreed check IDs, start before a run, checks for its outcomes, replan before a new plan, and auto with the person\'s exact affirmative request.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'plan', 'start', 'checks', 'replan', 'auto'] },
      request: { type: 'string', description: 'Active request ID from status, required for updates' },
      run: { type: 'string', description: 'Distinct, stable ID for a check run or re-plan' },
      checks: { type: 'array', items: { type: 'string' }, description: 'Stable check IDs for the plan or this run' },
      commands: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { check: { type: 'string', required: true }, command: { type: 'string', required: true } } },
      description: 'For plan, give each agreed check ID and its exact foreground command in the result folder' },
      results: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { check: { type: 'string', required: true }, pass: { type: 'boolean', required: true } } } },
      quote: { type: 'string', description: 'The person’s exact affirmative instruction to turn Auto on for this request' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const { bot, own } = solverCaller(exec)
      return rt.solverProgress(bot, own, args)
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'message_bot',
    description: 'Send a message to another Bot on the team. If that Bot is working, it reads your message at its next step and can change course, then answers once that work is done; if it is idle, it starts on it right away. Its reply arrives later as a new message to you; with reply_to "user" it answers the user in its own chat instead, and with reply_to "none" nothing comes back at all. In a group chat it reaches only members of that group, as writing "@Name" there does. With request_id you name the request yourself: a repeat of that name with the same message is not sent again, but gives the receipt of the first call back.',
    parameters: {
      to: { type: 'string', required: true, description: 'Bot ID or exact Bot name from list_bots' },
      message: { type: 'string', required: true, description: 'Self-contained message; the other Bot cannot see this conversation' },
      images: { type: 'array', items: { type: 'string' }, description: 'Pictures to send along by name, sha256 or saved path as your own chat shows it. In a designated RESULT review you can also give the paths of image files inside your result folder.' },
      reply_to: {
        type: 'string',
        enum: ['me', 'user', 'none'],
        description: '"me" (default): the reply comes back to you and the user does not see it. "user": the Bot answers the user in its own chat, where the user reads it, and nothing comes back to you. "none": the Bot reads your message and nothing comes back to you; use it for a thank-you, a hold, a warning or a fact, never for work you need an answer to. Use "user" whenever the user wants to hear from that Bot directly or asks Bots to say something in their own chats.',
      },
      when: {
        type: 'string',
        enum: ['now', 'queue'],
        description: '"now" (default): a working Bot reads your message at its next step, between its current actions, and answers once its current work is done; use it for questions, information it needs, corrections and warnings. "queue": it reads your message only after its current work is done, as a separate task; use it only for a new task unrelated to what it is doing now. With reply_to "user" the message always queues.',
      },
      request_id: {
        type: 'string',
        description: `Your own name for this request, up to ${NAME_MAX} characters, so that a repeat of it is not sent twice. Send the same request_id with the same message when you repeat a call: the receipt of the first call comes back and nothing is sent again. A request_id names one request: with other content it is refused.`,
      },
      solver_review: { type: 'string', enum: ['plan', 'result'], description: 'Solver only. Designate this exchange as the plan or result review.' },
      solver_request: { type: 'string', description: 'Active Solver request ID when designating a review' },
    },
    output: messageOutput,
    async execute(args, exec) {
      await rt.load()
      if (Array.isArray(args.images) && args.images.length > 4) return refusedMessage('Not sent: send at most 4 pictures in one message_bot call.')
      const sender = callerBot(exec)
      if (sender === undefined) return refusedMessage('Only Bots on the team can use message_bot.')
      const toReviewer = typeof sender.reviewerId === 'string' && args.to === sender.reviewerId
      const target = toReviewer ? rt.botOf(args.to) : rt.findBot(args.to)
      if (target === undefined) return refusedMessage(`No Bot named ${args.to}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`)
      if (target.id === sender.id) return refusedMessage('You cannot message yourself.')
      if (String(args.message ?? '').trim() === '') return refusedMessage('Write a message to send.')
      // Work never goes to a Bot whose plugin is not installed: it cannot run it (installed.js).
      await rt.refreshInstallation?.()
      const installation = rt.installationOf?.(target)
      if (installation?.installed === false) return refusedMessage(`Not sent: ${target.name} is not installed in this DSH (${installation.reason}). Ask the user to install it before giving it work.`)
      const toUser = rt.isPrivate(target.id) || args.reply_to === 'user'
      // No reply is owed to the sender: the message is read where it lands, and no
      // answer is routed back or handed on. A private Bot still answers the user.
      const noReply = args.reply_to === 'none'
      const designating = args.solver_review !== undefined || args.solver_request !== undefined
      const designatedCaller = designating ? solverCaller(exec) : undefined
      if (designating && (!['plan', 'result'].includes(args.solver_review) || !designatedCaller.own
        || designatedCaller.bot !== sender || toUser || noReply || sender.reviewerId !== target.id)) {
        return refusedMessage('Designate a review in your own Solver chat with your assigned reviewer and a reply to you.')
      }
      const name = typeof args.request_id === 'string' ? args.request_id.trim() : ''
      if (name.length > NAME_MAX) return refusedMessage(`The request_id is ${name.length} characters long; a request name is at most ${NAME_MAX}.`)
      let text = absoluteLinks(String(args.message), rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      const images = []
      const resultReview = args.solver_review === 'result'
      const editInput = createEditInput({ rt, ctx })
      if (Array.isArray(args.images) && args.images.length > 0) {
        if (room !== undefined || rt.groupOwners.has(exec.agent?.session?.id ?? exec.agent?.id)) return refusedMessage('Not sent: forward pictures from your own chat.')
        for (const selector of resultReview ? [] : args.images) {
          try { images.push(await editInput.findPicture(exec, selector, exec.signal)) } catch (error) {
            return refusedMessage(`${JSON.stringify(selector)}: ${error.message}`)
          }
        }
      }
      // The request the caller named: it is admitted once, and a repeat of it is not sent again.
      const request = name === '' ? undefined : rt.requestIdentity({
        caller: sender.id,
        context: room === undefined ? 'chat' : `room:${room.id}`,
        name,
        payload: {
          to: target.id,
          message: String(args.message ?? '').replace(/\r\n?/g, '\n').trim(),
          reply_to: toUser ? 'user' : noReply ? 'none' : 'me',
          when: designating || args.when === 'queue' ? 'queue' : 'now',
          ...(designating ? { solver_review: args.solver_review, solver_request: args.solver_request } : {}),
          ...(images.length > 0 ? { images: images.map(ref => ref.attachmentId).sort() } : {}),
          ...(resultReview && args.images?.length > 0 ? { images: [...args.images].sort() } : {}),
        },
      })
      // What the caller gets for a request that was admitted before.
      const answer = (outcome) => {
        if (outcome.status === 'replay') return outcome.receipt
        if (outcome.status === 'conflict') refuse(`Not sent: request_id "${name}" was already used for a different request. A request_id names one request; send this one under a new name.`)
        if (outcome.status === 'uncertain') refuse(`Not sent again: the outcome of request_id "${name}" is not known (the delivery failed, or Omni restarted while it was in flight), so it was not sent again. Check whether ${target.name} got it before sending it under a new name.`)
        if (outcome.status === 'expired') return refusedMessage(`Nothing was sent again: request_id "${name}" was admitted before, but its receipt is no longer kept, so only the fact that it was sent is left. Send the work under a new request_id if it must be done again.`)
        if (outcome.status === 'readonly') refuse(`Not sent: this window cannot save the Bot team, so it cannot record the request_id "${name}". Send it from the window that owns the team, or leave the request_id out.`)
        return outcome.receipt
      }
      if (request !== undefined) {
        const seen = await rt.knownRequest(request)
        if (seen !== undefined) return answer(seen)
      }
      if (room !== undefined) {
        const problem = groupRefusal(room, sender, target)
        if (problem !== undefined) refuse(problem)
        const send = () => callInGroup(exec, room, sender, target, text.trim())
        return request === undefined ? await send() : answer(await rt.admitRequest(request, send))
      }
      const posted = calledInPosts.get(exec.agent?.id)
      const postedIn = posted !== undefined && posted.turn === turnOf(exec) ? posted.calls.get(target.id) : undefined
      if (postedIn !== undefined) refuse(`Not sent: you called ${target.name} in "${postedIn}" in this turn, and it works on that there. Send each task one way only; to add to it, post in that group.`)
      // Whoever waits for this work gets the answer by itself; a message there only
      // sends the work round in a circle. Not a failed call: the turn goes on with
      // the work, and the result says where its answer goes instead of showing a
      // bare error the Bot cannot act on.
      const works = worksOf(exec)
      if (rt.upstreamOf(works).has(target.id)) {
        return refusedMessage(`Not sent: ${target.name} is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Finish the work and end your turn; to ask ${target.name} something, end your turn with the question.`)
      }
      const authorizePictures = async pictures => {
        if (pictures.length > 0 && rt.isPrivate(sender.id)) {
          await rt.approvePictureForward(exec, { sender, target, images: pictures })
          exec.signal?.throwIfAborted()
        }
      }
      const send = async () => {
        if (!resultReview) await authorizePictures(images)
        const work = toUser || noReply ? undefined : works[0]
        const chat = rt.chatOf(target.id)
        const agent = await rt.resolveAgent(chat)
        const status = rt.statusOf(target.id)
        // A request it has not read yet, sent for the same work, takes this one in, so
        // messages to a Bot that cannot read them do not pile up.
        const unread = designating ? undefined : unreadRequest(agent, sender.id, toUser)
        const earlier = unread && !state.works?.[unread.message.source.exchangeId]?.name?.startsWith('solver-review-') ? unread : undefined
        const joinable = earlier !== undefined && (toUser || rt.sameWork(earlier.message.source.exchangeId, work))
        const before = joinable ? bodyOf(earlier.message) : undefined
        const reviewExchange = designating ? randomUUID() : undefined
        let long
        if (designating) {
          long = await rt.solverReview(sender, target, true, {
            kind: args.solver_review, request: args.solver_request, exchangeId: reviewExchange, agent: exec.agent,
            ...(resultReview ? { pictures: { selectors: args.images, signal: exec.signal,
              find: selector => editInput.findPicture(exec, selector, exec.signal, { requireExhaustion: true }),
              authorize: authorizePictures } } : {}),
            prepare: (kind, checks, commands) => {
              const stage = kind.toUpperCase()
              const evidence = commands ? `\nAgreed check commands: ${JSON.stringify(commands)}` : ''
              const choices = `${verdictFirstLine(`exactly one of \`${stage} SHIP\`, \`${stage} FIX-FIRST\`, or \`${stage} BLOCKED\` alone`)} ${REVIEW_AFTER_CHECKS}`
              text = `Designated Solver ${kind} review. ${choices}\nAgreed check IDs: ${checks.join(', ')}.${evidence}\n\n${text}`
              return rt.attachLong(text, `Message from ${sender.name}.txt`)
            },
          })
        } else {
          long = await rt.attachLong(before ? `${before.text}\n\n${text}` : text, `Message from ${sender.name}.txt`)
        }
        // Nothing went out, so a named request must not take this as a delivered
        // receipt: admitRequest drops the pending record instead, and a retry can send.
        if (long === undefined) { if (request !== undefined) request.unsent = true; return refusedMessage(tooLong(text)) }
        if (long.images) images.push(...long.images)
        const currentReview = () => !exec.signal?.aborted && rt.chatOf(target.id) === chat
          && rt.resultReviewCurrent(sender, target, args.solver_request, reviewExchange)
        const joins = before !== undefined && agent.inbox?.remove?.(earlier.message.id) === true
        if (before !== undefined && !joins) long = await rt.attachLong(text, `Message from ${sender.name}.txt`) ?? long
        const working = rt.live.get(chat)?.turn !== undefined
        const steer = (!designating && args.when !== 'queue' && !toUser) || (joins && earlier.steered)
        const exchangeId = joins ? earlier.message.source.exchangeId : (reviewExchange ?? randomUUID())
        // The merged message owes nothing only when neither message it took in does.
        const earlierNoReply = earlier !== undefined && earlier.message.source.noReply === true
        const mergedNoReply = noReply && (joins ? earlierNoReply : true)
        if (joins) rt.forgetDelivery?.(exchangeId)
        try {
          if (resultReview && !currentReview()) throw refusal('The Solver request changed before the review could be sent.')
          // A request that owes a reply needs its work, also when it grew out of an
          // earlier no-reply message that had none.
          if (!toUser && !mergedNoReply && state.works?.[exchangeId] === undefined) {
            rt.openWork(exchangeId, { from: sender.id, to: target.id, parent: work,
              ...(designating ? { name: `solver-review-${args.solver_review}` } : {}) })
          }
          const delivered = await rt.deliver({ fromId: sender.id, toId: target.id, text: long.text, files: [...long.files, ...(joins ? before.files : [])], images: [...images, ...(joins ? before.images : [])], forwarded: true, length: long.length, role: 'request', steer, exchangeId, resultReview, ...(joins ? { merged: true } : {}), ...(mergedNoReply ? { noReply: true } : {}), ...(toUser ? { audience: 'user' } : {}) },
            resultReview ? { shouldSend: currentReview } : undefined)
          if (resultReview && delivered === undefined) {
            if (request !== undefined) request.unsent = true
            rt.forgetDelivery?.(exchangeId)
            rt.dropWork(exchangeId)
            throw refusal('The Solver request changed before the review could be sent.')
          }
        } catch (error) {
          // The delivery stays noted for the next start while its Bot exists
          // (resume.js), and the resent request still answers up the tree, so the
          // work it opened stays too. Only a target that is gone drops the work.
          if (!joins && rt.botOf(target.id) === undefined) rt.dropWork(exchangeId)
          throw error
        } finally {
          if (designating) rt.solverReviewSent(reviewExchange)
        }
        const sent = toUser
          ? `Delivered to ${target.name}. It will answer the user in its own chat; nothing comes back to you, so point the user to ${target.name}'s chat instead of relaying.`
          : noReply || mergedNoReply
            ? working && steer
              ? `Delivered to ${target.name} while it is working: it reads your message at its next step. No reply comes back to you.`
              : working
                ? `Queued for ${target.name}: it reads your message after its current work. No reply comes back to you.`
                : `Delivered to ${target.name}. It reads your message; no reply comes back to you.`
            : working && steer
              ? `Delivered to ${target.name} while it is working: it reads your message at its next step and answers once that work is done. Its reply will arrive later as a new message; do not wait for it.`
              : working
                ? `Queued for ${target.name}: it reads your message after its current work. Its reply will arrive later as a new message; do not wait for it.`
                : `Delivered to ${target.name}. Its reply will arrive later as a new message; do not wait for it.`
        const asker = work !== undefined && rt.ownsWork(sender.id, work) ? rt.botOf(state.works[work].from)?.name : undefined
        const notes = [
          long.reviewNotice,
          long.reviewComplete ? await reviewPictureReceipt(rt, agent, chat) : '',
          joins ? `${target.name} had not read your earlier message yet, so this one was added to it, ${mergedNoReply ? 'and it reads them together.' : 'and it answers both at once.'}` : '',
          status === 'idle' ? '' : `${target.name} now: ${status}.`,
          asker ? `When you have handed on everything, end your turn: each reply brings you back to this work, and your answer goes to ${asker} once all of it is back.` : '',
        ].filter(Boolean)
        const pictures = images.length + (joins ? before.images.length : 0)
        const out = [sent, ...(pictures ? [`Sent with ${pictures} picture(s).`] : []), ...notes].join(' ')
        // Messages reach a Bot's own chat only; work in a group goes on without them.
        const groups = activeSessions(target.id).running.filter(sessionId => sessionId !== chat)
        if (groups.length === 0) return out
        const stop = rt.isMain(sender.id) ? ' If it must not go on there, use stop_bot.' : ''
        return `${out} Your message does not reach its work in ${groups.map(whereOf).join(' and ')}.${stop}`
      }
      return request === undefined ? await send() : answer(await rt.admitRequest(request, send))
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'stop_bot',
    description: 'Main Bot only. Stop another Bot\'s running turn immediately — when it must not finish a dangerous action and a message_bot warning is not enough. Its queued messages are dropped with the turn. It is then told why in a new turn, whose reply comes back to you.',
    parameters: {
      bot: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      reason: { type: 'string', description: 'Why it was stopped; it reads this afterwards' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined || !rt.isMain(sender.id)) refuse('Only a Main Bot can stop other Bots.')
      const target = rt.findBot(args.bot)
      if (target === undefined) refuse(`No Bot named ${args.bot}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`)
      if (target.id === sender.id) refuse('You cannot stop yourself.')
      const { running } = activeSessions(target.id)
      if (running.length === 0) refuse(`${target.name} is not running right now, so there is nothing to stop. Use message_bot to reach it.`)
      for (const sessionId of running) {
        const agent = await rt.resolveAgent(sessionId)
        agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      }
      const why = String(args.reason ?? '').trim() || 'Stop what you are doing; the previous turn was ended on purpose. Acknowledge briefly.'
      await rt.deliver({ fromId: sender.id, toId: target.id, text: why, role: 'stopped', ...callerRoom(exec) })
      return `Stopped ${target.name} in ${running.map(whereOf).join(' and ')}. It is told why in a new turn, whose reply comes back to you.`
    },
  }))

  const createBotTool = defineTool({
    name: 'create_bot',
    description: 'Main Bot only. Create a new Bot on the user\'s team. It appears in the sidebar and greets the user.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short display name, e.g. "Researcher" or "Editor"' },
      role: { type: 'string', required: true, description: 'Two-to-four character role label shown under the name' },
      instructions: { type: 'string', required: true, description: 'What this Bot is responsible for and how it should work' },
      brief: { type: 'string', description: 'Why the user wants it, passed to the new Bot as its first context' },
      model: { type: 'string', description: 'Model the Bot runs on, as provider/model or a model id. Only when the user names one; otherwise the team default model from Omni settings, or the model you run on.' },
      effort: { type: 'string', description: 'Thinking level for the model, as list_bot_models shows it. Only when the user names one.' },
      work_dir: WORK_DIR_PARAM,
      section: SECTION_PARAM,
      avatar: AVATAR_PARAM,
      deny_tools: DENY_TOOLS_PARAM,
      denyTools: DENY_TOOLS_PARAM,
    },
    output,
    async execute(args, exec) {
      if (Object.hasOwn(args, 'solverAuto')) throw refusal('Only the person can turn Auto on or off for a Solver.')
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only the Main Bot can create Bots. Ask the Main Bot instead.'
      try {
        const supplied = Object.hasOwn(args, 'avatar') && args.avatar !== undefined
        const avatar = supplied ? await readAvatar(args.avatar, { baseDir: rt.sessionFolder?.(exec.agent?.session ?? exec.agent), isData: rt.inData }) : undefined
        const workDir = args.work_dir ? await rt.cleanWorkDir(args.work_dir) : undefined
        const name = String(args.name ?? '').trim()
        await rt.approveFolder(exec, { path: workDir, who: { en: `the new Bot ${name}`, zh: `新 Bot ${name} ` } })
        // Without a named model the team's default applies; without one the new Bot
        // takes its creator's: the DSH default may be a provider that has no key, and
        // then the new Bot fails on its first reply.
        const creator = rt.botOf(self)
        const served = new Set((await rt.catalog()).filter(entry => entry.needsKey !== true && rt.isLocalAgentRef?.(entry.ref) !== true).map(entry => entry.ref))
        const denyTools = args.deny_tools ?? args.denyTools
        // A new Bot that will deny acp_tool skips a fallback that runs its own tools (#2026).
        const deniesAcp = deniesAcpTool([...(Array.isArray(creator?.denyTools) ? creator.denyTools : []),
          ...(Array.isArray(denyTools) ? denyTools : [])])
        const fallback = [state.prefs.defaultBotModel, creator?.model]
          .find(ref => ref && served.has(ref) && !(deniesAcp && rt.ownToolsRoute?.(ref) === true))
        const model = args.model || fallback
        const inheritAuto = rt.autoOpener?.()
        const readScopeSource = exec.agent?.session?.id ?? rt.callerSessionId?.() ?? exec.agent?.id
        // Only the parameters declared above can come from the model. Other options (an
        // existing Session to adopt, a Main Bot, a copy, a held model, a kind) are the
        // host's and the user's to give, never a model's: an undeclared argument is dropped.
        const bot = await rt.createBot({
          name: args.name,
          role: args.role,
          instructions: args.instructions,
          brief: args.brief,
          model,
          effort: args.effort,
          workDir,
          section: args.section,
          avatar: avatar === undefined ? undefined : { image: avatar },
          createdBy: self,
          ...(inheritAuto === undefined ? {} : { inheritAuto }),
          // Only when asked: an older call keeps the exact payload it had.
          ...(denyTools === undefined ? {} : { denyTools }),
        }, { readScopeSource })
        // A level taken from the creator is said, so the creator knows what the Bot may do.
        const inherited = creator && rt.permissionCatalog() && bot.permission
          ? ` Permission inherited from ${creator.name} (${bot.permissionAuto ? 'Auto' : bot.permission})${bot.permission === (creator.permission ?? rt.permissionCatalog()?.defaultPreset) ? '.' : ', no wider than this conversation.'}` : ''
        const denied = Array.isArray(creator?.denyTools) && creator.denyTools.length > 0
          ? ` It never gets the tools ${creator.name} does not have: ${creator.denyTools.join(', ')}.` : ''
        return `Created ${bot.name}${workDir ? `, working in ${workDir}` : ''}.${inherited}${denied} It is greeting the user now.`
      } catch (error) {
        return `Could not create the Bot: ${error.message}`
      }
    },
  })
  rt.teamTools.push({
    ...createBotTool,
    execute(args, exec) {
      // Some model providers send null for omitted arguments. Normalize it before DSH validates the string.
      if (args?.avatar !== null || !Object.hasOwn(args, 'avatar')) return createBotTool.execute(args, exec)
      const normalized = { ...args }
      delete normalized.avatar
      return createBotTool.execute(normalized, exec)
    },
  })

  rt.teamTools.push(defineTool({
    name: 'update_bot',
    description: 'Change a Bot\'s name, role, color, profile picture, model, thinking level, working folder, or instructions. Every Bot may change itself; only a Main Bot may change another Bot.',
    parameters: {
      bot: { type: 'string', description: 'Current name of the Bot to change; leave out to change yourself' },
      name: { type: 'string', description: 'New name' },
      role: { type: 'string', description: 'New role label' },
      instructions: { type: 'string', description: 'Replacement instructions' },
      color: { type: 'string', description: `One of ${[...COLORS, ...EXTRA_COLORS].join(', ')}` },
      avatar: { ...AVATAR_PARAM, description: `${AVATAR_PARAM.description} An empty string removes the photo and shows the Bot's character again.` },
      model: { type: 'string', description: 'Move the Bot to another model, as provider/model or a model id. It stays on what it runs on: only the user moves a Bot between Omni models and a local agent CLI, or between two CLIs, in its settings.' },
      effort: { type: 'string', description: 'Thinking level for the Bot\'s model, as list_bot_models shows; an empty string returns to the model\'s default' },
      work_dir: { ...WORK_DIR_PARAM, description: `${WORK_DIR_PARAM.description}; an empty string returns it to the team workspace` },
      deny_tools: DENY_TOOLS_PARAM,
      denyTools: DENY_TOOLS_PARAM,
      section: { ...SECTION_PARAM, description: `${SECTION_PARAM.description}; an empty string removes the Bot from its section (Main Bot only)` },
    },
    output,
    async execute(args, exec) {
      if (Object.hasOwn(args, 'solverAuto')) throw refusal('Only the person can turn Auto on or off for a Solver.')
      if (Object.hasOwn(args, 'people')) {
        const bot = args.bot ? rt.findBot(args.bot) : rt.botOf(rt.selfOf(exec.agent?.id))
        throw refusal('Only the user can choose who may talk to ' + (bot?.name ?? 'this Bot'))
      }
      const leave = rt.enterOwnership?.() ?? (() => {})
      try {
        await rt.load()
        const self = rt.selfOf(exec.agent?.id)
        const caller = rt.botOf(self)
        if (caller === undefined) return 'Only Bots on the team can use update_bot.'
        const bot = args.bot ? rt.findBot(args.bot) : caller
        if (bot === undefined) return `No Bot named ${args.bot}.`
        if (bot.id !== caller.id && !rt.isMain(self)) return 'Only a Main Bot can change another Bot. Leave out bot to change yourself, or ask a Main Bot with message_bot.'
        try {
          const { name: newName, role, instructions, color, model, effort, section } = args
          let image
          if (args.avatar !== undefined) {
            const input = typeof args.avatar === 'string' ? args.avatar.trim() : args.avatar
            image = input === null || input === '' ? null : await readAvatar(String(input), { baseDir: rt.sessionFolder?.(exec.agent?.session ?? exec.agent), isData: rt.inData })
          }
          const moving = typeof args.work_dir === 'string'
          const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined
          if (moving && workDir !== bot.workDir) await rt.approveFolder(exec, { path: workDir, sessions: rt.sessionsOfBot(bot.id), who: { en: bot.name, zh: ` ${bot.name} ` } })
          // The photo rides on the Bot's other avatar fields, as the settings page's upload
          // does: setting one keeps a custom character, and clearing removes only the image.
          // They are read here, after the waits above, so a change made meanwhile stays.
          const avatar = image === undefined ? undefined : { ...rt.botOf(bot.id)?.avatar, image }
          // `denyTools` needs no other field, so a list-only change is a patch of its own.
          const denyTools = args.deny_tools ?? args.denyTools
          const next = await rt.updateBot(bot.id, {
            ...(newName === undefined ? {} : { name: newName }),
            ...(role === undefined ? {} : { role }),
            ...(instructions === undefined ? {} : { instructions }),
            ...(color === undefined ? {} : { color }),
            ...(avatar === undefined ? {} : { avatar }),
            ...(model ? { model } : {}),
            ...(effort === undefined ? {} : { effort }),
            ...(section === undefined ? {} : { section }),
            ...(moving ? { workDir: workDir ?? '' } : {}),
            ...(denyTools === undefined ? {} : { denyTools }),
          }, self, exec.agent?.id)
          if (!moving) return `Updated ${next.name}.`
          const folder = workDir ?? 'the team workspace'
          return bot.id === caller.id ? `Updated ${next.name}. From your next step on, you work in ${folder}.` : `Updated ${next.name}. It now works in ${folder}.`
        } catch (error) {
          return `Could not update the Bot: ${error.message}`
        }
      } finally { leave() }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'delete_bot',
    description: 'Main Bot only. Delete a Bot from the team for good, only when the user explicitly asks to delete that Bot. Its memory and conversations are archived, its secrets are deleted, and it leaves every group chat; its tasks go on without it and its folder stays on disk. A Main Bot cannot be deleted, and neither can an adopted DSH bot.',
    parameters: {
      bot: { type: 'string', required: true, description: 'Exact Bot name from list_bots; this Bot is permanently removed from the team' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) refuse('Only a Main Bot can delete Bots.')
      const target = rt.findBot(args.bot)
      if (target === undefined) refuse(`No Bot named ${args.bot}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`)
      if (target.id === self) refuse('You cannot delete yourself.')
      // The same host deletion the sidebar's Delete calls: its own checks refuse a Main Bot
      // and an adopted DSH bot, and it removes membership, secrets and archived sessions.
      await rt.deleteBot(target.id)
      return `Deleted ${target.name}. Its memory and conversations are archived, its secrets are deleted, and it has left every group chat. Its tasks go on without it and its folder stays on disk.`
    },
  }))

  // DSH's working_directory changes a Session's folder in place, and the next part starts in
  // the Bot's working folder again. A Bot that changes to a folder outside its working folder
  // sets its working folder instead, with update_bot's checks, and goes on in a fresh part
  // there; a folder inside it only moves this Session there. In a group without a folder of
  // its own the change holds only for that conversation: the Bot's folder, its other groups
  // and its own chat keep theirs (folders.js memberDirs).
  ctx.on('tools/execute', async (exec, next) => {
    const cd = workingDirectoryCd(exec)
    const session = exec.agent?.session
    if (cd === '' || session === undefined) return next()
    await rt.load()
    const bot = callerBot(exec)
    if (bot === undefined) return next()
    // A Session its host runs changes folder as that host's own does; the Bot's working
    // folder stays as it is (parts.js `pinned`).
    if (bot.sessionPinned === true && rt.chatOf(bot.id) === exec.agent.id) return next()
    const room = rt.roomOf(rt.groupOwners.get(exec.agent.id)?.roomId)
    const home = rt.workDirOf({ botId: bot.id, roomId: room?.id }) ?? rt.teamFolder()
    const target = await rt.folderAt(rt.sessionFolder(session), cd)
    if (target === undefined || !(await rt.isFolder(target))) return next()
    // Even an in-place move inside the workspace must stay out of protected data.
    const workDir = await rt.workFolder(target)
    if (home === undefined || within(target, await rt.real(home))) return next()
    if (room?.workDir) throw new Error(`Every member of "${room.name}" works in ${room.workDir} here, so you stay inside it. The user or a Main Bot can change the group's folder.`)
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(`Your working folder cannot change now: ${readOnly}`)
    // Saved folders are trimmed like typed ones, so such a name would save another folder.
    if (unquote(target) !== target) throw new Error(`${JSON.stringify(target)} cannot be a working folder: its name starts or ends with a space or a quote mark.`)
    if (room !== undefined) {
      // The folder holds only for this group conversation, so only this Session's
      // writes widen; the private-Bot check is the one updateBot would run.
      await rt.checkPrivacyChange(bot, { moving: true, workDir })
      await rt.approveFolder(exec, { path: workDir, sessions: [exec.agent.id], who: { en: bot.name, zh: ` ${bot.name} ` } })
      const sessionId = exec.agent.id
      const release = rt.holdGrants?.({ sessionIds: [sessionId] })
      try {
        const result = await next()
        if (result?.isError !== true) {
          ;(room.memberDirs ??= {})[bot.id] = workDir ?? null
          room.scoped = true
          rt.endGrants?.(sessionId, 'group')
          await rt.save()
        }
        return result
      } finally {
        release?.()
      }
    }
    await rt.approveFolder(exec, { path: workDir, sessions: rt.sessionsOfBot(bot.id), who: { en: bot.name, zh: ` ${bot.name} ` } })
    const result = await next()
    if (result?.isError !== true) await rt.updateBot(bot.id, { workDir: workDir ?? '' }, rt.selfOf(exec.agent?.id))
    return result
  })

  rt.teamTools.push(defineTool({
    name: 'list_bot_models',
    description: 'List the models a Bot can run on, as provider/model refs for create_bot and update_bot. A model in use also lists the thinking levels it serves.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const caller = rt.botOf(rt.selfOf(exec?.agent?.id))
      if (caller !== undefined && rt.hostOwned?.(caller)) return `Your model is not a DSH model: the user picks it in your chat's model menu.`
      const models = await rt.catalog({ fresh: true })
      if (models.length === 0) return 'No models are configured. Ask the user to add one in Settings → Models.'
      const fallback = rt.defaultRef()
      // Only catalog entries that already carry `reasoning` (models a Bot runs on)
      // show levels; asking every model for its levels would take a call each.
      return models.map((entry) => {
        const levels = entry.reasoning?.efforts?.map(effort => effort.id) ?? []
        const thinking = levels.length > 0 ? `, thinking: ${levels.join(', ')}${entry.reasoning.defaultEffort === undefined ? '' : ` (default: ${entry.reasoning.defaultEffort})`}` : ''
        const local = rt.isLocalAgentRef?.(entry.ref) === true ? `, runs on the local agent ${entry.providerName}` : ''
        return `- ${entry.ref}${entry.name !== entry.id ? ` (${entry.name})` : ''}${local}${entry.input?.includes('image') ? ', reads images' : ''}${entry.ref === fallback ? ', default' : ''}${thinking}`
      }).join('\n')
    },
  }))

  // Group tools take Bot names as an array, or as one comma-separated string from
  // models that flatten it.
  const nameList = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、]/) : [])
    .map(item => String(item ?? '').trim()).filter(Boolean)
  const resolveBots = (refs) => {
    const bots = []
    const unknown = []
    for (const ref of nameList(refs)) {
      const bot = rt.findBot(ref)
      if (bot === undefined) unknown.push(ref)
      else if (!bots.includes(bot)) bots.push(bot)
    }
    return { bots, unknown }
  }
  const teamNames = () => Object.values(state.bots).map(bot => bot.name).join(', ')
  const groupNames = self => visibleRooms(self).map(room => `"${room.name}"`).join(', ') || 'none'
  const pickRoom = (ref, self) => {
    const matches = rt.findRooms(ref).filter(room => visibleRooms(self).includes(room))
    if (matches.length === 1) return { room: matches[0] }
    if (matches.length > 1) return { error: `Several group chats are called "${unquote(ref)}". Rename one first.` }
    return { error: `No group chat called "${unquote(ref)}" that you can see. Groups: ${groupNames(self)}.` }
  }

  rt.teamTools.push(defineTool({
    name: 'create_group',
    description: 'Main Bot only. Create a group chat with the user and some Bots. You join it as its admin unless you name another member.',
    parameters: {
      members: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact names of the other Bots to add; you are added automatically' },
      name: { type: 'string', description: 'Group name; defaults to the member names' },
      notice: { type: 'string', description: 'Shared instructions every member reads before speaking in this group; at most 2000 characters' },
      admin: { type: 'string', description: 'Member who leads the group; defaults to you' },
      mode: MODE_PARAM,
      section: SECTION_PARAM,
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can create group chats. Ask a Main Bot instead.'
      const { bots, unknown } = resolveBots(args.members)
      if (unknown.length > 0) return `No Bot named ${unknown.join(', ')}. Team: ${teamNames()}`
      const admin = args.admin ? rt.findBot(args.admin) : rt.botOf(self)
      if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`
      const members = [...new Set([self, ...bots.map(bot => bot.id), admin.id])]
      try {
        const room = await rt.createRoom({ members, name: args.name, notice: args.notice, mode: args.mode, admin: admin.id, section: args.section, createdBy: self })
        return `Created group "${room.name}" with ${room.members.map(id => rt.botOf(id).name).join(', ')}. ${admin.id === self ? 'You are' : `${admin.name} is`} its admin. It is in the user's sidebar; use post_to_group to start a discussion there.`
      } catch (error) {
        if (isGuardGroupRefusal(error)) return error.message
        return `Could not create the group: ${error.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'update_group',
    description: 'Change a group chat: rename it, set its notice, add or remove members, change its admin or reply mode. Main Bots may change any group; a group\'s admin may change its own group.',
    parameters: {
      group: GROUP_REF,
      name: { type: 'string', description: 'New group name; an empty string names it after its members again' },
      notice: { type: 'string', description: 'Replacement notice, the shared instructions every member reads; an empty string clears it; at most 2000 characters' },
      add_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to add' },
      remove_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to remove' },
      admin: { type: 'string', description: 'Member to make the admin; "none" leaves the group without one (Main Bots only)' },
      mode: MODE_PARAM,
      work_dir: { ...WORK_DIR_PARAM, description: `${WORK_DIR_PARAM.description}. Every member works there in this group; an empty string lets each member work in its own folder again (Main Bots only)` },
      section: { ...SECTION_PARAM, description: `${SECTION_PARAM.description}; an empty string removes the group from its section (Main Bots only)` },
    },
    output,
    async execute(args, exec) {
      const leave = typeof args.work_dir === 'string' ? rt.enterOwnership?.() ?? (() => {}) : () => {}
      try {
        await rt.load()
        const self = rt.selfOf(exec.agent?.id)
        if (rt.botOf(self) === undefined) return 'Only Bots on the team can use update_group.'
        const { room, error } = pickRoom(args.group, self)
        if (error) return error
        const moving = typeof args.work_dir === 'string'
        if (moving && !rt.isMain(self)) return `Only a Main Bot can set the folder of "${room.name}".`
        if (args.section !== undefined && !rt.isMain(self)) return `Only a Main Bot can move "${room.name}" between sidebar sections.`
        const add = resolveBots(args.add_members)
        const remove = resolveBots(args.remove_members)
        const unknown = [...add.unknown, ...remove.unknown]
        if (unknown.length > 0) return `No Bot named ${unknown.join(', ')}. Team: ${teamNames()}`
        let admin
        if (args.admin !== undefined && args.admin !== '') {
          if (/^(none|nobody|null|无|没有)$/i.test(String(args.admin).trim())) admin = null
          else {
            admin = rt.findBot(args.admin)?.id
            if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`
          }
        }
        try {
          const seats = { add: add.bots.map(bot => bot.id), remove: remove.bots.map(bot => bot.id) }
          if (moving) rt.checkRoomJoins(room, seats, self)
          const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined
          const live = rt.roomOf(room.id)
          if (live === undefined) throw refusal('Unknown group chat')
          // A Bot that joins a group with a folder works there from its first turn.
          const joining = rt.checkRoomJoins(live, seats, self)
          if (moving && workDir !== live.workDir) {
            const members = [...live.members, ...joining.map(bot => bot.id)]
            await rt.approveFolder(exec, { path: workDir, sessions: members.map(id => live.sessions?.[id]).filter(Boolean), who: { en: `every member of "${live.name}"`, zh: `群聊「${live.name}」的成员` } })
          } else if (joining.length > 0) {
            const names = joining.map(bot => bot.name)
            await rt.approveFolder(exec, { path: live.workDir, sessions: joining.map(bot => live.sessions?.[bot.id]).filter(Boolean), who: { en: names.join(', '), zh: ` ${names.join('、')} ` } })
          }
          const { room: next, changes } = await rt.updateRoom(room.id, {
            name: args.name,
            notice: args.notice,
            mode: args.mode,
            admin,
            ...seats,
            ...(args.section === undefined ? {} : { section: args.section }),
            ...(moving ? { workDir: workDir ?? '' } : {}),
          }, self)
          return changes.length === 0 ? `Nothing changed in "${next.name}".` : `Updated "${next.name}": ${changes.join('; ')}.`
        } catch (failure) {
          if (isGuardGroupRefusal(failure)) return failure.message
          return `Could not update "${room.name}": ${failure.message}`
        }
      } finally { leave() }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'delete_group',
    description: 'Main Bot only. Delete a group chat; its history is archived. Only when the user asks.',
    parameters: { group: GROUP_REF },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can delete group chats.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      if (rt.roomBusy(room.id)) return `"${room.name}" is in the middle of a round. Delete it after the round ends.`
      await rt.deleteRoom(room.id)
      return `Deleted "${room.name}". Its history is archived.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'post_to_group',
    description: 'Post a message into a group chat as yourself. A Main Bot may post into any group, any other Bot into a group it is in. A Main Bot\'s or the group admin\'s post starts a round: members reply in the group, where the user reads them. Another member\'s post calls only the members it names with "@Name"; without one it is only written into the group.',
    parameters: {
      group: GROUP_REF,
      message: { type: 'string', required: true, description: 'What to say; write "@Name" to choose who answers, and a name without "@" to only mention a member' },
      report_back: { type: 'boolean', description: 'Also send the members\' replies back to you as a new message when the round ends' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const sender = rt.botOf(self)
      if (sender === undefined) return 'Only Bots on the team can use post_to_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      // An ordinary member's post calls only the members it names (openingSpeakers).
      const member = !rt.isMain(self) && !rt.isAdminOf(room, self)
      const info = rt.live.get(exec.agent?.id)?.info
      if (info?.role === 'room' && info.roomId === room.id) return `You are speaking in "${room.name}" right now. Write your message as your reply instead.`
      const text = absoluteLinks(String(args.message ?? '').trim(), rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      if (text === '') return 'Write a message to post.'
      // Counted on the whole message. A post past MESSAGE_INLINE_MAX keeps only its
      // first LONG_HEAD characters, and the round reads this list instead of that text.
      const spans = mentionSpans(text, room.members.map(rt.botOf).filter(Boolean))
      const named = []
      for (const span of spans) {
        if (span.bot && span.bot.id !== self && !named.includes(span.bot.id)) named.push(span.bot.id)
      }
      const mentions = { ids: named, all: spans.some(span => span.all === true) }
      const reportBack = args.report_back === true
      if (member && reportBack && named.length === 0) {
        return 'Nobody would answer: your post only calls the members you name. Write "@Name" for each member who should answer, or post without report_back.'
      }
      const long = await rt.attachLong(text, `Post from ${sender.name}.txt`)
      if (long === undefined) return tooLong(text)
      // Replies the poster waits for, while it works on what a Bot asked it for, are
      // work handed on for that request (handoffs.js).
      const work = reportBack ? worksOf(exec).find(id => rt.ownsWork(self, id)) : undefined
      const sub = work === undefined ? undefined : randomUUID()
      if (sub !== undefined) rt.openWork(sub, { from: self, room: room.id, parent: work })
      try {
        // A post that wants the replies names the conversation it was written
        // from, so the report comes back there instead of the own chat.
        await rt.postToRoom(room, sender, long.text, { mentions, ...(reportBack ? { reportBack: true, ...callerRoom(exec) } : {}), ...(member ? { member: true } : {}), ...(sub ? { sub } : {}), ...(long.length ? { length: long.length } : {}), ...(long.files.length > 0 ? { excerpt: headOf(text, LONG_HEAD) } : {}) }, long.files)
      } catch (failure) {
        if (sub !== undefined) rt.dropWork(sub)
        return `Could not post in "${room.name}": ${failure.message}`
      }
      if (member && named.length === 0) return `Posted in "${room.name}", where the user and its members read it. Nobody answers it: your post only calls the members you name with @Name.`
      if (named.length > 0) {
        const turn = turnOf(exec)
        const earlier = calledInPosts.get(exec.agent?.id)
        const calls = new Map(earlier !== undefined && earlier.turn === turn ? earlier.calls : [])
        for (const id of named) calls.set(id, room.name)
        calledInPosts.set(exec.agent?.id, { turn, calls })
      }
      const asker = sub === undefined ? undefined : rt.botOf(state.works[work]?.from)?.name
      const waits = asker ? ` End your turn when you have handed on everything: the replies bring you back to this work, and your answer goes to ${asker} once all of it is back.` : ''
      return `Posted in "${room.name}". Members reply there, where the user reads them${reportBack ? '; their replies also come back to you as a new message when the round ends' : ', and nothing comes back to you'}.${waits}`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'ask_user',
    description: 'Show the user a short multiple-choice question card in the chat (the user can also type their own answer). Calling it ends your turn; the chosen answer arrives later as the user\'s next message.',
    parameters: {
      question: { type: 'string', required: true, description: 'One short question' },
      options: {
        type: 'array',
        required: true,
        description: 'Two to four answers',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'Short answer shown on the option' },
            description: { type: 'string', description: 'Optional one-line explanation under the label' },
          },
        },
      },
      detail: { type: 'string', description: 'Optional one-line context shown under the question' },
      multiSelect: { type: 'boolean', description: 'Allow choosing several options' },
      allowCustom: { type: 'boolean', description: 'Also offer a field for an answer in the user\'s own words' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      if (rt.groupOwners.has(id)) return 'Question cards only work in your own chat. In a group, ask in your message instead.'
      if (!rt.chatOwners.has(id)) return `Only Bots on the team can use ask_user. Use ${BLOCKING_QUESTION_TOOL} if it is available in this session, or ask the user in your reply.`
      const options = questionOptions(args.options)
      if (options.length === 0) return 'Give at least one option.'
      const card = {
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        question: String(args.question ?? '').trim(),
        ...(args.detail ? { detail: String(args.detail).trim() } : {}),
        options,
        multiSelect: args.multiSelect === true,
        ...(args.allowCustom === true ? { allowCustom: true } : {}),
        askedAt: Date.now(),
      }
      await rt.solverQuestion?.(rt.chatOwners.get(id), card.callId ?? card.id)
      state.questions[id] = card
      await rt.save()
      rt.cardShown?.(id, 'question', state.questions[id].question)
      exec.concludeTurn?.()
      return 'The card is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  // Scoped per Bot session, not global: another plugin's global show_view serves
  // the sessions ds-bot does not own, while this one shadows it inside them.
  rt.teamTools.push(defineTool({
    name: 'show_view',
    description: showViewDescription({ where: 'your own chat' }),
    parameters: showViewParameters,
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      if (rt.groupOwners.has(id)) return 'View cards only work in your own chat. In a group, ask in your message instead.'
      if (!rt.chatOwners.has(id)) return `Only Bots on the team can use show_view. Use ${BLOCKING_QUESTION_TOOL} if it is available in this session, or ask the user in your reply.`
      const checked = checkShownView(args.title, args.view)
      if (checked.error !== undefined) return checked.error
      const title = checked.title
      const view = checked.view
      if (!checked.interactive && args.await_reply === true) return 'This view has nothing to submit; call show_view with await_reply: false.'
      if (checked.interactive && args.await_reply === false) return 'This view has controls to submit, so it waits for the user\'s answer; call show_view without await_reply: false.'
      const awaitReply = args.await_reply ?? checked.interactive
      if (!awaitReply) return 'The view is on screen.'
      state.views[id] = {
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        title,
        view,
        askedAt: Date.now(),
      }
      await rt.save()
      rt.cardShown?.(id, 'view', title)
      exec.concludeTurn?.()
      return 'The view is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  // A page of the team's Settings as a card in the Bot's own chat (settings-card.js): the
  // same page the Settings dialog draws, live, saving through the same actions. It changes
  // nothing itself, and every change on it is the user's click: a Bot can show a setting
  // only the user may change, such as the tools it is denied, but never change it.
  rt.teamTools.push(defineTool({
    name: 'show_settings',
    description: 'Show the user a page of the team\'s Settings as a card in your own chat, so they can see and change it without leaving the chat. The card is the real Settings page, live: what they change there is saved as in Settings, and only their own clicks change it. Use it when the user wants to see or change something set up in Automagik, and for what only the user may change (the tools a Bot is denied, who may send, keys, permissions). Name a Bot to open its own settings (page bots), its scheduled tasks (schedules) or its usage (usage); name a group to open its settings (page groups). A page another plugin adds is plugin:<id>. It does not end your turn.',
    parameters: {
      page: { type: 'string', required: true, description: `Which page: ${SHOWABLE_PAGES.join(', ')}, or plugin:<id> for a page another plugin adds` },
      bot: { type: 'string', description: 'Exact Bot name from list_bots, for page bots, schedules or usage' },
      group: { type: 'string', description: 'Exact group chat name, for page groups' },
      note: { type: 'string', description: 'One short line shown on the card: what to look at or change there' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      if (rt.groupOwners.has(id)) return 'Settings cards only work in your own chat. In a group, say where the setting is instead.'
      if (!rt.chatOwners.has(id)) return 'Only Bots on the team can use show_settings.'
      const page = String(args.page ?? '').trim()
      if (!isShowablePage(page)) return `No Settings page named ${JSON.stringify(page)}. Pick one of ${SHOWABLE_PAGES.join(', ')}, or plugin:<id>.`
      const named = []
      if (args.bot !== undefined && String(args.bot).trim() !== '') {
        if (!['bots', 'schedules', 'usage'].includes(page)) return 'Name a Bot only with page bots, schedules or usage.'
        const bot = rt.findBot(String(args.bot))
        if (bot === undefined) return `No Bot named ${args.bot}.`
        named.push(bot.name)
      }
      if (args.group !== undefined && String(args.group).trim() !== '') {
        if (page !== 'groups') return 'Name a group only with page groups.'
        const rooms = rt.findRooms(String(args.group))
        if (rooms.length === 0) return `No group chat named ${args.group}.`
        if (rooms.length > 1) return `More than one group chat is named ${args.group}; ask the user which one.`
        named.push(rooms[0].name)
      }
      const note = String(args.note ?? '').trim()
      if (note.length > 200) return 'Keep the note to one short line (200 characters at most).'
      return `Showing Settings → ${page}${named.length ? ` (${named.join(', ')})` : ''} in the chat. The user changes it there; nothing has changed yet.`
    },
  }))

  // A change to a Bot's setup, proposed as a card that shows each field as it is and as it
  // would be (settings-card.js). Nothing changes until the user presses Apply there, which
  // saves through the same path as the Bot's settings form, as the user. What only the user
  // may set (the tools a Bot is denied, private, browser grants) is never in a proposal.
  rt.teamTools.push(defineTool({
    name: 'propose_bot_change',
    description: 'Propose a change to a Bot\'s setup as a card in your own chat: each field as it is now and as it would be, with Apply and Dismiss. Nothing changes until the user presses Apply, so use it instead of update_bot when the user should see and approve the change first, or when several fields change together. Leave out bot to propose a change to yourself; only a Main Bot proposes changes to other Bots. It does not end your turn.',
    parameters: {
      bot: { type: 'string', description: 'Exact Bot name from list_bots; leave out for yourself' },
      name: { type: 'string', description: 'New name' },
      role: { type: 'string', description: `New role label, ${ROLE_MAX} characters at most` },
      instructions: { type: 'string', description: 'Replacement instructions' },
      work_dir: { type: 'string', description: 'Full path of the new working folder; an empty string returns it to the team workspace' },
      model: { type: 'string', description: 'New model, as provider/model or a model id from list_bot_models' },
      effort: { type: 'string', description: 'New thinking level, as list_bot_models shows; an empty string returns to the model\'s default' },
      note: { type: 'string', description: 'One short line shown on the card: why this change' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      if (rt.groupOwners.has(id)) return 'Proposal cards only work in your own chat. In a group, describe the change instead.'
      if (!rt.chatOwners.has(id)) return 'Only Bots on the team can use propose_bot_change.'
      const self = rt.selfOf(id)
      const caller = rt.botOf(self)
      if (caller === undefined) return 'Only Bots on the team can use propose_bot_change.'
      const bot = args.bot ? rt.findBot(String(args.bot)) : caller
      if (bot === undefined) return `No Bot named ${args.bot}.`
      if (bot.id !== caller.id && !rt.isMain(self)) return 'Only a Main Bot can propose changes to another Bot. Leave out bot to propose a change to yourself.'
      const note = String(args.note ?? '').trim()
      if (note.length > 200) return 'Keep the note to one short line (200 characters at most).'
      const asked = {}
      for (const [key, arg] of PROPOSAL_FIELDS) {
        if (args[arg] === undefined || args[arg] === null) continue
        asked[key] = String(args[arg])
      }
      if (Object.keys(asked).length === 0) return 'Propose at least one change: name, role, instructions, work_dir, model or effort.'
      // While the review guard is on, only the person moves the Bot to another model (H5-1): no card.
      if (asked.model !== undefined && bot.reviewGuard === true) {
        return `${bot.name}'s review guard is on, so its model cannot be proposed here. Only the person can change it, in ${bot.name}'s Settings.`
      }
      const proposal = {}
      try {
        if (asked.name !== undefined) {
          const name = asked.name.trim()
          if (name === '' || name.length > 40) return 'A name has 1 to 40 characters.'
          proposal.name = name
        }
        if (asked.role !== undefined) {
          const role = asked.role.trim()
          if (role.length > ROLE_MAX) return `A role label has ${ROLE_MAX} characters at most.`
          proposal.role = role
        }
        if (asked.instructions !== undefined) proposal.instructions = asked.instructions.trim()
        if (asked.workDir !== undefined) proposal.workDir = asked.workDir.trim() === '' ? '' : await rt.cleanWorkDir(asked.workDir.trim())
        if (asked.model !== undefined) {
          if (asked.model.trim() === '') return 'Name the model to move to; list_bot_models shows them.'
          proposal.model = await rt.resolveModel(asked.model.trim(), { checkAccess: true, remember: false, keep: bot.model })
        }
        if (asked.effort !== undefined) {
          const ref = proposal.model ?? bot.model ?? bot.appliedModel
          if (asked.effort.trim() === '') proposal.effort = ''
          else if (ref === undefined) return 'Propose a model first: this Bot has none to set a thinking level on.'
          else {
            const effort = await rt.resolveEffort(ref, asked.effort.trim())
            if (effort === undefined) return `${asked.effort} is not a thinking level of ${ref}; list_bot_models shows them.`
            proposal.effort = effort
          }
        }
      } catch (error) {
        return error?.message ?? String(error)
      }
      const current = { name: bot.name, role: bot.role ?? '', instructions: bot.instructions ?? '', workDir: bot.workDir ?? '', model: bot.model ?? bot.appliedModel ?? '', effort: bot.effort ?? '' }
      for (const key of Object.keys(proposal)) if (proposal[key] === current[key]) delete proposal[key]
      if (Object.keys(proposal).length === 0) return `Nothing to propose: ${bot.name} already has these settings.`
      const fields = Object.keys(proposal).join(', ')
      return `Proposed for ${bot.name}: ${fields}. The card is on screen; nothing changes until the user presses Apply.\n${proposalLine({ bot: bot.id, ...(note ? { note } : {}), change: proposal })}`
    },
  }))

  // The team tools live in each Session's own scope, never in the global layer:
  // a Bot's chat and a member's group Session get all of them, a group's own
  // Session gets only its relay, and a Session ds-bot does not own gets none —
  // so they never appear in a plain dsh conversation, and another plugin's
  // same-named global tool can neither collide with them at boot nor shadow
  // them inside these Sessions. What is scoped onto a Session is kept by its
  // disposers and goes with the ownership: indexSessions (store.js) runs
  // syncScopedTools on every save and adopt, so a deleted Bot's adopted
  // Session, a member who left, or a deleted group shows the plain dsh surface
  // again — and the unload effect lifts whatever is left. The same sync scopes
  // the live Agents back: a reload lifts their scope while they are still
  // live, and agent/created does not fire for them again, so without the walk
  // their next request would come without the team tools.
  /** @type {Map<string, {agent: any, relay: boolean, tools: boolean, restricted: boolean, filtered: boolean, disposers: Array<() => void>, unlisted: Set<string>}>} */
  const scoped = new Map()
  const unscope = (id) => {
    const held = scoped.get(id)
    if (held === undefined) return
    scoped.delete(id)
    for (const dispose of [...(held.packageLifts ?? []), ...held.disposers, ...(held.roleLifts ?? [])]) {
      try {
        dispose()
      } catch (error) {
        rt.warn('omni-ui: a scoped tool of %s was not removed: %s', id, error)
      }
    }
  }
  const syncScopedTools = () => {
    // unscope() deletes as it goes, which a Map keys iterator takes in stride.
    for (const id of scoped.keys()) {
      if (!rt.isBotSession(id) && rt.roomOf(id) === undefined && !scoped.get(id)?.skill) unscope(id)
    }
    // A reload lifts the scope of Agents that are still live, and an adopted
    // file can newly own one that already runs: scope each live Agent the team
    // owns before its next request. hideBotUnusedTools does nothing for a
    // Session that stays unowned, and nothing twice for one already scoped.
    for (const agent of ctx.get?.('agents')?.list?.() ?? []) hideBotUnusedTools(agent)
  }
  ctx.effect(() => () => { for (const id of scoped.keys()) unscope(id) }, 'omni-ui: scoped team tools')

  // A wanted Session whose Agent cannot take scoped tools yet is warned about
  // once; held.tools stays unset, so the next step's check tries again.
  const registerless = new WeakSet()
  const packageToolCollision = name => [...scoped.values()].some(held => !held.relay && !held.skill
    && !held.packageNames?.includes(name) && ctx.tools?.get?.(name, held.agent) !== undefined)
  const syncPackageTools = (agent, held) => {
    const role = rt.roleRuntime?.tools?.(agent, held.packageKey)
    if (held.packageKey === role?.key) return
    for (const dispose of held.packageLifts ?? []) dispose()
    for (const name of held.packageNames ?? []) {
      held.unlisted.delete(name)
      ;(held.removedPackages ??= new Set()).add(name)
    }
    held.packageKey = undefined
    held.packageLifts = []
    held.packageNames = []
    if (!role) return
    const lifts = [role.dispose]
    try {
      for (const def of role.definitions) {
        const dispose = agent.ctx?.tools?.register?.(def)
        if (typeof dispose !== 'function') throw new Error('Role tools need a disposable Session registration.')
        lifts.push(dispose)
      }
    } catch (error) {
      for (const dispose of lifts) dispose()
      rt.warn?.('omni-ui: role tools not served to %s: %s', agent.session?.id, error)
      return
    }
    held.packageKey = role.key
    held.packageLifts = lifts
    held.packageNames = role.definitions.map(def => def.name)
    for (const name of held.packageNames) {
      held.removedPackages?.delete(name)
      held.unlisted.add(name)
    }
  }
  const shareBotTools = (agent) => {
    if (agent === undefined) return
    const id = agent.session?.id
    const owns = rt.isBotSession(id)
    const relayOnly = !owns && rt.roomOf(id) !== undefined
    const skillOnly = !owns && !relayOnly && rt.skillCalls?.workerAvailable?.(id, agent) === true
    const wanted = owns || relayOnly || skillOnly
    let held = scoped.get(id)
    // The local-agent tools (the CLI permission bridge) join the scope only of
    // a Bot whose route is a local agent; they are not in rt.teamTools. A Bot
    // can move onto or off a local route after its Agent exists.
    const self = owns ? rt.botOf(rt.selfOf(id)) : undefined
    const localBot = rt.isLocalAgentRef?.(self?.model ?? self?.appliedModel) === true
    // A Session that left the team, a scope of the wrong kind, a fresh Agent
    // for one Session, or a Bot that changed between a local route and a model
    // all start over; a wanted scope is registered again below.
    if (held !== undefined && (!wanted || held.agent !== agent || held.relay !== relayOnly ||
        (held.skill === true) !== skillOnly || (held.tools === true && held.local !== localBot))) {
      unscope(id)
      held = undefined
    }
    if (!wanted) return
    const definitions = [...rt.teamTools, ...(localBot ? (rt.localAgentTools ?? []) : [])]
      .filter(def => (!relayOnly || def.name === 'group_relay') && (!skillOnly || def.name === SKILL_TOOL))
    // A live Agent can be scoped while the modules that add tools are still installing:
    // loading the plugin again walks the live Agents from the load the memory module
    // starts, and the tools added after it (memory, secrets, connectors) would never
    // join that scope. Register what it is missing, so the next request is whole.
    if (held?.tools === true) {
      for (const def of definitions) {
        if (def.name === 'solver_progress' && !rt.chatOwners.has(id)) continue
        if (held.added?.has(def.name) === true) continue
        try {
          const dispose = registerTrustedTool(agent.ctx.tools, def)
          if (typeof dispose === 'function') {
            ;(held.toolLifts ??= new Map()).set(def.name, dispose)
            held.disposers.push(dispose)
          }
          // Recorded only once the Agent took it: one that failed is tried again at
          // the next assemble, so a reload cannot leave that tool out for good.
          ;(held.added ??= new Set()).add(def.name)
          held.unlisted.add(def.name)
        } catch (error) {
          // A name the replaced plugin's scope still holds reads as already
          // registered. It is left out of `added`, so the next assemble tries again
          // once that scope is released, and it is not reported as a new failure.
          if (/already registered/i.test(String(error?.message ?? error))) continue
          if (held.missed?.has(def.name) === true) continue
          ;(held.missed ??= new Set()).add(def.name)
          rt.warn('omni-ui: team tool %s not added to %s: %s', def.name, id, error)
        }
      }
      return
    }
    if (typeof agent.ctx?.tools?.register !== 'function') {
      if (!registerless.has(agent)) {
        registerless.add(agent)
        rt.warn('omni-ui: %s needs the team tools but its Agent cannot register them yet', id)
      }
      return
    }
    const disposers = []
    const failed = []
    const registered = []
    for (const def of definitions) {
      if (def.name === 'solver_progress' && !rt.chatOwners.has(id)) continue
      try {
        const dispose = registerTrustedTool(agent.ctx.tools, def)
        if (typeof dispose === 'function') {
          disposers.push(dispose)
          ;(held ??= { relay: relayOnly, tools: false, restricted: false, filtered: false, disposers: [], unlisted: new Set() }).toolLifts ??= new Map()
          held.toolLifts.set(def.name, dispose)
        }
        registered.push(def.name)
      } catch (error) {
        // A tool another plugin already scoped onto this agent stays missing
        // rather than stopping the team; the rest still land.
        failed.push(`${def.name}: ${error.message ?? error}`)
      }
    }
    held ??= { relay: relayOnly, tools: false, restricted: false, filtered: false, disposers: [], unlisted: new Set() }
    held.agent = agent
    held.relay = relayOnly
    held.skill = skillOnly
    held.tools = true
    held.local = localBot
    held.disposers.push(...disposers)
    held.added = new Set(registered)
    scoped.set(id, held)
    // A scope made outside creation never reached a collected tool list; the
    // assemble adds the pending names to the step's list once, then clears them.
    for (const name of registered) held.unlisted.add(name)
    if (failed.length > 0) rt.warn('omni-ui: team tools not served to %s: %s', id, failed.join('; '))
  }

  // The standard preset registers `subagent` (model selection) in each Agent's own
  // scope, where restrict() and a same-name section cannot reach it, so the Bot's
  // assembly drops the hidden tools and their guidance instead. restrict still
  // masks what it can, so lookup and execution stay aligned, and the guard
  // refuses calls. The assembly filter goes on every Bot Session whether or not
  // the tools are served yet: subagent's own agent/created listener can run
  // after this one.
  const filterBotAssembly = (agent, held) => {
    if (held.filtered === true || typeof agent.ctx?.on !== 'function') return
    const id = agent.session?.id ?? agent.id
    const hidden = hiddenToolsOf(id)
    const hiddenSections = hiddenSectionsOf(id)
    const dispose = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      // DSH 0.2.2 adds the tool list after this waterfall (#814), so only an
      // older assembly still carries tools to drop here.
      return {
        ...assembled,
        ...Array.isArray(assembled.tools) ? { tools: assembled.tools.filter(tool => !hidden.includes(tool.name)) } : {},
        sections: assembled.sections.filter(section => !hiddenSections.has(section.name)),
      }
    })
    held.filtered = true
    if (typeof dispose === 'function') held.disposers.push(dispose)
  }

  // Tools joined after the first scoping (mail tools appear when the first
  // account is added) register into every held Agent and are offered once.
  const addTeamTool = (def) => {
    if (rt.teamTools.some(tool => tool.name === def.name)) return
    rt.teamTools.push(def)
    for (const held of scoped.values()) {
      if (held.relay || held.skill || typeof held.agent?.ctx?.tools?.register !== 'function') continue
      try {
        const dispose = held.agent.ctx.tools.register(def)
        if (typeof dispose === 'function') held.disposers.push(dispose)
        ;(held.added ??= new Set()).add(def.name)
        held.unlisted.add(def.name)
      } catch { /* an agent that refuses it simply lacks the tool */ }
    }
  }
  const removeTeamTool = (name) => {
    const at = rt.teamTools.findIndex(tool => tool.name === name)
    if (at !== -1) rt.teamTools.splice(at, 1)
    // Scoped registrations already handed out are disposed by name.
    for (const held of scoped.values()) {
      held.toolLifts?.get(name)?.()
      held.toolLifts?.delete(name)
      held.added?.delete(name)
      held.unlisted.delete(name)
    }
  }

  // Per-Bot connector switches (state.connectors[id].offFor): deny the served
  // tools matching each off connector's prefix. Re-applied on tools/change.
  const maskConnectorTools = (agent, held) => {
    if (typeof agent.ctx?.tools?.restrict !== 'function' || typeof ctx.tools?.schemas !== 'function') return
    const botId = rt.selfOf(agent.session?.id)
    const prefixes = rt.connectorOffFor?.(botId) ?? []
    const served = new Set(ctx.tools.schemas(agent).map(schema => schema.name))
    const deny = [...served].filter(name => prefixes.some(prefix => name.startsWith(prefix)))
    const before = held.connectorDenied ?? new Set()
    if (deny.length === before.size && deny.every(name => before.has(name))) return
    for (const lift of held.connectorLifts ?? []) { try { lift() } catch { /* already lifted */ } }
    held.connectorLifts = []
    held.connectorDenied = new Set(deny)
    for (const name of deny) {
      try {
        const lift = agent.ctx.tools.restrict({ deny: [name] })
        if (typeof lift === 'function') held.connectorLifts.push(lift)
      } catch { /* a scoped name cannot be restricted; connectors are global */ }
    }
  }
  const maskRoleTools = (agent, held) => {
    if (typeof agent.ctx?.tools?.restrict !== 'function' || typeof ctx.tools?.schemas !== 'function') return
    const wanted = withheldRoleTools(roleBotOf(agent.session?.id))
    const before = held.roleDenied ?? new Set()
    if (wanted.length === 0 && before.size === 0) return
    // Visible schemas omit the names we already masked. Prefer the registry's
    // pre-restriction view so our mask stays in place when other masks lift.
    const served = ctx.tools.view?.(agent)?.restrictableNames
      ?? new Set([...before, ...ctx.tools.schemas(agent).map(schema => schema.name)])
    const deny = wanted.filter(name => served.has(name))
    if (deny.length === before.size && deny.every(name => before.has(name))) return
    // Update the held names before restrict/lift, which can emit tools/change.
    held.roleDenied = new Set(deny)
    for (const lift of held.roleLifts ?? []) { try { lift() } catch { /* already lifted */ } }
    held.roleLifts = []
    for (const name of deny) {
      try {
        const lift = agent.ctx.tools.restrict({ deny: [name] })
        if (typeof lift === 'function') held.roleLifts.push(lift)
      } catch { /* the executor guard still refuses the call */ }
    }
  }
  const dropUnavailableWorkerTools = () => {
    for (const [id, held] of scoped) {
      if (held.skill && rt.skillCalls?.workerAvailable(id, held.agent) !== true) unscope(id)
    }
  }
  const reapplyToolMasks = () => {
    // Local tools bypass DSH masks. Lift the definition as soon as a
    // profile filter changes so the ACP bridge observes the same surface.
    dropUnavailableWorkerTools()
    for (const held of scoped.values()) {
      if (held.agent === undefined || held.skill) continue
      try { maskConnectorTools(held.agent, held) } catch (error) { rt.warn('omni-ui: connector mask failed: %s', error) }
      try { maskRoleTools(held.agent, held) } catch (error) { rt.warn('omni-ui: role mask failed: %s', error) }
    }
  }

  // restrict() throws on a name this profile does not serve.
  const maskHiddenTools = (agent, held, served) => {
    const groups = hiddenToolGroupsOf(agent.session?.id ?? agent.id)
      .map(group => group.filter(name => served.has(name))).filter(group => group.length > 0)
    if (groups.length === 0) return
    // Marked after one attempt even when a group fails, so a profile that can
    // never mask it is not re-masked on every resolve.
    held.restricted = true
    for (const deny of groups) {
      try {
        const lift = agent.ctx.tools.restrict({ deny })
        if (typeof lift === 'function') held.disposers.push(lift)
      } catch {
        // A name in the Agent's own scope fails the whole list (restrict() masks
        // inherited tools only), so mask the rest one at a time; what stays is
        // covered by the assembly filter and the guard.
        for (const name of deny) {
          try {
            const lift = agent.ctx.tools.restrict({ deny: [name] })
            if (typeof lift === 'function') held.disposers.push(lift)
          } catch {
            // Expected for names in the Agent's own scope.
          }
        }
      }
    }
  }

  // dsh's own question tool holds the turn open until the user answers, and every
  // message from another Bot or a group round queues behind it. Bot Sessions ask
  // through ask_user instead, so it is taken out of their tool list. DSH's goal tools
  // stay in a Bot's own chat and go with the question tool in a group Session, whose
  // goal is the group's own. The restricts are kept with the Session's scope, so they
  // lift with it. A native DSH Bot keeps DSH's own question and goal tools.
  const nativeDshSession = id => rt.botOf(rt.selfOf(id))?.kind === 'dsh'
  const hideBotUnusedTools = (agent) => {
    shareBotTools(agent)
    const id = agent?.session?.id
    // The shell shadows go with the scope, so a reload or a Session that leaves
    // the team lifts them like the rest, and the Agent can be scoped again.
    const shadows = rt.shadowShells?.(agent) ?? []
    if (shadows.length > 0) {
      const held = scoped.get(id) ?? { relay: false, tools: false, restricted: false, filtered: false, disposers: [], unlisted: new Set() }
      held.agent = agent
      held.disposers.push(...shadows)
      scoped.set(id, held)
    }
    if (agent === undefined || !rt.isBotSession(id)) return
    const held = scoped.get(id) ?? { relay: false, tools: false, restricted: false, filtered: false, disposers: [], unlisted: new Set() }
    held.agent = agent
    scoped.set(id, held)
    syncPackageTools(agent, held)
    if (!nativeDshSession(id)) filterBotAssembly(agent, held)
    if (!nativeDshSession(id) && held.restricted !== true && typeof agent.ctx?.tools?.restrict === 'function') {
      maskHiddenTools(agent, held, new Set(ctx.tools.schemas(agent).map(schema => schema.name)))
    }
    maskConnectorTools(agent, held)
    maskRoleTools(agent, held)
  }
  rt.syncWorkerSkillTool = shareBotTools
  rt.dropUnavailableWorkerTools = dropUnavailableWorkerTools
  rt.workerSkillInStep = id => {
    const held = scoped.get(id)
    return held?.stepTools?.view(held.agent).has(SKILL_TOOL) === true
  }
  rt.canUseWorkerSkillTool = id => {
    const held = scoped.get(id)
    const agent = held?.agent
    if (!held?.skill || !held.added?.has(SKILL_TOOL) || rt.skillCalls?.workerAvailable(id, agent) !== true) return false
    const agents = ctx.get?.('agents')
    if (typeof agents?.get === 'function' && agents.get(id) !== agent) return false
    const tools = ctx.get?.('tools') ?? ctx.tools
    return typeof tools?.executable !== 'function' ||
      tools.executable(SKILL_TOOL, agent) === rt.teamTools.find(def => def.name === SKILL_TOOL)
  }
  ctx.on('tools/change', () => reapplyToolMasks())
  // A new Bot, part, or group Session gets its Agent before ds-bot records it, so the
  // recording path resolves it again once the session is known as a Bot's; meanwhile
  // the guard refuses the question tool in any Bot Session, and a goal made there is
  // blocked. A native DSH Bot's Session keeps DSH's own tools as they are.
  ctx.tools.guard((exec) => {
    if (!rt.isBotSession(exec.agent?.id) || nativeDshSession(exec.agent?.id)) return undefined
    if (exec.name === BLOCKING_QUESTION_TOOL) return `Bots cannot use ${BLOCKING_QUESTION_TOOL}. Ask with ask_user in your own chat, or ask in your reply.`
    const bot = roleBotOf(exec.agent?.id)
    if (withheldRoleTools(bot).includes(exec.name)) return `${bot.name} does not have the ${exec.name} tool: its Genie role is off.`
    const target = exec.arguments?.target
    return SCHEDULE_TARGET_TOOLS.includes(exec.name) && target !== undefined && target !== 'this_session' ? SCHEDULE_TARGET_REFUSAL : undefined
  })
  const pendingRole = agent => {
    const owner = rt.selfOf?.(agent?.session?.id)
    return owner === undefined ? undefined : rt.roleRuntime?.ready?.(owner)
  }
  // Creation waits for this listener, so the Agent's first step already lacks the tool.
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await rt.load()
      // Keep the hidden-tools filter in registration order when no role is loading.
      const ready = pendingRole(agent)
      if (ready) await ready
      hideBotUnusedTools(agent)
      // Creation runs before the first step collects the tool list, so the
      // names just registered will already be in it; nothing stays pending.
      scoped.get(agent?.session?.id)?.unlisted?.clear()
    } catch (error) {
      rt.warn('omni-ui: hiding %s on agent/created failed: %s', hiddenToolsOf(agent?.session?.id ?? agent?.id).join(', '), error)
    }
  })

  // A live Agent the creation path missed — after a restart, agent/created may
  // run before this plugin's listeners are back — is scoped by the load or
  // here, before the step's request. The request's tool list was collected
  // before this waterfall, so names scoped since are added now: a same-named
  // global entry is replaced by the scoped schema, and a PTC list that reaches
  // team tools through run_code is left alone.
  ctx.on('system-prompt/assemble', async function scopeTeamTools(_assembly, context, next) {
    const agent = context.agent
    if (agent === undefined) return next()
    try {
      await rt.load()
      const ready = pendingRole(agent)
      if (ready) await ready
      hideBotUnusedTools(agent)
    } catch (error) {
      rt.warn('omni-ui: scoping the tools of %s failed: %s', agent.session?.id ?? agent.id, error)
    }
    let assembled = await next()
    const held = scoped.get(agent.session?.id)
    if (held?.skill) held.stepTools = context.toolSet
    if (held?.removedPackages?.size && Array.isArray(assembled.tools)) {
      assembled = { ...assembled, tools: assembled.tools.filter(tool => !held.removedPackages.has(tool.name)) }
      held.removedPackages.clear()
    }
    if (held?.unlisted === undefined || held.unlisted.size === 0) return assembled
    // DSH 0.2.2 collects the scoped tools itself after this waterfall (#814).
    if (!Array.isArray(assembled.tools)) {
      held.unlisted.clear()
      return assembled
    }
    const pending = [...held.unlisted]
    // Cleared whatever happens below: the names are offered once, not on
    // every step.
    held.unlisted.clear()
    if ((assembled.tools ?? []).some(tool => tool.name === 'run_code')) return assembled
    if (typeof ctx.tools?.schemas !== 'function') return assembled
    try {
      const wanted = new Set(pending)
      const current = new Map(ctx.tools.schemas(agent).filter(schema => wanted.has(schema.name)).map(schema => [schema.name, schema]))
      let changed = false
      const tools = (assembled.tools ?? []).map((tool) => {
        const schema = current.get(tool.name)
        if (schema === undefined) return tool
        changed = true
        return schema
      })
      const present = new Set((assembled.tools ?? []).map(tool => tool.name))
      for (const name of pending) {
        if (present.has(name) || !current.has(name)) continue
        changed = true
        tools.push(current.get(name))
      }
      return changed ? { ...assembled, tools } : assembled
    } catch (error) {
      rt.warn('omni-ui: listing the scoped tools of %s failed: %s', agent.session?.id ?? agent.id, error)
      return assembled
    }
  })

  // A Bot's own chat runs the goal: DSH's round driver continues its rounds, and
  // create_goal/update_goal are in its tool list. A group Session is the one place a
  // DSH goal would run rounds nobody answers, so a goal made there is blocked at once;
  // the group's own goal is Omni's (group_goal).
  let goals = null
  const attachGoals = (sub) => {
    const own = sub.goals
    goals = own
    sub.effect(() => () => { if (goals === own) goals = null }, 'omni-ui: goal service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['goals'], attachGoals)
  else if (ctx.get?.('goals') !== undefined) attachGoals({ goals: ctx.get('goals'), effect: (execute, label) => ctx.effect(execute, label) })
  const blockGoal = async (sessionId) => {
    const service = goals
    if (service === null) return
    try {
      const agent = await rt.resolveAgent(sessionId)
      const goal = service.get(agent)
      if (goal?.phase !== 'active') return
      service.block(agent, { id: goal.id, revision: goal.revision }, { code: 'not-supported', message: GOAL_REFUSAL })
    } catch (error) {
      rt.warn('omni-ui: blocking the goal in %s failed: %s', sessionId, error)
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'goal/change' || event.data?.goal?.phase !== 'active') return
    const id = session?.id
    if (nativeDshSession(id) || !groupSessionOf(id)) return
    // block() appends to the same log, so it waits until every listener has seen this change.
    setTimeout(() => void blockGoal(id), 0)
  })

  rt.teamTools.push(defineTool({
    name: 'list_capabilities',
    description: 'List shared MCP servers and packs, plus the capabilities attached to you.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const bot = rt.botOf(self)
      if (!bot) return 'Only Bots on the team can use list_capabilities.'
      const items = Object.values(state.capabilities?.items ?? {})
      if (items.length === 0) return 'No shared capabilities are saved yet.'
      const statuses = rt.capabilityStatusesView()[bot.id] ?? {}
      const lines = items.map(item => {
        const extra = item.kind === 'pack' ? `; includes ${(item.items ?? []).join(', ') || 'nothing'}`
          : item.kind === 'mcp' && item.transport === 'stdio' ? `; ${item.approved ? 'allowed' : 'needs user approval'}` : ''
        const itemStatus = statuses[item.name]
        const state = itemStatus ? ` (${itemStatus.state}${itemStatus.error ? `: ${itemStatus.error}` : ''})` : ''
        const status = bot.capabilities?.includes(item.name) ? `; attached to you${state}` : ''
        return `- ${item.name} (${item.kind})${item.description ? ` — ${item.description}` : ''}${extra}${status}`
      })
      return ['Shared capabilities:', ...lines].join('\n')
    },
  }))
  rt.teamTools.push(skillTool(rt))
  rt.teamTools.push(defineTool({
    name: 'save_capability',
    description: 'Create or update a shared MCP server, skill, or pack. Changes apply from your next message.',
    parameters: {
      name: { type: 'string', required: true, description: 'Lowercase letters, digits, and single hyphens, up to 32 characters; "github" is reserved' },
      kind: { type: 'string', required: true, enum: ['mcp', 'skill', 'pack'] },
      description: { type: 'string', description: 'What this capability provides' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'How to reach an MCP server: a local command or an HTTP URL' },
      command: { type: 'string', description: 'Program that starts a local MCP server' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments for command' },
      env: { type: 'object', additionalProperties: true, description: 'Environment variables for command; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value' },
      url: { type: 'string', description: 'MCP server URL; write $DSH_SECRET_<NAME> in the path or query to insert a saved secret, URL-encoded. Prefer headers for keys' },
      headers: { type: 'object', additionalProperties: true, description: 'HTTP headers; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value' },
      content: { type: 'string', description: 'Skill instructions' },
      items: { type: 'array', items: { type: 'string' }, description: 'MCP server and skill names in the pack' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only Bots on the team can use save_capability.'
      try {
        const item = await rt.capabilitySave(args, { botId: self })
        const verdict = item.verification?.status === 'verified' ? ' (verified)'
          : item.verification?.status === 'unverified' ? ` (unverified${item.verification.reason ? `: ${item.verification.reason}` : ''})`
            : ''
        const approval = item.kind === 'mcp' && item.transport === 'stdio' && !item.approved
          ? ` The user must allow this MCP server before it can work: in ${rt.allowPlace()} (name it in exactly these words).`
          : ''
        return `Saved ${item.name}${verdict}. Bots with it attached use the change from their next message.${approval}`
      } catch (error) { return error.message }
    },
  }))
  rt.teamTools.push(defineTool({
    name: 'delete_capability',
    description: 'Remove a shared capability and detach it from every Bot and pack.',
    parameters: { name: { type: 'string', required: true } },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only Bots on the team can use delete_capability.'
      try {
        await rt.capabilityDelete(args.name, { botId: self })
        return `Deleted ${args.name}; it was removed from every Bot and pack. The change applies from their next message.`
      } catch (error) { return error.message }
    },
  }))
  for (const [name, endpoint, verb] of [['attach_capability', 'attach', 'Attached'], ['detach_capability', 'detach', 'Detached']]) {
    rt.teamTools.push(defineTool({
      name,
      description: `${verb} a shared capability to yourself, or to another Bot if you are a Main Bot.`,
      parameters: {
        name: { type: 'string', required: true, description: 'Capability name from list_capabilities' },
        bot: { type: 'string', description: 'Optional Bot name; only a Main Bot may change another Bot' },
      },
      output,
      async execute(args, exec) {
        await rt.load()
        const self = rt.selfOf(exec.agent?.id)
        if (!rt.botOf(self)) return `Only Bots on the team can use ${name}.`
        try {
          const result = await rt.changeCapabilityAttachment(endpoint, args, self)
          const attached = rt.own(state.capabilities.items, args.name)
          const members = attached?.kind === 'pack'
            ? (attached.items ?? []).map(child => rt.own(state.capabilities.items, child)).filter(Boolean)
            : attached ? [attached] : []
          const approvals = members
            .filter(item => item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true)
            .map(item => ` The user must allow ${item.name} before it can work: in ${rt.allowPlace()} (name it in exactly these words).`)
            .join('')
          return `${verb} ${args.name} ${args.bot ? `to ${result.bot}` : 'to yourself'}. Changes apply from ${result.bot}'s next message.${endpoint === 'attach' ? approvals : ''}`
        } catch (error) { return error.message }
      },
    }))
  }

  Object.assign(rt, { pickRoom, hideBotUnusedTools, syncScopedTools, addTeamTool, removeTeamTool, reapplyToolMasks, packageToolCollision })
}
