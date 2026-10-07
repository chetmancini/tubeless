# Security policy

Please report vulnerabilities privately. Do not open a public issue, pull
request, or discussion for a security problem.

Use [GitHub private vulnerability reporting](https://github.com/chetmancini/tubeless/security/advisories/new)
for this repository.

Include the affected version or commit, what you expected, what happened, and
enough detail to reproduce. Do not include exploits against third-party
systems.

This is a small-maintainer pre-1.0 project. I will acknowledge reports I can
act on, but there is no SLA.

## Scope

In scope: the published `tubeless` library, CLI, and Studio, including enforcement
of the documented authenticated gateway boundary.

Out of scope: application pipelines, commands, and catalogs; application login,
authorization, proxy, and deployment configuration; leaked credentials in your own
runs or stores; and deliberately shared unauthenticated read-only binding.

## Studio

`tubeless ui` binds `127.0.0.1` by default. Without gateway mode, browser execution
requires loopback (`127.0.0.1`, `::1`, or `localhost`, case-insensitive), and history
clearing is wired only on loopback. A non-loopback host without commands serves
read-only history to anyone who can reach the port, including recorded logs.

`--public-url` enables authenticated gateway mode and requires a secret
`TUBELESS_STUDIO_GATEWAY_TOKEN` (32 random bytes encoded as 64 hex characters).
Studio authenticates the gateway on every request, validates Host, and requires
exact browser Origin for POST/DELETE in addition to existing custom-header guards.
It never trusts forwarded identity or host headers. Gateway mode disables history
clearing and permits registered execution on a private non-loopback listener.

The application must authenticate and authorize every page/API request, replace
browser credentials with the backend token, and forward to a fixed private
upstream with the configured public Host and original checked Origin. Expose only
the application gateway publicly; protect the backend transport appropriately.
Bearer authentication does not encrypt HTTP. There is one admin trust domain:
admitted users can access the entire configured store and command catalog.

Tokens never belong in HTML, browser requests, URLs, argv, or logs. Studio removes
the token from its environment after startup so launched commands and their child
processes do not inherit it. Recorded
pipeline data is not redacted. Preserve no-store and CSP response headers and
exclude Studio from service-worker/shared caching. API login denials use JSON
401/403; backend credential failures should become generic gateway 502 responses.

The CLI hosting flags and gateway forwarding rules are supported. Studio's JSON
payloads and server internals remain bundled UI/server implementation details,
not a public embedding or REST API. Execution is process-local, not a durable
scheduler; never automatically retry uncertain launch requests.

See [the Studio hosting contract](./docs/studio.md#host-studio-behind-an-application-gateway).
