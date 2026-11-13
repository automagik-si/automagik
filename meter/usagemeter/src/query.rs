//! `usagemeter query`: the meter's answer for genie, contract 1 (RFC 0018 (a)). The schema is
//! `meter/schema/query/v1/envelope.schema.json`, and its examples are this module's fixtures.
//!
//! It is fork-and-exit and never writes the store: it opens an existing store with
//! `SQLITE_OPEN_READ_ONLY` and no checkpoint on close, reads one snapshot in one read transaction
//! and prints one envelope on stdout. The database's content never changes. For a WAL store,
//! SQLite itself may create the store's `-wal` and `-shm` companions, as RFC 0018 (a) allows; no
//! other file or folder is created, nothing is migrated or synced, `meter.lock` is never taken,
//! and there is no `hc` call, no git call and no network. In a state folder the meter cannot
//! write, a store without those companions is refused by name (`read_only_folder`): SQLite could
//! not open it without writing, and an `immutable` open is never used, because a sync elsewhere
//! may be writing. Every exit the contract defines prints an envelope, refusals included, and the
//! request is checked against the byte budget before the store is opened.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension};
use serde::{Serialize, Serializer};
use sha2::{Digest, Sha256};

use crate::paths::{self, StateDirs};
use crate::prices::PriceTable;
use crate::sources::Source;
use crate::store::SCHEMA_VERSION;
use crate::time::{DAY_MS, HOUR_MS, format_rfc3339, hour_start};

pub const CONTRACT: &str = "usagemeter.query";
pub const CONTRACT_VERSION: u64 = 1;
pub const CAPABILITY: &str = "meter.usage@1";
pub const SUPPORTED_CONTRACTS: [u64; 1] = [1];

/// The byte budget (RFC 0018 (a), "The byte budget").
pub const MAX_BRANCHES: usize = 500;
pub const MAX_BRANCH_BYTES: usize = 255;
pub const MAX_NAMES_BYTES: usize = 65_536;
pub const MAX_REPO_BYTES: usize = 512;
pub const MAX_REPO_ALIASES: usize = 16;
/// The whole envelope as written to stdout, its line feed included.
pub const OUTPUT_CAP: usize = 458_752;
/// A refusal keeps the leading names whose echo fits here.
pub const REFUSAL_ECHO_BYTES: usize = 4096;
/// A row's bound, its actor block at its largest included (RFC 0018, amended by RFC 0021
/// delivery 6: it was 2 KiB before the block).
pub const ROW_BYTES: usize = 2304;
pub const METADATA_BYTES: usize = 16_384;
pub const REFUSAL_BYTES: usize = 8192;
pub const MESSAGE_CHARS: usize = 1000;
pub const LABEL_CHARS: usize = 200;
/// `unpriced_models` keeps the models with the most unpriced tokens, each name cut to this many
/// bytes as JSON; `tokens_unpriced` still counts every one.
pub const UNPRICED_MODELS_MAX: usize = 8;
pub const MODELS_MAX: usize = 8;
pub const MODEL_NAME_BYTES: usize = 40;
/// A user's string quoted in an error message is cut to this many characters.
const QUOTED_CHARS: usize = 64;
pub const MACHINE_ID_CHARS: usize = 128;

pub const DEFAULT_STALE_AFTER_S: i64 = 7200;
pub const MIN_STALE_AFTER_S: i64 = 60;
pub const MAX_STALE_AFTER_S: i64 = 30 * 24 * 3600;
/// How long the query waits for a consistent snapshot (exit 11 past it).
pub const BUSY_BUDGET: Duration = Duration::from_secs(2);
pub const RETRY_AFTER_S: i64 = 5;

/// The source entry that reports usage an older meter wrote to the old state folder after the
/// move: it never reaches the query, so no row may claim to be complete beside it.
pub const LEGACY_STORE: &str = "legacy-store";

/// Exit codes (RFC 0018 (a), "Exit codes").
pub mod exit {
    pub const OK: u8 = 0;
    pub const ERROR: u8 = 1;
    pub const USAGE: u8 = 2;
    pub const ABSENT_STORE: u8 = 10;
    pub const LOCKED: u8 = 11;
    pub const NEWER_SCHEMA: u8 = 12;
    pub const OUTDATED_STORE: u8 = 13;
    pub const UNSUPPORTED_CONTRACT: u8 = 14;
    pub const TOO_LARGE: u8 = 15;
}

/// What the query needs from its surroundings; the binary fills it from the environment.
#[derive(Debug, Clone)]
pub struct Ctx {
    /// None when neither `METER_STATE_DIR` nor `HOME` is set.
    pub state: Option<StateDirs>,
    /// `METER_STATE_DIR` chose `state.dir`: it is the only place looked at.
    pub overridden: bool,
    pub now_ms: i64,
    pub busy: Duration,
    pub meter_version: String,
}

impl Ctx {
    pub fn from_env() -> Ctx {
        let var = |k: &str| std::env::var_os(k);
        Ctx {
            state: paths::state_dirs(var),
            overridden: var("METER_STATE_DIR").is_some_and(|v| !v.is_empty()),
            now_ms: crate::time::now_ms(),
            busy: BUSY_BUDGET,
            meter_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

/// One call's result: the exit code and everything for stdout (one line of compact JSON).
#[derive(Debug, Clone)]
pub struct Answer {
    pub code: u8,
    pub stdout: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Window {
    D1,
    D7,
    D30,
    D90,
}

impl Window {
    /// Contract 1's windows, in the order a report prints them.
    pub(crate) const ALL: [Window; 3] = [Window::D1, Window::D7, Window::D30];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Window::D1 => "d1",
            Window::D7 => "d7",
            Window::D30 => "d30",
            Window::D90 => "d90",
        }
    }

    pub(crate) fn days(self) -> i64 {
        match self {
            Window::D1 => 1,
            Window::D7 => 7,
            Window::D30 => 30,
            Window::D90 => 90,
        }
    }

    /// The window's place in contract 1's order.
    pub(crate) fn index(self) -> usize {
        match self {
            Window::D1 => 0,
            Window::D7 => 1,
            Window::D30 => 2,
            Window::D90 => 3,
        }
    }
}

/// A window's bounds, as the query reads it: contract 1's `d1`/`d7`/`d30`, clipped to
/// `counted_from` and ending at the end of the hour that holds the watermark (the generated time's
/// hour while there is none). The coverage report prints the same numbers, so the two cannot
/// disagree about what a window is.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Bounds {
    pub(crate) requested_start: i64,
    pub(crate) start: i64,
    pub(crate) end: i64,
    pub(crate) clipped: bool,
}

pub(crate) fn bounds(meta: &BTreeMap<String, String>, window: Window, now_ms: i64) -> Bounds {
    let end = hour_start(watermark(meta).unwrap_or(now_ms)) + HOUR_MS;
    let requested_start = end - window.days() * DAY_MS;
    let counted_from = meta_i64(meta, "counted_from_ms").unwrap_or(requested_start);
    let start = requested_start.max(counted_from);
    Bounds {
        requested_start,
        start,
        end,
        clipped: start > requested_start,
    }
}

#[derive(Debug, Clone)]
struct Request {
    repo: String,
    repo_aliases: Vec<String>,
    window: Window,
    interval: Option<(i64, i64)>,
    /// What a row is keyed by: the branch (default), the bot, or the task.
    by: By,
    branches: Vec<String>,
    stale_after_s: i64,
}

impl Request {
    fn bounds(&self, meta: &BTreeMap<String, String>, now_ms: i64) -> Bounds {
        let Some((since, until)) = self.interval else {
            return bounds(meta, self.window, now_ms);
        };
        let counted = meta_i64(meta, "counted_from_ms").unwrap_or(since);
        let evidence = meta_i64(meta, crate::evidence::FROM_META);
        Bounds {
            requested_start: since,
            start: evidence.map_or(until, |ev| since.max(counted.max(ev)).min(until)),
            end: until,
            clipped: since < counted || evidence.is_none_or(|ev| since < ev),
        }
    }
}

/// What the answer's rows are keyed by (RFC 0018 (a); `--by bot` is RFC 0021 D1, `--by task` is
/// RFC 0018 M3 and RFC 0021 D4). An answer holds one kind of row, by this (D2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum By {
    /// The default: one row per distinct branch named.
    Branch,
    /// `--by bot`: bot rows, the branches named an optional filter (RFC 0021 (d)).
    Bot,
    /// `--by task`: task rows, the branches named an optional filter (RFC 0018 M3).
    Task,
}

impl By {
    /// The value `query.by` echoes: absent for branch rows.
    fn echo(self) -> Option<&'static str> {
        match self {
            By::Branch => None,
            By::Bot => Some("bot"),
            By::Task => Some("task"),
        }
    }

    /// The line `request_sha256` adds after the window: `by <by>` for a non-branch answer.
    fn hash_line(self) -> Option<&'static str> {
        match self {
            By::Branch => None,
            By::Bot => Some("by bot"),
            By::Task => Some("by task"),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The envelope. Field order follows the schema; `Option` serializes as null.

#[derive(Serialize)]
struct Envelope {
    contract: &'static str,
    contract_version: u64,
    capability: &'static str,
    meter_version: String,
    status: &'static str,
    error: Option<ErrorObj>,
    generated_at: String,
    as_of: Option<String>,
    machine: Option<Machine>,
    store: Option<StoreInfo>,
    ingestion: Option<Ingestion>,
    window: Option<WindowInfo>,
    sources: Vec<SourceInfo>,
    unattributed: Option<Unattributed>,
    /// Present exactly when the meter reports actors (every answer, RFC 0021 (d)); a refusal
    /// reports none and leaves it out.
    #[serde(skip_serializing_if = "Option::is_none")]
    actor_unattributed: Option<ActorUnattributed>,
    pricing: Option<Pricing>,
    query: Option<Echo>,
    rows: Vec<Row>,
}

#[derive(Serialize, Clone, Default)]
struct ErrorObj {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_s: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    store_schema_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supported_schema_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supported_contracts: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    needed_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rows_fit: Option<usize>,
}

impl ErrorObj {
    fn new(code: &'static str, message: impl Into<String>) -> ErrorObj {
        ErrorObj {
            code,
            message: chars(&message.into(), MESSAGE_CHARS),
            ..ErrorObj::default()
        }
    }
}

#[derive(Serialize, Clone)]
struct Machine {
    id: String,
    scope: &'static str,
}

#[derive(Serialize, Clone)]
struct StoreInfo {
    schema_version: i64,
    location: &'static str,
}

#[derive(Serialize)]
struct Ingestion {
    watermark: Option<String>,
    counted_from: String,
    evidence_from: Option<String>,
    complete: bool,
    backlog: Backlog,
    stale: bool,
    stale_after_s: i64,
}

/// None: unknown (a reset's re-import has not finished a run yet, or a store that never
/// recorded it). Unknown is never shown as 0, and makes the answer incomplete.
#[derive(Serialize)]
struct Backlog {
    bytes: Option<i64>,
    files: Option<i64>,
}

#[derive(Serialize)]
struct WindowInfo {
    name: &'static str,
    requested_start: String,
    start: String,
    end: String,
    clipped: bool,
}

#[derive(Serialize, Clone)]
pub(crate) struct SourceInfo {
    pub(crate) harness: String,
    pub(crate) status: String,
    reason: Option<String>,
    last_success: Option<String>,
    stale: bool,
}

#[derive(Serialize)]
struct Unattributed {
    tokens_total: i64,
    harnesses: Vec<String>,
}

/// The repo's usage in the window given to no bot (RFC 0021 (d), delivery 2 D5).
#[derive(Serialize)]
struct ActorUnattributed {
    tokens_total: i64,
    tokens_ambiguous: i64,
    tokens_unlinked: i64,
    tokens_before_evidence: i64,
    parts: Vec<ActorPart>,
    absent_bot_is_zero: bool,
}

#[derive(Serialize)]
struct ActorPart {
    state: &'static str,
    reason: &'static str,
    tokens_total: i64,
    harnesses: Vec<String>,
}

#[derive(Serialize)]
struct Pricing {
    table: PriceInfo,
    reported_wins: bool,
    long_prompt_tiers: bool,
}

#[derive(Serialize)]
struct PriceInfo {
    origin: &'static str,
    date: String,
    source: &'static str,
    label: &'static str,
    sha256: Option<String>,
}

#[derive(Serialize, Clone)]
struct Echo {
    repo: String,
    /// Present, and false, only when `repo` was cut to fit its bound (a refusal).
    #[serde(skip_serializing_if = "Option::is_none")]
    repo_complete: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    repo_aliases: Vec<String>,
    window: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    until: Option<String>,
    /// `bot` for a `--by bot` request; absent for branch rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    by: Option<&'static str>,
    branch_count: usize,
    branches: Vec<String>,
    branches_complete: bool,
    request_sha256: String,
}

/// A row is a branch row, or, for `--by bot` or `--by task`, a bot or task row: one kind per
/// answer, by `query.by` (RFC 0021 D2).
#[derive(Serialize)]
#[serde(untagged)]
enum Row {
    Branch(Box<BranchRow>),
    Bot(Box<BotRow>),
    Task(Box<TaskRow>),
}

#[derive(Serialize)]
struct BranchRow {
    branch: String,
    requested: usize,
    state: &'static str,
    reason: Option<&'static str>,
    tokens: Option<TokensOut>,
    cost: Option<Cost>,
    models: Vec<ModelOut>,
    models_omitted: usize,
    token_precision: Option<&'static str>,
    attribution: Attribution,
    activity: Option<Activity>,
    incomplete_sources: Vec<String>,
}

#[derive(Serialize, Clone, Copy)]
pub(crate) struct TokensOut {
    input: i64,
    cache_read: i64,
    cache_write_5m: i64,
    cache_write_1h: i64,
    output: i64,
    /// None when a harness that counted toward the row logs no reasoning split (dsh-tui): its
    /// reasoning is inside `output` and unknown, never 0.
    reasoning: Option<i64>,
    unsplit: i64,
    pub(crate) total: i64,
}

/// Nothing yet: every count 0, reasoning a known 0 until a row that does not log it is added.
impl Default for TokensOut {
    fn default() -> TokensOut {
        TokensOut {
            input: 0,
            cache_read: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            output: 0,
            reasoning: Some(0),
            unsplit: 0,
            total: 0,
        }
    }
}

#[derive(Serialize)]
struct Cost {
    state: &'static str,
    #[serde(serialize_with = "usd")]
    usd: Option<f64>,
    #[serde(serialize_with = "usd")]
    usd_reported: Option<f64>,
    #[serde(serialize_with = "usd")]
    usd_estimated: Option<f64>,
    tokens_priced: i64,
    tokens_reported: i64,
    tokens_unpriced: i64,
    unpriced_models: Vec<String>,
    /// How many unpriced models `unpriced_models` leaves out past its cap: none goes silently.
    unpriced_models_omitted: usize,
}

/// One model's usage on a row (R1b, #1098): ordered by `tokens.total` descending, ties by
/// `model` ascending. `cost_usd` is `None` (`null`) when none of the model's calls on the row
/// is priced or reported (unknown, never 0).
#[derive(Serialize, Clone)]
struct ModelOut {
    model: String,
    calls: i64,
    tokens: TokensOut,
    #[serde(serialize_with = "usd")]
    cost_usd: Option<f64>,
}

/// A bot row (RFC 0021 (d)): the attributed usage of one bot key in the repo and window.
#[derive(Serialize)]
struct BotRow {
    bot: String,
    kind: String,
    role: Option<String>,
    squad: Option<String>,
    unrecorded: Vec<&'static str>,
    harness: String,
    state: &'static str,
    reason: Option<&'static str>,
    tokens: TokensOut,
    cost: Cost,
    models: Vec<ModelOut>,
    models_omitted: usize,
    token_precision: &'static str,
    attribution: Attribution,
    activity: Activity,
    incomplete_sources: Vec<String>,
}

/// A task row (RFC 0018 M3, RFC 0021 D4): one task id's usage in the repo and window, with the
/// launch tags that did the work. A task id the meter ties to more than one checkout of the repo
/// is never summed: the row is `missing` with `task_ambiguous` and no numbers.
#[derive(Serialize)]
struct TaskRow {
    task: String,
    actors: Vec<TaskActor>,
    /// Actor keys the row's bound left out past its byte budget: above 0, the task had more
    /// workers than the row can name (the trailing ones in key order), never a silent cut.
    actors_omitted: usize,
    state: &'static str,
    reason: Option<&'static str>,
    tokens: Option<TokensOut>,
    cost: Option<Cost>,
    models: Vec<ModelOut>,
    models_omitted: usize,
    token_precision: Option<&'static str>,
    attribution: Attribution,
    activity: Option<Activity>,
    incomplete_sources: Vec<String>,
}

/// One launch tag that did part of a task's work: the bot key a bot row is keyed by, without its
/// numbers. The task row's tokens are theirs together, so several bots/roles are named, never
/// one guessed.
#[derive(Serialize)]
struct TaskActor {
    bot: String,
    kind: &'static str,
    role: Option<String>,
    squad: Option<String>,
    unrecorded: Vec<&'static str>,
    harness: String,
}

impl TaskActor {
    fn of(key: BotKey) -> TaskActor {
        let unrecorded = key.unrecorded();
        TaskActor {
            bot: key.bot,
            kind: "worker",
            role: key.role,
            squad: key.squad,
            unrecorded,
            harness: key.harness,
        }
    }
}

#[derive(Serialize)]
struct Attribution {
    precision: &'static str,
    exclusive: bool,
    shared: bool,
    coverage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    actor: Option<ActorOut>,
}

/// Who a row's tokens belong to (RFC 0021 (d)): the four counts add up to `tokens.total`,
/// `tokens_by_basis` to `tokens_attributed`, and `tokens_by_branch_basis` to `tokens.total`.
#[derive(Serialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
struct ActorOut {
    tokens_attributed: i64,
    tokens_ambiguous: i64,
    tokens_unlinked: i64,
    tokens_before_evidence: i64,
    tokens_by_basis: ByBasis,
    tokens_by_branch_basis: ByBranchBasis,
}

#[derive(Serialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
struct ByBasis {
    session: i64,
    label: i64,
    worktree: i64,
}

#[derive(Serialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
struct ByBranchBasis {
    log: i64,
    ledger: i64,
    none: i64,
}

#[derive(Serialize)]
struct Activity {
    first_hour: Option<String>,
    last_hour: Option<String>,
    hours: usize,
    harnesses: Vec<String>,
}

/// USD to four decimals ([`round_usd`]), written as an integer when it is whole (`0`, not `0.0`).
fn usd<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        None => s.serialize_none(),
        Some(v) => {
            let r = round_usd(*v);
            if r.fract() == 0.0 && r.abs() < 9.0e15 {
                s.serialize_i64(r as i64)
            } else {
                s.serialize_f64(r)
            }
        }
    }
}

