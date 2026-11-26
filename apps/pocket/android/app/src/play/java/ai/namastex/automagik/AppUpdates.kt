package ai.namastex.automagik

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.Composable

/** Google Play delivers updates for this flavor. */
@Suppress("UNUSED_PARAMETER")
internal object AppUpdates {
    fun init(context: Context) = Unit

    fun setForeground(shown: Boolean) = Unit

    fun registerUsage(foreground: () -> Boolean, terminalOpen: () -> Boolean, watching: () -> Boolean) = Unit

    fun touched() = Unit

    fun openInstallNotification(activity: Activity, intent: Intent?, showSettings: () -> Unit) = false

    @Composable
    fun InstallEffects() = Unit

    @Composable
    fun ToolbarDivider() = HorizontalDivider(color = Border)

    @Composable
    fun Settings() = Unit
}
