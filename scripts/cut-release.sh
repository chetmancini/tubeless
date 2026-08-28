#!/usr/bin/env bash
# Cut an annotated version tag matching package.json and push it.
# That tag runs npm publish and opens the GitHub Release.
#
#   make release
#   make release NOTES='Summary
#
#   - Change'
#   make release NOTES_FILE=notes.md
#   make release DRY=1
#   make release PUSH=0 WATCH=0 SKIP_CHECK=1
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "${root}"

version="$(node -p 'require("./package.json").version')"
tag="v${version}"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "working tree is dirty; commit or stash first" >&2
	exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${branch}" != "main" ]]; then
	echo "cut releases from main (on ${branch})" >&2
	exit 1
fi

git fetch origin main --tags

head="$(git rev-parse HEAD)"
remote="$(git rev-parse origin/main)"
if [[ "${head}" != "${remote}" ]]; then
	echo "HEAD is not origin/main. Push or pull, then retry." >&2
	exit 1
fi

if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
	echo "local tag ${tag} already exists" >&2
	exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
	echo "origin already has ${tag}" >&2
	exit 1
fi

echo "release ${tag} at $(git rev-parse --short HEAD)"

if [[ "${DRY:-}" == "1" ]]; then
	echo "dry run: would tag ${tag} and push to origin"
	exit 0
fi

if [[ "${SKIP_CHECK:-}" != "1" ]]; then
	make check
fi

if [[ -n "${NOTES_FILE:-}" ]]; then
	git tag -a "${tag}" -F "${NOTES_FILE}"
elif [[ -n "${NOTES:-}" ]]; then
	git tag -a "${tag}" -m "${NOTES}"
else
	git tag -a "${tag}"
fi

if [[ "${PUSH:-1}" == "0" ]]; then
	echo "created ${tag} locally (PUSH=0). Push with: git push origin ${tag}"
	exit 0
fi

git push origin "${tag}"
echo "pushed ${tag}"
echo "https://github.com/chetmancini/tubeless/releases/tag/${tag}"
echo "https://github.com/chetmancini/tubeless/actions"

if ! command -v gh >/dev/null 2>&1 || [[ "${WATCH:-1}" == "0" ]]; then
	exit 0
fi

wait_for_run() {
	local workflow="$1"
	local id=""
	local i
	for i in $(seq 1 20); do
		id="$(gh run list --workflow "${workflow}" --json databaseId,headBranch,event \
			--jq "[.[] | select(.headBranch==\"${tag}\" and .event==\"push\")] | first | .databaseId // empty")"
		if [[ -n "${id}" && "${id}" != "null" ]]; then
			printf '%s\n' "${id}"
			return 0
		fi
		sleep 2
	done
	echo "timed out waiting for ${workflow} on ${tag}" >&2
	return 1
}

publish_id="$(wait_for_run publish.yml)"
gh run watch "${publish_id}" --exit-status
if release_id="$(wait_for_run github-release.yml)"; then
	gh run watch "${release_id}" --exit-status
else
	echo "npm publish finished; watch the GitHub Release at https://github.com/chetmancini/tubeless/actions" >&2
fi