/// To four decimals, except an amount above 0 that would round to 0: that keeps its exact value
/// (`0.00002`), because a 0 is shown only when the cost truly is zero.
fn round_usd(v: f64) -> f64 {
    let r = (v * 10_000.0).round() / 10_000.0;
    if r == 0.0 && v > 0.0 { v } else { r }
}

// ---------------------------------------------------------------------------------------------
// Bounded strings.

/// At most `n` characters.
fn chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The bytes `s` takes as a JSON string, quotes included (serde_json's escaping).
fn json_len(s: &str) -> usize {
    2 + s
        .chars()
        .map(|c| match c {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
            c if (c as u32) < 0x20 => 6,
            c => c.len_utf8(),
        })
        .sum::<usize>()
}

/// `s` cut, at a whole character, so that it takes at most `max` bytes as a JSON string; a cut
/// name ends in `…` so a reader never takes it for a whole one.
fn json_bounded(s: &str, max: usize) -> String {
    if json_len(s) <= max {
        return s.to_string();
    }
    let mut out = String::new();
    for c in s.chars() {
        let mut next = out.clone();
        next.push(c);
        if json_len(&next) + '…'.len_utf8() > max {
            break;
        }
        out = next;
    }
    out.push('…');
    out
}

pub(crate) fn quoted(s: &str) -> String {
    let cut: String = s.chars().take(QUOTED_CHARS).collect();
    if cut.len() < s.len() {
        format!("\"{cut}…\"")
    } else {
        format!("\"{cut}\"")
    }
}

// ---------------------------------------------------------------------------------------------
// The request.

/// A refusal before or instead of an answer.
struct Refusal {
    code: u8,
    status: &'static str,
    error: ErrorObj,
    echo: Option<Echo>,
    store: Option<StoreInfo>,
    machine: Option<Machine>,
}

impl Refusal {
    fn usage(message: impl Into<String>) -> Refusal {
        Refusal {
            code: exit::USAGE,
            status: "usage",
            error: ErrorObj::new("usage", message),
            echo: None,
            store: None,
            machine: None,
        }
    }
}

/// Git and the meter refuse a branch holding a space, a backslash or a control character (the
/// schema's `\s` includes U+FEFF), so `"` is the only character escaping can grow.
pub fn branch_ok(b: &str) -> bool {
    !b.is_empty()
        && !b
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\\' || c == '\u{feff}')
}

/// The schema's repo form: `host/owner/repo`, host lower-case and at most 253 bytes (a DNS name),
/// every segment non-empty.
pub fn repo_ok(r: &str) -> bool {
    let mut parts = r.split('/');
    let host = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && !rest.is_empty()
        && rest
            .iter()
            .all(|s| !s.is_empty() && !s.chars().any(|c| c.is_whitespace() || c == '\u{feff}'))
}

/// The request's hash: repo, each `alias <repo>` line, window, custom interval bounds,
/// optional `by <by>`, then each branch, each followed by a line feed. The prefixed lines hold a space, which no window or
/// branch can, so they are unambiguous. No aliases preserves the original hash.
fn request_sha256(
    repo: &str,
    aliases: &[String],
    window: &str,
    interval: Option<(i64, i64)>,
    by: By,
    branches: &[String],
) -> String {
    let mut h = Sha256::new();
    let aliases: Vec<String> = aliases.iter().map(|a| format!("alias {a}")).collect();
    let interval_lines: Vec<String> = interval
        .map(|(since, until)| {
            vec![
                format!("since {}", format_rfc3339(since)),
                format!("until {}", format_rfc3339(until)),
            ]
        })
        .unwrap_or_default();
    for part in std::iter::once(repo)
        .chain(aliases.iter().map(String::as_str))
        .chain(std::iter::once(window))
        .chain(interval_lines.iter().map(String::as_str))
        .chain(by.hash_line())
        .chain(branches.iter().map(String::as_str))
    {
        h.update(part.as_bytes());
        h.update(b"\n");
    }
    crate::event::hex(&h.finalize())
}

/// The request echoed back. A refusal keeps the leading names that fit in 4 KiB (each name
/// counted as its JSON bytes plus a comma), cut at a whole name: at most 500, none past 255 bytes.
fn echo(
    repo: &str,
    aliases: &[String],
    window: Window,
    interval: Option<(i64, i64)>,
    by: By,
    branches: &[String],
    capped: bool,
) -> Echo {
    let mut kept = Vec::new();
    let mut used = 0;
    for b in branches {
        let cost = json_len(b) + 1;
        if capped
            && (used + cost > REFUSAL_ECHO_BYTES
                || b.len() > MAX_BRANCH_BYTES
                || kept.len() == MAX_BRANCHES)
        {
            break;
        }
        used += cost;
        kept.push(b.clone());
    }
    let (repo_echo, repo_complete) = if repo.len() > MAX_REPO_BYTES {
        // The host is at most 253 bytes (`repo_ok`), so the cut keeps `host/` and part of a
        // segment: still the repo form.
        let mut end = MAX_REPO_BYTES;
        while !repo.is_char_boundary(end) {
            end -= 1;
        }
        (repo[..end].trim_end_matches('/').to_string(), Some(false))
    } else {
        (repo.to_string(), None)
    };
    let name = if interval.is_some() {
        "custom"
    } else {
        window.name()
    };
    Echo {
        repo: repo_echo,
        repo_complete,
        repo_aliases: aliases.to_vec(),
        window: name,
        since: interval.map(|(s, _)| format_rfc3339(s)),
        until: interval.map(|(_, u)| format_rfc3339(u)),
        by: by.echo(),
        branch_count: branches.len(),
        branches_complete: kept.len() == branches.len(),
        branches: kept,
        request_sha256: request_sha256(repo, aliases, name, interval, by, branches),
    }
}

fn too_large_request(echo: Echo, message: String, limit: usize, needed: usize) -> Refusal {
    let mut e = ErrorObj::new("request_too_large", message);
    e.limit_bytes = Some(limit);
    e.needed_bytes = Some(needed);
    Refusal {
        code: exit::USAGE,
        status: "usage",
        error: e,
        echo: Some(echo),
        store: None,
        machine: None,
    }
}

fn parse(args: &[String]) -> Result<Request, Box<Refusal>> {
    let mut repo: Option<String> = None;
    let mut repo_aliases: Vec<String> = Vec::new();
    let mut window: Option<Window> = None;
    let mut since = None;
    let mut until = None;
    let mut contract: Option<u64> = None;
    let mut stale: Option<i64> = None;
    let mut by: Option<By> = None;
    let mut branches: Vec<String> = Vec::new();
    let mut json = false;
    let mut it = args.iter();
    let value = |flag: &str, v: Option<&String>| -> Result<String, Refusal> {
        v.cloned()
            .ok_or_else(|| Refusal::usage(format!("{flag} needs a value")))
    };
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => json = true,
            "--repo" => {
                let v = value("--repo", it.next())?;
                if repo.replace(v).is_some() {
                    return Err(Box::new(Refusal::usage(
                        "--repo is given twice: one call per project",
                    )));
                }
            }
            "--repo-alias" => {
                let alias = value("--repo-alias", it.next())?;
                if !repo_ok(&alias) {
                    return Err(Box::new(Refusal::usage(format!(
                        "--repo-alias takes host/owner/repo as the meter normalizes a remote, not {}",
                        quoted(&alias)
                    ))));
                }
                repo_aliases.push(alias);
            }
            "--branch" => branches.push(value("--branch", it.next())?),
            "--by" => {
                let v = value("--by", it.next())?;
                let what = match v.as_str() {
                    "branch" => By::Branch,
                    "bot" => By::Bot,
                    "task" => By::Task,
                    _ => {
                        return Err(Box::new(Refusal::usage(format!(
                            "--by takes branch, bot or task, not {}",
                            quoted(&v)
                        ))));
                    }
                };
                if by.replace(what).is_some() {
                    return Err(Box::new(Refusal::usage("--by is given twice")));
                }
            }
            "--since" | "--until" => {
                let v = value(a, it.next())?;
                let slot = if a == "--since" {
                    &mut since
                } else {
                    &mut until
                };
                if slot.replace(v).is_some() {
                    return Err(Box::new(Refusal::usage(format!("{a} is given twice"))));
                }
            }
            "--window" => {
                let v = value("--window", it.next())?;
                let w = match v.as_str() {
                    "d1" => Window::D1,
                    "d7" => Window::D7,
                    "d30" => Window::D30,
                    "d90" => Window::D90,
                    _ => {
                        return Err(Box::new(Refusal::usage(format!(
                            "--window takes d1, d7, d30 or d90, not {}",
                            quoted(&v)
                        ))));
                    }
                };
                if window.replace(w).is_some() {
                    return Err(Box::new(Refusal::usage("--window is given twice")));
                }
            }
            "--contract" => {
                let v = value("--contract", it.next())?;
                let n = v.parse::<u64>().map_err(|_| {
                    Refusal::usage(format!(
                        "--contract takes a whole number, not {}",
                        quoted(&v)
                    ))
                })?;
                if contract.replace(n).is_some() {
                    return Err(Box::new(Refusal::usage("--contract is given twice")));
                }
            }
            "--stale-after" => {
                let v = value("--stale-after", it.next())?;
                let n = v
                    .parse::<i64>()
                    .ok()
                    .filter(|n| (MIN_STALE_AFTER_S..=MAX_STALE_AFTER_S).contains(n))
                    .ok_or_else(|| {
                        Refusal::usage(format!(
                            "--stale-after takes seconds from {MIN_STALE_AFTER_S} to \
                             {MAX_STALE_AFTER_S}, not {}",
                            quoted(&v)
                        ))
                    })?;
                if stale.replace(n).is_some() {
                    return Err(Box::new(Refusal::usage("--stale-after is given twice")));
                }
            }
            other => {
                return Err(Box::new(Refusal::usage(format!(
                    "unknown option {} for query; see usagemeter --help",
                    quoted(other)
                ))));
            }
        }
    }
    if !json {
        return Err(Box::new(Refusal::usage(
            "--json is required: query contract 1 has no text output",
        )));
    }
    let repo = repo.ok_or_else(|| Refusal::usage("--repo is required"))?;
    let by = by.unwrap_or(By::Branch);
    // A bot or task query may name no branch: its branches are a filter (RFC 0021 D1).
    if branches.is_empty() && by == By::Branch {
        return Err(Box::new(Refusal::usage(
            "at least one --branch is required (or --by bot or --by task)",
        )));
    }
    if let Some(i) = branches.iter().position(|b| !branch_ok(b)) {
        return Err(Box::new(Refusal::usage(format!(
            "branch {} is empty or holds a space, a backslash or a control character",
            i + 1
        ))));
    }
    if window.is_some() && (since.is_some() || until.is_some()) {
        return Err(Box::new(Refusal::usage(
            "--window cannot be combined with --since and --until",
        )));
    }
    let interval = match (since, until) {
        (None, None) => None,
        (Some(s), Some(u)) => {
            let since_ms = crate::time::parse_rfc3339(&s).ok_or_else(|| {
                Refusal::usage(format!(
                    "--since takes an RFC 3339 timestamp, not {}",
                    quoted(&s)
                ))
            })?;
            let until_ms = crate::time::parse_rfc3339(&u).ok_or_else(|| {
                Refusal::usage(format!(
                    "--until takes an RFC 3339 timestamp, not {}",
                    quoted(&u)
                ))
            })?;
            if since_ms >= until_ms {
                return Err(Box::new(Refusal::usage(
                    "--since must be earlier than --until",
                )));
            }
            Some((since_ms, until_ms))
        }
        _ => {
            return Err(Box::new(Refusal::usage(
                "--since and --until must be given together",
            )));
        }
    };
    let window = window.unwrap_or(Window::D30);
    if !repo_ok(&repo) {
        return Err(Box::new(Refusal::usage(format!(
            "--repo takes host/owner/repo as the meter normalizes a remote, not {}",
            quoted(&repo)
        ))));
    }
    repo_aliases.retain(|a| a != &repo);
    let mut seen = BTreeSet::new();
    repo_aliases.retain(|a| seen.insert(a.clone()));
    for alias in &repo_aliases {
        if alias.len() > MAX_REPO_BYTES {
            return Err(Box::new(too_large_request(
                echo(&repo, &[], window, interval, by, &branches, true),
                format!(
                    "--repo-alias takes {} bytes; the most it takes is {MAX_REPO_BYTES}",
                    alias.len()
                ),
                MAX_REPO_BYTES,
                alias.len(),
            )));
        }
    }
    if repo_aliases.len() > MAX_REPO_ALIASES {
        return Err(Box::new(Refusal::usage(
            "at most 16 --repo-alias values may be given",
        )));
    }
    if repo.len() > MAX_REPO_BYTES {
        // The defined refusal, echoed: its repo cut to fit (`repo_complete: false`), the request
        // still matched by its count and sha256.
        return Err(Box::new(too_large_request(
            echo(&repo, &repo_aliases, window, interval, by, &branches, true),
            format!(
                "--repo takes {} bytes; the most it takes is {MAX_REPO_BYTES}",
                repo.len()
            ),
            MAX_REPO_BYTES,
            repo.len(),
        )));
    }
    if branches.len() > MAX_BRANCHES {
        let mut r = Refusal::usage(format!(
            "{} branches were named; the most one call takes is {MAX_BRANCHES}",
            branches.len()
        ));
        r.error.code = "too_many_branches";
        r.echo = Some(echo(
            &repo,
            &repo_aliases,
            window,
            interval,
            by,
            &branches,
            true,
        ));
        return Err(Box::new(r));
    }
    if let Some(long) = branches.iter().map(String::len).max()
        && long > MAX_BRANCH_BYTES
    {
        return Err(Box::new(too_large_request(
            echo(&repo, &repo_aliases, window, interval, by, &branches, true),
            format!("a branch name takes {long} bytes; the most one takes is {MAX_BRANCH_BYTES}"),
            MAX_BRANCH_BYTES,
            long,
        )));
    }
    let names: usize = branches.iter().map(String::len).sum();
    if names > MAX_NAMES_BYTES {
        return Err(Box::new(too_large_request(
            echo(&repo, &repo_aliases, window, interval, by, &branches, true),
            format!(
                "the branch names take {names} bytes; the most one call takes is \
                 {MAX_NAMES_BYTES}"
            ),
            MAX_NAMES_BYTES,
            names,
        )));
    }
    let contract = contract.unwrap_or(CONTRACT_VERSION);
    if !SUPPORTED_CONTRACTS.contains(&contract) {
        let mut e = ErrorObj::new(
            "unsupported_contract",
            format!("this meter serves query contract 1 only; --contract {contract} was asked"),
        );
        e.supported_contracts = Some(SUPPORTED_CONTRACTS.to_vec());
        return Err(Box::new(Refusal {
            code: exit::UNSUPPORTED_CONTRACT,
            status: "unsupported_contract",
            error: e,
            echo: Some(echo(
                &repo,
                &repo_aliases,
                window,
                interval,
                by,
                &branches,
                true,
            )),
            store: None,
            machine: None,
        }));
    }
    Ok(Request {
        repo,
        repo_aliases,
        window,
        interval,
        by,
        branches,
        stale_after_s: stale.unwrap_or(DEFAULT_STALE_AFTER_S),
    })
}

