package ai.namastex.automagik

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.security.KeyStoreException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit.SECONDS
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class PhoneKeyTest {
    @get:Rule val folder = TemporaryFolder()
    private val dir get() = folder.root
    private val plain get() = File(dir, "iroh.key")
    private val sealed get() = File(dir, "iroh.key.sealed")
    private val temp get() = File(dir, "iroh.key.tmp")
    private val key = ByteArray(PhoneKey.SIZE) { it.toByte() }
    private val otherKey = ByteArray(PhoneKey.SIZE) { (it + 1).toByte() }
    private val sealer = FakeSealer()
    private val noSync: (File) -> Unit = {}

    @Test fun wrapsTheOriginalBytesAndReusesTheSealedRecord() {
        plain.writeBytes(key)
        val plainAtSync = mutableListOf<Boolean>()
        assertArrayEquals(key, load(syncDir = {
            assertEquals(dir, it)
            assertTrue(sealed.exists())
            plainAtSync += plain.exists()
        }))
        assertEquals(listOf(true, true, false), plainAtSync)
        assertArrayEquals(key, sealer.open(sealed.readBytes(), PhoneKey.SIZE))
        assertFalse(plain.exists())
        assertFalse(temp.exists())

        val before = sealed.readBytes()
        assertArrayEquals(key, load())
        assertArrayEquals(before, sealed.readBytes())
        assertEquals(1, sealer.sealCount)
    }

    @Test fun matchingRecordsRetirePlainWithoutResealing() {
        plain.writeBytes(key)
        val before = writeSealed()
        assertArrayEquals(key, load())
        assertFalse(plain.exists())
        assertArrayEquals(before, sealed.readBytes())
        assertEquals(1, sealer.sealCount)
    }

    @Test fun disagreeingRecordsKeepBothAndUsePlain() {
        plain.writeBytes(key)
        val before = writeSealed(otherKey)
        assertArrayEquals(key, load(create = true))
        assertArrayEquals(key, plain.readBytes())
        assertArrayEquals(before, sealed.readBytes())
    }

    @Test fun unreadableSealedRecordKeepsBothAndUsesPlain() {
        plain.writeBytes(key)
        val before = writeSealed()
        sealer.openError = KeyStoreException("Transient error")
        assertArrayEquals(key, load(create = true))
        assertArrayEquals(key, plain.readBytes())
        assertArrayEquals(before, sealed.readBytes())
    }

    @Test fun wrongSizePlainIsPreservedWhenSealedOpens() {
        val wrongSize = key.copyOf(PhoneKey.SIZE + 1)
        plain.writeBytes(wrongSize)
        val before = writeSealed()
        assertArrayEquals(key, load())
        assertArrayEquals(wrongSize, plain.readBytes())
        assertArrayEquals(before, sealed.readBytes())
    }

    @Test fun wrongSizePlainAlonePreventsGeneration() {
        val wrongSize = key.copyOf(PhoneKey.SIZE - 1)
        plain.writeBytes(wrongSize)
        assertUnreadable { load(create = true) }
        assertArrayEquals(wrongSize, plain.readBytes())
        assertFalse(sealed.exists())
    }

    @Test fun sealingFailureKeepsPlain() {
        plain.writeBytes(key)
        sealer.failSeal = true
        assertArrayEquals(key, load())
        assertArrayEquals(key, plain.readBytes())
        assertFalse(sealed.exists())
        assertFalse(temp.exists())
    }

    @Test fun unavailableKeystoreKeepsPlain() {
        plain.writeBytes(key)
        assertArrayEquals(key, load(sealer = null))
        assertArrayEquals(key, plain.readBytes())
        assertFalse(sealed.exists())
    }

    @Test fun unavailableKeystoreCannotReplaceASealedRecord() {
        val before = writeSealed()
        assertUnreadable { load(sealer = null, create = true) }
        assertArrayEquals(before, sealed.readBytes())
        assertFalse(plain.exists())
    }

    @Test fun transientOpenFailureLeavesTheOriginalForRetry() {
        val before = writeSealed()
        val failure = KeyStoreException("Transient error")
        sealer.openError = failure
        assertSame(failure, assertUnreadable { load(create = true) }.cause)
        assertFalse(plain.exists())
        sealer.openError = null
        assertArrayEquals(key, load())
        assertArrayEquals(before, sealed.readBytes())
    }

    @Test fun missingAliasAndDamagedTagLeaveTheRecordsInPlace() {
        val before = writeSealed()
        assertUnreadable { load(sealer = FakeSealer(), create = true) }
        assertArrayEquals(before, sealed.readBytes())

        val damaged = before.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        sealed.writeBytes(damaged)
        assertUnreadable { load(create = true) }
        assertArrayEquals(damaged, sealed.readBytes())
        assertFalse(plain.exists())
    }

    @Test fun unknownVersionAndOversizedSealedRecordsPreventGeneration() {
        val unknownVersion = writeSealed().also { it[0] = 2 }
        sealed.writeBytes(unknownVersion)
        assertUnreadable { load(create = true) }
        assertArrayEquals(unknownVersion, sealed.readBytes())
        assertEquals(1, sealer.openCount)

        val oversized = ByteArray(257)
        sealed.writeBytes(oversized)
        assertUnreadable { load(create = true) }
        assertArrayEquals(oversized, sealed.readBytes())
        assertEquals(1, sealer.openCount)
        assertFalse(plain.exists())
    }

    @Test fun reconnectWithNoRecordsReportsMissingAndWritesNothing() {
        val error = assertThrows(IllegalStateException::class.java) { load() }
        assertEquals(PhoneKey.MISSING, error.message)
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test fun pairingWithNoRecordsWritesOnlySealed() {
        assertArrayEquals(key, load(create = true) { key })
        assertArrayEquals(key, sealer.open(sealed.readBytes(), PhoneKey.SIZE))
        assertFalse(plain.exists())
        assertFalse(temp.exists())
    }

    @Test fun rejectingGeneratedKeysOfTheWrongSizeWritesNothing() {
        assertThrows(IllegalArgumentException::class.java) { load(create = true) { key.copyOf(31) } }
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test fun pairingFallsBackToPlainOnSealFailureAndStartupRetries() {
        sealer.failSeal = true
        assertArrayEquals(key, load(create = true) { key })
        assertArrayEquals(key, plain.readBytes())
        assertFalse(sealed.exists())
        assertFalse(temp.exists())

        sealer.failSeal = false
        PhoneKey.migrate(dir, sealer, noSync)
        assertArrayEquals(key, load())
        assertFalse(plain.exists())
    }

    @Test fun pairingWithoutKeystoreWritesPlain() {
        assertArrayEquals(key, load(sealer = null, create = true) { key })
        assertArrayEquals(key, plain.readBytes())
        assertFalse(sealed.exists())
        assertFalse(temp.exists())
    }

    @Test fun leftoverTempIsRemovedOnLoad() {
        plain.writeBytes(key)
        temp.writeBytes(otherKey)
        assertArrayEquals(key, load(sealer = null))
        assertFalse(temp.exists())
    }

    @Test fun startupWithNoPlainDoesNotCreateOrChangeRecords() {
        PhoneKey.migrate(dir, sealer, noSync)
        assertTrue(dir.listFiles().orEmpty().isEmpty())
        val before = writeSealed()
        PhoneKey.migrate(dir, sealer, noSync)
        assertArrayEquals(before, sealed.readBytes())
        assertFalse(plain.exists())
        assertEquals(0, sealer.openCount)
    }

    @Test fun failedStageReadBackPreservesPlainAndRemovesTemp() {
        plain.writeBytes(key)
        sealer.openError = IOException("Cannot open staged key")
        assertArrayEquals(key, load())
        assertArrayEquals(key, plain.readBytes())
        assertEquals(1, sealer.openCount)
        assertFalse(sealed.exists())
        assertFalse(temp.exists())
    }

    @Test fun stageOpeningToDifferentBytesPreventsPublication() {
        plain.writeBytes(key)
        val wrongReadBack = object : Sealer by sealer {
            override fun open(blob: ByteArray, plainSize: Int): ByteArray {
                sealer.open(blob, plainSize)
                return otherKey
            }
        }
        assertArrayEquals(key, load(sealer = wrongReadBack))
        assertArrayEquals(key, plain.readBytes())
        assertFalse(sealed.exists())
        assertFalse(temp.exists())
    }

    @Test fun pairingFallsBackWhenTheVerifiedStageCannotBeRenamed() {
        sealer.afterOpen = { assertTrue(temp.delete()) }
        assertArrayEquals(key, load(create = true) { key })
        assertArrayEquals(key, plain.readBytes())
        assertFalse(sealed.exists())
        assertFalse(temp.exists())
    }

    @Test fun sealedRecordAppearingBeforeRenamePreventsPublishAndFallback() {
        val before = sealer.seal(otherKey)
        sealer.afterOpen = { sealed.writeBytes(before) }
        assertUnreadable { load(create = true) { key } }
        assertArrayEquals(before, sealed.readBytes())
        assertFalse(plain.exists())
        assertFalse(temp.exists())
    }

    @Test fun pairingKeepsOnlySealedIfSyncFailsAfterRename() {
        assertArrayEquals(key, load(create = true, syncDir = { throw IOException("Directory sync failed") }) { key })
        assertArrayEquals(key, sealer.open(sealed.readBytes(), PhoneKey.SIZE))
        assertFalse(plain.exists())
        assertFalse(temp.exists())
    }

    @Test fun migrationKeepsPlainIfSyncFailsAfterRename() {
        plain.writeBytes(key)
        var syncs = 0
        PhoneKey.migrate(dir, sealer) {
            syncs++
            throw IOException("Directory sync failed")
        }
        assertEquals(1, syncs)
        assertArrayEquals(key, plain.readBytes())
        assertArrayEquals(key, sealer.open(sealed.readBytes(), PhoneKey.SIZE))
        assertFalse(temp.exists())
    }

    @Test fun retirementKeepsPlainIfTheSealedEntryCannotBeSynced() {
        plain.writeBytes(key)
        val before = writeSealed()
        assertArrayEquals(key, load(syncDir = { throw IOException("Directory sync failed") }))
        assertArrayEquals(key, plain.readBytes())
        assertArrayEquals(before, sealed.readBytes())
    }

    @Test fun finalSyncFailureAfterPlainDeletionStillReturnsTheKey() {
        plain.writeBytes(key)
        val before = writeSealed()
        assertArrayEquals(key, load(syncDir = { if (!plain.exists()) throw IOException("Directory sync failed") }))
        assertFalse(plain.exists())
        assertArrayEquals(before, sealed.readBytes())
    }

    @Test fun concurrentMigrationAndLoadPublishOnce() {
        plain.writeBytes(key)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val migration = pool.submit<Unit> {
                check(start.await(5, SECONDS))
                PhoneKey.migrate(dir, sealer, noSync)
            }
            val read = pool.submit<ByteArray> {
                check(start.await(5, SECONDS))
                load()
            }
            start.countDown()
            migration.get(5, SECONDS)
            assertArrayEquals(key, read.get(5, SECONDS))
            assertArrayEquals(key, sealer.open(sealed.readBytes(), PhoneKey.SIZE))
            assertEquals(1, sealer.sealCount)
            assertEquals(listOf("iroh.key.sealed"), dir.list()?.toList())
        } finally {
            pool.shutdownNow()
        }
    }

    private fun load(
        sealer: Sealer? = this.sealer,
        create: Boolean = false,
        syncDir: (File) -> Unit = noSync,
        generate: () -> ByteArray = { error("Unexpected key generation") },
    ) = PhoneKey.load(dir, sealer, create, syncDir, generate)

    private fun writeSealed(bytes: ByteArray = key): ByteArray = sealer.seal(bytes).also { sealed.writeBytes(it) }

    private fun assertUnreadable(read: () -> ByteArray): IllegalStateException =
        assertThrows(IllegalStateException::class.java) { read() }.also { assertEquals(PhoneKey.UNREADABLE, it.message) }

    private class FakeSealer : Sealer {
        private val keys = mutableMapOf<String, SecretKey>()
        var failSeal = false
        var openError: Exception? = null
        var afterOpen: () -> Unit = {}
        var sealCount = 0
            private set
        var openCount = 0
            private set

        override fun seal(plain: ByteArray): ByteArray {
            if (failSeal) throw KeyStoreException("Cannot generate wrapping key")
            val alias = "pocket-key-" + "%016x".format(++sealCount)
            val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            keys[alias] = key
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            return Seal.frame(alias, cipher.iv, cipher.doFinal(plain))
        }

        override fun open(blob: ByteArray, plainSize: Int): ByteArray {
            openCount++
            openError?.let { throw it }
            val (alias, iv, ciphertext) = Seal.unframe(blob, plainSize)
            val key = checkNotNull(keys[alias])
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            return cipher.doFinal(ciphertext).also { afterOpen() }
        }
    }
}
