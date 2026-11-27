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
	"sync"
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
	Send(address, text string) error
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
	return &hcHost{ops: hcLive{}, home: home, knobs: defaultKnobs(),
		installID: sync.OnceValue(schedulerInstallID)}
}

type hcHost struct {
	ops       hcOps
	home      string
	knobs     knobs
	installID func() string
	// Tests advance the clock for blocked grace and startup inspections.
	clock func() time.Time
	// notes belong to runs on different panes, which can finish together.
	notesMu sync.Mutex
	notes   map[string]string
	// roster and amFn are a target run's seams. nil is the project's real
	// .herdr/bots.json and the pack's real `am`.
	roster func(path string) ([]byte, error)
	amFn   func(args, extraEnv []string) (string, error)
}

const (
	installLabel   = "automation.install"
	installIDBytes = 16
)

func schedulerInstallID() string {
	id, err := loadInstallID(config.StateDir())
	if err != nil {
		log.Printf("scheduler install identity unavailable: %v", err)
	}
	return id
}

func loadInstallID(dir string) (string, error) {
	path := filepath.Join(dir, "install-id")
	id, err := readInstallID(path)
	if !errors.Is(err, os.ErrNotExist) {
		return id, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	temp, err := os.CreateTemp(dir, ".install-id-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(temp.Name())
	var random [installIDBytes]byte
	rand.Read(random[:])
	id = hex.EncodeToString(random[:])
	_, writeErr := temp.WriteString(id)
	if err := errors.Join(writeErr, temp.Close()); err != nil {
		return "", err
	}
	// A concurrent scheduler can win the link, but can only see a complete ID.
	if err := os.Link(temp.Name(), path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return readInstallID(path)
		}
		return "", err
	}
	return id, nil
}

func readInstallID(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 ||
		info.Size() != 2*installIDBytes {
		return "", fmt.Errorf("invalid or non-private install identity file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if _, err := hex.DecodeString(string(data)); err != nil {
		return "", fmt.Errorf("invalid install identity")
	}
	return string(data), nil
}

const (
	startupDialogWindow = 2 * time.Minute
	startupDialogHold   = 10 * time.Second
)

// Note returns the run's note and forgets it.
func (h *hcHost) Note(s Session) string {
	h.notesMu.Lock()
	defer h.notesMu.Unlock()
	note := h.notes[s.PaneID]
	delete(h.notes, s.PaneID)
	return note
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
	if a.Target != "" {
		return h.targetProvision(a)
	}
	argv, err := hcArgv(a)
	if err != nil {
		return Session{}, err
	}
	space, cwd := newID("sp"), a.Repo
	tab := newID("tb")
	switch a.Workspace {
	case config.WorkspaceWorktree:
		cwd, err = h.worktree(a)
		if err != nil {
			return Session{}, err
		}
	case config.WorkspaceExisting:
		space = a.WorkspaceID
	case config.WorkspaceRoot:
	default:
		return Session{}, fmt.Errorf("unknown workspace mode %q", a.Workspace)
	}
	// An id the app does not know becomes a new space or tab, unnamed, so it
	// is called after its folder and nests under its repo. The tab ID also
	// identifies this run if hc later reuses its terminal address.
	labels := map[string]string{"herdr.space": space, "herdr.tab": tab, "automation": a.Name,
		"automation.workspace": string(a.Workspace)}
	if id := h.installID(); id != "" {
		labels[installLabel] = id
	}
	address, err := h.ops.Run(cwd, labels, argv)
	s := Session{WorkspaceID: space, PaneID: address, TabID: tab, Workspace: a.Workspace}
	if err != nil {
		return s, fmt.Errorf("start %s: %w", argv[0], err)
	}
	return s, nil
}

// worktree checks out a fresh branch where the app's "New worktree…" would:
// ~/.herdr/worktrees/<main checkout's folder>/<branch, slashes as dashes>.
func (h *hcHost) worktree(a config.Automation) (string, error) {
	main, err := h.ops.MainCheckout(a.Repo)
	if err != nil {
		return "", fmt.Errorf("%s is not a git repository: %w", a.Repo, err)
	}
	branch := fmt.Sprintf("auto/%s-%s", slug(a.Name), time.Now().Format("20060102-1504"))
	path := filepath.Join(h.worktreeFolder(main), appSlug(branch))
	if err := h.ops.WorktreeAdd(a.Repo, branch, path); err != nil {
		return "", fmt.Errorf("git worktree add: %w", err)
	}
	return path, nil
}

func (h *hcHost) worktreeFolder(main string) string {
	return filepath.Join(h.home, ".herdr", "worktrees", filepath.Base(main))
}

// Do carries out the run: a bot target hands the prompt over (or skips a busy
// bot), a worker target waits for its turn and ends it, and every other run
// waits for its agent as before.
func (h *hcHost) Do(s Session, a config.Automation, timeout time.Duration) error {
	if s.Target != "" {
		return h.targetDo(s, a, timeout)
	}
	return h.waitTurn(s, a, timeout)
}

// waitTurn waits for the agent in s to finish its turn.
func (h *hcHost) waitTurn(s Session, a config.Automation, timeout time.Duration) error {
	h.Note(s)
	started := time.Now()
	startupStarted := h.now()
	deadline := started.Add(timeout)
	turn, working := 0, false
	sawWork := func() {
		if turn > 0 || working {
			return
		}
		working = true
		elapsed := time.Since(started)
		if elapsed > h.knobs.paneReady {
			note := fmt.Sprintf("started late: first seen working %s after the run began", elapsed.Round(time.Second))
			log.Printf("%s: %s", s.PaneID, note)
			h.notesMu.Lock()
			if h.notes == nil {
				h.notes = make(map[string]string)
			}
			h.notes[s.PaneID] = note
			h.notesMu.Unlock()
		}
	}
	grace := a.BlockedGrace()
	failFast := !a.WaitsOutBlocked()
	var blockedSince, inspected, dialogSince time.Time
	var waitErr error
	previousDialog := ""
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			if waitErr != nil {
				return fmt.Errorf("wait for the agent until the run timeout: %w", waitErr)
			}
			if turn == 0 && !working {
				if h.agentState(s) == "working" {
					sawWork()
				} else {
					return fmt.Errorf("the agent never started working: no sign of work in %s", timeout)
				}
			}
			return fmt.Errorf("the agent was still working after %s", timeout)
		}
		slice := h.knobs.waitSlice
		if !working || !blockedSince.IsZero() {
			slice = h.knobs.statusPoll
		}
		w, err := h.ops.Wait(s.PaneID, min(slice, remaining))
		if err != nil {
			if errors.Is(err, hc.ErrNotFound) {
				return ErrCancelled
			}
			waitErr = err
			time.Sleep(min(h.knobs.statusPoll, time.Until(deadline)))
			continue
		}
		waitErr = nil
		// Claude counts a turn when it starts, pi when it ends: having been
		// seen at work is what says the prompt landed. Blocked is not that: a
		// dialog can come up before the prompt is read (a trust or a permission
		// mode question), and a run that went from it straight back to idle did
		// no work at all (#938).
		if w.Status == "working" || w.Turn > 0 {
			sawWork()
		}
		turn = max(turn, w.Turn)
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
				return dialogError(promptLine(h.readScreen(s)))
			}
		} else {
			blockedSince = time.Time{}
		}
		if time.Until(deadline) <= 0 {
			continue
		}
		// Only use screen evidence during startup. Once work starts, the
		// agent's blocked status and its configured grace govern the failure.
		now := h.now()
		if !working && now.Sub(inspected) >= h.knobs.statusPoll {
			inspected = now
			line := ""
			if failFast && now.Sub(startupStarted) < startupDialogWindow {
				if screen, err := h.ops.Read(s.PaneID); err == nil {
					line = startupDialogLine(screen, a.Prompt)
				}
			}
			switch h.agentState(s) {
			case "working":
				sawWork()
			case "done", "error":
				line = "" // Let the next wait confirm the turn's outcome.
			}
			if line != previousDialog {
				previousDialog, dialogSince = line, now
			}
			if !working && line != "" && now.Sub(dialogSince) >= startupDialogHold &&
				time.Until(deadline) > 0 {
				return fmt.Errorf("the agent never started working: %w", dialogError(line))
			}
		}
		if w.Ended {
			// blocked, or idle before the prompt landed: wait answers at once
			// for those, so pace the loop.
			time.Sleep(h.knobs.statusPoll)
		}
	}
}

func (h *hcHost) readScreen(s Session) string {
	screen, err := h.ops.Read(s.PaneID)
	if err != nil {
		log.Printf("could not read the screen of %s: %v", s.PaneID, err)
	}
	return screen
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
	if s.Target != "" {
		// A target run opened no workspace to close; a worker target ended its
		// worker with the run.
		return nil
	}
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

// agentState asks the terminal itself: a wait that only checked in may not
// carry the agent's state. An unreadable state is unknown, not a witness.
func (h *hcHost) agentState(s Session) string {
	t, err := h.ops.Get(s.PaneID)
	if err != nil || t.Status == nil {
		return ""
	}
	return t.Status.State
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
	if errors.Is(err, hc.ErrNotFound) || t.Reason == "killed" {
		return ErrCancelled
	}
	if err != nil {
		return fmt.Errorf("read the agent's exit status: %w", err)
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
