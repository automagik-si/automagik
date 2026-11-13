package ai.namastex.automagik

import android.os.Bundle
import androidx.activity.compose.LocalActivity
import androidx.compose.ui.platform.LocalView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import android.content.Intent
import android.os.Build
import android.Manifest
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.launch
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.UUID


class MainActivity : ComponentActivity() {
    private val vm get() = (application as PocketApplication).vm
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) { openLink(intent); openAlert(intent); openUpdate(intent) }
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(0xfffbf6ee.toInt(), 0xff262029.toInt())
        )
        setContent {
            AutomagikTheme {
                PocketApp(vm)
            }
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); openLink(intent); openAlert(intent); openUpdate(intent) }
    // A waiting update doesn't install under someone using the app.
    override fun onUserInteraction() { super.onUserInteraction(); Updater.touched() }
    // The "ready" notification: show Settings → About, where the update's progress is, and run Android's confirm flow.
    private fun openUpdate(intent: Intent?) {
        if (intent?.action != Updater.ACTION_INSTALL) return
        vm.navigate(Nav.SETTINGS)
        Updater.installFromNotification(this)
        setIntent(Intent(this, MainActivity::class.java))
    }
    // A notification's tap opens its agent.
    private fun openAlert(intent: Intent?) {
        val ref = Notify.opened(intent) ?: return
        vm.selectTerminal(ref)
        setIntent(Intent(this, MainActivity::class.java))
    }
    // A pairing link from outside the app is only offered: the person confirms it in the app.
    private fun openLink(intent: Intent?) {
        val link = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString ?: return
        vm.offerPairing(link)
        setIntent(Intent(this, MainActivity::class.java))
    }
}

@Composable fun Brand(size: Int = 28) {
    Image(painterResource(R.drawable.automagik), "Automagik", Modifier.size(size.dp).clip(RoundedCornerShape((size / 4).dp)))
}
@Composable @ReadOnlyComposable fun stateColor(word: String) = when (word) { "blocked", "error" -> Blocked; "working" -> Working; "done" -> Done; else -> Muted }
fun stateName(word: String) = when (word) { "blocked" -> "Needs you"; "working" -> "Working"; "done" -> "Done"; "error" -> "Error"; "idle" -> "Idle"; else -> "Terminal" }

