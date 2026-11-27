package host

import (
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/herdr"
)

func (h *live) sessionOps(s Session) ops {
	if s.HerdrSession != "" {
		return h.ops.In(s.HerdrSession)
	}
	return h.ops
}

// Previous checks run history against Herdr's pane identity. For older rows,
// also check the provisioning labels before trusting a potentially reused ID.
func (h *live) Previous(a config.Automation, known []Session) ([]Session, error) {
	var previous []Session
	seen := make(map[[2]string]bool)
	panes := make(map[string]map[string]herdr.PaneInfo)
	skipped := make(map[string]string)
	for _, s := range known {
		key := [2]string{s.HerdrSession, s.PaneID}
		if seen[key] || !strings.HasPrefix(s.PaneID, s.WorkspaceID+":") || s.Target != "" {
			continue
		}
		o := h.sessionOps(s)
		byID, listed := panes[s.HerdrSession]
		if !listed {
			list, err := o.PaneList()
			if err != nil {
				skipped[s.HerdrSession] = fmt.Sprintf(
					"skipped terminal cleanup in Herdr session %q: list panes: %v", s.HerdrSession, err)
				log.Printf("%s: %s", a.Name, skipped[s.HerdrSession])
				panes[s.HerdrSession] = nil
			} else {
				byID = make(map[string]herdr.PaneInfo, len(list))
				for _, pane := range list {
					byID[pane.PaneID] = pane
				}
				panes[s.HerdrSession] = byID
			}
		}
		if reason := skipped[s.HerdrSession]; reason != "" {
			s.CleanupSkip = reason
			previous = append(previous, s)
			continue
		}
		pane := byID[s.PaneID]
		if !samePane(s, pane) {
			continue
		}
		if s.TerminalID == "" {
			mode, err := legacyWorkspace(o, a.Name, pane)
			if paneGone(o, err) || o.HasCode(err, "tab_not_found") {
				continue
			}
			if err != nil {
				return nil, err
			}
			if mode == "" {
				continue
			}
			s.Workspace = mode
		}
		s.TerminalID, s.TabID = pane.TerminalID, pane.TabID
		seen[key] = true
		previous = append(previous, s)
	}
	return previous, nil
}

func samePane(s Session, p herdr.PaneInfo) bool {
	return p.PaneID == s.PaneID && p.WorkspaceID == s.WorkspaceID && p.TabID != "" &&
		(s.TabID == "" || p.TabID == s.TabID) && (s.TerminalID == "" || p.TerminalID == s.TerminalID)
}

func legacyWorkspace(o ops, name string, p herdr.PaneInfo) (config.Workspace, error) {
	label, err := o.TabLabel(p.TabID)
	if err != nil {
		return "", err
	}
	if when, ok := strings.CutPrefix(label, "auto: "+name+" "); ok {
		if _, err := time.Parse("2006-01-02 15:04", when); err == nil {
			return config.WorkspaceExisting, nil
		}
	}
	label, err = o.WorkspaceLabel(p.WorkspaceID)
	if err != nil || label != "auto: "+name {
		return "", err
	}
	// Root and worktree use the same label and can both lose the owned pane.
	return config.WorkspaceRoot, nil
}

func paneGone(o ops, err error) bool {
	return o.HasCode(err, herdr.CodePaneGone) || o.HasCode(err, herdr.CodeWorkspaceGone)
}

func (h *live) Screen(s Session) (string, error) {
	o := h.sessionOps(s)
	pane, err := o.PaneGet(s.PaneID)
	if err != nil {
		return "", err
	}
	if !samePane(s, pane) {
		return "", fmt.Errorf("pane identity changed")
	}
	screen, err := o.PaneRead(s.PaneID, 120)
	return screenTail(screen), err
}

func (h *live) Remove(s Session, _ config.Automation) error {
	o := h.sessionOps(s)
	unlock := lockWorkspaceClose(o.CurrentSession(), s.WorkspaceID)
	defer unlock()
	pane, err := o.PaneGet(s.PaneID)
	if paneGone(o, err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !samePane(s, pane) {
		return fmt.Errorf("pane identity changed")
	}
	if s.Workspace == config.WorkspaceExisting || s.Workspace == "" {
		tabs, err := o.TabList(s.WorkspaceID)
		if paneGone(o, err) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("check the space's last tab: %w", err)
		}
		if !slices.Contains(tabs, pane.TabID) {
			return fmt.Errorf("the run's pane is no longer in its tab")
		}
		if len(tabs) == 1 {
			panes, err := o.PaneList()
			if err != nil {
				return fmt.Errorf("check the space's last pane: %w", err)
			}
			hasPeer := slices.ContainsFunc(panes, func(peer herdr.PaneInfo) bool {
				return peer.WorkspaceID == s.WorkspaceID && peer.TabID == pane.TabID &&
					peer.PaneID != "" && peer.PaneID != s.PaneID
			})
			if !hasPeer {
				if err := o.PaneSplit(s.PaneID); err != nil {
					// A blocked agent can still stop without taking the tab with it.
					_, stopErr := o.AgentStop(s.PaneID)
					return errors.Join(fmt.Errorf("keep the space's last tab: %w", err), stopErr)
				}
			}
		}
	}
	if err := o.PaneClose(s.PaneID); !paneGone(o, err) {
		return err
	}
	return nil
}
