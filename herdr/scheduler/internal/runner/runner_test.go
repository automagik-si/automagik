package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/command"
	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/herdr"
	"github.com/DnzzL/herdr-automations/internal/history"
	"github.com/DnzzL/herdr-automations/internal/host"
	"github.com/DnzzL/herdr-automations/internal/notify"
)

// fakeSink is notify's test seam (internal/notify/notify_test.go), reused here
// to assert the runner drives it rather than filtering statuses itself.
type fakeSink struct {
	titles []string
	bodies []string
}

func (f *fakeSink) NotificationShow(title, body string, sound herdr.Sound) error {
	f.titles = append(f.titles, title)
	f.bodies = append(f.bodies, body)
	return nil
}

// fakeHost stands in for the machine. A nil field means the step works.
type fakeHost struct {
	provision func(config.Automation) (host.Session, error)
	do        func(host.Session, config.Automation, time.Duration) error
	close     func(host.Session) error

	mu       sync.Mutex
	timeouts []time.Duration
	closed   []string
}

func (f *fakeHost) Provision(a config.Automation) (host.Session, error) {
	if f.provision == nil {
		return host.Session{WorkspaceID: "w1", PaneID: "w1:p1"}, nil
	}
	return f.provision(a)
}

func (f *fakeHost) Do(s host.Session, a config.Automation, timeout time.Duration) error {
	f.mu.Lock()
	f.timeouts = append(f.timeouts, timeout)
	f.mu.Unlock()
	if f.do == nil {
		return nil
	}
	return f.do(s, a, timeout)
}

func (f *fakeHost) Close(s host.Session, a config.Automation) error {
	f.mu.Lock()
	f.closed = append(f.closed, s.WorkspaceID)
	f.mu.Unlock()
	if f.close == nil {
		return nil
	}
	return f.close(s)
}

// runs is the history as the board and `history` would read it back.
func runs(t *testing.T) []history.Record {
	t.Helper()
	out, err := history.Runs("", 0)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// statuses is every status written for an automation, oldest first. It reads
// the log raw: history.Runs collapses each run to its latest state, which is
// what the board wants and the opposite of what this asserts.
func statuses(t *testing.T, name string) []history.Status {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(config.StateDir(), "history.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var out []history.Status
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var r history.Record
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("unreadable history line %q: %v", line, err)
		}
		if r.Automation == name {
			out = append(out, r.Status)
		}
	}
	return out
}

func automation() config.Automation {
	return config.Automation{
		Name: "triage", Cron: "@daily", Repo: "/repo", Agent: "claude",
		Workspace: config.WorkspaceWorktree, Prompt: "go", TimeoutMinutes: 45,
	}
}

func TestRunRecordsTheWholeTrailOfASuccessfulRun(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &fakeHost{}

	if err := New(h).Run(automation(), "cron"); err != nil {
		t.Fatal(err)
	}

	// One run ID, collapsing to done, with the workspace it happened in
	// attached — that last part is what the board's `enter` jumps to.
	got := runs(t)
	if len(got) != 1 {
		t.Fatalf("want a single run, got %d: %+v", len(got), got)
	}
	if got[0].Status != history.StatusDone {
		t.Errorf("status = %q, want done", got[0].Status)
	}
	if got[0].WorkspaceID != "w1" || got[0].PaneID != "w1:p1" {
		t.Errorf("run recorded without a workspace to jump to: %+v", got[0])
	}
	if got[0].Trigger != "cron" {
		t.Errorf("trigger = %q", got[0].Trigger)
	}
	if len(h.timeouts) != 1 || h.timeouts[0] != 45*time.Minute {
		t.Errorf("timeouts = %v, want the automation's 45m", h.timeouts)
	}
}

func TestRunPassesThroughScheduledAndRunning(t *testing.T) {
	// The board reads the latest state per run, so a run that is still working
	// has to have said so. Losing the running record makes an in-flight run
	// look like it never started.
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())

	if err := New(&fakeHost{}).Run(automation(), "manual"); err != nil {
		t.Fatal(err)
	}

	want := []history.Status{history.StatusScheduled, history.StatusRunning, history.StatusDone}
	got := statuses(t, "triage")
	if len(got) != len(want) {
		t.Fatalf("trail = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("trail = %v, want %v", got, want)
		}
	}
}

