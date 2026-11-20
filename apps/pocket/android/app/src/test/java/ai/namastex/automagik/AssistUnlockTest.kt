package ai.namastex.automagik

import org.junit.Assert.assertEquals
import org.junit.Test

class AssistUnlockTest {
    @Test fun unlockFirstOnlyWithAppLockOffAndLockScreenAnswersOff() {
        val flags = listOf(false, true)
        val answers = flags.flatMap { appLock ->
            flags.flatMap { locked -> flags.map { lockAnswers -> Assist.waitsForUnlock(appLock, locked, lockAnswers) } }
        }
        assertEquals(listOf(false, false, true, false, false, false, false, false), answers)
    }
}
