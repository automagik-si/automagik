//! A JSON Schema 2020-12 checker for the contracts under `meter/schema`, so the crate's tests
//! need no new dependency. An unknown keyword or pattern panics so schema changes cannot
//! bypass validation.
#![allow(dead_code)]

use serde_json::Value;

pub struct Schema {
    root: Value,
}

/// Keywords that only annotate.
const ANNOTATIONS: [&str; 5] = ["$schema", "$id", "title", "description", "format"];

impl Schema {
    pub fn new(root: Value) -> Schema {
        Schema { root }
    }

    /// Every violation, as `path: what`. Empty when `v` is valid.
    pub fn errors(&self, v: &Value) -> Vec<String> {
        let mut out = Vec::new();
        self.check(&self.root, v, "$", &mut out);
        out
    }

    pub fn valid(&self, v: &Value) -> bool {
        self.errors(v).is_empty()
    }

    fn resolve(&self, r: &str) -> &Value {
        let path = r
            .strip_prefix("#/")
            .unwrap_or_else(|| panic!("only local refs: {r}"));
        let mut cur = &self.root;
        for part in path.split('/') {
            cur = cur
                .get(part)
                .unwrap_or_else(|| panic!("unresolved ref {r}"));
        }
        cur
    }

    fn check(&self, s: &Value, v: &Value, at: &str, out: &mut Vec<String>) {
        let Some(obj) = s.as_object() else {
            match s {
                Value::Bool(true) => return,
                Value::Bool(false) => {
                    out.push(format!("{at}: false schema"));
                    return;
                }
                _ => panic!("schema at {at} is not an object: {s}"),
            }
        };
        for (k, sv) in obj {
            match k.as_str() {
                k if ANNOTATIONS.contains(&k) => {}
                "$defs" => {}
                "$ref" => self.check(self.resolve(sv.as_str().unwrap()), v, at, out),
                "type" => {
                    let types: Vec<&str> = match sv {
                        Value::String(t) => vec![t.as_str()],
                        Value::Array(a) => a.iter().map(|t| t.as_str().unwrap()).collect(),
                        _ => panic!("type at {at}"),
                    };
                    if !types.iter().any(|t| is_type(v, t)) {
                        out.push(format!("{at}: not {types:?}: {v}"));
                    }
                }
                "const" => {
                    if !same(sv, v) {
                        out.push(format!("{at}: not the const {sv}: {v}"));
                    }
                }
                "enum" => {
                    if !sv.as_array().unwrap().iter().any(|e| same(e, v)) {
                        out.push(format!("{at}: not in {sv}: {v}"));
                    }
                }
                "required" => {
                    if let Some(o) = v.as_object() {
                        for r in sv.as_array().unwrap() {
                            let r = r.as_str().unwrap();
                            if !o.contains_key(r) {
                                out.push(format!("{at}: lacks {r}"));
                            }
                        }
                    }
                }
                "properties" => {
                    if let Some(o) = v.as_object() {
                        for (p, ps) in sv.as_object().unwrap() {
                            if let Some(pv) = o.get(p) {
                                self.check(ps, pv, &format!("{at}.{p}"), out);
                            }
                        }
                    }
                }
                "additionalProperties" => {
                    assert!(
                        sv.is_object() || sv == &Value::Bool(false),
                        "additionalProperties must be false or an object schema"
                    );
                    if let Some(o) = v.as_object() {
                        let known = obj.get("properties").and_then(Value::as_object);
                        for (p, pv) in o {
                            if !known.is_some_and(|k| k.contains_key(p)) {
                                if sv.is_object() {
                                    self.check(sv, pv, &format!("{at}.{p}"), out);
                                } else {
                                    out.push(format!("{at}: unknown property {p}"));
                                }
                            }
                        }
                    }
                }
                "items" => {
                    if let Some(a) = v.as_array() {
                        for (i, item) in a.iter().enumerate() {
                            self.check(sv, item, &format!("{at}[{i}]"), out);
                        }
                    }
                }
                "minItems" | "maxItems" => {
                    if let Some(a) = v.as_array() {
                        let n = sv.as_u64().unwrap() as usize;
                        let bad = if k == "minItems" {
                            a.len() < n
                        } else {
                            a.len() > n
                        };
                        if bad {
                            out.push(format!("{at}: {} items, {k} {n}", a.len()));
                        }
                    }
                }
                "minimum" | "maximum" => {
                    if let Some(x) = v.as_f64() {
                        let bound = sv.as_f64().unwrap();
                        let bad = if k == "minimum" { x < bound } else { x > bound };
                        if bad {
                            out.push(format!("{at}: {x}, {k} {sv}"));
                        }
                    }
                }
                "minLength" | "maxLength" => {
                    if let Some(st) = v.as_str() {
                        let n = sv.as_u64().unwrap() as usize;
                        let len = st.chars().count();
                        let bad = if k == "minLength" { len < n } else { len > n };
                        if bad {
                            out.push(format!("{at}: {len} characters, {k} {n}"));
                        }
                    }
                }
                "pattern" => {
                    if let Some(st) = v.as_str()
                        && !pattern(sv.as_str().unwrap())(st)
                    {
                        out.push(format!("{at}: {st:?} does not match {sv}"));
                    }
                }
                "oneOf" => {
                    let n = sv
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|s| {
                            let mut e = Vec::new();
                            self.check(s, v, at, &mut e);
                            e.is_empty()
                        })
                        .count();
                    if n != 1 {
                        out.push(format!("{at}: {n} branches of oneOf match"));
                    }
                }
                "anyOf" => {
                    let any = sv.as_array().unwrap().iter().any(|s| {
                        let mut e = Vec::new();
                        self.check(s, v, at, &mut e);
                        e.is_empty()
                    });
                    if !any {
                        out.push(format!("{at}: no branch of anyOf matches"));
                    }
                }
                "allOf" => {
                    for s in sv.as_array().unwrap() {
                        self.check(s, v, at, out);
                    }
                }
                "if" => {
                    let mut e = Vec::new();
                    self.check(sv, v, at, &mut e);
                    let branch = if e.is_empty() { "then" } else { "else" };
                    if let Some(b) = obj.get(branch) {
                        self.check(b, v, at, out);
                    }
                }
                "then" | "else" => {}
                other => panic!("the checker does not know the keyword {other} (at {at})"),
            }
        }
    }
}

