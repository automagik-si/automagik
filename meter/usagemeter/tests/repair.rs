//! `usagemeter repair` (issue 1126) on fixture stores in temp dirs. Synthetic rows only.

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use meter::repair::{self, Copy, Opts, exit};
use meter::time::{HOUR_MS, parse_rfc3339};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

const NOW: i64 = 1_800_000_000_000;
const CR: usize = 1; // cache_read
const IN: usize = 0; // input_uncached

fn hour(s: &str) -> i64 {
    parse_rfc3339(s).unwrap()
}

struct Fx {
    _dir: tempfile::TempDir,
    _envs: [common::Env; 2],
    store: PathBuf,
    oracle: PathBuf,
    scratch: PathBuf,
}

impl Fx {
    fn new() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        // The real schema path: a sync of an empty home, so every table sync makes (the outcomes
        // `pr` table, `WITHOUT ROWID`, included) is in the fixture store.
        let mk = || {
            let env = common::Env::new();
            env.run(&env.opts());
            env
        };
        let envs = [mk(), mk()];
        let (store, oracle) = (envs[0].state(), envs[1].state());
        let scratch = dir.path().join("scratch");
        fs::create_dir_all(&scratch).unwrap();
        Fx {
            _dir: dir,
            _envs: envs,
            store,
            oracle,
            scratch,
        }
    }
    fn conn(dir: &Path) -> Connection {
        Connection::open(dir.join("meter.db")).unwrap()
    }
    fn put(
        dir: &Path,
        id: &str,
        harness: &str,
        h: &str,
        v: [i64; 7],
        events: i64,
        state: Option<&str>,
    ) {
        Fx::put_m(dir, id, harness, h, v, events, state, "mach", None);
    }
    #[allow(clippy::too_many_arguments)]
    fn put_m(
        dir: &Path,
        id: &str,
        harness: &str,
        h: &str,
        v: [i64; 7],
        events: i64,
        state: Option<&str>,
        machine: &str,
        branch: Option<&str>,
    ) {
        Fx::put_full(dir, id, harness, h, v, events, state, machine, branch, None);
    }
    #[allow(clippy::too_many_arguments)]
    fn put_full(
        dir: &Path,
        id: &str,
        harness: &str,
        h: &str,
        v: [i64; 7],
        events: i64,
        state: Option<&str>,
        machine: &str,
        branch: Option<&str>,
        repo: Option<&str>,
    ) {
        Fx::conn(dir)
            .execute(
                "INSERT INTO usage(id, hour_ms, harness, model, machine, precision, events,
                   updated_ms, actor_state, input_uncached, cache_read, cache_write_5m,
                   cache_write_1h, output, reasoning, unsplit, branch, repo)
                 VALUES (?1, ?2, ?3, 'm', ?13, 'exact', ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?14, ?15)",
                rusqlite::params![
                    id,
                    hour(h),
                    harness,
                    events,
                    state,
                    v[0],
                    v[1],
                    v[2],
                    v[3],
                    v[4],
                    v[5],
                    v[6],
                    machine,
                    branch,
                    repo
                ],
            )
            .unwrap();
    }
    fn s(&self, id: &str, harness: &str, h: &str, v: [i64; 7], ev: i64) {
        Fx::put(&self.store, id, harness, h, v, ev, None);
    }
    fn o(&self, id: &str, harness: &str, h: &str, v: [i64; 7], ev: i64) {
        Fx::put(&self.oracle, id, harness, h, v, ev, None);
    }
    fn opts(&self, extra: &[&str]) -> Opts {
        let mut a: Vec<String> = vec![
            "--store".into(),
            self.store.display().to_string(),
            "--against".into(),
            self.oracle.display().to_string(),
        ];
        a.extend(extra.iter().map(|s| s.to_string()));
        repair::parse(&a, NOW).unwrap()
    }
    /// A copy of the store as `VACUUM INTO` makes it, with its sha256.
    fn copy(&self, name: &str) -> Copy {
        let path = self.scratch.join(name);
        Fx::conn(&self.store)
            .execute("VACUUM INTO ?1", [path.display().to_string()])
            .unwrap();
        let sha = meter::event::hex(&Sha256::digest(fs::read(&path).unwrap()));
        Copy { path, sha256: sha }
    }
    fn apply_opts(&self, extra: &[&str], c: &Copy) -> Opts {
        let mut o = self.opts(extra);
        o.apply = Some(c.clone());
        o
    }
    fn col(dir: &Path, harness: &str, h: &str, c: usize) -> i64 {
        let name = repair::COLS[c];
        Fx::conn(dir)
            .query_row(
                &format!(
                    "SELECT coalesce(sum({name}), 0) FROM usage WHERE harness = ?1 AND hour_ms = ?2"
                ),
                rusqlite::params![harness, hour(h)],
                |r| r.get(0),
            )
            .unwrap()
    }
    fn events(dir: &Path) -> i64 {
        Fx::conn(dir)
            .query_row("SELECT coalesce(sum(events), 0) FROM usage", [], |r| {
                r.get(0)
            })
            .unwrap()
    }
    fn db_hash(dir: &Path) -> String {
        meter::event::hex(&Sha256::digest(fs::read(dir.join("meter.db")).unwrap()))
    }
    fn journal(&self) -> Option<String> {
        Fx::conn(&self.store)
            .query_row("SELECT v FROM meta WHERE k = ?1", [repair::JOURNAL], |r| {
                r.get(0)
            })
            .ok()
    }
}

fn cols(i: usize, n: i64) -> [i64; 7] {
    let mut v = [0; 7];
    v[i] = n;
    v
}

const H8: &str = "2026-11-08T10:00:00Z";
const H9: &str = "2026-11-09T11:00:00Z";

#[test]
fn short_cell_top_up_then_idempotent_second_apply() {
    let _g = common_serial();
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 160), 5);
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(d.report.total_change(), 60);
    assert!(d.report.passed());
    let j = d.report.to_json(d.code);
    assert_eq!(j["cells"][0]["column"], "cache_read");
    assert_eq!(j["cells"][0]["before"], 100);
    assert_eq!(j["cells"][0]["after"], 160);
    assert_eq!(j["total"]["events_change"], 0);

    let c = fx.copy("copy.db");
    let d = repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(d.applied_days, vec!["2026-11-08"]);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H8, CR), 160);
    assert_eq!(Fx::events(&fx.store), 5);
    assert_eq!(fx.journal().as_deref(), Some("2026-11-08"));

    // Second apply: the plan is empty, exit 3, nothing is written.
    let h = Fx::db_hash(&fx.store);
    let d = repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    assert_eq!(d.code, exit::NOTHING);
    assert!(d.applied_days.is_empty());
    assert_eq!(Fx::db_hash(&fx.store), h);
}

