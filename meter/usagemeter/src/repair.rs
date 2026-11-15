//! `usagemeter repair` (issue 1126): tops up the rollup totals of a store that lost tokens, from an
//! oracle store a person built from the frozen logs with the existing commands.
//!
//! The repair never reads a log and never subtracts. It compares the two stores' rollups per
//! (harness, hour, model, machine, repo, branch, precision), summed over actor state, and plans
//! `after = max(before, oracle)` column by column. A cell where the store holds more than the
//! oracle is kept and listed. Events never change. The recovered tokens go into the group's
//! before-evidence row when it has one, so an hour's evidence sum stays at or under its rollup.
//!
//! The default is a dry run over two read-only opens, which writes nothing. `--apply` needs a
//! verified copy (`--copy` and `--confirm-copy`), the sync lock, and writes one SQLite
//! transaction per day with a `meta` journal key.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::sources::Source;
use crate::store::SCHEMA_VERSION;
use crate::time::{DAY_MS, HOUR_MS, format_day, format_rfc3339, parse_rfc3339};

/// The token columns, in the order every array in this file uses. `unsplit` is last.
pub const COLS: [&str; 7] = [
    "input_uncached",
    "cache_read",
    "cache_write_5m",
    "cache_write_1h",
    "output",
    "reasoning",
    "unsplit",
];

/// `meta` key recording the last day a repair transaction committed. A record only: it never
/// decides which day is planned (the plan is rebuilt from the live rows).
pub const JOURNAL: &str = "repair_1126_done";
pub const DEFAULT_FROM: &str = "2026-11-07";
pub const DEFAULT_UNTIL: &str = "2026-11-10";

/// Index of `reasoning` in [`COLS`]: part of `output`, so never added to a total (crate rule,
/// `event.rs`).
const REASONING: usize = 5;

/// All tokens of a row: the six counted columns; `reasoning` is inside `output`.
fn counted(v: &[i64; 7]) -> i64 {
    v.iter().sum::<i64>() - v[REASONING]
}

pub mod exit {
    pub const OK: u8 = 0;
    pub const CONSERVATION: u8 = 1;
    pub const USAGE: u8 = 2;
    pub const NOTHING: u8 = 3;
    pub const NEWER_SCHEMA: u8 = 12;
}

#[derive(Debug, Clone)]
pub struct Copy {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct Opts {
    /// The store's state directory (holds `meter.db`), from `--store`; never defaulted.
    pub state_dir: PathBuf,
    /// The oracle's state directory.
    pub against: PathBuf,
    /// First hour (inclusive) and end (exclusive) of the range, UTC day boundaries.
    pub from_ms: i64,
    pub until_ms: i64,
    pub json: bool,
    /// `--coarse`: match on (harness, hour, model, precision) only.
    pub coarse: bool,
    /// `--repo-alias OLD=NEW` (with `--coarse`): a repo label that is the same repo under
    /// another name. OLD ending in `/` is a prefix.
    pub aliases: Vec<(String, String)>,
    pub apply: Option<Copy>,
    pub now_ms: i64,
}

/// What a run decided; `report` is the dry-run plan whatever the mode.
pub struct Done {
    pub code: u8,
    pub report: Report,
    pub applied_days: Vec<String>,
}

#[derive(Debug, Clone)]
struct Row {
    id: String,
    harness: String,
    hour: i64,
    model: String,
    machine: String,
    repo: Option<String>,
    branch: Option<String>,
    precision: String,
    state: Option<String>,
    v: [i64; 7],
    events: i64,
}

type GKey = (
    String,
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
);

#[derive(Debug, Clone)]
struct Group {
    /// How many store rows this group sums.
    rows: usize,
    /// The evidence-free row that takes a top-up; None when the group has none (every row is
    /// attributed: a top-up there would be tokens attributed to a bot with no call behind them).
    target: Option<String>,
    /// The receiving row's labels: machine, repo, branch, precision.
    labels: (String, Option<String>, Option<String>, String),
    target_rank: (i64, String),
    v: [i64; 7],
    events: i64,
}

/// The group key: (harness, hour, model, machine, repo, branch, precision). With `coarse` (the
/// `--coarse` option) the machine, repo and branch are left out: (harness, hour, model,
/// precision) only, the store's rows summed across them.
fn gkey(r: &Row, coarse: bool) -> GKey {
    (
        r.harness.clone(),
        r.hour,
        r.model.clone(),
        if coarse {
            String::new()
        } else {
            r.machine.clone()
        },
        if coarse { None } else { r.repo.clone() },
        if coarse { None } else { r.branch.clone() },
        r.precision.clone(),
    )
}

fn group(rows: &[Row], coarse: bool) -> BTreeMap<GKey, Group> {
    let mut m: BTreeMap<GKey, Group> = BTreeMap::new();
    for r in rows {
        // The row that takes a top-up: only a before-evidence row (no actor state); the biggest,
        // then the lowest id, so the choice never depends on read order.
        let rank = (-counted(&r.v), r.id.clone());
        let g = m.entry(gkey(r, coarse)).or_insert_with(|| Group {
            rows: 0,
            target: None,
            labels: Default::default(),
            target_rank: (i64::MAX, String::new()),
            v: [0; 7],
            events: 0,
        });
        if r.state.is_none() && (g.target.is_none() || rank < g.target_rank) {
            g.target = Some(r.id.clone());
            g.labels = (
                r.machine.clone(),
                r.repo.clone(),
                r.branch.clone(),
                r.precision.clone(),
            );
            g.target_rank = rank;
        }
        for (a, b) in g.v.iter_mut().zip(r.v) {
            *a += b;
        }
        g.events += r.events;
        g.rows += 1;
    }
    m
}

/// One group's planned top-up.
#[derive(Debug, Clone)]
pub struct Change {
    key: GKey,
    /// `--coarse`: the one new row this top-up is (existing rows are never changed then).
    pub new_row: Option<NewRow>,
    pub harness: String,
    pub hour: i64,
    pub day: String,
    pub id: String,
    pub before: [i64; 7],
    pub oracle: [i64; 7],
    pub after: [i64; 7],
    pub events_before: i64,
    pub events_oracle: i64,
    /// The receiving row's labels, and how many store rows its group summed.
    pub machine: String,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub precision: String,
    pub group_rows: usize,
}

/// The row a `--coarse` top-up creates: before evidence (no actor state, no bot), machine and
/// branch empty, events 0, only the added tokens. `repo` is empty when no single repo is short.
#[derive(Debug, Clone)]
pub struct NewRow {
    pub id: String,
    pub repo: Option<String>,
}

impl Change {
    /// The counted tokens this top-up adds.
    fn added(&self) -> i64 {
        counted(&self.delta())
    }

