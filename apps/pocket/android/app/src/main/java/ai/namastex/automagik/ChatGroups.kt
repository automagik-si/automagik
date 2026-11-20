package ai.namastex.automagik

/** Group chats (RFC 0040) on Home and Team, listed by a bridge that granted groups. In memory only. */
object ChatGroups {
    const val HEADING = "Groups"
    const val AGENT = "Group"
    const val ADDRESS = "Group chat"

    /** Shown groups, most urgent first, then by title and terminal. */
    fun rows(dsh: Map<String, List<Chat.Terminal>>): List<Pair<TerminalRef, Chat.Terminal>> =
        dsh.flatMap { (host, chats) -> chats.filter { it.group && it.shown }.map { TerminalRef(host, it.terminal) to it } }
            .sortedWith(compareByDescending<Pair<TerminalRef, Chat.Terminal>> { Cockpit.rank(it.second.status) }
                .thenBy { it.second.title.lowercase() }.thenBy { it.second.terminal })

    /** The members' names as drawn on the card. */
    fun members(t: Chat.Terminal): String =
        t.members.map { ChatText.clean(it).trim() }.filter { it.isNotBlank() }.joinToString(", ")

    /** A blocked group may have nothing the phone can answer. */
    fun waiting(t: Chat.Terminal): String? = when {
        t.status != "blocked" -> null
        t.approvals == 0 -> Chat.WAITING_ON_COMPUTER
        t.approvals == 1 -> "1 approval"
        else -> "${t.approvals} approvals"
    }

    fun card(t: Chat.Terminal): CoreTerminal =
        CoreTerminal(t.terminal, ChatText.clean(t.title).trim().ifBlank { AGENT }, "", "live",
            t.status.ifBlank { "idle" }, AGENT, members(t), 0, 0, app = "dsh", kind = if (t.status == "blocked") t.kind else "")

    /** Updates the open group's list row between reads. */
    fun withState(list: List<Chat.Terminal>, terminal: String, title: String, status: Chat.Status, approvals: Int): List<Chat.Terminal> {
        if (status.state.isBlank()) return list
        val row = list.find { it.terminal == terminal } ?: return list
        val next = row.copy(title = title.ifBlank { row.title }, status = status.state, kind = status.kind, approvals = approvals)
        return if (next == row) list else list.map { if (it.terminal == terminal) next else it }
    }

    /** Drops a group whose watch ended when the computer revoked it. */
    fun without(list: List<Chat.Terminal>, terminal: String): List<Chat.Terminal> =
        if (list.none { it.terminal == terminal }) list else list.filterNot { it.terminal == terminal }
}
