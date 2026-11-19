#!/usr/bin/env bash
# The release cut's pre-flight gates, in one place: .github/workflows/release.yml runs them from its
# own steps before the cut, and a cut that lost its push to a merge re-runs them on the new tip
# before it re-cuts (#668).
#
#   scripts/release-gates.sh base            the repository's checks and the plugins' client bundles
#   scripts/release-gates.sh herdr           the pack's tests, syntax checks, shellcheck and indexes
#   scripts/release-gates.sh herdr-imports   every shipped mod's static import graph
#   scripts/release-gates.sh herdr-app       every shipped mod loads in the pinned herdr-app
#   scripts/release-gates.sh herdr-key       HERDR_PACK_SIGNER selects a key pack-keys.json lists
#   scripts/release-gates.sh am              am's tests, syntax check and shellcheck
#   scripts/release-gates.sh am-key          AM_LANE_KEY signs against am/am-keys.json (or warns)
#   scripts/release-gates.sh meter           the meter crate's fmt, clippy and tests
#   scripts/release-gates.sh meter-key       METER_LANE_KEY is a key meter-keys.json lists
#   scripts/release-gates.sh pocket          Pocket's unit tests and lint
#   scripts/release-gates.sh pocket-key      Pocket's two signing secrets are present
#   scripts/release-gates.sh addons <dir>    the add-ons the lane carries, into <dir>
#   scripts/release-gates.sh lane [<file>]   the "Which lane" decision: key=value into <file>
#                                            (default: $GITHUB_OUTPUT), the human line to stdout
#   scripts/release-gates.sh all <kind> <herdr> <pocket> <meter>
#                                            every gate that lane needs, in the order the workflow
#                                            ran them, the signing-key checks included
#
# Every gate is a function, and `all` calls the same functions the single-gate dispatch does, so a
# case label can never run as a command. The signing-key checks read the tree (the key lists), so a
# re-cut runs them again on the new tip: a key-list change between attempts stops the new tip
# before its tag. Each gate needs what its workflow step sets up (the herdr-app libraries, Rust, the
# Android SDK); the step that runs it is still responsible for that.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "${root}"