    fn delta(&self) -> [i64; 7] {
        std::array::from_fn(|i| self.after[i] - self.before[i])
    }
}

#[derive(Debug, Clone, Default)]
struct Cell {
    before: [i64; 7],
    change: [i64; 7],
    events: i64,
}

#[derive(Debug, Clone, Default)]
pub struct Report {
    pub from_day: String,
    pub until_day: String,
    pub changes: Vec<Change>,
    cells: BTreeMap<(String, String), Cell>,
    /// (harness, day) -> (hours, tokens) with store rows and no oracle rows.
    unresolved: BTreeMap<(String, String), (BTreeSet<i64>, i64)>,
    /// (harness, day, column index) -> tokens the store holds above the oracle.
    kept: BTreeMap<(String, String, usize), i64>,
    /// harness -> (groups, tokens) short outside the range: reported, never repaired.
    outside: BTreeMap<String, (usize, i64)>,
    /// (harness, day) -> (groups, short tokens): short, but the group has no evidence-free row.
    no_free: BTreeMap<(String, String), (usize, i64)>,
    /// The match used: `--coarse` (harness, hour, model, precision) or the exact key; and how
    /// many store rows in the range the groups summed (rows, groups, most rows in one group).
    pub coarse: bool,
    pub aliases: Vec<(String, String)>,
    pub group_rows: (usize, usize, usize),
    /// Hours whose evidence is above the rollup before the repair (the damage), reported.
    pub damage_hours: Vec<i64>,
    /// The store this plan is for (a path the person gave).
    pub store: String,
    pub failures: Vec<String>,
}

impl Report {
    pub fn total_change(&self) -> i64 {
        self.cells.values().map(|c| counted(&c.change)).sum()
    }
    pub fn total_before(&self) -> i64 {
        self.cells.values().map(|c| counted(&c.before)).sum()
    }
    pub fn passed(&self) -> bool {
        self.failures.is_empty()
    }
    pub fn unresolved_tokens(&self) -> i64 {
        self.unresolved.values().map(|u| u.1).sum()
    }
    pub fn kept_tokens(&self) -> i64 {
        self.kept
            .iter()
            .filter(|((_, _, c), _)| *c != REASONING)
            .map(|(_, t)| t)
            .sum()
    }

    /// How many top-ups are new rows (`--coarse`); the others change an existing row.
    pub fn new_rows(&self) -> usize {
        self.changes.iter().filter(|c| c.new_row.is_some()).count()
    }

    /// Added counted tokens per (harness, day).
    fn added_by_day(&self) -> BTreeMap<(String, String), i64> {
        let mut m: BTreeMap<(String, String), i64> = BTreeMap::new();
        for c in &self.changes {
            *m.entry((c.harness.clone(), c.day.clone())).or_default() += c.added();
        }
        m
    }

    pub fn to_json(&self, code: u8) -> Value {
        let mut cells = vec![];
        for ((h, d), c) in &self.cells {
            for (i, col) in COLS.iter().enumerate() {
                if c.change[i] != 0 {
                    cells.push(json!({
                        "harness": h, "day": d, "column": col,
                        "before": c.before[i], "after": c.before[i] + c.change[i],
                        "change": c.change[i],
                        "events_before": c.events, "events_after": c.events,
                    }));
                }
            }
        }
        let before = self.total_before();
        let change = self.total_change();
        json!({
            "store": self.store,
            "match": {
                "mode": if self.coarse { "coarse" } else { "exact" },
                "key": if self.coarse {
                    "harness, hour, model, precision"
                } else {
                    "harness, hour, model, machine, repo, branch, precision"
                },
                "store_rows": self.group_rows.0, "groups": self.group_rows.1,
                "max_rows_per_group": self.group_rows.2,
            },
            "range": {"from": self.from_day, "until": self.until_day, "until_exclusive": true},
            "cells": cells,
            "total": {"before": before, "after": before + change, "change": change,
                      "change_seven_columns": self.cells.values()
                          .map(|c| c.change.iter().sum::<i64>()).sum::<i64>(),
                      "events_change": 0},
            "repo_aliases": self.aliases.iter()
                .map(|(a, b)| json!({"old": a, "new": b})).collect::<Vec<_>>(),
            "damage_hours_before": {
                "count": self.damage_hours.len(),
                "hours": self.damage_hours.iter().map(|h| format_rfc3339(*h)).collect::<Vec<_>>(),
            },
            "new_rows_created": self.new_rows(),
            "existing_rows_changed": self.changes.len() - self.new_rows(),
            "unresolved": self.unresolved.iter().map(|((h, d), (hours, t))| json!({
                "harness": h, "day": d, "hours": hours.len(), "tokens": t})).collect::<Vec<_>>(),
            "kept": self.kept.iter().map(|((h, d, c), t)| json!({
                "harness": h, "day": d, "column": COLS[*c], "tokens": t})).collect::<Vec<_>>(),
            "added_by_day": self.added_by_day().iter().map(|((h, d), t)| json!({
                "harness": h, "day": d, "tokens": t})).collect::<Vec<_>>(),
            "top_ups": self.changes.iter().map(|c| {
                let d = c.delta();
                let added: serde_json::Map<String, Value> = COLS.iter().enumerate()
                    .filter(|(i, _)| d[*i] != 0)
                    .map(|(i, n)| ((*n).to_string(), json!(d[i])))
                    .collect();
                json!({
                    "kind": if c.new_row.is_some() { "new_row" } else { "existing_row" },
                    "harness": c.harness, "hour": format_rfc3339(c.hour), "day": c.day,
                    "receiving_row": {"machine": c.machine, "repo": c.repo,
                                      "branch": c.branch, "precision": c.precision},
                    "group_rows": c.group_rows, "added_tokens": c.added(), "added": added,
                })
            }).collect::<Vec<_>>(),
            "outside_range": self.outside.iter().map(|(h, (g, t))| json!({
                "harness": h, "groups": g, "tokens": t})).collect::<Vec<_>>(),
            "unresolved_groups": self.no_free.iter().map(|((h, d), (g, t))| json!({
                "harness": h, "day": d, "groups": g, "tokens": t,
                "reason": "no_evidence_free_row"})).collect::<Vec<_>>(),
            "targets": {"state": "before_evidence", "rows": self.changes.len()},
            "conservation": {"pass": self.failures.is_empty(), "failures": self.failures},
            "exit": code,
        })
    }

