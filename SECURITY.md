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

The studio defaults to `127.0.0.1`. Browser-triggered execution is rejected
unless the bind address is loopback. See [the studio docs](./docs/studio.md).
