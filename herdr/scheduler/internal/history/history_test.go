package history

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAppendKeepsHistoryPrivate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	t.Setenv("HERDR_PLUGIN_STATE_DIR", dir)
	write := func() {
		t.Helper()
		if err := Append(Record{RunID: "r1", Screen: "terminal output"}); err != nil {
			t.Fatal(err)
		}
	}
	check := func(name string, want os.FileMode) {
		t.Helper()
		info, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s mode = %o, want %o", filepath.Base(name), got, want)
		}
	}
	write()
	check(dir, 0o700)
	check(path(), 0o600)
	if err := os.Chmod(path(), 0o644); err != nil {
		t.Fatal(err)
	}
	write()
	check(path(), 0o600)
}

func TestRunsCollapsesToLatestState(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	base := time.Now()
	steps := []Record{
		{RunID: "r1", Automation: "triage", Status: StatusScheduled, At: base},
		{RunID: "r1", Automation: "triage", Status: StatusRunning, At: base.Add(time.Second)},
		{RunID: "r1", Automation: "triage", Status: StatusDone, At: base.Add(time.Minute)},
		{RunID: "r2", Automation: "other", Status: StatusFailed, At: base.Add(2 * time.Minute), Error: "boom"},
	}
	for _, r := range steps {
		if err := Append(r); err != nil {
			t.Fatal(err)
		}
	}

	runs, err := Runs("", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 2 {
		t.Fatalf("expected 2 runs, got %d", len(runs))
	}
	if runs[0].RunID != "r2" || runs[0].Status != StatusFailed {
		t.Fatalf("newest first expected, got %+v", runs[0])
	}
	if runs[1].Status != StatusDone {
		t.Fatalf("r1 should collapse to done, got %s", runs[1].Status)
	}

	last, err := LastRun("triage")
	if err != nil || last == nil || last.RunID != "r1" {
		t.Fatalf("LastRun(triage) = %+v, %v", last, err)
	}
}

// Opening a run in the panel marks it seen. The mark is a record of its own,
// appended like everything else, and must not stand in for the run's status.
func TestSeenMarksARunWithoutReplacingItsStatus(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	base := time.Now()
	for _, r := range []Record{
		{RunID: "r1", Automation: "triage", Status: StatusRunning, At: base},
		{RunID: "r1", Automation: "triage", Status: StatusDone, At: base.Add(time.Minute)},
	} {
		if err := Append(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := MarkSeen("r1"); err != nil {
		t.Fatal(err)
	}
	if err := MarkSeen("nope"); err == nil {
		t.Fatal("marking an unknown run must say so")
	}

	runs, err := Runs("triage", 0)
	if err != nil {
		t.Fatal(err)
	}
	r := runs[0]
	if r.Status != StatusDone || !r.Seen {
		t.Fatalf("got status %s seen %v", r.Status, r.Seen)
	}
	if !r.Started.Equal(base) || !r.At.Equal(base.Add(time.Minute)) {
		t.Fatalf("started %s at %s", r.Started, r.At)
	}
}

// The first time the panel opens, every finished run ever recorded is unseen.
func TestMarkAllSeenEmptiesTheInbox(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	for _, r := range []Record{
		{RunID: "r1", Automation: "a", Status: StatusDone, At: time.Now()},
		{RunID: "r2", Automation: "b", Status: StatusFailed, At: time.Now()},
		{RunID: "r3", Automation: "b", Status: StatusRunning, At: time.Now()},
	} {
		if err := Append(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := MarkAllSeen(); err != nil {
		t.Fatal(err)
	}
	runs, err := Runs("", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range runs {
		if want := r.Status != StatusRunning; r.Seen != want {
			t.Errorf("%s (%s): seen %v, want %v", r.RunID, r.Status, r.Seen, want)
		}
	}
}
