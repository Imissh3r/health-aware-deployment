# Formal paired rollback experiment protocol

**Status** · Frozen V1. The collection commit pins this protocol, the frozen
schedule, and the archived initial execution manifest.

## Question and scope

Compare automatic rollback (Arm A) with scripted operator-delay rollback (Arm B) under the same candidate-only HTTP 500 fault and workload. Arm B uses the configured 10,000 ms delay, then reacquires the routing lock and reconfirms degradation before attempting rollback. Record the actual confirmation-to-rollback interval. The scripted delay models a response interval and does not measure real operator behavior.

Target 12 evaluable pairs. Each consists of two technically valid attempts
from the same round. This is a practical collection target for descriptive
analysis. Total attempts can exceed 24. Keep the original pilot pair separate
and use it to check the analysis tool.

## Schedule and run conditions

- Follow [the frozen schedule](formal-paired-trial-schedule.json) in
  sequence. Each of the six blocks includes one AB pair and one BA pair.
  AB means run A first and BA means run B first. Preserve the saved seed and
  generation method. Use the [archived initial manifest](formal-paired-trial-initial-manifest.json)
  as the starting point for the working execution manifest. Preserve the
  assigned order for every replacement round.
- Use the same clean Git commit, host setup, application versions, container image IDs and configuration throughout formal collection. Record the actual run commit and environment identifiers. Verify stable `1.0.0` through Nginx, an absent candidate fault flag, clear active and pending deployment IDs, and healthy required services before every run. Promote and verify candidate `2.0.0` before starting the workload.
- Use Driver V1 with 5 requests/s for 60 s, a 5 s warm-up, a 3,000 ms timeout, maximum concurrency 50, and maximum lateness 200 ms. Send requests through Nginx to `http://127.0.0.1:8080/api/work`. Target fault activation at 15 s using the same injection mechanism. Record both ends of the fault-write bracket and use the recorded acknowledgment for recovery timing.
- Repeat the same reset and integrity checks before the next run. Document any settling period and apply it consistently. If a run leaves the deployment unresolved, archive its evidence before any manual restore, record that intervention, and verify the reset before continuing.

### Reproduce the schedule and check the manifest

From the repository root, run this read-only check against the archived
initial manifest and save its output with the execution records. The schedule
retains the block metadata. The archive preserves the manifest exactly as
generated for review, including its original `proposed` status.

```bash
python3 - docs/formal-paired-trial-schedule.json docs/formal-paired-trial-initial-manifest.json <<'PY'
import hashlib
import json
import sys
from pathlib import Path

schedule, manifest = (json.loads(Path(name).read_text()) for name in sys.argv[1:])
assert schedule["status"] == "frozen"
assert schedule["schedule_id"] == manifest["schedule_id"]
assert schedule["generator"]["algorithm"] == "sha256-first-byte-low-bit-v1"
seed = bytes.fromhex(schedule["seed_hex"])
generated = []
for block in range(1, 7):
    bit = hashlib.sha256(seed + bytes([block])).digest()[0] & 1
    orders = ("AB", "BA") if bit == 0 else ("BA", "AB")
    generated.extend((block, order) for order in orders)
assert generated == [(p["block"], p["planned_order"]) for p in schedule["pairs"]]
assert schedule["target_evaluable_pairs"] == 12
assert manifest["schema_version"] == 2
assert len(manifest["pairs"]) == len(schedule["pairs"]) == 12
trial_ids = set()
pair_ids = set()
for sequence, (planned, pair) in enumerate(zip(schedule["pairs"], manifest["pairs"]), start=1):
    assert planned["sequence"] == sequence, planned["pair_id"]
    assert pair["pair_id"] == planned["pair_id"] and pair["pair_id"] not in pair_ids
    pair_ids.add(pair["pair_id"])
    assert pair["assigned_order"] == planned["planned_order"], pair["pair_id"]
    assert planned["arms"] == list(planned["planned_order"]), pair["pair_id"]
    assert len(pair["rounds"]) == 1, pair["pair_id"]
    round_ids = set()
    for round_entry in pair["rounds"]:
        assert round_entry["round_id"] and round_entry["round_id"] not in round_ids
        round_ids.add(round_entry["round_id"])
        assert [slot["arm"] for slot in round_entry["attempts"]] == planned["arms"]
        for slot in round_entry["attempts"]:
            assert "disposition" not in slot, slot["trial_id"]
            assert slot["trial_id"] and slot["trial_id"] not in trial_ids
            trial_ids.add(slot["trial_id"])
    print(f"{sequence:02d} {pair['pair_id']} block={planned['block']} order={pair['assigned_order']}")
print(f"Verified six balanced blocks, 12 manifest pairs, and {len(trial_ids)} unique trial IDs.")
PY
```

