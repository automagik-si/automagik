//! The query's actors (RFC 0021 delivery 6): `--by bot`, `attribution.actor`,
//! `actor_unattributed` with `absent_bot_is_zero`, and the evidence backfill that recomputes
//! attribution. The examples themselves are compared in `tests/query.rs`; these are the delivery's
//! Check and the rules around it. Synthetic fixtures only: every id, bot, path and number is made
//! up.

mod common;
mod scenes;

use common::serial;
use meter::evidence;
use scenes::{
    H, MACHINE, OTHER_CORE, ROOT, SYNCED, Scene, Start, Usage, args, at, hours, labelled,
    session_row, t, worker, wt,
};
use serde_json::Value;

fn answer(s: &Scene, by_bot: bool, branches: &[&str]) -> Value {
    let (code, raw) = s.query(&args(by_bot, branches));
    assert_eq!(code, 0, "{raw}");
    serde_json::from_str(&raw).unwrap()
}

fn int(v: &Value) -> i64 {
    v.as_i64().unwrap_or_else(|| panic!("not an integer: {v}"))
}

fn counts(row: &Value) -> [i64; 4] {
    let a = &row["attribution"]["actor"];
    [
        "tokens_attributed",
        "tokens_ambiguous",
        "tokens_unlinked",
        "tokens_before_evidence",
    ]
    .map(|k| int(&a[k]))
}

fn reasons(v: &Value) -> Vec<(String, String, i64)> {
    v["actor_unattributed"]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["reason"].as_str().unwrap().to_string(),
                p["state"].as_str().unwrap().to_string(),
                int(&p["tokens_total"]),
            )
        })
        .collect()
}

