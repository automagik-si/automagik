//! `usagemeter coverage`: the store's bot-tag coverage (RFC 0026 delivery 2).
//!
//! One local, read-only, fork-and-exit report on the query's read-only open: the usage rows a
//! `--by bot` answer would count, split by RFC 0021 (d)'s four actor counts and the five reasons,
//! per repo and per bot, for contract 1's `d1`, `d7` and `d30` windows. It prints text (the
//! default) or one JSON record (the fleet step's, RFC 0026 (e)). It creates nothing, migrates
//! nothing, writes no `meta`, takes no lock, calls no `hc` and opens no network; it adds no
//! query-contract field and no store column. The metric is (a): tokens, never rows or cost,
//! `bot_coverage = attributed / total` (four decimals, null when the total is 0) and `inspected =
//! attributed / (attributed + ambiguous + unlinked)` beside it as the diagnostic. A ratio is
//! always "over counted usage"; it is never called a bound, and a repo or bot that has no tokens
//! is `no_usage` with a null ratio, never a 0.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use rusqlite::Connection;
use serde::Serialize;

use crate::query::{self, Basis, BotKey, Class, Located, Unlinked, Window, exit};
use crate::sources::Source;
use crate::store::SCHEMA_VERSION;
use crate::time::format_rfc3339;

/// The JSON record's version, for the fleet step (RFC 0026 (e), delivery 5).
pub const RECORD_VERSION: u64 = 1;

/// RFC 0026 (g): at most 50 repos and 50 bots are shown; the rest are counted and summed, so
/// every total stays complete.
const MAX_REPOS: usize = 50;
const MAX_BOTS: usize = 50;

/// The five classes, in the schema's reason order (state, reason).
const PARTS: [(&str, &str); 5] = [
    ("ambiguous", "claimants_differ"),
    ("unlinked", "no_record"),
    ("unlinked", "dsh_tui_seat"),
    ("unlinked", "other_machine"),
    ("before_evidence", "before_evidence"),
];

const NO_REPO: &str = "store-wide, even with --repo: usage with no repo belongs to no query \
     answer, so it is outside the denominator";

const ABSENT: &str = "no meter store on this machine yet; open Herdr or run usagemeter sync";

/// One call's result: the exit code, and what goes to stdout (the report) or stderr (why not).
pub struct Reply {
    pub code: u8,
    pub stdout: String,
    pub stderr: Option<String>,
}

impl Reply {
    fn ok(stdout: String) -> Reply {
        Reply {
            code: exit::OK,
            stdout,
            stderr: None,
        }
    }

    fn err(code: u8, message: impl Into<String>) -> Reply {
        Reply {
            code,
            stdout: String::new(),
            stderr: Some(format!("meter: coverage: {}", message.into())),
        }
    }
}

struct Failure {
    code: u8,
    message: String,
}

impl Failure {
    fn new(code: u8, message: impl Into<String>) -> Failure {
        Failure {
            code,
            message: message.into(),
        }
    }

    fn sql(e: rusqlite::Error) -> Failure {
        let code = if query::is_busy(&e) {
            exit::LOCKED
        } else {
            exit::ERROR
        };
        Failure::new(code, format!("the store could not be read: {e}"))
    }
}

// ---------------------------------------------------------------------------------------------
// The request.

struct Request {
    windows: Vec<Window>,
    repos: Vec<String>,
    repo_aliases: Vec<String>,
    json: bool,
}

/// `--window d1|d7|d30 ...`, `--repo host/owner/repo ...`, `--json`. Unlike the query, no repo is
/// required and every window is the default; a name given twice is one name.
fn parse(args: &[String]) -> Result<Request, String> {
    let mut windows: Vec<Window> = Vec::new();
    let mut repos: Vec<String> = Vec::new();
    let mut repo_aliases: Vec<String> = Vec::new();
    let mut json = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => json = true,
            "--window" => {
                let v = it.next().ok_or("--window needs a value")?;
                let w = match v.as_str() {
                    "d1" => Window::D1,
                    "d7" => Window::D7,
                    "d30" => Window::D30,
                    _ => {
                        return Err(format!(
                            "--window takes d1, d7 or d30, not {}",
                            query::quoted(v)
                        ));
                    }
                };
                if !windows.contains(&w) {
                    windows.push(w);
                }
            }
            "--repo" => {
                let v = it.next().ok_or("--repo needs a value")?;
                if !query::repo_ok(v) {
                    return Err(format!(
                        "--repo takes host/owner/repo as the meter normalizes a remote, not {}",
                        query::quoted(v)
                    ));
                }
                if v.len() > query::MAX_REPO_BYTES {
                    return Err(format!(
                        "--repo takes {} bytes; the most it takes is {}",
                        v.len(),
                        query::MAX_REPO_BYTES
                    ));
                }
                if !repos.iter().any(|r| r == v) {
                    repos.push(v.clone());
                }
            }
            "--repo-alias" => {
                let v = it.next().ok_or("--repo-alias needs a value")?;
                if !query::repo_ok(v) {
                    return Err(format!(
                        "--repo-alias takes host/owner/repo as the meter normalizes a remote, not {}",
                        query::quoted(v)
                    ));
                }
                if v.len() > query::MAX_REPO_BYTES {
                    return Err(format!(
                        "--repo-alias takes {} bytes; the most it takes is {}",
                        v.len(),
                        query::MAX_REPO_BYTES
                    ));
                }
                if !repo_aliases.contains(v) {
                    repo_aliases.push(v.clone());
                }
            }
            other => {
                return Err(format!(
                    "unknown option {} for coverage; see usagemeter --help",
                    query::quoted(other)
                ));
            }
        }
    }
    if !repo_aliases.is_empty() {
        if repos.is_empty() {
            return Err("--repo-alias requires --repo".into());
        }
        if repos.len() > 1 {
            return Err("--repo-alias requires a single --repo".into());
        }
        repo_aliases.retain(|a| a != &repos[0]);
        if repo_aliases.len() > query::MAX_REPO_ALIASES {
            return Err("at most 16 --repo-alias values may be given".into());
        }
    }
    if windows.is_empty() {
        windows = Window::ALL.to_vec();
    } else {
        windows.sort_by_key(|w| w.index());
    }
    Ok(Request {
        windows,
        repos,
        repo_aliases,
        json,
    })
}

