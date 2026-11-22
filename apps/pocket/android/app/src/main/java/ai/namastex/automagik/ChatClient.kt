package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap

/** The desktop's Pocket Link has no chat route yet (an older bridge): the terminal view is all there is. */
class ChatUnsupported : IllegalStateException(Chat.UPDATE_LINK)

/** This connection was not granted group chats. */
class GroupsUnsupported : IllegalStateException(Chat.GROUPS_UNAVAILABLE)

/**
 * The chat connection the view model drives. [ChatClient] is the production one, over Pocket Link's chat route; this
 * interface is the internal seam that lets the JVM unit tests put a fake bridge behind the same code path (#754).
 */
internal interface ChatLink : Closeable {
    val dshWrite: Boolean
    val groups: Boolean get() = false
    val isClosed: Boolean get() = false
    val manage: Set<String> get() = emptySet()
    suspend fun list(): List<Chat.Terminal>
    suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit): Int
    suspend fun backfill(terminal: String, before: String, limit: Int = 50): JSONArray
    suspend fun send(terminal: String, text: String, id: String): JSONObject
    suspend fun send(terminal: String, text: String, id: String, retry: Boolean): JSONObject =
        if (retry) ChatClient.refusedRetry(id) else send(terminal, text, id)
    suspend fun sendHeld(terminal: String, id: String): JSONObject
    suspend fun cancelHeld(terminal: String, id: String): JSONObject
    suspend fun answer(terminal: String, row: String, choice: String, text: String? = null): JSONObject
    suspend fun interrupt(terminal: String): JSONObject
    suspend fun memoryRead(terminal: String) = ChatClient.refusedMemory()
    suspend fun memoryEdit(terminal: String, id: String, rev: String, text: String) = ChatClient.refusedMemory()
    suspend fun memoryAdd(terminal: String, text: String) = ChatClient.refusedMemory()
    suspend fun scheduleList(terminal: String, id: String? = null) = ChatClient.refusedSchedules()
    suspend fun schedulePause(terminal: String, id: String, rev: String) = ChatClient.refusedSchedules()
    suspend fun scheduleResume(terminal: String, id: String, rev: String) = ChatClient.refusedSchedules()
    suspend fun scheduleRename(terminal: String, id: String, rev: String, title: String) = ChatClient.refusedSchedules()
    suspend fun settingsRead(terminal: String) = ChatClient.refusedSettings()
    suspend fun settingsName(terminal: String, rev: String, name: String) = ChatClient.refusedSettings()
    suspend fun settingsModel(terminal: String, rev: String, model: String) = ChatClient.refusedSettings()
    val attach: Attach.Peer get() = Attach.Peer.NotAsked
    suspend fun attachBegin(terminal: String, upload: String, mediaType: String, bytes: Int) = Attach.refusedLocal()
    suspend fun attachChunk(terminal: String, upload: String, offset: Int, data: ByteArray) = Attach.refusedLocal()
    suspend fun attachFinish(terminal: String, upload: String) = Attach.refusedLocal()
    suspend fun attachCancel(terminal: String, upload: String) = Attach.refusedLocal()
    suspend fun attachmentRead(terminal: String, row: String, block: Int) = Attach.refusedLocal()
    suspend fun sendUploads(terminal: String, id: String, text: String, uploads: List<String>) = Attach.refusedLocal()
}

