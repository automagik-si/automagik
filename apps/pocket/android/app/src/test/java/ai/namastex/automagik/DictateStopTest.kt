package ai.namastex.automagik

import android.Manifest
import android.app.Application
import android.speech.SpeechRecognizer
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

/**
 * Stopping the mic is the person's choice, not a failed listen (#1068): Android reports an error when listening
 * stops, and that must not read as "Didn't catch that".
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DictateStopTest {
    @get:Rule val compose = createComposeRule()

    /** Android's recognizer reports `ERROR_CLIENT` after `stopListening` while nobody spoke. */
    private class StopEngine : DictateEngine {
        private var error: ((Int) -> Unit)? = null
        var starts = 0
        override fun start(onResult: (String) -> Unit, onError: (Int) -> Unit) { starts++; error = onError }
        override fun stop() { error?.invoke(SpeechRecognizer.ERROR_CLIENT) }
        override fun destroy() {}
    }

    @Before fun grantMicrophoneAndClearToasts() {
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        ShadowToast.reset()
    }

    @Test fun stoppingTheMicShowsNoFailedListenMessage() {
        val engine = StopEngine()
        compose.setContent { Dictate(engine, onHeard = {}) }
        compose.onNodeWithContentDescription("Speak").performClick()
        compose.onNodeWithContentDescription("Stop listening").performClick()
        compose.waitForIdle()
        assertNull("a stop is not a failed listen", ShadowToast.getTextOfLatestToast())
    }
}
