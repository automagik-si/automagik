// A target run hands its prompt to a bot instead of opening a fresh session
// (#498): to the bot's own terminal ("bot:<id>"), or to a worker started under
// that bot for this run ("worker:<id>"). The bot is named by its id in the
// project's .herdr/bots.json, never by a terminal address: addresses change on
// every restart, ids do not.
//
// The worker is started by the pack's own CLI (`am worker`) with the bot's
// pane as the caller, so it inherits the bot's launch and permission words
// exactly as a worker the bot starts itself would. The scheduler only decides
// when and ends it when the run finishes.
package host

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/hc"
	"github.com/DnzzL/herdr-automations/internal/hostpath"
)

// ErrTargetBusy means a bot target was dropped because the bot was already
// working and target_when_busy is skip. It is a skip, not a failure.
var ErrTargetBusy = errors.New("the bot was busy")

// botRoster is a project's .herdr/bots.json, trimmed to what a target reads:
// the stable id, the name a person sees, and whether the bot is only planned.
type botRoster struct {
	Version int         `json:"version"`
	Bots    []rosterBot `json:"bots"`
}

type rosterBot struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Planned json.RawMessage `json:"planned"`
}

// find returns the bot by its id, or nil.
func (r *botRoster) find(id string) *rosterBot {
	for i := range r.Bots {
		if r.Bots[i].ID == id {
			return &r.Bots[i]
		}
	}
	return nil
}

// targetProvision resolves the target and makes the place the run's prompt
// goes: the bot's own terminal, started when it is not running, or a worker
// of it for this run.
func (h *hcHost) targetProvision(a config.Automation) (Session, error) {
	kind, botID, err := config.SplitTarget(a.Target)
	if err != nil {
		return Session{}, err
	}
	project, roster, err := h.projectOf(a.Repo)
	if err != nil {
		return Session{}, err
	}
	bot := roster.find(botID)
	if bot == nil {
		return Session{}, fmt.Errorf("%s isn't defined in %s: pick a bot from that project's roster "+
			"(a bot on a linked machine is not a target here)", botID, filepath.Join(project, ".herdr", "bots.json"))
	}
	if len(bot.Planned) > 0 && string(bot.Planned) != "null" {
		return Session{}, fmt.Errorf("%s (%s) is planned and starts no runs (%s): clear planned there, "+
			"or pick a bot that is not planned", bot.Name, botID, filepath.Join(project, ".herdr", "bots.json"))
	}
	name := bot.Name
	if name == "" {
		name = botID
	}
	addr, remote, err := h.liveBot(project, botID)
	if err != nil {
		return Session{}, fmt.Errorf("looking for %s (%s): %w", name, botID, err)
	}
	if addr.Address == "" {
		if remote != "" {
			return Session{}, fmt.Errorf("%s (%s) is live on another machine (%s): an automation runs on the "+
				"computer its scheduler runs on, and never reaches a linked machine's bot", name, botID, remote)
		}
		if err := h.startBot(project, bot); err != nil {
			return Session{}, err
		}
		if addr, err = h.awaitBot(project, bot); err != nil {
			return Session{}, err
		}
	}
	s := Session{PaneID: addr.Address, Target: a.Target, TargetName: name, TargetParent: addr.Address,
		TargetCreatedMS: addr.CreatedMS}
	if kind == config.TargetBot {
		// Busy is answered before the run is recorded as running: a queue
		// hands the prompt over now, a skip drops the occurrence.
		if !a.QueueWhenBusy() {
			if state := h.botState(addr.Address); state == "working" || state == "blocked" {
				return s, fmt.Errorf("%w: %s (%s) was %s, and target_when_busy is skip", ErrTargetBusy, name, botID, state)
			}
		}
		return s, nil
	}
	// The parent is the caller, not the worker this run will own.
	s.PaneID = ""
	dir, err := h.worktree(a)
	if err != nil {
		return s, fmt.Errorf("a worker of %s (%s) needs a worktree: %w", name, botID, err)
	}
	terminal, err := h.startWorker(a, project, bot, dir, addr.Address)
	if err != nil {
		return s, err
	}
	s.PaneID = terminal
	if t, err := h.ops.Get(terminal); err == nil && workerTerminal(t, s, a.Name) {
		s.TerminalID = hcIdentity(t)
		s.WorkspaceID, s.TabID = t.Labels["herdr.space"], t.Labels["herdr.tab"]
	}
	return s, nil
}

