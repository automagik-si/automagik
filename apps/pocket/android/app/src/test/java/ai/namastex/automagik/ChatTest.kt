package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** The chat's model, its button gate and its text rendering (RFC 0015 delivery 5). */
class ChatTest {
    private fun j(text: String) = JSONObject(text)
    private fun state(terminal: String = "t1") = Chat.reduce(Chat.State(terminal), j("""{"type":"snapshot","reset":false,"rows":[],"screen":[],
        "status":{"state":"idle","kind":null,"msg":""},"approval":null,"held":[]}"""))
    private fun approval(open: Boolean = true, choices: String = """["allow","deny"]""") =
        """{"id":"approval:c1","kind":"approval","source":"status","tool":"Bash","summary":"npm test","input":"npm test","call":"c1","choices":$choices,"open":$open}"""
    private fun blocked(s: Chat.State) = Chat.reduce(s, j("""{"type":"status","status":{"state":"blocked","kind":"permission","msg":"Allow?"}}"""))

    // ---- rendering: plain text only, nothing loads or runs

    /** No image block exists; a lone tag is one plain span, its characters exactly as written. */
    @Test fun imgTagRendersAsPlainTextAndLoadsNothing() {
        val blocks = ChatText.blocks("<img src=x>")
        assertEquals(listOf(ChatText.Prose(listOf(ChatText.Plain("<img src=x>")))), blocks)
        val withUrl = ChatText.blocks("""<img src="https://evil.example/pixel.png" onerror="fetch('https://evil.example')">""")
        val spans = (withUrl.single() as ChatText.Prose).spans
        assertEquals("""<img src="https://evil.example/pixel.png" onerror="fetch('https://evil.example')">""", spans.joinToString("") { it.text })
        // The URL is only a link that shows its own target, opened on a tap; nothing fetches it.
        assertTrue(spans.filterIsInstance<ChatText.Link>().all { it.text.startsWith("https://evil.example") })
        assertTrue(withUrl.all { it is ChatText.Prose || it is ChatText.Code })
    }

    @Test fun scriptTagRendersAsPlainTextAndRunsNothing() {
        val text = "<script>alert(document.cookie)</script>"
        assertEquals(listOf(ChatText.Prose(listOf(ChatText.Plain(text)))), ChatText.blocks(text))
        val mixed = "before <script src=\"https://evil.example/x.js\"></script> after"
        val spans = (ChatText.blocks(mixed).single() as ChatText.Prose).spans
        assertEquals(mixed, spans.joinToString("") { it.text })
        assertEquals(listOf("https://evil.example/x.js"), spans.filterIsInstance<ChatText.Link>().map { it.text })
    }

    @Test fun markdownImageIsATapOnlyLinkNeverAnImage() {
        val spans = (ChatText.blocks("![logo](https://evil.example/logo.png)").single() as ChatText.Prose).spans
        assertEquals("![logo](https://evil.example/logo.png)", spans.joinToString("") { it.text })
        assertEquals(listOf(ChatText.Link("https://evil.example/logo.png")), spans.filterIsInstance<ChatText.Link>())
    }

    @Test fun onlyHttpLinksBecomeLinks() {
        val spans = (ChatText.blocks("javascript:alert(1) file:///etc/passwd data:text/html,<b>x</b>").single() as ChatText.Prose).spans
        assertTrue(spans.none { it is ChatText.Link })
    }

    @Test fun escapeSequencesAndControlCharactersAreRemoved() {
        assertEquals("red plain\ttab\nline", ChatText.clean("\u001b[31mred\u001b[0m plain\ttab\r\nline\u0007\u0000"))
        assertEquals("title gone", ChatText.clean("\u001b]0;evil\u0007title gone"))
        assertEquals("pasted", ChatText.clean("\u001b[200~pasted\u001b[201~"))
        assertEquals("ab", ChatText.clean("a\u009b31mb\u007f"))
    }

    @Test fun fencedCodeIsItsOwnMonospaceBlock() {
        val blocks = ChatText.blocks("Run this:\n```sh\nrm -rf <dir>\n```\nDone")
        assertEquals(listOf(ChatText.Prose(listOf(ChatText.Plain("Run this:"))), ChatText.Code("rm -rf <dir>"), ChatText.Prose(listOf(ChatText.Plain("Done")))), blocks)
        assertEquals(listOf(ChatText.Code("never closed")), ChatText.blocks("```\nnever closed"))
    }

    // ---- read only: a DSH chat gets no action, whatever its rows claim

    @Test fun dshChatOffersNoActionsEvenWhenRowsClaimChoices() {
        val s = blocked(state("dsh:bot-1"))
        // A hostile or mistaken row: open, answerable, with choices.
        val claimed = Chat.reduce(s, j("""{"type":"approval","row":${approval()}}"""))
        assertTrue(claimed.readOnly)
        assertEquals(emptyList<String>(), ChatActions.choices(claimed, claimed.approval))
        assertFalse(ChatActions.canSend(claimed))
        assertFalse(ChatActions.canInterrupt(claimed))
        assertFalse(ChatActions.canShowTerminal(claimed))
        val held = Chat.Message("m1", "hi", "held", "draft")
        assertFalse(ChatActions.canSendHeld(claimed.copy(messages = listOf(held)), held))
        assertFalse(ChatActions.canRetry(claimed, Chat.Message("m2", "hi", "maybe")))
    }

    // ---- writes on a DSH chat, only where the bridge's hello said dshWrite (RFC 0015, Amendments 2026-11-07)

    /** With dshWrite: send, interrupt, allow and deny; never allow for session, never a terminal pane. */
    @Test fun dshChatWithDshWriteOffersSendAnswerAndInterruptButNeverAllowForSession() {
        val s = blocked(state("dsh:bot-1").copy(dshWrite = true))
        val claimed = Chat.reduce(s, j("""{"type":"approval","row":${approval(choices = """["allow","allow-always","deny"]""")}}"""))
        assertFalse(claimed.readOnly)
        assertEquals(listOf("allow", "deny"), ChatActions.choices(claimed, claimed.approval))
        assertTrue(ChatActions.canSend(claimed))
        assertTrue(ChatActions.canInterrupt(claimed))
        assertFalse(ChatActions.canShowTerminal(claimed))
        assertTrue(ChatActions.canRetry(claimed, Chat.Message("m2", "hi", "maybe")))
        // A row without buttons still points at the computer, never at a terminal.
        assertEquals(Chat.ANSWER_ON_COMPUTER, ChatActions.passive(claimed))
        // The same chat without the flag stays read only.
        assertEquals(emptyList<String>(), ChatActions.choices(claimed.copy(dshWrite = false), claimed.approval))
        assertFalse(ChatActions.canSend(claimed.copy(dshWrite = false)))
    }

