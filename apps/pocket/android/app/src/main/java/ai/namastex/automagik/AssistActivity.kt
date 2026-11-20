package ai.namastex.automagik

import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material.icons.outlined.Send
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Who the assistant offers to talk to: agents that need the person, then finished ones, most recent first. */
object Assist {
    fun targets(sections: List<Cockpit.Section>, max: Int = 5): List<Cockpit.Entry> =
        sections.filter { it.rank == Cockpit.BLOCKED || it.rank == Cockpit.DONE }.sortedByDescending { it.rank }.flatMap { it.entries }.take(max)

    fun waitsForUnlock(appLock: Boolean, keyguardLocked: Boolean, lockAnswers: Boolean) =
        !appLock && keyguardLocked && !lockAnswers
}

/**
 * The phone's assistant (hold the side button): a panel over whatever is on screen, the lock screen included, with
 * the agents that need the person and a message box with voice input, sent like the composer.
 */
class AssistActivity : ComponentActivity() {
    private val vm get() = (application as PocketApplication).vm
    private val keyguard get() = getSystemService(KeyguardManager::class.java)
    private lateinit var lockAuth: AppLockAuth
    private var keyguardLocked by mutableStateOf(false)
    private var dismissingKeyguard by mutableStateOf(false)
    private var unlockFirstPending = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lockAuth = AppLockAuth(this, savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        keyguardLocked = keyguard.isKeyguardLocked
        setContent {
            AutomagikTheme {
                val lock by AppLock.state.collectAsState()
                val state by vm.state.collectAsStateWithLifecycle()
                val waitingForPhone = keyguardLocked || dismissingKeyguard
                LockGate(lock.copy(locked = lock.enabled && (lock.locked || waitingForPhone)), cover = {
                    lockAuth.AutoPrompt(lock, ready = !waitingForPhone)
                    LockCover(lockAuth.canLock, ::unlock, { startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) }, vm::setForeground)
                }, content = {
                    if (Assist.waitsForUnlock(lock.enabled, keyguardLocked, state.lockAnswers)) Box(Modifier.fillMaxSize())
                    else AssistPanel(vm, keyguardLocked = { keyguard.isKeyguardLocked }, onClose = ::finish, onOpen = { ref ->
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            .apply { ref?.let { putExtra(Notify.EXTRA_HOST, it.hostId).putExtra(Notify.EXTRA_ADDRESS, it.address) } })
                        finish()
                    })
                })
            }
        }
    }

    override fun onResume() {
        super.onResume()
        keyguardLocked = keyguard.isKeyguardLocked
        // API 26 can't show this window over the lock screen, so it asks now. From 27 it asks once the window has
        // focus: a request made before the window covers the lock screen is cancelled when it does.
        if (Build.VERSION.SDK_INT < 27) askUnlockFirst()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || Build.VERSION.SDK_INT < 27) return
        keyguardLocked = keyguard.isKeyguardLocked
        askUnlockFirst()
    }

    /** With the app lock and "Answer from the lock screen" off, Android's unlock comes before the panel. */
    private fun askUnlockFirst() {
        if (unlockFirstPending || !Assist.waitsForUnlock(AppLock.enabled, keyguardLocked, vm.state.value.lockAnswers)) return
        unlockFirstPending = true
        keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() { unlockFirstPending = false; keyguardLocked = keyguard.isKeyguardLocked }
            override fun onDismissCancelled() { unlockFirstPending = false; finish() }
            override fun onDismissError() { unlockFirstPending = false; finish() }
        })
    }
    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); lockAuth.save(outState) }

    private fun unlock() {
        if (dismissingKeyguard) return
        if (!keyguard.isKeyguardLocked) {
            keyguardLocked = false
            if (AppLock.locked()) lockAuth.request(AppLock.Purpose.UNLOCK)
            return
        }
        keyguardLocked = true
        dismissingKeyguard = true
        keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() {
                keyguardLocked = keyguard.isKeyguardLocked
                dismissingKeyguard = false
                if (AppLock.locked()) {
                    AppLock.claimAutoPrompt(AppLock.state.value.episode)
                    lockAuth.request(AppLock.Purpose.UNLOCK)
                }
            }

            override fun onDismissCancelled() { keyguardLocked = true; dismissingKeyguard = false }
            override fun onDismissError() { keyguardLocked = true; dismissingKeyguard = false }
        })
    }
}

