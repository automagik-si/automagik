package ai.namastex.automagik

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Home with the Automagik Bots' `dsh:` chats beside the terminals (#732): the issue's acceptance rows, one test each. */
class HomeChatsTest {
    private val host = "h"
    private fun pane(address: String, status: String, ms: Long = 0, bot: String? = null) = CoreTerminal.parse(JSONObject()
        .put("address", address).put("state", "live").put("cwd", "/w").put("status_ms", ms).put("turn", 1)
        .put("labels", bot?.let { JSONObject().put("bot", it) } ?: JSONObject.NULL)
        .put("status", JSONObject().put("state", status).put("app", "claude-code")))
    private fun row(id: String, status: String, kind: String? = null, msg: String = "", shown: Boolean = true, registryId: String? = null, title: String = "Lead") =
        Chat.Terminal.parse(JSONObject().put("terminal", "dsh:$id").put("machine", JSONObject.NULL).put("agent", "dsh").put("title", title)
            .put("status", JSONObject().put("state", status).put("kind", kind ?: JSONObject.NULL).put("msg", msg).put("turn", 0))
            .put("chat", "session").put("shown", shown).apply { if (registryId != null) put("registryId", registryId) })
    private fun sidebar(vararg terminals: CoreTerminal) = SidebarHost(host, "Laptop", true,
        listOf(PocketSpace("s1", "W", "/w", "", listOf(PocketTab("a", "Main", terminals.map { it.address })))), terminals.toList(), emptyList())
    private fun chats(rows: List<Chat.Terminal>, watched: Map<String, ChatWatch.Watched> = ChatWatch.read(emptyMap(), host, rows, 100),
                      write: Boolean = true, teams: List<Teams.Team> = emptyList()) =
        Cockpit.chats(mapOf(host to rows), watched, mapOf(host to write), teams, 200)
    private fun pulse(chats: Cockpit.Chats, vararg terminals: CoreTerminal, seen: Set<String> = emptySet()) = Projects.pulse(listOf(sidebar(*terminals)), seen, chats)
    private fun refs(pulse: Projects.Pulse, rank: Int) = pulse.sections.find { it.rank == rank }?.entries?.map { it.ref.address }.orEmpty()

    /** Row: a DSH approval increments Home's count and badge, in the Needs you list with the agent's name and the question. */
    @Test fun aBlockedBotChatCountsOnHomeAndItsBadge() {
        val rows = listOf(row("s1", "blocked", kind = "question", msg = "Which branch?"), row("s2", "working"))
        val p = pulse(chats(rows), pane("t1", "working"))
        assertEquals(1, p.needsYou); assertEquals(2, p.working)
        assertEquals(1, Nav.badge(Nav.HOME_TAB, p.needsYou, 0))
        val e = p.sections.first { it.rank == Cockpit.BLOCKED }.entries.single()
        assertEquals("dsh:s1", e.ref.address); assertEquals("Lead", e.terminal.title); assertEquals("Which branch?", e.terminal.message)
        assertEquals("Needs you · question", statusLabel(Cockpit.status(e.terminal, false), e.terminal.kind))
        // Projects and tasks stay the terminals': a chat has no folder.
        assertEquals(listOf("t1"), p.projects.flatMap { it.agents }.map { it.ref.address })
    }

    /** Row: the row opens the chat at the question: its ref is the `dsh:` chat ([PocketViewModel.selectTerminal] opens a chat for it). */
    @Test fun theRowIsTheChatItself() {
        val e = pulse(chats(listOf(row("s1", "blocked", kind = "permission"))), pane("t1", "idle")).sections.first().entries.single()
        assertTrue(Chat.isDsh(e.ref.address)); assertEquals(TerminalRef(host, "dsh:s1"), e.ref)
        assertEquals("Bot chat", Cockpit.addressLabel(e.ref)); assertEquals("t1", Cockpit.addressLabel(TerminalRef(host, "t1")))
        assertEquals("Automagik Bot", e.terminal.agent)
    }

