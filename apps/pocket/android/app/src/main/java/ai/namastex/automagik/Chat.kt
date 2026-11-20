package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject

/**
 * The phone's half of the live chat (RFC 0015 delivery 5): what Pocket Link's `herdr-pocket/chat/1`
 * route sends (herdr/mods/pocket-link/bridge/chat.mjs, chat/engine.js), folded into one state, and
 * the one place that decides which buttons a chat shows ([ChatActions]).
 *
 * Rows live only here, in memory: never in preferences, Room or the log (docs/privacy.md).
 */
object Chat {
    /**
     * An Automagik Bot's chat (bots-dsh, dsh-source.mjs): read only on the phone unless the bridge's hello says
     * `dshWrite: true` (RFC 0015, Amendments 2026-11-07).
     */
    const val DSH_PREFIX = "dsh:"
    const val ANSWER_ON_COMPUTER = "Answer on the computer"
    const val ANSWER_IN_TERMINAL = "Answer in the terminal"
    /** A key sent, but the prompt was still there when read back: never shown as answered. */
    const val NOT_TAKEN = "Not taken: answer on the Mac."
    const val UPDATE_LINK = "Update Pocket Link on this computer for chat"
    const val DRAFT_WARNING = "Sends your half-typed terminal text with it"
    const val NO_CHAT = "This terminal has no chat. Herdr shows Claude, Codex and omp terminals as chats."
    /** Programs the bridge reads as chats (chat/find.js `APPS`), as herdr-core names them. */
    private val AGENTS = setOf("claude-code", "claude", "codex", "omp")
    /** Rows kept per open chat; older ones come back with Load earlier. */
    const val MAX_ROWS = 1000
    /** Receipts kept per chat until dismissed: as many as bots-dsh keeps settled per Session (pocket-chat.js `KEEP_SETTLED`). */
    const val MAX_RECEIPTS = 16
    /** Request ids whose end the phone knows, kept so a reconnect never receipts one twice. */
    const val MAX_DONE = 64
    /** A card that was open when the phone left and is neither open nor in `settled[]` on reconnect: no outcome is claimed. */
    const val CLOSED_AWAY = "Closed while you were away"

    /** A tool output preview the bridge cuts at 8 KiB (rows.js `OUTPUT_PREVIEW`), then adds one "…" and sets no flag. */
    const val OUTPUT_PREVIEW = 8 * 1024
    const val CUT_NOTE = "Cut here: open in the terminal for the rest."
    /** A Bot chat has no terminal to open: its rest stays on the computer. */
    const val CUT_NOTE_DSH = "Cut here: the rest stays in the chat on the computer."

    /**
     * The note under a row the bridge cut: a text row's own `cut` flag (64 KiB), or a tool result longer than the
     * preview (the bridge sets no flag there: only a cut output is longer than [OUTPUT_PREVIEW]); null otherwise.
     */
    fun cutNote(row: Row, dsh: Boolean = false): String? {
        val note = if (dsh) CUT_NOTE_DSH else CUT_NOTE
        return when (row.kind) {
            "text" -> if (row.cut) note else null
            "tool-result" -> if (row.cut || row.output.length > OUTPUT_PREVIEW) note else null
            else -> null
        }
    }

    /** An Automagik Bot's chat: no terminal pane, approvals answered as DSH raised them. */
    fun isDsh(terminal: String) = terminal.startsWith(DSH_PREFIX)

    /** Whether the phone refuses writes on [terminal]: a DSH chat, on a bridge that did not say `dshWrite: true`. */
    fun readOnly(terminal: String, dshWrite: Boolean = false) = isDsh(terminal) && !dshWrite

    /** A terminal worth offering a Chat tab: the program the bridge decodes runs in it (find.js `agentOf`). */
    fun offered(t: CoreTerminal?): Boolean {
        if (t == null || !t.live) return false
        return listOf(t.app, t.argv.firstOrNull().orEmpty().substringAfterLast('/'), t.agent).any { it.lowercase() in AGENTS }
    }

