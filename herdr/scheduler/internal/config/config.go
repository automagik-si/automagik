// Package config loads and validates automations.yaml, the single source of
// truth for the plugin. Everything else (wizard, pane, daemon) reads or
// rewrites this file.
//
// Loading is deliberately partial: an entry that does not validate becomes a
// Diagnostic and the rest of the file still runs. Returning one error for the
// whole file meant a typo in the seventh automation stopped the other six, and
// the daemon's only response was a log line nobody reads at 09:00. For a tool
// whose promise is "it ran while you slept", a silent absence is the worst
// failure mode there is.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
	"gopkg.in/yaml.v3"

	"github.com/DnzzL/herdr-automations/internal/hostpath"
)

// CronParser accepts the standard 5-field crontab syntax plus descriptors
// like @daily. Shared by the daemon and the wizard preview.
var CronParser = cron.NewParser(
	cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor,
)

type Workspace string

const (
	WorkspaceWorktree Workspace = "worktree" // fresh git worktree per run
	WorkspaceExisting Workspace = "existing" // fresh tab in an existing workspace
	WorkspaceRoot     Workspace = "root"     // workspace on the repo root
)

// CloseWorkspace says whether a run closes its workspace once it is done
// (ADR 0012). The open workspace is otherwise the sign nobody read the run.
// Existing mode asks for the tab this run opened, after checking that the tab
// is not the space's last one at that moment. A person closing the other tabs
// in between can still leave it last.
type CloseWorkspace string

const (
	CloseNever     CloseWorkspace = "never"      // leave it for a person (ADR 0001)
	CloseOnSuccess CloseWorkspace = "on-success" // close it once the run is done
)

// Backend is the Herdr a run is launched in: the TUI's server, or herdr-core
// behind the desktop app. The two share no agents (ADR 0011).
type Backend string

const (
	BackendAuto  Backend = "auto"  // hc when herdr-core answers, else herdr
	BackendHerdr Backend = "herdr" // the TUI's server; the default
	BackendHC    Backend = "hc"    // herdr-core, shown by the desktop app
)

// TargetKind is what an automation's target names: a bot's own terminal, or a
// worker started under that bot for the run. A target replaces the fresh
// session a prompt run opens today (#498).
type TargetKind string

const (
	TargetBot    TargetKind = "bot"    // hand the prompt to the bot's own terminal
	TargetWorker TargetKind = "worker" // a worker of the bot, for this run only
)

// Targets are the target kinds this build runs, for `ls --json`: a panel
// offers a target only when the scheduler it drives names the kind. Absent
// from a build that predates targets, so that panel never writes one to a
// scheduler that would drop it.
var Targets = []string{string(TargetBot), string(TargetWorker)}

// TargetBotID is a bot id from .herdr/bots.json: "b-" and ten lowercase
// base32 characters (model.js's ID_SHAPE, kept equal). A terminal address,
// a bot name and a linked machine's pane are never a target: only the stable
// id is, so a rename or a restart never changes where an automation goes.
var TargetBotID = regexp.MustCompile(`^b-[a-z2-7]{10}$`)

// SplitTarget reads an automation's target, "<kind>:<bot id>", or says why it
// is not one. The kind and the id stay one YAML key so a form, a `put` and a
// hand-edited file all have one value to read and write.
func SplitTarget(target string) (TargetKind, string, error) {
	kind, bot, found := strings.Cut(strings.TrimSpace(target), ":")
	if !found {
		return "", "", fmt.Errorf("target %q is not <kind>:<bot id>, e.g. bot:b-xxxxxxxxxx", target)
	}
	switch TargetKind(kind) {
	case TargetBot, TargetWorker:
	default:
		return "", "", fmt.Errorf("target %q names %q; it must be bot or worker", target, kind)
	}
	if !TargetBotID.MatchString(bot) {
		return "", "", fmt.Errorf("target %q: %q is not a bot id (b- and ten base32 characters); "+
			"name the bot, never a terminal address", target, bot)
	}
	return TargetKind(kind), bot, nil
}

// TargetWhenBusy is what a bot target does when the bot is already working:
// queue (the default) hands the prompt over for the bot's next turn, skip
// drops the occurrence the way an overlapping run is dropped.
type TargetWhenBusy string

const (
	TargetQueue TargetWhenBusy = "queue" // the default
	TargetSkip  TargetWhenBusy = "skip"
)