// ---------------------------------------------------------------------------------------------
// Finding and opening the store.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Location {
    Current,
    Legacy,
    Override,
}

impl Location {
    pub fn as_str(self) -> &'static str {
        match self {
            Location::Current => "current",
            Location::Legacy => "legacy",
            Location::Override => "override",
        }
    }
}

#[derive(Debug, Clone)]
pub enum Located {
    /// No store anywhere the meter looks: never synced on this machine.
    Absent,
    Store {
        db: PathBuf,
        dir: PathBuf,
        location: Location,
        /// Why usage in the old state folder does not reach this store, if it does not.
        stray: Option<&'static str>,
    },
}

/// A store is a non-empty `meter.db` (an empty file is what a sync makes before its first run).
fn is_store(db: &Path) -> bool {
    db.metadata().is_ok_and(|m| m.is_file() && m.len() > 0)
}

/// Where the store is: `METER_STATE_DIR` alone when set; else the current folder, then the
/// folder before the move. Looks only; opens and creates nothing. An unfinished move is an error:
/// its files may be two generations, and nothing may open them until a sync settles it.
pub fn locate(dirs: &StateDirs, overridden: bool) -> Result<Located, String> {
    if overridden {
        let db = dirs.dir.join("meter.db");
        return Ok(if is_store(&db) {
            Located::Store {
                db,
                dir: dirs.dir.clone(),
                location: Location::Override,
                stray: None,
            }
        } else {
            Located::Absent
        });
    }
    if paths::move_unfinished(&dirs.dir) {
        return Err(
            "a move into the state folder has not finished, so nothing there is opened; the next \
             usagemeter sync says why (README: \"An interrupted move\")"
                .into(),
        );
    }
    let db = dirs.dir.join("meter.db");
    if is_store(&db) {
        let stray = dirs
            .legacy
            .as_deref()
            .and_then(|old| paths::stray_legacy_store(old, &dirs.dir));
        return Ok(Located::Store {
            db,
            dir: dirs.dir.clone(),
            location: Location::Current,
            stray,
        });
    }
    if let Some(old) = &dirs.legacy {
        let db = old.join("meter.db");
        if is_store(&db) {
            return Ok(Located::Store {
                db,
                dir: old.clone(),
                location: Location::Legacy,
                stray: None,
            });
        }
    }
    Ok(Located::Absent)
}

/// `SQLITE_OPEN_READ_ONLY`, no checkpoint on close, a bounded busy timeout: the database and its
/// wal keep exactly the bytes they had. SQLite may create the `-wal` and `-shm` companions of a
/// WAL store it reads (see [`read_only_folder`]).
pub fn open_read_only(db: &Path, busy: Duration) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )?;
    conn.busy_timeout(busy)?;
    Ok(conn)
}

/// Whether the store cannot be read without writing a file: its folder cannot be written and its
/// `-wal` and `-shm` companions do not both exist. SQLite reads a WAL store read-only only once
/// those exist (it creates them when it can); with them present, a read-only folder is read as
/// usual. Opening `immutable` instead would skip SQLite's locks while a sync elsewhere (outside a
/// sandbox that binds the folder read-only, say) may be writing, so the meter refuses by name.
pub fn read_only_folder(db: &Path) -> bool {
    let companion = |suffix: &str| {
        let mut p = db.as_os_str().to_owned();
        p.push(suffix);
        PathBuf::from(p).symlink_metadata().is_ok()
    };
    let have_both = companion("-wal") && companion("-shm");
    !have_both && !writable(db.parent().unwrap_or(Path::new(".")))
}

#[cfg(unix)]
fn writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `c` is a valid NUL-terminated path; access(2) only reads it.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn writable(dir: &Path) -> bool {
    dir.metadata().is_ok_and(|m| !m.permissions().readonly())
}

/// The refusal for [`read_only_folder`].
pub const READ_ONLY_FOLDER: &str = "the state folder cannot be written and the store has no -wal \
     and -shm files, which SQLite needs to read it without writing; make the folder writable, or \
     read it where a reader already left them";

pub(crate) fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _)
        if matches!(f.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked))
}

// ---------------------------------------------------------------------------------------------
// Reading the snapshot.

/// One hourly usage row or exact evidence call of the repo, as the query reads it.
pub(crate) struct UsageRead {
    /// The row's repo: null for a folder that is not a checkout with a remote.
    pub(crate) repo: Option<String>,
    /// The branch the row holds: logged, or filled from a worker's start row.
    pub(crate) branch: Option<String>,
    pub(crate) harness: String,
    pub(crate) model: String,
    pub(crate) events: i64,
    pub(crate) hour_ms: i64,
    pub(crate) tokens: TokensOut,
    pub(crate) total_only: bool,
    pub(crate) reported_usd: Option<f64>,
    /// How the row's calls were attributed, judged against `evidence_from`.
    pub(crate) class: Class,
    /// `log`, `ledger` or `none`.
    pub(crate) branch_basis: BranchBasis,
    /// The bot key, for an attributed row.
    pub(crate) bot: Option<BotKey>,
    /// The rollup still carries a bot tag (its own `bot` column): on a row before evidence, the
    /// old live-terminal definition's residue (RFC 0026 (a), `before_evidence_tagged`).
    pub(crate) tagged: bool,
}

/// How a rollup row's calls count in the four actor counts (RFC 0021 (d)).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Class {
    /// Before `evidence_from` (or all of it while that is null), and every row written before
    /// schema 3 (`actor_state` null, the frozen tags): never attributed, whatever it names.
    Before,
    Attributed(Basis),
    Ambiguous,
    Unlinked(Unlinked),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Basis {
    Session,
    Label,
    Worktree,
}

impl Basis {
    /// `0` session, `1` label, `2` worktree: the order `tokens_by_basis` reports.
    pub(crate) fn index(self) -> usize {
        match self {
            Basis::Session => 0,
            Basis::Label => 1,
            Basis::Worktree => 2,
        }
    }
}

/// Why an unlinked call has no bot, in the schema's reason order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Unlinked {
    NoRecord,
    DshTuiSeat,
    OtherMachine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BranchBasis {
    Log,
    Ledger,
    None,
}

/// A bot row's key, in the order rows are sorted: byte order, null first, `unrecorded` in its
/// enum's order.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct BotKey {
    pub(crate) bot: String,
    pub(crate) kind: String,
    pub(crate) role: Option<String>,
    pub(crate) squad: Option<String>,
    /// 0 `[]`, 1 `["role"]`, 2 `["squad"]`, 3 `["role", "squad"]`.
    pub(crate) unrecorded: u8,
    pub(crate) harness: String,
}

impl BotKey {
    fn unrecorded(&self) -> Vec<&'static str> {
        match self.unrecorded {
            0 => vec![],
            1 => vec!["role"],
            2 => vec!["squad"],
            _ => vec!["role", "squad"],
        }
    }
}

/// The bot key of an attributed row, or None when it cannot be read: no bot, a kind that is
/// neither worker nor seat, or a bot past the contract's cap. The caller counts such a row as
/// ambiguous, so every sum still holds and no bot is guessed (RFC 0021 (d)).
fn bot_key(
    bot: Option<String>,
    kind: Option<String>,
    role: Option<String>,
    squad: Option<String>,
    unrecorded: Option<String>,
    harness: &str,
) -> Option<BotKey> {
    let bot = bot.filter(|b| crate::ledger::tag_fits(b))?;
    let kind = kind.filter(|k| matches!(k.as_str(), "worker" | "seat"))?;
    let listed = |k: &str| {
        unrecorded
            .as_deref()
            .is_some_and(|u| u.split(',').any(|f| f == k))
    };
    // A role the start row left null is as unknown as one it left out, and one past the
    // contract's cap (a store written before the cap) is unrecorded.
    let no_role = listed("role") || role.as_ref().is_none_or(|r| !crate::ledger::tag_fits(r));
    let no_squad = listed("squad") || squad.as_ref().is_some_and(|s| !crate::ledger::tag_fits(s));
    Some(BotKey {
        bot,
        kind,
        role: role.filter(|_| !no_role),
        squad: squad.filter(|_| !no_squad),
        unrecorded: u8::from(no_role) | (u8::from(no_squad) << 1),
        harness: harness.to_string(),
    })
}

/// The row's class from its stored attribution: before evidence when its hour is before
/// `evidence_from` (or that is null) or it carries no state (written before schema 3); a state or
/// basis this meter does not know is never counted as attributed.
#[allow(clippy::too_many_arguments)]
fn classify(
    evidence_from: Option<i64>,
    hour_ms: i64,
    state: Option<&str>,
    basis: Option<&str>,
    reason: Option<&str>,
) -> Class {
    if evidence_from.is_none_or(|f| hour_ms < f) {
        return Class::Before;
    }
    match (state, basis) {
        (Some("attributed"), Some("session")) => Class::Attributed(Basis::Session),
        (Some("attributed"), Some("label")) => Class::Attributed(Basis::Label),
        (Some("attributed"), Some("worktree")) => Class::Attributed(Basis::Worktree),
        (Some("ambiguous"), _) => Class::Ambiguous,
        (Some("unlinked"), _) => Class::Unlinked(match reason {
            Some("dsh_tui_seat") => Unlinked::DshTuiSeat,
            Some("other_machine") => Unlinked::OtherMachine,
            _ => Unlinked::NoRecord,
        }),
        _ => Class::Before,
    }
}

struct Snapshot {
    version: i64,
    meta: BTreeMap<String, String>,
    health: BTreeMap<String, Option<i64>>,
    /// Every row of the repo in the window, whatever its branch.
    rows: Vec<UsageRead>,
    /// The repo's task-labelled calls in the window, for `--by task` only (RFC 0018 M3).
    task_calls: Vec<TaskCall>,
    repo_seen: bool,
    /// The start of per-call evidence; None while the store has kept none.
    evidence_from: Option<i64>,
}

