//! The per-machine SQLite store (WAL).
//!
//! - `usage`: `ae/1` (revision 3) `agent.usage` rows, one per rollup key, hour and precision,
//!   upserted on their id. The `ae_usage` view renders each row as an `ae/1` envelope: an exact
//!   row carries the split fields, a total_only row carries `unsplit` alone.
//! - `files`: how far each log has been read, plus what identifies it (device, inode, size, a hash
//!   of its first bytes) so a rewritten or truncated file is noticed.
//! - `seen`: every dedupe-key hash counted since `counted_from`, never evicted, so a log read
//!   again from the start, or a message a resumed session copies, adds nothing already counted.
//!   It lives on disk, so it costs bytes, not memory; a reset clears it with the rows.
//! - `sessions`: which harness session a sub-agent transcript rolls up to.
//! - `codex_threads`: the last cumulative token count seen per Codex thread, keyed by thread id
//!   so a rollout that moves (to `archived_sessions`) is never counted twice.
//!
//! - Schema 3 adds per-call evidence, the `launch` and `link` tables and the attribution columns
//!   of `usage` ([`crate::evidence`]).
//! - Still schema 3, added in place by `sync`: `ev_error`, `pr` and how a launch's terminal ended
//!   ([`crate::outcomes::record`], issue 899), for `usagemeter outcomes`.
//!
//! Every chunk of a log is applied in one transaction that adds its usage and its evidence,
//! records its keys and advances the file's offset, so a killed run leaves either all of a chunk
//! or none of it.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::event::{Precision, RollupAttr, RollupKey, Tokens, key_hash};
use crate::evidence::{self, Evidence, Interner};
use crate::outcomes::record;
use crate::sources::FileCtx;
use crate::sources::codex::{CodexCtx, Cum};

/// 3: per-call evidence, the `launch` and `link` tables, and the attribution columns of `usage`
/// (RFC 0021 delivery 5). A schema 2 store is migrated in place by `sync` ([`Store::migrate`]),
/// every row kept, after a generation. 2: precision is part of the row id (`ae/1` revision 3); a
/// store older than 2 is rebuilt from the logs (`sync` resets it), because every row id changed.
pub const SCHEMA_VERSION: i64 = 3;

pub struct Store {
    pub conn: Connection,
    pub intern: Interner,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileState {
    pub path: String,
    pub source: String,
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mtime_ms: i64,
    pub offset: u64,
    /// Bytes before the hashed head (omp rewrites its first line, the title, in place).
    pub head_skip: u64,
    pub head_len: u64,
    pub head_hash: String,
    pub ctx: FileCtx,
    pub rewrites: i64,
}

/// What one chunk adds to a source's parser health.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Health {
    pub usage_lines: i64,
    pub events: i64,
    pub duplicates: i64,
    pub skipped_lines: i64,
    pub rewrites: i64,
}

impl Health {
    pub fn add(&mut self, o: &Health) {
        self.usage_lines += o.usage_lines;
        self.events += o.events;
        self.duplicates += o.duplicates;
        self.skipped_lines += o.skipped_lines;
        self.rewrites += o.rewrites;
    }
}

