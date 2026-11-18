package host

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/hc"
)

// hcOps is the hc host's internal seam: herdr-core, and the two git calls a
// worktree run needs now that no Herdr makes the worktree for us.
type hcOps interface {
	Run(cwd string, labels map[string]string, argv []string) (string, error)
	Wait(address string, timeout time.Duration) (hc.Wait, error)
	Get(address string) (hc.Terminal, error)
	Terminals(labels map[string]string) ([]string, error)
	Read(address string) (string, error)
	Kill(address string) error
	Rm(address string) error
	// MainCheckout is the repo's main working tree, whatever checkout repo is.
	MainCheckout(repo string) (string, error)
	WorktreeAdd(repo, branch, path string) error
}

// NewHC returns the Host that runs automations in herdr-core, where the Herdr
// desktop app shows them (ADR 0011).
func NewHC() Host {
	home, _ := os.UserHomeDir()
	return &hcHost{ops: hcLive{}, home: home, knobs: defaultKnobs()}
}

type hcHost struct {
	ops   hcOps
	home  string
	knobs knobs
	// clock measures the blocked grace. nil is time.Now; the tests advance it
	// instead of sleeping out a real grace.
	clock func() time.Time
}

func (h *hcHost) now() time.Time {
	if h.clock != nil {
		return h.clock()
	}
	return time.Now()
}

// Provision makes the place and starts the agent there with its prompt.
//
// Starting the agent here rather than in Do is what puts its terminal address
// in the run's history as soon as it is running. hc takes the prompt with the
// launch, so there is no separate submit step to keep apart.
func (h *hcHost) Provision(a config.Automation) (Session, error) {
	argv, err := hcArgv(a)
	if err != nil {
		return Session{}, err
	}
	space, cwd := newID("sp"), a.Repo
	var tabID string
	switch a.Workspace {
	case config.WorkspaceWorktree:
		cwd, err = h.worktree(a)
		if err != nil {
			return Session{}, err
		}
	case config.WorkspaceExisting:
		space = a.WorkspaceID
		// The app adopts this terminal into the tab named by its label, so
		// that id identifies the run's own tab when Close checks the space.
		tabID = newID("tb")
	case config.WorkspaceRoot:
	default:
		return Session{}, fmt.Errorf("unknown workspace mode %q", a.Workspace)
	}
	tab := tabID
	if tab == "" {
		tab = newID("tb")
	}
	// An id the app does not know becomes a new space or tab, unnamed, so it
	// is called after its folder and nests under its repo.
	labels := map[string]string{"herdr.space": space, "herdr.tab": tab, "automation": a.Name}
	address, err := h.ops.Run(cwd, labels, argv)
	if err != nil {
		return Session{WorkspaceID: space}, fmt.Errorf("start %s: %w", argv[0], err)
	}
	return Session{WorkspaceID: space, PaneID: address, TabID: tabID}, nil
}

// worktree checks out a fresh branch where the app's "New worktree…" would:
// ~/.herdr/worktrees/<main checkout's folder>/<branch, slashes as dashes>.
func (h *hcHost) worktree(a config.Automation) (string, error) {
	main, err := h.ops.MainCheckout(a.Repo)
	if err != nil {
		return "", fmt.Errorf("%s is not a git repository: %w", a.Repo, err)
	}
	branch := fmt.Sprintf("auto/%s-%s", slug(a.Name), time.Now().Format("20060102-1504"))
	path := filepath.Join(h.home, ".herdr", "worktrees", filepath.Base(main), appSlug(branch))
	if err := h.ops.WorktreeAdd(a.Repo, branch, path); err != nil {
		return "", fmt.Errorf("git worktree add: %w", err)
	}
	return path, nil
}

