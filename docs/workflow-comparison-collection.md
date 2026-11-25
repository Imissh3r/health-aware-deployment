# Workflow-comparison collection controls

WP4 implements Draft v1.2 coordination for the three approved single-arm runners. Gate E supplies the actual seed, clean collection commit and verified environment. The example seed below is for inspection only.

```sh
node tools/experiments/formal-collection.mjs plan 01234567
node tools/experiments/formal-collection.mjs inspect /path/to/collection
node --test --test-isolation=none tools/experiments/{formal-collection,run-formal-healthy-release,run-formal-faulty-candidate,run-formal-post-rollout-degradation,workflow-client-classifier,formal-trial-classifier}.test.mjs
```

The CLI is read-only. `plan` emits a draft with null Git and environment fields. `inspect` checks the manifest by regenerating it, replays the ledger, and displays the next eligible arm or the reason collection is blocked. The tests exercise the same collection API with fixture runners, a fixture verifier and separate `fixture-evidence` directories. Fixture ledgers are labeled and cannot dispatch live runners.

## Manifest

Schema version 1 records the protocol revision, algorithm, lowercase hex seed, full Git revision, frozen environment metadata, schedule ID and ordered pairs. Each pair contains the scenario, pair ID, assigned order and its original attempt. Each arm records position, H/C assignment, trial ID and intended Driver V1 run ID. The schedule ID is `wc-` plus SHA-256 of the compact JSON provenance object assembled by the generator.

`sha256-fisher-yates-v1` shuffles four `HC` and four `CH` entries independently for each scenario. For each descending Fisher–Yates index, take the first four bytes of SHA-256 of the UTF-8 text `sha256-fisher-yates-v1:<seed>:<scenario>:<counter>` as a big-endian unsigned integer. The decimal counter starts at zero per scenario and advances for every draw. Reject integers in the incomplete modulo bucket at the top of the 32-bit range, then reduce modulo the number of available positions. The manifest lists S1, S2, S3 in that order, with eight pairs each. Pair IDs append the scenario and pair ordinal to the schedule ID. Attempt IDs append `r01`, `r02` or `r03`, and trial IDs append H or C. Replacements keep their pair's original order.

## Coordinator API

- `generateCollectionManifest({ seed, gitRevision, frozen })` and `initializeCollection(directory, manifest, { mode })` create the plan and publish it into a new directory. Use an existing parent directory and a local filesystem with hard-link and directory-fsync support.
- `openCollection(directory, { verifyEnvironment })` exposes `inspect()`, `runNext()`, `reconcile(details)` and `decidePair(details)`. Each `runNext()` attempts at most one arm. The formal API dispatches the approved scenario runner. Fixture mode requires an explicit injected runner map and never falls back to live runners.
- The formal admission check requires the expected branch, exact Git revision, clean checkout, frozen hostname, explicit `COMPOSE_PROJECT_NAME` and `DEPLOYMENT_PROXY_URL`, and a verifier supplied by the collection operator. The verifier receives a copy of the expected metadata and must independently observe and return `{ gitRevision, frozen }` for comparison on every launch. Frozen metadata contains the host, Compose project, canonical loopback proxy URL, stable config SHA-256, environment fingerprint, sanitized effective Compose config digest and reference, immutable image digests by service and preflight reference. The verifier should report only sanitized failure reasons. Each runner also runs its own preflight.
- The manifest and numbered ledger events are create-once. The coordinator publishes each ledger event via a flushed temporary file and an exclusive hard link. A durable start precedes runner invocation and records the assigned and attempted arm, evidence path and process owner. The outcome event preserves the full returned summary after checking it against the runner's evidence file. Each event includes a manifest hash, sequence, timestamp and mode. Runner artifacts remain in their own create-once directories.

## Continuation and adjudication

