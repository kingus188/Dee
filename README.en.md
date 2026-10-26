# Pi Durable Assistant · Xiao D

**A familiar face, a memory of your preferences, and an assistant that keeps working.**

Xiao D is a self-hosted personal AI assistant with an Electron desktop app, a web interface, and optional WeChat iLink and Teams message integrations. Give it a task through conversation, see its working state through an animated avatar, remember preferences, recall past work, and let longer tasks run in the background.

The project, **Pi Durable Assistant**, is built on [Pi Durable](https://github.com/earendil-works/pi). The avatar communicates activity; the durable Agent runtime handles execution. Work can continue after you close the browser, and recoverable tasks resume from persisted state after a server restart.

[简体中文](README.md) · [Getting started](docs/GETTING_STARTED.md) · [Desktop app](apps/desktop/README.md) · [Configuration](docs/CONFIGURATION.md) · [Architecture](docs/ARCHITECTURE.md)

[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-43853d?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![CI](https://github.com/kingus188/pi-durable-assistant/actions/workflows/v3-ci.yml/badge.svg)](https://github.com/kingus188/pi-durable-assistant/actions/workflows/v3-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> An experimental, single-user application. Today, interaction uses text and a two-dimensional animated avatar. Real-time voice, lip synchronization and photorealistic video avatars are not implemented.

## Core capabilities

A personal digital companion should be recognizable, make its activity understandable, and help you pick up where you left off.

- **Visible activity.** Expressions and short status messages reflect thinking, tool use, waiting, disconnection and recovery. Animation follows application state.
- **Preferences and history.** Assistant-proposed long-term memories and skills require approval before use. Separately, automatic summaries of web, WeChat and Teams history help recall context and open items; they can omit details and are not confirmed facts.
- **Work that continues.** Reminders, recurring plans and background tasks have persistent records. The server can keep working while you are away from the browser.
- **Sources you can check.** Search configured Obsidian notes in read-only mode. Work materials distinguish current documents, drafts and archives, with file and line citations.
- **Multiple ways to connect.** Desktop and browser clients use an independent Web service and the same API backend. Optional integrations add WeChat conversations and server-side Teams search and forwarding. Desktop no longer embeds a backend.
- **A personal space you manage.** Conversations, memory and task state are stored in your instance. You can stop tasks, manage memories, archive conversations and export chat text.

## Things to try

These examples require a real model. Results depend on the selected model and the relevant configuration.

| You might say | Current capability |
| --- | --- |
| “Remember that I prefer short answers with bullet points.” | Propose a long-term memory for your approval |
| “Remind me to stretch in ten minutes.” | Create a persistent reminder that returns to the conversation |
| “Save these ideas, then help me make a to-do list.” | Keep notes and todos for the current conversation |
| “Read this public webpage and summarize it in the background.” | Retrieve public webpage text and delegate suitable work to a background Agent |
| “Find the decision about this project in my notes, with sources.” | Search configured, allowlisted Obsidian folders with file and line citations |
| “Save these steps as a skill for similar work later.” | Propose a reusable procedure for approval; this does not retrain the model |
| “What happened with the issue we discussed on WeChat?” | Search collected cross-channel summaries, including dates, sources and open items |
| “Which Teams messages still need my reply?” | Search Teams messages collected by the backend; account configuration and permissions are required |

The web interface supports multiple conversations, conversation forks, streamed responses, and image/text attachments. Conversation cards manage tasks, reminders, memories and skills. An optional WeChat iLink bridge handles text and voice-transcription text provided by WeChat. Generic Webhooks and Feishu bots can deliver task notifications.

### Saving materials, Teams replies and coding tasks

- **Saving work materials:** Turn conversation content into a draft, approve it as current, and archive an older document with the same name.
- **Teams replies:** Show the target chat and draft, then send only after the user says `确认发送`. Requires backend account access and send permissions.
- **Coding tasks:** Run Codex or Claude Code in a separate git worktree for an allowlisted local repository, producing a report and branch. A local merge requires the user's `确认合并 <task ID>` message after review; tasks do not automatically push or deploy. The selected coding tool must be installed and authenticated separately.

## Run locally

Requires **Node.js ≥ 22.19**, pnpm 12.9.1 and Git. Chat and background tasks also require a working model service.

```bash
git clone https://github.com/kingus188/pi-durable-assistant.git
cd pi-durable-assistant
corepack enable
pnpm install --frozen-lockfile
```

**Backend:** Run `pnpm run build` once, then `pnpm run start:api` and open **http://127.0.0.1:3000**. The backend serves the built interface, APIs and WebSocket on the same origin.

**Optional Web gateway:** Run `pnpm run start:web` in another terminal and open **http://127.0.0.1:8080**. Set `API_ORIGIN` to change its backend URL.

**Desktop:** Keep the backend running, then run `pnpm run desktop`. Set `ASSISTANT_SERVER_URL` or use the desktop connection menu to choose the backend address. `ASSISTANT_WEB_URL` remains a legacy fallback.

Administrators configure models on the server through an `LLM_MODELS_FILE` catalog or the existing single-model `LLM_*` environment variables. Desktop and browser clients only enter the backend address and select a model published by that server. Model protocols, upstream URLs, model IDs and API keys stay server-side. Restart the backend after saving a selection. Without a model, the workspace remains available for managing data. Legacy SQLite model settings remain a fallback; see [Configuration](docs/CONFIGURATION.md).

The product does not offer simulated replies or a model-free fallback. Previous simulated conversations and legacy conversations without an explicit model remain stored, while real-model chat starts in a separate conversation.

Supported API protocols are `openai-completions`, `openai-responses` and `anthropic-messages`. Model availability, image understanding, costs and data handling depend on your provider. Knowledge search, notifications and WeChat need separate configuration; see [Configuration](docs/CONFIGURATION.md).

Desktop stores client connection settings only. Closing or quitting it does not stop backend tasks; quitting stops desktop notification polling. Run `pnpm run desktop:package` to produce a client-only application under `dist/desktop/`, without backend, Web assets or a WeChat binary. Distribution signing, notarization and automatic updates are not included. Existing desktop data is not automatically migrated; see the [desktop guide](apps/desktop/README.md).

## Keep Xiao D running

Background work needs a running server, or a process manager that restarts it after an exit. The included Docker Compose setup persists SQLite data and restarts the service automatically.

```bash
cp .env.example .env
# Configure a real model and a strong DEMO_PASSWORD
docker compose up -d --build
docker compose ps
```

The default address is **http://127.0.0.1:3300**. For remote access, use an HTTPS reverse proxy and retain authentication; the HTTP Basic Auth username is `demo`. Back up volumes before upgrading. **Do not use `docker compose down -v` to upgrade**, as it removes persistent data.

See [Deployment and backups](docs/DEPLOYMENT.md). WeChat requires a separate `wx-bot` service and QR-code login; desktop does not manage it. The [WeChat and Teams guide](docs/WECHAT.md) covers channel configuration. Detailed guides are primarily in Chinese.

## Current boundaries

- **Avatar and voice:** SVG/CSS animation is available. Real-time voice conversation, voice cloning, lip synchronization, Live2D and 3D model integration are not implemented.
- **Memory and data:** Self-hosting stores conversations and memory in your instance. Relevant messages, attachments and retrieved text may still be sent to an external model provider. Never commit `.env`, API keys or WeChat credentials.
- **Execution and recovery:** Recovery depends on persisted state and the task's recovery semantics. It does not guarantee exactly-once execution of arbitrary external operations. Recurring jobs use fixed-minute intervals, not timezone-aware calendar scheduling. Coding tasks are owned by the server process and stop on restart; committed branch changes remain available.
- **Delivery:** Generic Webhook and Feishu notifications use a SQLite outbox, resume after restart and retain failure records after at most five attempts per delivery round. Settings → Notification delivery shows the latest 100 records per status for the current destination and lets you requeue failed events with their original ID and payload. Delivery is not guaranteed or exactly-once; receivers should deduplicate by event ID. WeChat uses a separate persistent queue. Real Feishu, WeChat and production delivery need separate validation.
- **Attachments and access:** Web uploads allow 5 files, up to 5 MiB per image, 200 KiB per text file and 10 MiB total. WeChat images, videos and files are not parsed. Obsidian access is read-only. Material writes target the designated materials directory and coding changes target configured repository worktrees. General computer control is not provided.
- **Scope:** This is a personal application without tenant isolation or enterprise role management. Archiving stops that conversation's unfinished tasks. Removing it from the list does not erase all persisted records.

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

**TypeScript / React / Electron / Node.js / Pi Durable 1.3.0 / PostgreSQL (pgvector) / SQLite / WebSocket.** The project uses pnpm workspaces, `tsc` and esbuild. Business tasks and daily reports use PostgreSQL; Agent conversations, settings, notification outbox and other persistence remain in SQLite. The existing build command includes the web bundle.

| Directory | Responsibility |
| --- | --- |
| `apps/web` | Xiao D's avatar, conversation interface and interactions |
| `apps/desktop` | Electron API client, connection settings and system notifications |
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

Tests require reachable PostgreSQL via `DATABASE_URL`; Docker Compose starts `pgvector/pgvector:pg16`. See [Configuration](docs/CONFIGURATION.md).

`pnpm start` and `pnpm run dev` build first. `dev` restarts exited processes but does not watch source files; rebuild after editing. See [Architecture and development](docs/ARCHITECTURE.md) for workspace commands and dependency boundaries.

Automated tests cover simulated local models, APIs, persistence and recovery. They do not replace real-model, browser, WeChat or production deployment validation.

## Further reading

[Getting started](docs/GETTING_STARTED.md) · [Desktop app](apps/desktop/README.md) · [Configuration](docs/CONFIGURATION.md) · [Deployment](docs/DEPLOYMENT.md) · [WeChat and Teams](docs/WECHAT.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [v3 design record](docs/V3_PLAN.md) · [Knowledge requirements](docs/KNOWLEDGE_FEATURE_REQUIREMENTS.md)

Some guides describe the earlier Task Center interface and historical designs. Follow the interface in your running version; planned features are not evidence of implemented capabilities.

## License and acknowledgements

Based on [xiaomoBoy/pi-durable-assistant](https://github.com/xiaomoBoy/pi-durable-assistant), now maintained as an independent repository with the original copyright notice retained. [Pi Durable](https://github.com/earendil-works/pi) provides the persistence runtime.

Licensed under [MIT](LICENSE). This is not an official product of Pi Durable, WeChat or any model provider.
