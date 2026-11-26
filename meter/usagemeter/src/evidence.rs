//! Schema 3 (RFC 0021 delivery 5, the evidence half of RFC 0018's slice M3): per-call evidence,
//! the `launch` and `link` tables, and the attribution derived from them.
//!
//! - `evidence`: one row per counted call, RFC 0018 (b)'s minimum: the time in ms, the harness,
//!   model, machine, repo and branch as logged (interned in `ev_dim`), every token kind (the prompt
//!   size is the sum of the input kinds), the precision, the reported USD, the session and its
//!   parent session and the request identity as keyed 128-bit hashes (never the raw ids), the cwd
//!   and the folder the session started in (interned in `ev_cwd`), and whether the call is a
//!   dsh-tui fork's copy. Its attribution is derived, never typed in: an `ev_actor` row (state,
//!   reason, bot, kind, role, squad, unrecorded, task, project, filled branch, basis).
//! - `launch` and `link` (RFC 0021 (b)): one row per launch and per session in a launch, with
//!   validity intervals. They follow RFC 0018 (b)'s rules (bounded retention, machine-local ids,
//!   superseded rows kept marked) without extending its session-to-task contract: a bot per
//!   session is the ownership map's M3 row ("Bots and lead association"). Ledger rows are re-read
//!   each sync; these tables keep what only a sync can see (the hc snapshot: unlogged launches, the
//!   session labels, the live folder and harness, a terminal gone between two syncs) and what each
//!   sync derived, so a later recompute replays the same answer. A dsh-tui session's links (RFC
//!   0026 (d): its header's terminal, a `session` row, its pane's session label) are all kept at
//!   `session` basis and read back ([`session_links`]); `seen_first` is set only on a link a
//!   session label made, which is how a replay tells the second witness from a row's or a
//!   header's link without another column.
//! - `ev_dirty`: sessions and start folders whose links or launches changed, waiting for their
//!   calls' attribution to be recomputed (a durable queue: a run stopped by its budget resumes).
//! - `ledgers`: the project app homes found so far, read again on every sync.
//!
//! The hourly rollups (`usage`) are a cache of the evidence: a schema 3 row keys on its squad and
//! its [`RollupAttr`], and when a call's attribution changes its tokens move from the old row to
//! the new one in the same transaction. Rows written before schema 3 (`actor_state` null) are
//! frozen: their bot and role stay for the doc and `status`, and they are never counted as
//! attributed.
//!
//! Session ids, request ids and paths stay in the state folder (mode 0600): nothing here prints
//! one, and no count output names one.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

use crate::event::{Precision, RollupAttr, RollupKey, Tokens};
use crate::ledger::{Basis, Kind, Resolution};

/// Per-call evidence is kept this long (RFC 0018 (b), proposed).
pub const EVIDENCE_DAYS: i64 = 90;
/// ... or until it takes this many bytes, whichever comes first (proposed).
pub const EVIDENCE_BYTES: u64 = 1 << 30;
/// Closed launches and links are kept this long after they end (proposed).
pub const LINK_DAYS: i64 = 400;
/// What a call of evidence is assumed to take when SQLite cannot measure the table.
const BYTES_PER_CALL: u64 = 200;
/// The first moment the day bound keeps evidence for: the start of the oldest whole day of the
/// last [`EVIDENCE_DAYS`]. A call before it gets no evidence row at all, so a backfill never writes
/// evidence the bound would drop at once (the Fixer's M2 on PR 849).
pub fn retention_cut(now_ms: i64) -> i64 {
    crate::time::day_start(now_ms) - (EVIDENCE_DAYS - 1) * crate::time::DAY_MS
}

/// The `meta` key of the store's session key (hex).
pub const KEY_META: &str = "evidence_key";
/// The `meta` key of the start of per-call evidence (ms).
pub const FROM_META: &str = "evidence_from_ms";

/// The tables, indexes and columns schema 3 adds to a schema 2 store, all in one transaction
/// ([`crate::store::Store::migrate`]).
pub const DDL: &str = "
CREATE TABLE IF NOT EXISTS ev_dim (
  id INTEGER PRIMARY KEY,
  harness TEXT NOT NULL, model TEXT NOT NULL, machine TEXT NOT NULL,
  repo TEXT, branch TEXT, precision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ev_actor (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL, reason TEXT, bot TEXT, kind TEXT, role TEXT, squad TEXT, unrecorded TEXT,
  task TEXT, project TEXT, filled_branch TEXT, basis TEXT
);
CREATE TABLE IF NOT EXISTS ev_cwd (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  dim INTEGER NOT NULL,
  actor INTEGER NOT NULL,
  session BLOB, parent BLOB, request BLOB,
  cwd INTEGER, session_cwd INTEGER,
  copied INTEGER NOT NULL DEFAULT 0,
  input_uncached INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  unsplit INTEGER NOT NULL DEFAULT 0,
  reported_usd REAL
);
CREATE INDEX IF NOT EXISTS evidence_ts ON evidence(ts_ms);
CREATE INDEX IF NOT EXISTS evidence_session ON evidence(session);
CREATE INDEX IF NOT EXISTS evidence_parent ON evidence(parent) WHERE parent IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_session_cwd ON evidence(session_cwd);
CREATE TABLE IF NOT EXISTS launch (
  lkey TEXT PRIMARY KEY,
  core TEXT, terminal TEXT, created_ms INTEGER,
  kind TEXT, bot TEXT, role TEXT, squad TEXT, lead TEXT, task TEXT, project TEXT, branch TEXT,
  worktree TEXT, agent TEXT,
  valid_from INTEGER, valid_to INTEGER, end_basis TEXT, gone_after INTEGER,
  source TEXT NOT NULL, source_ref TEXT,
  seen_first INTEGER, seen_last INTEGER, live_cwd TEXT, live_agent TEXT,
  bound TEXT,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS link (
  id INTEGER PRIMARY KEY,
  harness TEXT NOT NULL, session BLOB NOT NULL, lkey TEXT NOT NULL, basis TEXT NOT NULL,
  valid_from INTEGER, valid_to INTEGER,
  seen_first INTEGER, seen_last INTEGER,
  superseded_by INTEGER
);
CREATE INDEX IF NOT EXISTS link_session ON link(session);
CREATE INDEX IF NOT EXISTS link_lkey ON link(lkey);
CREATE TABLE IF NOT EXISTS ev_dirty (k TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ledgers (home TEXT PRIMARY KEY, found_ms INTEGER NOT NULL);
";

/// The columns schema 3 adds to `usage`, each added only when missing.
pub const USAGE_COLUMNS: [(&str, &str); 7] = [
    ("kind", "TEXT"),
    ("basis", "TEXT"),
    ("branch_basis", "TEXT"),
    ("actor_state", "TEXT"),
    ("unrecorded", "TEXT"),
    ("usd_events", "INTEGER"),
    ("reason", "TEXT"),
];

/// Every table and index [`DDL`] makes.
pub const OBJECTS: [(&str, &str); 14] = [
    ("table", "ev_dim"),
    ("table", "ev_actor"),
    ("table", "ev_cwd"),
    ("table", "evidence"),
    ("index", "evidence_ts"),
    ("index", "evidence_session"),
    ("index", "evidence_parent"),
    ("index", "evidence_session_cwd"),
    ("table", "launch"),
    ("table", "link"),
    ("index", "link_session"),
    ("index", "link_lkey"),
    ("table", "ev_dirty"),
    ("table", "ledgers"),
];

/// The store's key for session and request hashes: random per store, kept in `meta`, never
/// printed. HMAC-SHA256, cut to 128 bits (RFC 0018 (b), open question 5).
#[derive(Clone)]
pub struct SessionKey([u8; 32]);

impl std::fmt::Debug for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionKey(..)")
    }
}

impl SessionKey {
    pub fn from_hex(h: &str) -> Option<SessionKey> {
        let b = from_hex(h)?;
        Some(SessionKey(b.try_into().ok()?))
    }

    /// 32 bytes from the system's random source. Never a fallback: a key someone could predict
    /// would let them test a guessed session id against the store's hashes.
    pub fn random() -> std::io::Result<SessionKey> {
        use std::io::Read;
        let mut b = [0u8; 32];
        std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
        Ok(SessionKey(b))
    }

    pub fn to_hex(&self) -> String {
        crate::event::hex(&self.0)
    }

    /// The keyed hash of `id` within `scope` (an agent for a session, `req:<harness>` for a
    /// request).
    pub fn hash(&self, scope: &str, id: &str) -> [u8; 16] {
        let mut msg = Vec::with_capacity(scope.len() + id.len() + 1);
        msg.extend_from_slice(scope.as_bytes());
        msg.push(0x1f);
        msg.extend_from_slice(id.as_bytes());
        let mac = hmac(&self.0, &msg);
        let mut out = [0u8; 16];
        out.copy_from_slice(&mac[..16]);
        out
    }

    pub fn hex(&self, scope: &str, id: &str) -> String {
        crate::event::hex(&self.hash(scope, id))
    }
}

fn hmac(key: &[u8; 32], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    k[..32].copy_from_slice(key);
    let (mut ipad, mut opad) = ([0x36u8; 64], [0x5cu8; 64]);
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new()
        .chain_update(ipad)
        .chain_update(msg)
        .finalize();
    Sha256::new()
        .chain_update(opad)
        .chain_update(inner)
        .finalize()
        .into()
}

pub fn from_hex(h: &str) -> Option<Vec<u8>> {
    if !h.len().is_multiple_of(2) {
        return None;
    }
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(h.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The session scope of a harness: the ledger's agent name, so a Claude Code call's session and a
/// Herdr row's Claude session hash alike.
pub fn scope(harness: &str) -> &str {
    crate::ledger::agent_of(harness).unwrap_or(harness)
}

/// What a call was logged as: the part of its rollup key attribution never changes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct Dim {
    pub harness: String,
    pub model: String,
    pub machine: String,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub precision: String,
}

/// A call's derived attribution (RFC 0021 (a) and (c)).
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Actor {
    /// `attributed`, `ambiguous` or `unlinked`.
    pub state: String,
    /// Why a call has no bot: `claimants_differ` (ambiguous), or for an unlinked call
    /// `other_machine`, `dsh_tui_seat` or `no_record` (RFC 0021 delivery 2, D5).
    pub reason: Option<String>,
    pub bot: Option<String>,
    pub kind: Option<String>,
    pub role: Option<String>,
    pub squad: Option<String>,
    pub unrecorded: Option<String>,
    pub task: Option<String>,
    pub project: Option<String>,
    /// The worker's start-row branch, for a dsh-tui or omp call whose log has none.
    pub filled_branch: Option<String>,
    pub basis: Option<String>,
}

/// Harnesses whose logs carry no branch: a call of theirs that resolves to a worker launch takes
/// the start row's branch (`branch_basis: ledger`, RFC 0021 (a)).
fn logs_no_branch(harness: &str) -> bool {
    matches!(harness, "dsh-tui" | "omp")
}

impl Actor {
    /// The attribution a resolution gives a call of `harness` whose log recorded `branch`.
    pub fn derive(r: &Resolution, harness: &str, branch: Option<&str>) -> Actor {
        match r {
            Resolution::Tag(tag, basis) => {
                let kind = match tag.kind {
                    Kind::Worker => "worker",
                    Kind::Seat => "seat",
                };
                // Never from git or today's checkout: only a worker's own start row.
                let filled_branch =
                    (branch.is_none() && logs_no_branch(harness) && tag.kind == Kind::Worker)
                        .then(|| tag.branch.clone())
                        .flatten();
                Actor {
                    state: "attributed".into(),
                    reason: None,
                    bot: Some(tag.bot.clone()),
                    kind: Some(kind.into()),
                    role: tag.role.clone(),
                    squad: tag.squad.clone(),
                    unrecorded: (!tag.unrecorded.is_empty()).then(|| tag.unrecorded.join(",")),
                    task: tag.task.clone(),
                    project: tag.project.clone(),
                    filled_branch,
                    basis: Some(basis_str(*basis).into()),
                }
            }
            Resolution::Ambiguous => Actor {
                state: "ambiguous".into(),
                reason: Some("claimants_differ".into()),
                ..Actor::default()
            },
            Resolution::Unlinked => Actor {
                state: "unlinked".into(),
                reason: Some("no_record".into()),
                ..Actor::default()
            },
        }
    }
}

/// Why an unlinked call has no bot, the first that holds (RFC 0021 delivery 2, D5): a dsh-tui
/// fork's copy is `no_record` (its own session is unknown); a session that another machine's
/// records name is `other_machine` (Decided 6); a dsh-tui session no start-time record names
/// (`witnessed` false: no header terminal, no `session` row, no session label) is `dsh_tui_seat`,
/// since dsh-tui calls are otherwise found by their worker's worktree alone (RFC 0026 (d));
/// anything else is `no_record`, a witnessed dsh-tui session included: its record names a
/// terminal or a launch, and no launch there names a bot.
pub fn unlinked_reason(
    harness: &str,
    copied: bool,
    elsewhere: bool,
    witnessed: bool,
) -> &'static str {
    if copied {
        "no_record"
    } else if elsewhere {
        "other_machine"
    } else if harness == "dsh-tui" && !witnessed {
        "dsh_tui_seat"
    } else {
        "no_record"
    }
}

fn basis_str(b: Basis) -> &'static str {
    b.as_str()
}

