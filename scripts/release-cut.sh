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
# Environment (the lane's decision): KIND, HERDR, POCKET, POCKET_SINCE, METER, METER_SINCE.
# GITHUB_OUTPUT receives the version, SHA and effective build flags after a successful push.
#   RELEASE_CUT_ATTEMPTS  whole attempts, default 3 (1 turns the retry off)
#   RELEASE_CUT_STARTED   first attempt's start in epoch seconds, default script start
#   RELEASE_CUT_DEADLINE  optional retry deadline in epoch seconds
#   RELEASE_CUT_POINTER_WAIT  seconds to wait for Pocket across all attempts, default 300
#   RELEASE_CUT_POINTER_POLL  seconds between Pocket reads, default 15
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

pointer_wait=${RELEASE_CUT_POINTER_WAIT-300}
if [[ ! "${pointer_wait}" =~ ^[0-9]+$ ]]; then
  echo "::error::RELEASE_CUT_POINTER_WAIT must be seconds (0 or more)" >&2
  exit 1
fi
pointer_wait=$((10#${pointer_wait}))
pointer_poll=${RELEASE_CUT_POINTER_POLL-15}
if [[ ! "${pointer_poll}" =~ ^[0-9]+$ ]] || (( 10#${pointer_poll} < 1 )); then
  echo "::error::RELEASE_CUT_POINTER_POLL must be seconds (1 or more)" >&2
  exit 1
fi
pointer_poll=$((10#${pointer_poll}))

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

baseline_pattern='^v3\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'
read_lane_pointer() {
  local part="$1" asset="$2" field="$3" quoted
  local version_pattern='^"3\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})"$'
  # Keep the JSON quotes so command substitution cannot strip newlines from the version.
  quoted=$(timeout --kill-after=5s 20s gh release download "${part}-lane" --repo "${GITHUB_REPOSITORY}" -p "${asset}" -O - 2>/dev/null \
    | jq -cse --arg field "${field}" 'select(length == 1) | .[0][$field]' 2>/dev/null) || return 1
  [[ "${quoted}" =~ ${version_pattern} ]] || return 1
  printf '%s\n' "${quoted}"
}

wait_for_pocket_post() {
  local -n observed="$1"
  local since="$2" asset="$3" field="$4"
  local old="v${observed:1:-1}" candidate newest ships
  local started now cap end remaining delay poll_started='' polled tag elapsed
  [[ "${PRERELEASE:-}" != true ]] && (( pointer_wait >= 26 && pointer_wait >= pointer_poll )) || return 0
  candidate=$(git tag --list 'v3.*' --sort=-v:refname \
    | grep -E "${baseline_pattern}" | sed -n '1p') || return 0
  [[ -n "${candidate}" && "${candidate}" != "${old}" ]] || return 0
  if [[ -n "${since}" ]]; then
    [[ "${since}" =~ ${baseline_pattern} && "${candidate}" != "${since}" ]] || return 0
  fi
  newest=$(printf '%s\n' "${old}" "${since}" "${candidate}" | LC_ALL=C sort -V | tail -n 1) || return 0
  [[ "${newest}" == "${candidate}" ]] || return 0

  started=$(date +%s) || return 0
  cap=${pointer_wait}
  if [[ -n "${deadline}" ]]; then
    # Leave time for another attempt of this length and for the push.
    remaining=$((deadline - started - (started - attempt_started) - 60))
    if (( remaining < cap )); then cap=${remaining}; fi
  fi
  (( cap >= pointer_poll && cap >= 26 )) || return 0
  # The lookup and the polls share the same allowance across attempts.
  end=$((started + cap))

  # The APK is attached first. Both uploads have to finish before the post can run.
  if timeout --kill-after=5s 20s gh release view "${candidate}" --repo "${GITHUB_REPOSITORY}" --json tagName,isDraft,isPrerelease,publishedAt,assets 2>/dev/null \
    | jq -se --arg tag "${candidate}" --arg apk "automagik-pocket-${candidate#v}.apk" 'length == 1 and (.[0] |
        .tagName == $tag and .isDraft == false and .isPrerelease == false and .publishedAt != null and
        any(.assets[]; .name == $apk and .state == "uploaded" and (.size | type == "number" and . > 0)) and
        any(.assets[]; .name == "latest.json" and .state == "uploaded" and (.size | type == "number" and . > 0)))' >/dev/null 2>&1 &&
    ships=$(bun scripts/lane.ts pocket "${candidate}") && [[ "${ships}" == no ]]; then
    poll_started=$(date +%s) || return 0
    remaining=$((end - poll_started))
    if (( remaining >= 26 )); then
      echo "::notice::${candidate} carries its Pocket build but pocket-lane still names ${old}; waiting up to ${remaining}s for its post"
      while now=$(date +%s) && (( end - now >= 26 )); do
        # Keep 25 seconds free for the next read, including the timeout's kill grace.
        delay=$((end - now - 25))
        if (( pointer_poll < delay )); then delay=${pointer_poll}; fi
        sleep "${delay}" || break
        now=$(date +%s) || break
        (( end - now >= 26 )) || break
        if polled=$(read_lane_pointer pocket "${asset}" "${field}"); then
          tag="v${polled:1:-1}"
          newest=$(printf '%s\n' "${candidate}" "${tag}" | LC_ALL=C sort -V | tail -n 1) || break
          if [[ "${newest}" == "${tag}" ]]; then
            observed=${polled}
            echo "::notice::pocket-lane now names ${tag}"
            break
          fi
        fi
      done
      if [[ "v${observed:1:-1}" == "${old}" ]]; then
        now=$(date +%s) || now=${poll_started}
        echo "::notice::pocket-lane still names ${old} after $((now - poll_started))s; keeping the Pocket build"
      fi
    fi
  fi

  now=$(date +%s) || return 0
  elapsed=$((now - started))
  pointer_wait=$((pointer_wait - elapsed))
  # Only the polling is left out of the retry estimate: the next attempt repeats the lookup.
  if [[ -n "${poll_started}" ]]; then
    pointer_wait_elapsed=$((pointer_wait_elapsed + now - poll_started))
  fi
  return 0
}

# A pointer can advance while the gates run. Its tag must name a published stable release before
# it can cover the build. Pocket can still race before both assets attach or after the wait ends.
# A newer tag can also hide an older pending post. The meter can still post after its check.
build_is_covered() {
  local part="$1" since="$2" asset="$3" field="$4"
  local quoted_version tag newest ships
  [[ -n "${GITHUB_REPOSITORY:-}" ]] || return 1
  quoted_version=$(read_lane_pointer "${part}" "${asset}" "${field}") || return 1
  [[ "${KIND}" != "${part}" ]] || return 1
  if [[ "${part}" == pocket ]]; then
    wait_for_pocket_post quoted_version "${since}" "${asset}" "${field}"
  fi
  tag="v${quoted_version:1:-1}"
  if [[ -n "${since}" ]]; then
    [[ "${since}" =~ ${baseline_pattern} && "${tag}" != "${since}" ]] || return 1
    newest=$(printf '%s\n' "${since}" "${tag}" | LC_ALL=C sort -V | tail -n 1) || return 1
    [[ "${newest}" == "${tag}" ]] || return 1
  fi
  git rev-parse --verify --quiet "refs/tags/${tag}^{commit}" >/dev/null || return 1
  timeout --kill-after=5s 20s gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" 2>/dev/null \
    | jq -se --arg tag "${tag}" 'length == 1 and (.[0] |
        .tag_name == $tag and .draft == false and .prerelease == false and
        (.published_at | fromdateiso8601 | type == "number"))' >/dev/null 2>&1 || return 1
  ships=$(bun scripts/lane.ts "${part}" "${tag}") || return 1
  [[ "${ships}" == no ]] || return 1
  echo "::notice::${part}-lane advanced to ${tag} and covers this checkout; skipping the ${part} build for this attempt"
}

pocket_since="${POCKET_SINCE-unknown}"
meter_since="${METER_SINCE-unknown}"
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
    pocket_since=$(lane_value pocket_since "${lane_file}")
    meter_since=$(lane_value meter_since "${lane_file}")
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

  # Start each attempt with its gate inputs. A rejected push discards this checkout's decision.
  pocket="${POCKET}"
  meter="${METER}"
  pointer_wait_elapsed=0
  if [[ "${METER}" == yes ]] && build_is_covered meter "${meter_since}" meter.json version; then
    meter=no
  fi
  if [[ "${POCKET}" == yes ]] && build_is_covered pocket "${pocket_since}" latest.json versionName; then
    pocket=no
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
    {
      echo "version=${version}"
      echo "sha=$(git rev-parse HEAD)"
      echo "pocket=${pocket}"
      echo "meter=${meter}"
    } >> "${GITHUB_OUTPUT}"
    exit 0
  fi
  retry_duration=$((attempt_duration - pointer_wait_elapsed))
  if (( retry_duration > longest_duration )); then
    longest_duration=${retry_duration}
  fi
  git fetch -q origin dev
  if [[ "$(git rev-parse origin/dev)" == "$(git rev-parse HEAD~1)" ]]; then
    # dev is where this attempt started: the push failed for a reason other than the race.
    exit 1
  fi
done

echo "::notice::dev moved on while this run cut v${version} on each of ${attempts} attempts; the run for the newer merge releases these changes too"
