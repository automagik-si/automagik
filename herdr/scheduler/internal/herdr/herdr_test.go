package herdr

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNewAPIErrorPrefersHerdrsOwnCode(t *testing.T) {
	body := []byte(`{"error":{"code":"agent_pane_busy","message":"pane w1T:p1 is not an available shell"},"id":"cli:agent:start"}`)
	err := newAPIError([]string{"agent", "start", "triage"}, body, "", errors.New("exit status 1"))

	if !HasCode(err, CodePaneBusy) {
		t.Fatalf("code not recovered from %v", err)
	}
	want := "agent start: agent_pane_busy: pane w1T:p1 is not an available shell"
	if err.Error() != want {
		t.Errorf("got %q, want %q", err.Error(), want)
	}
}

func TestNewAPIErrorReadsTheCodeFromStderr(t *testing.T) {
	// herdr 0.8.0 writes the error envelope to stderr, not stdout.
	stderr := `{"error":{"code":"agent_pane_busy","message":"agent target pane w3V:p1 is not an available shell"},"id":"cli:agent:start"}` + "\n"
	err := newAPIError([]string{"agent", "start", "triage"}, nil, stderr, errors.New("exit status 1"))

	if !HasCode(err, CodePaneBusy) {
		t.Fatalf("code not recovered from %v", err)
	}
	want := "agent start: agent_pane_busy: agent target pane w3V:p1 is not an available shell"
	if err.Error() != want {
		t.Errorf("got %q, want %q", err.Error(), want)
	}
}

func TestNewAPIErrorFallsBackToTheExecError(t *testing.T) {
	// The failure that made a run undiagnosable: herdr exits non-zero and
	// prints nothing, so the only thing left to report is why the process died.
	err := newAPIError([]string{"worktree", "create"}, nil, "", errors.New("exit status 1"))

	want := "worktree create: exit status 1"
	if err.Error() != want {
		t.Fatalf("got %q, want %q", err.Error(), want)
	}
}

func TestNewAPIErrorKeepsStderrOverTheExecError(t *testing.T) {
	// "exit status 1" says less than whatever herdr wrote, so it loses.
	err := newAPIError([]string{"worktree", "create"}, nil,
		"  fatal: not a git repository\n", errors.New("exit status 128"))

	want := "worktree create: fatal: not a git repository"
	if err.Error() != want {
		t.Fatalf("got %q, want %q", err.Error(), want)
	}
}

func TestNewAPIErrorSurvivesANilExecError(t *testing.T) {
	if err := newAPIError([]string{"pane", "read"}, nil, "", nil); err == nil {
		t.Fatal("want an error even with nothing to say")
	}
}

func TestNotificationArgsOmitsAnEmptyBody(t *testing.T) {
	got := notificationArgs("triage failed", "", SoundRequest)
	for _, a := range got {
		if a == "--body" {
			t.Fatalf("args = %v, want no --body flag for an empty body", got)
		}
	}
}

func TestNotificationArgsPassesTheTitleAsAPositionalArgument(t *testing.T) {
	got := notificationArgs("triage failed", "boom", SoundRequest)
	want := []string{"notification", "show", "triage failed",
		"--body", "boom", "--position", notificationPosition, "--sound", "request"}
	if len(got) != len(want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("args = %v, want %v", got, want)
		}
	}
}

func TestTabCreate(t *testing.T) {
	for _, tc := range []struct {
		name, response, tab, pane string
		wantError                 bool
	}{
		{"created", `{"result":{"type":"tab_created","tab":{"tab_id":"tb7"},"root_pane":{"pane_id":"w7:p2"}}}`, "tb7", "w7:p2", false},
		// An older Herdr leaves the tab id out: the run can still open, and
		// close_workspace then has nothing safe to close.
		{"missing tab id", `{"result":{"type":"tab_created","root_pane":{"pane_id":"w7:p2"}}}`, "", "w7:p2", false},
		{"missing pane", `{"result":{"type":"tab_created"}}`, "", "", true},
		{"invalid response", `not json`, "", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			bin := filepath.Join(dir, "herdr")
			argsFile := filepath.Join(dir, "args")
			script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HERDR_TEST_ARGS\"\nprintf '%s\\n' \"$HERDR_TEST_RESPONSE\"\n"
			if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("HERDR_BIN_PATH", bin)
			t.Setenv("HERDR_TEST_ARGS", argsFile)
			t.Setenv("HERDR_TEST_RESPONSE", tc.response)
			tab, pane, err := (Client{}).TabCreate("w7", "/a repo", "auto: daily summary")
			if (err != nil) != tc.wantError || tab != tc.tab || pane != tc.pane {
				t.Fatalf("tab=%q pane=%q err=%v", tab, pane, err)
			}
			raw, err := os.ReadFile(argsFile)
			if err != nil {
				t.Fatal(err)
			}
			got := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
			want := []string{"tab", "create", "--workspace", "w7", "--cwd", "/a repo", "--label", "auto: daily summary", "--no-focus"}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("args=%q, want %q", got, want)
			}
		})
	}
}

