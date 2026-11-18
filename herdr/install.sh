#!/bin/sh
# Automagik Herdr installer (A17): turns a plain Herdr into Automagik Herdr on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash
#   ... | bash -s -- --yes            answer yes to every question (for agents)
#   ... | bash -s -- --version 3.58.0 a given release that carries the pack, instead of the newest
#   ... | bash -s -- --adopt          also replace pack-named mods this installer did not install
#   ... | bash -s -- --uninstall      put back what was there before
#   ... | bash -s -- --no-usagemeter  leave usagemeter alone everywhere (install and --uninstall)
#   ... | bash -s -- --usagemeter-local-only  usagemeter on this computer only, no linked machine
#   ... | bash -s -- --no-scheduler   leave herdr-automations and its login service alone
#   ... | bash -s -- --dsh-tui | --no-dsh-tui  install (or leave) dsh-TUI as a Herdr agent
#   ... | bash -s -- --revive | --no-revive    install (or leave) the login service that brings
#                                              the bots back after a restart (Linux, #939)
#
# It checks the OS, Node and Herdr (herdrdev's, dev.herdr.app: offering its own installer from
# releases.herdr.dev, no sudo, asking first),
# reads the signed pointer to the newest pack (the herdr-lane release's pack.json and its ed25519
# signature, checked against the keys embedded below: a desktop or plugin release carries no
# pack, so nothing searches the releases), downloads its pack tarball (automagik-herdr-pack-<v>.tgz: every pack mod
# and layouts/automagik.json), checks it against the sha256 the signed pointer names before
# anything is written (a --version release against its own .sha256), and installs every
# pack mod through the pack's own update.mjs: each folder staged, then swapped in, the replaced
# ones kept together in <app home>/automagik-herdr/.prev. Its ownership record (the marker)
# lists every folder it put in mods/; only those are ever replaced. Any other folder is left
# alone, or with --adopt moved to automagik-herdr/backup/ first. Pocket Link is never touched.
# It merges the pack's free keys, points the mod manager at the catalog, adds the `automagik`
# layout (replacing only v0.2's unchanged copy; in a kept one, or one of the person's own showing
# the sidebar, Herdr's workspace-status block becomes am-status, and it says so), runs
# `herdr-app check` on each mod, and links
# the `automagik-herdr` command into ~/.local/bin. It installs usagemeter (the token meter the
# sidebar runs every 10 minutes) to ~/.local/bin/usagemeter: the build the signed meter-lane pointer
# names (meter.json and its ed25519 signature, checked against the keys embedded below; never one
# older than a pointer it took before), checked against the sha256 that pointer names, never over a
# newer one; and the same build on every connected linked machine (`hc machine ls`, through the
# pack's `automagik-herdr meter install --linked`: each machine downloads and checks it itself); a
# failure there is only a warning. It installs herdr-automations (the scheduler the Automations
# panel drives, #220) to ~/.local/bin: the build the checked pack pins, checked against its sha256,
# never over one this installer did not put there; with no automations.yaml yet it writes one saying
# `backend: hc`, asks before starting the scheduler's login service, and says whether Automations
# is ready (`ls --json`: the scheduler runs, the backend is the app's); a failure there is only a
# warning too. When asked at a terminal (or with --dsh-tui; --yes
# never does), it installs the pinned dsh-TUI into DSH's own `dsh-tui` profile and the `dsh-tui` shim
# into ~/.local/bin, so Herdr's built-in DSH entry works; no dsh on PATH: one honest line, skipped. Safe to run again: a rerun of the installed
# release downloads it all the same, checks every installed pack file against it, reinstalls a
# missing or damaged folder the record lists (the damaged copy kept in backup/), puts back a
# missing automagik layout and runs `herdr-app check` again. It says "up to date" only when every
# file matches, and says whether the mods were checked too (not without herdr-app). It never
# touches a project's .herdr/bots.json or Herdr's settings. Apache-2.0.
#
# The whole script is one function, called on its last line: a download cut short by the
# network defines part of it and runs nothing.
#
# For tests: AUTOMAGIK_HERDR_RELEASE_URL, a file:// folder (files at <url>/download/<tag>/<file>,
# the pointer at <url>/download/herdr-lane/pack.json) or a page of this repository on github.com;
# with a file:// one also AUTOMAGIK_HERDR_TTY (default /dev/tty), AUTOMAGIK_HERDR_APPS (default
# /Applications; ~/Applications is read too) and AUTOMAGIK_HERDR_PACK_KEYS (the trusted keys, as TRUSTED_KEYS: a test's own;
# never honoured for a GitHub URL), and AUTOMAGIK_HERDR_METER_KEYS the same for METER_KEYS. HERDR_APP_HOME as Herdr reads
# it. A file:// release folder also serves the meter lane (<url>/download/meter-lane/meter.json) and the builds it names
# (<url>/download/v<version>/<asset>), so a test never reaches the network.

main() {
  set -eu
  # Under `curl | bash` the script itself is stdin: every program it runs gets </dev/null, so
  # none can read (eat) the rest of the script; questions read the terminal instead.

  # The pack ships on the Automagik monorepo's releases (its herdr/), v<version> in its one version.
  REPO=automagik-dev/automagik
  RELEASES=https://github.com/$REPO/releases
  # The keys the pack pointer may be signed with: mods/am-sidebar/pack-keys.json, kept equal by a
  # test (bun scripts/herdr-lane.ts keygen writes both).
  TRUSTED_KEYS='{"keys":[{"keyId":"herdr-pack-2026-11","publicKey":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAU4DbVpmwLMRaZhuWMHXjf0H6pSR8uZdLGplgc+Biy5w=\n-----END PUBLIC KEY-----\n"}]}'
  TTY=/dev/tty
  APPS=/Applications
  APP_HOME=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
  MODS=$APP_HOME/mods
  PACK=$MODS/am-sidebar
  # The sidebar's folder before the rename (release.js OLD_PACK_NAME): what a v0.2-v0.4.x install has.
  OLD=spaces-agents
  STATE=$APP_HOME/automagik-herdr
  MARK=$STATE/installed-by-install.sh
  BEFORE=$STATE/$OLD.before-install
  LAYOUT=$APP_HOME/layouts/automagik.json
  REF=$STATE/automagik.json
  HINT=no
  BIN_DIR=$HOME/.local/bin
  LINK=$BIN_DIR/automagik-herdr
  AM_LINK=$BIN_DIR/am
  NODE_MIN=22.7
  # How long `herdr-app status` may take: a Herdr that does not answer never holds up a run.
  STATUS_SECONDS=10
  # The Herdr this pack runs in is herdrdev's (D27): bundle id dev.herdr.app on macOS, herdr-app on
  # Linux, installed by its own installer. Another app named Herdr (Herdr UI, penso/herdr-gpui:
  # so.pen.herdr-gpui) is a different app and never counts.
  HERDR_ID=dev.herdr.app
  HERDR_INSTALLER=https://releases.herdr.dev/app/install.sh
  # usagemeter (Group 6c): the build the signed meter-lane pointer names. The keys it may be signed
  # with: mods/am-sidebar/meter-keys.json, a copy of meter/usagemeter/meter-keys.json, kept equal by
  # tests (bun scripts/meter-lane.ts keygen writes all three). One shared path.
  METER_KEYS='{"keys":[{"keyId":"meter-2026-11","publicKey":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAf2gfjEnFdw08xICy53pSDqo6uQxkoYOE+UvHQaZ0RPE=\n-----END PUBLIC KEY-----\n"}]}'
  METER=$BIN_DIR/usagemeter
  METER_OK=1
  # Linked machines too (meterFleet.js): 0 with --usagemeter-local-only (or --no-usagemeter).
  FLEET_OK=1
  # The automations scheduler (#220): herdr-automations, the build the pack pins, and this
  # installer's own record of it. 0 with --no-scheduler.
  SCHED=$BIN_DIR/herdr-automations
  SCHED_RECORD=$STATE/scheduler
  SCHED_OK=1
  # DSH as a Herdr agent (#561): ask, yes or no. Third-party: only --dsh-tui or an explicit
  # answer installs it; --yes never does.
  DSH_TUI=ask
  # The login service that brings the bots back after a restart of this computer (#939): ask, yes
  # or no. It changes what runs at login, so only --revive or an explicit answer installs it;
  # --yes never does. Linux (a systemd user unit); the CLI writes and removes it.
  REVIVE=ask
  REVIVE_UNIT=$HOME/.config/systemd/user/automagik-herdr-revive.service

  YES=0
  ADOPT=0
  UNINSTALL=0
  WANT=
  while [ $# -gt 0 ]; do
    case $1 in
      --yes|-y) YES=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --adopt) ADOPT=1 ;;
      --no-usagemeter) METER_OK=0; FLEET_OK=0 ;;
      --usagemeter-local-only) FLEET_OK=0 ;;
      --no-scheduler) SCHED_OK=0 ;;
      --dsh-tui) DSH_TUI=yes ;;
      --no-dsh-tui) DSH_TUI=no ;;
      --revive) REVIVE=yes ;;
      --no-revive) REVIVE=no ;;
      --version) [ $# -ge 2 ] || { echo "--version needs a version, like 0.2.0" >&2; exit 2; }; WANT=${2#v}; shift ;;
      --version=*) WANT=${1#--version=}; WANT=${WANT#v} ;;
      --help|-h) usage; exit 0 ;;
      *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
  done
  # --yes answers the other questions; the third-party dsh-TUI package is never installed by it.

  # The test hooks: a release from a file:// folder or this repository's GitHub pages only.
  if [ -n "${AUTOMAGIK_HERDR_RELEASE_URL:-}" ]; then
    # curl collapses dot segments (.../automagik-herdr/../../x is x), so `..` and `%`
    # (an escaped dot) are refused before the prefix is checked.
    case $AUTOMAGIK_HERDR_RELEASE_URL in
      *..*|*%*) fail "AUTOMAGIK_HERDR_RELEASE_URL must not contain '..' or '%'; not $AUTOMAGIK_HERDR_RELEASE_URL." ;;
    esac
    case $AUTOMAGIK_HERDR_RELEASE_URL in
      file://*|"https://github.com/$REPO/"*) RELEASES=$AUTOMAGIK_HERDR_RELEASE_URL ;;
      *) fail "AUTOMAGIK_HERDR_RELEASE_URL must be a file:// folder or https://github.com/$REPO/…; not $AUTOMAGIK_HERDR_RELEASE_URL." ;;
    esac
    say "Releases from $RELEASES (AUTOMAGIK_HERDR_RELEASE_URL)."
    case $RELEASES in
      file://*) TTY=${AUTOMAGIK_HERDR_TTY:-$TTY}; APPS=${AUTOMAGIK_HERDR_APPS:-$APPS}; STATUS_SECONDS=${AUTOMAGIK_HERDR_STATUS_SECONDS:-$STATUS_SECONDS}; TRUSTED_KEYS=${AUTOMAGIK_HERDR_PACK_KEYS:-$TRUSTED_KEYS}; METER_KEYS=${AUTOMAGIK_HERDR_METER_KEYS:-$METER_KEYS} ;;
    esac
  fi

  TMP=
  trap 'rm -rf "$TMP"' EXIT
  trap 'exit 130' INT TERM

  if [ "$UNINSTALL" = 1 ]; then uninstall; else install; fi
}

usage() {
  cat <<'EOF'
Automagik Herdr installer

  install.sh [--yes] [--version <v>] [--adopt] [--no-usagemeter | --usagemeter-local-only]
             [--no-scheduler] [--dsh-tui | --no-dsh-tui] [--revive | --no-revive]
                                       install or update the pack and the automagik-herdr command
  install.sh --uninstall [--yes]       move the pack out of mods/, put back what was there before;
                                       refused while the layout Herdr shows names a pack mod
  install.sh --help

--yes answers yes to every question (installing Node on macOS, Herdr from releases.herdr.dev,
switching Herdr to the automagik layout, starting the automations scheduler at login). It never installs dsh-TUI: that third-party package is
opt-in by --dsh-tui or an explicit answer. --version installs that Automagik release; it must carry the
pack (automagik-herdr-pack-<v>.tgz): not every release does.
--adopt replaces a pack-named mod this installer did not install, after moving it to
<app home>/automagik-herdr/backup/; without it such a folder is reported and left alone.
--no-usagemeter leaves ~/.local/bin/usagemeter (the token meter) alone, here and on every linked
machine: install skips it, and --uninstall keeps it even where this installer put it.
--usagemeter-local-only installs and removes it on this computer only, never on a linked machine
(hc machine ls). Both are remembered for 'automagik-herdr update' and the sidebar's sync.
--no-scheduler leaves ~/.local/bin/herdr-automations (the automations scheduler) and its login
service alone: install skips them, and --uninstall keeps them even where this installer put them.
Without it the installer puts the build the pack pins there (never over one it did not install),
writes 'backend: hc' only where there is no automations.yaml yet, and asks before starting the
login service.
--dsh-tui installs the pinned dsh-TUI into DSH's own `dsh-tui` profile and the dsh-tui shim into
~/.local/bin, so Herdr's built-in DSH entry works; --no-dsh-tui leaves DSH alone. Without either,
the installer asks (unless --yes), and a machine with no dsh gets one line saying how to get it.
--uninstall removes dsh-TUI (the plugin and the shim) when this installer put it there.
--revive installs the login service that brings the bots back after a restart of this computer
('automagik-herdr revive --boot': each bot whose pane is gone or a bare shell is restarted in its
place, resumed where its agent allows). Linux only for now: a systemd user unit, enabled, never
started on the spot. --no-revive leaves it alone. Without either, the installer asks (--yes never
installs it). --uninstall removes the unit when it is this pack's.
EOF
}

