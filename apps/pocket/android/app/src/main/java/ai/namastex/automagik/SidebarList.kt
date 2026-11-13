package ai.namastex.automagik

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp


/** The drawer's machine/space/agent tree, row for row as Herdr desktop's sidebar draws it. */
fun LazyListScope.sidebarRows(rows: List<SidebarRow>, activeSpace: Pair<String, String>?, focused: TerminalRef?,
                              onToggle: (MachineHeaderRow) -> Unit, onSpace: (SpaceRow) -> Unit, onTerminal: (TerminalRef) -> Unit,
                              onStats: (StatsSheet) -> Unit = {}) {
    items(rows, key = { it.key }) { row ->
        Box(Modifier.padding(horizontal = 8.dp)) {
            when (row) {
                is MachineHeaderRow -> MachineHeader(row) { onToggle(row) }
                is SpaceRow -> SpaceLine(row, activeSpace == (row.hostId to row.space.id), onStats) { onSpace(row) }
                is AgentRow -> AgentLine(row, focused == TerminalRef(row.hostId, row.terminal.address), onStats) { onTerminal(TerminalRef(row.hostId, row.terminal.address)) }
                is KidRow -> KidLine(row, focused == TerminalRef(row.hostId, row.terminal.address), onStats) { onTerminal(TerminalRef(row.hostId, row.terminal.address)) }
                is CategoryRow -> CategoryLine(row)
                is SleepingBotRow -> SleepingBotLine(row)
            }
        }
    }
}

@Composable private fun MachineHeader(row: MachineHeaderRow, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(30.dp).clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(if (row.machine.isBlank()) Icons.Outlined.Computer else Icons.Outlined.Dns, null, Modifier.size(13.dp), tint = SidebarDim)
        Spacer(Modifier.width(7.dp))
        Text(row.title, color = SidebarDim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (!row.connected && row.state.isNotBlank()) { Text(row.state, color = SidebarDim, fontSize = 11.sp); Spacer(Modifier.width(7.dp)) }
        Box(Modifier.size(6.dp).background(if (row.connected) SidebarConnected else SidebarDim, CircleShape))
        Spacer(Modifier.width(7.dp))
        Icon(if (row.folded) Icons.Outlined.ChevronRight else Icons.Outlined.ExpandMore, if (row.folded) "Expand ${row.title}" else "Collapse ${row.title}",
            Modifier.size(13.dp), tint = SidebarDim)
    }
}