    /** Row: answering decrements the count, and the finished chat moves to Done with its receipt, until it is looked at. */
    @Test fun answeringDecrementsAndAFinishedChatIsDoneWithItsReceipt() {
        val key = ChatWatch.key(host, "dsh:s1")
        val list = listOf(row("s1", "blocked", kind = "permission"))
        var watched = ChatWatch.read(emptyMap(), host, list, 100)
        assertEquals(1, pulse(chats(list, watched)).needsYou)
        // The open chat says the answer landed: a receipt on the closed card, then the turn runs.
        val closed = JSONObject("""{"type":"approval","row":{"id":"a1","kind":"approval","open":false,"receipt":{"by":"phone","name":"Pixel","outcome":"allow","at":1}}}""")
        assertEquals("Answered on the phone (Pixel): Allow", Chat.receiptLine(closed))
        assertNull(Chat.receiptLine(JSONObject("""{"type":"approval","row":{"id":"a1","kind":"approval","open":true}}""")))
        watched = ChatWatch.receipt(watched, key, Chat.receiptLine(closed)!!)
        val working = Chat.withStatus(list, "dsh:s1", Chat.Status("working"))
        watched = ChatWatch.status(watched, key, "working", 150)
        val running = pulse(chats(working, watched))
        assertEquals(0, running.needsYou); assertEquals(listOf("dsh:s1"), refs(running, Cockpit.WORKING))
        // The turn ends: Done, with the receipt as its line.
        val idle = Chat.withStatus(working, "dsh:s1", Chat.Status("idle"))
        watched = ChatWatch.status(watched, key, "idle", 200)
        val done = pulse(chats(idle, watched))
        val e = done.sections.single { it.rank == Cockpit.DONE }.entries.single()
        assertEquals("dsh:s1", e.ref.address); assertEquals("Answered on the phone (Pixel): Allow", e.terminal.message)
        // Looked at: idle, until another turn finishes.
        val seen = setOf(Cockpit.seenKey(e.ref, watched.getValue(key).turn))
        assertEquals(listOf("dsh:s1"), refs(pulse(chats(idle, watched), seen = seen), Cockpit.IDLE))
        watched = ChatWatch.read(watched, host, listOf(row("s1", "working")), 300)
        watched = ChatWatch.read(watched, host, listOf(row("s1", "idle")), 400)
        val again = pulse(chats(idle, watched), seen = seen)
        assertEquals(listOf("dsh:s1"), refs(again, Cockpit.DONE)); assertEquals("", again.sections.single().entries.single().terminal.message)
    }

    /** Row: a DSH chat with a Herdr pane counts once (RFC 0015 D29): the pane's row, raised to the chat, opens the chat. */
    @Test fun aBotWithAChatAndAPaneIsOneRow() {
        val paneRef = TerminalRef(host, "t1"); val chatRef = TerminalRef(host, "dsh:s1")
        val lead = Teams.Bot("b-main", "Lead", true, null, Teams.WORKING, "", 0L, paneRef, "")
        val team = Teams.Team("$host||/w", host, "", "/w", "W", Teams.Icon.Letter, null, listOf(lead))
        val rows = listOf(row("s1", "blocked", kind = "question", msg = "Which branch?", registryId = "b-main"))
        val c = chats(rows, teams = listOf(team))
        assertTrue(c.agents.isEmpty()); assertEquals(setOf(paneRef), c.panes.keys); assertEquals(chatRef, c.panes.getValue(paneRef).chat)
        val p = pulse(c, pane("t1", "working", bot = "b-main"), pane("t2", "working"))
        assertEquals(1, p.needsYou); assertEquals(listOf("t1"), refs(p, Cockpit.BLOCKED)); assertEquals(listOf("t2"), refs(p, Cockpit.WORKING))
        // The row is the chat's: its kind, its line (the question), its turn and time; the pane's name and folder stay.
        val e = p.sections.first().entries.single().terminal
        assertEquals(listOf("question", "Which branch?", 1L, 100L, "claude-code"), listOf(e.kind, e.message, e.turn, e.statusMs, e.title))
        // The pane's own word stays when it is the more urgent; a stale project's pane joins nothing.
        val own = pulse(chats(listOf(row("s1", "idle", registryId = "b-main")), teams = listOf(team)), pane("t1", "blocked", bot = "b-main"))
        assertEquals(listOf("t1"), refs(own, Cockpit.BLOCKED)); assertTrue(own.fromChat.isEmpty())
        val stale = chats(rows, teams = listOf(team.copy(stale = true, bots = listOf(lead.copy(ref = null)))))
        assertEquals(listOf("dsh:s1"), stale.agents.map { it.first.address })
        // An older bots-dsh serves no registry id: `dsh:<id>` itself is the Bot's.
        assertEquals(setOf(paneRef), chats(listOf(row("b-main", "blocked")), teams = listOf(team)).panes.keys)
    }

