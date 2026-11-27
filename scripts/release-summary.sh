#!/usr/bin/env bash
# A confirmed release, a tag without its release, and a cut superseded by another merge
# are different outcomes even when all verification jobs passed.
set -euo pipefail
repo="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"
{
  if [[ -n "${SUCCESSOR:-}" ]]; then
    [[ "$SUCCESSOR" =~ ^[0-9a-f]{40}$ ]] || exit 1
    echo "### Superseded before publication"
    # A newer push can still be waiting for its workflow run to be registered.
    url=$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/release.yml/runs?branch=dev&head_sha=${SUCCESSOR}&per_page=10" \
      --jq '.workflow_runs[0].html_url // empty') || url=''
    if [[ -n "$url" ]]; then
      echo "The [successor release run](${url}) handles dev at \`${SUCCESSOR:0:9}\`."
    else
      echo "Dev moved to \`${SUCCESSOR:0:9}\`. [Find the successor run](${repo}/actions/workflows/release.yml?query=branch%3Adev+${SUCCESSOR})."
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
