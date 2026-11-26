package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject

/** Settings and model choices come from the same reply and share its lifetime. */
object ChatSettings {
    enum class Phase { CONNECTING, LOADING, READY, READ_FAILED, RECONCILING, CLOSED }
    enum class Op(val method: String) {
        NONE(""), READ("settings.read"), NAME("settings.name"), MODEL("settings.model")
    }

    data class Model(val saved: String?, val label: String?, val applied: String?, val running: String?,
                     val effort: String?, val runningEffort: String?)
    data class Level(val saved: String?, val inherited: Boolean, val auto: Boolean,
                     val fallback: String?, val notOffered: Boolean, val runs: String?)
    data class Editable(val name: Boolean, val model: Boolean, val reason: String?)
    data class Settings(val terminal: String, val rev: String, val name: String, val model: Model,
                        val level: Level, val editable: Editable)
    data class ModelChoice(val id: String, val label: String, val provider: String)
    data class Models(val entries: List<ModelChoice>, val truncated: Boolean)
    data class Snapshot(val settings: Settings, val models: Models)

    data class State(val hostId: String, val terminal: String, val token: Long, val snapshot: Snapshot? = null,
                     val phase: Phase = Phase.CONNECTING, val op: Op = Op.NONE, val grants: Set<String> = emptySet(),
                     val outcome: String? = null, val status: String? = null, val autoOff: Boolean = false,
                     val uncertain: Boolean = false, val notice: String? = null) {
        fun canEdit(edit: Op) = phase == Phase.READY && op == Op.NONE && !uncertain &&
            Op.READ.method in grants && edit.method in grants && when (edit) {
                Op.NAME -> snapshot?.settings?.editable?.name == true
                Op.MODEL -> snapshot?.let { it.settings.editable.model && it.models.entries.isNotEmpty() } == true
                else -> false
            }

        val canRefresh get() = op == Op.NONE && (phase == Phase.READY || phase == Phase.READ_FAILED)
        val mayHaveChanged get() = uncertain || op == Op.NAME || op == Op.MODEL

        /** Keep only the address and content-free feedback when the connection ends. */
        fun closed(status: String, outcome: String? = null) =
            State(hostId, terminal, token, phase = Phase.CLOSED, status = status, outcome = outcome, notice = notice)
    }

    const val CHECKING = "Checking…"
    const val MAY_HAVE_CHANGED = "The computer may have changed this Bot's settings. Check them on the computer."
    const val EARLIER_CHANGE = "An earlier change may have reached the computer. Check the Bot's settings there."
    const val CONNECTION_CLOSED = "The connection to the computer closed."
    const val AUTO_OFF = "Auto was turned off by the model change."
    const val EMPTY_MODELS = "The computer has no model list ready. Open the Bot's model menu on the computer, then Refresh."
    private const val BUSY = "The computer is busy. Try again in a moment."
    private const val REFUSED = "The computer refused that request."
    private const val PENDING = "The computer may not have saved this yet. Check it on the computer."
    private const val UNCONFIRMED = "The computer didn't confirm this change."
    private const val NOT_APPLIED = "The computer could not switch the Bot to that model, so it stays on its current one."
    private const val CHANGING = "Its model is changing on the computer."
    private val authority = setOf("revoked", "read-only", "not-found", "not-shown", "global", "unavailable")
    private val snapshotRefusals = setOf("stale", "computer", "changing", "unknown-model", "model-not-allowed", "not-applied")
    private val revPattern = Regex("[0-9a-f]{16}")
    private const val MAX_MODELS = 200

    fun isBot(terminal: String) = Chat.isDsh(terminal) && !Chat.isGroup(terminal) && terminal.length > Chat.DSH_PREFIX.length

    private fun JSONObject.string(key: String) = opt(key) as? String
    private fun JSONObject.bool(key: String) = opt(key) as? Boolean
    private fun JSONObject.nullableString(key: String) = opt(key).let { it === JSONObject.NULL || it is String }

    private fun levelValue(value: String?) = when (value) {
        null, "read-only", "workspace-write", "danger-full-access", "auto" -> value
        else -> "custom"
    }