# The lane decision: what the commits since the last release are, and which parts this release
# rebuilds. It is the same decision the workflow's "Which lane" step used to make inline (plus
# `ships`, which the re-cut needs), so a lane value cannot mean two things; release-cut.sh re-runs
# it on the new tip after a merge.
lane() {
  local out="${1:-${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}}"
  local full last kind herdr lane_version pocket_since pocket meter_version prerelease_tags meter_since meter ships
  full=$(git tag --list 'v3.*.0' --sort=-v:refname | grep -E '^v3\.(0|[1-9][0-9]{0,3})\.0$' | head -1 || true)
  last=$(git tag --list 'v3.*' --sort=-v:refname | grep -E '^v3\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$' | head -1 || true)
  kind=$(bun scripts/lane.ts kind "${full}" "${last}")
  # The herdr pack is rebuilt when herdr/ shipped something since the last release, any kind.
  herdr=$(bun scripts/lane.ts herdr "${last}")
  # Pocket's app is rebuilt when apps/pocket/ shipped something since the build phones have: the
  # version pocket-lane names (a prerelease never moves it, so a Pocket change in one comes
  # again), or the last release when there is no lane yet (scripts/lane.ts pocket-since).
  lane_version=$(gh release download pocket-lane --repo "${GITHUB_REPOSITORY}" -p latest.json -O - 2>/dev/null | jq -r '.versionName // empty' 2>/dev/null || true)
  pocket_since=$(bun scripts/lane.ts pocket-since "${last}" "${lane_version}")
  pocket=$(bun scripts/lane.ts pocket "${pocket_since}")
  # The meter is built when meter/usagemeter/ shipped something since the build machines have:
  # the version meter-lane names, else the newest stable release (a prerelease never moves the
  # lane and is never the base: its meter is built again by the next stable release), or every
  # change when no release has carried the meter yet (scripts/lane.ts meter-since). It answers
  # no while the lane is held: no key listed, or RFC 0021's contract not in (meterHeld). The
  # prerelease list must be read: an error here stops the run rather than guess a base.
  meter_version=$(gh release download meter-lane --repo "${GITHUB_REPOSITORY}" -p meter.json -O - 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
  prerelease_tags=$(gh release list --repo "${GITHUB_REPOSITORY}" --limit 200 --json tagName,isPrerelease --jq '.[] | select(.isPrerelease) | .tagName')
  mapfile -t prereleases <<< "${prerelease_tags}"
  meter_since=$(bun scripts/lane.ts meter-since "${last}" "${meter_version}" "${prereleases[@]}")
  meter=$(bun scripts/lane.ts meter "${meter_since}")
  # A merge can leave nothing that reaches an install (a revert of everything since the last
  # release): the re-cut then has nothing to cut, and the queued run finds the same.
  ships=$(bun scripts/lane.ts ships "${last}")
  {
    echo "kind=${kind}"
    echo "herdr=${herdr}"
    echo "pocket=${pocket}"
    echo "pocket_since=${pocket_since}"
    echo "meter=${meter}"
    echo "meter_since=${meter_since}"
    echo "ships=${ships}"
    echo "base=${full#v}"
  } >> "${out}"
  echo "since ${full:-the start}: ${kind} release; since ${last:-the start}, the herdr pack: ${herdr}; since ${pocket_since:-the start}, Pocket: ${pocket}; since ${meter_since:-the start}, the meter: ${meter}"
}

# The repository's checks and the plugins' client bundles (release.yml's "The gates the release
# stands on" step).
gate_base() {
  bun install --frozen-lockfile --ignore-scripts
  bun run check
  for app in acp-dsh bots-dsh locale-pt-br-dsh welcome-dsh; do
    (cd "apps/${app}" && bun install --frozen-lockfile --ignore-scripts && { [ ! -f scripts/build-client.mjs ] || node scripts/build-client.mjs --check; })
  done
}

# The pack's tests, syntax checks, shellcheck and indexes (release.yml's "The herdr pack's gates").
gate_herdr() {
  (
    cd herdr
    node --test 'test/*.test.mjs'
    for f in mods/*/*.js mods/*/*.mjs mods/*/bin/*.mjs mods/*/pack/*.mjs scripts/*.mjs scripts/*/*.mjs; do
      node --check "$f"
    done
    sh -n install.sh
    shellcheck -s sh install.sh mods/am-sidebar/bin/run.sh mods/am-sidebar/bin/automagik-herdr
    node scripts/catalog.mjs --check
    node scripts/version.mjs check
    node scripts/entries.mjs --check
    node scripts/parts.mjs --check
  )
}

# Every shipped mod's static import graph (release.yml's "Every pack mod's import graph").
gate_herdr_imports() {
  (cd herdr && node --test test/mod-imports.test.mjs)
}

# Every shipped mod loads in the pinned herdr-app (release.yml's "Every pack mod loads in herdr-app").
gate_herdr_app() {
  node .github/scripts/herdr-app-check.mjs --strict
}

# Validate HERDR_PACK_SIGNER and the selected secret from release.yml against pack-keys.json.
gate_herdr_key() {
  bun scripts/herdr-lane.ts check-key
}

# am's tests, syntax check and shellcheck (release.yml's "The am part's gates").
gate_am() {
  (
    cd am
    node ../scripts/am-copies.mjs --check
    node --test 'test/*.test.mjs'
    for f in *.js *.mjs bin/*.mjs lib/*.mjs; do
      node --check "$f"
    done
    shellcheck -s sh bin/am bin/run.sh bin/automagik-herdr
  )
}

# AM_LANE_KEY against am/am-keys.json (release.yml's "The am lane's signing key"): a listed key
# signs (sign=yes), no listed key or no secret warns and signs nothing (sign=no), and any other key
# fails before the tag.
gate_am_key() {
  bun scripts/am-lane.ts check-key
}

# The meter crate's fmt, clippy and tests (release.yml's "The meter's gates").
gate_meter() {
  (
    cd meter/usagemeter
    toolchain="${RUST_TOOLCHAIN:-1.93.0}"
    rustup toolchain install "${toolchain}" --profile minimal --component rustfmt,clippy
    rustup default "${toolchain}"
    cargo fmt --check
    cargo clippy --all-targets --locked -- -D warnings
    cargo test --locked
  )
}

# METER_LANE_KEY against meter-keys.json (release.yml's "The meter lane's signing key"): a meter
# build is never attached unsigned, so anything but a listed key fails before the tag.
gate_meter_key() {
  bun scripts/meter-lane.ts check-key
}

# Both Pocket flavors' unit tests and lint (release.yml's "Pocket's gates").
gate_pocket() {
  (cd apps/pocket/android && ./gradlew --stacktrace :app:testGithubDebugUnitTest :app:lintGithubDebug \
    :app:testPlayDebugUnitTest :app:lintPlayDebug)
}

# Both Pocket signing secrets must be present (release.yml's "Pocket's signing key is in the
# secrets"): names only, the values are never read here.
gate_pocket_key() {
  if [[ "${HAS_KEYSTORE:-}" != "true" || "${HAS_PASSWORD:-}" != "true" ]]; then
    echo "::error::POCKET_SIGNING_KEYSTORE and POCKET_SIGNING_PASSWORD must be in this repository's secrets: a Pocket release is signed with the release key"
    exit 1
  fi
}

# The add-ons the lane carries, packed into <dir> (release.yml's "Pack the add-ons the lane carries").
gate_addons() {
  bun scripts/lane.ts pack-addons "${1:-release}"
}

# Every gate the lane needs, in the order release.yml ran its steps. A gate's failure ends the run
# with its own message, exactly as its step did; a retry's `all` is the same set of commands, not a
# shortened one.
all() {
  local kind="${1:?the lane kind}"
  local herdr="${2:?herdr yes or no}"
  local pocket="${3:?pocket yes or no}"
  local meter="${4:?meter yes or no}"
  gate_base
  if [[ "${herdr}" == yes ]]; then
    gate_herdr
    gate_herdr_imports
    gate_herdr_app
    gate_herdr_key
  fi
  gate_am
  gate_am_key
  if [[ "${meter}" == yes ]]; then
    gate_meter
    gate_meter_key
  fi
  if [[ "${pocket}" == yes ]]; then
    gate_pocket_key
    gate_pocket
  fi
  case "${kind}" in
    herdr | pocket | am | meter) ;;
    *) gate_addons release ;;
  esac
}

case "${1:-}" in
  base) gate_base ;;
  herdr) gate_herdr ;;
  herdr-imports) gate_herdr_imports ;;
  herdr-app) gate_herdr_app ;;
  herdr-key) gate_herdr_key ;;
  am) gate_am ;;
  am-key) gate_am_key ;;
  meter) gate_meter ;;
  meter-key) gate_meter_key ;;
  pocket) gate_pocket ;;
  pocket-key) gate_pocket_key ;;
  addons) gate_addons "${2:-release}" ;;
  lane) lane "${2:-}" ;;
  all) all "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  *)
    echo "usage: scripts/release-gates.sh base|herdr|herdr-imports|herdr-app|herdr-key|am|am-key|meter|meter-key|pocket|pocket-key|addons|lane|all ..." >&2
    exit 2
    ;;
esac
