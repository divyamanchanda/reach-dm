# REACH — local demo (Python backend + App1 + App2)

## 1. Start infrastructure

```bash
docker compose up -d
```

This starts **PostgreSQL 16 + PostGIS** and **Redis** (`infra/init-db.sql` creates tables on first DB init).

## 2. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # optional
PYTHONPATH=. python -m scripts.seed
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

- REST + OpenAPI: http://localhost:8000/docs  
- Contract reference: `docs/API.md`  
- Dependencies explained: `backend/requirements.txt` (header comments)

## 3. App1 — Dispatch console

```bash
cd app1
npm install
npm run dev
```

Open http://localhost:5173 — sign in with seed user **+919876543210** / **reach2026**.

## 4. App2 — Public SOS

```bash
cd app2
npm install
npm run dev
```

Open http://localhost:5174 — corridor UUID defaults to the seeded corridor (`app2/.env.development`). You can override with `?corridor=<uuid>`.

## Ports

| Service    | Port |
|-----------|------|
| API + Socket.IO | 8000 |
| App1 (Vite)     | 5173 |
| App2 (Vite)     | 5174 |
| PostgreSQL      | 5432 |
| Redis           | 6379 |
