package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject

/** Memory replies belong to one Bot. The dialog keeps an acknowledged write even if reading it back fails. */
object ChatMemory {
    enum class Phase { CONNECTING, LOADING, READY, READ_FAILED, RECONCILING, CLOSED }
    enum class Op { NONE, READ, ADD, EDIT }

    data class Entry(val id: String, val rev: String, val text: String, val topic: String?, val added: String?,
                     val until: String?, val pinned: Boolean, val expired: Boolean)

    /** Each snapshot replaces the last one, so an open editor cannot keep using its old entry. */
    class Snapshot(val terminal: String, val entries: List<Entry>, val size: Int, val limit: Int, val truncated: Boolean)

    data class State(val hostId: String, val terminal: String, val token: Long, val snapshot: Snapshot? = null,
                     val confirmed: Entry? = null, val phase: Phase = Phase.CONNECTING, val op: Op = Op.NONE,
                     val outcome: String? = null, val status: String? = null, val grants: Set<String> = emptySet()) {
        fun canWrite(method: String) = phase == Phase.READY && op == Op.NONE && method in grants
        val canRefresh get() = op == Op.NONE && (phase == Phase.READY || phase == Phase.READ_FAILED)

        /** Authority ended. Drop memory content and keep the write outcome. */
        fun closed(line: String?) = copy(snapshot = null, confirmed = null, phase = Phase.CLOSED, op = Op.NONE,
            status = line, grants = emptySet())
    }

    const val SAVED = "Saved."
    const val UNCHANGED = "No change: that text is already there."
    const val UNCONFIRMED = "The computer didn't confirm this change."
    const val CHECKING = "Checking…"
    private const val BUSY = "Too many requests at once. Try again."
    private const val READ_FAILED = "Couldn't read the memory."
    private const val CHECK_FAILED = "Couldn't check the memory. Refresh to see what was saved."
    private val AUTHORITY = setOf("revoked", "read-only", "private", "global", "not-shown", "not-found")
    private val CONFLICTS = mapOf(
        "stale" to "That entry changed on the computer. Here is the current memory.",
        "gone" to "That entry is gone from the computer.",
        "ambiguous" to "That entry appears twice on the computer; edit it there."
    )

    private fun JSONObject.string(key: String) = opt(key) as? String

    private fun entry(value: Any?): Entry? {
        val row = value as? JSONObject ?: return null
        return Entry(row.string("id") ?: return null, row.string("rev") ?: return null, row.string("text") ?: return null,
            row.string("topic"), row.string("added"), row.string("until"), row.opt("pinned") == true, row.opt("expired") == true)
    }

    fun parse(memory: Any?, expectedTerminal: String): Snapshot? {
        val obj = memory as? JSONObject ?: return null
        if (obj.string("terminal") != expectedTerminal) return null
        val rows = obj.opt("entries") as? JSONArray ?: return null
        return Snapshot(expectedTerminal, (0 until rows.length()).mapNotNull { entry(rows.opt(it)) },
            (obj.opt("size") as? Number)?.toInt() ?: 0, (obj.opt("limit") as? Number)?.toInt() ?: 0, obj.opt("truncated") == true)
    }

    /** The bridge counts the bytes it receives. The host checks what can go into an entry. */
    fun checkText(text: String): String? = when {
        text.isBlank() -> "Type a memory entry first."
        text.toByteArray(Charsets.UTF_8).size > 4096 -> "That text is too long."
        else -> null
    }

    private fun reasonText(reason: String, reply: JSONObject) = when (reason) {
        "private" -> "This Bot is private: its memory stays on the computer."
        "global" -> "The Main Bot and global Bots' memory is managed on the computer."
        "not-shown" -> "This Bot's project isn't shown to the phone. Show it in Automagik first."
        "not-found" -> "This Bot isn't on the computer anymore."
        "revoked", "read-only" -> "This phone can't manage this Bot's memory now."
        "rate" -> "Too many memory requests. Wait a minute."
        "busy" -> "Another memory request for this Bot is running. Try again."
        "too-large" -> "This Bot's memory is too large to manage from the phone."
        "unavailable" -> "Memory isn't available on the computer right now."
        "offline" -> "The computer didn't answer."
        "invalid" -> reply.string("message") ?: "The computer refused that text."
        else -> "The computer refused this (${reason.asSequence().filter { it in 'a'..'z' || it in '0'..'9' || it == '-' }.take(32).joinToString("")})."
    }

