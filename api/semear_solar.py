"""Cria a loja-vitrine da secao "Placa solar".

A secao funciona em qualquer loja -- a geracao e fisica, nao medicao. Mas a
HISTORIA que ela conta depende de duas coisas que nenhuma loja em producao
tinha, e que foram descobertas rodando a conta contra o banco:

1. **Nenhuma das 10 lojas com solar tem excedente.** Em todas, o sol nunca
   passa do consumo da propria loja -- a mais folgada fica 11 kW abaixo. Sem
   excedente, o ramo "sobra sol" de `plano_do_dia` nunca dispara e a bateria
   nunca carrega do sol. O "excedente e armazenado" era indemonstravel.

2. **O dia semeado pelo `semear_bateria.py` caiu num sabado**, e fim de semana
   nao tem tarifa de ponta. Sem ponta a bateria tambem nunca descarrega, e o
   `soc` fica reto em 0,500 as 24 horas.

Este script resolve as duas: instala solar numa loja pequena o bastante para o
sol passar do consumo, e semeia um dia UTIL com carga no almoco e na ponta.

O resultado, conferido: a bateria percorre as quatro faixas.

    10h-11h  a sobra de sol carrega        0,50 -> 0,74   bom
    12h-13h  os carros puxam, o sol vai direto
    14h      volta a sobrar                0,74 -> 0,80   excelente
    18h      ponta, a bateria entrega      0,80 -> 0,30   critico
    20h      chega no piso, passa p/ rede  0,10           troca

Aditivo e idempotente, como os outros semear_*: rodar de novo nao duplica.

    python api/semear_solar.py --mostrar    # so diz o que faria
    python api/semear_solar.py              # escreve

RODAR DE NOVO NA MANHA DA APRESENTACAO. O bloco de "hoje" so cobre as horas
que ja passaram -- leitura e medicao, e semear o futuro seria mentira. Rodando
de manha, `dia_de_referencia` devolve hoje e a tela mostra um dia vivo em vez
de "ultimo dia com medicao".
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

BRASIL = timezone(timedelta(hours=-3))

# A loja. Por nome, e nao por id, porque o nome e o que se confere de olho
# antes de escrever em producao.
LOJA = "Pet & Cia Vila Mariana"

# A instalacao a criar. Os numeros nao sao redondos por acaso:
#
#   30 kWp   pico de 22,2 kW contra 18 kW de consumo proprio -> sobra real de
#            ~4 kW ao redor do meio-dia. Menos que isso e o sol nunca passa do
#            consumo e a bateria nao tem o que guardar.
#   20 kWh   absorve a sobra do dia inteiro sem transbordar.
#   10 kW    cobre dois tercos da ponta. O resto vem da rede -- e e justamente
#            isso que faz o aviso de troca aparecer, que e o ponto da tela.
INSTALACAO = {
    "solar_kwp": 30.0,
    "bateria_kwh": 20.0,
    "bateria_kw": 10.0,
    # Vila Mariana. As tres lojas do painel estao sem coordenada, e sem ela
    # `local_da_loja` cai no padrao de Sao Paulo -- funciona, mas a tela passa
    # a avisar que a latitude e estimada.
    "lat": -23.5890,
    "lng": -46.6340,
}

# Os dois blocos de carga, em (hora_inicial, duracao_em_horas).
#
# O do almoco e o que faz a tela existir: sem carga de dia, `para_carros_kwh` e
# zero e o sol teria ido inteiro para a loja -- o bloco "para onde foi o sol"
# nao teria o que dizer. O da ponta mostra a bateria devolvendo. Sao as duas
# metades da historia.
BLOCOS = ((12, 2), (18, 3))
PASSO_MIN = 15


def conectar():
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("!! sem DATABASE_URL no ambiente")
        raise SystemExit(1)
    return psycopg.connect(url, row_factory=dict_row)


def dia_util_anterior(referencia: datetime) -> datetime:
    """O dia util mais recente antes de `referencia`.

    Pular o fim de semana nao e capricho: `Tarifa.em_ponta` devolve False em
    sabado e domingo, e um dia sem ponta e um dia em que a bateria nunca
    descarrega. Foi exatamente assim que o dia semeado antes saiu reto.
    """
    d = referencia - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.replace(hour=0, minute=0, second=0, microsecond=0)


def leituras_do_dia(vagas: list[dict], dia: datetime,
                    ate: datetime | None = None) -> list[tuple]:
    """As leituras dos blocos daquele dia, sem passar de `ate`."""
    linhas = []
    for hora, duracao in BLOCOS:
        inicio = dia.replace(hour=hora)
        fim = inicio + timedelta(hours=duracao)
        t = inicio
        while t < fim:
            if ate is not None and t >= ate:
                break
            for v in vagas:
                # Potencia nominal com uma queda leve na segunda metade, que e
                # como uma sessao real se comporta (ver ai/charge_curve.py).
                # Nao muda nenhuma conta; evita a reta perfeita, que nao existe.
                fracao = 1.0 if t < inicio + timedelta(hours=1) else 0.82
                linhas.append((v["id"], t, round(float(v["potencia_kw"]) * fracao, 3)))
            t += timedelta(minutes=PASSO_MIN)
    return linhas


def ja_tem_leitura(cur, loja_id: int, dia: datetime) -> bool:
    cur.execute("SELECT count(*) AS n FROM leituras l"
                " JOIN carregadores c ON c.id = l.carregador_id"
                " WHERE c.estabelecimento_id = %s"
                "   AND l.momento >= %s AND l.momento < %s",
                (loja_id, dia, dia + timedelta(days=1)))
    return bool(cur.fetchone()["n"])


def main() -> None:
    mostrar = "--mostrar" in sys.argv
    agora = datetime.now(BRASIL)

    with conectar() as con, con.cursor() as cur:
        cur.execute("SELECT * FROM estabelecimentos WHERE nome = %s AND ativo", (LOJA,))
        loja = cur.fetchone()
        if not loja:
            print(f"!! loja '{LOJA}' nao encontrada")
            return
        if loja["so_mapa"]:
            print(f"!! '{LOJA}' e so do mapa -- o painel nao consegue abri-la")
            return

        cur.execute("SELECT id, nome, potencia_kw FROM carregadores"
                    " WHERE estabelecimento_id = %s AND ativo ORDER BY id",
                    (loja["id"],))
        vagas = cur.fetchall()
        if not vagas:
            print(f"!! '{LOJA}' nao tem carregador ativo")
            return

        juntas = sum(float(v["potencia_kw"]) for v in vagas)
        print(f"  loja:      {loja['nome']} (#{loja['id']})")
        print(f"  consumo    {float(loja['carga_base_kw']):.0f} kW de base  "
              f"{len(vagas)} vagas somando {juntas:.1f} kW")

        # ---------------------------------------------------- a instalacao --
        instalar = float(loja["solar_kwp"] or 0) <= 0
        if instalar:
            print(f"  instalar:  {INSTALACAO['solar_kwp']:.0f} kWp  "
                  f"bateria {INSTALACAO['bateria_kwh']:.0f} kWh / "
                  f"{INSTALACAO['bateria_kw']:.0f} kW"
                  + ("  + coordenada" if loja["lat"] is None else ""))
        else:
            print(f"  instalar:  ja tem {float(loja['solar_kwp']):.0f} kWp — nada a fazer")

        # ---------------------------------------------------- as leituras ---
        ontem = dia_util_anterior(agora)
        hoje = agora.replace(hour=0, minute=0, second=0, microsecond=0)
        planos = []
        for dia, ate in ((ontem, None), (hoje, agora)):
            if agora.weekday() >= 5 and dia == hoje:
                print(f"  {dia.date()}: fim de semana, sem ponta — pulado")
                continue
            if ja_tem_leitura(cur, loja["id"], dia):
                print(f"  {dia.date()}: ja tem leitura — pulado")
                continue
            linhas = leituras_do_dia(vagas, dia, ate)
            if not linhas:
                print(f"  {dia.date()}: nenhum bloco ja aconteceu — nada a semear")
                continue
            planos.append((dia, linhas))
            quando = "o dia inteiro" if ate is None else f"ate {ate:%H:%M}"
            print(f"  {dia.date()}: {len(linhas)} leituras, {quando}")

        if mostrar:
            print("  (--mostrar: nada foi escrito)")
            return
        if not instalar and not planos:
            print("  nada a fazer.")
            return

        if instalar:
            campos = dict(INSTALACAO)
            if loja["lat"] is not None:        # nao sobrescreve coordenada real
                campos.pop("lat", None)
                campos.pop("lng", None)
            sets = ", ".join(f"{k} = %s" for k in campos)
            cur.execute(f"UPDATE estabelecimentos SET {sets}, atualizado_em = now()"
                        f" WHERE id = %s", (*campos.values(), loja["id"]))

        for _, linhas in planos:
            cur.executemany(
                "INSERT INTO leituras (carregador_id, momento, potencia_kw)"
                " VALUES (%s, %s, %s)", linhas)
        con.commit()

        total = sum(len(l) for _, l in planos)
        print(f"  gravado: {total} leituras"
              + (" e a instalacao solar." if instalar else "."))
        print(f"  A secao 'Placa solar' da loja {loja['id']} passa a mostrar a"
              f" bateria carregando do excedente e devolvendo na ponta.")


if __name__ == "__main__":
    main()