/// The rollup row a call with this logging and attribution goes to.
pub fn rollup_key(dim: &Dim, actor: &Actor, hour_ms: i64) -> (RollupKey, Precision) {
    let branch_basis = if dim.branch.is_some() {
        "log"
    } else if actor.filled_branch.is_some() {
        "ledger"
    } else {
        "none"
    };
    let precision = if dim.precision == "total_only" {
        Precision::TotalOnly
    } else {
        Precision::Exact
    };
    (
        RollupKey {
            bot: actor.bot.clone(),
            role: actor.role.clone(),
            harness: dim.harness.clone(),
            model: dim.model.clone(),
            machine: dim.machine.clone(),
            repo: dim.repo.clone(),
            branch: dim.branch.clone().or_else(|| actor.filled_branch.clone()),
            hour_ms,
            squad: actor.squad.clone(),
            attr: Some(RollupAttr {
                state: actor.state.clone(),
                kind: actor.kind.clone(),
                basis: actor.basis.clone(),
                branch_basis: branch_basis.into(),
                unrecorded: actor.unrecorded.clone(),
                reason: actor.reason.clone(),
            }),
        },
        precision,
    )
}

/// One call's evidence, as ingestion hands it to the store.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Evidence {
    pub dim: Dim,
    pub actor: Actor,
    pub session: Option<[u8; 16]>,
    pub parent: Option<[u8; 16]>,
    pub request: Option<[u8; 16]>,
    pub cwd: Option<String>,
    pub session_cwd: Option<String>,
    pub copied: bool,
}

/// Ids of interned rows, cached per store. Cleared whenever a transaction that may have added
/// one fails.
#[derive(Debug, Default)]
pub struct Interner {
    dims: HashMap<Dim, i64>,
    actors: HashMap<Actor, i64>,
    cwds: HashMap<String, i64>,
}

impl Interner {
    pub fn clear(&mut self) {
        *self = Interner::default();
    }

    pub fn dim(&mut self, c: &Connection, d: &Dim) -> rusqlite::Result<i64> {
        if let Some(&id) = self.dims.get(d) {
            return Ok(id);
        }
        let found: Option<i64> = c
            .query_row(
                "SELECT id FROM ev_dim WHERE harness = ?1 AND model = ?2 AND machine = ?3
                 AND repo IS ?4 AND branch IS ?5 AND precision = ?6",
                params![d.harness, d.model, d.machine, d.repo, d.branch, d.precision],
                |r| r.get(0),
            )
            .optional()?;
        let id = match found {
            Some(id) => id,
            None => {
                c.execute(
                    "INSERT INTO ev_dim(harness, model, machine, repo, branch, precision)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                    params![d.harness, d.model, d.machine, d.repo, d.branch, d.precision],
                )?;
                c.last_insert_rowid()
            }
        };
        self.dims.insert(d.clone(), id);
        Ok(id)
    }

    pub fn actor(&mut self, c: &Connection, a: &Actor) -> rusqlite::Result<i64> {
        if let Some(&id) = self.actors.get(a) {
            return Ok(id);
        }
        let p = params![
            a.state,
            a.reason,
            a.bot,
            a.kind,
            a.role,
            a.squad,
            a.unrecorded,
            a.task,
            a.project,
            a.filled_branch,
            a.basis
        ];
        let found: Option<i64> = c
            .query_row(
                "SELECT id FROM ev_actor WHERE state = ?1 AND reason IS ?2 AND bot IS ?3
                 AND kind IS ?4 AND role IS ?5 AND squad IS ?6 AND unrecorded IS ?7 AND task IS ?8
                 AND project IS ?9 AND filled_branch IS ?10 AND basis IS ?11",
                p,
                |r| r.get(0),
            )
            .optional()?;
        let id = match found {
            Some(id) => id,
            None => {
                c.execute(
                    "INSERT INTO ev_actor(state, reason, bot, kind, role, squad, unrecorded, task,
                       project, filled_branch, basis)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    p,
                )?;
                c.last_insert_rowid()
            }
        };
        self.actors.insert(a.clone(), id);
        Ok(id)
    }

    pub fn cwd(&mut self, c: &Connection, path: Option<&str>) -> rusqlite::Result<Option<i64>> {
        let Some(path) = path else { return Ok(None) };
        if let Some(&id) = self.cwds.get(path) {
            return Ok(Some(id));
        }
        c.execute(
            "INSERT INTO ev_cwd(path) VALUES(?1) ON CONFLICT(path) DO NOTHING",
            [path],
        )?;
        let id: i64 = c.query_row("SELECT id FROM ev_cwd WHERE path = ?1", [path], |r| {
            r.get(0)
        })?;
        self.cwds.insert(path.to_owned(), id);
        Ok(Some(id))
    }
}

