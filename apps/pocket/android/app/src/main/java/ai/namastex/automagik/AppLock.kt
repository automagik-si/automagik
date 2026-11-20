package ai.namastex.automagik

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.SharedPreferences
import android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK
import android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LifecycleStartEffect
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

object AppLock {
    const val TIMEOUT_MS = 60_000L
    private const val PREF = "app_lock"

    enum class Purpose { UNLOCK, ENABLE, DISABLE }
    data class State(val enabled: Boolean, val locked: Boolean, val episode: Int)

    /** One monotonic away interval for the process, including time with the screen off. */
    class Policy(enabled: Boolean) {
        private var enabled = enabled
        private var unlocked = false
        private var started = 0
        private var awayAt: Long? = null
        private var episode = if (enabled) 1 else 0
        private var autoPrompted = 0
        private var lastAttempt = 0L
        private var attempt: Pair<Long, Purpose>? = null

        private fun expired(now: Long) = started == 0 && awayAt?.let { now - it >= TIMEOUT_MS } == true

        @Synchronized fun onStarted(now: Long) {
            if (expired(now)) {
                if (enabled && unlocked) episode++
                unlocked = false
            }
            started++
            awayAt = null
        }

        @Synchronized fun onStopped(now: Long) {
            started = (started - 1).coerceAtLeast(0)
            if (started == 0) awayAt = now
        }

        @Synchronized fun locked(now: Long) = enabled && (!unlocked || expired(now))

        @Synchronized fun snapshot(now: Long) = State(enabled, locked(now), episode)

        @Synchronized fun unlock() { unlocked = true }

        @Synchronized fun setEnabled(on: Boolean) {
            enabled = on
            if (on) unlocked = true
        }

        @Synchronized fun begin(purpose: Purpose): Long = (++lastAttempt).also { attempt = it to purpose }

        @Synchronized fun complete(id: Long, success: Boolean): Purpose? {
            val current = attempt?.takeIf { it.first == id } ?: return null
            attempt = null
            return current.second.takeIf { success }
        }

        @Synchronized fun claimAutoPrompt(episode: Int): Boolean {
            if (!enabled || unlocked || episode != this.episode || autoPrompted == episode) return false
            autoPrompted = episode
            return true
        }
    }

    /** Publishing an alert and enabling the lock must agree on which alerts are safe to show. */
    internal val notifyLock = Any()
    private lateinit var prefs: SharedPreferences
    private var policy = Policy(false)
    private val startedActivities = mutableSetOf<Activity>()
    private val _state = MutableStateFlow(State(enabled = false, locked = false, episode = 0))
    val state = _state.asStateFlow()
    val enabled get() = state.value.enabled

    @Synchronized fun init(context: Context) {
        prefs = context.getSharedPreferences("pocket", Context.MODE_PRIVATE)
        policy = Policy(prefs.getBoolean(PREF, false))
        startedActivities.clear()
        refresh(SystemClock.elapsedRealtime())
    }

    @Synchronized fun locked() = policy.locked(SystemClock.elapsedRealtime())

    fun canLock(context: Context) = context.getSystemService(KeyguardManager::class.java).isDeviceSecure

    @Synchronized internal fun onStarted(activity: Activity) {
        startedActivities.add(activity)
        val now = SystemClock.elapsedRealtime()
        policy.onStarted(now)
        refresh(now)
        applyWindowPolicy(activity)
    }

    @Synchronized internal fun onStopped(activity: Activity) {
        startedActivities.remove(activity)
        val now = SystemClock.elapsedRealtime()
        policy.onStopped(now)
        refresh(now)
    }

    internal fun applyWindowPolicy(activity: Activity) {
        if (Build.VERSION.SDK_INT >= 33) {
            activity.setRecentsScreenshotEnabled(!enabled)
        } else if (enabled) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    @Synchronized fun unlock() {
        policy.unlock()
        refresh(SystemClock.elapsedRealtime())
    }

    internal fun setEnabled(context: Context, on: Boolean): Unit = synchronized(notifyLock) {
        synchronized(this) {
            prefs.edit { putBoolean(PREF, on) }
            policy.setEnabled(on)
            refresh(SystemClock.elapsedRealtime())
            startedActivities.forEach(::applyWindowPolicy)
        }
        if (on) Notify.cancelAlerts(context)
    }

    @Synchronized fun begin(purpose: Purpose) = policy.begin(purpose)
    @Synchronized fun complete(id: Long, success: Boolean) = policy.complete(id, success)
    @Synchronized fun claimAutoPrompt(episode: Int) = policy.claimAutoPrompt(episode)

    private fun refresh(now: Long) { _state.value = policy.snapshot(now) }
}

/** A credential activity can return to a recreated caller. A biometric prompt belongs to the old window. */
internal class AppLockAuth(
    private val activity: ComponentActivity,
    savedInstanceState: Bundle?,
) : DefaultLifecycleObserver {
    var canLock by mutableStateOf(AppLock.canLock(activity))
        private set
    private var credentialAttempt = savedInstanceState?.takeIf { it.getString(CREDENTIAL_PROCESS) == processToken }
        ?.getLong(CREDENTIAL_ATTEMPT)?.takeIf { it != 0L }
    private var prompt: Pair<Long, CancellationSignal>? = null
    private val credential = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val id = credentialAttempt ?: return@registerForActivityResult
        credentialAttempt = null
        complete(id, result.resultCode == Activity.RESULT_OK)
    }

