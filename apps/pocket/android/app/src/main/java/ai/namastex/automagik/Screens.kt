package ai.namastex.automagik

import android.Manifest
import android.app.role.RoleManager
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.activity.compose.LocalActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** Machines a host's core reaches: live from the connection, or remembered from the last one. */
fun PocketState.linkedFor(host: HostProfile): List<LinkedMachine> =
    machines[host.id]?.linked?.takeIf { it.isNotEmpty() } ?: host.linked.map { LinkedMachine(it, "") }

/** The demo's sample machines: connected in [PocketState.machines] but never saved as a host, so the Machines tab shows them read-only. */
fun PocketState.previewMachines(): List<Pair<String, MachineState>> =
    if (!demo) emptyList() else machines.filterKeys { id -> hosts.none { it.id == id } }.toList()

/** A machine card's status line. */
fun machineStatus(machine: MachineState): String =
    if (machine.connected) "Connected · hc ${machine.version} · ${machine.terminals.size} terminals" else if (machine.connecting) "Connecting…" else "Not connected"

/** A saved machine's status line: a legacy SSH machine ([LegacySsh]) only ever asks to be paired again. */
fun machineStatus(host: HostProfile, machine: MachineState): String = if (host.legacySsh) LegacySsh.STATUS else machineStatus(machine)

private val PAIRED_KEY = Regex("^[0-9a-f]{12}$")

/** The stored key fingerprint, when a paired card has a key prefix. */
fun pairedKey(host: HostProfile): String? = host.host.takeIf { host.paired && PAIRED_KEY.matches(it) }?.let(::keyFingerprint)

/** A machine card's icon, name, address and connection dot. */
@Composable fun MachineHeader(name: String, address: String, connected: Boolean, greyed: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Computer, null, Modifier.size(22.dp), tint = if (greyed) Muted else Accent); Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(name, fontWeight = FontWeight.Medium, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(4.dp)); Text(address, fontSize = 12.sp, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Dot(if (connected) Ok else Muted)
    }
}

@Composable fun LinkedMachineRows(linked: List<LinkedMachine>, via: String) {
    if (linked.isEmpty()) return
    Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SmallLabel("Through $via")
        linked.forEach { m ->
            Row(Modifier.padding(start = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Dot(if (m.connected) Ok else Muted); Spacer(Modifier.width(10.dp))
                Text(m.name, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(when { m.state.isBlank() -> "Connect to see status"; m.connected -> if (m.terminals == 1) "1 terminal" else "${m.terminals} terminals"; else -> m.state.replaceFirstChar(Char::uppercase) },
                    fontSize = 12.sp, color = Muted)
            }
        }
    }
}

/** What Settings does with a machine: [repair] is a legacy SSH machine's "Pair with QR", which opens the QR scanner ([LegacySsh]). */
class MachineActions(val pair: () -> Unit, val repair: (HostProfile) -> Unit, val connect: (HostProfile) -> Unit, val edit: (HostProfile) -> Unit,
                     val disconnect: (String) -> Unit, val remove: (String) -> Unit, val botChats: (HostProfile) -> Unit)

/** Settings' first section, what the Machines tab was: the saved machines, then pairing. */
@Composable fun MachinesSection(state: PocketState, actions: MachineActions) {
    var remove by remember { mutableStateOf<HostProfile?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Column { SmallLabel("Machines"); Spacer(Modifier.height(10.dp)); Text("Pair the computer running Herdr desktop: scan the QR code its Pocket Link shows.", fontSize = 13.sp, lineHeight = 21.sp, color = Muted) }
        state.hosts.forEach { host -> key(host.id) {
            val machine = state.machines[host.id] ?: MachineState()
            if (host.legacySsh) LegacySshCard(host, state.pairing, onRepair = { actions.repair(host) }, onRemove = { remove = host })
            else MachineCard(host, machine, state.linkedFor(host), actions) { remove = host }
        } }
        // The preview's sample machine, like a connected one but read-only: no connect, edit or remove, and no network.
        state.previewMachines().forEach { (id, machine) -> key("preview:$id") {
            Surface(shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Border), color = Surface) {
                Column(Modifier.padding(18.dp)) {
                    MachineHeader(PREVIEW_MACHINE, "Sample data · not a real connection", machine.connected)
                    Spacer(Modifier.height(18.dp))
                    Text(machineStatus(machine), fontSize = 12.sp, color = Muted)
                }
            }
        } }
        Button(onClick = actions.pair, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(12.dp)) { Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Pair with Herdr desktop") }
    }
    remove?.let { host -> AlertDialog(onDismissRequest = { remove = null }, title = { Text("Remove ${host.name}?") },
        text = { Text("This removes the saved connection from this phone. Its remote terminals keep running.") },
        confirmButton = { TextButton(onClick = { actions.remove(host.id); remove = null }) { Text("Remove", color = Blocked) } }, dismissButton = { TextButton(onClick = { remove = null }) { Text("Cancel") } }) }
}

/** A paired machine: its state, what it reaches, and connect, disconnect, bot chats, edit and remove. */
@Composable fun MachineCard(host: HostProfile, machine: MachineState, linked: List<LinkedMachine>, actions: MachineActions, onRemove: () -> Unit) {
    Surface(shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Border), color = Surface) {
        Column(Modifier.padding(18.dp)) {
            MachineHeader(host.name, host.address, machine.connected)
            Spacer(Modifier.height(18.dp))
            Text(machineStatus(host, machine), fontSize = 12.sp, color = Muted)
            pairedKey(host)?.let { Text("Computer key fingerprint $it", fontSize = 12.sp, color = Muted) }
            machine.error?.let { Spacer(Modifier.height(10.dp)); SelectionContainer { Text(it, color = Blocked, fontSize = 12.sp, lineHeight = 18.sp) } }
            LinkedMachineRows(linked, host.name)
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (machine.connected) OutlinedButton(onClick = { actions.disconnect(host.id) }) { Text("Disconnect", fontSize = 13.sp) }
                if (machine.connected && host.paired) { Spacer(Modifier.width(8.dp)); TextButton(onClick = { actions.botChats(host) }) { Text("Bot chats", fontSize = 13.sp) } }
                else Button(onClick = { actions.connect(host) }, enabled = !machine.connecting) {
                    if (machine.connecting) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp) else Text("Connect", fontSize = 13.sp)
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { actions.edit(host) }) { Icon(Icons.Outlined.Edit, "Edit ${host.name}", Modifier.size(19.dp), tint = Muted) }
                IconButton(onClick = onRemove) { Icon(Icons.Outlined.DeleteOutline, "Remove ${host.name}", Modifier.size(19.dp), tint = Muted) }
            }
        }
    }
}

