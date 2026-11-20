package ai.namastex.automagik

import ai.namastex.automagik.ChatSchedules.Op
import ai.namastex.automagik.ChatSchedules.Phase
import ai.namastex.automagik.ChatSchedules.Timing
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

internal fun scheduleTestTask(id: String = "x0000000000000001", rev: String = "0000000000000001",
                              title: String = "Daily report", state: String = "scheduled",
                              timing: JSONObject = JSONObject().put("kind", "daily").put("at", "2026-11-20T01:00:00Z")
                                  .put("time", "01:00:00.000").put("timeZone", "UTC")) =
    JSONObject().put("id", id).put("rev", rev).put("title", title).put("state", state).put("timing", timing)

internal fun scheduleTestList(terminal: String, rows: List<Any> = listOf(scheduleTestTask()), truncated: Boolean = false) =
    JSONObject().put("ok", true).put("state", "read").put("schedules",
        JSONObject().put("terminal", terminal).put("tasks", JSONArray(rows)).put("truncated", truncated))

internal fun scheduleTestRefusal(reason: String, applied: Boolean = false) =
    JSONObject().put("ok", false).put("state", "refused").put("reason", reason).apply { if (applied) put("applied", true) }

internal fun scheduleTestWrite(state: String, task: Any = scheduleTestTask()) =
    JSONObject().put("ok", true).put("state", state).put("task", task)

class ChatSchedulesTest {
    private val bot = "dsh:lead"
    private val id = "x0000000000000001"
    private val initial = ChatSchedules.State("box", bot, 1, phase = Phase.LOADING, op = Op.READ, grants = ChatClient.SCHEDULES.toSet())
    private val ready get() = ChatSchedules.afterRead(initial, null, scheduleTestList(bot))
    private fun writing(op: Op = Op.RENAME) = ready.copy(op = op, opTask = id)
    private val checking get() = ChatSchedules.afterWrite(writing(), null)

    @Test fun readsCheckTheTerminalAndSkipRowsWithoutTheRequiredTypes() {
        val invalid = listOf(JSONObject.NULL, 3, scheduleTestTask().put("id", 5), scheduleTestTask().put("rev", false),
            scheduleTestTask().put("title", JSONObject.NULL), scheduleTestTask().put("state", "unknown"),
            scheduleTestTask().put("state", 1), scheduleTestTask().put("timing", "daily"), scheduleTestTask(timing = JSONObject().put("kind", 1)))
        val row = scheduleTestTask().put("prompt", "fixture-prompt-marker").put("target", JSONObject().put("sessionId", "fixture-session-marker"))
        val read = ChatSchedules.afterRead(initial, null, scheduleTestList(bot, listOf(row) + invalid, truncated = true))
        val listing = checkNotNull(read.listing)
        assertEquals(Phase.READY, read.phase)
        assertEquals(Op.NONE, read.op)
        assertEquals(bot, listing.terminal)
        assertTrue(listing.truncated)
        assertEquals(ChatSchedules.Task(id, "0000000000000001", "Daily report", "scheduled",
            Timing("daily", "2026-11-20T01:00:00Z", time = "01:00:00.000", timeZone = "UTC")), listing.tasks.single())
        assertFalse("fixture-prompt-marker" in listing.toString() || "fixture-session-marker" in listing.toString())
        for (reply in listOf(scheduleTestList("dsh:other"), scheduleTestList(bot).apply { getJSONObject("schedules").put("tasks", "[]") },
            scheduleTestList(bot).put("ok", "true"), scheduleTestList(bot).put("schedules", JSONArray()), null, 3)) {
            assertEquals(Phase.READ_FAILED, ChatSchedules.afterRead(initial, null, reply).phase)
        }
    }

