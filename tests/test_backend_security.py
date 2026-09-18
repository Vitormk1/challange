"""Regressões de autorização e credenciais sem acessar serviços externos."""
import copy
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
import auth
import correio
import main
import protecao
import trocar_senha
from fastapi.testclient import TestClient


class Banco:
    def __init__(self):
        self.users = {1: {'id':1, 'nome':'Teste', 'papel':'motorista', 'ativo':True,
                         'email':'teste@example.com', 'email_verificado':False,
                         'senha_hash':auth.criar_hash('senha-correta')}}
        self.tokens = {token:{'usuario_id':1,'expira_em':datetime.now(timezone.utc)+timedelta(hours=1)}
                       for token in ('primeiro','irmao')}
        self.sessions = {'antiga':1,'atual':1}
        self.sales = {8:{'id':8,'estabelecimento_id':10,'cliente_id':None,'cupom_id':None,'sessao_id':None,'valor_brl':25}}
        self.references = {
            'cliente_id':{11:{'id':11,'loja':10},21:{'id':21,'loja':20}},
            'sessao_id':{12:{'id':12,'loja':10,'cliente_id':11},22:{'id':22,'loja':20,'cliente_id':21}},
            'cupom_id':{13:{'id':13,'loja':10,'cliente_id':11,'sessao_id':12},23:{'id':23,'loja':20,'cliente_id':21,'sessao_id':22}},
        }
        self.payload = {'estabelecimentos':[{'id':10,'nome':'Loja','margem_liquida_pct':20,'ticket_medio_brl':30}],
                        'clientes':[{'id':11,'apelido':'Teste','visitas':3,'fidelidade_saldo_cashback_brl':5,'fidelidade_creditos':2}],
                        'sessoes':[{'id':12,'energia_kwh':4,'situacao':'concluida','cashback_brl':5,'previsao_custo_brl':6,'custo_energia_brl':7,'valor_cobrado_brl':8}],
                        'vendas':[{'id':8,'momento':'hoje','valor_brl':30}],
                        'cupons':[{'id':13,'codigo':'CODIGO','desconto_brl':5}]}

    def conectar(self):
        return Conexao(self)


class Conexao:
    def __init__(self,b): self.b=b
    def __enter__(self): self.snapshot=copy.deepcopy(self.b.__dict__); return self
    def commit(self): self.snapshot=copy.deepcopy(self.b.__dict__)
    def __exit__(self,typ,*_):
        if typ: self.b.__dict__.update(self.snapshot)
    def cursor(self): return Cursor(self.b)


