package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// The edits here change one thing in automations.yaml and leave the rest as
// the user wrote it: comments, order, and entries that do not load. Save
// rewrites the whole file from what loaded, which is right for the wizard and
// wrong for a panel that touches one entry at a time.

// PutResult is what a Put found. Problem is why the entry would not load, in
// the words Load uses; empty means it was written (or would be, on a dry run).
type PutResult struct {
	Problem string      `json:"problem,omitempty"`
	Next    []time.Time `json:"next,omitempty"`
}

// Put writes a, replacing the entry named original, or appending when
// original is empty. Nothing is written when the result would not load.
//
// given names the keys the caller sets; the replaced entry keeps every other
// key as it was, so a form that knows only some keys cannot drop the rest. A
// given key a leaves empty is removed. nil replaces the whole entry.
func Put(original string, a Automation, given []string, dryRun bool) (PutResult, error) {
	edit, err := readEdit()
	if err != nil {
		return PutResult{}, err
	}
	at, err := entryIndex(edit.seq, original)
	if err != nil {
		return PutResult{}, err
	}
	if original != "" && at < 0 {
		return PutResult{}, fmt.Errorf("no automation named %q", original)
	}
	name := a.Name
	if at >= 0 && given != nil && !slices.Contains(given, "name") {
		name = original
	}
	if name != original && len(namedEntries(edit.seq, name)) > 0 {
		return PutResult{Problem: fmt.Sprintf("%s: an automation by that name already exists", name)}, nil
	}

	var node yaml.Node
	if err := node.Encode(a); err != nil {
		return PutResult{}, err
	}
	var expected Automation
	if at < 0 || given == nil {
		expected, err = decodeAutomation(&node)
		if err != nil {
			return PutResult{}, err
		}
	}
	seq := edit.sequence()
	delta := 0
	unsafeTarget := false
	if at < 0 {
		at, delta = len(seq.Content), 1
		seq.Content = append(seq.Content, &node)
	} else if given != nil {
		target := seq.Content[at]
		before := edit.before.entries[at].value
		unsafeTarget = before.problem != "" || hasMismatchedKey(target, given...)
		expected = withGivenFields(before.automation, a, given)
		setKeys(target, &node, given)
	} else {
		node.HeadComment = seq.Content[at].HeadComment
		seq.Content[at] = &node
	}

	raw, cfg, err := edit.checked(at, delta, func(after effectiveConfig, _ *Config) error {
		if unsafeTarget || !sameValue(after.entries[at].value, automationValue{automation: expected}) {
			return changeRefused(edit.line(at))
		}
		return nil
	})
	var notLoaded loadError
	if errors.As(err, &notLoaded) {
		return PutResult{Problem: notLoaded.Error()}, nil
	}
	if err != nil {
		return PutResult{}, err
	}
	if d := cfg.Diagnostic(name); d != nil {
		return PutResult{Problem: d.Message}, nil
	}
	target := cfg.Find(name)
	if target == nil {
		return PutResult{}, changeRefused(edit.line(at))
	}
	res := PutResult{Next: nextRuns(target.Cron, 3)}
	if dryRun {
		return res, nil
	}
	return res, write(raw)
}

// Remove deletes the entry named name, valid or not.
func Remove(name string) error {
	edit, err := readEdit()
	if err != nil {
		return err
	}
	at, err := entryIndex(edit.seq, name)
	if err != nil {
		return err
	}
	if at < 0 {
		return fmt.Errorf("no automation named %q", name)
	}
	seq := edit.seq
	seq.Content = append(seq.Content[:at], seq.Content[at+1:]...)
	raw, _, err := edit.checked(at, -1, nil)
	if err != nil {
		return err
	}
	return write(raw)
}

