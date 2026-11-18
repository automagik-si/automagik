package host

import (
	"regexp"
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