#[test]
fn kept_cell_keeps_evidence_free_tokens() {
    let _g = common_serial();
    let fx = Fx::new();
    // Mixed history: 50 evidence-free + 100 attributed in one group; the oracle has 100.
    Fx::put(&fx.store, "free", "claude-code", H8, cols(CR, 50), 2, None);
    Fx::put(
        &fx.store,
        "att",
        "claude-code",
        H8,
        cols(CR, 100),
        3,
        Some("attributed"),
    );
    let mut o = cols(CR, 100);
    o[IN] = 30;
    fx.o("a", "claude-code", H8, o, 5);
    let mut s = [0; 7];
    s[IN] = 10;
    Fx::put(&fx.store, "in", "claude-code", H8, s, 0, None);
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert_eq!(d.report.total_change(), 20);
    assert_eq!(d.report.kept_tokens(), 50);
    let j = d.report.to_json(d.code);
    assert_eq!(j["kept"][0]["column"], "cache_read");
    assert_eq!(j["kept"][0]["tokens"], 50);
    let c = fx.copy("c.db");
    repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    // Nothing subtracted, the top-up went to the evidence-free row, the attributed row is as it was.
    assert_eq!(Fx::col(&fx.store, "claude-code", H8, CR), 150);
    assert_eq!(Fx::col(&fx.store, "claude-code", H8, IN), 30);
    // The attributed row is unchanged in every column and in events.
    let row = |id: &str| -> ([i64; 7], i64) {
        let names = repair::COLS.join(", ");
        Fx::conn(&fx.store)
            .query_row(
                &format!("SELECT {names}, events FROM usage WHERE id = ?1"),
                [id],
                |r| {
                    let mut v = [0i64; 7];
                    for (i, x) in v.iter_mut().enumerate() {
                        *x = r.get(i)?;
                    }
                    Ok((v, r.get(7)?))
                },
            )
            .unwrap()
    };
    assert_eq!(row("att"), (cols(CR, 100), 3));
    // The recovered tokens (30 input_uncached: 10 held, 20 recovered) sit in the evidence-free
    // rows, taken together: the top-up goes to the largest of them.
    let (free, in_row) = (row("free"), row("in"));
    let both: [i64; 7] = std::array::from_fn(|i| free.0[i] + in_row.0[i]);
    let mut want = cols(CR, 50);
    want[IN] = 30;
    assert_eq!(both, want);
    assert_eq!(free.1 + in_row.1, 2);
}

#[test]
fn unresolved_hour_is_listed_and_untouched() {
    let _g = common_serial();
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 1);
    fx.s("b", "dsh-tui", H9, cols(CR, 70), 1);
    fx.o("b", "dsh-tui", H9, cols(CR, 70), 1);
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::NOTHING);
    assert_eq!(d.report.unresolved_tokens(), 100);
    let j = d.report.to_json(d.code);
    assert_eq!(j["unresolved"][0]["hours"], 1);
    assert_eq!(j["unresolved"][0]["day"], "2026-11-08");
    assert!(d.report.passed());
    // Both a short hour and an unresolved one: only the short one is planned.
    fx.o("c", "dsh-tui", "2026-11-09T12:00:00Z", cols(CR, 9), 1);
    fx.s("c", "dsh-tui", "2026-11-09T12:00:00Z", cols(CR, 4), 1);
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(d.report.changes.len(), 1);
    assert_eq!(d.report.unresolved_tokens(), 100);
}

#[test]
fn events_differ_fails_and_apply_writes_nothing() {
    let _g = common_serial();
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 160), 6);
    let c = fx.copy("c.db");
    let h = Fx::db_hash(&fx.store);
    let d = repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    assert_eq!(d.code, exit::CONSERVATION);
    assert!(
        d.report
            .failures
            .iter()
            .any(|f| f.contains("events differ"))
    );
    assert!(d.applied_days.is_empty());
    assert_eq!(Fx::db_hash(&fx.store), h);
}

#[test]
fn codex_and_antigravity_change_fails() {
    let _g = common_serial();
    for harness in ["codex", meter::sources::Source::Agy.harness()] {
        let fx = Fx::new();
        fx.s("a", harness, H8, cols(CR, 100), 5);
        fx.o("a", harness, H8, cols(CR, 101), 5);
        let d = repair::execute(&fx.opts(&[])).unwrap();
        assert_eq!(d.code, exit::CONSERVATION, "{harness}");
        assert!(d.report.failures.iter().any(|f| f.contains(harness)));
    }
}

#[test]
fn range_limit_reports_outside_and_from_until_narrow() {
    let _g = common_serial();
    let fx = Fx::new();
    let before = "2026-11-06T10:00:00Z";
    fx.s("o", "dsh-tui", before, cols(CR, 10), 1);
    fx.o("o", "dsh-tui", before, cols(CR, 90), 1);
    fx.s("a", "dsh-tui", H8, cols(CR, 10), 1);
    fx.o("a", "dsh-tui", H8, cols(CR, 20), 1);
    fx.s("b", "dsh-tui", H9, cols(CR, 10), 1);
    fx.o("b", "dsh-tui", H9, cols(CR, 30), 1);
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.report.total_change(), 10 + 20);
    let j = d.report.to_json(d.code);
    assert_eq!(j["outside_range"][0]["tokens"], 80);
    let d = repair::execute(&fx.opts(&["--from", "2026-11-09", "--until", "2026-11-09"])).unwrap();
    assert_eq!(d.report.total_change(), 20);
    assert_eq!(d.report.changes[0].day, "2026-11-09");
    // Apply leaves the day outside the range as it was.
    let c = fx.copy("c.db");
    repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    assert_eq!(Fx::col(&fx.store, "dsh-tui", before, CR), 10);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H8, CR), 20);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H9, CR), 30);
}

#[test]
fn kill_between_days_leaves_whole_days() {
    let _g = common_serial();
    let fx = Fx::new();
    for (i, h) in [H8, H9, "2026-11-10T01:00:00Z"].iter().enumerate() {
        let id = format!("r{i}");
        fx.s(&id, "dsh-tui", h, cols(CR, 10), 1);
        fx.o(&id, "dsh-tui", h, cols(CR, 25), 1);
    }
    let c = fx.copy("c.db");
    let o = fx.apply_opts(&[], &c);
    let rep = repair::execute(&fx.opts(&[])).unwrap().report;
    let done = repair::apply(&o, &c, &rep, 1).unwrap();
    assert_eq!(done, vec!["2026-11-08"]);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H8, CR), 25);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H9, CR), 10);
    assert_eq!(fx.journal().as_deref(), Some("2026-11-08"));
    // A rerun with the same copy finishes the rest and skips the done day.
    let d = repair::execute(&o).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(d.applied_days, vec!["2026-11-09", "2026-11-10"]);
    assert_eq!(
        Fx::col(&fx.store, "dsh-tui", "2026-11-10T01:00:00Z", CR),
        25
    );
    assert_eq!(repair::execute(&o).unwrap().code, exit::NOTHING);
}

#[test]
fn failed_day_check_rolls_the_day_back() {
    let _g = common_serial();
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 10), 1);
    fx.o("a", "dsh-tui", H8, cols(CR, 25), 1);
    // A second group in the same day: a change that tops up the wrong group's row writes the
    // row, but the day's own group comparison catches it and rolls the day back.
    fx.s("other", "dsh-tui", "2026-11-08T14:00:00Z", cols(CR, 40), 1);
    fx.o("other", "dsh-tui", "2026-11-08T14:00:00Z", cols(CR, 40), 1);
    let c = fx.copy("c.db");
    let o = fx.apply_opts(&[], &c);
    let mut rep = repair::execute(&fx.opts(&[])).unwrap().report;
    assert_eq!(rep.changes.len(), 1);
    rep.changes[0].id = "other".into();
    let h = Fx::db_hash(&fx.store);
    match repair::apply(&o, &c, &rep, usize::MAX) {
        Err(e) => {
            assert!(e.contains("not what the plan says"), "{e}");
            assert!(e.contains("rolled back"), "{e}");
        }
        Ok(days) => panic!("the day was committed: {days:?}"),
    }
    assert_eq!(Fx::db_hash(&fx.store), h);
    assert_eq!(fx.journal(), None);
    // A change whose row is gone is refused the same way.
    rep.changes[0].id = "no-such-row".into();
    let h = Fx::db_hash(&fx.store);
    let e = repair::apply(&o, &c, &rep, usize::MAX).unwrap_err();
    assert!(e.contains("rolled back"), "{e}");
    assert_eq!(Fx::db_hash(&fx.store), h);
    assert_eq!(fx.journal(), None);
}

