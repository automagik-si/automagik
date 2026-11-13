package ai.namastex.automagik

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** A card's menu read: [done] separates "not read yet" from a read that found no menu. */
private data class MenuRead(val menu: Prompt.Menu?, val done: Boolean)

/**
 * One answer: the view-model callback records it, while the card's scope only plays the motion. A deck closed
 * during the confirm window still counts the answer; a cancelled scope only skips the animation.
 */
class DeckSend(private val scope: CoroutineScope, private val record: (String) -> Unit,
               private val finish: (sent: Boolean) -> Unit, private val returnMotion: suspend () -> Unit) {
    fun send(key: String, dispatch: (done: (Boolean) -> Unit) -> Unit, exit: suspend () -> Unit) {
        val result = CompletableDeferred<Boolean>()
        scope.launch {
            withTimeoutOrNull(Teams.DECK_EXIT_MS) { exit() }
            if (result.await()) finish(true) else { returnMotion(); finish(false) }
        }
        dispatch { sent ->
            if (sent) record(key)
            result.complete(sent)
        }
    }
}

/** The deck's answers and requests seen, kept in PocketApp so opening a card and coming Back keeps them. */
class DeckMemory {
    var answered by mutableStateOf(setOf<String>())
    var gone by mutableStateOf(setOf<String>())
    var seen by mutableIntStateOf(0)
    /** The deck reached All clear: the next open starts a new count, while a mid-deck close keeps it. */
    var complete by mutableStateOf(false)

    companion object {
        val Saver = listSaver<DeckMemory, Any>(
            save = { listOf(it.answered.toList(), it.gone.toList(), it.seen, it.complete) },
            restore = { saved ->
                DeckMemory().apply {
                    answered = (saved.getOrNull(0) as? List<*>)?.filterIsInstance<String>()?.toSet().orEmpty()
                    gone = (saved.getOrNull(1) as? List<*>)?.filterIsInstance<String>()?.toSet().orEmpty()
                    seen = saved.getOrNull(2) as? Int ?: 0
                    complete = saved.getOrNull(3) as? Boolean ?: false
                }
            })
    }
}

/**
 * Home's needs-you deck: one card per entry of Home's own Needs you list. Swipe right for Yes, left for No, up for
 * the agent; the same three buttons sit under the card. A card with a chat and no terminal menu opens its chat instead.
 * After the last answer, the all clear says how many requests were answered and the bot hops once.
 *
 * [cards] is Home's reachable list, [offline] the entries on machines that are not connected now. A future "Answer
 * all" button opens this same screen.
 */