/// Inserts one call's evidence.
pub fn insert(
    tx: &Transaction<'_>,
    intern: &mut Interner,
    e: &Evidence,
    ts_ms: i64,
    t: &Tokens,
    reported_usd: Option<f64>,
) -> rusqlite::Result<()> {
    let dim = intern.dim(tx, &e.dim)?;
    let actor = intern.actor(tx, &e.actor)?;
    let cwd = intern.cwd(tx, e.cwd.as_deref())?;
    let session_cwd = intern.cwd(tx, e.session_cwd.as_deref())?;
    tx.prepare_cached(
        "INSERT INTO evidence(ts_ms, dim, actor, session, parent, request, cwd, session_cwd, copied,
           input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning, unsplit,
           reported_usd)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )?
    .execute(params![
        ts_ms,
        dim,
        actor,
        e.session.map(|b| b.to_vec()),
        e.parent.map(|b| b.to_vec()),
        e.request.map(|b| b.to_vec()),
        cwd,
        session_cwd,
        e.copied,
        t.input_uncached,
        t.cache_read,
        t.cache_write_5m,
        t.cache_write_1h,
        t.output,
        t.reasoning,
        t.unsplit,
        reported_usd
    ])?;
    Ok(())
}

/// One stored call, as the recompute pass reads it back.
#[derive(Debug, Clone)]
pub struct Stored {
    pub id: i64,
    pub ts_ms: i64,
    pub dim: Dim,
    pub actor_id: i64,
    pub actor: Actor,
    pub session: Option<Vec<u8>>,
    pub parent: Option<Vec<u8>>,
    pub cwd: Option<String>,
    pub session_cwd: Option<String>,
    pub copied: bool,
    pub tokens: Tokens,
    pub reported_usd: Option<f64>,
}

const STORED: &str = "SELECT e.id, e.ts_ms, d.harness, d.model, d.machine, d.repo, d.branch,
    d.precision, e.actor, a.state, a.reason, a.bot, a.kind, a.role, a.squad, a.unrecorded, a.task,
    a.project, a.filled_branch, a.basis, e.session, e.parent, c.path, sc.path, e.copied,
    e.input_uncached, e.cache_read, e.cache_write_5m, e.cache_write_1h, e.output, e.reasoning,
    e.unsplit, e.reported_usd
  FROM evidence e JOIN ev_dim d ON d.id = e.dim JOIN ev_actor a ON a.id = e.actor
  LEFT JOIN ev_cwd c ON c.id = e.cwd LEFT JOIN ev_cwd sc ON sc.id = e.session_cwd";

fn stored(r: &rusqlite::Row<'_>) -> rusqlite::Result<Stored> {
    Ok(Stored {
        id: r.get(0)?,
        ts_ms: r.get(1)?,
        dim: Dim {
            harness: r.get(2)?,
            model: r.get(3)?,
            machine: r.get(4)?,
            repo: r.get(5)?,
            branch: r.get(6)?,
            precision: r.get(7)?,
        },
        actor_id: r.get(8)?,
        actor: Actor {
            state: r.get(9)?,
            reason: r.get(10)?,
            bot: r.get(11)?,
            kind: r.get(12)?,
            role: r.get(13)?,
            squad: r.get(14)?,
            unrecorded: r.get(15)?,
            task: r.get(16)?,
            project: r.get(17)?,
            filled_branch: r.get(18)?,
            basis: r.get(19)?,
        },
        session: r.get(20)?,
        parent: r.get(21)?,
        cwd: r.get(22)?,
        session_cwd: r.get(23)?,
        copied: r.get(24)?,
        tokens: Tokens {
            input_uncached: r.get(25)?,
            cache_read: r.get(26)?,
            cache_write_5m: r.get(27)?,
            cache_write_1h: r.get(28)?,
            output: r.get(29)?,
            reasoning: r.get(30)?,
            unsplit: r.get(31)?,
        },
        reported_usd: r.get(32)?,
    })
}

/// Every stored call (tests and checks).
pub fn all(c: &Connection) -> rusqlite::Result<Vec<Stored>> {
    let mut st = c.prepare(&format!("{STORED} ORDER BY e.id"))?;
    st.query_map([], stored)?.collect()
}

/// The calls a dirty key names: a session (`s:<hex>`, its own calls and its sub-agents') or a
/// start folder (`c:<path>`).
pub fn calls_of(c: &Connection, key: &str) -> rusqlite::Result<Vec<Stored>> {
    if let Some(h) = key.strip_prefix("s:") {
        let Some(b) = from_hex(h) else {
            return Ok(Vec::new());
        };
        let mut st = c.prepare_cached(&format!(
            "{STORED} WHERE e.session = ?1 OR e.parent = ?1 ORDER BY e.id"
        ))?;
        return st.query_map([b], stored)?.collect();
    }
    if let Some(p) = key.strip_prefix("c:") {
        let mut st = c.prepare_cached(&format!(
            "{STORED} WHERE e.session_cwd = (SELECT id FROM ev_cwd WHERE path = ?1) ORDER BY e.id"
        ))?;
        return st.query_map([p], stored)?.collect();
    }
    Ok(Vec::new())
}

/// Moves one call to a new attribution: its evidence row points at the new actor, and its tokens
/// leave the old rollup row for the new one. The caller holds the transaction. When no rollup row
/// holds the call it moves nothing, its evidence included, and says so (false): totals never
/// change.
pub fn reattribute(
    tx: &Transaction<'_>,
    intern: &mut Interner,
    call: &Stored,
    to: &Actor,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    let hour = crate::time::hour_start(call.ts_ms);
    let (old, p) = rollup_key(&call.dim, &call.actor, hour);
    let (new, _) = rollup_key(&call.dim, to, hour);
    // The row that counted the call: its id now, and for an ambiguous or unlinked call also the id
    // a meter before RFC 0021 delivery 6 gave it, which left the reason out of the key (a store
    // that meter wrote, then upgraded).
    let mut ids = vec![old.id(p)];
    if old.attr.as_ref().is_some_and(|a| a.reason.is_some()) {
        let mut pre = old.clone();
        if let Some(a) = pre.attr.as_mut() {
            a.reason = None;
        }
        ids.push(pre.id(p));
    }
    let mut from = None;
    for id in ids {
        if debit(tx, &id, call, now_ms)? {
            from = Some(id);
            break;
        }
    }
    // No row holds the call's tokens: moving it would count it twice, so it stays as it is.
    let Some(row) = from else {
        return Ok(false);
    };
    delete_empty_rollup(tx, &row)?;
    let id = intern.actor(tx, to)?;
    tx.execute(
        "UPDATE evidence SET actor = ?1 WHERE id = ?2",
        params![id, call.id],
    )?;
    let mut rows = BTreeMap::new();
    rows.insert(
        (new, p),
        crate::store::Pending {
            squad: None,
            tokens: call.tokens,
            usd: call.reported_usd,
            usd_events: i64::from(call.reported_usd.is_some()),
            events: 1,
        },
    );
    crate::store::upsert_rows(tx, &rows, now_ms)?;
    Ok(true)
}

/// Takes `call` out of the rollup row `row`, only when that row still holds all of it (an event
/// and at least its tokens). Whether it did.
fn debit(tx: &Transaction<'_>, row: &str, call: &Stored, now_ms: i64) -> rusqlite::Result<bool> {
    let t = &call.tokens;
    let n = tx.execute(
        "UPDATE usage SET input_uncached = input_uncached - ?2, cache_read = cache_read - ?3,
           cache_write_5m = cache_write_5m - ?4, cache_write_1h = cache_write_1h - ?5,
           output = output - ?6, reasoning = reasoning - ?7, unsplit = unsplit - ?8,
           events = events - 1,
           usd_events = coalesce(usd_events, 0) - ?9,
           reported_usd = CASE WHEN coalesce(usd_events, 0) - ?9 <= 0 THEN NULL
                               ELSE reported_usd - coalesce(?10, 0) END,
           updated_ms = ?11
         WHERE id = ?1 AND events >= 1 AND input_uncached >= ?2 AND cache_read >= ?3
           AND cache_write_5m >= ?4 AND cache_write_1h >= ?5 AND output >= ?6
           AND reasoning >= ?7 AND unsplit >= ?8",
        params![
            row,
            t.input_uncached,
            t.cache_read,
            t.cache_write_5m,
            t.cache_write_1h,
            t.output,
            t.reasoning,
            t.unsplit,
            i64::from(call.reported_usd.is_some()),
            call.reported_usd,
            now_ms
        ],
    )?;
    Ok(n == 1)
}

/// A last event need not account for every remaining token (for example, a re-read log's
/// split changed). Keep that remainder; deleting it is neither adoption nor attribution.
fn delete_empty_rollup(tx: &Transaction<'_>, row: &str) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM usage WHERE id = ?1 AND events = 0
           AND input_uncached = 0 AND cache_read = 0 AND cache_write_5m = 0
           AND cache_write_1h = 0 AND output = 0 AND reasoning = 0 AND unsplit = 0",
        [row],
    )?;
    Ok(())
}

