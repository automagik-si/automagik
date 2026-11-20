package ai.namastex.automagik

import ai.namastex.automagik.ChatSchedules.Phase
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy

/** Both windows are secure because task details and drafts belong only in the open dialog. */
@Composable internal fun ChatSchedulesDialog(vm: PocketViewModel, s: ChatSchedules.State) {
    val secure = DialogProperties(securePolicy = SecureFlagPolicy.SecureOn)
    val closed = s.phase == Phase.CLOSED
    var selected by remember(s.token) { mutableStateOf<Pair<String, String>?>(null) }
    val editing = selected?.let { (id, rev) ->
        s.listing?.tasks?.find { it.id == id && it.rev == rev && s.canAct("schedule.rename", it) }
    }
    LaunchedEffect(selected, editing) { if (editing == null) selected = null }
    AlertDialog(onDismissRequest = vm::closeSchedules, properties = secure,
        title = if (closed) null else ({ Text("Schedules") }),
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                s.notice?.let { Text(it, fontSize = 12.sp, color = Blocked) }
                if (!closed) {
                    Text("Task names and times go only between this phone and your computer, and the phone keeps them only while this is open.",
                        fontSize = 12.sp, color = Muted)
                    if (s.phase in listOf(Phase.CONNECTING, Phase.LOADING, Phase.RECONCILING))
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
                s.outcome?.let { Text(ChatText.clean(it), fontSize = 12.sp, color = Ink) }
                s.status?.let {
                    Text(ChatText.clean(it), fontSize = 12.sp, color = if (closed || s.phase == Phase.READ_FAILED) Blocked else Muted)
                }
                if (!closed) s.listing?.let { listing ->
                    if (listing.tasks.isEmpty()) Text("No scheduled tasks for this Bot.", fontSize = 12.sp, color = Muted)
                    else LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 360.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(listing.tasks.size, key = { it }) { index ->
                            val task = listing.tasks[index]
                            ScheduleRow(vm, s, task) { selected = task.id to task.rev }
                        }
                    }
                    if (listing.truncated) Text("Some tasks aren't shown.", fontSize = 12.sp, color = Muted)
                }
            }
        },
        dismissButton = if (s.canRefresh) {
            { TextButton(onClick = vm::refreshSchedules) { Text("Refresh") } }
        } else null,
        confirmButton = { TextButton(onClick = vm::closeSchedules) { Text("Close") } })
    editing?.let { task ->
        key(s.token, task.id, task.rev) {
            RenameScheduleDialog(task, secure, onDismiss = { selected = null }) { title ->
                vm.scheduleRename(task, title)
                selected = null
            }
        }
    }
}

@Composable private fun ScheduleRow(vm: PocketViewModel, s: ChatSchedules.State, task: ChatSchedules.Task, onRename: () -> Unit) {
    Column {
        Text(ChatText.clean(task.title), fontSize = 14.sp, color = Ink)
        val (instant, rule) = ChatSchedules.timingText(task)
        val state = task.state.replaceFirstChar { it.uppercaseChar() }
        Text(ChatText.clean(listOfNotNull(state, instant).joinToString(" · ")), fontSize = 11.sp, color = Muted)
        Text(ChatText.clean(rule), fontSize = 11.sp, color = Muted)
        if (task.id == s.uncertain) Text("Refresh to check this task first.", fontSize = 11.sp, color = Muted)
        else if (task.id in s.needsRefresh) Text("Refresh to see its current state.", fontSize = 11.sp, color = Muted)
        val pause = s.canAct("schedule.pause", task)
        val resume = s.canAct("schedule.resume", task)
        val rename = s.canAct("schedule.rename", task)
        if (pause || resume || rename) Row {
            if (pause) TextButton(onClick = { vm.schedulePause(task) }) { Text("Pause", fontSize = 12.sp) }
            if (resume) TextButton(onClick = { vm.scheduleResume(task) }) { Text("Resume", fontSize = 12.sp) }
            if (rename) TextButton(onClick = onRename) { Text("Rename", fontSize = 12.sp) }
        }
    }
}

@Composable private fun RenameScheduleDialog(task: ChatSchedules.Task, secure: DialogProperties, onDismiss: () -> Unit,
                                            onSave: (String) -> Unit) {
    var draft by remember { mutableStateOf(task.title) }
    var issue by remember { mutableStateOf<String?>(null) }
    AlertDialog(onDismissRequest = onDismiss, properties = secure, title = { Text("Rename task") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(draft, { draft = it; issue = null }, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Task name") }, singleLine = true)
                issue?.let { Text(it, fontSize = 12.sp, color = Blocked) }
            }
        },
        confirmButton = { TextButton(onClick = {
            issue = ChatSchedules.checkTitle(draft)
            if (issue == null) onSave(draft)
        }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
