package ai.namastex.automagik

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * The preview's usage meter: two synthetic `herdr-meter` docs (schema 2) for the demo's repositories, written relative
 * to now so Today always has hours to show. Made-up numbers, no real machine: the preview machine reports fresh, a
 * second one ("build-box") last reported three hours ago, and one model has no price.
 */
object SpendDemo {
    private const val HOUR = 3_600_000L
    private fun t(input: Long, cr: Long, cw: Long, out: Long, usd: Double?, unpriced: Long = 0) = JSONObject().apply {
        put("in", input); put("cr", cr); put("cw", cw); put("out", out)
        if (usd != null) put("usd", usd)
        if (unpriced > 0) put("unpriced", unpriced)
    }
    private fun windows(o: JSONObject, d1: JSONObject?, d7: JSONObject, d30: JSONObject) = o.apply {
        d1?.let { put("d1", it) }; put("d7", d7); put("d30", d30)
    }
    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

    /** One doc. [scale] sizes the numbers, [ageMs] how long ago it was written. */
    fun doc(machine: String, now: Long, ageMs: Long, scale: Double, withUnpriced: Boolean): JSONObject {
        val generated = now - ageMs
        val hour = generated - generated.mod(HOUR)
        fun s(v: Double) = Math.round(v * scale * 100) / 100.0
        fun n(v: Long) = (v * scale).toLong()
        val tasks = JSONArray()
            .put(windows(JSONObject().put("repo", "github.com/example/herdr").put("branch", "feat/auth-flow").put("agents", JSONArray().put("claude-code"))
                .put("first", iso(hour - 30 * HOUR)).put("last", iso(hour)).put("hours", 6),
                t(n(900), n(1_400_000), n(60_000), n(21_000), s(4.10)), t(n(2_100), n(3_900_000), n(160_000), n(52_000), s(11.30)),
                t(n(2_100), n(3_900_000), n(160_000), n(52_000), s(11.30))))
            .put(windows(JSONObject().put("repo", "github.com/example/herdr").put("branch", "feat/release-notes").put("agents", JSONArray().put("codex"))
                .put("first", iso(hour - 5 * HOUR)).put("last", iso(hour)).put("hours", 3),
                t(n(400), n(600_000), n(20_000), n(9_000), s(1.60)), t(n(400), n(600_000), n(20_000), n(9_000), s(1.60)),
                t(n(400), n(600_000), n(20_000), n(9_000), s(1.60))))
        if (withUnpriced) tasks.put(windows(JSONObject().put("repo", "github.com/example/herdr").put("branch", "fix/api-review")
            .put("agents", JSONArray().put("codex")).put("first", iso(hour - 2 * HOUR)).put("last", iso(hour - HOUR)).put("hours", 2),
            t(300, 410_000, 0, 7_000, null, 417_300), t(300, 410_000, 0, 7_000, null, 417_300), t(300, 410_000, 0, 7_000, null, 417_300)))
        val herdr = windows(JSONObject().put("repo", "github.com/example/herdr").put("tasks", tasks.length()).put("hours", 11).put("last", iso(hour)),
            t(n(1_700), n(2_400_000), n(90_000), n(38_000), s(6.90), if (withUnpriced) 417_300 else 0),
            t(n(3_400), n(5_600_000), n(210_000), n(78_000), s(15.40), if (withUnpriced) 417_300 else 0),
            t(n(9_800), n(14_500_000), n(540_000), n(190_000), s(38.20), if (withUnpriced) 417_300 else 0))
        val website = windows(JSONObject().put("repo", "github.com/example/website").put("tasks", 0).put("hours", 4).put("last", iso(hour - 2 * HOUR)),
            t(n(200), n(300_000), n(10_000), n(4_000), s(0.90)), t(n(900), n(1_100_000), n(40_000), n(16_000), s(3.40)),
            t(n(2_600), n(3_000_000), n(120_000), n(41_000), s(9.80)))
        website.put("untasked", website.getJSONObject("d30"))
        // 48 hours of $ for the hourly chart: quiet nights, a working day that peaks in the afternoon.
        val usd = JSONArray()
        val from = hour - 47 * HOUR
        for (i in 0 until 48) {
            val h = Instant.ofEpochMilli(from + i * HOUR).atZone(java.time.ZoneId.systemDefault()).hour
            usd.put(if (h in 8..20) s(0.15 + 0.6 * (1 - Math.abs(h - 14) / 7.0)) else 0.0)
        }
        return JSONObject().put("schema_version", 2).put("kind", "herdr-meter").put("meter_version", "0.0.0-preview")
            .put("generatedAt", iso(generated)).put("machine", machine).put("counted_from", iso(hour - 40 * 24 * HOUR))
            .put("complete", true).put("pending", JSONObject().put("bytes", 0).put("files", 0))
            .put("prices", JSONObject().put("date", "2026-10-06").put("source", "bundled"))
            .put("windows", JSONObject().put("d1", iso(hour - 23 * HOUR)).put("d7", iso(hour - 167 * HOUR)).put("d30", iso(hour - 719 * HOUR)))
            .put("projects", JSONArray().put(herdr).put(website)).put("tasks", tasks)
            .put("hourly", JSONObject().put("from", iso(from)).put("hours", 48).put("series", JSONArray().put(JSONObject().put("harness", "claude-code").put("usd", usd))))
            .put("truncated", JSONArray())
    }

