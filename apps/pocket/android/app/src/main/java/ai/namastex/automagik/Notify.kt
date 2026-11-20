package ai.namastex.automagik

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Android notifications for the desktop's alerts, in the app and away from it, for agents the person isn't looking at: one per agent, with Reply
 * (typed into the agent like the composer) and a tap that opens it.
 */
object Notify {
    const val NEEDS_YOU = "needs_you"
    const val DONE = "done"
    const val EXTRA_HOST = "ai.namastex.automagik.host"
    const val EXTRA_ADDRESS = "ai.namastex.automagik.address"
    private const val EXTRA_TITLE = "ai.namastex.automagik.title"
    private const val KEY_REPLY = "reply"

    fun channels(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
            NotificationChannel(NEEDS_YOU, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply { description = "An agent asks something or waits for approval." },
            NotificationChannel(DONE, "Done", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "An agent finished a turn." }))
    }

    fun allowed(context: Context) = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    fun id(ref: TerminalRef) = "${ref.hostId}|${ref.address}".hashCode()

    /** The actions' titles in order: one per choice ("Always" for a "don't ask again" option), then Reply if there's room. */
    fun titles(choices: List<Prompt.Choice>) =
        choices.map { if (it.always) "Always" else it.label.take(40) } + if (choices.size < 3) listOf("Reply") else emptyList()

    /** [detail]: what it asks or said, and where it runs. [lockScreen]: Reply works without unlocking, and the content shows there. */
    /** [menu]: the options on the agent's screen, which become buttons (see [Prompt.choices]), and their dialog text. */
    fun post(context: Context, alert: Alerts.Alert, detail: String, silent: Boolean, lockScreen: Boolean, menu: Prompt.Menu? = null) =
        post(context, alert.ref, alert.kind, alert.text, detail, silent, lockScreen, null,
            Prompt.choices(alert.terminal.kind, menu), menu?.options.orEmpty(), alert.terminal.message, menu?.dialog.orEmpty())

    /** The alert and its actions when answers from notifications are available. */
    private fun detailed(context: Context, ref: TerminalRef, kind: String, title: String, detail: String, silent: Boolean, lockScreen: Boolean,
                         sent: String?, choices: List<Prompt.Choice>, options: List<String>, msg: String, dialog: String): Notification {
        // One button per option; each remembers the question and the whole menu, so a stale tap presses nothing.
        // A permission with a "don't ask again" option fills all three: Yes, Always, No, and Reply goes (Android shows at
        // most three); tapping the notification still opens the agent to type. Always is locked like the others.
        val names = titles(choices)
        val picks = choices.mapIndexed { i, c ->
            NotificationCompat.Action.Builder(R.drawable.ic_notify, names[i], PendingIntent.getBroadcast(context, id(ref) * 31 + c.index + 1,
                Intent(context, ChoiceReceiver::class.java).putExtra(EXTRA_HOST, ref.hostId).putExtra(EXTRA_ADDRESS, ref.address).putExtra(EXTRA_TITLE, title)
                    .putExtra(EXTRA_KIND, kind).putExtra(EXTRA_DETAIL, detail).putExtra(EXTRA_MSG, msg)
                    .putStringArrayListExtra(EXTRA_OPTIONS, ArrayList(options)).putExtra(EXTRA_INDEX, c.index).putExtra(EXTRA_LABEL, c.label)
                    .putExtra(EXTRA_DIALOG, dialog),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).setAuthenticationRequired(!lockScreen).build()
        }
        val reply = NotificationCompat.Action.Builder(R.drawable.ic_notify, "Reply", PendingIntent.getBroadcast(context, id(ref),
            Intent(context, ReplyReceiver::class.java).putExtra(EXTRA_HOST, ref.hostId).putExtra(EXTRA_ADDRESS, ref.address).putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_KIND, kind).putExtra(EXTRA_DETAIL, detail),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE))
            .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel("Message to the agent").build())
            .setAllowGeneratedReplies(false).setAuthenticationRequired(!lockScreen)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).build()
        // "Always" alone doesn't say what it allows: the text does.
        val text = sent ?: choices.firstOrNull { it.always }?.let { "$detail\nAlways: ${Prompt.scope(it.label)}" } ?: detail
        return alertBuilder(context, kind)
            .setSmallIcon(R.drawable.ic_notify).setColor(BrandArgb)
            .setContentTitle(title).setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(if (kind == Alerts.BLOCKED) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (kind == Alerts.BLOCKED) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(if (lockScreen) NotificationCompat.VISIBILITY_PUBLIC else NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(open(context, ref)).setAutoCancel(true)
            .setSilent(silent || sent != null).setOnlyAlertOnce(sent != null)
            .apply { picks.forEach(::addAction); if (picks.size < 3) addAction(reply) }.build()
    }

    /** [sent]: a reply's outcome, shown in place of [detail] without alerting again. */
    fun post(context: Context, ref: TerminalRef, kind: String, title: String, detail: String, silent: Boolean, lockScreen: Boolean, sent: String?,
             choices: List<Prompt.Choice> = emptyList(), options: List<String> = emptyList(), msg: String = "", dialog: String = "") {
        if (!allowed(context)) return
        synchronized(AppLock.notifyLock) {
            val n = if (AppLock.enabled) generic(context, ref, kind, silent, sent)
                else detailed(context, ref, kind, title, detail, silent, lockScreen, sent, choices, options, msg, dialog)
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            runCatching { NotificationManagerCompat.from(context).notify(id(ref), n) }
        }
    }

    private const val LOCKED_OUTCOME = "Not sent: Automagik is locked. Open it to answer."

    private fun alertBuilder(context: Context, kind: String) = NotificationCompat.Builder(context, if (kind == Alerts.BLOCKED) NEEDS_YOU else DONE)

    private fun generic(context: Context, ref: TerminalRef, kind: String, silent: Boolean, sent: String?): Notification {
        val text = when {
            sent == LOCKED_OUTCOME -> LOCKED_OUTCOME
            kind == Alerts.BLOCKED -> "An agent needs you."
            else -> "An agent finished."
        }
        return alertBuilder(context, kind).setSmallIcon(R.drawable.ic_notify).setColor(BrandArgb)
            .setContentTitle("Automagik").setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(if (kind == Alerts.BLOCKED) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (kind == Alerts.BLOCKED) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(open(context, ref)).setAutoCancel(true)
            .setSilent(silent || sent != null).setOnlyAlertOnce(sent != null).build()
    }

    /** A stale action can arrive without a view model, including at process start. */
    private fun rejectLocked(context: Context, ref: TerminalRef, kind: String): Boolean = synchronized(AppLock.notifyLock) {
        if (!AppLock.enabled) return@synchronized false
        post(context, ref, kind, "", "", silent = true, lockScreen = false, sent = LOCKED_OUTCOME)
        true
    }

    fun cancel(context: Context, ref: TerminalRef) = NotificationManagerCompat.from(context).cancel(id(ref))

    fun cancelAlerts(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.notification.channelId == NEEDS_YOU || it.notification.channelId == DONE }
            .forEach { manager.cancel(it.tag, it.id) }
    }

    private fun open(context: Context, ref: TerminalRef) = PendingIntent.getActivity(context, id(ref),
        Intent(context, MainActivity::class.java).putExtra(EXTRA_HOST, ref.hostId).putExtra(EXTRA_ADDRESS, ref.address)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** The agent a notification's tap opens, if [intent] came from one. */
    fun opened(intent: Intent?): TerminalRef? {
        val host = intent?.getStringExtra(EXTRA_HOST) ?: return null
        return TerminalRef(host, intent.getStringExtra(EXTRA_ADDRESS) ?: return null)
    }

    private const val EXTRA_KIND = "ai.namastex.automagik.kind"
    private const val EXTRA_MSG = "ai.namastex.automagik.msg"
    private const val EXTRA_DIALOG = "ai.namastex.automagik.dialog"
    private const val EXTRA_OPTIONS = "ai.namastex.automagik.options"
    private const val EXTRA_INDEX = "ai.namastex.automagik.index"
    private const val EXTRA_LABEL = "ai.namastex.automagik.label"

    /** An option's button: picks it in the agent, after checking the same question and menu are still there. */
    class ChoiceReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val ref = opened(intent) ?: return
            val kind = intent.getStringExtra(EXTRA_KIND) ?: Alerts.BLOCKED
            if (rejectLocked(context, ref, kind)) return
            val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
            val detail = intent.getStringExtra(EXTRA_DETAIL).orEmpty()
            fun show(outcome: String) = post(context, ref, kind, title, detail, silent = true,
                lockScreen = PocketViewModel.current?.state?.value?.lockAnswers ?: false, sent = outcome)
            val vm = PocketViewModel.current ?: run { show("Not sent: open Automagik and connect first."); return }
            val pending = goAsync()
            scope.launch {
                try {
                    show(vm.choose(ref, intent.getStringExtra(EXTRA_MSG).orEmpty(), intent.getStringExtra(EXTRA_DIALOG).orEmpty(),
                        intent.getStringArrayListExtra(EXTRA_OPTIONS).orEmpty(), intent.getIntExtra(EXTRA_INDEX, -1), intent.getStringExtra(EXTRA_LABEL).orEmpty()))
                } finally { pending.finish() }
            }
        }
    }
    private const val EXTRA_DETAIL = "ai.namastex.automagik.detail"

    /** Reply: sends the typed text through the open connection and shows the outcome in the same notification. */
    class ReplyReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val ref = opened(intent) ?: return
            val kind = intent.getStringExtra(EXTRA_KIND) ?: Alerts.BLOCKED
            if (rejectLocked(context, ref, kind)) return
            val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY)?.toString()?.trim().orEmpty()
            val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
            val detail = intent.getStringExtra(EXTRA_DETAIL).orEmpty()
            fun show(outcome: String) = post(context, ref, kind, title, detail, silent = true,
                lockScreen = PocketViewModel.current?.state?.value?.lockAnswers ?: false, sent = outcome)
            if (text.isBlank()) return
            val pending = goAsync()
            val vm = PocketViewModel.current
            if (vm == null) { show("Not sent: open Automagik and connect first."); pending.finish(); return }
            scope.launch {
                try { show(vm.reply(ref, text)) } finally { pending.finish() }
            }
        }
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
}
