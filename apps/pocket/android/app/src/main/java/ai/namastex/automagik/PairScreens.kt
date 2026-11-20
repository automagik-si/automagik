package ai.namastex.automagik

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Pair with Herdr desktop: its Pocket Link mod shows a QR code and a link; either one pairs this phone. */
@Composable fun PairDialog(pairing: Boolean, onDismiss: () -> Unit, onScan: (() -> Unit)?, onPair: (String) -> Unit) {
    var link by remember { mutableStateOf("") }
    val clipboard = LocalClipboardManager.current
    LaunchedEffect(Unit) {
        // A link copied on this phone (or synced from the desktop) is the likely one.
        clipboard.getText()?.text?.takeIf { PairingLink.parse(it) != null }?.let { link = it }
    }
    val valid = PairingLink.parse(link) != null
    AlertDialog(onDismissRequest = { if (!pairing) onDismiss() }, title = { Text("Pair with Herdr desktop") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("On your computer, open Herdr and press ⌘⌥P (Ctrl+Alt+P on Linux) for Pocket Link, then Pair a phone.", color = Muted, fontSize = 13.sp, lineHeight = 19.sp)
            if (onScan != null) Button(onClick = onScan, enabled = !pairing, modifier = Modifier.fillMaxWidth()) { Text("Scan the QR code") }
            OutlinedTextField(link, { link = it.trim() }, label = { Text("Or paste the pairing link") }, singleLine = true, enabled = !pairing,
                isError = link.isNotBlank() && !valid, keyboardOptions = plainKeys(KeyboardType.Uri, ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (valid) onPair(link) }), modifier = Modifier.fillMaxWidth())
            if (link.isNotBlank() && !valid) Text("That isn’t a Pocket Link pairing link.", color = Blocked, fontSize = 12.sp)
            if (pairing) Row { CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(10.dp)); Text("Pairing…", fontSize = 13.sp) }
            Text("No password needed. The connection is end to end encrypted: directly on your network, or through an encrypted relay when it can’t be.", color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
        }
    }, confirmButton = { TextButton(onClick = { onPair(link) }, enabled = valid && !pairing) { Text("Pair") } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !pairing) { Text("Cancel") } })
}

/** A pairing link that came from outside the app: pair only if it's on the person's own screen. */
@Composable fun ConfirmPairDialog(offer: PairingOffer, onPair: () -> Unit, onCancel: () -> Unit) {
    val knownName = offer.known?.let { displayName(it.name) }
    AlertDialog(onDismissRequest = onCancel, title = { Text(if (knownName == null) "Pair with a new computer?" else "Pair $knownName again?") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (knownName == null) {
                Text("New computer: its key isn’t saved on this phone.", color = Blocked, fontSize = 13.sp, lineHeight = 19.sp)
                Text("It calls itself “${offer.link.name}”.", color = Muted, fontSize = 13.sp, lineHeight = 19.sp)
            } else Text("This computer is already saved on this phone as “$knownName”.", color = Muted, fontSize = 13.sp, lineHeight = 19.sp)
            Text("Computer key fingerprint: ${offer.fingerprint}", color = Ink, fontSize = 13.sp, lineHeight = 19.sp)
            Text("Only pair if this code is on your own computer’s screen, in Herdr’s Pocket Link. Whatever you type in its terminals goes to that computer.",
                color = Muted, fontSize = 13.sp, lineHeight = 19.sp)
            if (knownName == null) Text("Tap Connect afterwards to open a session.", color = Muted, fontSize = 13.sp, lineHeight = 19.sp)
        }
    }, confirmButton = { TextButton(onClick = onPair) { Text("Pair") } }, dismissButton = { TextButton(onClick = onCancel) { Text("Cancel") } })
}

/** A paired desktop has no address or user to edit: its name, and which core session to open. */
@Composable fun PairedHostDialog(host: HostProfile, onDismiss: () -> Unit, onSave: (HostProfile) -> Unit) {
    var name by remember { mutableStateOf(host.name) }
    var session by remember { mutableStateOf(host.session) }
    val valid = name.isNotBlank() && Regex("^[A-Za-z0-9_.-]{1,64}$").matches(session.trim())
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Edit ${host.name}") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true)
            OutlinedTextField(session, { session = it }, label = { Text("Core session") }, singleLine = true, keyboardOptions = plainKeys(ime = ImeAction.Done))
            Text("Paired through Pocket Link. To pair again, make a new code on the desktop.", color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
        }
    }, confirmButton = { TextButton(onClick = { onSave(host.copy(name = name.trim(), session = session.trim())) }, enabled = valid) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
