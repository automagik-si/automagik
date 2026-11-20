package ai.namastex.automagik

import android.app.Application
import android.content.Context
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
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
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
// A plain application keeps the GitHub updater idle while the test exercises foregrounding.
@Config(sdk = [35], application = Application::class)
class PocketViewModelPairTest {
    private val dispatcher = StandardTestDispatcher()
    /** Keep the view model’s init loops parked, as in the chat tests. */
    private val initDispatcher = StandardTestDispatcher()
    private val pausedLookup = StandardTestDispatcher(TestCoroutineScheduler())
    private val ticketA = "endpoint" + "a".repeat(24)
    private val ticketB = "endpoint" + "b".repeat(24)
    private val desktopA = "6d35626dc129f365026a5cb104f735bb"
    private val desktopB = "abcdef012345f365026a5cb104f735bb"
    private val ssh = HostProfile("ssh", "Workstation", "workstation.example", "phone", session = "work", linked = listOf("Laptop"))
    private lateinit var vm: PocketViewModel
    private lateinit var backend: FakeBackend
    private var chatOpens = 0

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        val app: Application = ApplicationProvider.getApplicationContext()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        backend = FakeBackend(mutableMapOf(ticketA to desktopA, ticketB to desktopB))
        vm = PocketViewModel(app, initDispatcher)
        vm.pocketLink = backend
        vm.linkDispatcher = dispatcher
        vm.chatOpener = { _, _, _ -> chatOpens++; throw IOException("No chat in this test") }
    }

    @After fun tearDown() {
        vm.viewModelScope.cancel()
        Dispatchers.resetMain()
    }

    private class FakeBackend(val ids: MutableMap<String, String>) : PocketLinkBackend {
        val pairedTickets = mutableListOf<String>()
        val openedTickets = mutableListOf<String>()
        var replyName = "Desktop"
        var pairFailure: IOException? = null

        override fun desktopId(ticket: String): String = ids[ticket] ?: throw IOException("Unreadable ticket")
        override suspend fun pair(context: Context, link: PairingLink, device: String): String {
            pairedTickets += link.ticket
            pairFailure?.let { throw it }
            return replyName
        }
        override suspend fun open(context: Context, ticket: String, session: String, scope: CoroutineScope): IrohTransport {
            openedTickets += ticket
            throw IOException("No session in this test")
        }
    }

    private fun link(ticket: String) = "herdr-pocket://pair?v=1&n=Link%20label&c=Zx9_-aB3cD4eF5gH6iJ7kQ&t=$ticket"

    /** Run this lookup only when the test drains [pausedLookup]’s scheduler. */
    private fun offerWithPausedLookup(ticket: String) {
        vm.linkDispatcher = pausedLookup
        vm.offerPairing(link(ticket))
        vm.linkDispatcher = dispatcher
    }

    @Test fun externalPairingSavesWithoutOpeningUntilConnect() = runTest(dispatcher) {
        backend.replyName = "  Work\u202Est\u200Bation\u2028\u2029\n  "
        vm.offerPairing(link(ticketA))
        runCurrent()
        val offer = checkNotNull(vm.state.value.offeredPairing)
        assertEquals("6d35 626d c129", offer.fingerprint)
        assertNull(offer.known)
        assertTrue(backend.pairedTickets.isEmpty())

        vm.confirmOfferedPairing(offer.id)
        assertNull(vm.state.value.offeredPairing)
        runCurrent()
        val saved = vm.state.value.hosts.single()
        assertEquals("Workstation", saved.name)
        assertEquals(ticketA, saved.ticket)
        assertEquals("6d35 626d c129", pairedKey(saved))
        assertEquals("Paired with Workstation. Connect it in Settings when you’re ready.", vm.state.value.message)
        assertEquals(listOf(ticketA), backend.pairedTickets)
        assertTrue(backend.openedTickets.isEmpty())

        vm.refreshAll()
        vm.resumeWatching()
        vm.saveHost(saved.copy(session = "other"))
        vm.setForeground(true)
        vm.streams(true)
        runCurrent()
        assertTrue(backend.openedTickets.isEmpty())
        assertEquals(0, chatOpens)

        vm.reconnect(saved.id)
        runCurrent()
        assertEquals(listOf(ticketA), backend.openedTickets)
        assertEquals(0, chatOpens)
    }

    @Test fun pastingInTheAppOpensASession() = runTest(dispatcher) {
        vm.pair(link(ticketA))
        runCurrent()
        assertEquals(listOf(ticketA), backend.openedTickets)
    }

    @Test fun scanningInTheAppOpensASession() = runTest(dispatcher) {
        vm.scanned(link(ticketA))
        runCurrent()
        assertEquals(listOf(ticketA), backend.openedTickets)
    }

    @Test fun invalidLinkClearsTheOfferWhileAnEarlierLookupIsPending() = runTest(dispatcher) {
        offerWithPausedLookup(ticketA)
        vm.offerPairing("invalid")
        pausedLookup.scheduler.runCurrent()
        runCurrent()
        assertNull(vm.state.value.offeredPairing)
        assertEquals(LegacySsh.NOT_A_LINK, vm.state.value.message)
    }

    @Test fun onlyTheLatestValidLinkIsOfferedWhenLookupsFinishInReverseOrder() = runTest(dispatcher) {
        offerWithPausedLookup(ticketA)
        vm.offerPairing(link(ticketB))
        runCurrent()
        val latest = checkNotNull(vm.state.value.offeredPairing)
        assertEquals(ticketB, latest.link.ticket)

        pausedLookup.scheduler.runCurrent()
        runCurrent()
        assertEquals(latest, vm.state.value.offeredPairing)
    }

    @Test fun anOlderLookupFailureLeavesTheLatestOfferAndMessageAlone() = runTest(dispatcher) {
        backend.ids.remove(ticketA)
        offerWithPausedLookup(ticketA)
        vm.offerPairing(link(ticketB))
        runCurrent()
        val latest = checkNotNull(vm.state.value.offeredPairing)
        assertEquals(ticketB, latest.link.ticket)

        pausedLookup.scheduler.runCurrent()
        runCurrent()
        assertEquals(latest, vm.state.value.offeredPairing)
        assertNull(vm.state.value.message)
    }

    @Test fun staleDialogCallbacksCannotConfirmOrDismissANewerOffer() = runTest(dispatcher) {
        vm.offerPairing(link(ticketA))
        runCurrent()
        val first = checkNotNull(vm.state.value.offeredPairing)

        vm.offerPairing(link(ticketB))
        assertNull(vm.state.value.offeredPairing)
        runCurrent()
        val latest = checkNotNull(vm.state.value.offeredPairing)
        assertEquals(ticketB, latest.link.ticket)

        vm.confirmOfferedPairing(first.id)
        vm.dismissOfferedPairing(first.id)
        runCurrent()
        assertTrue(backend.pairedTickets.isEmpty())
        assertEquals(latest, vm.state.value.offeredPairing)
    }

    @Test fun dismissingTheCurrentOfferKeepsAnOlderPendingLookupHidden() = runTest(dispatcher) {
        offerWithPausedLookup(ticketA)
        vm.offerPairing(link(ticketB))
        runCurrent()
        vm.dismissOfferedPairing(checkNotNull(vm.state.value.offeredPairing).id)
        assertNull(vm.state.value.offeredPairing)

        pausedLookup.scheduler.runCurrent()
        runCurrent()
        assertNull(vm.state.value.offeredPairing)
        assertTrue(backend.pairedTickets.isEmpty())
        assertTrue(vm.state.value.hosts.isEmpty())
    }

    @Test fun startingAnInAppPairingInvalidatesAPendingOffer() = runTest(dispatcher) {
        offerWithPausedLookup(ticketA)
        vm.pair(link(ticketB))
        runCurrent()
        pausedLookup.scheduler.runCurrent()
        runCurrent()
        assertNull(vm.state.value.offeredPairing)
        assertEquals(listOf(ticketB), backend.pairedTickets)
    }

    @Test fun aParserValidButUnreadableTicketIsRefusedBeforePairing() = runTest(dispatcher) {
        backend.ids.remove(ticketA)
        vm.offerPairing(link(ticketA))
        runCurrent()
        assertNull(vm.state.value.offeredPairing)
        assertEquals(LegacySsh.NOT_A_LINK, vm.state.value.message)
        assertTrue(backend.pairedTickets.isEmpty())
        assertTrue(vm.state.value.hosts.isEmpty())
    }

    @Test fun aKnownComputerKeepsItsCardAndUsesItsSavedName() = runTest(dispatcher) {
        backend.ids[ticketB] = desktopA
        val saved = HostProfile("saved", "Renamed workstation", desktopA.take(12), "", 0, session = "work", transport = "iroh", ticket = ticketA)
        vm.saveHost(saved)
        vm.offerPairing(link(ticketB))
        runCurrent()
        val offer = checkNotNull(vm.state.value.offeredPairing)
        assertEquals(saved, offer.known)

        vm.confirmOfferedPairing(offer.id)
        runCurrent()
        assertEquals(listOf(saved.copy(ticket = ticketB)), vm.state.value.hosts)
        assertEquals("Paired Renamed workstation again.", vm.state.value.message)
        assertEquals(listOf(ticketB), backend.pairedTickets)
        assertTrue(backend.openedTickets.isEmpty())
    }

    @Test fun aSuccessfulRepairScanReplacesTheSshCardAndKeepsItsSession() = runTest(dispatcher) {
        vm.saveHost(ssh)
        vm.repairWithQr(ssh.id)
        vm.scanned(link(ticketA))
        runCurrent()
        val saved = vm.state.value.hosts.single()
        assertTrue(saved.paired)
        assertEquals(ticketA, saved.ticket)
        assertEquals(ssh.session, saved.session)
        assertEquals(ssh.linked, saved.linked)
        assertEquals(listOf(ticketA), backend.openedTickets)
    }

    @Test fun aFailedRepairScanLeavesTheSshCardInPlace() = runTest(dispatcher) {
        backend.pairFailure = IOException("Pairing refused")
        vm.saveHost(ssh)
        vm.repairWithQr(ssh.id)
        vm.scanned(link(ticketA))
        runCurrent()
        assertEquals(listOf(ticketA), backend.pairedTickets)
        assertEquals(listOf(ssh), vm.state.value.hosts)
        assertEquals("Pairing refused", vm.state.value.message)
        assertTrue(backend.openedTickets.isEmpty())
    }
}
