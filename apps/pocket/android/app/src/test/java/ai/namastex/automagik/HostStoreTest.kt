package ai.namastex.automagik

import android.app.Application
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

internal class TestHostSealer : HostSealer {
    private val key = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
    val creates = mutableListOf<Boolean>()
    var failSeal = false
    var failOpen = false
    var missingKey = false
    var mismatch = false
    private var staged: ByteArray? = null

    override fun seal(plain: ByteArray, create: Boolean): ByteArray {
        creates += create
        if (failSeal || missingKey) throw IOException("Cannot seal")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return HostSeal.frame(cipher.iv, cipher.doFinal(plain)).also { staged = it.takeIf { mismatch } }
    }

    override fun open(blob: ByteArray): ByteArray {
        if (failOpen || missingKey) throw IOException("Cannot open")
        val (iv, ciphertext) = HostSeal.unframe(blob)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
        val bytes = cipher.doFinal(ciphertext)
        return if (mismatch && staged?.contentEquals(blob) == true) bytes + 0.toByte() else bytes
    }
}

internal fun replaceHostRecord(from: File, to: File) {
    Files.move(from.toPath(), to.toPath(), REPLACE_EXISTING, ATOMIC_MOVE)
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class HostStoreTest {
    @get:Rule val folder = TemporaryFolder()
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val prefs = app.getSharedPreferences("host-store-test", 0)
    private val dir get() = folder.root
    private val sealed get() = File(dir, "hosts.sealed")
    private val tmp get() = File(dir, "hosts.tmp")
    private val fake = TestHostSealer()
    private var available = true
    private var failRename = false
    private var failSync = false
    private val host = HostProfile("saved", "Computer", "desktop", "", 0, transport = "iroh", ticket = "ticket")
    private val raw = JSONArray(listOf(host.json())).toString()
    private val other = host.copy(name = "Other")
    private val next = JSONArray(listOf(other.json())).toString()

    @Before fun clearPreferences() { prefs.edit().clear().commit() }

    private fun store(prefs: SharedPreferences = this.prefs) = HostStore(dir, prefs, { fake.takeIf { available } },
        syncDir = { if (failSync) throw IOException("Cannot sync directory") },
        rename = { from, to -> if (failRename) throw IOException("Cannot rename") else replaceHostRecord(from, to) })

    private fun plain(json: String = raw) { assertTrue(prefs.edit().putString(HostStore.PREF, json).commit()) }

    @Test fun emptyAndLegacyLoads() {
        assertEquals(HostStore.Loaded(emptyList(), blocked = false, migrate = false), store().load())
        plain()
        assertEquals(HostStore.Loaded(listOf(host), blocked = false, migrate = true), store().load())
        plain("corrupt")
        assertEquals(HostStore.Loaded(null, blocked = false, migrate = false), store().load())
    }

    @Test fun migrationKeepsExactUtf8IncludingUnknownFieldsAndNonObjects() {
        val mixed = " [ ${host.json().put("future", "ação")}, 42 ] "
        plain(mixed)
        assertEquals(HostStore.Result.SAVED, store().migrate())
        assertArrayEquals(mixed.toByteArray(Charsets.UTF_8), fake.open(sealed.readBytes()))
        assertFalse(prefs.contains(HostStore.PREF))
        assertEquals(HostStore.Loaded(listOf(host), blocked = false, migrate = false), store().load())
    }

    @Test fun stalePlainIsIgnoredAndRemoved() {
        plain(next)
        assertEquals(HostStore.Result.SAVED, store().write(raw))
        assertFalse(prefs.contains(HostStore.PREF))
        plain(next)
        assertEquals(HostStore.Loaded(listOf(host), blocked = false, migrate = true), store().load())
        assertEquals(HostStore.Result.SAVED, store().migrate())
        assertFalse(prefs.contains(HostStore.PREF))
        assertEquals(listOf(true), fake.creates)
    }

    @Test fun unusableSealedRecordsBlockLoadWriteAndCleanup() {
        assertEquals(HostStore.Result.SAVED, store().write(raw))
        val good = sealed.readBytes()
        plain(next)
        fun assertBlocked() {
            val bytes = sealed.readBytes()
            val store = store()
            assertEquals(HostStore.Loaded(null, blocked = true, migrate = false), store.load())
            assertEquals(HostStore.Result.BLOCKED, store.write("[]"))
            assertEquals(HostStore.Result.BLOCKED, store.migrate())
            assertArrayEquals(bytes, sealed.readBytes())
            assertEquals(next, prefs.getString(HostStore.PREF, null))
        }
        fake.failOpen = true
        assertBlocked()
        fake.failOpen = false
        fake.missingKey = true
        assertBlocked()
        fake.missingKey = false
        available = false
        assertBlocked()
        available = true
        sealed.writeBytes(good.copyOf(2))
        assertBlocked()
        sealed.writeBytes(fake.seal(byteArrayOf(0xc3.toByte(), 0x28), create = false))
        assertBlocked()
        sealed.writeBytes(fake.seal("{}".toByteArray(), create = false))
        assertBlocked()
    }

    @Test fun absentKeystoreFallsBackToPlainButMigrationLeavesItAlone() {
        available = false
        assertEquals(HostStore.Result.SAVED, store().write(raw))
        assertEquals(raw, prefs.getString(HostStore.PREF, null))
        assertFalse(sealed.exists())
        assertEquals(HostStore.Result.SAVED, store().migrate())
        assertEquals(raw, prefs.getString(HostStore.PREF, null))
    }

    @Test fun failedSealOnlyFallsBackBeforeFirstPublication() {
        fake.failSeal = true
        assertEquals(HostStore.Result.SAVED, store().write(raw))
        assertEquals(HostStore.Result.FAILED, store().migrate())
        assertEquals(raw, prefs.getString(HostStore.PREF, null))
        assertFalse(sealed.exists())
        fake.failSeal = false
        assertEquals(HostStore.Result.SAVED, store().migrate())
        val old = sealed.readBytes()
        fake.failSeal = true
        assertEquals(HostStore.Result.FAILED, store().write(next))
        assertArrayEquals(old, sealed.readBytes())
        assertFalse(prefs.contains(HostStore.PREF))
    }

    @Test fun stagedReadBackMismatchAndRenameFailureLeaveOldRecord() {
        assertEquals(HostStore.Result.SAVED, store().write(raw))
        val old = sealed.readBytes()
        fake.mismatch = true
        assertEquals(HostStore.Result.FAILED, store().write(next))
        assertArrayEquals(old, sealed.readBytes())
        assertFalse(tmp.exists())
        fake.mismatch = false
        failRename = true
        assertEquals(HostStore.Result.FAILED, store().write(next))
        assertArrayEquals(old, sealed.readBytes())
        assertEquals(listOf(host), store().load().hosts)
        assertFalse(tmp.exists())
    }

    @Test fun failedDirectorySyncKeepsPlainEvenAcrossAnotherFailedCleanup() {
        plain()
        failSync = true
        assertEquals(HostStore.Result.FAILED, store().write(next))
        val reopened = store()
        assertEquals(HostStore.Loaded(listOf(other), blocked = false, migrate = true), reopened.load())
        assertEquals(HostStore.Result.FAILED, reopened.migrate())
        assertFalse(reopened.confirmDurable())
        assertEquals(raw, prefs.getString(HostStore.PREF, null))
        failSync = false
        assertEquals(HostStore.Result.SAVED, reopened.write(next))
        assertTrue(reopened.confirmDurable())
        assertFalse(prefs.contains(HostStore.PREF))
    }

    @Test fun failedPrefRemovalIsToleratedAndRetriedFromDiskAtNextStart() {
        plain()
        var hidden = false
        val failedCleanup = object : SharedPreferences by prefs {
            override fun contains(key: String) = !hidden && prefs.contains(key)
            override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor by prefs.edit() {
                override fun remove(key: String): SharedPreferences.Editor = this
                override fun commit(): Boolean { hidden = true; return false }
            }
        }
        assertEquals(HostStore.Result.SAVED, store(failedCleanup).write(next))
        assertFalse(failedCleanup.contains(HostStore.PREF))
        assertTrue(prefs.contains(HostStore.PREF))
        val reopened = store()
        assertEquals(HostStore.Loaded(listOf(other), blocked = false, migrate = true), reopened.load())
        assertEquals(HostStore.Result.SAVED, reopened.migrate())
        assertFalse(prefs.contains(HostStore.PREF))
        assertEquals(listOf(true), fake.creates)
    }

    @Test fun replacementAndLastRemovalKeepUsingTheSameKey() {
        val store = store()
        assertEquals(HostStore.Result.SAVED, store.write(raw))
        assertEquals(HostStore.Result.SAVED, store.write(next))
        assertEquals(listOf(other), store().load().hosts)
        assertEquals(HostStore.Result.SAVED, store.write("[]"))
        assertArrayEquals("[]".toByteArray(), fake.open(sealed.readBytes()))
        assertEquals(emptyList<HostProfile>(), store().load().hosts)
        assertEquals(listOf(true, false, false), fake.creates)
    }

    @Test fun oversizedUtf8LeavesAuthoritativeCopiesInPlace() {
        val oversized = JSONArray(listOf(host.copy(name = "é".repeat(HostStore.MAX_PLAIN / 2)).json())).toString()
        plain(oversized)
        assertEquals(HostStore.Result.TOO_LARGE, store().migrate())
        assertFalse(sealed.exists())
        assertTrue(fake.creates.isEmpty())
        assertEquals(oversized, prefs.getString(HostStore.PREF, null))
        assertEquals(HostStore.Result.SAVED, store().write(raw))
        val old = sealed.readBytes()
        plain(raw)
        tmp.writeText("abandoned")
        assertEquals(HostStore.Result.TOO_LARGE, store().write(oversized))
        assertArrayEquals(old, sealed.readBytes())
        assertEquals(raw, prefs.getString(HostStore.PREF, null))
        assertFalse(tmp.exists())
    }
}
