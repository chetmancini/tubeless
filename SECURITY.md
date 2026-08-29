# Security policy

Please report vulnerabilities privately. Do not open a public issue, pull
request, or discussion for a security problem.

Use [GitHub private vulnerability reporting](https://github.com/chetmancini/tubeless/security/advisories/new)
for this repository.

Include the affected version or commit, what you expected, what happened, and
enough detail to reproduce. Do not include exploits against third-party
systems.

This is a small-maintainer `0.1.0` project. I will acknowledge reports I can
act on, but there is no SLA.

## Scope

In scope: the published `tubeless` library, the `tubeless` CLI, and the local
studio as they ship from this repository.

Out of scope: pipelines, commands, and studio catalogs you or others write on
top of Tubeless; leaked credentials in your own runs or stores; and
non-loopback studio binding you enable yourself.

## Local studio

The studio is a local process. It is not an authenticated network service.

`tubeless ui` binds `127.0.0.1` by default. Browser-triggered plan, launch, and cancel
are refused unless `--host` is `127.0.0.1`, `::1`, or `localhost` (compared
case-insensitively). Clear-history is wired only on those same hosts.

A non-loopback `--host` without registered commands serves a read-only view of
the run store. Anyone who can reach that port can read recorded events,
including log text your pipelines wrote. Binding `0.0.0.0` or a LAN address is
out of scope; you enabled it.

`startPipelineRunStudio` also defaults to `127.0.0.1`, but it does not refuse a
non-loopback host plus an injected launcher or history capability. That
combination is out of scope.

Browser plan, launch, cancel, and clear-history require a `Host` header that matches
the bound authority, a custom `x-tubeless-studio-*` header, and
`application/json` for plan and launch. Those checks stop ordinary cross-site
form posts. They are not authentication. Do not expose studio to a network you
do not trust.

See [the studio docs](./docs/studio.md).