// ---------------------------------------------------------------------------------------------
// Counting.

#[derive(Clone, Copy, Default)]
struct Counts {
    attributed: i64,
    ambiguous: i64,
    unlinked: i64,
    before_evidence: i64,
}

impl Counts {
    fn total(self) -> i64 {
        self.attributed
            .saturating_add(self.ambiguous)
            .saturating_add(self.unlinked)
            .saturating_add(self.before_evidence)
    }

    fn add(&mut self, class: Class, n: i64) {
        let n = n.max(0);
        let slot = match class {
            Class::Before => &mut self.before_evidence,
            Class::Attributed(_) => &mut self.attributed,
            Class::Ambiguous => &mut self.ambiguous,
            Class::Unlinked(_) => &mut self.unlinked,
        };
        *slot = slot.saturating_add(n);
    }

    fn add_counts(&mut self, o: Counts) {
        self.attributed = self.attributed.saturating_add(o.attributed);
        self.ambiguous = self.ambiguous.saturating_add(o.ambiguous);
        self.unlinked = self.unlinked.saturating_add(o.unlinked);
        self.before_evidence = self.before_evidence.saturating_add(o.before_evidence);
    }

    /// RFC 0026 (a): attributed over total, four decimals, null (never 0) when the total is 0.
    fn bot_coverage(self) -> Option<f64> {
        ratio(self.attributed, self.total())
    }

    /// RFC 0026 (a): the same numerator over the usage that is not before evidence, the
    /// diagnostic printed beside the headline.
    fn inspected(self) -> Option<f64> {
        let inspected = self
            .attributed
            .saturating_add(self.ambiguous)
            .saturating_add(self.unlinked);
        ratio(self.attributed, inspected)
    }
}

/// A part of the total: `part / total`, null when there is no counted usage.
fn ratio(part: i64, total: i64) -> Option<f64> {
    (total > 0).then(|| round4(part.max(0) as f64 / total as f64))
}

/// To four decimals, except a share above 0 that would round to 0: that keeps its exact value,
/// because a 0 is shown only when the share truly is zero (the query's cost rule, RFC 0026 (a)).
fn round4(v: f64) -> f64 {
    let r = (v * 10_000.0).round() / 10_000.0;
    if r == 0.0 && v > 0.0 { v } else { r }
}

/// The class's place in [`PARTS`]; None for attributed, which is the numerator.
fn part_index(class: Class) -> Option<usize> {
    match class {
        Class::Attributed(_) => None,
        Class::Ambiguous => Some(0),
        Class::Unlinked(Unlinked::NoRecord) => Some(1),
        Class::Unlinked(Unlinked::DshTuiSeat) => Some(2),
        Class::Unlinked(Unlinked::OtherMachine) => Some(3),
        Class::Before => Some(4),
    }
}

/// One class's tokens and the harnesses that logged them.
#[derive(Default)]
struct PartAcc {
    tokens: i64,
    harnesses: BTreeSet<String>,
}

/// A bot line's aggregates: its contract bot-key rows summed by bot id (RFC 0026 (a)).
#[derive(Default)]
struct BotAgg {
    tokens: i64,
    by_basis: [i64; 3],
    /// The union of the keys' `unrecorded` fields: a launch whose squad was not recorded is
    /// visible on the line, never hidden behind one whose squad was.
    unrecorded: u8,
    unrecorded_tokens: i64,
    harnesses: BTreeSet<String>,
}

