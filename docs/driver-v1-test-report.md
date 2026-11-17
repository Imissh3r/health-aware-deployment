# Experiment Driver V1 Functional Verification Report

- **Final implementation checkpoint** — `8d273d2` (`Finalize experiment driver V1 reporting and fatal error recovery`)
- **Specification** — [Experiment Driver V1](driver-spec.md)
- **Verification environment** — Ubuntu under WSL2 with Node.js `v24.22.2`, plus separate local stand-in checks

## 1. Purpose and scope

The Experiment Driver generates a fixed-rate HTTP workload and records client-visible outcomes, timing, and run metadata. It operates independently of deployment, promotion, and rollback decisions.

This report records functional checks carried out across several implementation checkpoints. The terminal transcript confirms that `8d273d2` was pushed to `origin/main` and that the working tree was clean after the push. The final commit identifies the completed implementation. Individual test runs may have used an earlier revision or uncommitted changes.

## 2. Verification setup

The application-level checks ran against the Express sample application and PostgreSQL in Docker Compose under WSL2. Local HTTP fixtures produced redirect responses and stalled bodies. The output-failure checks used simulated filesystem errors in WSL2. A separate Node 24 stand-in harness exercised the request-task fatal error path.

## 3. V1 acceptance checklist

| Spec test | Configuration or stimulus | Observed result |
|---|---|---|
| 1. Healthy requests | 5 requests/s for 10 s, warm-up disabled | 50 HTTP 200 responses recorded as `ok`, with the application version present. |
| 2. Injected HTTP errors | 5 requests/s for 10 s with `ERROR_EVERY_N_REQUESTS=1` | All 50 rows had HTTP 500 and outcome `http_error`. The response version was present. |
| 3. Added response delay | 5 requests/s for 10 s with `RESPONSE_DELAY_MS=500` | All 50 responses succeeded. Recorded request latencies were 502.3–566.6 ms. |
| 4. Timeout before headers | 5 requests/s for 10 s, 2,000 ms app delay and 1,000 ms client timeout | All 50 rows had outcome `timeout` and an empty HTTP status. Latencies were 1,000.2–1,004.1 ms. |
| 5. Application stop and restart | 5 requests/s for 20 s. The app was stopped and restarted while the driver ran. Stop and start command times were saved in `events.csv`. | 23 successes before the stop, 25 connection errors during the confirmed outage, and 1 connection error plus 41 successes after the start command returned. The final 5 requests succeeded. |
| 6. Concurrency limit | WSL2 persistence check at 10 requests/s for 6 s, 2,000 ms app delay, maximum concurrency 5 | All 60 slots were recorded. The driver dispatched and settled 15 successful requests and recorded 45 `concurrency` misses. Missed rows had empty measurement fields, and CSV counts agreed with `run.json`. |
| 7. Schedule spacing | Same healthy run as test 1 | The stored schedule advanced in exact 200 ms intervals. The maximum observed dispatch delay was 1.9 ms. |
| 8. Redirect handling | Local fixture returned HTTP 302 for two requests | Both CSV rows stored HTTP 302 and outcome `http_error`. The driver did not follow the redirect. The metadata counted two HTTP errors. |
| 9. CLI and run-ID validation | Rates of `0` and `2.5`, then an existing run ID | All three invocations exited 1 with validation errors. The existing files and directory entries were preserved. |
| 10. Interruption | One Ctrl+C during a 150-slot run. In a separate run, two SIGTERM signals were sent while responses were delayed. | The first run saved 43 successful rows and `status: "incomplete"`, exiting 130. The second saved 3 dispatched rows as `interrupted` with the same run status, exiting 143. |
| 11. Timeout during body read | Two WSL2 runs used local fixtures that sent HTTP 200 headers and left the body unfinished. The client timeout was 1,000 ms. | Both rows retained HTTP 200 and recorded outcome `timeout`. The measured latencies were 1,003.4 ms and 1,005.2 ms. |

The outage run recorded 100 dispatched and settled requests in requests.csv. The three selected time windows account for 90 observations; the remaining 10 rows fall outside those windows. One connection error occurred after the Compose start command returned but before successful responses resumed. See requests.csv and events.csv for the complete request and event records.

## 4. Additional persistence and failure-handling checks

