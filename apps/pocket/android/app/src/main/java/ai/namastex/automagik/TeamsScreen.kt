package ai.namastex.automagik

import android.content.Context
import android.graphics.BitmapFactory
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.createBitmap
import com.caverock.androidsvg.SVG
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

/** The desktop's space images, copied to the phone once ([PocketViewModel] fetches them), drawn at tile size. */
object SpaceIcons {
    private fun file(context: Context, hostId: String, file: String): File {
        val hash = MessageDigest.getInstance("SHA-256").digest("$hostId|$file".toByteArray()).take(12).joinToString("") { "%02x".format(it) }
        return File(context.filesDir, "space-icons/$hash.${file.substringAfterLast('.').lowercase()}")
    }
    fun cached(context: Context, hostId: String, file: String) = file(context, hostId, file).isFile
    fun save(context: Context, hostId: String, file: String, bytes: ByteArray) {
        val to = file(context, hostId, file).apply { parentFile?.mkdirs() }
        File(to.path + ".tmp").apply { writeBytes(bytes); renameTo(to) }
    }
    /** The image at [px] square, or null when it isn't here or doesn't draw. Blocking. */
    fun load(context: Context, hostId: String, file: String, px: Int): ImageBitmap? = runCatching {
        val f = file(context, hostId, file).takeIf { it.isFile } ?: return null
        if (f.extension == "svg") {
            val svg = SVG.getFromString(f.readText())
            svg.documentWidth = px.toFloat(); svg.documentHeight = px.toFloat()
            createBitmap(px, px).also { svg.renderToCanvas(android.graphics.Canvas(it)) }.asImageBitmap()
        } else BitmapFactory.decodeFile(f.path)?.asImageBitmap()
    }.getOrNull()
}

/** The amber of a request for the person: Herdr's ansi3 in the theme the phone shows. */
@Composable @ReadOnlyComposable fun amber() = Color(0xff000000 or SpaceColors.rgb("ansi3", LocalPalette.current.dark).toLong())

/**
 * The Teams tab's projects: the connected machines' live reading, and the cached rows of machines that aren't
 * connected (the preview shows only its own). Recomputed every 30 s, so an idle bot falls asleep on time.
 */
@Composable fun rememberTeams(state: PocketState, vm: PocketViewModel): List<Teams.Team> {
    val cached by vm.cachedTeams.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = System.currentTimeMillis() } }
    return remember(state.machines, state.hosts, state.demo, cached, now) {
        // Live only for a machine read far enough (as the cache is written), each linked machine on its own; until then,
        // its cached projects, stale: shown at once, never answered from.
        val read = Teams.read(state.machines, now)
        val live = Teams.live(state.machines, read, now)
        if (state.demo) live else Teams.merge(live, cached, read, state.hosts.map { it.id }.toSet())
    }
}

/**
 * Team: one bubble per project, its main bot (All first in the project circles; a project that needs the person jumps
 * ahead with an amber halo and a haptic tick). A bubble opens its bot's chat: the `dsh:` chat of a universal or DSH bot,
 * else the projected chat of a Herdr-only main bot's terminal ([Teams.bubbles]).
 */
