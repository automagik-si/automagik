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
#   RELEASE_CUT_POINTER_WAIT  seconds to wait for the Pocket and meter posts across all attempts, default 300
#   RELEASE_CUT_POINTER_POLL  seconds between pointer reads, default 15
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
# Allow five minutes beyond the build, attach and post jobs' timeouts.
pocket_post_window=2700
meter_post_window=3300
scratch=$(mktemp -d)
trap 'rm -rf "${scratch}"' EXIT

has_wait_time() {
  local end="$1" now
  [[ "${rate_limited}" == no ]] && now=$(date +%s) && (( end - now >= 26 ))
}

read_release() {
  local end="$1"
  shift
  if [[ -n "${end}" ]]; then has_wait_time "${end}" || return 1; fi
  if gh_response=$(timeout --kill-after=5s 20s gh "$@" 2>"${scratch}/gh-error"); then
    return 0
  fi
  if grep -Eiq 'rate limit|HTTP (403|429)' "${scratch}/gh-error"; then
    rate_limited=yes
  fi
  return 1
}

read_lane_pointer() {
  local part="$1" asset="$2" field="$3" end="${4:-}"
  local version_pattern='^"3\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})"$'
  read_release "${end}" release download "${part}-lane" --repo "${GITHUB_REPOSITORY}" -p "${asset}" -O - || return 1
  # Keep the JSON quotes so command substitution cannot strip newlines from the version.
  pointer_version=$(jq -cse --arg field "${field}" --arg part "${part}" --arg repo "${GITHUB_REPOSITORY}" '
    select(length == 1) | .[0] | .[$field] as $version |
    if $part == "pocket" then
      select($version | test("^3\\.(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})\\z")) |
      ($version | split(".") | map(tonumber)) as [$major, $minor, $patch] |
      select(.versionCode == ($major * 1000000 + $minor * 1000 + $patch) and
        .url == "https://github.com/\($repo)/releases/download/v\($version)/automagik-pocket-\($version).apk" and
        (.sha256 | test("^[0-9a-f]{64}\\z")))
    else . end | $version' <<< "${gh_response}" 2>/dev/null) || return 1
  [[ "${pointer_version}" =~ ${version_pattern} ]]
}

read_part_pointer() {
  case "$1" in
    meter) read_lane_pointer meter meter.json version "${2:-}" ;;
    pocket) read_lane_pointer pocket latest.json versionName "${2:-}" ;;
  esac
}

read_meter_pair() {
  local end="${1:-}" dir version status=1
  dir=$(mktemp -d "${scratch}/meter.XXXXXX") || return 1
  if read_release "${end}" release download meter-lane --repo "${GITHUB_REPOSITORY}" \
      -p meter.json -p meter.json.sig -D "${dir}" &&
    bun scripts/meter-lane.ts verify "${dir}/meter.json" "${dir}/meter.json.sig" >/dev/null 2>&1 &&
    version=$(jq -er '.version | select(test("^3\\.[0-9]+\\.[0-9]+\\z"))' "${dir}/meter.json" 2>/dev/null); then
    pair_tag="v${version}"
    status=0
  fi
  rm -rf "${dir}"
  return "${status}"
}

tag_after() {
  [[ "$1" != "$2" && "$(printf '%s\n' "$1" "$2" | LC_ALL=C sort -V | tail -n 1)" == "$1" ]]
}

after_baseline() {
  [[ -z "$2" ]] || { [[ "$2" =~ ${baseline_pattern} ]] && tag_after "$1" "$2"; }
}

# A pointer must name a local tag and a published stable release whose build covers this checkout.
coverage_checks() {
  local part="$1" since="$2" tag="$3" end="${4:-}" ships
  after_baseline "${tag}" "${since}" || return 1
  git rev-parse --verify --quiet "refs/tags/${tag}^{commit}" >/dev/null || return 1
  read_release "${end}" api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" || return 1
  jq -se --arg tag "${tag}" 'length == 1 and (.[0] |
    .tag_name == $tag and .draft == false and .prerelease == false and
    (.published_at | fromdateiso8601 | type == "number"))' <<< "${gh_response}" >/dev/null 2>&1 || return 1
  ships=$(bun scripts/lane.ts "${part}" "${tag}") && [[ "${ships}" == no ]]
}

# Both parts share the same release lookups, including failures.
candidate_view() {
  local tag="$1"
  if [[ ! -v 'views[$tag]' ]]; then
    views[${tag}]=''
    if read_release "${wait_end}" release view "${tag}" --repo "${GITHUB_REPOSITORY}" \
        --json tagName,isDraft,isPrerelease,publishedAt,assets; then
      views[${tag}]=${gh_response}
    fi
  fi
  [[ -n "${views[${tag}]}" ]]
}