    data class Row(
        val id: String, val kind: String, val source: String = "", val turn: Long = 0,
        val role: String = "", val text: String = "", val tool: String = "", val summary: String = "",
        val input: String = "", val output: String = "", val ok: Boolean = true, val call: String = "",
        val choices: List<String> = emptyList(), val open: Boolean = false, val answerable: Boolean = true,
        val prompt: String = "", val cut: Boolean = false, val why: String = "", val state: String = "", val msg: String = "",
        /** A question's option labels, in order (option 1 first), and whether several can be picked. */
        val options: List<String> = emptyList(), val multi: Boolean = false,
        /** An assistant text row whose turn was interrupted (bots-dsh pocket-chat.js rowsOf): it reads [STOPPED]. */
        val interrupted: Boolean = false,
        val blocks: List<Attach.Block>? = null
    ) {
        companion object {
            fun parse(j: JSONObject?): Row? {
                if (j == null) return null
                val id = j.optString("id").takeIf { it.isNotEmpty() } ?: return null
                fun s(k: String) = if (j.isNull(k)) "" else j.optString(k, "")
                return Row(id, s("kind"), s("source"), j.optLong("turn", 0), s("role"), s("text"), s("tool"), s("summary"),
                    s("input"), s("output"), j.optBoolean("ok", true), s("call"), j.optJSONArray("choices").strings(),
                    j.optBoolean("open", false), j.optBoolean("answerable", true), s("prompt"), j.optBoolean("cut", false),
                    s("why"), s("state"), s("msg"), j.optJSONArray("options").strings(), j.optBoolean("multi", false),
                    j.opt("interrupted") == true, Attach.blocks(j.opt("blocks")))
            }
        }
    }

    data class Status(val state: String = "idle", val kind: String = "", val msg: String = "") {
        companion object {
            fun parse(j: JSONObject?) = if (j == null) null else Status(j.optString("state", "idle"), if (j.isNull("kind")) "" else j.optString("kind"), j.optString("msg"))
        }
    }

    /**
     * A message this phone wrote, by its own id: sending, sent, queued, held (with why), refused, or maybe not sent
     * ("maybe": no answer seen; Retry sends the same id, which the bridge or bots-dsh takes at most once).
     */
    data class Message(val id: String, val text: String, val state: String, val why: String = "", val reason: String = "")

    /**
     * A chat.list row. [shown]: false when bots-dsh lists a project Bot whose project has no yes in `shown[]` (RFC 0015
     * `:751-755`); a row without the field (an older bots-dsh, which serves every Bot) is shown.
     * [registryId]: the registry Bot's `b-...` id bots-dsh serves beside the Session id (#672);
     * null when it has none or an older bots-dsh leaves the field out. [terminal] stays
     * `dsh:<sessionId>`, the chat's one id.
     */
    data class Terminal(val terminal: String, val machine: String, val agent: String, val title: String, val status: String, val chat: String,
                        val shown: Boolean = true, val registryId: String? = null,
                        /** The rest of the row's status (bots-dsh pocket-chat.js `statusOf`): a blocked chat's kind (permission or
                         *  question), its line (what is asked, or where to answer), and the Session's turn as bots-dsh counts it. */
                        val kind: String = "", val msg: String = "", val turn: Long = 0) {
        /** An Automagik Bot's chat (listed by bots-dsh), not a terminal's. */
        val dsh: Boolean get() = isDsh(terminal)
        companion object {
            fun parse(j: JSONObject): Terminal {
                val status = j.optJSONObject("status")
                return Terminal(j.optString("terminal"), if (j.isNull("machine")) "" else j.optString("machine"),
                    j.optString("agent"), j.optString("title"), status?.optString("state").orEmpty(), j.optString("chat"),
                    j.opt("shown") != false,
                    (j.opt("registryId") as? String)?.takeIf { it.isNotBlank() },
                    status?.clean("kind").orEmpty(), status?.clean("msg").orEmpty(), status?.optLong("turn", 0) ?: 0)
            }
        }
    }

    /** An approval or question card the phone showed open and has not seen close: its kind and what it asked. */
    data class Card(val id: String, val kind: String, val label: String)

    /**
     * A card that closed while the phone was away (RFC 0015, "Settled requests on reconnect"; #733): bots-dsh's settled
     * entry for the request (`{id, by, name?, outcome, at}`, pocket-chat.js `hold`), or, with none (older than the 16
     * kept, or bots-dsh restarted), the closing alone with no outcome claimed. It stays until dismissed. [label] is
     * what the card asked, when the phone saw it. [at] is bots-dsh's clock for a settled entry, the phone's otherwise.
     */
    data class Receipt(val id: String, val kind: String, val label: String = "", val by: String = "", val name: String = "",
                       val outcome: String = "", val at: Long = 0) {
        /** bots-dsh said how it ended; false for a card that only vanished. */
        val settled: Boolean get() = outcome.isNotEmpty()
    }