@Composable private fun SpaceLine(row: SpaceRow, active: Boolean, onStats: (StatsSheet) -> Unit, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(if (active) SidebarSelected else Color.Transparent).clickable(onClick = onClick)) {
    Row(Modifier.fillMaxWidth().height(if (row.nested) 28.dp else 34.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        // A worktree nested under its main checkout: a branch glyph instead of the avatar.
        if (row.nested) { Spacer(Modifier.width(14.dp)); BranchGlyph(); Spacer(Modifier.width(8.dp)) }
        else {
            Box(Modifier.size(18.dp).background(Color(Sidebar.MARK[row.color] ?: Sidebar.MARK.getValue("ansi6")), RoundedCornerShape(5.dp)), contentAlignment = Alignment.Center) {
                Text(row.letter, color = Color.White, fontSize = 10.5.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(9.dp))
        }
        Text(row.space.name, color = Ink, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 150.dp))
        Row(Modifier.weight(1f).padding(start = 8.dp), horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
            if (row.tail.isNotEmpty()) Text(row.tail, color = SidebarDim, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (row.ahead > 0) Text("↑${row.ahead}", color = Color(Sidebar.MARK.getValue("ansi2")), fontSize = 11.5.sp, maxLines = 1, softWrap = false)
            if (row.behind > 0) Text("↓${row.behind}", color = Color(Sidebar.MARK.getValue("ansi1")), fontSize = 11.5.sp, maxLines = 1, softWrap = false)
        }
    }
    // Line 2 starts under the name, after the avatar (8 + 18 + 9).
    row.stats?.let { s -> SpaceLine2(s, Modifier.padding(start = 35.dp, end = 8.dp, bottom = 6.dp)) { onStats(ChipSheet(s, it)) } }
    }
}

/** Lucide's git-branch (ISC), 13 dp in dim, as the desktop draws nested worktree rows. */
@Composable private fun BranchGlyph() {
    val dim = SidebarDim
    Canvas(Modifier.size(13.dp)) {
        val u = size.width / 24f; val stroke = Stroke(2 * u, cap = StrokeCap.Round)
        drawLine(dim, Offset(6 * u, 3 * u), Offset(6 * u, 15 * u), 2 * u, StrokeCap.Round)
        drawCircle(dim, 3 * u, Offset(18 * u, 6 * u), style = stroke)
        drawCircle(dim, 3 * u, Offset(6 * u, 18 * u), style = stroke)
        drawArc(dim, 0f, 90f, false, Offset(0f, 0f), androidx.compose.ui.geometry.Size(18 * u, 18 * u), style = stroke)
    }
}

@Composable private fun AgentLine(row: AgentRow, focused: Boolean, onStats: (StatsSheet) -> Unit, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(32.dp).clip(RoundedCornerShape(8.dp)).background(if (focused) SidebarSelected else Color.Transparent)
        .clickable(onClick = onClick).padding(start = (if (row.nested) 44 else 28).dp + TREE_STEP * row.depth, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        ProgramIcon(row.program, 14)
        Spacer(Modifier.width(8.dp))
        Text(row.label, color = if (row.status == "idle" && !focused) SidebarMuted else Ink, fontSize = 12.5.sp, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        row.machineLabel?.let { Spacer(Modifier.width(6.dp)); Text(it, color = SidebarDim, fontSize = 10.sp, maxLines = 1) }
        row.bot?.let { b -> Spacer(Modifier.width(4.dp)); StatsButton { onStats(BotSheet(b)) } }
        Spacer(Modifier.width(if (row.bot != null) 4.dp else 8.dp))
        StatusMark(row.status)
    }
}

@Composable private fun KidLine(row: KidRow, focused: Boolean, onStats: (StatsSheet) -> Unit, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(30.dp).clip(RoundedCornerShape(8.dp)).background(if (focused) Raised else Color.Transparent)
        .clickable(onClick = onClick).padding(start = (if (row.nested) 50 else 34).dp + TREE_STEP * row.depth, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        row.lines.forEach { TreeLine(it) }
        ProgramIcon(row.program, 13)
        Spacer(Modifier.width(7.dp))
        Text(row.label, color = if (focused) Ink else SidebarMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        row.bot?.let { b -> Spacer(Modifier.width(4.dp)); StatsButton { onStats(BotSheet(b)) } }
        Spacer(Modifier.width(if (row.bot != null) 4.dp else 8.dp))
        StatusMark(row.status)
    }
}

/** How far each level of a project's bot tree indents. */
private val TREE_STEP = 12.dp

/** A category of the bot tree: its title, as the desktop heads a group of the main bot's reports. */
@Composable private fun CategoryLine(row: CategoryRow) {
    Row(Modifier.fillMaxWidth().height(26.dp).padding(start = (if (row.nested) 44 else 28).dp + TREE_STEP, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(row.title.ifBlank { row.id }, color = SidebarDim, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A bot with no pane: dimmed, nothing to open. */
@Composable private fun SleepingBotLine(row: SleepingBotRow) {
    Row(Modifier.fillMaxWidth().height(32.dp).padding(start = (if (row.nested) 44 else 28).dp + TREE_STEP * row.depth, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.SmartToy, null, Modifier.size(14.dp), tint = SidebarDim)
        Spacer(Modifier.width(8.dp))
        Text(row.label, color = SidebarDim, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(if (row.planned) "planned" else "asleep", color = SidebarDim, fontSize = 10.sp, maxLines = 1)
        Spacer(Modifier.width(8.dp))
    }
}

// One depth step: 9 wide plus 4 of margin. "├" and "└" draw the same L; "│" continues an ancestor; "" is blank.
@Composable private fun TreeLine(marker: String) {
    val line = SidebarInput
    Canvas(Modifier.padding(end = 4.dp).width(9.dp).fillMaxHeight()) {
        if (marker.isEmpty()) return@Canvas
        val stroke = 1.5.dp.toPx(); val x = stroke / 2; val mid = size.height / 2
        if (marker == "│") { drawLine(line, Offset(x, 0f), Offset(x, size.height), stroke); return@Canvas }
        val r = 6.dp.toPx()
        val path = Path().apply { moveTo(x, 0f); lineTo(x, mid - r); quadraticTo(x, mid, x + r, mid); lineTo(size.width, mid) }
        drawPath(path, line, style = Stroke(stroke))
        if (marker == "├") drawLine(line, Offset(x, mid), Offset(x, size.height), stroke)
    }
}

/** Desktop's status marks: spinner while working, "Needs you" when blocked, ring when idle, blue dot when done. */
@Composable fun StatusMark(status: String) {
    when (status) {
        "working" -> {
            val angle by rememberInfiniteTransition(label = "spinner").animateFloat(0f, 360f,
                infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "spinner")
            val working = Working
            Canvas(Modifier.padding(horizontal = 1.dp).size(12.dp).rotate(angle)) {
                val stroke = 3.2f / 24f * size.width
                val inset = stroke / 2
                val arcSize = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke)
                drawArc(working.copy(alpha = .24f), 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(stroke))
                drawArc(working, -90f, 90f, false, Offset(inset, inset), arcSize, style = Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
            }
        }
        "blocked" -> Box(Modifier.heightIn(min = 18.dp).background(Blocked.copy(alpha = .15f), RoundedCornerShape(5.dp)).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
            Text("Needs you", color = Ink, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
        "idle" -> Box(Modifier.padding(horizontal = 3.dp).size(7.dp).border(1.5.dp, SidebarDim, CircleShape))
        "done" -> Box(Modifier.padding(horizontal = 3.dp).size(7.dp).background(Done, CircleShape))
        "unknown" -> Box(Modifier.padding(horizontal = 3.dp).size(7.dp).background(SidebarDim, CircleShape))
        else -> Spacer(Modifier.padding(horizontal = 3.dp).size(7.dp))
    }
}

/** The desktop's own icon for the program once it's been read from the desktop; until then a stand-in.
 *  As on the desktop, a tinted icon is one colour in the text colour, an untinted one keeps its own colours. */
@Composable fun ProgramIcon(program: Program, size: Int) {
    val svgs by ProgramIcons.svgs.collectAsState()
    val px = with(LocalDensity.current) { size.dp.roundToPx() }
    val svg = svgs[program.icon]
    val bitmap = svg?.let { ProgramIcons.render(program.icon, it, px, if (program.tint) "#ffffff" else "#eeeeef") }
    if (bitmap != null) Image(bitmap, null, Modifier.size(size.dp), colorFilter = if (program.tint) ColorFilter.tint(Ink) else null)
    else { val (icon, tint) = programGlyph(program); Icon(icon, null, Modifier.size(size.dp), tint = tint) }
}

@Composable @ReadOnlyComposable private fun programGlyph(p: Program): Pair<ImageVector, Color> = when (p.key) {
    "claude" -> Icons.Outlined.SmartToy to Color(0xffd97757)
    "codex" -> Icons.Outlined.SmartToy to Ink
    "shell" -> Icons.Outlined.Terminal to Ink
    "program" -> Icons.Outlined.Code to Ink
    "agent" -> Icons.Outlined.SmartToy to Ink
    else -> (if (p.icon.contains("agent") || !p.tint) Icons.Outlined.SmartToy else Icons.Outlined.Terminal) to Ink
}

/** How far a sideways drag goes before it counts as a swipe to another agent. */
private val SWIPE = 56.dp

/** A sideways swipe: to the left is the next agent (+1), to the right the previous one (-1); taps pass through. */
suspend fun PointerInputScope.detectAgentSwipe(onSwipe: (Int) -> Unit) {
    var total = 0f
    detectHorizontalDragGestures(onDragStart = { total = 0f },
        onDragEnd = { if (kotlin.math.abs(total) > SWIPE.toPx()) onSwipe(if (total < 0) 1 else -1) }) { change, dx ->
        total += dx; change.consume()
    }
}
