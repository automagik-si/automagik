//! Synthetic stores for adoption's capacity and deletion invariants. No filesystem or live data.
use super::*;
use crate::store::{Pending, Store, upsert_rows};

const HOUR: i64 = 3_600_000;

fn tokens(n: i64) -> Tokens {
    Tokens {
        input_uncached: n,
        cache_read: n * 2,
        cache_write_5m: n * 3,
        cache_write_1h: n * 4,
        output: n * 5,
        reasoning: n,
        unsplit: 0,
    }
}

fn column(k: usize, n: i64) -> Tokens {
    let mut a = [0; 7];
    a[k] = n;
    Tokens {
        input_uncached: a[0],
        cache_read: a[1],
        cache_write_5m: a[2],
        cache_write_1h: a[3],
        output: a[4],
        reasoning: a[5],
        unsplit: a[6],
    }
}

fn logged() -> Evidence {
    Evidence {
        dim: Dim {
            harness: "dsh-tui".into(),
            model: "synthetic-model".into(),
            machine: "synthetic".into(),
            precision: "exact".into(),
            ..Dim::default()
        },
        actor: Actor {
            state: "unlinked".into(),
            reason: Some("no_record".into()),
            ..Actor::default()
        },
        ..Evidence::default()
    }
}

fn attributed() -> Evidence {
    let mut e = logged();
    e.actor = Actor {
        state: "attributed".into(),
        bot: Some("synthetic-worker".into()),
        kind: Some("worker".into()),
        basis: Some("session".into()),
        ..Actor::default()
    };
    e
}

fn setup() -> Store {
    let s = Store::open_in_memory().unwrap();
    s.conn.execute_batch(BACKFILL_DDL).unwrap();
    s
}

fn put(tx: &Transaction<'_>, e: &Evidence, t: Tokens, events: i64) -> String {
    let (k, p) = rollup_key(&e.dim, &e.actor, HOUR);
    let id = k.id(p);
    upsert_rows(
        tx,
        &BTreeMap::from([(
            (k, p),
            Pending {
                squad: None,
                tokens: t,
                usd: None,
                usd_events: 0,
                events,
            },
        )]),
        HOUR,
    )
    .unwrap();
    id
}

fn adopt_call(tx: &Transaction<'_>, intern: &mut Interner, e: &Evidence, t: &Tokens) -> bool {
    adopt(tx, intern, e, HOUR + 1, t, None, HOUR * 2, HOUR * 3).unwrap()
}

// Choose valid keys with the backed candidate first; no arbitrary IDs that bypass rollup_key.
fn ordered() -> (Evidence, Evidence) {
    let a = logged();
    let b = attributed();
    let id = |e: &Evidence| {
        let (k, p) = rollup_key(&e.dim, &e.actor, HOUR);
        k.id(p)
    };
    if id(&a) < id(&b) { (a, b) } else { (b, a) }
}

