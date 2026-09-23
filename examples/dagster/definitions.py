"""Dagster asset backed by a Node.js Tubeless pipeline through Dagster Pipes."""

import json
import shutil
from pathlib import Path

import dagster as dg


class DatasetConfig(dg.Config):
    lines: list[str] = [" Alpha ", "", "Beta", "ALPHA"]


@dg.asset(
    kinds={"typescript", "tubeless"},
    retry_policy=dg.RetryPolicy(max_retries=2, delay=1),
)
def normalized_rows(
    context: dg.AssetExecutionContext,
    config: DatasetConfig,
    pipes: dg.PipesSubprocessClient,
):
    root = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node.js must be installed on the Dagster execution host")
    # Each Dagster run owns its directory. Step retries replace the same dataset.
    directory = root / ".context" / "dagster-artifacts" / context.run.run_id
    trace_path = directory / "trace.ndjson"
    invocation = pipes.run(
        command=[node, str(root / ".context" / "dagster" / "worker.js")],
        cwd=str(root),
        context=context,
        extras={
            "job": {
                "lines": config.lines,
                "outputPath": str(directory / "rows.json"),
                "tracePath": str(trace_path),
            }
        },
    )
    # Save raw Tubeless events, not the surrounding Pipes protocol messages.
    directory.mkdir(parents=True, exist_ok=True)
    with trace_path.open("w") as trace:
        for message in invocation.get_custom_messages():
            if isinstance(message, dict) and message.get("kind") == "tubeless-trace":
                trace.write(json.dumps(message["event"]) + "\n")

    # Require explicit confirmation from the worker, not inferred success.
    results = invocation.get_results(implicit_materializations=False)
    if len(results) != 1:
        raise dg.Failure(f"Expected one explicit materialization, got {len(results)}")
    yield from results


defs = dg.Definitions(
    assets=[normalized_rows],
    resources={"pipes": dg.PipesSubprocessClient()},
)