    data class State(
        val terminal: String, val rows: List<Row> = emptyList(), val screen: List<Row> = emptyList(),
        val status: Status = Status(), val approval: Row? = null, val question: Row? = null,
        val messages: List<Message> = emptyList(), val connected: Boolean = false, val error: String? = null,
        /** A short answer to the last action ("The question changed; nothing was pressed"). */
        val notice: String? = null,
        /** The terminal ended, or the chat closed for good. */
        val gone: Boolean = false,
        /** herdr-core went away: the last rows stay, greyed, and nothing is sent. */
        val offline: Boolean = false,
        /** No transcript found: history appears once it is. */
        val screenOnly: Boolean = false,
        val more: Boolean = true,
        /** The bridge's hello said `dshWrite: true`: a DSH chat takes send, answer and interrupt. */
        val dshWrite: Boolean = false,
        /** A DSH chat whose bots-dsh socket went away ([RESUMABLE]): the phone connects again by itself. */
        val resuming: Boolean = false,
        /** The cards this DSH chat showed open and has not seen close: what a reconnect's receipt names ([carry]). */
        val cards: List<Card> = emptyList(),
        /** Receipts for cards that closed while the phone was away, oldest first, until dismissed ([MAX_RECEIPTS]). */
        val receipts: List<Receipt> = emptyList(),
        /** Request ids whose end the phone already knows (closed in view, receipted, or settled before the chat opened). */
        val done: List<String> = emptyList(),
        /** A snapshot has been folded in: the next one is a reconnect, and what settled since gets a receipt. */
        val synced: Boolean = false
    ) {
        val readOnly: Boolean get() = Chat.readOnly(terminal, dshWrite)
        val dsh: Boolean get() = isDsh(terminal)
        /** Where a resubscribe resumes: the newest transcript row. */
        val cursor get() = rows.lastOrNull()?.id
        val oldest get() = rows.firstOrNull()?.id
    }

    /**
     * One event from a subscription's stream (chat.mjs `event`), folded into [s]. Unknown events change nothing. [now]
     * dates a receipt for a card that vanished with no settled entry.
     */
    fun reduce(s: State, e: JSONObject, now: Long = System.currentTimeMillis()): State = when (e.optString("type")) {
        "snapshot" -> {
            val rows = e.optJSONArray("rows").rows()
            val kept = if (e.optBoolean("reset")) rows else merge(s.rows, rows)
            val approval = Row.parse(e.optJSONObject("approval"))?.takeIf { it.open }
            val question = Row.parse(e.optJSONObject("question"))?.takeIf { it.open }
            reconnected(s, approval, question, e.optJSONArray("settled"), now).copy(rows = kept.takeLast(MAX_ROWS), screen = e.optJSONArray("screen").rows(),
                status = Status.parse(e.optJSONObject("status")) ?: s.status,
                approval = approval, question = question,
                messages = held(s.messages, e.optJSONArray("held")), connected = true, gone = false, offline = false, error = null,
                resuming = false, synced = true)
        }
        "rows" -> s.copy(rows = merge(s.rows, e.optJSONArray("rows").rows()).takeLast(MAX_ROWS))
        "screen" -> s.copy(screen = e.optJSONArray("rows").rows())
        "status" -> {
            val js = e.optJSONObject("status")
            val blocked = js?.optString("state") == "blocked"
            s.copy(status = Status.parse(js) ?: s.status, question = s.question.takeIf { blocked },
                cards = s.cards.filterNot { !blocked && it.kind == "question" })
        }
        "source" -> s.copy(screenOnly = e.optString("source") == "none")
        "approval" -> Row.parse(e.optJSONObject("row")).let { r -> card(s.copy(approval = r?.takeIf { it.open }), r) }
        "question" -> Row.parse(e.optJSONObject("row")).let { r -> card(s.copy(question = r), r) }
        "held" -> message(s, e.optString("id")) { it.copy(state = "held", why = e.optString("why")) }
        "sent" -> message(s, e.optString("id")) { it.copy(state = e.optString("state", "sent").ifBlank { "sent" }, why = "") }
        "sending" -> message(s, e.optString("id")) { it.copy(state = "sending", why = "") }
        "matched" -> s.copy(messages = s.messages.filterNot { it.id == e.optString("id") })
        "cancelled" -> s.copy(messages = s.messages.filterNot { it.id == e.optString("id") })
        "gone" -> gone(s, e.optString("reason"))
        "offline" -> s.copy(offline = true, approval = null, question = null)
        else -> s
    }

