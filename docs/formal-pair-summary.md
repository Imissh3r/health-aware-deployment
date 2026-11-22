# Formal pair summary

Status — Companion to the [formal protocol V1](formal-paired-trial-protocol.md).

## Execution manifest

Use a JSON file with `schema_version: 2` and a `pairs` array. Give each pair a
unique `pair_id` and an `assigned_order` of `AB` or `BA`. List its `rounds`
in execution order. Each round has a `round_id` unique within that pair and
two `attempts`, one per arm in the assigned order. Reserve both globally
unique `trial_id` values before running the round. Version 1 attempt records
from the recorder are the inputs to this manifest.

```json
{
  "schema_version": 2,
  "pairs": [
    {
      "pair_id": "pair-01",
      "assigned_order": "AB",
      "rounds": [
        {
          "round_id": "round-01",
          "attempts": [
            { "arm": "A", "trial_id": "pair-01-r01-a" },
            { "arm": "B", "trial_id": "pair-01-r01-b" }
          ]
        }
      ]
    }
  ]
}
```

When the protocol permits a retry after technical invalidity, append a new
round for the same pair and reserve two fresh trial IDs in its assigned arm
order. Preserve the earlier rounds and immutable attempt records.

If an assigned arm was skipped or an interruption left no publishable
bundle, retain any available evidence and document the disposition on its
manifest entry before advancing. Use a `disposition` object with `status`
`not_run` or `interrupted_without_bundle` and a nonempty `reason`. This
excludes the round from selection while keeping the reserved trial ID in the
history. A disposition and an attempt record for that ID require review.

If an attempt ends with a failed reset, pause and reconcile the environment
before the next arm. Resume in manifest order after the starting-condition
checks pass. Preserve the completed attempt's V1 validity assessment. A reset
failure after completion is an operational hold on the next arm.

## Selection and reporting

- Select both arms from the first round in manifest order with two V1-valid
  attempts. Valid unknown cutoff outcomes and verified late recoveries remain
  eligible. Retain every round in the history.
- Flag attempts recorded in later rounds after a valid round and V1
  evidence conflicts for review. Preserve the first valid round in those cases.
- If an earlier round has an undocumented missing record, hold the pair as
  unresolved when a later valid round exists. Missing or conflicting manifest
  assignments also leave the affected pairs unresolved.
- A pair is complete when it has a selected round. Each selected attempt
  contributes one V1 cutoff outcome to its arm's counts. The supplemental
  `verified_late` count is a subset of `unknown` and records verified recovery
  at or after 60 s. Those attempts already count toward the complete-pair
  denominator.

Read the manifest and immutable attempt records with:

```bash
node tools/experiments/summarize-formal-pairs.mjs PATH_TO_MANIFEST experiments/results/formal-attempts
```

The command prints schema version 2 JSON to standard output. Each pair
summary includes its selected round ID, both selected attempts, the history
grouped by round, and review flags.
