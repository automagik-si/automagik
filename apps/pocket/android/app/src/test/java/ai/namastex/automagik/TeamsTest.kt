package ai.namastex.automagik

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import java.io.File
import java.time.ZoneOffset

class TeamsTest {
    private fun fixture(name: String) = javaClass.getResource("/teams/$name")!!.readText()
    private fun terminal(status: String, live: Boolean = true, statusMs: Long = 0, bot: String? = null) =
        CoreTerminal("t1", "x", "/w", if (live) "live" else "exited", status, "claude-code", "", 80, 24,
            labels = bot?.let { mapOf("bot" to it) } ?: emptyMap(), statusMs = statusMs)

    // ---- state -> pose -> pet row

    @Test fun posesFollowTheDesktopRule() {
        val now = 100 * 60_000L
        assertEquals(Teams.ASLEEP, Teams.poseOf(null, now))
        assertEquals(Teams.ASLEEP, Teams.poseOf(terminal("working", live = false), now))
        assertEquals(Teams.WORKING, Teams.poseOf(terminal("working"), now))
        assertEquals(Teams.NEEDS_YOU, Teams.poseOf(terminal("blocked"), now))
        assertEquals(Teams.FAILED, Teams.poseOf(terminal("error"), now))
        assertEquals(Teams.DONE, Teams.poseOf(terminal("done"), now))
        assertEquals(Teams.IDLE, Teams.poseOf(terminal("idle", statusMs = now - 9 * 60_000L), now))
        assertEquals(Teams.ASLEEP, Teams.poseOf(terminal("idle", statusMs = now - 10 * 60_000L), now))
        // No status time yet: idle with no asleep timer, as on the desktop.
        assertEquals(Teams.IDLE, Teams.poseOf(terminal("idle"), now))
        assertEquals(Teams.IDLE, Teams.poseOf(terminal(""), now))
    }

    @Test fun posesPlayTheirPetRows() {
        assertEquals(Teams.PetRow(null, "running"), Teams.petRow(Teams.WORKING))
        assertEquals(Teams.PetRow("waving", "waiting"), Teams.petRow(Teams.NEEDS_YOU))
        assertEquals(Teams.PetRow(null, "review"), Teams.petRow(Teams.DONE))
        assertEquals(Teams.PetRow(null, "failed"), Teams.petRow(Teams.FAILED))
        assertEquals(Teams.PetRow(null, "sleep"), Teams.petRow(Teams.ASLEEP))
        assertEquals(Teams.PetRow(null, "idle"), Teams.petRow("unknown"))
        assertEquals("jumping", Teams.EVENT_ROWS["merged"])
        // Every row a pose plays is in the atlas (sleep is the strip).
        for (r in Teams.STATE_ROWS.values) for (row in listOfNotNull(r.once, r.row)) assertTrue(row, row == "sleep" || row in PetAtlas.ROWS)
    }

