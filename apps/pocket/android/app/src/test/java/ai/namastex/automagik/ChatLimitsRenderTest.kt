package ai.namastex.automagik

import android.app.Application
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The chat's limits as the screen draws them (#1333): the cut marker under a cut row, the Bot-chat variant that
 * points at the computer instead of a terminal, and the refused-too-long note. The rules had tests; the drawing
 * did not.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatLimitsRenderTest {
    @get:Rule val compose = createComposeRule()

    private lateinit var vm: PocketViewModel

    @Before fun setUp() {
        Dispatchers.setMain(StandardTestDispatcher())
        val app: Application = ApplicationProvider.getApplicationContext()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        vm = PocketViewModel(app, StandardTestDispatcher())
    }

    @After fun tearDown() {
        vm.viewModelScope.cancel()
        Dispatchers.resetMain()
    }

    private fun draw(row: Chat.Row, state: Chat.State, expanded: MutableMap<String, Boolean> = mutableStateMapOf()) {
        compose.setContent { ChatRowView(row, state, vm, { _, _ -> }, expanded) }
    }

    @Test fun aCutTerminalRowDrawsTheCutMarker() {
        val output = "x".repeat(Chat.OUTPUT_PREVIEW) + "…"
        draw(Chat.Row(id = "o1", kind = "tool-result", output = output), Chat.State("t1"),
            mutableStateMapOf("o1:result" to true))
        compose.onNodeWithText(Chat.CUT_NOTE).assertExists()
    }

    @Test fun aCutBotChatRowDrawsTheComputerMarkerNotTheTerminalOne() {
        draw(Chat.Row(id = "r1", kind = "text", role = "assistant", text = "a…", cut = true), Chat.State("dsh:s1"))
        compose.onNodeWithText(Chat.CUT_NOTE_DSH).assertExists()
        compose.onNodeWithText(Chat.CUT_NOTE).assertDoesNotExist()
    }

    @Test fun aCutTextRowOnATerminalChatKeepsTheTerminalMarker() {
        draw(Chat.Row(id = "r1", kind = "text", role = "assistant", text = "a…", cut = true), Chat.State("t1"))
        compose.onNodeWithText(Chat.CUT_NOTE).assertExists()
        compose.onNodeWithText(Chat.CUT_NOTE_DSH).assertDoesNotExist()
    }

    @Test fun aRefusedTooLongMessageDrawsItsLimit() {
        compose.setContent { MessageView(Chat.Message("m1", "a long answer", "refused", reason = "too-long"),
            Chat.State("t1"), onSendNow = {}, onCancel = {}, onRetry = {}) }
        compose.onNodeWithText("Not sent (too-long)").assertExists()
    }
}
