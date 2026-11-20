package ai.namastex.automagik

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.DataInputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** [ChatClient] against a fake Pocket Link chat route that speaks chat.mjs's framing over in-memory streams. */
class ChatClientTest {
    /**
     * The bridge's side: answers hello (with [dshWrite] as its `dshWrite` when set), records every frame the phone
     * sends, answers requests with [answer].
     */
    private class FakeBridge(chat: Boolean, dshWrite: Any? = null, groups: Any? = null, val answer: (JSONObject) -> JSONObject = { JSONObject() }) {
        val toPhone = Channel<ByteArray>(Channel.UNLIMITED)
        val fromPhone = Channel<ByteArray>(Channel.UNLIMITED)
        val requests = LinkedBlockingQueue<JSONObject>()
        val hellos = LinkedBlockingQueue<JSONObject>()
        val credits = LinkedBlockingQueue<Pair<Int, Int>>()
        val closes = LinkedBlockingQueue<Int>()
        val phoneOut = object : OutputStream() {
            override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
            override fun write(b: ByteArray, off: Int, len: Int) { fromPhone.trySend(b.copyOfRange(off, off + len)) }
        }
        val phoneIn = ChannelInputStream(toPhone)

        fun send(bytes: ByteArray) { toPhone.trySend(bytes) }
        fun frame(channel: Int, kind: Int, payload: ByteArray) = send(Wire.encode(channel, kind, payload))