    /**
     * A DSH send whose socket did not answer in time (`offline`) may have gone: "maybe not sent" with Retry, never a
     * plain refusal or a success. On a terminal chat `offline` stays a refusal. A DSH `sent` is final.
     */
    @Test fun dshSendOfflineIsMaybeNotSentAndSentIsFinal() {
        val dsh = state("dsh:bot-1").copy(dshWrite = true, messages = listOf(Chat.Message("m", "x", "sending")))
        val maybe = Chat.answered(dsh, "m", "x", j("""{"state":"refused","ok":false,"reason":"offline","id":"m"}"""))
        assertEquals("maybe", maybe.messages.single().state)
        assertTrue(ChatActions.canRetry(maybe, maybe.messages.single()))
        val terminal = Chat.answered(state(), "m", "x", j("""{"state":"refused","ok":false,"reason":"offline","id":"m"}"""))
        assertEquals("refused", terminal.messages.single().state)
        assertEquals("sent", Chat.answered(dsh, "m", "x", j("""{"ok":true,"state":"sent","id":"m"}""")).messages.single().state)
        assertEquals("queued", Chat.answered(dsh, "m", "x", j("""{"ok":true,"state":"queued","id":"m"}""")).messages.single().state)
        // A terminal's sent bubble waits for the transcript, as before.
        val typing = state().copy(messages = listOf(Chat.Message("m", "x", "sending")))
        assertEquals("sending", Chat.answered(typing, "m", "x", j("""{"ok":true,"state":"sent","id":"m"}""")).messages.single().state)
    }

    /** A reconnect keeps only messages whose outcome is unknown, as maybe; sent, queued, refused and held are left to the bridge. */
    @Test fun aReconnectKeepsUnknownMessagesAsMaybe() {
        val s = state("dsh:bot-1").copy(messages = listOf(Chat.Message("a", "1", "sending"), Chat.Message("b", "2", "maybe"),
            Chat.Message("c", "3", "sent"), Chat.Message("d", "4", "refused", reason = "rate"), Chat.Message("e", "5", "held", "draft")))
        assertEquals(listOf("a" to "maybe", "b" to "maybe"), Chat.unknown(s).map { it.id to it.state })
    }

    /** The socket's refusals on a DSH answer read as what happened; a receipt never claims more than it holds. */
    @Test fun dshAnswerNoticesPassTheSocketsReasonsThrough() {
        fun n(text: String) = Chat.answerNotice(j(text), dsh = true)
        assertNull(n("""{"ok":true,"state":"sent"}"""))
        assertEquals("Already answered on the computer: Deny.", n("""{"state":"refused","ok":false,"reason":"settled","receipt":{"by":"computer","outcome":"deny"}}"""))
        assertEquals("Already answered on the phone (Pixel 8): Allow.", n("""{"state":"refused","ok":false,"reason":"settled","receipt":{"by":"phone","name":"Pixel 8","outcome":"allow"}}"""))
        assertEquals("No longer needed.", n("""{"state":"refused","ok":false,"reason":"settled","receipt":{"by":null,"outcome":"withdrawn"}}"""))
        assertEquals("Already answered.", n("""{"state":"refused","ok":false,"reason":"settled"}"""))
        assertEquals("The question changed; nothing was answered.", n("""{"state":"refused","ok":false,"reason":"changed"}"""))
        assertEquals("Show this project in Automagik first.", n("""{"state":"refused","ok":false,"reason":"not-shown"}"""))
        assertEquals(Chat.ANSWER_MAYBE, n("""{"state":"refused","ok":false,"reason":"offline"}"""))
        assertEquals(Chat.ANSWER_ON_COMPUTER, n("""{"state":"refused","ok":false,"reason":"read-only"}"""))
        assertEquals("Not answered. ${Chat.ANSWER_ON_COMPUTER}.", n("""{"state":"refused","ok":false,"reason":"failed"}"""))
        // An interrupt the socket did not answer in time is not confirmed, never "sent" and never repeated.
        assertEquals("Interrupt not confirmed. Check the computer.", Chat.interruptNotice(j("""{"state":"refused","ok":false,"reason":"offline"}"""), dsh = true))
        assertEquals("Interrupt not confirmed. Check the computer.", Chat.interruptNotice(null, dsh = true))
        assertEquals("Interrupt not confirmed. Check the terminal.", Chat.interruptNotice(null, dsh = false))
    }

    /** The read-back from #655/#658 holds on every chat: keys sent but still asking is "not taken", never answered. */
    @Test fun readBackNotTakenIsNeverShownAsAnswered() {
        val uncertain = j("""{"ok":true,"pressed":"uncertain","sent":true}""")
        assertEquals(Chat.NOT_TAKEN, Chat.answerNotice(uncertain))
        assertEquals(Chat.NOT_TAKEN, Chat.answerNotice(uncertain, dsh = true))
        val row = Chat.Row("approval:c1", "approval", open = true, why = "not-taken")
        assertEquals(Chat.NOT_TAKEN, ChatActions.pendingNote(Chat.State("t1", connected = true), row))
        assertEquals(Chat.NOT_TAKEN, ChatActions.pendingNote(Chat.State("dsh:b1", connected = true, dshWrite = true), row))
        assertEquals(Chat.ANSWER_ON_COMPUTER, ChatActions.pendingNote(Chat.State("dsh:b1", connected = true, dshWrite = true), row.copy(why = "")))
    }

    @Test fun dshApprovalShowsAnswerOnTheComputer() {
        val row = """{"id":"dsh:s:4:approval","turn":0,"at":null,"source":"session","kind":"approval","tool":"","summary":"Answer on the computer","choices":[],"open":true,"answerable":false}"""
        val s = Chat.reduce(state("dsh:bot-1"), j("""{"type":"approval","row":$row}"""))
        assertNotNull(s.approval)
        assertEquals(emptyList<String>(), ChatActions.choices(s, s.approval))
        assertEquals(Chat.ANSWER_ON_COMPUTER, ChatActions.passive(s))
        val question = Chat.reduce(s, j("""{"type":"question","row":{"id":"q","kind":"question","prompt":"Answer on the computer","options":[],"multi":false,"answerable":false}}"""))
        assertEquals(emptyList<String>(), ChatActions.choices(question, question.question))
    }

    @Test fun terminalApprovalGetsOnlyTheEngineChoices() {
        val s = Chat.reduce(blocked(state()), j("""{"type":"approval","row":${approval(choices = """["allow","allow-always","deny","press-9"]""")}}"""))
        assertEquals(listOf("allow", "allow-always", "deny"), ChatActions.choices(s, s.approval))
        assertEquals(Chat.ANSWER_IN_TERMINAL, ChatActions.passive(s))
        // No choices from the engine (an unrecognised dialog): no buttons.
        val none = Chat.reduce(s, j("""{"type":"approval","row":${approval(choices = "[]")}}"""))
        assertEquals(emptyList<String>(), ChatActions.choices(none, none.approval))
        // Offline or disconnected: nothing to press.
        assertEquals(emptyList<String>(), ChatActions.choices(s.copy(offline = true), s.approval))
        assertEquals(emptyList<String>(), ChatActions.choices(s.copy(connected = false), s.approval))
    }

    // ---- questions: the engine's options, tapped as the digits chat/question.js reads

    private fun question(multi: Boolean = false, answerable: Boolean = true) =
        """{"id":"question:1:2.0","kind":"question","source":"status","turn":3,"prompt":"Which database?","options":["Postgres","SQLite"],"multi":$multi,"answerable":$answerable,"call":"1:2.0","open":true}"""
    private fun asked(s: Chat.State, row: String) = Chat.reduce(Chat.reduce(s, j("""{"type":"status","status":{"state":"blocked","kind":"question","msg":"Which database?"}}""")), j("""{"type":"question","row":$row}"""))

