package config

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func fileText(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(Path())
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

const commented = `# my automations
backend: hc
automations:
  # mornings
  - name: triage
    cron: "0 9 * * 1-5"   # weekdays
    repo: /x
    prompt: p
  - name: broken
    cron: "0 99 * * *"
    repo: /x
    prompt: p
`

// The panel edits one entry; the rest of the file is the user's, comments and
// broken siblings included. Save rewrites everything and refuses while one
// entry is broken, which would lock the panel out of the whole file.
func TestPutReplacesOneEntryAndKeepsTheRest(t *testing.T) {
	withConfig(t, commented)
	a := Automation{Name: "triage", Cron: "0 8 * * 1-5", Repo: "/x", Prompt: "new prompt"}
	if res, err := Put("triage", a, nil, false); err != nil || res.Problem != "" {
		t.Fatalf("put: %v %q", err, res.Problem)
	}
	text := fileText(t)
	for _, want := range []string{"# my automations", "# mornings", "new prompt", "0 8 * * 1-5", "name: broken"} {
		if !strings.Contains(text, want) {
			t.Errorf("file lost %q:\n%s", want, text)
		}
	}
}

// The panel's form knows only some keys. An edit must not drop the others:
// a paused entry edited in the panel came back resumed.
func TestPutKeepsTheKeysItWasNotGiven(t *testing.T) {
	withConfig(t, `automations:
  - name: triage
    cron: "0 9 * * 1-5"
    repo: /x
    model: opus
    prompt: p
    agent_args: [--verbose]   # keep me
    catch_up_minutes: 30
    disabled: true
`)
	a := Automation{Name: "triage", Cron: "0 8 * * 1-5", Repo: "/x", Prompt: "new prompt"}
	if res, err := Put("triage", a, []string{"name", "cron", "repo", "model", "prompt"}, false); err != nil || res.Problem != "" {
		t.Fatalf("put: %v %q", err, res.Problem)
	}
	cfg, _ := Load()
	got := cfg.Find("triage")
	if got == nil || !got.Disabled || got.CatchUpMinutes != 30 || len(got.AgentArgs) != 1 {
		t.Fatalf("lost keys it was not given: %+v", got)
	}
	if got.Model != "" || got.Prompt != "new prompt" || got.Cron != "0 8 * * 1-5" {
		t.Fatalf("given keys not applied (model must be cleared): %+v", got)
	}
	if !strings.Contains(fileText(t), "# keep me") {
		t.Errorf("an untouched key lost its comment:\n%s", fileText(t))
	}
}

// close_workspace is one key of the entry, so put's merge rules cover it like the rest: the form
// can set it, a put that does not send it keeps a hand-written value, and an empty value removes
// the key. With workspace: existing it is valid too, because the host closes only the run's tab.
func TestPutCarriesCloseWorkspace(t *testing.T) {
	base := `automations:
  - name: triage
    cron: "0 9 * * 1-5"
    repo: /x
    prompt: p
`
	with := base + "    close_workspace: on-success\n"
	given := []string{"name", "cron", "repo", "prompt", "close_workspace"}
	entry := func(close CloseWorkspace) Automation {
		return Automation{Name: "triage", Cron: "0 9 * * 1-5", Repo: "/x", Prompt: "p", CloseWorkspace: close}
	}

	t.Run("writes on-success", func(t *testing.T) {
		withConfig(t, base)
		if res, err := Put("triage", entry(CloseOnSuccess), given, false); err != nil || res.Problem != "" {
			t.Fatalf("put: %v %q", err, res.Problem)
		}
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Find("triage").CloseWorkspace != CloseOnSuccess {
			t.Fatalf("close_workspace not applied:\n%s", fileText(t))
		}
	})

	t.Run("keeps a hand-written value when the key is not given", func(t *testing.T) {
		withConfig(t, with)
		if res, err := Put("triage", entry(""), []string{"name", "cron", "repo", "prompt"}, false); err != nil || res.Problem != "" {
			t.Fatalf("put: %v %q", err, res.Problem)
		}
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Find("triage").CloseWorkspace != CloseOnSuccess {
			t.Fatalf("hand-written close_workspace lost:\n%s", fileText(t))
		}
	})

	t.Run("removes the key when given empty", func(t *testing.T) {
		withConfig(t, with)
		if res, err := Put("triage", entry(""), given, false); err != nil || res.Problem != "" {
			t.Fatalf("put: %v %q", err, res.Problem)
		}
		if strings.Contains(fileText(t), "close_workspace") {
			t.Fatalf("an empty close_workspace left the key:\n%s", fileText(t))
		}
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Find("triage").CloseWorkspace != CloseNever {
			t.Fatalf("the removed key does not read as never: %+v", cfg.Find("triage"))
		}
	})

	t.Run("accepts on-success with an existing workspace", func(t *testing.T) {
		shared := `automations:
  - name: triage
    cron: "0 9 * * 1-5"
    repo: /x
    prompt: p
    workspace: existing
    workspace_id: w7
`
		withConfig(t, shared)
		a := entry(CloseOnSuccess)
		a.Workspace, a.WorkspaceID = WorkspaceExisting, "w7"
		res, err := Put("triage", a, []string{"name", "cron", "repo", "prompt", "workspace", "workspace_id", "close_workspace"}, false)
		if err != nil {
			t.Fatal(err)
		}
		if res.Problem != "" {
			t.Fatalf("problem %q", res.Problem)
		}
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if got := cfg.Find("triage"); got == nil || got.CloseWorkspace != CloseOnSuccess || got.Workspace != WorkspaceExisting {
			t.Fatalf("existing entry not saved: %+v", got)
		}
	})
}

// blocked_grace_minutes follows the same merge rules as the other keys; 0 is
// the default, so sending it removes the hand-written value.
func TestPutCarriesBlockedGrace(t *testing.T) {
	base := `automations:
  - name: triage
    cron: "0 9 * * 1-5"
    repo: /x
    prompt: p
`
	given := []string{"name", "cron", "repo", "prompt", "blocked_grace_minutes"}
	entry := func(grace int) Automation {
		return Automation{Name: "triage", Cron: "0 9 * * 1-5", Repo: "/x", Prompt: "p", BlockedGraceMinutes: grace}
	}

	t.Run("writes a positive value", func(t *testing.T) {
		withConfig(t, base)
		if res, err := Put("triage", entry(5), given, false); err != nil || res.Problem != "" {
			t.Fatalf("put: %v %q", err, res.Problem)
		}
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if got := cfg.Find("triage").BlockedGraceMinutes; got != 5 {
			t.Fatalf("blocked_grace_minutes = %d, want 5:\n%s", got, fileText(t))
		}
	})

	t.Run("keeps a hand-written value when the key is not given", func(t *testing.T) {
		withConfig(t, base+"    blocked_grace_minutes: 7\n")
		if res, err := Put("triage", entry(0), []string{"name", "cron", "repo", "prompt"}, false); err != nil || res.Problem != "" {
			t.Fatalf("put: %v %q", err, res.Problem)
		}
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if got := cfg.Find("triage").BlockedGraceMinutes; got != 7 {
			t.Fatalf("hand-written grace lost: %d\n%s", got, fileText(t))
		}
	})

	t.Run("removes the key when given zero", func(t *testing.T) {
		withConfig(t, base+"    blocked_grace_minutes: 7\n")
		if res, err := Put("triage", entry(0), given, false); err != nil || res.Problem != "" {
			t.Fatalf("put: %v %q", err, res.Problem)
		}
		if strings.Contains(fileText(t), "blocked_grace_minutes") {
			t.Fatalf("a zero grace left the key:\n%s", fileText(t))
		}
	})
}

func TestPutAppendsANewEntry(t *testing.T) {
	withConfig(t, commented)
	a := Automation{Name: "digest", Cron: "0 17 * * 5", Repo: "/x", Prompt: "sum up"}
	if res, err := Put("", a, nil, false); err != nil || res.Problem != "" {
		t.Fatalf("put: %v %q", err, res.Problem)
	}
	cfg, _ := Load()
	if cfg.Find("digest") == nil || cfg.Find("triage") == nil {
		t.Fatalf("got %+v", cfg.Automations)
	}
}

func TestPutRefusesWhatWouldNotLoadAndWritesNothing(t *testing.T) {
	withConfig(t, commented)
	before := fileText(t)
	a := Automation{Name: "triage", Cron: "nope", Repo: "/x", Prompt: "p"}
	res, err := Put("triage", a, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Problem, "invalid cron") {
		t.Fatalf("problem %q", res.Problem)
	}
	if fileText(t) != before {
		t.Fatal("a refused put changed the file")
	}
}

func TestPutRefusesANameAlreadyTaken(t *testing.T) {
	withConfig(t, commented)
	a := Automation{Name: "broken", Cron: "@daily", Repo: "/x", Prompt: "p"}
	res, err := Put("", a, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Problem, "already") {
		t.Fatalf("problem %q", res.Problem)
	}
}

func TestPutDryRunPreviewsAndWritesNothing(t *testing.T) {
	withConfig(t, commented)
	before := fileText(t)
	a := Automation{Name: "triage", Cron: "0 8 * * 1-5", Repo: "/x", Prompt: "p"}
	res, err := Put("triage", a, nil, true)
	if err != nil || res.Problem != "" {
		t.Fatalf("put: %v %q", err, res.Problem)
	}
	if len(res.Next) != 3 || res.Next[0].Hour() != 8 {
		t.Fatalf("next %v", res.Next)
	}
	if fileText(t) != before {
		t.Fatal("dry run changed the file")
	}
}

func TestRemoveAndPauseKeepComments(t *testing.T) {
	withConfig(t, commented)
	if err := SetPaused("", true); err != nil {
		t.Fatal(err)
	}
	if err := SetPaused("triage", true); err != nil {
		t.Fatal(err)
	}
	cfg, _ := Load()
	if !cfg.Paused || !cfg.Find("triage").Disabled {
		t.Fatalf("paused %v, triage %+v", cfg.Paused, cfg.Find("triage"))
	}
	if err := Remove("broken"); err != nil {
		t.Fatal(err)
	}
	text := fileText(t)
	if strings.Contains(text, "broken") || !strings.Contains(text, "# weekdays") {
		t.Fatalf("got:\n%s", text)
	}
	if err := Remove("ghost"); err == nil {
		t.Fatal("removing a name that is not there must say so")
	}
}

// An edit must not reformat the entries it did not touch. yaml.v3 does
// normalise the gap before an inline comment to one space; that is all.
func TestEditsKeepTheFilesIndentation(t *testing.T) {
	for _, file := range []string{commented, strings.ReplaceAll(commented, "\n  ", "\n    ")} {
		withConfig(t, file)
		if err := SetPaused("", true); err != nil {
			t.Fatal(err)
		}
		if err := SetPaused("", false); err != nil {
			t.Fatal(err)
		}
		if got, want := fileText(t), strings.ReplaceAll(file, `"   # weekdays`, `" # weekdays`); got != want {
			t.Fatalf("round trip changed the file:\n--- before\n%s--- after\n%s", file, got)
		}
	}
}

const editJobFields = `    cron: "@daily"
    repo: /x
    prompt: p
`

func editJob(name string) Automation {
	return Automation{Name: name, Cron: "@weekly", Repo: "/x", Prompt: "p"}
}

func readEditJob(t *testing.T, name string) Automation {
	t.Helper()
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	job := cfg.Find(name)
	if job == nil {
		t.Fatalf("%q did not load: %+v", name, cfg.Invalid)
	}
	got := *job
	got.Line = 0
	return got
}

func requireRefusal(t *testing.T, before, want string, err error) {
	t.Helper()
	if err == nil || err.Error() != want {
		t.Errorf("got error %v, want %q", err, want)
	}
	if got := fileText(t); got != before {
		t.Errorf("refused edit changed the file:\n%s", got)
	}
}

func namedEditAttempts(name string) map[string]func() error {
	return map[string]func() error{
		"pause":  func() error { return SetPaused(name, true) },
		"remove": func() error { return Remove(name) },
		"put": func() error {
			_, err := Put(name, editJob(name), nil, false)
			return err
		},
	}
}

func TestEditsResolveAliasedNames(t *testing.T) {
	const aliasLine = "  - name: *review\n"
	withConfig(t, "anchors: [&review morning]\nautomations:\n"+aliasLine+editJobFields+
		"  - name: review\n"+editJobFields)
	morning := readEditJob(t, "morning")
	checkMorning := func(want Automation) {
		t.Helper()
		if got := readEditJob(t, "morning"); !reflect.DeepEqual(got, want) {
			t.Fatalf("morning changed: got %+v, want %+v", got, want)
		}
		if !strings.Contains(fileText(t), "\n"+aliasLine) {
			t.Fatalf("lost the name alias:\n%s", fileText(t))
		}
	}
	for _, paused := range []bool{true, false} {
		if err := SetPaused("review", paused); err != nil {
			t.Fatal(err)
		}
		if got := readEditJob(t, "review"); got.Disabled != paused {
			t.Fatalf("review disabled = %v, want %v", got.Disabled, paused)
		}
		checkMorning(morning)
	}
	if res, err := Put("review", editJob("review"), nil, false); err != nil || res.Problem != "" {
		t.Fatalf("put: %v %q", err, res.Problem)
	}
	checkMorning(morning)
	review := readEditJob(t, "review")
	if review.Cron != "@weekly" {
		t.Fatalf("review cron = %q", review.Cron)
	}
	if err := SetPaused("morning", true); err != nil {
		t.Fatal(err)
	}
	morning.Disabled = true
	checkMorning(morning)
	if got := readEditJob(t, "review"); !reflect.DeepEqual(got, review) {
		t.Fatalf("review changed: got %+v, want %+v", got, review)
	}
	if err := Remove("review"); err != nil {
		t.Fatal(err)
	}
	checkMorning(morning)
	cfg, err := Load()
	if err != nil || cfg.Declares("review") {
		t.Fatalf("review still present or reload failed: %+v, %v", cfg, err)
	}
}

func TestEditsRefuseWholeEntryAliases(t *testing.T) {
	const raw = `template: &tmpl
  name: job
  cron: "@daily"
  repo: /x
  prompt: p
automations:
  - *tmpl
`
	for verb, run := range namedEditAttempts("job") {
		t.Run(verb, func(t *testing.T) {
			withConfig(t, raw)
			requireRefusal(t, raw, `"job" is a copy of another entry (line 7); edit automations.yaml by hand`, run())
		})
	}
}

func TestEditsRefuseChangesToSharedAnchors(t *testing.T) {
	const raw = "automations:\n  - &base\n    name: job\n" + editJobFields + `  - <<: *base
    name: child
`
	const changedChild = "this change would also change other automations in automations.yaml (lines 7); edit it by hand"
	const lostAnchor = "this change would also change other automations in automations.yaml (lines 2); edit it by hand"
	withConfig(t, raw)
	requireRefusal(t, raw, changedChild, SetPaused("job", true))
	requireRefusal(t, raw, lostAnchor, Remove("job"))
	for _, tc := range []struct {
		label string
		given []string
		dry   bool
		want  string
	}{
		{"partial", []string{"cron"}, false, changedChild},
		{"replacement", nil, false, lostAnchor},
		{"dry run", []string{"cron"}, true, changedChild},
	} {
		t.Run(tc.label, func(t *testing.T) {
			res, err := Put("job", editJob("job"), tc.given, tc.dry)
			requireRefusal(t, raw, tc.want, err)
			if res.Problem != "" || len(res.Next) != 0 {
				t.Errorf("structural refusal returned a put result: %+v", res)
			}
		})
	}
}

func TestResumeRefusesInheritedDisabled(t *testing.T) {
	const raw = `template: &base
  name: job
  disabled: true
automations:
  - <<: *base
` + editJobFields
	withConfig(t, raw)
	requireRefusal(t, raw, `"job" stays paused through a merged template (line 5); edit automations.yaml by hand`, SetPaused("job", false))
}

func TestEditsRefuseIndirectOrInvalidCollections(t *testing.T) {
	const jobs = "  - name: job\n" + editJobFields + "  - name: taken\n" + editJobFields
	const rawList = "automations:\n" + jobs
	const refusal = "automations.yaml builds its automations list from anchors or merges; edit it by hand"
	for label, raw := range map[string]string{
		"alias":        "jobs: &jobs\n" + jobs + "automations: *jobs\n",
		"merge":        "defaults: &defaults\n  " + strings.ReplaceAll(strings.TrimSuffix(rawList, "\n"), "\n", "\n  ") + "\n<<: *defaults\n",
		"duplicate":    rawList + "automations: []\n",
		"wrong kind":   "automations: {name: job}\n",
		"alias to nil": "jobs: &jobs null\nautomations: *jobs\n",
	} {
		t.Run(label, func(t *testing.T) {
			withConfig(t, raw)
			res, err := Put("", editJob("new"), nil, false)
			requireRefusal(t, raw, refusal, err)
			if res.Problem != "" {
				t.Errorf("create returned a problem: %q", res.Problem)
			}
			res, err = Put("job", editJob("taken"), nil, false)
			requireRefusal(t, raw, refusal, err)
			if res.Problem != "" {
				t.Errorf("rename returned a problem: %q", res.Problem)
			}
			res, err = Put("", editJob("job"), nil, false)
			requireRefusal(t, raw, refusal, err)
			if res.Problem != "" {
				t.Errorf("create with a conflicting name returned a problem: %q", res.Problem)
			}
			requireRefusal(t, raw, refusal, SetPaused("", true))
		})
	}
}

func TestPutCreatesLocalCollection(t *testing.T) {
	for label, raw := range map[string]string{
		"absent":       "backend: hc\n",
		"null":         "automations:\n",
		"quoted merge": `"<<": {automations: []}` + "\n",
	} {
		t.Run(label, func(t *testing.T) {
			withConfig(t, raw)
			if res, err := Put("", editJob("job"), nil, false); err != nil || res.Problem != "" {
				t.Fatalf("put: %v %q", err, res.Problem)
			}
			readEditJob(t, "job")
		})
	}
}

func TestEditsSkipEntriesWithDuplicateNameKeys(t *testing.T) {
	const raw = "automations:\n  - name: job\n    name: job\n" + editJobFields + "  - name: good\n" + editJobFields
	withConfig(t, raw)
	cfg, err := Load()
	if err != nil || len(cfg.Invalid) != 1 || cfg.Invalid[0].Name != "" {
		t.Fatalf("expected one unnamed diagnostic: %+v, %v", cfg, err)
	}
	for verb, run := range namedEditAttempts("job") {
		t.Run(verb, func(t *testing.T) {
			requireRefusal(t, raw, `no automation named "job"`, run())
		})
	}
	if err := SetPaused("good", true); err != nil {
		t.Fatal(err)
	}
	if !readEditJob(t, "good").Disabled || !strings.Contains(fileText(t), "  - name: job\n    name: job\n") {
		t.Fatalf("pause did not preserve the unnamed entry:\n%s", fileText(t))
	}
	if res, err := Put("", editJob("job"), nil, false); err != nil || res.Problem != "" {
		t.Fatalf("unnamed entry blocked append: %v %q", err, res.Problem)
	}
	readEditJob(t, "job")
}

func TestEditsRefuseDuplicateDecodedNames(t *testing.T) {
	const job = "  - name: job\n" + editJobFields
	const refusal = `2 entries are named "job" (lines 2, 6); remove or rename one in automations.yaml`
	for label, first := range map[string]string{"both valid": job, "invalid first": strings.Replace(job, "@daily", "bad", 1)} {
		for verb, run := range namedEditAttempts("job") {
			t.Run(label+"/"+verb, func(t *testing.T) {
				raw := "automations:\n" + first + job
				withConfig(t, raw)
				requireRefusal(t, raw, refusal, run())
			})
		}
	}
}

func TestPutReportsDecodedNameCollision(t *testing.T) {
	const raw = "anchors: [&alias taken]\nautomations:\n  - name: *alias\n" + editJobFields + "  - name: job\n" + editJobFields
	withConfig(t, raw)
	for _, dry := range []bool{false, true} {
		res, err := Put("job", editJob("taken"), nil, dry)
		if err != nil || res.Problem != "taken: an automation by that name already exists" || len(res.Next) != 0 {
			t.Fatalf("put: %+v, %v", res, err)
		}
		if fileText(t) != raw {
			t.Fatal("name collision changed the file")
		}
	}
}

func TestEditsPreserveNonMappingSiblings(t *testing.T) {
	const raw = "automations:\n  - name: job\n" + editJobFields + "  - scalar\n  - [one, two]\n  - null\n"
	withConfig(t, raw)
	if err := SetPaused("job", true); err != nil {
		t.Fatal(err)
	}
	if !readEditJob(t, "job").Disabled {
		t.Fatal("job stayed active")
	}
	if err := Remove("job"); err != nil {
		t.Fatal(err)
	}
	if got, want := fileText(t), "automations:\n  - scalar\n  - [one, two]\n  - null\n"; got != want {
		t.Fatalf("siblings changed:\n%s", got)
	}
}

func TestEditsRefuseAliasedTargetKeys(t *testing.T) {
	const raw = `keys: [&cron prompt, &flag disabled]
automations:
  - name: job
    *cron : p
    *flag : true
    cron: "@daily"
    repo: /x
`
	const refusal = "this change would also change other automations in automations.yaml (lines 3); edit it by hand"
	withConfig(t, raw)
	readEditJob(t, "job")
	res, err := Put("job", editJob("job"), []string{"cron"}, false)
	requireRefusal(t, raw, refusal, err)
	if res.Problem != "" {
		t.Errorf("put returned a problem: %q", res.Problem)
	}
	requireRefusal(t, raw, refusal, SetPaused("job", false))
}

func TestPauseRefusesChangesToOtherSettings(t *testing.T) {
	for _, tc := range []struct {
		label string
		raw   string
		name  string
		line  string
	}{
		{
			"global resume would disable a job",
			"defaults: &flag true\npaused: &flag false\nautomations:\n  - name: job\n" + editJobFields + "    disabled: *flag\n",
			"", "4",
		},
		{
			"job resume would clear global pause",
			"defaults: &flag false\nautomations:\n  - name: job\n" + editJobFields + "    disabled: &flag true\npaused: *flag\n",
			"job", "1",
		},
		{
			"job resume would rename the job",
			"defaults: &flag other\nautomations:\n  - disabled: &flag true\n    name: *flag\n" + editJobFields,
			"true", "3",
		},
	} {
		t.Run(tc.label, func(t *testing.T) {
			withConfig(t, tc.raw)
			want := "this change would also change other automations in automations.yaml (lines " + tc.line + "); edit it by hand"
			requireRefusal(t, tc.raw, want, SetPaused(tc.name, false))
		})
	}
}

// A file that does not load before the edit keeps reporting the loader's error
// as Put's problem; only an edit that breaks a file that loaded is refused.
func TestPutReportsAFileThatDidNotLoad(t *testing.T) {
	withConfig(t, `backend: nowhere
automations:
  - name: triage
    cron: "0 9 * * *"
    repo: /x
    prompt: p
`)
	before := fileText(t)
	a := Automation{Name: "triage", Cron: "0 8 * * *", Repo: "/x", Prompt: "p"}
	res, err := Put("triage", a, []string{"cron"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Problem, "backend must be") {
		t.Fatalf("problem %q", res.Problem)
	}
	if fileText(t) != before {
		t.Fatal("a refused put changed the file")
	}
}

func TestPauseRefusesChangingChildWithComplexNotes(t *testing.T) {
	const raw = `automations:
  - &base {name: base, cron: "@daily", repo: /x, prompt: p}
  - <<: *base
    name: child
    notes:
      ? [a, b]
      : value
`
	withConfig(t, raw)
	const refusal = "this change would also change other automations in automations.yaml (lines 3); edit it by hand"
	requireRefusal(t, raw, refusal, SetPaused("base", true))
}

func TestRemoveRefusesChangingNameScalarSpelling(t *testing.T) {
	const raw = `previous: &id 01
automations:
  - {name: drop, cron: "@daily", repo: /x, prompt: &id 1}
  - {name: *id, cron: "@daily", repo: /x, prompt: p}
`
	withConfig(t, raw)
	const refusal = "this change would also change other automations in automations.yaml (lines 4); edit it by hand"
	requireRefusal(t, raw, refusal, Remove("drop"))
}

func TestResumeRefusesChangingTargetPrompt(t *testing.T) {
	const raw = `previous: &flag replacement
automations:
  - name: job
    cron: "@daily"
    repo: /x
    disabled: &flag true
    prompt: *flag
`
	withConfig(t, raw)
	const refusal = "this change would also change other automations in automations.yaml (lines 3); edit it by hand"
	requireRefusal(t, raw, refusal, SetPaused("job", false))
}

func TestPutRefusesExposingInheritedDisabled(t *testing.T) {
	const raw = `defaults: &base {disabled: true}
automations:
  - {<<: *base, name: job, cron: "@daily", repo: /x, prompt: p, disabled: false}
`
	withConfig(t, raw)
	const refusal = "this change would also change other automations in automations.yaml (lines 3); edit it by hand"
	for _, dry := range []bool{true, false} {
		res, err := Put("job", Automation{Name: "job", Disabled: false}, []string{"name", "disabled"}, dry)
		requireRefusal(t, raw, refusal, err)
		if res.Problem != "" || len(res.Next) != 0 {
			t.Errorf("dry run %v: structural refusal returned a put result: %+v", dry, res)
		}
	}
}

func TestPauseIgnoresComplexNoteMerge(t *testing.T) {
	withConfig(t, `automations:
  - name: job
    cron: "@daily"
    repo: /x
    prompt: p
    notes:
      0: local
      <<:
        ? [a, b]
        : value
`)
	if err := SetPaused("job", true); err != nil {
		t.Fatal(err)
	}
	if !readEditJob(t, "job").Disabled {
		t.Fatal("job stayed active")
	}
	if !strings.Contains(fileText(t), "0: local") || !strings.Contains(fileText(t), "? [a, b]") {
		t.Fatal("pause lost the complex notes")
	}
}

func TestPauseAllPreservesPlainNaNPrompt(t *testing.T) {
	withConfig(t, `automations:
  - {name: job, cron: "@daily", repo: /x, prompt: .nan}
`)
	if err := SetPaused("", true); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load()
	if err != nil || !cfg.Paused {
		t.Fatalf("expected global pause: %+v, %v", cfg, err)
	}
	if got := readEditJob(t, "job"); got.Disabled || got.Prompt != ".nan" {
		t.Fatalf("pause changed the job: %+v", got)
	}
}

func TestEditsHandleInvalidGlobalPaused(t *testing.T) {
	const raw = `paused: typo
automations: []
`
	t.Run("resume all repairs the flag", func(t *testing.T) {
		withConfig(t, raw)
		if err := SetPaused("", false); err != nil {
			t.Fatal(err)
		}
		cfg, err := Load()
		if err != nil || cfg.Paused || fileText(t) != "automations: []\n" {
			t.Fatalf("expected the invalid paused flag to be removed: %+v, %v", cfg, err)
		}
	})
	t.Run("put reports the loader error", func(t *testing.T) {
		withConfig(t, raw)
		_, loadErr := Load()
		if loadErr == nil {
			t.Fatal("the invalid paused flag loaded")
		}
		a := Automation{Name: "job", Cron: "@daily", Repo: "/x", Prompt: "p", AgentArgs: []string{}}
		res, err := Put("", a, []string{"name", "cron", "repo", "prompt", "agent_args"}, false)
		if err != nil || res.Problem != loadErr.Error() || len(res.Next) != 0 {
			t.Fatalf("put: %+v, %v, want problem %q", res, err, loadErr)
		}
		if fileText(t) != raw {
			t.Fatal("a refused put changed the file")
		}
	})
}

func TestPutRefusesNewLoadErrorInAnInvalidFile(t *testing.T) {
	const raw = `backend: nowhere
automations:
  - {name: first, cron: "@daily", repo: /x, prompt: &p old}
  - {name: second, cron: "@daily", repo: /x, prompt: *p}
`
	withConfig(t, raw)
	const refusal = "this change would also change other automations in automations.yaml (lines 3); edit it by hand"
	res, err := Put("first", Automation{Name: "first", Prompt: "new"}, []string{"name", "prompt"}, false)
	requireRefusal(t, raw, refusal, err)
	if res.Problem != "" || len(res.Next) != 0 {
		t.Errorf("structural refusal returned a put result: %+v", res)
	}
}

// The panel's form sends every key it shows, empty ones included: an edit with
// agent_args [] and an empty mcp_config must not read as a changed entry.
func TestPutWithGivenEmptyKeysKeepsWorking(t *testing.T) {
	withConfig(t, `automations:
  - name: triage
    cron: "0 9 * * *"
    repo: /x
    prompt: p
    agent_args: []
`)
	a := Automation{Name: "triage", Cron: "0 8 * * *", Repo: "/x", Prompt: "p", AgentArgs: []string{}}
	res, err := Put("triage", a, []string{"name", "cron", "repo", "prompt", "agent_args", "mcp_config", "close_workspace", "workflow", "notify"}, false)
	if err != nil || res.Problem != "" {
		t.Fatalf("put: %v %q", err, res.Problem)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Find("triage"); got == nil || got.Cron != "0 8 * * *" || len(got.AgentArgs) != 0 {
		t.Fatalf("after put: %+v", got)
	}
}

// A sibling that does not load still keeps the fields that decoded: removing
// the anchor its prompt points at must be refused, not accepted silently.
func TestRemoveRefusesChangingABrokenSiblingsPrompt(t *testing.T) {
	withConfig(t, `fallback: &p "send weekly report"
automations:
  - {name: drop, cron: "@daily", repo: /x, prompt: &p "send daily report"}
  - {name: keep, cron: "@daily", repo: /x, prompt: *p, timeout_minutes: typo}
`)
	before := fileText(t)
	err := Remove("drop")
	if err == nil || !strings.Contains(err.Error(), "would also change other automations") {
		t.Fatalf("remove: %v", err)
	}
	if fileText(t) != before {
		t.Fatal("a refused remove changed the file")
	}
}

// The panel sends the defaults it shows (timeout 60, catch-up 120, worktree,
// never): a child that inherits the edited entry runs the same before and
// after, so the edit goes through.
func TestPutAcceptsAnEditWhoseChildRunsTheSame(t *testing.T) {
	withConfig(t, `automations:
  - &base {name: base, cron: "@daily", repo: /x, prompt: p}
  - {<<: *base, name: child, cron: "@hourly"}
`)
	a := Automation{Name: "base", Cron: "@weekly", Repo: "/x", Workspace: WorkspaceWorktree, Agent: "claude",
		Prompt: "p", TimeoutMinutes: 60, CatchUpMinutes: 120, AgentArgs: []string{}, CloseWorkspace: CloseNever}
	given := []string{"name", "cron", "repo", "workspace", "workspace_id", "agent", "template", "model", "prompt",
		"mcp_config", "timeout_minutes", "catch_up_minutes", "disabled", "agent_args", "close_workspace"}
	for _, dry := range []bool{true, false} {
		res, err := Put("base", a, given, dry)
		if err != nil || res.Problem != "" {
			t.Fatalf("put dry=%v: %v %q", dry, err, res.Problem)
		}
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if b, c := cfg.Find("base"), cfg.Find("child"); b == nil || c == nil || b.Cron != "@weekly" || c.Cron != "@hourly" {
		t.Fatalf("after put: %+v %+v", b, c)
	}
}
