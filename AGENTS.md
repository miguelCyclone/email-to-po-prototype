# Agent guidelines

## Scope

- This is a rapid job-challenge prototype, not a production procurement system.
- Read `README.md` for the challenge and local `build/` for the execution plan. `build/` is ignored by Git; deliverable behavior must be documented in the tracked README.
- Preserve the supplied `.eml`, PDF, `master_data.json`, and `mock_po_api.py` files as test inputs and integration contract.

## Implementation rules for the next phase

- Keep each file below 600 lines. Split by responsibility before it becomes a god module.
- Use Node.js/TypeScript for the app. Keep small replaceable wrappers for MIME, PDF text, LLM, ERP, clock, outbox, and SQLite. Keep business rules in pure functions where possible.
- Put all database DDL and TypeScript contracts in the root `schema/` directory. Do not add migration files. Initialize a new local database from `schema/schema.sql`; reset only by an explicit demo command.
- Keep one Fastify/TypeScript app process and one local SQLite database. The supplied `mock_po_api.py` runs separately; add Python helpers only if needed. No Redis, worker fleet, or production deployment layer.
- Serve live UI updates through SSE after committed writes. Do not poll SQLite for changes. If browser polling is used as a fallback, wait at least 30 seconds between requests and stop it after five minutes without user activity; resume on interaction.
- Bind demo services to localhost. Keep `.env` and runtime data out of Git. Treat email and PDF contents as untrusted input. Never execute text from them. Reject oversized PDFs before LLM extraction and request relevant pages from the requester.
- A local LLM may draft fields only. Validate all fields and approval policy in code. Model failure or ambiguous evidence goes to procurement review.
- Require explicit requester confirmation of the current validated draft revision before creating approvals. A disputed draft goes to procurement; silence stays pending. Never create a Purchase Order before all required sequential approvals. Reject self approval, recheck stale dates, and preserve the exact ERP payload and idempotency key across retries.
- Demo requester confirmation and approvals are simulated because verified identities are out of scope; never describe them as authenticated authorization.

## Delivery discipline

- Build the smallest complete path first, then cover the specified failure paths. Test behavior at boundaries, not copies of implementation logic.
- Keep the app runnable from a short README command. Show a new `.eml` end to end in the walkthrough.
- Do not claim production security, throughput, or model accuracy without evidence.