    pub fn to_text(&self, code: u8) -> String {
        let mut s = String::new();
        s.push_str(&format!(
            "repair plan for the store {}, from {} up to {} (end excluded) (dry run unless --apply)\n\
             top-ups go to the group's before-evidence row\n",
            self.store, self.from_day, self.until_day
        ));
        s.push_str(&format!(
            "match: {} ({}); {} store rows in {} groups, at most {} rows in one group\n",
            if self.coarse { "coarse" } else { "exact" },
            if self.coarse {
                "harness, hour, model, precision"
            } else {
                "harness, hour, model, machine, repo, branch, precision"
            },
            th(self.group_rows.0 as i64),
            th(self.group_rows.1 as i64),
            self.group_rows.2
        ));
        if !self.aliases.is_empty() {
            let a: Vec<String> = self
                .aliases
                .iter()
                .map(|(a, b)| format!("{a}={b}"))
                .collect();
            s.push_str(&format!("repo aliases: {}\n", a.join(", ")));
        }
        s.push_str(&format!(
            "{:<12} {:<11} {:<15} {:>16} {:>16} {:>14}  {}\n",
            "harness", "day", "column", "before", "after", "change", "events before/after"
        ));
        for ((h, d), c) in &self.cells {
            for (i, col) in COLS.iter().enumerate() {
                if c.change[i] != 0 {
                    s.push_str(&format!(
                        "{:<12} {:<11} {:<15} {:>16} {:>16} {:>+14}  {} / {}\n",
                        h,
                        d,
                        col,
                        th(c.before[i]),
                        th(c.before[i] + c.change[i]),
                        c.change[i],
                        th(c.events),
                        th(c.events)
                    ));
                }
            }
        }
        let (b, c) = (self.total_before(), self.total_change());
        s.push_str(&format!(
            "TOTAL tokens before {} after {} change {:+} events change 0 \
             (seven columns, reasoning included: {:+})\n",
            th(b),
            th(b + c),
            c,
            self.cells
                .values()
                .map(|c| c.change.iter().sum::<i64>())
                .sum::<i64>()
        ));
        s.push_str(&format!(
            "damage_hours_before {}: hours whose evidence is above the rollup before the repair \
             (reported, not a failure; the repair must cover them)\n",
            self.damage_hours.len()
        ));
        for h in &self.damage_hours {
            s.push_str(&format!("  {}\n", format_rfc3339(*h)));
        }
        s.push_str(&format!(
            "new rows created: {}; existing rows changed: {}\n",
            self.new_rows(),
            self.changes.len() - self.new_rows()
        ));
        let hours: usize = self.unresolved.values().map(|u| u.0.len()).sum();
        s.push_str(&format!(
            "unresolved: {hours} hours, {} tokens (rows, no oracle rows; not touched)\n",
            th(self.unresolved_tokens())
        ));
        for ((h, d), (hrs, t)) in &self.unresolved {
            s.push_str(&format!(
                "  {h} {d}: {} hours, {} tokens\n",
                hrs.len(),
                th(*t)
            ));
        }
        s.push_str(&format!(
            "kept: {} cells, {} tokens (store above oracle; kept)\n",
            self.kept.len(),
            th(self.kept_tokens())
        ));
        for ((h, d, col), t) in &self.kept {
            s.push_str(&format!("  {h} {d} {}: {}\n", COLS[*col], th(*t)));
        }
        for ((h, d), (g, t)) in &self.no_free {
            s.push_str(&format!(
                "unresolved, no evidence-free row (every row attributed; not touched): {h} {d}: \
                 {g} groups short, {} tokens\n",
                th(*t)
            ));
        }
        s.push_str("added tokens per harness and day (the six counted columns):\n");
        for ((h, d), t) in &self.added_by_day() {
            s.push_str(&format!("  {h} {d}: {:+}\n", t));
        }
        s.push_str(&format!("top-ups ({}):\n", self.changes.len()));
        for c in &self.changes {
            let d = c.delta();
            let cols: Vec<String> = COLS
                .iter()
                .enumerate()
                .filter(|(i, _)| d[*i] != 0)
                .map(|(i, n)| format!("{n} {:+}", d[i]))
                .collect();
            s.push_str(&format!(
                "  {} {} +{} ({}) {} machine={} repo={} branch={} precision={} \
                 (group of {} store rows)\n",
                c.harness,
                format_rfc3339(c.hour),
                th(c.added()),
                cols.join(", "),
                if c.new_row.is_some() {
                    "as a NEW row:"
                } else {
                    "into the row"
                },
                if c.machine.is_empty() {
                    "-"
                } else {
                    &c.machine
                },
                c.repo.as_deref().unwrap_or("-"),
                c.branch.as_deref().unwrap_or("-"),
                c.precision,
                c.group_rows
            ));
        }
        for (h, (g, t)) in &self.outside {
            s.push_str(&format!(
                "outside range (reported, not repaired): {h}: {g} groups counted short (the oracle holds more under the same hour, model and precision; the same tokens may sit in another precision or model of that hour), {} tokens\n",
                th(*t)
            ));
        }
        if self.failures.is_empty() {
            s.push_str("conservation: PASS\n");
        } else {
            s.push_str("conservation: FAIL\n");
            for f in &self.failures {
                s.push_str(&format!("  - {f}\n"));
            }
        }
        s.push_str(&format!("exit {code}\n"));
        s
    }
}

fn th(n: i64) -> String {
    let neg = n < 0;
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if neg { format!("-{out}") } else { out }
}

fn has_column(c: &Connection, table: &str, col: &str) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT count(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, col],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

fn has_table(c: &Connection, table: &str) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

/// The store's `schema_version`, if it has one.
fn schema_version(c: &Connection) -> rusqlite::Result<Option<i64>> {
    if !has_table(c, "meta")? {
        return Ok(None);
    }
    let v: Option<String> = c
        .query_row("SELECT v FROM meta WHERE k = 'schema_version'", [], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(v.and_then(|v| v.parse().ok()))
}

/// Every rollup row with an hour in `[lo, hi)`.
fn load(c: &Connection, lo: i64, hi: i64, all: bool) -> rusqlite::Result<Vec<Row>> {
    let state = if has_column(c, "usage", "actor_state")? {
        "actor_state"
    } else {
        "NULL"
    };
    let range = if all {
        ""
    } else {
        "WHERE hour_ms >= ?1 AND hour_ms < ?2"
    };
    let sql = format!(
        "SELECT id, harness, hour_ms, model, machine, repo, branch, precision, {state},
                input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning,
                unsplit, events FROM usage {range} ORDER BY id"
    );
    let mut st = c.prepare(&sql)?;
    let map = |r: &rusqlite::Row| -> rusqlite::Result<Row> {
        let mut v = [0i64; 7];
        for (i, x) in v.iter_mut().enumerate() {
            *x = r.get(9 + i)?;
        }
        Ok(Row {
            id: r.get(0)?,
            harness: r.get(1)?,
            hour: r.get(2)?,
            model: r.get(3)?,
            machine: r.get(4)?,
            repo: r.get(5)?,
            branch: r.get(6)?,
            precision: r.get(7)?,
            state: r.get(8)?,
            v,
            events: r.get(16)?,
        })
    };
    let rows = if all {
        st.query_map([], map)?.collect::<Result<Vec<_>, _>>()?
    } else {
        st.query_map([lo, hi], map)?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows)
}

/// Per hour, the evidence table's sums, for hours in `[lo, hi)`. Empty when it has no table.
fn evidence_hours(c: &Connection, lo: i64, hi: i64) -> rusqlite::Result<BTreeMap<i64, [i64; 7]>> {
    let mut m = BTreeMap::new();
    if !has_table(c, "evidence")? {
        return Ok(m);
    }
    let sums: Vec<String> = COLS.iter().map(|c| format!("sum({c})")).collect();
    let sql = format!(
        "SELECT ts_ms / {HOUR_MS}, {} FROM evidence WHERE ts_ms >= ?1 AND ts_ms < ?2 GROUP BY 1",
        sums.join(", ")
    );
    let mut st = c.prepare(&sql)?;
    let rows = st.query_map([lo, hi], |r| {
        let h: i64 = r.get(0)?;
        let mut v = [0i64; 7];
        for (i, x) in v.iter_mut().enumerate() {
            *x = r.get(1 + i)?;
        }
        Ok((h * HOUR_MS, v))
    })?;
    for r in rows {
        let (h, v) = r?;
        m.insert(h, v);
    }
    Ok(m)
}

fn is_untouchable(harness: &str) -> bool {
    harness == Source::Codex.harness() || harness == Source::Agy.harness()
}

/// A repo label after the aliases: None when it has none. An alias OLD=NEW matches the label
/// exactly, or as a prefix when OLD ends in `/`.
fn canon_repo(repo: Option<&str>, aliases: &[(String, String)]) -> Option<String> {
    let r = repo.filter(|r| !r.is_empty())?;
    for (old, new) in aliases {
        if r == old {
            return Some(new.clone());
        }
        if old.ends_with('/')
            && let Some(rest) = r.strip_prefix(old.as_str())
        {
            return Some(format!("{new}{rest}"));
        }
    }
    Some(r.to_string())
}

/// The one repo that is short in a coarse group, when exactly one is and none is over (and it is
/// not "no repo"): in the store's naming. Otherwise None, the new row's repo stays empty.
fn short_repo(
    diff: Option<&BTreeMap<Option<String>, i64>>,
    label: &BTreeMap<(GKey, String), String>,
    k: &GKey,
) -> Option<String> {
    let d = diff?;
    let pos: Vec<&Option<String>> = d.iter().filter(|(_, v)| **v > 0).map(|(r, _)| r).collect();
    if d.values().any(|v| *v < 0) || pos.len() != 1 {
        return None;
    }
    let c = pos[0].as_ref()?;
    Some(label.get(&(k.clone(), c.clone())).unwrap_or(c).clone())
}

/// The id of a `--coarse` new row: stable for its group and repo, and never a sync id (those are
/// 32 hex digits; this one starts `repair1126:`).
fn new_row_id(k: &GKey, repo: Option<&str>) -> String {
    let mut h = Sha256::new();
    for p in [k.0.as_str(), k.2.as_str(), k.6.as_str(), repo.unwrap_or("")] {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p.as_bytes());
    }
    h.update(k.1.to_le_bytes());
    h.update([repo.is_some() as u8]);
    format!("repair1126:{}", crate::event::hex(&h.finalize()[..16]))
}

/// Builds the plan and runs checks 1 to 6 on it. Pure: it reads only the rows it is given.
fn plan(
    store: &[Row],
    oracle: &[Row],
    evidence: &BTreeMap<i64, [i64; 7]>,
    from_ms: i64,
    until_ms: i64,
    coarse: bool,
    aliases: &[(String, String)],
) -> Report {
    let mut rep = Report {
        from_day: format_rfc3339(from_ms),
        until_day: format_rfc3339(until_ms),
        ..Report::default()
    };
    let in_range = |h: i64| h >= from_ms && h < until_ms;
    rep.coarse = coarse;
    rep.aliases = aliases.to_vec();
    let sg = group(store, coarse);
    let og = group(oracle, coarse);
    let in_groups = sg.iter().filter(|(k, _)| in_range(k.1));
    rep.group_rows = (
        in_groups.clone().map(|(_, g)| g.rows).sum(),
        in_groups.clone().count(),
        in_groups.map(|(_, g)| g.rows).max().unwrap_or(0),
    );
    let oracle_hours: BTreeSet<(String, i64)> = og.keys().map(|k| (k.0.clone(), k.1)).collect();
    // `--coarse`: per group, each repo's signed difference (oracle minus store, over the seven
    // columns, after the alias) and the label the store's own rows carry for it.
    let mut repo_diff: BTreeMap<GKey, BTreeMap<Option<String>, i64>> = BTreeMap::new();
    let mut repo_label: BTreeMap<(GKey, String), String> = BTreeMap::new();
    if coarse {
        for (rows, sign, is_store) in [(store, -1i64, true), (oracle, 1i64, false)] {
            for r in rows.iter().filter(|r| in_range(r.hour)) {
                let k = gkey(r, true);
                let canon = canon_repo(r.repo.as_deref(), aliases);
                let e = repo_diff.entry(k.clone()).or_default();
                *e.entry(canon.clone()).or_default() += sign * r.v.iter().sum::<i64>();
                if let (true, Some(c), Some(own)) =
                    (is_store, canon, r.repo.as_deref().filter(|x| !x.is_empty()))
                {
                    let l = repo_label.entry((k, c)).or_insert_with(|| own.to_string());
                    if own < l.as_str() {
                        *l = own.to_string();
                    }
                }
            }
        }
    }
    // Cell "before" and the unresolved hours come from every store row in range.
    for (k, g) in &sg {
        if !in_range(k.1) {
            continue;
        }
        let day = format_day(k.1);
        let cell = rep.cells.entry((k.0.clone(), day.clone())).or_default();
        for i in 0..7 {
            cell.before[i] += g.v[i];
        }
        cell.events += g.events;
        if !oracle_hours.contains(&(k.0.clone(), k.1)) {
            let u = rep.unresolved.entry((k.0.clone(), day)).or_default();
            u.0.insert(k.1);
            u.1 += counted(&g.v);
        }
    }

    let mut events_bad = 0usize;
    let mut oracle_only = 0usize;
    for (k, o) in &og {
        let s = sg.get(k);
        if !in_range(k.1) {
            // Outside the range: reported, never repaired.
            let before = s.map_or([0; 7], |g| g.v);
            let short: i64 = (0..7)
                .filter(|i| *i != REASONING)
                .map(|i| (o.v[i] - before[i]).max(0))
                .sum();
            if short > 0 {
                let e = rep.outside.entry(k.0.clone()).or_default();
                e.0 += 1;
                e.1 += short;
            }
            continue;
        }
        let Some(s) = s else {
            oracle_only += 1;
            continue;
        };
        let after: [i64; 7] = std::array::from_fn(|i| s.v[i].max(o.v[i]));
        let day = format_day(k.1);
        for i in 0..7 {
            if s.v[i] > o.v[i] {
                *rep.kept.entry((k.0.clone(), day.clone(), i)).or_default() += s.v[i] - o.v[i];
            }
        }
        if after != s.v && !coarse && s.target.is_none() {
            // Short, and every row of the group is attributed: not repaired, listed.
            let e = rep.no_free.entry((k.0.clone(), day)).or_default();
            e.0 += 1;
            e.1 += (0..7)
                .filter(|i| *i != REASONING)
                .map(|i| (o.v[i] - s.v[i]).max(0))
                .sum::<i64>();
        } else if after != s.v {
            if s.events != o.events {
                events_bad += 1;
            }
            // `--coarse` creates one new row; otherwise the top-up goes to the group's target row.
            let new_row = coarse.then(|| {
                let repo = short_repo(repo_diff.get(k), &repo_label, k);
                NewRow {
                    id: new_row_id(k, repo.as_deref()),
                    repo,
                }
            });
            let (id, machine, repo, branch, precision) = match &new_row {
                Some(n) => (
                    n.id.clone(),
                    String::new(),
                    n.repo.clone(),
                    None,
                    k.6.clone(),
                ),
                None => (
                    s.target.clone().expect("checked above"),
                    s.labels.0.clone(),
                    s.labels.1.clone(),
                    s.labels.2.clone(),
                    s.labels.3.clone(),
                ),
            };
            rep.changes.push(Change {
                key: k.clone(),
                new_row,
                harness: k.0.clone(),
                hour: k.1,
                day,
                id,
                before: s.v,
                oracle: o.v,
                after,
                events_before: s.events,
                events_oracle: o.events,
                machine,
                repo,
                branch,
                precision,
                group_rows: s.rows,
            });
        }
    }
    // Store groups with no oracle group in a resolved hour: the store holds tokens the oracle
    // does not (kept, never subtracted).
    for (k, s) in &sg {
        if in_range(k.1) && !og.contains_key(k) && oracle_hours.contains(&(k.0.clone(), k.1)) {
            let day = format_day(k.1);
            for i in 0..7 {
                if s.v[i] > 0 {
                    *rep.kept.entry((k.0.clone(), day.clone(), i)).or_default() += s.v[i];
                }
            }
        }
    }
    for c in &rep.changes {
        let cell = rep
            .cells
            .entry((c.harness.clone(), c.day.clone()))
            .or_default();
        for (i, d) in c.delta().iter().enumerate() {
            cell.change[i] += d;
        }
    }

    // 1. no column or event goes down; events change 0.
    for c in &rep.changes {
        if (0..7).any(|i| c.after[i] < c.before[i]) {
            rep.failures.push(format!(
                "a column goes down: {} {}",
                c.harness,
                format_day(c.hour)
            ));
        }
        // 2. after equals the oracle in each column where it was short.
        if (0..7).any(|i| c.before[i] < c.oracle[i] && c.after[i] != c.oracle[i]) {
            rep.failures.push(format!(
                "a short column does not reach the oracle: {} {}",
                c.harness,
                format_day(c.hour)
            ));
        }
    }
    if events_bad > 0 {
        rep.failures.push(format!(
            "events differ in {events_bad} rows to repair (a different problem; nothing planned)"
        ));
    }
    if oracle_only > 0 {
        rep.failures.push(format!(
            "{oracle_only} oracle rows in range have no store row (events would change)"
        ));
    }
    // 3. the evidence sum is at or under the rollup after the repair. Evidence above the rollup
    // BEFORE it is the damage the repair exists for: reported (`damage_hours`), not a failure.
    let mut roll: BTreeMap<i64, ([i64; 7], [i64; 7])> = BTreeMap::new();
    for (k, g) in &sg {
        if in_range(k.1) {
            let e = roll.entry(k.1).or_default();
            for i in 0..7 {
                e.0[i] += g.v[i];
                e.1[i] += g.v[i];
            }
        }
    }
    for c in &rep.changes {
        let e = roll.entry(c.hour).or_default();
        for (i, d) in c.delta().iter().enumerate() {
            e.1[i] += d;
        }
    }
    for (hour, ev) in evidence {
        let (b, a) = roll.get(hour).copied().unwrap_or_default();
        if (0..7).any(|i| ev[i] > b[i]) {
            rep.damage_hours.push(*hour);
        }
        if (0..7).any(|i| ev[i] > a[i]) {
            rep.failures.push(format!(
                "evidence above the rollup after the repair in hour {}",
                format_rfc3339(*hour)
            ));
        }
    }
    // 4. unresolved hours are untouched.
    if rep.changes.iter().any(|c| {
        rep.unresolved
            .get(&(c.harness.clone(), c.day.clone()))
            .is_some_and(|u| u.0.contains(&c.hour))
    }) {
        rep.failures
            .push("a change falls in an unresolved hour".into());
    }
    // 6. Codex and Antigravity change nothing.
    for ((h, d), c) in &rep.cells {
        if is_untouchable(h) && c.change.iter().any(|x| *x != 0) {
            rep.failures
                .push(format!("{h} {d} has a non-zero change (expected none)"));
        }
    }
    rep
}

fn parse_day(s: &str) -> Result<i64, String> {
    let b = s.as_bytes();
    if b.len() != 10 {
        return Err(format!("{s:?} is not a day (YYYY-MM-DD)"));
    }
    parse_rfc3339(&format!("{s}T00:00:00Z"))
        .ok_or_else(|| format!("{s:?} is not a day (YYYY-MM-DD)"))
}

/// A range bound: a date (`--from` is its start, `--until` its end, the whole day counted) or an
/// RFC 3339 UTC time exactly on the hour, which is the bound itself (an end is excluded).
fn parse_bound(s: &str, end: bool) -> Result<i64, String> {
    if s.len() == 10 {
        let d = parse_day(s)?;
        return Ok(if end { d + DAY_MS } else { d });
    }
    let on_the_hour = (s.ends_with('Z') || s.ends_with('z'))
        .then(|| parse_rfc3339(s))
        .flatten()
        .filter(|t| t % HOUR_MS == 0);
    on_the_hour.ok_or_else(|| {
        format!(
            "{s:?} is not a date (YYYY-MM-DD) or an RFC 3339 UTC time exactly on the hour \
             (like 2026-11-10T14:00:00Z)"
        )
    })
}

/// Parses the arguments after `repair`. Returns the options, or the usage error.
pub fn parse(args: &[String], now_ms: i64) -> Result<Opts, String> {
    let (mut store, mut against, mut from, mut until) = (
        None,
        None,
        DEFAULT_FROM.to_string(),
        DEFAULT_UNTIL.to_string(),
    );
    let (mut json, mut dry, mut apply, mut coarse) = (false, false, false, false);
    let mut aliases: Vec<(String, String)> = vec![];
    let (mut confirm, mut copy) = (None, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = |f: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{f} needs a value"))
        };
        match a.as_str() {
            "--store" => store = Some(PathBuf::from(val("--store")?)),
            "--against" => against = Some(PathBuf::from(val("--against")?)),
            "--from" => from = val("--from")?,
            "--until" => until = val("--until")?,
            "--confirm-copy" => confirm = Some(val("--confirm-copy")?),
            "--copy" => copy = Some(PathBuf::from(val("--copy")?)),
            "--json" => json = true,
            "--coarse" => coarse = true,
            "--repo-alias" => {
                let v = val("--repo-alias")?;
                match v.split_once('=') {
                    Some((a, b)) if !a.is_empty() && !b.is_empty() => {
                        aliases.push((a.to_string(), b.to_string()))
                    }
                    _ => return Err(format!("--repo-alias takes OLD=NEW, got {v:?}")),
                }
            }
            "--dry-run" => dry = true,
            "--apply" => apply = true,
            other => return Err(format!("repair: unknown option {other:?}")),
        }
    }
    if dry && apply {
        return Err("repair: --dry-run and --apply exclude each other".into());
    }
    let store =
        store.ok_or("repair needs --store <the store's state dir>: it is never defaulted")?;
    let against = against.ok_or("repair needs --against <oracle state dir>")?;
    if !aliases.is_empty() && !coarse {
        return Err("--repo-alias belongs to --coarse (the exact match needs no alias)".into());
    }
    if aliases.len() > 16 {
        return Err("--repo-alias: at most 16".into());
    }
    let from_ms = parse_bound(&from, false)?;
    let until_ms = parse_bound(&until, true)?;
    if from_ms >= until_ms {
        return Err("--from must not be after --until".into());
    }
    let apply = if apply {
        let sha = confirm.ok_or("--apply needs --confirm-copy <sha256> and --copy <path>")?;
        let path = copy.ok_or("--apply needs --copy <path> of the verified copy")?;
        let sha = sha.to_ascii_lowercase();
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("--confirm-copy takes the copy's sha256 (64 hex digits)".into());
        }
        Some(Copy { path, sha256: sha })
    } else if confirm.is_some() || copy.is_some() {
        return Err("--copy and --confirm-copy belong to --apply".into());
    } else {
        None
    };
    Ok(Opts {
        state_dir: store,
        against,
        from_ms,
        until_ms,
        json,
        coarse,
        aliases,
        apply,
        now_ms,
    })
}

fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(crate::event::hex(&h.finalize()))
}

/// Loads both stores read-only and builds the plan with checks 1 to 6.
fn build_plan(o: &Opts) -> Result<Result<Report, u8>, String> {
    let db = o.state_dir.join("meter.db");
    let odb = o.against.join("meter.db");
    for (what, p) in [("the store", &db), ("the oracle", &odb)] {
        if !p.is_file() {
            return Err(format!("{what} has no meter.db at {}", p.display()));
        }
    }
    let busy = std::time::Duration::from_secs(5);
    let s = crate::query::open_read_only(&db, busy).map_err(|e| format!("the store: {e}"))?;
    let x = crate::query::open_read_only(&odb, busy).map_err(|e| format!("the oracle: {e}"))?;
    for (what, c) in [("store", &s), ("oracle", &x)] {
        match schema_version(c).map_err(|e| format!("the {what}: {e}"))? {
            Some(v) if v > SCHEMA_VERSION => {
                eprintln!(
                    "meter: the {what}'s schema_version is {v}, newer than this meter's \
                     {SCHEMA_VERSION}; update the meter"
                );
                return Ok(Err(exit::NEWER_SCHEMA));
            }
            Some(v) if v == SCHEMA_VERSION => {}
            _ => return Err(format!("the {what} is not at schema {SCHEMA_VERSION}")),
        }
    }
    let err = |what: &'static str| move |e: rusqlite::Error| format!("the {what}: {e}");
    let all_store = load(&s, 0, 0, true).map_err(err("store"))?;
    // The oracle is read whole too, so rows outside the range can be reported.
    let oracle = load(&x, 0, 0, true).map_err(err("oracle"))?;
    let ev = evidence_hours(&s, o.from_ms, o.until_ms).map_err(err("store"))?;
    Ok(Ok(plan(
        &all_store, &oracle, &ev, o.from_ms, o.until_ms, o.coarse, &o.aliases,
    )))
}

