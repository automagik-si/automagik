package history

import (
	"bytes"
	"log"
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestAppendWarnsAndWritesWhenChmodFails(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	// Linux allows writing a thread's name, but rejects chmod on the proc file.
	// Restore the name before returning the thread to the runtime.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	const comm = "/proc/thread-self/comm"
	name, err := os.ReadFile(comm)
	if os.IsNotExist(err) {
		t.Skip("procfs is unavailable")
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.WriteFile(comm, bytes.TrimSuffix(name, []byte("\n")), 0o600); err != nil {
			t.Error(err)
		}
	}()
	if err := os.Symlink(comm, path()); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	output := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(output) })

	if err := Append(Record{RunID: "probe"}); err != nil {
		t.Fatalf("chmod failure blocked append: %v", err)
	}
	got, err := os.ReadFile(comm)
	if err != nil || !bytes.HasPrefix(got, []byte(`{"run_id":"prob`)) {
		t.Fatalf("record prefix = %q, %v", got, err)
	}
	if !strings.Contains(logs.String(), "could not restrict history permissions") {
		t.Fatalf("missing chmod warning: %q", logs.String())
	}
}