func TestRunRecordsAFailureToProvision(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &fakeHost{provision: func(config.Automation) (host.Session, error) {
		return host.Session{}, errors.New("worktree create: fatal: not a git repository")
	}}

	err := New(h).Run(automation(), "cron")
	if err == nil {
		t.Fatal("want the provisioning error returned")
	}
	last := runs(t)[0]
	if last.Status != history.StatusFailed {
		t.Errorf("status = %q, want failed", last.Status)
	}
	if last.Error == "" {
		t.Error("a failed run has to say why")
	}
}

// A busy bot target told to skip is a dropped occurrence, not a failure: the
// Provision error keeps the pane it already resolved and the target it names,
// so the row says where the skipped run would have gone (#498).
func TestRunRecordsABusySkippedTargetAsSkipped(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &fakeHost{provision: func(config.Automation) (host.Session, error) {
		return host.Session{PaneID: "t7", Target: "bot:b-6jrz4bmxml", TargetName: "Housekeeper"},
			fmt.Errorf("housekeeping: %w: Housekeeper was working", host.ErrTargetBusy)
	}}

	if err := New(h).Run(automation(), "cron"); err == nil {
		t.Fatal("want the busy skip returned")
	}
	want := []history.Status{history.StatusScheduled, history.StatusSkipped}
	got := statuses(t, "triage")
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("trail = %v, want %v", got, want)
	}
	last := runs(t)[0]
	if last.Error == "" {
		t.Error("a skipped run has to say why")
	}
	if last.PaneID != "t7" || last.Target != "bot:b-6jrz4bmxml" {
		t.Errorf("the skipped run lost its pane or target: %+v", last)
	}
}

func TestRunRecordsAClosedWorkspaceAsCancelledNotFailed(t *testing.T) {
	// Closing a run's workspace is how you call one off. Nothing broke,
	// somebody decided — and the board dims it rather than colouring it red.
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &fakeHost{do: func(host.Session, config.Automation, time.Duration) error {
		return fmt.Errorf("waiting for the agent: %w", host.ErrCancelled)
	}}

	if err := New(h).Run(automation(), "cron"); err == nil {
		t.Fatal("want the cancellation returned")
	}
	if got := runs(t)[0].Status; got != history.StatusCancelled {
		t.Errorf("status = %q, want cancelled", got)
	}
}

func TestRunSkipsAnAutomationThatIsStillWorking(t *testing.T) {
	// The 9:00 run is still going at 10:00: the occurrence is dropped, not
	// queued, and the drop is recorded so it isn't a silent absence.
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	release := make(chan struct{})
	entered := make(chan struct{})
	h := &fakeHost{do: func(host.Session, config.Automation, time.Duration) error {
		close(entered)
		<-release
		return nil
	}}
	r := New(h)

	// Waited on before returning: a run still recording after t.Setenv is
	// undone writes into the real history.
	done := make(chan struct{})
	go func() { defer close(done); _ = r.Run(automation(), "cron") }()
	<-entered

	if !r.Busy() {
		t.Error("Busy() = false with a run in flight")
	}
	err := r.Run(automation(), "cron")
	if err == nil {
		t.Fatal("want the second run refused")
	}
	close(release)
	<-done

	var skipped bool
	for _, rec := range runs(t) {
		if rec.Status == history.StatusSkipped {
			skipped = true
		}
	}
	if !skipped {
		t.Error("a skipped occurrence has to leave a record")
	}
}

func TestRunLetsADifferentAutomationThrough(t *testing.T) {
	// The in-flight set is per automation: a nightly job holding a slot must
	// not block the morning triage.
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	release := make(chan struct{})
	entered := make(chan struct{})
	h := &fakeHost{do: func(_ host.Session, a config.Automation, _ time.Duration) error {
		if a.Name == "triage" {
			close(entered)
			<-release
		}
		return nil
	}}
	r := New(h)

	// Waited on before returning: a run still recording after t.Setenv is
	// undone writes into the real history.
	done := make(chan struct{})
	go func() { defer close(done); _ = r.Run(automation(), "cron") }()
	<-entered

	other := automation()
	other.Name = "nightly"
	if err := r.Run(other, "cron"); err != nil {
		t.Fatalf("a different automation was blocked: %v", err)
	}
	close(release)
	<-done
}