/// The `meta` key set once every ambiguous and unlinked rollup is keyed with its reason (RFC 0021
/// delivery 6): a store an older meter wrote is re-keyed on its first open by this one.
pub const REASON_KEYED_META: &str = "rollups_reason_keyed";

/// The `meta` key of an evidence backfill in progress: the start (ms) it re-reads the logs back
/// to (`sync --evidence-backfill`, RFC 0018 (b) and RFC 0021 (c)).
pub const BACKFILL_META: &str = "evidence_backfill_from_ms";

/// An evidence backfill's own state, made when one starts and emptied when it ends: how far each
/// log has been re-read (`offset` -1 once the whole file was), and the request keys it has adopted
/// so far, so a call a log repeats is adopted once.
pub const BACKFILL_DDL: &str = "
CREATE TABLE IF NOT EXISTS ev_backfill (
  path TEXT PRIMARY KEY, offset INTEGER NOT NULL, ctx TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS ev_backfill_seen (k INTEGER PRIMARY KEY);
-- Connection-local backing, reset at the start of each backfill invocation. No store migration.
CREATE TEMP TABLE IF NOT EXISTS ev_adoption_hours (hour_ms INTEGER PRIMARY KEY);
CREATE TEMP TABLE IF NOT EXISTS ev_adoption_backed (
  id TEXT PRIMARY KEY,
  input_uncached INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
  output INTEGER NOT NULL, reasoning INTEGER NOT NULL, unsplit INTEGER NOT NULL,
  events INTEGER NOT NULL
);
DELETE FROM temp.ev_adoption_hours;
DELETE FROM temp.ev_adoption_backed;
";

/// Load an hour once per invocation, using evidence_ts rather than a per-call store scan.
/// Both the loaded marker and backing credits live in the caller's transaction: a failed chunk
/// rolls them back too. A resumed invocation starts fresh from its committed evidence.
fn load_adoption_hour(tx: &Transaction<'_>, hour: i64) -> rusqlite::Result<()> {
    if tx.execute(
        "INSERT OR IGNORE INTO temp.ev_adoption_hours(hour_ms) VALUES(?1)",
        [hour],
    )? == 0
    {
        return Ok(());
    }
    let mut backed: BTreeMap<String, (Tokens, i64)> = BTreeMap::new();
    let mut st = tx.prepare_cached(&format!("{STORED} WHERE e.ts_ms >= ?1 AND e.ts_ms < ?2"))?;
    for call in st.query_map(params![hour, hour + crate::time::HOUR_MS], stored)? {
        let call = call?;
        let (k, p) = rollup_key(&call.dim, &call.actor, hour);
        let entry = backed.entry(k.id(p)).or_default();
        entry.0.add(&call.tokens);
        entry.1 += 1;
    }
    for (id, (tokens, events)) in backed {
        credit_adoption_backing(tx, &id, &tokens, events)?;
    }
    Ok(())
}

fn credit_adoption_backing(
    tx: &Transaction<'_>,
    id: &str,
    t: &Tokens,
    events: i64,
) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "INSERT INTO temp.ev_adoption_backed
           (id, input_uncached, cache_read, cache_write_5m, cache_write_1h, output,
            reasoning, unsplit, events)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           input_uncached = input_uncached + excluded.input_uncached,
           cache_read = cache_read + excluded.cache_read,
           cache_write_5m = cache_write_5m + excluded.cache_write_5m,
           cache_write_1h = cache_write_1h + excluded.cache_write_1h,
           output = output + excluded.output, reasoning = reasoning + excluded.reasoning,
           unsplit = unsplit + excluded.unsplit, events = events + excluded.events",
    )?
    .execute(params![
        id,
        t.input_uncached,
        t.cache_read,
        t.cache_write_5m,
        t.cache_write_1h,
        t.output,
        t.reasoning,
        t.unsplit,
        events
    ])?;
    Ok(())
}

/// Whether the store already holds this call's evidence: the same time, request id and logging.
/// A call a normal sync read from a log's tail before `evidence_from` (the hour the store migrated
/// in) is already counted; adopting it again would write an identical second row (issue 1229).
/// Two real calls can reuse a request id, but not at the same time and logging as well: that pair
/// is one call and a duplicate row.
fn has_evidence(tx: &Transaction<'_>, e: &Evidence, ts_ms: i64) -> rusqlite::Result<bool> {
    let Some(request) = e.request else {
        return Ok(false);
    };
    tx.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM evidence ev JOIN ev_dim d ON d.id = ev.dim
           WHERE ev.ts_ms = ?1 AND ev.request = ?2
             AND d.harness = ?3 AND d.model = ?4 AND d.machine = ?5
             AND d.repo IS ?6 AND d.branch IS ?7 AND d.precision = ?8)",
        params![
            ts_ms,
            request.as_slice(),
            e.dim.harness,
            e.dim.model,
            e.dim.machine,
            e.dim.repo,
            e.dim.branch,
            e.dim.precision
        ],
        |r| r.get(0),
    )
}

/// Gives one re-read call of an hour before `evidence_from` its evidence (an evidence backfill):
/// its tokens leave a rollup row that counted it before evidence (a frozen row, or one of an hour
/// before `evidence_from`) with the same logging (harness, model, machine, repo, branch, hour and
/// precision) and at least its tokens of every kind remaining beyond the row's evidence, for
/// the row its derived attribution names, and
/// its evidence row is written, all in the caller's transaction. A call no such row holds (its
/// usage was counted under other logging, or never) is left alone, as is one that already has its
/// evidence: adopting it again would write an identical second row (issue 1229). A backfill never
/// adds a token to a total or takes one from it. Returns whether the call was adopted.
#[allow(clippy::too_many_arguments)]
pub fn adopt(
    tx: &Transaction<'_>,
    intern: &mut Interner,
    e: &Evidence,
    ts_ms: i64,
    t: &Tokens,
    reported_usd: Option<f64>,
    evidence_from: i64,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    if has_evidence(tx, e, ts_ms)? {
        return Ok(false);
    }
    let hour = crate::time::hour_start(ts_ms);
    load_adoption_hour(tx, hour)?;
    let found: Option<String> = tx
        .prepare_cached(
            "SELECT u.id FROM usage u LEFT JOIN temp.ev_adoption_backed b ON b.id = u.id
             WHERE u.harness = ?1 AND u.model = ?2 AND u.machine = ?3 AND u.repo IS ?4
               AND (u.branch IS ?5 OR (?5 IS NULL AND u.branch_basis = 'ledger'))
               AND u.hour_ms = ?6 AND u.precision = ?7
               AND (u.actor_state IS NULL OR u.hour_ms < ?8)
               AND u.input_uncached - coalesce(b.input_uncached, 0) >= ?9
               AND u.cache_read - coalesce(b.cache_read, 0) >= ?10
               AND u.cache_write_5m - coalesce(b.cache_write_5m, 0) >= ?11
               AND u.cache_write_1h - coalesce(b.cache_write_1h, 0) >= ?12
               AND u.output - coalesce(b.output, 0) >= ?13
               AND u.reasoning - coalesce(b.reasoning, 0) >= ?14
               AND u.unsplit - coalesce(b.unsplit, 0) >= ?15
               AND u.events - coalesce(b.events, 0) >= 1
             ORDER BY u.id LIMIT 1",
        )?
        .query_row(
            params![
                e.dim.harness,
                e.dim.model,
                e.dim.machine,
                e.dim.repo,
                e.dim.branch,
                hour,
                e.dim.precision,
                evidence_from,
                t.input_uncached,
                t.cache_read,
                t.cache_write_5m,
                t.cache_write_1h,
                t.output,
                t.reasoning,
                t.unsplit
            ],
            |r| r.get(0),
        )
        .optional()?;
    let Some(row) = found else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE usage SET input_uncached = input_uncached - ?2, cache_read = cache_read - ?3,
           cache_write_5m = cache_write_5m - ?4, cache_write_1h = cache_write_1h - ?5,
           output = output - ?6, reasoning = reasoning - ?7, unsplit = unsplit - ?8,
           events = events - 1,
           usd_events = CASE WHEN usd_events IS NULL THEN NULL ELSE usd_events - ?9 END,
           reported_usd = CASE WHEN ?10 IS NULL OR reported_usd IS NULL THEN reported_usd
                               ELSE max(reported_usd - ?10, 0) END,
           updated_ms = ?11
         WHERE id = ?1",
        params![
            row,
            t.input_uncached,
            t.cache_read,
            t.cache_write_5m,
            t.cache_write_1h,
            t.output,
            t.reasoning,
            t.unsplit,
            i64::from(reported_usd.is_some()),
            reported_usd,
            now_ms
        ],
    )?;
    delete_empty_rollup(tx, &row)?;
    insert(tx, intern, e, ts_ms, t, reported_usd)?;
    let (key, p) = rollup_key(&e.dim, &e.actor, hour);
    let id = key.id(p);
    let mut rows = BTreeMap::new();
    rows.insert(
        (key, p),
        crate::store::Pending {
            squad: None,
            tokens: *t,
            usd: reported_usd,
            usd_events: i64::from(reported_usd.is_some()),
            events: 1,
        },
    );
    crate::store::upsert_rows(tx, &rows, now_ms)?;
    credit_adoption_backing(tx, &id, t, 1)?;
    Ok(true)
}

