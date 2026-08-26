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

# A assistente do site de apresentação não pede login, e cada pergunta dela é
# dinheiro na OpenRouter. Sem login não há quem cobrar, então o teto tem de
# ser o próprio limite — e em duas camadas, porque uma só não cobre os dois
# jeitos de estourar a conta:
#
#   por IP — segura a pessoa (ou o script) que fica perguntando em laço.
#   global — segura o que o limite por IP não pega: muitos IPs diferentes,
#     que é exatamente o que uma botnet ou um link que viralizou produzem.
#     É um teto de gasto por dia, não uma proteção contra abuso individual.
#
# Números pensados para uma banca e alguns curiosos, não para tráfego de
# produto: 10 por hora dá para tirar dúvida, não para conversar a tarde toda.
LIMITE_IA_PUBLICA_IP = (10, 3600)
LIMITE_IA_PUBLICA_TOTAL = (300, 86400)

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


def limitar_ia_publica(request: Request) -> None:
    """Teto duplo da assistente pública: por IP e no total do dia.

    A ordem importa. O balde global é conferido DEPOIS do balde do IP, senão
    um único cliente em laço gastaria as 300 do dia e derrubaria a assistente
    para todo mundo antes de o limite dele próprio disparar.
    """
    _limpar_velhas()
    quantas, janela = LIMITE_IA_PUBLICA_IP
    ok, espera = _bater(f"ia-pub:ip:{ip_de(request)}", quantas, janela)
    if not ok:
        raise HTTPException(429,
            f"Você já fez {quantas} perguntas nesta hora. "
            f"Volte em {espera // 60 + 1} min — ou entre no painel, onde o limite é maior.")

    quantas, janela = LIMITE_IA_PUBLICA_TOTAL
    ok, _ = _bater("ia-pub:total", quantas, janela)
    if not ok:
        raise HTTPException(429,
            "A assistente do site atingiu o limite de uso de hoje. "
            "Ela volta amanhã; o painel continua no ar.")


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

# A página do mapa é a única que carrega imagem de fora, e ganha uma CSP
# própria por isso. O que muda é só o img-src, e só nela.
#
# Por que não Google Maps: a API dele chega por <script> de maps.googleapis.com,
# o que obrigaria a abrir `script-src` para um terceiro — e script de terceiro
# na página pode tudo, inclusive ler o cookie de sessão de quem estiver logado
# no painel na mesma origem. Ainda exigiria uma chave no cliente, numa página
# que não pede login: qualquer um copiaria do código-fonte e gastaria a cota,
# que é cobrada. Restrição por referrer ajuda e não resolve.
#
# Com Leaflet servido daqui, `script-src 'self'` continua intacto e o que se
# abre é `img-src` para um host de tiles. Imagem não executa código, e a
# diferença de superfície entre as duas escolhas é essa.
#
# `connect-src` NÃO é afetado: tile raster chega por <img>, não por fetch.
TILES = "https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org"
CSP_MAPA = CSP.replace("img-src 'self' data:", f"img-src 'self' data: {TILES}")

CABECALHOS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    # `microphone=(self)`, não `microphone=()`. A lista vazia proíbe TODA
    # origem, inclusive a própria página — e foi assim que o botão de ditar
    # parou de funcionar sem dizer nada: a política bloqueava antes de o
    # navegador sequer perguntar. `(self)` libera só esta origem, que é o
    # necessário para o reconhecimento de fala e nada além disso.
    # `geolocation=(self)`: o mapa público tem um botão de "onde estou", e com
    # a lista vazia o navegador barrava antes mesmo de perguntar — o mesmo erro
    # que já tinha derrubado o microfone. `(self)` libera só esta origem, e o
    # navegador continua pedindo permissão a quem usa; quem recusa perde só o
    # centralizar, porque os pontos são fictícios e não dependem disso.
    "Permissions-Policy": "geolocation=(self), microphone=(self), camera=(), payment=()",
}

# HSTS: o navegador passa a recusar http nesta origem por um ano, sem nem
# tentar. O Render já responde 301 de http para https, mas o 301 acontece
# DEPOIS de a primeira requisição sair em texto claro — e é essa primeira que
# um atacante na mesma rede intercepta. O HSTS elimina essa primeira.
#
# Só vai embora em resposta que chegou por https, olhando o x-forwarded-proto
# que o Render põe. Em desenvolvimento a origem é http://127.0.0.1, e mandar
# HSTS ali ensinaria o navegador a recusar o próprio ambiente local por um
# ano — um estrago demorado de desfazer, porque quem limpa é o usuário nas
# configurações do navegador, não o servidor.
#
# Sem `preload`: entrar na lista de pré-carga é um compromisso que se pede
# fácil e se desfaz devagar, e este endereço ainda é um subdomínio temporário
# do Render.
HSTS = "max-age=31536000; includeSubDomains"


class CabecalhosDeSeguranca(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        resposta = await call_next(request)
        for nome, valor in CABECALHOS.items():
            resposta.headers.setdefault(nome, valor)
        # comparação exata, não `startswith`: um prefixo deixaria
        # /painel/mapa.html.qualquer-coisa herdar a política afrouxada
        if request.url.path == "/painel/mapa.html":
            resposta.headers["Content-Security-Policy"] = CSP_MAPA
        protocolo = request.headers.get("x-forwarded-proto", request.url.scheme)
        if protocolo == "https":
            resposta.headers.setdefault("Strict-Transport-Security", HSTS)
        return resposta
