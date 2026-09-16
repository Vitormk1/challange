"""Carteira Pix: dinheiro confirmado no servidor, lançamentos idempotentes.

As chamadas externas são serializadas por carteira/pagamento no PostgreSQL.
Não há débito por recarga enquanto não existir integração com o equipamento.
"""
from __future__ import annotations

import hmac
import os
import re
import secrets
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation

import requests
from fastapi import APIRouter, Body, Depends, HTTPException, Request

from db import conectar
from protecao import limitar_carteira

SANDBOX = "https://api-sandbox.asaas.com/v3"
PRODUCAO = "https://api.asaas.com/v3"
BRASIL = timezone(timedelta(hours=-3))
PAGOS = {"CONFIRMED", "RECEIVED"}

# As tres formas que a carteira aceita, e o nome que cada uma tem na Asaas.
#
# CARTAO NAO PASSA POR AQUI. A cobranca e criada por nos, mas o numero do
# cartao e digitado no checkout hospedado da Asaas (o invoiceUrl que toda
# cobranca devolve). Nenhum dado de cartao entra neste servidor -- o que
# mantem o projeto inteiro fora do escopo do PCI-DSS. Receber o numero aqui
# para repassar seria menos codigo numa tela e muito mais responsabilidade em
# tudo: log, memoria, backup, e a hospedagem no meio.
FORMAS = {"pix": "PIX", "boleto": "BOLETO", "cartao": "CREDIT_CARD"}
LANCAMENTO = {"pix": "recarga_pix", "boleto": "recarga_boleto", "cartao": "recarga_cartao"}
COMO_ENTROU = {"pix": "via Pix", "boleto": "via boleto", "cartao": "via cartao"}
EVENTOS = {"PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE",
           "PAYMENT_DELETED", "PAYMENT_REFUNDED", "PAYMENT_PARTIALLY_REFUNDED",
           "PAYMENT_UPDATED", "PAYMENT_RESTORED",
           # Contestacao existe so no cartao: Pix e boleto nao voltam atras.
           # Sem estes tres eventos o webhook respondia "ignorado" e a pessoa
           # ficava com o saldo enquanto o dinheiro era retirado da conta --
           # um jeito silencioso de sacar dinheiro da empresa.
           "PAYMENT_CHARGEBACK_REQUESTED", "PAYMENT_CHARGEBACK_DISPUTE",
           "PAYMENT_AWAITING_CHARGEBACK_REVERSAL"}

# Status em que a Asaas ja retirou o valor do nosso saldo. O tratamento e o
# mesmo de um estorno: a maquinaria de devolucao ja existia, so nao era
# alcancada por estes status porque antes nao havia cartao.
CONTESTADOS = {"CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE",
               "AWAITING_CHARGEBACK_REVERSAL"}


def configuracao():
    chave = os.environ.get("ASAAS_API_KEY", "").strip()
    if not chave:
        raise HTTPException(503, "O Pix está temporariamente indisponível.")
    base = os.environ.get("ASAAS_API_BASE", "").strip().rstrip("/")
    base = base or (PRODUCAO if chave.startswith("$aact_prod_") else SANDBOX)
    if base not in {SANDBOX, PRODUCAO}:
        raise HTTPException(503, "O ambiente de pagamentos precisa ser revisado.")
    if ((chave.startswith("$aact_prod_") and base != PRODUCAO)
            or (chave.startswith("$aact_hmlg_") and base != SANDBOX)):
        raise HTTPException(503, "A chave de pagamentos não corresponde ao ambiente configurado.")
    return base, chave


def estado_configuracao():
    """Sonda operacional sem expor chave, token ou informações da conta."""
    chave = bool(os.environ.get("ASAAS_API_KEY", "").strip())
    webhook = bool(os.environ.get("ASAAS_WEBHOOK_TOKEN", "").strip())
    pendencias = []
    if not chave:
        pendencias.append("ASAAS_API_KEY")
    if not webhook:
        pendencias.append("ASAAS_WEBHOOK_TOKEN")
    try:
        base, _ = configuracao()
    except HTTPException:
        base = None
        if chave:
            pendencias.append("ASAAS_API_BASE")
    return {"pix_configurado": base is not None and not pendencias,
            "api_key_configurada": chave, "webhook_configurado": webhook,
            "ambiente": "indisponivel" if base is None else
                        "sandbox" if base == SANDBOX else "producao",
            "pendencias": pendencias}