/** The production [ChatLink]: [ChatClient] over Pocket Link's chat route, straight through. */
internal class PocketLinkChat(private val client: ChatClient) : ChatLink {
    override val dshWrite get() = client.dshWrite
    override val groups get() = client.groups
    override val isClosed get() = client.isClosed
    override val manage get() = client.manage
    override suspend fun list() = client.list()
    override suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit) =
        client.subscribe(terminal, after, event, closed)
    override suspend fun backfill(terminal: String, before: String, limit: Int) = client.backfill(terminal, before, limit)
    override suspend fun send(terminal: String, text: String, id: String) = client.send(terminal, text, id)
    override suspend fun send(terminal: String, text: String, id: String, retry: Boolean) = client.send(terminal, text, id, retry)
    override suspend fun sendHeld(terminal: String, id: String) = client.sendHeld(terminal, id)
    override suspend fun cancelHeld(terminal: String, id: String) = client.cancelHeld(terminal, id)
    override suspend fun answer(terminal: String, row: String, choice: String, text: String?) = client.answer(terminal, row, choice, text)
    override suspend fun interrupt(terminal: String) = client.interrupt(terminal)
    override suspend fun memoryRead(terminal: String) = client.memoryRead(terminal)
    override suspend fun memoryEdit(terminal: String, id: String, rev: String, text: String) = client.memoryEdit(terminal, id, rev, text)
    override suspend fun memoryAdd(terminal: String, text: String) = client.memoryAdd(terminal, text)
    override suspend fun scheduleList(terminal: String, id: String?) = client.scheduleList(terminal, id)
    override suspend fun schedulePause(terminal: String, id: String, rev: String) = client.schedulePause(terminal, id, rev)
    override suspend fun scheduleResume(terminal: String, id: String, rev: String) = client.scheduleResume(terminal, id, rev)
    override suspend fun scheduleRename(terminal: String, id: String, rev: String, title: String) =
        client.scheduleRename(terminal, id, rev, title)
    override suspend fun settingsRead(terminal: String) = client.settingsRead(terminal)
    override suspend fun settingsName(terminal: String, rev: String, name: String) = client.settingsName(terminal, rev, name)
    override suspend fun settingsModel(terminal: String, rev: String, model: String) = client.settingsModel(terminal, rev, model)
    override val attach get() = client.attach
    override suspend fun attachBegin(terminal: String, upload: String, mediaType: String, bytes: Int) =
        client.attachBegin(terminal, upload, mediaType, bytes)
    override suspend fun attachChunk(terminal: String, upload: String, offset: Int, data: ByteArray) =
        client.attachChunk(terminal, upload, offset, data)
    override suspend fun attachFinish(terminal: String, upload: String) = client.attachFinish(terminal, upload)
    override suspend fun attachCancel(terminal: String, upload: String) = client.attachCancel(terminal, upload)
    override suspend fun attachmentRead(terminal: String, row: String, block: Int) = client.attachmentRead(terminal, row, block)
    override suspend fun sendUploads(terminal: String, id: String, text: String, uploads: List<String>) =
        client.sendUploads(terminal, id, text, uploads)
    override fun close() = client.close()
}

/**
 * The `chat.*` methods of Pocket Link's `herdr-pocket/chat/1` route, over the same framing herdr-core speaks
 * ([CoreClient]). A write on a DSH chat is refused here, before anything is sent, unless the bridge's hello said
 * `dshWrite: true` ([dshWrite]); the bridge refuses it too without a socket that takes writes (dsh-source.mjs).
 * With it, send, answer and interrupt go to the bridge as on a terminal: the bridge adds the phone's name and key,
 * which the phone never sets. Held messages never exist on a DSH chat, so sendHeld and cancelHeld stay refused.
 */