@Composable fun DeckScreen(cards: List<Teams.DeckCard>, chats: List<Teams.DeckCard>, offline: List<Teams.DeckCard>,
                           vm: PocketViewModel, connected: Boolean, memory: DeckMemory, message: String?,
                           onClose: () -> Unit, onOpen: (TerminalRef) -> Unit, onBackHome: () -> Unit) {
    BackHandler(onBack = onClose)
    LaunchedEffect(cards.size) { memory.seen = maxOf(memory.seen, cards.size) }
    val answered = memory.answered
    val gone = memory.gone
    val offlineWaiting = offline.count { Teams.deckKey(it) !in answered }
    val waiting = (memory.seen - answered.size).coerceAtLeast(0)
    val view = Teams.deckView(cards, gone, connected, waiting, offlineWaiting, chats)
    LaunchedEffect(view is Teams.DeckView.Clear) { memory.complete = view is Teams.DeckView.Clear }
    // The card being answered stays composed through its exit, even if Home has already dropped it.
    var leaving by remember { mutableStateOf<Teams.DeckCard?>(null) }
    val showing = leaving ?: (view as? Teams.DeckView.Cards)?.cards?.firstOrNull()
    // Read the cards behind the top one before they arrive, so a swipe does not show a terminal-only frame.
    val menuCache = remember { mutableStateMapOf<String, MenuRead>() }
    val visible = (view as? Teams.DeckView.Cards)?.cards.orEmpty()
    LaunchedEffect(visible.map { Teams.deckKey(it) }) {
        for (c in visible.drop(1)) {
            val key = Teams.deckKey(c)
            if (c.chat == null && menuCache[key] == null) menuCache[key] = MenuRead(vm.readMenu(c.ref), true)
        }
    }
    Box(Modifier.fillMaxSize().background(Canvas).clickable(enabled = false) {}.statusBarsPadding().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                if (view is Teams.DeckView.Clear && leaving == null) {
                    // The all-clear screen has no Needs-you header; it keeps the close control.
                    Spacer(Modifier.weight(1f))
                } else {
                    Text("Needs you", color = Ink, fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    if (view is Teams.DeckView.Cards) {
                        Box(Modifier.clip(RoundedCornerShape(16.dp)).background(amber().copy(alpha = .15f))
                            .border(1.dp, amber().copy(alpha = .5f), RoundedCornerShape(16.dp)).padding(horizontal = 12.dp, vertical = 5.dp)) {
                            Text("${view.cards.size} left", color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.width(8.dp))
                    }
                }
                IconButton(onClick = onClose) { Icon(Icons.Outlined.Close, "Close the deck", tint = Muted) }
            }
            val card = showing
            if (card != null) {
                val key = Teams.deckKey(card)
                val cached = menuCache[key]
                val cardsNow = (view as? Teams.DeckView.Cards)?.cards.orEmpty()
                val under = Teams.deckUnder(cardsNow, leaving?.let(Teams::deckKey))
                val next = under.next
                val behind = under.behind
                key(key) {
                    DeckCard(vm, card, next = next, behind = behind,
                        initialMenu = cached?.menu, initialMenuDone = cached?.done == true, modifier = Modifier.weight(1f),
                        onSending = { leaving = card },
                        onAnswered = {
                            memory.answered = memory.answered + key
                            memory.gone = memory.gone + key
                        },
                        onGone = { sent ->
                            if (leaving?.let(Teams::deckKey) == key) leaving = null
                            // The "You chose" strip leaves with the card it answers.
                            if (sent) vm.dismissMessage()
                        },
                        onOpen = { onOpen(card.ref) })
                }
            } else when (view) {
                is Teams.DeckView.Chats -> ChatEnd(view.cards, onOpen, onClose, Modifier.weight(1f))
                Teams.DeckView.Clear -> DeckEnd(Teams.DONE, "All clear", if (answered.isEmpty()) "No bot is waiting on you."
                    else "You answered ${answered.size} ${if (answered.size == 1) "request" else "requests"}. Your bots are back to work.",
                    celebrate = answered.isNotEmpty(), action = "Back to Home", onAction = onBackHome, Modifier.weight(1f))
                is Teams.DeckView.Offline -> DeckEnd(Teams.ASLEEP, "Offline: can't answer",
                    if (view.waiting == 1) "1 bot was waiting when the connection dropped. Reconnect to answer."
                    else "${view.waiting} bots were waiting when the connection dropped. Reconnect to answer.",
                    celebrate = false, action = "Back to Home", onAction = onClose, Modifier.weight(1f))
                is Teams.DeckView.Cards -> Unit
            }
        }
        // The Scaffold's snackbar sits under this layer; answer outcomes overlay it here without moving the card.
        message?.takeIf { it.isNotBlank() }?.let {
            Text(it, color = Ink, fontSize = 13.sp, lineHeight = 18.sp, textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 193.dp).fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp)).background(Raised).border(1.dp, Border, RoundedCornerShape(12.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp))
        }
    }
}

