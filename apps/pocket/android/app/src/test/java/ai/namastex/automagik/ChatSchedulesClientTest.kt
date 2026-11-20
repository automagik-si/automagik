package ai.namastex.automagik

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.OutputStream

class ChatSchedulesClientTest {
    /** Exercise negotiation and calls through CoreClient's real framed read loop. */
    private class Bridge(private val manage: Any? = null) {
        private val incoming = Channel<ByteArray>(Channel.UNLIMITED)
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val requests = mutableListOf<JSONObject>()
        private var rawHello = ""

        private val output = object : OutputStream() {
            override fun write(b: Int) = error("expected a whole request")
            override fun write(b: ByteArray, off: Int, len: Int) {
                val bytes = b.copyOfRange(off, off + len)
                if (rawHello.isEmpty()) {
                    rawHello = bytes.toString(Charsets.UTF_8)
                    val hello = JSONObject(rawHello)
                    val result = JSONObject().put("generation", 1).put("framed", true).put("chat", 1)
                    if (manage != null) result.put("manage", manage)
                    val line = JSONObject().put("jsonrpc", "2.0").put("id", hello.get("id")).put("result", result)
                    incoming.trySend(("$line\n").toByteArray())
                } else {
                    val (channel, kind, size) = Wire.header(bytes.copyOfRange(0, 9))
                    check(channel == 0 && kind == Wire.DATA && size == bytes.size - 9)
                    val request = JSONObject(bytes.copyOfRange(9, bytes.size).toString(Charsets.UTF_8))
                    requests += request
                    val reply = JSONObject().put("jsonrpc", "2.0").put("id", request.get("id"))
                        .put("result", JSONObject().put("ok", true))
                    incoming.trySend(Wire.encode(0, Wire.DATA, reply.toString().toByteArray()))
                }
            }
        }

        val core = CoreClient(ChannelInputStream(incoming), output, Closeable { incoming.cancel() }, scope) { }
        val params get() = JSONObject(rawHello).getJSONObject("params")
        val requested get() = params.optJSONArray("manage")?.let { (0 until it.length()).map(it::getString) }
        fun close() { core.close(); scope.cancel() }
    }

    private fun withChat(bridge: Bridge, requested: List<String> = ChatClient.SCHEDULES, test: suspend (ChatLink) -> Unit) = runBlocking {
        try { withTimeout(10_000) { test(PocketLinkChat(ChatClient.start(bridge.core, requested))) } }
        finally { bridge.close() }
    }

    private fun assertLocalRefusal(reply: JSONObject) {
        assertEquals(3, reply.length())
        assertEquals(false, reply.get("ok"))
        assertEquals("refused", reply.getString("state"))
        assertEquals("read-only", reply.getString("reason"))
    }

    @Test fun scheduleHelloOnlyRequestsKnownMethodsAndIntersectsTheAnswer() {
        val bridge = Bridge(JSONArray(listOf("schedule.list", "schedule.pause", "memory.read", "schedule.extra")))
        withChat(bridge, ChatClient.SCHEDULES.reversed() + "schedule.extra") { link ->
            assertEquals(ChatClient.SCHEDULES, bridge.requested)
            assertEquals(setOf("framed", "generation", "manage"), bridge.params.keys().asSequence().toSet())
            assertEquals(setOf("schedule.list", "schedule.pause"), link.manage)
        }
        val excess = Bridge(JSONArray(ChatClient.SCHEDULES))
        withChat(excess, listOf("schedule.list")) { assertEquals(setOf("schedule.list"), it.manage) }
        val ordinary = Bridge(JSONArray(ChatClient.SCHEDULES))
        withChat(ordinary, emptyList()) {
            assertNull(ordinary.requested)
            assertTrue(it.manage.isEmpty())
        }
    }

