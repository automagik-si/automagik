package ai.namastex.automagik

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface HostSealer {
    /** [create] permits generating the store key when no sealed record exists. */
    fun seal(plain: ByteArray, create: Boolean): ByteArray
    fun open(blob: ByteArray): ByteArray
}

/** Wraps the saved machine list with its own Android Keystore key. */
object HostSeal {
    const val ALIAS = "pocket-hosts"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val CIPHER = "AES/GCM/NoPadding"
    private const val VERSION: Byte = 1
    private const val IV_SIZE = 12
    private const val TAG_SIZE = 16
    private const val CIPHERTEXT_OFFSET = 2 + IV_SIZE
    internal const val OVERHEAD = CIPHERTEXT_OFFSET + TAG_SIZE

    internal fun frame(iv: ByteArray, ciphertext: ByteArray): ByteArray {
        require(iv.size == IV_SIZE && ciphertext.size >= TAG_SIZE)
        return byteArrayOf(VERSION, IV_SIZE.toByte()) + iv + ciphertext
    }

    internal fun unframe(blob: ByteArray): Pair<ByteArray, ByteArray> {
        require(blob.size >= OVERHEAD && blob[0] == VERSION && blob[1] == IV_SIZE.toByte())
        return blob.copyOfRange(2, CIPHERTEXT_OFFSET) to blob.copyOfRange(CIPHERTEXT_OFFSET, blob.size)
    }

    fun sealer(): HostSealer? = try {
        KeystoreSealer(KeyStore.getInstance(KEYSTORE).apply { load(null) })
    } catch (_: Exception) {
        null
    }

    private class KeystoreSealer(private val keyStore: KeyStore) : HostSealer {
        private fun key(): SecretKey? = keyStore.getKey(ALIAS, null)?.let { it as SecretKey }

        override fun seal(plain: ByteArray, create: Boolean): ByteArray {
            val key = key() ?: run {
                check(create) { "Host store key unavailable" }
                KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
                    init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setKeySize(256)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .build())
                    generateKey()
                }
            }
            val cipher = Cipher.getInstance(CIPHER)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            return frame(cipher.iv, cipher.doFinal(plain))
        }

        override fun open(blob: ByteArray): ByteArray {
            val (iv, ciphertext) = unframe(blob)
            val cipher = Cipher.getInstance(CIPHER)
            cipher.init(Cipher.DECRYPT_MODE, checkNotNull(key()) { "Host store key unavailable" }, GCMParameterSpec(TAG_SIZE * 8, iv))
            return cipher.doFinal(ciphertext)
        }
    }
}