// QueueWhenBusy is the busy behaviour actually used: an absent value is queue.
func (a Automation) QueueWhenBusy() bool { return a.TargetWhenBusy != TargetSkip }

// Command is work the scheduler runs itself: one program, started directly by
// the daemon as the user it runs as. No pane, no agent, no model (ADR 0013).
type Command struct {
	// Argv is the program and its arguments, as they are: no shell reads them.
	Argv []string `yaml:"argv" json:"argv"`
	// Cwd is the working folder (absolute, ~ expanded). Empty is the home folder.
	Cwd string `yaml:"cwd,omitempty" json:"cwd,omitempty"`
	// Env is added to the daemon's own environment, and wins over it.
	Env map[string]string `yaml:"env,omitempty" json:"env,omitempty"`
}

// Automation is one scheduled entry: a prompt (or delegated workflow) fired
// on a cron schedule against an agent in a provisioned workspace, or a command
// the scheduler runs itself.
type Automation struct {
	Name string `yaml:"name"`
	Cron string `yaml:"cron"`
	// Repo the automation operates on (absolute path, ~ expanded). A command
	// has none: it names its own working folder.
	Repo string `yaml:"repo,omitempty"`
	// Workspace provisioning mode; defaults to worktree.
	Workspace Workspace `yaml:"workspace,omitempty"`
	// WorkspaceID is required for existing mode. Each run gets a fresh tab at Repo.
	WorkspaceID string `yaml:"workspace_id,omitempty"`
	// Agent kind as understood by `herdr agent start --kind`; defaults to claude.
	Agent string `yaml:"agent,omitempty"`
	// Template is an hc template (~/.config/herdr-core/templates/<name>.md):
	// it brings its own agent, model and instructions, and Prompt becomes its
	// task. Replaces Agent and Model; hc backend only.
	Template string `yaml:"template,omitempty"`
	// Model handed to the agent executable as --model. Empty leaves the agent
	// on its own default, which may not be the one your quota can afford.
	// The value is passed through untouched: model names move faster than any
	// list we could keep here, so a typo surfaces when the agent refuses it.
	Model string `yaml:"model,omitempty"`
	// Prompt submitted to the agent. Exactly one of Prompt, Workflow and
	// Command is set.
	Prompt string `yaml:"prompt,omitempty"`
	// Workflow delegates execution to herdr-workflows: `hwf run <name>`.
	Workflow string `yaml:"workflow,omitempty"`
	// Command is run by the scheduler itself, with TimeoutMinutes as its
	// bound. Exit 0 is done; anything else, or the timeout, is failed.
	Command *Command `yaml:"command,omitempty"`
	// Notify names the bot a command's one-line result is sent to: a bot id
	// (the terminal labelled bot=<id>), else a terminal name. Command only.
	Notify string `yaml:"notify,omitempty"`
	// MCPConfig is a path to an MCP servers JSON passed to the agent
	// (claude: --mcp-config). Sugar over AgentArgs.
	MCPConfig string `yaml:"mcp_config,omitempty"`
	// AgentArgs are extra args appended to the agent command verbatim.
	AgentArgs []string `yaml:"agent_args,omitempty"`
	// TimeoutMinutes bounds the agent prompt --wait; defaults to 60.
	TimeoutMinutes int `yaml:"timeout_minutes,omitempty"`
	// CatchUpMinutes is how late a missed occurrence may still run — the
	// laptop-was-asleep case. 0 uses the default (120); -1 never catches up.
	CatchUpMinutes int `yaml:"catch_up_minutes,omitempty"`
	// BlockedGraceMinutes is how long the agent may sit on a dialog before
	// the run fails. 0 uses the default (2); -1 waits as long as the
	// timeout allows, as before.
	BlockedGraceMinutes int `yaml:"blocked_grace_minutes,omitempty"`
	// Session is the Herdr session the run happens in, whoever triggers it.
	// Empty means the session of the process running it (ADR 0010).
	Session string `yaml:"session,omitempty"`
	// CloseWorkspace closes a done run's workspace; failures stay open.
	CloseWorkspace CloseWorkspace `yaml:"close_workspace,omitempty"`
	// Target is who a prompt run hands its prompt to instead of opening a
	// fresh session: "bot:<id>" (the bot's own terminal, started when it is
	// not running) or "worker:<id>" (a worker of that bot for this run only).
	// Empty is a new session, exactly as before (#498). A target needs the
	// project's repo, because .herdr/bots.json names the bot there.
	Target string `yaml:"target,omitempty"`
	// TargetWhenBusy is a bot target's answer to a busy bot: "queue" (the
	// default) or "skip". A worker target runs alongside its bot and never
	// asks.
	TargetWhenBusy TargetWhenBusy `yaml:"target_when_busy,omitempty"`
	// Disabled keeps the entry in the file but out of the scheduler.
	Disabled bool `yaml:"disabled,omitempty"`

	// Line is where this entry starts in automations.yaml, 1-based, so an
	// editor can be opened right at it. Set by Load, never written back.
	Line int `yaml:"-"`
}

