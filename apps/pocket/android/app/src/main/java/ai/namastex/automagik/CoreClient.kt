package ai.namastex.automagik

import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.Closeable
import java.io.DataInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

class CoreError(val kind: String, message: String) : IllegalStateException(message)

class CoreClient(
    input: InputStream, private val output: OutputStream, private val transport: Closeable,
    private val scope: CoroutineScope, private val disconnected: (String) -> Unit
) : Closeable {
    private val input = DataInputStream(input)
    private val pending = ConcurrentHashMap<Int, CompletableDeferred<JSONObject>>()
    private val ids = AtomicInteger(1)
    private val handlers = mutableMapOf<Int, (Frame) -> Unit>()
    /** Attached streams whose path takes AUTOMATIC_INPUT (the attach's automatic_input). */
    private val automatic = ConcurrentHashMap.newKeySet<Int>()
    fun automaticInput(channel: Int) = channel in automatic
    private val early = mutableMapOf<Int, MutableList<Frame>>()
    private var earlyBytes = 0
    private val gate = Any()
    @Volatile private var closed = false
    lateinit var hello: JSONObject
        private set

    suspend fun start(manage: JSONArray? = null): JSONObject = withContext(Dispatchers.IO) {
        val params = JSONObject().put("framed", true).put("generation", 1)
        if (manage != null && manage.length() > 0) params.put("manage", manage)
        val request = JSONObject().put("jsonrpc", "2.0").put("id", 0).put("method", "hello").put("params", params)
        synchronized(output) { output.write((request.toString() + "\n").toByteArray()); output.flush() }
        val line = java.io.ByteArrayOutputStream()
        while (true) {
            val c = input.read()
            check(c != -1) { "Core closed before its hello. Check that hc is installed and running." }
            if (c == 10) break
            check(line.size() < 1024 * 1024) { "Invalid core hello" }
            line.write(c)
        }
        hello = try {
            val reply = JSONObject(line.toString("UTF-8"))
            check(!reply.has("error")) { reply.optJSONObject("error")?.optString("message") ?: "Core rejected hello" }
            reply.getJSONObject("result")
        } catch (_: JSONException) { error("Invalid hello from the computer") }
        check(hello.optInt("generation") == 1 && hello.optBoolean("framed")) { "This app needs herdr-core protocol generation 1" }
        scope.launch(Dispatchers.IO) {
            try {
                while (!closed) {
                    val header = ByteArray(9); input.readFully(header)
                    val (channel, kind, length) = Wire.header(header)
                    val payload = ByteArray(length); input.readFully(payload)
                    if (channel == 0 && kind == Wire.DATA) {
                        val json = JSONObject(String(payload, Charsets.UTF_8))
                        val deferred = pending.remove(json.optInt("id")) ?: continue
                        val error = json.optJSONObject("error")
                        if (error != null) {
                            val message = error.optString("message", "Core request failed")
                            val errorKind = error.optJSONObject("data")?.opt("kind") as? String
                            deferred.completeExceptionally(if (errorKind == null) IllegalStateException(message) else CoreError(errorKind, message))
                        } else deferred.complete(json.optJSONObject("result") ?: JSONObject())
                    } else synchronized(gate) {
                        val frame = Frame(channel, kind, payload)
                        val handler = handlers[channel]
                        if (handler != null) handler(frame)
                        else {
                            check(earlyBytes + payload.size <= 4 * 1024 * 1024) { "Unclaimed core stream exceeded limit" }
                            early.getOrPut(channel) { mutableListOf() }.add(frame)
                            earlyBytes += payload.size
                        }
                    }
                }
            } catch (e: Exception) {
                if (!closed) {
                    close()
                    disconnected(if (generateSequence<Throwable>(e) { it.cause }.any { it is JSONException })
                        "Invalid message from the computer" else e.message ?: "Connection lost")
                }
            }
        }
        hello
    }

    suspend fun call(method: String, params: JSONObject = JSONObject()): JSONObject {
        check(!closed) { "Disconnected" }
        val id = ids.getAndIncrement()
        val deferred = CompletableDeferred<JSONObject>()
        pending[id] = deferred
        return try {
            send(0, Wire.DATA, JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params).toString().toByteArray())
            withTimeout(30_000) { deferred.await() }
        } finally { pending.remove(id) }
    }

    fun send(channel: Int, kind: Int, payload: ByteArray = byteArrayOf()) {
        check(!closed) { "Disconnected" }
        synchronized(output) { output.write(Wire.encode(channel, kind, payload)); output.flush() }
    }

    private fun register(channel: Int, handler: (Frame) -> Unit) = synchronized(gate) {
        handlers[channel] = handler
        early.remove(channel)?.forEach { earlyBytes -= it.payload.size; handler(it) }
    }

    suspend fun subscribe(changed: () -> Unit) {
        val reply = call("events.subscribe")
        register(reply.getInt("channel")) { f ->
            if (f.kind == Wire.DATA) { changed(); send(f.channel, Wire.CREDIT, Wire.credit(f.payload.size)) }
        }
    }

    suspend fun attach(address: String, cols: Int, rows: Int, rendered: (Int, ByteArray) -> Unit, ended: (String) -> Unit, history: Int = 1000): Int {
        val reply = call("terminal.attach", JSONObject().put("terminal", address).put("cols", cols).put("rows", rows).put("history", history))
        val channel = reply.getInt("channel")
        if (reply.optBoolean("automatic_input")) automatic.add(channel)
        register(channel) { f ->
            when (f.kind) {
                Wire.DATA -> rendered(channel, f.payload)
                Wire.CLOSE -> {
                    // Keep a tombstone until the connection ends: CLOSE acknowledgements must not be queued.
                    handlers[channel] = { }
                    val reason = runCatching { JSONObject(String(f.payload)).optString("reason") }.getOrDefault("")
                    ended(reason.ifBlank { "Terminal detached" })
                }
            }
        }
        return channel
    }

    /**
     * A stream another route opened on [channel] (the chat's subscriptions): each DATA frame to [data], its bytes
     * granted back as credit once handled, as [subscribe] does; a CLOSE to [closed] with its reason.
     */
    fun stream(channel: Int, data: (ByteArray) -> Unit, closed: (String) -> Unit) = register(channel) { f ->
        when (f.kind) {
            Wire.DATA -> { data(f.payload); if (!this.closed) runCatching { send(f.channel, Wire.CREDIT, Wire.credit(f.payload.size)) } }
            Wire.CLOSE -> {
                handlers[channel] = { }
                closed(runCatching { JSONObject(String(f.payload)).optString("reason") }.getOrDefault(""))
            }
        }
    }

    fun detach(channel: Int) {
        synchronized(gate) { handlers[channel] = { } }
        if (!closed) send(channel, Wire.CLOSE)
    }

    override fun close() {
        if (closed) return
        closed = true
        pending.values.forEach { it.completeExceptionally(IllegalStateException("Connection closed")) }; pending.clear()
        runCatching { transport.close() }
        synchronized(gate) { handlers.clear(); early.clear(); earlyBytes = 0 }
    }
}
