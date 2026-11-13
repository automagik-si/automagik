package ai.namastex.automagik

import ai.namastex.automagik.Spend.Period.D1
import ai.namastex.automagik.Spend.Period.D30
import ai.namastex.automagik.Spend.Period.D7
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** Spend from synthetic `herdr-meter` docs: made-up numbers, example repositories. */
class SpendTest {
    private val hour = 3_600_000L
    private val now = Instant.parse("2026-01-15T12:30:00Z").toEpochMilli()
    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()
    private fun t(usd: Double? = null, input: Long = 100, cr: Long = 900, cw: Long = 0, out: Long = 50, unpriced: Long = 0, un: Long = 0) = JSONObject().apply {
        put("in", input); put("cr", cr); if (cw > 0) put("cw", cw); put("out", out)
        if (usd != null) put("usd", usd); if (unpriced > 0) put("unpriced", unpriced); if (un > 0) put("un", un)
    }
    private fun w(o: JSONObject, d1: JSONObject?, d7: JSONObject?, d30: JSONObject) = o.apply { d1?.let { put("d1", it) }; d7?.let { put("d7", it) }; put("d30", d30) }
    private fun project(repo: String?, d1: JSONObject?, d7: JSONObject?, d30: JSONObject) = w(JSONObject().put("repo", repo ?: JSONObject.NULL).put("tasks", 1), d1, d7, d30)
    private fun task(repo: String, branch: String, hours: Int, d1: JSONObject?, d7: JSONObject?, d30: JSONObject) =
        w(JSONObject().put("repo", repo).put("branch", branch).put("hours", hours).put("agents", JSONArray().put("claude-code")), d1, d7, d30)

    /** A v2 doc written at [generated], counting since 40 days before it unless [countedDays] says otherwise. */
    private fun v2(machine: String, projects: List<JSONObject>, tasks: List<JSONObject> = emptyList(), generated: Long = now - 5 * 60_000,
                   countedDays: Int = 40, hourlyUsd: List<Double>? = null, extra: (JSONObject) -> Unit = {}): JSONObject {
        val h = generated - generated.mod(hour)
        val counted = h - countedDays * 24 * hour
        fun start(hours: Int) = iso(maxOf(h - (hours - 1) * hour, counted))
        return JSONObject().put("schema_version", 2).put("kind", "herdr-meter").put("machine", machine).put("generatedAt", iso(generated))
            .put("counted_from", iso(counted)).put("complete", true).put("prices", JSONObject().put("date", "2026-01-01"))
            .put("windows", JSONObject().put("d1", start(24)).put("d7", start(168)).put("d30", start(720)))
            .put("projects", JSONArray(projects)).put("tasks", JSONArray(tasks)).put("truncated", JSONArray())
            .apply {
                if (hourlyUsd != null) put("hourly", JSONObject().put("from", iso(h - 47 * hour)).put("hours", 48)
                    .put("series", JSONArray().put(JSONObject().put("harness", "claude-code").put("usd", JSONArray(hourlyUsd)))))
                extra(this)
            }
    }
    private fun report(name: String, doc: JSONObject) = Spend.parse(name, doc) as Spend.Report
    private fun view(vararg r: Spend.Reading?, machines: List<String> = emptyList()) = Spend.View(r.filterNotNull(), machines, now, ZoneOffset.UTC)

    private val app = "repo:example/app"
    private val a = report("desktop", v2("core-a",
        listOf(project("github.com/example/app", t(2.0), t(10.0), t(30.0)), project(null, t(0.5), t(0.5), t(0.5))),
        listOf(task("github.com/example/app", "feat/login", 4, t(1.0), t(4.0), t(12.0)), task("github.com/example/app", "fix/crash", 2, null, t(2.0), t(6.0)))))
    private val b = report("workstation", v2("core-b",
        listOf(project("gitlab.com/Example/App", t(3.0), t(5.0), t(8.0))),
        listOf(task("gitlab.com/Example/App", "feat/login", 3, t(3.0), t(5.0), t(8.0)))))

