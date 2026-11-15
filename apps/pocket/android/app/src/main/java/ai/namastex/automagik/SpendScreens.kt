package ai.namastex.automagik

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Every machine's meter doc from [state], merged; the machines connected now are the ones expected to report. */
fun spendView(state: PocketState, now: Long = System.currentTimeMillis()): Spend.View {
    fun own(id: String) = state.hosts.find { it.id == id }?.name ?: if (state.demo) PREVIEW_MACHINE else "Machine"
    val expected = state.machines.filterValues { it.connected }.flatMap { (id, m) -> listOf(own(id)) + m.linked.filter { it.connected }.map { it.name } }
    return Spend.View(state.machines.values.flatMap { it.meter.values }, expected.distinct(), now)
}

@Composable fun rememberSpend(state: PocketState): Spend.View = remember(state.machines, state.hosts, state.demo) { spendView(state) }

/**
 * Today's row of four count tiles: the screen gutter, the gaps and the tile padding, so the $ tile's text width can be
 * worked out per screen width ([textWidthDp]). At 360 dp a tile has 54 dp for text, which "≥$7.80" overflows at
 * [MAX_SP]; the amount shrinks down to [MIN_SP] rather than clip.
 */
object TodayTiles {
    const val GUTTER_DP = 20
    const val GAP_DP = 8
    const val COUNT = 4
    const val PAD_DP = 10
    /** Two 24sp body lines, the 10dp top/bottom padding and 4dp of slack; grows with the font setting. */
    fun heightDp(fontScale: Float) = (48f * fontScale + 24f).dp
    const val MAX_SP = 22
    const val MIN_SP = 12
    fun textWidthDp(screenDp: Int): Double = (screenDp - 2.0 * GUTTER_DP - (COUNT - 1) * GAP_DP) / COUNT - 2 * PAD_DP
}

/** A tile's second line: one line that shrinks rather than ellipsize at a large font setting. */
@Composable fun TileLabel(text: String, modifier: Modifier = Modifier) {
    BasicText(text, modifier = modifier, style = LocalTextStyle.current.copy(color = Muted, fontSize = 12.sp),
        maxLines = 1, softWrap = false, autoSize = TextAutoSize.StepBased(7.sp, 12.sp, 1.sp))
}

/** Today's "spent today" count, beside needs you / working / connected; the caller shows it only when a meter reports. */
@Composable fun SpendCount(view: Spend.View, modifier: Modifier = Modifier) {
    val numberBox = with(LocalDensity.current) { 24.sp.toDp() }
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(Surface).border(1.dp, Border, RoundedCornerShape(12.dp)).padding(TodayTiles.PAD_DP.dp, 10.dp)) {
        // The same fixed line box as CountCard, so the label below starts at the same height.
        Box(Modifier.height(numberBox), contentAlignment = Alignment.CenterStart) {
            BasicText(Spend.compact(view.today()), style = LocalTextStyle.current.copy(color = Ink, fontSize = TodayTiles.MAX_SP.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
                maxLines = 1, softWrap = false, autoSize = TextAutoSize.StepBased(TodayTiles.MIN_SP.sp, TodayTiles.MAX_SP.sp, 1.sp))
        }
        TileLabel("spent today")
    }
}

/** The one hint when no machine has a meter: no zeros anywhere. */
@Composable fun MeterHint() {
    Text("Install the Automagik meter on your machines to see spend.", color = Muted, fontSize = 12.sp)
}

/** Which machines report and what the $ are: under the spend on Projects and a project. */
@Composable fun SpendNotes(view: Spend.View) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(Spend.coverageLine(view.coverage), color = if (view.coverage.complete) Muted else Blocked, fontSize = 12.sp)
        Text(Spend.footnote(view), color = Muted, fontSize = 11.sp, lineHeight = 15.sp)
    }
}