// Check (delivery 6): a window straddling evidence_from puts the part before it in
// tokens_before_evidence, and the four counts add up to tokens.total. The part before is never
// attributed, even where a frozen rollup names a bot.
#[test]
fn a_window_straddling_evidence_from_counts_the_part_before_it_and_the_counts_add_up() {
    let s = scenes::straddling();
    let v = answer(&s, false, &["feat/gn-12-cache"]);
    assert_eq!(v["ingestion"]["evidence_from"], "2026-10-25T00:00:00Z");
    assert!(v["window"]["start"].as_str().unwrap() < "2026-10-25");
    let row = &v["rows"][0];
    let c = counts(row);
    assert_eq!(c, [1_678_000, 0, 0, 940_000]);
    assert_eq!(c.iter().sum::<i64>(), int(&row["tokens"]["total"]));
    // The frozen rows name otter; none of their tokens is in otter's bot row.
    let bots = answer(&s, true, &[]);
    let otter: i64 = bots["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["bot"] == "otter")
        .map(|r| int(&r["tokens"]["total"]))
        .sum();
    assert_eq!(otter, 1_500_000, "only the evidence-backed session");
    assert_eq!(
        int(&bots["actor_unattributed"]["tokens_before_evidence"]),
        1_090_000
    );
}

// Check (delivery 6): a dsh-tui worker's filled branch counts under ledger, a Claude worker's
// logged branch under log, on the branch row and on each bot row.
#[test]
fn a_dsh_tui_workers_filled_branch_is_ledger_and_a_claude_workers_logged_one_is_log() {
    let s = scenes::ledger_branch();
    let v = answer(&s, false, &["feat/gn-31-sync"]);
    let b = &v["rows"][0]["attribution"]["actor"]["tokens_by_branch_basis"];
    assert_eq!(
        (int(&b["log"]), int(&b["ledger"]), int(&b["none"])),
        (1_060_000, 1_641_000, 0)
    );
    let bots = answer(&s, true, &["feat/gn-31-sync"]);
    for r in bots["rows"].as_array().unwrap() {
        let b = &r["attribution"]["actor"]["tokens_by_branch_basis"];
        let total = int(&r["tokens"]["total"]);
        match r["harness"].as_str().unwrap() {
            "claude-code" => assert_eq!(int(&b["log"]), total),
            "dsh-tui" => assert_eq!(int(&b["ledger"]), total),
            h => panic!("no row expected for {h}"),
        }
    }
    assert_eq!(bots["rows"].as_array().unwrap().len(), 2);
}

// Check (delivery 6): a store before evidence_from (none kept yet) gives no attributed count and
// no bot: every token is before evidence, an absent bot is unknown (never a 0), and a store from
// before schema 3 is refused with no actor field at all.
#[test]
fn a_store_before_evidence_names_no_bot_and_never_vouches_for_an_absent_one() {
    let s = scenes::no_evidence();
    let v = answer(&s, false, &["feat/gn-12-cache"]);
    assert_eq!(v["ingestion"]["evidence_from"], Value::Null);
    let row = &v["rows"][0];
    assert_eq!(counts(row), [0, 0, 0, int(&row["tokens"]["total"])]);
    let bots = answer(&s, true, &[]);
    assert_eq!(bots["rows"], serde_json::json!([]));
    assert_eq!(bots["actor_unattributed"]["absent_bot_is_zero"], false);
    assert_eq!(
        int(&bots["actor_unattributed"]["tokens_before_evidence"]),
        int(&bots["actor_unattributed"]["tokens_total"])
    );
    // A schema 2 store: the query refuses it (only sync migrates), with no actor field.
    let old = scenes::Scene::migrated("2026-09-11T23:30:00Z", &[]);
    old.store().set_meta("schema_version", "2").unwrap();
    let (code, raw) = old.query(&args(true, &[]));
    assert_eq!(code, 13, "{raw}");
    let v: Value = serde_json::from_str(&raw).unwrap();
    assert!(v.get("actor_unattributed").is_none() && v["rows"] == serde_json::json!([]));
}

// absent_bot_is_zero: true only in a bot answer with nothing given to no bot and every zero
// condition of the whole answer; under a branch filter, usage with no branch (which could be an
// absent bot's on a branch named) makes it false even when every token has a bot.
#[test]
fn an_absent_bot_is_zero_only_in_a_bot_answer_where_every_condition_holds() {
    let s = scenes::bots();
    let flag = |v: &Value| v["actor_unattributed"]["absent_bot_is_zero"].clone();
    assert_eq!(flag(&answer(&s, true, &[])), true);
    assert_eq!(flag(&answer(&s, true, &["feat/gn-31-sync"])), true);
    assert_eq!(
        flag(&answer(&s, false, &["feat/gn-31-sync"])),
        false,
        "a branch answer"
    );
    // Every token has a bot, but an omp seat's has no branch.
    let mut s = Scene::migrated("2026-09-11T23:30:00Z", &[]);
    let c19 = t("2026-11-02T08:00:00Z");
    s.start(Start {
        kind: "seat",
        branch: None,
        ..worker("t19", "wren", "captain", "wren", "omp", ROOT, "", c19)
    });
    s.snapshot.push(labelled("t19", c19, "omp", ROOT, "o-wren"));
    s.add(
        Usage::new(
            H::Omp,
            "o-wren",
            ROOT,
            None,
            at(&["2026-11-03T08", "2026-11-04T08"]),
        )
        .tokens([3000, 25000, 0, 0, 2000, 0]),
    );
    s.add(
        Usage::new(
            H::Claude,
            "s-wren",
            ROOT,
            Some("main"),
            at(&["2026-11-03T09"]),
        )
        .tokens([1000, 9000, 0, 0, 500, 0]),
    );
    s.ledger_row(session_row("t19", c19, "s-wren", "claude", c19 + 60_000));
    s.sync();
    let all = answer(&s, true, &[]);
    assert_eq!(int(&all["actor_unattributed"]["tokens_total"]), 0);
    assert_eq!(flag(&all), true);
    let filtered = answer(&s, true, &["main"]);
    assert!(int(&filtered["unattributed"]["tokens_total"]) > 0);
    assert_eq!(flag(&filtered), false);
    for r in filtered["rows"].as_array().unwrap() {
        assert_eq!(r["attribution"]["coverage"], "partial");
    }
    // A stopped sync's backlog: unknown, never 0.
    let b = scenes::bots_backlog();
    assert_eq!(flag(&answer(&b, true, &[])), false);
}

// D5's reasons: a session that another computer's records name is other_machine, whether a
// start row of another core or a session label on a linked machine's pane says so; a dsh-tui
// session nothing claims is dsh_tui_seat; anything else no_record.
#[test]
fn usage_given_to_no_bot_says_why() {
    let mut s = Scene::migrated("2026-09-11T23:30:00Z", &[]);
    let c = t("2026-11-01T08:00:00Z");
    s.start(Start {
        kind: "seat",
        session: Some("s-ledger-away"),
        branch: None,
        core: OTHER_CORE,
        ..worker("t3", "swift", "captain", "swift", "claude", ROOT, "", c)
    });
    // A pane hc lists on a linked machine (its address holds a `/`).
    s.snapshot
        .push(labelled("peer/t4", c, "claude-code", ROOT, "s-label-away"));
    for (h, session, tokens) in [
        (H::Claude, "s-ledger-away", 1000),
        (H::Claude, "s-label-away", 2000),
        (H::Claude, "s-nobody", 4000),
        (H::Dsh, "d-root", 8000),
        (H::Omp, "o-root", 16000),
    ] {
        let branch = (h == H::Claude).then_some("main");
        s.add(
            Usage::new(h, session, ROOT, branch, at(&["2026-11-02T10"]))
                .tokens([tokens, 0, 0, 0, 0, 0]),
        );
    }
    s.sync();
    let v = answer(&s, true, &[]);
    assert_eq!(
        reasons(&v),
        [
            ("no_record".into(), "unlinked".into(), 20000),
            ("dsh_tui_seat".into(), "unlinked".into(), 8000),
            ("other_machine".into(), "unlinked".into(), 3000),
        ]
    );
    assert_eq!(v["rows"], serde_json::json!([]));
    // The machine's own core stays this machine's.
    assert_eq!(v["machine"]["id"], MACHINE);
}

// The Reviewer's M1 on PR 875: a start row's bot, role and squad are printed, and the contract
// caps each at 64 characters. A bot past the cap is a record that cannot be read (its calls are
// ambiguous, never under a shortened name another bot could share); a role or squad past it is
// unrecorded. Either way the answer is one the schema accepts.
#[test]
fn a_tag_past_the_contracts_cap_is_never_printed_or_cut_short() {
    let long = |c: char| c.to_string().repeat(300);
    let (bot, role, squad) = (long('b'), long('r'), long('s'));
    let mut s = Scene::migrated("2026-09-11T23:30:00Z", &[]);
    let (w41, w42) = (wt("gn-41"), wt("gn-42"));
    let c = t("2026-11-01T08:00:00Z");
    s.start(worker(
        "t41",
        &bot,
        "dev",
        "lark",
        "claude",
        &w41,
        "feat/gn-41",
        c,
    ));
    s.start(worker(
        "t42",
        "kite",
        &role,
        &squad,
        "claude",
        &w42,
        "feat/gn-42",
        c,
    ));
    s.add(
        Usage::new(
            H::Claude,
            "s-41",
            &w41,
            Some("feat/gn-41"),
            at(&["2026-11-02T10"]),
        )
        .tokens([1000, 0, 0, 0, 0, 0]),
    );
    s.add(
        Usage::new(
            H::Claude,
            "s-42",
            &w42,
            Some("feat/gn-42"),
            at(&["2026-11-02T11"]),
        )
        .tokens([2000, 0, 0, 0, 0, 0]),
    );
    s.sync();
    let schema = common::schema::Schema::new(
        serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../schema/query/v1/envelope.schema.json"),
            )
            .unwrap(),
        )
        .unwrap(),
    );
    for (by_bot, branches) in [(true, vec![]), (false, vec!["feat/gn-41", "feat/gn-42"])] {
        let v = answer(&s, by_bot, &branches);
        let e = schema.errors(&v);
        assert!(e.is_empty(), "the answer breaks the schema: {e:?}\n{v}");
    }
    let v = answer(&s, true, &[]);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{v}");
    let kite = &rows[0];
    assert_eq!(kite["bot"], "kite");
    assert_eq!(kite["role"], Value::Null);
    assert_eq!(kite["squad"], Value::Null);
    assert_eq!(kite["unrecorded"], serde_json::json!(["role", "squad"]));
    assert_eq!(int(&kite["tokens"]["total"]), 2000);
    assert_eq!(
        reasons(&v),
        [("claimants_differ".into(), "ambiguous".into(), 1000)]
    );
}