impl BotAgg {
    fn add(&mut self, total: i64, basis: Basis, key: &BotKey) {
        self.tokens = self.tokens.saturating_add(total);
        let at = basis.index();
        self.by_basis[at] = self.by_basis[at].saturating_add(total);
        self.harnesses.insert(key.harness.clone());
        if key.unrecorded != 0 {
            self.unrecorded |= key.unrecorded;
            self.unrecorded_tokens = self.unrecorded_tokens.saturating_add(total);
        }
    }

    fn merge(&mut self, o: &BotAgg) {
        self.tokens = self.tokens.saturating_add(o.tokens);
        for i in 0..3 {
            self.by_basis[i] = self.by_basis[i].saturating_add(o.by_basis[i]);
        }
        self.unrecorded |= o.unrecorded;
        self.unrecorded_tokens = self.unrecorded_tokens.saturating_add(o.unrecorded_tokens);
        self.harnesses.extend(o.harnesses.iter().cloned());
    }
}

struct WinAcc {
    counts: Counts,
    parts: [PartAcc; 5],
    /// The tokens in `before_evidence` whose frozen rollup still carries a bot tag: the old
    /// definition's residue, never in the numerator (RFC 0026 (a)).
    before_tagged: i64,
    no_repo: i64,
    repos: BTreeMap<String, Counts>,
    bots: BTreeMap<String, BotAgg>,
}

impl WinAcc {
    fn new() -> WinAcc {
        WinAcc {
            counts: Counts::default(),
            parts: std::array::from_fn(|_| PartAcc::default()),
            before_tagged: 0,
            no_repo: 0,
            repos: BTreeMap::new(),
            bots: BTreeMap::new(),
        }
    }
}

fn read_meta(c: &Connection) -> rusqlite::Result<BTreeMap<String, String>> {
    let mut meta = BTreeMap::new();
    let mut st = c.prepare("SELECT k, v FROM meta")?;
    let mut q = st.query([])?;
    while let Some(r) = q.next()? {
        meta.insert(r.get(0)?, r.get(1)?);
    }
    Ok(meta)
}

fn read_health(c: &Connection) -> rusqlite::Result<BTreeMap<String, Option<i64>>> {
    let mut health = BTreeMap::new();
    let mut st = c.prepare("SELECT source, last_success_ms FROM health")?;
    let mut q = st.query([])?;
    while let Some(r) = q.next()? {
        health.insert(r.get(0)?, r.get(1)?);
    }
    Ok(health)
}

/// The oldest launch or link record: the backfill's horizon beside `evidence_from` (RFC 0026
/// (f)). A launch row written before RFC 0021 delivery 3 may have no `created_ms`; its
/// `valid_from` is when its span starts, so it carries the horizon back rather than forward.
/// Null when the store has kept neither.
fn oldest_record(c: &Connection) -> rusqlite::Result<Option<i64>> {
    c.query_row(
        "SELECT min(m) FROM (SELECT min(coalesce(created_ms, valid_from)) AS m FROM launch
                              UNION ALL SELECT min(valid_from) AS m FROM link)",
        [],
        |r| r.get(0),
    )
}

/// The store's repos, when the request names none.
fn store_repos(c: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut v = Vec::new();
    let mut st = c.prepare(
        "SELECT DISTINCT repo FROM usage WHERE repo IS NOT NULL AND repo != '' ORDER BY repo",
    )?;
    let mut q = st.query([])?;
    while let Some(r) = q.next()? {
        v.push(r.get(0)?);
    }
    Ok(v)
}

/// The last success every counting source has, as the query reports `as_of`: null unless every
/// source that counts has one.
fn as_of(meta: &BTreeMap<String, String>, health: &BTreeMap<String, Option<i64>>) -> Option<i64> {
    let mut min: Option<i64> = None;
    for s in Source::ALL {
        let (status, _) = crate::sync::source_status(|k| meta.get(k).cloned(), s);
        if !matches!(status.as_str(), "ok" | "degraded") {
            continue;
        }
        let t = health.get(s.harness()).copied().flatten()?;
        min = Some(min.map_or(t, |m| m.min(t)));
    }
    min
}

/// Whether a window is wholly at or after `evidence_from` (`full`), starts before it
/// (`partial`), or has none (`none`): RFC 0026 (a).
fn evidence_state(b: &query::Bounds, evidence_from: Option<i64>) -> &'static str {
    match evidence_from {
        None => "none",
        Some(f) if b.start >= f => "full",
        Some(f) if b.end <= f => "none",
        Some(_) => "partial",
    }
}

// ---------------------------------------------------------------------------------------------
// The record.

#[derive(Serialize, Clone, Copy, Default)]
struct Totals {
    attributed: i64,
    ambiguous: i64,
    unlinked: i64,
    before_evidence: i64,
    total: i64,
}

impl Totals {
    fn of(c: Counts) -> Totals {
        Totals {
            attributed: c.attributed,
            ambiguous: c.ambiguous,
            unlinked: c.unlinked,
            before_evidence: c.before_evidence,
            total: c.total(),
        }
    }
}

#[derive(Serialize)]
struct StoreOut {
    schema_version: i64,
    location: &'static str,
}

