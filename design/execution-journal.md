# Host-owned execution journal

Issue: [#332](https://github.com/chetmancini/tubeless/issues/332).

The recovery contract was agreed on 2026-11-15. Its implemented contract and
adapter obligations are documented in [execution journals](../docs/execution-journal.md).

Keep stable recovery paths separate from fresh invocation run IDs. Require explicit
implementation versions and lossless compatibility bindings, stop on incomplete
ordinary effects, and let native agent checkpoints own agent replay. Storage,
leases, fencing and human-input waiting remain host-owned. Cloud adaptation follows
the upstream release; retain every patch hunk without an upstream replacement.