type Config struct {
	// Backend picks where runs are launched. Defaults to herdr, so a file
	// written before backends existed keeps running where it always did.
	Backend Backend `yaml:"backend,omitempty"`
	// Paused holds every automation, on top of each one's own Disabled, so
	// resuming restores exactly what was paused before.
	Paused bool `yaml:"paused,omitempty"`
	// Automations are the entries that loaded. Only these run.
	Automations []Automation `yaml:"automations"`
	// Invalid are the entries that did not, one Diagnostic each. Kept out of
	// Automations so nothing has to check before scheduling, and reported so
	// the failure is visible where you look rather than only in a log.
	Invalid []Diagnostic `yaml:"-"`
}

// Diagnostic is one entry that did not load, and where to go and fix it.
type Diagnostic struct {
	// Name of the automation, or empty when the entry is malformed enough that
	// even its name could not be read.
	Name string
	// Line the entry starts on, 1-based. 0 when it could not be located.
	Line    int
	Message string
}

// String renders a diagnostic the way an editor and a human both want it:
// file, line, then what is wrong.
func (d Diagnostic) String() string {
	where := filepath.Base(Path())
	if d.Line > 0 {
		where = fmt.Sprintf("%s:%d", where, d.Line)
	}
	return where + ": " + d.Message
}

func (a *Automation) applyDefaults() {
	if a.TimeoutMinutes <= 0 {
		a.TimeoutMinutes = 60
	}
	if a.CatchUpMinutes == 0 {
		a.CatchUpMinutes = 120
	}
	if a.Target != "" {
		// A target starts no agent and opens no space: the bot's own launch,
		// or its worker's, supplies both. Only the wait's grace applies.
		if a.BlockedGraceMinutes == 0 {
			a.BlockedGraceMinutes = 2
		}
		if a.TargetWhenBusy == "" && strings.HasPrefix(a.Target, string(TargetBot)+":") {
			a.TargetWhenBusy = TargetQueue
		}
		return
	}
	if a.Command != nil {
		// No workspace and no agent to default: a command has neither.
		return
	}
	if a.Workspace == "" {
		a.Workspace = WorkspaceWorktree
	}
	if a.CloseWorkspace == "" {
		a.CloseWorkspace = CloseNever
	}
	if a.Agent == "" {
		a.Agent = "claude"
	}
	if a.BlockedGraceMinutes == 0 {
		a.BlockedGraceMinutes = 2
	}
}

// CatchUp is how late this automation may still start; negative means never.
func (a Automation) CatchUp() time.Duration {
	if a.CatchUpMinutes < 0 {
		return 0
	}
	return time.Duration(a.CatchUpMinutes) * time.Minute
}

// BlockedGrace is how long an agent may sit blocked before the run fails.
// -1 keeps the old wait-for-the-timeout behaviour and yields 0. A zero value
// reaching here is a raw Automation that never went through the loader, so it
// gets the default.
func (a Automation) BlockedGrace() time.Duration {
	switch {
	case a.BlockedGraceMinutes < 0:
		return 0
	case a.BlockedGraceMinutes == 0:
		return 2 * time.Minute
	default:
		return time.Duration(a.BlockedGraceMinutes) * time.Minute
	}
}

// WaitsOutBlocked reports whether the run should wait for the timeout on a
// blocked agent instead of failing after the grace.
func (a Automation) WaitsOutBlocked() bool { return a.BlockedGraceMinutes < 0 }

