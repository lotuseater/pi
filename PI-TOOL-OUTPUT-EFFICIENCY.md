# Tool-output retirement and shell compaction

Large historical tool results can be replaced in outgoing requests by references to exact local records. The saved conversation remains unchanged. `recall_tool_output` retrieves the historical bytes, including UTF-8 byte paging for very long lines. Re-running a command is not historical retrieval.

Both features are disabled by default. An archive-only configuration for an evaluation with up to 32 session stores is:

```json
{
  "toolVault": {
    "enabled": true,
    "retireOldResults": true,
    "compactShellOutput": false,
    "minBytes": 8192,
    "keepRecentResults": 10,
    "minAssistantTurnsOld": 2,
    "minUserTurnsOld": 0,
    "rootBytes": 1073741824
  }
}
```

Retirement applies to successful, provenance-verified `read`, `grep`, `find`, `ls`, and complete `bash` results after ten later results and two completed assistant rounds. Existing Bash results without the new marker are left intact. Failed, small, unsupported, or unpaired outputs and incomplete Bash results remain visible. Native search/list snapshots may archive their exact observed output even when the search itself was limited. A session activates retrieval during its autonomous run; every reference requires retrieval in the actual outgoing tool declarations.

`compactShellOutput` independently shortens recent successful Bash results by collapsing exact adjacent duplicate lines or matching percentage-progress updates. It preserves unique newline-delimited diagnostics, unknown carriage-return content, terminal output, and programmatic Bash results. It archives the original before shortening anything, and rejects representations that are not smaller after their reference metadata is included. Set `retireOldResults` to false to evaluate compaction alone.

## Replay evidence

Eight saved conversations were replayed at their last 30 assistant request boundaries, with the installed reference-projection policy and a controlled seven-tool loadout. Historical commands were never executed. A local stub captured the real OpenAI-completions serializer's complete JSON request bodies. A common follow-up asked for historical evidence; candidates hiding that evidence paid the recall round and three later retransmissions.

| Prospective replay of newly captured results | Request-body bytes | Saving |
| --- | ---: | ---: |
| Baseline | 125,980,804 | — |
| Retirement | 123,486,364 | 1.98% |
| Shell compaction | 125,980,804 | 0.00% |
| Both | 123,486,364 | 1.98% |

The archive result is concentrated: two conversations improve, two regress, and four are unchanged. The largest winner accounts for more than the net saving; the other seven together regress by about 0.36%. The historical replay, which adds no missing provenance, saves 1.23%. Synthetic repetitive-log results are substantially better, but do not establish benefit on the sampled real work.

These are replay byte counts, not measured live tokens, network framing, model quality, throughput, or tokens per minute. Model behavior and historic outputs are fixed; the retrieval suffix is scripted. Provider retries and summary-generation requests are unavailable from these records. Live validation remains necessary. Archive-only is the candidate for further evaluation; shell compaction stays off by default.

The reproducible harness and its limitations are documented in [scripts/pi-efficiency/TOOL-OUTPUT-REPLAY.md](scripts/pi-efficiency/TOOL-OUTPUT-REPLAY.md). Private transcripts are not included in this repository.

Validation passed: 76 focused checks covering storage, concurrent writers, exact retrieval, session integration, shell compaction and generated schemas; 14 named benchmark assertions; repository `npm run check`; and `npm run build:offline`. These checks use local fixtures and stub providers. They do not establish live task quality or installation on a user's machine.

## Storage and rollback

Records are immutable and are verified before a reference is emitted. Missing or corrupt records, refused storage, and unavailable retrieval keep the original result in the request. The default root admits eight session stores; the example above admits 32. Quotas bound admission and provide best-effort write accounting, not a strict cross-process disk limit. No automatic eviction of referenced history is performed; exhausted storage falls back to full output.

Set `toolVault.enabled` to false or start with `PI_TOOL_VAULT=0` to disable projections. Keep archives while conversations may still refer to them. A managed installation must retain its previous release and resume the original conversation IDs when applying or reverting settings. Source publication does not imply that a packaged release has been installed.
