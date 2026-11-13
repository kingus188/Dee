# Personal notes persistence

The workspace **Notes** page is an instance-wide personal notebook stored in PostgreSQL
(`assistant.personal_notes` in normal deployments). It no longer selects a conversation,
creates one, or depends on a browser tab or the runtime's numeric conversation ID.
Both HTTP and WebSocket use `/api/notes`; writes compare a revision and conflict rather
than overwrite another page's changes. Single-note edits send only the changed text.
`/api/notes/export.md` exports the personal notebook, not a conversation transcript.

## Upgrade and existing notes

Before resuming runtime work, startup copies the current notes from conversations still
listed in the runtime index (including archived conversations). It preserves the SQLite
source, never deletes it, and atomically appends notes plus import markers in PostgreSQL.
A conversation ID and its original creation timestamp identify each source; repeated
startup or restoring that same runtime directory does not re-import already copied notes.
Removed conversations are not recovered automatically. There is no silent truncation of
historical text. Libraries larger than today's creation limit remain readable/exportable
and existing notes can be shortened or edited individually. New notes still enforce the
1000-note / 128000-character creation quota, and new or edited text is at most 16000 characters.
Malformed legacy data fails migration visibly and rolls it back, rather than marking it imported.

Conversation `memo` tools and `/api/conversations/:id/notes` remain conversation-scoped
Durable memo records in `DATA_DIR/agent.sqlite`. They are not a second writer for the
personal notebook. After a source has been imported once, subsequent changes to that
conversation memo do not overwrite the independent personal notebook. The assistant's
conversation context does not automatically receive all personal notebook contents.

## Deployment and recovery

Keep the same PostgreSQL database/schema and preserve its volume and backups when
replacing the application container. Losing or switching that database can still lose
or hide personal notes. Also preserve `DATA_DIR` for conversations, runtime execution,
conversation memos, integrations and any legacy notes not yet migrated. The supplied
Compose setup mounts both the PostgreSQL and `/data` named volumes. Do not use
`docker compose down -v` as an upgrade procedure.

Older versions already persisted notes, but in SQLite and under the selected conversation.
A different/new conversation can therefore show an empty list even if the original notes
still exist. If the old runtime volume or backup survives, start the upgraded server with
that runtime data and the intended PostgreSQL database to import it once. Back up both
first. If the SQLite files were deleted without a backup before this migration, this fix
cannot recreate their content. Do not attach unrelated runtime databases or delete import
markers to force a retry: that may import duplicates. Inspect and reconcile deliberately.

Verification uses isolated PostgreSQL, simulated loss of the runtime directory and a
server restart. It does not establish the user's actual production volume configuration
or whether missing historical data remains recoverable.
