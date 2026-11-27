package host

import "testing"

func TestStartupDialogLineRequiresInteractiveCues(t *testing.T) {
	cases := []struct {
		name, screen, want string
	}{
		{"trust dialog", trustScreen, "Do you trust the files in this folder?"},
		{"permission dialog with escapes", "\x1b[1mBash command\x1b[0m\n  Do you want to proceed?\r\n❯ 1. Yes\n  2. No\nEsc to cancel\n", "Do you want to proceed?"},
		{"prompt word without options", "Should I continue with the next page?\n", ""},
		{"options without a question", "Pick one\n1. alpha\n2. beta\n", ""},
		{"no key hint", "Do you want to proceed?\n❯ 1. Yes\n  2. No", ""},
		{"no selected option", "Do you want to proceed?\n1. Yes\n2. No\nEsc to cancel", ""},
		{"question below the options is not theirs", "1. alpha\n2. beta\nDo you want to proceed?\n", ""},
		{"the option reads like a question", "Choose\n❯ 1. Yes, proceed\n  2. No, exit\n", ""},
		{"busy screen", busyScreen, ""},
		{"empty", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := startupDialogLine(c.screen, ""); got != c.want {
				t.Fatalf("startupDialogLine = %q, want %q", got, c.want)
			}
		})
	}
}
