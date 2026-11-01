"""Local log fixtures for pi-task wait-many; no workers or providers are started."""

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


LOADER = importlib.machinery.SourceFileLoader("pi_task_wait_many", str(Path(__file__).with_name("pi-task")))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
pi = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(pi)


def assistant(text="answer", usage=None, **fields):
    return dict(ev="assistant", text=text, usage=usage, **fields)


def settled(text="answer", usage=None, seq=1, **fields):
    return [{"ev": "read", "seq": seq}, assistant(text, usage, **fields), {"ev": "idle"}]


class WaitManyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-task-wait-many-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sessions = self.root / "sessions"
        self.sessions.mkdir()
        self.original_sessions = pi.SESSIONS
        pi.SESSIONS = self.sessions
        self.addCleanup(setattr, pi, "SESSIONS", self.original_sessions)
        # The real log scanner and wait_for run; only tmux/process liveness is replaced.
        live = patch.object(pi.Session, "pane", return_value={"dead": False, "pid": 123, "status": None})
        live.start()
        self.addCleanup(live.stop)
        self.parser, self.commands = pi.build_parser()

    def session(self, name, records=(), seq=1, **metadata):
        sess = pi.Session(name)
        sess.dir.mkdir()
        sess.queue_dir.mkdir()
        sess.sent_dir.mkdir()
        pi.write_json(sess.meta_path, dict(name=name, pi_session_id=f"id-{name}", last_msg=seq,
                                           updated=1, **metadata))
        pi.write_json(sess.state_path, {"last_stop": "stale-other-message"})
        sess.log_path.touch()
        self.append(sess, records)
        return sess

    def append(self, sess, records):
        with sess.log_path.open("a", encoding="utf-8") as f:
            for record in records:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def snapshot(self):
        return {str(path.relative_to(self.sessions)): (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
                for path in self.sessions.rglob("*") if path.is_file()}

    def run_wait(self, names, timeout=2, *options):
        args = self.commands["wait-many"].parse_intermixed_args(
            [*names, "--timeout", str(timeout), "--json", *options])
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = args.func(args)
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        data = json.loads(stdout.getvalue())
        self.assertEqual(data["schema_version"], 1)
        return code, data

    def assert_usage(self, usage, count, input_, output, total):
        self.assertEqual(usage, {"response_count": count, "input_tokens": input_,
                                 "output_tokens": output, "total_tokens": total})

    def test_frozen_sequence_ignores_stale_idle_and_newer_last_message(self):
        sess = self.session("frozen", settled("old", seq=1), seq=5)
        original = pi.Tail.lines
        changed = threading.Event()

        def source(tail):
            records = original(tail)
            if threading.current_thread() is not threading.main_thread() and not changed.is_set():
                meta = sess.meta()
                meta["last_msg"] = 6
                pi.write_json(sess.meta_path, meta)
                self.append(sess, settled("requested", {"input": 3, "output": 4, "total": 7}, seq=5,
                                          stop="stop") + settled("newer", seq=6))
                changed.set()
            return records

        with patch.object(pi.Tail, "lines", source):
            code, data = self.run_wait(["fro"])
        self.assertTrue(changed.is_set())
        self.assertEqual(code, 0)
        result = data["targets"][0]
        self.assertEqual((result["session"], result["pi_session_id"], result["seq"]), ("frozen", "id-frozen", 5))
        self.assertEqual(result["reply"], "requested")
        self.assertEqual(result["stop_reason"], "stop")
        self.assert_usage(data["usage"], 1, 3, 4, 7)

    def test_sessions_wait_concurrently_and_default_waits_for_all(self):
        first, second = self.session("first"), self.session("second")
        original = pi.Tail.lines
        readers, ready, release = {}, threading.Event(), threading.Event()
        errors = []

        def source(tail):
            if threading.current_thread() is not threading.main_thread():
                readers[tail.path.parent.name] = threading.get_ident()
                if len(readers) == 2:
                    ready.set()
            return original(tail)

        def write_logs():
            try:
                if not ready.wait(1):
                    raise AssertionError("both local observers must start before either task settles")
                self.append(first, settled("first done"))
                time.sleep(0.4)
                self.append(second, settled("second done"))
                release.set()
            except BaseException as e:
                errors.append(e)

        writer = threading.Thread(target=write_logs)
        with patch.object(pi.Tail, "lines", source):
            writer.start()
            code, data = self.run_wait(["first", "second"])
            writer.join(2)
        self.assertFalse(writer.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(release.is_set())
        self.assertEqual(len(set(readers.values())), 2)
        self.assertEqual(code, 0)
        self.assertEqual([r["status"] for r in data["targets"]], ["done", "done"])

    def test_failure_returns_early_collects_settled_peers_and_leaves_workers_untouched(self):
        self.session("failed", settled("partial failure", stop="error", error="broken"))
        self.session("survivor", [{"ev": "read", "seq": 1}, assistant("still working")])
        self.session("finished", settled("already available"))
        before = self.snapshot()
        started = time.monotonic()
        code, data = self.run_wait(["failed", "survivor", "finished"], 30)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual((code, data["status"]), (1, "error"))
        self.assertEqual([r["status"] for r in data["targets"]], ["error", "waiting", "done"])
        self.assertEqual(data["targets"][0]["error"], "broken")
        self.assertEqual(data["targets"][1]["reply"], "still working")
        self.assertEqual(self.snapshot(), before)

    def test_timeout_keeps_partial_replies_and_does_not_change_worker_files(self):
        self.session("slow", [{"ev": "read", "seq": 1},
                              assistant("partial", {"input": 4, "output": 1, "total": 5})])
        before = self.snapshot()
        started = time.monotonic()
        code, data = self.run_wait(["slow"], 0.05)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual((code, data["status"]), (3, "timeout"))
        self.assertEqual(data["targets"][0]["status"], "timeout")
        self.assertEqual(data["targets"][0]["reply"], "partial")
        self.assert_usage(data["usage"], 1, 4, 1, 5)
        self.assertEqual(self.snapshot(), before)

    def test_wait_for_cancellation_does_a_final_scan_without_mutation(self):
        sess = self.session("cancelled", [{"ev": "read", "seq": 1}])
        cancel = threading.Event()
        before = self.snapshot()
        timer = threading.Timer(0.03, cancel.set)
        timer.start()
        try:
            out = pi.wait_for(sess, 1, quiet=True, cancel_event=cancel)
        finally:
            timer.join()
        self.assertEqual(out.status, "waiting")
        self.assertTrue(out.read)
        self.assertEqual(self.snapshot(), before)
        self.append(sess, [assistant("available at cancellation"), {"ev": "idle"}])
        out = pi.wait_for(sess, 1, quiet=True, cancel_event=cancel)
        self.assertEqual((out.status, pi.reply_text(out)), ("done", "available at cancellation"))

    def test_keyboard_interrupt_cancels_only_observers_and_returns_json(self):
        self.session("running", [{"ev": "read", "seq": 1}])
        before = self.snapshot()
        ready = threading.Event()
        original = pi.Tail.lines

        def source(tail):
            if threading.current_thread() is not threading.main_thread():
                ready.set()
            return original(tail)

        def interrupt():
            if ready.wait(1):
                os.kill(os.getpid(), signal.SIGINT)

        previous = signal.signal(signal.SIGINT, signal.default_int_handler)
        writer = threading.Thread(target=interrupt)
        try:
            with patch.object(pi.Tail, "lines", source):
                writer.start()
                code, data = self.run_wait(["running"], 2)
        finally:
            writer.join(2)
            signal.signal(signal.SIGINT, previous)
        self.assertEqual((code, data["status"]), (1, "interrupted"))
        self.assertEqual(data["targets"][0]["status"], "waiting")
        self.assertEqual(self.snapshot(), before)

    def test_duplicate_aliases_are_usage_errors(self):
        self.session("alpha", settled())
        before = self.snapshot()
        for names in (["alpha", "al"], ["id-alpha", "alpha"], ["last", "alpha"]):
            with self.subTest(names=names), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    self.run_wait(names)
                self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.snapshot(), before)

    def test_invalid_inputs_are_usage_errors(self):
        self.session("none", seq=None)
        self.session("valid", settled())
        cases = [([], 1, ()), ([""], 1, ()), ([" "], 1, ()), (["none"], 1, ()),
                 ([f"task{i}" for i in range(33)], 1, ()), (["valid"], -1, ()),
                 (["valid"], float("nan"), ()), (["valid"], float("inf"), ()),
                 (["valid"], 1, ("--reply-chars", "8193")), (["valid"], 1, ("--reply-chars", "-1"))]
        for names, timeout, options in cases:
            with self.subTest(names=names, timeout=timeout, options=options):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                    self.run_wait(names, timeout, *options)
                self.assertEqual(error.exception.code, 2)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            self.commands["wait-many"].parse_intermixed_args(["valid"])
        self.assertEqual(error.exception.code, 2)

    def test_missing_and_malformed_usage_is_unknown_per_field(self):
        bad_values = [None, {}, [], "bad", {"input": "3", "output": 2, "total": 5},
                      {"input": True, "output": -1, "total": 4.5},
                      {"input": 3, "output": None, "total": 5}, {"input": 3, "output": 2},
                      {"input": 0, "output": 0, "total": 0}]
        for index, usage in enumerate(bad_values):
            with self.subTest(usage=usage):
                name = f"usage{index}"
                response = assistant("last", usage)
                if usage is None:
                    response.pop("usage")
                self.session(name, [{"ev": "read", "seq": 1},
                                    assistant("first", {"input": 10, "output": 20, "total": 35}),
                                    response, {"ev": "idle"}])
                code, data = self.run_wait([name])
                self.assertEqual(code, 0)
                expected = {"response_count": 2}
                for key, base in (("input", 10), ("output", 20), ("total", 35)):
                    value = usage.get(key) if isinstance(usage, dict) else None
                    expected[key + "_tokens"] = base + value if type(value) is int and value >= 0 else None
                self.assertEqual(data["targets"][0]["usage"], expected)
                self.assertEqual(data["usage"], expected)

    def test_every_worker_response_contributes_to_aggregate_reported_totals(self):
        self.session("one", [{"ev": "read", "seq": 1},
                             assistant("planning", {"input": 10, "output": 2, "total": 17}),
                             assistant("", {"input": 20, "output": 3, "total": 29}),
                             assistant("final", {"input": 30, "output": 4, "total": 41}), {"ev": "idle"}])
        self.session("two", settled("second", {"input": 7, "output": 5, "total": 15}))
        code, data = self.run_wait(["one", "two"])
        self.assertEqual(code, 0)
        self.assert_usage(data["targets"][0]["usage"], 3, 60, 9, 87)
        self.assert_usage(data["targets"][1]["usage"], 1, 7, 5, 15)
        self.assert_usage(data["usage"], 4, 67, 14, 102)
        self.assertEqual(data["targets"][0]["reply"], "final")

    def test_aggregate_usage_preserves_unknown_totals_from_each_target(self):
        self.session("known", settled("known usage", {"input": 10, "output": 2, "total": 17}))
        self.session("empty", [{"ev": "read", "seq": 1}, {"ev": "idle"}])
        self.session("compact", [{"ev": "compacting", "seq": 1},
                                 {"ev": "compacted", "seq": 1, "pre": 100, "post": 20}])
        self.session("missing", settled("missing usage"))
        self.session("partial", settled("partial usage", {"input": 4, "output": None, "total": 7}))
        cases = [("empty", 1, 1, None, None, None), ("compact", 0, 1, None, None, None),
                 ("missing", 0, 2, None, None, None), ("partial", 0, 2, 14, None, 24)]
        for target, expected_code, count, input_, output, total in cases:
            with self.subTest(target=target):
                artifact = self.root / f"usage-{target}.json"
                code, data = self.run_wait(["known", target], 1, "--output", str(artifact))
                self.assertEqual(code, expected_code)
                self.assert_usage(data["targets"][0]["usage"], 1, 10, 2, 17)
                self.assert_usage(data["usage"], count, input_, output, total)
                self.assertEqual(data["usage_scope"], "captured_assistant_responses")
                raw = json.loads(artifact.read_text())
                self.assertEqual(raw["usage"], data["usage"])
                self.assertEqual(raw["usage_scope"], data["usage_scope"])

    def test_reply_bounds_and_full_private_atomic_artifact(self):
        text = "multiline\n" + "\u03bb" * 10000
        self.session("large", settled(text, {"input": 8, "output": 9, "total": 17}))
        artifact = self.root / "result.json"
        code, data = self.run_wait(["large"], 1, "--output", str(artifact))
        self.assertEqual(code, 0)
        self.assertEqual(data["raw_artifact"], str(artifact))
        self.assertEqual(data["targets"][0]["reply"], text[:1600])
        self.assertTrue(data["targets"][0]["reply_truncated"])
        raw = json.loads(artifact.read_text())
        self.assertEqual(raw["targets"][0]["reply"], text)
        self.assertEqual(raw["targets"][0]["outcome"]["replies"][0]["text"], text)
        self.assertEqual(raw["usage"], data["usage"])
        self.assertEqual(stat.S_IMODE(artifact.stat().st_mode), 0o600)
        self.assertEqual(list(self.root.glob(".result.json.*")), [])
        before = artifact.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            self.run_wait(["large"], 1, "--output", str(artifact))
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(artifact.read_bytes(), before)
        for bound in (0, 12, 8192):
            with self.subTest(bound=bound):
                _, bounded = self.run_wait(["large"], 1, "--reply-chars", str(bound))
                self.assertEqual(bounded["targets"][0]["reply"], text[:bound])
                self.assertTrue(bounded["targets"][0]["reply_truncated"])

    def test_artifact_created_during_wait_is_never_overwritten(self):
        self.session("race", settled())
        artifact = self.root / "race.json"
        original = pi.Tail.lines

        def source(tail):
            if threading.current_thread() is not threading.main_thread():
                artifact.write_text("other writer result")
            return original(tail)

        with patch.object(pi.Tail, "lines", source):
            code, data = self.run_wait(["race"], 1, "--output", str(artifact))
        self.assertEqual((code, data["status"]), (1, "error"))
        self.assertIsNone(data["raw_artifact"])
        self.assertIn("cannot write result", data["error"])
        self.assertEqual(artifact.read_text(), "other writer result")
        self.assertEqual(list(self.root.glob(".race.json.*")), [])

    def test_empty_answer_aborted_and_error_stop_follow_existing_report_exit_rules(self):
        cases = [([{"ev": "read", "seq": 1}, {"ev": "idle", "stop": "length"}], True, "length", None),
                 (settled("  ", stop="max_tokens"), True, "max_tokens", None),
                 ([{"ev": "read", "seq": 1}, assistant("partial"), {"ev": "idle", "aborted": True}],
                  False, None, "interrupted"),
                 (settled("partial", stop="error", error="provider failed"), False, "error", "provider failed"),
                 ([{"ev": "failed", "seqs": [1], "error": "delivery failed"}], False, None, "delivery failed"),
                 ([{"ev": "dropped", "seqs": [1], "reason": "stopped"}], False, None,
                  "the message was dropped: pi-task stopped the session before pi read it"),
                 ([{"ev": "read", "seq": 1}, {"ev": "shutdown", "stopping": True}],
                  False, None, "pi-task stop ended the session")]
        for index, (records, empty, stop, error) in enumerate(cases):
            with self.subTest(index=index):
                sess = self.session(f"failure{index}", records)
                code, data = self.run_wait([sess.name])
                result = data["targets"][0]
                self.assertEqual((code, data["status"], result["status"]), (1, "error", "error"))
                self.assertEqual(result["answer_empty"], empty)
                self.assertEqual(result["stop_reason"], stop)
                if empty:
                    self.assertIn("Qwen gave no answer", result["error"])
                else:
                    self.assertEqual(result["error"], error)
                out = pi.wait_for(sess, 1, quiet=True)
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    existing_code = pi.report(sess, out, self.commands["wait"].parse_args([sess.name, "--json"]),
                                              time.time())
                self.assertEqual(code, existing_code)

    def test_last_nonempty_reply_and_compaction_keep_existing_semantics(self):
        self.session("nonempty", [{"ev": "read", "seq": 1}, assistant("kept"), assistant(""), {"ev": "idle"}])
        self.session("compact", [{"ev": "compacting", "seq": 1},
                                 {"ev": "compacted", "seq": 1, "pre": 100, "post": 20}])
        code, data = self.run_wait(["nonempty", "compact"])
        self.assertEqual(code, 0)
        self.assertEqual(data["targets"][0]["reply"], "kept")
        self.assertFalse(data["targets"][1]["answer_empty"])
        self.assert_usage(data["targets"][1]["usage"], 0, None, None, None)

    def test_zero_deadline_still_collects_available_outcomes(self):
        self.session("done", settled())
        self.session("pending")
        code, data = self.run_wait(["done", "pending"], 0)
        self.assertEqual((code, data["status"]), (3, "timeout"))
        self.assertEqual([r["status"] for r in data["targets"]], ["done", "timeout"])
        self.assert_usage(data["targets"][1]["usage"], 0, None, None, None)

    def test_json_is_the_default_and_existing_wait_cli_remains_available(self):
        self.session("plain", settled())
        args = self.commands["wait-many"].parse_intermixed_args(["plain", "--timeout", "1"])
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(args.func(args), 0)
        self.assertEqual(json.loads(stdout.getvalue())["status"], "done")
        args = self.commands["wait"].parse_intermixed_args(["plain", "--timeout", "1", "--quiet", "--json"])
        with contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(args.func(args), 0)
        self.assertEqual(json.loads(stdout.getvalue())["reply"], "answer")

    def test_accepts_32_unique_sessions(self):
        names = [f"worker{index}" for index in range(32)]
        for name in names:
            self.session(name, settled(usage={"input": 1, "output": 2, "total": 3}))
        code, data = self.run_wait(names)
        self.assertEqual(code, 0)
        self.assertEqual([r["session"] for r in data["targets"]], names)
        self.assert_usage(data["usage"], 32, 32, 64, 96)

    def test_observer_source_errors_return_failure_json(self):
        self.session("unreadable")
        original = pi.Tail.lines

        def source(tail):
            if threading.current_thread() is not threading.main_thread():
                raise OSError("fixture source unavailable")
            return original(tail)

        with patch.object(pi.Tail, "lines", source):
            code, data = self.run_wait(["unreadable"], 1)
        self.assertEqual((code, data["status"]), (1, "error"))
        self.assertEqual(data["targets"][0]["error"], "fixture source unavailable")


if __name__ == "__main__":
    unittest.main()
