//! Antigravity (`agy`) conversations: `~/.gemini/antigravity-cli/conversations/<id>.db`.
//!
//! One SQLite database per conversation. `gen_metadata.data` is an `exa.cortex_pb`
//! `CortexStepGeneratorMetadata` blob whose `chat_model.usage` carries the provider's own token
//! counts (input, cache read and write, output, and the part of output spent thinking). The row has
//! no time: `gen_metadata` names the `steps` it covers, and each step's metadata carries the call's
//! timestamp. `trajectory_metadata_blob` carries the conversation's folder, repository and branch.
//!
//! The blobs are decoded here with a small protobuf reader rather than a schema compiler: the
//! format is private, changes with the CLI, and a field the meter does not know is skipped. An
//! unknown shape is refused: it makes the source `unsupported` with a named reason instead of
//! counting zero.
//!
//! Nothing here writes the conversation data: it is opened read-only with a busy timeout, and
//! checkpoint on close is off. A database in WAL mode may still have its `-wal` and `-shm`
//! sidecars created or updated by a read-only SQLite open; the database bytes are not rewritten.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::event::{Precision, Tokens, UsageEvent, key_hash};
use crate::sources::clip;
use crate::time::DAY_MS;

pub const HARNESS: &str = "agy";

/// How far a conversation's time may be from the sync and still be counted (a clock skew guard).
const MAX_SKEW_MS: i64 = 2 * DAY_MS;
/// A count above this is not a token count: it is a negative int64 written as a varint, or
/// corruption. Either way its call is refused, never counted as `i64::MAX`.
const MAX_CALL_TOKENS: u64 = 1_000_000_000_000;
/// The `ModelUsageStats` fields the evidence names. A block with none of them is a shape this
/// meter does not know; a block with only some (a model and no counts yet) is a known zero call.
const KNOWN_USAGE_FIELDS: [u64; 16] = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17];
/// A generation row with no usage block yet is incomplete while its database still changes. After
/// this long, the row is taken as final (a generation that failed before a model call).
const INCOMPLETE_MS: i64 = 30 * 60 * 1000;

/// A conversation's read cursor, kept in the file row's JSON context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgyCtx {
    /// The highest `gen_metadata.idx` read. A refused or incomplete row keeps this below itself,
    /// so the next run reads it again; rows above it are read then too, and the dedupe key drops
    /// the repeats.
    #[serde(default = "no_generation")]
    pub max_gen: i64,
    /// The first step time of the row at [`AgyCtx::max_gen`], or 0 when that row has none, or -1
    /// when an older context did not record it. Checked each run: a missing row or a different
    /// time means the conversation was rewound and refilled, so it is read from the start again.
    #[serde(default = "no_generation")]
    pub cursor_ts: i64,
}

/// Before the first read nothing is counted, and the first row is index 0.
fn no_generation() -> i64 {
    -1
}

impl Default for AgyCtx {
    fn default() -> AgyCtx {
        AgyCtx {
            max_gen: no_generation(),
            cursor_ts: no_generation(),
        }
    }
}

/// Why a transcript was not read. The message never names a path, account or machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The database's shape is not one this meter knows: its usage is unknown, never zero.
    Shape(String),
    /// The database could not be opened or read this time; retry on the next sync.
    Unreadable(String),
}

/// What one read of a conversation database produced.
#[derive(Debug, Default)]
pub struct Read {
    pub events: Vec<UsageEvent>,
    /// For each call, the hashes it could have been counted under before its earliest time arrived.
    pub(crate) later_step_keys: HashMap<String, Vec<i64>>,
    /// The highest `gen_metadata.idx` processed. A refused or incomplete row leaves it below
    /// that row, so the next sync reads it again instead of losing its usage.
    pub max_gen: i64,
    /// The first step time of the row at [`Read::max_gen`] (0 when it has none, -1 at no row).
    pub cursor_ts: i64,
    /// Rows refused or still being written. They hold the cursor, while the rows after them are
    /// still counted; the next sync re-reads them.
    pub held: i64,
    /// The deadline cut the read short; the next sync continues above [`Read::max_gen`].
    pub stopped: bool,
    /// A row or the file had an unknown shape. The rows already read still count.
    pub shape: Option<String>,
}