/// One event after attribution, ready to be folded into its hourly row.
#[derive(Debug, Clone)]
pub struct Attributed {
    pub dedupe_key: String,
    pub key: RollupKey,
    pub tokens: Tokens,
    pub precision: Precision,
    pub reported_usd: Option<f64>,
    pub session: Option<String>,
    pub parent_session: Option<String>,
    pub ts_ms: i64,
    /// The call's evidence row; `sync` always gives one.
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageRow {
    /// The row's `idempotency_key`.
    pub id: String,
    pub key: RollupKey,
    pub squad: Option<String>,
    pub tokens: Tokens,
    pub precision: String,
    pub reported_usd: Option<f64>,
    pub events: i64,
}

const TABLES: &str = "
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  hour_ms INTEGER NOT NULL,
  bot TEXT, role TEXT, squad TEXT,
  harness TEXT NOT NULL, model TEXT NOT NULL, machine TEXT NOT NULL,
  repo TEXT, branch TEXT,
  input_uncached INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  unsplit INTEGER NOT NULL DEFAULT 0,
  precision TEXT NOT NULL,
  reported_usd REAL,
  events INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_hour ON usage(hour_ms);
CREATE INDEX IF NOT EXISTS usage_repo_branch ON usage(repo, branch, hour_ms);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, source TEXT NOT NULL,
  dev INTEGER NOT NULL, ino INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  offset INTEGER NOT NULL, head_skip INTEGER NOT NULL DEFAULT 0,
  head_len INTEGER NOT NULL, head_hash TEXT NOT NULL,
  ctx TEXT NOT NULL DEFAULT '{}', rewrites INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS seen (k INTEGER PRIMARY KEY, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS seen_seq ON seen(seq);
CREATE TABLE IF NOT EXISTS sessions (
  harness TEXT NOT NULL, session TEXT NOT NULL, parent_session TEXT,
  first_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL,
  PRIMARY KEY (harness, session)
);
CREATE TABLE IF NOT EXISTS cwd_repo (cwd TEXT PRIMARY KEY, repo TEXT, checked_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS health (
  source TEXT PRIMARY KEY,
  last_success_ms INTEGER,
  usage_lines INTEGER NOT NULL DEFAULT 0, events INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0, skipped_lines INTEGER NOT NULL DEFAULT 0,
  rewrites INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS codex_threads (
  id TEXT PRIMARY KEY, path TEXT, cum TEXT NOT NULL, counted INTEGER NOT NULL
);
";

/// Compared with the stored definition on open, and recreated only when it differs.
const VIEW: &str = "CREATE VIEW ae_usage AS SELECT id, json_object(
  'schema', 'ae/1', 'id', id, 'type', 'agent.usage',
  'ts', strftime('%Y-%m-%dT%H:%M:%SZ', hour_ms / 1000, 'unixepoch'),
  'actor', json_object('bot', bot, 'role', role, 'squad', squad, 'harness', harness,
                       'model', model, 'machine', machine),
  'work', json_object('repo', repo, 'branch', branch),
  'trust', 'agent',
  'data', CASE WHEN precision = 'total_only'
    THEN json_object('precision', precision, 'unsplit', unsplit, 'reported_usd', reported_usd)
    ELSE json_object('input_uncached', input_uncached, 'cache_read', cache_read,
                     'cache_write_5m', cache_write_5m, 'cache_write_1h', cache_write_1h,
                     'output', output, 'reasoning', reasoning, 'precision', precision,
                     'reported_usd', reported_usd) END,
  'idempotency_key', id) AS envelope FROM usage";

impl Store {
    /// Opens the store for `sync`, creating it on first use. A store already at this version is
    /// opened without a write: no DDL, no `meta` row, no journal-mode change. Read paths
    /// (`query`, `status`) never call this; they use [`Store::open_read_only`].
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        let conn = Connection::open(path)?;
        Store::init(conn)
    }

    /// Opens an existing store only to read it: no schema setup, no journal-mode change, and no
    /// checkpoint on close, so the database and its wal keep exactly the bytes they had.
    pub fn open_read_only(path: &Path) -> rusqlite::Result<Store> {
        let conn = crate::query::open_read_only(path, std::time::Duration::from_secs(5))?;
        Ok(Store {
            conn,
            intern: Interner::default(),
        })
    }

    pub fn open_in_memory() -> rusqlite::Result<Store> {
        Store::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Store> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") && !mode.eq_ignore_ascii_case("memory") {
            conn.pragma_update(None, "journal_mode", "WAL")?;
        }
        // Per connection, never stored in the file.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        // A new store is made whole in one transaction, at the current version: it holds nothing
        // a migration would have to keep, and another open racing it waits, then finds it made.
        let mut fresh = false;
        if !table_exists(&conn, "usage")? {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let made = (|| -> rusqlite::Result<bool> {
                if table_exists(&conn, "usage")? {
                    return Ok(false);
                }
                conn.execute_batch(TABLES)?;
                add_schema_3(&conn)?;
                // A new store's rollups are keyed with their reason from the start (RFC 0021
                // delivery 6): only a store an older meter made is ever re-keyed.
                conn.execute(
                    "INSERT INTO meta(k, v) VALUES('schema_version', ?1), (?2, ?3), (?4, '1')
                     ON CONFLICT(k) DO NOTHING",
                    [
                        SCHEMA_VERSION.to_string(),
                        evidence::KEY_META.to_string(),
                        evidence::SessionKey::random()
                            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?
                            .to_hex(),
                        evidence::REASON_KEYED_META.to_string(),
                    ],
                )?;
                Ok(true)
            })();
            match made {
                Ok(m) => {
                    conn.execute_batch("COMMIT")?;
                    fresh = m;
                }
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(e);
                }
            }
        }
        // Stores made before `unsplit` existed: add the column before the view that names it.
        if !fresh && !column_exists(&conn, "usage", "unsplit")? {
            conn.execute_batch("ALTER TABLE usage ADD COLUMN unsplit INTEGER NOT NULL DEFAULT 0")?;
        }
        if !schema_complete(&conn)? {
            conn.execute_batch(TABLES)?;
        }
        // Stores made before `head_skip` existed.
        if !column_exists(&conn, "files", "head_skip")? {
            conn.execute_batch(
                "ALTER TABLE files ADD COLUMN head_skip INTEGER NOT NULL DEFAULT 0",
            )?;
        }
        // A schema 3 store a meter before RFC 0021 delivery 6 wrote lacks the rollup columns added
        // since (`reason`): add them in place, at the same version. Its rows keep their ids and
        // read as they were (a null reason is `no_record` or `claimants_differ` by its state).
        if !fresh && table_exists(&conn, "evidence")? {
            for (col, ty) in evidence::USAGE_COLUMNS {
                if !column_exists(&conn, "usage", col)? {
                    conn.execute_batch(&format!("ALTER TABLE usage ADD COLUMN {col} {ty}"))?;
                }
            }
        }
        let view: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'ae_usage'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if view.as_deref() != Some(VIEW) {
            // One transaction: a second open racing this one waits, then replaces it whole.
            conn.execute_batch(&format!(
                "BEGIN IMMEDIATE; DROP VIEW IF EXISTS ae_usage; {VIEW}; COMMIT;"
            ))?;
        }
        // An older store without a version stays without one, so `sync` sees it is outdated and
        // keeps a generation before it resets it.
        let s = Store {
            conn,
            intern: Interner::default(),
        };
        Ok(s)
    }

