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
