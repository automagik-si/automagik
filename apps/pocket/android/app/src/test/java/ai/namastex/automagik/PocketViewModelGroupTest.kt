package ai.namastex.automagik

import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val ROOM = "dsh:room:r1"

internal fun groupApproval(id: String, name: String, open: Boolean = true, receipt: JSONObject? = null) =
    JSONObject().put("id", id).put("kind", "approval").put("name", name).put("open", open).put("answerable", open)
        .put("choices", JSONArray(listOf("allow", "deny"))).put("tool", "Bash").put("summary", "Run tests")
        .apply { if (receipt != null) put("receipt", receipt) }

internal fun groupSnapshot(approvals: List<JSONObject> = emptyList(), settled: List<JSONObject> = emptyList(),
                           status: String = "working", rows: JSONArray = JSONArray()) =
    JSONObject().put("type", "snapshot").put("title", "Launch").put("status", JSONObject().put("state", status))
        .put("rows", rows).put("reset", true).put("approval", JSONObject.NULL)
        .put("approvals", JSONArray(approvals)).put("settled", JSONArray(settled))

internal fun groupReceipt(id: String, by: String = "computer", outcome: String = "allow", name: String? = null) =
    JSONObject().put("id", id).put("by", by).put("outcome", outcome).put("at", 5)
        .apply { if (name != null) put("name", name) }

internal fun groupGone(reason: String) = JSONObject().put("type", "gone").put("reason", reason)

/** One fake chat link. Only its callbacks and scripted RPC replies advance the open pane. */
internal class GroupLink(private val rows: List<Chat.Terminal> = emptyList(), override val groups: Boolean = true) : ChatLink {
    override val dshWrite = true
    override val manage = (ChatClient.MEMORY + ChatClient.SCHEDULES + ChatClient.SETTINGS).toSet()
    override val attach = Attach.peer(offeredHello())
    val subscribed = CompletableDeferred<Unit>()
    val closed = CompletableDeferred<Unit>()
    private lateinit var event: (JSONObject) -> Unit
    var lost: (String) -> Unit = {}
    val listCalls = AtomicInteger()
    val sends = CopyOnWriteArrayList<Triple<String, String, Boolean>>()
    val retryOverloadCalls = AtomicInteger()
    val answers = CopyOnWriteArrayList<Pair<String, String>>()
    val interrupts = CopyOnWriteArrayList<String>()
    val backfills = CopyOnWriteArrayList<String>()
    val sendReplies = ConcurrentLinkedQueue<suspend () -> JSONObject>()
    val answerReplies = ConcurrentLinkedQueue<suspend () -> JSONObject>()
    var backfillReply: suspend () -> JSONArray = { JSONArray() }
    var interruptReply = sent()
    val unanswered = CompletableDeferred<JSONObject>()

    override suspend fun list(): List<Chat.Terminal> {
        listCalls.incrementAndGet()
        return rows
    }

    override suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit): Int {
        this.event = event
        subscribed.complete(Unit)
        return 1
    }

    fun emit(e: JSONObject) = event(e)
    fun approval(row: JSONObject) = emit(JSONObject().put("type", "approval").put("row", row))

    private fun sent() = JSONObject().put("ok", true).put("state", "sent")
    override suspend fun send(terminal: String, text: String, id: String) = recordSend(text, id, retry = false)

    override suspend fun send(terminal: String, text: String, id: String, retry: Boolean): JSONObject {
        retryOverloadCalls.incrementAndGet()
        return recordSend(text, id, retry)
    }

    private suspend fun recordSend(text: String, id: String, retry: Boolean): JSONObject {
        sends += Triple(text, id, retry)
        return sendReplies.poll()?.invoke() ?: sent()
    }

    override suspend fun answer(terminal: String, row: String, choice: String, text: String?): JSONObject {
        check(text == null)
        answers += row to choice
        return answerReplies.poll()?.invoke() ?: sent()
    }

    override suspend fun backfill(terminal: String, before: String, limit: Int): JSONArray {
        backfills += before
        return backfillReply()
    }

    override suspend fun interrupt(terminal: String): JSONObject {
        interrupts += terminal
        return interruptReply
    }

    override suspend fun sendHeld(terminal: String, id: String) = error("No held messages")
    override suspend fun cancelHeld(terminal: String, id: String) = error("No held messages")

    override fun close() {
        unanswered.cancel()
        closed.complete(Unit)
    }
}

