package ai.namastex.automagik

import android.content.Context
import android.net.ConnectivityManager
import computer.iroh.Endpoint
import computer.iroh.EndpointOptions
import computer.iroh.EndpointTicket
import computer.iroh.IrohAndroid
import computer.iroh.SecretKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.net.URLDecoder

/** A link from Herdr desktop's Pocket Link mod: `herdr-pocket://pair?v=1&n=<desktop>&c=<one-time code>&t=<iroh ticket>`. */
data class PairingLink(val name: String, val code: String, val ticket: String) {
    companion object {
        private val TICKET = Regex("^endpoint[a-z2-7]{20,2000}$")
        private val CODE = Regex("^[A-Za-z0-9_-]{16,64}$")
        fun parse(text: String): PairingLink? {
            val uri = runCatching { URI(text.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "herdr-pocket" || uri.host != "pair") return null
            val query = uri.rawQuery?.split('&')?.mapNotNull { part ->
                val (k, v) = part.split('=', limit = 2).takeIf { it.size == 2 } ?: return@mapNotNull null
                k to runCatching { URLDecoder.decode(v, "UTF-8") }.getOrNull()
            }?.toMap().orEmpty()
            if (query["v"] != "1") return null
            val ticket = query["t"]?.takeIf { TICKET.matches(it) } ?: return null
            val code = query["c"]?.takeIf { CODE.matches(it) } ?: return null
            val name = query["n"].orEmpty().filterNot { it.isISOControl() }.take(60).ifBlank { "Herdr desktop" }
            return PairingLink(name, code, ticket)
        }
    }
}

/** A session to a paired desktop's herdr-core, as the byte streams CoreClient reads and writes. */
class IrohTransport(val input: InputStream, val output: OutputStream, private val onClose: () -> Unit) : Closeable {
    override fun close() = onClose()
}

/** This phone's iroh endpoint: one key for its life, kept in no-backup storage, which Android never backs up. */
object IrohLink {
    private val SESSION = "herdr-pocket/1".toByteArray()
    private val PAIR = "herdr-pocket/pair/1".toByteArray()
    /** Pocket Link's chat route (RFC 0015): an older bridge does not offer it. */
    val CHAT = "herdr-pocket/chat/1".toByteArray()
    private val lock = Mutex()
    private var endpoint: Endpoint? = null
    /** The network the endpoint was bound on, and connect timeouts in a row since ([Background.rebind]). */
    private var boundOn: String? = null
    private var timeouts = 0

    /** The phone's default network now, as a handle that changes when it moves (Wi-Fi to mobile, another Wi-Fi). */
    private fun network(context: Context): String? =
        runCatching { context.getSystemService(ConnectivityManager::class.java)?.activeNetwork?.toString() }.getOrNull()

    private suspend fun endpoint(context: Context, create: Boolean = false): Endpoint = lock.withLock {
        endpoint?.takeUnless { it.isClosed() } ?: run {
            IrohAndroid.installAndroidContext(context.applicationContext)
            val key = PhoneKey.load(context.noBackupFilesDir, Seal.sealer(), create) { SecretKey.generate().toBytes() }
            Endpoint.bind(EndpointOptions(secretKey = key, alpns = emptyList())).also { endpoint = it; boundOn = network(context); timeouts = 0 }
        }
    }

    /**
     * After a connect timed out: drops the endpoint when the network changed since its bind (one bound before a network
     * change can stay deaf after it), or every few timeouts in a row; an unreachable desktop alone keeps it.
     */
    private suspend fun timedOut(context: Context, stale: Endpoint) = lock.withLock {
        if (endpoint === stale && Background.rebind(boundOn, network(context), ++timeouts)) { endpoint = null; runCatching { stale.close() } }
    }

    /** The desktop a ticket names, as a stable id for "is this the same machine". */
    fun desktopId(ticket: String): String = EndpointTicket.fromString(ticket).endpointAddr().id().toString()

