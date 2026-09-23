"""Optional real-host tests: compile the worker, then run unittest discovery here."""

import json
import shutil
import unittest
from pathlib import Path

import dagster as dg
from definitions import normalized_rows


class DagsterIntegrationTests(unittest.TestCase):
    def run_asset(self, config):
        result = dg.materialize(
            [normalized_rows],
            resources={"pipes": dg.PipesSubprocessClient()},
            run_config={"ops": {"normalized_rows": {"config": config}}},
            raise_on_error=False,
        )
        directory = Path(__file__).resolve().parents[2] / ".context" / "dagster-artifacts" / result.run_id
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        return result, directory

    def test_materialization_and_trace(self):
        result, directory = self.run_asset({})
        self.assertTrue(result.success)
        events = result.get_asset_materialization_events()
        self.assertEqual(len(events), 1)
        materialization = events[0].event_specific_data.materialization
        self.assertEqual(materialization.metadata["row_count"].value, 2)
        self.assertEqual(materialization.metadata["artifact"].value, str(directory / "rows.json"))
        self.assertIn("dagster/data_version", materialization.tags)
        self.assertEqual(json.loads((directory / "rows.json").read_text()), {"rows": ["alpha", "beta"]})
        trace = [json.loads(line) for line in (directory / "trace.ndjson").read_text().splitlines()]
        self.assertTrue(any(event["name"] == "pipeline.completed" for event in trace))
        self.assertEqual(trace[0]["runId"], materialization.metadata["tubeless_run_id"].value)

    def test_failure_does_not_materialize(self):
        result, directory = self.run_asset({"lines": [" "]})
        self.assertFalse(result.success)
        self.assertEqual(result.get_asset_materialization_events(), [])
        self.assertFalse((directory / "rows.json").exists())
        self.assertEqual(sum(event.event_type_value == "STEP_RESTARTED" for event in result.all_events), 2)


if __name__ == "__main__":
    unittest.main()