    /**
     * What a snapshot of a DSH chat says about the cards the phone had ([State.cards]) and bots-dsh's `settled[]`
     * (RFC 0015, "Settled requests on reconnect"). A settled entry is only ever a receipt: it never opens a card, and
     * one for the card the snapshot shows open is left alone. The first snapshot of a chat takes `settled[]` as history
     * (nothing is receipted); every later one is a reconnect, and each entry the phone has not seen end gets one receipt.
     * A card that is neither open nor settled closes as [CLOSED_AWAY]. An id is receipted once, however many reconnects.
     */
    private fun reconnected(s: State, approval: Row?, question: Row?, settled: JSONArray?, now: Long): State {
        if (!s.dsh) return s
        val live = listOfNotNull(approval, question)
        val liveIds = live.map { it.id }.toSet()
        val done = s.done.toMutableList()
        val fresh = mutableListOf<Receipt>()
        for (i in 0 until (settled?.length() ?: 0)) {
            val r = settled?.optJSONObject(i) ?: continue
            val id = r.optString("id").takeIf { it.isNotEmpty() } ?: continue
            if (id in done || id in liveIds) continue
            done += id
            if (!s.synced) continue
            val card = s.cards.find { it.id == id }
            fresh += Receipt(id, card?.kind ?: kindOf(id), card?.label.orEmpty(), r.clean("by"), r.clean("name"), r.clean("outcome"),
                r.optLong("at", 0).takeIf { it > 0 } ?: now)
        }
        for (card in s.cards) if (card.id !in liveIds && card.id !in done) { done += card.id; fresh += Receipt(card.id, card.kind, card.label, at = now) }
        return s.copy(cards = live.map(::cardOf), done = done.takeLast(MAX_DONE), receipts = (s.receipts + fresh).takeLast(MAX_RECEIPTS))
    }

    /**
     * An approval or question event on a DSH chat: an open row is a card the phone has; a closed one is done. An open row
     * the snapshot did not carry (a question, or a second approval) says the card was not closed while the phone was
     * away after all: the reconnect's guess, its receipt and the done entry go with it.
     */
    private fun card(s: State, r: Row?): State = when {
        r == null || !s.dsh -> s
        r.open -> s.copy(cards = (s.cards.filterNot { it.id == r.id } + cardOf(r)).takeLast(MAX_RECEIPTS),
            done = s.done.filterNot { it == r.id }, receipts = s.receipts.filterNot { it.id == r.id })
        else -> s.copy(cards = s.cards.filterNot { it.id == r.id }, done = (s.done.filterNot { it == r.id } + r.id).takeLast(MAX_DONE))
    }

    private fun cardOf(r: Row) = Card(r.id, r.kind, labelOf(r))

    /** What a card asks: the approval's tool and reason, or the question. */
    fun labelOf(r: Row): String = if (r.kind == "question") r.prompt else listOf(r.tool, r.summary).filter { it.isNotBlank() }.distinct().joinToString(": ")

    /** A request's kind from bots-dsh's row id (`…#approval-<call>`, `…#question-<call>`, pocket-chat.js `requestRowId`). */
    private fun kindOf(id: String) = when { "#question-" in id -> "question"; "#approval-" in id -> "approval"; else -> "request" }

    /** The receipt [id] dismissed: gone for good, since its id stays known ([State.done]). */
    fun dismissReceipt(s: State, id: String) = s.copy(receipts = s.receipts.filterNot { it.id == id })

    /**
     * What a reconnect of the same chat keeps of [s] beside [unknown]: the cards it showed (so a reconnect can say
     * what closed), its receipts, the request ids it knows ended, and that it had a snapshot (so the next is a reconnect).
     */
    fun carry(s: State?, into: State): State = if (s == null) into else into.copy(cards = s.cards, receipts = s.receipts, done = s.done, synced = s.synced)

    /** A receipt's heading: the Bot, the kind of card and when it closed (as [time] renders [Receipt.at]). */
    fun receiptHeading(r: Receipt, bot: String, time: String): String =
        listOf(bot, when (r.kind) { "approval" -> "Approval"; "question" -> "Question"; else -> "Request" }, time).filter { it.isNotBlank() }.joinToString(" · ")

    /** What a receipt says happened while the phone was away; never more than bots-dsh's entry holds. */
    fun receiptText(r: Receipt): String = when {
        !r.settled -> CLOSED_AWAY
        r.outcome == "withdrawn" -> "No longer needed"
        else -> "Answered${whereOf(r.by, r.name)} while you were away" + outcomeOf(r.outcome).let { if (it.isNotEmpty()) ": $it" else "" }
    }

    /** A settled receipt as Home's Done line ([receiptLine]'s words); null for a card that only vanished. */
    fun doneLine(r: Receipt): String? = when {
        !r.settled -> null
        r.outcome == "withdrawn" -> "No longer needed"
        else -> "Answered${whereOf(r.by, r.name)}" + outcomeOf(r.outcome).let { if (it.isNotEmpty()) ": $it" else "" }
    }

    private fun outcomeOf(o: String) = when (o) { "allow" -> "Allow"; "deny" -> "Deny"; else -> o }
    private fun whereOf(by: String, name: String) = when (by) {
        "phone" -> " on the phone" + name.takeIf { it.isNotBlank() }?.let { " ($it)" }.orEmpty()
        "computer" -> " on the computer"
        else -> ""
    }