pub fn execute(o: &Opts) -> Result<Done, String> {
    let report = match build_plan(o)? {
        Ok(mut r) => {
            r.store = o.state_dir.display().to_string();
            r
        }
        Err(code) => {
            return Ok(Done {
                code,
                report: Report::default(),
                applied_days: vec![],
            });
        }
    };
    let code = if !report.passed() {
        exit::CONSERVATION
    } else if report.changes.is_empty() {
        // Not the counted total: a gap in `reasoning` alone is a change too, printed and applied.
        exit::NOTHING
    } else {
        exit::OK
    };
    let Some(copy) = &o.apply else {
        return Ok(Done {
            code,
            report,
            applied_days: vec![],
        });
    };
    if code != exit::OK {
        return Ok(Done {
            code,
            report,
            applied_days: vec![],
        });
    }
    let days = apply(o, copy, &report, usize::MAX)?;
    // Every day the plan has must be committed: an apply that did less is not a success.
    let planned: BTreeSet<&str> = report.changes.iter().map(|c| c.day.as_str()).collect();
    if days.len() != planned.len() {
        eprintln!(
            "meter: the plan has {} days with a change, {} were committed",
            planned.len(),
            days.len()
        );
        return Ok(Done {
            code: exit::CONSERVATION,
            report,
            applied_days: days,
        });
    }
    Ok(Done {
        code: exit::OK,
        report,
        applied_days: days,
    })
}

