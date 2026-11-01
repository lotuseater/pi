#!/usr/bin/env python3
"""Replay completed pi-task runs through individual and grouped result collection.

This exercises the existing Python controller without contacting a provider or
executing historical commands. Private full replies stay under --out-dir.
"""
import argparse
import contextlib
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import time


def load_controller(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def bounded_read(path):
    if path.stat().st_size > 64 * 1024 * 1024:
        raise ValueError(f"input exceeds 64 MiB: {path}")
    return path.read_bytes()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def collect(args):
    root = args.out_dir.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    snapshots = root / "state" / "sessions"
    snapshots.mkdir(parents=True)
    baseline = load_controller(args.baseline, "pi_coord_baseline")
    candidate = load_controller(args.candidate, "pi_coord_candidate")
    candidates = sorted(args.state_dir.joinpath("sessions").glob("*/meta.json"),
                        key=lambda p: p.stat().st_mtime, reverse=True)
    workers = []
    skipped = 0
    for meta_path in candidates:
        if len(workers) == args.limit:
            break
        try:
            meta_raw = bounded_read(meta_path)
            state_raw = bounded_read(meta_path.with_name("state.json"))
            log_raw = bounded_read(meta_path.with_name("log.jsonl"))
            meta, state = json.loads(meta_raw), json.loads(state_raw)
            seq = meta.get("last_msg")
            if not seq:
                continue
            records = [json.loads(line) for line in log_raw.splitlines() if line.strip()]
            outcome = baseline.Outcome()
            if not baseline.scan(records, seq, outcome) or outcome.status != "done" or outcome.aborted:
                continue
            if not outcome.replies or outcome.replies[-1].get("stop") == "error":
                continue
            if not baseline.reply_text(outcome).strip():
                continue
            source = Path(state["session_file"])
            source_raw = bounded_read(source)
            source_entries = [json.loads(line) for line in source_raw.splitlines() if line.strip()]
            if source_entries[0].get("type") != "session":
                continue
            start = end = None
            for record in records:
                if record.get("ev") == "read" and record.get("seq") == seq:
                    start = record["ts"]
                elif start is not None and record.get("ev") == "idle":
                    end = record["ts"]
                    break
            if start is None or end is None:
                continue
            # Keep independent frozen controller inputs; no live session state is mutated.
            folder = snapshots / meta_path.parent.name
            folder.mkdir(mode=0o700)
            for name, data in [("meta.json", meta_raw), ("state.json", state_raw), ("log.jsonl", log_raw)]:
                folder.joinpath(name).write_bytes(data)
            folder.joinpath("queue").mkdir()
            folder.joinpath("sent").mkdir()
            corpus_path = root / f"worker-{len(workers)}.jsonl"
            corpus_path.write_bytes(source_raw)
            baseline.SESSIONS = snapshots
            session = baseline.Session(meta_path.parent.name)
            capture = io.StringIO()
            with contextlib.redirect_stdout(capture):
                rc = baseline.report(session, outcome, argparse.Namespace(json=True, quiet=True),
                                     time.time())
            if rc != 0:
                raise AssertionError("selected completed outcome failed baseline reporting")
            usage = {}
            for field in ["input", "output", "total"]:
                values = [r.get("usage", {}).get(field) for r in outcome.replies]
                usage[field] = sum(values) if all(type(v) in (int, float) and v >= 0 for v in values) else None
            workers.append({"name": session.name, "sequence": seq,
                            "sourcePath": str(source), "sourceSha256": digest(source_raw),
                            "sourceBytes": len(source_raw), "snapshotPath": str(corpus_path),
                            "logSha256": digest(log_raw), "runStart": start, "runEnd": end,
                            "observedResponses": len(outcome.replies), "reportedUsage": usage,
                            "baseline": json.loads(capture.getvalue())})
        except (OSError, ValueError, KeyError, TypeError):
            skipped += 1
    if len(workers) != args.limit:
        raise RuntimeError(f"only {len(workers)} complete readable runs; requested {args.limit}")
    candidate.STATE_DIR = root / "state"
    candidate.SESSIONS = snapshots
    names = [worker["name"] for worker in workers]
    before = {str(p): digest(p.read_bytes()) for p in snapshots.rglob("*") if p.is_file()}
    _, commands = candidate.build_parser()
    parsed = commands["wait-many"].parse_intermixed_args(
        [*names, "--timeout", "2", "--json", "--reply-chars", "1600",
         "--output", str(root / "full-results.json")])
    capture = io.StringIO()
    started = time.monotonic()
    with contextlib.redirect_stdout(capture):
        rc = parsed.func(parsed)
    elapsed = time.monotonic() - started
    if rc != 0:
        raise AssertionError(f"grouped collection failed: {rc}: {capture.getvalue()}")
    after = {str(p): digest(p.read_bytes()) for p in snapshots.rglob("*") if p.is_file()}
    if before != after:
        raise AssertionError("read-only collection changed a session snapshot")
    grouped = json.loads(capture.getvalue())
    full = json.loads(root.joinpath("full-results.json").read_text())
    result = {"formatVersion": 1, "selection": "most recently modified completed nonempty last-message runs",
              "workers": workers, "grouped": grouped, "fullGrouped": full,
              "groupedLocalSeconds": elapsed, "skippedUnreadable": skipped,
              "snapshotStateUnchanged": True, "newModelInvocations": 0}
    root.joinpath("traffic-input.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"workers": len(workers), "workerResponses": sum(w["observedResponses"] for w in workers),
                      "fullIndividualBytes": sum(len(json.dumps(w["baseline"]).encode()) for w in workers),
                      "groupedStdoutBytes": len(capture.getvalue().encode()), "localSeconds": elapsed,
                      "artifact": str(root / "traffic-input.json")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, default=Path(__file__).with_name("pi-task"))
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=8, choices=range(1, 33))
    os.umask(0o077)
    collect(parser.parse_args())
