package ai.namastex.automagik

import org.junit.Assert.assertEquals
import org.junit.Test

class NotifyUnlockTest {
    @Test fun unlockRequiredOnlyWithKeyguardLockedAndLockScreenAnswersOff() {
        assertEquals(listOf(false, true, false, false),
            listOf(false, true).flatMap { answers -> listOf(false, true).map { locked -> Notify.needsUnlock(answers, locked) } })
    }
}