    /** The mark on an assistant row whose turn was interrupted. */
    const val STOPPED = "Stopped"
    /** A DSH chat coming back by itself after its bots-dsh socket went away. */
    const val RESUMING = "Automagik on the computer stopped answering. Reconnecting…"
    /** A DSH chat that did not come back within [RESUME_DELAYS_MS]: the Reconnect button stays. */
    const val NOT_ANSWERING = "Automagik on the computer isn’t answering. Reconnect once it is back."
    /** Waits before each automatic reconnect of a DSH chat, about a minute in all; then the person reconnects. */
    val RESUME_DELAYS_MS = listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 30_000L)

    /**
     * Why a DSH chat's stream ended that a new connection can come back from. `unavailable`, `timeout`: the bridge lost
     * the bots-dsh socket (dsh-source.mjs `onClose`, or a subscribe it could not make); `closed`: bots-dsh shut down
     * (pocket-chat.js `close`, a restart); `moved`, `ended`: the Bot's Session moved on or its follow ended. The
     * `dsh:` terminal names the Bot, so the next subscribe follows its current Session, or says why it can't.
     */
    val RESUMABLE = setOf("unavailable", "timeout", "closed", "moved", "ended")
    fun resumable(s: State, reason: String) = s.dsh && reason in RESUMABLE

    /** The wait before automatic reconnect [attempt] (0 first), or null: no more, the person reconnects. */
    fun resumeDelayMs(attempt: Int): Long? = RESUME_DELAYS_MS.getOrNull(attempt)

    /**
     * A `gone` event. On a DSH chat a [RESUMABLE] reason keeps the chat: what was sending becomes "maybe" (Retry sends
     * the same id, which bots-dsh takes at most once) and the phone reconnects. Anything else ends the chat, with the
     * reason in words where bots-dsh gave one.
     */
    private fun gone(s: State, reason: String): State =
        if (resumable(s, reason)) s.copy(connected = false, resuming = true, error = RESUMING, approval = null, question = null,
            messages = s.messages.map { if (it.state == "sending") it.copy(state = "maybe") else it })
        else s.copy(gone = true, connected = false, resuming = false, approval = null, question = null,
            error = if (s.dsh) goneWhy(reason) ?: s.error else s.error)

    /** A DSH subscribe bots-dsh refused (pocket-socket.js `subscribe`), in words; null for an end with no reason. */
    private fun goneWhy(reason: String): String? = when (reason) {
        "not-shown" -> "Show this project in Automagik first."
        "not-found" -> "This Bot is no longer on the computer."
        "too-many", "too_many" -> "Too many Bot chats are open on the computer. Close one and reconnect."
        "" -> null
        else -> "This chat closed ($reason)."
    }

    /** Older rows from chat.backfill, before what is shown; none left means no more. */
    fun earlier(s: State, page: JSONArray?): State {
        val older = page.rows().filter { r -> s.rows.none { it.id == r.id } }
        return s.copy(rows = (older + s.rows).take(MAX_ROWS), more = older.isNotEmpty())
    }

    /**
     * The answer to chat.send (or sendHeld) for message [id]. On a DSH chat `offline` is a socket that did not
     * answer in time, so the prompt may have gone: "maybe", never a plain refusal or a success.
     */
    fun answered(s: State, id: String, text: String, answer: JSONObject): State {
        val state = answer.optString("state")
        if (state == "refused" && s.dsh && answer.optString("reason") == "offline") return unanswered(s, id, text)
        if (state == "refused") return s.copy(messages = upsert(s.messages, Message(id, text, "refused", reason = answer.optString("reason"))))
        return s.copy(messages = upsert(s.messages, (s.messages.find { it.id == id } ?: Message(id, text, state))
            .let { m -> if (m.state == "sending" && state == "sent" && !s.dsh) m else m.copy(state = state.ifBlank { "sent" }, why = answer.optString("why")) }))
    }

    /** An answer the phone sent and did not see answered: tapping again sends the same one, taken at most once. */
    const val ANSWER_MAYBE = "Maybe not sent. Tap it again: it is answered at most once."

    /**
     * What the chat says after an approval tap (chat.answer's answer, approve.js reasons, or on a [dsh] chat the
     * bots-dsh socket's refusals passed through by the bridge); null for a plain success.
     */
    fun answerNotice(a: JSONObject, dsh: Boolean = false): String? = when {
        a.optString("reason") == "read-only" -> ANSWER_ON_COMPUTER
        a.optBoolean("ok") -> if (a.optString("pressed") == "uncertain") NOT_TAKEN else null
        dsh -> when (a.optString("reason")) {
            "settled" -> receipt(a.optJSONObject("receipt"))
            "changed" -> "The question changed; nothing was answered."
            "offline" -> ANSWER_MAYBE
            "busy" -> "Still answering the last tap."
            "rate" -> "Too many taps. Wait a moment."
            "not-shown" -> "Show this project in Automagik first."
            "not-watching" -> "This chat moved on. Reopen it."
            "text-on-approval", "invalid" -> "Not answered: that answer doesn't fit. $ANSWER_ON_COMPUTER."
            "empty" -> "Type an answer first."
            "too-long" -> "That answer is too long."
            else -> "Not answered. $ANSWER_ON_COMPUTER."
        }
        else -> when (a.optString("reason")) {
            "changed" -> "The question changed; nothing was pressed."
            "closed", "no-such-row" -> "That question is already closed."
            "answered" -> "Already answered."
            "stopped" -> "Stopped partway: the question moved on. Finish in the terminal."
            "in-flight" -> "Still answering the last tap."
            else -> "Not answered. $ANSWER_IN_TERMINAL."
        }
    }

    /**
     * What the chat says after an interrupt: sent, refused (a DSH chat passes the socket's reason through), or not
     * confirmed when no answer came or the socket did not answer in time (never repeated by itself).
     */
    fun interruptNotice(a: JSONObject?, dsh: Boolean): String = when {
        a?.optBoolean("ok") == true -> "Interrupt sent."
        a != null && dsh && a.optString("reason") !in setOf("", "offline") -> "Interrupt not sent: ${answerNotice(a, dsh = true)}"
        else -> "Interrupt not confirmed. Check the ${if (dsh) "computer" else "terminal"}."
    }

    /** Who answered a request first (bots-dsh's settled entry); never more than it says. */
    private fun receipt(r: JSONObject?): String {
        if (r == null) return "Already answered."
        if (r.optString("outcome") == "withdrawn") return "No longer needed."
        val outcome = outcomeOf(r.optString("outcome"))
        return "Already answered" + whereOf(r.clean("by"), r.clean("name")) + (if (outcome.isNotEmpty()) ": $outcome." else ".")
    }

    /** A send that got no answer (the link dropped, or it timed out): never sent again by itself, shown with Retry. */
    fun unanswered(s: State, id: String, text: String) = s.copy(messages = upsert(s.messages, Message(id, text, "maybe")))

    /**
     * [list] with [terminal]'s state as the open chat last said it, so Team's bubble and Home's rows agree with the
     * chat between two chat.list reads: its state and kind, and as its line what the chat waits on ([question], the
     * open card's text) while it is blocked, else nothing. The same list when nothing changes.
     */
    fun withStatus(list: List<Terminal>, terminal: String, status: Status, question: String = ""): List<Terminal> {
        val state = status.state
        if (state.isBlank()) return list
        val msg = if (state == "blocked") question.ifBlank { list.find { it.terminal == terminal }?.msg.orEmpty() } else ""
        if (list.none { it.terminal == terminal && (it.status != state || it.kind != status.kind || it.msg != msg) }) return list
        return list.map { if (it.terminal == terminal) it.copy(status = state, kind = status.kind, msg = msg) else it }
    }

    /** The open card's text, for the chat's row on Home: the question, or the approval's tool and reason. */
    fun asked(s: State): String = s.question?.prompt?.takeIf { it.isNotBlank() } ?: s.approval?.let(::labelOf).orEmpty()

    /**
     * The closing row's receipt (bots-dsh's settled entry on an approval or question event), as Home's Done line:
     * who answered and what. Null for a row with no receipt.
     */
    fun receiptLine(e: JSONObject): String? {
        if (e.optString("type") !in setOf("approval", "question")) return null
        val row = e.optJSONObject("row") ?: return null
        if (row.optBoolean("open", false)) return null
        val r = row.optJSONObject("receipt") ?: return null
        if (r.optString("outcome") == "withdrawn") return "No longer needed"
        val outcome = outcomeOf(r.optString("outcome"))
        return "Answered" + whereOf(r.clean("by"), r.clean("name")) + (if (outcome.isNotEmpty()) ": $outcome" else "")
    }

    /** What a reconnect keeps of [s]: messages whose outcome is unknown (still sending, or maybe), as maybe, with Retry. */
    fun unknown(s: State): List<Message> = s.messages.filter { it.state == "maybe" || it.state == "sending" }.map { it.copy(state = "maybe") }

    private fun message(s: State, id: String, change: (Message) -> Message): State {
        val m = s.messages.find { it.id == id } ?: return s
        return s.copy(messages = s.messages.map { if (it.id == id) change(m) else it })
    }

    private fun upsert(list: List<Message>, m: Message) = if (list.any { it.id == m.id }) list.map { if (it.id == m.id) m else it } else list + m

    /** The bridge's held list is the truth for held messages after a (re)subscribe; ours keep their text. */
    private fun held(mine: List<Message>, held: JSONArray?): List<Message> {
        val ids = (0 until (held?.length() ?: 0)).mapNotNull { held?.optJSONObject(it) }.associate { it.optString("id") to it.optString("why") }
        return mine.mapNotNull { m -> when {
            m.id in ids -> m.copy(state = "held", why = ids.getValue(m.id))
            m.state == "held" -> null
            else -> m
        } }
    }

    /** New rows after the old, each id once (a newer copy of a row replaces it in place). */
    fun merge(old: List<Row>, new: List<Row>): List<Row> {
        if (new.isEmpty()) return old
        val at = old.withIndex().associate { it.value.id to it.index }
        val out = old.toMutableList()
        for (r in new) { val i = at[r.id]; if (i != null) out[i] = r else out += r }
        return out
    }

    private fun JSONArray?.rows(): List<Row> = if (this == null) emptyList() else (0 until length()).mapNotNull { Row.parse(optJSONObject(it)) }
    private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }.filter { it.isNotEmpty() }
}

