package host

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/hc"
)

// fakeHC scripts herdr-core and git: each Wait pops the next answer.
type fakeHC struct {
	cwd        string
	labels     map[string]string
	argv       []string
	worktree   [3]string // repo, branch, path
	waits      []hc.Wait
	term       hc.Terminal
	screen     string
	screenErr  error
	terminals  []string
	termSeq    [][]string // one answer per call, the last repeating; wins over terminals
	termCalls  int
	termErr    error
	termLabels map[string]string
	runErr     error
	delay      time.Duration // per Wait
	onWait     func()        // lets a test advance its clock
	onKill     func()        // lets a test change the space at the read/act boundary
	calls      []string      // kill and rm, with their address
	readCalls  int
	killErr    error
	sent       []string // hc send's texts, in order
	sendErr    error
}

func (f *fakeHC) Send(address, text string) error {
	f.calls = append(f.calls, "send "+address)
	f.sent = append(f.sent, text)
	return f.sendErr
}

func (f *fakeHC) Kill(address string) error {
	if f.onKill != nil {
		f.onKill()
	}
	f.calls = append(f.calls, "kill "+address)
	return f.killErr
}

func (f *fakeHC) Rm(address string) error {
	f.calls = append(f.calls, "rm "+address)
	return nil
}

func (f *fakeHC) Read(string) (string, error) {
	f.readCalls++
	return f.screen, f.screenErr
}

func (f *fakeHC) Terminals(labels map[string]string) ([]string, error) {
	f.termLabels = labels
	if f.termSeq != nil {
		at := f.termCalls
		f.termCalls++
		if at >= len(f.termSeq) {
			at = len(f.termSeq) - 1
		}
		return f.termSeq[at], f.termErr
	}
	return f.terminals, f.termErr
}

func (f *fakeHC) Run(cwd string, labels map[string]string, argv []string) (string, error) {
	f.cwd, f.labels, f.argv = cwd, labels, argv
	return "t7", f.runErr
}

func (f *fakeHC) Wait(string, time.Duration) (hc.Wait, error) {
	time.Sleep(f.delay)
	if f.onWait != nil {
		f.onWait()
	}
	if len(f.waits) == 0 {
		return hc.Wait{Reason: "timeout"}, nil
	}
	w := f.waits[0]
	f.waits = f.waits[1:]
	return w, nil
}

func (f *fakeHC) Get(string) (hc.Terminal, error) { return f.term, nil }

func (f *fakeHC) MainCheckout(string) (string, error) { return "/src/myapp", nil }

func (f *fakeHC) WorktreeAdd(repo, branch, path string) error {
	f.worktree = [3]string{repo, branch, path}
	return nil
}

func newHCTest(f *fakeHC) *hcHost {
	return &hcHost{ops: f, home: "/home/me", knobs: knobs{
		paneReady: 30 * time.Millisecond, waitSlice: time.Millisecond, statusPoll: time.Millisecond,
	}}
}

func hcAutomation() config.Automation {
	return config.Automation{
		Name: "Issue triage", Repo: "/src/myapp/sub", Workspace: config.WorkspaceWorktree,
		Agent: "claude", Model: "sonnet", Prompt: "Triage the issues",
	}
}

// A run made the way the app's own "New worktree…" makes one, so the app
// nests it under its repo: same root, same folder name for the branch, and a
// space id the app has never seen.
func TestHCProvisionMakesAWorktreeTheAppRecognises(t *testing.T) {
	f := &fakeHC{}
	s, err := newHCTest(f).Provision(hcAutomation())
	if err != nil {
		t.Fatal(err)
	}
	repo, branch, path := f.worktree[0], f.worktree[1], f.worktree[2]
	if repo != "/src/myapp/sub" || !strings.HasPrefix(branch, "auto/issue-triage-") {
		t.Fatalf("worktree add %q %q", repo, branch)
	}
	if want := filepath.Join("/home/me/.herdr/worktrees/myapp", strings.ReplaceAll(branch, "/", "-")); path != want {
		t.Fatalf("path %q, want %q", path, want)
	}
	if f.cwd != path {
		t.Fatalf("agent started in %q, not the worktree", f.cwd)
	}
	space, tab := f.labels["herdr.space"], f.labels["herdr.tab"]
	if !strings.HasPrefix(space, "sp") || len(space) != 34 || !strings.HasPrefix(tab, "tb") || len(tab) != 34 {
		t.Fatalf("ids not in the app's shape: space %q tab %q", space, tab)
	}
	if f.labels["automation"] != "Issue triage" {
		t.Fatalf("labels %v", f.labels)
	}
	if got := strings.Join(f.argv, " "); got != "claude --model sonnet Triage the issues" {
		t.Fatalf("argv %q", got)
	}
	if s.WorkspaceID != space || s.PaneID != "t7" {
		t.Fatalf("session %+v", s)
	}
}

