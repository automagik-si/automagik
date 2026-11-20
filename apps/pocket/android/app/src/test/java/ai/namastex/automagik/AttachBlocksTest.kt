package ai.namastex.automagik

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AttachBlocksTest {
    @Test fun richBlocksKeepContentOrderAndSkipInvalidParts() {
        val row = Chat.Row.parse(JSONObject("""{"id":"dsh:session:7","kind":"text","blocks":[
            {"type":"text","text":"caption"},{"type":"image","block":1,"mediaType":"image/gif","width":2,"height":3},
            {"type":"image","block":2,"mediaType":"image/svg+xml","width":2,"height":3},
            {"type":"image","block":3,"mediaType":"image/png","width":0,"height":3},
            {"type":"file","block":3,"bytes":-1},{"type":"file","block":4,"bytes":12288,"name":" note.txt "},
            {"type":"other"},{"type":"more","count":3}]}"""))!!
        assertEquals(listOf(Attach.Block.Text("caption"), Attach.Block.Image(1, Attach.GIF, 2, 3),
            Attach.Block.File(4, 12288, "note.txt"), Attach.Block.More(3)), row.blocks)
    }

    @Test fun fileNamesAreCleanedAndEmptyOrDotNamesDropped() {
        val j = JSONObject("""{"blocks":[{"type":"file","block":0,"bytes":0,"name":"\u001b[31mname"},
            {"type":"file","block":1,"bytes":0,"name":"."},{"type":"file","block":2,"bytes":0,"name":".."},
            {"type":"file","block":3,"bytes":0,"name":" "}]}""")
        assertEquals(listOf("name", null, null, null), Attach.blocks(j.get("blocks"))!!.map { (it as Attach.Block.File).name })
        assertNull(Attach.blocks(JSONObject()))
        assertTrue(Attach.renderable(Attach.blocks(org.json.JSONArray())!!).isEmpty())
        assertTrue(Attach.renderable(listOf(Attach.Block.Text(" "))).isEmpty())
    }

    @Test fun canonicalRowsRetainColonsInTheSessionAndRejectMalformedIds() {
        assertEquals("dsh:session:internal:19", Attach.canonicalRow("dsh:session:internal:19#2"))
        assertEquals("session:internal", Attach.sessionOf("dsh:session:internal:19#2"))
        for (id in listOf("", "t:1", "dsh::1", "dsh:session", "dsh:session:", "dsh:s:-1", "dsh:s:+1"))
            assertNull(id, Attach.sessionOf(id))
    }
}
