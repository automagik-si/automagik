package ai.namastex.automagik

import android.app.Activity
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageInstaller
import android.net.ConnectivityManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.IntentCompat
import androidx.core.content.edit
import androidx.core.net.toUri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * The newest published build, from `latest.json` on the monorepo's rolling `pocket-lane` release (the APK itself stays on
 * its `vX.Y.Z` release; docs/rfcs/0011-monorepo-parts-and-releases.md, "Pocket").
 */
data class Release(val versionCode: Long, val versionName: String, val url: String, val sha256: String, val notes: String) {
    val label get() = "$versionName ($versionCode)"
    /** Whether a download whose SHA-256 is [actual] is this build: nothing else is handed to the installer. */
    fun matches(actual: String) = actual.lowercase() == sha256
    companion object {
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        /** [cleartext]: also accept an http:// download, only for a build pointed at a local test server over http. */
        fun parse(text: String, cleartext: Boolean = BuildConfig.UPDATE_URL.startsWith("http://")): Release? = runCatching {
            val json = JSONObject(text)
            val code = json.getLong("versionCode")
            val url = json.getString("url")
            val sha = json.getString("sha256").lowercase()
            require(code > 0 && (url.startsWith("https://") || (cleartext && url.startsWith("http://"))) && SHA256.matches(sha))
            Release(code, json.optString("versionName").filterNot { it.isISOControl() }.take(40).ifBlank { "build" }, url, sha,
                json.optString("notes").take(600))
        }.getOrNull()
    }
}

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object Current : UpdateState
    /** On offer: Settings → About shows it, and a "ready" notification may be up. */
    data class Available(val release: Release) : UpdateState
    /** Android asks once whether Automagik may install apps; the update continues when the person comes back. */
    data class NeedsPermission(val release: Release) : UpdateState
    /** [manual]: the person started it, so the screen shows progress; a background download shows nothing. */
    data class Downloading(val release: Release, val progress: Float, val manual: Boolean) : UpdateState
    /** Downloaded and checked; installs on its own once Automagik isn't in use (see [UpdatePolicy.installNow]). */
    data class Waiting(val release: Release, val apk: File) : UpdateState
    /** Android's "Update this app?" prompt, for the screen to open. */
    data class Confirm(val release: Release, val intent: Intent) : UpdateState
    data class Installing(val release: Release, val manual: Boolean) : UpdateState
    data class Failed(val message: String, val release: Release?) : UpdateState
}

/**
 * Updates the installed app from the GitHub releases: download, check the hash, hand the APK to Android's installer.
 *
 * With Install updates automatically on (the default), it checks when the app opens and every 6 hours while the app or
 * its watch service runs, and on Android 12+ installs without asking once the app isn't in use. Otherwise a quiet
 * notification offers the build, and a tap runs Android's confirm prompt. After an update, the next start says so.
 */
object Updater {
    private const val MAX_APK = 200L shl 20
    private const val CHANNEL = "updates"
    private const val READY_ID = 2001
    private const val UPDATED_ID = 2002
    /** The "ready" notification's tap: [MainActivity] opens Settings and runs the confirm flow. */
    const val ACTION_INSTALL = "ai.namastex.automagik.INSTALL_UPDATE"
    private const val PREF_AUTO = "auto_update"
    private const val PREF_CHECKED = "update_checked_at"
    private const val PREF_NOTIFIED = "update_notified"
    private const val PREF_CONFIRM = "update_needs_confirm"
    private const val PREF_PENDING = "update_pending"
    private const val PREF_DONE = "update_done"

