package ai.namastex.automagik

import android.Manifest
import android.app.Application
import android.speech.SpeechRecognizer
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

/**
 * Dictation's messages belong to the app, not to a system toast (#1068): they go to the composer's own snackbar
 * host, and a phone with no connection says so instead of "Didn't catch that".
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DictateMessageTest {
    @get:Rule val compose = createComposeRule()

    private class Engine : DictateEngine {
        var error: ((Int) -> Unit)? = null
        var starts = 0
        override fun start(onResult: (String) -> Unit, onError: (Int) -> Unit) { starts++; error = onError }
        override fun stop() {}
        override fun destroy() {}
    }

    @Before fun grantMicrophoneAndClearToasts() {
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        ShadowToast.reset()
    }

    @Test fun aFailedListenGoesToTheComposersMessageHostNotASystemToast() {
        val engine = Engine()
        val said = mutableListOf<String>()
        compose.setContent { Dictate(engine, onHeard = {}, onSay = { said += it }) }
        compose.onNodeWithContentDescription("Speak").performClick()
        compose.runOnIdle { engine.error!!.invoke(SpeechRecognizer.ERROR_AUDIO) }
        compose.waitForIdle()
        assertEquals(listOf("Speech recognition could not use the microphone. Try again."), said)
        assertNull("the app's snackbar replaces the system toast", ShadowToast.getTextOfLatestToast())
    }

    @Test fun aPhoneWithNoConnectionSaysSoInsteadOfDidntCatchThat() {
        assertEquals(DICTATE_OFFLINE, dictateError(SpeechRecognizer.ERROR_NO_MATCH, online = false))
        assertEquals(DICTATE_OFFLINE, dictateError(SpeechRecognizer.ERROR_NETWORK, online = false))
        assertTrue(dictateError(SpeechRecognizer.ERROR_NO_MATCH, online = true).contains("catch"))
    }
}
