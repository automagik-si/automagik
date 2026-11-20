package ai.namastex.automagik

import ai.namastex.automagik.Fmt.Arrow
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneOffset

/** The Space Row feed, from the shared synthetic fixture (example paths and made-up numbers). */
class SpaceFeedTest {
    private fun fixture() = meterFixture("space.json")
    private val dash = SpaceFeed.DASH

    @Test fun parsesTheFixture() {
        val feed = SpaceFeed.parse(fixture())!!
        assertEquals(java.time.Instant.parse("2026-11-02T18:30:00Z").toEpochMilli(), feed.generatedMs)
        assertFalse(feed.truncated)
        val p = feed.project("/work/example-project/")!!
        assertEquals(7.0, p.merges!!.n); assertEquals(5.0, p.merges!!.prevN)
        assertEquals(listOf("feat", "fix", "test"), SpaceFeed.typeOrder(p.merges!!.byType.keys))
        assertEquals(3.0, p.merges!!.byType["fix"])
        assertEquals("https://github.com/example/example-project/pull/45", p.merges!!.items.single().url)
        assertEquals("github", p.merges!!.items.single().forge)
        assertEquals(listOf(1.0, 2.0, 2.0, 1.0, 1.0, 0.0), p.time!!.bands)
        assertEquals("<15m", p.time!!.labels.first())
        assertEquals("gh-50", p.time!!.fastest!!.task); assertEquals(240.0, p.time!!.slowest!!.min)
        assertEquals(listOf(4.0, 2.0, 1.0, 0.0), p.firstPass!!.fixes)
        assertNull(p.spent!!.byModel["example-claude-model"])
        assertEquals(setOf("example-codex-model", "example-claude-model", "example-deepseek-model"), p.spent!!.byModel.keys)
        assertEquals(0.09, p.spent!!.codexWeekShare)
        assertEquals(10290000.0, p.tokens!!.total)
        assertEquals(310.0, p.tokens!!.byModel.getValue("example-codex-model").turns)
        val captain = p.bots.getValue("b-example-captain")
        assertEquals("member", captain.partsKind)
        assertEquals(listOf("b-example-dev", "b-example-test", "other"), captain.parts.map { it.key })
        val leaf = p.bots.getValue("b-example-leaf")
        assertNull(leaf.usdPerTask); assertEquals(0.0, leaf.usd24h)
        // Line 2 as the rules print it.
        assertEquals("7", Fmt.count(p.merges!!.n)); assertEquals("38m", Fmt.minutes(p.time!!.medianMin))
        assertEquals("57%", Fmt.share(p.firstPass!!.share)); assertEquals("9%", Fmt.share(p.spent!!.codexWeekShare))
        assertEquals("10.3M", Fmt.tokens(p.tokens!!.total)); assertEquals("$18", Fmt.dollars(p.spent!!.realUsd))
        assertEquals("as of 18:30", Fmt.asOf(feed.generatedMs, ZoneOffset.UTC))
    }

    @Test fun nullIsADashNeverZero() {
        listOf(Fmt.count(null), Fmt.minutes(null), Fmt.share(null), Fmt.dollars(null), Fmt.tokens(null)).forEach { assertEquals(dash, it) }
        assertEquals("as of $dash", Fmt.asOf(null))
        // Zero is a real value.
        assertEquals("0", Fmt.count(0.0)); assertEquals("0m", Fmt.minutes(0.0)); assertEquals("0%", Fmt.share(0.0)); assertEquals("$0.00", Fmt.dollars(0.0))
        // Missing keys are null too.
        val leaf = SpaceFeed.parse(fixture())!!.project("/work/example-project")!!.bots.getValue("b-example-leaf")
        assertEquals(dash, Fmt.dollars(leaf.usdPerTask)); assertEquals(dash, Fmt.minutes(leaf.minPerTask)); assertEquals("$0.00", Fmt.dollars(leaf.usd24h))
    }