    /** The issue's case (#752): a project main Bot with no pane, its shown DSH chat blocked on a question, is a Needs you row. */
    @Test fun aDshOnlyMainBotWithAnOpenQuestionIsANeedsYouRow() {
        val lead = Teams.Bot("b-main", "Lead", true, null, Teams.IDLE, "", 0L, null, "")
        val team = Teams.Team("$host||/w", host, "", "/w", "W", Teams.Icon.Letter, null, listOf(lead))
        val blocked = listOf(row("s1", "blocked", kind = "question", msg = "Which branch?", registryId = "b-main"))
        val p = pulse(chats(blocked, teams = listOf(team)), pane("t1", "working"))
        assertEquals(1, p.needsYou); assertEquals(1, Nav.badge(Nav.HOME_TAB, p.needsYou, 0))
        val e = p.sections.first { it.rank == Cockpit.BLOCKED }.entries.single()
        assertEquals(TerminalRef(host, "dsh:s1"), e.ref); assertEquals("Lead", e.terminal.title)
        assertEquals("question", e.terminal.kind); assertEquals("Which branch?", e.terminal.message)
        // An idle such chat adds no needs-you row: it is in Home's Idle, and the badge stays clear.
        val idle = pulse(chats(listOf(row("s1", "idle", registryId = "b-main")), teams = listOf(team)), pane("t1", "working"))
        assertEquals(0, idle.needsYou); assertEquals(listOf("dsh:s1"), refs(idle, Cockpit.IDLE))
        assertTrue(idle.sections.none { it.rank == Cockpit.BLOCKED })
    }

    /** The joined row's Done is the chat's: its receipt is the line, and looking at the chat clears it. The pane's own Done keeps its own key. */
    @Test fun aJoinedRowsDoneIsTheChatsAndClearsWithTheChatsKey() {
        val paneRef = TerminalRef(host, "t1"); val chatRef = TerminalRef(host, "dsh:s1"); val key = ChatWatch.key(host, "dsh:s1")
        val lead = Teams.Bot("b-main", "Lead", true, null, Teams.IDLE, "", 0L, paneRef, "")
        val team = Teams.Team("$host||/w", host, "", "/w", "W", Teams.Icon.Letter, null, listOf(lead))
        val rows = listOf(row("s1", "idle", registryId = "b-main"))
        var watched = ChatWatch.read(emptyMap(), host, listOf(row("s1", "blocked", registryId = "b-main")), 100)
        watched = ChatWatch.receipt(watched, key, "Answered on the phone: Allow")
        watched = ChatWatch.read(watched, host, rows, 200)
        val done = pulse(chats(rows, watched, teams = listOf(team)), pane("t1", "idle", bot = "b-main"))
        val e = done.sections.single().entries.single()
        assertEquals(Cockpit.DONE, e.rank); assertEquals(paneRef, e.ref); assertEquals("Answered on the phone: Allow", e.terminal.message)
        // Its seen key is the chat's, the one PocketViewModel.markSeen adds when the chat is looked at; the pane's own does nothing.
        assertEquals(Cockpit.seenKey(chatRef, 1L), done.seenKey(e.ref, e.terminal))
        val seenChat = pulse(chats(rows, watched, teams = listOf(team)), pane("t1", "idle", bot = "b-main"), seen = setOf(Cockpit.seenKey(chatRef, 1L)))
        assertEquals(listOf("t1"), refs(seenChat, Cockpit.IDLE))
        val seenPane = pulse(chats(rows, watched, teams = listOf(team)), pane("t1", "idle", bot = "b-main"), seen = setOf(Cockpit.seenKey(paneRef, 1L)))
        assertEquals(listOf("t1"), refs(seenPane, Cockpit.DONE))
        // The pane's own Done (the chat idle) keeps the pane's key, which looking at the row from Home also marks.
        val paneDone = pulse(chats(rows, ChatWatch.read(emptyMap(), host, rows, 100), teams = listOf(team)), pane("t1", "done", bot = "b-main"))
        val pe = paneDone.sections.single().entries.single()
        assertEquals(Cockpit.DONE, pe.rank); assertEquals(Cockpit.seenKey(paneRef, pe.terminal), paneDone.seenKey(pe.ref, pe.terminal))
        // A chat-only Done clears with the chat's key as before.
        val alone = pulse(chats(rows, watched), seen = setOf(Cockpit.seenKey(chatRef, 1L)))
        assertEquals(listOf("dsh:s1"), refs(alone, Cockpit.IDLE))
    }

