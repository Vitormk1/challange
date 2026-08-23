# Publicar a API

O painel é HTML estático e vive no GitHub Pages. A API é um processo Python, e
Pages não executa Python — por isso, publicado, o painel cai em modo
demonstração. Este arquivo é o passo a passo para o painel publicado funcionar
de verdade: com login, com escrita no banco e com o assistente.

O banco não muda. O Aiven já é público, e tanto a sua máquina quanto o servidor
falam com ele.

---

## Por que Render

| | Render | Railway | Fly.io | Vercel / Netlify |
|---|---|---|---|---|
| Plano gratuito com URL HTTPS | ✔ | crédito de teste | ✔ | ✔ |
| Python + uvicorn direto | ✔ | ✔ | exige Docker | só função curta |
| Configuração versionada | `render.yaml` | parcial | `fly.toml` | — |
| Cartão de crédito | não | sim | sim | não |
| Processo de longa duração | ✔ | ✔ | ✔ | ✘ |

O que pesou:

- **Não precisa de cartão.** É um trabalho de faculdade; deixar de exigir cartão
  importa. O Railway trocou o gratuito por um crédito de teste que acaba.
- **Não precisa de Docker.** O Fly.io é ótimo e mais rápido, mas exige escrever
  e manter um `Dockerfile`. Um arquivo a mais para dar errado.
- **`render.yaml` mora no repositório.** Quem for subir uma cópia depois não
  precisa adivinhar o que foi clicado — a configuração está versionada.
- **Vercel e Netlify estão fora**, e não é preferência: eles rodam função sem
  estado, com poucos segundos de execução. Nosso processo mantém um pool de
  conexões vivo e chama a OpenRouter, que pode levar dezenas de segundos.

**O que você perde no gratuito:** o serviço hiberna depois de ~15 minutos sem
acesso, e a primeira visita depois disso espera de 30 a 60 segundos. Como
contornar, na seção "Antes da apresentação".

---

## Passo a passo

### 1. Criar o serviço

1. Entre em <https://render.com> com a conta do GitHub.
2. **New → Blueprint**, escolha o repositório `Vitormk1/challange`.
3. O Render lê o `render.yaml` e propõe o serviço `praca-recarga-api`. Confirme.
4. Ele vai pedir os dois segredos marcados `sync: false`:

   | Campo | Valor |
   |---|---|
   | `DATABASE_URL` | a mesma linha do seu `.env` (com `?sslmode=require`) |
   | `OPENROUTER_API_KEY` | a chave da OpenRouter |

   Esses dois ficam no cofre do Render. **Não vão para o repositório.**

5. O primeiro deploy leva uns 3 minutos. No fim você recebe uma URL, tipo
   `https://praca-recarga-api.onrender.com`.

### 2. Conferir que subiu certo

Abra `https://SUA-URL.onrender.com/saude`. A resposta diz o que está valendo:

```json
{"ok": true, "banco": true, "ia": true,
 "origens": "https://vitormk1.github.io",
 "cookie": {"samesite": "none", "secure": true}}
```

- `banco: false` → a `DATABASE_URL` está errada ou faltou `?sslmode=require`
- `ia: false` → faltou a `OPENROUTER_API_KEY`
- `cookie.samesite` diferente de `none` → o login vai responder 200 e a sessão
  não vai colar (ver seção 4)

### 3. Apontar o painel para a API

Em [`docs/painel/api.js`](docs/painel/api.js), uma linha:

```js
const API_PUBLICADA = "https://praca-recarga-api.onrender.com";
```

Commit e push. O Pages republica sozinho.

### 4. Por que o cookie precisa de atenção

O painel fica em `vitormk1.github.io` e a API em `onrender.com` — **domínios
diferentes**. Um cookie `SameSite=Lax` não é enviado nesse caso: o login
responderia 200, o cookie seria descartado pelo navegador, e a próxima
requisição voltaria 401. Parece bug de senha, e não é.

Por isso o `render.yaml` traz `COOKIE_SAMESITE=none` e `COOKIE_SEGURO=1` — e
`None` só é aceito junto com `Secure`, ou seja, só em HTTPS. Em
desenvolvimento, tudo em `localhost`, o padrão continua `lax`, que não exige
HTTPS.

`ORIGENS_PERMITIDAS` precisa ser **exatamente** a origem do Pages, sem barra no
fim: `https://vitormk1.github.io`.

### 5. Trocar as senhas

As senhas de demonstração (`praca2026`) viram senhas de internet no momento em
que a API fica pública. Antes de divulgar o link:

```bash
python api/trocar_senha.py vitor@pracaderecarga.local
```

---

## Antes da apresentação

O plano gratuito hiberna. Se um jurado abrir o link com o serviço dormindo, ele
espera quase um minuto olhando para a tela de login — e vai achar que travou.

Três saídas, da mais simples para a mais garantida:

1. **Abrir o link 2 minutos antes.** Uma visita acorda o serviço, e ele fica de
   pé enquanto houver acesso. Resolve o caso da apresentação, e é grátis.
2. **Ping automático.** Um cron gratuito (cron-job.org, UptimeRobot) chamando
   `/saude` a cada 10 minutos mantém acordado. Grátis, mas mantém o serviço
   rodando o tempo todo.
3. **Plano pago**, US$ 7/mês, sem hibernação. Só vale se o painel for ficar no
   ar de verdade depois do desafio.

**Ponha um limite de gasto na OpenRouter** antes de publicar. A chave passa a
estar num servidor público; o limite é a rede de segurança se algo escapar.

---

## Se der errado

| Sintoma | Onde olhar |
|---|---|
| Login responde 200 e volta para a tela de login | cookie: seção 4 |
| "Não achei o servidor em …" | `API_PUBLICADA` na seção 3, ou serviço dormindo |
| Erro de CORS no console | `ORIGENS_PERMITIDAS` não bate com a origem exata do Pages |
| `/saude` com `banco: false` | `DATABASE_URL`, e confira o `?sslmode=require` |
| Primeira visita muito lenta | hibernação: seção "Antes da apresentação" |
| 503 "O banco não respondeu agora" | pool esgotado; o plano gratuito é 1 worker, veja `render.yaml` |
