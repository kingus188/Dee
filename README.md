# Dee · Xiao D

**A familiar face, a memory of your preferences, and an assistant that keeps working.**

Xiao D is a self-hosted personal AI assistant with an Electron desktop app and a web workspace. It can connect to WeChat iLink and Teams, and can read Microsoft 365 mail when configured. Give it work through conversation, see its current state through an animated avatar, keep long-term context under your control, and let durable tasks continue in the background.

The project, **Dee**, is built on [Pi Durable](https://github.com/earendil-works/pi). The avatar communicates activity; the durable Agent runtime handles execution. Work can continue after you close the browser, and recoverable tasks resume from persisted state after a server restart.

[简体中文](README.zh-CN.md) · [Getting started](docs/GETTING_STARTED.md) · [Desktop app](apps/desktop/README.md) · [Configuration](docs/CONFIGURATION.md) · [Architecture](docs/ARCHITECTURE.md)

[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-43853d?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![CI](https://github.com/kingus188/Dee/actions/workflows/v3-ci.yml/badge.svg)](https://github.com/kingus188/Dee/actions/workflows/v3-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> An experimental, single-user application. Today, interaction uses text and a two-dimensional animated avatar. Real-time voice, lip synchronization and photorealistic video avatars are not implemented.

## Core capabilities

A personal digital companion should be recognizable, make its activity understandable, and help you pick up where you left off.

- **Visible activity.** Expressions and short status messages reflect thinking, tool use, waiting, disconnection and recovery. Animation follows application state.
- **Preferences and history.** Assistant-proposed long-term memories and skills wait for approval before they take effect. Approved memories retain verifiable source messages and recent history. Automatic summaries of web, WeChat and Teams history help recall context and open items; they may omit details and are not confirmed facts.
- **Work that continues.** Reminders, daily, weekly and monthly calendar schedules, and background tasks have persistent records. Each run keeps its status, response, failure reason and timestamps. Daylight executions become pending review after a successful result.
- **Sources you can check.** Search configured Obsidian notes in read-only mode. Work materials distinguish current documents, drafts and archives, with file and line citations.
- **Multiple ways to connect.** Desktop and browser clients use the same backend through its API and WebSocket. Optional integrations add WeChat conversations, Teams history and selected Teams forwarding, plus read-only Outlook mail access.
- **A personal space you manage.** Conversations, memory, skills, notes, daily reports and task state stay in your instance. You can stop tasks, manage memories, archive conversations and export chat text.

## Workspace

The new workspace design keeps today’s work and long-term personal context in one place:

- **Today:** See current todos, task activity, reminders and items that need follow-up.
- **Chat:** Continue multi-turn conversations with streamed replies, tool activity, attachments and result cards. Fork a conversation when you need a separate path.
- **Tasks:** Use Daylight for projects, tasks, calendar views, priorities, tags, subtasks and rich-text notes. A task can be handed to Xiao D; successful results wait for your confirmation before the task is completed.
- **Notifications:** Review background jobs, reminders, schedules and external delivery activity, including failure records and unread state.
- **Personal space:** Manage long-term memory, local skills, notes, daily reports, tasks and reminders, plus connection and model settings.

The interface uses one primary navigation. Chat keeps the avatar and conversation in focus; management pages use compact white workspace layouts. On narrow screens, open the navigation to reach the full menu. The editor uses one Markdown, preview and structured-editing workflow, and keeps unsaved drafts while you move between pages.

## Things to try

These examples require a real model. Results depend on the selected model and the relevant configuration.

| You might say | Current capability |
| --- | --- |
| “Remember that I prefer short answers with bullet points.” | Propose a long-term memory for your approval |
| “Remind me to stretch in ten minutes.” | Create a persistent reminder that returns to the conversation |
| “Save these ideas, then help me make a to-do list.” | Keep notes in the conversation and put shared todos in Daylight |
| “Read this public webpage and summarize it in the background.” | Retrieve public webpage text and delegate suitable work to a background Agent |
| “Find the decision about this project in my notes, with sources.” | Search configured, allowlisted Obsidian folders with file and line citations |
| “Save these steps as a skill for similar work later.” | Propose a reusable procedure for approval; this does not retrain the model |
| “What happened with the issue we discussed on WeChat?” | Search collected cross-channel summaries, including dates, sources and open items |
| “Which Teams messages still need my reply?” | Search Teams messages collected by the backend; account configuration and permissions are required |
| “Show me today’s Outlook mail and read Zhang’s quotation.” | Query and read mail from the configured Microsoft 365 inbox; this is read-only |

The web interface supports multiple conversations, conversation forks, streamed replies, and image and text attachments. The fixed workspace pages are Today, Daylight tasks, notifications, long-term memory, notes, local skills, daily reports, tasks and reminders, and settings. They do not display a chat composer. Notes, memories, remote skill records, reminders, schedules, background task instructions, daily reports and Daylight notes use the shared Tiptap document editor with Markdown source editing, nested lists and task lists, tables, formulas, code highlighting, images and footnotes.

Opening, reading or switching editor modes does not rewrite the original text. Unchanged blocks keep their original Markdown; changed structures are serialized as Markdown. Source whitespace and line breaks are preserved where possible, and undo can return to the original source. Concurrent edits reject stale writes so the current text can be copied, reloaded and merged.

Daylight stores projects and tasks in PostgreSQL and provides board, list and calendar views, priorities, due dates, labels, subtasks, drag sorting and rich-text notes. Agent tools and the UI use the same global data. Legacy SQLite Daylight data is imported once and retained as a read-only source. Older conversation todos are migrated once into a matching “History” project. The migration is idempotent.

Daily reports provide one Markdown page per date with editing, preview, save, calendar navigation and history. Reports do not require a model and are stored in PostgreSQL. Unsaved drafts remain when navigating inside the workspace; leaving or refreshing still requires saving. Concurrent edits are rejected instead of silently overwriting newer content. Legacy SQLite reports are imported once and the source file is retained as a backup.

Outlook mail is synchronized by the backend and shared by the desktop and browser clients. Configure `MAIL_ACCOUNT_FILE`, or use device-code sign-in under Settings → Outlook mail when available. The first sync covers roughly the last 30 days without alerting for historical messages; later syncs are incremental. The product does not send mail, change read state or download attachments.

### Durable personal goals

You can ask Xiao D to “organize the materials for project A and report conclusions, sources and missing information.” `start_goal` saves the objective and acceptance criteria, then proceeds in rounds with evidence. When information is missing, the same goal waits for your input and resumes through `control_goal`; timed waits survive server restarts. Workers can only query materials, mail, Teams and tasks. They cannot send messages, delete data or change business records, and their internal steps do not become global todos. A delivered result enters pending review and is completed only after you accept it. Status reports are appended as passive messages without triggering another tool run in the main conversation. Tasks and reminders, and conversation cards, show progress, evidence, acceptance and cancellation controls.

Goals default to 12 rounds (configurable from 1 to 24), expire within 24 hours (a shorter limit can be set), and allow up to 5 minutes of active work per round. Each goal has a provider-reported budget of 50,000 tokens; usage from workers started before cancellation or a requirement change still counts, and an in-flight request can exceed the limit. At most 3 goals run at once. Repeated progress, a missing checkpoint, exhausted limits or an inability to continue stop execution with an explanation. User updates use revision checks, and cancelled goals cannot restart automatically. User input and timed wake-ups are supported; new mail or Teams messages do not directly resume goals. Real-model judgments and cited content still require your review. APIs: `GET /api/goals`, `POST /api/conversations/:id/goals` and `POST /api/goals/:id/{resume,cancel,accept}`. Control requests require the current `revision`; `resume` also requires the user's additional `input`.

### Saving materials, Teams replies and coding tasks

- **Saving work materials:** Turn conversation content into a draft, approve it as current, and archive an older document with the same name.
- **Teams replies:** Show the target chat and reply draft, then send only after the user says `确认发送`. Requires backend account access and send permissions.
- **Coding tasks:** Run Codex or Claude Code in a separate git worktree for an allowlisted local repository, producing a report and branch. A local merge requires the user's `确认合并 <task ID>` message after review; tasks do not automatically push or deploy. The selected coding tool must be installed and authenticated separately.

## Run locally

Requires **Node.js ≥ 22.19**, pnpm 12.9.1 and Git. Chat and background tasks also require a working model service. A PostgreSQL connection is required for Daylight tasks and daily reports.

```bash
git clone https://github.com/kingus188/Dee.git
cd Dee
corepack enable
pnpm install --frozen-lockfile
```

**Backend:** Build once, then start the API:

```bash
pnpm run build
pnpm run start:api
```

Open **http://127.0.0.1:3000**. The backend serves the built interface, HTTP API and WebSocket on the same origin.

**Optional Web gateway:** Run `pnpm run start:web` in another terminal and open **http://127.0.0.1:8080**. Set `API_ORIGIN` to change its backend URL.

**Desktop:** Keep the backend running, then run `pnpm run desktop`. Set `ASSISTANT_SERVER_URL` or use the desktop connection menu to choose the backend address. `ASSISTANT_WEB_URL` remains a legacy fallback. The desktop client stores connection settings and system-notification state; it does not embed or start the backend.

Administrators configure models on the server through an `LLM_MODELS_FILE` catalog or the existing single-model `LLM_*` environment variables. Desktop and browser clients only enter the backend address and select a model published by that server. Provider details, upstream URLs, model IDs and API keys stay server-side. Restart the backend after saving a selection. Without a model, you can still manage Daylight, notes, memory, skills and daily reports; chat and generated tasks wait for model configuration.

Supported API protocols are `openai-completions`, `openai-responses` and `anthropic-messages`. Model availability, image understanding, costs and data handling depend on your provider. Knowledge search, notifications, Outlook, Teams and WeChat need separate configuration; see [Configuration](docs/CONFIGURATION.md).

Run `pnpm run desktop:package` to produce a client-only application under `dist/desktop/`, without the backend, web assets or WeChat binary. Distribution signing, notarization and automatic updates are not included. Existing desktop data is not automatically migrated; see the [desktop guide](apps/desktop/README.md).

## Keep Xiao D running

Background work needs a running server, or a process manager that restarts it after an exit. The included Docker Compose setup persists PostgreSQL business data and SQLite Agent data, and restarts the service automatically.

```bash
cp .env.example .env
# Configure a real model, database and a strong DEMO_PASSWORD password
docker compose up -d --build
docker compose ps
```

The default address is **http://127.0.0.1:3300**. For remote access, use an HTTPS reverse proxy and retain authentication; the HTTP Basic Auth username is `demo`. Back up both the PostgreSQL business database and SQLite data before upgrading. **Do not use `docker compose down -v` to upgrade**, as it removes persistent data.

See [Deployment and backups](docs/DEPLOYMENT.md). WeChat requires a separate `wx-bot` service and QR-code login; the desktop client does not manage it. The [WeChat and Teams guide](docs/WECHAT.md) covers channel configuration. Detailed guides are primarily in Chinese.

The existing server is available at the reserved, fixed address **<https://xiaod.vip.cpolar.cn>**. Sign in as `demo` with your existing credentials. Switching hostnames requires a fresh sign-in; your credentials are unchanged. Protected browser sessions support WebSocket access through cpolar. See the [current cpolar deployment](docs/DEPLOYMENT.md#7-直接使用-cpolar-公网访问2026-10-26) for configuration and operations.

## Current boundaries

- **Avatar and voice:** SVG/CSS animation is available. Real-time voice conversation, voice cloning, lip synchronization, Live2D and 3D model integration are not implemented.
- **Memory and data:** Self-hosting stores conversations and memory in your instance. Relevant messages, attachments and retrieved text may still be sent to an external model provider. Never commit `.env`, API keys or WeChat credentials.
- **Execution and recovery:** Recovery depends on persisted state and the task's recovery semantics. It does not guarantee exactly-once execution of arbitrary external operations. Calendar schedules use their configured IANA timezone: nonexistent daylight-saving times are skipped, repeated times run once at the earlier occurrence, and the 31st is skipped in months without that date. Each run records its answer separately from the fact that it was triggered. Coding tasks are owned by the server process and stop on restart; committed branch changes remain available.
- **Delivery:** Generic Webhook and Feishu notifications use a persistent outbox, resume after restart and retain failure records after bounded retries. Quiet hours keep events queued until delivery is allowed. Notification read state synchronizes through the server, while offline changes wait locally for a later sync. Receivers should deduplicate by event ID. WeChat uses a separate persistent queue. Real Feishu, WeChat and production delivery need separate validation.
- **Attachments and access:** Web uploads allow up to 5 files: 5 MiB per image, 200 KiB per UTF-8 text file, 5 MiB per PDF or DOCX, and 10 MiB total. Document extraction is limited to 100,000 characters and reports page or section references; scanned-PDF OCR is not included. The server needs `pdftotext`; DOCX extraction also needs `/usr/bin/unzip` and `/usr/bin/xsltproc`. WeChat media is not parsed. Obsidian access is read-only. Material writes target the designated materials directory and coding changes target configured repository worktrees. General computer control is not provided.
- **Scope:** This is a personal application without tenant isolation or enterprise role management. Archiving stops that conversation's unfinished tasks. Removing a conversation from the list does not erase all persisted records.

## Direction

Future work focuses on identity, expression and sustained collaboration. These are **product directions, not shipped features or delivery commitments**.

| Direction | Intended experience |
| --- | --- |
| Configurable identity | Choose a name, appearance and communication style that remain consistent across conversations |
| Voice interaction | Speak, hear replies and interrupt while keeping task state coherent |
| Richer expression | Coordinate expressions, motion and lip movement with conversation and execution events |
| Reviewable collaboration | Understand memory sources, authorization boundaries and task progress; correct or revoke them |
| Continuity across channels | Continue work between the web and messaging channels, with better delivery and permission controls |

## Development

**TypeScript / React / Electron / Node.js / Pi Durable 1.3.0 / PostgreSQL (pgvector) / SQLite / WebSocket.** The project uses pnpm workspaces, `tsc` and esbuild. Daylight tasks and daily reports use PostgreSQL; Agent conversations, settings, notification outbox and other runtime persistence remain in SQLite. The build command includes the web bundle.

| Directory | Responsibility |
| --- | --- |
| `apps/web` | Xiao D's avatar, workspace, conversation interface and interactions |
| `apps/desktop` | Electron API client, connection settings, local skills and system notifications |
| `apps/server` | API backend, data, task scheduling and messaging integrations |
| `packages/contracts` | Shared frontend/backend protocol types |
| `packages/runtime` | Model integration, sessions and the durable runtime |
| `packages/features` | Memory, skills, materials, knowledge search, reminders, tasks and Teams tools |
| `packages/channel-wechat` | WeChat message handling and the persistent delivery queue |
| `tests/integration` | Cross-module API and recovery verification |

```bash
pnpm run check
pnpm --recursive --workspace-concurrency=1 run build
pnpm test
```

Tests require a reachable PostgreSQL instance through `DATABASE_URL`; Docker Compose starts `pgvector/pgvector:pg16`. See [Configuration](docs/CONFIGURATION.md).

`pnpm start` and `pnpm run dev` build first. `dev` restarts exited processes but does not watch source files; rebuild after editing. See [Architecture and development](docs/ARCHITECTURE.md) for workspace commands and dependency boundaries.

Automated tests cover local simulated models, APIs, persistence and recovery. They do not replace real-model, browser, desktop, WeChat, Teams or production deployment validation.

## Further reading

[Getting started](docs/GETTING_STARTED.md) · [Desktop app](apps/desktop/README.md) · [Configuration](docs/CONFIGURATION.md) · [Deployment](docs/DEPLOYMENT.md) · [WeChat and Teams](docs/WECHAT.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [v3 design record](docs/V3_PLAN.md) · [Knowledge requirements](docs/KNOWLEDGE_FEATURE_REQUIREMENTS.md)

Some guides describe earlier Task Center interfaces and historical designs. Follow the interface in your running version; planned features are not evidence of implemented capabilities.

## License and acknowledgements

Based on [xiaomoBoy/pi-durable-assistant](https://github.com/xiaomoBoy/pi-durable-assistant), now maintained as an independent repository with the original copyright notice retained. [Pi Durable](https://github.com/earendil-works/pi) provides the persistence runtime.

Licensed under [MIT](LICENSE). This is not an official product of Pi Durable, WeChat or any model provider.
