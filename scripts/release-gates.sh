#!/usr/bin/env bash
# The release cut's pre-flight gates, in one place: .github/workflows/release.yml runs them from its
# own steps before the cut, and a cut that lost its push to a merge re-runs them on the new tip
# before it re-cuts (#668).
#
#   scripts/release-gates.sh base            the repository's checks and the plugins' client bundles
#   scripts/release-gates.sh herdr           the pack's tests, syntax checks, shellcheck and indexes
#   scripts/release-gates.sh herdr-imports   every shipped mod's static import graph
#   scripts/release-gates.sh herdr-app       every shipped mod loads in the pinned herdr-app
#   scripts/release-gates.sh am              am's tests, syntax check and shellcheck
#   scripts/release-gates.sh meter           the meter crate's fmt, clippy and tests
#   scripts/release-gates.sh pocket          Pocket's unit tests and lint
#   scripts/release-gates.sh addons <dir>    the add-ons the lane carries, into <dir>
#   scripts/release-gates.sh lane [<file>]   the "Which lane" decision: key=value into <file>
#                                            (default: $GITHUB_OUTPUT), the human line to stdout
#   scripts/release-gates.sh all <kind> <herdr> <pocket> <meter>
#                                            every gate that lane needs, as the cut ran them
#
# The lane's signing-key checks are not here: they do not read the tree, so the cut runs them once
# and a re-cut has no reason to repeat them. Each gate needs what its workflow step sets up (the
# herdr-app libraries, Rust, the Android SDK); the step that runs it is still responsible for that.
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
  { echo "kind=${kind}"; echo "herdr=${herdr}"; echo "pocket=${pocket}"; echo "pocket_since=${pocket_since}"; echo "meter=${meter}"; echo "ships=${ships}"; echo "base=${full#v}"; } >> "${out}"
  echo "since ${full:-the start}: ${kind} release; since ${last:-the start}, the herdr pack: ${herdr}; since ${pocket_since:-the start}, Pocket: ${pocket}; since ${meter_since:-the start}, the meter: ${meter}"
}

case "${1:-}" in
  base)
    bun install --frozen-lockfile --ignore-scripts
    bun run check
    for app in acp-dsh bots-dsh locale-pt-br-dsh welcome-dsh; do
      (cd "apps/${app}" && bun install --frozen-lockfile --ignore-scripts && { [ ! -f scripts/build-client.mjs ] || node scripts/build-client.mjs --check; })
    done
    ;;
  herdr)
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
    ;;
  herdr-imports)
    (cd herdr && node --test test/mod-imports.test.mjs)
    ;;
  herdr-app)
    node .github/scripts/herdr-app-check.mjs --strict
    ;;
  am)
    (
      cd am
      node ../scripts/am-copies.mjs --check
      node --test 'test/*.test.mjs'
      for f in *.js *.mjs bin/*.mjs lib/*.mjs; do
        node --check "$f"
      done
      shellcheck -s sh bin/am bin/run.sh bin/automagik-herdr
    )
    ;;
  meter)
    (
      cd meter/usagemeter
      toolchain="${RUST_TOOLCHAIN:-1.93.0}"
      rustup toolchain install "${toolchain}" --profile minimal --component rustfmt,clippy
      rustup default "${toolchain}"
      cargo fmt --check
      cargo clippy --all-targets --locked -- -D warnings
      cargo test --locked
    )
    ;;
  pocket)
    (cd apps/pocket/android && ./gradlew --stacktrace :app:testDebugUnitTest :app:lintDebug)
    ;;
  addons)
    bun scripts/lane.ts pack-addons "${2:-release}"
    ;;
  lane)
    lane "${2:-}"
    ;;
  all)
    kind="${2:?the lane kind}"
    herdr="${3:?herdr yes or no}"
    pocket="${4:?pocket yes or no}"
    meter="${5:?meter yes or no}"
    base
    am
    if [[ "${herdr}" == yes ]]; then
      herdr
      herdr-imports
      herdr-app
    fi
    if [[ "${meter}" == yes ]]; then meter; fi
    if [[ "${pocket}" == yes ]]; then pocket; fi
    case "${kind}" in
      herdr | pocket | am | meter) ;;
      *) addons release ;;
    esac
    ;;
  *)
    echo "usage: scripts/release-gates.sh base|herdr|herdr-imports|herdr-app|am|meter|pocket|addons|lane|all ..." >&2
    exit 2
    ;;
esac