// Do waits for the agent to finish its turn.
func (h *hcHost) Do(s Session, a config.Automation, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	started := time.Now()
	turn, working := 0, false
	grace := a.BlockedGrace()
	failFast := !a.WaitsOutBlocked()
	var blockedSince time.Time
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("the agent was still working after %s", timeout)
		}
		w, err := h.ops.Wait(s.PaneID, min(h.knobs.waitSlice, remaining))
		if err != nil {
			// The terminal is unreadable: removed along with its space, most
			// likely. Not enough to call it a crash (see agentGoneOutcome).
			log.Printf("could not wait on %s (%v), recording it as cancelled", s.PaneID, err)
			return ErrCancelled
		}
		turn = max(turn, w.Turn)
		// Claude counts a turn when it starts, pi when it ends: having been
		// seen at work is what says the prompt landed. Blocked is not that: a
		// dialog can come up before the prompt is read (a trust or a permission
		// mode question), and a run that went from it straight back to idle did
		// no work at all (#938).
		working = working || w.Status == "working"
		switch {
		case w.Reason == "exit":
			return h.exitOutcome(s, turn > 0 || working)
		case w.Reason == "status" && w.Status == "error":
			return fmt.Errorf("the agent reported an error")
		// done is the agent's own word for a finished turn, so it needs no
		// second witness: a turn shorter than one wait is never seen working,
		// and an agent that reports no turn count would otherwise be failed
		// as "never started" with its work finished (#938).
		case w.Reason == "status" && w.Status == "done":
			return nil
		// idle is also what an agent says before it has read its prompt.
		case w.Reason == "status" && w.Status == "idle" && (turn > 0 || working):
			return nil
		}
		// A dialog is not work: after the grace the run fails now, with the
		// line the person would have read, instead of holding its slot until
		// the timeout. A blocked blip under the grace is left alone.
		if failFast && w.Status == "blocked" {
			if blockedSince.IsZero() {
				blockedSince = h.now()
			}
			if h.now().Sub(blockedSince) > grace {
				return h.blockedOutcome(s)
			}
		} else {
			blockedSince = time.Time{}
		}
		// No turn yet after this long: the agent is sitting on something only
		// a person can answer, like Claude's trust dialog in a folder it has
		// never seen. It reports no status there at all, not even blocked.
		if turn == 0 && !working && time.Since(started) > h.knobs.paneReady && !h.reportsWork(s) {
			return fmt.Errorf("the agent never started working; open %s and look for a dialog (trust prompt?)", s.PaneID)
		}
		if w.Ended {
			// blocked, or idle before the prompt landed: wait answers at once
			// for those, so pace the loop.
			time.Sleep(h.knobs.statusPoll)
		}
	}
}

// blockedOutcome ends the blocked agent's terminal and reports the dialog it
// was waiting on. The workspace and tab are left open, as any failed run's
// are: they are where a person goes to read what happened.
func (h *hcHost) blockedOutcome(s Session) error {
	line := ""
	if screen, err := h.ops.Read(s.PaneID); err == nil {
		line = promptLine(screen)
	} else {
		log.Printf("could not read the screen of %s: %v", s.PaneID, err)
	}
	if err := h.ops.Kill(s.PaneID); err != nil && !errors.Is(err, hc.ErrNotFound) {
		log.Printf("could not end the blocked agent on %s: %v", s.PaneID, err)
	}
	if line == "" {
		return fmt.Errorf("blocked on a dialog")
	}
	return fmt.Errorf("blocked on a dialog: %s", line)
}