    init { activity.lifecycle.addObserver(this) }

    fun save(outState: Bundle) {
        credentialAttempt?.let {
            outState.putLong(CREDENTIAL_ATTEMPT, it)
            outState.putString(CREDENTIAL_PROCESS, processToken)
        }
    }

    override fun onResume(owner: LifecycleOwner) { canLock = AppLock.canLock(activity) }
    override fun onStop(owner: LifecycleOwner) = cancelPrompt()
    override fun onDestroy(owner: LifecycleOwner) = cancelPrompt()

    fun request(purpose: AppLock.Purpose) {
        canLock = AppLock.canLock(activity)
        if (!canLock || credentialAttempt != null || prompt != null) return
        val id = AppLock.begin(purpose)
        if (Build.VERSION.SDK_INT >= 30) {
            val signal = CancellationSignal()
            prompt = id to signal
            runCatching {
                BiometricPrompt.Builder(activity)
                    .setTitle("Unlock Automagik")
                    .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
                    .setConfirmationRequired(false)
                    .build().authenticate(signal, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = finishPrompt(id, true)
                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = finishPrompt(id, false)
                    })
            }.onFailure { finishPrompt(id, false) }
        } else {
            credentialAttempt = id
            @Suppress("DEPRECATION") // The credential activity supports PIN-only devices below API 30.
            val intent = activity.getSystemService(KeyguardManager::class.java)
                .createConfirmDeviceCredentialIntent("Unlock Automagik", null)
            if (intent == null || runCatching { credential.launch(intent) }.isFailure) {
                credentialAttempt = null
                complete(id, false)
            }
        }
    }

    @Composable fun AutoPrompt(lock: AppLock.State, ready: Boolean = true) {
        LifecycleResumeEffect(lock.episode, lock.locked, ready && canLock) {
            if (ready && canLock && credentialAttempt == null && prompt == null && AppLock.claimAutoPrompt(lock.episode)) {
                request(AppLock.Purpose.UNLOCK)
            }
            onPauseOrDispose { }
        }
    }

    private fun finishPrompt(id: Long, success: Boolean) {
        if (prompt?.first != id) return
        prompt = null
        complete(id, success)
    }

    private fun cancelPrompt() {
        val (id, signal) = prompt ?: return
        finishPrompt(id, false)
        signal.cancel()
    }

    private fun complete(id: Long, success: Boolean) {
        val purpose = AppLock.complete(id, success) ?: return
        AppLock.unlock()
        when (purpose) {
            AppLock.Purpose.ENABLE -> AppLock.setEnabled(activity, true)
            AppLock.Purpose.DISABLE -> AppLock.setEnabled(activity, false)
            AppLock.Purpose.UNLOCK -> Unit
        }
    }

    private companion object {
        const val CREDENTIAL_ATTEMPT = "app_lock_credential_attempt"
        const val CREDENTIAL_PROCESS = "app_lock_credential_process"
        val processToken = UUID.randomUUID().toString()
    }
}

/** Disposing app content removes its dialogs and Android views from the window. */
@Composable fun LockGate(lock: AppLock.State, cover: @Composable () -> Unit, content: @Composable () -> Unit) {
    if (lock.locked) cover() else content()
}

/** The cover is foreground for Watch and updates, without retaining the terminal or chat streams. */
@Composable internal fun LockCover(
    canLock: Boolean,
    onUnlock: () -> Unit,
    onSettings: () -> Unit,
    onForeground: (Boolean) -> Unit,
) {
    LifecycleStartEffect(Unit) { onForeground(true); onStopOrDispose { onForeground(false) } }
    Column(
        Modifier.fillMaxSize().background(Canvas).safeDrawingPadding().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
    ) {
        Brand(36)
        Text("Automagik is locked", color = Ink, style = MaterialTheme.typography.titleLarge)
        if (canLock) Button(onClick = onUnlock) { Text("Unlock") }
        else {
            Text("Set a screen lock in Android settings to unlock Automagik.", color = Muted, textAlign = TextAlign.Center)
            Button(onClick = onSettings) { Text("Open Android settings") }
        }
    }
}