func TestBusyIsFalseOnceARunFinishes(t *testing.T) {
	// The daemon re-execs itself on a plugin upgrade only when nothing is in
	// flight. A slot that leaks means it never upgrades.
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	r := New(&fakeHost{do: func(host.Session, config.Automation, time.Duration) error {
		return errors.New("boom")
	}})

	_ = r.Run(automation(), "cron")
	if r.Busy() {
		t.Error("Busy() = true after the run failed: the slot leaked")
	}
}

func TestRunToastsAFailureAndNothingBefore(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &fakeHost{do: func(host.Session, config.Automation, time.Duration) error {
		return errors.New("boom")
	}}
	sink := &fakeSink{}
	r := NewWith(h, notify.With(sink))

	_ = r.Run(automation(), "cron")

	if len(sink.titles) != 1 {
		t.Fatalf("toasts = %v, want exactly one despite scheduled/running also being recorded", sink.titles)
	}
	if sink.titles[0] != "triage failed" {
		t.Errorf("title = %q", sink.titles[0])
	}
}

// A blocked fail-fast is a failure, so it goes out through the same notifier
// every other failure does, carrying the dialog line.
func TestRunToastsABlockedFailureWithItsDialogLine(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &fakeHost{do: func(host.Session, config.Automation, time.Duration) error {
		return errors.New("blocked on a dialog: Do you want to proceed?")
	}}
	sink := &fakeSink{}
	r := NewWith(h, notify.With(sink))

	_ = r.Run(automation(), "cron")

	if len(sink.titles) != 1 || sink.titles[0] != "triage failed" {
		t.Fatalf("toasts = %v, want one failed toast", sink.titles)
	}
	if len(sink.bodies) != 1 || sink.bodies[0] != "blocked on a dialog: Do you want to proceed?" {
		t.Fatalf("body = %q, want the dialog line", sink.bodies)
	}
	if got := runs(t)[0]; got.Status != history.StatusFailed || !strings.Contains(got.Error, "blocked on a dialog:") {
		t.Fatalf("history = %+v, want a failed run carrying the dialog line", got)
	}
}

func TestRunNotifiesTheNotifierOfEveryStatusItRecords(t *testing.T) {
	// Deciding what deserves a toast is notify's job; a runner that pre-filters
	// puts the policy in two places.
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	sink := &fakeSink{}
	r := NewWith(&fakeHost{}, notify.With(sink))

	if err := r.Run(automation(), "cron"); err != nil {
		t.Fatal(err)
	}
	if len(sink.titles) != 0 {
		t.Fatalf("toasts = %v, want none for a run that succeeded", sink.titles)
	}
}

func TestRunWithoutANotifierStillRuns(t *testing.T) {
	// The board and the CLI build a Runner with New/Default, which carries no
	// notifier — a nil one must not panic.
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	if err := New(&fakeHost{}).Run(automation(), "cron"); err != nil {
		t.Fatal(err)
	}
}

func TestStatusForSeparatesACancellationFromAFailure(t *testing.T) {
	cancelled := fmt.Errorf("waiting for the agent: %w", host.ErrCancelled)
	if got := statusFor(cancelled); got != history.StatusCancelled {
		t.Errorf("a closed workspace recorded as %q, want cancelled", got)
	}
	if got := statusFor(errors.New("start claude agent: boom")); got != history.StatusFailed {
		t.Errorf("a real failure recorded as %q, want failed", got)
	}
	// A bot that was busy when its automation was told to skip is a dropped
	// occurrence, not a failure that toasts at 3am (#498).
	busy := fmt.Errorf("housekeeping: %w: Housekeeper was working", host.ErrTargetBusy)
	if got := statusFor(busy); got != history.StatusSkipped {
		t.Errorf("a busy bot target recorded as %q, want skipped", got)
	}
}

func TestHistoryRemembersWhichSessionARunLivesIn(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &fakeHost{provision: func(config.Automation) (host.Session, error) {
		return host.Session{WorkspaceID: "w1", PaneID: "w1:p1", HerdrSession: "automations"}, nil
	}}
	if err := New(h).Run(config.Automation{Name: "triage"}, history.TriggerManual); err != nil {
		t.Fatal(err)
	}
	if got := runs(t)[0].Session; got != "automations" {
		t.Fatalf("session = %q, want automations: the board cannot find w1 without it", got)
	}
}