/**
 * Which buttons a chat shows: the only place that decides it. A read-only DSH chat (a bridge without
 * `dshWrite`) gets none of them, whatever its rows claim; the bridge refuses those writes too
 * (dsh-source.mjs `refusedDsh`). A writable one never offers allow for session (RFC 0015 Amendments).
 */
object ChatActions {
    /** Allowed keys, as the engine names them (approve.js); anything else is never offered. */
    private val CHOICES = listOf("allow", "allow-always", "deny")

    fun canSend(s: Chat.State) = !s.readOnly && s.connected && !s.gone && !s.offline
    fun canInterrupt(s: Chat.State) = canSend(s) && s.status.state in setOf("working", "blocked")
    fun canShowTerminal(s: Chat.State) = !s.dsh
    fun canSendHeld(s: Chat.State, m: Chat.Message) = canSend(s) && m.state == "held"
    fun canRetry(s: Chat.State, m: Chat.Message) = canSend(s) && m.state == "maybe"

    /** A DSH chat the bridge or bots-dsh takes no phone writes on (no `dshWrite` in the hello): why, and what to do. */
    const val READ_ONLY = "Read only on the phone: Pocket Link or Automagik on this computer takes no phone writes. " +
        "Update both, or ${Chat.ANSWER_ON_COMPUTER}."