@Composable fun TeamsScreen(state: PocketState, vm: PocketViewModel, teams: List<Teams.Team>, dsh: Map<String, List<Chat.Terminal>>,
                            groupChats: List<Pair<TerminalRef, Chat.Terminal>> = emptyList(),
                            onOpenGroup: (TerminalRef) -> Unit = {}, onOpen: (Teams.Opens) -> Unit) {
    val celebrations by vm.celebrations.collectAsState()
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    val ordered = remember(teams) { Teams.order(teams) }
    val selected = ordered.find { it.id == selectedId }
    LaunchedEffect(selected == null) { if (selected == null) selectedId = null }
    // A haptic tick when a project jumps ahead because it needs the person.
    val view = LocalView.current
    var before by remember { mutableStateOf<List<String>?>(null) }
    LaunchedEffect(ordered.map { it.id to it.needsYou }) {
        val was = before
        if (was != null && Teams.jumped(was, ordered).isNotEmpty()) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        before = ordered.map { it.id }
    }
    val shown = if (selected == null) ordered else listOf(selected)
    val bubbles = remember(shown, dsh) { Teams.bubbles(shown, dsh) }
    val offline = teams.any { it.stale }
    val connected = state.machines.values.any { it.connected }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
        item(key = "bar") {
            LazyRow(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                item(key = "all") { ProjectCircle(null, selected == null, needsYou = 0, onClick = { selectedId = null }) }
                items(ordered, key = { it.id }) { t ->
                    ProjectCircle(t, t.id == selectedId, t.needsYou, Modifier.animateItem(), onClick = { selectedId = t.id })
                }
            }
        }
        if (!connected || offline) item(key = "offline") {
            Text(if (connected) "Some machines are offline · last known state" else "Offline · last known state",
                color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp))
        }
        if (bubbles.isEmpty()) item(key = "empty") {
            Text("No projects yet. A project shows here once Herdr opens its space.", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(24.dp))
        }
        items(bubbles, key = { it.id }) { b ->
            // A merge celebrates for two minutes after it is seen: a row scrolled back later doesn't jump again.
            val celebrate = b.main?.let { celebrations["${b.team.id}|${it.id}"] }?.takeIf { System.currentTimeMillis() - it < 120_000 }
            BubbleRow(state, vm, b, celebrate = celebrate, modifier = Modifier.animateItem(), onOpen = onOpen)
        }
        if (selected == null && groupChats.isNotEmpty()) {
            item(key = "groups") {
                Box(Modifier.padding(horizontal = 14.dp)) { SectionHeader(ChatGroups.HEADING, groupChats.size) }
            }
            items(groupChats, key = { "g:${it.first.hostId}:${it.first.address}" }) { (ref, g) ->
                Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
                    GroupCard(g, vm.hostName(ref.hostId)) { onOpenGroup(ref) }
                }
            }
        }
    }
}

/**
 * The `dsh:` chats Team and Home read: the preview's one sample chat while the demo runs ([ChatDemo.chats]), else the
 * last good listing of the saved [hosts].
 */
internal fun dshChats(demo: Boolean, last: Map<String, List<Chat.Terminal>>, hosts: List<String>) =
    if (demo) ChatDemo.chats() else last.filterKeys { it in hosts }

/**
 * Each connected, paired machine's `dsh:` chats, read again every 30 s while [reading] (Home or Team shows). A reading
 * in flight or failed keeps the last good one, so a bubble or a Home row does not flip between its chat and its
 * terminal.
 */
@Composable fun rememberDshChats(state: PocketState, vm: PocketViewModel, reading: Boolean): Map<String, List<Chat.Terminal>> {
    val hosts = state.hosts.filter { it.paired && state.machines[it.id]?.connected == true }.map { it.id }
    LaunchedEffect(hosts, state.demo, reading) {
        if (state.demo || !reading) return@LaunchedEffect
        while (true) { hosts.forEach(vm::loadBotChats); delay(30_000) }
    }
    val read by vm.botChats.collectAsState()
    var last by remember { mutableStateOf(emptyMap<String, List<Chat.Terminal>>()) }
    LaunchedEffect(read) { read.forEach { (h, r) -> r?.getOrNull()?.let { last = last + (h to it) } } }
    return dshChats(state.demo, last, hosts)
}