    @Test fun formatsMatchTheRules() {
        assertEquals(listOf("9m", "38m", "1h", "1h 5m", "4h", "26h 40m", "1h"), listOf(9.0, 38.0, 60.0, 65.0, 240.0, 1600.0, 59.5).map(Fmt::minutes))
        assertEquals(listOf("57%", "9%", "<1%"), listOf(0.57, 0.09, 0.004).map(Fmt::share))
        assertEquals(listOf("$2.60", "$18", "$105", "$1.2k", "<$0.01"), listOf(2.6, 18.4, 105.0, 1200.0, 0.004).map(Fmt::dollars))
        assertEquals(listOf("310", "90.0k", "120k", "10.3M", "150M", "1.2B"), listOf(310.0, 90000.0, 120000.0, 10290000.0, 150000000.0, 1.2e9).map(Fmt::tokens))
        assertEquals("-$2.60", Fmt.dollars(-2.6))
    }

    @Test fun arrowsCompareRawValues() {
        assertEquals(Arrow.UP, Fmt.arrow(7.0, 5.0))
        assertEquals(Arrow.DOWN, Fmt.arrow(38.0, 55.0))
        assertEquals(Arrow.NONE, Fmt.arrow(5.0, 5.0))
        assertEquals(Arrow.NONE, Fmt.arrow(null, 5.0)); assertEquals(Arrow.NONE, Fmt.arrow(5.0, null))
        // Colour: merges up is good, time up is bad; no arrow has no colour.
        assertEquals(true, Fmt.good(Arrow.UP, upGood = true)); assertEquals(false, Fmt.good(Arrow.UP, upGood = false))
        assertEquals(true, Fmt.good(Arrow.DOWN, upGood = false)); assertNull(Fmt.good(Arrow.NONE, upGood = true))
    }

    @Test fun line2ChipsFollowTheArrowTable() {
        val p = SpaceFeed.parse(fixture())!!.project("/work/example-project")!!
        val line = SpaceFeed.line2(p).associateBy { it.key }
        assertEquals(listOf("merges", "time", "first_pass", "spent", "tokens"), SpaceFeed.line2(p).map { it.key })
        assertEquals(Arrow.UP to true, line.getValue("merges").let { it.arrow to it.good })        // 7 vs 5, up is good
        assertEquals(Arrow.DOWN to true, line.getValue("time").let { it.arrow to it.good })        // 38 vs 55, up is bad
        assertEquals(Arrow.UP to true, line.getValue("first_pass").let { it.arrow to it.good })    // 0.57 vs 0.4
        assertEquals(Arrow.DOWN to true, line.getValue("spent").let { it.arrow to it.good })       // real_usd 18.4 vs 22.1
        assertEquals(Arrow.UP to false, line.getValue("tokens").let { it.arrow to it.good })       // more tokens is bad
        assertEquals("9%", line.getValue("spent").text)
    }

    @Test fun aNullValueHasNoArrowEvenWhenItsFieldsMoved() {
        // Spent's value is codex_week_share; its arrow compares real_usd. Null share: "–" and no arrow.
        val spent = SpaceFeed.Spent(realUsd = 18.4, prevRealUsd = 22.1, byModel = emptyMap(), codexWeekShare = null)
        val chip = SpaceFeed.line2(SpaceFeed.Project(null, null, null, spent, null, emptyMap())).single { it.key == "spent" }
        assertEquals(dash, chip.text); assertEquals(true, chip.isNull)
        assertEquals(Arrow.NONE, chip.arrow); assertNull(chip.good)
        // Missing sections: every chip "–", no arrows.
        SpaceFeed.line2(SpaceFeed.Project(null, null, null, null, null, emptyMap())).forEach {
            assertEquals(dash, it.text); assertEquals(Arrow.NONE, it.arrow); assertNull(it.good)
        }
    }

