package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64
import kotlin.math.sqrt

/** The negotiated Pocket Link attachment contract. No Android state or image processing. */
object Attach {
    const val METHOD_BEGIN = "chat.attach"
    const val METHOD_CHUNK = "chat.attachChunk"
    const val METHOD_FINISH = "chat.attachFinish"
    const val METHOD_CANCEL = "chat.attachCancel"
    const val METHOD_READ = "chat.attachmentRead"
    const val METHOD_SEND = "chat.send"
    val METHODS = setOf(METHOD_BEGIN, METHOD_CHUNK, METHOD_FINISH, METHOD_CANCEL, METHOD_READ)
    const val CHUNK_BYTES = 24_576
    const val FINISH_TIMEOUT_MS = 80_000L
    const val PEAK_PIXELS = 16_777_216L
    const val HELD_BYTES = 32L * 1024 * 1024
    const val HELD_MESSAGES = 4
    const val PNG = "image/png"
    const val JPEG = "image/jpeg"
    const val WEBP = "image/webp"
    const val GIF = "image/gif"
    private const val SAFE_INTEGER = 9_007_199_254_740_991L
    private val uploadTypes = setOf(PNG, JPEG, WEBP)
    internal val readTypes = uploadTypes + GIF
    const val READ_ONLY_APP = "Read only on the phone: the Automagik app on this computer takes no phone writes. Update it, or ${Chat.ANSWER_ON_COMPUTER}."

    sealed interface Peer {
        data object NotAsked : Peer
        data object Missing : Peer
        data object App : Peer
        data object None : Peer
        data object Unusable : Peer
        data class Offered(val offer: Offer) : Peer
    }

    data class Offer(
        val mediaTypes: Set<String>, val fileBytes: Int, val files: Int, val messageBytes: Int,
        val maxPixels: Long, val maxDimension: Long, val chunkBytes: Int, val thumbnail: Thumbnail
    )
    data class Thumbnail(val edge: Int, val bytes: Int)

    internal fun int(j: JSONObject, key: String): Long? = nonNegativeInt(j, key)?.takeIf { it > 0 }

    private fun nonNegativeInt(j: JSONObject, key: String): Long? = when (val v = j.opt(key)) {
        is Int -> v.toLong()
        is Long -> v
        else -> null
    }?.takeIf { it in 0..SAFE_INTEGER }

    private fun JSONArray.values() = (0 until length()).map { opt(it) }

    fun peer(hello: JSONObject): Peer {
        if (!hello.has("attachments")) return Peer.Missing
        val a = hello.optJSONObject("attachments") ?: return Peer.Unusable
        if (int(a, "version") != 1L) return Peer.Unusable
        if (a.has("unavailable")) return when (a.opt("unavailable")) {
            "app" -> Peer.App
            "none" -> Peer.None
            else -> Peer.Unusable
        }
        if (a.optJSONArray("methods")?.values()?.containsAll(METHODS) != true ||
            hello.optJSONArray("methods")?.values()?.containsAll(METHODS) != true) return Peer.Unusable
        val types = a.optJSONArray("mediaTypes")?.values() ?: return Peer.Unusable
        if (types.isEmpty() || types.any { it !is String || it !in uploadTypes } || types.distinct().size != types.size) return Peer.Unusable
        val l = a.optJSONObject("limits") ?: return Peer.Unusable
        val file = int(l, "fileBytes")?.takeIf { it in 1..8_388_608 } ?: return Peer.Unusable
        val files = int(l, "files")?.takeIf { it in 1..4 } ?: return Peer.Unusable
        val total = int(l, "messageBytes")?.takeIf { it in file..16_777_216 } ?: return Peer.Unusable
        val pixels = int(l, "maxPixels")?.takeIf { it in 1..40_000_000 } ?: return Peer.Unusable
        val dimension = int(l, "maxDimension") ?: return Peer.Unusable
        if (int(l, "chunkBytes") != CHUNK_BYTES.toLong() || int(l, "deviceOutstanding") != HELD_BYTES ||
            int(l, "deviceDailyBytes") != 268_435_456L || int(l, "deviceDailyCount") != 128L) return Peer.Unusable
        val t = l.optJSONObject("thumbnail") ?: return Peer.Unusable
        val edge = int(t, "edge")?.takeIf { it in 1..512 } ?: return Peer.Unusable
        val bytes = int(t, "bytes")?.takeIf { it in 1..131_072 } ?: return Peer.Unusable
        return Peer.Offered(Offer(types.filterIsInstance<String>().toSet(), file.toInt(), files.toInt(), total.toInt(),
            pixels, dimension, CHUNK_BYTES, Thumbnail(edge.toInt(), bytes.toInt())))
    }

