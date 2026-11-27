// Package hc is a thin client over herdr-core's CLI, the backend of the Herdr
// desktop app. Where that binary lives is hostpath's problem.
package hc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/DnzzL/herdr-automations/internal/hostpath"
)

// Client talks to the hc CLI. The zero value is ready.
type Client struct{}

// Wait is one `hc wait` answer, trimmed to what a run needs.
type Wait struct {
	// Ended is false when the wait only checked in (reason "timeout").
	Ended bool `json:"ended"`
	// Reason is status, exit, output, timeout or not_started.
	Reason string `json:"reason"`
	// Status is the agent's own word when Reason is status: idle, working,
	// done, blocked or error.
	Status   string `json:"status"`
	Turn     int    `json:"turn"`
	ExitCode *int   `json:"exit_code"`
}

// Terminal is one `hc get` answer, trimmed.
type Terminal struct {
	State string `json:"state"`
	// Reason is why a finished terminal finished: exited, or killed (its pane
	// was closed in the app).
	Reason   string `json:"reason"`
	ExitCode *int   `json:"exit_code"`
	// Status is what the agent last reported, nil when it never has.
	Status *struct {
		State string `json:"state"`
	} `json:"status"`
	// Address, CreatedMS, Cwd, Labels and Foreground are the pane's identity:
	// what tells a target's live terminal apart from a stale shell, another
	// project's pane, or a terminal that merely carries the same label (#498).
	Address    string            `json:"address"`
	CreatedMS  int64             `json:"created_ms"`
	Cwd        string            `json:"cwd"`
	Parent     string            `json:"parent"`
	Labels     map[string]string `json:"labels"`
	Foreground *Foreground       `json:"foreground"`
}

// Foreground is the program in front of a pane: a shell when its agent has
// quit, the agent itself while it runs.
type Foreground struct {
	Argv []string `json:"argv"`
}

// ErrNotFound is hc's answer about a terminal it does not have, or no longer.
var ErrNotFound = errors.New("no such terminal")

func run(out any, args ...string) error {
	return runCommand(exec.Command(hostpath.HCBin(), args...), out, args...)
}