say() { printf '%s\n' "$*"; }
# The briefing hooks' notice update.mjs gave (its `notice: ` lines), held in $TMP/notice for the
# end of the run: printed once, there or before any failure after it, so it is never lost.
held_notice() {
  { [ -n "${TMP:-}" ] && [ -s "$TMP/notice" ]; } || return 0
  say ""
  cat "$TMP/notice"
  say ""
  : >"$TMP/notice"
}
fail() { held_notice; printf 'automagik-herdr install: %s\n' "$*" >&2; exit 1; }

# A yes/no question. Stdin is the downloaded script under `curl | bash`, so the answer comes
# from the terminal; with none (an agent, CI) the answer is no unless --yes was given.
ask() {
  [ "$YES" = 1 ] && return 0
  if ( : <"$TTY" ) 2>/dev/null; then
    printf '%s [y/N] ' "$1" >"$TTY" 2>/dev/null || printf '%s [y/N] ' "$1"
    read -r reply <"$TTY" || reply=
    case $reply in [yY]|[yY][eE][sS]) return 0 ;; esac
  fi
  return 1
}

# A question --yes must not answer: a third-party package is installed only by its own flag or an
# explicit answer at the terminal. The prompt goes to stderr, so the answer source (a terminal,
# or a test's file named by AUTOMAGIK_HERDR_TTY) is only read. No terminal (an agent, CI): no.
ask_opt_in() {
  ( : <"$TTY" ) 2>/dev/null || return 1
  printf '%s [y/N] ' "$1" >&2
  read -r reply <"$TTY" || reply=
  case $reply in [yY]|[yY][eE][sS]) return 0 ;; esac
  return 1
}

# A line of the marker (the ownership record, release.js parseMarker): v2 has `version=`,
# `mods=<comma list>`, `layout=added|kept`, `before=kept|none` and `adopted=<mod>:<path>,…`;
# v0.2's v1 has no `mods=` (it installed $OLD only, its first pack copied to $BEFORE).
mark_get() { sed -n "s/^$1=//p" "$MARK" 2>/dev/null | head -n 1; }

# Whether $LINK is a link to the pack's own command in this app home (the sidebar folder's
# bin/automagik-herdr wrapper, which v0.3.5-v0.4.x link, or bin/automagik-herdr.mjs, under its old
# or its am-* name), the only kind this script replaces or removes: a link the person pointed
# anywhere else stays theirs.
link_ours() {
  l=${1:-$LINK}
  [ -L "$l" ] || return 1
  to=$(readlink "$l" 2>/dev/null) || return 1
  case $to in
    "$MODS/$OLD/bin/automagik-herdr"|"$MODS/$OLD/bin/automagik-herdr.mjs") return 0 ;;
    "$PACK/bin/automagik-herdr"|"$PACK/bin/automagik-herdr.mjs") return 0 ;;
  esac
  return 1
}

# Whether $AM_LINK is a link into am's own store (am self install took it from the pack): am's,
# so this script leaves it as it is and says nothing about removing it.
am_link_is_am() {
  [ -L "$AM_LINK" ] || return 1
  case $(readlink "$AM_LINK" 2>/dev/null) in
    */parts/automagik.am/*) return 0 ;;
  esac
  return 1
}

# The command the link points at, in the sidebar folder the ownership record lists (am-sidebar,
# else $OLD, a rollback's): its bin/automagik-herdr wrapper when the pack ships one (it finds a node
# where PATH has none), else bin/automagik-herdr.mjs; empty when the record lists neither folder.
cli_target() {
  case ",$(mark_get mods)," in
    *,"${PACK##*/}",*) dir=$PACK/bin ;;
    *,"$OLD",*) dir=$MODS/$OLD/bin ;;
    *) return 0 ;;
  esac
  if [ -f "$dir/automagik-herdr" ]; then echo "$dir/automagik-herdr"; else echo "$dir/automagik-herdr.mjs"; fi
}

# The layout Herdr shows ("layout" in `herdr-app status`); empty when herdr-app or its status
# is unavailable, or gives no answer within $STATUS_SECONDS (macOS has no `timeout`).
shown_layout() {
  command -v herdr-app >/dev/null 2>&1 || return 0
  st=$(mktemp) || return 0
  herdr-app status </dev/null >"$st" 2>/dev/null &
  asked=$!
  # Nothing of the watchdog's stays on stdout: callers read this function through $(…), which would
  # wait for its sleep. Stopped, it stops its sleep too, so no run leaves one behind.
  (
    nap=
    trap '[ -z "$nap" ] || { kill "$nap"; wait "$nap"; }; exit 0' TERM
    sleep "$STATUS_SECONDS" &
    nap=$!
    wait "$nap" || true
    kill "$asked" 2>/dev/null
  ) >/dev/null 2>&1 &
  watchdog=$!
  rc=0
  wait "$asked" || rc=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if [ "$rc" = 0 ]; then sed -n 's/.*"layout"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$st" | head -n 1; fi
  rm -f "$st"
}

# The sidebar mod has place "none": it shows only in a layout that names it. While Herdr shows
# another layout, this offers the switch (--yes switches), but only to the pack's own copy;
# an edited layout, no herdr-app or no status get the printed command (HINT) and nothing else.
offer_switch() {
  [ -f "$LAYOUT" ] || return 0
  shown=$(shown_layout)
  [ "$shown" != automagik ] || return 0
  # A layout that already shows the pack (the person's own, like main-agents): nothing to do.
  if [ -n "$shown" ] && [ -f "$APP_HOME/layouts/$shown.json" ] \
    && grep -q '"mod"[[:space:]]*:[[:space:]]*"am-sidebar"' "$APP_HOME/layouts/$shown.json"; then
    return 0
  fi
  if [ -z "$shown" ] || [ ! -f "$REF" ] || ! cmp -s "$LAYOUT" "$REF"; then
    HINT=yes
    return 0
  fi
  if ask "Switch Herdr to the automagik layout now? The Automagik sidebar appears after this."; then
    if herdr-app 'do' layout.switch '{"name":"automagik"}' </dev/null >/dev/null 2>&1; then
      say "Switched Herdr to the automagik layout."
      return 0
    fi
    say "Herdr didn't switch."
  fi
  HINT=yes
}

# A layout of the person's own that shows the sidebar (one adapted for a sidebar-only release)
# doesn't gain the rest of the pack by itself, and this script never edits it: for each such
# layout, say which pack surfaces it lacks and where to copy them from.
layout_notes() {
  [ -f "$REF" ] || return 0
  for f in "$APP_HOME"/layouts/*.json; do
    if [ ! -f "$f" ] || [ "$f" = "$LAYOUT" ]; then continue; fi
    grep -q '"mod"[[:space:]]*:[[:space:]]*"am-sidebar"' "$f" || continue
    lacks=
    # The Automations and Accounts panels aren't listed: the footer opens them itself, and the
    # pack's layout names neither (Herdr shows plain Herdr instead of a layout naming a mod that is
    # off, and either can be).
    for s in 'am-footer:the footer rail (am-footer)' 'am-tabs:the tab bar (am-tabs)' \
      'am-status:the status bar with the pack version (am-status)' \
      'am-markdown:the Markdown menu (am-markdown)'; do
      # A block naming the mod ("mod": …), or for am-markdown the root's "terminal_menu": an id like
      # "am-tabs-bar" or a mention elsewhere doesn't count.
      # A mod that is off (mods-disabled/) isn't missed: a block naming it would make Herdr show
      # plain Herdr instead of the layout.
      if [ ! -d "$MODS/${s%%:*}" ] && [ -d "$APP_HOME/mods-disabled/${s%%:*}" ]; then continue; fi
      grep -Eq "\"(mod|terminal_menu)\"[[:space:]]*:[[:space:]]*\"${s%%:*}\"" "$f" || lacks=${lacks:+$lacks, }${s#*:}
    done
    [ -n "$lacks" ] || continue
    name=${f##*/}
    say "Your layout ${name%.json} ($f) shows the Automagik sidebar, but not the rest of the pack: $lacks."
    say "  It is left as it is. To add them, copy their blocks (and \"terminal_menu\": \"am-markdown\") from the pack's layout, $REF, into it; or use the automagik layout instead."
  done
}

# The record's mods as the install summary names them: one switched off (in mods-disabled/, as
# am-quota ships) says so, and where to turn it on.
mods_said() {
  said=
  set -f
  old_ifs=$IFS
  IFS=,
  for m in $(mark_get mods); do
    if [ ! -d "$MODS/$m" ] && [ -d "$APP_HOME/mods-disabled/$m" ]; then m="$m (off; turn it on in the Mods panel)"; fi
    said=${said:+$said, }$m
  done
  IFS=$old_ifs
  set +f
  printf '%s' "$said"
}

