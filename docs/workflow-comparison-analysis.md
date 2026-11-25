# Workflow comparison evidence audit and analysis

The WP5 analyzer reads an existing WP4 collection. Use a quiescent collection at its recorded path because WP4 stores absolute arm evidence paths. The analyzer imports WP4's read-only inspector and the approved Driver V1 CSV parser and client classifier. It has no collection or deployment command.

```sh
node tools/experiments/analyze-workflow-collection.mjs audit /path/to/collection
node tools/experiments/analyze-workflow-collection.mjs inspect /path/to/collection
node tools/experiments/analyze-workflow-collection.mjs report /path/to/collection --out /path/to/new-report
```

The output directory must be new and outside the collection, with an existing parent. A report can be written for incomplete or blocked input. The CLI exits nonzero for a collection integrity block or detected trial integrity issue. Verify the evidence store before publishing formal results. Reports label WP4 fixture mode as synthetic and do not consume pilot or Frozen V1 inputs.

## Evidence checks

The audit regenerates the seeded manifest via WP4, validates the numbered ledger and replays its start, outcome, replacement and reconciliation rules. It checks canonical trial evidence paths and rejects symlinks in inspected evidence paths. It compares each terminal ledger outcome with its on-disk summary, checks runner identity and environment fields, traces referenced events, checks observer streak and monitor timing sources, and compares controller deployment stdout with the recorded outcome. It hashes the raw Driver V1 artifacts against the classifier's references, checks the start notification against the final clock metadata, compares Driver Git provenance when present, and replays the approved client classifier. The audit checks the Compose digest when its referenced snapshot is available in the collection. External or opaque references are reported as unverifiable and are never followed.

A hash computed during analysis describes the bytes read. A `verified` artifact has a matching recorded digest. `missing`, `inconsistent`, and `corrupted` identify absence, contradictory records and invalid or hash-mismatched bytes respectively. `unverifiable` identifies provenance without an independent recorded digest. Relationship checks can corroborate an artifact with no independently published hash. WP4 does not independently bind every artifact, the collected environment, or executed source bytes. Its per-trial Driver hashes support consistency checks but cannot authenticate a coordinated rewrite of the raw inputs and their references.

The older `formal-trial-classifier.mjs` and bundle utilities describe the separate Frozen V1 study. Their timing, study arm and validity rules cannot be applied to this collection. WP5 replays `workflow-client-classifier.mjs` and preserves the workflow runners' validity records.

## Analysis rules

- Every planned arm and authorized attempt remains in the inventory. Only the current round can supply a matched observation. Valid adverse outcomes qualify. An unresolved round, a technically invalid arm, or an evidence conflict excludes the pair. A retained `needs_review` arm can contribute when the recorded issues are limited to identified measurement domains and independent checks support the metric. Free-form operator reasons and evidence references stay in the source ledger.
- S1 includes sampled client disruption, failed requests and the certified sustained candidate milestone. S2 keeps C's deployment-origin alert and end-to-end recovery endpoints separate from H prevention. Unexpected H promotion and recovery are visible as supporting outcomes. S3 uses the fault acknowledgment origin, keeps signed write-bracket offsets when detection is origin-uncertain, and reports failure to reach the fault stage separately. Its deployment milestone is pre-fault supporting evidence.
- The approved client classifier determines cohort membership, failure episodes and milestone certification. When a recorded intervention overlaps the trace, the analyzer reruns the classifier with the intervention barrier after checking the originally stored result. Early primary intervention excludes the affected arm; late cleanup cannot count as workflow recovery. Right-censored episode bounds, late milestones, and uncertain clock bounds remain separate from exact primary results.
- Numeric differences are C minus H within one accepted round and scenario. Exact observations contribute to point summaries. Compatible clock-bounded endpoints also produce paired bounds, without imputing a midpoint. Each group reports median, min/max, quartiles and IQR using linear interpolation at `(n - 1) * p`. Unpaired usable values and categorical counts remain visible. S3 reports all assigned arms separately from fault-acknowledged arms with adequate recovery evidence in accepted rounds.

## Report files

| File | Contents |
| --- | --- |
| `integrity.json` | Artifact hashes and statuses, detected conflicts, ledger state and operator annotation references by ledger sequence |
| `inventory.json` | All pairs, rounds and arm histories, selection reasons, six metric dispositions and supporting evidence references |
| `matched-pairs.json` | Scenario flows, exact and bounded comparisons, descriptive statistics, categorical counts and S3 denominators |
| `provenance.json` | Manifest identity, seed, environment digests, analysis Git revision and source hashes, analysis timestamp, selection rules and limitations |
| `summary.md` | Human-readable descriptive summary |

The API accepts an explicit analysis Git revision and ISO timestamp for reproducibility tests. The CLI supplies those generation fields from Git and the current time. Report paths within the evidence are collection-relative, and raw controller output, notes, hostnames, and environment values are omitted.

## Remaining collection gates

Gate D must rehearse audit ingestion on actual runner output and confirm prospective clock evidence, intervention logging, environment snapshot capture and finalization across cleanup and recovery branches. Gate E must bind sanitized environment snapshots and executable and artifact digests to the authorized manifest or a separately approved provenance record, settle how an archived collection preserves or maps WP4's absolute paths, and define structured metric-scoped adjudication for cases outside the implemented review rules. An unverifiable provenance report cannot serve as a freeze certification.

## Rehearsal reports

WP5 accepts the dedicated WP4 `rehearsal` manifest and ledger. The `audit`, `inspect`, and `report` commands work with that directory at its recorded location. Rehearsal reports identify the nonformal session in the heading and provenance, and use `rehearsal-arms.json` for the individual inventory, metrics, outcomes, and safety state. They omit formal pair artifacts. Rehearsal trials are excluded from formal paired analysis even when the selected arms happen to include both workflows.