    @Test fun questionRowShowsItsOptionsAndATapIsThatOptionsDigit() {
        val s = asked(state(), question())
        assertEquals(listOf("Postgres", "SQLite"), ChatActions.options(s, s.question))
        assertTrue(ChatActions.canType(s, s.question))
        assertEquals("2" to null, ChatActions.questionAnswer(s, s.question, listOf(1)))
        assertEquals(ChatActions.OTHER to "MySQL 8", ChatActions.questionAnswer(s, s.question, emptyList(), " MySQL 8 "))
        // One option on a single-select, in range; a typed answer is one line, not blank.
        for (picked in listOf(listOf(0, 1), listOf(2), listOf(-1), emptyList())) assertNull(ChatActions.questionAnswer(s, s.question, picked))
        for (text in listOf("", "  ", "two\nlines")) assertNull(ChatActions.questionAnswer(s, s.question, emptyList(), text))
        // Approval buttons are not question options, and the other way round.
        assertEquals(emptyList<String>(), ChatActions.choices(s, s.question))
    }

    @Test fun multiSelectQuestionSubmitsTheTickedDigitsAndTakesNoTypedAnswer() {
        val s = asked(state(), question(multi = true))
        assertEquals(listOf("Postgres", "SQLite"), ChatActions.options(s, s.question))
        assertFalse(ChatActions.canType(s, s.question))
        assertEquals("2,1" to null, ChatActions.questionAnswer(s, s.question, listOf(1, 0)))
        assertNull(ChatActions.questionAnswer(s, s.question, listOf(1, 1)))
        assertNull(ChatActions.questionAnswer(s, s.question, emptyList(), "x"))
    }

    /** A phone that opens the chat after the question was raised (an app restart, another device) gets it from the snapshot. */
    @Test fun questionInTheSnapshotShowsOnAFreshChatAndCanBeAnswered() {
        val fresh = Chat.reduce(Chat.State("t1"), j("""{"type":"snapshot","reset":false,"rows":[],"screen":[],
            "status":{"state":"blocked","kind":"question","msg":"Which database?"},"approval":null,"question":${question()},"held":[]}"""))
        assertEquals("question:1:2.0", fresh.question?.id)
        assertEquals(listOf("Postgres", "SQLite"), ChatActions.options(fresh, fresh.question))
        assertEquals("2" to null, ChatActions.questionAnswer(fresh, fresh.question, listOf(1)))
        // A closed question in the snapshot, or none: no card.
        val closed = question().replace("\"open\":true", "\"open\":false")
        assertNull(Chat.reduce(fresh, j("""{"type":"snapshot","reset":false,"rows":[],"screen":[],"status":{"state":"blocked","kind":"question"},"question":$closed,"held":[]}""")).question)
        assertNull(Chat.reduce(fresh, j("""{"type":"snapshot","reset":false,"rows":[],"screen":[],"status":{"state":"working"},"question":null,"held":[]}""")).question)
    }

    @Test fun questionWithoutTheEngineOptionsOffersNothingToTap() {
        for (s in listOf(asked(state(), question(answerable = false)), asked(state("dsh:bot-1"), question()),
            asked(state(), question()).copy(offline = true), asked(state(), question()).copy(connected = false))) {
            assertEquals(emptyList<String>(), ChatActions.options(s, s.question))
            assertNull(ChatActions.questionAnswer(s, s.question, listOf(0)))
            assertNull(ChatActions.questionAnswer(s, s.question, emptyList(), "x"))
        }
        // An approval row never gets question options.
        val a = Chat.reduce(blocked(state()), j("""{"type":"approval","row":${approval()}}"""))
        assertEquals(emptyList<String>(), ChatActions.options(a, a.approval))
    }

    @Test fun approvalClosesWhenTheEngineSaysSo() {
        val s = Chat.reduce(blocked(state()), j("""{"type":"approval","row":${approval()}}"""))
        assertEquals("approval:c1", s.approval?.id)
        assertNull(Chat.reduce(s, j("""{"type":"approval","row":${approval(open = false)}}""")).approval)
    }

    @Test fun interruptOnlyWhileTheAgentIsBusy() {
        assertFalse(ChatActions.canInterrupt(state()))
        assertTrue(ChatActions.canInterrupt(Chat.reduce(state(), j("""{"type":"status","status":{"state":"working"}}"""))))
        assertTrue(ChatActions.canInterrupt(blocked(state())))
        assertTrue(ChatActions.canShowTerminal(state()))
    }

    // ---- the stream's events

    @Test fun snapshotRowsAndScreenFold() {
        var s = Chat.reduce(Chat.State("t1"), j("""{"type":"snapshot","reset":false,"rows":[{"id":"1:1.0","kind":"text","role":"user","text":"hi","source":"transcript"}],
            "screen":[{"id":"screen:1","kind":"text","role":"assistant","text":"thinking"}],"status":{"state":"working"},"approval":null,"held":[]}"""))
        assertTrue(s.connected)
        assertEquals("1:1.0", s.cursor)
        assertEquals(1, s.screen.size)
        s = Chat.reduce(s, j("""{"type":"rows","rows":[{"id":"1:2.0","kind":"text","role":"assistant","text":"hello"},{"id":"1:1.0","kind":"text","role":"user","text":"hi!"}]}"""))
        assertEquals(listOf("1:1.0", "1:2.0"), s.rows.map { it.id })
        assertEquals("hi!", s.rows[0].text)
        s = Chat.reduce(s, j("""{"type":"screen","rows":[]}"""))
        assertEquals(emptyList<Chat.Row>(), s.screen)
        // A reset (the bridge restarted) replaces the rows with the latest page.
        s = Chat.reduce(s, j("""{"type":"snapshot","reset":true,"rows":[{"id":"1:9.0","kind":"text","role":"assistant","text":"new"}],"screen":[],"status":{"state":"idle"},"approval":null,"held":[]}"""))
        assertEquals(listOf("1:9.0"), s.rows.map { it.id })
    }

    @Test fun aDshSnapshotWithoutScreenOrHeldStillFolds() {
        val s = Chat.reduce(Chat.State("dsh:b"), j("""{"type":"snapshot","rows":[{"id":"r","kind":"text","role":"assistant","text":"x"}]}"""))
        assertEquals(1, s.rows.size)
        assertTrue(s.connected)
        assertEquals(s, Chat.reduce(s, j("""{"type":"something-new"}""")))
    }

    @Test fun goneOfflineAndScreenOnly() {
        val s = Chat.reduce(blocked(state()), j("""{"type":"approval","row":${approval()}}"""))
        val offline = Chat.reduce(s, j("""{"type":"offline"}"""))
        assertTrue(offline.offline); assertNull(offline.approval); assertFalse(ChatActions.canSend(offline))
        val gone = Chat.reduce(s, j("""{"type":"gone"}"""))
        assertTrue(gone.gone); assertFalse(ChatActions.canSend(gone))
        assertTrue(Chat.reduce(s, j("""{"type":"source","source":"none"}""")).screenOnly)
    }

