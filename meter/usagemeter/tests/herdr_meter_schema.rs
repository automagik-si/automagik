//! The herdr-meter v2 contract, using shared fixtures and a synthetic sync's publication payload.

mod common;

use common::schema::Schema;
use common::{Env, U1, claude_line, now, write_lines};
use serde_json::{Value, json};

fn schema() -> Schema {
    let input = include_str!("../../schema/herdr-meter.v2.schema.json");
    Schema::new(serde_json::from_str(input).unwrap())
}

fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../schema/fixtures")
        .join(name);
    let input = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
    serde_json::from_str(&input).unwrap_or_else(|err| panic!("invalid JSON in {name}: {err}"))
}

fn assert_valid(schema: &Schema, label: &str, doc: &Value) {
    let errors = schema.errors(doc);
    assert!(errors.is_empty(), "{label}: {}", errors.join("\n"));
}

fn assert_invalid_at(schema: &Schema, doc: &Value, path: &str) {
    let errors = schema.errors(doc);
    let prefix = format!("{path}:");
    assert_eq!(errors.len(), 1, "expected an error at {path}: {errors:?}");
    assert!(errors[0].starts_with(prefix.as_str()), "{errors:?}");
}

#[test]
fn shared_fixtures_match_the_schema() {
    let schema = schema();
    for name in ["full.json", "cut.json", "space.json", "first-import.json"] {
        assert_valid(&schema, name, &fixture(name));
    }
    for (name, key, value) in [
        ("bad-version.json", "schema_version", json!(3)),
        ("bad-kind.json", "kind", json!("example-meter")),
    ] {
        let doc = fixture(name);
        let mut expected = fixture("full.json");
        expected[key] = value;
        assert_eq!(doc, expected, "{name} changes only {key}");
        assert_invalid_at(&schema, &doc, &format!("$.{key}"));
    }
}

#[test]
fn removing_each_unconditional_root_key_fails() {
    let schema = schema();
    // full.json contains only the keys the writer always emits, including generatedAt.
    let full = fixture("full.json");
    for key in full.as_object().unwrap().keys() {
        let mut doc = full.clone();
        doc.as_object_mut().unwrap().remove(key);
        assert_eq!(schema.errors(&doc), vec![format!("$: lacks {key}")]);
    }
}

#[test]
fn an_extra_root_field_keeps_the_space_fixture_valid() {
    let schema = schema();
    let mut doc = fixture("space.json");
    doc["future_field"] = json!({"example": true});
    assert_valid(&schema, "extended space.json", &doc);
}

#[test]
fn space_has_its_own_version_and_truncation_type() {
    let schema = schema();
    let space = fixture("space.json");
    let mut doc = space.clone();
    doc["space"]["version"] = json!(2);
    assert_invalid_at(&schema, &doc, "$.space.version");

    let mut doc = space.clone();
    doc["space"]["truncated"] = json!([]);
    assert_invalid_at(&schema, &doc, "$.space.truncated");

    let mut doc = space;
    doc["truncated"] = json!(false);
    assert_invalid_at(&schema, &doc, "$.truncated");
}

#[test]
fn windows_require_utc_timestamps_and_daily_uses_dates() {
    let schema = schema();
    let mut doc = fixture("full.json");
    doc["windows"]["d1"] = json!("garbageZ");
    assert_invalid_at(&schema, &doc, "$.windows.d1");

    doc["windows"]["d1"] = json!("2026-11-01T19:00:00.123Z");
    assert_valid(&schema, "milliseconds", &doc);

    doc["daily"]["from"] = json!("2026-10-04T00:00:00Z");
    assert_invalid_at(&schema, &doc, "$.daily.from");
}

#[test]
fn token_counts_and_unsplit_series_require_integers() {
    let schema = schema();
    let mut doc = fixture("full.json");
    doc["projects"][0]["d1"]["in"] = json!(1.5);
    assert_invalid_at(&schema, &doc, "$.projects[0].d1.in");

    for period in ["hourly", "daily"] {
        let mut cut = fixture("cut.json");
        cut[period]["series"][1]["un"][0] = json!(1.5);
        assert_invalid_at(&schema, &cut, &format!("$.{period}.series[1].un[0]"));
    }
}

#[test]
fn sync_publication_payload_validates_before_and_after_cutting() {
    let env = Env::new();
    let mut opts = env.opts();
    // Initialize the real store, then give each synthetic Claude cwd a cached remote.
    // Env keeps repo discovery and herdr-core calls off.
    env.run(&opts);
    let store = env.store();
    for i in 0..12 {
        let cwd = format!("/work/example-app-{i}");
        let repo = format!("github.com/example/app-{i}");
        store.cache_repo(&cwd, Some(&repo), now()).unwrap();
        let line = claude_line(
            &format!("msg-{i}"),
            &format!("request-{i}"),
            "2026-01-15T10:01:00Z",
            "claude-sonnet-5-5",
            &U1,
            0,
        )
        .replace("/work/app", &cwd);
        write_lines(&env.claude(&format!("example/app-{i}.jsonl")), &[line]);
    }
    drop(store);

    // dsh-tui has no branch, repo or reasoning split, and this model has no price.
    let at = now() - 2 * meter::time::HOUR_MS;
    write_lines(
        &env.dsh("-work-example-dsh/example-session/session.v4.jsonl"),
        &[
            json!({
                "type": "session", "version": 4, "id": "example-session",
                "createdAt": at, "cwd": "/work/example-dsh",
                "isSeeded": false, "delegationDepth": 0
            })
            .to_string(),
            json!({
                "type": "assistant/message", "seq": 0, "time": at, "surfaceOp": "append",
                "data": {
                    "turn": 1, "step": 0,
                    "message": {
                        "role": "assistant", "id": "example-message", "content": [],
                        "source": {
                            "kind": "llm", "provider": "example", "model": "example-unpriced-model"
                        }
                    },
                    "usage": {
                        "inputTokens": 10, "outputTokens": 20, "cacheReadTokens": 0,
                        "cacheWriteTokens": 0, "totalTokens": 30
                    },
                    "stream": []
                }
            })
            .to_string(),
        ],
    );

    // Report.summary is the same value sync would pass to doc_put.
    let schema = schema();
    let report = env.run(&opts);
    let uncut = report.summary.unwrap();
    assert_valid(&schema, "uncut sync", &uncut);
    assert_eq!(uncut["truncated"], json!([]));
    for key in ["projects_other", "tasks_other", "space"] {
        assert!(uncut.get(key).is_none(), "uncut sync emitted {key}");
    }
    let projects = uncut["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 13);
    let untasked = projects.iter().find(|p| p["repo"].is_null()).unwrap();
    assert!(untasked.get("usd_per_task").is_none());
    assert_eq!(
        untasked["untasked"],
        json!({"in": 10, "out": 20, "rs": null, "unpriced": 30})
    );

    // Make room for only part of the project detail, even after all tasks have been cut.
    let task_bytes = serde_json::to_vec(&uncut["tasks"]).unwrap().len();
    let project_bytes = serde_json::to_vec(projects).unwrap().len();
    opts.summary_cap = report.summary_bytes - task_bytes - project_bytes / 2;
    let report = env.run(&opts);
    assert!(report.summary_bytes <= opts.summary_cap);
    let cut = report.summary.unwrap();
    assert_valid(&schema, "cut sync", &cut);
    assert_eq!(cut["tasks"], json!([]));
    assert_eq!(cut["tasks_other"]["count"], 12);
    assert!(cut["projects_other"]["count"].as_u64().unwrap() > 0);
    assert!(!cut["truncated"].as_array().unwrap().is_empty());
}
