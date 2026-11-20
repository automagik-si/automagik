package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/** A task revision belongs to one Bot's listing. Only a selected read can unlock an unconfirmed write. */
object ChatSchedules {
    enum class Phase { CONNECTING, LOADING, READY, READ_FAILED, RECONCILING, CLOSED }
    enum class Op { NONE, READ, PAUSE, RESUME, RENAME }

    data class Timing(val kind: String, val at: String? = null, val afterSeconds: Long? = null, val everySeconds: Long? = null,
                      val time: String? = null, val timeZone: String? = null, val weekdays: List<Int>? = null,
                      val expression: String? = null, val rrule: String? = null, val ruleTooLong: Boolean = false)
    data class Task(val id: String, val rev: String, val title: String, val state: String, val timing: Timing)
    data class Listing(val terminal: String, val tasks: List<Task>, val truncated: Boolean)
    data class State(val hostId: String, val terminal: String, val token: Long, val listing: Listing? = null,
                     val phase: Phase = Phase.CONNECTING, val op: Op = Op.NONE, val opTask: String? = null,
                     val outcome: String? = null, val status: String? = null, val grants: Set<String> = emptySet(),
                     val uncertain: String? = null, val needsRefresh: Set<String> = emptySet(), val notice: String? = null) {
        fun canAct(method: String, task: Task) = phase == Phase.READY && op == Op.NONE && uncertain == null &&
            task.id !in needsRefresh && method in grants && when (method) {
                "schedule.pause" -> task.state == "scheduled" || task.state == "overdue"
                "schedule.resume" -> task.state == "paused"
                "schedule.rename" -> task.state in TASK_STATES
                else -> false
            }
        val canRefresh get() = op == Op.NONE && (phase == Phase.READY || phase == Phase.READ_FAILED)
        val mayHaveSaved get() = uncertain != null || op in WRITE_OPS

        /** Drop task data immediately when the dialog loses authority. */
        fun closed(line: String?) = copy(listing = null, phase = Phase.CLOSED, op = Op.NONE, opTask = null,
            status = line, grants = emptySet(), needsRefresh = emptySet())
    }

    const val UNCONFIRMED = "The computer didn't confirm this change."
    const val EARLIER_CHANGE = "A change you sent earlier may have been saved: check it on the computer."
    const val CHECKING = "Checking…"
    private const val BUSY = "Too many requests at once. Try again."
    private const val READ_FAILED = "Couldn't read the schedules."
    private const val CHECK_FAILED = "Couldn't check the task. Refresh to check again."
    private const val GONE = "That task is gone from the computer."
    private val AUTHORITY = setOf("revoked", "read-only", "not-shown", "not-found", "global")
    private val TASK_STATES = setOf("scheduled", "overdue", "paused", "finished")
    private val WRITE_OPS = setOf(Op.PAUSE, Op.RESUME, Op.RENAME)

    private fun JSONObject.string(key: String) = opt(key) as? String
    private fun integer(value: Any?) = (value as? Number)?.toString()?.toLongOrNull()

    private fun task(value: Any?): Task? {
        val row = value as? JSONObject ?: return null
        val state = row.string("state")?.takeIf { it in TASK_STATES } ?: return null
        val timing = row.opt("timing") as? JSONObject ?: return null
        val weekdays = (timing.opt("weekdays") as? JSONArray)?.let { days ->
            (0 until days.length()).mapNotNull { integer(days.opt(it))?.takeIf { day -> day in 1L..7L }?.toInt() }
        }
        return Task(row.string("id") ?: return null, row.string("rev") ?: return null, row.string("title") ?: return null, state,
            Timing(timing.string("kind") ?: return null, timing.string("at"), integer(timing.opt("afterSeconds")),
                integer(timing.opt("everySeconds")), timing.string("time"), timing.string("timeZone"), weekdays,
                timing.string("expression"), timing.string("rrule"), timing.opt("ruleTooLong") == true))
    }

    fun parse(schedules: Any?, expectedTerminal: String): Listing? {
        val obj = schedules as? JSONObject ?: return null
        if (obj.string("terminal") != expectedTerminal) return null
        val rows = obj.opt("tasks") as? JSONArray ?: return null
        return Listing(expectedTerminal, (0 until rows.length()).mapNotNull { task(rows.opt(it)) }, obj.opt("truncated") == true)
    }