    /** The Bot chats dialog's line for a machine whose last listing said its bridge takes phone writes. */
    const val BOT_CHATS_WRITABLE = "Writable: you can send messages, answer approvals and questions, " +
        "and interrupt the agent from the phone."

    /** The Bot chats dialog's line for a machine whose listing advertised no phone writes: why, and where to answer. */
    const val BOT_CHATS_READ_ONLY = "Read only: Pocket Link or Automagik on this computer advertises no phone writes, " +
        "so send and answer happen on the computer."

    /**
     * The Bot chats dialog's capability line, from the machine's last listing (`dshWrite`): true says what the phone
     * can do there, false says read only and why a send would be refused; null (no listing yet, still loading) makes
     * neither claim.
     */
    fun botChatsLine(writable: Boolean?): String? = when (writable) {
        true -> BOT_CHATS_WRITABLE
        false -> BOT_CHATS_READ_ONLY
        null -> null
    }

    /**
     * The write state the Bot chats dialog may claim: the machine's last-known `dshWrite` only once this load's
     * listing has arrived. While it loads ([result] null) or after it failed, the dialog claims neither state, so a
     * value an earlier poll recorded never sits beside the spinner or the error.
     */
    fun botChatsWritable(result: Result<*>?, lastKnown: Boolean?): Boolean? =
        if (result?.isSuccess == true) lastKnown else null

    /**
     * What the chat's bottom line says when there is no message box, so a chat that cannot send always says why and
     * never drops a message silently: ended, offline, reconnecting, not connected, or read only. Null: the box shows
     * (or the chat is still connecting, which the list says).
     */
    fun whyNoSend(s: Chat.State): String? = when {
        canSend(s) -> null
        s.gone -> "This chat ended. Nothing typed here is sent."
        s.offline -> "The machine is offline. Nothing is sent until it is back."
        s.resuming -> "Reconnecting. Nothing is sent until the chat is back."
        !s.connected -> if (s.error != null) "Not connected. Nothing is sent." else null
        s.readOnly -> READ_ONLY
        else -> null
    }

    /** The approval's buttons: only on a writable chat, an open row the engine raised, with choices it named. */
    fun choices(s: Chat.State, row: Chat.Row?): List<String> {
        if (row == null || s.readOnly || !canSend(s) || !row.open || !row.answerable || row.kind != "approval") return emptyList()
        return CHOICES.filter { it in row.choices && !(s.dsh && it == "allow-always") }
    }

    /** The choice that types a question's own answer (chat/question.js `OTHER`). */
    const val OTHER = "other"