/// Makes the store one a meter before RFC 0021 delivery 6 (PR 849 alone) wrote: its ambiguous and
/// unlinked rollups keyed without their reason (that meter's ids) and holding none, and with
/// `drop_reason`, no `reason` column at all, as that meter's schema 3 made the table. Unless
/// `keyed` (a store this meter re-keyed, then an older meter wrote again: a downgrade), it has
/// never been re-keyed.
fn as_older(s: &Scene, drop_reason: bool, keyed: bool) {
    let rows = s.store().rows_since(i64::MIN).unwrap();
    let c = rusqlite::Connection::open(s.env.state().join("meter.db")).unwrap();
    for r in rows {
        if r.key.attr.as_ref().is_none_or(|a| a.reason.is_none()) {
            continue;
        }
        let mut k = r.key.clone();
        if let Some(a) = k.attr.as_mut() {
            a.reason = None;
        }
        let p = if r.precision == "total_only" {
            meter::event::Precision::TotalOnly
        } else {
            meter::event::Precision::Exact
        };
        c.execute(
            "UPDATE usage SET id = ?1, reason = NULL WHERE id = ?2",
            rusqlite::params![k.id(p), r.id],
        )
        .unwrap();
    }
    if drop_reason {
        c.execute_batch("ALTER TABLE usage DROP COLUMN reason")
            .unwrap();
    }
    if !keyed {
        c.execute(
            "DELETE FROM meta WHERE k = ?1",
            [evidence::REASON_KEYED_META],
        )
        .unwrap();
    }
}

/// Two unlinked calls (3,300 tokens between them) of a session no launch names yet, in a worker's
/// worktree, and an ambiguous call (700 tokens: two workers started in its folder), on a store an
/// 849 meter wrote; then the first worker's start row, which a later sync learns.
fn upgraded(drop_reason: bool) -> Scene {
    upgraded_with(drop_reason, false)
}

fn upgraded_with(drop_reason: bool, keyed: bool) -> Scene {
    let mut s = Scene::migrated("2026-09-11T23:30:00Z", &[]);
    let (w, w52) = (wt("gn-51"), wt("gn-52"));
    let c = t("2026-11-01T08:00:00Z");
    s.start(worker(
        "t52",
        "heron",
        "dev",
        "lark",
        "claude",
        &w52,
        "feat/gn-52",
        c,
    ));
    s.start(worker(
        "t53",
        "kite",
        "review",
        "lark",
        "claude",
        &w52,
        "feat/gn-52",
        c,
    ));
    s.add(
        Usage::new(
            H::Claude,
            "s-52",
            &w52,
            Some("feat/gn-52"),
            at(&["2026-11-02T12"]),
        )
        .tokens([700, 0, 0, 0, 0, 0]),
    );
    s.add(
        Usage::new(
            H::Claude,
            "s-51",
            &w,
            Some("feat/gn-51"),
            at(&["2026-11-02T10", "2026-11-02T11"]),
        )
        .tokens([1000, 2000, 0, 0, 300, 0]),
    );
    s.sync();
    as_older(&s, drop_reason, keyed);
    s.start(worker(
        "t51",
        "otter",
        "dev",
        "lark",
        "claude",
        &w,
        "feat/gn-51",
        c,
    ));
    s
}

