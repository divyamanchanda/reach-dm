# REACH Python backend

## Prerequisites

- Docker (for PostgreSQL 16 + PostGIS and Redis)
- Python 3.11+

## Local setup

```bash
# From repo root
docker compose up -d

cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Optional: copy env
cp .env.example .env

# Apply schema (first time only — also runs via docker init on fresh volume)
# If the DB volume already existed without PostGIS, remove the volume or run:
#   psql ... -f ../infra/init-db.sql

# Seed dummy corridor, operator user, vehicles, incidents
PYTHONPATH=. python -m scripts.seed

uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

- API: http://localhost:8000/api/health  
- OpenAPI: http://localhost:8000/docs (FastAPI auto-docs; mirrors `docs/API.md`)

## Demo login (after seed)

- Phone: `+919876543210`  
- Password: `reach2026`  
- Corridor id for App2: printed at end of seed (`c0ffee00-0000-4000-8000-000000000002`)

## Socket.IO (App1)

Connect with `socket.io-client`, `auth: { token: "<JWT>" }`, then emit `subscribe_corridor` with `{ corridor_id: "<uuid>" }`.

## Environment variables

See `app/config.py` and `.env.example`.