// ADR 0009: the space is the user's, named in the file, never guessed.
func TestHCProvisionExistingOpensATabInTheNamedSpace(t *testing.T) {
	f := &fakeHC{}
	a := hcAutomation()
	a.Workspace, a.WorkspaceID = config.WorkspaceExisting, "sp123"
	s, err := newHCTest(f).Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	if f.worktree[0] != "" || f.cwd != a.Repo || f.labels["herdr.space"] != "sp123" || s.WorkspaceID != "sp123" {
		t.Fatalf("worktree %v cwd %q labels %v", f.worktree, f.cwd, f.labels)
	}
}

// copilot rejects a bare prompt ("Invalid command format") and -p would exit
// after one answer; -i keeps it interactive so hc can watch it finish.
func TestHCProvisionHandsCopilotItsPromptWithDashI(t *testing.T) {
	f := &fakeHC{}
	a := hcAutomation()
	a.Agent = "copilot"
	if _, err := newHCTest(f).Provision(a); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.argv, "|"); got != "copilot|--model|sonnet|-i|Triage the issues" {
		t.Fatalf("argv %q", got)
	}
}

func TestHCProvisionHandsCopilotItsMCPConfigAndPrompt(t *testing.T) {
	f := &fakeHC{}
	a := hcAutomation()
	a.Agent = "copilot"
	a.MCPConfig = "/mcp config.json"
	a.AgentArgs = []string{"--no-ask-user"}
	if _, err := newHCTest(f).Provision(a); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.argv, "|"); got != "copilot|--additional-mcp-config|@/mcp config.json|--model|sonnet|--no-ask-user|-i|Triage the issues" {
		t.Fatalf("argv %q", got)
	}
}

func TestHCProvisionHandsATemplateItsTask(t *testing.T) {
	f := &fakeHC{}
	a := hcAutomation()
	a.Agent, a.Model, a.Template = "", "", "reviewer"
	if _, err := newHCTest(f).Provision(a); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.argv, "|"); got != "reviewer|Triage the issues" {
		t.Fatalf("argv %q", got)
	}
}

