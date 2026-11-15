# Cross-device result review

Peer execution and result delivery are separate. Disconnecting a desktop does not confirm cancellation; the source retains a cancellation request until the execution side confirms it. A completed task is not replayed on reconnect.

## Selected result files

Only files explicitly chosen through the desktop file picker are shared. A completed local peer task owns the selection. The server stores bytes and metadata, validates SHA-256 and size, and serves downloads as attachments behind existing authentication. Limits are 1 MiB per file, five files per task, 500 files / 50 MiB per instance. Symlinks and non-regular files are rejected. This is not workspace synchronization. Existing pairing credentials are instance-wide, not independent per-device security identities.

## Summary drafts

Generate draft uses the configured Pi model provider and the visible conversation text. The provider may be remote even in Local only mode. Generation does not change sharing scope or publish anything to the Dee server. Review/edit the draft, select Summary & results, and explicitly publish. Publishing a generated draft checks the source conversation revision again. Later conversation messages are not automatically included in a published summary. Full conversation and previously shared data retain their existing semantics.

## Native result review

Completed native requests support Accept / Reject and an optional reason. The decision binds the session, request and recorded text result hash with an optimistic review revision; history is durable. It is not proof of workspace file contents. Reject records a decision only: it does not send, retry or rerun the request. Pi does not yet expose equivalent per-request result records and is explicitly unsupported.

## Progress diagnostics

Native active execution shows elapsed time, time since the last observed provider output/activity/approval request, and the running tool step when reported. Polling is not a provider heartbeat. Two minutes without events displays an observation, not failure detection. Approvals remain a distinct wait state. Peer jobs display age of the last recorded state, not a heartbeat. No diagnostic automatically retries execution. Pi timing is unavailable rather than inferred.

## Validation boundary

Automated transport checks use real loopback HTTP/WebSocket, separate server/desktop instances and synthetic native processes/model responses. They cover approval before execution, disconnected cancellation pending, reconnection confirmation, and no replay. They do not replace mobile → deployed server → physical Electron → real provider acceptance. That final acceptance requires a connected user desktop, browser access, a configured provider and explicit selection of non-sensitive test files.