@Composable fun Dot(color: Color, size: Int = 6) { Box(Modifier.size(size.dp).background(color, CircleShape)) }
@Composable fun SmallLabel(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), modifier, color = Muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.4.sp)
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable fun PocketApp(vm: PocketViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var pairDesktop by remember { mutableStateOf(false) }
    // Pocket Link's QR code; a cancelled scan returns no contents, and leaves a legacy SSH card it came from as it was.
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result -> vm.scanned(result.contents) }
    fun scan() { scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the code in Pocket Link").setBeepEnabled(false).setOrientationLocked(false)) }
    // A legacy SSH machine's "Pair with QR" ([LegacySsh]): straight to the scanner; the pairing replaces that card.
    fun repair(host: HostProfile) { vm.repairWithQr(host.id); scan() }
    // The pairing dialog closes once a pairing it started finishes (the outcome shows as a message).
    var wasPairing by remember { mutableStateOf(false) }
    LaunchedEffect(state.pairing) { if (wasPairing && !state.pairing) pairDesktop = false; wasPairing = state.pairing }
    // Pairing started from the general dialog replaces no legacy SSH card, whatever an earlier scan left behind.
    LaunchedEffect(pairDesktop) { if (pairDesktop) vm.cancelRepair() }
    var editHost by remember { mutableStateOf<HostProfile?>(null) }
    var newTerminal by remember { mutableStateOf(false) }
    // Home's swipe deck. It lives here, not inside Home, so a later "Answer all" button opens the same screen.
    var deckOpen by rememberSaveable { mutableStateOf(false) }
    /** Whether the open terminal/chat came from the deck, so Back returns to the deck instead of Home. */
    var deckReturn by rememberSaveable { mutableStateOf(false) }
    /** The deck's answers and seen count, kept across a card's terminal/chat and a configuration change. */
    val deckMemory = rememberSaveable(saver = DeckMemory.Saver) { DeckMemory() }
    val openDeck: () -> Unit = {
        // A closed mid-deck session keeps its count; a new one after All clear starts fresh.
        if (deckMemory.complete) {
            deckMemory.answered = emptySet(); deckMemory.gone = emptySet(); deckMemory.seen = 0; deckMemory.complete = false
        }
        deckOpen = true
    }
    // The preview's deck session does not outlive the preview, so Exit clears its answered count.
    LaunchedEffect(state.demo) {
        deckMemory.answered = emptySet(); deckMemory.gone = emptySet(); deckMemory.seen = 0; deckMemory.complete = false
        if (!state.demo) deckOpen = false
    }
    /** The machine whose Automagik Bot chats are listed (read only). */
    var botChats by remember { mutableStateOf<String?>(null) }
    val selected = state.selected
    // A selection that did not come from the deck closes it; one that did (deckReturn) comes back to it on Back.
    LaunchedEffect(selected) {
        val (open, fromDeck) = Teams.deckAfterSelection(deckOpen, deckReturn, selected)
        deckOpen = open
        deckReturn = fromDeck
    }
    val space = state.space?.let { (host, id) -> state.machines[host]?.spaces?.find { it.id == id } }
    val terminal = selected?.let { state.machines[it.hostId]?.terminals?.find { t -> t.address == it.address } }
    // The open terminal's own space, for its tabs; the space screen under it may be another one or none.
    val terminalSpace = selected?.let { ref -> state.machines[ref.hostId]?.spaces?.find { ref.address in it.addresses } }
    val immersive = selected != null && state.terminalFullscreen
    val activity = LocalActivity.current
    val view = LocalView.current
    DisposableEffect(immersive) {
        val bars = activity?.window?.let { WindowCompat.getInsetsController(it, view) }
        bars?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (immersive) bars?.hide(WindowInsetsCompat.Type.systemBars())
        else bars?.show(WindowInsetsCompat.Type.systemBars())
        onDispose { bars?.show(WindowInsetsCompat.Type.systemBars()) }
    }
    val disconnected = state.machines.values.none { it.connected || it.terminals.isNotEmpty() }
    // Hosts in the order they were saved, then any others: what the spaces tree, Projects and Tasks read.
    val sidebar = state.hosts.mapNotNull { h -> state.machines[h.id]?.let { m -> SidebarHost(h.id, h.name, m.connected, m.spaces, m.terminals, m.linked, m.colors, m.git, m.space, m.bots, m.members) } } +
        state.machines.filterKeys { id -> state.hosts.none { it.id == id } }.map { (id, m) -> SidebarHost(id, vm.hostName(id), m.connected, m.spaces, m.terminals, m.linked, m.colors, m.git, m.space, m.bots, m.members) }
    val teams = rememberTeams(state, vm)
    // The Bots' `dsh:` chats, for Team's bubbles and Home's rows: a main bot's pane opens its DSH chat (RFC 0015 D29).
    val dsh = rememberDshChats(state, vm, reading = selected == null && state.screen in setOf(Nav.TEAM, Nav.HOME_TAB))
    val paneChats = remember(teams, dsh) { Teams.paneChats(Teams.bubbles(teams, dsh)) }
    // Home counts the Bots' chats with the terminals: a chat that needs the person is a row, a Bot with a pane one row (#732).
    val watched by vm.chatWatch.collectAsStateWithLifecycle()
    val writes by vm.botWrites.collectAsStateWithLifecycle()
    val chats = remember(dsh, watched, writes, teams) { Cockpit.chats(dsh, watched, writes, teams, System.currentTimeMillis()) }
    val pulse = remember(sidebar, state.seen, chats) { Projects.pulse(sidebar, state.seen, chats) }
    // What the deck's "Open" opens: the Bot chat when the row has one, else the terminal (Home's own row rule).
    val openFromDeck: (TerminalRef) -> Unit = { ref ->
        val target = if (Chat.isDsh(ref.address)) ref else pulse.fromChat[ref] ?: paneChats[ref] ?: ref
        vm.selectTerminal(target, row = ref.takeIf { target != ref })
    }
    // Repositories and branches re-check every minute while a screen shows them; otherwise only when work stops.
    val gitScreen = selected == null && state.screen == Nav.CODE
    LaunchedEffect(gitScreen) { vm.gitShown(gitScreen) }
    LaunchedEffect(state.message) { state.message?.let { snackbar.showSnackbar(it); vm.dismissMessage() } }
    // Self-update runs in the background and speaks through notifications (see Updater); the screen only opens Android's
    // confirm prompt for an install the person started, and continues after the install permission screen.
    val update by Updater.state.collectAsStateWithLifecycle()
    LaunchedEffect(update) {
        when (val u = update) {
            is UpdateState.Confirm -> { runCatching { activity?.startActivity(u.intent) }; Updater.confirming(u.release) }
            is UpdateState.Available -> if (Updater.takeStartWhenFound()) activity?.let(Updater::start)
            else -> {}
        }
    }
    LifecycleResumeEffect(Unit) { activity?.let(Updater::resume); onPauseOrDispose { } }
    // A stopped screen (the app left, or the screen off) lets go of the terminal and chat streams; a start takes them back.
    LifecycleStartEffect(Unit) { vm.setForeground(true); vm.streams(true); onStopOrDispose { vm.setForeground(false); vm.streams(false) } }
    // Android 13+ asks before an app's first notification: once, when a machine first connects.
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val anyConnected = state.machines.values.any { it.connected }
    LaunchedEffect(anyConnected) {
        if (anyConnected && Build.VERSION.SDK_INT >= 33 && vm.shouldAskNotifications()) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    LaunchedEffect(Unit) {
        if (CrashLog.announce() && snackbar.showSnackbar("Automagik closed unexpectedly last time", "Report", duration = SnackbarDuration.Long) == SnackbarResult.ActionPerformed)
            vm.navigate(Nav.SETTINGS)
    }
    BackHandler(selected != null || state.screen != Nav.HOME || state.space != null || state.project != null) { vm.back() }
    val project = state.project?.let { key -> pulse.projects.find { it.key == key } }
    val root = selected == null && state.space == null && state.project == null && state.screen in Nav.TABS
    // Kept here, not in the tabs, so a terminal opened from a tab comes back to the same view of it.
    var codeView by rememberSaveable { mutableStateOf(CodeView.SPACES) }
    var tasksOnly by rememberSaveable { mutableStateOf(false) }
    val keyboard = WindowInsets.isImeVisible
    // Code, the desktop's Herdr window made mobile: the spaces and bots tree opens as a drawer over the terminal, and a
    // sideways swipe goes to the next or previous agent of the space, in the tree's order.
    val rows = remember(sidebar, state.folded) { Sidebar.rows(sidebar, vm.programs, state.folded) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }
    LaunchedEffect(selected == null) { if (selected == null) drawer.snapTo(DrawerValue.Closed) }
    val swipe: (Int) -> Unit = { step -> selected?.let { Sidebar.neighbour(rows, it, step) }?.let(vm::selectTerminal) }
    val strip = remember(rows, selected) { selected?.let { Sidebar.strip(rows, it) }.orEmpty() }
    ModalNavigationDrawer(drawerState = drawer, gesturesEnabled = drawer.isOpen, drawerContent = {
        ModalDrawerSheet(drawerContainerColor = Canvas) {
            Text("Spaces", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(20.dp, 18.dp, 20.dp, 4.dp))
            SpacesTree(state, vm, pulse, rows, tasksOnly, { tasksOnly = it }) { scope.launch { drawer.close() } }
        }
    }) {
    Scaffold(containerColor = Canvas, snackbarHost = { SnackbarHost(snackbar) },
        modifier = Modifier.imePadding(),
        contentWindowInsets = if (immersive) WindowInsets(0, 0, 0, 0) else ScaffoldDefaults.contentWindowInsets,
        topBar = {
            if (!immersive) Column(Modifier.background(Chrome).statusBarsPadding()) {
                val swiping by rememberUpdatedState(swipe)
                Row(Modifier.fillMaxWidth().height(60.dp).then(if (selected != null) Modifier.pointerInput(Unit) { detectAgentSwipe { swiping(it) } } else Modifier)
                    .padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (selected == null && !root) IconButton(onClick = { vm.back() }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") }
                    else if (selected == null) { Spacer(Modifier.width(8.dp)); Brand(25); Spacer(Modifier.width(11.dp)) }
                    else IconButton(onClick = { scope.launch { drawer.open() } }) { Icon(Icons.Outlined.Menu, "Spaces and bots") }
                    Column(Modifier.weight(1f)) {
                        val (title, subtitle) = when {
                            selected != null -> (terminal?.title ?: selected.address) to (terminalSpace?.name ?: "Terminal")
                            space != null -> space.name to "Space"
                            project != null -> project.name to project.remote.ifBlank { null }
                            state.screen == Nav.SETTINGS -> "Settings" to "${pulse.machines} connected"
                            state.screen == Nav.CODE -> "Code" to pulse.projects.size.let { if (it == 1) "1 project" else "$it projects" }
                            state.screen == Nav.TEAM -> "Team" to teams.sumOf { it.bots.size }.let { n ->
                                "${if (n == 1) "1 bot" else "$n bots"} · ${teams.sumOf { it.working }} working" }
                            else -> "Home" to "${pulse.machines} ${if (pulse.machines == 1) "machine" else "machines"} · ${pulse.spaces} ${if (pulse.spaces == 1) "space" else "spaces"}"
                        }
                        Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        subtitle?.let { Text(it, fontSize = 12.sp, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                    if (selected != null) {
                        IconButton(onClick = { vm.setTerminalFullscreen(true) }) { Icon(Icons.Outlined.Fullscreen, "Full screen terminal", tint = Accent) }
                        IconButton(onClick = vm::backToList) { Icon(Icons.Outlined.Close, "Back to agents", tint = Muted) }
                    }
                    if (root && state.screen == Nav.HOME_TAB && state.machines.values.any { it.connected } && !state.demo)
                        IconButton(onClick = { newTerminal = true }) { Icon(Icons.Outlined.Add, "New terminal", tint = Accent) }
                    if (root && state.screen == Nav.SETTINGS) IconButton(onClick = { pairDesktop = true }) { Icon(Icons.Outlined.Add, "Pair a machine", tint = Accent) }
                }
                (update as? UpdateState.Downloading)?.takeIf { it.manual }?.let { LinearProgressIndicator(progress = { it.progress }, Modifier.fillMaxWidth().height(2.dp), color = Accent, trackColor = Border) }
                    ?: HorizontalDivider(color = Border)
                if (state.demo) Row(Modifier.fillMaxWidth().background(Accent.copy(alpha = .09f)).padding(start = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Interface preview · sample data", color = Accent, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    TextButton(onClick = vm::leaveDemo) { Text("Exit", fontSize = 12.sp) }
                }
            }
        },
        // The terminal has the whole screen; the keyboard has the bar's place while it is up.
        bottomBar = { if (Nav.barShown(Nav.Place(state.screen, state.project, state.space, selected)) && !keyboard) PocketTabs(state.screen, pulse.homeNeedsYou, teams.sumOf { it.needsYou }) { vm.navigate(it) } }
    ) { padding ->
        CompositionLocalProvider(LocalIconsVersion provides state.iconsVersion) { Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                // An Automagik Bot's chat has no terminal: the chat alone (writes only with the bridge's dshWrite).
                selected != null && Chat.isDsh(selected.address) -> ChatPane(vm, selected, onShowTerminal = null, onBack = vm::backToList, modifier = Modifier.fillMaxSize())
                selected != null -> TerminalScreen(vm, state, terminal, terminalSpace, strip, swipe) { scope.launch { drawer.open() } }
                space != null -> OverviewScreen(state, space, vm, pulse, paneChats, onAll = vm::showAll)
                state.screen == Nav.SETTINGS -> SettingsScreen(state, vm, MachineActions(pair = { pairDesktop = true }, repair = ::repair, connect = { vm.connect(it) },
                    edit = { editHost = it }, disconnect = { vm.disconnect(it) }, remove = vm::removeHost, botChats = { botChats = it.id }))
                state.screen == Nav.CODE && project != null -> ProjectScreen(state, vm, project, pulse, remember(rows, project) { Projects.tree(rows, project) })
                state.screen == Nav.CODE -> CodeScreen(state, vm, pulse, rows, codeView, { codeView = it }, tasksOnly) { tasksOnly = it }
                // Team opens from the cache while no machine is connected; with nothing cached, the welcome shows instead.
                state.screen == Nav.TEAM && !(disconnected && teams.isEmpty()) -> TeamsScreen(state, vm, teams, dsh) { opens ->
                    when (opens) {
                        is Teams.Opens.DshChat -> vm.selectTerminal(opens.ref)
                        is Teams.Opens.TerminalChat -> vm.selectTerminal(opens.ref, chat = true)
                        Teams.Opens.NotShown -> Unit
                    }
                }
                disconnected -> WelcomeScreen(state, onPair = { pairDesktop = true }, onRepair = ::repair, onConnect = { vm.connect(it) }, onPreview = vm::enterDemo)
                else -> OverviewScreen(state, null, vm, pulse, paneChats, onAll = vm::showAll, onReviewNeedsYou = openDeck)
            }
        } }
    }
    }
    if (deckOpen && selected == null) {
        // Home's own Needs you list, the one its count tiles and cards use: a chat row as a chat card, a terminal row
        // with its menu. A future "Answer all" button only has to call openDeck.
        val needs = pulse.sections.firstOrNull { it.rank == Cockpit.BLOCKED }?.entries.orEmpty()
        val all = Teams.deckCards(needs, pulse.fromChat) { ref ->
            state.machines[ref.hostId]?.spaces?.find { ref.address in it.addresses }?.name ?: vm.hostName(ref.hostId)
        }
        // A disconnected machine keeps its terminals in the reading; its cards move to the offline end, not the deck.
        // A chat the phone cannot write to is not a deck card: it could never be answered or cleared.
        val cards = all.filter { state.machines[it.ref.hostId]?.connected == true && Teams.deckAnswerable(it) }
        val chats = Teams.deckChats(all.filter { state.machines[it.ref.hostId]?.connected == true })
        val offline = all.filter { state.machines[it.ref.hostId]?.connected != true }
        DeckScreen(cards, chats, offline, vm, anyConnected, deckMemory, state.message, onClose = { deckOpen = false },
            onOpen = { ref -> deckReturn = true; openFromDeck(ref) },
            onBackHome = { deckOpen = false })
    }
    vm.sheet.collectAsStateWithLifecycle().value?.let { StatsSheetHost(it, onDismiss = vm::closeStats) }
    if (pairDesktop) PairDialog(state.pairing, onDismiss = { pairDesktop = false }, onScan = ::scan, onPair = vm::pair)
    state.offeredPairing?.let { link -> ConfirmPairDialog(link, onPair = { vm.pair(link) }, onCancel = vm::dismissOfferedPairing) }
    editHost?.takeIf { it.paired }?.let { host -> PairedHostDialog(host, onDismiss = { editHost = null }, onSave = { vm.saveHost(it); editHost = null }) }
    botChats?.let { id -> BotChatsDialog(vm, id) { botChats = null } }
    if (newTerminal) NewTerminalDialog(state, onDismiss = { newTerminal = false }) { host, cwd, command -> vm.startTerminal(host, cwd, command); newTerminal = false }
}

/** The bottom bar: Home, Team, Code, Settings ([Nav.TABS]); the counts on them are [Nav.badge]. */
@Composable fun PocketTabs(current: String, needsYou: Int, botsNeedYou: Int, onTab: (String) -> Unit) {
    Column {
        HorizontalDivider(color = Border)
        NavigationBar(containerColor = Chrome, tonalElevation = 0.dp) {
            listOf(Triple(Nav.HOME_TAB, "Home", Icons.Outlined.Home), Triple(Nav.TEAM, "Team", Icons.Outlined.Groups), Triple(Nav.CODE, "Code", Icons.Outlined.Code),
                Triple(Nav.SETTINGS, "Settings", Icons.Outlined.Settings)).forEach { (screen, label, icon) ->
                NavigationBarItem(selected = current == screen, onClick = { onTab(screen) }, label = { Text(label, fontSize = 12.sp) },
                    icon = {
                        val count = Nav.badge(screen, needsYou, botsNeedYou)
                        if (count > 0) BadgedBox(badge = { Badge(containerColor = Blocked, contentColor = OnAccent) { Text(count.toString()) } }) { Icon(icon, null) }
                        else Icon(icon, null)
                    },
                    colors = NavigationBarItemDefaults.colors(selectedIconColor = Accent, selectedTextColor = Accent, indicatorColor = Accent.copy(alpha = .12f),
                        unselectedIconColor = Muted, unselectedTextColor = Muted))
            }
        }
    }
}

@Composable fun WelcomeScreen(state: PocketState, onPair: () -> Unit, onRepair: (HostProfile) -> Unit, onConnect: (HostProfile) -> Unit, onPreview: () -> Unit) {
    val returning = state.hosts.isNotEmpty()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 32.dp), verticalArrangement = Arrangement.Center) {
        Surface(color = Raised, shape = RoundedCornerShape(22.dp), modifier = Modifier.size(if (returning) 64.dp else 80.dp)) {
            Box(contentAlignment = Alignment.Center) { Brand(if (returning) 40 else 50) }
        }
        Spacer(Modifier.height(if (returning) 26.dp else 34.dp)); SmallLabel("Pick up where you left off")
        Spacer(Modifier.height(16.dp)); Text("Your herd,\nin your pocket.", fontSize = if (returning) 30.sp else 35.sp, lineHeight = if (returning) 36.sp else 42.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-1).sp)
        if (returning) {
            // Returning users get one-tap connect instead of a detour through Machines.
            Spacer(Modifier.height(28.dp))
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                state.hosts.forEach { host -> QuickConnectRow(host, state.machines[host.id] ?: MachineState(), state.linkedFor(host), state.pairing) { if (host.legacySsh) onRepair(host) else onConnect(host) } }
            }
            Row(Modifier.padding(top = 6.dp)) {
                TextButton(onClick = onPair) { Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(17.dp)); Spacer(Modifier.width(6.dp)); Text("Pair a desktop") }
            }
        } else {
            Spacer(Modifier.height(18.dp)); Text("The same agents. The same terminals.\nConnect to your machine and keep going.", color = Muted, fontSize = 15.sp, lineHeight = 24.sp)
            Spacer(Modifier.height(36.dp))
            Button(onClick = onPair, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(12.dp)) {
                Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(19.dp)); Spacer(Modifier.width(8.dp)); Text("Pair with Herdr desktop", fontWeight = FontWeight.SemiBold)
            }
        }
        TextButton(onClick = onPreview, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Explore the interface", color = Muted, fontSize = 13.sp) }
        Spacer(Modifier.height(36.dp)); HorizontalDivider(color = Border); Spacer(Modifier.height(20.dp))
        Row(verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Outlined.Terminal, null, Modifier.size(16.dp), tint = Muted); Spacer(Modifier.width(10.dp)); Text("Connects to your existing herdr-core through Pocket Link", color = Muted, fontSize = 12.sp) }
    }
}