        init {
            thread(isDaemon = true) {
                val input = DataInputStream(ChannelInputStream(fromPhone))
                val line = StringBuilder()
                while (true) { val c = input.read(); if (c == -1) return@thread; if (c == 10) break; line.append(c.toChar()) }
                val hello = JSONObject(line.toString())
                hellos.put(hello.getJSONObject("params"))
                val result = JSONObject().put("generation", 1).put("framed", true).apply {
                    if (chat) put("chat", 1).put("credit", 256 * 1024)
                    if (dshWrite != null) put("dshWrite", dshWrite)
                    if (groups != null) put("groups", groups)
                }
                send((JSONObject().put("jsonrpc", "2.0").put("id", hello.get("id")).put("result", result).toString() + "\n").toByteArray())
                try {
                    while (true) {
                        val head = ByteArray(9); input.readFully(head)
                        val (channel, kind, length) = Wire.header(head)
                        val payload = ByteArray(length); input.readFully(payload)
                        when {
                            channel == 0 && kind == Wire.DATA -> {
                                val m = JSONObject(String(payload, Charsets.UTF_8))
                                requests.put(m)
                                val reply = JSONObject().put("jsonrpc", "2.0").put("id", m.get("id")).put("result", answer(m))
                                frame(0, Wire.DATA, reply.toString().toByteArray())
                            }
                            kind == Wire.CREDIT -> credits.put(channel to ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN).int)
                            kind == Wire.CLOSE -> closes.put(channel)
                        }
                    }
                } catch (_: Exception) { }
            }
        }
    }

    private fun withChat(bridge: FakeBridge, test: suspend CoroutineScope.(ChatClient) -> Unit) =
        withChat(bridge, groups = false, test = test)

    private fun withChat(bridge: FakeBridge, groups: Boolean, test: suspend CoroutineScope.(ChatClient) -> Unit) = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val core = CoreClient(bridge.phoneIn, bridge.phoneOut, Closeable { bridge.toPhone.close(); bridge.fromPhone.close() }, scope) { }
        try {
            withTimeout(10_000) { test(if (groups) ChatClient.start(core, groups = true) else ChatClient.start(core)) }
        } finally { core.close(); scope.cancel() }
    }

    private fun LinkedBlockingQueue<JSONObject>.next() = poll(5, TimeUnit.SECONDS) ?: error("no request")

    @Test fun anOlderBridgeWithoutChatSaysToUpdatePocketLink() = runBlocking {
        val bridge = FakeBridge(chat = false)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val e = runCatching { withTimeout(10_000) { ChatClient.start(CoreClient(bridge.phoneIn, bridge.phoneOut, Closeable { }, scope) { }) } }.exceptionOrNull()
            assertTrue(e is ChatUnsupported)
            assertEquals(Chat.UPDATE_LINK, e?.message)
        } finally { scope.cancel() }
        assertTrue(ChatClient.refusedRoute(IllegalStateException("connection failed: peer refused ALPN herdr-pocket/chat/1")))
        assertFalse(ChatClient.refusedRoute(IllegalStateException("timed out")))
    }

    @Test fun listsAndSubscribesThenGrantsCreditForEachEvent() {
        val bridge = FakeBridge(chat = true) { m ->
            when (m.getString("method")) {
                "chat.list" -> JSONObject("""{"terminals":[{"terminal":"t3","machine":null,"agent":"claude","title":"API","status":{"state":"working"},"chat":"transcript"},
                    {"terminal":"dsh:b1","machine":null,"agent":"dsh","title":"Omni","status":{"state":"idle"},"chat":"session"}]}""")
                "chat.subscribe" -> JSONObject().put("channel", 1)
                else -> JSONObject()
            }
        }
        withChat(bridge) { chat ->
            val list = chat.list()
            assertEquals(listOf("t3", "dsh:b1"), list.map { it.terminal })
            assertEquals(listOf(false, true), list.map { it.dsh })
            assertEquals("working", list[0].status)
            val events = Channel<JSONObject>(Channel.UNLIMITED)
            val channel = chat.subscribe("t3", "1:4.0", { events.trySend(it) }) { }
            assertEquals(1, channel)
            assertEquals("chat.list", bridge.requests.next().getString("method"))
            val subscribe = bridge.requests.next()
            assertEquals("t3", subscribe.getJSONObject("params").getString("terminal"))
            assertEquals("1:4.0", subscribe.getJSONObject("params").getString("after"))
            val snapshot = """{"type":"snapshot","reset":false,"rows":[{"id":"1:5.0","kind":"text","role":"assistant","text":"<img src=x>"}],"screen":[],"status":{"state":"working"},"approval":null,"held":[]}""" + "\n"
            bridge.frame(1, Wire.DATA, snapshot.toByteArray())
            val e = events.receive()
            assertEquals("snapshot", e.getString("type"))
            assertEquals("<img src=x>", Chat.reduce(Chat.State("t3"), e).rows.single().text)
            assertEquals(1 to snapshot.toByteArray().size, bridge.credits.poll(5, TimeUnit.SECONDS))
            chat.unsubscribe(channel)
            assertEquals(1, bridge.closes.poll(5, TimeUnit.SECONDS))
        }
    }

    @Test fun writesGoToTheBridgeForATerminal() {
        val bridge = FakeBridge(chat = true) { m -> if (m.getString("method") == "chat.send") JSONObject().put("state", "held").put("id", "m1").put("why", "draft") else JSONObject().put("ok", true) }
        withChat(bridge) { chat ->
            assertEquals("held", chat.send("t3", "run tests", "m1").getString("state"))
            val send = bridge.requests.next()
            assertEquals("chat.send", send.getString("method"))
            val params = send.getJSONObject("params")
            assertEquals(listOf("t3", "run tests", "m1"), listOf("terminal", "text", "id").map { params.getString(it) })
            assertEquals(3, params.length())
            chat.sendHeld("t3", "m1"); assertEquals("chat.sendHeld", bridge.requests.next().getString("method"))
            chat.answer("t3", "approval:c1", "allow"); assertEquals("chat.answer", bridge.requests.next().getString("method"))
            chat.interrupt("t3"); assertEquals("chat.interrupt", bridge.requests.next().getString("method"))
        }
    }

    /** A tap on a question's option sends chat.answer with that option's digit; a typed answer adds its text. */
    @Test fun aQuestionTapSendsChatAnswerWithTheOptionsDigit() {
        val bridge = FakeBridge(chat = true) { JSONObject().put("ok", true).put("pressed", "done").put("sent", true) }
        val row = """{"id":"question:1:2.0","kind":"question","source":"status","prompt":"Which database?","options":["Postgres","SQLite"],"multi":false,"answerable":true,"call":"1:2.0","open":true}"""
        val s = Chat.reduce(Chat.reduce(Chat.State("t3", connected = true), JSONObject("""{"type":"status","status":{"state":"blocked","kind":"question"}}""")),
            JSONObject("""{"type":"question","row":$row}"""))
        withChat(bridge) { chat ->
            assertEquals(listOf("Postgres", "SQLite"), ChatActions.options(s, s.question))
            val (choice, text) = ChatActions.questionAnswer(s, s.question, listOf(1))!!
            assertNull(Chat.answerNotice(chat.answer("t3", s.question!!.id, choice, text)))
            val tap = bridge.requests.next()
            assertEquals("chat.answer", tap.getString("method"))
            val p = tap.getJSONObject("params")
            assertEquals(listOf("t3", "question:1:2.0", "2"), listOf("terminal", "row", "choice").map { p.getString(it) })
            assertFalse(p.has("text"))
            val (other, typed) = ChatActions.questionAnswer(s, s.question, emptyList(), "MySQL")!!
            chat.answer("t3", s.question!!.id, other, typed)
            val p2 = bridge.requests.next().getJSONObject("params")
            assertEquals(listOf("other", "MySQL"), listOf(p2.getString("choice"), p2.getString("text")))
        }
    }

    /** A DSH chat on a bridge without `dshWrite` is read only: the phone sends no write for it at all, and answers as the bridge would. */
    @Test fun phoneNeverWritesOnADshChat() {
        val bridge = FakeBridge(chat = true) { JSONObject().put("ok", true) }
        withChat(bridge) { chat ->
            for (answer in listOf(chat.send("dsh:b1", "hi", "m1"), chat.sendHeld("dsh:b1", "m1"), chat.cancelHeld("dsh:b1", "m1"),
                chat.answer("dsh:b1", "dsh:s:1:approval", "allow"), chat.interrupt("dsh:b1"))) {
                assertEquals("refused", answer.getString("state"))
                assertEquals("read-only", answer.getString("reason"))
                assertEquals(Chat.ANSWER_ON_COMPUTER, answer.getString("message"))
            }
            // A read still goes, so the queue holds exactly that one request.
            chat.list()
            assertEquals("chat.list", bridge.requests.next().getString("method"))
            assertTrue(bridge.requests.isEmpty())
        }
    }

    /** Only `dshWrite: true` counts: no flag, false, 1 or "true" in the hello keeps DSH chats read only, nothing sent. */
    @Test fun aHelloWithoutDshWriteTrueKeepsDshChatsReadOnly() {
        for (flag in listOf(null, false, 1, "true")) {
            val bridge = FakeBridge(chat = true, dshWrite = flag) { JSONObject().put("ok", true).put("state", "sent") }
            withChat(bridge) { chat ->
                assertFalse(chat.dshWrite)
                for (a in listOf(chat.send("dsh:b1", "hi", "m1"), chat.answer("dsh:b1", "dsh:s:1:approval", "allow"), chat.interrupt("dsh:b1")))
                    assertEquals("read-only", a.getString("reason"))
                chat.list()
                assertEquals("chat.list", bridge.requests.next().getString("method"))
                assertTrue(bridge.requests.isEmpty())
            }
        }
    }

    /**
     * A bridge whose hello says `dshWrite: true` takes send, answer and interrupt on a DSH chat, through chat.*; the
     * phone sets no phone key or `by` (the bridge adds them). Nothing is ever held on a DSH chat, so those stay local.
     */
    @Test fun dshWritesGoToTheBridgeWhenItsHelloSaysDshWrite() {
        val bridge = FakeBridge(chat = true, dshWrite = true) { m ->
            if (m.getString("method") == "chat.send") JSONObject().put("ok", true).put("state", "queued").put("id", "m1")
            else JSONObject().put("ok", true).put("state", "sent")
        }
        withChat(bridge) { chat ->
            assertTrue(chat.dshWrite)
            assertFalse(chat.readOnly("dsh:b1"))
            assertEquals("queued", chat.send("dsh:b1", "hi", "m1").getString("state"))
            val send = bridge.requests.next()
            assertEquals("chat.send", send.getString("method"))
            val p = send.getJSONObject("params")
            assertEquals(listOf("dsh:b1", "hi", "m1"), listOf("terminal", "text", "id").map { p.getString(it) })
            assertEquals(3, p.length())
            assertNull(Chat.answerNotice(chat.answer("dsh:b1", "dsh:s:1:approval", "allow"), dsh = true))
            val answer = bridge.requests.next()
            assertEquals("chat.answer", answer.getString("method"))
            assertEquals(setOf("terminal", "row", "choice"), answer.getJSONObject("params").keys().asSequence().toSet())
            assertEquals("Interrupt sent.", Chat.interruptNotice(chat.interrupt("dsh:b1"), dsh = true))
            val interrupt = bridge.requests.next()
            assertEquals("chat.interrupt", interrupt.getString("method"))
            assertEquals(1, interrupt.getJSONObject("params").length())
            assertEquals("read-only", chat.sendHeld("dsh:b1", "m1").getString("reason"))
            assertEquals("read-only", chat.cancelHeld("dsh:b1", "m1").getString("reason"))
            chat.list()
            assertEquals("chat.list", bridge.requests.next().getString("method"))
            assertTrue(bridge.requests.isEmpty())
        }
    }

    /**
     * A send whose answer never came (the link dropped) is "maybe not sent", never a success and never sent again by
     * itself; a reconnect keeps it, and Retry sends the same id once, which bots-dsh answers `sent` without a prompt.
     */
    @Test fun aLostDshSendIsMaybeNotSentAndRetrySendsTheSameIdOnce() {
        lateinit var lost: FakeBridge
        lost = FakeBridge(chat = true, dshWrite = true) { lost.toPhone.close(); JSONObject() }
        var s = Chat.State("dsh:b1", connected = true, dshWrite = true, messages = listOf(Chat.Message("m1", "hi", "sending")))
        assertFalse(ChatActions.canRetry(s, s.messages.single()))
        withChat(lost) { chat ->
            assertTrue(runCatching { chat.send("dsh:b1", "hi", "m1") }.isFailure)
            s = Chat.unanswered(s, "m1", "hi")
        }
        assertEquals("chat.send", lost.requests.next().getString("method"))
        assertNull(lost.requests.poll(300, TimeUnit.MILLISECONDS))
        assertEquals("maybe", s.messages.single().state)
        // The reconnect: a new chat state keeps the unknown message, still with Retry.
        s = Chat.State("dsh:b1", connected = true, dshWrite = true, messages = Chat.unknown(s))
        val m = s.messages.single()
        assertTrue(ChatActions.canRetry(s, m))
        val again = FakeBridge(chat = true, dshWrite = true) { JSONObject().put("ok", true).put("state", "sent").put("id", "m1").put("repeat", true) }
        withChat(again) { chat -> s = Chat.answered(s, m.id, m.text, chat.send("dsh:b1", m.text, m.id)) }
        val retry = again.requests.next().getJSONObject("params")
        assertEquals(listOf("m1", "hi"), listOf(retry.getString("id"), retry.getString("text")))
        assertTrue(again.requests.isEmpty())
        assertEquals("sent", s.messages.single().state)
        assertFalse(ChatActions.canRetry(s, s.messages.single()))
    }

    /** The bridge's refusals on a DSH chat (its own or the socket's) reach the chat unchanged, with their reason and receipt. */
    @Test fun dshRefusalsFromTheBridgePassThrough() {
        val bridge = FakeBridge(chat = true, dshWrite = true) { m ->
            when (m.getString("method")) {
                "chat.send" -> JSONObject().put("state", "refused").put("ok", false).put("reason", "not-shown").put("id", "m1")
                "chat.answer" -> JSONObject("""{"state":"refused","ok":false,"reason":"settled","receipt":{"id":"r1","by":"computer","outcome":"allow","at":1}}""")
                else -> JSONObject().put("state", "refused").put("ok", false).put("reason", "rate")
            }
        }
        withChat(bridge) { chat ->
            val s = Chat.State("dsh:b1", connected = true, dshWrite = true)
            val sent = Chat.answered(s, "m1", "hi", chat.send("dsh:b1", "hi", "m1"))
            assertEquals(listOf("refused" to "not-shown"), sent.messages.map { it.state to it.reason })
            assertFalse(ChatActions.canRetry(sent, sent.messages.single()))
            assertEquals("Already answered on the computer: Allow.", Chat.answerNotice(chat.answer("dsh:b1", "r1", "allow"), dsh = true))
            assertEquals("Interrupt not sent: Too many taps. Wait a moment.", Chat.interruptNotice(chat.interrupt("dsh:b1"), dsh = true))
        }
    }
    private val room = "dsh:room:r1"

    @Test fun aPlainStartAsksNoGroups() {
        val bridge = FakeBridge(chat = true, groups = true)
        withChat(bridge) { chat ->
            assertFalse(bridge.hellos.next().has("groups"))
            assertFalse(chat.groups)
        }
    }

    @Test fun onlyGroupsTrueGrantsGroups() {
        for (flag in listOf(null, false, 1, "true", true)) {
            val bridge = FakeBridge(chat = true, groups = flag)
            withChat(bridge, groups = true) { chat ->
                assertEquals(1, bridge.hellos.next().get("groups"))
                assertEquals(flag == true, chat.groups)
            }
        }
    }

    @Test fun groupRowsListOnlyWithTheGrant() {
        for (granted in listOf(false, true)) {
            val bridge = FakeBridge(chat = true, groups = granted) { m ->
                when (m.getString("method")) {
                    "chat.subscribe" -> JSONObject().put("channel", 1)
                    else -> JSONObject("""{"terminals":[{"terminal":"dsh:b1"},{"terminal":"$room","machine":null,"agent":"dsh",
                        "chat":"group","title":"Launch","status":{"state":"blocked"},"approvals":2,"shown":true,
                        "members":[{"name":" Ana ","registryId":"b-a"},{"name":"Ben","registryId":null},{"name":" "},null]}]}""")
                }
            }
            withChat(bridge, groups = true) { chat ->
                val rows = chat.list()
                assertEquals(if (granted) listOf("dsh:b1", room) else listOf("dsh:b1"), rows.map { it.terminal })
                assertEquals("chat.list", bridge.requests.next().getString("method"))
                if (granted) {
                    val group = rows.last()
                    assertTrue(group.group)
                    assertEquals(listOf("Ana", "Ben"), group.members)
                    assertEquals(2, group.approvals)
                    assertNull(group.registryId)
                    assertEquals(1, chat.subscribe(room, null, {}, {}))
                    assertEquals(room, bridge.requests.next().getJSONObject("params").getString("terminal"))
                }
            }
        }
    }

    @Test fun withoutTheGrantAGroupSendsNothing() {
        val bridge = FakeBridge(chat = true, dshWrite = true)
        withChat(bridge, groups = true) { chat ->
            for (a in listOf(chat.send(room, "hi", "m1"), chat.answer(room, "a1", "deny"), chat.interrupt(room))) {
                assertEquals("read-only", a.getString("reason"))
            }
            assertTrue(runCatching { chat.subscribe(room, null, {}, {}) }.exceptionOrNull() is GroupsUnsupported)
            assertTrue(bridge.requests.isEmpty())
        }
    }

    @Test fun aRetryAddsRetryTrueAndAFirstSendDoesNot() {
        val bridge = FakeBridge(chat = true, dshWrite = true, groups = true) {
            if (it.getJSONObject("params").optBoolean("retry")) JSONObject("""{"ok":false,"state":"unknown","id":"m1"}""")
            else JSONObject("""{"ok":true,"state":"sent"}""")
        }
        withChat(bridge, groups = true) { chat ->
            val keys = setOf("terminal", "text", "id")
            chat.send(room, "hi", "m1")
            assertEquals(keys, bridge.requests.next().getJSONObject("params").keys().asSequence().toSet())

            val answer = chat.send(room, "hi", "m1", retry = true)
            val retry = bridge.requests.next().getJSONObject("params")
            assertEquals(keys + "retry", retry.keys().asSequence().toSet())
            assertEquals(true, retry.get("retry"))
            assertEquals("m1", retry.getString("id"))
            for (result in listOf(answer, JSONObject(answer.toString()).put("reason", "no-record"))) {
                assertEquals("unknown", Chat.answered(Chat.State(room), "m1", "hi", result).messages.single().state)
            }

            chat.send("dsh:b1", "hi", "m2")
            assertEquals(keys, bridge.requests.next().getJSONObject("params").keys().asSequence().toSet())
        }
    }

    @Test fun aGroupAnswerIsAllowOrDenyWithoutText() {
        val bridge = FakeBridge(chat = true, dshWrite = true, groups = true)
        withChat(bridge, groups = true) { chat ->
            assertEquals("invalid", chat.answer(room, "a1", "allow-always").getString("reason"))
            assertEquals("invalid", chat.answer(room, "a1", "allow", "yes").getString("reason"))
            assertTrue(bridge.requests.isEmpty())
            chat.answer(room, "a1", "deny")
            val answer = bridge.requests.next()
            assertEquals("chat.answer", answer.getString("method"))
            val p = answer.getJSONObject("params")
            assertEquals(setOf("terminal", "row", "choice"), p.keys().asSequence().toSet())
            assertEquals(listOf(room, "a1", "deny"), listOf("terminal", "row", "choice").map(p::getString))
        }
    }

    @Test fun aGrantedGroupStopSendsInterruptForTheRoom() {
        val bridge = FakeBridge(chat = true, dshWrite = true, groups = true) {
            JSONObject("""{"ok":false,"state":"failed","reason":"x"}""")
        }
        withChat(bridge, groups = true) { chat ->
            assertEquals(Chat.STOP_PARTLY, Chat.interruptNotice(chat.interrupt(room), dsh = true, group = true))
            val interrupt = bridge.requests.next()
            assertEquals("chat.interrupt", interrupt.getString("method"))
            assertEquals(room, interrupt.getJSONObject("params").getString("terminal"))
        }
    }
}
