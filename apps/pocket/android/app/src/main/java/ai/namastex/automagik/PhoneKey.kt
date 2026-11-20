package ai.namastex.automagik

import android.system.Os
import android.system.OsConstants
import java.io.DataInputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.LinkOption

/** Keeps the phone's iroh identity in no-backup storage. */
object PhoneKey {
    const val SIZE = 32
    private const val MAX_SEALED_SIZE = 256
    private const val PLAIN_NAME = "iroh.key"
    internal const val UNREADABLE = "This phone’s Pocket Link key can’t be read right now. Try again; if it keeps failing, " +
        "clear Automagik’s storage in Android settings and pair this phone again."
    internal const val MISSING = "This phone has no Pocket Link key. Pair it again from Pocket Link."

    /** Reads the existing identity, creating one only when pairing allows it. */
    @Synchronized
    fun load(
        dir: File,
        sealer: Sealer?,
        create: Boolean,
        syncDir: (File) -> Unit = ::syncDirectory,
        generate: () -> ByteArray,
    ): ByteArray {
        val plainFile = File(dir, PLAIN_NAME)
        val sealedFile = File(dir, "iroh.key.sealed")
        val temp = File(dir, "iroh.key.tmp")
        temp.delete()

        fun publish(bytes: ByteArray, sealer: Sealer, onRename: () -> Unit = {}) {
            writeAtomic(sealedFile, temp, sealer.seal(bytes)) {
                check(readSealed(temp, sealer).contentEquals(bytes)) { "Staged key differs" }
            }
            onRename()
            syncDir(dir)
        }

        fun retire() {
            syncDir(dir)
            if (plainFile.delete()) syncDir(dir)
        }

        val plainExists = !absent(plainFile)
        val plain = if (plainExists) {
            try {
                readRecord(plainFile, SIZE..SIZE)
            } catch (_: Exception) {
                null
            }
        } else null
        val sealedExists = !absent(sealedFile)
        var sealedError: Exception? = null
        val opened = if (sealedExists && sealer != null) {
            try {
                readSealed(sealedFile, sealer)
            } catch (e: Exception) {
                sealedError = e
                null
            }
        } else null

        if (plain != null) {
            if (sealer != null && (!sealedExists || opened?.contentEquals(plain) == true)) {
                try {
                    if (!sealedExists) publish(plain, sealer)
                    retire()
                } catch (_: Exception) {
                    // Keep using the original bytes even if wrapping or cleanup failed.
                }
            }
            return plain
        }
        if (sealedExists) return opened ?: throw IllegalStateException(UNREADABLE, sealedError)
        if (plainExists) throw IllegalStateException(UNREADABLE)
        if (!create) throw IllegalStateException(MISSING)

        val bytes = generate()
        require(bytes.size == SIZE)
        if (sealer != null) {
            var renamed = false
            try {
                publish(bytes, sealer) { renamed = true }
                return bytes
            } catch (_: Exception) {
                // The sealed file is already visible if only the directory sync failed.
                if (renamed) return bytes
            }
        }
        check(absent(sealedFile)) { UNREADABLE }
        writeAtomic(plainFile, temp, bytes)
        syncDir(dir)
        return bytes
    }

    /** Wraps a plain key on startup when Keystore is available. */
    @Synchronized
    fun migrate(dir: File, sealer: Sealer?, syncDir: (File) -> Unit = ::syncDirectory) {
        if (sealer == null) return
        try {
            if (!absent(File(dir, PLAIN_NAME))) {
                load(dir, sealer, create = false, syncDir = syncDir) { error("never") }
            }
        } catch (_: Exception) {
            // A later load can retry the migration.
        }
    }

    private fun absent(file: File): Boolean = Files.notExists(file.toPath(), LinkOption.NOFOLLOW_LINKS)

    private fun readSealed(file: File, sealer: Sealer): ByteArray =
        sealer.open(readRecord(file, 0..MAX_SEALED_SIZE), SIZE).also {
            check(it.size == SIZE) { "Sealed key has the wrong size" }
        }

    private fun readRecord(file: File, sizes: IntRange): ByteArray {
        check(file.isFile) { "Key record is not a file" }
        val size = file.length()
        check(size >= sizes.first.toLong() && size <= sizes.last.toLong()) { "Key record has the wrong size" }
        return DataInputStream(file.inputStream()).use { input ->
            ByteArray(size.toInt()).also {
                input.readFully(it)
                check(input.read() == -1) { "Key record grew during read" }
            }
        }
    }

    private fun writeAtomic(target: File, temp: File, bytes: ByteArray, verify: () -> Unit = {}) {
        try {
            check(absent(temp)) { "Key staging file already exists" }
            FileOutputStream(temp).use {
                it.write(bytes)
                it.fd.sync()
            }
            verify()
            check(absent(target) && temp.renameTo(target)) { "Could not publish key record" }
        } catch (e: Exception) {
            temp.delete()
            throw e
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
}
