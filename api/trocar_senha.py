"""Troca a senha de um usuário.

As senhas do seed viram senhas de internet no momento em que a API fica
pública. Este script existe para trocá-las sem editar o seed nem recriar o
banco.

    python api/trocar_senha.py vitor@pracaderecarga.local
    python api/trocar_senha.py --todos

A senha é digitada, nunca passada como argumento: argumento fica no histórico
do terminal e aparece na lista de processos.
"""

from __future__ import annotations

import getpass
import secrets
import string
import sys

from auth import criar_hash
from db import conectar


def sortear(tamanho: int = 14) -> str:
    alfabeto = string.ascii_letters + string.digits
    return "".join(secrets.choice(alfabeto) for _ in range(tamanho))


def trocar(email: str, senha: str) -> bool:
    with conectar() as con, con.cursor() as cur:
        cur.execute("UPDATE usuarios SET senha_hash = %s WHERE lower(email) = lower(%s) "
                    "RETURNING nome, papel", (criar_hash(senha), email))
        linha = cur.fetchone()
        if linha:
            con.commit()
            print(f"  {email:<34} {linha['nome']} ({linha['papel']})")
        return bool(linha)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)

    if sys.argv[1] == "--todos":
        with conectar() as con, con.cursor() as cur:
            cur.execute("SELECT email FROM usuarios WHERE ativo ORDER BY id")
            emails = [l["email"] for l in cur.fetchall()]
        print(f"Sorteando senha nova para {len(emails)} usuário(s).")
        print("Anote agora — o banco guarda o hash, não dá para consultar depois.\n")
        for email in emails:
            senha = sortear()
            trocar(email, senha)
            print(f"  {'':34} senha: {senha}\n")
        return

    email = sys.argv[1]
    senha = getpass.getpass(f"Senha nova para {email}: ")
    if len(senha) < 8:
        raise SystemExit("Senha curta demais. Use pelo menos 8 caracteres.")
    if senha != getpass.getpass("Repita: "):
        raise SystemExit("As duas não bateram.")
    if not trocar(email, senha):
        raise SystemExit(f"Não existe usuário ativo com o e-mail {email}.")
    print("Trocada. As sessões abertas continuam valendo até expirar;")
    print("para derrubar todas: DELETE FROM sessoes_web WHERE usuario_id = ...")


if __name__ == "__main__":
    main()