    /// Brings a store older than this meter to [`SCHEMA_VERSION`] in one write transaction (RFC
    /// 0018 (d)); `sync` alone calls it, under the lock, after the free-space check and the
    /// generation. With `reset` (a store older than 2, whose row ids all changed) every row and
    /// offset is dropped and the window starts there; otherwise (schema 2) every row is kept: the
    /// columns and tables of schema 3 are added, `branch_basis` is backfilled on the old rollups
    /// (`log` where a branch is recorded, `none` where it is null), and their `actor_state` stays
    /// null, so their tags are frozen and never counted as attributed. Evidence starts at the next
    /// hour: every rollup of an hour from then on is the evidence's. Before it commits, every table
    /// the store had holds as many rows as before (or none, on a reset); else nothing changes.
    pub fn migrate(&mut self, now_ms: i64, reset: Option<i64>) -> Result<(), String> {
        let cut = evidence::retention_cut(now_ms);
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("cannot start the migration: {e}"))?;
        let db = |e: rusqlite::Error| {
            if no_room(&e) {
                format!("{NO_ROOM}: the migration failed: {e}")
            } else {
                format!("the migration failed: {e}")
            }
        };
        let before = row_counts(&tx).map_err(db)?;
        add_schema_3(&tx).map_err(db)?;
        let evidence_from = match reset {
            Some(from) => {
                clear(&tx, from).map_err(db)?;
                from.max(cut)
            }
            None => {
                tx.execute(
                    "UPDATE usage SET branch_basis = CASE WHEN branch IS NULL THEN 'none'
                       ELSE 'log' END
                     WHERE actor_state IS NULL AND branch_basis IS NULL",
                    [],
                )
                .map_err(db)?;
                crate::time::hour_start(now_ms) + crate::time::HOUR_MS
            }
        };
        let put = |k: &str, v: &str| {
            tx.execute(
                "INSERT INTO meta(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                [k, v],
            )
        };
        put(evidence::FROM_META, &evidence_from.to_string()).map_err(db)?;
        let has_key: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM meta WHERE k = ?1)",
                [evidence::KEY_META],
                |r| r.get(0),
            )
            .map_err(db)?;
        if !has_key {
            let key = evidence::SessionKey::random()
                .map_err(|e| format!("cannot make the store's hash key: {e}"))?;
            put(evidence::KEY_META, &key.to_hex()).map_err(db)?;
        }
        put("schema_version", &SCHEMA_VERSION.to_string()).map_err(db)?;
        // Every rollup this meter writes is keyed with its reason: nothing to re-key later.
        put(evidence::REASON_KEYED_META, "1").map_err(db)?;
        if reset.is_none() {
            let after = row_counts(&tx).map_err(db)?;
            for (table, n) in &before {
                // `meta` gains the version's keys; every other table keeps its rows.
                if table != "meta" && after.get(table) != Some(n) {
                    return Err(format!(
                        "the migration would change {table}'s rows ({n} before, {:?} after), so \
                         nothing was changed",
                        after.get(table)
                    ));
                }
            }
        }
        tx.commit().map_err(db)?;
        self.intern.clear();
        Ok(())
    }

    /// The store's key for session and request hashes.
    pub fn session_key(&self) -> rusqlite::Result<evidence::SessionKey> {
        if let Some(k) = self
            .meta(evidence::KEY_META)?
            .as_deref()
            .and_then(evidence::SessionKey::from_hex)
        {
            return Ok(k);
        }
        let k = evidence::SessionKey::random()
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        self.set_meta(evidence::KEY_META, &k.to_hex())?;
        Ok(k)
    }

    pub fn meta(&self, k: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0))
            .optional()
    }

    pub fn meta_i64(&self, k: &str) -> rusqlite::Result<Option<i64>> {
        Ok(self.meta(k)?.and_then(|v| v.parse().ok()))
    }

    pub fn set_meta(&self, k: &str, v: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO meta(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            [k, v],
        )?;
        Ok(())
    }

    /// Drops every row and offset so the next read imports again from `counted_from`, and marks
    /// the store as the current version. It also forgets when the last run finished and what it
    /// left: until a run over the new window ends, a reader sees no watermark and an unknown
    /// backlog, never a partial re-import passed off as complete and fresh.
    /// The evidence goes with the rows (the re-import writes it again) and starts at the new
    /// window; the `launch` and `link` tables stay: they hold what only past syncs saw.
    pub fn reset(&mut self, counted_from_ms: i64) -> rusqlite::Result<()> {
        self.reset_at(counted_from_ms, counted_from_ms)
    }

    /// [`Store::reset`], with evidence starting at `evidence_from_ms` (never before the window):
    /// a re-import writes no evidence a retention bound would drop at once.
    pub fn reset_at(
        &mut self,
        counted_from_ms: i64,
        evidence_from_ms: i64,
    ) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        clear(&tx, counted_from_ms)?;
        tx.execute(
            "INSERT INTO meta(k, v) VALUES('schema_version', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            [SCHEMA_VERSION.to_string()],
        )?;
        tx.execute(
            "INSERT INTO meta(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            [
                evidence::FROM_META,
                &evidence_from_ms.max(counted_from_ms).to_string(),
            ],
        )?;
        tx.commit()?;
        self.intern.clear();
        Ok(())
    }

    pub fn file(&self, path: &str) -> rusqlite::Result<Option<FileState>> {
        self.conn
            .query_row(
                "SELECT path, source, dev, ino, size, mtime_ms, offset, head_len, head_hash, ctx, rewrites, head_skip
                 FROM files WHERE path = ?1",
                [path],
                |r| {
                    let ctx: String = r.get(9)?;
                    Ok(FileState {
                        path: r.get(0)?,
                        source: r.get(1)?,
                        dev: r.get::<_, i64>(2)? as u64,
                        ino: r.get::<_, i64>(3)? as u64,
                        size: r.get::<_, i64>(4)? as u64,
                        mtime_ms: r.get(5)?,
                        offset: r.get::<_, i64>(6)? as u64,
                        head_len: r.get::<_, i64>(7)? as u64,
                        head_hash: r.get(8)?,
                        ctx: serde_json::from_str(&ctx).unwrap_or_default(),
                        rewrites: r.get(10)?,
                        head_skip: r.get::<_, i64>(11)? as u64,
                    })
                },
            )
            .optional()
    }

    pub fn cached_repo(&self, cwd: &str) -> rusqlite::Result<Option<(Option<String>, i64)>> {
        self.conn
            .query_row(
                "SELECT repo, checked_ms FROM cwd_repo WHERE cwd = ?1",
                [cwd],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
    }

    pub fn cache_repo(&self, cwd: &str, repo: Option<&str>, now_ms: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO cwd_repo(cwd, repo, checked_ms) VALUES(?1, ?2, ?3)
             ON CONFLICT(cwd) DO UPDATE SET repo = excluded.repo, checked_ms = excluded.checked_ms",
            params![cwd, repo, now_ms],
        )?;
        Ok(())
    }

    /// Applies one chunk atomically: new usage, its dedupe keys, the file's new offset and the
    /// health counters. Returns how many events were new (not seen before).
    pub fn apply_chunk(
        &mut self,
        file: &FileState,
        events: &[Attributed],
        health: Health,
        now_ms: i64,
    ) -> rusqlite::Result<Health> {
        self.apply_chunk_with(file, events, &[], health, now_ms)
    }

    /// [`Store::apply_chunk`], with the tool failures the chunk's lines flagged (issue 899): they
    /// commit with the file's offset, so a failure is never read twice or skipped. The caller has
    /// run [`record::ensure`] on this store.
    pub fn apply_chunk_with(
        &mut self,
        file: &FileState,
        events: &[Attributed],
        errors: &[record::ErrorRow],
        health: Health,
        now_ms: i64,
    ) -> rusqlite::Result<Health> {
        self.apply(
            Some(file),
            &file.source,
            None,
            events,
            errors,
            health,
            now_ms,
            None,
        )
    }

    /// Applies an Antigravity conversation's chunk. Its rows are re-read while a held row waits,
    /// so a repeat is not a duplicate line and neither the duplicate nor the usage-line counters
    /// grow; `usage_lines` is the number of new usage calls. A late earlier step can change
    /// the call's key, so check its possible previous keys in the same transaction.
    pub fn apply_agy(
        &mut self,
        file: &FileState,
        events: &[Attributed],
        later_step_keys: &HashMap<String, Vec<i64>>,
        health: Health,
        now_ms: i64,
    ) -> rusqlite::Result<Health> {
        self.apply(
            Some(file),
            "agy",
            None,
            events,
            &[],
            health,
            now_ms,
            Some(later_step_keys),
        )
    }

    /// Applies usage that comes with no file (a Codex thread counted from its `tokens_used`) and
    /// the thread's new cumulative, atomically.
    pub fn apply_codex(
        &mut self,
        thread: &CodexCtx,
        events: &[Attributed],
        health: Health,
        now_ms: i64,
    ) -> rusqlite::Result<Health> {
        self.apply(
            None,
            "codex",
            Some(thread),
            events,
            &[],
            health,
            now_ms,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn apply(
        &mut self,
        file: Option<&FileState>,
        source: &str,
        thread: Option<&CodexCtx>,
        events: &[Attributed],
        errors: &[record::ErrorRow],
        health: Health,
        now_ms: i64,
        agy_step_keys: Option<&HashMap<String, Vec<i64>>>,
    ) -> rusqlite::Result<Health> {
        let r = self.apply_tx(
            file,
            source,
            thread,
            events,
            errors,
            health,
            now_ms,
            agy_step_keys,
        );
        if r.is_err() {
            // An id it cached may belong to the rolled-back transaction.
            self.intern.clear();
        }
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_tx(
        &mut self,
        file: Option<&FileState>,
        source: &str,
        thread: Option<&CodexCtx>,
        events: &[Attributed],
        errors: &[record::ErrorRow],
        mut health: Health,
        now_ms: i64,
        agy_step_keys: Option<&HashMap<String, Vec<i64>>>,
    ) -> rusqlite::Result<Health> {
        let quiet_duplicates = agy_step_keys.is_some();
        let tx = self.conn.transaction()?;
        let mut seq: i64 =
            tx.query_row("SELECT coalesce(max(seq), 0) FROM seen", [], |r| r.get(0))?;
        let mut rows: BTreeMap<(RollupKey, Precision), Pending> = BTreeMap::new();
        {
            let mut ins = tx.prepare_cached("INSERT OR IGNORE INTO seen(k, seq) VALUES(?1, ?2)")?;
            let mut sess = tx.prepare_cached(
                "INSERT INTO sessions(harness, session, parent_session, first_ms, last_ms) VALUES(?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(harness, session) DO UPDATE SET
                   parent_session = coalesce(excluded.parent_session, parent_session),
                   first_ms = min(first_ms, excluded.first_ms), last_ms = max(last_ms, excluded.last_ms)",
            )?;
            'event: for e in events {
                if let Some(keys) = agy_step_keys.and_then(|keys| keys.get(&e.dedupe_key)) {
                    // Preserve the original count and leave the new key available for a future call.
                    let mut seen =
                        tx.prepare_cached("SELECT EXISTS(SELECT 1 FROM seen WHERE k = ?1)")?;
                    for key in keys {
                        if seen.query_row([*key], |r| r.get::<_, bool>(0))? {
                            continue 'event;
                        }
                    }
                }
                // Every session with a usage line has its row, a copy of another session's call
                // included (a forked dsh-tui session starts with its parent's): which file is read
                // first then decides only which session a call's tokens go to, never which
                // sessions exist or their first and last times.
                if let Some(s) = &e.session {
                    sess.execute(params![e.key.harness, s, e.parent_session, e.ts_ms])?;
                }
                if !e.dedupe_key.is_empty() {
                    seq += 1;
                    if ins.execute(params![key_hash(&e.dedupe_key), seq])? == 0 {
                        if !quiet_duplicates {
                            health.duplicates += 1;
                        }
                        continue;
                    }
                }
                health.events += 1;
                if let Some(ev) = &e.evidence {
                    evidence::insert(
                        &tx,
                        &mut self.intern,
                        ev,
                        e.ts_ms,
                        &e.tokens,
                        e.reported_usd,
                    )?;
                }
                let entry = rows.entry((e.key.clone(), e.precision)).or_default();
                if e.key.squad.is_some() {
                    entry.squad.clone_from(&e.key.squad);
                }
                entry.tokens.add(&e.tokens);
                if let Some(usd) = e.reported_usd {
                    entry.usd = Some(entry.usd.unwrap_or(0.0) + usd);
                    entry.usd_events += 1;
                }
                entry.events += 1;
            }
        }
        if quiet_duplicates {
            health.usage_lines = health.events;
        }
        for e in errors {
            record::insert(&tx, &mut self.intern, e)?;
        }
        upsert_rows(&tx, &rows, now_ms)?;
        if let Some(file) = file {
            put_file(&tx, file)?;
        }
        if let Some(t) = thread {
            put_thread(&tx, t, None)?;
        }
        tx.execute(
            "INSERT INTO health(source, usage_lines, events, duplicates, skipped_lines, rewrites)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(source) DO UPDATE SET usage_lines = usage_lines + excluded.usage_lines,
               events = events + excluded.events, duplicates = duplicates + excluded.duplicates,
               skipped_lines = skipped_lines + excluded.skipped_lines, rewrites = rewrites + excluded.rewrites",
            params![source, health.usage_lines, health.events, health.duplicates, health.skipped_lines, health.rewrites],
        )?;
        tx.commit()?;
        Ok(health)
    }

    /// Records a file's identity without reading it (for example, a file that did not change).
    pub fn put_file(&mut self, file: &FileState) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        put_file(&tx, file)?;
        tx.commit()
    }

    pub fn mark_success(&self, source: &str, now_ms: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO health(source, last_success_ms) VALUES(?1, ?2)
             ON CONFLICT(source) DO UPDATE SET last_success_ms = excluded.last_success_ms",
            params![source, now_ms],
        )?;
        Ok(())
    }

    pub fn health(&self) -> rusqlite::Result<Vec<(String, Option<i64>, Health)>> {
        let mut st = self.conn.prepare(
            "SELECT source, last_success_ms, usage_lines, events, duplicates, skipped_lines, rewrites FROM health ORDER BY source",
        )?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                Health {
                    usage_lines: r.get(2)?,
                    events: r.get(3)?,
                    duplicates: r.get(4)?,
                    skipped_lines: r.get(5)?,
                    rewrites: r.get(6)?,
                },
            ))
        })?;
        rows.collect()
    }

    pub fn rows_since(&self, from_ms: i64) -> rusqlite::Result<Vec<UsageRow>> {
        let mut st = self.conn.prepare(
            "SELECT bot, role, harness, model, machine, repo, branch, hour_ms, squad,
                    input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning,
                    precision, reported_usd, events, unsplit, id,
                    actor_state, kind, basis, branch_basis, unrecorded, reason
             FROM usage WHERE hour_ms >= ?1
             ORDER BY hour_ms, harness, model, repo, branch, bot, role, precision",
        )?;
        let rows = st.query_map([from_ms], |r| {
            Ok(UsageRow {
                id: r.get(19)?,
                key: RollupKey {
                    bot: r.get(0)?,
                    role: r.get(1)?,
                    harness: r.get(2)?,
                    model: r.get(3)?,
                    machine: r.get(4)?,
                    repo: r.get(5)?,
                    branch: r.get(6)?,
                    hour_ms: r.get(7)?,
                    squad: r.get(8)?,
                    attr: match r.get::<_, Option<String>>(20)? {
                        Some(state) => Some(RollupAttr {
                            state,
                            kind: r.get(21)?,
                            basis: r.get(22)?,
                            branch_basis: r.get::<_, Option<String>>(23)?.unwrap_or_default(),
                            unrecorded: r.get(24)?,
                            reason: r.get(25)?,
                        }),
                        None => None,
                    },
                },
                squad: r.get(8)?,
                tokens: Tokens {
                    input_uncached: r.get(9)?,
                    cache_read: r.get(10)?,
                    cache_write_5m: r.get(11)?,
                    cache_write_1h: r.get(12)?,
                    output: r.get(13)?,
                    reasoning: r.get(14)?,
                    unsplit: r.get(18)?,
                },
                precision: r.get(15)?,
                reported_usd: r.get(16)?,
                events: r.get(17)?,
            })
        })?;
        rows.collect()
    }

    /// A Codex thread's stored path, cumulative and counted total.
    pub fn codex_thread(&self, id: &str) -> rusqlite::Result<Option<(Option<String>, Cum, i64)>> {
        self.conn
            .query_row(
                "SELECT path, cum, counted FROM codex_threads WHERE id = ?1",
                [id],
                |r| {
                    let cum: String = r.get(1)?;
                    Ok((
                        r.get(0)?,
                        serde_json::from_str(&cum).unwrap_or_default(),
                        r.get(2)?,
                    ))
                },
            )
            .optional()
    }

    /// (exact, total_only) Codex threads: a thread is `total_only` when part of what was counted
    /// for it has no split.
    pub fn codex_thread_counts(&self) -> rusqlite::Result<(i64, i64)> {
        let mut st = self
            .conn
            .prepare("SELECT cum, counted FROM codex_threads WHERE counted > 0")?;
        let mut exact = 0;
        let mut total_only = 0;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (cum, counted) = row?;
            let cum: Cum = serde_json::from_str(&cum).unwrap_or_default();
            if cum.total < counted {
                total_only += 1;
            } else {
                exact += 1;
            }
        }
        Ok((exact, total_only))
    }

    pub fn count(&self, table: &str) -> rusqlite::Result<i64> {
        let sql = match table {
            "usage" => "SELECT count(*) FROM usage",
            "files" => "SELECT count(*) FROM files",
            "seen" => "SELECT count(*) FROM seen",
            "sessions" => "SELECT count(*) FROM sessions",
            "evidence" => "SELECT count(*) FROM evidence",
            "launch" => "SELECT count(*) FROM launch",
            "link" => "SELECT count(*) FROM link",
            _ => return Ok(0),
        };
        self.conn.query_row(sql, [], |r| r.get(0))
    }
}

