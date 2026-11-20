package ai.namastex.automagik

import ai.namastex.automagik.ChatMemory.Op
import ai.namastex.automagik.ChatMemory.Phase
import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

internal fun memoryTestReply(terminal: String, text: String = "A fact", state: String = "read") = JSONObject()
    .put("ok", true).put("state", state).put("memory", JSONObject().put("terminal", terminal).put("size", text.length).put("limit", 2000)
        .put("entries", JSONArray().put(JSONObject().put("id", "id").put("rev", "rev").put("text", text))))

internal fun memoryTestRefusal(reason: String, applied: Boolean = false) =
    JSONObject().put("ok", false).put("state", "refused").put("reason", reason).put("applied", applied)

/** Each fake represents one connection, so a test can tell which methods went over the chat or the memory link. */
internal class MemoryTestLink(override val manage: Set<String> = ChatClient.MEMORY.toSet(),
                              private val subscribeFailure: Boolean = false) : ChatLink {
    override val dshWrite = true
    val reads = CopyOnWriteArrayList<String>()
    val adds = CopyOnWriteArrayList<Pair<String, String>>()
    val edits = CopyOnWriteArrayList<List<String>>()
    val subscribed = CompletableDeferred<(JSONObject) -> Unit>()
    val closedOn = CompletableDeferred<Thread>()
    @Volatile var closed = false
        private set
    var read: suspend (String) -> JSONObject = { terminal -> memoryTestReply(terminal) }
    var add: suspend (String, String) -> JSONObject = { terminal, text -> memoryTestReply(terminal, text, "saved") }
    var edit: suspend (String, String) -> JSONObject = { terminal, text -> memoryTestReply(terminal, text, "saved") }

    override suspend fun list(): List<Chat.Terminal> = emptyList()
    override suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit): Int {
        if (subscribeFailure) error("Too many Bot chats")
        event(JSONObject().put("type", "snapshot").put("rows", JSONArray()).put("reset", true))
        subscribed.complete(event)
        return 1
    }
    override suspend fun backfill(terminal: String, before: String, limit: Int) = JSONArray()
    override suspend fun send(terminal: String, text: String, id: String) = JSONObject()
    override suspend fun sendHeld(terminal: String, id: String) = JSONObject()
    override suspend fun cancelHeld(terminal: String, id: String) = JSONObject()
    override suspend fun answer(terminal: String, row: String, choice: String, text: String?) = JSONObject()
    override suspend fun interrupt(terminal: String) = JSONObject()
    override suspend fun memoryRead(terminal: String): JSONObject { reads += terminal; return read(terminal) }
    override suspend fun memoryAdd(terminal: String, text: String): JSONObject { adds += terminal to text; return add(terminal, text) }
    override suspend fun memoryEdit(terminal: String, id: String, rev: String, text: String): JSONObject {
        edits += listOf(terminal, id, rev, text)
        return edit(terminal, text)
    }
    override fun close() { closed = true; closedOn.complete(Thread.currentThread()) }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PocketViewModelMemoryTest {
    private val dispatcher = StandardTestDispatcher()
    private val ref = TerminalRef("box", "dsh:lead")
    private val uncertainLoss = "The connection closed before the computer answered. The change may have been saved: open Memory again to check."
    private val notOffered = "Memory isn't offered on this connection. If this keeps happening, update Pocket Link and Automagik on this computer."
    private lateinit var vm: PocketViewModel
    private val memory get() = checkNotNull(vm.memory.value)

    @Before fun setUp() {
        val initDispatcher = StandardTestDispatcher()
        Dispatchers.setMain(dispatcher)
        val app: Application = ApplicationProvider.getApplicationContext()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        vm = PocketViewModel(app, initDispatcher)
        vm.linkDispatcher = StandardTestDispatcher(dispatcher.scheduler)
    }

    @After fun tearDown() {
        vm.closeChat()
        vm.viewModelScope.cancel()
        dispatcher.scheduler.runCurrent()
        Dispatchers.resetMain()
    }

    private fun use(link: MemoryTestLink) { vm.chatOpenerManage = { _, _, _, _ -> link } }

    @Test fun onlyTheDialogRequestsMemoryAndItWorksAfterChatSubscribeFails() = runTest(dispatcher) {
        val requested = CopyOnWriteArrayList<List<String>>()
        val chat = MemoryTestLink(emptySet(), subscribeFailure = true)
        val manage = MemoryTestLink()
        vm.chatOpenerManage = { _, _, methods, _ ->
            requested += methods
            if (methods.isEmpty()) chat else manage
        }
        vm.openChat(ref)
        withContext(Dispatchers.IO) { withTimeout(10_000) { while (!chat.closed) delay(5) } }
        assertEquals("Too many Bot chats", vm.chat.value?.error)
        assertFalse(vm.chat.value?.connected ?: true)
        vm.loadBotChats(ref.hostId)
        withContext(Dispatchers.IO) { withTimeout(10_000) { while (vm.botChats.value[ref.hostId] == null) delay(5) } }
        vm.openMemory(ref)
        runCurrent()
        assertEquals(listOf(emptyList(), emptyList(), ChatClient.MEMORY), requested.toList())
        assertTrue(chat.reads.isEmpty())
        assertEquals(listOf(ref.address), manage.reads.toList())
        assertEquals(Phase.READY, memory.phase)
        assertEquals(true, vm.botManage.value[ref.hostId])
    }

    @Test fun openingAndRefreshingClaimOneReadAndLoadingRejectsAdds() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink().apply { read = { pending.await() } }
        var opens = 0
        vm.chatOpenerManage = { _, _, _, _ -> opens++; link }
        vm.openMemory(ref)
        val token = memory.token
        vm.openMemory(ref)
        assertEquals(token, memory.token)
        assertEquals(Phase.CONNECTING, memory.phase)
        runCurrent()
        assertEquals(1, opens)
        assertEquals(Phase.LOADING, memory.phase)
        assertEquals("Checking…", memory.status)
        vm.memoryAdd("A fact")
        vm.refreshMemory()
        runCurrent()
        assertTrue(link.adds.isEmpty())
        assertEquals(1, link.reads.size)
        pending.complete(memoryTestReply(ref.address))
        runCurrent()
        assertEquals(Phase.READY, memory.phase)
        vm.refreshMemory()
        assertEquals(Op.READ, memory.op)
        assertEquals(Phase.LOADING, memory.phase)
        assertEquals("Checking…", memory.status)
        vm.refreshMemory()
        runCurrent()
        assertEquals(2, link.reads.size)
        assertEquals(Phase.READY, memory.phase)
        assertNull(memory.status)
    }

    @Test fun aSecondAddCannotPassTheClaimAndInvalidTextStaysLocal() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink().apply { add = { _, _ -> pending.await() } }
        use(link)
        vm.openMemory(ref)
        runCurrent()
        vm.memoryAdd("   ")
        assertEquals("Type a memory entry first.", memory.outcome)
        assertEquals(Op.NONE, memory.op)
        vm.memoryAdd("First")
        assertEquals(Op.ADD, memory.op)
        vm.memoryAdd("Second")
        runCurrent()
        assertEquals(listOf(ref.address to "First"), link.adds.toList())
        pending.complete(memoryTestReply(ref.address, "First", "saved"))
        runCurrent()
        assertEquals("First", memory.snapshot?.entries?.single()?.text)
        assertEquals("Saved.", memory.outcome)
        assertEquals(1, link.reads.size)
    }

    @Test fun staleEditsUseTheSuppliedSnapshotWithoutAnotherRead() = runTest(dispatcher) {
        val link = MemoryTestLink().apply { edit = { terminal, _ ->
            memoryTestReply(terminal, "Changed on the computer", "refused").put("ok", false).put("reason", "stale")
        } }
        use(link)
        vm.openMemory(ref)
        runCurrent()
        val entry = checkNotNull(memory.snapshot).entries.single()
        vm.memoryEdit(entry, "My edit")
        runCurrent()
        assertEquals(listOf(listOf(ref.address, entry.id, entry.rev, "My edit")), link.edits.toList())
        assertEquals("Changed on the computer", memory.snapshot?.entries?.single()?.text)
        assertEquals(Phase.READY, memory.phase)
        assertEquals(1, link.reads.size)
    }

    @Test fun aConflictWithoutCurrentMemoryDisablesWritesUntilRefresh() = runTest(dispatcher) {
        val link = MemoryTestLink().apply { edit = { _, _ -> memoryTestRefusal("gone") } }
        use(link)
        vm.openMemory(ref)
        runCurrent()
        val entry = checkNotNull(memory.snapshot).entries.single()
        vm.memoryEdit(entry, "My edit")
        runCurrent()
        assertEquals(Phase.READ_FAILED, memory.phase)
        assertEquals("That entry is gone from the computer.", memory.outcome)
        assertEquals("Refresh to see the current memory.", memory.status)
        vm.memoryEdit(entry, "Try again")
        vm.memoryAdd("Try adding")
        runCurrent()
        assertEquals(1, link.reads.size)
        assertEquals(1, link.edits.size)
        assertTrue(link.adds.isEmpty())
        vm.refreshMemory()
        runCurrent()
        assertEquals(2, link.reads.size)
        assertTrue(memory.canWrite("memory.edit"))
    }

    @Test fun anUnknownWriteReadsOnceAndEachFailedRefreshKeepsItsOutcome() = runTest(dispatcher) {
        val link = MemoryTestLink()
        link.read = { terminal -> if (link.reads.size == 1) memoryTestReply(terminal)
            else memoryTestRefusal("offline") }
        link.add = { _, _ -> JSONObject().put("ok", false).put("state", "unknown").put("reason", "offline") }
        lateinit var lost: (String) -> Unit
        vm.chatOpenerManage = { _, _, _, callback -> lost = callback; link }
        vm.openMemory(ref)
        runCurrent()
        vm.memoryAdd("Maybe saved")
        runCurrent()
        assertEquals(2, link.reads.size)
        assertEquals(1, link.adds.size)
        assertEquals(Phase.READ_FAILED, memory.phase)
        assertEquals("The computer didn't confirm this change.", memory.outcome)
        assertEquals("Couldn't check the memory. Refresh to see what was saved.", memory.status)
        vm.memoryAdd("Must wait for refresh")
        runCurrent()
        assertEquals(2, link.reads.size)
        assertEquals(1, link.adds.size)
        repeat(2) { retry ->
            vm.refreshMemory()
            assertEquals("Checking…", memory.status)
            runCurrent()
            assertEquals(3 + retry, link.reads.size)
            assertEquals(1, link.adds.size)
            assertEquals(Phase.READ_FAILED, memory.phase)
            assertEquals("The computer didn't confirm this change.", memory.outcome)
            assertEquals("Couldn't check the memory. Refresh to see what was saved.", memory.status)
        }
        lost("Connection detail")
        runCurrent()
        assertEquals(Phase.CLOSED, memory.phase)
        assertEquals(uncertainLoss, memory.status)
        assertEquals("The computer didn't confirm this change.", memory.outcome)
    }

    @Test fun reopeningDropsLateResultsFromTheOldLinkEvenForTheSameBot() = runTest(dispatcher) {
        val late = CompletableDeferred<JSONObject>()
        val old = MemoryTestLink().apply { read = { withContext(NonCancellable) { late.await() } } }
        val fresh = MemoryTestLink().apply { read = { memoryTestReply(it, "Fresh") } }
        val links = listOf(old, fresh).iterator()
        vm.chatOpenerManage = { _, _, _, _ -> links.next() }
        vm.openMemory(ref)
        runCurrent()
        assertEquals(1, old.reads.size)
        vm.closeMemory()
        assertNull(vm.memory.value)
        runCurrent()
        assertTrue(old.closed)
        vm.openMemory(ref)
        runCurrent()
        late.complete(memoryTestReply(ref.address, "Late"))
        runCurrent()
        assertEquals("Fresh", memory.snapshot?.entries?.single()?.text)
        assertFalse(fresh.closed)
    }

    @Test fun closingChatAndStoppingStreamsDismissMemoryWithoutReopeningIt() = runTest(dispatcher) {
        val first = MemoryTestLink()
        val second = MemoryTestLink()
        val chat = MemoryTestLink()
        vm.chatOpenerManage = { _, _, methods, _ -> if (methods.isEmpty()) chat else first }
        vm.openChat(ref)
        withContext(Dispatchers.IO) { withTimeout(10_000) { while (vm.chat.value?.connected != true) delay(5) } }
        vm.openMemory(ref)
        runCurrent()
        vm.closeChat(ref)
        assertNull(vm.memory.value)
        runCurrent()
        assertTrue(first.closed)
        use(second)
        vm.openMemory(ref)
        runCurrent()
        vm.streams(false)
        assertNull(vm.memory.value)
        runCurrent()
        assertTrue(second.closed)
        vm.streams(true)
        runCurrent()
        assertNull(vm.memory.value)
        assertEquals(1, second.reads.size)
    }

    @Test fun sameChatReconnectAndResumeKeepMemoryUntilAnotherChatOpens() = runTest(dispatcher) {
        val link = MemoryTestLink()
        val chatLinks = CopyOnWriteArrayList<MemoryTestLink>()
        vm.chatOpenerManage = { _, _, methods, _ ->
            if (methods.isEmpty()) MemoryTestLink(emptySet()).also { chatLinks += it } else link
        }
        vm.openChat(ref)
        withContext(Dispatchers.IO) { withTimeout(10_000) { while (vm.chat.value?.connected != true) delay(5) } }
        vm.openMemory(ref)
        runCurrent()
        val ready = memory
        assertEquals(Phase.READY, ready.phase)

        vm.reconnectChat()
        val event = withContext(Dispatchers.IO) {
            withTimeout(10_000) {
                while (chatLinks.size < 2) delay(5)
                chatLinks[1].subscribed.await()
            }
        }
        runCurrent()
        assertSame(ready, memory)
        assertFalse(link.closed)

        event(JSONObject().put("type", "gone").put("reason", "unavailable"))
        runCurrent()
        advanceTimeBy(Chat.RESUME_DELAYS_MS.first())
        runCurrent()
        withContext(Dispatchers.IO) { withTimeout(10_000) { while (chatLinks.size < 3) delay(5) } }
        assertSame(ready, memory)
        assertFalse(link.closed)
        assertEquals(listOf(ref.address), link.reads.toList())

        vm.openChat(ref.copy(hostId = "other"))
        assertNull(vm.memory.value)
        runCurrent()
        assertTrue(link.closed)
    }

    @Test fun releasingMemoryClearsTheStateAndClosesTheTransportOffMain() = runTest(dispatcher) {
        val link = MemoryTestLink()
        use(link)
        vm.openMemory(ref)
        runCurrent()
        assertEquals(Phase.READY, memory.phase)
        val mainThread = Thread.currentThread()
        vm.linkDispatcher = Dispatchers.IO
        vm.closeMemory()
        assertNull(vm.memory.value)
        runCurrent()
        val closeThread = withContext(Dispatchers.IO) { withTimeout(10_000) { link.closedOn.await() } }
        assertNotSame(mainThread, closeThread)
    }

    @Test fun losingTheMemoryConnectionDropsBothSnapshotAndConfirmedEntry() = runTest(dispatcher) {
        lateinit var lost: (String) -> Unit
        val link = MemoryTestLink().apply { add = { terminal, _ ->
            memoryTestReply(terminal, "Old", "saved").put("entry", JSONObject().put("id", "new").put("rev", "rev").put("text", "New"))
        } }
        vm.chatOpenerManage = { _, _, _, callback -> lost = callback; link }
        vm.openMemory(ref)
        runCurrent()
        vm.memoryAdd("New")
        runCurrent()
        assertNotNull(memory.snapshot)
        assertNotNull(memory.confirmed)
        lost("Connection detail")
        runCurrent()
        assertEquals(Phase.CLOSED, memory.phase)
        assertNull(memory.snapshot)
        assertNull(memory.confirmed)
        assertEquals("The connection to the computer closed.", memory.status)
        assertEquals("Saved.", memory.outcome)
        assertTrue(link.closed)
    }

    @Test fun routeLossBeforeAWriteReplyDropsTheReplyWithoutReconciliation() = runTest(dispatcher) {
        for (op in listOf(Op.ADD, Op.EDIT)) {
            val pending = CompletableDeferred<JSONObject>()
            val write: suspend (String, String) -> JSONObject = { _, _ -> withContext(NonCancellable) { pending.await() } }
            val link = MemoryTestLink().apply { add = write; edit = write }
            lateinit var lost: (String) -> Unit
            vm.chatOpenerManage = { _, _, _, callback -> lost = callback; link }
            vm.openMemory(ref)
            runCurrent()
            if (op == Op.ADD) vm.memoryAdd("Maybe saved")
            else vm.memoryEdit(checkNotNull(memory.snapshot).entries.single(), "Maybe saved")
            runCurrent()
            assertEquals(op, memory.op)
            assertEquals(1, link.adds.size + link.edits.size)
            lost("Connection detail")
            runCurrent()
            val closed = memory
            assertEquals(Phase.CLOSED, closed.phase)
            assertEquals(uncertainLoss, closed.status)
            assertEquals(Op.NONE, closed.op)
            assertNull(closed.snapshot)
            assertTrue(link.closed)

            pending.complete(JSONObject().put("ok", false).put("state", "unknown"))
            lost("Duplicate loss")
            runCurrent()
            assertSame(closed, memory)
            assertEquals(1, link.reads.size)
            vm.closeMemory()
        }
    }

    @Test fun routeLossAfterAWriteReplyDropsTheInFlightReconcileRead() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink()
        link.read = { terminal ->
            if (link.reads.size == 1) memoryTestReply(terminal) else withContext(NonCancellable) { pending.await() }
        }
        link.add = { _, _ -> JSONObject().put("ok", true).put("state", "saved").put("memory", JSONObject.NULL) }
        lateinit var lost: (String) -> Unit
        vm.chatOpenerManage = { _, _, _, callback -> lost = callback; link }
        vm.openMemory(ref)
        runCurrent()
        vm.memoryAdd("Saved before loss")
        runCurrent()
        assertEquals(Phase.RECONCILING, memory.phase)
        assertEquals("Checking…", memory.status)
        assertEquals("Saved.", memory.outcome)
        assertEquals(2, link.reads.size)

        lost("Connection detail")
        runCurrent()
        val closed = memory
        assertEquals(Phase.CLOSED, closed.phase)
        assertEquals(uncertainLoss, closed.status)
        assertEquals("Saved.", closed.outcome)
        assertTrue(link.closed)
        pending.complete(memoryTestReply(ref.address, "Late"))
        runCurrent()
        assertSame(closed, memory)
        assertNull(memory.snapshot)
        assertEquals(2, link.reads.size)
    }

    @Test fun aBridgeWithoutMemoryClosesTheDialogAndMarksOnlyItsHost() = runTest(dispatcher) {
        val legacy = MemoryTestLink(emptySet())
        use(legacy)
        vm.openMemory(ref)
        runCurrent()
        assertEquals(Phase.CLOSED, memory.phase)
        assertEquals(notOffered, memory.status)
        assertEquals(mapOf(ref.hostId to false), vm.botManage.value)
        assertTrue(legacy.closed)
        assertTrue(legacy.reads.isEmpty())
    }

    @Test fun chatRouteUnsupportedAndOrdinaryConnectFailuresHaveDifferentCapabilityEffects() = runTest(dispatcher) {
        vm.chatOpenerManage = { _, _, _, _ -> throw ChatUnsupported() }
        vm.openMemory(ref)
        runCurrent()
        assertEquals(Phase.CLOSED, memory.phase)
        assertEquals(notOffered, memory.status)
        assertEquals(false, vm.botManage.value[ref.hostId])
        val other = ref.copy(hostId = "other")
        vm.chatOpenerManage = { _, _, _, _ -> error("Transport detail") }
        vm.openMemory(other)
        runCurrent()
        assertEquals(Phase.CLOSED, memory.phase)
        assertEquals("Couldn't connect to the computer.", memory.status)
        assertEquals(mapOf(ref.hostId to false), vm.botManage.value)
    }

    @Test fun openingOrReconnectingChatClearsOnlyThatHostsMemoryOffer() = runTest(dispatcher) {
        val other = ref.copy(hostId = "other")
        vm.chatOpenerManage = { _, _, _, _ -> MemoryTestLink(emptySet()) }
        vm.openMemory(other)
        runCurrent()
        vm.openMemory(ref)
        runCurrent()
        assertEquals(mapOf(ref.hostId to false, other.hostId to false), vm.botManage.value)

        vm.openChat(ref)
        assertEquals(mapOf(other.hostId to false), vm.botManage.value)
        vm.openMemory(ref)
        runCurrent()
        assertEquals(false, vm.botManage.value[ref.hostId])
        val notice = memory
        vm.reconnectChat()
        assertEquals(mapOf(other.hostId to false), vm.botManage.value)
        assertSame(notice, memory)

        val upgraded = MemoryTestLink()
        vm.chatOpenerManage = { _, _, methods, _ -> if (methods.isEmpty()) MemoryTestLink(emptySet()) else upgraded }
        vm.closeMemory()
        vm.openMemory(ref)
        runCurrent()
        assertEquals(Phase.READY, memory.phase)
        assertEquals(mapOf(ref.hostId to true, other.hostId to false), vm.botManage.value)
    }

    @Test fun sameBotAddressOnTwoHostsUsesTwoDifferentConnections() = runTest(dispatcher) {
        val other = ref.copy(hostId = "other")
        val first = MemoryTestLink().apply { read = { memoryTestReply(it, "From the first computer") } }
        val writable = MemoryTestLink().apply { read = { memoryTestReply(it, "From the other computer") } }
        vm.chatOpenerManage = { host, _, _, _ -> if (host == ref.hostId) first else writable }
        vm.openMemory(ref)
        runCurrent()
        assertEquals("From the first computer", memory.snapshot?.entries?.single()?.text)
        vm.openMemory(other)
        assertNull(memory.snapshot)
        runCurrent()
        assertTrue(first.closed)
        assertEquals(other.hostId, memory.hostId)
        assertEquals(other.address, memory.terminal)
        assertEquals("From the other computer", memory.snapshot?.entries?.single()?.text)
        assertEquals(mapOf(ref.hostId to true, other.hostId to true), vm.botManage.value)
        assertEquals(listOf(ref.address), first.reads.toList())
        assertEquals(listOf(other.address), writable.reads.toList())
    }
}
