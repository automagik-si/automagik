package ai.namastex.automagik

import ai.namastex.automagik.ChatSettings.Phase
import android.app.Application
import android.os.Looper
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import org.json.JSONArray
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
@Config(sdk = [35], qualifiers = "w320dp-h640dp")
class ChatSettingsDialogTest {
    @get:Rule val compose = createComposeRule()
    private val ref = TerminalRef("fixture-host", SETTINGS_BOT)
    private lateinit var vm: PocketViewModel
    private val pill = SemanticsMatcher("click labelled Bot settings") {
        it.config.getOrNull(SemanticsActions.OnClick)?.label == "Bot settings"
    }

    @Before fun setUp() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        vm = PocketViewModel(app, StandardTestDispatcher())
    }

    @After fun tearDown() {
        vm.closeChat()
        vm.viewModelScope.cancel()
    }

    private fun awaitState(condition: () -> Boolean) {
        try { compose.waitUntil(10_000) { shadowOf(Looper.getMainLooper()).idle(); condition() } }
        catch (e: ComposeTimeoutException) {
            throw AssertionError("settings phase=${vm.settings.value?.phase}, offer=${vm.botSettings.value[ref.hostId]}", e)
        }
    }

    private fun chatLink() = object : ChatLink by SchedulesTestLink(emptySet()) {
        override suspend fun list() = listOf(Chat.Terminal.parse(JSONObject().put("terminal", ref.address).put("title", "Test")))

        override suspend fun subscribe(terminal: String, after: String?, event: (JSONObject) -> Unit, closed: (String) -> Unit): Int {
            event(JSONObject().put("type", "snapshot").put("rows", JSONArray()).put("reset", true)
                .put("status", JSONObject().put("state", "working")))
            return 1
        }
    }

    private fun start(settings: () -> SettingsTestLink) {
        vm.chatOpenerManage = { _, _, methods, _ ->
            when (methods) {
                ChatClient.SETTINGS -> settings()
                ChatClient.MEMORY -> SchedulesTestLink(ChatClient.MEMORY.toSet())
                ChatClient.SCHEDULES -> SchedulesTestLink()
                else -> chatLink()
            }
        }
        compose.setContent { ChatPane(vm, ref, onShowTerminal = null, onBack = {}) }
        vm.loadBotChats(ref.hostId)
        awaitState { vm.botChats.value[ref.hostId]?.getOrNull()?.singleOrNull()?.title == "Test" }
        awaitState { vm.chat.value?.let { it.connected && it.status.state == "working" } == true }
    }

    private fun tapPill() {
        compose.onNode(pill and hasText("Test") and hasText("Working")).performSemanticsAction(SemanticsActions.OnClick) { it() }
    }

    private fun open() {
        tapPill()
        awaitState { vm.settings.value?.phase == Phase.READY }
        assertDetails()
    }

    private fun assertDetails() {
        compose.onNodeWithText("Bot settings").assertExists()
        compose.onNodeWithText(SETTINGS_NAME).assertExists()
        compose.onNodeWithText("Fixture Model One").assertExists()
        compose.onNodeWithText("Workspace").assertExists()
        compose.onNodeWithText("The level is changed on the computer.").assertExists()
    }

    private fun rename(draft: String) {
        compose.onNodeWithText("Rename").performClick()
        compose.onNodeWithText("Rename Bot").assertExists()
        compose.onNode(hasSetTextAction() and hasText("Bot name")).performTextReplacement(draft)
        compose.onNodeWithText("Save").performClick()
    }

    @Test fun narrowWorkingChatOpensViaTheMergedPillAndRenamesWithoutALevelControl() {
        val link = SettingsTestLink().apply {
            write = { settingsReply("saved", rev = SETTINGS_NEXT_REV, name = it.value) }
        }
        start { link }
        compose.onNode(pill and hasText("Test") and hasText("Working")).assertIsDisplayed()
        compose.onNodeWithContentDescription("Interrupt").assertIsDisplayed()
        open()
        compose.onNode(hasText("Workspace") and hasClickAction()).assertDoesNotExist()
        compose.onNode(hasText("Auto is on") and hasClickAction()).assertDoesNotExist()
        compose.onNodeWithText("Change level").assertDoesNotExist()

        rename("a".repeat(41))
        compose.onNodeWithText("Use 40 characters or fewer").assertExists()
        assertEquals(0, link.writes.size)
        compose.onNode(hasSetTextAction() and hasText("Bot name")).performTextReplacement("  Fixture Renamed  ")
        compose.onNodeWithText("Save").performClick()
        awaitState { vm.settings.value?.snapshot?.settings?.name == "Fixture Renamed" }
        assertEquals(listOf(SettingsTestLink.Write("settings.name", ref.address, SETTINGS_REV, "Fixture Renamed")), link.writes)
        compose.onNodeWithText("Fixture Renamed").assertExists()
        compose.onNodeWithText("Rename Bot").assertDoesNotExist()
    }

    @Test fun modelWritesRenderTheReturnedLevelAndReplaceThePickerOnSaveAndRefusal() {
        val link = SettingsTestLink().apply {
            read = { settingsReply(truncated = true).apply {
                getJSONObject("settings").getJSONObject("model").put("running", "example/chat")
            } }
            write = {
                if (writes.size == 1) settingsReply("saved", rev = SETTINGS_NEXT_REV, saved = SETTINGS_OTHER_MODEL,
                    label = "Fixture Model Two", auto = false,
                    entries = listOf(settingsChoice(SETTINGS_OTHER_MODEL, "Fixture Model Two"), settingsChoice("other/three", "Fixture Model Three")))
                else settingsReply("refused", "not-applied", saved = SETTINGS_OTHER_MODEL, label = "Fixture Model Two", auto = false)
                    .put("message", "The computer could not switch the Bot to that model, so it stays on its current one.")
            }
        }
        start { link }
        open()
        compose.onNodeWithText("Its chat runs example/chat now.").assertExists()
        compose.onNodeWithText("fixture-effort").assertDoesNotExist()
        compose.onNodeWithText("Change model").performClick()
        compose.onNodeWithText("Changing the model can turn Auto off.").assertExists()
        compose.onNodeWithText("Current model").assertExists()
        compose.onNodeWithText("More models are on the computer.").assertExists()
        compose.onNodeWithText("Fixture Model Two").performClick()
        awaitState { vm.settings.value?.outcome == "Saved." }
        compose.onNodeWithText(ChatSettings.AUTO_OFF).assertExists()
        compose.onNodeWithText("Auto is on").assertDoesNotExist()
        compose.onNodeWithText("Workspace").assertExists()
        compose.onNodeWithText("Change model").performClick()
        compose.onNodeWithText("Fixture Model Three").assertExists()
        compose.onNodeWithText("Fixture Model One").assertDoesNotExist()
        compose.onNodeWithText("Cancel").performClick()

        // The computer turns Auto back on before refusing the next pick.
        link.read = { settingsReply(rev = SETTINGS_NEXT_REV, saved = SETTINGS_OTHER_MODEL, label = "Fixture Model Two",
            entries = listOf(settingsChoice("other/three", "Fixture Model Three"))) }
        compose.onNodeWithText("Refresh").performClick()
        awaitState { vm.settings.value?.snapshot?.settings?.level?.auto == true }
        compose.onNodeWithText("Change model").performClick()
        compose.onNodeWithText("Fixture Model Three").performClick()
        awaitState { vm.settings.value?.outcome?.startsWith("The computer could not switch") == true }
        compose.onNodeWithText(ChatSettings.AUTO_OFF).assertExists()
        compose.onNodeWithText("Auto is on").assertDoesNotExist()
        compose.onNodeWithText("Fixture Model Two").assertExists()
        compose.onNodeWithText("Workspace").assertExists()
        assertEquals(listOf(
            SettingsTestLink.Write("settings.model", ref.address, SETTINGS_REV, SETTINGS_OTHER_MODEL),
            SettingsTestLink.Write("settings.model", ref.address, SETTINGS_NEXT_REV, "other/three")
        ), link.writes)
        assertEquals(listOf(ref.address, ref.address), link.reads)
    }

    @Test fun aNewRevisionDiscardsBothEditorsAndTheRenameDraft() {
        val initial = ChatSettings.State(ref.hostId, ref.address, 1, checkNotNull(ChatSettings.parse(settingsReply(), ref.address)),
            Phase.READY, grants = ChatClient.SETTINGS.toSet())
        val current = mutableStateOf(initial)
        compose.setContent { ChatSettingsDialog(vm, current.value) }
        assertDetails()
        compose.onNodeWithText("Rename").performClick()
        compose.onNode(hasSetTextAction() and hasText("Bot name")).performTextReplacement("Fixture Old Draft")
        compose.runOnIdle {
            current.value = initial.copy(snapshot = ChatSettings.parse(settingsReply(rev = SETTINGS_NEXT_REV), ref.address))
        }
        compose.onNodeWithText("Rename Bot").assertDoesNotExist()
        compose.onNodeWithText("Fixture Old Draft").assertDoesNotExist()
        compose.onNodeWithText("Change model").performClick()
        compose.onNodeWithText("Cancel").assertExists()
        compose.runOnIdle { current.value = initial }
        compose.onNodeWithText("Cancel").assertDoesNotExist()
    }

    @Test fun partialGrantAndEmptyCatalogLeaveOnlyAuthorizedEditorsUsable() {
        val link = SettingsTestLink(setOf("settings.read", "settings.model")).apply {
            write = { settingsReply("saved", rev = SETTINGS_NEXT_REV, entries = emptyList(), saved = null) }
        }
        start { link }
        open()
        compose.onNodeWithText("Change model").performClick()
        compose.onNodeWithText("Fixture Model Two").performClick()
        awaitState { vm.settings.value?.outcome == "Saved." }
        assertEquals(listOf(SettingsTestLink.Write("settings.model", ref.address, SETTINGS_REV, SETTINGS_OTHER_MODEL)), link.writes)
        compose.onNodeWithText("Rename").assertDoesNotExist()
        compose.onNodeWithText("Change model").assertIsNotEnabled()
        compose.onNodeWithText(ChatSettings.EMPTY_MODELS).assertExists()

        link.read = { settingsReply(canModel = false, editableReason = "host-model", entries = emptyList()) }
        compose.onNodeWithText("Refresh").performClick()
        awaitState { vm.settings.value?.snapshot?.settings?.editable?.model == false }
        compose.onNodeWithText("Change model").assertIsNotEnabled()
        compose.onNodeWithText("Its plugin chooses its model on the computer.").assertExists()
        compose.onNodeWithText(ChatSettings.EMPTY_MODELS).assertDoesNotExist()
    }

    @Test fun reconnectToAnUnsupportedBridgeHidesOnlySettingsAndReconnectRestoresDiscovery() {
        var link = SettingsTestLink()
        start { link }
        open()
        compose.runOnIdle { vm.reconnectChat() }
        awaitState { vm.chat.value?.connected == true && vm.botSettings.value[ref.hostId] == null }
        assertDetails()
        assertEquals(listOf(ref.address), link.reads)
        compose.onNodeWithText("Close").performClick()
        val legacy = SettingsTestLink(setOf("settings.model", "memory.read", "schedule.list"))
        link = legacy
        compose.runOnIdle { vm.reconnectChat() }
        awaitState { vm.chat.value?.connected == true && vm.botSettings.value[ref.hostId] == null }
        tapPill()
        awaitState { vm.settings.value?.phase == Phase.CLOSED }
        compose.onNodeWithText("Bot settings aren't offered on this connection.").assertExists()
        compose.onNodeWithText("Close").performClick()
        compose.onNode(pill).assertDoesNotExist()
        compose.onNodeWithText("Test").assertExists()
        assertEquals(0, legacy.reads.size + legacy.writes.size)

        compose.onNodeWithContentDescription("Bot memory").performClick()
        awaitState { vm.memory.value?.phase == ChatMemory.Phase.READY }
        compose.onNodeWithText("Memory").assertExists()
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithContentDescription("Bot schedules").performClick()
        awaitState { vm.schedules.value?.phase == ChatSchedules.Phase.READY }
        compose.onNodeWithText("Schedules").assertExists()
        compose.onNodeWithText("Close").performClick()
        link = SettingsTestLink()
        compose.runOnIdle { vm.reconnectChat() }
        awaitState { vm.chat.value?.connected == true && vm.botSettings.value[ref.hostId] == null }
        open()
    }

    @Test fun revocationClearsTheDraftAndOldHostMessageBeforeReopening() = verifyPrivacy(background = false)
    @Test fun backgroundingClearsTheDraftAndOldHostMessageBeforeReopening() = verifyPrivacy(background = true)

    private fun verifyPrivacy(background: Boolean) {
        var link = SettingsTestLink().apply {
            write = { settingsReply("refused", "invalid").put("message", "Fixture Host Rule") }
            read = { if (reads.size == 1) settingsReply() else settingsRefusal("revoked") }
        }
        start { link }
        open()
        rename("Fixture Refused Name")
        awaitState { vm.settings.value?.outcome == "Fixture Host Rule" }
        assertEquals(listOf(SettingsTestLink.Write("settings.name", ref.address, SETTINGS_REV, "Fixture Refused Name")), link.writes)
        compose.onNodeWithText("Fixture Host Rule").assertExists()
        compose.onNodeWithText("Rename").performClick()
        compose.onNode(hasSetTextAction() and hasText("Bot name")).performTextReplacement("Fixture Private Draft")
        compose.onNodeWithText("Fixture Private Draft").assertExists()

        compose.runOnIdle { if (background) vm.streams(false) else vm.refreshSettings() }
        awaitState { link.isClosed && (if (background) vm.settings.value == null else vm.settings.value?.phase == Phase.CLOSED) }
        for (text in listOf("Fixture Host Rule", "Fixture Private Draft", SETTINGS_NAME, "Fixture Model One", "Workspace"))
            compose.onNodeWithText(text).assertDoesNotExist()
        if (background) {
            compose.runOnIdle { vm.streams(true) }
            awaitState { vm.chat.value?.connected == true }
        } else {
            compose.onNodeWithText("Close").performClick()
        }

        link = SettingsTestLink()
        open()
        compose.onNodeWithText("Fixture Host Rule").assertDoesNotExist()
        compose.onNodeWithText("Rename").performClick()
        compose.onNode(hasSetTextAction() and hasText(SETTINGS_NAME)).assertExists()
        compose.onNodeWithText("Fixture Private Draft").assertDoesNotExist()
    }
}