fn is_type(v: &Value, t: &str) -> bool {
    match t {
        "null" => v.is_null(),
        "boolean" => v.is_boolean(),
        "object" => v.is_object(),
        "array" => v.is_array(),
        "string" => v.is_string(),
        "number" => v.is_number(),
        "integer" => v.is_i64() || v.is_u64() || v.as_f64().is_some_and(|f| f.fract() == 0.0),
        _ => panic!("unknown type {t}"),
    }
}

/// JSON equality, numbers compared as numbers (`0` equals `0.0`).
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).is_some_and(|q| same(p, q)))
        }
        _ => a == b,
    }
}

/// ECMA-262 `\s`.
fn ecma_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// A matcher for each pattern the schema uses, written out by hand.
fn pattern(p: &str) -> fn(&str) -> bool {
    match p {
        r"^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$" => |s| {
            let (core, tail) = match s.find(['-', '+']) {
                Some(i) => (&s[..i], Some(&s[i + 1..])),
                None => (s, None),
            };
            let parts: Vec<&str> = core.split('.').collect();
            parts.len() == 3
                && parts
                    .iter()
                    .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
                && tail.is_none_or(|t| {
                    !t.is_empty()
                        && t.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
                })
        },
        r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$" => |s| {
            s.len() == 10
                && s.is_ascii()
                && digits(&s[0..4], 4)
                && &s[4..5] == "-"
                && digits(&s[5..7], 2)
                && &s[7..8] == "-"
                && digits(&s[8..10], 2)
        },
        r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$" => |s| {
            let Some(s) = s.strip_suffix('Z') else {
                return false;
            };
            let (whole, millis) = s
                .split_once('.')
                .map_or((s, None), |(whole, millis)| (whole, Some(millis)));
            whole.len() == 19
                && whole.is_ascii()
                && pattern(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")(&whole[..10])
                && &whole[10..11] == "T"
                && digits(&whole[11..13], 2)
                && &whole[13..14] == ":"
                && digits(&whole[14..16], 2)
                && &whole[16..17] == ":"
                && digits(&whole[17..19], 2)
                && millis.is_none_or(|millis| digits(millis, 3))
        },
        r"^[0-9a-f]{64}$" => |s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        },
        "Z$" => |s| s.ends_with('Z'),
        r"^[a-z0-9.-]+(/[^/\s]+)+$" => |s| {
            let mut parts = s.split('/');
            let host = parts.next().unwrap_or("");
            let rest: Vec<&str> = parts.collect();
            !host.is_empty()
                && host
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
                && !rest.is_empty()
                && rest
                    .iter()
                    .all(|seg| !seg.is_empty() && !seg.chars().any(ecma_space))
        },
        r"^[^\s\\\u0000-\u001f\u007f]+$" => |s| {
            !s.is_empty()
                && !s
                    .chars()
                    .any(|c| ecma_space(c) || c == '\\' || (c as u32) < 0x20 || c == '\u{7f}')
        },
        other => panic!("the checker has no matcher for the pattern {other}"),
    }
}

#[test]
fn schema_valued_additional_properties_only_checks_undeclared_fields() {
    use serde_json::json;

    let s = Schema::new(json!({
        "type": "object",
        "properties": {"known": {"type": "boolean"}},
        "additionalProperties": {"type": "integer", "minimum": 0, "maximum": 1}
    }));
    assert!(s.valid(&json!({"known": true, "low": 0, "high": 1})));
    assert!(!s.valid(&json!({"known": 0})));
    assert!(!s.valid(&json!({"extra": "invalid"})));
    assert!(!s.valid(&json!({"extra": -1})));
    assert!(!s.valid(&json!({"extra": 2})));

    let s = Schema::new(json!({
        "type": "object",
        "additionalProperties": {"type": "string"}
    }));
    assert!(s.valid(&json!({"marker": "a recorded rule"})));
    assert!(!s.valid(&json!({"marker": 1})));
}
