# Offline tool-output replay

This probe measures JSON request-body bytes for four settings: existing Pi8 behavior, old-output retirement, shell compaction, and both. It uses the real OpenAI-completions serializer with a stub response. It does not contact a provider or execute any recorded shell command.

Run from the repository root with the same Node version used by Pi:

```sh
env -u PI_TOOL_VAULT PI_CONTEXT_RESULT_REFERENCES=1 PI_CONTEXT_READ_DELTAS=0 \
  node --max-old-space-size=512 scripts/pi-efficiency/tool-output-replay.mjs \
  --out /path/to/private/replay.json \
  --corpus /path/to/saved-session.jsonl \
  --limit 30
```

Repeat `--corpus` for each explicitly selected session. `--no-synthetic` omits the synthetic cases. `--json` is an alias for `--out`. The input limit is 64 MiB per file and 1–200 recorded assistant boundaries per session. Run under the host's normal memory and scheduling controls. The runner creates and removes its own temporary archive directory.

Tests:

```sh
node --test scripts/pi-efficiency/tool-output-replay.test.mjs
node --test scripts/pi-efficiency/tool-vault-wire.test.mjs
```

The first test launches a bounded child process with the required reference settings. The second is the older native-read diagnostic probe, corrected to use assistant boundaries and the Pi8 reference projection; it is not the four-variant rollout benchmark.

When the host forbids child process pipes or test-runner workers, use the exported harness entry points in the same process. These commands run every assertion and the corpus fixture through `node:test` without spawning a subprocess:

```sh
timeout 180s env -u PI_TOOL_VAULT PI_CONTEXT_RESULT_REFERENCES=1 PI_CONTEXT_READ_DELTAS=0 PI_REPLAY_IN_PROCESS=1 \
  node --max-old-space-size=512 scripts/pi-efficiency/tool-output-replay.test.mjs
timeout 180s env -u PI_TOOL_VAULT PI_CONTEXT_RESULT_REFERENCES=1 PI_CONTEXT_READ_DELTAS=0 PI_REPLAY_IN_PROCESS=1 \
  node --max-old-space-size=512 scripts/pi-efficiency/tool-vault-wire.test.mjs
```

Both modes create result JSON before reading it for assertions. Normal subprocess mode checks spawn errors, signals, exit status and nonempty output, with a 120-second child timeout. Successful validation prints seven named passing subtests for each file; a file-level exit status alone is insufficient.

## What the report contains

- `sources`: explicit private input paths, SHA256 hashes, sizes, and selected assistant entry IDs. No conversation text or request payloads are saved.
- `historical`: recorded messages as they are. Unmarked historical Bash results remain full after installation.
- `prospective`: the same saved output text passed through the current built-in Bash tool's fake execution operations to simulate newly produced results. Only complete successful text is marked, and its visible bytes must remain identical. No historical command is executed. This is a prospective simulation, not a migration of old sessions.
- `sharedBytes`: request bodies at recorded assistant boundaries, reconstructed with Pi's session context builder, including existing branch and compaction state.
- `verificationBytes`: one common scripted query requesting exact lines from the same historical result in every variant.
- `retrievalBytes`: an extra request only when that variant hid the requested result. Exact retrieval is asserted. This includes the retrieval schema, call and result.
- `laterBytes`: three common follow-up requests, with the same scripted answer in every variant and retransmitted recall output where applicable.
- `totalBytes`: all four categories combined. Synthetic, historical and prospective aggregates remain separate.
- `localWallMs` and `localCpuMs`: per-case local projection, archive integrity I/O, and stub serialization. Fixed variant order, warmed caches, and shared host load mean these are diagnostic costs rather than a controlled speed comparison. `peakRssMiB` is the whole process high-water mark, excluding file cache.

The retrieval target is the first large, complete, successful Bash result in the final context, otherwise the first large successful text result, otherwise the first successful text result. The test asks for lines 1–20. This is an explicit stress case, not an estimate of how often a model would recall output.

The seven declared baseline tools and Pi8 reference projection are held constant. Historical system-message `toolsAdded` and `toolsRemoved` registry changes are excluded while instruction text is retained; every serialized request asserts the actual declaration names. Session logs cannot reconstruct every historical extension declaration, provider retry, compaction-generation request, or configuration change. Counts therefore describe the stated offline replay configuration, not a reconstruction of billed usage. They are not exact model tokens, HTTP transport bytes, tokens per active minute, useful-work throughput, or evidence of preserved task quality.

Keep the JSON report private: corpus paths and identifiers can disclose project information. Public benchmark artifacts should contain the harness, configuration, corpus hashes where appropriate, and aggregated measurements, never private session content.