enum Read {
    /// No tables, or a store whose first sync never got as far as its window.
    Absent,
    Version(i64),
    Snapshot(Box<Snapshot>),
}

fn table_exists(c: &Connection, name: &str) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |r| r.get(0),
    )
}

/// The store's `schema_version`: None when it has no table at all (an empty database). A store
/// with tables but no version is older than versioning (0).
pub fn schema_version(c: &Connection) -> rusqlite::Result<Option<i64>> {
    let tables: i64 = c.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
        [],
        |r| r.get(0),
    )?;
    if tables == 0 {
        return Ok(None);
    }
    if !table_exists(c, "meta")? {
        return Ok(Some(0));
    }
    let v: Option<String> = c
        .query_row("SELECT v FROM meta WHERE k = 'schema_version'", [], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(Some(v.and_then(|v| v.trim().parse().ok()).unwrap_or(0)))
}

fn nonneg(v: Option<i64>) -> i64 {
    v.unwrap_or(0).max(0)
}

/// One task-labelled call, read from the evidence for `--by task` (RFC 0018 M3).
struct TaskCall {
    /// Genie's short task id, as the launch's start row recorded it.
    task: String,
    /// The main checkout the launch recorded, normalized: identity only, never printed.
    project: String,
    /// The launch tag that did the work.
    bot: BotKey,
    /// The branch the call holds: logged, or filled from the worker's start row.
    branch: Option<String>,
    branch_basis: BranchBasis,
    class: Class,
    hour_ms: i64,
    harness: String,
    model: String,
    tokens: TokensOut,
    total_only: bool,
    reported_usd: Option<f64>,
}

impl TaskCall {
    fn parts(&self) -> CallParts<'_> {
        CallParts {
            calls: 1,
            tokens: &self.tokens,
            class: self.class,
            branch_basis: self.branch_basis,
            hour_ms: self.hour_ms,
            harness: &self.harness,
            model: &self.model,
            reported_usd: self.reported_usd,
            total_only: self.total_only,
        }
    }
}

/// One task id's calls: the checkouts that name it (the ambiguity rule is judged on them) and
/// the accumulator and actor keys of the calls the branch filter keeps (RFC 0021 D4).
#[derive(Default)]
struct TaskEntry {
    projects: BTreeSet<String>,
    acc: Acc,
    actors: BTreeSet<BotKey>,
    in_filter: bool,
}

/// The most candidate session hashes or start-folder ids one evidence statement binds. SQLite's
/// variable limit is far above it, and the task read stays a handful of indexed statements.
const TASK_CANDIDATE_CHUNK: usize = 400;

/// The evidence a task read may look at: the sessions linked to a launch started on a task, and
/// the start folders of those launches. The stored attribution is still the authority; this only
/// keeps the read off the whole evidence table (RFC 0018 M3).
struct TaskCandidates {
    sessions: Vec<Vec<u8>>,
    cwds: Vec<i64>,
}

fn task_candidates(c: &Connection) -> rusqlite::Result<TaskCandidates> {
    let mut sessions: BTreeSet<Vec<u8>> = BTreeSet::new();
    {
        let mut st = c.prepare(
            "SELECT DISTINCT l.session FROM link l JOIN launch g ON g.lkey = l.lkey
             WHERE g.task IS NOT NULL AND g.project IS NOT NULL",
        )?;
        let mut q = st.query([])?;
        while let Some(r) = q.next()? {
            let s: Vec<u8> = r.get(0)?;
            if !s.is_empty() {
                sessions.insert(s);
            }
        }
    }
    let worktrees: BTreeSet<String> = {
        let mut out = BTreeSet::new();
        let mut st = c.prepare(
            "SELECT worktree FROM launch
             WHERE task IS NOT NULL AND project IS NOT NULL AND worktree IS NOT NULL",
        )?;
        let mut q = st.query([])?;
        while let Some(r) = q.next()? {
            let w: String = r.get(0)?;
            out.insert(crate::ledger::normalize(&w).to_string());
        }
        out
    };
    let mut cwds: Vec<i64> = Vec::new();
    if !worktrees.is_empty() {
        // Lexical, never opening the path: the launch row and the evidence row are compared as
        // strings, as the resolver compares them.
        let mut st = c.prepare("SELECT id, path FROM ev_cwd")?;
        let mut q = st.query([])?;
        while let Some(r) = q.next()? {
            let id: i64 = r.get(0)?;
            let path: String = r.get(1)?;
            if worktrees.contains(crate::ledger::normalize(&path)) {
                cwds.push(id);
            }
        }
    }
    Ok(TaskCandidates {
        sessions: sessions.into_iter().collect(),
        cwds,
    })
}

/// The task-labelled calls of the repo in the window (RFC 0018 M3), read only from the evidence
/// its task launches can name. The stored attribution stays the authority; the bound only keeps
/// the read proportional to the tasks, not to the whole evidence table.
fn task_calls(
    c: &Connection,
    repos: &[&str],
    from: i64,
    to: i64,
) -> rusqlite::Result<Vec<TaskCall>> {
    let TaskCandidates { sessions, cwds } = task_candidates(c)?;
    let mut kept: BTreeMap<i64, TaskCall> = BTreeMap::new();
    // Three arms, one count per evidence id: a call's own session, its parent's (a sub-agent or a
    // resumed child is tied through its parent, as the resolver ties it in ledger.rs), and its
    // start folder. Each arm is one indexed column.
    for chunk in sessions.chunks(TASK_CANDIDATE_CHUNK) {
        read_task_calls(c, repos, from, to, TaskArm::Sessions(chunk), &mut kept)?;
        read_task_calls(c, repos, from, to, TaskArm::Parents(chunk), &mut kept)?;
    }
    for chunk in cwds.chunks(TASK_CANDIDATE_CHUNK) {
        read_task_calls(c, repos, from, to, TaskArm::Cwds(chunk), &mut kept)?;
    }
    Ok(kept.into_values().collect())
}

/// Which evidence column the candidates of one statement name.
enum TaskArm<'a> {
    /// `e.session`, through `evidence_session`.
    Sessions(&'a [Vec<u8>]),
    /// `e.parent`, through `evidence_parent`.
    Parents(&'a [Vec<u8>]),
    /// `e.session_cwd`, through `evidence_session_cwd`.
    Cwds(&'a [i64]),
}

/// A task id the contract can print: not empty, no control character (no blank row, no row
/// carrying an escape), and within the tag bound. Only that is checked; Genie's id shape is not.
pub(crate) fn task_id_fits(task: &str) -> bool {
    !task.is_empty() && !task.chars().any(char::is_control) && crate::ledger::tag_fits(task)
}

/// `n` numbered placeholders starting at `first`.
fn placeholders(first: usize, n: usize) -> String {
    (0..n)
        .map(|i| format!("?{}", first + i))
        .collect::<Vec<_>>()
        .join(", ")
}

fn read_task_calls(
    c: &Connection,
    repos: &[&str],
    from: i64,
    to: i64,
    arm: TaskArm<'_>,
    kept: &mut BTreeMap<i64, TaskCall>,
) -> rusqlite::Result<()> {
    let mut values: Vec<rusqlite::types::Value> = vec![from.into(), to.into()];
    values.extend(
        repos
            .iter()
            .map(|r| rusqlite::types::Value::Text((*r).into())),
    );
    let repo_list = placeholders(3, repos.len());
    // A call is tied to its launch by its own session or by its parent's (ledger.rs), so the
    // session hashes are matched against both columns. Matching only the own session drops a
    // parent-only call with no count and can hide a second checkout from the ambiguity rule.
    let predicate = match &arm {
        TaskArm::Sessions(sessions) | TaskArm::Parents(sessions) => {
            let list = placeholders(3 + repos.len(), sessions.len());
            for s in *sessions {
                values.push(rusqlite::types::Value::Blob(s.clone()));
            }
            if matches!(arm, TaskArm::Parents(_)) {
                format!("e.parent IS NOT NULL AND e.parent IN ({list})")
            } else {
                format!("e.session IN ({list})")
            }
        }
        TaskArm::Cwds(ids) => {
            let list = placeholders(3 + repos.len(), ids.len());
            for id in *ids {
                values.push(rusqlite::types::Value::Integer(*id));
            }
            format!("e.session_cwd IN ({list})")
        }
    };
    let sql = format!(
        "SELECT e.id, d.branch, d.harness, d.model, e.ts_ms, e.input_uncached, e.cache_read,
           e.cache_write_5m, e.cache_write_1h, e.output, e.reasoning, e.unsplit, d.precision,
           e.reported_usd, a.state, a.basis, a.bot, a.kind, a.role, a.squad, a.unrecorded,
           a.task, a.project, a.filled_branch
         FROM evidence e JOIN ev_dim d ON d.id = e.dim JOIN ev_actor a ON a.id = e.actor
         WHERE e.ts_ms >= ?1 AND e.ts_ms < ?2 AND d.repo IN ({repo_list})
           AND a.state = 'attributed' AND a.task IS NOT NULL AND a.task <> ''
           AND a.project IS NOT NULL
           AND {predicate}"
    );
    let mut st = c.prepare(&sql)?;
    let mut q = st.query(rusqlite::params_from_iter(values))?;
    while let Some(r) = q.next()? {
        let id: i64 = r.get(0)?;
        if kept.contains_key(&id) {
            continue;
        }
        let branch: Option<String> = r.get::<_, Option<String>>(1)?.filter(|b| !b.is_empty());
        let harness: String = r.get(2)?;
        let model: String = r.get(3)?;
        let ts_ms: i64 = r.get(4)?;
        let mut tokens = TokensOut {
            input: nonneg(r.get(5)?),
            cache_read: nonneg(r.get(6)?),
            cache_write_5m: nonneg(r.get(7)?),
            cache_write_1h: nonneg(r.get(8)?),
            output: nonneg(r.get(9)?),
            reasoning: Source::from_harness(&harness)
                .filter(|s| s.logs_reasoning())
                .map(|_| nonneg(r.get(10).ok().flatten())),
            unsplit: nonneg(r.get(11)?),
            total: 0,
        };
        tokens.total = split_total(&tokens).saturating_add(tokens.unsplit);
        if tokens.total == 0 {
            continue;
        }
        let total_only: String = r.get(12)?;
        let reported_usd: Option<f64> = r
            .get::<_, Option<f64>>(13)?
            .filter(|u| u.is_finite() && *u >= 0.0);
        let state: Option<String> = r.get(14)?;
        let basis: Option<String> = r.get(15)?;
        let basis = match (state.as_deref(), basis.as_deref()) {
            (Some("attributed"), Some("session")) => Basis::Session,
            (Some("attributed"), Some("label")) => Basis::Label,
            (Some("attributed"), Some("worktree")) => Basis::Worktree,
            _ => continue,
        };
        let Some(bot) = bot_key(
            r.get(16)?,
            r.get(17)?,
            r.get(18)?,
            r.get(19)?,
            r.get(20)?,
            &harness,
        ) else {
            continue;
        };
        // A task is a worker launch's: a seat never records one (RFC 0021 (a)).
        if bot.kind != "worker" {
            continue;
        }
        let task: Option<String> = r.get(21)?;
        let project: Option<String> = r.get(22)?;
        let filled: Option<String> = r.get::<_, Option<String>>(23)?.filter(|f| !f.is_empty());
        let (Some(task), Some(project)) = (task, project) else {
            continue;
        };
        // Genie's task id is joined with its project; the id alone is not a key, and one the
        // contract cannot print is never cut short. An empty id, or one with a control
        // character, fails closed: no blank row, no row carrying an escape.
        if !task_id_fits(&task) {
            continue;
        }
        let logged = branch.is_some();
        let branch = branch.or(filled);
        let branch_basis = if logged {
            BranchBasis::Log
        } else if branch.is_some() {
            BranchBasis::Ledger
        } else {
            BranchBasis::None
        };
        kept.insert(
            id,
            TaskCall {
                task,
                project: crate::ledger::normalize(&project).to_string(),
                bot,
                branch,
                branch_basis,
                class: Class::Attributed(basis),
                hour_ms: hour_start(ts_ms),
                harness,
                model,
                tokens,
                total_only: total_only == "total_only",
                reported_usd,
            },
        );
    }
    Ok(())
}

/// Reads everything the answer needs in one read transaction, so it is one snapshot.
fn read(
    c: &Connection,
    req: &Request,
    start: impl Fn(&BTreeMap<String, String>) -> (i64, i64),
) -> rusqlite::Result<Read> {
    c.execute_batch("BEGIN")?;
    let version = match schema_version(c)? {
        None => return Ok(Read::Absent),
        Some(v) => v,
    };
    if version != SCHEMA_VERSION {
        return Ok(Read::Version(version));
    }
    let mut meta = BTreeMap::new();
    {
        let mut st = c.prepare("SELECT k, v FROM meta")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (k, v) = row?;
            meta.insert(k, v);
        }
    }
    if !meta.contains_key("counted_from_ms") {
        return Ok(Read::Absent);
    }
    let mut health = BTreeMap::new();
    {
        let mut st = c.prepare("SELECT source, last_success_ms FROM health")?;
        let rows = st.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
        })?;
        for row in rows {
            let (k, v) = row?;
            health.insert(k, v);
        }
    }
    let (from, to) = start(&meta);
    let evidence_from = meta_i64(&meta, crate::evidence::FROM_META);
    // Every row of the repo in the window, through `usage_repo_branch`: branch rows read the
    // branches named, and the actor counts (`actor_unattributed`, bot rows) the whole repo.
    let mut rows = Vec::new();
    let repos: Vec<&str> = std::iter::once(req.repo.as_str())
        .chain(req.repo_aliases.iter().map(String::as_str))
        .collect();
    if let Some((since, until)) = req.interval {
        scan_evidence(c, &repos, from, to, evidence_from, &mut |r| rows.push(r))?;
        // Hourly tokens that have no per-call record, in the whole hours of the interval, count
        // as before-evidence actor tokens: never a branch or bot row.
        if evidence_from.is_some() {
            let excess = hourly_excess(c, &repos, from, to, evidence_from, &rows)?;
            rows.extend(excess);
        }
        // Hourly history cannot be sliced exactly. Report it only as before-evidence
        // actor totals, never as exact branch or bot usage in the custom interval.
        if evidence_from.is_none_or(|ev| since < ev) {
            let counted = meta_i64(&meta, "counted_from_ms").unwrap_or(since);
            scan_usage(
                c,
                Some(&repos),
                hour_start(since).max(counted),
                evidence_from.unwrap_or(until).min(until),
                evidence_from,
                &mut |mut r| {
                    r.class = Class::Before;
                    r.branch = None;
                    r.branch_basis = BranchBasis::None;
                    r.bot = None;
                    rows.push(r);
                },
            )?;
        }
    } else {
        scan_usage(c, Some(&repos), from, to, evidence_from, &mut |r| {
            rows.push(r);
        })?;
    }
    let repo_seen = rows.iter().any(|r| r.tokens.total > 0)
        || c.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM usage WHERE repo IN ({}))",
                placeholders(1, repos.len())
            ),
            rusqlite::params_from_iter(&repos),
            |r| r.get::<_, bool>(0),
        )?;
    // The task rows read per-call evidence (RFC 0018 M3): the hourly rollups carry no task.
    let task_calls = if req.by == By::Task {
        task_calls(c, &repos, from, to)?
    } else {
        Vec::new()
    };
    c.execute_batch("COMMIT")?;
    Ok(Read::Snapshot(Box::new(Snapshot {
        version,
        meta,
        health,
        rows,
        task_calls,
        repo_seen,
        evidence_from,
    })))
}

