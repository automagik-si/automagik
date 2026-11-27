package host

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/hc"
)

// #1416: an hc agent slow to report its first turn was failed as "never
// started" at paneReady while it went on to work in its pane.

// seqHC scripts the terminal's own answers over time, on top of fakeHC's
// waits: each Get pops the next state (the last one stays), each Read the
// next screen (the last one stays).
type seqHC struct {
	*fakeHC
	gets    []string // "" = no status reported
	screens []string
	readErr error
	reads   int
}

func (f *seqHC) Get(string) (hc.Terminal, error) {
	state := ""
	if len(f.gets) > 0 {
		state = f.gets[0]
		if len(f.gets) > 1 {
			f.gets = f.gets[1:]
		}
	}
	if state == "" {
		return hc.Terminal{State: "live"}, nil
	}
	t := hc.Terminal{State: "live"}
	t.Status = &struct {
		State string `json:"state"`
	}{State: state}
	return t, nil
}

func (f *seqHC) Read(string) (string, error) {
	f.reads++
	if f.readErr != nil {
		return "", f.readErr
	}
	if len(f.screens) == 0 {
		return "", nil
	}
	s := f.screens[0]
	if len(f.screens) > 1 {
		f.screens = f.screens[1:]
	}
	return s, nil
}

const trustScreen = "╭──────────────────────────────────────────╮\n" +
	"│ Do you trust the files in this folder?   │\n" +
	"│                                          │\n" +
	"│ ❯ 1. Yes, proceed                        │\n" +
	"│   2. No, exit                            │\n" +
	"╰──────────────────────────────────────────╯\n" +
	"  Enter to confirm · Esc to exit\n"

const busyScreen = "✻ Connecting to MCP servers… (1m 12s)\n"

func newSeqTest(f *seqHC) *hcHost {
	return &hcHost{ops: f, home: "/home/me", knobs: knobs{
		paneReady: 30 * time.Millisecond, waitSlice: time.Millisecond, statusPoll: time.Millisecond,
	}}
}

func advanceHCStartupClock(h *hcHost, f *fakeHC) {
	clock := time.Unix(0, 0)
	h.clock = func() time.Time { return clock }
	f.onWait = func() { clock = clock.Add(2 * time.Second) }
}

func timeouts(n int) []hc.Wait {
	out := make([]hc.Wait, n)
	for i := range out {
		out[i] = hc.Wait{Ended: false, Reason: "timeout"}
	}
	return out
}

// The issue's run: no status for longer than paneReady, a busy screen, then
// the agent reports its turn and finishes. Done, with the late start noted.
func TestHCLateStartIsNotNeverStarted(t *testing.T) {
	waits := append(timeouts(2),
		hc.Wait{Ended: false, Reason: "timeout", Status: "working", Turn: 1},
		hc.Wait{Ended: true, Reason: "status", Status: "done", Turn: 1})
	f := &seqHC{fakeHC: &fakeHC{waits: waits, delay: 40 * time.Millisecond}, screens: []string{busyScreen}}
	h := newSeqTest(f)
	if err := h.Do(Session{PaneID: "t7"}, hcAutomation(), 5*time.Second); err != nil {
		t.Fatalf("a late start is not a failure: %v", err)
	}
	note := h.Note(Session{PaneID: "t7"})
	if !strings.HasPrefix(note, "started late: first seen working ") || !strings.HasSuffix(note, " after the run began") {
		t.Fatalf("note = %q", note)
	}
	if again := h.Note(Session{PaneID: "t7"}); again != "" {
		t.Fatalf("a note is taken once, got %q again", again)
	}
}

