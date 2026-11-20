package ai.namastex.automagik

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

/** Both launchers stay registered while the chat reconnects after returning from the picker. */
@Composable
internal fun rememberAttachPicker(session: AttachSession): (Int) -> Unit {
    val result: (List<Uri>) -> Unit = { deliverAttachPick(session, it) }
    val one = rememberLauncherForActivityResult(remember { PickVisualMedia() }) { result(listOfNotNull(it)) }
    val many = rememberLauncherForActivityResult(remember { PickMultipleVisualMedia(4) }, result)
    return { slots ->
        val request = PickVisualMediaRequest(PickVisualMedia.ImageOnly)
        if (slots == 1) one.launch(request) else many.launch(request)
    }
}

internal fun deliverAttachPick(session: AttachSession, uris: List<Uri>) {
    if (AppLock.locked()) session.pickDiscarded() else session.picked(uris)
}

@Composable
internal fun AttachButton(s: Chat.State, att: AttachState, picker: (Int) -> Unit, session: AttachSession) {
    if (!s.dsh || !ChatActions.canSend(s)) return
    IconButton(onClick = { session.pick()?.let(picker) }, modifier = Modifier.size(48.dp)) {
        Icon(Icons.Outlined.Add, "Add images", tint = if (att.peer is Attach.Peer.Offered) Accent else Muted)
    }
}

@Composable
internal fun AttachTray(att: AttachState, session: AttachSession) {
    if (att.draft.isEmpty() && att.preparing == 0) return
    Column(Modifier.padding(horizontal = 12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            for (image in att.draft) key(image.key) {
                Surface(color = Surface, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, Border),
                    modifier = Modifier.size(64.dp)) {
                    Box {
                        image.preview?.let {
                            Image(remember(it) { it.asImageBitmap() }, "Selected image", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                        }
                        IconButton(onClick = { session.removeDraft(image.key) }, modifier = Modifier.align(Alignment.TopEnd).size(48.dp)) {
                            Surface(color = Raised, shape = RoundedCornerShape(12.dp)) {
                                Icon(Icons.Outlined.Close, "Remove image", Modifier.size(16.dp), tint = Ink)
                            }
                        }
                    }
                }
            }
            if (att.preparing > 0) AttachSpinner()
        }
        if (att.draft.isNotEmpty()) {
            val slots = (att.peer as? Attach.Peer.Offered)?.offer?.files ?: 4
            Text("${att.draft.size} of $slots · ${fileSize(att.draft.sumOf { it.bytes.size.toLong() })}", color = Muted, fontSize = 12.sp)
        }
    }
}

@Composable
internal fun UploadMessageView(
    m: ImageMessage, s: Chat.State, att: AttachState, session: AttachSession,
    onCancel: () -> Unit, restoreCaption: (String) -> Unit = {}
) {
    var confirm by remember(m.id) { mutableStateOf(false) }
    val action = session.action(m, att)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Surface(color = Accent.copy(alpha = .08f), shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, Accent.copy(alpha = .3f)), modifier = Modifier.widthIn(max = 560.dp)) {
            Column(Modifier.padding(10.dp, 8.dp)) {
                if (m.caption.isNotBlank()) Text(ChatText.clean(m.caption), fontSize = 14.sp, lineHeight = 20.sp, color = Ink)
                Text(if (m.count == 1) "1 image" else "${m.count} images", fontSize = 12.sp, color = Muted)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (m.phase == Phase.UPLOADING) AttachSpinner()
                    Text(uploadLine(m, session), fontSize = 11.sp,
                        color = if (m.phase in setOf(Phase.MAYBE, Phase.REFUSED, Phase.STOPPED)) Blocked else Muted)
                }
                val removable = !m.active && (m.images.isNotEmpty() || action != AttachAction.NONE)
                if (m.phase == Phase.UPLOADING || removable || (action != AttachAction.NONE && ChatActions.canSend(s))) Row {
                    if (m.phase == Phase.UPLOADING) TextButton(onClick = onCancel) { Text("Cancel", fontSize = 12.sp) }
                    if (action != AttachAction.NONE && ChatActions.canSend(s)) {
                        val sendAsNew = action == AttachAction.SEND_AGAIN && m.uncertain && att.peer is Attach.Peer.Offered
                        TextButton(onClick = {
                            if (sendAsNew) confirm = true else session.retry(m.id, restoreCaption = restoreCaption)
                        }) {
                            Text(when {
                                action == AttachAction.RETRY -> "Retry"
                                m.uncertain -> "Send as new"
                                else -> "Send again"
                            }, fontSize = 12.sp)
                        }
                    }
                    if (removable) TextButton(onClick = { session.removeMessage(m.id) }) { Text("Remove", fontSize = 12.sp) }
                }
            }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false },
        title = { Text("Send as a new message?") },
        text = { Text("The first one may already have reached the Bot. This sends the pictures again as another message.") },
        confirmButton = { TextButton(onClick = {
            confirm = false
            session.retry(m.id, confirmed = true, restoreCaption = restoreCaption)
        }) { Text("Send") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } })
}

