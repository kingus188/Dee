# Selected result files

Completed server-to-desktop delegated tasks can share a result file through the native desktop file picker. In **Completed peer tasks**, choose **Share selected file**. Opening the picker is not a workspace scan: only the one selected regular file is read. The Agent cannot invoke this picker through its tools. Links, directories, oversized files, and files changing during the read are rejected. Cancelling the picker uploads nothing.

On the server web or mobile workspace, open **Tasks → Result files** to list and download previously shared files. This read does not wake the desktop, run the task, or upload more files. Downloads work when the producing desktop is offline. The list shows filename, MIME type, size, status, device, task and SHA256. Desktop-selected files intentionally use `application/octet-stream`; content is not sniffed or rendered inline. HTTP downloads require the server's normal authentication and are sent as attachments with `nosniff` and no-store caching. A server configured with only a peer token and no browser password does not expose the files to anonymous browser users.

Files are stored in the server's durable document store, separately from conversation sync. Switching a conversation to Local only or Summary & results does not remove already shared files. Back up the server data directory. Only the completed task's execution device may upload, and device IDs are checked against task participants. As with the existing peer API, the pairing credential is instance-wide, not cryptographic isolation between independently trusted devices.

Limits: 1 MiB per file, 5 files per task, 500 files and 50 MiB total per instance. There is no automatic eviction. Upload requests carry explicit IDs and reject reuse with conflicting content or metadata; matching retries are idempotent. Server validation checks byte count, canonical base64 and SHA256 before committing. A failed or unconfirmed upload is not reported as successful. Sharing after switching servers is rejected until the original server is selected again.

APIs (existing peer authentication applies):

- `POST /api/peers/tasks/:taskId/artifacts`: explicit file payload with device ID, UUID, name, MIME type, size, SHA256 and base64 data.
- `GET /api/peers/artifacts`: metadata only, for the single-user instance's result-file list.
- `GET /api/peers/tasks/:taskId/artifacts?deviceId=...`: task metadata only.
- `GET /api/peers/tasks/:taskId/artifacts/:artifactId?deviceId=...`: stored metadata and bytes for a participant.
- Add `&download=1` to the last HTTP route for a binary attachment response.

This version covers explicitly selected outputs of desktop tasks delegated from the server. It does not automatically collect server execution outputs, upload whole workspaces, delete existing shared artifacts, or guarantee content is free of secrets or malicious code. Review the selected file before sharing it.