    /** The monorepo's own file: apps/bots-dsh/src/client/<name>, found from wherever Gradle runs the tests. */
    private fun botsDsh(name: String): String {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val f = File(dir, "apps/bots-dsh/src/client/$name")
            if (f.isFile) return f.readText()
            dir = dir.parentFile
        }
        error("apps/bots-dsh/src/client/$name not found above ${System.getProperty("user.dir")}")
    }

    @Test fun poseMapMatchesTheBotTeamsPetJs() {
        val js = botsDsh("pet.js")
        val block = js.substringAfter("export const STATE_ROWS = Object.freeze({").substringBefore("\n})")
        val entry = Regex("""'?([\w-]+)'?: Object\.freeze\(\{ (?:once: '([\w-]+)', )?row: '([\w-]+)' \}\)""")
        val fromJs = entry.findAll(block).associate { m -> m.groupValues[1] to Teams.PetRow(m.groupValues[2].ifEmpty { null }, m.groupValues[3]) }
        assertEquals(Teams.STATE_ROWS, fromJs)
        val events = js.substringAfter("export const EVENT_ROWS = Object.freeze({").substringBefore("\n})")
        val fromJsEvents = Regex("""'?([\w-]+)'?: Object\.freeze\(\{ once: '([\w-]+)' \}\)""").findAll(events).associate { it.groupValues[1] to it.groupValues[2] }
        assertEquals(Teams.EVENT_ROWS, fromJsEvents)
    }

    @Test fun atlasRowsMatchTheBotTeamsPoses() {
        val js = botsDsh("pet-poses.js")
        val block = js.substringAfter("export const ROWS = Object.freeze({").substringBefore("\n})")
        fun ms(expr: String): List<Long> = if (expr.startsWith("[")) expr.trim('[', ']').split(',').map { it.trim().toLong() }
            else Regex("""even\((\d+), (\d+), (\d+)\)""").find(expr)!!.destructured.let { (n, a, b) -> List(n.toInt() - 1) { a.toLong() } + b.toLong() }
        val rows = Regex("""'?([\w-]+)'?: \{ row: (\d+), ms: (\[[^\]]*]|even\([^)]*\)) \}""").findAll(block)
            .associate { m -> m.groupValues[1] to PetAtlas.Row(m.groupValues[2].toInt(), ms(m.groupValues[3])) }
        assertEquals(PetAtlas.ROWS, rows)
        assertTrue(js.contains("export const SLEEP = Object.freeze({ ms: Array(${PetAtlas.SLEEP.size}).fill(${PetAtlas.SLEEP.first()}) })"))
        assertTrue(js.contains("export const CELL = Object.freeze({ width: ${PetAtlas.CELL_W}, height: ${PetAtlas.CELL_H}, columns: 8 })"))
    }

    // ---- registry and live state, from synthetic fixtures

    @Test fun registryParsesHerdrBotsJson() {
        val bots = Teams.registry.parse(fixture("bots.json"))
        assertEquals(listOf("b-aaaaaaaaaa", "b-bbbbbbbbbb", "b-cccccccccc", "b-dddddddddd"), bots.map { it.id })
        assertEquals(Teams.Member("b-aaaaaaaaaa", "Lead", main = true, pet = "kitty-blue"), bots[0])
        assertEquals("Builder", bots[1].name)   // the first entry of a repeated id wins
        assertNull(bots[2].pet)                 // no look: Genie
        assertNull(bots[3].pet)                 // a look that isn't one path segment is no pet
        assertEquals("b-dddddddddd", bots[3].name)
        assertEquals(emptyList<Teams.Member>(), Teams.registry.parse("not json"))
        assertEquals(emptyList<Teams.Member>(), Teams.registry.parse(null))
        assertEquals("/work/example/.herdr/bots.json", Teams.registry.path("/work/example/"))
    }

    private fun machine(): MachineState {
        val terminals = JSONObject(fixture("terminals.json")).getJSONArray("terminals").objects().map(CoreTerminal::parse)
        val spaces = listOf(
            PocketSpace("s1", "Example", "/work/example", "", listOf(PocketTab("a", "Main", listOf("t1", "t3", "t5")))),
            PocketSpace("s2", "Example worktree", "/work/example-wt", "", listOf(PocketTab("b", "Wt", listOf("t2")))),
            PocketSpace("s3", "Site", "/work/site", "", listOf(PocketTab("c", "Shell", listOf("t4")))))
        val git = mapOf(
            Sidebar.gitKey("", "/work/example") to GitInfo("dev", 0, 0, "/work/example", "/work/example/.git"),
            Sidebar.gitKey("", "/work/example-wt") to GitInfo("feat/x", 0, 0, "/work/example-wt", "/work/example/.git"),
            Sidebar.gitKey("", "/work/site") to GitInfo("main", 0, 0, "/work/site", "/work/site/.git"))
        return MachineState(connected = true, terminals = terminals, spaces = spaces, git = git,
            members = mapOf("|/work/example" to Teams.registry.parse(fixture("bots.json"))),
            icons = mapOf("s1" to Teams.Icon.Emoji("🧪"), "s2" to Teams.Icon.Emoji("🌲")), colors = mapOf("s1" to "ansi3"))
    }

    @Test fun teamsComeFromSpacesRegistryAndLabelledPanes() {
        val teams = Teams.build(mapOf("h1" to machine()), now = 10_000L)
        // One project per main checkout: the worktree space folds in, and the first space names it and gives its icon.
        assertEquals(listOf("h1||/work/example", "h1||/work/site"), teams.map { it.id })
        val example = teams[0]
        assertEquals("Example", example.name)
        assertEquals(Teams.Icon.Emoji("🧪"), example.icon)
        assertEquals("ansi3", example.color)
        assertEquals(Teams.Icon.Letter, teams[1].icon)
        assertEquals("S", teams[1].letter)
        val bots = example.bots.associateBy { it.id }
        assertEquals(Teams.WORKING, bots.getValue("b-aaaaaaaaaa").pose)
        assertEquals(Teams.NEEDS_YOU, bots.getValue("b-bbbbbbbbbb").pose)
        assertEquals("permission", bots.getValue("b-bbbbbbbbbb").kind)
        assertEquals(TerminalRef("h1", "t2"), bots.getValue("b-bbbbbbbbbb").ref)
        // A registry bot whose only pane has exited is asleep, with no terminal to open.
        assertEquals(Teams.ASLEEP, bots.getValue("b-cccccccccc").pose)
        assertNull(bots.getValue("b-cccccccccc").ref)
        // A labelled pane the registry doesn't list still shows, named by its id.
        assertEquals("b-eeeeeeeeee", bots.getValue("b-eeeeeeeeee").name)
        assertEquals(Teams.DONE, bots.getValue("b-eeeeeeeeee").pose)
        // Rows: needs-you first, then working, done, asleep (two asleep ones by name: "b-dddddddddd" before "Checker").
        assertEquals(listOf("b-bbbbbbbbbb", "b-aaaaaaaaaa", "b-eeeeeeeeee", "b-dddddddddd", "b-cccccccccc"), example.bots.map { it.id })
        assertEquals(1, example.needsYou)
        assertEquals(1, example.working)
        assertEquals(emptyList<Teams.Bot>(), teams[1].bots)
        assertEquals(listOf("b-bbbbbbbbbb"), Teams.deck(teams).map { it.second.id })
    }

    // ---- reorder

    private fun team(id: String, vararg poses: String) = Teams.Team(id, "h", "", id, id, Teams.Icon.Letter, null,
        poses.mapIndexed { i, p -> Teams.Bot("$id-$i", "$id$i", false, null, p, "", i.toLong(), TerminalRef("h", "$id$i"), "") })

    @Test fun projectsThatNeedYouJumpAheadAndTheRestKeepHerdrsOrder() {
        val a = team("a", Teams.WORKING, Teams.WORKING)
        val b = team("b", Teams.IDLE)
        val c = team("c", Teams.NEEDS_YOU)
        val d = team("d", Teams.NEEDS_YOU, Teams.NEEDS_YOU)
        assertEquals(listOf("a", "b"), Teams.order(listOf(a, b)).map { it.id })   // working never reorders
        val after = Teams.order(listOf(a, b, c, d))
        assertEquals(listOf("d", "c", "a", "b"), after.map { it.id })
        assertEquals(listOf("d", "c"), Teams.jumped(listOf("a", "b", "c", "d"), after))
        assertEquals(emptyList<String>(), Teams.jumped(after.map { it.id }, after))
        assertEquals(emptyList<String>(), Teams.jumped(listOf("b", "a"), Teams.order(listOf(a, b))))
    }

    // ---- icons and colours

    @Test fun iconsFollowHerdrsSpaceIconAndFallBackToTheLetter() {
        assertEquals(Teams.Icon.Emoji("🧠"), Teams.icon(JSONObject("""{"kind":"emoji","char":"🧠"}""")))
        assertEquals(Teams.Icon.Image("space-icons/s1-1.png"), Teams.icon(JSONObject("""{"kind":"image","file":"space-icons/s1-1.png"}""")))
        assertEquals(Teams.Icon.Image("space-icons/old.png"), Teams.icon("space-icons/old.png"))
        assertEquals(Teams.Icon.Letter, Teams.icon(JSONObject("""{"kind":"emoji","char":""}""")))
        assertEquals(Teams.Icon.Letter, Teams.icon(JSONObject("""{"kind":"sticker"}""")))
        assertEquals(Teams.Icon.Letter, Teams.icon(null))
        // The am.* keys win; the old keys count only when the new one isn't there yet.
        val both = Teams.looks(JSONObject("""{"am.sidebar.icons":{"s1":{"kind":"emoji","char":"A"}},"spaces-agents.icons":{"s1":{"kind":"emoji","char":"B"}},
            "space.colors":{"s1":"ansi1"}}"""))
        assertEquals(Teams.Icon.Emoji("A"), both.icons["s1"])
        assertEquals("ansi1", both.colors["s1"])
        assertEquals(Teams.Looks(), Teams.looks(JSONObject("{}")))
        assertTrue(Teams.safeIconFile("space-icons/s1-17.png"))
        assertTrue(!Teams.safeIconFile("space-icons/../shared.json") && !Teams.safeIconFile("/etc/passwd") && !Teams.safeIconFile("space-icons/a/b.png"))
    }

    @Test fun tileColoursAreHerdrsOwn() {
        assertEquals(0x22a99a, Teams.colorRgb(null, dark = true))
        assertEquals(0xe3814f, Teams.colorRgb("ansi3", dark = false))
        assertEquals(0x123456, Teams.colorRgb("#123456", dark = true))
        assertEquals(0xaabbcc, Teams.colorRgb("#abc", dark = true))
        assertNull(Teams.colorRgb("transparent", dark = true))
        assertEquals(SpaceColors.rgb("ansi12", true), Teams.colorRgb("ansi12", dark = true))
    }

    // ---- agent time and today's peak

    @Test fun feedTasksGiveAgentMinutesAndWorkingCountsGivePeaks() {
        assertNull(Teams.agentMinutes(null))
        assertNull(Teams.agentMinutes(SpaceFeed.Project(null, null, null, null, null, emptyMap())))
        assertEquals(0.0, Teams.agentMinutes(SpaceFeed.Project(null, null, null, null, null, emptyMap(), emptyList()))!!, 0.0)
        assertEquals(mapOf("a" to 2, "b" to 0, "" to 2), Teams.working(listOf(team("a", Teams.WORKING, Teams.WORKING), team("b", Teams.IDLE))))
    }

    @Test fun feedTasksGiveAgentTimeAndCelebrations() {
        val doc = JSONObject("""{"generated_at":"2026-11-02T18:30:00Z","space":{"version":1,"projects":{"/work/example":{"merges":{"n":2},
            "tasks":[{"task":"gh-1","bots":[{"bot":"b-aaaaaaaaaa","work_min":25},{"bot":"b-bbbbbbbbbb","work_min":null}]},{"task":"gh-2","bots":[{"bot":"b-aaaaaaaaaa","work_min":11}]}]}}}}""")
        val feed = SpaceFeed.parse(doc)!!
        assertEquals(36.0, Teams.agentMinutes(feed.project("/work/example"))!!, 0.0)
        val m = machine().copy(space = mapOf("" to feed))
        val team = Teams.build(mapOf("h1" to m), 10_000L).first()
        assertEquals(2.0, team.merged!!, 0.0)
        assertEquals(36.0, team.agentMin!!, 0.0)
        val seen = Teams.merges(mapOf("h1" to m)).getValue("h1|")
        assertEquals(emptySet<String>(), Teams.celebrations(null, seen))   // the first reading is the baseline
        assertEquals(emptySet<String>(), Teams.celebrations(seen, seen))
        val before = seen - "h1||/work/example|gh-2|b-aaaaaaaaaa"
        assertEquals(setOf("h1||/work/example|b-aaaaaaaaaa"), Teams.celebrations(before, seen))
        assertEquals("${team.id}|b-aaaaaaaaaa", Teams.celebrations(before, seen).single())
    }

    // ---- cache and offline

    @Test fun cachedProjectsOfOfflineMachinesStayAndAreStale() {
        val live = listOf(team("a", Teams.WORKING).copy(hostId = "h1"))
        val cached = listOf(team("a", Teams.IDLE).copy(hostId = "h1"), team("b", Teams.NEEDS_YOU).copy(hostId = "h2"),
            team("c", Teams.IDLE).copy(hostId = "gone"))
        val merged = Teams.merge(live, cached, read = setOf("h1|"), known = setOf("h1", "h2"))
        assertEquals(listOf("a", "b"), merged.map { it.id })   // a machine no longer saved shows nothing
        assertEquals(Teams.WORKING, merged[0].bots.single().pose)
        assertTrue(merged[1].stale)
        assertNull(merged[1].bots.single().ref)   // an offline machine's terminal can't be opened
        assertEquals(emptyList<Pair<Teams.Team, Teams.Bot>>(), Teams.deck(merged.drop(1)))
    }

    @Test fun aSpaceWaitsForItsGitAnswerAndTheCacheCoversAMachineStillBeingRead() {
        val m = machine()
        assertEquals(emptyList<Teams.Team>(), Teams.build(mapOf("h1" to m.copy(git = emptyMap())), 10_000L))
        // Not a repository (git answered null): a project of its own, keyed by the space.
        val site = Teams.build(mapOf("h1" to m.copy(git = m.git + (Sidebar.gitKey("", "/work/site") to null))), 10_000L).last()
        assertEquals("h1||space:s3", site.id)
        // Connected but not read yet: the cache shows, stale, and nothing in it can be answered.
        val cached = Teams.build(mapOf("h1" to m), 10_000L)
        val shown = Teams.merge(emptyList(), cached, read = emptySet(), known = setOf("h1"))
        assertEquals(cached.map { it.id }, shown.map { it.id })
        assertTrue(shown.all { it.stale } && Teams.deck(shown).isEmpty())
    }

    @Test fun aMachineIsReadOnceItsSpacesAndGitAre() {
        val m = machine().copy(session = 2, readSession = 2, layouts = mapOf("" to 1_000L))
        assertTrue(Teams.ready(m, "", now = 2_000L))
        assertTrue(!Teams.ready(m.copy(connected = false), "", 2_000L))
        assertTrue(!Teams.ready(m.copy(readSession = 1), "", 2_000L))   // this session's terminals not read yet
        val pending = m.copy(git = m.git - Sidebar.gitKey("", "/work/site"))
        assertTrue(!Teams.ready(pending, "", 2_000L))
        assertTrue(Teams.ready(pending, "", 1_000L + Teams.READ_GRACE_MS))   // a space whose git never answers stops holding it
        // A space on a linked machine that is down doesn't hold it back, and shows nothing.
        val away = m.copy(spaces = m.spaces + PocketSpace("box/s9", "Box", "/x", "box", listOf(PocketTab("box/z", "Z", listOf("box/t9")))))
        assertTrue(Teams.ready(away, "", 2_000L))
        assertEquals(2, Teams.build("h1", away, 2_000L).size)
        // A folder the core didn't report as a path: a project of its own, no git needed.
        val relative = m.copy(spaces = m.spaces + PocketSpace("s8", "Home", "~", "", emptyList()))
        assertTrue(Teams.ready(relative, "", 2_000L))
        assertEquals("h1||space:s8", Teams.build("h1", relative, 2_000L).last().id)
    }

    // ---- each linked machine on its own

    /** [machine] plus linked machines "fast" and "slow" with a project each; [slowGit]: slow's git has answered. */
    private fun linkedMachines(slowGit: Boolean, slowLaidOut: Boolean = true, slowUp: Boolean = true): MachineState {
        val m = machine().copy(session = 2, readSession = 2)
        fun space(machine: String) = PocketSpace("$machine/s1", machine, "/srv/$machine", machine,
            listOf(PocketTab("$machine/a", "A", listOf("$machine/t1"))))
        fun pane(machine: String) = CoreTerminal("$machine/t1", "lead", "/srv/$machine", "live", "blocked", "claude-code", "Run it?", 80, 24,
            labels = mapOf("bot" to "b-$machine"), statusMs = 7, kind = "permission")
        fun git(machine: String) = Sidebar.gitKey(machine, "/srv/$machine") to GitInfo("main", 0, 0, "/srv/$machine", "/srv/$machine/.git")
        return m.copy(spaces = m.spaces + space("fast") + space("slow"), terminals = m.terminals + pane("fast") + pane("slow"),
            git = m.git + git("fast") + (if (slowGit) mapOf(git("slow")) else emptyMap()),
            linked = listOf(LinkedMachine("fast", "connected"), LinkedMachine("slow", if (slowUp) "connected" else "disconnected")),
            layouts = mapOf("" to 1_000L, "fast" to 1_000L) + (if (slowLaidOut) mapOf("slow" to 1_000L) else emptyMap()))
    }

    @Test fun eachLinkedMachineGoesLiveOnItsOwnAndASlowOneDoesNotHoldTheOthersBack() {
        val m = linkedMachines(slowGit = false)
        // slow's git hasn't answered: the core's own machine and fast are read, slow isn't (until the grace runs out).
        assertEquals(setOf("h1|", "h1|fast"), Teams.read(mapOf("h1" to m), 2_000L))
        assertEquals(setOf("h1|", "h1|fast", "h1|slow"), Teams.read(mapOf("h1" to m), 1_000L + Teams.READ_GRACE_MS))
        // Its git answers: slow is read too, without waiting for the grace.
        assertEquals(setOf("h1|", "h1|fast", "h1|slow"), Teams.read(mapOf("h1" to linkedMachines(slowGit = true)), 2_000L))
        // A machine whose layout didn't answer this session, or that is down, is never read, whatever the grace.
        for (away in listOf(linkedMachines(slowGit = true, slowLaidOut = false), linkedMachines(slowGit = true, slowUp = false)))
            assertEquals(setOf("h1|", "h1|fast"), Teams.read(mapOf("h1" to away), 1_000L + Teams.READ_GRACE_MS))
        // Nothing of this session read yet: nothing is.
        assertEquals(emptySet<String>(), Teams.read(mapOf("h1" to m.copy(readSession = 1)), 2_000L))
    }

    @Test fun theCacheShowsFirstAndEachMachineReplacesItsRowsAsItIsRead() {
        val full = linkedMachines(slowGit = true)
        val cached = Teams.build(mapOf("h1" to full), 2_000L)
        val known = setOf("h1")
        // Connected, nothing read yet: every cached project shows at once, stale.
        val first = Teams.merge(Teams.live(mapOf("h1" to full), emptySet(), 2_000L), cached, emptySet(), known)
        assertEquals(cached.map { it.id }.toSet(), first.map { it.id }.toSet())
        assertTrue(first.all { it.stale })
        // fast and the core's own are read; slow is still being read: its row stays cached and stale.
        val partial = linkedMachines(slowGit = false)
        val read = Teams.read(mapOf("h1" to partial), 2_000L)
        val shown = Teams.merge(Teams.live(mapOf("h1" to partial), read, 2_000L), cached, read, known)
        assertEquals(cached.map { it.id }.toSet(), shown.map { it.id }.toSet())
        assertEquals(listOf("slow"), shown.filter { it.stale }.map { it.machine })
        assertTrue(shown.filter { !it.stale }.all { it.machine in setOf("", "fast") })
        // Then slow: nothing stale is left.
        val all = Teams.read(mapOf("h1" to full), 2_000L)
        assertTrue(Teams.merge(Teams.live(mapOf("h1" to full), all, 2_000L), cached, all, known).none { it.stale })
    }

    @Test fun theDeckAnswersOnlyFromMachinesReadThisSession() {
        val partial = linkedMachines(slowGit = false)
        val cached = Teams.build(mapOf("h1" to linkedMachines(slowGit = true)), 2_000L)
        val read = Teams.read(mapOf("h1" to partial), 2_000L)
        val shown = Teams.merge(Teams.live(mapOf("h1" to partial), read, 2_000L), cached, read, setOf("h1"))
        // slow's request is in the cache, but slow isn't read: it can't be answered, and it has no terminal to open.
        val deck = Teams.deck(shown).map { it.second.id }
        assertTrue("b-slow" !in deck)
        assertTrue("b-fast" in deck)
        assertNull(shown.single { it.machine == "slow" }.bots.single { it.id == "b-slow" }.ref)
        // Every card is one a read machine's live terminal answers.
        assertTrue(Teams.deck(shown).all { (t, b) -> Teams.scope(t.hostId, t.machine) in read && b.ref != null })
    }

    @Test fun aBotsPaneMustBeInItsProject() {
        val m = machine()
        // b-aaaaaaaaaa's pane moved into the Site space: no longer the example project's pane, and not labelled there.
        val moved = m.copy(spaces = listOf(m.spaces[0].copy(tabs = listOf(PocketTab("a", "Main", listOf("t3", "t5")))), m.spaces[1],
            m.spaces[2].copy(tabs = listOf(PocketTab("c", "Shell", listOf("t4", "t1"))))),
            terminals = m.terminals.map { if (it.address == "t1") it.copy(cwd = "/work/site") else it },
            git = m.git + (Sidebar.gitKey("", "/work/site") to GitInfo("main", 0, 0, "/work/site", "/work/site/.git")))
        val teams = Teams.build("h1", moved, 10_000L)
        val lead = teams[0].bots.single { it.id == "b-aaaaaaaaaa" }
        assertEquals(Teams.ASLEEP, lead.pose)
        assertNull(lead.ref)
        // A pane outside the spaces whose folder is in the project's repository is still its bot's.
        val outside = m.copy(spaces = listOf(m.spaces[0].copy(tabs = listOf(PocketTab("a", "Main", listOf("t3", "t5")))), m.spaces[1], m.spaces[2]))
        assertEquals(TerminalRef("h1", "t1"), Teams.build("h1", outside, 10_000L)[0].bots.single { it.id == "b-aaaaaaaaaa" }.ref)
    }

    // ---- answers

    @Test fun onlyAnAnswerThatReachedTheAgentCountsAsSent() {
        for (outcome in listOf("Not sent: Machine isn’t connected. Open Automagik to reconnect.", "Not confirmed: check the agent before trying again.",
                "Not sent: its options changed. Open the agent to answer.")) assertTrue(outcome, !Teams.sent(outcome))
        assertTrue(Teams.sent("You chose: Yes"))
    }

    // ---- Team: one bubble per project

    /** A bots-dsh row for `dsh:<id>`; [registryId] as given (JSONObject.NULL: null), else none. */
    private fun dshRow(
        id: String, status: String = "working", shown: Boolean? = null, registryId: Any? = null,
    ) = Chat.Terminal.parse(JSONObject()
        .put("terminal", "dsh:$id").put("machine", JSONObject.NULL).put("agent", "dsh")
        .put("title", "Lead").put("status", JSONObject().put("state", status))
        .put("chat", "session")
        .apply {
            if (shown != null) put("shown", shown)
            if (registryId != null) put("registryId", registryId)
        })

    private val pane = Teams.Opens.TerminalChat(TerminalRef("h1", "t1"))
    private fun opensOn(host: String, vararg rows: Chat.Terminal) =
        Teams.bubbles(Teams.build(mapOf("h1" to machine()), 10_000L), mapOf(host to rows.toList()))

    @Test fun aRegistryIdMatchWinsAndTheTapKeepsTheSessionId() {
        // bots-dsh lists main bot b-aaaaaaaaaa under its Session id, its registry id beside (#684).
        val row = dshRow("session-1", status = "blocked", registryId = "b-aaaaaaaaaa")
        assertEquals("b-aaaaaaaaaa", row.registryId)
        val b = opensOn("h1", row)[0]
        assertEquals("b-aaaaaaaaaa", b.main?.id)
        assertEquals(Teams.Opens.DshChat(TerminalRef("h1", "dsh:session-1")), b.opens)
        // A row that served no id but is dsh:<id> itself loses to the registry id match.
        val both = opensOn("h1", dshRow("b-aaaaaaaaaa"), row)[0].opens
        assertEquals(Teams.Opens.DshChat(TerminalRef("h1", "dsh:session-1")), both)
        // A served id is the answer: a dsh:<id> row serving another bot's id is not this bot's.
        val other = dshRow("b-aaaaaaaaaa", registryId = "b-nnnnnnnnnn")
        assertEquals(pane, opensOn("h1", other)[0].opens)
    }

    @Test fun aNullOrMissingRegistryIdKeepsTodaysMatchAndTerminalFallback() {
        for (rid in listOf(null, JSONObject.NULL, "", 7)) {
            // Absent, null, blank or not a string: no registry id, never an error.
            assertNull(dshRow("session-1", registryId = rid).registryId)
            // A Session id chat with none opens the main bot's terminal chat, as before #672.
            assertEquals(pane, opensOn("h1", dshRow("session-1", registryId = rid))[0].opens)
            // A dsh:<registry id> row with none still matches by its id.
            val same = opensOn("h1", dshRow("b-aaaaaaaaaa", registryId = rid))[0].opens
            assertEquals(Teams.Opens.DshChat(TerminalRef("h1", "dsh:b-aaaaaaaaaa")), same)
        }
    }

    @Test fun aRegistryIdChatListedNotShownStaysUnclickable() {
        val row = dshRow("session-1", shown = false, registryId = "b-aaaaaaaaaa")
        val hidden = opensOn("h1", row)[0]
        assertEquals(Teams.Opens.NotShown, hidden.opens)
        assertEquals(Teams.NOT_SHOWN, Teams.lineOf(hidden))
    }

    @Test fun aRegistryIdOfAnotherMachineOrNoMainBotMakesNoMatchAndNoBubble() {
        // The same registry id listed by another machine's bots-dsh is not this project's bot.
        assertEquals(pane, opensOn("h2", dshRow("session-1", registryId = "b-aaaaaaaaaa"))[0].opens)
        // An id no registry lists as a main bot is no bubble; the main bot keeps its pane.
        val unknown = opensOn("h1", dshRow("session-2", registryId = "b-zzzzzzzzzz"))
        assertEquals(listOf("h1||/work/example", "h1||/work/site"), unknown.map { it.id })
        assertTrue(unknown.none { it.main?.id == "b-zzzzzzzzzz" })
        assertEquals(pane, unknown[0].opens)
        assertNull(unknown[1].opens)
    }

    @Test fun aDshChatAndAHerdrPaneOfOneRegistryIdAreOneBubble() {
        val teams = Teams.build(mapOf("h1" to machine()), 10_000L)
        // The main bot b-aaaaaaaaaa has a labelled pane (t1) and a dsh: chat under the same id: one bubble, the chat's.
        val bubbles = Teams.bubbles(teams, mapOf("h1" to listOf(dshRow("b-aaaaaaaaaa"), dshRow("b-zzzzzzzzzz"))))
        assertEquals(listOf("h1||/work/example", "h1||/work/site"), bubbles.map { it.id })
        val example = bubbles[0]
        assertEquals("b-aaaaaaaaaa", example.main?.id)
        assertEquals("Lead", example.main?.name)
        assertEquals("kitty-blue", example.main?.pet)
        assertEquals(Teams.Opens.DshChat(TerminalRef("h1", "dsh:b-aaaaaaaaaa")), example.opens)
        // A dsh: chat no registry lists as a main bot is no bubble of its own.
        assertEquals(1, bubbles.count { it.main?.id == "b-aaaaaaaaaa" })
        assertTrue(bubbles.none { it.main?.id == "b-zzzzzzzzzz" })
        // Without the chat, the same main bot opens its pane's projected chat.
        assertEquals(Teams.Opens.TerminalChat(TerminalRef("h1", "t1")), Teams.bubbles(teams, emptyMap())[0].opens)
        // A chat of another machine is not this bot's.
        assertEquals(Teams.Opens.TerminalChat(TerminalRef("h1", "t1")), Teams.bubbles(teams, mapOf("h2" to listOf(dshRow("b-aaaaaaaaaa"))))[0].opens)
    }

    @Test fun twoSpacesOfOneRepoAreOneBubble() {
        // s1 (/work/example) and s2 (/work/example-wt) share one git dir: one project, one bubble.
        val bubbles = Teams.bubbles(Teams.build(mapOf("h1" to machine()), 10_000L), emptyMap())
        assertEquals(2, bubbles.size)
        assertEquals(1, bubbles.count { it.team.key == "/work/example" })
        assertEquals("Example", bubbles[0].team.name)
    }

    @Test fun aProjectWithoutAMainBotSaysSoInTheDesktopsWords() {
        val site = Teams.bubbles(Teams.build(mapOf("h1" to machine()), 10_000L), emptyMap())[1]
        assertNull(site.main)
        assertNull(site.opens)
        assertEquals("No main bot in this project", Teams.lineOf(site))
        // A project whose bots are all members has no main bot either.
        val members = Teams.bubbles(listOf(team("m", Teams.WORKING, Teams.NEEDS_YOU)), emptyMap()).single()
        assertNull(members.main)
        assertEquals(Teams.NO_MAIN, Teams.lineOf(members))
    }

    @Test fun aChatListedNotShownOpensNothingAndAskForTheYes() {
        val teams = Teams.build(mapOf("h1" to machine()), 10_000L)
        val hidden = Teams.bubbles(teams, mapOf("h1" to listOf(dshRow("b-aaaaaaaaaa", shown = false))))[0]
        assertEquals(Teams.Opens.NotShown, hidden.opens)
        assertEquals("Show in Automagik first", Teams.lineOf(hidden))
        // A row with no shown field (today's bots-dsh, which serves every Bot) is shown.
        assertEquals(true, dshRow("b-aaaaaaaaaa").shown)
        assertEquals(Teams.Opens.DshChat(TerminalRef("h1", "dsh:b-aaaaaaaaaa")), Teams.bubbles(teams, mapOf("h1" to listOf(dshRow("b-aaaaaaaaaa", shown = true))))[0].opens)
    }

    @Test fun aDshOnlyMainBotTakesItsPoseFromTheChatAndAStaleProjectOpensNothing() {
        val lead = Teams.Bot("b-main", "Lead", true, null, Teams.ASLEEP, "", 0L, null, "")
        val t = Teams.Team("h|x", "h", "", "/w", "W", Teams.Icon.Letter, null, listOf(lead))
        val b = Teams.bubbles(listOf(t), mapOf("h" to listOf(dshRow("b-main", status = "blocked")))).single()
        assertEquals(Teams.NEEDS_YOU, b.main?.pose)
        assertTrue(b.needsYou)
        assertEquals(Teams.Opens.DshChat(TerminalRef("h", "dsh:b-main")), b.opens)
        assertNull(Teams.bubbles(listOf(t.copy(stale = true)), mapOf("h" to listOf(dshRow("b-main")))).single().opens)
    }

    @Test fun aBubbleShowsMarkupAsText() {
        val raw = "<img src=x onerror=alert(1)> <script>alert(1)</script>"
        val lead = Teams.Bot("b-main", "Lead", true, null, Teams.WORKING, raw, 1L, TerminalRef("h", "t1"), "")
        val b = Teams.bubbles(listOf(Teams.Team("h|x", "h", "", "/w", "W", Teams.Icon.Letter, null, listOf(lead))), emptyMap()).single()
        assertEquals(raw, Teams.lineOf(b))
        // The chat it opens shows the same text as prose, tags and all (RFC 0015 :254-255).
        val blocks = ChatText.blocks(raw)
        assertEquals(listOf(ChatText.Prose(listOf(ChatText.Plain(raw)))), blocks)
    }

    @Test fun rowsRoundTripTheModel() {
        val teams = Teams.build(mapOf("h1" to machine()), 10_000L).map { it.copy(merged = 3.0) }
        val (t, b) = TeamsCache.rows(teams)
        assertEquals(teams, TeamsCache.teams(t.reversed(), b.reversed()))
    }

    @Test fun rowTimesReadLikeAChatList() {
        val zone = ZoneOffset.UTC
        val now = java.time.Instant.parse("2026-11-03T15:00:00Z").toEpochMilli()
        assertEquals("", Teams.time(0, now, zone))
        assertEquals("14:05", Teams.time(java.time.Instant.parse("2026-11-03T14:05:00Z").toEpochMilli(), now, zone))
        assertEquals("Yesterday", Teams.time(java.time.Instant.parse("2026-11-02T23:59:00Z").toEpochMilli(), now, zone))
        assertEquals("2026-11-03", Teams.day(now, zone))
    }

    /**
     * Rows "a Main Bot's Team bubble opens its DSH chat" and Home's needs-you rows (#731, RFC 0015 D29): the main
     * bot's pane maps to the chat its bubble opens, so Home opens the same chat. No chat, a chat not shown or a
     * DSH-only bot (no pane) leaves Home's rows on their terminals.
     */
    @Test fun aMainBotsPaneOnHomeOpensTheSameDshChatAsItsBubble() {
        val chat = TerminalRef("h1", "dsh:session-1")
        val bubbles = opensOn("h1", dshRow("session-1", status = "blocked", registryId = "b-aaaaaaaaaa"))
        assertEquals(Teams.Opens.DshChat(chat), bubbles[0].opens)
        assertEquals(mapOf(TerminalRef("h1", "t1") to chat), Teams.paneChats(bubbles))
        assertEquals(emptyMap<TerminalRef, TerminalRef>(), Teams.paneChats(opensOn("h1")))
        assertEquals(emptyMap<TerminalRef, TerminalRef>(),
            Teams.paneChats(opensOn("h1", dshRow("session-1", shown = false, registryId = "b-aaaaaaaaaa"))))
        val lead = Teams.Bot("b-main", "Lead", true, null, Teams.ASLEEP, "", 0L, null, "")
        val dshOnly = Teams.bubbles(listOf(Teams.Team("h|x", "h", "", "/w", "W", Teams.Icon.Letter, null, listOf(lead))),
            mapOf("h" to listOf(dshRow("b-main", status = "blocked"))))
        assertEquals(emptyMap<TerminalRef, TerminalRef>(), Teams.paneChats(dshOnly))
    }

    // ---- Home's needs-you deck

    private fun deckEntry(address: String, turn: Long = 1, statusMs: Long = 10, kind: String = "permission",
                          title: String = "Integrator", message: String = "Run 2 commands?", app: String = "claude-code") =
        Cockpit.Entry(TerminalRef("h", address),
            CoreTerminal(address, title, "/w", "live", "blocked", if (app == "dsh") "Automagik Bot" else app, message, 80, 24,
                app = app, statusMs = statusMs, turn = turn, kind = kind), Cockpit.BLOCKED)

    @Test fun theDeckCardsComeFromHomesNeedsYouEntriesInTheirOrder() {
        val first = deckEntry("t1", turn = 1, statusMs = 100)
        val second = deckEntry("t2", turn = 2, statusMs = 200, title = "Builder", message = "May I push?")
        val cards = Teams.deckCards(listOf(second, first)) { "brain-v3" }
        assertEquals(listOf("t2", "t1"), cards.map { it.ref.address })
        assertEquals(listOf("Builder", "Integrator"), cards.map { it.title })
        assertEquals(listOf("May I push?", "Run 2 commands?"), cards.map { it.message })
        assertEquals(listOf("brain-v3", "brain-v3"), cards.map { it.where })
        assertEquals(listOf("2:200", "1:100"), cards.map { it.turn to it.statusMs }.map { "${it.first}:${it.second}" })
        assertTrue(cards.none { it.opensChat })
    }

    @Test fun aChatCardAndAPaneRaisedToItsChatOpenTheChat() {
        val chat = TerminalRef("h", "dsh:s1")
        val lone = Teams.deckCards(listOf(deckEntry("dsh:s1", kind = "question", title = "Lead", message = "Which branch?", app = "dsh"))) { "Home" }
        assertEquals(chat, lone.single().chat)
        assertTrue(lone.single().opensChat)
        // A pane row whose chat is the more urgent keeps the pane ref but opens the chat ([Cockpit.Raised.fromChat]).
        val pane = deckEntry("t1", kind = "question", title = "Lead", message = "Which branch?")
        val raised = Teams.deckCards(listOf(pane), mapOf(TerminalRef("h", "t1") to chat)) { "Home" }
        assertEquals(TerminalRef("h", "t1"), raised.single().ref)
        assertEquals(chat, raised.single().chat)
        // Every other row still answers its own terminal.
        assertNull(Teams.deckCards(listOf(pane)).single().chat)
    }

    @Test fun onlyAnsweredCardsLeaveAndDisconnectIsOfflineNotAllClear() {
        val one = Teams.deckCards(listOf(deckEntry("t1", turn = 1, statusMs = 100))) { "P" }.single()
        val two = Teams.deckCards(listOf(deckEntry("t2", turn = 2, statusMs = 200))) { "P" }.single()
        val cards = listOf(two, one)
        assertEquals(Teams.DeckView.Cards(cards), Teams.deckView(cards, emptySet(), anyConnected = true, waiting = 2))
        assertEquals(Teams.DeckView.Cards(listOf(two)), Teams.deckView(cards, setOf(Teams.deckKey(one)), anyConnected = true, waiting = 1))
        // A new request from the same agent (a later turn) is another card.
        val later = one.copy(turn = 3, statusMs = 300)
        assertEquals(Teams.DeckView.Cards(listOf(later)), Teams.deckView(listOf(later), setOf(Teams.deckKey(one)), anyConnected = true, waiting = 1))
        assertEquals(Teams.DeckView.Clear, Teams.deckView(cards, setOf(Teams.deckKey(one), Teams.deckKey(two)), anyConnected = true, waiting = 0))
        // The link dropped with unanswered requests: offline, never a false all clear.
        assertEquals(Teams.DeckView.Offline(2), Teams.deckView(emptyList(), emptySet(), anyConnected = false, waiting = 2))
        assertEquals(Teams.DeckView.Clear, Teams.deckView(emptyList(), emptySet(), anyConnected = false, waiting = 0))
        // A machine dropped while another is still connected: its waiting cards are offline, not all clear.
        assertEquals(Teams.DeckView.Offline(1), Teams.deckView(emptyList(), emptySet(), anyConnected = true, waiting = 0, offline = 1))
        assertEquals(Teams.DeckView.Clear, Teams.deckView(emptyList(), emptySet(), anyConnected = true, waiting = 0, offline = 0))
    }

    @Test fun everyChatCardIsSkippedAndItsHomeRowSaysWhereToAnswer() {
        val chat = Teams.DeckCard(TerminalRef("h", "dsh:reader"), "Reader", "herdr", "Automagik Bot",
            Chat.ANSWER_ON_COMPUTER, "question", 1, 2, TerminalRef("h", "dsh:reader"))
        val writable = chat.copy(message = "Which branch?")
        val terminal = chat.copy(ref = TerminalRef("h", "t1"), chat = null, message = "Run?")
        assertTrue(!Teams.deckAnswerable(chat))
        assertTrue(!Teams.deckAnswerable(writable))
        assertTrue(Teams.deckAnswerable(terminal))
        assertEquals(listOf(terminal), listOf(chat, writable, terminal).filter(Teams::deckAnswerable))
        assertEquals("On computer", Teams.chatWaitLabel(deckEntry("dsh:reader", kind = "question").terminal.copy(message = Chat.ANSWER_ON_COMPUTER)))
        assertEquals("In chat", Teams.chatWaitLabel(deckEntry("dsh:reader", kind = "question").terminal.copy(message = "Which branch?")))
    }

    @Test fun theMergedSampleDeckWalksFromFirstCardToAllClear() {
        fun chat(id: String, message: String) = Teams.DeckCard(TerminalRef("h", "dsh:$id"), id, "herdr", "Automagik Bot",
            message, "question", 1, 2, TerminalRef("h", "dsh:$id"))
        fun terminal(address: String) = Teams.DeckCard(TerminalRef("h", address), address, "herdr", "Claude Code",
            "Run?", "permission", 3, 1, null)
        val sample = listOf(chat("reader", Chat.ANSWER_ON_COMPUTER), chat("captain", "Which branch?"),
            terminal("t1"), terminal("t8"), terminal("t9"))
        val deck = sample.filter(Teams::deckAnswerable)
        assertEquals(listOf("t1", "t8", "t9"), deck.map { it.ref.address })
        var answered = emptySet<String>()
        while (true) {
            val view = Teams.deckView(deck, answered, anyConnected = true, waiting = deck.size - answered.size)
            if (view is Teams.DeckView.Clear) break
            val card = (view as Teams.DeckView.Cards).cards.first()
            answered = answered + Teams.deckKey(card)
        }
        assertEquals(3, answered.size)
    }

    @Test fun aLeavingCardKeepsItsMenu() {
        val menu = Prompt.Menu(listOf("1. Yes", "2. No"), 0, "Run?")
        val next = menu.copy(cursor = 1)
        assertSame(menu, Teams.deckMenu(menu, null, sending = true))
        assertSame(menu, Teams.deckMenu(menu, next, sending = true))
        assertSame(next, Teams.deckMenu(menu, next, sending = false))
    }

    @Test fun theLeavingCardIsNotTheCardBehind() {
        val cards = Teams.deckCards(listOf(deckEntry("t1"), deckEntry("t2"), deckEntry("t3"))) { "P" }
        val under = Teams.deckUnder(cards, Teams.deckKey(cards[0]))
        assertEquals(cards[1], under.next)
        assertEquals(2, under.behind)
        val normal = Teams.deckUnder(cards.drop(1), null)
        assertEquals(cards[2], normal.next)
        assertEquals(1, normal.behind)
    }

    @Test fun anAnswerIsRecordedWhenTheCardMotionIsCancelled() {
        // Close, Back and Open all dispose the card's scope during the confirm window.
        for (reason in listOf("Close", "Back", "Open")) {
            val recorded = mutableListOf<String>()
            var done: ((Boolean) -> Unit)? = null
            val scope = CoroutineScope(Job())
            DeckSend(scope, record = { recorded += it }, finish = { _ -> }, returnMotion = {}).send("k",
                dispatch = { done = it }, exit = {})
            scope.cancel()
            done!!.invoke(true)
            assertEquals(reason, listOf("k"), recorded)
        }
    }

    @Test fun theSampleDeckDoesNotShowAllClearWhileChatsWait() {
        fun chat(id: String, message: String) = Teams.DeckCard(TerminalRef("h", "dsh:$id"), id, "herdr", "Automagik Bot",
            message, "question", 1, 2, TerminalRef("h", "dsh:$id"))
        fun terminal(address: String) = Teams.DeckCard(TerminalRef("h", address), address, "herdr", "Claude Code",
            "Run?", "permission", 3, 1, null)
        val sample = listOf(chat("reader", Chat.ANSWER_ON_COMPUTER), chat("captain", "Which branch?"),
            terminal("t1"), terminal("t8"), terminal("t9"))
        val terminals = sample.filter(Teams::deckAnswerable)
        val chats = sample.filter { it.chat != null }
        var answered = emptySet<String>()
        var view = Teams.deckView(terminals, answered, anyConnected = true, waiting = terminals.size, chats = chats)
        while (view is Teams.DeckView.Cards) {
            val card = view.cards.first()
            answered = answered + Teams.deckKey(card)
            view = Teams.deckView(terminals, answered, anyConnected = true, waiting = terminals.size - answered.size, chats = chats)
        }
        // Only Bot-chat requests are left; the count is above zero, so this is never Clear.
        assertTrue(view is Teams.DeckView.Chats)
        val waiting = (view as Teams.DeckView.Chats).cards
        assertEquals(chats, waiting)
        assertEquals(chats.map { it.ref }, waiting.map { it.ref })
        assertTrue(Teams.deckView(emptyList(), emptySet(), anyConnected = true, waiting = chats.size, chats = chats) is Teams.DeckView.Chats)
        // A chat request answered in its chat is no longer in Home's list, so the deck drops it.
        val remaining = Teams.deckChats(sample - chats[0])
        assertEquals(chats.drop(1), remaining)
        assertEquals(remaining, (Teams.deckView(emptyList(), emptySet(), anyConnected = true, waiting = remaining.size, chats = remaining) as Teams.DeckView.Chats).cards)
        assertEquals(3, answered.size)
    }

    @Test fun eachPreviewRequestShowsItsOwnCommand() {
        fun sample(address: String, message: String) =
            CoreTerminal(address, "x", "/w", "live", "blocked", "Claude Code", message, 80, 24, kind = "permission")
        assertTrue("npm test" in previewMenu(sample("t1", "Run the test suite?")))
        val second = previewMenu(sample("t8", "Run the lint check?"))
        assertTrue("npm run lint" in second)
        assertTrue("npm test" !in second)
        val third = previewMenu(sample("t9", "Approve the sample deploy?"))
        assertTrue("./deploy.sh" in third)
        assertTrue("npm test" !in third)
    }

    @Test fun backFromADeckOpenedCardReturnsToTheDeckAndAnExternalSelectionClosesIt() {
        val card = TerminalRef("h", "t1")
        assertEquals(true to true, Teams.deckAfterSelection(open = true, fromDeck = true, selected = card))
        assertEquals(true to false, Teams.deckAfterSelection(open = true, fromDeck = true, selected = null))
        assertEquals(false to false, Teams.deckAfterSelection(open = true, fromDeck = false, selected = card))
        assertEquals(true to false, Teams.deckAfterSelection(open = true, fromDeck = false, selected = null))
        // A closed deck stays closed when a card opens from anywhere.
        assertEquals(false to false, Teams.deckAfterSelection(open = false, fromDeck = false, selected = card))
    }

    @Test fun aSwipeFollowsTheAxisItMovedMostAlong() {
        val t = 100f
        assertEquals(Teams.Swipe.OPEN, Teams.swipe(dx = 120f, dy = -200f, t, canYes = true, canNo = true))   // diagonal, mostly up
        assertEquals(Teams.Swipe.YES, Teams.swipe(dx = 200f, dy = -120f, t, canYes = true, canNo = true))   // diagonal, mostly right
        assertEquals(Teams.Swipe.NO, Teams.swipe(dx = -150f, dy = 0f, t, canYes = true, canNo = true))
        assertEquals(Teams.Swipe.NONE, Teams.swipe(dx = 150f, dy = 0f, t, canYes = false, canNo = true))   // no Yes to send
        assertEquals(Teams.Swipe.NONE, Teams.swipe(dx = 60f, dy = -80f, t, canYes = true, canNo = true))    // too short
    }
}