/** A machine saved over SSH by an older version: greyed, never connected, one way forward ([LegacySsh]). */
@Composable fun LegacySshCard(host: HostProfile, pairing: Boolean, onRepair: () -> Unit, onRemove: () -> Unit) {
    Surface(shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Border), color = Surface) {
        Column(Modifier.padding(18.dp)) {
            Box(Modifier.alpha(.55f)) { MachineHeader(host.name, host.address, connected = false, greyed = true) }
            Spacer(Modifier.height(18.dp))
            Text(LegacySsh.STATUS, fontSize = 12.sp, color = Muted)
            Spacer(Modifier.height(4.dp))
            Text("This app no longer connects over SSH. Open Pocket Link on this computer, then scan its code; this entry is replaced once it pairs.", fontSize = 12.sp, lineHeight = 18.sp, color = Muted)
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = onRepair, enabled = !pairing) { Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text(LegacySsh.ACTION, fontSize = 13.sp) }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onRemove) { Icon(Icons.Outlined.DeleteOutline, "Remove ${host.name}", Modifier.size(19.dp), tint = Muted) }
            }
        }
    }
}

/** Settings, a tab: the machines and pairing first, then the display, alerts and About. */
@Composable fun SettingsScreen(state: PocketState, vm: PocketViewModel, machines: MachineActions) {
    val lock by AppLock.state.collectAsStateWithLifecycle()
    val activity = LocalActivity.current as? MainActivity
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        MachinesSection(state, machines)
        Spacer(Modifier.height(34.dp)); HorizontalDivider(color = Border); Spacer(Modifier.height(26.dp))
        SmallLabel("Terminal display"); Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilterChip(selected = !state.nativeDisplay, onClick = { vm.preferNativeDisplay(false) }, label = { Text("Full color") })
            FilterChip(selected = state.nativeDisplay, onClick = { vm.preferNativeDisplay(true) }, label = { Text("Native text") })
        }
        Spacer(Modifier.height(8.dp))
        Text("Text display uses a simpler native view and keeps message and key controls. It also opens automatically if the color display is unavailable.", color = Muted, fontSize = 13.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(28.dp)); SmallLabel("Terminal text size"); Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedIconButton(onClick = { vm.setFontSize(state.fontSize - 1) }, enabled = state.fontSize > FONT_SIZES.first) { Icon(Icons.Outlined.Remove, "Smaller terminal text") }
            Text("${state.fontSize}", Modifier.width(52.dp), textAlign = TextAlign.Center, fontFamily = FontFamily.Monospace, fontSize = 17.sp)
            OutlinedIconButton(onClick = { vm.setFontSize(state.fontSize + 1) }, enabled = state.fontSize < FONT_SIZES.last) { Icon(Icons.Outlined.Add, "Larger terminal text") }
            Spacer(Modifier.width(16.dp))
            Text("~/work $", fontFamily = FontFamily.Monospace, fontSize = state.fontSize.sp, color = Muted, maxLines = 1, modifier = Modifier.weight(1f))
            if (state.fontSize != DEFAULT_FONT_SIZE) TextButton(onClick = { vm.setFontSize(DEFAULT_FONT_SIZE) }) { Text("Reset") }
        }
        Spacer(Modifier.height(8.dp))
        Text("You can also pinch a terminal with two fingers to change its text size.", color = Muted, fontSize = 13.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(28.dp)); SmallLabel("Alerts"); Spacer(Modifier.height(6.dp))
        AlertRow("Sounds", "Play a sound when an agent needs you, or finishes while you aren’t looking at it.", state.alertSounds, onPlay = vm::playAlert) { vm.setAlerts(sounds = it) }
        AlertRow("Needs you", "When an agent asks something or waits for approval.", state.alertBlocked) { vm.setAlerts(blocked = it) }
        AlertRow("Done", "When an agent finishes a turn while you aren’t looking at it.", state.alertDone) { vm.setAlerts(done = it) }
        AlertRow("Watch in background", "Keep your machines connected when you leave the app, so alerts still arrive. Android shows a “Watching” notification meanwhile.", state.watch) { vm.setWatch(it) }
        Spacer(Modifier.height(8.dp)); AssistantRow(lock.enabled); Spacer(Modifier.height(8.dp))
        AlertRow("Lock Automagik", "Ask for your fingerprint, face or screen lock to open Automagik, every time it starts and 60 seconds after you leave it. Notifications then only say an agent needs you; answer in the app.", lock.enabled) {
            activity?.requestAppLock(if (it) AppLock.Purpose.ENABLE else AppLock.Purpose.DISABLE)
        }
        if (!lock.enabled) AlertRow("Answer from the lock screen", "Notifications show what the agent asks on the lock screen, and Reply and Yes work there without unlocking. Anyone holding your locked phone could answer, so it starts off.", state.lockAnswers) { vm.setLockAnswers(it) }
        Spacer(Modifier.height(4.dp))
        val alertHelp = if (lock.enabled) "Alerts are Android notifications, in the app too: tap one to open its agent and answer in the app."
            else "Alerts are Android notifications, in the app too: tap one to open its agent, or answer from it."
        Text("$alertHelp The agent on screen only sounds when it needs you. They come while Automagik is connected.", color = Muted, fontSize = 13.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(34.dp)); HorizontalDivider(color = Border); Spacer(Modifier.height(26.dp))
        SmallLabel("About"); Spacer(Modifier.height(15.dp))
        Row(verticalAlignment = Alignment.CenterVertically) { Brand(36); Spacer(Modifier.width(12.dp)); Column { Text("Automagik", fontWeight = FontWeight.SemiBold); Text("${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) · Android companion", color = Muted, fontSize = 12.sp) } }
        AppUpdates.Settings()
        CrashRow()
        Spacer(Modifier.height(18.dp)); Text("A native companion for your existing herdr-core, in Automagik’s colors, light or dark as your phone is set. Spaces and tabs follow the desktop’s design.", color = Muted, fontSize = 13.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(10.dp)); Text("With Watch in background on, connections stay open while you’re away and come back on their own after a drop. Otherwise Android may close them; pull down on the agent list or tap Reconnect. Your remote programs keep running.", color = Muted, fontSize = 13.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(20.dp)); TextButton(onClick = vm::enterDemo, contentPadding = PaddingValues(0.dp)) { Text("Explore the interface with sample data", fontSize = 13.sp) }
    }
}