/** [onConnect]: Connect, or for a legacy SSH machine ([LegacySsh]) "Pair with QR"; [pairing] holds that while one runs. */
@Composable fun QuickConnectRow(host: HostProfile, machine: MachineState, linked: List<LinkedMachine>, pairing: Boolean, onConnect: () -> Unit) {
    val legacy = host.legacySsh
    Surface(shape = RoundedCornerShape(14.dp), color = Surface, border = BorderStroke(1.dp, Border),
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).clickable(enabled = if (legacy) !pairing else !machine.connecting, onClick = onConnect)) {
        Column(Modifier.padding(16.dp, 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Computer, null, Modifier.size(22.dp), tint = if (legacy) Muted else Accent); Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(host.name, fontWeight = FontWeight.Medium, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(host.address, fontSize = 12.sp, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.width(8.dp))
                if (legacy) FilledTonalButton(onClick = onConnect, enabled = !pairing) { Text(LegacySsh.ACTION) }
                else if (machine.connecting) CircularProgressIndicator(Modifier.padding(horizontal = 18.dp).size(20.dp), strokeWidth = 2.dp)
                else FilledTonalButton(onClick = onConnect) { Text("Connect") }
            }
            if (linked.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text("Also reaches " + linked.joinToString(", ") { it.name }, fontSize = 12.sp, color = Muted, lineHeight = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            machine.error?.let { Spacer(Modifier.height(10.dp)); Text(it, color = Blocked, fontSize = 12.sp, lineHeight = 17.sp, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun OverviewScreen(state: PocketState, space: PocketSpace?, vm: PocketViewModel, pulse: Projects.Pulse,
                               paneChats: Map<TerminalRef, TerminalRef>, onAll: () -> Unit, onReviewNeedsYou: () -> Unit = {}) {
    // A main bot's pane opens the bot's DSH chat, as its Team bubble does ([Teams.paneChats]); any other agent its terminal.
    val open: (TerminalRef) -> Unit = { ref -> vm.selectTerminal(paneChats[ref] ?: ref, row = ref) }
    var search by remember { mutableStateOf("") }
    val all = state.machines.flatMap { (host, machine) -> machine.terminals.filter { it.live }.map { TerminalRef(host, it.address) to it } }
    val scoped = all.filter { (ref, _) -> space == null || (ref.hostId == state.space?.first && ref.address in space.addresses) }
    val shown = scoped.filter { (_, t) -> search.isBlank() || "${t.title} ${t.agent} ${t.cwd} ${t.message}".contains(search, true) }
    // The cockpit (every machine, no search): what needs the person, then what finished; the rest one tap away.
    val cockpit = space == null && search.isBlank()
    val sections = remember(pulse) { pulse.sections.associateBy { it.rank } }
    fun count(rank: Int) = sections[rank]?.entries?.size ?: 0
    var everything by rememberSaveable { mutableStateOf(false) }
    // Machines whose connection dropped or failed; their terminal list may be stale.
    val offline = if (state.demo) emptyList() else state.hosts.filter { h -> state.machines[h.id]?.offline == true }
    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = vm::refreshAll, modifier = Modifier.fillMaxSize()) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp, 24.dp, 20.dp, 32.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(offline, key = { "offline:${it.id}" }) { host ->
            val machine = state.machines[host.id] ?: MachineState()
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Blocked.copy(alpha = .1f)).border(1.dp, Blocked.copy(alpha = .3f), RoundedCornerShape(12.dp)).padding(start = 14.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Dot(if (machine.connecting) Working else Blocked, 7); Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f).padding(vertical = 10.dp)) {
                    Text(if (machine.connecting) "Reconnecting to ${host.name}…" else "${host.name} is disconnected", fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (!machine.connecting) machine.error?.let { Text(it, fontSize = 11.sp, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
                if (machine.connecting) CircularProgressIndicator(Modifier.padding(14.dp).size(18.dp), strokeWidth = 2.dp)
                else TextButton(onClick = { vm.reconnect(host.id) }) { Text("Reconnect") }
            }
        }
        // Today: the counts and nothing else above the agents; spent today joins them once a usage meter reports.
        if (space == null) item(key = "today") {
            val needsYou = pulse.homeNeedsYou
            val fontScale = LocalDensity.current.fontScale
            val tile = TodayTiles.heightDp(fontScale)
            val spend = rememberSpend(state).takeIf { !it.coverage.none }
            if (fontScale >= 1.2f) {
                // At a large font the four counts become two rows, so every label keeps the same 12sp size.
                Column(verticalArrangement = Arrangement.spacedBy(TodayTiles.GAP_DP.dp)) {
                    Row(Modifier.fillMaxWidth().height(tile), horizontalArrangement = Arrangement.spacedBy(TodayTiles.GAP_DP.dp)) {
                        CountCard(needsYou, if (needsYou == 1) "needs you" else "need you", Blocked, Modifier.weight(1f).fillMaxHeight(),
                            onClick = if (needsYou > 0) onReviewNeedsYou else null)
                        CountCard(pulse.working, "working", Working, Modifier.weight(1f).fillMaxHeight())
                    }
                    Row(Modifier.fillMaxWidth().height(tile), horizontalArrangement = Arrangement.spacedBy(TodayTiles.GAP_DP.dp)) {
                        CountCard(pulse.machines, "connected", Ink, Modifier.weight(1f).fillMaxHeight())
                        if (spend != null) SpendCount(spend, Modifier.weight(1f).fillMaxHeight()) else Spacer(Modifier.weight(1f))
                    }
                }
            } else {
                Row(Modifier.fillMaxWidth().height(tile), horizontalArrangement = Arrangement.spacedBy(TodayTiles.GAP_DP.dp)) {
                    CountCard(needsYou, if (needsYou == 1) "needs you" else "need you", Blocked, Modifier.weight(1f).fillMaxHeight(),
                        onClick = if (needsYou > 0) onReviewNeedsYou else null)
                    CountCard(pulse.working, "working", Working, Modifier.weight(1f).fillMaxHeight())
                    CountCard(pulse.machines, "connected", Ink, Modifier.weight(1f).fillMaxHeight())
                    spend?.let { SpendCount(it, Modifier.weight(1f).fillMaxHeight()) }
                }
            }
            Spacer(Modifier.height(12.dp))
            val focus = LocalFocusManager.current
            OutlinedTextField(value = search, onValueChange = { search = it }, placeholder = { Text("Find an agent or terminal…", fontSize = 14.sp) },
                leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(18.dp)) }, singleLine = true, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth(),
                trailingIcon = { if (search.isNotEmpty()) IconButton(onClick = { search = "" }) { Icon(Icons.Outlined.Close, "Clear search", Modifier.size(18.dp)) } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
                colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Border, focusedBorderColor = Accent, unfocusedContainerColor = Surface))
            if (needsYou > 0) {
                Spacer(Modifier.height(10.dp))
                val request = amber()
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(request.copy(alpha = .14f))
                    .clickable(onClick = onReviewNeedsYou).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Dot(request, 8); Spacer(Modifier.width(10.dp))
                    Text(if (needsYou == 1) "1 needs you" else "$needsYou need you", fontWeight = FontWeight.SemiBold,
                        fontSize = 14.sp, modifier = Modifier.weight(1f))
                    Text("Review", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        if (space != null) item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SmallLabel(space.folder.ifBlank { "Space" }, Modifier.weight(1f))
                Row(verticalAlignment = Alignment.CenterVertically) { Dot(Ok); Spacer(Modifier.width(6.dp)); Text("${state.machines.values.count { it.connected }} connected", color = Muted, fontSize = 12.sp) }
            }
            Spacer(Modifier.height(12.dp))
            Text(space.name, fontSize = 30.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-.7).sp)
            Spacer(Modifier.height(6.dp))
            Text(if (scoped.any { it.second.attention }) "A little attention goes a long way." else "Everything in this space, in one place.", color = Muted, fontSize = 13.sp)
            Spacer(Modifier.height(24.dp))
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Surface).border(1.dp, Border, RoundedCornerShape(12.dp)).padding(vertical = 17.dp)) {
                Stat(scoped.count { it.second.attention }, "Needs you", Blocked, Modifier.weight(1f))
                Box(Modifier.width(1.dp).height(32.dp).background(Border))
                Stat(scoped.count { it.second.status == "working" }, "Working", Working, Modifier.weight(1f))
                Box(Modifier.width(1.dp).height(32.dp).background(Border))
                Stat(scoped.count { (r, t) -> t.status == "done" && Cockpit.seenKey(r, t) !in state.seen }, "Done", Done, Modifier.weight(1f))
            }
            Spacer(Modifier.height(18.dp))
            val focus = LocalFocusManager.current
            OutlinedTextField(value = search, onValueChange = { search = it }, placeholder = { Text("Find an agent or terminal…", fontSize = 14.sp) },
                leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(18.dp)) }, singleLine = true, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth(),
                trailingIcon = { if (search.isNotEmpty()) IconButton(onClick = { search = "" }) { Icon(Icons.Outlined.Close, "Clear search", Modifier.size(18.dp)) } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
                colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Border, focusedBorderColor = Accent, unfocusedContainerColor = Surface))
            Spacer(Modifier.height(8.dp))
        }
        fun location(ref: TerminalRef) = state.machines[ref.hostId]?.spaces?.find { ref.address in it.addresses }?.name ?: vm.hostName(ref.hostId)
        if (cockpit) {
            fun section(rank: Int) = sections[rank]?.let { section ->
                item(key = "section:$rank") { SectionHeader(section.title, section.entries.size) }
                section.entries.forEach { e ->
                    item(key = "c:${e.ref.hostId}:${e.ref.address}") {
                        val chatWait = if (e.rank == Cockpit.BLOCKED && (Chat.isDsh(e.ref.address) || e.ref in pulse.fromChat))
                            Teams.chatWaitLabel(e.terminal) else null
                        TerminalCard(e.terminal, location(e.ref), Cockpit.addressLabel(e.ref), status = Cockpit.status(e.terminal, pulse.seenKey(e.ref, e.terminal) in state.seen).let { word ->
                            if (e.rank == Cockpit.BLOCKED && word != "blocked") "blocked" else word }, waiting = chatWait) { open(e.ref) }
                    }
                    items(e.kids, key = { "k:${it.first.hostId}:${it.first.address}" }) { (ref, kid) -> KidRow(kid, ref.address) { vm.selectTerminal(ref) } }
                }
            }
            section(Cockpit.BLOCKED); section(Cockpit.DONE)
            if (sections[Cockpit.BLOCKED] == null && sections[Cockpit.DONE] == null) item {
                Column(Modifier.fillMaxWidth().padding(vertical = 34.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Outlined.TaskAlt, null, Modifier.size(32.dp), tint = Muted); Spacer(Modifier.height(14.dp))
                    Text("All clear", fontWeight = FontWeight.Medium); Spacer(Modifier.height(4.dp))
                    Text("Agents that need you or finish show up here.", color = Muted, fontSize = 13.sp)
                }
            }
            // Working and idle agents, then terminals without a status: Projects has them too, by space.
            val listed = sections.values.flatMap { it.entries.map { e -> e.ref } }.toSet()
            val plain = all.filter { it.first !in listed }
            val rest = count(Cockpit.WORKING) + count(Cockpit.IDLE) + plain.size
            if (rest > 0) item(key = "everything") {
                Row(Modifier.fillMaxWidth().padding(top = 8.dp).clip(RoundedCornerShape(10.dp)).clickable { everything = !everything }.padding(vertical = 12.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text(if (everything) "Hide the rest" else "Everything else", color = Accent, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.width(8.dp))
                    Text(listOfNotNull(count(Cockpit.WORKING).takeIf { it > 0 }?.let { "$it working" }, count(Cockpit.IDLE).takeIf { it > 0 }?.let { "$it idle" },
                        plain.size.takeIf { it > 0 }?.let { "$it other" }).joinToString(" · "), color = Muted, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    Icon(if (everything) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(18.dp), tint = Muted)
                }
            }
            if (everything) {
                section(Cockpit.WORKING); section(Cockpit.IDLE)
                if (plain.isNotEmpty()) {
                    item(key = "section:plain") { SectionHeader("Terminals", plain.size) }
                    items(plain, key = { "p:${it.first.hostId}:${it.first.address}" }) { (ref, t) -> TerminalCard(t, location(ref), ref.address) { open(ref) } }
                }
            }
            return@LazyColumn
        }
        // A finished agent looked at here counts as idle, as in the cockpit.
        fun done(e: Pair<TerminalRef, CoreTerminal>) = e.second.status == "done" && Cockpit.seenKey(e.first, e.second) !in state.seen
        val groups = listOf("Needs you" to shown.filter { it.second.attention }, "Working" to shown.filter { it.second.status == "working" },
            "Done" to shown.filter(::done), "Ready" to shown.filter { !it.second.attention && it.second.status != "working" && !done(it) })
        groups.filter { it.second.isNotEmpty() }.forEach { (title, terminals) ->
            item { SectionHeader(title, terminals.size) }
            items(terminals, key = { "${it.first.hostId}:${it.first.address}" }) { (ref, terminal) ->
                TerminalCard(terminal, location(ref), ref.address, status = if (done(ref to terminal) || terminal.status != "done") terminal.status else "idle") { open(ref) }
            }
        }
        if (shown.isEmpty()) item {
            Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Outlined.Terminal, null, Modifier.size(32.dp), tint = Muted); Spacer(Modifier.height(14.dp))
                Text(if (search.isNotBlank()) "No matching terminals" else "No live terminals here", color = Muted)
                if (space != null) TextButton(onClick = onAll) { Text("See all agents") }
            }
        }
    }
    }
}