    private fun readFailed(s: State, line: String) = s.copy(phase = Phase.READ_FAILED, op = Op.NONE,
        status = if (s.phase == Phase.RECONCILING || s.outcome == UNCONFIRMED) CHECK_FAILED else line) to false

    fun afterRead(s: State, result: Any?): Pair<State, Boolean> {
        val reply = result as? JSONObject
        val state = reply?.string("state")
        if (reply != null) {
            if (reply.opt("ok") == true && state == "read") {
                val snapshot = parse(reply.opt("memory"), s.terminal) ?: return readFailed(s, READ_FAILED)
                val outcome = if (s.outcome == UNCONFIRMED) "$UNCONFIRMED The list shows what the computer has now." else s.outcome
                return s.copy(snapshot = snapshot, confirmed = null, phase = Phase.READY, op = Op.NONE,
                    outcome = outcome, status = null) to false
            }
            if (reply.opt("ok") == false && state == "refused") {
                val reason = reply.string("reason") ?: "unknown"
                val line = reasonText(reason, reply)
                return if (reason in AUTHORITY) s.closed(line) to false else readFailed(s, line)
            }
        }
        return readFailed(s, if ((result as? CoreError)?.kind == "busy") BUSY else READ_FAILED)
    }

    private fun ready(s: State, outcome: String) = s.copy(phase = Phase.READY, op = Op.NONE, outcome = outcome, status = null) to false

    private fun reconcile(s: State, outcome: String) = s.copy(phase = Phase.RECONCILING, op = Op.READ,
        outcome = outcome, status = CHECKING) to true

    /** Read once when the write might have arrived or was saved without a usable snapshot. */
    fun afterWrite(s: State, op: Op, result: Any?): Pair<State, Boolean> {
        if (op != Op.ADD && op != Op.EDIT) return s to false
        if ((result as? CoreError)?.kind == "busy") return ready(s, BUSY)
        val reply = result as? JSONObject ?: return reconcile(s, UNCONFIRMED)
        val state = reply.string("state")
        if (reply.opt("ok") == true && (state == "saved" || state == "unchanged")) {
            val snapshot = parse(reply.opt("memory"), s.terminal)
            if (snapshot == null) return reconcile(s, if (state == "saved") SAVED else UNCONFIRMED)
            val confirmed = entry(reply.opt("entry"))?.takeUnless { saved -> snapshot.entries.any { it.id == saved.id && it.rev == saved.rev } }
            return ready(s.copy(snapshot = snapshot, confirmed = confirmed), if (state == "saved") SAVED else UNCHANGED)
        }
        if (reply.opt("ok") == false && state == "refused") {
            val reason = reply.string("reason") ?: "unknown"
            val conflict = CONFLICTS[reason]
            if (conflict != null) {
                val snapshot = parse(reply.opt("memory"), s.terminal)
                if (snapshot == null) return s.copy(phase = Phase.READ_FAILED, op = Op.NONE,
                    outcome = conflict, status = "Refresh to see the current memory.") to false
                return ready(s.copy(snapshot = snapshot, confirmed = null), conflict)
            }
            val line = reasonText(reason, reply)
            if (reply.opt("applied") == true) {
                val saved = "Saved on the computer, but $line"
                return if (reason in AUTHORITY) s.copy(outcome = saved).closed(null) to false else reconcile(s, saved)
            }
            if (reason == "offline") return ready(s, "$line Nothing was changed.")
            return if (reason in AUTHORITY) s.closed(line) to false else ready(s, line)
        }
        return reconcile(s, UNCONFIRMED)
    }
}
