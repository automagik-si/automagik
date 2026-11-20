package ai.namastex.automagik

import ai.namastex.automagik.ChatSettings.Op
import ai.namastex.automagik.ChatSettings.Phase
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

internal const val SETTINGS_BOT = "dsh:b-fixture"
internal const val SETTINGS_REV = "0123456789abcdef"
internal const val SETTINGS_NEXT_REV = "0123456789abcde0"
internal const val SETTINGS_NAME = "Fixture Bot"
internal const val SETTINGS_MODEL = "example/one"
internal const val SETTINGS_OTHER_MODEL = "example/two"

internal fun settingsChoice(id: String = SETTINGS_MODEL, label: String = "Fixture Model One") =
    JSONObject().put("id", id).put("label", label).put("provider", "Fixture Provider")

internal fun settingsReply(state: String = "read", reason: String? = null, terminal: String = SETTINGS_BOT,
                           rev: String = SETTINGS_REV, name: String = SETTINGS_NAME, saved: String? = SETTINGS_MODEL,
                           label: String? = "Fixture Model One", auto: Boolean = true, canName: Boolean = true,
                           canModel: Boolean = true, editableReason: String? = null,
                           entries: List<Any> = listOf(settingsChoice(), settingsChoice(SETTINGS_OTHER_MODEL, "Fixture Model Two")),
                           truncated: Boolean = false): JSONObject {
    val model = JSONObject().put("saved", saved ?: JSONObject.NULL).put("label", label ?: JSONObject.NULL)
        .put("applied", saved ?: JSONObject.NULL).put("running", saved ?: JSONObject.NULL)
        .put("effort", "fixture-effort").put("runningEffort", JSONObject.NULL)
    val level = JSONObject().put("saved", "workspace-write").put("inherited", false).put("auto", auto)
    val editable = JSONObject().put("name", canName).put("model", canModel).apply {
        if (editableReason != null) put("reason", editableReason)
    }
    val settings = JSONObject().put("terminal", terminal).put("rev", rev).put("name", name)
        .put("model", model).put("level", level).put("editable", editable)
    return JSONObject().put("ok", state in setOf("read", "saved", "unchanged")).put("state", state)
        .put("settings", settings).put("models", JSONObject().put("entries", JSONArray(entries)).put("truncated", truncated))
        .apply { if (reason != null) put("reason", reason) }
}

internal fun settingsRefusal(reason: String, applied: Boolean = false) =
    JSONObject().put("ok", false).put("state", "refused").put("reason", reason).apply {
        if (applied) put("applied", true)
    }

class ChatSettingsTest {
    private val initial = ChatSettings.State("fixture-host", SETTINGS_BOT, 1, phase = Phase.LOADING,
        op = Op.READ, grants = ChatClient.SETTINGS.toSet())
    private val ready get() = ChatSettings.afterRead(initial, settingsReply())
    private fun writing(op: Op = Op.MODEL) = ready.copy(op = op)

    @Test fun parsesTheBoundSnapshotAndCapsWellFormedModelChoices() {
        val reply = settingsReply(entries = listOf(JSONObject.NULL, settingsChoice("bare-id"),
            settingsChoice().put("provider", 5), settingsChoice(label = "a".repeat(201))) +
            List(201) { settingsChoice("example/$it") })
        reply.getJSONObject("settings").getJSONObject("level").put("saved", "fixture-unrecognized-level")
        val parsed = checkNotNull(ChatSettings.parse(reply, SETTINGS_BOT))
        assertEquals(SETTINGS_NAME, parsed.settings.name)
        assertEquals(SETTINGS_REV, parsed.settings.rev)
        assertEquals(ChatSettings.Model(SETTINGS_MODEL, "Fixture Model One", SETTINGS_MODEL, SETTINGS_MODEL, "fixture-effort", null),
            parsed.settings.model)
        assertEquals("custom", parsed.settings.level.saved)
        assertEquals(List(200) { "example/$it" }, parsed.models.entries.map { it.id })
        assertTrue(parsed.models.truncated)

        val bad = listOf(settingsReply(terminal = "dsh:b-other"), settingsReply(rev = "0123456789ABCDEF"),
            settingsReply(rev = "abcdef"), settingsReply().apply { remove("models") },
            settingsReply().apply { getJSONObject("models").put("truncated", "true") },
            settingsReply().apply { getJSONObject("settings").getJSONObject("model").put("runningEffort", 0) },
            settingsReply().apply { getJSONObject("settings").getJSONObject("editable").put("model", "true") })
        for (invalid in bad) assertNull(ChatSettings.parse(invalid, SETTINGS_BOT))
    }

