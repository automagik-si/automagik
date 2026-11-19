//! Antigravity (`agy`) conversations: the reader's fixture, its 7-day answer and its refusal of
//! an unknown shape. Synthetic fixtures only: every id, path, model and number here is made up.

mod common;

use std::fs;
use std::path::Path;

use common::{Env, serial};
use meter::evidence::SessionKey;
use meter::event::key_hash;
use meter::hc::{Labels, Terminal};
use meter::time::{format_rfc3339, parse_rfc3339};
use rusqlite::{Connection, params};

const CONV: &str = "conv-915-fixture";
const PROJECT: &str = "/work/example-project";
const CWD: &str = "/work/example-project/.worktrees/915";
const REPO: &str = "example.com/acme/example-project";
const BRANCH: &str = "feat/915-agy-transcripts";
const BOT: &str = "wren";
const TASK: &str = "915";

fn at(s: &str) -> i64 {
    parse_rfc3339(s).unwrap()
}

fn put_varint(mut v: u64, out: &mut Vec<u8>) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// A length-delimited protobuf field, the only wire type the fixture's messages use.
fn bytes(no: u64, b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    put_varint((no << 3) | 2, &mut out);
    put_varint(b.len() as u64, &mut out);
    out.extend_from_slice(b);
    out
}

fn uint(no: u64, v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    put_varint(no << 3, &mut out);
    put_varint(v, &mut out);
    out
}

fn text(no: u64, s: &str) -> Vec<u8> {
    bytes(no, s.as_bytes())
}

fn timestamp(secs: i64, nanos: u64) -> Vec<u8> {
    [uint(1, secs as u64), uint(2, nanos)].concat()
}

fn step_metadata(secs: i64) -> Vec<u8> {
    bytes(1, &timestamp(secs, 250_000_000))
}

fn trajectory(created: i64) -> Vec<u8> {
    let workspace = [
        text(1, &format!("file://{CWD}")),
        text(2, &format!("file://{PROJECT}")),
        bytes(
            3,
            &[
                text(1, "acme/example-project"),
                text(2, "https://example.com/acme/example-project.git"),
            ]
            .concat(),
        ),
        text(4, BRANCH),
    ]
    .concat();
    [bytes(1, &workspace), bytes(2, &timestamp(created, 0))].concat()
}

/// `ModelUsageStats`: input excludes a cache read, output includes thinking.
fn usage(input: u64, cache_read: u64, cache_write: u64, output: u64, thinking: u64) -> Vec<u8> {
    [
        uint(2, input),
        uint(3, output),
        uint(4, cache_write),
        uint(5, cache_read),
        uint(9, thinking),
        uint(10, output - thinking),
    ]
    .concat()
}

/// `ChatModelMetadata`: the model strings sit beside `usage`, not inside it.
fn chat_model(model: &str, display: &str, usage: &[u8]) -> Vec<u8> {
    [
        uint(3, 1417),
        bytes(4, usage),
        text(19, model),
        text(21, display),
    ]
    .concat()
}

fn generation(steps: &[u64], exec: &str, model: &str, display: &str, usage: &[u8]) -> Vec<u8> {
    let mut packed = Vec::new();
    for s in steps {
        put_varint(*s, &mut packed);
    }
    [
        bytes(1, &chat_model(model, display, usage)),
        bytes(2, &packed),
        text(4, exec),
    ]
    .concat()
}

const DDL: &str = "
CREATE TABLE trajectory_meta (
  trajectory_id text, cascade_id text, trajectory_type integer, source integer,
  PRIMARY KEY (trajectory_id)
);
CREATE TABLE steps (
  idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0,
  has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, PRIMARY KEY (idx)
);
CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));
";

/// The schema, the conversation metadata and steps 0-3, with no generation rows yet.
fn base_db(path: &Path, created: i64) {
    let c = Connection::open(path).unwrap();
    c.execute_batch(DDL).unwrap();
    c.execute(
        "INSERT INTO trajectory_meta VALUES('traj-915', ?1, 4, 17)",
        [CONV],
    )
    .unwrap();
    c.execute(
        "INSERT INTO trajectory_metadata_blob VALUES('main', ?1)",
        [trajectory(created)],
    )
    .unwrap();
    for (i, secs) in [
        (0, at("2026-01-15T10:00:00Z") / 1000),
        (1, at("2026-01-15T10:01:00Z") / 1000),
        (2, at("2026-01-15T10:02:00Z") / 1000),
        (3, at("2026-01-15T10:03:00Z") / 1000),
    ] {
        c.execute(
            "INSERT INTO steps(idx, step_type, status, metadata) VALUES(?1, 15, 3, ?2)",
            params![i, step_metadata(secs)],
        )
        .unwrap();
    }
}

/// Writes or replaces one generation row.
fn put_gen(path: &Path, idx: i64, data: &[u8]) {
    let c = Connection::open(path).unwrap();
    c.execute(
        "INSERT OR REPLACE INTO gen_metadata(idx, data, size) VALUES(?1, ?2, ?3)",
        params![idx, data, data.len() as i64],
    )
    .unwrap();
}