# Before --uninstall moves anything (#420), as `am uninstall herdr.pack` does: refused while a
# block ("mod": "<m>") of the layout Herdr shows names a pack mod in mods/ ($1, the record's
# list), since Herdr would drop that layout and show plain Herdr. With no layout to read (no
# herdr-app, Herdr not running, a name with a path, no such file) it goes on, naming each layout
# whose blocks name one ($2: the pack's own layout file when this run removes it, left out unless
# Node finds it does not parse, #489, or Herdr gave no answer at all, #487: then said as removed,
# or kept in a linked layouts/; refused too while Herdr shows that file). What this script cannot
# check is said as well (#525): that file without Node (whether it parses), a layout file it
# cannot read, and a layouts/ it cannot list.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
layout_guard() {
  shown=$(shown_layout)
  why=
  case $shown in
    '') why="no layout from herdr-app status: no herdr-app, Herdr is not running, or it did not answer in ${STATUS_SECONDS}s" ;;
    */*|.|..) why="Herdr shows the layout \"$shown\", a name with a path, so no file in $APP_HOME/layouts was read" ;;
    *)
      if [ ! -f "$APP_HOME/layouts/$shown.json" ]; then why="Herdr shows $shown, and $APP_HOME/layouts/$shown.json is not there"
      elif [ ! -r "$APP_HOME/layouts/$shown.json" ]; then why="Herdr shows $shown, and $APP_HOME/layouts/$shown.json could not be read"; fi ;;
  esac
  set -f
  IFS=,
  on=
  for m in $1; do
    case $m in ''|pocket-link|*[!a-z0-9-]*) continue ;; esac
    if [ -d "$MODS/$m" ] && [ ! -L "$MODS/$m" ]; then on="${on:+$on,}$m"; fi
  done
  named=
  if [ -z "$why" ]; then
    for m in $on; do
      if grep -q "\"mod\"[[:space:]]*:[[:space:]]*\"$m\"" "$APP_HOME/layouts/$shown.json"; then named="${named:+$named, }$m"; fi
    done
  fi
  unset IFS
  set +f
  # The command names main, so it does nothing while main is the layout in the way.
  how="ctrl-shift-l, or herdr-app do layout.switch '{\"name\":\"main\"}'"
  if [ "$shown" = main ]; then how=ctrl-shift-l; fi
  if [ -n "$named" ]; then
    fail "the pack stays: the $shown layout shows $named, and Herdr drops a layout whose mod is gone (plain Herdr instead). Switch layouts first ($how), then uninstall the pack."
  fi
  # The layout Herdr shows is the file this run removes, though no pack mod it names leaves (each
  # is a link, which stays: #450): refused as well, as the mod manager's package remove words it
  # (its name case-insensitive, as macOS's disk). Not inside a linked layouts/: that file stays (#448).
  if [ -z "$why" ] && [ -n "$2" ] && [ ! -L "$APP_HOME/layouts" ] && [ "$(lower "$shown.json")" = "$(lower "${2##*/}")" ]; then
    fail "the $shown layout is this package's (layouts/${2##*/}) and Herdr shows it: removing the package takes it away (plain Herdr instead). Switch layouts first ($how), then uninstall the pack."
  fi
  [ -n "$why" ] || return 0
  on_said=$(printf '%s' "$on" | sed 's/,/, /g')
  # A layouts/ this script cannot list (#525): none of its files is checked, and that is said.
  if [ -n "$on" ] && [ -d "$APP_HOME/layouts" ] && ! ls "$APP_HOME/layouts" >/dev/null 2>&1; then
    say "Uninstalling the pack without knowing the layout Herdr shows ($why), and $APP_HOME/layouts could not be listed, so no layout in it was checked: if one names $on_said and Herdr shows it, Herdr drops it (plain Herdr instead). Showing one? Switch layouts (ctrl-shift-l), or run this installer again to put the pack back."
    return 0
  fi
  for f in "$APP_HOME"/layouts/*.json; do
    [ -f "$f" ] || continue
    # A layout file this script cannot read (mode 000, #525): said, as layoutSafe.mjs says one
    # that does not read.
    if [ ! -r "$f" ]; then
      if [ -n "$on" ]; then
        say "Uninstalling the pack without knowing the layout Herdr shows ($why), and $f could not be read: if it names $on_said and Herdr shows it, Herdr drops it (plain Herdr instead). Showing it? Switch layouts (ctrl-shift-l), or run this installer again to put the pack back."
      fi
      continue
    fi
    # The pack's own layout this run removes: while Herdr gave a name (a path, no such file), not
    # the one shown, so left out unless it does not parse (#489: Node reads it; without Node it
    # cannot be checked, and that is said, #525). With no answer at all (#487) it may be the one
    # shown: said either way, Node or not.
    reads=
    if [ "$f" = "$2" ]; then
      if node_ok; then if json_reads "$f"; then reads=yes; else reads=no; fi; fi
      if [ -n "$shown" ] && [ "$reads" = yes ]; then continue; fi
    fi
    has=
    set -f
    IFS=,
    for m in $on; do
      if grep -q "\"mod\"[[:space:]]*:[[:space:]]*\"$m\"" "$f"; then has="${has:+$has, }$m"; fi
    done
    unset IFS
    set +f
    if [ -z "$has" ]; then
      # The pack's own layout naming no pack mod that leaves, with no answer from Herdr: removed,
      # it may still be the one shown, said as layoutSafe.mjs says it (#525). One a linked layouts/
      # keeps, or one that does not parse, loses nothing: not said, there as here.
      if [ "$f" = "$2" ] && [ -z "$shown" ] && [ "$reads" != no ] && [ ! -L "$APP_HOME/layouts" ]; then
        say "Removing the pack's own layout $f without knowing the layout Herdr shows ($why), so it may be the one shown. If Herdr shows it, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l), or run this installer again to put the pack back."
      fi
      continue
    fi
    name=${f##*/}
    if [ "$f" = "$2" ] && [ "$reads" = no ]; then
      say "Uninstalling the pack without knowing the layout Herdr shows ($why), and its own layout ($f) does not read: its text names $has, and Herdr drops a layout whose mod is gone (plain Herdr instead). Showing it? Switch layouts (ctrl-shift-l), or run this installer again to put the pack back."
      continue
    fi
    # Herdr gave a name that is not this file, and without Node nothing says whether it parses
    # (#525): its text is read instead, and what it names is said, never passed over silently.
    if [ "$f" = "$2" ] && [ -n "$shown" ]; then
      say "Uninstalling the pack without knowing the layout Herdr shows ($why), and its own layout ($f) could not be checked without Node $NODE_MIN or later: its text names $has, and Herdr drops a layout whose mod is gone (plain Herdr instead). Showing it? Switch layouts (ctrl-shift-l), or run this installer again to put the pack back."
      continue
    fi
    if [ "$f" = "$2" ]; then
      if [ -L "$APP_HOME/layouts" ]; then
        say "Keeping the pack's own layout $f without knowing the layout Herdr shows ($why): $APP_HOME/layouts is a link, your own folder, so it stays, but its text names $has, which leave mods/ with the pack. If Herdr shows it, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l), or run this installer again to put the pack back."
      else
        say "Removing the pack's own layout $f without knowing the layout Herdr shows ($why), so it may be the one shown: its text names $has, which leave mods/ with the pack. If Herdr shows it, Herdr drops it (plain Herdr instead): switch layouts (ctrl-shift-l), or run this installer again to put the pack back."
      fi
      continue
    fi
    say "Uninstalling the pack without knowing the layout Herdr shows ($why): your layout ${name%.json} ($f) shows $has, and Herdr drops a layout whose mod is gone (plain Herdr instead). Showing it? Switch layouts (ctrl-shift-l), or run this installer again to put the pack back."
  done
}

# Whether the file $1 parses as JSON (Node checked first by the caller).
json_reads() {
  node -e 'try { JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }' "$1" </dev/null >/dev/null 2>&1
}

switch_hint() {
  [ "$HINT" = yes ] || return 0
  say "To show the Automagik sidebar, switch Herdr to the automagik layout; the sidebar appears after this:"
  say "  herdr-app do layout.switch '{\"name\":\"automagik\"}'"
}

# The pack's layout, as --uninstall removes it: left where it is inside a linked layouts/, the
# person's own folder (#448), else removed.
say_left_layout() { say "Left $LAYOUT: $APP_HOME/layouts is a link, your own folder, not one this installer made; the file in it stays yours."; }
say_removed_layout() { say "Removed the automagik layout ($LAYOUT). If Herdr shows it, switch back: herdr-app do layout.switch '{\"name\":\"main\"}'"; }
drop_layout() {
  if [ -L "$APP_HOME/layouts" ]; then say_left_layout; return 0; fi
  rm -f "$LAYOUT"
  say_removed_layout
}

# --uninstall's removals through the installed updater ($1, update.mjs): into the kept set ($2),
# the layout ($3, or none) and each folder after them. Its lines on stdout (removed, moved, left),
# its error as JSON there too; its stderr is not shown.
pack_out() {
  p_upd=$1
  p_to=$2
  p_layout=$3
  shift 3
  for f; do set -- "$@" --move "$f"; shift; done
  if [ -n "$p_layout" ]; then set -- --layout "$p_layout" "$@"; fi
  HERDR_APP_HOME=$APP_HOME node "$p_upd" pack-out --mods "$MODS" --to "$p_to" "$@" </dev/null 2>/dev/null
}

# A linked mods/ is the person's folder (#494): the same words as layoutSafe.mjs linkedModsLine.
linked_mods_line() {
  printf '%s' "mods/ ($MODS) is a link to $(readlink "$MODS"), your own folder, not one this install made: nothing is moved through it, and the folders in it stay as they are. Put that folder in the link's place (a plain mods/), then run this again"
}

