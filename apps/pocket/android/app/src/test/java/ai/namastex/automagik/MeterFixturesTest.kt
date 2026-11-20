package ai.namastex.automagik

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Instant

internal fun meterFixture(name: String): JSONObject =
    meterFixture(name, File(System.getProperty("user.dir")))

private fun meterFixture(name: String, start: File): JSONObject {
    val root = generateSequence(start.absoluteFile) { it.parentFile }
        .firstOrNull { File(it, ".git").exists() }
        ?: error("No checkout found from ${start.absolutePath}")
    val file = File(root, "meter/schema/fixtures/$name")
    check(file.isFile) { "Missing meter fixture ${file.absolutePath}" }
    return JSONObject(file.readText())
}

class MeterFixturesTest {
    @get:Rule val temp = TemporaryFolder()

    private data class Summary(
        val tokens: Long,
        val usd: Double,
        val complete: Boolean = true,
        val cut: Boolean = false,
    )

    @Test fun sharedFixturesMatchBothReaders() {
        val reports = mapOf(
            "full.json" to Summary(220, 2.0),
            "cut.json" to Summary(320, 3.0, cut = true),
            "space.json" to Summary(220, 2.0),
            "first-import.json" to Summary(220, 2.0, complete = false),
        )
        for ((name, expected) in reports) {
            val doc = meterFixture(name)
            val reading = Spend.parse("Example", doc)
            assertTrue("$name Spend result: $reading", reading is Spend.Report)
            val report = reading as Spend.Report
            assertEquals("$name complete", expected.complete, report.complete)
            assertEquals("$name projectsCut", expected.cut, report.projectsCut)
            assertEquals("$name tasksCut", expected.cut, report.tasksCut)
            for (period in Spend.Period.entries) {
                val total = report.totals.getValue(period)
                assertEquals("$name ${period.key} tokens", expected.tokens, total.tokens.total)
                assertEquals("$name ${period.key} USD", expected.usd, requireNotNull(total.usd), 0.0)
                assertEquals("$name ${period.key} unpriced tokens", 20L, total.unpriced)
            }
            if (name == "cut.json") {
                assertTrue(doc.getJSONArray("truncated").length() > 0)
                assertTrue(report.tasks.isEmpty())
                val retained = report.projects.getValue("repo:example/app").windows.getValue(Spend.Period.D1)
                val projectsOther = doc.getJSONObject("projects_other").getJSONObject("d1")
                val tasksOther = doc.getJSONObject("tasks_other").getJSONObject("d1")
                assertTrue(tasksOther.getDouble("usd") > 0)
                assertEquals(requireNotNull(retained.usd) + projectsOther.getDouble("usd"),
                    requireNotNull(report.totals.getValue(Spend.Period.D1).usd), 0.0)
            }

            val feed = SpaceFeed.parse(doc)
            if (name == "space.json") {
                val space = requireNotNull(feed)
                assertEquals(Instant.parse("2026-11-02T18:30:00Z").toEpochMilli(), space.generatedMs)
                assertFalse(space.truncated)
                val project = requireNotNull(space.project("/work/example-project"))
                assertEquals(7.0, project.merges?.n)
                val modelCosts = requireNotNull(project.spent).byModel
                assertTrue(modelCosts.containsKey("example-claude-model"))
                assertNull(modelCosts["example-claude-model"])
                assertEquals(0.0, project.bots.getValue("b-example-leaf").usd24h)
            } else {
                assertNull("$name SpaceFeed result", feed)
            }
        }

        for ((name, version) in mapOf("bad-version.json" to "3", "bad-kind.json" to "2")) {
            val doc = meterFixture(name)
            assertEquals("$name Spend result", Spend.Unsupported("Example", version), Spend.parse("Example", doc))
            assertNull("$name SpaceFeed result", SpaceFeed.parse(doc))
        }
    }

    @Test fun missingGeneratedAtIsUnsupported() {
        val doc = meterFixture("full.json")
        doc.remove("generatedAt")
        assertEquals(Spend.Unsupported("Example", "2"), Spend.parse("Example", doc))
        assertNull(SpaceFeed.parse(doc))
    }

    @Test fun extraRootFieldKeepsBothReadingsEqual() {
        val doc = meterFixture("space.json")
        val report = Spend.parse("Example", doc)
        assertTrue(report is Spend.Report)
        val feed = requireNotNull(SpaceFeed.parse(doc))

        doc.put("future_field", JSONObject().put("example", true))
        assertEquals(report, Spend.parse("Example", doc))
        assertEquals(feed, SpaceFeed.parse(doc))
    }

    @Test fun loaderStopsAtNearestCheckoutAndReturnsFreshObjects() {
        val checkout = temp.newFolder("checkout")
        File(checkout, ".git").mkdir()
        val parentFixture = File(checkout, "meter/schema/fixtures/space.json")
        parentFixture.parentFile!!.mkdirs()
        parentFixture.writeText("""{"version":1}""")

        val worktree = File(checkout, "worktree").apply { mkdir() }
        File(worktree, ".git").writeText("gitdir: example")
        val start = File(worktree, "apps/pocket").apply { mkdirs() }
        assertEquals(1, meterFixture("space.json", checkout).getInt("version"))
        assertThrows(IllegalStateException::class.java) { meterFixture("space.json", start) }

        val ownFixture = File(worktree, "meter/schema/fixtures/space.json")
        ownFixture.parentFile!!.mkdirs()
        ownFixture.writeText("""{"version":2}""")
        meterFixture("space.json", start).put("version", 3)
        assertEquals(2, meterFixture("space.json", start).getInt("version"))
    }
}