    @Test fun selectedReadsRebuildTheListingAndMergeEvenATaskOutsideTheCap() {
        val fresh = scheduleTestTask(id = "other", title = "New row")
        val selected = scheduleTestTask(rev = "latest", title = "Current name", state = "paused")
        val reply = scheduleTestList(bot, listOf(fresh), truncated = true).put("task", selected)
        val resolved = ChatSchedules.afterRead(checking, id, reply)
        assertEquals(Phase.READY, resolved.phase)
        assertNull(resolved.uncertain)
        assertEquals("The computer didn't confirm this change. The list shows what the computer has now.", resolved.outcome)
        assertEquals(listOf("other", id), resolved.listing?.tasks?.map { it.id })
        assertEquals("latest", resolved.listing?.tasks?.last()?.rev)
        assertTrue(checkNotNull(resolved.listing).truncated)
        val replaced = ChatSchedules.afterRead(checking, id, scheduleTestList(bot).put("task", selected))
        assertEquals("Current name", replaced.listing?.tasks?.single()?.title)
    }

    @Test fun nullAndGonePurgeTheRowAndKeepItLockedEvenIfAPlainListShowsItAgain() {
        val other = scheduleTestTask(id = "other", title = "New row")
        val gone = listOf(
            ChatSchedules.afterRead(checking, id, scheduleTestList(bot, listOf(other, scheduleTestTask())).put("task", JSONObject.NULL)),
            ChatSchedules.afterRead(checking, id, scheduleTestRefusal("gone")))
        assertEquals(listOf("other"), gone.first().listing?.tasks?.map { it.id })
        assertTrue(checkNotNull(gone.last().listing).tasks.isEmpty())
        for (result in gone) {
            assertEquals(Phase.READY, result.phase)
            assertEquals(ChatSchedules.UNCONFIRMED, result.outcome)
            assertEquals(id, result.uncertain)
            assertTrue(result.canRefresh)
            val plain = ChatSchedules.afterRead(result, null, scheduleTestList(bot).put("task", scheduleTestTask()))
            assertEquals(id, plain.uncertain)
            assertFalse(plain.canAct("schedule.rename", checkNotNull(plain.listing).tasks.single()))
        }
    }

    @Test fun malformedSelectedRepliesAndTemporaryFailuresLeaveRefreshAndKeepUncertainty() {
        val failures = listOf(scheduleTestList(bot), scheduleTestList(bot).put("task", 1),
            scheduleTestList(bot).put("task", scheduleTestTask(id = "other")),
            scheduleTestList(bot).put("task", scheduleTestTask().put("rev", 2)),
            scheduleTestList("dsh:other").put("task", scheduleTestTask()),
            JSONObject("""{"ok":false,"state":"unknown","reason":"pending"}"""), CoreError("busy", "detail"),
            IllegalStateException("timeout"), null) + listOf("busy", "rate", "unavailable", "offline", "unknown", "ambiguous").map { scheduleTestRefusal(it) }
        for (reply in failures) {
            val failed = ChatSchedules.afterRead(checking, id, reply)
            assertEquals(Phase.READ_FAILED, failed.phase)
            assertEquals(id, failed.uncertain)
            assertEquals(ChatSchedules.UNCONFIRMED, failed.outcome)
            assertEquals("Couldn't check the task. Refresh to check again.", failed.status)
            assertTrue(failed.canRefresh)
        }
    }

    @Test fun savedUnchangedStaleAndEndedUseTheWholeTaskWithoutReconciliation() {
        val returned = scheduleTestTask(rev = "current", title = "Changed on the computer", state = "finished",
            timing = JSONObject().put("kind", "at").put("at", "2026-11-20T01:00:00Z"))
        val replies = listOf(
            Triple(Op.PAUSE, scheduleTestWrite("saved", returned), "Paused."),
            Triple(Op.RESUME, scheduleTestWrite("saved", returned), "Resumed."),
            Triple(Op.RENAME, scheduleTestWrite("saved", returned), "Renamed."),
            Triple(Op.RENAME, scheduleTestWrite("unchanged", returned), "No change."),
            Triple(Op.RENAME, scheduleTestRefusal("stale").put("task", returned), "That task changed on the computer. Here is the current version."),
            Triple(Op.PAUSE, scheduleTestRefusal("ended").put("task", returned), "That task has finished."))
        for ((op, reply, outcome) in replies) {
            val result = ChatSchedules.afterWrite(writing(op), reply)
            assertEquals(Phase.READY, result.phase)
            assertEquals(Op.NONE, result.op)
            assertNull(result.uncertain)
            assertEquals(outcome, result.outcome)
            val row = checkNotNull(result.listing).tasks.single()
            assertEquals(ChatSchedules.Task(id, "current", "Changed on the computer", "finished", Timing("at", "2026-11-20T01:00:00Z")), row)
            assertTrue(result.canAct("schedule.rename", row))
            assertFalse(result.canAct("schedule.resume", row))
            assertFalse(result.canAct("schedule.pause", row))
        }
    }

