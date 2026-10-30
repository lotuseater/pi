# Pi efficiency fork

This independent fork builds on [earendil-works/pi](https://github.com/earendil-works/pi),
upstream `main` commit `908aa7b74baa7502321293797313f64c6fec22ee`.
The original study baseline was tag `v1.4.0`, commit
`4a080252f06caf63a525d7873c5d94d3c23887e0`.
The upstream [MIT license](LICENSE) and Mario Zechner attribution are preserved.

## Retained improvements

- Large local text reads retain a bounded prefix while scanning for exact line and byte totals. Regular files at least 256 KiB with supported integer ranges use the optimized path; custom backends, images and unsupported inputs retain the existing paths. Reads still scan the file. This reduces client allocation, not model input bytes.
- Grep context reads stream requested line windows and retain capped prefixes, preserving upstream LF line numbering and CR sanitization. Custom backends retain their full-read path.
- `PI_CONTEXT_RESULT_REFERENCES=1`, set before launch, enables request-local references for eligible identical read and grep results. Calls still execute; stored originals remain full. A surviving first result stays full after compaction or branching. `force=true` resends full text. Directory and limited grep references describe only the exact observed tool result, including limits and notices; they make no assertion about unobserved files. Changed arguments, identity, text or material metadata prevent reuse. Unsupported metadata falls back to full text.
- The interactive footer shows the loaded build version and reference state. `/version` reports loaded version, custom-build status, optional source revision and PID locally, without a model turn or history entry. SDK consumers can read frozen `RUNTIME_IDENTITY`; changing an installation selector cannot change the identity already loaded in a process.

The accepted `.1`–`.5` improvements originated in reviewed source
`e9e123e40b98cf7aa9afa6e4dd2c268832b7cefe`, then were rebased onto the upstream
commit above. One integration adjustment preserves upstream's fix for lone CR:
LF alone advances ripgrep line numbers; CR is removed before retaining capped
rendered text. CRLF across chunks, Unicode, truncation and custom backends are
covered. The `.6` follow-up corrected TypeBox's optional `force` input typing;
the disabled wire schema still omits that property. Full check, fresh build and
388 selected local cases passed for `.6`, superseding the earlier source-only
build limitation. These local checks do not constitute the entire upstream suite.
Private study history, installation paths, credentials and conversations are not
part of this public source tree.

## Optional changed-file projection

`PI_CONTEXT_READ_DELTAS=1` additionally enables a bounded changed-file projection
when references are enabled. Both source options are **off unless explicitly
selected**. This is a distinct policy from executing or caching filesystem reads:
every tool call still runs, and durable tool results stay complete.

For an eligible changed, complete local text read, the outgoing result can contain
one JSON line-splice operation instead of a second full copy. The exact full base
must already occur earlier in the **same outgoing history**. The note names its
snapshot, path, entire-file range, observation order, base/current SHA256, and
application rules. For example, `{"startLine":12,"deleteLineCount":1,"insertText":"new line\n"}`
replaces base line 12 including its old ending with the decoded JSON text.
Unchanged lines remain from that full base. The implementation parses its emitted
operation and verifies exact reconstruction before use. Deltas never become bases
for more deltas or anchors for unchanged references. A reverted file can reference
its retained full original. `force=true` requests the full current result.

Initial support excludes explicit offset/limit ranges, truncated results, images,
errors, binary/control or replacement-character text, custom backends without the
builtin snapshot marker, and material result metadata. Missing or evicted bases,
compaction, ambiguous identity and unprofitable edits fall back to full text. Each
input is at most 50 KiB / 2,000 lines; attempted base+current work is capped at
512 KiB per projection, alongside the existing 32-entry / 1 MiB result cache.
A linear common-prefix/suffix scan emits one splice; there is no quadratic diff or
unbounded chain. The complete escaped JSON text must save at least 20% plus 512
bytes against current text before projection. Widely separated changes can make
the single splice too large and therefore trigger fallback.

The tests establish byte reconstruction and local serialized request savings,
not equivalent model reasoning, billed tokens, provider cache behavior, GPU work
or inference latency. Compaction and branch summaries restore original tool text before applying their
existing per-result summary limit, so truncation cannot leave a delta referring to
a cut-off base. Summary serialization matches raw history under the same limit;
this may use more bytes than an unsafe reference-only summary.

A model may need `force=true` to inspect the current text
in full. Keep this separate opt-in off when that tradeoff is unsuitable. The
footer adds `deltas on` only when both launch options are enabled.

## Local control integration

`local/pi-task-extension.ts` is the separately maintained control extension. With
its normal `PI_TASK_DIR` state it records loaded SDK version/source, PID, Linux
start ticks, boot ID and conversation ID in an existing atomic snapshot. Without
that environment it is inactive. No new heartbeat/provider polling is added.

`local/pi-task-runtime.patch` is the exact reviewed delta for a separate wrapper
whose base SHA256 is `aeafabf16c8cdfa75a82dd0f0cf1176f280bcc519f6305e54a2634213fb5e3b2`.
It is not a complete wrapper/installer. Obtain a matching base and run
`git apply --check` before applying. Status validates live PID/start/boot/session
ownership; stopped, stale, mismatched and legacy receipts report unknown.
Every new launch resolves the selected release and its extension, honoring explicit
overrides. Local receipts are not a hostile same-user security boundary. No forced
restart, process-title change or provider call is needed for identity reporting.

Package metadata remains upstream `1.4.0`; local iteration labels are assigned by
the packager. `piEfficiencyStudy.sourceCommit` records immutable build provenance.
Missing source metadata is reported as unknown. This branch is source publication,
not an npm release. Existing active processes keep their loaded build until a safe
normal restart; source publication alone does not install it.

## Build and focused checks

Use Node.js 22.19 or newer and the upstream development workflow:

```bash
npm ci --ignore-scripts
npm run build
npm run check
node --test scripts/pi-efficiency/focused.test.mjs scripts/pi-efficiency/read-deltas.test.mjs
# With model metadata already hydrated:
npm run build:offline
# Local serializer-only fixture; no provider traffic:
PI_CONTEXT_RESULT_REFERENCES=1 node --import ./packages/coding-agent/src/experimental/source-resolver.ts scripts/pi-efficiency/read-deltas-wire.mjs
# Optional source launch, using your own provider setup:
PI_CONTEXT_RESULT_REFERENCES=1 PI_CONTEXT_READ_DELTAS=1 ./pi-test.sh
```

Synthetic checks cover read/grep equivalence and cancellation, exact-repeat anchors,
metadata validation, changed-read reconstruction, successive edits, reverts,
insertions/deletions, CRLF/Unicode/final-newline behavior, compaction, forced-full,
eviction and work bounds. The serializer fixture records actual normalized request
bytes and local costs using an in-memory response; it makes no model/network calls.
Installation-specific bundle, wrapper, rollback and process-identity checks remain
separate local release gates. Unique or short outputs can receive reference-marker
overhead; no universal token or end-to-end speed improvement is claimed.
