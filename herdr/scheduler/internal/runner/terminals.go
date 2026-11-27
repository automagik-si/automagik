package runner

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/history"
	"github.com/DnzzL/herdr-automations/internal/host"
)

var errRunLocked = errors.New("previous run still in flight")

// A manual run and the daemon share history but have separate in-flight maps.
func lockRun(name string) (func(), error) {
	return lockState("automation", name, syscall.LOCK_EX|syscall.LOCK_NB)
}

func lockWorkspace(s host.Session) (func(), error) {
	return lockState("workspace", s.HerdrSession+"\x00"+s.WorkspaceID, syscall.LOCK_EX)
}

func lockState(kind, key string, mode int) (func(), error) {
	dir := filepath.Join(config.StateDir(), "run-locks")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("lock %s: %w", kind, err)
	}
	path := filepath.Join(dir, fmt.Sprintf("%s-%x", kind, sha256.Sum256([]byte(key))))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("lock %s: %w", kind, err)
	}
	if err := syscall.Flock(int(f.Fd()), mode); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, errRunLocked
		}
		return nil, fmt.Errorf("lock %s: %w", kind, err)
	}
	// Keep the file so all contenders lock the same inode.
	return func() { _ = f.Close() }, nil
}

func (r *Runner) fail(id string, a config.Automation, trigger history.Trigger, s host.Session,
	runErr error, terminals host.RunTerminals) error {
	rec := runRecord(id, a.Name, trigger, statusFor(runErr), s)
	rec.Error = runErr.Error()
	if terminals == nil || rec.Status != history.StatusFailed || !ownsTerminal(s) {
		r.write(rec, rec.Error)
		return runErr
	}
	if err := r.removeTerminal(terminals, a, s, rec, "failed run", true); err != nil {
		return errors.Join(runErr, err)
	}
	return runErr
}

func ownsTerminal(s host.Session) bool {
	return s.PaneID != "" && (s.Target == "" || strings.HasPrefix(s.Target, "worker:"))
}

func (r *Runner) removePrevious(terminals host.RunTerminals, a config.Automation, trigger history.Trigger) error {
	runs, err := history.Runs(a.Name, 0)
	if err != nil {
		return fmt.Errorf("read earlier runs: %w", err)
	}
	known := make([]host.Session, 0, len(runs))
	for _, rec := range runs {
		s := host.Session{HistoryID: rec.RunID, WorkspaceID: rec.WorkspaceID,
			PaneID: rec.PaneID, HerdrSession: rec.Session,
			TabID: rec.TabID, Workspace: rec.Workspace, TerminalID: rec.TerminalID, Target: rec.Target,
			Started: rec.Started, Observed: rec.TerminalObserved, TargetParent: rec.TargetParent,
			CleanupPending: rec.CleanupPending}
		switch rec.Status {
		case history.StatusRunning, history.StatusFailed, history.StatusDone:
			if ownsTerminal(s) && (rec.Cleanup == "" || rec.CleanupPending) {
				known = append(known, s)
			}
		}
	}
	previous, err := terminals.Previous(a, known)
	if err != nil {
		return fmt.Errorf("find earlier terminals: %w", err)
	}
	var removalErrors error
	for _, s := range previous {
		rec := runRecord(history.NewID(a.Name, "recovered"), a.Name, trigger, history.StatusRunning, s)
		for _, old := range runs {
			if s.HistoryID != "" && s.HistoryID != old.RunID {
				continue
			}
			if old.PaneID == s.PaneID && (old.WorkspaceID == "" || old.WorkspaceID == s.WorkspaceID) &&
				old.Session == s.HerdrSession &&
				(old.TabID == "" || old.TabID == s.TabID) &&
				(old.TerminalID == "" || old.TerminalID == s.TerminalID) && old.Target == s.Target {
				rec = old
				break
			}
		}
		if s.CleanupSkip != "" {
			rec.Seen = false
			rec.Cleanup, rec.CleanupPending = s.CleanupSkip, true
			if err := history.Append(rec); err != nil {
				log.Printf("history append failed: %v", err)
			}
			continue
		}
		announce := rec.Status == history.StatusRunning
		if announce {
			rec.Status, rec.Error = history.StatusFailed, "previous run left a live terminal"
		}
		removalErrors = errors.Join(removalErrors, r.removeTerminal(terminals, a, s, rec, "earlier run", announce))
	}
	return removalErrors
}

func (r *Runner) removeTerminal(terminals host.RunTerminals, a config.Automation, s host.Session,
	rec history.Record, reason string, announce bool) error {
	// Keep the original failure and any screen saved before a partial removal.
	rec.Seen = false // This is an update, not a seen marker.
	rec.TabID, rec.Workspace, rec.TerminalID = s.TabID, s.Workspace, s.TerminalID
	rec.WorkspaceID = s.WorkspaceID
	rec.TargetParent = s.TargetParent
	if screen, err := terminals.Screen(s); err != nil {
		log.Printf("%s: could not read terminal %s: %v", a.Name, s.PaneID, err)
	} else if screen != "" && rec.Screen == "" {
		rec.Screen = screen
	}
	if announce {
		rec.At = time.Now()
	}
	rec.CleanupPending = true
	rec.Cleanup = "removing terminal of " + reason
	appendRecord := history.Append
	if announce {
		appendRecord = func(rec history.Record) error { return r.write(rec, rec.Error) }
	}
	if err := appendRecord(rec); err != nil {
		return fmt.Errorf("save history before removing terminal %s: %w", s.PaneID, err)
	}
	err := withWorkspaceLock(s, func() error { return terminals.Remove(s, a) })
	if err == nil {
		rec.Cleanup, rec.CleanupPending = "removed terminal of "+reason, false
	} else {
		rec.Cleanup = fmt.Sprintf("could not remove terminal %s: %v", s.PaneID, err)
	}
	if appendErr := history.Append(rec); appendErr != nil {
		log.Printf("history append failed: %v", appendErr)
	}
	if err != nil {
		return fmt.Errorf("remove terminal %s of %s: %w", s.PaneID, reason, err)
	}
	return nil
}

func withWorkspaceLock(s host.Session, action func() error) error {
	if s.WorkspaceID == "" || s.Workspace == config.WorkspaceRoot || s.Workspace == config.WorkspaceWorktree {
		return action()
	}
	release, err := lockWorkspace(s)
	if err != nil {
		return err
	}
	defer release()
	return action()
}
