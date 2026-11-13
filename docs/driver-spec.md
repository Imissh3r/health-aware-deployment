# Experiment Driver Specification (v0.1)

## Purpose

A small Node.js command-line tool that sends requests to an HTTP endpoint at a
fixed rate and records what happens to each request. It generates the workload
for the experiments and acts as an **independent observer** of client-visible
behaviour.

It is an experimental instrument, not a general-purpose load-testing tool. All
numeric defaults below are initial values to be calibrated, not established
thresholds.

## Principles

1. **Observer only.** The driver never decides whether to promote, reject or
   roll back a version. Those decisions belong to the deployment workflows.
2. **Same driver, same settings** for baseline and proposed-workflow trials.
3. **Open-loop scheduling.** Requests are sent on a fixed schedule whether or
   not earlier requests have finished, to avoid coordinated omission (slow
   responses reducing the number of requests sent).
4. **Nothing is silently dropped.** In a complete run, every scheduled request
   produces exactly one row in the output, including requests that could not
   be sent.
5. **Instrument failures are not application failures.** Problems inside the
   driver are classified separately and flag the run for review.
6. **No fabricated values.** A measurement that does not exist is left empty,
   never filled with zero.
7. **Results are never overwritten.** Every run writes to its own directory.
8. **Keep the driver simple.** Analysis (percentiles, intervals, plots) is done
   afterwards by separate scripts from the raw data.

## Inputs

| Option | Meaning | Initial default |
|---|---|---|
| `--url` | Target URL (through the Nginx entry point once it exists) | none |
| `--rate` | Requests per second (positive integer) | 5 |
| `--duration` | Run length in seconds (positive integer) | 60 |
| `--timeout` | Per-request timeout in ms, covering the whole response | 3000 |
| `--max-concurrency` | Maximum requests in flight | 50 |
| `--max-lateness` | Maximum ms a request may be dispatched late before it is recorded as missed | one request interval (`1000 / rate`) |
| `--warmup` | Seconds at the start flagged as warm-up | 5 |
| `--run-id` | Identifier for this run; names its output directory | generated |
| `--out` | Parent directory for run directories | `experiments/results/` |
| `--notes` | Free text recorded in `run.json` (the experiment script uses it for the app version and fault settings) | empty |

The driver refuses to start, with a clear message and no output files, if an
option is missing, not a positive integer where one is required, or otherwise
invalid. It also refuses to start if the run directory already exists.

Redirects are not followed: the driver calls `fetch` with `redirect: 'manual'`.
A 3xx response is recorded as an `http_error` with its status code.

Total scheduled requests = `rate x duration` (both integers).

## Scheduling model

- Request `i` is scheduled at `start + i * (1000 / rate)` ms on the monotonic
  clock.
- At each scheduled time the driver does exactly one of three things, in order:
  1. If it is later than `--max-lateness` for this request, record it as
     `missed` with reason `late`. Do not send it, and do not send a
     catch-up burst.
  2. Else, if `--max-concurrency` requests are already in flight, record it as
     `missed` with reason `concurrency`. Do not queue it.
  3. Else dispatch it.
- `dispatch_delay` = actual dispatch time minus scheduled time. It exposes timer
  jitter and CPU contention on the host.
- `latency` = completion time minus actual dispatch time. It does not include
  dispatch delay.
- Requests scheduled during the warm-up period are recorded with
  `warmup=true`. They stay in the CSV and are excluded from summary statistics.

## Completion and timeout

A request is **complete** when its whole HTTP response body has been read, or
when it ends in an error or timeout. `latency` is measured to that point.

`--timeout` covers the whole operation, including reading the body: the abort
signal stays active until the body has been fully read, and is not cleared when
`fetch()` first resolves. A stalled body read is therefore aborted as well as a
stalled connection.

## Timing rules

- All durations and offsets use `performance.now()` (monotonic).
- Wall-clock time (`Date.now()`) is recorded **once**, at the start of the run,
  as `wall_start_ms`. Per-request times in `requests.csv` are monotonic offsets
  from the start of the run.