#[derive(Serialize)]
struct Record {
    v: u64,
    generated_at: String,
    meter_version: String,
    schema_version: i64,
    machine: String,
    store: StoreOut,
    counted_from: String,
    records_from: Option<String>,
    evidence_from: Option<String>,
    complete: bool,
    stale: bool,
    as_of: Option<String>,
    /// Every counting source is `ok` or `absent` and the old folder's store is not degraded: only
    /// then is a zero share or a `no_usage` repo a vouched 0 (RFC 0018's zero rule), otherwise
    /// they are unknown and their lines carry the unreadable sources.
    all_vouch: bool,
    /// The sources the query reports as `degraded` or `unsupported`, by harness, in its order.
    incomplete_sources: Vec<String>,
    /// True when any window's repo or bot list was capped at 50; every total still includes every
    /// repo and bot. The record's 64 KiB bound is the fleet step's per-machine cut (RFC 0026 (e)).
    truncated: bool,
    windows: Vec<WindowOut>,
}

#[derive(Serialize)]
struct WindowOut {
    window: &'static str,
    requested_start: String,
    start: String,
    end: String,
    clipped: bool,
    /// `full`, `partial` or `none` (RFC 0026 (a)).
    evidence: &'static str,
    evidence_from: Option<String>,
    complete: bool,
    stale: bool,
    totals: Totals,
    bot_coverage: Option<f64>,
    inspected: Option<f64>,
    parts: Vec<PartOut>,
    before_evidence_tagged: i64,
    no_repo: NoRepo,
    repos: Vec<RepoLine>,
    repos_shown: usize,
    repos_omitted: usize,
    repos_other: Option<RepoLine>,
    bots: Vec<BotLine>,
    bots_shown: usize,
    bots_omitted: usize,
    bots_other: Option<BotLine>,
    /// True when a repo or bot list was capped; every total still includes every repo and bot.
    truncated: bool,
}

#[derive(Serialize)]
struct PartOut {
    state: &'static str,
    reason: &'static str,
    tokens: i64,
    /// Null when there is no counted usage, and for a zero whose sources cannot vouch for it.
    share: Option<f64>,
    /// False only for a zero class share while a source is `degraded` or `unsupported`: the
    /// class may hold usage the meter could not read, so its 0 is unknown, not a vouched 0.
    vouched: bool,
    harnesses: Vec<String>,
}

#[derive(Serialize)]
struct NoRepo {
    tokens: i64,
    note: &'static str,
}

#[derive(Serialize)]
struct RepoLine {
    repo: String,
    /// `measured`; `no_usage` for a repo with no counted usage (a null ratio, never a 0) when
    /// every source vouches for it; `unknown` when one does not; or `other` (the omitted repos'
    /// line).
    state: &'static str,
    totals: Totals,
    bot_coverage: Option<f64>,
}

#[derive(Serialize)]
struct BasisOut {
    session: i64,
    label: i64,
    worktree: i64,
}

#[derive(Serialize)]
struct BotLine {
    bot: String,
    tokens: i64,
    share: f64,
    tokens_by_basis: BasisOut,
    /// The union of the contract's `unrecorded` fields behind this line (`[]` when every key
    /// recorded both role and squad).
    unrecorded: Vec<&'static str>,
    /// The tokens whose key left role or squad unrecorded: what the line's `unrecorded` hides.
    tokens_unrecorded: i64,
    harnesses: Vec<String>,
    /// True only for the `other` line: an individual bot behind it has no total of its own, so a
    /// per-bot token total read from it is a lower bound (RFC 0026 (a); a ratio never is).
    lower_bound: bool,
}

fn unrecorded_fields(mask: u8) -> Vec<&'static str> {
    let mut v = Vec::new();
    if mask & 1 != 0 {
        v.push("role");
    }
    if mask & 2 != 0 {
        v.push("squad");
    }
    v
}

fn bot_line(bot: String, agg: &BotAgg, total: i64) -> BotLine {
    BotLine {
        bot,
        tokens: agg.tokens,
        // The same four-decimal rule as `bot_coverage`: a share above 0 is never rounded to 0.
        share: ratio(agg.tokens, total).unwrap_or(0.0),
        tokens_by_basis: BasisOut {
            session: agg.by_basis[0],
            label: agg.by_basis[1],
            worktree: agg.by_basis[2],
        },
        unrecorded: unrecorded_fields(agg.unrecorded),
        tokens_unrecorded: agg.unrecorded_tokens,
        harnesses: agg.harnesses.iter().cloned().collect(),
        lower_bound: false,
    }
}

fn repo_line(repo: String, counts: Counts, all_vouch: bool) -> RepoLine {
    RepoLine {
        repo,
        state: if counts.total() > 0 {
            "measured"
        } else if all_vouch {
            "no_usage"
        } else {
            "unknown"
        },
        totals: Totals::of(counts),
        bot_coverage: counts.bot_coverage(),
    }
}

