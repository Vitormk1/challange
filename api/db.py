"""Conexão com o PostgreSQL e aplicação do esquema.

A URI NUNCA fica no código. Ela vem do ambiente:

    DATABASE_URL=postgres://usuario:senha@host:porta/banco?sslmode=require

Rode uma vez para preparar o banco:

    python api/db.py
"""

from __future__ import annotations

import os
import pathlib
import sys

import psycopg
from psycopg.rows import dict_row

RAIZ = pathlib.Path(__file__).resolve().parent
SCHEMA = RAIZ / "schema.sql"

# Carrega o .env da raiz, se existir. Sem isto, cada terminal e cada processo
# (uvicorn, scripts) precisaria exportar as variaveis na mao.
try:
    from dotenv import load_dotenv
    load_dotenv(RAIZ.parent / ".env")
except ImportError:
    pass


def uri() -> str:
    valor = os.environ.get("DATABASE_URL", "").strip()
    if not valor:
        raise SystemExit(
            "Faltou DATABASE_URL.\n"
            "  PowerShell:  $env:DATABASE_URL = 'postgres://...'\n"
            "  bash:        export DATABASE_URL='postgres://...'"
        )
    return valor


_pool: "ConnectionPool | None" = None


def pool():
    """Conexões reaproveitadas.

    Abrir conexão contra o Aiven custa ~1,2s de handshake TLS. Uma requisição
    que abre quatro paga cinco segundos antes de consultar qualquer coisa. O
    pool paga esse preço uma vez, na subida, e depois só empresta.
    """
    global _pool
    if _pool is None:
        from psycopg_pool import ConnectionPool
        _pool = ConnectionPool(uri(), min_size=2, max_size=8, open=True,
                               kwargs={"row_factory": dict_row})
        _pool.wait(timeout=30)
    return _pool


def conectar(*, autocommit: bool = False):
    """Conexão com linhas em dicionário — é o formato que o resto espera.

    Com `autocommit`, vai direto ao banco sem passar pelo pool: é o caso dos
    scripts de esquema, que rodam DDL uma vez e saem.
    """
    if autocommit:
        return psycopg.connect(uri(), row_factory=dict_row, autocommit=True)
    return pool().connection()


def aplicar_schema() -> None:
    """Cria tabelas, índices e visões. É idempotente: pode rodar de novo."""
    sql = SCHEMA.read_text(encoding="utf-8")
    with conectar(autocommit=True) as con, con.cursor() as cur:
        cur.execute(sql)
        cur.execute(
            "SELECT table_name, table_type FROM information_schema.tables "
            "WHERE table_schema = 'public' ORDER BY table_type, table_name"
        )
        linhas = cur.fetchall()
    tabelas = [l["table_name"] for l in linhas if l["table_type"] == "BASE TABLE"]
    visoes = [l["table_name"] for l in linhas if l["table_type"] == "VIEW"]
    print(f"tabelas ({len(tabelas)}): {', '.join(tabelas)}")
    print(f"visões  ({len(visoes)}): {', '.join(visoes)}")


def consultar(sql: str, params: tuple = ()) -> list[dict]:
    with conectar() as con, con.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


if __name__ == "__main__":
    try:
        aplicar_schema()
    except psycopg.Error as erro:
        print(f"erro do banco: {erro}", file=sys.stderr)
        raise SystemExit(1)
