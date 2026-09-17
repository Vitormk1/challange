"""Cria (ou atualiza) duas lojas de teste da fidelidade e a conta que as usa.

Ao contrário de seed.py, este script NUNCA apaga nada: só insere o que falta
e atualiza o que já existe, pelo nome da loja e pelo e-mail da conta. É
seguro rodar contra o banco de produção quantas vezes for preciso — inclusive
de novo, se os valores de exemplo mudarem.

Cria:
  - "Loja Teste — Tiers": fidelidade por tiers, com a ficha da conta de teste
    já em 4 compras no mês (acima do limiar de 3, mostra o desconto máximo).
  - "Loja Teste — Créditos": fidelidade por créditos, com 7 créditos já
    acumulados na ficha da conta de teste.
  - a conta motorista cliente1@teste.com, com e-mail já verificado (é conta
    de teste, não alguém que vai clicar num link), ligada às duas fichas
    acima — é o que a área do cliente usa para achar o que mostrar na caixa
    "Fidelidade por loja".

    python api/seed_fidelidade_teste.py            # pede confirmação
    python api/seed_fidelidade_teste.py --sim       # não pede
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import string
import sys

from auth import criar_hash
from db import conectar

EMAIL_CLIENTE_TESTE = "cliente1@teste.com"

# (nome, tipo, desconto inicial %, a partir da compra nº, desconto topo %,
#  reais por crédito, minutos por crédito, compras no mês, créditos)
LOJAS_TESTE = [
    ("Loja Teste — Tiers",    "tiers",    5.0, 3, 15.0, None, None, 4, 0),
    ("Loja Teste — Créditos", "creditos", None, None, None, 25.0, 15.0, 0, 7),
]

VEICULO, BATERIA_KWH = "BYD Dolphin Mini", 38.0


def _sortear_senha(tamanho: int = 14) -> str:
    alfabeto = string.ascii_letters + string.digits
    return "".join(secrets.choice(alfabeto) for _ in range(tamanho))


def _onde_vai_escrever() -> str:
    """O host do banco, sem a senha — só para reconhecer o alvo antes de escrever."""
    url = os.environ.get("DATABASE_URL", "")
    m = re.search(r"@([^/?]+)", url)
    return m.group(1) if m else "(DATABASE_URL não definida)"


def _confirmar() -> bool:
    alvo = _onde_vai_escrever()
    if "--sim" in sys.argv:
        print(f"escrevendo em: {alvo}")
        return True
    print("Este script cria/atualiza 2 lojas de teste e a conta "
          f"{EMAIL_CLIENTE_TESTE} em:")
    print(f"   {alvo}")
    print("Não apaga nem altera nenhum outro dado.")
    if not sys.stdin.isatty():
        print("Sem terminal para confirmar. Rode de novo com --sim se é isso mesmo.")
        return False
    try:
        return input("Continuar? (sim/não): ").strip().lower() in ("sim", "s")
    except EOFError:
        print("Sem resposta. Recusado.")
        return False


def semear_fidelidade_teste() -> dict:
    """Faz o trabalho e devolve um resumo — quem chama decide como mostrar
    (print no terminal, JSON numa rota). Não imprime nada aqui de propósito:
    a rota /admin/seed-fidelidade-teste em main.py chama isto direto."""
    with conectar() as con, con.cursor() as cur:
        estab_ids = []
        for nome, tipo, ini, limiar, topo, reais, minutos, _, _ in LOJAS_TESTE:
            cur.execute("SELECT id FROM estabelecimentos WHERE nome = %s", (nome,))
            linha = cur.fetchone()
            if linha:
                estab_id = linha["id"]
                cur.execute(
                    "UPDATE estabelecimentos SET fidelidade_tipo = %s, "
                    "fidelidade_tiers_desconto_inicial_pct = %s, "
                    "fidelidade_tiers_a_partir_da_compra = %s, "
                    "fidelidade_tiers_desconto_top_pct = %s, "
                    "fidelidade_creditos_reais_por_credito = %s, "
                    "fidelidade_creditos_minutos_por_credito = %s "
                    "WHERE id = %s",
                    (tipo, ini, limiar, topo, reais, minutos, estab_id))
            else:
                cur.execute(
                    "INSERT INTO estabelecimentos "
                    "(nome, segmento, margem_liquida_pct, ticket_medio_brl, tarifa_kwh_brl, "
                    " fidelidade_tipo, fidelidade_tiers_desconto_inicial_pct, "
                    " fidelidade_tiers_a_partir_da_compra, fidelidade_tiers_desconto_top_pct, "
                    " fidelidade_creditos_reais_por_credito, fidelidade_creditos_minutos_por_credito) "
                    "VALUES (%s,'outro',15.0,50.0,0.7890, %s,%s,%s,%s,%s,%s) "
                    "RETURNING id",
                    (nome, tipo, ini, limiar, topo, reais, minutos))
                estab_id = cur.fetchone()["id"]
            estab_ids.append(estab_id)

        cur.execute("SELECT id, papel FROM usuarios WHERE lower(email) = lower(%s)",
                     (EMAIL_CLIENTE_TESTE,))
        linha = cur.fetchone()
        senha_nova = None
        if linha:
            if linha["papel"] != "motorista":
                raise SystemExit(f"{EMAIL_CLIENTE_TESTE} já existe, mas não é conta de "
                                  f"motorista (é '{linha['papel']}'). Nada foi alterado.")
            cliente_id = linha["id"]
        else:
            senha_nova = _sortear_senha()
            cur.execute(
                "INSERT INTO usuarios (nome, email, papel, senha_hash, email_verificado) "
                "VALUES (%s,%s,'motorista',%s,true) RETURNING id",
                ("Cliente Teste", EMAIL_CLIENTE_TESTE, criar_hash(senha_nova)))
            cliente_id = cur.fetchone()["id"]

        for estab_id, (nome, _, _, _, _, _, _, compras_mes, creditos) in zip(estab_ids, LOJAS_TESTE):
            hash_ficha = hashlib.sha256(f"{estab_id}-cliente-teste".encode()).hexdigest()[:32]
            cur.execute(
                "INSERT INTO clientes (estabelecimento_id, identificador_hash, apelido, "
                " modelo_veiculo, bateria_kwh, consentimento_lgpd, usuario_id, "
                " fidelidade_compras_mes, fidelidade_creditos) "
                "VALUES (%s,%s,'Cliente Teste',%s,%s,true,%s,%s,%s) "
                "ON CONFLICT (estabelecimento_id, identificador_hash) DO UPDATE SET "
                "  usuario_id = excluded.usuario_id, "
                "  fidelidade_compras_mes = excluded.fidelidade_compras_mes, "
                "  fidelidade_creditos = excluded.fidelidade_creditos",
                (estab_id, hash_ficha, VEICULO, BATERIA_KWH, cliente_id, compras_mes, creditos))
        con.commit()

    return {
        "lojas": [nome for nome, *_ in LOJAS_TESTE],
        "email": EMAIL_CLIENTE_TESTE,
        "senha_nova": senha_nova,
        "conta": "criada" if senha_nova else "já existia (fichas atualizadas)",
    }


if __name__ == "__main__":
    if not _confirmar():
        print("cancelado, nada foi tocado")
        raise SystemExit(1)
    resumo = semear_fidelidade_teste()
    print(f"lojas: {', '.join(resumo['lojas'])}")
    if resumo["senha_nova"]:
        print(f"conta criada: {resumo['email']} / {resumo['senha_nova']}")
    else:
        print(f"conta já existia: {resumo['email']} (senha mantida, fichas atualizadas)")