- An arm can start only at the next manifest position. The coordinator requires the runner's `nextArmAllowed`, compatible cleanup status and a verified reset with evidence before continuing. A preflight mismatch or unsafe reset blocks further launches. A recorded start without an outcome also blocks launches, including after a restart.
- `reconcile` requires `authorizedBy`, `reason`, `evidenceRef`, `operationsSettled: true` and `resetVerified: true`. The operator must positively verify settlement and stable reset and reference that evidence. A still-active starting coordinator cannot be reconciled. An interrupted arm with a usable summary can recover that summary in place. A missing or unusable summary requires `aborted: true`, which preserves partial evidence and leaves validity undecided. The same trial ID is never launched again after a start. A reconciled preflight failure can retry admission because the arm was never started.
- A technically valid round advances after both arms, regardless of workflow outcome. An invalid, uncertain or aborted result leaves the pair pending review after both slots are resolved. `decidePair` records `retain` or `replace` with an authorizer, reason and evidence reference. Replacement also requires the affected `invalidTrialId`, `matchingInvalid: true` and a `technicalReason`. An uncertain or aborted result needs an explicit `adjudicatedValidity: 'invalid'` finding supported by the review evidence. The decision links both preceding trial IDs. After `r03`, retain the available evidence and record the remaining shortfall in the disposition.
- Gate E must designate the authorized coordinator, collection directory, reviewers and source of reset evidence for the frozen environment. Use one collection directory per authorized schedule on that environment. The ledger enforces exclusion within that directory. Gate E must also supply the independent live environment verifier and freeze the host, effective Compose configuration and bindings, immutable image identities, source revision, protocol, preflight report and final seed. Final evidence packaging and metric selection belong to WP5.

## Comparison stack for an authorized rehearsal

The persistent `compose.comparison.yaml` override replaces the two published-port lists. Select it explicitly with the base file. It requires Compose 2.24.4 or newer for the `!override` tag. The override selects the historical comparison project, Nginx loopback port 18080 and stable app loopback port 13000. The base defines the internal candidate and database, database volume and read-only Nginx runtime mount.

Run the following only after live startup is separately authorized. Keep these exports in the shell that will invoke the rehearsal API so the runner and its controller subprocesses select the same files.

```sh
cd /home/sree_odin/projects/health-aware-workflow-comparison
unset COMPOSE_PATH_SEPARATOR
export COMPOSE_PROJECT_NAME=health-aware-workflow-comparison
export COMPOSE_FILE="$(pwd -P)/compose.yaml:$(pwd -P)/compose.comparison.yaml"
export DEPLOYMENT_PROXY_URL=http://127.0.0.1:18080/api/work
docker compose --profile routing up -d --no-build --no-recreate --pull never
```

Before startup, verify the existing comparison containers' image IDs, mount and volume, and verify that both intended host ports are free. The startup command preserves existing containers and their volume. Gate D must still verify the running ports, service health, fault flag and stable route. Compose obtains credentials from its usual local environment or ignored `.env` file.

## Real rehearsal provenance

Use `generateRehearsalManifest({ sessionId, gitRevision, frozen, arms })` with a unique session ID and an ordered array of selected `{ scenario, arm }` values. Initialize a new collection directory with `initializeCollection(directory, manifest, { mode: 'rehearsal' })`. Store it separately from formal and archived evidence. Operate only one active collection or rehearsal against the comparison stack at a time. There is no seed, pair, or replacement round in a rehearsal plan. Trial IDs begin with `rehearsal-` and evidence lives under `rehearsal-evidence/`.

Read the plan and ledger with the existing offline `inspect` command. For an authorized live call use `openCollection(directory, { expectedMode: 'rehearsal', verifyEnvironment })` and call `runNext()` once per selected arm. The explicit mode is also required for `reconcile()`. Rehearsal execution applies the existing clean-checkout, Git, host, environment, and reset checks and requires the comparison Compose file list above. The operator's verifier must independently check the rehearsal environment. Reuse the same directory and manifest on resume. An unsafe outcome or unresolved start blocks continuation until explicitly reconciled. Started IDs are never reused. To rehearse another arm after finishing the plan, authorize a new session with a new ID.

