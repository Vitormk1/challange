# Comece aqui

Bem-vindo ao **Smart Charge** — o projeto que transforma o carregador de carro
elétrico em ativo comercial para o lojista. Está no ar em
<https://smartcharge.ia.br/painel/>.

Este documento é o caminho do zero até o seu primeiro Pull Request. Leva uns
20 minutos. Cada comando vem com o que ele faz, porque a ideia é você entender
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

## Parte 5 — O arquivo `.env` (uma vez só)

O projeto precisa de senhas: a do banco de dados e a chave da IA. Elas **não
estão no repositório**, porque ele é público — quem tem o link vê tudo.

```bash
copy .env.example .env        # Windows
cp .env.example .env          # Mac ou Linux
```

Isso cria um `.env` com os campos vazios. **Peça os valores ao Vitor** por
mensagem privada e cole cada um no seu arquivo.

> Nunca commite o `.env`, nunca mande print dele no grupo. Se uma chave
> vazar, ela precisa ser trocada em todos os serviços.

---

## Parte 6 — Rodar

```bash
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --app-dir api --reload
```

**O que faz:** sobe o servidor na sua máquina. O `--reload` faz ele reiniciar
sozinho toda vez que você salva um arquivo, então você edita e atualiza o
navegador para ver.

Abra <http://127.0.0.1:8000/painel/>. Se a apresentação aparecer, você está
com o projeto rodando. Para parar o servidor, `Ctrl + C` no terminal.

---

## Parte 7 — Sua primeira tarefa

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
3. **Rodar `api/seed.py`** apontando para o banco compartilhado — ele apaga
   todas as tabelas e recria. O script pergunta antes; leia o que ele mostra.

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
