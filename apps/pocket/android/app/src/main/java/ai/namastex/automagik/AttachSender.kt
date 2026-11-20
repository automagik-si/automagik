package ai.namastex.automagik

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

internal enum class Phase { UPLOADING, SENDING, SENT, QUEUED, STOPPED, CANCELLED, MAYBE, REFUSED }
internal enum class AttachAction { RETRY, SEND_AGAIN, NONE }

internal data class ImageMessage(
    val id: String, val caption: String, val images: List<Prepared>, val anchor: String?, val watchToken: Long,
    val count: Int = images.size, val continuity: Boolean = true, val phase: Phase = Phase.UPLOADING,
    val uploads: List<String> = emptyList(), val progress: Float = 0f, val done: Int = 0,
    val reason: String = "", val code: String = "", val sendWritten: Boolean = false,
    val uncertain: Boolean = false, val action: AttachAction = AttachAction.NONE
) {
    val active get() = phase == Phase.UPLOADING || phase == Phase.SENDING
    val heldBytes get() = images.sumOf { it.heldBytes }
}

/** An attempt owns every id it may have opened, up to the point it can write chat.send. */
internal class Attempt(val token: Long, initial: Phase = Phase.UPLOADING) {
    val phase = AtomicReference(initial)
    val lock = Any()
    val opened = LinkedHashSet<String>()
    val admitted = ArrayList<String>()
    var beginInFlight: CompletableDeferred<Unit>? = null
    var cleaned = false
    var sendWritten = initial == Phase.SENDING
    val cleanupDone = CompletableDeferred<Unit>()

    fun cancel() = synchronized(lock) { phase.compareAndSet(Phase.UPLOADING, Phase.CANCELLED) }
}

