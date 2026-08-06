# Stable coding conventions

- Prefer graph-aware code discovery (`search_graph`, `trace_path`, `get_code_snippet`) before text search; use grep/glob for configs, literals, and non-code files.
- Routes do not reach directly into DB; inject dependencies and call domain functions. Keep authorization in domain/API boundaries, not only UI.
- Control-plane graph advancement and run finalization are transactional and centralized; scheduling must not infer terminal Run outcome from a StepRun outcome.
- Lease/result protocol is idempotent by lease token. Preserve explicit distinctions such as `failed` vs `skipped`, `unknown_leases` vs `cancel`, and `awaiting-human` without a lease.
- Blob flows are presigned and metadata-only through control plane: upload first, then record metadata. Never put secret/blob bytes in Postgres or URLs.
- Pipeline/output/question schemas live in `@factory/shared` and are reused as runner feedback gates and control-plane authoritative gates.
- Use migrations for schema changes and regenerate committed OpenAPI after route/schema changes. Keep generated artifacts synchronized.
- Prose is not restricted to ASCII: doc comments quote the Indonesian spec verbatim and use em dashes and typographic quotes throughout. Do not "fix" that. Identifiers stay ASCII.
- Comments explain why — a constraint, an invariant, a hazard, a non-obvious ordering. They never restate what the code does, and never reference a ticket, an issue number, a PR, or a scratch transcript: that context belongs in the commit message, which survives the code it describes.
- Commit messages are written in Indonesian.
- Never commit credentials or a real `.env`. A committed `.env.example` is a template with empty values and is expected; secret material never rides an environment variable, only the *path* to a file does (`*_FILE`).