/** A project's circle: its Herdr icon (emoji or image) on its tile colour, else its letter; All is a grid. */
@Composable fun ProjectCircle(team: Teams.Team?, selected: Boolean, needsYou: Int, modifier: Modifier = Modifier, size: Dp = 52.dp,
                              onClick: (() -> Unit)? = null) {
    val amber = amber()
    val halo = if (needsYou > 0) rememberInfiniteTransition(label = "halo").animateFloat(.35f, 1f,
        infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "halo").value else 0f
    val label = team?.let { if (needsYou > 0) "${it.name}, $needsYou need you" else it.name } ?: "All projects"
    Column(modifier.semantics { contentDescription = label }, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(size + 8.dp), contentAlignment = Alignment.Center) {
            if (needsYou > 0) Box(Modifier.size(size + 8.dp).border(3.dp, amber.copy(alpha = halo), CircleShape))
            ProjectIcon(team, size, Modifier.then(if (onClick != null) Modifier.clip(CircleShape).clickable(onClick = onClick) else Modifier))
            if (needsYou > 0) Box(Modifier.align(Alignment.TopEnd).defaultMinSize(20.dp, 20.dp).background(amber, CircleShape).padding(horizontal = 5.dp),
                contentAlignment = Alignment.Center) {
                Text("$needsYou", color = Color(0xff1b1b1e), fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
        if (onClick != null) Box(Modifier.padding(top = 2.dp).size(5.dp).background(if (selected) Accent else Color.Transparent, CircleShape))
    }
}

/** A project's face at [size]: what Herdr draws for its space. */
@Composable fun ProjectIcon(team: Teams.Team?, size: Dp, modifier: Modifier = Modifier) {
    val dark = LocalPalette.current.dark
    val tile = team?.let { Teams.colorRgb(it.color, dark) }?.let { Color(0xff000000 or it.toLong()) }
    Box(modifier.size(size).clip(CircleShape).background(tile ?: Raised), contentAlignment = Alignment.Center) {
        when (val icon = team?.icon) {
            null -> Icon(Icons.Outlined.GridView, null, tint = Ink, modifier = Modifier.size(size * .46f))
            is Teams.Icon.Emoji -> Text(icon.char, fontSize = (size.value * .5f).sp)
            is Teams.Icon.Image -> {
                val context = LocalContext.current
                val px = with(LocalDensity.current) { size.roundToPx() }
                val version = LocalIconsVersion.current
                val image by produceState<ImageBitmap?>(null, icon.file, team.hostId, px, version) {
                    value = withContext(Dispatchers.IO) { SpaceIcons.load(context, team.hostId, icon.file, px) }
                }
                image?.let { Image(it, null, Modifier.fillMaxSize()) } ?: Letter(team, size, tile)
            }
            Teams.Icon.Letter -> Letter(team, size, tile)
        }
    }
}

/** Raised when a space image or a pet arrives, so icons already on screen read their file again. */
val LocalIconsVersion = compositionLocalOf { 0 }

@Composable private fun Letter(team: Teams.Team, size: Dp, tile: Color?) =
    Text(team.letter, color = if (tile != null) Color.White else Ink, fontSize = (size.value * .42f).sp, fontWeight = FontWeight.Bold)

/**
 * A project's bubble, IM-like: its main bot's pet in the pose for its state, its name, what it says and when, and the
 * bot card button; a project with no main bot says so ([Teams.NO_MAIN]) and opens nothing.
 */
@Composable fun BubbleRow(state: PocketState, vm: PocketViewModel, bubble: Teams.Bubble, celebrate: Long?,
                          modifier: Modifier = Modifier, onOpen: (Teams.Opens) -> Unit) {
    val team = bubble.team
    val bot = bubble.main
    val opens = bubble.opens
    val feed = state.machines[team.hostId]?.space?.get(team.machine)
    val names = state.machines[team.hostId]?.bots?.get("${team.machine}|${team.key}")
    val now = System.currentTimeMillis()
    val color = when (bot?.pose) { Teams.NEEDS_YOU -> amber(); Teams.FAILED -> Blocked; Teams.WORKING -> Working; Teams.DONE -> Done; else -> Muted }
    Row(modifier.fillMaxWidth().clickable(enabled = opens != null && opens != Teams.Opens.NotShown) { opens?.let(onOpen) }
        .background(if (bubble.needsYou) amber().copy(alpha = .07f) else Color.Transparent)
        .padding(start = 14.dp, end = 6.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(52.dp)) {
            if (bot == null) ProjectIcon(team, 52.dp)
            else {
                Box(Modifier.size(52.dp).clip(CircleShape).background(Surface), contentAlignment = Alignment.BottomCenter) {
                    PetView(bot.pet, bot.pose, 50.dp, celebrate = celebrate)
                }
                ProjectIcon(team, 18.dp, Modifier.align(Alignment.BottomEnd).border(1.5.dp, Canvas, CircleShape))
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(bot?.name ?: team.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false), color = if (bot == null || bot.pose == Teams.ASLEEP) Muted else Ink)
                if (bot != null) {
                    Spacer(Modifier.width(6.dp))
                    Text("MAIN", fontSize = 9.5.sp, fontWeight = FontWeight.Bold, color = Accent,
                        modifier = Modifier.border(1.dp, Accent.copy(alpha = .5f), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp, vertical = 1.dp))
                }
                Spacer(Modifier.weight(1f))
                if (bot != null) Text(Teams.time(bot.statusMs, now), fontSize = 11.5.sp, color = Muted, maxLines = 1)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (bot != null) { Dot(color, 7); Spacer(Modifier.width(6.dp)) }
                Text(Teams.lineOf(bubble), fontSize = 13.sp, color = if (bubble.needsYou) Ink else Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (feed != null && bot != null) StatsButton { vm.openStats(BotSheet(BotStats(bot.id, bot.name, feed, feed.project(team.key)?.bots?.get(bot.id), names))) }
        else Spacer(Modifier.width(8.dp))
    }
}
