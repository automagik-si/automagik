package ai.namastex.automagik

import ai.namastex.automagik.ChatMemory.Op
import ai.namastex.automagik.ChatMemory.Phase
import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PocketViewModelMemoryNoticeTest {
    private val dispatcher = StandardTestDispatcher()
    private val ref = TerminalRef("box", "dsh:lead")
    private lateinit var vm: PocketViewModel
    private val memory get() = checkNotNull(vm.memory.value)

    @Before fun setUp() {
        val initDispatcher = StandardTestDispatcher()
        Dispatchers.setMain(dispatcher)
        vm = PocketViewModel(ApplicationProvider.getApplicationContext<Application>(), initDispatcher)
        vm.linkDispatcher = StandardTestDispatcher(dispatcher.scheduler)
    }

    @After fun tearDown() {
        vm.closeChat()
        vm.viewModelScope.cancel()
        dispatcher.scheduler.runCurrent()
        Dispatchers.resetMain()
    }

    private fun TestScope.open(link: MemoryTestLink = MemoryTestLink(), target: TerminalRef = ref) {
        vm.chatOpenerManage = { _, _, _, _ -> link }
        vm.openMemory(target)
        runCurrent()
        assertEquals(Phase.READY, memory.phase)
    }

    private fun TestScope.startHeldAdd() {
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink().apply { add = { _, _ -> pending.await() } }
        open(link)
        vm.memoryAdd("Fixture draft")
        runCurrent()
        assertEquals(Op.ADD, memory.op)
        assertEquals(listOf(ref.address to "Fixture draft"), link.adds.toList())
    }

    @Test fun closingDuringAddShowsTheNoticeOnceAndIgnoresTheLateReply() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val first = MemoryTestLink().apply { add = { _, _ -> withContext(NonCancellable) { pending.await() } } }
        try {
            open(first)
            vm.memoryAdd("Fixture draft")
            runCurrent()
            assertEquals(Op.ADD, memory.op)
            assertEquals(listOf(ref.address to "Fixture draft"), first.adds.toList())
            vm.closeMemory()
            assertNull(vm.memory.value)

            open(MemoryTestLink().apply { read = { memoryTestReply(it, "Fresh fixture") } })
            val reopened = memory
            assertEquals(ChatMemory.EARLIER_CHANGE, reopened.notice)
            pending.complete(memoryTestReply(ref.address, "Late fixture", "saved"))
            runCurrent()
            assertSame(reopened, memory)
            assertEquals("Fresh fixture", memory.snapshot?.entries?.single()?.text)
            assertNull(memory.outcome)

            vm.closeMemory()
            open()
            assertNull(memory.notice)
        } finally {
            pending.cancel()
            runCurrent()
        }
    }

    @Test fun closingDuringEditShowsTheNotice() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink().apply { edit = { _, _ -> pending.await() } }
        open(link)
        val entry = checkNotNull(memory.snapshot).entries.single()
        vm.memoryEdit(entry, "Edited fixture")
        runCurrent()
        assertEquals(Op.EDIT, memory.op)
        assertEquals(listOf(listOf(ref.address, entry.id, entry.rev, "Edited fixture")), link.edits.toList())
        vm.closeMemory()
        open()
        assertEquals(ChatMemory.EARLIER_CHANGE, memory.notice)
    }

    @Test fun closingWhileCheckingAnAcknowledgedSaveShowsTheNotice() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink().apply {
            add = { _, _ -> JSONObject().put("ok", true).put("state", "saved") }
            read = { terminal -> if (reads.size == 1) memoryTestReply(terminal) else pending.await() }
        }
        open(link)
        vm.memoryAdd("Fixture draft")
        runCurrent()
        assertEquals(Phase.RECONCILING, memory.phase)
        assertEquals(Op.READ, memory.op)
        assertEquals(ChatMemory.SAVED, memory.outcome)
        assertEquals(2, link.reads.size)
        vm.closeMemory()
        open()
        assertEquals(ChatMemory.EARLIER_CHANGE, memory.notice)
    }

    @Test fun closingAfterFailedReconciliationShowsTheNoticeEvenWhenIdle() = runTest(dispatcher) {
        open(MemoryTestLink().apply {
            add = { _, _ -> JSONObject() }
            read = { terminal -> if (reads.size == 1) memoryTestReply(terminal) else memoryTestRefusal("unavailable") }
        })
        vm.memoryAdd("Fixture draft")
        runCurrent()
        assertEquals(Phase.READ_FAILED, memory.phase)
        assertEquals(Op.NONE, memory.op)
        assertEquals(ChatMemory.UNCONFIRMED, memory.outcome)
        vm.closeMemory()
        open()
        assertEquals(ChatMemory.EARLIER_CHANGE, memory.notice)
    }

    @Test fun dismissingAnUnconfirmedClosedDialogShowsTheNotice() = runTest(dispatcher) {
        open(MemoryTestLink().apply {
            add = { _, _ -> JSONObject() }
            read = { terminal -> if (reads.size == 1) memoryTestReply(terminal) else memoryTestRefusal("private") }
        })
        vm.memoryAdd("Fixture draft")
        runCurrent()
        assertEquals(Phase.CLOSED, memory.phase)
        assertEquals(Op.NONE, memory.op)
        assertEquals(ChatMemory.UNCONFIRMED, memory.outcome)
        vm.closeMemory()
        open()
        assertEquals(ChatMemory.EARLIER_CHANGE, memory.notice)
    }

    @Test fun closingAfterSuccessfulReconciliationShowsNoNotice() = runTest(dispatcher) {
        val link = MemoryTestLink().apply { add = { _, _ -> JSONObject() } }
        open(link)
        vm.memoryAdd("Fixture draft")
        runCurrent()
        assertEquals(2, link.reads.size)
        assertEquals(Phase.READY, memory.phase)
        assertEquals(Op.NONE, memory.op)
        assertEquals("${ChatMemory.UNCONFIRMED} The list shows what the computer has now.", memory.outcome)
        vm.closeMemory()
        open()
        assertNull(memory.notice)
    }

    @Test fun closingAfterAnAcknowledgedSaveWithASnapshotShowsNoNotice() = runTest(dispatcher) {
        val link = MemoryTestLink()
        open(link)
        vm.memoryAdd("Saved fixture")
        runCurrent()
        assertEquals(1, link.reads.size)
        assertEquals(Phase.READY, memory.phase)
        assertEquals(Op.NONE, memory.op)
        assertEquals(ChatMemory.SAVED, memory.outcome)
        assertEquals("Saved fixture", memory.snapshot?.entries?.single()?.text)
        vm.closeMemory()
        open()
        assertNull(memory.notice)
    }

    @Test fun closingWithoutAWriteShowsNoNotice() = runTest(dispatcher) {
        open()
        vm.closeMemory()
        open()
        assertNull(memory.notice)
    }

    @Test fun switchingScopesTheNoticeToTheOriginalHostAndBot() = runTest(dispatcher) {
        startHeldAdd()
        open(target = ref.copy(hostId = "other-box"))
        assertNull(memory.notice)
        open(target = ref.copy(address = "dsh:other"))
        assertNull(memory.notice)
        open()
        val reopened = memory
        assertEquals(ChatMemory.EARLIER_CHANGE, reopened.notice)
        vm.openMemory(ref)
        runCurrent()
        assertSame(reopened, memory)
        vm.closeMemory()
        open()
        assertNull(memory.notice)
    }

    @Test fun backgroundingDuringAddShowsTheNotice() = runTest(dispatcher) {
        startHeldAdd()
        vm.streams(false)
        assertNull(vm.memory.value)
        vm.streams(true)
        open()
        assertEquals(ChatMemory.EARLIER_CHANGE, memory.notice)
    }

    @Test fun leavingTheChatDuringAddShowsTheNotice() = runTest(dispatcher) {
        startHeldAdd()
        vm.closeChat()
        assertNull(vm.memory.value)
        open()
        assertEquals(ChatMemory.EARLIER_CHANGE, memory.notice)
    }

    @Test fun routeLossDuringAddKeepsTheExistingStatusAndShowsTheNoticeOnReopen() = runTest(dispatcher) {
        lateinit var lost: (String) -> Unit
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink().apply { add = { _, _ -> pending.await() } }
        vm.chatOpenerManage = { _, _, _, callback -> lost = callback; link }
        vm.openMemory(ref)
        runCurrent()
        vm.memoryAdd("Fixture draft")
        runCurrent()
        assertEquals(Op.ADD, memory.op)

        lost("Disconnected")
        runCurrent()
        val closed = memory
        assertEquals(Phase.CLOSED, closed.phase)
        assertEquals(Op.NONE, closed.op)
        assertEquals("The connection closed before the computer answered. The change may have been saved: open Memory again to check.", closed.status)
        assertNull(closed.outcome)
        assertNull(closed.notice)
        lost("Duplicate loss")
        runCurrent()
        assertSame(closed, memory)

        vm.openMemory(ref)
        runCurrent()
        assertSame(closed, memory)
        vm.closeMemory()
        open()
        assertEquals(ChatMemory.EARLIER_CHANGE, memory.notice)
    }
}