fn gemini_gen(usage: &[u8], steps: &[u64]) -> Vec<u8> {
    generation(
        steps,
        "exec-1",
        "gemini-4-argon",
        "Gemini 4 Argon (High)",
        usage,
    )
}

fn opus_gen(usage: &[u8], steps: &[u64]) -> Vec<u8> {
    generation(
        steps,
        "exec-2",
        "claude-opus-5-5",
        "Claude Opus 5.5 (High)",
        usage,
    )
}

fn write_db(path: &Path, created: i64) {
    base_db(path, created);
    let gemini = usage(1000, 4000, 50, 200, 120);
    let opus = usage(500, 6000, 0, 100, 60);
    put_gen(path, 0, &gemini_gen(&gemini, &[1, 2]));
    put_gen(path, 1, &opus_gen(&opus, &[3]));
}

fn ledger(env: &Env, created: i64) {
    let dir = env.home().join(".config/herdr-app/automagik-herdr");
    fs::create_dir_all(&dir).unwrap();
    let row = serde_json::json!({
        "event": "start", "kind": "worker", "terminal": "t915", "botId": BOT,
        "role": "dev", "squad": "meter", "worktree": CWD, "agent": "agy",
        "branch": BRANCH, "project": PROJECT, "task": TASK, "lead": null,
        "created_ms": created, "at": format_rfc3339(created + 5_000)
    });
    let p = dir.join("workers.jsonl");
    fs::write(&p, row.to_string() + "\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

fn snapshot(created: i64) -> Terminal {
    Terminal {
        terminal: "t915".into(),
        created_ms: Some(created),
        finished_ms: None,
        harness: Some("agy"),
        cwd: Some(CWD.into()),
        labels: Labels::default(),
    }
}

#[test]
fn a_fixture_conversation_counts_gemini_and_opus_with_a_bot_and_a_session_key() {
    let env = Env::new();
    let path = env.agy(&format!("{CONV}.db"));
    let created = at("2026-01-15T09:55:00Z");
    write_db(&path, created);
    ledger(&env, created);
    let mut o = env.opts();
    o.snapshot = Some(vec![snapshot(created)]);
    let r = env.run(&o);
    assert_eq!(r.health.usage_lines, 2, "{r:?}");

    let totals = env.totals();
    assert_eq!(
        totals["gemini-4-argon"].total(),
        1000 + 4000 + 50 + 200,
        "Gemini input, cache read, cache write and output"
    );
    assert_eq!(totals["gemini-4-argon"].reasoning, 120);
    assert_eq!(
        totals["claude-opus-5-5"].total(),
        500 + 6000 + 100,
        "Antigravity-hosted Opus is not zero"
    );

    // The evidence keeps the same attribution the other harnesses use: bot, role, squad, task,
    // branch and a keyed hash of the conversation id as the session.
    let store = env.store();
    let key =
        SessionKey::from_hex(store.meta("evidence_key").unwrap().as_deref().unwrap()).unwrap();
    let want = key.hex("agy", CONV);
    let mut stmt = store
        .conn
        .prepare(
            "SELECT e.session, a.bot, a.role, a.squad, a.task, d.branch
             FROM evidence e JOIN ev_dim d ON d.id = e.dim JOIN ev_actor a ON a.id = e.actor
             WHERE d.harness = 'agy' ORDER BY e.ts_ms",
        )
        .unwrap();
    let rows: Vec<(Vec<u8>, String, String, String, String, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(rows.len(), 2);
    for (session, bot, role, squad, task, branch) in rows {
        assert_eq!(meter::event::hex(&session), want);
        assert_eq!((bot.as_str(), role.as_str()), (BOT, "dev"));
        assert_eq!((squad.as_str(), task.as_str()), ("meter", TASK));
        assert_eq!(branch, BRANCH);
    }

    // A 7-day bot query shows the usage and its coverage.
    let out = env
        .command()
        .env("METER_STATE_DIR", env.state())
        .args([
            "query", "--repo", REPO, "--by", "bot", "--window", "d7", "--json",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let agy = v["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["harness"] == "agy")
        .expect("agy has a source health row");
    assert_eq!(agy["status"], "ok", "{agy}");
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{v}");
    let row = &rows[0];
    assert_eq!(row["bot"], BOT);
    assert_eq!(row["role"], "dev");
    assert_eq!(row["squad"], "meter");
    assert_eq!(row["harness"], "agy");
    assert_eq!(row["tokens"]["total"], 11_850);
    assert_eq!(row["tokens"]["reasoning"], 180);
    // Gemini has no bundled price row: its tokens are visible as unpriced, never silently priced.
    assert_eq!(row["cost"]["state"], "partial");
    assert!(
        row["cost"]["unpriced_models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m == "gemini-4-argon"),
        "{}",
        row["cost"]["unpriced_models"]
    );
    let a = &row["attribution"]["actor"];
    assert_eq!(a["tokens_attributed"], 11_850);
    assert_eq!(a["tokens_unlinked"], 0);
    assert_eq!(row["attribution"]["coverage"], "complete");

    // A branch row names the branch the conversation recorded.
    let out = env
        .command()
        .env("METER_STATE_DIR", env.state())
        .args([
            "query", "--repo", REPO, "--branch", BRANCH, "--window", "d7", "--json",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["rows"][0]["branch"], BRANCH);
    assert_eq!(v["rows"][0]["tokens"]["total"], 11_850);

    // The next sync reads nothing new: the generation cursor is the file's.
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 0);
    assert_eq!(
        env.totals()["gemini-4-argon"].total(),
        1000 + 4000 + 50 + 200
    );
}

#[test]
fn an_unknown_transcript_schema_is_refused_by_name() {
    let env = Env::new();
    let path = env.agy("conv-old.db");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("CREATE TABLE gen_metadata (idx integer, data blob);")
        .unwrap();
    drop(c);
    let r = env.run(&env.opts());
    let doc = r.summary.expect("a summary");
    assert_eq!(doc["sources"]["agy"]["status"], "unsupported", "{doc}");
    let reason = doc["sources"]["agy"]["reason"].as_str().unwrap();
    assert!(reason.contains("schema"), "{reason}");
    assert_eq!(env.store().rows_since(i64::MIN).unwrap().len(), 0);
}

#[test]
fn a_row_with_missing_steps_is_held() {
    let env = Env::new();
    let path = env.agy("conv-no-time.db");
    let created = at("2026-01-15T09:00:00Z");
    write_db(&path, created);
    // Keep the tables and the trajectory, drop every timestamp the generation needs.
    let c = Connection::open(&path).unwrap();
    c.execute("DELETE FROM steps", []).unwrap();
    drop(c);
    let r = env.run(&env.opts());
    let doc = r.summary.expect("a summary");
    assert_eq!(doc["sources"]["agy"]["status"], "degraded", "{doc}");
    let reason = doc["sources"]["agy"]["reason"].as_str().unwrap();
    assert!(reason.contains("still being written"), "{reason}");
    assert!(
        env.store()
            .rows_since(i64::MIN)
            .unwrap()
            .iter()
            .all(|r| r.key.harness != "agy"),
        "an unknown shape must not become a zero row"
    );
    assert_eq!(env.totals().len(), 0);
}

#[test]
fn a_full_read_does_not_leave_a_backlog() {
    let env = Env::new();
    let path = env.agy(&format!("{CONV}.db"));
    write_db(&path, at("2026-01-15T09:55:00Z"));
    let _g = serial();
    let r = env.run(&env.opts());
    assert_eq!(r.pending_files, 0, "{r:?}");
    assert!(!r.stopped_by_budget);
}

/// The summary's agy source status and reason.
fn agy_source(doc: &serde_json::Value) -> (String, String) {
    let s = &doc["sources"]["agy"];
    (
        s["status"].as_str().unwrap_or("").to_string(),
        s["reason"].as_str().unwrap_or("").to_string(),
    )
}

#[test]
fn a_held_row_stays_degraded_after_a_second_sync() {
    let env = Env::new();
    let path = env.agy("conv-refused.db");
    write_db(&path, at("2026-01-15T09:55:00Z"));
    let c = Connection::open(&path).unwrap();
    c.execute("DELETE FROM steps", []).unwrap();
    drop(c);
    for run in 1..=2 {
        let r = env.run(&env.opts());
        let (status, reason) = agy_source(&r.summary.expect("a summary"));
        assert_eq!(status, "degraded", "run {run}: {reason}");
        assert!(
            reason.contains("still being written"),
            "run {run}: {reason}"
        );
        assert!(
            env.store()
                .rows_since(i64::MIN)
                .unwrap()
                .iter()
                .all(|r| r.key.harness != "agy"),
            "run {run}: a refused row became a zero row"
        );
    }
}

#[test]
fn a_placeholder_generation_is_read_once_its_usage_arrives() {
    let env = Env::new();
    let path = env.agy("conv-placeholder.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    // A model block with an empty usage block: the row exists before its usage does.
    put_gen(&path, 0, &gemini_gen(&[], &[1, 2]));
    put_gen(&path, 1, &opus_gen(&usage(500, 6000, 0, 100, 60), &[3]));

    // The sync clock is just after the generation's steps: the row is recent and incomplete.
    let mut o = env.opts();
    o.now_ms = at("2026-01-15T10:03:00Z");
    let r = env.run(&o);
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "degraded", "{reason}");
    assert!(reason.contains("still being written"), "{reason}");
    assert_eq!(
        r.health.events, 1,
        "the row after the held one is still counted"
    );
    let t = env.totals();
    assert!(!t.contains_key("gemini-4-argon"));
    assert_eq!(t["claude-opus-5-5"].total(), 6_600);

    // The provider fills the row in place: the next sync must still read it.
    put_gen(
        &path,
        0,
        &gemini_gen(&usage(1000, 4000, 50, 200, 120), &[1, 2]),
    );
    let r = env.run(&o);
    assert_eq!(r.health.events, 1, "only the filled row is new: {r:?}");
    let t = env.totals();
    assert_eq!(t["gemini-4-argon"].total(), 5_250);
    assert_eq!(t["claude-opus-5-5"].total(), 6_600);
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
}

#[test]
fn a_reset_with_reused_indices_counts_the_new_generation() {
    let env = Env::new();
    let path = env.agy("conv-reset.db");
    write_db(&path, at("2026-01-15T09:55:00Z"));
    env.run(&env.opts());
    assert_eq!(env.totals()["gemini-4-argon"].total(), 5_250);

    // The conversation is reset and reuses index 0 for a new call with a new step time.
    let c = Connection::open(&path).unwrap();
    c.execute("DELETE FROM gen_metadata", []).unwrap();
    c.execute(
        "INSERT INTO steps(idx, step_type, status, metadata) VALUES(10, 15, 3, ?1)",
        [step_metadata(at("2026-01-15T11:00:00Z") / 1000)],
    )
    .unwrap();
    drop(c);
    put_gen(&path, 0, &gemini_gen(&usage(2000, 0, 0, 100, 20), &[10]));
    env.run(&env.opts());
    let t = env.totals();
    assert_eq!(t["gemini-4-argon"].total(), 5_250 + 2_100);
    assert_eq!(t["claude-opus-5-5"].total(), 6_600);
}

#[test]
fn an_unknown_only_usage_block_is_refused_by_name() {
    let env = Env::new();
    let path = env.agy("conv-unknown-usage.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &gemini_gen(&uint(99, 3), &[1]));
    for run in 1..=2 {
        let r = env.run(&env.opts());
        let (status, reason) = agy_source(&r.summary.expect("a summary"));
        assert_eq!(status, "unsupported", "run {run}: {reason}");
        assert!(reason.contains("none of the fields"), "run {run}: {reason}");
        assert!(env.totals().is_empty(), "run {run}");
    }
}

#[test]
fn an_out_of_range_count_is_refused_by_name() {
    let env = Env::new();
    let path = env.agy("conv-negative.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    let negative = [uint(2, u64::MAX), uint(3, 1)].concat();
    put_gen(&path, 0, &gemini_gen(&negative, &[1]));
    for run in 1..=2 {
        let r = env.run(&env.opts());
        let (status, reason) = agy_source(&r.summary.expect("a summary"));
        assert_eq!(status, "unsupported", "run {run}: {reason}");
        assert!(reason.contains("out of range"), "run {run}: {reason}");
        assert!(env.totals().is_empty(), "run {run}");
    }
}

#[test]
fn a_refused_timeless_row_is_read_when_its_step_arrives() {
    let env = Env::new();
    let path = env.agy("conv-late-step.db");
    write_db(&path, at("2026-01-15T09:55:00Z"));
    let c = Connection::open(&path).unwrap();
    c.execute("DELETE FROM steps WHERE idx IN (1, 2)", [])
        .unwrap();
    drop(c);
    let r = env.run(&env.opts());
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "degraded", "{reason}");
    // The row after the held one still counts; only the timeless Gemini row is missing.
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 6_600);

    // The step rows land after the generation row, as a live database may commit them.
    let c = Connection::open(&path).unwrap();
    for (idx, secs) in [
        (1, at("2026-01-15T10:01:00Z") / 1000),
        (2, at("2026-01-15T10:02:00Z") / 1000),
    ] {
        c.execute(
            "INSERT INTO steps(idx, step_type, status, metadata) VALUES(?1, 15, 3, ?2)",
            params![idx, step_metadata(secs)],
        )
        .unwrap();
    }
    drop(c);
    let r = env.run(&env.opts());
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
    assert_eq!(r.health.events, 1, "the Opus row was already counted");
    let t = env.totals();
    assert_eq!(t["gemini-4-argon"].total(), 5_250);
    assert_eq!(t["claude-opus-5-5"].total(), 6_600);
}

#[cfg(unix)]
#[test]
fn a_read_only_conversation_is_still_read() {
    use std::os::unix::fs::PermissionsExt;
    let env = Env::new();
    let path = env.agy("conv-read-only.db");
    write_db(&path, at("2026-01-15T09:55:00Z"));
    let old = fs::metadata(&path).unwrap().permissions();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
    let r = env.run(&env.opts());
    fs::set_permissions(&path, old).unwrap();
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
    assert_eq!(r.health.events, 2);
    assert_eq!(env.totals()["gemini-4-argon"].total(), 5_250);
}

#[test]
fn a_malformed_model_blob_is_refused_through_sync() {
    let env = Env::new();
    let path = env.agy("conv-bad-model.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    let g = [bytes(1, b"junk"), bytes(2, &[1])].concat();
    put_gen(&path, 0, &g);
    for run in 1..=2 {
        let r = env.run(&env.opts());
        let (status, reason) = agy_source(&r.summary.expect("a summary"));
        assert_eq!(status, "unsupported", "run {run}: {reason}");
        assert!(
            reason.contains("model metadata blob"),
            "run {run}: {reason}"
        );
        assert!(env.totals().is_empty(), "run {run}");
    }
}

#[test]
fn a_rewind_does_not_double_count_the_rows_it_re_reads() {
    let env = Env::new();
    let path = env.agy("conv-rewind.db");
    write_db(&path, at("2026-01-15T09:55:00Z"));
    env.run(&env.opts());
    let before = env.totals();

    // agy removes its last generation (an undo): the highest index falls below the cursor.
    let c = Connection::open(&path).unwrap();
    c.execute("DELETE FROM gen_metadata WHERE idx = 1", [])
        .unwrap();
    drop(c);
    let r = env.run(&env.opts());
    let after = env.totals();
    assert_eq!(
        after["gemini-4-argon"].total(),
        before["gemini-4-argon"].total()
    );
    assert_eq!(
        after["claude-opus-5-5"].total(),
        before["claude-opus-5-5"].total(),
        "the remaining row was read again and counted twice"
    );
    assert_eq!(r.health.events, 0, "{r:?}");
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
}

#[test]
fn a_bad_row_does_not_stop_the_valid_rows_after_it() {
    let env = Env::new();
    let path = env.agy("conv-bad-then-good.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &gemini_gen(&uint(99, 3), &[1]));
    put_gen(&path, 1, &opus_gen(&usage(500, 6000, 0, 100, 60), &[3]));
    for run in 1..=3 {
        let r = env.run(&env.opts());
        let (status, reason) = agy_source(&r.summary.expect("a summary"));
        assert_eq!(status, "unsupported", "run {run}: {reason}");
        let t = env.totals();
        assert!(!t.contains_key("gemini-4-argon"), "run {run}");
        assert_eq!(t["claude-opus-5-5"].total(), 6_600, "run {run}");
    }
    // The refusals and re-reads do not grow the stored counters: one call, counted once.
    let health = env
        .store()
        .health()
        .unwrap()
        .into_iter()
        .find(|(s, _, _)| s == "agy")
        .map(|(_, _, h)| h)
        .unwrap();
    assert_eq!(health.skipped_lines, 0);
    assert_eq!(health.usage_lines, 1, "re-reads must not count as lines");
    assert_eq!(health.duplicates, 0, "re-reads are not duplicate lines");

    // Once the bad row is readable, it counts and the status clears.
    put_gen(
        &path,
        0,
        &gemini_gen(&usage(1000, 4000, 50, 200, 120), &[1]),
    );
    let r = env.run(&env.opts());
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
    assert_eq!(env.totals()["gemini-4-argon"].total(), 5_250);
}

#[test]
fn a_quiet_placeholder_is_final_and_later_rows_count() {
    use std::time::{Duration, SystemTime};
    let env = Env::new();
    let path = env.agy("conv-quiet-placeholder.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &gemini_gen(&[], &[1, 2]));
    put_gen(&path, 1, &opus_gen(&usage(500, 6000, 0, 100, 60), &[3]));
    // The database has been quiet for over 30 minutes on the sync's own clock.
    let old = SystemTime::UNIX_EPOCH + Duration::from_millis(at("2026-01-15T09:00:00Z") as u64);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let mut o = env.opts();
    o.now_ms = at("2026-01-15T10:03:00Z");
    let r = env.run(&o);
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
    let t = env.totals();
    assert!(!t.contains_key("gemini-4-argon"));
    let opus = t.get("claude-opus-5-5").map(|x| x.total()).unwrap_or(0);
    assert_eq!(opus, 6_600, "{t:?} {reason}");
}

#[test]
fn a_re_read_row_with_changed_bytes_is_not_counted_again() {
    let env = Env::new();
    let path = env.agy("conv-byte-rewrite.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &gemini_gen(&[], &[1, 2]));
    put_gen(&path, 1, &opus_gen(&usage(500, 6000, 0, 100, 60), &[3]));
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 1);
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 6_600);

    // The row behind the held one is rewritten with the same usage and an extra field.
    let mut g = opus_gen(&usage(500, 6000, 0, 100, 60), &[3]);
    g.extend(bytes(99, b"x"));
    put_gen(&path, 1, &g);
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 0, "{r:?}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 6_600);
}

#[test]
fn a_rewind_plus_a_rewrite_is_not_counted_again() {
    let env = Env::new();
    let path = env.agy("conv-rewind-rewrite.db");
    write_db(&path, at("2026-01-15T09:55:00Z"));
    env.run(&env.opts());
    let c = Connection::open(&path).unwrap();
    c.execute("DELETE FROM gen_metadata WHERE idx = 1", [])
        .unwrap();
    drop(c);
    let mut g = gemini_gen(&usage(1000, 4000, 50, 200, 120), &[1, 2]);
    g.extend(bytes(99, b"x"));
    put_gen(&path, 0, &g);
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 0, "{r:?}");
    assert_eq!(env.totals()["gemini-4-argon"].total(), 5_250);
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 6_600);
}

#[test]
fn a_partial_output_row_waits_for_its_fill() {
    let env = Env::new();
    let path = env.agy("conv-partial-fill.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &gemini_gen(&usage(1000, 4000, 50, 0, 0), &[1, 2]));
    let r = env.run(&env.opts());
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "degraded", "{reason}");
    assert!(env.totals().is_empty());

    put_gen(
        &path,
        0,
        &gemini_gen(&usage(1000, 4000, 50, 200, 120), &[1, 2]),
    );
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 1, "{r:?}");
    assert_eq!(env.totals()["gemini-4-argon"].total(), 5_250);
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
}

#[test]
fn a_partial_row_behind_a_held_row_counts_once_it_fills() {
    let env = Env::new();
    let path = env.agy("conv-partial-behind-hold.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &gemini_gen(&[], &[1, 2]));
    put_gen(&path, 1, &opus_gen(&usage(500, 0, 0, 0, 0), &[3]));
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 0, "{r:?}");

    put_gen(&path, 1, &opus_gen(&usage(500, 0, 0, 100, 0), &[3]));
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 1, "{r:?}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
}

#[test]
fn a_recent_wal_keeps_a_placeholder_held() {
    use std::time::{Duration, SystemTime};
    let env = Env::new();
    let path = env.agy("conv-wal-hold.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    let writer = Connection::open(&path).unwrap();
    writer.pragma_update(None, "journal_mode", "WAL").unwrap();
    writer
        .pragma_update(None, "wal_autocheckpoint", "0")
        .unwrap();
    let placeholder = gemini_gen(&[], &[1, 2]);
    writer
        .execute(
            "INSERT INTO gen_metadata(idx, data, size) VALUES(0, ?1, ?2)",
            params![placeholder, placeholder.len() as i64],
        )
        .unwrap();
    let old = SystemTime::UNIX_EPOCH + Duration::from_millis(at("2026-01-15T09:00:00Z") as u64);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let wal = path.with_file_name(format!(
        "{}-wal",
        path.file_name().unwrap().to_string_lossy()
    ));
    let recent = SystemTime::UNIX_EPOCH + Duration::from_millis(at("2026-01-15T10:02:00Z") as u64);
    std::fs::File::options()
        .write(true)
        .open(&wal)
        .unwrap()
        .set_modified(recent)
        .unwrap();
    let mut o = env.opts();
    o.now_ms = at("2026-01-15T10:03:00Z");
    let r = env.run(&o);
    drop(writer);
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "degraded", "{reason}");
    assert!(reason.contains("still being written"), "{reason}");
    assert!(!env.totals().contains_key("gemini-4-argon"));
}

#[test]
fn a_rewind_refilled_before_a_sync_is_still_read() {
    let env = Env::new();
    let path = env.agy("conv-refill.db");
    write_db(&path, at("2026-01-15T09:55:00Z"));
    env.run(&env.opts());
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 6_600);

    // agy rewinds gen 1 and writes a new Opus call at the same index before the next sync.
    let c = Connection::open(&path).unwrap();
    c.execute("DELETE FROM gen_metadata WHERE idx = 1", [])
        .unwrap();
    c.execute(
        "UPDATE steps SET metadata = ?1 WHERE idx = 3",
        [step_metadata(at("2026-01-15T11:10:00Z") / 1000)],
    )
    .unwrap();
    drop(c);
    put_gen(&path, 1, &opus_gen(&usage(900, 0, 0, 100, 0), &[3]));
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 1, "{r:?}");
    assert_eq!(env.totals()["gemini-4-argon"].total(), 5_250);
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 7_600);
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
}

#[test]
fn two_rewound_rows_refilled_before_a_sync_are_both_read() {
    let env = Env::new();
    let path = env.agy("conv-refill-two.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    let c = Connection::open(&path).unwrap();
    c.execute(
        "INSERT INTO steps(idx, step_type, status, metadata) VALUES(10, 15, 3, ?1)",
        [step_metadata(at("2026-01-15T10:04:00Z") / 1000)],
    )
    .unwrap();
    drop(c);
    put_gen(
        &path,
        0,
        &gemini_gen(&usage(1000, 4000, 50, 200, 120), &[1, 2]),
    );
    put_gen(&path, 1, &opus_gen(&usage(500, 6000, 0, 100, 60), &[3]));
    put_gen(&path, 2, &opus_gen(&usage(1900, 0, 0, 100, 0), &[10]));
    env.run(&env.opts());
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 6_600 + 2_000);

    // Both newest calls are rewound and refilled at the same indices before the next sync.
    let c = Connection::open(&path).unwrap();
    c.execute("DELETE FROM gen_metadata WHERE idx IN (1, 2)", [])
        .unwrap();
    c.execute(
        "UPDATE steps SET metadata = ?1 WHERE idx = 3",
        [step_metadata(at("2026-01-15T11:10:00Z") / 1000)],
    )
    .unwrap();
    c.execute(
        "UPDATE steps SET metadata = ?1 WHERE idx = 10",
        [step_metadata(at("2026-01-15T11:11:00Z") / 1000)],
    )
    .unwrap();
    drop(c);
    put_gen(&path, 1, &opus_gen(&usage(900, 0, 0, 100, 0), &[3]));
    put_gen(&path, 2, &opus_gen(&usage(2900, 0, 0, 100, 0), &[10]));
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 2, "{r:?}");
    assert_eq!(env.totals()["gemini-4-argon"].total(), 5_250);
    assert_eq!(
        env.totals()["claude-opus-5-5"].total(),
        6_600 + 2_000 + 1_000 + 3_000
    );
}

#[test]
fn a_step_time_that_lands_later_does_not_double_count() {
    let env = Env::new();
    let path = env.agy("conv-late-step-time.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(
        &path,
        0,
        &gemini_gen(&usage(1000, 4000, 50, 200, 120), &[1]),
    );
    put_gen(&path, 1, &opus_gen(&usage(500, 0, 0, 100, 0), &[2, 3]));
    // An earlier step of the Opus row has no time on the first sync.
    let c = Connection::open(&path).unwrap();
    c.execute("UPDATE steps SET metadata = ?1 WHERE idx = 2", [uint(3, 2)])
        .unwrap();
    drop(c);

    let r = env.run(&env.opts());
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "degraded", "{reason}");
    assert!(!env.totals().contains_key("claude-opus-5-5"));

    // The earlier step's time lands: the row is counted once, with a complete step set.
    let c = Connection::open(&path).unwrap();
    c.execute(
        "UPDATE steps SET metadata = ?1 WHERE idx = 2",
        [step_metadata(at("2026-01-15T10:02:00Z") / 1000)],
    )
    .unwrap();
    drop(c);
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 1, "{r:?}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");

    // The stored cursor names the complete step set, so a third sync reads nothing new.
    let saved = env.store().file(&path.to_string_lossy()).unwrap().unwrap();
    let ctx = saved.ctx.agy.expect("an agy cursor");
    assert_eq!(ctx.max_gen, 1);
    assert_eq!(ctx.cursor_ts, at("2026-01-15T10:02:00Z") + 250);
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 0, "{r:?}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
}