    @Test fun recognizesLevelLabelsAndTrimsNamesWithJavaScriptWhitespaceAndUtf16Length() {
        val level = checkNotNull(ready.snapshot).settings.level
        val labels = mapOf(null to "Unknown", "read-only" to "Read only", "workspace-write" to "Workspace",
            "danger-full-access" to "Full access", "auto" to "Auto review", "custom" to "Custom")
        for ((saved, label) in labels) assertEquals(label, ChatSettings.levelLines(level.copy(saved = saved)).first())
        assertEquals(listOf("Auto review · the computer's default", "Auto is on", "Runs as Workspace here",
            "This level is no longer offered on the computer.", "Runs as Read only now"),
            ChatSettings.levelLines(level.copy(saved = "auto", inherited = true, fallback = "workspace-write",
                notOffered = true, runs = "read-only")))
        assertEquals(listOf("Workspace", "Auto is on"), ChatSettings.levelLines(level.copy(runs = "workspace-write")))
        assertEquals("Fixture", ChatSettings.trimName("\uFEFF\u00A0Fixture\u2000\u2029"))
        assertEquals("\u0085Fixture\u001C", ChatSettings.trimName("\u0085Fixture\u001C"))
        assertNotNull(ChatSettings.checkName("\uFEFF\n"))
        assertNull(ChatSettings.checkName(" " + "a".repeat(38) + "😀" + "\u3000"))
        assertNotNull(ChatSettings.checkName("a".repeat(39) + "😀"))
    }

    @Test fun everySettingsBearingWriteReplacesTheSnapshotAndCatalogWithoutReading() {
        val refused = "refused"
        val cases = listOf(
            Triple("saved", null, "Saved."),
            Triple("unchanged", null, "No change."),
            Triple(refused, "stale", "That changed on the computer. Here is the current version."),
            Triple(refused, "computer", "Its plugin chooses its model on the computer."),
            Triple(refused, "changing", "Its model is changing on the computer."),
            Triple(refused, "invalid", "Fixture name rule"),
            Triple(refused, "unknown-model", "The computer doesn't have that model."),
            Triple(refused, "model-not-allowed", "This Bot can't use that model from the phone."),
            Triple(refused, "not-applied", "The computer could not switch the Bot to that model, so it stays on its current one."),
            Triple("unknown", "pending", "The computer may not have saved this yet. Check it on the computer."))
        for ((state, reason, line) in cases) {
            val reply = settingsReply(state, reason, rev = SETTINGS_NEXT_REV, name = "Fixture Renamed",
                saved = "other/replacement", auto = false, editableReason = "host-model",
                entries = listOf(settingsChoice("other/replacement")), truncated = true).put("message", line)
            val updated = ChatSettings.afterWrite(writing(), reply)
            assertEquals(reason ?: state, Phase.READY, updated.phase)
            assertEquals(Op.NONE, updated.op)
            assertFalse(updated.uncertain)
            assertEquals(ChatSettings.parse(reply, SETTINGS_BOT), updated.snapshot)
            assertEquals(line, updated.outcome)
            assertTrue(updated.canEdit(Op.MODEL))
            assertEquals(state == "saved" || reason == "not-applied" || state == "unknown", updated.autoOff)
        }
        val rename = ChatSettings.afterWrite(writing(Op.NAME), settingsReply("saved", auto = false))
        assertFalse(rename.autoOff)
    }