// The upgrade path (Fixer's review of PR 875): an 849 meter keyed an unlinked call's rollup without
// its reason. When this meter learns the call's launch, it takes the call out of that row (whose
// id it no longer derives) rather than adding it again: totals never change.
#[test]
fn a_call_an_849_meter_counted_moves_once_when_its_launch_is_learned() {
    let mut s = upgraded(false);
    let before = totals(&s);
    assert_eq!(before.total(), 3300 + 700);
    let r = s.sync();
    assert_eq!(
        totals(&s).total(),
        before.total(),
        "a move never changes a total (moved {}, refused {})",
        r.calls_moved,
        r.calls_refused
    );
    assert_eq!((r.calls_moved, r.calls_refused), (2, 0));
    assert_eq!(totals(&s), before);
    assert_rollups_agree(&s);
    let v = answer(&s, true, &[]);
    // The 849 meter's ambiguous row (no reason) reads as claimants_differ, as that meter meant.
    assert_eq!(
        reasons(&v),
        [("claimants_differ".into(), "ambiguous".into(), 700)]
    );
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{v}");
    assert_eq!(rows[0]["bot"], "otter");
    assert_eq!(int(&rows[0]["tokens"]["total"]), 3300);
}

/// Copies each reason-less ambiguous or unlinked rollup under the id this meter derives for it
/// (its reason included), as a pre-fix build of PR 875 could leave a store: one row under both ids.
fn under_both_ids(s: &Scene) -> usize {
    let rows = s.store().rows_since(i64::MIN).unwrap();
    let c = rusqlite::Connection::open(s.env.state().join("meter.db")).unwrap();
    let mut n = 0;
    for r in rows {
        let Some(a) = r.key.attr.as_ref() else {
            continue;
        };
        if a.reason.is_some() || !["ambiguous", "unlinked"].contains(&a.state.as_str()) {
            continue;
        }
        let mut k = r.key.clone();
        if let Some(a) = k.attr.as_mut() {
            a.reason = Some(
                if a.state == "ambiguous" {
                    "claimants_differ"
                } else {
                    "no_record"
                }
                .into(),
            );
        }
        let p = if r.precision == "total_only" {
            meter::event::Precision::TotalOnly
        } else {
            meter::event::Precision::Exact
        };
        let reason = k.attr.as_ref().unwrap().reason.clone();
        c.execute_batch("CREATE TEMP TABLE dup AS SELECT * FROM usage WHERE 0")
            .unwrap();
        c.execute("INSERT INTO dup SELECT * FROM usage WHERE id = ?1", [&r.id])
            .unwrap();
        c.execute(
            "UPDATE dup SET id = ?1, reason = ?2",
            rusqlite::params![k.id(p), reason],
        )
        .unwrap();
        c.execute_batch("INSERT INTO usage SELECT * FROM dup; DROP TABLE dup;")
            .unwrap();
        n += 1;
    }
    n
}

