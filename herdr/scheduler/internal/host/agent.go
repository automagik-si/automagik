package host

import (
	"fmt"
	"log"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/herdr"
)

// agentWork starts an interactive agent, hands it the prompt, and waits for it
// to settle. Every step verifies what actually happened rather than trusting
// the previous call's verdict: a freshly started agent is reported ready before
// it can accept input, and herdr's answers are correspondingly hedged.
type agentWork struct {
	ops   ops
	knobs knobs
	a     config.Automation
	clock func() time.Time
}

func (w agentWork) now() time.Time {
	if w.clock != nil {
		return w.clock()
	}
	return time.Now()
}

// A blocked submit with no observed blocked status is inconclusive. Give a
// short mismatch time to clear without retrying indefinitely against the CLI.
const maxSubmitMismatches = 3

func (w agentWork) do(s Session, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	startupUntil := w.now().Add(startupDialogWindow)
	if err := w.start(s); err != nil {
		if !w.ops.HasCode(err, herdr.CodeAgentNotReady) && !w.ops.HasCode(err, herdr.CodeAgentBlocked) {
			return fmt.Errorf("start %s agent: %w", w.a.Agent, err)
		}
		// A blocked startup retains its agent in this pane. Wait for the
		// dialog before submitting; starting a second agent would be wrong.
		if _, err := w.waitBlocked(s, deadline, startupUntil); err != nil {
			return err
		}
	}
	mismatches := 0
	for {
		if !time.Now().Before(deadline) {
			return fmt.Errorf("prompt: run timeout before the agent accepted the prompt")
		}
		err := w.submit(s)
		if err == nil {
			break
		}
		if !w.ops.HasCode(err, herdr.CodeAgentBlocked) {
			return err
		}
		sawBlocked, err := w.waitBlocked(s, deadline, startupUntil)
		if err != nil {
			return err
		}
		if sawBlocked {
			mismatches = 0
		} else {
			mismatches++
			if mismatches >= maxSubmitMismatches {
				return fmt.Errorf("prompt: agent reported blocked but its status stayed non-blocked after %d attempts", mismatches)
			}
		}
		// Even an immediately cleared dialog gets a poll interval before the
		// next submit; the loop checks the deadline again before sending it.
		time.Sleep(min(w.knobs.statusPoll, time.Until(deadline)))
	}
	if err := w.await(s, time.Until(deadline)); err != nil {
		return err
	}
	return nil
}

// waitBlocked covers a dialog that prevents startup or prompt submission from
// reaching await. Once it clears, the prompt still needs to be submitted.
func (w agentWork) waitBlocked(s Session, deadline, startupUntil time.Time) (bool, error) {
	sawBlocked := false
	var since, dialogSince time.Time
	var previousDialog string
	for {
		status, err := w.ops.AgentStatus(s.PaneID)
		if err != nil {
			return sawBlocked, fmt.Errorf("read blocked agent status: %w", err)
		}
		if status != "blocked" {
			return sawBlocked, nil
		}
		sawBlocked = true
		if !time.Now().Before(deadline) {
			return true, fmt.Errorf("the agent was still blocked at the run timeout")
		}
		if since.IsZero() {
			since = w.now()
		}
		if !w.a.WaitsOutBlocked() {
			now := w.now()
			expired := now.Sub(since) > w.a.BlockedGrace()
			startup := now.Before(startupUntil)
			if expired || startup {
				screen := w.readBlockedScreen(s)
				line := startupDialogLine(screen, w.a.Prompt)
				if line != previousDialog {
					previousDialog, dialogSince = line, now
				}
				if expired || startup && line != "" && now.Sub(dialogSince) >= startupDialogHold {
					if state, err := w.ops.AgentStatus(s.PaneID); err == nil && state != "blocked" {
						return true, nil
					}
					if line == "" {
						line = promptLine(screen)
					}
					return true, dialogError(line)
				}
			}
		}
		time.Sleep(min(w.knobs.statusPoll, time.Until(deadline)))
	}
}