    @Test fun goneAndAmbiguousAreDefiniteAndOnlyGoneRemovesTheTask() {
        val s = writing()
        val gone = ChatSchedules.afterWrite(s, scheduleTestRefusal("gone"))
        assertEquals("That task is gone from the computer.", gone.outcome)
        assertEquals(Phase.READY, gone.phase)
        assertTrue(checkNotNull(gone.listing).tasks.isEmpty())
        val ambiguous = ChatSchedules.afterWrite(s, scheduleTestRefusal("ambiguous"))
        assertEquals("That task appears twice on the computer; change it there.", ambiguous.outcome)
        assertEquals(Phase.READY, ambiguous.phase)
        assertSame(s.listing, ambiguous.listing)
    }

    @Test fun authorityRefusalsDiscardContentAndKeepAnUnconfirmedOutcome() {
        for (reason in listOf("revoked", "read-only", "not-shown", "not-found", "global")) {
            val read = ChatSchedules.afterRead(checking, id, scheduleTestRefusal(reason))
            val write = ChatSchedules.afterWrite(writing(), scheduleTestRefusal(reason))
            for (closed in listOf(read, write)) {
                assertEquals(Phase.CLOSED, closed.phase)
                assertNull(closed.listing)
                assertNull(closed.opTask)
                assertTrue(closed.grants.isEmpty())
                assertFalse(closed.canRefresh)
            }
            assertEquals(ChatSchedules.UNCONFIRMED, read.outcome)
            assertEquals(id, read.uncertain)
        }
    }

    @Test fun appliedWinsOverGoneAndAuthorityAndOtherReasonsLockOnlyTheAffectedRow() {
        val gone = ChatSchedules.afterWrite(writing(), scheduleTestRefusal("gone", applied = true))
        assertTrue(checkNotNull(gone.listing).tasks.isEmpty())
        assertEquals("Saved on the computer, but That task is gone from the computer.", gone.outcome)
        for (reason in listOf("revoked", "not-shown")) {
            val closed = ChatSchedules.afterWrite(writing(), scheduleTestRefusal(reason, applied = true))
            assertEquals(Phase.CLOSED, closed.phase)
            assertNull(closed.listing)
            assertTrue(checkNotNull(closed.outcome).startsWith("Saved on the computer, but "))
        }
        val unavailable = ChatSchedules.afterWrite(writing(), scheduleTestRefusal("unavailable", applied = true))
        val noReason = ChatSchedules.afterWrite(writing(), scheduleTestRefusal("unavailable", applied = true).apply { remove("reason") })
        assertEquals("Saved on the computer, but The computer refused that.", noReason.outcome)
        assertEquals(setOf(id), noReason.needsRefresh)
        val row = checkNotNull(unavailable.listing).tasks.single()
        assertEquals(Phase.READY, unavailable.phase)
        assertEquals(setOf(id), unavailable.needsRefresh)
        assertFalse(unavailable.canAct("schedule.rename", row))
        assertTrue(unavailable.canRefresh)
        val other = scheduleTestTask(id = "other", title = "Other task")
        val twoRows = writing().copy(listing = ChatSchedules.afterRead(initial, null,
            scheduleTestList(bot, listOf(scheduleTestTask(), other))).listing)
        val affectedOnly = ChatSchedules.afterWrite(twoRows, scheduleTestRefusal("unavailable", applied = true))
        val otherRow = checkNotNull(affectedOnly.listing).tasks.single { it.id == "other" }
        assertEquals(setOf(id), affectedOnly.needsRefresh)
        assertTrue(affectedOnly.canAct("schedule.rename", otherRow))
        val failed = ChatSchedules.afterRead(unavailable, null, scheduleTestRefusal("busy"))
        assertEquals(unavailable.outcome, failed.outcome)
        val omitted = ChatSchedules.afterRead(failed, null, scheduleTestList(bot, emptyList(), truncated = true))
        assertEquals(setOf(id), omitted.needsRefresh)
        val supplied = ChatSchedules.afterRead(omitted, null, scheduleTestList(bot))
        assertEquals(unavailable.outcome, supplied.outcome)
        assertTrue(supplied.needsRefresh.isEmpty())
        assertTrue(supplied.canAct("schedule.pause", checkNotNull(supplied.listing).tasks.single()))
    }

