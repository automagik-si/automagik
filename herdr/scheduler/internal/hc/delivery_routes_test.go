package hc_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/DnzzL/herdr-automations/internal/config"
	"github.com/DnzzL/herdr-automations/internal/host"
	"github.com/DnzzL/herdr-automations/internal/notify"
)

func TestDeliveryStatusGuardsDispatchedTargetsAndNotifications(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake commands use sh")
	}
	dir := t.TempDir()
	install := func(name, script string) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0700); err != nil {
			t.Fatal(err)
		}
		return path
	}
	t.Setenv("HC_BIN", install("fake-hc", `case "$1" in
get) printf '%s' '{"address":"t7","state":"live","created_ms":100,"labels":{"bot":"b-6jrz4bmxml"},"foreground":{"argv":["claude"]}}' ;;
ls) printf '%s' '{"terminals":[{"address":"t7"}]}' ;;
send) printf '%s\n' "$@" >> "$SENT_ARGS" ;;
*) exit 2 ;;
esac`))
	t.Setenv("AM_BIN", install("fake-am", `[ "$1" = delivery-status ] && [ "$2" = t7 ] && [ "$3" = --json ] || exit 2
printf '%s' "$SEAT_STATUS"`))
	delivery := filepath.Join(dir, "delivery")
	t.Setenv("SENT_ARGS", delivery)
	const target = "bot:b-6jrz4bmxml"
	dispatch := func() error {
		a := config.Automation{Target: target, Prompt: "scheduled task"}
		s := host.Session{PaneID: "t7", Target: target, TargetName: "Housekeeper", TargetCreatedMS: 100}
		return host.NewHC().Do(s, a, time.Minute)
	}
	notification := func() error {
		_, err := notify.NewBots().Send("b-6jrz4bmxml", "scheduler notification")
		return err
	}
	for _, route := range []struct {
		name string
		send func() error
		text string
	}{{"dispatched target", dispatch, "scheduled task"}, {"notification", notification, "scheduler notification"}} {
		t.Run(route.name, func(t *testing.T) {
			for _, result := range []string{`{"terminal":"t7","held":true}`, "unreadable"} {
				t.Setenv("SEAT_STATUS", result)
				if err := route.send(); err == nil || !strings.Contains(err.Error(), "automatic delivery") {
					t.Fatalf("expected delivery-status to hold %s: %v", route.name, err)
				}
				if _, err := os.Stat(delivery); !os.IsNotExist(err) {
					t.Fatalf("held route sent or could not inspect delivery: %v", err)
				}
			}
			t.Setenv("SEAT_STATUS", `{"terminal":"t7","held":false}`)
			if err := route.send(); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(delivery)
			if err != nil || string(got) != "send\n--json\n--\nt7\n"+route.text+"\n" {
				t.Fatalf("unexpected delivery: %q, %v", got, err)
			}
			if err := os.Remove(delivery); err != nil {
				t.Fatal(err)
			}
		})
	}
}
