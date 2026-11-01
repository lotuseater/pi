# Pi coordination traffic experiment — 1 November 2026

## Decision

Adopt `pi-task wait-many` as an optional system-wide local observer for independent
worker groups. Use existing local build waits, changed-file commands and test
reports without asking a model for routine status. Do not change every Pi
session's prompt or tool schema. No session restart is needed.

The useful improvement is eliminating coordinator model turns between individual
waits. Summarizing results contributes very little once worker traffic is counted.
An already-batched Bash call achieves almost all the measured saving.

## Experiment

Eight most-recently-modified, completed, nonempty last-message worker runs were
frozen from the local session store, preserving identities, sequence numbers,
source hashes and log hashes. Selection did not depend on potential savings.
Eight saved real Pi parent contexts supplied different context sizes. The same
worker cohort is reused in each parent-context scenario; these are not 64
independent workers.

The collector read frozen files without changing their contents and made zero
model invocations. Replay reconstructed every recorded assistant boundary within
each selected worker run. All **221 worker responses** were included once per
scenario in every variant. A mismatch fails the benchmark. A regression fixture
ensures a preceding run's response two milliseconds before the start is excluded.

Request bodies were serialized by the fork's actual OpenAI-completions adapter
with a stubbed transport, seven fixed tools and reference projection enabled.
Unexpected external fetches fail. No historical command or active session was
executed, stopped or resumed. Qwen was unavailable, so no live model A/B test was
performed.

Four scripted coordinator policies use the same context and worker results:

1. `individual-full`: initial request, then one request after each of eight waits.
2. `batched-full`: initial request, then all full results in one local Bash return.
3. `grouped-compact`: initial request, then bounded structured `wait-many` results.
4. `grouped-read-all`: grouped collection, followed by another request containing
   the entire full artifact when the compact result is insufficient.

## Results

Average serialized request-body bytes per scenario, in decimal MB. Worker traffic
is **94.882 MB and 221 requests** in every row. Request counts include the parent.

| Policy | Parent MB | Parent + worker MB | Total requests |
| --- | ---: | ---: | ---: |
| Individual full results | 3.353 | 98.235 | 230 |
| Already-batched full results | 0.742 | 95.624 | 223 |
| Grouped compact results | 0.734 | 95.616 | 223 |
| Grouped, then retrieve everything | 1.199 | 96.081 | 224 |

Grouped compact versus individual waits saved **78.10% of parent request bytes**,
**2.665% of total parent-plus-worker bytes**, and **7/230 = 3.043% of all requests**.
Across the eight parent contexts, total byte savings ranged from **1.464% to
3.601%**. These figures use the ratio of summed bytes, not an unweighted average
of percentages.

Against the stronger already-batched baseline, grouped compact saved only
**0.007864% of total bytes**, with no request reduction. Reading the full artifact
afterwards increased total bytes by **0.478%** against that baseline. Choose full
results directly when the decision is likely to need them; do not trade evidence
quality for a small context saving.

Recorded worker usage was 34,630,380 input and 203,907 output tokens, total
34,834,287. These are existing provider-reported counts, not newly billed replay
tokens. Cache treatment is unspecified in these historical controller records.
All workers count, including intermediate responses; unknown counts stay unknown.

## Local cost and validation

The eight-worker collection took 0.136 seconds in-process. Including startup,
the capped job took 0.8 seconds: process max RSS 49.9 MiB, cgroup peak 70.9 MiB,
anonymous peak 40.7 MiB, file cache at completion 26.4 MiB. Replay took 2.5 seconds:
process max RSS 232.0 MiB, cgroup peak 247.4 MiB, anonymous peak 174.4 MiB,
file cache at completion 67.6 MiB. File cache is reclaimable. The PC had concurrent
work, so these timings are observations rather than quiet-machine speed claims.

Validation passed: 19 controller tests, 3 serialization/accounting tests, the
eight-context real replay, and full `npm run check`. Tests cover identities,
message freezing, concurrency, failure/timeout/cancellation, empty answers,
private artifacts, overwrite races, unknown usage and the existing single wait.
Full checks took 13.3 seconds under a 4 GiB cap, with process max RSS 3,257.6 MiB,
cgroup peak 3,399.6 MiB, anonymous peak 3,163.2 MiB and ending file cache 129.0 MiB.

The controller is an extension of existing Python code; replay uses the existing
JavaScript benchmark infrastructure. No new runtime dependency was introduced.

## Limits and development cost

This is an offline traffic replay using real task histories and scripted
coordination policies. It does not measure live tokens per minute, compressed
network bytes, task quality, model choice frequency, provider retries or the
prevalence of unnecessary polling. Historical tool registries and settings are
not completely reconstructable. Compaction-generation requests absent from the
saved assistant events cannot be counted. No saving from shorter worker briefs
is claimed; worker work is held fixed.

One implementation worker consumed 1,659,875 input tokens (1,556,608 reported as
cached) and 23,120 output tokens, total 1,682,995, across implementation and review
fixes. That is development overhead, separate from the steady-state comparison.
Parent development usage was not measured per task; therefore neither total
development cost nor break-even is claimed. Offline replay itself used no paid
provider requests.

## Provenance

Base fork commit: `dcd2b53452d16a0be6a09bb1ed193234e5dae522` on
`lotuseater/pi`, branch `codex/pi-efficiency`. Baseline system controller SHA-256:
`b69d9b913f6171e98dc64cb53f261be4330a23e9e699f071d6245b63db4d534c`.

Reproduction commands and behavioral details are in [PI-COORDINATION.md](PI-COORDINATION.md).
Private frozen inputs and raw replies are retained locally with the Documents
report and are excluded from the public fork. Public aggregate evidence contains
source hashes and measurements, without source paths or task text.