func (a *Automation) validate(backend Backend) error {
	if a.Name == "" {
		return fmt.Errorf("automation without a name")
	}
	if a.Cron == "" {
		return fmt.Errorf("%s: missing cron", a.Name)
	}
	if _, err := CronParser.Parse(a.Cron); err != nil {
		return fmt.Errorf("%s: invalid cron %q: %w", a.Name, a.Cron, err)
	}
	kinds := 0
	for _, set := range []bool{a.Prompt != "", a.Workflow != "", a.Command != nil} {
		if set {
			kinds++
		}
	}
	if kinds != 1 {
		return fmt.Errorf("%s: exactly one of prompt, workflow or command is required", a.Name)
	}
	if a.Target != "" {
		return a.validateTarget(backend)
	}
	if a.TargetWhenBusy != "" {
		return fmt.Errorf("%s: target_when_busy is a bot target's; add target: bot:<id> or drop it", a.Name)
	}
	if a.Command != nil {
		return a.validateCommand()
	}
	if a.Notify != "" {
		return fmt.Errorf("%s: notify sends a command's result; a prompt or workflow run has none", a.Name)
	}
	if a.Repo == "" {
		return fmt.Errorf("%s: missing repo", a.Name)
	}
	if a.Workspace != WorkspaceWorktree && a.Workspace != WorkspaceRoot && a.Workspace != WorkspaceExisting {
		return fmt.Errorf("%s: workspace must be worktree, root or existing, got %q", a.Name, a.Workspace)
	}
	if a.Workspace == WorkspaceExisting && strings.TrimSpace(a.WorkspaceID) == "" {
		return fmt.Errorf("%s: workspace_id is required for existing mode", a.Name)
	}
	if a.Workspace != WorkspaceExisting && a.WorkspaceID != "" {
		return fmt.Errorf("%s: workspace_id requires existing mode", a.Name)
	}
	if a.CloseWorkspace != "" && a.CloseWorkspace != CloseNever && a.CloseWorkspace != CloseOnSuccess {
		return fmt.Errorf("%s: close_workspace must be never or on-success, got %q", a.Name, a.CloseWorkspace)
	}
	if a.BlockedGraceMinutes < -1 {
		return fmt.Errorf("%s: blocked_grace_minutes must be -1, 0 (the default) or a positive number, got %d",
			a.Name, a.BlockedGraceMinutes)
	}
	// The name becomes a directory under Herdr's config dir; whether that
	// session is running is a 3am fact, not a load-time one.
	if a.Session != "" && (strings.ContainsAny(a.Session, "/\\ \t\n") || strings.HasPrefix(a.Session, ".")) {
		return fmt.Errorf("%s: session %q is not a Herdr session name", a.Name, a.Session)
	}
	if a.Session != "" && backend == BackendHC {
		return fmt.Errorf("%s: session names a Herdr TUI session; it means nothing under backend: hc", a.Name)
	}
	if a.Template != "" && backend != BackendHC {
		return fmt.Errorf("%s: template requires backend: hc", a.Name)
	}
	if a.Template == "" && backend == BackendHC && !KindTakesPromptArg(a.Agent) {
		return fmt.Errorf("%s: agent %q cannot take its prompt under backend: hc yet (claude, codex, pi and copilot can)", a.Name, a.Agent)
	}
	if a.Workflow != "" && backend == BackendHC {
		return fmt.Errorf("%s: workflow drives the Herdr TUI; it cannot run under backend: hc", a.Name)
	}
	if a.Model != "" && !KindAcceptsModel(a.Agent) {
		return fmt.Errorf("%s: agent %q takes no --model; put the flag it does take in agent_args", a.Name, a.Agent)
	}
	return nil
}

