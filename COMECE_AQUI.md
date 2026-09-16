# Comece aqui

Bem-vindo ao **Smart Charge** — o projeto que transforma o carregador de carro
elétrico em ativo comercial para o lojista. Está no ar em
<https://smartcharge.ia.br/painel/>.

Este documento é o caminho do zero até o seu primeiro Pull Request. Leva uns
uns 30 minutos, a maior parte esperando instalação. Cada comando vem com o que ele faz, porque a ideia é você entender
e não decorar.

Depois que estiver rodando, o [CONTRIBUTING.md](CONTRIBUTING.md) é a
referência do dia a dia — volte lá quando esquecer alguma coisa.

---

## Parte 1 — Instalar (uma vez só)

**Git** — <https://git-scm.com/downloads>. É o programa que guarda o histórico
do projeto e permite várias pessoas mexerem sem se atrapalhar.

**Python 3.12 ou mais novo** — <https://www.python.org/downloads/>. No Windows,
**marque a caixa "Add Python to PATH"** na instalação. Sem ela, o terminal não
acha o Python e você vai perder meia hora com isso.

**Um editor** — [VS Code](https://code.visualstudio.com/) serve bem.

Confira se deu certo abrindo o terminal (no Windows, PowerShell) e digitando:

```bash
git --version
python --version
```

Se os dois responderem com um número de versão, está pronto. Se algum disser
"não é reconhecido como comando", ele não foi instalado ou não entrou no PATH.

---

## Parte 2 — Dizer ao Git quem você é (uma vez só)

```bash
git config --global user.name "Seu Nome"
git config --global user.email "seu@email.com"
```

**O que faz:** todo commit que você criar carrega seu nome e e-mail. É assim
que o histórico sabe quem escreveu o quê. Sem isso, o Git recusa o primeiro
commit ou grava um autor genérico.

Use o **mesmo e-mail da sua conta do GitHub**. Assim seus commits aparecem
ligados ao seu perfil.

---

## Parte 3 — Trazer o projeto (uma vez só)

```bash
git clone https://github.com/Vitormk1/challange.git
cd challange
```

**`git clone`** baixa o projeto inteiro — não só os arquivos de hoje, mas todo
o histórico: cada commit, cada mudança, desde o início. Por isso você consegue
ver o que mudou e voltar atrás sem precisar de internet.

**`cd challange`** entra na pasta. Todos os comandos daqui em diante são
rodados de dentro dela.

---

## Parte 4 — Instalar as bibliotecas (uma vez só)

Opcional mas recomendado — um ambiente isolado, para as bibliotecas deste
projeto não brigarem com as de outros:

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
source .venv/bin/activate     # Mac ou Linux
```

Depois, em qualquer caso:

```bash
pip install -r requirements.txt
```

**O que faz:** o `requirements.txt` lista de que o projeto precisa — FastAPI
(o servidor), uvicorn (quem o executa), psycopg (fala com o banco). O `pip`
lê essa lista e instala tudo.

---

## Parte 5 — Seu banco de dados (uma vez só)

**Cada um roda o próprio banco, na própria máquina.** Não usamos o banco que
está no ar para desenvolver, e isso não é frescura: o `api/seed.py` apaga dez
tabelas e recria do zero. É um comando normal de desenvolvimento, e é o que
você vai querer rodar quando quiser dados limpos — só que apontado para o
banco de produção ele apaga as lojas, os trinta dias de operação e as contas
de todo mundo. Com um banco só seu, você quebra à vontade.

Instale o [Docker Desktop](https://www.docker.com/products/docker-desktop/) e
suba o banco:

```bash
docker compose -f docker-compose.dev.yml up -d
```

**O que faz:** liga um PostgreSQL na sua máquina, na porta 5433. A porta é
5433 e não 5432 para não brigar com um Postgres que você já tenha instalado.
O `-d` deixa rodando no fundo. Para desligar e apagar tudo:
`docker compose -f docker-compose.dev.yml down -v`.

---

## Parte 6 — O arquivo `.env` (uma vez só)

O projeto lê as configurações daqui. Este arquivo **nunca vai para o
repositório** — ele está no `.gitignore`, e o repositório é público.

Crie um arquivo chamado `.env` na raiz do projeto com exatamente isto:

```
DATABASE_URL=postgresql://smart:smart@localhost:5433/smartcharge

OPENROUTER_API_KEY=
OPENROUTER_MODEL=mistralai/mistral-small-24b-instruct-2501

SENHA_MAIN=
SENHA_DEMO=
SENHA_GERENTE=
SENHA_OPERADOR=

CARTO_KEY=cb1_27zl_1_12d6ebc987e8b8882e924f80
```

Três coisas sobre esses valores:

- **`DATABASE_URL`** aponta para o banco que você acabou de subir. Esse
  usuário e senha (`smart`/`smart`) são descartáveis e valem só na sua
  máquina — por isso podem estar escritos aqui sem problema.
- **As `SENHA_*` ficam vazias de propósito.** O `seed.py` sorteia uma senha
  para cada usuário e **imprime na tela** quando roda. Anote na hora: o banco
  guarda só o hash, e não tem como consultar depois.
- **`OPENROUTER_API_KEY` vazia também está certo.** O projeto inteiro roda sem
  ela; só o assistente de IA não responde. Se você for mexer especificamente
  na IA, crie a sua própria chave em [openrouter.ai](https://openrouter.ai) —
  assim o gasto fica no seu nome.

> Nunca commite o `.env`, nunca mande print dele no grupo.

---

## Parte 7 — Criar as tabelas e os dados de exemplo (uma vez só)

```bash
python api/db.py
python api/seed.py
```

**`db.py`** lê o `api/schema.sql` e cria tabelas, índices e visões. Rode
sempre que alguém mexer no `schema.sql` — ele é seguro de repetir, não apaga
nada.

**`seed.py`** preenche o banco com três lojas e trinta dias de operação
inventada, para você ter o que ver na tela. **Ele apaga tudo antes de
preencher**, e pergunta antes de fazer isso. Leia o que ele mostra: se
aparecer qualquer endereço que não seja `localhost:5433`, responda não.

Anote as senhas que ele imprimir.

---

## Parte 8 — Rodar

```bash
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --app-dir api --reload
```

**O que faz:** sobe o servidor na sua máquina. O `--reload` faz ele reiniciar
sozinho toda vez que você salva um arquivo, então você edita e atualiza o
navegador para ver.

Abra <http://127.0.0.1:8000/painel/>. Se a apresentação aparecer, você está
com o projeto rodando. Para parar o servidor, `Ctrl + C` no terminal.

As telas, para você se achar:

| Endereço | O que é |
|---|---|
| `/painel/` | a apresentação do projeto, aberta |
| `/painel/entrar.html` | login e cadastro |
| `/painel/cliente.html` | área do motorista (Dashboard, Mapa, Carteira) |
| `/painel/dashboard.html` | o painel do lojista |
| `/painel/mapa.html` | mapa dos carregadores, aberto |
| `/painel/anuncio.html` | o filme do projeto |

Entre com um dos e-mails que o `seed.py` criou (`gerente.petecia@praca.local`,
por exemplo) e a senha que ele imprimiu. Ou crie uma conta em
`/painel/entrar.html` — contas criadas ali entram como **motorista** e vão
para a área do cliente.

---

## Parte 9 — Sua primeira tarefa

Agora o ciclo que se repete para sempre. São seis passos.

### 1. Parta do que está publicado

```bash
git checkout main
git pull
```

**`checkout main`** te leva para o branch principal — o que está no ar.
**`pull`** baixa o que os outros publicaram desde a última vez.

Este é o passo mais esquecido e o que mais causa dor de cabeça depois. Faça
sempre, antes de qualquer coisa.

### 2. Crie o seu branch

```bash
git checkout -b ana/filtro-do-mapa
```

**O que faz:** cria uma linha do tempo paralela, só sua, e te move para ela. O
`-b` é de "branch novo".

Use `seunome/o-que-vai-fazer`. Uma tarefa, um branch. Terminou, o branch morre.

**Isto é o coração de tudo:** a partir daqui, nada do que você fizer toca o
trabalho de ninguém.

### 3. Trabalhe

Edite os arquivos normalmente. Para ver o que mudou:

```bash
git status      # quais arquivos mudaram
git diff        # o que exatamente mudou, linha por linha
```

### 4. Salve pontos no caminho

```bash
git add -A
git commit -m "Filtra os pontos do mapa por segmento"
```

**`add -A`** marca tudo que mudou para entrar no próximo commit.
**`commit`** grava esse conjunto no histórico, com a mensagem que você escrever.

Commit é ponto de salvamento, não é entrega. Faça vários por dia, sempre que
algo passar a funcionar. Só não commite coisa quebrada.

### 5. Traga o que os outros fizeram

Antes de mandar, atualize seu branch:

```bash
git checkout main
git pull
git checkout -
git merge main
```

**`git checkout -`** volta para o branch anterior (o seu) — atalho útil.
**`git merge main`** traz para dentro do seu branch tudo que foi publicado
enquanto você trabalhava.

Fazendo isso aqui, qualquer atrito aparece na sua máquina, com calma, em vez
de aparecer no Pull Request com todo mundo esperando.

### 6. Mande e abra o Pull Request

```bash
git push -u origin ana/filtro-do-mapa
```

**O que faz:** envia o **seu branch** para o GitHub. O `-u` só na primeira vez;
depois, `git push` sozinho basta.

Vá em <https://github.com/Vitormk1/challange> — vai aparecer um botão
**"Compare & pull request"**. Clique, descreva o que fez e peça revisão.

Quando alguém aprovar e mesclar, o site publica sozinho em uns 3 minutos.

Depois:

```bash
git checkout main
git pull
git branch -d ana/filtro-do-mapa    # apaga o branch, já cumpriu o papel
```

E volta ao passo 1.

---

## Quando travar

```bash
git branch                  # em que branch eu estou?
git log --oneline -10       # os últimos 10 commits

git restore arquivo.js      # desfaz o que você mudou e NÃO commitou
git stash                   # guarda o trabalho pela metade
git stash pop               # ...e traz de volta depois
```

E três coisas que **não** se faz:

1. **`git push --force`** — é o único comando capaz de apagar o trabalho dos
   outros do histórico. Na dúvida, pergunte antes.
2. **Commitar o `.env`** — tem senha dentro, e o repositório é público.
3. **Rodar `api/seed.py` sem olhar para onde ele aponta** — ele apaga todas
   as tabelas e recria. No seu banco local isso é normal e até útil. Apontado
   para o banco que está no ar, apaga o trabalho de todo mundo. O script
   pergunta antes e mostra o endereço: se não for `localhost:5433`, responda
   não.

---

## Por que ninguém vai sobrescrever ninguém

Essa é a dúvida que todo mundo tem no começo, e a resposta tem duas partes.

### O Git não guarda arquivos, guarda mudanças

Isso muda tudo. Quando você faz um commit, o Git não salva uma cópia do
arquivo: ele salva **o que mudou** — "na linha 50 do mapa.js, isto virou
aquilo".

Então quando dois trabalhos se encontram, o Git não escolhe um e joga o outro
fora. Ele **aplica as duas mudanças**.

Um exemplo concreto:

- A Ana mexe na **linha 50 do `mapa.js`**
- O Lucas mexe na **linha 200 do `site.css`**
- Os dois mandam

O Git junta os dois sem perguntar nada. Nem precisam ser arquivos diferentes —
se a Ana mexe na linha 50 e o Lucas na linha 300 do **mesmo** arquivo, também
junta sozinho.

Ele só para e pergunta num caso: **os dois mudaram exatamente as mesmas
linhas**. Aí ele não tem como adivinhar qual está certa, então mostra as duas
versões marcadas no arquivo e você escolhe. Isso se chama conflito, e é raro —
e mesmo quando acontece, nada se perde: as duas versões estão ali.

### O branch é o que dá segurança

Enquanto você trabalha no `ana/filtro-do-mapa`, você está numa linha do tempo
só sua. O que você faz ali **não existe** para os outros até você abrir o PR.

E o `main` — o que está no ar — só recebe trabalho por Pull Request, um de cada
vez, depois de alguém olhar. Nunca dois ao mesmo tempo.

Por isso os dois hábitos do passo 1 e do passo 5 importam tanto: **`git pull`
antes de começar** e **`git merge main` antes de mandar**. Eles fazem seu
branch encontrar o trabalho dos outros na sua máquina, cedo, quando resolver é
fácil.

### O que de fato causa problema

Quase nunca é a ferramenta. É **duas pessoas mexendo na mesma coisa sem
saber**. A solução não é técnica: **combinem quem pega o quê** antes de
começar. Cinco minutos de conversa evitam a maior parte dos conflitos.

---

Dúvida em qualquer passo, pergunte no grupo antes de tentar resolver na
tentativa e erro — principalmente se envolver `--force` ou apagar alguma coisa.
