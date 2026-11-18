//! `meter sync`: one bounded pass over the harness logs, then the summary doc.

use std::collections::{BTreeSet, HashMap};
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::event::{Precision, Tokens, UsageEvent};
use crate::evidence::{self, Actor, Dim, Evidence, SessionKey};
use crate::hc::Hc;
use crate::ledger::{Call, Resolver};
use crate::outcomes::record;
use crate::paths;
use crate::prices::PriceTable;
use crate::scan::{self, Candidate, Plan, ReadLimits, ReadOutcome};
use crate::sources::Source;
use crate::sources::codex::{self, State};
use crate::sources::tool_error::ToolError;
use crate::store::{Attributed, FileState, Health, SCHEMA_VERSION, Store};
use crate::summary::{self, SourceHealth};
use crate::time::{DAY_MS, HOUR_MS, day_start};
use rusqlite::OptionalExtension;

/// Phase timings on stderr when `METER_TRACE` is set. Durations only, never content.
struct Trace {
    on: bool,
    last: std::cell::Cell<Instant>,
}

impl Trace {
    fn new() -> Trace {
        Trace {
            on: std::env::var_os("METER_TRACE").is_some(),
            last: std::cell::Cell::new(Instant::now()),
        }
    }

    fn mark(&self, phase: &str) {
        if self.on {
            let now = Instant::now();
            eprintln!(
                "meter: {phase} {:.0} ms",
                (now - self.last.get()).as_secs_f64() * 1000.0
            );
            self.last.set(now);
        }
    }
}

pub const DEFAULT_DAYS: i64 = 30;
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(20);
pub const DEFAULT_STALE_MS: i64 = 10 * 60 * 1000;
pub const DEFAULT_DOC: &str = "herdr-meter";
const REPO_RECHECK_MS: i64 = 7 * DAY_MS;
/// Threads are re-listed from a little before the last run's newest `updated_at_ms`, in case
/// Codex stamped a thread before it finished writing the rollout.
const CODEX_SLACK_MS: i64 = 10 * 60 * 1000;
/// A rollout with no running total is counted from `tokens_used` only once its thread has been
/// idle this long (a new thread writes its first total after its first reply).
const CODEX_IDLE_MS: i64 = HOUR_MS;

#[derive(Debug, Clone)]
pub struct Options {
    /// `~/.omp/agent/sessions`.
    pub omp_root: PathBuf,
    /// `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`).
    pub claude_root: PathBuf,
    /// `~/.codex` (or `$CODEX_HOME`).
    pub codex_home: PathBuf,
    /// `~/.dsh/sessions` (or `$DSH_HOME/sessions`).
    pub dsh_root: PathBuf,
    /// `~/.gemini/antigravity-cli/conversations` (or `$AGY_HOME/conversations`).
    pub agy_root: PathBuf,
    /// Herdr's global app home (`$HERDR_APP_HOME`, else `~/.config/herdr-app`): its workers and
    /// attach ledgers attribute usage. None reads neither.
    pub app_home: Option<PathBuf>,
    /// `$HERDR_WORKERS_LEDGER`, read beside the app home's ledgers when set.
    pub workers_ledger: Option<PathBuf>,
    /// Look for project app homes (`.herdr/app-home`) above each call's cwd.
    pub project_ledgers: bool,
    pub state_dir: PathBuf,
    /// The old default state directory to move the meter's files out of, once, before the first
    /// run in `state_dir` (see [`paths::migrate`]). None when `METER_STATE_DIR` is set.
    pub migrate_from: Option<PathBuf>,
    /// Window for the first import, and for a widening re-import.
    pub days: Option<i64>,
    pub backfill: bool,
    /// `--evidence-backfill --days N`: give the calls of the last `N` days (at most
    /// [`evidence::EVIDENCE_DAYS`]) their evidence from the logs still on disk, and recompute the
    /// attribution of every call from then (RFC 0018 (b), RFC 0021 (c)). Explicit, never on a
    /// read; once started, it resumes on later syncs until it is done.
    pub evidence_backfill: Option<i64>,
    pub force: bool,
    pub budget: Duration,
    pub stale_ms: i64,
    pub publish: bool,
    pub doc_name: String,
    /// Talk to herdr-core (core id, labels, publish). Off in tests.
    pub use_hc: bool,
    /// Ask git for the repo of each cwd. Off in most tests.
    pub resolve_repos: bool,
    pub chunk_bytes: usize,
    pub max_line: usize,
    pub summary_cap: usize,
    pub now_ms: i64,
    /// Stop after this many chunks, as the time budget would (tests).
    #[doc(hidden)]
    pub chunk_limit: Option<usize>,
    /// The free bytes the migration check sees, instead of asking the filesystem (tests).
    #[doc(hidden)]
    pub free_bytes: Option<u64>,
    /// Fail the store write after this many chunks, as a full disk would (tests).
    #[doc(hidden)]
    pub fail_writes_after: Option<usize>,
    /// What `hc terminal.list` would answer, when `use_hc` is off (tests): the snapshot the
    /// resolver and the launch table read, with the store's machine id as the core.
    #[doc(hidden)]
    pub snapshot: Option<Vec<crate::hc::Terminal>>,
    /// Look for project app homes only inside this folder (tests: their temp folder).
    #[doc(hidden)]
    pub walk_within: Option<PathBuf>,
    /// What hc's list of finished terminals would answer, when `use_hc` is off (tests).
    #[doc(hidden)]
    pub ends: Option<Vec<crate::hc::TerminalEnd>>,
    /// Make putting a generation back fail once the failed store is moved aside (tests).
    #[doc(hidden)]
    pub fail_restore: bool,
}

impl Options {
    pub fn new(home: PathBuf, state_dir: PathBuf, now_ms: i64) -> Options {
        let claude_root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"))
            .join("projects");
        let codex_home = std::env::var_os("CODEX_HOME")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let dsh_root = std::env::var_os("DSH_HOME")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".dsh"))
            .join("sessions");
        let agy_root = std::env::var_os("AGY_HOME")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".gemini/antigravity-cli"))
            .join("conversations");
        let app_home = crate::ledger::app_home(
            std::env::var_os(crate::ledger::APP_HOME_ENV),
            Some(home.clone()),
        );
        let workers_ledger = std::env::var_os(crate::ledger::LEDGER_ENV)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from);
        Options {
            omp_root: home.join(".omp/agent/sessions"),
            claude_root,
            codex_home,
            dsh_root,
            agy_root,
            app_home,
            workers_ledger,
            project_ledgers: true,
            state_dir,
            migrate_from: None,
            days: None,
            backfill: false,
            evidence_backfill: None,
            force: false,
            budget: DEFAULT_BUDGET,
            stale_ms: DEFAULT_STALE_MS,
            publish: true,
            doc_name: DEFAULT_DOC.into(),
            use_hc: true,
            resolve_repos: true,
            chunk_bytes: 8 << 20,
            max_line: 16 << 20,
            summary_cap: summary::DEFAULT_CAP_BYTES,
            now_ms,
            chunk_limit: None,
            free_bytes: None,
            fail_writes_after: None,
            snapshot: None,
            walk_within: None,
            ends: None,
            fail_restore: false,
        }
    }
}

#[derive(Debug, Default)]
pub struct Report {
    pub files_seen: usize,
    pub files_read: usize,
    pub unreadable: usize,
    pub bytes_read: u64,
    pub health: Health,
    pub pending_bytes: u64,
    pub pending_files: u64,
    pub stopped_by_budget: bool,
    pub elapsed: Duration,
    pub counted_from_ms: i64,
    pub reimported: bool,
    pub machine: String,
    pub summary_bytes: usize,
    pub summary: Option<serde_json::Value>,
    /// None: not attempted. Some(Ok(version)) or Some(Err(reason)).
    pub published: Option<Result<u64, String>>,
    /// The generation this run kept before it reset the store.
    pub generation: Option<crate::store::Generation>,
    /// Generations removed because this run succeeded on the migrated store.
    pub generations_removed: Vec<PathBuf>,
    /// Rollups an older build keyed without their reason, re-keyed by this run (after keeping a
    /// generation), and how many of them were merged into a row already under the new id.
    pub rekeyed: (usize, usize),
    /// This run migrated the store to the current schema (its generation stays until a later
    /// successful sync).
    pub migrated: bool,
    /// Launch and link rows this run wrote, and the calls it queued for recompute (by session or
    /// start folder).
    pub launches_changed: usize,
    pub links_changed: usize,
    /// Calls whose attribution a launch or link learned this run changed, moved between rollups.
    pub calls_moved: u64,
    /// Calls whose attribution changed but which no rollup row held, so were left where they
    /// were rather than counted twice.
    pub calls_refused: u64,
    /// Sessions and start folders still waiting for recompute (the budget ran out).
    pub attribution_backlog: i64,
    /// Evidence rows dropped by the retention bounds.
    pub evidence_pruned: usize,
    /// An evidence backfill ran this sync: the start it re-reads back to, the calls it gave their
    /// evidence, and whether it is done (else the next sync goes on).
    pub evidence_backfill: Option<Backfilled>,
}

/// What one sync did of an evidence backfill.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Backfilled {
    pub from_ms: i64,
    pub adopted: u64,
    /// Calls re-read that were left as they were: no pre-evidence row held them with the same
    /// logging, or they already had their evidence (issue 1229).
    pub left_alone: u64,
    /// Calls the rollups of the backfilled hours held beyond their evidence (pruned, and no log
    /// gave it back), moved to those hours' frozen rows when the backfill ended: before evidence.
    pub unbacked: u64,
    pub done: bool,
}

#[derive(Debug)]
pub enum Outcome {
    /// Another `meter sync` holds the lock.
    Locked,
    /// The move out of the old state directory is blocked (stderr says why): nothing was
    /// created, opened or synced.
    Blocked,
    /// The last complete sync is younger than the staleness window.
    Fresh {
        age_ms: i64,
    },
    /// The store was written by a newer meter (its `schema_version` is above this binary's):
    /// nothing was read, written or created.
    NewerSchema {
        store: i64,
    },
    /// A destructive migration needs at least twice the store's size, plus the growth the logs
    /// still to import are projected to add ([`projected_growth`]), free and the filesystem has
    /// less: the store was left as it was, and nothing else changed.
    NoSpace {
        free: u64,
        needed: u64,
        /// The projected growth inside `needed`.
        growth: u64,
    },
    /// The store ran out of room part-way, despite the check: the run stopped, and the store was
    /// put back from its generation, or keeps the chunks it committed (`reason` says which).
    RanOutOfRoom {
        reason: String,
    },
    Ran(Box<Report>),
}

