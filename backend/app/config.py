from pydantic import AliasChoices, Field
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

    cors_origin: str = (
        "http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176"
    )

    api_prefix: str = "/api"
    routing_base_url: str = "https://router.project-osrm.org"

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
        return [o.strip() for o in self.cors_origin.split(",") if o.strip()]


settings = Settings()
