use std::process::ExitCode;
use std::time::Duration;

use meter::coverage;
use meter::fleet;
use meter::outcomes;
use meter::query::{self, Located};
use meter::store::{SCHEMA_VERSION, Store};
use meter::sync::{self, Options, Outcome};
use meter::time::{format_rfc3339, now_ms};
use meter::{paths, summary};

const USAGE: &str = "\
Usage:
  usagemeter sync [--force] [--backfill] [--days N] [--budget-secs N] [--no-publish] [--doc NAME]
  usagemeter sync --evidence-backfill --days N [--budget-secs N] [--no-publish] [--doc NAME]
  usagemeter status
  usagemeter query --repo HOST/OWNER/REPO --branch B [--branch B ...] --json
                   [--repo-alias <host/owner/repo>]...
                   [--window d1|d7|d30|d90 | --since <rfc3339> --until <rfc3339>]
                   [--contract 1] [--stale-after SECONDS]
  usagemeter query --repo HOST/OWNER/REPO --by bot [--branch B ...] --json [...]
  usagemeter query --repo HOST/OWNER/REPO --by task [--branch B ...] --json [...]
  usagemeter coverage [--window d1|d7|d30 ...] [--repo HOST/OWNER/REPO ...] [--json]
                      [--repo-alias <host/owner/repo>]...
  usagemeter outcomes [--window d1|d7|d30 ...] [--repo HOST/OWNER/REPO ...] [--json]
                      [--repo-alias <host/owner/repo>]...
  usagemeter repair --store STATE_DIR --against ORACLE_STATE_DIR [--from DAY] [--until DAY]
                    [--json]
                    [--dry-run | --apply --copy FILE --confirm-copy SHA256]
  usagemeter fleet usage --json [--missing MACHINE:REASON[:MESSAGE] ...] FILE [FILE ...]
  usagemeter fleet outcomes --json [--missing MACHINE:REASON[:MESSAGE] ...] FILE [FILE ...]
  usagemeter --version