func TestPaneProcessInfo(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "herdr")
	argsFile := filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HERDR_TEST_ARGS\"\nprintf '%s\\n' '{\"result\":{\"process_info\":{\"shell_pid\":200,\"foreground_process_group_id\":300}}}'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN_PATH", bin)
	t.Setenv("HERDR_TEST_ARGS", argsFile)
	info, err := (Client{Session: "auto"}).PaneProcessInfo("w7:p2")
	if err != nil || info.ShellPID != 200 || info.ForegroundGroup != 300 {
		t.Fatalf("info=%+v err=%v", info, err)
	}
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Fields(string(raw)); !reflect.DeepEqual(got, []string{"--session", "auto", "pane", "process-info", "--pane", "w7:p2"}) {
		t.Fatalf("args=%v", got)
	}
}

func TestTabClose(t *testing.T) {
	args := fakeHerdr(t, `{"result":{}}`)
	if err := (Client{}).TabClose("tb7"); err != nil {
		t.Fatal(err)
	}
	if got, want := readArgs(t, args), []string{"tab", "close", "tb7"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args=%q, want %q", got, want)
	}
}

func TestTabList(t *testing.T) {
	args := fakeHerdr(t, `{"result":{"type":"tab_list","tabs":[{"tab_id":"tb1"},{"tab_id":"tb2"}]}}`)
	tabs, err := (Client{}).TabList("w7")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(tabs, "|"), "tb1|tb2"; got != want {
		t.Fatalf("tabs=%q, want %q", got, want)
	}
	if got, want := readArgs(t, args), []string{"tab", "list", "--workspace", "w7"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args=%q, want %q", got, want)
	}
}

func TestTerminalCleanupCommands(t *testing.T) {
	const pane = `{"pane_id":"w7:p2","terminal_id":"t8","workspace_id":"w7","tab_id":"tb7"}`
	wantPane := PaneInfo{PaneID: "w7:p2", TerminalID: "t8", WorkspaceID: "w7", TabID: "tb7"}
	for _, tc := range []struct {
		name, response string
		argv           []string
		call           func(Client) (any, error)
		want           any
	}{
		{
			"pane get", `{"result":{"pane":` + pane + `}}`, []string{"pane", "get", "w7:p2"},
			func(c Client) (any, error) { return c.PaneGet("w7:p2") }, wantPane,
		},
		{
			"pane list", `{"result":{"panes":[` + pane + `]}}`, []string{"pane", "list"},
			func(c Client) (any, error) { return c.PaneList() }, []PaneInfo{wantPane},
		},
		{
			"tab get", `{"result":{"tab":{"tab_id":"tb7","label":"auto: daily"}}}`,
			[]string{"tab", "get", "tb7"},
			func(c Client) (any, error) { return c.TabLabel("tb7") }, "auto: daily",
		},
		{
			"workspace get", `{"result":{"workspace":{"workspace_id":"w7","label":"auto: daily"}}}`,
			[]string{"workspace", "get", "w7"},
			func(c Client) (any, error) { return c.WorkspaceLabel("w7") }, "auto: daily",
		},
		{
			"pane close", `{"result":{}}`, []string{"pane", "close", "w7:p2"},
			func(c Client) (any, error) { return nil, c.PaneClose("w7:p2") }, nil,
		},
		{
			"pane split", `{"result":{"pane":` + pane + `}}`,
			[]string{"pane", "split", "w7:p2", "--no-focus"},
			func(c Client) (any, error) { return nil, c.PaneSplit("w7:p2") }, nil,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := fakeHerdr(t, tc.response)
			got, err := tc.call(Client{Session: "automations"})
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("result = %+v, %v, want %+v", got, err, tc.want)
			}
			wantArgs := append([]string{"--session", "automations"}, tc.argv...)
			if gotArgs := readArgs(t, args); !reflect.DeepEqual(gotArgs, wantArgs) {
				t.Fatalf("args = %q, want %q", gotArgs, wantArgs)
			}
		})
	}
}

