"""Regressões de pagamentos sem banco remoto, credenciais ou dinheiro real."""
import copy
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
import carteira as wallet
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


class Banco:
    """Modelo transacional do ledger; falhar dentro do contexto faz rollback."""
    def __init__(self):
        self.pix = {}
        self.ledger = {}
        self.eventos = set()
        self.cadastro = {}

    def conectar(self):
        return Conexao(self)

    def adicionar_pix(self, usuario=1, valor="25.00", pagamento="pay_teste"):
        self.pix[pagamento] = {"id": len(self.pix)+1, "usuario_id": usuario,
            "asaas_pagamento_id": pagamento, "valor_brl": Decimal(valor), "status":"PENDING",
            "recebido_em":None, "asaas_base":wallet.SANDBOX, "payload_pix":"codigo-seguro",
            "imagem_base64":None, "expiracao_em":datetime.now(timezone.utc)+timedelta(hours=1),
            "criado_em":datetime.now(timezone.utc)}


class Conexao:
    def __init__(self, banco): self.banco = banco
    def __enter__(self): self.salvar(); return self
    def salvar(self): self.snapshot = copy.deepcopy(self.banco.__dict__)
    def commit(self): self.salvar()
    def __exit__(self, tipo, *_):
        if tipo: self.banco.__dict__.update(self.snapshot)
    def cursor(self): return Cursor(self.banco)


class Cursor:
    def __init__(self, banco): self.b = banco; self.linhas = []
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def fetchone(self): return self.linhas.pop(0) if self.linhas else None
    def fetchall(self): return self.linhas
    def execute(self, sql, args=()):
        self.linhas = []
        if sql.startswith(("SET TRANSACTION", "SELECT pg_advisory")): return
        if sql.startswith("SELECT * FROM carteira_pix"):
            valores = list(self.b.pix.values())
            if "asaas_pagamento_id=%s" in sql:
                valores = [p for p in valores if p["asaas_pagamento_id"] == args[0]]
                if "usuario_id=%s" in sql: valores = [p for p in valores if p["usuario_id"] == args[1]]
            elif "WHERE id=%s" in sql: valores = [p for p in valores if p["id"] == args[0]]
            else:
                valores = [p for p in valores if p["usuario_id"] == args[0]]
                if "valor_brl=%s" in sql: valores = [p for p in valores if p["valor_brl"] == args[1]]
                if "status='PENDING'" in sql: valores = [p for p in valores if p["status"] == "PENDING" and (not p["expiracao_em"] or p["expiracao_em"] > datetime.now(timezone.utc))]
            self.linhas = [copy.deepcopy(p) for p in sorted(valores,key=lambda x:x["id"],reverse=True)]
            return
        if sql.startswith("INSERT INTO carteira_eventos"):
            if args[0] not in self.b.eventos: self.b.eventos.add(args[0]); self.linhas = [{"evento_id":args[0]}]
            return
        if sql.startswith("INSERT INTO carteira_lancamentos"):
            usuario, valor, ref = args
            tipo = "estorno" if "'estorno'" in sql else "recarga_pix"
            self.b.ledger.setdefault(ref, {"usuario_id":usuario,"valor_brl":valor,"tipo":tipo,
                "id":len(self.b.ledger)+1,"descricao":"Pix","criado_em":datetime.now(timezone.utc)})
            return
        if sql.startswith("SELECT coalesce(-sum"):
            self.linhas = [{"total": -sum((l["valor_brl"] for r,l in self.b.ledger.items() if r.startswith(args[1][:-1]) and l["usuario_id"] == args[0]),Decimal("0"))}]; return
        if sql.startswith("SELECT coalesce(sum"):
            self.linhas = [{"saldo":sum((l["valor_brl"] for l in self.b.ledger.values() if l["usuario_id"]==args[0]),Decimal("0"))}]; return
        if sql.startswith("SELECT id,tipo"):
            self.linhas = [copy.deepcopy(l) for l in self.b.ledger.values() if l["usuario_id"] == args[0]]; return
        if sql.startswith("SELECT e.id AS estabelecimento_id"): return
        if sql.startswith("SELECT asaas_cliente_id"):
            c = self.b.cadastro.get(args[0]); self.linhas = [copy.deepcopy(c)] if c else []; return
        if sql.startswith("SELECT pix_referencia"):
            self.linhas = [{"pix_referencia":self.b.cadastro[args[0]].get("pix_referencia")}]; return
        if sql.startswith("UPDATE carteiras SET pix_referencia"):
            self.b.cadastro[args[-1]]["pix_referencia"] = args[0] if "=%s" in sql else None; return
        if sql.startswith("INSERT INTO carteira_pix"):
            usuario, pagamento, valor, _, base = args
            if pagamento not in self.b.pix:
                self.b.adicionar_pix(usuario,str(valor),pagamento)
                self.b.pix[pagamento].update(payload_pix=None,expiracao_em=None,asaas_base=base)
            self.linhas = [copy.deepcopy(self.b.pix[pagamento])]; return
        if sql.startswith("UPDATE carteira_pix"):
            p = next(p for p in self.b.pix.values() if p["id"] == args[-1])
            if "SET recebido_em=" in sql: p["recebido_em"] = p["recebido_em"] or datetime.now(timezone.utc)
            elif "SET payload_pix=" in sql: p.update(payload_pix=args[0],imagem_base64=args[1],expiracao_em=args[2])
            elif "SET status=" in sql: p["status"] = args[0]
            if "RETURNING" in sql: self.linhas = [copy.deepcopy(p)]
            return
        raise AssertionError(f"SQL não modelado no teste: {sql}")


class CarteiraTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ,{"ASAAS_API_KEY":"$aact_hmlg_teste", "ASAAS_API_BASE":"", "ASAAS_WEBHOOK_TOKEN":"token-teste", "WALLET_DEMO_MODE":"0"})
        self.env.start(); self.addCleanup(self.env.stop)
        self.banco = Banco(); self.banco.adicionar_pix()
        self.usuario = {"id":1,"papel":"motorista","nome":"Teste","email":"teste@example.com"}
        app = FastAPI(); wallet.registrar_carteira(app, lambda:self.usuario)
        self.client = TestClient(app)
        self.db = patch.object(wallet,"conectar",self.banco.conectar); self.db.start(); self.addCleanup(self.db.stop)
        self.limite = patch.object(wallet,"limitar_carteira"); self.limite.start(); self.addCleanup(self.limite.stop)
        self.pagamento = {"id":"pay_teste", "value":25, "billingType":"PIX", "status":"RECEIVED", "refunds":[]}
        self.api = patch.object(wallet,"asaas", side_effect=lambda *a,**k: copy.deepcopy(self.pagamento))
        self.mock = self.api.start(); self.addCleanup(self.api.stop)

    def evento(self, nome="PAYMENT_RECEIVED", id="evt_1", pagamento=None):
        return self.client.post("/webhooks/asaas",headers={"asaas-access-token":"token-teste"},json={"id":id,"event":nome,"payment":pagamento or self.pagamento})

    def saldo(self): return sum((l["valor_brl"] for l in self.banco.ledger.values()),Decimal("0"))

    def test_confirmacao_repetida_e_dois_eventos_nao_duplicam_saldo(self):
        self.assertEqual(self.evento().status_code,200)
        self.assertTrue(self.evento().json()["duplicado"])
        self.assertEqual(self.evento("PAYMENT_CONFIRMED","evt_2").status_code,200)
        self.assertEqual(self.saldo(),Decimal("25")); self.assertEqual(len(self.banco.ledger),1)

    def test_webhook_antes_da_gravacao_pode_ser_reenviado(self):
        self.banco.pix.clear()
        p = {**self.pagamento,"externalReference":"smartcharge-carteira-1-abc"}
        self.assertEqual(self.evento(pagamento=p).status_code,503)
        self.assertFalse(self.banco.eventos)
        self.banco.adicionar_pix()
        self.assertEqual(self.evento(pagamento=p).status_code,200)
        self.assertEqual(self.saldo(),Decimal("25"))

    def test_falha_do_provedor_nao_consume_evento(self):
        self.mock.side_effect = HTTPException(502,"fora do ar")
        self.assertEqual(self.evento().status_code,502)
        self.assertFalse(self.banco.eventos); self.assertEqual(self.saldo(),0)

    def test_estornos_parciais_e_total_sao_idempotentes(self):
        self.evento()
        self.pagamento["refunds"] = [{"value":5,"status":"DONE"},{"value":3,"status":"PENDING"}]
        self.assertEqual(self.evento("PAYMENT_PARTIALLY_REFUNDED","evt_2").status_code,200)
        self.assertEqual(self.saldo(),Decimal("20"))
        self.evento("PAYMENT_PARTIALLY_REFUNDED","evt_3"); self.assertEqual(self.saldo(),Decimal("20"))
        self.pagamento["status"] = "REFUNDED"
        self.evento("PAYMENT_REFUNDED","evt_4"); self.assertEqual(self.saldo(),0)
        # Evento de recebimento antigo consulta o estado atual e não recredita.
        self.evento("PAYMENT_RECEIVED","evt_5"); self.assertEqual(self.saldo(),0)

    def test_estorno_antes_do_recebimento_nao_deixa_saldo_negativo(self):
        self.pagamento["status"] = "REFUNDED"
        self.assertEqual(self.evento("PAYMENT_REFUNDED").status_code,200)
        self.assertEqual(self.saldo(),0)

    def test_divergencia_de_valor_e_meio_de_pagamento_nao_creditam(self):
        for campo,valor in [("value",250),("billingType","RECEIVED_IN_CASH")]:
            original = self.pagamento[campo]; self.pagamento[campo] = valor
            self.assertEqual(self.evento().status_code,409)
            self.assertFalse(self.banco.eventos); self.assertEqual(self.saldo(),0)
            self.pagamento[campo] = original

    def test_conferir_recupera_confirmacao_sem_webhook(self):
        for _ in range(2): self.assertEqual(self.client.post("/carteira/pix/pay_teste/verificar").status_code,200)
        self.assertEqual(self.saldo(),Decimal("25"))

    def test_motorista_nao_acessa_pix_de_outro_usuario(self):
        self.usuario["id"] = 2
        self.assertEqual(self.client.get("/carteira/pix/pay_teste").status_code,404)
        self.assertEqual(self.client.post("/carteira/pix/pay_teste/verificar").status_code,404)
        self.mock.assert_not_called()
        self.assertEqual(self.client.get("/carteira").json()["cobrancas"],[])

    def test_gerente_nao_acessa_carteira(self):
        self.usuario["papel"] = "gerente"
        self.assertEqual(self.client.get("/carteira").status_code,403)

    def test_token_invalido_e_corpos_invalidos(self):
        self.assertEqual(self.client.post("/webhooks/asaas",json={}).status_code,401)
        self.assertEqual(self.evento(pagamento={"id":123}).status_code,422)
        self.assertEqual(self.client.post("/webhooks/asaas",headers={"asaas-access-token":"token-teste"},json={"id":"e","event":[]}).status_code,200)

    def test_pix_pendente_e_reutilizado_sem_nova_cobranca(self):
        r = self.client.post("/carteira/pix",json={"valor":"25.00"})
        self.assertEqual(r.status_code,200); self.assertEqual(r.json()["id"],"pay_teste")
        self.mock.assert_not_called()

    def test_qr_falha_mas_cobranca_permanece_recuperavel(self):
        self.banco.pix.clear()
        self.banco.cadastro[1] = {"asaas_cliente_id":"cus_1","asaas_base":wallet.SANDBOX,"pix_referencia":None}
        def fornecedor(metodo,caminho,corpo=None):
            if caminho.endswith("pixQrCode"): raise HTTPException(502,"QR indisponível")
            if metodo == "GET": return {"data":[]}
            return {**self.pagamento,"status":"PENDING"}
        self.mock.side_effect = fornecedor
        self.assertEqual(self.client.post("/carteira/pix",json={"valor":"25"}).status_code,502)
        self.assertIn("pay_teste",self.banco.pix)
        self.mock.side_effect = lambda *a,**k: {"payload":"codigo","encodedImage":"imagem", "expirationDate":(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()}
        r = self.client.post("/carteira/pix",json={"valor":"25"})
        self.assertEqual(r.status_code,200); self.assertEqual(r.json()["copia_e_cola"],"codigo")

    def test_valores_invalidos(self):
        for v in ["NaN","Infinity","-Infinity","abc",None,"4.99","1000.01","25.001"]:
            self.assertEqual(self.client.post("/carteira/pix",json={"valor":v}).status_code,422,v)
        self.assertEqual(wallet.valor_pix("25.50"),Decimal("25.50"))

    def test_documento_validado(self):
        self.assertEqual(wallet.documento_valido("529.982.247-25"),"52998224725")
        self.assertEqual(wallet.documento_valido("11.222.333/0001-81"),"11222333000181")
        for doc in ["11111111111","52998224724","123",None]:
            with self.assertRaises(HTTPException): wallet.documento_valido(doc)

    def test_ambiente_detectado_e_credito_demo_bloqueado_em_producao(self):
        os.environ["ASAAS_API_KEY"] = "$aact_prod_teste"
        self.assertEqual(wallet.configuracao()[0],wallet.PRODUCAO)
        os.environ["WALLET_DEMO_MODE"] = "1"
        self.assertEqual(self.client.post("/carteira/credito-teste").status_code,404)
        os.environ["ASAAS_API_BASE"] = wallet.SANDBOX
        with self.assertRaises(HTTPException): wallet.configuracao()

    def test_configuracao_ausente_nao_e_tratada_como_sandbox(self):
        os.environ["ASAAS_API_KEY"] = ""
        os.environ["ASAAS_WEBHOOK_TOKEN"] = ""
        config = wallet.estado_configuracao()
        self.assertFalse(config["pix_configurado"])
        self.assertEqual(config["pendencias"],["ASAAS_API_KEY","ASAAS_WEBHOOK_TOKEN"])
        resposta = self.client.get("/carteira").json()
        self.assertFalse(resposta["pix_disponivel"])
        self.assertEqual(resposta["ambiente"],"indisponivel")
        self.assertFalse(resposta["modo_demo"])

    def test_ativacao_depois_de_configurar_servidor(self):
        os.environ["ASAAS_API_KEY"] = ""
        self.assertFalse(self.client.get("/carteira").json()["pix_disponivel"])
        os.environ["ASAAS_API_KEY"] = "$aact_hmlg_teste"
        self.assertTrue(self.client.get("/carteira").json()["pix_disponivel"])
        self.assertEqual(wallet.estado_configuracao()["pendencias"],[])
        os.environ["ASAAS_API_BASE"] = "https://api-malicioso.example/v3"
        with self.assertRaises(HTTPException): wallet.configuracao()


if __name__ == "__main__": unittest.main()
