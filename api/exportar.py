"""Despeja o Postgres em docs/painel/dados.json.

O GitHub Pages só serve arquivo estático — não roda Python. Então o painel lê
um JSON gerado aqui. Quando existir uma API de verdade, só a origem dos dados
muda no painel; o formato continua o mesmo.

A tabela `usuarios` fica de fora de propósito: é conta e senha, não é coisa
que o lojista precisa ver nem editar.

    python api/exportar.py
"""

from __future__ import annotations

import json
import pathlib
from datetime import date, datetime
from decimal import Decimal

from db import conectar

SAIDA = pathlib.Path(__file__).resolve().parents[1] / "docs" / "painel" / "dados.json"

# Leituras são o volume: 5 em 5 minutos por sessão. Só as mais recentes vão
# para o JSON — o resto continua no banco, que é onde tem que ficar.
LIMITE_LEITURAS = 4000

CONSULTAS = {
    "estabelecimentos": "SELECT * FROM estabelecimentos ORDER BY id",
    "carregadores":     "SELECT * FROM carregadores ORDER BY estabelecimento_id, id",
    "clientes":         "SELECT * FROM clientes ORDER BY estabelecimento_id, id",
    "sessoes":          "SELECT * FROM sessoes ORDER BY inicio DESC",
    "cupons":           "SELECT * FROM cupons ORDER BY emitido_em DESC",
    "vendas":           "SELECT * FROM vendas ORDER BY momento DESC",
    "paineis":          "SELECT * FROM paineis ORDER BY estabelecimento_id, id",
    "leituras":        f"SELECT * FROM leituras ORDER BY momento DESC LIMIT {LIMITE_LEITURAS}",
}


def simples(valor):
    """Decimal e datetime não viram JSON sozinhos."""
    if isinstance(valor, Decimal):
        return float(valor)
    if isinstance(valor, (datetime, date)):
        return valor.isoformat()
    raise TypeError(f"não sei serializar {type(valor)}")


def exportar() -> None:
    dados = {}
    with conectar() as con, con.cursor() as cur:
        for chave, sql in CONSULTAS.items():
            cur.execute(sql)
            dados[chave] = cur.fetchall()

    SAIDA.parent.mkdir(parents=True, exist_ok=True)
    SAIDA.write_text(
        json.dumps(dados, default=simples, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tamanho = SAIDA.stat().st_size / 1024
    resumo = "  ".join(f"{k}: {len(v)}" for k, v in dados.items())
    print(f"{SAIDA.relative_to(SAIDA.parents[2])}  ({tamanho:.0f} KB)")
    print(resumo)


if __name__ == "__main__":
    exportar()