    /** Row: a read-only needs-you row says it cannot answer. */
    @Test fun aReadOnlyNeedsYouRowSaysSo() {
        val rows = listOf(row("s1", "blocked", kind = "permission"))
        assertEquals(Cockpit.READ_ONLY, chats(rows, write = false).agents.single().second.message)
        assertEquals("", chats(rows, write = true).agents.single().second.message)
        // bots-dsh's own line (its socket takes no writes) stays; a chat that is not blocked says nothing.
        assertEquals(Chat.ANSWER_ON_COMPUTER, chats(listOf(row("s1", "blocked", kind = "permission", msg = Chat.ANSWER_ON_COMPUTER))).agents.single().second.message)
        assertEquals("", chats(listOf(row("s1", "working", msg = "x")), write = false).agents.single().second.message)
    }

    /** Row: the Today ordering holds: Needs you, then Done; Working and Idle under Everything else. */
    @Test fun todaysOrderHoldsWithChatsAmongTheTerminals() {
        val rows = listOf(row("s1", "blocked", kind = "question"), row("s2", "working"), row("s3", "idle"), row("s4", "blocked", shown = false))
        var watched = ChatWatch.read(emptyMap(), host, rows, 100)
        watched = ChatWatch.read(watched, host, listOf(row("s1", "blocked", kind = "question"), row("s2", "idle"), row("s3", "idle")), 200)
        val p = pulse(chats(rows, watched), pane("t1", "done", ms = 50), pane("t2", "idle"), pane("t3", "blocked", ms = 5), pane("t4", "working"))
        assertEquals(listOf("Needs you", "Done", "Working", "Idle"), p.sections.map { it.title })
        assertEquals(listOf("dsh:s1", "t3"), refs(p, Cockpit.BLOCKED))
        assertEquals(listOf("dsh:s2", "t1"), refs(p, Cockpit.DONE))
        assertEquals(listOf("t4"), refs(p, Cockpit.WORKING))
        assertEquals(listOf("dsh:s3", "t2"), refs(p, Cockpit.IDLE))
        // A chat listed `shown: false` opens nothing, so it is no row and no count.
        assertTrue(p.sections.flatMap { it.entries }.none { it.ref.address == "dsh:s4" })
    }

    /** The deck reads Home's own Needs you list: its count equals the cards, chats and terminals in Home's order. */
    @Test fun theDeckReadsHomesNeedsYouListNotTheTeamBubbles() {
        val rows = listOf(row("s1", "blocked", kind = "question", msg = "Which branch?"),
            row("s2", "blocked", kind = "permission", msg = "Run 2 commands?"))
        val p = pulse(chats(rows), pane("t1", "blocked", ms = 50), pane("t2", "working"))
        val needs = p.sections.first { it.rank == Cockpit.BLOCKED }
        assertEquals(3, p.needsYou)
        val cards = Teams.deckCards(needs.entries, p.fromChat) { if (Chat.isDsh(it.address)) "Bot chats" else "W" }
        assertEquals(p.needsYou, cards.size)
        assertEquals(needs.entries.map { it.ref }, cards.map { it.ref })
        // A chat row is a chat card; a terminal row keeps its terminal menu.
        assertEquals(listOf(true, true, false), cards.map { it.opensChat })
        assertEquals(listOf(TerminalRef(host, "dsh:s1"), TerminalRef(host, "dsh:s2"), null), cards.map { it.chat })
        assertEquals(listOf("Bot chats", "Bot chats", "W"), cards.map { it.where })
    }

