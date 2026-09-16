#!/usr/bin/env bash
set -euo pipefail

candidate="${1:?candidate version is required}"
latest="${2:?latest version is required}"
mode="${3:-newer}"

if [[ "${mode}" != "newer" && "${mode}" != "newer-or-equal" ]]; then
	echo "unknown release version comparison mode: ${mode}" >&2
	exit 1
fi

bun -e '
const [candidate, latest, mode] = Bun.argv.slice(1);
let order;
try {
  order = Bun.semver.order(candidate, latest);
} catch {
  console.error(`invalid semantic version: ${candidate} or ${latest}`);
  process.exit(1);
}
if (order < 0 || (order === 0 && mode === "newer")) {
  const requirement = mode === "newer" ? "newer than" : "at least";
  console.error(`refusing version ${candidate}; it must be ${requirement} latest release ${latest}`);
  process.exit(1);
}
' "${candidate}" "${latest}" "${mode}"
