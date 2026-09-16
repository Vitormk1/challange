"""Testa o envio de e-mail sem passar pelo cadastro.

    python api/testar_email.py seu@email.com

Existe porque "o e-mail não chegou" tem muitas causas, e o fluxo de cadastro
não distingue nenhuma: a tela diz "mandamos o link" de qualquer jeito, porque
o envio roda em tarefa de fundo para não segurar a resposta. O erro real fica
só no log do servidor, que no Render exige abrir o painel e caçar.

Este script faz o contrário: fala com o SMTP na sua frente, síncrono, e diz
exatamente onde parou.
"""

from __future__ import annotations

import os
import smtplib
import ssl
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

import correio


VERDE, VERMELHO, AMARELO, FIM = "\033[32m", "\033[31m", "\033[33m", "\033[0m"


def diz(ok: bool | None, texto: str, detalhe: str = "") -> None:
    marca = f"{VERDE}ok{FIM}   " if ok else (f"{AMARELO}--{FIM}   " if ok is None
                                             else f"{VERMELHO}FALHA{FIM}")
    print(f"  {marca} {texto}" + (f"\n         {detalhe}" if detalhe else ""))


def main() -> int:
    destino = sys.argv[1] if len(sys.argv) > 1 else ""
    if not destino or "@" not in destino:
        print("uso: python api/testar_email.py seu@email.com")
        return 2

    print("\n== configuração ==")
    faltando = [v for v in ("SMTP_HOST", "SMTP_USUARIO", "SMTP_SENHA")
                if not os.environ.get(v, "").strip()]
    if faltando:
        diz(False, f"faltam variáveis: {', '.join(faltando)}",
            "Sem as três, a verificação de e-mail fica DESLIGADA e o cadastro "
            "segue como antes. Ver .env.example.")
        return 1

    host = os.environ["SMTP_HOST"].strip()
    porta = int(os.environ.get("SMTP_PORTA", "587") or 587)
    usuario = os.environ["SMTP_USUARIO"].strip()
    nome_rem, endereco_rem = correio.remetente()

    diz(True, f"servidor: {host}:{porta}  ({'TLS direto' if porta == 465 else 'STARTTLS'})")
    diz(True, f"usuário:  {usuario}")
    diz(True, f"remetente: {nome_rem} <{endereco_rem}>")
    if not os.environ.get("URL_PUBLICA", "").strip():
        diz(None, "URL_PUBLICA não definida",
            "Em produção isto não é opcional: sem ela o link do e-mail é montado "
            "a partir do cabeçalho Host, que quem faz a requisição controla.")

    # Um erro por vez, e cada um com o conserto. A mensagem crua do smtplib é
    # precisa e ilegível; quem está configurando SMTP às onze da noite precisa
    # da frase seguinte, não do código de erro.
    print("\n== conversa com o servidor ==")
    contexto = ssl.create_default_context()
    try:
        if porta == 465:
            s = smtplib.SMTP_SSL(host, porta, context=contexto, timeout=20)
        else:
            s = smtplib.SMTP(host, porta, timeout=20)
            s.starttls(context=contexto)
        diz(True, "conectou e negociou TLS")
    except (OSError, smtplib.SMTPException) as erro:
        diz(False, f"não conectou: {type(erro).__name__}: {erro}",
            "Porta errada é a causa mais comum, e ela não dá erro de senha: "
            "dá conexão pendurada. 587 = STARTTLS, 465 = TLS direto.")
        return 1

    with s:
        try:
            s.login(usuario, os.environ["SMTP_SENHA"].strip())
            diz(True, "autenticou")
        except smtplib.SMTPAuthenticationError as erro:
            diz(False, f"usuário ou senha recusados: {erro.smtp_code}",
                "No Resend o usuário é a palavra 'resend', literalmente, e a "
                "senha é a chave da API (começa com re_).")
            return 1

        print("\n== envio ==")
        link = (os.environ.get("URL_PUBLICA", "http://127.0.0.1:8000").rstrip("/")
                + "/painel/verificar.html?token=TESTE-NAO-FUNCIONA")
        msg = correio._montar(
            destino, "[teste] " + correio.ASSUNTO,
            correio._texto("teste", link, correio_horas()),
            correio._html("teste", link, correio_horas()))
        try:
            s.send_message(msg)
        except smtplib.SMTPRecipientsRefused:
            diz(False, f"o servidor recusou {destino}",
                "Com domínio ainda não verificado, o Resend só entrega para o "
                "e-mail da sua própria conta. Verifique smartcharge.ia.br no "
                "painel, ou teste com o seu endereço de cadastro.")
            return 1
        except smtplib.SMTPException as erro:
            diz(False, f"recusado no envio: {type(erro).__name__}: {erro}")
            return 1

    diz(True, f"aceito para entrega em {destino}")
    print(f"\n  {VERDE}O SMTP está funcionando.{FIM} Se a mensagem não aparecer em alguns")
    print("  minutos, olhe o spam — e, se estiver lá, o que falta é verificar o")
    print("  domínio no painel do provedor (SPF e DKIM).\n")
    return 0


def correio_horas() -> int:
    """As mesmas 24 horas que o main.py usa. Importar o main aqui subiria a
    aplicação inteira, com pool de banco e tudo, só para ler um número."""
    return 24


if __name__ == "__main__":
    raise SystemExit(main())
