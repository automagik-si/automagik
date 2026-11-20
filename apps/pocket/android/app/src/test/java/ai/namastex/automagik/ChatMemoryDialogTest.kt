package ai.namastex.automagik

import ai.namastex.automagik.ChatMemory.Phase
import android.app.Application
import android.os.Looper
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
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
class ChatMemoryDialogTest {
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

    /** Waits for [condition]; a timeout names the chat and memory state it saw. */
    private fun awaitState(condition: () -> Boolean) {
        // Robolectric's paused main looper: run what IO completions posted to Main before each look.
        try { compose.waitUntil(10_000) { shadowOf(Looper.getMainLooper()).idle(); condition() } }
        catch (e: androidx.compose.ui.test.ComposeTimeoutException) {
            throw AssertionError("chat=${vm.chat.value?.let { it.error to it.dshWrite }} memory=${vm.memory.value} manage=${vm.botManage.value}", e)
        }
    }

    private fun open(link: MemoryTestLink) {
        vm.chatOpenerManage = { _, _, methods, _ ->
            if (methods.isEmpty()) MemoryTestLink(emptySet(), subscribeFailure = true) else link
        }
        compose.setContent { ChatPane(vm, ref, onShowTerminal = null, onBack = {}) }
        awaitState { vm.chat.value?.error == "Too many Bot chats" }
        compose.onNodeWithContentDescription("Bot memory").performClick()
        awaitState { vm.memory.value?.let { it.phase == Phase.READY || it.phase == Phase.CLOSED } == true }
    }

    @Test fun readOnlyMemoryRendersTheEntryAndFooterWithoutWriteControls() {
        open(MemoryTestLink(setOf("memory.read")))
        compose.onNodeWithText("A fact").assertExists()
        compose.onNodeWithText("Main memory: 6 of 2000 characters").assertExists()
        compose.onNodeWithText("Refresh").assertExists()
        compose.onNodeWithText("Edit").assertDoesNotExist()
        compose.onNodeWithText("Add").assertDoesNotExist()
    }

    @Test fun addUsesTheViewModelAndDoesNotExposeAnUngrantedEdit() {
        val link = MemoryTestLink(setOf("memory.read", "memory.add"))
        open(link)
        compose.onNodeWithText("Edit").assertDoesNotExist()
        compose.onNode(hasSetTextAction()).performTextInput("New fact")
        compose.onNodeWithText("Add").performClick()
        awaitState { vm.memory.value?.outcome == "Saved." }
        assertEquals(listOf(ref.address to "New fact"), link.adds.toList())
        compose.onNodeWithText("New fact").assertExists()
        compose.onNodeWithText("Saved.").assertExists()
    }

    @Test fun editIsGrantedSeparatelyAndClosesWhenARefreshReplacesTheEntries() {
        val link = MemoryTestLink(setOf("memory.read", "memory.edit"))
        open(link)
        compose.onNodeWithText("Add").assertDoesNotExist()
        compose.onNodeWithText("Edit").performClick()
        compose.onNodeWithText("Edit memory").assertExists()
        compose.onNodeWithText("Save").assertExists()
        compose.onNodeWithText("Cancel").assertExists()
        compose.runOnIdle { vm.refreshMemory() }
        awaitState { link.reads.size == 2 && vm.memory.value?.op == ChatMemory.Op.NONE }
        compose.onNodeWithText("Edit memory").assertDoesNotExist()
        compose.onNodeWithText("A fact").assertExists()
    }

    @Test fun closedMemoryShowsTheUnconfirmedOutcomeWithThePrivateNotice() {
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink()
        link.add = { _, _ -> JSONObject().put("ok", false).put("state", "unknown") }
        link.read = { terminal -> if (link.reads.size == 1) memoryTestReply(terminal) else pending.await() }
        open(link)
        compose.runOnIdle { vm.memoryAdd("Maybe saved") }
        awaitState { vm.memory.value?.phase == Phase.RECONCILING }
        compose.onNodeWithText("The computer didn't confirm this change.").assertExists()
        compose.onNodeWithText("Checking…").assertExists()

        pending.complete(memoryTestRefusal("private"))
        awaitState { vm.memory.value?.phase == Phase.CLOSED }
        compose.onNodeWithText("The computer didn't confirm this change.").assertExists()
        compose.onNodeWithText("This Bot is private: its memory stays on the computer.").assertExists()
        compose.onNodeWithText("Checking…").assertDoesNotExist()
        compose.onNodeWithText("A fact").assertDoesNotExist()
        compose.onNodeWithText("Refresh").assertDoesNotExist()
        compose.onNodeWithText("Close").assertExists()
    }

    @Test fun aWriteAppliedBeforeBecomingPrivateShowsTheSavedNotice() {
        val link = MemoryTestLink().apply { add = { _, _ -> memoryTestRefusal("private", applied = true) } }
        open(link)
        compose.runOnIdle { vm.memoryAdd("Saved fact") }
        awaitState { vm.memory.value?.phase == Phase.CLOSED }
        compose.onNodeWithText("Saved on the computer, but This Bot is private: its memory stays on the computer.").assertExists()
        compose.onNodeWithText("A fact").assertDoesNotExist()
        compose.onNodeWithText("Add").assertDoesNotExist()
        compose.onNodeWithText("Close").assertExists()
    }

    @Test fun unsupportedMemoryHidesTheBarButtonUntilChatReconnects() {
        open(MemoryTestLink(emptySet()))
        compose.onNodeWithText("Memory isn't offered on this connection. If this keeps happening, update Pocket Link and Automagik on this computer.").assertExists()
        compose.onNodeWithText("Close").assertExists()
        compose.onNodeWithText("Memory").assertDoesNotExist()
        compose.onNodeWithText("Refresh").assertDoesNotExist()
        compose.onNodeWithText("Edit").assertDoesNotExist()
        compose.onNodeWithText("Add").assertDoesNotExist()
        compose.onNodeWithText("Close").performClick()
        assertEquals(false, vm.botManage.value[ref.hostId])
        compose.onNodeWithContentDescription("Bot memory").assertDoesNotExist()
        compose.onNodeWithText("Reconnect").performClick()
        awaitState { vm.chat.value?.error == "Too many Bot chats" }
        compose.onNodeWithContentDescription("Bot memory").assertExists()
    }
}
