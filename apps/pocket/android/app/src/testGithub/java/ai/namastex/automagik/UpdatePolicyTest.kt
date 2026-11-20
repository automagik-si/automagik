package ai.namastex.automagik

import ai.namastex.automagik.UpdatePolicy.Route
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    private val hour = 60 * 60_000L
    private val minute = 60_000L

    @Test fun installsSilentlyOnlyOnAndroid12WithEverythingAllowed() {
        assertEquals(Route.SILENT, UpdatePolicy.route(sdk = 35, auto = true, canInstall = true, metered = false))
        assertEquals(Route.SILENT, UpdatePolicy.route(sdk = 31, auto = true, canInstall = true, metered = false))
    }

    @Test fun notifiesWhenSilentIsntPossibleOrWanted() {
        assertEquals("Android 11", Route.NOTIFY, UpdatePolicy.route(sdk = 30, auto = true, canInstall = true, metered = false))
        assertEquals("Android 8", Route.NOTIFY, UpdatePolicy.route(sdk = 26, auto = true, canInstall = true, metered = false))
        assertEquals("setting off", Route.NOTIFY, UpdatePolicy.route(sdk = 35, auto = false, canInstall = true, metered = false))
        assertEquals("installs not allowed", Route.NOTIFY, UpdatePolicy.route(sdk = 35, auto = true, canInstall = false, metered = false))
        assertEquals("phone plan", Route.NOTIFY, UpdatePolicy.route(sdk = 35, auto = true, canInstall = true, metered = true))
    }

    @Test fun neverInstallsUnderAnOpenTerminal() {
        assertFalse(UpdatePolicy.installNow(foreground = true, terminalOpen = true, sinceInputMs = 0))
        assertFalse(UpdatePolicy.installNow(foreground = true, terminalOpen = true, sinceInputMs = 5 * hour))
    }

    @Test fun waitsOnOtherScreensUntilLeftAlone() {
        assertFalse(UpdatePolicy.installNow(foreground = true, terminalOpen = false, sinceInputMs = 30_000))
        assertFalse(UpdatePolicy.installNow(foreground = true, terminalOpen = false, sinceInputMs = UpdatePolicy.IDLE_MS - 1))
        assertTrue(UpdatePolicy.installNow(foreground = true, terminalOpen = false, sinceInputMs = UpdatePolicy.IDLE_MS))
    }

    @Test fun installsAtOnceAwayFromTheApp() {
        assertTrue(UpdatePolicy.installNow(foreground = false, terminalOpen = true, sinceInputMs = 0))
        assertTrue(UpdatePolicy.installNow(foreground = false, terminalOpen = false, sinceInputMs = 0))
    }

    @Test fun comparesVersionCodes() {
        assertTrue(UpdatePolicy.isNewer(912346, 912345))
        assertFalse(UpdatePolicy.isNewer(912345, 912345))
        assertFalse(UpdatePolicy.isNewer(1, 912345))
    }

    @Test fun checksEverySixHoursAndOnOpenAfterAPause() {
        val now = 1_000 * hour
        assertTrue("never checked", UpdatePolicy.due(0, now))
        assertFalse(UpdatePolicy.due(now - 5 * hour, now))
        assertTrue(UpdatePolicy.due(now - 6 * hour, now))
        assertFalse("opened again soon", UpdatePolicy.due(now - 10 * minute, now, UpdatePolicy.OPEN_DEBOUNCE_MS))
        assertTrue("opened after a while", UpdatePolicy.due(now - 20 * minute, now, UpdatePolicy.OPEN_DEBOUNCE_MS))
        assertTrue("clock moved back", UpdatePolicy.due(now + hour, now))
    }

    @Test fun notifiesOncePerBuild() {
        assertTrue(UpdatePolicy.shouldNotify(912346, 0))
        assertFalse(UpdatePolicy.shouldNotify(912346, 912346))
        assertTrue(UpdatePolicy.shouldNotify(912400, 912346))
    }

    @Test fun saysUpdatedOnlyWhenTheInstalledBuildRuns() {
        assertTrue(UpdatePolicy.justUpdated(pending = 912346, installed = 912346))
        assertTrue("a newer build replaced it meanwhile", UpdatePolicy.justUpdated(pending = 912346, installed = 912400))
        assertFalse("still the old build", UpdatePolicy.justUpdated(pending = 912346, installed = 912345))
        assertFalse("nothing pending", UpdatePolicy.justUpdated(pending = 0, installed = 912345))
    }

    @Test fun takesTheNotesFirstLine() {
        assertEquals("Projects tab", UpdatePolicy.notesLine("\n- Projects tab\n- Tasks filter"))
        assertEquals("", UpdatePolicy.notesLine("  \n "))
        val long = UpdatePolicy.notesLine("x".repeat(300), max = 20)
        assertEquals(20, long.length); assertTrue(long.endsWith("…"))
    }
}