/// Every table and index [`TABLES`] makes.
const OBJECTS: [(&str, &str); 11] = [
    ("table", "meta"),
    ("table", "usage"),
    ("index", "usage_hour"),
    ("index", "usage_repo_branch"),
    ("table", "files"),
    ("table", "seen"),
    ("index", "seen_seq"),
    ("table", "sessions"),
    ("table", "cwd_repo"),
    ("table", "health"),
    ("table", "codex_threads"),
];

/// How an error begins when the store could not be written for want of room.
pub const NO_ROOM: &str = "no room to write the store";

/// A write SQLite could not make for want of room: the disk is full (`SQLITE_FULL`), or a write
/// failed outright (`SQLITE_IOERR_WRITE`, as a file-size limit's `EFBIG` gives).
pub fn no_room(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == rusqlite::ErrorCode::DiskFull
                || f.extended_code == rusqlite::ffi::SQLITE_IOERR_WRITE
    )
}

/// Gives the ambiguous and unlinked rollups a meter before RFC 0021 delivery 6 wrote (no reason,
/// an id without one) the reason that meter meant (`claimants_differ` for ambiguous, `no_record`
/// for unlinked, the only ones it recorded) and the id this meter derives for it, merged into a
/// row already under that id. One transaction; totals never change. Then `meta` records it, so
/// later runs skip it. `sync` alone calls it, under the lock, after keeping a counted generation
/// (RFC 0018 (d)), as for any rewrite of a store's rows. Returns (rows re-keyed, of them merged).
pub fn rekey_reasons(conn: &Connection) -> rusqlite::Result<(usize, usize)> {
    let tx = conn.unchecked_transaction()?;
    let (mut rekeyed, mut merged) = (0usize, 0usize);
    struct Old {
        id: String,
        key: RollupKey,
        precision: Precision,
    }
    let rows: Vec<Old> = {
        let mut st = tx.prepare(
            "SELECT id, bot, role, harness, model, machine, repo, branch, hour_ms, squad,
                    actor_state, kind, basis, branch_basis, unrecorded, precision
             FROM usage WHERE reason IS NULL AND actor_state IN ('ambiguous', 'unlinked')",
        )?;
        st.query_map([], |r| {
            Ok(Old {
                id: r.get(0)?,
                key: RollupKey {
                    bot: r.get(1)?,
                    role: r.get(2)?,
                    harness: r.get(3)?,
                    model: r.get(4)?,
                    machine: r.get(5)?,
                    repo: r.get(6)?,
                    branch: r.get(7)?,
                    hour_ms: r.get(8)?,
                    squad: r.get(9)?,
                    attr: Some(RollupAttr {
                        state: r.get(10)?,
                        kind: r.get(11)?,
                        basis: r.get(12)?,
                        branch_basis: r.get::<_, Option<String>>(13)?.unwrap_or_default(),
                        unrecorded: r.get(14)?,
                        reason: None,
                    }),
                },
                precision: if r.get::<_, String>(15)? == "total_only" {
                    Precision::TotalOnly
                } else {
                    Precision::Exact
                },
            })
        })?
        .collect::<rusqlite::Result<_>>()?
    };
    for mut o in rows {
        // Only a row under the id that meter gave it: any other is left as it is.
        if o.key.id(o.precision) != o.id {
            continue;
        }
        let Some(a) = o.key.attr.as_mut() else {
            continue;
        };
        let reason = if a.state == "ambiguous" {
            "claimants_differ"
        } else {
            "no_record"
        };
        a.reason = Some(reason.to_string());
        let new = o.key.id(o.precision);
        let taken: bool = tx.query_row(
            "SELECT count(*) > 0 FROM usage WHERE id = ?1",
            [&new],
            |r| r.get(0),
        )?;
        if taken {
            // The old row's counts, read first and added as values: no column of the statement
            // can name two rows.
            let (t, events, usd, usd_events, updated): (Tokens, i64, Option<f64>, i64, i64) = tx
                .query_row(
                    "SELECT input_uncached, cache_read, cache_write_5m, cache_write_1h, output,
                            reasoning, unsplit, events, reported_usd, coalesce(usd_events, 0),
                            updated_ms
                     FROM usage WHERE id = ?1",
                    [&o.id],
                    |r| {
                        Ok((
                            Tokens {
                                input_uncached: r.get(0)?,
                                cache_read: r.get(1)?,
                                cache_write_5m: r.get(2)?,
                                cache_write_1h: r.get(3)?,
                                output: r.get(4)?,
                                reasoning: r.get(5)?,
                                unsplit: r.get(6)?,
                            },
                            r.get(7)?,
                            r.get(8)?,
                            r.get(9)?,
                            r.get(10)?,
                        ))
                    },
                )?;
            tx.execute(
                "UPDATE usage SET input_uncached = input_uncached + ?2,
                   cache_read = cache_read + ?3, cache_write_5m = cache_write_5m + ?4,
                   cache_write_1h = cache_write_1h + ?5, output = output + ?6,
                   reasoning = reasoning + ?7, unsplit = unsplit + ?8, events = events + ?9,
                   usd_events = coalesce(usd_events, 0) + ?10,
                   reported_usd = CASE WHEN ?11 IS NULL THEN reported_usd
                                       ELSE coalesce(reported_usd, 0) + ?11 END,
                   updated_ms = max(updated_ms, ?12)
                 WHERE id = ?1",
                params![
                    new,
                    t.input_uncached,
                    t.cache_read,
                    t.cache_write_5m,
                    t.cache_write_1h,
                    t.output,
                    t.reasoning,
                    t.unsplit,
                    events,
                    usd_events,
                    usd,
                    updated
                ],
            )?;
            tx.execute("DELETE FROM usage WHERE id = ?1", [&o.id])?;
            merged += 1;
        } else {
            tx.execute(
                "UPDATE usage SET id = ?1, reason = ?2 WHERE id = ?3",
                params![new, reason, o.id],
            )?;
        }
        rekeyed += 1;
    }
    tx.execute(
        "INSERT INTO meta(k, v) VALUES(?1, '1') ON CONFLICT(k) DO NOTHING",
        [evidence::REASON_KEYED_META],
    )?;
    tx.commit()?;
    Ok((rekeyed, merged))
}

