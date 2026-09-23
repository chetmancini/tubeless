"""Airflow 3 DAG: run a Tubeless pipeline as one retryable task."""

import json
import os
import subprocess
import tempfile
from datetime import timedelta
from pathlib import Path

from airflow.sdk import dag, get_current_context, task


@dag(dag_id="tubeless_example", schedule=None, catchup=False, tags=["tubeless"])
def tubeless_example():
    @task(task_id="normalize", retries=2, retry_delay=timedelta(seconds=5), multiple_outputs=False)
    def normalize():
        context = get_current_context()
        ti = context["ti"]
        job = {
            "dagId": ti.dag_id,
            "dagRunId": ti.run_id,
            "taskId": ti.task_id,
            "tryNumber": ti.try_number,
            "mapIndex": ti.map_index,
            "conf": context["dag_run"].conf,
        }
        # Install Bun and the example project on EVERY execution worker. This
        # directory is deployment configuration, never user-supplied DAG conf.
        project = Path(os.environ["TUBELESS_EXAMPLE_ROOT"]).resolve()
        print(f"Tubeless invocation: Airflow attempt {ti.try_number}", flush=True)
        with tempfile.TemporaryDirectory(prefix="tubeless-airflow-") as directory:
            result_path = Path(directory) / "result.json"
            subprocess.run(
                ["bun", "run", str(project / "examples/airflow/worker.ts")],
                input=json.dumps(job),
                text=True,
                check=True,
                timeout=90,
                cwd=project,
                env={**os.environ, "TUBELESS_RESULT_PATH": str(result_path)},
            )
            # A nonzero exit or timeout raises before this point: Airflow owns
            # retries. Logs stream to the task log; only a small result is XCom.
            return json.loads(result_path.read_text())

    normalize()


tubeless_example()
