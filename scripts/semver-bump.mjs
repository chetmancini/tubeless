#!/usr/bin/env node
// Classify a semver bump between a previous v* tag and a new version.
// Usage: node scripts/semver-bump.mjs --from 0.1.0 --to 0.1.1

function parse(raw) {
  const value = String(raw ?? "")
    .trim()
    .replace(/^v/, "");
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? "",
    version: value,
  };
}

function classify(fromRaw, toRaw) {
  const to = parse(toRaw);
  if (!to) {
    return {
      kind: "invalid",
      title: "invalid",
      summary: `invalid version ${toRaw}`,
      from: fromRaw ? String(fromRaw).replace(/^v/, "") : "",
      to: String(toRaw ?? ""),
    };
  }
  if (!fromRaw) {
    return {
      kind: "initial",
      title: "initial release",
      summary: `initial release (${to.version})`,
      from: "",
      to: to.version,
    };
  }
  const from = parse(fromRaw);
  if (!from) {
    return {
      kind: "invalid",
      title: "invalid",
      summary: `invalid previous tag ${fromRaw}`,
      from: String(fromRaw).replace(/^v/, ""),
      to: to.version,
    };
  }
  if (from.version === to.version) {
    return {
      kind: "same",
      title: "not a bump",
      summary: `same version as last tag v${from.version}`,
      from: from.version,
      to: to.version,
    };
  }

  const coreDelta = to.major - from.major || to.minor - from.minor || to.patch - from.patch;
  if (coreDelta < 0) {
    return {
      kind: "downgrade",
      title: "downgrade",
      summary: `downgrade (${from.version} → ${to.version})`,
      from: from.version,
      to: to.version,
    };
  }

  let coreKind = "";
  if (to.major > from.major) coreKind = "major";
  else if (to.minor > from.minor) coreKind = "minor";
  else if (to.patch > from.patch) coreKind = "patch";

  const zeroMinorNote = from.major === 0 && coreKind === "minor";
  if (to.pre) {
    if (!coreKind && !from.pre) {
      return {
        kind: "downgrade",
        title: "downgrade",
        summary: `downgrade (${from.version} → ${to.version})`,
        from: from.version,
        to: to.version,
      };
    }
    const title = coreKind ? `${coreKind} prerelease` : "prerelease";
    return {
      kind: "prerelease",
      title,
      summary: zeroMinorNote
        ? `${title} (${from.version} → ${to.version}; 0.x minor may include breaking changes)`
        : `${title} (${from.version} → ${to.version})`,
      from: from.version,
      to: to.version,
    };
  }
  if (!coreKind && from.pre) {
    return {
      kind: "stable",
      title: "stable",
      summary: `stable (${from.version} → ${to.version})`,
      from: from.version,
      to: to.version,
    };
  }
  return {
    kind: coreKind || "invalid",
    title: coreKind || "invalid",
    summary: zeroMinorNote
      ? `${coreKind} (${from.version} → ${to.version}; 0.x minor may include breaking changes)`
      : `${coreKind} (${from.version} → ${to.version})`,
    from: from.version,
    to: to.version,
  };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] ?? "";
}

const bump = classify(arg("--from"), arg("--to"));
if (process.argv.includes("--sh")) {
  for (const [key, value] of Object.entries(bump)) {
    process.stdout.write(`${key}=${JSON.stringify(value)}\n`);
  }
} else {
  process.stdout.write(`${JSON.stringify(bump)}\n`);
}