## Operator launcher for the first S1 H rehearsal

`tools/experiments/run-s1-rehearsal.mjs` supports one fixed S1 H arm. It uses the exports in **Comparison stack for an authorized rehearsal** above. Run from the reviewed clean `workflow-comparison` checkout on WSL. Supply the full Git revision approved for rehearsal, including this launcher after review and commit. Select one unused session ID. The evidence destination is derived as `experiments/results/rehearsal-<session>` and must be absent. The results parent must already exist at its normal repository path.

```sh
node tools/experiments/run-s1-rehearsal.mjs check \
  --session d2-first --git-revision "$APPROVED_REVISION"
```

`check` prints the proposed manifest and sanitized facts. It uses Git, Docker metadata and Compose rendering, reads the stable route files, and checks tool versions, including `flock --version`. It creates no files and performs no HTTP requests, lock acquisition, container exec, or trial operations. Review the printed `manifest.frozen.environmentFingerprint` before any authorization to execute.

**Future execution command — not run during Gate D2.5**

```sh
node tools/experiments/run-s1-rehearsal.mjs execute \
  --session d2-first --git-revision "$APPROVED_REVISION" \
  --fingerprint "$REVIEWED_FINGERPRINT" --authorize-s1-h
```

Set `APPROVED_REVISION` and `REVIEWED_FINGERPRINT` to the reviewed literal values. Execution reobserves the environment and checks the fingerprint before initializing WP4. It writes create-once sanitized Compose and preflight artifacts into the new rehearsal directory, then calls WP4 `runNext()` once. WP4's injected verifier independently reobserves the environment again at admission and verifies the artifacts against their expected content. A change detected there records a WP4 preflight block without invoking S1. A session left behind by a crash, blocked admission, or unsafe reset requires WP4 inspection and authorized reconciliation. The launcher refuses to reopen it or retry the arm.

Use a WSL shell that grants Node child processes permission to run Git, Docker Compose and `flock`. The metadata check establishes read-only child-process access when run from that shell. S1 still requires Docker exec for candidate preflight and Nginx operations, Node IPC for Driver V1 and the monitor, and `flock` on the inherited routing-lock descriptor. These live capabilities are outside the metadata check. Operate a single rehearsal or collection against the comparison stack.

### Fingerprint and provenance

Both check and execution use the same observer. Canonical bytes are UTF-8 compact JSON with object keys sorted recursively by JavaScript's default string order, arrays kept in semantic order, and one trailing LF. SHA-256 is encoded as lowercase hex.

- `comparison-compose.redacted.json` is the `s1-rehearsal-compose/v1` projection of the effective model. It covers the project, ordered files, profile, named network and volume, and the four services' image/build references, ports, mounts, dependency targets, profiles, allowed app settings, and database health check. Dependency health conditions and the Nginx mount policy are validated before serialization. Its canonical bytes produce `composeConfigSha256`.
- `rehearsal-preflight.json` is the `s1-rehearsal-environment/v1` facts object. It binds Git HEAD, WSL hostname and kernel, tool versions, project, proxy URL, ordered Compose files, the projected Compose digest, the runtime stable-config digest, bridge identity, volume name and creation metadata, and per-service container and image IDs. Hashing its canonical bytes produces `environmentFingerprint`.
- Compose credentials are checked for presence and equality with running container settings in memory. Credentials, arbitrary container environment values and command stderr are omitted from the artifacts and hashes. This means a change in credentials alone is not a fingerprint change. The running comparison identities, mounts, bindings and health metadata must agree with the effective model. Missing required observations or mismatches fail the check.
- WP4 calls its image identity field `imageDigests`. For this launcher those values are Docker Engine image IDs, corroborated by the running container and local image inspection. The field does not assert registry manifest digests or image signatures.

These are locally reproducible rehearsal facts. Gate E still requires independently bound source and environment provenance, immutable image provenance, and full evidence artifact integrity. The launcher does not establish application response or fault absence through metadata. The approved S1 live preflight makes those checks after authorization.