- Never subtract a wall-clock value from a monotonic one.
- Experiment scripts write their own events (failure injected, deployment
  started, rollback started, and so on) with wall-clock timestamps to
  `events.csv` in the run directory. Those line up with the driver's data
  through `wall_start_ms`.

## Outcome classification

| Outcome | Meaning |
|---|---|
| `ok` | HTTP 2xx, body fully read |
| `http_error` | Any other HTTP status (3xx, 4xx, 5xx); status code stored |
| `timeout` | No complete response within `--timeout` |
| `connection_error` | Refused, reset, DNS or similar; error code stored |
| `driver_error` | Unexpected malfunction inside the driver itself |
| `missed` | Not sent; reason stored (`late` or `concurrency`) |
| `interrupted` | Still in flight when a second interrupt signal ended the run; only occurs in `incomplete` runs |

**Client-visible failure** = `http_error`, `timeout` or `connection_error`.
`missed` and `interrupted` are reported separately and never merged into
failures.

`driver_error` is reserved for genuine unexpected failures in the measurement
code. It is never counted as an application failure. A run containing one is
flagged for review and normally excluded from formal comparisons. It is not a
catch-all:

- A response body that is not JSON is not a driver error. The version is
  recorded as empty.
- A network timeout is a `timeout`, not a `driver_error`.

4xx responses should not occur against this app. If they do, they point to a
test setup problem; they are stored with their status code.

**Version tracking:** the driver reads the `version` field from the JSON body of
each response (including error responses) and stores it. If the body is missing
or not JSON, the version is empty.

## Output

Each run writes to its own directory, `<out>/<run-id>/`, containing
`requests.csv`, `run.json` and, when an experiment script supplies it,
`events.csv`. Existing run directories are never overwritten.

`requests.csv` (one row per scheduled request):

`run_id, seq, scheduled_ms, dispatched_ms, completed_ms, dispatch_delay_ms,
latency_ms, outcome, http_status, error_code, miss_reason, version, warmup`

For a `missed` request, `dispatched_ms`, `completed_ms`, `dispatch_delay_ms`,
`latency_ms`, `http_status`, `error_code` and `version` are empty. `outcome` is
`missed` and `miss_reason` is `late` or `concurrency`. `scheduled_ms` and
`warmup` are always filled in. Unavailable values are always left empty, never
zero.

`run.json` (one per run):

- run id and `status`:
  - `complete`: every offered request is accounted for and all invariants hold
  - `incomplete`: the run ended early (interrupt or fatal error); available
    records are preserved, the invariants are not required, and the run is
    excluded from formal comparisons
  - `invalid`: the run reached its end but an invariant failed, or the output
    could not be reliably written
- `wall_start_ms` (Unix epoch, milliseconds) and `wall_start_iso` (ISO 8601,
  the same instant)
- all input options and the target URL
- driver and Node versions
- host details: platform, CPU count, memory
- git commit hash, and `clean` or `dirty`, from
  `git status --porcelain -- . ':(exclude)experiments/results'` at the start of
  the run, before any output is written (empty output = clean). This catches
  uncommitted and untracked files but not ignored ones such as `.env`
- target configuration (app version and fault-injection settings), supplied
  through `--notes`
- the running Docker image identifier (optional; recorded for formal
  experiments)
- whether connections are reused (keep-alive)

Formal experiments should be run with a clean tree.

The driver keeps its rows in memory and writes them when the run ends, so disk
writes do not disturb its timing. Writing results after an abnormal end is
best-effort only: a hard kill (SIGKILL) or machine failure loses the run, which
is then treated as not performed.

At the end of a run the driver prints only counts per outcome.

## Run end

When the duration ends, the driver stops scheduling, waits for in-flight
requests to finish or time out, and only then writes the result files.

## Interruption

On the first SIGINT or SIGTERM, the driver stops scheduling and waits for
in-flight requests to settle (each is bounded by `--timeout`), writes the
result files and sets `status` to `incomplete`. On a second signal it stops
waiting, records every unsettled request with outcome `interrupted`, writes the
files and sets `status` to `incomplete`. Requests that were never scheduled have
no rows.

## Reporting rule

Every run reports these counts separately:

- **Offered** = `rate x duration`
- **Dispatched** = requests actually sent
- **Settled** = dispatched requests that reached a terminal outcome (`ok`,
  `http_error`, `timeout`, `connection_error` or `driver_error`)
