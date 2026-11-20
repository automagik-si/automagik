package ai.namastex.automagik

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockTest {
    @Test fun processStartIsLockedOnlyWhenEnabled() {
        assertEquals(AppLock.State(true, true, 1), AppLock.Policy(true).snapshot(0))
        val disabled = AppLock.Policy(false)
        assertEquals(AppLock.State(false, false, 0), disabled.snapshot(0))
        disabled.onStarted(0)
        disabled.onStopped(1)
        disabled.onStarted(60_001)
        assertEquals(AppLock.State(false, false, 0), disabled.snapshot(60_001))
    }

    @Test fun timeAwayIsCheckedBeforeTheFirstActivityStarts() {
        val policy = AppLock.Policy(true)
        policy.onStarted(0)
        policy.unlock()
        policy.onStopped(100)
        assertFalse(policy.locked(60_099))
        assertTrue(policy.locked(60_100))
        policy.onStarted(60_100)
        assertEquals(AppLock.State(true, true, 2), policy.snapshot(60_100))
        policy.unlock()
        assertEquals(AppLock.State(true, false, 2), policy.snapshot(60_100))
    }

    @Test fun aShortAbsenceKeepsTheUnlock() {
        val policy = AppLock.Policy(true)
        policy.onStarted(0)
        policy.unlock()
        policy.onStopped(100)
        policy.onStarted(60_099)
        assertEquals(AppLock.State(true, false, 1), policy.snapshot(60_100))
    }

    @Test fun switchingFromMainToTheScannerAndBackKeepsAnActivityStarted() {
        val policy = AppLock.Policy(true)
        policy.onStarted(0)
        policy.unlock()
        policy.onStarted(100)
        policy.onStopped(200)
        assertFalse(policy.locked(60_200))
        policy.onStarted(70_000)
        policy.onStopped(70_100)
        assertEquals(AppLock.State(true, false, 1), policy.snapshot(130_100))
    }

    @Test fun aSecondLongAbsenceWhileLockedKeepsTheEpisode() {
        val policy = AppLock.Policy(true)
        policy.onStarted(0)
        policy.unlock()
        policy.onStopped(100)
        policy.onStarted(60_100)
        policy.onStopped(60_200)
        policy.onStarted(120_200)
        assertEquals(AppLock.State(true, true, 2), policy.snapshot(120_200))
        policy.unlock()
        policy.onStopped(120_300)
        policy.onStarted(180_300)
        assertEquals(AppLock.State(true, true, 3), policy.snapshot(180_300))
    }

    @Test fun enablingLeavesTheAppUnlockedWithoutBumpingTheEpisode() {
        val policy = AppLock.Policy(false)
        policy.onStarted(0)
        policy.setEnabled(true)
        assertEquals(AppLock.State(true, false, 0), policy.snapshot(0))
        policy.setEnabled(false)
        assertEquals(AppLock.State(false, false, 0), policy.snapshot(0))
    }

    @Test fun onlyTheCurrentAttemptCanCompleteAndOnlyOnce() {
        val policy = AppLock.Policy(false)
        val earlier = policy.begin(AppLock.Purpose.UNLOCK)
        val current = policy.begin(AppLock.Purpose.ENABLE)
        assertNull(policy.complete(earlier, true))
        assertNull(policy.complete(current + 1, true))
        assertEquals(AppLock.Purpose.ENABLE, policy.complete(current, true))
        assertNull(policy.complete(current, true))
        val cancelled = policy.begin(AppLock.Purpose.DISABLE)
        assertNull(policy.complete(cancelled, false))
        assertNull(policy.complete(cancelled, true))
    }

    @Test fun theAutomaticPromptCanBeClaimedOncePerLockedEpisode() {
        val policy = AppLock.Policy(true)
        assertFalse(policy.claimAutoPrompt(2))
        assertTrue(policy.claimAutoPrompt(1))
        assertFalse(policy.claimAutoPrompt(1))
        policy.onStarted(0)
        policy.unlock()
        assertFalse(policy.claimAutoPrompt(1))
        policy.onStopped(100)
        policy.onStarted(60_100)
        assertFalse(policy.claimAutoPrompt(1))
        assertTrue(policy.claimAutoPrompt(2))
        assertFalse(policy.claimAutoPrompt(2))
    }
}