    @Test fun heldMessageThenSendNowThenMatched() {
        var s = state()
        s = s.copy(messages = listOf(Chat.Message("m1", "run tests", "sending")))
        s = Chat.answered(s, "m1", "run tests", j("""{"state":"held","id":"m1","why":"draft"}"""))
        val held = s.messages.single()
        assertEquals("held", held.state); assertEquals("draft", held.why)
        assertTrue(ChatActions.canSendHeld(s, held))
        s = Chat.reduce(s, j("""{"type":"sent","id":"m1","state":"sent"}"""))
        s = Chat.reduce(s, j("""{"type":"sending","id":"m1"}"""))
        assertEquals("sending", s.messages.single().state)
        s = Chat.reduce(s, j("""{"type":"matched","id":"m1","row":"1:3.0"}"""))
        assertTrue(s.messages.isEmpty())
    }

    @Test fun resubscribeKeepsOnlyWhatTheBridgeStillHolds() {
        val s = state().copy(messages = listOf(Chat.Message("a", "x", "held", "draft"), Chat.Message("b", "y", "held", "working"), Chat.Message("c", "z", "sending")))
        val after = Chat.reduce(s, j("""{"type":"snapshot","rows":[],"held":[{"id":"b","why":"dialog"}]}"""))
        assertEquals(listOf("b" to "dialog", "c" to ""), after.messages.map { it.id to it.why })
    }

    // ---- limits (RFC 0015, Limits): what the phone says when the bridge cuts a row or refuses a long send

    private fun rowOf(json: String) = Chat.Row.parse(j(json))!!

    @Test fun aTextRowCutAt64KiBSaysOpenInTheTerminal() {
        val text = "a".repeat(64 * 1024) + "…"
        val row = rowOf(JSONObject().put("id", "r1").put("kind", "text").put("role", "assistant").put("text", text).put("cut", true).toString())
        assertEquals(Chat.CUT_NOTE, Chat.cutNote(row))
        assertNull(Chat.cutNote(rowOf("""{"id":"r2","kind":"text","role":"assistant","text":"short"}""")))
    }

    @Test fun aToolOutputCutAt8KiBSaysOpenInTheTerminalWithoutAFlag() {
        val cut = rowOf(JSONObject().put("id", "o1").put("kind", "tool-result").put("output", "x".repeat(Chat.OUTPUT_PREVIEW) + "…").toString())
        assertEquals(Chat.CUT_NOTE, Chat.cutNote(cut))
        val whole = rowOf(JSONObject().put("id", "o2").put("kind", "tool-result").put("output", "x".repeat(Chat.OUTPUT_PREVIEW)).toString())
        assertNull(Chat.cutNote(whole))
        assertNull(Chat.cutNote(rowOf("""{"id":"c1","kind":"tool-call","tool":"Bash","input":"ls"}""")))
    }

    @Test fun aSendOver32KiBRefusedByTheBridgeStaysRefusedWithItsReason() {
        val text = "é".repeat(17 * 1024)
        val refused = Chat.answered(state(), "m", text, j("""{"state":"refused","id":"m","reason":"too-long"}"""))
        val m = refused.messages.single()
        assertEquals("refused", m.state)
        assertEquals("too-long", m.reason)
        assertEquals(text, m.text)
        assertEquals("That answer is too long.", Chat.answerNotice(j("""{"state":"refused","ok":false,"reason":"too-long"}"""), dsh = true))
    }

    /** Rows hold the person's agent's text, tool output and answers: the chat code never logs or stores them (docs/privacy.md). */
    @Test fun chatCodeNeverLogsOrStoresRows() {
        val dir = java.io.File("src/main/java/ai/namastex/automagik")
        val files = dir.listFiles { f -> f.name.startsWith("Chat") && f.name.endsWith(".kt") }.orEmpty()
        assertTrue("chat sources not found from ${java.io.File(".").absoluteFile.name}", files.any { it.name == "Chat.kt" })
        val banned = Regex("""android\.util\.Log|\bLog\.[a-z]\(|\bprintln\(|\bprint\(|printStackTrace|Timber|SharedPreferences|getSharedPreferences|DataStore|openFileOutput|FileOutputStream|FileWriter|writeText|writeBytes|@Dao|@Entity|SQLiteDatabase|\.edit\(\)""")
        val hits = files.flatMap { f -> f.readLines().mapIndexedNotNull { i, l -> if (banned.containsMatchIn(l)) "${f.name}:${i + 1}: ${l.trim()}" else null } }
        assertEquals(emptyList<String>(), hits)
    }

    @Test fun refusedAndUnansweredSends() {
        val refused = Chat.answered(state(), "m", "x", j("""{"state":"refused","id":"m","reason":"empty"}"""))
        assertEquals("refused", refused.messages.single().state)
        val maybe = Chat.unanswered(state(), "m", "x")
        assertEquals("maybe", maybe.messages.single().state)
        assertTrue(ChatActions.canRetry(maybe, maybe.messages.single()))
    }

    @Test fun earlierPagesGoBeforeAndStopWhenEmpty() {
        val s = Chat.reduce(state(), j("""{"type":"rows","rows":[{"id":"1:5.0","kind":"text","text":"b"}]}"""))
        val more = Chat.earlier(s, JSONArray("""[{"id":"1:4.0","kind":"text","text":"a"},{"id":"1:5.0","kind":"text","text":"b"}]"""))
        assertEquals(listOf("1:4.0", "1:5.0"), more.rows.map { it.id })
        assertTrue(more.more)
        assertFalse(Chat.earlier(more, JSONArray()).more)
    }

    @Test fun answerNotices() {
        assertNull(Chat.answerNotice(j("""{"ok":true,"pressed":"done","sent":true}""")))
        assertEquals("The question changed; nothing was pressed.", Chat.answerNotice(j("""{"ok":false,"reason":"changed"}""")))
        assertEquals(Chat.ANSWER_ON_COMPUTER, Chat.answerNotice(j("""{"state":"refused","ok":false,"reason":"read-only"}""")))
        assertEquals("Stopped partway: the question moved on. Finish in the terminal.", Chat.answerNotice(j("""{"ok":false,"reason":"stopped","sent":true}""")))
        // Keys sent but the dialog stayed past the bridge's read-back: not taken, never a success.
        assertEquals("Not taken: answer on the Mac.", Chat.answerNotice(j("""{"ok":true,"pressed":"uncertain","sent":true}""")))
    }

    @Test fun aPendingRowSaysAnsweredOnlyWhenTheBridgeSawItTaken() {
        val s = Chat.State("t1", connected = true)
        val row = Chat.Row("approval:c1", "approval", open = true)
        assertEquals("Answered.", ChatActions.pendingNote(s, row.copy(why = "answered")))
        assertEquals("Not taken: answer on the Mac.", ChatActions.pendingNote(s, row.copy(why = "not-taken")))
        assertEquals(Chat.ANSWER_IN_TERMINAL, ChatActions.pendingNote(s, row))
    }