## Observation boundary and classification

Time zero is `wall_start_ms` in Driver V1's `run.json`. The exclusive recovery cutoff is `wall_start_ms + 60_000`. Verified recovery requires the controller's successful verification of three consecutive HTTP 200 responses from stable `1.0.0` through Nginx. A verification timestamp must be strictly earlier than the cutoff to count. Preserve late recovery timestamps as separate evidence.

Use the immutable V1 attempt record for technical validity and cutoff outcome.
V1 checks setup, fault acknowledgment, and workload usability for technical
validity. It reports clock integrity and probe usability separately. For the
cutoff outcome, use these V1 categories.

| Cutoff outcome | Evidence required |
|---|---|
| `recovered_in_window` | A valid attempt with verified recovery strictly before cutoff and usable clock evidence. |
| `not_recovered_by_cutoff` | A valid attempt with usable timing evidence, a qualified terminal `ROLLBACK_FAILED` record, cleanup deferred through cutoff, and an eligible near-cutoff HTTP 500 probe from candidate `2.0.0`. |
| `unknown` | V1 cannot establish either outcome. For example, the clock trace or probe may be unusable, or verification may occur at or after cutoff. |

Clock integrity requires samples bracketing workload start and cleanup start,
wall-minus-monotonic divergence of at most 20 ms, and adjacent gaps of at most
1,000 ms. A qualifying probe starts at or after cutoff, completes within
200 ms of cutoff, and completes by cleanup start. V1 checks interruptions and
evidence consistency against the stored bundle.

Preserve the raw runner status separately from V1's assessments. A failed
post-run reset holds the next arm until reconciliation and starting checks.
Use the completed attempt's V1 validity when assessing its eligibility.

## Attempts and evidence

Keep each trial's original evidence in its own directory. Preserve driver CSV and metadata, events, controller log, promotion and deployment state, runner output, and relevant reset information. Record the evidence path even for attempts that only produced partial evidence.

Keep three records. The schedule and manifest define the planned execution.
The operator's append-only JSONL attempt log records actual execution and
incidents. The recorder publishes the immutable V1 evidence digests and
assessments. Append a start record before invoking the runner and an outcome
record after evidence review. Keep earlier records when appending follow-up
information. Give both arms in a round the same `pair_id`, `round_id`, and
`pair_attempt` number. Use a fresh `trial_id` for every run.

| Fields | Meaning |
|---|---|
| `record_type`, `logged_at`, `trial_id` | Start or outcome, record timestamp, and unique run identifier |
| `schedule_id`, `pair_id`, `round_id`, `pair_attempt`, `arm`, `planned_order`, `actual_position`, `rerun_of` | Schedule and manifest identity, one-based round position in the manifest, actual arm position (1 or 2), and the superseded round ID for a rerun |
| `git_commit`, `working_tree`, `environment_id`, `evidence_directory` | Code, environment and evidence provenance |
| `driver_started_ms`, `fault_acknowledged_ms`, `cutoff_ms`, `observed_through_ms` | Observed times and cutoff, with null for unavailable observations |
| `runner_status`, `validity`, `recovery_status`, `recovery_timing`, `verified_at_ms`, `recovery_time_ms`, `invalid_reason`, `record_path` | Raw runner status, V1 validity, cutoff outcome and recovery timing, supporting times and validity reasons, and the immutable record path when available |

