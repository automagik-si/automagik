package ai.namastex.automagik

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface Sealer {
    fun seal(plain: ByteArray): ByteArray
    fun open(blob: ByteArray, plainSize: Int): ByteArray
}

/** Wraps a record with a fresh Android Keystore key. */
object Seal {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val CIPHER = "AES/GCM/NoPadding"
    private const val VERSION: Byte = 1
    private const val ALIAS_PREFIX = "pocket-key-"
    private const val ALIAS_SIZE = 27
    private const val IV_SIZE = 12
    private const val TAG_SIZE = 16
    private const val IV_LENGTH_OFFSET = 2 + ALIAS_SIZE
    private const val IV_OFFSET = IV_LENGTH_OFFSET + 1
    private const val CIPHERTEXT_OFFSET = IV_OFFSET + IV_SIZE
    private val aliasPattern = Regex("${ALIAS_PREFIX}[0-9a-f]{16}")

    /** Opens Android Keystore, or returns null when it is unavailable. */
    fun sealer(): Sealer? = try {
        KeystoreSealer(KeyStore.getInstance(KEYSTORE).apply { load(null) })
    } catch (_: Exception) {
        null
    }

    internal data class Framed(val alias: String, val iv: ByteArray, val ciphertext: ByteArray)

    internal fun frame(alias: String, iv: ByteArray, ciphertext: ByteArray): ByteArray {
        require(aliasPattern.matches(alias))
        require(iv.size == IV_SIZE)
        require(ciphertext.size >= TAG_SIZE)
        return byteArrayOf(VERSION, ALIAS_SIZE.toByte()) + alias.toByteArray(Charsets.US_ASCII) +
            byteArrayOf(IV_SIZE.toByte()) + iv + ciphertext
    }

    /** Validates the whole frame before the caller looks up its key. */
    internal fun unframe(blob: ByteArray, plainSize: Int): Framed {
        require(plainSize >= 0 && blob.size.toLong() == CIPHERTEXT_OFFSET + TAG_SIZE + plainSize.toLong())
        require(blob[0] == VERSION && blob[1] == ALIAS_SIZE.toByte())
        val alias = String(blob, 2, ALIAS_SIZE, Charsets.US_ASCII)
        require(aliasPattern.matches(alias))
        require(blob[IV_LENGTH_OFFSET] == IV_SIZE.toByte())
        return Framed(alias, blob.copyOfRange(IV_OFFSET, CIPHERTEXT_OFFSET),
            blob.copyOfRange(CIPHERTEXT_OFFSET, blob.size))
    }

    private class KeystoreSealer(private val keyStore: KeyStore) : Sealer {
        override fun seal(plain: ByteArray): ByteArray {
            val random = ByteArray(8).also { SecureRandom().nextBytes(it) }
            val alias = ALIAS_PREFIX + random.joinToString("") { "%02x".format(it) }
            check(!keyStore.containsAlias(alias)) { "Keystore alias already exists" }
            val key = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build())
                generateKey()
            }
            val cipher = Cipher.getInstance(CIPHER)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            return frame(alias, cipher.iv, cipher.doFinal(plain))
        }

        override fun open(blob: ByteArray, plainSize: Int): ByteArray {
            val (alias, iv, ciphertext) = unframe(blob, plainSize)
            val key = keyStore.getKey(alias, null) as? SecretKey
                ?: throw IllegalStateException("Keystore key unavailable")
            val cipher = Cipher.getInstance(CIPHER)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_SIZE * 8, iv))
            return cipher.doFinal(ciphertext)
        }
    }
}