    /** What the screen is doing, for [UpdatePolicy.installNow]; [watching]: the watch service holds connections. */
    data class Usage(val foreground: Boolean = false, val terminalOpen: Boolean = false, val watching: Boolean = false)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state = _state.asStateFlow()
    private val _auto = MutableStateFlow(true)
    /** Settings → About → Install updates automatically. */
    val auto = _auto.asStateFlow()
    private val _updated = MutableStateFlow<String?>(null)
    /** "Updated to X" with its notes line, while the build the updater installed runs; Settings → About shows it. */
    val updated = _updated.asStateFlow()
    private var job: Job? = null
    private var waiter: Job? = null
    /** The session the updater committed last: an abandoned older one still reports (aborted), and is ignored. */
    @Volatile private var session = -1
    // The Application, which lives as long as the process: no screen leaks through it.
    @Volatile private var app: Application? = null
    @Volatile private var lastInput = 0L
    @Volatile private var startWhenFound = false
    @Volatile var usage: () -> Usage = { Usage() }

    private val prefs: SharedPreferences? get() = app?.getSharedPreferences("pocket", 0)

    /** Whether [release] is newer than the running build. */
    fun isNewer(release: Release, installed: Long = BuildConfig.VERSION_CODE.toLong()) = UpdatePolicy.isNewer(release.versionCode, installed)

    /** Once per process, from [PocketApplication]: say if the last update landed, then check every 6 hours. */
    fun init(context: Context) {
        if (app != null) return
        app = context.applicationContext as Application
        touched()
        _auto.value = prefs?.getBoolean(PREF_AUTO, true) ?: true
        announce(context)
        scope.launch {
            while (true) {
                val last = prefs?.getLong(PREF_CHECKED, 0L) ?: 0L
                val now = System.currentTimeMillis()
                if (UpdatePolicy.due(last, now)) automatic()
                val since = (System.currentTimeMillis() - (prefs?.getLong(PREF_CHECKED, now) ?: now)).coerceAtLeast(0)
                delay((UpdatePolicy.INTERVAL_MS - since).coerceIn(60_000L, UpdatePolicy.INTERVAL_MS))
            }
        }
    }

    fun setAuto(on: Boolean) {
        prefs?.edit { putBoolean(PREF_AUTO, on) }
        _auto.value = on
        if (on) automatic()
    }

    /** The app came on screen: check, unless a check ran in the last 15 minutes. */
    fun opened() {
        touched()
        val last = prefs?.getLong(PREF_CHECKED, 0L) ?: 0L
        if (UpdatePolicy.due(last, System.currentTimeMillis(), UpdatePolicy.OPEN_DEBOUNCE_MS)) automatic()
        else tryInstall()
    }

    /** The app left the screen: a waiting update may install now. */
    fun left() = tryInstall()

    /** Any touch or key in the app, so a waiting update doesn't close it under the person. */
    fun touched() { lastInput = SystemClock.elapsedRealtime() }

    private fun busy() = job?.isActive == true || _state.value.let {
        it is UpdateState.Downloading || it is UpdateState.Installing || it is UpdateState.Confirm || it is UpdateState.Waiting
    }

    /** The automatic check: silent install where Android allows it, a notification where it doesn't. */
    private fun automatic() {
        val context = app ?: return
        if (busy()) { tryInstall(); return }
        job = scope.launch {
            prefs?.edit { putLong(PREF_CHECKED, System.currentTimeMillis()) }
            val release = runCatching { fetch(BuildConfig.UPDATE_URL) }.getOrNull()
            if (release == null) { if (_state.value is UpdateState.Checking) _state.value = UpdateState.Idle; return@launch }
            if (!isNewer(release)) { _state.value = UpdateState.Current; return@launch }
            val asked = prefs?.getLong(PREF_CONFIRM, 0L) == release.versionCode
            val route = UpdatePolicy.route(Build.VERSION.SDK_INT, _auto.value && !asked, context.packageManager.canRequestPackageInstalls(), metered(context))
            if (route == UpdatePolicy.Route.NOTIFY) { _state.value = UpdateState.Available(release); notifyReady(context, release); return@launch }
            runCatching { download(context, release, manual = false) }
                .onSuccess { apk -> _state.value = UpdateState.Waiting(release, apk); tryInstall() }
                // A failed background download stays on offer in Settings and tries again at the next check.
                .onFailure { _state.value = UpdateState.Available(release) }
        }
    }

