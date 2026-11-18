// Package api is what `--json` prints: the shapes the Herdr app panel reads.
// The panel never parses automations.yaml or history.jsonl itself (ADR 0011),
// so these structs are the contract — rename a field here and the panel breaks.
package api

import (
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/daemon"
	"github.com/DnzzL/herdr-automations/internal/history"
)

// Listing is `ls --json`.
type Listing struct {
	Backend config.Backend `json:"backend"`
	Paused  bool           `json:"paused"`
	// Scheduler is the daemon's pid, 0 when none is running.
	Scheduler int    `json:"scheduler"`
	Config    string `json:"config"`
	// State is the folder history.jsonl lives in, for the panel to watch.
	State string `json:"state"`
	// Kinds are the kinds of work this build runs: prompt, workflow, command.
	// A panel offers the command form only when it reads "command" here.
	Kinds       []string     `json:"kinds"`
	Automations []Automation `json:"automations"`
	Invalid     []Invalid    `json:"invalid"`
}

// Automation is one entry as the form edits it, plus what the list shows.
type Automation struct {
	Name           string           `json:"name"`
	Cron           string           `json:"cron"`
	Repo           string           `json:"repo"`
	Workspace      config.Workspace `json:"workspace"`
	WorkspaceID    string           `json:"workspace_id,omitempty"`
	CloseWorkspace string           `json:"close_workspace,omitempty"`
	Agent          string           `json:"agent,omitempty"`
	Model          string           `json:"model,omitempty"`
	Template       string           `json:"template,omitempty"`
	Prompt         string           `json:"prompt,omitempty"`
	Workflow       string           `json:"workflow,omitempty"`
	// Command is the program the scheduler runs itself, and Notify the bot its
	// one-line result goes to (ADR 0013). A command entry has no repo,
	// workspace or agent.
	Command        *config.Command `json:"command,omitempty"`
	Notify         string          `json:"notify,omitempty"`
	MCPConfig      string          `json:"mcp_config,omitempty"`
	AgentArgs      []string        `json:"agent_args,omitempty"`
	TimeoutMinutes int             `json:"timeout_minutes"`
	CatchUpMinutes int             `json:"catch_up_minutes"`
	// BlockedGraceMinutes is how long an agent may sit on a dialog before the
	// run fails; the loader fills in the default (2), -1 waits it out.
	BlockedGraceMinutes int       `json:"blocked_grace_minutes"`
	Disabled            bool      `json:"disabled"`
	Line                int       `json:"line"`
	Next                time.Time `json:"next"`
	Last                *Run      `json:"last"`
}

// Invalid is an entry that did not load, and where to fix it.
type Invalid struct {
	Name    string `json:"name"`
	Line    int    `json:"line"`
	Message string `json:"message"`
}

// Run is one run as the inbox and the detail view show it.
type Run struct {
	RunID      string         `json:"run_id"`
	Automation string         `json:"automation"`
	Status     history.Status `json:"status"`
	Trigger    string         `json:"trigger,omitempty"`
	Started    time.Time      `json:"started"`
	At         time.Time      `json:"at"`
	Seconds    int            `json:"seconds"`
	Space      string         `json:"space,omitempty"`
	Terminal   string         `json:"terminal,omitempty"`
	Error      string         `json:"error,omitempty"`
	// A command run's: its exit status (absent when it has none), its one
	// line, the last lines of its stderr, and what became of the report.
	ExitCode *int   `json:"exit_code,omitempty"`
	Result   string `json:"result,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
	Notified string `json:"notified,omitempty"`
	Seen     bool   `json:"seen"`
}

// List reads the config and the latest run of each automation.
func List() (Listing, error) {
	cfg, err := config.Load()
	if err != nil {
		return Listing{}, err
	}
	pid, _ := daemon.Running()
	out := Listing{
		Backend: cfg.Backend, Paused: cfg.Paused, Scheduler: pid, Config: config.Path(), State: config.StateDir(),
		Kinds:       config.Kinds,
		Automations: []Automation{}, Invalid: []Invalid{},
	}
	now := time.Now()
	for _, a := range cfg.Automations {
		entry := Automation{
			Name: a.Name, Cron: a.Cron, Repo: a.Repo, Workspace: a.Workspace, WorkspaceID: a.WorkspaceID,
			CloseWorkspace: string(a.CloseWorkspace),
			Agent:          a.Agent, Model: a.Model, Template: a.Template, Prompt: a.Prompt, Workflow: a.Workflow,
			MCPConfig: a.MCPConfig, AgentArgs: a.AgentArgs, TimeoutMinutes: a.TimeoutMinutes,
			CatchUpMinutes: a.CatchUpMinutes, BlockedGraceMinutes: a.BlockedGraceMinutes,
			Disabled: a.Disabled, Line: a.Line,
			Command: a.Command, Notify: a.Notify,
		}
		if a.Template != "" {
			entry.Agent = "" // the default filled in at load; a template brings its own
		}
		if sched, err := config.CronParser.Parse(a.Cron); err == nil {
			entry.Next = sched.Next(now)
		}
		if r, _ := history.LastRun(a.Name); r != nil {
			last := toRun(*r)
			entry.Last = &last
		}
		out.Automations = append(out.Automations, entry)
	}
	for _, d := range cfg.Invalid {
		out.Invalid = append(out.Invalid, Invalid{Name: d.Name, Line: d.Line, Message: d.Message})
	}
	return out, nil
}

// History lists recent runs, newest first; name filters to one automation.
func History(name string, limit int) ([]Run, error) {
	recs, err := history.Runs(name, limit)
	if err != nil {
		return nil, err
	}
	out := make([]Run, 0, len(recs))
	for _, r := range recs {
		out = append(out, toRun(r))
	}
	return out, nil
}

func toRun(r history.Record) Run {
	return Run{
		RunID: r.RunID, Automation: r.Automation, Status: r.Status, Trigger: string(r.Trigger),
		Started: r.Started, At: r.At, Seconds: int(r.At.Sub(r.Started).Seconds()),
		Space: r.WorkspaceID, Terminal: r.PaneID, Error: r.Error, Seen: r.Seen,
		ExitCode: r.ExitCode, Result: r.Result, Stderr: r.Stderr, Notified: r.Notified,
	}
}
