package host

import (
	"bytes"
	"errors"
	"log"
	"strings"
	"testing"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/herdr"
)

func TestHerdrCleanupRefusesReusedTerminalID(t *testing.T) {
	a := config.Automation{Name: "triage"}
	s := Session{PaneID: "w7:p2", WorkspaceID: "w7", TabID: "tb1", TerminalID: "t7",
		Workspace: config.WorkspaceRoot}
	pane := herdr.PaneInfo{PaneID: s.PaneID, WorkspaceID: s.WorkspaceID, TabID: s.TabID,
		TerminalID: "t8"}
	h := &live{ops: &fakeOps{
		paneList: func() ([]herdr.PaneInfo, error) { return []herdr.PaneInfo{pane}, nil },
		paneGet:  func(string) (herdr.PaneInfo, error) { return pane, nil },
		paneClose: func(id string) error {
			t.Fatalf("closed reused pane %s", id)
			return nil
		},
	}}
	if previous, err := h.Previous(a, []Session{s}); err != nil || len(previous) != 0 {
		t.Errorf("selected a reused pane: %+v, %v", previous, err)
	}
	if err := h.Remove(s, a); err == nil || err.Error() != "pane identity changed" {
		t.Fatalf("remove error = %v, want refusal", err)
	}
}

func TestHerdrPreviousRefusesUnlabelledLegacyPane(t *testing.T) {
	a := config.Automation{Name: "triage"}
	s := Session{PaneID: "w7:p2", WorkspaceID: "w7"}
	pane := herdr.PaneInfo{PaneID: s.PaneID, WorkspaceID: s.WorkspaceID, TabID: "tb1",
		TerminalID: "t8"}
	h := &live{ops: &fakeOps{
		paneList:       func() ([]herdr.PaneInfo, error) { return []herdr.PaneInfo{pane}, nil },
		tabLabel:       func(string) (string, error) { return "auto: triage notes", nil },
		workspaceLabel: func(string) (string, error) { return "auto: other", nil },
	}}
	if previous, err := h.Previous(a, []Session{s}); err != nil || len(previous) != 0 {
		t.Fatalf("selected a legacy pane without a matching run label: %+v, %v", previous, err)
	}
}

func TestHerdrRemoveRefusesWhenSharedTabsCannotBeListed(t *testing.T) {
	a := config.Automation{Name: "triage"}
	s := Session{PaneID: "w7:p2", WorkspaceID: "w7", TabID: "tb1", TerminalID: "t7",
		Workspace: config.WorkspaceExisting}
	pane := herdr.PaneInfo{PaneID: s.PaneID, WorkspaceID: s.WorkspaceID, TabID: s.TabID,
		TerminalID: s.TerminalID}
	listErr := errors.New("tab list unavailable")
	h := &live{ops: &fakeOps{
		paneGet: func(string) (herdr.PaneInfo, error) { return pane, nil },
		tabList: func(string) ([]string, error) { return nil, listErr },
		paneClose: func(id string) error {
			t.Fatalf("closed %s with an unreadable tab list", id)
			return nil
		},
	}}
	if err := h.Remove(s, a); !errors.Is(err, listErr) {
		t.Fatalf("remove error = %v, want tab list error", err)
	}
}

func TestHerdrPreviousLogsUnreadablePaneListAndSkipsThatSession(t *testing.T) {
	var logs bytes.Buffer
	output := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(output) })

	a := config.Automation{Name: "triage"}
	known := []Session{
		{PaneID: "w7:p1", WorkspaceID: "w7", HerdrSession: "unavailable", TerminalID: "t1"},
		{PaneID: "w7:p2", WorkspaceID: "w7", HerdrSession: "unavailable", TerminalID: "t2"},
		{PaneID: "w7:p1", WorkspaceID: "w7", HerdrSession: "available", TerminalID: "t3"},
	}
	f := &fakeOps{}
	f.paneList = func() ([]herdr.PaneInfo, error) {
		if f.session == "unavailable" {
			return nil, errors.New("connection refused")
		}
		return []herdr.PaneInfo{
			{PaneID: "w7:p1", WorkspaceID: "w7", TabID: "tb1", TerminalID: "t3"},
		}, nil
	}
	previous, err := (&live{ops: f}).Previous(a, known)
	if err != nil || len(previous) != 1 || previous[0].HerdrSession != "available" {
		t.Fatalf("previous = %+v, err = %v", previous, err)
	}
	want := `triage: skipping earlier terminal cleanup in Herdr session "unavailable":` +
		" list panes: connection refused"
	if got := logs.String(); strings.Count(got, want) != 1 {
		t.Fatalf("expected one log with the skip reason, got %q", got)
	}
}