/// One protobuf field. Only the wire types the agy blobs use are kept.
struct Field<'a> {
    no: u64,
    wire: u8,
    varint: u64,
    bytes: &'a [u8],
}

fn varint(b: &[u8], at: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    let mut shift = 0u32;
    loop {
        let c = *b.get(*at)?;
        *at += 1;
        v |= u64::from(c & 0x7f) << shift;
        if c & 0x80 == 0 {
            return Some(v);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

/// A protobuf message as its fields, in wire order. Groups and field 0 are refused: the agy
/// descriptors use neither.
fn fields(b: &[u8]) -> Option<Vec<Field<'_>>> {
    let mut out = Vec::with_capacity(8);
    let mut at = 0usize;
    while at < b.len() {
        let key = varint(b, &mut at)?;
        let no = key >> 3;
        let wire = (key & 7) as u8;
        if no == 0 || no > 100_000 {
            return None;
        }
        let mut f = Field {
            no,
            wire,
            varint: 0,
            bytes: &[],
        };
        match wire {
            0 => f.varint = varint(b, &mut at)?,
            1 => {
                let end = at.checked_add(8)?;
                f.bytes = b.get(at..end)?;
                at = end;
            }
            2 => {
                let n = varint(b, &mut at)?;
                let end = at.checked_add(usize::try_from(n).ok()?)?;
                f.bytes = b.get(at..end)?;
                at = end;
            }
            5 => {
                let end = at.checked_add(4)?;
                f.bytes = b.get(at..end)?;
                at = end;
            }
            _ => return None,
        }
        out.push(f);
        if out.len() > 100_000 {
            return None;
        }
    }
    Some(out)
}

fn sub<'a>(fs: &'a [Field<'a>], no: u64) -> Option<&'a [u8]> {
    fs.iter()
        .find(|f| f.no == no && f.wire == 2)
        .map(|f| f.bytes)
}

fn subs<'a>(fs: &'a [Field<'a>], no: u64) -> impl Iterator<Item = &'a [u8]> + 'a {
    fs.iter()
        .filter(move |f| f.no == no && f.wire == 2)
        .map(|f| f.bytes)
}

fn text(b: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(b).ok()?.trim();
    if s.is_empty() {
        return None;
    }
    Some(clip(s, 512))
}

fn uint(fs: &[Field<'_>], no: u64) -> u64 {
    fs.iter()
        .filter(|f| f.no == no && f.wire == 0)
        .map(|f| f.varint)
        .next()
        .unwrap_or(0)
}

/// A timestamp message (`seconds`, `nanos`): epoch ms, or None when it is not one.
fn timestamp(b: &[u8]) -> Option<i64> {
    let fs = fields(b)?;
    let secs = fs
        .iter()
        .find(|f| f.no == 1 && f.wire == 0)
        .map(|f| f.varint)?;
    let nanos = fs
        .iter()
        .find(|f| f.no == 2 && f.wire == 0)
        .map_or(0, |f| f.varint.min(999_999_999));
    let secs = i64::try_from(secs).ok()?;
    if secs <= 0 {
        return None;
    }
    Some(secs.saturating_mul(1000) + (nanos / 1_000_000) as i64)
}

/// `file:///work/app` → `/work/app`, percent escapes decoded. None for a non-file URI.
fn file_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = bytes.get(i + 1..i + 3)
            && let Ok(s) = std::str::from_utf8(hex)
            && let Ok(v) = u8::from_str_radix(s, 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    let s = String::from_utf8(out).ok()?;
    (!s.is_empty()).then_some(clip(&s, 1024))
}

/// Where a conversation ran: folder, repo and branch, from `workspaces[0]`.
#[derive(Debug, Default)]
struct Workspace {
    cwd: Option<String>,
    repo: Option<String>,
    branch: Option<String>,
}

fn trajectory(blob: &[u8]) -> Option<Workspace> {
    let fs = fields(blob)?;
    let Some(ws) = sub(&fs, 1) else {
        // A conversation outside a project has no workspace: still a known shape.
        return Some(Workspace::default());
    };
    let wf = fields(ws)?;
    let cwd = sub(&wf, 1)
        .and_then(text)
        .as_deref()
        .and_then(file_path)
        .or_else(|| sub(&wf, 2).and_then(text).as_deref().and_then(file_path));
    let branch = sub(&wf, 4).and_then(text);
    // repository: 1 name (`owner/repo`), 2 URL. Only the URL names a host.
    let repo = sub(&wf, 3)
        .and_then(fields)
        .and_then(|rf| sub(&rf, 2).and_then(text))
        .and_then(|url| crate::repo::normalize_remote(&url));
    Some(Workspace { cwd, repo, branch })
}

/// One `gen_metadata.data` row, decoded as far as it can be.
#[derive(Debug)]
enum Decoded {
    /// A generation with a usage block and the steps it covers.
    Call {
        model: Option<String>,
        tokens: Tokens,
        steps: Vec<i64>,
    },
    /// A row whose usage block is not written yet (or absent): it may be updated in place.
    Incomplete { steps: Vec<i64> },
}

/// `ModelUsageStats` inside `ChatModelMetadata.usage`. Input excludes cache reads (the real rows
/// show a cache read larger than input, so input cannot include it) and output includes thinking.
fn usage(b: &[u8]) -> Result<Tokens, String> {
    let fs = fields(b).ok_or("an agy usage block is not the shape this meter reads")?;
    if !fs.iter().any(|f| KNOWN_USAGE_FIELDS.contains(&f.no)) {
        return Err("an agy usage block has none of the fields this meter reads".into());
    }
    let count = |no| -> Result<i64, String> {
        let v = uint(&fs, no);
        if v > MAX_CALL_TOKENS {
            return Err("an agy token count is out of range".into());
        }
        Ok(v as i64)
    };
    let output = count(3)?;
    Ok(Tokens {
        input_uncached: count(2)?,
        cache_read: count(5)?,
        cache_write_5m: count(4)?,
        cache_write_1h: 0,
        output,
        // Thinking is part of output. Never let a bad row make it larger than the output.
        reasoning: count(9)?.min(output),
        unsplit: 0,
    })
}

/// The model a `ChatModelMetadata` names: response model, full response model, then display name.
fn model_of(fs: &[Field<'_>]) -> Option<String> {
    [19u64, 22, 21]
        .into_iter()
        .find_map(|no| subs(fs, no).next())
        .and_then(text)
}

/// Decodes one `gen_metadata.data` row. A model blob that does not parse, or a non-empty usage
/// block with none of the known fields, is an unknown shape, never a zero-token call.
fn generation(data: &[u8]) -> Result<Decoded, String> {
    let fs = fields(data).ok_or("an agy generation blob is not the shape this meter reads")?;
    let mut steps = Vec::new();
    for f in &fs {
        match (f.no, f.wire) {
            (2, 2) => {
                let mut at = 0usize;
                while at < f.bytes.len() {
                    let Some(v) = varint(f.bytes, &mut at) else {
                        return Err("an agy generation names steps this meter cannot read".into());
                    };
                    steps.push(i64::try_from(v).unwrap_or(i64::MAX));
                }
            }
            (2, 0) => steps.push(i64::try_from(f.varint).unwrap_or(i64::MAX)),
            _ => {}
        }
    }
    for cm in subs(&fs, 1) {
        let cf =
            fields(cm).ok_or("an agy model metadata blob is not the shape this meter reads")?;
        let Some(u) = sub(&cf, 4) else {
            continue;
        };
        if u.is_empty() {
            continue; // a usage block with no fields yet: incomplete, not zero
        }
        let tokens = usage(u)?;
        return Ok(Decoded::Call {
            model: model_of(&cf),
            tokens,
            steps,
        });
    }
    Ok(Decoded::Incomplete { steps })
}

/// A step's metadata: field 1 is the time it started.
fn step_time(metadata: &[u8]) -> Option<i64> {
    let fs = fields(metadata)?;
    let t = sub(&fs, 1)?;
    timestamp(t)
}

fn mtime_ms(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// The newest write time of a database and its write-ahead log. A WAL-only row does not move the
/// database file's mtime, so judging a generation's age by the main file alone would pass it. An
/// empty WAL is ignored: a read-only open may create one, and it holds no row.
fn newest_mtime_ms(path: &Path) -> Option<i64> {
    let wal = path.file_name().and_then(|n| {
        let p = path.with_file_name(format!("{}-wal", n.to_string_lossy()));
        let m = std::fs::metadata(&p).ok()?;
        (m.len() > 0).then(|| mtime_ms(&p)).flatten()
    });
    let main = mtime_ms(path);
    match wal {
        Some(w) => Some(main.map_or(w, |m| m.max(w))),
        None => main,
    }
}

/// The step times for `wanted`, in chunks under SQLite's variable limit. None when the deadline
/// passed before every chunk was read.
fn step_times(
    conn: &Connection,
    wanted: &[i64],
    deadline: Option<Instant>,
) -> Result<Option<std::collections::HashMap<i64, i64>>, Failure> {
    let unreadable = || Failure::Unreadable("an agy transcript could not be read this time".into());
    let mut times = std::collections::HashMap::new();
    for chunk in wanted.chunks(400) {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            return Ok(None);
        }
        let list = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut stmt = conn
            .prepare(&format!(
                "SELECT idx, metadata FROM steps WHERE idx IN ({list})"
            ))
            .map_err(|_| unreadable())?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(chunk.iter()))
            .map_err(|_| unreadable())?;
        while let Some(r) = rows.next().map_err(|_| unreadable())? {
            let Ok(idx) = r.get::<_, i64>(0) else {
                continue;
            };
            let Ok(md) = r.get::<_, Vec<u8>>(1) else {
                continue;
            };
            if let Some(t) = step_time(&md) {
                times.insert(idx, t);
            }
        }
    }
    Ok(Some(times))
}

/// The first step time a generation row names, or None when it names no timed step.
fn first_step_time(conn: &Connection, data: &[u8]) -> Result<Option<i64>, Failure> {
    let steps = match generation(data) {
        Ok(Decoded::Call { steps, .. }) | Ok(Decoded::Incomplete { steps }) => steps,
        _ => return Ok(None),
    };
    let Some(times) = step_times(conn, &steps, None)? else {
        return Ok(None);
    };
    Ok(steps.iter().filter_map(|i| times.get(i)).min().copied())
}

/// Opens one conversation database read-only: no writes, no checkpoint on close, and a query-only
/// connection as the second guard. A small helper so a test can assert the mode on a writable file.
fn open_read_only(path: &Path) -> Result<Connection, Failure> {
    let unreadable = || Failure::Unreadable("an agy transcript could not be read this time".into());
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| Failure::Unreadable("an agy transcript could not be opened this time".into()))?;
    conn.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )
    .map_err(|_| unreadable())?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| unreadable())?;
    conn.pragma_update(None, "query_only", "ON")
        .map_err(|_| unreadable())?;
    Ok(conn)
}

fn table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>, Failure> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| Failure::Unreadable("an agy transcript could not be read this time".into()))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|_| Failure::Unreadable("an agy transcript could not be read this time".into()))?;
    let mut out = HashSet::new();
    for c in rows {
        out.insert(c.map_err(|_| {
            Failure::Unreadable("an agy transcript could not be read this time".into())
        })?);
    }
    Ok(out)
}

