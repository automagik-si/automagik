package host

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/herdr"
)

// fakeOps scripts Herdr's answers. A nil field means "this call is fine and
// says nothing", which keeps each test to the calls it actually cares about.
type fakeOps struct {
	tabCreate       func(workspaceID, cwd, label string) (string, string, error)
	tabList         func(workspaceID string) ([]string, error)
	tabClose        func(tabID string) error
	worktreeCreate  func(repo, branch, label string) (string, string, error)
	workspaceCreate func(cwd, label string) (string, string, error)
	agentStart      func(name, kind, paneID string, args []string) error
	agentSubmit     func(target, text string) error
	submitPending   func(paneID string) error
	agentStatus     func(target string) (string, error)
	agentWait       func(target string, d time.Duration) error
	agentStop       func(paneID string) (bool, error)
	paneRun         func(paneID string, command ...string) error
	paneRead        func(paneID string, lines int) (string, error)
	paneList        func() ([]herdr.PaneInfo, error)
	paneGet         func(string) (herdr.PaneInfo, error)
	paneClose       func(string) error
	paneSplit       func(string) error
	tabLabel        func(string) (string, error)
	workspaceLabel  func(string) (string, error)
	lookPath        func(file string) error
	workspaceClose  func(workspaceID string) error

	// session is what In bound the fake to, read by a test at call time to
	// see which session a call was made in. current answers CurrentSession.
	session string
	current string

	starts       int
	submits      int
	pending      int
	waits        int
	reads        int
	stopRequests []string
	// closed is every workspace close, closedTabs every tab close; the *In
	// slices are the session each was aimed at.
	closed     []string
	closedIn   []string
	closedTabs []string
	tabsIn     []string
	// tabListCalls and tabListWorkspace say how often and where Close asked
	// which tabs a shared space still has.
	tabListCalls     int
	tabListWorkspace string
}

func (f *fakeOps) WorkspaceClose(workspaceID string) error {
	f.closed = append(f.closed, workspaceID)
	f.closedIn = append(f.closedIn, f.session)
	if f.workspaceClose == nil {
		return nil
	}
	return f.workspaceClose(workspaceID)
}

func (f *fakeOps) TabClose(tabID string) error {
	f.closedTabs = append(f.closedTabs, tabID)
	f.tabsIn = append(f.tabsIn, f.session)
	if f.tabClose == nil {
		return nil
	}
	return f.tabClose(tabID)
}

func (f *fakeOps) WorktreeCreate(repo, branch, label string) (string, string, error) {
	if f.worktreeCreate == nil {
		return "w1", "w1:p1", nil
	}
	return f.worktreeCreate(repo, branch, label)
}

func (f *fakeOps) WorkspaceCreate(cwd, label string) (string, string, error) {
	if f.workspaceCreate == nil {
		return "w2", "w2:p1", nil
	}
	return f.workspaceCreate(cwd, label)
}

func (f *fakeOps) TabCreate(workspaceID, cwd, label string) (string, string, error) {
	if f.tabCreate == nil {
		return "tb1", workspaceID + ":p1", nil
	}
	return f.tabCreate(workspaceID, cwd, label)
}

func (f *fakeOps) TabList(workspaceID string) ([]string, error) {
	f.tabListCalls++
	f.tabListWorkspace = workspaceID
	if f.tabList == nil {
		return nil, nil
	}
	return f.tabList(workspaceID)
}

func (f *fakeOps) AgentStart(name, kind, paneID string, args []string) error {
	f.starts++
	if f.agentStart == nil {
		return nil
	}
	return f.agentStart(name, kind, paneID, args)
}

func (f *fakeOps) AgentSubmit(target, text string) error {
	f.submits++
	if f.agentSubmit == nil {
		return nil
	}
	return f.agentSubmit(target, text)
}

func (f *fakeOps) AgentSubmitPending(paneID string) error {
	f.pending++
	if f.submitPending == nil {
		return nil
	}
	return f.submitPending(paneID)
}

