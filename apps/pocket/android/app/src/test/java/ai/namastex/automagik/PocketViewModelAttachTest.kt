package ai.namastex.automagik

import android.app.Application
import android.net.Uri
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PocketViewModelAttachTest {
    private lateinit var vm: PocketViewModel
    private lateinit var app: Application
    private val ref = TerminalRef("box", "dsh:bot")
    private val dispatcher = StandardTestDispatcher()
    private val links = LinkedBlockingQueue<AttachTestLink>()
    private val flags = CopyOnWriteArrayList<Pair<List<String>, Boolean>>()
    private val uri = Uri.parse("content://fixture/photo")

    @Before fun init() {
        Dispatchers.setMain(dispatcher)
        app = ApplicationProvider.getApplicationContext()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        AppLock.init(app)
        vm = create()
    }

    private fun create() = PocketViewModel(app, StandardTestDispatcher()).apply {
        chatOpenerAttach = { _, _, manage, attachments, _ ->
            flags += manage to attachments
            links.remove()
        }
    }

    @After fun close() {
        vm.closeChat()
        vm.viewModelScope.cancel()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        AppLock.init(app)
        Dispatchers.resetMain()
    }

    private suspend fun attach(link: AttachTestLink, action: () -> Unit) {
        links.add(link)
        action()
        withTimeout(5_000) { link.subscribed.await() }
        link.event(attachSnapshot(attachRow("dsh:session:1")))
    }

    private suspend fun waitFor(condition: () -> Boolean) = withTimeout(5_000) {
        while (!condition()) delay(5)
    }

    @Test fun readyPrecedesConnectedAndOnlyChatViewAsksForAttachments() = runBlocking {
        val sawReady = CompletableDeferred<Boolean>()
        val observer = launch(Dispatchers.Unconfined) {
            vm.chat.first { it?.connected == true }
            sawReady.complete(vm.attachments.watchReady())
        }
        try {
            attach(AttachTestLink()) { vm.openChat(ref) }
            assertTrue(withTimeout(5_000) { sawReady.await() })
            val list = AttachTestLink()
            links.add(list)
            vm.loadBotChats(ref.hostId)
            withTimeout(5_000) { list.closed.await() }
            val memory = AttachTestLink()
            links.add(memory)
            vm.openMemory(ref)
            dispatcher.scheduler.runCurrent()
            waitFor { flags.size == 3 }
            dispatcher.scheduler.runCurrent()
            assertEquals(listOf(emptyList<String>() to true, emptyList<String>() to false, ChatClient.MEMORY to false), flags.toList())
        } finally {
            observer.cancel()
        }
    }

    @Test fun lifecycleKeepsDraftAndHeldMessagesAndRenegotiatesEachTime() = runBlocking {
        vm.attachments.prepare = { picked, _ -> fakePrepared(picked) }
        val first = AttachTestLink().apply { begin = { attachRefusal("quota") } }
        attach(first) { vm.openChat(ref) }
        val a = vm.attachments
        a.pick(); a.picked(listOf(uri))
        waitFor { a.state.value.draft.size == 1 && a.state.value.preparing == 0 }
        assertEquals(Submit.Accepted, a.submit("caption"))
        waitFor { a.state.value.messages.singleOrNull()?.phase == Phase.STOPPED }
        a.pick(); a.picked(listOf(uri))
        waitFor { a.state.value.draft.size == 1 }
        vm.streams(false)
        assertEquals(Attach.Peer.NotAsked, a.state.value.peer)
        assertFalse(a.watchReady())
        attach(AttachTestLink(Attach.Peer.Missing)) { vm.streams(true) }
        assertEquals(Attach.Peer.Missing, a.state.value.peer)
        assertEquals(1, a.state.value.draft.size)
        assertEquals(Phase.STOPPED, a.state.value.messages.single().phase)
        attach(AttachTestLink()) { vm.reconnectChat() }
        assertTrue(a.state.value.peer is Attach.Peer.Offered)
        vm.closeChat()
        assertEquals(AttachState.EMPTY, a.state.value)
    }

    @Test fun resultBeforeStartWaitsForNewOfferAndTruncatesBeforeReads() = runBlocking {
        val reads = CopyOnWriteArrayList<Pair<Uri, Int>>()
        vm.attachments.prepare = { picked, offer ->
            reads += picked to offer.files
            fakePrepared(picked)
        }
        attach(AttachTestLink()) { vm.openChat(ref) }
        assertEquals(4, vm.attachments.pick())
        vm.streams(false)
        deliverAttachPick(vm.attachments, (1..6).map { Uri.parse("content://fixture/$it") })
        assertTrue(reads.isEmpty())
        attach(AttachTestLink(Attach.Peer.Offered(testOffer().copy(files = 2)))) { vm.streams(true) }
        waitFor { vm.attachments.state.value.draft.size == 2 }
        assertEquals(listOf(Uri.parse("content://fixture/1") to 2, Uri.parse("content://fixture/2") to 2), reads.toList())
    }

    @Test fun lockNavigationAndANewVmDiscardPendingResults() = runBlocking {
        val provider = CompletableDeferred<Unit>()
        val started = CompletableDeferred<Unit>()
        vm.attachments.prepare = { picked, _ ->
            withContext(NonCancellable) { started.complete(Unit); provider.await(); fakePrepared(picked) }
        }
        attach(AttachTestLink()) { vm.openChat(ref) }
        try {
            vm.attachments.pick()
            app.getSharedPreferences("pocket", 0).edit().putBoolean("app_lock", true).commit()
            AppLock.init(app)
            assertTrue(AppLock.locked())
            deliverAttachPick(vm.attachments, listOf(uri))
            assertNull(vm.attachments.state.value.pendingPick)
            assertFalse(started.isCompleted)
            assertEquals("Pick the images again.", vm.chat.value?.notice)

            app.getSharedPreferences("pocket", 0).edit().remove("app_lock").commit()
            AppLock.init(app)
            vm.attachments.pick()
            deliverAttachPick(vm.attachments, listOf(uri))
            withTimeout(5_000) { started.await() }
            val other = TerminalRef("box", "dsh:other")
            attach(AttachTestLink()) { vm.openChat(other) }
            provider.complete(Unit)
            assertTrue(vm.attachments.state.value.draft.isEmpty())

            val fresh = create()
            try {
                attach(AttachTestLink()) { fresh.openChat(other) }
                deliverAttachPick(fresh.attachments, listOf(uri))
                assertTrue(fresh.attachments.state.value.draft.isEmpty())
                assertEquals("Pick the images again.", fresh.chat.value?.notice)
            } finally {
                fresh.closeChat()
                fresh.viewModelScope.cancel()
            }
        } finally {
            provider.complete(Unit)
        }
    }
}