#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A failure to write the store while a log was read (a full disk, a file-size limit): never an
/// unreadable log, always the end of the run.
#[derive(Debug)]
struct StoreWrite(rusqlite::Error);

impl std::fmt::Display for StoreWrite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if no_room(&self.0) {
            write!(f, "{NO_ROOM}: {}", self.0)
        } else {
            write!(f, "cannot write the store: {}", self.0)
        }
    }
}

impl std::error::Error for StoreWrite {}

fn store_write(e: rusqlite::Error) -> io::Error {
    io::Error::other(StoreWrite(e))
}

/// The run's error when reading a log failed because the store could not be written.
fn store_failure(e: &io::Error) -> Option<Error> {
    e.get_ref()
        .and_then(|x| x.downcast_ref::<StoreWrite>())
        .map(|w| Error(w.to_string()))
}

use crate::store::{NO_ROOM, no_room};

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Error {
        if no_room(&e) {
            Error(format!("{NO_ROOM}: meter database: {e}"))
        } else {
            Error(format!("meter database: {e}"))
        }
    }
}

/// Attribution: machine, repo per cwd (cached), and the call's evidence and derived attribution
/// from the resolver. Session and request ids are hashed with the store's key before anything
/// else sees them.
struct Attributor {
    machine: String,
    resolver: Resolver,
    repos: HashMap<String, Option<String>>,
    resolve: bool,
    now_ms: i64,
    key: SessionKey,
    /// Fail the store write after this many chunks, as a full disk would (tests).
    fail_writes_after: Option<std::cell::Cell<usize>>,
}

impl Attributor {
    fn repo(&mut self, store: &Store, cwd: Option<&str>) -> rusqlite::Result<Option<String>> {
        let Some(cwd) = cwd else { return Ok(None) };
        if let Some(r) = self.repos.get(cwd) {
            return Ok(r.clone());
        }
        let r = match store.cached_repo(cwd)? {
            Some((r, checked)) if self.now_ms - checked < REPO_RECHECK_MS => r,
            _ => {
                let r = if self.resolve {
                    crate::repo::resolve(cwd)
                } else {
                    None
                };
                store.cache_repo(cwd, r.as_deref(), self.now_ms)?;
                r
            }
        };
        self.repos.insert(cwd.to_string(), r.clone());
        Ok(r)
    }

    /// The call's attribution, derived from the launch the resolver ties it to (RFC 0021 (a)).
    /// An ambiguous or unlinked call has no bot: a bot is never guessed.
    #[allow(clippy::too_many_arguments)]
    fn actor(
        &mut self,
        harness: &str,
        session: Option<&str>,
        parent: Option<&str>,
        cwd: Option<&str>,
        session_cwd: Option<&str>,
        at_ms: i64,
        copied: bool,
        branch: Option<&str>,
    ) -> Actor {
        let call = Call {
            harness,
            session,
            parent_session: parent,
            cwd,
            session_cwd,
            at_ms,
            copied,
        };
        let r = self.resolver.resolve(&call);
        let mut a = Actor::derive(&r, harness, branch);
        if matches!(r, crate::ledger::Resolution::Unlinked) {
            let elsewhere = !copied && self.resolver.elsewhere(&call);
            let witnessed = !copied && self.resolver.witnessed(&call);
            a.reason =
                Some(evidence::unlinked_reason(harness, copied, elsewhere, witnessed).into());
        }
        a
    }

    /// Hands the resolver a dsh-tui session's own start record, when its header named the
    /// terminal it runs in (RFC 0026 (d)): the session hashed as its calls are, the terminal and
    /// the session's start. Called with a file's context before its calls are attributed, so the
    /// first call of a new log already finds its launch.
    fn witness(&mut self, source: Source, ctx: &crate::sources::FileCtx) {
        if source != Source::DshTui {
            return;
        }
        if let (Some(session), Some(terminal)) = (ctx.session.as_deref(), ctx.terminal.as_deref()) {
            let scope = evidence::scope(source.harness());
            self.resolver
                .witness(&self.key.hex(scope, session), terminal, ctx.created_at);
        }
    }

    /// A stored call's attribution, as the resolver gives it now.
    fn rederive(&mut self, c: &evidence::Stored) -> Actor {
        let session = c.session.as_deref().map(crate::event::hex);
        let parent = c.parent.as_deref().map(crate::event::hex);
        let harness = c.dim.harness.clone();
        self.actor(
            &harness,
            session.as_deref(),
            parent.as_deref(),
            c.cwd.as_deref(),
            c.session_cwd.as_deref(),
            c.ts_ms,
            c.copied,
            c.dim.branch.as_deref(),
        )
    }

    /// A stored tool failure's attribution, as the resolver gives it now.
    fn rederive_error(&mut self, e: &record::Stored) -> Actor {
        let session = e.session.as_deref().map(crate::event::hex);
        let parent = e.parent.as_deref().map(crate::event::hex);
        let harness = e.harness.clone();
        self.actor(
            &harness,
            session.as_deref(),
            parent.as_deref(),
            e.cwd.as_deref(),
            e.session_cwd.as_deref(),
            e.ts_ms,
            false,
            e.branch.as_deref(),
        )
    }

    /// A chunk's tool failures (issue 899), each attributed as a call of the same session, folder
    /// and moment is: through the same links, to the same launch. One before the window, or
    /// before the evidence's day bound, is not kept.
    fn attribute_errors(
        &mut self,
        store: &Store,
        errors: Vec<ToolError>,
        from_ms: i64,
    ) -> rusqlite::Result<Vec<record::ErrorRow>> {
        let floor = from_ms.max(evidence::retention_cut(self.now_ms));
        let mut out = Vec::with_capacity(errors.len());
        for e in errors {
            if e.ts_ms < floor {
                continue;
            }
            let repo = match &e.repo {
                Some(r) => Some(r.clone()),
                None => self.repo(store, e.cwd.as_deref())?,
            };
            let scope = evidence::scope(e.harness);
            let session = e.session.as_deref().map(|s| self.key.hash(scope, s));
            let parent = e.parent_session.as_deref().map(|s| self.key.hash(scope, s));
            let (sh, ph) = (
                session.map(|b| crate::event::hex(&b)),
                parent.map(|b| crate::event::hex(&b)),
            );
            let actor = self.actor(
                e.harness,
                sh.as_deref(),
                ph.as_deref(),
                e.cwd.as_deref(),
                e.session_cwd.as_deref(),
                e.ts_ms,
                false,
                e.branch.as_deref(),
            );
            out.push(record::ErrorRow {
                ts_ms: e.ts_ms,
                kind: e.kind,
                // A failure has no model and no precision: it is not usage.
                dim: Dim {
                    harness: e.harness.to_string(),
                    model: String::new(),
                    machine: self.machine.clone(),
                    repo,
                    branch: e.branch,
                    precision: String::new(),
                },
                actor,
                session,
                parent,
                cwd: e.cwd,
                session_cwd: e.session_cwd,
                ident: self.key.hash("err", &e.ident),
            });
        }
        Ok(out)
    }

    fn attribute(
        &mut self,
        store: &Store,
        events: Vec<UsageEvent>,
        from_ms: i64,
    ) -> rusqlite::Result<Vec<Attributed>> {
        let mut out = Vec::with_capacity(events.len());
        for e in events {
            if e.ts_ms < from_ms {
                continue;
            }
            let repo = match &e.repo {
                Some(r) => Some(r.clone()),
                None => self.repo(store, e.cwd.as_deref())?,
            };
            let scope = evidence::scope(e.harness);
            let session = e.session.as_deref().map(|s| self.key.hash(scope, s));
            let parent = e.parent_session.as_deref().map(|s| self.key.hash(scope, s));
            let (sh, ph) = (
                session.map(|b| crate::event::hex(&b)),
                parent.map(|b| crate::event::hex(&b)),
            );
            let actor = self.actor(
                e.harness,
                sh.as_deref(),
                ph.as_deref(),
                e.cwd.as_deref(),
                e.session_cwd.as_deref(),
                e.ts_ms,
                e.copied,
                e.branch.as_deref(),
            );
            let dim = Dim {
                harness: e.harness.to_string(),
                model: e.model,
                machine: self.machine.clone(),
                repo,
                branch: e.branch,
                precision: e.precision.as_str().into(),
            };
            let (key, _) = evidence::rollup_key(&dim, &actor, crate::time::hour_start(e.ts_ms));
            // A call already past the evidence's day bound keeps its rollup, never an evidence
            // row the same run would prune.
            let kept = e.ts_ms >= evidence::retention_cut(self.now_ms);
            let request = (!e.dedupe_key.is_empty())
                .then(|| self.key.hash(&format!("req:{}", e.harness), &e.dedupe_key));
            out.push(Attributed {
                key,
                dedupe_key: e.dedupe_key,
                tokens: e.tokens,
                precision: e.precision,
                reported_usd: e.reported_usd,
                session: e.session,
                parent_session: e.parent_session,
                ts_ms: e.ts_ms,
                evidence: kept.then_some(Evidence {
                    dim,
                    actor,
                    session,
                    parent,
                    request,
                    cwd: e.cwd,
                    session_cwd: e.session_cwd,
                    copied: e.copied,
                }),
            });
        }
        Ok(out)
    }
}

fn random_id() -> String {
    use std::io::Read;
    let mut b = [0u8; 12];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .is_err()
    {
        let seed = format!("{}-{}", crate::time::now_ms(), std::process::id());
        b.copy_from_slice(
            &sha2::Digest::finalize(<sha2::Sha256 as sha2::Digest>::new_with_prefix(seed))[..12],
        );
    }
    format!("m-{}", crate::event::hex(&b))
}

/// The machine id: herdr-core's core id, else a random id generated once and kept in the store.
fn machine_id(store: &Store, core: Option<&str>) -> rusqlite::Result<String> {
    if let Some(id) = core {
        store.set_meta("machine", id)?;
        return Ok(id.to_owned());
    }
    if let Some(id) = store.meta("machine")? {
        return Ok(id);
    }
    let id = match store.meta("machine_fallback")? {
        Some(id) => id,
        None => {
            let id = random_id();
            store.set_meta("machine_fallback", &id)?;
            id
        }
    };
    Ok(id)
}