    @Test fun modelsSortByUtf16AndTakeColoursModEight() {
        val ids = listOf("b", "é", "B", "a", "Z", "m1", "m2", "m3", "m4")
        val p = SpaceFeed.Project(null, null, null,
            SpaceFeed.Spent(null, null, ids.take(5).associateWith { 1.0 }, null),
            SpaceFeed.Tokens(null, null, null, ids.drop(4).associateWith { SpaceFeed.ModelTokens(1.0, null, null, null, null, null) }), emptyMap())
        // UTF-16 code units: uppercase before lowercase, accented after ASCII.
        assertEquals(listOf("B", "Z", "a", "b", "m1", "m2", "m3", "m4", "é"), SpaceFeed.models(p))
        assertEquals(listOf("ansi4", "ansi6", "ansi3", "ansi5", "ansi2", "ansi12", "ansi13", "ansi14", "ansi4"),
            SpaceFeed.models(p).map { SpaceFeed.modelColor(p, it) })
        // The same model has one colour in both cards: "Z" is in spent and tokens.
        assertEquals("ansi6", SpaceFeed.modelColor(p, "Z"))
    }

    @Test fun partsAndMergeTypesTakeTheirColours() {
        assertEquals(listOf("ansi4", "ansi6", "dim", "ansi5"), listOf("a", "b", "other", "c").mapIndexed { i, k -> SpaceColors.part(i, k) })
        assertEquals("ansi4", SpaceColors.part(8, "x"))
        val types = mapOf("feat" to "ansi13", "fix" to "ansi11", "test" to "ansi14", "docs" to "ansi12", "refactor" to "ansi5", "perf" to "ansi10",
            "ci" to "ansi4", "build" to "ansi6", "chore" to "ansi8", "style" to "ansi9", "revert" to "ansi1", "wip" to "dim")
        types.forEach { (t, token) -> assertEquals(t, token, SpaceColors.type(t)) }
    }

    @Test fun noSpaceOrAnotherVersionDrawsNothing() {
        assertNull(SpaceFeed.parse(null))
        assertNull(SpaceFeed.parse(JSONObject().put("kind", "herdr-meter").put("schema_version", 2)))
        assertNull(SpaceFeed.parse(fixture().apply { getJSONObject("space").put("version", 2) }))
        assertNull(SpaceFeed.parse(JSONObject().put("space", "not an object")))
        // Missing sections and future keys are fine.
        val feed = SpaceFeed.parse(JSONObject().put("space", JSONObject().put("version", 1).put("future", 1)
            .put("projects", JSONObject().put("/w/a", JSONObject().put("merges", JSONObject().put("n", JSONObject.NULL))))))!!
        val a = feed.project("/w/a")!!
        assertNull(a.merges!!.n); assertNull(a.time); assertEquals(emptyMap<String, SpaceFeed.Bot>(), a.bots)
        assertNull(feed.generatedMs)
    }

    @Test fun projectKeyIsTheParentOfTheCommonDir() {
        assertEquals("/w/brain", SpaceFeed.projectKey(GitInfo("dev", 0, 0, "/w/brain", "/w/brain/.git")))
        assertEquals("/w/brain", SpaceFeed.projectKey(GitInfo("fix/x", 0, 0, "/w/brain-fix", "/w/brain/.git")))
        assertNull(SpaceFeed.projectKey(null))
    }