#[test]
fn dry_run_writes_nothing() {
    let _g = common_serial();
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 160), 5);
    let (hs, ho) = (Fx::db_hash(&fx.store), Fx::db_hash(&fx.oracle));
    let files_before = {
        let mut v: Vec<String> = fs::read_dir(&fx.store)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.ends_with("-wal") && !n.ends_with("-shm"))
            .collect();
        v.sort();
        v
    };
    let d = repair::execute(&fx.opts(&["--dry-run"])).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(Fx::db_hash(&fx.store), hs);
    assert_eq!(Fx::db_hash(&fx.oracle), ho);
    // No file is added to the store's folder but SQLite's own read-only companions.
    let files = |d: &Path| -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.ends_with("-wal") && !n.ends_with("-shm"))
            .collect();
        v.sort();
        v
    };
    assert_eq!(files(&fx.store), files_before);
    assert!(fx.journal().is_none());
}

#[test]
fn evidence_sum_stays_under_the_rollup() {
    let _g = common_serial();
    let ev = |fx: &Fx, n: i64| {
        Fx::conn(&fx.store)
            .execute(
                "INSERT INTO evidence(ts_ms, dim, actor, cache_read) VALUES (?1, 0, 0, ?2)",
                rusqlite::params![hour(H8) + 5, n],
            )
            .unwrap();
    };
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 160), 5);
    ev(&fx, 90);
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    // Evidence above the rollup already (the damage), and the top-up covers it: planned and
    // applied, exit 0, the damage hour reported, 0 hours above the rollup after.
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 160), 5);
    ev(&fx, 120);
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    let j = d.report.to_json(d.code);
    assert_eq!(j["damage_hours_before"]["count"], 1);
    assert_eq!(j["damage_hours_before"]["hours"][0], H8);
    assert!(d.report.to_text(d.code).contains("damage_hours_before 1"));
    let c = fx.copy("c.db");
    let d = repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H8, CR), 160);
    assert_eq!(repair::execute(&fx.opts(&[])).unwrap().code, exit::NOTHING);
    // The top-up does not cover the evidence (110 against 120): exit 1, the hour named, and an
    // apply writes nothing.
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 110), 5);
    ev(&fx, 120);
    let c = fx.copy("c.db");
    let h = Fx::db_hash(&fx.store);
    let d = repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    assert_eq!(d.code, exit::CONSERVATION);
    assert!(
        d.report
            .failures
            .iter()
            .any(|f| f.contains("after the repair") && f.contains(H8)),
        "{:?}",
        d.report.failures
    );
    assert!(d.applied_days.is_empty());
    assert_eq!(Fx::db_hash(&fx.store), h);
    let _ = HOUR_MS;
}

#[test]
fn apply_refused_without_the_matching_copy_and_on_a_newer_schema() {
    let _g = common_serial();
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 160), 5);
    // No --copy / --confirm-copy at all.
    let a: Vec<String> = [
        "--store",
        fx.store.to_str().unwrap(),
        "--against",
        fx.oracle.to_str().unwrap(),
        "--apply",
    ]
    .map(String::from)
    .to_vec();
    assert!(repair::parse(&a, NOW).is_err());
    // A wrong sha256.
    let mut c = fx.copy("c.db");
    c.sha256 = "0".repeat(64);
    let h = Fx::db_hash(&fx.store);
    let e = match repair::execute(&fx.apply_opts(&[], &c)) {
        Err(e) => e,
        Ok(_) => panic!("applied with a wrong sha256"),
    };
    assert!(e.contains("sha256"), "{e}");
    assert_eq!(Fx::db_hash(&fx.store), h);
    // A copy that no longer matches the store.
    let c = fx.copy("d.db");
    fx.s("x", "omp", H9, cols(IN, 1), 1);
    assert!(repair::execute(&fx.apply_opts(&[], &c)).is_err());
    // A newer schema.
    Fx::conn(&fx.store)
        .execute("UPDATE meta SET v = '99' WHERE k = 'schema_version'", [])
        .unwrap();
    assert_eq!(
        repair::execute(&fx.opts(&[])).unwrap().code,
        exit::NEWER_SCHEMA
    );
}

#[test]
fn cli_dry_run_exit_codes_and_json() {
    let _g = common_serial();
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 160), 5);
    let run = |extra: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_usagemeter"))
            .arg("repair")
            .arg("--store")
            .arg(&fx.store)
            .arg("--against")
            .arg(&fx.oracle)
            .args(extra)
            .output()
            .unwrap()
    };
    let out = run(&["--json"]);
    assert_eq!(out.status.code(), Some(0));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["total"]["change"], 60);
    assert_eq!(v["conservation"]["pass"], true);
    assert_eq!(run(&[]).status.code(), Some(0));
    assert_eq!(run(&["--from", "2026-11-09"]).status.code(), Some(3));
    assert_eq!(run(&["--from", "nonsense"]).status.code(), Some(2));
    assert_eq!(run(&["--apply"]).status.code(), Some(2));
    // The plan names the store.
    assert_eq!(v["store"], fx.store.display().to_string());
    let text = String::from_utf8(run(&[]).stdout).unwrap();
    assert!(text.contains(&fx.store.display().to_string()), "{text}");
    // No --store: a usage error, even with METER_STATE_DIR set to a real store.
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_usagemeter"))
        .arg("repair")
        .arg("--against")
        .arg(&fx.oracle)
        .env("METER_STATE_DIR", &fx.store)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--store"));
}

#[test]
fn the_store_is_an_explicit_argument() {
    let a: Vec<String> = ["--against", "oracle"].map(String::from).to_vec();
    let e = repair::parse(&a, NOW).unwrap_err();
    assert!(e.contains("--store"), "{e}");
}

#[test]
fn a_narrowed_apply_does_not_lock_out_the_earlier_days() {
    let _g = common_serial();
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 10), 1);
    fx.o("a", "dsh-tui", H8, cols(CR, 25), 1);
    fx.s("b", "dsh-tui", H9, cols(CR, 10), 1);
    fx.o("b", "dsh-tui", H9, cols(CR, 25), 1);
    let c = fx.copy("c.db");
    // The later day first, as a careful operator would.
    let d = repair::execute(&fx.apply_opts(&["--from", "2026-11-09", "--until", "2026-11-09"], &c))
        .unwrap();
    assert_eq!(
        (d.code, d.applied_days),
        (exit::OK, vec!["2026-11-09".to_string()])
    );
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H8, CR), 10);
    // Then the default range: the earlier day is still planned, written and reported.
    let d = repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(d.report.total_change(), 15);
    assert_eq!(d.applied_days, vec!["2026-11-08"]);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H8, CR), 25);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H9, CR), 25);
    assert_eq!(
        repair::execute(&fx.apply_opts(&[], &c)).unwrap().code,
        exit::NOTHING
    );
}