candidate_body() {
  local tag="$1" note="$2"
  if [[ ! -v 'bodies[$tag]' ]]; then
    bodies[${tag}]=''
    if read_release "${wait_end}" release view "${tag}" --repo "${GITHUB_REPOSITORY}" --json body; then
      bodies[${tag}]=${gh_response}
    fi
  fi
  [[ -n "${bodies[${tag}]}" ]] &&
    jq -se --arg note "${note}" 'length == 1 and (.[0].body | contains($note))' \
      <<< "${bodies[${tag}]}" >/dev/null 2>&1
}

find_pending_post() {
  local part="$1" old="$2" since="$3" label="$4"
  local tag published window asset manifest note now end reason ships
  case "${part}" in
    meter) window=${meter_post_window}; asset=meter.json; manifest=meter.json.sig ;;
    pocket) window=${pocket_post_window}; manifest=latest.json ;;
  esac
  for tag in "${recent_tags[@]}"; do
    if ! { tag_after "${tag}" "${old}" && after_baseline "${tag}" "${since}"; }; then break; fi
    candidate_view "${tag}" || break
    # A valid draft, prerelease or unpublished release can be passed over. A bad view ends the search.
    published=$(jq -rse --arg tag "${tag}" '
      select(length == 1) | .[0] |
      select(.tagName == $tag and (.isDraft | type == "boolean") and
        (.isPrerelease | type == "boolean") and has("publishedAt") and
        (.assets | type == "array") and all(.assets[]; type == "object")) |
      if .isDraft or .isPrerelease or .publishedAt == null then "unpublished"
      else .publishedAt | fromdateiso8601 end' <<< "${views[${tag}]}" 2>/dev/null) || break
    [[ "${published}" != unpublished ]] || continue
    if [[ "${part}" == pocket ]]; then asset="automagik-pocket-${tag#v}.apk"; fi
    end=${wait_end}
    reason="carries its ${label} build"
    if ! jq -e --arg asset "${asset}" --arg manifest "${manifest}" '
      def uploaded($name): any(.assets[]; .name == $name and .state == "uploaded" and
        (.size | type == "number" and . > 0));
      uploaded($asset) and uploaded($manifest)' <<< "${views[${tag}]}" >/dev/null 2>&1; then
      now=$(date +%s)
      (( now >= published && now - published < window )) || break
      case "${part}" in
        meter) note="usagemeter: \`usagemeter-darwin-arm64\`" ;;
        pocket) note="\`${asset}\` follows" ;;
      esac
      candidate_body "${tag}" "${note}" || break
      if (( published + window < end )); then end=$((published + window)); fi
      reason="is still building its ${label} build"
    fi
    if ! { ships=$(bun scripts/lane.ts "${part}" "${tag}") && [[ "${ships}" == no ]]; }; then break; fi
    candidates[${part}]=${tag}
    post_ends[${part}]=${end}
    post_reasons[${part}]=${reason}
    break
  done
}

poll_delay() {
  local end="$1" now delay
  now=$(date +%s)
  [[ "${rate_limited}" == no ]] && (( end - now >= 26 )) || return 1
  # Leave the read enough time for the timeout and its kill grace.
  delay=$((end - now - 25))
  if (( pointer_poll < delay )); then delay=${pointer_poll}; fi
  sleep "${delay}"
}

poll_pending_posts() {
  local part old tag now next_end end
  local -A started=()
  now=$(date +%s)
  for part in meter pocket; do
    end=${post_ends[${part}]:-0}
    has_wait_time "${end}" || continue
    started[${part}]=${now}
    echo "::notice::${candidates[${part}]} ${post_reasons[${part}]} but ${part}-lane still names ${observed[${part}]};" \
      "waiting up to $((end - now))s for its post"
  done

  while [[ "${rate_limited}" == no ]]; do
    now=$(date +%s)
    next_end=0
    for part in meter pocket; do
      end=${post_ends[${part}]:-0}
      if ! { [[ -v 'started[$part]' ]] && (( end - now >= 26 )); }; then continue; fi
      if (( next_end == 0 || end < next_end )); then next_end=${end}; fi
    done
    if ! { (( next_end > 0 )) && poll_delay "${next_end}"; }; then break; fi

    for part in meter pocket; do
      end=${post_ends[${part}]:-0}
      if ! { [[ -v 'started[$part]' ]] && has_wait_time "${end}"; }; then continue; fi
      polled[${part}]=yes
      if [[ "${part}" == meter ]]; then
        read_meter_pair "${end}" || continue
        tag=${pair_tag}
      else
        read_part_pointer pocket "${end}" || continue
        tag="v${pointer_version:1:-1}"
      fi
      old=${observed[${part}]}
      tag_after "${tag}" "${old}" || continue
      observed[${part}]=${tag}
      if ! tag_after "${candidates[${part}]}" "${tag}" ||
        coverage_checks "${part}" "${baselines[${part}]}" "${tag}" "${end}"; then
        echo "::notice::${part}-lane now names ${tag}"
        post_ends[${part}]=0
      fi
    done
  done

  now=$(date +%s)
  for part in meter pocket; do
    [[ -v 'started[$part]' && "${observed[${part}]}" == "${old_tags[${part}]}" ]] || continue
    echo "::notice::${part}-lane still names ${old_tags[${part}]} after $((now - started[$part]))s;" \
      "keeping the ${labels[${part}]} build"
  done
}