def asaas(metodo, caminho, corpo=None):
    base, chave = configuracao()
    try:
        r = requests.request(metodo, base + caminho, json=corpo, timeout=20,
            headers={"access_token": chave, "Content-Type": "application/json",
                     "User-Agent": "SmartCharge/2.0"}, allow_redirects=False)
    except requests.RequestException:
        raise HTTPException(502, "Não conseguimos falar com a Asaas. Tente novamente em instantes.")
    if not r.ok:
        # Respostas externas podem conter documento ou detalhes da conta.
        mensagem = ("A Asaas não autorizou a integração. Revise a chave e o ambiente no servidor."
                    if r.status_code in (401, 403) else
                    "A Asaas não concluiu a solicitação. Confira os dados e tente novamente.")
        raise HTTPException(502, mensagem)
    try:
        dados = r.json()
        if not isinstance(dados, dict):
            raise ValueError()
        return dados
    except ValueError:
        raise HTTPException(502, "O serviço de pagamentos retornou uma resposta inválida.")


def dinheiro(bruto):
    try:
        valor = Decimal(str(bruto))
        if not valor.is_finite() or valor != valor.quantize(Decimal("0.01")):
            raise InvalidOperation()
        return valor.quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(422, "Informe um valor válido com até duas casas decimais.")


def valor_pix(bruto):
    valor = dinheiro(bruto)
    if not Decimal("5") <= valor <= Decimal("1000"):
        raise HTTPException(422, "Escolha um valor entre R$ 5,00 e R$ 1.000,00.")
    return valor


def documento_valido(bruto):
    doc = re.sub(r"\D", "", str(bruto or ""))
    if len(doc) not in (11, 14) or len(set(doc)) == 1:
        raise HTTPException(422, "Informe um CPF ou CNPJ válido.")
    pesos = ([list(range(10, 1, -1)), list(range(11, 1, -1))] if len(doc) == 11
             else [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
                   [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]])
    inicio = len(doc) - 2
    for i, peso in enumerate(pesos):
        resto = sum(int(n) * p for n, p in zip(doc[:inicio + i], peso)) % 11
        if int(doc[inicio + i]) != (0 if resto < 2 else 11 - resto):
            raise HTTPException(422, "Informe um CPF ou CNPJ válido.")
    return doc


def serializar(linha):
    return {k: (v.isoformat() if isinstance(v, datetime)
                else str(v) if isinstance(v, Decimal) else v)
            for k, v in linha.items()}


def pix_publico(linha):
    d = serializar(linha)
    return {"id": d["asaas_pagamento_id"], "valor_brl": d["valor_brl"],
            "status": d["status"], "recebido_em": d.get("recebido_em"),
            "forma": d.get("forma") or "pix",
            # Pix: QR e copia-e-cola. Boleto: linha digitavel e PDF. Cartao:
            # o checkout da Asaas. Quem nao usa o campo recebe nulo, e a tela
            # decide o que mostrar pela `forma`.
            "copia_e_cola": d.get("payload_pix"),
            "imagem_base64": d.get("imagem_base64"),
            "linha_digitavel": d.get("linha_digitavel"),
            "url_boleto": d.get("url_boleto"),
            "url_pagamento": d.get("url_pagamento"),
            "expira_em": d.get("expiracao_em"),
            "criado_em": d.get("criado_em")}