    /** A question's options to tap: only on a writable chat, an open answerable row the engine raised, with options it named. */
    fun options(s: Chat.State, row: Chat.Row?): List<String> {
        if (row == null || s.readOnly || !canSend(s) || !row.open || !row.answerable || row.kind != "question") return emptyList()
        return row.options
    }

    /** Whether the question also takes a typed answer: a single-select with options (a multi-select's was never probed). */
    fun canType(s: Chat.State, row: Chat.Row?) = row != null && !row.multi && options(s, row).isNotEmpty()

    /**
     * The chat.answer `choice` for the options picked, 0-based as drawn: one option on a single-select (its digit),
     * one or more on a multi-select (digits joined by ","); null for anything else.
     */
    fun questionChoice(s: Chat.State, row: Chat.Row?, picked: List<Int>): String? {
        val n = options(s, row).size
        if (n == 0 || picked.isEmpty() || picked.any { it !in 0 until n } || picked.toSet().size != picked.size) return null
        if (row?.multi != true && picked.size != 1) return null
        return picked.joinToString(",") { (it + 1).toString() }
    }

    /**
     * What a tap on a question sends as chat.answer's (choice, text): the options [picked], or the typed [text] (one
     * line, single-select only) with choice [OTHER]. Null when the row does not offer it: nothing is sent.
     */
    fun questionAnswer(s: Chat.State, row: Chat.Row?, picked: List<Int>, text: String? = null): Pair<String, String?>? {
        if (text == null) return questionChoice(s, row, picked)?.let { it to null }
        val typed = text.trim()
        if (!canType(s, row) || typed.isEmpty() || typed.any { it == '\n' || it == '\r' } || picked.isNotEmpty()) return null
        return OTHER to typed
    }

    /** What an approval or question without buttons says instead. */
    fun passive(s: Chat.State) = if (s.dsh) Chat.ANSWER_ON_COMPUTER else Chat.ANSWER_IN_TERMINAL

    /** What a pending row without buttons says: answered (the bridge saw it taken), not taken, or [passive]. */
    fun pendingNote(s: Chat.State, row: Chat.Row) = when (row.why) { "answered" -> "Answered."; "not-taken" -> Chat.NOT_TAKEN; else -> passive(s) }
}

/**
 * Row text as the phone shows it: plain text only (RFC 0015, "Rendering, both clients"). Escape
 * sequences and control characters are removed; raw HTML stays as the characters it is, never
 * parsed or rendered; nothing loads by itself; an http(s) link is a span showing its own target,
 * opened only on a tap. Image blocks load only on a tap ([Attach]).
 */
object ChatText {
    sealed interface Span { val text: String }
    data class Plain(override val text: String) : Span
    /** A link, shown as its target: [text] is the target itself. */
    data class Link(override val text: String) : Span

    sealed interface Block
    data class Prose(val spans: List<Span>) : Block
    /** A fenced code block, shown monospace. */
    data class Code(val text: String) : Block

    private val ESCAPES = Regex("\u001b\\[[0-?]*[ -/]*[@-~]|\u001b\\][^\u0007\u001b]*(\u0007|\u001b\\\\)?|\u001b[PX^_][^\u001b]*(\u001b\\\\)?|\u001b[@-Z\\\\-_]|\u009b[0-?]*[ -/]*[@-~]")

    /** ANSI and other escape sequences gone; then every control but newline and tab. CRLF becomes LF. */
    fun clean(text: String): String = ESCAPES.replace(text.replace("\r\n", "\n"), "")
        .filter { c -> c == '\n' || c == '\t' || !(c.isISOControl() || c == '\u007f') }

    fun spans(text: String): List<Span> {
        val out = mutableListOf<Span>()
        var at = 0
        for (range in Links.find(text)) {
            val url = text.substring(range)
            if (Links.browsable(url) == null) continue
            if (range.first > at) out += Plain(text.substring(at, range.first))
            out += Link(url)
            at = range.last + 1
        }
        if (at < text.length) out += Plain(text.substring(at))
        return out
    }

    /** [text] as blocks: fenced code apart, the rest prose. */
    fun blocks(text: String): List<Block> {
        val cleaned = clean(text)
        val out = mutableListOf<Block>()
        val prose = StringBuilder()
        val code = StringBuilder()
        var inCode = false
        fun flushProse() { if (prose.isNotEmpty()) { out += Prose(spans(prose.toString().trimEnd('\n'))); prose.clear() } }
        for (line in cleaned.split('\n')) {
            if (line.trimStart().startsWith("```")) {
                if (inCode) { out += Code(code.toString().trimEnd('\n')); code.clear() } else flushProse()
                inCode = !inCode
                continue
            }
            (if (inCode) code else prose).append(line).append('\n')
        }
        if (inCode) out += Code(code.toString().trimEnd('\n'))
        flushProse()
        return out.filterNot { it is Prose && it.spans.isEmpty() }
    }
}