#[test]
fn a_short_group_with_no_evidence_free_row_is_unresolved_not_topped_up() {
    let _g = common_serial();
    let fx = Fx::new();
    // Two attributed rows, none evidence-free: 100 + 40 against 200.
    Fx::put(
        &fx.store,
        "t1",
        "claude-code",
        H8,
        cols(CR, 100),
        3,
        Some("attributed"),
    );
    Fx::put(
        &fx.store,
        "t2",
        "claude-code",
        H8,
        cols(CR, 40),
        2,
        Some("attributed"),
    );
    fx.o("o1", "claude-code", H8, cols(CR, 200), 5);
    // And a normal short group beside it.
    fx.s("n", "dsh-tui", H9, cols(CR, 10), 1);
    fx.o("n", "dsh-tui", H9, cols(CR, 30), 1);
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert_eq!(d.report.total_change(), 20, "the 60 are not in the change");
    let j = d.report.to_json(d.code);
    assert_eq!(j["unresolved_groups"][0]["tokens"], 60);
    assert_eq!(j["unresolved_groups"][0]["reason"], "no_evidence_free_row");
    assert_eq!(j["targets"]["state"], "before_evidence");
    assert!(d.report.to_text(d.code).contains("no evidence-free row"));
    let c = fx.copy("c.db");
    repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    // The attributed rows are as they were; the other group was topped up.
    let all = |id: &str| -> i64 {
        Fx::conn(&fx.store)
            .query_row("SELECT cache_read FROM usage WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
    };
    assert_eq!((all("t1"), all("t2")), (100, 40));
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H9, CR), 30);
    // Alone, the group is nothing to repair.
    let fx = Fx::new();
    Fx::put(
        &fx.store,
        "t1",
        "claude-code",
        H8,
        cols(CR, 100),
        3,
        Some("attributed"),
    );
    fx.o("o1", "claude-code", H8, cols(CR, 200), 3);
    assert_eq!(repair::execute(&fx.opts(&[])).unwrap().code, exit::NOTHING);
}

#[test]
fn totals_add_the_six_counted_columns_and_never_reasoning() {
    let _g = common_serial();
    let fx = Fx::new();
    let mut s = [0; 7];
    s[4] = 100; // output
    s[5] = 40; // reasoning, inside output
    let mut o = [0; 7];
    o[4] = 150;
    o[5] = 60;
    fx.s("a", "claude-code", H8, s, 1);
    fx.o("a", "claude-code", H8, o, 1);
    // An unresolved hour holding output 10, reasoning 5: 10 tokens, not 15.
    let mut u = [0; 7];
    u[4] = 10;
    u[5] = 5;
    fx.s("u", "claude-code", H9, u, 1);
    // Kept: the store's reasoning (30) is above the oracle's (0), its output is equal: 0 counted.
    let mut k = [0; 7];
    k[4] = 5;
    k[5] = 30;
    fx.s("k", "omp", H8, k, 1);
    let mut k0 = [0; 7];
    k0[4] = 5;
    fx.o("k", "omp", H8, k0, 1);
    // Outside the range: the oracle's reasoning is above the store's (20), output equal: 0 counted.
    let out = "2026-11-01T10:00:00Z";
    fx.s("x", "omp", out, cols(4, 7), 1);
    let mut x = cols(4, 7);
    x[5] = 20;
    fx.o("x", "omp", out, x, 1);
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.report.kept_tokens(), 0);
    assert!(
        d.report.to_json(d.code)["outside_range"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(d.report.total_change(), 50);
    assert_eq!(d.report.total_before(), 115);
    assert_eq!(d.report.unresolved_tokens(), 10);
    let j = d.report.to_json(d.code);
    assert_eq!(j["total"]["change"], 50);
    assert_eq!(j["total"]["before"], 115);
    // Reasoning is still a repaired column in the per-column lines.
    let cells = j["cells"].as_array().unwrap();
    let r = cells.iter().find(|c| c["column"] == "reasoning").unwrap();
    assert_eq!(r["change"], 20);
}

fn common_serial() -> impl Drop {
    // One lock-taking test at a time: the apply tests take the store's sync lock.
    static M: std::sync::Mutex<()> = std::sync::Mutex::new(());
    M.lock().unwrap_or_else(|e| e.into_inner())
}

#[test]
fn a_store_made_by_sync_applies_end_to_end_and_every_table_hashes() {
    let _g = common_serial();
    let fx = Fx::new();
    // What sync made: every table the real schema path creates, `pr` (WITHOUT ROWID) included.
    let tables: Vec<String> = Fx::conn(&fx.store)
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for t in [
        "pr",
        "ev_error",
        "evidence",
        "launch",
        "link",
        "ev_dim",
        "ev_actor",
        "ev_cwd",
        "ledgers",
        "meta",
        "usage",
        "files",
        "seen",
        "sessions",
        "cwd_repo",
        "health",
        "codex_threads",
    ] {
        assert!(tables.iter().any(|x| x == t), "{t} missing from {tables:?}");
    }
    let c = Fx::conn(&fx.store);
    c.execute(
        "INSERT INTO pr(project, branch, pr, state, at_ms) VALUES ('p', 'b', 1, 'open', 1)",
        [],
    )
    .unwrap();
    drop(c);
    // Every table hashes, the hash is stable, and a change to a `pr` row changes it.
    let db = fx.store.join("meter.db");
    let h = repair::fingerprint_file(&db, 0, 1).unwrap();
    assert_eq!(repair::fingerprint_file(&db, 0, 1).unwrap(), h);
    Fx::conn(&fx.store)
        .execute("UPDATE pr SET state = 'merged'", [])
        .unwrap();
    assert_ne!(repair::fingerprint_file(&db, 0, 1).unwrap(), h);
    // And a repair runs on it.
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 160), 5);
    let c = fx.copy("c.db");
    let d = repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(d.applied_days, vec!["2026-11-08"]);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H8, CR), 160);
}

#[test]
fn the_copy_must_be_a_separate_file() {
    let _g = common_serial();
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
    fx.o("a", "dsh-tui", H8, cols(CR, 160), 5);
    let db = fx.store.join("meter.db");
    let sha = meter::event::hex(&Sha256::digest(fs::read(&db).unwrap()));
    let h = Fx::db_hash(&fx.store);
    let refused = |path: PathBuf, what: &str| {
        let c = Copy {
            path,
            sha256: sha.clone(),
        };
        match repair::execute(&fx.apply_opts(&[], &c)) {
            Err(e) => assert!(e.contains("copy"), "{what}: {e}"),
            Ok(d) => panic!("{what}: applied, code {}", d.code),
        }
        assert_eq!(Fx::db_hash(&fx.store), h, "{what}");
    };
    // The same bytes and sha256, by every way a path can name the store.
    let sym = fx.scratch.join("sym.db");
    std::os::unix::fs::symlink(&db, &sym).unwrap();
    refused(sym, "symlink");
    let hard = fx.scratch.join("hard.db");
    fs::hard_link(&db, &hard).unwrap();
    refused(hard, "hard link");
    refused(fx.store.join(".").join("meter.db"), "./ spelling");
    refused(db.clone(), "the store itself");
    // A real, separate copy passes.
    let c = fx.copy("real.db");
    assert_eq!(
        repair::execute(&fx.apply_opts(&[], &c)).unwrap().code,
        exit::OK
    );
}

