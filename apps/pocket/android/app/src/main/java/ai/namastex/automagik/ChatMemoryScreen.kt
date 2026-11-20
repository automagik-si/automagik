package ai.namastex.automagik

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy

/** The secure windows keep memory and drafts out of screenshots and the recent-apps preview. */
@Composable internal fun ChatMemoryDialog(vm: PocketViewModel, s: ChatMemory.State) {
    val secure = DialogProperties(securePolicy = SecureFlagPolicy.SecureOn)
    if (s.phase == ChatMemory.Phase.CLOSED) {
        AlertDialog(onDismissRequest = vm::closeMemory, properties = secure,
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    s.outcome?.let { MemoryOutcome(it) }
                    s.status?.let { Text(ChatText.clean(it), fontSize = 12.sp, color = Blocked) }
                }
            },
            confirmButton = { TextButton(onClick = vm::closeMemory) { Text("Close") } })
        return
    }
    var draft by remember(s.token) { mutableStateOf("") }
    var selected by remember(s.token, s.snapshot, s.phase, s.op) { mutableStateOf<ChatMemory.Entry?>(null) }
    val canEdit = s.canWrite("memory.edit")
    AlertDialog(onDismissRequest = vm::closeMemory, properties = secure, title = { Text("Memory") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Memory text goes only between this phone and your computer, and the phone keeps it only while this is open.",
                    fontSize = 12.sp, color = Muted)
                if (s.phase in listOf(ChatMemory.Phase.CONNECTING, ChatMemory.Phase.LOADING, ChatMemory.Phase.RECONCILING))
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                s.outcome?.let { MemoryOutcome(it) }
                s.status?.let {
                    Text(ChatText.clean(it), fontSize = 12.sp, color = if (s.phase == ChatMemory.Phase.READ_FAILED) Blocked else Muted)
                }
                s.snapshot?.let { snapshot ->
                    LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        s.confirmed?.let { entry -> item("confirmed") {
                            Text("Just saved", fontSize = 11.sp, color = Muted)
                            MemoryEntry(entry, canEdit) { selected = entry }
                        } }
                        items(snapshot.entries.size, key = { it }) { index ->
                            val entry = snapshot.entries[index]
                            MemoryEntry(entry, canEdit) { selected = entry }
                        }
                    }
                    Text("Main memory: ${snapshot.size} of ${snapshot.limit} characters", fontSize = 12.sp, color = Muted)
                    if (snapshot.truncated) Text("Some entries aren't shown.", fontSize = 12.sp, color = Muted)
                }
                if (s.canWrite("memory.add")) {
                    OutlinedTextField(draft, { draft = it }, modifier = Modifier.fillMaxWidth(), label = { Text("New entry") }, maxLines = 4)
                    TextButton(onClick = {
                        vm.memoryAdd(draft)
                        if (ChatMemory.checkText(draft) == null) draft = ""
                    }) { Text("Add") }
                }
            }
        },
        dismissButton = if (s.canRefresh) {
            { TextButton(onClick = vm::refreshMemory) { Text("Refresh") } }
        } else null,
        confirmButton = { TextButton(onClick = vm::closeMemory) { Text("Close") } })
    selected?.takeIf { canEdit }?.let { entry ->
        EditMemoryDialog(entry, secure, onDismiss = { selected = null }) { text, valid ->
            vm.memoryEdit(entry, text)
            if (valid) selected = null
        }
    }
}

@Composable private fun MemoryOutcome(outcome: String) {
    Text(ChatText.clean(outcome), fontSize = 12.sp,
        color = if (outcome == ChatMemory.SAVED || outcome == ChatMemory.UNCHANGED) Muted else Blocked)
}

@Composable private fun MemoryEntry(entry: ChatMemory.Entry, canEdit: Boolean, onEdit: () -> Unit) {
    Column {
        Text(ChatText.clean(entry.text), fontSize = 14.sp, color = Ink)
        val meta = listOfNotNull(entry.topic, "Pinned".takeIf { entry.pinned }, "Expired".takeIf { entry.expired },
            entry.until?.let { "Until $it" }).joinToString(" · ")
        if (meta.isNotEmpty()) Text(ChatText.clean(meta), fontSize = 11.sp, color = Muted)
        if (canEdit) TextButton(onClick = onEdit) { Text("Edit", fontSize = 12.sp) }
    }
}

@Composable private fun EditMemoryDialog(entry: ChatMemory.Entry, secure: DialogProperties, onDismiss: () -> Unit, onSave: (String, Boolean) -> Unit) {
    var draft by remember(entry) { mutableStateOf(entry.text) }
    var issue by remember(entry) { mutableStateOf<String?>(null) }
    AlertDialog(onDismissRequest = onDismiss, properties = secure, title = { Text("Edit memory") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(draft, { draft = it; issue = null }, modifier = Modifier.fillMaxWidth(), label = { Text("Entry") }, maxLines = 4)
                issue?.let { Text(it, fontSize = 12.sp, color = Blocked) }
            }
        },
        confirmButton = { TextButton(onClick = {
            issue = ChatMemory.checkText(draft)
            onSave(draft, issue == null)
        }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