    private fun parseSettings(obj: JSONObject, terminal: String): Settings? {
        if (!isBot(terminal) || obj.string("terminal") != terminal) return null
        val rev = obj.string("rev")?.takeIf(revPattern::matches) ?: return null
        val name = obj.string("name") ?: return null
        val model = obj.optJSONObject("model") ?: return null
        val level = obj.optJSONObject("level") ?: return null
        val editable = obj.optJSONObject("editable") ?: return null
        if (!listOf("saved", "label", "applied", "running", "effort", "runningEffort").all { model.nullableString(it) } ||
            !level.nullableString("saved")) return null
        if (level.has("fallback") && level.string("fallback") != "workspace-write" ||
            level.has("notOffered") && level.bool("notOffered") != true ||
            level.has("runs") && !level.nullableString("runs") ||
            editable.has("reason") && editable.string("reason") == null) return null
        return Settings(terminal, rev, name,
            Model(model.string("saved"), model.string("label")?.take(200), model.string("applied"),
                model.string("running"), model.string("effort"), model.string("runningEffort")),
            Level(levelValue(level.string("saved")), level.bool("inherited") ?: return null,
                level.bool("auto") ?: return null, level.string("fallback"), level.bool("notOffered") == true,
                levelValue(level.string("runs"))),
            Editable(editable.bool("name") ?: return null, editable.bool("model") ?: return null, editable.string("reason")))
    }

    private fun modelChoice(value: Any?): ModelChoice? {
        val entry = value as? JSONObject ?: return null
        val id = entry.string("id") ?: return null
        val slash = id.indexOf('/')
        if (slash <= 0 || slash == id.lastIndex || id.any { it.isISOControl() } ||
            id.toByteArray(Charsets.UTF_8).size !in 3..512) return null
        val label = entry.string("label")?.takeIf { it.length <= 200 } ?: return null
        val provider = entry.string("provider")?.takeIf { it.length <= 80 } ?: return null
        return ModelChoice(id, label, provider)
    }

    fun parse(reply: JSONObject, terminal: String): Snapshot? {
        val settings = reply.optJSONObject("settings")?.let { parseSettings(it, terminal) } ?: return null
        val models = reply.optJSONObject("models") ?: return null
        val rows = models.opt("entries") as? JSONArray ?: return null
        val truncated = models.bool("truncated") ?: return null
        val entries = (0 until rows.length()).asSequence().mapNotNull { modelChoice(rows.opt(it)) }
            .take(MAX_MODELS + 1).toList()
        return Snapshot(settings, Models(entries.take(MAX_MODELS), truncated || entries.size > MAX_MODELS))
    }

    // The schedules title guard uses the same ECMAScript whitespace set.
    fun trimName(name: String) = ChatSchedules.trimTitle(name)

    fun checkName(name: String): String? = when (trimName(name).length) {
        0 -> "Give the Bot a name"
        in 1..40 -> null
        else -> "Use 40 characters or fewer"
    }

    private fun levelLabel(value: String?) = when (value) {
        "read-only" -> "Read only"
        "workspace-write" -> "Workspace"
        "danger-full-access" -> "Full access"
        "auto" -> "Auto review"
        null -> "Unknown"
        else -> "Custom"
    }

    fun levelLines(level: Level): List<String> = buildList {
        add(levelLabel(level.saved) + if (level.inherited) " · the computer's default" else "")
        if (level.auto) add("Auto is on")
        if (level.fallback == "workspace-write") add("Runs as Workspace here")
        if (level.notOffered) add("This level is no longer offered on the computer.")
        if (level.runs != null && level.runs != level.saved) add("Runs as ${levelLabel(level.runs)} now")
    }

    fun autoCleared(before: Level?, after: Level) = before?.auto == true && !after.auto

    fun editableReason(reason: String?) = when (reason) {
        "greeting" -> "This Bot is still greeting; change it on the computer."
        "host-model" -> "Its plugin chooses its model on the computer."
        "shell" -> "It is waiting for a shell choice on the computer."
        "changing" -> CHANGING
        "no-model" -> "It has no model yet; choose one on the computer."
        else -> null
    }

