package ai.namastex.automagik

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.media.ExifInterface
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.util.Base64
import java.util.zip.CRC32

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachImageTest {
    @get:Rule val tmp = TemporaryFolder()
    private val resolver get() = ApplicationProvider.getApplicationContext<Application>().contentResolver

    private fun image(bitmap: Bitmap, format: Bitmap.CompressFormat): ByteArray =
        ByteArrayOutputStream().also { assertTrue(bitmap.compress(format, 100, it)) }.toByteArray()

    private fun file(name: String, bytes: ByteArray) = tmp.newFile(name).apply { writeBytes(bytes) }
    private fun decode(bytes: ByteArray): Bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        ?: error("Fixture was not decoded")

    private fun corners(bitmap: Bitmap) = listOf(
        bitmap.getPixel(1, 1), bitmap.getPixel(bitmap.width - 2, 1),
        bitmap.getPixel(1, bitmap.height - 2), bitmap.getPixel(bitmap.width - 2, bitmap.height - 2)
    )

    private fun colorNear(expected: Int, actual: Int) {
        assertTrue(kotlin.math.abs(Color.red(expected) - Color.red(actual)) <= 28)
        assertTrue(kotlin.math.abs(Color.green(expected) - Color.green(actual)) <= 28)
        assertTrue(kotlin.math.abs(Color.blue(expected) - Color.blue(actual)) <= 28)
    }

    @Test fun legacyDecoderOrientsJpegCornersAndRemovesApp1IncludingGps() {
        val palette = listOf(Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW)
        val base = Bitmap.createBitmap(48, 32, Bitmap.Config.ARGB_8888)
        for (y in 0 until base.height) for (x in 0 until base.width)
            base.setPixel(x, y, palette[(if (y < 16) 0 else 2) + if (x < 24) 0 else 1])
        val jpg = image(base, Bitmap.CompressFormat.JPEG)
        base.recycle()

        val expected = listOf(
            listOf(0, 1, 2, 3), listOf(1, 0, 3, 2), listOf(3, 2, 1, 0), listOf(2, 3, 0, 1),
            listOf(0, 2, 1, 3), listOf(2, 0, 3, 1), listOf(3, 1, 2, 0), listOf(1, 3, 0, 2)
        )
        for (orientation in 1..8) {
            val fixture = file("orientation-$orientation.jpg", jpg)
            ExifInterface(fixture.path).apply {
                setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
                setAttribute(ExifInterface.TAG_GPS_LATITUDE, "12/1,34/1,56/1")
                setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
                setAttribute(ExifInterface.TAG_GPS_LONGITUDE, "12/1,34/1,56/1")
                setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, "E")
                saveAttributes()
            }
            assertTrue(jpegHasApp1(fixture.readBytes()))
            val prepared = AttachImage(resolver, forceLegacy = true).prepare(Uri.fromFile(fixture),
                testOffer().copy(mediaTypes = setOf(Attach.JPEG)))
            assertEquals(if (orientation >= 5) 32 else 48, prepared.width)
            assertEquals(if (orientation >= 5) 48 else 32, prepared.height)
            assertFalse(jpegHasApp1(prepared.bytes))
            val actual = decode(prepared.bytes)
            corners(actual).zip(expected[orientation - 1]).forEach { (pixel, index) -> colorNear(palette[index], pixel) }
            actual.recycle()
            prepared.preview?.recycle()
        }
    }

    @Test fun alphaPngAndWebpKeepPixelsWhileJpegFlattensOnWhiteAndPngDropsMetadata() {
        val source = Bitmap.createBitmap(24, 24, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.TRANSPARENT) }
        val png = image(source, Bitmap.CompressFormat.PNG)
        source.recycle()
        val fixture = file("alpha.png", withTextChunk(png))
        assertTrue("tEXt" in pngChunks(fixture.readBytes()))
        for (type in listOf(Attach.PNG, Attach.WEBP, Attach.JPEG)) {
            val prepared = AttachImage(resolver, forceLegacy = true)
                .prepare(Uri.fromFile(fixture), testOffer().copy(mediaTypes = setOf(type)))
            assertEquals(type, prepared.mediaType)
            val image = decode(prepared.bytes)
            if (type == Attach.JPEG) colorNear(Color.WHITE, image.getPixel(12, 12))
            else assertEquals(0, Color.alpha(image.getPixel(12, 12)))
            if (type == Attach.PNG)
                assertTrue(pngChunks(prepared.bytes).none { it in setOf("eXIf", "tEXt", "iTXt", "zTXt") })
            image.recycle()
            prepared.preview?.recycle()
        }
    }

    @Test fun legacyDecoderBoundsLargeInputAndPreview() {
        val bitmap = Bitmap.createBitmap(6000, 4000, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
        val fixture = file("large.jpg", image(bitmap, Bitmap.CompressFormat.JPEG))
        bitmap.recycle()
        val prepared = AttachImage(resolver, forceLegacy = true).prepare(Uri.fromFile(fixture), testOffer())
        assertEquals(2048, prepared.width)
        assertTrue(prepared.height in 1363..1366)
        val preview = prepared.preview!!
        assertTrue(maxOf(preview.width, preview.height) <= 192)
        colorNear(Color.BLUE, preview.getPixel(preview.width / 2, preview.height / 2))
        preview.recycle()
    }

    @Test fun encoderStepsDownBeforeShrinkingAndPreviewsOnlyAcceptedOutput() {
        val bitmap = Bitmap.createBitmap(64, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
        val fixture = Uri.fromFile(file("small.jpg", image(bitmap, Bitmap.CompressFormat.JPEG)))
        bitmap.recycle()
        val offer = testOffer().copy(fileBytes = 4096, mediaTypes = setOf(Attach.JPEG))
        val steps = mutableListOf<Pair<Int, Int>>()
        val prepared = AttachImage(resolver, forceLegacy = true) { candidate, format, quality, output ->
            steps += candidate.width to quality
            if (steps.size < 3) {
                try { output.write(ByteArray(offer.fileBytes + 1)) } catch (_: IOException) { }
                false
            } else {
                // Give the encoded copy a different color without changing the decoded source.
                val encoded = Bitmap.createBitmap(candidate.width, candidate.height, Bitmap.Config.ARGB_8888)
                try {
                    encoded.eraseColor(Color.RED)
                    encoded.compress(format, quality, output)
                } finally {
                    encoded.recycle()
                }
            }
        }.prepare(fixture, offer)
        assertEquals(listOf(64 to 90, 64 to 80, 48 to 80), steps)
        assertTrue(prepared.bytes.size <= offer.fileBytes)
        val preview = prepared.preview!!
        colorNear(Color.RED, preview.getPixel(preview.width / 2, preview.height / 2))
        preview.recycle()
        val falseReturn = AttachImage(resolver, forceLegacy = true) { _, _, _, _ -> false }
        assertEquals("Couldn't prepare this picture.", assertThrows(AttachImage.Refusal::class.java) {
            falseReturn.prepare(fixture, offer)
        }.words)
        assertEquals("Too large to send even after shrinking.", assertThrows(AttachImage.Refusal::class.java) {
            AttachImage(resolver, forceLegacy = true).prepare(fixture, offer.copy(fileBytes = 1))
        }.words)
        val stream = AttachImage.CappedOutput(9)
        stream.write(ByteArray(8))
        assertThrows(IOException::class.java) { stream.write(byteArrayOf(1, 2)) }
        assertTrue(stream.overflowed)
        assertEquals(8, stream.size)
    }

    @Test fun animatedGifSendsOnlyTheFirstFrameAndGifThumbnailsAreAccepted() {
        val data = "R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7"
        val fixture = Uri.fromFile(file("animated.gif", Base64.getDecoder().decode(data)))
        val prepared = AttachImage(resolver, forceLegacy = true)
            .prepare(fixture, testOffer().copy(mediaTypes = setOf(Attach.PNG)))
        assertEquals(Attach.PNG, prepared.mediaType)
        val still = decode(prepared.bytes)
        assertEquals(Color.RED, still.getPixel(0, 0))
        still.recycle()
        prepared.preview?.recycle()
        val gif = JSONObject().put("ok", true).put("mediaType", Attach.GIF).put("width", 2).put("height", 2).put("data", data)
        val thumb = AttachImage.thumbnail(gif, testOffer().thumbnail)
        assertNotNull(thumb)
        assertEquals(Color.RED, thumb!!.getPixel(0, 0))
        thumb.recycle()
    }

    @Test fun legacyDecoderRefusesUnreadableImagesLocally() {
        val garbage = Uri.fromFile(file("garbage.png", byteArrayOf(1, 2)))
        assertEquals("Couldn't prepare this picture.", assertThrows(AttachImage.Refusal::class.java) {
            AttachImage(resolver, forceLegacy = true).prepare(garbage, testOffer())
        }.words)
    }

    private fun jpegHasApp1(data: ByteArray): Boolean {
        var offset = 2
        while (offset + 4 <= data.size && data[offset].toInt() and 255 == 255) {
            val marker = data[offset + 1].toInt() and 255
            if (marker == 0xe1) return true
            if (marker == 0xda || marker == 0xd9) return false
            offset += 2 + ((data[offset + 2].toInt() and 255) shl 8) + (data[offset + 3].toInt() and 255)
        }
        return false
    }

    private fun pngChunks(data: ByteArray): List<String> = buildList {
        val input = ByteBuffer.wrap(data)
        input.position(8)
        while (input.remaining() >= 12) {
            val size = input.int
            val type = ByteArray(4).also { input.get(it) }
            add(String(type, Charsets.US_ASCII))
            input.position(input.position() + size + 4)
        }
    }

    private fun withTextChunk(data: ByteArray): ByteArray {
        val field = "tEXtcomment\u0000synthetic".toByteArray()
        val crc = CRC32().apply { update(field) }
        val out = ByteArrayOutputStream()
        DataOutputStream(out).use {
            it.write(data, 0, 33) // Signature and IHDR.
            it.writeInt(field.size - 4)
            it.write(field)
            it.writeInt(crc.value.toInt())
            it.write(data, 33, data.size - 33)
        }
        return out.toByteArray()
    }
}
