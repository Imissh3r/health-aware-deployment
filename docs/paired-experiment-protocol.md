# Paired pilot protocol for automatic and scripted operator-delay rollback

**Status** · Draft v0.2 for procedure validation. Repeated trials for the
dissertation follow the pilot.

## Research question

Under the same client workload, runtime fault, and recovery criteria, how
do client-visible failures and time to verified recovery change when a
degraded, already-promoted candidate is rolled back immediately or after a
scripted operator delay?

## Conditions

| Arm | Condition | Action after the first fresh failure confirmation |
|---|---|---|
| A | Automatic rollback | Start rollback immediately while holding the routing lock. |
| B | Scripted operator-delay baseline | Release the lock and wait 10 s. Reacquire the lock, recheck ownership, and make a fresh bounded failure probe before starting the same rollback procedure. |
| B(0) | Optional zero-delay control | Exercise the baseline entry point once with a delay of 0 s if it differs from A. Otherwise count the extra run as a repeat of A. |

The 10 s delay models an assumed operator response time. Measure the actual
interval from the first fresh failure confirmation to rollback start. In arm B,
that interval includes the wait, lock reacquisition, and the second confirmation.
If the subsequent check finds a different owner or the fault no longer qualifies,
record the result and stop the planned rollback attempt.

## Fixed pilot configuration

| Item | Value |
|---|---|
| Workload endpoint | `http://127.0.0.1:8080/api/work` through Nginx |
| Driver | Frozen Experiment Driver V1 |
| Request rate | 5 requests/s |
| Total duration | 60 s, with the first 5 s flagged as warm-up |
| Request timeout | 3,000 ms |
| Versions | Stable `1.0.0`, candidate `2.0.0` |
| State at driver start | Candidate already promoted and verified through Nginx |
| Fault | Candidate-only runtime flag makes `/api/work` return HTTP 500 with the candidate version |
| Fault timing | Target 15 s after driver start and record the observed offset |
| Detection rule | Three consecutive HTTP 500 probes identifying the expected candidate version, followed by a fresh bounded confirmation under the routing lock |
| Recovery verification | Three consecutive HTTP 200 responses from stable `1.0.0` through Nginx |

## Trial procedure

1. Verify the reset conditions and record `reset_verified`.
2. Promote candidate `2.0.0` and verify it through Nginx. Save the promotion
   event and deployment ID.
3. Start the workload driver and monitor. The driver continues for its full
   60 s regardless of when recovery completes.
4. At the planned fault time, log `fault_activation_started` immediately
   before writing the fault flag in the candidate container. Log
   `fault_activated` immediately after the command succeeds. These
   timestamps bracket the activation.
5. Use the assigned arm. Record the first qualifying probe in the streak
   that reached the detection threshold, the first fresh confirmation,
   the delayed reconfirmation when applicable, rollback start, and
   verified recovery.
6. At the end of the driver window, clear the fault flag and verify the
   reset conditions before starting another trial. Preserve partial
   evidence if a step fails.

## Evidence and time alignment

Retain one directory per trial with `requests.csv`, `run.json`, the
promotion and monitor events, `events.csv`, and the final deployment and
routing records. Associate the trial ID and arm with the deployment ID.
Stage the runner's event data separately until the driver creates its own
run directory. V1 refuses an existing run directory.

The event CSV columns are `trial_id,arm,event,wall_ms,source`. Use epoch
milliseconds for these markers.

| Marker | Meaning |
|---|---|
| `trial_start` | Runner starts the trial procedure. |
| `reset_verified` | Stable routing and reset conditions were verified. Record at the start and again after cleanup. |
| `promotion_verified` | Candidate verified through Nginx. |
| `driver_started` | Measurement origin from the driver's `run.json` field `wall_start_ms`. |
| `fault_activation_started` | Immediately before issuing the fault-flag write. |
| `fault_activated` | The fault-flag write returned successfully. |
| `first_failure_probe` | First qualifying HTTP 500 in the streak used for detection. |
| `failure_confirmed` | First fresh qualifying confirmation after the locked ownership check. |
| `rollback_reconfirmed` | Fresh check after the delayed arm reacquires the lock. |
| `rollback_started` | The locked rollback routine begins. |
| `recovery_verified` | The third consecutive stable HTTP 200 response was verified. |
| `fault_cleared` | The command to remove the flag completed successfully. |

