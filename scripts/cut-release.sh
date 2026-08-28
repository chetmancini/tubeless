#!/usr/bin/env bash
# Cut an annotated version tag matching package.json and push it.
# Notes start from scripts/generate-release-notes.sh; refine in $EDITOR.
#
#   make release                 # patch (default)
#   make release BUMP=minor
#   make release BUMP=major
#   make release BUMP=prerelease # 0.1.0 → 0.1.1-rc.0; 0.1.1-rc.0 → 0.1.1-rc.1
#   make release VERSION=0.2.0
#   make release EDIT=0
#   make release NOTES='Summary
#
#   - Change'
#   make release NOTES_FILE=notes.md
#   make release DRY=1
#   make release PUSH=0 WATCH=0 SKIP_CHECK=1
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
root="${repo_root}"
if [[ -n "${RELEASE_ROOT:-}" ]]; then
	root="$(cd "${RELEASE_ROOT}" && pwd)"
fi
cd "${root}"

package_version() {
	node -p 'require("./package.json").version'
}

write_package_version() {
	local next="$1"
	node -e '
		const fs = require("fs");
		const version = process.argv[1];
		const path = "package.json";
		const raw = fs.readFileSync(path, "utf8");
		const updated = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
		if (updated === raw) {
			console.error("failed to update package.json version");
			process.exit(1);
		}
		fs.writeFileSync(path, updated);
	' "${next}"
}

current="$(package_version)"
notes_path="$(mktemp)"
trap 'rm -f "${notes_path}"' EXIT

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

last="$(git tag -l 'v*' --sort=-version:refname | awk '{ print; exit }')"
eval "$(node "${repo_root}/scripts/semver-bump.mjs" --from "${last}" --to "${current}" --sh)"

wrote=0
if [[ -n "${VERSION:-}" ]]; then
	if [[ -n "${BUMP:-}" ]]; then
		echo "use VERSION= or BUMP=, not both" >&2
		exit 1
	fi
	version="${VERSION}"
	if [[ "${version}" != "${current}" ]]; then
		wrote=1
	fi
elif [[ "${kind}" == "same" ]]; then
	eval "$(node "${repo_root}/scripts/semver-bump.mjs" --from "${current}" --next "${BUMP:-patch}" --sh)"
	version="${to}"
	wrote=1
elif [[ "${kind}" == "downgrade" || "${kind}" == "invalid" ]]; then
	echo "refusing ${summary}" >&2
	exit 1
else
	# Already a valid committed bump; tag HEAD as-is.
	version="${current}"
	if [[ -n "${BUMP:-}" ]]; then
		matched=0
		if [[ "${BUMP}" == "${kind}" ]]; then
			matched=1
		elif [[ "${BUMP}" == "patch" && "${kind}" == "stable" ]]; then
			matched=1
		fi
		if [[ "${matched}" != "1" ]]; then
			echo "package.json is already ${current} (${kind}); refusing BUMP=${BUMP}" >&2
			exit 1
		fi
		echo "package.json is already ${current} (${kind}); ignoring BUMP=${BUMP}" >&2
	fi
fi

eval "$(node "${repo_root}/scripts/semver-bump.mjs" --from "${last}" --to "${version}" --sh)"
tag="v${version}"
echo "release ${tag} at $(git rev-parse --short HEAD) — ${summary}"
if [[ "${kind}" == "same" || "${kind}" == "downgrade" || "${kind}" == "invalid" ]]; then
	echo "refusing ${summary}" >&2
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

if [[ -n "${NOTES_FILE:-}" ]]; then
	cat "${NOTES_FILE}" >"${notes_path}"
elif [[ -n "${NOTES:-}" ]]; then
	printf '%s\n' "${NOTES}" >"${notes_path}"
else
	bash "${repo_root}/scripts/generate-release-notes.sh" "${tag}" >"${notes_path}"
	if [[ "${EDIT:-1}" == "1" && -t 0 ]]; then
		editor="${VISUAL:-${EDITOR:-vi}}"
		"${editor}" "${notes_path}"
	fi
fi

if ! grep -q '[^[:space:]]' "${notes_path}"; then
	echo "release notes are empty" >&2
	exit 1
fi

echo "--- release notes ---"
cat "${notes_path}"
echo "---"

if [[ "${DRY:-}" == "1" ]]; then
	if [[ "${wrote}" == "1" ]]; then
		echo "dry run: would bump package.json to ${version}, commit, tag ${tag}, and push origin main then ${tag}"
	else
		echo "dry run: would tag ${tag} and push to origin"
	fi
	exit 0
fi

if [[ "${wrote}" == "1" ]]; then
	write_package_version "${version}"
fi

if [[ "${SKIP_CHECK:-}" != "1" ]]; then
	# Release flags stay in this process; make check must not inherit them or
	# scripts/cut-release.test.ts sees both BUMP and VERSION and refuses.
	if ! env -u BUMP -u VERSION -u NOTES -u NOTES_FILE -u DRY -u PUSH -u WATCH \
		-u EDIT -u RELEASE_ROOT -u SKIP_CHECK make check; then
		if [[ "${wrote}" == "1" ]]; then
			echo "check failed after writing ${version}; restore with: git checkout -- package.json" >&2
		fi
		exit 1
	fi
fi

if [[ "${wrote}" == "1" ]]; then
	git add package.json
	git commit -m "Bump version to ${version}."
fi

git tag -a "${tag}" -F "${notes_path}"

if [[ "${PUSH:-1}" == "0" ]]; then
	if [[ "${wrote}" == "1" ]]; then
		echo "created ${tag} locally (PUSH=0). Push with:"
		echo "  git push origin main"
		echo "  git push origin ${tag}"
	else
		echo "created ${tag} locally (PUSH=0). Push with: git push origin ${tag}"
	fi
	exit 0
fi

if [[ "${wrote}" == "1" ]]; then
	git push origin main
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
