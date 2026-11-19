package ai.namastex.automagik

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.*
import android.view.inputmethod.InputMethodManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import android.widget.Toast
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.text.style.TextOverflow
import android.view.HapticFeedbackConstants
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import androidx.compose.ui.input.pointer.pointerInput
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** The terminal composer's Send is live whenever there is a draft; a preview or a reconnect must not gray it out. */
fun terminalSendEnabled(draft: String, sending: Boolean): Boolean = draft.isNotBlank() && !sending

/**
 * Code's main view: the agent's terminal, or its Chat tab. [strip] is the agents of its space in the drawer's order (from
 * [Sidebar.spaceAgents]); a sideways swipe on the chat or on the terminal's bars goes to the next or previous one
 * ([onSwipe], [Sidebar.neighbour]), and [onDrawer] opens the spaces and bots tree.
 */
@Composable fun TerminalScreen(vm: PocketViewModel, state: PocketState, terminal: CoreTerminal?, space: PocketSpace?,
                               strip: List<Pair<TerminalRef, String>> = emptyList(), onSwipe: (Int) -> Unit = {}, onDrawer: () -> Unit = {}) {
    val ref = state.selected ?: return
    val swipe by rememberUpdatedState(onSwipe)
    val swipeable = Modifier.pointerInput(Unit) { detectAgentSwipe { swipe(it) } }
    var message by remember(ref) { mutableStateOf("") }
    var showComposer by remember(ref) { mutableStateOf(false) }
    var controls by remember(ref) { mutableStateOf(false) }
    // The Chat tab (RFC 0015 delivery 5): the same agent as a chat, over the terminal's place; Show terminal comes back.
    val chatOffered = !state.demo && Chat.offered(terminal)
    var chatView by remember(ref) { mutableStateOf(state.chatFirst) }
    val snackbar = remember { SnackbarHostState() }
    val snackbarScope = rememberCoroutineScope()
    // Dictation's messages belong to the app, above the composer, not to a system toast over the keys (#1068).
    val say: (String) -> Unit = { text -> snackbarScope.launch { snackbar.showSnackbar(text) } }
    if (chatView && chatOffered) {
        ChatPane(vm, ref, onShowTerminal = { chatView = false }, onBack = vm::backToList, modifier = Modifier.fillMaxSize().displayCutoutPadding().then(swipeable))
        return
    }
    // Full screen, scrolling back slides the space's tabs in over the terminal, like a phone browser's toolbar.
    var tabsShown by remember(ref) { mutableStateOf(false) }
    var lastScroll by remember(ref) { mutableLongStateOf(0L) }
    val onScroll: (Boolean) -> Unit = { up -> tabsShown = up; lastScroll = System.nanoTime() }
    LaunchedEffect(tabsShown, lastScroll) { if (tabsShown) { delay(6_000); tabsShown = false } }
    var focusTerminal by remember { mutableStateOf<(() -> Unit)?>(null) }
    val composerFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val fullscreen = state.terminalFullscreen
    androidx.activity.compose.BackHandler(controls || showComposer) {
        if (showComposer) { showComposer = false; keyboard?.hide() } else controls = false
    }
    LaunchedEffect(showComposer) { if (showComposer) { composerFocus.requestFocus(); keyboard?.show() } }
    val machine = state.machines[ref.hostId]
    val offline = !state.demo && machine?.connected != true
    Box(Modifier.fillMaxSize().background(TermBg).displayCutoutPadding()) {
        Column(Modifier.fillMaxSize()) {
            if (!fullscreen) TerminalTabs(vm, state, space, strip)
            // A new connection session recreates the view, which attaches the terminal again.
            key(ref, state.nativeDisplay, machine?.session) {
                if (state.nativeDisplay) NativeTerminal(vm, state.screenText, state.nativeAlternateScreen, state.fontSize, Modifier.fillMaxWidth().weight(1f), onScroll)
                else TerminalCanvas(vm, Modifier.fillMaxWidth().weight(1f), onScroll) { focusTerminal = it }
            }
            val keys = !offline && (!fullscreen || controls || keyboardVisible || showComposer)
            if (!offline) PromptChoices(vm, ref, terminal, bottom = !keys && fullscreen && !controls)
            if (offline) OfflineStrip(vm.hostName(ref.hostId), machine?.connecting == true) { vm.reconnect(ref.hostId) }
            if (keys) TerminalKeys(vm, state)
            if (showComposer) {
                SnackbarHost(snackbar, Modifier.fillMaxWidth().padding(horizontal = 10.dp))
                Row(Modifier.fillMaxWidth().background(Chrome).padding(10.dp, 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(message, { message = it }, placeholder = { Text("Message this agent…", fontSize = 12.sp) }, modifier = Modifier.weight(1f).focusRequester(composerFocus), maxLines = 4, shape = RoundedCornerShape(12.dp))
                    Dictate(onHeard = { heard -> message = dictated(message, heard) }, onSay = say)
                    val enabled = terminalSendEnabled(message, state.sending)
                    IconButton(onClick = { val draft = message; vm.sendMessage(draft) { if (message == draft) message = "" } }, enabled = enabled) {
                        if (state.sending) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Outlined.Send, "Send message", tint = if (enabled) Accent else Muted)
                    }
                    IconButton(onClick = { showComposer = false; keyboard?.hide() }) { Icon(Icons.Outlined.Close, "Close composer", tint = Muted) }
                }
            }
            if (!fullscreen || controls) Row(Modifier.fillMaxWidth().background(Chrome).then(swipeable).padding(horizontal = 10.dp).navigationBarsPadding(), verticalAlignment = Alignment.CenterVertically) {
                Text(state.terminalStatus, color = if (state.terminalStatus.startsWith("Live")) Muted else Accent, fontSize = 11.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (chatOffered) TextButton(onClick = { controls = false; showComposer = false; chatView = true }) { Text("Chat", fontSize = 12.sp) }
                IconButton(onClick = { showComposer = !showComposer; controls = false }) { Icon(Icons.Outlined.ChatBubbleOutline, "Toggle message composer", Modifier.size(20.dp), tint = if (showComposer) Accent else Muted) }
                IconButton(onClick = { controls = false; if (state.nativeDisplay) showComposer = true else focusTerminal?.invoke() }) { Icon(Icons.Outlined.Keyboard, "Open terminal keyboard", Modifier.size(22.dp), tint = Accent) }
            }
        }
        val tabbed = space != null && (space.tabs.size > 1 || space.tabs.any { ref.address in it.terminals && it.terminals.size > 1 })
        AnimatedVisibility(fullscreen && !controls && tabsShown && tabbed, Modifier.align(Alignment.TopCenter).fillMaxWidth(),
            enter = slideInVertically { -it } + fadeIn(), exit = slideOutVertically { -it } + fadeOut()) {
            Column(Modifier.fillMaxWidth().background(Chrome.copy(alpha = .97f)).padding(end = 52.dp)) {
                TerminalTabs(vm, state, space, strip)
                HorizontalDivider(color = Border)
            }
        }
        if (fullscreen && !controls) Surface(color = Chrome.copy(alpha = .80f), shape = RoundedCornerShape(12.dp), modifier = Modifier.align(Alignment.TopEnd).padding(4.dp)) {
            IconButton(onClick = { controls = true }) { Icon(Icons.Outlined.MoreHoriz, "Terminal controls", tint = Muted) }
        }
        if (fullscreen && controls) Column(Modifier.align(Alignment.TopCenter).fillMaxWidth().background(Chrome.copy(alpha = .97f))) {
            Row(Modifier.fillMaxWidth().then(swipeable), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = vm::backToList) { Icon(Icons.Outlined.ArrowBack, "Back to agents") }
                IconButton(onClick = { controls = false; onDrawer() }) { Icon(Icons.Outlined.Menu, "Spaces and bots") }
                Text(terminal?.title ?: ref.address, modifier = Modifier.weight(1f), fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (chatOffered) TextButton(onClick = { controls = false; showComposer = false; chatView = true }) { Text("Chat") }
                IconButton(onClick = { controls = false; vm.setTerminalFullscreen(false) }) { Icon(Icons.Outlined.FullscreenExit, "Exit full screen") }
                IconButton(onClick = { controls = false }) { Icon(Icons.Outlined.Close, "Hide terminal controls") }
            }
            TerminalTabs(vm, state, space, strip)
            HorizontalDivider(color = Border)
        }
    }
}

@Composable private fun TerminalTabs(vm: PocketViewModel, state: PocketState, space: PocketSpace?, strip: List<Pair<TerminalRef, String>>) {
    val ref = state.selected ?: return
    if (space != null && space.tabs.isNotEmpty()) Row(Modifier.fillMaxWidth().background(Chrome).horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        space.tabs.forEach { tab ->
            val active = ref.address in tab.terminals
            Column(Modifier.widthIn(min = 90.dp).clickable(enabled = tab.terminals.isNotEmpty()) { vm.selectTerminal(TerminalRef(ref.hostId, tab.terminals.first())) }) {
                Row(Modifier.padding(14.dp, 13.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Terminal, null, Modifier.size(13.dp), tint = if (active) Accent else Muted)
                    Spacer(Modifier.width(7.dp)); Text(tab.name.ifBlank { state.machines[ref.hostId]?.terminals?.find { it.address in tab.terminals }?.title ?: "Terminal" }, color = if (active) Ink else Muted, fontSize = 11.sp)
                }
                Box(Modifier.fillMaxWidth().height(2.dp).background(if (active) Accent else Color.Transparent))
            }
        }
    }
    // The agent strip: the space's agents as the drawer orders them, one tap each; a terminal the tree doesn't list
    // (a plain shell) keeps its tab's terminals.
    val currentTab = space?.tabs?.find { ref.address in it.terminals }
    if (strip.size > 1) Row(Modifier.fillMaxWidth().background(Chrome).horizontalScroll(rememberScrollState()).padding(10.dp, 0.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        strip.forEach { (agent, label) ->
            FilterChip(selected = agent == ref, onClick = { vm.selectTerminal(agent) }, label = { Text(label, fontSize = 10.sp) })
        }
    }
    else if (currentTab != null && currentTab.terminals.size > 1) Row(Modifier.fillMaxWidth().background(Chrome).horizontalScroll(rememberScrollState()).padding(10.dp, 0.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        currentTab.terminals.forEach { address ->
            val t = state.machines[ref.hostId]?.terminals?.find { it.address == address }
            FilterChip(selected = address == ref.address, onClick = { vm.selectTerminal(TerminalRef(ref.hostId, address)) }, label = { Text(t?.title ?: address, fontSize = 10.sp) })
        }
    }
}

/**
 * While the agent is blocked on a menu (a permission or a question), its answers as buttons under the terminal, so
 * answering never depends on hitting a line of the screen. A press goes through [PocketViewModel.choose], which reads
 * the screen again and sends the keys only if the same dialog text and menu are still there. The row goes when the
 * menu does.
 */
@Composable private fun PromptChoices(vm: PocketViewModel, ref: TerminalRef, terminal: CoreTerminal?, bottom: Boolean) {
    val kind = terminal?.kind.orEmpty()
    val msg = terminal?.message.orEmpty()
    val asking = terminal?.attention == true && kind in Prompt.KINDS
    var menu by remember(ref) { mutableStateOf<Prompt.Menu?>(null) }
    var sending by remember(ref) { mutableStateOf(false) }
    var reread by remember(ref) { mutableIntStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(ref, asking, kind, msg, terminal?.turn, reread) {
        if (!asking) { menu = null; return@LaunchedEffect }
        // The prompt may draw a moment after the status, and the person may move its cursor or answer by keys. Not while
        // the app is stopped: this loop keeps running when the screen is not drawn.
        Background.poll(lifecycle.started(), 1_500) { vm.readMenu(ref) }.collect { menu = it }
    }
    val shown = menu?.takeIf { asking } ?: return
    val choices = Prompt.choices(kind, shown, limit = Prompt.ALL)
    if (choices.isEmpty()) return
    Row(Modifier.fillMaxWidth().background(Chrome).then(if (bottom) Modifier.navigationBarsPadding() else Modifier)
        .horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (kind == "permission") "Allow?" else "Answer", color = Muted, fontSize = 12.sp)
        choices.forEachIndexed { i, choice ->
            Button(onClick = { sending = true; vm.answer(ref, msg, shown.dialog, shown.options, choice) { sending = false; reread++ } },
                enabled = !sending, shape = RoundedCornerShape(10.dp), contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                modifier = Modifier.heightIn(min = 44.dp),
                colors = if (i == 0) ButtonDefaults.buttonColors(containerColor = Accent, contentColor = OnAccent)
                    else ButtonDefaults.buttonColors(containerColor = Raised, contentColor = Ink)) {
                Text("${choice.index + 1}. ${choice.button}", fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 260.dp))
            }
        }
    }
}

@Composable private fun OfflineStrip(host: String, connecting: Boolean, onReconnect: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(Blocked.copy(alpha = .12f)).padding(start = 16.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Dot(if (connecting) Working else Blocked, 7); Spacer(Modifier.width(10.dp))
        Text(if (connecting) "Reconnecting to $host…" else "Disconnected from $host", fontSize = 13.sp, color = Ink,
            modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (connecting) CircularProgressIndicator(Modifier.padding(14.dp).size(18.dp), strokeWidth = 2.dp)
        else TextButton(onClick = onReconnect) { Text("Reconnect") }
    }
}

private data class BarKey(val label: String, val bytes: String, val description: String = label, val repeats: Boolean = false)
private val barKeys = listOf(
    BarKey("tab", "\t", "Tab"), BarKey("⇧tab", "\u001b[Z", "Shift Tab"),
    BarKey("↑", "\u001b[A", "Up", true), BarKey("↓", "\u001b[B", "Down", true),
    BarKey("←", "\u001b[D", "Left", true), BarKey("→", "\u001b[C", "Right", true),
    BarKey("enter", "\r", "Enter"), BarKey("^C", "\u0003", "Control C"),
    BarKey("home", "\u001b[H", "Home"), BarKey("end", "\u001b[F", "End"),
    BarKey("pg up", "\u001b[5~", "Page up", true), BarKey("pg dn", "\u001b[6~", "Page down", true),
    BarKey("/", "/", "Slash"), BarKey("-", "-", "Dash"), BarKey("|", "|", "Pipe"), BarKey("~", "~", "Tilde"))

@Composable private fun TerminalKeys(vm: PocketViewModel, state: PocketState) {
    val view = LocalView.current
    val clipboard = LocalClipboardManager.current
    val enabled = !state.demo
    fun tap(action: () -> Unit) { view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP); action() }
    Row(Modifier.fillMaxWidth().background(Chrome).horizontalScroll(rememberScrollState()).padding(6.dp), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        KeyCap("esc", "Escape", enabled) { tap { vm.pressKey("\u001b".toByteArray()) } }
        KeyCap("ctrl", if (state.modifiers.ctrl) "Control, armed for the next key" else "Control", enabled, active = state.modifiers.ctrl) { tap(vm::toggleCtrl) }
        KeyCap("alt", if (state.modifiers.alt) "Alt, armed for the next key" else "Alt", enabled, active = state.modifiers.alt) { tap(vm::toggleAlt) }
        barKeys.forEach { key -> KeyCap(key.label, key.description, enabled, repeats = key.repeats) { tap { vm.pressKey(key.bytes.toByteArray()) } } }
        KeyCap(null, "Paste clipboard", enabled, icon = Icons.Outlined.ContentPaste) { tap { clipboard.getText()?.text?.let(vm::paste) } }
    }
}

/** A key that types on tap and, for cursor-style keys, repeats while held. Dragging scrolls the bar without typing. */
@Composable private fun KeyCap(label: String?, description: String, enabled: Boolean, active: Boolean = false, repeats: Boolean = false,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null, onPress: () -> Unit) {
    val press by rememberUpdatedState(onPress)
    val scope = rememberCoroutineScope()
    val repeated = remember { booleanArrayOf(false) }
    Surface(shape = RoundedCornerShape(7.dp), color = if (active) Accent else Raised, modifier = Modifier.height(42.dp).widthIn(min = 42.dp)
        .semantics(mergeDescendants = true) { role = Role.Button; contentDescription = description; onClick { if (enabled) press(); enabled } }
        .pointerInput(enabled, repeats) {
            if (!enabled) return@pointerInput
            detectTapGestures(
                onPress = {
                    if (repeats) {
                        repeated[0] = false
                        val job = scope.launch { delay(380); repeated[0] = true; while (isActive) { press(); delay(55) } }
                        tryAwaitRelease(); job.cancel()
                    }
                },
                onTap = { if (!repeated[0]) press() })
        }) {
        Box(Modifier.padding(horizontal = 13.dp), contentAlignment = Alignment.Center) {
            val tint = if (active) Chrome else if (enabled) Ink else Muted
            if (icon != null) Icon(icon, null, Modifier.size(18.dp), tint = tint)
            else Text(label.orEmpty(), color = tint, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
        }
    }
}

/** Opens a terminal's web link in the browser. A link whose text may differ from its target is confirmed first. */
@Composable fun rememberLinkOpener(): (String, Boolean) -> Unit {
    val context = LocalContext.current
    var asking by remember { mutableStateOf<String?>(null) }
    asking?.let { url ->
        AlertDialog(onDismissRequest = { asking = null }, title = { Text("Open this link?") },
            text = { SelectionContainer { Text(url, fontSize = 13.sp, lineHeight = 19.sp, color = Muted) } },
            confirmButton = { TextButton(onClick = { asking = null; openInBrowser(context, url) }) { Text("Open") } },
            dismissButton = { TextButton(onClick = { asking = null }) { Text("Cancel") } })
    }
    return remember(context) { { url, confirm -> Links.browsable(url)?.let { if (confirm) asking = it else openInBrowser(context, it) } } }
}

private fun openInBrowser(context: Context, url: String) {
    val intent = Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try { context.startActivity(intent) } catch (_: ActivityNotFoundException) { Toast.makeText(context, "No app can open this link", Toast.LENGTH_SHORT).show() }
}

@Composable fun NativeTerminal(vm: PocketViewModel, text: String, alternate: Boolean, fontSize: Int, modifier: Modifier, onScroll: (Boolean) -> Unit = {}) {
    val reportScroll by rememberUpdatedState(onScroll)
    // While pinching, the size previews locally and is saved when the fingers lift.
    var pinchSize by remember { mutableStateOf<Int?>(null) }
    val size = pinchSize ?: fontSize
    val currentSize by rememberUpdatedState(fontSize)
    val lineSp = (size * 18f / 13f).sp
    val style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = size.sp, lineHeight = lineSp, letterSpacing = 0.sp, color = TermInk)
    val measure = rememberTextMeasurer()
    val width = measure.measure("M", style).size.width.coerceAtLeast(1)
    val density = LocalDensity.current
    val lineHeight = with(density) { lineSp.toPx() }
    val padding = with(density) { 16.dp.toPx() }
    val vertical = rememberScrollState()
    val horizontal = rememberScrollState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(text, alternate) {
        val follow = alternate || vertical.value >= vertical.maxValue - (lineHeight * 2).toInt()
        if (follow) { withFrameNanos { }; vertical.scrollTo(vertical.maxValue) }
    }
    val gestures = if (alternate) Modifier.pointerInput(alternate, lineHeight) {
        var pending = 0f
        detectVerticalDragGestures(
            onDragStart = { pending = 0f },
            onVerticalDrag = { change, amount ->
                change.consume(); pending -= amount
                val lines = (pending / lineHeight).toInt()
                if (kotlin.math.abs(lines) >= 3) { vm.scrollNative(lines); reportScroll(lines < 0); pending = 0f }
            }
        )
    } else Modifier.nestedScroll(remember {
        // Only the person's drags and flings arrive here; following new output scrolls without them.
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (kotlin.math.abs(available.y) > 1f) reportScroll(available.y > 0)
                return Offset.Zero
            }
        }
    }).verticalScroll(vertical)
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    val pinching = pinchSize != null
    LaunchedEffect(viewport, width, lineHeight, pinching) {
        // Resize the remote program once, after the pinch, not for every preview size.
        if (viewport == IntSize.Zero || pinching) return@LaunchedEffect
        delay(120) // Settle keyboard and pinch changes before resizing the remote terminal.
        vm.nativeReady(((viewport.width - padding) / width).toInt(), ((viewport.height - padding) / lineHeight).toInt())
    }
    val pinch = Modifier.pointerInput(Unit) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val start = currentSize
            var zoom = 1f
            do {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                if (event.changes.count { it.pressed } >= 2) {
                    zoom *= event.calculateZoom()
                    pinchSize = (start * zoom).roundToInt().coerceIn(FONT_SIZES)
                    event.changes.forEach { it.consume() }
                }
            } while (event.changes.any { it.pressed })
            val chosen = pinchSize
            if (chosen != null && chosen != start) vm.setFontSize(chosen) else pinchSize = null
        }
    }
    LaunchedEffect(fontSize) { pinchSize = null }
    val openLink = rememberLinkOpener()
    val shown = text.ifBlank { "Connecting…" }
    val linked = remember(shown) {
        buildAnnotatedString {
            append(shown)
            val style = TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline))
            for (range in Links.find(shown)) {
                val url = shown.substring(range)
                addLink(LinkAnnotation.Url(url, style) { openLink(url, false) }, range.first, range.last + 1)
            }
        }
    }
    Box(modifier.background(TermBg).onSizeChanged { viewport = it }.then(pinch).padding(8.dp)) {
        SelectionContainer {
            Text(linked, style = style, softWrap = false,
                modifier = Modifier.fillMaxSize().then(gestures).horizontalScroll(horizontal))
        }
        if (!alternate && vertical.value < vertical.maxValue - lineHeight * 2) {
            SmallFloatingActionButton(onClick = { scope.launch { vertical.animateScrollTo(vertical.maxValue) } }, modifier = Modifier.align(Alignment.BottomEnd), containerColor = Raised) {
                Icon(Icons.Outlined.ArrowDownward, "Latest output", tint = Accent)
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
@Composable fun TerminalCanvas(vm: PocketViewModel, modifier: Modifier, onScroll: (Boolean) -> Unit = {}, focus: ((() -> Unit)?) -> Unit) {
    val reportScroll by rememberUpdatedState(onScroll)
    val context = LocalContext.current
    val handler = remember { Handler(Looper.getMainLooper()) }
    val webView = remember { WebView(context) }
    val openLink by rememberUpdatedState(rememberLinkOpener())
    DisposableEffect(webView) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        var disposed = false
        val selectedAtCreation = vm.state.value.selected
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()
        webView.setBackgroundColor(TermBgArgb)
        webView.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = false
            allowFileAccess = false; allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // Requests are intercepted below; only bundled assets can load.
            blockNetworkLoads = false
            setSupportMultipleWindows(false)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse =
                loader.shouldInterceptRequest(request.url) ?: WebResourceResponse("text/plain", "UTF-8", java.io.ByteArrayInputStream(byteArrayOf()))
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest) = true
        }
        webView.addJavascriptInterface(object {
            @JavascriptInterface fun failed(message: String) {
                if (BuildConfig.DEBUG) android.util.Log.e("HerdrTerminal", message.take(500))
                handler.post { if (!disposed) vm.rendererFailed() }
            }
            @JavascriptInterface fun ready(cols: Int, rows: Int) { handler.post { if (!disposed) vm.terminalReady(cols, rows) } }
            @JavascriptInterface fun resized(cols: Int, rows: Int) { handler.post { if (!disposed) vm.resized(cols, rows) } }
            @JavascriptInterface fun input(value: String) {
                if (value.length > 2 * 1024 * 1024) return
                runCatching { Base64.decode(value, Base64.NO_WRAP) }.onSuccess {
                    if (!disposed && vm.state.value.selected == selectedAtCreation) vm.type(it)
                }
            }
            @JavascriptInterface fun painted(revision: Long, channel: Int, count: Int) { if (!disposed) vm.acknowledge(revision, channel, count) }
            @JavascriptInterface fun scrolled(up: Boolean) { handler.post { if (!disposed) reportScroll(up) } }
            @JavascriptInterface fun fontSize(size: Int) { handler.post { if (!disposed) vm.setFontSize(size) } }
            // The page never navigates; links it reports are checked and handed to the browser.
            @JavascriptInterface fun openUrl(url: String, confirm: Boolean) { handler.post { if (!disposed) openLink(url, confirm) } }
        }, "Pocket")
        vm.resetTerminal = { revision -> handler.post { if (!disposed) webView.evaluateJavascript("window.resetTerminal($revision)", null) } }
        vm.terminalBytes = { revision, channel, bytes ->
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(bytes.size, offset + 24 * 1024)
                val encoded = Base64.encodeToString(bytes.copyOfRange(offset, end), Base64.NO_WRAP)
                handler.post { if (!disposed) webView.evaluateJavascript("window.output($revision,$channel,${JSONObject.quote(encoded)})", null) }
                offset = end
            }
        }
        focus {
            webView.requestFocus()
            webView.evaluateJavascript("window.focusTerminal()") {
                (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT)
            }
        }
        webView.loadUrl("https://appassets.androidplatform.net/assets/terminal/index.html?font=${vm.state.value.fontSize}")
        onDispose {
            disposed = true; vm.detach(); vm.resetTerminal = null; vm.terminalBytes = null; focus(null)
            webView.removeJavascriptInterface("Pocket"); webView.stopLoading(); webView.destroy()
        }
    }
    // A stopped app's page and its JS timers pause; the stream itself is let go by PocketViewModel.streams.
    LifecycleStartEffect(webView) { webView.started(true); onStopOrDispose { webView.started(false) } }
    AndroidView(factory = { webView }, modifier = modifier)
}