// The Reviewer's M1 on cf79aedb: a store holding a rollup under both ids (the older build's and
// this one's) takes the re-key's merge, which keeps every total; and the sync that re-keys keeps a
// counted generation first (RFC 0018 (d)), as any rewrite of a store's rows does.
#[test]
fn a_rekey_merges_a_row_under_both_ids_behind_a_generation() {
    let mut s = upgraded(false);
    assert_eq!(under_both_ids(&s), 3);
    let before = totals(&s);
    let r = s.sync();
    assert!(r.generation.is_some(), "the re-key kept no generation");
    assert_eq!(r.rekeyed, (3, 3));
    assert_eq!(totals(&s), before, "a re-key never changes a total");
    let left: i64 = s
        .store()
        .conn
        .query_row(
            "SELECT count(*) FROM usage WHERE reason IS NULL
             AND actor_state IN ('ambiguous', 'unlinked')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
    // The next sync has nothing to re-key, and keeps no new generation for it.
    let r = s.sync();
    assert_eq!(r.rekeyed, (0, 0));
}

// A store this meter re-keyed, then an older meter wrote again (a downgrade, then back): its rows
// under the older ids are not re-keyed twice, and a move still takes each call out of the row
// that holds it, by the older id. Totals never change.
#[test]
fn a_call_an_older_meter_counted_after_the_rekey_still_moves_once() {
    let mut s = upgraded_with(false, true);
    let before = totals(&s);
    let r = s.sync();
    assert_eq!((r.calls_moved, r.calls_refused), (2, 0));
    assert_eq!(totals(&s), before);
    let v = answer(&s, true, &[]);
    assert_eq!(v["rows"][0]["bot"], "otter");
    assert_eq!(int(&v["rows"][0]["tokens"]["total"]), 3300);
}

// A call no rollup row holds (a row lost, or changed by hand) is never added again when its
// attribution changes: it stays where it is, and the sync counts it as refused.
#[test]
fn a_call_no_row_holds_is_refused_never_counted_twice() {
    let mut s = upgraded(false);
    drop(s.store());
    rusqlite::Connection::open(s.env.state().join("meter.db"))
        .unwrap()
        .execute("DELETE FROM usage WHERE actor_state = 'unlinked'", [])
        .unwrap();
    let before = totals(&s);
    assert_eq!(before.total(), 700);
    let r = s.sync();
    assert_eq!((r.calls_moved, r.calls_refused), (0, 2));
    assert_eq!(totals(&s), before);
}

// The Reviewer's L3 on PR 875: on one branch row, a session two workers' folder holds is
// ambiguous and a session in a folder no launch started is unlinked, and the row keeps them
// apart.
#[test]
fn a_branch_row_tells_ambiguous_from_unlinked() {
    let mut s = Scene::migrated("2026-09-11T23:30:00Z", &[]);
    let (w, lone) = (wt("gn-71"), wt("gn-71u"));
    let b = "feat/gn-71";
    let c = t("2026-11-01T08:00:00Z");
    s.start(worker("t71", "heron", "dev", "lark", "claude", &w, b, c));
    s.start(worker("t72", "kite", "review", "lark", "claude", &w, b, c));
    s.add(
        Usage::new(H::Claude, "s-71a", &w, Some(b), at(&["2026-11-02T10"]))
            .tokens([700, 0, 0, 0, 0, 0]),
    );
    s.add(
        Usage::new(H::Claude, "s-71u", &lone, Some(b), at(&["2026-11-02T11"]))
            .tokens([300, 0, 0, 0, 0, 0]),
    );
    s.sync();
    let v = answer(&s, false, &[b]);
    assert_eq!(counts(&v["rows"][0]), [0, 700, 300, 0]);
    assert_eq!(
        reasons(&v),
        [
            ("claimants_differ".into(), "ambiguous".into(), 700),
            ("no_record".into(), "unlinked".into(), 300)
        ]
    );
}

// The Fixer's Low (a) on PR 875: an attributed rollup whose bot key cannot be read (no bot, or a
// kind that is neither worker nor seat) names no bot row, so it counts as ambiguous: every token
// lands somewhere, the bot rows and actor_unattributed add up to the repo's total, and each branch
// row's four counts add up to its total.
#[test]
fn an_attributed_row_with_no_readable_bot_still_counts() {
    let mut s = Scene::migrated("2026-09-11T23:30:00Z", &[]);
    let c = t("2026-11-01T08:00:00Z");
    for (i, (term, bot, tokens)) in [
        ("t61", "kite", 1000),
        ("t62", "otter", 2000),
        ("t63", "heron", 3000),
    ]
    .into_iter()
    .enumerate()
    {
        let w = wt(&format!("gn-6{}", i + 1));
        let b = format!("feat/gn-6{}", i + 1);
        s.start(worker(term, bot, "dev", "lark", "claude", &w, &b, c));
        s.add(
            Usage::new(
                H::Claude,
                &format!("s-6{}", i + 1),
                &w,
                Some(&b),
                at(&["2026-11-02T10"]),
            )
            .tokens([tokens, 0, 0, 0, 0, 0]),
        );
    }
    s.sync();
    let c2 = rusqlite::Connection::open(s.env.state().join("meter.db")).unwrap();
    c2.execute_batch(
        "UPDATE usage SET bot = NULL WHERE bot = 'kite';
         UPDATE usage SET kind = 'pane' WHERE bot = 'otter';",
    )
    .unwrap();
    drop(c2);
    let v = answer(&s, true, &[]);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{v}");
    assert_eq!(rows[0]["bot"], "heron");
    assert_eq!(
        reasons(&v),
        [("claimants_differ".into(), "ambiguous".into(), 3000)]
    );
    let bots: i64 = rows.iter().map(|r| int(&r["tokens"]["total"])).sum();
    assert_eq!(
        bots + int(&v["actor_unattributed"]["tokens_total"]),
        totals(&s).total()
    );
    let v = answer(&s, false, &["feat/gn-61", "feat/gn-62", "feat/gn-63"]);
    for row in v["rows"].as_array().unwrap() {
        assert_eq!(
            counts(row).iter().sum::<i64>(),
            int(&row["tokens"]["total"]),
            "{row}"
        );
    }
    assert_eq!(counts(&v["rows"][0]), [0, 1000, 0, 0]);
    assert_eq!(counts(&v["rows"][1]), [0, 2000, 0, 0]);
    assert_eq!(counts(&v["rows"][2]), [3000, 0, 0, 0]);
}

// The same store as that meter left it, with no `reason` column: the query reads it as it was,
// and the next sync adds the column at the same schema version, then moves each call once.
#[test]
fn a_store_an_849_meter_left_without_reasons_still_answers_and_syncs() {
    let mut s = upgraded(true);
    let v = answer(&s, false, &["feat/gn-51"]);
    assert_eq!(
        int(&v["rows"][0]["attribution"]["actor"]["tokens_unlinked"]),
        3300
    );
    // Rows with no reason read as that meter meant them: ambiguous is claimants_differ, unlinked
    // no_record.
    assert_eq!(
        reasons(&v),
        [
            ("claimants_differ".into(), "ambiguous".into(), 700),
            ("no_record".into(), "unlinked".into(), 3300)
        ]
    );
    let r = s.sync();
    assert_eq!((r.calls_moved, r.calls_refused), (2, 0));
    assert_eq!(totals(&s).total(), 3300 + 700);
    assert_rollups_agree(&s);
    assert_eq!(
        s.store().meta("schema_version").unwrap().as_deref(),
        Some("3")
    );
}

/// otter's Claude Code session on `feat/gn-40-old`, run before 10-25 and again after, with no
/// ledger yet: its calls are unlinked. Then the retention bound drops the evidence before 10-25,
/// as the size bound would, so those hours are before evidence.
fn pruned() -> Scene {
    pruned_with(false)
}

/// [`pruned`], with `codex`: a Codex thread in the same folder on 10-14 (4,600 tokens), whose
/// evidence the bound drops too and which no backfill can re-read.
fn pruned_with(codex: bool) -> Scene {
    let mut s = Scene::migrated("2026-09-11T23:30:00Z", &[]);
    let w = wt("gn-40");
    if codex {
        s.add(
            Usage::new(
                H::Codex,
                "c-old",
                &w,
                Some("feat/gn-40-old"),
                at(&["2026-10-14T09"]),
            )
            .tokens([4000, 0, 0, 0, 600, 0]),
        );
    }
    s.add(
        Usage::new(
            H::Claude,
            "s-old",
            &w,
            Some("feat/gn-40-old"),
            hours("2026-10-12T10:00:00Z", "2026-10-20T10:00:00Z", 5),
        )
        .tokens([5000, 50000, 1000, 0, 2000, 100]),
    );
    s.add(
        Usage::new(
            H::Dsh,
            "d-old",
            &w,
            None,
            at(&["2026-10-15T09", "2026-11-03T09"]),
        )
        .tokens([7000, 70000, 0, 0, 3000, 0]),
    );
    s.add(
        Usage::new(
            H::Claude,
            "s-new",
            &w,
            Some("feat/gn-40-old"),
            hours("2026-11-01T10:00:00Z", "2026-11-05T10:00:00Z", 3),
        )
        .tokens([3000, 30000, 0, 0, 1000, 0]),
    );
    s.sync();
    let store = s.store();
    let tx = store.conn.unchecked_transaction().unwrap();
    evidence::prune(&tx, t(SYNCED), 15, u64::MAX).unwrap();
    tx.commit().unwrap();
    assert_eq!(
        store.meta_i64(evidence::FROM_META).unwrap(),
        Some(t("2026-10-25T00:00:00Z"))
    );
    drop(store);
    // The worker's start row is learned now: its sessions and its worktree.
    s.start(Start {
        session: Some("s-old"),
        ..worker(
            "t40",
            "otter",
            "dev",
            "lark",
            "claude",
            &w,
            "feat/gn-40-old",
            t("2026-10-01T08:00:00Z"),
        )
    });
    s.start(worker(
        "t41",
        "otter",
        "dev",
        "lark",
        "dsh-tui",
        &w,
        "feat/gn-40-old",
        t("2026-10-01T09:00:00Z"),
    ));
    s.ledger_row(session_row(
        "t40",
        t("2026-10-01T08:00:00Z"),
        "s-new",
        "claude",
        t("2026-10-31T08:00:00Z"),
    ));
    s
}

fn totals(s: &Scene) -> meter::event::Tokens {
    let mut sum = meter::event::Tokens::default();
    for r in s.store().rows_since(i64::MIN).unwrap() {
        sum.add(&r.tokens);
    }
    sum
}

fn assert_rollups_agree(s: &Scene) {
    let store = s.store();
    let from = store.meta_i64(evidence::FROM_META).unwrap().unwrap();
    let implied = evidence::implied_rollups(&store.conn).unwrap();
    let stored: std::collections::BTreeMap<_, _> = evidence::stored_rollups(&store.conn, from)
        .unwrap()
        .into_iter()
        .collect();
    assert_eq!(implied, stored);
}

// The backfill (RFC 0021 (c), operator-run): it gives the hours before evidence_from their
// evidence from the logs still on disk, recomputes the attribution of every call from its start,
// and never changes a total; actor_unattributed falls for the backfilled hours.
#[test]
fn the_evidence_backfill_recomputes_attribution_and_keeps_every_total() {
    let mut s = pruned();
    let before = totals(&s);
    // The ledger alone moves only the calls with evidence.
    s.sync();
    let v = answer(&s, true, &[]);
    // s-old's five calls, and the first of d-old's two (the other is after 10-25).
    let old_part = 58000 + 40000;
    assert_eq!(
        int(&v["actor_unattributed"]["tokens_before_evidence"]),
        old_part
    );
    assert_eq!(totals(&s), before);

    let r = s.sync_with(|o| o.evidence_backfill = Some(30));
    let b = r.evidence_backfill.expect("a backfill ran");
    assert!(b.done, "{b:?}");
    assert_eq!(b.from_ms, t("2026-10-10T00:00:00Z"));
    assert_eq!((b.adopted, b.left_alone), (6, 0));
    assert_eq!(totals(&s), before, "a backfill never changes a total");
    assert_rollups_agree(&s);
    let store = s.store();
    assert_eq!(
        store.meta_i64(evidence::FROM_META).unwrap(),
        Some(b.from_ms)
    );
    assert_eq!(store.meta(evidence::BACKFILL_META).unwrap(), None);
    assert_eq!(store.count("evidence").unwrap(), 5 + 2 + 3);
    drop(store);
    let v = answer(&s, true, &[]);
    assert_eq!(int(&v["actor_unattributed"]["tokens_total"]), 0);
    assert_eq!(v["actor_unattributed"]["absent_bot_is_zero"], true);
    let by: Vec<(String, i64)> = v["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["harness"].as_str().unwrap().into(),
                int(&r["tokens"]["total"]),
            )
        })
        .collect();
    assert_eq!(
        by,
        [
            ("claude-code".into(), 58000 + 34000),
            ("dsh-tui".into(), 80000)
        ]
    );
    // dsh-tui's old call takes its worker's branch too, now that it has a launch.
    let row = answer(&s, false, &["feat/gn-40-old"]);
    assert_eq!(int(&row["unattributed"]["tokens_total"]), 0);

    // Done: a later sync does nothing more of it.
    let r = s.sync_with(|_| {});
    assert!(r.evidence_backfill.is_none());
}

