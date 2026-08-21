"""Conexao com o MongoDB e criacao dos indices.

A connection string NUNCA fica no codigo. Ela vem do ambiente:

    MONGODB_URI=mongodb+srv://usuario:senha@cluster.xxxxx.mongodb.net/

Pegue em Atlas -> Database -> Connect -> Drivers. Um IP nao serve: o Atlas
responde por nome, e o IP que aparece no painel e o *seu*, o que esta liberado
na lista de acesso.

Rode uma vez para preparar o banco:

    python api/db.py
"""

from __future__ import annotations

import os
import sys

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import PyMongoError

DB_NAME = os.environ.get("MONGODB_DB", "praca_recarga")

# Telemetria bruta some depois disso. E o que mantem o banco dentro dos 512 MB
# do plano gratuito sem perder nada que importe: os agregados diarios ficam.
TELEMETRY_TTL_DAYS = 30


def get_client() -> MongoClient:
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        sys.exit(
            "MONGODB_URI nao definida.\n"
            "  Windows:  setx MONGODB_URI \"mongodb+srv://...\"  (reabra o terminal)\n"
            "  Linux/Mac: export MONGODB_URI=\"mongodb+srv://...\"\n"
            "Veja .env.example."
        )
    return MongoClient(uri, serverSelectionTimeoutMS=8000)


def get_db():
    return get_client()[DB_NAME]


def setup_indexes(db) -> list[str]:
    """Cria os indices. Idempotente — pode rodar quantas vezes quiser."""
    created = []

    db.stores.create_index([("store_id", ASCENDING)], unique=True)
    created.append("stores.store_id (unico)")

    db.points.create_index([("point_id", ASCENDING)], unique=True)
    db.points.create_index([("store_id", ASCENDING)])
    created.append("points.point_id (unico) + store_id")

    db.sessions.create_index([("session_id", ASCENDING)], unique=True)
    db.sessions.create_index([("store_id", ASCENDING), ("started_at", DESCENDING)])
    db.sessions.create_index([("point_id", ASCENDING), ("started_at", DESCENDING)])
    db.sessions.create_index([("customer_ref", ASCENDING)], sparse=True)
    created.append("sessions: id, store+data, point+data, cliente")

    # chave de acesso unica: o mesmo cupom nao vale duas vezes
    db.sales.create_index([("access_key", ASCENDING)], unique=True)
    db.sales.create_index([("store_id", ASCENDING), ("at", DESCENDING)])
    db.sales.create_index([("customer_ref", ASCENDING)], sparse=True)
    created.append("sales: chave de acesso (unica), store+data, cliente")

    # O indice que segura o tamanho do banco: o Mongo apaga sozinho.
    db.telemetry.create_index(
        [("at", ASCENDING)], expireAfterSeconds=TELEMETRY_TTL_DAYS * 86400
    )
    db.telemetry.create_index([("point_id", ASCENDING), ("at", DESCENDING)])
    created.append(f"telemetry: TTL de {TELEMETRY_TTL_DAYS} dias + point+data")

    db.rollups.create_index(
        [("point_id", ASCENDING), ("day", ASCENDING)], unique=True
    )
    db.rollups.create_index([("store_id", ASCENDING), ("day", DESCENDING)])
    created.append("rollups: point+dia (unico), store+dia")

    return created


def storage_report(db) -> dict:
    """Quanto do plano gratuito ja foi usado."""
    stats = db.command("dbStats")
    used_mb = (stats.get("dataSize", 0) + stats.get("indexSize", 0)) / (1024 * 1024)
    return {
        "usado_mb": round(used_mb, 2),
        "limite_mb": 512,
        "uso_pct": round(100 * used_mb / 512, 2),
        "colecoes": {c: db[c].estimated_document_count() for c in db.list_collection_names()},
    }


if __name__ == "__main__":
    try:
        db = get_db()
        db.command("ping")
        print(f"conectado em {DB_NAME}\n")
        for line in setup_indexes(db):
            print("  indice ok:", line)
        print()
        report = storage_report(db)
        print(f"armazenamento: {report['usado_mb']} MB de {report['limite_mb']} MB "
              f"({report['uso_pct']}%)")
        if report["colecoes"]:
            for name, count in report["colecoes"].items():
                print(f"  {name}: {count} documentos")
        else:
            print("  banco ainda vazio")
    except PyMongoError as exc:
        sys.exit(
            f"falha ao conectar: {type(exc).__name__}\n"
            "verifique a connection string e se o seu IP esta liberado em "
            "Atlas -> Network Access."
        )
