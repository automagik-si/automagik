package ai.namastex.automagik

import android.app.Application
import android.net.Uri
import android.os.Looper
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CompletableDeferred
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
class ChatAttachRenderTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var vm: PocketViewModel
    private val ref = TerminalRef("box", "dsh:bot")
    private val uri = Uri.parse("content://fixture/image")

    @Before fun init() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        AppLock.init(app)
        vm = PocketViewModel(app, StandardTestDispatcher())
        vm.attachments.prepare = { picked, _ -> fakePrepared(picked) }
    }

    @After fun close() {
        vm.closeChat()
        vm.viewModelScope.cancel()
    }

    private fun waitFor(condition: () -> Boolean) {
        compose.waitUntil(10_000) { shadowOf(Looper.getMainLooper()).idle(); condition() }
    }

    private fun mount(link: AttachTestLink, target: TerminalRef = ref, vararg rows: JSONObject) {
        vm.chatOpenerAttach = { _, _, _, _, _ -> link }
        compose.setContent { ChatPane(vm, target, onShowTerminal = null, onBack = {}) }
        waitFor { link.subscribed.isCompleted }
        link.event(attachSnapshot(*rows))
        waitFor { vm.chat.value?.connected == true }
        compose.waitForIdle()
    }

    private fun pick(vararg picked: Uri) {
        compose.runOnIdle {
            assertNotNull(vm.attachments.pick())
            deliverAttachPick(vm.attachments, picked.toList())
        }
    }

    private fun add() = compose.onNodeWithContentDescription("Add images")
    private fun send() = compose.onNodeWithContentDescription("Send message")
    private fun field() = compose.onNode(hasSetTextAction())

    @Test fun addIsAbsentOnTerminalChats() {
        mount(AttachTestLink(), TerminalRef(ref.hostId, "t1"))
        add().assertDoesNotExist()
    }

    @Test fun unsupportedPeersUseTheSameAddTargetAndShowTheCorrespondingNotice() {
        mount(AttachTestLink(Attach.Peer.Missing))
        add().assertExists().assertWidthIsEqualTo(48.dp).performClick()
        compose.onNodeWithText(Attach.partWords(Attach.Peer.Missing)).assertExists()
        for (peer in listOf(Attach.Peer.App, Attach.Peer.None, Attach.Peer.Unusable, Attach.Peer.NotAsked)) {
            val new = AttachTestLink(peer)
            compose.runOnIdle {
                vm.chatOpenerAttach = { _, _, _, _, _ -> new }
                vm.reconnectChat()
            }
            waitFor { new.subscribed.isCompleted }
            new.event(attachSnapshot())
            waitFor { vm.chat.value?.connected == true }
            add().performClick()
            compose.onNodeWithText(Attach.partWords(peer)).assertExists()
            assertTrue(new.calls.isEmpty())
        }
    }

    @Test fun readOnlyAppMarkerNamesTheApp() {
        mount(AttachTestLink(Attach.Peer.App, dshWrite = false))
        compose.onNodeWithText(Attach.READ_ONLY_APP).assertExists()
        add().assertDoesNotExist()
    }

    @Test fun readOnlyMissingMarkerKeepsTheExistingLine() {
        mount(AttachTestLink(Attach.Peer.Missing, dshWrite = false))
        compose.onNodeWithText(ChatActions.READ_ONLY).assertExists()
        add().assertDoesNotExist()
    }

    @Test fun sendDuringPreparationKeepsCaptionAndWritesNoTextOrUpload() {
        val link = AttachTestLink()
        val blocked = CompletableDeferred<Unit>()
        vm.attachments.prepare = { picked, _ -> blocked.await(); fakePrepared(picked) }
        mount(link)
        try {
            field().performTextInput("hello")
            pick(uri)
            waitFor { vm.attachments.state.value.preparing == 1 }
            send().performClick()
            field().assertTextContains("hello")
            compose.onNodeWithText("Wait for the pictures to get ready.").assertExists()
            assertTrue(link.calls.isEmpty())
        } finally {
            blocked.complete(Unit)
        }
    }

    @Test fun missingReplacementOfferKeepsBothCaptionAndTrayWhenSendIsRefused() {
        val offered = AttachTestLink()
        mount(offered)
        field().performTextInput("hello")
        pick(uri)
        waitFor { vm.attachments.state.value.draft.isNotEmpty() }
        val missing = AttachTestLink(Attach.Peer.Missing)
        compose.runOnIdle {
            vm.chatOpenerAttach = { _, _, _, _, _ -> missing }
            vm.reconnectChat()
        }
        waitFor { missing.subscribed.isCompleted }
        missing.event(attachSnapshot())
        waitFor { vm.chat.value?.connected == true }
        send().performClick()
        field().assertTextContains("hello")
        compose.onNodeWithContentDescription("Remove image").assertExists()
        compose.onNodeWithText(Attach.partWords(Attach.Peer.Missing)).assertExists()
        assertTrue(offered.calls.isEmpty())
        assertTrue(missing.calls.isEmpty())
    }

    @Test fun acceptedImageOnlySendClearsTrayAndScrollsToTheUploadingBubble() {
        val link = AttachTestLink()
        val blocked = CompletableDeferred<Unit>()
        link.begin = { blocked.await(); link.open(it) }
        mount(link)
        try {
            compose.onNodeWithText("No messages yet.").assertExists()
            pick(uri)
            waitFor { vm.attachments.state.value.draft.size == 1 }
            send().assertIsEnabled().performClick()
            compose.onNodeWithContentDescription("Remove image").assertDoesNotExist()
            compose.onNodeWithText("Uploading 1 of 1 · 0%").assertIsDisplayed()
            compose.onNodeWithText("Cancel").assertExists()
            compose.onNodeWithText("No messages yet.").assertDoesNotExist()
            compose.onNodeWithText("Cancel").performClick()
            compose.onNodeWithContentDescription("Remove image").assertExists()
            assertTrue(link.calls.none { it.kind == "text" || it.kind == "send" })
        } finally {
            blocked.complete(Unit)
        }
    }

    @Test fun uploadProgressAndCancelDoNotOverwriteASecondCaption() {
        val first = Uri.parse("content://fixture/first")
        val second = Uri.parse("content://fixture/second")
        vm.attachments.prepare = { picked, _ -> fakePrepared(picked, if (picked == first) 45 else 55) }
        val link = AttachTestLink()
        val blocked = CompletableDeferred<Unit>()
        link.finish = { blocked.await(); link.admit(it) }
        mount(link)
        try {
            field().performTextInput("first caption")
            pick(first, second)
            waitFor { vm.attachments.state.value.draft.size == 2 }
            send().performClick()
            waitFor { vm.attachments.state.value.messages.single().progress == .45f }
            field().assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
            compose.onNodeWithText("Uploading 1 of 2 · 45%").assertExists()
            field().performTextInput("next caption")
            compose.onNodeWithText("Cancel").performClick()
            field().assertTextContains("next caption")
            compose.onNodeWithText("Cancelled: not sent").assertExists()
            compose.onNodeWithText("Send again").assertExists()
            compose.onNodeWithText("Remove").assertExists()
        } finally {
            blocked.complete(Unit)
        }
    }

    @Test fun aLostAckThenRefusalRequiresConfirmationBeforeSendingAsNew() {
        val link = AttachTestLink()
        link.sendImage = { JSONObject() }
        mount(link)
        pick(uri)
        waitFor { vm.attachments.state.value.draft.size == 1 }
        send().performClick()
        waitFor { vm.attachments.state.value.messages.singleOrNull()?.phase == Phase.MAYBE }
        compose.onNodeWithText("Maybe not sent").assertExists()
        link.sendImage = { attachRefusal("session-changed") }
        compose.onNodeWithText("Retry").performClick()
        waitFor { vm.attachments.state.value.messages.single().action == AttachAction.SEND_AGAIN }
        compose.onNodeWithText("Send as new").performClick()
        compose.onNodeWithText("Send as a new message?").assertExists()
        assertEquals(2, link.calls.count { it.kind == "send" })
        link.sendImage = { attachSuccess(it) }
        compose.onNodeWithText("Send", substring = false).performClick()
        waitFor { vm.attachments.state.value.messages.single().phase == Phase.SENT }
        val sent = link.calls.filter { it.kind == "send" }
        assertEquals(sent[0], sent[1])
        assertNotEquals(sent[0].id, sent[2].id)
    }

    @Test fun richRowsLoadOnTapAndRenderFileSummariesBesideLegacyText() {
        val link = AttachTestLink()
        link.readImage = { thumbnailReply() }
        val row = attachRow("dsh:s:2").put("blocks", JSONArray("""[
            {"type":"image","block":0,"mediaType":"image/png","width":2,"height":2},
            {"type":"file","block":1,"bytes":12288,"name":"notes.txt"},{"type":"more","count":3}]"""))
        mount(link, ref, attachRow("dsh:s:1", "Legacy words"), row)
        compose.onNodeWithText("Legacy words").assertExists()
        compose.onNodeWithText("Image · 2 × 2").assertExists()
        compose.onNodeWithText("File · notes.txt · 12 KB · on the computer").assertExists()
        compose.onNodeWithText("+3 more on the computer").assertExists()
        assertTrue(link.calls.isEmpty())
        compose.onNodeWithText("Show").performClick()
        waitFor { vm.attachments.state.value.shown.isNotEmpty() }
        compose.onNodeWithContentDescription("Image from the chat, 2 × 2").assertExists()
        assertEquals(listOf("read"), link.calls.map { it.kind })
    }

    @Test fun emptyRichRowHasNoBubbleSurface() {
        mount(AttachTestLink(), ref, attachRow("dsh:s:1").put("blocks", JSONArray()))
        compose.onNodeWithTag("chat-attachment-row").assertDoesNotExist()
    }
}