func (f *fakeOps) AgentStatus(target string) (string, error) {
	if f.agentStatus == nil {
		return "idle", nil
	}
	return f.agentStatus(target)
}

func (f *fakeOps) AgentWait(target string, d time.Duration) error {
	f.waits++
	if f.agentWait == nil {
		return nil
	}
	return f.agentWait(target, d)
}

func (f *fakeOps) AgentStop(paneID string) (bool, error) {
	f.stopRequests = append(f.stopRequests, paneID)
	if f.agentStop != nil {
		return f.agentStop(paneID)
	}
	return true, nil
}

func (f *fakeOps) PaneRun(paneID string, command ...string) error {
	if f.paneRun == nil {
		return nil
	}
	return f.paneRun(paneID, command...)
}

func (f *fakeOps) PaneRead(paneID string, lines int) (string, error) {
	f.reads++
	if f.paneRead == nil {
		return "", nil
	}
	return f.paneRead(paneID, lines)
}

func (f *fakeOps) PaneList() ([]herdr.PaneInfo, error) {
	if f.paneList != nil {
		return f.paneList()
	}
	return nil, nil
}

func (f *fakeOps) PaneGet(id string) (herdr.PaneInfo, error) {
	if f.paneGet != nil {
		return f.paneGet(id)
	}
	return herdr.PaneInfo{}, apiErr("pane get", herdr.CodePaneGone)
}

func (f *fakeOps) PaneClose(id string) error {
	return f.paneClose(id)
}

func (f *fakeOps) PaneSplit(id string) error {
	return f.paneSplit(id)
}

func (f *fakeOps) TabLabel(id string) (string, error) {
	return f.tabLabel(id)
}

func (f *fakeOps) WorkspaceLabel(id string) (string, error) {
	return f.workspaceLabel(id)
}

func (f *fakeOps) LookPath(file string) error {
	if f.lookPath == nil {
		return nil
	}
	return f.lookPath(file)
}

func (f *fakeOps) In(session string) ops {
	f.session = session
	return f
}

func (f *fakeOps) CurrentSession() string {
	if f.session != "" {
		return f.session
	}
	return f.current
}

// HasCode is the real thing: the fakes return real *herdr.APIError values, so
// the code-recovery path under test is the one that ships.
func (f *fakeOps) HasCode(err error, code string) bool { return herdr.HasCode(err, code) }

// fast is defaultKnobs with the sleeps taken out.
func fast() knobs {
	return knobs{
		paneReady:        time.Minute,
		paneReadyPoll:    time.Millisecond,
		waitSlice:        30 * time.Second,
		statusPoll:       time.Millisecond,
		promptSettle:     5 * time.Millisecond,
		promptSettleLast: 5 * time.Millisecond,
		workflowPoll:     time.Millisecond,
	}
}

func apiErr(command, code string) error {
	return &herdr.APIError{Command: command, Code: code, Message: code}
}

