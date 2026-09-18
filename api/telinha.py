"""A telinha da vaga, agora com servidor por tras -- e sem perder o offline.

A telinha nasceu simulando tudo no navegador, com os parametros na URL. Isso
deu a ela uma propriedade que vale manter e que nenhuma outra tela do sistema
tem: funciona com a internet da loja fora do ar, que e exatamente quando uma
tela ao lado do carregador mais importa. Tela apagada ao lado da vaga e pior
que nenhuma tela.

O que faltava era o outro lado. Quando HA rede:

    a sessao existe de verdade      entra no historico da loja, no painel e na
                                    fidelidade do motorista
    o QR aparece                    o motorista acompanha do celular, sem
                                    instalar aplicativo e sem fazer login
    o leilao acontece               quando falta potencia, a telinha pergunta
                                    antes de comecar

Sem rede, nada disso aparece e a recarga corre como antes. A degradacao e por
funcionalidade, nao por tela quebrada.

NENHUMA ROTA DAQUI EXIGE LOGIN, e isso e deliberado: quem chama e o carregador,
que nao tem conta. O que protege e outra coisa -- limite por IP e por vaga
(ver protecao.limitar_telinha), e um token aleatorio para acompanhar a sessao.
Token e nao id sequencial: id na URL deixaria qualquer um varrer as sessoes dos
outros trocando o numero.
"""

from __future__ import annotations

import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from db import conectar
from potencia import carga_agora_kw, local_da_loja
from protecao import limitar_telinha

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ai.demanda import (  # noqa: E402
    fator_cashback, folga_kw, ha_disputa, ofertas_de_leilao,
)

BRASIL = timezone(timedelta(hours=-3))

# Energia usada para estimar o custo em tempo de cada oferta. E um numero de
# referencia, nao a bateria do carro: a oferta aparece ANTES de plugar, quando
# ninguem sabe quanto falta. 20 kWh e a recarga tipica de quem para no mercado.
ENERGIA_REFERENCIA_KWH = 20.0

# Uma sessao sem leitura por mais que isto e uma sessao que o carregador
# abandonou -- queda de energia, telinha reiniciada, carro desplugado na
# tomada. Ela nao pode segurar a vaga para sempre.
SESSAO_ORFA_MIN = 30


def _agora() -> datetime:
    return datetime.now(BRASIL)


def novo_token() -> str:
    """Segredo curto do QR. Curto porque vai num codigo que a camera precisa
    ler de longe, e cada caractere a mais aumenta a densidade do desenho."""
    return secrets.token_urlsafe(9)


def _vaga(cur, carregador_id: int) -> dict:
    # `e.*` vem PRIMEIRO e os apelidos depois, de proposito: numa linha de
    # dicionario a ultima coluna com o mesmo nome vence, e tanto carregadores
    # quanto estabelecimentos tem `id` e `nome`. Com a ordem invertida, `id`
    # virava o do carregador e `local_da_loja` recebia a loja errada -- silencio
    # total, resultado errado. Os dois ids ficam explicitos para ninguem ter de
    # lembrar dessa regra ao ler o codigo.
    cur.execute(
        "SELECT e.*, e.id AS estabelecimento_id,"
        "       c.id AS carregador_id, c.nome AS vaga, c.potencia_kw,"
        "       c.preco_kwh_brl, c.cashback_pct, c.carencia_min, c.taxa_ociosidade_min"
        "  FROM carregadores c JOIN estabelecimentos e ON e.id = c.estabelecimento_id"
        " WHERE c.id = %s AND c.ativo AND e.ativo", (carregador_id,))
    linha = cur.fetchone()
    if not linha:
        raise HTTPException(404, "vaga não encontrada")
    return linha


def _opcoes_da_loja(linha: dict) -> list[tuple[float, float]]:
    pares = []
    for pct, fator in ((linha.get("leilao_op1_potencia_pct"), linha.get("leilao_op1_fator")),
                       (linha.get("leilao_op2_potencia_pct"), linha.get("leilao_op2_fator"))):
        if pct and fator:
            pares.append((float(pct), float(fator)))
    return pares


def _sessao_por_token(cur, token: str) -> dict:
    cur.execute(
        "SELECT s.*, c.nome AS vaga, c.potencia_kw, c.preco_kwh_brl, c.cashback_pct,"
        "       e.nome AS loja, e.id AS estabelecimento_id"
        "  FROM sessoes s JOIN carregadores c ON c.id = s.carregador_id"
        "  JOIN estabelecimentos e ON e.id = c.estabelecimento_id"
        " WHERE s.token = %s", (token,))
    s = cur.fetchone()
    if not s:
        raise HTTPException(404, "sessão não encontrada")
    return s


