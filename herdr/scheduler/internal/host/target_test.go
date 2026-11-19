package host

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/hc"
)

const targetRoster = `{"version":1,"bots":[{"id":"b-6jrz4bmxml","name":"Housekeeper"}]}`

func targetAutomation(target string) config.Automation {
	return config.Automation{
		Name: "housekeeping", Repo: "/src/project", Target: target,
		Prompt: "tidy the house", TimeoutMinutes: 60,
	}
}

// targetHost reads the fixture roster and knows the project keeps it.
func targetHost(f *fakeHC) *hcHost {
	h := newHCTest(f)
	h.knobs.targetPoll = time.Millisecond
	h.roster = func(path string) ([]byte, error) {
		if path == "/src/project/.herdr/bots.json" {
			return []byte(targetRoster), nil
		}
		return nil, os.ErrNotExist
	}
	return h
}

func botStatus(state string) *struct {
	State string `json:"state"`
} {
	return &struct {
		State string `json:"state"`
	}{State: state}
}

// A bot target hands the prompt to the bot's own live terminal, never to a
// fresh agent, and never kills the bot when the run is done (#498).
func TestBotTargetSendsToTheBotsOwnTerminal(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7"}, term: hc.Terminal{Status: botStatus("idle")}}
	h := targetHost(f)
	a := targetAutomation("bot:b-6jrz4bmxml")
	s, err := h.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	if s.PaneID != "t7" || s.Target != a.Target || s.TargetName != "Housekeeper" {
		t.Fatalf("session %+v", s)
	}
	if f.termLabels["bot"] != "b-6jrz4bmxml" {
		t.Fatalf("looked for labels %v", f.termLabels)
	}
	if err := h.Do(s, a, time.Minute); err != nil {
		t.Fatal(err)
	}
	if len(f.sent) != 1 || f.sent[0] != "tidy the house" {
		t.Fatalf("sent %v", f.sent)
	}
	if note := h.Note(s); note != "delivered to Housekeeper" {
		t.Fatalf("note %q", note)
	}
	if err := h.Close(s, a); err != nil {
		t.Fatal(err)
	}
	for _, call := range f.calls {
		if strings.HasPrefix(call, "kill") {
			t.Fatalf("a bot target killed its bot: %v", f.calls)
		}
	}
}

// A stopped bot is started with the pack's CLI and waited for; a start that
// leaves no terminal labelled with the bot fails the run, never falls back to
// a fresh session.
func TestBotTargetStartsAStoppedBot(t *testing.T) {
	f := &fakeHC{termSeq: [][]string{{}, {}, {"t7"}}, term: hc.Terminal{Status: botStatus("idle")}}
	h := targetHost(f)
	var calls []string
	h.amFn = func(args, _ []string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		return "", nil
	}
	s, err := h.Provision(targetAutomation("bot:b-6jrz4bmxml"))
	if err != nil {
		t.Fatal(err)
	}
	if s.PaneID != "t7" {
		t.Fatalf("session %+v", s)
	}
	if len(calls) != 1 || calls[0] != "start b-6jrz4bmxml --project /src/project" {
		t.Fatalf("am calls %v", calls)
	}
}

func TestBotTargetStartedButNeverAppeared(t *testing.T) {
	f := &fakeHC{terminals: nil}
	h := targetHost(f)
	h.knobs.paneReady = 5 * time.Millisecond
	h.amFn = func([]string, []string) (string, error) { return "", nil }
	_, err := h.Provision(targetAutomation("bot:b-6jrz4bmxml"))
	if err == nil || !strings.Contains(err.Error(), "no terminal labelled bot=b-6jrz4bmxml appeared") {
		t.Fatalf("err %v", err)
	}
}

