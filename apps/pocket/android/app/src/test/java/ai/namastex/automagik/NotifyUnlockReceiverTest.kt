package ai.namastex.automagik

import android.Manifest
import android.app.Application
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.core.app.RemoteInput
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 35], application = Application::class)
class NotifyUnlockReceiverTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val manager = app.getSystemService(NotificationManager::class.java)
    private val keyguard = shadowOf(app.getSystemService(KeyguardManager::class.java))
    private val prefs = app.getSharedPreferences("pocket", 0)
    private val ref = TerminalRef("paired", "agent")
    private val outgoing = ByteArrayOutputStream()
    private var previousViewModel: PocketViewModel? = null
    private lateinit var vm: PocketViewModel

    @Before fun setUp() {
        Dispatchers.setMain(StandardTestDispatcher())
        if (Build.VERSION.SDK_INT >= 33) shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        prefs.edit().clear().commit()
        AppLock.init(app)
        keyguard.setKeyguardLocked(false)
        previousViewModel = PocketViewModel.current
        vm = PocketViewModel(app, StandardTestDispatcher())
        // Any attempted core call writes a frame. Supply just the transport sink without starting a reader.
        val client = CoreClient(ByteArray(0).inputStream(), outgoing, java.io.Closeable {}, vm.viewModelScope) {}
        val field = PocketViewModel::class.java.getDeclaredField("clients").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val clients = field.get(vm) as ConcurrentHashMap<String, CoreClient>
        clients[ref.hostId] = client
    }

    @After fun tearDown() {
        if (::vm.isInitialized) vm.viewModelScope.cancel()
        PocketViewModel.current = previousViewModel
        keyguard.setKeyguardLocked(false)
        manager.cancelAll()
        Dispatchers.resetMain()
    }

    private fun notification() = manager.activeNotifications.single { it.id == Notify.id(ref) }.notification

    private fun staleAction(index: Int): Intent {
        vm.setLockAnswers(true)
        Notify.post(app, ref, Alerts.BLOCKED, "Agent title", "Agent detail", silent = false, lockScreen = true,
            sent = null, choices = listOf(Prompt.Choice(0, "Yes")), options = listOf("Yes"))
        val action = notification().actions[index]
        val intent = Intent(shadowOf(action.actionIntent).savedIntent)
        vm.setLockAnswers(false)
        keyguard.setKeyguardLocked(true)
        return intent
    }

    private fun assertRefused() {
        val notification = notification()
        assertEquals(0, outgoing.size())
        assertEquals("Automagik", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("Not sent: unlock the phone to answer.", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertTrue(notification.actions.isNullOrEmpty())
        assertNotNull(notification.contentIntent)
    }

    @Test fun choiceRefusesAnActionPostedBeforeTheSettingChanged() {
        Notify.ChoiceReceiver().onReceive(app, staleAction(0))
        assertRefused()
    }

    @Test fun replyRefusesAnActionPostedBeforeTheSettingChanged() {
        val intent = staleAction(1)
        RemoteInput.addResultsToIntent(arrayOf(RemoteInput.Builder("reply").build()), intent,
            Bundle().apply { putCharSequence("reply", "An answer") })
        Notify.ReplyReceiver().onReceive(app, intent)
        assertRefused()
    }
}
