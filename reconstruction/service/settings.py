"""Environment configuration for the reconstruction HTTP service."""

from dataclasses import dataclass
import os
from pathlib import Path


class SettingsError(RuntimeError):
    """Service configuration is unsafe or incomplete."""


def _positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise SettingsError(f"{name} must be a positive integer") from None
    if value <= 0:
        raise SettingsError(f"{name} must be a positive integer")
    return value


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    api_key: str | None
    blender: str | None = None
    workers: int = 1
    cors_origins: tuple[str, ...] = ()
    openai_api_key: str = ""
    openai_model: str = ""
    openai_vision_model: str = ""
    browser_use_api_key: str = ""
    browser_use_model: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        data_dir = os.environ.get("TADAIMA_DATA_DIR")
        if not data_dir:
            raise SettingsError("Set TADAIMA_DATA_DIR to a private, writable directory")
        api_key = os.environ.get("TADAIMA_API_KEY") or None
        if api_key is None and os.environ.get("TADAIMA_ALLOW_NO_AUTH") != "1":
            raise SettingsError("Set TADAIMA_API_KEY, or TADAIMA_ALLOW_NO_AUTH=1 for local development only")
        if api_key is not None and len(api_key) < 24:
            raise SettingsError("TADAIMA_API_KEY must be at least 24 characters")
        origins = tuple(origin.strip() for origin in os.environ.get("TADAIMA_CORS_ORIGINS", "").split(",") if origin.strip())
        return cls(
            data_dir=Path(data_dir).absolute(), api_key=api_key,
            blender=os.environ.get("BLENDER_BIN") or None,
            workers=_positive_int("TADAIMA_WORKERS", 1),
            cors_origins=origins,
            openai_api_key=os.environ.get("OPENAI_API_KEY", ""),
            openai_model=os.environ.get("OPENAI_MODEL", ""),
            # Capture historically read OPENAI_VISION_MODEL; fall back to the shared name.
            openai_vision_model=os.environ.get("OPENAI_VISION_MODEL") or os.environ.get("OPENAI_MODEL", ""),
            browser_use_api_key=os.environ.get("BROWSER_USE_API_KEY", ""),
            browser_use_model=os.environ.get("BROWSER_USE_MODEL") or None,
        )