/// Whether a store needs [`rekey_reasons`]: schema 3 with evidence, written by a meter before RFC
/// 0021 delivery 6 (no `rollups_reason_keyed` mark).
pub fn needs_rekey(conn: &Connection) -> rusqlite::Result<bool> {
    if !table_exists(conn, "evidence")? || !table_exists(conn, "meta")? {
        return Ok(false);
    }
    let marked: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM meta WHERE k = ?1)",
        [evidence::REASON_KEYED_META],
        |r| r.get(0),
    )?;
    Ok(!marked)
}

/// Adds schema 3's columns and tables where they are missing.
fn add_schema_3(conn: &Connection) -> rusqlite::Result<()> {
    for (col, ty) in evidence::USAGE_COLUMNS {
        if !column_exists(conn, "usage", col)? {
            conn.execute_batch(&format!("ALTER TABLE usage ADD COLUMN {col} {ty}"))?;
        }
    }
    conn.execute_batch(evidence::DDL)
}

/// A reset's deletes: every row, offset and piece of evidence, and the window from `from`.
fn clear(tx: &Transaction<'_>, from: i64) -> rusqlite::Result<()> {
    tx.execute_batch(
        "DELETE FROM usage; DELETE FROM files; DELETE FROM seen; DELETE FROM sessions;
         DELETE FROM health; DELETE FROM codex_threads;",
    )?;
    if table_exists(tx, "evidence")? {
        tx.execute_batch(
            "DELETE FROM evidence; DELETE FROM ev_dirty; DELETE FROM ev_dim; DELETE FROM ev_actor;
             DELETE FROM ev_cwd;",
        )?;
    }
    // The tool failures go with the rows they were read beside (the re-import records them
    // again); the launches' ends and the pull requests stay, as the launches do.
    record::clear(tx)?;
    tx.execute(
        "INSERT INTO meta(k, v) VALUES('counted_from_ms', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        [from.to_string()],
    )?;
    tx.execute(
        "DELETE FROM meta WHERE k IN ('last_success_ms', 'last_run_ms', 'last_pending_bytes',
         'last_pending_files', 'codex_watermark_ms', 'codex_bad_lines')",
        [],
    )?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |r| r.get(0),
    )
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT count(*) > 0 FROM pragma_table_info(?1) WHERE name = ?2",
        [table, column],
        |r| r.get(0),
    )
}