// The Reviewer's L2 on PR 875: a Codex thread's evidence that a retention bound pruned cannot be
// re-read (its deltas carry no request identity), so once a backfill moves evidence_from back
// over its hour, its rollup counts as before evidence, never as unlinked or attributed with no
// evidence behind it. Totals never change, and the rollups agree with the evidence.
#[test]
fn a_backfill_counts_pruned_codex_usage_before_evidence() {
    let mut s = pruned_with(true);
    let before = totals(&s);
    s.sync();
    let r = s.sync_with(|o| o.evidence_backfill = Some(30));
    let b = r.evidence_backfill.expect("a backfill ran");
    assert!(b.done, "{b:?}");
    assert_eq!((b.adopted, b.unbacked), (6, 1));
    assert_eq!(totals(&s), before, "a backfill never changes a total");
    assert_rollups_agree(&s);
    let v = answer(&s, true, &[]);
    assert_eq!(
        reasons(&v),
        [("before_evidence".into(), "before_evidence".into(), 4600)]
    );
    let row = answer(&s, false, &["feat/gn-40-old"]);
    let r0 = &row["rows"][0];
    assert_eq!(counts(r0)[3], 4600, "{r0}");
    assert_eq!(counts(r0).iter().sum::<i64>(), int(&r0["tokens"]["total"]));
}

