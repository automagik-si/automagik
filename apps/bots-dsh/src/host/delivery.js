// Delivery: how one Bot, the user, or Omni itself puts a message into a Bot Session.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HISTORY_TIMEOUT_MS, LONG_HEAD, MESSAGE_INLINE_MAX, READ_LINE_MAX, SOURCE_KIND, TEXT_KEPT, TEXT_SHOW_MAX } from './constants.js'
import { headOf, textOf } from './text.js'

export function install(rt) {
  const { ctx, state } = rt

  const resolveAgent = async (sessionId, botId) => {
    rt.assertShellChoice?.(sessionId, botId)
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    rt.assertShellChoice?.(sessionId, botId)
    if ('error' in resolved) {
      const error = Object.assign(new Error(resolved.error?.message ?? 'Session unavailable'), { code: resolved.error?.code })
      throw rt.autoClosed?.(sessionId, error) ?? error
    }
    rt.hideBotUnusedTools(resolved.agent)
    return resolved.agent
  }

  const headerFor = (role, fromName, roomName, audience, note = 'new message', deferred = false, { resumed = false, retried = false, resent = false, abandoned = false, asker, noReply = false, plural = false, hasSender = false } = {}) => {
    // What came back for work another Bot gave this one says where its answer goes.
    const goesOn = asker === undefined ? '' : ` · for the work ${asker} asked you for; your answer goes to ${asker} once everything you handed on is back`
    // A wait the user gave up reads as its own thing: the other Bot never answered.
    if (abandoned) return `[Waiting given up · ${fromName} did not hand back this work; go on with the work it was for${goesOn}]`
    if (deferred && role === 'reply') return `[Reply from ${fromName} · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role === 'report') return `[Group chat "${roomName}" · replies to your post · you read them during your last task; go on with the work they are for now${goesOn}]`
    if (deferred && role !== 'room') return plural
      ? `[Messages from ${fromName} · you read them during your last task; answer them now]`
      : `[Message from ${fromName} · you read it during your last task; answer it now]`
    // A message that owes nothing says so, so the Bot reads it without answering it.
    if (noReply && role === 'request' && audience !== 'user') return resumed
      ? `[Message from ${fromName} · no reply needed · DeepSeek Harness restarted while you were working on it]`
      : `[Message from ${fromName} · no reply needed]`
    if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
    if (resumed && role === 'resume') return '[DeepSeek Harness restarted while you were working]'
    if (resumed && role !== 'room') return plural
      ? `[Messages from ${fromName} · DeepSeek Harness restarted while you were working on them]`
      : `[Message from ${fromName} · DeepSeek Harness restarted while you were working on it]`
    if (resent && role === 'reply' && hasSender) return `[Reply from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (resent && role === 'task-done') return `[Task "${note}" finished · DeepSeek Harness restarted before this report could reach you · its last words follow; tell the user what matters in a line or two]`
    if (resent && hasSender && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (role === 'reply') return `[Reply from ${fromName}${goesOn}]`
    if (role === 'stopped') return `[Stopped by ${fromName}]`
    if (role === 'room') return `[Group chat "${roomName}" · ${note}]`
    if (role === 'report') return `[Group chat "${roomName}" · replies to your post${goesOn}]`
    if (role === 'task') return `[Task · subscription "${note}" · one run: do it, then end with one or two lines on what you did]`
    if (role === 'task-done') return `[Task "${note}" finished · its last words follow; tell the user what matters in a line or two]`
    if (role === 'kickoff') return '[Bot team setup]'
    if (role === 'continue') return '[Retry after a failed turn]'
    // The editor can be the user or a Bot (its own tool call, or a Main Bot's):
    // the header stays neutral about who changed the profile.
    if (role === 'update') return '[Your profile was updated — follow the latest version]'
    if (role === 'secret') return '[Secret card]'
    if (role === 'permission') return '[Omni permission card]'
    if (audience === 'user') return `[Message from ${fromName} · the user sees your reply here]`
    return `[Message from ${fromName}]`
  }

  // Roles recorded as team exchanges.
  const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped'])

  // What two Bots say to each other is in the book of the pair (books.js), whole, written
  // before the message goes out. A message is shown once a record says it was delivered.
  const pairBook = (a, b) => `pair-${[String(a), String(b)].sort().join('-')}`
  // A pair's book starts from the exchanges a team kept in state.json before the ledger.
  rt.ledger.importer('pair-', book => state.exchanges
    .filter(entry => entry.from !== undefined && entry.to !== undefined && pairBook(entry.from, entry.to) === book)
    .map(entry => ({ ...entry, delivered: true })))
  // A message shows the text its delivery carried: the last record of its id written before
  // a delivery mark. A merged request whose replacement never went out keeps the text that did.
  function pairMessages(a, b) {
    const written = new Map()
    const shown = new Map()
    for (const record of rt.ledger.records(pairBook(a, b))) {
      if (record.event === 'delivered') {
        if (written.has(record.id)) shown.set(record.id, written.get(record.id))
      } else if (record.event === undefined) {
        written.set(record.id, record)
        if (record.delivered === true) shown.set(record.id, record)
      }
    }
    return [...shown.values()]
  }

  // Where a message for a Session goes now: that Session while it is still one of a
  // Bot's, else the current Session of its Bot, or of its group when it went to one.
  // One no Bot owns any more (a run whose record is gone) has nowhere to go: undefined.
  rt.sessionNow = (sessionId, toId, roomId) => (rt.isBotSession(sessionId) ? sessionId
    : !rt.pastOwners.has(sessionId) ? undefined
      : roomId === undefined ? rt.chatOf(toId) : rt.roomOf(roomId)?.sessions?.[toId])

  // Replies waiting for one Bot go in together: the turn it opens reads them all.
  // A finished turn appends its replies here before any await, so one event-loop turn
  // collects them; `inject` queues for the next step without waking, and the last one
  // wakes the driver, so one turn claims the batch. A batch never mixes two works:
  // one turn answers one work, and replies for different works keep their own turns
  // (the merge covers what one answer can carry). A queue is the Bot's, not one
  // Session's: a part switch while replies wait gives the Bot a new chat, and the
  // flush sends them to the Session the Bot has then.
  const replyQueues = new Map()
  const replyKey = (toId, roomId, work) => `${toId}\u0000${roomId ?? ''}\u0000${work ?? ''}`
  const targetOf = queue => rt.sessionNow(queue.sessionId, queue.toId, rt.pastOwners.get(queue.sessionId)?.roomId) ?? queue.sessionId
  const scheduleReplies = (key) => {
    const queue = replyQueues.get(key)
    if (queue === undefined || queue.timer !== undefined || queue.running) return
    // Deliveries made by one turn append before any await, so one event-loop turn is
    // enough to collect them; what is waiting when the flush runs goes in together.
    queue.timer = setImmediate(() => {
      queue.timer = undefined
      void flushReplies(key)
    })
  }
  const flushReplies = async (key) => {
    const queue = replyQueues.get(key)
    if (queue === undefined || queue.running || queue.items.length === 0) return
    queue.sessionId = targetOf(queue)
    // A turn is already reading its inbox: what waits for it goes in when it ends.
    if (rt.live?.get?.(queue.sessionId)?.turn !== undefined) return
    queue.running = true
    queue.waiting = false
    const batch = queue.items.splice(0)
    try {
      // The exchange is recorded before its message goes out; wait for each.
      const outcomes = await Promise.allSettled(batch.map(item => item.ready))
      const sendable = []
      for (const [index, item] of batch.entries()) {
        if (outcomes[index].status === 'fulfilled') sendable.push(item)
        else item.fail(outcomes[index].reason)
      }
      if (sendable.length === 0) return
      // The Bot may have switched part while the replies waited: they go to its part now.
      const target = targetOf(queue)
      queue.sessionId = target
      rt.assertShellChoice?.(target, queue.toId)
      let agent = sendable.find(item => item.sessionId === target)?.agent
      if (agent === undefined) {
        await rt.ensureCapabilities(target)
        agent = await resolveAgent(target, queue.toId)
        rt.assertShellChoice?.(target, queue.toId)
      }
      if (rt.live?.get?.(target)?.turn !== undefined || agent.status === 'running') {
        // A turn opened while the exchanges were written, or the agent has not settled
        // yet: the turn's end or the agent going idle wakes the queue again.
        queue.items = [...sendable, ...queue.items]
        queue.waiting = true
        return
      }
      // A recovery reply can have been consumed while this queue waited for idle.
      rt.assertShellChoice?.(target, queue.toId)
      const remaining = sendable.filter(item => {
        if (item.shouldSend === undefined || item.shouldSend(agent, target)) return true
        item.delivered(false)
        return false
      })
      if (remaining.length === 0) return
      if (typeof agent.inject === 'function') {
        for (const item of remaining.slice(0, -1)) agent.inject(item.message)
        agent.followup(remaining.at(-1).message)
      } else {
        // An older host without inject still gets the replies, one turn each.
        for (const item of remaining) agent.followup(item.message)
      }
      await ctx.sessions.flush(agent.session)
      for (const item of remaining) item.delivered(target)
    } catch (error) {
      for (const item of batch) item.fail(error)
    } finally {
      queue.running = false
      if (queue.items.length === 0) replyQueues.delete(key)
      else if (!queue.waiting) scheduleReplies(key)
    }
  }
  const queueReply = (sessionId, toId, work, message, shouldSend) => {
    const key = replyKey(toId, rt.groupOwners?.get?.(sessionId)?.roomId, work)
    let queue = replyQueues.get(key)
    if (queue === undefined) replyQueues.set(key, queue = { sessionId, toId, work, items: [], timer: undefined, running: false, waiting: false })
    let markReady
    let markUnready
    let markDelivered
    let markFailed
    const item = {
      message,
      shouldSend,
      sessionId,
      agent: undefined,
      ready: new Promise((resolve, reject) => { markReady = resolve; markUnready = reject }),
      sent: new Promise((resolve, reject) => { markDelivered = resolve; markFailed = reject }),
      made: () => markReady(),
      delivered: target => markDelivered(target),
      fail: (error) => { markUnready(error); markFailed(error) },
    }
    // A setup failure is reported through `sent`; these keep neither promise unhandled
    // while the reply waits for a busy Bot or the delivery that failed is still unwinding.
    item.ready.catch(() => {})
    item.sent.catch(() => {})
    queue.items.push(item)
    if (!queue.running) scheduleReplies(key)
    return item
  }
  // What waits for a Session goes in once it can take it: after every listener has
  // cleared its turn, or once its agent settles idle.
  const wake = (id) => {
    for (const [key, queue] of replyQueues) if (queue.sessionId === id || targetOf(queue) === id) setImmediate(() => void flushReplies(key))
  }
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end') wake(session?.id)
  })
  ctx.on('agent/status', ({ agent, status } = {}) => {
    if (status !== 'idle') return
    const id = agent?.session?.id ?? agent?.id
    if (id !== undefined && [...replyQueues.values()].some(queue => queue.waiting)) wake(id)
  })

  // `sessionId` defaults to the recipient's own chat; group turns name its group Session.
  // `deferred`: a request the Bot already read mid-turn, handed back to answer in a
  // turn of its own; its exchange was recorded when it first arrived. `resumed` and
  // `retried` carry on a turn that a restart cut off or that wrote its tool call as
  // text (resume.js, turns.js); their exchange is recorded already too. `resent` is
  // a message a shutdown cancelled; its first send may not have been recorded.
  // `askedBy` is the member whose @mention called a group turn (groups.js).
  // `fromRoomId`: the group whose Session the sender wrote from; the reply goes back
  // to that Session (turns.js). `images` and `files` go along as image and file blocks,
  // which DSH projects for the recipient's model and tools. `length`: the whole message's
  // length when it went as a file (attachLong). `work`: the work (handoffs.js) a
  // result that came back goes on with. `merged`: a request that takes in an earlier
  // one its recipient had not read, under that one's exchange. `uploads`: the person's
  // uploads of a group turn, for a member over ACP.
  async function deliver({ fromId, fromName: senderName, toId, sessionId, text, role, replyTo, roomId, audience, note, exchangeId = randomUUID(), steer = false, deferred = false, resumed = false, retried = false, resent = false, merged = false, noReply = false, joined, abandoned = false, recordExchange = true, askedBy, fromRoomId, images = [], forwarded = false, files = [], uploads = [], length, work, taskSessionId }, { enqueue, shouldSend } = {}) {
    const from = rt.botOf(fromId)
    const to = rt.botOf(toId)
    if (to === undefined) throw new Error(`Unknown Bot ${toId}`)
    const fromName = senderName ?? from?.name ?? 'You'
    const room = rt.roomOf(roomId)
    const asker = work === undefined ? undefined : rt.botOf(state.works?.[work]?.from)?.name
    // Session events reject `undefined` members, so optional fields are omitted instead.
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      ...(role !== 'task-done' || fromId !== undefined || senderName !== undefined ? { senderName: fromName } : {}),
      ...(work ? { work } : {}),
      ...(fromId ? { senderSessionId: fromId } : {}),
      ...(forwarded && images.length > 0 ? { forwarded: { v: 1 } } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(roomId ? { roomId } : {}),
      ...(roomId && uploads.length > 0 ? { uploads: { v: 1, roomId, items: uploads } } : {}),
      ...(audience === 'user' ? { audience } : {}),
      ...(deferred ? { deferred: true } : {}),
      ...(noReply ? { noReply: true } : {}),
      ...(joined && joined.length > 0 ? { joined } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(retried ? { retried: true } : {}),
      ...(askedBy ? { askedBy } : {}),
      ...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
      ...(taskSessionId ? { taskSessionId } : {}),
      ...(abandoned ? { abandoned: true } : {}),
    }
    const targetSessionId = sessionId ?? rt.chatOf(toId)
    rt.assertShellChoice?.(targetSessionId, toId)
    // Where the message went: a reply that waited for a busy Bot may reach a later part.
    let deliveredTo = targetSessionId
    // On disk before it goes out: a message the book could not keep is not sent, so none is
    // delivered with no record of it. A resend keeps the record it has; only a merged request
    // replaces it with its added text.
    const book = fromId !== undefined && from !== undefined && recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried ? pairBook(fromId, toId) : undefined
    // A steered message cuts into a running turn at its next step; a follow-up
    // queues for the next turn (see turns.js for how each is routed).
    const message = createUserMessage({
      content: [
        { type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried, resent, abandoned, asker, hasSender: fromId !== undefined || senderName !== undefined, noReply, plural: (joined?.length ?? 0) > 0 })}\n${text}` },
        ...images.map(attachment => ({ type: 'image', attachment })),
        ...files.map(attachment => ({ type: 'file', attachment })),
      ],
      source,
    })
    // A reply joins its recipient's batch before anything is awaited, so every reply one
    // finished turn produces lands in the same batch and one turn reads them all.
    const queued = role === 'reply' && !steer && enqueue === undefined
      ? queueReply(targetSessionId, toId, work, message, shouldSend) : undefined
    try {
      if (book !== undefined && (merged || !rt.ledger.records(book).some(record => record.event === undefined && record.id === exchangeId))) {
        rt.ledger.append(book, { id: exchangeId, from: fromId, to: toId, role, text, time: Date.now(), ...(length !== undefined ? { length, files } : {}), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}), ...(roomId ? { roomId } : {}) })
        await rt.ledger.written(book)
      }
      rt.assertShellChoice?.(targetSessionId, toId)
      await rt.ensureCapabilities(targetSessionId)
      const agent = await resolveAgent(targetSessionId, toId)
      rt.assertShellChoice?.(targetSessionId, toId)
      if (queued !== undefined) {
        queued.agent = agent
        queued.made()
        const destination = await queued.sent
        if (destination === false) return undefined
        deliveredTo = destination ?? targetSessionId
      } else if (shouldSend !== undefined && !shouldSend(agent, targetSessionId)) {
        return undefined
      } else if (enqueue !== undefined) {
        if (!await enqueue(agent, message)) return undefined
      } else {
        if (steer) agent.steer(message)
        else agent.followup(message)
        await ctx.sessions.flush(agent.session)
      }
    } catch (error) {
      queued?.fail(error)
      throw error
    }
    if (book !== undefined) {
      rt.ledger.append(book, { event: 'delivered', id: exchangeId, sessionId: deliveredTo, time: Date.now() })
      // The message went out either way; a mark that is lost only hides it from the dialog.
      await rt.ledger.written(book).catch(() => {})
    } else if (recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried) {
      // A message no Bot of the team sent keeps the record it had before the ledger.
      // Recorded once the message is in the Session: an earlier record would show
      // a failed delivery as delivered. The whole text is in its file, or in the
      // Session it goes to; exchangeText reads it back there. Resends keep any
      // existing record; only a merged request replaces it with its added text.
      const kept = headOf(text, TEXT_KEPT)
      const whole = length !== undefined ? { length, files } : kept.length < text.length ? { length: text.length, sessionId: deliveredTo } : {}
      const entry = { id: exchangeId, from: fromId, to: toId, text: kept, ...whole, role, time: Date.now(), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}) }
      const earlier = state.exchanges.findIndex(other => other.id === exchangeId)
      if (earlier === -1) state.exchanges.push(entry)
      else if (merged) state.exchanges[earlier] = entry
      void rt.save().catch(() => {})
    }
    return exchangeId
  }

  // A message between Bots, whole, from the Session it was delivered to: the message
  // there is its header line, then the text. `whole` is false when only the start could
  // be read (the Session is gone, or the message is past what the dialog shows).
  async function exchangeText(entry) {
    // A message of the ledger is whole there, or in its file when it went as one.
    if (entry.ledger === true && entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: headOf(entry.text, TEXT_SHOW_MAX), whole: false }
    if (entry.ledger === true) return { text: headOf(entry.text, TEXT_SHOW_MAX), whole: entry.text.length <= TEXT_SHOW_MAX }
    if (entry.length === undefined) return { text: entry.text, whole: true }
    if (entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: entry.text, whole: false }
    try {
      for await (const event of rt.eventsBackwards(entry.sessionId ?? rt.chatOf(entry.to), AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        if (event.type !== 'user/message' || event.data?.source?.exchangeId !== entry.id) continue
        const delivered = textOf(event.data.content)
        const text = delivered.slice(delivered.indexOf('\n') + 1)
        return { text: headOf(text, TEXT_SHOW_MAX), whole: text.length <= TEXT_SHOW_MAX }
      }
    } catch (error) {
      rt.warn('omni-ui: message %s not read back: %s', entry.id, error)
    }
    return { text: entry.text, whole: false }
  }

  // A message a Bot sends past MESSAGE_INLINE_MAX goes as a DSH file: it is stored once,
  // not in every Session it reaches, and the model reads it with its file tools when it
  // needs it. Undefined when this DSH cannot store files.
  async function attachLong(text, name) {
    if (text.length <= MESSAGE_INLINE_MAX) return { text, files: [] }
    try {
      const file = await ctx.get?.('attachments')?.saveFile({ data: new TextEncoder().encode(text), name })
      if (file === undefined) return undefined
      // The file stays verbatim, so a line past what the read tool shows needs another way.
      const wide = text.split('\n').some(line => line.length > READ_LINE_MAX)
      const note = `[A long message: ${text.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.${wide ? ` Some lines are longer than the ${READ_LINE_MAX} characters the read tool shows of a line; read those with a shell command.` : ''}]`
      return { text: `${note}\n${headOf(text, LONG_HEAD)}…`, files: [file], length: text.length }
    } catch (error) {
      rt.warn('omni-ui: long message not stored as a file: %s', error)
      return undefined
    }
  }

  // The text of a stored file, up to what the dialogs show.
  async function fileText(file) {
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined) return undefined
    const decoder = new TextDecoder()
    let text = ''
    try {
      for await (const chunk of attachments.readFileStream(file, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        text += decoder.decode(chunk, { stream: true })
        if (text.length > TEXT_SHOW_MAX) return { text: headOf(text, TEXT_SHOW_MAX), whole: false }
      }
    } catch (error) {
      rt.warn('omni-ui: file %s not read: %s', file?.name, error)
      return undefined
    }
    text += decoder.decode()
    return { text, whole: true }
  }

  const exchangesOf = (a, b) => pairMessages(a, b).map((record) => {
    const kept = headOf(record.text ?? '', TEXT_KEPT)
    const { delivered: _delivered, ...rest } = record
    return { ...rest, text: kept, ...(record.length === undefined && kept.length < (record.text ?? '').length ? { length: record.text.length } : {}) }
  })
  const exchangeOf = (id, a, b) => {
    const record = pairMessages(a, b).find(item => item.id === id)
    if (record === undefined) return undefined
    // Imported from before the ledger: as whole as it was kept then.
    if (record.sessionId !== undefined || (record.length !== undefined && !(record.files?.length > 0))) return record
    return { ...record, ledger: true }
  }

  Object.assign(rt, { resolveAgent, deliver, exchangeText, attachLong, fileText, exchangesOf, exchangeOf })
}