    @Test fun meterReposMapToProjectKeys() {
        assertEquals("repo:example/app", Spend.projectKey("github.com/Example/App"))
        assertEquals("repo:group/sub/repo", Spend.projectKey("gitlab.com/group/sub/repo"))
        assertNull(Spend.projectKey(null)); assertNull(Spend.projectKey("hostonly"))
        assertEquals(Spend.projectKey("github.com/example/herdr"), "repo:" + Projects.remoteKey("git@github.com:example/herdr.git"))
    }

    @Test fun machinesMergeBySumming() {
        val v = view(a, b)
        assertEquals(5.0, v.project(app, D1)!!.usd!!, 1e-9)
        assertEquals(38.0, v.project(app, D30)!!.usd!!, 1e-9)
        // Work in no repository counts in the total only.
        assertEquals(5.5, v.total(D1)!!.usd!!, 1e-9)
        // The same branch on two machines is one task.
        val login = v.task(app, "feat/login", D30)!!
        assertEquals(20.0, login.sum.usd!!, 1e-9); assertEquals(7, login.hours)
        assertEquals(2, v.taskCount(app, D30))
        assertEquals("$5.00", Spend.money(v.project(app, D1)))
    }

    @Test fun periodToggleSumsEachWindow() {
        val v = view(a, b)
        assertEquals(listOf(5.0, 15.0, 38.0), listOf(D1, D7, D30).map { v.project(app, it)!!.usd!! })
        // fix/crash had no usage in the last 24 h: one task then, two over 7 days.
        assertEquals(listOf(1, 2, 2), listOf(D1, D7, D30).map { v.taskCount(app, it) })
        assertEquals(listOf("feat/login"), v.tasks(app, D1).map { it.branch })
    }

    @Test fun costPerTaskIsTaskedSpendOverTasks() {
        val v = view(a, b)
        // 30 days: feat/login 12 + 8, fix/crash 6 → 26 over 2 tasks; untasked work is left out.
        val per = v.costPerTask(app, D30)!!
        assertEquals(13.0, per.usd, 1e-9); assertEquals(2, per.tasks); assertFalse(per.atLeast)
        assertEquals("$13", Spend.money(per))
        assertEquals((7 + 2) / 2.0, v.hoursPerTask(app)!!, 1e-9)
        assertNull(v.costPerTask("repo:example/none", D30))
    }

    @Test fun unpricedTokensShowNoDollar() {
        val doc = v2("core-c", listOf(project("github.com/example/app", t(null, unpriced = 1050), t(null, unpriced = 1050), t(null, unpriced = 1050))),
            listOf(task("github.com/example/app", "feat/x", 1, t(null, unpriced = 1050), t(null, unpriced = 1050), t(null, unpriced = 1050))))
        val v = view(report("vps", doc))
        val s = v.project(app, D1)!!
        assertNull(s.usd); assertEquals(1050L, s.tokens.total)
        assertEquals("$ —", Spend.money(s))
        assertEquals("1k tokens · 90% cached", Spend.detail(s))
        assertNull(v.costPerTask(app, D1))
        // Priced and unpriced together: the $ is a lower bound.
        val mixed = view(a, report("vps", doc)).project(app, D1)!!
        assertEquals("≥ $2.00", Spend.money(mixed))
        // Today's tile: the same, as one word that can't wrap after the "≥".
        assertEquals("≥$2.00", Spend.compact(mixed)); assertEquals("$—", Spend.compact(s))
        assertEquals("$2.00", Spend.compact(view(a).project(app, D1))); assertEquals("—", Spend.compact(null))
    }

    @Test fun unsplitTokensCountButNeverPrice() {
        val doc = v2("core-c", listOf(project("github.com/example/app", null, null, t(1.0, input = 0, cr = 0, out = 0, un = 500, unpriced = 500))))
        val s = view(report("vps", doc)).project(app, D30)!!
        assertEquals(500L, s.tokens.total); assertEquals("≥ $1.00", Spend.money(s))
    }