fn schema_complete(conn: &Connection) -> rusqlite::Result<bool> {
    for (kind, name) in OBJECTS {
        let n: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
            [kind, name],
            |r| r.get(0),
        )?;
        if n == 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

/// What `sync` needs to know about a store before it opens it for writing, read read-only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peek {
    /// `schema_version`; 0 for a store with tables but no version (older than versioning).
    pub version: i64,
    /// The start of its window; None until its first sync reset it.
    pub counted_from_ms: Option<i64>,
    /// Whether `usage`, `files` or `seen` holds a row: a reset would drop something.
    pub has_rows: bool,
    /// Whether it has the `usage_repo_branch` index the query reads through.
    pub has_repo_index: bool,
    /// Whether its rollups must be re-keyed with their reason ([`rekey_reasons`]): a rewrite of
    /// rows, so `sync` keeps a generation first.
    pub needs_rekey: bool,
}

/// Reads a store's version and window without writing a byte. None when there is no store yet:
/// no file, an empty file, or a database without tables.
pub fn peek(path: &Path) -> rusqlite::Result<Option<Peek>> {
    if !path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0) {
        return Ok(None);
    }
    let conn = open_peek(path)?;
    let Some(version) = crate::query::schema_version(&conn)? else {
        return Ok(None);
    };
    let counted_from_ms = if table_exists(&conn, "meta")? {
        conn.query_row("SELECT v FROM meta WHERE k = 'counted_from_ms'", [], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .and_then(|v| v.parse().ok())
    } else {
        None
    };
    let mut has_rows = false;
    for t in ["usage", "files", "seen"] {
        if table_exists(&conn, t)? {
            has_rows |= conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {t})"), [], |r| {
                r.get::<_, bool>(0)
            })?;
        }
    }
    let has_repo_index = conn.query_row(
        "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'index' AND name = 'usage_repo_branch'",
        [],
        |r| r.get(0),
    )?;
    let needs_rekey = version == SCHEMA_VERSION && needs_rekey(&conn)?;
    Ok(Some(Peek {
        version,
        counted_from_ms,
        has_rows,
        has_repo_index,
        needs_rekey,
    }))
}

