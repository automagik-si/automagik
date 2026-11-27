//go:build unix

package host

import (
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/herdr"
)

// A person can answer a dialog after the grace and screen read, before the
// failure verdict. A working agent at the final check resumes instead of failing.
func TestDoResumesWhenDialogClearsBeforeFailure(t *testing.T) {
	for _, phase := range []string{"start", "submit", "await"} {
		t.Run(phase, func(t *testing.T) {
			clock := time.Unix(0, 0)
			state := "blocked"
			dialogCleared := false
			ops := &fakeOps{}
			ops.agentStatus = func(string) (string, error) {
				clock = clock.Add(time.Minute)
				return state, nil
			}
			ops.agentWait = func(string, time.Duration) error {
				if dialogCleared {
					state = "done"
				}
				return nil
			}
			ops.paneRead = func(string, int) (string, error) {
				if clock.Sub(time.Unix(0, 0)) >= 4*time.Minute {
					state, dialogCleared = "working", true
				}
				return "Do you want to proceed?", nil
			}
			if phase == "start" {
				ops.agentStart = func(string, string, string, []string) error { return apiErr("agent start", herdr.CodeAgentNotReady) }
			}
			if phase == "submit" {
				ops.agentSubmit = func(string, string) error {
					if ops.submits == 1 {
						return apiErr("agent prompt", herdr.CodeAgentBlocked)
					}
					return nil
				}
			}
			w := agentWorkWith(ops, config.Automation{Prompt: "go"})
			w.clock = func() time.Time { return clock }
			if err := w.do(Session{PaneID: "p"}, 200*time.Millisecond); err != nil {
				t.Fatal(err)
			}
			wantSubmits := 1
			if phase == "submit" {
				wantSubmits = 2
			}
			if !dialogCleared || len(ops.stopRequests) != 0 || ops.starts != 1 || ops.submits != wantSubmits {
				t.Fatalf("dialogCleared=%t stopRequests=%v starts=%d submits=%d", dialogCleared, ops.stopRequests, ops.starts, ops.submits)
			}
			if len(ops.closed)+len(ops.closedTabs) != 0 {
				t.Fatal("resumed run closed its layout")
			}
		})
	}
}