    /** Home's badge and tile count every waiting request, including one waiting in a Bot chat. */
    @Test fun homeCountsARequestWaitingInABotChat() {
        val rows = listOf(row("s1", "blocked", kind = "question"))
        val p = pulse(chats(rows), pane("t1", "blocked"))
        assertEquals(2, p.homeNeedsYou)
        assertEquals(1, p.answerableNeedsYou)
        assertEquals(2, Nav.badge(Nav.HOME_TAB, p.homeNeedsYou, 0))
    }

    /** A pane row raised to its chat keeps the pane's name and project, and opens the chat. */
    @Test fun theDecksPaneRaisedToItsChatOpensThatChat() {
        val paneRef = TerminalRef(host, "t1"); val chatRef = TerminalRef(host, "dsh:s1")
        val lead = Teams.Bot("b-main", "Lead", true, null, Teams.IDLE, "", 0L, paneRef, "")
        val team = Teams.Team("$host||/w", host, "", "/w", "W", Teams.Icon.Letter, null, listOf(lead))
        val rows = listOf(row("s1", "blocked", kind = "question", msg = "Which branch?", registryId = "b-main"))
        val p = pulse(chats(rows, teams = listOf(team)), pane("t1", "working", bot = "b-main"))
        val card = Teams.deckCards(p.sections.first().entries, p.fromChat) { "W" }.single()
        assertEquals(paneRef, card.ref); assertEquals(chatRef, card.chat); assertTrue(card.opensChat)
    }

    @Test fun theWatchStartsQuietForgetsUnlistedChatsAndKeepsItsReceiptThroughTheTurn() {
        val k = ChatWatch.key(host, "dsh:s1")
        val quiet = ChatWatch.read(emptyMap(), host, listOf(row("s1", "idle")), 1)
        assertEquals(ChatWatch.Watched("idle", 0, 1), quiet.getValue(k))
        assertSame(quiet.getValue(k), ChatWatch.read(quiet, host, listOf(row("s1", "idle")), 2).getValue(k))
        val gone = ChatWatch.read(quiet, host, emptyList(), 3)
        assertTrue(gone.isEmpty())
        var w = ChatWatch.read(quiet, host, listOf(row("s1", "blocked")), 4)
        assertEquals(ChatWatch.Watched("blocked", 1, 4), w.getValue(k))
        w = ChatWatch.receipt(w, k, "Answered on the computer: Deny")
        w = ChatWatch.status(w, k, "working", 5)
        w = ChatWatch.status(w, k, "idle", 6)
        assertEquals(ChatWatch.Watched("done", 1, 6, "Answered on the computer: Deny"), w.getValue(k))
        // Still done on the next reading; a new turn drops the receipt.
        assertEquals("done", ChatWatch.read(w, host, listOf(row("s1", "idle")), 7).getValue(k).status)
        assertEquals(ChatWatch.Watched("working", 2, 8), ChatWatch.read(w, host, listOf(row("s1", "working")), 8).getValue(k))
        // The phone left the chat while it was blocked: bots-dsh lists it idle now, which is no finish; seen active
        // again, it is the same turn, and its finish is Done.
        val open = ChatWatch.receipt(ChatWatch.read(quiet, host, listOf(row("s1", "blocked")), 10), k, "Answered on the computer: Allow")
        val left = ChatWatch.left(open, k)
        assertEquals(ChatWatch.Watched("idle", 1, 11), ChatWatch.read(left, host, listOf(row("s1", "idle")), 11).getValue(k))
        val back = ChatWatch.read(left, host, listOf(row("s1", "working")), 12).getValue(k)
        assertEquals(ChatWatch.Watched("working", 1, 12, "Answered on the computer: Allow"), back)
        assertEquals("done", ChatWatch.observe(back, "idle", 13).status)
        assertSame(quiet, ChatWatch.left(quiet, k)); assertSame(quiet, ChatWatch.left(quiet, "h|dsh:none"))
        // Another machine's chats are untouched by this one's reading.
        val other = ChatWatch.read(w, "h2", listOf(row("s9", "blocked")), 9)
        assertEquals(setOf(k, ChatWatch.key("h2", "dsh:s9")), other.keys)
    }
}
