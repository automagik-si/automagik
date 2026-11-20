package ai.namastex.automagik

import ai.namastex.automagik.ChatMemory.Op
import ai.namastex.automagik.ChatMemory.Phase
import android.app.Application
import android.os.Looper
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
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
class ChatMemoryNoticeDialogTest {
    @get:Rule val compose = createComposeRule()
    private val ref = TerminalRef("box", "dsh:lead")
    private val oldEntry = "Fixture old marker"
    private val draft = "Fixture draft marker"
    private val freshEntry = "Fixture fresh entry"
    private val notice = "A change you sent earlier may have been saved: check Memory on the computer."
    private lateinit var vm: PocketViewModel

    @Before fun setUp() {
        vm = PocketViewModel(ApplicationProvider.getApplicationContext<Application>(), StandardTestDispatcher())
    }

    @After fun tearDown() {
        vm.closeChat()
        vm.viewModelScope.cancel()
    }

    private fun awaitState(condition: () -> Boolean) {
        try {
            compose.waitUntil(10_000) { shadowOf(Looper.getMainLooper()).idle(); condition() }
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("chat=${vm.chat.value?.error} memory phase=${vm.memory.value?.phase} op=${vm.memory.value?.op}", e)
        }
    }

    private fun useMemoryLink(link: MemoryTestLink) {
        vm.chatOpenerManage = { _, _, methods, _ ->
            if (methods.isEmpty()) MemoryTestLink(emptySet(), subscribeFailure = true) else link
        }
    }

    private fun closeDuringAdd() {
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink().apply {
            read = { memoryTestReply(it, oldEntry) }
            add = { _, _ -> pending.await() }
        }
        useMemoryLink(link)
        compose.setContent { ChatPane(vm, ref, onShowTerminal = null, onBack = {}) }
        awaitState { vm.chat.value?.error == "Too many Bot chats" }
        compose.onNodeWithContentDescription("Bot memory").performClick()
        awaitState { vm.memory.value?.phase == Phase.READY }
        compose.onNodeWithText(oldEntry).assertExists()
        compose.onNode(hasSetTextAction() and hasText("New entry")).performTextInput(draft)
        compose.onNodeWithText("Add").performClick()
        awaitState { vm.memory.value?.op == Op.ADD && link.adds.singleOrNull() == (ref.address to draft) }
        compose.onNodeWithText("Close").performClick()
        awaitState { vm.memory.value == null }
    }

    @Test fun reopeningShowsTheNoticeWithoutTheOldEntryOrDraftWhileReading() {
        closeDuringAdd()
        val pending = CompletableDeferred<JSONObject>()
        val link = MemoryTestLink().apply { read = { pending.await() } }
        compose.runOnIdle { useMemoryLink(link) }
        compose.onNodeWithContentDescription("Bot memory").performClick()
        awaitState { vm.memory.value?.phase == Phase.LOADING && link.reads.singleOrNull() == ref.address }
        compose.onNodeWithText(notice).assertExists()
        compose.onNodeWithText(oldEntry).assertDoesNotExist()
        compose.onNodeWithText(draft).assertDoesNotExist()

        pending.complete(memoryTestReply(ref.address, freshEntry))
        awaitState { vm.memory.value?.phase == Phase.READY }
        compose.onNodeWithText(freshEntry).assertExists()
        compose.onNodeWithText(notice).assertExists()
        compose.onNodeWithText(oldEntry).assertDoesNotExist()
        compose.onNodeWithText(draft).assertDoesNotExist()
    }

    @Test fun reopeningWithoutMemoryReadShowsTheNoticeAndUnsupportedStatus() {
        closeDuringAdd()
        compose.runOnIdle { useMemoryLink(MemoryTestLink(emptySet())) }
        compose.onNodeWithContentDescription("Bot memory").performClick()
        awaitState { vm.memory.value?.phase == Phase.CLOSED }
        compose.onNodeWithText(notice).assertExists()
        compose.onNodeWithText(
            "Memory isn't offered on this connection. If this keeps happening, update Pocket Link and Automagik on this computer."
        ).assertExists()
    }
}
