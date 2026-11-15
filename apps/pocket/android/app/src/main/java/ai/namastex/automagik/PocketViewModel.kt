package ai.namastex.automagik

import ai.namastex.automagik.Background.whileShown
import android.app.Application
import androidx.core.content.edit
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Semaphore
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// session increases with each successful connection, so open terminal views know to attach again.
data class MachineState(val connecting: Boolean = false, val connected: Boolean = false, val version: String = "",
    val terminals: List<CoreTerminal> = emptyList(), val spaces: List<PocketSpace> = emptyList(), val error: String? = null,
    val session: Int = 0, val linked: List<LinkedMachine> = emptyList(),
    /** Desktop avatar colours (shared.json space.colors), by space id. */
    val colors: Map<String, String> = emptyMap(),
    /** Git answers for the drawer, by Sidebar.gitKey: null is not a repository. */
    val git: Map<String, GitInfo?> = emptyMap(),
    /** The usage meter's doc per machine this core reaches ("" is its own); a machine with no meter has none. */
    val meter: Map<String, Spend.Reading> = emptyMap(),
    /** The meter doc's Space Row feed per machine, keyed like [meter]; a machine whose doc has none (or another version) has none. */
    val space: Map<String, SpaceFeed.Feed> = emptyMap(),
    /** Bot and category names from each project's `.herdr/bots.json`, by "machine|project key". */
    val bots: Map<String, SpaceFeed.Names> = emptyMap(),
    /** Desktop space icons (shared.json am.sidebar.icons), by space id. */
    val icons: Map<String, Teams.Icon> = emptyMap(),
    /** Each project's bots as its registry defines them ([Teams.registry]), by "machine|project key". */
    val members: Map<String, List<Teams.Member>> = emptyMap(),
    /** The [session] whose terminals have been read ([Teams.ready]). */
    val readSession: Int = 0,
    /** In [readSession], each machine whose spaces were read ("" is the core's own), and when that first reading came. */
    val layouts: Map<String, Long> = emptyMap()) {
    /** Dropped or failed, as opposed to never connected or disconnected on purpose. */
    val offline get() = !connected && (connecting || error != null)
    /** Worth retrying without asking: a dropped or failed connection. */
    val retryable get() = !connected && !connecting && error != null
}
/** The demo's one machine, by name: synthetic, nothing real is reached. */
const val PREVIEW_MACHINE = "Preview machine"
data class TerminalRef(val hostId: String, val address: String)
data class PocketState(
    val hosts: List<HostProfile> = emptyList(), val machines: Map<String, MachineState> = emptyMap(),
    /** The bottom tab ([Nav.TABS]); [project] ([Projects.Project.key]) and [space] are open over it, [selected] over all. */
    val screen: String = Nav.HOME, val space: Pair<String, String>? = null, val selected: TerminalRef? = null,
    val project: String? = null,
    val message: String? = null,
    val terminalStatus: String = "", val demo: Boolean = false, val sending: Boolean = false,
    val nativeDisplay: Boolean = false, val screenText: String = "",
    val terminalFullscreen: Boolean = true, val nativeAlternateScreen: Boolean = false,
    /** [selected] opens on its Chat tab (a Team bubble of a Herdr-only main bot), when its terminal offers one. */
    val chatFirst: Boolean = false,
    /** The Home row [selected] was opened from, when it is another agent: a Bot's pane whose row opens its chat. */
    val row: TerminalRef? = null,
    val fontSize: Int = DEFAULT_FONT_SIZE, val modifiers: KeyModifiers = KeyModifiers(),
    val refreshing: Boolean = false,
    /** A Pocket Link pairing is in progress. */
    val pairing: Boolean = false,
    /** The legacy SSH machine ([LegacySsh]) whose "Pair with QR" started the scan: the next pairing replaces it. */
    val repairing: String? = null,
    /** A pairing link that arrived from outside the app, waiting for the person to confirm it. */
    val offeredPairing: PairingLink? = null,
    /** Folded drawer machine groups, as "hostId|machine". */
    val folded: Set<String> = emptySet(),
    /** Finished turns the person looked at on the phone ([Cockpit.seenKey]); they leave the cockpit's Done. */
    val seen: Set<String> = emptySet(),
    /** Settings > Alerts, phone-local like the desktop's settings.json `sounds`. */
    val alertSounds: Boolean = true, val alertBlocked: Boolean = true, val alertDone: Boolean = true,
    /** Notifications show their content on the lock screen, and Reply works there without unlocking. */
    val lockAnswers: Boolean = false,
    /** Keep connections open in the background ([WatchService]) so alerts arrive as notifications. */
    val watch: Boolean = true,
    /** Goes up when a space image or a pet arrives from the desktop, so the Teams tab draws it. */
    val iconsVersion: Int = 0,
)
const val DEFAULT_FONT_SIZE = 13
/** Size caps on what Teams copies from a desktop: a space image (Herdr's own limit), a pet's sheet and its sleep strip. */
const val ICON_MAX = 5 * 1024 * 1024
const val PET_SHEET_MAX = 6 * 1024 * 1024
const val PET_SLEEP_MAX = 2 * 1024 * 1024
val FONT_SIZES = 8..24

/**
 * This state with machine [id] changed by [transform] (from a blank one if it has none yet), unless [id] is neither
 * shown nor saved: a reading that finishes after its machine was removed must not bring it back.
 */
fun PocketState.withMachine(id: String, transform: (MachineState) -> MachineState): PocketState =
    if (id !in machines && hosts.none { it.id == id }) this
    else copy(machines = machines + (id to transform(machines[id] ?: MachineState())))

class PocketViewModel(application: Application, private val initDispatcher: CoroutineDispatcher = Dispatchers.IO) : AndroidViewModel(application) {
    private val prefs = application.getSharedPreferences("pocket", 0)
    /** Null when the saved list couldn't be read: it then shows empty, but its SSH entries may still be in the preferences. */
    private val savedHosts = LegacySsh.loadHosts(prefs.getString("hosts", "[]"))
    private val _state = MutableStateFlow(PocketState(nativeDisplay = prefs.getBoolean("native_display", false),
        fontSize = prefs.getInt("font_size", DEFAULT_FONT_SIZE).coerceIn(FONT_SIZES), folded = prefs.getStringSet("folded_machines", null).orEmpty().toSet(),
        alertSounds = prefs.getBoolean("alert_sounds", true), alertBlocked = prefs.getBoolean("alert_blocked", true), alertDone = prefs.getBoolean("alert_done", true),
        lockAnswers = prefs.getBoolean("lock_answers", false), watch = prefs.getBoolean(WatchResume.PREF_WATCH, true),
        seen = runCatching { JSONArray(prefs.getString("seen_done", "[]")).let { a -> (0 until a.length()).map(a::getString) }.toSet() }.getOrDefault(emptySet()), hosts = savedHosts.orEmpty()))
    val state = _state.asStateFlow()
    /** Herdr desktop's program table, for the drawer's names and icons. */
    val programs: Programs by lazy { Programs(JSONObject(application.assets.open("programs.json").bufferedReader().use { it.readText() })) }
    private val colorsRead = ConcurrentHashMap<String, Long>()
    private val meterRead = ConcurrentHashMap<String, Long>()
    private val homes = ConcurrentHashMap<String, String>()
    private val herdrHomes = ConcurrentHashMap<String, String>()
    // Git for the spaces tree, projects and tasks runs in its own slow loop, never in the event refresh: one pass after
    // connecting, a re-check when a terminal stops working, and the desktop's 60 s fallback only while a screen that
    // shows repositories or branches is open. Only in the foreground, and only reading: the phone never changes a repo.
    private val gitWake = Channel<Unit>(Channel.CONFLATED)
    private val gitChecked = ConcurrentHashMap<String, Long>()
    /** At most [HostReads.POOL] machines read at once, across every saved machine. */
    private val hostPool = Semaphore(HostReads.POOL)
    private val hostReads = KeptReads<CoreClient, HostReads>()
    /** The Teams reads of saved machine [id] over [client] ([HostReads]), kept for its live connection ([KeptReads]). */
    private fun reads(id: String, client: CoreClient): HostReads = hostReads.get(id, client, clients[id]) {
        HostReads({ method, params -> client.call(method, params) }, { state.value.machines[id] }, { f -> updateMachine(id, f) }, hostPool)
    }
    private val gitDirty: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val wasWorking = ConcurrentHashMap<String, Set<String>>()
    @Volatile private var gitShown = false
    private val iconsTried: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val petsTried: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val spaceIconsTried: MutableSet<String> = ConcurrentHashMap.newKeySet()
    /** The Teams tab's local copy ([TeamsDb]). */
    private val teamsDao by lazy { TeamsDb.get(application).teams() }
    /** The cached projects and bots, for the tab's first frame and for machines that aren't connected. */
    val cachedTeams: StateFlow<List<Teams.Team>> by lazy {
        combine(teamsDao.teams(), teamsDao.bots()) { t, b -> TeamsCache.teams(t, b) }.flowOn(Dispatchers.IO)
            .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    }
    /** Today's peaks of simultaneous agents by scope ("" is All), as the phone counted them. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val peaks: StateFlow<Map<String, Int>> by lazy {
        flow { while (true) { emit(Teams.day(System.currentTimeMillis())); delay(60_000) } }.distinctUntilChanged()
            .flatMapLatest { teamsDao.day(it) }.map { rows -> rows.associate { it.scope to it.peak } }.flowOn(Dispatchers.IO)
            .stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    }
    private val _celebrations = MutableStateFlow<Map<String, Long>>(emptyMap())
    /** Bots to celebrate, "team id|bot id" to when their merge was seen: each jumps once. */
    val celebrations = _celebrations.asStateFlow()
    /** The one writer of the Teams cache ([TeamsSync]). */
    private val teamsSync by lazy { TeamsSync(teamsDao) }
    private val petJobs = ConcurrentHashMap<String, Job>()
    fun gitShown(shown: Boolean) { gitShown = shown; if (shown) gitWake.trySend(Unit) }
    fun toggleFold(key: String) {
        val folded = state.value.folded.let { if (key in it) it - key else it + key }
        prefs.edit { putStringSet("folded_machines", folded) }
        _state.update { it.copy(folded = folded) }
    }
    private val clients = ConcurrentHashMap<String, CoreClient>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private var attachJob: Job? = null
    private var nativeJob: Job? = null
    @Volatile private var activeChannel: Pair<CoreClient, Int>? = null
    @Volatile private var attachRevision = 0L
    @Volatile var terminalBytes: ((Long, Int, ByteArray) -> Unit)? = null
    @Volatile var resetTerminal: ((Long) -> Unit)? = null
    private var cols = 80
    private var rows = 24
    // Modes of the attached terminal's output stream, for key-bar cursor keys, paste and native scrolling.
    @Volatile private var modes = TerminalModes()
    private val keystrokes = Channel<Pair<Pair<CoreClient, Int>, ByteArray>>(64)

