# ⚡️ FileFlow: Distributed Multimedia Pipeline & Autonomous Operations Agent

**Live Production App:** [https://file-flow-test.vercel.app](https://file-flow-test.vercel.app)  
**Operations Agent Console:** [https://file-flow-test.vercel.app/operator](https://file-flow-test.vercel.app/operator)  
**MCPx Control Plane:** [https://mcpx-mcpx-web.vercel.app](https://mcpx-mcpx-web.vercel.app)  
**Architecture Deep Dive:** [View ARCHITECTURE.md](./ARCHITECTURE.md)

FileFlow is a distributed, asynchronous file processing platform and autonomous operations control plane built to handle multimedia uploads (images, PDFs, videos) without bottlenecking the API gateway. It combines direct-to-storage presigned uploads, asynchronous Redis worker queues, real-time Server-Sent Events (SSE) status updates, and a **governed Autonomous AI Operations Agent** for self-healing queue recovery and reliable multi-service workspace provisioning via **MCPx**.

---

## 🎯 What FileFlow Does

1. **Direct Storage Ingestion:** The browser transfers files directly to S3-compatible object storage via short-lived presigned PUT URLs, completely bypassing the API server for heavy data transfers.
2. **Asynchronous Message Broker:** BullMQ and Redis route processing tasks to dedicated background worker processes with type-specific concurrency limits (Images: 10, PDFs: 5, Videos: 2).
3. **Real-Time Push Observability:** Server-Sent Events (SSE) stream live state transitions to the browser as workers claim, transform, and complete jobs.
4. **Autonomous AI Operations Agent (`OBSERVE -> DECIDE -> ACT/PROPOSE -> VERIFY`):** A supervised agent monitors Redis worker heartbeats, BullMQ queue depths, and DLQ errors. It autonomously executes low-risk DLQ failure replays and proposes governed, human-approved multi-service workspace operations.
5. **Reliable WebMCP Orchestration via MCPx:** Consequential multi-step workspace operations are coordinated across 4 independent WebMCP reference services with DAG execution, Saga reverse compensations on failure, and atomic PostgreSQL state tracking.

---

## 🏗 System Architecture & Operations Loop

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Frontend (Next.js 14)                           │
│   /login  ·  /register  ·  /upload  ·  /uploads  ·  /admin  ·  /operator    │
└───────────────────────┬───────────────────────────────┬─────────────────────┘
                        │ HTTP / SSE                    │ Propose / Approve
                        ▼                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Express Backend API (:4000)                          │
│  Auth  · Presigned S3  · Admin & DLQ APIs  · SSE Stream  · Operations Agent │
└────────┬──────────────────────────┬───────────────────────────┬─────────────┘
         │ SQL (pg)                 │ BullMQ Jobs               │ @mcpxx/sdk
         ▼                          ▼                           ▼
┌─────────────────┐        ┌──────────────────┐       ┌───────────────────────┐
│   PostgreSQL    │        │  Redis / BullMQ  │       │   MCPx Coordinator    │
│  users          │        │  image-queue     │       │  Saga Compensations   │
│  uploads        │        │  pdf-queue       │       │  PostgreSQL Durability│
│  workspaces     │        │  video-queue     │       └───────────┬───────────┘
└─────────────────┘        │  dlq-queue       │                   │ WebMCP Tools
                           │  worker:heartbeat│                   ▼
                           └────────┬─────────┘       ┌───────────────────────┐
                                    │ BullMQ Poll     │ 4 WebMCP Microservices│
                                    ▼                 │ Routing · Database    │
                           ┌──────────────────┐       │ Compute · Frontend    │
                           │ Background Worker│       └───────────────────────┘
                           │ Sharp · FFmpeg   │
                           │ pdf-lib          │
                           └────────┬─────────┘
                                    │ GetObject / PutObject
                                    ▼
                           ┌──────────────────┐
                           │ S3 / Cloudflare  │
                           │ raw / processed  │
                           └──────────────────┘
```

---

## 🤖 The Autonomous Operations Agent

The FileFlow Operations Agent runs on a continuous supervision loop to keep the processing pipeline healthy:

```
                  ┌──────────────────────────────┐
                  │       PERSISTENT GOAL        │
                  │ "Keep pipeline healthy and   │
                  │ recover failed jobs while    │
                  │ requiring human approval for │
                  │ workspace operations"        │
                  └──────────────┬───────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. OBSERVE (GET /agent/observe)                                 │
│    • Redis Worker Heartbeat (TTL 30s)                           │
│    • BullMQ queue depths (image, pdf, video, dlq)               │
│    • PostgreSQL pending & failed upload records                 │
│    • Latest MCPx workspace provisioned state                    │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. DECIDE (POST /agent/evaluate via Gemini 2.0 Flash)           │
│    ├── Pipeline Healthy  ──► NO_ACTION_REQUIRED                 │
│    ├── DLQ Failed Job    ──► AUTONOMOUS_ACTION (replay_failed)  │
│    ├── Worker Offline    ──► BLOCKED (awaiting worker reboot)   │
│    └── Workspace Needed  ──► PROPOSAL_REQUIRED (request approval)│
└────────────────────────────────┬────────────────────────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
┌────────────────────────────────┐ ┌──────────────────────────────┐
│ 3A. AUTONOMOUS ACTION          │ │ 3B. GOVERNED PROPOSAL        │
│ • Replay eligible DLQ job      │ │ • Request human confirmation │
│ • Atomic DB state transition   │ │ • Execute MCPx DAG on approval│
│ • Worker consumes & processes  │ │ • Reverse compensation on fail│
└────────────────┬───────────────┘ └──────────────┬───────────────┘
                 │                                │
                 └───────────────┬────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. VERIFY                                                       │
│    • Re-sample pipeline telemetry                               │
│    • Confirm DLQ depth = 0 and file status = PROCESSED          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛠 Tech Stack

- **Frontend:** Next.js 14 (App Router), React, TypeScript, Tailwind CSS, Heroicons, Server-Sent Events (SSE).
- **Backend API:** Node.js, Express, PostgreSQL (`pg`), Redis (`ioredis`), BullMQ, AWS SDK v3 (`@aws-sdk/client-s3`), JWT, bcrypt, Google Generative AI (`@google/genai`).
- **Task Queues & Telemetry:** Redis Cloud, BullMQ.
- **Background Worker:** Standalone Node.js process, Sharp (image resizing/PNG conversion), pdf-lib (PDF metadata & compression), fluent-ffmpeg (video 720p transcoding & thumbnail extraction).
- **Orchestration Layer:** MCPx Coordinator (`@mcpxx/sdk`) with WebMCP browser tool discovery and 4 reference microservices (`routing-app`, `database-app`, `compute-app`, `frontend-app`).
- **Storage:** MinIO / AWS S3 / Cloudflare R2.
- **Cloud Infrastructure:** Supabase PostgreSQL, Redis Cloud, Render (Backend API & Worker), Vercel (Frontends & MCPx Control Plane).

---

## ⚙️ Environment Variables

### Backend (`Backend/.env`)

| Variable         | Description                                 | Production Value                                                   |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`   | Supabase PostgreSQL connection string       | `postgresql://postgres...pooler.supabase.com:5432/postgres`        |
| `REDIS_URL`      | Redis Cloud connection URL                  | `redis://default:...@steel-uplifting-sack-43648.db.redis.io:16292` |
| `JWT_SECRET`     | Secret key for JWT signing                  | Set securely                                                       |
| `ADMIN_EMAILS`   | Admin email allowlist                       | `davidonadokun@gmail.com`                                          |
| `MCPX_BASE_URL`  | MCPx Coordinator URL                        | `https://mcpx-mcpx-web.vercel.app`                                 |
| `LLM_PROVIDER`   | AI Agent LLM provider (`gemini` / `openai`) | `gemini`                                                           |
| `GEMINI_API_KEY` | Gemini API Key for Agent reasoning          | Set securely                                                       |
| `GEMINI_MODEL`   | Gemini Model ID                             | `gemini-2.0-flash`                                                 |

### Frontend (`frontend/.env.local`)

| Variable                       | Description             | Production Value                             |
| ------------------------------ | ----------------------- | -------------------------------------------- |
| `NEXT_PUBLIC_API_URL`          | Backend API base URL    | `https://fileflow-prod-backend.onrender.com` |
| `NEXT_PUBLIC_MCPX_CONSOLE_URL` | MCPx Coordinator UI URL | `https://mcpx-mcpx-web.vercel.app`           |

---

## 🚀 Running Locally

```bash
# 1. Start Infrastructure (Postgres, Redis, MinIO)
docker-compose up -d

# 2. Start Backend API
cd Backend && npm install && node init-db.js && npm run dev

# 3. Start Worker
cd worker && npm install && npm run dev

# 4. Start Frontend
cd frontend && npm install && npm run dev -- -p 3005

# 5. Start MCPx Coordinator (Optional for multi-service operations)
cd /path/to/mcpx && pnpm dev
```

### 🧪 Simulation Testing & Self-Healing Demo

Inject simulated states using the built-in simulation script:

```bash
cd Backend
node scripts/seed-simulation.js dlq       # Seeds a transient DLQ failure to watch the agent heal it
node scripts/seed-simulation.js offline   # Simulates worker going offline
node scripts/seed-simulation.js reset     # Cleans queues and resets heartbeat
```
