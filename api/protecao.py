"""Limite de tentativas e cabeçalhos de segurança.

Duas coisas que só passaram a importar quando a API foi para a internet:

1. **Força bruta no login.** Sem limite, 12 tentativas levavam 7,8 segundos —
   dá para varrer um dicionário inteiro. O `scrypt` protege as senhas se o
   banco vazar, mas não impede ninguém de adivinhar pela porta da frente.

2. **Cabeçalhos.** Agora que este processo serve HTML, e não só JSON, o
   navegador precisa ser instruído sobre o que a página pode carregar.

A contagem é em memória, e isso é uma escolha consciente: o serviço roda com
um worker só (ver render.yaml), então um dicionário basta e não exige Redis.
Se um dia forem dois workers, cada um contará o seu — e aí o limite efetivo
dobra. Está anotado aqui para não virar surpresa.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware

# (tentativas, janela em segundos)
#
# Os dois limites têm papéis diferentes, e por isso números diferentes:
#
#   por e-mail — é a proteção que importa. Adivinhar a senha de uma conta
#     exige tentar naquela conta, e 6 por 5 min torna isso inviável.
#   por IP — é a rede grossa contra quem varre várias contas de uma vez. Tem
#     que ser folgada: uma loja inteira sai por um IP só, e apertar aqui
#     bloquearia gente que errou a senha uma vez porque o colega errou antes.
#
# A primeira versão usava 8 para os dois, e o resultado apareceu na hora: a
# própria auditoria se bloqueou, porque a bateria de força bruta gastou o
# balde do IP e os logins seguintes não passaram.
LIMITE_LOGIN_EMAIL = (6, 300)
LIMITE_LOGIN_IP = (30, 300)
LIMITE_IA = (30, 3600)       # 30 perguntas por hora, por usuário

_tentativas: dict[str, deque[float]] = defaultdict(deque)


def _bater(chave: str, quantas: int, janela: int) -> tuple[bool, int]:
    """Registra uma tentativa. Devolve (permitido, segundos até liberar)."""
    agora = time.monotonic()
    fila = _tentativas[chave]
    while fila and agora - fila[0] > janela:
        fila.popleft()
    if len(fila) >= quantas:
        return False, int(janela - (agora - fila[0])) + 1
    fila.append(agora)
    return True, 0


def _limpar_velhas(limite: int = 5000) -> None:
    """Sem isto, um ataque distribuído encheria a memória de chaves mortas."""
    if len(_tentativas) <= limite:
        return
    agora = time.monotonic()
    mortas = [k for k, v in _tentativas.items() if not v or agora - v[-1] > 3600]
    for k in mortas:
        del _tentativas[k]


def ip_de(request: Request) -> str:
    """O IP real, atrás do proxy do Render.

    X-Forwarded-For é cabeçalho que qualquer cliente manda; confiar nele
    inteiro deixaria qualquer um forjar o próprio IP e escapar do limite. O
    primeiro item é o que o proxy da borda escreveu, e é o único que presta.
    """
    encaminhado = request.headers.get("x-forwarded-for", "")
    if encaminhado:
        return encaminhado.split(",")[0].strip()
    return request.client.host if request.client else "desconhecido"


def limitar_login(request: Request, email: str) -> None:
    _limpar_velhas()
    for chave, (quantas, janela) in (
        (f"login:email:{email.lower()}", LIMITE_LOGIN_EMAIL),
        (f"login:ip:{ip_de(request)}", LIMITE_LOGIN_IP),
    ):
        ok, espera = _bater(chave, quantas, janela)
        if not ok:
            raise HTTPException(429, f"Tentativas demais. Espere {espera}s e tente de novo.")


def limitar_ia(usuario_id: int) -> None:
    quantas, janela = LIMITE_IA
    ok, espera = _bater(f"ia:{usuario_id}", quantas, janela)
    if not ok:
        raise HTTPException(429,
            f"Você fez {quantas} perguntas na última hora. Espere {espera // 60 + 1} min.")


def zerar_login(request: Request, email: str) -> None:
    """Login certo limpa a contagem — senão quem erra duas vezes e acerta
    continua perto do bloqueio sem motivo."""
    _tentativas.pop(f"login:ip:{ip_de(request)}", None)
    _tentativas.pop(f"login:email:{email.lower()}", None)


# --------------------------------------------------------------- cabeçalhos ---
# 'unsafe-inline' em style porque o painel calcula largura e altura de card em
# atributo style — é assim que a grade funciona. Script não precisa: todo o
# JavaScript é arquivo próprio, nenhum <script> embutido na página.
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",          # data: é o avatar recortado no navegador
    "font-src 'self'",
    "connect-src 'self'",            # mesma origem: não há para onde vazar
    "frame-ancestors 'none'",        # ninguém embute o painel num iframe
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
])

CABECALHOS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
}


class CabecalhosDeSeguranca(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        resposta = await call_next(request)
        for nome, valor in CABECALHOS.items():
            resposta.headers.setdefault(nome, valor)
        return resposta
