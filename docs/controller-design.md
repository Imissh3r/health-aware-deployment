# Deployment Controller Design

## First slice: candidate validation

The host CLI probes the running `candidate` service from inside the Compose network.
It uses the Node runtime in `app` to reach `http://candidate:3000`. An operator
starts the two application instances and Nginx using the `routing` profile.

The CLI checks `/health` and `/ready`, then makes five sequential `/api/work`
requests. A passing candidate returns HTTP 200 and version `2.0.0` on every
workload response. Each probe has its own timeout. The starting settings are a
1,500 ms timeout and a maximum workload latency of 1,000 ms per successful
response. Both settings are configurable and provisional.

Workload error rate is failed attempts divided by attempts. HTTP failures,
connection failures, and timeouts count as failed workload attempts. Version
and latency criteria are evaluated separately. Zero attempted workload
requests gives an undefined error rate, recorded as JSON `null`.

| Decision | Exit code | Meaning |
|---|---|---|
| `ELIGIBLE_FOR_PROMOTION` | 0 | The candidate met the validation criteria. |
| `REJECTED` | 2 | An observed health or workload result violated a criterion. |
| `INCONCLUSIVE` | 3 | The probe could run, but it returned insufficient evidence, for example a transport failure during an initial health check. |
| `FAILED` | 1 | A controller operation failed, such as a Compose execution error. |

Each invocation emits a JSON event with its decision, reason, timestamps, and
available probe results. Redirect stdout to save the event for a test run.
The active Nginx configuration stays at `app` during this slice.

Acceptance checks use a healthy candidate and then a candidate configured to
return HTTP 500 on every workload request. They verify the logged decision and
fresh responses from version `1.0.0` at the proxy in both cases.

## Later slices

Promotion and rollback use the verified Nginx switch. Validate the configuration,
reload it, and confirm the expected version and successful responses through
the proxy. If promotion verification fails after a switch, attempt to restore
the previously verified upstream and verify the result. Record the promotion
failure separately from the recovery outcome.

The conventional baseline shares the app, Nginx switch, post-promotion monitoring
signal, and Experiment Driver endpoint. Its operator response delay is measured
from the same detection event used for automated recovery. A zero-delay case
measures the best-case baseline. Candidate rejection before a switch and rollback
after a switch are separate scenarios. Post-promotion failure trials will use an
in-place fault trigger so they can isolate degradation from container restart.

## Second slice: verified promotion

Run `node tools/controller/promote.mjs` from the host with the routing stack
running. Save stdout to retain the promotion event. The command expects the
saved Nginx config to point to `app` and a live response version of `1.0.0`.
It runs the existing validator before changing the upstream and records
`PROMOTION_BLOCKED` if validation rejects the candidate or is inconclusive.

The command replaces the config through a temporary file in the mounted
directory, tests it with `nginx -t`, and reloads Nginx. It records `PROMOTED`
after three consecutive fresh HTTP 200 responses identify version `2.0.0`.
Verification uses a five-second window and polls every 200 ms by default.
Use `--verification-window-ms` and `--verification-interval-ms` to adjust
these settings. The event records attempts, elapsed time, and the last result.

If the candidate config fails its syntax check, the CLI restores the saved
file and checks the live stable route. If reload was attempted, it tests and
reloads the saved file before checking the proxy. A failed promotion keeps its
own `PROMOTION_FAILED` result and records recovery as `RESTORED` only when the
file is restored, required Nginx operations succeed, and three fresh HTTP 200
responses identify version `1.0.0`. Other recovery results are `RECOVERY_FAILED`.
The CLI exits 1 on promotion failure even when recovery succeeds. Validation
rejection and inconclusive decisions retain exit codes 2 and 3.

The implementation assumes one routing operator. A completed promotion leaves
the candidate active. The manual switch-back is available for resetting the
smoke test, and runtime rollback after a verified promotion is a later slice.

## Third slice: in-place fault after promotion