pub fn source_health(store: &Store) -> rusqlite::Result<Vec<SourceHealth>> {
    let mut by: HashMap<String, SourceHealth> = HashMap::new();
    for (src, last, h) in store.health()? {
        by.insert(
            src.clone(),
            SourceHealth {
                harness: src,
                last_success_ms: last,
                usage_lines: h.usage_lines,
                events: h.events,
                duplicates: h.duplicates,
                skipped_lines: h.skipped_lines,
                rewrites: h.rewrites,
                ..Default::default()
            },
        );
    }
    let mut out = Vec::new();
    for s in Source::ALL {
        let mut h = by.remove(s.harness()).unwrap_or(SourceHealth {
            harness: s.harness().into(),
            ..Default::default()
        });
        let (status, reason) = source_status(|k| store.meta(k).ok().flatten(), s);
        h.status = status;
        h.reason = reason;
        if s == Source::Codex {
            h.threads = Some(store.codex_thread_counts()?);
        }
        out.push(h);
    }
    Ok(out)
}

/// The longest reason the query's envelope carries (`sources[].reason`).
const REASON_CHARS: usize = crate::query::LABEL_CHARS;

/// The `meta` key holding how many Herdr ledgers the last sync refused.
pub const LEDGERS_REFUSED: &str = "ledgers_refused";

/// Why attribution is missing on every source, when a ledger was refused; None otherwise.
fn refused_reason(meta: &impl Fn(&str) -> Option<String>) -> Option<String> {
    let n: u64 = meta(LEDGERS_REFUSED)?.parse().ok().filter(|n| *n > 0)?;
    Some(format!(
        "{n} Herdr ledger(s) not read (group- or world-writable): the usage they would tag has \
         no bot"
    ))
}

/// One source's status and reason, from the store's `meta`, as `status`, the summary doc and the
/// query all report it: `<harness>_status` and `<harness>_reason`, which every sync writes, then
/// the refused-ledger note when the last sync refused one. A dsh-tui session in a format this
/// meter cannot read makes that source `unsupported`.
pub fn source_status(meta: impl Fn(&str) -> Option<String>, s: Source) -> (String, Option<String>) {
    let h = s.harness();
    if s == Source::DshTui
        && let Some(r) = meta("dsh_unread").filter(|r| !r.is_empty())
    {
        return ("unsupported".into(), Some(r));
    }
    let status = meta(&format!("{h}_status"))
        .filter(|v| matches!(v.as_str(), "ok" | "degraded" | "unsupported" | "absent"))
        .unwrap_or_else(|| "ok".into());
    let own = meta(&format!("{h}_reason")).filter(|r| !r.is_empty());
    // A refused ledger leaves the usage complete but untagged: the status stays. The harness's
    // own reason comes first, cut short when needed so the note still fits the reason's bound.
    let refused = matches!(status.as_str(), "ok" | "degraded")
        .then(|| refused_reason(&meta))
        .flatten();
    let reason = match (own, refused) {
        (Some(o), Some(r)) => {
            let room = REASON_CHARS.saturating_sub(r.chars().count() + 2);
            let o: String = o.chars().take(room).collect();
            Some(format!("{o}; {r}"))
        }
        (o, r) => o.or(r),
    };
    (status, reason)
}

/// How long a session file must have been left alone before bytes at its end that are not a whole
/// frame count as unreadable rather than as a frame still being written.
const HELD_AFTER_MS: i64 = 60 * 1000;