// Gone or renamed: the id is the contract. A bot this project's roster no
// longer names is a clear failure, not a fresh agent under the old name.
func TestBotTargetGoneFromTheRoster(t *testing.T) {
	f := &fakeHC{}
	h := targetHost(f)
	h.roster = func(string) ([]byte, error) {
		return []byte(`{"version":1,"bots":[{"id":"b-aaaaaaaaaa","name":"Someone else"}]}`), nil
	}
	_, err := h.Provision(targetAutomation("bot:b-6jrz4bmxml"))
	if err == nil || !strings.Contains(err.Error(), "b-6jrz4bmxml isn't defined in /src/project/.herdr/bots.json") {
		t.Fatalf("err %v", err)
	}
}

// A candidate on another machine is never reached: the roster is here, the
// bot's pane is there, and the run says so.
func TestBotTargetOnAnotherMachine(t *testing.T) {
	f := &fakeHC{terminals: []string{"build-box/t7"}}
	h := targetHost(f)
	_, err := h.Provision(targetAutomation("bot:b-6jrz4bmxml"))
	if err == nil || !strings.Contains(err.Error(), "live on another machine (build-box/t7)") {
		t.Fatalf("err %v", err)
	}
}

func TestTargetNeedsAProjectRoster(t *testing.T) {
	f := &fakeHC{}
	h := targetHost(f)
	h.roster = func(string) ([]byte, error) { return nil, os.ErrNotExist }
	_, err := h.Provision(targetAutomation("bot:b-6jrz4bmxml"))
	if err == nil || !strings.Contains(err.Error(), "no project above it with .herdr/bots.json") {
		t.Fatalf("err %v", err)
	}
}

func TestTargetRefusesAPlannedBot(t *testing.T) {
	f := &fakeHC{}
	h := targetHost(f)
	h.roster = func(string) ([]byte, error) {
		return []byte(`{"version":1,"bots":[{"id":"b-6jrz4bmxml","name":"Housekeeper","planned":{"wave":3}}]}`), nil
	}
	_, err := h.Provision(targetAutomation("bot:b-6jrz4bmxml"))
	if err == nil || !strings.Contains(err.Error(), "is planned and starts no runs") {
		t.Fatalf("err %v", err)
	}
}

// Busy is configurable: skip drops the occurrence (a skip, not a failure),
// queue still hands the prompt over for the bot's next turn.
func TestBotTargetBusySkipAndQueue(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7"}, term: hc.Terminal{Status: botStatus("working")}}
	h := targetHost(f)
	a := targetAutomation("bot:b-6jrz4bmxml")
	a.TargetWhenBusy = config.TargetSkip
	if _, err := h.Provision(a); !errors.Is(err, ErrTargetBusy) {
		t.Fatalf("err %v, want ErrTargetBusy", err)
	} else if !strings.Contains(err.Error(), "was working, and target_when_busy is skip") {
		t.Fatalf("err %v", err)
	}
	a.TargetWhenBusy = config.TargetQueue
	s, err := h.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Do(s, a, time.Minute); err != nil {
		t.Fatal(err)
	}
	if len(f.sent) != 1 {
		t.Fatalf("a queued prompt was not sent: %v", f.sent)
	}
}

// A worker target starts the pack's worker under the bot with the automation's
// worktree and prompt, then ends it when the run's turn is over (#498).
func TestWorkerTargetStartsAndEndsAWorker(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7"}}
	h := targetHost(f)
	var got []string
	var env []string
	h.amFn = func(args, extraEnv []string) (string, error) {
		if args[0] != "worker" {
			t.Fatalf("am %v", args)
		}
		got, env = args, extraEnv
		return `{"terminal":"t9","warnings":["a warning"]}`, nil
	}
	f.waits = []hc.Wait{{Ended: true, Reason: "status", Status: "done"}}
	a := targetAutomation("worker:b-6jrz4bmxml")
	s, err := h.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	if s.PaneID != "t9" || s.Target != a.Target || s.TargetName != "Housekeeper" {
		t.Fatalf("session %+v", s)
	}
	repo, branch, path := f.worktree[0], f.worktree[1], f.worktree[2]
	if repo != "/src/project" || !strings.HasPrefix(branch, "auto/housekeeping-") {
		t.Fatalf("worktree %q %q", repo, branch)
	}
	want := []string{"worker", "tidy the house", "--worktree", path, "--project", "/src/project", "--json"}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("am worker %v", got)
	}
	if len(env) != 1 || env[0] != "HC_TERMINAL_ID=t7" {
		t.Fatalf("env %v", env)
	}
	if err := h.Do(s, a, time.Minute); err != nil {
		t.Fatal(err)
	}
	var killed, removed bool
	for _, call := range f.calls {
		killed = killed || call == "kill t9"
		removed = removed || call == "rm t9"
	}
	if !killed || !removed {
		t.Fatalf("the run's worker was not ended: %v", f.calls)
	}
	if err := h.Close(s, a); err != nil {
		t.Fatal(err)
	}
}

