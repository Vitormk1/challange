"""Cria o dia de demonstracao do card "Bateria e as reservas".

O card so tem o que mostrar quando existe demanda concentrada numa hora cara:
e a meta de carga que faz a linha tracejada subir, e sem deficit ela fica reta
em 10% o dia inteiro. As lojas do mapa nasceram do `semear_mapa.py` com curvas
baixas demais para isso acontecer.

Este script escolhe UMA loja com bateria e escreve leituras de um dia em que
tres vagas carregaram juntas as 19h -- o pior caso que o modulo foi feito para
resolver. Nada e inventado sobre o comportamento da bateria: as leituras sao a
carga dos carregadores, e a meta sai da conta de `metas_de_bateria`.

Aditivo e idempotente, como os outros semear_*: rodar de novo nao duplica.

    python api/semear_bateria.py            # escreve
    python api/semear_bateria.py --mostrar  # so diz o que faria

POR QUE LEITURAS, E NAO RESERVAS. As duas alimentam a mesma curva (ver
`curva_do_dia`), e a reserva seria a demonstracao mais fiel da ideia. Mas
reserva vale para um horario: passada a hora, ela some da curva e o card volta
a ficar reto -- no dia da apresentacao nao teria nada. Leitura fica.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

BRASIL = timezone(timedelta(hours=-3))

# A hora do aperto: dentro da ponta padrao (18h-21h), quando o sol ja se pos e
# a tarifa esta cara. Tres vagas na potencia nominal ao mesmo tempo.
HORA_PICO = 19
DURACAO_H = 2
PASSO_MIN = 15

# Marca do dia semeado. Fica 8 dias atras para nao colidir com leitura real e
# para `dia_de_referencia` cair nele quando a loja nao tiver medicao de hoje.
DIAS_ATRAS = 8


def conectar():
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("!! sem DATABASE_URL no ambiente")
        raise SystemExit(1)
    return psycopg.connect(url, row_factory=dict_row)


def escolher_loja(cur) -> dict | None:
    """A loja com bateria cuja soma de carregadores mais estoura o teto.

    Estourar e o requisito: se os carregadores cabem na folga, nao ha deficit,
    nao ha meta, e o card nao tem historia para contar.
    """
    cur.execute("""
        SELECT e.*,
               (SELECT coalesce(sum(c.potencia_kw), 0) FROM carregadores c
                 WHERE c.estabelecimento_id = e.id AND c.ativo) AS instalada_kw,
               (SELECT count(*) FROM carregadores c
                 WHERE c.estabelecimento_id = e.id AND c.ativo) AS vagas
          FROM estabelecimentos e
         WHERE e.ativo AND e.bateria_kwh > 0 AND e.bateria_kw > 0
           AND e.demanda_contratada_kw > 0
         ORDER BY e.id""")
    melhor, melhor_excesso = None, 0.0
    for l in cur.fetchall():
        if int(l["vagas"]) < 2:
            continue
        teto = float(l["demanda_contratada_kw"]) * 0.95
        folga = teto - float(l["carga_base_kw"] or 0)
        excesso = float(l["instalada_kw"]) - folga
        if excesso > melhor_excesso:
            melhor, melhor_excesso = l, excesso
    return melhor


def main() -> None:
    mostrar = "--mostrar" in sys.argv
    with conectar() as con, con.cursor() as cur:
        loja = escolher_loja(cur)
        if not loja:
            print("!! nenhuma loja com bateria e carregadores acima do teto")
            return

        cur.execute("SELECT id, nome, potencia_kw FROM carregadores"
                    " WHERE estabelecimento_id = %s AND ativo ORDER BY id",
                    (loja["id"],))
        vagas = cur.fetchall()

        teto = float(loja["demanda_contratada_kw"]) * 0.95
        folga = teto - float(loja["carga_base_kw"] or 0)
        juntas = sum(float(v["potencia_kw"]) for v in vagas)
        print(f"  loja:      {loja['nome']}")
        print(f"  contratada {loja['demanda_contratada_kw']} kW  "
              f"base {loja['carga_base_kw']} kW  teto util {folga:.1f} kW")
        print(f"  {len(vagas)} vagas somam {juntas:.1f} kW  -> excesso de "
              f"{juntas - folga:.1f} kW as {HORA_PICO}h")
        print(f"  bateria:   {loja['bateria_kwh']} kWh / {loja['bateria_kw']} kW")

        dia = (datetime.now(BRASIL) - timedelta(days=DIAS_ATRAS)).replace(
            hour=0, minute=0, second=0, microsecond=0)
        inicio = dia.replace(hour=HORA_PICO)
        fim = inicio + timedelta(hours=DURACAO_H)

        cur.execute("SELECT count(*) AS n FROM leituras l"
                    " JOIN carregadores c ON c.id = l.carregador_id"
                    " WHERE c.estabelecimento_id = %s"
                    "   AND l.momento >= %s AND l.momento < %s",
                    (loja["id"], inicio, fim))
        if cur.fetchone()["n"]:
            print(f"  ja semeado em {dia.date()} — nada a fazer")
            return

        linhas = []
        t = inicio
        while t < fim:
            for v in vagas:
                # Potencia nominal com uma queda leve no fim, que e como uma
                # sessao real se comporta (ver ai/charge_curve.py). Nao muda a
                # conta da meta; evita uma reta perfeita, que nao existe.
                fracao = 1.0 if t < inicio + timedelta(hours=1) else 0.82
                linhas.append((v["id"], t, round(float(v["potencia_kw"]) * fracao, 3)))
            t += timedelta(minutes=PASSO_MIN)

        print(f"  {len(linhas)} leituras de {inicio:%d/%m %H:%M} a {fim:%H:%M}")
        if mostrar:
            print("  (--mostrar: nada foi escrito)")
            return

        cur.executemany(
            "INSERT INTO leituras (carregador_id, momento, potencia_kw)"
            " VALUES (%s, %s, %s)", linhas)
        con.commit()
        print(f"  gravado. O card 'Bateria e as reservas' da loja {loja['id']}"
              f" passa a mostrar a meta subindo antes das {HORA_PICO}h.")


if __name__ == "__main__":
    main()