/// dsh-tui's health after a run: `absent` with no session folder; `degraded` when any usage line
/// or frame could not be read since the window started (its usage is unknown), or when bytes at
/// the end of a session that stopped growing are not a whole frame (a corrupted block size holds
/// back the rest of the file); else `ok`.
fn dsh_tui_health(store: &Store, root: &std::path::Path, now: i64) -> rusqlite::Result<()> {
    let h = Source::DshTui.harness();
    let (status, reason) = if !root.is_dir() {
        ("absent", String::new())
    } else {
        let skipped = store
            .health()?
            .into_iter()
            .find(|(s, _, _)| s == h)
            .map_or(0, |(_, _, x)| x.skipped_lines);
        let (files, bytes): (i64, i64) = store.conn.query_row(
            "SELECT count(*), coalesce(sum(size - offset), 0) FROM files
             WHERE source = ?1 AND offset < size AND mtime_ms <= ?2",
            rusqlite::params![h, now - HELD_AFTER_MS],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut why = Vec::new();
        if skipped > 0 {
            why.push(format!(
                "{skipped} usage lines or frames could not be read, so their usage is unknown"
            ));
        }
        if files > 0 {
            why.push(format!(
                "{bytes} bytes at the end of {files} sessions are not whole frames, so their \
                 usage is unknown"
            ));
        }
        (
            if why.is_empty() { "ok" } else { "degraded" },
            why.join("; "),
        )
    };
    store.set_meta(&format!("{h}_status"), status)?;
    store.set_meta(&format!("{h}_reason"), &reason)
}

/// Antigravity's health after a run: `absent` with no conversation folder, `unsupported` when a
/// transcript has a shape this meter does not know (its usage is unknown, never zero), `degraded`
/// when one could not be read this time, else `ok`. The reason never names a path or account.
fn agy_health(
    store: &Store,
    root: &std::path::Path,
    shape: Option<String>,
    pending: Option<String>,
    unreadable: Option<String>,
) -> rusqlite::Result<()> {
    let (status, reason) = if !root.is_dir() {
        ("absent", String::new())
    } else if let Some(why) = shape {
        ("unsupported", why)
    } else if let Some(why) = pending {
        ("degraded", why)
    } else if let Some(why) = unreadable {
        ("degraded", why)
    } else {
        ("ok", String::new())
    };
    store.set_meta("agy_status", status)?;
    store.set_meta("agy_reason", &reason)
}

/// The version of the store at `db` when it is newer than this meter's. The caller holds the lock
/// of the store's directory, so nothing writes while it reads.
fn newer_version(db: &std::path::Path) -> Result<Option<i64>, Error> {
    Ok(crate::store::peek(db)?
        .map(|p| p.version)
        .filter(|v| *v > SCHEMA_VERSION))
}

/// [`newer_version`] for a directory whose lock is not held, read only while it has no lock file:
/// every meter makes its lock file before it writes, so with none there before and after the
/// read, nothing wrote during it. Anything else (a lock file, an unreadable store) says nothing.
fn newer_unlocked(dir: &std::path::Path) -> Option<i64> {
    let lock = dir.join("meter.lock");
    if lock.symlink_metadata().is_ok() {
        return None;
    }
    let v = newer_version(&dir.join("meter.db")).ok().flatten()?;
    lock.symlink_metadata().is_err().then_some(v)
}

/// [`newer_version`] for the old directory's store: under its lock when it has a lock file (and
/// not at all while an older meter holds it), else as [`newer_unlocked`].
fn newer_in_old_dir(old: &std::path::Path) -> Result<Option<i64>, Error> {
    if old.join("meter.lock").symlink_metadata().is_err() {
        return Ok(newer_unlocked(old));
    }
    match paths::try_lock(old) {
        Ok(Some(_held)) => newer_version(&old.join("meter.db")),
        _ => Ok(None),
    }
}

pub fn run(opts: &Options) -> Result<Outcome, Error> {
    let started = Instant::now();
    let deadline = started + opts.budget;
    let mkdir_err = |e: std::io::Error| {
        Error(format!(
            "cannot create the state directory {}: {e}",
            opts.state_dir.display()
        ))
    };
    paths::ensure_dir(&opts.state_dir).map_err(mkdir_err)?;
    let db_path = opts.state_dir.join("meter.db");
    // A store from a newer meter is refused before anything is made, the lock file included.
    // With no lock file no sync is writing (every meter makes its lock file before it writes): the
    // store is read as it lies, and the answer counts only if no lock file appeared meanwhile.
    if !paths::move_unfinished(&opts.state_dir)
        && let Some(v) = newer_unlocked(&opts.state_dir)
    {
        return Ok(Outcome::NewerSchema { store: v });
    }
    let Some(_lock) = paths::try_lock(&opts.state_dir).map_err(|e| {
        Error(format!(
            "cannot take the lock in {}: {e}",
            opts.state_dir.display()
        ))
    })?
    else {
        return Ok(Outcome::Locked);
    };
    // Under the lock nothing else writes here. A newer store, here or in the old directory, is
    // refused before the move runs: the move can settle markers and copy files.
    if !paths::move_unfinished(&opts.state_dir)
        && let Some(v) = newer_version(&db_path)?
    {
        return Ok(Outcome::NewerSchema { store: v });
    }
    if let Some(old) = &opts.migrate_from
        && !db_path.exists()
        && let Some(v) = newer_in_old_dir(old)?
    {
        return Ok(Outcome::NewerSchema { store: v });
    }
    // The move runs under the lock and before `prepare`, which creates an empty database.
    let mut old_generation = None;
    if let Some(old) = &opts.migrate_from {
        let m = paths::migrate(old, &opts.state_dir).map_err(|e| {
            Error(format!(
                "cannot move the state from {} to {}: {e}; files already moved are in {}, the rest are still in {}",
                old.display(),
                opts.state_dir.display(),
                opts.state_dir.display(),
                old.display()
            ))
        })?;
        if m.busy {
            return Ok(Outcome::Locked);
        }
        // Files the move cannot prove are its own sit in the state directory: creating or
        // opening a store beside them could replay or delete another generation's log.
        if m.stop {
            return Ok(Outcome::Blocked);
        }
        // An earlier run's move left the old copies as the recoverable generation: they go once
        // this sync succeeds, never in the run that copied them.
        old_generation = m.old_generation.then_some(old);
    }
    // Read before anything writes: the version decides whether this run may open the store at
    // all, and whether it must keep a generation first. (A store the move just brought in is read
    // here for the first time.)
    let peek = crate::store::peek(&db_path)?;
    if let Some(p) = &peek
        && p.version > SCHEMA_VERSION
    {
        return Ok(Outcome::NewerSchema { store: p.version });
    }
    let now = opts.now_ms;
    // The import window. Widening it (or --backfill) re-imports: rows are a projection.
    let stored = peek.as_ref().and_then(|p| p.counted_from_ms);
    // A store older than 2 (row ids without precision) is rebuilt once over its window: the reset
    // drops every old row in the same transaction, so no doc counts a token twice. A schema 2
    // store is migrated in place, every row kept (RFC 0021 delivery 5).
    let outdated = peek.as_ref().is_some_and(|p| p.version < 2);
    let migrate = peek.as_ref().is_some_and(|p| p.version < SCHEMA_VERSION);
    // A schema 3 store an older build wrote has rollups to re-key with their reason: a rewrite of
    // its rows, so it keeps a counted generation first, as a migration does (RFC 0018 (d)).
    let rekey = peek.as_ref().is_some_and(|p| p.needs_rekey);
    // A store that holds less than the default window (one filled when the default was 14 days)
    // widens once on its own: the installed trigger runs a plain `sync`.
    let wanted = if opts.backfill {
        0
    } else {
        let days = opts.days.unwrap_or(DEFAULT_DAYS).max(1);
        day_start(now - days * DAY_MS + DAY_MS)
    };
    let reset_from = match stored {
        None => Some(wanted),
        Some(s) if wanted < s || outdated => Some(wanted.min(s)),
        Some(_) => None,
    };
    // A reset, or the evidence tables' first creation over a full store (RFC 0018 (d)), is
    // destructive when the store holds any row, whatever its window says.
    let holds_rows = peek.as_ref().is_some_and(|p| p.has_rows);
    let destructive = (reset_from.is_some() || migrate || rekey) && holds_rows;
    let reimported = reset_from.is_some() && (stored.is_some() || holds_rows);
    // Writing to an existing store's schema (a reset, or the index an older store lacks) needs at
    // least twice the store's size free; without it nothing changes. A rebuild, a backfill or a
    // migration also needs room for what the logs still to import will add, so a disk that
    // would fill mid-run is refused up front.
    let needs_index = peek.as_ref().is_some_and(|p| !p.has_repo_index);
    if destructive || needs_index {
        let size: u64 = ["meter.db", "meter.db-wal"]
            .iter()
            .filter_map(|f| opts.state_dir.join(f).metadata().ok())
            .map(|m| m.len())
            .sum();
        let growth = if destructive {
            let offsets = match reset_from {
                Some(_) => None,
                None => Some(crate::store::imported_offsets(&db_path)?),
            };
            projected_growth(
                opts,
                reset_from.or(stored).unwrap_or(wanted),
                offsets.as_ref(),
            )
        } else {
            0
        };
        let needed = size.saturating_mul(2).saturating_add(growth);
        let free = match opts.free_bytes {
            Some(f) => f,
            None => paths::free_bytes(&opts.state_dir).map_err(|e| {
                Error(format!(
                    "cannot tell how much space is free in {}, so the store is not migrated: {e}",
                    opts.state_dir.display()
                ))
            })?,
        };
        if free < needed {
            return Ok(Outcome::NoSpace {
                free,
                needed,
                growth,
            });
        }
    }
    // Before a reset drops a store's rows, a generation that holds every row, checked by count.
    let mut generation = None;
    if let (Some(p), true) = (&peek, destructive) {
        let g = crate::store::write_generation(&db_path, p.version, now).map_err(|e| {
            Error(format!(
                "the store was not migrated: its generation could not be kept ({e})"
            ))
        })?;
        // One generation is kept: the newest, now that it is verified.
        for old in crate::store::generations(&opts.state_dir) {
            if old != g.path {
                crate::store::remove_generation(&old).map_err(|e| {
                    Error(format!(
                        "cannot remove the older generation {}: {e}",
                        old.display()
                    ))
                })?;
            }
        }
        generation = Some(g);
    }
    // Everything from here writes the store. A run that fails puts back the generation it kept
    // (or the one kept beside a re-import still in progress), so a failed rebuild never leaves a
    // store with fewer rows than before.
    let made = generation
        .as_ref()
        .map(|g: &crate::store::Generation| g.path.clone());
    let ran = (|| -> Result<Outcome, Error> {
        let db = paths::prepare(&opts.state_dir).map_err(mkdir_err)?;
        let trace = Trace::new();
        let mut store = Store::open(&db)?;
        let prices = PriceTable::load(&opts.state_dir.join("prices.json")).map_err(Error)?;
        // One transaction: the schema 3 tables and columns, the branch_basis backfill and the new
        // version, or (older than 2) the reset with them.
        if migrate {
            store
                .migrate(now, reset_from.filter(|_| outdated))
                .map_err(Error)?;
        }
        let rekeyed = if rekey {
            crate::store::rekey_reasons(&store.conn)?
        } else {
            (0, 0)
        };
        let counted_from = match reset_from {
            Some(from) if migrate && outdated => from,
            Some(from) => {
                store.reset_at(from, evidence::retention_cut(now))?;
                from
            }
            None => stored.unwrap_or(wanted),
        };
        // A run that migrated or re-keyed always goes on: it reports that and its generation.
        if !opts.force && !reimported && !migrate && !rekey {
            let last = store.meta_i64("last_success_ms")?;
            let pending = store.meta_i64("last_pending_bytes")?.unwrap_or(0);
            if let Some(last) = last
                && pending == 0
                && now - last < opts.stale_ms
                && now >= last
            {
                return Ok(Outcome::Fresh { age_ms: now - last });
            }
        }
        // Before any log is read: the tables `usagemeter outcomes` reads, and where the recorded
        // tool failures start (issue 899). A read never makes them.
        record::ensure(&mut store.conn, now, counted_from)?;

        trace.mark("open");
        let mut hc = if opts.use_hc {
            Hc::connect(Duration::from_secs(3))
        } else {
            None
        };
        let core = hc.as_mut().and_then(|h| h.core_id());
        let machine = machine_id(&store, core.as_deref())?;
        // None when hc did not answer: then no launch is taken for gone.
        let listed = match hc.as_mut() {
            Some(h) => h.terminals_listed(),
            None => opts.snapshot.clone(),
        };
        let answered = listed.is_some();
        let snapshot = listed.unwrap_or_default();
        // Rows of another core are skipped: with hc away, the core this store last saw stands in.
        let core = match core {
            Some(c) => Some(c),
            None => store.meta("machine")?,
        };
        let key = store.session_key()?;
        let this_core = core.clone();
        let snap = Snapshot::of(&store, core.as_deref(), &snapshot, answered, now)?;
        let headers = dsh_headers(&store)?;
        let mut attr = Attributor {
            machine: machine.clone(),
            resolver: resolver(opts, core, snapshot, key.clone(), &snap, &store)?,
            repos: HashMap::new(),
            resolve: opts.resolve_repos,
            now_ms: now,
            key,
            fail_writes_after: opts.fail_writes_after.map(std::cell::Cell::new),
        };
        for ctx in &headers {
            attr.witness(Source::DshTui, ctx);
        }

        trace.mark("hc");
        let mut report = Report {
            counted_from_ms: counted_from,
            reimported,
            machine,
            generation,
            migrated: migrate,
            rekeyed,
            ..Report::default()
        };
        let mut pending_sources: BTreeSet<Source> = BTreeSet::new();
        // Codex first, with at most half the budget: once imported, a run reads a few small tails.
        let codex_limits = ReadLimits {
            chunk_bytes: opts.chunk_bytes,
            max_line: opts.max_line,
            deadline: started + opts.budget / 2,
            chunks_left: opts.chunk_limit.map(std::cell::Cell::new),
        };
        let codex_read = codex_pass(
            opts,
            &mut store,
            &mut attr,
            counted_from,
            &codex_limits,
            &mut report,
            &mut pending_sources,
        )?;
        trace.mark("codex");

        let mut candidates: Vec<Candidate> = Vec::new();
        scan::discover(&opts.omp_root, Source::Omp, &mut candidates);
        scan::discover(&opts.claude_root, Source::Claude, &mut candidates);
        scan::discover(&opts.dsh_root, Source::DshTui, &mut candidates);
        scan::discover(&opts.agy_root, Source::Agy, &mut candidates);
        let unread = crate::sources::dsh_tui::unread_generations(&opts.dsh_root);
        store.set_meta("dsh_unread", unread.as_deref().unwrap_or(""))?;
        // Newest first: recent usage is what people look at, and an old backlog can wait a run.
        candidates.sort_by(|a, b| {
            b.mtime_ms
                .cmp(&a.mtime_ms)
                .then_with(|| a.path.cmp(&b.path))
        });
        forks_last(&store, &mut candidates)?;

        report.files_seen += candidates.len();
        let limits = ReadLimits {
            chunk_bytes: opts.chunk_bytes,
            max_line: opts.max_line,
            deadline,
            chunks_left: opts.chunk_limit.map(std::cell::Cell::new),
        };
        let mut stopped_at = candidates.len();
        // The first shape and read failures an agy conversation reported this run.
        let mut agy_shape: Option<String> = None;
        let mut agy_pending: Option<String> = None;
        let mut agy_unreadable: Option<String> = None;

        trace.mark("discover");
        for (i, c) in candidates.iter().enumerate() {
            if limits.exhausted() {
                stopped_at = i;
                break;
            }
            let path = c.path.to_string_lossy().into_owned();
            let prev = store.file(&path)?;
            if prev.is_none() && c.mtime_ms < counted_from {
                continue; // older than the window and never read
            }
            let plan = match scan::plan(c, prev) {
                Ok(p) => p,
                Err(_) => {
                    report.unreadable += 1;
                    continue;
                }
            };
            let (mut state, rewritten) = match plan {
                Plan::Unchanged => continue,
                Plan::Read { state, rewritten } => (*state, rewritten),
            };
            // A fork an older meter read part of has no createdAt in its file context: read it from
            // the header, so its own later calls are never taken for copies.
            if c.source == Source::DshTui && state.ctx.seeded && state.ctx.created_at.is_none() {
                state.ctx.created_at = scan::dsh_header(&c.path).and_then(|h| h.created_at);
            }
            if c.source == Source::Agy {
                match read_agy_into_store(
                    &mut store,
                    &mut attr,
                    &mut state,
                    rewritten,
                    &limits,
                    counted_from,
                    now,
                    &mut report,
                    &mut agy_shape,
                    &mut agy_pending,
                    &mut agy_unreadable,
                ) {
                    Ok(outcome) => {
                        if outcome.stopped {
                            report.stopped_by_budget = true;
                            report.pending_bytes += c.size.saturating_sub(state.offset);
                            report.pending_files += 1;
                            pending_sources.insert(c.source);
                            stopped_at = i + 1;
                            break;
                        }
                    }
                    Err(e) => match store_failure(&e) {
                        Some(err) => return Err(err),
                        None => report.unreadable += 1,
                    },
                }
                continue;
            }
            let res = read_into_store(
                &mut store,
                &mut attr,
                &mut state,
                c.source,
                rewritten,
                &limits,
                counted_from,
                now,
                &mut report,
            );
            match res {
                Ok(outcome) => {
                    if outcome.stopped {
                        report.stopped_by_budget = true;
                        report.pending_bytes += c.size.saturating_sub(state.offset);
                        report.pending_files += 1;
                        pending_sources.insert(c.source);
                        stopped_at = i + 1;
                        break;
                    }
                }
                // A log that cannot be read is counted and skipped; a store that cannot be written
                // ends the run (RFC 0018 (d): never a partial count reported as complete).
                Err(e) => match store_failure(&e) {
                    Some(err) => return Err(err),
                    None => report.unreadable += 1,
                },
            }
        }
        for c in &candidates[stopped_at..] {
            let prev = store.file(&c.path.to_string_lossy())?;
            let offset = match &prev {
                Some(p)
                    if p.dev == c.dev
                        && p.ino == c.ino
                        && p.size == c.size
                        && p.mtime_ms == c.mtime_ms =>
                {
                    continue;
                }
                Some(p) if p.dev == c.dev && p.ino == c.ino && c.size >= p.offset => p.offset,
                None if c.mtime_ms < counted_from => continue,
                _ => 0,
            };
            if c.size > offset {
                report.stopped_by_budget = true;
                report.pending_bytes += c.size - offset;
                report.pending_files += 1;
                pending_sources.insert(c.source);
            }
        }

        trace.mark("read");
        report.evidence_backfill =
            evidence_backfill(opts, &mut store, &mut attr, counted_from, &limits, now)?;
        trace.mark("evidence backfill");
        // The launches and links this run derived, what the snapshot showed, and the calls whose
        // attribution they change; then the recompute, under what is left of the budget.
        let cwds = evidence::cwds(&store.conn)?;
        attr.resolver.look_above(cwds.iter().map(String::as_str));
        links_pass(&mut store, &mut attr, &snap, now, &mut report)?;
        // How each launch's terminal ended (hc's list of finished terminals first, then what an
        // `end` row copied) and the pull requests the ledgers record (issue 899).
        let hc_ends = if record::ends_wanted(&store.conn)? {
            match hc.as_mut() {
                Some(h) => h.ends(),
                None => opts.ends.clone(),
            }
        } else {
            None
        };
        let mut ends: Vec<record::End> = hc_ends.iter().flatten().map(record::End::of_hc).collect();
        ends.extend(
            attr.resolver
                .end_details()
                .iter()
                .map(record::End::of_ledger),
        );
        let prs = attr.resolver.pr_rows().to_vec();
        let mut pr_repos = Vec::with_capacity(prs.len());
        for p in &prs {
            // The repo of the project folder, as a call's cwd gets it: never an address from a row.
            pr_repos.push((p, attr.repo(&store, Some(&p.project))?));
        }
        {
            let tx = store.conn.transaction()?;
            record::record_ends(&tx, this_core.as_deref(), &ends)?;
            record::fold_prs(&tx, &pr_repos, now)?;
            tx.commit()?;
        }
        let (moved, refused, left) = recompute(&mut store, &mut attr, deadline, now)?;
        report.calls_moved = moved;
        report.calls_refused = refused;
        report.attribution_backlog = left;
        if left > 0 {
            eprintln!(
                "meter: {left} sessions or folders still wait for their attribution to be \
             recomputed; the next sync goes on"
            );
        }
        {
            let tx = store.conn.transaction()?;
            let p = evidence::prune(&tx, now, evidence::EVIDENCE_DAYS, evidence::EVIDENCE_BYTES)?;
            record::prune(&tx, now)?;
            tx.commit()?;
            report.evidence_pruned = p.evidence;
        }
        for p in attr.resolver.oversized() {
            eprintln!(
                "meter: {} is larger than {} MiB, so it was not read; the usage it would tag has no \
             bot",
                p.display(),
                crate::ledger::LEDGER_CAP >> 20
            );
        }
        report.bytes_read += attr.resolver.bytes_read();
        trace.mark("attribution");
        // Kept in the store, so status, the doc and the query can say why usage has no bot: the
        // sidebar's background sync drops stderr. A run that resolved nothing and refused nothing
        // looked for no project ledger, so it keeps the last run's count.
        let refused = attr.resolver.refused().len();
        if refused > 0 || attr.resolver.resolved() > 0 {
            store.set_meta(LEDGERS_REFUSED, &refused.to_string())?;
        }
        for p in attr.resolver.refused() {
            eprintln!(
                "meter: {} is group- or world-writable, so anyone could have written who plays which \
             bot; it was not read. Check its rows, then make it the owner's alone: chmod 600 {}",
                p.display(),
                p.display()
            );
        }
        store.set_meta("last_run_ms", &now.to_string())?;
        record::stamp(&store.conn, now)?;
        store.set_meta("last_pending_bytes", &report.pending_bytes.to_string())?;
        store.set_meta("last_pending_files", &report.pending_files.to_string())?;
        // A harness whose log folder does not exist is absent on this machine: nothing to count, and
        // no success to stamp. (Codex records its own status in `codex_pass`.)
        for (s, root) in [
            (Source::Omp, &opts.omp_root),
            (Source::Claude, &opts.claude_root),
        ] {
            let status = if root.is_dir() { "ok" } else { "absent" };
            store.set_meta(&format!("{}_status", s.harness()), status)?;
        }
        dsh_tui_health(&store, &opts.dsh_root, now)?;
        agy_health(
            &store,
            &opts.agy_root,
            agy_shape,
            agy_pending,
            agy_unreadable,
        )?;
        for s in Source::ALL {
            let absent = match s {
                Source::Omp => !opts.omp_root.is_dir(),
                Source::Claude => !opts.claude_root.is_dir(),
                Source::Codex => !codex_read,
                Source::DshTui => !opts.dsh_root.is_dir(),
                Source::Agy => !opts.agy_root.is_dir(),
            };
            if !pending_sources.contains(&s) && !absent {
                store.mark_success(s.harness(), now)?;
            }
        }
        if report.pending_bytes == 0 {
            store.set_meta("last_success_ms", &now.to_string())?;
            // A later sync that succeeded on the migrated store: its generation has done its job.
            if !reimported && !migrate && !rekey {
                for g in crate::store::generations(&opts.state_dir) {
                    match crate::store::remove_generation(&g) {
                        Ok(()) => report.generations_removed.push(g),
                        Err(e) => eprintln!(
                            "meter: the generation {} was not removed: {e}; the next successful \
                         sync tries again",
                            g.display()
                        ),
                    }
                }
            }
            if let Some(old) = old_generation
                && let Err(e) = paths::drop_old_generation(old, &opts.state_dir)
            {
                eprintln!(
                    "meter: the old copies in {} were not removed: {e}; the next successful sync \
                 tries again",
                    old.display()
                );
            }
        }

        trace.mark("commit");
        let rows = store.rows_since(counted_from)?;
        let sources = source_health(&store)?;
        let (doc, size) = summary::build(
            &summary::Input {
                rows: &rows,
                prices: &prices,
                now_ms: now,
                machine: &report.machine,
                meter_version: env!("CARGO_PKG_VERSION"),
                counted_from_ms: counted_from,
                pending_bytes: report.pending_bytes,
                pending_files: report.pending_files,
                sources: &sources,
            },
            opts.summary_cap,
        );
        trace.mark("summary");
        report.summary_bytes = size;
        if opts.publish {
            report.published = Some(match hc.as_mut() {
                Some(h) => h.doc_put(&opts.doc_name, &doc).map_err(|e| e.to_string()),
                None => Err("hc is not available".into()),
            });
        }
        trace.mark("publish");
        report.summary = Some(doc);
        report.elapsed = started.elapsed();
        Ok(Outcome::Ran(Box::new(report)))
    })();
    match ran {
        Ok(o) => Ok(o),
        Err(e) => {
            let full = e.0.starts_with(NO_ROOM);
            let e = rollback(&opts.state_dir, made.as_deref(), e, opts.fail_restore);
            if full {
                Ok(Outcome::RanOutOfRoom { reason: e.0 })
            } else {
                Err(e)
            }
        }
    }
}

/// After a failed run, the store as it was before it: the generation this run kept, else one kept
/// beside a re-import that has not finished (a store with no watermark), replaces the store, its
/// failed store's files moved aside first (and back, should the generation not go in place) so no
/// frame of the failed store is replayed onto it. Otherwise the
/// store keeps every chunk it committed, each whole, and the next sync goes on.
fn rollback(
    dir: &std::path::Path,
    made: Option<&std::path::Path>,
    e: Error,
    fail_restore: bool,
) -> Error {
    let db = dir.join("meter.db");
    let reimporting = || {
        crate::query::open_read_only(&db, Duration::from_secs(2))
            .ok()
            .and_then(|c| {
                c.query_row(
                    "SELECT count(*) = 0 FROM meta WHERE k = 'last_success_ms'",
                    [],
                    |r| r.get::<_, bool>(0),
                )
                .ok()
            })
            .unwrap_or(false)
    };
    let target = made.map(std::path::Path::to_path_buf).or_else(|| {
        crate::store::generations(dir)
            .pop()
            .filter(|_| reimporting())
    });
    let Some(g) = target.filter(|g| g.exists()) else {
        return Error(format!(
            "{e}; the store keeps what earlier chunks committed, and the next sync goes on"
        ));
    };
    // The failed store's files are moved aside, never deleted, until the generation is in place:
    // if that fails, they come back, so the store is never left unreadable.
    let unit = ["meter.db", "meter.db-wal", "meter.db-shm"];
    let aside = |f: &str| dir.join(format!(".{f}.failed"));
    let put_back = (|| -> io::Result<()> {
        let mut moved = Vec::new();
        let r = (|| -> io::Result<()> {
            for f in unit {
                match std::fs::rename(dir.join(f), aside(f)) {
                    Ok(()) => moved.push(f),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
            if fail_restore {
                return Err(io::Error::other("the generation could not be put in place"));
            }
            std::fs::rename(&g, &db)
        })();
        if let Err(e) = r {
            for f in moved {
                let _ = std::fs::rename(aside(f), dir.join(f));
            }
            return Err(e);
        }
        for f in moved {
            let _ = std::fs::remove_file(aside(f));
        }
        std::fs::File::open(dir)?.sync_all()
    })();
    match put_back {
        Ok(()) => Error(format!(
            "{e}; the store was put back as it was before this rebuild or migration (its \
             generation, every table's rows counted when it was kept)"
        )),
        Err(r) => Error(format!(
            "{e}; the store could not be put back ({r}): its generation is {}",
            g.display()
        )),
    }
}

/// What the store is assumed to grow by per byte of log still to import, evidence included: 1/8,
/// far above what was measured here (a full rebuild of 2.0 GB of logs made a 14.7 MB store, about
/// 1/137). It is an estimate: denser logs can grow the store more, and a run that still runs out
/// of room stops with exit 4 and puts the store back.
pub const GROWTH_PER_LOG_BYTE: u64 = 8;

/// Room for the write-ahead log at its high point: SQLite's checkpoint threshold (1,000 pages)
/// plus two chunks' worth of rows.
pub fn wal_allowance(opts: &Options) -> u64 {
    1000 * 4096 + 2 * opts.chunk_bytes as u64
}

/// The bytes a run that starts at `from_ms` may add to the store: the log bytes it still has to
/// import, divided by [`GROWTH_PER_LOG_BYTE`], plus the [`wal_allowance`]. With `offsets` (a run that keeps the store's rows),
/// a log counts from the offset the store already read it to; without (a reset), every log in the
/// window counts whole. Codex rollouts count by their files. Only file sizes are read.
pub fn projected_growth(
    opts: &Options,
    from_ms: i64,
    offsets: Option<&HashMap<String, u64>>,
) -> u64 {
    let mut logs = Vec::new();
    scan::discover(&opts.omp_root, Source::Omp, &mut logs);
    scan::discover(&opts.claude_root, Source::Claude, &mut logs);
    scan::discover(&opts.dsh_root, Source::DshTui, &mut logs);
    scan::discover(&opts.agy_root, Source::Agy, &mut logs);
    for d in ["sessions", "archived_sessions"] {
        scan::discover(&opts.codex_home.join(d), Source::Codex, &mut logs);
    }
    let mut bytes: u64 = 0;
    for c in &logs {
        let read = offsets.and_then(|o| o.get(c.path.to_string_lossy().as_ref()).copied());
        let left = match read {
            Some(off) => c.size.saturating_sub(off),
            None if c.mtime_ms < from_ms => 0,
            None => c.size,
        };
        bytes = bytes.saturating_add(left);
    }
    bytes
        .div_ceil(GROWTH_PER_LOG_BYTE)
        .saturating_add(wal_allowance(opts))
}

/// The resolver for one sync: the global app home's ledgers, `$HERDR_WORKERS_LEDGER`, the project
/// app homes earlier syncs found, those found above the cwds it is asked about, and what earlier
/// syncs recorded (RFC 0021 (b)). Session ids are hashed with the store's key as they are read.
fn resolver(
    opts: &Options,
    core: Option<String>,
    snapshot: Vec<crate::hc::Terminal>,
    key: SessionKey,
    snap: &Snapshot,
    store: &Store,
) -> Result<Resolver, Error> {
    let mut r = Resolver::new(core, snapshot)
        .walk(opts.project_ledgers)
        .walk_within(opts.walk_within.clone())
        .keyed(key)
        .at(opts.now_ms);
    if let Some(home) = &opts.app_home {
        r.load_app_home(home);
    }
    if let Some(p) = &opts.workers_ledger {
        r.load_workers(p);
    }
    if opts.project_ledgers {
        for h in evidence::known_homes(&store.conn)? {
            r.load_project_home(std::path::Path::new(&h));
        }
    }
    r.add_history(
        &snap.history,
        &evidence::label_history(&store.conn)?,
        &snap.gone_at,
    );
    r.add_session_links(&evidence::session_links(&store.conn)?);
    Ok(r)
}

/// The file context of every dsh-tui session log read so far whose header named a terminal (RFC
/// 0026 (d)): the header's record as the last read left it in the store, so a sync that reads
/// nothing new of a log still knows which terminal its session started in. A recompute then
/// keeps a session whose terminal no launch covers at `no_record`, and links it once a later
/// sync learns that launch, with no log re-read.
fn dsh_headers(store: &Store) -> rusqlite::Result<Vec<crate::sources::FileCtx>> {
    let mut st = store
        .conn
        .prepare("SELECT ctx FROM files WHERE source = ?1 ORDER BY path")?;
    let rows = st.query_map([Source::DshTui.harness()], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for ctx in rows {
        if let Ok(ctx) = serde_json::from_str::<crate::sources::FileCtx>(&ctx?)
            && ctx.terminal.is_some()
        {
            out.push(ctx);
        }
    }
    Ok(out)
}

/// What this sync's hc snapshot says about the launches earlier syncs saw.
struct Snapshot {
    history: Vec<evidence::History>,
    /// Launches an earlier sync saw live that hc no longer lists: launch key to this sync's time,
    /// when they end (`gone`).
    gone_at: HashMap<String, i64>,
    /// The same launches, to the last sync that saw them (`gone_after`).
    gone_after: HashMap<String, i64>,
    /// What hc shows live now, per launch key.
    seen: Vec<evidence::Seen>,
    /// A fingerprint of what hc showed, for skipping an unchanged diff.
    print: String,
}

impl Snapshot {
    fn of(
        store: &Store,
        core: Option<&str>,
        terminals: &[crate::hc::Terminal],
        answered: bool,
        now: i64,
    ) -> rusqlite::Result<Snapshot> {
        let history = evidence::history(&store.conn)?;
        let listed: std::collections::HashSet<(&str, i64)> = terminals
            .iter()
            .filter_map(|t| Some((t.terminal.as_str(), t.created_ms?)))
            .collect();
        let (mut gone_at, mut gone_after) = (HashMap::new(), HashMap::new());
        if answered {
            for h in &history {
                if let (Some(last), None) = (h.seen_last, h.valid_to)
                    && !listed.contains(&(h.terminal.as_str(), h.created_ms))
                {
                    gone_at.insert(h.lkey.clone(), now);
                    gone_after.insert(h.lkey.clone(), last);
                }
            }
        }
        let mut seen = Vec::new();
        let mut print = sha2::Sha256::new();
        use sha2::Digest;
        for t in terminals {
            print.update(format!(
                "{}\x1f{:?}\x1f{:?}\x1f{:?}\x1f{:?}\x1f{:?}\x1e",
                t.terminal, t.created_ms, t.finished_ms, t.harness, t.cwd, t.labels
            ));
            let (Some(created), Some(h), true) = (t.created_ms, t.harness, t.live()) else {
                continue;
            };
            let agent = crate::ledger::agent_of(h).map(str::to_owned);
            for c in [core, None] {
                seen.push(evidence::Seen {
                    lkey: crate::ledger::launch_key(c, &t.terminal, created),
                    cwd: t.cwd.clone(),
                    agent: agent.clone(),
                });
            }
        }
        for k in gone_at.keys() {
            print.update(format!("gone\x1f{k}\x1e"));
        }
        Ok(Snapshot {
            history,
            gone_at,
            gone_after,
            seen,
            print: crate::event::hex(&print.finalize()),
        })
    }
}

/// The `meta` key of the last attribution inputs' fingerprint.
const INPUTS_META: &str = "attribution_inputs";

/// The derivation's version, the fingerprint's first input: a sync compares its inputs against the
/// stored fingerprint, so changing what a launch's tags or a session's links are derived from
/// (RFC 0026 delivery 3 added the label claims; delivery 4b made a dsh-tui session label a
/// `session` link) revisits every launch and link once, on the first sync after the upgrade,
/// instead of waiting for a ledger or the snapshot to change.
const DERIVATION: &[u8] = b"dsh-seat-v1\x1e";

/// The fingerprint of what the launches and links are derived from: the derivation's version,
/// what hc showed, each ledger read (its path, size, modification time and first bytes), the
/// project app homes found, and the dsh-tui header records known (`witnesses`,
/// [`Resolver::witness_print`]: empty for none). The last makes a sync whose only news is a
/// dsh-tui log write that session's link.
fn inputs_print(
    derivation: &[u8],
    snapshot: &str,
    files: &[PathBuf],
    homes: &[String],
    witnesses: &str,
) -> String {
    use sha2::Digest;
    let mut print = sha2::Sha256::new();
    print.update(derivation);
    print.update(snapshot.as_bytes());
    for f in files {
        print.update(f.to_string_lossy().as_bytes());
        if let Ok(m) = f.metadata() {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            print.update(format!("\x1f{}\x1f{mtime}", m.len()));
        }
        if let Ok(mut fh) = std::fs::File::open(f) {
            use std::io::Read;
            let mut head = [0u8; 4096];
            let n = fh.read(&mut head).unwrap_or(0);
            print.update(&head[..n]);
        }
        print.update([0x1e]);
    }
    for h in homes {
        print.update(h.as_bytes());
    }
    print.update(witnesses.as_bytes());
    crate::event::hex(&print.finalize())
}

/// Writes the launches and links this sync derived and queues the calls they change (RFC 0021
/// (b)), in one transaction. When no ledger changed (its size, modification time and first bytes)
/// and hc showed the same terminals, the diff is skipped: only what the snapshot saw is touched.
fn links_pass(
    store: &mut Store,
    attr: &mut Attributor,
    snap: &Snapshot,
    now: i64,
    report: &mut Report,
) -> Result<(), Error> {
    let homes: Vec<String> = attr
        .resolver
        .homes()
        .iter()
        .map(|h| h.to_string_lossy().into_owned())
        .collect();
    let print = inputs_print(
        DERIVATION,
        &snap.print,
        &attr.resolver.files(),
        &homes,
        &attr.resolver.witness_print(),
    );
    let same = store.meta(INPUTS_META)?.as_deref() == Some(print.as_str());
    let tx = store.conn.transaction()?;
    if same {
        evidence::touch_seen(&tx, &snap.seen, now)?;
    } else {
        let (launches, links) = attr.resolver.records();
        let p = evidence::persist(
            &tx,
            &launches,
            &links,
            &snap.seen,
            &snap.gone_after,
            &homes,
            now,
        )?;
        report.launches_changed = p.launches;
        report.links_changed = p.links;
        tx.execute(
            "INSERT INTO meta(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            [INPUTS_META, print.as_str()],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// The calls in the recompute queue per transaction, at most.
const RECOMPUTE_KEYS: usize = 64;

/// Recomputes the attribution of the calls whose sessions or start folders are queued, moving
/// each changed call's tokens between rollups with its evidence row, one transaction per batch,
/// until the queue is empty or `deadline` passes. Returns the calls moved, the calls refused (no
/// rollup row held them, so moving one would count it twice) and what is left.
fn recompute(
    store: &mut Store,
    attr: &mut Attributor,
    deadline: Instant,
    now: i64,
) -> Result<(u64, u64, i64), Error> {
    let (mut moved, mut refused) = (0u64, 0u64);
    while Instant::now() < deadline {
        let keys = evidence::dirty_batch(&store.conn, RECOMPUTE_KEYS)?;
        if keys.is_empty() {
            break;
        }
        let mut done = std::collections::HashSet::new();
        let mut changes = Vec::new();
        // The tool failures of the same sessions and folders move with their calls.
        let mut errors_done = std::collections::HashSet::new();
        let mut error_changes = Vec::new();
        for k in &keys {
            for c in evidence::calls_of(&store.conn, k)? {
                if !done.insert(c.id) {
                    continue;
                }
                let to = attr.rederive(&c);
                if to != c.actor {
                    changes.push((c, to));
                }
            }
            for e in record::errors_of(&store.conn, k)? {
                if !errors_done.insert(e.id) {
                    continue;
                }
                let to = attr.rederive_error(&e);
                if to != e.actor {
                    error_changes.push((e.id, to));
                }
            }
        }
        let r = (|| -> rusqlite::Result<u64> {
            let tx = store.conn.transaction()?;
            let mut n = 0;
            for (c, to) in &changes {
                if evidence::reattribute(&tx, &mut store.intern, c, to, now)? {
                    n += 1;
                }
            }
            for (id, to) in &error_changes {
                record::reattribute(&tx, &mut store.intern, *id, to)?;
            }
            {
                let mut del = tx.prepare_cached("DELETE FROM ev_dirty WHERE k = ?1")?;
                for k in &keys {
                    del.execute([k])?;
                }
            }
            tx.commit()?;
            Ok(n)
        })();
        match r {
            Ok(n) => {
                moved += n;
                refused += changes.len() as u64 - n;
            }
            Err(e) => {
                store.intern.clear();
                return Err(e.into());
            }
        }
    }
    Ok((moved, refused, evidence::dirty_count(&store.conn)?))
}

/// The evidence backfill (`sync --evidence-backfill --days N`, RFC 0018 (b), now recomputing
/// attribution, RFC 0021 (c)): explicit, bounded by the retention, chunked and resumable, never on a
/// read. It starts at the later of `counted_from` and the start of the day `N - 1` days ago.
///
/// 1. Hours before `evidence_from` have rollups but no evidence. The omp, Claude Code and dsh-tui
///    logs still on disk are re-read from their start, under the run's budget, each file from
///    where the last run stopped (one transaction per chunk, with the file's place); each call of
///    those hours is adopted ([`evidence::adopt`]): it takes its tokens out of the pre-evidence
///    row that counted it, for the row its attribution, derived now, names, and gets its evidence.
///    Totals never change. Codex threads, whose deltas carry no request identity a rerun could
///    tell apart, keep their hours before evidence as they are, and so does usage whose logs are
///    gone.
/// 2. Once every log is read, `evidence_from` moves back to the start, and every session and start
///    folder with evidence from then on is queued for the recompute pass, which re-derives each
///    call's attribution from today's ledgers and labels.
///
/// The start is kept in `meta` until both are done, so a later sync goes on with it.
fn evidence_backfill(
    opts: &Options,
    store: &mut Store,
    attr: &mut Attributor,
    counted_from: i64,
    limits: &ReadLimits,
    now: i64,
) -> Result<Option<Backfilled>, Error> {
    let asked = opts.evidence_backfill.map(|d| {
        (day_start(now) - (d.clamp(1, evidence::EVIDENCE_DAYS) - 1) * DAY_MS).max(counted_from)
    });
    let kept = store.meta_i64(evidence::BACKFILL_META)?;
    let Some(from) = [asked, kept].into_iter().flatten().min() else {
        return Ok(None);
    };
    if kept != Some(from) {
        store.set_meta(evidence::BACKFILL_META, &from.to_string())?;
    }
    let mut out = Backfilled {
        from_ms: from,
        ..Backfilled::default()
    };
    let evidence_from = store.meta_i64(evidence::FROM_META)?.unwrap_or(i64::MAX);
    if from < evidence_from {
        store.conn.execute_batch(evidence::BACKFILL_DDL)?;
        let mut candidates: Vec<Candidate> = Vec::new();
        scan::discover(&opts.omp_root, Source::Omp, &mut candidates);
        scan::discover(&opts.claude_root, Source::Claude, &mut candidates);
        scan::discover(&opts.dsh_root, Source::DshTui, &mut candidates);
        candidates.sort_by(|a, b| a.path.cmp(&b.path));
        forks_last(store, &mut candidates)?;
        for c in &candidates {
            if limits.exhausted() {
                return Ok(Some(out));
            }
            let path = c.path.to_string_lossy().into_owned();
            let cursor: Option<(i64, String)> = store
                .conn
                .query_row(
                    "SELECT offset, ctx FROM ev_backfill WHERE path = ?1",
                    [&path],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            // Done, or last written before the start: it holds no call to adopt.
            if cursor.as_ref().is_some_and(|(o, _)| *o < 0) || c.mtime_ms < from {
                continue;
            }
            let Ok(Plan::Read { state, .. }) = scan::plan(c, None) else {
                continue;
            };
            let mut state = *state;
            if let Some((offset, ctx)) = cursor {
                state.offset = offset as u64;
                state.ctx = serde_json::from_str(&ctx).unwrap_or_default();
            }
            // The tool failures of these lines are not recorded here: they are older than
            // `errors_from`, and the failures never move back with the evidence.
            let read = scan::read_file(&mut state, c.source, limits, |st, events, _, _| {
                attr.witness(c.source, &st.ctx);
                let calls = attr
                    .attribute(store, events, from)
                    .map_err(io::Error::other)?;
                let r = (|| -> rusqlite::Result<(u64, u64)> {
                    let tx = store.conn.transaction()?;
                    let (mut adopted, mut alone) = (0u64, 0u64);
                    for e in &calls {
                        let Some(ev) = &e.evidence else { continue };
                        // A call with evidence already, or none a rerun could tell apart.
                        if e.ts_ms >= evidence_from || e.dedupe_key.is_empty() {
                            continue;
                        }
                        let fresh = tx
                            .prepare_cached("INSERT OR IGNORE INTO ev_backfill_seen(k) VALUES(?1)")?
                            .execute([crate::event::key_hash(&e.dedupe_key)])?;
                        if fresh == 0 {
                            continue;
                        }
                        if evidence::adopt(
                            &tx,
                            &mut store.intern,
                            ev,
                            e.ts_ms,
                            &e.tokens,
                            e.reported_usd,
                            evidence_from,
                            now,
                        )? {
                            adopted += 1;
                        } else {
                            alone += 1;
                        }
                    }
                    tx.execute(
                        "INSERT INTO ev_backfill(path, offset, ctx) VALUES(?1, ?2, ?3)
                         ON CONFLICT(path) DO UPDATE SET offset = excluded.offset,
                           ctx = excluded.ctx",
                        rusqlite::params![
                            st.path,
                            st.offset as i64,
                            serde_json::to_string(&st.ctx).unwrap_or_else(|_| "{}".into())
                        ],
                    )?;
                    tx.commit()?;
                    Ok((adopted, alone))
                })();
                match r {
                    Ok((a, l)) => {
                        out.adopted += a;
                        out.left_alone += l;
                        Ok(())
                    }
                    Err(e) => {
                        store.intern.clear();
                        Err(io::Error::other(e))
                    }
                }
            });
            match read {
                Ok(o) if o.stopped => return Ok(Some(out)),
                Ok(_) => {
                    store.conn.execute(
                        "INSERT INTO ev_backfill(path, offset) VALUES(?1, -1)
                         ON CONFLICT(path) DO UPDATE SET offset = -1",
                        [&path],
                    )?;
                }
                // An unreadable log keeps its hours before evidence; the rest goes on.
                Err(_) => {}
            }
        }
    }
    // Every log was read: evidence starts at the backfill's start, and every call from then is
    // queued for the recompute pass, which re-derives its attribution.
    let tx = store.conn.transaction()?;
    if from < evidence_from {
        // What a rollup of those hours holds beyond its evidence (evidence the size or day bound
        // pruned, that no log could give back: Codex, or a log gone) counts as before evidence,
        // never as attributed with nothing behind it (the Reviewer's L2 on PR 875).
        out.unbacked = evidence::freeze_unbacked(&tx, from, evidence_from, now)?;
        tx.execute(
            "INSERT INTO meta(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            [evidence::FROM_META, &from.to_string()],
        )?;
        tx.execute_batch("DELETE FROM ev_backfill; DELETE FROM ev_backfill_seen;")?;
    }
    evidence::queue_since(&tx, from)?;
    tx.execute("DELETE FROM meta WHERE k = ?1", [evidence::BACKFILL_META])?;
    tx.commit()?;
    out.done = true;
    Ok(Some(out))
}

/// Moves dsh-tui forks behind every other log, oldest fork first, keeping the rest in order: a
/// fork's first rows are copies of calls from the session it was seeded from (DSH does not record
/// which), so reading it after every session it could have copied, its own parent forks included,
/// lets each copied call be counted from its own session's read first. The header is read once
/// per file: after a first read, the file context holds it.
fn forks_last(store: &Store, candidates: &mut Vec<Candidate>) -> rusqlite::Result<()> {
    let mut forks: Vec<(i64, Candidate)> = Vec::new();
    let mut rest: Vec<Candidate> = Vec::with_capacity(candidates.len());
    for c in candidates.drain(..) {
        if c.source != Source::DshTui {
            rest.push(c);
            continue;
        }
        let prev = store.file(&c.path.to_string_lossy())?;
        let header = match prev.as_ref().map(|p| &p.ctx) {
            Some(ctx) if ctx.session.is_some() && !ctx.seeded => None,
            Some(ctx) if ctx.seeded && ctx.created_at.is_some() => Some(scan::DshHeader {
                seeded: true,
                created_at: ctx.created_at,
            }),
            _ => scan::dsh_header(&c.path),
        };
        match header {
            Some(h) if h.seeded => forks.push((h.created_at.unwrap_or(i64::MAX), c)),
            _ => rest.push(c),
        }
    }
    forks.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.path.cmp(&b.1.path)));
    rest.extend(forks.into_iter().map(|(_, c)| c));
    *candidates = rest;
    Ok(())
}

/// Reads one Antigravity conversation from its saved generation cursor. The database is opened
/// read-only; a file whose shape is unknown is named and left uncounted, never counted as zero.
#[allow(clippy::too_many_arguments)]
fn read_agy_into_store(
    store: &mut Store,
    attr: &mut Attributor,
    state: &mut FileState,
    rewritten: bool,
    limits: &ReadLimits,
    counted_from: i64,
    now: i64,
    report: &mut Report,
    agy_shape: &mut Option<String>,
    agy_pending: &mut Option<String>,
    agy_unreadable: &mut Option<String>,
) -> io::Result<ReadOutcome> {
    let (cursor, cursor_ts) = state
        .ctx
        .agy
        .as_ref()
        .map_or((-1, -1), |a| (a.max_gen, a.cursor_ts));
    let read = match crate::sources::agy::read(
        std::path::Path::new(&state.path),
        cursor,
        cursor_ts,
        now,
        limits.deadline,
    ) {
        Ok(r) => r,
        Err(crate::sources::agy::Failure::Shape(why)) => {
            agy_shape.get_or_insert(why);
            report.unreadable += 1;
            return Ok(ReadOutcome::default());
        }
        Err(crate::sources::agy::Failure::Unreadable(why)) => {
            agy_unreadable.get_or_insert(why);
            report.unreadable += 1;
            return Ok(ReadOutcome::default());
        }
    };
    if let Some(why) = read.shape {
        agy_shape.get_or_insert(why);
    } else if read.held > 0 {
        agy_pending.get_or_insert(format!(
            "{} agy generation(s) are still being written, so their usage is not counted yet",
            read.held
        ));
    }
    state.ctx.agy = Some(crate::sources::agy::AgyCtx {
        max_gen: read.max_gen,
        cursor_ts: read.cursor_ts,
    });
    // A stopped read leaves bytes pending; a full one does not. The generation cursor, not the
    // byte offset, is where the next run resumes.
    state.offset = if read.stopped { 0 } else { state.size };
    let health = Health {
        rewrites: i64::from(rewritten),
        ..Health::default()
    };
    let attributed = attr
        .attribute(store, read.events, counted_from)
        .map_err(store_write)?;
    let applied = store
        .apply_agy(state, &attributed, health, now)
        .map_err(store_write)?;
    report.health.add(&applied);
    report.files_read += 1;
    Ok(ReadOutcome {
        bytes: 0,
        stopped: read.stopped,
    })
}

/// Reads one file from its saved state, committing each chunk (rows, offset and, for Codex, the
/// thread's running total) in one transaction, then records the file's final state.
#[allow(clippy::too_many_arguments)]
fn read_into_store(
    store: &mut Store,
    attr: &mut Attributor,
    state: &mut FileState,
    source: Source,
    rewritten: bool,
    limits: &ReadLimits,
    counted_from: i64,
    now: i64,
    report: &mut Report,
) -> io::Result<ReadOutcome> {
    let mut first = true;
    let outcome = scan::read_file(
        state,
        source,
        limits,
        |st: &FileState, events, errors, mut health| {
            if first && rewritten {
                health.rewrites += 1;
            }
            first = false;
            attr.witness(source, &st.ctx);
            let attributed = attr
                .attribute(store, events, counted_from)
                .map_err(store_write)?;
            let errors = attr
                .attribute_errors(store, errors, counted_from)
                .map_err(store_write)?;
            if let Some(n) = &attr.fail_writes_after {
                if n.get() == 0 {
                    return Err(store_write(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
                        Some("database or disk is full (simulated)".into()),
                    )));
                }
                n.set(n.get() - 1);
            }
            let applied = store
                .apply_chunk_with(st, &attributed, &errors, health, now)
                .map_err(store_write)?;
            report.health.add(&applied);
            Ok(())
        },
    )?;
    report.files_read += 1;
    report.bytes_read += outcome.bytes;
    if rewritten && first {
        // Nothing was read (an emptied file): still count the rewrite.
        let h = Health {
            rewrites: 1,
            ..Health::default()
        };
        store.apply_chunk(state, &[], h, now).map_err(store_write)?;
        report.health.add(&h);
    } else {
        store.put_file(state).map_err(store_write)?;
    }
    Ok(outcome)
}

fn set_codex_status(store: &Store, status: &str, reason: &str) -> rusqlite::Result<()> {
    store.set_meta("codex_status", status)?;
    store.set_meta("codex_reason", reason)
}

/// Codex threads changed since the last run: each rollout from where the last run stopped (its
/// tail, once imported), else the thread's `tokens_used` as `total_only`. Returns whether the
/// thread list could be read.
fn codex_pass(
    opts: &Options,
    store: &mut Store,
    attr: &mut Attributor,
    counted_from: i64,
    limits: &ReadLimits,
    report: &mut Report,
    pending: &mut BTreeSet<Source>,
) -> Result<bool, Error> {
    let now = opts.now_ms;
    let Some(db) = codex::state_db(&opts.codex_home) else {
        set_codex_status(store, "absent", "")?;
        return Ok(false);
    };
    let watermark = store.meta_i64("codex_watermark_ms")?;
    let since = watermark.map_or(counted_from, |w| (w - CODEX_SLACK_MS).max(counted_from));
    let (threads, parents) = match codex::read_state(&db, since) {
        State::Threads { threads, parents } => (threads, parents),
        State::Absent => {
            set_codex_status(store, "absent", "")?;
            return Ok(false);
        }
        State::Unsupported(reason) => {
            set_codex_status(store, "unsupported", &reason)?;
            return Ok(false);
        }
        State::Unreadable(reason) => {
            // Try again next run; what was counted stays.
            set_codex_status(store, "degraded", &reason)?;
            return Ok(false);
        }
    };
    report.files_seen += threads.len();
    let mut mark = watermark.unwrap_or(counted_from);
    let mut blocked = false;
    let (mut bad, mut unreadable, mut cache_writes, mut decreases) = (0i64, 0i64, 0i64, 0i64);
    for t in &threads {
        let rollout = codex::resolve_rollout(&opts.codex_home, t.rollout_path.as_deref());
        let c = rollout.as_deref().and_then(scan::candidate_of);
        if blocked || limits.exhausted() {
            blocked = true;
            report.stopped_by_budget = true;
            if let Some(c) = &c {
                let offset = store
                    .file(&c.path.to_string_lossy())?
                    .map_or(0, |f| f.offset);
                report.pending_bytes += c.size.saturating_sub(offset);
            }
            report.pending_files += 1;
            pending.insert(Source::Codex);
            continue;
        }
        let (old_path, cum, counted) = store.codex_thread(&t.id)?.unwrap_or_default();
        let mut ctx = t.ctx(parents.get(&t.id), cum, counted);
        // `complete`: everything the rollout holds is folded into `ctx`.
        let mut complete = rollout.is_none();
        match &c {
            None if rollout.is_some() => unreadable += 1,
            None => {}
            Some(c) => {
                let key = c.path.to_string_lossy().into_owned();
                let mut prev = store.file(&key)?;
                if prev.is_none()
                    && let Some(op) = old_path.as_deref().filter(|op| *op != key)
                    && let Some(mut o) = store.file(op)?
                    && o.dev == c.dev
                    && o.ino == c.ino
                {
                    // Moved (archived) in place: carry the offset over instead of reading again.
                    o.path = key.clone();
                    prev = Some(o);
                }
                match scan::plan(c, prev) {
                    Err(_) => unreadable += 1,
                    Ok(Plan::Unchanged) => complete = true,
                    Ok(Plan::Read { state, rewritten }) => {
                        let mut state = *state;
                        // The running total belongs to the thread, so a rollout read again from
                        // the start (rewritten or copied elsewhere) counts nothing twice.
                        state.ctx.codex = Some(ctx.clone());
                        match read_into_store(
                            store,
                            attr,
                            &mut state,
                            Source::Codex,
                            rewritten,
                            limits,
                            counted_from,
                            now,
                            report,
                        ) {
                            Ok(outcome) => {
                                if let Some(cx) = state.ctx.codex.take() {
                                    ctx = cx;
                                }
                                if outcome.stopped {
                                    blocked = true;
                                    report.stopped_by_budget = true;
                                    report.pending_bytes += c.size.saturating_sub(state.offset);
                                    report.pending_files += 1;
                                    pending.insert(Source::Codex);
                                } else {
                                    complete = true;
                                }
                            }
                            Err(e) => match store_failure(&e) {
                                Some(err) => return Err(err),
                                None => unreadable += 1,
                            },
                        }
                    }
                }
            }
        }
        bad += ctx.bad;
        cache_writes += ctx.cache_writes;
        decreases += ctx.decreases;
        let no_split = rollout.is_none()
            || ctx.bad > 0
            || (ctx.cum.total == 0 && now - t.updated_at_ms > CODEX_IDLE_MS);
        if complete && no_split && t.tokens_used > ctx.counted {
            let tokens = Tokens {
                unsplit: t.tokens_used - ctx.counted,
                ..Tokens::default()
            };
            ctx.counted = t.tokens_used;
            let e = codex::event(&ctx, t.updated_at_ms, tokens, Precision::TotalOnly);
            let attributed = attr.attribute(store, vec![e], counted_from)?;
            let h = Health {
                usage_lines: 1,
                ..Health::default()
            };
            let applied = store.apply_codex(&ctx, &attributed, h, now)?;
            report.health.add(&applied);
        }
        if !blocked {
            mark = mark.max(t.updated_at_ms);
        }
    }
    if Some(mark) != watermark {
        store.set_meta("codex_watermark_ms", &mark.to_string())?;
    }
    let total_bad = store.meta_i64("codex_bad_lines")?.unwrap_or(0) + bad;
    store.set_meta("codex_bad_lines", &total_bad.to_string())?;
    let mut reasons = Vec::new();
    if total_bad > 0 {
        reasons.push(format!(
            "{total_bad} token_count lines in an unknown format; their threads count as total_only"
        ));
    }
    if unreadable > 0 {
        reasons.push(format!("{unreadable} rollouts could not be read"));
    }
    if decreases > 0 {
        reasons.push(format!(
            "{decreases} running totals went down; counted as 0"
        ));
    }
    let degraded = !reasons.is_empty();
    if cache_writes > 0 {
        reasons.push(format!(
            "{cache_writes} lines have cache_write_input_tokens, counted as uncached input"
        ));
    }
    set_codex_status(
        store,
        if degraded { "degraded" } else { "ok" },
        &reasons.join("; "),
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests;