class Cursor:
    def __init__(self,b): self.b=b; self.rows=[]; self.rowcount=0
    def __enter__(self): return self
    def __exit__(self,*_): pass
    def fetchone(self): return self.rows.pop(0) if self.rows else None
    def execute(self,query,args=()):
        query=query.as_string() if hasattr(query,'as_string') else query
        self.rows=[]; self.rowcount=0
        if query.startswith('SELECT pg_advisory'): return
        if query == main.SQL_DADOS: self.rows=[{'payload':copy.deepcopy(self.b.payload)}]; return
        if query == 'context': self.rows=[{'ctx':copy.deepcopy(getattr(self.b,'context_payload',{}))}]; return
        if query.startswith('SELECT usuario_id FROM verificacoes_email'):
            t=self.b.tokens.get(args[0]); self.rows=[copy.deepcopy(t)] if t else []; return
        if query.startswith('SELECT ativo, email_verificado') or query.startswith('SELECT senha_hash'):
            u=self.b.users.get(args[0]); self.rows=[copy.deepcopy(u)] if u else []; return
        if query.startswith('DELETE FROM verificacoes_email WHERE token'):
            t=self.b.tokens.pop(args[0],None); self.rows=[t] if t else []; return
        if query.startswith('DELETE FROM verificacoes_email WHERE usuario_id'):
            self.b.tokens={t:v for t,v in self.b.tokens.items() if v['usuario_id']!=args[0]}; return
        if query.startswith('DELETE FROM verificacoes_email WHERE expira_em'): return
        if query.startswith('UPDATE usuarios SET email_verificado'):
            self.b.users[args[0]]['email_verificado']=True; return
        if query.startswith('UPDATE usuarios SET senha_hash'):
            uid=args[1] if isinstance(args[1],int) else next((u['id'] for u in self.b.users.values() if u['email']==args[1]),None)
            if uid: self.b.users[uid]['senha_hash']=args[0]; self.rows=[copy.deepcopy(self.b.users[uid])]
            return
        if query.startswith('INSERT INTO sessoes_web'):
            self.b.sessions[args[0]]=args[1]; return
        if query.startswith('DELETE FROM sessoes_web WHERE usuario_id'):
            before=len(self.b.sessions)
            keep=args[1] if len(args)>1 else None
            self.b.sessions={t:u for t,u in self.b.sessions.items() if u!=args[0] or t==keep}
            self.rowcount=before-len(self.b.sessions); return
        if query.startswith('SELECT 1 FROM usuarios WHERE lower(email)'):
            self.rows=[{'exists':1}] if any(u['email']==args[0] for u in self.b.users.values()) else []; return
        if query.startswith('INSERT INTO usuarios'):
            uid=len(self.b.users)+1
            self.b.users[uid]={'id':uid,'nome':args[0],'email':args[1],'papel':'motorista','senha_hash':args[2],'email_verificado':args[3],'ativo':True}
            self.rows=[{'id':uid}]; return
        if query.startswith('INSERT INTO verificacoes_email'):
            self.b.tokens[args[0]]={'usuario_id':args[1],'expira_em':datetime.now(timezone.utc)+timedelta(hours=24)}; return
        if query.startswith('SELECT * FROM vendas WHERE id'):
            v=self.b.sales.get(args[0]); self.rows=[copy.deepcopy(v)] if v else []; return
        for field, prefix in [('cliente_id','SELECT id, estabelecimento_id AS loja'),('sessao_id','SELECT s.id, s.cliente_id'),('cupom_id','SELECT q.id, q.sessao_id')]:
            if query.startswith(prefix):
                v=self.b.references[field].get(args[0]); self.rows=[copy.deepcopy(v)] if v else []; return
        if query.startswith('UPDATE "vendas"'):
            v=self.b.sales[args[-1]]
            import re
            names=re.findall(r'"([a-z_]+)" = %s',query)
            v.update(zip(names,args[:-1])); self.rows=[copy.deepcopy(v)]; return
        if query.startswith('INSERT INTO "vendas"'):
            import re
            names=re.findall(r'"([a-z_]+)"',query)[1:]
            v=dict(zip(names,args)); v['id']=9; self.b.sales[9]=v; self.rows=[copy.deepcopy(v)]; return
        if query.startswith('SELECT 1 FROM clientes'):
            r=self.b.references['cliente_id'].get(args[0]); self.rows=[{'exists':1}] if r and r['loja']==args[1] else []; return
        raise AssertionError('Unmodeled SQL: '+query)


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.b=Banco(); protecao._tentativas.clear()
        self.addCleanup(protecao._tentativas.clear)
        self.db=patch.object(main,'conectar',self.b.conectar); self.db.start(); self.addCleanup(self.db.stop)
        self.lojas=patch.object(main,'lojas_do_usuario',return_value=[10,20]); self.lojas.start(); self.addCleanup(self.lojas.stop)
        self.dono=patch.object(main,'_confere_dono'); self.dono.start(); self.addCleanup(self.dono.stop)
        self.loja=patch.object(main,'exigir_loja',side_effect=lambda u,id:id); self.loja.start(); self.addCleanup(self.loja.stop)
        self.fid=patch.object(main,'aplicar_fidelidade'); self.fid.start(); self.addCleanup(self.fid.stop)
        self.u={'id':1,'papel':'gerente'}
        main.app.dependency_overrides[main.usuario_atual]=lambda:self.u
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client=TestClient(main.app)

    def test_dados_operador_redige_financeiro_preserva_operacao(self):
        self.u['papel']='operador'
        data=self.client.get('/dados?estabelecimento_id=10').json()
        self.assertEqual(data['sessoes'][0]['energia_kwh'],4)
        self.assertEqual(data['clientes'][0]['apelido'],'Teste')
        for name,keys in [('sessoes',['cashback_brl','previsao_custo_brl','custo_energia_brl','valor_cobrado_brl']),('vendas',['valor_brl']),('cupons',['desconto_brl']),('clientes',['fidelidade_saldo_cashback_brl','fidelidade_creditos']),('estabelecimentos',['margem_liquida_pct','ticket_medio_brl'])]:
            for key in keys: self.assertNotIn(key,data[name][0])
        self.assertEqual(self.client.get('/dados?estabelecimento_id=10').headers['cache-control'],'no-store')

    def test_dados_gerente_e_main_preservam_financeiro(self):
        for role in ['gerente','main']:
            self.u['papel']=role
            self.assertEqual(self.client.get('/dados?estabelecimento_id=10').json()['vendas'][0]['valor_brl'],30)

    def test_referencias_estrangeiras_create_patch_e_main(self):
        for role in ['gerente','main']:
            self.u['papel']=role
            for field,value in [('cliente_id',21),('sessao_id',22),('cupom_id',23)]:
                for method,url,body in [('post','/registros/vendas',{'estabelecimento_id':10,'valor_brl':25,field:value}),('patch','/registros/vendas/8',{field:value})]:
                    self.assertEqual(getattr(self.client,method)(url,json=body).status_code,400)
        self.assertEqual(len(self.b.sales),1)
        self.assertIsNone(self.b.sales[8]['cliente_id'])

    def test_referencias_inexistentes_e_ids_malformados(self):
        for value in [999,True,1.5,[],{},-1,'11 OR 1=1',9223372036854775808]:
            self.assertEqual(self.client.patch('/registros/vendas/8',json={'cliente_id':value}).status_code,400)

    def test_venda_local_e_referencias_nulas_funcionam(self):
        response=self.client.post('/registros/vendas',json={'estabelecimento_id':10,'valor_brl':25,'cliente_id':11,'sessao_id':12,'cupom_id':13})
        self.assertEqual(response.status_code,200)
        response=self.client.patch('/registros/vendas/9',json={'cliente_id':None,'sessao_id':None,'cupom_id':None})
        self.assertEqual(response.status_code,200)

    def test_inconsistencia_mesma_loja_recusada(self):
        self.b.references['cupom_id'][13]['sessao_id']=99
        self.assertEqual(self.client.post('/registros/vendas',json={'estabelecimento_id':10,'valor_brl':25,'sessao_id':12,'cupom_id':13}).status_code,400)
        self.b.references['cupom_id'][13]['sessao_id']=12
        self.b.references['sessao_id'][12]['cliente_id']=999
        self.assertEqual(self.client.post('/registros/vendas',json={'estabelecimento_id':10,'valor_brl':25,'cliente_id':11,'sessao_id':12}).status_code,400)

    def test_confirmar_invalida_irmaos_e_nao_reabre_conta(self):
        with patch.object(main,'eu',return_value={'ok':True}),patch.object(main,'usuario_atual',return_value=self.u):
            self.assertEqual(self.client.post('/auth/verificar',json={'token':'primeiro'}).status_code,200)
            count=len(self.b.sessions)
            self.assertEqual(self.client.post('/auth/verificar',json={'token':'irmao'}).status_code,404)
            self.b.tokens['legado']={'usuario_id':1,'expira_em':datetime.now(timezone.utc)+timedelta(hours=1)}
            self.assertEqual(self.client.post('/auth/verificar',json={'token':'legado'}).status_code,404)
            self.assertEqual(len(self.b.sessions),count)

    def test_link_expirado_e_conta_inativa_nao_autenticam(self):
        self.b.tokens['primeiro']['expira_em']=datetime.now(timezone.utc)-timedelta(hours=1)
        self.assertEqual(self.client.post('/auth/verificar',json={'token':'primeiro'}).status_code,410)
        self.b.users[1]['ativo']=False
        self.assertEqual(self.client.post('/auth/verificar',json={'token':'irmao'}).status_code,404)

    def test_troca_senha_invalida_links_e_outras_sessoes(self):
        response=self.client.post('/perfil/senha',json={'senha_atual':'senha-correta','nova':'senha-nova-segura'},cookies={main.COOKIE:'atual'})
        self.assertEqual(response.status_code,200)
        self.assertFalse(self.b.tokens)
        self.assertEqual(self.b.sessions,{'atual':1})
        self.assertTrue(auth.conferir_senha('senha-nova-segura',self.b.users[1]['senha_hash']))
        self.assertEqual(self.client.post('/auth/verificar',json={'token':'irmao'}).status_code,404)

    def test_rotacao_administrativa_invalida_tudo(self):
        with patch.object(trocar_senha,'conectar',self.b.conectar),patch('builtins.print'):
            self.assertTrue(trocar_senha.trocar('teste@example.com','senha-nova-segura'))
        self.assertFalse(self.b.tokens); self.assertFalse(self.b.sessions)

    def test_limite_compartilhado_entre_rotas_e_sessoes(self):
        with patch.object(main,'consultar',return_value=[self.b.users[1]]):
            for i in range(6):
                path='/perfil/nome' if i%2==0 else '/perfil/senha'
                body={'nome':'Outro Nome','nova':'outra-senha','senha_atual':'incorreta'}
                self.assertEqual(self.client.post(path,json=body,cookies={main.COOKIE:str(i)}).status_code,403)
            self.assertEqual(self.client.post('/perfil/nome',json={'nome':'Outro Nome','senha_atual':'incorreta'}).status_code,429)
            self.assertEqual(self.client.post('/perfil/senha',json={'nova':'outra-senha','senha_atual':'incorreta'}).status_code,429)

    def test_cadastro_em_email_existente_recusa_sem_tocar_na_conta(self):
        """O cadastro DIZ que o e-mail ja tem conta, e isso e deliberado.

        Ate a versao anterior as duas respostas eram iguais, para nao revelar
        quais enderecos tem cadastro. O preco apareceu no primeiro teste real:
        a pessoa clicava, nada acontecia, e a unica saida era adivinhar que ja
        tinha conta. O sigilo tambem nao se sustentava sozinho -- quem quiser
        descobrir se um endereco tem conta aqui tem caminhos mais diretos.

        A troca esta assumida e comentada em `main.cadastrar`. O que este
        teste protege agora e o que NAO pode mudar junto: a tentativa nao
        altera a conta existente, nao devolve sessao para quem tentou, e a
        recusa e um 409 limpo, sem vazar nada da conta alheia.

        So o modo com verificacao ligada e exercido: e a configuracao de
        producao, e sem provedor de e-mail o cadastro entra logado, caminho
        que o dublê de banco desta suite nao modela.
        """
        with patch.object(main,'verificacao_ativa',return_value=True),patch.object(main,'_mandar_verificacao'):
            novo=self.client.post('/auth/cadastrar',json={'nome':'Novo','email':'novo@example.com','senha':'senha-segura'})
            existente=self.client.post('/auth/cadastrar',json={'nome':'Invasor','email':'teste@example.com','senha':'senha-segura'})

        self.assertEqual(novo.status_code,200)
        self.assertEqual(existente.status_code,409)
        # Nenhuma das duas entra logada: quem se cadastra ainda precisa
        # verificar o e-mail, e quem tentou um endereco alheio nao ganha nada.
        self.assertNotIn('set-cookie',novo.headers); self.assertNotIn('set-cookie',existente.headers)
        # A recusa nao pode virar um oraculo sobre a conta alheia: so o aviso.
        self.assertEqual(set(existente.json()),{'detail'})
        # E a conta existente segue intacta -- nome, e nao 'Invasor'.
        self.assertEqual(self.b.users[1]['nome'],'Teste')

    def test_nome_e_url_ficam_texto_no_email(self):
        for name in ['<a/href=https://evil.example>clique</a>','<img/src=x/onerror=alert(1)>','Ana & João']:
            html=correio._html(name,'https://smartcharge.ia.br/?a=1&b="2"',24)
            self.assertNotIn(name,html)
            self.assertNotIn('<img/src=',html)
            self.assertIn('&amp;b=&quot;2&quot;',html)
        self.assertIn('Ana & João',correio._texto('Ana & João','https://smartcharge.ia.br',24))

    def test_fidelidade_motorista_funciona_e_loja_recusada(self):
        with patch.object(main,'consultar',return_value=[]):
            self.u['papel']='motorista'
            self.assertEqual(self.client.get('/fidelidade').status_code,200)
            self.u['papel']='gerente'
            self.assertEqual(self.client.get('/fidelidade').status_code,403)

    def test_contexto_da_ia_do_operador_redige_precos(self):
        bruto={'loja':{'nome':'Loja','segmento':'x','margem_liquida_pct':20,'ticket_medio_brl':30,'tarifa_kwh_brl':2,'demanda_contratada_kw':50},
               'carregadores':[{'nome':'C1','potencia_kw':10,'conector':'x','preco_kwh_brl':2,'cashback_pct':5,'taxa_ociosidade_min':1,'ativo':True}],
               'operacao':{'sessoes':1,'energia_kwh':4,'custo_energia_brl':7,'recarga_cobrada_brl':8,'cashback_brl':5,'clientes':1},
               'cupons':{'emitidos':1,'usados':1},'horarios_de_pico':[],'clientes_mais_frequentes':[{'visitas':3}],
               'precisao_da_previsao':None,'vendas':{'n':1,'total':30,'com_cupom':5}}
        self.b.context_payload=bruto
        with patch.object(main,'SQL_CONTEXTO','context'):
            ctx=main.contexto_da_loja(10,'operador')
        for key in ('tarifa_energia_brl_kwh','demanda_contratada_kw'): self.assertNotIn(key,ctx['loja'])
        for key in ('preco_kwh_brl','cashback_pct','taxa_ociosidade_min'): self.assertNotIn(key,ctx['carregadores'][0])
        for key in ('custo_energia_brl','recarga_cobrada_brl','cashback_brl'): self.assertNotIn(key,ctx['operacao'])


if __name__ == '__main__':
    unittest.main()