    companion object {
        /** The live instance, for notification actions that arrive outside the activity. */
        @Volatile var current: PocketViewModel? = null
    }
    /** The app on screen: Teams sync waits for it ([Background.whileShown]). */
    private val onScreen = MutableStateFlow(false)
    init {
        current = this
        Notify.channels(application)
        viewModelScope.launch(initDispatcher) {
            for ((target, bytes) in keystrokes) {
                if (activeChannel === target) runCatching { target.first.send(target.second, Wire.inputKind(bytes, target.first.automaticInput(target.second)), bytes) }
                    .onFailure { e -> _state.update { it.copy(terminalStatus = "Input not sent: ${e.message}") } }
            }
        }
        // Older versions made an SSH key for everyone; it goes once no machine saved over SSH is left.
        dropSshKeyIfUnused()
        ProgramIcons.load(application)
        // Teams: each reading of the connected machines replaces their rows in the cache and raises today's peaks; a new
        // merge in a feed celebrates its bots; pets and space images the phone lacks are fetched once. Only while the app is
        // on screen ([Background.whileShown]): the latest reading syncs when it comes back.
        // At most one reading every 400 ms, each of the latest state: readings arrive many times a second while a desktop
        // starts, and restarting a delay on each (collectLatest) could put the cache write and pets off indefinitely.
        viewModelScope.launch(initDispatcher) {
            state.map { s -> if (s.demo) null else s.machines.filterValues { it.connected } }.distinctUntilChanged().whileShown(onScreen).conflate().collect { live ->
                live ?: return@collect
                val now = System.currentTimeMillis()
                val jump = try { teamsSync.reading(live, now) } catch (e: CancellationException) { throw e } catch (_: Exception) { emptySet() }
                if (jump.isNotEmpty()) _celebrations.update { it + jump.associateWith { now } }
                for ((id, client) in clients.entries.toList()) {
                    val m = live[id] ?: continue
                    // The core's own projects, once their machine is read: pets are fetched from it alone.
                    if (Teams.ready(m, "", now)) startPets(id, client, Teams.build(id, m, now).filter { it.machine.isBlank() })
                }
                delay(400)
            }
        }
        viewModelScope.launch(initDispatcher) {
            while (true) {
                withTimeoutOrNull(15_000) { gitWake.receive() }
                if (foreground) for ((id, client) in clients.entries.toList()) runCatching { gitPass(id, client) }
            }
        }
    }

    fun dismissMessage() { _state.update { it.copy(message = null) } }
    private fun saveHosts(hosts: List<HostProfile>) {
        prefs.edit().putString("hosts", JSONArray(hosts.map { it.json() }).toString()).apply()
        _state.update { it.copy(hosts = hosts) }
    }
    fun saveHost(profile: HostProfile) {
        if (state.value.demo) leaveDemo()
        val hosts = state.value.hosts
        val previous = hosts.find { it.id == profile.id }
        val moved = previous != null && (previous.host != profile.host || previous.port != profile.port || previous.user != profile.user || previous.session != profile.session)
        val live = state.value.machines[profile.id]?.let { it.connected || it.connecting } == true
        saveHosts(if (previous != null) hosts.map { if (it.id == profile.id) profile.copy(linked = if (moved) emptyList() else it.linked) else it } else hosts + profile)
        // A live connection to the old address would otherwise keep running under the new name.
        if (moved && live) connect(profile)
    }
    fun removeHost(id: String) {
        // Its cached projects and bots go with it (TeamsSync), so Teams never shows a machine the phone no longer has.
        viewModelScope.launch(Dispatchers.IO) { runCatching { teamsSync.removed(id) } }
        disconnect(id)
        saveHosts(state.value.hosts.filter { it.id != id })
        _state.update { it.copy(machines = it.machines - id, repairing = if (it.repairing == id) null else it.repairing) }
        dropSshKeyIfUnused()
    }
    private fun dropSshKeyIfUnused() {
        // An unreadable saved list may still hold SSH entries: keep the key for as long as this process runs.
        val hosts = if (savedHosts == null) null else state.value.hosts
        viewModelScope.launch(Dispatchers.IO) { runCatching { LegacySsh.deleteKeyIfUnused(getApplication<Application>().noBackupFilesDir, hosts) } }
    }
    /** A tab (or Settings), opened at its top. */
    fun navigate(screen: String) { place(Nav.tab(screen)) }
    private fun place(p: Nav.Place) {
        if (p.selected == null) detach()
        _state.update { it.copy(screen = p.screen, project = p.project, space = p.space, selected = p.selected,
            terminalStatus = if (p.selected == null) "" else it.terminalStatus) }
    }
    /** One step back by [Nav.back]; false when there is nowhere further back to go. */
    fun back(): Boolean {
        val s = state.value
        val to = Nav.back(Nav.Place(s.screen, s.project, s.space, s.selected)) ?: return false
        place(to); return true
    }
    /** A space's agents, over the tab that showed it. */
    fun selectSpace(hostId: String, spaceId: String) {
        detach()
        _state.update { it.copy(space = hostId to spaceId, selected = null) }
    }
    fun openProject(key: String) { detach(); _state.update { it.copy(screen = Nav.CODE, project = key, space = null, selected = null) } }
    fun setTerminalFullscreen(fullscreen: Boolean) { _state.update { it.copy(terminalFullscreen = fullscreen) } }
    /**
     * [chat]: open on the terminal's Chat tab (its projected chat) instead of the terminal. [row]: the Home row this
     * was opened from, when it is another agent (a Bot's pane whose row opens the Bot's chat): looking at the chat
     * is looking at that row too ([markSeen]).
     */
    fun selectTerminal(ref: TerminalRef, chat: Boolean = false, row: TerminalRef? = null) {
        Notify.cancel(getApplication(), ref)
        if (state.value.selected == ref) return
        detach()
        // The terminal covers the tab it was opened from, which stays as it was for Back.
        _state.update { it.copy(selected = ref, chatFirst = chat, row = row?.takeIf { it != ref }, terminalStatus = "Connecting terminal…", screenText = "", terminalFullscreen = true, nativeAlternateScreen = false) }
    }
    fun backToList() { detach(); _state.update { it.copy(selected = null, terminalStatus = "") } }
    fun showAll() { navigate(Nav.HOME_TAB) }

    /** [retry]: a background reconnect's attempt number; a failure schedules the next. */
    fun connect(profile: HostProfile, retry: Int = 0) {
        // The only way out to a machine: SSH is gone, so a legacy entry is offered "Pair with QR" and never dialled.
        LegacySsh.refusal(profile)?.let { reason -> _state.update { it.copy(message = reason) }; return }
        disconnect(profile.id, deliberate = retry == 0)
        if (state.value.demo) leaveDemo()
        jobs[profile.id] = viewModelScope.launch(Dispatchers.IO) {
            updateMachine(profile.id) { it.copy(connecting = true, connected = false, error = null) }
            var client: CoreClient? = null
            try {
                val connectionScope = CoroutineScope(coroutineContext + SupervisorJob(coroutineContext[Job]))
                val t = IrohLink.open(getApplication(), profile.ticket, profile.session, connectionScope)
                ensureActive()
                lateinit var c: CoreClient
                c = CoreClient(t.input, t.output, t, connectionScope) { reason -> lost(profile, c, reason) }
                client = c
                val hello = withTimeout(20_000) { c.start() }
                ensureActive()
                clients[profile.id] = c
                gitChecked.keys.removeIf { it.startsWith("${profile.id}|") }
                retrying.remove(profile.id); attempts.remove(profile.id)
                updateMachine(profile.id) { it.copy(connecting = false, connected = true, version = hello.optString("version"), error = null, session = it.session + 1) }
                val changes = Channel<Unit>(Channel.CONFLATED)
                c.subscribe { changes.trySend(Unit) }
                refresh(profile.id, c)
                var fullRead = System.currentTimeMillis()
                for (ignored in changes) {
                    // Away from the app, fewer reads: the alert is what matters, not every redraw. Only the terminal list,
                    // and the whole machine when a status moved or every 30 s ([Background.refresh]).
                    delay(if (foreground) 180 else 1_500)
                    runCatching {
                        val list = c.call("terminal.list")
                        val now = System.currentTimeMillis()
                        val terminals = list.optJSONArray("terminals")?.objects()?.map(CoreTerminal::parse).orEmpty()
                        if (Background.refresh(foreground, alertBase[profile.id]?.takeIf { it.first === c }?.second, terminals, fullRead, now)) {
                            refresh(profile.id, c, list); fullRead = now
                        }
                    }.onFailure { e -> updateMachine(profile.id) { it.copy(error = e.message) } }
                }
            } catch (e: Throwable) {
                client?.close()
                // A timeout is a failed attempt like any other (and is retried); only a real cancel ends quietly.
                if (e is CancellationException && e !is TimeoutCancellationException) throw e
                val reason = if (e is TimeoutCancellationException) "The machine didn’t answer in time." else e.message ?: "Connection failed"
                updateMachine(profile.id) { it.copy(error = reason) }
                if (retry > 0) reconnectLater(profile, retry)
                updateMachine(profile.id) { it.copy(connecting = false, connected = false) }
            }
        }
    }
    private fun lost(profile: HostProfile, client: CoreClient, reason: String) {
        // A connection already replaced by a newer one: its late loss changes nothing (the new one and its reads stay).
        clients[profile.id]?.let { if (it !== client) return }
        val unexpected = jobs[profile.id]?.isActive == true
        clients.remove(profile.id, client)
        hostReads.lost(profile.id, client)
        if (unexpected) reconnectLater(profile, 1)
        updateMachine(profile.id) { it.copy(connected = false, connecting = false, error = "Disconnected: $reason") }
        if (state.value.selected?.hostId == profile.id) _state.update { it.copy(terminalStatus = "Disconnected") }
    }

    fun offerPairing(text: String) {
        val link = PairingLink.parse(text) ?: run { _state.update { it.copy(message = "That isn’t a Pocket Link pairing link.") }; return }
        _state.update { it.copy(offeredPairing = link) }
    }
    fun dismissOfferedPairing() { _state.update { it.copy(offeredPairing = null) } }

