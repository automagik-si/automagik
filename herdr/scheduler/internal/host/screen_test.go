package host

import (
	"strings"
	"testing"
)

// The screen a blocked agent draws is the last place its dialog can be read:
// the question, not the box around it or the keys below it.
func TestPromptLineFindsTheDialogQuestion(t *testing.T) {
	screen := "╭──────────────────────────╮\n" +
		"\x1b[1m│ Bash command             │\x1b[0m\n" +
		"╰──────────────────────────╯\n" +
		"  Do you want to proceed?\r\n" +
		"❯ 1. Yes\n" +
		"  2. No\n" +
		"Esc to cancel\n"
	if got := promptLine(screen); got != "Do you want to proceed?" {
		t.Fatalf("promptLine = %q", got)
	}
}

func TestPromptLineStripsControlCharactersAndBoundsLength(t *testing.T) {
	long := "Do you want to \x07proceed? " + strings.Repeat("x", 300)
	got := promptLine("\x1b[31m" + long + "\x1b[0m")
	if strings.ContainsAny(got, "\x07\x1b") {
		t.Fatalf("control characters survived: %q", got)
	}
	if len([]rune(got)) != promptLimit {
		t.Fatalf("line is %d runes, want %d", len([]rune(got)), promptLimit)
	}
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("a clipped line should say so: %q", got)
	}
}

// Without a recognizable question, the last non-empty line that is not chrome
// is still better than saying nothing.
func TestPromptLineFallsBackToTheLastRealLine(t *testing.T) {
	if got := promptLine("working\n\n  Waiting for approval  \n---\nEsc to cancel\n"); got != "Waiting for approval" {
		t.Fatalf("promptLine = %q", got)
	}
	if got := promptLine("---\n\n"); got != "" {
		t.Fatalf("promptLine = %q, want empty", got)
	}
}

func TestScreenTailKeepsTheLastTwelvePlainLines(t *testing.T) {
	screen := "old output\n" + strings.Repeat("line\n", 11) + "\x1b[31mfinal line\x1b[0m\n\n"
	want := strings.Repeat("line\n", 11) + "final line"
	if got := screenTail(screen); got != want {
		t.Fatalf("screen tail = %q, want %q", got, want)
	}
}