Use `run.json.wall_start_ms` as the client trace alignment point. Subtract
it from both fault timestamps to report the actual onset bracket relative
to driver start. Use the successful write acknowledgment as the stated
reference for point estimates of fault-to-detection and fault-to-recovery
time, and retain the bracket. A qualifying probe can arrive during the
bracket, before the write command returns.

## Measures

- Report fault to first qualifying probe, fault to first fresh confirmation,
  first confirmation to rollback start, rollback start to verified recovery,
  and fault to verified recovery. Keep the scripted delay and measured
  confirmation-to-rollback interval in the record.
- Compare client-visible HTTP errors, timeouts, and connection errors in
  the same scheduled client window from 15 s through the end of the run.
  Use the driver's scheduled offsets to apply that window and report actual
  fault offsets alongside it. Also report totals for the full measured
  window after warm-up.
- Report successful-response latency as a distribution. Count driver
  misses separately from failures on dispatched requests.
- For runs with client-observed failures, compare the first successful
  stable-version response after the final observed failure with the
  controller's recovery-verification timestamp. Preserve both measurements.

## Reset and pilot acceptance

A reset requires an HTTP 200 from stable `1.0.0` through Nginx, both
deployment IDs set to `null`, a cleared candidate fault flag, a healthy
candidate, and a healthy database. Promotion is the next step after reset.

A procedurally valid run has a complete driver result with valid request
accounting, a usable event record, verified recovery through Nginx,
preserved evidence, and a verified reset. Record unexpected ownership
loss, a failed reset, or an incomplete driver run with its reason. Review
any driver `review_required` flag. Retain failed trial evidence before a
rerun.

Aim for about 20 s of post-recovery traffic in the slower arm. If the
pilot leaves too little, increase the common duration for both arms before
the repeated trials.

## Scope

Both arms share detection, the rollback and verification mechanism, and
monitor probe traffic. The comparison estimates the effect of the
scripted delay under this detection and recovery procedure. The setup
uses a single WSL2 host, a shared database, and a controlled runtime fault.
Use the first pair to validate evidence collection and resetting. Alternate
arm order for subsequent repeated pairs.

## Nginx runtime setup and provenance

Before starting the routing profile on a fresh checkout, run
`node tools/controller/init-nginx-runtime.mjs`. It seeds
`runtime/nginx/conf.d/default.conf` from the tracked stable template at
`infra/nginx/conf.d/default.conf` when the runtime file is absent and both
deployment IDs are clear. Initialization preserves existing files.

For the first migration, confirm clear deployment ownership, initialize
the runtime file, and run `docker compose --profile routing up -d --wait`.
Verify that the Nginx container mounts `runtime/nginx/conf.d` read-only,
`nginx -t` succeeds, and the proxy returns HTTP 200 from stable `1.0.0`.
Keep the mounted directory in place during operation. Promotion and
rollback replace the file within it.

Template edits apply on a fresh initialization. For a deliberate reset of
the runtime file from the updated template, save the existing config,
confirm both deployment IDs are clear, stop Nginx, then remove only the
runtime file and rerun initialization before restarting Nginx.

Use a clean, committed checkout for repeated trials. Verify that Git stays
clean while the candidate serves and that V1 records `git.working_tree`
as `clean` at measurement start. The saved candidate and previous
snapshots record the exact routing configuration for each trial.

The original pilot pair ran before runtime isolation. The runner patch
was uncommitted and promotion modified the tracked Nginx config. Preserve
the original dirty-tree metadata and snapshots with the pilot evidence.