// Close ends the run's terminal, which makes the app remove its tab, then
// removes the finished terminal. hc counts blocked as unfinished, so Do never
// reports done for an agent waiting on a person.
//
// In existing mode the tab is the run's, but the space is shared: the app
// removes a space with its last tab, so the space's terminals are read first
// and the tab is left open when it is the only one at that moment. A person
// closing the other tabs in between can still leave it last; the scheduler
// itself asks for no space close in this mode.
func (h *hcHost) Close(s Session, a config.Automation) error {
	if a.Workspace == config.WorkspaceExisting {
		if s.TabID == "" {
			log.Printf("%s: done, but its tab stays open: the run has no tab id", a.Name)
			return nil
		}
		unlock := lockWorkspaceClose("hc", s.WorkspaceID)
		defer unlock()
		// Re-read after acquiring the lock, immediately before the kill.
		terminals, err := h.ops.Terminals(map[string]string{"herdr.space": s.WorkspaceID})
		if err != nil {
			log.Printf("%s: done, but its tab stays open: cannot tell whether it is the space's last one (%v)", a.Name, err)
			return nil
		}
		// The run's tab id is minted for it alone, so any other terminal in
		// the space is another tab at this read. Leave the last tab we can see.
		if len(terminals) <= 1 {
			log.Printf("%s: done, but its tab stays open: it is the last one in its space at the time of the check", a.Name)
			return nil
		}
	}
	if err := h.ops.Kill(s.PaneID); err != nil && !errors.Is(err, hc.ErrNotFound) {
		return err
	}
	if err := h.ops.Rm(s.PaneID); err != nil && !errors.Is(err, hc.ErrNotFound) {
		return err
	}
	return nil
}

// reportsWork asks the terminal itself: a wait that only checked in may not
// carry the agent's state. done counts: an agent that says so did start.
func (h *hcHost) reportsWork(s Session) bool {
	t, err := h.ops.Get(s.PaneID)
	if err != nil || t.Status == nil {
		return false
	}
	return t.Status.State == "working" || t.Status.State == "blocked" || t.Status.State == "done"
}

// exitOutcome reads how the run's program ended. Closing the run's space in
// the app kills its terminal: called off. A non-zero code, or none, is a crash.
//
// Exit code 0 is done only when nothing says the work was cut short (#938):
// the program never reported a status (a plain program or a template's
// script, where the exit code is the only word there is), or the agent's last
// word was done, or idle after its turn (worked). An agent that left while
// working or blocked, or idle before it read its prompt, was quit, and agents
// exit 0 on a quit: that is not a finished run.
func (h *hcHost) exitOutcome(s Session, worked bool) error {
	t, err := h.ops.Get(s.PaneID)
	if err != nil || t.Reason == "killed" {
		return ErrCancelled
	}
	if t.ExitCode == nil {
		return fmt.Errorf("the agent exited before finishing")
	}
	if *t.ExitCode == 0 {
		switch {
		case t.Status == nil, t.Status.State == "done", t.Status.State == "idle" && worked:
			return nil
		}
	}
	return fmt.Errorf("the agent exited with code %d before finishing", *t.ExitCode)
}

// hcArgv is what hc runs: a template and its task, or the agent with its
// flags and the prompt as its first message.
func hcArgv(a config.Automation) ([]string, error) {
	if a.Template != "" {
		return []string{a.Template, a.Prompt}, nil
	}
	if !config.KindTakesPromptArg(a.Agent) {
		return nil, fmt.Errorf("agent %q cannot take its prompt under backend: hc yet", a.Agent)
	}
	argv := []string{a.Agent}
	if a.Agent == "codex" && !slices.Contains(a.AgentArgs, "--no-daemon") {
		// Keep execution in this hc terminal; configured permissions stay as supplied.
		argv = append(argv, "--no-daemon")
	}
	argv = append(argv, agentArgs(a)...)
	return append(argv, config.PromptArgs(a.Agent, a.Prompt)...), nil
}

var appSlugRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// appSlug is the app's own folder name for a branch (mods/worktree/main.js).
func appSlug(branch string) string {
	return strings.Trim(appSlugRe.ReplaceAllString(branch, "-"), "-")
}

// newID mints an id in the app's shape: a two-letter kind and 32 hex digits.
func newID(kind string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return kind + hex.EncodeToString(b)
}

// hcLive is the production hcOps.
type hcLive struct{ hc.Client }

func (hcLive) MainCheckout(repo string) (string, error) {
	out, err := exec.Command("git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir").Output()
	if err != nil {
		return "", err
	}
	return filepath.Dir(strings.TrimSpace(string(out))), nil
}

func (hcLive) WorktreeAdd(repo, branch, path string) error {
	out, err := exec.Command("git", "-C", repo, "worktree", "add", "-b", branch, path, "HEAD").CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return nil
}