/// Checks the tables and columns the reader needs. An old or a newer shape is refused by name.
fn check_shape(conn: &Connection) -> Result<(), Failure> {
    for (table, columns) in [
        ("trajectory_metadata_blob", &["data"][..]),
        ("steps", &["idx", "metadata"][..]),
        ("gen_metadata", &["idx", "data"][..]),
    ] {
        let cols = table_columns(conn, table)?;
        if cols.is_empty() {
            return Err(Failure::Shape(format!(
                "the agy transcript schema is not the one this meter reads: no {table} table"
            )));
        }
        for c in columns {
            if !cols.contains(*c) {
                return Err(Failure::Shape(format!(
                    "the agy transcript schema is not the one this meter reads: {table}.{c} is \
                     missing"
                )));
            }
        }
    }
    Ok(())
}

/// Reads every generation above `cursor` from one conversation database. The file is never
/// written; `deadline` stops the read between rows. A refused or incomplete row keeps the cursor
/// below it, so a later sync reads it again rather than losing its usage.
pub fn read(
    path: &Path,
    cursor: i64,
    cursor_ts: i64,
    now: i64,
    deadline: Instant,
) -> Result<Read, Failure> {
    let unreadable = || Failure::Unreadable("an agy transcript could not be read this time".into());
    // A row with no usage block yet waits while its database (or its WAL) keeps changing, and is
    // taken as a failed generation once both have been quiet for INCOMPLETE_MS.
    let db_recent = newest_mtime_ms(path).is_none_or(|t| now.saturating_sub(t) < INCOMPLETE_MS);
    let conn = open_read_only(path)?;
    check_shape(&conn)?;
    let blob: Vec<u8> = conn
        .query_row(
            "SELECT data FROM trajectory_metadata_blob WHERE id = 'main'",
            [],
            |r| r.get(0),
        )
        .or_else(|_| {
            conn.query_row(
                "SELECT data FROM trajectory_metadata_blob LIMIT 1",
                [],
                |r| r.get(0),
            )
        })
        .map_err(|_| Failure::Shape("an agy transcript has no trajectory metadata".into()))?;
    let workspace = trajectory(&blob).ok_or_else(|| {
        Failure::Shape(
            "an agy transcript's trajectory metadata is not the shape this meter reads".into(),
        )
    })?;
    let conversation = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| clip(s, 128))
        .filter(|s| !s.is_empty());
    let max_db: i64 = conn
        .query_row("SELECT coalesce(max(idx), -1) FROM gen_metadata", [], |r| {
            r.get(0)
        })
        .map_err(|_| unreadable())?;
    // A conversation whose highest index fell below the cursor, or whose cursor row is missing or
    // names a different first step, was reset, compacted or undone, possibly refilled again before
    // this sync. Read from index -1 (so 0 is included); the step-time key drops every unchanged
    // row, and a reused index with a new call has a new step time and counts.
    let mut from = cursor;
    if max_db < cursor {
        from = -1;
    } else if cursor >= 0 {
        let same = if cursor_ts < 0 {
            false // an older context did not record the cursor row's time: scan once more
        } else {
            match conn
                .query_row(
                    "SELECT data FROM gen_metadata WHERE idx = ?1",
                    [cursor],
                    |r| r.get::<_, Vec<u8>>(0),
                )
                .optional()
                .map_err(|_| unreadable())?
            {
                None => false,
                Some(data) => {
                    let ts = first_step_time(&conn, &data)?;
                    match (cursor_ts, ts) {
                        (0, None) => true,
                        (c, Some(t)) => c == t,
                        _ => false,
                    }
                }
            }
        };
        if !same {
            from = -1;
        }
    }
    let next_ts = if from >= 0 { cursor_ts } else { -1 };
    let mut stmt = conn
        .prepare("SELECT idx, data FROM gen_metadata WHERE idx > ?1 ORDER BY idx")
        .map_err(|_| unreadable())?;
    let mut rows = stmt.query([from]).map_err(|_| unreadable())?;
    let mut gens: Vec<(i64, Vec<u8>)> = Vec::new();
    let mut stopped = false;
    while let Some(r) = rows.next().map_err(|_| unreadable())? {
        let (idx, data): (i64, Vec<u8>) = r
            .get(0)
            .and_then(|i| r.get(1).map(|d| (i, d)))
            .map_err(|_| unreadable())?;
        gens.push((idx, data));
        if Instant::now() >= deadline {
            stopped = true;
            break;
        }
    }
    drop(rows);
    let mut decoded: Vec<(i64, Result<Decoded, String>)> = Vec::with_capacity(gens.len());
    let mut wanted: HashSet<i64> = HashSet::new();
    for (idx, data) in gens {
        let d = generation(&data);
        match &d {
            Ok(Decoded::Call { steps, .. }) | Ok(Decoded::Incomplete { steps }) => {
                wanted.extend(steps.iter().copied());
            }
            _ => {}
        }
        decoded.push((idx, d));
    }
    let mut wanted: Vec<i64> = wanted.into_iter().collect();
    wanted.sort_unstable();
    let Some(times) = step_times(&conn, &wanted, Some(deadline))? else {
        return Ok(Read {
            max_gen: cursor,
            cursor_ts,
            stopped: true,
            ..Read::default()
        });
    };
    let mut out = Read {
        max_gen: from,
        stopped,
        ..Read::default()
    };
    let mut next = from;
    let mut next_by_idx: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    let mut held_at: Option<i64> = None;
    for (idx, dec) in decoded {
        let dec = match dec {
            Ok(d) => d,
            Err(why) => {
                out.held += 1;
                out.shape.get_or_insert(why);
                held_at.get_or_insert(idx);
                continue;
            }
        };
        match dec {
            Decoded::Incomplete { steps } => {
                let ts = steps.iter().filter_map(|i| times.get(i)).min().copied();
                next_by_idx.insert(idx, ts.unwrap_or(0));
                if db_recent {
                    out.held += 1;
                    held_at.get_or_insert(idx);
                    continue;
                }
                next = idx;
            }
            Decoded::Call {
                model,
                tokens,
                steps,
            } => {
                // A recent row waits until every step it names has a time. A quiet row can count
                // with the times present, even if another step's time arrives later.
                let complete = steps.iter().all(|i| times.contains_key(i));
                let ts = steps.iter().filter_map(|i| times.get(i)).min().copied();
                next_by_idx.insert(idx, ts.unwrap_or(0));
                if !complete && db_recent {
                    out.held += 1;
                    held_at.get_or_insert(idx);
                    continue;
                }
                if tokens.is_zero() {
                    if db_recent {
                        out.held += 1;
                        held_at.get_or_insert(idx);
                        continue;
                    }
                    next = idx;
                    continue;
                }
                if tokens.output == 0 && db_recent {
                    // A model call with no output yet is still being written: wait for its fill
                    // rather than counting the prompt alone.
                    out.held += 1;
                    held_at.get_or_insert(idx);
                    continue;
                }
                let Some(ts) = ts else {
                    out.held += 1;
                    out.shape.get_or_insert(
                        "an agy usage row has no step time, so its hour is unknown".into(),
                    );
                    held_at.get_or_insert(idx);
                    continue;
                };
                if ts > now + MAX_SKEW_MS {
                    out.held += 1;
                    out.shape
                        .get_or_insert("an agy usage row is dated in the future".into());
                    held_at.get_or_insert(idx);
                    continue;
                }
                let Some(model) = model else {
                    out.held += 1;
                    out.shape
                        .get_or_insert("an agy usage row names no model".into());
                    held_at.get_or_insert(idx);
                    continue;
                };
                let Some(session) = conversation.as_deref() else {
                    out.held += 1;
                    out.shape
                        .get_or_insert("an agy transcript has no conversation id".into());
                    held_at.get_or_insert(idx);
                    continue;
                };
                // A quiet row may already have been counted using one of its later times.
                // Reconstruct those keys from its named steps, including for stores that saved
                // only the original key's hash. The cursor still tracks the earliest current time.
                let prefix = format!("agy|{session}|{idx}|");
                let dedupe = format!("{prefix}{ts}");
                let mut later_times: Vec<_> = steps
                    .iter()
                    .filter_map(|i| times.get(i).copied())
                    .filter(|&time| time > ts)
                    .collect();
                if !later_times.is_empty() {
                    later_times.sort_unstable();
                    later_times.dedup();
                    out.later_step_keys.insert(
                        dedupe.clone(),
                        later_times
                            .into_iter()
                            .map(|time| key_hash(&format!("{prefix}{time}")))
                            .collect(),
                    );
                }
                out.events.push(UsageEvent {
                    dedupe_key: dedupe,
                    ts_ms: ts,
                    harness: HARNESS,
                    model: clip(&model, 128),
                    session: Some(session.to_string()),
                    parent_session: None,
                    cwd: workspace.cwd.clone(),
                    session_cwd: workspace.cwd.clone(),
                    branch: workspace.branch.clone(),
                    repo: workspace.repo.clone(),
                    tokens,
                    precision: Precision::Exact,
                    reported_usd: None,
                    copied: false,
                });
                next = idx;
            }
        }
    }
    // Rows after a held one still count; the cursor only stops before the first held row, so the
    // next sync re-reads it and its followers (the dedupe set drops the repeats).
    if let Some(h) = held_at {
        next = next.min(h.saturating_sub(1));
    }
    out.max_gen = next;
    out.cursor_ts = if next >= 0 {
        next_by_idx.get(&next).copied().unwrap_or(next_ts)
    } else {
        -1
    };
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_varint(mut v: u64, out: &mut Vec<u8>) {
        while v >= 0x80 {
            out.push((v as u8) | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }

    fn field(no: u64, wire: u8, b: &[u8]) -> Vec<u8> {
        assert_eq!(wire, 2);
        let mut out = Vec::new();
        put_varint((no << 3) | 2, &mut out);
        put_varint(b.len() as u64, &mut out);
        out.extend_from_slice(b);
        out
    }

    fn text_field(no: u64, s: &str) -> Vec<u8> {
        field(no, 2, s.as_bytes())
    }

    fn uint_field(no: u64, v: u64) -> Vec<u8> {
        let mut out = Vec::new();
        put_varint(no << 3, &mut out);
        put_varint(v, &mut out);
        out
    }

    fn timestamp(secs: u64, nanos: u64) -> Vec<u8> {
        [uint_field(1, secs), uint_field(2, nanos)].concat()
    }

    fn usage_blob(
        input: u64,
        cache_read: u64,
        cache_write: u64,
        output: u64,
        thinking: u64,
    ) -> Vec<u8> {
        [
            uint_field(2, input),
            uint_field(3, output),
            uint_field(4, cache_write),
            uint_field(5, cache_read),
            uint_field(9, thinking),
            uint_field(10, output.saturating_sub(thinking)),
        ]
        .concat()
    }

    fn chat_model(u: &[u8], model: &str, display: &str) -> Vec<u8> {
        [
            uint_field(3, 1417),
            field(4, 2, u),
            text_field(19, model),
            text_field(21, display),
        ]
        .concat()
    }

    #[test]
    fn reads_the_real_field_numbers() {
        let ws = [
            text_field(1, "file:///work/example-project/.worktrees/915"),
            text_field(2, "file:///work/example-project"),
            field(
                3,
                2,
                &[
                    text_field(1, "acme/example-project"),
                    text_field(2, "https://example.com/acme/example-project.git"),
                ]
                .concat(),
            ),
            text_field(4, "feat/915-agy-transcripts"),
        ]
        .concat();
        let blob = [field(1, 2, &ws), field(2, 2, &timestamp(1_800_000_000, 0))].concat();
        let w = trajectory(&blob).unwrap();
        assert_eq!(
            w.cwd.as_deref(),
            Some("/work/example-project/.worktrees/915")
        );
        assert_eq!(w.repo.as_deref(), Some("example.com/acme/example-project"));
        assert_eq!(w.branch.as_deref(), Some("feat/915-agy-transcripts"));
        let u = usage_blob(1000, 4000, 50, 200, 120);
        let t = super::usage(&u).unwrap();
        assert_eq!(
            t,
            Tokens {
                input_uncached: 1000,
                cache_read: 4000,
                cache_write_5m: 50,
                output: 200,
                reasoning: 120,
                ..Tokens::default()
            }
        );
        let cm = chat_model(&u, "gemini-4-argon", "Gemini 4 Argon (High)");
        match generation(&[field(1, 2, &cm), field(2, 2, &[1, 2])].concat()).unwrap() {
            Decoded::Call { model, steps, .. } => {
                assert_eq!(model.as_deref(), Some("gemini-4-argon"));
                assert_eq!(steps, [1, 2]);
            }
            other => panic!("expected a call, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_step_time_is_left_to_the_reader() {
        let u = usage_blob(10, 0, 0, 5, 0);
        let cm = chat_model(&u, "gemini-4-argon", "Gemini 4 Argon (High)");
        let g = [
            field(1, 2, &cm),
            field(2, 2, &[1, 2]),
            text_field(4, "exec-1"),
        ]
        .concat();
        match generation(&g).unwrap() {
            Decoded::Call { model, steps, .. } => {
                assert_eq!(steps, [1, 2]);
                assert_eq!(model.as_deref(), Some("gemini-4-argon"));
            }
            other => panic!("expected a call, got {other:?}"),
        }
    }

    #[test]
    fn a_zero_usage_row_is_a_call_and_a_garbage_blob_is_refused() {
        let u = usage_blob(0, 0, 0, 0, 0);
        let cm = chat_model(&u, "gemini-4-argon", "Gemini 4 Argon (High)");
        let g = [field(1, 2, &cm), field(2, 2, &[1])].concat();
        match generation(&g).unwrap() {
            Decoded::Call { tokens, .. } => assert!(tokens.is_zero()),
            other => panic!("expected an empty call, got {other:?}"),
        }
        assert!(generation(b"not a protobuf").is_err());
    }

    #[test]
    fn a_row_without_a_usage_block_is_incomplete() {
        let cm = uint_field(3, 1417);
        let g = [field(1, 2, &cm), field(2, 2, &[1, 2])].concat();
        match generation(&g).unwrap() {
            Decoded::Incomplete { steps } => assert_eq!(steps, [1, 2]),
            other => panic!("expected an incomplete row, got {other:?}"),
        }
        let empty = field(4, 2, &[]);
        let g = [field(1, 2, &empty), field(2, 2, &[1])].concat();
        assert!(matches!(
            generation(&g).unwrap(),
            Decoded::Incomplete { .. }
        ));
    }

    #[test]
    fn a_usage_block_with_only_unknown_fields_is_refused() {
        let unknown = uint_field(99, 3);
        assert!(super::usage(&unknown).is_err());
        let cm = chat_model(&unknown, "gemini-4-argon", "Gemini 4 Argon (High)");
        let g = [field(1, 2, &cm), field(2, 2, &[1])].concat();
        assert!(generation(&g).is_err());
    }

    #[test]
    fn an_out_of_range_token_count_is_refused() {
        let negative = [uint_field(2, u64::MAX), uint_field(3, 1)].concat();
        assert!(super::usage(&negative).is_err());
        let huge = [uint_field(2, MAX_CALL_TOKENS + 1), uint_field(3, 1)].concat();
        assert!(super::usage(&huge).is_err());
    }

    #[test]
    fn a_malformed_model_blob_is_refused_not_skipped() {
        let g = [field(1, 2, b"junk"), field(2, 2, &[1])].concat();
        assert!(generation(&g).is_err());
    }

    #[test]
    fn the_source_is_known_and_logs_reasoning() {
        assert_eq!(
            crate::sources::Source::from_harness(HARNESS),
            Some(crate::sources::Source::Agy)
        );
        assert!(crate::sources::Source::Agy.logs_reasoning());
    }

    #[test]
    fn maps_file_uris_and_refuses_other_schemes() {
        assert_eq!(file_path("file:///work/a%20b"), Some("/work/a b".into()));
        assert_eq!(file_path("file://localhost/work/a"), Some("/work/a".into()));
        assert_eq!(file_path("https://example.com/a"), None);
        assert_eq!(file_path("file://relative/a"), None);
    }

    #[test]
    fn a_writable_database_is_opened_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("conv.db");
        Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE t(x)")
            .unwrap();
        let conn = open_read_only(&db).unwrap();
        assert!(
            conn.is_readonly("main").unwrap(),
            "the connection must be read-only even when the file is writable"
        );
        assert!(conn.execute("CREATE TABLE t2(x)", []).is_err());
    }

    #[test]
    fn the_wal_mtime_counts_as_the_database_mtime() {
        use std::time::{Duration, SystemTime};
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("conv.db");
        let wal = dir.path().join("conv.db-wal");
        std::fs::write(&db, b"db").unwrap();
        std::fs::write(&wal, b"wal").unwrap();
        let old = SystemTime::now() - Duration::from_secs(3 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&db)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let newest = newest_mtime_ms(&db).unwrap();
        let wal_ms = mtime_ms(&wal).unwrap();
        assert!(
            newest >= wal_ms,
            "the WAL write ({wal_ms}) must be newer than the main file ({newest})"
        );
    }

    #[test]
    fn a_trajectory_without_a_workspace_is_known() {
        let blob = field(2, 2, &timestamp(1_800_000_000, 0));
        let w = trajectory(&blob).unwrap();
        assert!(w.cwd.is_none() && w.repo.is_none() && w.branch.is_none());
    }
}