#[allow(clippy::too_many_arguments)]
fn window_out(
    window: Window,
    b: &query::Bounds,
    acc: WinAcc,
    repo_names: &[String],
    complete: bool,
    stale: bool,
    evidence_from: Option<i64>,
    all_vouch: bool,
) -> WindowOut {
    let totals = Totals::of(acc.counts);
    let parts: Vec<PartOut> = PARTS
        .iter()
        .enumerate()
        .map(|(i, (state, reason))| {
            let p = &acc.parts[i];
            // A zero share is a claim only a fully readable store can vouch for (RFC 0018).
            let vouched = !(p.tokens == 0 && totals.total > 0 && !all_vouch);
            PartOut {
                state,
                reason,
                tokens: p.tokens,
                share: if vouched {
                    ratio(p.tokens, totals.total)
                } else {
                    None
                },
                vouched,
                harnesses: p.harnesses.iter().cloned().collect(),
            }
        })
        .collect();

    // Repos and bots are capped by tokens, counted, and the rest summed into their other line, so
    // every total still includes every repo and every bot (RFC 0026 (g)).
    let mut repos: Vec<(String, Counts)> = repo_names
        .iter()
        .map(|name| {
            (
                name.clone(),
                acc.repos.get(name).copied().unwrap_or_default(),
            )
        })
        .collect();
    repos.sort_by(|a, b| b.1.total().cmp(&a.1.total()).then_with(|| a.0.cmp(&b.0)));
    let repos_omitted = repos.len().saturating_sub(MAX_REPOS);
    let mut other_repos = Counts::default();
    for (_, c) in repos.iter().skip(MAX_REPOS) {
        other_repos.add_counts(*c);
    }
    let repos_shown = repos.len().min(MAX_REPOS);
    let repos: Vec<RepoLine> = repos
        .into_iter()
        .take(MAX_REPOS)
        .map(|(name, c)| repo_line(name, c, all_vouch))
        .collect();
    let repos_other = (repos_omitted > 0).then(|| {
        let mut line = repo_line("other".into(), other_repos, all_vouch);
        line.state = "other";
        line
    });

    let mut bots: Vec<(String, BotAgg)> = acc.bots.into_iter().collect();
    bots.sort_by(|a, b| b.1.tokens.cmp(&a.1.tokens).then_with(|| a.0.cmp(&b.0)));
    let bots_omitted = bots.len().saturating_sub(MAX_BOTS);
    let mut other_bots = BotAgg::default();
    for (_, a) in bots.iter().skip(MAX_BOTS) {
        other_bots.merge(a);
    }
    let bots_shown = bots.len().min(MAX_BOTS);
    let bots: Vec<BotLine> = bots
        .into_iter()
        .take(MAX_BOTS)
        .map(|(name, agg)| bot_line(name, &agg, totals.total))
        .collect();
    let bots_other = (bots_omitted > 0).then(|| {
        let mut line = bot_line("other".into(), &other_bots, totals.total);
        line.lower_bound = true;
        line
    });

    WindowOut {
        window: window.name(),
        requested_start: format_rfc3339(b.requested_start),
        start: format_rfc3339(b.start),
        end: format_rfc3339(b.end),
        clipped: b.clipped,
        evidence: evidence_state(b, evidence_from),
        evidence_from: evidence_from.map(format_rfc3339),
        complete,
        stale,
        totals,
        bot_coverage: acc.counts.bot_coverage(),
        inspected: acc.counts.inspected(),
        parts,
        before_evidence_tagged: acc.before_tagged,
        no_repo: NoRepo {
            tokens: acc.no_repo,
            note: NO_REPO,
        },
        repos,
        repos_shown,
        repos_omitted,
        repos_other,
        bots,
        bots_shown,
        bots_omitted,
        bots_other,
        truncated: repos_omitted > 0 || bots_omitted > 0,
    }
}

// ---------------------------------------------------------------------------------------------
// The report.

