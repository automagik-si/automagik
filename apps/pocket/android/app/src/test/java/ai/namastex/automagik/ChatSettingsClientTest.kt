package ai.namastex.automagik

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.OutputStream

class ChatSettingsClientTest {
    private class Bridge(private val offer: Any?) : Closeable {
        private val incoming = Channel<ByteArray>(Channel.UNLIMITED)
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        private var rawHello = ""
        val requested: List<String>?
            get() = JSONObject(rawHello).getJSONObject("params").optJSONArray("manage")
                ?.let { a -> (0 until a.length()).map(a::getString) }
        val requests = mutableListOf<JSONObject>()

        private val output = object : OutputStream() {
            override fun write(b: Int) = error("Expected a whole request")
            override fun write(b: ByteArray, off: Int, len: Int) {
                val bytes = b.copyOfRange(off, off + len)
                if (rawHello.isEmpty()) {
                    rawHello = bytes.toString(Charsets.UTF_8)
                    val hello = JSONObject(rawHello)
                    val result = JSONObject().put("generation", 1).put("framed", true).put("chat", 1)
                    if (offer != null) result.put("manage", offer)
                    val reply = JSONObject().put("jsonrpc", "2.0").put("id", hello.get("id")).put("result", result)
                    incoming.trySend(("$reply\n").toByteArray())
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

        override fun close() { core.close(); scope.cancel() }
    }

    private fun withChat(offer: Any?, methods: List<String> = ChatClient.SETTINGS, test: suspend (Bridge, ChatLink) -> Unit) =
        runBlocking {
            Bridge(offer).use { bridge ->
                withTimeout(10_000) { test(bridge, PocketLinkChat(ChatClient.start(bridge.core, methods))) }
            }
        }

    private fun assertUnsent(reply: JSONObject) {
        assertEquals(3, reply.length())
        assertEquals(false, reply.get("ok"))
        assertEquals("refused", reply.get("state"))
        assertEquals("read-only", reply.get("reason"))
    }

    @Test fun settingsNegotiatesItsOwnReadAndIntersectsTheOfferAlongsideTheOtherFamilies() {
        val known = ChatClient.MEMORY + ChatClient.SCHEDULES + ChatClient.SETTINGS
        val offered = listOf("memory.read", "memory.add", "schedule.list", "settings.read", "settings.model")
        withChat(JSONArray(offered + "settings.level"), (known + "settings.level").reversed()) { bridge, link ->
            assertEquals(known, bridge.requested)
            assertEquals(offered.toSet(), link.manage)
            assertEquals(true, link.settingsRead(SETTINGS_BOT).get("ok"))
            assertEquals(true, link.settingsModel(SETTINGS_BOT, SETTINGS_REV, SETTINGS_OTHER_MODEL).get("ok"))
            assertUnsent(link.settingsName(SETTINGS_BOT, SETTINGS_REV, "Fixture Rename"))
            assertEquals(listOf("settings.read", "settings.model"), bridge.requests.map { it.getString("method") })
        }
        withChat(JSONArray(known), emptyList()) { bridge, link ->
            assertNull(bridge.requested)
            assertTrue(link.manage.isEmpty())
            assertUnsent(link.settingsRead(SETTINGS_BOT))
            assertTrue(bridge.requests.isEmpty())
        }
        withChat(JSONArray(known), listOf("settings.name")) { bridge, link ->
            assertEquals(listOf("settings.name"), bridge.requested)
            assertTrue(link.manage.isEmpty())
            assertUnsent(link.settingsName(SETTINGS_BOT, SETTINGS_REV, "Fixture Rename"))
            assertTrue(bridge.requests.isEmpty())
        }
    }

    @Test fun legacyMalformedAndWriteOnlyOffersLeaveSettingsUnsent() {
        withChat(JSONArray(ChatClient.SETTINGS)) { bridge, link ->
            assertEquals(true, link.settingsRead(SETTINGS_BOT).get("ok"))
            assertEquals(1, bridge.requests.size)
        }
        for (offer in listOf(null, "settings.read", JSONArray(listOf("settings.read", 1)),
            JSONArray(listOf("settings.read", JSONObject.NULL)), JSONArray(listOf("settings.name", "settings.model")))) {
            withChat(offer) { bridge, link ->
                assertEquals(ChatClient.SETTINGS, bridge.requested)
                assertTrue(link.manage.isEmpty())
                assertUnsent(link.settingsRead(SETTINGS_BOT))
                assertUnsent(link.settingsName(SETTINGS_BOT, SETTINGS_REV, "Fixture Rename"))
                assertUnsent(link.settingsModel(SETTINGS_BOT, SETTINGS_REV, SETTINGS_OTHER_MODEL))
                assertTrue(bridge.requests.isEmpty())
            }
        }
    }

    @Test fun settingsSendsOnlyTheExactFieldsAndRejectsNonBotTerminalsLocally() {
        withChat(JSONArray(ChatClient.SETTINGS)) { bridge, link ->
            val name = "Fixture Rename"
            link.settingsRead(SETTINGS_BOT)
            link.settingsName(SETTINGS_BOT, SETTINGS_REV, name)
            link.settingsModel(SETTINGS_BOT, SETTINGS_REV, SETTINGS_OTHER_MODEL)
            for (terminal in listOf("t3", "dsh:")) {
                assertUnsent(link.settingsRead(terminal))
                assertUnsent(link.settingsName(terminal, SETTINGS_REV, name))
                assertUnsent(link.settingsModel(terminal, SETTINGS_REV, SETTINGS_OTHER_MODEL))
            }
            assertEquals(ChatClient.SETTINGS, bridge.requests.map { it.getString("method") })
            val target = mapOf("terminal" to SETTINGS_BOT)
            val edit = target + ("rev" to SETTINGS_REV)
            val expected = listOf(target, edit + ("name" to name), edit + ("model" to SETTINGS_OTHER_MODEL))
            for ((request, fields) in bridge.requests.zip(expected)) {
                val params = request.getJSONObject("params")
                assertEquals(fields.keys, params.keys().asSequence().toSet())
                for ((key, value) in fields) assertEquals(value, params.get(key))
            }
        }
    }
}
