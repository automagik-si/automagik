package host

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/hc"
)

// Previous also checks the core's labels, since a scheduler can stop between
// launching a terminal and writing its address to history.
func (h *hcHost) Previous(a config.Automation, known []Session) ([]Session, error) {
	addresses, err := h.ops.Terminals(map[string]string{"automation": a.Name})
	if err != nil {
		return nil, err
	}
	candidates := make(map[string][]Session)
	workerBots := make(map[string]bool)
	for _, s := range known {
		if localAddress(s.PaneID) && s.HerdrSession == "" {
			candidates[s.PaneID] = append(candidates[s.PaneID], s)
			if s.CleanupPending {
				addresses = append(addresses, s.PaneID)
			} else if kind, id, err := config.SplitTarget(s.Target); err == nil && kind == config.TargetWorker {
				workerBots[id] = true
			}
		}
	}
	for bot := range workerBots {
		workers, err := h.ops.Terminals(map[string]string{"worker.of": bot})
		if err != nil {
			return nil, err
		}
		for _, address := range workers {
			if len(candidates[address]) > 0 {
				addresses = append(addresses, address)
			}
		}
	}
	seen := make(map[string]bool)
	var previous []Session
	for _, address := range addresses {
		if !localAddress(address) || seen[address] {
			continue
		}
		seen[address] = true
		t, err := h.ops.Get(address)
		if errors.Is(err, hc.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if s, ok := previousWorker(t, a.Name, candidates[address]); ok {
			previous = append(previous, s)
			continue
		}
		space, tab := t.Labels["herdr.space"], t.Labels["herdr.tab"]
		if !runTerminal(t, address, a.Name) {
			continue
		}
		// A terminal without a mode label may belong to a shared space,
		// even if this automation now runs in a space of its own.
		s := Session{WorkspaceID: space, TabID: tab, PaneID: address,
			TerminalID: hcIdentity(t), Workspace: config.Workspace(t.Labels["automation.workspace"])}
		for _, old := range candidates[address] {
			if old.WorkspaceID != space || old.TabID != "" && old.TabID != tab ||
				old.TerminalID != "" && old.TerminalID != s.TerminalID {
				continue
			}
			s.CleanupPending = old.CleanupPending
			break
		}
		if t.State == "live" || s.CleanupPending {
			previous = append(previous, s)
		}
	}
	return previous, nil
}

func hcIdentity(t hc.Terminal) string {
	return fmt.Sprint(t.CreatedMS)
}

func localAddress(address string) bool {
	return address != "" && !strings.ContainsAny(address, "/:")
}

func runTerminal(t hc.Terminal, address, name string) bool {
	return localAddress(address) && (t.Address == "" || t.Address == address) &&
		t.Labels["automation"] == name && t.Labels["bot"] == "" && t.Labels["worker.of"] == "" &&
		t.Labels["herdr.space"] != "" && t.Labels["herdr.tab"] != ""
}

func workerTerminal(t hc.Terminal, s Session, automation string) bool {
	kind, bot, err := config.SplitTarget(s.Target)
	when, branchMatches := strings.CutPrefix(t.Labels["branch"], "auto/"+slug(automation)+"-")
	_, branchErr := time.Parse("20060102-1504", when)
	return err == nil && kind == config.TargetWorker && branchMatches && branchErr == nil && localAddress(s.PaneID) &&
		t.Address == s.PaneID && t.Labels["worker.of"] == bot && t.Labels["bot"] == "" &&
		localAddress(t.Parent) && (s.TargetParent == "" || t.Parent == s.TargetParent) &&
		t.CreatedMS > 0 && (s.TerminalID == "" || hcIdentity(t) == s.TerminalID)
}

func previousWorker(t hc.Terminal, name string, known []Session) (Session, bool) {
	for _, s := range known {
		if !workerTerminal(t, s, name) || t.State != "live" && !s.CleanupPending {
			continue
		}
		// Older worker rows have no launch identity. Their worker must have
		// been created during that run, otherwise the address could be reused.
		if s.TerminalID == "" && (s.Started.IsZero() || t.CreatedMS < s.Started.UnixMilli() ||
			t.CreatedMS > s.Observed.UnixMilli()) {
			continue
		}
		s.TerminalID, s.TargetParent = hcIdentity(t), t.Parent
		s.WorkspaceID, s.TabID = t.Labels["herdr.space"], t.Labels["herdr.tab"]
		return s, true
	}
	return Session{}, false
}

func (h *hcHost) Screen(s Session) (string, error) {
	t, err := h.ops.Get(s.PaneID)
	if err != nil {
		return "", err
	}
	if t.Labels["herdr.space"] != s.WorkspaceID || t.Labels["herdr.tab"] != s.TabID ||
		s.TerminalID != "" && hcIdentity(t) != s.TerminalID {
		return "", fmt.Errorf("terminal identity changed")
	}
	screen, err := h.ops.Read(s.PaneID)
	return screenTail(screen), err
}

func (h *hcHost) Remove(s Session, a config.Automation) error {
	unlock := lockWorkspaceClose("hc", s.WorkspaceID)
	defer unlock()

	t, err := h.ops.Get(s.PaneID)
	if errors.Is(err, hc.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	owned := runTerminal(t, s.PaneID, a.Name)
	if s.Target != "" {
		owned = s.TerminalID != "" && workerTerminal(t, s, a.Name)
	}
	if !owned || t.Labels["herdr.space"] != s.WorkspaceID ||
		t.Labels["herdr.tab"] != s.TabID || s.TerminalID != "" && hcIdentity(t) != s.TerminalID {
		return fmt.Errorf("terminal identity changed")
	}
	if s.WorkspaceID != "" && s.Workspace != config.WorkspaceWorktree && s.Workspace != config.WorkspaceRoot {
		if err := h.preserveSpace(s, t.Cwd); err != nil {
			return err
		}
	}
	if t.State == "live" {
		if err := h.ops.Kill(s.PaneID); err != nil && !errors.Is(err, hc.ErrNotFound) {
			return err
		}
	}
	// Recheck the identity after ending the program, before deleting its record.
	current, err := h.ops.Get(s.PaneID)
	if errors.Is(err, hc.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if current.CreatedMS != t.CreatedMS || current.Labels["herdr.tab"] != s.TabID {
		return fmt.Errorf("terminal identity changed after kill")
	}
	if err := h.ops.Rm(s.PaneID); err != nil && !errors.Is(err, hc.ErrNotFound) {
		return err
	}
	return nil
}

func (h *hcHost) preserveSpace(s Session, cwd string) error {
	peers, err := h.ops.Terminals(map[string]string{"herdr.space": s.WorkspaceID})
	if err != nil {
		return fmt.Errorf("check the space's last tab: %w", err)
	}
	for _, peer := range peers {
		if peer == s.PaneID || !localAddress(peer) {
			continue
		}
		t, err := h.ops.Get(peer)
		if errors.Is(err, hc.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if t.State == "live" && t.Labels["herdr.space"] == s.WorkspaceID && t.Labels["herdr.tab"] != "" {
			return nil
		}
	}
	// Give the existing space a shell in the same tab before removing its last
	// terminal. The shell carries no automation label and is never reaped.
	_, err = h.ops.Run(cwd, map[string]string{"herdr.space": s.WorkspaceID, "herdr.tab": s.TabID}, nil)
	if err != nil {
		return fmt.Errorf("keep the space's last tab: %w", err)
	}
	return nil
}
