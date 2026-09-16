#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "${root}"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "working tree is dirty; commit or stash first" >&2
	exit 1
fi
if [[ "$(git branch --show-current)" != "main" ]]; then
	echo "cut releases from main" >&2
	exit 1
fi

git fetch origin main --tags
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
	echo "HEAD is not origin/main; push or pull, then retry" >&2
	exit 1
fi
if [[ -n "${BUMP:-}" && -n "${VERSION:-}" ]]; then
	echo "use BUMP or VERSION, not both" >&2
	exit 1
fi

requested="${VERSION:-${BUMP:-patch}}"
args=("${requested}" --no-git-tag-version --ignore-scripts)
if [[ "${requested}" == "prerelease" ]]; then
	args+=(--preid rc)
fi
npm version "${args[@]}" >/dev/null

version="$(node -p 'require("./package.json").version')"
tag="v${version}"
if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
	echo "local tag ${tag} already exists" >&2
	exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
	echo "origin already has ${tag}" >&2
	exit 1
fi

make check
git add package.json
git commit -m "Bump version to ${version}."
git tag -a "${tag}" -m "tubeless ${version}"
git push origin main "${tag}"