/// Reads the usage rows in `from..to`, classified against `evidence_from`, one at a time: the
/// query collects them, the coverage report sums them, so the two cannot read a row differently.
/// `repos` names the repos to read; `None` reads every repo and the usage that has none (which
/// the report shows beside the ratio, never in it). One read transaction is the caller's.
pub(crate) fn scan_usage(
    c: &Connection,
    repos: Option<&[&str]>,
    from: i64,
    to: i64,
    evidence_from: Option<i64>,
    f: &mut dyn FnMut(UsageRead),
) -> rusqlite::Result<()> {
    // A schema 3 store a meter before RFC 0021 delivery 6 wrote has no `reason` column until its
    // next sync adds it: its ambiguous and unlinked rows read as they were, with no reason.
    let reason: bool = c.query_row(
        "SELECT count(*) > 0 FROM pragma_table_info('usage') WHERE name = 'reason'",
        [],
        |r| r.get(0),
    )?;
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();
    for r in repos.unwrap_or(&[]) {
        params.push(r);
    }
    let mut sql = String::from(
        "SELECT repo, branch, harness, model, hour_ms, input_uncached, cache_read,
           cache_write_5m, cache_write_1h, output, reasoning, unsplit, precision, reported_usd,
           actor_state, basis, branch_basis, ",
    );
    sql.push_str(if reason { "reason" } else { "NULL" });
    sql.push_str(", bot, kind, role, squad, unrecorded, events FROM usage WHERE ");
    if let Some(rs) = repos.filter(|rs| !rs.is_empty()) {
        let names: Vec<String> = (1..=rs.len()).map(|i| format!("?{i}")).collect();
        sql.push_str(&format!("repo IN ({}) AND ", names.join(", ")));
    }
    let (from_at, to_at) = (params.len() + 1, params.len() + 2);
    sql.push_str(&format!("hour_ms >= ?{from_at} AND hour_ms < ?{to_at}"));
    params.push(&from);
    params.push(&to);
    let mut st = c.prepare(&sql)?;
    let mut q = st.query(params.as_slice())?;
    while let Some(r) = q.next()? {
        let harness: String = r.get(2)?;
        let mut t = TokensOut {
            input: nonneg(r.get(5)?),
            cache_read: nonneg(r.get(6)?),
            cache_write_5m: nonneg(r.get(7)?),
            cache_write_1h: nonneg(r.get(8)?),
            output: nonneg(r.get(9)?),
            reasoning: crate::sources::Source::from_harness(&harness)
                .filter(|s| s.logs_reasoning())
                .map(|_| nonneg(r.get(10).ok().flatten())),
            unsplit: nonneg(r.get(11)?),
            total: 0,
        };
        t.total = split_total(&t).saturating_add(t.unsplit);
        let hour_ms: i64 = r.get(4)?;
        let repo: Option<String> = r.get::<_, Option<String>>(0)?.filter(|p| !p.is_empty());
        let branch: Option<String> = r.get::<_, Option<String>>(1)?.filter(|b| !b.is_empty());
        let state: Option<String> = r.get(14)?;
        let basis: Option<String> = r.get(15)?;
        let reason: Option<String> = r.get(17)?;
        let class = classify(
            evidence_from,
            hour_ms,
            state.as_deref(),
            basis.as_deref(),
            reason.as_deref(),
        );
        let branch_basis = match (r.get::<_, Option<String>>(16)?.as_deref(), &branch) {
            (_, None) => BranchBasis::None,
            (Some("ledger"), Some(_)) => BranchBasis::Ledger,
            _ => BranchBasis::Log,
        };
        let fits = |s: &String| crate::ledger::tag_fits(s);
        let stored_bot: Option<String> = r.get(18)?;
        let tagged = stored_bot.as_deref().is_some_and(|b| !b.is_empty());
        let bot = match (class, stored_bot, r.get::<_, Option<String>>(19)?) {
            (Class::Attributed(_), Some(bot), Some(kind))
                if matches!(kind.as_str(), "worker" | "seat") && fits(&bot) =>
            {
                let role: Option<String> = r.get(20)?;
                let squad: Option<String> = r.get(21)?;
                let unrecorded: Option<String> = r.get(22)?;
                let listed = |k: &str| {
                    unrecorded
                        .as_deref()
                        .is_some_and(|u| u.split(',').any(|f| f == k))
                };
                // A role the start row left null is as unknown as one it left out, and one
                // past the contract's cap (a store written before the cap) is unrecorded.
                let no_role = listed("role") || role.as_ref().is_none_or(|r| !fits(r));
                let no_squad = listed("squad") || squad.as_ref().is_some_and(|s| !fits(s));
                Some(BotKey {
                    bot,
                    kind,
                    role: role.filter(|_| !no_role),
                    squad: squad.filter(|_| !no_squad),
                    unrecorded: u8::from(no_role) | (u8::from(no_squad) << 1),
                    harness: harness.clone(),
                })
            }
            _ => None,
        };
        // An attributed row whose bot key cannot be read (no bot, a kind that is neither
        // worker nor seat, a bot past the cap) names no bot row: it counts as ambiguous, so
        // its tokens land in actor_unattributed and every sum holds.
        let class = match (class, &bot) {
            (Class::Attributed(_), None) => Class::Ambiguous,
            _ => class,
        };
        f(UsageRead {
            repo,
            branch,
            harness,
            model: r.get(3)?,
            events: nonneg(r.get(23)?).max(1),
            hour_ms,
            tokens: t,
            total_only: r.get::<_, String>(12)? == "total_only",
            reported_usd: r
                .get::<_, Option<f64>>(13)?
                .filter(|u| u.is_finite() && *u >= 0.0),
            class,
            branch_basis,
            bot,
            tagged,
        });
    }
    Ok(())
}

/// Exact calls for custom intervals; hourly rollups cannot resolve sub-hour boundaries.
fn scan_evidence(
    c: &Connection,
    repos: &[&str],
    from: i64,
    to: i64,
    evidence_from: Option<i64>,
    f: &mut dyn FnMut(UsageRead),
) -> rusqlite::Result<()> {
    let mut values: Vec<rusqlite::types::Value> = vec![from.into(), to.into()];
    values.extend(
        repos
            .iter()
            .map(|r| rusqlite::types::Value::Text((*r).into())),
    );
    let sql = format!(
        "SELECT d.repo, d.branch, d.harness, d.model, e.ts_ms, e.input_uncached, e.cache_read,
           e.cache_write_5m, e.cache_write_1h, e.output, e.reasoning, e.unsplit, d.precision,
           e.reported_usd, a.state, a.basis, a.reason, a.bot, a.kind, a.role, a.squad,
           a.unrecorded, a.filled_branch
         FROM evidence e JOIN ev_dim d ON d.id = e.dim JOIN ev_actor a ON a.id = e.actor
         WHERE e.ts_ms >= ?1 AND e.ts_ms < ?2 AND d.repo IN ({})",
        placeholders(3, repos.len())
    );
    let mut st = c.prepare(&sql)?;
    let mut q = st.query(rusqlite::params_from_iter(values))?;
    while let Some(r) = q.next()? {
        let harness: String = r.get(2)?;
        let mut tokens = TokensOut {
            input: nonneg(r.get(5)?),
            cache_read: nonneg(r.get(6)?),
            cache_write_5m: nonneg(r.get(7)?),
            cache_write_1h: nonneg(r.get(8)?),
            output: nonneg(r.get(9)?),
            reasoning: Source::from_harness(&harness)
                .filter(|s| s.logs_reasoning())
                .map(|_| nonneg(r.get(10).ok().flatten())),
            unsplit: nonneg(r.get(11)?),
            total: 0,
        };
        tokens.total = split_total(&tokens).saturating_add(tokens.unsplit);
        if tokens.total == 0 {
            continue;
        }
        let hour_ms = hour_start(r.get(4)?);
        let logged = r.get::<_, Option<String>>(1)?.filter(|b| !b.is_empty());
        let filled = r.get::<_, Option<String>>(22)?.filter(|b| !b.is_empty());
        let branch_basis = if logged.is_some() {
            BranchBasis::Log
        } else if filled.is_some() {
            BranchBasis::Ledger
        } else {
            BranchBasis::None
        };
        let state: Option<String> = r.get(14)?;
        let basis: Option<String> = r.get(15)?;
        let reason: Option<String> = r.get(16)?;
        let class = classify(
            evidence_from,
            hour_ms,
            state.as_deref(),
            basis.as_deref(),
            reason.as_deref(),
        );
        let stored_bot: Option<String> = r.get(17)?;
        let tagged = stored_bot.as_deref().is_some_and(|b| !b.is_empty());
        let bot = if matches!(class, Class::Attributed(_)) {
            bot_key(
                stored_bot,
                r.get(18)?,
                r.get(19)?,
                r.get(20)?,
                r.get(21)?,
                &harness,
            )
        } else {
            None
        };
        let class = match (class, &bot) {
            (Class::Attributed(_), None) => Class::Ambiguous,
            _ => class,
        };
        f(UsageRead {
            repo: r.get(0)?,
            branch: logged.or(filled),
            harness,
            model: r.get(3)?,
            events: 1,
            hour_ms,
            tokens,
            total_only: r.get::<_, String>(12)? == "total_only",
            reported_usd: r
                .get::<_, Option<f64>>(13)?
                .filter(|u| u.is_finite() && *u >= 0.0),
            class,
            branch_basis,
            bot,
            tagged,
        });
    }
    Ok(())
}

/// The seven token columns of a group, in `TokensOut` order.
fn columns(t: &TokensOut) -> [i64; 7] {
    [
        t.input,
        t.cache_read,
        t.cache_write_5m,
        t.cache_write_1h,
        t.output,
        t.reasoning.unwrap_or(0),
        t.unsplit,
    ]
}

/// Hourly tokens inside the whole hours of `from..to` that per-call evidence does not hold: per
/// (hour, harness, model, repo), each column's `max(0, hourly - evidence)`, as a before-evidence
/// row with no branch and no bot. `evidence` is what `scan_evidence` read for the same interval.
/// A partial hour at either end is not added (the rollup cannot be sliced); an hour before
/// `evidence_from` is the existing before-evidence reader's.
fn hourly_excess(
    c: &Connection,
    repos: &[&str],
    from: i64,
    to: i64,
    evidence_from: Option<i64>,
    evidence: &[UsageRead],
) -> rusqlite::Result<Vec<UsageRead>> {
    let first = from.saturating_add(HOUR_MS - 1).div_euclid(HOUR_MS) * HOUR_MS;
    let last = hour_start(to);
    if first >= last {
        return Ok(Vec::new());
    }
    type Key = (i64, String, String, String);
    let add = |sums: &mut BTreeMap<Key, [i64; 7]>, r: &UsageRead| {
        let Some(repo) = r.repo.clone() else { return };
        let s = sums
            .entry((r.hour_ms, r.harness.clone(), r.model.clone(), repo))
            .or_default();
        for (a, b) in s.iter_mut().zip(columns(&r.tokens)) {
            *a = a.saturating_add(b);
        }
    };
    let mut held: BTreeMap<Key, [i64; 7]> = BTreeMap::new();
    for r in evidence
        .iter()
        .filter(|r| r.hour_ms >= first && r.hour_ms < last)
    {
        add(&mut held, r);
    }
    let mut hourly: BTreeMap<Key, [i64; 7]> = BTreeMap::new();
    scan_usage(c, Some(repos), first, last, evidence_from, &mut |r| {
        add(&mut hourly, &r);
    })?;
    let mut out = Vec::new();
    for ((hour_ms, harness, model, repo), sums) in hourly {
        let have = held
            .get(&(hour_ms, harness.clone(), model.clone(), repo.clone()))
            .copied()
            .unwrap_or_default();
        let mut e = [0i64; 7];
        for i in 0..7 {
            e[i] = (sums[i] - have[i]).max(0);
        }
        let mut tokens = TokensOut {
            input: e[0],
            cache_read: e[1],
            cache_write_5m: e[2],
            cache_write_1h: e[3],
            output: e[4],
            reasoning: Source::from_harness(&harness)
                .filter(|s| s.logs_reasoning())
                .map(|_| e[5]),
            unsplit: e[6],
            total: 0,
        };
        tokens.total = split_total(&tokens).saturating_add(tokens.unsplit);
        if tokens.total == 0 {
            continue;
        }
        out.push(UsageRead {
            repo: Some(repo),
            branch: None,
            harness,
            model,
            events: 1,
            hour_ms,
            tokens,
            total_only: false,
            reported_usd: None,
            class: Class::Before,
            branch_basis: BranchBasis::None,
            bot: None,
            tagged: false,
        });
    }
    Ok(out)
}

fn split_total(t: &TokensOut) -> i64 {
    t.input
        .saturating_add(t.cache_read)
        .saturating_add(t.cache_write_5m)
        .saturating_add(t.cache_write_1h)
        .saturating_add(t.output)
}

impl TokensOut {
    fn add(&mut self, o: &TokensOut) {
        self.input = self.input.saturating_add(o.input);
        self.cache_read = self.cache_read.saturating_add(o.cache_read);
        self.cache_write_5m = self.cache_write_5m.saturating_add(o.cache_write_5m);
        self.cache_write_1h = self.cache_write_1h.saturating_add(o.cache_write_1h);
        self.output = self.output.saturating_add(o.output);
        self.reasoning = self
            .reasoning
            .zip(o.reasoning)
            .map(|(a, b)| a.saturating_add(b));
        self.unsplit = self.unsplit.saturating_add(o.unsplit);
        self.total = self.total.saturating_add(o.total);
    }

