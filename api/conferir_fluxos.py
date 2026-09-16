"""Confere se as funcionalidades realmente funcionam -- e se gravam.

A auditoria.py pergunta "isto esta protegido?". Esta aqui pergunta outra coisa:
"isto faz o que promete, e o que aconteceu ficou salvo?". Sao perguntas
diferentes, e um sistema pode passar numa e falhar na outra: uma rota pode
recusar direitinho quem nao tem sessao e mesmo assim nao gravar nada quando
quem tem sessao usa.

Por isso cada passo que escreve alguma coisa e conferido DUAS vezes: pela
resposta da API e por uma consulta ao banco. Acreditar so na resposta e como
conferir um deposito olhando o comprovante em vez do extrato.

    python api/conferir_fluxos.py                         # contra o local
    python api/conferir_fluxos.py https://smartcharge.ia.br

Precisa de DATABASE_URL e das senhas de teste no ambiente (as mesmas da
auditoria.py):

    SENHA_MAIN=...  SENHA_GERENTE=...  SENHA_OPERADOR=...

O motorista de teste e criado e APAGADO no fim, junto com tudo que ele gerou.
Nenhuma cobranca real e criada: a carteira e exercitada por leitura e por
lancamento direto, nunca chamando a Asaas, que esta em producao.
"""

from __future__ import annotations

import os
import secrets
import sys
from datetime import datetime, timedelta, timezone

import psycopg
import requests
from psycopg.rows import dict_row

API = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
BRASIL = timezone(timedelta(hours=-3))
TEMPO = 90

passou = falhou = 0
avisos: list[str] = []


def ok(nome: str, condicao: bool, detalhe: str = "") -> bool:
    global passou, falhou
    if condicao:
        passou += 1
        print(f"  ok   {nome:<52} {detalhe}")
    else:
        falhou += 1
        print(f"  XX   {nome:<52} {detalhe}")
    return condicao


def aviso(texto: str) -> None:
    avisos.append(texto)
    print(f"  ..   {texto}")


def secao(titulo: str) -> None:
    print(f"\n== {titulo} ==")


# UMA conexao para o teste inteiro, reaproveitada.
#
# A primeira versao abria uma conexao por consulta. Parecia inofensivo e nao
# era: o Aiven deste plano permite 20 conexoes no total, e uma rodada do teste
# chegou a segurar 18 ao mesmo tempo -- com o site de producao disputando as
# mesmas 20. Um teste que derruba o que veio testar nao serve.
_conexao = None


def banco():
    global _conexao
    if _conexao is None or _conexao.closed:
        _conexao = psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row,
                                   autocommit=True, application_name="conferir_fluxos")
    return _conexao


def uma(sql: str, *args):
    with banco().cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchone()


# ==========================================================================