account_wait() {
  local elapsed=$(( $(date +%s) - $1 ))
  pointer_wait=$((pointer_wait - elapsed))
  pointer_wait_elapsed=$((pointer_wait_elapsed + elapsed))
}

retry_meter_pair() {
  local since="$1" tag="$2" status=1 started
  has_wait_time "${wait_end}" || return 1
  started=$(date +%s)
  while poll_delay "${wait_end}"; do
    if read_meter_pair "${wait_end}"; then
      if [[ "${pair_tag}" == "${tag}" ]] || coverage_checks meter "${since}" "${pair_tag}" "${wait_end}"; then
        status=0
      fi
      break
    fi
  done
  account_wait "${started}"
  return "${status}"
}

build_is_covered() {
  local part="$1" since="$2" tag="$3" started status
  coverage_checks "${part}" "${since}" "${tag}" || return 1
  if (( pointer_wait_elapsed > 0 )) && [[ ! -v 'polled[$part]' ]]; then
    # Check again before skipping a build whose pointer was read before the wait.
    started=$(date +%s)
    status=1
    if read_part_pointer "${part}" "${wait_end}"; then
      tag="v${pointer_version:1:-1}"
      if coverage_checks "${part}" "${since}" "${tag}" "${wait_end}"; then status=0; fi
    fi
    account_wait "${started}"
    (( status == 0 )) || return 1
  fi
  if [[ "${part}" == meter ]]; then
    # The verified pair can come from a newer post than the observation that led us here.
    if read_meter_pair; then
      [[ "${pair_tag}" == "${tag}" ]] || coverage_checks meter "${since}" "${pair_tag}" || return 1
    else
      retry_meter_pair "${since}" "${tag}" || return 1
    fi
    tag=${pair_tag}
  fi
  echo "::notice::${part}-lane advanced to ${tag} and covers this checkout; skipping the ${part} build for this attempt"
}

# A post can outlast the wait. A stable tag without build evidence can hide an older post, and
# more than three intervening drafts or prereleases exhaust discovery. A stale meter that did
# not trigger a wait can still post while Pocket is polling.
recheck_builds() {
  local part remaining cap wait_end=0 started rate_limited=no
  local gh_response pointer_version pair_tag
  local -a recent_tags
  local -A old_tags=() observed=() views=() bodies=() polled=()
  local -A candidates=() post_ends=() post_reasons=()
  local -A labels=([meter]=meter [pocket]=Pocket)
  local -A baselines=([meter]="${meter_since}" [pocket]="${pocket_since}")
  [[ -n "${GITHUB_REPOSITORY:-}" ]] || return 0
  for part in meter pocket; do
    if ! { [[ "${!part}" == yes ]] && read_part_pointer "${part}" && [[ "${KIND}" != "${part}" ]]; }; then
      continue
    fi
    observed[${part}]="v${pointer_version:1:-1}"
    old_tags[${part}]=${observed[${part}]}
  done

  started=$(date +%s)
  cap=${pointer_wait}
  if [[ -n "${deadline}" ]]; then
    # Leave time for the rest of this attempt, a retry of the same length and the pushes.
    remaining=$((deadline - started - 2 * (started - attempt_started) - 120))
    if (( remaining < cap )); then cap=${remaining}; fi
  fi
  if [[ "${PRERELEASE:-}" != true && "${rate_limited}" == no ]] &&
    (( ${#observed[@]} > 0 && cap >= pointer_poll && cap >= 26 )); then
    wait_end=$((started + cap))
    mapfile -t recent_tags < <(git tag --list 'v3.*' --sort=-v:refname |
      grep -E "${baseline_pattern}" | sed -n '1,3p')
    for part in meter pocket; do
      [[ -v 'observed[$part]' ]] || continue
      find_pending_post "${part}" "${observed[${part}]}" "${baselines[${part}]}" "${labels[${part}]}"
    done
    poll_pending_posts
    account_wait "${started}"
  fi

  for part in meter pocket; do
    [[ "${rate_limited}" == no && -v 'observed[$part]' ]] || continue
    if build_is_covered "${part}" "${baselines[${part}]}" "${observed[${part}]}"; then
      printf -v "${part}" '%s' no
    fi
  done
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
  recheck_builds

  version=$(next_version)
  bun scripts/version.ts set "${version}"
  bun scripts/version.ts check
  if [[ "${KIND}" == full || "${KIND}" == plugins ]]; then
    bun scripts/lane.ts stamp-bundled-solver "${version}"
  fi
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
