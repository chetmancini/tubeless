#!/usr/bin/env bash
set -euo pipefail

tag="${1:?release tag is required}"
commit="$(git rev-parse --verify HEAD)"
if ! tag_commit="$(git rev-parse --verify "refs/tags/${tag}^{commit}" 2>/dev/null)"; then
	echo "Release tag ${tag} does not exist" >&2
	exit 1
fi
if [[ "${tag_commit}" != "${commit}" ]]; then
	echo "Release tag ${tag} points to ${tag_commit}, which does not match HEAD ${commit}; rerun the original release workflow" >&2
	exit 1
fi

printf '%s\n' "${commit}"
