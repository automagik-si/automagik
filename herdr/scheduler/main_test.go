package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// put is the wire path the panel writes an automation through (JSON on stdin, config.Put behind
// it): these cases run putCmd itself, so close_workspace has to survive the JSON-to-config mapping
// and the merge rules the form relies on.
func runPut(t *testing.T, config, body string, args ...string) (answer, after string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", dir)
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	path := filepath.Join(dir, "automations.yaml")
	if err := os.WriteFile(path, []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	stdin, err := os.CreateTemp(t.TempDir(), "stdin-")
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if _, err := stdin.WriteString(body); err != nil {
		t.Fatal(err)
	}
	if _, err := stdin.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldIn, oldOut := os.Stdin, os.Stdout
	os.Stdin, os.Stdout = stdin, writer
	runErr := putCmd(args)
	writer.Close()
	os.Stdin, os.Stdout = oldIn, oldOut
	out, err := io.ReadAll(reader)
	reader.Close()
	if runErr != nil {
		t.Fatalf("put: %v", runErr)
	}
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(out), string(raw)
}

const putBase = `automations:
  - name: triage
    cron: "0 9 * * 1-5"
    repo: /x
    prompt: p
`

func TestPutCarriesCloseWorkspace(t *testing.T) {
	t.Run("writes on-success", func(t *testing.T) {
		answer, after := runPut(t, putBase, `{"name":"triage","cron":"0 9 * * 1-5","repo":"/x","prompt":"p","close_workspace":"on-success"}`, "--original", "triage")
		if strings.Contains(answer, `"problem"`) {
			t.Fatalf("put refused it: %s", answer)
		}
		if !strings.Contains(after, "close_workspace: on-success") {
			t.Fatalf("close_workspace not written:\n%s", after)
		}
	})

	t.Run("keeps a hand-written value when the key is not sent", func(t *testing.T) {
		_, after := runPut(t, putBase+"    close_workspace: on-success\n", `{"name":"triage","cron":"0 9 * * 1-5","repo":"/x","prompt":"p"}`, "--original", "triage")
		if !strings.Contains(after, "close_workspace: on-success") {
			t.Fatalf("hand-written close_workspace lost:\n%s", after)
		}
	})

	t.Run("removes the key when sent empty", func(t *testing.T) {
		_, after := runPut(t, putBase+"    close_workspace: on-success\n", `{"name":"triage","cron":"0 9 * * 1-5","repo":"/x","prompt":"p","close_workspace":""}`, "--original", "triage")
		if strings.Contains(after, "close_workspace") {
			t.Fatalf("an empty close_workspace left the key:\n%s", after)
		}
	})

	t.Run("accepts on-success with an existing workspace", func(t *testing.T) {
		shared := putBase + "    workspace: existing\n    workspace_id: w7\n"
		answer, after := runPut(t, shared, `{"name":"triage","cron":"0 9 * * 1-5","repo":"/x","prompt":"p","workspace":"existing","workspace_id":"w7","close_workspace":"on-success"}`, "--original", "triage")
		if strings.Contains(answer, `"problem"`) {
			t.Fatalf("put refused it: %s", answer)
		}
		if !strings.Contains(after, "close_workspace: on-success") {
			t.Fatalf("close_workspace not written:\n%s", after)
		}
	})
}

// blocked_grace_minutes is one of the keys a put that does not send it must
// leave alone; sending 0 removes it and reads as the default.
func TestPutCarriesBlockedGrace(t *testing.T) {
	with := putBase + "    blocked_grace_minutes: 7\n"

	t.Run("writes it", func(t *testing.T) {
		answer, after := runPut(t, putBase, `{"name":"triage","cron":"0 9 * * 1-5","repo":"/x","prompt":"p","blocked_grace_minutes":5}`, "--original", "triage")
		if strings.Contains(answer, `"problem"`) {
			t.Fatalf("put refused it: %s", answer)
		}
		if !strings.Contains(after, "blocked_grace_minutes: 5") {
			t.Fatalf("blocked_grace_minutes not written:\n%s", after)
		}
	})

	t.Run("keeps a hand-written value when the key is not sent", func(t *testing.T) {
		_, after := runPut(t, with, `{"name":"triage","cron":"0 9 * * 1-5","repo":"/x","prompt":"p"}`, "--original", "triage")
		if !strings.Contains(after, "blocked_grace_minutes: 7") {
			t.Fatalf("hand-written blocked_grace_minutes lost:\n%s", after)
		}
	})

	t.Run("removes the key when sent zero", func(t *testing.T) {
		_, after := runPut(t, with, `{"name":"triage","cron":"0 9 * * 1-5","repo":"/x","prompt":"p","blocked_grace_minutes":0}`, "--original", "triage")
		if strings.Contains(after, "blocked_grace_minutes") {
			t.Fatalf("a zero blocked_grace_minutes left the key:\n%s", after)
		}
	})
}

// #938: a new automation written with put and no agent_args gets the form's
// automatic mode. The fixture's form side is held to the real form by the
// panel's own test (herdr/test/am-automations-panel.test.mjs); here the real
// put must write the same file for both.
func TestPutAndAFormSaveWriteTheSameFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "test", "fixtures", "automation-put-parity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Agent string          `json:"agent"`
			Put   json.RawMessage `json:"put"`
			Form  json.RawMessage `json:"form"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("the fixture has no cases")
	}
	flags := map[string]string{
		"codex":  "--dangerously-bypass-approvals-and-sandbox",
		"claude": "--dangerously-skip-permissions",
	}
	for _, c := range fixture.Cases {
		t.Run(c.Agent, func(t *testing.T) {
			var form struct {
				AgentArgs *[]string `json:"agent_args"`
			}
			var put map[string]json.RawMessage
			if json.Unmarshal(c.Form, &form) != nil || json.Unmarshal(c.Put, &put) != nil {
				t.Fatal("unreadable case")
			}
			if _, sent := put["agent_args"]; sent || form.AgentArgs == nil {
				t.Fatal("the put side must send no agent_args and the form side must")
			}
			answer, fromPut := runPut(t, "", string(c.Put))
			if strings.Contains(answer, `"problem"`) {
				t.Fatalf("put refused it: %s", answer)
			}
			answer, fromForm := runPut(t, "", string(c.Form))
			if strings.Contains(answer, `"problem"`) {
				t.Fatalf("put refused the form's: %s", answer)
			}
			if fromPut != fromForm {
				t.Fatalf("put wrote\n%s\nthe form wrote\n%s", fromPut, fromForm)
			}
			if flag, auto := flags[c.Agent]; auto && !strings.Contains(fromPut, flag) {
				t.Fatalf("no %s in\n%s", flag, fromPut)
			} else if !auto && strings.Contains(fromPut, "agent_args") {
				t.Fatalf("%s has no automatic mode, yet agent_args was written:\n%s", c.Agent, fromPut)
			}
		})
	}
}

func TestPutDefaultAgentArgs(t *testing.T) {
	const bare = `{"name":"job","cron":"0 9 * * 1-5","repo":"/x","prompt":"p"`
	const codexAuto = "--dangerously-bypass-approvals-and-sandbox"

	t.Run("no agent named is claude", func(t *testing.T) {
		_, after := runPut(t, "", bare+`}`)
		if !strings.Contains(after, "--dangerously-skip-permissions") {
			t.Fatalf("the default agent's automatic flag is missing:\n%s", after)
		}
	})

	t.Run("sent args stand as written", func(t *testing.T) {
		_, after := runPut(t, "", bare+`,"agent":"codex","agent_args":["--sandbox","workspace-write"]}`)
		if strings.Contains(after, codexAuto) || !strings.Contains(after, "workspace-write") {
			t.Fatalf("hand-written agent_args were not kept as sent:\n%s", after)
		}
	})

	t.Run("sent empty stays the agent's own default", func(t *testing.T) {
		_, after := runPut(t, "", bare+`,"agent":"codex","agent_args":[]}`)
		if strings.Contains(after, "agent_args") {
			t.Fatalf("an explicit empty agent_args was filled in:\n%s", after)
		}
	})

	t.Run("a template brings its own", func(t *testing.T) {
		_, after := runPut(t, "backend: hc\n", `{"name":"job","cron":"0 9 * * 1-5","repo":"/x","prompt":"p","template":"reviewer"}`)
		if strings.Contains(after, "agent_args") {
			t.Fatalf("a template run was given flags:\n%s", after)
		}
	})

	t.Run("a workflow has no agent", func(t *testing.T) {
		_, after := runPut(t, "", `{"name":"job","cron":"0 9 * * 1-5","repo":"/x","workflow":"nightly"}`)
		if strings.Contains(after, "agent_args") {
			t.Fatalf("a workflow run was given flags:\n%s", after)
		}
	})

	t.Run("a dry run answers and writes nothing", func(t *testing.T) {
		answer, after := runPut(t, "", bare+`,"agent":"codex"}`, "--dry-run")
		if strings.Contains(answer, `"problem"`) || after != "" {
			t.Fatalf("answer %s, file %q", answer, after)
		}
	})

	// An edit keeps the entry's own args (v0.12.0), and an entry that has none
	// is not migrated: only a new automation gets the default.
	t.Run("an edit keeps hand-written args", func(t *testing.T) {
		with := "automations:\n  - name: triage\n    cron: \"0 9 * * 1-5\"\n    repo: /x\n    agent: codex\n    prompt: p\n    agent_args: [\"--sandbox\", \"read-only\"]\n"
		_, after := runPut(t, with, `{"name":"triage","cron":"0 9 * * 1-5","repo":"/x","agent":"codex","prompt":"q"}`, "--original", "triage")
		if strings.Contains(after, codexAuto) || !strings.Contains(after, "read-only") {
			t.Fatalf("an edit changed the entry's agent_args:\n%s", after)
		}
	})

	t.Run("an edit of an entry with none adds none", func(t *testing.T) {
		_, after := runPut(t, putBase, `{"name":"triage","cron":"0 9 * * 1-5","repo":"/x","agent":"codex","prompt":"q"}`, "--original", "triage")
		if strings.Contains(after, "agent_args") {
			t.Fatalf("an edit migrated the entry onto the automatic mode:\n%s", after)
		}
	})
}

// The panel's command form writes through the same put: the command, its
// folder, env and bot have to survive the JSON-to-config mapping (ADR 0013).
func TestPutCarriesACommandAndItsBot(t *testing.T) {
	body := `{"name":"check","cron":"0 7 * * *","repo":"","workspace":"","agent":"","prompt":"",` +
		`"command":{"argv":["./check.sh","two words"],"cwd":"/srv/checks","env":{"REGION":"eu"}},` +
		`"notify":"b-captain","timeout_minutes":10}`
	answer, after := runPut(t, "automations:\n", body)
	if strings.Contains(answer, `"problem"`) {
		t.Fatalf("put refused it: %s", answer)
	}
	for _, want := range []string{"command:", "- ./check.sh", "- two words", "cwd: /srv/checks", "REGION: eu", "notify: b-captain", "timeout_minutes: 10"} {
		if !strings.Contains(after, want) {
			t.Fatalf("%q not written:\n%s", want, after)
		}
	}
	for _, never := range []string{"repo:", "agent:", "workspace:", "prompt:"} {
		if strings.Contains(after, never) {
			t.Fatalf("a command entry was written with %q:\n%s", never, after)
		}
	}

	// A bot writes a new command with put and no agent_args key. put's default
	// agent args are for a new agent run only: given to a command they would be
	// refused by the loader ("drop agent_args") and nothing would be written.
	t.Run("a new command sent without agent_args gets none", func(t *testing.T) {
		answer, written := runPut(t, "", `{"name":"probe","cron":"@daily","command":{"argv":["/bin/true"]}}`)
		if strings.Contains(answer, `"problem"`) {
			t.Fatalf("put refused a new command: %s", answer)
		}
		if !strings.Contains(written, "- /bin/true") || strings.Contains(written, "agent_args") || strings.Contains(written, "--dangerously") {
			t.Fatalf("wrote:\n%s", written)
		}
	})

	t.Run("an edit that sends no command keeps it", func(t *testing.T) {
		_, kept := runPut(t, after, `{"name":"check","cron":"0 8 * * *"}`, "--original", "check")
		if !strings.Contains(kept, "- ./check.sh") || !strings.Contains(kept, "notify: b-captain") || !strings.Contains(kept, `0 8 * * *`) {
			t.Fatalf("the command or its bot was lost:\n%s", kept)
		}
	})

	t.Run("a command with an agent key is refused, not written", func(t *testing.T) {
		answer, same := runPut(t, after, `{"name":"check","cron":"0 7 * * *","agent":"claude"}`, "--original", "check")
		if !strings.Contains(answer, "drop agent") || same != after {
			t.Fatalf("answer %s\nfile:\n%s", answer, same)
		}
	})
}

// A target goes through put as one key, and a new one gets no default agent
// args: it starts no agent, the bot's launch is the run's (#498).
func TestPutCarriesATarget(t *testing.T) {
	hcBase := "backend: hc\nautomations:\n"
	body := `{"name":"housekeeping","cron":"0 9 * * *","repo":"/x","prompt":"tidy",` +
		`"target":"bot:b-6jrz4bmxml","target_when_busy":"skip","timeout_minutes":30}`
	answer, after := runPut(t, hcBase, body)
	if strings.Contains(answer, `"problem"`) {
		t.Fatalf("put refused it: %s", answer)
	}
	for _, want := range []string{"target: bot:b-6jrz4bmxml", "target_when_busy: skip", "prompt: tidy", "repo: /x"} {
		if !strings.Contains(after, want) {
			t.Fatalf("%q not written:\n%s", want, after)
		}
	}
	for _, never := range []string{"agent:", "agent_args:", "workspace:", "--dangerously"} {
		if strings.Contains(after, never) {
			t.Fatalf("a target was written with %q:\n%s", never, after)
		}
	}

	t.Run("an edit that sends no target keeps it", func(t *testing.T) {
		_, kept := runPut(t, after, `{"name":"housekeeping","cron":"0 8 * * *"}`, "--original", "housekeeping")
		if !strings.Contains(kept, "target: bot:b-6jrz4bmxml") || !strings.Contains(kept, `0 8 * * *`) {
			t.Fatalf("the target was lost:\n%s", kept)
		}
	})

	t.Run("an agent key is refused", func(t *testing.T) {
		answer, same := runPut(t, after, `{"name":"housekeeping","cron":"0 9 * * *","agent":"claude"}`, "--original", "housekeeping")
		if !strings.Contains(answer, "drop agent") || same != after {
			t.Fatalf("answer %s\nfile:\n%s", answer, same)
		}
	})

	t.Run("sending an empty target removes it", func(t *testing.T) {
		_, plain := runPut(t, after, `{"name":"housekeeping","cron":"0 9 * * *","repo":"/x","prompt":"tidy","target":""}`, "--original", "housekeeping")
		if strings.Contains(plain, "target:") || strings.Contains(plain, "target_when_busy:") {
			t.Fatalf("an empty target left its keys behind:\n%s", plain)
		}
	})
}
