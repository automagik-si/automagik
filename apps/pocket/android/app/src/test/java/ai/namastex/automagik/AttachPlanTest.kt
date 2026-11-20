package ai.namastex.automagik

import org.junit.Assert.*
import org.junit.Test

class AttachPlanTest {
    @Test fun samplingBoundsBothBitmapsAndWorksForExtremeAspectRatios() {
        for ((w, h) in listOf(4097 to 4097, 8191 to 8191, 6143 to 4095, 1 to 70000, 70000 to 70000, Int.MAX_VALUE to Int.MAX_VALUE)) {
            for ((edge, pixels) in listOf(2_147_483_648L to 40_000_000L, 512L to 200_000L, 2_048L to 1L)) {
                for (peak in listOf(Attach.PEAK_PIXELS, Attach.PEAK_PIXELS / 4)) {
                    val p = Attach.plan(w, h, edge, pixels, peak)!!
                    val sample = p.sample.toLong()
                    val sw = (w + sample - 1) / sample
                    val sh = (h + sample - 1) / sample
                    assertTrue(p.width in 1..minOf(sw, edge, 2048L))
                    assertTrue(p.height in 1..minOf(sh, edge, 2048L))
                    assertTrue(p.width.toLong() * p.height <= pixels)
                    assertTrue(sw * sh + p.width.toLong() * p.height <= peak)
                    assertEquals(0, p.sample and (p.sample - 1))
                }
            }
        }
        assertNull(Attach.plan(0, 1, 2048, 2048))
    }

    @Test fun formatPolicyCoversEverySubsetAndSdkIncludingLosslessBoundary() {
        val formats = listOf(Attach.PNG, Attach.JPEG, Attach.WEBP)
        for (sdk in listOf(26, 28, 29, 30, 35)) for (alpha in listOf(false, true)) for (mask in 1..7) {
            val types = formats.filterIndexed { index, _ -> mask and (1 shl index) != 0 }.toSet()
            val result = Attach.encoding(types, alpha, sdk)
            val expected = (if (alpha) listOf(Attach.PNG, Attach.WEBP, Attach.JPEG)
                else listOf(Attach.JPEG, Attach.WEBP, Attach.PNG)).first { it in types }
            assertEquals(expected, result.mediaType)
            val lossy = expected == Attach.JPEG || (expected == Attach.WEBP && (!alpha || sdk < 29))
            assertEquals(lossy, result.lossy)
            if (expected == Attach.WEBP) {
                assertEquals(if (alpha) 100 else 90, result.quality)
                assertEquals(when {
                    sdk < 30 -> Attach.Kind.WEBP
                    alpha -> Attach.Kind.WEBP_LOSSLESS
                    else -> Attach.Kind.WEBP_LOSSY
                }, result.kind)
            }
        }
    }
}