// targetDo carries out a target run: a bot receives the prompt through hc
// send, exactly as one bot messages another; a worker waits for its turn and
// is ended here on success. A failure reaches the runner before cleanup.
func (h *hcHost) targetDo(s Session, a config.Automation, timeout time.Duration) error {
	kind, botID, err := config.SplitTarget(a.Target)
	if err != nil {
		return err
	}
	name := s.TargetName
	if name == "" {
		name = botID
	}
	if kind == config.TargetWorker {
		err := h.waitTurn(s, a, timeout)
		if err == nil {
			if err := h.endWorker(s); err != nil {
				log.Printf("could not end the run's worker %s through am worker kill: %v", s.PaneID, err)
			}
		}
		return err
	}
	// Resolution and the send are two steps, and a terminal id can be reused
	// or its agent can quit between them. Read the pane once more immediately
	// before the paste; anything but the resolved terminal refuses the send
	// (#498).
	if err := h.confirmSend(s, name, botID); err != nil {
		return err
	}
	if err := h.ops.Send(s.PaneID, a.Prompt); err != nil {
		return fmt.Errorf("the prompt did not reach %s (%s) at %s: %w", name, botID, s.PaneID, err)
	}
	h.notesMu.Lock()
	if h.notes == nil {
		h.notes = make(map[string]string)
	}
	h.notes[s.PaneID] = "delivered to " + name
	h.notesMu.Unlock()
	return nil
}

// endWorker ends the worker this run started through the pack's checked path:
// `am worker kill`, with the bot's own pane as the caller, so the pack's guard
// confirms this really is that bot's worker and no bot's seat. The finished
// terminal stays, so the run's saved PaneID still names where the worker ran.
func (h *hcHost) endWorker(s Session) error {
	if s.TargetParent == "" {
		return fmt.Errorf("the worker's parent pane is unknown")
	}
	_, err := h.am([]string{"worker", "kill", s.PaneID, "--json"},
		[]string{"HC_TERMINAL_ID=" + s.TargetParent})
	return err
}

// botState is the bot's own word about what it is doing, or "" when it has
// none. A bot that never reported a state (a plain terminal) is not busy.
func (h *hcHost) botState(address string) string {
	t, err := h.ops.Get(address)
	if err != nil || t.Status == nil {
		return ""
	}
	return t.Status.State
}

// liveBot is the bot's running terminal on this computer, if it has one.
// remote names a pane on a linked machine when that is all there is. The
// returned terminal is the one the run's send is confirmed against.
//
// A label is only a hint: this reads each labelled pane and keeps it only when
// `hc get` says it is live, still carries this bot's label, has an agent in
// front (not a shell left after the agent quit), and its folder belongs to this
// project. More than one such pane is refused, never guessed between; a
// duplicate id in another project's roster is not this project's bot.
//
// This resolves by the label, not by the pack's attach ledger: a stale
// `bot=<id>` label on a pane the ledger has moved to another bot can pass here.
// The send re-reads the pane, which catches a change in the window, but it does
// not consult the ledger either (see the ADR's remaining limit).
func (h *hcHost) liveBot(project, id string) (terminal hc.Terminal, remote string, err error) {
	addrs, err := h.ops.Terminals(map[string]string{"bot": id})
	if err != nil {
		return hc.Terminal{}, "", err
	}
	var local []string
	for _, a := range addrs {
		if a == "" {
			continue
		}
		if strings.Contains(a, "/") {
			remote = a
			continue
		}
		local = append(local, a)
	}
	var live []hc.Terminal
	for _, a := range local {
		t, err := h.ops.Get(a)
		if errors.Is(err, hc.ErrNotFound) {
			continue
		}
		if err != nil {
			return hc.Terminal{}, "", fmt.Errorf("reading the pane %s: %w", a, err)
		}
		if t.Address != "" && t.Address != a {
			continue
		}
		if t.State != "live" || t.Labels["bot"] != id {
			continue
		}
		if !agentInForeground(t.Foreground) {
			continue
		}
		ours, err := h.inProject(project, t.Cwd)
		if err != nil {
			return hc.Terminal{}, "", err
		}
		if !ours {
			continue
		}
		live = append(live, t)
	}
	switch len(live) {
	case 0:
		return hc.Terminal{}, remote, nil
	case 1:
		return live[0], "", nil
	default:
		names := make([]string, 0, len(live))
		for _, t := range live {
			names = append(names, t.Address)
		}
		return hc.Terminal{}, "", fmt.Errorf("bot %s has %d live terminals (%s) in %s; inspect them and leave one, "+
			"or remove the duplicate label, before targeting it", id, len(live), strings.Join(names, ", "), project)
	}
}