    @Test fun unknownLostOrUnmatchedWritesStartASelectedRead() {
        val replies = listOf(null, 1, JSONObject(), JSONArray(), IllegalStateException("closed"), CoreError("failed", "detail"),
            JSONObject("""{"ok":false,"state":"unknown","reason":"pending"}"""),
            JSONObject("""{"ok":false,"state":"unknown","reason":"offline"}"""),
            scheduleTestWrite("saved", scheduleTestTask(id = "other")), scheduleTestWrite("unchanged", JSONObject.NULL),
            scheduleTestRefusal("stale"), scheduleTestRefusal("ended").put("task", scheduleTestTask(id = "other")))
        for (reply in replies) {
            val result = ChatSchedules.afterWrite(writing(), reply)
            assertEquals(Phase.RECONCILING, result.phase)
            assertEquals(Op.READ, result.op)
            assertEquals(id, result.opTask)
            assertEquals(id, result.uncertain)
            assertEquals(ChatSchedules.UNCONFIRMED, result.outcome)
            assertFalse(result.canRefresh)
        }
    }

    @Test fun definiteRefusalsShowHostValidationAndSafeTransportText() {
        val replies = listOf(
            CoreError("busy", "detail") to "Too many requests at once. Try again.",
            scheduleTestRefusal("offline") to "The computer didn't answer. Nothing was changed.",
            scheduleTestRefusal("busy") to "Another request for this Bot is running. Try again.",
            scheduleTestRefusal("rate") to "Too many schedule requests. Wait a minute.",
            scheduleTestRefusal("unavailable") to "Schedules aren't available on the computer right now.",
            scheduleTestRefusal("invalid").put("message", false) to "The computer refused that."
        ) + listOf("Give the task a name", "Keep the name under 120 characters", "This task has no future occurrence.")
            .map { scheduleTestRefusal("invalid").put("message", it) to it }
        for ((reply, line) in replies) {
            val result = ChatSchedules.afterWrite(writing(), reply)
            assertEquals(Phase.READY, result.phase)
            assertNull(result.uncertain)
            assertEquals(line, result.outcome)
        }
    }

    @Test fun actionsDependOnStateGrantAndAnIdleReadyListing() {
        val states = mapOf("scheduled" to setOf("schedule.pause", "schedule.rename"), "overdue" to setOf("schedule.pause", "schedule.rename"),
            "paused" to setOf("schedule.resume", "schedule.rename"), "finished" to setOf("schedule.rename"))
        val s = ready
        val row = checkNotNull(s.listing).tasks.single()
        for ((state, methods) in states) {
            assertEquals(methods, ChatClient.SCHEDULES.filter { s.canAct(it, row.copy(state = state)) }.toSet())
        }
        assertFalse(s.copy(grants = setOf("schedule.list")).canAct("schedule.pause", row))
        assertFalse(s.copy(op = Op.READ).canAct("schedule.pause", row))
        assertFalse(s.copy(phase = Phase.READ_FAILED).canAct("schedule.pause", row))
        assertTrue(s.copy(phase = Phase.READ_FAILED).canRefresh)
    }