Use JSON `null` for unavailable fields. Copy `validity` from
`classification.attemptValidity.status`, `recovery_status` from
`classification.cutoffOutcome.status`, and `recovery_timing` from
`classification.recoveryEvidence.timing`. Use `observed_through_ms` only when
the evidence establishes that time. For in-window recovery, use the V1
verification timestamp minus fault acknowledgment as `recovery_time_ms`.
For an interrupted attempt without a bundle, append an outcome describing
the incident, preserve the available evidence, and record its v2 manifest
disposition. For a planned slot that did not run, retain its reserved ID and
disposition.

If either arm is technically invalid, retain the entire round and rerun the
pair in its original order with fresh IDs for both arms. Select the first
round in manifest order with two technically valid arms. Valid unknown,
verified late, and non-recovery outcomes remain eligible. Report attrition
and observed outcomes from technically incomplete pairs and unselected
rounds separately. If the environment cannot be restored reliably, pause
collection and report any shortfall from the target.

## Analysis and reporting

- HTTP error rate uses requests scheduled in `[15_000, 60_000)` ms after
  driver start. Divide the count of `http_error` outcomes by the count of
  dispatched requests (scheduled requests minus `missed`). Report misses
  separately. A zero dispatched count gives an undefined rate. Derive this
  metric for usable traces even when recovery was not verified.
- Report per-arm in-window recovery counts and rates for the evaluable paired
  dataset, and the counts of non-recovery and unknown cutoff outcomes. Each
  selected attempt contributes one cutoff outcome. Show verified late
  recoveries as a supplemental subset of `unknown` within the same
  denominator. Report how many evaluable pairs provide two in-window
  recoveries for the recovery-time comparison.
- For each selected round, compute B − A HTTP error-rate differences in
  percentage points when both rates are defined. Compute B − A recovery-time
  differences in milliseconds only when both arms verified recovery in-window.
  Within each arm, subtract fault acknowledgment from the verification
  timestamp. Positive differences mean B had a higher rate or took longer.
- Show the individual differences. For each metric, report its contributing
  pair count, median, Q1, Q3 and IQR (Q3 minus Q1). Sort the defined differences
  and compute the 25th, 50th and 75th percentiles by linearly interpolating at
  zero-based index `(n - 1) × p`, where `n` is the contributing pair count and
  `p` is 0.25, 0.50 or 0.75. With one pair, all three percentiles equal its
  difference and IQR is zero. With zero pairs, all four statistics are null.
- As secondary measures, report per-attempt p50 and p95 latency in
  milliseconds and the number of `ok` requests scheduled in
  `[15_000, 60_000)` ms for each selected attempt. Sort its successful request
  latencies and use the nearest rank `ceil(p × n)` (one-based). With no
  successful requests, report a count of zero and null percentiles.
- Interpret conditional recovery times alongside recovery frequency and
  describe the limits of a single host, one injected fault scenario and the
  scripted operator policy.
- Use the v2 summary for round selection and cutoff counts. The strict
  analyzer remains suitable for pairs it can verify. Derive the formal HTTP
  measures from usable Driver V1 traces in all selected rounds, including
  non-recovery and unknown outcomes. Leave unobserved recovery times null.
  The formal HTTP report identifies the expanded output with
  `schema_version: 2`.

## Readiness checks before collection

The runner records the cutoff and cleanup boundary, raw clock samples, the
near-cutoff probe when applicable, and reasons for missing observations.
Use the [run checklist](formal-run-checklist.md) to verify the approved
checkout, rehearse the append-only log and evidence recording, and match the
saved schedule to its initial manifest. Verify the workload analysis for
usable traces from recovered, non-recovered, and unknown attempts.

Record the SHA of the clean collection commit with the execution records.
Complete the live preflight in the [run checklist](formal-run-checklist.md)
before running any formal pair.
