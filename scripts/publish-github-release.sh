#!/usr/bin/env bash
# Create or update the GitHub Release for an annotated version tag.
# Uses the tag annotation. If the tag has no message, generates a draft.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "${root}"

tag="${1:-${GITHUB_REF_NAME:?tag is required}}"
version="$(node -p 'require("./package.json").version')"
if [[ "${tag}" != "v${version}" ]]; then
	echo "tag ${tag} does not match package.json version ${version}" >&2
	exit 1
fi

subject="$(git tag -l --format='%(contents:subject)' "${tag}")"
body="$(git tag -l --format='%(contents:body)' "${tag}")"
notes="$(mktemp)"
trap 'rm -f "${notes}"' EXIT

if [[ -n "${subject}" ]]; then
	{
		printf '%s\n' "${subject}"
		if [[ -n "${body}" ]]; then
			printf '\n%s\n' "${body}"
		fi
	} >"${notes}"
else
	bash "${root}/scripts/generate-release-notes.sh" "${tag}" >"${notes}"
fi

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