    @Test fun staleAndMissingMachinesAreNamed() {
        val stale = report("desktop", v2("core-a", listOf(project("github.com/example/app", t(1.0), t(1.0), t(1.0))), generated = now - 3 * hour - 60_000))
        val v = view(stale, b, machines = listOf("desktop", "workstation", "vps", "laptop"))
        assertEquals(listOf(Spend.State.STALE, Spend.State.FRESH, Spend.State.MISSING, Spend.State.MISSING), v.coverage.machines.map { it.state })
        assertEquals("2 of 4 machines reporting · desktop data 3 h old · no meter on laptop, vps", Spend.coverageLine(v.coverage))
        assertFalse(v.coverage.complete)
        // A stale doc still counts: its machine's totals don't vanish.
        assertEquals(4.0, v.project(app, D1)!!.usd!!, 1e-9)
    }

    @Test fun unsupportedVersionAsksForAnUpdate() {
        val future = Spend.parse("desktop", JSONObject().put("schema_version", 99).put("kind", "herdr-meter").put("projects", "anything"))
        assertTrue(future is Spend.Unsupported)
        assertTrue(Spend.parse("desktop", JSONObject().put("hello", 1)) is Spend.Unsupported)
        // A known version that doesn't parse (no generatedAt) is unsupported too, not a crash.
        assertTrue(Spend.parse("desktop", JSONObject().put("schema_version", 2).put("kind", "herdr-meter")) is Spend.Unsupported)
        val v = view(future, b, machines = listOf("desktop", "workstation"))
        assertEquals("1 of 2 machines reporting · desktop: update the app or the meter (doc v99)", Spend.coverageLine(v.coverage))
        assertEquals(3.0, v.project(app, D1)!!.usd!!, 1e-9)
    }

    @Test fun noMeterAnywhereShowsNothing() {
        assertNull(Spend.parse("desktop", null))
        val v = view(machines = listOf("desktop", "workstation"))
        assertTrue(v.coverage.none)
        assertNull(v.total(D1)); assertNull(v.today()); assertNull(v.hourly())
        assertEquals("—", Spend.money(v.project(app, D1)))
    }

    @Test fun oneDocThroughTwoConnectionsCountsOnce() {
        val again = report("desktop (via laptop)", v2("core-a", listOf(project("github.com/example/app", t(2.0), t(10.0), t(30.0)))))
        assertEquals(2.0, view(a, again).project(app, D1)!!.usd!!, 1e-9)
    }

    /** A busy machine: every project kept, tasks cut to fit (the meter's "tasks: kept N of M"). */
    private fun busy(machine: String, projectTasks: Int, usdPerTask: Double?, vararg branches: String) = report(machine, v2(machine,
        listOf(project("github.com/example/app", t(2.0), t(2.0), t(9.0)).put("tasks", projectTasks).apply { usdPerTask?.let { put("usd_per_task", it) } }),
        branches.map { task("github.com/example/app", it, 1, t(1.0), t(1.0), t(1.0)) }) {
        it.put("tasks_other", JSONObject().put("count", 40).put("d30", t(4.0))).put("truncated", JSONArray().put("tasks: kept 150 of 190"))
    })

    @Test fun cutTasksElsewhereLeaveAWholeProjectExact() {
        // Tasks were cut, but this project's two tasks both stayed: its figures are whole.
        val v = view(busy("desktop", 2, 1.0, "feat/login", "fix/crash"))
        assertEquals(2, v.taskCount(app, D1))
        assertEquals("$1.00", Spend.money(v.costPerTask(app, D1)))
        assertEquals("$1.00", Spend.money(v.task(app, "feat/login", D1)!!.sum))
    }

    @Test fun cutTasksFallBackToTheMetersOwnFigures() {
        // One of three tasks kept: the 24 h count is unknown, but the meter's own 30-day count and $ per task hold.
        val v = view(busy("desktop", 3, 2.5, "feat/login"))
        assertNull(v.taskCount(app, D1)); assertNull(v.costPerTask(app, D1))
        assertEquals(3, v.taskCount(app, D30))
        assertEquals("$2.50", Spend.money(v.costPerTask(app, D30)))
        // The kept task is exact on its machine.
        assertEquals("$1.00", Spend.money(v.task(app, "feat/login", D1)!!.sum))
        // Two machines with the project: their counts can't be added (a branch may be on both), so "—".
        val two = view(busy("desktop", 3, 2.5, "feat/login"), b)
        assertNull(two.taskCount(app, D30)); assertEquals("—", Spend.money(two.costPerTask(app, D30)))
        // feat/login is kept on both machines, so its merged sum is exact.
        assertEquals("$4.00", Spend.money(two.task(app, "feat/login", D1)!!.sum))
    }