// args assembles what gets forwarded to the agent executable. Model and MCP
// config are sugar over agent_args, and go in front so an explicit agent_args
// entry can still override them.
func (w agentWork) args() []string { return agentArgs(w.a) }

func agentArgs(a config.Automation) []string {
	args := a.AgentArgs
	if a.Model != "" {
		args = append([]string{"--model", a.Model}, args...)
	}
	if a.MCPConfig != "" {
		flag, path := "--mcp-config", a.MCPConfig
		if a.Agent == "copilot" {
			flag, path = "--additional-mcp-config", "@"+path
		}
		args = append([]string{flag, path}, args...)
	}
	return args
}

// start launches the agent, retrying while herdr says the pane is not a shell
// yet. Any other error is final — a bad agent kind or a missing binary will
// not fix itself, and retrying only delays the report.
func (w agentWork) start(s Session) error {
	name := agentNameFor(w.a, s.PaneID)
	deadline := time.Now().Add(w.knobs.paneReady)
	for {
		err := w.ops.AgentStart(name, w.a.Agent, s.PaneID, w.args())
		// An unread previous run still holds the name: take the pane-marked
		// one existing mode uses, rather than fail every run until it is read.
		if paneName := paneAgentName(w.a, s.PaneID); w.ops.HasCode(err, herdr.CodeNameTaken) && name != paneName {
			name = paneName
			continue
		}
		if err == nil || !w.ops.HasCode(err, herdr.CodePaneBusy) {
			return err
		}
		if !time.Now().Before(deadline) {
			return err
		}
		log.Printf("pane has no shell yet, retrying agent start in %s", w.knobs.paneReadyPoll)
		time.Sleep(w.knobs.paneReadyPoll)
	}
}

// submit gets the prompt in front of the agent and confirms it started working.
//
// A freshly started agent is reported ready before it can actually accept
// input — it may still be connecting MCP servers, especially right after the
// machine wakes. herdr then reports agent_prompt_stalled even though the text
// reached the composer, so each step here checks the status rather than
// trusting the previous call's verdict.
func (w agentWork) submit(s Session) error {
	err := w.ops.AgentSubmit(s.PaneID, w.a.Prompt)
	if err == nil {
		return nil
	}
	if !w.ops.HasCode(err, herdr.CodeStalled) {
		return fmt.Errorf("prompt: %w", err)
	}

	// The text is probably in the composer, just not submitted. Give the agent
	// a moment, then press Enter for it, then fall back to typing it again.
	if w.working(s, w.knobs.promptSettle) {
		return nil
	}
	log.Printf("prompt stalled on %s, submitting the pending composer", s.PaneID)
	if err := w.ops.AgentSubmitPending(s.PaneID); err != nil {
		return fmt.Errorf("prompt: %w", err)
	}
	if w.working(s, w.knobs.promptSettle) {
		return nil
	}

	log.Printf("still idle on %s, retyping the prompt", s.PaneID)
	if err := w.ops.AgentSubmit(s.PaneID, w.a.Prompt); err != nil && !w.ops.HasCode(err, herdr.CodeStalled) {
		return fmt.Errorf("prompt: %w", err)
	}
	if w.working(s, w.knobs.promptSettleLast) {
		return nil
	}
	return fmt.Errorf("prompt: the agent never started working; it may still be initialising")
}