/// Queues every session and start folder with a call of evidence from `from_ms` for the
/// recompute pass: the backfill's "recomputing attribution" (RFC 0021 (c)).
pub fn queue_since(tx: &Transaction<'_>, from_ms: i64) -> rusqlite::Result<usize> {
    let s = tx.execute(
        "INSERT INTO ev_dirty(k)
         SELECT DISTINCT 's:' || lower(hex(session)) FROM evidence
         WHERE ts_ms >= ?1 AND session IS NOT NULL
         ON CONFLICT DO NOTHING",
        [from_ms],
    )?;
    let c = tx.execute(
        "INSERT INTO ev_dirty(k)
         SELECT DISTINCT 'c:' || c.path FROM evidence e JOIN ev_cwd c ON c.id = e.session_cwd
         WHERE e.ts_ms >= ?1
         ON CONFLICT DO NOTHING",
        [from_ms],
    )?;
    Ok(s + c)
}

/// Queues sessions and start folders for the recompute pass.
pub fn mark_dirty<'a>(
    tx: &Transaction<'_>,
    keys: impl IntoIterator<Item = &'a String>,
) -> rusqlite::Result<usize> {
    let mut st = tx.prepare_cached("INSERT INTO ev_dirty(k) VALUES(?1) ON CONFLICT DO NOTHING")?;
    let mut n = 0;
    for k in keys {
        n += st.execute([k])?;
    }
    Ok(n)
}

pub fn dirty_batch(c: &Connection, limit: usize) -> rusqlite::Result<Vec<String>> {
    let mut st = c.prepare_cached("SELECT k FROM ev_dirty ORDER BY k LIMIT ?1")?;
    st.query_map([limit as i64], |r| r.get(0))?.collect()
}

pub fn dirty_count(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row("SELECT count(*) FROM ev_dirty", [], |r| r.get(0))
}

/// At most this many duplicate hours are listed; the rest are counted in `hours_omitted`.
const DUPLICATE_HOURS: usize = 50;

/// One hour with duplicate evidence rows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DuplicateHour {
    pub hour_ms: i64,
    pub groups: i64,
    pub extra_rows: i64,
}

/// Duplicate evidence rows (issue 1229), for a dry-run report before any removal. A group is the
/// rows that share a time, logging and request id: two real calls with the same request id are
/// distinct when their times differ, and one with the same time and logging is one call counted
/// twice. `exact` counts the groups whose rows are identical in every column but the row id.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Duplicates {
    pub groups: i64,
    pub extra_rows: i64,
    pub exact_groups: i64,
    pub exact_extra_rows: i64,
    /// The hours that hold at least one group, oldest first, at most [`DUPLICATE_HOURS`].
    pub hours: Vec<DuplicateHour>,
    pub hours_omitted: usize,
}

/// Counts the duplicate evidence rows in the store, without writing anything.
pub fn duplicates(c: &Connection) -> rusqlite::Result<Duplicates> {
    let (groups, extra_rows) = c.query_row(
        "SELECT count(*), coalesce(sum(n - 1), 0) FROM (
           SELECT count(*) AS n FROM evidence
           WHERE request IS NOT NULL
           GROUP BY ts_ms, dim, request
           HAVING count(*) > 1
         )",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (exact_groups, exact_extra_rows) = c.query_row(
        "SELECT count(*), coalesce(sum(n - 1), 0) FROM (
           SELECT count(*) AS n FROM evidence
           WHERE request IS NOT NULL
           GROUP BY ts_ms, dim, actor, session, parent, request, cwd, session_cwd, copied,
                    input_uncached, cache_read, cache_write_5m, cache_write_1h, output,
                    reasoning, unsplit, reported_usd
           HAVING count(*) > 1
         )",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut st = c.prepare(&format!(
        "SELECT hour, count(*), coalesce(sum(n - 1), 0) FROM (
           SELECT (ts_ms / {h}) * {h} AS hour, count(*) AS n FROM evidence
           WHERE request IS NOT NULL
           GROUP BY ts_ms, dim, request
           HAVING count(*) > 1
         ) GROUP BY hour ORDER BY hour",
        h = crate::time::HOUR_MS
    ))?;
    let mut hours = st
        .query_map([], |r| {
            Ok(DuplicateHour {
                hour_ms: r.get(0)?,
                groups: r.get(1)?,
                extra_rows: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let hours_omitted = hours.len().saturating_sub(DUPLICATE_HOURS);
    hours.truncate(DUPLICATE_HOURS);
    Ok(Duplicates {
        groups,
        extra_rows,
        exact_groups,
        exact_extra_rows,
        hours,
        hours_omitted,
    })
}

/// A launch as one sync derived it ([`crate::ledger::Resolver::records`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchRecord {
    pub lkey: String,
    pub core: Option<String>,
    pub terminal: Option<String>,
    pub created_ms: Option<i64>,
    pub kind: Option<String>,
    pub bot: Option<String>,
    pub role: Option<String>,
    pub squad: Option<String>,
    pub lead: Option<String>,
    pub task: Option<String>,
    pub project: Option<String>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub agent: Option<String>,
    pub valid_from: Option<i64>,
    pub valid_to: Option<i64>,
    pub end_basis: Option<String>,
    /// `ledger` or `snapshot`.
    pub source: String,
    pub source_ref: Option<String>,
    /// A seat's bots from the attach ledger over time (`from-to:bot`, `;`-separated): a change
    /// moves its calls as a changed start row would.
    pub bound: Option<String>,
}

/// A session's link to a launch, as one sync derived it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRecord {
    /// The ledger's agent name.
    pub harness: String,
    /// The session's keyed hash, hex.
    pub session: String,
    pub lkey: String,
    pub basis: String,
    pub valid_from: Option<i64>,
    pub valid_to: Option<i64>,
    /// A session label a snapshot showed made this link (every `label` link, and a dsh-tui
    /// session's label link, kept at `session` basis): its row carries `seen_first`.
    pub sighted: bool,
}

/// What the snapshot showed of one launch at this sync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    pub lkey: String,
    pub cwd: Option<String>,
    pub agent: Option<String>,
}

/// A stored launch the hc snapshot showed at an earlier sync, read back as history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct History {
    pub lkey: String,
    pub core: Option<String>,
    pub terminal: String,
    pub created_ms: i64,
    pub valid_to: Option<i64>,
    pub end_basis: Option<String>,
    pub source: String,
    pub worktree: Option<String>,
    pub seen_last: Option<i64>,
    pub live_cwd: Option<String>,
    pub live_agent: Option<String>,
    /// A launch with no start row keeps the tag its snapshot's labels supplied (RFC 0026 (c)).
    pub kind: Option<String>,
    pub bot: Option<String>,
    pub role: Option<String>,
    /// Its `bound` timeline: the attach bindings, and the label sightings earlier syncs saw.
    pub bound: Option<String>,
}

/// Stored launches with a key: their ends, and what earlier snapshots saw of them.
pub fn history(c: &Connection) -> rusqlite::Result<Vec<History>> {
    let mut st = c.prepare(
        "SELECT lkey, core, terminal, created_ms, valid_to, end_basis, source, worktree, seen_last,
                live_cwd, live_agent, kind, bot, role, bound
         FROM launch WHERE terminal IS NOT NULL AND created_ms IS NOT NULL
         ORDER BY lkey",
    )?;
    st.query_map([], |r| {
        Ok(History {
            lkey: r.get(0)?,
            core: r.get(1)?,
            terminal: r.get(2)?,
            created_ms: r.get(3)?,
            valid_to: r.get(4)?,
            end_basis: r.get(5)?,
            source: r.get(6)?,
            worktree: r.get(7)?,
            seen_last: r.get(8)?,
            live_cwd: r.get(9)?,
            live_agent: r.get(10)?,
            kind: r.get(11)?,
            bot: r.get(12)?,
            role: r.get(13)?,
            bound: r.get(14)?,
        })
    })?
    .collect()
}

/// Session labels earlier snapshots saw: (agent, session hash hex, launch key).
pub fn label_history(c: &Connection) -> rusqlite::Result<Vec<(String, String, String)>> {
    let mut st = c.prepare(
        "SELECT harness, session, lkey FROM link WHERE basis = 'label' AND superseded_by IS NULL",
    )?;
    st.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            crate::event::hex(&r.get::<_, Vec<u8>>(1)?),
            r.get::<_, String>(2)?,
        ))
    })?
    .collect()
}

/// The dsh-tui session links earlier syncs kept (RFC 0026 (d)): each active `session` link of a
/// dsh-tui session, with whether a session label made it (`seen_first` set). Other harnesses'
/// `session` links come from ledger rows, read again each sync, so they are not replayed.
pub fn session_links(c: &Connection) -> rusqlite::Result<Vec<crate::ledger::SessionLink>> {
    let mut st = c.prepare(
        "SELECT harness, session, lkey, valid_from, valid_to, seen_first IS NOT NULL FROM link
         WHERE basis = 'session' AND harness = 'dsh-tui' AND superseded_by IS NULL ORDER BY id",
    )?;
    st.query_map([], |r| {
        Ok(crate::ledger::SessionLink {
            agent: r.get(0)?,
            session: crate::event::hex(&r.get::<_, Vec<u8>>(1)?),
            lkey: r.get(2)?,
            valid_from: r.get(3)?,
            valid_to: r.get(4)?,
            sighted: r.get(5)?,
        })
    })?
    .collect()
}