// ── close_workspace (ADR 0012) ──────────────────────────────────────

func TestRunClosesADoneRunsWorkspaceOnlyAfterRecordingIt(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	a := automation()
	a.CloseWorkspace = config.CloseOnSuccess
	var atClose []history.Status
	h := &fakeHost{close: func(host.Session) error {
		atClose = statuses(t, a.Name)
		return nil
	}}
	if err := New(h).Run(a, "cron"); err != nil {
		t.Fatal(err)
	}
	if len(h.closed) != 1 || h.closed[0] != "w1" {
		t.Fatalf("closed %q, want w1 once", h.closed)
	}
	// Closing is also how a person cancels a run: done must be on record first.
	if len(atClose) == 0 || atClose[len(atClose)-1] != history.StatusDone {
		t.Fatalf("closed before done was recorded: %v", atClose)
	}
}

func TestRunLeavesTheWorkspaceOfARunThatDidNotSucceed(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	a := automation()
	a.CloseWorkspace = config.CloseOnSuccess
	h := &fakeHost{do: func(host.Session, config.Automation, time.Duration) error { return errors.New("boom") }}
	_ = New(h).Run(a, "cron")
	if len(h.closed) != 0 {
		t.Fatalf("closed a failed run's workspace: %q", h.closed)
	}
}

func TestRunLeavesTheWorkspaceByDefault(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	h := &fakeHost{}
	if err := New(h).Run(automation(), "cron"); err != nil {
		t.Fatal(err)
	}
	if len(h.closed) != 0 {
		t.Fatalf("closed without close_workspace: %q", h.closed)
	}
}

// Existing mode defaults to never too: a successful run leaves its tab open
// like any other unread run.
func TestRunLeavesAnExistingRunsTabByDefault(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	a := automation()
	a.Workspace, a.WorkspaceID = config.WorkspaceExisting, "w7"
	h := &fakeHost{}
	if err := New(h).Run(a, "cron"); err != nil {
		t.Fatal(err)
	}
	if len(h.closed) != 0 {
		t.Fatalf("closed without close_workspace: %q", h.closed)
	}
}

func TestRunStaysDoneWhenTheCloseFails(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	a := automation()
	a.CloseWorkspace = config.CloseOnSuccess
	h := &fakeHost{close: func(host.Session) error { return errors.New("herdr is down") }}
	if err := New(h).Run(a, "cron"); err != nil {
		t.Fatalf("a failed close failed the run: %v", err)
	}
	if got := runs(t); got[0].Status != history.StatusDone {
		t.Fatalf("status %q, want done", got[0].Status)
	}
}

// ---- the command kind (ADR 0013) ----

// fakeBots is the report's test seam: no herdr-core is asked.
type fakeBots struct {
	err  error
	sent [][2]string
}

func (f *fakeBots) Send(bot, text string) (string, error) {
	f.sent = append(f.sent, [2]string{bot, text})
	if f.err != nil {
		return "", f.err
	}
	return "t7", nil
}

// refusingHost fails the test if a command run touches the host: there is no
// workspace to provision and no pane to work in.
type refusingHost struct{ t *testing.T }

func (h refusingHost) Provision(config.Automation) (host.Session, error) {
	h.t.Error("a command run provisioned a workspace")
	return host.Session{}, nil
}
func (h refusingHost) Do(host.Session, config.Automation, time.Duration) error {
	h.t.Error("a command run was handed to the host")
	return nil
}
func (h refusingHost) Close(host.Session, config.Automation) error {
	h.t.Error("a command run closed a workspace")
	return nil
}

func commandAutomation(script string) config.Automation {
	return config.Automation{
		Name: "check", Cron: "@daily", TimeoutMinutes: 1,
		Command: &config.Command{Argv: []string{"/bin/sh", "-c", script}},
	}
}