/** A fresh fake link per hello, including the short-lived listing links. */
internal class GroupBridge(vararg links: GroupLink) {
    private val waiting = ConcurrentLinkedQueue(links.asList())
    val asked = CopyOnWriteArrayList<Boolean>()

    fun install(vm: PocketViewModel) {
        vm.chatOpenerAttach = { _, _, _, attachments, lost ->
            asked += attachments
            checkNotNull(waiting.poll()) { "Unexpected chat connection" }.also { it.lost = lost }
        }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PocketViewModelGroupTest {
    private val dispatcher = StandardTestDispatcher()
    // Keep the view model's background reads off the clock that drives chat reconnects.
    private val initDispatcher = StandardTestDispatcher(TestCoroutineScheduler())
    private val host = "box"
    private val room = TerminalRef(host, ROOM)
    private val bot = TerminalRef(host, "dsh:s1")
    private val a1 = groupApproval("a1", "Ana")
    private val a2 = groupApproval("a2", "Ben")
    private val a3 = groupApproval("a3", "Cid")
    private val groupRow = Chat.Terminal(ROOM, "", "dsh", "Launch", "working", "group", members = listOf("Ana", "Ben"))
    private val botRow = Chat.Terminal(bot.address, "", "dsh", "Lead", "idle", "session")
    private lateinit var vm: PocketViewModel
    private val chat get() = checkNotNull(vm.chat.value)

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        val app = ApplicationProvider.getApplicationContext<Application>()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        vm = PocketViewModel(app, initDispatcher)
        vm.chatIo = dispatcher
        vm.saveHost(HostProfile(host, "Box", "box", "phone", transport = "iroh"))
    }

    @After fun tearDown() {
        vm.closeChat()
        vm.viewModelScope.cancel()
        Dispatchers.resetMain()
    }

    private suspend fun await(result: CompletableDeferred<Unit>) = withContext(Dispatchers.IO) {
        withTimeout(10_000) { result.await() }
    }

    private suspend fun until(condition: () -> Boolean) = withContext(Dispatchers.IO) {
        withTimeout(10_000) { while (!condition()) delay(5) }
    }

    private suspend fun TestScope.open(link: GroupLink, vararg approvals: JSONObject, target: TerminalRef = room,
                                       rows: JSONArray = JSONArray()) {
        vm.openChat(target)
        snapshot(link, groupSnapshot(approvals.toList(), rows = rows))
    }

    private suspend fun TestScope.snapshot(link: GroupLink, event: JSONObject = groupSnapshot()) {
        await(link.subscribed)
        link.emit(event)
        runCurrent()
    }

    private fun TestScope.nextAttempt() {
        advanceTimeBy(Chat.RESUME_DELAYS_MS.first())
        runCurrent()
    }

    private fun TestScope.pastLadder() {
        advanceTimeBy(Chat.RESUME_DELAYS_MS.sum() + 1)
        runCurrent()
    }

    private suspend fun listed(): List<Chat.Terminal> {
        vm.loadBotChats(host)
        until { vm.botChats.value[host] != null }
        return vm.botChats.value.getValue(host)!!.getOrThrow()
    }

    @Test fun twoCardsOpenAndDenyOnOneAnswersOnlyThatId() = runTest(dispatcher) {
        val link = GroupLink()
        GroupBridge(link).install(vm)
        open(link, a1, a2)
        assertEquals(listOf("a1", "a2"), chat.approvals.map { it.id })
        vm.chatAnswer(chat.approvals.last(), "deny")
        runCurrent()
        assertEquals(listOf("a2" to "deny"), link.answers)
        link.approval(groupApproval("a2", "Ben", false, groupReceipt("a2", "phone", "deny", "Pixel")))
        assertEquals("a1", chat.approvals.single().id)
        assertEquals("Answered on the phone (Pixel): Deny", Chat.receiptText(chat.receipts.single()))
        assertTrue(chat.receipts.single().live)
        vm.chatAnswer(chat.approvals.single(), "allow-always")
        runCurrent()
        assertEquals(listOf("a2" to "deny"), link.answers)
    }

    @Test fun oneCardClosedOnTheComputerLeavesTheOtherAnswerable() = runTest(dispatcher) {
        val link = GroupLink()
        GroupBridge(link).install(vm)
        open(link, a1, a2)
        link.approval(groupApproval("a1", "Ana", false, groupReceipt("a1")))
        assertEquals("a2", chat.approvals.single().id)
        assertEquals(listOf("allow", "deny"), ChatActions.choices(chat, chat.approvals.single()))
        assertEquals("Answered on the computer: Allow", Chat.receiptText(chat.receipts.single()))
    }

    @Test fun aLateAnswerAfterEvictionClosesThatCardAsAway() = runTest(dispatcher) {
        val link = GroupLink()
        link.answerReplies.add { JSONObject("""{"ok":false,"state":"refused","reason":"settled"}""") }
        GroupBridge(link).install(vm)
        open(link, a1, a2)
        vm.chatAnswer(chat.approvals.last(), "deny")
        runCurrent()
        assertEquals(listOf("a2" to "deny"), link.answers)
        assertEquals("a1", chat.approvals.single().id)
        assertEquals("a2", chat.receipts.single().id)
        assertEquals(Chat.CLOSED_AWAY, Chat.receiptText(chat.receipts.single()))
        assertNull(chat.notice)
    }

    @Test fun reconnectReconcilesApprovalsAndSettled() = runTest(dispatcher) {
        val first = GroupLink()
        val second = GroupLink()
        val third = GroupLink()
        GroupBridge(first, second, third).install(vm)
        open(first, a1, a2)
        val replay = groupSnapshot(listOf(a1), listOf(groupReceipt("a2")))
        vm.reconnectChat()
        snapshot(second, replay)
        assertEquals("a1", chat.approvals.single().id)
        assertEquals("Answered on the computer while you were away: Allow", Chat.receiptText(chat.receipts.single()))
        val receipts = chat.receipts
        vm.reconnectChat()
        snapshot(third, replay)
        assertEquals(receipts, chat.receipts)
    }

    @Test fun theAutomaticReconnectReconcilesTheCardsTheGoneHid() = runTest(dispatcher) {
        val first = GroupLink()
        val second = GroupLink()
        GroupBridge(first, second).install(vm)
        open(first, a1, a2, a3)
        first.emit(groupGone("unavailable"))
        assertTrue(chat.hidden && chat.approvals.isEmpty())
        nextAttempt()
        snapshot(second, groupSnapshot(listOf(a1), listOf(groupReceipt("a2", "phone", name = "Pixel"))))
        assertFalse(chat.hidden)
        assertEquals("a1", chat.approvals.single().id)
        assertEquals(listOf("a2", "a3"), chat.receipts.map { it.id })
        assertEquals(listOf("Answered on the phone (Pixel) while you were away: Allow", Chat.CLOSED_AWAY), chat.receipts.map(Chat::receiptText))
    }

    @Test fun moreThanSixteenSettlementsKeepEveryOutcome() = runTest(dispatcher) {
        val first = GroupLink()
        val second = GroupLink()
        GroupBridge(first, second).install(vm)
        fun outcome(i: Int) = if (i % 2 == 0) "deny" else "allow"
        open(first, *(1..20).map { groupApproval("a$it", "Ana") }.toTypedArray())
        for (i in 1..20) first.approval(groupApproval("a$i", "Ana", false, groupReceipt("a$i", outcome = outcome(i))))
        assertEquals((1..20).map(::outcome), chat.receipts.map { it.outcome })
        vm.dismissReceipt("a20")
        val remaining = chat.receipts
        assertEquals(19, remaining.size)
        vm.reconnectChat()
        snapshot(second, groupSnapshot(settled = (5..20).map { groupReceipt("a$it", outcome = outcome(it)) }))
        assertEquals(remaining, chat.receipts)
    }

    @Test fun seventyClosuresKeepTheFirstOutcomeAcrossAReconnect() = runTest(dispatcher) {
        val first = GroupLink()
        val second = GroupLink()
        val third = GroupLink()
        GroupBridge(first, second, third).install(vm)
        open(first)
        for (i in 1..70) {
            first.approval(groupApproval("a$i", "Ana"))
            first.approval(groupApproval("a$i", "Ana", false, groupReceipt("a$i")))
        }
        first.emit(groupGone("unavailable"))
        nextAttempt()
        val replay = groupSnapshot(settled = (55..70).map { groupReceipt("a$it") })
        snapshot(second, replay)
        assertEquals(70, chat.receipts.size)
        assertEquals("a1" to "allow", chat.receipts.first().let { it.id to it.outcome })
        vm.dismissReceipt("a1")
        vm.reconnectChat()
        snapshot(third, replay)
        assertEquals((2..70).map { "a$it" }, chat.receipts.map { it.id })
    }

    @Test fun unknownThenSendAsNewSendsOneFreshIdWithoutRetry() = runTest(dispatcher) {
        val link = GroupLink()
        link.sendReplies.add { error("No reply") }
        link.sendReplies.add { JSONObject("""{"ok":false,"state":"unknown","id":"m1"}""") }
        GroupBridge(link).install(vm)
        open(link)

        vm.chatSend("hi", "m1")
        runCurrent()
        val maybe = chat.messages.single()
        assertEquals("maybe", maybe.state)
        vm.chatRetry(maybe)
        vm.chatRetry(maybe)
        runCurrent()
        val unknown = chat.messages.single()
        assertTrue(ChatActions.canSendAsNew(chat, unknown))
        assertEquals(listOf(Triple("hi", "m1", false), Triple("hi", "m1", true)), link.sends)

        vm.chatSendAsNew(unknown)
        vm.chatSendAsNew(unknown)
        runCurrent()
        val fresh = chat.messages.single()
        assertEquals("sent", fresh.state)
        assertNotEquals("m1", fresh.id)
        assertEquals(3, link.sends.size)
        assertEquals(Triple("hi", fresh.id, false), link.sends.last())
    }

    @Test fun aSendWhoseReplyTheBridgeDroppedStaysMaybeAndRetries() = runTest(dispatcher) {
        val first = GroupLink()
        val second = GroupLink()
        first.sendReplies.add { first.unanswered.await() }
        second.sendReplies.add { JSONObject("""{"ok":false,"state":"unknown","id":"m1"}""") }
        GroupBridge(first, second).install(vm)
        open(first)
        vm.chatSend("hi", "m1")
        runCurrent()
        assertEquals("sending", chat.messages.single().state)
        assertEquals(listOf(Triple("hi", "m1", false)), first.sends)
        first.emit(groupGone("unavailable"))
        nextAttempt()
        snapshot(second)
        await(first.closed)
        runCurrent()
        val m = chat.messages.single()
        assertEquals("maybe", m.state)
        assertNull(chat.notice)
        vm.chatRetry(m)
        runCurrent()
        assertEquals(listOf(Triple("hi", "m1", true)), second.sends)
        assertTrue(ChatActions.canSendAsNew(chat, chat.messages.single()))
    }

    @Test fun aGoneBetweenAdmissionAndDispatchSendsNothing() = runTest(dispatcher) {
        for (reason in listOf("not-shown", "unavailable")) {
            val link = GroupLink()
            GroupBridge(link).install(vm)
            val rows = JSONArray().put(JSONObject().put("id", "$ROOM:1").put("kind", "text"))
            open(link, a1, rows = rows)
            vm.chatSend("hi", "m1")
            vm.chatEarlier()
            vm.chatAnswer(chat.approvals.single(), "allow")
            vm.chatInterrupt()
            assertEquals("sending", chat.messages.single().state)
            link.emit(groupGone(reason))
            runCurrent()
            assertTrue(link.sends.isEmpty() && link.backfills.isEmpty() && link.answers.isEmpty() && link.interrupts.isEmpty())
            assertTrue(chat.rows.isEmpty())
            if (reason == "unavailable") {
                assertTrue(chat.hidden)
                assertEquals("maybe", chat.messages.single().state)
            } else assertTrue(chat.messages.isEmpty())
            vm.closeChat()
        }
    }

    @Test fun aBotChatRetryNeverAddsRetry() = runTest(dispatcher) {
        val link = GroupLink(groups = false)
        link.sendReplies.add { error("No reply") }
        GroupBridge(link).install(vm)
        open(link, target = bot)
        vm.chatSend("hi", "m1")
        until { vm.chat.value?.messages?.singleOrNull()?.state == "maybe" }
        vm.chatRetry(chat.messages.single())
        until { vm.chat.value?.messages?.singleOrNull()?.state == "sent" }
        assertEquals(List(2) { Triple("hi", "m1", false) }, link.sends)
        assertEquals(0, link.retryOverloadCalls.get())
    }

    @Test fun aGroupPaneAsksNoAttachmentsAndOffersNoManagement() = runTest(dispatcher) {
        val first = GroupLink()
        val second = GroupLink()
        val bridge = GroupBridge(first, second)
        bridge.install(vm)
        open(first)
        vm.openMemory(room)
        vm.openSchedules(room)
        vm.openSettings(room)
        runCurrent()
        assertNull(vm.memory.value)
        assertNull(vm.schedules.value)
        assertNull(vm.settings.value)
        assertEquals(Attach.Peer.NotAsked, vm.attachments.state.value.peer)
        assertEquals(listOf(false), bridge.asked)
        open(second, target = bot)
        assertEquals(listOf(false, true), bridge.asked)
    }

    @Test fun goneClearsTheGroupPaneAndDropsLateCompletions() = runTest(dispatcher) {
        val list = GroupLink(listOf(botRow, groupRow))
        val first = GroupLink()
        val second = GroupLink(groups = false)
        val bridge = GroupBridge(list, first, second)
        bridge.install(vm)
        listed()
        val row = JSONObject().put("id", "$ROOM:1").put("kind", "text").put("text", "hello")
        val send = CompletableDeferred<JSONObject>()
        val earlier = CompletableDeferred<JSONArray>()
        first.sendReplies.add { send.await() }
        first.backfillReply = { earlier.await() }
        open(first, a1, rows = JSONArray().put(row))
        vm.chatSend("hi", "m1")
        vm.chatEarlier()
        runCurrent()
        assertEquals(listOf("$ROOM:1"), first.backfills)
        assertEquals(1, first.sends.size)

        first.emit(groupGone("unavailable"))
        send.complete(JSONObject("""{"ok":true,"state":"sent"}"""))
        earlier.complete(JSONArray().put(JSONObject(row.toString()).put("id", "$ROOM:0")))
        runCurrent()
        assertTrue(chat.rows.isEmpty() && chat.approvals.isEmpty() && chat.hidden)
        assertEquals("maybe", chat.messages.single().state)
        assertEquals(1, chat.wiped)
        nextAttempt()
        await(second.closed)
        runCurrent()
        assertTrue(chat.gone && chat.messages.isEmpty() && chat.cards.isEmpty())
        assertFalse(second.subscribed.isCompleted)
        assertEquals(listOf(botRow), vm.botChats.value[host]?.getOrNull())
        pastLadder()
        assertEquals(listOf(false, false, false), bridge.asked)
    }

    @Test fun goneNotShownEndsTheGroupWithoutResuming() = runTest(dispatcher) {
        for (reason in listOf("not-shown", "deleted")) {
            val list = GroupLink(listOf(botRow, groupRow))
            val link = GroupLink()
            val bridge = GroupBridge(list, link)
            bridge.install(vm)
            assertEquals(listOf(botRow, groupRow), listed())
            open(link, a1)
            link.emit(groupGone(reason))
            runCurrent()
            assertTrue(chat.gone && chat.approvals.isEmpty())
            assertNotNull(chat.error)
            val remaining = vm.botChats.value[host]!!.getOrThrow()
            assertEquals(listOf(botRow), remaining)
            assertTrue(ChatGroups.rows(mapOf(host to remaining)).isEmpty())
            pastLadder()
            assertEquals(2, bridge.asked.size)
            vm.closeChat()
        }
    }

    @Test fun transportLossHidesTheGroupUntilManualReconnect() = runTest(dispatcher) {
        val first = GroupLink()
        val second = GroupLink()
        val bridge = GroupBridge(first, second)
        bridge.install(vm)
        val rows = JSONArray().put(JSONObject().put("id", "$ROOM:1").put("kind", "text").put("text", "Hello"))
        open(first, a1, rows = rows)
        first.lost("Connection lost")
        assertTrue(chat.hidden && chat.rows.isEmpty() && chat.approvals.isEmpty())
        assertEquals(1, chat.wiped)
        pastLadder()
        assertEquals(1, bridge.asked.size)
        vm.reconnectChat()
        snapshot(second, groupSnapshot(listOf(a1), rows = rows))
        assertFalse(chat.hidden)
        assertEquals("Hello", chat.rows.single().text)
        assertEquals("a1", chat.approvals.single().id)
    }

    @Test fun groupsListOnlyWithTheGrantAndStayOutOfTheWatchAndTheCache() = runTest(dispatcher) {
        val rows = listOf(botRow, groupRow)
        GroupBridge(GroupLink(rows, groups = false), GroupLink(rows)).install(vm)
        val before = vm.state.value.machines
        assertEquals(listOf(botRow), listed())
        val dsh = mapOf(host to listed())
        assertEquals(rows, dsh[host])
        assertEquals(setOf(ChatWatch.key(host, bot.address)), vm.chatWatch.value.keys)
        assertEquals(listOf(bot.address), Cockpit.chats(dsh, vm.chatWatch.value, mapOf(host to true), emptyList(), 100).agents.map { it.first.address })
        assertEquals(listOf(room), ChatGroups.rows(dsh).map { it.first })
        assertEquals(before, vm.state.value.machines)
        for (machine in vm.state.value.machines.values) {
            assertTrue(machine.terminals.none { Chat.isGroup(it.address) })
            assertTrue(machine.bots.values.none { names -> names.bots.keys.any(Chat::isGroup) })
            assertTrue(machine.members.values.flatten().none { Chat.isGroup(it.id) })
        }
    }

    @Test fun anOpenGroupKeepsItsHomeRowInStep() = runTest(dispatcher) {
        val list = GroupLink(listOf(groupRow))
        val link = GroupLink()
        GroupBridge(list, link).install(vm)
        listed()
        open(link)
        val status = JSONObject().put("type", "status").put("status", JSONObject().put("state", "blocked").put("kind", "permission"))
            .put("title", "Renamed").put("approvals", 0)
        link.emit(status)
        runCurrent()
        fun listedGroup() = vm.botChats.value[host]!!.getOrThrow().single()
        assertEquals(groupRow.copy(title = "Renamed", status = "blocked", kind = "permission"), listedGroup())
        assertEquals(Chat.WAITING_ON_COMPUTER, ChatGroups.waiting(listedGroup()))
        link.emit(status.put("approvals", 2))
        runCurrent()
        assertEquals("2 approvals", ChatGroups.waiting(listedGroup()))
        assertEquals(1, list.listCalls.get())
        assertEquals(0, link.listCalls.get())
    }

    @Test fun stopReportsAPartialFailure() = runTest(dispatcher) {
        val link = GroupLink()
        link.interruptReply = JSONObject("""{"ok":false,"state":"failed","reason":"x"}""")
        GroupBridge(link).install(vm)
        open(link)
        vm.chatInterrupt()
        runCurrent()
        assertEquals(listOf(ROOM), link.interrupts)
        assertEquals(Chat.STOP_PARTLY, chat.notice)
    }
}
