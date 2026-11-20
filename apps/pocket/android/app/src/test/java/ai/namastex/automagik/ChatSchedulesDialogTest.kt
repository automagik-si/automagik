package ai.namastex.automagik

import ai.namastex.automagik.ChatSchedules.Phase
import android.app.Application
import android.os.Looper
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatSchedulesDialogTest {
    @get:Rule val compose = createComposeRule()
    private val ref = TerminalRef("box", "dsh:lead")
    private lateinit var vm: PocketViewModel

    @Before fun setUp() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        vm = PocketViewModel(app, StandardTestDispatcher())
    }

    @After fun tearDown() {
        vm.closeChat()
        vm.viewModelScope.cancel()
    }

    /** Run the IO completions posted to Robolectric's paused main looper before looking at state. */
    private fun awaitState(condition: () -> Boolean) {
        try { compose.waitUntil(10_000) { shadowOf(Looper.getMainLooper()).idle(); condition() } }
        catch (e: androidx.compose.ui.test.ComposeTimeoutException) {
            throw AssertionError("chat=${vm.chat.value?.error} schedules=${vm.schedules.value?.phase} offers=${vm.botSchedules.value}", e)
        }
    }

    private fun open(link: SchedulesTestLink, memory: SchedulesTestLink = SchedulesTestLink(ChatClient.MEMORY.toSet())) {
        vm.chatOpenerManage = { _, _, methods, _ ->
            when (methods) {
                ChatClient.SCHEDULES -> link
                ChatClient.MEMORY -> memory
                else -> SchedulesTestLink(emptySet(), subscribeFailure = true)
            }
        }
        compose.setContent { ChatPane(vm, ref, onShowTerminal = null, onBack = {}) }
        awaitState { vm.chat.value?.error == "Too many Bot chats" }
        compose.onNodeWithContentDescription("Bot schedules").performClick()
        awaitState { vm.schedules.value?.let { it.phase == Phase.READY || it.phase == Phase.CLOSED } == true }
    }

    @Test fun listRendersTheTaskTimingPrivacyAndTruncationWithStateSpecificButtons() {
        val link = SchedulesTestLink().apply {
            read = { terminal, _ ->
                when (reads.size) {
                    1 -> scheduleTestList(terminal, truncated = true)
                    2 -> scheduleTestList(terminal, listOf(scheduleTestTask(title = "Paused report", state = "paused",
                        timing = JSONObject().put("kind", "every").put("everySeconds", 3600))))
                    3 -> scheduleTestList(terminal, listOf(scheduleTestTask(title = "Finished report", state = "finished")))
                    else -> scheduleTestList(terminal, emptyList())
                }
            }
        }
        open(link)
        compose.onNodeWithText("Schedules").assertExists()
        compose.onNodeWithText("Task names and times go only between this phone and your computer, and the phone keeps them only while this is open.").assertExists()
        compose.onNodeWithText("Daily report").assertExists()
        compose.onNodeWithText("Scheduled · Next:", substring = true).assertExists()
        compose.onNodeWithText("Daily at 01:00 (UTC)").assertExists()
        compose.onNodeWithText("Some tasks aren't shown.").assertExists()
        compose.onNodeWithText("Pause").assertExists()
        compose.onNodeWithText("Rename").assertExists()
        compose.onNodeWithText("Resume").assertDoesNotExist()

        compose.onNodeWithText("Refresh").performClick()
        awaitState { link.reads.size == 2 && vm.schedules.value?.phase == Phase.READY }
        compose.onNodeWithText("Paused report").assertExists()
        compose.onNodeWithText("Every 1 hour").assertExists()
        compose.onNodeWithText("Resume").assertExists()
        compose.onNodeWithText("Rename").assertExists()
        compose.onNodeWithText("Pause").assertDoesNotExist()

        compose.onNodeWithText("Refresh").performClick()
        awaitState { link.reads.size == 3 && vm.schedules.value?.phase == Phase.READY }
        compose.onNodeWithText("Finished report").assertExists()
        compose.onNodeWithText("Rename").assertExists()
        compose.onNodeWithText("Pause").assertDoesNotExist()
        compose.onNodeWithText("Resume").assertDoesNotExist()

        compose.onNodeWithText("Refresh").performClick()
        awaitState { link.reads.size == 4 && vm.schedules.value?.phase == Phase.READY }
        compose.onNodeWithText("No scheduled tasks for this Bot.").assertExists()
    }

    @Test fun renameValidatesTheDraftAndSavesWithTheDisplayedRevision() {
        val link = SchedulesTestLink().apply { write = { call ->
            scheduleTestWrite("saved", scheduleTestTask(id = call.id, rev = "new", title = checkNotNull(call.title)))
        } }
        open(link)
        compose.onNodeWithText("Rename").performClick()
        compose.onNodeWithText("Rename task").assertExists()
        compose.onNode(hasSetTextAction()).performTextReplacement("   ")
        compose.onNodeWithText("Save").performClick()
        compose.onNodeWithText("Give the task a name").assertExists()
        assertEquals(emptyList<SchedulesTestLink.Write>(), link.writes.toList())
        compose.onNode(hasSetTextAction()).performTextReplacement("  Renamed report  ")
        compose.onNodeWithText("Save").performClick()
        awaitState { vm.schedules.value?.outcome == "Renamed." }
        assertEquals(listOf(SchedulesTestLink.Write("schedule.rename", ref.address, "x0000000000000001", "0000000000000001", "Renamed report")), link.writes.toList())
        compose.onNodeWithText("Rename task").assertDoesNotExist()
        compose.onNodeWithText("Renamed report").assertExists()
        compose.onNodeWithText("Renamed.").assertExists()
    }

    @Test fun aChangedRevisionOrRemovedRowDiscardsTheEditorAndItsDraft() {
        val task = ChatSchedules.Task("id", "v1", "Old title", "scheduled", ChatSchedules.Timing("at"))
        val original = ChatSchedules.State(ref.hostId, ref.address, 1, ChatSchedules.Listing(ref.address, listOf(task), false),
            phase = Phase.READY, grants = ChatClient.SCHEDULES.toSet())
        val current = mutableStateOf(original)
        compose.setContent { ChatSchedulesDialog(vm, current.value) }
        compose.onNodeWithText("Rename").performClick()
        compose.onNode(hasSetTextAction()).performTextReplacement("Discard me")
        val updated = task.copy(rev = "v2", title = "Current title")
        compose.runOnIdle { current.value = original.copy(listing = original.listing?.copy(tasks = listOf(updated))) }
        compose.onNodeWithText("Rename task").assertDoesNotExist()
        compose.onNodeWithText("Discard me").assertDoesNotExist()
        compose.onNodeWithText("Rename").performClick()
        compose.onNodeWithText("Rename task").assertExists()
        compose.onNode(hasSetTextAction() and hasText("Current title")).assertExists()
        compose.runOnIdle { current.value = original.copy(listing = original.listing?.copy(tasks = emptyList())) }
        compose.onNodeWithText("Rename task").assertDoesNotExist()
        compose.onNodeWithText("No scheduled tasks for this Bot.").assertExists()
    }

    @Test fun authorityLossLeavesOnlyOutcomeStatusAndClose() {
        val link = SchedulesTestLink().apply { write = { scheduleTestRefusal("revoked", applied = true) } }
        open(link)
        compose.onNodeWithText("Pause").performClick()
        awaitState { vm.schedules.value?.phase == Phase.CLOSED }
        compose.onNodeWithText("Saved on the computer, but This phone can't manage this Bot's schedules now.").assertExists()
        for (text in listOf("Schedules", "Daily report", "Refresh", "Pause", "Resume", "Rename"))
            compose.onNodeWithText(text).assertDoesNotExist()
        compose.onNodeWithText("Close").assertExists()
    }

    @Test fun confirmedSaveWithoutATaskDisablesItsButtonsUntilRefreshSuppliesTheRow() {
        val link = SchedulesTestLink().apply {
            write = { scheduleTestRefusal("unavailable", applied = true) }
            read = { terminal, _ -> if (reads.size == 1) scheduleTestList(terminal)
                else scheduleTestList(terminal, listOf(scheduleTestTask(rev = "new", state = "paused"))) }
        }
        open(link)
        compose.onNodeWithText("Pause").performClick()
        awaitState { vm.schedules.value?.needsRefresh?.isNotEmpty() == true }
        compose.onNodeWithText("Saved on the computer, but Schedules aren't available on the computer right now.").assertExists()
        compose.onNodeWithText("Daily report").assertExists()
        compose.onNodeWithText("Refresh to see its current state.").assertExists()
        compose.onNodeWithText("Pause").assertDoesNotExist()
        compose.onNodeWithText("Rename").assertDoesNotExist()
        compose.onNodeWithText("Refresh").performClick()
        awaitState { link.reads.size == 2 && vm.schedules.value?.phase == Phase.READY }
        compose.onNodeWithText("Refresh to see its current state.").assertDoesNotExist()
        compose.onNodeWithText("Resume").assertExists()
        compose.onNodeWithText("Rename").assertExists()
        assertEquals(listOf(ref.address to null, ref.address to null), link.reads.toList())
    }

    @Test fun aReturnedButStillUncertainRowAsksForASelectedRefresh() {
        val task = ChatSchedules.Task("id", "rev", "Returned task", "scheduled", ChatSchedules.Timing("at"))
        val locked = ChatSchedules.State(ref.hostId, ref.address, 1, ChatSchedules.Listing(ref.address, listOf(task), false),
            phase = Phase.READY, grants = ChatClient.SCHEDULES.toSet(), uncertain = task.id)
        compose.setContent { ChatSchedulesDialog(vm, locked) }
        compose.onNodeWithText("Returned task").assertExists()
        compose.onNodeWithText("Refresh to check this task first.").assertExists()
        compose.onNodeWithText("Refresh").assertExists()
        compose.onNodeWithText("Pause").assertDoesNotExist()
        compose.onNodeWithText("Rename").assertDoesNotExist()
    }

    @Test fun reopeningAfterCloseWhileWritingShowsTheEarlierChangeNoticeWithFreshTasks() {
        val pending = CompletableDeferred<JSONObject>()
        val link = SchedulesTestLink().apply { write = { pending.await() } }
        open(link)
        compose.onNodeWithText("Pause").performClick()
        awaitState { link.writes.size == 1 }
        compose.onNodeWithText("Close").performClick()
        awaitState { vm.schedules.value == null && link.closed }
        val fresh = SchedulesTestLink().apply { read = { terminal, _ -> scheduleTestList(terminal, emptyList()) } }
        vm.chatOpenerManage = { _, _, _, _ -> fresh }
        compose.onNodeWithContentDescription("Bot schedules").performClick()
        awaitState { vm.schedules.value?.phase == Phase.READY }
        compose.onNodeWithText(ChatSchedules.EARLIER_CHANGE).assertExists()
        compose.onNodeWithText("No scheduled tasks for this Bot.").assertExists()
        compose.onNodeWithText("Daily report").assertDoesNotExist()
        assertEquals(listOf(ref.address to null), fresh.reads.toList())
    }

    @Test fun lazyDiscoveryHidesOnlySchedulesUntilChatReconnects() {
        val legacy = SchedulesTestLink(ChatClient.MEMORY.toSet())
        val memory = SchedulesTestLink(ChatClient.MEMORY.toSet())
        open(legacy, memory)
        compose.onNodeWithText("Schedules aren't offered on this connection. If this keeps happening, update Pocket Link and Automagik on this computer.").assertExists()
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithContentDescription("Bot schedules").assertDoesNotExist()
        compose.onNodeWithContentDescription("Bot memory").performClick()
        awaitState { vm.memory.value?.phase == ChatMemory.Phase.READY }
        compose.onNodeWithText("Memory").assertExists()
        compose.onNodeWithText("Close").performClick()
        assertEquals(listOf(ref.address), memory.memoryReads.toList())
        assertEquals(0, legacy.reads.size + legacy.writes.size)
        compose.onNodeWithText("Reconnect").performClick()
        awaitState { vm.chat.value?.error == "Too many Bot chats" }
        compose.onNodeWithContentDescription("Bot schedules").assertExists()
    }
}
