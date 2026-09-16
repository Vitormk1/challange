"""Envio de e-mail.

Chama-se correio, e não `email`, de propósito: `api/` entra no sys.path por
causa do `--app-dir api`, e um arquivo chamado `email.py` ali sombrearia o
pacote `email` da biblioteca padrão — que é justamente o que o `smtplib`
importa para montar a mensagem. O programa quebraria num ponto que não tem
nada a ver com o arquivo novo.

SMTP da biblioteca padrão, e não a API de um serviço, por dois motivos: não
acrescenta dependência ao requirements.txt, e funciona com qualquer provedor
— Gmail, Brevo, Resend, Mailgun, todos falam SMTP. Trocar de provedor vira
trocar variável de ambiente, sem tocar em código.

QUANDO NÃO HÁ CONFIGURAÇÃO, A VERIFICAÇÃO NÃO É EXIGIDA.

Essa é a decisão mais importante deste arquivo, e ela é deliberada. As
alternativas são piores:

  recusar o cadastro — derruba a única porta de entrada do site enquanto
    ninguém tiver configurado SMTP, e quem chegasse veria um erro sem saber
    que é temporário.
  criar a conta e exigir verificação assim mesmo — prende a pessoa: conta
    criada, login recusado, e nenhum e-mail para clicar. Pior que não ter
    verificação nenhuma.

Então: sem SMTP, o cadastro funciona como antes e a conta já nasce
verificada. Com SMTP, a verificação passa a valer sozinha, sem mexer em
código. Para isso não virar um silêncio perigoso, o estado aparece em
/saude e o servidor avisa ao subir.
"""

from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage      # o pacote da stdlib, não este arquivo
from email.utils import formataddr


def _cfg(nome: str, padrao: str = "") -> str:
    return os.environ.get(nome, padrao).strip()


def configurado() -> bool:
    """Há SMTP suficiente para enviar? É isto que liga a verificação."""
    return bool(_cfg("SMTP_HOST") and _cfg("SMTP_USUARIO") and _cfg("SMTP_SENHA"))


def remetente() -> tuple[str, str]:
    """(nome exibido, endereço). O endereço cai no usuário SMTP se não vier."""
    return (_cfg("EMAIL_NOME", "Smart Charge"),
            _cfg("EMAIL_REMETENTE") or _cfg("SMTP_USUARIO"))


def _montar(para: str, assunto: str, texto: str, html: str) -> EmailMessage:
    nome, endereco = remetente()
    msg = EmailMessage()
    msg["From"] = formataddr((nome, endereco))
    msg["To"] = para
    msg["Subject"] = assunto
    # Texto puro primeiro, HTML como alternativa. Cliente que não renderiza
    # HTML — e filtro de spam, que lê os dois — recebe algo legível, com o
    # link à vista. Mensagem só-HTML pontua pior em quase todo filtro.
    msg.set_content(texto)
    msg.add_alternative(html, subtype="html")
    return msg


def enviar(para: str, assunto: str, texto: str, html: str) -> None:
    """Envia, ou levanta. Quem chama decide o que fazer com a falha.

    Porta 465 é SMTPS (TLS desde o primeiro byte); 587 é STARTTLS (começa em
    claro e sobe para TLS). Trocar os dois não dá erro de senha, dá conexão
    pendurada até estourar o tempo — por isso o caminho é escolhido pela
    porta, e não por mais uma variável que alguém teria de acertar.
    """
    host = _cfg("SMTP_HOST")
    porta = int(_cfg("SMTP_PORTA", "587") or 587)
    usuario = _cfg("SMTP_USUARIO")
    senha = _cfg("SMTP_SENHA")

    msg = _montar(para, assunto, texto, html)
    contexto = ssl.create_default_context()

    # Tempo curto: isto roda em tarefa de fundo, mas um worker preso num
    # socket morto é um worker a menos, e o plano gratuito tem um só.
    if porta == 465:
        with smtplib.SMTP_SSL(host, porta, context=contexto, timeout=20) as s:
            s.login(usuario, senha)
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, porta, timeout=20) as s:
            s.starttls(context=contexto)
            s.login(usuario, senha)
            s.send_message(msg)


# ==========================================================================
# A mensagem de verificação
# ==========================================================================

ASSUNTO = "Confirme seu e-mail — Smart Charge"


def _texto(nome: str, link: str, horas: int) -> str:
    return (
        f"Olá, {nome}.\n\n"
        "Falta um passo para sua conta Smart Charge ficar pronta: confirme "
        "que este e-mail é seu abrindo o endereço abaixo.\n\n"
        f"{link}\n\n"
        f"O link vale por {horas} horas.\n\n"
        "Se não foi você que criou a conta, ignore esta mensagem — sem o "
        "clique, ela não é ativada.\n\n"
        "Smart Charge — recarga elétrica como ativo comercial\n"
        "Challenge FIAP · GoodWe\n"
    )


def _html(nome: str, link: str, horas: int) -> str:
    # Tabela e estilo em atributo, que é o que cliente de e-mail entende:
    # Gmail e Outlook descartam <style> no topo e não conhecem flexbox nem
    # grid. Feio como página, correto como e-mail.
    return f"""<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#F4F4F6;
  font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#16161A;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"
         style="max-width:480px;margin:0 auto;background:#FFFFFF;border-radius:16px;
                border:1px solid #E4E4E9;">
    <tr><td style="padding:28px 28px 8px;">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.12em;
                text-transform:uppercase;color:#74747F;">Smart Charge</p>
      <h1 style="margin:0;font-size:21px;line-height:1.25;">Confirme seu e-mail</h1>
    </td></tr>
    <tr><td style="padding:12px 28px 0;font-size:15px;line-height:1.55;color:#55555F;">
      <p style="margin:0 0 16px;">Olá, {nome}. Falta um passo para sua conta
      ficar pronta.</p>
    </td></tr>
    <tr><td style="padding:8px 28px 4px;">
      <a href="{link}" style="display:inline-block;padding:13px 24px;border-radius:999px;
         background:#B4160F;color:#FFFFFF;text-decoration:none;font-weight:700;
         font-size:15px;">Confirmar meu e-mail</a>
    </td></tr>
    <tr><td style="padding:16px 28px 0;font-size:13px;line-height:1.5;color:#74747F;">
      <p style="margin:0 0 10px;">O link vale por {horas} horas. Se o botão não
      funcionar, copie este endereço:</p>
      <p style="margin:0 0 16px;word-break:break-all;color:#55555F;">{link}</p>
      <p style="margin:0;">Se não foi você que criou a conta, ignore esta
      mensagem — sem o clique, ela não é ativada.</p>
    </td></tr>
    <tr><td style="padding:20px 28px 26px;border-top:1px solid #E4E4E9;margin-top:16px;
                   font-size:12px;color:#9A9AA6;">
      Challenge FIAP · GoodWe
    </td></tr>
  </table>
</body></html>"""


def enviar_verificacao(para: str, nome: str, link: str, horas: int) -> None:
    primeiro = (nome or "").strip().split(" ")[0] or "tudo bem"
    enviar(para, ASSUNTO, _texto(primeiro, link, horas), _html(primeiro, link, horas))