private fun uploadLine(m: ImageMessage, session: AttachSession) = when (m.phase) {
    Phase.UPLOADING -> "Uploading ${minOf(m.done + 1, m.count)} of ${m.count} · ${(m.progress * 100).roundToInt()}%"
    Phase.SENDING -> "Sending…"
    Phase.SENT -> "Sent"
    Phase.QUEUED -> "Queued: the agent reads it after this turn"
    Phase.CANCELLED -> "Cancelled: not sent"
    Phase.STOPPED -> if (session.stoppedAfterMove(m)) "Not sent: this Bot's chat changed on the computer."
        else "Not sent: the upload stopped (${Attach.words(m.reason, m.code)})."
    Phase.MAYBE -> if (m.reason.isBlank()) "Maybe not sent"
        else "Maybe not sent. The retry was refused: ${Attach.words(m.reason, m.code)}."
    Phase.REFUSED -> when {
        m.reason == "changed" -> "Not sent: this Retry didn't match the first message, which may already have reached the Bot."
        m.action == AttachAction.RETRY -> "Not sent (${Attach.words(m.reason, m.code)})"
        else -> "Not sent: ${Attach.words(m.reason, m.code)}"
    }
}

@Composable
internal fun AttachBlocks(row: Chat.Row, s: Chat.State, att: AttachState, session: AttachSession, openLink: (String, Boolean) -> Unit) {
    val blocks = remember(row.blocks) { Attach.renderable(row.blocks.orEmpty()) }
    if (blocks.isEmpty() && row.text.isNotBlank()) ChatTextView(row.text, openLink)
    for (block in blocks) when (block) {
        is Attach.Block.Text -> ChatTextView(block.text, openLink)
        is Attach.Block.Image -> {
            val key = AttachSession.thumbKey(row.id, block.block)
            val shown = att.shown[key]
            val size = "${block.width} × ${block.height}"
            Row(Modifier.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Image · $size", color = Muted, fontSize = 12.sp)
                if (att.loading == key) AttachSpinner()
                else if (shown == null) TextButton(enabled = att.loading == null && s.connected && !s.gone && !s.offline,
                    onClick = { session.show(row, block) }) { Text("Show", fontSize = 12.sp) }
            }
            if (shown != null) Image(remember(shown) { shown.asImageBitmap() }, "Image from the chat, $size",
                Modifier.sizeIn(maxWidth = 240.dp, maxHeight = 240.dp).clip(RoundedCornerShape(8.dp)),
                contentScale = ContentScale.Fit)
        }
        is Attach.Block.File -> Text(listOfNotNull("File", block.name, fileSize(block.bytes), "on the computer").joinToString(" · "),
            color = Muted, fontSize = 12.sp)
        is Attach.Block.More -> Text("+${block.count} more on the computer", color = Muted, fontSize = 12.sp)
    }
}

@Composable
private fun AttachSpinner() {
    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
}

private fun fileSize(bytes: Long): String {
    val (unit, label) = when {
        bytes >= 1_048_576 -> 1_048_576 to "MB"
        bytes >= 1024 -> 1024 to "KB"
        else -> return "$bytes B"
    }
    val tenths = (bytes * 10 + unit / 2) / unit
    return if (tenths % 10 == 0L) "${tenths / 10} $label" else "${tenths / 10}.${tenths % 10} $label"
}
