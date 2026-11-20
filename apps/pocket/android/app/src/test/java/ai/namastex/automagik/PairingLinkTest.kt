package ai.namastex.automagik

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.json.JSONObject
import org.junit.Test

class PairingLinkTest {
    private val ticket = "endpoint" + "abcdefghijklmnopqrstuvwxyz234567".repeat(4)
    private val code = "Zx9_-aB3cD4eF5gH6iJ7kQ"

    @Test fun readsTheDesktopsLink() {
        assertEquals(PairingLink("MacBook Pro", code, ticket), PairingLink.parse("herdr-pocket://pair?v=1&n=MacBook%20Pro&c=$code&t=$ticket"))
        assertEquals("Herdr desktop", PairingLink.parse(" herdr-pocket://pair?v=1&c=$code&t=$ticket\n")?.name)
    }
    @Test fun refusesAnythingElse() {
        for (bad in listOf("https://pair?v=1&c=$code&t=$ticket", "herdr-pocket://other?v=1&c=$code&t=$ticket",
            "herdr-pocket://pair?v=2&c=$code&t=$ticket", "herdr-pocket://pair?v=1&c=short&t=$ticket",
            "herdr-pocket://pair?v=1&c=$code&t=notaticket", "herdr-pocket://pair?v=1&c=$code", "herdr-pocket://pair?v=1&t=$ticket", "", "garbage"))
            assertNull(bad, PairingLink.parse(bad))
    }
    @Test fun keepsNamesShortAndPrintable() {
        assertEquals("ab", PairingLink.parse("herdr-pocket://pair?v=1&n=a%0Ab&c=$code&t=$ticket")?.name)
        assertEquals(60, PairingLink.parse("herdr-pocket://pair?v=1&n=${"x".repeat(200)}&c=$code&t=$ticket")?.name?.length)
    }
    @Test fun pairedHostsRoundTripAndOldOnesAreLegacySsh() {
        val host = HostProfile("id", "Mac", "0123456789ab", "", 0, transport = "iroh", ticket = ticket)
        assertEquals(host, HostProfile.parse(host.json()))
        assertFalse(host.legacySsh)
        // A machine saved over SSH by an older version still loads, so it can be shown and paired again.
        val old = HostProfile.parse(JSONObject("""{"id":"a","name":"b","host":"c","user":"d"}"""))
        assertEquals("ssh", old.transport); assertTrue(old.legacySsh)
    }

    @Test fun theTerminalSaysPocketLink() {
        assertEquals("Pocket Link encrypted", HostProfile("id", "Mac", "0123456789ab", "", 0, transport = "iroh", ticket = ticket).encryption)
    }

    @Test fun formatsTheKeyLikePocketLink() {
        assertEquals("6d35 626d c129", keyFingerprint("6d35626dc129f365026a5cb104f735bb"))
        assertEquals("abc", keyFingerprint("abc"))
    }

    @Test fun dropsFormatCharactersAndSeparatorsFromTheLinkName() {
        val name = "%20%20Work%E2%80%AE%E2%80%8B%E2%80%A8%E2%80%A9%F3%A0%80%81station%20"
        assertEquals("Workstation", PairingLink.parse("herdr-pocket://pair?v=1&n=$name&c=$code&t=$ticket")?.name)
    }

    @Test fun recognizesASavedComputerByItsFullKey() {
        val link = PairingLink("Desktop", code, ticket)
        val desktop = "6d35626dc129f365026a5cb104f735bb"
        val collision = HostProfile("other", "Other desktop", desktop.take(12), "", 0, transport = "iroh", ticket = "other-ticket")
        val saved = collision.copy(id = "saved", name = "Saved desktop", ticket = "saved-ticket")
        val ids = mapOf(collision.ticket to "6d35626dc129f365026a5cb104f735bc", saved.ticket to desktop)
        val offer = PairingOffer.of(1L, link, desktop, listOf(collision, saved), ids::getValue)
        assertEquals(saved, offer.known)
        assertEquals("6d35 626d c129", offer.fingerprint)
        assertNull(PairingOffer.of(2L, link, desktop, listOf(collision), ids::getValue).known)
    }

    @Test fun skipsUnreadableAndLegacySavedTickets() {
        val link = PairingLink("Desktop", code, ticket)
        val desktop = "6d35626dc129f365026a5cb104f735bb"
        val saved = HostProfile("saved", "Saved desktop", desktop.take(12), "", 0, transport = "iroh", ticket = "saved-ticket")
        val ssh = saved.copy(id = "ssh", transport = "ssh")
        val unreadable = saved.copy(id = "unreadable", ticket = "bad-ticket")
        val ids = mapOf(saved.ticket to desktop)
        assertEquals(saved, PairingOffer.of(1L, link, desktop, listOf(ssh, unreadable, saved), ids::getValue).known)
        assertNull(PairingOffer.of(2L, link, desktop, listOf(ssh, unreadable), ids::getValue).known)
    }

    @Test fun onlyPairedCardsWithAStoredKeyPrefixHaveAFingerprint() {
        val saved = HostProfile("saved", "Desktop", "6d35626dc129", "", 0, transport = "iroh", ticket = ticket)
        assertEquals("6d35 626d c129", pairedKey(saved))
        assertNull(pairedKey(saved.copy(transport = "ssh")))
        assertNull(pairedKey(saved.copy(host = "6D35626DC129")))
        assertNull(pairedKey(saved.copy(host = "6d35626dc12")))
        assertNull(pairedKey(saved.copy(host = "desktop")))
    }
}
