package ai.namastex.automagik

import ai.namastex.automagik.ChatSchedules.Op
import ai.namastex.automagik.ChatSchedules.Phase
import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import kotlinx.coroutines.test.StandardTestDispatcher
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

/** One fake per connection lets tests check which grant saw each call, including a call held past Close. */
internal class SchedulesTestLink(override val manage: Set<String> = ChatClient.SCHEDULES.toSet(),
                                private val subscribeFailure: Boolean = false) : ChatLink {
    override val dshWrite = true
    val reads = CopyOnWriteArrayList<Pair<String, String?>>()
    data class Write(val method: String, val terminal: String, val id: String, val rev: String, val title: String? = null)
    val writes = CopyOnWriteArrayList<Write>()
    val memoryReads = CopyOnWriteArrayList<String>()
    val closedOn = CompletableDeferred<Thread>()
    val closed get() = closedOn.isCompleted
    var read: suspend (String, String?) -> JSONObject = { terminal, _ -> scheduleTestList(terminal) }
    var write: suspend (Write) -> JSONObject = { scheduleTestWrite("unchanged", scheduleTestTask(id = it.id, rev = it.rev)) }
    var readMemory: suspend (String) -> JSONObject = { terminal ->
        JSONObject().put("ok", true).put("state", "read").put("memory",
            JSONObject().put("terminal", terminal).put("entries", JSONArray()))
    }

    override suspend fun list(): List<Chat.Terminal> = emptyList()
    override suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit): Int {
        if (subscribeFailure) error("Too many Bot chats")
        event(JSONObject().put("type", "snapshot").put("rows", JSONArray()).put("reset", true))
        return 1
    }
    override suspend fun backfill(terminal: String, before: String, limit: Int) = JSONArray()
    override suspend fun send(terminal: String, text: String, id: String) = JSONObject()
    override suspend fun sendHeld(terminal: String, id: String) = JSONObject()
    override suspend fun cancelHeld(terminal: String, id: String) = JSONObject()
    override suspend fun answer(terminal: String, row: String, choice: String, text: String?) = JSONObject()
    override suspend fun interrupt(terminal: String) = JSONObject()
    override suspend fun memoryRead(terminal: String): JSONObject { memoryReads += terminal; return readMemory(terminal) }
    override suspend fun scheduleList(terminal: String, id: String?): JSONObject { reads += terminal to id; return read(terminal, id) }
    override suspend fun schedulePause(terminal: String, id: String, rev: String) = edit(Write("schedule.pause", terminal, id, rev))
    override suspend fun scheduleResume(terminal: String, id: String, rev: String) = edit(Write("schedule.resume", terminal, id, rev))
    override suspend fun scheduleRename(terminal: String, id: String, rev: String, title: String) =
        edit(Write("schedule.rename", terminal, id, rev, title))
    private suspend fun edit(request: Write): JSONObject { writes += request; return write(request) }
    override fun close() { closedOn.complete(Thread.currentThread()) }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PocketViewModelSchedulesTest {
    private val dispatcher = StandardTestDispatcher()
    private val ref = TerminalRef("box", "dsh:lead")
    private lateinit var vm: PocketViewModel
    private val schedules get() = checkNotNull(vm.schedules.value)
    private val row get() = checkNotNull(schedules.listing).tasks.single()
    private val uncertainLoss = "The connection closed before the computer answered. The change may have been saved: check it on the computer."

    @Before fun setUp() {
        // Made before setMain, so the view model's endless background loops never share runTest's scheduler.
        val initDispatcher = StandardTestDispatcher()
        Dispatchers.setMain(dispatcher)
        val app = ApplicationProvider.getApplicationContext<Application>()
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

    private fun use(link: SchedulesTestLink) { vm.chatOpenerManage = { _, _, _, _ -> link } }
    private fun unknown() = JSONObject().put("ok", false).put("state", "unknown").put("reason", "pending")

    @Test fun chatMemoryAndSchedulesDiscoverSeparateGrantsOnDemand() = runTest(dispatcher) {
        val requested = CopyOnWriteArrayList<List<String>>()
        val chat = SchedulesTestLink(emptySet(), subscribeFailure = true)
        val memory = SchedulesTestLink(ChatClient.MEMORY.toSet())
        val tasks = SchedulesTestLink()
        vm.chatOpenerManage = { _, _, methods, _ ->
            requested += methods
            when (methods) { ChatClient.MEMORY -> memory; ChatClient.SCHEDULES -> tasks; else -> chat }
        }
        vm.openChat(ref)
        withContext(Dispatchers.IO) { withTimeout(10_000) { chat.closedOn.await() } }
        assertEquals("Too many Bot chats", vm.chat.value?.error)
        assertEquals(listOf(emptyList<String>()), requested.toList())
        assertNull(vm.botSchedules.value[ref.hostId])
        vm.openMemory(ref)
        runCurrent()
        vm.openSchedules(ref)
        runCurrent()
        assertEquals(listOf(emptyList(), ChatClient.MEMORY, ChatClient.SCHEDULES), requested.toList())
        assertEquals(listOf(ref.address), memory.memoryReads.toList())
        assertEquals(listOf(ref.address to null), tasks.reads.toList())
        assertTrue(chat.reads.isEmpty() && memory.reads.isEmpty() && tasks.memoryReads.isEmpty())
        assertEquals(true, vm.botSchedules.value[ref.hostId])
        assertEquals(ChatMemory.Phase.READY, vm.memory.value?.phase)
        assertEquals(Phase.READY, schedules.phase)
    }

    @Test fun synchronousClaimsBlockDuplicateReadsAndWritesAndSendTheDisplayedRevision() = runTest(dispatcher) {
        val pendingRead = CompletableDeferred<JSONObject>()
        val pendingWrite = CompletableDeferred<JSONObject>()
        val link = SchedulesTestLink().apply { read = { _, _ -> pendingRead.await() }; write = { pendingWrite.await() } }
        var opens = 0
        vm.chatOpenerManage = { _, _, _, _ -> opens++; link }
        vm.openSchedules(ref)
        val token = schedules.token
        vm.openSchedules(ref)
        assertEquals(token, schedules.token)
        runCurrent()
        assertEquals(1, opens)
        assertEquals(Phase.LOADING, schedules.phase)
        vm.refreshSchedules()
        runCurrent()
        assertEquals(1, link.reads.size)
        pendingRead.complete(scheduleTestList(ref.address))
        runCurrent()
        val shown = row
        vm.schedulePause(shown)
        assertEquals(Op.PAUSE, schedules.op)
        assertEquals(shown.id, schedules.opTask)
        vm.scheduleRename(shown, "Another title")
        vm.refreshSchedules()
        runCurrent()
        assertEquals(listOf(SchedulesTestLink.Write("schedule.pause", ref.address, shown.id, shown.rev)), link.writes.toList())
        assertEquals(1, link.reads.size)
        pendingWrite.complete(scheduleTestWrite("saved", scheduleTestTask(rev = "new", state = "paused")))
        runCurrent()
        assertEquals("Paused.", schedules.outcome)
        assertEquals("paused", row.state)
        vm.scheduleRename(shown, "Stale click")
        runCurrent()
        assertEquals(1, link.writes.size)
        assertEquals(1, link.reads.size)
        vm.refreshSchedules()
        vm.refreshSchedules()
        runCurrent()
        assertEquals(listOf(ref.address to null, ref.address to null), link.reads.toList())
    }

    @Test fun renameSendsOnlyTheTrimmedTitleAndUnchangedSkipsReadback() = runTest(dispatcher) {
        val link = SchedulesTestLink()
        use(link)
        vm.openSchedules(ref)
        runCurrent()
        vm.scheduleRename(row, "a".repeat(119) + "😀")
        assertEquals("Keep the name under 120 characters", schedules.outcome)
        assertTrue(link.writes.isEmpty())
        val titles = listOf(" ".repeat(4097) + "Short\u00A0" to "Short", "\uFEFF" + "a".repeat(120) to "a".repeat(120))
        for ((input, sent) in titles) {
            val shown = row
            vm.scheduleRename(shown, input)
            runCurrent()
            assertEquals(SchedulesTestLink.Write("schedule.rename", ref.address, shown.id, shown.rev, sent), link.writes.last())
            assertEquals("No change.", schedules.outcome)
        }
        assertEquals(2, link.writes.size)
        assertEquals(listOf(ref.address to null), link.reads.toList())
    }

    @Test fun unknownWriteChecksOnceAndBusyRateUnavailableRetriesStaySelectedOnTheSameLink() = runTest(dispatcher) {
        val failures = listOf("busy", "rate", "unavailable").iterator()
        val link = SchedulesTestLink().apply {
            write = { unknown() }
            read = { terminal, id ->
                when {
                    id == null -> scheduleTestList(terminal)
                    failures.hasNext() -> scheduleTestRefusal(failures.next())
                    else -> scheduleTestList(terminal, emptyList(), truncated = true)
                        .put("task", scheduleTestTask(id = id, rev = "current", title = "Current task"))
                }
            }
        }
        var opens = 0
        vm.chatOpenerManage = { _, _, _, _ -> opens++; link }
        vm.openSchedules(ref)
        runCurrent()
        val old = row
        vm.scheduleRename(old, "Maybe saved")
        runCurrent()
        assertEquals(listOf(ref.address to null, ref.address to old.id), link.reads.toList())
        repeat(3) {
            assertEquals(Phase.READ_FAILED, schedules.phase)
            assertEquals(old.id, schedules.uncertain)
            assertEquals(ChatSchedules.UNCONFIRMED, schedules.outcome)
            vm.scheduleRename(old, "Must wait")
            vm.refreshSchedules()
            assertEquals(Phase.RECONCILING, schedules.phase)
            vm.refreshSchedules()
            runCurrent()
        }
        assertEquals(1, opens)
        assertEquals(1, link.writes.size)
        assertEquals(listOf(ref.address to null) + List(4) { ref.address to old.id }, link.reads.toList())
        assertNull(schedules.uncertain)
        assertEquals("current", row.rev)
        assertTrue(schedules.canAct("schedule.rename", row))
    }

    @Test fun selectedNullAndGoneKeepRefreshTargetedUntilTheMatchingTaskReturns() = runTest(dispatcher) {
        val link = SchedulesTestLink().apply {
            write = { unknown() }
            read = { terminal, id ->
                when (reads.size) {
                    1 -> scheduleTestList(terminal)
                    2 -> scheduleTestList(terminal).put("task", JSONObject.NULL)
                    3 -> scheduleTestRefusal("gone")
                    else -> scheduleTestList(terminal, emptyList()).put("task", scheduleTestTask(id = checkNotNull(id), rev = "current"))
                }
            }
        }
        use(link)
        vm.openSchedules(ref)
        runCurrent()
        val old = row
        vm.schedulePause(old)
        runCurrent()
        repeat(2) {
            assertTrue(checkNotNull(schedules.listing).tasks.isEmpty())
            assertEquals(old.id, schedules.uncertain)
            assertEquals(ChatSchedules.UNCONFIRMED, schedules.outcome)
            vm.refreshSchedules()
            runCurrent()
        }
        assertEquals(listOf(ref.address to null) + List(3) { ref.address to old.id }, link.reads.toList())
        assertEquals(1, link.writes.size)
        assertNull(schedules.uncertain)
        assertEquals("current", row.rev)
    }

    @Test fun aRequestTimeoutStillReconcilesOnTheOriginalLink() = runTest(dispatcher) {
        val link = SchedulesTestLink().apply {
            write = { withTimeout(1_000) { awaitCancellation() } }
            read = { terminal, id ->
                scheduleTestList(terminal).apply { if (id != null) put("task", scheduleTestTask(id = id, state = "paused")) }
            }
        }
        use(link)
        vm.openSchedules(ref)
        runCurrent()
        val id = row.id
        vm.schedulePause(row)
        runCurrent()
        assertEquals(Op.PAUSE, schedules.op)
        testScheduler.advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf(ref.address to null, ref.address to id), link.reads.toList())
        assertEquals(1, link.writes.size)
        assertEquals("paused", row.state)
        assertNull(schedules.uncertain)
        assertEquals("${ChatSchedules.UNCONFIRMED} The list shows what the computer has now.", schedules.outcome)
    }

    @Test fun routeLossBeforeTheWriteReplyDropsLateRepliesWithoutReadingOrReopening() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val link = SchedulesTestLink().apply { write = { withContext(NonCancellable) { pending.await() } } }
        lateinit var lost: (String) -> Unit
        vm.chatOpenerManage = { _, _, _, callback -> lost = callback; link }
        vm.openSchedules(ref)
        runCurrent()
        vm.schedulePause(row)
        runCurrent()
        try {
            assertEquals(1, link.writes.size)
            lost("Transport detail")
            runCurrent()
            val closed = schedules
            assertEquals(Phase.CLOSED, closed.phase)
            assertNull(closed.listing)
            assertEquals(uncertainLoss, closed.status)
            assertEquals(ChatSchedules.UNCONFIRMED, closed.outcome)
            assertTrue(link.closed)
            pending.complete(scheduleTestWrite("saved"))
            lost("Late callback")
            runCurrent()
            assertSame(closed, schedules)
            assertEquals(1, link.reads.size)
        } finally { pending.complete(unknown()) }
    }

    @Test fun lossDuringReconciliationAndItsLateSelectedReplyCannotCertifyANewView() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val old = SchedulesTestLink().apply {
            write = { unknown() }
            read = { terminal, id -> if (id == null) scheduleTestList(terminal) else withContext(NonCancellable) { pending.await() } }
        }
        lateinit var lost: (String) -> Unit
        vm.chatOpenerManage = { _, _, _, callback -> lost = callback; old }
        vm.openSchedules(ref)
        runCurrent()
        val id = row.id
        vm.schedulePause(row)
        runCurrent()
        try {
            assertEquals(Phase.RECONCILING, schedules.phase)
            assertEquals(listOf(ref.address to null, ref.address to id), old.reads.toList())
            lost("Transport detail")
            runCurrent()
            assertEquals(uncertainLoss, schedules.status)
            assertEquals(ChatSchedules.UNCONFIRMED, schedules.outcome)
            assertNull(schedules.listing)
            assertTrue(old.closed)
            vm.closeSchedules()
            val fresh = SchedulesTestLink().apply { read = { terminal, _ -> scheduleTestList(terminal, listOf(scheduleTestTask(title = "Fresh"))) } }
            use(fresh)
            vm.openSchedules(ref)
            runCurrent()
            pending.complete(scheduleTestList(ref.address).put("task", scheduleTestTask(title = "Late title")))
            lost("Late callback")
            runCurrent()
            assertEquals("Fresh", row.title)
            assertEquals(ChatSchedules.EARLIER_CHANGE, schedules.notice)
            assertNull(schedules.outcome)
            assertNull(schedules.uncertain)
            assertEquals(listOf(ref.address to null), fresh.reads.toList())
            assertTrue(fresh.writes.isEmpty())
        } finally { pending.complete(scheduleTestList(ref.address)) }
    }

    @Test fun closeAndBackgroundBeforeTheReplyRememberOnlyTheNoticeForThatBot() = runTest(dispatcher) {
        val other = ref.copy(hostId = "other")
        for (stop in listOf<() -> Unit>(vm::closeSchedules, { vm.streams(false) })) {
            val pending = CompletableDeferred<JSONObject>()
            val old = SchedulesTestLink().apply { write = { withContext(NonCancellable) { pending.await() } } }
            use(old)
            vm.openSchedules(ref)
            runCurrent()
            vm.scheduleRename(row, "Pending title")
            runCurrent()
            try {
                stop()
                assertNull(vm.schedules.value)
                runCurrent()
                assertTrue(old.closed)
                vm.streams(true)
                assertNull(vm.schedules.value)
                use(SchedulesTestLink())
                vm.openSchedules(other)
                runCurrent()
                assertNull(schedules.notice)
                val fresh = SchedulesTestLink().apply { read = { terminal, _ -> scheduleTestList(terminal, emptyList()) } }
                use(fresh)
                vm.openSchedules(ref)
                assertEquals(ChatSchedules.EARLIER_CHANGE, schedules.notice)
                runCurrent()
                pending.complete(scheduleTestWrite("saved", scheduleTestTask(title = "Late title")))
                runCurrent()
                assertEquals(ChatSchedules.EARLIER_CHANGE, schedules.notice)
                assertNull(schedules.outcome)
                assertTrue(checkNotNull(schedules.listing).tasks.isEmpty())
                assertEquals(listOf(ref.address to null), fresh.reads.toList())
            } finally { pending.complete(unknown()) }
            vm.closeSchedules()
            runCurrent()
        }
    }

    @Test fun sameChatReconnectKeepsSchedulesAndSwitchingHostsClosesAndClearsTheirTitles() = runTest(dispatcher) {
        val other = ref.copy(hostId = "other")
        val first = SchedulesTestLink().apply { read = { terminal, _ -> scheduleTestList(terminal, listOf(scheduleTestTask(title = "First"))) } }
        val second = SchedulesTestLink().apply { read = { terminal, _ -> scheduleTestList(terminal, listOf(scheduleTestTask(title = "Second"))) } }
        vm.chatOpenerManage = { host, _, methods, _ ->
            when { methods.isEmpty() -> SchedulesTestLink(emptySet()); host == ref.hostId -> first; else -> second }
        }
        vm.openChat(ref)
        vm.openSchedules(ref)
        runCurrent()
        val ready = schedules
        assertEquals("First", row.title)
        vm.reconnectChat()
        assertSame(ready, schedules)
        assertNull(vm.botSchedules.value[ref.hostId])
        runCurrent()
        assertFalse(first.closed)
        vm.openChat(other)
        assertNull(vm.schedules.value)
        runCurrent()
        assertTrue(first.closed)
        vm.openSchedules(other)
        runCurrent()
        assertEquals(other.hostId, schedules.hostId)
        assertEquals(ref.address, schedules.terminal)
        assertEquals("Second", row.title)
        assertEquals(listOf(ref.address to null), first.reads.toList())
        assertEquals(listOf(ref.address to null), second.reads.toList())
        vm.closeChat(ref)
        assertEquals("Second", row.title)
        vm.closeChat(other)
        assertNull(vm.schedules.value)
        runCurrent()
        assertTrue(second.closed)
    }

    @Test fun closeClearsTheDialogImmediatelyAndClosesTheTransportOffMain() = runTest(dispatcher) {
        val link = SchedulesTestLink()
        use(link)
        vm.openSchedules(ref)
        runCurrent()
        val mainThread = Thread.currentThread()
        vm.linkDispatcher = Dispatchers.IO
        vm.closeSchedules()
        assertNull(vm.schedules.value)
        runCurrent()
        val closeThread = withContext(Dispatchers.IO) { withTimeout(10_000) { link.closedOn.await() } }
        assertNotSame(mainThread, closeThread)
    }

    @Test fun missingScheduleOfferSendsNoCallsAndKeepsMemoryUsable() = runTest(dispatcher) {
        val legacy = SchedulesTestLink(ChatClient.MEMORY.toSet())
        val memory = SchedulesTestLink(ChatClient.MEMORY.toSet())
        vm.chatOpenerManage = { _, _, methods, _ -> if (methods == ChatClient.SCHEDULES) legacy else memory }
        vm.openSchedules(ref)
        runCurrent()
        assertEquals(Phase.CLOSED, schedules.phase)
        assertEquals(false, vm.botSchedules.value[ref.hostId])
        assertTrue(legacy.closed)
        assertTrue(legacy.reads.isEmpty() && legacy.writes.isEmpty())
        vm.openMemory(ref)
        runCurrent()
        assertEquals(true, vm.botManage.value[ref.hostId])
        assertEquals(ChatMemory.Phase.READY, vm.memory.value?.phase)
        assertEquals(listOf(ref.address), memory.memoryReads.toList())
    }

    @Test fun delayedMemoryAndScheduleCallbacksCannotAffectTheOtherFamily() = runTest(dispatcher) {
        val lateMemory = CompletableDeferred<JSONObject>()
        val lateSchedules = CompletableDeferred<JSONObject>()
        val memory = SchedulesTestLink(ChatClient.MEMORY.toSet()).apply {
            readMemory = { withContext(NonCancellable) { lateMemory.await() } }
        }
        val readySchedules = SchedulesTestLink()
        val pendingSchedules = SchedulesTestLink().apply { read = { _, _ -> withContext(NonCancellable) { lateSchedules.await() } } }
        lateinit var memoryLost: (String) -> Unit
        lateinit var schedulesLost: (String) -> Unit
        vm.chatOpenerManage = { _, _, _, callback -> memoryLost = callback; memory }
        vm.openMemory(ref)
        runCurrent()
        try {
            vm.closeMemory()
            use(readySchedules)
            vm.openSchedules(ref)
            runCurrent()
            val ready = schedules
            memoryLost("Late Memory loss")
            lateMemory.complete(JSONObject())
            runCurrent()
            assertSame(ready, schedules)
            assertNull(vm.memory.value)

            vm.closeSchedules()
            vm.chatOpenerManage = { _, _, _, callback -> schedulesLost = callback; pendingSchedules }
            vm.openSchedules(ref)
            runCurrent()
            vm.closeSchedules()
            use(SchedulesTestLink(ChatClient.MEMORY.toSet()))
            vm.openMemory(ref)
            runCurrent()
            val readyMemory = vm.memory.value
            assertEquals(ChatMemory.Phase.READY, readyMemory?.phase)
            schedulesLost("Late Schedules loss")
            lateSchedules.complete(scheduleTestList(ref.address))
            runCurrent()
            assertSame(readyMemory, vm.memory.value)
            assertNull(vm.schedules.value)
        } finally {
            lateMemory.complete(JSONObject())
            lateSchedules.complete(JSONObject())
        }
    }
}
