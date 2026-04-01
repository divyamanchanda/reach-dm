# REACH — Handoff package

This document ships with the codebase (see `REACH-DM-handoff.tar.gz` or your git clone). Share **both** the archive and this note (or point recipients to this file inside the project).

---

## (a) Design, architecture, and tech stack

### Product slice (Phase 1)

**REACH** is a local demo of a highway emergency coordination stack: a **dispatch console** (operators), a **public SOS reporter** (bystanders), one **shared backend**, and **real-time** updates on the operator map/list. This drop focuses on **App1 (dispatch web)** and **App2 (public SOS web)** plus the **Python API** they call.

### High-level architecture

```
┌─────────────┐     REST + JWT      ┌──────────────────────────────────┐
│   App1      │◄───────────────────►│  FastAPI (`/api/...`)            │
│  Vite/React │     Socket.IO       │  + Socket.IO (same port 8000)    │
│  :5173      │◄───────────────────►│  JWT auth, corridor rooms        │
└─────────────┘                     │                                  │
                                    │  SQLAlchemy + PostGIS queries    │
┌─────────────┐     REST (public)   │  TrustScore, Dispatch (txn)      │
│   App2      │────────────────────►│                                  │
│  Vite/React │                     └──────────┬───────────────────────┘
│  :5174      │                                │
└─────────────┘                     ┌──────────▼──────────┐
                                    │ PostgreSQL 16 +       │
                                    │ PostGIS (geography)  │
                                    │ Redis (reserved)     │
                                    └──────────────────────┘
```

- **Single backend** serves all apps; **no** separate microservice per app.
- **App1** uses **JWT** (`Authorization: Bearer …`) after phone/password login.
- **App2** uses **`POST /api/corridors/{id}/incidents/public`** with **no login**.
- **Socket.IO**: clients authenticate with JWT in the handshake; operators **subscribe** to `corridor:<uuid>` for live incident/vehicle events.

### Tech stack (as implemented)

| Layer | Technology |
|--------|------------|
| API | **Python 3.11+**, **FastAPI**, **Uvicorn** |
| Real-time | **python-socketio** (ASGI mount next to FastAPI) |
| DB | **PostgreSQL 16** + **PostGIS** (Docker image `postgis/postgis`) |
| ORM / geo | **SQLAlchemy 2**, **GeoAlchemy2**, **psycopg2** |
| Cache | **Redis 7** in Docker (wired for future use; API works if Redis is idle) |
| Auth | **JWT** (PyJWT), **bcrypt** password hashes |
| App1 / App2 | **React** + **TypeScript**, **Vite**, **socket.io-client** (App1) |

### Important files

| Path | Role |
|------|------|
| `docker-compose.yml` | Postgres + Redis; mounts `infra/init-db.sql` on **first** DB init |
| `infra/init-db.sql` | Schema (UUIDs, `geography` points) |
| `backend/app/main.py` | FastAPI app + Socket.IO ASGI wrapper |
| `backend/app/routers/` | REST routes |
| `backend/app/services/` | Trust scoring, public incident insert, dispatch transaction |
| `backend/scripts/seed.py` | Dummy org, corridor, users, vehicles, incidents |
| `docs/API.md` | HTTP + Socket contract (human-readable) |

### Intentional gaps vs a full production brief

- **MapmyIndia / Mappls** map SDK is **not** integrated in App1 (coordinates + OSM link only); needs `VITE_MAPMYINDIA_KEY` and SDK wiring later.
- App2 **PWA / offline queue / SMS fallback** are **not** implemented in this demo.
- **ETA** on screen uses a **simple distance/speed stub**, not MapmyIndia Distance Matrix yet.

---

## (b) What they do (setup)

### Prerequisites

- **Docker Desktop** (or equivalent) — `docker info` must show a **Server** section.
- **Python 3.11+** (`python3 --version`).
- **Node.js 18+** and npm (`node -v`, `npm -v`).