fn report(
    c: &Connection,
    req: &Request,
    ctx: &query::Ctx,
    location: query::Location,
    stray: Option<&'static str>,
) -> Result<Option<Record>, Failure> {
    c.execute_batch("BEGIN").map_err(Failure::sql)?;
    let version = match query::schema_version(c).map_err(Failure::sql)? {
        None => return Ok(None),
        Some(v) => v,
    };
    if version > SCHEMA_VERSION {
        return Err(Failure::new(
            exit::NEWER_SCHEMA,
            "the store was written by a newer usagemeter; update the meter",
        ));
    }
    if version < SCHEMA_VERSION {
        return Err(Failure::new(
            exit::OUTDATED_STORE,
            "the store needs a migration that only usagemeter sync runs",
        ));
    }
    let meta = read_meta(c).map_err(Failure::sql)?;
    if !meta.contains_key("counted_from_ms") {
        return Ok(None);
    }
    let health = read_health(c).map_err(Failure::sql)?;
    let records_from = oldest_record(c).map_err(Failure::sql)?;
    let counted_from = query::meta_i64(&meta, "counted_from_ms").unwrap_or(0);
    let evidence_from = query::meta_i64(&meta, crate::evidence::FROM_META);
    let watermark = query::watermark(&meta);
    let stale_ms = query::DEFAULT_STALE_AFTER_S * 1000;
    let stale = watermark.is_none_or(|w| ctx.now_ms - w > stale_ms);
    let pending = |k: &str| query::meta_i64(&meta, k).map(|v| v.max(0));
    let complete =
        pending("last_pending_bytes") == Some(0) && pending("last_pending_files") == Some(0);
    // RFC 0018's zero rule: a zero share, or a repo with no usage, is vouched for only when every
    // source is ok or absent and the old folder's store (a stale, out-of-store source) is not
    // degraded. The query reports the same list on every row it answers.
    let srcs = query::sources(&meta, &health, stray, ctx.now_ms, stale_ms);
    let incomplete_sources: Vec<String> = srcs
        .iter()
        .filter(|s| matches!(s.status.as_str(), "degraded" | "unsupported"))
        .map(|s| s.harness.clone())
        .collect();
    let all_vouch = srcs
        .iter()
        .all(|s| matches!(s.status.as_str(), "ok" | "absent"));
    let bounds: Vec<(Window, query::Bounds)> = req
        .windows
        .iter()
        .map(|w| (*w, query::bounds(&meta, *w, ctx.now_ms)))
        .collect();
    // One read of the widest window serves all of them: every window ends at the same hour, so
    // the d30 start (or counted_from) is the earliest a row this report counts can have.
    let from = bounds
        .iter()
        .map(|(_, b)| b.start)
        .min()
        .unwrap_or(ctx.now_ms);
    let to = bounds.first().map(|(_, b)| b.end).unwrap_or(ctx.now_ms);
    let repo_names: Vec<String> = if req.repos.is_empty() {
        store_repos(c).map_err(Failure::sql)?
    } else {
        req.repos.clone()
    };

    let mut wins: Vec<WinAcc> = bounds.iter().map(|_| WinAcc::new()).collect();
    let named: BTreeSet<&str> = req.repos.iter().map(String::as_str).collect();
    query::scan_usage(c, None, from, to, evidence_from, &mut |mut r| {
        if r.repo
            .as_ref()
            .is_some_and(|repo| req.repo_aliases.contains(repo))
        {
            r.repo = Some(req.repos[0].clone());
        }
        let total = r.tokens.total;
        if total <= 0 {
            return;
        }
        for (i, (_, b)) in bounds.iter().enumerate() {
            if r.hour_ms < b.start || r.hour_ms >= b.end {
                continue;
            }
            let win = &mut wins[i];
            let Some(repo) = &r.repo else {
                win.no_repo = win.no_repo.saturating_add(total);
                continue;
            };
            if !named.is_empty() && !named.contains(repo.as_str()) {
                continue;
            }
            win.counts.add(r.class, total);
            win.repos
                .entry(repo.clone())
                .or_default()
                .add(r.class, total);
            if let Some(pi) = part_index(r.class) {
                let p = &mut win.parts[pi];
                p.tokens = p.tokens.saturating_add(total);
                p.harnesses.insert(r.harness.clone());
            }
            if r.class == Class::Before && r.tagged {
                win.before_tagged = win.before_tagged.saturating_add(total);
            }
            if let (Class::Attributed(basis), Some(key)) = (r.class, &r.bot) {
                win.bots
                    .entry(key.bot.clone())
                    .or_default()
                    .add(total, basis, key);
            }
        }
    })
    .map_err(Failure::sql)?;
    c.execute_batch("COMMIT").map_err(Failure::sql)?;

    let windows: Vec<WindowOut> = bounds
        .iter()
        .zip(wins)
        .map(|((window, b), acc)| {
            window_out(
                *window,
                b,
                acc,
                &repo_names,
                complete,
                stale,
                evidence_from,
                all_vouch,
            )
        })
        .collect();
    let truncated = windows.iter().any(|w| w.truncated);
    Ok(Some(Record {
        v: RECORD_VERSION,
        generated_at: format_rfc3339(ctx.now_ms),
        meter_version: ctx.meter_version.clone(),
        schema_version: version,
        machine: query::machine_id(&meta),
        store: StoreOut {
            schema_version: version,
            location: location.as_str(),
        },
        counted_from: format_rfc3339(counted_from),
        records_from: records_from.map(format_rfc3339),
        evidence_from: evidence_from.map(format_rfc3339),
        complete,
        stale,
        as_of: as_of(&meta, &health).map(format_rfc3339),
        all_vouch,
        incomplete_sources,
        truncated,
        windows,
    }))
}