// SetPaused pauses or resumes one automation (its disabled flag), or every
// automation when name is empty (the top-level paused flag).
func SetPaused(name string, paused bool) error {
	edit, err := readEdit()
	if err != nil {
		return err
	}
	target, key := edit.doc.Content[0], "paused"
	at := -1
	if name != "" {
		at, err = entryIndex(edit.seq, name)
		if err != nil {
			return err
		}
		if at < 0 {
			return fmt.Errorf("no automation named %q", name)
		}
		target, key = edit.seq.Content[at], "disabled"
	}
	aliasedKey := hasMismatchedKey(target, key)
	setBool(target, key, paused)
	raw, _, err := edit.checked(at, 0, func(after effectiveConfig, cfg *Config) error {
		line := edit.line(at)
		if aliasedKey {
			return changeRefused(line)
		}
		if at < 0 {
			if cfg.Paused != paused {
				return changeRefused(line)
			}
			return nil
		}
		before, actual := edit.before.entries[at].value, after.entries[at].value
		if before.problem != "" || actual.problem != "" {
			return changeRefused(line)
		}
		expected := before.automation
		expected.Disabled = paused
		if sameAutomation(actual.automation, expected) {
			return nil
		}
		expected.Disabled = true
		if !paused && sameAutomation(actual.automation, expected) {
			return fmt.Errorf("%q stays paused through a merged template (line %d); edit automations.yaml by hand", name, line)
		}
		return changeRefused(line)
	})
	if err != nil {
		return err
	}
	return write(raw)
}

type yamlEdit struct {
	doc      *yaml.Node
	seq      *yaml.Node
	indent   int
	before   effectiveConfig
	parseErr error
}

func readEdit() (*yamlEdit, error) {
	raw, err := os.ReadFile(Path())
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	doc, err := decodeDoc(raw)
	if err != nil {
		return nil, err
	}
	seq, err := automationsOf(doc)
	if err != nil {
		return nil, err
	}
	before, err := snapshot(doc, seq)
	if err != nil {
		return nil, changeRefused(doc.Content[0].Line)
	}
	_, parseErr := parseEdit(raw)
	return &yamlEdit{doc: doc, seq: seq, indent: detectIndent(raw), before: before, parseErr: parseErr}, nil
}

// decodeDoc reads a node tree; a missing or empty file is an empty mapping.
func decodeDoc(raw []byte) (*yaml.Node, error) {
	var doc yaml.Node
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := yaml.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("parse %s: %w", Path(), err)
		}
	}
	if len(doc.Content) == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Line: 1}}}
	}
	if doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s: expected a mapping at the top", Path())
	}
	return &doc, nil
}

// automationsOf accepts only a local list, a null value, or an absent key.
func automationsOf(doc *yaml.Node) (*yaml.Node, error) {
	const refusal = "automations.yaml builds its automations list from anchors or merges; edit it by hand"
	root := doc.Content[0]
	var seq *yaml.Node
	for i := 0; i < len(root.Content); i += 2 {
		key := root.Content[i]
		// Use yaml.v3's merge predicate; a quoted string key is ordinary YAML.
		if key.Kind == yaml.ScalarNode && key.Value == "<<" && (key.Tag == "" || key.Tag == "!" || key.ShortTag() == "!!merge") {
			return nil, errors.New(refusal)
		}
		var name string
		if decodeEditNode(key, &name) != nil || name != "automations" {
			continue
		}
		v := root.Content[i+1]
		if seq != nil || (v.Kind != yaml.SequenceNode && !(v.Kind == yaml.ScalarNode && v.ShortTag() == "!!null")) {
			return nil, errors.New(refusal)
		}
		seq = v
	}
	return seq, nil
}

func (e *yamlEdit) sequence() *yaml.Node {
	if e.seq == nil {
		e.seq = &yaml.Node{Kind: yaml.SequenceNode}
		root := e.doc.Content[0]
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: "automations"}, e.seq)
	} else if e.seq.Kind == yaml.ScalarNode {
		*e.seq = yaml.Node{Kind: yaml.SequenceNode}
	}
	return e.seq
}