#[test]
fn a_reasoning_only_gap_is_printed_and_applied_not_dropped() {
    let _g = common_serial();
    let fx = Fx::new();
    let mut s = [0; 7];
    s[4] = 100;
    s[5] = 10;
    let mut o = s;
    o[5] = 40;
    fx.s("a", "claude-code", H8, s, 1);
    fx.o("a", "claude-code", H8, o, 1);
    // The dry run prints the change and its exit agrees: a plan (0), not "nothing to repair" (3).
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert_eq!(d.report.total_change(), 0, "reasoning is never in a total");
    let j = d.report.to_json(d.code);
    assert_eq!(j["cells"][0]["column"], "reasoning");
    assert_eq!(j["cells"][0]["change"], 30);
    // The apply writes it.
    let c = fx.copy("c.db");
    let d = repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(d.applied_days, vec!["2026-11-08"]);
    assert_eq!(Fx::col(&fx.store, "claude-code", H8, 5), 40);
    assert_eq!(Fx::col(&fx.store, "claude-code", H8, 4), 100);
    // Then nothing is left.
    assert_eq!(
        repair::execute(&fx.apply_opts(&[], &c)).unwrap().code,
        exit::NOTHING
    );
}

/// What a refused apply must not change in the store's folder: every file but the database and
/// SQLite's own companions, by name, size and mtime.
fn listing(dir: &Path) -> Vec<(String, u64, std::time::SystemTime)> {
    let mut v: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            let m = e.metadata().unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                m.len(),
                m.modified().unwrap(),
            )
        })
        .filter(|(n, _, _)| !n.starts_with("meter.db"))
        .collect();
    v.sort();
    v
}

#[test]
fn a_refused_apply_leaves_nothing_behind_in_the_store_folder() {
    let _g = common_serial();
    // Each refusal path, on a store with its lock file (a synced store has one) and on one
    // without: the folder listing is identical before and after, and the store is unchanged.
    for with_lock in [true, false] {
        let fx = Fx::new();
        fx.s("a", "dsh-tui", H8, cols(CR, 100), 5);
        fx.o("a", "dsh-tui", H8, cols(CR, 160), 5);
        let good = fx.copy("good.db");
        if !with_lock {
            fs::remove_file(fx.store.join("meter.lock")).unwrap();
        }
        let db = fx.store.join("meter.db");
        let sha = |p: &Path| meter::event::hex(&Sha256::digest(fs::read(p).unwrap()));
        let notdb = fx.scratch.join("notdb.db");
        fs::write(&notdb, b"not a database").unwrap();
        let hard = fx.scratch.join("hard.db");
        fs::hard_link(&db, &hard).unwrap();
        let copies: Vec<(&str, Copy)> = vec![
            (
                "wrong sha",
                Copy {
                    path: good.path.clone(),
                    sha256: "0".repeat(64),
                },
            ),
            (
                "missing copy",
                Copy {
                    path: fx.scratch.join("nope.db"),
                    sha256: good.sha256.clone(),
                },
            ),
            (
                "not a database",
                Copy {
                    sha256: sha(&notdb),
                    path: notdb,
                },
            ),
            (
                "hard link",
                Copy {
                    sha256: sha(&hard),
                    path: hard,
                },
            ),
        ];
        let (before, h) = (listing(&fx.store), Fx::db_hash(&fx.store));
        for (what, c) in copies {
            assert!(repair::execute(&fx.apply_opts(&[], &c)).is_err(), "{what}");
            assert_eq!(listing(&fx.store), before, "{what} (lock file {with_lock})");
            assert_eq!(Fx::db_hash(&fx.store), h, "{what}");
        }
        // A copy that no longer matches the store's rows (taken, then the store grew).
        let stale = fx.copy("stale.db");
        fx.s("x", "omp", H9, cols(IN, 1), 1);
        let (before, h) = (listing(&fx.store), Fx::db_hash(&fx.store));
        assert!(
            repair::execute(&fx.apply_opts(&[], &stale)).is_err(),
            "stale"
        );
        assert_eq!(listing(&fx.store), before, "stale (lock file {with_lock})");
        assert_eq!(Fx::db_hash(&fx.store), h);
        // Conservation fails (events differ): refused before any lock.
        fx.o("e", "dsh-tui", H9, cols(CR, 9), 2);
        fx.s("e", "dsh-tui", H9, cols(CR, 3), 1);
        let (before, h) = (listing(&fx.store), Fx::db_hash(&fx.store));
        let d = repair::execute(&fx.apply_opts(&[], &good)).unwrap();
        assert_eq!(d.code, exit::CONSERVATION);
        assert_eq!(
            listing(&fx.store),
            before,
            "conservation (lock file {with_lock})"
        );
        assert_eq!(Fx::db_hash(&fx.store), h);
        // A newer store: refused before any lock.
        Fx::conn(&fx.store)
            .execute("UPDATE meta SET v = '99' WHERE k = 'schema_version'", [])
            .unwrap();
        let (before, h) = (listing(&fx.store), Fx::db_hash(&fx.store));
        let d = repair::execute(&fx.apply_opts(&[], &good)).unwrap();
        assert_eq!(d.code, exit::NEWER_SCHEMA);
        assert_eq!(
            listing(&fx.store),
            before,
            "newer schema (lock file {with_lock})"
        );
        assert_eq!(Fx::db_hash(&fx.store), h);
    }
}

#[test]
fn a_failed_apply_never_removes_the_lock_file() {
    let _g = common_serial();
    // A store folder with no lock file (one no sync has run in), and an apply that fails after it
    // took the lock: the file stays. A sync may have opened or locked it meanwhile, and unlinking
    // it would leave that sync holding a lock on a file no one else can see.
    let fx = Fx::new();
    fx.s("a", "dsh-tui", H8, cols(CR, 10), 1);
    fx.o("a", "dsh-tui", H8, cols(CR, 25), 1);
    let c = fx.copy("c.db");
    let o = fx.apply_opts(&[], &c);
    let mut rep = repair::execute(&fx.opts(&[])).unwrap().report;
    rep.changes[0].id = "no-such-row".into();
    let lock = fx.store.join("meter.lock");
    fs::remove_file(&lock).unwrap();
    let h = Fx::db_hash(&fx.store);
    let e = repair::apply(&o, &c, &rep, usize::MAX).unwrap_err();
    assert!(e.contains("rolled back"), "{e}");
    assert!(lock.exists(), "the lock file was unlinked");
    assert_eq!(Fx::db_hash(&fx.store), h);
    // And it is still a lock file a sync can take: not held after the failed apply.
    assert!(meter::paths::try_lock(&fx.store).unwrap().is_some());
}

const ALPHA: &str = "example.test/org/alpha";
const BETA: &str = "example.test/org/beta";

/// Every column of every row of a store, by id: what "byte-unchanged" compares.
fn all_rows(dir: &Path) -> Vec<String> {
    let c = Fx::conn(dir);
    let mut st = c.prepare("SELECT * FROM usage ORDER BY id").unwrap();
    let n = st.column_count();
    let rows = st
        .query_map([], |r| {
            Ok((0..n)
                .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                .collect::<Vec<_>>()
                .join("|"))
        })
        .unwrap();
    rows.map(|r| r.unwrap()).collect()
}

#[allow(clippy::too_many_arguments)]
fn sr(fx: &Fx, id: &str, v: i64, ev: i64, machine: &str, branch: &str, repo: &str) {
    Fx::put_full(
        &fx.store,
        id,
        "dsh-tui",
        H8,
        cols(CR, v),
        ev,
        None,
        machine,
        Some(branch),
        Some(repo),
    );
}

