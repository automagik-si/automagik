package ai.namastex.automagik

import android.app.Application
import android.content.Context
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class PocketViewModelHostsTest {
    @get:Rule val folder = TemporaryFolder()
    private val dispatcher = StandardTestDispatcher()
    private val initDispatcher = StandardTestDispatcher()
    private val pausedWrites = StandardTestDispatcher(TestCoroutineScheduler())
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val prefs = app.getSharedPreferences("pocket", 0)
    private val sshDir = File(app.noBackupFilesDir, "ssh")
    private val sealer = TestHostSealer()
    private val ticket = "endpoint" + "a".repeat(24)
    private val link = "herdr-pocket://pair?v=1&n=Label&c=Zx9_-aB3cD4eF5gH6iJ7kQ&t=$ticket"
    private val ssh = HostProfile("legacy", "Computer", "desktop", "phone", session = "work", linked = listOf("Linked"))
    private lateinit var store: HostStore
    private lateinit var vm: PocketViewModel
    private val backend = TestBackend()
    private var previousViewModel: PocketViewModel? = null
    private val sealed get() = File(folder.root, "hosts.sealed")

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        previousViewModel = PocketViewModel.current
        prefs.edit().clear().commit()
        store = HostStore(folder.root, prefs, { sealer }, syncDir = {}, rename = ::replaceHostRecord)
    }

    @After fun tearDown() {
        if (::vm.isInitialized) vm.viewModelScope.cancel()
        PocketViewModel.current = previousViewModel
        sshDir.deleteRecursively()
        Dispatchers.resetMain()
    }

    private fun startVm() {
        if (::vm.isInitialized) vm.viewModelScope.cancel()
        vm = PocketViewModel(app, initDispatcher, store)
        vm.pocketLink = backend
        vm.linkDispatcher = dispatcher
    }

    private class TestBackend : PocketLinkBackend {
        var pairs = 0
        var onPair: () -> Unit = {}
        val opens = mutableListOf<Pair<String, String>>()

        override fun desktopId(ticket: String) = "desktop-id"
        override suspend fun pair(context: Context, link: PairingLink, device: String): String {
            pairs++
            onPair()
            return "Desktop"
        }
        override suspend fun open(context: Context, ticket: String, session: String, scope: CoroutineScope): IrohTransport {
            opens += ticket to session
            throw IOException("No remote session in this test")
        }
    }

    @Test fun pairReportsSuccessOnlyAfterSealingTheTicket() = runTest(dispatcher) {
        startVm()
        prefs.edit().putString(HostStore.PREF, "[]").commit()
        backend.onPair = { vm.linkDispatcher = pausedWrites }
        vm.pair(link)
        runCurrent()
        assertTrue(vm.state.value.pairing)
        assertFalse(sealed.exists())
        assertTrue(backend.opens.isEmpty())
        assertNull(vm.state.value.message)

        vm.linkDispatcher = dispatcher
        pausedWrites.scheduler.runCurrent()
        runCurrent()
        val plaintext = JSONArray(sealer.open(sealed.readBytes()).toString(Charsets.UTF_8))
        assertEquals(ticket, plaintext.getJSONObject(0).getString("ticket"))
        assertFalse(prefs.contains(HostStore.PREF))
        assertEquals("Paired with Desktop", vm.state.value.message)
        assertEquals(listOf(ticket to "default"), backend.opens)
    }

    @Test fun failedRepairKeepsCardAndKeyUntilTheLocalSaveRetries() = runTest(dispatcher) {
        assertEquals(HostStore.Result.SAVED, store.write(JSONArray(listOf(ssh.json())).toString()))
        assertTrue(sshDir.mkdirs())
        File(sshDir, "old-key").writeText("old")
        startVm()
        sealer.failSeal = true

        vm.repairWithQr(ssh.id)
        vm.scanned(link)
        runCurrent()
        val paired = vm.state.value.hosts.single()
        assertEquals(ticket, paired.ticket)
        assertEquals(ssh.session, paired.session)
        assertEquals(ssh.linked, paired.linked)
        assertEquals(listOf(ticket to ssh.session), backend.opens)
        assertTrue(vm.state.value.message.orEmpty().contains("couldn’t save it yet"))
        assertEquals(listOf(ssh), store.load().hosts)
        assertTrue(sshDir.exists())

        sealer.failSeal = false
        vm.setForeground(true)
        runCurrent()
        assertEquals(listOf(paired), store.load().hosts)
        assertFalse(sshDir.exists())
        assertEquals(1, backend.pairs)
    }

    @Test fun blockedStartupPreservesWatchAndRefusesBothOfferAndPair() = runTest(dispatcher) {
        assertEquals(HostStore.Result.SAVED, store.write(JSONArray(listOf(ssh.json())).toString()))
        val original = sealed.readBytes()
        prefs.edit().putStringSet(WatchResume.PREF, setOf(ssh.id)).commit()
        sealer.failOpen = true
        startVm()
        val unreadable = vm.state.value.message.orEmpty()
        assertTrue(unreadable.startsWith("Saved computers can’t be read"))
        vm.setForeground(true)
        assertEquals(setOf(ssh.id), prefs.getStringSet(WatchResume.PREF, null))
        vm.offerPairing(link)
        runCurrent()
        assertNull(vm.state.value.offeredPairing)
        vm.pair(link)
        runCurrent()
        assertEquals(0, backend.pairs)
        assertEquals(unreadable, vm.state.value.message)
        assertArrayEquals(original, sealed.readBytes())
    }

    @Test fun blockedWriteRefusesPairUntilTheStoreCanBeReloaded() = runTest(dispatcher) {
        assertEquals(HostStore.Result.SAVED, store.write(JSONArray(listOf(ssh.json())).toString()))
        startVm()
        val original = sealed.readBytes()
        sealer.failOpen = true
        vm.saveHost(ssh.copy(name = "Unsaved"))
        runCurrent()
        vm.pair(link)
        runCurrent()
        assertEquals(0, backend.pairs)
        assertArrayEquals(original, sealed.readBytes())

        sealer.failOpen = false
        vm.offerPairing(link)
        runCurrent()
        assertNotNull(vm.state.value.offeredPairing)
        assertEquals(listOf(ssh), vm.state.value.hosts)
        vm.confirmOfferedPairing(checkNotNull(vm.state.value.offeredPairing).id)
        runCurrent()
        assertEquals(1, backend.pairs)
        assertEquals(listOf(ssh, vm.state.value.hosts.last()), store.load().hosts)
    }

    @Test fun removalSupersedesQueuedPairAndSuppressesItsSuccessAndConnect() = runTest(dispatcher) {
        startVm()
        backend.onPair = { vm.linkDispatcher = pausedWrites }
        vm.pair(link)
        runCurrent()
        vm.removeHost(vm.state.value.hosts.single().id)
        pausedWrites.scheduler.runCurrent()
        runCurrent()
        assertEquals(emptyList<HostProfile>(), store.load().hosts)
        assertEquals(listOf(true), sealer.creates)
        assertFalse(vm.state.value.pairing)
        assertNull(vm.state.value.message)
        assertTrue(backend.opens.isEmpty())
    }

    @Test fun identicalDirtyPairRetriesAndStaleEditorKeepsCurrentTicket() = runTest(dispatcher) {
        val paired = ssh.copy(transport = "iroh", ticket = "old-ticket")
        assertEquals(HostStore.Result.SAVED, store.write(JSONArray(listOf(paired.json())).toString()))
        startVm()
        sealer.failSeal = true
        vm.pair(link)
        runCurrent()
        assertTrue(vm.state.value.message.orEmpty().contains("couldn’t save it yet"))

        sealer.failSeal = false
        vm.pair(link)
        runCurrent()
        assertEquals("Paired Computer again.", vm.state.value.message)
        assertEquals(ticket, store.load().hosts?.single()?.ticket)
        vm.saveHost(paired.copy(name = "Renamed"))
        runCurrent()
        assertEquals(paired.copy(name = "Renamed", ticket = ticket), store.load().hosts?.single())

        val writes = sealer.creates.size
        vm.saveHost(vm.state.value.hosts.single())
        runCurrent()
        assertEquals(writes, sealer.creates.size)
    }

    @Test fun oversizedWriteSurfacesLimitAndForegroundLeavesItPending() = runTest(dispatcher) {
        startVm()
        vm.saveHost(ssh.copy(name = "é".repeat(HostStore.MAX_PLAIN)))
        runCurrent()
        assertEquals("Too many saved computers to save on this phone.", vm.state.value.message)
        vm.dismissMessage()
        vm.setForeground(true)
        runCurrent()
        assertNull(vm.state.value.message)
        assertFalse(sealed.exists())
        vm.saveHost(ssh)
        runCurrent()
        assertEquals(listOf(ssh), store.load().hosts)
    }

    @Test fun oversizedStartupMigrationReportsTheLimitAndKeepsThePref() = runTest(dispatcher) {
        val legacy = ssh.copy(name = "é".repeat(HostStore.MAX_PLAIN / 2))
        val raw = JSONArray(listOf(legacy.json())).toString()
        prefs.edit().putString(HostStore.PREF, raw).commit()
        startVm()
        initDispatcher.scheduler.runCurrent()
        assertEquals(listOf(legacy), vm.state.value.hosts)
        assertEquals("Too many saved computers to save on this phone.", vm.state.value.message)
        assertEquals(raw, prefs.getString(HostStore.PREF, null))
        assertFalse(sealed.exists())
    }
}