// validateCommand checks a command entry. It runs before any default is
// filled in for the agent keys (applyDefaults leaves them alone for a
// command), so a key that is set here is one somebody wrote.
func (a *Automation) validateCommand() error {
	c := a.Command
	if len(c.Argv) == 0 || strings.TrimSpace(c.Argv[0]) == "" {
		return fmt.Errorf("%s: command needs argv, the program first", a.Name)
	}
	if c.Cwd != "" && !filepath.IsAbs(c.Cwd) {
		return fmt.Errorf("%s: command cwd must be an absolute path or start with ~/, got %q", a.Name, c.Cwd)
	}
	for k := range c.Env {
		if k == "" || strings.ContainsAny(k, "=\x00 \t\n") {
			return fmt.Errorf("%s: command env name %q is not a variable name", a.Name, k)
		}
	}
	// A command starts no agent and opens no workspace. A key that only means
	// something to those is a mistake to say out loud, not to ignore.
	for _, k := range []struct {
		name string
		set  bool
	}{
		{"repo (the working folder is command.cwd)", a.Repo != ""},
		{"workspace", a.Workspace != ""},
		{"workspace_id", a.WorkspaceID != ""},
		{"session", a.Session != ""},
		{"agent", a.Agent != ""},
		{"template", a.Template != ""},
		{"model", a.Model != ""},
		{"mcp_config", a.MCPConfig != ""},
		{"agent_args", len(a.AgentArgs) > 0},
		{"blocked_grace_minutes", a.BlockedGraceMinutes != 0},
		{"close_workspace", a.CloseWorkspace != "" && a.CloseWorkspace != CloseNever},
	} {
		if k.set {
			return fmt.Errorf("%s: a command starts no agent and opens no workspace; drop %s", a.Name, k.name)
		}
	}
	if strings.ContainsAny(a.Notify, " \t\n") || strings.HasPrefix(a.Notify, "-") {
		return fmt.Errorf("%s: notify %q is not a bot id or a terminal name", a.Name, a.Notify)
	}
	return nil
}

// validateTarget checks a bot or worker target. A target run opens no space and
// starts no agent of its own — the bot's launch, or its worker's, is the whole
// point — so an entry that still names one is a mistake to say out loud, not
// to ignore. It also has to run in herdr-core, where bots live.
func (a *Automation) validateTarget(backend Backend) error {
	kind, bot, err := SplitTarget(a.Target)
	if err != nil {
		return fmt.Errorf("%s: %w", a.Name, err)
	}
	if a.Command != nil {
		return fmt.Errorf("%s: a target hands over a prompt; a command cannot also name one", a.Name)
	}
	if a.Workflow != "" {
		return fmt.Errorf("%s: a target hands over a prompt; a workflow cannot be sent to a bot", a.Name)
	}
	if a.Repo == "" {
		return fmt.Errorf("%s: a target needs repo: the project whose .herdr/bots.json names %s", a.Name, bot)
	}
	if a.BlockedGraceMinutes < -1 {
		return fmt.Errorf("%s: blocked_grace_minutes must be -1, 0 (the default) or a positive number, got %d",
			a.Name, a.BlockedGraceMinutes)
	}
	switch a.TargetWhenBusy {
	case "":
	case TargetQueue, TargetSkip:
		if kind == TargetWorker {
			return fmt.Errorf("%s: target_when_busy is a bot target's; a worker runs alongside its bot", a.Name)
		}
	default:
		return fmt.Errorf("%s: target_when_busy must be queue or skip, got %q", a.Name, a.TargetWhenBusy)
	}
	for _, k := range []struct {
		name string
		set  bool
	}{
		{"workspace", a.Workspace != ""},
		{"workspace_id", a.WorkspaceID != ""},
		{"session", a.Session != ""},
		{"agent", a.Agent != ""},
		{"template", a.Template != ""},
		{"model", a.Model != ""},
		{"mcp_config", a.MCPConfig != ""},
		{"agent_args", len(a.AgentArgs) > 0},
		{"notify", a.Notify != ""},
		{"close_workspace", a.CloseWorkspace != "" && a.CloseWorkspace != CloseNever},
	} {
		if k.set {
			return fmt.Errorf("%s: a target run uses the bot's own launch and opens no space; drop %s", a.Name, k.name)
		}
	}
	if backend == BackendHerdr {
		return fmt.Errorf("%s: a target runs in herdr-core, where bots live; set backend: hc", a.Name)
	}
	return nil
}

// Kind is what a run of this automation is: "command", "workflow" or "prompt".
func (a Automation) Kind() string {
	switch {
	case a.Command != nil:
		return "command"
	case a.Workflow != "":
		return "workflow"
	}
	return "prompt"
}

// Kinds are the kinds of work this build can run, for `ls --json`: a panel
// offers a kind only when the scheduler it drives names it.
var Kinds = []string{"prompt", "workflow", "command"}