#[allow(clippy::too_many_arguments)]
fn or(fx: &Fx, id: &str, v: i64, ev: i64, repo: &str) {
    Fx::put_full(
        &fx.oracle,
        id,
        "dsh-tui",
        H8,
        cols(CR, v),
        ev,
        None,
        "machine-scratch",
        Some("branch-z"),
        Some(repo),
    );
}

#[test]
fn coarse_puts_the_shortfall_on_one_new_row_labelled_with_the_one_short_repo() {
    let _g = common_serial();
    let fx = Fx::new();
    // A group of two store rows (two machines, two branches, two repos); the oracle, built in a
    // scratch home, has other machine and branch labels. Only alpha is short: 65 against 40.
    sr(&fx, "a", 40, 3, "machine-one", "branch-x", ALPHA);
    sr(&fx, "b", 60, 2, "machine-two", "branch-y", BETA);
    or(&fx, "o1", 65, 3, ALPHA);
    or(&fx, "o2", 60, 2, BETA);
    // Without the option the exact key stays: nothing matches, the plan refuses.
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::CONSERVATION, "{}", d.report.to_text(d.code));
    assert_eq!(d.report.to_json(d.code)["match"]["mode"], "exact");
    let old = all_rows(&fx.store);
    let d = repair::execute(&fx.opts(&["--coarse"])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert!(d.report.passed());
    assert_eq!(d.report.total_change(), 25);
    let j = d.report.to_json(d.code);
    assert_eq!(j["match"]["mode"], "coarse");
    assert_eq!(j["match"]["store_rows"], 2);
    assert_eq!(j["match"]["max_rows_per_group"], 2);
    assert_eq!(j["new_rows_created"], 1);
    assert_eq!(j["existing_rows_changed"], 0);
    let t = &j["top_ups"][0];
    assert_eq!(t["kind"], "new_row");
    assert_eq!(t["receiving_row"]["repo"], ALPHA);
    assert_eq!(t["receiving_row"]["machine"], "");
    assert!(t["receiving_row"]["branch"].is_null());
    assert_eq!(t["receiving_row"]["precision"], "exact");
    assert_eq!(t["group_rows"], 2);
    assert_eq!(t["added"]["cache_read"], 25);
    assert_eq!(j["added_by_day"][0]["tokens"], 25);
    let text = d.report.to_text(d.code);
    assert!(
        text.contains("as a NEW row:") && text.contains(&format!("repo={ALPHA}")),
        "{text}"
    );
    assert!(text.contains("(group of 2 store rows)"), "{text}");
    assert!(text.contains("dsh-tui 2026-11-08: +25"), "{text}");
    assert!(
        text.contains("new rows created: 1; existing rows changed: 0"),
        "{text}"
    );
    // Apply: one new row, every old row byte-unchanged.
    let c = fx.copy("c.db");
    let d = repair::execute(&fx.apply_opts(&["--coarse"], &c)).unwrap();
    assert_eq!(d.code, exit::OK);
    let new = all_rows(&fx.store);
    assert_eq!(new.len(), old.len() + 1);
    for r in &old {
        assert!(new.contains(r), "an existing row changed: {r}");
    }
    // The new row, read as one string of every label column: NULL shown as "-".
    let row: String = Fx::conn(&fx.store)
        .query_row(
            "SELECT id || '|' || machine || '|' || coalesce(repo, '-') || '|' ||
                    coalesce(branch, '-') || '|' || coalesce(actor_state, '-') || '|' ||
                    events || '|' || cache_read || '|' || coalesce(bot, '-')
             FROM usage WHERE id LIKE 'repair1126:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let f: Vec<&str> = row.split('|').collect();
    let (id, machine, repo, branch, state, events, cr, bot) =
        (f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7]);
    assert!(id.starts_with("repair1126:"));
    assert_eq!(
        (machine, repo, branch, state, events, cr, bot),
        ("", ALPHA, "-", "-", "0", "25", "-")
    );
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H8, CR), 125);
    assert_eq!(Fx::events(&fx.store), 5);
    // A rerun finds nothing: the new row is in the group's sums.
    assert_eq!(
        repair::execute(&fx.apply_opts(&["--coarse"], &c))
            .unwrap()
            .code,
        exit::NOTHING
    );
}