- **Missed** = requests not sent, split by reason (`late`, `concurrency`)

Invariants, checked automatically after every run. They are **mandatory for
`complete` runs**; an `incomplete` run preserves what it has and does not need
to satisfy them:

- Offered = Dispatched + Missed
- Dispatched = Settled (exactly one outcome per dispatched request)
- The CSV has exactly `rate x duration` rows with no duplicate `seq` values

These checks show internal consistency only. They cannot show that latency was
measured correctly, which is what the acceptance tests are for.

A run that reaches its end but violates an invariant is `invalid`. A run with
many `late` misses points to driver or host overload and may be invalid. Misses
caused by `concurrency` mean all permitted slots were occupied: saturation
relative to the configured limit. The cause (slow server, low limit, host
contention) is investigated, not assumed. Neither kind of miss is discarded
automatically.

## App change required before the tests

`/api/work` runs a trivial query (`SELECT 1`) against PostgreSQL so a database
outage causes real client-visible failures. When the query fails it returns
HTTP 503, and the response body includes the `version` field. Order of
operations: count the request, apply the configured delay, apply the injected
error, then run the query. An injected HTTP 500 therefore takes precedence over
a database failure. `/health` and `/` are unchanged. Latency baselines must be
re-measured after this change.

## Acceptance tests for the driver

Common configuration unless a test says otherwise: rate 5, duration 10 s,
timeout 3000 ms, max-concurrency 50, warm-up 0 s (so every row counts). Each
test changes only what is listed. The invariants must hold in every test that
runs to completion.

| # | Overrides | Expected |
|---|---|---|
| 1 | Healthy app | All `ok`, version present, small dispatch delays |
| 2 | App with `ERROR_EVERY_N_REQUESTS=1` | All `http_error`, status 500 |
| 3 | App with `RESPONSE_DELAY_MS=500` | `ok`, latency just above 500 ms |
| 4 | App with `RESPONSE_DELAY_MS=2000`; timeout 1000 | All `timeout`, latency about 1000 ms |
| 5 | Duration 20 s; stop the app container about 5 s after the run starts and start it about 5 s later | `connection_error` rows during the outage (a request in flight at the moment of the stop may be a `timeout` instead); `ok` rows resume once the app is healthy again. Actual stop and start times are recorded in `events.csv` |
| 6 | App with `RESPONSE_DELAY_MS=2000`; rate 10; max-concurrency 5 | `missed` rows with reason `concurrency`; no queued requests |
| 7 | Healthy app | Gaps between `scheduled_ms` values equal 200 ms (`1000 / rate`) within jitter |
| 8 | Throwaway local server on port 8081 that always replies `302` with `Location: /` | Every row `http_error`, status 302; redirect not followed |
| 9 | `--rate 0`, then `--rate 2.5`, then an existing `--run-id` | Driver refuses to start with a clear message; no result files written or overwritten |
| 10 | Interrupt the driver (Ctrl+C) partway through a run | Files written; `status` is `incomplete`; in-flight requests settled or marked `interrupted` |
| 11 | Throwaway local server that sends response headers and then stalls the body | `timeout` at about `--timeout`, showing that the timeout covers the body |

Test 5 may show that the real error codes differ from what is assumed here. If
so, the classification is adjusted to match what is observed.

## Known limitations

- The driver, the app and the monitoring stack share one machine, so the
  driver's own timing can be disturbed. `dispatch_delay` makes this visible.
- Clock correlation between the driver and experiment events relies on one host
  clock. Its uncertainty is not yet measured, and a system clock adjustment
  during a run would break the alignment.
- Node's built-in `fetch` reuses connections (keep-alive). Reuse affects latency
  and how errors appear after a server restart, so the setting is recorded in
  `run.json` and kept the same across trials.
- Constant-rate traffic is a controlled stand-in for real traffic, not a model
  of it.

## Decisions

1. Missed requests are reported separately and kept when judging run validity.
2. Warm-up starts at 5 s and is calibrated from measurements.
3. Percentiles and intervals are computed by separate analysis scripts from the
   raw CSV.