# Pi efficiency fork

This independent fork builds on [earendil-works/pi](https://github.com/earendil-works/pi),
fresh upstream `main` commit `908aa7b74baa7502321293797313f64c6fec22ee`.
The original study baseline was tag `v1.4.0`, commit
`4a080252f06caf63a525d7873c5d94d3c23887e0`.
The upstream [MIT license](LICENSE) and Mario Zechner attribution are preserved.

## Implemented source changes

- Large local text reads retain a bounded prefix while scanning for exact line and byte totals. The optimized path applies to regular files at least 256 KiB with supported integer ranges; custom backends, images and other inputs retain the existing paths. Reads still scan the file, and files above Node's existing size bound retain its fallback behavior.
- Grep context reads stream requested line windows and cap retained line prefixes, preserving upstream LF line numbering and CR sanitization. Custom backends retain their full-read path.
- `PI_CONTEXT_RESULT_REFERENCES=1`, set before launch, enables request-local references for eligible identical read and grep outputs. It is off by default. Calls still execute; stored originals remain full. A surviving first result stays full after history compaction or branching. `force=true` resends full text when enabled.
- Directory and limited grep references describe only the exact observed tool result, including limits and notices. They make no assertion about unobserved files. Changed arguments, identity, text or material metadata prevent reuse. Unsupported metadata falls back to full text.
- The interactive footer shows the configured build version and whether references are on.

## Provenance and limits

The accepted `.1`–`.5` improvements originate in reviewed source
`e9e123e40b98cf7aa9afa6e4dd2c268832b7cefe`. The public improvement line has now
been rebased onto upstream `main` at
`908aa7b74baa7502321293797313f64c6fec22ee`, preserving public documentation,
checks, attribution and the local control-extension source. Private local study
history, reports, deployment paths and session data remain excluded.

One integration conflict required a behavior adjustment: upstream fixed grep
context so a lone CR does not advance ripgrep's LF-based line number. The bounded
helper now splits on LF and removes CR before retaining capped text, matching
upstream's renderer. CRLF across stream chunks, lone CR, Unicode and truncation
remain covered by focused checks. Custom backends follow upstream's full-read
path. Historical allocation and request-byte measurements describe the earlier
accepted builds; no new performance claim is made for this rebase. Installed
local `.5` is preserved unchanged; this update publishes source only.

Package metadata remains upstream `1.4.0`; the locally assigned `.5` label is not
the package version in this source checkout. `/version` reports the version and
optional source revision recorded in the package actually loaded at startup.
A packager can set `piEfficiencyStudy.sourceCommit` when preparing build metadata;
missing source metadata is reported as unknown. This is a source publication,
not an npm or binary release.

## Running-build identity

`/version` is a local command: it displays loaded version, custom-build status,
source revision when available, and PID without a model turn or history entry.
SDK consumers can read frozen `RUNTIME_IDENTITY`. Changing an installation selector
does not change that identity in an already running process. The existing footer
continues to show the loaded package version and reference-feature state.

`local/pi-task-extension.ts` is the separately maintained control extension used
for process receipts. When launched with its normal `PI_TASK_DIR` control state,
it records loaded SDK version/source plus PID, Linux start ticks, boot ID and
conversation ID in its existing atomic snapshot; without that environment it is
inactive. No new heartbeat or provider polling is added.

The optional `local/pi-task-runtime.patch` is the exact reviewed delta for a
separate local pi-task wrapper whose base SHA256 is
`aeafabf16c8cdfa75a82dd0f0cf1176f280bcc519f6305e54a2634213fb5e3b2`.
It is not a complete wrapper or an installer. Check the exact base and
`git apply --check` before applying it to a separately obtained matching wrapper.
Its `pi-task status` validates live PID/start/boot/conversation/ownership before
reporting the running version; legacy, stopped, stale or mismatched receipts
report unknown. The wrapper selects the immutable release's extension on each
new launch, honoring explicit extension overrides. Operational receipts trust
local code and are not a hostile same-user security boundary. No process-title
change, forced restart, provider call or global configuration change is required.

The independent local release review covered SDK/bundle mapping, actual RPC
same-conversation A/B selector swaps, missing/stale/PID identity failures,
CLI/footer behavior, wrapper transactions and reversible installation. Those
installation-specific fixtures are not included in this public source tree.
Rebase validation passed 35 dependency-free public checks, 65 source read/grep
comparisons against fresh upstream, 17 projection/history/metadata cases and five
process-identity cases (122 cases total). Source CLI/SDK/pi-task tests also passed:
local `/version`, native session save/resume, provider/model controls, and a
same-conversation restart with PID/start/boot receipts, without model traffic.
The public command below runs the 35 helper checks; the installation-specific
source integration fixtures remain separate. Two obsolete legacy tests were
excluded: the earlier directory-bypass contract and an old built-bundle fixture.

The pinned dependency install was attempted with scripts disabled and timed out
(`ETIMEDOUT`); an offline tool-cache attempt also lacked TypeScript. Full check
stops at missing Biome and the offline build at missing `tsc`. These are setup
limits, not passing lint/type/build results. Pinned-dependency and entry-graph
checks plus Node syntax checks of 12 changed TypeScript files passed.
Runtime smoke used copied external dependencies and cached model data from the
accepted build; every internal Pi package resolved to the rebased source. It
validates source mode, not a newly built bundle or a regenerated model catalog.
Installed `.5`, its settings/history and active sessions were left unchanged.

The dependency-free checks below cover the retained streaming/reference helpers;
they do not replace full runtime or wrapper integration tests.

References can increase request bytes for unique or short outputs. Savings depend
on repeated eligible results in the same request. No general token, provider latency,
model quality or end-to-end speed improvement is claimed. The focused checks below
do not establish full CLI, provider serialization, migration or deployment equivalence.

## Build and run from source

Use Node.js 22.19 or newer. The upstream README's installation commands install
upstream releases. To use this checkout, follow its development workflow:

```bash
npm ci --ignore-scripts
npm run build
./pi-test.sh --no-env --help
# Enable references at process launch, when ready to run with your own provider setup:
PI_CONTEXT_RESULT_REFERENCES=1 ./pi-test.sh
```

`npm run build` refreshes upstream model data and builds the workspace. If model
data is already hydrated, `npm run build:offline` avoids that refresh. These commands
were inspected in README/package scripts; a fresh dependency install and full build
were not run during publication preparation. No global install is needed for source use.

## Focused synthetic checks

Run from this repository root; no npm dependencies, credentials or provider calls:

```bash
node --test scripts/pi-efficiency/focused.test.mjs
```

These compare bounded-read output and metadata with full-file truncation, compare
grep windows with normalized full-file lines, and exercise cancellation, references,
history anchors, metadata validation and fallbacks. Fixtures are created in a unique
temporary directory and only that owned directory is removed. They adapt the safe,
standalone portions of local JavaScript probes to the existing Node/TypeScript tooling.
