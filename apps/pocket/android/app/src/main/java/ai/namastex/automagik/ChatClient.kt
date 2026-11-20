package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable

/** The desktop's Pocket Link has no chat route yet (an older bridge): the terminal view is all there is. */
class ChatUnsupported : IllegalStateException(Chat.UPDATE_LINK)

/**
 * The chat connection the view model drives. [ChatClient] is the production one, over Pocket Link's chat route; this
 * interface is the internal seam that lets the JVM unit tests put a fake bridge behind the same code path (#754).
 */
internal interface ChatLink : Closeable {
    val dshWrite: Boolean
    val manage: Set<String> get() = emptySet()
    suspend fun list(): List<Chat.Terminal>
    suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit): Int
    suspend fun backfill(terminal: String, before: String, limit: Int = 50): JSONArray
    suspend fun send(terminal: String, text: String, id: String): JSONObject
    suspend fun sendHeld(terminal: String, id: String): JSONObject
    suspend fun cancelHeld(terminal: String, id: String): JSONObject
    suspend fun answer(terminal: String, row: String, choice: String, text: String? = null): JSONObject
    suspend fun interrupt(terminal: String): JSONObject
    suspend fun memoryRead(terminal: String) = ChatClient.refusedMemory()
    suspend fun memoryEdit(terminal: String, id: String, rev: String, text: String) = ChatClient.refusedMemory()
    suspend fun memoryAdd(terminal: String, text: String) = ChatClient.refusedMemory()
}

/** The production [ChatLink]: [ChatClient] over Pocket Link's chat route, straight through. */
internal class PocketLinkChat(private val client: ChatClient) : ChatLink {
    override val dshWrite get() = client.dshWrite
    override val manage get() = client.manage
    override suspend fun list() = client.list()
    override suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit) =
        client.subscribe(terminal, after, event, closed)
    override suspend fun backfill(terminal: String, before: String, limit: Int) = client.backfill(terminal, before, limit)
    override suspend fun send(terminal: String, text: String, id: String) = client.send(terminal, text, id)
    override suspend fun sendHeld(terminal: String, id: String) = client.sendHeld(terminal, id)
    override suspend fun cancelHeld(terminal: String, id: String) = client.cancelHeld(terminal, id)
    override suspend fun answer(terminal: String, row: String, choice: String, text: String?) = client.answer(terminal, row, choice, text)
    override suspend fun interrupt(terminal: String) = client.interrupt(terminal)
    override suspend fun memoryRead(terminal: String) = client.memoryRead(terminal)
    override suspend fun memoryEdit(terminal: String, id: String, rev: String, text: String) = client.memoryEdit(terminal, id, rev, text)
    override suspend fun memoryAdd(terminal: String, text: String) = client.memoryAdd(terminal, text)
    override fun close() = client.close()
}

/**
 * The `chat.*` methods of Pocket Link's `herdr-pocket/chat/1` route, over the same framing herdr-core speaks
 * ([CoreClient]). A write on a DSH chat is refused here, before anything is sent, unless the bridge's hello said
 * `dshWrite: true` ([dshWrite]); the bridge refuses it too without a socket that takes writes (dsh-source.mjs).
 * With it, send, answer and interrupt go to the bridge as on a terminal: the bridge adds the phone's name and key,
 * which the phone never sets. Held messages never exist on a DSH chat, so sendHeld and cancelHeld stay refused.
 */
