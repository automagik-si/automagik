package ai.namastex.automagik

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle

internal object AppUpdates {
    fun init(context: Context) = Updater.init(context)

    fun setForeground(shown: Boolean) {
        if (shown) Updater.opened() else Updater.left()
    }

    fun registerUsage(foreground: () -> Boolean, terminalOpen: () -> Boolean, watching: () -> Boolean) {
        Updater.usage = { Updater.Usage(foreground(), terminalOpen(), watching()) }
    }

    fun touched() = Updater.touched()

    fun openInstallNotification(activity: Activity, intent: Intent?, showSettings: () -> Unit): Boolean {
        if (intent?.action != Updater.ACTION_INSTALL) return false
        showSettings()
        Updater.installFromNotification(activity)
        return true
    }

    /** Open Android's prompt for a manual install and continue after the install permission screen. */
    @Composable
    fun InstallEffects() {
        val activity = LocalActivity.current
        val update by Updater.state.collectAsStateWithLifecycle()
        LaunchedEffect(update) {
            when (val current = update) {
                is UpdateState.Confirm -> {
                    runCatching { activity?.startActivity(current.intent) }
                    Updater.confirming(current.release)
                }
                is UpdateState.Available -> if (Updater.takeStartWhenFound()) activity?.let(Updater::start)
                else -> {}
            }
        }
        LifecycleResumeEffect(Unit) { activity?.let(Updater::resume); onPauseOrDispose { } }
    }

    @Composable
    fun ToolbarDivider() {
        val update by Updater.state.collectAsStateWithLifecycle()
        val download = (update as? UpdateState.Downloading)?.takeIf { it.manual }
        if (download != null) {
            LinearProgressIndicator(
                progress = { download.progress },
                modifier = Modifier.fillMaxWidth().height(2.dp),
                color = Accent,
                trackColor = Border,
            )
        } else {
            HorizontalDivider(color = Border)
        }
    }

    @Composable
    fun Settings() {
        Spacer(Modifier.height(16.dp))
        UpdateRow()
    }
}

/** Settings → About: check for a newer build, install it, and whether updates install on their own. */
@Composable private fun UpdateRow() {
    val update by Updater.state.collectAsStateWithLifecycle()
    val auto by Updater.auto.collectAsStateWithLifecycle()
    val updated by Updater.updated.collectAsStateWithLifecycle()
    val activity = LocalActivity.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        updated?.let { Text(it, color = Muted, fontSize = 12.sp, lineHeight = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        when (val u = update) {
            is UpdateState.Available, is UpdateState.NeedsPermission, is UpdateState.Waiting -> {
                val release = when (u) { is UpdateState.Available -> u.release; is UpdateState.NeedsPermission -> u.release; else -> (u as UpdateState.Waiting).release }
                Button(onClick = { activity?.let(Updater::start) }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                    Text(if (u is UpdateState.Waiting) "Install ${release.label} now" else "Update to ${release.label}") }
                if (u is UpdateState.Waiting) Text("Downloaded. It installs on its own when you leave Automagik.", color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
                if (release.notes.isNotBlank()) Text(release.notes, color = Muted, fontSize = 12.sp, lineHeight = 17.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
                if (u is UpdateState.NeedsPermission) Text("Allow Automagik to install apps, then come back here. Android asks this once.", color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
            }
            is UpdateState.Downloading -> {
                Text("Downloading ${u.release.label}…", fontSize = 13.sp)
                LinearProgressIndicator(progress = { u.progress }, Modifier.fillMaxWidth(), color = Accent, trackColor = Border)
            }
            is UpdateState.Installing, is UpdateState.Confirm -> Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(10.dp)); Text("Installing…", fontSize = 13.sp)
            }
            else -> Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { Updater.check() }, enabled = u != UpdateState.Checking) { Text(if (u == UpdateState.Checking) "Checking…" else "Check for updates") }
                Spacer(Modifier.width(12.dp))
                when (u) {
                    UpdateState.Current -> Text("You have the latest build.", color = Muted, fontSize = 12.sp)
                    is UpdateState.Failed -> Text(u.message, color = Blocked, fontSize = 12.sp, lineHeight = 17.sp)
                    else -> {}
                }
            }
        }
        if ((update as? UpdateState.Failed)?.release != null) TextButton(onClick = { activity?.let(Updater::start) }, contentPadding = PaddingValues(0.dp)) { Text("Try again") }
        AlertRow("Install updates automatically", if (Build.VERSION.SDK_INT >= UpdatePolicy.SILENT_SDK)
            "New versions download on Wi-Fi and install while you’re away from the app; a notification says so after. Off, a notification asks first."
            else "Android ${Build.VERSION.RELEASE} asks before each update: a notification says when one is ready.", auto) { Updater.setAuto(it) }
    }
}
