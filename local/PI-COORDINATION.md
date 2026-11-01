# Local coordination without extra model turns

`local/pi-task` is the existing Python controller with `wait-many` added. Its
companion extension remains `local/pi-task-extension.ts`. Install the controller
alongside the deployed extension, preserving its executable mode. Existing
sessions require no reload; each CLI invocation loads the installed controller.

For independent workers that can be reviewed together:

```sh
pi-task wait-many worker-a worker-b --timeout 540 --json --output /tmp/results-unique.json
```

The observer freezes each target's resolved name, last-message sequence and Pi
session ID. It waits locally until all requested runs settle, a run fails, or
the deadline expires. It never sends a prompt, stops a worker or changes session
state. Cancellation stops observers only. A deadline is cooperative: an ongoing
filesystem or tmux operation can delay cleanup.

Exit codes: 0 completed; 1 failed/interrupted or artifact write failed; 2 invalid
arguments; 3 unfinished at deadline. `done` describes the run's completion,
not verification that its answer is correct. On early failure other targets can
still be `waiting` and continue working. Up to 32 distinct sessions are accepted.

The JSON contains explicit identities, status, errors, stop reasons, bounded
replies and captured response usage. Replies default to 1,600 characters each
(`--reply-chars 0..8192`). A truncation flag means evidence was omitted: read the
relevant full reply before making a decision that depends on it. `--output`
creates a private mode-0600 JSON artifact atomically and refuses existing paths.
Its parent directory must already exist. Full artifacts can contain private task
content and should remain local.

Usage includes every captured assistant response in the requested worker runs,
not just final answers. Missing counts remain `null`, including in aggregate
totals. The scope is `captured_assistant_responses`; unrecorded provider retries
and compaction-generation calls are not inferred.

Keep build waits, changed-file checks and test-summary extraction in local
commands. Save long output to files and preserve the command's exit status. Use
one tool call to collect related results. An existing batched Bash collection is
already effective; this command adds stable identities and structured results.
Avoid waking a model merely to poll. Use a background process completion event
when the host tool cannot wait for the required duration.

Give workers only the objective, relevant files, constraints and done condition.
Request a short structured result: status, changed paths, checks with exit codes,
evidence paths and remaining blockers. Keep detailed logs in artifacts; never
have another model summarize unchanged logs merely for coordination. Count
parent and worker requests when evaluating savings. These handoff conventions
are guidance; their effect on model behavior was not measured in this replay.

See [the benchmark](PI-COORDINATION-BENCHMARK.md) for measured benefits and limits.

## Reproduce offline

The collector modifies only a new private output directory. Use a saved baseline
controller and a copy of your own session state. The replay never executes
historical commands and its provider transport is stubbed. Install dependencies
and build the Pi checkout as documented by the repository before replaying.

```sh
python3 -m unittest discover -s local -p test_pi_task_wait_many.py
node scripts/pi-efficiency/coordination-replay.test.mjs
python3 local/benchmark_wait_many.py --baseline /path/to/old/pi-task \
  --state-dir /path/to/pi-task-state --out-dir /private/new-cohort --limit 8
PI_CONTEXT_RESULT_REFERENCES=1 PI_CONTEXT_READ_DELTAS=0 \
  node scripts/pi-efficiency/coordination-replay.mjs \
  --input /private/new-cohort/traffic-input.json --out /private/new-replay.json \
  --parent /private/parent-session.jsonl
```

Repeat `--parent` for up to eight saved parent sessions. Keep snapshots, paths and
raw replies private. Publish aggregates and source hashes only. Use the machine's
required memory caps for validation and benchmark jobs.