// Exercise Provision's hc seam without launching an agent or reading local templates.
func TestHCProvisionLaunchArguments(t *testing.T) {
	tests := []struct {
		name string
		a    config.Automation
		want []string
	}{
		{
			name: "codex agent default",
			a:    config.Automation{Agent: "codex"},
			want: []string{"codex", "--no-daemon", "Task\nwith instructions"},
		},
		{
			name: "codex automatic permissions",
			a: config.Automation{
				Agent: "codex", AgentArgs: config.DefaultAgentArgs("codex"),
			},
			want: []string{
				"codex", "--no-daemon", "--dangerously-bypass-approvals-and-sandbox",
				"Task\nwith instructions",
			},
		},
		{
			name: "codex custom arguments",
			a: config.Automation{
				Agent: "codex", Model: "configured-model", MCPConfig: "/scratch/mcp config.json",
				AgentArgs: []string{
					"--ask-for-approval", "on-request", "--sandbox", "workspace-write",
					"--model", "explicit-model", "-c", "custom_instruction=keep this",
				},
			},
			want: []string{
				"codex", "--no-daemon", "--mcp-config", "/scratch/mcp config.json",
				"--model", "configured-model", "--ask-for-approval", "on-request",
				"--sandbox", "workspace-write", "--model", "explicit-model",
				"-c", "custom_instruction=keep this", "Task\nwith instructions",
			},
		},
		{
			name: "codex keeps an explicit no-daemon argument",
			a: config.Automation{
				Agent: "codex", AgentArgs: []string{"--no-daemon", "--approve-for-me"},
			},
			want: []string{
				"codex", "--no-daemon", "--approve-for-me",
				"Task\nwith instructions",
			},
		},
		{
			name: "template keeps name and task",
			a: config.Automation{
				Template: "codex-reviewer", AgentArgs: []string{"--ignored-for-template"},
			},
			want: []string{"codex-reviewer", "Task\nwith instructions"},
		},
		{
			name: "claude keeps its permissions",
			a: config.Automation{
				Agent: "claude", Model: "sonnet", AgentArgs: config.DefaultAgentArgs("claude"),
			},
			want: []string{
				"claude", "--model", "sonnet", "--dangerously-skip-permissions",
				"Task\nwith instructions",
			},
		},
		{
			name: "pi keeps explicit arguments",
			a: config.Automation{
				Agent: "pi", AgentArgs: []string{"--provider", "example", "--model", "example"},
			},
			want: []string{
				"pi", "--provider", "example", "--model", "example", "Task\nwith instructions",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := tt.a
			a.Repo, a.Workspace = t.TempDir(), config.WorkspaceRoot
			a.Name, a.Prompt = tt.name, "Task\nwith instructions"
			argsBefore := append([]string(nil), a.AgentArgs...)
			f := &fakeHC{}
			if _, err := newHCTest(f).Provision(a); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(f.argv, tt.want) {
				t.Fatalf("launch arguments = %q, want %q", f.argv, tt.want)
			}
			if !reflect.DeepEqual(a.AgentArgs, argsBefore) {
				t.Fatal("launch mutated configured agent arguments")
			}
		})
	}
}