func TestACommandThatExitsZeroIsDoneWithItsLastLine(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	sink := &fakeSink{}
	r := NewWith(refusingHost{t}, notify.With(sink))

	if err := r.Run(commandAutomation(`echo working; echo "12 checked, 0 broken"`), "cron"); err != nil {
		t.Fatal(err)
	}
	got := runs(t)
	if len(got) != 1 {
		t.Fatalf("want one run, got %+v", got)
	}
	run := got[0]
	if run.Status != history.StatusDone || run.Result != "12 checked, 0 broken" || run.Error != "" {
		t.Fatalf("run = %+v", run)
	}
	if run.ExitCode == nil || *run.ExitCode != 0 {
		t.Fatalf("exit code = %v, want 0", run.ExitCode)
	}
	if run.WorkspaceID != "" || run.PaneID != "" || run.Notified != "" {
		t.Fatalf("a command run has no workspace, pane or report: %+v", run)
	}
	want := []history.Status{history.StatusScheduled, history.StatusRunning, history.StatusDone}
	if trail := statuses(t, "check"); fmt.Sprint(trail) != fmt.Sprint(want) {
		t.Fatalf("trail = %v, want %v", trail, want)
	}
	if len(sink.titles) != 0 {
		t.Fatalf("a done run raised a toast: %v", sink.titles)
	}
}

func TestACommandThatExitsNonZeroIsFailedWithItsCodeAndStderr(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	sink := &fakeSink{}
	r := NewWith(refusingHost{t}, notify.With(sink))

	// The last line of stdout reads like success; the exit status decides.
	err := r.Run(commandAutomation(`echo "all good"; echo "cannot reach the registry" >&2; exit 7`), "manual")
	if err == nil {
		t.Fatal("want the failure returned")
	}
	run := runs(t)[0]
	if run.Status != history.StatusFailed || run.Error != "exited 7" {
		t.Fatalf("run = %+v", run)
	}
	if run.ExitCode == nil || *run.ExitCode != 7 {
		t.Fatalf("exit code = %v, want 7", run.ExitCode)
	}
	if run.Stderr != "cannot reach the registry" || run.Result != "exited 7: cannot reach the registry" {
		t.Fatalf("stderr %q, result %q", run.Stderr, run.Result)
	}
	if len(sink.titles) != 1 || sink.titles[0] != "check failed" || sink.bodies[0] != "exited 7: cannot reach the registry" {
		t.Fatalf("toast = %v / %v", sink.titles, sink.bodies)
	}
}

func TestACommandPastItsTimeoutIsFailed(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	r := New(refusingHost{t})
	var asked time.Duration
	r.exec = func(_ config.Command, timeout time.Duration) command.Result {
		asked = timeout
		return command.Result{TimedOut: true, Problem: "timed out after 1m0s", Stderr: "still fetching"}
	}
	if err := r.Run(commandAutomation("sleep 600"), "cron"); err == nil {
		t.Fatal("want the timeout returned")
	}
	run := runs(t)[0]
	if asked != time.Minute {
		t.Fatalf("the command was given %s, want the automation's 1m", asked)
	}
	if run.Status != history.StatusFailed || run.ExitCode != nil || run.Error != "timed out after 1m0s" {
		t.Fatalf("run = %+v", run)
	}
}

func TestACommandsResultGoesToItsBot(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	bots := &fakeBots{}
	r := New(refusingHost{t})
	r.bots = bots

	done := commandAutomation(`echo "3 new, 0 broken"`)
	done.Notify = "b-captain"
	if err := r.Run(done, "cron"); err != nil {
		t.Fatal(err)
	}
	failed := commandAutomation(`echo "no route to host" >&2; exit 2`)
	failed.Name, failed.Notify = "probe", "b-captain"
	if err := r.Run(failed, "cron"); err == nil {
		t.Fatal("want the failure returned")
	}
	quiet := commandAutomation(`true`)
	quiet.Name, quiet.Notify = "quiet", "b-captain"
	if err := r.Run(quiet, "cron"); err != nil {
		t.Fatal(err)
	}

	want := [][2]string{
		{"b-captain", "[automation check] done: 3 new, 0 broken"},
		{"b-captain", "[automation probe] failed: exited 2: no route to host"},
		{"b-captain", "[automation quiet] done"},
	}
	if fmt.Sprint(bots.sent) != fmt.Sprint(want) {
		t.Fatalf("sent %v\nwant %v", bots.sent, want)
	}
	for _, run := range runs(t) {
		if run.Notified != "sent to t7" {
			t.Fatalf("%s: notified = %q", run.Automation, run.Notified)
		}
	}
	// The report is a second copy of the final record, never a new status.
	if trail := statuses(t, "probe"); fmt.Sprint(trail) != "[scheduled running failed failed]" {
		t.Fatalf("trail = %v", trail)
	}
}