class ChatClient(private val core: CoreClient, val dshWrite: Boolean = false, val manage: Set<String> = emptySet()) : Closeable {
    companion object {
        val MEMORY = listOf("memory.read", "memory.edit", "memory.add")

        /** The bridge's answer to a write the phone never sends: the same shape dsh-source.mjs `refusedDsh` gives. */
        fun refusedReadOnly(id: String? = null): JSONObject = JSONObject().put("state", "refused").put("ok", false)
            .put("reason", "read-only").put("message", Chat.ANSWER_ON_COMPUTER).apply { if (id != null) put("id", id) }

        internal fun refusedMemory() = JSONObject().put("ok", false).put("state", "refused").put("reason", "read-only")

        /** Memory is opt-in per connection and is usable only when the bridge grants at least its read method. */
        suspend fun start(core: CoreClient, manage: List<String> = emptyList()): ChatClient {
            val requested = MEMORY.filter { it in manage }
            val hello = core.start(requested.takeIf { it.isNotEmpty() }?.let { JSONArray(it) })
            if (hello.optInt("chat") != 1) { core.close(); throw ChatUnsupported() }
            val answered = hello.optJSONArray("manage")?.let { a -> (0 until a.length()).map { a.opt(it) } }.orEmpty()
            val granted = if (answered.all { it is String }) requested.filter { it in answered }.toSet() else emptySet()
            return ChatClient(core, dshWrite = hello.opt("dshWrite") == true, manage = granted.takeIf { "memory.read" in it }.orEmpty())
        }

        /** A connect that failed because the bridge does not offer the chat route (an older Pocket Link). */
        fun refusedRoute(e: Throwable): Boolean {
            val m = generateSequence(e) { it.cause }.mapNotNull { it.message?.lowercase() }.joinToString(" ")
            return "alpn" in m || "application protocol" in m || "no_application_protocol" in m
        }
    }

    private fun params(terminal: String) = JSONObject().put("terminal", terminal)

    /** Whether this phone refuses a write on [terminal] itself: a DSH chat on a bridge without `dshWrite`. */
    fun readOnly(terminal: String) = Chat.readOnly(terminal, dshWrite)

    suspend fun list(): List<Chat.Terminal> {
        val terminals = core.call("chat.list").optJSONArray("terminals") ?: JSONArray()
        return (0 until terminals.length()).mapNotNull { terminals.optJSONObject(it) }.map(Chat.Terminal::parse).filter { it.terminal.isNotEmpty() }
    }

    /**
     * Watches [terminal]'s chat from [after] (a row id, or null for the latest page). Each event line goes to
     * [event]; [closed] gets the reason the bridge closed it ("slow": resubscribe with the cursor).
     */
    suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit): Int {
        val p = params(terminal).apply { if (after != null) put("after", after) }
        val channel = core.call("chat.subscribe", p).getInt("channel")
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
        }, closed)
        return channel
    }

    fun unsubscribe(channel: Int) = runCatching { core.detach(channel) }

    suspend fun backfill(terminal: String, before: String, limit: Int = 50): JSONArray =
        core.call("chat.backfill", params(terminal).put("before", before).put("limit", limit)).optJSONArray("rows") ?: JSONArray()

    suspend fun send(terminal: String, text: String, id: String): JSONObject =
        if (readOnly(terminal)) refusedReadOnly(id) else core.call("chat.send", params(terminal).put("text", text).put("id", id))

    suspend fun sendHeld(terminal: String, id: String): JSONObject =
        if (Chat.isDsh(terminal)) refusedReadOnly(id) else core.call("chat.sendHeld", params(terminal).put("id", id))

    suspend fun cancelHeld(terminal: String, id: String): JSONObject =
        if (Chat.isDsh(terminal)) refusedReadOnly(id) else core.call("chat.cancelHeld", params(terminal).put("id", id))

    /** [text]: a question's typed answer, with choice [ChatActions.OTHER] only. */
    suspend fun answer(terminal: String, row: String, choice: String, text: String? = null): JSONObject =
        if (readOnly(terminal)) refusedReadOnly()
        else core.call("chat.answer", params(terminal).put("row", row).put("choice", choice).apply { if (text != null) put("text", text) })

    suspend fun interrupt(terminal: String): JSONObject =
        if (readOnly(terminal)) refusedReadOnly() else core.call("chat.interrupt", params(terminal))

    private suspend fun memory(method: String, terminal: String, fields: JSONObject.() -> Unit): JSONObject =
        if (method !in manage || !Chat.isDsh(terminal)) refusedMemory() else core.call(method, params(terminal).apply(fields))

    suspend fun memoryRead(terminal: String) = memory("memory.read", terminal) { }
    suspend fun memoryEdit(terminal: String, id: String, rev: String, text: String) =
        memory("memory.edit", terminal) { put("id", id).put("rev", rev).put("text", text) }
    suspend fun memoryAdd(terminal: String, text: String) = memory("memory.add", terminal) { put("text", text) }

    override fun close() = core.close()
}
