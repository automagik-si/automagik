package ai.namastex.automagik

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.DataInputStream
import java.io.EOFException
import java.io.OutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class AttachClientTest {
    private class DelayedBridge(
        hello: JSONObject,
        private val delayMs: (String) -> Long = { 0 }
    ) : Closeable {
        private val toPhone = Channel<ByteArray>(Channel.UNLIMITED)
        private val fromPhone = Channel<ByteArray>(Channel.UNLIMITED)
        private val replies = ScheduledThreadPoolExecutor(2)
        val greeting = CompletableDeferred<JSONObject>()
        val requests = LinkedBlockingQueue<JSONObject>()
        val incomingFinish = CompletableDeferred<Unit>()

        fun client(scope: CoroutineScope) = CoreClient(ChannelInputStream(toPhone), object : OutputStream() {
            override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
            override fun write(b: ByteArray, off: Int, len: Int) { fromPhone.trySend(b.copyOfRange(off, off + len)) }
        }, this, scope) { }

        init {
            thread(isDaemon = true) {
                val input = DataInputStream(ChannelInputStream(fromPhone))
                val line = StringBuilder()
                try {
                    while (true) {
                        val b = input.readUnsignedByte()
                        if (b == 10) break
                        line.append(b.toChar())
                    }
                    val request = JSONObject(line.toString())
                    greeting.complete(request.getJSONObject("params"))
                    val result = hello.put("generation", 1).put("framed", true)
                    toPhone.trySend((reply(request, result).toString() + "\n").toByteArray())
                    while (true) {
                        val (channel, kind, length) = Wire.header(ByteArray(9).also { input.readFully(it) })
                        val payload = ByteArray(length).also { input.readFully(it) }
                        if (channel != 0 || kind != Wire.DATA) continue
                        val rpc = JSONObject(String(payload, Charsets.UTF_8))
                        val method = rpc.getString("method")
                        requests.put(rpc)
                        if (method == Attach.METHOD_FINISH) incomingFinish.complete(Unit)
                        replies.schedule({
                            val response = when (method) {
                                "chat.subscribe" -> JSONObject().put("channel", 1)
                                else -> JSONObject().put("ok", true)
                            }
                            frame(0, Wire.DATA, reply(rpc, response))
                        }, delayMs(method), TimeUnit.MILLISECONDS)
                    }
                } catch (_: EOFException) {
                    // Both pipe ends close with CoreClient.
                } catch (_: java.util.concurrent.RejectedExecutionException) {
                    // The client closed while the reader was dispatching its final request.
                }
            }
        }

        fun frame(channel: Int, kind: Int, json: JSONObject) {
            toPhone.trySend(Wire.encode(channel, kind, json.toString().toByteArray()))
        }

        fun next() = requests.poll(2, TimeUnit.SECONDS) ?: error("No request")
        override fun close() { toPhone.close(); fromPhone.close(); replies.shutdownNow() }

        private fun reply(request: JSONObject, result: JSONObject) =
            JSONObject().put("jsonrpc", "2.0").put("id", request.get("id")).put("result", result)
    }

    private fun withBridge(
        hello: JSONObject = offeredHello().put("chat", 1).put("dshWrite", true),
        delayMs: (String) -> Long = { 0 },
        test: suspend CoroutineScope.(DelayedBridge, CoreClient) -> Unit
    ) = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val bridge = DelayedBridge(hello, delayMs)
        val core = bridge.client(scope)
        try { withTimeout(8_000) { test(bridge, core) } }
        finally { core.close(); scope.cancel() }
    }

    @Test fun defaultHelloAndManagementOptInsKeepTheirExactKeys() {
        for (manage in listOf(emptyList(), ChatClient.MEMORY, ChatClient.SCHEDULES)) withBridge { bridge, core ->
            val chat = ChatClient.start(core, manage)
            val hello = bridge.greeting.await()
            assertEquals(setOf("framed", "generation") + if (manage.isEmpty()) emptySet() else setOf("manage"), hello.keys().asSequence().toSet())
            assertEquals(Attach.Peer.NotAsked, chat.attach)
        }
    }

    @Test fun optedInMethodsSendOnlyTheExactFieldsAndCanonicalChunkAndRow() = withBridge { bridge, core ->
        val chat = ChatClient.start(core, attachments = true)
        assertTrue(chat.attach is Attach.Peer.Offered)
        val hello = bridge.greeting.await()
        assertEquals(setOf("framed", "generation", "attachments"), hello.keys().asSequence().toSet())
        assertEquals(1, hello.getInt("attachments"))

        val terminal = "dsh:bot"
        chat.subscribe(terminal, null, {}, {})
        assertEquals("chat.subscribe", bridge.next().getString("method"))
        fun params(method: String, vararg keys: String): JSONObject {
            val rpc = bridge.next()
            assertEquals(method, rpc.getString("method"))
            return rpc.getJSONObject("params").also {
                assertEquals(keys.toSet() + "terminal", it.keys().asSequence().toSet())
                assertEquals(terminal, it.get("terminal"))
            }
        }
        chat.attachBegin(terminal, "upload", Attach.PNG, 2)
        val begin = params(Attach.METHOD_BEGIN, "upload", "mediaType", "bytes")
        assertEquals("upload", begin.getString("upload"))
        assertEquals(Attach.PNG, begin.getString("mediaType"))
        assertEquals(2, begin.getInt("bytes"))
        chat.attachChunk(terminal, "upload", 0, byteArrayOf(1, 2))
        val chunk = params(Attach.METHOD_CHUNK, "upload", "offset", "data")
        assertEquals(0, chunk.getInt("offset"))
        assertEquals("AQI=", chunk.getString("data"))
        chat.attachFinish(terminal, "upload")
        params(Attach.METHOD_FINISH, "upload")
        chat.attachCancel(terminal, "upload")
        params(Attach.METHOD_CANCEL, "upload")
        chat.attachmentRead(terminal, "dsh:s:1#3", 3)
        val read = params(Attach.METHOD_READ, "row", "block")
        assertEquals("dsh:s:1", read.getString("row"))
        assertEquals(3, read.getInt("block"))
        chat.sendUploads(terminal, "msg", "  ", listOf("upload", "other"))
        val imageOnly = params(Attach.METHOD_SEND, "id", "uploads")
        assertEquals("msg", imageOnly.getString("id"))
        assertEquals(listOf("upload", "other"), (0..1).map { imageOnly.getJSONArray("uploads").getString(it) })
        chat.sendUploads(terminal, "msg", " caption ", listOf("upload"))
        assertEquals(" caption ", params(Attach.METHOD_SEND, "id", "uploads", "text").getString("text"))
    }

    @Test fun allMethodsRefuseWithoutAnOfferOrMatchingWritableWatch() {
        suspend fun refuseAll(chat: ChatClient, terminal: String) {
            val replies = listOf(chat.attachBegin(terminal, "u", Attach.PNG, 1), chat.attachChunk(terminal, "u", 0, byteArrayOf(1)),
                chat.attachFinish(terminal, "u"), chat.attachCancel(terminal, "u"), chat.attachmentRead(terminal, "dsh:s:1", 0),
                chat.sendUploads(terminal, "m", "", listOf("u")))
            for (reply in replies) {
                assertEquals(setOf("ok", "state", "reason"), reply.keys().asSequence().toSet())
                assertEquals("read-only", reply.getString("reason"))
            }
        }
        val terminal = "dsh:bot"
        for (hello in listOf(offeredHello().put("dshWrite", false), offeredHello().put("dshWrite", true),
            JSONObject().put("dshWrite", true))) withBridge(hello.put("chat", 1)) { bridge, core ->
            val chat = ChatClient.start(core, attachments = true)
            refuseAll(chat, terminal)
            val channel = chat.subscribe(terminal, null, {}, {})
            bridge.next()
            refuseAll(chat, "dsh:other")
            refuseAll(chat, "t1")
            if (!chat.dshWrite || chat.attach !is Attach.Peer.Offered) refuseAll(chat, terminal)
            chat.unsubscribe(channel)
            refuseAll(chat, terminal)
            chat.subscribe("t1", null, {}, {})
            assertEquals("chat.subscribe", bridge.next().getString("method"))
            refuseAll(chat, "t1")
            assertTrue(bridge.requests.isEmpty())
        }
    }

    @Test fun streamCloseRemovesTheWatchAndPreChatRouteStillThrows() {
        withBridge { bridge, core ->
            val chat = ChatClient.start(core, attachments = true)
            val closed = CompletableDeferred<Unit>()
            val channel = chat.subscribe("dsh:bot", null, {}, { closed.complete(Unit) })
            bridge.next()
            bridge.frame(channel, Wire.CLOSE, JSONObject().put("reason", "slow"))
            closed.await()
            assertEquals("read-only", chat.attachCancel("dsh:bot", "u").getString("reason"))
            assertTrue(bridge.requests.isEmpty())
        }
        withBridge(offeredHello()) { _, core ->
            assertTrue(runCatching { ChatClient.start(core, attachments = true) }.exceptionOrNull() is ChatUnsupported)
        }
    }

    @Test fun delayedFinishHasItsOwnDeadlineAndOtherCallsKeepCompleting() =
        withBridge(delayMs = { if (it == Attach.METHOD_FINISH || it == Attach.METHOD_CANCEL) 400 else 0 }) { bridge, core ->
            assertEquals(30_000L, core.callTimeoutMs)
            val chat = ChatClient.start(core, attachments = true)
            assertTrue(chat.finishTimeoutMs >= 75_000L)
            chat.subscribe("dsh:bot", null, {}, {})
            core.callTimeoutMs = 100
            chat.finishTimeoutMs = 2_000
            val finished = CopyOnWriteArrayList<String>()
            val finish = async {
                assertTrue(chat.attachFinish("dsh:bot", "upload").getBoolean("ok"))
                finished += "finish"
            }
            bridge.incomingFinish.await()
            chat.list()
            finished += "list"
            val timeout = runCatching { chat.attachCancel("dsh:bot", "upload") }.exceptionOrNull()
            assertTrue(timeout is TimeoutCancellationException)
            finish.await()
            assertEquals(listOf("list", "finish"), finished.toList())
        }
}