    @Test fun chatTabOnlyForAgentsTheBridgeReads() {
        fun t(agent: String, app: String = "", argv: List<String> = emptyList(), state: String = "live") =
            CoreTerminal("t1", "x", "/", state, "idle", agent, "", 80, 24, app = app, argv = argv)
        assertTrue(Chat.offered(t("Claude Code", app = "claude-code")))
        assertTrue(Chat.offered(t("node", argv = listOf("/usr/local/bin/codex"))))
        assertTrue(Chat.offered(t("omp")))
        assertFalse(Chat.offered(t("zsh")))
        assertFalse(Chat.offered(t("claude", app = "claude-code", state = "finished")))
        assertFalse(Chat.offered(null))
    }

    // ---- #731: a Main Bot's full DSH chat on the phone

    private fun dshLive(write: Boolean = true) = state("dsh:session-1").copy(dshWrite = write)

    /**
     * Row "a bots-dsh restart reconnects to the same chat": the bridge losing the socket (`unavailable`) or bots-dsh
     * shutting down (`closed`) keeps the chat, reconnecting; a send in flight becomes maybe, kept across the reopen
     * with Retry (same id, deduped by bots-dsh's log); the next snapshot is the same chat again.
     */
    @Test fun aBotsDshRestartKeepsTheDshChatAndResumesIt() {
        for (reason in listOf("unavailable", "closed", "timeout", "moved", "ended")) {
            val busy = blocked(dshLive()).copy(messages = listOf(Chat.Message("m", "hi", "sending")))
            val withCard = Chat.reduce(busy, j("""{"type":"approval","row":${approval()}}"""))
            val dropped = Chat.reduce(withCard, j("""{"type":"gone","reason":"$reason"}"""))
            assertFalse(reason, dropped.gone)
            assertTrue(reason, dropped.resuming)
            assertFalse(dropped.connected)
            assertEquals(Chat.RESUMING, dropped.error)
            assertNull("a card from before the drop is never answered blind", dropped.approval)
            assertFalse(ChatActions.canSend(dropped))
            assertEquals(listOf("m" to "maybe"), Chat.unknown(dropped).map { it.id to it.state })
            // The reopen (PocketViewModel.openChat) starts from the unknown messages; its snapshot is the same chat.
            val back = Chat.reduce(Chat.State("dsh:session-1", messages = Chat.unknown(dropped), dshWrite = true),
                j("""{"type":"snapshot","rows":[{"id":"r1","kind":"text","role":"assistant","text":"hello"}],"screen":[],
                "status":{"state":"idle"},"approval":null,"held":[]}"""))
            assertTrue(back.connected); assertFalse(back.resuming); assertNull(back.error)
            assertEquals(listOf("r1"), back.rows.map { it.id })
            assertTrue(ChatActions.canRetry(back, back.messages.single()))
        }
        // About a minute of automatic tries, then the Reconnect button.
        assertEquals(1_000L, Chat.resumeDelayMs(0))
        assertEquals(30_000L, Chat.resumeDelayMs(Chat.RESUME_DELAYS_MS.size - 1))
        assertNull(Chat.resumeDelayMs(Chat.RESUME_DELAYS_MS.size))
        // A terminal's chat that went away ends, as before.
        val terminal = Chat.reduce(state("t1"), j("""{"type":"gone","reason":"unavailable"}"""))
        assertTrue(terminal.gone); assertFalse(terminal.resuming); assertNull(terminal.error)
    }

    /** A subscribe bots-dsh refused ends the DSH chat and says why; an end with no reason reads Ended. */
    @Test fun aRefusedDshSubscribeEndsTheChatAndSaysWhy() {
        val hidden = Chat.reduce(dshLive(), j("""{"type":"gone","reason":"not-shown"}"""))
        assertTrue(hidden.gone); assertFalse(hidden.resuming)
        assertEquals("Show this project in Automagik first.", hidden.error)
        assertEquals("This Bot is no longer on the computer.", Chat.reduce(dshLive(), j("""{"type":"gone","reason":"not-found"}""")).error)
        val plain = Chat.reduce(dshLive(), j("""{"type":"gone"}"""))
        assertTrue(plain.gone); assertNull(plain.error)
    }

    /**
     * Row "a read-only chat cannot send and says why": a DSH chat on a bridge whose hello has no `dshWrite` has no
     * message box, and its bottom line names the cause and the way out. A chat that cannot send for any other reason
     * says so too; only a chat still connecting (the list says "Connecting chat…") has no line.
     */
    @Test fun aReadOnlyDshChatCannotSendAndSaysWhy() {
        val ro = dshLive(write = false)
        assertFalse(ChatActions.canSend(ro))
        assertEquals(ChatActions.READ_ONLY, ChatActions.whyNoSend(ro))
        assertTrue(ChatActions.READ_ONLY.contains("Pocket Link") && ChatActions.READ_ONLY.contains(Chat.ANSWER_ON_COMPUTER))
        assertNull(ChatActions.whyNoSend(dshLive()))
        assertNull(ChatActions.whyNoSend(state("t1")))
        assertEquals("This chat ended. Nothing typed here is sent.", ChatActions.whyNoSend(ro.copy(gone = true)))
        assertEquals("The machine is offline. Nothing is sent until it is back.", ChatActions.whyNoSend(dshLive().copy(offline = true)))
        val resuming = Chat.reduce(dshLive(), j("""{"type":"gone","reason":"unavailable"}"""))
        assertEquals("Reconnecting. Nothing is sent until the chat is back.", ChatActions.whyNoSend(resuming))
        // While resuming the hello may lack dshWrite (bots-dsh still down): it reads reconnecting, not read only.
        assertEquals("Reconnecting. Nothing is sent until the chat is back.", ChatActions.whyNoSend(resuming.copy(dshWrite = false)))
        assertEquals("Not connected. Nothing is sent.", ChatActions.whyNoSend(Chat.State("dsh:x", error = "Chat disconnected: hung up")))
        assertNull(ChatActions.whyNoSend(Chat.State("dsh:x")))
    }

    /**
     * Row "the Bot chats dialog says what the phone can do": a machine whose listing said `dshWrite` says writable
     * and names send and answer; one that advertised no writes says read only and why, before a send is refused;
     * with no listing yet (null) the dialog makes no claim either way.
     */
    @Test fun botChatsDialogSaysWhetherTheMachineTakesPhoneWrites() {
        val writable = ChatActions.botChatsLine(true).orEmpty()
        val readOnly = ChatActions.botChatsLine(false).orEmpty()
        assertTrue(writable.contains("Writable"))
        assertTrue(writable.contains("send") && writable.contains("answer") && writable.contains("from the phone"))
        assertTrue(readOnly.contains("Read only"))
        assertTrue(readOnly.contains("Pocket Link") && readOnly.contains("no phone writes") && readOnly.contains("on the computer"))
        assertFalse(writable.contains("Read only"))
        assertFalse(readOnly.contains("Writable"))
        assertNotEquals(writable, readOnly)
        assertNull(ChatActions.botChatsLine(null))
    }

