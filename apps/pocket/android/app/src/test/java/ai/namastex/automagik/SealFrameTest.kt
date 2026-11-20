package ai.namastex.automagik

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SealFrameTest {
    private val alias = "pocket-key-0123456789abcdef"
    private val iv = ByteArray(12) { it.toByte() }
    private val ciphertext = ByteArray(PhoneKey.SIZE + 16) { (12 + it).toByte() }
    private val blob = Seal.frame(alias, iv, ciphertext)

    @Test fun roundTripsTheV1Frame() {
        assertArrayEquals(byteArrayOf(1, 27) + alias.toByteArray(Charsets.US_ASCII) + byteArrayOf(12) + iv + ciphertext, blob)
        val framed = Seal.unframe(blob, PhoneKey.SIZE)
        assertEquals(alias, framed.alias)
        assertArrayEquals(iv, framed.iv)
        assertArrayEquals(ciphertext, framed.ciphertext)
    }

    @Test fun rejectsUnknownVersionAndShortHeader() {
        rejects(blob.copyOf().also { it[0] = 2 })
        rejects(byteArrayOf(1))
    }

    @Test fun rejectsTruncatedCiphertextAndTrailingBytes() {
        rejects(blob.copyOf(blob.size - 1))
        rejects(blob + byteArrayOf(0))
        assertThrows(IllegalArgumentException::class.java) { Seal.unframe(blob, PhoneKey.SIZE + 1) }
    }

    @Test fun rejectsInvalidAliases() {
        for (length in listOf(0, 26, 28, 65)) {
            rejects(blob.copyOf().also { it[1] = length.toByte() })
        }
        for (invalid in listOf("pocket-key-0123456789ABCDEF", "pocket-new-0123456789abcdef", "pocket-key-0123456789abcde/")) {
            val malformed = byteArrayOf(1, 27) + invalid.toByteArray(Charsets.US_ASCII) + byteArrayOf(12) + iv + ciphertext
            rejects(malformed)
        }
    }

    @Test fun rejectsWrongIvLengths() {
        rejects(blob.copyOf().also { it[29] = 11 })
        rejects(blob.copyOf().also { it[29] = 13 })
    }

    private fun rejects(bytes: ByteArray) {
        assertThrows(IllegalArgumentException::class.java) { Seal.unframe(bytes, PhoneKey.SIZE) }
    }
}
