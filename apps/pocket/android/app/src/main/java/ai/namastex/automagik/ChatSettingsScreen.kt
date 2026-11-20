package ai.namastex.automagik

import ai.namastex.automagik.ChatSettings.Op
import ai.namastex.automagik.ChatSettings.Phase
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy

private data class SettingsEditor(val token: Long, val rev: String, val op: Op)

@Composable internal fun ChatSettingsDialog(vm: PocketViewModel, s: ChatSettings.State) {
    val secure = DialogProperties(securePolicy = SecureFlagPolicy.SecureOn)
    val closed = s.phase == Phase.CLOSED
    val snapshot = s.snapshot
    val settings = snapshot?.settings
    var selected by remember(s.token, settings?.rev) { mutableStateOf<SettingsEditor?>(null) }
    val editing = selected?.takeIf { s.canEdit(it.op) }
    LaunchedEffect(selected, editing) { if (editing == null) selected = null }
    AlertDialog(onDismissRequest = vm::closeSettings, properties = secure,
        title = if (closed) null else ({ Text("Bot settings") }),
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                s.notice?.let { Text(it, fontSize = 12.sp, color = Blocked) }
                if (s.op != Op.NONE) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                s.outcome?.let { Text(ChatText.clean(it), fontSize = 12.sp, color = Ink) }
                s.status?.let {
                    Text(it, fontSize = 12.sp, color = if (closed || s.phase == Phase.READ_FAILED) Blocked else Muted)
                }
                if (s.autoOff) Text(ChatSettings.AUTO_OFF, fontSize = 12.sp, color = Muted)
                if (snapshot != null) SettingsDetails(s, snapshot) { op -> selected = SettingsEditor(s.token, snapshot.settings.rev, op) }
            }
        },
        dismissButton = if (s.canRefresh) {
            { TextButton(onClick = vm::refreshSettings) { Text("Refresh") } }
        } else null,
        confirmButton = { TextButton(onClick = vm::closeSettings) { Text("Close") } })
    if (editing != null && snapshot != null) {
        key(editing) {
            when (editing.op) {
                Op.NAME -> RenameBotDialog(snapshot.settings.name, secure, onDismiss = { selected = null }) { name ->
                    vm.settingsName(editing.token, editing.rev, name)
                    selected = null
                }
                Op.MODEL -> ChangeBotModelDialog(snapshot, secure, onDismiss = { selected = null }) { model ->
                    vm.settingsModel(editing.token, editing.rev, model)
                    selected = null
                }
                else -> Unit
            }
        }
    }
}

@Composable private fun SettingsDetails(s: ChatSettings.State, snapshot: ChatSettings.Snapshot, onEdit: (Op) -> Unit) {
    val settings = snapshot.settings
    val model = settings.model
    Text(ChatText.clean(settings.name), fontSize = 14.sp, color = Ink)
    if (Op.NAME.method in s.grants) {
        TextButton(onClick = { onEdit(Op.NAME) }, enabled = s.canEdit(Op.NAME)) { Text("Rename") }
    }
    Text(ChatText.clean(model.label ?: model.saved ?: "No model"), fontSize = 14.sp, color = Ink)
    if (model.running != null && model.running != model.saved)
        Text(ChatText.clean("Its chat runs ${model.running} now."), fontSize = 12.sp, color = Muted)
    if (Op.MODEL.method in s.grants) {
        TextButton(onClick = { onEdit(Op.MODEL) }, enabled = s.canEdit(Op.MODEL)) { Text("Change model") }
    }
    if (settings.editable.model && snapshot.models.entries.isEmpty())
        Text(ChatSettings.EMPTY_MODELS, fontSize = 12.sp, color = Muted)
    ChatSettings.editableReason(settings.editable.reason)?.takeIf { it != s.outcome }
        ?.let { Text(it, fontSize = 12.sp, color = Muted) }
    ChatSettings.levelLines(settings.level).forEach { Text(it, fontSize = 12.sp, color = Ink) }
    Text("The level is changed on the computer.", fontSize = 12.sp, color = Muted)
}

@Composable private fun RenameBotDialog(name: String, secure: DialogProperties, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var draft by remember { mutableStateOf(name) }
    var issue by remember { mutableStateOf<String?>(null) }
    AlertDialog(onDismissRequest = onDismiss, properties = secure, title = { Text("Rename Bot") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(draft, { draft = it; issue = null }, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Bot name") }, singleLine = true)
                issue?.let { Text(it, fontSize = 12.sp, color = Blocked) }
            }
        },
        confirmButton = { TextButton(onClick = {
            issue = ChatSettings.checkName(draft)
            if (issue == null) onSave(draft)
        }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable private fun ChangeBotModelDialog(snapshot: ChatSettings.Snapshot, secure: DialogProperties,
                                             onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val entries = snapshot.models.entries
    AlertDialog(onDismissRequest = onDismiss, properties = secure, title = { Text("Change model") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (snapshot.settings.level.auto) Text("Changing the model can turn Auto off.", fontSize = 12.sp, color = Muted)
                LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 360.dp)) {
                    items(entries.size) { index ->
                        val choice = entries[index]
                        TextButton(onClick = { onPick(choice.id) }, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.fillMaxWidth()) {
                                Text(ChatText.clean(choice.label))
                                Text(ChatText.clean(choice.provider), fontSize = 12.sp, color = Muted)
                                if (choice.id == snapshot.settings.model.saved)
                                    Text("Current model", fontSize = 12.sp, color = Muted)
                            }
                        }
                    }
                }
                if (snapshot.models.truncated) Text("More models are on the computer.", fontSize = 12.sp, color = Muted)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