    /** Match the host's trim and UTF-16 length before measuring the bytes Pocket Link receives. */
    fun trimTitle(title: String) = title.trim {
        it in '\u0009'..'\u000D' || it in '\u2000'..'\u200A' ||
            it in "\u0020\u00A0\u1680\u2028\u2029\u202F\u205F\u3000\uFEFF"
    }

    fun checkTitle(title: String): String? = trimTitle(title).let {
        when {
            it.isEmpty() -> "Give the task a name"
            it.length > 120 || it.toByteArray(Charsets.UTF_8).size > 4096 -> "Keep the name under 120 characters"
            else -> null
        }
    }

    private fun reasonText(reason: String, reply: JSONObject) = when (reason) {
        "revoked", "read-only" -> "This phone can't manage this Bot's schedules now."
        "not-shown" -> "This Bot's project isn't shown to the phone. Show it in Automagik first."
        "not-found" -> "This Bot isn't on the computer anymore."
        "global" -> "The Main Bot and global Bots' schedules are managed on the computer."
        "busy" -> "Another request for this Bot is running. Try again."
        "rate" -> "Too many schedule requests. Wait a minute."
        "unavailable" -> "Schedules aren't available on the computer right now."
        "offline" -> "The computer didn't answer."
        "gone" -> GONE
        "stale" -> "That task changed on the computer. Here is the current version."
        "ended" -> "That task has finished."
        "ambiguous" -> "That task appears twice on the computer; change it there."
        "invalid" -> reply.string("message") ?: "The computer refused that."
        else -> "The computer refused that."
    }

    private fun Listing.withTask(row: Task): Listing {
        val index = tasks.indexOfFirst { it.id == row.id }
        return copy(tasks = if (index < 0) tasks + row else tasks.toMutableList().apply { set(index, row) })
    }

    private fun State.withoutTask(id: String) = copy(listing = listing?.let { it.copy(tasks = it.tasks.filterNot { row -> row.id == id }) },
        needsRefresh = needsRefresh - id)

    private fun readFailed(s: State, line: String) = s.copy(phase = Phase.READ_FAILED, op = Op.NONE, opTask = null,
        status = if (s.uncertain != null) CHECK_FAILED else line)

    fun afterRead(s: State, id: String?, result: Any?): State {
        val reply = result as? JSONObject
        val selected = id?.takeIf { it == s.uncertain }
        if (reply != null && reply.opt("ok") == true && reply.string("state") == "read") {
            val listing = parse(reply.opt("schedules"), s.terminal) ?: return readFailed(s, READ_FAILED)
            val next = s.copy(listing = listing, phase = Phase.READY, op = Op.NONE, opTask = null, status = null,
                needsRefresh = s.needsRefresh - listing.tasks.map { it.id }.toSet())
            if (selected == null) return next
            if (reply.opt("task") === JSONObject.NULL) return next.withoutTask(selected).copy(status = "That task is no longer available.")
            val row = task(reply.opt("task"))?.takeIf { it.id == selected } ?: return readFailed(s, READ_FAILED)
            val outcome = s.outcome ?: UNCONFIRMED
            return next.copy(listing = listing.withTask(row), uncertain = null, needsRefresh = next.needsRefresh - selected,
                outcome = "$outcome The list shows what the computer has now.")
        }
        if (reply != null && reply.opt("ok") == false && reply.string("state") == "refused") {
            val reason = reply.string("reason") ?: "unknown"
            val line = reasonText(reason, reply)
            if (reason in AUTHORITY) return s.closed(line)
            if (reason == "gone" && selected != null) return s.withoutTask(selected).copy(phase = Phase.READY,
                op = Op.NONE, opTask = null, status = line)
            return readFailed(s, line)
        }
        return readFailed(s, if ((result as? CoreError)?.kind == "busy") BUSY else READ_FAILED)
    }

    private fun ready(s: State, outcome: String) =
        s.copy(phase = Phase.READY, op = Op.NONE, opTask = null, outcome = outcome, status = null)

    private fun reconcile(s: State, id: String) = s.copy(phase = Phase.RECONCILING, op = Op.READ, opTask = id,
        uncertain = id, outcome = UNCONFIRMED, status = CHECKING)

