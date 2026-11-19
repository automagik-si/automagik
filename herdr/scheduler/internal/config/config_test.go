package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func withConfig(t *testing.T, yaml string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", dir)
	if yaml != "" {
		if err := os.WriteFile(filepath.Join(dir, "automations.yaml"), []byte(yaml), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLoadMissingFileIsEmpty(t *testing.T) {
	withConfig(t, "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Automations) != 0 {
		t.Fatalf("expected empty config, got %d entries", len(cfg.Automations))
	}
}

func TestLoadDefaultsAndValidation(t *testing.T) {
	withConfig(t, `
automations:
  - name: triage
    cron: "0 9 * * 1-5"
    repo: ~/Projects/foo
    prompt: "Triage the issues"
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	a := cfg.Automations[0]
	if a.Workspace != WorkspaceWorktree || a.Agent != "claude" || a.TimeoutMinutes != 60 || a.CloseWorkspace != CloseNever {
		t.Fatalf("defaults not applied: %+v", a)
	}
	home, _ := os.UserHomeDir()
	if a.Repo != filepath.Join(home, "Projects/foo") {
		t.Fatalf("home not expanded: %s", a.Repo)
	}
}

func TestLoadCarriesTheLineEachEntryStartsOn(t *testing.T) {
	withConfig(t, `automations:
  - name: first
    cron: "@daily"
    repo: /x
    prompt: p
  - name: second
    cron: "@daily"
    repo: /x
    prompt: p
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Automations[0].Line; got != 2 {
		t.Errorf("first starts on line %d, want 2", got)
	}
	if got := cfg.Automations[1].Line; got != 6 {
		t.Errorf("second starts on line %d, want 6", got)
	}
}

func TestLoadKeepsTheGoodEntriesWhenOneIsBad(t *testing.T) {
	// The failure this exists for: one error for the whole file meant a typo in
	// the seventh automation stopped the other six, silently.
	withConfig(t, `automations:
  - {name: fine, cron: "@daily", repo: /x, prompt: p}
  - {name: broken, cron: "0 99 * * *", repo: /x, prompt: p}
  - {name: also-fine, cron: "@hourly", repo: /x, prompt: p}
`)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("a single bad entry must not fail the load: %v", err)
	}
	if len(cfg.Automations) != 2 {
		t.Fatalf("loaded %d entries, want the two good ones", len(cfg.Automations))
	}
	if len(cfg.Invalid) != 1 {
		t.Fatalf("diagnostics = %+v, want one", cfg.Invalid)
	}
	d := cfg.Invalid[0]
	if d.Name != "broken" {
		t.Errorf("diagnostic names %q", d.Name)
	}
	if d.Line != 3 {
		t.Errorf("diagnostic points at line %d, want 3", d.Line)
	}
	if got := d.String(); !strings.Contains(got, "automations.yaml:3") {
		t.Errorf("String() = %q, want a file:line an editor can open", got)
	}
}

func TestLoadStillFailsOnAFileItCannotParse(t *testing.T) {
	// Nothing to run and nothing to point at: that is a real error.
	withConfig(t, "automations: [oh: dear\n  ]]] not yaml")
	if _, err := Load(); err == nil {
		t.Fatal("want an error for a file that is not YAML")
	}
}

func TestLoadDiagnosesAnEntryWhoseTypesAreWrong(t *testing.T) {
	withConfig(t, `automations:
  - {name: fine, cron: "@daily", repo: /x, prompt: p}
  - {name: odd, cron: "@daily", repo: /x, prompt: p, timeout_minutes: soon}
`)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("a malformed entry must not fail the load: %v", err)
	}
	if len(cfg.Automations) != 1 || len(cfg.Invalid) != 1 {
		t.Fatalf("loaded %d, invalid %d", len(cfg.Automations), len(cfg.Invalid))
	}
	// Even undecodable, the name is worth recovering: it is how the board and
	// `run` refer to the entry.
	if cfg.Invalid[0].Name != "odd" {
		t.Errorf("diagnostic names %q, want odd", cfg.Invalid[0].Name)
	}
}

func TestDiagnosticAndDeclaresSeeTheEntriesThatFailed(t *testing.T) {
	withConfig(t, `automations:
  - {name: broken, cron: "nope", repo: /x, prompt: p}
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Find("broken") != nil {
		t.Error("a broken entry must not be findable as runnable")
	}
	if cfg.Diagnostic("broken") == nil {
		t.Error(`Diagnostic("broken") = nil: "no automation named broken" is the wrong thing to say`)
	}
	if !cfg.Declares("broken") {
		t.Error("Declares() must see it, or the wizard writes a second one")
	}
}

func TestModelIsPassedThroughUnvalidated(t *testing.T) {
	// Model names change faster than any allowlist would survive, so anything
	// non-empty loads and the agent gets the final say.
	withConfig(t, `
automations:
  - {name: a, cron: "@daily", repo: /x, prompt: p, model: some-unreleased-model}`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Automations[0].Model != "some-unreleased-model" {
		t.Fatalf("model not kept: %q", cfg.Automations[0].Model)
	}
}

func TestModelFlagKindsAreKindsHerdrKnows(t *testing.T) {
	// `herdr agent start --kind` as of Herdr 0.8.2 — a hardcoded snapshot, not a
	// live check, so this only ever catches a typo in modelFlagKinds itself.
	herdrKnows := map[string]bool{
		"pi": true, "claude": true, "codex": true, "gemini": true, "cursor": true,
		"devin": true, "agy": true, "cline": true, "omp": true, "mastracode": true,
		"opencode": true, "copilot": true, "kimi": true, "kiro": true, "droid": true,
		"amp": true, "grok": true, "hermes": true, "kilo": true, "qodercli": true,
		"qwen": true, "maki": true,
	}
	for kind := range modelFlagKinds {
		if !herdrKnows[kind] {
			t.Errorf("modelFlagKinds has %q, which herdr agent start --kind does not accept", kind)
		}
	}
}

func TestLoadDiagnosesBadEntries(t *testing.T) {
	cases := map[string]string{
		"bad cron": `
automations:
  - {name: a, cron: "not a cron", repo: /x, prompt: p}`,
		"prompt and workflow": `
automations:
  - {name: a, cron: "@daily", repo: /x, prompt: p, workflow: w}`,
		"neither prompt nor workflow": `
automations:
  - {name: a, cron: "@daily", repo: /x}`,
		"duplicate names": `
automations:
  - {name: a, cron: "@daily", repo: /x, prompt: p}
  - {name: a, cron: "@daily", repo: /x, prompt: p}`,
		"bad workspace": `
automations:
  - {name: a, cron: "@daily", repo: /x, prompt: p, workspace: sandbox}`,
		"model on a kind that takes none": `
automations:
  - {name: a, cron: "@daily", repo: /x, prompt: p, agent: devin, model: opus}`,
		"no name": `
automations:
  - {cron: "@daily", repo: /x, prompt: p}`,
		"no repo": `
automations:
  - {name: a, cron: "@daily", prompt: p}`,
		"bad close_workspace": `
automations:
  - {name: a, cron: "@daily", repo: /x, prompt: p, close_workspace: always}`,
		"bad blocked grace": `
automations:
  - {name: a, cron: "@daily", repo: /x, prompt: p, blocked_grace_minutes: -2}`,
	}
	for label, yaml := range cases {
		t.Run(label, func(t *testing.T) {
			withConfig(t, yaml)
			cfg, err := Load()
			if err != nil {
				t.Fatalf("want a diagnostic, not a failed load: %v", err)
			}
			if len(cfg.Invalid) != 1 {
				t.Fatalf("diagnostics = %+v, want one for %s", cfg.Invalid, label)
			}
			// A duplicate keeps the first entry; everything else keeps none.
			want := 0
			if label == "duplicate names" {
				want = 1
			}
			if len(cfg.Automations) != want {
				t.Fatalf("%s: loaded %d entries, want %d", label, len(cfg.Automations), want)
			}
		})
	}
}

func TestSaveRefusesToDropTheEntriesThatDidNotLoad(t *testing.T) {
	// The regression this exists for: Load returns only the valid entries, so
	// marshalling a Config straight back deletes every broken one. The wizard
	// does exactly that — read, append, save — which would make
	// `herdr-automations add` silently eat an automation with a typo in it.
	withConfig(t, `automations:
  - {name: fine, cron: "@daily", repo: /x, prompt: p}
  - {name: broken, cron: "nope", repo: /x, prompt: p}
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}

	if err := Save(cfg); err == nil {
		t.Fatal("want Save refused: it cannot write what it was never given")
	}
	// And the file is untouched.
	raw, err := os.ReadFile(Path())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "broken") {
		t.Fatal("the broken entry was deleted from the file")
	}
}

func TestExistingWorkspaceValidation(t *testing.T) {
	a := Automation{Name: "inbox", Cron: "@hourly", Repo: "/repo", Prompt: "check", Workspace: WorkspaceExisting}
	if err := a.validate(BackendHerdr); err == nil {
		t.Fatal("missing workspace_id accepted")
	}
	a.WorkspaceID = "w7"
	if err := a.validate(BackendHerdr); err != nil {
		t.Fatal(err)
	}
	a.Workspace = WorkspaceRoot
	if err := a.validate(BackendHerdr); err == nil {
		t.Fatal("ignored workspace_id accepted")
	}
}

// Closing an existing run is now meaningfully different from closing its
// workspace: the host closes only the tab the run made, so the loader keeps it.
func TestExistingWorkspaceMayCloseItsOwnTab(t *testing.T) {
	withConfig(t, `automations:
  - name: inbox
    cron: "@hourly"
    repo: /repo
    prompt: check
    workspace: existing
    workspace_id: w7
    close_workspace: on-success
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 0 || len(cfg.Automations) != 1 {
		t.Fatalf("config = %+v", cfg)
	}
	if got := cfg.Find("inbox").CloseWorkspace; got != CloseOnSuccess {
		t.Fatalf("close_workspace = %q, want on-success", got)
	}
}

func TestBlockedGraceDefaultsAndMinusOne(t *testing.T) {
	withConfig(t, `automations:
  - {name: default, cron: "@daily", repo: /x, prompt: p}
  - {name: slower, cron: "@daily", repo: /x, prompt: p, blocked_grace_minutes: 5}
  - {name: never, cron: "@daily", repo: /x, prompt: p, blocked_grace_minutes: -1}
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]time.Duration{
		"default": 2 * time.Minute,
		"slower":  5 * time.Minute,
		"never":   0,
	} {
		a := cfg.Find(name)
		if a == nil {
			t.Fatalf("%s did not load: %+v", name, cfg.Invalid)
		}
		if got := a.BlockedGrace(); got != want {
			t.Errorf("%s: BlockedGrace() = %s, want %s", name, got, want)
		}
	}
	if !cfg.Find("never").WaitsOutBlocked() || cfg.Find("default").WaitsOutBlocked() {
		t.Error("only -1 should wait out a blocked agent")
	}
}

func TestExistingWorkspaceSurvivesConfigRoundTrip(t *testing.T) {
	withConfig(t, `automations:
  - name: daily-summary
    cron: "@daily"
    repo: /repo
    workspace: existing
    workspace_id: w7
    prompt: Summarize recent changes.
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 0 || len(cfg.Automations) != 1 {
		t.Fatalf("config=%+v", cfg)
	}
	if err := Save(cfg); err != nil {
		t.Fatal(err)
	}
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	a := cfg.Find("daily-summary")
	if a == nil || a.Workspace != WorkspaceExisting || a.WorkspaceID != "w7" {
		t.Fatalf("existing workspace was lost on save: %+v", a)
	}
}

func TestSessionNamesWhereTheRunHappens(t *testing.T) {
	withConfig(t, `
automations:
  - {name: triage, cron: "@daily", repo: /x, prompt: p, session: automations}
  - {name: here, cron: "@daily", repo: /x, prompt: p}
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Find("triage").Session; got != "automations" {
		t.Errorf("session = %q, want automations", got)
	}
	if got := cfg.Find("here").Session; got != "" {
		t.Errorf("session = %q, want empty: no key keeps today's behaviour", got)
	}
}

func TestASessionNameHerdrCouldNotResolveIsRefusedAtLoad(t *testing.T) {
	for _, bad := range []string{`"my session"`, `"../default"`, `" automations"`} {
		withConfig(t, "automations:\n  - {name: t, cron: \"@daily\", repo: /x, prompt: p, session: "+bad+"}\n")
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.Invalid) != 1 || !strings.Contains(cfg.Invalid[0].Message, "session") {
			t.Errorf("session %s: invalid = %+v, want one diagnostic about the session", bad, cfg.Invalid)
		}
	}
}

func TestLoadReadsBackendAndGlobalPause(t *testing.T) {
	withConfig(t, `backend: hc
paused: true
automations: []
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Backend != BackendHC || !cfg.Paused {
		t.Fatalf("got backend %q paused %v", cfg.Backend, cfg.Paused)
	}
}

// A file written before backends existed keeps running where it always did.
// Defaulting to auto would move every TUI user who also has the app to hc on
// upgrade, without a word.
func TestLoadDefaultsBackendToHerdr(t *testing.T) {
	withConfig(t, "automations: []\n")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Backend != BackendHerdr {
		t.Fatalf("got %q", cfg.Backend)
	}
}

// An unknown backend leaves nothing runnable: every entry would be launched
// somewhere nobody looks. That is a file error, not one diagnostic.
func TestLoadRejectsUnknownBackend(t *testing.T) {
	withConfig(t, "backend: tmux\nautomations: []\n")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "backend") {
		t.Fatalf("expected a backend error, got %v", err)
	}
}

func TestTemplateNeedsTheHCBackendAndNoAgent(t *testing.T) {
	entry := func(extra string) string {
		return `
  - name: t
    cron: "@daily"
    repo: /x
    prompt: p
    template: reviewer` + extra
	}
	cases := []struct {
		backend, extra, want string
	}{
		{"hc", "", ""},
		{"auto", "", "template requires backend: hc"},
		{"herdr", "", "template requires backend: hc"},
		{"hc", "\n    agent: codex", "template replaces agent and model"},
		{"hc", "\n    model: opus", "template replaces agent and model"},
	}
	for _, c := range cases {
		withConfig(t, "backend: "+c.backend+"\nautomations:"+entry(c.extra)+"\n")
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if c.want == "" {
			if len(cfg.Automations) != 1 || cfg.Automations[0].Template != "reviewer" {
				t.Fatalf("%s%s: expected it to load, got %+v", c.backend, c.extra, cfg.Invalid)
			}
			continue
		}
		if len(cfg.Invalid) != 1 || !strings.Contains(cfg.Invalid[0].Message, c.want) {
			t.Fatalf("%s%s: want %q, got %+v", c.backend, c.extra, c.want, cfg.Invalid)
		}
	}
}

// herdr-workflows drives the TUI's server; under hc it would start nothing.
func TestWorkflowIsRefusedUnderHC(t *testing.T) {
	withConfig(t, `backend: hc
automations:
  - name: w
    cron: "@daily"
    repo: /x
    workflow: nightly
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 1 || !strings.Contains(cfg.Invalid[0].Message, "workflow") {
		t.Fatalf("got %+v", cfg.Invalid)
	}
}

func TestSaveKeepsBackendAndPause(t *testing.T) {
	withConfig(t, "backend: hc\nautomations: []\n")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Paused = true
	if err := Save(cfg); err != nil {
		t.Fatal(err)
	}
	again, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if again.Backend != BackendHC || !again.Paused {
		t.Fatalf("got backend %q paused %v", again.Backend, again.Paused)
	}
}

func TestHCRefusesAnAgentThatCannotTakeItsPrompt(t *testing.T) {
	withConfig(t, `backend: hc
automations:
  - name: o
    cron: "@daily"
    repo: /x
    prompt: p
    agent: opencode
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 1 || !strings.Contains(cfg.Invalid[0].Message, "cannot take its prompt") {
		t.Fatalf("got %+v", cfg.Invalid)
	}
}

func TestSessionIsRefusedUnderHC(t *testing.T) {
	withConfig(t, "backend: hc\nautomations:\n  - {name: s, cron: \"@daily\", repo: /x, prompt: p, session: automations}\n")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 1 || !strings.Contains(cfg.Invalid[0].Message, "session") {
		t.Fatalf("got %+v", cfg.Invalid)
	}
}

// A command is the third kind of work (ADR 0013): the scheduler runs it
// itself, so it has no repo, workspace or agent, and gets none by default.
func TestACommandLoadsWithoutRepoWorkspaceOrAgent(t *testing.T) {
	withConfig(t, `
automations:
  - name: daily-check
    cron: "0 7 * * *"
    command:
      argv: ["./check.sh", "--all"]
      cwd: ~/checks
      env:
        REGION: eu
    timeout_minutes: 10
    notify: b-captain
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 0 || len(cfg.Automations) != 1 {
		t.Fatalf("did not load: %+v", cfg.Invalid)
	}
	a := cfg.Automations[0]
	home, _ := os.UserHomeDir()
	if a.Kind() != "command" || a.Command.Cwd != filepath.Join(home, "checks") || a.Command.Env["REGION"] != "eu" {
		t.Fatalf("command = %+v", a.Command)
	}
	if strings.Join(a.Command.Argv, " ") != "./check.sh --all" || a.Notify != "b-captain" || a.TimeoutMinutes != 10 {
		t.Fatalf("got %+v", a)
	}
	if a.Agent != "" || a.Workspace != "" || a.CloseWorkspace != "" || a.BlockedGraceMinutes != 0 {
		t.Fatalf("a command was given agent defaults: %+v", a)
	}
	if a.CatchUpMinutes != 120 {
		t.Fatalf("catch_up_minutes = %d, want the default every kind gets", a.CatchUpMinutes)
	}
}

func TestACommandRunsUnderEitherBackend(t *testing.T) {
	for _, backend := range []string{"herdr", "hc", "auto"} {
		withConfig(t, "backend: "+backend+`
automations:
  - name: c
    cron: "@daily"
    command:
      argv: [/bin/true]
`)
		cfg, err := Load()
		if err != nil || len(cfg.Automations) != 1 {
			t.Fatalf("backend %s: %v %+v", backend, err, cfg)
		}
		if cfg.Automations[0].TimeoutMinutes != 60 {
			t.Fatalf("timeout default = %d", cfg.Automations[0].TimeoutMinutes)
		}
	}
}

func TestCommandEntriesThatDoNotLoad(t *testing.T) {
	entry := func(body string) string {
		return "automations:\n  - name: c\n    cron: \"@daily\"\n" + body
	}
	cases := []struct{ name, yaml, want string }{
		{"with a prompt", entry("    prompt: p\n    repo: /x\n    command:\n      argv: [/bin/true]\n"), "exactly one of prompt, workflow or command"},
		{"with a workflow", entry("    workflow: w\n    command:\n      argv: [/bin/true]\n"), "exactly one of prompt, workflow or command"},
		{"nothing to do", entry("    repo: /x\n"), "exactly one of prompt, workflow or command"},
		{"no argv", entry("    command:\n      cwd: /x\n"), "command needs argv"},
		{"empty program", entry("    command:\n      argv: [\"\"]\n"), "command needs argv"},
		{"relative cwd", entry("    command:\n      argv: [/bin/true]\n      cwd: checks\n"), "cwd must be an absolute path"},
		{"bad env name", entry("    command:\n      argv: [/bin/true]\n      env:\n        \"A=B\": x\n"), "is not a variable name"},
		{"repo", entry("    repo: /x\n    command:\n      argv: [/bin/true]\n"), "drop repo"},
		{"agent", entry("    agent: claude\n    command:\n      argv: [/bin/true]\n"), "drop agent"},
		{"model", entry("    model: sonnet\n    command:\n      argv: [/bin/true]\n"), "drop model"},
		{"workspace", entry("    workspace: root\n    command:\n      argv: [/bin/true]\n"), "drop workspace"},
		{"session", entry("    session: s\n    command:\n      argv: [/bin/true]\n"), "drop session"},
		{"agent_args", entry("    agent_args: [-v]\n    command:\n      argv: [/bin/true]\n"), "drop agent_args"},
		{"close_workspace", entry("    close_workspace: on-success\n    command:\n      argv: [/bin/true]\n"), "drop close_workspace"},
		{"notify with spaces", entry("    notify: \"Herdr Captain\"\n    command:\n      argv: [/bin/true]\n"), "is not a bot id or a terminal name"},
		{"notify as a flag", entry("    notify: --force\n    command:\n      argv: [/bin/true]\n"), "is not a bot id or a terminal name"},
		{"notify on a prompt", entry("    repo: /x\n    prompt: p\n    notify: b-captain\n"), "notify sends a command's result"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withConfig(t, c.yaml)
			cfg, err := Load()
			if err != nil {
				t.Fatal(err)
			}
			if len(cfg.Automations) != 0 || len(cfg.Invalid) != 1 {
				t.Fatalf("want one diagnostic, got %d loaded, %+v", len(cfg.Automations), cfg.Invalid)
			}
			if !strings.Contains(cfg.Invalid[0].Message, c.want) {
				t.Fatalf("message %q does not say %q", cfg.Invalid[0].Message, c.want)
			}
		})
	}
}

// close_workspace: never is the default spelled out; it asks for nothing.
func TestACommandMaySpellOutCloseWorkspaceNever(t *testing.T) {
	withConfig(t, "automations:\n  - name: c\n    cron: \"@daily\"\n    close_workspace: never\n    command:\n      argv: [/bin/true]\n")
	cfg, err := Load()
	if err != nil || len(cfg.Automations) != 1 {
		t.Fatalf("%v %+v", err, cfg)
	}
}

func TestPutWritesACommandAndSwitchesKinds(t *testing.T) {
	withConfig(t, "automations:\n    # nightly\n    - name: check\n      cron: \"@daily\"\n      repo: /x\n      agent: claude\n      prompt: p\n      catch_up_minutes: 30\n")
	cmd := Automation{Name: "check", Cron: "@daily", TimeoutMinutes: 5, Notify: "b-captain",
		Command: &Command{Argv: []string{"./check.sh", "two words"}, Cwd: "/srv/checks", Env: map[string]string{"A": "1"}}}
	// The form sends every key it owns; the agent's are sent empty, so they go.
	given := []string{"name", "cron", "repo", "workspace", "workspace_id", "agent", "model", "template", "prompt",
		"mcp_config", "agent_args", "timeout_minutes", "close_workspace", "command", "notify"}
	res, err := Put("check", cmd, given, false)
	if err != nil || res.Problem != "" {
		t.Fatalf("put: %v %q", err, res.Problem)
	}
	cfg, err := Load()
	if err != nil || len(cfg.Automations) != 1 {
		t.Fatalf("%v %+v", err, cfg)
	}
	a := cfg.Automations[0]
	if a.Kind() != "command" || a.Prompt != "" || a.Repo != "" || a.Agent != "" || a.Notify != "b-captain" {
		t.Fatalf("got %+v", a)
	}
	if strings.Join(a.Command.Argv, "|") != "./check.sh|two words" || a.Command.Cwd != "/srv/checks" || a.Command.Env["A"] != "1" {
		t.Fatalf("command %+v", a.Command)
	}
	if a.CatchUpMinutes != 30 {
		t.Fatalf("a key the form did not send was lost: catch_up_minutes = %d", a.CatchUpMinutes)
	}
	raw, _ := os.ReadFile(Path())
	if !strings.Contains(string(raw), "# nightly") {
		t.Fatalf("the entry's comment was lost:\n%s", raw)
	}

	// And back: a prompt in, the command and its bot out.
	back := Automation{Name: "check", Cron: "@daily", Repo: "/x", Agent: "claude", Prompt: "p"}
	res, err = Put("check", back, given, false)
	if err != nil || res.Problem != "" {
		t.Fatalf("put back: %v %q", err, res.Problem)
	}
	cfg, _ = Load()
	if a := cfg.Automations[0]; a.Kind() != "prompt" || a.Command != nil || a.Notify != "" {
		t.Fatalf("got %+v", a)
	}
}

// A target is stored as one key, "<kind>:<bot id>", and the entry starts no
// workspace, agent, model or close: the bot's own launch is the whole run
// (#498). A worker target runs alongside its bot and so carries no busy rule.
func TestTargetLoadsAndDefaults(t *testing.T) {
	withConfig(t, `
backend: hc
automations:
  - name: housekeeping
    cron: "0 9 * * *"
    repo: /src/project
    target: "bot:b-6jrz4bmxml"
    prompt: tidy the house
  - name: review
    cron: "0 10 * * *"
    repo: /src/project
    target: "worker:b-6jrz4bmxml"
    prompt: review the queue
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 0 {
		t.Fatalf("invalid: %+v", cfg.Invalid)
	}
	bot := cfg.Find("housekeeping")
	if bot == nil {
		t.Fatal("the bot target did not load")
	}
	if bot.Target != "bot:b-6jrz4bmxml" || bot.TargetWhenBusy != TargetQueue {
		t.Fatalf("bot target %q busy %q", bot.Target, bot.TargetWhenBusy)
	}
	if bot.Agent != "" || bot.Workspace != "" || bot.CloseWorkspace != "" {
		t.Fatalf("a target starts no agent or space: %+v", *bot)
	}
	if bot.TimeoutMinutes != 60 || bot.CatchUpMinutes != 120 || bot.BlockedGraceMinutes != 2 {
		t.Fatalf("wait defaults not applied: %+v", *bot)
	}
	worker := cfg.Find("review")
	if worker == nil {
		t.Fatal("the worker target did not load")
	}
	if worker.Target != "worker:b-6jrz4bmxml" || worker.TargetWhenBusy != "" {
		t.Fatalf("worker target %q busy %q", worker.Target, worker.TargetWhenBusy)
	}
}

func TestTargetRefusals(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{"not a target", `target: t3q1`, "not <kind>:<bot id>"},
		{"not a bot id", `target: "bot:t3q1"`, "not a bot id"},
		{"unknown kind", `target: "main:b-6jrz4bmxml"`, "must be bot or worker"},
		{"a worker has no busy rule", "target: \"worker:b-6jrz4bmxml\"\n    target_when_busy: skip", "target_when_busy is a bot target's"},
		{"a bad busy rule", "target: \"bot:b-6jrz4bmxml\"\n    target_when_busy: wait", "target_when_busy must be queue or skip"},
		{"a workspace", "target: \"bot:b-6jrz4bmxml\"\n    workspace: worktree", "drop workspace"},
		{"an agent", "target: \"bot:b-6jrz4bmxml\"\n    agent: claude", "drop agent"},
		{"a close", "target: \"bot:b-6jrz4bmxml\"\n    close_workspace: on-success", "drop close_workspace"},
		{"notify", "target: \"bot:b-6jrz4bmxml\"\n    notify: b-6jrz4bmxml", "drop notify"},
		{"no repo", `target: "bot:b-6jrz4bmxml"`, "needs repo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := "    repo: /src/project\n"
			if tc.name == "no repo" {
				repo = ""
			}
			withConfig(t, "backend: hc\nautomations:\n  - name: x\n    cron: \"0 9 * * *\"\n"+repo+"    prompt: p\n    "+tc.body+"\n")
			cfg, err := Load()
			if err != nil {
				t.Fatal(err)
			}
			if len(cfg.Invalid) != 1 {
				t.Fatalf("got %d entries, %d invalid: %+v", len(cfg.Automations), len(cfg.Invalid), cfg.Invalid)
			}
			if !strings.Contains(cfg.Invalid[0].Message, tc.want) {
				t.Fatalf("message %q, want it to name %q", cfg.Invalid[0].Message, tc.want)
			}
		})
	}
}

// A target needs herdr-core, where bots live: under backend: herdr it is a
// diagnostic, not a run that starts a fresh agent at 3am.
func TestTargetNeedsHerdrCore(t *testing.T) {
	withConfig(t, `
automations:
  - name: housekeeping
    cron: "0 9 * * *"
    repo: /src/project
    target: "bot:b-6jrz4bmxml"
    prompt: tidy
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 1 || !strings.Contains(cfg.Invalid[0].Message, "backend: hc") {
		t.Fatalf("%+v", cfg.Invalid)
	}
}

func TestTargetCannotBeACommand(t *testing.T) {
	withConfig(t, `
backend: hc
automations:
  - name: housekeeping
    cron: "0 9 * * *"
    repo: /src/project
    target: "bot:b-6jrz4bmxml"
    command:
      argv: [echo, hi]
`)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Invalid) != 1 || !strings.Contains(cfg.Invalid[0].Message, "a command cannot also name one") {
		t.Fatalf("%+v", cfg.Invalid)
	}
}

func TestSplitTarget(t *testing.T) {
	kind, bot, err := SplitTarget("worker:b-6jrz4bmxml")
	if err != nil || kind != TargetWorker || bot != "b-6jrz4bmxml" {
		t.Fatalf("got %q %q %v", kind, bot, err)
	}
	for _, bad := range []string{"", "b-6jrz4bmxml", "bot:", "bot:b-6Jrz4bmxml", "pane:b-6jrz4bmxml", "bot:t7"} {
		if _, _, err := SplitTarget(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}