func TestHCDo(t *testing.T) {
	status := func(state string) *struct {
		State string `json:"state"`
	} {
		return &struct {
			State string `json:"state"`
		}{State: state}
	}
	code, zero := 2, 0
	cases := []struct {
		name    string
		waits   []hc.Wait
		term    hc.Terminal
		want    string // "" = success, "cancelled" = ErrCancelled, else a substring
		timeout time.Duration
		slow    bool // each wait takes longer than paneReady
	}{
		{name: "done", waits: []hc.Wait{{Ended: true, Reason: "status", Status: "done", Turn: 1}}},
		{name: "idle after its turn", waits: []hc.Wait{{Ended: true, Reason: "status", Status: "idle", Turn: 1}}},
		{name: "blocked, then done", waits: []hc.Wait{
			{Ended: true, Reason: "status", Status: "blocked", Turn: 1},
			{Ended: true, Reason: "status", Status: "done", Turn: 1},
		}},
		{name: "idle before the prompt landed is not done", waits: []hc.Wait{
			{Ended: true, Reason: "status", Status: "idle", Turn: 0},
			{Ended: true, Reason: "status", Status: "done", Turn: 1},
		}},
		{name: "space closed in the app", waits: []hc.Wait{{Ended: true, Reason: "exit"}},
			term: hc.Terminal{State: "finished", Reason: "killed"}, want: "cancelled"},
		{name: "agent exited", waits: []hc.Wait{{Ended: true, Reason: "exit", ExitCode: &code}},
			term: hc.Terminal{State: "finished", Reason: "exited", ExitCode: &code}, want: "exited with code 2"},
		// #938, a finished run listed failed: the agent's own done is enough.
		// A turn shorter than one wait is never seen working, and an agent
		// that reports no turn count stays at turn 0.
		{name: "done at turn 0, never seen working", waits: []hc.Wait{
			{Ended: true, Reason: "status", Status: "idle", Turn: 0},
			{Ended: true, Reason: "status", Status: "done", Turn: 0},
		}},
		{name: "done at turn 0 after paneReady is not never started", waits: []hc.Wait{
			{Ended: false, Reason: "timeout", Turn: 0},
			{Ended: false, Reason: "timeout", Turn: 0},
			{Ended: true, Reason: "status", Status: "done", Turn: 0},
		}, term: hc.Terminal{State: "live", Status: status("done")}, slow: true},
		// #938, the same direction: a program that left on its own with exit
		// code 0 is not a crash, when nothing says its work was cut short: it
		// never reported a status (a plain program, a template's script), or
		// its last word was done, or idle after its turn.
		{name: "exited 0, a program that reports no status", waits: []hc.Wait{{Ended: true, Reason: "exit", ExitCode: &zero}},
			term: hc.Terminal{State: "finished", Reason: "exited", ExitCode: &zero}},
		{name: "exited 0 after saying done", waits: []hc.Wait{{Ended: true, Reason: "exit", ExitCode: &zero}},
			term: hc.Terminal{State: "finished", Reason: "exited", ExitCode: &zero, Status: status("done")}},
		{name: "exited 0, idle after its turn", waits: []hc.Wait{
			{Ended: false, Reason: "timeout", Status: "working", Turn: 1},
			{Ended: true, Reason: "exit", ExitCode: &zero},
		}, term: hc.Terminal{State: "finished", Reason: "exited", ExitCode: &zero, Status: status("idle")}},
		// And the other direction: agents exit 0 when a person quits them, so
		// exit 0 from an agent that had not finished is not done.
		{name: "quit mid-turn with exit 0", waits: []hc.Wait{
			{Ended: false, Reason: "timeout", Status: "working", Turn: 1},
			{Ended: true, Reason: "exit", ExitCode: &zero},
		}, term: hc.Terminal{State: "finished", Reason: "exited", ExitCode: &zero, Status: status("working")},
			want: "exited with code 0 before finishing"},
		{name: "quit on a dialog with exit 0", waits: []hc.Wait{
			{Ended: true, Reason: "status", Status: "blocked", Turn: 1},
			{Ended: true, Reason: "exit", ExitCode: &zero},
		}, term: hc.Terminal{State: "finished", Reason: "exited", ExitCode: &zero, Status: status("blocked")},
			want: "exited with code 0 before finishing"},
		{name: "exit 0 before any work", waits: []hc.Wait{
			{Ended: true, Reason: "status", Status: "idle", Turn: 0},
			{Ended: true, Reason: "exit", ExitCode: &zero},
		}, term: hc.Terminal{State: "finished", Reason: "exited", ExitCode: &zero, Status: status("idle")},
			want: "exited with code 0 before finishing"},
		{name: "exited with no code", waits: []hc.Wait{{Ended: true, Reason: "exit"}},
			term: hc.Terminal{State: "finished", Reason: "exited"}, want: "exited before finishing"},
		// #938, a failed run listed done: a dialog before the prompt was read
		// is not work, so the idle after it is not a finished turn. Nothing
		// ran here, and the run ends as never started, not done.
		{name: "blocked before any turn, then idle, is not done", waits: []hc.Wait{
			{Ended: true, Reason: "status", Status: "blocked", Turn: 0},
			{Ended: true, Reason: "status", Status: "idle", Turn: 0},
		}, want: "never started working", timeout: time.Second},
		{name: "blocked before any turn, then its turn", waits: []hc.Wait{
			{Ended: true, Reason: "status", Status: "blocked", Turn: 0},
			{Ended: true, Reason: "status", Status: "idle", Turn: 0},
			{Ended: false, Reason: "timeout", Status: "working", Turn: 1},
			{Ended: true, Reason: "status", Status: "idle", Turn: 1},
		}},
		{name: "error after work is not done", waits: []hc.Wait{
			{Ended: false, Reason: "timeout", Status: "working", Turn: 1},
			{Ended: true, Reason: "status", Status: "error", Turn: 1},
			{Ended: true, Reason: "status", Status: "idle", Turn: 1},
		}, want: "reported an error"},
		{name: "agent error", waits: []hc.Wait{{Ended: true, Reason: "status", Status: "error", Turn: 1}}, want: "error"},
		// pi counts its turn when the turn ends, Claude when it starts: working
		// at turn 0 for longer than paneReady is pi on a long task, not a dialog.
		{name: "pi working at turn 0, then done", waits: []hc.Wait{
			{Ended: false, Reason: "timeout", Status: "working", Turn: 0},
			{Ended: false, Reason: "timeout", Status: "working", Turn: 0},
			{Ended: true, Reason: "status", Status: "done", Turn: 1},
		}, slow: true},
		// A trust dialog: no status at all, ever. Without a bound the run would
		// hold its slot for the whole timeout.
		{name: "never started", want: "never started working", timeout: time.Second},
		{name: "still working at the deadline", waits: []hc.Wait{
			{Ended: true, Reason: "status", Status: "working", Turn: 1},
		}, want: "still working", timeout: 5 * time.Millisecond},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeHC{waits: c.waits, term: c.term, delay: map[bool]time.Duration{true: 40 * time.Millisecond}[c.slow]}
			h := newHCTest(f)
			if c.name == "still working at the deadline" {
				h.knobs.paneReady = time.Hour
			}
			timeout := c.timeout
			if timeout == 0 {
				timeout = time.Second
			}
			err := h.Do(Session{PaneID: "t7"}, hcAutomation(), timeout)
			switch {
			case c.want == "" && err != nil:
				t.Fatalf("want success, got %v", err)
			case c.want == "cancelled" && !errors.Is(err, ErrCancelled):
				t.Fatalf("want cancelled, got %v", err)
			case c.want != "" && c.want != "cancelled" && (err == nil || !strings.Contains(err.Error(), c.want)):
				t.Fatalf("want %q, got %v", c.want, err)
			}
		})
	}
}