    /**
     * The preview's Space Row feed (space.version 1) for its `herdr` and `website` repositories: made-up numbers, example
     * links. `website` has only some sections, so its line 2 shows "–".
     */
    fun space(now: Long): Map<String, SpaceFeed.Feed> = listOfNotNull(SpaceFeed.parse(JSONObject("""
        {"kind":"herdr-meter","schema_version":2,"generated_at":"${iso(now - 4 * 60_000L)}","space":{"version":1,"truncated":false,"projects":{
          "~/work/herdr":{
            "merges":{"n":7,"prev_n":5,"by_type":{"feat":3,"fix":3,"test":1},"items":[
              {"task":"gh-45","type":"feat","forge":"github","url":"https://github.com/example/herdr/pull/45","lead_min":42},
              {"task":"gh-44","type":"fix","forge":"github","url":"https://github.com/example/herdr/pull/44","lead_min":18},
              {"task":"gh-43","type":"feat","forge":"github","url":"https://github.com/example/herdr/pull/43","lead_min":95},
              {"task":"gh-42","type":"fix","forge":"github","url":"https://github.com/example/herdr/pull/42","lead_min":9},
              {"task":"gh-41","type":"test","forge":"github","url":"https://github.com/example/herdr/pull/41","lead_min":240},
              {"task":"gh-40","type":"feat","forge":"github","url":"https://github.com/example/herdr/pull/40","lead_min":61},
              {"task":"gh-39","type":"fix","forge":"github","url":"https://github.com/example/herdr/pull/39","lead_min":null}]},
            "time":{"median_min":38,"prev_median_min":55,"bands":[1,2,2,1,1,0],"bands_labels":["<15m","15-30m","30m-1h","1-2h","2-6h",">6h"],
              "fastest":{"task":"gh-42","min":9,"url":"https://github.com/example/herdr/pull/42"},"avg_min":61,
              "slowest":{"task":"gh-41","min":240,"url":"https://github.com/example/herdr/pull/41"}},
            "first_pass":{"share":0.57,"prev_share":0.4,"fixes":[4,2,1,0]},
            "spent":{"real_usd":18.4,"prev_real_usd":22.1,"by_model":{"example-codex-model":12.0,"example-claude-model":null,"example-deepseek-model":6.4},"codex_week_share":0.09},
            "tokens":{"total":10290000,"prev_total":8700000,"cache_hit":0.88,"by_model":{
              "example-codex-model":{"input":1200000,"output":90000,"cache_read":9000000,"turns":310,"reasoning_share":0.31,"cache_hit":0.88}}},
            "bots":{
              "b-demo-captain":{"usd_per_task":2.6,"min_per_task":38,"usd_24h":18.4,"other_usd":1.2,"parts_kind":"member",
                "parts":[{"key":"b-demo-dev","usd":9.1},{"key":"b-demo-test","usd":8.1},{"key":"other","usd":1.2}]},
              "b-demo-dev":{"usd_per_task":null,"min_per_task":null,"usd_24h":0.0,"other_usd":null,"parts_kind":"model","parts":[]}},
            "tasks":[
              {"task":"gh-45","usd":3.1,"lead_min":42,"bots":[{"bot":"b-demo-dev","usd":1.9,"work_min":25},{"bot":"b-demo-test","usd":1.2,"work_min":11}]},
              {"task":"gh-44","usd":1.4,"lead_min":18,"bots":[{"bot":"b-demo-captain","usd":1.4,"work_min":52}]},
              {"task":"gh-43","usd":2.2,"lead_min":95,"bots":[{"bot":"b-demo-dev","usd":2.2,"work_min":44},{"bot":"b-demo-test","usd":null,"work_min":null}]}]},
          "~/work/website":{"merges":{"n":0,"prev_n":0,"by_type":{},"items":[]},"time":null,"first_pass":null,
            "spent":{"real_usd":0.0,"prev_real_usd":null,"by_model":{},"codex_week_share":0.004},"tokens":{"total":48200,"prev_total":61000,"cache_hit":null,"by_model":{}}}
        }}}"""))).associateBy { "" }

