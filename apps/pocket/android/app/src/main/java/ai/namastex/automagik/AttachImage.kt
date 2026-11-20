package ai.namastex.automagik

import android.annotation.SuppressLint
import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import androidx.annotation.RequiresApi
import org.json.JSONObject
import java.io.FileNotFoundException
import java.io.IOException
import java.io.OutputStream
import java.util.Base64
import java.util.UUID

internal data class Prepared(
    val key: String, val uri: String, val mediaType: String, val bytes: ByteArray, val width: Int, val height: Int,
    val preview: Bitmap? = null
) {
    val heldBytes get() = bytes.size.toLong() + (preview?.byteCount ?: 0)
    fun fits(offer: Attach.Offer) = Attach.fits(offer, mediaType, bytes.size, width, height)
}

internal class AttachImage(
    private val resolver: ContentResolver,
    private val forceLegacy: Boolean = false,
    private val compress: (Bitmap, Bitmap.CompressFormat, Int, OutputStream) -> Boolean = Bitmap::compress
) {
    class Refusal(val words: String) : IOException(words)

    fun prepare(uri: Uri, offer: Attach.Offer): Prepared = try {
        try {
            encode(uri, offer, Attach.PEAK_PIXELS)
        } catch (_: OutOfMemoryError) {
            encode(uri, offer, Attach.PEAK_PIXELS / 4)
        }
    } catch (e: Refusal) {
        throw e
    } catch (_: FileNotFoundException) {
        throw Refusal("Pick the images again.")
    } catch (_: SecurityException) {
        throw Refusal("Pick the images again.")
    } catch (_: IOException) {
        throw Refusal(PREPARE_FAILED)
    } catch (_: IllegalArgumentException) {
        throw Refusal(PREPARE_FAILED)
    } catch (_: OutOfMemoryError) {
        throw Refusal(PREPARE_FAILED)
    }

    private fun encode(uri: Uri, offer: Attach.Offer, peak: Long): Prepared {
        var bitmap = if (!forceLegacy && Build.VERSION.SDK_INT >= 28) modern(uri, offer, peak)
            else legacy(uri, offer, peak)
        try {
            val encoding = Attach.encoding(offer.mediaTypes, bitmap.hasAlpha(), Build.VERSION.SDK_INT)
            if (encoding.mediaType == Attach.JPEG && bitmap.hasAlpha()) {
                val source = bitmap
                bitmap = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
                try {
                    Canvas(bitmap).apply { drawColor(Color.WHITE); drawBitmap(source, 0f, 0f, null) }
                } finally {
                    source.recycle()
                }
            }
            // Ultra HDR JPEG can carry a gain map and its XMP. Encode only the new still's pixels.
            if (Build.VERSION.SDK_INT >= 34) bitmap.setGainmap(null)

            val format = format(encoding.kind)
            var quality = encoding.quality
            var shrinks = 0
            while (true) {
                val capped = CappedOutput(offer.fileBytes)
                val ok = try { compress(bitmap, format, quality, capped) } catch (_: IOException) { false }
                if (!capped.overflowed) {
                    if (!ok || capped.size == 0) throw Refusal(PREPARE_FAILED)
                    val bytes = capped.bytes()
                    return Prepared(UUID.randomUUID().toString(), uri.toString(), encoding.mediaType,
                        bytes, bitmap.width, bitmap.height, preview(bytes, bitmap.width, bitmap.height))
                }
                if (encoding.lossy && quality > 80) {
                    quality = 80
                } else {
                    if (shrinks == 3 || (bitmap.width == 1 && bitmap.height == 1))
                        throw Refusal("Too large to send even after shrinking.")
                    bitmap = scaled(bitmap, maxOf(1, bitmap.width * 3 / 4), maxOf(1, bitmap.height * 3 / 4))
                    shrinks++
                }
            }
        } finally {
            bitmap.recycle()
        }
    }

    @RequiresApi(28)
    private fun modern(uri: Uri, offer: Attach.Offer, peak: Long): Bitmap {
        val src = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
            decoder.setTargetSampleSize(plan(info.size.width, info.size.height, offer, peak).sample)
        }
        return transform(src) {
            val out = plan(src.width, src.height, offer, peak)
            Bitmap.createScaledBitmap(src, out.width, out.height, true)
        }
    }

    private fun legacy(uri: Uri, offer: Attach.Offer, peak: Long): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        stream(uri) { BitmapFactory.decodeStream(it, null, bounds) }
        if (isHeic(bounds.outMimeType) || isHeic(resolver.getType(uri)))
            throw Refusal("This phone can't read this picture. Pick a JPEG or PNG.")
        val sample = plan(bounds.outWidth, bounds.outHeight, offer, peak).sample
        // The API 26–27 fallback reads JPEG orientation. PNG and WebP use their pixel order.
        val orientation = if (bounds.outMimeType == Attach.JPEG) jpegOrientation(uri) else ExifInterface.ORIENTATION_NORMAL
        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
        }
        val src = stream(uri) { BitmapFactory.decodeStream(it, null, options) } ?: throw Refusal(PREPARE_FAILED)
        return transform(src) {
            val out = plan(src.width, src.height, offer, peak)
            val matrix = Matrix().apply {
                setScale(out.width.toFloat() / src.width, out.height.toFloat() / src.height)
                when (orientation) {
                    2 -> postScale(-1f, 1f)
                    3 -> postRotate(180f)
                    4 -> postScale(1f, -1f)
                    5 -> { postRotate(90f); postScale(-1f, 1f) }
                    6 -> postRotate(90f)
                    7 -> { postRotate(270f); postScale(-1f, 1f) }
                    8 -> postRotate(270f)
                }
            }
            Bitmap.createBitmap(src, 0, 0, src.width, src.height, matrix, true)
        }
    }

    // JPEG orientation only, API 26-27; androidx.exifinterface is not a dependency.
    @SuppressLint("ExifInterface")
    private fun jpegOrientation(uri: Uri) = stream(uri) {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    }

    private fun <T> stream(uri: Uri, read: (java.io.InputStream) -> T): T =
        (resolver.openInputStream(uri) ?: throw FileNotFoundException()).use(read)

    private fun plan(w: Int, h: Int, offer: Attach.Offer, peak: Long) =
        Attach.plan(w, h, offer.maxDimension, offer.maxPixels, peak) ?: throw Refusal(PREPARE_FAILED)

    private inline fun transform(src: Bitmap, make: () -> Bitmap): Bitmap {
        var dst: Bitmap? = null
        try {
            return make().also { dst = it }
        } finally {
            if (dst !== src) src.recycle()
        }
    }

    private fun scaled(src: Bitmap, w: Int, h: Int) =
        transform(src) { Bitmap.createScaledBitmap(src, w, h, true) }

    @Suppress("DEPRECATION")
    private fun format(kind: Attach.Kind): Bitmap.CompressFormat = when (kind) {
        Attach.Kind.PNG -> Bitmap.CompressFormat.PNG
        Attach.Kind.JPEG -> Bitmap.CompressFormat.JPEG
        Attach.Kind.WEBP -> Bitmap.CompressFormat.WEBP
        Attach.Kind.WEBP_LOSSLESS ->
            if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSLESS else Bitmap.CompressFormat.WEBP
        Attach.Kind.WEBP_LOSSY ->
            if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
    }

    private fun preview(bytes: ByteArray, w: Int, h: Int): Bitmap {
        val edge = maxOf(w, h)
        var sample = 1
        while ((edge + sample - 1) / sample > 192) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }) ?: throw Refusal(PREPARE_FAILED)
    }

    internal class CappedOutput(private val limit: Int) : OutputStream() {
        private var data = ByteArray(minOf(8192, limit))
        var size = 0
            private set
        var overflowed = false
            private set

        private fun reserve(amount: Int) {
            if (amount > limit - size) {
                overflowed = true
                throw IOException("Image output limit")
            }
            if (size + amount > data.size) data = data.copyOf(maxOf(size + amount, minOf(limit, data.size * 2)))
        }

        override fun write(value: Int) {
            reserve(1)
            data[size++] = value.toByte()
        }

        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            reserve(length)
            bytes.copyInto(data, size, offset, offset + length)
            size += length
        }

        fun bytes(): ByteArray = if (data.size == size) data else data.copyOf(size)
    }

    companion object {
        private const val PREPARE_FAILED = "Couldn't prepare this picture."
        private val heicTypes = setOf("image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence")

        private fun isHeic(type: String?) = type != null && type in heicTypes

        fun thumbnail(reply: JSONObject, limits: Attach.Thumbnail): Bitmap? {
            if (reply.opt("ok") != true) return null
            val type = reply.opt("mediaType") as? String ?: return null
            val width = Attach.int(reply, "width")?.takeIf { it in 1..limits.edge.toLong() } ?: return null
            val height = Attach.int(reply, "height")?.takeIf { it in 1..limits.edge.toLong() } ?: return null
            val data = reply.opt("data") as? String ?: return null
            if (type !in Attach.readTypes || data.length > 4 * ((limits.bytes + 2) / 3)) return null
            val bytes = try { Base64.getDecoder().decode(data) } catch (_: IllegalArgumentException) { return null }
            if (bytes.size !in 1..limits.bytes || !magic(bytes, type)) return null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth.toLong() != width || bounds.outHeight.toLong() != height) return null
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let {
                if (it.width.toLong() == width && it.height.toLong() == height) it
                else { it.recycle(); null }
            }
        }

        private fun magic(bytes: ByteArray, type: String): Boolean {
            fun at(offset: Int, vararg signature: Int) = bytes.size >= offset + signature.size &&
                signature.indices.all { bytes[offset + it].toInt() and 255 == signature[it] }
            return when (type) {
                Attach.PNG -> at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
                Attach.JPEG -> at(0, 0xff, 0xd8, 0xff)
                Attach.WEBP -> at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)
                Attach.GIF -> at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
                else -> false
            }
        }
    }
}