| Check | Environment and stimulus | Observed result |
|---|---|---|
| Normal output and metadata | WSL2, healthy application with the final reporting changes | Stdout contained only outcome counts. The driver saved one request row and metadata with `status: "complete"`, then exited 0. |
| Missing observation detection | WSL2, standalone sparse-array check | The corrected sequence check rejected a three-slot array with a missing middle record. The subsequent healthy 50-request smoke test passed all four recorded invariants. |
| Output directory creation failure | WSL2, a regular file occupied the requested output parent path | The driver reported `EEXIST` at `create_run_directory`, exited 1, and preserved the existing file contents. |
| Partial CSV write | WSL2, simulated `ENOSPC` during the temporary CSV write | The driver exited 1, removed the temporary file, and saved `run.json` with `status: "invalid"` and `output_error.step: "write_requests_csv"`. |
| Partial metadata write | WSL2, simulated `ENOSPC` during the first temporary JSON write | The driver exited 1 and preserved the published CSV. The retry saved invalid metadata with `output_error.step: "write_run_json"`. |
| Run-directory collision | WSL2, a fixture claimed the run directory immediately before the driver's exclusive creation attempt | The driver exited 1 and preserved the existing `run.json` contents. |
| Fatal scheduler error | WSL2, an injected error during the scheduling wait | The driver saved 2 successful request rows, recorded `status: "incomplete"` and `fatal_error.code: "TEST_FATAL_SCHEDULER"`, and exited 1. |
| Fatal request-task error | Local Node 24 stand-in harness, an injected error escaped the per-request handler | The driver preserved 2 rows, one `ok` and one `driver_error`, recorded an incomplete run, and exited 1. |

## 5. Output and accounting

- `requests.csv` contains request-level observations, including scheduled slots skipped by the driver.
- `run.json` contains the configuration, timing origin, provenance, outcome counts, run status, and accounting checks.
- An experiment script can supply `events.csv` to align external events with request observations. The outage test used it to record the Compose stop and start command boundaries.

For completed runs, the driver checks that offered slots equal dispatched requests plus misses, dispatched requests equal settled requests, row count and sequence match the planned schedule, and the sum of miss reasons equals the miss count. An interrupted or fatal run can save fewer rows than planned and retain `status: "incomplete"`.

A concurrency miss represents a slot the driver skipped before sending an HTTP request. It counts toward offered workload. HTTP error and timeout rates use dispatched requests and should disclose the number of misses separately.

## 6. Limitations

- The driver and application share a host in these tests. Resource contention can affect dispatch delay and response latency.
- The reported timings describe the tested runs. Fixed-rate scheduling, dispatch-delay accounting, and client timeouts were checked under those conditions.
- Cross-machine clock alignment was outside the test scope. The outage test compared wall-clock event timestamps with request offsets relative to the driver's wall-clock origin.
- The driver used Node.js built-in `fetch` with its default connection-reuse behaviour. Per-request reuse was not measured.
- Fault injection demonstrated selected failure paths. Partial output writes were simulated. Saving after a fatal run error depends on the process reaching finalization and the output path remaining writable.
- The controlled request patterns support repeatable trials. Formal comparisons will need defined workloads, repeat runs, and matched conditions.

## 7. Evidence provenance

The development transcript contains the test results summarized above. Some runs wrote evidence under `/tmp`, so the directories below are references to the original WSL2 runs and may no longer exist. Where available, inspect the original `run.json` for the run's Git revision and working-tree state. The exact revision is not independently confirmed for every row in this report.

| Run or batch | Recorded WSL2 evidence directory |
|---|---|
| CSV and metadata smoke test | `/tmp/health-driver-test/metadata-smoke-02` |
| Concurrency persistence | `/tmp/health-driver-concurrency.wu1qmy/metadata-concurrency-01` |
| Outage and recovery | `/tmp/health-driver-v1-outage-_943n6m4/app-outage` |
| HTTP 500 and pre-header timeout | `/tmp/health-driver-v1-responses.EKOvlz` |
| Redirect | `/tmp/redirect-acceptance` |
| Stalled response body | `/tmp/health-driver-stalled-body-o2wenvlu/stalled-body` |
| First and second signals | `/tmp/health-driver-interrupt.BNw7bG/first-signal` and `/tmp/health-driver-double-signal.wfgztt/double-signal` |
| Simulated output failures | `/tmp/health-driver-faults-vkvmjg9j` |
| Final healthy, delay, schedule, and CLI checks | `/tmp/health-driver-v1-final.yXtutv` |
| Counts-only output and fatal scheduler recovery | `/tmp/health-driver-v1-fatal-zk7zic91` |

For example, `metadata-smoke-02` explicitly captured `db1ec72` with a dirty working tree while the persistence changes were under development. It is evidence for that iteration.

## 8. Conclusion

The recorded checks support using the driver as an independent measurement tool for the next deployment integration milestone. They establish functional behaviour for the exercised cases. Nginx traffic switching, controller decisions, rollback, and the baseline-versus-proposed comparison will have their own verification evidence.