internal class AttachSender(
    private val link: ChatLink, private val terminal: String, private val offer: Attach.Offer,
    private val attempt: Attempt, private val live: (Long) -> Boolean,
    private val publish: ((ImageMessage) -> ImageMessage) -> Unit
) {
    private fun uploading() = attempt.phase.get() == Phase.UPLOADING && live(attempt.token)

    suspend fun upload(message: ImageMessage) {
        val total = message.images.sumOf { it.bytes.size }
        var acked = 0
        val failure = try {
            var stopped: Failure? = null
            for (image in message.images) {
                stopped = uploadImage(image) { n ->
                    acked += n
                    publish { it.copy(progress = acked.toFloat() / total) }
                }
                if (stopped != null) break
                publish { it.copy(done = attempt.admitted.size) }
            }
            if (stopped == null && synchronized(attempt.lock) {
                    uploading() && attempt.phase.compareAndSet(Phase.UPLOADING, Phase.SENDING)
                }) {
                val sending = message.copy(uploads = attempt.admitted.toList(), phase = Phase.SENDING)
                publish { it.copy(phase = Phase.SENDING, uploads = sending.uploads) }
                send(sending, fresh = true)
                return
            }
            stopped ?: Failure("offline")
        } catch (e: CancellationException) {
            withContext(NonCancellable) { cleanup() }
            throw e
        }
        cleanup()
        if (attempt.phase.compareAndSet(Phase.UPLOADING, Phase.STOPPED))
            publish { it.copy(phase = Phase.STOPPED, reason = failure.reason, code = failure.code, action = AttachAction.RETRY) }
    }

    private suspend fun uploadImage(image: Prepared, ack: (Int) -> Unit): Failure? {
        val begun = busy<Begin>(30_000, { it.reply }) {
            val id = UUID.randomUUID().toString()
            val inFlight = synchronized(attempt.lock) {
                if (!uploading()) return@busy Begin(id, offline())
                attempt.opened += id
                CompletableDeferred<Unit>().also { attempt.beginInFlight = it }
            }
            try {
                Begin(id, request { link.attachBegin(terminal, id, image.mediaType, image.bytes.size) })
            } finally {
                synchronized(attempt.lock) { attempt.beginInFlight = null }
                inFlight.complete(Unit)
            }
        } ?: return Failure("busy")
        if (!uploading()) return Failure("offline")
        val id = begun.id
        if (!Attach.opened(begun.reply, id)) return failure(begun.reply)

        var offset = 0
        while (offset < image.bytes.size) {
            val end = Attach.chunkEnd(offset, image.bytes.size, offer)
            val chunk = image.bytes.copyOfRange(offset, end)
            val reply = busy<JSONObject>(25_000, { it }) {
                if (uploading()) request { link.attachChunk(terminal, id, offset, chunk) } else offline()
            } ?: return Failure("busy")
            if (!uploading()) return Failure("offline")
            if (!Attach.received(reply, end)) return failure(reply)
            ack(end - offset)
            offset = end
        }

        if (!uploading()) return Failure("offline")
        val finish = request { link.attachFinish(terminal, id) }
        if (!uploading()) return Failure("offline")
        if (!Attach.admitted(finish, id, image.bytes.size, offer)) return failure(finish)
        attempt.admitted += id
        return null
    }

    suspend fun send(message: ImageMessage, fresh: Boolean = false) {
        // Publish before the final watch check, so even a synchronous state observer cannot move
        // the chat between this check and issuing the request.
        if (fresh) publish { it.copy(sendWritten = true) }
        val canWrite = synchronized(attempt.lock) {
            (attempt.phase.get() == Phase.SENDING && live(attempt.token)).also { if (it) attempt.sendWritten = true }
        }
        if (fresh && !canWrite) {
            cleanup()
            if (attempt.phase.compareAndSet(Phase.SENDING, Phase.STOPPED)) publish {
                it.copy(phase = Phase.STOPPED, reason = "offline", action = AttachAction.RETRY,
                    uploads = emptyList(), sendWritten = false)
            }
            return
        }
        val answer = if (canWrite) request { link.sendUploads(terminal, message.id, message.caption, message.uploads) }
            else offline()
        val outcome = outcome(message, answer)
        if (attempt.phase.compareAndSet(Phase.SENDING, outcome.phase)) {
            publish { current ->
                current.copy(phase = outcome.phase, reason = outcome.reason, code = outcome.code,
                    uncertain = outcome.uncertain, action = outcome.action,
                    images = if (outcome.phase == Phase.MAYBE || outcome.action != AttachAction.NONE) current.images else emptyList(),
                    uploads = if (outcome.uncertain || outcome.action == AttachAction.RETRY) current.uploads else emptyList())
            }
        }
    }

    suspend fun cleanup() {
        val work = synchronized(attempt.lock) {
            if (attempt.sendWritten) return
            if (attempt.cleaned) null else {
                attempt.cleaned = true
                attempt.opened.toList() to attempt.beginInFlight
            }
        }
        if (work == null) {
            attempt.cleanupDone.await()
            return
        }
        try {
            // Cancellation can race an on-the-wire begin. Let its reply arrive before cancelling that id.
            work.second?.await()
            for (id in work.first) request { link.attachCancel(terminal, id) }
        } finally {
            attempt.cleanupDone.complete(Unit)
        }
    }

    private suspend fun <T> busy(limit: Long, reply: (T) -> JSONObject, call: suspend () -> T): T? =
        withTimeoutOrNull(limit) {
            var pause = 250L
            var result = call()
            while (failure(reply(result)).reason == "busy" && uploading()) {
                delay(pause)
                pause = (pause * 2).coerceAtMost(2_000)
                result = call()
            }
            result
        }

    private data class Begin(val id: String, val reply: JSONObject)
    private data class Failure(val reason: String, val code: String = "")

    companion object {
        private val retryable = setOf("busy", "rate", "unavailable")

        private fun offline() = JSONObject().put("ok", false).put("state", "unknown").put("reason", "offline")

        private suspend fun request(call: suspend () -> JSONObject): JSONObject = try {
            call()
        } catch (_: TimeoutCancellationException) {
            offline()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            offline()
        }

        private fun failure(reply: JSONObject): Failure = when {
            reply.opt("ok") == false && reply.opt("state") == "refused" ->
                Failure(reply.optString("reason", "failed"), reply.optString("code", ""))
            reply.opt("ok") == false && reply.opt("state") == "unknown" -> Failure("offline")
            else -> Failure("failed")
        }

        internal data class Outcome(
            val phase: Phase, val action: AttachAction = AttachAction.NONE, val uncertain: Boolean = false,
            val reason: String = "", val code: String = ""
        )

        internal fun outcome(m: ImageMessage, a: JSONObject): Outcome {
            val maybe = Outcome(Phase.MAYBE, AttachAction.RETRY, uncertain = true)
            if (a.has("id") && a.opt("id") != m.id) return maybe
            val state = a.opt("state")
            if (a.opt("id") == m.id) {
                if (state == "sent") return Outcome(Phase.SENT)
                if (state == "queued") return Outcome(Phase.QUEUED)
            }
            if (state != "refused") return maybe
            val reason = a.optString("reason")
            val code = a.optString("code")
            if (m.uncertain) return maybe.copy(
                action = if (reason in retryable || reason == "offline") AttachAction.RETRY else AttachAction.SEND_AGAIN,
                reason = reason.ifBlank { "failed" }, code = code
            )
            if (reason == "offline") return maybe
            val action = when {
                reason in retryable -> AttachAction.RETRY
                reason == "expired" || reason == "session-changed" || (reason == "rejected" && code == "timeout") ->
                    AttachAction.SEND_AGAIN
                else -> AttachAction.NONE
            }
            return Outcome(Phase.REFUSED, action, reason = reason, code = code)
        }
    }
}
