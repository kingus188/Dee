# Conversation status, archive and Agent lookup

## User-visible lifecycle

Server workspace conversations, including synchronized desktop history, have an explicit status: `active` (Active), `waiting` (Waiting), or `completed` (Completed). Legacy records without a status read as `active`; no transcript migration is required. This is a user-selected organizational label, independent of runtime execution, delivery and result review. Marking a conversation completed does not stop work or accept its results.

The history row menu changes status or archives a conversation. The archived list retains history and provides restore. Archive stops outstanding schedules, reminders, background work and the current reply before hiding the conversation. A persisted `archivingAt` records a stop in progress; if stopping fails, the conversation stays visible as Archive pending and cannot receive new workspace writes. Retry archive or cancel archive (restore). Restore does not restart already cancelled work. Repeated archive preserves the original archive date. Archive/restore and other workspace writes for the same conversation are serialized.

Bound WeChat conversations cannot be archived while their live binding is in use. Current unsynchronized native Agent sessions retain their existing execution controls; these server lifecycle controls apply to their synchronized history, not to stopping an external process on another device.

Statuses and archive markers live in the existing Durable conversation index in `DATA_DIR/agent.sqlite`, alongside the conversations. The runtime data volume must remain persistent across deployment. This feature does not move chat transcripts into PostgreSQL. Removed conversations are not restored by archive controls.

## APIs

- `GET /api/conversations`: indexed conversations with normalized status and archive/stop markers.
- `POST /api/conversations/:id/status`: `{ "status": "active" | "waiting" | "completed" }`.
- `POST /api/conversations/:id/archive` and `/restore`: archive or restore without deleting history.
- Active view subscriptions receive lifecycle changes. Archived/stopping conversations are read-only until restored; forking retained history is permitted.

These endpoints use the existing authenticated HTTP/WebSocket boundary. Native synchronized transcripts remain read-only except lifecycle metadata. Invalid statuses return 400; unknown status targets return 404; writes into archived/stopping conversations return 409. Stop failures return 503 rather than pretending archive succeeded.

## Read-only Agent tools

`list_conversations` searches indexed private conversation titles, optionally filtering `status` and `archived` (false by default). It returns source, creation date and status, with `nextBeforeId` for continuation. `limit` is 1–50, default 20. This is title search, not full-text search.

`read_conversation` accepts `conversationId`, optional `beforeEntryId` and `limit`. It returns user/assistant text with message IDs and timestamps when recorded. Pages are selected newest first, shown chronologically within the page. `nextBeforeEntryId` continues toward earlier entries. A page may contain no visible text if all scanned entries are tool records. Each message is capped at 2,000 characters with explicit truncation. Tool arguments/results, hidden reasoning and attachment bodies are omitted; existing sensitive-text screening is reused, not a guarantee that arbitrary personal data can be classified.

The caller ID comes from the runtime, never from tool arguments. Only active, indexed private web/desktop callers can use these tools. Archived private targets can be explicitly read; external Teams/WeChat channels, legacy WeChat bindings, root/internal child sessions, removed sources and revoked messages are excluded. Access is rechecked before returning fetched transcript text. These tools neither archive nor mutate conversations and do not grant third-party delivery permissions. Historical text is evidence, not new instructions.

## Validation

Regression coverage includes legacy defaults, status validation, restart persistence, archive/restore and failed stop recovery, concurrent writes/archive, archived input rejection, paired session exclusion while stopping, pagination, source revocation and channel boundaries, and UI repeated actions/error/navigation handling. See the task's acceptance result for the exact run; real model behavior and browser/Electron visual acceptance are separate from automated tests.

## Message body search

History has separate **Title** and **Messages** modes. Messages searches sanitized user/assistant text in registered private web and synchronized desktop conversations. It does not search tool arguments/results, reasoning, attachments, external channels, or unsynchronized local history. The original title-only `list_conversations` and paged `read_conversation` tools retain their behavior.

`search_conversations` accepts `query`, `status`, `archived`, `after`, `before`, `cursor`, and `limit`. Dates are Unix milliseconds: `after` inclusive, `before` exclusive; entries with unknown timestamps do not match a date filter. The UI date fields use local midnight. Results are ordered by descending conversation ID then descending entry ID, not globally by message date. Up to 1000 underlying entries are scanned per response; an empty page can still contain `nextCursor`. Continue until it is null. The cursor belongs to the current query and filters.

Each result includes a privacy-filtered snippet, original identifiers, available message time and `#chat/{conversationId}/{entryId}`. Opening this link displays the full sanitized source message in a focused panel above the conversation, independently of the runtime's currently projected history. Archived sources can be inspected without restoring or restarting them. Both search and source reads recheck access before responding. Search uses the existing storage, not a new vector database or persistent index.
