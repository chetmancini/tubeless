#!/usr/bin/env bash
# Create or update the GitHub Release for an annotated version tag.
# Prepends the tag annotation, then GitHub's generated notes.
set -euo pipefail

tag="${1:-${GITHUB_REF_NAME:?tag is required}}"
version="$(node -p 'require("./package.json").version')"
if [[ "${tag}" != "v${version}" ]]; then
	echo "tag ${tag} does not match package.json version ${version}" >&2
	exit 1
fi

repo="${GITHUB_REPOSITORY:-}"
if [[ -z "${repo}" ]]; then
	repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi

subject="$(git tag -l --format='%(contents:subject)' "${tag}")"
body="$(git tag -l --format='%(contents:body)' "${tag}")"
notes="$(mktemp)"
trap 'rm -f "${notes}"' EXIT

{
	if [[ -n "${subject}" ]]; then
		printf '%s\n' "${subject}"
		if [[ -n "${body}" ]]; then
			printf '\n%s\n' "${body}"
		fi
		printf '\n'
	fi
	generated="$(gh api "repos/${repo}/releases/generate-notes" \
		-f tag_name="${tag}" --jq .body)"
	if [[ -n "${generated}" ]]; then
		printf '%s\n' "${generated}"
	fi
} >"${notes}"

if gh release view "${tag}" >/dev/null 2>&1; then
	edit_args=(--title "${tag}" --notes-file "${notes}")
	if [[ "${version}" == *-* ]]; then
		edit_args+=(--prerelease)
	fi
	gh release edit "${tag}" "${edit_args[@]}"
else
	create_args=(--title "${tag}" --notes-file "${notes}" --verify-tag)
	if [[ "${version}" == *-* ]]; then
		create_args+=(--prerelease --latest=false)
	fi
	gh release create "${tag}" "${create_args[@]}"
fi
