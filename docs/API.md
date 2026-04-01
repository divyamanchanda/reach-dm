# REACH API — App1 (Dispatch Console) & App2 (Public SOS)

Implementation: **Python** (FastAPI + `python-socketio` + SQLAlchemy + PostGIS). OpenAPI UI: `/docs` when the server is running.

Base URL (local default): `http://localhost:8000`  
Real-time (App1): Socket.IO on the **same origin** (path `/socket.io/`).

Auth: `Authorization: Bearer <JWT>` except where noted. JWT payload includes `sub` (user UUID), `role`, `phone`.

---

## Health

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/health` | Public | Liveness for probes and local checks |

**Response:** `{ "status": "ok" }`

---

## Authentication (App1)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/auth/login` | Public | Phone + password → JWT |

**Request body:**

```json
{ "phone": "+9198...", "password": "reach2026" }
```

**Response:** `{ "access_token": "...", "token_type": "bearer", "user": { "id", "phone", "full_name", "role", "organisation_id" } }`

---

## Corridors & live stats (App1)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/corridors` | JWT | List active corridors for dropdown |
| `GET` | `/api/corridors/{corridor_id}/stats` | JWT | Topbar: active incidents, pending, available vehicles, avg response (minutes) |
| `GET` | `/api/corridors/{corridor_id}/vehicles` | JWT | Vehicles with last known position for map |
| `GET` | `/api/corridors/{corridor_id}/incidents` | JWT | Incidents sorted by severity (critical → major → minor), then recency |

---

## Incidents — operator (App1)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/incidents/{incident_id}` | JWT | Detail, trust breakdown, timeline (`incident_events`) |
| `GET` | `/api/incidents/{incident_id}/nearby-vehicles` | JWT (`dispatch_operator`) | Ranked ambulances: distance (m), ETA estimate (stub until MapmyIndia) |
| `POST` | `/api/incidents/{incident_id}/dispatch` | JWT (`dispatch_operator`) | Atomic assign vehicle: lock rows, validate, dispatch row, timeline, socket `incident:dispatched` |
| `PATCH` | `/api/incidents/{incident_id}/status` | JWT | Update lifecycle status (e.g. closed); append timeline |

**Dispatch body:**

```json
{ "vehicle_id": "<uuid>" }
```

---

## Public SOS (App2)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/corridors/{corridor_id}/incidents/public` | **Public** | Create incident from bystander; compute trust score; returns public report id + ETA stub |

**Request body (JSON):**

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `incident_type` | string | yes | e.g. `accident`, `fire`, `breakdown`, `medical`, `other` |
| `severity` | string | yes | `critical` \| `major` \| `minor` |
| `injured_count` | int | no | default `0` |
| `latitude` | float | no | Improves trust when present |
| `longitude` | float | no | Pair with latitude |
| `km_marker` | float | no | Highway km if known |
| `photo_url` | string | no | Optional URL if upload handled elsewhere |
| `notes` | string | no | Free text |

**Response:** `{ "incident_id", "public_report_id", "trust_score", "trust_recommendation", "nearest_ambulance_eta_minutes" }`  
(`nearest_ambulance_eta_minutes` may be `null` if no suitable vehicle.)

---

## Vehicles — driver / console (App1 map updates)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `PATCH` | `/api/vehicles/{vehicle_id}/location` | JWT | GPS ping (~10s); broadcasts `vehicle:location` to corridor room |
| `PATCH` | `/api/vehicles/{vehicle_id}/status` | JWT | `available`, `en_route`, `on_scene`, `transporting`, `off_duty`; socket `vehicle:status` |

**Location body:** `{ "latitude": 12.97, "longitude": 77.59 }`  
**Status body:** `{ "status": "en_route" }`

---

## Socket.IO events (App1)

Client joins room: **`corridor:<corridor_uuid>`** (server accepts join after JWT in handshake `auth.token`).

| Event | Direction | When |
|-------|-----------|------|
| `incident:new` | server → client | New incident on corridor |
| `incident:updated` | server → client | Status or fields changed |
| `incident:dispatched` | server → client | Dispatch created |
| `vehicle:location` | server → client | Vehicle GPS updated |
| `vehicle:status` | server → client | Vehicle status changed |
| `corridor:stats` | server → client | Stats snapshot (on change or periodic) |

Payloads are JSON objects keyed by entity ids; see `app/socket_events.py` in the backend for exact shapes.

---

## Errors

REST errors use JSON: `{ "detail": "..." }` or FastAPI validation `detail` array.  
Typical status codes: `401` auth, `403` role, `404` not found, `409` conflict (e.g. dispatch when not allowed), `422` validation.