/** Settings: make Automagik the phone's assistant, so holding the side button opens its panel (lock screen too). */
@Composable fun AssistantRow(appLockEnabled: Boolean = false) {
    val context = LocalContext.current
    fun isHeld() = Build.VERSION.SDK_INT >= 29 && context.getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_ASSISTANT)
    var held by remember { mutableStateOf(isHeld()) }
    LifecycleResumeEffect(Unit) { held = isHeld(); onPauseOrDispose { } }
    // Android may not offer the role in a dialog; its Digital assistant settings always can.
    fun settings() = runCatching { context.startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)) }
        .recoverCatching { context.startActivity(Intent(Settings.ACTION_SETTINGS)) }
    val role = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { held = isHeld(); if (!held) settings() }
    fun ask() {
        val roles = if (Build.VERSION.SDK_INT >= 29) context.getSystemService(RoleManager::class.java) else null
        if (Build.VERSION.SDK_INT >= 29 && roles != null && roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT) && !held)
            runCatching { role.launch(roles.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)) }.onFailure { settings() }
        else settings()
    }
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ask() }
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Side button assistant", fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(2.dp))
            Text(if (appLockEnabled) "Hold the side button to open Automagik. Unlock to see what needs you and answer by typing or speaking."
                else if (held) "Automagik is your assistant. Hold the side button to see what needs you and answer by typing or speaking, on the lock screen too."
                else "Hold the side button to open Automagik over any screen, the lock screen too: see what needs you and answer by typing or speaking.",
                color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
        }
        Spacer(Modifier.width(8.dp))
        OutlinedButton(onClick = {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) ask()
            else mic.launch(Manifest.permission.RECORD_AUDIO)
        }) { Text(if (held) "Change" else "Set up") }
    }
}

