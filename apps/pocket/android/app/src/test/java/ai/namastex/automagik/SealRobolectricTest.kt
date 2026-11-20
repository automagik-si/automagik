package ai.namastex.automagik

import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SealRobolectricTest {
    @Test fun unavailableAndroidKeystoreReturnsNull() {
        assertNull(Seal.sealer())
    }
}
