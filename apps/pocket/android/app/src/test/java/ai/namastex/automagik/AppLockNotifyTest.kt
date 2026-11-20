package ai.namastex.automagik

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.core.content.edit
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AppLockNotifyTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val manager = app.getSystemService(NotificationManager::class.java)
    private val prefs = app.getSharedPreferences("pocket", 0)
    private val ref = TerminalRef("paired", "agent")
    private val finished = TerminalRef("paired", "other-agent")

    private var previousViewModel: PocketViewModel? = null

    @Before fun grantNotifications() {
        // Other tests leave their view model in the static field: these cases need none.
        previousViewModel = PocketViewModel.current
        PocketViewModel.current = null
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        Notify.channels(app)
    }

    @After fun resetLock() {
        PocketViewModel.current = previousViewModel
        prefs.edit { remove("app_lock") }
        AppLock.init(app)
        manager.cancelAll()
    }

    private fun seedLock(enabled: Boolean) {
        prefs.edit { putBoolean("app_lock", enabled) }
        AppLock.init(app)
    }

    private fun post(ref: TerminalRef, kind: String, sent: String? = null) =
        Notify.post(app, ref, kind, "Agent title", "Agent detail", silent = false, lockScreen = true, sent = sent,
            choices = listOf(Prompt.Choice(0, "Yes")))

    private fun notification(ref: TerminalRef) = manager.activeNotifications.single { it.id == Notify.id(ref) }.notification
    private fun actionIntent() = Intent().putExtra(Notify.EXTRA_HOST, ref.hostId).putExtra(Notify.EXTRA_ADDRESS, ref.address)

    private fun assertGeneric(ref: TerminalRef, text: String) {
        val notification = notification(ref)
        assertEquals("Automagik", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(text, notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(0, notification.actions.orEmpty().size)
        assertNotNull(notification.contentIntent)
    }

    @Test fun enabledLockPostsOnlyGenericAlertsAndOutcomes() {
        seedLock(true)
        post(ref, Alerts.BLOCKED)
        post(finished, Alerts.DONE, sent = "You: private reply")
        assertGeneric(ref, "An agent needs you.")
        assertGeneric(finished, "An agent finished.")
    }

    @Test fun disabledLockKeepsTheDetailedAlertAndActions() {
        seedLock(false)
        post(ref, Alerts.BLOCKED)
        val notification = notification(ref)
        assertEquals("Agent title", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("Agent detail", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(listOf("Yes", "Reply"), notification.actions.orEmpty().map { it.title.toString() })
    }

    @Test fun staleReplyIsRejectedBeforeLookingUpTheViewModel() {
        seedLock(true)
        assertNull(PocketViewModel.current)
        val intent = actionIntent()
        val input = RemoteInput.Builder("reply").build()
        RemoteInput.addResultsToIntent(arrayOf(input), intent, Bundle().apply { putCharSequence("reply", "An answer") })
        Notify.ReplyReceiver().onReceive(app, intent)
        assertGeneric(ref, "Not sent: Automagik is locked. Open it to answer.")
    }

    @Test fun staleChoiceIsRejectedBeforeLookingUpTheViewModel() {
        seedLock(true)
        assertNull(PocketViewModel.current)
        Notify.ChoiceReceiver().onReceive(app, actionIntent())
        assertGeneric(ref, "Not sent: Automagik is locked. Open it to answer.")
    }

    @Test fun enablingCancelsExistingAlertsAndKeepsOtherNotifications() {
        seedLock(false)
        post(ref, Alerts.BLOCKED)
        post(finished, Alerts.DONE)
        val other = "other"
        manager.createNotificationChannel(NotificationChannel(other, "Other", NotificationManager.IMPORTANCE_LOW))
        if (Build.VERSION.SDK_INT >= 33 && app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            error("POST_NOTIFICATIONS was not granted")
        }
        manager.notify(1, NotificationCompat.Builder(app, other).setSmallIcon(R.drawable.ic_notify).build())
        assertEquals(setOf(Notify.NEEDS_YOU, Notify.DONE, other), manager.activeNotifications.map { it.notification.channelId }.toSet())

        AppLock.setEnabled(app, true)

        assertEquals(listOf(other), manager.activeNotifications.map { it.notification.channelId })
    }
}