/** The end when terminal cards are done but Bot-chat requests still wait: each one is a tap away. */
@Composable private fun ChatEnd(cards: List<Teams.DeckCard>, onOpen: (TerminalRef) -> Unit, onClose: () -> Unit, modifier: Modifier) {
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(1f))
        Text("Waiting on a chat", color = Ink, fontSize = 24.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text("These requests are waiting in their Bot chats. Open one to answer there.", color = Muted,
            fontSize = 14.sp, lineHeight = 20.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(16.dp))
        cards.forEach { card ->
            val where = if (card.message == Chat.ANSWER_ON_COMPUTER || card.message == Cockpit.READ_ONLY) "On computer" else "In chat"
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Surface).border(1.dp, Border, RoundedCornerShape(12.dp))
                .padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(card.title, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(listOf(card.where, where).filter { it.isNotBlank() }.joinToString(" · "), color = Muted, fontSize = 12.sp, maxLines = 1)
                }
                TextButton(onClick = { onOpen(card.ref) }) {
                    Text("Open chat", color = Accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.height(8.dp))
        }
        Spacer(Modifier.weight(1f))
        Button(onClick = onClose, modifier = Modifier.fillMaxWidth().height(54.dp), shape = RoundedCornerShape(27.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = OnAccent)) {
            Text("Back to Home", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** The deck's end: all clear (one hop of Genie's) or offline (no celebration: nothing was answered). */
@Composable private fun DeckEnd(pose: String, title: String, text: String, celebrate: Boolean, action: String,
                                onAction: () -> Unit, modifier: Modifier) {
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(1f))
        PetView(Teams.GENIE, pose, 132.dp, celebrate = if (celebrate) Unit else null)
        Spacer(Modifier.height(12.dp))
        Text(title, color = Ink, fontSize = 28.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(text, color = Muted, fontSize = 16.sp, lineHeight = 24.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.weight(1f))
        Button(onClick = onAction, modifier = Modifier.fillMaxWidth().height(54.dp), shape = RoundedCornerShape(27.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = OnAccent)) {
            Text(action, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/**
 * One card: who asks, the project, what it asks, the pending commands read off its screen, and the three answers.
 * A permission's Yes and No go through [PocketViewModel.answer] with the dialog text, as the terminal's buttons do;
 * anything the phone can't read, and every chat card, is answered by opening it.
 */
@Composable private fun DeckCard(vm: PocketViewModel, card: Teams.DeckCard, next: Teams.DeckCard?, behind: Int,
                                 initialMenu: Prompt.Menu?, initialMenuDone: Boolean, modifier: Modifier,
                                 onSending: () -> Unit, onAnswered: () -> Unit, onGone: (sent: Boolean) -> Unit,
                                 onOpen: () -> Unit) {
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Read again every 2 s, as the terminal screen does: a menu that wasn't drawn yet, or changed, shows its answers.
    // Not while the app is stopped ([Background.poll]). A chat card has no terminal menu to read.
    var sending by remember { mutableStateOf(false) }
    var read by remember(card.ref, card.chat) { mutableStateOf(initialMenuDone) }
    val menu by produceState<Prompt.Menu?>(initialMenu, card.ref, card.chat) {
        if (card.chat != null) { value = null; read = true; return@produceState }
        Background.poll(lifecycle.started(), 2_000) { vm.readMenu(card.ref) }.collect {
            // A leaving card keeps the menu it was answered from; the agent is moving on by then.
            value = Teams.deckMenu(value, it, sending)
            read = true
        }
    }
    val waitingForMenu = !read && card.chat == null && card.kind == "permission"
    val choices = remember(menu, card.kind, card.chat) {
        if (card.chat == null && card.kind == "permission") Prompt.choices(card.kind, menu) else emptyList()
    }
    val yes = choices.firstOrNull()
    val no = choices.lastOrNull()?.takeIf { choices.size >= 2 }
    val dx = remember { Animatable(0f) }
    val dy = remember { Animatable(0f) }
    val threshold = with(LocalDensity.current) { 110.dp.toPx() }
    val amber = amber()
    fun send(choice: Prompt.Choice?, direction: Float) {
        val m = menu ?: return
        if (choice == null || sending) return
        sending = true
        onSending()
        view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
        // The card travels off while the agent confirms, so it never parks at the edge; a rejected answer returns it.
        val short = if (choice.index == yes?.index) "Yes" else if (choice.index == no?.index) "No" else choice.button
        DeckSend(scope = scope, record = { onAnswered() }, finish = { sent ->
            if (!sent) sending = false
            onGone(sent)
        }, returnMotion = {
            dx.animateTo(0f, tween(180))
            dy.animateTo(0f, tween(180))
        }).send(Teams.deckKey(card), dispatch = { done ->
            vm.answer(card.ref, card.message, m.dialog, m.options, choice, short = short) { sent -> done(sent) }
        }, exit = { dx.animateTo(direction * 1400f, tween(500)) })
    }
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.weight(1f).fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
            // The cards still waiting, peeking out under this one; the next one shows its own who/project.
            for (i in minOf(behind, 2) downTo 1) {
                Box(Modifier.fillMaxWidth(1f - i * .05f).fillMaxHeight(.92f).offset(y = (i * 10).dp)
                    .clip(RoundedCornerShape(24.dp)).background(Surface.copy(alpha = 1f - i * .3f)).border(1.dp, Border, RoundedCornerShape(24.dp))) {
                    if (i == 1 && next != null) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            PeekHeader(next, Alignment.Start)
                            Spacer(Modifier.weight(1f))
                            if (next.where.isNotBlank()) Text(next.where, color = Muted, fontSize = 12.sp, maxLines = 1,
                                overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.weight(1f))
                            PeekHeader(next, Alignment.End)
                        }
                    }
                }
            }
            Box(Modifier.fillMaxWidth().fillMaxHeight(.94f)
                .graphicsLayer { translationX = dx.value; translationY = dy.value; rotationZ = dx.value / 40f }) {
                Column(Modifier.fillMaxSize()
                    .clip(RoundedCornerShape(24.dp)).background(Surface).border(1.5.dp, amber.copy(alpha = .65f), RoundedCornerShape(24.dp))
                    .pointerInput(card.ref, yes, no, card.chat) {
                        detectDragGestures(onDragEnd = {
                            scope.launch {
                                when (Teams.swipe(dx.value, dy.value, threshold, yes != null && menu != null, no != null && menu != null)) {
                                    Teams.Swipe.YES -> send(yes, 1f)
                                    Teams.Swipe.NO -> send(no, -1f)
                                    Teams.Swipe.OPEN -> { launch { dx.animateTo(0f) }; dy.animateTo(0f); onOpen() }
                                    Teams.Swipe.NONE -> { launch { dx.animateTo(0f) }; dy.animateTo(0f) }
                                }
                            }
                        }) { change, drag -> change.consume(); scope.launch { dx.snapTo(dx.value + drag.x); dy.snapTo(minOf(0f, dy.value + drag.y)) } }
                    }.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Dot(amber, 8); Spacer(Modifier.width(8.dp))
                        Text(card.where.ifBlank { "Home" }, color = Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f))
                        Text(listOf(card.agent, Teams.time(card.statusMs, System.currentTimeMillis())).filter { it.isNotBlank() }.joinToString(" · "),
                            color = Muted, fontSize = 12.sp, maxLines = 1)
                    }
                    Spacer(Modifier.weight(.55f))
                    PetView(Teams.GENIE, Teams.NEEDS_YOU, 104.dp)
                    Spacer(Modifier.height(10.dp))
                    Text(card.title, color = Ink, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(statusLabel("blocked", card.kind), color = amber, fontSize = 13.sp)
                    Spacer(Modifier.height(12.dp))
                    Text(card.message.ifBlank { if (card.opensChat) "Waiting for your reply" else "Waiting for you" }, color = Ink,
                        fontSize = 17.sp, lineHeight = 24.sp, textAlign = TextAlign.Center, maxLines = 4, overflow = TextOverflow.Ellipsis)
                    if (waitingForMenu) {
                        Spacer(Modifier.height(10.dp))
                        Box(Modifier.fillMaxWidth().heightIn(min = 76.dp).clip(RoundedCornerShape(12.dp)).background(Canvas).padding(12.dp),
                            contentAlignment = Alignment.CenterStart) {
                            Text("Reading the agent's menu…", color = Muted, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                        }
                    } else menu?.dialog?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(10.dp))
                        Text(it, color = Ink, fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 19.sp, maxLines = 6,
                            overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Canvas).padding(12.dp))
                    }
                    Spacer(Modifier.weight(1f))
                    Text(when {
                        card.opensChat -> "Swipe up, or tap Open chat, to answer there"
                        waitingForMenu -> "Reading the agent's menu…"
                        yes != null -> "Swipe right for Yes, left for No"
                        else -> "Answer this one in its terminal: swipe up"
                    }, color = Muted, fontSize = 12.sp, textAlign = TextAlign.Center)
                }
                // The stamps sit on the card and move with it, as the mock draws them.
                val lean = (dx.value / threshold).coerceIn(-1f, 1f)
                if (lean > .1f && yes != null) Stamp("YES", Ok, lean, Modifier.align(Alignment.TopStart).padding(start = 22.dp, top = 86.dp))
                if (lean < -.1f && no != null) Stamp("NO", Blocked, -lean, Modifier.align(Alignment.TopEnd).padding(end = 22.dp, top = 86.dp))
            }
        }
        Text("← No  ·  ↑ Open  ·  Yes →", color = Muted, fontSize = 12.sp)
        Spacer(Modifier.height(10.dp))
        // The same three answers as buttons, at thumb's reach.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = { send(no, -1f) }, enabled = no != null && !sending, modifier = Modifier.weight(1f).height(56.dp)) { Text("No") }
            OutlinedButton(onClick = onOpen, modifier = Modifier.weight(1f).height(56.dp)) { Text(if (card.opensChat) "Open chat" else "Open") }
            Button(onClick = { send(yes, 1f) }, enabled = yes != null && !sending, modifier = Modifier.weight(1f).height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Ok)) { Text("Yes") }
        }
    }
}

/** The same next-card header at both edges, so a left or right drag reveals the mascot and name. */
@Composable private fun PeekHeader(next: Teams.DeckCard, alignment: Alignment.Horizontal) {
    Column(horizontalAlignment = alignment) {
        PetView(Teams.GENIE, Teams.NEEDS_YOU, 26.dp)
        Spacer(Modifier.height(2.dp))
        Text(next.title, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable private fun Stamp(text: String, color: Color, alpha: Float, modifier: Modifier) {
    // The whole stamp (frame and letters) is one alpha layer, so the frame keeps its corners as it fades.
    Box(modifier.graphicsLayer { rotationZ = if (text == "YES") -14f else 14f; this.alpha = alpha }
        .border(3.dp, color, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 2.dp)) {
        Text(text, color = color, fontSize = 30.sp, fontWeight = FontWeight.Black)
    }
}
