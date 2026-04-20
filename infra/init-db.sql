-- REACH core schema (UUID v4; GPS as plain lat/lng — no PostGIS)
CREATE TABLE organisations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE corridors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations (id),
  name TEXT NOT NULL,
  code TEXT,
  start_lat DOUBLE PRECISION,
  start_lng DOUBLE PRECISION,
  end_lat DOUBLE PRECISION,
  end_lng DOUBLE PRECISION,
  km_start DOUBLE PRECISION,
  km_end DOUBLE PRECISION,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corridor_id UUID NOT NULL REFERENCES corridors (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  km_start DOUBLE PRECISION,
  km_end DOUBLE PRECISION
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID REFERENCES organisations (id),
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corridor_id UUID NOT NULL REFERENCES corridors (id),
  driver_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'ambulance',
  status TEXT NOT NULL DEFAULT 'available',
  is_available BOOLEAN NOT NULL DEFAULT true,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vehicles_corridor ON vehicles (corridor_id);

CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corridor_id UUID NOT NULL REFERENCES corridors (id),
  incident_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  km_marker DOUBLE PRECISION,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  trust_score INTEGER NOT NULL DEFAULT 0,
  trust_recommendation TEXT,
  trust_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  reporter_type TEXT NOT NULL,
  source TEXT,
  sos_details JSONB,
  injured_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  photo_url TEXT,
  public_report_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_incidents_corridor ON incidents (corridor_id);
CREATE INDEX idx_incidents_created ON incidents (created_at DESC);

CREATE TABLE incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_incident_events_incident ON incident_events (incident_id);

CREATE TABLE dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents (id),
  vehicle_id UUID NOT NULL REFERENCES vehicles (id),
  cross_boundary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dispatches_incident ON dispatches (incident_id);

-- Align with backend startup migrations (app/main.py) for greenfield installs
ALTER TABLE corridors ADD COLUMN IF NOT EXISTS waypoints JSONB;
ALTER TABLE corridors ADD COLUMN IF NOT EXISTS auto_dispatch_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  user_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  details JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp DESC);
