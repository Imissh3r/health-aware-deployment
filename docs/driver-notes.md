# Driver implementation notes

Validation rules added in code beyond spec v0.1. To be folded into v0.2.

- `--run-id` may contain only letters, digits, dot, dash and underscore.
- `--warmup` must be less than `--duration`.
- `--url` must use http or https.
- `--max-lateness` accepts positive decimal numbers; zero is rejected.
- `rate x duration` must be a safe integer of at most 1,000,000 (a typo guard,
  not an experimental threshold).
- Repeated options are rejected (Node's parseArgs would otherwise silently keep
  the last value).
- Default run IDs are `run-<UTC timestamp>-<4 hex characters>`.
- Run directories are created exclusively (no `recursive`), so creation itself
  fails if the directory already exists.