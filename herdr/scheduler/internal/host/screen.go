package host

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// promptLimit bounds the dialog line a failed run carries. History and toasts
// are one-line things; a screen can be a whole window.
const promptLimit = 200

var (
	ansiEscape = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`)
	ruleLine   = regexp.MustCompile(`^[\s\-_=~─━═╌╭╮╰╯│┃┏┓┗┛┣┫┳┻╋┼┠┨┯┷┿╂]+$`)
	optionLine = regexp.MustCompile(`^(?:[❯›>]\s*)?\d+[.)]\s+\S`)
	promptWord = regexp.MustCompile(`(?i)(^|[^a-z])(do you want|would you like|allow|approve|confirm|proceed|continue|trust)([^a-z]|$)`)
)

// promptLine picks the line of a blocked agent's screen that a person would
// call the question: the last non-empty line that reads like one, else the
// last line that is not a rule, an option or a key hint. Control characters
// and ANSI escapes are stripped, and the answer is bounded to promptLimit.
func promptLine(screen string) string {
	lines := strings.Split(screen, "\n")
	fallback := ""
	for i := len(lines) - 1; i >= 0; i-- {
		line := cleanLine(lines[i])
		if line == "" || ruleLine.MatchString(line) {
			continue
		}
		if optionLine.MatchString(line) {
			continue
		}
		if promptWord.MatchString(line) {
			return clipPrompt(line)
		}
		if fallback == "" && !keyHint(line) {
			fallback = line
		}
	}
	return clipPrompt(fallback)
}

// dialogLine picks the last question with an answer option below it. A word
// like "continue" in ordinary output is not enough to call it a dialog.
func dialogLine(screen string) string {
	lines := strings.Split(screen, "\n")
	hasOption := false
	for i := len(lines) - 1; i >= 0; i-- {
		line := cleanLine(lines[i])
		// An option is an answer, never the question, even when it reads like
		// one ("1. Yes, proceed").
		if optionLine.MatchString(line) {
			hasOption = true
			continue
		}
		if hasOption && promptWord.MatchString(line) {
			return clipPrompt(line)
		}
	}
	return ""
}

// A silent agent may print arbitrary text. Look for a selected choice and a
// key hint before treating its output as an interactive startup dialog.
func startupDialogLine(screen, prompt string) string {
	lines := strings.Split(screen, "\n")
	hint, selected := false, false
	for i := len(lines) - 1; i >= 0; i-- {
		line := cleanLine(lines[i])
		if keyHint(line) {
			hint = true
			continue
		}
		text := strings.TrimSpace(strings.TrimLeft(line, "❯›>"))
		if optionLine.MatchString(line) {
			selected = selected || hint && text != line
			continue
		}
		if selected && promptWord.MatchString(text) {
			// A prompt can be echoed with a leading glyph and soft line wraps.
			promptText := strings.Join(strings.Fields(cleanLine(prompt)), " ")
			if strings.Contains(promptText, strings.Join(strings.Fields(text), " ")) {
				return ""
			}
			return clipPrompt(text)
		}
	}
	return ""
}

// cleanLine removes escapes and control characters, trims the result, and
// takes off the box edge a dialog's question can sit inside.
func cleanLine(line string) string {
	line = ansiEscape.ReplaceAllString(line, "")
	var b strings.Builder
	for _, r := range line {
		switch {
		case r == '\t':
			b.WriteByte(' ')
		case unicode.IsControl(r):
		default:
			b.WriteRune(r)
		}
	}
	return strings.Trim(strings.TrimSpace(b.String()), "│┃║ ")
}

// keyHint is the footer an agent draws under a dialog ("Esc to cancel", "Press
// enter to confirm"): not the question, and never the last thing worth saying.
func keyHint(line string) bool {
	lower := strings.ToLower(line)
	for _, prefix := range []string{
		"esc to ", "enter to ", "press ", "tab to ", "? for ",
		"ctrl+", "shift+", "alt+", "cmd+", "⌘", "⇧",
	} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

// clipPrompt truncates on a rune boundary, so a multi-byte character split
// mid-sequence does not turn into mojibake.
func clipPrompt(line string) string {
	r := []rune(line)
	if len(r) <= promptLimit {
		return string(r)
	}
	return string(r[:promptLimit-1]) + "…"
}

// screenTail keeps a bounded, plain-text excerpt in the run's history.
func screenTail(screen string) string {
	lines := strings.Split(screen, "\n")
	tail := make([]string, 0, 12)
	for i := len(lines) - 1; i >= 0 && len(tail) < cap(tail); i-- {
		line := cleanLine(lines[i])
		if line != "" {
			tail = append(tail, clipPrompt(line))
		}
	}
	slices.Reverse(tail)
	return strings.Join(tail, "\n")
}

func dialogError(line string) error {
	if line == "" {
		return fmt.Errorf("blocked on a dialog")
	}
	return fmt.Errorf("blocked on a dialog: %s", line)
}
