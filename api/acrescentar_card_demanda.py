"""Acrescenta o card de demanda aos paineis que ainda nao o tem.

O layout padrao do codigo so vale para quem nunca salvou um painel. Quem ja
usa o sistema tem o layout guardado na tabela `paineis`, e ele vence -- que e
o comportamento certo: ninguem quer ver o proprio painel remontado sozinho.

So que o card de demanda avisa sobre multa de ultrapassagem, e um aviso que
ninguem ve nao avisa nada. Este script ACRESCENTA o card no fim dos paineis
que tem acesso a financeiro, sem tocar na ordem nem no tamanho do que ja
estava la. Quem nao quiser, remove pelo menu do card.

    python api/acrescentar_card_demanda.py            # aplica
    python api/acrescentar_card_demanda.py --mostrar  # so lista
"""

from __future__ import annotations

import json
import os
import sys

import psycopg
from psycopg.rows import dict_row

CARD = {"id": "demanda", "grupo": "large", "cols": 20, "rows": 5, "config": {}}


def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("!! sem DATABASE_URL no ambiente")
        return 2
    mostrar = "--mostrar" in sys.argv

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row,
                         autocommit=True) as con, con.cursor() as cur:
        # O card e financeiro; painel de operador nao o recebe, pela mesma
        # razao que ele nao ve tarifa: demanda contratada e conta de dinheiro.
        cur.execute(
            "SELECT p.id, p.nome, p.cards, u.papel, u.nome AS dono"
            "  FROM paineis p JOIN usuarios u ON u.id = p.usuario_id"
            " WHERE u.papel <> 'operador' ORDER BY p.id")
        mexidos = 0
        for p in cur.fetchall():
            cards = p["cards"] or []
            if any(c.get("id") == "demanda" for c in cards):
                continue
            print(f"   painel #{p['id']:<3} '{p['nome']}' de {p['dono']} ({p['papel']})"
                  f" — {len(cards)} cards, ganha o de demanda")
            mexidos += 1
            if mostrar:
                continue
            cur.execute("UPDATE paineis SET cards = %s::jsonb WHERE id = %s",
                        (json.dumps(cards + [CARD]), p["id"]))

    print(f"\n  {'seriam alterados' if mostrar else 'alterados'}: {mexidos} painel(is)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