// fakeHerdr installs a herdr that records its argv and prints response.
func fakeHerdr(t *testing.T, response string) (argsFile string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "herdr")
	argsFile = filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HERDR_TEST_ARGS\"\nprintf '%s\\n' \"$HERDR_TEST_RESPONSE\"\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN_PATH", bin)
	t.Setenv("HERDR_TEST_ARGS", argsFile)
	t.Setenv("HERDR_TEST_RESPONSE", response)
	return argsFile
}

func readArgs(t *testing.T, argsFile string) []string {
	t.Helper()
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
}

func TestAClientBoundToASessionTargetsItOnEveryCall(t *testing.T) {
	args := fakeHerdr(t, `{"result":{"tab":{"tab_id":"tb1"},"root_pane":{"pane_id":"w7:p2"}}}`)
	if _, _, err := (Client{Session: "automations"}).TabCreate("w7", "/r", "l"); err != nil {
		t.Fatal(err)
	}
	got := readArgs(t, args)
	if len(got) < 3 || got[0] != "--session" || got[1] != "automations" || got[2] != "tab" {
		t.Fatalf("args = %q, want --session automations ahead of the subcommand", got)
	}
}

const twoSessions = `{"sessions":[
 {"default":true,"name":"default","running":true,"socket_path":"/h/.config/herdr/herdr.sock"},
 {"default":false,"name":"automations","running":true,"socket_path":"/h/.config/herdr/sessions/automations/herdr.sock"},
 {"default":false,"name":"old","running":false,"socket_path":"/h/.config/herdr/sessions/old/herdr.sock"}]}`

func TestRunningSessionsLeavesOutTheStoppedOnes(t *testing.T) {
	args := fakeHerdr(t, twoSessions)
	got, err := (Client{Session: "ignored"}).RunningSessions()
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"default", "automations"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sessions = %q, want %q", got, want)
	}
	// Listing sessions is about the machine, not about one of them.
	if a := readArgs(t, args); a[0] != "session" {
		t.Fatalf("args = %q, want no --session on session list", a)
	}
}

func TestCurrentSessionIsTheOneWhoseSocketThisProcessUses(t *testing.T) {
	fakeHerdr(t, twoSessions)
	t.Setenv("HERDR_SESSION", "")
	t.Setenv("HERDR_SOCKET_PATH", "/h/.config/herdr/sessions/automations/herdr.sock")
	if got := (Client{}).CurrentSession(); got != "automations" {
		t.Fatalf("current = %q, want automations", got)
	}
}

func TestCurrentSessionOutsideHerdrIsTheDefaultOne(t *testing.T) {
	// herdr's CLI talks to the default session when nothing says otherwise.
	fakeHerdr(t, twoSessions)
	t.Setenv("HERDR_SESSION", "")
	t.Setenv("HERDR_SOCKET_PATH", "")
	if got := (Client{}).CurrentSession(); got != "default" {
		t.Fatalf("current = %q, want default", got)
	}
}

func TestCurrentSessionOfABoundClientIsItsOwn(t *testing.T) {
	if got := (Client{Session: "automations"}).CurrentSession(); got != "automations" {
		t.Fatalf("current = %q, want automations", got)
	}
}

func TestAnErrorFromABoundClientIsLabelledByTheCommandNotTheSession(t *testing.T) {
	err := newAPIError([]string{"--session", "b", "agent", "start", "x"}, nil,
		`{"error":{"code":"agent_not_ready","message":"m"}}`, errors.New("exit status 1"))
	if want := "agent start: agent_not_ready: m"; err.Error() != want {
		t.Fatalf("got %q, want %q", err.Error(), want)
	}
}
