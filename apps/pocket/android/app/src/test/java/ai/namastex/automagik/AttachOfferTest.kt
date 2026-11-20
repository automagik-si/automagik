package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

internal fun offeredHello(): JSONObject = JSONObject()
    .put("methods", JSONArray(Attach.METHODS.toList()))
    .put("attachments", JSONObject().put("version", 1).put("methods", JSONArray(Attach.METHODS.toList()))
        .put("mediaTypes", JSONArray(listOf(Attach.PNG, Attach.JPEG, Attach.WEBP)))
        .put("limits", JSONObject().put("files", 4).put("fileBytes", 8_388_608).put("messageBytes", 16_777_216)
            .put("maxPixels", 40_000_000).put("maxDimension", 9007199254740991L).put("chunkBytes", 24_576)
            .put("deviceOutstanding", 33_554_432).put("deviceDailyBytes", 268_435_456).put("deviceDailyCount", 128)
            .put("thumbnail", JSONObject().put("edge", 512).put("bytes", 131_072))))

internal fun testOffer() = (Attach.peer(offeredHello()) as Attach.Peer.Offered).offer

class AttachOfferTest {
    @Test fun markersAndBothMethodListsAreRequired() {
        assertEquals(Attach.Peer.Missing, Attach.peer(JSONObject()))
        for ((marker, expected) in mapOf("app" to Attach.Peer.App, "none" to Attach.Peer.None, "other" to Attach.Peer.Unusable)) {
            assertEquals(expected, Attach.peer(JSONObject().put("attachments", JSONObject().put("version", 1).put("unavailable", marker))))
        }
        assertEquals(Attach.Peer.Unusable, Attach.peer(JSONObject().put("attachments", JSONObject.NULL)))
        for (nested in listOf(false, true)) {
            val hello = offeredHello()
            (if (nested) hello.getJSONObject("attachments") else hello).put("methods", JSONArray(Attach.METHODS.toList().dropLast(1)))
            assertEquals(Attach.Peer.Unusable, Attach.peer(hello))
        }
        val hello = offeredHello()
        for (bad in listOf(2, "1", 1.0)) {
            hello.getJSONObject("attachments").put("version", bad)
            assertEquals(Attach.Peer.Unusable, Attach.peer(hello))
        }
    }

    @Test fun typesAreAnExactNonEmptySubsetAndWriteWatchAndDshAreIndependentGates() {
        for (types in listOf(emptyList(), listOf(Attach.GIF), listOf(Attach.PNG, Attach.PNG), listOf(Attach.PNG, 1))) {
            val hello = offeredHello()
            hello.getJSONObject("attachments").put("mediaTypes", JSONArray(types))
            assertEquals(Attach.Peer.Unusable, Attach.peer(hello))
        }
        val hello = offeredHello()
        hello.getJSONObject("attachments").put("mediaTypes", JSONArray(listOf(Attach.WEBP)))
        val peer = Attach.peer(hello)
        assertEquals(setOf(Attach.WEBP), (peer as Attach.Peer.Offered).offer.mediaTypes)
        assertTrue(Attach.usable(peer, true, "dsh:bot", true))
        assertFalse(Attach.usable(peer, false, "dsh:bot", true))
        assertFalse(Attach.usable(peer, true, "t1", true))
        assertFalse(Attach.usable(peer, true, "dsh:bot", false))
    }

    @Test fun strictBoundsAndExactDeviceLimitsRejectTheWholeOffer() {
        val bad = mapOf(
            "files" to listOf(0, 5, 4.0, "4"), "fileBytes" to listOf(0, 8_388_609),
            "messageBytes" to listOf(0, 8_388_607, 16_777_217), "chunkBytes" to listOf(24_575, 24_577, 49_152),
            "maxPixels" to listOf(0, 40_000_001), "maxDimension" to listOf(0, 9_007_199_254_740_992L),
            "deviceOutstanding" to listOf(33_554_431, 33_554_433),
            "deviceDailyBytes" to listOf(268_435_455, 268_435_457), "deviceDailyCount" to listOf(127, 129)
        )
        for ((field, values) in bad) for (value in values) {
            val hello = offeredHello()
            hello.getJSONObject("attachments").getJSONObject("limits").put(field, value)
            assertEquals("$field=$value", Attach.Peer.Unusable, Attach.peer(hello))
        }
        for ((field, value) in listOf("edge" to 0, "edge" to 513, "bytes" to 0, "bytes" to 131_073)) {
            val hello = offeredHello()
            hello.getJSONObject("attachments").getJSONObject("limits").getJSONObject("thumbnail").put(field, value)
            assertEquals(Attach.Peer.Unusable, Attach.peer(hello))
        }
        for (dimension in listOf(2_147_483_648, 9_007_199_254_740_991L)) {
            val hello = offeredHello()
            hello.getJSONObject("attachments").getJSONObject("limits").put("maxDimension", dimension)
            assertEquals(dimension, (Attach.peer(hello) as Attach.Peer.Offered).offer.maxDimension)
        }
    }

}