/** Today's $ by hour, every project together (the meter's hourly series is per harness, not per project). */
@Composable fun HourChart(hours: List<Double>) {
    val peak = hours.withIndex().maxByOrNull { it.value }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Surface).border(1.dp, Border, RoundedCornerShape(14.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text("Spend by hour today", color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (peak != null && peak.value > 0) Text("peak ${"%02d".format(peak.index)}:00 · ${Spend.usd(peak.value)}", color = Muted, fontSize = 12.sp)
        }
        val top = hours.maxOrNull()?.takeIf { it > 0 } ?: 1.0
        Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.Bottom) {
            for (i in 0 until 24) {
                val v = hours.getOrNull(i)
                Box(Modifier.weight(1f).fillMaxHeight(((v ?: 0.0) / top).toFloat().coerceIn(.04f, 1f)).clip(RoundedCornerShape(2.dp))
                    .background(when { v == null -> Raised; i == peak?.index -> Accent; else -> Accent.copy(alpha = .35f) }))
            }
        }
        Row { Text("0:00", color = Muted, fontSize = 10.sp, modifier = Modifier.weight(1f)); Text("12:00", color = Muted, fontSize = 10.sp, modifier = Modifier.weight(1f)); Text("23:00", color = Muted, fontSize = 10.sp) }
    }
}

/** A labelled figure in a small card, as the project's spend cards show them. */
@Composable fun FigureCard(label: String, value: String, detail: String?, modifier: Modifier = Modifier) {
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(Surface).border(1.dp, Border, RoundedCornerShape(12.dp)).padding(12.dp, 10.dp)) {
        Text(label, color = Muted, fontSize = 12.sp, maxLines = 1)
        Text(value, color = Ink, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        if (detail != null) Text(detail, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A project's spend over [period]: tasks, cost per task, $ with tokens and cache share, time per task. */
@Composable fun ProjectSpend(view: Spend.View, key: String, period: Spend.Period, onPeriod: (Spend.Period) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Spend", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { Spend.Period.entries.forEach { p -> Pill(p.label, p == period) { onPeriod(p) } } }
        }
        val sum = view.project(key, period)
        val count = view.taskCount(key, period)
        val hours = view.hoursPerTask(key)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FigureCard("Tasks", count?.toString() ?: "—", "with usage in ${period.label}", Modifier.weight(1f))
            FigureCard("Cost per task", Spend.money(view.costPerTask(key, period)), "untasked work excluded", Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FigureCard("Spent", Spend.money(sum), sum?.let { Spend.detail(it) } ?: "no usage reported", Modifier.weight(1f))
            if (hours != null) FigureCard("Time per task", Spend.hours(hours), "active hours, 30d", Modifier.weight(1f))
            else Spacer(Modifier.weight(1f))
        }
    }
}

/** The project's tasks by spend in [period], finished ones included: $ and active hours. */
@Composable fun TaskSpendList(tasks: List<Spend.TaskView>, period: Spend.Period) {
    if (tasks.isEmpty()) return
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Surface).border(1.dp, Border, RoundedCornerShape(14.dp)).padding(14.dp, 6.dp)) {
        Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.Bottom) {
            Text("Tasks by spend", color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("${period.label} · active time", color = Muted, fontSize = 12.sp)
        }
        tasks.forEach { t ->
            Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(t.branch, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(listOf(t.agents.joinToString(", "), Spend.detail(t.sum)).filter { it.isNotBlank() }.joinToString(" · "), color = Muted, fontSize = 12.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.width(8.dp))
                TaskSpend(t)
            }
        }
    }
}

/** A task's $ over its active hours, right-aligned at the end of its row. */
@Composable fun TaskSpend(t: Spend.TaskView) {
    Column(horizontalAlignment = Alignment.End) {
        Text(Spend.money(t.sum), color = Ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        t.hours?.let { Text(Spend.hours(it.toDouble()), color = Muted, fontSize = 12.sp) }
    }
}
