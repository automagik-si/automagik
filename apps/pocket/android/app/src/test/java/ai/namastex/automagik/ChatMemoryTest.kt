package ai.namastex.automagik

import ai.namastex.automagik.ChatMemory.Op
import ai.namastex.automagik.ChatMemory.Phase
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ChatMemoryTest {
    private val bot = "dsh:lead"
    private val initial = ChatMemory.State("box", bot, 1, phase = Phase.LOADING, op = Op.READ, grants = ChatClient.MEMORY.toSet())
    private fun entry(id: String = "id", rev: String = "rev") = JSONObject().put("id", id).put("rev", rev).put("text", "A fact")
    private fun snapshot(terminal: String = bot, entries: List<Any> = listOf(entry()), truncated: Boolean = false) =
        JSONObject().put("terminal", terminal).put("entries", JSONArray(entries)).put("size", 7).put("limit", 2000).put("truncated", truncated)
    private fun success(state: String, memory: Any = snapshot()) = JSONObject().put("ok", true).put("state", state).put("memory", memory)
    private fun refused(reason: String) = JSONObject().put("ok", false).put("state", "refused").put("reason", reason)
    private fun ready() = ChatMemory.afterRead(initial, success("read")).first

    @Test fun snapshotsKeepDuplicateLegacyEntriesAndRequireStringFields() {
        val first = entry().put("pinned", true).put("topic", "Project").put("added", "2026-11-19").put("until", "2026-12-01")
        val second = entry().put("expired", true).put("added", 2).put("pinned", "true")
        val invalid = listOf(JSONObject.NULL, 9, entry().put("id", 5), entry().put("rev", false), entry().put("text", JSONObject.NULL))
        val (s, read) = ChatMemory.afterRead(initial, success("read", snapshot(entries = listOf(first, second) + invalid, truncated = true)))
        assertFalse(read)
        assertEquals(Phase.READY, s.phase)
        assertEquals(Op.NONE, s.op)
        assertNull(s.status)
        val memory = checkNotNull(s.snapshot)
        assertEquals(bot, memory.terminal)
        assertEquals(7, memory.size)
        assertEquals(2000, memory.limit)
        assertTrue(memory.truncated)
        val (a, b) = memory.entries
        assertEquals(listOf("id", "id"), memory.entries.map { it.id })
        assertEquals(listOf("rev", "rev"), memory.entries.map { it.rev })
        assertEquals("A fact", a.text)
        assertEquals("Project", a.topic)
        assertEquals("2026-11-19", a.added)
        assertEquals("2026-12-01", a.until)
        assertTrue(a.pinned)
        assertTrue(b.expired)
        assertFalse(b.pinned)
        assertNull(b.added)
    }

    @Test fun malformedOrWrongBotSnapshotsFailReadsAndReconcileSaves() {
        val invalid = listOf(JSONObject.NULL, 17, JSONArray(), JSONObject().put("terminal", bot),
            snapshot("dsh:other"), snapshot().put("entries", "[]"))
        val s = ready()
        for (memory in invalid) {
            val (read, again) = ChatMemory.afterRead(s, success("read", memory))
            assertFalse(again)
            assertEquals(Phase.READ_FAILED, read.phase)
            assertEquals("Couldn't read the memory.", read.status)
            assertSame(s.snapshot, read.snapshot)
            val (write, verify) = ChatMemory.afterWrite(s, Op.EDIT, success("saved", memory))
            assertTrue(verify)
            assertEquals(Phase.RECONCILING, write.phase)
            assertEquals("Saved.", write.outcome)
            assertSame(s.snapshot, write.snapshot)
        }
        val (sparse, verify) = ChatMemory.afterWrite(s, Op.ADD, success("saved").apply { remove("memory") })
        assertTrue(verify)
        assertEquals("Saved.", sparse.outcome)
    }

    @Test fun successfulWritesReplaceTheSnapshotAndShowAnEntryOmittedByTruncation() {
        val old = ready()
        val (saved, verify) = ChatMemory.afterWrite(old, Op.EDIT, success("saved", snapshot(truncated = true)).put("entry", entry(rev = "new")))
        assertFalse(verify)
        assertNotSame(old.snapshot, saved.snapshot)
        assertEquals("new", saved.confirmed?.rev)
        assertEquals("Saved.", saved.outcome)
        val (read, again) = ChatMemory.afterRead(saved, success("read"))
        assertFalse(again)
        assertNull(read.confirmed)
        assertEquals("Saved.", read.outcome)
        val (unchanged, recheck) = ChatMemory.afterWrite(read, Op.ADD, success("unchanged").put("entry", entry()))
        assertFalse(recheck)
        assertNull(unchanged.confirmed)
        assertEquals("No change: that text is already there.", unchanged.outcome)
        val (badEntry, _) = ChatMemory.afterWrite(read, Op.ADD, success("saved").put("entry", entry().put("rev", 1)))
        assertNull(badEntry.confirmed)
    }

    @Test fun conflictsRequireRefreshUnlessTheyReturnACurrentSnapshot() {
        val s = ready().copy(confirmed = ChatMemory.Entry("old", "rev", "Old", null, null, null, false, false))
        val lines = mapOf("stale" to "That entry changed on the computer. Here is the current memory.",
            "gone" to "That entry is gone from the computer.", "ambiguous" to "That entry appears twice on the computer; edit it there.")
        for ((reason, line) in lines) {
            val (with, check) = ChatMemory.afterWrite(s, Op.EDIT, refused(reason).put("memory", snapshot(entries = emptyList())))
            assertFalse(check)
            assertEquals(Phase.READY, with.phase)
            assertEquals(line, with.outcome)
            assertNull(with.status)
            assertEquals(emptyList<ChatMemory.Entry>(), with.snapshot?.entries)
            assertNull(with.confirmed)
            assertTrue(with.canWrite("memory.edit"))
            for (reply in listOf(refused(reason), refused(reason).put("memory", JSONObject.NULL),
                refused(reason).put("memory", JSONObject().put("terminal", bot)), refused(reason).put("memory", snapshot("dsh:other")))) {
                val (without, again) = ChatMemory.afterWrite(s, Op.EDIT, reply)
                assertFalse(again)
                assertSame(s.snapshot, without.snapshot)
                assertEquals(Phase.READ_FAILED, without.phase)
                assertEquals(line, without.outcome)
                assertEquals("Refresh to see the current memory.", without.status)
                assertFalse(without.canWrite("memory.edit"))
                assertTrue(without.canRefresh)
            }
        }
    }

    @Test fun unknownWritesAskForOneReadAndFailedReconciliationKeepsTheOutcome() {
        val s = ready()
        val unknown = listOf(null, 2, JSONArray(), JSONObject(), success("future"), success("unchanged", JSONObject.NULL),
            CoreError("unavailable", "detail"), IllegalStateException("connection closed"),
            JSONObject("""{"ok":false,"state":"unknown","reason":"pending"}"""),
            JSONObject("""{"ok":false,"state":"unknown","reason":"offline"}"""))
        for (reply in unknown) {
            val (checking, check) = ChatMemory.afterWrite(s, Op.ADD, reply)
            assertTrue(check)
            assertEquals(Phase.RECONCILING, checking.phase)
            assertEquals(Op.READ, checking.op)
            assertEquals("The computer didn't confirm this change.", checking.outcome)
            assertEquals("Checking…", checking.status)
            val (failed, again) = ChatMemory.afterRead(checking, refused("offline"))
            assertFalse(again)
            assertEquals(Phase.READ_FAILED, failed.phase)
            assertEquals(checking.outcome, failed.outcome)
            assertEquals("Couldn't check the memory. Refresh to see what was saved.", failed.status)
            assertFalse(failed.canWrite("memory.add"))
            assertTrue(failed.canRefresh)
            val refreshing = failed.copy(phase = Phase.LOADING, op = Op.READ, status = "Checking…")
            val (failedAgain, retry) = ChatMemory.afterRead(refreshing, IllegalStateException("Timed out"))
            assertEquals(failed, failedAgain)
            assertFalse(retry)
            for (reading in listOf(checking, refreshing)) {
                val (read, readAgain) = ChatMemory.afterRead(reading, success("read"))
                assertFalse(readAgain)
                assertEquals(Phase.READY, read.phase)
                assertEquals("The computer didn't confirm this change. The list shows what the computer has now.", read.outcome)
                assertNull(read.status)
                assertTrue(read.canWrite("memory.add"))
            }
        }
        val (saved, _) = ChatMemory.afterWrite(s, Op.ADD, success("saved", JSONObject.NULL))
        val (read, _) = ChatMemory.afterRead(saved, success("read"))
        assertEquals("Saved.", read.outcome)
        assertNull(read.status)
    }

    @Test fun authorityRefusalsDropTheSnapshotAndConfirmedEntry() {
        val (s, _) = ChatMemory.afterWrite(ready(), Op.ADD, success("saved").put("entry", entry("extra")))
        val lines = mapOf("private" to "This Bot is private: its memory stays on the computer.",
            "global" to "The Main Bot and global Bots' memory is managed on the computer.",
            "not-shown" to "This Bot's project isn't shown to the phone. Show it in Automagik first.",
            "not-found" to "This Bot isn't on the computer anymore.",
            "revoked" to "This phone can't manage this Bot's memory now.", "read-only" to "This phone can't manage this Bot's memory now.")
        for ((reason, line) in lines) {
            val read = ChatMemory.afterRead(s, refused(reason))
            val writing = s.copy(op = Op.EDIT, outcome = null)
            val write = ChatMemory.afterWrite(writing, Op.EDIT, refused(reason))
            val applied = ChatMemory.afterWrite(writing, Op.EDIT, refused(reason).put("applied", true))
            val expectations = listOf(Triple(read, line, "Saved."), Triple(write, line, null),
                Triple(applied, null, "Saved on the computer, but $line"))
            for ((result, status, outcome) in expectations) {
                val (closed, check) = result
                assertFalse(check)
                assertEquals(Phase.CLOSED, closed.phase)
                assertEquals(status, closed.status)
                assertNull(closed.snapshot)
                assertNull(closed.confirmed)
                assertEquals(outcome, closed.outcome)
                assertTrue(closed.grants.isEmpty())
                assertFalse(closed.canRefresh)
            }
        }
        val (checking, _) = ChatMemory.afterWrite(s, Op.ADD, null)
        val (closed, again) = ChatMemory.afterRead(checking, refused("private"))
        assertFalse(again)
        assertEquals(Phase.CLOSED, closed.phase)
        assertEquals("The computer didn't confirm this change.", closed.outcome)
        assertEquals(lines["private"], closed.status)
    }

    @Test fun ordinaryRefusalsExposeTheReasonAndOnlyAppliedWritesReconcile() {
        val s = ready()
        val reasons = mapOf("busy" to "Another memory request for this Bot is running. Try again.",
            "rate" to "Too many memory requests. Wait a minute.",
            "too-large" to "This Bot's memory is too large to manage from the phone.",
            "unavailable" to "Memory isn't available on the computer right now.",
            "offline" to "The computer didn't answer.",
            "invalid" to "The computer refused that text.",
            "!!" + "a".repeat(32) + "MARKER" to "The computer refused this (${"a".repeat(32)}).")
        for ((reason, line) in reasons) {
            val (read, again) = ChatMemory.afterRead(s, refused(reason))
            assertFalse(again)
            assertEquals(Phase.READ_FAILED, read.phase)
            assertEquals(line, read.status)
            assertSame(s.snapshot, read.snapshot)
            val (write, check) = ChatMemory.afterWrite(s, Op.ADD, refused(reason))
            assertFalse(check)
            assertEquals(Phase.READY, write.phase)
            assertEquals(if (reason == "offline") "$line Nothing was changed." else line, write.outcome)
            assertSame(s.snapshot, write.snapshot)
        }
        val (invalid, _) = ChatMemory.afterWrite(s, Op.ADD, refused("invalid").put("message", "At most 300 characters."))
        assertEquals("At most 300 characters.", invalid.outcome)
        assertEquals(reasons["invalid"], ChatMemory.afterWrite(s, Op.ADD, refused("invalid").put("message", 3)).first.outcome)
        val (applied, check) = ChatMemory.afterWrite(s, Op.ADD, refused("unavailable").put("applied", true))
        assertTrue(check)
        assertEquals(Phase.RECONCILING, applied.phase)
        assertEquals("Saved on the computer, but Memory isn't available on the computer right now.", applied.outcome)
        val (offlineAfterSave, verify) = ChatMemory.afterWrite(s, Op.ADD, refused("offline").put("applied", true))
        assertTrue(verify)
        assertEquals("Saved on the computer, but The computer didn't answer.", offlineAfterSave.outcome)
    }

    @Test fun coreBusyIsDefiniteAndOtherReadFailuresAreGeneric() {
        val s = ready()
        val busy = CoreError("busy", "detail")
        val line = "Too many requests at once. Try again."
        val (write, check) = ChatMemory.afterWrite(s, Op.ADD, busy)
        assertFalse(check)
        assertEquals(Phase.READY, write.phase)
        assertEquals(line, write.outcome)
        val (read, again) = ChatMemory.afterRead(s, busy)
        assertFalse(again)
        assertEquals(Phase.READ_FAILED, read.phase)
        assertEquals(line, read.status)
        for (reply in listOf(null, "bad", IllegalArgumentException("payload"), JSONObject(), success("saved"))) {
            assertEquals("Couldn't read the memory.", ChatMemory.afterRead(s, reply).first.status)
        }
    }

    @Test fun controlsRequireAnIdleOperationAndTextUsesTheUtf8ByteLimit() {
        val s = ready().copy(grants = setOf("memory.read", "memory.add"))
        assertTrue(s.canWrite("memory.add"))
        assertFalse(s.canWrite("memory.edit"))
        assertTrue(s.canRefresh)
        assertFalse(s.copy(op = Op.READ).canRefresh)
        assertFalse(s.copy(op = Op.EDIT).canWrite("memory.add"))
        assertFalse(initial.canRefresh)
        assertNotNull(ChatMemory.checkText(" \n\t "))
        assertNull(ChatMemory.checkText("é".repeat(2048)))
        assertNotNull(ChatMemory.checkText("é".repeat(2048) + "a"))
    }
}