// The refusal goes through the real hc.Client.Send: a fake hc finds the bot's
// terminal, then refuses the send with what hc wrote, and exits 9. A JSON
// envelope is told in its message, on one line, in the history, and kept whole
// in the log; any other refusal reads as it always did.
func TestAReportThatCannotBeDeliveredLeavesTheStatusAlone(t *testing.T) {
	// The envelope is fake-hc.mjs's refusal of a blocked terminal.
	const envelope = `{"error":{"kind":"blocked","message":"t9 is blocked"}}`
	for _, c := range []struct {
		name, stderr, stdout, notified, logged string
	}{
		{name: "an hc envelope", stderr: envelope,
			notified: "not delivered: hc send: t9 is blocked",
			logged:   "hc send: " + envelope + " (exit status 9)"},
		{name: "an envelope with a hint over lines",
			stderr:   "{\"error\":{\"kind\":\"blocked\",\"message\":\"t9 is\\n  blocked\",\"hint\":\"close the dialog\"}}\n",
			notified: "not delivered: hc send: t9 is blocked",
			logged:   `"hint":"close the dialog"}} (exit status 9)`},
		{name: "an envelope on stdout", stdout: envelope,
			notified: "not delivered: hc send: t9 is blocked",
			logged:   "hc send: " + envelope + " (exit status 9)"},
		{name: "plain text", stderr: "the program is blocked\n",
			notified: "not delivered: hc send: the program is blocked (exit status 9)"},
		{name: "nothing said",
			notified: "not delivered: hc send:  (exit status 9)"},
		{name: "malformed json", stderr: `{"error":{"kind":"blocked"`,
			notified: `not delivered: hc send: {"error":{"kind":"blocked" (exit status 9)`},
		{name: "an envelope with a blank message", stderr: `{"error":{"kind":"blocked","message":"  "}}`,
			notified: `not delivered: hc send: {"error":{"kind":"blocked","message":"  "}} (exit status 9)`},
		{name: "other json", stderr: `{"error":"blocked"}`,
			notified: `not delivered: hc send: {"error":"blocked"} (exit status 9)`},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
			t.Setenv("HC_BIN", fakeRefusingHC(t, c.stderr, c.stdout))
			var logs strings.Builder
			log.SetOutput(&logs)
			t.Cleanup(func() { log.SetOutput(os.Stderr) })

			r := New(refusingHost{t})
			r.bots = notify.NewBots()
			a := commandAutomation(`echo fine`)
			a.Notify = "b-captain"
			if err := r.Run(a, "cron"); err != nil {
				t.Fatalf("an undelivered report failed the run: %v", err)
			}

			all := runs(t)
			if len(all) != 1 {
				t.Fatalf("history holds %d runs, want 1: %+v", len(all), all)
			}
			run := all[0]
			if run.Status != history.StatusDone || run.Result != "fine" || run.Error != "" {
				t.Fatalf("run = %+v", run)
			}
			if run.Notified != c.notified {
				t.Fatalf("notified = %q\nwant        %q", run.Notified, c.notified)
			}
			if strings.ContainsAny(run.Notified, "\r\n") {
				t.Fatalf("notified spans lines: %q", run.Notified)
			}
			if c.logged != "" && strings.Contains(run.Notified, "{") {
				t.Fatalf("notified kept the envelope: %q", run.Notified)
			}
			if n := strings.Count(logs.String(), "did not reach b-captain"); n != 1 {
				t.Fatalf("logged the refusal %d times, want once:\n%s", n, logs.String())
			}
			want := c.logged
			if want == "" {
				want = strings.TrimPrefix(c.notified, "not delivered: ")
			}
			if n := strings.Count(logs.String(), want); n != 1 {
				t.Fatalf("the log holds %q %d times, want once:\n%s", want, n, logs.String())
			}
			if c.logged != "" && strings.Count(logs.String(), "exit status 9") != 1 {
				t.Fatalf("the log lost the exit status once:\n%s", logs.String())
			}
		})
	}
}

