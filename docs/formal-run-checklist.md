# Formal experiment run checklist

**Status** · Run checklist for formal protocol V1.

## Before collection

- Confirm the checkout matches the frozen formal protocol, schedule, and
  archived initial manifest.
- Record the collection commit SHA, the clean checkout state, the host and Node
  versions, the Docker and Compose versions, and the stable and candidate
  build identities. Use the same approved configuration for both arms.
- Confirm the host clock is synchronized and the runner can publish raw wall
  and monotonic clock readings. Review the starting conditions in the
  [pilot protocol](paired-experiment-protocol.md#reset-and-pilot-acceptance).
- Verify that the runtime Nginx configuration points to the stable app, both
  deployment ownership IDs are clear, and the candidate fault flag is absent.
  Expect HTTP 200 from stable `1.0.0` through Nginx, one running instance of
  each routing-profile service, and healthy `db`, `app`, and `candidate`
  containers. Verify candidate `2.0.0` at promotion.
- Keep the formal manifest, append-only JSONL audit log, immutable V1
  attempt records, and run notes under the formal results directory.
  Start the working manifest from the [archived initial manifest](formal-paired-trial-initial-manifest.json).
  Make the initial copy in the formal results directory before the first
  attempt. If a working manifest already exists, verify it and continue
  using it. Append retry rounds and dispositions only in the working copy.

## Assign order and reserve IDs

- Use the [frozen schedule](formal-paired-trial-schedule.json)
  for 12 evaluable pairs in six blocks with one AB and one BA pair each.
  Preserve its seed and generated order with the execution records.
- Use the [schema v2 manifest](formal-pair-summary.md#execution-manifest). The
  order of `pairs` gives the planned pair sequence. Match every schedule
  `pair_id` to its manifest `pair_id`, `planned_order` to `assigned_order`, and
  the one-based `sequence` to its position in the manifest's `pairs` array.
  Keep `block` in the schedule. Each `round_id` has exactly two `attempts` in
  the assigned arm order, each with a globally unique `trial_id`.
- Run the [schedule and manifest check](formal-paired-trial-protocol.md#reproduce-the-schedule-and-check-the-manifest)
  before collection. Preserve its output with the reviewed schedule and
  initial manifest.
- Reserve both trial IDs before starting a round. Append whole-pair retries as
  fresh rounds for the same pair with the original AB or BA order. Keep the
  original schedule and prior round assignments. Use new IDs for both arms.
- For a separate `--preflight-only` invocation, use a disposable ID. That
  command reserves a staging directory. Each formal attempt runs its own
  preflight as part of the normal invocation.

## Append to the execution audit log

- Use `experiments/results/formal-attempt-audit.jsonl`. Follow the
  [protocol's audit fields](formal-paired-trial-protocol.md#attempts-and-evidence)
  for identity, actual arm position, retry linkage, Git and environment
  provenance, and evidence paths. Use the manifest round's one-based index
  for `pair_attempt` and the prior round ID in `rerun_of` for retries.
- Append one JSON object with `record_type: "start"` before running an
  attempt and one with `record_type: "outcome"` after evidence review. Use
  the same `trial_id` and include the immutable `record_path` in the outcome
  when available. Copy validity, cutoff outcome, and recovery timing from
  V1. Use `null` for unavailable evidence fields. Keep earlier log lines.

Prepare each record as a JSON object in `audit_record_file` and set
`attempt_audit_log` to the JSONL path above. Append the object as one line.

```bash
python3 -c 'import json, sys; row = json.load(sys.stdin); assert isinstance(row, dict); print(json.dumps(row))' \
  < "$audit_record_file" >> "$attempt_audit_log"
```

## Run and record each attempt

1. Set the shell variables `pair_id`, `arm`, and `trial_id` from the current
   manifest slot. Append its audit start record, then start the assigned
   attempt from the repository root.

   ```bash
   node tools/experiments/run-paired-pilot.mjs --arm "$arm" --trial-id "$trial_id"
   ```

2. Let the runner perform preflight, promote the candidate, then start the
   monitor and Driver V1. Both arms use 5 requests/s for 60 s with 5 s warm-up
   and a 3,000 ms request timeout. Arm A begins rollback after fresh failure
   confirmation. Arm B uses the scripted 10 s delay and a fresh confirmation.
   Preserve the recorded fault activation bracket and acknowledgment around
   the 15 s target.
3. Wait for the runner to exit. Review the cleanup and reset evidence in
   `trial.json` and the event log. Record every published attempt bundle
   regardless of the runner's exit code. The recorder reads the bundle and
   writes the V1 classification and artifact digests.

   ```bash
   node tools/experiments/record-formal-attempt.mjs \
     --pair-id "$pair_id" --arm "$arm" "experiments/results/$trial_id"
   ```

4. Save the returned `record_path` in the audit outcome record after reviewing the
   evidence. Check the immutable record's
   pair ID, arm, trial ID and `classification`. V1 reports validity, workload
   usability, clock integrity, probe usability, cutoff outcome, and recovery
   evidence. The cutoff is 60 s after workload start. Verification must
   precede it to count as in-window. If recording fails, retain the bundle
   and retry recording with the same identifiers after resolving the error.
   A recorder conflict or a trial still in `.staging` needs review before
   proceeding.
5. Before the next arm, confirm reset and starting conditions. If reset
   failed, pause until the environment is reconciled and the starting checks
   pass. Use V1 to assess the completed attempt's technical validity. For a
   planned pause, record the interruption, verify the approved build and
   starting conditions, then resume at the next assigned slot.

## Handle interruptions and retries

- Preserve available evidence and document the interruption. For an attempt
  with a published bundle, use its V1 assessment. If an assigned slot was
  skipped or an interrupted attempt has no publishable bundle, record the
  [manifest disposition](formal-pair-summary.md#execution-manifest) with
  `status` and a nonempty `reason`. Keep the reserved trial ID. Append an
  audit outcome for any started attempt and link the evidence that survived.
- When V1 marks either attempt technically invalid, the round is ineligible.
  Preserve the recorded attempts and any documented disposition, then run
  both arms in a new round in the original assigned order.
- Keep technically valid attempts with an `unknown` cutoff or a verified
  late recovery eligible. Review evidence conflicts and later rounds
  recorded after a valid round before making any further retry decision.

## Review each pair

Run the summary with the saved manifest path in `manifest_file`.

```bash
node tools/experiments/summarize-formal-pairs.mjs \
  "$manifest_file" experiments/results/formal-attempts
```

- Check the status, `selected_round_id`, and the two selected trial IDs. A
  complete pair has two technically valid attempts from the same round.
  Earlier missing records or conflicting assignments can leave selection
  unresolved. Review the flags against the evidence history.
- Confirm that all assigned slots and recorded attempts are accounted for.
  Save review outputs outside the attempt-record directory so it holds only
  the immutable attempt records.

## Close collection

- Account for all 12 complete pairs and verify one AB and one BA pair in
  each block. Review outstanding flags and document protocol deviations.
- Report one V1 cutoff outcome per selected attempt at the 60 s boundary.
  Report `verified_late` as a supplemental count within `unknown` for attempts
  whose recovery was verified at or after the cutoff. The complete-pair
  denominator already includes these attempts.
- Follow the predefined workload analysis for the scheduled window
  `[15,000, 60,000)` ms. Report dispatched-request failures and rates, record
  missed dispatches separately, and retain the actual fault offsets and
  available recovery timing evidence.
- Report attrition separately, including invalid attempts, unselected
  rounds, and any shortfall from 12 complete pairs. Report observed
  experimental outcomes from technically incomplete pairs separately from
  the complete-pair analysis.
- Archive the raw bundles, manifest and its initial schedule, immutable
  attempt records, append-only audit log, incident notes, and final analysis
  outputs.