    @Test fun rowsMapSpacesByProjectKeyAndBotsByLabel() {
        val feed = SpaceFeed.parse(fixture())!!
        val main = PocketSpace("s1", "example", "/work/example-project", "", listOf(PocketTab("tb1", "a", listOf("t1"))))
        val tree = PocketSpace("s2", "example-fix", "/work/example-fix", "", listOf(PocketTab("tb2", "b", listOf("t2"))))
        val other = PocketSpace("s3", "other", "/work/other", "", listOf(PocketTab("tb3", "c", listOf("t3"))))
        fun t(a: String, cwd: String, bot: String) = CoreTerminal(a, a, cwd, "live", "idle", "Codex", "", 80, 24, labels = mapOf("bot" to bot))
        val git = mapOf(Sidebar.gitKey("", "/work/example-project") to GitInfo("main", 0, 0, "/work/example-project", "/work/example-project/.git"),
            Sidebar.gitKey("", "/work/example-fix") to GitInfo("fix/x", 0, 0, "/work/example-fix", "/work/example-project/.git"),
            Sidebar.gitKey("", "/work/other") to GitInfo("main", 0, 0, "/work/other", "/work/other/.git"))
        val host = SidebarHost("h", "Machine", true, listOf(main, tree, other),
            listOf(t("t1", "/work/example-project", "b-example-captain"), t("t2", "/work/example-fix", "b-example-leaf"), t("t3", "/work/other", "b-x")),
            emptyList(), git = git, space = mapOf("" to feed),
            bots = mapOf("|/work/example-project" to SpaceFeed.Names(mapOf("b-example-captain" to "Captain"))))
        val rows = Sidebar.rows(listOf(host), Programs(JSONObject()))
        val spaces = rows.filterIsInstance<SpaceRow>().associateBy { it.space.id }
        assertNotNull(spaces.getValue("s1").stats)
        assertNull(spaces.getValue("s2").stats)   // nested worktree: no line 2
        assertNull(spaces.getValue("s3").stats)   // not in the feed: no line 2
        val bots = rows.filterIsInstance<AgentRow>().associate { it.terminal.address to it.bot }
        assertEquals("Captain", bots.getValue("t1")!!.name)
        assertEquals(0.0, bots.getValue("t2")!!.bot!!.usd24h)   // a worktree's bot reads its main checkout's project
        assertNull(bots.getValue("t3")!!.bot)                   // still a button, every cell "–"
        // No feed: no buttons.
        assertNull(Sidebar.rows(listOf(host.copy(space = emptyMap())), Programs(JSONObject())).filterIsInstance<AgentRow>().first().bot)
    }

    @Test fun partsAreNamedFromTheBotsFile() {
        val names = SpaceFeed.names("""{"version":1,"categories":[{"id":"build","title":"Build"}],"bots":[{"id":"b-example-dev","name":"Dev"}]}""")
        assertEquals("Dev", SpaceFeed.partLabel(SpaceFeed.Part("b-example-dev", 1.0), "member", names))
        assertEquals("b-unknown", SpaceFeed.partLabel(SpaceFeed.Part("b-unknown", 1.0), "member", names))
        assertEquals("Build", SpaceFeed.partLabel(SpaceFeed.Part("build", 1.0), "category", names))
        assertEquals("other", SpaceFeed.partLabel(SpaceFeed.Part("other", 1.0), "member", names))
        assertEquals("example-model", SpaceFeed.partLabel(SpaceFeed.Part("example-model", 1.0), "model", names))
        assertEquals(SpaceFeed.Names(), SpaceFeed.names("not json"))
    }

    @Test fun coloursMatchTheRulesTables() {
        fun hex(l: List<Int>) = l.joinToString(" ") { "#%06x".format(it) }
        assertEquals("#009957 #aa981d #f77f1f #e64d5d", hex(SpaceColors.scale(4, dark = true)))
        assertEquals("#007d47 #5f6b2c #a2512a #c7303f", hex(SpaceColors.scale(4, dark = false)))
        assertEquals("#009957 #669934 #cc9811 #fa8913 #f06b38 #e64d5d", hex(SpaceColors.scale(6, dark = true)))
        assertEquals("#007d47 #397237 #726727 #9a5825 #b14432 #c7303f", hex(SpaceColors.scale(6, dark = false)))
        assertEquals(listOf("feat", "fix", "test", "chore", "alpha", "zeta"), SpaceFeed.typeOrder(listOf("zeta", "test", "chore", "fix", "alpha", "feat")))
        assertNotNull(SpaceColors.rgb("nope", dark = true))
    }
}
