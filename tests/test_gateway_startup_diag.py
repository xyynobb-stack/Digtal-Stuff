import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class StartupDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "resources/hermes-agent-overlays/gateway/desktop_startup_diag.py"
        spec = importlib.util.spec_from_file_location("diag", source)
        self.diag = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.diag)

    def test_stacks_are_bounded_and_exclude_local_values(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"HERMES_HOME": home, "HERMES_GATEWAY_START_ID": "test"}):
            secret_value = "must-not-be-in-diagnostics"
            with patch.object(self.diag._stop, "wait", return_value=False):
                self.diag._watch()
            raw = (Path(home) / "logs/gateway-startup-diag.jsonl").read_text()
            rows = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual(len(rows), 12)
            self.assertNotIn(secret_value, raw)
            self.assertTrue(all(row["startup_id"] == "test" for row in rows))
            self.assertIn("threads", rows[0])

    def test_finish_stops_sampling_and_io_failure_is_nonfatal(self):
        self.diag.finish()
        with patch.object(self.diag, "record") as record:
            self.diag._watch()
            record.assert_not_called()
        with patch("pathlib.Path.mkdir", side_effect=OSError("denied")):
            self.diag.record("test")


if __name__ == "__main__":
    unittest.main()