// A failing worker run still ends its worker: nothing is left running.
func TestWorkerTargetEndsItsWorkerOnFailure(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7"}}
	h := targetHost(f)
	h.amFn = func([]string, []string) (string, error) { return `{"terminal":"t9"}`, nil }
	f.waits = []hc.Wait{{Ended: true, Reason: "status", Status: "error"}}
	if _, err := h.Provision(targetAutomation("worker:b-6jrz4bmxml")); err != nil {
		t.Fatal(err)
	}
	s := Session{PaneID: "t9", Target: "worker:b-6jrz4bmxml", TargetName: "Housekeeper"}
	if err := h.Do(s, targetAutomation("worker:b-6jrz4bmxml"), time.Minute); err == nil {
		t.Fatal("an agent error was recorded as done")
	}
	if !strings.Contains(strings.Join(f.calls, " "), "kill t9") {
		t.Fatalf("calls %v", f.calls)
	}
}

func TestWorkerTargetStartFailureIsClear(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7"}}
	h := targetHost(f)
	h.amFn = func([]string, []string) (string, error) {
		return "", errors.New("Only a bot starts workers, from its own pane")
	}
	_, err := h.Provision(targetAutomation("worker:b-6jrz4bmxml"))
	if err == nil || !strings.Contains(err.Error(), "starting a worker of Housekeeper (b-6jrz4bmxml)") ||
		!strings.Contains(err.Error(), "Only a bot starts workers") {
		t.Fatalf("err %v", err)
	}
}

// What a person sees when the target cannot be reached: the bot's name, its
// id and the terminal, then the reason.
func TestBotTargetSendFailureIsClear(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7"}, sendErr: errors.New("terminal is blocked on a dialog")}
	h := targetHost(f)
	a := targetAutomation("bot:b-6jrz4bmxml")
	s, err := h.Provision(a)
	if err != nil {
		t.Fatal(err)
	}
	err = h.Do(s, a, time.Minute)
	if err == nil || !strings.Contains(err.Error(), "the prompt did not reach Housekeeper (b-6jrz4bmxml) at t7") {
		t.Fatalf("err %v", err)
	}
}

// The roster is read from the project above a repo subfolder, and a broken
// one is a diagnostic, never a silent fresh session.
func TestTargetRosterWalksUpAndRefusesBadJSON(t *testing.T) {
	f := &fakeHC{terminals: []string{"t7"}}
	h := targetHost(f)
	h.roster = func(path string) ([]byte, error) {
		if path == "/src/project/.herdr/bots.json" {
			return []byte(targetRoster), nil
		}
		return nil, os.ErrNotExist
	}
	a := targetAutomation("bot:b-6jrz4bmxml")
	a.Repo = "/src/project/sub"
	if _, err := h.Provision(a); err != nil {
		t.Fatalf("a repo subfolder did not find its project: %v", err)
	}
	h.roster = func(string) ([]byte, error) { return []byte("{not json"), nil }
	_, err := h.Provision(a)
	if err == nil || !strings.Contains(err.Error(), ".herdr/bots.json") {
		t.Fatalf("err %v", err)
	}
}
