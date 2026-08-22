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


def uri() -> str:
    valor = os.environ.get("DATABASE_URL", "").strip()
    if not valor:
        raise SystemExit(
            "Faltou DATABASE_URL.\n"
            "  PowerShell:  $env:DATABASE_URL = 'postgres://...'\n"
            "  bash:        export DATABASE_URL='postgres://...'"
        )
    return valor


def conectar(*, autocommit: bool = False) -> psycopg.Connection:
    """Conexão com linhas em dicionário — é o formato que o resto espera."""
    return psycopg.connect(uri(), row_factory=dict_row, autocommit=autocommit)


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
