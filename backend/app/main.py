import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import socketio
from sqlalchemy import text

from app.config import settings
from app.database import engine
from app.routers import admin, auth, corridors, health, incidents, public, sms, vehicles
from app.socket_server import sio

fastapi_app = FastAPI(title="REACH API", version="0.1.0")

fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = settings.api_prefix
# App2 (public SOS) has no login — must stay unauthenticated (see routers/public.py).
fastapi_app.include_router(health.router, prefix=api)
fastapi_app.include_router(public.router, prefix=api)
fastapi_app.include_router(sms.router, prefix=api)
fastapi_app.include_router(auth.router, prefix=api)
fastapi_app.include_router(admin.router, prefix=api)
fastapi_app.include_router(corridors.router, prefix=api)
fastapi_app.include_router(incidents.router, prefix=api)
fastapi_app.include_router(vehicles.router, prefix=api)


@fastapi_app.on_event("startup")
def ensure_coordinate_columns() -> None:
    logging.getLogger("uvicorn.error").info(
        "REACH public corridors (no JWT): GET %s/public/corridors",
        api,
    )
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE corridors ADD COLUMN IF NOT EXISTS start_lat DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE corridors ADD COLUMN IF NOT EXISTS start_lng DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE corridors ADD COLUMN IF NOT EXISTS end_lat DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE corridors ADD COLUMN IF NOT EXISTS end_lng DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source TEXT"))
        conn.execute(text("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS sos_details JSONB"))
        conn.execute(text("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION"))
        conn.execute(
            text(
                "ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS driver_user_id UUID REFERENCES users(id) ON DELETE SET NULL"
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_vehicles_driver_user ON vehicles (driver_user_id)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS speed_zones (
                  id UUID PRIMARY KEY,
                  corridor_id UUID NOT NULL REFERENCES corridors(id) ON DELETE CASCADE,
                  start_km DOUBLE PRECISION NOT NULL,
                  end_km DOUBLE PRECISION NOT NULL,
                  speed_limit_kph DOUBLE PRECISION NOT NULL DEFAULT 100,
                  created_at TIMESTAMPTZ DEFAULT now()
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS broadcast_messages (
                  id UUID PRIMARY KEY,
                  message TEXT NOT NULL,
                  created_by UUID REFERENCES users(id),
                  created_at TIMESTAMPTZ DEFAULT now()
                )
                """
            )
        )
        conn.execute(text("ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS priority TEXT"))

app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app, socketio_path="socket.io")