// Chunked and resumable: a backfill stopped by the budget goes on at the next sync from where it
// stopped, and ends where one run would have.
#[test]
fn a_backfill_stopped_by_its_budget_resumes_on_the_next_sync() {
    let mut once = pruned();
    once.sync_with(|o| o.evidence_backfill = Some(30));
    let want = answer(&once, true, &[]);

    let mut s = pruned();
    let before = totals(&s);
    let r = s.sync_with(|o| {
        o.evidence_backfill = Some(30);
        o.chunk_limit = Some(1);
    });
    let b = r.evidence_backfill.unwrap();
    assert!(!b.done, "{b:?}");
    assert!(s.store().meta(evidence::BACKFILL_META).unwrap().is_some());
    assert_eq!(totals(&s), before);
    let mut runs = 1;
    loop {
        let r = s.sync_with(|o| o.chunk_limit = Some(1));
        runs += 1;
        if r.evidence_backfill.is_none_or(|b| b.done) {
            break;
        }
        assert!(runs < 10);
    }
    assert!(runs >= 2);
    assert_eq!(totals(&s), before);
    assert_rollups_agree(&s);
    let mut got = answer(&s, true, &[]);
    let mut want = want;
    for v in [&mut got, &mut want] {
        v["as_of"] = Value::Null;
    }
    assert_eq!(got["rows"], want["rows"]);
    assert_eq!(got["actor_unattributed"], want["actor_unattributed"]);
}

// Frozen rollups (written before schema 3, a bot in their tag and no state) have no log to
// re-read: a backfill leaves them as they are, and they stay before evidence, never attributed.
#[test]
fn a_backfill_never_attributes_a_frozen_row() {
    let mut s = scenes::straddling();
    let before = totals(&s);
    let r = s.sync_with(|o| o.evidence_backfill = Some(30));
    assert!(r.evidence_backfill.unwrap().done);
    assert_eq!(totals(&s), before);
    let v = answer(&s, false, &["feat/gn-12-cache"]);
    assert_eq!(v["ingestion"]["evidence_from"], "2026-10-10T00:00:00Z");
    assert_eq!(counts(&v["rows"][0]), [1_678_000, 0, 0, 940_000]);
}