// fakeRefusingHC writes a scratch hc that finds bot b-captain at t9 and
// refuses every send with the given output and exit status 9.
func fakeRefusingHC(t *testing.T, stderr, stdout string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{"stderr": stderr, "stdout": stdout} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// This test exercises hc's refusal after the synthetic seat passed the pack's read-only check.
	guard := filepath.Join(dir, "am")
	if err := os.WriteFile(guard, []byte(`#!/bin/sh
[ "$1 $2 $3" = "delivery-status t9 --json" ] || exit 64
printf '%s' '{"terminal":"t9","held":false}'
`), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AM_BIN", guard)
	bin := filepath.Join(dir, "hc")
	script := `#!/bin/sh
dir=$(dirname "$0")
case $1 in
ls) [ "$2 $3 $4" = "--json --label bot=b-captain" ] || exit 64
    printf '{"terminals":[{"address":"t9"}]}\n' ;;
send) [ "$2 $3 $4" = "--json -- t9" ] || exit 64
    cat "$dir/stderr" >&2; cat "$dir/stdout"; exit 9 ;;
*) exit 64 ;;
esac
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return bin
}

// A seen mark written while the report is on its way must survive the
// report's copy of the record.
func TestASeenMarkSurvivesTheReportsRecord(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	r := New(refusingHost{t})
	a := commandAutomation(`echo fine`)
	a.Notify = "b-captain"
	r.bots = seenThenSend{t}
	if err := r.Run(a, "cron"); err != nil {
		t.Fatal(err)
	}
	if run := runs(t)[0]; !run.Seen || run.Notified != "sent to t9" || run.Status != history.StatusDone {
		t.Fatalf("run = %+v", run)
	}
}

type seenThenSend struct{ t *testing.T }

func (s seenThenSend) Send(string, string) (string, error) {
	if err := history.MarkAllSeen(); err != nil {
		s.t.Fatal(err)
	}
	return "t9", nil
}

func TestACommandStillSkipsAnOverlappingRun(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	r := New(refusingHost{t})
	started, release := make(chan struct{}), make(chan struct{})
	r.exec = func(config.Command, time.Duration) command.Result {
		close(started)
		<-release
		zero := 0
		return command.Result{ExitCode: &zero}
	}
	a := commandAutomation("sleep 1")
	finished := make(chan error, 1)
	go func() { finished <- r.Run(a, "cron") }()
	<-started
	if err := r.Run(a, "cron"); err == nil || !strings.Contains(err.Error(), "skipped") {
		t.Fatalf("the second run was not skipped: %v", err)
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}

// A command the stopping scheduler ended is failed and says why; no report is
// sent from a process on its way out, and the run no longer counts as running.
func TestACommandEndedByAStoppingSchedulerIsFailedAndNotReported(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	bots := &fakeBots{}
	r := New(refusingHost{t})
	r.bots = bots
	during := -1
	r.exec = func(config.Command, time.Duration) command.Result {
		during = r.CommandsRunning()
		return command.Result{Stopped: true, Problem: "stopped: the scheduler was stopping"}
	}
	a := commandAutomation("sleep 600")
	a.Notify = "b-captain"
	if err := r.Run(a, "cron"); err == nil {
		t.Fatal("want the failure returned")
	}
	run := runs(t)[0]
	if run.Status != history.StatusFailed || run.Error != "stopped: the scheduler was stopping" || run.Notified != "" {
		t.Fatalf("run = %+v", run)
	}
	if len(bots.sent) != 0 {
		t.Fatalf("a report was sent while stopping: %v", bots.sent)
	}
	if during != 1 || r.CommandsRunning() != 0 {
		t.Fatalf("commands running: %d during, %d after; want 1 and 0", during, r.CommandsRunning())
	}
}

type terminalHost struct {
	*fakeHost
	previous func(config.Automation, []host.Session) ([]host.Session, error)
	remove   func(host.Session, config.Automation) error
}

func (f terminalHost) Previous(a config.Automation, known []host.Session) ([]host.Session, error) {
	if f.previous == nil {
		return nil, nil
	}
	return f.previous(a, known)
}

func (f terminalHost) Screen(host.Session) (string, error) {
	return "final line on the screen", nil
}

func (f terminalHost) Remove(s host.Session, a config.Automation) error {
	return f.remove(s, a)
}

func TestRunSavesFailureScreenBeforeRemovingTerminal(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	var removed bool
	h := terminalHost{fakeHost: &fakeHost{
		do: func(host.Session, config.Automation, time.Duration) error { return errors.New("timed out") },
	}, remove: func(s host.Session, _ config.Automation) error {
		removed = true
		rec := runs(t)[0]
		if rec.PaneID != s.PaneID || rec.Status != history.StatusFailed || rec.Error != "timed out" {
			t.Fatalf("history at removal = %+v", rec)
		}
		raw, err := os.ReadFile(filepath.Join(config.StateDir(), "history.jsonl"))
		if err != nil || !strings.Contains(string(raw), "final line on the screen") {
			t.Fatalf("screen is missing at removal: %v", err)
		}
		return nil
	}}
	if err := New(h).Run(automation(), history.TriggerCron); err == nil || !removed {
		t.Fatalf("run error = %v, removed = %t", err, removed)
	}
}

func TestRunReapsPreviousTerminalBeforeProvision(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	a := automation()
	if err := history.Append(history.Record{
		RunID: "earlier", Automation: a.Name, PaneID: "t8", WorkspaceID: "sp8",
		Status: history.StatusFailed, Error: "agent did not start",
	}); err != nil {
		t.Fatal(err)
	}
	var removed bool
	h := terminalHost{fakeHost: &fakeHost{
		provision: func(config.Automation) (host.Session, error) {
			if !removed {
				t.Fatal("provisioned while the earlier terminal was still live")
			}
			return host.Session{PaneID: "t9"}, nil
		},
	}, previous: func(_ config.Automation, known []host.Session) ([]host.Session, error) {
		if len(known) != 1 || known[0].PaneID != "t8" {
			t.Fatalf("previous sessions = %+v", known)
		}
		return known, nil
	}, remove: func(s host.Session, _ config.Automation) error {
		removed = true
		for _, rec := range runs(t) {
			if rec.RunID == "earlier" && rec.Error == "agent did not start" && rec.PaneID == s.PaneID {
				return nil
			}
		}
		t.Fatal("the earlier run lost its failure record")
		return nil
	}}
	if err := New(h).Run(a, history.TriggerCron); err != nil {
		t.Fatal(err)
	}
}

func TestRunBlocksNewProvisionWhenPreviousRemovalFails(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	a := automation()
	h := terminalHost{fakeHost: &fakeHost{
		provision: func(config.Automation) (host.Session, error) {
			t.Fatal("provisioned when the earlier terminal could not be removed")
			return host.Session{}, nil
		},
	}, previous: func(config.Automation, []host.Session) ([]host.Session, error) {
		return []host.Session{{PaneID: "t8", WorkspaceID: "sp8"}}, nil
	}, remove: func(host.Session, config.Automation) error { return errors.New("core unavailable") }}
	if err := New(h).Run(a, history.TriggerCron); err == nil || !strings.Contains(err.Error(), "core unavailable") {
		t.Fatalf("run error = %v", err)
	}
	for _, rec := range runs(t) {
		if rec.PaneID == "t8" && rec.CleanupPending && strings.Contains(rec.Cleanup, "core unavailable") {
			return
		}
	}
	t.Fatal("the earlier run has no recorded cleanup failure")
}

func TestRunnerInstancesDropOverlappingOccurrences(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	a := automation()
	working, release := make(chan struct{}), make(chan struct{})
	h := terminalHost{fakeHost: &fakeHost{
		do: func(host.Session, config.Automation, time.Duration) error {
			close(working)
			<-release
			return nil
		},
	}}
	first := make(chan error, 1)
	go func() { first <- New(h).Run(a, history.TriggerCron) }()
	<-working
	second := New(terminalHost{fakeHost: &fakeHost{
		provision: func(config.Automation) (host.Session, error) {
			t.Error("a second runner provisioned during an active run")
			return host.Session{}, errors.New("duplicate provision")
		},
	}})
	err := second.Run(a, history.TriggerManual)
	close(release)
	if firstErr := <-first; firstErr != nil {
		t.Fatal(firstErr)
	}
	if !errors.Is(err, errRunLocked) || runs(t)[0].Status != history.StatusSkipped {
		t.Fatalf("second run error = %v, history = %+v", err, runs(t))
	}
}