// modelFlagKinds are the agent kinds whose executable takes `--model`. Herdr
// forwards the flag verbatim, so a model: on any other kind would make the
// agent refuse to start — better to fail here, while the file is being
// written, than at 3am inside a scheduler goroutine.
//
// This is a known-good allowlist, not a gate: `herdr agent start --help`
// accepts more kinds than this table lists (see ADR 0003), and a kind missing
// here is a false rejection, not a safety net doing its job.
var modelFlagKinds = map[string]bool{
	"claude":   true,
	"codex":    true,
	"cursor":   true,
	"gemini":   true,
	"opencode": true,
	"grok":     true,
	"qwen":     true,
	"kimi":     true,
	"amp":      true,
	"droid":    true,
	"copilot":  true,
	"hermes":   true,
	"pi":       true,
}

// KindAcceptsModel reports whether this agent kind understands `--model`.
func KindAcceptsModel(kind string) bool { return modelFlagKinds[kind] }

// promptFlags are the agent kinds the hc host can run, and the flag each
// puts in front of its first message ("" for a bare trailing argument). They
// also report their state to hc (OSC 7501), without which a run can't be told
// done from stuck. Measured on 2026-10-30: claude, pi and copilot report;
// opencode reports nothing; codex is assumed from its CLI, not measured.
// copilot needs -i: a bare argument is "Invalid command format", and -p would
// exit after one answer. Herdr's TUI watches agents' screens itself, which is
// why it supports more of them.
var promptFlags = map[string]string{
	"claude":  "",
	"codex":   "",
	"pi":      "",
	"copilot": "-i",
}

// KindTakesPromptArg reports whether this agent kind takes its prompt on its
// command line.
func KindTakesPromptArg(kind string) bool { _, ok := promptFlags[kind]; return ok }

// PromptArgs is how this agent kind's command line carries its first message.
func PromptArgs(kind, prompt string) []string {
	if flag := promptFlags[kind]; flag != "" {
		return []string{flag, prompt}
	}
	return []string{prompt}
}

// defaultAgentArgs are the flags a new automation starts its agent with when
// the request names none: the automatic mode, in which an unattended run can
// work at all (codex outside its sandbox and approvals, claude past its
// permission prompts). The panel's form writes the same words for a new entry
// (AUTO_ARGS in mods/am-automations/modes.js; a test holds the two tables
// equal), so an automation a bot writes with `put` runs with the access the
// same one made in the form has (#938).
var defaultAgentArgs = map[string][]string{
	"codex":  {"--dangerously-bypass-approvals-and-sandbox"},
	"claude": {"--dangerously-skip-permissions"},
}

// DefaultAgentArgs returns the automatic mode's flags for a new automation
// run by this agent kind ("" is the default agent), or nil when the kind has
// none. The slice is the caller's.
func DefaultAgentArgs(kind string) []string {
	if kind == "" {
		kind = "claude"
	}
	return append([]string(nil), defaultAgentArgs[kind]...)
}

// Dir is where automations.yaml lives.
func Dir() string { return hostpath.ConfigDir() }

// StateDir is where run history and scheduler state live.
func StateDir() string { return hostpath.StateDir() }

func Path() string { return filepath.Join(Dir(), "automations.yaml") }

// Load reads the config. A missing file is an empty config, not an error: the
// daemon idles until the first automation exists. An unreadable or unparseable
// file is an error — there is nothing to run and nothing to point at. Anything
// short of that is a Diagnostic on Config.Invalid, and the entries that did
// load still run.
func Load() (*Config, error) {
	raw, err := os.ReadFile(Path())
	if os.IsNotExist(err) {
		return &Config{}, nil
	}
	if err != nil {
		return nil, err
	}
	return parse(raw)
}