    /** The preview's bots.json names, keyed like [MachineState.bots]. */
    val BOTS = mapOf("|~/work/herdr" to SpaceFeed.Names(mapOf("b-demo-captain" to "Captain", "b-demo-dev" to "Dev", "b-demo-test" to "Tester")))

    /** The preview's bot registries, keyed like [MachineState.members]: synthetic bots, Genie's pet for all. */
    val MEMBERS = mapOf(
        "|~/work/herdr" to listOf(Teams.Member("b-demo-captain", "Captain", main = true, pet = Teams.GENIE),
            Teams.Member("b-demo-dev", "Dev", main = false, pet = null), Teams.Member("b-demo-test", "Tester", main = false, pet = null),
            Teams.Member("b-demo-review", "Reviewer", main = false, pet = null), Teams.Member("b-demo-flaky", "Flaky", main = false, pet = null)),
        "|~/work/website" to listOf(Teams.Member("b-demo-writer", "Writer", main = true, pet = null)),
        "|~/work/notes" to listOf(Teams.Member("b-demo-scribe", "Scribe", main = true, pet = null)))
    /** The preview's space icons and tile colours, as Herdr stores them (shared.json), by space id. */
    val ICONS = mapOf<String, Teams.Icon>("sp1" to Teams.Icon.Emoji("🚀"), "sp4" to Teams.Icon.Emoji("📓"))
    val COLORS = mapOf("sp1" to "ansi3", "sp2" to "ansi1", "sp3" to "ansi4", "sp4" to "ansi5")

    /** The preview's readings, keyed like [MachineState.meter]. */
    fun readings(now: Long): Map<String, Spend.Reading> = mapOfNotNull(
        "" to Spend.parse("Preview machine", doc("preview-core", now, 4 * 60_000L, 1.0, withUnpriced = true)),
        "build-box" to Spend.parse("build-box", doc("build-core", now, 3 * HOUR, 0.4, withUnpriced = false)))
    private fun mapOfNotNull(vararg pairs: Pair<String, Spend.Reading?>) = pairs.mapNotNull { (k, v) -> v?.let { k to it } }.toMap()
}