Use verified promotion to bring a healthy `candidate` (`2.0.0`) onto the
Nginx route. The candidate service explicitly opts into a fault flag in its
container-local filesystem. The operator sets and clears the flag using
`docker compose exec` on `candidate`. With the flag set, candidate
`/api/work` returns HTTP 500 with its version. The flag affects only the
candidate workload endpoint.

| Check | Expected response |
|---|---|
| Through Nginx before setting the flag | HTTP 200, version `2.0.0` |
| Through Nginx after setting the flag | HTTP 500, version `2.0.0` |
| Direct stable request while the flag is set | HTTP 200, version `1.0.0` |
| Through Nginx after clearing the flag | HTTP 200, version `2.0.0` |

Record the candidate container ID and start time before setting the flag
and after clearing it. Both values must match. Reset the test stack to the
stable route using the verified manual switch-back.

## Runtime monitoring and ownership

Run `node tools/controller/monitor.mjs <deployment-id>` after promotion.
The monitor probes `/api/work` through Nginx once per second. Three
consecutive HTTP 500 responses containing the candidate version from the
manifest (currently `2.0.0`) trigger an ownership check. Any other result
breaks the streak. Each request, including its response body, has a
1,000 ms timeout.

Routine probes run outside the routing lock. When the lock is acquired,
require the monitored ID to match the active ID, the pending ID to be
`null`, the manifest to be `PROMOTED`, and the installed Nginx config
to match the saved candidate config byte for byte. Confirm the failure
with one fresh probe while holding the lock.

| Monitor event | Behaviour |
|---|---|
| `DEGRADATION_CONFIRMED` | The deployment still owns the route and the confirmation qualified. Exit 0. |
| `LOST_OWNERSHIP` | The ownership check failed. Exit 2 without a confirmation probe. |
| `DEGRADATION_CLEARED` | The confirmation did not qualify. Release the lock, reset the streak, and continue probing. |
| `LOCK_BUSY` | Continue probing outside the lock. Retry on the next probe if the streak still qualifies. |
| `MONITOR_FAILED` | An input, state read, or controller operation failed. Exit 1. |

The CLI emits JSON lines on stdout. This slice records the decision
without changing routing. Run `node --test tools/controller/monitor.test.mjs`
to check detection, lock contention, confirmation, and a deterministic
ownership change from A to B with identical configuration and version.

## Later slice: runtime rollback

The conventional baseline will use the same fault, probe schedule, and
detection rule, with its operator delay measured from detection.

Use the deployment handoff to recover the exact pre-promotion config.
Verify restoration through Nginx with three consecutive HTTP 200
responses from `1.0.0`.

Record fault activation, detection, rollback start, and verified recovery
as separate events. The Experiment Driver independently records
client-visible responses through Nginx.

## Deployment handoff

Each promotion reserves a unique directory under `deployments/`. Save
`previous-nginx.conf`, `candidate-nginx.conf`, and `deployment.json` before
switching traffic. The snapshots retain the exact bytes used by the
promotion. The manifest records the deployment ID, expected versions,
config mode, state, and timestamps. The local records outlive the
promotion process and are ignored by Git.

Promotion holds the shared `routing.lock` using Linux `flock`. The same
lock will guard rollback. The shared `active-deployment.json` has either
an active deployment ID, a pending deployment ID, or two null IDs.
After validation passes, publish the pending ID and mark the manifest
`PROMOTION_IN_PROGRESS` before writing the candidate config. After
proxy verification, mark the manifest `PROMOTED` and atomically replace
the shared record with the active ID. The shared record is authoritative
for handoff. A later monitor must match the active ID and the candidate
config before changing the route.

If final publication fails after a switch, restore and verify the previous
route. If the CLI exits with a pending ID, the next invocation checks
the saved route against that deployment's two snapshots. A recognized
route permits reloading and verifying the previous config under the lock.
Record `PROMOTION_INTERRUPTED` and clear the pending marker after
reconciliation. A config conflict or failed recovery leaves the pending
marker in place for investigation.

Keep routing changes under one operator during the smoke test. A manual
reset switches Nginx back to stable outside the controller. The saved
deployment then serves as historical evidence, and the next promotion
checks the stable route in its preflight.