/// Every folder a stored call ran in or started in.
pub fn cwds(c: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut st = c.prepare("SELECT path FROM ev_cwd ORDER BY path")?;
    st.query_map([], |r| r.get(0))?.collect()
}

/// The project app homes found by earlier syncs.
pub fn known_homes(c: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut st = c.prepare("SELECT home FROM ledgers ORDER BY home")?;
    st.query_map([], |r| r.get(0))?.collect()
}

/// A link row's identity: (agent, session hash, launch key, basis).
type LinkKey = (String, Vec<u8>, String, String);

/// What [`persist`] changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Persisted {
    pub launches: usize,
    pub links: usize,
    pub dirty: usize,
}

type LaunchCmp = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    (Option<i64>, Option<i64>),
    (Option<String>, Option<String>),
    String,
    Option<String>,
);

fn cmp_of(l: &LaunchRecord) -> LaunchCmp {
    (
        l.kind.clone(),
        l.bot.clone(),
        l.role.clone(),
        l.squad.clone(),
        l.task.clone(),
        l.project.clone(),
        l.branch.clone(),
        l.worktree.clone(),
        (l.valid_from, l.valid_to),
        (l.agent.clone(), l.bound.clone()),
        l.source.clone(),
        l.end_basis.clone(),
    )
}

/// Writes one sync's derived launches and links, what the snapshot saw (`seen`), the project app
/// homes it found, and the dirty marks for every session and start folder whose launches or links
/// changed, in one transaction. A changed link keeps its old row, marked superseded.
#[allow(clippy::too_many_arguments)]
pub fn persist(
    tx: &Transaction<'_>,
    launches: &[LaunchRecord],
    links: &[LinkRecord],
    seen: &[Seen],
    gone: &HashMap<String, i64>,
    homes: &[String],
    now_ms: i64,
) -> rusqlite::Result<Persisted> {
    let mut out = Persisted::default();
    let mut stored: HashMap<String, (LaunchCmp, Option<String>, Option<String>)> = HashMap::new();
    {
        let mut st = tx.prepare(
            "SELECT lkey, kind, bot, role, squad, task, project, branch, worktree, valid_from,
                    valid_to, agent, bound, source, end_basis, live_cwd, live_agent FROM launch",
        )?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (
                    (
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        (r.get(9)?, r.get(10)?),
                        (r.get(11)?, r.get(12)?),
                        r.get(13)?,
                        r.get(14)?,
                    ),
                    r.get(15)?,
                    r.get(16)?,
                ),
            ))
        })?;
        for row in rows {
            let (k, v) = row?;
            stored.insert(k, v);
        }
    }
    let mut dirty: HashSet<String> = HashSet::new();
    let mut changed_launches: HashSet<&str> = HashSet::new();
    let seen_by: HashMap<&str, &Seen> = seen.iter().map(|s| (s.lkey.as_str(), s)).collect();
    for l in launches {
        let cmp = cmp_of(l);
        let live = seen_by.get(l.lkey.as_str());
        let (fields_changed, live_changed) = match stored.get(&l.lkey) {
            None => (true, true),
            Some((c, cwd, agent)) => (
                *c != cmp,
                live.is_some_and(|s| s.cwd != *cwd || s.agent != *agent),
            ),
        };
        if fields_changed {
            tx.prepare_cached(
                "INSERT INTO launch(lkey, core, terminal, created_ms, kind, bot, role, squad, lead,
                   task, project, branch, worktree, agent, valid_from, valid_to, end_basis,
                   source, source_ref, updated_ms, bound)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                   ?17, ?18, ?19, ?20, ?21)
                 ON CONFLICT(lkey) DO UPDATE SET kind = excluded.kind, bot = excluded.bot,
                   role = excluded.role, squad = excluded.squad, lead = excluded.lead,
                   task = excluded.task, project = excluded.project, branch = excluded.branch,
                   worktree = excluded.worktree, agent = excluded.agent,
                   valid_from = excluded.valid_from, valid_to = excluded.valid_to,
                   end_basis = excluded.end_basis, source = excluded.source,
                   source_ref = excluded.source_ref, updated_ms = excluded.updated_ms,
                   bound = excluded.bound",
            )?
            .execute(params![
                l.lkey,
                l.core,
                l.terminal,
                l.created_ms,
                l.kind,
                l.bot,
                l.role,
                l.squad,
                l.lead,
                l.task,
                l.project,
                l.branch,
                l.worktree,
                l.agent,
                l.valid_from,
                l.valid_to,
                l.end_basis,
                l.source,
                l.source_ref,
                now_ms,
                l.bound
            ])?;
            out.launches += 1;
        }
        if let Some(&after) = gone.get(&l.lkey) {
            tx.execute(
                "UPDATE launch SET gone_after = coalesce(gone_after, ?2) WHERE lkey = ?1",
                params![l.lkey, after],
            )?;
        }
        if let Some(s) = live {
            tx.prepare_cached(
                "UPDATE launch SET seen_first = coalesce(seen_first, ?2), seen_last = ?2,
                   live_cwd = ?3, live_agent = ?4 WHERE lkey = ?1",
            )?
            .execute(params![l.lkey, now_ms, s.cwd, s.agent])?;
        }
        if fields_changed || live_changed {
            changed_launches.insert(l.lkey.as_str());
            for c in [
                l.worktree.as_deref(),
                live.and_then(|s| s.cwd.as_deref()),
                stored.get(&l.lkey).and_then(|(_, cwd, _)| cwd.as_deref()),
            ]
            .into_iter()
            .flatten()
            {
                dirty.insert(format!("c:{c}"));
            }
        }
    }
    // Links: a new or changed one is written (the old row kept, superseded), and its session is
    // dirty; so is every session linked to a launch that changed.
    let mut active: HashMap<LinkKey, (i64, Option<i64>, Option<i64>, bool)> = HashMap::new();
    {
        let mut st = tx.prepare(
            "SELECT id, harness, session, lkey, basis, valid_from, valid_to,
                    seen_first IS NOT NULL FROM link
             WHERE superseded_by IS NULL",
        )?;
        let rows = st.query_map([], |r| {
            Ok((
                (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?),
                (r.get(0)?, r.get(5)?, r.get(6)?, r.get(7)?),
            ))
        })?;
        for row in rows {
            let (k, v) = row?;
            active.insert(k, v);
        }
    }
    for l in links {
        let Some(session) = from_hex(&l.session) else {
            continue;
        };
        let k = (
            l.harness.clone(),
            session.clone(),
            l.lkey.clone(),
            l.basis.clone(),
        );
        let label_seen = l.sighted && seen_by.contains_key(l.lkey.as_str());
        // A `session` link's `seen_first` says a session label made it (a dsh-tui session's):
        // it is set when the link is written, whether or not its terminal is live now, and
        // cleared when a row or header takes the link over.
        let marked = l.basis == "session";
        let id = match active.get(&k) {
            Some(&(id, from, to, sighted)) if from == l.valid_from && to == l.valid_to => {
                if marked && sighted && !l.sighted {
                    tx.execute(
                        "UPDATE link SET seen_first = NULL, seen_last = NULL WHERE id = ?1",
                        [id],
                    )?;
                    out.links += 1;
                    dirty.insert(format!("s:{}", l.session));
                }
                Some(id)
            }
            old => {
                tx.prepare_cached(
                    "INSERT INTO link(harness, session, lkey, basis, valid_from, valid_to)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                )?
                .execute(params![
                    l.harness,
                    session,
                    l.lkey,
                    l.basis,
                    l.valid_from,
                    l.valid_to
                ])?;
                let new = tx.last_insert_rowid();
                if let Some(&(old, _, _, _)) = old {
                    tx.execute(
                        "UPDATE link SET superseded_by = ?2 WHERE id = ?1",
                        params![old, new],
                    )?;
                    // The sightings follow the link only while a label still makes it.
                    if l.sighted {
                        tx.execute(
                            "UPDATE link SET seen_first = (SELECT seen_first FROM link WHERE id = ?1),
                               seen_last = (SELECT seen_last FROM link WHERE id = ?1) WHERE id = ?2",
                            params![old, new],
                        )?;
                    }
                }
                out.links += 1;
                dirty.insert(format!("s:{}", l.session));
                Some(new)
            }
        };
        if let (true, Some(id)) = (label_seen, id) {
            tx.execute(
                "UPDATE link SET seen_first = coalesce(seen_first, ?2), seen_last = ?2
                 WHERE id = ?1",
                params![id, now_ms],
            )?;
        } else if let (true, true, Some(id)) = (marked, l.sighted, id) {
            tx.execute(
                "UPDATE link SET seen_first = coalesce(seen_first, ?2) WHERE id = ?1",
                params![id, now_ms],
            )?;
        }
        if changed_launches.contains(l.lkey.as_str()) {
            dirty.insert(format!("s:{}", l.session));
        }
    }
    for h in homes {
        tx.execute(
            "INSERT INTO ledgers(home, found_ms) VALUES(?1, ?2) ON CONFLICT(home) DO NOTHING",
            params![h, now_ms],
        )?;
    }
    out.dirty = mark_dirty(tx, dirty.iter())?;
    Ok(out)
}