    /** Pairs with the desktop that showed [text] (a Pocket Link QR or pasted link), saves it and connects. */
    /** A pasted link: it replaces no legacy card. */
    fun pair(text: String) {
        pair(PairingLink.parse(text) ?: run { _state.update { it.copy(message = LegacySsh.NOT_A_LINK) }; return })
    }
    /** The QR scanner's result (null when cancelled); only a scan opened from a legacy card replaces that card. */
    fun scanned(text: String?) {
        var scan: LegacySsh.Scan = LegacySsh.Scan.Cancelled
        _state.update { s -> LegacySsh.scanned(s, text).also { scan = it.second }.first }
        (scan as? LegacySsh.Scan.Pair)?.let { pair(it.link, it.replacing) }
    }
    /** A legacy SSH card's "Pair with QR": the scan it opens pairs that computer and replaces the card ([LegacySsh]). */
    fun repairWithQr(hostId: String) { _state.update { LegacySsh.start(it, hostId) } }
    /** The scan was cancelled: the legacy card stays as it was. */
    fun cancelRepair() { _state.update(LegacySsh::cancel) }
    /** [replacing]: the legacy SSH card this pairing replaces once it succeeds ([scanned]); none for a pasted or external link. */
    fun pair(link: PairingLink, replacing: String? = null) {
        if (state.value.demo) leaveDemo()
        _state.update { it.copy(pairing = true, offeredPairing = null) }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val device = listOf(android.os.Build.MANUFACTURER, android.os.Build.MODEL).distinct().joinToString(" ").trim().ifBlank { "Android phone" }
                val name = IrohLink.pair(getApplication(), link, device)
                val desktop = IrohLink.desktopId(link.ticket)
                // Pairing the same desktop again keeps its card and history, with the new ticket.
                val previous = state.value.hosts.find { it.paired && runCatching { IrohLink.desktopId(it.ticket) }.getOrNull() == desktop }
                val profile = (previous ?: HostProfile(UUID.randomUUID().toString(), name, desktop.take(12), "", 0, transport = "iroh"))
                    .copy(ticket = link.ticket, transport = "iroh")
                withContext(Dispatchers.Main) {
                    // The legacy SSH entry this pairing replaces goes only now, after the pairing succeeded.
                    val hosts = LegacySsh.afterPairing(state.value.hosts, profile, replacing)
                    val replaced = state.value.hosts.filter { h -> hosts.none { it.id == h.id } }.map { it.id }
                    replaced.forEach { disconnect(it) }
                    saveHosts(hosts)
                    _state.update { it.copy(pairing = false, repairing = null, machines = it.machines - replaced.toSet(), message = "Paired with $name") }
                    dropSshKeyIfUnused()
                    hosts.find { it.id == profile.id }?.let { connect(it) }
                }
            } catch (e: Throwable) {
                if (e is CancellationException) throw e
                _state.update { it.copy(pairing = false, repairing = null, message = e.message ?: "Pairing failed") }
            }
        }
    }

    fun reconnect(hostId: String) { state.value.hosts.find { it.id == hostId }?.let { connect(it) } }
    /** Pull to refresh: reload connected inventories, and retry machines whose connection dropped or failed. */
    fun refreshAll() {
        if (state.value.refreshing) return
        if (state.value.demo) { viewModelScope.launch { _state.update { it.copy(refreshing = true) }; delay(400); _state.update { it.copy(refreshing = false) } }; return }
        _state.update { it.copy(refreshing = true) }
        meterRead.clear()
        val retry = state.value.hosts.filter { h -> h.paired && state.value.machines[h.id]?.retryable == true }
        retry.forEach { connect(it) }
        viewModelScope.launch(Dispatchers.IO) {
            val started = System.currentTimeMillis()
            clients.entries.toList().map { (id, c) -> async { runCatching { refresh(id, c) }.onFailure { e -> updateMachine(id) { it.copy(error = e.message) } } } }.awaitAll()
            delay((400 - (System.currentTimeMillis() - started)).coerceAtLeast(0))
            _state.update { it.copy(refreshing = false) }
        }
    }
    fun setFontSize(size: Int, persist: Boolean = true) {
        val value = size.coerceIn(FONT_SIZES)
        if (persist) prefs.edit().putInt("font_size", value).apply()
        _state.update { it.copy(fontSize = value) }
    }
    fun toggleCtrl() { _state.update { it.copy(modifiers = it.modifiers.copy(ctrl = !it.modifiers.ctrl)) } }
    fun toggleAlt() { _state.update { it.copy(modifiers = it.modifiers.copy(alt = !it.modifiers.alt)) } }
    /** [deliberate]: the person asked, so a background reconnect in progress ends too. */
    fun disconnect(id: String, deliberate: Boolean = true) {
        reconnects.remove(id)?.cancel()
        if (deliberate) { retrying.remove(id); attempts.remove(id) }
        if (state.value.selected?.hostId == id) detach()
        jobs.remove(id)?.cancel()
        clients.remove(id)?.close()
        hostReads.drop(id)
        // A deliberate disconnect is not an error to surface or retry.
        updateMachine(id) { it.copy(connected = false, connecting = false, error = null) }
    }
    private fun updateMachine(id: String, transform: (MachineState) -> MachineState) {
        _state.update { it.withMachine(id, transform) }
        syncWatch()
    }
    private val reconnects = ConcurrentHashMap<String, Job>()
    /** Machines coming back on their own, so the watch service keeps running between attempts. */
    private val retrying = ConcurrentHashMap.newKeySet<String>()
    /** Each retrying machine's last attempt, so opening the app tries a slow one at once ([kickSlowReconnects]). */
    private val attempts = ConcurrentHashMap<String, Int>()
    /** A dropped connection comes back on its own while watching: after 2 s, then longer, then every 15 minutes ([Background.reconnectDelay]). */
    private fun reconnectLater(profile: HostProfile, attempt: Int) {
        if (!state.value.watch || state.value.demo) return
        retrying.add(profile.id)
        attempts[profile.id] = attempt
        reconnects.remove(profile.id)?.cancel()
        reconnects[profile.id] = viewModelScope.launch {
            delay(Background.reconnectDelay(attempt))
            reconnects.remove(profile.id)
            state.value.hosts.find { it.id == profile.id }?.let { connect(it, retry = attempt + 1) }
        }
        syncWatch()
    }
    /** The person opened the app: a machine waiting out its slow retry is tried now (a failure goes back to waiting). */
    private fun kickSlowReconnects() {
        for ((id, attempt) in attempts) {
            if (attempt <= Background.RECONNECT_FAST || reconnects[id]?.isActive != true) continue
            state.value.hosts.find { it.id == id }?.let { connect(it, retry = attempt + 1) }
        }
    }
    @Volatile private var watchText = ""
    @Volatile private var kept: Set<String>? = null
    /** Runs [WatchService] while a machine is connected (or coming back), with how many agents need the person.
     *  [canStart]: Android allows starting it now (on screen, or from [resumeWatching]). */
    private fun syncWatch(canStart: Boolean = foreground) {
        val s = state.value
        val app = getApplication<Application>()
        // What to reconnect if an update or a restart ends the process ([WatchResume]).
        val active = s.machines.filterValues { it.connected || it.connecting }.keys + retrying
        val watched = WatchResume.watched(s.watch, s.demo, active)
        if (watched != kept) { kept = watched; prefs.edit { putStringSet(WatchResume.PREF, watched) } }
        val machines = s.machines.values.count { it.connected }
        if (!s.watch || s.demo || (machines == 0 && retrying.isEmpty() && s.machines.values.none { it.connecting })) {
            watchText = ""; WatchService.stop(app); return
        }
        val needYou = s.machines.values.sumOf { m -> m.terminals.count { it.live && it.attention && it.parent.isBlank() } }
        val text = if (machines == 0) "Reconnecting…" else WatchService.summary(machines, needYou)
        if (text == watchText) return
        watchText = text
        WatchService.show(app, text, canStart)
    }
    /** After an update or a phone restart ended the process: reconnect the machines it was watching and start the watch service, with no
     *  screen. Called from [WatchResumeReceiver], whose broadcast lets the service start from the background. */
    fun resumeWatching() {
        val s = state.value
        if (s.demo) return
        val ids = WatchResume.hosts(s.watch, prefs.getStringSet(WatchResume.PREF, null), s.hosts.map { it.id })
        // Never a legacy SSH machine a version before RFC 0008 was watching: it would show "Reconnecting…" forever.
        val hosts = s.hosts.filter { it.id in ids && it.paired && jobs[it.id]?.isActive != true }
        if (hosts.isEmpty()) return
        retrying.addAll(hosts.map { it.id })
        watchText = ""; syncWatch(canStart = true)
        hosts.forEach { connect(it, retry = 1) }
    }
    fun setWatch(on: Boolean) {
        prefs.edit { putBoolean(WatchResume.PREF_WATCH, on) }
        _state.update { it.copy(watch = on) }
        if (!on) { reconnects.values.forEach { it.cancel() }; reconnects.clear(); retrying.clear(); attempts.clear() }
        watchText = ""; syncWatch()
    }
    /** The watch notification's Stop: disconnect everything and stay disconnected until the person connects again. */
    fun stopWatching() {
        reconnects.values.forEach { it.cancel() }; reconnects.clear(); retrying.clear(); attempts.clear()
        state.value.machines.keys.forEach { disconnect(it) }
        watchText = ""
    }
    private val alertBase = ConcurrentHashMap<String, Pair<CoreClient, List<CoreTerminal>>>()
    private val foreground get() = onScreen.value
    fun setForeground(shown: Boolean) {
        onScreen.value = shown
        // Android lets the watch service start only from the foreground.
        if (shown) { watchText = ""; syncWatch(); kickSlowReconnects() }
        if (shown) Updater.opened() else Updater.left()
    }
    // Opening the app checks for an update (setForeground); this tells a waiting one when installing would interrupt.
    // Registered after the fields its lambda reads (onScreen, watchText): Updater can call it while this view model is
    // still being constructed (a download finishing then), and a registration before them would read a null field (#762).
    init {
        Updater.usage = { val s = state.value; Updater.Usage(foreground, s.selected != null, watchText.isNotEmpty()) }
    }
    private suspend fun alert(found: List<Alerts.Alert>, client: CoreClient) {
        val s = state.value
        val wanted = found.filter { if (it.kind == Alerts.BLOCKED) s.alertBlocked else s.alertDone }
        if (wanted.isEmpty() || s.demo) return
        val app = getApplication<Application>()
        fun looking(a: Alerts.Alert) = foreground && s.selected == a.ref
        // An agent the person isn't looking at alerts as an Android notification, in the app too: its channel plays the
        // sound, Needs you pops up over the screen, and a tap opens the agent. There is no in-app toast.
        val notify = Notify.allowed(app)
        if (notify) wanted.filterNot(::looking).forEach { a -> Notify.post(app, a, detail(a), silent = !s.alertSounds, lockScreen = s.lockAnswers, menu = menu(a, client)) }
        // What no notification covers: the agent on screen asking (Needs you sounds while looking), or notifications off.
        val unheard = if (notify) wanted.filter(::looking) else wanted
        if (s.alertSounds && unheard.any { Alerts.sounds(it.kind, looking(it)) }) Alerts.play(app)
    }
    /** The options a blocked agent shows (a permission or a question), read off its screen; the prompt may draw a moment after its status. */
    private suspend fun menu(a: Alerts.Alert, client: CoreClient): Prompt.Menu? {
        if (a.kind != Alerts.BLOCKED || a.terminal.kind !in setOf("permission", "question")) return null
        repeat(3) { attempt ->
            if (attempt > 0) delay(500)
            runCatching { Prompt.menu(client.call("terminal.read", JSONObject().put("terminal", a.ref.address).put("lines", 0)).optString("text")) }
                .getOrNull()?.let { return it }
        }
        return null
    }
    /**
     * A notification's option button: re-reads the agent and presses the keys only if it still asks [msg] with the same
     * [options] and the same [dialog] text above them on screen; otherwise nothing is sent. Returns what to show in the
     * notification.
     */
    suspend fun choose(ref: TerminalRef, msg: String, dialog: String, options: List<String>, index: Int, label: String): String {
        if (state.value.demo) return choosePreview(ref, msg, dialog, options, index, label)
        val c = clients[ref.hostId] ?: return "Not sent: ${hostName(ref.hostId)} isn’t connected. Open Automagik to reconnect."
        if (index !in options.indices) return "Not sent: open the agent to answer."
        // The keys (herdr-core types them after ~3 s of quiet) and then Prompt.VERIFY_MS of read-back.
        return withTimeoutOrNull(12_000) {
            runCatching { Prompt.choose({ m, p -> c.call(m, p) }, ref.address, msg, dialog, options, index, label) }.getOrElse { e -> "Not sent: ${e.message ?: "the core refused it"}" }
        } ?: "Not confirmed: check the agent before trying again."
    }
    /** The menu [ref]'s agent shows now, read off its screen as [choose] reads it, or null. */
    suspend fun readMenu(ref: TerminalRef): Prompt.Menu? {
        if (state.value.demo) return Prompt.menu(previewScreen(terminalOf(ref)))
        val c = clients[ref.hostId] ?: return null
        return try { Prompt.menu(c.call("terminal.read", JSONObject().put("terminal", ref.address).put("lines", 0)).optString("text")) }
        catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }
    /**
     * A terminal screen's answer button: [choose], then show the outcome. [done] runs either way, told whether it was
     * sent ([Teams.sent]).
     */
    fun answer(ref: TerminalRef, msg: String, dialog: String, options: List<String>, choice: Prompt.Choice,
               short: String? = null, done: (sent: Boolean) -> Unit) {
        viewModelScope.launch {
            var sent = false
            try {
                val outcome = choose(ref, msg, dialog, options, choice.index, choice.label)
                sent = Teams.sent(outcome)
                // The deck's strip says "Yes"/"No"; everywhere else keeps the whole choice in the outcome.
                _state.update { it.copy(message = if (sent && short != null) "You chose: $short" else outcome) }
            } finally { done(sent) }
        }
    }
    /** The preview's failing request fails once, so the deck's error strip renders and the retry can move on. */
    private val previewFailed = mutableSetOf<String>()
    /** The preview has no core: its blocked agent checks the dialog and menu the same way, logs the keys it would get, and moves on. */
    private fun choosePreview(ref: TerminalRef, msg: String, dialog: String, options: List<String>, index: Int, label: String): String {
        val t = terminalOf(ref)
        if (index !in options.indices) return "Not sent: open the agent to answer."
        if (t == null || !t.attention || t.message != msg) return Prompt.CHANGED
        val menu = Prompt.menu(previewScreen(t))
        if (menu == null) return Prompt.CHANGED
        if (dialog.isBlank() || menu.dialog.isBlank()) return Prompt.NOT_READABLE
        if (!Prompt.sameDialog(dialog, menu)) return Prompt.CHANGED
        if (!Prompt.unchanged(options, menu)) return "Not sent: its options changed. Open the agent to answer."
        // The sample's failing request: a valid menu that changes before the keys land once, so the deck shows its error.
        if (ref.address == "t9" && previewFailed.add(ref.address)) return Prompt.CHANGED
        android.util.Log.i("PocketPrompt", "preview ${ref.address} keys=${Prompt.keys(menu, index).joinToString(",")}")
        val running = when (ref.address) {
            "t8" -> "Running the lint check"
            "t9" -> "Deploying the sample build"
            else -> "Running the test suite"
        }
        _state.update { s ->
            val m = s.machines[ref.hostId] ?: return@update s
            val moved = m.terminals.map { if (it.address == ref.address) it.copy(status = "working", kind = "", message = running) else it }
            s.copy(machines = s.machines + (ref.hostId to m.copy(terminals = moved)))
        }
        if (state.value.selected == ref) { if (state.value.nativeDisplay) nativeReady(cols, rows) else terminalReady(cols, rows) }
        return "You chose: $label"
    }
    private fun terminalOf(ref: TerminalRef) = state.value.machines[ref.hostId]?.terminals?.find { it.address == ref.address }
    private fun previewTerminal() = state.value.selected?.let(::terminalOf)
    /** What a notification says under its title: what the agent asks or said, and where it runs. */
    private fun detail(a: Alerts.Alert): String {
        val where = state.value.machines[a.ref.hostId]?.spaces?.find { a.ref.address in it.addresses }?.name ?: hostName(a.ref.hostId)
        val what = a.terminal.message.ifBlank { if (a.kind == Alerts.BLOCKED) statusLabel("blocked", a.terminal.kind) else "Finished its turn" }
        return "$what · $where"
    }
    /** True once: the first time a machine connects and notifications aren't allowed yet. */
    fun shouldAskNotifications(): Boolean {
        if (Notify.allowed(getApplication()) || prefs.getBoolean("asked_notifications", false)) return false
        prefs.edit { putBoolean("asked_notifications", true) }; return true
    }
    fun setLockAnswers(on: Boolean) { prefs.edit { putBoolean("lock_answers", on) }; _state.update { it.copy(lockAnswers = on) } }
    /** A notification's Reply: typed into the agent like the composer; returns what to show in the notification. */
    suspend fun reply(ref: TerminalRef, text: String): String {
        val c = clients[ref.hostId] ?: return "Not sent: ${hostName(ref.hostId)} isn’t connected. Open Automagik to reconnect."
        return withTimeoutOrNull(8_000) {
            runCatching { c.call("terminal.send", JSONObject().put("terminal", ref.address).put("text", text)) }
                .fold({ "You: $text" }, { e -> "Not sent: ${e.message ?: "the core refused it"}" })
        } ?: "Not confirmed: check the terminal before sending again."
    }
    fun setAlerts(sounds: Boolean = state.value.alertSounds, blocked: Boolean = state.value.alertBlocked, done: Boolean = state.value.alertDone) {
        prefs.edit { putBoolean("alert_sounds", sounds); putBoolean("alert_blocked", blocked); putBoolean("alert_done", done) }
        _state.update { it.copy(alertSounds = sounds, alertBlocked = blocked, alertDone = done) }
    }
    fun playAlert() = Alerts.play(getApplication())
    private fun encryption(hostId: String) = state.value.hosts.find { it.id == hostId }?.encryption ?: "encrypted"
    /** [listed]: a terminal.list this event already read. */
    private suspend fun refresh(id: String, client: CoreClient, listed: JSONObject? = null) {
        val list = listed ?: client.call("terminal.list")
        val terminals = list.optJSONArray("terminals")?.objects()?.map(CoreTerminal::parse).orEmpty()
        val local = client.call("doc.get", JSONObject().put("name", "herdr-app"))
        val home = homes.getOrPut(id) { exec(client, "printenv", "HOME") }
        val own = LayoutReader.spaces(local.optJSONObject("value"), terminals = terminals, home = home)
        val names = list.optJSONArray("machines")?.objects().orEmpty().filter { it.clean("state") == "connected" }.map { it.getString("name") }
        val linked = LinkedMachine.list(list, terminals)
        // Compared with this connection's previous read only, so connecting never replays what was already waiting.
        val previous = alertBase[id]?.takeIf { it.first === client }?.second
        alertBase[id] = client to terminals
        // The core's own terminals and spaces at once, then its alerts and git: never behind a linked machine's layout,
        // which is read in the background and lands as it answers ([HostReads.refresh]).
        reads(id, client).refresh(CoroutineScope(viewModelScope.coroutineContext + Dispatchers.IO), terminals, own, names, linked,
            System.currentTimeMillis(), ownRead = {
                // One pass over every terminal: [paned] only tells a sub-agent without a pane of its own.
                val paned = state.value.machines[id]?.spaces.orEmpty().flatMap { it.addresses }.toSet()
                alert(Alerts.changes(previous, terminals, id) { it.address in paned }, client)
                Alerts.resolved(previous, terminals, id) { it.address in paned }.forEach { Notify.cancel(getApplication(), it) }
                gitWake.trySend(Unit)
            }, linkedRead = { gitWake.trySend(Unit) })   // a linked machine's new spaces need git too
        rememberLinked(id, linked.map { it.name })
        // The desktop assigns colours as spaces appear; read them again now and then, never write them.
        val now = System.currentTimeMillis()
        if (now - (colorsRead[id] ?: 0L) > 30_000) { colorsRead[id] = now; runCatching { readColors(id, client) } }
        runCatching { fetchIcons(id, client, terminals) }
        // The meter publishes at most every 10 minutes: a read every 5 is plenty, and pull to refresh reads at once.
        if (now - (meterRead[id] ?: 0L) > 300_000) { meterRead[id] = now; runCatching { readMeter(id, client, linked) } }
    }
    /**
     * Each machine's usage-meter doc, read only. A machine whose read fails keeps its last doc (shown as stale); one
     * that answers with no doc has no meter.
     */
    private suspend fun readMeter(id: String, client: CoreClient, linked: List<LinkedMachine>) {
        val read = HashMap<String, Spend.Reading?>()
        val feeds = HashMap<String, SpaceFeed.Feed?>()
        val own = state.value.hosts.find { it.id == id }?.name ?: "Machine"
        // Every machine's doc at once, each time-boxed: a slow machine keeps its last doc without delaying the others.
        val machines = listOf("") + linked.filter { it.connected }.map { it.name }
        for ((m, doc) in reads(id, client).docs(Spend.DOC, machines)) if (doc != null) {
            val v = doc.optJSONObject("value"); read[m] = Spend.parse(m.ifBlank { own }, v); feeds[m] = SpaceFeed.parse(v)
        }
        updateMachine(id) { m -> m.copy(meter = (m.meter - read.filterValues { it == null }.keys) + read.mapNotNull { (k, v) -> v?.let { k to it } },
            space = (m.space - feeds.filterValues { it == null }.keys) + feeds.mapNotNull { (k, v) -> v?.let { k to it } }) }
        runCatching { readBots(id, client) }
    }
    /**
     * Bot and category names for the bot cards, and each project's bots for the Teams tab: each project's registry file
     * ([Teams.registry], today `.herdr/bots.json`), read only, on machines that are up: one call per machine
     * ([HostBatch.FILES]), the machines at once. Read after each meter read (every 5 minutes), and when a project first
     * appears ([gitPass]). A project with no file, or one that doesn't parse, gets empty names (its bots show their ids)
     * and isn't read again until the next meter read; a read that fails keeps the names read before.
     */
    private suspend fun readBots(id: String, client: CoreClient) {
        val m = state.value.machines[id] ?: return
        val byAddress = m.terminals.associateBy { it.address }
        reads(id, client).registries(m.spaces.mapNotNull { s ->
            SpaceFeed.projectKey(m.git[Sidebar.gitKey(s.machine, Sidebar.place(s, byAddress))])?.let { s.machine to it }
        })
    }
    /** Herdr desktop's config folder on the core's machine (it may have none: a core running without the desktop app). */
    private suspend fun herdrHome(id: String, client: CoreClient): String? = herdrHomes[id] ?: exec(client, "printenv", "HERDR_APP_HOME")
        .ifBlank { (homes[id] ?: exec(client, "printenv", "HOME")).ifBlank { return null } + "/.config/herdr-app" }.also { herdrHomes[id] = it }
    /** The desktop's own icons for the programs on screen, read from its icons folder once per launch; the APK bundles none. */
    private suspend fun fetchIcons(id: String, client: CoreClient, terminals: List<CoreTerminal>) {
        val wanted = (terminals.map { programs.of(it).icon } + listOf(programs.agent.icon, programs.shell.icon, programs.program.icon))
            .filter { ProgramIcons.valid(it) && "$id|$it" !in iconsTried && !ProgramIcons.fresh(it) }.distinct()
        if (wanted.isEmpty()) return
        val home = herdrHome(id, client) ?: return
        for (icon in wanted) {
            iconsTried += "$id|$icon"
            runCatching { client.call("file.read", JSONObject().put("path", "$home/$icon")) }.getOrNull()
                ?.takeIf { it.optInt("last") >= it.optInt("lines") }?.optString("text")?.takeIf { it.contains("<svg") }
                ?.let { ProgramIcons.save(icon, it) }
        }
    }
    private suspend fun gitPass(id: String, client: CoreClient) {
        val m = state.value.machines[id]?.takeIf { it.connected } ?: return
        val byAddress = m.terminals.associateBy { it.address }
        val working = m.terminals.filter { it.status == "working" }.map { it.address }.toSet()
        val stopped = wasWorking.put(id, working).orEmpty() - working
        // Each space's folder, and each agent's own working directory (a worktree can be another task's branch), by the
        // terminals whose stopping should re-check it.
        val places = LinkedHashMap<Pair<String, String>, MutableSet<String>>()
        for (s in m.spaces) places.getOrPut(s.machine to Sidebar.place(s, byAddress)) { HashSet() } += s.addresses
        for (t in m.terminals) if (t.live && t.status.isNotBlank() && t.cwd.isNotBlank())
            places.getOrPut(t.address.substringBefore('/', "") to t.cwd) { HashSet() } += t.address
        val due = ArrayList<Pair<String, String>>()
        for ((where, addresses) in places) {
            val (machine, place) = where
            // Only folders the core reported, on machines that are up.
            if (!place.startsWith("/") || (machine.isNotBlank() && m.linked.find { it.name == machine }?.connected != true)) continue
            val key = Sidebar.gitKey(machine, place); val full = "$id|$key"
            // A terminal that stops working may have committed or switched branch.
            if (addresses.any { it in stopped }) gitDirty += full
            val now = System.currentTimeMillis()
            val last = gitChecked[full]
            val dirty = gitDirty.remove(full)
            val known = state.value.machines[id]?.git?.containsKey(key) == true
            val repo = state.value.machines[id]?.git?.get(key) != null
            if (!(last == null || dirty || (gitShown && (repo || !known) && now - last > 60_000))) continue
            gitChecked[full] = now
            due += where
        }
        // Each machine on its own and at once (a slow or unreachable one holds back only its own folders), the space
        // folders first (they come first in [places]). Unsure (machine away, odd error): keep the last answer, retry in 15 s.
        reads(id, client).git(due) { machine, place -> gitChecked["$id|${Sidebar.gitKey(machine, place)}"] = System.currentTimeMillis() - 45_000 }
    }
    /** Space colours and icons from the desktop's shared.json ([Teams.looks]: the am.* keys, else the old ones), read only. */
    private suspend fun readColors(id: String, client: CoreClient) {
        val home = herdrHome(id, client) ?: return
        val read = client.call("file.read", JSONObject().put("path", "$home/shared.json"))
        if (read.optInt("last") < read.optInt("lines")) return
        val looks = Teams.looks(JSONObject(read.optString("text", "{}")))
        updateMachine(id) { it.copy(colors = looks.colors, icons = looks.icons) }
        fetchSpaceIcons(id, client, home, looks.icons.values)
    }
    /**
     * A file's bytes on the core's machine (or [on] another one it reaches), through machine.exec: at most [max] bytes are
     * read (`head -c`), and a larger file is refused. Null if it failed; cancellation is passed on.
     */
    private suspend fun readBytes(client: CoreClient, path: String, max: Int, on: String = ""): ByteArray? {
        val params = JSONObject().put("argv", JSONArray(listOf("head", "-c", "${max + 1}", path)))
        if (on.isNotBlank()) params.put("on", on)
        val r = try { withTimeout(30_000) { client.call("machine.exec", params) } }
            catch (e: CancellationException) { if (e is TimeoutCancellationException) return null else throw e } catch (_: Exception) { return null }
        if (r.optBoolean("timed_out") || r.optInt("code", 1) != 0) return null
        return runCatching { java.util.Base64.getDecoder().decode(r.optString("stdout")) }.getOrNull()?.takeIf { it.isNotEmpty() && it.size <= max }
    }
    /** The desktop's space images (PNG or SVG under its space-icons folder), copied once; the APK bundles none. */
    private suspend fun fetchSpaceIcons(id: String, client: CoreClient, home: String, icons: Collection<Teams.Icon>) {
        val app = getApplication<Application>()
        var saved = false
        for (file in icons.filterIsInstance<Teams.Icon.Image>().map { it.file }.distinct()) {
            if (!Teams.safeIconFile(file) || SpaceIcons.cached(app, id, file) || "$id|$file" in spaceIconsTried) continue
            readBytes(client, "$home/$file", ICON_MAX)?.let { SpaceIcons.save(app, id, file, it); saved = true }
            spaceIconsTried += "$id|$file"   // tried only once the read finished (a cancelled one is tried again)
        }
        if (saved) _state.update { it.copy(iconsVersion = it.iconsVersion + 1) }
    }
    /**
     * The bots' own pets, from the folder the desktop bakes them into (~/.automagik/bots/pets/<id>, RFC 0014), copied
     * once per launch; until then, and for bots on other machines, Genie. The phone never bakes.
     */
    /** Fetches [teams]' pets in a job of its own, one per machine at a time, so a new reading doesn't cancel it. */
    private fun startPets(id: String, client: CoreClient, teams: List<Teams.Team>) {
        val app = getApplication<Application>()
        val wanted = teams.filter { it.machine.isBlank() }.flatMap { t -> t.bots.mapNotNull { Teams.petId(it.pet) } }.distinct()
            .filter { it != Teams.GENIE && "$id|$it" !in petsTried && !Pets.cached(app, it) }
        if (wanted.isEmpty() || petJobs[id]?.isActive == true) return
        petJobs[id] = viewModelScope.launch(Dispatchers.IO) { fetchPets(id, client, wanted) }
    }
    private suspend fun fetchPets(id: String, client: CoreClient, wanted: List<String>) {
        val app = getApplication<Application>()
        val home = homes[id] ?: execText(client, "printenv", "HOME").also { if (it.isNotBlank()) homes[id] = it }
        if (home.isBlank()) return
        val bots = execText(client, "printenv", "AUTOMAGIK_BOTS_HOME").ifBlank {
            execText(client, "printenv", "AUTOMAGIK_HOME").ifBlank { null }?.let { "$it/bots" } ?: "$home/.automagik/bots" }
        var any = false
        for (pet in wanted) {
            val sheet = readBytes(client, "$bots/pets/$pet/spritesheet.webp", PET_SHEET_MAX)
            if (sheet != null) any = Pets.save(app, pet, sheet, readBytes(client, "$bots/pets/$pet/sleep.webp", PET_SLEEP_MAX)) || any
            petsTried += "$id|$pet"   // only once its reads finished: a cancelled fetch tries again
        }
        if (any) _state.update { it.copy(iconsVersion = it.iconsVersion + 1) }
    }
    /** [exec], but passing cancellation on. */
    private suspend fun execText(client: CoreClient, vararg argv: String): String = try {
        val r = client.call("machine.exec", JSONObject().put("argv", JSONArray(argv.toList())))
        if (r.optInt("code", 1) != 0) "" else String(java.util.Base64.getDecoder().decode(r.optString("stdout")), Charsets.UTF_8).trim()
    } catch (e: CancellationException) { throw e } catch (_: Exception) { "" }
    /** A program's trimmed output on the core's machine, or "" if it failed. */
    private suspend fun exec(client: CoreClient, vararg argv: String): String = runCatching {
        val r = client.call("machine.exec", JSONObject().put("argv", JSONArray(argv.toList())))
        if (r.optInt("code", 1) != 0) "" else String(java.util.Base64.getDecoder().decode(r.optString("stdout")), Charsets.UTF_8).trim()
    }.getOrDefault("")
    /** Saves which machines a core reaches, so the start screen lists them before the next connection. */
    private fun rememberLinked(id: String, names: List<String>) {
        val hosts = state.value.hosts
        if (hosts.none { it.id == id && it.linked != names }) return
        saveHosts(hosts.map { if (it.id == id) it.copy(linked = names) else it })
    }

    // Called only once the local terminal page has measured its actual viewport.
    fun terminalReady(columns: Int, lines: Int) {
        cols = columns.coerceIn(2, 500); rows = lines.coerceIn(2, 300)
        val selected = state.value.selected ?: return
        if (state.value.demo) {
            val rev = ++attachRevision
            resetTerminal?.invoke(rev)
            val t = state.value.machines[selected.hostId]?.terminals?.find { it.address == selected.address }
            terminalBytes?.invoke(rev, -1, ("\u001b[2J\u001b[H\u001b[38;2;127;216;234mAutomagik\u001b[0m  ·  Interface preview\r\n\r\n" +
                "\u001b[38;2;166;189;145m❯\u001b[0m ${t?.agent ?: "shell"}\r\n\r\n" +
                "  \u001b[1m${t?.title}\u001b[0m\r\n\r\n  ${t?.message ?: "Ready for your next task."}\r\n\r\n" +
                "  This is sample output. Connect your machine for a live terminal.\r\n\r\n" +
                previewMenu(t).replace("\n", "\r\n")).toByteArray())
            _state.update { it.copy(terminalStatus = "Preview • sample output") }
            return
        }
        val client = clients[selected.hostId] ?: run { _state.update { it.copy(terminalStatus = "Connect this machine to open its terminal") }; return }
        val rev = ++attachRevision
        resetTerminal?.invoke(rev)
        val streamModes = TerminalModes()
        modes = streamModes
        attachJob = viewModelScope.launch(Dispatchers.IO) {
            activeChannel?.let { (old, channel) -> runCatching { old.detach(channel) } }; activeChannel = null
            var opened: Int? = null
            var streamEnded = false
            try {
                val channel = client.attach(selected.address, cols, rows, { ch, bytes ->
                    streamModes.feed(bytes)
                    if (attachRevision == rev) terminalBytes?.invoke(rev, ch, bytes)
                }, { reason ->
                    streamEnded = true
                    if (attachRevision == rev) { activeChannel = null; _state.update { it.copy(terminalStatus = reason) } }
                })
                opened = channel
                if (attachRevision == rev && !streamEnded) {
                    activeChannel = client to channel
                    _state.update { it.copy(terminalStatus = "Live • ${encryption(selected.hostId)}") }
                } else client.detach(channel)
            } catch (e: CancellationException) { opened?.let { runCatching { client.detach(it) } }; throw e }
            catch (e: Exception) { if (attachRevision == rev) _state.update { it.copy(terminalStatus = e.message ?: "Could not attach") } }
        }
    }
    fun resized(columns: Int, lines: Int) {
        cols = columns.coerceIn(2, 500); rows = lines.coerceIn(2, 300)
        val pair = activeChannel ?: return
        viewModelScope.launch(Dispatchers.IO) { runCatching { pair.first.send(pair.second, Wire.RESIZE, Wire.resize(cols, rows)) } }
    }
    fun rendererFailed() {
        detach()
        _state.update { it.copy(nativeDisplay = true, terminalStatus = "Connecting text display…") }
    }
    fun preferNativeDisplay(native: Boolean) {
        detach()
        prefs.edit().putBoolean("native_display", native).apply()
        _state.update { it.copy(nativeDisplay = native) }
    }
    fun nativeReady(columns: Int, lines: Int) {
        if (state.value.demo) {
            _state.update { it.copy(screenText = previewScreen(previewTerminal()), terminalStatus = "Preview • sample output") }
            return
        }
        val ref = state.value.selected ?: return
        val client = clients[ref.hostId] ?: return
        if (activeChannel != null) { resized(columns, lines); return }
        nativeJob?.cancel()
        val rev = ++attachRevision
        cols = columns.coerceIn(2, 500); rows = lines.coerceIn(2, 300)
        nativeJob = viewModelScope.launch(Dispatchers.IO) {
            val modes = TerminalModes()
            this@PocketViewModel.modes = modes
            val updates = Channel<Unit>(Channel.CONFLATED)
            var snapshotJob: Job? = null
            try {
                // Wait for an attach reply even when navigation cancels the view,
                // so a late stream can be explicitly closed rather than orphaned.
                val channel = withContext(NonCancellable) {
                    client.attach(ref.address, cols, rows, { ch, bytes ->
                        modes.feed(bytes)
                        client.send(ch, Wire.CREDIT, Wire.credit(bytes.size))
                        updates.trySend(Unit)
                    }, { reason -> if (rev == attachRevision) _state.update { it.copy(terminalStatus = reason) } }, history = 0)
                }
                if (rev != attachRevision) { client.detach(channel); return@launch }
                activeChannel = client to channel
                _state.update { it.copy(terminalStatus = "Live • ${encryption(ref.hostId)} · text display") }
                snapshotJob = launch {
                    for (ignored in updates) {
                        delay(100)
                        try {
                            val alternate = modes.alternate
                            val screen = client.call("terminal.read", JSONObject().put("terminal", ref.address).put("lines", if (alternate) 0 else 500))
                            if (rev == attachRevision) _state.update { it.copy(screenText = screen.optString("text"), nativeAlternateScreen = alternate) }
                        } catch (e: CancellationException) { throw e }
                        catch (e: Exception) { if (rev == attachRevision) _state.update { it.copy(terminalStatus = e.message ?: "Could not read terminal") } }
                    }
                }
                updates.trySend(Unit)
                awaitCancellation()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (rev == attachRevision) _state.update { it.copy(terminalStatus = e.message ?: "Could not open terminal") } }
            finally {
                snapshotJob?.cancel(); updates.close()
                if (rev == attachRevision) {
                    val active = activeChannel; activeChannel = null
                    active?.let { runCatching { it.first.detach(it.second) } }
                }
            }
        }
    }
    fun acknowledge(revision: Long, channel: Int, bytes: Int) {
        if (revision != attachRevision || channel < 0) return
        val ref = state.value.selected ?: return
        val c = clients[ref.hostId] ?: return
        viewModelScope.launch(Dispatchers.IO) { runCatching { c.send(channel, Wire.CREDIT, Wire.credit(bytes)) } }
    }
    /** Sends input to the attached terminal. Typed keys consume any Ctrl/Alt armed on the key bar. */
    fun type(bytes: ByteArray, modifiable: Boolean = true) {
        val pair = activeChannel ?: return
        val mods = state.value.modifiers
        val modified = if (modifiable) KeyInput.modify(bytes, mods) else null
        if (modified != null) _state.update { it.copy(modifiers = KeyModifiers()) }
        if (!keystrokes.trySend(pair to (modified ?: bytes)).isSuccess) _state.update { it.copy(message = "Input queue is full. Wait for the connection to catch up.") }
    }
    /** A key-bar key: honors the program's cursor-key mode, then any armed modifiers. */
    fun pressKey(bytes: ByteArray) {
        type(if (state.value.modifiers.any) bytes else KeyInput.cursorKeys(bytes, modes.applicationCursor))
    }
    fun paste(text: String) {
        if (text.isEmpty() || activeChannel == null) return
        if (text.length > 256 * 1024) { _state.update { it.copy(message = "Clipboard is too large to paste into a terminal.") }; return }
        type(KeyInput.paste(text, modes.bracketedPaste), modifiable = false)
    }
    // Native snapshots have local shell history. Only alternate-screen apps receive scroll keys.
    fun scrollNative(lines: Int) {
        if (!state.value.nativeAlternateScreen || lines == 0) return
        val current = modes
        if (current.mouseTracking && current.sgrMouse) {
            val button = if (lines < 0) 64 else 65
            repeat(kotlin.math.abs(lines).coerceAtMost(12)) { type("\u001b[<$button;${(cols / 2).coerceAtLeast(1)};${(rows / 2).coerceAtLeast(1)}M".toByteArray(), modifiable = false) }
        } else {
            type((if (lines < 0) "\u001b[5~" else "\u001b[6~").toByteArray(), modifiable = false)
        }
    }
    fun sendMessage(text: String, confirmed: () -> Unit = {}) {
        val ref = state.value.selected ?: return
        if (text.isBlank() || state.value.sending) return
        val c = clients[ref.hostId]
        if (c == null) {
            // The preview has no link and a disconnected machine none either: say so instead of a dead Send.
            _state.update { it.copy(message = if (state.value.demo) "Preview • this sample terminal does not send. Connect a machine to message the agent."
                else "Connect this machine to send a message.") }
            return
        }
        _state.update { it.copy(sending = true) }
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { c.call("terminal.send", JSONObject().put("terminal", ref.address).put("text", text)) }
                .onSuccess { withContext(Dispatchers.Main) { confirmed() } }
                .onFailure { e -> _state.update { it.copy(message = "Message not confirmed: ${e.message}. Check the terminal before retrying.") } }
            _state.update { it.copy(sending = false) }
        }
    }
    // ---- The live chat (RFC 0015 delivery 5) over Pocket Link's chat route. Its rows are only in [chat], in memory:
    // never in preferences, Room or the log (docs/privacy.md). One chat open at a time, on its own connection.
    private val _chat = MutableStateFlow<Chat.State?>(null)
    val chat = _chat.asStateFlow()
    /** Each machine's Automagik Bot chats (read only), as chat.list gave them; null while loading. */
    private val _botChats = MutableStateFlow<Map<String, Result<List<Chat.Terminal>>?>>(emptyMap())
    val botChats = _botChats.asStateFlow()
    /** What the phone saw of each Bot chat between readings ([ChatWatch]): Home's word for it and its receipt. */
    private val _chatWatch = MutableStateFlow<Map<String, ChatWatch.Watched>>(emptyMap())
    val chatWatch = _chatWatch.asStateFlow()
    /** Whether each machine's bridge takes the phone's writes on its Bot chats (`dshWrite`), from the last listing. */
    private val _botWrites = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    val botWrites = _botWrites.asStateFlow()
    private var chatJob: Job? = null
    @Volatile private var chatRef: TerminalRef? = null
    @Volatile private var chatLink: ChatLink? = null
    @Volatile private var chatGen = 0
    /**
     * How [openChatLink] reaches a chat route. It is the production Pocket Link route by default; a unit test points
     * it at a fake bridge to drive the chat wiring without a device (#754). The app never sets it.
     */
    internal var chatOpener: suspend (hostId: String, scope: CoroutineScope, lost: (String) -> Unit) -> ChatLink =
        { hostId, scope, lost -> connectChatLink(hostId, scope, lost) }
    /** Automatic reconnects of the open DSH chat since its last snapshot (main thread only); see [Chat.RESUMABLE]. */
    private var resumeAttempt = 0
    private var resumeJob: Job? = null

    private suspend fun openChatLink(hostId: String, scope: CoroutineScope, lost: (String) -> Unit): ChatLink =
        chatOpener(hostId, scope, lost)

    /** The production chat route: Iroh to the paired desktop, then Pocket Link's chat version 1 ([ChatClient]). */
    private suspend fun connectChatLink(hostId: String, scope: CoroutineScope, lost: (String) -> Unit): ChatLink {
        val profile = state.value.hosts.find { it.id == hostId && it.paired } ?: error("This machine isn’t paired with Pocket Link.")
        val t = try { IrohLink.open(getApplication(), profile.ticket, profile.session, scope, IrohLink.CHAT) }
            catch (e: Exception) { if (e !is CancellationException && ChatClient.refusedRoute(e)) throw ChatUnsupported() else throw e }
        return withTimeout(20_000) { PocketLinkChat(ChatClient.start(CoreClient(t.input, t.output, t, scope, lost))) }
    }

    private fun chatUpdate(gen: Int, change: (Chat.State) -> Chat.State) {
        _chat.update { s -> if (s == null || gen != chatGen) s else change(s) }
    }

    /**
     * Opens [ref]'s chat (a terminal's, or a `dsh:` Bot chat); the same chat already open stays as it is. Reopening
     * the same chat (a reconnect) keeps the messages whose outcome is unknown as "maybe not sent", with Retry, and
     * what [Chat.carry] names, so the cards that closed meanwhile get their receipts (#733).
     */
    fun openChat(ref: TerminalRef) = openChat(ref, resuming = false)

    /**
     * [resuming]: an automatic reconnect of a DSH chat whose bots-dsh socket went away ([resumeLater]). A new
     * connection, so the bridge greets the socket again and its hello says `dshWrite` afresh.
     */
    private fun openChat(ref: TerminalRef, resuming: Boolean) {
        if (chatRef == ref && chatJob?.isActive == true) return
        val prior = _chat.value?.takeIf { chatRef == ref }
        val unknown = prior?.let(Chat::unknown).orEmpty()
        val attempt = if (resuming) resumeAttempt else 0
        closeChat()
        resumeAttempt = attempt
        val gen = ++chatGen
        chatRef = ref
        _chat.value = Chat.carry(prior, Chat.State(ref.address, messages = unknown, resuming = resuming, error = if (resuming) Chat.RESUMING else null))
        if (state.value.demo) {
            _chat.value = ChatDemo.stateFor(ref) ?: Chat.State(ref.address, error = "Chat needs a connected machine.")
            return
        }
        chatJob = viewModelScope.launch(Dispatchers.IO) {
            val scope = CoroutineScope(coroutineContext + SupervisorJob(coroutineContext[Job]))
            var link: ChatLink? = null
            try {
                link = openChatLink(ref.hostId, scope) { reason -> chatUpdate(gen) { it.copy(connected = false, error = "Chat disconnected: $reason",
                    messages = it.messages.map { m -> if (m.state == "sending") m.copy(state = "maybe") else m }) } }
                chatLink = link
                val dshWrite = link.dshWrite
                chatUpdate(gen) { it.copy(dshWrite = dshWrite) }
                if (!Chat.isDsh(ref.address) && link.list().none { it.terminal == ref.address }) { chatUpdate(gen) { it.copy(error = Chat.NO_CHAT) }; return@launch }
                chatSubscribe(link, ref.address, null, gen)
                awaitCancellation()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                // A DSH chat coming back keeps trying (within RESUME_DELAYS_MS); anything else waits for Reconnect.
                if (resuming && e !is ChatUnsupported) { chatUpdate(gen) { it.copy(connected = false) }; viewModelScope.launch { resumeLater(ref, gen) } }
                else chatUpdate(gen) { it.copy(connected = false, resuming = false, error = e.message ?: "Chat couldn’t connect") }
            }
            finally { if (chatLink === link) chatLink = null; link?.close() }
        }
    }

    /**
     * After an event of chat [gen] (main thread): a snapshot ends the reconnect count; a `gone` that left the chat
     * resuming connects again after a wait. The open DSH chat's state goes into its chat.list row, so Team's bubble
     * and Home's rows say what the chat says.
     */
    private fun chatEvent(gen: Int, type: String) {
        val ref = chatRef
        val s = _chat.value
        if (gen != chatGen || ref == null || s == null) return
        when (type) {
            "snapshot" -> resumeAttempt = 0
            "gone" -> if (s.resuming) resumeLater(ref, gen)
        }
        if (s.dsh && s.connected) {
            _botChats.update { m ->
                val list = m[ref.hostId]?.getOrNull() ?: return@update m
                val now = Chat.withStatus(list, ref.address, s.status, Chat.asked(s))
                if (now === list) m else m + (ref.hostId to Result.success(now))
            }
            if (type == "snapshot" || type == "status") _chatWatch.update { ChatWatch.status(it, ChatWatch.key(ref.hostId, ref.address), s.status.state, System.currentTimeMillis()) }
        }
    }

    /** The next automatic reconnect of DSH chat [ref], or, past [Chat.RESUME_DELAYS_MS], the Reconnect button. */
    private fun resumeLater(ref: TerminalRef, gen: Int) {
        if (gen != chatGen || chatRef != ref) return
        val wait = Chat.resumeDelayMs(resumeAttempt)
            ?: return chatUpdate(gen) { it.copy(resuming = false, error = Chat.NOT_ANSWERING) }
        resumeAttempt++
        resumeJob?.cancel()
        resumeJob = viewModelScope.launch {
            delay(wait)
            if (gen == chatGen && chatRef == ref) { chatJob?.cancel(); chatJob = null; openChat(ref, resuming = true) }
        }
    }

    private suspend fun chatSubscribe(link: ChatLink, terminal: String, after: String?, gen: Int) {
        link.subscribe(terminal, after, { e ->
            val before = _chat.value?.takeIf { gen == chatGen }?.receipts.orEmpty()
            chatUpdate(gen) { Chat.reduce(it, e) }
            val type = e.optString("type")
            // A closed card's receipt goes on the chat's Home row, for its Done line: one seen close, or the newest a
            // reconnect's snapshot found settled while the phone was away.
            if (Chat.isDsh(terminal)) {
                val fresh = _chat.value?.takeIf { gen == chatGen }?.receipts.orEmpty().filter { r -> before.none { it.id == r.id } }
                (Chat.receiptLine(e) ?: fresh.lastOrNull { it.settled }?.let(Chat::doneLine))
                    ?.let { line -> chatRef?.let { r -> _chatWatch.update { ChatWatch.receipt(it, ChatWatch.key(r.hostId, terminal), line) } } }
            }
            viewModelScope.launch { chatEvent(gen, type) }
        }) { reason ->
            // Too slow to keep up: the bridge closed the stream; come back from the cursor.
            if (reason == "slow" && gen == chatGen) viewModelScope.launch(Dispatchers.IO) {
                runCatching { chatSubscribe(link, terminal, _chat.value?.cursor, gen) }
                    .onFailure { e -> chatUpdate(gen) { it.copy(connected = false, error = e.message) } }
            } else chatUpdate(gen) { it.copy(connected = false, error = if (reason.isBlank()) "The chat closed." else "The chat closed: $reason") }
        }
    }

    /** Closes the chat for [ref] (any chat when null); its rows are dropped. */
    fun closeChat(ref: TerminalRef? = null) {
        if (ref != null && ref != chatRef) return
        // bots-dsh stops following a Bot chat no phone watches: what it lists next is not a finish ([ChatWatch.left]).
        chatRef?.takeIf { Chat.isDsh(it.address) }?.let { r -> _chatWatch.update { ChatWatch.left(it, ChatWatch.key(r.hostId, r.address)) } }
        ++chatGen
        chatRef = null
        chatJob?.cancel(); chatJob = null
        resumeJob?.cancel(); resumeJob = null
        resumeAttempt = 0
        _chat.value = null
    }

    private val held = Background.Held()
    /**
     * The main screen stopped (the app left, or the screen off) or started: a stopped one streams nothing, so the
     * attached terminal and the open chat let go, and the next start takes them back where the person left them.
     */
    fun streams(started: Boolean) {
        if (!started) {
            held.stop(activeChannel != null || attachJob?.isActive == true || nativeJob?.isActive == true, chatRef?.takeIf { chatJob?.isActive == true || resumeJob?.isActive == true })
            dropStream()
            chatJob?.cancel(); chatJob = null
            resumeJob?.cancel(); resumeJob = null
            return
        }
        val (terminal, chat) = held.start()
        if (terminal && state.value.selected != null) { if (state.value.nativeDisplay) nativeReady(cols, rows) else terminalReady(cols, rows) }
        if (chat != null && chat == chatRef) openChat(chat)
    }
    /** Connects the open chat again after it dropped. */
    fun reconnectChat() { val ref = chatRef ?: return; chatJob?.cancel(); chatJob = null; openChat(ref) }

    /** The preview has no chat link: its controls say so instead of pretending, and the sample stays as drawn. */
    private fun previewChat(): Boolean {
        if (!state.value.demo) return false
        chatUpdate(chatGen) { it.copy(notice = ChatDemo.SAMPLE_ONLY) }
        return true
    }

    /** The preview's answer: the card leaves as a real answer would, and the notice says nothing was sent. */
    private fun previewAnswer(row: Chat.Row): Boolean {
        if (!state.value.demo) return false
        chatUpdate(chatGen) { s ->
            val next = s.copy(
                approval = s.approval?.takeIf { it.id != row.id },
                question = s.question?.takeIf { it.id != row.id })
            // The sample has no bridge to send a status after the last card: leave "blocked" behind.
            if (next.approval == null && next.question == null)
                next.copy(status = Chat.Status("working", "sample", "Sample turn finished"), notice = ChatDemo.SAMPLE_ONLY)
            else next.copy(notice = ChatDemo.SAMPLE_ONLY)
        }
        return true
    }

    private fun chatAct(block: suspend (ChatLink, Chat.State, Int) -> Unit) {
        val link = chatLink ?: return
        val s = _chat.value ?: return
        val gen = chatGen
        viewModelScope.launch(Dispatchers.IO) { block(link, s, gen) }
    }

    /** Sends [text] to the open chat; a chat that cannot send (read only, ended, reconnecting) says why instead. */
    fun chatSend(text: String, id: String = UUID.randomUUID().toString()) {
        val s = _chat.value ?: return
        if (text.isBlank()) return
        if (previewChat()) return
        if (!ChatActions.canSend(s)) { chatUpdate(chatGen) { it.copy(notice = ChatActions.whyNoSend(it) ?: "Not sent: the chat isn’t ready yet.") }; return }
        chatUpdate(chatGen) { it.copy(messages = it.messages.filterNot { m -> m.id == id } + Chat.Message(id, text, "sending")) }
        chatAct { link, st, gen ->
            runCatching { link.send(st.terminal, text, id) }
                .onSuccess { a -> chatUpdate(gen) { Chat.answered(it, id, text, a) } }
                .onFailure { chatUpdate(gen) { Chat.unanswered(it, id, text) } }
        }
    }

    /** A message that may not have gone: sent again with the same id, so the bridge types it at most once. */
    fun chatRetry(m: Chat.Message) { if (_chat.value?.let { ChatActions.canRetry(it, m) } == true) chatSend(m.text, m.id) }

    fun chatSendHeld(m: Chat.Message) {
        val s = _chat.value ?: return
        if (!ChatActions.canSendHeld(s, m)) return
        chatAct { link, st, gen ->
            runCatching { link.sendHeld(st.terminal, m.id) }
                .onSuccess { a -> chatUpdate(gen) { Chat.answered(it, m.id, m.text, a) } }
                .onFailure { chatUpdate(gen) { Chat.unanswered(it, m.id, m.text) } }
        }
    }

    fun chatCancelHeld(m: Chat.Message) {
        val s = _chat.value ?: return
        if (s.dsh) return
        chatAct { link, st, gen ->
            runCatching { link.cancelHeld(st.terminal, m.id) }
                .onSuccess { a -> if (a.optBoolean("ok")) chatUpdate(gen) { it.copy(messages = it.messages.filterNot { x -> x.id == m.id }) } }
        }
    }

    fun chatAnswer(row: Chat.Row, choice: String) {
        val s = _chat.value ?: return
        if (choice !in ChatActions.choices(s, row)) return
        if (previewAnswer(row)) return
        chatAct { link, st, gen ->
            val notice = runCatching { Chat.answerNotice(link.answer(st.terminal, row.id, choice), st.dsh) }.getOrElse { unconfirmed(st) }
            chatUpdate(gen) { it.copy(notice = notice) }
        }
    }

    /** A question answered on the phone: the options picked (0-based) or a typed answer, only as [ChatActions] offers it. */
    fun chatAnswerQuestion(row: Chat.Row, picked: List<Int>, text: String? = null) {
        val s = _chat.value ?: return
        val (choice, typed) = ChatActions.questionAnswer(s, row, picked, text) ?: return
        if (previewAnswer(row)) return
        chatAct { link, st, gen ->
            val notice = runCatching { Chat.answerNotice(link.answer(st.terminal, row.id, choice, typed), st.dsh) }.getOrElse { unconfirmed(st) }
            chatUpdate(gen) { it.copy(notice = notice) }
        }
    }

    fun chatInterrupt() {
        val s = _chat.value ?: return
        if (!ChatActions.canInterrupt(s)) return
        if (previewChat()) return
        chatAct { link, st, gen ->
            val notice = Chat.interruptNotice(runCatching { link.interrupt(st.terminal) }.getOrNull(), st.dsh)
            chatUpdate(gen) { it.copy(notice = notice) }
        }
    }

    /**
     * An answer the phone sent and saw no answer to (the link dropped, or it timed out). On a DSH chat the open card
     * stays and a tap sends the same row and choice, which bots-dsh settles at most once (or answers `settled`).
     */
    private fun unconfirmed(s: Chat.State) = if (s.dsh) Chat.ANSWER_MAYBE else "Not confirmed. Check the terminal."

    fun chatEarlier() {
        val before = _chat.value?.oldest ?: return
        chatAct { link, st, gen ->
            runCatching { link.backfill(st.terminal, before) }
                .onSuccess { page -> chatUpdate(gen) { Chat.earlier(it, page) } }
                .onFailure { e -> chatUpdate(gen) { it.copy(notice = e.message) } }
        }
    }

    fun dismissChatNotice() { _chat.update { it?.copy(notice = null) } }
    /** Dismisses the receipt of a card that closed while the phone was away; it does not come back on the next reconnect. */
    fun dismissReceipt(id: String) { _chat.update { it?.let { s -> Chat.dismissReceipt(s, id) } } }

    /** Reads machine [hostId]'s Automagik Bot chats (read only) for the Bot chats list, on a short-lived connection. */
    fun loadBotChats(hostId: String) {
        if (state.value.demo) return
        _botChats.update { it + (hostId to null) }
        viewModelScope.launch(Dispatchers.IO) {
            val result = runCatching {
                coroutineScope {
                    val scope = CoroutineScope(coroutineContext + SupervisorJob(coroutineContext[Job]))
                    val link = openChatLink(hostId, scope) { }
                    try { link.list().filter { it.dsh }.also { _botWrites.update { w -> w + (hostId to link.dshWrite) } } } finally { link.close(); scope.cancel() }
                }
            }
            result.getOrNull()?.let { rows -> _chatWatch.update { ChatWatch.read(it, hostId, rows, System.currentTimeMillis()) } }
            _botChats.update { it + (hostId to result) }
        }
    }

    fun startTerminal(hostId: String, cwd: String, command: String) {
        val c = clients[hostId] ?: return
        if (state.value.demo) return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val params = JSONObject().put("cwd", cwd.ifBlank { null })
                if (command.isNotBlank()) params.put("line", command)
                val spaceId = state.value.space?.takeIf { it.first == hostId }?.second
                val space = state.value.machines[hostId]?.spaces?.find { it.id == spaceId }
                if (space != null) {
                    if (space.machine.isNotBlank()) params.put("on", space.machine)
                    val localId = if (space.machine.isBlank()) space.id else space.id.removePrefix(space.machine + "/")
                    params.put("labels", JSONObject().put("herdr.space", localId).put("herdr.tab", "tb" + UUID.randomUUID().toString().replace("-", "")))
                }
                val reply = c.call("terminal.run", params)
                refresh(hostId, c)
                val address = reply.optJSONObject("terminal")?.optString("address") ?: reply.optString("address")
                if (address.isNotBlank()) selectTerminal(TerminalRef(hostId, address))
            } catch (e: Exception) { _state.update { it.copy(message = e.message ?: "Could not start terminal") } }
        }
    }
    fun detach() {
        markSeen()
        if (state.value.modifiers.any) _state.update { it.copy(modifiers = KeyModifiers()) }
        dropStream()
    }
    /** Closes the attached terminal's stream; what is selected stays. */
    private fun dropStream() {
        ++attachRevision; attachJob = null
        nativeJob?.cancel(); nativeJob = null
        val previous = activeChannel; activeChannel = null
        if (previous != null) viewModelScope.launch(Dispatchers.IO) { runCatching { previous.first.detach(previous.second) } }
    }
    /** Leaving a finished agent: like the desktop, looking at it turns its done into idle until it finishes another turn. */
    private fun markSeen() {
        val s = state.value
        val ref = s.selected ?: return
        // A Bot chat's Done is the phone's own ([ChatWatch]); a terminal's is the core's. A chat opened from its
        // pane's Home row ([PocketState.row]) is that pane looked at too.
        fun paneKey(r: TerminalRef) = s.machines[r.hostId]?.terminals?.find { it.address == r.address }?.takeIf { it.status == "done" }?.let { Cockpit.seenKey(r, it) }
        val keys = listOfNotNull(
            if (Chat.isDsh(ref.address)) _chatWatch.value[ChatWatch.key(ref.hostId, ref.address)]?.takeIf { it.status == "done" }?.let { Cockpit.seenKey(ref, it.turn) } else paneKey(ref),
            s.row?.takeIf { !Chat.isDsh(it.address) }?.let(::paneKey)).filter { it !in s.seen }
        if (keys.isEmpty()) return
        // Insertion order is kept, so the oldest go first past the cap.
        val seen = (s.seen + keys).toList().takeLast(400).toSet()
        prefs.edit { putString("seen_done", JSONArray(seen.toList()).toString()) }
        _state.update { it.copy(seen = seen) }
    }
    fun enterDemo() {
        clients.keys.toList().forEach { disconnect(it) }
        previewFailed.clear()
        val id = "preview"
        // The sample main bot's chat, listed as a real bridge would list it, so Team's bubble and the chat pane agree.
        _botChats.update { it + (id to Result.success(ChatDemo.listing())) }
        _botWrites.update { it + (id to true) }
        val terminals = listOf(
            CoreTerminal("t1", "Authentication flow", "~/work/herdr-auth", "live", "blocked", "Claude Code", "Waiting for your approval to run the test suite", 80, 24, labels = mapOf("bot" to "b-demo-test"), kind = "permission"),
            CoreTerminal("t2", "Android companion", "~/work/herdr", "live", "working", "Codex", "Building the mobile navigation", 80, 24, labels = mapOf("bot" to "b-demo-captain")),
            CoreTerminal("t3", "API review", "~/work/herdr-api", "live", "done", "Claude Code", "Reviewed 12 files · ready when you are", 80, 24, labels = mapOf("bot" to "b-demo-dev")),
            CoreTerminal("t4", "Shell", "~/work/website", "live", "", "zsh", "", 80, 24),
            CoreTerminal("t5", "Release notes", "~/work/herdr-squad", "live", "working", "Codex", "Drafting the changelog", 80, 24),
            CoreTerminal("t6", "Landing copy", "~/work/website", "live", "idle", "Claude Code", "", 80, 24, labels = mapOf("bot" to "b-demo-writer")),
            CoreTerminal("t7", "Notes", "~/work/notes", "live", "idle", "Claude Code", "", 80, 24, labels = mapOf("bot" to "b-demo-scribe")),
            // A second waiting agent, so sample data renders a deck of two cards; t9's first answer fails to
            // show the deck's error strip.
            CoreTerminal("t8", "Release gate", "~/work/herdr", "live", "blocked", "Claude Code", "Run the lint check?", 80, 24, labels = mapOf("bot" to "b-demo-review"), kind = "permission"),
            CoreTerminal("t9", "Sample deploy", "~/work/herdr", "live", "blocked", "Claude Code", "Approve the sample deploy?", 80, 24, labels = mapOf("bot" to "b-demo-flaky"), kind = "permission"))
            // Each one's last change, so the Teams rows show times and the scribe has dozed off.
            .map { t -> t.copy(statusMs = System.currentTimeMillis() - mapOf("t1" to 1L, "t2" to 3L, "t3" to 14L, "t5" to 6L, "t6" to 4L, "t7" to 95L, "t8" to 2L, "t9" to 99L).getOrDefault(t.address, 0L) * 60_000L) }
        val spaces = listOf(PocketSpace("sp1", "herdr", "~/work/herdr", "", listOf(PocketTab("tb2", "Android", listOf("t2", "t3")), PocketTab("tb1", "Authentication", listOf("t1")), PocketTab("tb7", "Release gate", listOf("t8")), PocketTab("tb8", "Deploy", listOf("t9")))),
            PocketSpace("sp3", "Release squad", "~/work/herdr-squad", "", listOf(PocketTab("tb4", "Notes", listOf("t5")))),
            PocketSpace("sp2", "Website", "~/work/website", "", listOf(PocketTab("tb3", "Shell", listOf("t4")), PocketTab("tb5", "Copy", listOf("t6")))),
            PocketSpace("sp4", "Notes", "~/work/notes", "", listOf(PocketTab("tb6", "Notes", listOf("t7")))))
        // Sample repositories: one with a squad's worktrees (its branches are tasks), one on main (untasked).
        fun repo(top: String, branch: String, common: String = "~/work/herdr/.git", remote: String = "example/herdr") =
            Sidebar.gitKey("", top) to GitInfo(branch, 0, 0, top, common, remote)
        val git = mapOf(repo("~/work/herdr", "dev"), repo("~/work/herdr-auth", "feat/auth-flow"), repo("~/work/herdr-api", "fix/api-review"),
            repo("~/work/herdr-squad", "feat/release-notes"), repo("~/work/website", "main", "~/work/website/.git", "example/website"),
            repo("~/work/notes", "main", "~/work/notes/.git", "example/notes"))
        _state.update { it.copy(demo = true, screen = Nav.HOME, selected = null, space = null, project = null,
            machines = mapOf(id to MachineState(connected = true, version = "preview", terminals = terminals, spaces = spaces, git = git,
                meter = SpendDemo.readings(System.currentTimeMillis()), space = SpendDemo.space(System.currentTimeMillis()), bots = SpendDemo.BOTS,
                members = SpendDemo.MEMBERS, icons = SpendDemo.ICONS, colors = SpendDemo.COLORS,
                // Read already: its projects are live at once.
                layouts = spaces.map { it.machine }.distinct().plus("").associateWith { 0L }))) }
    }
    private val _sheet = MutableStateFlow<StatsSheet?>(null)
    /** The Space Row card open as a bottom sheet, if any. */
    val sheet = _sheet.asStateFlow()
    fun openStats(s: StatsSheet) { _sheet.value = s }
    fun closeStats() { _sheet.value = null }
    fun leaveDemo() {
        closeChat()
        _botChats.update { it - ChatDemo.HOST }
        _botWrites.update { it - ChatDemo.HOST }
        detach()
        _state.update { it.copy(demo = false, machines = emptyMap(), selected = null, space = null, project = null) }
    }
    fun hostName(hostId: String) = if (state.value.demo) PREVIEW_MACHINE else state.value.hosts.find { it.id == hostId }?.name ?: "Machine"
    override fun onCleared() { if (current === this) current = null; closeChat(); clients.values.forEach { it.close() }; clients.clear() }
}

/** The preview's sample screen for [t]: a header, and the menu its blocked agent waits on (synthetic). */
internal fun previewScreen(t: CoreTerminal?) = "Automagik  ·  Interface preview\n\n❯ ${t?.agent ?: "shell"}\n\n  ${t?.title}\n\n" +
    "  ${t?.message ?: "Ready for your next task."}\n\n  This is sample output. Connect your machine for a live terminal.\n\n" + previewMenu(t)

/** A permission shaped like Claude Code's, for the preview's agent that is blocked on one. */
internal fun previewMenu(t: CoreTerminal?): String {
    if (t?.attention != true || t.kind != "permission") return ""
    // Each sample request carries its own command, so the second deck card does not repeat the first's block.
    val (command, purpose) = when (t.address) {
        "t8" -> "npm run lint" to "Run the lint check"
        "t9" -> "./deploy.sh" to "Deploy the sample build"
        else -> "npm test" to "Run the test suite"
    }
    return """
⏺ Bash($command)
────────────────────────────────────────
 Bash command
   $command
   $purpose
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for $command commands in this project
   3. No, and tell Claude what to do differently (esc)
 Esc to cancel
""".trimStart()
}
