package ai.namastex.automagik

import android.app.Application
import android.content.SharedPreferences
import android.system.Os
import android.system.OsConstants
import java.io.DataInputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption

/** Owns the saved machine record and its migration from preferences. */
class HostStore(
    private val dir: File,
    private val prefs: SharedPreferences,
    private val sealer: () -> HostSealer?,
    private val syncDir: (File) -> Unit = ::syncDirectory,
    private val rename: (File, File) -> Unit = { a, b -> Os.rename(a.path, b.path) },
) {
    enum class Result { SAVED, FAILED, BLOCKED, TOO_LARGE }
    data class Loaded(val hosts: List<HostProfile>?, val blocked: Boolean, val migrate: Boolean)

    private val sealed = File(dir, "hosts.sealed")
    private val tmp = File(dir, "hosts.tmp")

    @Synchronized fun load(): Loaded {
        if (sealedExists()) {
            val hosts = readHosts() ?: return Loaded(null, blocked = true, migrate = false)
            return Loaded(hosts, blocked = false, migrate = prefs.contains(PREF))
        }
        val hosts = LegacySsh.loadHosts(prefs.getString(PREF, null))
        return Loaded(hosts, blocked = false, migrate = hosts != null && prefs.contains(PREF))
    }

    @Synchronized fun write(json: String): Result = write(json, fallback = true)

    @Synchronized fun migrate(): Result {
        if (sealedExists()) {
            if (readHosts() == null) return Result.BLOCKED
            return if (prefs.contains(PREF)) syncAndClean() else Result.SAVED
        }
        val raw = prefs.getString(PREF, null) ?: return Result.SAVED
        if (LegacySsh.loadHosts(raw) == null) return Result.SAVED
        if (raw.toByteArray(Charsets.UTF_8).size > MAX_PLAIN) return Result.TOO_LARGE
        val adapter = sealer() ?: return Result.SAVED
        return write(raw, fallback = false, migrationSealer = adapter)
    }

    /** Confirms the visible record is durable before startup retires the old SSH key. */
    @Synchronized internal fun confirmDurable(): Boolean = !sealedExists() ||
        (readHosts() != null && runCatching { syncDir(dir) }.isSuccess)

    private fun write(json: String, fallback: Boolean, migrationSealer: HostSealer? = null): Result {
        tmp.delete()
        val bytes = json.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_PLAIN) return Result.TOO_LARGE
        val exists = sealedExists()
        if (exists && readHosts() == null) return Result.BLOCKED
        val adapter = migrationSealer ?: sealer()
        if (adapter == null) return plainOrFailed(json, fallback && !exists)
        try {
            val blob = adapter.seal(bytes, create = !exists)
            check(Files.notExists(tmp.toPath(), LinkOption.NOFOLLOW_LINKS))
            FileOutputStream(tmp).use {
                it.write(blob)
                it.fd.sync()
            }
            check(adapter.open(readRecord(tmp)).contentEquals(bytes))
            rename(tmp, sealed)
        } catch (_: Exception) {
            tmp.delete()
            return plainOrFailed(json, fallback && !exists && !sealedExists())
        }
        if (prefs.contains(PREF) && readHosts(adapter) == null) return Result.FAILED
        return syncAndClean()
    }

    private fun sealedExists() = !Files.notExists(sealed.toPath(), LinkOption.NOFOLLOW_LINKS)

    private fun plainOrFailed(json: String, fallback: Boolean): Result =
        if (fallback && runCatching { prefs.edit().putString(PREF, json).commit() }.getOrDefault(false)) Result.SAVED else Result.FAILED

    private fun syncAndClean(): Result {
        if (runCatching { syncDir(dir) }.isFailure) return Result.FAILED
        // Failed commits can still remove the in-memory key. The next process can retry from disk.
        if (prefs.contains(PREF)) runCatching { prefs.edit().remove(PREF).commit() }
        return Result.SAVED
    }

    private fun readHosts(adapter: HostSealer? = null): List<HostProfile>? = runCatching {
        val bytes = checkNotNull(adapter ?: sealer()).open(readRecord(sealed))
        check(bytes.size <= MAX_PLAIN)
        val json = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        LegacySsh.loadHosts(json)
    }.getOrNull()

    private fun readRecord(file: File): ByteArray {
        check(file.isFile)
        val size = file.length()
        check(size in HostSeal.OVERHEAD.toLong()..(HostSeal.OVERHEAD + MAX_PLAIN).toLong())
        return DataInputStream(file.inputStream()).use { input ->
            ByteArray(size.toInt()).also {
                input.readFully(it)
                check(input.read() == -1)
            }
        }
    }

    companion object {
        const val PREF = "hosts"
        const val MAX_PLAIN = 1 shl 20
        fun of(app: Application) = HostStore(app.noBackupFilesDir, app.getSharedPreferences("pocket", 0), HostSeal::sealer)
    }
}

private fun syncDirectory(dir: File) {
    val fd = Os.open(dir.path, OsConstants.O_RDONLY, 0)
    try {
        Os.fsync(fd)
    } finally {
        Os.close(fd)
    }
}