sync      Read new harness usage (omp, Claude Code, Codex, dsh-tui, Antigravity) into the store and
          publish the summary doc to herdr-core. Does nothing within 10 minutes of a complete sync.
  --force         Run even if the last sync is recent.
  --backfill      Re-import the full history (slow; resumes across runs).
  --days N        Import window in days (default 30). A wider window re-imports.
  --evidence-backfill
                  Give the last N days (--days, 1 to 90, the evidence's retention) per-call
                  evidence from the logs still on disk, then recompute the attribution of every
                  call from then. Totals never change; it resumes on later syncs until done.
  --budget-secs N Stop after N seconds and resume next run (default 20).
  --no-publish    Do not write the summary doc.
  --doc NAME      Doc name to publish to (default herdr-meter).
status    Print the store's state as JSON. It never writes the store: the database's content
          does not change, nothing is migrated or locked, and the only files SQLite may add are
          the store's -wal and -shm. A folder it cannot write is read only when those exist.
query     Usage and estimated cost per branch of one repo, as the contract 1 envelope (RFC 0018,
          meter/schema/query/v1/) on stdout, for every exit below. It opens the store as status
          does; only sync refreshes the store. Capability meter.usage@1.
  --repo-alias <host/owner/repo>
                  Include a previous repo name; repeat for more aliases (at most 16).
                  Coverage and outcomes require a single --repo when aliases are given.
  --by bot        One row per bot (RFC 0021): bot, kind, role, squad and harness, from the
                  usage tied to a launch; any --branch is then a filter, and none is needed.
  --by task       One row per task id (RFC 0018 M3, RFC 0021 D4): the task's usage and cost,
                  with the launch tags that did the work in actors (bot, kind, role, squad,
                  unrecorded, harness; keys past the row's bound are counted in actors_omitted,
                  never cut). Any --branch is then a filter, and none is needed. A task id tied
                  to more than one checkout of the repo is missing with reason task_ambiguous,
                  and no checkout path is printed. A window with no task labels is an empty ok
                  answer, and the branch row stays the fallback.
repair    Top up the rollup totals of the store in --store (always given, never defaulted) from
          an oracle state dir built from the frozen logs (issue 1126), 2026-11-07..10 unless
          --from/--until narrow it. A dry run is the default: both stores are opened read-only
          and nothing is written. It never subtracts and never changes events; a cell above the
          oracle is kept and listed; hours with no oracle rows, and short groups with no
          evidence-free row, are listed as unresolved. --apply needs --copy (a VACUUM INTO copy
          of the store) and its sha256. Totals count the six counted columns (not reasoning).
          Exit status: 0 plan or applied, 1 conservation failed, 2 usage or unreadable store,
          3 nothing to repair, 12 a newer store.
fleet     Roll up local query/outcomes JSON files; no collection, network calls or store writes.
          Missing machines and non-ok queries make the answer partial; unknown is never zero.
          Exit status: 0 ok or partial, 2 bad request, 1 invalid input or incompatible queries.
coverage  The store's bot-tag coverage (RFC 0026 (a)): text by default, or one JSON record with
          --json. Every window's counted usage splits into attributed, ambiguous, unlinked and
          before_evidence, per repo (50 shown, the rest counted and summed) and per bot (50 shown,
          the rest summed), with the old definition's frozen-tag residue beside the headline. It
          opens the store read-only, as `status` does; only `sync` refreshes the store.
outcomes  Recorded failures and time to pull request (issues 899 and 1026), per window: text by
          default, or one JSON record with --json. Local and read-only like coverage; not
          contract 1.
          Failures are raw counts per bot, kind, role, squad, harness, error kind and source,
          plus the unattributed by reason. They are counts of harness-flagged failures,
          including expected ones (a red test run while working test-first, a grep with no
          match) and usage-limit stops (written after a harness's own retries, so a count of
          model calls that failed for the session, not each retried attempt):
          not a quality verdict on their own, and no rate, label or score is printed.
            tool_error (harness_log)  a tool result the harness itself flagged as failed.
                Claude Code: a tool_result block with is_error: true, once per tool_use_id.
                Codex: an item_completed event whose item has status failed or a non-zero
                exit_code, once per item id. omp, dsh-tui and Antigravity have no pinned
                marker: they are listed as unsupported, never counted as 0.
            api_error (harness_log)   a model call the harness itself flagged as failed after
                its own retries (model calls that failed for the session, not each retried
                attempt, including usage-limit stops). Claude Code: a type assistant line
                with top-level isApiErrorMessage: true, once per line uuid. Codex, omp,
                dsh-tui and Antigravity have no pinned marker: they are listed as
                unsupported, never counted as 0.
            run_failed (hc_snapshot, workers_ledger)  a launch whose terminal ended on its
                own with a non-zero exit status or on a signal: hc_snapshot when hc's list
                of finished terminals says so, workers_ledger when an end row of Herdr's
                workers ledger copied it. A window's total names the sources its failed
                runs came from. killed and stopped_by_restart are counted as ends, never
                as errors.
          Time to pull request is in seconds on two clocks, from the pull requests Herdr
          records in its workers ledger: from the branch's first commit (to_open_s,
          to_merge_s) and from its first worker launch (launch_to_open_s, launch_to_merge_s),
          per branch, and as nearest-rank p50 and p90 per repo and per (bot, role); n_shared
          counts the samples of branches several (bot, role) pairs worked on. A branch with
          worker launches and no pull request is no_pr, in no percentile.
          Unknown is never 0: a window is partial when it starts before errors_from or
          api_errors_from or a launch's end is unknown, not_recorded until a sync has
          prepared the store, and no_data (counts and percentiles null) when nothing ran in
          it. The output holds no tool name, argument, output, error text, session, folder
          or terminal. Lists are capped (50 rows, 50 bots, 50 repos, 200 branches, 64 KiB),
          the rest counted.

