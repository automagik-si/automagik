package ai.namastex.automagik

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.OutputStream

class ChatMemoryClientTest {
    /** Receives the raw hello and frames from the phone. The response goes through CoreClient's real read loop. */
    private class Bridge(private val manage: Any? = null, private val helloLine: String? = null,
                         private val answer: (JSONObject) -> JSONObject = { JSONObject().put("result", JSONObject().put("ok", true)) }) {
        private val incoming = Channel<ByteArray>(Channel.UNLIMITED)
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val disconnected = CompletableDeferred<String>()
        val requests = mutableListOf<JSONObject>()
        var rawHello = ""
            private set

        private val output = object : OutputStream() {
            override fun write(b: Int) = error("expected a whole request")
            override fun write(b: ByteArray, off: Int, len: Int) {
                val bytes = b.copyOfRange(off, off + len)
                if (rawHello.isEmpty()) {
                    rawHello = bytes.toString(Charsets.UTF_8)
                    val hello = JSONObject(rawHello)
                    val result = JSONObject().put("generation", 1).put("framed", true).put("chat", 1)
                    if (manage != null) result.put("manage", manage)
                    val line = helloLine ?: JSONObject().put("jsonrpc", "2.0").put("id", hello.get("id")).put("result", result).toString()
                    incoming.trySend((line + "\n").toByteArray())
                } else {
                    val (channel, kind, size) = Wire.header(bytes.copyOfRange(0, 9))
                    check(channel == 0 && kind == Wire.DATA && size == bytes.size - 9)
                    val request = JSONObject(bytes.copyOfRange(9, bytes.size).toString(Charsets.UTF_8))
                    requests += request
                    val reply = answer(request).put("jsonrpc", "2.0").put("id", request.get("id"))
                    frame(reply.toString())
                }
            }
        }

        val core = CoreClient(ChannelInputStream(incoming), output, Closeable { incoming.cancel() }, scope) { disconnected.complete(it) }
        val params get() = JSONObject(rawHello).getJSONObject("params")
        fun frame(payload: String) { incoming.trySend(Wire.encode(0, Wire.DATA, payload.toByteArray())) }
        fun fail(cause: Throwable) { incoming.close(cause) }
        fun close() { core.close(); scope.cancel() }
    }

    private fun withChat(bridge: Bridge, requested: List<String> = ChatClient.MEMORY, test: suspend (ChatClient) -> Unit) = runBlocking {
        try { withTimeout(10_000) { test(ChatClient.start(bridge.core, requested)) } }
        finally { bridge.close() }
    }

    @Test fun ordinaryHelloOmitsManageEvenIfTheBridgeOffersIt() {
        val bridge = Bridge(JSONArray(ChatClient.MEMORY))
        withChat(bridge, emptyList()) { chat ->
            assertEquals(setOf("framed", "generation"), bridge.params.keys().asSequence().toSet())
            assertEquals(true, bridge.params.get("framed"))
            assertEquals(1, bridge.params.get("generation"))
            assertTrue(chat.manage.isEmpty())
        }
    }

    @Test fun coreHelloOmitsAnExplicitEmptyArray() = runBlocking {
        val bridge = Bridge()
        try {
            withTimeout(10_000) { bridge.core.start(JSONArray()) }
            assertFalse(bridge.params.has("manage"))
        } finally { bridge.close() }
    }

    @Test fun memoryHelloKeepsOnlyKnownRequestedAndGrantedNames() {
        val bridge = Bridge(JSONArray(listOf("memory.read", "memory.edit", "memory.delete")))
        withChat(bridge, ChatClient.MEMORY + "memory.delete") { chat ->
            val params = bridge.params
            assertEquals(setOf("framed", "generation", "manage"), params.keys().asSequence().toSet())
            assertEquals(true, params.get("framed"))
            assertEquals(1, params.get("generation"))
            val array = params.getJSONArray("manage")
            assertEquals(ChatClient.MEMORY, (0 until array.length()).map(array::getString))
            assertEquals(setOf("memory.read", "memory.edit"), chat.manage)
            assertLocalRefusal(chat.memoryAdd("dsh:lead", "a fact"))
            assertTrue(bridge.requests.isEmpty())
        }
        val excess = Bridge(JSONArray(ChatClient.MEMORY))
        withChat(excess, listOf("memory.read")) { assertEquals(setOf("memory.read"), it.manage) }
    }