def registrar_telinha(app):
    router = APIRouter()

    # ---------------------------------------------------------------- boot --
    @router.get("/vagas/{carregador_id}/telinha")
    def abrir_telinha(carregador_id: int):
        """Tudo que a telinha precisa para desenhar a primeira tela.

        Uma chamada so, e nao tres: a telinha roda numa tela presa na parede,
        muitas vezes num tablet velho em wi-fi de loja. Cada ida a mais e uma
        chance a mais de a tela nascer pela metade.
        """
        agora = _agora()
        with conectar() as con, con.cursor() as cur:
            v = _vaga(cur, carregador_id)
            local = local_da_loja(v)
            carregando = carga_agora_kw(cur, v["id"])
            f = folga_kw(local, agora, carregando)
            fator = fator_cashback(local, agora, carregando)

            nominal = float(v["potencia_kw"])
            # Quem mais esta pedindo potencia nesta loja agora. Sem os outros
            # pedidos nao da para saber se ha disputa -- e sem disputa o leilao
            # nao deve aparecer.
            cur.execute(
                "SELECT count(*) AS n FROM sessoes s"
                "  JOIN carregadores c ON c.id = s.carregador_id"
                " WHERE c.estabelecimento_id = %s AND s.situacao = 'ativa'",
                (v["estabelecimento_id"],))
            ativas = int(cur.fetchone()["n"])

            # Sessao ja aberta nesta vaga: a telinha reiniciou no meio da
            # recarga e precisa voltar para onde estava, nao comecar de novo.
            cur.execute(
                "SELECT token FROM sessoes WHERE carregador_id = %s AND situacao = 'ativa'"
                " ORDER BY inicio DESC LIMIT 1", (carregador_id,))
            aberta = cur.fetchone()

        pedidos = [nominal] * max(1, ativas + 1)
        disputa = bool(v["leilao_ativo"]) and ha_disputa(pedidos, f.disponivel_kw)
        opcoes = _opcoes_da_loja(v) if disputa else []
        teto = float(v["leilao_teto_fator"] or 2.0)

        ofertas = ofertas_de_leilao(nominal, f.disponivel_kw, fator, opcoes,
                                    teto_fator=teto,
                                    energia_kwh=ENERGIA_REFERENCIA_KWH) if disputa else []

        return {
            "vaga": v["vaga"],
            "loja": v["nome"],
            "potencia_nominal_kw": round(nominal, 2),
            "potencia_liberada_kw": round(max(0.0, min(nominal, f.disponivel_kw)), 2),
            "limitada_pela_rede": min(nominal, f.disponivel_kw) < nominal - 1e-9,
            "preco_kwh_brl": float(v["preco_kwh_brl"]),
            "cashback_pct": float(v["cashback_pct"]),
            "cashback_fator": fator,
            "em_ponta": f.em_ponta,
            "carencia_min": int(v["carencia_min"] or 15),
            "taxa_ociosidade_min": float(v["taxa_ociosidade_min"] or 0),
            "sessoes_ativas_na_loja": ativas,
            "leilao": {
                "ativo": disputa,
                "ofertas": [o.__dict__ for o in ofertas],
            },
            "sessao_aberta": aberta["token"] if aberta else None,
        }

    # ------------------------------------------------------------- abrir ----
    @router.post("/vagas/{carregador_id}/sessao")
    def abrir_sessao(carregador_id: int, corpo: dict, request: Request):
        """O carro plugou. Abre a sessao e devolve o token do QR."""
        limitar_telinha(request, carregador_id)
        agora = _agora()

        soc = corpo.get("soc_inicial")
        soc = max(0.0, min(1.0, float(soc))) if soc is not None else None
        pct = corpo.get("leilao_potencia_pct")
        fator_escolhido = corpo.get("leilao_fator")

        with conectar() as con, con.cursor() as cur:
            v = _vaga(cur, carregador_id)

            # Sessao orfa: o carregador parou de reportar e ninguem fechou.
            # Fecha antes de abrir outra, senao a vaga fica presa para sempre.
            cur.execute(
                "UPDATE sessoes SET situacao = 'interrompida', fim = now()"
                " WHERE carregador_id = %s AND situacao = 'ativa'"
                "   AND inicio < now() - make_interval(mins => %s)",
                (carregador_id, SESSAO_ORFA_MIN))

            cur.execute(
                "SELECT token FROM sessoes WHERE carregador_id = %s AND situacao = 'ativa'"
                " ORDER BY inicio DESC LIMIT 1", (carregador_id,))
            ja = cur.fetchone()
            if ja:
                return {"token": ja["token"], "reaproveitada": True}

            # O fator so vale se TRES coisas forem verdade ao mesmo tempo: a
            # loja oferece aquela opcao, o leilao esta ligado, e ha disputa
            # agora.
            #
            # A terceira e a que faltava e nao e detalhe. Sem ela, bastaria
            # mandar `leilao_potencia_pct: 30` numa loja vazia para levar o
            # dobro de cashback sem abrir mao de nada -- a loja pagaria o
            # premio por uma escassez que nao existe. O premio compra potencia
            # de volta; sem ninguem na fila, nao ha o que comprar.
            #
            # E a conferencia da opcao existe porque a telinha e codigo que
            # roda na loja: sem isso, `leilao_fator: 99` no corpo faria a
            # recarga render cem vezes mais.
            cur.execute(
                "SELECT count(*) AS n FROM sessoes s"
                "  JOIN carregadores c ON c.id = s.carregador_id"
                " WHERE c.estabelecimento_id = %s AND s.situacao = 'ativa'",
                (v["estabelecimento_id"],))
            ativas = int(cur.fetchone()["n"])
            local_agora = local_da_loja(v)
            folga_agora = folga_kw(local_agora, agora, carga_agora_kw(cur, v["estabelecimento_id"]))
            nominal = float(v["potencia_kw"])
            disputa = ha_disputa([nominal] * (ativas + 1), folga_agora.disponivel_kw)

            validos = {p for p, _ in _opcoes_da_loja(v)}
            teto = float(v["leilao_teto_fator"] or 2.0)
            if pct is not None and float(pct) in validos and v["leilao_ativo"] and disputa:
                pct = float(pct)
                par = dict(_opcoes_da_loja(v))[pct]
                fator = min(fator_cashback(local_agora, agora) * par, teto)
            else:
                pct, fator = None, None

            token = novo_token()
            cur.execute(
                "INSERT INTO sessoes (carregador_id, inicio, energia_kwh, soc_inicial,"
                "                     custo_energia_brl, valor_cobrado_brl, minutos_ocioso,"
                "                     situacao, cashback_brl, token,"
                "                     leilao_potencia_pct, leilao_fator)"
                " VALUES (%s, now(), 0, %s, 0, 0, 0, 'ativa', 0, %s, %s, %s)"
                " RETURNING id", (carregador_id, soc, token, pct, fator))
            sid = cur.fetchone()["id"]
            con.commit()

        return {"id": sid, "token": token, "reaproveitada": False,
                "leilao_potencia_pct": pct, "leilao_fator": fator}

    # ------------------------------------------------------------ leitura ---
    @router.post("/sessoes/{token}/leitura")
    def leitura(token: str, corpo: dict):
        """A telinha reporta onde a recarga esta. E o que alimenta o celular.

        Grava em `leituras`, que e a mesma tabela que o grafico de demanda le.
        Uma sessao de verdade passa a aparecer na curva do dia da loja sem
        precisar de nenhum caminho novo.
        """
        soc = corpo.get("soc")
        kw = corpo.get("potencia_kw")
        kwh = corpo.get("energia_kwh")
        with conectar() as con, con.cursor() as cur:
            s = _sessao_por_token(cur, token)
            if s["situacao"] != "ativa":
                raise HTTPException(409, "esta sessão já foi encerrada")

            if kw is not None:
                cur.execute(
                    "INSERT INTO leituras (carregador_id, sessao_id, momento, potencia_kw, soc)"
                    " VALUES (%s, %s, now(), %s, %s)",
                    (s["carregador_id"], s["id"], max(0.0, float(kw)),
                     None if soc is None else max(0.0, min(1.0, float(soc)))))

            if kwh is not None:
                preco = float(s["preco_kwh_brl"])
                pct = float(s["cashback_pct"])
                fator = float(s["leilao_fator"]) if s["leilao_fator"] else 1.0
                energia = max(0.0, float(kwh))
                cur.execute(
                    "UPDATE sessoes SET energia_kwh = %s, soc_final = %s,"
                    "       valor_cobrado_brl = %s, cashback_brl = %s,"
                    "       minutos_ocioso = %s"
                    " WHERE id = %s",
                    (energia, None if soc is None else max(0.0, min(1.0, float(soc))),
                     round(energia * preco, 2),
                     round(energia * preco * pct / 100.0 * fator, 2),
                     int(corpo.get("minutos_ocioso") or 0), s["id"]))
            con.commit()
        return {"ok": True}

    @router.post("/sessoes/{token}/encerrar")
    def encerrar(token: str):
        with conectar() as con, con.cursor() as cur:
            s = _sessao_por_token(cur, token)
            cur.execute("UPDATE sessoes SET situacao = 'concluida', fim = now()"
                        " WHERE id = %s AND situacao = 'ativa'", (s["id"],))
            con.commit()
        return {"ok": True}

    # ----------------------------------------------- acompanhar no celular --
    @router.get("/s/{token}")
    def acompanhar(token: str):
        """O que o celular do motorista mostra. Sem login, so com o token.

        Devolve o minimo: nada de identificar quem e, nada de saldo, nada da
        loja alem do nome. Quem tem o token esteve fisicamente ao lado daquela
        vaga -- e so isso deve comprar.
        """
        with conectar() as con, con.cursor() as cur:
            s = _sessao_por_token(cur, token)
            cur.execute(
                "SELECT potencia_kw, soc, momento FROM leituras"
                " WHERE sessao_id = %s ORDER BY momento DESC LIMIT 1", (s["id"],))
            ultima = cur.fetchone()

        energia = float(s["energia_kwh"] or 0)
        return {
            "loja": s["loja"],
            "vaga": s["vaga"],
            "situacao": s["situacao"],
            "inicio": s["inicio"].isoformat() if s["inicio"] else None,
            "fim": s["fim"].isoformat() if s["fim"] else None,
            "energia_kwh": round(energia, 3),
            "soc": float(ultima["soc"]) if ultima and ultima["soc"] is not None else None,
            "potencia_kw": float(ultima["potencia_kw"]) if ultima else None,
            "preco_kwh_brl": float(s["preco_kwh_brl"]),
            "valor_brl": float(s["valor_cobrado_brl"] or 0),
            "cashback_brl": float(s["cashback_brl"] or 0),
            "cashback_pct": float(s["cashback_pct"]),
            "leilao_fator": float(s["leilao_fator"]) if s["leilao_fator"] else None,
            "leilao_potencia_pct": (float(s["leilao_potencia_pct"])
                                    if s["leilao_potencia_pct"] else None),
            "minutos_ocioso": int(s["minutos_ocioso"] or 0),
        }

    @router.get("/s/{token}/qr.svg")
    def qr(token: str):
        """O desenho do QR, em SVG.

        Gerado no servidor e nao no navegador porque a politica de seguranca do
        site proibe script de fora (`script-src 'self'`) -- trazer uma
        biblioteca de QR por CDN custaria abrir essa porta para um terceiro na
        mesma origem do cookie de sessao. SVG e nao PNG porque escala sem
        borrar: a telinha as vezes e um monitor grande na parede.
        """
        from fastapi.responses import Response
        alvo = f"https://smartcharge.ia.br/painel/sessao.html?t={token}"
        try:
            import segno
            import io as _io
            desenho = segno.make(alvo, error="m")
            # `save(kind="svg")` e NAO `svg_inline`. O svg_inline omite o
            # xmlns de proposito, porque foi feito para ser colado dentro do
            # HTML, onde o namespace ja esta implicito. Servido como arquivo e
            # carregado por <img>, um SVG sem xmlns nao e reconhecido: o
            # navegador recebe 200, nao parseia, e a imagem fica com largura
            # natural zero -- some da tela sem erro nenhum no console.
            buf = _io.BytesIO()
            desenho.save(buf, kind="svg", scale=8, border=2,
                         dark="#0D0D0F", light="#FFFFFF")
            svg = buf.getvalue().decode("utf-8")
        except Exception:
            # Sem a biblioteca a telinha nao fica sem saida: mostra o endereco
            # em texto, que funciona digitado. Pior, e nao quebrado.
            svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60">'
                   f'<text x="4" y="24" font-size="11" font-family="monospace">'
                   f'smartcharge.ia.br</text>'
                   f'<text x="4" y="44" font-size="13" font-family="monospace">'
                   f'/s/{token}</text></svg>')
        return Response(svg, media_type="image/svg+xml",
                        headers={"Cache-Control": "public, max-age=3600"})

    app.include_router(router)