class ChatClient(
    private val core: CoreClient, val dshWrite: Boolean = false, val manage: Set<String> = emptySet(),
    val attach: Attach.Peer = Attach.Peer.NotAsked, val groups: Boolean = false
) : Closeable {
    internal val isClosed get() = core.isClosed
    private val watched = ConcurrentHashMap<Int, String>()
    @Volatile internal var finishTimeoutMs: Long = Attach.FINISH_TIMEOUT_MS

    companion object {
        val MEMORY = listOf("memory.read", "memory.edit", "memory.add")
        val SCHEDULES = listOf("schedule.list", "schedule.pause", "schedule.resume", "schedule.rename")
        val SETTINGS = listOf("settings.read", "settings.name", "settings.model")

        /** The bridge's answer to a write the phone never sends: the same shape dsh-source.mjs `refusedDsh` gives. */
        fun refusedReadOnly(id: String? = null): JSONObject = JSONObject().put("state", "refused").put("ok", false)
            .put("reason", "read-only").put("message", Chat.ANSWER_ON_COMPUTER).apply { if (id != null) put("id", id) }

        internal fun refusedRetry(id: String) = JSONObject().put("ok", false).put("state", "refused")
            .put("reason", "unsupported").put("id", id)

        internal fun refusedMemory() = JSONObject().put("ok", false).put("state", "refused").put("reason", "read-only")
        internal fun refusedSchedules() = refusedMemory()
        internal fun refusedSettings() = refusedMemory()

        /** Pocket requires each opted-in family to grant its read method so it can check an unconfirmed write. */
        suspend fun start(core: CoreClient, manage: List<String> = emptyList(), attachments: Boolean = false, groups: Boolean = false): ChatClient {
            val requested = (MEMORY + SCHEDULES + SETTINGS).filter { it in manage }
            val hello = core.start(requested.takeIf { it.isNotEmpty() }?.let { JSONArray(it) }, attachments, groups)
            if (hello.optInt("chat") != 1) { core.close(); throw ChatUnsupported() }
            val answered = hello.optJSONArray("manage")?.let { a -> (0 until a.length()).map { a.opt(it) } }.orEmpty()
            val granted = if (answered.all { it is String }) requested.filter { it in answered }.toSet() else emptySet()
            val usable = granted.filter { method ->
                when (method) {
                    in MEMORY -> "memory.read" in granted
                    in SCHEDULES -> "schedule.list" in granted
                    else -> "settings.read" in granted
                }
            }.toSet()
            return ChatClient(core, dshWrite = hello.opt("dshWrite") == true, manage = usable,
                attach = if (attachments) Attach.peer(hello) else Attach.Peer.NotAsked, groups = groups && hello.opt("groups") == true)
        }

        /** A connect that failed because the bridge does not offer the chat route (an older Pocket Link). */
        fun refusedRoute(e: Throwable): Boolean {
            val m = generateSequence(e) { it.cause }.mapNotNull { it.message?.lowercase() }.joinToString(" ")
            return "alpn" in m || "application protocol" in m || "no_application_protocol" in m
        }
    }

    private fun params(terminal: String) = JSONObject().put("terminal", terminal)

    /** Whether this phone refuses a write on [terminal] itself: a DSH chat on a bridge without `dshWrite`. */
    fun readOnly(terminal: String) = Chat.readOnly(terminal, dshWrite, groups)

    suspend fun list(): List<Chat.Terminal> {
        val terminals = core.call("chat.list").optJSONArray("terminals") ?: JSONArray()
        return (0 until terminals.length()).mapNotNull { terminals.optJSONObject(it) }.map(Chat.Terminal::parse)
            .filter { it.terminal.isNotEmpty() && (!it.group || groups) }
    }

    /**
     * Watches [terminal]'s chat from [after] (a row id, or null for the latest page). Each event line goes to
     * [event]; [closed] gets the reason the bridge closed it ("slow": resubscribe with the cursor).
     */
    suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit): Int {
        if (Chat.isGroup(terminal) && !groups) throw GroupsUnsupported()
        val p = params(terminal).apply { if (after != null) put("after", after) }
        val channel = core.call("chat.subscribe", p).getInt("channel")
        watched[channel] = terminal
        val partial = StringBuilder()
        core.stream(channel, { bytes ->
            partial.append(String(bytes, Charsets.UTF_8))
            while (true) {
                val end = partial.indexOf("\n")
                if (end < 0) break
                val line = partial.substring(0, end)
                partial.delete(0, end + 1)
                if (line.isNotBlank()) runCatching { JSONObject(line) }.getOrNull()?.let(event)
            }
        }) { reason -> watched.remove(channel); closed(reason) }
        return channel
    }

    fun unsubscribe(channel: Int) = runCatching { watched.remove(channel); core.detach(channel) }

    suspend fun backfill(terminal: String, before: String, limit: Int = 50): JSONArray =
        core.call("chat.backfill", params(terminal).put("before", before).put("limit", limit)).optJSONArray("rows") ?: JSONArray()

    suspend fun send(terminal: String, text: String, id: String, retry: Boolean = false): JSONObject =
        if (readOnly(terminal)) refusedReadOnly(id)
        else core.call("chat.send", params(terminal).put("text", text).put("id", id).apply {
            if (retry) put("retry", true)
        })

    suspend fun sendHeld(terminal: String, id: String): JSONObject =
        if (Chat.isDsh(terminal)) refusedReadOnly(id) else core.call("chat.sendHeld", params(terminal).put("id", id))

    suspend fun cancelHeld(terminal: String, id: String): JSONObject =
        if (Chat.isDsh(terminal)) refusedReadOnly(id) else core.call("chat.cancelHeld", params(terminal).put("id", id))

    /** [text]: a question's typed answer, with choice [ChatActions.OTHER] only. */
    suspend fun answer(terminal: String, row: String, choice: String, text: String? = null): JSONObject =
        if (readOnly(terminal)) refusedReadOnly()
        else if (Chat.isGroup(terminal) && (choice !in setOf("allow", "deny") || text != null))
            JSONObject().put("ok", false).put("state", "refused").put("reason", "invalid")
        else core.call("chat.answer", params(terminal).put("row", row).put("choice", choice).apply { if (text != null) put("text", text) })

    suspend fun interrupt(terminal: String): JSONObject =
        if (readOnly(terminal)) refusedReadOnly() else core.call("chat.interrupt", params(terminal))

    private suspend fun memory(method: String, terminal: String, fields: JSONObject.() -> Unit): JSONObject =
        if (method !in manage || !Chat.isDsh(terminal) || Chat.isGroup(terminal)) refusedMemory() else core.call(method, params(terminal).apply(fields))

    suspend fun memoryRead(terminal: String) = memory("memory.read", terminal) { }
    suspend fun memoryEdit(terminal: String, id: String, rev: String, text: String) =
        memory("memory.edit", terminal) { put("id", id).put("rev", rev).put("text", text) }
    suspend fun memoryAdd(terminal: String, text: String) = memory("memory.add", terminal) { put("text", text) }

    private suspend fun schedule(method: String, terminal: String, fields: JSONObject.() -> Unit): JSONObject =
        if (method !in manage || !Chat.isDsh(terminal) || Chat.isGroup(terminal)) refusedSchedules() else core.call(method, params(terminal).apply(fields))

    suspend fun scheduleList(terminal: String, id: String? = null) =
        schedule("schedule.list", terminal) { if (id != null) put("id", id) }
    suspend fun schedulePause(terminal: String, id: String, rev: String) =
        schedule("schedule.pause", terminal) { put("id", id).put("rev", rev) }
    suspend fun scheduleResume(terminal: String, id: String, rev: String) =
        schedule("schedule.resume", terminal) { put("id", id).put("rev", rev) }
    suspend fun scheduleRename(terminal: String, id: String, rev: String, title: String) =
        schedule("schedule.rename", terminal) { put("id", id).put("rev", rev).put("title", title) }

    private suspend fun settings(method: String, terminal: String, fields: JSONObject.() -> Unit): JSONObject =
        if ("settings.read" !in manage || method !in manage || !ChatSettings.isBot(terminal)) refusedSettings()
        else core.call(method, params(terminal).apply(fields))

    suspend fun settingsRead(terminal: String) = settings("settings.read", terminal) { }
    suspend fun settingsName(terminal: String, rev: String, name: String) =
        settings("settings.name", terminal) { put("rev", rev).put("name", name) }
    suspend fun settingsModel(terminal: String, rev: String, model: String) =
        settings("settings.model", terminal) { put("rev", rev).put("model", model) }

    private suspend fun attachment(
        method: String, terminal: String, timeoutMs: Long = core.callTimeoutMs, params: () -> JSONObject
    ): JSONObject = if (Attach.usable(attach, dshWrite, terminal, terminal in watched.values))
        core.call(method, params(), timeoutMs) else Attach.refusedLocal()

    suspend fun attachBegin(terminal: String, upload: String, mediaType: String, bytes: Int) =
        attachment(Attach.METHOD_BEGIN, terminal) { Attach.beginParams(terminal, upload, mediaType, bytes) }
    suspend fun attachChunk(terminal: String, upload: String, offset: Int, data: ByteArray) =
        attachment(Attach.METHOD_CHUNK, terminal) { Attach.chunkParams(terminal, upload, offset, data) }
    suspend fun attachFinish(terminal: String, upload: String) =
        attachment(Attach.METHOD_FINISH, terminal, finishTimeoutMs) { Attach.uploadParams(terminal, upload) }
    suspend fun attachCancel(terminal: String, upload: String) =
        attachment(Attach.METHOD_CANCEL, terminal) { Attach.uploadParams(terminal, upload) }
    suspend fun attachmentRead(terminal: String, row: String, block: Int) =
        attachment(Attach.METHOD_READ, terminal) { Attach.readParams(terminal, row, block) }
    suspend fun sendUploads(terminal: String, id: String, text: String, uploads: List<String>) =
        attachment(Attach.METHOD_SEND, terminal) { Attach.sendParams(terminal, id, text, uploads) }

    override fun close() { watched.clear(); core.close() }
}
