package ai.namastex.automagik

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.window.Dialog
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AppLockGateTest {
    @get:Rule val compose = createComposeRule()

    @Test fun lockingDisposesTheAppIncludingItsPairingDialog() {
        var lock by mutableStateOf(AppLock.State(true, false, 1))
        var unlocks = 0
        compose.setContent {
            AutomagikTheme {
                LockGate(lock, cover = { LockCover(true, { unlocks++ }, {}, {}) }, content = {
                    Text("Home")
                    Dialog(onDismissRequest = {}) {
                        Column {
                            OutlinedTextField("", {}, label = { Text("Pairing code") })
                            Button(onClick = {}) { Text("Pair") }
                        }
                    }
                })
            }
        }
        compose.onNodeWithText("Home").assertExists()
        compose.onNodeWithText("Pair").assertExists()
        compose.onNode(hasSetTextAction()).assertExists()

        compose.runOnIdle { lock = AppLock.State(true, true, 2) }
        compose.onNodeWithText("Automagik is locked").assertExists()
        compose.onNodeWithText("Home").assertDoesNotExist()
        compose.onNodeWithText("Pair").assertDoesNotExist()
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.onNodeWithText("Unlock").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, unlocks); lock = AppLock.State(true, false, 2) }
        compose.onNodeWithText("Home").assertExists()
        compose.onNodeWithText("Pair").assertExists()
        compose.onNode(hasSetTextAction()).assertExists()
        compose.onNodeWithText("Automagik is locked").assertDoesNotExist()
    }

    @Test fun theCoverOpensSettingsWhenThereIsNoScreenLock() {
        var opened = 0
        compose.setContent { AutomagikTheme { LockCover(false, {}, { opened++ }, {}) } }
        compose.onNodeWithText("Set a screen lock in Android settings to unlock Automagik.").assertExists()
        compose.onNodeWithText("Unlock").assertDoesNotExist()
        compose.onNodeWithText("Open Android settings").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, opened) }
    }
}