// confirmSend reads the resolved bot terminal once more, immediately before the
// prompt is pasted, and refuses anything but the terminal resolution chose. A
// terminal id is reused by herdr, and an agent can quit to a shell, in the
// window between resolution, the run record and the send; `hc send` addresses the
// pane and would paste into whatever is there now (#498).
func (h *hcHost) confirmSend(s Session, name, botID string) error {
	t, err := h.ops.Get(s.PaneID)
	if err != nil {
		return fmt.Errorf("the prompt was not sent to %s (%s): cannot read %s again: %w", name, botID, s.PaneID, err)
	}
	if why := paneChanged(s.PaneID, s.TargetCreatedMS, botID, t); why != "" {
		return fmt.Errorf("the prompt was not sent: %s changed between being resolved for %s (%s) and receiving it "+
			"(%s); inspect it (am show %s) and run the automation again", s.PaneID, name, botID, why, botID)
	}
	return nil
}

// paneChanged says what is no longer the terminal resolution chose, or "".
func paneChanged(pane string, createdMS int64, botID string, t hc.Terminal) string {
	var why []string
	if t.Address != "" && t.Address != pane {
		why = append(why, "it answers for "+t.Address)
	}
	if t.State != "live" {
		why = append(why, "it is no longer live")
	}
	if got := t.Labels["bot"]; got != botID {
		if got == "" {
			why = append(why, "its bot label is gone")
		} else {
			why = append(why, fmt.Sprintf("its bot label is now %q", got))
		}
	}
	if !agentInForeground(t.Foreground) {
		why = append(why, "a shell is in front, so the agent quit")
	}
	if createdMS == 0 {
		why = append(why, "it reported no created_ms when it was resolved, so it cannot be told apart from a reused terminal")
	} else if t.CreatedMS != createdMS {
		why = append(why, fmt.Sprintf("it is another terminal now (created_ms %d became %d)", createdMS, t.CreatedMS))
	}
	return strings.Join(why, "; ")
}

// inProject reports whether dir is inside project's own checkout, where the
// nearest .herdr/bots.json at or above it is project's. A folder under another
// project (a different roster, a different checkout) is not ours.
func (h *hcHost) inProject(project, dir string) (bool, error) {
	if dir == "" {
		return false, nil
	}
	project, dir = cleanPath(project), cleanPath(dir)
	if dir == "" || project == "" {
		return false, nil
	}
	for {
		if dir == project {
			return true, nil
		}
		_, err := os.Stat(filepath.Join(dir, ".herdr", "bots.json"))
		switch {
		case err == nil:
			// A roster nearer than the project's owns this folder.
			return false, nil
		case !os.IsNotExist(err):
			return false, fmt.Errorf("%s: %w", filepath.Join(dir, ".herdr", "bots.json"), err)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false, nil
		}
		dir = parent
	}
}

// cleanPath is an absolute, symlink-resolved path when the filesystem can say
// so, else the absolute path it was given.
func cleanPath(path string) string {
	if path == "" {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved
	}
	return filepath.Clean(abs)
}

// agentInForeground reports whether a pane's foreground is a program other
// than a shell: the same rule the pack's launchArgs.js uses, keep wrapper and
// login shell included. A shell in front is a pane whose agent has quit.
func agentInForeground(f *hc.Foreground) bool {
	if f == nil {
		return false
	}
	argv := f.Argv
	if len(argv) >= 5 && shells[baseName(argv[0])] && argv[1] == "-c" && argv[2] == keepWrapper {
		argv = argv[4:]
	}
	if len(argv) == 0 {
		return false
	}
	name := baseName(argv[0])
	return name != "" && !shells[name]
}

// keepWrapper is hc's keep wrapper (hc run --keep): once the program exits it
// execs the pane's shell, so the foreground is a shell again.
const keepWrapper = `"$@"; exec "${SHELL:-sh}" -i`

var shells = map[string]bool{
	"sh": true, "zsh": true, "bash": true, "fish": true, "dash": true,
	"ksh": true, "tcsh": true, "csh": true, "nu": true, "login": true,
}

func baseName(path string) string {
	return strings.TrimPrefix(filepath.Base(path), "-")
}

// startBot starts a stopped bot with the pack's CLI, the same `am start` a
// person runs. The bot's own launch (its template, its permissions) is the
// pack's business.
func (h *hcHost) startBot(project string, bot *rosterBot) error {
	if _, err := h.am([]string{"start", bot.ID, "--project", project}, nil); err != nil {
		return fmt.Errorf("starting %s (%s): %w", bot.Name, bot.ID, err)
	}
	return nil
}