// A trust dialog fails before the timeout, quoting the question so the runner
// can record it before removing the terminal.
func TestHCTrustDialogFailsEarlyWithItsQuestion(t *testing.T) {
	f := &seqHC{fakeHC: &fakeHC{}, screens: []string{trustScreen}}
	h := newSeqTest(f)
	advanceHCStartupClock(h, f.fakeHC)
	start := time.Now()
	err := h.Do(Session{PaneID: "t7"}, hcAutomation(), 10*time.Second)
	if err == nil {
		t.Fatal("a dialog held run must fail")
	}
	for _, want := range []string{"never started working", "blocked on a dialog", "Do you trust the files in this folder?"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q lacks %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "1. Yes") {
		t.Fatalf("an option is not the question: %q", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("the dialog took %s to fail, not early", time.Since(start))
	}
	if len(f.calls) != 0 {
		t.Fatalf("the wait must return before cleanup, got %v", f.calls)
	}
	if f.reads != 6 {
		t.Fatalf("want a ten-second hold at two-second intervals, got %d reads", f.reads)
	}
}

// A dialog word in ordinary output, with no answer to pick, is no dialog:
// the run waits out its timeout and then says it saw no sign of work.
func TestHCPromptWordWithoutOptionsIsNoDialog(t *testing.T) {
	f := &seqHC{fakeHC: &fakeHC{}, screens: []string{"Reading the issue list. Should I continue with the next page?\n"}}
	err := newSeqTest(f).Do(Session{PaneID: "t7"}, hcAutomation(), 200*time.Millisecond)
	if err == nil || strings.Contains(err.Error(), "blocked on a dialog") {
		t.Fatalf("want the timeout's verdict, got %v", err)
	}
	for _, want := range []string{"never started working", "no sign of work in 200ms"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q lacks %q", err, want)
		}
	}
}

// A dialog seen once, gone at the next inspection: the agent got past it.
func TestHCDialogSeenOnceThenWork(t *testing.T) {
	waits := append(timeouts(2),
		hc.Wait{Ended: false, Reason: "timeout", Status: "working", Turn: 1},
		hc.Wait{Ended: true, Reason: "status", Status: "done", Turn: 1})
	f := &seqHC{fakeHC: &fakeHC{waits: waits, delay: 40 * time.Millisecond}, screens: []string{trustScreen, busyScreen}}
	if err := newSeqTest(f).Do(Session{PaneID: "t7"}, hcAutomation(), 5*time.Second); err != nil {
		t.Fatalf("want success, got %v", err)
	}
}

func TestHCStartupLooksLikeDialogThenWorks(t *testing.T) {
	for _, tc := range []struct {
		name, screen, prompt string
		samples              int
	}{
		{"numbered output", "Confirm the checks\n1. First check\n2. Second check", "", 2},
		{"transient dialog", trustScreen, "", 2},
		{"echoed prompt", trustScreen, "Do you trust the files in this folder?", 8},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := hcAutomation()
			if tc.prompt != "" {
				a.Prompt = "Read this:\n" + tc.prompt + "\n1. Yes, proceed\n2. No, exit"
			}
			waits := append(timeouts(tc.samples),
				hc.Wait{Reason: "timeout", Status: "working", Turn: 1},
				hc.Wait{Reason: "status", Status: "done", Turn: 1})
			f := &seqHC{fakeHC: &fakeHC{waits: waits, delay: 2 * time.Millisecond},
				screens: []string{tc.screen}}
			h := newSeqTest(f)
			advanceHCStartupClock(h, f.fakeHC)
			if err := h.Do(Session{PaneID: "t7"}, a, time.Second); err != nil {
				t.Fatalf("healthy startup failed after %d screen reads: %v", f.reads, err)
			}
			if f.reads != tc.samples {
				t.Fatalf("screen reads = %d, want %d", f.reads, tc.samples)
			}
		})
	}
}

func TestHCSilentProgramStopsScreenChecksAfterStartup(t *testing.T) {
	clock := time.Unix(0, 0)
	exitCode := 0
	f := &fakeHC{
		waits:  append(timeouts(3), hc.Wait{Reason: "exit"}),
		screen: trustScreen,
		term:   hc.Terminal{ExitCode: &exitCode},
		onWait: func() { clock = clock.Add(time.Minute) },
	}
	h := newHCTest(f)
	h.clock = func() time.Time { return clock }
	if err := h.Do(Session{PaneID: "t7"}, hcAutomation(), time.Second); err != nil {
		t.Fatalf("silent program failed: %v", err)
	}
	if f.readCalls != 1 {
		t.Fatalf("screen reads = %d, want one before the end of startup", f.readCalls)
	}
}

