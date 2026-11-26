package ai.namastex.automagik

import android.graphics.Bitmap
import android.net.Uri
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.util.Base64

internal fun attachSnapshot(vararg rows: JSONObject) =
    JSONObject().put("type", "snapshot").put("reset", true).put("rows", JSONArray(rows.toList()))

internal fun attachRow(id: String, text: String = "") = JSONObject().put("id", id)
    .put("kind", "text").put("role", "user").put("text", text)

internal fun fakePrepared(uri: Uri, size: Int = 4, preview: Bitmap? = null) =
    Prepared(uri.toString(), uri.toString(), Attach.PNG, ByteArray(size), 1, 1, preview)

internal fun thumbnailReply(): JSONObject {
    val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
    val png = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    bitmap.recycle()
    return JSONObject().put("ok", true).put("mediaType", Attach.PNG).put("width", 2).put("height", 2)
        .put("data", Base64.getEncoder().encodeToString(png))
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachSessionTest {
    private class Run(scope: TestScope, offer: Attach.Offer = testOffer()) {
        var ref = TerminalRef("box", "dsh:bot")
        var chat = Chat.State(ref.address, connected = true, dshWrite = true)
        var link = AttachTestLink(Attach.Peer.Offered(offer))
        var gen = 1
        val notices = mutableListOf<String>()
        var preparer: suspend (Uri, Attach.Offer) -> Prepared = { uri, _ -> fakePrepared(uri) }
        private val lane = StandardTestDispatcher(scope.testScheduler)
        val session = AttachSession(scope.backgroundScope, { chat }, { ref }, { false }, { link }, { notices += it },
            { uri, o -> preparer(uri, o) }, io = lane, preparation = lane)
        val state get() = session.state.value
        val message get() = state.messages.single()

        init { session.linkOpened(gen, link.attach) }
        fun snapshot(vararg rows: JSONObject): Long {
            val token = session.watchStarted(gen)
            event(token, attachSnapshot(*rows))
            return token
        }
        fun watch(sessionId: String? = "a") =
            if (sessionId == null) snapshot() else snapshot(attachRow("dsh:$sessionId:1"))

        fun event(token: Long, e: JSONObject) {
            session.event(token, e)
            chat = Chat.reduce(chat, e)
        }

        fun pick(count: Int = 1) {
            assertNotNull(session.pick())
            session.picked((1..count).map { Uri.parse("content://picture/$it") })
        }

        fun reconnect(new: AttachTestLink, sessionId: String? = "a") {
            session.linkClosed(gen)
            session.closed(keep = true, gen = gen++)
            link = new
            session.linkOpened(gen, link.attach)
            watch(sessionId)
        }
    }

    @Test fun slowResubscribeStopsTheOldAttemptAndOnlySameSessionCanRetry() = runTest {
        for ((old, replacement) in listOf("a" to "a", "a" to "b", null to "a", "a" to null)) {
            val r = Run(this)
            val first = r.watch(old)
            r.pick(); runCurrent()
            val blocked = CompletableDeferred<Unit>()
            r.link.begin = { blocked.await(); r.link.open(it) }
            assertEquals(Submit.Accepted, r.session.submit("caption"))
            runCurrent()
            val original = r.message.id
            val firstBegin = r.link.calls.single()
            r.session.watchEnded(first)
            r.watch(replacement)
            blocked.complete(Unit)
            runCurrent()
            assertEquals(listOf("begin", "cancel"), r.link.calls.map { it.kind })
            assertEquals(Phase.STOPPED, r.message.phase)
            val same = old != null && old == replacement
            assertEquals(if (same) AttachAction.RETRY else AttachAction.SEND_AGAIN, r.session.action(r.message, r.state))
            assertEquals(!same, r.session.stoppedAfterMove(r.message))
            r.session.retry(original)
            runCurrent()
            assertEquals(if (same) original else r.message.id, r.link.calls.last().id)
            if (!same) assertNotEquals(original, r.message.id)
            assertNotEquals(firstBegin.id, r.link.calls.filter { it.kind == "begin" }.last().id)
        }
    }

    @Test fun goneMoveAndLossSynchronouslyKillWritesUntilTheNewWatchIsReady() = runTest {
        val r = Run(this)
        val token = r.watch()
        r.pick(); runCurrent()
        val ack = CompletableDeferred<JSONObject>()
        r.link.chunk = { _, _, _ -> ack.await() }
        r.session.submit("caption")
        runCurrent()
        r.session.linkClosed(1)
        assertFalse(r.session.live(token))
        r.session.event(token, attachSnapshot(attachRow("dsh:a:2")))
        assertFalse(r.session.watchReady())
        ack.complete(JSONObject().put("ok", true).put("received", 4))
        runCurrent()
        assertEquals(listOf("begin", "chunk", "cancel"), r.link.calls.map { it.kind })
        assertEquals(Phase.STOPPED, r.message.phase)

        val other = Run(this)
        val live = other.watch()
        other.pick(); runCurrent()
        other.session.event(live, JSONObject().put("type", "gone").put("reason", "moved"))
        assertFalse(other.session.live(live))
        assertTrue(other.session.submit("caption") is Submit.Refused)
        assertTrue(other.link.calls.isEmpty())
        assertEquals(1, other.state.draft.size)
    }

    @Test fun lostAckRetryUsesSameIdentityAndUncertaintySurvivesBusyAndSessionChanged() = runTest {
        val r = Run(this)
        r.watch()
        r.pick(2); runCurrent()
        r.link.sendImage = { JSONObject() }
        r.session.submit(" caption ")
        runCurrent()
        val first = r.link.calls.last()
        assertEquals(Phase.MAYBE, r.message.phase)

        val bridge = AttachTestLink(Attach.Peer.Offered(testOffer().copy(files = 1)))
        r.reconnect(bridge)
        bridge.sendImage = { attachRefusal("busy") }
        r.session.retry(first.id); runCurrent()
        assertEquals(listOf(first), bridge.calls)
        assertEquals(Phase.MAYBE, r.message.phase)
        assertTrue(r.message.uncertain)
        assertEquals("busy", r.message.reason)
        assertEquals(AttachAction.RETRY, r.message.action)

        bridge.sendImage = { attachRefusal("session-changed") }
        r.session.retry(first.id); runCurrent()
        assertEquals(listOf(first, first), bridge.calls)
        assertEquals(Phase.MAYBE, r.message.phase)
        assertEquals(AttachAction.SEND_AGAIN, r.message.action)
        r.session.retry(first.id); runCurrent()
        assertEquals(2, bridge.calls.size)

        val new = AttachTestLink()
        r.reconnect(new, "b")
        r.session.retry(first.id, confirmed = true); runCurrent()
        assertEquals(Phase.SENT, r.message.phase)
        assertNotEquals(first.id, new.calls.last().id)
        assertEquals(first.caption, new.calls.last().caption)
    }

    @Test fun imageOnlyRowsNeverSettleEvenWhenTwoMessagesSettleInReverseOrder() = runTest {
        val r = Run(this)
        val w = r.watch()
        r.link.sendImage = { JSONObject() }
        r.pick(); runCurrent()
        r.session.submit(""); runCurrent()
        r.pick(); runCurrent()
        r.session.submit(""); runCurrent()
        val first = r.link.calls.filter { it.kind == "send" }
        r.event(w, JSONObject().put("type", "rows").put("rows", JSONArray(listOf(attachRow("dsh:a:2"), attachRow("dsh:a:3")))))
        assertEquals(listOf(Phase.MAYBE, Phase.MAYBE), r.state.messages.map { it.phase })
        r.link.sendImage = { attachSuccess(it) }
        r.session.retry(first[1].id); runCurrent()
        assertEquals(listOf(Phase.MAYBE, Phase.SENT), r.state.messages.map { it.phase })
        r.session.retry(first[0].id); runCurrent()
        assertEquals(first.reversed(), r.link.calls.filter { it.kind == "send" }.takeLast(2))
        assertEquals(listOf(Phase.SENT, Phase.SENT), r.state.messages.map { it.phase })
    }

    @Test fun cancelCleansCurrentAndAdmittedIdsAndRestoresOnlyIntoAnEmptyComposer() = runTest {
        for (restore in listOf(true, false)) {
            val r = Run(this)
            r.watch()
            r.pick(2); runCurrent()
            val pending = CompletableDeferred<JSONObject>()
            r.link.chunk = { _, offset, data ->
                if (r.link.calls.count { it.kind == "begin" } == 2) pending.await()
                else JSONObject().put("ok", true).put("received", offset + data.size)
            }
            r.session.submit("caption"); runCurrent()
            val original = r.message
            assertEquals(1, original.done)
            assertEquals(restore, r.session.cancel(original.id, restore))
            runCurrent()
            val ids = r.link.calls.filter { it.kind == "begin" }.map { it.id }
            assertEquals(ids, r.link.calls.filter { it.kind == "cancel" }.map { it.id })
            pending.complete(JSONObject().put("ok", true).put("received", 4))
            runCurrent()
            assertTrue(r.link.calls.none { it.kind == "send" })
            if (restore) {
                assertEquals(original.images, r.state.draft)
                assertTrue(r.state.messages.isEmpty())
            } else {
                assertEquals(Phase.CANCELLED, r.message.phase)
                assertEquals(AttachAction.SEND_AGAIN, r.message.action)
                assertTrue(r.state.draft.isEmpty())
            }
        }
    }

    @Test fun cancelAfterSendingStartsIsIgnoredAndLateFinishAfterCancelIsDiscarded() = runTest {
        val r = Run(this)
        r.watch()
        r.pick(); runCurrent()
        val answer = CompletableDeferred<Unit>()
        r.link.sendImage = { answer.await(); attachSuccess(it) }
        r.session.submit(""); runCurrent()
        assertEquals(Phase.SENDING, r.message.phase)
        assertFalse(r.session.cancel(r.message.id, restore = true))
        answer.complete(Unit); runCurrent()
        assertEquals(Phase.SENT, r.message.phase)

        val stopped = Run(this)
        stopped.watch()
        stopped.pick(); runCurrent()
        val finish = CompletableDeferred<Unit>()
        stopped.link.finish = { finish.await(); stopped.link.admit(it) }
        stopped.session.submit(""); runCurrent()
        stopped.session.cancel(stopped.message.id, restore = false)
        finish.complete(Unit); runCurrent()
        assertEquals(Phase.CANCELLED, stopped.message.phase)
        assertEquals(listOf("begin", "chunk", "finish", "cancel"), stopped.link.calls.map { it.kind })
    }

    @Test fun aFreshAttemptWaitsForCancelCleanupButNotForALateFinishReply() = runTest {
        val r = Run(this)
        r.watch()
        val oldFinish = CompletableDeferred<Unit>()
        r.link.finish = {
            if (r.link.calls.count { call -> call.kind == "finish" } == 1) oldFinish.await()
            r.link.admit(it)
        }
        r.pick(); runCurrent()
        r.session.submit("caption"); runCurrent()
        val original = r.message
        r.session.cancel(original.id, restore = false)
        r.session.retry(original.id)
        runCurrent()
        assertEquals(listOf("begin", "chunk", "finish", "cancel", "begin", "chunk", "finish", "send"),
            r.link.calls.map { it.kind })
        assertEquals(Phase.SENT, r.message.phase)
        assertNotEquals(original.id, r.message.id)
        oldFinish.complete(Unit); runCurrent()
        assertEquals(1, r.link.calls.count { it.kind == "send" })
    }

    @Test fun reconnectReencodesCopiesThatNoLongerFitAndLimitsRefuseWithZeroWrites() = runTest {
        val r = Run(this)
        r.watch()
        r.preparer = { uri, offer -> fakePrepared(uri, size = minOf(20, offer.fileBytes)) }
        r.pick(2); runCurrent()
        val smaller = AttachTestLink(Attach.Peer.Offered(testOffer().copy(files = 1, fileBytes = 12, messageBytes = 12)))
        r.reconnect(smaller)
        runCurrent()
        assertEquals(listOf(12, 12), r.state.draft.map { it.bytes.size })
        assertEquals(Submit.Refused("Up to 1 images, 12 bytes each, 12 bytes in all."), r.session.submit("caption"))
        assertEquals(2, r.state.draft.size)
        assertTrue(smaller.calls.isEmpty())
        r.session.removeDraft(r.state.draft.last().key)
        assertEquals(Submit.Accepted, r.session.submit("caption"))
        runCurrent()
        assertEquals(Phase.SENT, r.message.phase)
    }

    @Test fun heldBudgetCountsPreviewsAndRemoveMakesRoomForAFifthMessage() = runTest {
        val r = Run(this)
        r.watch()
        r.preparer = { uri, _ -> fakePrepared(uri, 10_240, Bitmap.createBitmap(192, 192, Bitmap.Config.ARGB_8888)) }
        r.link.begin = { attachRefusal("quota") }
        repeat(4) {
            r.pick(4); runCurrent()
            assertEquals(Submit.Accepted, r.session.submit(""))
            runCurrent()
        }
        assertEquals(16L * (10_240 + 192 * 192 * 4), r.state.heldBytes)
        r.pick(); runCurrent()
        assertEquals(Submit.Refused("Remove a picture message above first."), r.session.submit(""))
        val msg = r.state.messages.first()
        val held = r.state.heldBytes
        r.session.removeMessage(msg.id)
        assertEquals(held - msg.heldBytes, r.state.heldBytes)
        assertEquals(Submit.Accepted, r.session.submit(""))
        runCurrent()
    }

    @Test fun excessPicksAreRefusedAndOldMaybePayloadsAreEvictedBeforeRetryIdentity() = runTest {
        val r = Run(this)
        r.watch()
        r.preparer = { uri, _ -> fakePrepared(uri, 8 * 1024 * 1024, Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)) }
        r.pick(4); runCurrent()
        assertEquals(3, r.state.draft.size)
        assertTrue(r.state.heldBytes <= Attach.HELD_BYTES)
        assertTrue(r.notices.last().contains("Too many pictures"))
        r.session.closed(keep = false, gen = 1)
        assertEquals(0L, r.state.heldBytes)

        val evicted = Run(this)
        evicted.watch()
        evicted.preparer = r.preparer
        evicted.link.sendImage = { JSONObject() }
        evicted.pick(1); runCurrent()
        evicted.session.submit(""); runCurrent()
        val original = evicted.message
        evicted.pick(3); runCurrent()
        assertTrue(evicted.message.images.isEmpty())
        assertEquals(original.uploads, evicted.message.uploads)
        assertTrue(evicted.state.heldBytes <= Attach.HELD_BYTES)
    }

    @Test fun picksReserveSlotsAndWaitForTheReplacementOfferBeforeOpeningAnything() = runTest {
        val r = Run(this)
        r.watch()
        val seen = mutableListOf<Pair<String, Int>>()
        r.preparer = { uri, offer -> seen += uri.toString() to offer.fileBytes; fakePrepared(uri) }
        assertEquals(4, r.session.pick())
        assertNull(r.session.pick())
        r.session.linkClosed(1)
        r.session.picked((1..6).map { Uri.parse("content://test/$it") })
        runCurrent()
        assertTrue(seen.isEmpty())
        r.reconnect(AttachTestLink(Attach.Peer.Offered(testOffer().copy(files = 2, fileBytes = 20))))
        runCurrent()
        assertEquals(listOf("content://test/1" to 20, "content://test/2" to 20), seen)
        assertEquals(2, r.state.draft.size)
    }

    @Test fun staleOrLatePickerResultsAreDiscardedAndWaitingExpires() = runTest {
        val r = Run(this)
        r.watch()
        val provider = CompletableDeferred<Unit>()
        r.preparer = { uri, _ -> withContext(NonCancellable) { provider.await(); fakePrepared(uri) } }
        r.pick(); runCurrent()
        r.session.closed(keep = false, gen = r.gen++)
        r.ref = TerminalRef("box", "dsh:other")
        r.session.linkOpened(r.gen, r.link.attach)
        r.watch()
        provider.complete(Unit)
        runCurrent()
        assertTrue(r.state.draft.isEmpty())

        r.session.picked(listOf(Uri.parse("content://test/late")))
        assertEquals("Pick the images again.", r.notices.last())
        assertNotNull(r.session.pick())
        r.session.linkClosed(r.gen)
        r.session.picked(listOf(Uri.parse("content://test/wait")))
        advanceTimeBy(20_001)
        assertNull(r.state.waiting)
        assertEquals("Pick the images again.", r.notices.last())
    }

    @Test fun thumbnailsAreTapOnlySerialBoundedAndDieWithTheWatch() = runTest {
        val r = Run(this)
        val block = Attach.Block.Image(0, Attach.PNG, 2, 2)
        val rows = (1..10).map { n -> attachRow("dsh:a:$n").put("blocks", JSONArray(listOf(JSONObject()
            .put("type", "image").put("block", 0).put("mediaType", Attach.PNG).put("width", 2).put("height", 2)))) }
        val token = r.snapshot(*rows.toTypedArray())
        assertTrue(r.link.calls.isEmpty())
        val read = CompletableDeferred<JSONObject>()
        r.link.readImage = { withContext(NonCancellable) { read.await() } }
        r.session.show(r.chat.rows[0], block)
        r.session.show(r.chat.rows[1], block)
        runCurrent()
        assertEquals(1, r.link.calls.size)
        r.session.watchEnded(token)
        r.snapshot(*rows.toTypedArray())
        read.complete(thumbnailReply()); runCurrent()
        assertTrue(r.state.shown.isEmpty())
        assertNull(r.state.loading)

        r.link.readImage = { thumbnailReply() }
        for (row in r.chat.rows) { r.session.show(row, block); runCurrent() }
        assertEquals(r.chat.rows.takeLast(8).map { AttachSession.thumbKey(it.id, 0) }, r.state.shown.keys.toList())
        r.session.linkClosed(1)
        assertTrue(r.state.shown.isEmpty())
        assertNull(r.state.loading)
    }

    @Test fun malformedThumbnailRepliesFailLocallyAndReadRefusalsUseFixedWords() = runTest {
        val r = Run(this)
        val row = attachRow("dsh:a:1").put("blocks", JSONArray(listOf(JSONObject()
            .put("type", "image").put("block", 0).put("mediaType", Attach.PNG).put("width", 2).put("height", 2))))
        r.snapshot(row)
        val item = r.chat.rows.single()
        val block = item.blocks!!.single() as Attach.Block.Image
        for (reply in listOf(thumbnailReply().put("data", "a".repeat(174_765)),
            thumbnailReply().put("mediaType", Attach.GIF), thumbnailReply().put("width", 3))) {
            r.link.readImage = { reply }
            r.session.show(item, block); runCurrent()
            assertEquals("Can't preview this image", r.notices.last())
            assertTrue(r.state.shown.isEmpty())
        }
        r.link.readImage = { attachRefusal("not-found") }
        r.session.show(item, block); runCurrent()
        assertEquals("This image is no longer on the computer.", r.notices.last())
    }
}
