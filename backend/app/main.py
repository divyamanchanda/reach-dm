from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import socketio
from sqlalchemy import text

from app.config import settings
from app.database import engine
from app.routers import admin, auth, corridors, health, incidents, vehicles
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
fastapi_app.include_router(health.router, prefix=api)
fastapi_app.include_router(auth.router, prefix=api)
fastapi_app.include_router(admin.router, prefix=api)
fastapi_app.include_router(corridors.router, prefix=api)
fastapi_app.include_router(incidents.router, prefix=api)
fastapi_app.include_router(vehicles.router, prefix=api)


@fastapi_app.on_event("startup")
def ensure_corridor_coordinate_columns() -> None:
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE corridors ADD COLUMN IF NOT EXISTS start_lat DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE corridors ADD COLUMN IF NOT EXISTS start_lng DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE corridors ADD COLUMN IF NOT EXISTS end_lat DOUBLE PRECISION"))
        conn.execute(text("ALTER TABLE corridors ADD COLUMN IF NOT EXISTS end_lng DOUBLE PRECISION"))

app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app, socketio_path="socket.io")