    /** Acknowledged writes replace the full row. Missing acknowledgments ask for one selected read. */
    fun afterWrite(s: State, result: Any?): State {
        val id = s.opTask ?: return s
        val saved = when (s.op) {
            Op.PAUSE -> "Paused."
            Op.RESUME -> "Resumed."
            Op.RENAME -> "Renamed."
            else -> return s
        }
        if ((result as? CoreError)?.kind == "busy") return ready(s, BUSY)
        val reply = result as? JSONObject ?: return reconcile(s, id)
        val state = reply.string("state")
        val row = task(reply.opt("task"))?.takeIf { it.id == id }
        val updated = if (row == null) s else s.copy(listing = s.listing?.withTask(row), needsRefresh = s.needsRefresh - id)
        if (reply.opt("ok") == true && row != null && (state == "saved" || state == "unchanged"))
            return ready(updated, if (state == "saved") saved else "No change.")
        if (reply.opt("ok") == false && state == "refused") {
            val reason = reply.string("reason").orEmpty()
            val line = reasonText(reason, reply)
            if (reply.opt("applied") == true) {
                val outcome = "Saved on the computer, but $line"
                return when {
                    reason in AUTHORITY -> s.copy(outcome = outcome).closed(null)
                    reason == "gone" -> ready(s.withoutTask(id), outcome)
                    row == null -> ready(s.copy(needsRefresh = s.needsRefresh + id), outcome)
                    else -> ready(updated, outcome)
                }
            }
            return when (reason) {
                "" -> reconcile(s, id)
                in AUTHORITY -> s.closed(line)
                "stale", "ended" -> if (row == null) reconcile(s, id) else ready(updated, line)
                "gone" -> ready(s.withoutTask(id), line)
                "offline" -> ready(s, "$line Nothing was changed.")
                else -> ready(s, line)
            }
        }
        return reconcile(s, id)
    }

    private val minute = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT)
    private fun wallTime(time: String): String {
        val parsed = runCatching { LocalTime.parse(time) }.getOrNull() ?: return time
        return if (parsed.second == 0 && parsed.nano == 0) parsed.format(minute) else time
    }

    private fun duration(seconds: Long): String {
        val (unit, size) = when {
            seconds != 0L && seconds % 86400 == 0L -> "day" to 86400
            seconds != 0L && seconds % 3600 == 0L -> "hour" to 3600
            seconds != 0L && seconds % 60 == 0L -> "minute" to 60
            else -> "second" to 1
        }
        val count = seconds / size
        return "$count $unit${if (count == 1L) "" else "s"}"
    }

    /** The instant uses the phone zone, while the recurring rule keeps the zone it was set in. */
    fun timingText(task: Task, phoneZone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): Pair<String?, String> {
        val t = task.timing
        val instant = t.at?.let { at -> runCatching {
            Instant.parse(at).atZone(phoneZone).format(DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", locale)) +
                (if (t.timeZone != null && t.timeZone != phoneZone.id) " (${phoneZone.id})" else "")
        }.getOrNull() }?.let {
            when (task.state) {
                "scheduled" -> "Next: $it"
                "overdue" -> "Overdue since $it"
                "paused" -> "Paused (was set for $it)"
                "finished" -> "Last: $it"
                else -> null
            }
        }
        val zone = t.timeZone?.let { " ($it)" }.orEmpty()
        val time = t.time?.let { " at ${wallTime(it)}" }.orEmpty()
        val rule = when (t.kind) {
            "at" -> "Once"
            "after" -> t.afterSeconds?.let { "Once, ${duration(it)} after it was set" } ?: "Once"
            "every" -> t.everySeconds?.let { "Every ${duration(it)}" } ?: "Repeats"
            "daily" -> "Daily$time$zone"
            "weekly" -> {
                val days = t.weekdays.orEmpty().filter { it in 1..7 }
                    .joinToString(", ") { DayOfWeek.of(it).getDisplayName(TextStyle.SHORT, locale) }
                "${days.ifEmpty { "Weekly" }}$time$zone"
            }
            "cron" -> if (t.ruleTooLong) "Cron$zone · Rule too long to show"
                else "Cron${t.expression?.let { " $it" }.orEmpty()}$zone"
            "rrule" -> if (t.ruleTooLong) "Repeats$zone · Rule too long to show" else t.rrule?.let { "Repeats: $it" } ?: "Repeats"
            else -> "Custom schedule"
        }
        return instant to rule
    }
}
