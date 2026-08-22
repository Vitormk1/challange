"""Senhas, sessões de login e o que cada papel pode fazer.

A senha nunca é guardada. O que vai para o banco é um `scrypt` com sal
próprio por usuário — se o banco vazar, as senhas não vêm junto. O `scrypt`
está na biblioteca padrão do Python; não vale a pena arrastar uma dependência
a mais para isso.

As três permissões que o painel inteiro consulta estão em PERMISSOES. Elas
são conferidas no servidor, sempre. Esconder um botão na tela é conforto para
quem usa, não segurança: quem quiser mandar a requisição na mão manda.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

# scrypt: parâmetros do RFC 7914 para uso interativo
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1
DIAS_DE_SESSAO = 14


# ---------------------------------------------------------------- senhas ---
def criar_hash(senha: str) -> str:
    sal = os.urandom(16)
    chave = hashlib.scrypt(senha.encode(), salt=sal, n=SCRYPT_N, r=SCRYPT_R,
                           p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${sal.hex()}${chave.hex()}"


def conferir_senha(senha: str, guardado: str | None) -> bool:
    if not guardado or not guardado.startswith("scrypt$"):
        return False
    try:
        _, n, r, p, sal, esperado = guardado.split("$")
        chave = hashlib.scrypt(senha.encode(), salt=bytes.fromhex(sal),
                               n=int(n), r=int(r), p=int(p), dklen=32)
    except (ValueError, TypeError):
        return False
    # comparação de tempo constante: comparar com == vaza o tamanho do acerto
    return hmac.compare_digest(chave.hex(), esperado)


# --------------------------------------------------------------- sessões ---
def novo_token() -> str:
    return secrets.token_urlsafe(32)


def validade() -> datetime:
    return datetime.now(timezone.utc) + timedelta(days=DIAS_DE_SESSAO)


# -------------------------------------------------------------- permissões ---
# Uma linha por papel, e é isto que o servidor confere em toda requisição.
PERMISSOES = {
    "main": {
        "trocar_estabelecimento": True,   # é quem desenvolve; vê todas as lojas
        "editar_dados": True,
        "ver_financeiro": True,
        "editar_painel_compartilhado": True,
        "gerir_usuarios": True,
    },
    "gerente": {
        "trocar_estabelecimento": False,  # só existe a loja dele
        "editar_dados": True,
        "ver_financeiro": True,
        "editar_painel_compartilhado": True,
        "gerir_usuarios": True,
    },
    "operador": {
        "trocar_estabelecimento": False,
        "editar_dados": False,            # vê tudo, não altera nada
        "ver_financeiro": False,          # o resultado da loja não é da conta dele
        "editar_painel_compartilhado": False,
        "gerir_usuarios": False,
    },
}

# Seções que cada papel enxerga. O operador não recebe "financeiro" — nem a
# seção, nem os números que a alimentam.
SECOES_BLOQUEADAS = {"operador": {"financeiro"}}


def permissoes(papel: str) -> dict:
    return dict(PERMISSOES.get(papel, PERMISSOES["operador"]))


def pode(papel: str, acao: str) -> bool:
    return bool(permissoes(papel).get(acao))


def secoes_bloqueadas(papel: str) -> set[str]:
    return set(SECOES_BLOQUEADAS.get(papel, ()))