/// A copy is accepted only when it is the file whose sha256 was given and passes `quick_check`;
/// [`compare_counts`] then checks it against the store. Needs no lock: it reads the copy only.
fn verify_copy(copy: &Copy) -> Result<Connection, String> {
    let sha = sha256_file(&copy.path).map_err(|e| format!("the copy: {e}"))?;
    if sha != copy.sha256 {
        return Err(format!(
            "the copy's sha256 is {sha}, not the {} given; nothing was written",
            copy.sha256
        ));
    }
    let c = crate::query::open_read_only(&copy.path, std::time::Duration::from_secs(5))
        .map_err(|e| format!("the copy: {e}"))?;
    let qc: String = c
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| format!("the copy: {e}"))?;
    if qc != "ok" {
        return Err(format!(
            "the copy fails quick_check ({qc}); nothing was written"
        ));
    }
    Ok(c)
}

/// The copy holds as many rollup rows and tokens as the store does right now.
fn compare_counts(store: &Connection, c: &Connection, resuming: bool) -> Result<(), String> {
    let sum = "SELECT count(*), coalesce(sum(input_uncached + cache_read + cache_write_5m + \
               cache_write_1h + output + reasoning + unsplit), 0) FROM usage";
    let q =
        |c: &Connection| c.query_row(sum, [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)));
    let (a, b) = (
        q(store).map_err(|e| e.to_string())?,
        q(c).map_err(|e| e.to_string())?,
    );
    // A copy is of the store before the first day was written: once a journal says some days
    // are done, the store may hold more than the copy, never less.
    if a.0 != b.0 || (a.1 != b.1 && !(resuming && a.1 > b.1)) {
        return Err(format!(
            "the copy holds {} rollup rows and {} tokens, the store {} and {}; make a new copy",
            b.0, b.1, a.0, a.1
        ));
    }
    Ok(())
}

/// The columns to order a table's rows by: its primary key, else `rowid`. A table made `WITHOUT
/// ROWID` (the outcomes `pr` table) has no `rowid` column but always has a primary key.
fn order_by(tx: &Transaction, table: &str) -> rusqlite::Result<String> {
    let pk: Vec<String> = tx
        .prepare("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk")?
        .query_map([table], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(if pk.is_empty() {
        "rowid".to_string()
    } else {
        pk.iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ")
    })
}

/// The fingerprint of a whole store file (every table whole, the rollup rows outside `[lo,
/// hi)`), for a test to see that every table the schema makes can be hashed.
pub fn fingerprint_file(db: &Path, lo: i64, hi: i64) -> Result<String, String> {
    let mut c = Connection::open(db).map_err(|e| e.to_string())?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    fingerprint(&tx, lo, hi).map_err(|e| e.to_string())
}

/// A hash of every row the repair must leave alone: the rollup rows outside `[lo, hi)`, the
/// `meta` rows but the journal, and every other table whole.
fn fingerprint(tx: &Transaction, lo: i64, hi: i64) -> rusqlite::Result<String> {
    let names: Vec<String> = tx
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut h = Sha256::new();
    for n in names {
        h.update(n.as_bytes());
        let sql = match n.as_str() {
            "usage" => {
                format!("SELECT * FROM usage WHERE hour_ms < {lo} OR hour_ms >= {hi} ORDER BY id")
            }
            "meta" => format!("SELECT * FROM meta WHERE k != '{JOURNAL}' ORDER BY k"),
            _ => format!("SELECT * FROM \"{n}\" ORDER BY {}", order_by(tx, &n)?),
        };
        let mut st = tx.prepare(&sql)?;
        let cols = st.column_count();
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            for i in 0..cols {
                match r.get_ref(i)? {
                    ValueRef::Null => h.update([0u8]),
                    ValueRef::Integer(v) => {
                        h.update([1u8]);
                        h.update(v.to_le_bytes());
                    }
                    ValueRef::Real(v) => {
                        h.update([2u8]);
                        h.update(v.to_le_bytes());
                    }
                    ValueRef::Text(t) => {
                        h.update([3u8]);
                        h.update((t.len() as u64).to_le_bytes());
                        h.update(t);
                    }
                    ValueRef::Blob(b) => {
                        h.update([4u8]);
                        h.update((b.len() as u64).to_le_bytes());
                        h.update(b);
                    }
                }
            }
        }
    }
    Ok(crate::event::hex(&h.finalize()))
}

/// The copy must be a separate file: not the store by any spelling, not a symlink, and not the
/// store's own inode (a hard link has the store's bytes and sha256 and would pass as a copy).
fn check_separate(db: &Path, copy: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let link = std::fs::symlink_metadata(copy).map_err(|e| format!("the copy: {e}"))?;
    if link.file_type().is_symlink() {
        return Err("the copy is a symbolic link; it must be a separate file".into());
    }
    let (a, b) = (
        std::fs::metadata(db).map_err(|e| format!("the store: {e}"))?,
        std::fs::metadata(copy).map_err(|e| format!("the copy: {e}"))?,
    );
    let same_path = match (std::fs::canonicalize(db), std::fs::canonicalize(copy)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    };
    if same_path || (a.dev() == b.dev() && a.ino() == b.ino()) {
        return Err("the copy is the store itself (same file); it must be a separate file".into());
    }
    Ok(())
}