def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("!! sem DATABASE_URL no ambiente")
        return 2

    marca = secrets.token_hex(4)
    email = f"conferencia+{marca}@smartcharge.ia.br"
    senha = "Conferencia!" + secrets.token_hex(6)
    motorista = requests.Session()
    lojista = requests.Session()
    usuario_id = None

    try:
        # ---------------------------------------------------------- saude
        secao("saude e configuracao")
        s = requests.get(f"{API}/saude", timeout=TEMPO).json()
        ok("a API responde e enxerga o banco", s.get("ok") and s.get("banco"),
           f"versao {s.get('versao')}")
        ok("o armazenamento tem todas as tabelas",
           not s["armazenamento"]["tabelas_ausentes"],
           str(s["armazenamento"]["tabelas_ausentes"] or "nenhuma faltando"))
        ok("verificacao de e-mail ligada", bool(s.get("verificacao_email")))
        cart = s.get("carteira", {})
        if cart.get("ambiente") == "indisponivel":
            aviso("Asaas nao configurado neste ambiente (normal fora do Render)")
        else:
            ok("pagamentos configurados", bool(cart.get("pix_configurado")),
               f"ambiente {cart.get('ambiente')}")
        if cart.get("ambiente") == "producao":
            aviso("Asaas em PRODUCAO: nenhuma cobranca sera criada por este teste")

        # ------------------------------------------------- cadastro + email
        secao("cadastro e confirmacao de e-mail")
        r = motorista.post(f"{API}/auth/cadastrar",
                           json={"nome": "Conferencia Automatica", "email": email,
                                 "senha": senha}, timeout=TEMPO)
        if r.status_code == 429:
            print("!! limite de cadastros atingido; espere uma hora e repita")
            return 2
        ok("cadastro aceito", r.status_code in (200, 201), f"HTTP {r.status_code}")

        linha = uma("SELECT id, papel, email_verificado FROM usuarios WHERE email=%s", email)
        ok("usuario GRAVADO no banco", linha is not None)
        if not linha:
            return 1
        usuario_id = linha["id"]
        ok("nasce como motorista", linha["papel"] == "motorista", linha["papel"])
        ok("nasce NAO verificado", linha["email_verificado"] is False)

        tok = uma("SELECT token, expira_em FROM verificacoes_email "
                  "WHERE usuario_id=%s ORDER BY criado_em DESC LIMIT 1", usuario_id)
        ok("token de confirmacao gravado", tok is not None)
        ok("token com prazo no futuro", tok and tok["expira_em"] > datetime.now(timezone.utc),
           str(tok["expira_em"]) if tok else "")

        r = motorista.post(f"{API}/auth/verificar", json={"token": tok["token"]}, timeout=TEMPO)
        ok("confirmacao aceita", r.status_code == 200, f"HTTP {r.status_code}")
        ok("e-mail marcado como verificado NO BANCO",
           uma("SELECT email_verificado v FROM usuarios WHERE id=%s", usuario_id)["v"] is True)
        # O token nao e marcado como usado: a linha e REMOVIDA. Some da tabela
        # e nao pode voltar -- e a forma mais simples de "usado uma vez so".
        ok("token consumido (linha removida)",
           uma("SELECT token FROM verificacoes_email WHERE token=%s", tok["token"]) is None)

        r = motorista.post(f"{API}/auth/verificar", json={"token": tok["token"]}, timeout=TEMPO)
        ok("o mesmo token nao serve duas vezes", r.status_code in (404, 410),
           f"HTTP {r.status_code}")

        outro = requests.Session()
        r = outro.post(f"{API}/auth/cadastrar",
                       json={"nome": "Outro", "email": email, "senha": senha}, timeout=TEMPO)
        ok("e-mail repetido e recusado", r.status_code == 409, f"HTTP {r.status_code}")

        # ------------------------------------------------------- sessao
        secao("sessao do motorista")
        r = motorista.get(f"{API}/auth/eu", timeout=TEMPO)
        ok("sessao aberta pela confirmacao", r.status_code == 200, f"HTTP {r.status_code}")
        eu = r.json().get("usuario", {})
        ok("a sessao e do usuario certo", eu.get("email") == email)
        ok("com o papel certo", eu.get("papel") == "motorista")

        # ------------------------------------------------------ carteira
        secao("carteira")
        c = motorista.get(f"{API}/carteira", timeout=TEMPO)
        ok("carteira responde", c.status_code == 200, f"HTTP {c.status_code}")
        dados = c.json()
        ok("comeca zerada", float(dados.get("saldo_brl", -1)) == 0.0,
           f"R$ {dados.get('saldo_brl')}")

        r = motorista.post(f"{API}/carteira/pix",
                           json={"valor": "5.00", "forma": "cheque"}, timeout=TEMPO)
        ok("forma de pagamento invalida e recusada", r.status_code == 422, f"HTTP {r.status_code}")
        # Forma ausente vira Pix de proposito: e o que mantem funcionando uma
        # tela aberta antes de o cartao existir.
        #
        # Nao da para conferir isso pelo codigo de status. Sem `forma`, o pedido
        # passa da validacao e segue ate a Asaa, que exige CPF para criar o
        # cliente -- e o 422 que volta e sobre o CPF, nao sobre a forma. Mandar
        # um CPF de verdade so para o teste passar criaria cadastro na conta de
        # producao deles. Entao o que se confere e a MENSAGEM: seja qual for a
        # recusa, ela nao pode ser a de forma invalida.
        r = motorista.post(f"{API}/carteira/pix", json={"valor": "5.00"}, timeout=TEMPO)
        ok("sem forma, nao reclama da forma (assume Pix)",
           "pix, boleto ou cart" not in r.text.lower(),
           f"HTTP {r.status_code} · {r.text[:60]}")

        # Credita direto no banco: e o mesmo caminho que o webhook usa, e evita
        # criar cobranca real na Asaas so para ter saldo de teste.
        with banco().cursor() as cur:
            cur.execute("INSERT INTO carteira_lancamentos "
                        "(usuario_id,tipo,valor_brl,descricao,referencia) "
                        "VALUES (%s,'credito_teste',50,'Conferencia automatica',%s)",
                        (usuario_id, f"conferencia:{marca}"))
        saldo = motorista.get(f"{API}/carteira", timeout=TEMPO).json()
        ok("saldo reflete o lancamento", float(saldo["saldo_brl"]) == 50.0,
           f"R$ {saldo['saldo_brl']}")
        ok("o lancamento aparece no extrato",
           any(m.get("referencia") == f"conferencia:{marca}" or "Conferencia" in str(m.get("descricao", ""))
               for m in saldo.get("lancamentos", saldo.get("movimentos", []))),
           f"{len(saldo.get('lancamentos', saldo.get('movimentos', [])))} movimento(s)")

        # --------------------------------------------------- mapa e reserva
        secao("mapa e reserva")
        r = requests.get(f"{API}/mapa/pontos", timeout=TEMPO)
        ok("mapa responde sem login", r.status_code == 200, f"HTTP {r.status_code}")
        pontos = r.json().get("pontos", r.json() if isinstance(r.json(), list) else [])
        ok("ha pontos no mapa", len(pontos) > 0, f"{len(pontos)} ponto(s)")

        vaga = uma("SELECT c.id, c.nome, e.nome loja FROM carregadores c "
                   "JOIN estabelecimentos e ON e.id=c.estabelecimento_id "
                   "WHERE c.ativo AND e.ativo ORDER BY c.id LIMIT 1")
        ok("ha vaga ativa para reservar", vaga is not None,
           f"{vaga['loja']} / {vaga['nome']}" if vaga else "")

        reserva_id = None
        if vaga:
            inicio = (datetime.now(BRASIL) + timedelta(hours=3)).replace(
                minute=0, second=0, microsecond=0)
            r = motorista.post(f"{API}/reservas",
                               json={"carregador_id": vaga["id"], "inicio": inicio.isoformat()},
                               timeout=TEMPO)
            ok("reserva criada", r.status_code in (200, 201), f"HTTP {r.status_code} {r.text[:80]}")
            if r.status_code in (200, 201):
                reserva_id = r.json().get("id") or r.json().get("reserva", {}).get("id")
                linha = uma("SELECT * FROM reservas WHERE usuario_id=%s ORDER BY id DESC LIMIT 1",
                            usuario_id)
                ok("reserva GRAVADA no banco", linha is not None,
                   f"situacao {linha['situacao']}" if linha else "")
                reserva_id = reserva_id or (linha["id"] if linha else None)

                deb = uma("SELECT valor_brl, tipo FROM carteira_lancamentos "
                          "WHERE usuario_id=%s AND tipo='reserva' ORDER BY id DESC LIMIT 1",
                          usuario_id)
                ok("a reserva DEBITOU a carteira", deb is not None and deb["valor_brl"] < 0,
                   f"R$ {deb['valor_brl']}" if deb else "nao debitou")

                saldo2 = float(motorista.get(f"{API}/carteira", timeout=TEMPO).json()["saldo_brl"])
                ok("saldo caiu de verdade", saldo2 < 50.0, f"R$ {saldo2}")

                r = motorista.get(f"{API}/reservas", timeout=TEMPO)
                lista = r.json().get("reservas", [])
                ok("a reserva aparece na lista do motorista",
                   any(x.get("id") == reserva_id for x in lista), f"{len(lista)} reserva(s)")

                # dobradinha: a mesma vaga, no mesmo horario, para outra pessoa
                r = motorista.post(f"{API}/reservas",
                                   json={"carregador_id": vaga["id"], "inicio": inicio.isoformat()},
                                   timeout=TEMPO)
                ok("a mesma vaga no mesmo horario e recusada",
                   r.status_code in (409, 422, 429), f"HTTP {r.status_code}")

                r = motorista.post(f"{API}/reservas/{reserva_id}/cancelar", json={}, timeout=TEMPO)
                ok("cancelamento aceito", r.status_code == 200, f"HTTP {r.status_code}")
                ok("situacao virou cancelada no banco",
                   uma("SELECT situacao FROM reservas WHERE id=%s", reserva_id)["situacao"] == "cancelada")
                est = uma("SELECT valor_brl FROM carteira_lancamentos WHERE usuario_id=%s "
                          "AND tipo='estorno_reserva' ORDER BY id DESC LIMIT 1", usuario_id)
                ok("o cancelamento DEVOLVEU o valor", est is not None and est["valor_brl"] > 0,
                   f"R$ {est['valor_brl']}" if est else "nao devolveu")
                saldo3 = float(motorista.get(f"{API}/carteira", timeout=TEMPO).json()["saldo_brl"])
                ok("saldo voltou ao que era", saldo3 == 50.0, f"R$ {saldo3}")

        # ---------------------------------------------------- fidelidade
        secao("fidelidade")
        r = motorista.get(f"{API}/fidelidade", timeout=TEMPO)
        ok("fidelidade responde", r.status_code == 200, f"HTTP {r.status_code}")
        ok("devolve lista", isinstance(r.json(), list), f"{len(r.json())} item(ns)")

        # ------------------------------------------- isolamento de papel
        secao("o motorista nao entra no lado do lojista")
        for rota in ("/dados?estabelecimento_id=1", "/paineis?estabelecimento_id=1"):
            r = motorista.get(f"{API}{rota}", timeout=TEMPO)
            ok(f"motorista barrado em {rota.split('?')[0]}", r.status_code in (401, 403),
               f"HTTP {r.status_code}")
        # /perfil NAO e do lojista: e "quem sou eu". Um motorista ver o proprio
        # perfil e o esperado. O que precisa ser conferido nao e se abre, e sim
        # se vem vazio de coisa que nao e dele.
        r = motorista.get(f"{API}/perfil", timeout=TEMPO)
        ok("motorista abre o proprio perfil", r.status_code == 200, f"HTTP {r.status_code}")
        if r.status_code == 200:
            perf = r.json()
            ok("o perfil dele nao lista loja nenhuma",
               perf.get("estabelecimentos") == [],
               str(perf.get("estabelecimentos"))[:40])
            ok("nem permissao de lojista",
               not (perf.get("permissoes") or {}).get("editar_dados"),
               str(perf.get("permissoes"))[:60])

        # ------------------------------------------------------- lojista
        secao("lado do lojista")
        senha_gerente = os.environ.get("SENHA_GERENTE")
        if not senha_gerente:
            aviso("sem SENHA_GERENTE: o lado do lojista nao foi exercitado")
        else:
            g = uma("SELECT email FROM usuarios WHERE papel='gerente' ORDER BY id LIMIT 1")
            r = lojista.post(f"{API}/auth/login",
                             json={"email": g["email"], "senha": senha_gerente}, timeout=TEMPO)
            entrou = ok("gerente entra", r.status_code == 200, f"HTTP {r.status_code}")

            if entrou:
                est = uma("SELECT e.id, e.nome FROM estabelecimentos e "
                          "JOIN usuarios_estabelecimentos ue ON ue.estabelecimento_id=e.id "
                          "JOIN usuarios u ON u.id=ue.usuario_id "
                          "WHERE u.email=%s ORDER BY e.id LIMIT 1", g["email"])
                r = lojista.get(f"{API}/dados?estabelecimento_id={est['id']}", timeout=TEMPO)
                ok("painel carrega os dados da loja", r.status_code == 200,
                   f"HTTP {r.status_code} · {est['nome']}")
                if r.status_code == 200:
                    d = r.json()
                    ok("os dados trazem as secoes esperadas",
                       all(k in d for k in ("carregadores", "sessoes")),
                       ", ".join(sorted(d.keys()))[:60])

                r = lojista.get(f"{API}/paineis?estabelecimento_id={est['id']}", timeout=TEMPO)
                ok("paineis respondem", r.status_code == 200, f"HTTP {r.status_code}")

                r = lojista.get(f"{API}/perfil", timeout=TEMPO)
                ok("perfil responde", r.status_code == 200, f"HTTP {r.status_code}")

                # Escrita de verdade, com volta: cria, confere no banco, apaga.
                # A tabela escolhida e `clientes` porque e por onde passa a
                # ponte entre os dois lados -- e e essa ponte, e nao o CRUD,
                # que interessa conferir.
                apelido = f"Conferencia {marca}"
                r = lojista.post(f"{API}/registros/clientes",
                                 json={"estabelecimento_id": est["id"], "apelido": apelido,
                                       "modelo_veiculo": "Teste EV", "consentimento_lgpd": True},
                                 timeout=TEMPO)
                criou = r.status_code in (200, 201)
                ok("lojista CRIA cliente", criou, f"HTTP {r.status_code} {r.text[:70]}")
                if criou:
                    cliente_id = r.json().get("id")
                    ok("cliente GRAVADO no banco",
                       uma("SELECT id FROM clientes WHERE id=%s", cliente_id) is not None,
                       f"#{cliente_id}")

                    r = lojista.patch(f"{API}/registros/clientes/{cliente_id}",
                                      json={"modelo_veiculo": "Teste EV 2"}, timeout=TEMPO)
                    ok("lojista ALTERA cliente", r.status_code == 200, f"HTTP {r.status_code}")
                    ok("alteracao GRAVADA no banco",
                       uma("SELECT modelo_veiculo m FROM clientes WHERE id=%s",
                           cliente_id)["m"] == "Teste EV 2")

                    # ---- a ponte: a ficha da loja passa a apontar para a conta
                    secao("ponte lojista -> motorista")
                    r = lojista.post(f"{API}/registros/clientes/{cliente_id}/vincular",
                                     json={"email": email}, timeout=TEMPO)
                    ok("lojista vincula a ficha a conta do motorista",
                       r.status_code == 200, f"HTTP {r.status_code} {r.text[:70]}")
                    ok("vinculo GRAVADO no banco",
                       uma("SELECT usuario_id FROM clientes WHERE id=%s",
                           cliente_id)["usuario_id"] == usuario_id)

                    r = lojista.post(f"{API}/registros/clientes/{cliente_id}/vincular",
                                     json={"email": "nao-existe-jamais@exemplo.invalido"},
                                     timeout=TEMPO)
                    ok("vincular a e-mail inexistente e recusado",
                       r.status_code == 404, f"HTTP {r.status_code}")

                    # ---- a venda que vira fidelidade do outro lado
                    antes_fid = uma("SELECT fidelidade_saldo_cashback_brl c, fidelidade_creditos k,"
                                    " fidelidade_compras_mes m FROM clientes WHERE id=%s", cliente_id)
                    r = lojista.post(f"{API}/registros/vendas",
                                     json={"estabelecimento_id": est["id"],
                                           "cliente_id": cliente_id, "valor_brl": 100},
                                     timeout=TEMPO)
                    vendeu = r.status_code in (200, 201)
                    ok("lojista REGISTRA venda", vendeu, f"HTTP {r.status_code} {r.text[:70]}")
                    venda_id = r.json().get("id") if vendeu else None
                    if vendeu:
                        ok("venda GRAVADA no banco",
                           uma("SELECT id FROM vendas WHERE id=%s", venda_id) is not None,
                           f"#{venda_id}")
                        dep = uma("SELECT fidelidade_saldo_cashback_brl c, fidelidade_creditos k,"
                                  " fidelidade_compras_mes m FROM clientes WHERE id=%s", cliente_id)
                        mudou = any(dep[x] != antes_fid[x] for x in ("c", "k", "m"))
                        ok("a venda APLICOU fidelidade na ficha", mudou,
                           f"cashback {antes_fid['c']}->{dep['c']}  creditos "
                           f"{antes_fid['k']}->{dep['k']}  compras {antes_fid['m']}->{dep['m']}")

                        # e agora o outro lado enxerga
                        r = motorista.get(f"{API}/fidelidade", timeout=TEMPO)
                        itens = r.json() if r.status_code == 200 else []
                        achou = any(i.get("estabelecimento_nome") == est["nome"] for i in itens)
                        ok("o MOTORISTA ve a fidelidade na conta dele", achou,
                           f"{len(itens)} item(ns): "
                           + ", ".join(str(i.get("estabelecimento_nome")) for i in itens)[:40])

                    # limpeza deste trecho
                    with banco().cursor() as cur:
                        if venda_id:
                            cur.execute("DELETE FROM vendas WHERE id=%s", (venda_id,))
                        cur.execute("UPDATE clientes SET usuario_id=NULL WHERE id=%s", (cliente_id,))
                    r = lojista.delete(f"{API}/registros/clientes/{cliente_id}", timeout=TEMPO)
                    ok("lojista APAGA cliente", r.status_code in (200, 204),
                       f"HTTP {r.status_code}")
                    ok("exclusao GRAVADA no banco",
                       uma("SELECT id FROM clientes WHERE id=%s", cliente_id) is None)

                r = lojista.get(f"{API}/carteira", timeout=TEMPO)
                ok("lojista NAO entra na carteira do motorista",
                   r.status_code in (401, 403), f"HTTP {r.status_code}")

        # ------------------------------------------------------- logout
        secao("sair")
        r = motorista.post(f"{API}/auth/logout", timeout=TEMPO)
        ok("logout aceito", r.status_code == 200, f"HTTP {r.status_code}")
        r = motorista.get(f"{API}/auth/eu", timeout=TEMPO)
        ok("a sessao morreu no servidor", r.status_code == 401, f"HTTP {r.status_code}")

    finally:
        # ------------------------------------------------------- limpeza
        secao("limpeza")
        if usuario_id:
            for tabela in ("carteira_lancamentos", "carteira_pix", "reservas",
                           "verificacoes_email", "sessoes_web", "carteiras"):
                try:
                    with banco().cursor() as cur:
                        cur.execute(f"DELETE FROM {tabela} WHERE usuario_id=%s", (usuario_id,))
                except psycopg.Error as e:
                    aviso(f"limpeza de {tabela}: {e}")
            with banco().cursor() as cur:
                cur.execute("DELETE FROM usuarios WHERE id=%s", (usuario_id,))
            sobrou = uma("SELECT id FROM usuarios WHERE id=%s", usuario_id)
            ok("motorista de teste removido", sobrou is None, f"#{usuario_id}")
        try:
            lojista.post(f"{API}/auth/logout", timeout=TEMPO)
        except requests.RequestException:
            pass
        if _conexao is not None and not _conexao.closed:
            _conexao.close()

    print("\n" + "=" * 74)
    for a in avisos:
        print(f"  aviso: {a}")
    print(f"{passou} de {passou + falhou} passaram"
          + (f"  ({falhou} FALHARAM)" if falhou else ""))
    return 1 if falhou else 0


if __name__ == "__main__":
    sys.exit(main())