    @Test fun cutProjectsAreLowerBounds() {
        // Cut projects make every project a lower bound.
        val other = report("desktop", v2("core-a", listOf(project("github.com/example/app", t(2.0), t(2.0), t(2.0)))) {
            it.put("projects_other", JSONObject().put("count", 2).put("tasks", 0).put("d30", t(1.0)))
        })
        assertEquals("≥ $2.00", Spend.money(view(other).project(app, D30)))
        assertEquals(3.0, view(other).total(D30)!!.usd!!, 1e-9)
    }

    @Test fun meterStartedInsideTheWindowIsALowerBound() {
        val young = report("desktop", v2("core-a", listOf(project("github.com/example/app", t(2.0), t(2.0), t(2.0))), countedDays = 10,
            tasks = listOf(task("github.com/example/app", "feat/login", 1, t(1.0), t(1.0), t(1.0)))))
        val v = view(young)
        assertEquals("$2.00", Spend.money(v.project(app, D7)))
        assertEquals("≥ $2.00", Spend.money(v.project(app, D30)))
        // A meter that started 10 days ago still counts its tasks; their 30-day $ are lower bounds.
        assertEquals(1, v.taskCount(app, D30))
        assertEquals("≥ $1.00", Spend.money(v.costPerTask(app, D30)))
        assertEquals("$1.00", Spend.money(v.costPerTask(app, D7)))
    }

    @Test fun todayIsLocalMidnightFromTheHourlySeries() {
        // 48 hourly values ending at 12:00 UTC: the last 13 are today (00:00..12:00) in UTC.
        val usd = List(48) { i -> if (i >= 35) 1.0 else 0.25 }
        val v = view(report("desktop", v2("core-a", listOf(project("github.com/example/app", t(2.0), t(2.0), t(2.0))), hourlyUsd = usd)))
        assertEquals(13.0, v.today()!!.usd!!, 1e-9)
        assertEquals("$13", Spend.money(v.today()))
        val hours = v.hourly()!!
        assertEquals(13, hours.size); assertTrue(hours.all { it == 1.0 })
    }

    @Test fun versionOneRowsStillRead() {
        fun row(hourMs: Long, repo: String?, branch: String?, usd: Double?) = JSONObject().put("hour", iso(hourMs)).put("harness", "claude-code")
            .put("model", "m").put("in", 10).put("cr", 90).put("cw5m", 0).put("cw1h", 0).put("out", 5).apply {
                repo?.let { put("repo", it) }; branch?.let { put("branch", it) }
                if (usd != null) put("usd", usd) else put("priced", false)
            }
        val h = now - now.mod(hour)
        val doc = JSONObject().put("schema_version", 1).put("kind", "herdr-meter").put("machine", "core-a").put("generatedAt", iso(now))
            .put("counted_from", iso(h - 14 * 24 * hour)).put("complete", true).put("prices", JSONObject().put("date", "2026-01-01"))
            .put("hourly", JSONArray().put(row(h, "github.com/example/app", "feat/login", 1.5)).put(row(h - hour, "github.com/example/app", "main", 0.5))
                .put(row(h - 2 * hour, "github.com/example/app", "feat/login", null)))
            .put("daily", JSONArray().put(JSONObject().put("day", "2026-01-10").put("harness", "claude-code").put("model", "m")
                .put("repo", "github.com/example/app").put("branch", "feat/login").put("in", 1).put("cr", 1).put("out", 1).put("usd", 4.0)))
            .put("truncated", JSONArray())
        val v = view(Spend.parse("desktop", doc))
        assertEquals(1, (v.reports.single()).version)
        assertEquals("≥ $2.00", Spend.money(v.project(app, D1)))
        assertEquals(6.0, v.project(app, D7)!!.usd!!, 1e-9)
        // Trunk work is untasked: one task, feat/login.
        assertEquals(listOf("feat/login"), v.tasks(app, D7).map { it.branch })
        assertEquals(5.5, v.task(app, "feat/login", D7)!!.sum.usd!!, 1e-9)
        // 30d starts before counted_from: a lower bound.
        assertTrue(v.project(app, D30)!!.atLeast)
        // Dropped repos on daily rows: 7d per project misses data, 24h doesn't.
        doc.put("truncated", JSONArray().put("daily rows without branch").put("daily rows without repo"))
        val cut = view(Spend.parse("desktop", doc))
        assertTrue(cut.project(app, D7)!!.gap); assertNull(cut.taskCount(app, D7))
        assertEquals(1, cut.taskCount(app, D1))
    }

