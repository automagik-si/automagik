// Package runner executes one automation end to end and records every state
// transition in the history log. What it means to provision a workspace or get
// an agent to do something lives behind the host seam; what is left here is the
// lifecycle: skip an overlapping run, record what happened, decide whether a
// failure was a failure at all.
//
// A command is the one kind of work that does not go through the host: the
// scheduler runs it itself, and there is no workspace to provision (ADR 0013).
package runner

import (
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/DnzzL/herdr-automations/internal/command"
	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/history"
	"github.com/DnzzL/herdr-automations/internal/host"
	"github.com/DnzzL/herdr-automations/internal/notify"
)

// Runner runs automations on a host. It holds the in-flight set, which used to
// be a package global that the daemon reached into to decide whether it could
// re-exec itself.
type Runner struct {
	host     host.Host
	notifier *notify.Notifier
	inFlight sync.Map
	// commands counts the command runs whose status is not recorded yet.
	commands atomic.Int32
	// exec runs a command, and bots reports its result. Fields so the tests
	// can stand in for a program and for herdr-core; nil means the real ones.
	exec func(config.Command, time.Duration) command.Result
	bots notify.Messenger
}

// New returns a Runner that works through h. Its notifier is nil, so it stays
// silent — the board and the CLI's `run` build one this way on purpose (see
// runner.record).
func New(h host.Host) *Runner { return &Runner{host: h} }

// NewWith returns a Runner that also toasts through n.
func NewWith(h host.Host, n *notify.Notifier) *Runner { return &Runner{host: h, notifier: n} }

// Default returns a Runner driving the backend automations.yaml names.
func Default() *Runner {
	b := config.BackendHerdr
	if cfg, err := config.Load(); err == nil {
		b = cfg.Backend
	}
	return New(host.For(b))
}

// Busy reports whether any automation is mid-run.
func (r *Runner) Busy() bool {
	busy := false
	r.inFlight.Range(func(_, _ any) bool { busy = true; return false })
	return busy
}

// CommandsRunning is how many command runs have not recorded how they ended.
// The daemon waits for it to reach zero after command.Shutdown, so a stopped
// scheduler leaves no command run listed as running.
func (r *Runner) CommandsRunning() int { return int(r.commands.Load()) }

// Run executes the automation synchronously.
//
// Overlapping runs of the same automation are skipped rather than queued: if
// the 9:00 run is still working at 10:00, the 10:00 occurrence is dropped and
// recorded as such.
func (r *Runner) Run(a config.Automation, trigger history.Trigger) error {
	if _, busy := r.inFlight.LoadOrStore(a.Name, true); busy {
		r.record(history.NewID(a.Name, ""), a.Name, trigger, history.StatusSkipped, host.Session{},
			"previous run still in flight")
		return fmt.Errorf("%s: previous run still in flight, skipped", a.Name)
	}
	defer r.inFlight.Delete(a.Name)

	id := history.NewID(a.Name, "")
	r.record(id, a.Name, trigger, history.StatusScheduled, host.Session{}, "")

	if a.Command != nil {
		return r.runCommand(id, a, trigger)
	}

	session, err := r.host.Provision(a)
	if err != nil {
		r.record(id, a.Name, trigger, history.StatusFailed,
			host.Session{WorkspaceID: session.WorkspaceID, HerdrSession: session.HerdrSession}, err.Error())
		return err
	}
	r.record(id, a.Name, trigger, history.StatusRunning, session, "")

	timeout := time.Duration(a.TimeoutMinutes) * time.Minute
	if err := r.host.Do(session, a, timeout); err != nil {
		r.record(id, a.Name, trigger, statusFor(err), session, err.Error())
		return err
	}
	r.record(id, a.Name, trigger, history.StatusDone, session, "")
	// After the record: closing is also how a person cancels a run.
	if a.CloseWorkspace == config.CloseOnSuccess {
		if err := r.host.Close(session, a); err != nil {
			log.Printf("%s: done, but its workspace stays open: %v", a.Name, err)
		}
	}
	return nil
}

// runCommand runs the automation's command and records how it ended. The
// status is the program's own: exit 0 is done; any other exit, a signal, the
// timeout or a program that would not start is failed, with the exit code and
// the last lines of stderr kept beside it.
func (r *Runner) runCommand(id string, a config.Automation, trigger history.Trigger) error {
	r.commands.Add(1)
	r.record(id, a.Name, trigger, history.StatusRunning, host.Session{}, "")

	run := r.exec
	if run == nil {
		run = command.Run
	}
	res := run(*a.Command, time.Duration(a.TimeoutMinutes)*time.Minute)

	rec := history.Record{
		RunID: id, Automation: a.Name, Trigger: trigger, Status: history.StatusDone, At: time.Now(),
		ExitCode: res.ExitCode, Result: res.Line(),
	}
	if !res.OK() {
		rec.Status, rec.Error, rec.Stderr = history.StatusFailed, res.Problem, res.Stderr
	}
	r.write(rec, rec.Result)
	r.commands.Add(-1)

	// A command the scheduler ended because it is stopping reports nothing:
	// the process is on its way out, and hc send may wait minutes.
	if a.Notify != "" && !res.Stopped {
		// After the record: the status must not wait on a bot that is busy.
		// The outcome of the report is a second copy of the same record, the
		// way a seen mark is, so a reader always finds the status in the last.
		rec.Notified = r.report(a, rec)
		rec.At = time.Now()
		if err := history.Append(rec); err != nil {
			log.Printf("history append failed: %v", err)
		}
	}
	if !res.OK() {
		return fmt.Errorf("%s: %s", a.Name, rec.Result)
	}
	return nil
}

// report sends the run's one line to the automation's bot and says what
// became of it. A report that cannot be delivered never changes the run's
// status: the command still exited the way it did.
func (r *Runner) report(a config.Automation, rec history.Record) string {
	bots := r.bots
	if bots == nil {
		bots = notify.NewBots()
	}
	line := fmt.Sprintf("[automation %s] %s", a.Name, rec.Status)
	if rec.Result != "" {
		line += ": " + rec.Result
	}
	terminal, err := bots.Send(a.Notify, line)
	if err != nil {
		log.Printf("%s: its result did not reach %s: %v", a.Name, a.Notify, err)
		return "not delivered: " + err.Error()
	}
	return "sent to " + terminal
}

// statusFor decides how a run that ended in err is remembered. Only a workspace
// closed under the run is not a failure.
func statusFor(err error) history.Status {
	if errors.Is(err, host.ErrCancelled) {
		return history.StatusCancelled
	}
	return history.StatusFailed
}

// record is the only writer of run history, which is what makes it the only
// caller of notify: the two cannot drift apart, and a future status inherits
// its notification for free without runner filtering anything.
func (r *Runner) record(id, name string, trigger history.Trigger, st history.Status, s host.Session, errMsg string) {
	r.write(history.Record{
		RunID: id, Automation: name, Trigger: trigger, Status: st, At: time.Now(),
		Session: s.HerdrSession, WorkspaceID: s.WorkspaceID, PaneID: s.PaneID, Error: errMsg,
	}, errMsg)
}

// write appends one record and announces it; detail is the toast's line.
func (r *Runner) write(rec history.Record, detail string) {
	if err := history.Append(rec); err != nil {
		log.Printf("history append failed: %v", err)
	}
	r.notifier.Outcome(rec.Automation, rec.Status, detail)
}
