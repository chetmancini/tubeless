#!/usr/bin/env bash
# Print a draft changelog for package.json's version (or $1).
# Commits since the latest existing v* tag, plus GitHub's generated notes
# (merged pull requests via .github/release.yml) when the tag is new.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "${root}"

version="$(node -p 'require("./package.json").version')"
tag="${1:-v${version}}"
if [[ "${tag}" != v* ]]; then
	echo "tag ${tag} must start with v" >&2
	exit 1
fi
title_version="${tag#v}"

repo="${GITHUB_REPOSITORY:-}"
if [[ -z "${repo}" ]] && command -v gh >/dev/null 2>&1; then
	repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
fi
if [[ -z "${repo}" ]]; then
	repo="chetmancini/tubeless"
fi

last="$(git tag -l 'v*' --sort=-version:refname | awk '{ print; exit }')"

if [[ -n "${last}" ]]; then
	commits="$(git log --no-merges --pretty=format:'- %s' "${last}..HEAD")"
else
	commits="$(git log --no-merges --pretty=format:'- %s')"
fi

generated=""
if command -v gh >/dev/null 2>&1 && [[ -n "${tag}" && "${tag}" != "${last}" ]]; then
	api_args=(-f tag_name="${tag}" -f target_commitish="$(git rev-parse HEAD)")
	if [[ -n "${last}" ]]; then
		api_args+=(-f previous_tag_name="${last}")
	fi
	generated="$(gh api "repos/${repo}/releases/generate-notes" "${api_args[@]}" --jq .body 2>/dev/null || true)"
fi

if [[ -n "${generated}" ]]; then
	generated="$(printf '%s\n' "${generated}" | grep -v '^<!--' || true)"
	while [[ "${generated}" == $'\n'* ]]; do
		generated="${generated#$'\n'}"
	done
fi

if [[ -z "${generated}" ]]; then
	compare_head="${tag}"
	if [[ "${tag}" == "${last}" ]]; then
		compare_head="HEAD"
	fi
	if [[ -n "${last}" ]]; then
		generated="**Full Changelog**: https://github.com/${repo}/compare/${last}...${compare_head}"
	else
		generated="**Full Changelog**: https://github.com/${repo}/commits/${compare_head}"
	fi
fi

printf 'tubeless %s\n\n' "${title_version}"
if printf '%s\n' "${generated}" | grep -q '^\* '; then
	printf '%s\n' "${generated}"
	if [[ -n "${commits}" ]]; then
		printf '\n## Commits\n\n%s\n' "${commits}"
	fi
else
	if [[ -n "${commits}" ]]; then
		printf '%s\n\n' "${commits}"
	fi
	printf '%s\n' "${generated}"
fi