    @Test fun missingReadMalformedOffersAndOldBridgesGrantNothing() {
        for (offer in listOf(null, JSONArray(listOf("memory.add")), "memory.read",
            JSONArray(listOf("memory.read", 1)), JSONArray(listOf("memory.read", JSONObject.NULL)))) {
            val bridge = Bridge(offer)
            withChat(bridge) { chat ->
                assertTrue(chat.manage.isEmpty())
                assertLocalRefusal(chat.memoryRead("dsh:lead"))
                assertLocalRefusal(chat.memoryEdit("dsh:lead", "id", "rev", "a fact"))
                assertLocalRefusal(chat.memoryAdd("dsh:lead", "a fact"))
                assertTrue(bridge.requests.isEmpty())
            }
        }
    }

    private fun assertLocalRefusal(reply: JSONObject) {
        assertEquals(3, reply.length())
        assertEquals(false, reply.get("ok"))
        assertEquals("refused", reply.getString("state"))
        assertEquals("read-only", reply.getString("reason"))
    }

    @Test fun memoryCallsSendExactParamsAndRefuseOtherTerminalsLocally() {
        val bridge = Bridge(JSONArray(ChatClient.MEMORY))
        withChat(bridge) { chat ->
            assertLocalRefusal(chat.memoryRead("t3"))
            assertLocalRefusal(chat.memoryAdd("t3", "a fact"))
            assertLocalRefusal(chat.memoryEdit("t3", "id", "rev", "a fact"))
            assertTrue(bridge.requests.isEmpty())
            chat.memoryRead("dsh:lead")
            chat.memoryEdit("dsh:lead", " id:+/ ", "rev-Aa!", " Edited ")
            chat.memoryAdd("dsh:lead", "A fact")
            assertEquals(ChatClient.MEMORY, bridge.requests.map { it.getString("method") })
            val expected = listOf(mapOf("terminal" to "dsh:lead"),
                mapOf("terminal" to "dsh:lead", "id" to " id:+/ ", "rev" to "rev-Aa!", "text" to " Edited "),
                mapOf("terminal" to "dsh:lead", "text" to "A fact"))
            for ((request, fields) in bridge.requests.zip(expected)) {
                val p = request.getJSONObject("params")
                assertEquals(fields.keys, p.keys().asSequence().toSet())
                for ((key, value) in fields) assertEquals(value, p.get(key))
            }
        }
    }

    @Test fun onlyStringErrorKindsProduceCoreErrorAndTheMessageStaysTheSame() {
        val bridge = Bridge(JSONArray(ChatClient.MEMORY)) { request ->
            if (request.getJSONObject("params").getString("terminal") == "dsh:other") {
                return@Bridge JSONObject().put("result", JSONObject().put("ok", true).put("state", "read"))
            }
            val error = JSONObject().put("message", "Request failed")
            when (request.getString("method")) {
                "memory.read" -> error.put("data", JSONObject().put("kind", "busy"))
                "memory.edit" -> error.put("data", JSONObject().put("kind", 2))
            }
            JSONObject().put("error", error)
        }
        withChat(bridge) { chat ->
            val busy = runCatching { chat.memoryRead("dsh:lead") }.exceptionOrNull()
            assertEquals("busy", (busy as? CoreError)?.kind)
            assertEquals("Request failed", busy?.message)
            val plain = listOf(runCatching { chat.memoryAdd("dsh:lead", "A fact") }.exceptionOrNull(),
                runCatching { chat.memoryEdit("dsh:lead", "id", "rev", "A fact") }.exceptionOrNull())
            for (error in plain) {
                assertEquals(IllegalStateException::class.java, error?.javaClass)
                assertEquals("Request failed", error?.message)
            }
            val next = chat.memoryRead("dsh:other")
            assertEquals(true, next.get("ok"))
            assertEquals("read", next.getString("state"))
        }
    }

    @Test fun malformedHelloAndFrameErrorsDoNotExposeThePayload() = runBlocking {
        val marker = "MEMORY_PAYLOAD_MARKER"
        val malformed = "{\"marker\":\"$marker\""
        for (line in listOf(malformed, JSONObject().put("result", marker).toString())) {
            val badHello = Bridge(helloLine = line)
            try {
                val error = runCatching { withTimeout(10_000) { ChatClient.start(badHello.core) } }.exceptionOrNull()
                assertEquals("Invalid hello from the computer", error?.message)
                // Coroutine stack-trace recovery may wrap a copy of the same error; no link may carry the payload.
                assertTrue(generateSequence(error) { it.cause }.none { marker in it.toString() })
            } finally { badHello.close() }
        }
        val badFrame = Bridge()
        withChat(badFrame) {
            badFrame.frame(malformed)
            assertEquals("Invalid message from the computer", badFrame.disconnected.await())
        }
        val wrapped = Bridge()
        withChat(wrapped) {
            wrapped.fail(JSONException(marker))
            assertEquals("Invalid message from the computer", wrapped.disconnected.await())
        }
    }
}