def gravar_qr(cur, pix):
    # Boleto e cartao nao tem QR de Pix. Pedir um a Asaas devolveria erro, e o
    # erro viraria 502 numa tela que so queria mostrar a linha digitavel.
    if (pix.get("forma") or "pix") != "pix":
        return pix
    if pix["status"] not in {"PENDING", "OVERDUE"}:
        return pix
    qr = asaas("GET", f"/payments/{pix['asaas_pagamento_id']}/pixQrCode")
    if not qr.get("payload") or not qr.get("expirationDate"):
        raise HTTPException(502, "O Pix ainda não está disponível. Tente recuperar o código em instantes.")
    try:
        expiracao = datetime.fromisoformat(qr["expirationDate"])
        if expiracao.tzinfo is None:
            expiracao = expiracao.replace(tzinfo=BRASIL)
    except (TypeError, ValueError):
        raise HTTPException(502, "A validade do Pix não foi informada corretamente pela Asaas.")
    cur.execute("UPDATE carteira_pix SET payload_pix=%s, imagem_base64=%s, expiracao_em=%s "
                "WHERE id=%s RETURNING *", (qr["payload"], qr.get("encodedImage"),
                                           expiracao, pix["id"]))
    return cur.fetchone()


def gravar_boleto(cur, pix):
    """Busca a linha digitavel do boleto e guarda.

    Separado da criacao pelo mesmo motivo que o QR do Pix: se esta chamada
    falhar, a cobranca ja esta gravada e a pessoa recupera depois. Perder a
    linha digitavel e chato; perder a cobranca e dinheiro.
    """
    if (pix.get("forma") or "pix") != "boleto" or pix["linha_digitavel"]:
        return pix
    if pix["status"] not in {"PENDING", "OVERDUE"}:
        return pix
    dados = asaas("GET", f"/payments/{pix['asaas_pagamento_id']}/identificationField")
    linha = dados.get("identificationField")
    if not linha:
        return pix
    cur.execute("UPDATE carteira_pix SET linha_digitavel=%s WHERE id=%s RETURNING *",
                (linha, pix["id"]))
    return cur.fetchone()


def aplicar_pagamento(cur, pix, pagamento):
    """Aplica um retrato consultado na Asaas, com a linha do Pix bloqueada."""
    # O billingType conferido e o da FORMA daquela linha, e nao "PIX" fixo: a
    # mesma tabela guarda boleto e cartao desde que a carteira deixou de ser so
    # Pix. Conferir continua importando -- e a garantia de que o retrato veio
    # da cobranca certa, e nao de outra com o mesmo id em outro ambiente.
    esperado = FORMAS.get(pix.get("forma") or "pix", "PIX")
    if (pagamento.get("id") != pix["asaas_pagamento_id"]
            or pagamento.get("billingType") != esperado
            or dinheiro(pagamento.get("value")) != pix["valor_brl"]):
        raise HTTPException(409, "A cobrança precisa ser conferida antes de atualizar o saldo.")
    status = "DELETED" if pagamento.get("deleted") else pagamento.get("status", pix["status"])
    refunds = pagamento.get("refunds") or []
    devolvido = sum((dinheiro(r.get("value")) for r in refunds
                    if r.get("status") == "DONE"), Decimal("0"))
    if status == "REFUNDED" or status in CONTESTADOS:
        devolvido = pix["valor_brl"]
    if devolvido < 0 or devolvido > pix["valor_brl"]:
        raise HTTPException(409, "O estorno precisa ser conferido antes de atualizar o saldo.")
    # Um estorno pode chegar antes da notificação de recebimento: o retrato
    # atual comprova tanto o crédito original quanto a devolução.
    if status in PAGOS or devolvido:
        forma = pix.get("forma") or "pix"
        cur.execute("INSERT INTO carteira_lancamentos "
                    "(usuario_id,tipo,valor_brl,descricao,referencia) "
                    f"VALUES (%s,'{LANCAMENTO[forma]}',%s,"
                    f"'Saldo adicionado {COMO_ENTROU[forma]}',%s) "
                    "ON CONFLICT (referencia) DO NOTHING", (pix["usuario_id"],
                    pix["valor_brl"], f"asaas:{pix['asaas_pagamento_id']}"))
        cur.execute("UPDATE carteira_pix SET recebido_em=coalesce(recebido_em,now()) WHERE id=%s", (pix["id"],))
    cur.execute("SELECT coalesce(-sum(valor_brl),0) AS total FROM carteira_lancamentos "
                "WHERE usuario_id=%s AND tipo='estorno' AND referencia LIKE %s",
                (pix["usuario_id"], f"asaas-estorno:{pix['asaas_pagamento_id']}:%"))
    anterior = cur.fetchone()["total"]
    # A palavra importa no extrato: "contestacao" diz a quem le que houve uma
    # disputa no cartao, e nao uma devolucao que a propria pessoa pediu.
    motivo = ("Contestacao no cartao" if status in CONTESTADOS
              else f"Valor devolvido pela Asaas ({COMO_ENTROU[pix.get('forma') or 'pix']})")
    if devolvido > anterior:
        cur.execute("INSERT INTO carteira_lancamentos "
                    "(usuario_id,tipo,valor_brl,descricao,referencia) "
                    "VALUES (%s,'estorno',%s,%s,%s) "
                    "ON CONFLICT (referencia) DO NOTHING", (pix["usuario_id"],
                    -(devolvido - anterior), motivo,
                    f"asaas-estorno:{pix['asaas_pagamento_id']}:{devolvido}"))
    cur.execute("UPDATE carteira_pix SET status=%s, verificado_em=now() WHERE id=%s RETURNING *",
                (status, pix["id"]))
    return cur.fetchone()