func namedEntries(seq *yaml.Node, name string) []int {
	if name == "" || seq == nil {
		return nil
	}
	var matches []int
	for i, node := range seq.Content {
		if editNameOf(node) == name {
			matches = append(matches, i)
		}
	}
	return matches
}

func entryIndex(seq *yaml.Node, name string) (int, error) {
	matches := namedEntries(seq, name)
	if len(matches) == 0 {
		return -1, nil
	}
	if len(matches) > 1 {
		lines := make([]int, 0, len(matches))
		for _, i := range matches {
			lines = append(lines, seq.Content[i].Line)
		}
		return -1, fmt.Errorf("%d entries are named %q (lines %s); remove or rename one in automations.yaml", len(matches), name, lineList(lines))
	}
	at := matches[0]
	if node := seq.Content[at]; node.Kind == yaml.AliasNode {
		return -1, fmt.Errorf("%q is a copy of another entry (line %d); edit automations.yaml by hand", name, node.Line)
	}
	return at, nil
}

type effectiveConfig struct {
	paused, backend rawSetting
	entries         []effectiveEntry
}

type rawSetting struct {
	text, aliasTarget string
}

type effectiveEntry struct {
	line  int
	value automationValue
}

type automationValue struct {
	automation Automation
	problem    string
	name       string
}

func sameAutomation(a, b Automation) bool {
	return reflect.DeepEqual(loaderView(a), loaderView(b))
}

func sameValue(a, b automationValue) bool {
	return a.problem == b.problem && a.name == b.name && sameAutomation(a.automation, b.automation)
}

func effective(raw []byte) (effectiveConfig, error) {
	doc, err := decodeDoc(raw)
	if err != nil {
		return effectiveConfig{}, err
	}
	seq, err := automationsOf(doc)
	if err != nil {
		return effectiveConfig{}, err
	}
	return snapshot(doc, seq)
}

func snapshot(doc, seq *yaml.Node) (effectiveConfig, error) {
	var state effectiveConfig
	root := doc.Content[0]
	var err error
	if state.paused, err = snapshotSetting(root, "paused"); err != nil {
		return state, err
	}
	if state.backend, err = snapshotSetting(root, "backend"); err != nil {
		return state, err
	}
	if seq != nil {
		for _, node := range seq.Content {
			a, err := decodeAutomation(node)
			value := automationValue{automation: a}
			if err != nil {
				// yaml.v3 still fills the fields that decoded: keep them, so a
				// sibling that does not load cannot silently change either.
				value = automationValue{automation: a, problem: editDecodeProblem(err), name: editNameOf(node)}
			}
			state.entries = append(state.entries, effectiveEntry{line: node.Line, value: value})
		}
	}
	return state, nil
}

func snapshotSetting(root *yaml.Node, key string) (rawSetting, error) {
	for i := 0; i < len(root.Content); i += 2 {
		var name string
		if decodeEditNode(root.Content[i], &name) != nil || name != key {
			continue
		}
		value := root.Content[i+1]
		raw, err := yaml.Marshal(value)
		if err != nil {
			return rawSetting{}, err
		}
		setting := rawSetting{text: string(raw)}
		// An unchanged alias spelling can point to a different value after
		// the edit removes an anchor that shadowed an earlier one.
		if value.Alias != nil {
			raw, err := yaml.Marshal(value.Alias)
			if err != nil {
				return rawSetting{}, err
			}
			setting.aliasTarget = string(raw)
		}
		return setting, nil
	}
	return rawSetting{}, nil
}

func withGivenFields(before, update Automation, given []string) Automation {
	dst, src := reflect.ValueOf(&before).Elem(), reflect.ValueOf(update)
	fields := src.Type()
	for i := 0; i < fields.NumField(); i++ {
		key, _, _ := strings.Cut(fields.Field(i).Tag.Get("yaml"), ",")
		if key != "-" && slices.Contains(given, key) {
			dst.Field(i).Set(src.Field(i))
		}
	}
	emptyAsNil(dst)
	return before
}

