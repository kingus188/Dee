# Execution records and result review

A conversation is the place where work is discussed. A task is a standing objective or schedule. A run is one execution or goal round. Run success, delivery and human acceptance are separate facts.

## Server task runs

`GET /api/conversations/:id/management` retains its existing fields and adds `runs`. This is a read model over existing durable delegate, background, schedule and goal records, not a replacement execution engine. Each record has a stable run ID, task ID, source conversation, worker conversation when known, outcome, recorded timestamps, result, evidence, cancellation and delivery state. Missing legacy metadata is shown as unknown rather than filled with a guessed timestamp.

The task page and conversation task details show these records under their original task. Results use the existing safe Markdown renderer, so links to produced documents or code can be inspected. Goal evidence remains the worker's reported evidence, not independent validation of a file or business operation. No artifact is inferred from a filename or a claim in model text.

For non-goal successful runs with results, the owner can accept or reject the result through `POST /api/conversations/:id/runs/review` with `runId`, the displayed `revision`, `decision` (`accepted` or `rejected`) and an optional `note`. The server rechecks the result fingerprint inside the transaction. A changed result invalidates the old acceptance. Repeating the same decision is idempotent; a conflicting decision against an already reviewed result is rejected rather than silently overwriting another tab. Review changes neither the execution outcome nor an external delivery status, and rejection does not automatically run tools again.

Goal rounds are inspectable, but the existing goal acceptance operation remains the only way to complete a goal. Accepting an individual research step must not silently complete its parent objective. Daylight task completion remains under its existing controls.

Delivery metadata describes the recorded destination, not every downstream side effect. In particular, syncing a Daylight result is not evidence that Teams, WeChat or email reached a person. A cancellation request does not prove an in-flight external operation was rolled back.

## Desktop Agent capabilities and handoff

Desktop snapshots describe implemented adapter capabilities: native resumption, approval protocol, cancellation mechanism, text history transfer and lack of context rollback. ACP/OMP resumption is unknown until protocol negotiation establishes it. Approval support does not override the selected permission mode.

Switching Agent records source/target, included message range, omitted count and whether the context is pending or submitted. Transfer includes complete recent text messages within a 48,000-character history budget. It excludes attachment bytes, live tool state and hidden reasoning. The new user instruction is preserved in full. Malformed legacy continuity data is reported without silently dropping history.

External desktop requests also expose per-request outcomes derived from their persisted request records and ordered messages. These use local session/request identifiers, not fabricated server conversation IDs. Legacy missing request status remains unknown. The desktop details distinguish this view from server task review; persistent human review and Pi per-submission projection are not currently supplied by this view.

## Verification boundary

Unit and integration tests use deterministic models and mocked external providers. Passing them does not establish real model quality, real message delivery, Electron native behavior or deployment success. Those require environment-specific acceptance.