// The fresh status after the read wins over the screen: working latches as
// work, so the idle that follows at turn 0 is a finished run.
func TestHCGetWorkingOverADialogScreenLatchesWork(t *testing.T) {
	waits := append(timeouts(3), hc.Wait{Ended: true, Reason: "status", Status: "idle", Turn: 0})
	f := &seqHC{fakeHC: &fakeHC{waits: waits, delay: 40 * time.Millisecond}, screens: []string{trustScreen}, gets: []string{"working"}}
	h := newSeqTest(f)
	if err := h.Do(Session{PaneID: "t7"}, hcAutomation(), 5*time.Second); err != nil {
		t.Fatalf("want success, got %v", err)
	}
	if note := h.Note(Session{PaneID: "t7"}); note == "" {
		t.Fatal("work first seen after paneReady is a late start")
	}
}

// An agent whose working shows only in hc get, never in a wait: idle at
// turn 0 after it is done, not idle before the prompt landed.
func TestHCGetOnlyWitnessThenIdle(t *testing.T) {
	waits := append(timeouts(2), hc.Wait{Ended: true, Reason: "status", Status: "idle", Turn: 0})
	f := &seqHC{fakeHC: &fakeHC{waits: waits, delay: 40 * time.Millisecond}, screens: []string{busyScreen}, gets: []string{"working", "idle"}}
	if err := newSeqTest(f).Do(Session{PaneID: "t7"}, hcAutomation(), 5*time.Second); err != nil {
		t.Fatalf("want success, got %v", err)
	}
}

// A fresh completed status supersedes a stale dialog screen.
func TestHCGetDoneStopsTheEarlyVerdict(t *testing.T) {
	f := &seqHC{fakeHC: &fakeHC{}, screens: []string{trustScreen}, gets: []string{"done"}}
	h := newSeqTest(f)
	advanceHCStartupClock(h, f.fakeHC)
	err := h.Do(Session{PaneID: "t7"}, hcAutomation(), 200*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "no sign of work") {
		t.Fatalf("want the timeout's verdict without a settled wait, got %v", err)
	}
}

// A screen that cannot be read is unknown, never a dialog: the run waits out
// its timeout.
func TestHCUnreadableScreenIsNoEarlyFailure(t *testing.T) {
	f := &seqHC{fakeHC: &fakeHC{}, screens: []string{trustScreen}, readErr: errors.New("hc read: timed out")}
	err := newSeqTest(f).Do(Session{PaneID: "t7"}, hcAutomation(), 200*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "no sign of work in 200ms") {
		t.Fatalf("want the timeout's never started, got %v", err)
	}
	if f.reads == 0 {
		t.Fatal("the screen was never inspected")
	}
}

// At the deadline with no witness yet, a fresh status that says working is
// an agent still at work, not one that never started.
func TestHCDeadlineWithGetWorkingIsStillWorking(t *testing.T) {
	f := &seqHC{fakeHC: &fakeHC{}, gets: []string{"working"}}
	h := newSeqTest(f)
	h.knobs.paneReady = time.Hour
	err := h.Do(Session{PaneID: "t7"}, hcAutomation(), 20*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "still working after") {
		t.Fatalf("want still working, got %v", err)
	}
}

// Before paneReady nothing is read: silence early on is the normal start.
func TestHCNoInspectionBeforePaneReady(t *testing.T) {
	waits := []hc.Wait{
		{Ended: false, Reason: "timeout", Status: "working", Turn: 1},
		{Ended: true, Reason: "status", Status: "done", Turn: 1},
	}
	f := &seqHC{fakeHC: &fakeHC{waits: waits}, screens: []string{trustScreen}}
	h := newSeqTest(f)
	h.knobs.paneReady = time.Hour
	if err := h.Do(Session{PaneID: "t7"}, hcAutomation(), time.Second); err != nil {
		t.Fatal(err)
	}
	if f.reads != 0 {
		t.Fatalf("read the screen %d times before paneReady", f.reads)
	}
	if note := h.Note(Session{PaneID: "t7"}); note != "" {
		t.Fatalf("an on-time start has no note, got %q", note)
	}
}

// A note left by an earlier run on the same pane is not the next run's.
func TestHCDoClearsAStaleNote(t *testing.T) {
	waits := append(timeouts(2),
		hc.Wait{Ended: false, Reason: "timeout", Status: "working", Turn: 1},
		hc.Wait{Ended: true, Reason: "status", Status: "done", Turn: 1})
	f := &seqHC{fakeHC: &fakeHC{waits: waits, delay: 40 * time.Millisecond}, screens: []string{busyScreen}}
	h := newSeqTest(f)
	if err := h.Do(Session{PaneID: "t7"}, hcAutomation(), 5*time.Second); err != nil {
		t.Fatal(err)
	}
	f.delay = 0
	f.waits = []hc.Wait{{Ended: true, Reason: "status", Status: "done", Turn: 1}}
	if err := h.Do(Session{PaneID: "t7"}, hcAutomation(), time.Second); err != nil {
		t.Fatal(err)
	}
	if note := h.Note(Session{PaneID: "t7"}); note != "" {
		t.Fatalf("stale note %q survived the next run", note)
	}
}

