#!/usr/bin/env bash
# Cut a release on dev, and when a merge lands while the gates run, re-cut on the new tip instead of
# stepping aside (#668).
#
# The cut computes the version, runs the gates, commits `chore(release): v<version>` and tags it, and
# pushes dev and the tag atomically. A rejected push means a merge changed dev after the gates began;
# rather than leaving the release to a queue that can lose the same race again, this fetches the new
# dev, re-decides the lane, re-runs the gates on the new tip and retries, up to
# RELEASE_CUT_ATTEMPTS whole attempts (default 3). A retried cut tags a tree the release gates saw.
#
# A merge can also change the lane (a herdr or Pocket change during a plugins cut, say). This run
# gated and would publish the old lane, so a re-decided lane that differs steps aside as before: the
# queued run for that merge builds the part this one did not. The notice says so either way, and
# after the bounded attempts -- a dev that keeps moving -- the run steps aside cleanly with the last
# attempt's version and no tag.
#
# Environment (the lane's decision): KIND, HERDR, POCKET, METER, GITHUB_OUTPUT.
#   RELEASE_CUT_ATTEMPTS  whole attempts, default 3 (1 turns the retry off)
#   RELEASE_CUT_STARTED   first attempt's start in epoch seconds, default script start
#   RELEASE_CUT_DEADLINE  optional retry deadline in epoch seconds
#   RELEASE_GATES         the gates command, default "bash scripts/release-gates.sh" (a test's own)
set -euo pipefail

attempt_started=${RELEASE_CUT_STARTED-$(date +%s)}
if [[ ! "${attempt_started}" =~ ^[0-9]+$ ]]; then
  echo "::error::RELEASE_CUT_STARTED must be an epoch timestamp in seconds" >&2
  exit 1
fi
attempt_started=$((10#${attempt_started}))

deadline=''
if [[ -v RELEASE_CUT_DEADLINE ]]; then
  if [[ ! "${RELEASE_CUT_DEADLINE}" =~ ^[0-9]+$ ]]; then
    echo "::error::RELEASE_CUT_DEADLINE must be an epoch timestamp in seconds" >&2
    exit 1
  fi
  deadline=$((10#${RELEASE_CUT_DEADLINE}))
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "${root}"

: "${KIND:?the lane kind}" "${HERDR:?}" "${POCKET:?}" "${METER:?}" "${GITHUB_OUTPUT:?}"

attempts="${RELEASE_CUT_ATTEMPTS:-3}"
read -r -a gates_cmd <<< "${RELEASE_GATES:-bash scripts/release-gates.sh}"

# The version this run cuts, from the tags as they are now. A retry deletes the tag its last attempt
# made (the push that would have sent it was refused), so the same version is computed again.
next_version() {
  # A plugin, herdr, Pocket, am or meter patch is 3.N.P; only a full release is 3.N.0.
  case " ${KIND} " in
    " plugins " | " herdr " | " pocket " | " am " | " meter ") bun scripts/lane.ts next-patch ;;
    *) bun scripts/version.ts next ;;
  esac
}

lane_value() {
  sed -n "s/^$1=//p" "$2" | head -1
}

version=''
longest_duration=0
for (( attempt = 1; attempt <= attempts; attempt++ )); do
  if (( attempt > 1 )); then
    attempt_started=$(date +%s)
    if [[ -n "${deadline}" ]] && (( attempt_started + longest_duration > deadline )); then
      remaining=$((deadline - attempt_started))
      echo "::notice::Skipping retry for v${version}: attempt $((attempt - 1)) of ${attempts} took ${attempt_duration}s, with ${remaining}s left in the release cut budget (longest attempt: ${longest_duration}s)" >&2
      exit 0
    fi

    # The last attempt's commit and tag are local only. Drop both before the new tip's decision, or
    # its tag would count as a release and skew the version and the lane.
    git tag -d "v${version}" >/dev/null 2>&1 || true
    git reset -q --hard origin/dev
    previous="${version}"
    version=''
    lane_file=$(mktemp)
    "${gates_cmd[@]}" lane "${lane_file}" >/dev/null
    if [[ "$(lane_value ships "${lane_file}")" != yes ]]; then
      rm -f "${lane_file}"
      echo "::notice::dev moved on while this run cut v${previous} and the new dev has nothing that reaches an install, so the run for the newer merge releases nothing"
      exit 0
    fi
    if [[ "$(lane_value kind "${lane_file}")" != "${KIND}" ||
      "$(lane_value herdr "${lane_file}")" != "${HERDR}" ||
      "$(lane_value pocket "${lane_file}")" != "${POCKET}" ||
      "$(lane_value meter "${lane_file}")" != "${METER}" ]]; then
      rm -f "${lane_file}"
      echo "::notice::dev moved on while this run cut v${previous} and changed the lane, so the run for the newer merge releases these changes too"
      exit 0
    fi
    rm -f "${lane_file}"
    echo "::notice::dev moved on while this run cut v${previous}; re-cutting on the new tip (attempt ${attempt} of ${attempts})"
    # The new tip's tree, on which this attempt's tag will name the release commit. The signing-key
    # gates run again here because they read the tree; their `sign=` goes to a scratch file, since
    # the job outputs that decide the pointer jobs were set by the key-check steps before the cut.
    (
      recheck_output=$(mktemp)
      trap 'rm -f "${recheck_output}"' EXIT
      GITHUB_OUTPUT="${recheck_output}" "${gates_cmd[@]}" all "${KIND}" "${HERDR}" "${POCKET}" "${METER}"
    )
  fi

  version=$(next_version)
  bun scripts/version.ts set "${version}"
  bun scripts/version.ts check
  # The crate's lock must still match its Cargo.toml, or the tag's --locked builds fail.
  if [[ "${METER}" == "yes" ]]; then cargo metadata --locked --format-version 1 --manifest-path meter/usagemeter/Cargo.toml > /dev/null; fi
  # The herdr pack's marketplace index rides the release commit, regenerated from this tree.
  if [[ "${HERDR}" == "yes" ]]; then (cd herdr && node scripts/catalog.mjs); fi
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git commit -qam "chore(release): v${version}"
  git tag -a "v${version}" -m "Automagik ${version%.0}"
  # Atomic: when dev moved meanwhile (a second merge), neither lands, so no tag names a release
  # commit dev never got (v3.5.0 did, on 2026-10-25). That is the race this retries; after the
  # bounded attempts the newer merge's own queued run releases these changes with it.
  push_result=accepted
  if ! git push -q --atomic origin HEAD:refs/heads/dev "refs/tags/v${version}"; then
    push_result=rejected
  fi
  attempt_duration=$(( $(date +%s) - attempt_started ))
  echo "::notice::Cut v${version} attempt ${attempt} of ${attempts}: push ${push_result} after ${attempt_duration}s" >&2
  if [[ "${push_result}" == accepted ]]; then
    echo "version=${version}" >> "${GITHUB_OUTPUT}"
    echo "sha=$(git rev-parse HEAD)" >> "${GITHUB_OUTPUT}"
    exit 0
  fi
  if (( attempt_duration > longest_duration )); then
    longest_duration=${attempt_duration}
  fi
  git fetch -q origin dev
  if [[ "$(git rev-parse origin/dev)" == "$(git rev-parse HEAD~1)" ]]; then
    # dev is where this attempt started: the push failed for a reason other than the race.
    exit 1
  fi
done

echo "::notice::dev moved on while this run cut v${version} on each of ${attempts} attempts; the run for the newer merge releases these changes too"