func TestProvisionOpensAWorktreeOnABranchOfItsOwn(t *testing.T) {
	var gotBranch, gotLabel string
	ops := &fakeOps{worktreeCreate: func(repo, branch, label string) (string, string, error) {
		gotBranch, gotLabel = branch, label
		return "w7", "w7:p1", nil
	}}
	h := &live{ops: ops, knobs: fast()}

	s, err := h.Provision(config.Automation{
		Name: "Weekly sprint planning", Repo: "/x", Workspace: config.WorkspaceWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	if s.WorkspaceID != "w7" || s.PaneID != "w7:p1" {
		t.Fatalf("session = %+v", s)
	}
	// git check-ref-format rejects spaces, so the name has to be slugged before
	// it can become a branch.
	if want := "auto/weekly-sprint-planning-"; len(gotBranch) <= len(want) || gotBranch[:len(want)] != want {
		t.Errorf("branch = %q, want it to start with %q", gotBranch, want)
	}
	if gotLabel != "auto: Weekly sprint planning" {
		t.Errorf("label = %q", gotLabel)
	}
}

func TestProvisionRootModeOpensTheRepoItself(t *testing.T) {
	called := false
	ops := &fakeOps{workspaceCreate: func(cwd, label string) (string, string, error) {
		called = true
		if cwd != "/repo" {
			t.Errorf("cwd = %q", cwd)
		}
		return "w9", "w9:p1", nil
	}}
	h := &live{ops: ops, knobs: fast()}

	if _, err := h.Provision(config.Automation{
		Name: "n", Repo: "/repo", Workspace: config.WorkspaceRoot,
	}); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("root mode must not create a worktree")
	}
}

func TestProvisionRefusesAWorkspaceModeItDoesNotKnow(t *testing.T) {
	// Load validates this, so reaching here means something bypassed it. Saying
	// so beats provisioning nothing and reporting success.
	h := &live{ops: &fakeOps{}, knobs: fast()}
	if _, err := h.Provision(config.Automation{Name: "n", Workspace: "sandbox"}); err == nil {
		t.Fatal("want an error for an unknown workspace mode")
	}
}

func TestDoPicksTheWorkflowAdapterWhenOneIsNamed(t *testing.T) {
	ops := &fakeOps{
		paneRead: func(string, int) (string, error) { return "", errors.New("no screen") },
		lookPath: func(string) error { return errors.New("not found") },
	}
	h := &live{ops: ops, knobs: fast()}

	err := h.Do(Session{PaneID: "p"}, config.Automation{Workflow: "bump"}, time.Minute)
	if err == nil || ops.starts != 0 {
		t.Fatalf("want the hwf adapter chosen, got err=%v starts=%d", err, ops.starts)
	}
}

func TestDoPicksTheAgentAdapterWhenThereIsAPrompt(t *testing.T) {
	ops := &fakeOps{}
	h := &live{ops: ops, knobs: fast()}

	if err := h.Do(Session{PaneID: "p"}, config.Automation{
		Agent: "claude", Prompt: "go", Name: "n",
	}, time.Minute); err != nil {
		t.Fatal(err)
	}
	if ops.starts != 1 || ops.submits != 1 || ops.waits != 1 {
		t.Fatalf("starts=%d submits=%d waits=%d, want one of each", ops.starts, ops.submits, ops.waits)
	}
}

func TestSlugProducesValidBranchNames(t *testing.T) {
	cases := map[string]string{
		"Weekly sprint planning": "weekly-sprint-planning",
		"issue-triage":           "issue-triage",
		"Deps  bump!!":           "deps-bump",
		"  ~weird/name~  ":       "weird-name",
		"???":                    "automation",
	}
	for in, want := range cases {
		if got := slug(in); got != want {
			t.Errorf("slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAgentNameFitsHerdrsLimit(t *testing.T) {
	long := "a-very-long-automation-name-that-herdr-will-not-accept"
	got := agentName(long)
	if len(got) > 32 {
		t.Fatalf("agentName(%q) = %q, %d chars", long, got, len(got))
	}
	if got[len(got)-1] == '-' {
		t.Errorf("agentName(%q) = %q, want no trailing dash", long, got)
	}
}

func TestProvisionExistingUsesFreshTabsInTheSameWorkspace(t *testing.T) {
	calls := 0
	ops := &fakeOps{
		workspaceCreate: func(string, string) (string, string, error) {
			t.Fatal("created a workspace")
			return "", "", nil
		},
		worktreeCreate: func(string, string, string) (string, string, error) {
			t.Fatal("created a worktree")
			return "", "", nil
		},
		tabCreate: func(workspaceID, cwd, label string) (string, string, error) {
			if workspaceID != "w7" || cwd != "/repo" || !strings.HasPrefix(label, "auto: inbox ") {
				t.Fatalf("unexpected tab: %q %q %q", workspaceID, cwd, label)
			}
			calls++
			return fmt.Sprintf("tb%d", calls), fmt.Sprintf("w7:p%d", calls), nil
		},
	}
	h := &live{ops: ops, knobs: fast()}
	a := config.Automation{Name: "inbox", Repo: "/repo", Workspace: config.WorkspaceExisting, WorkspaceID: "w7"}
	first, err := h.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	if first.WorkspaceID != second.WorkspaceID || first.PaneID == second.PaneID || calls != 2 {
		t.Fatalf("runs must share a workspace with distinct panes: %+v %+v", first, second)
	}
	ops.tabCreate = func(string, string, string) (string, string, error) { return "", "", errors.New("workspace gone") }
	if _, err := h.Provision(a); err == nil {
		t.Fatal("missing workspace must fail, never create a replacement")
	}
}

func TestExistingRunsHaveDistinctLiveAgentNames(t *testing.T) {
	seen := map[string]bool{}
	ops := &fakeOps{agentStart: func(name, kind, paneID string, args []string) error {
		if seen[name] || len(name) > 32 {
			t.Fatalf("invalid or reused name %q", name)
		}
		seen[name] = true
		return nil
	}}
	w := agentWork{ops: ops, knobs: fast(), a: config.Automation{Name: strings.Repeat("long-name", 8), Workspace: config.WorkspaceExisting}}
	// Herdr's pane IDs are case-sensitive; agent names are lowercase only. w1D
	// and w1d are two different live tabs and must not fold onto one name.
	for _, pane := range []string{"w7:p1", "w7:p2", "w1D:p1", "w1d:p1", "w17:pB", "w17:pb"} {
		if err := w.start(Session{PaneID: pane}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAgentNameIsTheAutomationsOutsideExistingMode(t *testing.T) {
	// The pane ID only earns its place where earlier runs stay open. Elsewhere
	// the sidebar should keep reading "inbox", not "w7-p1-inbox".
	for _, mode := range []config.Workspace{config.WorkspaceWorktree, config.WorkspaceRoot} {
		a := config.Automation{Name: "inbox", Workspace: mode}
		if got := agentNameFor(a, "w7:p1"); got != "inbox" {
			t.Errorf("agentNameFor(%s) = %q, want %q", mode, got, "inbox")
		}
	}
}

func TestARunNamingASessionIsProvisionedAndWorkedThere(t *testing.T) {
	ops := &fakeOps{current: "default"}
	var provisionedIn, startedIn string
	ops.worktreeCreate = func(string, string, string) (string, string, error) {
		provisionedIn = ops.session
		return "w7", "w7:p1", nil
	}
	ops.agentStart = func(string, string, string, []string) error {
		startedIn = ops.session
		return nil
	}
	h := &live{ops: ops, knobs: fast()}
	a := config.Automation{Name: "n", Repo: "/r", Workspace: config.WorkspaceWorktree,
		Prompt: "p", Session: "automations"}

	s, err := h.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	if provisionedIn != "automations" || s.HerdrSession != "automations" {
		t.Fatalf("provisioned in %q, session = %+v; want automations", provisionedIn, s)
	}
	if err := h.Do(s, a, time.Minute); err != nil {
		t.Fatal(err)
	}
	if startedIn != "automations" {
		t.Fatalf("agent started in %q, want automations", startedIn)
	}
}

func TestARunNamingNoSessionHappensWhereItWasTriggered(t *testing.T) {
	ops := &fakeOps{current: "alt"}
	h := &live{ops: ops, knobs: fast()}
	s, err := h.Provision(config.Automation{Name: "n", Repo: "/r", Workspace: config.WorkspaceRoot})
	if err != nil {
		t.Fatal(err)
	}
	if ops.session != "" || s.HerdrSession != "alt" {
		t.Fatalf("bound to %q, session = %+v; want unbound, recorded as alt", ops.session, s)
	}
}

// ── closing a done run's workspace (ADR 0012) ───────────────────────

func TestCloseClosesTheRunsWorkspaceInItsSession(t *testing.T) {
	ops := &fakeOps{agentStatus: func(string) (string, error) { return "idle", nil }}
	h := &live{ops: ops, knobs: fast()}
	s := Session{WorkspaceID: "w1", PaneID: "w1:p1", HerdrSession: "auto"}
	if err := h.Close(s, config.Automation{Prompt: "p"}); err != nil {
		t.Fatal(err)
	}
	if len(ops.closed) != 1 || ops.closed[0] != "w1" || ops.closedIn[0] != "auto" {
		t.Fatalf("closed %q in %q, want w1 in auto", ops.closed, ops.closedIn)
	}
}

// herdr's agent wait counts blocked as settled, so a run waiting on a person
// is recorded done: its workspace is the one place that question is asked.
func TestCloseLeavesAnAgentWaitingOnAPerson(t *testing.T) {
	ops := &fakeOps{agentStatus: func(string) (string, error) { return "blocked", nil }}
	h := &live{ops: ops, knobs: fast()}
	if err := h.Close(Session{WorkspaceID: "w1", PaneID: "w1:p1"}, config.Automation{Prompt: "p"}); err == nil {
		t.Fatal("want an error saying why the workspace stays open")
	}
	if len(ops.closed) != 0 {
		t.Fatalf("closed %q under a blocked agent", ops.closed)
	}
}

func TestCloseCountsAWorkspaceAlreadyGoneAsClosed(t *testing.T) {
	ops := &fakeOps{
		agentStatus:    func(string) (string, error) { return "idle", nil },
		workspaceClose: func(string) error { return apiErr("workspace close", herdr.CodeWorkspaceGone) },
	}
	h := &live{ops: ops, knobs: fast()}
	if err := h.Close(Session{WorkspaceID: "w1", PaneID: "w1:p1"}, config.Automation{Prompt: "p"}); err != nil {
		t.Fatalf("want nil for a workspace already closed, got %v", err)
	}
}

// Existing mode shares its workspace with every other tab: a successful run
// asks to close its own tab and leaves the last tab it can see.
func TestCloseExistingClosesOnlyTheRunsTab(t *testing.T) {
	ops := &fakeOps{
		agentStatus: func(string) (string, error) { return "idle", nil },
		tabList:     func(string) ([]string, error) { return []string{"tb7", "tb8"}, nil },
	}
	h := &live{ops: ops, knobs: fast()}
	s := Session{WorkspaceID: "w7", PaneID: "w7:p2", TabID: "tb7", HerdrSession: "auto"}
	a := config.Automation{Prompt: "p", Workspace: config.WorkspaceExisting, WorkspaceID: "w7"}

	if err := h.Close(s, a); err != nil {
		t.Fatal(err)
	}
	if len(ops.closed) != 0 {
		t.Fatalf("closed the shared workspace: %q", ops.closed)
	}
	if len(ops.closedTabs) != 1 || ops.closedTabs[0] != "tb7" || ops.tabsIn[0] != "auto" {
		t.Fatalf("closed tabs %q in %q, want tb7 in auto", ops.closedTabs, ops.tabsIn)
	}
	if ops.tabListCalls != 1 || ops.tabListWorkspace != "w7" {
		t.Fatalf("listed tabs %d time(s) for %q, want once for w7", ops.tabListCalls, ops.tabListWorkspace)
	}
}

// A person can close the space's other tabs while the run works. Closing the
// run's tab then would close the shared space, so the last tab stays open.
func TestCloseExistingLeavesTheLastTabOpen(t *testing.T) {
	var logged bytes.Buffer
	old := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(old)
	ops := &fakeOps{
		agentStatus: func(string) (string, error) { return "idle", nil },
		tabList:     func(string) ([]string, error) { return []string{"tb7"}, nil },
	}
	h := &live{ops: ops, knobs: fast()}
	s := Session{WorkspaceID: "w7", PaneID: "w7:p2", TabID: "tb7"}
	a := config.Automation{Prompt: "p", Workspace: config.WorkspaceExisting, WorkspaceID: "w7"}

	if err := h.Close(s, a); err != nil {
		t.Fatal(err)
	}
	if len(ops.closedTabs) != 0 || len(ops.closed) != 0 {
		t.Fatalf("closed the last tab: tabs %q workspaces %q", ops.closedTabs, ops.closed)
	}
	if !strings.Contains(logged.String(), "last one in its space") {
		t.Fatalf("the refusal was not logged: %q", logged.String())
	}
}

// A tab that is not on the list is not safe to aim at: the list moved or the
// tab is gone, and closing by id would still take the space's last tab.
func TestCloseExistingLeavesATabThatIsNotListed(t *testing.T) {
	var logged bytes.Buffer
	old := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(old)
	ops := &fakeOps{
		agentStatus: func(string) (string, error) { return "idle", nil },
		tabList:     func(string) ([]string, error) { return []string{"tb8"}, nil },
	}
	h := &live{ops: ops, knobs: fast()}
	s := Session{WorkspaceID: "w7", PaneID: "w7:p2", TabID: "tb7"}
	a := config.Automation{Prompt: "p", Workspace: config.WorkspaceExisting, WorkspaceID: "w7"}

	if err := h.Close(s, a); err != nil {
		t.Fatal(err)
	}
	if len(ops.closedTabs) != 0 || len(ops.closed) != 0 {
		t.Fatalf("closed an unlisted tab: tabs %q workspaces %q", ops.closedTabs, ops.closed)
	}
	if !strings.Contains(logged.String(), "not in the space's tab list") {
		t.Fatalf("the refusal was not logged: %q", logged.String())
	}
}

// The read and the close cannot be one step: a person who closes the space's
// other tab in between leaves the run's tab last. The scheduler still asks only
// for its own tab; the app is what closes a space whose last tab goes.
func TestCloseExistingRaceAfterTheReadClosesOnlyItsTab(t *testing.T) {
	tabs := []string{"tb7", "tb8"}
	ops := &fakeOps{
		agentStatus: func(string) (string, error) { return "idle", nil },
		tabList:     func(string) ([]string, error) { return append([]string{}, tabs...), nil },
		tabClose: func(string) error {
			tabs = []string{"tb7"}
			return nil
		},
	}
	h := &live{ops: ops, knobs: fast()}
	s := Session{WorkspaceID: "w7", PaneID: "w7:p2", TabID: "tb7"}
	a := config.Automation{Prompt: "p", Workspace: config.WorkspaceExisting, WorkspaceID: "w7"}

	if err := h.Close(s, a); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ops.closedTabs, "|"); got != "tb7" {
		t.Fatalf("closed tabs %q, want only tb7", got)
	}
	if len(ops.closed) != 0 {
		t.Fatalf("the scheduler issued a space close: %q", ops.closed)
	}
}

func TestCloseExistingLeavesTheTabOpenWhenTheListIsUnreadable(t *testing.T) {
	var logged bytes.Buffer
	old := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(old)
	ops := &fakeOps{
		agentStatus: func(string) (string, error) { return "idle", nil },
		tabList:     func(string) ([]string, error) { return nil, errors.New("herdr is down") },
	}
	h := &live{ops: ops, knobs: fast()}
	s := Session{WorkspaceID: "w7", PaneID: "w7:p2", TabID: "tb7"}
	a := config.Automation{Prompt: "p", Workspace: config.WorkspaceExisting, WorkspaceID: "w7"}

	if err := h.Close(s, a); err != nil {
		t.Fatal(err)
	}
	if len(ops.closedTabs) != 0 || len(ops.closed) != 0 {
		t.Fatalf("closed without a tab list: tabs %q workspaces %q", ops.closedTabs, ops.closed)
	}
	if !strings.Contains(logged.String(), "cannot read the space's tabs") {
		t.Fatalf("the refusal was not logged: %q", logged.String())
	}
}

// No tab id means no safe target: close nothing rather than guess at a tab.
func TestCloseExistingWithNoTabIDClosesNothing(t *testing.T) {
	ops := &fakeOps{agentStatus: func(string) (string, error) { return "idle", nil }}
	h := &live{ops: ops, knobs: fast()}
	s := Session{WorkspaceID: "w7", PaneID: "w7:p2"}
	a := config.Automation{Prompt: "p", Workspace: config.WorkspaceExisting, WorkspaceID: "w7"}

	if err := h.Close(s, a); err != nil {
		t.Fatal(err)
	}
	if len(ops.closedTabs) != 0 || len(ops.closed) != 0 {
		t.Fatalf("closed something without a tab id: tabs %q workspaces %q", ops.closedTabs, ops.closed)
	}
}

// Worktree and root runs still close their own workspace; the tab rule is
// existing mode's alone.
func TestCloseWorktreeAndRootStillCloseTheWorkspace(t *testing.T) {
	for _, mode := range []config.Workspace{config.WorkspaceWorktree, config.WorkspaceRoot} {
		ops := &fakeOps{agentStatus: func(string) (string, error) { return "idle", nil }}
		h := &live{ops: ops, knobs: fast()}
		s := Session{WorkspaceID: "w1", PaneID: "w1:p1", TabID: "tb1"}
		if err := h.Close(s, config.Automation{Prompt: "p", Workspace: mode}); err != nil {
			t.Fatal(err)
		}
		if len(ops.closed) != 1 || ops.closed[0] != "w1" {
			t.Errorf("%s: closed workspaces %q, want w1", mode, ops.closed)
		}
		if len(ops.closedTabs) != 0 {
			t.Errorf("%s: closed tabs %q, want none", mode, ops.closedTabs)
		}
	}
}

// backend: auto resolves to the TUI's server when herdr-core is down. A target
// must fail there, never fall back to the fresh session it exists to replace.
func TestTargetRefusesWithoutHerdrCore(t *testing.T) {
	h := &live{ops: &fakeOps{}, knobs: fast()}
	_, err := h.Provision(config.Automation{Name: "housekeeping", Target: "bot:b-6jrz4bmxml", Repo: "/src/project"})
	if err == nil || !strings.Contains(err.Error(), "a target needs herdr-core") {
		t.Fatalf("err %v", err)
	}
}

func TestHerdrPreviousAndRemovePreserveSharedLastTab(t *testing.T) {
	s := Session{PaneID: "w7:p2", WorkspaceID: "w7", HerdrSession: "other"}
	var calls []string
	pane := herdr.PaneInfo{PaneID: s.PaneID, WorkspaceID: "w7", TabID: "tb1", TerminalID: "t8"}
	f := &fakeOps{
		paneList: func() ([]herdr.PaneInfo, error) { return []herdr.PaneInfo{pane}, nil },
		paneGet:  func(string) (herdr.PaneInfo, error) { return pane, nil },
		tabLabel: func(string) (string, error) { return "auto: triage 2026-11-27 10:20", nil },
		tabList:  func(string) ([]string, error) { return []string{"tb1"}, nil },
		paneSplit: func(id string) error {
			calls = append(calls, "split "+id)
			return nil
		},
		paneClose: func(id string) error {
			calls = append(calls, "close "+id)
			return nil
		},
	}
	h := &live{ops: f}
	a := config.Automation{Name: "triage"}
	previous, err := h.Previous(a, []Session{s})
	if err != nil || len(previous) != 1 || previous[0].Workspace != config.WorkspaceExisting ||
		previous[0].TerminalID != "t8" {
		t.Fatalf("previous = %+v, err = %v", previous, err)
	}
	if err := h.Remove(previous[0], a); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(calls, ","); got != "split w7:p2,close w7:p2" || f.session != "other" {
		t.Fatalf("calls = %s, session = %s", got, f.session)
	}
}
