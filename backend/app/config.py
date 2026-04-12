from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def normalize_database_url(url: str) -> str:
    """Railway/Heroku often provide postgres:// which SQLAlchemy expects as postgresql+psycopg2://."""
    u = url.strip()
    if u.startswith("postgres://"):
        return "postgresql+psycopg2://" + u[len("postgres://") :]
    if u.startswith("postgresql://") and not u.startswith("postgresql+"):
        return "postgresql+psycopg2://" + u[len("postgresql://") :]
    return u


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Railway / cloud: set this in the environment (takes precedence over discrete DB_* vars).
    database_url: str | None = Field(default=None, validation_alias=AliasChoices("DATABASE_URL"))

    # Local / optional: only used when DATABASE_URL is unset (never implied as localhost).
    db_host: str | None = Field(default=None, validation_alias=AliasChoices("DB_HOST"))
    db_port: int = Field(default=5432, validation_alias=AliasChoices("DB_PORT"))
    db_name: str = Field(default="reach", validation_alias=AliasChoices("DB_NAME"))
    db_user: str = Field(default="reach", validation_alias=AliasChoices("DB_USER"))
    db_password: str = Field(default="reach", validation_alias=AliasChoices("DB_PASSWORD"))

    redis_url: str | None = "redis://localhost:6379/0"

    jwt_secret: str = "change-me-in-production-use-32chars-minimum!!"
    jwt_expires_in_days: int = 7

    # CORS. Railway/Vercel often set `CORS_ORIGINS`; we also accept `CORS_ORIGIN` for compatibility.
    cors_origins_raw: str = Field(
        default="http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176",
        validation_alias=AliasChoices("CORS_ORIGINS", "CORS_ORIGIN"),
    )

    api_prefix: str = Field(
        default="/api",
        validation_alias=AliasChoices("API_PREFIX", "api_prefix"),
        description="URL prefix for all HTTP API routes (App2 expects /api/public/corridors).",
    )
    routing_base_url: str = "https://router.project-osrm.org"

    # Outbound SMS replies (Twilio or MSG91). If unset, replies are logged only.
    sms_provider: str | None = Field(default=None, validation_alias=AliasChoices("SMS_PROVIDER"))
    twilio_account_sid: str | None = Field(default=None, validation_alias=AliasChoices("TWILIO_ACCOUNT_SID"))
    twilio_auth_token: str | None = Field(default=None, validation_alias=AliasChoices("TWILIO_AUTH_TOKEN"))
    twilio_from_number: str | None = Field(default=None, validation_alias=AliasChoices("TWILIO_FROM_NUMBER"))
    msg91_auth_key: str | None = Field(default=None, validation_alias=AliasChoices("MSG91_AUTH_KEY"))
    msg91_sender_id: str | None = Field(default=None, validation_alias=AliasChoices("MSG91_SENDER_ID"))
    msg91_route: str | None = Field(default="4", validation_alias=AliasChoices("MSG91_ROUTE"))

    public_upload_dir: str = Field(
        default="data/public_uploads",
        validation_alias=AliasChoices("PUBLIC_UPLOAD_DIR"),
        description="Directory for App2 public SOS photo uploads (created on startup).",
    )

    @field_validator("api_prefix", mode="after")
    @classmethod
    def normalize_api_prefix(cls, v: str) -> str:
        """Railway sometimes sets API_PREFIX to empty; App2 hardcodes /api/...."""
        s = (v or "").strip()
        if not s:
            return "/api"
        if not s.startswith("/"):
            s = f"/{s}"
        s = s.rstrip("/")
        return s if s else "/api"

    @property
    def sqlalchemy_database_url(self) -> str:
        if self.database_url:
            return normalize_database_url(self.database_url)
        if self.db_host:
            return (
                f"postgresql+psycopg2://{self.db_user}:{self.db_password}"
                f"@{self.db_host}:{self.db_port}/{self.db_name}"
            )
        raise RuntimeError(
            "Database URL is not configured: set DATABASE_URL in the environment (required on Railway), "
            "or set DB_HOST (and optionally DB_PORT, DB_NAME, DB_USER, DB_PASSWORD) for local Postgres."
        )

    @property
    def cors_origins(self) -> list[str]:
        hardcoded_origin = "https://reach-dispatch.vercel.app"

        raw = (self.cors_origins_raw or "").strip()
        tokens = [o.strip() for o in raw.split(",") if o.strip()]

        # Wildcard allow-all fallback.
        if len(tokens) == 1 and tokens[0] == "*":
            return ["*", hardcoded_origin]

        # Otherwise, use the explicit list of origins (comma-separated) + the hardcoded Vercel dispatch origin.
        origins: list[str] = []
        seen: set[str] = set()
        for o in [hardcoded_origin, *tokens]:
            o = o.strip()
            if not o:
                continue
            if o == "*":
                # Only treat * as allow-all when it is the only value.
                continue
            if o in seen:
                continue
            seen.add(o)
            origins.append(o)
        return origins


settings = Settings()