@Composable fun SectionHeader(title: String, count: Int) {
    Row(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        SmallLabel(title); Spacer(Modifier.width(8.dp)); Text(count.toString(), color = Muted, fontSize = 11.sp)
    }
}

/** A sub-agent that needs the person, under its parent's card. */
@Composable fun KidRow(t: CoreTerminal, address: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 22.dp).clip(RoundedCornerShape(10.dp)).background(Surface).border(1.dp, Blocked.copy(alpha = .32f), RoundedCornerShape(10.dp))
        .clickable(onClick = onClick).padding(12.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("↳", color = Muted, fontSize = 13.sp); Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(t.title, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (t.message.isNotBlank()) Text(t.message, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp)); Text(statusLabel("blocked", t.kind), color = Blocked, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.width(6.dp)); Text(address, color = Muted.copy(alpha = .6f), fontSize = 11.sp, fontFamily = FontFamily.Monospace)
    }
}

/** "Needs you", with what kind of answer when the agent said (permission, question, auth). */
fun statusLabel(word: String, kind: String) = stateName(word).let { if (word == "blocked" && kind.isNotBlank()) "$it · ${kind.replace('_', ' ')}" else it }

/** A count in a small card, as Today's header and a project's show them. [onClick] makes it open Home's deck. */
@Composable fun CountCard(number: Int, text: String, color: Color, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val numberBox = with(LocalDensity.current) { 24.sp.toDp() }
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(Surface).border(1.dp, Border, RoundedCornerShape(12.dp))
        .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(TodayTiles.PAD_DP.dp, 10.dp)) {
        Box(Modifier.height(numberBox), contentAlignment = Alignment.CenterStart) {
            Text(number.toString(), color = color, fontSize = 22.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
        }
        TileLabel(text)
    }
}

