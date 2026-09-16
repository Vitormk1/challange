"""Reserva de carregador.

Como funciona, em uma frase: o motorista escolhe dia e hora, paga R$ 10 da
carteira, e esses R$ 10 voltam para ele como crédito naquela recarga.

O valor existe por um motivo só, e vale escrever: reserva sem custo não segura
ninguém. Quem não paga nada para bloquear uma vaga bloqueia várias, esquece, e
quem chega não encontra. Cobrar e devolver na recarga alinha o interesse — a
pessoa não perde nada se aparecer, e perde se não aparecer.

    reservou   -R$ 10,00 na carteira, vaga bloqueada
    carregou   os R$ 10,00 abatem da conta da recarga
    cancelou   +R$ 10,00 de volta, até 30 min antes do horário
    não foi    fica com a loja, que segurou a vaga à toa

O prazo de 30 minutos não é arbitrário: é tempo suficiente para a vaga ser
oferecida a outra pessoa. Cancelar cinco minutos antes já custou a vaga à
loja, e devolver ali transferiria esse custo para quem não fez nada.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import psycopg
from fastapi import APIRouter, Body, Cookie, Depends, HTTPException, Request

from db import conectar
from protecao import limitar_reserva

# ---------------------------------------------------------------- regras ---

VALOR_RESERVA = Decimal("10.00")
DURACAO_MIN = 60              # cada reserva ocupa uma hora
ANTECEDENCIA_MIN = 15         # não dá para reservar para daqui a dois minutos
JANELA_DIAS = 14              # nem para daqui a três meses
DEVOLVE_ATE_MIN = 30          # cancelou com mais de 30 min? devolve tudo
CHEGADA_ANTES_MIN = 15        # dá para avisar que chegou 15 min antes
ATIVAS_POR_PESSOA = 3         # teto de reservas em aberto ao mesmo tempo


def _agora() -> datetime:
    return datetime.now(timezone.utc)


def serializar(r: dict) -> dict:
    return {k: (str(v) if isinstance(v, Decimal)
                else v.isoformat() if isinstance(v, datetime) else v)
            for k, v in r.items()}


# -------------------------------------------------------------- vencimento ---

def expirar_vencidas(cur) -> int:
    """Fecha as reservas cujo horário passou e ninguém usou.

    Roda de carona nas leituras, e não num agendador, porque não existe
    agendador: o plano gratuito hiberna e não tem cron. Varrer aqui custa um
    UPDATE indexado que quase sempre não encontra nada, e tem a propriedade
    que importa — o estado nunca é lido desatualizado, porque a leitura é
    justamente o que o atualiza.

    O valor NÃO volta para a carteira. É o que compensa a loja por ter
    segurado a vaga para alguém que não apareceu, e é o que faz a reserva
    valer alguma coisa: sem essa consequência, marcar cinco horários e usar um
    sairia de graça.
    """
    cur.execute("UPDATE reservas SET situacao = 'expirada', encerrada_em = now() "
                " WHERE situacao = 'ativa' AND fim < now()")
    return cur.rowcount


# ------------------------------------------------------------------ mapa ---

def pontos_do_mapa(cur, usuario_id: int | None) -> list[dict]:
    """As lojas com coordenada, cada uma com suas vagas.

    `livre_agora` sai das reservas, não de um sorteio: uma vaga está livre
    quando não há reserva ativa cobrindo este instante. Antes o mapa decidia
    isso com `rnd() > 0.32`, o que era honesto enquanto os pontos eram
    ilustração e deixou de ser quando viraram algo que se reserva.
    """
    cur.execute("""
        SELECT e.id, e.nome, e.segmento, e.lat, e.lng,
               c.id AS carregador_id, c.nome AS vaga, c.potencia_kw,
               c.conector, c.preco_kwh_brl, c.cashback_pct,
               EXISTS (SELECT 1 FROM reservas r
                        WHERE r.carregador_id = c.id AND r.situacao = 'ativa'
                          AND now() >= r.inicio AND now() < r.fim) AS ocupada,
               EXISTS (SELECT 1 FROM reservas r
                        WHERE r.carregador_id = c.id AND r.situacao = 'ativa'
                          AND r.usuario_id = %s AND r.fim > now())        AS minha
          FROM estabelecimentos e
          JOIN carregadores c ON c.estabelecimento_id = e.id AND c.ativo
         -- Sem filtrar por so_mapa: o mapa mostra qualquer loja com
         -- coordenada. A coluna separa quem aparece no PAINEL, e uma loja
         -- de verdade que ganhe coordenada deve aparecer nos dois.
         WHERE e.ativo AND e.lat IS NOT NULL AND e.lng IS NOT NULL
         ORDER BY e.id, c.id
    """, (usuario_id or 0,))

    lojas: dict[int, dict] = {}
    for l in cur.fetchall():
        p = lojas.setdefault(l["id"], {
            "id": l["id"], "nome": l["nome"], "segmento": l["segmento"],
            "lat": float(l["lat"]), "lng": float(l["lng"]), "carregadores": [],
        })
        p["carregadores"].append({
            "id": l["carregador_id"], "nome": l["vaga"],
            "potencia_kw": float(l["potencia_kw"]),
            "conector": l["conector"],
            "preco_kwh_brl": float(l["preco_kwh_brl"]),
            "cashback_pct": float(l["cashback_pct"]),
            "livre_agora": not l["ocupada"],
            "tenho_reserva": l["minha"],
        })

    for p in lojas.values():
        vagas = p["carregadores"]
        # O mapa mostra um marcador por loja, e o marcador precisa de um
        # resumo: a loja está livre se QUALQUER vaga dela estiver.
        p["vagas"] = len(vagas)
        p["livre"] = any(v["livre_agora"] for v in vagas)
        p["potencia"] = max(v["potencia_kw"] for v in vagas)
        p["preco"] = min(v["preco_kwh_brl"] for v in vagas)
        p["cashback"] = max(v["cashback_pct"] for v in vagas)
    return list(lojas.values())


# -------------------------------------------------------------- validação ---

def _ler_inicio(texto: str) -> datetime:
    """Interpreta o horário pedido e recusa o que não faz sentido."""
    try:
        inicio = datetime.fromisoformat(texto.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise HTTPException(400, "Não entendi o horário escolhido.")
    if inicio.tzinfo is None:
        # Sem fuso, o navegador mandou horário local. Tratar como UTC daria uma
        # reserva três horas fora do lugar, em silêncio.
        raise HTTPException(400, "O horário precisa vir com o fuso.")

    agora = _agora()
    if inicio < agora + timedelta(minutes=ANTECEDENCIA_MIN):
        raise HTTPException(400,
            f"Escolha um horário pelo menos {ANTECEDENCIA_MIN} minutos à frente.")
    if inicio > agora + timedelta(days=JANELA_DIAS):
        raise HTTPException(400, f"Dá para reservar com até {JANELA_DIAS} dias de antecedência.")
    return inicio


# ------------------------------------------------------------------ rotas ---

def registrar_reservas(app, usuario_atual):
    router = APIRouter()

    def motorista(u=Depends(usuario_atual)):
        if u["papel"] != "motorista":
            raise HTTPException(403, "Reservar vaga é para contas de motorista.")
        return u

    @router.get("/mapa/pontos")
    def mapa(praca_sessao: str | None = Cookie(default=None)):
        """Aberto, como o mapa sempre foi.

        Sem login mostra os pontos e a disponibilidade; quem está logado recebe
        também `tenho_reserva`, para a tela não oferecer reservar de novo o que
        a pessoa já reservou.

        O nome do parâmetro É o nome do cookie — é assim que o FastAPI o
        encontra, e é a mesma convenção do main.py. A primeira versão lia
        `request.cookies.get("sessao")` na mão e nunca achava nada: o cookie
        chama-se `praca_sessao`. Falhava em silêncio, porque não achar sessão é
        o caso normal aqui.
        """
        u = None
        if praca_sessao:
            try:
                u = usuario_atual(praca_sessao)
            except HTTPException:
                pass          # sessão vencida ou inválida: segue como visitante
        with conectar() as con, con.cursor() as cur:
            expirar_vencidas(cur)
            con.commit()
            return {"pontos": pontos_do_mapa(cur, u["id"] if u else None),
                    "valor_reserva_brl": str(VALOR_RESERVA),
                    "duracao_min": DURACAO_MIN}

    @router.get("/reservas")
    def minhas(u=Depends(motorista)):
        with conectar() as con, con.cursor() as cur:
            expirar_vencidas(cur)
            con.commit()
            cur.execute("""
                SELECT r.id, r.inicio, r.fim, r.situacao, r.valor_brl,
                       c.nome AS vaga, c.potencia_kw, e.nome AS loja,
                       e.lat, e.lng
                  FROM reservas r
                  JOIN carregadores c ON c.id = r.carregador_id
                  JOIN estabelecimentos e ON e.id = c.estabelecimento_id
                 WHERE r.usuario_id = %s
                 ORDER BY r.inicio DESC LIMIT 30
            """, (u["id"],))
            agora = _agora()
            linhas = []
            for r in cur.fetchall():
                x = serializar(r)
                # A tela não precisa recalcular a regra: o servidor já diz se
                # o botão "Cheguei" cabe agora. Ter a regra em dois lugares é
                # ter duas versões dela.
                x["pode_chegar"] = (r["situacao"] == "ativa"
                                    and r["inicio"] - timedelta(minutes=CHEGADA_ANTES_MIN) <= agora < r["fim"])
                x["pode_cancelar"] = r["situacao"] == "ativa" and r["inicio"] > agora
                linhas.append(x)
            return {"reservas": linhas,
                    "devolve_ate_min": DEVOLVE_ATE_MIN,
                    "chegada_antes_min": CHEGADA_ANTES_MIN}

    @router.post("/reservas")
    def criar(request: Request, corpo: dict = Body(...), u=Depends(motorista)):
        carregador_id = corpo.get("carregador_id")
        if not isinstance(carregador_id, int):
            raise HTTPException(400, "Escolha uma vaga.")
        inicio = _ler_inicio(str(corpo.get("inicio", "")))
        fim = inicio + timedelta(minutes=DURACAO_MIN)

        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT c.id, c.nome, e.nome AS loja FROM carregadores c "
                        "  JOIN estabelecimentos e ON e.id = c.estabelecimento_id "
                        " WHERE c.id = %s AND c.ativo AND e.ativo", (carregador_id,))
            vaga = cur.fetchone()
            if not vaga:
                raise HTTPException(404, "Essa vaga não existe mais.")

            cur.execute("SELECT count(*) AS n FROM reservas "
                        " WHERE usuario_id = %s AND situacao = 'ativa' AND fim > now()",
                        (u["id"],))
            if cur.fetchone()["n"] >= ATIVAS_POR_PESSOA:
                raise HTTPException(409,
                    f"Você já tem {ATIVAS_POR_PESSOA} reservas em aberto. "
                    "Cancele uma antes de marcar outra.")

            # O saldo é a soma do razão, sempre — não há número guardado que
            # possa discordar do extrato.
            cur.execute("SELECT coalesce(sum(valor_brl),0) AS saldo "
                        "  FROM carteira_lancamentos WHERE usuario_id = %s", (u["id"],))
            saldo = cur.fetchone()["saldo"]
            if saldo < VALOR_RESERVA:
                raise HTTPException(402,
                    f"Saldo insuficiente. A reserva custa R$ {VALOR_RESERVA:.2f} "
                    f"e você tem R$ {saldo:.2f}. Adicione saldo na carteira.")

            # O limite conta aqui, e não na entrada da função: só depois de a
            # reserva ser possível de verdade. Contando antes, horário
            # inválido e vaga ocupada gastariam cota, e quem estivesse
            # procurando um horário livre seria bloqueado por procurar.
            limitar_reserva(request, u["id"])

            # A reserva PRIMEIRO, o débito depois, na mesma transação.
            #
            # A ordem importa: se a vaga já estiver tomada, o EXCLUDE recusa
            # aqui e o dinheiro nunca chega a sair. Debitar antes exigiria
            # devolver na falha — e devolução que depende de o código lembrar
            # é devolução que um dia não acontece.
            try:
                cur.execute(
                    "INSERT INTO reservas (carregador_id, usuario_id, inicio, fim, valor_brl) "
                    "VALUES (%s,%s,%s,%s,%s) RETURNING id",
                    (carregador_id, u["id"], inicio, fim, VALOR_RESERVA))
            except psycopg.errors.ExclusionViolation:
                con.rollback()
                raise HTTPException(409,
                    "Alguém reservou esse horário antes de você. Escolha outro.")
            reserva_id = cur.fetchone()["id"]

            cur.execute(
                "INSERT INTO carteira_lancamentos (usuario_id,tipo,valor_brl,descricao,referencia) "
                "VALUES (%s,'reserva',%s,%s,%s)",
                (u["id"], -VALOR_RESERVA,
                 f"Reserva · {vaga['loja']} · {vaga['nome']}", f"reserva:{reserva_id}"))
            con.commit()

        return {"id": reserva_id, "inicio": inicio.isoformat(), "fim": fim.isoformat(),
                "valor_brl": str(VALOR_RESERVA), "loja": vaga["loja"], "vaga": vaga["nome"]}

    @router.post("/reservas/{reserva_id}/chegar")
    def chegar(reserva_id: int, u=Depends(motorista)):
        """A pessoa chegou na vaga. O depósito vira crédito.

        É aqui que a outra metade da regra acontece: os R$ 10 saíram da
        carteira para a reserva valer alguma coisa, e voltam agora porque ela
        cumpriu o combinado. Quem aparece não paga nada pela reserva; quem não
        aparece paga.

        O crédito volta para a CARTEIRA, e não para um saldo preso naquele
        carregador. Parece menos fiel à ideia de "crédito para usar ali", e é
        mais honesto: a carteira é o que paga a recarga neste projeto, então
        devolver ali é exatamente devolver para gastar na recarga — sem criar
        um segundo tipo de saldo que ninguém mais sabe ler.

        Quem confirma é o motorista, não o carregador, porque ainda não existe
        integração com carregador nenhum. Quando existir, é esta função que o
        equipamento chama, e nada mais muda.
        """
        with conectar() as con, con.cursor() as cur:
            expirar_vencidas(cur)
            cur.execute("SELECT * FROM reservas WHERE id = %s AND usuario_id = %s FOR UPDATE",
                        (reserva_id, u["id"]))
            r = cur.fetchone()
            if not r:
                raise HTTPException(404, "Reserva não encontrada.")
            if r["situacao"] != "ativa":
                rotulo = {"cumprida": "já foi usada", "cancelada": "foi cancelada",
                          "expirada": "passou do horário"}.get(r["situacao"], "já foi encerrada")
                raise HTTPException(409, f"Essa reserva {rotulo}.")

            agora = _agora()
            if agora < r["inicio"] - timedelta(minutes=CHEGADA_ANTES_MIN):
                raise HTTPException(409,
                    f"Ainda é cedo. Dá para avisar que chegou a partir de "
                    f"{CHEGADA_ANTES_MIN} minutos antes do horário.")

            cur.execute("UPDATE reservas SET situacao='cumprida', encerrada_em=now() "
                        " WHERE id = %s", (reserva_id,))
            cur.execute(
                "INSERT INTO carteira_lancamentos "
                "  (usuario_id,tipo,valor_brl,descricao,referencia) "
                "VALUES (%s,'estorno_reserva',%s,%s,%s) "
                "ON CONFLICT (referencia) DO NOTHING",
                (u["id"], r["valor_brl"], "Reserva usada · crédito devolvido para a recarga",
                 f"reserva-credito:{reserva_id}"))
            con.commit()

        return {"ok": True, "valor_brl": str(r["valor_brl"]),
                "mensagem": f"Boa recarga. Os R$ {r['valor_brl']:.2f} da reserva "
                            "voltaram para a carteira e valem nesta recarga."}

    @router.post("/reservas/{reserva_id}/cancelar")
    def cancelar(reserva_id: int, u=Depends(motorista)):
        with conectar() as con, con.cursor() as cur:
            expirar_vencidas(cur)
            # FOR UPDATE: dois cliques no botão não podem render duas
            # devoluções. O segundo espera o primeiro e encontra a reserva já
            # cancelada.
            cur.execute("SELECT * FROM reservas WHERE id = %s AND usuario_id = %s FOR UPDATE",
                        (reserva_id, u["id"]))
            r = cur.fetchone()
            if not r:
                raise HTTPException(404, "Reserva não encontrada.")
            if r["situacao"] != "ativa":
                raise HTTPException(409, "Essa reserva já foi encerrada.")

            devolve = r["inicio"] - _agora() > timedelta(minutes=DEVOLVE_ATE_MIN)
            cur.execute("UPDATE reservas SET situacao='cancelada', encerrada_em=now() "
                        " WHERE id = %s", (reserva_id,))
            if devolve:
                cur.execute(
                    "INSERT INTO carteira_lancamentos "
                    "  (usuario_id,tipo,valor_brl,descricao,referencia) "
                    "VALUES (%s,'estorno_reserva',%s,%s,%s) "
                    "ON CONFLICT (referencia) DO NOTHING",
                    (u["id"], r["valor_brl"], "Reserva cancelada · valor devolvido",
                     f"reserva-estorno:{reserva_id}"))
            con.commit()

        return {"ok": True, "devolvido": devolve,
                "valor_brl": str(r["valor_brl"]) if devolve else "0.00",
                "aviso": None if devolve else
                    f"Cancelamento com menos de {DEVOLVE_ATE_MIN} min não devolve o valor: "
                    "a vaga já ficou bloqueada para outras pessoas."}

    app.include_router(router)
