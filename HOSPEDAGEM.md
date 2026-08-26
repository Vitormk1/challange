# Publicar a API

A API é um processo Python que **serve o painel junto**, na mesma origem. Este
arquivo é o passo a passo para publicá-la, e explica por que ela acabou servindo
a página em vez de deixá-la no GitHub Pages — a resposta está na seção 4, e não
é preferência de arquitetura: é o que os navegadores obrigaram.

Não existe modo demonstração. Publicado, o painel é o serviço real: login,
escrita no banco, assistente.

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
 "cookie": {"samesite": "lax", "secure": true}}
```

- `banco: false` → a `DATABASE_URL` está errada ou faltou `?sslmode=require`
- `ia: false` → faltou a `OPENROUTER_API_KEY`
- `cookie.samesite` deve ser **`lax`**. Se estiver `none`, alguém voltou a
  configuração para o arranjo antigo de dois domínios, e o login vai falhar em
  boa parte dos navegadores (seção 4)
- `origens` é resto do arranjo antigo. Com o painel na mesma origem da API não
  há requisição entre domínios, então o CORS não é mais o que segura nada —
  o campo fica porque é barato e documenta o que está configurado

### 3. O endereço do painel

**As telas são servidas pela própria API.** `https://SUA-URL.onrender.com/painel/`
é o site de apresentação, e é esse o endereço para compartilhar: dali saem os
links para o painel (`/painel/dashboard.html`) e para o mapa de carregadores
(`/painel/mapa.html`), que é aberto e não pede login.

Em [`docs/painel/api.js`](docs/painel/api.js) uma linha guarda esse endereço, e
é a única que muda se o serviço trocar de host:

```js
const API_PUBLICADA = "https://praca-recarga-api.onrender.com";
```

A cópia que fica no GitHub Pages redireciona para lá.

### 4. Por que o painel não fica no GitHub Pages

Essa foi a primeira tentativa, e ela falha em boa parte dos navegadores.

Com o painel em `github.io` e a API em `onrender.com`, o cookie de sessão é um
**cookie de terceiro**. Safari, Firefox, Brave e o modo anônimo do Chrome
descartam cookie de terceiro por padrão: o login responde 200, o navegador joga
o cookie fora, e a requisição seguinte volta 401. Na tela isso aparece como
"e-mail ou senha incorretos" logo depois de um login que deu certo — e não há
configuração do lado de quem usa que resolva.

`SameSite=None; Secure` é o que permite cookie de terceiro *quando o navegador
aceita*. Como a maioria não aceita mais, a saída é não depender disso: mesma
origem para a página e para a API. O cookie volta a ser de primeira parte,
`SameSite=Lax` basta, e o CORS deixa de existir.

### 5. Trocar as senhas

As senhas do seed viram senhas de internet no momento em que a API fica
pública. Antes de divulgar o link:

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

**Sobre gasto na OpenRouter.** A chave passa a estar num servidor público, mas
só quem tem login chega nela, e há um teto de 30 perguntas por hora por usuário
(`LIMITE_IA`, em `api/protecao.py`). Um limite de gasto na conta da OpenRouter
continua sendo a rede de segurança mais direta se algo escapar — a decisão de
pôr ou não é de quem publica.

---

## Se der errado

| Sintoma | Onde olhar |
|---|---|
| Login responde 200 e volta para a tela de login | cookie: seção 4 |
| "Não achei o servidor em …" | `API_PUBLICADA` na seção 3, ou serviço dormindo |
| Erro de CORS no console | não devia acontecer: o painel é da mesma origem. Se acontecer, alguém está abrindo o painel de outro endereço que não `/painel/` do próprio serviço |
| `/saude` com `banco: false` | `DATABASE_URL`, e confira o `?sslmode=require` |
| Primeira visita muito lenta | hibernação: seção "Antes da apresentação" |
| 503 "O banco não respondeu agora" | pool esgotado; o plano gratuito é 1 worker, veja `render.yaml` |
| Publiquei e o site não mudou | o Render só reconstrói quando algo muda dentro do diretório raiz do serviço. `render.yaml` **não** define `rootDir` justamente por isso — se alguém reintroduzir, mudança em `docs/` para de publicar |
