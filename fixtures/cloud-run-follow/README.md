# Paired Cloud run-following fixtures

`v1/` mirrors `tests/fixtures/run-follow/v1/` from the C5a implementation at
`chetmancini/tubeless-cloud@f24d690939ff661ebda458d4532dfa8cd9c6adc5`
([Cloud PR #161](https://github.com/chetmancini/tubeless-cloud/pull/161)).
The matching contract lives in `docs/cloud/run-following.md` at that commit.

`bun run pack:verify` drives the installed CLI against these exchanges. The
packed test also drops a connection mid-record, replays an output position,
and sends SIGINT to a waiting client before attaching to the same run again.
It supplies full run projections for the final retained read because the
paired NDJSON intentionally contains compact projections.

Fixture acceptance covers the wire contract at the pinned commit. Cloud
deployment and npm release are separate integration milestones.