uninstall() {
  [ -f "$MARK" ] || { say "Nothing to uninstall: this installer did not install the pack in $MODS."; exit 0; }
  # Before anything (the layout, usagemeter on the linked machines, the folders, the record): with
  # mods/ a link, nothing is done, by this script or by the updater's pack-out (#494).
  if [ -L "$MODS" ]; then fail "$(linked_mods_line)"; fi
  mods=$(mark_get mods)
  adopted=$(mark_get adopted)
  ref=$REF
  if ! grep -q '^mods=' "$MARK"; then
    # v1 (v0.2.x): $OLD only, the layout's reference inside it, its first pack in $BEFORE.
    mods=$OLD
    ref=$MODS/$OLD/layouts/automagik.json
    if [ "$(mark_get before)" = kept ] && [ -d "$BEFORE" ]; then adopted=$OLD:v1; fi
  fi
  # The automagik layout goes only when this script added it and it is still the pack's own
  # (cmp): an edited one, or one copied by hand, stays.
  drop=
  if [ "$(mark_get layout)" = added ] && [ -f "$LAYOUT" ] && [ -f "$ref" ] && cmp -s "$LAYOUT" "$ref"; then drop=$LAYOUT; fi
  # Nothing moves while the shown layout's blocks name a pack mod (#420).
  layout_guard "$mods" "$drop"
  # dsh-TUI (the plugin and the shim) goes while its command and the pack are still in place.
  dsh_tui_uninstall
  revive_uninstall
  # How the layout and the folders leave: through the pack's updater (update.mjs pack-out, which
  # runs them through layoutSafe.mjs, journalled) when Node is here and the installed updater has
  # the command (read from its usage line: nothing runs, nothing is written); else this script's
  # mv and rm, as before. Either way a layout inside a linked layouts/ stays (#448).
  upd=
  case ",$mods," in *,"${PACK##*/}",*) upd=$PACK/update.mjs ;; esac
  via=shell
  if [ -z "$upd" ]; then how_out="the record lists no ${PACK##*/}"
  elif ! node_ok; then how_out="no Node $NODE_MIN or later"
  elif [ ! -f "$upd" ] || ! grep -q '| pack-out --to <dir>' "$upd" 2>/dev/null; then how_out="the installed updater has no pack-out (an older pack)"
  else via=updater; fi
  if [ "$via" = shell ]; then
    say "Removing the pack with this script ($how_out)."
    [ -z "$drop" ] || drop_layout
  fi
  # usagemeter on the linked machines first, while the pack's CLI is still in mods/.
  if grep -q '^usagemeter-machines=.' "$MARK"; then
    if [ "$FLEET_OK" = 0 ]; then say "Left usagemeter on the linked machines ($(mark_get usagemeter-machines | sed 's/:[^,]*//g; s/,/, /g'))."
    else fleet uninstall; fi
  fi
  # The record's folders leave mods/ together as the kept set (never deleted); only names the
  # pack can own, never Pocket Link, never a link.
  # Fresh names (mktemp): an earlier run's leftover is never taken for this run's and deleted.
  next=$(mktemp -d "$STATE/.prev-next.XXXXXX")
  moved=
  # The record's values are split on commas only, never glob-expanded (set -f).
  set -f
  IFS=,
  off=
  set --
  for m in $mods; do
    case $m in ''|pocket-link|*[!a-z0-9-]*) continue ;; esac
    if [ -L "$MODS/$m" ]; then say "Left $MODS/$m: it is a link, not a folder this script installed."; continue; fi
    if [ -d "$MODS/$m" ]; then
      set -- "$@" "$MODS/$m"
      moved=${moved:+$moved,}$m
    elif [ -d "$APP_HOME/mods-disabled/$m" ] && [ ! -L "$APP_HOME/mods-disabled/$m" ]; then
      # Switched off (the Mods panel, or a mod that ships off): kept as well, marked off, so a
      # reinstall or a rollback puts it back off.
      set -- "$@" "$APP_HOME/mods-disabled/$m"
      moved=${moved:+$moved,}$m
      off=${off:+$off,}$m
    fi
  done
  unset IFS
  set +f
  if [ "$via" = updater ]; then
    say "Removing the pack through its updater ($upd pack-out): a move that fails undoes the others."
    rc=0
    out=$(pack_out "$upd" "$next" "$drop" "$@") || rc=$?
    # What it did, read from the disk: a folder is out once it is in $next.
    gone=
    still=
    for f; do
      if [ -e "$next/${f##*/}" ] || [ -L "$next/${f##*/}" ]; then gone=${gone:+$gone, }${f##*/}; else still=${still:+$still, }${f##*/}; fi
    done
    layout_gone=no
    if [ -n "$drop" ] && [ ! -e "$drop" ] && [ ! -L "$drop" ]; then layout_gone=yes; fi
    err=$(printf '%s\n' "$out" | sed -n 's/.*"error":"\(.*\)"}.*/\1/p' | head -n 1)
    if [ "$rc" = 0 ] && [ -z "$still" ]; then
      if [ -n "$drop" ] && printf '%s\n' "$out" | grep -Fqx "left $drop"; then say_left_layout
      elif [ "$layout_gone" = yes ]; then say_removed_layout
      elif [ -n "$drop" ]; then say "Left $LAYOUT: the updater's pack-out did not remove it."; fi
    elif [ -z "$gone" ] && [ "$layout_gone" = no ]; then
      # pack-out changed nothing: this script does it all instead.
      say "Removing the pack with this script instead (the updater's pack-out failed${err:+: $err}; it changed nothing)."
      [ -z "$drop" ] || drop_layout
      via=shell
    else
      # Part done: nothing more moves, the record stays, and where each folder is gets said.
      lay=; [ -z "$drop" ] || { if [ "$layout_gone" = yes ]; then lay=" The automagik layout ($LAYOUT) is gone."; else lay=" The automagik layout ($LAYOUT) is in place."; fi; }
      fail "the updater's pack-out stopped partway${err:+ ($err)}. Already out, in $next: ${gone:-none}. Still in place: ${still:-none}.$lay The record ($MARK) stays: move the folders in $next back (mods/, or mods-disabled/ for ${off:-none}), then run --uninstall again."
    fi
  fi
  if [ "$via" = shell ]; then for f; do mv "$f" "$next/${f##*/}"; done; fi
  set -f
  IFS=,
  # A folder already kept (one a rollback moved out, with its state) stays kept beside them.
  if [ -n "$moved" ] && [ -f "$STATE/.prev/.pack" ]; then
    was_off=,$(sed -n 's/^off=//p' "$STATE/.prev/.pack" | head -n 1),
    for m in $(sed -n 's/^mods=//p' "$STATE/.prev/.pack" | head -n 1); do
      case $m in ''|pocket-link|*[!a-z0-9-]*) continue ;; esac
      if [ -d "$STATE/.prev/$m" ] && [ ! -L "$STATE/.prev/$m" ] && [ ! -e "$next/$m" ]; then
        mv "$STATE/.prev/$m" "$next/$m"
        moved=$moved,$m
        case $was_off in *",$m,"*) off=${off:+$off,}$m ;; esac
      fi
    done
  fi
  unset IFS
  set +f
  if [ -n "$moved" ]; then
    printf 'version=%s\nmods=%s\nbefore=none\n' "$(mark_get version)" "$moved" >"$next/.pack"
    if [ -n "$off" ]; then printf 'off=%s\n' "$off" >>"$next/.pack"; fi
    # The old set is set aside first and removed last: a failure never loses the folders just moved.
    old=$(mktemp -d "$STATE/.prev-old.XXXXXX")
    if [ -e "$STATE/.prev" ]; then mv "$STATE/.prev" "$old/set"; fi
    mv "$next" "$STATE/.prev"
    rm -rf "$old" 2>/dev/null || say "Could not remove the older kept set; it is in $old."
    say "Moved the pack out of $MODS ($moved); it is kept in $STATE/.prev."
  else
    rm -rf "$next"
  fi
  # What the person had before: each adopted folder comes back, unless something is in its place.
  # Only backup/<name> (release.js parseMarker's rule), or v0.2's before-install copy.
  set -f
  IFS=,
  for e in $adopted; do
    m=${e%%:*}
    p=${e#*:}
    case $m in ''|pocket-link|*[!a-z0-9-]*) continue ;; esac
    case $e in
      "$OLD:v1") p=${BEFORE#"$STATE"/} ;;
      *:backup/*) n=${p#backup/}
        case $n in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) continue ;; esac ;;
      *) continue ;;
    esac
    if [ -d "$STATE/$p" ] && [ ! -L "$STATE/$p" ] && [ ! -e "$MODS/$m" ]; then
      mv "$STATE/$p" "$MODS/$m"
      say "Put back $MODS/$m, the one that was there before the install."
    fi
  done
  unset IFS
  set +f
  if link_ours; then rm -f "$LINK"; say "Removed $LINK."
  elif [ -L "$LINK" ]; then say "Left $LINK: it points at $(readlink "$LINK"), not this install."; fi
  if link_ours "$AM_LINK"; then rm -f "$AM_LINK"; say "Removed $AM_LINK."
  elif am_link_is_am; then say "Left $AM_LINK: am's own link; am self uninstall hands it back."
  elif [ -L "$AM_LINK" ]; then say "Left $AM_LINK: it points at $(readlink "$AM_LINK"), not this install."; fi
  uninstall_meter
  uninstall_scheduler
  # The fleet coverage record the sidebar's meter run writes beside the record (meter.js).
  rm -f "$STATE/fleet-coverage.json"
  rm -f "$MARK"
  say "Done. Your bots (.herdr/bots.json in each project) and Herdr's settings are untouched. Reload Herdr's mods."
}

# ---- usagemeter (Group 6c) ----
# The version a usagemeter binary reports (`usagemeter --version` prints `usagemeter X.Y.Z`, a dev
# build maybe `usagemeter X.Y.Z-dev` or `X.Y.Z+build`), or nothing. Compare its X.Y.Z (${v%%[-+]*}).
meter_version() {
  "$1" --version </dev/null 2>/dev/null \
    | sed -n 's/^usagemeter \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\([-+][0-9A-Za-z.+-]*\)\{0,1\}\)$/\1/p' | head -n 1
}
# The meter-lane pointer: meter.json ($1) and its signature ($2), checked against METER_KEYS (ed25519
# over its exact bytes, every key tried before any field is read), then its fields as
# scripts/meter-lane.ts checkPointer checks them, then against the sequence this install took
# before ($3, may be empty): an older one is refused, so a re-posted older pointer never downgrades.
# Prints `<version> <sequence> <asset> <sha256>` for target $4; on a refusal prints why and
# returns 1. Node is checked before this runs.
read_meter_pointer() {
  # shellcheck disable=SC2016 # JavaScript: its ${...} are template literals, not the shell's.
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const [file, sigFile, keysJson, haveSeq, target] = process.argv.slice(1);
    const no = (why) => { console.log(`the meter-lane pointer ${why}: nothing was installed`); process.exit(1); };
    const REPO = "https://github.com/automagik-dev/automagik", DOWNLOADS = `${REPO}/releases/download`;
    const TARGETS = { "darwin-arm64": "usagemeter-darwin-arm64", "darwin-x86_64": "usagemeter-darwin-x86_64",
      "linux-x86_64": "usagemeter-linux-x86_64", "linux-aarch64": "usagemeter-linux-aarch64" };
    const bytes = fs.readFileSync(file);
    let sig = Buffer.alloc(0), keys = [];
    try { sig = Buffer.from(fs.readFileSync(sigFile, "utf8").trim(), "base64"); } catch {}
    try { keys = JSON.parse(keysJson).keys || []; } catch {}
    const signer = sig.length === 0 ? null : keys.find((k) => { try { return crypto.verify(null, bytes, crypto.createPublicKey(k.publicKey), sig); } catch { return false; } });
    if (!signer) no("is not signed by a key this installer trusts");
    let p;
    try { p = JSON.parse(bytes.toString("utf8")); } catch { no("is not JSON"); }
    if (!p || typeof p !== "object" || Array.isArray(p)) no("is not a JSON object");
    if (p.keyId !== signer.keyId) no(`names the key ${p.keyId}, but ${signer.keyId} signed it`);
    if (p.schemaVersion !== 1 || p.part !== "automagik.usagemeter") no(`is not a usagemeter pointer (schema ${p.schemaVersion}, part ${p.part})`);
    if (p.publisher !== "automagik" || p.repository !== REPO) no(`names another repository (${p.repository})`);
    const m = /^3\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(typeof p.version === "string" ? p.version : "");
    if (!m) no(`names no release version (${p.version})`);
    if (p.tag !== `v${p.version}`) no(`names the tag ${p.tag}, not v${p.version}`);
    if (!Number.isSafeInteger(p.sequence) || p.sequence !== Number(m[1]) * 10000 + Number(m[2])) no(`has the sequence ${p.sequence}, not the one ${p.version} has`);
    if (typeof p.commit !== "string" || !/^[0-9a-f]{40}$/.test(p.commit)) no("names no commit");
    const assets = p.assets && typeof p.assets === "object" && !Array.isArray(p.assets) ? p.assets : {};
    if (Object.keys(assets).sort().join() !== Object.keys(TARGETS).sort().join()) no(`does not name exactly the targets ${Object.keys(TARGETS).join(", ")}`);
    for (const [t, name] of Object.entries(TARGETS)) {
      const a = assets[t] && typeof assets[t] === "object" ? assets[t] : {};
      if (a.name !== name) no(`names ${a.name} for ${t}, not ${name}`);
      if (a.url !== `${DOWNLOADS}/${p.tag}/${name}`) no(`has ${name} at ${a.url}, off the tag ${p.tag}`);
      if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) no(`names no sha256 for ${name}`);
      if (!Number.isSafeInteger(a.size) || a.size <= 0) no(`names no size for ${name}`);
    }
    if (/^\d{1,15}$/.test(haveSeq || "") && p.sequence < Number(haveSeq)) no(`names ${p.version} (sequence ${p.sequence}), older than the sequence ${haveSeq} this install already took: refusing to downgrade`);
    const a = assets[target];
    if (!a) no(`names no build for ${target}`);
    console.log(`${p.version} ${p.sequence} ${a.name} ${a.sha256}`);
  ' "$1" "$2" "$METER_KEYS" "$3" "$4" </dev/null
}
# Whether version $1 >= $2, field by field as numbers (0.10.0 >= 0.9.0).
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }' </dev/null
}
# The marker's usagemeter lines, last and in release.js formatMarker's order (usagemeter=,
# usagemeter-sequence=, usagemeter-machines=, usagemeter-scope=), so a later rewrite by update.mjs
# changes nothing: $1 the usagemeter= value, $2 the usagemeter-scope= one and $3 the
# usagemeter-sequence= one (empty: dropped); the machines line kept.
# Unchanged values leave the record byte for byte (a rerun changes nothing). A v2 marker only.
mark_usagemeter() {
  grep -q '^mods=' "$MARK" 2>/dev/null || return 0
  machines=$(mark_get usagemeter-machines)
  m=$(mktemp "$STATE/.marker.XXXXXX") || return 1
  if { sed -e '/^usagemeter=/d' -e '/^usagemeter-sequence=/d' -e '/^usagemeter-machines=/d' -e '/^usagemeter-scope=/d' "$MARK"
    if [ -n "$1" ]; then printf 'usagemeter=%s\n' "$1"; fi
    if [ -n "$3" ]; then printf 'usagemeter-sequence=%s\n' "$3"; fi
    if [ -n "$machines" ]; then printf 'usagemeter-machines=%s\n' "$machines"; fi
    if [ -n "$2" ]; then printf 'usagemeter-scope=%s\n' "$2"; fi; } >"$m"; then
    if cmp -s "$m" "$MARK"; then rm -f "$m"; return 0; fi
    if mv "$m" "$MARK"; then return 0; fi
  fi
  rm -f "$m"
  return 1
}
mark_meter() { mark_usagemeter "$1" "$(mark_get usagemeter-scope)" "$(mark_get usagemeter-sequence)"; }
mark_scope() { mark_usagemeter "$(mark_get usagemeter)" "$1" "$(mark_get usagemeter-sequence)"; }
mark_sequence() { mark_usagemeter "$(mark_get usagemeter)" "$(mark_get usagemeter-scope)" "$1"; }
# Puts the build the signed meter-lane pointer names at $METER: the one for this OS and CPU,
# checked against the sha256 the pointer names, written to a temp file beside it, chmod 755,
# renamed into place. Never over a newer usagemeter (Pocket Link installs the same one; a
# pre-release counts by its X.Y.Z, so 3.N.P-dev stays), one that reports no version, a link or a
# folder. The pointer's sequence is recorded (a lower one is refused next time). Returns 1 with
# $why on a failure or a refusal; the caller only warns. Runs in a || list, where set -e is off:
# every step checks itself.
install_meter() {
  why=
  have=
  if [ -L "$METER" ] || { [ -e "$METER" ] && [ ! -f "$METER" ]; }; then
    say "usagemeter: left $METER, a link or a folder, as it is."
    mark_meter ""
    return 0
  fi
  if [ -f "$METER" ]; then
    have=$(meter_version "$METER")
    if [ -z "$have" ]; then
      say "Warning: $METER reports no usagemeter version; left it as it is (remove it to get usagemeter)."
      mark_meter ""
      return 0
    fi
  fi
  case $(uname -s 2>/dev/null)-$(uname -m 2>/dev/null) in
    Darwin-arm64|Darwin-aarch64) target=darwin-arm64 ;;
    Darwin-x86_64) target=darwin-x86_64 ;;
    Linux-x86_64|Linux-amd64) target=linux-x86_64 ;;
    Linux-aarch64|Linux-arm64) target=linux-aarch64 ;;
    *) why="no usagemeter build for $(uname -s 2>/dev/null) $(uname -m 2>/dev/null)"; return 1 ;;
  esac
  udir=$TMP/usagemeter
  mkdir -p "$udir" || { why="could not make $udir"; return 1; }
  upointer=$RELEASES/download/meter-lane/meter.json
  curl -fsSL --path-as-is "$upointer" -o "$udir/meter.json" </dev/null 2>/dev/null \
    || { why="could not download the meter-lane pointer $upointer"; return 1; }
  curl -fsSL --path-as-is "$upointer.sig" -o "$udir/meter.json.sig" </dev/null 2>/dev/null \
    || { why="the meter-lane pointer has no signature ($upointer.sig): nothing was installed"; return 1; }
  ulane=$(read_meter_pointer "$udir/meter.json" "$udir/meter.json.sig" "$(mark_get usagemeter-sequence)" "$target") \
    || { why=$ulane; return 1; }
  uwant=${ulane%% *}; urest=${ulane#* }
  useq=${urest%% *}; urest=${urest#* }
  asset=${urest%% *}; usum=${urest#* }
  mark_sequence "$useq" || say "usagemeter: the ownership record could not note the meter-lane pointer's sequence."
  if [ -n "$have" ]; then
    if [ "$have" = "$uwant" ]; then say "usagemeter $have: already installed ($METER)."; return 0; fi
    # Not older by its X.Y.Z: a newer release, or a dev build of this one or a newer one.
    if version_ge "${have%%[-+]*}" "$uwant"; then
      say "usagemeter $have is installed ($METER), not older than $uwant: not replacing it."
      mark_meter ""
      return 0
    fi
  fi
  ubase=$RELEASES/download/v$uwant
  case $ubase in file://*) uproto='=file' ;; *) uproto='=https' ;; esac
  say "Downloading usagemeter $uwant (the signed meter-lane pointer's)..."
  curl -fsSL --path-as-is --proto "$uproto" "$ubase/$asset" -o "$udir/$asset" </dev/null 2>/dev/null \
    || { why="could not download $ubase/$asset"; return 1; }
  if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$udir/$asset" </dev/null); else got=$(sha256sum "$udir/$asset" </dev/null); fi
  got=${got%% *}
  if [ "$got" != "$usum" ]; then
    why="$asset is not the build the signed meter-lane pointer names (sha256 $got, expected $usum): nothing was installed"
    return 1
  fi
  mkdir -p "$BIN_DIR" || { why="could not make $BIN_DIR"; return 1; }
  part=$(mktemp "$BIN_DIR/.usagemeter.XXXXXX") || { why="could not write in $BIN_DIR"; return 1; }
  if ! { cp "$udir/$asset" "$part" && chmod 755 "$part"; }; then rm -f "$part"; why="could not write $METER"; return 1; fi
  # Only after the sha256 matched: the new binary runs once, from beside the old one (a temp folder
  # may be noexec), with no variable but a bare PATH and a scratch HOME (usagemeter opens no network
  # connection), killed after 10 s; its whole answer must be exactly `usagemeter <version>`.
  env -i PATH=/usr/bin:/bin HOME="$udir" "$part" --version </dev/null >"$udir/smoke" 2>/dev/null & usp=$!
  ( sleep 10; kill -9 "$usp" ) </dev/null >/dev/null 2>&1 & ukp=$!
  wait "$usp"; kill "$ukp" 2>/dev/null
  uran=$(cat "$udir/smoke")
  if [ "$uran" != "usagemeter $uwant" ]; then
    rm -f "$part"
    usaid=$(printf '%s' "$uran" | tr '\n' ' ' | cut -c1-80)
    why="the new usagemeter does not run as $uwant (--version said: ${usaid:-nothing}): the old binary stays, nothing was installed"
    return 1
  fi
  # The binary it replaces (here only a regular file reporting an older version: a link, an
  # unversioned or a newer one returned above) is kept as $METER.prev for one swap: a hard link,
  # so its mode is the binary's. Going back is one rename: mv $METER.prev $METER.
  ukept=
  if [ -f "$METER" ] && [ ! -L "$METER" ]; then
    if [ -L "$METER.prev" ] || { [ -e "$METER.prev" ] && [ ! -f "$METER.prev" ]; }; then
      rm -f "$part"; why="$METER.prev is a link or a folder, not the backup this keeps: nothing was installed"; return 1
    fi
    if ! ln -f "$METER" "$METER.prev" 2>/dev/null; then
      rm -f "$part"; why="could not keep the previous binary as $METER.prev: nothing was installed"; return 1
    fi
    ukept=1
  fi
  if mv -f "$part" "$METER"; then
    say "Installed usagemeter $uwant ($METER, signed pointer, checksum ok)."
    [ -z "$ukept" ] || say "The previous usagemeter $have is kept as $METER.prev; to go back: mv $METER.prev $METER"
    mark_meter "$uwant" || say "usagemeter: the ownership record could not note it; --uninstall will leave it."
    return 0
  fi
  rm -f "$part"
  why="could not write $METER"
  return 1
}
# The pack's own CLI, run with node (install() checked it): meter install|uninstall on the linked
# machines. Its lines are printed as they are; it failing to run at all is only a warning.
fleet() {
  cli=$PACK/bin/automagik-herdr.mjs
  [ -f "$cli" ] || { say "Warning: usagemeter on linked machines: $cli is missing; skipped."; return 0; }
  # A release from before this command (--version <older>) has no meter: nothing to run.
  HERDR_APP_HOME=$APP_HOME node "$cli" help </dev/null 2>/dev/null | grep -q '^  meter install' \
    || { say "usagemeter on linked machines: skipped (this release's automagik-herdr has no meter install)."; return 0; }
  HERDR_APP_HOME=$APP_HOME node "$cli" meter "$@" </dev/null 2>&1 \
    || say "Warning: usagemeter on linked machines did not finish; 'automagik-herdr meter install' retries it."
}
meter_step() {
  if [ "$METER_OK" = 0 ]; then scope=none; elif [ "$FLEET_OK" = 0 ]; then scope=local; else scope=all; fi
  mark_scope "$scope" || say "usagemeter: the ownership record could not note --no-usagemeter or --usagemeter-local-only."
  if [ "$METER_OK" = 0 ]; then say "usagemeter: skipped (--no-usagemeter)."; return 0; fi
  install_meter || say "Warning: usagemeter was not installed: $why. The pack is installed; run this again later to retry."
}
# The linked machines, after the command is linked (the pack's CLI repoints an old link to its
# wrapper when it starts, which step e reports itself).
fleet_step() {
  [ "$METER_OK" = 1 ] || return 0
  if [ "$FLEET_OK" = 0 ]; then say "usagemeter on linked machines: skipped (--usagemeter-local-only)."; return 0; fi
  [ -n "$target" ] || { say "usagemeter on linked machines: skipped ($PACK is not this installer's)."; return 0; }
  fleet install --linked
}
# --uninstall: the binary goes only when the marker says this installer put it there, it still
# reports that version (a newer one is Pocket Link's or the person's), Pocket Link is not here, and
# --no-usagemeter was not given.
uninstall_meter() {
  um=$(mark_get usagemeter)
  [ -n "$um" ] || return 0
  if [ "$METER_OK" = 0 ]; then
    say "Left $METER (--no-usagemeter)."
  elif [ ! -f "$METER" ] || [ -L "$METER" ] || [ "$(meter_version "$METER")" != "$um" ]; then
    say "Left $METER: it is not the usagemeter $um this installer put there."
  elif [ -e "$MODS/pocket-link" ]; then
    say "Left $METER: Pocket Link ($MODS/pocket-link) runs it too."
  else
    rm -f "$METER" && say "Removed $METER (usagemeter $um). Its store is kept."
  fi
}

# ---- the automations scheduler (#220) ----
# herdr-automations: the program the Automations panel drives and the login service that fires the
# automations. Our build of the vendored fork (herdr/scheduler), from the release the pack itself
# pins: am-automations/scheduler.js, read out of the tarball this run has already checked, so this
# script holds no version and no hash of its own. Its own record, $SCHED_RECORD (version=, sha256=,
# and service=installed once this installer started the login service), says which binary is this
# installer's: only a regular file at $SCHED with exactly those bytes is ever replaced or removed.
# One on PATH somewhere else, a link, or a file this installer did not write is the person's and
# stays. automations.yaml and the run history are the scheduler's own: an existing file is never
# edited, and nothing here removes either.

# The sha256 of the file $1.
sha_of() {
  if command -v shasum >/dev/null 2>&1; then sha_out=$(shasum -a 256 "$1" </dev/null); else sha_out=$(sha256sum "$1" </dev/null); fi
  printf '%s\n' "${sha_out%% *}"
}
# Runs "$@" with no stdin and its stdout in the file $2, killed after $1 seconds (macOS has no
# `timeout`). The watchdog stops its own sleep when stopped, so no run leaves one behind.
bounded() {
  bsec=$1; bout=$2; shift 2
  "$@" </dev/null >"$bout" 2>/dev/null &
  basked=$!
  (
    nap=
    trap '[ -z "$nap" ] || { kill "$nap"; wait "$nap"; }; exit 0' TERM
    sleep "$bsec" &
    nap=$!
    wait "$nap" || true
    kill -9 "$basked" 2>/dev/null
  ) >/dev/null 2>&1 &
  bdog=$!
  brc=0
  wait "$basked" 2>/dev/null || brc=$?
  kill "$bdog" 2>/dev/null || true
  wait "$bdog" 2>/dev/null || true
  return "$brc"
}
sched_get() { sed -n "s/^$1=//p" "$SCHED_RECORD" 2>/dev/null | head -n 1; }
# The record: $1 the version, $2 the sha256 of the binary this installer wrote, $3 `installed` when
# it started the login service too (else empty). Written beside itself, then renamed.
sched_record() {
  mkdir -p "$STATE" || return 1
  { printf 'version=%s\nsha256=%s\n' "$1" "$2" && { [ -z "$3" ] || printf 'service=%s\n' "$3"; }; } >"$SCHED_RECORD.new" \
    || { rm -f "$SCHED_RECORD.new"; return 1; }
  mv -f "$SCHED_RECORD.new" "$SCHED_RECORD"
}
# Whether $SCHED is the binary this installer put there: a regular file, still the recorded bytes.
sched_ours() {
  [ -f "$SCHED_RECORD" ] || return 1
  { [ -f "$SCHED" ] && [ ! -L "$SCHED" ]; } || return 1
  sown=$(sched_get sha256)
  [ -n "$sown" ] && [ "$(sha_of "$SCHED")" = "$sown" ]
}
# What `<binary> version` says (its first line, nothing but version characters), or nothing.
sched_version() {
  bounded 10 "$TMP/sched-version" "$1" version || return 0
  sed -n '1p' "$TMP/sched-version" | tr -cd '0-9A-Za-z.+-' | cut -c1-40
}
# The build the pack pins for this machine: prints `<version> <asset> <sha256>` from the checked
# tarball's am-automations/scheduler.js; on a refusal prints why and returns 1. A release from
# before the pin (--version <older>) has none. Node is checked before this runs.
sched_pin() {
  spin_js=$TMP/x/am-automations/scheduler.js
  tar -xzf "$TMP/$TGZ" -C "$TMP/x" am-automations/scheduler.js </dev/null >/dev/null 2>&1 \
    || { say "release $VERSION's pack pins no scheduler build"; return 1; }
  { [ -f "$spin_js" ] && [ ! -L "$spin_js" ]; } || { say "$TGZ: am-automations/scheduler.js is not a plain file"; return 1; }
  cp "$spin_js" "$TMP/scheduler-pin.mjs" || { say "could not read the pack's scheduler pin"; return 1; }
  # shellcheck disable=SC2016 # JavaScript: its ${...} are template literals, not the shell's.
  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const [file, repo, os, machine] = process.argv.slice(1);
    const no = (why) => { console.log(why); process.exit(1); };
    let S;
    try { S = (await import(pathToFileURL(file).href)).SCHEDULER; } catch { no("the scheduler pin in the pack cannot be read"); }
    if (!S || S.repo !== repo || !/^\d+\.\d+\.\d+-am\.\d+$/.test(S.version || "")) no("the scheduler pin in the pack is not one this installer knows");
    const arch = { arm64: "arm64", aarch64: "arm64", x86_64: "amd64", amd64: "amd64" }[machine];
    const pins = { Darwin: ["darwin", S.sha256], Linux: ["linux", S.linux] }[os];
    const sum = arch && pins && pins[1] ? pins[1][arch] : null;
    if (!/^[0-9a-f]{64}$/.test(sum || "")) no(`the pack pins no herdr-automations ${S.version} build for ${os} ${machine}`);
    console.log(`${S.version} herdr-automations_${pins[0]}_${arch} ${sum}`);
  ' "$TMP/scheduler-pin.mjs" "$REPO" "$(uname -s 2>/dev/null)" "$(uname -m 2>/dev/null)" </dev/null 2>/dev/null
}
# Puts the pinned build at $SCHED: checked against the pack's sha256, written to a temp file beside
# it, chmod 755, run once (`version` must be exactly the pinned one), renamed into place, recorded.
# Sets SCHED_BIN to the scheduler the health check asks (ours, or the person's own, left as it is)
# and SCHED_NEW=1 when this run put a new binary in place. Returns 1 with $why on a failure; the
# caller only warns. Runs in a || list, where set -e is off: every step checks itself.
install_scheduler() {
  why=
  SCHED_BIN=
  SCHED_NEW=0
  sother=$(command -v herdr-automations 2>/dev/null || :)
  if [ -n "$sother" ] && [ "$sother" != "$SCHED" ]; then
    say "Automations scheduler: left $sother as it is (on PATH, not this installer's)."
    SCHED_BIN=$sother
    return 0
  fi
  if [ -L "$SCHED" ] || { [ -e "$SCHED" ] && [ ! -f "$SCHED" ]; }; then
    say "Automations scheduler: left $SCHED, a link or a folder, as it is."
    if [ -x "$SCHED" ] && [ ! -d "$SCHED" ]; then SCHED_BIN=$SCHED; fi
    return 0
  fi
  shad=
  sforeign=0
  if [ -f "$SCHED" ]; then
    SCHED_BIN=$SCHED
    if sched_ours; then shad=$(sched_get version); else sforeign=1; fi
  fi
  spin=$(sched_pin) || {
    why=${spin:-the scheduler pin in the pack cannot be read}
    [ "$sforeign" = 0 ] || { say "Automations scheduler: left $SCHED as it is (not installed by this installer)."; return 0; }
    return 1
  }
  swant=${spin%% *}; srest=${spin#* }
  sasset=${srest%% *}; ssum=${srest#* }
  if [ "$sforeign" = 1 ]; then
    # Not this installer's by the record. Exactly the pinned bytes (the panel's repair command puts
    # them there) is adopted: recorded, nothing replaced, so a later pin reaches it. Anything else
    # is the person's own and stays.
    if [ "$(sha_of "$SCHED")" = "$ssum" ]; then
      if sched_record "$swant" "$ssum" ""; then
        say "herdr-automations $swant: already installed ($SCHED), exactly the build the pack pins; this installer keeps it up to date from now on."
      else
        say "Automations scheduler: left $SCHED as it is (the pinned build; its record, $SCHED_RECORD, could not be written)."
      fi
      return 0
    fi
    say "Automations scheduler: left $SCHED as it is (not installed by this installer; it reports version $(sched_version "$SCHED"))."
    return 0
  fi
  if [ -n "$shad" ] && [ "$(sched_get sha256)" = "$ssum" ]; then
    say "herdr-automations $swant: already installed ($SCHED)."
    return 0
  fi
  sdir=$TMP/scheduler
  mkdir -p "$sdir" || { why="could not make $sdir"; return 1; }
  sbase=$RELEASES/download/herdr-automations-v$swant
  case $sbase in file://*) sproto='=file' ;; *) sproto='=https' ;; esac
  say "Downloading the automations scheduler (herdr-automations $swant, the build the pack pins)..."
  curl -fsSL --path-as-is --proto "$sproto" "$sbase/$sasset" -o "$sdir/$sasset" </dev/null 2>/dev/null \
    || { why="could not download $sbase/$sasset"; return 1; }
  sgot=$(sha_of "$sdir/$sasset")
  if [ "$sgot" != "$ssum" ]; then
    why="$sasset is not the build the pack pins (sha256 $sgot, expected $ssum): nothing was installed"
    return 1
  fi
  mkdir -p "$BIN_DIR" || { why="could not make $BIN_DIR"; return 1; }
  spart=$(mktemp "$BIN_DIR/.herdr-automations.XXXXXX") || { why="could not write in $BIN_DIR"; return 1; }
  if ! { cp "$sdir/$sasset" "$spart" && chmod 755 "$spart"; }; then rm -f "$spart"; why="could not write $SCHED"; return 1; fi
  # Only after the sha256 matched: the new binary runs once, from beside the old one (a temp folder
  # may be noexec), with no variable but a bare PATH and a scratch HOME, killed after 10 s; its
  # whole answer must be exactly the pinned version.
  bounded 10 "$sdir/smoke" env -i PATH=/usr/bin:/bin HOME="$sdir" "$spart" version || :
  sran=$(cat "$sdir/smoke" 2>/dev/null)
  if [ "$sran" != "$swant" ]; then
    rm -f "$spart"
    ssaid=$(printf '%s' "$sran" | tr '\n' ' ' | cut -c1-80)
    why="the new herdr-automations does not run as $swant (version said: ${ssaid:-nothing}): nothing was installed"
    return 1
  fi
  ssvc=$(sched_get service)
  if ! mv -f "$spart" "$SCHED"; then rm -f "$spart"; why="could not write $SCHED"; return 1; fi
  SCHED_BIN=$SCHED
  SCHED_NEW=1
  if [ -n "$shad" ]; then say "Updated herdr-automations $shad to $swant ($SCHED, pinned by the pack, checksum ok)."
  else say "Installed herdr-automations $swant ($SCHED, pinned by the pack, checksum ok)."; fi
  sched_record "$swant" "$ssum" "$ssvc" \
    || say "Automations scheduler: its record ($SCHED_RECORD) could not be written; an update or --uninstall will leave $SCHED."
  return 0
}
# What `ls --json` says, the health check's one question: prints `<backend> <pid> <config path>`
# (backend herdr when the file names none, as the scheduler reads it; pid 0 when no scheduler runs);
# returns 1 when the binary gives no listing within 15 s.
sched_ls() {
  bounded 15 "$TMP/sched-ls.json" "$1" ls --json || return 1
  # shellcheck disable=SC2016 # JavaScript: its ${...} are template literals, not the shell's.
  node -e '
    let j;
    try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
    if (!j || typeof j !== "object" || Array.isArray(j) || !("scheduler" in j)) process.exit(1);
    const backend = j.backend === undefined || j.backend === "" ? "herdr" : /^[a-z]{1,16}$/.test(j.backend) ? j.backend : "unknown";
    const pid = Number.isSafeInteger(j.scheduler) && j.scheduler > 0 ? j.scheduler : 0;
    const config = typeof j.config === "string" && j.config.startsWith("/") && !/[\r\n]/.test(j.config) ? j.config : "";
    console.log(`${backend} ${pid} ${config}`);
  ' "$TMP/sched-ls.json" </dev/null 2>/dev/null
}
# `service install` with ~/.local/bin on PATH (the service keeps the PATH it was installed with, to
# find hc, git and the agents). Records that the service is this installer's.
sched_service() {
  case ":$PATH:" in *":$BIN_DIR:"*) spath=$PATH ;; *) spath=$PATH:$BIN_DIR ;; esac
  if sout=$(PATH=$spath "$SCHED" service install </dev/null 2>&1); then
    SCHED_STARTED=1
    say "Automations: the scheduler's login service is installed and started${1:+ ($1)}."
    sched_record "$(sched_get version)" "$(sched_get sha256)" installed \
      || say "Automations scheduler: its record could not note the login service; --uninstall will leave the service."
  else
    say "Warning: the scheduler's login service was not started: $(printf '%s\n' "$sout" | sed -n '$p'). 'herdr-automations service install' retries it."
  fi
}
# For the binary this installer put there only. The backend: a machine with no automations.yaml
# gets one saying `backend: hc` (runs open in the Herdr app); an existing file is never edited.
# The login service: asked for (--yes says yes; no terminal, no) unless the scheduler already
# runs; restarted without asking only when it is this installer's and the binary was replaced.
sched_setup() {
  sls=$(sched_ls "$SCHED") || return 0
  sbackend=${sls%% *}; srest=${sls#* }
  spid=${srest%% *}; sconfig=${srest#* }
  if [ -n "$sconfig" ] && [ ! -e "$sconfig" ] && [ ! -L "$sconfig" ]; then
    if mkdir -p "${sconfig%/*}" && printf 'backend: hc\n' >"$sconfig"; then
      say "Automations: wrote $sconfig with 'backend: hc' (runs open in the Herdr app)."
    else
      say "Warning: could not write $sconfig; set 'backend: hc' there for runs to open in the Herdr app."
    fi
  elif [ "$sbackend" != hc ] && [ "$sbackend" != auto ]; then
    say "Automations: left ${sconfig:-automations.yaml} as it is (backend: $sbackend); runs open in the Herdr app only with 'backend: hc' there."
  fi
  ssvc=$(sched_get service)
  if [ "$SCHED_NEW" = 1 ] && [ "$ssvc" = installed ]; then
    sched_service "restarted on the new build"
    return 0
  fi
  if [ "$spid" != 0 ]; then
    [ "$SCHED_NEW" = 0 ] || say "Automations: a scheduler is already running (pid $spid), not started by this installer; restart it to run the new build."
    return 0
  fi
  bounded 15 "$TMP/sched-status" "$SCHED" service status || :
  if grep -q '^service installed: true' "$TMP/sched-status" 2>/dev/null && [ "$ssvc" != installed ]; then
    say "Warning: a login service for herdr-automations is installed, not by this installer, and the scheduler is not running; left as it is. 'herdr-automations service install' restarts it."
    return 0
  fi
  if ask "Start the automations scheduler when you log in (herdr-automations service install: a login service for your user, no sudo)?"; then
    sched_service ""
  else
    say "Automations: the scheduler is installed but not started; 'herdr-automations service install' (or Start in the Automations panel) starts it at login."
  fi
}
# The runtime check, for whichever scheduler this machine runs (ours, or the person's own): the
# binary answers `ls --json`, the scheduler runs, and the backend is the app's. One line says which.
sched_health() {
  stries=0
  while :; do
    sls=$(sched_ls "$SCHED_BIN") \
      || { say "Warning: Automations is not ready: $SCHED_BIN gave no answer to 'ls --json'."; return 0; }
    sbackend=${sls%% *}; srest=${sls#* }
    spid=${srest%% *}
    # A service started a moment ago may not hold its lock yet: asked again, for 5 s at most.
    if [ "$spid" != 0 ] || [ "$SCHED_STARTED" != 1 ] || [ "$stries" -ge 5 ]; then break; fi
    stries=$((stries + 1))
    sleep 1
  done
  sver=$(sched_version "$SCHED_BIN")
  if [ "$spid" = 0 ]; then
    say "Warning: Automations is not ready: herdr-automations ${sver:-?} answers (backend $sbackend), but no scheduler is running, so nothing runs on time. Start it: herdr-automations service install"
  elif [ "$sbackend" != hc ] && [ "$sbackend" != auto ]; then
    say "Warning: Automations is not ready for the Herdr app: the scheduler runs (pid $spid, herdr-automations ${sver:-?}), but with backend $sbackend its runs open in the Herdr TUI."
  else
    say "Automations: ready (herdr-automations ${sver:-?}, backend $sbackend, scheduler running, pid $spid)."
  fi
}
# Runs in a || list, where set -e is off: every step checks itself.
sched_step() {
  SCHED_BIN=
  SCHED_NEW=0
  SCHED_STARTED=0
  if [ "$SCHED_OK" = 0 ]; then say "Automations scheduler: skipped (--no-scheduler)."; return 0; fi
  install_scheduler || say "Warning: the automations scheduler was not installed: $why. The pack is installed; run this again later to retry."
  [ -n "$SCHED_BIN" ] || return 0
  if [ "$SCHED_BIN" = "$SCHED" ] && sched_ours; then sched_setup; fi
  sched_health
}
# --uninstall: the binary goes only while it is still the bytes this installer wrote, and the login
# service only when this installer started it (through the binary's own `service uninstall`); while
# a service someone else started is installed (`service status`), the binary stays too.
# automations.yaml and the run history stay.
uninstall_scheduler() {
  [ -f "$SCHED_RECORD" ] || return 0
  if [ "$SCHED_OK" = 0 ]; then say "Left $SCHED (--no-scheduler)."; return 0; fi
  if ! sched_ours; then
    if [ -e "$SCHED" ] || [ -L "$SCHED" ]; then say "Left $SCHED: it is not the herdr-automations $(sched_get version) this installer put there."; fi
    rm -f "$SCHED_RECORD"
    return 0
  fi
  # A login service this installer did not start (Start in the panel, or `service install` by hand)
  # runs this binary and restarts it for good: the binary stays, so nothing relaunches a missing
  # file, and the person removes both. The record stays with it: the binary is still ours.
  # `service status` is asked with the same 15 s limit as the install side's questions; with no
  # answer nobody knows whether a service runs it, so the binary stays then too.
  if [ "$(sched_get service)" != installed ]; then
    sstat=$(mktemp "${TMPDIR:-/tmp}/automagik-herdr-scheduler.XXXXXX") || sstat=
    if [ -z "$sstat" ] || ! bounded 15 "$sstat" "$SCHED" service status; then
      [ -z "$sstat" ] || rm -f "$sstat"
      say "Left $SCHED: it gave no answer to 'service status' within 15 s, so whether a login service runs it is not known. To remove both: herdr-automations service uninstall, then rm $SCHED"
      return 0
    fi
    if grep -q '^service installed: true' "$sstat"; then
      rm -f "$sstat"
      say "Left $SCHED: a login service this installer did not start runs it (removing the binary would leave that service restarting a missing file). To remove both: herdr-automations service uninstall, then rm $SCHED"
      return 0
    fi
    rm -f "$sstat"
  fi
  if [ "$(sched_get service)" = installed ]; then
    if sout=$("$SCHED" service uninstall </dev/null 2>&1); then
      say "Removed the automations scheduler's login service."
    else
      say "Warning: the scheduler's login service was not removed: $(printf '%s\n' "$sout" | sed -n '$p'). Left $SCHED; run 'herdr-automations service uninstall', then remove it."
      return 0
    fi
  fi
  rm -f "$SCHED" && say "Removed $SCHED (herdr-automations $(sched_get version)). automations.yaml and the run history are kept."
  rm -f "$SCHED_RECORD"
}

# ---- DSH as a Herdr agent (dsh-TUI, #561) ----
# The profile, the pin and the shim are the pack CLI's (`automagik-herdr dsh-tui install`), which
# writes DSH's own `dsh-tui` profile and never the desktop one. This step only decides whether to ask;
# a machine with no dsh gets the one line the CLI gives, and nothing is written.
dsh_tui_step() {
  [ "$DSH_TUI" = no ] && { say "Left DSH (dsh-TUI) alone (--no-dsh-tui)."; return 0; }
  if ! command -v dsh >/dev/null 2>&1; then
    say "DSH is not installed (no dsh on PATH): skipped dsh-TUI. Install DSH Desktop or 'npm install -g @deepseek-ai/dsh', then run 'automagik-herdr dsh-tui install'."
    return 0
  fi
  if [ "$DSH_TUI" = ask ] && [ "$YES" = 1 ]; then
    say "Left DSH (dsh-TUI) alone: --yes never installs the third-party dsh-TUI package; 'automagik-herdr dsh-tui install' or this installer with --dsh-tui adds it."
    return 0
  fi
  if [ "$DSH_TUI" = ask ] && ! ask_opt_in "Install DSH as a Herdr agent (dsh-TUI, its own dsh-tui DSH profile; a third-party package)?"; then
    say "Left DSH (dsh-TUI) alone; 'automagik-herdr dsh-tui install' adds it later."
    return 0
  fi
  dsh_rc=0
  dsh_out=$("$LINK" dsh-tui install <"/dev/null" 2>&1) || dsh_rc=$?
  if [ "$dsh_rc" != 0 ]; then
    say "Warning: dsh-TUI was not installed: $(printf '%s\n' "$dsh_out" | sed -n '$p')"
    return 0
  fi
  printf '%s\n' "$dsh_out" | sed 's/^/  /'
}
# The login service that runs 'automagik-herdr revive --boot' (#939). The unit is the pack CLI's
# ('automagik-herdr revive service install'); this step only decides whether to ask. Linux only:
# on another OS nothing is asked and nothing is written.
revive_step() {
  [ "$(uname -s)" = Linux ] || return 0
  [ "$REVIVE" = no ] && { say "Left the revive login service alone (--no-revive)."; return 0; }
  [ -x "$LINK" ] || return 0
  if [ -f "$REVIVE_UNIT" ] && [ "$REVIVE" = ask ]; then return 0; fi
  if [ "$REVIVE" = ask ] && [ "$YES" = 1 ]; then
    say "Left the revive login service alone: --yes never changes what runs at login; 'automagik-herdr revive service install' or this installer with --revive adds it."
    return 0
  fi
  if [ "$REVIVE" = ask ] && ! ask_opt_in "Bring the bots back by themselves after a restart of this computer (a login service that runs 'automagik-herdr revive --boot')?"; then
    say "Left the revive login service alone; 'automagik-herdr revive service install' adds it later."
    return 0
  fi
  revive_rc=0
  revive_out=$("$LINK" revive service install <"/dev/null" 2>&1) || revive_rc=$?
  if [ "$revive_rc" != 0 ]; then
    say "Warning: the revive login service was not installed: $(printf '%s\n' "$revive_out" | sed -n '$p')"
    return 0
  fi
  printf '%s\n' "$revive_out" | sed 's/^/  /'
}
# --uninstall: the unit goes through the command that wrote it, while the pack and its link are
# still in place, and only when its first line is the pack's mark (revive.js UNIT_MARK).
revive_uninstall() {
  [ -f "$REVIVE_UNIT" ] || return 0
  if ! sed -n '1p' "$REVIVE_UNIT" 2>/dev/null | grep -q '^# Automagik Herdr: brings the bots back after a restart'; then
    say "Left $REVIVE_UNIT: it is not this installer's."
    return 0
  fi
  if link_ours && [ -f "$PACK/bin/automagik-herdr.mjs" ] && grep -q 'revive service' "$PACK/bin/automagik-herdr.mjs" 2>/dev/null; then
    revive_rc=0
    revive_out=$("$LINK" revive service uninstall <"/dev/null" 2>&1) || revive_rc=$?
    if [ "$revive_rc" = 0 ]; then printf '%s\n' "$revive_out" | sed 's/^/  /'; return 0; fi
  fi
  rm -f "$REVIVE_UNIT" && say "Removed $REVIVE_UNIT (systemctl --user daemon-reload drops it from systemd)."
  return 0
}
# --uninstall: the plugin and the shim go through the command that put them there, while the pack
# and its link are still in place. A pack from before this command removes its own shim, nothing
# else; the predicate is the CLI's shimIsOurs (the marker and the exec line), not any mention of
# Automagik Herdr.
dsh_shim_is_ours() {
  [ -f "$1" ] || return 1
  grep -Fq "# Automagik Herdr's dsh-tui shim" "$1" 2>/dev/null || return 1
  grep -Fqx 'exec dsh --profile dsh-tui "$@"' "$1" 2>/dev/null && return 0
  grep -Fqx 'exec dsh --profile tui -- "$@"' "$1" 2>/dev/null
}
dsh_tui_uninstall() {
  if link_ours && [ -f "$PACK/bin/automagik-herdr.mjs" ] && grep -q 'dsh-tui install' "$PACK/bin/automagik-herdr.mjs" 2>/dev/null; then
    dsh_rc=0
    dsh_out=$("$LINK" dsh-tui uninstall <"/dev/null" 2>&1) || dsh_rc=$?
    if [ "$dsh_rc" != 0 ]; then
      say "Warning: dsh-TUI was not removed: $(printf '%s\n' "$dsh_out" | sed -n '$p')"
      return 0
    fi
    printf '%s\n' "$dsh_out" | sed 's/^/  /'
    return 0
  fi
  if [ -e "$BIN_DIR/dsh-tui" ] || [ -L "$BIN_DIR/dsh-tui" ]; then
    if dsh_shim_is_ours "$BIN_DIR/dsh-tui"; then
      rm -f "$BIN_DIR/dsh-tui" && say "Removed $BIN_DIR/dsh-tui; the dsh-tui DSH profile was left as it is (no installed dsh-tui command to run)."
    else
      say "Left $BIN_DIR/dsh-tui: it is not this installer's (or it is a dangling link)."
    fi
  fi
  return 0
}

# The pack pointer: pack.json ($1) and its signature ($2), checked against TRUSTED_KEYS (ed25519, as
# plugin-lane's lane.json.sig), then against what is installed: the marker's version ($3) and
# sequence ($4), either may be empty. A pointer older than either is refused, so a re-posted older
# pointer (signed, but replayed by someone who can write release assets) never downgrades; --version
# is the way to install an older release on purpose. Prints `<version> <sha256> <sequence>`; on a
# refusal prints why and returns 1. Node is checked before this runs.
read_pointer() {
  # shellcheck disable=SC2016 # JavaScript: its ${...} are template literals, not the shell's.
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const [file, sigFile, keysJson, haveVersion, haveSeq] = process.argv.slice(1);
    const no = (why) => { console.log(why); process.exit(1); };
    const bytes = fs.readFileSync(file);
    let p, keys;
    try { p = JSON.parse(bytes.toString("utf8")); keys = JSON.parse(keysJson).keys || []; } catch { no("it is not a pack pointer"); }
    const key = keys.find((k) => k && k.keyId === (p && p.keyId));
    if (!key) no(`it is signed by ${p && p.keyId}, a key this installer does not trust; nothing was installed`);
    let ok = false;
    try { ok = crypto.verify(null, bytes, crypto.createPublicKey(key.publicKey), Buffer.from(fs.readFileSync(sigFile, "utf8").trim(), "base64")); } catch {}
    if (!ok) no("its signature does not match; nothing was installed");
    const v = p.version, t = p.tarball || {};
    if (p.schemaVersion !== 1 || p.part !== "herdr" || !/^\d+\.\d+\.\d+$/.test(v || "") || t.name !== `automagik-herdr-pack-${v}.tgz` || !/^[0-9a-f]{64}$/.test(t.sha256 || "") || !Number.isSafeInteger(p.sequence) || p.sequence < 0) no("it is not a pack pointer");
    const older = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
    const refuse = (what) => no(`it names ${v} (sequence ${p.sequence}), older than the installed ${what}: refusing to downgrade; nothing was installed. To install ${v} on purpose: --version ${v}`);
    if (/^\d+\.\d+\.\d+$/.test(haveVersion || "") && older(v, haveVersion)) refuse(haveVersion);
    if (/^\d{1,15}$/.test(haveSeq || "") && p.sequence < Number(haveSeq)) refuse(`sequence ${haveSeq}`);
    console.log(`${v} ${t.sha256} ${p.sequence}`);
  ' "$1" "$2" "$TRUSTED_KEYS" "$3" "$4" </dev/null
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); const [x, y] = process.argv[1].split(".").map(Number); process.exit(a > x || (a === x && b >= y) ? 0 : 1)' "$NODE_MIN" </dev/null 2>/dev/null
}
# The CFBundleIdentifier of the app at $1, from its Info.plist: node reads an XML one (Herdr's
# is), PlistBuddy a binary one. Node is checked before this runs.
bundle_id() {
  [ -f "$1/Contents/Info.plist" ] || return 1
  rc=0
  node -e '
    const s = require("fs").readFileSync(process.argv[1], "latin1");
    if (s.startsWith("bplist")) process.exit(2);
    const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(s);
    if (!m) process.exit(1);
    console.log(m[1]);
  ' "$1/Contents/Info.plist" </dev/null 2>/dev/null || rc=$?
  [ "$rc" = 2 ] || return "$rc"
  [ -x /usr/libexec/PlistBuddy ] && /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" </dev/null 2>/dev/null
}
# macOS: an app with bundle id dev.herdr.app (where herdrdev's installer puts it, ~/Applications,
# or /Applications), never just a folder named Herdr.app. Linux:
# herdr-app on PATH, or in ~/.local/bin where herdrdev's installer links it.
herdr_ok() {
  if [ "$os" = Darwin ]; then
    for app in "$HOME/Applications/Herdr.app" "$APPS/Herdr.app"; do
      [ "$(bundle_id "$app")" = "$HERDR_ID" ] && return 0
    done
    return 1
  fi
  command -v herdr-app >/dev/null 2>&1 || [ -x "$BIN_DIR/herdr-app" ]
}

install() {
  # ---- a. supported OS ----
  os=$(uname -s)
  case $os in
    Darwin) say "macOS: ok." ;;
    Linux) say "Linux: ok." ;;
    *) fail "Automagik Herdr supports macOS and Linux; this is $os." ;;
  esac

  # ---- b. Node ----
  if ! node_ok; then
    have=$(node --version 2>/dev/null || echo none)
    if [ "$os" = Darwin ] && command -v brew >/dev/null 2>&1; then
      if ask "Node $NODE_MIN or later is needed (found: $have). Install it with 'brew install node'?"; then
        brew install node </dev/null
        node_ok || fail "Node is still older than $NODE_MIN after brew; open a new terminal and run this again."
      else
        fail "Node $NODE_MIN or later is needed (found: $have). Run: brew install node   then run this again."
      fi
    else
      fail "Node $NODE_MIN or later is needed (found: $have). Install it from https://nodejs.org, then run this again."
    fi
  fi
  say "Node $(node --version): ok."

  # ---- c. Herdr ----
  # herdrdev's own installer, run only after asking: no sudo, no package manager. Linux: the app
  # in ~/.local/share/herdr-app; macOS: ~/Applications/Herdr.app. Both link herdr-app into
  # ~/.local/bin, and it adds herdr-core and hc when there are none.
  if ! herdr_ok; then
    herdr_hint="Install it with: curl -fsSL $HERDR_INSTALLER | sh   then run this again."
    if [ "$os" = Darwin ]; then
      missing="Herdr (dev.herdr.app) is not in $HOME/Applications or $APPS"
      for app in "$HOME/Applications/Herdr.app" "$APPS/Herdr.app"; do
        [ -e "$app" ] || [ -L "$app" ] || continue
        if other=$(bundle_id "$app") && [ -n "$other" ]; then
          say "$app is $other, a different app named Herdr, not dev.herdr.app (the Herdr this pack runs in); it is left alone."
        else
          say "$app is not dev.herdr.app (the Herdr this pack runs in): its bundle id cannot be read; it is left alone."
        fi
        # herdrdev's installer rm -rf's ~/Applications/Herdr.app: only ever over dev.herdr.app,
        # so anything else there (another app, an unreadable one, a plain file) stops the install.
        [ "$app" = "$HOME/Applications/Herdr.app" ] &&
          fail "Herdr's installer would replace $app, which is not dev.herdr.app. Move it out of $HOME/Applications, then run this again."
      done
    else
      missing="Herdr is not installed (herdr-app is not on PATH or in $BIN_DIR)"
    fi
    if ask "$missing. Install it with Herdr's own installer ($HERDR_INSTALLER, no sudo)?"; then
      TMP=$(mktemp -d "${TMPDIR:-/tmp}/automagik-herdr.XXXXXX")
      # Downloaded whole before it runs; stdin may be this very installer.
      curl -fsSL "$HERDR_INSTALLER" -o "$TMP/herdr-install.sh" --path-as-is --proto '=https' </dev/null \
        || fail "could not download Herdr's installer. $herdr_hint"
      sh "$TMP/herdr-install.sh" </dev/null || fail "Herdr's installer failed (above). $herdr_hint"
      herdr_ok || fail "Herdr's installer finished, but $missing still. $herdr_hint"
      rm -rf "$TMP"
      TMP=
    else
      fail "$missing. $herdr_hint"
    fi
  fi
  # herdr-app's link is in ~/.local/bin, which PATH may lack: the mod checks below need it.
  if ! command -v herdr-app >/dev/null 2>&1 && [ -x "$BIN_DIR/herdr-app" ]; then
    PATH=$PATH:$BIN_DIR
    export PATH
  fi
  say "Herdr: ok."

  # ---- d. the pack ----
  # Nothing is written into the app home before the tarball matches the signed pointer's sha256.
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/automagik-herdr.XXXXXX")
  want=
  SEQUENCE=
  if [ -z "$WANT" ]; then
    # The newest pack, named by the signed pointer: one file and its signature, never a search.
    POINTER=$RELEASES/download/herdr-lane/pack.json
    curl -fsSL --path-as-is "$POINTER" -o "$TMP/pack.json" </dev/null || fail "could not download $POINTER (is a pack released yet?)."
    curl -fsSL --path-as-is "$POINTER.sig" -o "$TMP/pack.json.sig" </dev/null || fail "could not download $POINTER.sig: refusing the pointer."
    signed=$(read_pointer "$TMP/pack.json" "$TMP/pack.json.sig" "$(mark_get version)" "$(mark_get sequence)") || fail "the pack pointer $POINTER: $signed"
    WANT=${signed%% *}
    SEQUENCE=${signed##* }
    want=${signed#* }
    want=${want%% *}
    checked="the signed pointer"
    say "Pack pointer: signed by a key this installer trusts; it names $WANT."
  fi
  case $WANT in
    *[!0-9.]*|.*|*.|*..*) fail "--version takes a version like 3.58.0; not $WANT." ;;
  esac
  base=$RELEASES/download/v$WANT
  TGZ=automagik-herdr-pack-$WANT.tgz
  if [ -z "$want" ]; then
    # --version: that release's own .sha256, which proves integrity, not who published it.
    SUMS=$TGZ.sha256
    curl -fsSL --path-as-is "$base/$SUMS" -o "$TMP/$SUMS" </dev/null \
      || fail "could not download $base/$SUMS (does release v$WANT carry the pack? Not every Automagik release does)."
    want=$(sed -n "s/^\([0-9a-fA-F]\{64\}\) [ *]$TGZ\$/\1/p" "$TMP/$SUMS" | head -n 1 | tr 'A-F' 'a-f')
    [ -n "$want" ] || fail "$base/$SUMS does not list $TGZ."
    checked=$SUMS
    say "Note: --version $WANT is checked against its release's .sha256 (integrity, not who published it); without --version the newest pack comes through the signed pointer."
  fi
  VERSION=$WANT

  installed=$(mark_get version)
  [ -n "$installed" ] || installed=none
  # This release already installed: its tarball is downloaded all the same, and every installed
  # file is checked against it (update.mjs repair) before anything is called up to date.
  same=no
  if [ "$ADOPT" = 0 ] && [ "$installed" = "$VERSION" ] && grep -q '^mods=' "$MARK" 2>/dev/null; then same=yes; fi

  if [ "$same" = yes ]; then say "Checking the installed Automagik Herdr $VERSION against the release..."
  else say "Downloading Automagik Herdr $VERSION..."; fi
  curl -fsSL --path-as-is "$base/$TGZ" -o "$TMP/$TGZ" </dev/null || fail "could not download $base/$TGZ."
  if command -v shasum >/dev/null 2>&1; then sum=$(shasum -a 256 "$TMP/$TGZ"); else sum=$(sha256sum "$TMP/$TGZ"); fi
  sum=${sum%% *}
  [ "$sum" = "$want" ] || fail "$TGZ does not match $checked (sha256 $sum, expected $want): nothing was installed."
  say "Checksum: ok."
  # Only the installer's files come out here, to run them; update.mjs then lists every entry,
  # stages every folder beside mods/, checks again, keeps the replaced set and swaps, and the
  # migration (migrate.js, migrateHome.mjs) moves layouts and keys onto renamed folders, and
  # migrateHooks.mjs (with briefingText.mjs, model.js, its models.js and their retired.js) the
  # briefing hooks onto a fixed path; layoutSafe.mjs is the one door update.mjs and the migration
  # move folders and layouts through.
  mkdir "$TMP/x"
  side=${PACK##*/}
  tar -xzf "$TMP/$TGZ" -C "$TMP/x" "$side/update.mjs" "$side/release.js" "$side/migrate.js" \
    "$side/migrateHome.mjs" "$side/migrateHooks.mjs" "$side/briefingText.mjs" "$side/model.js" "$side/models.js" \
    </dev/null 2>/dev/null || fail "$TGZ lacks $side's updater files: nothing was installed."
  # retired.js: models.js imports it since #224; layoutSafe.mjs: update.mjs and migrateHome.mjs
  # import it since #431's PR A (and update.mjs pack-out, --uninstall's removals, runs through it).
  # An older release (--version) neither has nor needs them; one whose update.mjs imports
  # layoutSafe.mjs must carry it.
  tar -xzf "$TMP/$TGZ" -C "$TMP/x" "$side/retired.js" </dev/null >/dev/null 2>&1 || :
  tar -xzf "$TMP/$TGZ" -C "$TMP/x" "$side/hermesPair.js" </dev/null >/dev/null 2>&1 || :
  tar -xzf "$TMP/$TGZ" -C "$TMP/x" "$side/layoutSafe.mjs" </dev/null >/dev/null 2>&1 || :
  # #805: the restore notifier reads the shared attach ledger through attach.js.
  # Old releases do not import it and may omit it.
  tar -xzf "$TMP/$TGZ" -C "$TMP/x" "$side/attach.js" </dev/null >/dev/null 2>&1 || :
  for f in update.mjs release.js migrate.js migrateHome.mjs migrateHooks.mjs briefingText.mjs model.js models.js retired.js hermesPair.js layoutSafe.mjs attach.js; do
    case $f in
      hermesPair.js) [ ! -e "$TMP/x/$side/$f" ] && [ ! -L "$TMP/x/$side/$f" ] \
        && ! grep -q '/hermesPair\.js"' "$TMP/x/$side/model.js" && continue ;;
      retired.js) [ ! -e "$TMP/x/$side/$f" ] && [ ! -L "$TMP/x/$side/$f" ] && continue ;;
      attach.js) [ ! -e "$TMP/x/$side/$f" ] && [ ! -L "$TMP/x/$side/$f" ] \
        && ! grep -q '/attach\.js"' "$TMP/x/$side/update.mjs" && continue ;;
      layoutSafe.mjs) [ ! -e "$TMP/x/$side/$f" ] && [ ! -L "$TMP/x/$side/$f" ] \
        && ! grep -q '/layoutSafe\.mjs"' "$TMP/x/$side/update.mjs" && continue ;;
    esac
    { [ -f "$TMP/x/$side/$f" ] && [ ! -L "$TMP/x/$side/$f" ]; } || fail "$TGZ: $side/$f is not a plain file: nothing was installed."
  done
  rc=0
  changed=yes
  if [ "$same" = yes ]; then
    out=$(node "$TMP/x/$side/update.mjs" repair --from "$TMP/$TGZ" --version "$VERSION" --mods "$MODS" </dev/null 2>"$TMP/log") || rc=$?
    if [ "$rc" = 2 ]; then
      # A release whose updater has no `repair` command (cut before #44): it is installed again.
      say "This release's updater cannot check the installed files; installing $VERSION again."
      same=no
      rc=0
    elif [ "$rc" != 0 ] && [ "$rc" != 3 ] && [ "$rc" != 4 ]; then
      why=$(printf '%s' "$out" | sed -n 's/.*"error":"\(.*\)"}.*/\1/p' | head -n 1)
      fail "the installed pack $VERSION was left as it is (not checked or repaired): ${why:-$out $(cat "$TMP/log")}"
    else
      sed -e '/^notice: /d' -e 's/^/  /' "$TMP/log"
      sed -n 's/^notice: //p' "$TMP/log" >"$TMP/notice"
      case $out in *'"changed":false'*) changed=no ;; esac
      if [ "$changed" = yes ]; then say "Repaired the pack $VERSION in $MODS: what differed from the release is listed above."; fi
    fi
  fi
  if [ "$same" = no ]; then
    set -- install --from "$TMP/$TGZ" --version "$VERSION" --mods "$MODS" --setup
    # The pointer's sequence goes into the marker (a --version install records none).
    if [ -n "$SEQUENCE" ]; then set -- "$@" --sequence "$SEQUENCE"; fi
    if [ "$ADOPT" = 1 ]; then set -- "$@" --adopt; fi
    out=$(node "$TMP/x/$side/update.mjs" "$@" </dev/null 2>"$TMP/log") || rc=$?
    if [ "$rc" != 0 ] && [ "$rc" != 3 ] && [ "$rc" != 4 ]; then
      why=$(printf '%s' "$out" | sed -n 's/.*"error":"\(.*\)"}.*/\1/p' | head -n 1)
      fail "nothing was installed: ${why:-$out $(cat "$TMP/log")}"
    fi
    sed -e '/^notice: /d' -e 's/^/  /' "$TMP/log"
    # The briefing hooks' notice (update.mjs): kept for the end of the run, where it is read.
    sed -n 's/^notice: //p' "$TMP/log" >"$TMP/notice"
    say "Installed the pack $VERSION in $MODS: $(mods_said)."
    if [ -f "$STATE/.prev/.pack" ] && [ "$installed" != none ]; then
      say "The folders it replaced ($installed) are kept in $STATE/.prev: 'automagik-herdr update --rollback' swaps them back."
    fi
  fi
  meter_step
  sched_step || :
  offer_switch
  layout_notes

  # ---- e. the command ----
  mkdir -p "$BIN_DIR"
  target=$(cli_target)
  # Never a link to nothing: a pack whose sidebar ships no command stops here, and our link, if
  # it now points at nothing (into the replaced folder), goes rather than dangle.
  if [ -n "$target" ] && { [ ! -f "$target" ] || [ -L "$target" ]; }; then
    gone=
    if link_ours && [ ! -e "$LINK" ]; then rm -f "$LINK" && gone=" Removed $LINK, which pointed at nothing now."; fi
    if link_ours "$AM_LINK" && [ ! -e "$AM_LINK" ]; then rm -f "$AM_LINK"; fi
    fail "the pack is installed, but ${target%/*} has neither automagik-herdr nor automagik-herdr.mjs, so automagik-herdr is not linked.$gone"
  fi
  if [ -n "$target" ]; then chmod +x "$target"; fi
  if [ -n "$target" ] && [ "$(readlink "$LINK" 2>/dev/null || true)" = "$target" ]; then
    :
  elif [ -z "$target" ]; then
    say "Left $LINK as it is: $PACK is not this installer's (--adopt replaces it)."
  elif [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    say "Left $LINK alone: it is a file, not a link. Remove it and run this again to link automagik-herdr."
  elif [ -L "$LINK" ] && ! link_ours; then
    say "Left $LINK alone: it points at $(readlink "$LINK"), not this install. Remove it and run this again to link automagik-herdr."
  else
    ln -sfn "$target" "$LINK"
    say "Linked $LINK."
    changed=yes
  fi
  # am, the same command under its own name: the same wrapper, replaced or removed on the same
  # ownership rule as the old link (a file or another link there is the person's and stays).
  if [ -n "$target" ] && [ "$(readlink "$AM_LINK" 2>/dev/null || true)" != "$target" ]; then
    if [ -e "$AM_LINK" ] && [ ! -L "$AM_LINK" ]; then
      say "Left $AM_LINK alone: it is a file, not a link. Remove it and run this again to link am."
    elif am_link_is_am; then
      :
    elif [ -L "$AM_LINK" ] && ! link_ours "$AM_LINK"; then
      say "Left $AM_LINK alone: it points at $(readlink "$AM_LINK"), not this install. Remove it and run this again to link am."
    else
      ln -sfn "$target" "$AM_LINK"
      say "Linked $AM_LINK."
      changed=yes
    fi
  fi
  fleet_step
  case ":${PATH}:" in
    *":$BIN_DIR:"*) ;;
    *) say "Add ~/.local/bin to your PATH: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
  esac
  dsh_tui_step
  revive_step

  # ---- f. next ----
  # The hooks notice after everything else the run printed and before its last lines, so it is read.
  held_notice
  # A failed check or an unfinished step is never "Done" nor "up to date".
  if [ "$rc" = 4 ]; then switch_hint; fail "the pack is installed, but a step after it did not finish (the warning above says what, and where the folders are)."; fi
  if [ "$rc" = 3 ] && [ "$same" = yes ]; then
    switch_hint
    fail "herdr-app check failed for a mod (above): its output says what to fix. The files match release $VERSION."
  fi
  if [ "$rc" = 3 ]; then switch_hint; fail "herdr-app check failed for a mod (above); the pack is installed, and 'automagik-herdr update --rollback' swaps the kept set back."; fi
  if [ "$same" = yes ] && [ "$changed" = no ]; then
    case $out in
      *'"checked":true'*) verified="every file matches the release and every mod passed herdr-app check" ;;
      *) verified="every file matches the release; herdr-app not found, so no mod was checked" ;;
    esac
    say "Automagik Herdr $VERSION is already up to date ($MODS, $LINK): $verified."
    switch_hint
    return 0
  fi
  say "Done: Automagik Herdr $VERSION. Open Herdr (or reload its mods), or in a project folder run:"
  say "  automagik-herdr create --kind=main --name=<name> --agent=claude && automagik-herdr start <name>"
  switch_hint
}

main "$@"