    /** Pairs this phone with the desktop that made [link]; returns the desktop's name. */
    suspend fun pair(context: Context, link: PairingLink, device: String): String {
        val ep = endpoint(context, create = true)
        val conn = withTimeout(30_000) { ep.connect(EndpointTicket.fromString(link.ticket).endpointAddr(), PAIR) }
        try {
            val bi = conn.openBi()
            bi.send().writeAll((JSONObject().put("code", link.code).put("device", device).toString() + "\n").toByteArray())
            val reply = JSONObject(readLine(bi.recv()::read))
            check(reply.optBoolean("ok")) { reply.optString("error").ifBlank { "The desktop refused this phone." } }
            return reply.optString("name").ifBlank { link.name }
        } finally { runCatching { conn.close(0, byteArrayOf()) } }
    }

    /** Opens a session to a paired desktop's core; [scope] carries the stream pumps and ends with the connection. */
    suspend fun open(context: Context, ticket: String, session: String, scope: CoroutineScope, alpn: ByteArray = SESSION): IrohTransport {
        val ep = endpoint(context)
        val conn = try { withTimeout(30_000) { ep.connect(EndpointTicket.fromString(ticket).endpointAddr(), alpn) } }
            catch (e: TimeoutCancellationException) { timedOut(context, ep); throw e }
        lock.withLock { timeouts = 0 }
        val bi = conn.openBi()
        val send = bi.send(); val recv = bi.recv()
        send.writeAll((JSONObject().put("session", session).toString() + "\n").toByteArray())
        val incoming = Channel<ByteArray>(64)
        val outgoing = Channel<ByteArray>(Channel.UNLIMITED)
        scope.launch(Dispatchers.IO) {
            try {
                while (true) {
                    val chunk = recv.read(65536u)
                    if (chunk.isEmpty()) break
                    incoming.send(chunk)
                }
            } catch (e: Exception) {
                incoming.close(IllegalStateException(refusal(conn.closeReason()) ?: (e.message ?: "Connection lost")))
                return@launch
            }
            incoming.close()
        }
        scope.launch(Dispatchers.IO) { runCatching { for (chunk in outgoing) send.writeAll(chunk) } }
        val output = object : OutputStream() {
            override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
            override fun write(b: ByteArray, off: Int, len: Int) {
                check(outgoing.trySend(b.copyOfRange(off, off + len)).isSuccess) { "Disconnected" }
            }
        }
        return IrohTransport(ChannelInputStream(incoming), output) {
            outgoing.close(); incoming.cancel()
            runCatching { conn.close(0, byteArrayOf()) }
        }
    }

    // The bridge closes with "not paired" when the desktop forgot this phone.
    private fun refusal(reason: String?) = if (reason?.contains("not paired") == true)
        "This phone isn’t paired with the desktop anymore. Pair it again from Pocket Link." else null

    private suspend fun readLine(read: suspend (UInt) -> ByteArray): String {
        val buf = java.io.ByteArrayOutputStream()
        while (true) {
            val chunk = read(4096u)
            if (chunk.isEmpty()) break
            buf.write(chunk)
            check(buf.size() <= 4096) { "The desktop sent too much" }
            if (chunk.contains(10)) break
        }
        return buf.toString("UTF-8").substringBefore('\n')
    }
}

/** Bytes from a channel as a blocking stream; -1 once the channel closes, its error once it fails. */
class ChannelInputStream(private val chunks: ReceiveChannel<ByteArray>) : InputStream() {
    private var current = ByteArray(0)
    private var position = 0
    override fun read(): Int {
        val one = ByteArray(1)
        return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
    }
    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (len == 0) return 0
        while (position >= current.size) {
            val next = runBlocking { chunks.receiveCatching() }
            next.exceptionOrNull()?.let { throw java.io.IOException(it.message, it) }
            current = next.getOrNull() ?: return -1
            position = 0
        }
        val n = minOf(len, current.size - position)
        System.arraycopy(current, position, b, off, n)
        position += n
        return n
    }
}