The state lives in METER_STATE_DIR if set, else $AM_HOME/meter, else ~/.automagik/meter.
The first sync moves the meter's files out of the pre-0.5.0 default directory.

Exit status of sync and status: 0 done or nothing to do, 2 an error, 3 sync blocked by the state
move, 4 sync refused a migration for want of free space (twice the store's size, plus what the
logs still to import may add) or ran out of room part-way (the store put back as it was), 12
the store was written by a newer meter (sync writes nothing to it). stderr says why.

Exit status of query: 0 answered, 1 error, 2 bad request, 10 no store, 11 no snapshot in time,
12 store from a newer meter, 13 store needs sync to migrate it, 14 contract not served, 15 the
answer is past the output cap.
Exit status of coverage and outcomes: 0 reported, 1 error, 2 bad request, 10 no store, 11 no
snapshot in time, 12 store from a newer meter, 13 store needs sync to migrate it.";

/// `sync` did nothing because files in the state directory must be resolved by hand first.
const EXIT_BLOCKED: u8 = 3;
/// `sync` refused a destructive migration: less than twice the store's size is free.
const EXIT_NO_SPACE: u8 = 4;

fn fail(msg: &str) -> ExitCode {
    eprintln!("meter: {msg}");
    ExitCode::from(2)
}

fn human_bytes(b: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1000.0 && i < U.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    if i == 0 {
        format!("{b} B")
    } else {
        format!("{v:.1} {}", U[i])
    }
}

fn state_dirs() -> Result<paths::StateDirs, String> {
    paths::state_dirs(|k| std::env::var_os(k))
        .ok_or_else(|| "HOME is not set; set METER_STATE_DIR to choose a state directory".into())
}

fn parse_num(flag: &str, v: Option<String>, min: u64, max: u64) -> Result<u64, String> {
    let v = v.ok_or_else(|| format!("{flag} needs a number"))?;
    let n: u64 = v
        .parse()
        .map_err(|_| format!("{flag} needs a whole number, got {v:?}"))?;
    if n < min || n > max {
        return Err(format!("{flag} must be between {min} and {max}"));
    }
    Ok(n)
}

