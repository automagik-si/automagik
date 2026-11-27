package host

import (
	"errors"
	"path/filepath"
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

func TestHCPreviousRequiresSpaceAndTabLabels(t *testing.T) {
	for _, label := range []string{"herdr.space", "herdr.tab"} {
		t.Run(label, func(t *testing.T) {
			a := hcAutomation()
			term := automationTerminal("t1", a.Name, "sp1", "tb1", "live")
			delete(term.Labels, label)
			f := &fakeHC{term: term, terminals: []string{"t1"}}
			if previous, err := newHCTest(f).Previous(a, nil); err != nil || len(previous) != 0 {
				t.Fatalf("selected a terminal missing %s: %+v, %v", label, previous, err)
			}
		})
	}
}

func TestHCReconciliationRequiresOwnedFolder(t *testing.T) {
	const foreignWorktree = "foreign"
	a := hcAutomation()
	f := &fakeHC{terminals: []string{"t1"}}
	h := newHCTest(f)
	worktrees := filepath.Join(h.home, ".herdr", "worktrees", "myapp")
	f.mainCheckout = func(dir string) (string, error) {
		if strings.Contains(dir, foreignWorktree) {
			return "/other/myapp", nil
		}
		return "/src/myapp", nil
	}
	for _, tc := range []struct {
		dir   string
		owned bool
	}{
		{a.Repo, true},
		{filepath.Join(a.Repo, "nested"), true},
		{filepath.Join(worktrees, "auto-issue-triage-20261127-1020"), true},
		{filepath.Join(worktrees, foreignWorktree), false},
		{a.Repo + "-different", false},
		{"", false},
	} {
		t.Run(tc.dir, func(t *testing.T) {
			f.term = automationTerminal("t1", a.Name, "sp1", "tb1", "live")
			f.term.Cwd = tc.dir
			previous, err := h.Previous(a, nil)
			if err != nil || (len(previous) == 1) != tc.owned {
				t.Fatalf("previous = %+v, %v for %q", previous, err, tc.dir)
			}
			if !tc.owned {
				s := Session{PaneID: "t1", WorkspaceID: "sp1", TabID: "tb1"}
				if err := h.Remove(s, a); err == nil || len(f.calls) != 0 {
					t.Fatalf("removed from %q: %v, %v", tc.dir, f.calls, err)
				}
			}
		})
	}
}

func TestHCRunsAreStampedAndScopedToTheInstall(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", t.TempDir())
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	a := hcAutomation()
	a.Workspace = config.WorkspaceRoot
	f := &fakeHC{terminals: []string{"t7"}}
	first := NewHC().(*hcHost)
	first.ops = f
	s, err := first.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	if f.labels["automation.install"] == "" {
		t.Error("provision omitted the install label")
	}
	f.term = hc.Terminal{Address: s.PaneID, Cwd: f.cwd, State: "live", Labels: f.labels}
	if previous, err := first.Previous(a, nil); err != nil || len(previous) != 1 {
		t.Fatalf("own terminal = %+v, %v", previous, err)
	}
	for _, env := range []string{"HERDR_PLUGIN_CONFIG_DIR", "HERDR_PLUGIN_STATE_DIR"} {
		t.Run(env, func(t *testing.T) {
			t.Setenv(env, t.TempDir())
			other := NewHC().(*hcHost)
			other.ops = f
			if previous, err := other.Previous(a, nil); err != nil || len(previous) != 0 {
				t.Errorf("selected another install's terminal: %+v, %v", previous, err)
			}
			if err := other.Remove(s, a); err == nil || len(f.calls) != 0 {
				t.Fatalf("removed another install's terminal: %v, %v", f.calls, err)
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
		{"wrong parent", func(term *hc.Terminal, _ *Session) { term.Parent = "t3" }},
		{"nonlocal parent", func(term *hc.Terminal, s *Session) {
			term.Parent, s.TargetParent = "peer/t2", "peer/t2"
		}},
		{"missing launch identity", func(_ *hc.Terminal, s *Session) { s.TerminalID = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := hcAutomation()
			s := Session{PaneID: "t1", Target: "worker:b-6jrz4bmxml", TargetParent: "t2",
				TerminalID: "10"}
			term := hc.Terminal{Address: "t1", Parent: "t2", CreatedMS: 10, State: "live", Cwd: a.Repo,
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

func TestHCPreviousRecoversLegacyWorkerLaunchedBeforeItsFirstRow(t *testing.T) {
	a := hcAutomation()
	launched := time.Date(2026, 11, 27, 10, 20, 5, 0, time.Local)
	seen := launched.Add(time.Second)
	s := Session{PaneID: "t1", Target: "worker:b-6jrz4bmxml", Started: seen, Observed: seen}
	term := hc.Terminal{Address: "t1", Parent: "t2", Cwd: a.Repo,
		CreatedMS: launched.UnixMilli(), State: "live", Labels: map[string]string{
			"worker.of": "b-6jrz4bmxml", "branch": "auto/issue-triage-20261127-1020",
		}}
	f := &fakeHC{term: term, termSeq: [][]string{nil, {"t1"}}}
	previous, err := newHCTest(f).Previous(a, []Session{s})
	if err != nil || len(previous) != 1 || previous[0].TargetParent != term.Parent {
		t.Fatalf("legacy worker = %+v, %v", previous, err)
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
			term := hc.Terminal{Address: "t1", Parent: "t2", CreatedMS: tc.created,
				State: "live", Cwd: a.Repo,
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

func TestHCRemoveFinishedRecordDoesNotRecreateSharedSpace(t *testing.T) {
	a := hcAutomation()
	s := Session{PaneID: "t1", WorkspaceID: "sp1", TabID: "tb1",
		Workspace: config.WorkspaceExisting}
	f := &fakeHC{term: automationTerminal("t1", a.Name, "sp1", "tb1", "finished")}
	if err := newHCTest(f).Remove(s, a); err != nil || f.labels != nil ||
		strings.Join(f.calls, ",") != "rm t1" {
		t.Fatalf("shell labels = %v, cleanup calls = %v, error = %v", f.labels, f.calls, err)
	}
}

func TestHCPreviousOpensShellOnlyForLastTerminalInAnExistingSpace(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		configured, peer, shell bool
	}{
		{name: "run-made"},
		{name: "configured shared space", configured: true, shell: true},
		{name: "configured with a peer", configured: true, peer: true},
		{name: "unlabelled with a peer", peer: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := hcAutomation()
			a.Workspace = config.WorkspaceRoot
			if tc.configured {
				a.Workspace, a.WorkspaceID = config.WorkspaceExisting, "sp1"
			}
			f := &fakeHC{
				gets:    map[string]hc.Terminal{"t1": automationTerminal("t1", a.Name, "sp1", "tb1", "live")},
				termSeq: [][]string{{"t1"}, {"t1"}},
			}
			if tc.peer {
				f.gets["t2"] = automationTerminal("t2", "", "sp1", "tb1", "live")
				f.termSeq[1] = append(f.termSeq[1], "t2")
			}
			h := newHCTest(f)
			previous, err := h.Previous(a, nil)
			if err != nil || len(previous) != 1 {
				t.Fatalf("earlier terminal = %+v, %v", previous, err)
			}
			if err := h.Remove(previous[0], a); err != nil {
				t.Fatal(err)
			}
			if (f.labels != nil) != tc.shell || strings.Join(f.calls, ",") != "kill t1,rm t1" {
				t.Fatalf("shell labels = %v, cleanup calls = %v", f.labels, f.calls)
			}
		})
	}
}