// A late start that then fails still leaves its note to be taken (and the
// runner drops it): the failure is what the run says.
func TestHCLateStartThenFailureKeepsTheError(t *testing.T) {
	waits := append(timeouts(2),
		hc.Wait{Ended: false, Reason: "timeout", Status: "working", Turn: 1},
		hc.Wait{Ended: true, Reason: "status", Status: "error", Turn: 1})
	f := &seqHC{fakeHC: &fakeHC{waits: waits, delay: 40 * time.Millisecond}, screens: []string{busyScreen}}
	h := newSeqTest(f)
	err := h.Do(Session{PaneID: "t7"}, hcAutomation(), 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "reported an error") {
		t.Fatalf("want the agent's error, got %v", err)
	}
	if note := h.Note(Session{PaneID: "t7"}); note == "" {
		t.Fatal("the late start was not kept")
	}
}

// paneHC answers per pane, safe for concurrent runs: each pane is silent past
// paneReady, then works, then is done.
type paneHC struct {
	fakeHC
	mu    sync.Mutex
	calls map[string]int
}

func (f *paneHC) Wait(address string, _ time.Duration) (hc.Wait, error) {
	f.mu.Lock()
	n := f.calls[address]
	f.calls[address] = n + 1
	f.mu.Unlock()
	switch n {
	case 0:
		time.Sleep(40 * time.Millisecond)
		return hc.Wait{Reason: "timeout"}, nil
	case 1:
		return hc.Wait{Reason: "timeout", Status: "working", Turn: 1}, nil
	default:
		return hc.Wait{Ended: true, Reason: "status", Status: "done", Turn: 1}, nil
	}
}

func (f *paneHC) Get(string) (hc.Terminal, error) { return hc.Terminal{State: "live"}, nil }
func (f *paneHC) Read(string) (string, error)     { return busyScreen, nil }

// Runs of different automations finish together: each keeps its own note.
func TestHCNotesOfConcurrentRunsStayApart(t *testing.T) {
	f := &paneHC{calls: map[string]int{}}
	h := &hcHost{ops: f, home: "/home/me", knobs: knobs{
		paneReady: 30 * time.Millisecond, waitSlice: time.Millisecond, statusPoll: time.Millisecond,
	}}
	panes := []string{"t1", "t2", "t3", "t4"}
	var wg sync.WaitGroup
	errs := make([]error, len(panes))
	notes := make([]string, len(panes))
	for i, p := range panes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = h.Do(Session{PaneID: p}, hcAutomation(), 5*time.Second)
			notes[i] = h.Note(Session{PaneID: p})
		}()
	}
	wg.Wait()
	for i, p := range panes {
		if errs[i] != nil {
			t.Fatalf("%s: %v", p, errs[i])
		}
		if !strings.HasPrefix(notes[i], "started late: ") {
			t.Fatalf("%s: note %q", p, notes[i])
		}
	}
	if left := fmt.Sprint(h.notes); left != "map[]" {
		t.Fatalf("notes left behind: %s", left)
	}
}

func TestHCReportedStartupTrustDialogFailsBeforeGrace(t *testing.T) {
	blocked := hc.Wait{Ended: true, Reason: "status", Status: "blocked"}
	f := &seqHC{
		fakeHC:  &fakeHC{waits: []hc.Wait{blocked, blocked, blocked, blocked, blocked, blocked}},
		screens: []string{trustScreen}, gets: []string{"blocked"},
	}
	h := newSeqTest(f)
	advanceHCStartupClock(h, f.fakeHC)
	err := h.Do(Session{PaneID: "t7"}, hcAutomation(), time.Second)
	if err == nil || !strings.Contains(err.Error(), "Do you trust the files in this folder?") {
		t.Fatalf("want the trust question before the grace or timeout, got %v", err)
	}
}
