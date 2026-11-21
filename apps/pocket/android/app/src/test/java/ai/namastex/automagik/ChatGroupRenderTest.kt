package ai.namastex.automagik

import android.app.Application
import android.os.Looper
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatGroupRenderTest {
    @get:Rule val compose = createComposeRule()
    private val room = TerminalRef("box", "dsh:room:r1")
    private lateinit var vm: PocketViewModel

    @Before fun setUp() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        AppLock.init(app)
        vm = PocketViewModel(app, StandardTestDispatcher())
    }

    @After fun close() {
        vm.closeChat()
        vm.viewModelScope.cancel()
    }

    private fun waitFor(condition: () -> Boolean) {
        compose.waitUntil(10_000) { shadowOf(Looper.getMainLooper()).idle(); condition() }
    }

    private fun snapshot(link: GroupLink, event: JSONObject = groupSnapshot()) {
        waitFor { link.subscribed.isCompleted }
        link.emit(event)
        waitFor { vm.chat.value?.connected == true }
        compose.waitForIdle()
    }

    private fun mount(first: GroupLink, vararg later: GroupLink, event: JSONObject = groupSnapshot()) {
        GroupBridge(first, *later).install(vm)
        compose.setContent { ChatPane(vm, room, onShowTerminal = null, onBack = {}) }
        snapshot(first, event)
    }

    private fun composer() = compose.onNode(hasSetTextAction())
    private fun assertEmptyDraft() {
        val node = composer().assertExists().fetchSemanticsNode()
        assertEquals("", node.config[SemanticsProperties.EditableText].text)
    }

    @Test fun twoCardsArriveAfterAnEmptySnapshotAndDenyOnOneLeavesTheOther() {
        val link = GroupLink()
        mount(link)
        link.approval(groupApproval("a1", "Ana"))
        link.approval(groupApproval("a2", "Ben"))
        compose.onNodeWithText("Ana needs your approval").assertExists()
        compose.onNodeWithText("Ben needs your approval").assertExists()
        compose.onAllNodesWithText("Allow").assertCountEquals(2)
        compose.onAllNodesWithText("Deny").assertCountEquals(2)[1].performClick()
        waitFor { link.answers.size == 1 }
        assertEquals(listOf("a2" to "deny"), link.answers)

        link.approval(groupApproval("a2", "Ben", false, groupReceipt("a2", "phone", "deny", "Pixel")))
        compose.onNodeWithText("Ana needs your approval").assertExists()
        compose.onNodeWithText("Ben needs your approval").assertDoesNotExist()
        compose.onAllNodesWithText("Allow").assertCountEquals(1)
        compose.onAllNodesWithText("Deny").assertCountEquals(1)
        compose.onNodeWithText("Answered on the phone (Pixel): Deny").assertExists()
    }

    @Test fun aGroupPaneHasNoManagementOrAttachmentControls() {
        val link = GroupLink()
        mount(link)
        compose.onNodeWithContentDescription("Bot memory").assertDoesNotExist()
        compose.onNodeWithContentDescription("Bot schedules").assertDoesNotExist()
        compose.onNodeWithContentDescription("Add images").assertDoesNotExist()
        compose.onNode(SemanticsMatcher("click labelled Bot settings") {
            it.config.getOrNull(SemanticsActions.OnClick)?.label == "Bot settings"
        }).assertDoesNotExist()
        compose.onNodeWithContentDescription("Interrupt").assertExists()
    }

    @Test fun goneClearsTheDraft() {
        val first = GroupLink()
        val second = GroupLink()
        val row = JSONObject().put("id", "${room.address}:1").put("kind", "text").put("role", "assistant")
            .put("name", "Ana").put("text", "Ready on the computer")
        mount(first, second, event = groupSnapshot(rows = JSONArray().put(row)))
        compose.onNodeWithText("Ana").assertExists()
        compose.onNodeWithText("Ready on the computer").assertExists()
        first.approval(groupApproval("a1", "Ana"))
        first.approval(groupApproval("a1", "Ana", false, groupReceipt("a1")))
        compose.onNodeWithText("Answered on the computer: Allow").assertExists()
        composer().performTextInput("hello")
        composer().assertTextContains("hello")
        first.emit(groupGone("not-shown"))
        composer().assertDoesNotExist()
        compose.onNodeWithText("Ready on the computer").assertDoesNotExist()
        compose.onNodeWithText("Answered on the computer: Allow").assertDoesNotExist()
        compose.onNodeWithText("Reconnect").performClick()
        snapshot(second)
        assertEmptyDraft()
    }

    @Test fun automaticReconnectClearsTheDraftAndHidesUnconfirmedMessagesUntilSnapshot() {
        val first = GroupLink()
        val second = GroupLink()
        first.sendReplies.add { error("No reply") }
        mount(first, second)
        compose.runOnIdle { vm.chatSend("unconfirmed", "m1") }
        waitFor { vm.chat.value?.messages?.singleOrNull()?.state == "maybe" }
        compose.onNodeWithText("Maybe not sent").assertExists()
        composer().performTextInput("hello")
        composer().assertTextContains("hello")
        first.emit(groupGone("unavailable"))
        composer().assertDoesNotExist()
        compose.onNodeWithText("Maybe not sent").assertDoesNotExist()

        val main = shadowOf(Looper.getMainLooper())
        main.idle()
        main.idleFor(Chat.RESUME_DELAYS_MS.first(), TimeUnit.MILLISECONDS)
        waitFor { second.subscribed.isCompleted }
        compose.onNodeWithText("Maybe not sent").assertDoesNotExist()
        snapshot(second)
        assertEmptyDraft()
        compose.onNodeWithText("Maybe not sent").assertExists()
    }

    @Test fun anUnknownSendShowsTheFreshSendWarning() {
        val link = GroupLink()
        link.sendReplies.add { error("No reply") }
        link.sendReplies.add { JSONObject("""{"ok":false,"state":"unknown","id":"m1"}""") }
        mount(link)
        compose.runOnIdle { vm.chatSend("hello", "m1") }
        waitFor { vm.chat.value?.messages?.singleOrNull()?.state == "maybe" }
        compose.onNodeWithText("Retry").performClick()
        waitFor { vm.chat.value?.messages?.singleOrNull()?.state == "unknown" }
        compose.onNodeWithText(Chat.UNKNOWN_SEND).assertExists()
        compose.onNodeWithText(Chat.SEND_AS_NEW_WARNING).assertExists()
        compose.onNodeWithText(Chat.SEND_AS_NEW).performClick()
        waitFor { vm.chat.value?.messages?.singleOrNull()?.state == "sent" }
        assertEquals(3, link.sends.size)
        assertEquals("hello", link.sends.last().first)
        assertNotEquals("m1", link.sends.last().second)
        assertFalse(link.sends.last().third)
    }

    @Test
    @Config(sdk = [35], qualifiers = "w320dp-h640dp")
    fun everyMemberNameIsReadableOnANarrowCard() {
        val names = listOf("Ana Alexandra Anderson", "Ben Benjamin Buchanan", "Cid Christopher Carter",
            "Dee Delilah Davidson", "Eve Elizabeth Edwards")
        val row = Chat.Terminal(room.address, "", "dsh", "Launch", "working", "group", members = names)
        val card = ChatGroups.card(row)
        compose.setContent {
            Column {
                GroupCard(row, "Machine") {}
                TerminalCard(card, "Machine", "Terminal") {}
            }
        }
        val lines = compose.onAllNodesWithText(names.joinToString(", "), useUnmergedTree = true).assertCountEquals(2)
        fun layout(node: SemanticsNodeInteraction): TextLayoutResult {
            val results = mutableListOf<TextLayoutResult>()
            node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(results)) }
            return results.single()
        }
        val group = layout(lines[0])
        assertTrue(group.lineCount > 2)
        assertFalse(group.hasVisualOverflow)
        assertTrue(group.layoutInput.text.text.endsWith(names.last()))
        val plain = layout(lines[1])
        assertEquals(2, plain.lineCount)
        assertTrue(plain.hasVisualOverflow)
    }
}
