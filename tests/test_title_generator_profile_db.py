"""Regression tests for profile-scoped background session titles."""

import contextlib
import importlib
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch


AGENT_ROOT = Path(__file__).resolve().parents[1] / "build" / "offline-runtime" / "hermes-agent"
sys.path.insert(0, str(AGENT_ROOT))

# title_generator only needs this symbol at import time. Keeping the stub local
# avoids making this regression test depend on the packaged Python environment.
auxiliary_client = types.ModuleType("agent.auxiliary_client")
auxiliary_client.call_llm = lambda *args, **kwargs: None
sys.modules.setdefault("agent.auxiliary_client", auxiliary_client)
title_generator = importlib.import_module("agent.title_generator")


class BackgroundTitleProfileDbTests(unittest.TestCase):
    def test_factory_is_entered_in_worker_and_supplies_profile_db(self):
        finished = threading.Event()
        observed = {}
        request_thread = threading.get_ident()
        profile_db = object()

        @contextlib.contextmanager
        def profile_db_factory():
            observed["factory_thread"] = threading.get_ident()
            observed["entered"] = True
            try:
                yield profile_db
            finally:
                observed["closed"] = True

        def fake_auto_title(db, session_id, *_args, **_kwargs):
            observed["db"] = db
            observed["session_id"] = session_id
            observed["title_thread"] = threading.get_ident()
            finished.set()

        with (
            patch.object(title_generator, "_auto_title_enabled", return_value=True),
            patch.object(title_generator, "auto_title_session", side_effect=fake_auto_title),
        ):
            title_generator.maybe_auto_title(
                None,
                "profile-session",
                "user",
                "assistant",
                [{"role": "user", "content": "user"}],
                session_db_factory=profile_db_factory,
            )

        self.assertTrue(finished.wait(2), "background title worker did not finish")
        self.assertIs(observed["db"], profile_db)
        self.assertEqual(observed["session_id"], "profile-session")
        self.assertNotEqual(observed["factory_thread"], request_thread)
        self.assertEqual(observed["factory_thread"], observed["title_thread"])
        self.assertTrue(observed.get("closed"))


if __name__ == "__main__":
    unittest.main()
