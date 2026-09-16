"""Cria (ou refaz) a conta de demonstracao usada nos prints do site.

Os prints da secao "Do outro lado do carregador" em docs/painel/index.html sao
telas reais. Para serem reais e nao mockup, precisam de uma conta com dados
dentro -- e nao pode ser a conta de ninguem: os prints vao para uma pagina
publica, e levariam junto o e-mail e o saldo de verdade da pessoa.

    python api/semear_demo.py            # cria e imprime o token de sessao
    python api/semear_demo.py --apagar   # remove tudo que este script criou

Para refazer os prints depois de mexer nas telas:

    python api/semear_demo.py
    # com o servidor local no ar, para cada tela (cliente, mapa, carteira,
    # ajustes), abra-a com o cookie `praca_sessao` igual ao token impresso e
    # capture em 504 de largura -- que e o minimo que o Chrome headless aceita
    # no Windows. Depois reduza para 756 de largura em JPEG.
    python api/semear_demo.py --apagar

A sessao e criada direto no banco, e nao por login. Nao e so conveniencia:
evita ter a senha de alguem em qualquer lugar do processo.
"""

from __future__ import annotations

import os
import secrets
import sys
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

from auth import criar_hash

BRASIL = timezone(timedelta(hours=-3))
EMAIL = "demonstracao@smartcharge.ia.br"
NOME = "Ana Souza"


def conectar():
    return psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row, autocommit=True)


def apagar(cur) -> int | None:
    cur.execute("SELECT id FROM usuarios WHERE email = %s", (EMAIL,))
    achado = cur.fetchone()
    if not achado:
        return None
    uid = achado["id"]
    for tabela in ("carteira_lancamentos", "carteira_pix", "reservas",
                   "verificacoes_email", "sessoes_web", "carteiras"):
        cur.execute(f"DELETE FROM {tabela} WHERE usuario_id = %s", (uid,))
    # A ficha de cliente pertence a loja, nao a conta: some o vinculo, fica a ficha.
    cur.execute("UPDATE clientes SET usuario_id = NULL WHERE usuario_id = %s", (uid,))
    cur.execute("DELETE FROM clientes WHERE apelido = 'Ana' AND usuario_id IS NULL")
    cur.execute("DELETE FROM usuarios WHERE id = %s", (uid,))
    return uid


def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("!! sem DATABASE_URL no ambiente")
        return 2

    with conectar() as con, con.cursor() as cur:
        if "--apagar" in sys.argv:
            uid = apagar(cur)
            print(f"  removido: #{uid}" if uid else "  nao havia conta de demonstracao")
            return 0

        apagar(cur)
        cur.execute("INSERT INTO usuarios (nome, email, papel, senha_hash, ativo, email_verificado) "
                    "VALUES (%s, %s, 'motorista', %s, true, true) RETURNING id",
                    (NOME, EMAIL, criar_hash("Demo!" + secrets.token_hex(12))))
        uid = cur.fetchone()["id"]
        print(f"  motorista #{uid}  {NOME}")

        # Um extrato com historia: entrou por Pix e por cartao, reservou,
        # desistiu a tempo, e pagou uma recarga. Sem isso a carteira aparece
        # vazia no print, que e o contrario do que a secao quer mostrar.
        agora = datetime.now(BRASIL)
        for tipo, valor, desc, dias in (
                ("recarga_pix", 120, "Saldo adicionado via Pix", 9),
                ("recarga_cartao", 80, "Saldo adicionado via cartao", 4),
                ("reserva", -10, "Reserva de vaga", 2),
                ("estorno_reserva", 10, "Reserva cancelada a tempo", 2),
                ("pagamento_recarga", -46.30, "Recarga no Pet & Cia Vila Mariana", 1)):
            cur.execute("INSERT INTO carteira_lancamentos "
                        "(usuario_id, tipo, valor_brl, descricao, referencia, criado_em) "
                        "VALUES (%s, %s, %s, %s, %s, %s)",
                        (uid, tipo, valor, desc, f"demo:{uid}:{secrets.token_hex(6)}",
                         agora - timedelta(days=dias)))
        cur.execute("SELECT sum(valor_brl) AS s FROM carteira_lancamentos WHERE usuario_id = %s", (uid,))
        print(f"  saldo: R$ {cur.fetchone()['s']}")

        # Uma reserva para amanha, para o Dashboard nao aparecer vazio.
        cur.execute("SELECT c.id, c.nome FROM carregadores c "
                    "  JOIN estabelecimentos e ON e.id = c.estabelecimento_id "
                    " WHERE c.ativo AND e.ativo ORDER BY c.id LIMIT 1")
        vaga = cur.fetchone()
        inicio = (agora + timedelta(days=1)).replace(hour=14, minute=0, second=0, microsecond=0)
        cur.execute("INSERT INTO reservas (usuario_id, carregador_id, inicio, fim, situacao, valor_brl) "
                    "VALUES (%s, %s, %s, %s, 'ativa', 10)",
                    (uid, vaga["id"], inicio, inicio + timedelta(hours=1)))
        print(f"  reserva em {vaga['nome']} para {inicio:%d/%m %H:%M}")

        # Fidelidade: uma ficha de loja com cashback, ligada a conta.
        cur.execute("SELECT id FROM estabelecimentos ORDER BY id LIMIT 1")
        loja = cur.fetchone()["id"]
        cur.execute("INSERT INTO clientes (estabelecimento_id, identificador_hash, apelido, "
                    "  modelo_veiculo, consentimento_lgpd, usuario_id, fidelidade_saldo_cashback_brl) "
                    "VALUES (%s, %s, 'Ana', 'Fiat E-Pulse', true, %s, 18.40)",
                    (loja, secrets.token_hex(16), uid))
        print("  fidelidade: R$ 18,40 numa loja parceira")

        token = secrets.token_urlsafe(32)
        cur.execute("INSERT INTO sessoes_web (token, usuario_id, expira_em, agente) "
                    "VALUES (%s, %s, %s, 'prints da apresentacao')",
                    (token, uid, datetime.now(timezone.utc) + timedelta(hours=6)))
        print(f"\n  cookie:  praca_sessao={token}")
        print("  (vale 6 horas; rode com --apagar quando terminar)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