    /** Installs a waiting update once the app isn't in use; until then looks again every minute. */
    private fun tryInstall() {
        val waiting = _state.value as? UpdateState.Waiting ?: return
        val context = app ?: return
        // Switched off after the download: offer it instead.
        if (!_auto.value) { _state.value = UpdateState.Available(waiting.release); notifyReady(context, waiting.release); return }
        val use = usage()
        val since = SystemClock.elapsedRealtime() - lastInput
        if (!UpdatePolicy.installNow(use.foreground, use.terminalOpen, since)) {
            if (waiter?.isActive != true) waiter = scope.launch { while (_state.value is UpdateState.Waiting) { delay(60_000); tryInstall() } }
            return
        }
        waiter?.cancel()
        job = scope.launch {
            runCatching { install(context, waiting.release, waiting.apk, manual = false, watching = use.watching) }
                .onFailure { _state.value = UpdateState.Available(waiting.release) }
        }
    }

    /** Looks for a newer build. [quiet] keeps a failed check from showing as an error. */
    fun check(quiet: Boolean = false) {
        if (busy()) return
        _state.value = UpdateState.Checking
        job = scope.launch {
            prefs?.edit { putLong(PREF_CHECKED, System.currentTimeMillis()) }
            _state.value = runCatching { fetch(BuildConfig.UPDATE_URL) }.fold(
                { release -> if (release != null && isNewer(release)) UpdateState.Available(release) else UpdateState.Current },
                { e -> if (quiet) UpdateState.Idle else UpdateState.Failed("Couldn’t check for updates: ${e.message ?: "no connection"}", null) })
        }
    }

    /** The "ready" notification's tap: install what it offered, after looking it up again if the app restarted since. */
    fun installFromNotification(activity: Activity) {
        cancelReady(activity)
        when (_state.value) {
            is UpdateState.Available, is UpdateState.NeedsPermission, is UpdateState.Failed, is UpdateState.Waiting -> start(activity)
            is UpdateState.Idle, is UpdateState.Current -> { startWhenFound = true; check() }
            else -> {}
        }
    }

    /** True once, when a check started by the notification found the build: the screen then calls [start]. */
    fun takeStartWhenFound(): Boolean = startWhenFound.also { startWhenFound = false }