/// Runs one report. `args` are the words after `coverage`.
pub fn run(args: &[String], ctx: &query::Ctx) -> Reply {
    let req = match parse(args) {
        Ok(r) => r,
        Err(m) => return Reply::err(exit::USAGE, m),
    };
    let Some(dirs) = &ctx.state else {
        return Reply::err(
            exit::ERROR,
            "HOME is not set; set METER_STATE_DIR to choose the state folder",
        );
    };
    let (db, location, stray) = match query::locate(dirs, ctx.overridden) {
        Ok(Located::Store {
            db,
            location,
            stray,
            ..
        }) => (db, location, stray),
        Ok(Located::Absent) => return Reply::err(exit::ABSENT_STORE, ABSENT),
        Err(m) => return Reply::err(exit::ERROR, m),
    };
    if query::read_only_folder(&db) {
        return Reply::err(exit::ERROR, query::READ_ONLY_FOLDER);
    }
    let conn = match query::open_read_only(&db, ctx.busy) {
        Ok(c) => c,
        Err(e) => {
            let code = if query::is_busy(&e) {
                exit::LOCKED
            } else {
                exit::ERROR
            };
            return Reply::err(code, format!("the store could not be read: {e}"));
        }
    };
    let record = match report(&conn, &req, ctx, location, stray) {
        Ok(Some(r)) => r,
        Ok(None) => return Reply::err(exit::ABSENT_STORE, ABSENT),
        Err(f) => return Reply::err(f.code, f.message),
    };
    drop(conn);
    if req.json {
        return match serde_json::to_string(&record) {
            Ok(mut s) => {
                s.push('\n');
                Reply::ok(s)
            }
            Err(e) => Reply::err(exit::ERROR, format!("the report could not be written: {e}")),
        };
    }
    Reply::ok(text(&record))
}

// ---------------------------------------------------------------------------------------------
// The text report.

fn or_null(t: &Option<String>) -> &str {
    t.as_deref().unwrap_or("null")
}

/// A share as a percentage; above 0 but below the last digit it prints as `<0.0001%`, never as 0.
fn percent(part: i64, total: i64) -> String {
    if total <= 0 {
        return "null".into();
    }
    let p = part.max(0) as f64 / total as f64 * 100.0;
    let s = format!("{p:.4}%");
    if s == "0.0000%" && part > 0 {
        "<0.0001%".into()
    } else {
        s
    }
}

fn fraction(v: Option<f64>) -> String {
    match v {
        None => "null".into(),
        Some(v) => {
            let s = format!("{v:.4}");
            if s == "0.0000" && v > 0.0 {
                "<0.0001".into()
            } else {
                s
            }
        }
    }
}

fn harnesses(h: &[String]) -> String {
    if h.is_empty() {
        "[]".into()
    } else {
        format!("[{}]", h.join(", "))
    }
}