fn cmd_sync(args: Vec<String>) -> Result<ExitCode, String> {
    let home = paths::home().ok_or("HOME is not set")?;
    let dirs = state_dirs()?;
    let mut opts = Options::new(home, dirs.dir, now_ms());
    opts.migrate_from = dirs.legacy;
    let mut evidence_backfill = false;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--force" => opts.force = true,
            "--backfill" => opts.backfill = true,
            "--evidence-backfill" => evidence_backfill = true,
            "--no-publish" => opts.publish = false,
            "--days" => opts.days = Some(parse_num("--days", it.next(), 1, 36_500)? as i64),
            "--budget-secs" => {
                opts.budget = Duration::from_secs(parse_num("--budget-secs", it.next(), 1, 3600)?)
            }
            "--doc" => {
                let name = it.next().ok_or("--doc needs a name")?;
                if name.is_empty()
                    || name.len() > 64
                    || !name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    return Err("--doc takes a name of letters, digits, - and _".into());
                }
                opts.doc_name = name;
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(ExitCode::SUCCESS);
            }
            other => {
                return Err(format!(
                    "unknown option {other:?} for sync; see usagemeter --help"
                ));
            }
        }
    }
    if evidence_backfill {
        // --days is then how far back the evidence goes, never the import window: it never asks
        // past the evidence's retention, whatever the oldest ledger row says (RFC 0021 delivery 8).
        if opts.backfill {
            return Err("--evidence-backfill and --backfill do not go together".into());
        }
        let days = opts
            .days
            .take()
            .ok_or("--evidence-backfill needs --days N (1 to 90)")?;
        if days > meter::evidence::EVIDENCE_DAYS {
            return Err(format!(
                "--days takes 1 to {} with --evidence-backfill: evidence is kept {} days",
                meter::evidence::EVIDENCE_DAYS,
                meter::evidence::EVIDENCE_DAYS
            ));
        }
        opts.evidence_backfill = Some(days);
        opts.force = true;
    }
    match sync::run(&opts).map_err(|e| e.0)? {
        Outcome::Locked => println!("meter: another sync is running; nothing to do"),
        // The one stderr line from the move says why and what to do. Not a success: a scheduled
        // run must not report one while nothing syncs.
        Outcome::Blocked => return Ok(ExitCode::from(EXIT_BLOCKED)),
        Outcome::NewerSchema { store } => {
            eprintln!(
                "meter: the store's schema_version is {store}, newer than this meter's \
                 {SCHEMA_VERSION}: it was written by a newer usagemeter, so nothing was read or \
                 written; update the meter"
            );
            return Ok(ExitCode::from(query::exit::NEWER_SCHEMA));
        }
        Outcome::NoSpace {
            free,
            needed,
            growth,
        } => {
            eprintln!(
                "meter: the store needs a rebuild or migration, which keeps a copy first and needs {} free \
                 (twice the store, plus {} the logs still to import may add); only {} is free, \
                 so nothing was changed and the store keeps working as it is",
                human_bytes(needed),
                human_bytes(growth),
                human_bytes(free)
            );
            return Ok(ExitCode::from(EXIT_NO_SPACE));
        }
        // Exit 4 as for the up-front refusal: the store is as it was, or keeps whole chunks.
        Outcome::RanOutOfRoom { reason } => {
            eprintln!("meter: {reason}");
            return Ok(ExitCode::from(EXIT_NO_SPACE));
        }
        Outcome::Fresh { age_ms } => println!(
            "meter: last sync was {}s ago; nothing to do (use --force)",
            age_ms / 1000
        ),
        Outcome::Ran(r) => {
            let h = &r.health;
            println!(
                "meter: read {} from {} of {} files in {:.1}s; {} new usage events, {} duplicates dropped, {} skipped lines",
                human_bytes(r.bytes_read),
                r.files_read,
                r.files_seen,
                r.elapsed.as_secs_f64(),
                h.events,
                h.duplicates,
                h.skipped_lines
            );
            if let Some(g) = &r.generation {
                let rows: i64 = g.counts.values().sum();
                let before = if r.migrated && !r.reimported {
                    "the migration"
                } else {
                    "the reset"
                };
                println!(
                    "meter: kept the store before {before} as {} ({rows} rows, every table's \
                     count checked)",
                    g.path.display()
                );
            }
            for g in &r.generations_removed {
                println!("meter: removed the generation {}", g.display());
            }
            if r.migrated && r.reimported {
                println!(
                    "meter: migrated the store to schema {SCHEMA_VERSION} and rebuilt it from \
                     the logs: its rows were from a meter older than schema 2"
                );
            } else if r.migrated {
                println!(
                    "meter: migrated the store to schema {SCHEMA_VERSION}: every row kept, \
                     per-call evidence from the next hour on"
                );
            }
            if r.launches_changed + r.links_changed > 0 || r.calls_moved > 0 {
                println!(
                    "meter: attribution: {} launch and {} link rows changed, {} calls moved",
                    r.launches_changed, r.links_changed, r.calls_moved
                );
            }
            if let Some(b) = &r.evidence_backfill {
                println!(
                    "meter: evidence backfill from {}: {} calls given their evidence, {} left as \
                     they were (no row before evidence held them as logged); {}",
                    format_rfc3339(b.from_ms),
                    b.adopted,
                    b.left_alone,
                    if b.done {
                        "done, attribution queued for recompute"
                    } else {
                        "the next sync goes on"
                    }
                );
                if b.unbacked > 0 {
                    println!(
                        "meter: evidence backfill: {} calls whose evidence was pruned and no log \
                         gave back count as before evidence",
                        b.unbacked
                    );
                }
            }
            if r.rekeyed.0 > 0 {
                println!(
                    "meter: re-keyed {} rollup rows an older build wrote ({} merged); every total \
                     kept, its generation kept until a later sync",
                    r.rekeyed.0, r.rekeyed.1
                );
            }
            if r.calls_refused > 0 {
                println!(
                    "meter: attribution: {} calls left where they were: no rollup row held them",
                    r.calls_refused
                );
            }
            if r.reimported {
                println!(
                    "meter: window widened or store rebuilt; re-imported from {}",
                    format_rfc3339(r.counted_from_ms)
                );
            }
            if r.pending_bytes > 0 {
                println!(
                    "meter: stopped at the time budget; {} in {} files left for the next run",
                    human_bytes(r.pending_bytes),
                    r.pending_files
                );
            }
            if h.rewrites > 0 {
                println!(
                    "meter: {} files were rewritten or truncated and read again",
                    h.rewrites
                );
            }
            if r.unreadable > 0 {
                println!("meter: {} files could not be read", r.unreadable);
            }
            match &r.published {
                None => println!(
                    "meter: summary ({}) not published (--no-publish)",
                    human_bytes(r.summary_bytes as u64)
                ),
                Some(Ok(v)) => println!(
                    "meter: published {} ({}) version {v}",
                    opts.doc_name,
                    human_bytes(r.summary_bytes as u64)
                ),
                Some(Err(e)) => println!("meter: summary not published: {e}"),
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_status() -> Result<ExitCode, String> {
    let ctx = query::Ctx::from_env();
    let dirs = ctx
        .state
        .clone()
        .ok_or("HOME is not set; set METER_STATE_DIR to choose a state directory")?;
    // The query's read-only open: no lock (a sync may be running; a wal reader waits for nobody),
    // nothing migrated, the database's content unchanged (SQLite may add its -wal and -shm). A move
    // that has not finished opens nothing.
    let (db, location, stray) = match query::locate(&dirs, ctx.overridden)? {
        Located::Absent => {
            println!(
                "{}",
                serde_json::json!({"state_dir": dirs.dir, "synced": false})
            );
            return Ok(ExitCode::SUCCESS);
        }
        Located::Store {
            db,
            location,
            stray,
            ..
        } => (db, location, stray),
    };
    if query::read_only_folder(&db) {
        return Err(format!("read_only_folder: {}", query::READ_ONLY_FOLDER));
    }
    let store =
        Store::open_read_only(&db).map_err(|e| format!("cannot open {}: {e}", db.display()))?;
    store
        .conn
        .execute_batch("BEGIN")
        .map_err(|e| format!("cannot read {}: {e}", db.display()))?;
    let version = query::schema_version(&store.conn)
        .map_err(|e| format!("cannot read {}: {e}", db.display()))?;
    let get = |k: &str| store.meta_i64(k).ok().flatten();
    let current = version == Some(SCHEMA_VERSION);
    let sources = if current {
        sync::source_health(&store).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let v = serde_json::json!({
        "state_dir": db.parent(),
        "location": location.as_str(),
        "version": env!("CARGO_PKG_VERSION"),
        "schema_version": version,
        "supported_schema_version": SCHEMA_VERSION,
        "legacy_store": stray,
        "machine": store.meta("machine").ok().flatten().or_else(|| store.meta("machine_fallback").ok().flatten()),
        "counted_from": get("counted_from_ms").map(format_rfc3339),
        "last_success": get("last_success_ms").map(format_rfc3339),
        "last_run": get("last_run_ms").map(format_rfc3339),
        "pending_bytes": get("last_pending_bytes").unwrap_or(0),
        "pending_files": get("last_pending_files").unwrap_or(0),
        "rows": store.count("usage").unwrap_or(0),
        "files": store.count("files").unwrap_or(0),
        "dedupe_keys": store.count("seen").unwrap_or(0),
        "sessions": store.count("sessions").unwrap_or(0),
        // Schema 3 (RFC 0021 delivery 5): counts only, never an id. Tokens before the evidence
        // (rows written before schema 3 included) are never counted as attributed.
        "evidence": current.then(|| serde_json::json!({
            "evidence_from": get(meter::evidence::FROM_META).map(format_rfc3339),
            "calls": store.count("evidence").unwrap_or(0),
            "launches": store.count("launch").unwrap_or(0),
            "links": store.count("link").unwrap_or(0),
            "attribution_backlog": meter::evidence::dirty_count(&store.conn).unwrap_or(0),
            "tokens_by_harness": meter::evidence::actor_totals(
                &store.conn,
                get("counted_from_ms").unwrap_or(0),
            ).unwrap_or_default(),
        })),
        "sources": sources.iter().map(|s| serde_json::json!({
            "harness": s.harness, "status": s.status, "reason": s.reason,
            "last_success": s.last_success_ms.map(format_rfc3339),
            "usage_lines": s.usage_lines, "events": s.events, "duplicates": s.duplicates,
            "skipped_lines": s.skipped_lines, "rewrites": s.rewrites,
            "threads": s.threads.map(|(e, t)| serde_json::json!({"exact": e, "total_only": t})),
        })).collect::<Vec<_>>(),
        "summary_schema_version": summary::SUMMARY_SCHEMA_VERSION,
    });
    println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
    Ok(ExitCode::SUCCESS)
}

fn cmd_coverage(args: &[String]) -> ExitCode {
    reply(coverage::run(args, &query::Ctx::from_env()))
}

fn cmd_outcomes(args: &[String]) -> ExitCode {
    reply(outcomes::run(args, &query::Ctx::from_env()))
}

/// A report's answer: stdout when it reported, stderr with why not otherwise.
fn reply(a: coverage::Reply) -> ExitCode {
    use std::io::Write;
    let text = if a.stdout.is_empty() {
        a.stderr.unwrap_or_default()
    } else {
        a.stdout
    };
    let written = if a.code == query::exit::OK {
        let mut out = std::io::stdout().lock();
        out.write_all(text.as_bytes()).and_then(|()| out.flush())
    } else {
        let mut err = std::io::stderr().lock();
        err.write_all(text.as_bytes()).and_then(|()| err.flush())
    };
    if written.is_err() {
        return ExitCode::from(query::exit::ERROR);
    }
    ExitCode::from(a.code)
}

fn cmd_query(args: &[String]) -> ExitCode {
    write_answer(query::run(args, &query::Ctx::from_env()))
}

fn write_answer(a: query::Answer) -> ExitCode {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    if out
        .write_all(a.stdout.as_bytes())
        .and_then(|()| out.flush())
        .is_err()
    {
        return ExitCode::from(query::exit::ERROR);
    }
    ExitCode::from(a.code)
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let cmd = args.next();
    let rest: Vec<String> = args.collect();
    let r = match cmd.as_deref() {
        Some("sync") => cmd_sync(rest),
        Some("query") => return cmd_query(&rest),
        Some("fleet") => {
            return write_answer(fleet::run(&rest, now_ms(), env!("CARGO_PKG_VERSION")));
        }
        Some("coverage") => return cmd_coverage(&rest),
        Some("outcomes") => return cmd_outcomes(&rest),
        Some("repair") => return ExitCode::from(meter::repair::cmd(&rest, now_ms())),
        Some("status") if rest.is_empty() => cmd_status(),
        Some("status") => Err("status takes no options".into()),
        Some("--version" | "-V" | "version") => {
            println!("usagemeter {}", env!("CARGO_PKG_VERSION"));
            Ok(ExitCode::SUCCESS)
        }
        Some("-h" | "--help" | "help") | None => {
            println!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        Some(other) => Err(format!("unknown command {other:?}; see usagemeter --help")),
    };
    r.unwrap_or_else(|e| fail(&e))
}