@Composable fun Stat(number: Int, text: String, color: Color, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(number.toString(), color = color, fontSize = 24.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(3.dp)); Text(text, fontSize = 12.sp, color = Muted)
    }
}

@Composable fun TerminalCard(t: CoreTerminal, location: String, address: String, status: String = t.status,
                             waiting: String? = null, onClick: () -> Unit) {
    val color = stateColor(status)
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Surface).border(1.dp, if (status == "blocked" || status == "error") Blocked.copy(alpha = .32f) else Border, RoundedCornerShape(12.dp))
        .clickable(onClick = onClick).padding(16.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.size(35.dp).clip(RoundedCornerShape(9.dp)).background(color.copy(alpha = .09f)), contentAlignment = Alignment.Center) {
            Icon(if (t.agent.lowercase().contains("sh")) Icons.Outlined.Terminal else Icons.Outlined.AutoAwesome, null, Modifier.size(18.dp), tint = color)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(t.agent, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Dot(color, 6); Spacer(Modifier.width(6.dp)); Text(waiting ?: stateName(status), color = color, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            }
            Spacer(Modifier.height(6.dp)); Text(t.title, fontWeight = FontWeight.Medium, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (t.message.isNotBlank()) { Spacer(Modifier.height(6.dp)); Text(t.message, color = Muted, fontSize = 13.sp, lineHeight = 19.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            Spacer(Modifier.height(14.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.FolderOpen, null, Modifier.size(12.dp), tint = Muted); Spacer(Modifier.width(5.dp))
                Text(location, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(address, color = Muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
                Spacer(Modifier.width(5.dp)); Icon(Icons.Outlined.ChevronRight, null, Modifier.size(14.dp), tint = Muted)
            }
        }
    }
}
