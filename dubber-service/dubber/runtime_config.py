import os


def _env_bool(name, default=False):
    raw = os.getenv(name)
    if raw is None:
        return bool(default)
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def get_pipeline_mode():
    """
    Resolve pipeline mode as:
    - PIPELINE_MODE=economy|quality  (preferred)
    - FREE_TIER_OPTIMIZED=1|0       (legacy compatibility)
    Default: economy
    """
    mode = os.getenv("PIPELINE_MODE")
    if mode:
        m = str(mode).strip().lower()
        if m in {"economy", "quality"}:
            return m

    legacy = os.getenv("FREE_TIER_OPTIMIZED")
    if legacy is not None:
        return "economy" if _env_bool("FREE_TIER_OPTIMIZED", True) else "quality"

    return "economy"


def is_economy_mode():
    return get_pipeline_mode() == "economy"


def is_quality_mode():
    return get_pipeline_mode() == "quality"


def mode_label():
    return "Economy mode" if is_economy_mode() else "Quality mode"


def is_free_tier_optimized():
    """
    Backward-compatible alias for old naming.
    Prefer: is_economy_mode()
    """
    return is_economy_mode()
