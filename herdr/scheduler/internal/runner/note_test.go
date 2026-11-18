package runner

import (
	"errors"
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/history"
	"github.com/DnzzL/herdr-automations/internal/host"
)

// noteHost is a fakeHost that keeps a note for the run, as the hc host does
// for a late start (#1416).
type noteHost struct {
	fakeHost
	note  string
	taken int
}

func (n *noteHost) Note(host.Session) string {
	n.taken++
	note := n.note
	n.note = ""
	return note
}

var _ host.Noter = (*noteHost)(nil)

func TestADoneRunCarriesTheHostsNote(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &noteHost{note: "started late: first seen working 2m31s after the run began"}
	if err := New(h).Run(automation(), "cron"); err != nil {
		t.Fatal(err)
	}
	rs := runs(t)
	if len(rs) != 1 || rs[0].Status != history.StatusDone {
		t.Fatalf("runs %+v", rs)
	}
	if rs[0].Result != "started late: first seen working 2m31s after the run began" || rs[0].Error != "" {
		t.Fatalf("result %q error %q", rs[0].Result, rs[0].Error)
	}
	if h.taken != 1 {
		t.Fatalf("note taken %d times", h.taken)
	}
}

// The panel shows result before error: a note on a failed run would hide why
// it failed, so it is taken and dropped.
func TestAFailedRunDropsTheHostsNote(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &noteHost{note: "started late: first seen working 2m31s after the run began"}
	h.do = func(host.Session, config.Automation, time.Duration) error {
		return errors.New("the agent reported an error")
	}
	if err := New(h).Run(automation(), "cron"); err == nil {
		t.Fatal("want the failure")
	}
	rs := runs(t)
	if len(rs) != 1 || rs[0].Status != history.StatusFailed {
		t.Fatalf("runs %+v", rs)
	}
	if rs[0].Result != "" || rs[0].Error != "the agent reported an error" {
		t.Fatalf("result %q error %q", rs[0].Result, rs[0].Error)
	}
	if h.taken != 1 || h.note != "" {
		t.Fatalf("note taken %d times, left %q", h.taken, h.note)
	}
}

func TestACancelledRunDropsTheHostsNote(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &noteHost{note: "started late: first seen working 3m0s after the run began"}
	h.do = func(host.Session, config.Automation, time.Duration) error { return host.ErrCancelled }
	_ = New(h).Run(automation(), "cron")
	rs := runs(t)
	if len(rs) != 1 || rs[0].Status != history.StatusCancelled || rs[0].Result != "" {
		t.Fatalf("runs %+v", rs)
	}
	if h.taken != 1 {
		t.Fatalf("note taken %d times", h.taken)
	}
}

// A host with no notes changes nothing: a done agent run has no result.
func TestADoneRunWithoutNotesHasNoResult(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	if err := New(&fakeHost{}).Run(automation(), "cron"); err != nil {
		t.Fatal(err)
	}
	rs := runs(t)
	if len(rs) != 1 || rs[0].Status != history.StatusDone || rs[0].Result != "" {
		t.Fatalf("runs %+v", rs)
	}
}
