# Needs attention

The notification page includes a read-only “需要我处理” section. It derives items from indexed private Web and synchronized desktop conversations. Archived, removed, revoked, channel-bound and internal conversations are excluded; visibility is checked again after asynchronous reads.

`GET /api/workspace/attention` returns `items`, `total` and `truncated`. At most 200 items are returned, with pending archival first and recent recorded run times next. This is a projection, not another task database. Refreshing it does not retry result delivery, send messages, accept results or resume work.

Reasons are shown separately: `Waiting`, `Archive pending`, `Failed`, `Interrupted`, `Review pending`, `Delivery unknown`, `Delivery failed`, and `Stop pending`. A successful run alone is not an attention reason. Delivery refers only to the destination recorded by that run, including Daylight synchronization; it does not imply external Teams/WeChat/email delivery. This first view does not aggregate separate Teams outbox or self-chat ledgers. Completed historical failures remain reviewable at their source and are not silently treated as resolved.

`Review` opens the original conversation or its task management page. Existing source controls remain authoritative: archival retry/restore in the history list, result review and task controls in task details. No one-click retry is inferred for unknown side effects. Decisions must be made against current source data, not this periodically refreshed summary.

When capabilities, a handoff, an active execution or recorded runs are present, the desktop Agent details identify the local node, server connection and control boundary. Connection is not proof of transcript synchronization, so synchronization is shown as unknown when the snapshot supplies no acknowledgement. Unsynchronized local history is not controlled by server archival. Server run details identify server orchestration/record storage, not the actual environment of every nested tool.