    @Test fun definiteRefusalsKeepTheSnapshotAndOnlyUnansweredWritesReconcile() {
        val current = writing()
        assertNotNull(current.snapshot)
        val definite = listOf(
            CoreError("busy", "fixture transport detail") to "The computer is busy. Try again in a moment.",
            settingsRefusal("busy") to "The computer is busy. Try again in a moment.",
            settingsRefusal("rate") to "The computer is busy. Try again in a moment.",
            settingsRefusal("offline") to "The computer didn't answer. The change wasn't sent.",
            settingsRefusal("too-large") to "The settings are too large to show here.",
            settingsRefusal("invalid") to "The computer refused that request.")
        for ((reply, text) in definite) {
            val next = ChatSettings.afterWrite(current, reply)
            assertEquals(Phase.READY, next.phase)
            assertSame(current.snapshot, next.snapshot)
            assertEquals(text, next.outcome)
        }
        val missing = listOf(null, IllegalStateException("fixture timeout"),
            JSONObject().put("ok", false).put("state", "unknown").put("reason", "offline"),
            JSONObject().put("ok", false).put("state", "unknown").put("reason", "pending"),
            settingsReply("saved").apply { remove("models") }, settingsReply("saved", terminal = "dsh:b-other"))
        for (result in missing) {
            val next = ChatSettings.afterWrite(current, result)
            assertEquals(Phase.RECONCILING, next.phase)
            assertTrue(next.uncertain)
            assertFalse(next.canEdit(Op.MODEL))
            val failed = ChatSettings.afterRead(next, settingsRefusal("busy"))
            assertEquals(Phase.READ_FAILED, failed.phase)
            assertTrue(failed.canRefresh)
            assertFalse(failed.canEdit(Op.NAME))
            val checked = ChatSettings.afterRead(failed, settingsReply(rev = SETTINGS_NEXT_REV))
            assertTrue(checked.canEdit(Op.NAME))
            assertEquals(SETTINGS_NEXT_REV, checked.snapshot?.settings?.rev)
        }
    }

    @Test fun authorityLossDiscardsTheSnapshotGrantsAndHostTextEvenWhenApplied() {
        val current = writing().copy(outcome = "Fixture host text", autoOff = true)
        assertNotNull(current.snapshot?.settings?.level)
        assertFalse(checkNotNull(current.snapshot).models.entries.isEmpty())
        for (reason in listOf("revoked", "not-found", "not-shown", "global", "unavailable", "read-only")) {
            val reply = settingsRefusal(reason, applied = true).put("message", "Fixture host text")
            for (closed in listOf(ChatSettings.afterRead(current, reply), ChatSettings.afterWrite(current, reply))) {
                assertEquals(Phase.CLOSED, closed.phase)
                assertNull(closed.snapshot)
                assertTrue(closed.grants.isEmpty())
                assertFalse(closed.autoOff)
                assertEquals(ChatSettings.MAY_HAVE_CHANGED, closed.outcome)
                assertFalse(closed.canRefresh)
                assertFalse(closed.toString().contains("Fixture host text"))
            }
        }
        assertEquals("Settings for global Bots stay on the computer.",
            ChatSettings.afterWrite(current, settingsRefusal("global")).status)
    }

    @Test fun modelAndNameHaveIndependentGrantsAndUseTheLatestCatalogEvenFromNoModel() {
        assertTrue(ready.canEdit(Op.NAME) && ready.canEdit(Op.MODEL))
        val nameOnly = ready.copy(grants = setOf(Op.READ.method, Op.NAME.method))
        assertTrue(nameOnly.canEdit(Op.NAME))
        assertFalse(nameOnly.canEdit(Op.MODEL))
        assertFalse(ready.copy(grants = setOf(Op.NAME.method)).canEdit(Op.NAME))
        val empty = ChatSettings.afterRead(initial, settingsReply(entries = emptyList()))
        assertTrue(empty.canEdit(Op.NAME))
        assertFalse(empty.canEdit(Op.MODEL))
        val noModel = ChatSettings.afterRead(initial, settingsReply(saved = null, label = null))
        assertNull(noModel.snapshot?.settings?.model?.saved)
        assertTrue(noModel.canEdit(Op.MODEL))
        val newCatalog = ChatSettings.afterWrite(noModel.copy(op = Op.MODEL), settingsReply("saved",
            saved = "other/new", entries = listOf(settingsChoice("other/new"))))
        assertTrue(newCatalog.canEdit(Op.MODEL))
        assertEquals("other/new", newCatalog.snapshot?.models?.entries?.single()?.id)
    }

    @Test fun settingsSourcesKeepContentInMemoryWithoutLogsOrSavedState() {
        val dir = File("src/main/java/ai/namastex/automagik")
        val vm = File(dir, "PocketViewModel.kt").readText()
        val from = vm.indexOf("private val _settings =")
        val to = vm.indexOf("fun startTerminal(")
        assertTrue(from in 0 until to)
        val sources = listOf("ChatSettings.kt", "ChatSettingsScreen.kt").associateWith { File(dir, it).readText() } +
            ("PocketViewModel settings" to vm.substring(from, to))
        val banned = Regex("""\b(?:Log|println|SharedPreferences|DataStore|File|FileOutputStream|FileWriter|rememberSaveable)\b|\b(?:getSharedPreferences|openFileOutput|filesDir|dataStore)\b""")
        for ((source, code) in sources) assertFalse(source, banned.containsMatchIn(code))
    }
}