// working polls until the agent leaves idle, or the window closes.
func (w agentWork) working(s Session, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for {
		status, err := w.ops.AgentStatus(s.PaneID)
		if err == nil && status != "idle" && status != "unknown" {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(w.knobs.statusPoll)
	}
}

// await blocks until the agent settles, the run is cancelled, or the timeout
// runs out.
//
// It waits in slices rather than handing herdr the whole timeout at once. A run
// whose workspace was closed thirteen seconds in used to sit here for the full
// forty-five minutes before anyone was told, holding the automation's in-flight
// slot the whole time and skipping the next occurrence.
func (w agentWork) await(s Session, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	var blockedSince time.Time
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			if last != nil {
				return last
			}
			return fmt.Errorf("the agent was still working after %s", timeout)
		}
		slice := min(w.knobs.waitSlice, remaining)

		err := w.ops.AgentWait(s.PaneID, slice)
		if w.ops.HasCode(err, herdr.CodeAgentGone) {
			return w.agentGoneOutcome(s)
		}
		// AgentWait also settles on blocked. Check its status after each slice
		// instead of recording a dialog as successful work.
		status, statusErr := w.ops.AgentStatus(s.PaneID)
		if statusErr == nil && status == "blocked" {
			if blockedSince.IsZero() {
				blockedSince = w.now()
			}
			if !w.a.WaitsOutBlocked() && w.now().Sub(blockedSince) > w.a.BlockedGrace() {
				screen := w.readBlockedScreen(s)
				if state, err := w.ops.AgentStatus(s.PaneID); err != nil || state == "blocked" {
					return dialogError(promptLine(screen))
				}
				blockedSince = time.Time{}
			}
			// A blocked wait returns at once. Pace it while the grace runs.
			time.Sleep(min(w.knobs.statusPoll, time.Until(deadline)))
			continue
		}
		blockedSince = time.Time{}
		if err == nil {
			if statusErr != nil {
				return fmt.Errorf("read agent status after waiting: %w", statusErr)
			}
			// Only the agent's own idle or done is a finished run. Herdr's wait
			// also returns for an agent it can no longer read, and recording
			// that as done listed runs done whose work had failed (#938).
			switch status {
			case "idle", "done":
				return nil
			case "error":
				return fmt.Errorf("the agent reported an error")
			case "working":
			default:
				// unknown, or a word this build does not know: not an answer
				// yet. Keep waiting, and say so if the timeout comes first.
				last = fmt.Errorf("the agent's status was %q at the run timeout, neither idle nor done", status)
			}
			time.Sleep(min(w.knobs.statusPoll, time.Until(deadline)))
			continue
		}
		// The slice expired with the agent still working, which is the normal
		// case. Keep it: if the deadline passes it is the most accurate thing
		// we have to report.
		last = err
	}
}

func (w agentWork) readBlockedScreen(s Session) string {
	screen, err := w.ops.PaneRead(s.PaneID, 30)
	if err != nil {
		log.Printf("could not read the screen of %s: %v", s.PaneID, err)
		return ""
	}
	return screen
}

// agentGoneOutcome disambiguates herdr's agent_not_running: it means either
// the workspace was closed, or the agent process died inside a workspace that
// is still open. herdr.go documents both under the same code, but only the
// first is a cancellation — the second is a crash, and reporting it as
// "cancelled" hides it behind the one status the plugin deliberately never
// notifies about.
func (w agentWork) agentGoneOutcome(s Session) error {
	_, err := w.ops.AgentStatus(s.PaneID)
	switch {
	case err == nil:
		// The pane is alive and answered, so nothing closed the workspace —
		// the agent itself is what is missing.
		return fmt.Errorf("the agent exited before finishing")
	case w.ops.HasCode(err, herdr.CodeWorkspaceGone):
		return ErrCancelled
	case w.ops.HasCode(err, herdr.CodeAgentGone):
		// AgentStatus is itself agent-scoped, so a dead agent in a live
		// workspace is exactly as likely to answer with its own
		// agent_not_running as with a status string. Either shape means the
		// same thing: the workspace is fine, the agent is what is gone.
		return fmt.Errorf("the agent exited before finishing")
	default:
		// Unreadable for some other, unrelated reason: not enough to call it
		// a crash, so keep the existing behaviour rather than turning a doubt
		// into a failure.
		log.Printf("could not confirm why %s went silent (%v), recording it as cancelled", s.PaneID, err)
		return ErrCancelled
	}
}