    private fun refusalText(reason: String?) = when (reason) {
        "revoked", "read-only" -> "This phone can't manage this Bot's settings now."
        "not-found" -> "This Bot isn't on the computer anymore."
        "not-shown" -> "This Bot's project isn't shown to the phone."
        "global" -> "Settings for global Bots stay on the computer."
        "unavailable" -> "Settings aren't available on the computer right now."
        "busy", "rate" -> BUSY
        "offline" -> "The computer didn't answer."
        "too-large" -> "The settings are too large to show here."
        else -> REFUSED
    }

    private fun refusedAuthority(s: State, reply: JSONObject, reason: String?) =
        s.closed(refusalText(reason), MAY_HAVE_CHANGED.takeIf { reply.opt("applied") == true || s.uncertain })

    fun afterRead(s: State, result: Any?): State {
        val reply = result as? JSONObject
        if (reply != null && reply.bool("ok") == true && reply.string("state") == "read") {
            val snapshot = parse(reply, s.terminal)
            if (snapshot != null) return s.copy(snapshot = snapshot, phase = Phase.READY, op = Op.NONE, status = null,
                uncertain = false, autoOff = false, outcome = if (s.uncertain)
                    "$UNCONFIRMED The settings shown are what the computer has now." else null)
        }
        val refusal = reply?.takeIf { it.bool("ok") == false && it.string("state") == "refused" }
        val reason = refusal?.string("reason")
        if (refusal != null && reason in authority) return refusedAuthority(s, refusal, reason)
        val line = when {
            s.uncertain -> "Couldn't check the settings. Refresh to check again."
            refusal != null -> refusalText(reason)
            (result as? CoreError)?.kind == "busy" -> BUSY
            else -> "Couldn't read the settings."
        }
        return s.copy(phase = Phase.READ_FAILED, op = Op.NONE, status = line)
    }

    private fun reconcile(s: State) = s.copy(phase = Phase.RECONCILING, op = Op.READ, uncertain = true,
        status = CHECKING, outcome = UNCONFIRMED, autoOff = false)

    private fun ready(s: State, outcome: String) = s.copy(phase = Phase.READY, op = Op.NONE, status = null,
        outcome = outcome, uncertain = false, autoOff = false)

    fun afterWrite(s: State, result: Any?): State {
        if (s.op != Op.NAME && s.op != Op.MODEL) return s
        if ((result as? CoreError)?.kind == "busy") return ready(s, BUSY)
        val reply = result as? JSONObject ?: return reconcile(s)
        val ok = reply.bool("ok")
        val state = reply.string("state")
        val reason = reply.string("reason")
        val refused = ok == false && state == "refused"
        if (refused && reason in authority) return refusedAuthority(s, reply, reason)

        val message = reply.string("message")?.take(300)
        val pending = ok == false && (state == "unknown" || refused && reason == "pending")
        val hasSnapshot = ok == true && (state == "saved" || state == "unchanged") || pending ||
            refused && (reason in snapshotRefusals || reason == "invalid" && message != null)
        if (hasSnapshot) {
            val snapshot = parse(reply, s.terminal) ?: return reconcile(s)
            val outcome = when {
                pending -> PENDING
                state == "saved" -> "Saved."
                state == "unchanged" -> "No change."
                else -> when (reason) {
                    "stale" -> "That changed on the computer. Here is the current version."
                    "computer" -> editableReason(snapshot.settings.editable.reason) ?: "Change this on the computer."
                    "changing" -> CHANGING
                    "invalid" -> message ?: REFUSED
                    "unknown-model" -> "The computer doesn't have that model."
                    "model-not-allowed" -> "This Bot can't use that model from the phone."
                    "not-applied" -> message?.takeIf { it.isNotBlank() } ?: NOT_APPLIED
                    else -> REFUSED
                }
            }
            val modelMayHaveChangedAuto = s.op == Op.MODEL && (state == "saved" || reason == "not-applied" || pending)
            return ready(s.copy(snapshot = snapshot), outcome).copy(autoOff =
                modelMayHaveChangedAuto && autoCleared(s.snapshot?.settings?.level, snapshot.settings.level))
        }
        return when {
            refused && reason == "offline" -> ready(s, "The computer didn't answer. The change wasn't sent.")
            refused && reason in setOf("busy", "rate", "invalid", "too-large") -> ready(s, refusalText(reason))
            else -> reconcile(s)
        }
    }
}