/// A read that makes no file at all. With no wal beside it the database file is the whole store,
/// and `immutable` reads it with no lock and no `-wal` or `-shm` companion: safe because the
/// caller holds the sync lock (or no lock file exists yet), so nothing writes while it reads. With
/// a wal (a sync that stopped without closing), the companions already exist and a plain
/// read-only open is the one that sees the wal's rows.
fn open_peek(path: &Path) -> rusqlite::Result<Connection> {
    let wal = path.with_file_name(format!(
        "{}-wal",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    if wal.symlink_metadata().is_ok() {
        return crate::query::open_read_only(path, std::time::Duration::from_secs(5));
    }
    let mut uri = String::from("file:");
    for b in path.to_string_lossy().bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri.push_str("?immutable=1");
    Connection::open_with_flags(
        uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_URI
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

/// How far the store has read each log (`files.offset`), by path, read without writing a byte.
/// Empty when the store has no `files` table.
pub fn imported_offsets(path: &Path) -> rusqlite::Result<std::collections::HashMap<String, u64>> {
    let mut out = std::collections::HashMap::new();
    if !path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0) {
        return Ok(out);
    }
    let conn = open_peek(path)?;
    if !table_exists(&conn, "files")? {
        return Ok(out);
    }
    let mut st = conn.prepare("SELECT path, offset FROM files")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (p, o) = row?;
        out.insert(p, o.max(0) as u64);
    }
    Ok(out)
}

/// Row counts of every table, by name.
pub fn row_counts(conn: &Connection) -> rusqlite::Result<BTreeMap<String, i64>> {
    let names: Vec<String> = {
        let mut st = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )?;
        st.query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    let mut out = BTreeMap::new();
    for n in names {
        let q = format!("SELECT count(*) FROM \"{}\"", n.replace('"', "\"\""));
        out.insert(n, conn.query_row(&q, [], |r| r.get(0))?);
    }
    Ok(out)
}

/// A recoverable generation: a copy of the store kept before a destructive migration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generation {
    pub path: std::path::PathBuf,
    pub counts: BTreeMap<String, i64>,
}

/// The prefix of every generation's file name in the state directory.
pub const GENERATION_PREFIX: &str = "meter.db.gen-";

/// Writes `meter.db.gen-<schema>-<utc>` beside the store (mode 0600) as an online backup of one
/// snapshot (`VACUUM INTO`, which reads the store and writes only the copy), fsyncs
/// it, opens it and checks that every table holds as many rows as the store's. On any failure
/// the copy is removed and the store is untouched.
pub fn write_generation(db: &Path, version: i64, now_ms: i64) -> Result<Generation, String> {
    let dir = db.parent().unwrap_or(Path::new("."));
    let stamp: String = crate::time::format_rfc3339(now_ms)
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let base = format!("{GENERATION_PREFIX}{version}-{stamp}");
    // A name no file has: a generation from the same second (or a kill's leftover) is never
    // replaced, and never removed by this call, which removes only the file it created.
    let mut path = dir.join(&base);
    let mut created = false;
    for n in 0..100 {
        if n > 0 {
            path = dir.join(format!("{base}-{n}"));
        }
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        match o.open(&path) {
            Ok(_) => {
                created = true;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
        }
    }
    if !created {
        return Err(format!("no free name for a generation beside {base}"));
    }
    let made = (|| -> Result<BTreeMap<String, i64>, String> {
        let src = crate::query::open_read_only(db, std::time::Duration::from_secs(5))
            .map_err(|e| format!("cannot open the store: {e}"))?;
        // The caller holds the sync lock, so nothing writes between the count and the copy.
        let want = row_counts(&src).map_err(|e| format!("cannot count the store's rows: {e}"))?;
        src.execute("VACUUM INTO ?1", [path.to_string_lossy()])
            .map_err(|e| format!("cannot copy the store: {e}"))?;
        drop(src);
        std::fs::File::open(&path)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("cannot fsync {}: {e}", path.display()))?;
        std::fs::File::open(dir)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("cannot fsync {}: {e}", dir.display()))?;
        let copy = crate::query::open_read_only(&path, std::time::Duration::from_secs(5))
            .map_err(|e| format!("cannot open the copy: {e}"))?;
        let got = row_counts(&copy).map_err(|e| format!("cannot count the copy's rows: {e}"))?;
        if got != want {
            return Err(format!(
                "the copy's row counts {got:?} differ from the store's {want:?}"
            ));
        }
        Ok(got)
    })();
    match made {
        Ok(counts) => Ok(Generation { path, counts }),
        Err(e) => {
            let _ = remove_generation(&path);
            Err(e)
        }
    }
}