/// Records what the snapshot showed this sync when nothing else changed: each live launch's last
/// sighting, folder and harness.
pub fn touch_seen(tx: &Transaction<'_>, seen: &[Seen], now_ms: i64) -> rusqlite::Result<()> {
    let mut st = tx.prepare_cached(
        "UPDATE launch SET seen_first = coalesce(seen_first, ?2), seen_last = ?2, live_cwd = ?3,
           live_agent = ?4 WHERE lkey = ?1",
    )?;
    for s in seen {
        st.execute(params![s.lkey, now_ms, s.cwd, s.agent])?;
    }
    Ok(())
}

/// What [`prune`] removed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Pruned {
    pub evidence: usize,
    pub launches: usize,
    pub links: usize,
}

/// The bytes the evidence takes, its indexes included: measured by SQLite's `dbstat` when it is
/// built in, else [`BYTES_PER_CALL`] per row.
pub fn evidence_bytes(c: &Connection) -> rusqlite::Result<u64> {
    let measured: rusqlite::Result<Option<i64>> = c.query_row(
        "SELECT sum(pgsize) FROM dbstat WHERE name IN ('evidence', 'evidence_ts',
           'evidence_session', 'evidence_parent', 'evidence_session_cwd')",
        [],
        |r| r.get(0),
    );
    match measured {
        Ok(b) => Ok(b.unwrap_or(0).max(0) as u64),
        Err(_) => {
            let n: i64 = c.query_row("SELECT count(*) FROM evidence", [], |r| r.get(0))?;
            Ok(n.max(0) as u64 * BYTES_PER_CALL)
        }
    }
}

/// Keeps the evidence within its bounds (`days` and `max_bytes`), oldest whole day first, and
/// moves `evidence_from` past what went; drops closed launches and links older than
/// [`LINK_DAYS`]. The rollups stay. One transaction.
pub fn prune(
    tx: &Transaction<'_>,
    now_ms: i64,
    days: i64,
    max_bytes: u64,
) -> rusqlite::Result<Pruned> {
    use crate::time::{DAY_MS, day_start};
    let mut out = Pruned::default();
    let mut cut = day_start(now_ms) - (days - 1) * DAY_MS;
    out.evidence += tx.execute("DELETE FROM evidence WHERE ts_ms < ?1", [cut])?;
    let mut moved = out.evidence > 0;
    while evidence_bytes(tx)? > max_bytes {
        let Some(oldest): Option<i64> =
            tx.query_row("SELECT min(ts_ms) FROM evidence", [], |r| r.get(0))?
        else {
            break;
        };
        cut = cut.max(day_start(oldest) + DAY_MS);
        let n = tx.execute("DELETE FROM evidence WHERE ts_ms < ?1", [cut])?;
        out.evidence += n;
        moved = true;
        if n == 0 {
            break;
        }
    }
    if moved {
        let from: Option<i64> = tx
            .query_row("SELECT v FROM meta WHERE k = ?1", [FROM_META], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .and_then(|v| v.parse().ok());
        if from.is_none_or(|f| f < cut) {
            tx.execute(
                "INSERT INTO meta(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                params![FROM_META, cut.to_string()],
            )?;
        }
    }
    let old = now_ms - LINK_DAYS * DAY_MS;
    out.links = tx.execute(
        "DELETE FROM link WHERE valid_to IS NOT NULL AND valid_to < ?1",
        [old],
    )?;
    out.launches = tx.execute(
        "DELETE FROM launch WHERE valid_to IS NOT NULL AND valid_to < ?1",
        [old],
    )?;
    Ok(out)
}

/// Tokens of one harness by how they are attributed (RFC 0021 (d)'s four counts): rollups of an
/// hour before `evidence_from`, and every row written before schema 3 (`actor_state` null, the
/// frozen tags), count as before evidence, never as attributed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ActorTotals {
    pub tokens_attributed: i64,
    pub tokens_ambiguous: i64,
    pub tokens_unlinked: i64,
    pub tokens_before_evidence: i64,
}