    @Test fun titleGuardMatchesJavaScriptWhitespaceAndCountsUtf16AfterTrimming() {
        val whitespace = "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"
        assertEquals("Give the task a name", ChatSchedules.checkTitle(whitespace))
        assertEquals("\u0085Title\u001C", ChatSchedules.trimTitle("\u0085Title\u001C"))
        assertEquals("Short", ChatSchedules.trimTitle(whitespace.repeat(1024) + "Short" + whitespace))
        assertNull(ChatSchedules.checkTitle(" ".repeat(4097) + "Short"))
        assertNull(ChatSchedules.checkTitle("\uFEFF" + "a".repeat(120)))
        assertNull(ChatSchedules.checkTitle("a".repeat(118) + "😀"))
        assertEquals("Keep the name under 120 characters", ChatSchedules.checkTitle("a".repeat(119) + "😀"))
    }

    @Test fun timingShowsThePhoneDateAndKeepsTheRuleZoneAndWallClockPrecision() {
        val row = checkNotNull(ready.listing).tasks.single()
        val zone = ZoneId.of("America/Los_Angeles")
        fun text(timing: Timing, state: String = "scheduled") = ChatSchedules.timingText(row.copy(timing = timing, state = state), zone, Locale.US)
        assertEquals("Next: Thu 19 Nov, 17:00 (America/Los_Angeles)" to "Daily at 01:00 (UTC)", text(row.timing))
        assertEquals("Overdue since Thu 19 Nov, 17:00 (America/Los_Angeles)", text(row.timing, "overdue").first)
        assertEquals("Paused (was set for Thu 19 Nov, 17:00 (America/Los_Angeles))", text(row.timing, "paused").first)
        assertEquals("Last: Thu 19 Nov, 17:00 (America/Los_Angeles)", text(row.timing, "finished").first)
        assertEquals("Next: Thu 19 Nov, 17:00", text(row.timing.copy(timeZone = zone.id)).first)
        assertEquals(null to "Daily at 12:00:45.5 (Bogus/Zone)", text(Timing("daily", "bad instant", time = "12:00:45.5", timeZone = "Bogus/Zone")))
        assertEquals("Mon, Fri at 12:00 (UTC)", text(Timing("weekly", time = "12:00:00.000", timeZone = "UTC", weekdays = listOf(1, 5))).second)
        assertEquals("Once", text(Timing("at")).second)
        assertEquals("Once, 30 seconds after it was set", text(Timing("after", afterSeconds = 30)).second)
        assertEquals("Every 2 minutes", text(Timing("every", everySeconds = 120)).second)
        assertEquals("Every 1 hour", text(Timing("every", everySeconds = 3600)).second)
        assertEquals("Every 2 days", text(Timing("every", everySeconds = 172800)).second)
        assertEquals("Every 61 seconds", text(Timing("every", everySeconds = 61)).second)
        assertEquals("Cron 0 12 * * * (UTC)", text(Timing("cron", expression = "0 12 * * *", timeZone = "UTC")).second)
        assertEquals("Cron (UTC) · Rule too long to show", text(Timing("cron", timeZone = "UTC", ruleTooLong = true)).second)
        assertEquals("Repeats: FREQ=MONTHLY", text(Timing("rrule", rrule = "FREQ=MONTHLY")).second)
        assertEquals("Repeats · Rule too long to show", text(Timing("rrule", ruleTooLong = true)).second)
        assertEquals("Custom schedule", text(Timing("future")).second)
    }

    @Test fun aResumedAfterTaskDisplaysTheReturnedAtTiming() {
        val after = scheduleTestTask(state = "paused", timing = JSONObject().put("kind", "after").put("afterSeconds", 30))
        val current = ChatSchedules.afterRead(initial, null, scheduleTestList(bot, listOf(after))).copy(op = Op.RESUME, opTask = id)
        val reply = scheduleTestWrite("saved", scheduleTestTask(rev = "new", timing = JSONObject().put("kind", "at")))
        val resumed = ChatSchedules.afterWrite(current, reply)
        val task = checkNotNull(resumed.listing).tasks.single()
        assertEquals("Resumed.", resumed.outcome)
        assertEquals("new", task.rev)
        assertEquals("Once", ChatSchedules.timingText(task, ZoneId.of("UTC"), Locale.US).second)
    }
}