// awaitBot waits for the started bot's terminal to appear. A start that says
// it worked but leaves no terminal labelled with the bot is a failure, never a
// fallback to a fresh session.
func (h *hcHost) awaitBot(project string, bot *rosterBot) (hc.Terminal, error) {
	deadline := time.Now().Add(h.knobs.paneReady)
	for {
		found, remote, err := h.liveBot(project, bot.ID)
		if err != nil {
			return hc.Terminal{}, fmt.Errorf("looking for %s (%s) after starting it: %w", bot.Name, bot.ID, err)
		}
		if found.Address != "" {
			return found, nil
		}
		if remote != "" {
			return hc.Terminal{}, fmt.Errorf("%s (%s) is live on another machine (%s): an automation never reaches a "+
				"linked machine's bot", bot.Name, bot.ID, remote)
		}
		if time.Now().After(deadline) {
			return hc.Terminal{}, fmt.Errorf("%s (%s) was started but no terminal labelled bot=%s appeared within %s; "+
				"check it with am show %s", bot.Name, bot.ID, bot.ID, h.knobs.paneReady, bot.ID)
		}
		time.Sleep(h.knobs.targetPoll)
	}
}

// startWorker starts a worker of the bot in dir and returns its terminal. It
// runs the pack's `am worker` with the bot's own pane as the caller, so the
// worker is nested under the bot and uses the bot's worker launch words; the
// task is the automation's prompt.
func (h *hcHost) startWorker(a config.Automation, project string, bot *rosterBot, dir, parent string) (string, error) {
	args := []string{"worker", a.Prompt, "--worktree", dir, "--project", project, "--json"}
	out, err := h.am(args, []string{"HC_TERMINAL_ID=" + parent})
	if err != nil {
		return "", fmt.Errorf("starting a worker of %s (%s): %w", bot.Name, bot.ID, err)
	}
	var res struct {
		Terminal string   `json:"terminal"`
		Warnings []string `json:"warnings"`
	}
	if json.Unmarshal([]byte(out), &res) != nil || res.Terminal == "" {
		return "", fmt.Errorf("starting a worker of %s (%s): am worker gave no terminal (%s)",
			bot.Name, bot.ID, oneLine(out))
	}
	for _, warning := range res.Warnings {
		log.Printf("%s: %s", a.Name, warning)
	}
	return res.Terminal, nil
}

// projectOf walks up from repo to the project that owns it: the nearest
// .herdr/bots.json above it (a worktree's project is its main checkout, which
// is where the file is). The project on a linked machine has its file there,
// not here, and so is never found.
func (h *hcHost) projectOf(repo string) (string, *botRoster, error) {
	dir, err := filepath.Abs(repo)
	if err != nil {
		return "", nil, err
	}
	for {
		path := filepath.Join(dir, ".herdr", "bots.json")
		raw, err := h.readRoster(path)
		switch {
		case err == nil:
			var roster botRoster
			if err := json.Unmarshal(raw, &roster); err != nil {
				return "", nil, fmt.Errorf("%s: %w", path, err)
			}
			if roster.Version != 1 {
				return "", nil, fmt.Errorf("%s: version %d, expected 1", path, roster.Version)
			}
			return dir, &roster, nil
		case !os.IsNotExist(err):
			return "", nil, fmt.Errorf("%s: %w", path, err)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", nil, fmt.Errorf("%s names no project above it with .herdr/bots.json: a target reads the "+
				"bot from its project's roster (a bot on a linked machine is not a target here)", repo)
		}
		dir = parent
	}
}

// readRoster reads a bots file; nil is the real filesystem, and the tests set
// their own so no case reads a project's real roster.
func (h *hcHost) readRoster(path string) ([]byte, error) {
	if h.roster != nil {
		return h.roster(path)
	}
	return os.ReadFile(path)
}

// amTimeout bounds one am call. A start can be slow (git worktree, hc run,
// a bot's own launch); it must not hold a run's in-flight slot forever.
const amTimeout = 5 * time.Minute

// am runs the pack's CLI (`am`): a bot start, or a worker start. A test sets
// amFn to stand in for it.
func (h *hcHost) am(args, extraEnv []string) (string, error) {
	if h.amFn != nil {
		return h.amFn(args, extraEnv)
	}
	ctx, cancel := context.WithTimeout(context.Background(), amTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, hostpath.AmBin(), args...)
	// The pack's hc must reach herdr-core itself, not a sandbox proxy the
	// scheduler may have been started under: the bot is named by the env only.
	cmd.Env = append(withoutEnv(os.Environ(), "HC_SOCKET", "HC_TERMINAL_ID"), extraEnv...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := oneLine(stderr.String())
		if msg == "" {
			msg = oneLine(stdout.String())
		}
		if msg == "" && ctx.Err() != nil {
			msg = fmt.Sprintf("no answer within %s", amTimeout)
		}
		if msg == "" {
			msg = err.Error()
		}
		return stdout.String(), errors.New(msg)
	}
	return stdout.String(), nil
}

// withoutEnv removes environment entries by name, so an added value wins.
func withoutEnv(env []string, names ...string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		drop := false
		for _, n := range names {
			if name == n {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, kv)
		}
	}
	return out
}

// oneLine is the last non-empty line of a program's output: the line a person
// needs, without the arguments dumped above it.
func oneLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return ""
}