    fn as_event_tokens(&self) -> crate::event::Tokens {
        crate::event::Tokens {
            input_uncached: self.input,
            cache_read: self.cache_read,
            cache_write_5m: self.cache_write_5m,
            cache_write_1h: self.cache_write_1h,
            output: self.output,
            reasoning: self.reasoning.unwrap_or(0),
            unsplit: self.unsplit,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The answer.

/// The fields one call contributes to an accumulator, whichever source it came from: an hourly
/// rollup (RFC 0018 (a)) or a per-call evidence row (`--by task`, RFC 0018 M3).
struct CallParts<'a> {
    calls: i64,
    tokens: &'a TokensOut,
    class: Class,
    branch_basis: BranchBasis,
    hour_ms: i64,
    harness: &'a str,
    model: &'a str,
    reported_usd: Option<f64>,
    total_only: bool,
}

impl UsageRead {
    fn parts(&self) -> CallParts<'_> {
        CallParts {
            calls: self.events.max(1),
            tokens: &self.tokens,
            class: self.class,
            branch_basis: self.branch_basis,
            hour_ms: self.hour_ms,
            harness: &self.harness,
            model: &self.model,
            reported_usd: self.reported_usd,
            total_only: self.total_only,
        }
    }
}

#[derive(Default)]
struct ModelAcc {
    calls: i64,
    tokens: TokensOut,
    usd: f64,
    tokens_priced: i64,
}

/// What a branch's usage in the window adds up to.
#[derive(Default)]
struct Acc {
    tokens: TokensOut,
    hours: BTreeSet<i64>,
    harnesses: BTreeSet<String>,
    exact: bool,
    total_only: bool,
    usd_reported: f64,
    usd_estimated: f64,
    tokens_priced: i64,
    tokens_reported: i64,
    tokens_unpriced: i64,
    unpriced: BTreeMap<String, i64>,
    models: BTreeMap<String, ModelAcc>,
    actor: ActorOut,
}

impl ActorOut {
    /// Counts a row's `total` tokens by its class and its branch basis.
    fn count(&mut self, class: Class, branch_basis: BranchBasis, total: i64) {
        let add = |n: &mut i64| *n = n.saturating_add(total);
        match class {
            Class::Before => add(&mut self.tokens_before_evidence),
            Class::Ambiguous => add(&mut self.tokens_ambiguous),
            Class::Unlinked(_) => add(&mut self.tokens_unlinked),
            Class::Attributed(b) => {
                add(&mut self.tokens_attributed);
                add(match b {
                    Basis::Session => &mut self.tokens_by_basis.session,
                    Basis::Label => &mut self.tokens_by_basis.label,
                    Basis::Worktree => &mut self.tokens_by_basis.worktree,
                });
            }
        }
        add(match branch_basis {
            BranchBasis::Log => &mut self.tokens_by_branch_basis.log,
            BranchBasis::Ledger => &mut self.tokens_by_branch_basis.ledger,
            BranchBasis::None => &mut self.tokens_by_branch_basis.none,
        });
    }
}

impl Acc {
    /// A row with no tokens adds nothing, not even a reported amount: a branch is found only by
    /// its tokens, and a row that is not found never carries a cost.
    fn add(&mut self, r: &CallParts<'_>, prices: &PriceTable) {
        let t = r.tokens;
        if t.total == 0 {
            return;
        }
        let m = self.models.entry(r.model.to_string()).or_default();
        m.calls = m.calls.saturating_add(r.calls.max(1));
        m.tokens.add(t);
        self.tokens.add(t);
        self.actor.count(r.class, r.branch_basis, t.total);
        self.hours.insert(r.hour_ms);
        self.harnesses.insert(r.harness.to_string());
        if r.total_only {
            self.total_only = true;
        } else {
            self.exact = true;
        }
        if let Some(u) = r.reported_usd {
            self.usd_reported += u;
            self.tokens_reported = self.tokens_reported.saturating_add(t.total);
            m.usd += u;
            m.tokens_priced = m.tokens_priced.saturating_add(t.total);
        } else if let Some(p) = prices.get(r.model) {
            let split = split_total(t);
            if split > 0 {
                let est = p.cost(&t.as_event_tokens());
                self.usd_estimated += est;
                self.tokens_priced = self.tokens_priced.saturating_add(split);
                m.usd += est;
                m.tokens_priced = m.tokens_priced.saturating_add(split);
            }
            self.tokens_unpriced = self.tokens_unpriced.saturating_add(t.unsplit);
        } else {
            self.tokens_unpriced = self.tokens_unpriced.saturating_add(t.total);
            let n = self.unpriced.entry(r.model.to_string()).or_default();
            *n = n.saturating_add(t.total);
        }
    }

    fn models(&self) -> (Vec<ModelOut>, usize) {
        let mut list: Vec<(&String, &ModelAcc)> = self.models.iter().collect();
        list.sort_by(|a, b| {
            b.1.tokens
                .total
                .cmp(&a.1.tokens.total)
                .then_with(|| a.0.cmp(b.0))
        });
        let omitted = list.len().saturating_sub(MODELS_MAX);
        let out = list
            .into_iter()
            .take(MODELS_MAX)
            .map(|(name, m)| ModelOut {
                model: json_bounded(name, MODEL_NAME_BYTES),
                calls: m.calls,
                tokens: m.tokens,
                cost_usd: (m.tokens_priced > 0).then_some(m.usd),
            })
            .collect();
        (out, omitted)
    }

    fn cost(&self) -> Cost {
        let known = self.tokens_priced.saturating_add(self.tokens_reported);
        let state = if self.tokens_unpriced == 0 {
            "priced"
        } else if known > 0 {
            "partial"
        } else {
            "unpriced"
        };
        let mut models: Vec<(&String, &i64)> = self.unpriced.iter().collect();
        models.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        let unpriced_models_omitted = models.len().saturating_sub(UNPRICED_MODELS_MAX);
        let unpriced_models = models
            .into_iter()
            .take(UNPRICED_MODELS_MAX)
            .map(|(m, _)| json_bounded(m, MODEL_NAME_BYTES))
            .collect();
        let (usd, rep, est) = if state == "unpriced" {
            (None, None, None)
        } else {
            (
                Some(self.usd_reported + self.usd_estimated),
                Some(self.usd_reported),
                Some(self.usd_estimated),
            )
        };
        Cost {
            state,
            usd,
            usd_reported: rep,
            usd_estimated: est,
            tokens_priced: self.tokens_priced,
            tokens_reported: self.tokens_reported,
            tokens_unpriced: self.tokens_unpriced,
            unpriced_models,
            unpriced_models_omitted,
        }
    }

    fn precision(&self) -> &'static str {
        match (self.exact, self.total_only) {
            (true, true) => "mixed",
            (false, true) => "total_only",
            _ => "exact",
        }
    }

    fn activity(&self) -> Activity {
        Activity {
            first_hour: self.hours.first().map(|h| format_rfc3339(*h)),
            last_hour: self.hours.last().map(|h| format_rfc3339(*h)),
            hours: self.hours.len(),
            harnesses: self.harnesses.iter().cloned().collect(),
        }
    }
}

fn machine_of(meta: &BTreeMap<String, String>) -> Machine {
    Machine {
        id: machine_id(meta),
        scope: "local",
    }
}

