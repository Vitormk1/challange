"""Popula o banco com 30 dias de operação de três lojas.

Os segmentos não foram escolhidos ao acaso: eles mostram o contraste que o
painel precisa deixar claro — pet shop paga a cortesia com folga, restaurante
paga na conta, supermercado não paga. É o resultado de ai/break_even.py
virando dado.

Tudo é montado em memória e enviado em poucos comandos. Inserir linha a linha
contra um banco na nuvem é uma ida e volta pela rede por linha, e são milhares
de linhas — a diferença é entre segundos e meia hora.

    python api/seed.py            # apaga e recria os dados de demonstração
"""

from __future__ import annotations

import hashlib
import json
import os
import random
from datetime import datetime, timedelta, timezone

from auth import criar_hash
from db import conectar

random.seed(20260821)

TARIFA = 0.7890
UPLIFT = 0.12          # quanto o ticket de quem carrega sobe
NOVOS = 0.20           # fatia de clientes que não viria sem o carregador
COMPRAM = 0.90         # quantos de fato passam no caixa
DIAS = 30

# (nome, segmento, margem %, ticket médio, demanda kW)
LOJAS = [
    ("Pet & Cia Vila Mariana", "pet",         22.0, 180.0, 75.0),
    ("Cantina do Porto",       "restaurante", 12.0,  95.0, 60.0),
    ("Supermercado Bom Preço", "mercado",      2.9, 140.0, 220.0),
]

# (nome, kW, modo, teto kWh, preço R$/kWh)
CARREGADORES = {
    "pet": [
        ("Vaga 1 — frente",  7.40, "cortesia", 6.0, None),
        ("Vaga 2 — lateral", 7.40, "cortesia", 6.0, None),
    ],
    "restaurante": [
        ("Vaga do salão", 7.40, "cortesia", 4.0, None),
        ("Vaga da rua",  11.00, "pago",     0.0, 1.90),
    ],
    "mercado": [
        ("Estacionamento A", 22.00, "pago", 0.0, 1.75),
        ("Estacionamento B", 22.00, "pago", 0.0, 1.75),
        ("Vaga rápida",      50.00, "pago", 0.0, 2.40),
    ],
}

VEICULOS = [
    ("BYD Dolphin Mini", 38.0), ("BYD Dolphin", 44.9), ("Renault Kwid E-Tech", 26.8),
    ("Volvo EX30", 69.0), ("GWM Ora 03", 48.0), ("Fiat 500e", 42.0),
    ("Chevrolet Bolt", 65.0), ("BYD Seal", 82.5), ("Caoa Chery iCar", 30.6),
]

APELIDOS = ["Ana", "Bruno", "Carla", "Diego", "Elis", "Fábio", "Gabi", "Heitor",
            "Iara", "João", "Kelly", "Lucas", "Marina", "Nando", "Olívia",
            "Paulo", "Rita", "Sérgio", "Tati", "Vitor"]

# Cada card guarda o tamanho junto: e o que faz o layout atravessar de um
# computador para outro exatamente como a pessoa deixou.
CARDS_PADRAO = [
    {"id": "retorno",  "grupo": "large", "cols": 11, "rows": 4, "config": {}},
    {"id": "teto",     "grupo": "large", "cols": 9,  "rows": 4, "config": {}},
    {"id": "lucro",    "grupo": "small", "cols": 5,  "rows": 2, "config": {}},
    {"id": "sessoes",  "grupo": "small", "cols": 5,  "rows": 2, "config": {}},
    {"id": "clientes", "grupo": "small", "cols": 5,  "rows": 2, "config": {}},
    {"id": "energia",  "grupo": "small", "cols": 5,  "rows": 2, "config": {}},
]

# Painel do operador: os mesmos indicadores, sem nada de dinheiro.
CARDS_OPERADOR = [
    {"id": "horas",    "grupo": "large", "cols": 11, "rows": 4, "config": {}},
    {"id": "pontos",   "grupo": "large", "cols": 9,  "rows": 4, "config": {}},
    {"id": "sessoes",  "grupo": "small", "cols": 5,  "rows": 2, "config": {}},
    {"id": "clientes", "grupo": "small", "cols": 5,  "rows": 2, "config": {}},
    {"id": "energia",  "grupo": "small", "cols": 5,  "rows": 2, "config": {}},
]

# Senha de demonstração. Trocar em produção, e a do main sai do ambiente.
SENHA_DEMO = os.environ.get("SENHA_DEMO", "praca2026")
SENHA_MAIN = os.environ.get("SENHA_MAIN", "praca2026")