    @Test fun eachFamilyNeedsItsOwnReadAndMemoryOnlyHelloKeepsItsBehavior() {
        val cases = listOf(
            Triple(listOf("schedule.list"), ChatClient.SCHEDULES, setOf("schedule.list")),
            Triple(listOf("schedule.pause", "schedule.rename"), ChatClient.SCHEDULES, emptySet<String>()),
            Triple(listOf("memory.read", "memory.edit", "schedule.rename"), ChatClient.MEMORY + ChatClient.SCHEDULES, setOf("memory.read", "memory.edit")),
            Triple(listOf("memory.add", "schedule.list", "schedule.resume"), ChatClient.MEMORY + ChatClient.SCHEDULES, setOf("schedule.list", "schedule.resume")),
            Triple(ChatClient.MEMORY + ChatClient.SCHEDULES, ChatClient.MEMORY, ChatClient.MEMORY.toSet()),
            Triple(listOf("memory.edit", "schedule.list"), ChatClient.MEMORY, emptySet<String>()),
            Triple(ChatClient.MEMORY + ChatClient.SCHEDULES, ChatClient.MEMORY + ChatClient.SCHEDULES, (ChatClient.MEMORY + ChatClient.SCHEDULES).toSet()))
        for ((offer, request, usable) in cases) {
            val bridge = Bridge(JSONArray(offer))
            withChat(bridge, request) { link ->
                assertEquals(request, bridge.requested)
                assertEquals(usable, link.manage)
            }
        }
    }

    @Test fun absentMalformedAndWriteOnlyGrantsRefuseAllScheduleCallsWithoutSending() {
        val bot = "dsh:lead"
        for (offer in listOf(null, "schedule.list", JSONObject().put("schedule.list", true),
            JSONArray(listOf("schedule.list", 1)), JSONArray(listOf("schedule.list", JSONObject.NULL)),
            JSONArray(listOf("schedule.pause", "schedule.resume", "schedule.rename")))) {
            val bridge = Bridge(offer)
            withChat(bridge) { link ->
                assertTrue(link.manage.isEmpty())
                assertLocalRefusal(link.scheduleList(bot, "id"))
                assertLocalRefusal(link.schedulePause(bot, "id", "rev"))
                assertLocalRefusal(link.scheduleResume(bot, "id", "rev"))
                assertLocalRefusal(link.scheduleRename(bot, "id", "rev", "New title"))
                assertTrue(bridge.requests.isEmpty())
            }
        }
    }

    @Test fun scheduleCallsForwardOnlyTheirExactFieldsAndRefuseOtherTerminalsLocally() {
        val bridge = Bridge(JSONArray(ChatClient.SCHEDULES))
        withChat(bridge) { link ->
            val bot = "dsh:lead"
            val id = "x0000000000000001"
            val rev = "89abcdef01234567"
            assertLocalRefusal(link.scheduleList("t3"))
            assertLocalRefusal(link.schedulePause("t3", id, rev))
            assertLocalRefusal(link.scheduleResume("t3", id, rev))
            assertLocalRefusal(link.scheduleRename("t3", id, rev, "New title"))
            assertTrue(bridge.requests.isEmpty())
            link.scheduleList(bot)
            link.scheduleList(bot, id)
            link.schedulePause(bot, id, rev)
            link.scheduleResume(bot, id, rev)
            link.scheduleRename(bot, id, rev, "New title")
            assertEquals(listOf("schedule.list") + ChatClient.SCHEDULES, bridge.requests.map { it.getString("method") })
            val edit = mapOf("terminal" to bot, "id" to id, "rev" to rev)
            val expected = listOf(mapOf("terminal" to bot), mapOf("terminal" to bot, "id" to id), edit, edit, edit + ("title" to "New title"))
            for ((request, fields) in bridge.requests.zip(expected)) {
                val params = request.getJSONObject("params")
                assertEquals(fields.keys, params.keys().asSequence().toSet())
                for ((key, value) in fields) assertEquals(value, params.get(key))
            }
        }
    }

    @Test fun listOnlyAllowsSelectedReadsAndRefusesEveryWriteLocally() {
        val bridge = Bridge(JSONArray(listOf("schedule.list")))
        withChat(bridge) { link ->
            val bot = "dsh:lead"
            assertLocalRefusal(link.schedulePause(bot, "id", "rev"))
            assertLocalRefusal(link.scheduleResume(bot, "id", "rev"))
            assertLocalRefusal(link.scheduleRename(bot, "id", "rev", "New title"))
            assertTrue(bridge.requests.isEmpty())
            assertEquals(true, link.scheduleList(bot, "id").get("ok"))
            assertEquals("schedule.list", bridge.requests.single().getString("method"))
        }
    }
}