    /** Starts installing the release on offer; first sends the person to allow installs if Android hasn't yet. */
    fun start(activity: Activity) {
        val release = when (val s = _state.value) {
            is UpdateState.Available -> s.release
            is UpdateState.NeedsPermission -> s.release
            is UpdateState.Waiting -> s.release
            is UpdateState.Failed -> s.release ?: return
            else -> return
        }
        if (!activity.packageManager.canRequestPackageInstalls()) {
            _state.value = UpdateState.NeedsPermission(release)
            runCatching { activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${activity.packageName}".toUri())) }
            return
        }
        waiter?.cancel()
        val context = activity.applicationContext
        job = scope.launch {
            runCatching { install(context, release, download(context, release, manual = true), manual = true, watching = usage().watching) }
                .onFailure { e -> _state.value = UpdateState.Failed("Update failed: ${e.message ?: e.javaClass.simpleName}", release) }
        }
    }

    /** Back from Android's install permission screen: continue if it was granted. */
    fun resume(activity: Activity) {
        if (_state.value is UpdateState.NeedsPermission && activity.packageManager.canRequestPackageInstalls()) start(activity)
    }

    /** The screen opened Android's prompt; the receiver reports what the person chose. */
    fun confirming(release: Release) { _state.value = UpdateState.Installing(release, manual = true) }

    private fun metered(context: Context) =
        runCatching { context.getSystemService(ConnectivityManager::class.java).isActiveNetworkMetered }.getOrDefault(true)

    private fun fetch(url: String): Release? {
        val text = open(url).run { try { inputStream.bufferedReader().use { it.readText().take(8192) } } finally { disconnect() } }
        return Release.parse(text)
    }

    private fun open(url: String) = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15_000; readTimeout = 30_000; instanceFollowRedirects = true
        setRequestProperty("User-Agent", "HerdrPocket/${BuildConfig.VERSION_NAME}")
        if (responseCode !in 200..299) { disconnect(); error("the server answered $responseCode") }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(64 shl 10); while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun download(context: Context, release: Release, manual: Boolean): File {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        val file = File(dir, "automagik-${release.versionCode}.apk")
        // Already downloaded and still matching the published hash: a tap on the notification needn't fetch it again.
        if (file.isFile && runCatching { sha256(file) }.getOrNull()?.let(release::matches) == true) return file
        dir.listFiles()?.forEach { it.delete() }
        val digest = MessageDigest.getInstance("SHA-256")
        _state.value = UpdateState.Downloading(release, 0f, manual)
        val connection = open(release.url)
        try {
            val total = connection.contentLengthLong.takeIf { it > 0 }
            check((total ?: 0) <= MAX_APK) { "the download is too large" }
            connection.inputStream.use { input -> file.outputStream().use { output ->
                val buffer = ByteArray(64 shl 10); var read = 0L; var shown = 0f
                while (true) {
                    val n = input.read(buffer); if (n < 0) break
                    read += n; check(read <= MAX_APK) { "the download is too large" }
                    digest.update(buffer, 0, n); output.write(buffer, 0, n)
                    val progress = total?.let { read.toFloat() / it } ?: 0f
                    if (progress - shown >= .01f) { shown = progress; _state.value = UpdateState.Downloading(release, progress, manual) }
                }
            } }
        } finally { connection.disconnect() }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        if (!release.matches(sha)) { file.delete(); error("the download doesn’t match the published build") }
        return file
    }

    private fun install(context: Context, release: Release, apk: File, manual: Boolean, watching: Boolean) {
        _state.value = UpdateState.Installing(release, manual)
        // Written before Android replaces the app: the next start reads it to say "Updated to X".
        prefs?.edit { putString(PREF_PENDING, JSONObject().put("code", release.versionCode).put("name", release.versionName)
            .put("notes", release.notes).put("watching", watching).toString()) }
        val installer = context.packageManager.packageInstaller
        // One update session at a time: a background attempt Android left waiting for a confirmation goes.
        installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } }
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName); setSize(apk.length())
            // Android 12+ updates an app that updates itself without asking (see UpdatePolicy); otherwise it reports
            // STATUS_PENDING_USER_ACTION and the person confirms.
            if (Build.VERSION.SDK_INT >= UpdatePolicy.SILENT_SDK) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params).also { session = it }
        installer.openSession(id).use { session ->
            session.openWrite("automagik.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; session.fsync(out) }
            val callback = Intent(context, UpdateReceiver::class.java).putExtra(PackageInstaller.EXTRA_SESSION_ID, id)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, id, callback, flags).intentSender)
        }
    }

    internal fun reported(id: Int, status: Int, message: String?, confirm: Intent?) {
        if (id != session) return
        val (release, manual) = when (val s = _state.value) {
            is UpdateState.Installing -> s.release to s.manual; is UpdateState.Confirm -> s.release to true; else -> null
        } ?: return
        val context = app
        if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_PENDING_USER_ACTION) prefs?.edit { remove(PREF_PENDING) }
        _state.value = when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> when {
                confirm == null -> UpdateState.Failed("Android didn’t ask to install the update.", release)
                manual -> UpdateState.Confirm(release, confirm)
                // In the background Android wants a confirmation (not its own installer yet, or older rules): offer it
                // by notification, and don't try silently again for this build.
                else -> {
                    prefs?.edit { putLong(PREF_CONFIRM, release.versionCode) }
                    context?.let { notifyReady(it, release) }
                    UpdateState.Available(release)
                }
            }
            PackageInstaller.STATUS_SUCCESS -> UpdateState.Current
            PackageInstaller.STATUS_FAILURE_ABORTED -> UpdateState.Available(release)
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> UpdateState.Failed(
                "This copy of Automagik was signed with a different key. Uninstall it once, then install the release from GitHub.", null)
            PackageInstaller.STATUS_FAILURE_STORAGE -> UpdateState.Failed("Not enough storage to install the update.", release)
            else -> UpdateState.Failed("Android didn’t install the update${message?.let { ": $it" }.orEmpty()}.", release)
        }
    }

    private fun channel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Updates", NotificationManager.IMPORTANCE_LOW).apply {
                description = "A new version is ready to install, or has just installed."; setShowBadge(false) })
    }

    /** "Automagik X is ready · Install", once per build. */
    private fun notifyReady(context: Context, release: Release) {
        if (!UpdatePolicy.shouldNotify(release.versionCode, prefs?.getLong(PREF_NOTIFIED, 0L) ?: 0L) || !Notify.allowed(context)) return
        channel(context)
        val tap = PendingIntent.getActivity(context, READY_ID, Intent(context, MainActivity::class.java).setAction(ACTION_INSTALL),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notify).setColor(BrandArgb)
            .setContentTitle("Automagik ${release.versionName} is ready")
            .setContentText(UpdatePolicy.notesLine(release.notes).ifBlank { "Tap to install." })
            .setContentIntent(tap).addAction(R.drawable.ic_notify, "Install", tap).setAutoCancel(true).setOnlyAlertOnce(true).build()
        if (runCatching { NotificationManagerCompat.from(context).notify(READY_ID, n) }.isSuccess) prefs?.edit { putLong(PREF_NOTIFIED, release.versionCode) }
    }

    private fun cancelReady(context: Context) = runCatching { NotificationManagerCompat.from(context).cancel(READY_ID) }

    /** On the first start of a build the updater installed: "Updated to X", quietly, and the same line in Settings → About. */
    fun announce(context: Context) {
        val p = context.getSharedPreferences("pocket", 0)
        p.getString(PREF_DONE, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
            ?.takeIf { it.optLong("code") == BuildConfig.VERSION_CODE.toLong() }?.let { _updated.value = it.optString("text") }
        val pending = p.getString(PREF_PENDING, null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return
        if (!UpdatePolicy.justUpdated(pending.optLong("code"), BuildConfig.VERSION_CODE.toLong())) return
        val line = UpdatePolicy.notesLine(pending.optString("notes"))
        val text = listOf("Updated to ${pending.optString("name")}", line).filter(String::isNotBlank).joinToString(" · ")
        p.edit { remove(PREF_PENDING); remove(PREF_CONFIRM); putString(PREF_DONE, JSONObject().put("code", BuildConfig.VERSION_CODE).put("text", text).toString()) }
        _updated.value = text
        runCatching { File(context.cacheDir, "updates").deleteRecursively() }
        cancelReady(context)
        if (!Notify.allowed(context)) return
        channel(context)
        // Android closed the app to replace it. WatchResumeReceiver brings watched machines back; one connected with a
        // typed password waits for the person.
        val reopen = pending.optBoolean("watching") && !WatchResume.wanted(context)
        val detail = listOf(line, if (reopen) "Open Automagik to reconnect your machines." else "")
            .filter(String::isNotBlank).joinToString("\n")
        val open = PendingIntent.getActivity(context, UPDATED_ID, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notify).setColor(BrandArgb)
            .setContentTitle("Updated to ${pending.optString("name")}").setContentText(detail.lineSequence().firstOrNull().orEmpty())
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail)).setContentIntent(open).setAutoCancel(true).setSilent(true).build()
        runCatching { NotificationManagerCompat.from(context).notify(UPDATED_ID, n) }
    }
}

/** Android's installer reports here: asks the person to confirm, or says how it went. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Updater.reported(intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1), intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE),
            intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE), IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java))
    }
}

/** Android starts the new build here right after replacing the app, so "Updated to X" doesn't wait for the next open. */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) Updater.init(context)
    }
}