    @Test fun moneyAndTokensRead() {
        assertEquals("$0.42", Spend.usd(0.42)); assertEquals("$96", Spend.usd(96.4)); assertEquals("$1.2k", Spend.usd(1234.0))
        assertEquals("4.1M", Spend.tokens(4_100_000)); assertEquals("820k", Spend.tokens(820_000)); assertEquals("950", Spend.tokens(950))
        assertEquals("3 h", Spend.age(3 * hour + 5)); assertEquals("1.5 h", Spend.hours(1.5))
        assertTrue(Spend.footnote(view(a)).startsWith("API-equivalent estimate at list price, not an amount billed (prices of 2026-01-01)"))
    }

    /**
     * Today's $ tile at 360 and 411 dp. Text width = (screen − 2·20 gutter − 3·8 gaps) / 4 − 2·10 padding. Each character
     * is taken at 0.62 em, wider than Roboto's digits, "$" and "≥" (about 0.56 em). The preview's "≥$7.80" overflows at
     * 22 sp on both widths (the clipped "≥" in the store screenshots), so the amount auto-sizes; even "≥$99.9k" fits at
     * the 12 sp floor.
     */
    @Test fun todayTileAmountFitsAtPhoneWidths() {
        fun widthDp(text: String, sp: Int) = text.length * 0.62 * sp
        assertEquals(54.0, TodayTiles.textWidthDp(360), 0.01); assertEquals(66.75, TodayTiles.textWidthDp(411), 0.01)
        for (screen in listOf(360, 411)) {
            val room = TodayTiles.textWidthDp(screen)
            assertTrue(widthDp("≥$7.80", TodayTiles.MAX_SP) > room)
            for (amount in listOf("≥$7.80", "≥$99", "≥$9.9k", "≥$99.9k", "$—")) assertTrue("$amount at $screen dp", widthDp(amount, TodayTiles.MIN_SP) <= room)
        }
        // The shrink stays readable for the usual amounts: "≥$7.80" fits at 14 sp on a 360 dp phone.
        assertTrue(widthDp("≥$7.80", 14) <= TodayTiles.textWidthDp(360))
    }

    /** The four tiles grow with the font setting: two 24sp lines, 20dp padding and 4dp slack at 1.3x. */
    @Test fun todayTileHeightFitsAtTheLargestFontScale() {
        assertEquals(72f, TodayTiles.heightDp(1f).value, 0.01f)
        assertEquals(86.4f, TodayTiles.heightDp(1.3f).value, 0.01f)
        assertTrue(TodayTiles.heightDp(1.3f).value >= 2 * 24f * 1.3f + 20f)
    }

    @Test fun previewDocsParseAndMerge() {
        val readings = SpendDemo.readings(now)
        assertEquals(2, readings.size); assertTrue(readings.values.all { it is Spend.Report })
        val v = Spend.View(readings.values.toList(), listOf("Preview machine"), now, ZoneOffset.UTC)
        assertEquals("2 of 2 machines reporting · build-box data 3 h old", Spend.coverageLine(v.coverage))
        assertEquals("$ —", Spend.money(v.task("repo:example/herdr", "fix/api-review", D30)!!.sum))
        assertTrue(v.project("repo:example/herdr", D1)!!.atLeast)
        assertTrue(v.today() != null)
    }
}
