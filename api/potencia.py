"""Demanda de potencia: o que o banco sabe, a conta que ai/demanda.py faz.

Divisao de trabalho, e ela e proposital:

    ai/demanda.py    fisica e regra de negocio. Funcao pura, sem banco e sem
                     relogio implicito. Da para simular um dia inteiro em
                     milissegundos e testar o pior caso sem esperar por ele.

    este arquivo     traduz linhas de tabela para os objetos daquele modulo,
                     e devolve o resultado como rota.

A curva de 24 horas sai de duas fontes que JA existiam no sistema e nunca
tinham sido somadas:

    leituras   o que ja aconteceu. A tabela grava potencia por carregador e
               por instante desde o inicio do projeto.
    reservas   o que vai acontecer. Uma reserva e uma sessao que a loja ja
               sabe que vem, com hora marcada.

E por isso que o grafico nao e so historico: ele enxerga o resto do dia.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Cookie, Depends, HTTPException

from db import conectar

# ai/ e irmao de api/, e o servidor roda com api/ no sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ai.demanda import (  # noqa: E402
    Bateria, Local, Tarifa, fator_cashback, folga_kw, melhor_hora_de_carregar,
    melhor_janela,
    plano_do_dia, repartir, solar_kw,
)

BRASIL = timezone(timedelta(hours=-3))

# Uma leitura mais velha que isto nao conta como "agora". Sem esse corte, um
# carregador que parou de reportar continuaria somando potencia para sempre, e
# o teto ficaria ocupado por um carro que ja foi embora.
LEITURA_RECENTE_MIN = 10


def _agora() -> datetime:
    return datetime.now(BRASIL)


# ==========================================================================
# Do banco para o modelo
# ==========================================================================

def local_da_loja(linha: dict) -> Local:
    """Monta o `Local` de ai/demanda.py a partir da linha de estabelecimentos.

    Uma loja sem tarifa de ponta cadastrada nao fica sem tarifa: ela usa a
    mesma o dia inteiro. E o caso do Grupo B sem tarifa branca, que e a
    maioria das lojas pequenas -- e tratar isso como "sem tarifa" faria a tela
    esconder o preco de quem simplesmente nao tem hora cara.
    """
    fora = float(linha.get("tarifa_kwh_brl") or 0.0)
    ponta = linha.get("tarifa_ponta_kwh_brl")
    tarifa = Tarifa(
        fora_ponta_kwh=fora,
        ponta_kwh=float(ponta) if ponta is not None else fora,
        ponta_inicio=int(linha.get("ponta_inicio") or 18),
        ponta_fim=int(linha.get("ponta_fim") or 21),
        grupo=str(linha.get("grupo_tarifario") or "B"),
    )

    bateria = None
    if float(linha.get("bateria_kwh") or 0) > 0 and float(linha.get("bateria_kw") or 0) > 0:
        bateria = Bateria(
            capacidade_kwh=float(linha["bateria_kwh"]),
            potencia_kw=float(linha["bateria_kw"]),
            soc=float(linha.get("bateria_soc") or 0.5),
        )

    return Local(
        demanda_contratada_kw=float(linha.get("demanda_contratada_kw") or 0.0),
        carga_base_kw=float(linha.get("carga_base_kw") or 0.0),
        tarifa=tarifa,
        solar_kwp=float(linha.get("solar_kwp") or 0.0),
        bateria=bateria,
        latitude=float(linha["lat"]) if linha.get("lat") is not None else -23.55,
    )


def carga_agora_kw(cur, estabelecimento_id: int) -> float:
    """Quanto os carregadores desta loja puxam neste momento.

    A ultima leitura de CADA carregador, e so as recentes. Somar todas as
    leituras da janela contaria o mesmo carro varias vezes.
    """
    cur.execute(
        "SELECT coalesce(sum(t.potencia_kw), 0) AS kw FROM ("
        "  SELECT DISTINCT ON (l.carregador_id) l.potencia_kw"
        "    FROM leituras l JOIN carregadores c ON c.id = l.carregador_id"
        "   WHERE c.estabelecimento_id = %s"
        "     AND l.momento > now() - make_interval(mins => %s)"
        "   ORDER BY l.carregador_id, l.momento DESC) t",
        (estabelecimento_id, LEITURA_RECENTE_MIN))
    return float(cur.fetchone()["kw"])


def dia_de_referencia(cur, estabelecimento_id: int, hoje: datetime) -> tuple[datetime, bool]:
    """Qual dia o grafico mostra.

    Hoje, quando ha leitura de hoje. Senao, o ultimo dia que teve -- e a tela
    DIZ qual e. Mostrar hoje vazio seria pior que mostrar outro dia: uma barra
    de carregadores em zero se le como "ninguem carregou", e nao como "nao ha
    medicao", que sao coisas diferentes para quem esta decidindo se aumenta a
    demanda contratada.
    """
    inicio = hoje.replace(hour=0, minute=0, second=0, microsecond=0)
    cur.execute(
        "SELECT 1 FROM leituras l JOIN carregadores c ON c.id = l.carregador_id"
        " WHERE c.estabelecimento_id = %s AND l.momento >= %s LIMIT 1",
        (estabelecimento_id, inicio))
    if cur.fetchone():
        return hoje, True

    cur.execute(
        "SELECT max(l.momento) AS ultimo FROM leituras l"
        "  JOIN carregadores c ON c.id = l.carregador_id"
        " WHERE c.estabelecimento_id = %s", (estabelecimento_id,))
    linha = cur.fetchone()
    if not linha or not linha["ultimo"]:
        return hoje, True          # loja sem leitura nenhuma: hoje mesmo, vazio
    ultimo = linha["ultimo"].astimezone(BRASIL)
    return ultimo, False


def curva_do_dia(cur, estabelecimento_id: int, dia: datetime) -> dict[int, float]:
    """kW nos carregadores, hora a hora. Passado medido, futuro reservado."""
    inicio = dia.replace(hour=0, minute=0, second=0, microsecond=0)
    fim = inicio + timedelta(days=1)

    # --- o que ja aconteceu -------------------------------------------------
    # Media por carregador e depois soma: as leituras dos varios carregadores
    # nao chegam no mesmo instante, entao agrupar pelo `momento` exato perderia
    # linhas. A media de cada um somada da a potencia media total da hora.
    cur.execute(
        "SELECT h, sum(kw_medio) AS kw FROM ("
        "  SELECT extract(hour from l.momento AT TIME ZONE 'America/Sao_Paulo')::int AS h,"
        "         l.carregador_id, avg(l.potencia_kw) AS kw_medio"
        "    FROM leituras l JOIN carregadores c ON c.id = l.carregador_id"
        "   WHERE c.estabelecimento_id = %s AND l.momento >= %s AND l.momento < %s"
        "   GROUP BY 1, 2) t GROUP BY h",
        (estabelecimento_id, inicio, fim))
    horas = {int(r["h"]): float(r["kw"]) for r in cur.fetchall()}

    # --- o que ainda vem ----------------------------------------------------
    # A reserva entra pela potencia NOMINAL da vaga, que e o pior caso. Uma
    # sessao real afunila no fim (ver ai/charge_curve.py) e puxa menos, mas
    # planejar demanda pelo caso medio e como dimensionar disjuntor pela conta
    # do mes. Aqui se planeja pelo teto.
    cur.execute(
        "SELECT extract(hour from r.inicio AT TIME ZONE 'America/Sao_Paulo')::int AS h,"
        "       sum(c.potencia_kw) AS kw"
        "  FROM reservas r JOIN carregadores c ON c.id = r.carregador_id"
        " WHERE c.estabelecimento_id = %s AND r.situacao = 'ativa'"
        "   AND r.inicio >= %s AND r.inicio < %s AND r.inicio > now()"
        " GROUP BY 1",
        (estabelecimento_id, inicio, fim))
    for r in cur.fetchall():
        h = int(r["h"])
        horas[h] = max(horas.get(h, 0.0), float(r["kw"]))

    return horas


# ==========================================================================
# Rotas
# ==========================================================================

def registrar_potencia(app, usuario_atual):
    router = APIRouter()

    def lojista(u=Depends(usuario_atual)):
        if u["papel"] == "motorista":
            raise HTTPException(403, "A demanda da loja é do painel do lojista.")
        return u

    @router.get("/estabelecimentos/{estabelecimento_id}/demanda")
    def demanda(estabelecimento_id: int, u=Depends(lojista)):
        """O quadro de potencia da loja: agora, e o resto do dia.

        E a tela que faltava para `demanda_contratada_kw` deixar de ser um
        campo decorativo.
        """
        from main import exigir_loja           # evita import circular na subida
        exigir_loja(u, estabelecimento_id)

        agora = _agora()
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT * FROM estabelecimentos WHERE id = %s AND ativo",
                        (estabelecimento_id,))
            loja = cur.fetchone()
            if not loja:
                raise HTTPException(404, "Loja não encontrada.")
            local = local_da_loja(loja)
            carregando = carga_agora_kw(cur, estabelecimento_id)
            referencia, e_hoje = dia_de_referencia(cur, estabelecimento_id, agora)
            horas = curva_do_dia(cur, estabelecimento_id, referencia)
            cur.execute("SELECT coalesce(sum(potencia_kw), 0) AS kw FROM carregadores "
                        " WHERE estabelecimento_id = %s AND ativo", (estabelecimento_id,))
            instalada = float(cur.fetchone()["kw"])

        f = folga_kw(local, agora, carregando)
        # A curva usa o dia de referencia (para o sol bater com a estacao do
        # dia medido); a folga usa AGORA, porque e a pergunta do lojista neste
        # instante. Misturar os dois faria o velocimetro mentir.
        linhas = plano_do_dia(local, referencia, horas)
        pico = max(linhas, key=lambda x: x["rede_kw"]) if linhas else None

        return {
            "estabelecimento_id": estabelecimento_id,
            "contratada_kw": local.demanda_contratada_kw,
            # Se todos os carregadores ligassem juntos na potencia nominal.
            # E o numero que diz se a loja PODE ter um problema, mesmo que hoje
            # nao tenha tido.
            "instalada_kw": round(instalada, 2),
            "agora": {
                "teto_kw": round(f.teto_kw, 2),
                "base_kw": round(f.base_kw, 2),
                "carregando_kw": round(f.carregando_kw, 2),
                "solar_kw": round(f.solar_kw, 2),
                "bateria_kw": round(f.bateria_kw, 2),
                "disponivel_kw": round(f.disponivel_kw, 2),
                "ocupacao": round(f.ocupacao, 3),
                "em_ponta": f.em_ponta,
                "cashback_fator": fator_cashback(local, agora, carregando),
            },
            "tarifa": {
                "grupo": local.tarifa.grupo,
                "fora_ponta_kwh": local.tarifa.fora_ponta_kwh,
                "ponta_kwh": local.tarifa.ponta_kwh,
                "ponta_inicio": local.tarifa.ponta_inicio,
                "ponta_fim": local.tarifa.ponta_fim,
            },
            "solar_kwp": local.solar_kwp,
            "bateria": ({"capacidade_kwh": local.bateria.capacidade_kwh,
                         "potencia_kw": local.bateria.potencia_kw,
                         "soc": local.bateria.soc} if local.bateria else None),
            "dia": linhas,
            "dia_referencia": referencia.date().isoformat(),
            "dia_e_hoje": e_hoje,
            "pico": pico,
            # O aviso que justifica a tela existir. `ultrapassou` compara a
            # potencia que vem da REDE com a contratada -- o que o telhado
            # entrega nao conta, porque nao passa pelo medidor.
            "risco_ultrapassagem": any(l["ultrapassou"] for l in linhas),
        }

    @router.post("/estabelecimentos/{estabelecimento_id}/repartir")
    def simular_reparticao(estabelecimento_id: int, corpo: dict | None = None,
                           u=Depends(lojista)):
        """Como a potencia disponivel seria dividida entre as sessoes ativas.

        Existe como rota porque e a resposta que o CARREGADOR precisa antes de
        liberar energia -- e, no painel, e a explicacao de por que o carro do
        cliente esta carregando a 7 kW e nao a 11.
        """
        from main import exigir_loja
        exigir_loja(u, estabelecimento_id)

        pedidos = (corpo or {}).get("pedidos_kw")
        agora = _agora()
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT * FROM estabelecimentos WHERE id = %s AND ativo",
                        (estabelecimento_id,))
            loja = cur.fetchone()
            if not loja:
                raise HTTPException(404, "Loja não encontrada.")
            local = local_da_loja(loja)
            if pedidos is None:
                # Sem pedidos no corpo, assume o pior caso: toda vaga ativa
                # querendo a potencia nominal ao mesmo tempo.
                cur.execute("SELECT nome, potencia_kw FROM carregadores "
                            " WHERE estabelecimento_id = %s AND ativo ORDER BY id",
                            (estabelecimento_id,))
                vagas = cur.fetchall()
                nomes = [v["nome"] for v in vagas]
                pedidos = [float(v["potencia_kw"]) for v in vagas]
            else:
                nomes = [f"vaga {i + 1}" for i in range(len(pedidos))]
                pedidos = [max(0.0, float(p)) for p in pedidos]

        f = folga_kw(local, agora, 0.0)
        concedido = repartir(pedidos, f.disponivel_kw)
        return {
            "disponivel_kw": round(f.disponivel_kw, 2),
            "pedido_total_kw": round(sum(pedidos), 2),
            "cabe_tudo": sum(pedidos) <= f.disponivel_kw + 1e-9,
            "vagas": [{"nome": n, "pediu_kw": round(p, 2), "recebe_kw": round(c, 2)}
                      for n, p, c in zip(nomes, pedidos, concedido)],
        }

    @router.get("/melhor-hora")
    def melhor_hora(u=Depends(usuario_atual)):
        """Quando vale mais a pena carregar, nas lojas que o motorista usa.

        `melhor_janela` ja existia em ai/demanda.py e so era consultada pela
        telinha, dentro de `contexto_da_vaga`. Quem decide a hora de carregar,
        porem, e quem dirige -- e no aplicativo dele a conta nao aparecia em
        lugar nenhum. Esta rota e a mesma funcao, exposta para o lado certo.

        Escolhe as lojas por vinculo real: onde o motorista tem ficha de
        fidelidade, e onde ele tem reserva marcada. Sem vinculo nenhum, cai
        para as lojas com carregador ativo -- devolver lista vazia para conta
        nova esconderia a funcionalidade justamente de quem ainda nao conhece.
        """
        from main import exigir_motorista     # evita import circular na subida
        exigir_motorista(u)

        agora = _agora()
        with conectar() as con, con.cursor() as cur:
            cur.execute(
                "SELECT e.* FROM estabelecimentos e"
                " WHERE e.ativo AND ("
                "   e.id IN (SELECT estabelecimento_id FROM clientes WHERE usuario_id = %s)"
                "   OR e.id IN (SELECT c.estabelecimento_id FROM reservas r"
                "                 JOIN carregadores c ON c.id = r.carregador_id"
                "                WHERE r.usuario_id = %s AND r.situacao = 'ativa'"
                "                  AND r.fim > now()))"
                " ORDER BY e.nome", (u["id"], u["id"]))
            linhas = cur.fetchall()
            if not linhas:
                cur.execute(
                    "SELECT e.* FROM estabelecimentos e"
                    " WHERE e.ativo AND EXISTS (SELECT 1 FROM carregadores c"
                    "   WHERE c.estabelecimento_id = e.id AND c.ativo)"
                    " ORDER BY e.nome LIMIT 6")
                linhas = cur.fetchall()

        lojas = []
        for l in linhas:
            local = local_da_loja(l)
            if local.tarifa is None or local.tarifa.fora_ponta_kwh <= 0:
                continue                      # loja sem preco cadastrado nao opina
            r = melhor_hora_de_carregar(local, agora)
            barato, credito = r["mais_barato"], r["mais_cashback"]
            # Loja sem nada melhor a frente NAO e descartada. "Agora e a
            # melhor hora" e resposta, e e a resposta certa na maior parte do
            # dia: fora da ponta nao ha preco melhor a sugerir, e perto do
            # meio-dia o sol ja esta no pico. Descartar essas lojas esvaziava
            # a lista, a secao inteira ficava escondida, e a funcionalidade
            # simplesmente nao existia para quem abrisse o aplicativo de dia.
            lojas.append({
                "nada_melhor_a_frente": not barato and not credito,
                "estabelecimento_id": l["id"],
                "estabelecimento_nome": l["nome"],
                "agora": {
                    "em_ponta": r["agora"]["em_ponta"],
                    "preco_kwh_brl": round(r["agora"]["preco_kwh_brl"], 4),
                    "cashback_fator": r["agora"]["cashback_fator"],
                },
                "mais_barato": None if not barato else {
                    "quando": barato["quando"].isoformat(),
                    "economia_pct": round(barato["economia_pct"], 1),
                },
                "mais_cashback": None if not credito else {
                    "quando": credito["quando"].isoformat(),
                    "fator": credito["fator"],
                    "vezes_mais": round(credito["vezes_mais"], 2),
                },
            })

        # Primeiro quem tem mais a ganhar esperando. Economia de preco pesa
        # mais que credito porque sai do bolso na hora; o credito so vale na
        # proxima compra. Empate: nome, para a ordem nao dancar a cada
        # atualizacao da tela.
        # Quem nao tem nada a ganhar esperando vai para o fim, mas continua na
        # lista: a tela usa a primeira dessas para dizer "agora e a melhor
        # hora" quando nenhuma loja tem sugestao.
        def ganho(x):
            p = x["mais_barato"]["economia_pct"] if x["mais_barato"] else 0.0
            c = 100.0 * (x["mais_cashback"]["vezes_mais"] - 1) if x["mais_cashback"] else 0.0
            return -(p + c * 0.5)

        lojas.sort(key=lambda x: (ganho(x), x["estabelecimento_nome"]))
        return {"agora": agora.isoformat(), "lojas": lojas}

    app.include_router(router)


# ==========================================================================
# Usado pelo lado do motorista (reservas.py)
# ==========================================================================

def contexto_da_vaga(cur, carregador_id: int, momento: datetime) -> dict | None:
    """Potencia, preco e cashback daquela vaga naquele instante.

    Chamado pela rota que o carregador consulta antes de liberar energia. O
    que o motorista ve na telinha -- "voce tem 30 minutos e 7 kW" -- sai daqui.
    """
    cur.execute(
        "SELECT c.potencia_kw, c.cashback_pct, c.preco_kwh_brl, e.* "
        "  FROM carregadores c JOIN estabelecimentos e ON e.id = c.estabelecimento_id "
        " WHERE c.id = %s AND c.ativo AND e.ativo", (carregador_id,))
    linha = cur.fetchone()
    if not linha:
        return None

    local = local_da_loja(linha)
    carregando = carga_agora_kw(cur, linha["id"])
    f = folga_kw(local, momento, carregando)

    nominal = float(linha["potencia_kw"])
    # A vaga nunca entrega mais que a propria potencia, nem mais que a folga.
    concedida = min(nominal, f.disponivel_kw)
    fator = fator_cashback(local, momento, carregando)
    janela = melhor_janela(local, momento)

    return {
        "potencia_nominal_kw": round(nominal, 2),
        "potencia_liberada_kw": round(max(0.0, concedida), 2),
        "limitada_pela_rede": concedida < nominal - 1e-9,
        "disponivel_na_loja_kw": round(f.disponivel_kw, 2),
        "solar_kw": round(f.solar_kw, 2),
        "em_ponta": f.em_ponta,
        "preco_kwh_brl": round(local.tarifa.preco_kwh(momento), 4),
        "cashback_pct": round(float(linha["cashback_pct"]) * fator, 2),
        "cashback_fator": fator,
        "melhor_em": janela["melhor_em"].isoformat() if janela["melhor_em"] else None,
        "economia_pct": round(janela["economia_pct"], 1),
    }