def registrar_carteira(app, usuario_atual):
    router = APIRouter()

    def motorista(u=Depends(usuario_atual)):
        if u["papel"] != "motorista":
            raise HTTPException(403, "A carteira é exclusiva para contas de motorista.")
        return u

    @router.get("/carteira")
    def carteira(u=Depends(motorista)):
        with conectar() as con, con.cursor() as cur:
            cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            # Um único retrato para saldo e extrato não discordarem entre si.
            cur.execute("SELECT coalesce(sum(valor_brl),0) AS saldo FROM carteira_lancamentos WHERE usuario_id=%s", (u["id"],))
            saldo = cur.fetchone()["saldo"]
            cur.execute("SELECT id,tipo,valor_brl,descricao,criado_em FROM carteira_lancamentos "
                        "WHERE usuario_id=%s ORDER BY criado_em DESC,id DESC LIMIT 50", (u["id"],))
            lancamentos = [serializar(x) for x in cur.fetchall()]
            cur.execute("SELECT e.id AS estabelecimento_id,e.nome AS loja, "
                        "sum(cp.desconto_brl) AS saldo_brl,count(*) AS cupons "
                        "FROM cupons cp JOIN sessoes s ON s.id=cp.sessao_id "
                        "JOIN clientes cl ON cl.id=s.cliente_id "
                        "JOIN carregadores c ON c.id=s.carregador_id "
                        "JOIN estabelecimentos e ON e.id=c.estabelecimento_id "
                        "WHERE cl.usuario_id=%s AND cp.usado_em IS NULL "
                        "AND (cp.expira_em IS NULL OR cp.expira_em>now()) AND cp.desconto_brl>0 "
                        "GROUP BY e.id,e.nome ORDER BY e.nome", (u["id"],))
            cashback = [serializar(x) for x in cur.fetchall()]
            cur.execute("SELECT * FROM carteira_pix WHERE usuario_id=%s "
                        "ORDER BY criado_em DESC,id DESC LIMIT 12", (u["id"],))
            cobrancas = [pix_publico(x) for x in cur.fetchall()]
            cur.execute("SELECT asaas_cliente_id,asaas_base FROM carteiras WHERE usuario_id=%s", (u["id"],))
            cadastro = cur.fetchone()
        config = estado_configuracao()
        return {"saldo_brl": str(saldo), "lancamentos": lancamentos,
                "cashback_lojas": cashback,
                "cobrancas": cobrancas, "pix_disponivel": config["pix_configurado"],
                "documento_necessario": not bool(cadastro and cadastro["asaas_cliente_id"]),
                "ambiente": config["ambiente"],
                "modo_demo": config["pix_configurado"] and config["ambiente"] == "sandbox"
                             and os.environ.get("WALLET_DEMO_MODE") == "1"}

    @router.post("/carteira/pix")
    def criar_pix(corpo: dict = Body(...), u=Depends(motorista)):
        # `forma` chega do corpo; sem ela, Pix, que era o unico jeito antes e
        # continua sendo o caminho de quem ja tinha a tela aberta.
        forma = str(corpo.get("forma") or "pix").lower()
        if forma not in FORMAS:
            raise HTTPException(422, "Escolha Pix, boleto ou cartao.")
        valor = valor_pix(corpo.get("valor"))
        limitar_carteira(u["id"], "criar")
        base, _ = configuracao()
        if not os.environ.get("ASAAS_WEBHOOK_TOKEN", "").strip():
            raise HTTPException(503, "O Pix está aguardando a configuração de confirmação de pagamentos.")
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s,%s)", (73421, u["id"]))
            # Pendente DA MESMA FORMA: um boleto em aberto nao pode impedir de
            # gerar um Pix para pagar agora, que e justamente o caso de quem
            # desistiu de esperar a compensacao.
            cur.execute("SELECT * FROM carteira_pix WHERE usuario_id=%s AND valor_brl=%s AND status='PENDING' "
                        "AND forma=%s AND (expiracao_em>now() OR expiracao_em IS NULL) "
                        "ORDER BY id DESC LIMIT 1", (u["id"], valor, forma))
            pendente = cur.fetchone()
            if pendente:
                if dinheiro(pendente["valor_brl"]) != valor:
                    raise HTTPException(409, "Você já tem um Pix pendente. Recupere o código ou aguarde sua validade terminar.")
                return pix_publico(gravar_qr(cur, pendente) if not pendente["payload_pix"] else pendente)
            cur.execute("SELECT asaas_cliente_id,asaas_base FROM carteiras WHERE usuario_id=%s", (u["id"],))
            cadastro = cur.fetchone()
            if cadastro and cadastro["asaas_base"] and cadastro["asaas_base"] != base:
                raise HTTPException(409, "Seu cadastro de pagamentos pertence a outro ambiente. Solicite a revisão da integração.")
            cliente_id = cadastro["asaas_cliente_id"] if cadastro else None
            if not cliente_id:
                cpf = documento_valido(corpo.get("cpfCnpj"))
                # Recupera um cliente criado antes de uma falha de gravação.
                encontrados = asaas("GET", f"/customers?externalReference=smartcharge-usuario-{u['id']}")
                clientes = encontrados.get("data") or []
                cliente = clientes[0] if clientes else asaas("POST", "/customers", {
                    "name": u["nome"], "email": u["email"], "cpfCnpj": cpf,
                    "externalReference": f"smartcharge-usuario-{u['id']}", "notificationDisabled": True})
                cliente_id = cliente["id"]
                cur.execute("INSERT INTO carteiras (usuario_id,asaas_cliente_id,asaas_base) VALUES (%s,%s,%s) "
                            "ON CONFLICT (usuario_id) DO UPDATE SET asaas_cliente_id=EXCLUDED.asaas_cliente_id, "
                            "asaas_base=EXCLUDED.asaas_base", (u["id"], cliente_id, base))
            # Persistir o cadastro antes de criar a cobrança facilita retomadas.
            con.commit()
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s,%s)", (73421, u["id"]))
            cur.execute("SELECT * FROM carteira_pix WHERE usuario_id=%s AND valor_brl=%s AND status='PENDING' "
                        "AND forma=%s AND (expiracao_em>now() OR expiracao_em IS NULL) "
                        "ORDER BY id DESC LIMIT 1", (u["id"], valor, forma))
            pendente = cur.fetchone()
            if pendente:
                if dinheiro(pendente["valor_brl"]) != valor:
                    raise HTTPException(409, "Você já tem um Pix pendente. Recupere o código existente.")
                return pix_publico(gravar_qr(cur, pendente) if not pendente["payload_pix"] else pendente)
            # A mesma referência é reutilizada após falha de rede/gravação.
            cur.execute("SELECT pix_referencia FROM carteiras WHERE usuario_id=%s", (u["id"],))
            # A forma entra na referencia: sem ela, uma cobranca de Pix deixada
            # para tras por uma falha seria recuperada como se fosse o boleto
            # que a pessoa acabou de pedir, e a conferencia de billingType
            # rejeitaria depois, com a cobranca ja gravada.
            ref = (cur.fetchone()["pix_referencia"]
                   or f"smartcharge-carteira-{u['id']}-{forma}-{secrets.token_hex(16)}")
            cur.execute("UPDATE carteiras SET pix_referencia=%s WHERE usuario_id=%s", (ref, u["id"]))
            con.commit()
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s,%s)", (73421, u["id"]))
            cur.execute("SELECT pix_referencia FROM carteiras WHERE usuario_id=%s", (u["id"],))
            atual = cur.fetchone()["pix_referencia"]
            if atual != ref:
                raise HTTPException(409, "Sua cobrança foi atualizada. Recarregue a carteira.")
            existentes = asaas("GET", f"/payments?externalReference={ref}").get("data") or []
            # Boleto precisa de prazo: emitir com vencimento hoje daria um
            # papel que vence antes de compensar. Pix e cartao sao na hora.
            vence = datetime.now(BRASIL).date() + timedelta(days=3 if forma == "boleto" else 0)
            cobranca = existentes[0] if existentes else asaas("POST", "/payments", {
                "customer": cliente_id, "billingType": FORMAS[forma], "value": float(valor),
                "dueDate": vence.isoformat(),
                "description": "Adicionar saldo na carteira Smart Charge", "externalReference": ref})
            if dinheiro(cobranca.get("value")) != valor:
                raise HTTPException(409, "Há uma cobrança anterior em recuperação. Tente novamente com o valor original.")
            # Para o boleto, `expiracao_em` recebe o vencimento: e a mesma
            # pergunta que a coluna ja respondia para o Pix -- ate quando esta
            # cobranca vale. Reaproveitar evita uma coluna nova e faz a
            # recuperacao de pendente funcionar de graca: enquanto o boleto
            # nao vencer, pedir outro devolve o mesmo, em vez de emitir dois.
            # Cartao fica nulo: nao vence.
            expira = (datetime.combine(vence, time(23, 59, 59), BRASIL)
                      if forma == "boleto" else None)
            cur.execute("INSERT INTO carteira_pix "
                        "  (usuario_id,asaas_pagamento_id,valor_brl,status,asaas_base,"
                        "   forma,url_pagamento,url_boleto,expiracao_em) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (asaas_pagamento_id) DO UPDATE "
                        "SET asaas_pagamento_id=EXCLUDED.asaas_pagamento_id RETURNING *",
                        (u["id"], cobranca["id"], valor, "PENDING", base, forma,
                         cobranca.get("invoiceUrl"), cobranca.get("bankSlipUrl"), expira))
            pix = cur.fetchone()
            cur.execute("UPDATE carteiras SET pix_referencia=NULL WHERE usuario_id=%s", (u["id"],))
            # Salvar ANTES do QR: uma falha no QR não perde uma cobrança real.
            con.commit()
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT * FROM carteira_pix WHERE id=%s FOR UPDATE", (pix["id"],))
            atual = cur.fetchone()
            if cobranca.get("status") in PAGOS or cobranca.get("refunds"):
                atual = aplicar_pagamento(cur, atual, asaas("GET", f"/payments/{atual['asaas_pagamento_id']}"))
            # Cada forma completa o que falta. Cartao nao precisa de nada: o
            # invoiceUrl ja veio na criacao.
            return pix_publico(gravar_boleto(cur, gravar_qr(cur, atual)))

    @router.get("/carteira/pix/{pagamento_id}")
    def consultar_pix(pagamento_id: str, u=Depends(motorista)):
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT * FROM carteira_pix WHERE asaas_pagamento_id=%s AND usuario_id=%s", (pagamento_id, u["id"]))
            pix = cur.fetchone()
            if not pix:
                raise HTTPException(404, "Pix não encontrado.")
            return pix_publico(pix)

    @router.post("/carteira/pix/{pagamento_id}/verificar")
    def verificar_pix(pagamento_id: str, u=Depends(motorista)):
        limitar_carteira(u["id"], "verificar")
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT * FROM carteira_pix WHERE asaas_pagamento_id=%s AND usuario_id=%s FOR UPDATE", (pagamento_id, u["id"]))
            pix = cur.fetchone()
            if not pix:
                raise HTTPException(404, "Pix não encontrado.")
            base, _ = configuracao()
            if pix["asaas_base"] and pix["asaas_base"] != base:
                raise HTTPException(409, "Este Pix pertence a outro ambiente de pagamentos.")
            pagamento = asaas("GET", f"/payments/{pix['asaas_pagamento_id']}")
            pix = aplicar_pagamento(cur, pix, pagamento)
            if pix["status"] == "PENDING":
                if not pix["payload_pix"]:
                    pix = gravar_qr(cur, pix)
                pix = gravar_boleto(cur, pix)
            return pix_publico(pix)

    @router.post("/carteira/credito-teste")
    def credito_teste(u=Depends(motorista)):
        base, _ = configuracao()
        if base != SANDBOX or os.environ.get("WALLET_DEMO_MODE") != "1":
            raise HTTPException(404, "Crédito de demonstração indisponível.")
        limitar_carteira(u["id"], "criar")
        with conectar() as con, con.cursor() as cur:
            cur.execute("INSERT INTO carteira_lancamentos (usuario_id,tipo,valor_brl,descricao,referencia) "
                        "VALUES (%s,'credito_teste',100,'Crédito fictício de demonstração',%s) "
                        "ON CONFLICT (referencia) DO NOTHING", (u["id"], f"demo:{u['id']}"))
        return {"ok": True}

    @router.post("/webhooks/asaas", include_in_schema=False)
    def webhook_asaas(request: Request, corpo: dict = Body(...)):
        esperado = os.environ.get("ASAAS_WEBHOOK_TOKEN", "").strip()
        recebido = request.headers.get("asaas-access-token", "")
        if not esperado or not hmac.compare_digest(recebido.encode(), esperado.encode()):
            raise HTTPException(401, "Webhook não autorizado.")
        evento_id, evento = corpo.get("id"), corpo.get("event")
        if not isinstance(evento_id, str) or not evento_id or len(evento_id) > 200:
            raise HTTPException(422, "Evento sem identificador válido.")
        if not isinstance(evento, str) or evento not in EVENTOS:
            return {"ok": True, "ignorado": True}
        pagamento = corpo.get("payment")
        if not isinstance(pagamento, dict) or not isinstance(pagamento.get("id"), str):
            raise HTTPException(422, "Evento sem cobrança válida.")
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT * FROM carteira_pix WHERE asaas_pagamento_id=%s FOR UPDATE", (pagamento["id"],))
            pix = cur.fetchone()
            if not pix:
                # Não marcar como processado: a Asaas pode notificar antes do
                # INSERT local. Cobranças alheias à carteira são ignoradas.
                referencia = pagamento.get("externalReference")
                if referencia is None:
                    referencia = asaas("GET", f"/payments/{pagamento['id']}").get("externalReference", "")
                if str(referencia).startswith("smartcharge-carteira-"):
                    raise HTTPException(503, "Cobrança em gravação. Reenvie o evento.")
                return {"ok": True, "ignorado": True}
            cur.execute("INSERT INTO carteira_eventos_asaas (evento_id) VALUES (%s) "
                        "ON CONFLICT DO NOTHING RETURNING evento_id", (evento_id,))
            if not cur.fetchone():
                return {"ok": True, "duplicado": True}
            base, _ = configuracao()
            if pix["asaas_base"] and pix["asaas_base"] != base:
                raise HTTPException(409, "Ambiente da cobrança não corresponde à integração.")
            # O retrato atual evita que um evento atrasado desfaça um estorno.
            aplicar_pagamento(cur, pix, asaas("GET", f"/payments/{pix['asaas_pagamento_id']}"))
        return {"ok": True}

    app.include_router(router)