// The app removes a space once its terminal is killed (measured 2026-11-04);
// rm keeps the finished terminal out of hc ls --all.
func TestHCCloseKillsThenRemovesTheRunsTerminal(t *testing.T) {
	f := &fakeHC{}
	if err := newHCTest(f).Close(Session{WorkspaceID: "sp1", PaneID: "t7"}, hcAutomation()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls, "|"); got != "kill t7|rm t7" {
		t.Fatalf("calls %q", got)
	}
}

func TestHCCloseCountsATerminalAlreadyGoneAsClosed(t *testing.T) {
	f := &fakeHC{killErr: fmt.Errorf("hc kill: no terminal: %w", hc.ErrNotFound)}
	if err := newHCTest(f).Close(Session{WorkspaceID: "sp1", PaneID: "t7"}, hcAutomation()); err != nil {
		t.Fatalf("want nil for a terminal already gone, got %v", err)
	}
}

func hcExistingAutomation() config.Automation {
	a := hcAutomation()
	a.Workspace, a.WorkspaceID = config.WorkspaceExisting, "sp7"
	return a
}

// The app removes a space with its last tab, so a run sharing a space may end
// its own terminal only while another terminal (another tab) is still there.
func TestHCCloseExistingEndsOnlyTheRunsTerminalWhenAnotherTabExists(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7", "t8"}}
	err := newHCTest(f).Close(Session{WorkspaceID: "sp7", PaneID: "t7", TabID: "tb7"}, hcExistingAutomation())
	if err != nil {
		t.Fatal(err)
	}
	if f.termLabels["herdr.space"] != "sp7" {
		t.Fatalf("looked for terminals labeled %v, want the run's space", f.termLabels)
	}
	if got := strings.Join(f.calls, "|"); got != "kill t7|rm t7" {
		t.Fatalf("calls %q, want only the run's terminal ended", got)
	}
}

func TestHCCloseExistingLeavesTheLastTabOpen(t *testing.T) {
	var logged bytes.Buffer
	old := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(old)
	f := &fakeHC{terminals: []string{"t7"}}
	err := newHCTest(f).Close(Session{WorkspaceID: "sp7", PaneID: "t7", TabID: "tb7"}, hcExistingAutomation())
	if err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 0 {
		t.Fatalf("ended the last tab's terminal: %q", f.calls)
	}
	if !strings.Contains(logged.String(), "last one in its space") {
		t.Fatalf("the refusal was not logged: %q", logged.String())
	}
}

func TestHCCloseExistingWithNoTabIDClosesNothing(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7", "t8"}}
	if err := newHCTest(f).Close(Session{WorkspaceID: "sp7", PaneID: "t7"}, hcExistingAutomation()); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 0 {
		t.Fatalf("closed a tab it could not name: %q", f.calls)
	}
}

// The read and the kill cannot be one step: a person who closes the space's
// other tab in between leaves the run's tab last. The scheduler still asks only
// for its own terminal; the app is what closes a space whose last tab goes.
func TestHCCloseExistingRaceAfterTheReadEndsOnlyItsTerminal(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7", "t8"}}
	f.onKill = func() { f.terminals = []string{"t7"} }
	err := newHCTest(f).Close(Session{WorkspaceID: "sp7", PaneID: "t7", TabID: "tb7"}, hcExistingAutomation())
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls, "|"); got != "kill t7|rm t7" {
		t.Fatalf("calls %q, want only the run's terminal", got)
	}
}