    /**
     * Row "the Bot chats dialog claims no write state until its listing arrives": an earlier poll's `dshWrite` is
     * not shown while this load runs or after it failed, and is shown once it succeeds.
     */
    @Test fun botChatsDialogClaimsNoWriteStateWhileLoadingOrAfterAFailedRead() {
        assertNull(ChatActions.botChatsWritable(null, true))
        assertNull(ChatActions.botChatsWritable(null, false))
        assertNull(ChatActions.botChatsWritable(Result.failure<List<String>>(RuntimeException("link down")), true))
        assertNull(ChatActions.botChatsWritable(Result.failure<List<String>>(RuntimeException("link down")), false))
        assertEquals(true, ChatActions.botChatsWritable(Result.success(listOf("t1")), true))
        assertEquals(false, ChatActions.botChatsWritable(Result.success(emptyList<String>()), false))
        assertNull(ChatActions.botChatsWritable(Result.success(listOf("t1")), null))
    }

    /** Row "interrupt stops the turn and the row reads stopped": bots-dsh marks the cut assistant row `interrupted`. */
    @Test fun anInterruptedTurnReadsStopped() {
        val working = Chat.reduce(dshLive(), j("""{"type":"status","status":{"state":"working"}}"""))
        assertTrue(ChatActions.canInterrupt(working))
        assertEquals("Interrupt sent.", Chat.interruptNotice(j("""{"ok":true}"""), dsh = true))
        val cut = Chat.reduce(working, j("""{"type":"rows","rows":[{"id":"r1","kind":"text","role":"assistant","text":"Half","interrupted":true},
            {"id":"r2","kind":"text","role":"assistant","text":"Whole"},{"id":"r3","kind":"text","role":"assistant","text":"x","interrupted":"true"}]}"""))
        assertEquals(listOf(true, false, false), cut.rows.map { it.interrupted })
        assertEquals("Stopped", Chat.STOPPED)
        val idle = Chat.reduce(cut, j("""{"type":"status","status":{"state":"idle"}}"""))
        assertFalse(ChatActions.canInterrupt(idle))
    }

    /** The rows and the agent agree: the open chat's state goes into its chat.list row until the next read. */
    @Test fun theOpenChatsStateGoesIntoItsListRow() {
        fun row(t: String, status: String) = Chat.Terminal(t, "", "dsh", "Lead", status, "session")
        val list = listOf(row("dsh:session-1", "blocked"), row("dsh:session-2", "working"))
        assertEquals(listOf("idle", "working"), Chat.withStatus(list, "dsh:session-1", Chat.Status("idle")).map { it.status })
        assertSame(list, Chat.withStatus(list, "dsh:session-1", Chat.Status("blocked")))
        assertSame(list, Chat.withStatus(list, "dsh:other", Chat.Status("idle")))
        assertSame(list, Chat.withStatus(list, "dsh:session-1", Chat.Status("")))
        // Blocked: the kind and what the open card asks go with it, for the Home row; idle clears the line.
        val asked = Chat.withStatus(list, "dsh:session-1", Chat.Status("blocked", "question"), "Which branch?")
        assertEquals(listOf("question", "Which branch?"), asked[0].let { listOf(it.kind, it.msg) })
        assertEquals("", Chat.withStatus(asked, "dsh:session-1", Chat.Status("idle"))[0].msg)
        val s = Chat.reduce(Chat.State("dsh:session-1"), j("""{"type":"question","row":{"id":"q1","kind":"question","prompt":"Which branch?","open":true}}"""))
        assertEquals("Which branch?", Chat.asked(s))
        assertEquals("Bash: npm test", Chat.asked(Chat.reduce(Chat.State("dsh:x"), j("""{"type":"approval","row":{"id":"a1","kind":"approval","tool":"Bash","summary":"npm test","open":true}}"""))))
        assertEquals("", Chat.asked(Chat.State("dsh:x")))
    }

    // ---- receipts for cards that closed while the phone was away (#733, RFC 0015 "Settled requests on reconnect")

    private val CARD = "dsh:session-1:7#approval-c1"
    private fun dshApproval(id: String = CARD, open: Boolean = true) =
        """{"id":"$id","kind":"approval","source":"session","tool":"Bash","summary":"npm test","input":"npm test","call":"c1","choices":["allow","deny"],"open":$open,"answerable":true}"""
    private fun settled(id: String = CARD, by: String = "computer", outcome: String = "allow", at: Long = 1_700_000_000_000) =
        """{"id":"$id","by":"$by","outcome":"$outcome","at":$at}"""
    private fun snapshot(approval: String = "null", settled: String = "[]") =
        j("""{"type":"snapshot","rows":[],"screen":[],"status":{"state":"idle"},"approval":$approval,"held":[],"settled":$settled}""")
    /** The chat with the card open, then its link dropped: what PocketViewModel.openChat starts the reconnect from. */
    private fun away(): Chat.State {
        val withCard = Chat.reduce(blocked(dshLive()), j("""{"type":"approval","row":${dshApproval()}}"""))
        assertEquals(CARD, withCard.approval?.id)
        val dropped = Chat.reduce(withCard, j("""{"type":"gone","reason":"unavailable"}"""))
        assertNull(dropped.approval)
        return Chat.carry(dropped, Chat.State("dsh:session-1", messages = Chat.unknown(dropped), dshWrite = true, resuming = true))
    }
    private val QUESTION = "dsh:session-1:9#question-q1"
    private fun dshQuestion(id: String = QUESTION, open: Boolean = true) =
        """{"id":"$id","kind":"question","source":"session","prompt":"Which database?","options":["Postgres","SQLite"],"open":$open,"answerable":true}"""
    /** The chat with a question open, then its link dropped: a Bot asked and the screen went off. */
    private fun awayWithQuestion(): Chat.State {
        val asked = Chat.reduce(blocked(dshLive()), j("""{"type":"question","row":${dshQuestion()}}"""))
        assertEquals(QUESTION, asked.question?.id)
        assertEquals(listOf(QUESTION), asked.cards.map { it.id })
        val dropped = Chat.reduce(asked, j("""{"type":"gone","reason":"unavailable"}"""))
        assertNull(dropped.question)
        return Chat.carry(dropped, Chat.State("dsh:session-1", dshWrite = true, resuming = true))
    }
    /** A DSH chat after its link dropped again and the phone opened it once more. */
    private fun carryAgain(s: Chat.State) = Chat.carry(Chat.reduce(s, j("""{"type":"gone","reason":"unavailable"}""")),
        Chat.State("dsh:session-1", dshWrite = true, resuming = true))

    /** Row 1: disconnect, answer on the desktop, reconnect: one receipt card, naming the card, who answered, what and when. */
    @Test fun aCardAnsweredOnTheComputerWhileAwayComesBackAsOneReceipt() {
        val back = Chat.reduce(away(), snapshot(settled = "[${settled()}]"), now = 5)
        val r = back.receipts.single()
        assertEquals(listOf(CARD, "approval", "Bash: npm test", "computer", "allow", 1_700_000_000_000L), listOf(r.id, r.kind, r.label, r.by, r.outcome, r.at))
        assertTrue(r.settled)
        assertEquals("Answered on the computer while you were away: Allow", Chat.receiptText(r))
        assertEquals("Answered on the computer: Allow", Chat.doneLine(r))
        assertEquals("Omni · Approval · 14:02", Chat.receiptHeading(r, "Omni", "14:02"))
        assertEquals("Approval · 14:02", Chat.receiptHeading(r, "", "14:02"))
        assertNull("the settled entry never reopens the card", back.approval)
        assertTrue(back.connected); assertTrue(back.synced); assertTrue(back.cards.isEmpty())
        // The other outcomes read as bots-dsh recorded them, never more.
        assertEquals("Answered on the phone (Pixel 8) while you were away: Deny", Chat.receiptText(r.copy(by = "phone", name = "Pixel 8", outcome = "deny")))
        assertEquals("No longer needed", Chat.receiptText(r.copy(by = "", outcome = "withdrawn")))
        assertEquals("Answered while you were away: Option B", Chat.receiptText(r.copy(by = "", outcome = "Option B")))
    }