fn text(r: &Record) -> String {
    let mut o = String::new();
    let _ = writeln!(
        o,
        "coverage: machine {}; schema {} (store {}); meter {}",
        r.machine, r.schema_version, r.store.location, r.meter_version
    );
    let _ = writeln!(
        o,
        "generated {}; counted_from {}; records_from {}; evidence_from {}",
        r.generated_at,
        r.counted_from,
        or_null(&r.records_from),
        or_null(&r.evidence_from)
    );
    let _ = writeln!(
        o,
        "ingestion complete: {}; stale: {}; as_of: {}; {} window(s), every ratio over counted usage",
        yes(r.complete),
        yes(r.stale),
        or_null(&r.as_of),
        r.windows.len()
    );
    if r.all_vouch {
        let _ = writeln!(o, "sources: every counting source is ok or absent");
    } else {
        let _ = writeln!(
            o,
            "sources unreadable: {} (their usage is not counted: zero shares and no_usage repos \
             are unknown here, not vouched 0s)",
            r.incomplete_sources.join(", ")
        );
    }
    if r.truncated {
        let _ = writeln!(
            o,
            "lists capped at {MAX_REPOS} repos and {MAX_BOTS} bots; every total still includes \
             every repo and bot"
        );
    }
    for w in &r.windows {
        let _ = writeln!(o);
        let _ = writeln!(
            o,
            "window {}: {} .. {} (requested start {}{})",
            w.window,
            w.start,
            w.end,
            w.requested_start,
            if w.clipped {
                "; clipped to counted_from"
            } else {
                ""
            }
        );
        let _ = writeln!(
            o,
            "  counted_from {}; records_from {}; evidence_from {}; evidence {}",
            r.counted_from,
            or_null(&r.records_from),
            w.evidence_from.as_deref().unwrap_or("null"),
            w.evidence
        );
        let _ = writeln!(
            o,
            "  ingestion complete: {}; stale: {}; clipped: {}",
            yes(w.complete),
            yes(w.stale),
            yes(w.clipped)
        );
        if !r.all_vouch {
            let _ = writeln!(
                o,
                "  sources unreadable: {} (zero shares in this window are unknown, not vouched 0s)",
                r.incomplete_sources.join(", ")
            );
        }
        let headline = if w.totals.total > 0 && w.totals.attributed == 0 && !r.all_vouch {
            "bot_coverage unknown (no token is attributed and a source is unreadable, so a zero \
             cannot be vouched for)"
                .to_string()
        } else {
            match w.bot_coverage {
                None => "bot_coverage null (no counted usage in this window)".to_string(),
                Some(_) if w.evidence == "none" => format!(
                    "bot_coverage {} (evidence none: every counted token is before evidence, a \
                     measured 0, not unknown)",
                    fraction(w.bot_coverage)
                ),
                Some(_) => format!(
                    "bot_coverage {} of the {} counted tokens (attributed {}, over counted usage)",
                    fraction(w.bot_coverage),
                    w.totals.total,
                    w.totals.attributed
                ),
            }
        };
        let _ = writeln!(o, "  {headline}");
        if w.evidence == "partial" {
            let _ = writeln!(
                o,
                "  evidence partial: the headline includes the part before evidence; inspected is \
                 the part the meter can vouch for"
            );
        }
        if w.totals.total > 0 {
            let _ = writeln!(
                o,
                "  tokens {}{}",
                w.totals.total,
                if w.complete && !w.stale && !w.clipped {
                    ""
                } else {
                    " (at least: the window or the store leaves usage uncounted)"
                }
            );
        }
        let _ = writeln!(
            o,
            "  inspected {} (diagnostic: attributed / (attributed + ambiguous + unlinked); always \
             printed, never the headline)",
            fraction(w.inspected)
        );
        let zero_unknown = |tokens: i64| tokens == 0 && w.totals.total > 0 && !r.all_vouch;
        let share = |tokens: i64| {
            if zero_unknown(tokens) {
                "unknown".to_string()
            } else {
                percent(tokens, w.totals.total)
            }
        };
        let _ = writeln!(
            o,
            "  attributed {} ({:>9} of the counted tokens; the bots below are its split)",
            w.totals.attributed,
            share(w.totals.attributed)
        );
        let _ = writeln!(o, "  classes (part / total):");
        for p in &w.parts {
            let _ = writeln!(
                o,
                "    {:<30} {:>10}  {:>10}  {}",
                format!("{}/{}", p.state, p.reason),
                p.tokens,
                share(p.tokens),
                harnesses(&p.harnesses)
            );
        }
        let _ = writeln!(
            o,
            "  before_evidence_tagged {} (the old definition's frozen tag, never in the numerator)",
            w.before_evidence_tagged
        );
        let _ = writeln!(
            o,
            "  no_repo {} tokens ({})",
            w.no_repo.tokens, w.no_repo.note
        );
        let _ = writeln!(
            o,
            "  repos: {} shown, {} omitted (counts attributed/ambiguous/unlinked/\
             before_evidence, total, bot_coverage)",
            w.repos_shown, w.repos_omitted
        );
        for line in &w.repos {
            let coverage = if line.state == "unknown" {
                "unknown".to_string()
            } else {
                fraction(line.bot_coverage)
            };
            let _ = writeln!(
                o,
                "    {}  {}/{}/{}/{}  {}  {}",
                line.repo,
                line.totals.attributed,
                line.totals.ambiguous,
                line.totals.unlinked,
                line.totals.before_evidence,
                line.totals.total,
                coverage
            );
        }
        if let Some(line) = &w.repos_other {
            let _ = writeln!(
                o,
                "    other ({} repos omitted)  {}/{}/{}/{}  {}  {}",
                w.repos_omitted,
                line.totals.attributed,
                line.totals.ambiguous,
                line.totals.unlinked,
                line.totals.before_evidence,
                line.totals.total,
                fraction(line.bot_coverage)
            );
        }
        let _ = writeln!(
            o,
            "  bots: {} shown, {} omitted",
            w.bots_shown, w.bots_omitted
        );
        for line in &w.bots {
            let _ = writeln!(o, "    {}", bot_text(line, w.totals.total));
        }
        if w.bots_shown + w.bots_omitted > 1 {
            let _ = writeln!(
                o,
                "  bot shares are each rounded to four decimals; their sum can differ from the \
                 attributed share by rounding"
            );
        }
        if let Some(line) = &w.bots_other {
            let _ = writeln!(
                o,
                "    other ({} bots omitted; an omitted bot's own token total is a lower bound, \
                 the line sums them exactly, and a bot without a line is not 0): {}",
                w.bots_omitted,
                bot_text(line, w.totals.total)
            );
        }
        if w.truncated {
            let _ = writeln!(
                o,
                "  truncated: yes (the caps above; every total still includes every repo and bot)"
            );
        }
    }
    o
}

fn bot_text(line: &BotLine, total: i64) -> String {
    format!(
        "{}  {} tokens  {} of total; basis session {}, label {}, worktree {}; unrecorded {}; \
         tokens_unrecorded {}; {}",
        line.bot,
        line.tokens,
        percent(line.tokens, total),
        line.tokens_by_basis.session,
        line.tokens_by_basis.label,
        line.tokens_by_basis.worktree,
        if line.unrecorded.is_empty() {
            "none".to_string()
        } else {
            line.unrecorded.join(", ")
        },
        line.tokens_unrecorded,
        harnesses(&line.harnesses)
    )
}

fn yes(b: bool) -> &'static str {
    if b { "yes" } else { "no" }
}
