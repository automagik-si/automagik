package ai.namastex.automagik

import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * The Teams tab, read off what the phone already knows: one project per Herdr space (keyed like the Space Row, by its
 * main checkout's path), its bots from the project's bot registry, and each bot's live state from the herdr-core pane
 * labelled `bot=<id>`. Pure: no Android, so the unit tests run it as it is.
 */
object Teams {
    // ---- Poses: herdr/mods/am-sidebar/rows.js poseOf, the desktop's rule, so both show the same state.
    const val WORKING = "working"
    const val IDLE = "idle"
    const val NEEDS_YOU = "needs-you"
    const val DONE = "done"
    const val FAILED = "failed"
    const val ASLEEP = "asleep"
    /** Rows in a list: most needing the person first. */
    val URGENCY = listOf(NEEDS_YOU, FAILED, WORKING, DONE, IDLE, ASLEEP)
    fun urgency(pose: String) = URGENCY.indexOf(pose).let { if (it < 0) URGENCY.size else it }
    /** Idle this long is asleep (rows.js ASLEEP_MS, Automagik's own threshold). */
    const val ASLEEP_MS = 10 * 60 * 1000L

    /** A bot's pose from its pane: none (or not live) is asleep; an idle status [ASLEEP_MS] old is asleep too. */
    fun poseOf(t: CoreTerminal?, now: Long): String {
        if (t == null || !t.live) return ASLEEP
        return when (t.status) {
            "working" -> WORKING
            "blocked" -> NEEDS_YOU
            "error" -> FAILED
            "done" -> DONE
            "idle" -> if (t.statusMs > 0 && now - t.statusMs >= ASLEEP_MS) ASLEEP else IDLE
            else -> IDLE
        }
    }

    /**
     * The pet row a pose plays: `once` first, then `row` in a loop. A mirror of STATE_ROWS and EVENT_ROWS in
     * apps/bots-dsh/src/client/pet.js; TeamsTest reads that file, so the two can't drift apart unnoticed.
     */
    data class PetRow(val once: String?, val row: String)
    val STATE_ROWS = mapOf(
        WORKING to PetRow(null, "running"), IDLE to PetRow(null, "idle"), NEEDS_YOU to PetRow("waving", "waiting"),
        DONE to PetRow(null, "review"), FAILED to PetRow(null, "failed"), ASLEEP to PetRow(null, "sleep"))
    /** One-shot events: a merge is the celebration, one jump. */
    val EVENT_ROWS = mapOf("merged" to "jumping")
    fun petRow(pose: String) = STATE_ROWS[pose] ?: STATE_ROWS.getValue(IDLE)

    // ---- Project icons: Herdr's own space icon and colour (am-sidebar spaceIconModel.js), never a second system.
    sealed interface Icon {
        data class Emoji(val char: String) : Icon
        /** [file] is relative to Herdr's app home, as Herdr stores it (space-icons/…). */
        data class Image(val file: String) : Icon
        data object Letter : Icon
    }
    const val ICONS = "am.sidebar.icons"
    const val ICONS_OLD = "spaces-agents.icons"
    const val COLORS = "am.space.colors"
    const val COLORS_OLD = "space.colors"

    /** What shared.json holds for one space, as spaceIconModel.js normalises it; anything else is the letter. */
    fun icon(value: Any?): Icon = when {
        value is String && value.isNotBlank() -> Icon.Image(value)
        value is JSONObject && value.optString("kind") == "image" && value.optString("file").isNotBlank() -> Icon.Image(value.getString("file"))
        value is JSONObject && value.optString("kind") == "emoji" && value.optString("char").isNotBlank() -> Icon.Emoji(value.getString("char"))
        else -> Icon.Letter
    }

    /** Space icons and colours by space id: the am.* keys, else (before the pack's migration ran) the old ones. */
    data class Looks(val icons: Map<String, Icon> = emptyMap(), val colors: Map<String, String> = emptyMap())
    fun looks(shared: JSONObject): Looks {
        fun table(new: String, old: String) = (shared.optJSONObject(new) ?: shared.optJSONObject(old))
        val icons = table(ICONS, ICONS_OLD)?.let { o -> o.keys().asSequence().associateWith { icon(o.opt(it)) } }.orEmpty()
        val colors = table(COLORS, COLORS_OLD)?.let { o -> o.keys().asSequence().associateWith { o.optString(it) }.filterValues { it.isNotBlank() } }.orEmpty()
        return Looks(icons, colors)
    }

    /** An image icon's file is only ever read inside Herdr's space-icons folder. */
    fun safeIconFile(file: String) = file.startsWith("space-icons/") && ".." !in file && file.count { it == '/' } == 1 &&
        Regex("""\.(png|svg)$""", RegexOption.IGNORE_CASE).containsMatchIn(file)

    /**
     * The tile colour (RGB): one of Herdr's tile colours as the drawer draws them ([Sidebar.MARK], ansi6 when none is
     * set), a hex of the person's own, or null for "transparent" (no tile). Another theme token comes from [SpaceColors].
     */
    fun colorRgb(color: String?, dark: Boolean): Int? = when {
        color == null -> (Sidebar.MARK.getValue("ansi6") and 0xffffff).toInt()
        color == "transparent" || color == "none" -> null
        Regex("^#[0-9a-fA-F]{6}$").matches(color) -> color.substring(1).toInt(16)
        Regex("^#[0-9a-fA-F]{3}$").matches(color) -> color.substring(1).map { "$it$it" }.joinToString("").toInt(16)
        else -> Sidebar.MARK[color]?.let { (it and 0xffffff).toInt() } ?: SpaceColors.rgb(color, dark)
    }

    // ---- The bot registry. One interface: moving to the shared registry (RFC 0014) swaps the reader, nothing else.
    /**
     * A bot as the registry defines it. [pet] is its pet id (`<character>-<colour>`), null for none. [category], [lead],
     * [rank] and [planned] place it in the desktop's tree (am-sidebar rows.js buildTree), which Code's drawer draws.
     */
    data class Member(val id: String, val name: String, val main: Boolean, val pet: String?, val category: String? = null,
                      val lead: String? = null, val rank: String? = null, val planned: Boolean = false)

    interface BotRegistry {
        /** The registry file of the project at [projectKey], on that project's machine. */
        fun path(projectKey: String): String
        /** Its bots, in file order; a file that is missing or doesn't parse has none. */
        fun parse(text: String?): List<Member>
    }

    /** Today's registry: the project's `.herdr/bots.json` (version 1). */
    object HerdrBotsJson : BotRegistry {
        override fun path(projectKey: String) = "${projectKey.trimEnd('/')}/.herdr/bots.json"
        override fun parse(text: String?): List<Member> = runCatching {
            val bots = JSONObject(text ?: return emptyList()).optJSONArray("bots") ?: return emptyList()
            bots.objects().mapNotNull { b ->
                val id = b.clean("id").trim().ifBlank { return@mapNotNull null }
                val look = b.optJSONObject("look")
                val pet = look?.let { "${it.clean("character")}-${it.clean("colour")}" }?.takeIf { petId(it) != null }
                Member(id, b.clean("name").trim().ifBlank { id }, b.clean("kind") == "main", pet,
                    b.clean("category").trim().ifBlank { null }, b.clean("lead").trim().ifBlank { null },
                    b.clean("rank").trim().ifBlank { null }, b.optJSONObject("planned") != null)
            }.distinctBy { it.id }
        }.getOrDefault(emptyList())
    }
    val registry: BotRegistry = HerdrBotsJson

    /** A pet id as one path segment (apps/bots-dsh pets.js cleanPetId), or null. */
    fun petId(id: String?) = id?.takeIf { Regex("^[a-z0-9][a-z0-9._-]{0,63}$", RegexOption.IGNORE_CASE).matches(it) && ".." !in it }
    /** Genie, the canonical pet: bundled in the APK, and what every bot wears until its own pet is on the phone. */
    const val GENIE = "genie-clay"

    // ---- The model the screen draws.
    data class Bot(val id: String, val name: String, val main: Boolean, val pet: String?, val pose: String,
                   val message: String, val statusMs: Long, val ref: TerminalRef?, val kind: String) {
        val needsYou get() = pose == NEEDS_YOU
    }

    /**
     * One project: [id] is "hostId|machine|key". [key] is the Space Row key (the main checkout's path), or "space:<id>" for
     * a space that is no repository. [merged] and [agentMin] are the feed's figures (null: "–").
     */
    data class Team(val id: String, val hostId: String, val machine: String, val key: String, val name: String,
                    val icon: Icon, val color: String?, val bots: List<Bot>, val merged: Double? = null, val agentMin: Double? = null,
                    /** From the cache, while its machine is not connected. */
                    val stale: Boolean = false) {
        val needsYou get() = bots.count { it.needsYou }
        val working get() = bots.count { it.pose == WORKING }
        val letter get() = Sidebar.letter(name)
    }

    /**
     * Every connected machine's projects. A space is one project; when two spaces map to one key (a worktree opened as a
     * space of its own), the first in Herdr's order names it and gives it its icon. A bot's pane is the live terminal
     * labelled with its id, the most urgent one if there are several; a labelled pane whose bot the registry doesn't list
     * still shows, named by its id.
     */
    fun build(machines: Map<String, MachineState>, now: Long): List<Team> =
        machines.flatMap { (hostId, m) -> build(hostId, m, now) }

    /** Where a space's project key stands: known ([key]), not known yet, or on a machine that isn't up (left out). */
    private sealed interface SpaceKey { data class Known(val key: String) : SpaceKey; data object Pending : SpaceKey; data object Away : SpaceKey }
    private fun spaceKey(m: MachineState, s: PocketSpace, byAddress: Map<String, CoreTerminal>): SpaceKey {
        if (s.machine.isNotBlank() && m.linked.find { it.name == s.machine }?.connected != true) return SpaceKey.Away
        val place = Sidebar.place(s, byAddress)
        val gitKey = Sidebar.gitKey(s.machine, place)
        return when {
            gitKey in m.git -> SpaceKey.Known(SpaceFeed.projectKey(m.git[gitKey]) ?: "space:${s.id}")
            // git never runs on a folder the core didn't report as a path: the space is a project of its own.
            !place.startsWith("/") -> SpaceKey.Known("space:${s.id}")
            else -> SpaceKey.Pending
        }
    }

    /** Waiting this long after the first reading, a space whose git never answers no longer holds its machine back. */
    const val READ_GRACE_MS = 30_000L
    /**
     * What Teams reads, shows and caches as one: a saved machine's own core ([machine] "") or one machine it links to.
     * Each goes live on its own, so a slow or unreachable linked machine never holds the others back.
     */
    fun scope(hostId: String, machine: String) = "$hostId|$machine"
    val Team.scope get() = scope(hostId, machine)
    /**
     * [machine] of [m] read far enough to replace its cached projects: connected, its terminals read this session, its
     * spaces read this session ([MachineState.layouts]), up, and git answered for each of its spaces (or [READ_GRACE_MS]
     * passed since its spaces were first read).
     */
    fun ready(m: MachineState, machine: String, now: Long): Boolean {
        if (!m.connected || m.readSession != m.session) return false
        val since = m.layouts[machine] ?: return false
        if (machine.isNotBlank() && m.linked.find { it.name == machine }?.connected != true) return false
        val byAddress = m.terminals.associateBy { it.address }
        return now - since >= READ_GRACE_MS || m.spaces.none { it.machine == machine && spaceKey(m, it, byAddress) == SpaceKey.Pending }
    }
    /** Every [scope] read far enough ([ready]): the only ones whose projects are live, cached and answered from. */
    fun read(machines: Map<String, MachineState>, now: Long): Set<String> = machines.flatMap { (hostId, m) ->
        m.layouts.keys.filter { ready(m, it, now) }.map { scope(hostId, it) }
    }.toSet()
    /** The projects of the [read] scopes only ([build] of the rest would show a machine still being read). */
    fun live(machines: Map<String, MachineState>, read: Set<String>, now: Long): List<Team> =
        build(machines.filterKeys { h -> read.any { it.startsWith("$h|") } }, now).filter { it.scope in read }

    fun build(hostId: String, m: MachineState, now: Long): List<Team> {
        val byAddress = m.terminals.associateBy { it.address }
        data class Draft(val machine: String, val key: String, val space: PocketSpace, val addresses: MutableSet<String>)
        val drafts = LinkedHashMap<String, Draft>()
        for (s in m.spaces) {
            // Not known yet (git hasn't answered): left out until it has, so a project never shows under a passing key.
            val key = (spaceKey(m, s, byAddress) as? SpaceKey.Known)?.key ?: continue
            drafts.getOrPut("${s.machine}|$key") { Draft(s.machine, key, s, HashSet()) }.addresses += s.addresses
        }
        val labelled = m.terminals.filter { it.live && !it.labels["bot"].isNullOrBlank() }
        fun machineOf(address: String) = address.substringBefore('/', "")
        // A pane outside the project's spaces is its bot's only when its own folder is in the project's repository.
        fun inProject(t: CoreTerminal, d: Draft) = t.address in d.addresses ||
            (t.cwd.startsWith("/") && SpaceFeed.projectKey(m.git[Sidebar.gitKey(d.machine, t.cwd)]) == d.key)
        return drafts.map { (where, d) ->
            val members = m.members[where].orEmpty()
            val own = labelled.filter { it.address in d.addresses }
            val ids = members.map { it.id } + own.mapNotNull { it.labels["bot"]?.trim() }.filter { id -> members.none { it.id == id } }.distinct()
            val bots = ids.map { id ->
                val member = members.find { it.id == id }
                val panes = labelled.filter { it.labels["bot"]?.trim() == id && machineOf(it.address) == d.machine && inProject(it, d) }
                val pane = panes.minByOrNull { urgency(poseOf(it, now)) }
                Bot(id, member?.name ?: id, member?.main == true, member?.pet, poseOf(pane, now), pane?.message.orEmpty(),
                    pane?.statusMs ?: 0L, pane?.let { TerminalRef(hostId, it.address) }, pane?.kind.orEmpty())
            }
            val feed = m.space[d.machine]?.project(d.key.takeIf { it.startsWith("/") || it.startsWith("~") })
            Team("$hostId|$where", hostId, d.machine, d.key, d.space.name, m.icons[d.space.id] ?: Icon.Letter,
                m.colors[d.space.id], sortBots(bots), feed?.merges?.n, agentMinutes(feed))
        }
    }

    /** Minutes the feed's merged tasks took their bots, summed; null when the feed lists no tasks at all. */
    fun agentMinutes(p: SpaceFeed.Project?): Double? = p?.tasks?.sumOf { t -> t.bots.sumOf { it.workMin ?: 0.0 } }

    /** One project's bots: most needing the person first, its main bot ahead within a state, then the latest. */
    fun sortBots(bots: List<Bot>) = bots.sortedWith(compareBy<Bot> { urgency(it.pose) }.thenByDescending { it.main }
        .thenByDescending { it.statusMs }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }.thenBy { it.id })

    /**
     * The project circles in All: those that need the person jump ahead, most requests first; the others keep Herdr's
     * order, so only a request moves anything.
     */
    fun order(teams: List<Team>): List<Team> = teams.withIndex()
        .sortedWith(compareByDescending<IndexedValue<Team>> { it.value.needsYou > 0 }.thenByDescending { it.value.needsYou }.thenBy { it.index })
        .map { it.value }

    /** The projects that moved ahead between two orders because they need the person: a haptic tick for each jump. */
    fun jumped(before: List<String>, after: List<Team>): List<String> = after.withIndex().filter { (i, t) ->
        val was = before.indexOf(t.id)
        t.needsYou > 0 && was >= 0 && i < was
    }.map { it.value.id }

    // ---- Team: one bubble per project, the project's main bot (RFC 0014 `:145`, Herdr's `kind: "main"`).
    /** The desktop's words for a project with no main bot (herdr/mods/am-sidebar/create.js:991). */
    const val NO_MAIN = "No main bot in this project"
    /** A DSH chat whose project has no yes in the home file's `shown[]` (RFC 0015 `:751-755`): no chat opens. */
    const val NOT_SHOWN = "Show in Automagik first"

    /** What tapping a bubble opens. */
    sealed interface Opens {
        /** The bot's `dsh:` chat (a universal or DSH bot); it takes writes when the bridge says `dshWrite`. */
        data class DshChat(val ref: TerminalRef) : Opens
        /** A Herdr-only main bot: its terminal's projected chat. */
        data class TerminalChat(val ref: TerminalRef) : Opens
        /** A DSH chat listed `shown: false`: the bubble says [NOT_SHOWN] and opens nothing. */
        data object NotShown : Opens
    }

    /** One project's bubble: its main bot (null: [NO_MAIN]) and what a tap opens (null: nothing, as for an asleep bot). */
    data class Bubble(val team: Team, val main: Bot?, val opens: Opens?) {
        val id get() = team.id
        val needsYou get() = main?.needsYou == true
    }

    /** A `dsh:` chat's status (bots-dsh pocket-chat.js statusOf) as a pose. */
    fun poseOfChat(state: String): String = when (state) {
        "blocked" -> NEEDS_YOU; "working" -> WORKING; "idle" -> IDLE; else -> ASLEEP
    }

    /**
     * One bubble per project, in [teams]' order. Bots are one by registry id: the main bot's `dsh:`
     * chat on its machine ([dsh], by host id, as chat.list gave it) and its labelled pane are the
     * same bot, so they make one bubble. A chat is the main bot's by the
     * [Chat.Terminal.registryId] bots-dsh serves (#672); a row that serves none (an older bots-dsh)
     * only when it is `dsh:<id>` itself. The chat wins the tap (a universal or DSH bot), under its
     * own `dsh:<sessionId>`; with none, the pane's projected chat. A stale project (its machine not
     * connected) opens nothing. A `dsh:` chat no registry lists as a main bot is not a bubble.
     */
    fun bubbles(teams: List<Team>, dsh: Map<String, List<Chat.Terminal>>): List<Bubble> = teams.map { t ->
        val main = t.bots.firstOrNull { it.main } ?: return@map Bubble(t, null, null)
        val chats = dsh[t.hostId].orEmpty().filter { it.dsh }
        val chat = if (t.stale) null else mainChat(main.id, chats)
        val bot = if (chat != null && main.ref == null) main.copy(pose = poseOfChat(chat.status)) else main
        val opens = when {
            chat != null && !chat.shown -> Opens.NotShown
            chat != null -> Opens.DshChat(TerminalRef(t.hostId, chat.terminal))
            main.ref != null -> Opens.TerminalChat(main.ref)
            else -> null
        }
        Bubble(t, bot, opens)
    }

    /**
     * Home's rows (RFC 0015 D29: one live agent, every window): each main bot's pane whose bubble opens the bot's
     * `dsh:` chat maps to that chat, so a Home row of the pane opens the same chat its Team bubble does. A pane whose
     * chat is listed `shown: false`, or that has no chat, is not in the map and opens its terminal as before.
     */
    fun paneChats(bubbles: List<Bubble>): Map<TerminalRef, TerminalRef> = bubbles.mapNotNull { b ->
        val pane = b.main?.ref ?: return@mapNotNull null
        (b.opens as? Opens.DshChat)?.let { pane to it.ref }
    }.toMap()

    /** The `dsh:` chat of registry bot [id]: by its served registry id, else (none) `dsh:<id>`. */
    private fun mainChat(id: String, chats: List<Chat.Terminal>) =
        chats.find { it.registryId == id }
        ?: chats.find { it.registryId == null && it.terminal == Chat.DSH_PREFIX + id }

    /** A bubble's second line: [NO_MAIN], [NOT_SHOWN], else its bot's ([line]). */
    fun lineOf(b: Bubble): String = when {
        b.main == null -> NO_MAIN
        b.opens == Opens.NotShown -> NOT_SHOWN
        else -> line(b.main)
    }

    // ---- Home's needs-you deck. It reads Home's own Needs you list, not the Team bubbles: the list its count
    // tiles and badge use, so the deck never shows fewer cards than the count (RFC 0015 D29, #732).
    /**
     * The old Teams-bot source of the deck: every bot waiting on the person that a live pane can answer, oldest
     * first. No screen reads it any more ([deckCards] is Home's deck); the reads tests keep it as the rule for which
     * panes are answerable.
     */
    fun deck(teams: List<Team>): List<Pair<Team, Bot>> = teams.filter { !it.stale }
        .flatMap { t -> t.bots.filter { it.needsYou && it.ref != null }.map { t to it } }.sortedBy { it.second.statusMs }
    /**
     * One card from Home's Needs you list: who asks, where, and what. A card with a [chat] has no terminal menu to
     * answer, so it opens that chat instead of sending keys.
     */
    data class DeckCard(val ref: TerminalRef, val title: String, val where: String, val agent: String, val message: String,
                        val kind: String, val statusMs: Long, val turn: Long, val chat: TerminalRef?) {
        val opensChat get() = chat != null
    }

    /** One request: a new request from the same agent (a later turn or status) is another card. */
    fun deckKey(c: DeckCard) = "${c.ref.hostId}|${c.ref.address}|${c.turn}:${c.statusMs}"

    /**
     * Home's Needs you entries as deck cards, in Home's order. [fromChat] maps a pane row raised to its Bot chat
     * ([Cockpit.Raised.fromChat]); a `dsh:` row is a chat on its own. [location] names the project or machine.
     */
    fun deckCards(entries: List<Cockpit.Entry>, fromChat: Map<TerminalRef, TerminalRef> = emptyMap(),
                  location: (TerminalRef) -> String = { "" }): List<DeckCard> = entries.map { e ->
        val t = e.terminal
        val chat = if (Chat.isDsh(e.ref.address)) e.ref else fromChat[e.ref]
        DeckCard(e.ref, t.title.ifBlank { t.agent.ifBlank { "Agent" } }, location(e.ref), t.agent, t.message, t.kind,
            t.statusMs, t.turn, chat)
    }

    /** What the deck shows: the cards left, "all clear", or offline (requests it can't reach now). */
    sealed interface DeckView {
        data class Cards(val cards: List<DeckCard>) : DeckView
        /** No terminal cards are left, but these Bot-chat requests still wait. */
        data class Chats(val cards: List<DeckCard>) : DeckView
        data object Clear : DeckView
        /** [waiting]: the requests last seen on machines the phone can't reach now. */
        data class Offline(val waiting: Int) : DeckView
    }

    /**
     * [cards] without the ones [answered], or the end. Offline when nothing is left but [offline] requests are on
     * machines the phone can't reach, or (with no connected machine) [waiting] were seen before the link dropped;
     * all clear once they were answered (or there were none).
     */
    fun deckView(cards: List<DeckCard>, answered: Set<String>, anyConnected: Boolean, waiting: Int, offline: Int = 0,
                 chats: List<DeckCard> = emptyList()): DeckView {
        val left = cards.filter { deckKey(it) !in answered }
        if (left.isNotEmpty()) return DeckView.Cards(left)
        // All clear only when every counted request is gone; Bot-chat requests live here until answered.
        if (chats.isNotEmpty()) return DeckView.Chats(chats)
        val lost = maxOf(offline, if (!anyConnected) waiting else 0)
        return if (lost > 0) DeckView.Offline(lost) else DeckView.Clear
    }

    /** The deck's exit window: after this the deck advances even if the exit animation never reported back. */
    const val DECK_EXIT_MS = 700L

    /** The next card and how many sit behind the top card. */
    data class Under(val next: DeckCard?, val behind: Int)

    /**
     * [Under] for the card being answered: [leaving] is dropped from [cards] before choosing the next one, so the
     * card behind is never the answered card itself while Home still lists it.
     */
    fun deckUnder(cards: List<DeckCard>, leaving: String?): Under {
        if (leaving == null) return Under(cards.getOrNull(1), (cards.size - 1).coerceAtLeast(0))
        val rest = cards.filter { deckKey(it) != leaving }
        return Under(rest.firstOrNull(), rest.size)
    }

    /** A leaving card keeps its last menu; a new read lands only while the card is not leaving. */
    fun deckMenu(current: Prompt.Menu?, incoming: Prompt.Menu?, sending: Boolean): Prompt.Menu? =
        if (sending) current else incoming

    /**
     * Whether the phone can answer this card: a terminal can always be opened; a Bot chat only when its bridge
     * takes phone writes and the chat does not say to answer on the computer.
     */
    fun deckAnswerable(c: DeckCard): Boolean = c.chat == null

    /** The connected Bot-chat requests that keep the deck from All clear until they are answered. */
    fun deckChats(cards: List<DeckCard>): List<DeckCard> = cards.filter { it.chat != null }

    /** The word a Home row shows for a request the deck cannot answer in place. */
    fun chatWaitLabel(t: CoreTerminal): String =
        if (t.message == Chat.ANSWER_ON_COMPUTER || t.message == Cockpit.READ_ONLY) "On computer" else "In chat"

    /**
     * The deck's open state and "opened from the deck" flag after a selection: Back from a card opened from the deck
     * keeps the deck and clears the flag; a selection from anywhere else closes it.
     */
    fun deckAfterSelection(open: Boolean, fromDeck: Boolean, selected: TerminalRef?): Pair<Boolean, Boolean> = when {
        selected == null -> open to false
        fromDeck -> open to true
        else -> false to false
    }

    /** A swipe's answer, by the axis it moved most along: up opens, right is Yes, left is No; short of [threshold], none. */
    enum class Swipe { YES, NO, OPEN, NONE }
    fun swipe(dx: Float, dy: Float, threshold: Float, canYes: Boolean, canNo: Boolean): Swipe = when {
        -dy > kotlin.math.abs(dx) -> if (-dy > threshold) Swipe.OPEN else Swipe.NONE
        dx > threshold && canYes -> Swipe.YES
        dx < -threshold && canNo -> Swipe.NO
        else -> Swipe.NONE
    }
    /** Whether an answer reached the agent ([PocketViewModel.choose]'s outcome): only then does its card leave the deck. */
    fun sent(outcome: String) = outcome.startsWith("You chose")

    /**
     * Live projects of the scopes read this session ([read], [scope]s), plus the cached ones of every other scope of a
     * saved machine ([known], host ids): marked stale, with no terminal to open, until their machine is read again.
     * Machines no longer saved show nothing.
     */
    fun merge(live: List<Team>, cached: List<Team>, read: Set<String>, known: Set<String>): List<Team> =
        live + cached.filter { it.scope !in read && it.hostId in known }.map { c ->
            c.copy(stale = true, bots = sortBots(c.bots.map { it.copy(ref = null) }))
        }

    // ---- Today's peak of simultaneous agents (TeamsDb).
    /** Working bots now, for today's peak: All ("") and each project. */
    fun working(teams: List<Team>): Map<String, Int> =
        teams.associate { it.id to it.working } + ("" to teams.sumOf { it.working })
    fun day(now: Long, zone: ZoneId = ZoneId.systemDefault()): String = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().toString()

    /**
     * Merges seen in the feeds, as "project id|task|bot", by feed ("hostId|machine"): a bot whose pair is new since its
     * feed's last reading jumps once. Each feed's first reading sets its own baseline, so nothing jumps on launch or when
     * another machine's feed first arrives.
     */
    fun merges(machines: Map<String, MachineState>): Map<String, Set<String>> = machines.flatMap { (hostId, m) ->
        m.space.map { (machine, feed) ->
            "$hostId|$machine" to feed.projects.flatMap { (key, p) -> p.tasks.orEmpty().flatMap { t -> t.bots.map { "$hostId|$machine|$key|${t.task}|${it.bot}" } } }.toSet()
        }
    }.toMap()
    /** The bots ("hostId|machine|key|botId") to celebrate: merges in [now] that weren't in [before]. */
    fun celebrations(before: Set<String>?, now: Set<String>): Set<String> = if (before == null) emptySet()
        else (now - before).map { val parts = it.split('|'); "${parts[0]}|${parts[1]}|${parts[2]}|${parts.last()}" }.toSet()

    /** A row's time: HH:MM today, else "Yesterday", the weekday within a week, else the date. Nothing for no time. */
    fun time(ms: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        if (ms <= 0) return ""
        val at = Instant.ofEpochMilli(ms).atZone(zone)
        val days = ChronoUnit.DAYS.between(at.toLocalDate(), Instant.ofEpochMilli(now).atZone(zone).toLocalDate())
        return when {
            days <= 0L -> DateTimeFormatter.ofPattern("HH:mm").format(at)
            days == 1L -> "Yesterday"
            days < 7L -> DateTimeFormatter.ofPattern("EEE", Locale.getDefault()).format(at)
            else -> DateTimeFormatter.ofPattern("d MMM", Locale.getDefault()).format(at)
        }
    }

    /** A row's second line: what the agent says, else its state in words. */
    fun line(b: Bot): String = b.message.ifBlank {
        when (b.pose) {
            NEEDS_YOU -> "Needs you"; WORKING -> "Working"; DONE -> "Done"; FAILED -> "Failed"; IDLE -> "Idle"; else -> "Asleep"
        }
    }
}