/// Removes a generation and the rollback journal a killed copy may have left beside it.
pub fn remove_generation(path: &Path) -> std::io::Result<()> {
    let journal = path.with_file_name(format!(
        "{}-journal",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    match std::fs::remove_file(&journal) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    std::fs::remove_file(path)
}

/// The generations in `dir`, by name.
pub fn generations(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut v: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            // A copy's own companions are not generations.
            n.starts_with(GENERATION_PREFIX)
                && !["-journal", "-wal", "-shm"].iter().any(|x| n.ends_with(x))
        })
        .map(|e| e.path())
        .collect();
    v.sort();
    v
}

fn put_file(tx: &Transaction<'_>, f: &FileState) -> rusqlite::Result<()> {
    let ctx = serde_json::to_string(&f.ctx).unwrap_or_else(|_| "{}".into());
    tx.prepare_cached(
        "INSERT INTO files(path, source, dev, ino, size, mtime_ms, offset, head_len, head_hash, ctx, rewrites, head_skip)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(path) DO UPDATE SET source = excluded.source, dev = excluded.dev, ino = excluded.ino,
           size = excluded.size, mtime_ms = excluded.mtime_ms, offset = excluded.offset,
           head_len = excluded.head_len, head_hash = excluded.head_hash, head_skip = excluded.head_skip, ctx = excluded.ctx,
           rewrites = excluded.rewrites",
    )?
    .execute(params![
        f.path,
        f.source,
        f.dev as i64,
        f.ino as i64,
        f.size as i64,
        f.mtime_ms,
        f.offset as i64,
        f.head_len as i64,
        f.head_hash,
        ctx,
        f.rewrites,
        f.head_skip as i64
    ])?;
    if let Some(t) = &f.ctx.codex {
        put_thread(tx, t, Some(&f.path))?;
    }
    Ok(())
}

/// The thread's cumulative moves with the chunk that advanced it, in the same transaction.
fn put_thread(tx: &Transaction<'_>, t: &CodexCtx, path: Option<&str>) -> rusqlite::Result<()> {
    let cum = serde_json::to_string(&t.cum).unwrap_or_else(|_| "{}".into());
    tx.prepare_cached(
        "INSERT INTO codex_threads(id, path, cum, counted) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET path = coalesce(excluded.path, path), cum = excluded.cum,
           counted = excluded.counted",
    )?
    .execute(params![t.thread, path, cum, t.counted])?;
    Ok(())
}

/// What a chunk adds to one rollup row.
#[derive(Debug, Clone, Default)]
pub struct Pending {
    pub squad: Option<String>,
    pub tokens: Tokens,
    pub usd: Option<f64>,
    /// How many of its calls reported USD: when a move takes the last away, the row's USD is
    /// null again, never 0.
    pub usd_events: i64,
    pub events: i64,
}

/// Precision is part of the id, so a row never mixes exact and total_only usage.
pub(crate) fn upsert_rows(
    tx: &Transaction<'_>,
    rows: &BTreeMap<(RollupKey, Precision), Pending>,
    now_ms: i64,
) -> rusqlite::Result<()> {
    let mut st = tx.prepare_cached(
        "INSERT INTO usage(id, hour_ms, bot, role, squad, harness, model, machine, repo, branch,
           input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning,
           precision, reported_usd, events, updated_ms, unsplit,
           actor_state, kind, basis, branch_basis, unrecorded, usd_events, reason)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21,
           ?22, ?23, ?24, ?25, ?26, ?27, ?28)
         ON CONFLICT(id) DO UPDATE SET
           usd_events = coalesce(usd_events, 0) + excluded.usd_events,
           squad = coalesce(excluded.squad, squad),
           input_uncached = input_uncached + excluded.input_uncached,
           cache_read = cache_read + excluded.cache_read,
           cache_write_5m = cache_write_5m + excluded.cache_write_5m,
           cache_write_1h = cache_write_1h + excluded.cache_write_1h,
           output = output + excluded.output,
           reasoning = reasoning + excluded.reasoning,
           unsplit = unsplit + excluded.unsplit,
           reported_usd = CASE WHEN excluded.reported_usd IS NULL THEN reported_usd
                               ELSE coalesce(reported_usd, 0) + excluded.reported_usd END,
           events = events + excluded.events,
           updated_ms = excluded.updated_ms",
    )?;
    for ((k, precision), p) in rows {
        let (squad, t, usd, n) = (&p.squad, &p.tokens, p.usd, p.events);
        let a = k.attr.as_ref();
        // A schema 3 row's squad is its key's; an older key's squad rides beside it.
        let squad = if a.is_some() { &k.squad } else { squad };
        let branch_basis = a
            .map(|a| a.branch_basis.clone())
            .or_else(|| Some(if k.branch.is_some() { "log" } else { "none" }.to_string()));
        st.execute(params![
            k.id(*precision),
            k.hour_ms,
            k.bot,
            k.role,
            squad,
            k.harness,
            k.model,
            k.machine,
            k.repo,
            k.branch,
            t.input_uncached,
            t.cache_read,
            t.cache_write_5m,
            t.cache_write_1h,
            t.output,
            t.reasoning,
            precision.as_str(),
            usd,
            n,
            now_ms,
            t.unsplit,
            a.map(|a| a.state.clone()),
            a.and_then(|a| a.kind.clone()),
            a.and_then(|a| a.basis.clone()),
            branch_basis,
            a.and_then(|a| a.unrecorded.clone()),
            p.usd_events,
            a.and_then(|a| a.reason.clone())
        ])?;
    }
    Ok(())
}
