package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/history"
)

func setup(t *testing.T, yaml string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", dir)
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	if err := os.WriteFile(filepath.Join(dir, "automations.yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
}

// What the panel draws its list from: every entry, the broken ones too, with
// its next run and its last.
func TestListGivesThePanelEverythingItShows(t *testing.T) {
	setup(t, `backend: hc
paused: true
automations:
  - name: triage
    cron: "0 9 * * 1-5"
    repo: /x
    model: sonnet
    prompt: p
    disabled: true
  - name: broken
    cron: "0 99 * * *"
    repo: /x
    prompt: p
`)
	if err := history.Append(history.Record{RunID: "r1", Automation: "triage", Status: history.StatusDone, At: time.Now()}); err != nil {
		t.Fatal(err)
	}
	l, err := List()
	if err != nil {
		t.Fatal(err)
	}
	if l.Backend != "hc" || !l.Paused || len(l.Automations) != 1 || len(l.Invalid) != 1 {
		t.Fatalf("got %+v", l)
	}
	a := l.Automations[0]
	if a.Name != "triage" || !a.Disabled || a.Model != "sonnet" || a.Next.IsZero() || a.Next.Hour() != 9 {
		t.Fatalf("automation %+v", a)
	}
	if a.BlockedGraceMinutes != 2 {
		t.Fatalf("blocked_grace_minutes = %d, want the loader's default 2", a.BlockedGraceMinutes)
	}
	if a.Last == nil || a.Last.RunID != "r1" || a.Last.Status != "done" {
		t.Fatalf("last %+v", a.Last)
	}
	if l.Invalid[0].Name != "broken" || l.Invalid[0].Line == 0 {
		t.Fatalf("invalid %+v", l.Invalid)
	}
}

func TestHistoryCarriesDurationAndSeen(t *testing.T) {
	setup(t, "automations: []\n")
	base := time.Now().Add(-time.Hour)
	for _, r := range []history.Record{
		{RunID: "r1", Automation: "triage", Status: history.StatusRunning, At: base, PaneID: "t7"},
		{RunID: "r1", Automation: "triage", Status: history.StatusDone, At: base.Add(4 * time.Minute), PaneID: "t7"},
	} {
		if err := history.Append(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := history.MarkSeen("r1"); err != nil {
		t.Fatal(err)
	}
	runs, err := History("", 10)
	if err != nil {
		t.Fatal(err)
	}
	r := runs[0]
	if r.Terminal != "t7" || !r.Seen || r.Seconds != 240 {
		t.Fatalf("got %+v", r)
	}
}

// The panel fills its close_workspace control from ls --json, so the listing carries the key for
// every entry; an entry that never names it reads as never, the default the loader applies.
func TestListCarriesCloseWorkspace(t *testing.T) {
	setup(t, `automations:
  - name: triage
    cron: "0 9 * * 1-5"
    repo: /x
    prompt: p
    close_workspace: on-success
  - name: digest
    cron: "0 17 * * 5"
    repo: /x
    prompt: p
`)
	l, err := List()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Automations []map[string]any `json:"automations"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Automations) != 2 {
		t.Fatalf("got %d automations in %s", len(got.Automations), raw)
	}
	want := map[string]string{"triage": "on-success", "digest": "never"}
	for _, entry := range got.Automations {
		name, _ := entry["name"].(string)
		if close, _ := entry["close_workspace"].(string); close != want[name] {
			t.Errorf("%s: close_workspace is %q in %s", name, close, raw)
		}
	}
}

// The panel will send blocked_grace_minutes later, so the listing carries it
// for every entry, with the loader's default filled in.
func TestListCarriesBlockedGrace(t *testing.T) {
	setup(t, `automations:
  - name: triage
    cron: "0 9 * * 1-5"
    repo: /x
    prompt: p
  - name: digest
    cron: "0 17 * * 5"
    repo: /x
    prompt: p
    blocked_grace_minutes: 5
`)
	l, err := List()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Automations []map[string]any `json:"automations"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]float64{"triage": 2, "digest": 5}
	for _, entry := range got.Automations {
		name, _ := entry["name"].(string)
		if grace, _ := entry["blocked_grace_minutes"].(float64); grace != want[name] {
			t.Errorf("%s: blocked_grace_minutes is %v in %s", name, entry["blocked_grace_minutes"], raw)
		}
	}
}

// The panel offers the command form only to a scheduler that names the kind,
// and draws a command entry from its command and its bot (ADR 0013).
func TestListCarriesTheKindsAndACommandEntry(t *testing.T) {
	setup(t, `automations:
  - name: daily-check
    cron: "0 7 * * *"
    command:
      argv: ["./check.sh", "--all"]
      cwd: /srv/checks
      env:
        REGION: eu
    notify: b-captain
`)
	l, err := List()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Kinds       []string `json:"kinds"`
		Automations []struct {
			Command *struct {
				Argv []string          `json:"argv"`
				Cwd  string            `json:"cwd"`
				Env  map[string]string `json:"env"`
			} `json:"command"`
			Notify    string  `json:"notify"`
			Agent     *string `json:"agent"`
			Workspace string  `json:"workspace"`
			Repo      string  `json:"repo"`
			Timeout   int     `json:"timeout_minutes"`
		} `json:"automations"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire.Kinds) != 3 || wire.Kinds[2] != "command" {
		t.Fatalf("kinds = %v", wire.Kinds)
	}
	a := wire.Automations[0]
	if a.Command == nil || len(a.Command.Argv) != 2 || a.Command.Cwd != "/srv/checks" || a.Command.Env["REGION"] != "eu" {
		t.Fatalf("command = %+v in %s", a.Command, raw)
	}
	if a.Notify != "b-captain" || a.Agent != nil || a.Workspace != "" || a.Repo != "" || a.Timeout != 60 {
		t.Fatalf("entry = %+v in %s", a, raw)
	}
}

func TestHistoryCarriesACommandRunsResult(t *testing.T) {
	setup(t, "automations: []\n")
	seven := 7
	if err := history.Append(history.Record{
		RunID: "r1", Automation: "check", Status: history.StatusFailed, At: time.Now(), Error: "exited 7",
		ExitCode: &seven, Result: "exited 7: no route", Stderr: "warming up\nno route", Notified: "sent to t7",
	}); err != nil {
		t.Fatal(err)
	}
	runs, err := History("check", 10)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(runs[0])
	for _, want := range []string{`"exit_code":7`, `"result":"exited 7: no route"`, `"stderr":"warming up\nno route"`, `"notified":"sent to t7"`, `"error":"exited 7"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("history --json lacks %s: %s", want, raw)
		}
	}
	// An agent run carries none of them.
	if err := history.Append(history.Record{RunID: "r2", Automation: "triage", Status: history.StatusDone, At: time.Now()}); err != nil {
		t.Fatal(err)
	}
	runs, _ = History("triage", 10)
	raw, _ = json.Marshal(runs[0])
	for _, key := range []string{"exit_code", "result", "stderr", "notified"} {
		if strings.Contains(string(raw), key) {
			t.Fatalf("an agent run carries %s: %s", key, raw)
		}
	}
}

// The panel draws a target and only offers one when this build names the
// kinds, so the listing carries both (#498).
func TestListCarriesTargets(t *testing.T) {
	setup(t, `backend: hc
automations:
  - name: housekeeping
    cron: "0 9 * * *"
    repo: /x
    target: "bot:b-6jrz4bmxml"
    prompt: tidy
  - name: review
    cron: "0 10 * * *"
    repo: /x
    target: "worker:b-6jrz4bmxml"
    prompt: review
`)
	l, err := List()
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Targets) != 2 || l.Targets[0] != "bot" || l.Targets[1] != "worker" {
		t.Fatalf("targets = %v", l.Targets)
	}
	byName := map[string]Automation{}
	for _, a := range l.Automations {
		byName[a.Name] = a
	}
	if a := byName["housekeeping"]; a.Target != "bot:b-6jrz4bmxml" || a.TargetWhenBusy != "queue" {
		t.Fatalf("bot target %+v", a)
	}
	if a := byName["review"]; a.Target != "worker:b-6jrz4bmxml" || a.TargetWhenBusy != "" {
		t.Fatalf("worker target %+v", a)
	}
	raw, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"targets":`, `"target":"bot:b-6jrz4bmxml"`, `"target_when_busy":"queue"`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("ls --json has no %s: %s", key, raw)
		}
	}
}

// Bots live in herdr-core: a backend: herdr scheduler refuses every target,
// so it must not name the kinds in ls --json either (#498).
func TestListDoesNotClaimTargetsUnderHerdr(t *testing.T) {
	setup(t, `automations:
  - name: night
    cron: "0 9 * * *"
    repo: /x
    agent: claude
    prompt: tidy
`)
	l, err := List()
	if err != nil {
		t.Fatal(err)
	}
	if l.Targets != nil {
		t.Fatalf("targets = %v under backend: herdr", l.Targets)
	}
	raw, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"targets"`) {
		t.Errorf("ls --json still names targets: %s", raw)
	}
}