### 1) Get the code

- Download **`REACH-DM-handoff.tar.gz`** (e.g. from Google Drive).
- Create a folder, e.g. `REACH-DM`, move the archive there, extract:

```bash
cd REACH-DM
tar xzf REACH-DM-handoff.tar.gz
```

You should see `backend/`, `app1/`, `app2/`, `docker-compose.yml`, `README.md`, `HANDOFF.md`, etc.

### 2) Open in Cursor

**File → Open Folder…** → select the extracted folder (the one that contains `docker-compose.yml`).

### 3) Start databases (terminal — project root)

```bash
cd /path/to/REACH-DM
docker compose up -d
docker compose ps
```

Expect **db** and **redis** **running**.

**macOS:** Docker may ask for access to **Desktop/Documents** if the project lives there — allow it, or move the repo elsewhere.

**If the database was created without this schema** (errors about missing tables), reset the volume once:

```bash
docker compose down -v
docker compose up -d
```

### 4) Backend (new terminal)

```bash
cd /path/to/REACH-DM/backend
python3 -m venv .venv
source .venv/bin/activate
```

**Windows (PowerShell):** `.venv\Scripts\Activate.ps1`

```bash
pip install -r requirements.txt
cp .env.example .env
PYTHONPATH=. python -m scripts.seed
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Leave this running.

- Health: http://localhost:8000/api/health  
- Swagger: http://localhost:8000/docs  

### 5) App1 — Dispatch console (second terminal)

```bash
cd /path/to/REACH-DM/app1
npm install
npm run dev
```

Open **http://localhost:5173**

### 6) App2 — Public SOS (third terminal)

```bash
cd /path/to/REACH-DM/app2
npm install
npm run dev
```

Open **http://localhost:5174**

---

## (c) Everything else worth knowing

### Demo credentials (after `scripts.seed`)

| Item | Value |
|------|--------|
| Dispatch login phone | `+919876543210` |
| Password | `reach2026` |
| Default corridor UUID (App2 / seed) | `c0ffee00-0000-4000-8000-000000000002` |

Corridor id must be a **valid UUID** (last segment = **12** hex chars). Typos like `…000044` (13 chars) will 422 from the API.

### Ports

| Service | Port |
|---------|------|
| API + Socket.IO | 8000 |
| App1 | 5173 |
| App2 | 5174 |
| PostgreSQL | 5432 |
| Redis | 6379 |

### Documentation in-repo

- **`README.md`** — short runbook  
- **`backend/README.md`** — backend specifics  
- **`docs/API.md`** — endpoints + Socket events  

### Regenerating the handoff tarball (for maintainers)

From project root:

```bash
rm -f REACH-DM-handoff.tar.gz
tar czvf REACH-DM-handoff.tar.gz \
  --exclude='./REACH-DM-handoff.tar.gz' \
  --exclude='./node_modules' \
  --exclude='./app1/node_modules' \
  --exclude='./app2/node_modules' \
  --exclude='./.venv' \
  --exclude='./dist' --exclude='./app1/dist' --exclude='./app2/dist' \
  --exclude='__pycache__' \
  --exclude='./.env' --exclude='./backend/.env' \
  .
```

### Resuming work

Opening this folder in **Cursor** is enough. Use **three terminals** in daily dev: Docker (once), backend, App1, App2 as needed. No special Cursor configuration is required.

### Support checklist if something fails

1. `docker info` works and `docker compose ps` shows DB up.  
2. Backend: `GET http://localhost:8000/api/health` → `{"status":"ok"}`.  
3. Re-run **`PYTHONPATH=. python -m scripts.seed`** if you need a clean demo dataset (this **wipes** demo tables — dev only).  
4. App2 trust **0** / ETA **missing** often means **no GPS** on the report; use **SOS — capture GPS** and allow browser location.

---

*End of handoff note.*