func runCommand(cmd *exec.Cmd, out any, args ...string) error {
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		var e struct {
			Error struct {
				Kind string `json:"kind"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(msg), &e) == nil && e.Error.Kind == "not_found" {
			return fmt.Errorf("hc %s: %s (%w)", args[0], msg, ErrNotFound)
		}
		return fmt.Errorf("hc %s: %s (%w)", args[0], msg, err)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(stdout.Bytes(), out); err != nil {
		return fmt.Errorf("hc %s: unexpected output %q: %w", args[0], stdout.String(), err)
	}
	return nil
}

// Run starts argv in a new kept terminal at cwd and returns its address. The
// terminal has no parent: the daemon is not one, and a run must outlive it.
func (Client) Run(cwd string, labels map[string]string, argv []string) (string, error) {
	args := []string{"run", "--bg", "--keep", "--no-parent", "--json", "--cwd", cwd}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "--label", k+"="+labels[k])
	}
	args = append(args, "--")
	args = append(args, argv...)
	var res struct {
		Address string `json:"address"`
	}
	if err := run(&res, args...); err != nil {
		return "", err
	}
	if res.Address == "" {
		return "", fmt.Errorf("hc run: no address in the answer")
	}
	return res.Address, nil
}

// Wait blocks until the terminal stops working, exits, or timeout passes.
func (Client) Wait(address string, timeout time.Duration) (Wait, error) {
	secs := max(1, int(timeout.Seconds()))
	var w Wait
	err := run(&w, "wait", address, "--json", "--timeout", strconv.Itoa(secs))
	return w, err
}

// Get reads one terminal's state.
func (Client) Get(address string) (Terminal, error) {
	var t Terminal
	err := run(&t, "get", address, "--json")
	return t, err
}

// Terminals lists the live terminals carrying every given label, by address.
func (Client) Terminals(labels map[string]string) ([]string, error) {
	args := []string{"ls", "--json"}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "--label", k+"="+labels[k])
	}
	var res struct {
		Terminals []struct {
			Address string `json:"address"`
		} `json:"terminals"`
	}
	if err := run(&res, args...); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(res.Terminals))
	for _, t := range res.Terminals {
		out = append(out, t.Address)
	}
	return out, nil
}

// Read returns the terminal's screen as plain text, without its history. It is
// what a blocked run quotes in its failure line. A read gets at most ten seconds.
func (Client) Read(address string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var res struct {
		Text string `json:"text"`
	}
	args := []string{"read", address, "--json"}
	err := runCommand(exec.CommandContext(ctx, hostpath.HCBin(), args...), &res, args...)
	return res.Text, err
}

// sendTimeout bounds one hc send. hc waits for a person typing in that
// terminal to pause; a report is not worth holding a run's slot for longer.
const sendTimeout = 2 * time.Minute

// SendError is a refusal reported by hc as a JSON error envelope.
type SendError struct {
	Envelope string
	message  string
	err      error
}

func (e *SendError) Error() string { return "hc send: " + e.message }

func (e *SendError) Unwrap() error { return e.err }

func sendErrorMessage(raw string) string {
	var envelope, body map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &envelope) != nil || json.Unmarshal(envelope["error"], &body) != nil {
		return ""
	}
	var kind *string
	var message string
	if json.Unmarshal(body["kind"], &kind) != nil || kind == nil || json.Unmarshal(body["message"], &message) != nil {
		return ""
	}
	return strings.Join(strings.Fields(message), " ")
}

// deliveryTarget asks the pack that owns the seat and its parked-restart records.
func deliveryTarget(ctx context.Context, address string) (string, error) {
	out, err := exec.CommandContext(ctx, hostpath.AmBin(), "delivery-status", address, "--json").Output()
	if err != nil {
		return "", fmt.Errorf("automatic delivery to %s held: the pack could not check the terminal: %w", address, err)
	}
	var status struct {
		Terminal string `json:"terminal"`
		Held     *bool  `json:"held"`
	}
	if err := json.Unmarshal(out, &status); err != nil || status.Held == nil || status.Terminal == "" || strings.HasPrefix(status.Terminal, "-") {
		return "", fmt.Errorf("automatic delivery to %s held: the pack returned no terminal status", address)
	}
	if *status.Held {
		return "", fmt.Errorf("automatic delivery to %s held: the terminal is waiting for a person", status.Terminal)
	}
	return status.Terminal, nil
}

// Send pastes text into a terminal and submits it: how one bot messages
// another. hc refuses a terminal whose program is blocked on a dialog, and
// that refusal is the answer: a report never answers somebody's dialog.
func (Client) Send(address, text string) error {
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	terminal, err := deliveryTarget(ctx, address)
	if err != nil {
		return err
	}
	// "--" keeps a text that starts with a dash from being read as a flag.
	cmd := exec.CommandContext(ctx, hostpath.HCBin(), "send", "--json", "--", terminal, text)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("hc send: no answer within %s", sendTimeout)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if message := sendErrorMessage(msg); message != "" {
			return &SendError{Envelope: msg, message: message, err: err}
		}
		return fmt.Errorf("hc send: %s (%w)", msg, err)
	}
	return nil
}

// Kill ends a terminal's program. A finished terminal is fine.
func (Client) Kill(address string) error { return run(nil, "kill", address, "--json") }

// Rm removes a finished terminal, so hc ls --all stops listing it.
func (Client) Rm(address string) error { return run(nil, "rm", address, "--json") }

// Available reports whether herdr-core answers on this machine.
func Available() bool {
	return exec.Command(hostpath.HCBin(), "server", "status").Run() == nil
}
