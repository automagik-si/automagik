#!/usr/bin/env bash
# A confirmed release, a tag without its release, and a cut superseded by another merge
# are different outcomes even when all verification jobs passed.
set -euo pipefail
repo="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"

successor_run() {
  local workflow="repos/${GITHUB_REPOSITORY}/actions/workflows/release.yml" runs id
  runs=$(gh api "${workflow}/runs?branch=dev&head_sha=$1&per_page=100") || return 1
  id=$(jq -r --arg current "${GITHUB_RUN_ID:?}" '[.workflow_runs[]
    | select((.id | tostring) != $current and (.event == "push" or .event == "workflow_dispatch"))
    | select(.status != "completed" or .conclusion == "success")][0].id // empty' <<< "$runs") || return 1
  if [[ -z "$id" ]]; then
    # A token-pushed market index has no push run. Dispatch on dev so it goes through
    # the ordinary planning and immutable verification again, even if dev moved meanwhile.
    id=$(jq -n --argjson pre "${PRERELEASE:-false}" --argjson desktop "${DESKTOP:-true}" \
      '{ref:"dev",return_run_details:true,inputs:{prerelease:($pre|tostring),desktop:($desktop|tostring)}}' |
      gh api --method POST "${workflow}/dispatches" --input - --jq '.workflow_run_id') || return 1
  fi
  [[ "$id" =~ ^[1-9][0-9]*$ && "$id" != "$GITHUB_RUN_ID" ]] || return 1
  echo "${repo}/actions/runs/${id}"
}

{
  if [[ -n "${SUCCESSOR:-}" ]]; then
    [[ "$SUCCESSOR" =~ ^[0-9a-f]{40}$ ]] || exit 1
    echo "### Superseded before publication"
    if url=$(successor_run "$SUCCESSOR"); then
      echo "[Successor release run](${url}). Dev moved to \`${SUCCESSOR:0:9}\`."
    else
      echo "Could not confirm a successor for \`${SUCCESSOR:0:9}\`. [Retry this handoff](${repo}/actions/runs/${GITHUB_RUN_ID})."
      exit 1
    fi
  elif [[ "${PUBLISHED:-}" == success ]]; then
    echo "### Published [v${VERSION}](${repo}/releases/tag/v${VERSION})"
    case "${FEED:-}" in
      success) echo "[Signed plugin feed](${repo}/releases/download/plugin-lane/lane.json) · [signature](${repo}/releases/download/plugin-lane/lane.json.sig)" ;;
      skipped)
        if [[ "${PLUGINS:-}" == true ]]; then
          echo "The versioned release exists, but its signed plugin feed was not posted."
        else
          echo "This release did not include plugins."
        fi ;;
      *) echo "Plugin feed publication was not confirmed." ;;
    esac
  elif [[ -n "${VERSION:-}" ]]; then
    echo "### Tagged v${VERSION}; publication was not confirmed"
  elif [[ "${RESULT:-}" == success ]]; then
    echo "### No changes to publish"
  else
    echo "### Release did not reach publication (${RESULT:-unknown})"
  fi
} >> "${GITHUB_STEP_SUMMARY:?}"