# (apelido do slug, nome do gerente, nome do operador)
EQUIPE = {
    "pet":         ("petecia",  "Renata Alves",  "Caio Moreira"),
    "restaurante": ("cantina",  "Marco Bianchi", "Juliana Reis"),
    "mercado":     ("bompreco", "Sandro Lima",   "Patrícia Nunes"),
}

# o pico é no fim da tarde, quando a loja também está cheia
PESO_HORA = [2, 2, 3, 5, 6, 4, 3, 3, 4, 6, 8, 7, 5, 3]   # 8h..21h

# o Postgres aceita no máximo 65535 parâmetros por comando
MAX_PARAMS = 60000


def codigo_cupom(usados: set[str]) -> str:
    while True:
        letras = "".join(random.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(2))
        codigo = f"PR-{letras}{random.randint(1000, 9999)}"
        if codigo not in usados:
            usados.add(codigo)
            return codigo


def inserir(cur, tabela: str, colunas: list[str], linhas: list[tuple],
            *, devolve_id: bool = False) -> list[int]:
    """Um INSERT com muitos VALUES de uma vez, fatiado no limite do Postgres."""
    if not linhas:
        return []
    cols = ", ".join(colunas)
    marca = "(" + ",".join(["%s"] * len(colunas)) + ")"
    por_lote = max(1, MAX_PARAMS // len(colunas))
    ids: list[int] = []
    for i in range(0, len(linhas), por_lote):
        fatia = linhas[i:i + por_lote]
        sql = (f"INSERT INTO {tabela} ({cols}) VALUES "
               + ",".join([marca] * len(fatia))
               + (" RETURNING id" if devolve_id else ""))
        cur.execute(sql, [v for linha in fatia for v in linha])
        if devolve_id:
            ids.extend(l["id"] for l in cur.fetchall())
    return ids


def semear() -> None:
    agora = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    janela = agora - timedelta(days=DIAS)

    with conectar() as con, con.cursor() as cur:
        cur.execute(
            "TRUNCATE vendas, cupons, leituras, sessoes, clientes, carregadores, "
            "paineis, usuarios_estabelecimentos, estabelecimentos, usuarios "
            "RESTART IDENTITY CASCADE"
        )

        # ---- quem entra no painel ----
        main_id = inserir(
            cur, "usuarios", ["nome", "email", "papel", "senha_hash"],
            [("Vitor Nascimento", "vitor@pracaderecarga.local", "main",
              criar_hash(SENHA_MAIN))],
            devolve_id=True)[0]

        estab_ids = inserir(
            cur, "estabelecimentos",
            ["nome", "segmento", "margem_liquida_pct", "ticket_medio_brl",
             "tarifa_kwh_brl", "demanda_contratada_kw"],
            [(nome, seg, margem, ticket, TARIFA, demanda)
             for nome, seg, margem, ticket, demanda in LOJAS],
            devolve_id=True,
        )

        # um gerente e um operador por loja, e o main ligado a todas
        equipe_linhas, equipe_meta = [], []
        for estab_id, loja in zip(estab_ids, LOJAS):
            slug, nome_gerente, nome_operador = EQUIPE[loja[1]]
            for papel, nome in (("gerente", nome_gerente), ("operador", nome_operador)):
                equipe_linhas.append((nome, f"{papel}.{slug}@praca.local", papel,
                                      criar_hash(SENHA_DEMO)))
                equipe_meta.append({"estab": estab_id, "papel": papel})
        equipe_ids = inserir(cur, "usuarios",
                             ["nome", "email", "papel", "senha_hash"],
                             equipe_linhas, devolve_id=True)
        for meta, uid in zip(equipe_meta, equipe_ids):
            meta["id"] = uid

        inserir(cur, "usuarios_estabelecimentos", ["usuario_id", "estabelecimento_id"],
                [(main_id, e) for e in estab_ids]
                + [(m["id"], m["estab"]) for m in equipe_meta])

        # o compartilhado da loja é do gerente; cada um ganha o particular dele
        paineis_linhas = []
        for estab_id in estab_ids:
            gerente = next(m for m in equipe_meta
                           if m["estab"] == estab_id and m["papel"] == "gerente")
            operador = next(m for m in equipe_meta
                            if m["estab"] == estab_id and m["papel"] == "operador")
            paineis_linhas += [
                (estab_id, gerente["id"], "Painel da loja", True, True, json.dumps(CARDS_PADRAO)),
                (estab_id, gerente["id"], "Meu painel", False, False, json.dumps(CARDS_PADRAO)),
                (estab_id, operador["id"], "Meu painel", False, False, json.dumps(CARDS_OPERADOR)),
                (estab_id, main_id, "Meu painel", False, False, json.dumps(CARDS_PADRAO)),
            ]
        inserir(cur, "paineis",
                ["estabelecimento_id", "usuario_id", "nome", "compartilhado", "padrao", "cards"],
                paineis_linhas)

        # ---- carregadores ----
        linhas_carregador, meta_carregador = [], []
        for pos, (estab_id, loja) in enumerate(zip(estab_ids, LOJAS), start=1):
            segmento = loja[1]
            for i, (cnome, kw, modo, teto, preco) in enumerate(CARREGADORES[segmento], start=1):
                linhas_carregador.append((
                    estab_id, cnome, f"GW-{pos:02d}{i:02d}-{random.randint(1000, 9999)}",
                    kw, modo, teto, preco, True))
                meta_carregador.append({"estab": estab_id, "kw": float(kw), "modo": modo,
                                        "teto": float(teto), "preco": float(preco or 0)})
        ids_carregador = inserir(
            cur, "carregadores",
            ["estabelecimento_id", "nome", "numero_serie", "potencia_kw", "modo",
             "teto_cortesia_kwh", "preco_kwh_brl", "ativo"],
            linhas_carregador, devolve_id=True)
        for meta, cid in zip(meta_carregador, ids_carregador):
            meta["id"] = cid
        pontos_por_loja = {e: [m for m in meta_carregador if m["estab"] == e] for e in estab_ids}

        # ---- clientes ----
        linhas_cliente, meta_cliente = [], []
        for estab_id in estab_ids:
            for apelido in random.sample(APELIDOS, k=12):
                veiculo, bateria = random.choice(VEICULOS)
                # o banco guarda um hash, nunca o dado que identifica a pessoa
                marca = hashlib.sha256(f"{estab_id}-{apelido}".encode()).hexdigest()[:32]
                linhas_cliente.append((estab_id, marca, apelido, veiculo, bateria,
                                       janela - timedelta(days=random.randint(0, 60)),
                                       random.random() < 0.8))
                meta_cliente.append({"estab": estab_id, "bateria": bateria})
        ids_cliente = inserir(
            cur, "clientes",
            ["estabelecimento_id", "identificador_hash", "apelido", "modelo_veiculo",
             "bateria_kwh", "primeira_visita", "consentimento_lgpd"],
            linhas_cliente, devolve_id=True)
        for meta, cid in zip(meta_cliente, ids_cliente):
            meta["id"] = cid
        clientes_por_loja = {e: [m for m in meta_cliente if m["estab"] == e] for e in estab_ids}

        # ---- sessões ----
        linhas_sessao, meta_sessao = [], []
        for estab_id, loja in zip(estab_ids, LOJAS):
            ticket = loja[3]
            for dia in range(DIAS):
                data = janela + timedelta(days=dia)
                fds = data.weekday() >= 5
                for _ in range(random.randint(2, 5) + (2 if fds else 0)):
                    ponto = random.choice(pontos_por_loja[estab_id])
                    cliente = random.choice(clientes_por_loja[estab_id])
                    hora = random.choices(range(8, 22), weights=PESO_HORA)[0]
                    comeco = data.replace(hour=hora, minute=random.choice([0, 15, 30, 45]))

                    # quanto o carro aceita nesta parada
                    permanencia = (random.uniform(0.5, 2.2) if ponto["kw"] < 20
                                   else random.uniform(0.3, 0.8))
                    energia = min(ponto["kw"] * permanencia * random.uniform(0.85, 0.98),
                                  cliente["bateria"] * 0.6)
                    if ponto["modo"] == "cortesia":
                        energia = min(energia, ponto["teto"])
                    energia = round(energia, 3)

                    fim = comeco + timedelta(hours=energia / ponto["kw"])
                    # a previsão erra alguns minutos — é isso que a coluna mostra
                    previsao = fim + timedelta(minutes=random.randint(-9, 12))
                    custo = round(energia * TARIFA, 2)
                    cobrado = round(energia * ponto["preco"], 2) if ponto["modo"] == "pago" else 0.0
                    soc_i = round(random.uniform(0.15, 0.55), 3)
                    soc_f = round(min(0.98, soc_i + energia / cliente["bateria"]), 3)

                    linhas_sessao.append((
                        ponto["id"], cliente["id"], comeco, fim, energia, soc_i, soc_f,
                        ponto["modo"], previsao, cobrado or custo, custo, cobrado,
                        random.choice([0, 0, 0, 8, 20, 35]), "concluida"))
                    meta_sessao.append({"estab": estab_id, "ponto": ponto, "cliente": cliente,
                                        "inicio": comeco, "fim": fim, "custo": custo,
                                        "soc_i": soc_i, "ticket": ticket})
        ids_sessao = inserir(
            cur, "sessoes",
            ["carregador_id", "cliente_id", "inicio", "fim", "energia_kwh", "soc_inicial",
             "soc_final", "modo", "previsao_fim", "previsao_custo_brl", "custo_energia_brl",
             "valor_cobrado_brl", "minutos_ocioso", "situacao"],
            linhas_sessao, devolve_id=True)
        for meta, sid in zip(meta_sessao, ids_sessao):
            meta["id"] = sid

        # ---- leituras: uma a cada 5 minutos enquanto carrega ----
        linhas_leitura = []
        for s in meta_sessao:
            momento, soc = s["inicio"], s["soc_i"]
            while momento < s["fim"]:
                soc = min(0.99, soc + (s["ponto"]["kw"] * (5 / 60)) / s["cliente"]["bateria"])
                linhas_leitura.append((s["ponto"]["id"], s["id"], momento,
                                       round(s["ponto"]["kw"] * random.uniform(0.93, 1.0), 3),
                                       round(soc, 3)))
                momento += timedelta(minutes=5)
        inserir(cur, "leituras",
                ["carregador_id", "sessao_id", "momento", "potencia_kw", "soc"],
                linhas_leitura)

        # ---- cupons: a cortesia gera cupom, e é o cupom que liga a recarga à venda ----
        usados: set[str] = set()
        linhas_cupom, meta_cupom = [], []
        for s in meta_sessao:
            if s["ponto"]["modo"] != "cortesia":
                continue
            comprou = random.random() < COMPRAM
            usado = s["inicio"] + timedelta(minutes=random.randint(10, 90))
            linhas_cupom.append((codigo_cupom(usados), s["id"], s["custo"], s["inicio"],
                                 usado if comprou else None, s["inicio"] + timedelta(days=7)))
            meta_cupom.append({"sessao": s, "comprou": comprou, "usado": usado})
        ids_cupom = inserir(
            cur, "cupons",
            ["codigo", "sessao_id", "desconto_brl", "emitido_em", "usado_em", "expira_em"],
            linhas_cupom, devolve_id=True)
        for meta, cid in zip(meta_cupom, ids_cupom):
            meta["id"] = cid

        # ---- vendas ----
        linhas_venda = []
        for c in meta_cupom:
            if not c["comprou"]:
                continue
            s = c["sessao"]
            novo = random.random() < NOVOS
            valor = s["ticket"] * (1.0 if novo else 1 + UPLIFT) * random.uniform(0.75, 1.35)
            linhas_venda.append((s["estab"], c["id"], s["id"], round(valor, 2), c["usado"]))
        inserir(cur, "vendas",
                ["estabelecimento_id", "cupom_id", "sessao_id", "valor_brl", "momento"],
                linhas_venda)

        # visitas e última visita saem das próprias sessões
        cur.execute("""
            UPDATE clientes c
               SET visitas = t.n, ultima_visita = t.ultima
              FROM (SELECT cliente_id, count(*) AS n, max(inicio) AS ultima
                      FROM sessoes WHERE cliente_id IS NOT NULL
                     GROUP BY cliente_id) t
             WHERE c.id = t.cliente_id
        """)
        con.commit()

    print(f"acessos:  vitor@pracaderecarga.local / {SENHA_MAIN}   (main)")
    for slug, nome_g, nome_o in EQUIPE.values():
        print(f"          gerente.{slug}@praca.local / {SENHA_DEMO}   ({nome_g})")
        print(f"          operador.{slug}@praca.local / {SENHA_DEMO}  ({nome_o})")
    print(f"lojas: {len(LOJAS)}  carregadores: {len(linhas_carregador)}  "
          f"clientes: {len(linhas_cliente)}  sessões: {len(linhas_sessao)}  "
          f"leituras: {len(linhas_leitura)}  cupons: {len(linhas_cupom)}  "
          f"vendas: {len(linhas_venda)}")


if __name__ == "__main__":
    semear()