    /** Row 2: a second reconnect (and a `slow` resubscribe into the same state) does not duplicate the receipt. */
    @Test fun aSecondReconnectDoesNotDuplicateTheReceipt() {
        val once = Chat.reduce(away(), snapshot(settled = "[${settled()}]"))
        val again = Chat.reduce(once, snapshot(settled = "[${settled()}]"))
        assertEquals(listOf(CARD), again.receipts.map { it.id })
        val dropped = Chat.reduce(again, j("""{"type":"gone","reason":"closed"}"""))
        val third = Chat.reduce(Chat.carry(dropped, Chat.State("dsh:session-1", dshWrite = true)), snapshot(settled = "[${settled()}]"))
        assertEquals(listOf(CARD), third.receipts.map { it.id })
        assertEquals(1, third.receipts.size)
    }

    /** Row 3: a settled entry is only ever a receipt; the card the snapshot shows open stays open and is not receipted. */
    @Test fun aSettledEntryNeverReopensALiveCard() {
        // Settled while away, but nothing of it in the snapshot's approval: no card.
        val closed = Chat.reduce(away(), snapshot(approval = "null", settled = "[${settled()}]"))
        assertNull(closed.approval); assertNull(closed.question)
        assertTrue(ChatActions.choices(closed, closed.approval).isEmpty())
        // Still open on the computer (and, contradictorily, in settled[]): the live card wins and gets no receipt.
        val open = Chat.reduce(away(), snapshot(approval = dshApproval(), settled = "[${settled()}]"))
        assertEquals(CARD, open.approval?.id)
        assertTrue(open.receipts.isEmpty())
        assertEquals(listOf(CARD), open.cards.map { it.id })
        // A settled entry for a question never becomes a question card either.
        val q = Chat.reduce(away(), snapshot(settled = "[${settled("dsh:session-1:9#question-q1", outcome = "Postgres")}]"))
        assertNull(q.question); assertNull(q.approval)
        // Two receipts: the question's settled entry, then the approval card that vanished with no entry.
        assertEquals(listOf("dsh:session-1:9#question-q1" to "Postgres", CARD to ""), q.receipts.map { it.id to it.outcome })
        assertEquals("question", q.receipts.first().kind)
    }

    /** Row 4: a reconnect with nothing settled shows nothing; so does the first snapshot of a chat, whatever settled[] holds. */
    @Test fun anEmptySettledListShowsNothing() {
        val fresh = Chat.reduce(Chat.State("dsh:session-1", dshWrite = true), snapshot(settled = "[]"))
        assertTrue(fresh.receipts.isEmpty())
        val quiet = Chat.reduce(Chat.carry(Chat.reduce(fresh, j("""{"type":"gone","reason":"closed"}""")), Chat.State("dsh:session-1", dshWrite = true)), snapshot(settled = "[]"))
        assertTrue(quiet.receipts.isEmpty())
        val absent = Chat.reduce(Chat.carry(fresh, Chat.State("dsh:session-1", dshWrite = true)), j("""{"type":"snapshot","rows":[],"screen":[],"status":{"state":"idle"},"approval":null,"held":[]}"""))
        assertTrue("an older bots-dsh without settled[]", absent.receipts.isEmpty())
        // The first snapshot of a chat: settled[] is history the phone was never shown, not news.
        val history = (0 until 16).joinToString(",") { settled("dsh:session-1:$it#approval-h$it") }
        val first = Chat.reduce(Chat.State("dsh:session-1", dshWrite = true), snapshot(settled = "[$history]"))
        assertTrue(first.receipts.isEmpty())
        assertEquals(16, first.done.size)
        // ...and a reconnect after it receipts only what settled since, bounded.
        val later = Chat.reduce(Chat.carry(first, Chat.State("dsh:session-1", dshWrite = true)), snapshot(settled = "[$history,${settled("dsh:session-1:20#approval-new")}]"))
        assertEquals(listOf("dsh:session-1:20#approval-new"), later.receipts.map { it.id })
        assertEquals("", later.receipts.single().label)
        assertEquals("approval", later.receipts.single().kind)
        // A terminal's chat has no settled[] and no receipts.
        assertTrue(Chat.reduce(Chat.carry(state("t1"), Chat.State("t1")), snapshot(settled = "[${settled()}]")).receipts.isEmpty())
    }

    /** Row 5: dismissing removes the receipt, and it does not come back on the next reconnect. */
    @Test fun aDismissedReceiptDoesNotComeBack() {
        val once = Chat.reduce(away(), snapshot(settled = "[${settled()}]"))
        val dismissed = Chat.dismissReceipt(once, CARD)
        assertTrue(dismissed.receipts.isEmpty())
        val dropped = Chat.reduce(dismissed, j("""{"type":"gone","reason":"unavailable"}"""))
        val back = Chat.reduce(Chat.carry(dropped, Chat.State("dsh:session-1", dshWrite = true)), snapshot(settled = "[${settled()}]"))
        assertTrue(back.receipts.isEmpty())
        assertEquals(dismissed, Chat.dismissReceipt(dismissed, "nothing"))
    }

    /** A card that is neither open nor settled on reconnect (older than the 16 kept, or bots-dsh restarted) closes with no outcome. */
    @Test fun aCardThatVanishedWithNoSettledEntryClosesAsClosedWhileAway() {
        val back = Chat.reduce(away(), snapshot(settled = "[]"), now = 42)
        val r = back.receipts.single()
        assertEquals(listOf(CARD, "approval", "Bash: npm test", "", 42L), listOf(r.id, r.kind, r.label, r.outcome, r.at))
        assertFalse(r.settled)
        assertEquals(Chat.CLOSED_AWAY, Chat.receiptText(r))
        assertNull("no outcome is claimed on Home either", Chat.doneLine(r))
        assertNull(back.approval)
        // Once, however many reconnects.
        assertEquals(1, Chat.reduce(back, snapshot(settled = "[]")).receipts.size)
        // The same without any settled field at all (an older bots-dsh).
        assertEquals(Chat.CLOSED_AWAY, Chat.receiptText(Chat.reduce(away(), j("""{"type":"snapshot","rows":[],"screen":[],"status":{"state":"idle"},"approval":null,"held":[]}""")).receipts.single()))
    }

    /** A card the phone saw close in view is done: its settled entry on the next reconnect is not news. */
    @Test fun aCardClosedInViewIsNotReceiptedOnReconnect() {
        val withCard = Chat.reduce(blocked(dshLive()), j("""{"type":"approval","row":${dshApproval()}}"""))
        assertEquals(listOf(CARD), withCard.cards.map { it.id })
        val closed = Chat.reduce(withCard, j("""{"type":"approval","row":${dshApproval(open = false)}}"""))
        assertNull(closed.approval); assertTrue(closed.cards.isEmpty()); assertEquals(listOf(CARD), closed.done)
        val dropped = Chat.reduce(closed, j("""{"type":"gone","reason":"unavailable"}"""))
        val back = Chat.reduce(Chat.carry(dropped, Chat.State("dsh:session-1", dshWrite = true)), snapshot(settled = "[${settled()}]"))
        assertTrue(back.receipts.isEmpty())
        // A question card the same way, by its own label.
        val q = """{"id":"dsh:session-1:9#question-q1","kind":"question","prompt":"Which database?","options":["Postgres","SQLite"],"open":true,"answerable":true}"""
        val asked = Chat.reduce(dshLive(), j("""{"type":"question","row":$q}"""))
        assertEquals(listOf("question" to "Which database?"), asked.cards.map { it.kind to it.label })
        val gone = Chat.reduce(asked, j("""{"type":"gone","reason":"closed"}"""))
        val r = Chat.reduce(Chat.carry(gone, Chat.State("dsh:session-1", dshWrite = true)), snapshot(settled = "[${settled("dsh:session-1:9#question-q1", outcome = "Postgres")}]")).receipts.single()
        assertEquals("Which database?", r.label)
        assertEquals("Answered on the computer while you were away: Postgres", Chat.receiptText(r))
        assertEquals("Question", Chat.receiptHeading(r, "", ""))
    }

    /**
     * #748 High: a question still open on the computer is not in the snapshot (only the first approval is): it follows
     * as an event, so the reconnect must not receipt it as "Closed while you were away".
     */
    @Test fun aQuestionOpenOnReconnectIsNotReceipted() {
        val back = Chat.reduce(awayWithQuestion(), snapshot())
        val reAsked = Chat.reduce(back, j("""{"type":"question","row":${dshQuestion()}}"""))
        assertEquals(QUESTION, reAsked.question?.id)
        assertEquals(listOf(QUESTION), reAsked.cards.map { it.id })
        assertTrue("no receipt for the question that was still open", reAsked.receipts.none { it.id == QUESTION })
        assertTrue(reAsked.receipts.none { Chat.receiptText(it) == Chat.CLOSED_AWAY })
        assertFalse(QUESTION in reAsked.done)
    }

    /** #748 High: the question re-sent after the snapshot reopens the card, and no false receipt is left under it. */
    @Test fun aQuestionResentAfterTheSnapshotKeepsItsCardAndLosesTheReceipt() {
        val back = Chat.reduce(awayWithQuestion(), snapshot())
        val once = Chat.reduce(back, j("""{"type":"question","row":${dshQuestion()}}"""))
        val again = Chat.reduce(once, j("""{"type":"question","row":${dshQuestion()}}"""))
        assertEquals(QUESTION, again.question?.id)
        assertEquals(listOf(QUESTION), again.cards.map { it.id })
        assertTrue(again.receipts.isEmpty())
        assertFalse(QUESTION in again.done)
        assertNull(again.approval)
    }

    /** #748 High: answered on the computer after the reconnect, the reopened question's real settled outcome is shown. */
    @Test fun aQuestionAnsweredAfterTheReconnectShowsItsRealOutcome() {
        val reAsked = Chat.reduce(Chat.reduce(awayWithQuestion(), snapshot()), j("""{"type":"question","row":${dshQuestion()}}"""))
        val answered = Chat.reduce(carryAgain(reAsked), snapshot(settled = "[${settled(QUESTION, outcome = "Postgres")}]"), now = 5)
        val r = answered.receipts.single()
        assertEquals(listOf(QUESTION, "question", "Which database?", "Postgres"), listOf(r.id, r.kind, r.label, r.outcome))
        assertTrue(r.settled)
        assertEquals("Answered on the computer while you were away: Postgres", Chat.receiptText(r))
    }

    /** #748 High: with two approvals open the snapshot carries the first; the second follows as an event and stays live. */
    @Test fun aSecondOpenApprovalStaysLiveAndIsNotReceipted() {
        val second = "dsh:session-1:8#approval-c2"
        val both = Chat.reduce(Chat.reduce(blocked(dshLive()), j("""{"type":"approval","row":${dshApproval()}}""")),
            j("""{"type":"approval","row":${dshApproval(second)}}"""))
        assertEquals(listOf(CARD, second), both.cards.map { it.id })
        val back = Chat.reduce(carryAgain(both), snapshot(approval = dshApproval(), settled = "[]"))
        assertEquals(listOf(CARD), back.cards.map { it.id })
        assertEquals(CARD, back.approval?.id)
        val live = Chat.reduce(back, j("""{"type":"approval","row":${dshApproval(second)}}"""))
        assertEquals(second, live.approval?.id)
        assertEquals(listOf(CARD, second), live.cards.map { it.id })
        assertTrue("the second approval is live, never receipted", live.receipts.isEmpty())
        assertFalse(second in live.done)
        // The first, the one the snapshot carried, is untouched: still a card, still not done.
        assertEquals("Bash: npm test", live.cards.first { it.id == CARD }.label)
        assertFalse(CARD in live.done)
    }

    /** #748 Medium: a read-only question closed in view (a status, never a close event) leaves no card to receipt. */
    @Test fun aQuestionClosedByStatusDropsItsCard() {
        val asked = Chat.reduce(blocked(dshLive(write = false)), j("""{"type":"question","row":${dshQuestion()}}"""))
        assertEquals(listOf(QUESTION), asked.cards.map { it.id })
        val closed = Chat.reduce(asked, j("""{"type":"status","status":{"state":"working","kind":"","msg":""}}"""))
        assertNull(closed.question)
        assertTrue("the question card goes with the status", closed.cards.isEmpty())
        val back = Chat.reduce(Chat.carry(closed, Chat.State("dsh:session-1", dshWrite = false)),
            j("""{"type":"snapshot","rows":[],"screen":[],"status":{"state":"working"},"approval":null,"held":[]}"""))
        assertTrue(back.receipts.isEmpty())
    }

    /** Receipts are a bounded history: the newest 16 stay. */
    @Test fun receiptsAreBounded() {
        var s = Chat.reduce(Chat.State("dsh:session-1", dshWrite = true), snapshot())
        for (i in 0 until 20) {
            val dropped = Chat.reduce(Chat.reduce(s, j("""{"type":"approval","row":${dshApproval("dsh:session-1:$i#approval-c$i")}}""")), j("""{"type":"gone","reason":"closed"}"""))
            s = Chat.reduce(Chat.carry(dropped, Chat.State("dsh:session-1", dshWrite = true)), snapshot(settled = "[${settled("dsh:session-1:$i#approval-c$i")}]"))
        }
        assertEquals(Chat.MAX_RECEIPTS, s.receipts.size)
        assertEquals("dsh:session-1:19#approval-c19", s.receipts.last().id)
        assertEquals("dsh:session-1:4#approval-c4", s.receipts.first().id)
    }
}