    fun usable(peer: Peer, dshWrite: Boolean, terminal: String, subscribed: Boolean) =
        peer is Peer.Offered && dshWrite && Chat.isDsh(terminal) && !Chat.isGroup(terminal) && subscribed

    internal fun refusedLocal(): JSONObject =
        JSONObject().put("ok", false).put("state", "refused").put("reason", "read-only")

    internal fun uploadParams(terminal: String, upload: String): JSONObject =
        JSONObject().put("terminal", terminal).put("upload", upload)

    internal fun beginParams(terminal: String, upload: String, mediaType: String, bytes: Int): JSONObject =
        uploadParams(terminal, upload).put("mediaType", mediaType).put("bytes", bytes)

    internal fun chunkParams(terminal: String, upload: String, offset: Int, data: ByteArray): JSONObject =
        uploadParams(terminal, upload).put("offset", offset).put("data", Base64.getEncoder().encodeToString(data))

    internal fun readParams(terminal: String, row: String, block: Int): JSONObject =
        JSONObject().put("terminal", terminal).put("row", canonicalRow(row)).put("block", block)

    internal fun sendParams(terminal: String, id: String, text: String, uploads: List<String>): JSONObject =
        JSONObject().put("terminal", terminal).put("id", id).put("uploads", JSONArray(uploads)).apply {
            if (text.isNotBlank()) put("text", text)
        }

    internal fun opened(a: JSONObject, upload: String) = a.opt("ok") == true && a.opt("state") == "open" &&
        a.opt("upload") == upload && int(a, "chunkBytes") == CHUNK_BYTES.toLong()

    internal fun received(a: JSONObject, end: Int) = a.opt("ok") == true && int(a, "received") == end.toLong()

    internal fun admitted(a: JSONObject, upload: String, length: Int, offer: Offer): Boolean {
        val image = a.optJSONObject("image") ?: return false
        if (int(image, "width") == null || int(image, "height") == null) return false
        val type = image.opt("mediaType") as? String ?: return false
        return a.opt("ok") == true && a.opt("state") == "admitted" && a.opt("upload") == upload &&
            type in offer.mediaTypes && int(image, "bytes") == length.toLong() && int(image, "stored") != null
    }

    internal fun fits(offer: Offer, type: String, bytes: Int, w: Int, h: Int) =
        type in offer.mediaTypes && bytes in 1..offer.fileBytes && w > 0 && h > 0 &&
            w <= offer.maxDimension && h <= offer.maxDimension && w.toLong() * h <= offer.maxPixels

    internal fun chunkEnd(offset: Int, size: Int, offer: Offer) = minOf(size, offset + offer.chunkBytes)

    sealed interface Block {
        data class Text(val text: String) : Block
        data class Image(val block: Int, val mediaType: String, val width: Long, val height: Long) : Block
        data class File(val block: Long, val bytes: Long, val name: String?) : Block
        data class More(val count: Long) : Block
    }

    fun blocks(value: Any?): List<Block>? = (value as? JSONArray)?.values()?.mapNotNull { item ->
        val j = item as? JSONObject ?: return@mapNotNull null
        when (j.opt("type")) {
            "text" -> (j.opt("text") as? String)?.let { Block.Text(it) }
            "image" -> {
                val index = nonNegativeInt(j, "block")?.takeIf { it <= Int.MAX_VALUE } ?: return@mapNotNull null
                val type = (j.opt("mediaType") as? String)?.takeIf { it in readTypes } ?: return@mapNotNull null
                val w = int(j, "width") ?: return@mapNotNull null
                val h = int(j, "height") ?: return@mapNotNull null
                Block.Image(index.toInt(), type, w, h)
            }
            "file" -> {
                val index = nonNegativeInt(j, "block") ?: return@mapNotNull null
                val bytes = nonNegativeInt(j, "bytes") ?: return@mapNotNull null
                val name = (j.opt("name") as? String)?.let { ChatText.clean(it).trim() }
                    ?.takeUnless { it.isEmpty() || it == "." || it == ".." }
                Block.File(index, bytes, name)
            }
            "more" -> int(j, "count")?.let { Block.More(it) }
            else -> null
        }
    }

    fun renderable(blocks: List<Block>) = blocks.filterNot { it is Block.Text && ChatText.clean(it.text).isBlank() }
    fun canonicalRow(id: String) = id.substringBefore('#')
    fun sessionOf(id: String): String? {
        if (!Chat.isDsh(id)) return null
        val body = canonicalRow(id).removePrefix(Chat.DSH_PREFIX)
        val end = body.lastIndexOf(':')
        if (end <= 0 || end == body.lastIndex || body.substring(end + 1).any { it !in '0'..'9' }) return null
        return body.substring(0, end)
    }