/** One Settings > Alerts switch, like the desktop's; [onPlay] previews the sound. */
@Composable fun AlertRow(title: String, detail: String, on: Boolean, onPlay: (() -> Unit)? = null, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!on) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(2.dp)); Text(detail, color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
        }
        onPlay?.let { IconButton(onClick = it) { Icon(Icons.Outlined.PlayArrow, "Play the alert sound", tint = Accent) } }
        Spacer(Modifier.width(8.dp)); Switch(checked = on, onCheckedChange = onChange)
    }
}

/** Settings → About: the last crash's report, to copy or send to whoever builds the app. */
@Composable fun CrashRow() {
    var report by remember { mutableStateOf(CrashLog.read()) }
    val crash = report ?: return
    val clipboard = LocalClipboardManager.current
    val activity = LocalActivity.current
    Spacer(Modifier.height(18.dp))
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Blocked.copy(alpha = .08f)).border(1.dp, Blocked.copy(alpha = .25f), RoundedCornerShape(10.dp)).padding(14.dp, 12.dp, 6.dp, 4.dp)) {
        Text("Automagik closed unexpectedly", fontSize = 13.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(4.dp))
        Text(crash.lines().drop(4).firstOrNull { it.isNotBlank() }.orEmpty(), color = Muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row {
            TextButton(onClick = { clipboard.setText(AnnotatedString(crash)) }) { Text("Copy report", fontSize = 13.sp) }
            TextButton(onClick = {
                runCatching { activity?.startActivity(android.content.Intent.createChooser(android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(android.content.Intent.EXTRA_SUBJECT, "Automagik crash").putExtra(android.content.Intent.EXTRA_TEXT, crash), "Send crash report")) }
            }) { Text("Share", fontSize = 13.sp) }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { CrashLog.clear(); report = null }) { Text("Clear", fontSize = 13.sp, color = Muted) }
        }
    }
}

/** Hostnames, users and commands: no auto-capitalization or autocorrect from the phone keyboard. */
fun plainKeys(type: KeyboardType = KeyboardType.Text, ime: ImeAction = ImeAction.Next) =
    KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = type, imeAction = ime)

@Composable fun NewTerminalDialog(state: PocketState, onDismiss: () -> Unit, onStart: (String, String, String) -> Unit) {
    val available = state.hosts.filter { state.machines[it.id]?.connected == true }
    var host by remember { mutableStateOf(state.space?.first ?: available.firstOrNull()?.id.orEmpty()) }
    var cwd by remember { mutableStateOf(state.space?.let { (h, s) -> state.machines[h]?.spaces?.find { it.id == s }?.folder }.orEmpty()) }
    var command by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("New terminal") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SmallLabel("Machine")
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                available.forEach { h -> FilterChip(selected = host == h.id, onClick = { host = h.id }, label = { Text(h.name) }) }
            }
            OutlinedTextField(cwd, { cwd = it }, label = { Text("Working directory (optional)") }, singleLine = true, keyboardOptions = plainKeys(KeyboardType.Uri))
            OutlinedTextField(command, { command = it }, label = { Text("Command (optional)") }, placeholder = { Text("claude, codex, or a shell command") }, maxLines = 3,
                keyboardOptions = plainKeys(ime = ImeAction.Go), keyboardActions = KeyboardActions(onGo = { if (host.isNotBlank()) onStart(host, cwd, command) }))
            Text("Leave the command empty to start the host’s default shell.", fontSize = 12.sp, color = Muted)
        }
    }, confirmButton = { TextButton(onClick = { onStart(host, cwd, command) }, enabled = host.isNotBlank()) { Text("Start terminal") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