func TestHCCloseExistingListFailureLeavesTheTabOpen(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7", "t8"}, termErr: errors.New("hc is down")}
	if err := newHCTest(f).Close(Session{WorkspaceID: "sp7", PaneID: "t7", TabID: "tb7"}, hcExistingAutomation()); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 0 {
		t.Fatalf("closed without knowing the space's tabs: %q", f.calls)
	}
}

// A dialog is not work: the run must fail at the grace with the line the
// person would have read, and the blocked agent must not be left waiting.
func TestHCDoFailsAtOnceOnALongBlockedDialog(t *testing.T) {
	clock := time.Unix(0, 0)
	blocked := hc.Wait{Ended: true, Reason: "status", Status: "blocked", Turn: 1}
	f := &fakeHC{
		waits:  []hc.Wait{blocked, blocked, blocked, blocked},
		onWait: func() { clock = clock.Add(time.Minute) },
		screen: "╭──────────────────────────╮\n" +
			"│ Bash command             │\n" +
			"╰──────────────────────────╯\n" +
			"Do you want to proceed?\n" +
			"❯ 1. Yes\n" +
			"  2. No\n" +
			"Esc to cancel\n",
	}
	h := newHCTest(f)
	h.clock = func() time.Time { return clock }
	a := hcAutomation()
	a.BlockedGraceMinutes = 2

	err := h.Do(Session{PaneID: "t7"}, a, 200*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "blocked on a dialog: Do you want to proceed?") {
		t.Fatalf("want the dialog line reported, got %v", err)
	}
	if strings.Contains(err.Error(), "still working") {
		t.Fatalf("waited for the timeout instead of failing at the grace: %v", err)
	}
	if f.readCalls != 1 {
		t.Errorf("read the screen %d times, want once", f.readCalls)
	}
	if got := strings.Join(f.calls, "|"); got != "kill t7" {
		t.Fatalf("calls %q, want the blocked agent's terminal ended and nothing else", got)
	}
}

// A blip under the grace is not a failure: the agent can block while it asks
// for something it then gets past, and the run still finishes.
func TestHCDoDoesNotFailABlockedBlipUnderTheGrace(t *testing.T) {
	clock := time.Unix(0, 0)
	f := &fakeHC{
		waits: []hc.Wait{
			{Ended: true, Reason: "status", Status: "blocked", Turn: 1},
			{Ended: true, Reason: "status", Status: "working", Turn: 1},
			{Ended: true, Reason: "status", Status: "done", Turn: 1},
		},
		onWait: func() { clock = clock.Add(time.Minute) },
	}
	h := newHCTest(f)
	h.clock = func() time.Time { return clock }
	a := hcAutomation()
	a.BlockedGraceMinutes = 2

	if err := h.Do(Session{PaneID: "t7"}, a, time.Hour); err != nil {
		t.Fatalf("a blocked blip failed the run: %v", err)
	}
	if len(f.calls) != 0 {
		t.Fatalf("ended the agent after a blip: %q", f.calls)
	}
}

// -1 keeps the old behaviour: wait as long as the timeout allows.
func TestHCDoWaitsOutBlockedWhenTheGraceIsMinusOne(t *testing.T) {
	clock := time.Unix(0, 0)
	blocked := hc.Wait{Ended: true, Reason: "status", Status: "blocked", Turn: 1}
	f := &fakeHC{
		waits:  []hc.Wait{blocked, blocked, blocked, {Ended: true, Reason: "status", Status: "done", Turn: 1}},
		onWait: func() { clock = clock.Add(10 * time.Minute) },
	}
	h := newHCTest(f)
	h.clock = func() time.Time { return clock }
	a := hcAutomation()
	a.BlockedGraceMinutes = -1

	if err := h.Do(Session{PaneID: "t7"}, a, time.Hour); err != nil {
		t.Fatalf("grace -1 failed a blocked run: %v", err)
	}
	if len(f.calls) != 0 {
		t.Fatalf("ended the agent under grace -1: %q", f.calls)
	}
}