#[test]
fn equal_event_residue_stays_attributed_after_freeze() {
    let mut s = setup();
    let e = attributed();
    let tx = s.conn.transaction().unwrap();
    let id = put(&tx, &e, column(1, 100), 2);
    for ts in [HOUR + 1, HOUR + 2] {
        insert(&tx, &mut s.intern, &e, ts, &column(1, 30), None).unwrap();
    }

    assert_eq!(implied_rollups(&tx).unwrap()[&id], (column(1, 60), 2));
    assert_eq!(freeze_unbacked(&tx, HOUR, 2 * HOUR, 3 * HOUR).unwrap(), 0);
    assert_eq!(stored_rollups(&tx, HOUR).unwrap()[&id], (column(1, 100), 2));
    let state: String = tx
        .query_row("SELECT actor_state FROM usage WHERE id = ?1", [&id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(state, "attributed");

    let counts = ResidueCounts {
        rows: 1,
        tokens: 40,
        reasoning_tokens: 0,
    };
    let report = unbacked_residue(&tx, HOUR, 2 * HOUR).unwrap();
    assert_eq!(report.totals, counts);
    assert_eq!(report.discrepancy_rows, 0);
    assert_eq!(
        report.by_day,
        BTreeMap::from([(("dsh-tui".into(), "1970-01-01".into()), counts)])
    );
    assert_eq!(
        unbacked_residue(&tx, 0, HOUR).unwrap(),
        ResidueReport::default()
    );
}

#[test]
fn residue_distinguishes_movable_events_discrepancies_and_reasoning() {
    let call = Tokens {
        cache_read: 30,
        output: 50,
        ..Tokens::default()
    };
    for (case, cache_read, reasoning, events, moved, counts, discrepancies) in [
        ("excess event", 100, 0, 3, 1, ResidueCounts::default(), 0),
        ("short column", 50, 40, 2, 0, ResidueCounts::default(), 1),
        ("short event", 100, 0, 1, 0, ResidueCounts::default(), 1),
        (
            "reasoning only",
            60,
            40,
            2,
            0,
            ResidueCounts {
                rows: 1,
                tokens: 0,
                reasoning_tokens: 40,
            },
            0,
        ),
    ] {
        let mut s = setup();
        let e = attributed();
        let tx = s.conn.transaction().unwrap();
        let stored = Tokens {
            cache_read,
            reasoning,
            output: 100,
            ..Tokens::default()
        };
        let id = put(&tx, &e, stored, events);
        for ts in [HOUR + 1, HOUR + 2] {
            insert(&tx, &mut s.intern, &e, ts, &call, None).unwrap();
        }

        let report = unbacked_residue(&tx, HOUR, 2 * HOUR).unwrap();
        assert_eq!(report.totals, counts, "{case}");
        assert_eq!(report.discrepancy_rows, discrepancies, "{case}");
        assert_eq!(
            report.by_day.values().next().copied(),
            (counts.rows != 0).then_some(counts),
            "{case}"
        );
        assert_eq!(
            freeze_unbacked(&tx, HOUR, 2 * HOUR, 3 * HOUR).unwrap(),
            moved,
            "{case}"
        );
        if moved > 0 {
            assert_eq!(
                stored_rollups(&tx, HOUR).unwrap(),
                implied_rollups(&tx).unwrap()
            );
            let frozen: (i64, i64) = tx
                .query_row(
                    "SELECT cache_read, events FROM usage WHERE actor_state IS NULL",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(frozen, (40, 1));
            assert_eq!(
                unbacked_residue(&tx, HOUR, 2 * HOUR).unwrap(),
                ResidueReport::default()
            );
        } else {
            assert_eq!(stored_rollups(&tx, HOUR).unwrap()[&id], (stored, events));
        }
    }
}

#[test]
fn adoption_skips_a_backed_candidate_and_uses_the_next_pruned_row() {
    let mut s = setup();
    let (backed, pruned) = ordered();
    let tx = s.conn.transaction().unwrap();
    let b = put(&tx, &backed, tokens(100), 1);
    insert(&tx, &mut s.intern, &backed, HOUR + 1, &tokens(100), None).unwrap();
    let p = put(&tx, &pruned, tokens(50), 2);
    assert!(b < p);
    assert!(
        adopt_call(&tx, &mut s.intern, &backed, &tokens(20)),
        "skip backed capacity and keep searching"
    );
    let rows = stored_rollups(&tx, HOUR).unwrap();
    assert_eq!(
        rows[&b],
        (tokens(120), 2),
        "previously backed tokens stay in their row"
    );
    assert_eq!(
        rows[&p],
        (tokens(30), 1),
        "legitimate unbacked remainder survives"
    );
    // Complete the remaining adoption: both rows now agree with their evidence.
    assert!(adopt_call(&tx, &mut s.intern, &backed, &tokens(30)));
    assert_eq!(
        stored_rollups(&tx, HOUR).unwrap(),
        implied_rollups(&tx).unwrap()
    );
    assert!(
        !adopt_call(&tx, &mut s.intern, &backed, &Tokens::default()),
        "backed events are not available capacity"
    );
    tx.commit().unwrap();
}

#[test]
fn adoption_uses_the_unbacked_remainder_of_a_partly_backed_row() {
    let mut s = setup();
    let e = logged();
    let tx = s.conn.transaction().unwrap();
    let id = put(&tx, &e, tokens(150), 3);
    insert(&tx, &mut s.intern, &e, HOUR + 1, &tokens(100), None).unwrap();
    for n in [20, 30] {
        assert!(
            adopt_call(&tx, &mut s.intern, &e, &tokens(n)),
            "a partly backed row must remain eligible for its true unbacked remainder"
        );
        assert_eq!(stored_rollups(&tx, HOUR).unwrap()[&id], (tokens(150), 3));
    }
    assert_eq!(
        stored_rollups(&tx, HOUR).unwrap(),
        implied_rollups(&tx).unwrap()
    );
    assert!(!adopt_call(&tx, &mut s.intern, &e, &Tokens::default()));
}

#[test]
fn adoption_reserves_every_backed_column_and_zero_token_events() {
    // An otherwise eligible row cannot cover the request out of its unbacked remainder.
    for k in 0..8 {
        let mut s = setup();
        let mut e = logged();
        if k == 6 {
            e.dim.precision = "total_only".into();
        }
        let (backed, whole, request, events) = if k == 7 {
            (Tokens::default(), Tokens::default(), Tokens::default(), 1)
        } else {
            (column(k, 10), column(k, 11), column(k, 2), 2)
        };
        let tx = s.conn.transaction().unwrap();
        put(&tx, &e, whole, events);
        insert(&tx, &mut s.intern, &e, HOUR + 1, &backed, None).unwrap();
        let before = stored_rollups(&tx, HOUR).unwrap();
        assert!(
            !adopt_call(&tx, &mut s.intern, &e, &request),
            "backed column/event {k} must not be debited"
        );
        assert_eq!(stored_rollups(&tx, HOUR).unwrap(), before);
        assert_eq!(all(&tx).unwrap().len(), 1);
    }
}

#[test]
fn adoption_and_reattribution_preserve_positive_residual_columns_after_the_last_event() {
    for k in 0..7 {
        for reattribute_call in [false, true] {
            let mut s = setup();
            let (mut from, mut to) = ordered();
            if k == 6 {
                from.dim.precision = "total_only".into();
                to.dim.precision = "total_only".into();
            }
            let tx = s.conn.transaction().unwrap();
            let id = put(&tx, &from, column(k, 3), 1);
            if reattribute_call {
                insert(&tx, &mut s.intern, &from, HOUR + 1, &column(k, 1), None).unwrap();
                let call = all(&tx).unwrap().pop().unwrap();
                assert!(reattribute(&tx, &mut s.intern, &call, &to.actor, HOUR * 3).unwrap());
            } else {
                assert!(adopt_call(&tx, &mut s.intern, &to, &column(k, 1)));
            }
            let rows = stored_rollups(&tx, HOUR).unwrap();
            assert_eq!(
                rows.get(&id),
                Some(&(column(k, 2), 0)),
                "positive residual column {k} must survive a zero-event debit; reattribute={reattribute_call}"
            );
            let mut total = Tokens::default();
            for (t, _) in rows.values() {
                total.add(t);
            }
            assert_eq!(total, column(k, 3));
        }
    }
}

#[test]
fn failed_chunks_roll_back_hour_markers_and_backing_credits() {
    for primed in [false, true] {
        let mut s = setup();
        let (to, from) = ordered();
        {
            let tx = s.conn.transaction().unwrap();
            put(&tx, &from, tokens(50), 2);
            if primed {
                load_adoption_hour(&tx, HOUR).unwrap();
            }
            tx.commit().unwrap();
        }
        let before = stored_rollups(&s.conn, HOUR).unwrap();
        {
            let tx = s.conn.transaction().unwrap();
            assert!(adopt_call(&tx, &mut s.intern, &to, &tokens(20)));
            // Simulate a later error in the same chunk: evidence, usage and temporary credits
            // must all roll back, including the loaded-hour marker when this chunk made it.
            tx.rollback().unwrap();
            s.intern.clear();
        }
        assert_eq!(stored_rollups(&s.conn, HOUR).unwrap(), before);
        assert_eq!(
            s.conn
                .query_row("SELECT count(*) FROM temp.ev_adoption_hours", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            i64::from(primed)
        );
        assert_eq!(
            s.conn
                .query_row("SELECT count(*) FROM temp.ev_adoption_backed", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let tx = s.conn.transaction().unwrap();
        assert!(adopt_call(&tx, &mut s.intern, &to, &tokens(20)));
        assert!(adopt_call(&tx, &mut s.intern, &to, &tokens(30)));
        assert_eq!(
            stored_rollups(&tx, HOUR).unwrap(),
            implied_rollups(&tx).unwrap()
        );
        tx.commit().unwrap();
    }
}

#[test]
fn a_new_invocation_reloads_evidence_committed_on_the_same_connection() {
    let mut s = setup();
    let e = logged();
    {
        let tx = s.conn.transaction().unwrap();
        put(&tx, &e, tokens(10), 1);
        load_adoption_hour(&tx, HOUR).unwrap();
        tx.commit().unwrap();
    }
    // Another operation writes evidence after this invocation's cache was built.
    {
        let tx = s.conn.transaction().unwrap();
        insert(&tx, &mut s.intern, &e, HOUR + 1, &tokens(10), None).unwrap();
        tx.commit().unwrap();
    }
    s.conn.execute_batch(BACKFILL_DDL).unwrap();
    let tx = s.conn.transaction().unwrap();
    assert!(
        !adopt_call(&tx, &mut s.intern, &e, &tokens(1)),
        "a later invocation must see newly committed backing"
    );
    assert_eq!(
        stored_rollups(&tx, HOUR).unwrap(),
        implied_rollups(&tx).unwrap()
    );
}

#[test]
fn backing_loads_only_touched_hours_and_keeps_one_entry_per_rollup() {
    let mut s = setup();
    let e = logged();
    let tx = s.conn.transaction().unwrap();
    for i in 0..50_000 {
        insert(&tx, &mut s.intern, &e, HOUR + 1 + i, &tokens(1), None).unwrap();
    }
    // Another hour is not needed by these adoptions.
    insert(&tx, &mut s.intern, &e, HOUR * 2 + 1, &tokens(1), None).unwrap();
    put(&tx, &e, tokens(50_000), 50_000);
    let sql = format!("EXPLAIN QUERY PLAN {STORED} WHERE e.ts_ms >= ?1 AND e.ts_ms < ?2");
    let mut plan = tx.prepare(&sql).unwrap();
    let detail: Vec<String> = plan
        .query_map([HOUR, HOUR * 2], |r| r.get(3))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(
        detail
            .iter()
            .any(|s| s.contains("SEARCH e USING INDEX evidence_ts")),
        "hour load must use the evidence time index: {detail:?}"
    );
    let started = std::time::Instant::now();
    for _ in 0..1000 {
        assert!(!adopt_call(&tx, &mut s.intern, &e, &tokens(1)));
    }
    assert_eq!(
        tx.query_row("SELECT count(*) FROM temp.ev_adoption_hours", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        tx.query_row(
            "SELECT count(*), sum(events) FROM temp.ev_adoption_backed",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        )
        .unwrap(),
        (1, 50_000)
    );
    eprintln!(
        "backing cost: 1000 attempts, 50000 existing calls in one touched hour, one cached rollup, {:?}",
        started.elapsed()
    );
}