#[test]
fn coarse_leaves_the_repo_empty_when_no_single_repo_is_short() {
    let _g = common_serial();
    // Alpha +30, beta -20: the group is 10 short, but a repo is over, so the repo stays empty.
    let fx = Fx::new();
    sr(&fx, "a", 40, 3, "machine-one", "branch-x", ALPHA);
    sr(&fx, "b", 60, 2, "machine-two", "branch-y", BETA);
    or(&fx, "o1", 70, 3, ALPHA);
    or(&fx, "o2", 40, 2, BETA);
    let d = repair::execute(&fx.opts(&["--coarse"])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert_eq!(d.report.total_change(), 10);
    let t = &d.report.to_json(d.code)["top_ups"][0];
    assert_eq!(t["kind"], "new_row");
    assert!(t["receiving_row"]["repo"].is_null());
    // Two repos short: also empty.
    let fx = Fx::new();
    sr(&fx, "a", 40, 3, "machine-one", "branch-x", ALPHA);
    sr(&fx, "b", 60, 2, "machine-two", "branch-y", BETA);
    or(&fx, "o1", 50, 3, ALPHA);
    or(&fx, "o2", 75, 2, BETA);
    let d = repair::execute(&fx.opts(&["--coarse"])).unwrap();
    assert_eq!(d.report.total_change(), 25);
    assert!(d.report.to_json(d.code)["top_ups"][0]["receiving_row"]["repo"].is_null());
    let c = fx.copy("c.db");
    repair::execute(&fx.apply_opts(&["--coarse"], &c)).unwrap();
    let repo: Option<String> = Fx::conn(&fx.store)
        .query_row(
            "SELECT repo FROM usage WHERE id LIKE 'repair1126:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(repo, None);
}

#[test]
fn a_repo_alias_joins_two_names_of_one_repo() {
    let _g = common_serial();
    let fx = Fx::new();
    // The store knows the repo as dev/alpha, the oracle as si/alpha.
    sr(
        &fx,
        "a",
        40,
        3,
        "machine-one",
        "branch-x",
        "example.test/dev/alpha",
    );
    or(&fx, "o1", 65, 3, "example.test/si/alpha");
    // No alias: two repos, one over and one short: empty.
    let d = repair::execute(&fx.opts(&["--coarse"])).unwrap();
    assert!(d.report.to_json(d.code)["top_ups"][0]["receiving_row"]["repo"].is_null());
    // The alias: one repo, short by 25, in the store's naming; printed in the header.
    let alias = "example.test/si/=example.test/dev/";
    let d = repair::execute(&fx.opts(&["--coarse", "--repo-alias", alias])).unwrap();
    assert_eq!(d.code, exit::OK);
    let j = d.report.to_json(d.code);
    assert_eq!(
        j["top_ups"][0]["receiving_row"]["repo"],
        "example.test/dev/alpha"
    );
    assert_eq!(j["repo_aliases"][0]["old"], "example.test/si/");
    assert!(
        d.report
            .to_text(d.code)
            .contains(&format!("repo aliases: {alias}"))
    );
    // An alias needs --coarse and the form OLD=NEW.
    for bad in [
        vec!["--repo-alias", alias],
        vec!["--coarse", "--repo-alias", "nope"],
    ] {
        let mut a: Vec<String> = ["--store", "s", "--against", "o"]
            .map(String::from)
            .to_vec();
        a.extend(bad.iter().map(|x| x.to_string()));
        assert!(repair::parse(&a, NOW).is_err());
    }
}

#[test]
fn without_coarse_two_oracle_machines_match_their_exact_rows() {
    let _g = common_serial();
    let fx = Fx::new();
    Fx::put_m(
        &fx.store,
        "a",
        "dsh-tui",
        H8,
        cols(CR, 50),
        1,
        None,
        "machine-one",
        None,
    );
    Fx::put_m(
        &fx.store,
        "b",
        "dsh-tui",
        H8,
        cols(CR, 70),
        1,
        None,
        "machine-two",
        None,
    );
    Fx::put_m(
        &fx.oracle,
        "oa",
        "dsh-tui",
        H8,
        cols(CR, 60),
        1,
        None,
        "machine-one",
        None,
    );
    Fx::put_m(
        &fx.oracle,
        "ob",
        "dsh-tui",
        H8,
        cols(CR, 70),
        1,
        None,
        "machine-two",
        None,
    );
    let d = repair::execute(&fx.opts(&[])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert_eq!(d.report.total_change(), 10);
    assert_eq!(d.report.to_json(d.code)["match"]["mode"], "exact");
    let c = fx.copy("c.db");
    repair::execute(&fx.apply_opts(&[], &c)).unwrap();
    let cr = |id: &str| -> i64 {
        Fx::conn(&fx.store)
            .query_row("SELECT cache_read FROM usage WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
    };
    assert_eq!((cr("a"), cr("b")), (60, 70));
}

const H14: &str = "2026-11-10T14:00:00Z";

#[test]
fn an_hour_bound_leaves_the_later_hours_out_of_every_check() {
    let _g = common_serial();
    let fx = Fx::new();
    // Before the bound: short, to be topped up. At and after it: the oracle holds more, events
    // differ, and the evidence is above the rollup: all of it must stay out of the run.
    fx.s("early", "dsh-tui", "2026-11-10T13:00:00Z", cols(CR, 10), 1);
    fx.o("early", "dsh-tui", "2026-11-10T13:00:00Z", cols(CR, 25), 1);
    // Before the start bound: short too, and out of the run.
    fx.s("twelve", "dsh-tui", "2026-11-10T12:00:00Z", cols(CR, 10), 1);
    fx.o("twelve", "dsh-tui", "2026-11-10T12:00:00Z", cols(CR, 20), 1);
    fx.s("late", "dsh-tui", H14, cols(CR, 10), 1);
    fx.o("late", "dsh-tui", H14, cols(CR, 99), 7);
    fx.s("later", "dsh-tui", "2026-11-10T15:00:00Z", cols(CR, 5), 1);
    Fx::conn(&fx.store)
        .execute(
            "INSERT INTO evidence(ts_ms, dim, actor, cache_read) VALUES (?1, 0, 0, 500)",
            rusqlite::params![hour(H14) + 5],
        )
        .unwrap();
    // The whole day: the later hours break the run (events differ, evidence above the rollup).
    let d = repair::execute(&fx.opts(&["--from", "2026-11-10", "--until", "2026-11-10"])).unwrap();
    assert_eq!(d.code, exit::CONSERVATION);
    // Up to the hour: only 13:00 is in the plan, and the checks do not see 14:00.
    let args = ["--from", "2026-11-10T13:00:00Z", "--until", H14];
    let d = repair::execute(&fx.opts(&args)).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert_eq!(d.report.total_change(), 15);
    assert_eq!(d.report.to_json(d.code)["range"]["until"], H14);
    assert!(
        d.report
            .to_text(d.code)
            .contains("up to 2026-11-10T14:00:00Z")
    );
    // Apply writes the 13:00 hour and leaves 14:00 and 15:00 as they were.
    let c = fx.copy("c.db");
    let d = repair::execute(&fx.apply_opts(&args, &c)).unwrap();
    assert_eq!(d.code, exit::OK);
    assert_eq!(
        Fx::col(&fx.store, "dsh-tui", "2026-11-10T13:00:00Z", CR),
        25
    );
    assert_eq!(
        Fx::col(&fx.store, "dsh-tui", "2026-11-10T12:00:00Z", CR),
        10
    );
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H14, CR), 10);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", "2026-11-10T15:00:00Z", CR), 5);
    // A start on the hour works the same way: 13:00 is out of a run that starts at 14:00.
    let d = repair::execute(&fx.opts(&["--from", H14, "--until", "2026-11-10T15:00:00Z"])).unwrap();
    assert_eq!(d.code, exit::CONSERVATION, "{}", d.report.to_text(d.code));
}

#[test]
fn a_time_not_on_the_hour_is_refused() {
    let fx = Fx::new();
    for bad in [
        "2026-11-10T14:30:00Z",
        "2026-11-10T14:00:01Z",
        "2026-11-10T14:00:00+01:00",
        "2026-11-10T14:00:00",
        "2026-11-10 14:00",
    ] {
        for flag in ["--from", "--until"] {
            let a: Vec<String> = ["--store", "s", "--against", "o", flag, bad]
                .map(String::from)
                .to_vec();
            let e = repair::parse(&a, NOW).unwrap_err();
            assert!(e.contains("exactly on the hour"), "{flag} {bad}: {e}");
        }
    }
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_usagemeter"))
        .arg("repair")
        .arg("--store")
        .arg(&fx.store)
        .arg("--against")
        .arg(&fx.oracle)
        .args(["--until", "2026-11-10T14:30:00Z"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    // On the hour is accepted, by both flags.
    let a: Vec<String> = [
        "--store",
        "s",
        "--against",
        "o",
        "--from",
        "2026-11-10T13:00:00Z",
        "--until",
        H14,
    ]
    .map(String::from)
    .to_vec();
    let o = repair::parse(&a, NOW).unwrap();
    assert_eq!((o.until_ms - o.from_ms) / HOUR_MS, 1);
}

#[test]
fn a_new_coarse_row_reads_in_status_and_query() {
    let _g = common_serial();
    let fx = Fx::new();
    sr(&fx, "a", 40, 3, "machine-one", "branch-x", ALPHA);
    or(&fx, "o1", 65, 3, ALPHA);
    let c = fx.copy("c.db");
    assert_eq!(
        repair::execute(&fx.apply_opts(&["--coarse"], &c))
            .unwrap()
            .code,
        exit::OK
    );
    let run = |args: &[&str]| {
        let o = std::process::Command::new(env!("CARGO_BIN_EXE_usagemeter"))
            .args(args)
            .env_clear()
            .env("METER_STATE_DIR", &fx.store)
            .env("HOME", &fx.scratch)
            .output()
            .unwrap();
        (
            o.status.code(),
            String::from_utf8_lossy(&o.stdout).to_string(),
        )
    };
    // status: the store opens and counts the new row (rows 2), nothing breaks on the empty labels.
    let (code, out) = run(&["status"]);
    assert_eq!(code, Some(0), "{out}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["rows"], 2, "{out}");
    // query: answers, branch rows count by branch window so the branch-less row is in none of
    // them; its precision is one the query accepts (it reads rows of `exact`/`total_only`).
    let q = |store: &Path, repo: &str| {
        let o = std::process::Command::new(env!("CARGO_BIN_EXE_usagemeter"))
            .args([
                "query",
                "--repo",
                repo,
                "--branch",
                "main",
                "--json",
                "--since",
                "2026-11-08T00:00:00Z",
                "--until",
                "2026-11-09T00:00:00Z",
                "--stale-after",
                "2592000",
            ])
            .env_clear()
            .env("METER_STATE_DIR", store)
            .env("HOME", &fx.scratch)
            .output()
            .unwrap();
        (
            o.status.code(),
            serde_json::from_slice::<serde_json::Value>(&o.stdout).unwrap(),
        )
    };
    let (code, v) = q(&fx.store, ALPHA);
    assert_eq!(code, Some(0), "{v}");
    assert_eq!(v["status"], "ok");
    println!(
        "QUERY_ALPHA unattributed={} rows={}",
        v["unattributed"], v["rows"]
    );
    // A new row with no repo: the query's unattributed bucket may hold it.
    let fx2 = Fx::new();
    sr(&fx2, "a", 40, 3, "machine-one", "branch-x", ALPHA);
    sr(&fx2, "b", 60, 2, "machine-two", "branch-y", BETA);
    or(&fx2, "o1", 70, 3, ALPHA);
    or(&fx2, "o2", 40, 2, BETA);
    let c2 = fx2.copy("c.db");
    assert_eq!(
        repair::execute(&fx2.apply_opts(&["--coarse"], &c2))
            .unwrap()
            .code,
        exit::OK
    );
    let (code, v) = q(&fx2.store, ALPHA);
    assert_eq!(code, Some(0), "{v}");
    println!(
        "QUERY_EMPTY unattributed={} rows={}",
        v["unattributed"], v["rows"]
    );
}

fn new_rows(fx: &Fx) -> Vec<(String, i64, Option<String>)> {
    let c = Fx::conn(&fx.store);
    let mut st = c
        .prepare(
            "SELECT id, hour_ms, repo FROM usage WHERE id LIKE 'repair1126:%' ORDER BY hour_ms",
        )
        .unwrap();
    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

#[test]
fn one_coarse_group_short_in_two_hours_gets_two_new_rows() {
    let _g = common_serial();
    let fx = Fx::new();
    // The same (harness, model, precision) and repo, short in two hours of one run: the new
    // rows' ids must differ (the hour is part of the id), or the second INSERT collides.
    let h9 = "2026-11-08T11:00:00Z";
    for h in [H8, h9] {
        Fx::put_full(
            &fx.store,
            &format!("s{h}"),
            "dsh-tui",
            h,
            cols(CR, 40),
            3,
            None,
            "machine-one",
            Some("branch-x"),
            Some(ALPHA),
        );
        Fx::put_full(
            &fx.oracle,
            &format!("o{h}"),
            "dsh-tui",
            h,
            cols(CR, 65),
            3,
            None,
            "machine-scratch",
            Some("branch-z"),
            Some(ALPHA),
        );
    }
    let d = repair::execute(&fx.opts(&["--coarse"])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert_eq!(d.report.total_change(), 50);
    let c = fx.copy("c.db");
    let d = repair::execute(&fx.apply_opts(&["--coarse"], &c)).unwrap();
    assert_eq!(d.code, exit::OK);
    let rows = new_rows(&fx);
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_ne!(rows[0].0, rows[1].0, "the two new rows share an id");
    assert_eq!(Fx::col(&fx.store, "dsh-tui", H8, CR), 65);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", h9, CR), 65);
    assert_eq!(
        repair::execute(&fx.apply_opts(&["--coarse"], &c))
            .unwrap()
            .code,
        exit::NOTHING
    );
}

#[test]
fn the_new_rows_repo_is_the_stores_own_label_when_it_carries_the_old_name() {
    let _g = common_serial();
    let fx = Fx::new();
    // The alias maps the oracle's name to the store's; here the STORE's row carries the old name
    // (the alias's left side) and the oracle the new one. The new row takes the store's label.
    let old = "example.test/si/alpha";
    sr(&fx, "a", 40, 3, "machine-one", "branch-x", old);
    or(&fx, "o1", 65, 3, "example.test/dev/alpha");
    let alias = "example.test/si/=example.test/dev/";
    let d = repair::execute(&fx.opts(&["--coarse", "--repo-alias", alias])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert_eq!(
        d.report.to_json(d.code)["top_ups"][0]["receiving_row"]["repo"],
        old
    );
    let c = fx.copy("c.db");
    repair::execute(&fx.apply_opts(&["--coarse", "--repo-alias", alias], &c)).unwrap();
    assert_eq!(new_rows(&fx)[0].2.as_deref(), Some(old));
}

#[test]
fn a_short_row_before_from_stays_out_of_the_day_transaction() {
    let _g = common_serial();
    let fx = Fx::new();
    // Same day: 12:00 is short with evidence above its rollup (damage, before --from), 13:00 is
    // short and in the range. The run covers 13:00 only: the day's transaction must not look at
    // 12:00 (its evidence would fail the day).
    let (h12, h13) = ("2026-11-10T12:00:00Z", "2026-11-10T13:00:00Z");
    for (h, st, or_) in [(h12, 10, 20), (h13, 10, 25)] {
        Fx::put_full(
            &fx.store,
            &format!("s{h}"),
            "dsh-tui",
            h,
            cols(CR, st),
            1,
            None,
            "machine-one",
            Some("branch-x"),
            Some(ALPHA),
        );
        Fx::put_full(
            &fx.oracle,
            &format!("o{h}"),
            "dsh-tui",
            h,
            cols(CR, or_),
            1,
            None,
            "machine-scratch",
            Some("branch-z"),
            Some(ALPHA),
        );
    }
    Fx::conn(&fx.store)
        .execute(
            "INSERT INTO evidence(ts_ms, dim, actor, cache_read) VALUES (?1, 0, 0, 500)",
            rusqlite::params![hour(h12) + 5],
        )
        .unwrap();
    let args = ["--coarse", "--from", h13, "--until", "2026-11-10T14:00:00Z"];
    let c = fx.copy("c.db");
    let d = repair::execute(&fx.apply_opts(&args, &c)).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert_eq!(Fx::col(&fx.store, "dsh-tui", h13, CR), 25);
    assert_eq!(Fx::col(&fx.store, "dsh-tui", h12, CR), 10);
}

#[test]
fn an_alias_without_a_trailing_slash_matches_the_whole_label_only() {
    let _g = common_serial();
    let fx = Fx::new();
    // Alias "example.test/si=example.test/dev" (no slash): not a prefix. The oracle's
    // example.test/six/alpha must not become example.test/devx/alpha, the store's other repo.
    sr(
        &fx,
        "a",
        40,
        3,
        "machine-one",
        "branch-x",
        "example.test/devx/alpha",
    );
    or(&fx, "o1", 65, 3, "example.test/six/alpha");
    let alias = "example.test/si=example.test/dev";
    let d = repair::execute(&fx.opts(&["--coarse", "--repo-alias", alias])).unwrap();
    assert_eq!(d.code, exit::OK, "{}", d.report.to_text(d.code));
    assert!(d.report.to_json(d.code)["top_ups"][0]["receiving_row"]["repo"].is_null());
    // And an exact label still maps.
    let fx = Fx::new();
    sr(
        &fx,
        "a",
        40,
        3,
        "machine-one",
        "branch-x",
        "example.test/dev",
    );
    or(&fx, "o1", 65, 3, "example.test/si");
    let d = repair::execute(&fx.opts(&["--coarse", "--repo-alias", alias])).unwrap();
    assert_eq!(
        d.report.to_json(d.code)["top_ups"][0]["receiving_row"]["repo"],
        "example.test/dev"
    );
}