// parse is Load without the file, so an edit can be checked before it is
// written.
func parse(raw []byte) (*Config, error) {
	// Decoding through yaml.Node rather than straight into Config is what buys
	// the line numbers: a diagnostic that cannot say where to look is only
	// marginally better than silence.
	var doc struct {
		Backend     Backend     `yaml:"backend"`
		Paused      bool        `yaml:"paused"`
		Automations []yaml.Node `yaml:"automations"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", Path(), err)
	}
	switch doc.Backend {
	case "":
		doc.Backend = BackendHerdr
	case BackendAuto, BackendHerdr, BackendHC:
	default:
		return nil, fmt.Errorf("%s: backend must be herdr, hc or auto, got %q", Path(), doc.Backend)
	}

	cfg := &Config{Backend: doc.Backend, Paused: doc.Paused}
	seen := map[string]bool{}
	for _, node := range doc.Automations {
		var a Automation
		if err := node.Decode(&a); err != nil {
			cfg.Invalid = append(cfg.Invalid, Diagnostic{
				Name: nameOf(node), Line: node.Line, Message: cleanYAMLError(err),
			})
			continue
		}
		a.Line = node.Line
		// Checked before the defaults fill Agent in: a template brings its own.
		if a.Template != "" && (a.Agent != "" || a.Model != "") {
			cfg.Invalid = append(cfg.Invalid, Diagnostic{
				Name: a.Name, Line: a.Line,
				Message: fmt.Sprintf("%s: template replaces agent and model; drop them", a.Name),
			})
			continue
		}
		a.applyDefaults()
		a.Repo = expandHome(a.Repo)
		a.MCPConfig = expandHome(a.MCPConfig)
		if a.Command != nil {
			a.Command.Cwd = expandHome(a.Command.Cwd)
		}

		if err := a.validate(cfg.Backend); err != nil {
			cfg.Invalid = append(cfg.Invalid, Diagnostic{
				Name: a.Name, Line: a.Line, Message: err.Error(),
			})
			continue
		}
		if seen[a.Name] {
			cfg.Invalid = append(cfg.Invalid, Diagnostic{
				Name: a.Name, Line: a.Line,
				Message: fmt.Sprintf("%s: an automation by that name is already declared above", a.Name),
			})
			continue
		}
		seen[a.Name] = true
		cfg.Automations = append(cfg.Automations, a)
	}
	return cfg, nil
}

// nameOf recovers just the name from an entry too malformed to decode whole,
// so the diagnostic can still say which automation it is about.
func nameOf(node yaml.Node) string {
	var partial struct {
		Name string `yaml:"name"`
	}
	if node.Decode(&partial) != nil {
		return ""
	}
	return partial.Name
}

// cleanYAMLError trims the library's line prefix: the diagnostic carries the
// entry's own line, which is the one worth opening.
func cleanYAMLError(err error) string {
	msg := err.Error()
	if _, rest, found := strings.Cut(msg, ": "); found && strings.HasPrefix(msg, "yaml: line ") {
		return rest
	}
	return strings.TrimPrefix(msg, "yaml: ")
}

// Save writes the config back, creating the directory on first use.
//
// It refuses while anything in the file failed to load. Save marshals what the
// Config holds, and a Config holds only the entries that loaded — so writing
// one back over a file with a broken entry in it deletes that entry. The wizard
// does read-append-save, which is how `add` would silently eat an automation
// with a typo in it.
func Save(cfg *Config) error {
	if len(cfg.Invalid) > 0 {
		return fmt.Errorf("%s has %d entr%s that did not load; fix %s first",
			filepath.Base(Path()), len(cfg.Invalid),
			plural(len(cfg.Invalid), "y", "ies"), cfg.Invalid[0])
	}
	if err := os.MkdirAll(Dir(), 0o755); err != nil {
		return err
	}
	// herdr is the default: writing it would add a line to every file saved.
	out := *cfg
	if out.Backend == BackendHerdr {
		out.Backend = ""
	}
	raw, err := yaml.Marshal(&out)
	if err != nil {
		return err
	}
	return os.WriteFile(Path(), raw, 0o644)
}

// Find returns the automation named name, or nil.
func (c *Config) Find(name string) *Automation {
	for i := range c.Automations {
		if c.Automations[i].Name == name {
			return &c.Automations[i]
		}
	}
	return nil
}

// Diagnostic returns the reason an automation by that name did not load, or
// nil. "No automation named x" is the wrong thing to say about one that is
// right there in the file with a broken cron.
func (c *Config) Diagnostic(name string) *Diagnostic {
	for i := range c.Invalid {
		if c.Invalid[i].Name == name {
			return &c.Invalid[i]
		}
	}
	return nil
}

// Declares reports whether the file mentions this name at all, valid or not.
// The wizard needs it: refusing a duplicate only when the existing entry
// happens to be valid writes a second one nobody asked for.
func (c *Config) Declares(name string) bool {
	return c.Find(name) != nil || c.Diagnostic(name) != nil
}

// plural picks a suffix without making the caller write a map literal.
func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func expandHome(p string) string {
	if len(p) >= 2 && p[:2] == "~/" {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, p[2:])
	}
	return p
}