fn check_schema(c: &Connection) -> Result<(), String> {
    match schema_version(c).map_err(|e| e.to_string())? {
        Some(v) if v > SCHEMA_VERSION => Err(format!(
            "the store's schema_version is {v}, newer than this meter's {SCHEMA_VERSION}; \
             nothing was written"
        )),
        Some(v) if v == SCHEMA_VERSION => Ok(()),
        _ => Err(format!("the store is not at schema {SCHEMA_VERSION}")),
    }
}

fn journal(c: &Connection) -> Result<Option<String>, String> {
    c.query_row("SELECT v FROM meta WHERE k = ?1", [JOURNAL], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

/// Writes the plan, one transaction per day, at most `limit` days (a test's stand-in for a kill
/// between days). Returns the days committed.
///
/// Every refusal that needs no lock comes first (the copy is a separate file, its sha256, its
/// `quick_check`, its counts against the store, the schema), all by read-only opens, so a refused
/// apply creates nothing in the store's folder. The lock file is never removed afterwards: it may
/// be one a sync has opened or locked in the meantime, and the sync lock belongs to the sync.
pub fn apply(o: &Opts, copy: &Copy, rep: &Report, limit: usize) -> Result<Vec<String>, String> {
    let db = o.state_dir.join("meter.db");
    check_separate(&db, &copy.path)?;
    let copy_conn = {
        let ro = crate::query::open_read_only(&db, std::time::Duration::from_secs(5))
            .map_err(|e| format!("the store: {e}"))?;
        check_schema(&ro)?;
        let c = verify_copy(copy)?;
        compare_counts(&ro, &c, journal(&ro)?.is_some())?;
        c
    };
    // A seam for the unit tests only (it does not exist in a release build): a sync landing
    // between the read-only checks above and the lock below.
    #[cfg(test)]
    tests::between_checks_and_lock();
    let _lock = match crate::paths::try_lock(&o.state_dir) {
        Ok(Some(l)) => l,
        Ok(None) => return Err("another sync holds the lock; nothing was written".into()),
        Err(e) => return Err(format!("the lock: {e}")),
    };
    let mut conn = Connection::open(&db).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    // Under the lock: the store may have changed since the checks above.
    check_schema(&conn)?;
    compare_counts(&conn, &copy_conn, journal(&conn)?.is_some())?;
    let mut by_day: BTreeMap<&str, Vec<&Change>> = BTreeMap::new();
    for c in &rep.changes {
        by_day.entry(c.day.as_str()).or_default().push(c);
    }
    let mut committed = vec![];
    for (day, changes) in by_day {
        if committed.len() >= limit {
            break;
        }
        // The day's transaction covers the day's hours inside the range only: an hour bound
        // leaves the rest of that day out of every write and every check.
        let lo = parse_day(day)?.max(o.from_ms);
        let hi = (parse_day(day)? + DAY_MS).min(o.until_ms);
        let tx = Transaction::new(&mut conn, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        // An Err drops tx: the day rolls back.
        day_tx(&tx, day, lo, hi, &changes, o.now_ms, rep.coarse)?;
        tx.commit().map_err(|e| e.to_string())?;
        committed.push(day.to_string());
    }
    Ok(committed)
}

fn day_tx(
    tx: &Transaction,
    day: &str,
    lo: i64,
    hi: i64,
    changes: &[&Change],
    now_ms: i64,
    coarse: bool,
) -> Result<(), String> {
    let e = |e: rusqlite::Error| e.to_string();
    let fp0 = fingerprint(tx, lo, hi).map_err(e)?;
    let before = load(tx, lo, hi, false).map_err(e)?;
    let bg = group(&before, coarse);
    let set: Vec<String> = COLS.iter().map(|c| format!("{c} = {c} + ?")).collect();
    let sql = format!(
        "UPDATE usage SET {}, updated_ms = ? WHERE id = ?",
        set.join(", ")
    );
    let insert = format!(
        "INSERT INTO usage(id, hour_ms, harness, model, machine, repo, branch, precision,
           events, updated_ms, {}) VALUES (?1, ?2, ?3, ?4, '', ?5, NULL, ?6, 0, ?7, {})",
        COLS.join(", "),
        (8..15)
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    for c in changes {
        let d = c.delta();
        if let Some(n) = &c.new_row {
            // A new row: before evidence (no actor state, no bot), machine and branch empty,
            // events 0, only the added tokens. Existing rows are not touched.
            let mut p: Vec<rusqlite::types::Value> = vec![
                n.id.clone().into(),
                c.hour.into(),
                c.harness.clone().into(),
                c.key.2.clone().into(),
                n.repo.clone().into(),
                c.precision.clone().into(),
                now_ms.into(),
            ];
            p.extend(d.iter().map(|x| rusqlite::types::Value::from(*x)));
            tx.execute(&insert, rusqlite::params_from_iter(p))
                .map_err(e)?;
            continue;
        }
        let mut p: Vec<rusqlite::types::Value> = d.iter().map(|x| (*x).into()).collect();
        p.push(now_ms.into());
        p.push(c.id.clone().into());
        let n = tx.execute(&sql, rusqlite::params_from_iter(p)).map_err(e)?;
        if n != 1 {
            return Err(format!("{day}: the row to top up is gone; day rolled back"));
        }
    }
    // The day's own conservation, on what the transaction now holds.
    let after_rows = load(tx, lo, hi, false).map_err(e)?;
    if coarse {
        // `--coarse` only adds rows: every row the day held is as it was, all columns.
        let now: BTreeMap<&str, &Row> = after_rows.iter().map(|r| (r.id.as_str(), r)).collect();
        for r in &before {
            let same = now
                .get(r.id.as_str())
                .is_some_and(|n| n.v == r.v && n.events == r.events && n.state == r.state);
            if !same {
                return Err(format!(
                    "{day}: an existing row changed under --coarse; day rolled back"
                ));
            }
        }
    }
    let after = group(&after_rows, coarse);
    let mut planned: BTreeMap<GKey, &Change> = BTreeMap::new();
    for c in changes {
        if c.new_row.is_some() {
            planned.insert(c.key.clone(), *c);
            continue;
        }
        let r = before.iter().find(|r| r.id == c.id).ok_or_else(|| {
            format!("{day}: the row to top up is not in the day; day rolled back")
        })?;
        planned.insert(gkey(r, coarse), *c);
    }
    if after.len() != bg.len() {
        return Err(format!(
            "{day}: the set of rollup groups changed; day rolled back"
        ));
    }
    for (k, b) in &bg {
        let a = after
            .get(k)
            .ok_or_else(|| format!("{day}: a group went; day rolled back"))?;
        if a.events != b.events {
            return Err(format!("{day}: events changed; day rolled back"));
        }
        let want = planned.get(k).map_or(b.v, |c| c.after);
        if a.v != want {
            return Err(format!(
                "{day}: a group is not what the plan says; day rolled back"
            ));
        }
    }
    let ev = evidence_hours(tx, lo, hi).map_err(e)?;
    let mut roll: BTreeMap<i64, [i64; 7]> = BTreeMap::new();
    for (k, g) in &after {
        let r = roll.entry(k.1).or_default();
        for (a, b) in r.iter_mut().zip(g.v) {
            *a += b;
        }
    }
    for (hour, s) in &ev {
        let r = roll.get(hour).copied().unwrap_or_default();
        if (0..7).any(|i| s[i] > r[i]) {
            return Err(format!("{day}: evidence above the rollup; day rolled back"));
        }
    }
    if fingerprint(tx, lo, hi).map_err(e)? != fp0 {
        return Err(format!(
            "{day}: a row outside the day changed; day rolled back"
        ));
    }
    tx.execute(
        "INSERT INTO meta(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        params![JOURNAL, day],
    )
    .map_err(e)?;
    Ok(())
}

/// The `repair` command: prints the plan (table or JSON) and returns the exit code.
pub fn cmd(args: &[String], now_ms: i64) -> u8 {
    let o = match parse(args, now_ms) {
        Ok(o) => o,
        Err(m) => {
            eprintln!("meter: {m}");
            return exit::USAGE;
        }
    };
    match execute(&o) {
        Ok(d) => {
            if d.report.from_day.is_empty() {
                return d.code; // refused before a plan (newer schema); stderr said why
            }
            if o.json {
                let mut j = d.report.to_json(d.code);
                if o.apply.is_some() {
                    j["applied_days"] = json!(d.applied_days);
                }
                println!("{j}");
            } else {
                print!("{}", d.report.to_text(d.code));
                if o.apply.is_some() {
                    println!("applied days: {}", d.applied_days.join(", "));
                }
            }
            d.code
        }
        Err(m) => {
            eprintln!("meter: {m}");
            // A day's own check failed and that day was rolled back: a conservation failure.
            if m.contains("rolled back") {
                exit::CONSERVATION
            } else {
                exit::USAGE
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use std::cell::RefCell;

    thread_local! {
        static BETWEEN: RefCell<Option<Box<dyn Fn()>>> = const { RefCell::new(None) };
    }

    /// Runs the test's callback, if any: what a sync writing at that moment would do.
    pub(super) fn between_checks_and_lock() {
        BETWEEN.with(|b| {
            if let Some(f) = b.borrow().as_ref() {
                f();
            }
        });
    }

    const HOUR: &str = "2026-11-08T10:00:00Z";

    fn put(dir: &Path, id: &str, cache_read: i64) {
        Connection::open(dir.join("meter.db"))
            .unwrap()
            .execute(
                "INSERT INTO usage(id, hour_ms, harness, model, machine, precision, events,
                   updated_ms, cache_read) VALUES (?1, ?2, 'dsh-tui', 'm', 'mach', 'exact', 1, 1, ?3)",
                params![id, parse_rfc3339(HOUR).unwrap(), cache_read],
            )
            .unwrap();
    }

    struct Fx {
        _d: tempfile::TempDir,
        store: PathBuf,
        opts: Opts,
    }

    /// A store short by 15 on one cell, its oracle, a verified copy, and a lock file in the
    /// store's folder (a synced store has one).
    fn fx() -> Fx {
        let d = tempfile::tempdir().unwrap();
        let mk = |n: &str| {
            let p = d.path().join(n);
            std::fs::create_dir_all(&p).unwrap();
            drop(Store::open(&p.join("meter.db")).unwrap());
            p
        };
        let (store, oracle) = (mk("store"), mk("oracle"));
        std::fs::write(store.join("meter.lock"), b"").unwrap();
        put(&store, "a", 10);
        put(&oracle, "a", 25);
        let copy = d.path().join("copy.db");
        Connection::open(store.join("meter.db"))
            .unwrap()
            .execute("VACUUM INTO ?1", [copy.display().to_string()])
            .unwrap();
        let sha = crate::event::hex(&Sha256::digest(std::fs::read(&copy).unwrap()));
        let args: Vec<String> = [
            "--store",
            store.to_str().unwrap(),
            "--against",
            oracle.to_str().unwrap(),
            "--apply",
            "--copy",
            copy.to_str().unwrap(),
            "--confirm-copy",
            &sha,
        ]
        .map(String::from)
        .to_vec();
        let opts = parse(&args, 1_800_000_000_000).unwrap();
        Fx { _d: d, store, opts }
    }

    fn listing(dir: &Path) -> Vec<(String, u64)> {
        let mut v: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                (
                    e.file_name().to_string_lossy().into_owned(),
                    e.metadata().unwrap().len(),
                )
            })
            .filter(|(n, _)| !n.starts_with("meter.db"))
            .collect();
        v.sort();
        v
    }

    fn db_bytes(dir: &Path) -> Vec<u8> {
        std::fs::read(dir.join("meter.db")).unwrap()
    }

    fn run_with(f: impl Fn() + 'static, fx: &Fx) -> Result<Done, String> {
        BETWEEN.with(|b| *b.borrow_mut() = Some(Box::new(f)));
        let r = execute(&fx.opts);
        BETWEEN.with(|b| *b.borrow_mut() = None);
        r
    }

    #[test]
    fn without_a_sync_in_between_the_apply_goes_through() {
        let fx = fx();
        let d = run_with(|| {}, &fx).unwrap();
        assert_eq!(d.code, exit::OK);
        assert_eq!(d.applied_days, vec!["2026-11-08"]);
    }

    #[test]
    fn a_sync_writing_between_the_checks_and_the_lock_refuses_the_apply() {
        let fx = fx();
        let s = fx.store.clone();
        let before = (listing(&fx.store), db_bytes(&fx.store));
        // A sync appends a rollup row after the copy was verified and before the lock is taken.
        let e = match run_with(move || put(&s, "b", 7), &fx) {
            Err(e) => e,
            Ok(d) => panic!("applied over a store that changed: code {}", d.code),
        };
        assert!(e.contains("make a new copy"), "{e}");
        // The folder is as it was but for the sync's own row in the database.
        assert_eq!(listing(&fx.store), before.0);
        let c = Connection::open(fx.store.join("meter.db")).unwrap();
        let (n, cr): (i64, i64) = c
            .query_row("SELECT count(*), sum(cache_read) FROM usage", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((n, cr), (2, 17), "nothing of the repair was written");
    }

    #[test]
    fn evidence_written_between_the_checks_and_the_lock_rolls_the_day_back() {
        let fx = fx();
        let s = fx.store.clone();
        let before = (listing(&fx.store), 10i64);
        // The plan passed (no evidence then). A sync lands evidence above what the repaired
        // rollup will hold (25) in the planned hour: the day's own after-check must refuse it.
        let e = match run_with(
            move || {
                Connection::open(s.join("meter.db"))
                    .unwrap()
                    .execute(
                        "INSERT INTO evidence(ts_ms, dim, actor, cache_read) VALUES (?1, 0, 0, 500)",
                        [parse_rfc3339(HOUR).unwrap() + 5],
                    )
                    .unwrap();
            },
            &fx,
        ) {
            Err(e) => e,
            Ok(d) => panic!("applied over evidence above the rollup: code {}", d.code),
        };
        assert!(
            e.contains("evidence above the rollup") && e.contains("rolled back"),
            "{e}"
        );
        let c = Connection::open(fx.store.join("meter.db")).unwrap();
        let cr: i64 = c
            .query_row("SELECT cache_read FROM usage WHERE id = 'a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(cr, before.1, "the day was rolled back");
        assert_eq!(listing(&fx.store), before.0);
        assert_eq!(journal(&c).unwrap(), None);
    }

    #[test]
    fn a_newer_schema_written_between_the_checks_and_the_lock_refuses_the_apply() {
        let fx = fx();
        let s = fx.store.clone();
        let listing_before = listing(&fx.store);
        let e = match run_with(
            move || {
                Connection::open(s.join("meter.db"))
                    .unwrap()
                    .execute("UPDATE meta SET v = '99' WHERE k = 'schema_version'", [])
                    .unwrap();
            },
            &fx,
        ) {
            Err(e) => e,
            Ok(d) => panic!("applied on a newer schema: code {}", d.code),
        };
        assert!(e.contains("newer"), "{e}");
        assert_eq!(listing(&fx.store), listing_before);
    }
}