func decodeAutomation(node *yaml.Node) (Automation, error) {
	var a Automation
	err := decodeEditNode(node, &a)
	emptyAsNil(reflect.ValueOf(&a).Elem())
	return a, err
}

// loaderView is an entry as the loader runs it: its defaults filled in, home
// folders expanded, and empty lists read as absent. Edits compare these views:
// comparing raw values would call a sibling changed when only a default moved.
func loaderView(a Automation) Automation {
	a.applyDefaults()
	a.Repo = expandHome(a.Repo)
	a.MCPConfig = expandHome(a.MCPConfig)
	if a.Command != nil {
		command := *a.Command
		command.Cwd = expandHome(command.Cwd)
		a.Command = &command
	}
	emptyAsNil(reflect.ValueOf(&a).Elem())
	return a
}

// emptyAsNil reads an empty list or map as an absent one, as the loader does
// (it only ever asks len), so `agent_args: []` sent by a form that the encoder
// omits compares equal to the key it removed.
func emptyAsNil(v reflect.Value) {
	switch v.Kind() {
	case reflect.Pointer:
		if !v.IsNil() {
			emptyAsNil(v.Elem())
		}
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Field(i).CanSet() {
				emptyAsNil(v.Field(i))
			}
		}
	case reflect.Slice:
		if v.Len() == 0 {
			if v.CanSet() {
				v.SetZero()
			}
			return
		}
		for i := range v.Len() {
			emptyAsNil(v.Index(i))
		}
	case reflect.Map:
		if v.Len() == 0 && v.CanSet() {
			v.SetZero()
		}
	}
}

func decodeEditNode(node *yaml.Node, dst any) (err error) {
	defer catchYAMLPanic(&err)
	return node.Decode(dst)
}

func editNameOf(node *yaml.Node) (name string) {
	defer func() {
		if recover() != nil {
			name = ""
		}
	}()
	return nameOf(*node)
}

func parseEdit(raw []byte) (cfg *Config, err error) {
	defer catchYAMLPanic(&err)
	return parse(raw)
}

// yaml.v3 can panic while resolving merge keys that are Go slices or maps.
func catchYAMLPanic(err *error) {
	if cause := recover(); cause != nil {
		*err = fmt.Errorf("yaml: %v", cause)
	}
}

var yamlLocation = regexp.MustCompile(`^line [0-9]+: | at line [0-9]+$`)

func editDecodeProblem(err error) string {
	if typeErr, ok := err.(*yaml.TypeError); ok {
		messages := make([]string, len(typeErr.Errors))
		for i, message := range typeErr.Errors {
			messages[i] = yamlLocation.ReplaceAllString(message, "")
		}
		return strings.Join(messages, "\n")
	}
	return cleanYAMLError(err)
}

// checked reparses the edit and compares every entry outside the target.
// at is -1 for a top-level edit; delta is the change in the list length.
func (e *yamlEdit) checked(at, delta int, checkTarget func(effectiveConfig, *Config) error) ([]byte, *Config, error) {
	raw, err := encode(e.doc, e.indent)
	if err != nil {
		return nil, nil, err
	}
	cfg, err := parseEdit(raw)
	if err != nil {
		if e.parseErr != nil && err.Error() == e.parseErr.Error() {
			return nil, nil, loadError{err}
		}
		return nil, nil, changeRefused(e.line(at))
	}
	after, err := effective(raw)
	if err != nil || len(after.entries) != len(e.before.entries)+delta {
		return nil, nil, changeRefused(e.line(at))
	}
	var changed []int
	if after.backend != e.before.backend || (at >= 0 && after.paused != e.before.paused) {
		changed = append(changed, e.line(-1))
	}
	for i, old := range e.before.entries {
		if i == at {
			continue
		}
		j := i
		if delta < 0 && i > at {
			j--
		}
		if !sameValue(old.value, after.entries[j].value) {
			changed = append(changed, old.line)
		}
	}
	if len(changed) > 0 {
		return nil, nil, changeRefused(changed...)
	}
	if checkTarget != nil {
		if err := checkTarget(after, cfg); err != nil {
			return nil, nil, err
		}
	}
	return raw, cfg, nil
}