// Issue 1229: the hour before the original evidence_from can hold a normal sync's evidence (a
// call read from the log tail) beside a frozen rollup of the same hour. A backfill re-reads that
// call, and adoption must not write a second, identical evidence row against the frozen rollup.
#[test]
fn a_backfill_never_writes_a_second_copy_of_a_call_that_has_evidence() {
    let branch = Some("feat/gn-70-dup");
    let frozen = scenes::Frozen {
        bot: None,
        harness: "claude-code",
        model: scenes::OPUS,
        branch,
        hour: t("2026-11-08T12:00:00Z"),
        tokens: [100, 1000, 0, 0, 100, 0],
    };
    let mut s = Scene::migrated("2026-11-08T12:30:00Z", &[frozen]);
    let w = wt("gn-70");
    s.add(
        Usage::new(H::Claude, "s-dup", &w, branch, at(&["2026-11-08T12"]))
            .tokens([10, 100, 0, 0, 10, 0]),
    );
    // The call is after the migration but before evidence_from (13:00): the normal sync gives
    // it evidence, and the hour's frozen row still counts its own older calls.
    s.sync();
    let before = totals(&s);
    assert_eq!(s.store().count("evidence").unwrap(), 1);
    let r = s.sync_with(|o| o.evidence_backfill = Some(30));
    let b = r.evidence_backfill.expect("a backfill ran");
    assert!(b.done, "{b:?}");
    assert_eq!(totals(&s), before, "a backfill never changes a total");
    assert_eq!(
        s.store().count("evidence").unwrap(),
        1,
        "the call already had its evidence; the backfill wrote no duplicate"
    );
    assert_rollups_agree(&s);
}

// Issue 1229's dry-run report: `status` counts duplicate evidence rows and removes nothing. Two
// real calls with the same request id at different times are not a duplicate group.
#[test]
fn status_counts_duplicate_evidence_rows_and_removes_nothing() {
    let mut s = Scene::migrated("2026-11-08T12:30:00Z", &[]);
    let w = wt("gn-71");
    s.add(
        Usage::new(
            H::Claude,
            "s-dup-status",
            &w,
            Some("feat/gn-71"),
            at(&["2026-11-08T14"]),
        )
        .tokens([10, 100, 0, 0, 10, 0]),
    );
    s.sync();
    let store = s.store();
    let first = store
        .conn
        .query_row("SELECT min(id) FROM evidence", [], |r| r.get::<_, i64>(0))
        .unwrap();
    store
        .conn
        .execute(
            "INSERT INTO evidence(ts_ms, dim, actor, session, parent, request, cwd, session_cwd,
               copied, input_uncached, cache_read, cache_write_5m, cache_write_1h, output,
               reasoning, unsplit, reported_usd)
             SELECT ts_ms, dim, actor, session, parent, request, cwd, session_cwd, copied,
               input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning,
               unsplit, reported_usd FROM evidence WHERE id = ?1",
            [first],
        )
        .unwrap();
    let d = evidence::duplicates(&store.conn).unwrap();
    assert_eq!(
        (d.groups, d.extra_rows, d.exact_groups, d.exact_extra_rows),
        (1, 1, 1, 1)
    );
    // The same request id one hour later is another real call, not a duplicate row.
    store
        .conn
        .execute(
            "INSERT INTO evidence(ts_ms, dim, actor, session, parent, request, cwd, session_cwd,
               copied, input_uncached, cache_read, cache_write_5m, cache_write_1h, output,
               reasoning, unsplit, reported_usd)
             SELECT ts_ms + 3600000, dim, actor, session, parent, request, cwd, session_cwd,
               copied, input_uncached, cache_read, cache_write_5m, cache_write_1h, output,
               reasoning, unsplit, reported_usd FROM evidence WHERE id = ?1",
            [first],
        )
        .unwrap();
    assert_eq!(evidence::duplicates(&store.conn).unwrap().groups, 1);
    drop(store);
    let out = s
        .env
        .command()
        .env("METER_STATE_DIR", s.env.state())
        .arg("status")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["evidence"]["duplicates"]["groups"], 1);
    assert_eq!(v["evidence"]["duplicates"]["extra_rows"], 1);
    assert_eq!(v["evidence"]["duplicates"]["exact_extra_rows"], 1);
    // A status run is read-only: the rows it counted are still there.
    let store = s.store();
    assert_eq!(store.count("evidence").unwrap(), 3);
}

// --days never asks past the retention bound (RFC 0021 delivery 8's Acceptance), and the backfill
// always says how far back it goes.
#[test]
fn the_backfill_asks_no_further_back_than_the_retention() {
    let env = common::Env::new();
    let _g = serial();
    for (a, ok) in [
        (vec!["--evidence-backfill", "--days", "91"], false),
        (vec!["--evidence-backfill"], false),
        (
            vec!["--evidence-backfill", "--days", "30", "--backfill"],
            false,
        ),
    ] {
        let out = env
            .command()
            .env("METER_STATE_DIR", env.state())
            .arg("sync")
            .args(&a)
            .arg("--no-publish")
            .output()
            .unwrap();
        assert_eq!(out.status.success(), ok, "{a:?}");
        assert_eq!(out.status.code(), Some(2), "{a:?}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(
            err.contains("--days") || err.contains("--backfill"),
            "{err}"
        );
    }
    let out = env
        .command()
        .env("METER_STATE_DIR", env.state())
        .args([
            "sync",
            "--evidence-backfill",
            "--days",
            "90",
            "--no-publish",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("evidence backfill from"));
}
