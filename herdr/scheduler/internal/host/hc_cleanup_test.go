package host

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/hc"
)

func TestHCRemoveRefusesChangedIdentityBeforeKill(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*hc.Terminal, *Session)
	}{
		{"automation", func(term *hc.Terminal, _ *Session) { term.Labels["automation"] = "other" }},
		{"space", func(term *hc.Terminal, _ *Session) { term.Labels["herdr.space"] = "sp2" }},
		{"tab", func(term *hc.Terminal, _ *Session) { term.Labels["herdr.tab"] = "tb2" }},
		{"creation", func(term *hc.Terminal, _ *Session) { term.CreatedMS++ }},
		{"target ownership", func(_ *hc.Terminal, s *Session) { s.Target = "bot:b-6jrz4bmxml" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := hcAutomation()
			s := Session{PaneID: "t1", WorkspaceID: "sp1", TabID: "tb1", Workspace: config.WorkspaceRoot,
				TerminalID: "10"}
			term := automationTerminal(s.PaneID, a.Name, s.WorkspaceID, s.TabID, "live")
			tc.change(&term, &s)
			f := &fakeHC{term: term}
			err := newHCTest(f).Remove(s, a)
			if err == nil || err.Error() != "terminal identity changed" || len(f.calls) != 0 {
				t.Fatalf("want refusal before kill, got %v with calls %v", err, f.calls)
			}
		})
	}
}

func TestHCPreviousExcludesBotAndWorkerLabels(t *testing.T) {
	for _, label := range []string{"bot", "worker.of"} {
		t.Run(label, func(t *testing.T) {
			a := hcAutomation()
			term := automationTerminal("t1", a.Name, "sp1", "tb1", "live")
			term.Labels[label] = "b1"
			f := &fakeHC{term: term, terminals: []string{"t1"}}
			previous, err := newHCTest(f).Previous(a, nil)
			if err != nil || len(previous) != 0 {
				t.Fatalf("selected an earlier terminal labelled %s: %+v, %v", label, previous, err)
			}
		})
	}
}

func TestHCRemoveRefusesUnownedWorker(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*hc.Terminal, *Session)
	}{
		{"worker of", func(term *hc.Terminal, _ *Session) { term.Labels["worker.of"] = "b-6jrz4bmxyy" }},
		{"branch prefix", func(term *hc.Terminal, _ *Session) {
			term.Labels["branch"] = "20261127-1020"
		}},
		{"branch timestamp", func(term *hc.Terminal, _ *Session) {
			term.Labels["branch"] = "auto/issue-triage-manual"
		}},
		{"bot seat", func(term *hc.Terminal, _ *Session) { term.Labels["bot"] = "b-6jrz4bmxml" }},
		{"missing launch identity", func(_ *hc.Terminal, s *Session) { s.TerminalID = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := hcAutomation()
			s := Session{PaneID: "t1", Target: "worker:b-6jrz4bmxml", TargetParent: "t2",
				TerminalID: "10"}
			term := hc.Terminal{Address: "t1", Parent: "t2", CreatedMS: 10, State: "live",
				Labels: map[string]string{
					"worker.of": "b-6jrz4bmxml", "branch": "auto/issue-triage-20261127-1020",
				}}
			tc.change(&term, &s)
			f := &fakeHC{term: term}
			err := newHCTest(f).Remove(s, a)
			if err == nil || err.Error() != "terminal identity changed" || len(f.calls) != 0 {
				t.Fatalf("want worker refusal before kill, got %v with calls %v", err, f.calls)
			}
		})
	}
}

func TestHCPreviousRefusesLegacyWorkerOutsideRunWindow(t *testing.T) {
	for _, tc := range []struct {
		name    string
		created int64
	}{
		{"before start", 9},
		{"after last observation", 21},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := hcAutomation()
			s := Session{PaneID: "t1", Target: "worker:b-6jrz4bmxml", Started: time.UnixMilli(10),
				Observed: time.UnixMilli(20)}
			term := hc.Terminal{Address: "t1", Parent: "t2", CreatedMS: tc.created, State: "live",
				Labels: map[string]string{
					"worker.of": "b-6jrz4bmxml", "branch": "auto/issue-triage-20261127-1020",
				}}
			f := &fakeHC{term: term, termSeq: [][]string{nil, {"t1"}}}
			previous, err := newHCTest(f).Previous(a, []Session{s})
			if err != nil || len(previous) != 0 {
				t.Fatalf("selected a worker created outside its run: %+v, %v", previous, err)
			}
		})
	}
}

func TestHCScreenRefusesChangedIdentity(t *testing.T) {
	for _, tc := range []struct{ name, space, tab, id string }{
		{"space", "sp2", "tb1", "10"},
		{"tab", "sp1", "tb2", "10"},
		{"creation", "sp1", "tb1", "9"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			term := automationTerminal("t1", hcAutomation().Name, "sp1", "tb1", "live")
			f := &fakeHC{term: term, screen: "another run's screen"}
			s := Session{PaneID: "t1", WorkspaceID: tc.space, TabID: tc.tab, TerminalID: tc.id}
			screen, err := newHCTest(f).Screen(s)
			if err == nil || screen != "" || f.readCalls != 0 {
				t.Fatalf("want refusal without reading screen, got %q, %v, %d reads",
					screen, err, f.readCalls)
			}
		})
	}
}

func TestHCRemoveRefusesWhenSharedSpaceCannotBeListed(t *testing.T) {
	a := hcAutomation()
	s := Session{PaneID: "t1", WorkspaceID: "sp1", TabID: "tb1", Workspace: config.WorkspaceExisting}
	listErr := errors.New("list unavailable")
	f := &fakeHC{term: automationTerminal("t1", a.Name, "sp1", "tb1", "live"), termErr: listErr}
	err := newHCTest(f).Remove(s, a)
	if !errors.Is(err, listErr) || len(f.calls) != 0 || f.labels != nil {
		t.Fatalf("want refusal before shell or kill, got %v with calls %v and labels %v",
			err, f.calls, f.labels)
	}
}

func TestHCPreviousPreservesUnlabelledLastTabAfterModeSwitch(t *testing.T) {
	a := hcAutomation()
	a.Workspace = config.WorkspaceRoot
	f := &fakeHC{term: automationTerminal("t1", a.Name, "sp1", "tb1", "live"),
		terminals: []string{"t1"}}
	h := newHCTest(f)
	previous, err := h.Previous(a, nil)
	if err != nil || len(previous) != 1 {
		t.Fatalf("earlier terminal = %+v, %v", previous, err)
	}
	f.onKill = func() {
		if f.labels["herdr.space"] != "sp1" || f.labels["herdr.tab"] != "tb1" {
			t.Fatalf("unlabelled run lost its last tab: shell labels %v", f.labels)
		}
	}
	if err := h.Remove(previous[0], a); err != nil {
		t.Fatal(err)
	}
	if strings.Join(f.calls, ",") != "kill t1,rm t1" {
		t.Fatalf("cleanup calls = %v", f.calls)
	}
}
