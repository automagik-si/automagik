package hc

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAutomaticDeliveryChecksTheSeatBeforeSending(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the synthetic command fixtures use sh")
	}
	dir := t.TempDir()
	install := func(name, body string) string {
		t.Helper()
		file := filepath.Join(dir, name)
		if err := os.WriteFile(file, []byte("#!/bin/sh\n"+body), 0700); err != nil {
			t.Fatal(err)
		}
		return file
	}
	argsFile := filepath.Join(dir, "delivery")
	t.Setenv("HC_BIN", install("fake-hc", "printf '%s\\n' \"$@\" > \"$SENT_ARGS\""))
	t.Setenv("AM_BIN", install("fake-am", `[ "$1" = delivery-status ] && [ "$2" = bot-name ] && [ "$3" = --json ] || exit 2
printf '%s' "$SEAT_STATUS"`))
	t.Setenv("SENT_ARGS", argsFile)
	for _, result := range []string{`{"terminal":"t7","held":true}`, "unreadable", `{"terminal":"t7"}`} {
		t.Setenv("SEAT_STATUS", result)
		if err := (Client{}).Send("bot-name", "scheduled note"); err == nil {
			t.Fatal("expected automatic delivery to be held")
		}
		if _, err := os.Stat(argsFile); !os.IsNotExist(err) {
			t.Fatalf("sent or could not inspect delivery: %v", err)
		}
	}
	t.Setenv("SEAT_STATUS", `{"terminal":"t7","held":false}`)
	if err := (Client{}).Send("bot-name", "scheduled note"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(argsFile)
	if err != nil || string(got) != "send\n--json\n--\nt7\nscheduled note\n" {
		t.Fatalf("unexpected delivery arguments: %q, %v", got, err)
	}
}