#[test]
fn a_counted_row_behind_a_hold_counts_once_when_its_output_grows() {
    let env = Env::new();
    let path = env.agy("conv-output-grows.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &gemini_gen(&[], &[1, 2]));
    put_gen(&path, 1, &opus_gen(&usage(500, 0, 0, 100, 0), &[3]));
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 1);
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);

    // The counted row behind the held one grows its output: re-reading it must not re-count it.
    put_gen(&path, 1, &opus_gen(&usage(500, 0, 0, 200, 0), &[3]));
    let r = env.run(&env.opts());
    assert_eq!(r.health.events, 0, "{r:?}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
}

#[test]
fn a_quiet_row_with_a_missing_step_counts_with_the_times_present() {
    use std::time::{Duration, SystemTime};
    let env = Env::new();
    let path = env.agy("conv-quiet-missing-step.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    // Step 9 is never written; steps 2 and 3 have their times.
    put_gen(&path, 0, &opus_gen(&usage(500, 0, 0, 100, 0), &[2, 3, 9]));
    let old = SystemTime::UNIX_EPOCH + Duration::from_millis(at("2026-01-15T09:00:00Z") as u64);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let mut o = env.opts();
    o.now_ms = at("2026-01-15T12:00:00Z");
    let r = env.run(&o);
    assert_eq!(r.health.events, 1, "{r:?}");
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
    let saved = env.store().file(&path.to_string_lossy()).unwrap().unwrap();
    let ctx = saved.ctx.agy.expect("an agy cursor");
    assert_eq!(ctx.cursor_ts, at("2026-01-15T10:02:00Z") + 250);
    let r = env.run(&o);
    assert_eq!(r.health.events, 0, "{r:?}");

    // This store has only the key an older reader wrote for the first available time.
    let seen = Connection::open(env.state().join("meter.db")).unwrap();
    let old_key = format!(
        "agy|conv-quiet-missing-step|0|{}",
        at("2026-01-15T10:02:00Z") + 250
    );
    assert_eq!(
        seen.query_row(
            "SELECT count(*) FROM seen WHERE k = ?1",
            [key_hash(&old_key)],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    drop(seen);

    // The missing step lands with an earlier time. The changed cursor forces a full rescan.
    let c = Connection::open(&path).unwrap();
    c.execute(
        "INSERT INTO steps(idx, step_type, status, metadata) VALUES(9, 15, 3, ?1)",
        [step_metadata(at("2026-01-15T10:01:00Z") / 1000)],
    )
    .unwrap();
    drop(c);
    let r = env.run(&o);
    assert_eq!(r.health.events, 0, "{r:?}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
    let saved = env.store().file(&path.to_string_lossy()).unwrap().unwrap();
    assert_eq!(
        saved.ctx.agy.unwrap().cursor_ts,
        at("2026-01-15T10:01:00Z") + 250
    );

    // A genuinely new generation may reuse the index with fresh step times.
    let c = Connection::open(&path).unwrap();
    for (idx, time) in [
        (2, "2026-01-15T11:00:00Z"),
        (3, "2026-01-15T11:01:00Z"),
        (9, "2026-01-15T11:02:00Z"),
    ] {
        c.execute(
            "UPDATE steps SET metadata = ?1 WHERE idx = ?2",
            params![step_metadata(at(time) / 1000), idx],
        )
        .unwrap();
    }
    drop(c);
    put_gen(&path, 0, &opus_gen(&usage(900, 0, 0, 100, 0), &[2, 3, 9]));
    let r = env.run(&o);
    assert_eq!(r.health.events, 1, "{r:?}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 1_600);
}

#[test]
fn a_late_step_behind_a_held_row_does_not_count_again() {
    use std::time::{Duration, SystemTime};
    let env = Env::new();
    let path = env.agy("conv-held-late-step.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &[0xff]); // A refused row keeps the cursor behind the counted row.
    put_gen(&path, 1, &opus_gen(&usage(500, 0, 0, 100, 0), &[2, 3, 9]));
    let old = SystemTime::UNIX_EPOCH + Duration::from_millis(at("2026-01-15T09:00:00Z") as u64);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let mut o = env.opts();
    o.now_ms = at("2026-01-15T12:00:00Z");
    let r = env.run(&o);
    assert_eq!(r.health.events, 1, "{r:?}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
    assert_eq!(
        env.store()
            .file(&path.to_string_lossy())
            .unwrap()
            .unwrap()
            .ctx
            .agy
            .unwrap()
            .max_gen,
        -1
    );

    // The same row is read again after its missing, earlier step time arrives.
    let c = Connection::open(&path).unwrap();
    c.execute(
        "INSERT INTO steps(idx, step_type, status, metadata) VALUES(9, 15, 3, ?1)",
        [step_metadata(at("2026-01-15T10:01:00Z") / 1000)],
    )
    .unwrap();
    drop(c);
    let r = env.run(&o);
    assert_eq!(r.health.events, 0, "{r:?}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
    assert_eq!(
        env.store()
            .file(&path.to_string_lossy())
            .unwrap()
            .unwrap()
            .ctx
            .agy
            .unwrap()
            .max_gen,
        -1
    );
}

#[test]
fn a_quiet_row_with_no_step_time_is_unsupported() {
    use std::time::{Duration, SystemTime};
    let env = Env::new();
    let path = env.agy("conv-quiet-no-step-time.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    put_gen(&path, 0, &opus_gen(&usage(500, 0, 0, 100, 0), &[2, 3]));
    let c = Connection::open(&path).unwrap();
    for idx in [2, 3] {
        c.execute(
            "UPDATE steps SET metadata = ?1 WHERE idx = ?2",
            params![uint(3, 2), idx],
        )
        .unwrap();
    }
    drop(c);
    let old = SystemTime::UNIX_EPOCH + Duration::from_millis(at("2026-01-15T09:00:00Z") as u64);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let mut o = env.opts();
    o.now_ms = at("2026-01-15T12:00:00Z");
    let r = env.run(&o);
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "unsupported", "{reason}");
    assert!(reason.contains("step time"), "{reason}");
    assert!(env.totals().is_empty());
}

#[test]
fn a_quiet_placeholder_with_a_missing_step_does_not_hold_forever() {
    use std::time::{Duration, SystemTime};
    let env = Env::new();
    let path = env.agy("conv-quiet-placeholder-missing.db");
    base_db(&path, at("2026-01-15T09:55:00Z"));
    // A no-usage row names a step that is never written, then a valid row follows it.
    put_gen(&path, 0, &gemini_gen(&[], &[2, 3, 9]));
    put_gen(&path, 1, &opus_gen(&usage(500, 0, 0, 100, 0), &[3]));
    let old = SystemTime::UNIX_EPOCH + Duration::from_millis(at("2026-01-15T09:00:00Z") as u64);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let mut o = env.opts();
    o.now_ms = at("2026-01-15T12:00:00Z");
    let r = env.run(&o);
    assert_eq!(r.health.events, 1, "{r:?}");
    let (status, reason) = agy_source(&r.summary.expect("a summary"));
    assert_eq!(status, "ok", "{reason}");
    assert_eq!(env.totals()["claude-opus-5-5"].total(), 600);
    let saved = env.store().file(&path.to_string_lossy()).unwrap().unwrap();
    assert_eq!(saved.ctx.agy.unwrap().max_gen, 1);
}
