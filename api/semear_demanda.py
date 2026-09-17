"""Preenche os dados de potencia das lojas que ainda nao tem.

As doze lojas do mapa nasceram do `semear_mapa.py`, que so precisava de nome,
segmento e coordenada. Elas ficaram sem demanda contratada, sem carga base e
sem geracao — e sem esses tres numeros a tela de demanda nao tem o que mostrar.

Aditivo e idempotente, como o semear_mapa.py: so escreve onde ainda esta vazio,
e pode rodar de novo sem estragar o que alguem ajustou na mao.

    python api/semear_demanda.py            # preenche o que falta
    python api/semear_demanda.py --mostrar  # so lista, nao escreve

DE ONDE VEM CADA NUMERO. Nenhum e medicao: sao ordens de grandeza tipicas do
segmento, escolhidas para a demonstracao ser honesta e o modelo ser exercitado
nos dois extremos. A loja real troca isso pela propria fatura, que e de onde
esses numeros deveriam sair — a demanda contratada e a carga base estao
impressas nela.
"""

from __future__ import annotations

import os
import sys

import psycopg
from psycopg.rows import dict_row

# segmento -> (demanda kW, carga base kW, solar kWp, bateria kWh, bateria kW,
#              grupo tarifario, tarifa de ponta)
#
# A carga base e a peca que costuma faltar no raciocinio: o carregador divide o
# medidor com a loja. Um supermercado gasta 145 kW em camara fria e climatizacao
# ANTES de qualquer carro chegar, e e por isso que contratar 220 kW nao quer
# dizer ter 220 kW para carregar.
#
# Solar e bateria so onde o investimento se paga: area de telhado e conta de
# energia grande. Deixar farmacia e pet shop sem geracao e proposital — e o
# caso da maioria das lojas, e o sistema nao pode depender de ter painel.
PERFIL = {
    "mercado":     (220.0, 145.0,  80.0, 60.0, 30.0, "A", 2.1500),
    "shopping":    (300.0, 180.0, 120.0, 80.0, 40.0, "A", 2.1500),
    "restaurante": ( 60.0,  26.0,  20.0, 15.0,  7.5, "B", 2.1500),
    "academia":    ( 90.0,  34.0,  30.0,  0.0,  0.0, "B", None),
    "pet":         ( 75.0,  18.0,   0.0,  0.0,  0.0, "B", None),
    "farmacia":    ( 45.0,  16.0,   0.0,  0.0,  0.0, "B", None),
    "cafe":        ( 40.0,  14.0,   0.0,  0.0,  0.0, "B", None),
    "outro":       ( 60.0,  20.0,   0.0,  0.0,  0.0, "B", None),
}


def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("!! sem DATABASE_URL no ambiente")
        return 2
    mostrar = "--mostrar" in sys.argv

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row,
                         autocommit=True) as con, con.cursor() as cur:
        cur.execute(
            "SELECT e.id, e.nome, e.segmento, e.demanda_contratada_kw, e.carga_base_kw,"
            "       coalesce(sum(c.potencia_kw) FILTER (WHERE c.ativo), 0) AS instalada"
            "  FROM estabelecimentos e"
            "  LEFT JOIN carregadores c ON c.estabelecimento_id = e.id"
            " WHERE e.ativo GROUP BY e.id ORDER BY e.id")
        lojas = cur.fetchall()

        mexidas = 0
        for l in lojas:
            perfil = PERFIL.get(l["segmento"], PERFIL["outro"])
            demanda, base, solar, bat_kwh, bat_kw, grupo, ponta = perfil

            # So preenche o que esta vazio. Demanda ja declarada e a da fatura
            # de verdade, e nao e deste script sobrescrever.
            falta_demanda = l["demanda_contratada_kw"] is None
            falta_base = float(l["carga_base_kw"] or 0) == 0.0
            if not (falta_demanda or falta_base):
                continue

            sobra = (demanda if falta_demanda else float(l["demanda_contratada_kw"])) - base
            aperto = " <- carregadores pedem mais que a folga" if l["instalada"] > sobra else ""
            print(f"  {l['nome'][:30]:<32} {l['segmento']:<12} "
                  f"contratada {demanda:>5.0f}  base {base:>5.0f}  "
                  f"instalada {float(l['instalada']):>5.0f} kW{aperto}")

            mexidas += 1
            if mostrar:
                continue
            cur.execute(
                "UPDATE estabelecimentos SET"
                "   demanda_contratada_kw = coalesce(demanda_contratada_kw, %s),"
                "   carga_base_kw         = CASE WHEN carga_base_kw = 0 THEN %s ELSE carga_base_kw END,"
                "   solar_kwp             = CASE WHEN solar_kwp = 0 THEN %s ELSE solar_kwp END,"
                "   bateria_kwh           = CASE WHEN bateria_kwh = 0 THEN %s ELSE bateria_kwh END,"
                "   bateria_kw            = CASE WHEN bateria_kw = 0 THEN %s ELSE bateria_kw END,"
                "   grupo_tarifario       = %s,"
                "   tarifa_ponta_kwh_brl  = coalesce(tarifa_ponta_kwh_brl, %s)"
                " WHERE id = %s",
                (demanda, base, solar, bat_kwh, bat_kw, grupo, ponta, l["id"]))

    print(f"\n  {'seriam preenchidas' if mostrar else 'preenchidas'}: {mexidas} loja(s)")
    if not mostrar:
        print("  as que ja tinham demanda declarada ficaram como estavam")
    return 0


if __name__ == "__main__":
    sys.exit(main())
