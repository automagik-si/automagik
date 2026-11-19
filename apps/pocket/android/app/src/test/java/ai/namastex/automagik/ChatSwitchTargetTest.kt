package ai.namastex.automagik

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Question/Approval switch as the screen draws it (#1040): each label's tap target is at
 * least 48 dp tall, measured through the semantics node's bounds. Removing the size from the
 * switch turns this red; the constant alone cannot say that.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatSwitchTargetTest {
    @get:Rule val compose = createComposeRule()

    private val question = Chat.Row(id = "q1", kind = "question", open = true,
        prompt = "Which build?")
    private val approval = Chat.Row(id = "a1", kind = "approval", open = true, tool = "Bash",
        summary = "ls")

    @Test fun theQuestionAndApprovalSwitchIsAtLeast48DpTall() {
        compose.setContent {
            ChatCardSwitch(listOf(question, approval), pinnedId = "q1", onPick = {})
        }
        for (label in listOf("Question", "Approval")) {
            val bounds = compose.onNodeWithText(label).fetchSemanticsNode().boundsInRoot
            val height = with(compose.density) { bounds.height.toDp() }
            assertTrue("$label is $height tall, under the 48 dp tap target", height >= 48.dp)
        }
    }
}