/// [`ActorTotals`] per harness, over the rollups from `from_ms`.
pub fn actor_totals(
    c: &Connection,
    from_ms: i64,
) -> rusqlite::Result<BTreeMap<String, ActorTotals>> {
    let evidence_from: Option<i64> = c
        .query_row("SELECT v FROM meta WHERE k = ?1", [FROM_META], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .and_then(|v| v.parse().ok());
    let mut st = c.prepare(
        "SELECT harness, actor_state, hour_ms,
                input_uncached + cache_read + cache_write_5m + cache_write_1h + output + unsplit
         FROM usage WHERE hour_ms >= ?1",
    )?;
    let mut out: BTreeMap<String, ActorTotals> = BTreeMap::new();
    let rows = st.query_map([from_ms], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    for row in rows {
        let (harness, state, hour, tokens) = row?;
        let t = out.entry(harness).or_default();
        let before = evidence_from.is_none_or(|f| hour < f);
        match state.as_deref() {
            _ if before => t.tokens_before_evidence += tokens,
            Some("attributed") => t.tokens_attributed += tokens,
            Some("ambiguous") => t.tokens_ambiguous += tokens,
            Some("unlinked") => t.tokens_unlinked += tokens,
            _ => t.tokens_before_evidence += tokens,
        }
    }
    Ok(out)
}

/// When an evidence backfill ends: what each schema 3 rollup of an hour from `from_ms` to `to_ms`
/// (the old `evidence_from`) holds beyond what its evidence implies moves to that hour's frozen
/// row (no attribution), so it counts as before evidence, never as attributed with no evidence
/// behind it. That part is usage whose evidence a retention bound pruned and that no log gave
/// back: a Codex thread (its deltas carry no request identity a rerun could adopt), or a log gone.
/// Totals never change. Returns the calls moved.
pub fn freeze_unbacked(
    tx: &Transaction<'_>,
    from_ms: i64,
    to_ms: i64,
    now_ms: i64,
) -> rusqlite::Result<u64> {
    let implied = implied_rollups(tx)?;
    struct Row {
        id: String,
        key: RollupKey,
        precision: Precision,
        squad: Option<String>,
        tokens: Tokens,
        events: i64,
        usd: Option<f64>,
        usd_events: i64,
    }
    let rows: Vec<Row> = {
        let mut st = tx.prepare(
            "SELECT id, bot, role, harness, model, machine, repo, branch, hour_ms, precision, squad,
                    input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning,
                    unsplit, events, reported_usd, coalesce(usd_events, 0)
             FROM usage WHERE actor_state IS NOT NULL AND hour_ms >= ?1 AND hour_ms < ?2",
        )?;
        st.query_map(params![from_ms, to_ms], |r| {
            Ok(Row {
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
                    squad: None,
                    attr: None,
                },
                precision: if r.get::<_, String>(9)? == "total_only" {
                    Precision::TotalOnly
                } else {
                    Precision::Exact
                },
                squad: r.get(10)?,
                tokens: Tokens {
                    input_uncached: r.get(11)?,
                    cache_read: r.get(12)?,
                    cache_write_5m: r.get(13)?,
                    cache_write_1h: r.get(14)?,
                    output: r.get(15)?,
                    reasoning: r.get(16)?,
                    unsplit: r.get(17)?,
                },
                events: r.get(18)?,
                usd: r.get(19)?,
                usd_events: r.get(20)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?
    };
    let mut moved = 0u64;
    for row in rows {
        let (want, want_events) = implied.get(&row.id).copied().unwrap_or_default();
        let t = &row.tokens;
        let extra = Tokens {
            input_uncached: t.input_uncached - want.input_uncached,
            cache_read: t.cache_read - want.cache_read,
            cache_write_5m: t.cache_write_5m - want.cache_write_5m,
            cache_write_1h: t.cache_write_1h - want.cache_write_1h,
            output: t.output - want.output,
            reasoning: t.reasoning - want.reasoning,
            unsplit: t.unsplit - want.unsplit,
        };
        let events = row.events - want_events;
        let parts = [
            extra.input_uncached,
            extra.cache_read,
            extra.cache_write_5m,
            extra.cache_write_1h,
            extra.output,
            extra.reasoning,
            extra.unsplit,
        ];
        // Nothing beyond the evidence, or a row its evidence outgrows (never written so): left.
        if events <= 0 || parts.iter().any(|&n| n < 0) {
            continue;
        }
        // A row with no evidence at all moves whole, its reported amount too; a row partly backed
        // keeps its amount, which the calls behind its evidence reported.
        let whole = want_events == 0;
        let (usd, usd_events) = if whole {
            (row.usd, row.usd_events)
        } else {
            (None, 0)
        };
        tx.execute(
            "UPDATE usage SET input_uncached = input_uncached - ?2, cache_read = cache_read - ?3,
               cache_write_5m = cache_write_5m - ?4, cache_write_1h = cache_write_1h - ?5,
               output = output - ?6, reasoning = reasoning - ?7, unsplit = unsplit - ?8,
               events = events - ?9, usd_events = coalesce(usd_events, 0) - ?10,
               reported_usd = CASE WHEN ?11 THEN NULL ELSE reported_usd END, updated_ms = ?12
             WHERE id = ?1",
            params![
                row.id,
                extra.input_uncached,
                extra.cache_read,
                extra.cache_write_5m,
                extra.cache_write_1h,
                extra.output,
                extra.reasoning,
                extra.unsplit,
                events,
                usd_events,
                whole,
                now_ms
            ],
        )?;
        delete_empty_rollup(tx, &row.id)?;
        let mut frozen = BTreeMap::new();
        frozen.insert(
            (row.key, row.precision),
            crate::store::Pending {
                squad: row.squad,
                tokens: extra,
                usd,
                usd_events,
                events,
            },
        );
        crate::store::upsert_rows(tx, &frozen, now_ms)?;
        moved += events as u64;
    }
    Ok(moved)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResidueCounts {
    pub rows: usize,
    pub tokens: i64,
    pub reasoning_tokens: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResidueReport {
    pub totals: ResidueCounts,
    /// Residue grouped by harness and UTC day.
    pub by_day: BTreeMap<(String, String), ResidueCounts>,
    pub discrepancy_rows: usize,
}

/// Inventory rows with actor state whose tokens exceed their evidence at equal event counts.
/// Rows below their evidence in any column or in events count as discrepancies.
pub fn unbacked_residue(
    c: &Connection,
    from_ms: i64,
    to_ms: i64,
) -> rusqlite::Result<ResidueReport> {
    let implied = implied_rollups(c)?;
    let mut st = c.prepare(
        "SELECT id, harness, hour_ms, input_uncached, cache_read, cache_write_5m, cache_write_1h,
                output, reasoning, unsplit, events
         FROM usage WHERE actor_state IS NOT NULL AND hour_ms >= ?1 AND hour_ms < ?2",
    )?;
    let mut rows = st.query(params![from_ms, to_ms])?;
    let mut report = ResidueReport::default();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let (want, want_events) = implied.get(&id).copied().unwrap_or_default();
        let extra = Tokens {
            input_uncached: row.get::<_, i64>(3)? - want.input_uncached,
            cache_read: row.get::<_, i64>(4)? - want.cache_read,
            cache_write_5m: row.get::<_, i64>(5)? - want.cache_write_5m,
            cache_write_1h: row.get::<_, i64>(6)? - want.cache_write_1h,
            output: row.get::<_, i64>(7)? - want.output,
            reasoning: row.get::<_, i64>(8)? - want.reasoning,
            unsplit: row.get::<_, i64>(9)? - want.unsplit,
        };
        let events = row.get::<_, i64>(10)? - want_events;
        let parts = [
            extra.input_uncached,
            extra.cache_read,
            extra.cache_write_5m,
            extra.cache_write_1h,
            extra.output,
            extra.reasoning,
            extra.unsplit,
        ];
        if events < 0 || parts.iter().any(|&n| n < 0) {
            report.discrepancy_rows += 1;
        } else if events == 0 && parts.iter().any(|&n| n > 0) {
            let day = crate::time::format_day(row.get(2)?);
            let day_counts = report.by_day.entry((row.get(1)?, day)).or_default();
            for counts in [&mut report.totals, day_counts] {
                counts.rows += 1;
                counts.tokens += extra.total();
                counts.reasoning_tokens += extra.reasoning;
            }
        }
    }
    Ok(report)
}

/// The rollups the evidence implies, per row id: what every schema 3 row of an hour from
/// `evidence_from` must hold (a check, and the tests').
pub fn implied_rollups(c: &Connection) -> rusqlite::Result<BTreeMap<String, (Tokens, i64)>> {
    let mut out: BTreeMap<String, (Tokens, i64)> = BTreeMap::new();
    for s in all(c)? {
        let (k, p) = rollup_key(&s.dim, &s.actor, crate::time::hour_start(s.ts_ms));
        let e = out.entry(k.id(p)).or_default();
        e.0.add(&s.tokens);
        e.1 += 1;
    }
    Ok(out)
}

/// The schema 3 rollups as stored, per row id, from `from_ms`.
pub fn stored_rollups(
    c: &Connection,
    from_ms: i64,
) -> rusqlite::Result<BTreeMap<String, (Tokens, i64)>> {
    let mut st = c.prepare(
        "SELECT id, input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning,
                unsplit, events
         FROM usage WHERE actor_state IS NOT NULL AND hour_ms >= ?1",
    )?;
    st.query_map([from_ms], |r| {
        Ok((
            r.get::<_, String>(0)?,
            (
                Tokens {
                    input_uncached: r.get(1)?,
                    cache_read: r.get(2)?,
                    cache_write_5m: r.get(3)?,
                    cache_write_1h: r.get(4)?,
                    output: r.get(5)?,
                    reasoning: r.get(6)?,
                    unsplit: r.get(7)?,
                },
                r.get(8)?,
            ),
        ))
    })?
    .collect()
}

#[cfg(test)]
mod adoption_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231_case_2_shape_and_keys_differ() {
        // RFC 4231 test case 2 uses a short key; with a 32-byte zero-padded key the HMAC is the
        // same function, so check it against a key of "Jefe" padded with zeros.
        let mut key = [0u8; 32];
        key[..4].copy_from_slice(b"Jefe");
        let mac = hmac(&key, b"what do ya want for nothing?");
        assert_eq!(
            crate::event::hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        let a = SessionKey([1u8; 32]);
        let b = SessionKey([2u8; 32]);
        assert_ne!(a.hash("claude", "s"), b.hash("claude", "s"));
        assert_ne!(a.hash("claude", "s"), a.hash("codex", "s"));
        assert_eq!(a.hex("claude", "s").len(), 32);
        assert_eq!(
            SessionKey::from_hex(&a.to_hex()).unwrap().hash("x", "y"),
            a.hash("x", "y")
        );
        assert_eq!(format!("{a:?}"), "SessionKey(..)");
    }

    // The Reviewer's delta L4 on PR 849: keys come from the random source, so keys made in one
    // instant differ (a time seed would repeat them).
    #[test]
    fn keys_made_at_once_all_differ() {
        let keys: std::collections::HashSet<String> = (0..64)
            .map(|_| SessionKey::random().unwrap().to_hex())
            .collect();
        assert_eq!(keys.len(), 64);
    }

    #[test]
    fn a_filled_branch_comes_only_from_a_worker_of_a_harness_that_logs_none() {
        use crate::ledger::Tag;
        let tag = |bot: &str, kind: Kind| Tag {
            label: false,
            bot: bot.into(),
            kind,
            role: None,
            squad: None,
            unrecorded: Vec::new(),
            task: None,
            project: None,
            branch: Some("feat/x".into()),
            lead: None,
            requested_agent: None,
            requested_model: None,
            requested_effort: None,
            swap: false,
            override_: false,
        };
        let worker = tag("b-dev", Kind::Worker);
        let seat = tag("b-main", Kind::Seat);
        let r = |t: &Tag| Resolution::Tag(t.clone(), Basis::Worktree);
        assert_eq!(
            Actor::derive(&r(&worker), "dsh-tui", None)
                .filled_branch
                .as_deref(),
            Some("feat/x")
        );
        assert_eq!(
            Actor::derive(&r(&worker), "omp", None)
                .filled_branch
                .as_deref(),
            Some("feat/x")
        );
        // Logged branches are never replaced; Claude and Codex are never filled; seats never.
        assert_eq!(
            Actor::derive(&r(&worker), "dsh-tui", Some("main")).filled_branch,
            None
        );
        assert_eq!(
            Actor::derive(&r(&worker), "claude-code", None).filled_branch,
            None
        );
        assert_eq!(Actor::derive(&r(&seat), "omp", None).filled_branch, None);
        let dim = Dim {
            harness: "dsh-tui".into(),
            precision: "exact".into(),
            ..Dim::default()
        };
        let a = Actor::derive(&r(&worker), "dsh-tui", None);
        let (k, _) = rollup_key(&dim, &a, 0);
        assert_eq!(k.branch.as_deref(), Some("feat/x"));
        assert_eq!(k.attr.unwrap().branch_basis, "ledger");
        let (k, _) = rollup_key(
            &Dim {
                branch: Some("main".into()),
                ..dim.clone()
            },
            &Actor::derive(&r(&worker), "dsh-tui", Some("main")),
            0,
        );
        assert_eq!(k.attr.unwrap().branch_basis, "log");
        let (k, _) = rollup_key(&dim, &Actor::derive(&Resolution::Unlinked, "omp", None), 0);
        assert_eq!(
            (k.branch, k.attr.unwrap().branch_basis.as_str()),
            (None, "none")
        );
    }
}
