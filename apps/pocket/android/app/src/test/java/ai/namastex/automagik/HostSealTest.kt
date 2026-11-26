package ai.namastex.automagik

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class HostSealTest {
    private val iv = ByteArray(12) { it.toByte() }
    private val ciphertext = ByteArray(21) { (it + 12).toByte() }

    @Test fun frameRoundTrip() {
        val blob = HostSeal.frame(iv, ciphertext)
        assertEquals(30 + 5, blob.size)
        assertArrayEquals(byteArrayOf(1, 12), blob.copyOfRange(0, 2))
        val (openedIv, openedCiphertext) = HostSeal.unframe(blob)
        assertArrayEquals(iv, openedIv)
        assertArrayEquals(ciphertext, openedCiphertext)
    }

    @Test fun rejectsBadVersionLengthAndShortFrame() {
        val blob = HostSeal.frame(iv, ciphertext)
        val malformed = listOf(blob.clone().apply { this[0] = 2 }, blob.clone().apply { this[1] = 11 }, blob.copyOf(29))
        malformed.forEach { assertThrows(IllegalArgumentException::class.java) { HostSeal.unframe(it) } }
    }
}