    fun partWords(peer: Peer): String = when (peer) {
        Peer.NotAsked, Peer.Missing -> "Images need a newer Pocket Link on this computer. Update it, then reconnect."
        Peer.App -> "Images need a newer Automagik app on this computer. Update it, then reconnect."
        Peer.None -> "Images aren't available on this connection. Update Pocket Link and the Automagik app on this computer, then reconnect."
        Peer.Unusable -> "Images aren't available: update Pocket and Pocket Link on this computer."
        is Peer.Offered -> "Wait for the chat to connect."
    }

    internal fun words(reason: String, code: String = ""): String = when (reason) {
        "unsupported" -> "the computer couldn't read this image"
        "too-large" -> "too large for the computer"
        "rejected" -> when (code) {
            "UNSUPPORTED_IMAGE_TYPE", "INVALID_IMAGE" -> words("unsupported")
            "IMAGE_TOO_LARGE", "IMAGE_TOO_MANY_PIXELS", "IMAGE_DIMENSION_TOO_LARGE" -> words("too-large")
            "timeout" -> "the computer took too long to take the image"
            "MODEL_DOES_NOT_SUPPORT_IMAGES" -> "this Bot's model can't read images"
            else -> "the computer refused this image"
        }
        "quota" -> "the computer takes no more images now (daily limit or low disk); try later"
        "busy" -> "the computer is busy with another image"
        "rate" -> "too many requests; wait a moment"
        "expired" -> "the images expired on the computer"
        "session-changed" -> "this Bot started a new chat on the computer"
        "not-shown" -> "show this project in Automagik first"
        "not-watching" -> "this chat moved on; reopen it"
        "revoked" -> "the chat closed; reconnect"
        "offline" -> "the computer didn't answer"
        else -> "the computer couldn't take it"
    }

    internal fun readWords(reason: String) = when (reason) {
        "not-found" -> "This image is no longer on the computer."
        "too-large" -> "Too large to preview."
        "rate" -> "Too many loads. Wait a moment."
        "busy", "unavailable", "failed", "offline" -> "Couldn't load. Tap Show to try again."
        "not-watching", "revoked", "not-shown" -> words(reason)
        else -> "Can't preview this image"
    }

    internal data class Plan(val width: Int, val height: Int, val sample: Int)

    internal fun plan(w: Int, h: Int, maxDimension: Long, maxPixels: Long, peak: Long = PEAK_PIXELS): Plan? {
        if (w <= 0 || h <= 0 || maxDimension <= 0 || maxPixels <= 0) return null
        val width = w.toLong()
        val height = h.toLong()
        val edge = minOf(2048L, maxDimension)
        val pixels = minOf(maxPixels, 2048L * 2048)
        val scale = minOf(1.0, edge.toDouble() / maxOf(width, height), sqrt(pixels.toDouble() / (width * height)))
        var outW = (width * scale).toLong().coerceIn(1, edge)
        var outH = (height * scale).toLong().coerceIn(1, edge)
        while (outW * outH > pixels) {
            if (outW >= outH) outW-- else outH--
        }
        fun sampled(side: Long, sample: Long) = (side + sample - 1) / sample
        var sample = 1L
        while (sample * 2 <= maxOf(width, height) &&
            sampled(width, sample * 2) >= outW && sampled(height, sample * 2) >= outH) sample *= 2
        while (sampled(width, sample) * sampled(height, sample) + outW * outH > peak) {
            sample *= 2
            outW = minOf(outW, sampled(width, sample))
            outH = minOf(outH, sampled(height, sample))
        }
        return Plan(outW.toInt(), outH.toInt(), sample.toInt())
    }

    internal enum class Kind { PNG, JPEG, WEBP, WEBP_LOSSY, WEBP_LOSSLESS }
    internal data class Encoding(val mediaType: String, val kind: Kind, val quality: Int, val lossy: Boolean)

    internal fun encoding(mediaTypes: Set<String>, alpha: Boolean, sdk: Int): Encoding = when {
        alpha && PNG in mediaTypes -> Encoding(PNG, Kind.PNG, 100, false)
        !alpha && JPEG in mediaTypes -> Encoding(JPEG, Kind.JPEG, 90, true)
        WEBP in mediaTypes && alpha && sdk >= 30 -> Encoding(WEBP, Kind.WEBP_LOSSLESS, 100, false)
        WEBP in mediaTypes && alpha -> Encoding(WEBP, Kind.WEBP, 100, sdk < 29)
        WEBP in mediaTypes -> Encoding(WEBP, if (sdk >= 30) Kind.WEBP_LOSSY else Kind.WEBP, 90, true)
        JPEG in mediaTypes -> Encoding(JPEG, Kind.JPEG, 90, true)
        else -> Encoding(PNG, Kind.PNG, 100, false)
    }
}