@Composable private fun AssistPanel(vm: PocketViewModel, keyguardLocked: () -> Boolean, onClose: () -> Unit, onOpen: (TerminalRef?) -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val all = state.machines.flatMap { (host, machine) -> machine.terminals.filter { it.live }.map { TerminalRef(host, it.address) to it } }
    val paned = state.machines.flatMap { (h, m) -> m.spaces.flatMap { s -> s.addresses.map { TerminalRef(h, it) } } }.toSet()
    val targets = Assist.targets(Cockpit.sections(all, { it in paned }) { r, t -> Cockpit.seenKey(r, t) in state.seen })
    var target by remember { mutableStateOf<TerminalRef?>(null) }
    val chosen = targets.find { it.ref == target } ?: targets.firstOrNull()
    var text by remember { mutableStateOf("") }
    var outcome by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val connected = state.machines.values.any { it.connected }
    // Opened from the side button the app may not be running: it is in the foreground now, so it can connect and watch.
    LifecycleStartEffect(Unit) { vm.setForeground(true); onStopOrDispose { vm.setForeground(false) } }
    Box(Modifier.fillMaxSize().background(Chrome.copy(alpha = .55f)).clickable(onClick = onClose), contentAlignment = Alignment.BottomCenter) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp)).background(Canvas).clickable(remember { MutableInteractionSource() }, null) {}
            .navigationBarsPadding().imePadding().padding(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Brand(26); Spacer(Modifier.width(10.dp))
                Text("Automagik", fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = { onOpen(chosen?.ref) }) { Text("Open app") }
            }
            Spacer(Modifier.height(10.dp))
            when {
                !connected -> Row(verticalAlignment = Alignment.CenterVertically) {
                    val connecting = state.machines.values.any { it.connecting }
                    Text(if (connecting) "Connecting…" else "Not connected.", color = Muted, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    if (!connecting && state.hosts.isNotEmpty()) TextButton(onClick = { state.hosts.forEach { vm.connect(it) } }) { Text("Connect") }
                }
                targets.isEmpty() -> Text("All clear: no agent needs you.", color = Muted, fontSize = 13.sp)
                else -> targets.forEach { e ->
                    val on = e.ref == chosen?.ref
                    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp).clip(RoundedCornerShape(10.dp)).background(if (on) Raised else Surface)
                        .border(1.dp, if (on) Accent.copy(alpha = .5f) else Border, RoundedCornerShape(10.dp)).clickable { target = e.ref }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Dot(stateColor(if (e.rank == Cockpit.BLOCKED) "blocked" else "done"), 7); Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(e.terminal.title.ifBlank { e.terminal.agent }, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val said = e.terminal.message.ifBlank { statusLabel(if (e.rank == Cockpit.BLOCKED) "blocked" else "done", e.terminal.kind) }
                            Text(said, color = Muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            outcome?.let { Spacer(Modifier.height(8.dp)); Text(it, color = if (it.startsWith("You:")) Accent else Blocked, fontSize = 12.sp) }
            if (connected && chosen != null) {
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(text, { text = it }, Modifier.weight(1f), placeholder = { Text("Message ${chosen.terminal.title.ifBlank { chosen.terminal.agent }}") }, maxLines = 4)
                    Spacer(Modifier.width(6.dp))
                    Dictate(onHeard = { heard -> text = dictated(text, heard) })
                    IconButton(enabled = text.isNotBlank(), onClick = {
                        val send = text.trim(); val ref = chosen.ref
                        scope.launch {
                            if (AppLock.locked()) {
                                outcome = "Not sent: Automagik is locked. Open it to answer."
                                return@launch
                            }
                            if (keyguardLocked() && (AppLock.enabled || !vm.state.value.lockAnswers)) {
                                outcome = "Not sent: unlock the phone to answer."
                                return@launch
                            }
                            val result = vm.reply(ref, send)
                            outcome = result
                            if (result.startsWith("You:")) { text = ""; delay(1_200); onClose() }
                        }
                    }) { Icon(Icons.Outlined.Send, "Send", tint = Accent) }
                }
            }
        }
    }
}
