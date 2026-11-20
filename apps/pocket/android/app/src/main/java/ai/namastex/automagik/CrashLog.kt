package ai.namastex.automagik

import android.app.Application
import android.os.Build
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Keeps the last crash's stack trace on the phone, so the person can copy it from Settings → About. */
class PocketApplication : Application() {
    /** One for the whole process, so the watch service keeps the connections when the screen goes away. */
    val vm by lazy { PocketViewModel(this) }
    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
        AppUpdates.init(this)
        kotlin.concurrent.thread(name = "pocket-key-wrap", isDaemon = true) { PhoneKey.migrate(noBackupFilesDir, Seal.sealer()) }
    }
}

object CrashLog {
    private const val MAX = 64 shl 10
    @Volatile private var file: File? = null

    fun install(app: Application) {
        val target = File(app.filesDir, "last-crash.txt").also { file = it }
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { target.writeText(report(thread.name, error, System.currentTimeMillis()).take(MAX)) }
            previous?.uncaughtException(thread, error)
        }
    }

    /** The saved report, or null if the app hasn't crashed since it was last cleared. */
    fun read(): String? = file?.takeIf { it.isFile }?.let { runCatching { it.readText() }.getOrNull() }?.ifBlank { null }

    fun clear() { file?.delete() }

    /** True once per crash: the first launch after it, to say a report is waiting. */
    fun announce(): Boolean {
        val crash = file?.takeIf { it.isFile } ?: return false
        val mark = File(crash.parentFile, "last-crash.announced")
        val stamp = crash.lastModified().toString()
        if (runCatching { mark.readText() }.getOrNull() == stamp) return false
        runCatching { mark.writeText(stamp) }
        return true
    }

    fun report(thread: String, error: Throwable, at: Long): String = buildString {
        append("Automagik ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.VERSION_CODE).append(")\n")
        append("Android ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(") · ")
        append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n')
        append(SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.US).format(Date(at))).append(" · thread ").append(thread).append("\n\n")
        append(error.stackTraceToString())
    }
}
