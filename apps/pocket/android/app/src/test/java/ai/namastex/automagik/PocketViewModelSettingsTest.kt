package ai.namastex.automagik

import ai.namastex.automagik.ChatSettings.Op
import ai.namastex.automagik.ChatSettings.Phase
import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

internal class SettingsTestLink(override val manage: Set<String> = ChatClient.SETTINGS.toSet()) :
    ChatLink by SchedulesTestLink(emptySet()) {
    data class Write(val method: String, val terminal: String, val rev: String, val value: String)
    val reads = CopyOnWriteArrayList<String>()
    val writes = CopyOnWriteArrayList<Write>()
    val closed = CompletableDeferred<Unit>()
    override val isClosed get() = closed.isCompleted
    var read: suspend (String) -> JSONObject = { settingsReply(terminal = it) }
    var write: suspend (Write) -> JSONObject = { settingsReply("unchanged", terminal = it.terminal) }

    override suspend fun settingsRead(terminal: String): JSONObject { reads += terminal; return read(terminal) }
    override suspend fun settingsName(terminal: String, rev: String, name: String) = edit(Write("settings.name", terminal, rev, name))
    override suspend fun settingsModel(terminal: String, rev: String, model: String) = edit(Write("settings.model", terminal, rev, model))
    private suspend fun edit(request: Write): JSONObject { writes += request; return write(request) }
    override fun close() { closed.complete(Unit) }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PocketViewModelSettingsTest {
    private val dispatcher = StandardTestDispatcher()
    private val ref = TerminalRef("fixture-host", SETTINGS_BOT)
    private lateinit var vm: PocketViewModel
    private val settings get() = checkNotNull(vm.settings.value)
    private val rev get() = checkNotNull(settings.snapshot).settings.rev

    @Before fun setUp() {
        // Keep the view model's background loops on a separate scheduler from runTest.
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

    private fun use(link: SettingsTestLink, connected: ((String) -> Unit) -> Unit = {}) {
        vm.chatOpenerManage = { _, _, methods, lost ->
            assertEquals(ChatClient.SETTINGS, methods)
            connected(lost)
            link
        }
    }

    private fun rename(value: String = "Fixture Rename") = vm.settingsName(settings.token, rev, value)
    private fun pick() = vm.settingsModel(settings.token, rev, SETTINGS_OTHER_MODEL)

    @Test fun claimsOneOperationAndSendsOnlyTheDisplayedRevisionAndTrimmedName() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val link = SettingsTestLink().apply { write = { pending.await() } }
        use(link)
        vm.openSettings(ref)
        runCurrent()
        assertEquals(Phase.READY, settings.phase)
        assertEquals(true, vm.botSettings.value[ref.hostId])
        rename(" \uFEFFFixture Rename\u3000")
        rename("Fixture Duplicate")
        pick()
        vm.refreshSettings()
        runCurrent()
        assertEquals(listOf(SettingsTestLink.Write("settings.name", ref.address, SETTINGS_REV, "Fixture Rename")), link.writes)
        assertEquals(listOf(ref.address), link.reads)
        pending.complete(settingsReply("saved", rev = SETTINGS_NEXT_REV, name = "Fixture Rename"))
        runCurrent()
        assertEquals("Fixture Rename", settings.snapshot?.settings?.name)
        assertEquals(SETTINGS_NEXT_REV, rev)
        assertEquals(listOf(ref.address), link.reads)
        rename("a".repeat(41))
        runCurrent()
        assertEquals("Use 40 characters or fewer", settings.outcome)
        assertEquals(1, link.writes.size)
    }

    @Test fun oldRevisionAndOldDialogWithSameRevisionCannotDispatchAnEditorCallback() = runTest(dispatcher) {
        val first = SettingsTestLink()
        use(first)
        vm.openSettings(ref)
        runCurrent()
        val oldToken = settings.token
        val oldRev = rev
        val oldCallback = { vm.settingsName(oldToken, oldRev, "Fixture Old Callback") }
        rename()
        runCurrent()
        assertEquals(1, first.writes.size)
        first.read = { settingsReply(rev = SETTINGS_NEXT_REV) }
        vm.refreshSettings()
        runCurrent()
        oldCallback()
        runCurrent()
        assertEquals(1, first.writes.size)
        vm.closeSettings()
        runCurrent()
        assertTrue(first.isClosed)

        val second = SettingsTestLink()
        use(second)
        vm.openSettings(ref)
        runCurrent()
        assertEquals(oldRev, rev)
        oldCallback()
        runCurrent()
        assertTrue(second.writes.isEmpty())
        rename()
        runCurrent()
        assertEquals(1, second.writes.size)
    }

    @Test fun editorCallbacksRequireTheirOwnGrantEditableFlagAndCatalogEntry() = runTest(dispatcher) {
        val link = SettingsTestLink(setOf("settings.read", "settings.model"))
        use(link)
        vm.openSettings(ref)
        runCurrent()
        assertEquals(Phase.READY, settings.phase)
        pick()
        runCurrent()
        assertEquals("settings.model", link.writes.single().method)
        rename()
        vm.settingsModel(settings.token, rev, "example/unlisted")
        runCurrent()
        assertEquals(1, link.writes.size)
        link.read = { settingsReply(canModel = false, editableReason = "shell", entries = emptyList()) }
        vm.refreshSettings()
        runCurrent()
        pick()
        runCurrent()
        assertEquals(1, link.writes.size)
    }

    @Test fun unsentBridgeAndTransportBusyRefusalsKeepTheViewAndNeverReadBack() = runTest(dispatcher) {
        val link = SettingsTestLink().apply {
            write = {
                if (writes.size == 1) settingsRefusal("offline") else throw CoreError("busy", "fixture transport detail")
            }
        }
        use(link)
        vm.openSettings(ref)
        runCurrent()
        val snapshot = checkNotNull(settings.snapshot)
        rename()
        runCurrent()
        assertEquals("The computer didn't answer. The change wasn't sent.", settings.outcome)
        assertSame(snapshot, settings.snapshot)
        pick()
        runCurrent()
        assertEquals("The computer is busy. Try again in a moment.", settings.outcome)
        assertSame(snapshot, settings.snapshot)
        assertEquals(listOf(ref.address), link.reads)
        assertEquals(2, link.writes.size)
        assertTrue(settings.canEdit(Op.MODEL))
    }

    @Test fun unknownOrTimedOutWriteReadsOnceAndFailedCheckLocksWritesUntilRefresh() = runTest(dispatcher) {
        for (timedOut in listOf(false, true)) {
            val link = SettingsTestLink().apply {
                read = { terminal ->
                    if (reads.size == 2) settingsRefusal("rate") else settingsReply(terminal = terminal, rev =
                        if (reads.size == 1) SETTINGS_REV else SETTINGS_NEXT_REV)
                }
                write = {
                    if (timedOut) withTimeout(1) { awaitCancellation() }
                    else JSONObject("""{"ok":false,"state":"unknown","reason":"offline"}""")
                }
            }
            use(link)
            vm.openSettings(ref)
            runCurrent()
            assertEquals(Phase.READY, settings.phase)
            pick()
            testScheduler.advanceTimeBy(1)
            runCurrent()
            assertEquals(Phase.READ_FAILED, settings.phase)
            assertEquals(listOf(ref.address, ref.address), link.reads)
            rename()
            pick()
            runCurrent()
            assertEquals(1, link.writes.size)
            assertEquals(2, link.reads.size)
            vm.refreshSettings()
            runCurrent()
            assertEquals(3, link.reads.size)
            assertEquals(SETTINGS_NEXT_REV, rev)
            assertTrue(settings.canEdit(Op.MODEL))
            vm.closeSettings()
            runCurrent()
        }
    }

    @Test fun transportClosureDropsAReplyAndCarriesANoticeOnlyForTheWritingHostAndBot() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val link = SettingsTestLink().apply { write = { pending.await() } }
        lateinit var lost: (String) -> Unit
        use(link) { lost = it }
        vm.openSettings(ref)
        runCurrent()
        assertNotNull(settings.snapshot)
        pick()
        runCurrent()
        assertEquals(1, link.writes.size)
        link.close()
        pending.complete(settingsReply("saved", name = "Fixture Late Reply"))
        runCurrent()
        lost("fixture transport detail")
        runCurrent()
        assertEquals(Phase.CLOSED, settings.phase)
        assertEquals(ChatSettings.MAY_HAVE_CHANGED, settings.outcome)
        assertNull(settings.snapshot)
        assertEquals(1, link.reads.size)

        vm.closeSettings()
        for (other in listOf(TerminalRef("another-host", ref.address), TerminalRef(ref.hostId, "dsh:b-other"))) {
            use(SettingsTestLink())
            vm.openSettings(other)
            runCurrent()
            assertEquals(Phase.READY, settings.phase)
            assertNull(settings.notice)
            vm.closeSettings()
            runCurrent()
        }
        use(SettingsTestLink())
        vm.openSettings(ref)
        runCurrent()
        assertEquals(ChatSettings.EARLIER_CHANGE, settings.notice)
        assertEquals(SETTINGS_NAME, settings.snapshot?.settings?.name)
    }

    @Test fun authorityAndBackgroundPurgeCatalogNameLevelAndHostOutcome() = runTest(dispatcher) {
        for (background in listOf(false, true)) {
            val link = SettingsTestLink().apply {
                write = {
                    if (writes.size == 1) settingsReply("refused", "invalid").put("message", "Fixture host rule")
                    else settingsRefusal("unavailable", applied = true)
                }
            }
            use(link)
            vm.openSettings(ref)
            runCurrent()
            assertNotNull(settings.snapshot?.settings?.level)
            assertEquals(2, settings.snapshot?.models?.entries?.size)
            rename()
            runCurrent()
            assertEquals("Fixture host rule", settings.outcome)
            if (background) vm.streams(false) else pick()
            runCurrent()
            assertTrue(link.isClosed)
            assertEquals(listOf(ref.address), link.reads)
            if (background) assertNull(vm.settings.value)
            else {
                assertEquals(Phase.CLOSED, settings.phase)
                assertNull(settings.snapshot)
                assertEquals(ChatSettings.MAY_HAVE_CHANGED, settings.outcome)
                assertFalse(settings.toString().contains("Fixture host rule"))
            }
            vm.closeSettings()
        }
    }

    @Test fun closingWhileWritingDiscardsTheLateReplyAndShowsTheEarlierChangeOnce() = runTest(dispatcher) {
        val pending = CompletableDeferred<JSONObject>()
        val link = SettingsTestLink().apply { write = { pending.await() } }
        use(link)
        vm.openSettings(ref)
        runCurrent()
        assertEquals(SETTINGS_NAME, settings.snapshot?.settings?.name)
        rename()
        runCurrent()
        assertEquals(listOf(SettingsTestLink.Write("settings.name", ref.address, SETTINGS_REV, "Fixture Rename")), link.writes)
        vm.closeSettings()
        pending.complete(settingsReply("saved", name = "Fixture Rename"))
        runCurrent()
        assertTrue(link.isClosed)
        assertNull(vm.settings.value)
        assertEquals(listOf(ref.address), link.reads)

        repeat(2) { attempt ->
            use(SettingsTestLink())
            vm.openSettings(ref)
            runCurrent()
            assertEquals(SETTINGS_NAME, settings.snapshot?.settings?.name)
            assertEquals(ChatSettings.EARLIER_CHANGE.takeIf { attempt == 0 }, settings.notice)
            vm.closeSettings()
            runCurrent()
        }
    }
}
