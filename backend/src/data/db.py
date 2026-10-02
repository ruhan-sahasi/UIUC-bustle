import asyncpg
from typing import Optional

_pool: Optional[asyncpg.Pool] = None


class DatabaseUnavailable(RuntimeError):
    """Raised when the pool isn't ready (startup failed or DATABASE_URL unset).

    Subclasses RuntimeError so existing ``except RuntimeError`` call sites keep
    working; the API maps any uncaught instance to a 503.
    """


async def init_pool(database_url: str) -> None:
    global _pool
    _pool = await asyncpg.create_pool(database_url, min_size=2, max_size=10)


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise DatabaseUnavailable("Database pool not initialized")
    return _pool
