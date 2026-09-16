"""Auditoria de integridade do banco configurado, somente leitura.

Use em Render Shell ou localmente com a DATABASE_URL do serviço. Nunca imprime
URLs, usuários, documentos ou linhas individuais.
"""
from __future__ import annotations

import json
import os
import sys

import psycopg
from psycopg import sql

import db


TABELAS = (
    "usuarios", "sessoes_web", "clientes", "sessoes", "vendas", "cupons",
    "carteiras", "carteira_pix", "carteira_lancamentos",
    "carteira_eventos_asaas", "verificacoes_email",
)


def executar() -> dict:
    saida = {"modo": "somente_leitura", "contagens": {}, "checks": {}}
    with psycopg.connect(db.uri(), connect_timeout=15) as con:
        with con.cursor() as cur:
            cur.execute("SET TRANSACTION READ ONLY")
            cur.execute("SET LOCAL statement_timeout = 15000")
            cur.execute("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()")
            saida["checks"]["tls"] = bool(cur.fetchone()[0])
            cur.execute("SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema='public' AND table_type='BASE TABLE'")
            tabelas = {row[0] for row in cur.fetchall()}
            saida["tabelas_ausentes"] = sorted(set(TABELAS) - tabelas)
            for tabela in TABELAS:
                if tabela in tabelas:
                    cur.execute(sql.SQL("SELECT count(*) FROM {}")
                                .format(sql.Identifier(tabela)))
                    saida["contagens"][tabela] = cur.fetchone()[0]
            checks = {
                "hashes_senha_invalidos": "SELECT count(*) FROM usuarios WHERE senha_hash !~ '^scrypt\\$[0-9]+\\$[0-9]+\\$[0-9]+\\$[a-f0-9]{32}\\$[a-f0-9]{64}$'",
                "lancamentos_orfaos": "SELECT count(*) FROM carteira_lancamentos l LEFT JOIN usuarios u ON u.id=l.usuario_id WHERE u.id IS NULL",
                "pagamentos_duplicados": "SELECT count(*) FROM (SELECT asaas_pagamento_id FROM carteira_pix GROUP BY 1 HAVING count(*)>1) x",
                "referencias_duplicadas": "SELECT count(*) FROM (SELECT referencia FROM carteira_lancamentos WHERE referencia IS NOT NULL GROUP BY 1 HAVING count(*)>1) x",
                "pix_com_valor_invalido": "SELECT count(*) FROM carteira_pix WHERE valor_brl IS NULL OR valor_brl<=0",
                "pix_recebido_sem_credito": "SELECT count(*) FROM carteira_pix p WHERE status IN ('RECEIVED','CONFIRMED') AND NOT EXISTS (SELECT 1 FROM carteira_lancamentos l WHERE l.referencia='asaas:'||p.asaas_pagamento_id AND l.usuario_id=p.usuario_id AND l.valor_brl=p.valor_brl)",
            }
            for nome, consulta in checks.items():
                cur.execute(consulta)
                saida["checks"][nome] = cur.fetchone()[0]
            con.rollback()
    saida["ok"] = not saida["tabelas_ausentes"] and all(
        saida["checks"].get(nome, 1) == 0 for nome in (
            "hashes_senha_invalidos", "lancamentos_orfaos", "pagamentos_duplicados",
            "referencias_duplicadas", "pix_com_valor_invalido", "pix_recebido_sem_credito"))
    return saida


if __name__ == "__main__":
    try:
        print(json.dumps(executar(), ensure_ascii=False, indent=2))
    except Exception as erro:
        print(json.dumps({"ok": False, "modo": "somente_leitura",
                          "erro_tipo": type(erro).__name__}, ensure_ascii=False))
        raise SystemExit(1)