func (e *yamlEdit) line(at int) int {
	if at >= 0 && at < len(e.before.entries) {
		return e.before.entries[at].line
	}
	return e.doc.Content[0].Line
}

// loadError is a result the loader refuses, which Put reports as its problem.
type loadError struct{ error }

func changeRefused(lines ...int) error {
	return fmt.Errorf("this change would also change other automations in automations.yaml (lines %s); edit it by hand", lineList(lines))
}

func lineList(lines []int) string {
	values := make([]string, 0, len(lines))
	for _, line := range lines {
		values = append(values, strconv.Itoa(line))
	}
	return strings.Join(values, ", ")
}

// The raw setters compare key text, which is the anchor label on an alias.
func hasMismatchedKey(m *yaml.Node, keys ...string) bool {
	for _, key := range keys {
		foundRaw := false
		for i := 0; i < len(m.Content); i += 2 {
			node := m.Content[i]
			rawMatch := node.Value == key
			if node.Kind == yaml.AliasNode {
				var name string
				_ = decodeEditNode(node, &name)
				if (name == key && !rawMatch) || (rawMatch && !foundRaw && name != key) {
					return true
				}
			}
			foundRaw = foundRaw || rawMatch
		}
	}
	return false
}

func valueOf(m *yaml.Node, key string) *yaml.Node {
	if m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// setKeys copies keys from src into dst in place: replaced where dst has them,
// appended where it does not, removed where src has none. dst's other keys,
// their order and their comments stay.
func setKeys(dst, src *yaml.Node, keys []string) {
	for _, key := range keys {
		v := valueOf(src, key)
		at := -1
		for i := 0; i+1 < len(dst.Content); i += 2 {
			if dst.Content[i].Value == key {
				at = i
				break
			}
		}
		switch {
		case at >= 0 && v != nil:
			dst.Content[at+1] = v
		case at >= 0:
			dst.Content = append(dst.Content[:at], dst.Content[at+2:]...)
		case v != nil:
			dst.Content = append(dst.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, v)
		}
	}
}

// setBool writes key: true, or removes the key for false so a resumed entry
// reads as if it had never been paused.
func setBool(m *yaml.Node, key string, on bool) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			if on {
				m.Content[i+1] = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"}
			} else {
				m.Content = append(m.Content[:i], m.Content[i+2:]...)
			}
			return
		}
	}
	if on {
		m.Content = append(m.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Value: key},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
	}
}

// detectIndent reads where the first list dash sits: yaml.v3 puts it at the
// indent width. 4 is what yaml.Marshal (and so Save) writes.
func detectIndent(raw []byte) int {
	for _, line := range bytes.Split(raw, []byte("\n")) {
		trimmed := bytes.TrimLeft(line, " ")
		if n := len(line) - len(trimmed); n > 0 && bytes.HasPrefix(trimmed, []byte("- ")) {
			return n
		}
	}
	return 4
}

func encode(doc *yaml.Node, indent int) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(indent)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), enc.Close()
}

// write replaces the file through a rename, so a crash mid-write cannot leave
// half a config for the daemon to read as "no automations".
func write(raw []byte) error {
	if err := os.MkdirAll(Dir(), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(Dir(), ".automations-*.yaml")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(Dir(), "automations.yaml"))
}

// nextRuns lists the next n occurrences of a cron line already validated.
func nextRuns(cron string, n int) []time.Time {
	sched, err := CronParser.Parse(cron)
	if err != nil {
		return nil
	}
	out := make([]time.Time, 0, n)
	t := time.Now()
	for range n {
		t = sched.Next(t)
		out = append(out, t)
	}
	return out
}