/// The store's machine name, as the query and the coverage report report it.
pub(crate) fn machine_id(meta: &BTreeMap<String, String>) -> String {
    meta.get("machine")
        .or_else(|| meta.get("machine_fallback"))
        .map(|s| chars(s, MACHINE_ID_CHARS))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

pub(crate) fn meta_i64(meta: &BTreeMap<String, String>, k: &str) -> Option<i64> {
    meta.get(k).and_then(|v| v.trim().parse().ok())
}

/// Source health, one entry per harness (by name), then the old folder's store if it holds usage
/// this store does not.
/// Every harness's health, then the old folder's store when it holds usage this store does not.
/// The query puts it in the envelope and the coverage report reads it for its zero rule
/// (RFC 0018: a zero is vouched for only when every source is `ok` or `absent`).
pub(crate) fn sources(
    meta: &BTreeMap<String, String>,
    health: &BTreeMap<String, Option<i64>>,
    stray: Option<&'static str>,
    now: i64,
    stale_ms: i64,
) -> Vec<SourceInfo> {
    let mut harnesses: Vec<Source> = Source::ALL.to_vec();
    harnesses.sort_by_key(|s| s.harness());
    let mut out: Vec<SourceInfo> = harnesses
        .into_iter()
        .map(|s| {
            let h = s.harness();
            let (status, reason) = crate::sync::source_status(|k| meta.get(k).cloned(), s);
            let reason = reason.map(|r| chars(&r, LABEL_CHARS));
            let last = health.get(h).copied().flatten();
            let counts = matches!(status.as_str(), "ok" | "degraded");
            let stale = counts && last.is_none_or(|t| now - t > stale_ms);
            SourceInfo {
                harness: h.to_string(),
                status,
                reason,
                last_success: last.map(format_rfc3339),
                stale,
            }
        })
        .collect();
    if let Some(why) = stray {
        out.push(SourceInfo {
            harness: LEGACY_STORE.into(),
            status: "degraded".into(),
            reason: Some(chars(why, LABEL_CHARS)),
            last_success: None,
            stale: false,
        });
    }
    out
}

fn pricing(dir: &Path) -> Result<(PriceTable, Pricing), String> {
    let path = dir.join("prices.json");
    let (table, origin, sha) = match std::fs::read(&path) {
        Ok(bytes) => {
            let text = String::from_utf8(bytes.clone())
                .map_err(|_| "the price override prices.json is not UTF-8".to_string())?;
            let t = PriceTable::with_override(&text)
                .map_err(|e| format!("the price override prices.json is not valid: {e}"))?;
            let sha = crate::event::hex(&Sha256::digest(&bytes));
            (t, "override", Some(sha))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (PriceTable::bundled(), "bundled", None)
        }
        Err(e) => {
            return Err(format!(
                "the price override prices.json cannot be read: {e}"
            ));
        }
    };
    if !is_date(&table.date) {
        return Err(format!(
            "the price override's date {} is not YYYY-MM-DD",
            quoted(&table.date)
        ));
    }
    let info = PriceInfo {
        origin,
        date: table.date.clone(),
        source: if sha.is_some() {
            "usagemeter bundled list prices, with the prices.json override"
        } else {
            "usagemeter bundled list prices"
        },
        label: "list prices, an estimate",
        sha256: sha,
    };
    Ok((
        table,
        Pricing {
            table: info,
            reported_wins: true,
            long_prompt_tiers: false,
        },
    ))
}

fn is_date(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// Runs one query. `args` are the words after `query`.
pub fn run(args: &[String], ctx: &Ctx) -> Answer {
    let generated_at = format_rfc3339(ctx.now_ms);
    let refuse = |r: Refusal| -> Answer {
        let env = Envelope {
            contract: CONTRACT,
            contract_version: CONTRACT_VERSION,
            capability: CAPABILITY,
            meter_version: ctx.meter_version.clone(),
            status: r.status,
            error: Some(r.error),
            generated_at: generated_at.clone(),
            as_of: None,
            machine: r.machine,
            store: r.store,
            ingestion: None,
            window: None,
            sources: Vec::new(),
            unattributed: None,
            actor_unattributed: None,
            pricing: None,
            query: r.echo,
            rows: Vec::new(),
        };
        Answer {
            code: r.code,
            stdout: line(&env),
        }
    };
    let req = match parse(args) {
        Ok(r) => r,
        Err(r) => return refuse(*r),
    };
    let echo_capped = || {
        Some(echo(
            &req.repo,
            &req.repo_aliases,
            req.window,
            req.interval,
            req.by,
            &req.branches,
            true,
        ))
    };
    let failure = |code: u8,
                   status: &'static str,
                   error: ErrorObj,
                   store: Option<StoreInfo>,
                   machine: Option<Machine>| Refusal {
        code,
        status,
        error,
        echo: echo_capped(),
        store,
        machine,
    };
    let Some(dirs) = &ctx.state else {
        return refuse(failure(
            exit::ERROR,
            "error",
            ErrorObj::new(
                "no_state_dir",
                "HOME is not set; set METER_STATE_DIR to choose the state folder",
            ),
            None,
            None,
        ));
    };
    let (db, dir, location, stray) = match locate(dirs, ctx.overridden) {
        Err(m) => {
            return refuse(failure(
                exit::ERROR,
                "error",
                ErrorObj::new("move_unfinished", m),
                None,
                None,
            ));
        }
        Ok(Located::Absent) => return refuse(absent(failure)),
        Ok(Located::Store {
            db,
            dir,
            location,
            stray,
        }) => (db, dir, location, stray),
    };
    let unreadable = |e: &rusqlite::Error, store: Option<StoreInfo>| -> Refusal {
        if is_busy(e) {
            let mut err = ErrorObj::new(
                "locked",
                format!(
                    "no consistent snapshot of the store within {} s",
                    ctx.busy.as_secs_f64()
                ),
            );
            err.retry_after_s = Some(RETRY_AFTER_S);
            failure(exit::LOCKED, "locked", err, None, None)
        } else {
            failure(
                exit::ERROR,
                "error",
                ErrorObj::new(
                    "store_unreadable",
                    format!("the store could not be read: {e}"),
                ),
                store,
                None,
            )
        }
    };
    if read_only_folder(&db) {
        return refuse(failure(
            exit::ERROR,
            "error",
            ErrorObj::new("read_only_folder", READ_ONLY_FOLDER),
            None,
            None,
        ));
    }
    let conn = match open_read_only(&db, ctx.busy) {
        Ok(c) => c,
        Err(e) => return refuse(unreadable(&e, None)),
    };
    let stale_ms = req.stale_after_s * 1000;
    let window_of = |meta: &BTreeMap<String, String>| -> (i64, i64) {
        let b = req.bounds(meta, ctx.now_ms);
        (b.start, b.end)
    };
    let snap = match read(&conn, &req, window_of) {
        Ok(Read::Snapshot(s)) => s,
        Ok(Read::Absent) => return refuse(absent(failure)),
        Ok(Read::Version(v)) => {
            let store = Some(StoreInfo {
                schema_version: v,
                location: location.as_str(),
            });
            let (code, status, msg) = if v > SCHEMA_VERSION {
                (
                    exit::NEWER_SCHEMA,
                    "newer_schema",
                    "the store was written by a newer usagemeter; update the meter",
                )
            } else {
                (
                    exit::OUTDATED_STORE,
                    "outdated_store",
                    "the store needs a migration that only usagemeter sync runs",
                )
            };
            let mut e = ErrorObj::new(status, msg);
            e.store_schema_version = Some(v);
            e.supported_schema_version = Some(SCHEMA_VERSION);
            return refuse(failure(code, status, e, store, None));
        }
        Err(e) => {
            // The version is known only when reading it worked; a busy store is not asked twice.
            let v = if is_busy(&e) {
                None
            } else {
                schema_version(&conn).ok().flatten()
            };
            let store = v.map(|v| StoreInfo {
                schema_version: v,
                location: location.as_str(),
            });
            return refuse(unreadable(&e, store));
        }
    };
    drop(conn);
    let store_info = StoreInfo {
        schema_version: snap.version,
        location: location.as_str(),
    };
    let machine = machine_of(&snap.meta);
    let (table, pricing) = match pricing(&dir) {
        Ok(p) => p,
        Err(m) => {
            return refuse(failure(
                exit::ERROR,
                "error",
                ErrorObj::new("prices_unreadable", m),
                Some(store_info),
                None,
            ));
        }
    };

    let now = ctx.now_ms;
    let meta = &snap.meta;
    let w = watermark(meta);
    let counted_from = meta_i64(meta, "counted_from_ms").unwrap_or(0);
    let b = req.bounds(meta, ctx.now_ms);
    let clipped = b.clipped;
    let clipped_by_evidence = req
        .interval
        .is_some_and(|(s, _)| snap.evidence_from.is_none_or(|ev| s < ev));
    let window_info = WindowInfo {
        name: if req.interval.is_some() {
            "custom"
        } else {
            req.window.name()
        },
        requested_start: format_rfc3339(b.requested_start),
        start: format_rfc3339(b.start),
        end: format_rfc3339(b.end),
        clipped: b.clipped,
    };
    let backlog = Backlog {
        bytes: meta_i64(meta, "last_pending_bytes").map(|v| v.max(0)),
        files: meta_i64(meta, "last_pending_files").map(|v| v.max(0)),
    };
    let stale = w.is_none_or(|w| now - w > stale_ms);
    let complete = backlog.bytes == Some(0) && backlog.files == Some(0);
    let srcs = sources(&snap.meta, &snap.health, stray, now, stale_ms);
    let harness_sources: Vec<&SourceInfo> =
        srcs.iter().filter(|s| s.harness != LEGACY_STORE).collect();
    let counting: Vec<&&SourceInfo> = harness_sources
        .iter()
        .filter(|s| matches!(s.status.as_str(), "ok" | "degraded"))
        .collect();
    let as_of = if counting.iter().all(|s| s.last_success.is_some()) {
        counting
            .iter()
            .filter_map(|s| snap.health.get(&s.harness).copied().flatten())
            .min()
            .map(format_rfc3339)
    } else {
        None
    };
    let incomplete: Vec<String> = srcs
        .iter()
        .filter(|s| matches!(s.status.as_str(), "degraded" | "unsupported"))
        .map(|s| s.harness.clone())
        .collect();
    let any_unsupported = srcs.iter().any(|s| s.status == "unsupported");
    let all_vouch = srcs
        .iter()
        .all(|s| matches!(s.status.as_str(), "ok" | "absent"));

    // Usage with no branch, neither logged nor filled from a worker's start row (OMP and dsh-tui
    // log none): it could belong to any branch named.
    let mut unattributed = 0i64;
    let mut unattributed_by: BTreeSet<String> = BTreeSet::new();
    let mut by_branch: BTreeMap<&str, Acc> = BTreeMap::new();
    for b in &req.branches {
        by_branch.entry(b.as_str()).or_default();
    }
    // The repo's usage given to no bot, by reason (RFC 0021 (d), delivery 2 D5), whatever the
    // branches named; and, for `--by bot`, the attributed usage per bot key.
    let mut parts: BTreeMap<(u8, &'static str, &'static str), (i64, BTreeSet<String>)> =
        BTreeMap::new();
    let mut by_bot: BTreeMap<BotKey, Acc> = BTreeMap::new();
    let named: BTreeSet<&str> = req.branches.iter().map(String::as_str).collect();
    for r in &snap.rows {
        let total = r.tokens.total;
        if total <= 0 {
            continue;
        }
        match r.branch.as_deref() {
            None => {
                unattributed = unattributed.saturating_add(total);
                unattributed_by.insert(r.harness.clone());
            }
            Some(b) => {
                if req.by == By::Branch
                    && let Some(acc) = by_branch.get_mut(b)
                {
                    acc.add(&r.parts(), &table);
                }
            }
        }
        let part = match r.class {
            Class::Ambiguous => Some((0, "ambiguous", "claimants_differ")),
            Class::Unlinked(Unlinked::NoRecord) => Some((1, "unlinked", "no_record")),
            Class::Unlinked(Unlinked::DshTuiSeat) => Some((2, "unlinked", "dsh_tui_seat")),
            Class::Unlinked(Unlinked::OtherMachine) => Some((3, "unlinked", "other_machine")),
            Class::Before => Some((4, "before_evidence", "before_evidence")),
            Class::Attributed(_) => None,
        };
        if let Some(k) = part {
            let e = parts.entry(k).or_default();
            e.0 = e.0.saturating_add(total);
            e.1.insert(r.harness.clone());
        }
        // A bot query filtered by branch counts only usage on a branch named, logged or filled.
        if req.by == By::Bot
            && let Some(key) = &r.bot
            && (named.is_empty() || r.branch.as_deref().is_some_and(|b| named.contains(b)))
        {
            by_bot
                .entry(key.clone())
                .or_default()
                .add(&r.parts(), &table);
        }
    }
    // A task answer reads the task-labelled calls of the repo in the window: one row per task
    // id, its checkout set for the ambiguity rule (RFC 0021 D4), and the calls the branch filter
    // keeps (as `--by bot`, the branches named are an optional filter).
    let mut by_task: BTreeMap<String, TaskEntry> = BTreeMap::new();
    if req.by == By::Task {
        for call in &snap.task_calls {
            let e = by_task.entry(call.task.clone()).or_default();
            e.projects.insert(call.project.clone());
            if named.is_empty() || call.branch.as_deref().is_some_and(|b| named.contains(b)) {
                e.in_filter = true;
                e.actors.insert(call.bot.clone());
                e.acc.add(&call.parts(), &table);
            }
        }
    }
    let coverage = if unattributed > 0 {
        "partial"
    } else {
        "complete"
    };
    let actor_unattributed = {
        let sum = |state: &str| -> i64 {
            parts
                .iter()
                .filter(|((_, s, _), _)| *s == state)
                .map(|(_, (n, _))| *n)
                .fold(0i64, i64::saturating_add)
        };
        let (ambiguous, unlinked, before) =
            (sum("ambiguous"), sum("unlinked"), sum("before_evidence"));
        let total = ambiguous.saturating_add(unlinked).saturating_add(before);
        // An absent bot is a real 0 only in a bot answer, with nothing given to no bot, and RFC
        // 0018's zero conditions for the whole answer: ingestion complete and fresh with a
        // watermark, the window not clipped, every source ok or absent, the repo seen, and, under
        // a branch filter, no usage with no branch, which could be an absent bot's.
        let absent_bot_is_zero = req.by == By::Bot
            && total == 0
            && complete
            && !stale
            && w.is_some()
            && !clipped
            && all_vouch
            && snap.repo_seen
            && (req.branches.is_empty() || unattributed == 0);
        ActorUnattributed {
            tokens_total: total,
            tokens_ambiguous: ambiguous,
            tokens_unlinked: unlinked,
            tokens_before_evidence: before,
            parts: parts
                .into_iter()
                .map(|((_, state, reason), (n, h))| ActorPart {
                    state,
                    reason,
                    tokens_total: n,
                    harnesses: h.into_iter().collect(),
                })
                .collect(),
            absent_bot_is_zero,
        }
    };

    let rows: Vec<Row> = match req.by {
        By::Bot => {
            // A bot query that names no branch counts usage with no branch in its rows itself, so
            // they are complete; under a branch filter, that usage could be owed to a branch
            // named.
            let bot_coverage = if req.branches.is_empty() {
                "complete"
            } else {
                coverage
            };
            by_bot
                .into_iter()
                .filter(|(_, acc)| acc.tokens.total > 0)
                .map(|(key, acc)| {
                    let (state, reason) = if stale {
                        ("stale", Some("ingestion_stale"))
                    } else {
                        ("measured", None)
                    };
                    let (models, models_omitted) = acc.models();
                    let mut row = BotRow {
                        unrecorded: key.unrecorded(),
                        bot: key.bot,
                        kind: key.kind,
                        role: key.role,
                        squad: key.squad,
                        harness: key.harness,
                        state,
                        reason,
                        tokens: acc.tokens,
                        cost: acc.cost(),
                        models,
                        models_omitted,
                        token_precision: acc.precision(),
                        attribution: Attribution {
                            precision: "actor_interval",
                            exclusive: false,
                            shared: false,
                            coverage: bot_coverage,
                            actor: Some(acc.actor),
                        },
                        activity: acc.activity(),
                        incomplete_sources: incomplete.clone(),
                    };
                    while json(&row).len() > ROW_BYTES && !row.models.is_empty() {
                        row.models.pop();
                        row.models_omitted += 1;
                    }
                    Row::Bot(Box::new(row))
                })
                .collect()
        }
        By::Task => task_rows(&req, by_task, stale, coverage, &incomplete),
        By::Branch => branch_rows(
            &req,
            &by_branch,
            &BranchCtx {
                stale,
                complete,
                clipped,
                clipped_by_evidence,
                all_vouch,
                any_unsupported,
                repo_seen: snap.repo_seen,
                unattributed,
                coverage,
                incomplete: &incomplete,
            },
        ),
    };

    let env = Envelope {
        contract: CONTRACT,
        contract_version: CONTRACT_VERSION,
        capability: CAPABILITY,
        meter_version: ctx.meter_version.clone(),
        status: "ok",
        error: None,
        generated_at: generated_at.clone(),
        as_of,
        machine: Some(machine.clone()),
        store: Some(store_info.clone()),
        ingestion: Some(Ingestion {
            watermark: w.map(format_rfc3339),
            counted_from: format_rfc3339(counted_from),
            evidence_from: snap.evidence_from.map(format_rfc3339),
            complete,
            backlog,
            stale,
            stale_after_s: req.stale_after_s,
        }),
        window: Some(window_info),
        sources: srcs,
        unattributed: Some(Unattributed {
            tokens_total: unattributed,
            harnesses: unattributed_by.into_iter().collect(),
        }),
        actor_unattributed: Some(actor_unattributed),
        pricing: Some(pricing),
        query: Some(echo(
            &req.repo,
            &req.repo_aliases,
            req.window,
            req.interval,
            req.by,
            &req.branches,
            false,
        )),
        rows,
    };

    // The output cap: refused whole, never truncated, with how many rows would have fit.
    let full = line(&env);
    if full.len() <= OUTPUT_CAP {
        return Answer {
            code: exit::OK,
            stdout: full,
        };
    }
    let row_lens: Vec<usize> = env.rows.iter().map(|r| json(r).len()).collect();
    let base = Envelope {
        rows: Vec::new(),
        ..env
    };
    let base_len = line(&base).len();
    let mut used = base_len;
    let mut rows_fit = 0;
    for (i, n) in row_lens.iter().enumerate() {
        let add = n + usize::from(i > 0);
        if used + add > OUTPUT_CAP {
            break;
        }
        used += add;
        rows_fit += 1;
    }
    let mut e = ErrorObj::new(
        "too_large",
        format!(
            "the answer would take {} bytes; the most one answer takes is {OUTPUT_CAP}",
            full.len()
        ),
    );
    e.limit_bytes = Some(OUTPUT_CAP);
    e.needed_bytes = Some(full.len());
    e.rows_fit = Some(rows_fit);
    refuse(failure(
        exit::TOO_LARGE,
        "too_large",
        e,
        Some(store_info),
        Some(machine),
    ))
}

/// What every branch row of one answer shares.
struct BranchCtx<'a> {
    stale: bool,
    complete: bool,
    clipped: bool,
    clipped_by_evidence: bool,
    all_vouch: bool,
    any_unsupported: bool,
    repo_seen: bool,
    unattributed: i64,
    coverage: &'static str,
    incomplete: &'a [String],
}

/// One row per distinct branch, in the order first named (RFC 0018 (a)).
fn branch_rows(req: &Request, by_branch: &BTreeMap<&str, Acc>, c: &BranchCtx<'_>) -> Vec<Row> {
    let mut order: Vec<(&str, usize)> = Vec::new();
    for b in &req.branches {
        match order.iter_mut().find(|(n, _)| *n == b.as_str()) {
            Some(e) => e.1 += 1,
            None => order.push((b.as_str(), 1)),
        }
    }
    order
        .into_iter()
        .map(|(branch, requested)| {
            let acc = &by_branch[branch];
            let found = acc.tokens.total > 0;
            let missing_reason = if !c.repo_seen {
                Some("repo_not_seen")
            } else if c.clipped_by_evidence {
                Some("before_evidence")
            } else if c.clipped {
                Some("window_before_counted_from")
            } else if !c.complete {
                Some("backlog")
            } else if !c.all_vouch {
                Some("source_incomplete")
            } else if c.unattributed > 0 {
                Some("branch_unattributed")
            } else {
                None
            };
            let numbers = |acc: &Acc| {
                (
                    Some(acc.tokens),
                    Some(acc.cost()),
                    Some(acc.precision()),
                    Some(acc.activity()),
                    Some(acc.actor),
                )
            };
            let none = (None, None, None, None, None);
            let (state, reason, (tokens, cost, precision, activity, actor)) = if c.stale {
                (
                    "stale",
                    Some("ingestion_stale"),
                    if found { numbers(acc) } else { none },
                )
            } else if found {
                ("measured", None, numbers(acc))
            } else if c.any_unsupported {
                ("unsupported", Some("source_unsupported"), none)
            } else if let Some(why) = missing_reason {
                ("missing", Some(why), none)
            } else {
                (
                    "zero",
                    None,
                    (
                        Some(TokensOut::default()),
                        Some(Cost {
                            state: "zero",
                            usd: Some(0.0),
                            usd_reported: Some(0.0),
                            usd_estimated: Some(0.0),
                            tokens_priced: 0,
                            tokens_reported: 0,
                            tokens_unpriced: 0,
                            unpriced_models: Vec::new(),
                            unpriced_models_omitted: 0,
                        }),
                        None,
                        Some(Activity {
                            first_hour: None,
                            last_hour: None,
                            hours: 0,
                            harnesses: Vec::new(),
                        }),
                        // A measured 0: every count 0, so the sums hold.
                        Some(ActorOut::default()),
                    ),
                )
            };
            let (models, models_omitted) = if found { acc.models() } else { (Vec::new(), 0) };
            let mut row = BranchRow {
                branch: branch.to_string(),
                requested,
                state,
                reason,
                tokens,
                cost,
                models,
                models_omitted,
                token_precision: precision,
                attribution: Attribution {
                    precision: "branch_window",
                    exclusive: false,
                    shared: requested > 1,
                    coverage: c.coverage,
                    actor,
                },
                activity,
                incomplete_sources: c.incomplete.to_vec(),
            };
            while json(&row).len() > ROW_BYTES && !row.models.is_empty() {
                row.models.pop();
                row.models_omitted += 1;
            }
            Row::Branch(Box::new(row))
        })
        .collect()
}

/// One row per task id with usage under the filter (RFC 0018 M3, RFC 0021 D4). A task id the
/// meter ties to more than one checkout of the repo is never summed: its row is missing with
/// `task_ambiguous`, whatever the window's age (the identity, not the freshness, is unknown).
fn task_rows(
    req: &Request,
    by_task: BTreeMap<String, TaskEntry>,
    stale: bool,
    coverage: &'static str,
    incomplete: &[String],
) -> Vec<Row> {
    // A task query that names no branch counts usage with no branch in its rows itself, so they
    // are complete; under a branch filter, that usage could be owed to a branch named (D3).
    let task_coverage = if req.branches.is_empty() {
        "complete"
    } else {
        coverage
    };
    by_task
        .into_iter()
        .filter(|(_, e)| e.in_filter)
        .map(|(task, e)| {
            let ambiguous = e.projects.len() > 1;
            let found = !ambiguous && e.acc.tokens.total > 0;
            let (state, reason) = if ambiguous {
                ("missing", Some("task_ambiguous"))
            } else if stale {
                ("stale", Some("ingestion_stale"))
            } else {
                ("measured", None)
            };
            let cost = e.acc.cost();
            let token_precision = e.acc.precision();
            let activity = e.acc.activity();
            let actor = e.acc.actor;
            let (models, models_omitted) = if found {
                e.acc.models()
            } else {
                (Vec::new(), 0)
            };
            let mut row = TaskRow {
                task,
                actors: if found {
                    e.actors.into_iter().map(TaskActor::of).collect()
                } else {
                    Vec::new()
                },
                actors_omitted: 0,
                state,
                reason,
                tokens: found.then_some(e.acc.tokens),
                cost: found.then_some(cost),
                models,
                models_omitted,
                token_precision: found.then_some(token_precision),
                attribution: Attribution {
                    precision: "task_interval",
                    exclusive: false,
                    shared: false,
                    coverage: task_coverage,
                    actor: found.then_some(actor),
                },
                activity: found.then_some(activity),
                incomplete_sources: incomplete.to_vec(),
            };
            fit_task_actors(&mut row);
            Row::Task(Box::new(row))
        })
        .collect()
}

/// Keep RFC 0018's row bound by omitting trailing models first, then actor keys. Every
/// omission is counted, so two bots never read as one and a reader shows "at least".
fn fit_task_actors(row: &mut TaskRow) {
    while json(row).len() > ROW_BYTES && !row.models.is_empty() {
        row.models.pop();
        row.models_omitted += 1;
    }
    while json(row).len() > ROW_BYTES && !row.actors.is_empty() {
        row.actors.pop();
        row.actors_omitted += 1;
    }
}

fn absent(
    failure: impl Fn(u8, &'static str, ErrorObj, Option<StoreInfo>, Option<Machine>) -> Refusal,
) -> Refusal {
    failure(
        exit::ABSENT_STORE,
        "absent_store",
        ErrorObj::new(
            "absent_store",
            "no meter store on this machine yet; open Herdr or run usagemeter sync",
        ),
        None,
        None,
    )
}

/// When the last sync finished its pass (a run that stopped at its time budget still finished;
/// `ingestion.complete` and `backlog` say what it left).
pub(crate) fn watermark(meta: &BTreeMap<String, String>) -> Option<i64> {
    meta_i64(meta, "last_run_ms").or_else(|| meta_i64(meta, "last_success_ms"))
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

fn line<T: Serialize>(v: &T) -> String {
    let mut s = json(v);
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_before_evidence_or_frozen_is_never_attributed() {
        let ev = Some(10 * HOUR_MS);
        let c = |from, hour, state: Option<&str>, basis: Option<&str>| {
            classify(from, hour, state, basis, None)
        };
        // No evidence at all: every row is before it, whatever it names.
        assert_eq!(
            c(None, 20 * HOUR_MS, Some("attributed"), Some("session")),
            Class::Before
        );
        // An hour before evidence_from, and a frozen row (no state) after it.
        assert_eq!(
            c(ev, 9 * HOUR_MS, Some("attributed"), Some("session")),
            Class::Before
        );
        assert_eq!(c(ev, 11 * HOUR_MS, None, None), Class::Before);
        // A basis or state this meter does not know is never attributed.
        assert_eq!(
            c(ev, 11 * HOUR_MS, Some("attributed"), Some("guess")),
            Class::Before
        );
        assert_eq!(
            c(ev, 10 * HOUR_MS, Some("attributed"), Some("label")),
            Class::Attributed(Basis::Label)
        );
        assert_eq!(
            classify(
                ev,
                11 * HOUR_MS,
                Some("unlinked"),
                None,
                Some("other_machine")
            ),
            Class::Unlinked(Unlinked::OtherMachine)
        );
        assert_eq!(
            classify(ev, 11 * HOUR_MS, Some("unlinked"), None, None),
            Class::Unlinked(Unlinked::NoRecord)
        );
    }

    #[test]
    fn json_len_matches_serde() {
        for s in [
            "plain",
            "a\"b",
            "back\\slash",
            "tab\there",
            "\u{1}ctl",
            "données",
            "é\"\u{7f}",
        ] {
            assert_eq!(
                json_len(s),
                serde_json::to_string(s).unwrap().len(),
                "{s:?}"
            );
        }
    }

    #[test]
    fn bounded_names_fit_and_say_they_were_cut() {
        let long = "m\"".repeat(100);
        let b = json_bounded(&long, MODEL_NAME_BYTES);
        assert!(json_len(&b) <= MODEL_NAME_BYTES, "{b}");
        assert!(b.ends_with('…'));
        assert_eq!(json_bounded("short", MODEL_NAME_BYTES), "short");
    }

    #[test]
    fn the_task_read_is_bounded_by_the_launches_started_on_a_task() {
        use crate::store::Store;
        let store = Store::open_in_memory().unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO launch(lkey, task, project, worktree, source, updated_ms) VALUES
                   ('a', 'gn-1', '/work/a', '/work/a/.worktrees/gn-1/', 'ledger', 0),
                   ('b', NULL, '/work/b', '/work/b/.worktrees/x', 'ledger', 0);
                 INSERT INTO link(harness, session, lkey, basis) VALUES
                   ('claude', x'0101', 'a', 'session'),
                   ('claude', x'0202', 'b', 'session');
                 INSERT INTO ev_cwd(id, path) VALUES
                   (1, '/work/a/.worktrees/gn-1'),
                   (2, '/work/b/.worktrees/x'),
                   (3, '/work/elsewhere');",
            )
            .unwrap();
        let c = task_candidates(&store.conn).unwrap();
        assert_eq!(
            c.sessions,
            vec![vec![1u8, 1]],
            "only a task launch's session"
        );
        assert_eq!(
            c.cwds,
            vec![1],
            "only a task launch's start folder, a trailing slash and all"
        );
    }

    #[test]
    fn a_sub_agent_is_read_into_its_task_through_its_parent_session() {
        use crate::store::Store;
        // A worker linked by its session, started in a folder that is not the launch's worktree
        // string, and its sub-agent: the sub-agent's own session names no link and its start
        // folder no worktree, so only its parent ties it to the task (as the resolver ties it).
        let store = Store::open_in_memory().unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO launch(lkey, task, project, worktree, source, updated_ms) VALUES
                   ('a', 'gn-1', '/work/a', '/work/a/.worktrees/gn-1', 'ledger', 0);
                 INSERT INTO link(harness, session, lkey, basis) VALUES
                   ('claude', x'01', 'a', 'session');
                 INSERT INTO ev_cwd(id, path) VALUES (1, '/work/a');
                 INSERT INTO ev_dim(id, harness, model, machine, repo, branch, precision) VALUES
                   (1, 'claude-code', 'claude-opus-5-5', 'machine-a1b2c3',
                    'example.com/acme/widgets', 'feat/gn-1', 'exact');
                 INSERT INTO ev_actor(id, state, bot, kind, role, task, project, basis) VALUES
                   (1, 'attributed', 'kite', 'worker', 'dev', 'gn-1', '/work/a', 'session');
                 INSERT INTO evidence(id, ts_ms, dim, actor, session, parent, session_cwd, output)
                 VALUES
                   (1, 1000, 1, 1, x'01', NULL, 1, 10),
                   (2, 2000, 1, 1, x'02', x'01', 1, 10),
                   (3, 3000, 1, 1, x'03', x'09', 1, 10);",
            )
            .unwrap();
        let calls = task_calls(&store.conn, &["example.com/acme/widgets"], 0, 10_000).unwrap();
        assert_eq!(
            calls.len(),
            2,
            "the worker's call and its sub-agent's, each once; a stranger's child is not read"
        );
        assert_eq!(calls.iter().map(|c| c.tokens.total).sum::<i64>(), 20);
        assert!(calls.iter().all(|c| c.task == "gn-1"));

        // A call both arms name (its session and its parent are task sessions) counts once.
        store
            .conn
            .execute_batch(
                "INSERT INTO link(harness, session, lkey, basis) VALUES
                   ('claude', x'02', 'a', 'session');",
            )
            .unwrap();
        let calls = task_calls(&store.conn, &["example.com/acme/widgets"], 0, 10_000).unwrap();
        assert_eq!(calls.len(), 2, "one count per evidence id");
        assert_eq!(calls.iter().map(|c| c.tokens.total).sum::<i64>(), 20);
    }

    #[test]
    fn a_task_id_the_contract_cannot_print_does_not_fit() {
        for bad in ["", "gn\u{1b}[2J", "gn\n41", "gn\t41", "\u{7f}", "\u{85}"] {
            assert!(!task_id_fits(bad), "{bad:?}");
        }
        assert!(!task_id_fits(&"t".repeat(65)));
        for ok in ["gn-41", "GN 41", "tâche-7", &"t".repeat(64)] {
            assert!(task_id_fits(ok), "{ok:?}");
        }
    }

    #[test]
    fn a_task_row_with_every_actor_at_its_largest_keeps_the_row_bound() {
        let actor = |i: usize| TaskActor {
            bot: format!("{i:02}{}", "b".repeat(62)),
            kind: "worker",
            role: Some("r".repeat(64)),
            squad: Some("s".repeat(64)),
            unrecorded: Vec::new(),
            harness: "h".repeat(64),
        };
        let mut counts = ActorOut::default();
        for n in [
            &mut counts.tokens_attributed,
            &mut counts.tokens_ambiguous,
            &mut counts.tokens_unlinked,
            &mut counts.tokens_before_evidence,
        ] {
            *n = i64::MAX;
        }
        let mut row = TaskRow {
            task: "t".repeat(64),
            actors: (0..20).map(actor).collect(),
            actors_omitted: 0,
            state: "measured",
            reason: None,
            tokens: Some(TokensOut {
                input: i64::MAX,
                cache_read: i64::MAX,
                cache_write_5m: i64::MAX,
                cache_write_1h: i64::MAX,
                output: i64::MAX,
                reasoning: Some(i64::MAX),
                unsplit: i64::MAX,
                total: i64::MAX,
            }),
            cost: Some(Cost {
                state: "unpriced",
                usd: None,
                usd_reported: None,
                usd_estimated: None,
                tokens_priced: i64::MAX,
                tokens_reported: i64::MAX,
                tokens_unpriced: i64::MAX,
                unpriced_models: (0..UNPRICED_MODELS_MAX).map(|i| format!("m{i}")).collect(),
                unpriced_models_omitted: 0,
            }),
            models: (0..MODELS_MAX)
                .map(|i| ModelOut {
                    model: format!("m{i}"),
                    calls: 1,
                    tokens: TokensOut {
                        total: 1,
                        ..TokensOut::default()
                    },
                    cost_usd: None,
                })
                .collect(),
            models_omitted: 0,
            token_precision: Some("exact"),
            attribution: Attribution {
                precision: "task_interval",
                exclusive: false,
                shared: false,
                coverage: "partial",
                actor: Some(counts),
            },
            activity: Some(Activity {
                first_hour: Some("2026-11-08T10:00:00Z".into()),
                last_hour: Some("2026-11-08T10:00:00Z".into()),
                hours: 1,
                harnesses: vec!["h".repeat(64)],
            }),
            incomplete_sources: Vec::new(),
        };
        let all: Vec<String> = row.actors.iter().map(|a| a.bot.clone()).collect();
        let total = row.tokens.as_ref().unwrap().total;
        fit_task_actors(&mut row);
        assert!(row.models.is_empty(), "models are omitted before actors");
        assert_eq!(row.models_omitted, MODELS_MAX);
        assert!(
            json(&row).len() <= ROW_BYTES,
            "a task row of {} bytes",
            json(&row).len()
        );
        assert_eq!(
            row.actors.len() + row.actors_omitted,
            all.len(),
            "every actor key is either kept or counted"
        );
        assert!(
            row.actors_omitted > 0,
            "the bound left some actor keys out and said so"
        );
        assert_eq!(
            row.actors.iter().map(|a| a.bot.clone()).collect::<Vec<_>>(),
            all[..row.actors.len()],
            "the kept keys are the leading ones, in order"
        );
        assert_eq!(
            row.tokens.as_ref().unwrap().total,
            total,
            "the row's tokens are the task's, unchanged at the bound"
        );
    }

    #[test]
    fn branch_and_repo_forms() {
        assert!(branch_ok("feat/gn-12-cache"));
        assert!(branch_ok("quote\"d"));
        for bad in [
            "",
            "a b",
            "a\\b",
            "a\u{1}",
            "a\u{7f}",
            "a\u{a0}",
            "a\u{feff}",
        ] {
            assert!(!branch_ok(bad), "{bad:?}");
        }
        assert!(repo_ok("example.com/acme/widgets"));
        assert!(repo_ok("example.org/group/sub/project"));
        for bad in [
            "Example.com/a/b",
            "example.com",
            "example.com/",
            "example.com//b",
            "e.com/a b",
        ] {
            assert!(!repo_ok(bad), "{bad:?}");
        }
    }
}
