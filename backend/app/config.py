from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "reach"
    db_user: str = "reach"
    db_password: str = "reach"

    redis_url: str | None = "redis://localhost:6379/0"

    jwt_secret: str = "change-me-in-production-use-32chars-minimum!!"
    jwt_expires_in_days: int = 7

    cors_origin: str = (
        "http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176"
    )

    api_prefix: str = "/api"
    routing_base_url: str = "https://router.project-osrm.org"

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg2://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origin.split(",") if o.strip()]


settings = Settings()
