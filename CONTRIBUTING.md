# Trabalhando em equipe neste repositório

Este arquivo existe por um motivo específico: a partir de agora somos mais de
um, e **o `main` é o que está no ar**. O Render observa esse branch e publica
sozinho a cada commit que chega nele. Isso é ótimo — e é exatamente por isso
que ninguém empurra direto para lá.

O resto deste documento é como fazer isso sem ninguém sobrescrever ninguém.

> **Primeira vez aqui?** Vá antes ao [COMECE_AQUI.md](COMECE_AQUI.md): ele
> leva do zero — instalar, clonar, configurar — até o primeiro Pull Request,
> explicando cada comando. Este arquivo aqui é a referência de consulta, para
> depois que o projeto já estiver rodando na sua máquina.

---

## A regra, em uma frase

**Cada tarefa tem o seu branch, vira Pull Request, alguém revisa, e só então
entra no `main` — que publica.**

Só isso. Não tem `develop`, não tem `release`, não tem gitflow. Para quatro
pessoas num projeto de faculdade, qualquer coisa além disto atrapalha mais do
que organiza.

---

## A rotina, do jeito que ela acontece

### Sentei para mexer no projeto

Sempre estes dois, sempre nesta ordem. É o passo que mais se esquece e o que
mais causa conflito depois:

```bash
git checkout main
git pull
```

Você acabou de trazer tudo que os outros publicaram desde ontem.

### Vou começar uma tarefa

```bash
git checkout -b vitor/filtro-do-mapa
```

Um branch por tarefa, com seu nome na frente. Terminou a tarefa, o branch
morre — não reaproveite branch antigo para assunto novo.

### Vou rodar o projeto

```bash
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --app-dir api --reload
```

`--reload` reinicia sozinho a cada arquivo salvo. Abre em
<http://127.0.0.1:8000/painel/>.

### Estou trabalhando

```bash
git status           # o que mudou desde o último commit
git diff             # exatamente o que mudou, linha a linha
```

### Terminei um pedaço que funciona

```bash
git add -A
git commit -m "Filtra os pontos do mapa por segmento"
```

Commit é ponto de salvamento, não entrega. Commite várias vezes por dia,
sempre que algo passar a funcionar. Só não commite coisa quebrada.

### Vou abrir o Pull Request

Antes, traga o que os outros publicaram enquanto você trabalhava:

```bash
git checkout main
git pull
git checkout vitor/filtro-do-mapa
git merge main
```

Se aparecer conflito, é aqui que você resolve — no seu branch, com calma.
Resolver aqui é muito melhor que descobrir no PR.

Depois:

```bash
git push -u origin vitor/filtro-do-mapa
```

O `-u` só na primeira vez. Nas seguintes, `git push` sozinho basta.

Vá ao GitHub, clique em **Compare & pull request**, descreva e peça revisão.

### Mesclaram meu PR

```bash
git checkout main
git pull
git branch -d vitor/filtro-do-mapa    # apaga o branch local, já foi
```

E volta ao começo.

---

## Quando der errado

```bash
git branch                    # em que branch eu estou?
git log --oneline -10         # o que aconteceu por último

git restore arquivo.js        # desfaz alterações NÃO commitadas do arquivo
git restore .                 # desfaz tudo que não foi commitado (cuidado)

git stash                     # guarda o trabalho pela metade
git checkout main             # ...para poder trocar de branch...
git checkout -                # ...e voltar...
git stash pop                 # ...e pegar de volta
```

Errou a mensagem do último commit e **ainda não deu push**:

```bash
git commit --amend -m "A mensagem certa"
```

## Três coisas que não se faz

1. **`git push --force`** em branch que não é só seu. É assim que trabalho
   dos outros some do histórico de verdade.
2. **Commitar o `.env`.** Ele tem senha de banco e chave de API, e o
   repositório é público. A verificação automática barra, mas não conte com
   ela como única defesa.
3. **Rodar `api/seed.py` contra o banco compartilhado.** Ele apaga tudo.

---

## Por que o nome do branch tem o seu nome

`vitor/filtro-do-mapa`, `ana/api-pagamento`, `lucas/simulador`. Com quatro
pessoas, `git branch -a` vira uma lista longa rápido, e saber de quem é cada
coisa sem perguntar economiza mais tempo do que parece.

---

## Quando duas pessoas mexem no mesmo arquivo

Vai acontecer, e não é problema — o Git resolve sozinho quase sempre. O que
dá trabalho é quando o seu branch ficou parado três dias enquanto o `main`
andou, e é por isso que a rotina acima manda fazer `git merge main` **antes**
de abrir o PR.

Quando há conflito de verdade, o Git marca os dois lados no arquivo e você
escolhe qual fica. Resolver ali, no seu branch, é muito melhor do que
descobrir o problema no PR com os outros esperando.

**Combinem quem mexe em quê.** A maior parte dos conflitos não é problema de
ferramenta, é duas pessoas editando a mesma função sem saber.

---

## O que você precisa para rodar localmente

### 1. Dependências

```bash
pip install -r requirements.txt
```

### 2. O arquivo `.env`

Ele **não** está no repositório, e não pode estar: tem senha de banco e chave
de API. Copie o modelo e peça os valores ao Vitor:

```bash
cp .env.example .env
```

Os campos estão documentados lá dentro. Mande os valores por um canal
privado — não por mensagem em grupo, não por commit, não por print.

### 3. Subir o servidor

```bash
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --app-dir api --reload
```

Abre em <http://127.0.0.1:8000/painel/>.

### 4. Rodar os testes

```bash
pip install -r requirements-dev.txt
python -m unittest discover -s tests
```

São **97 testes**, e nenhum deles precisa de rede ou de banco — dá para rodar
com o `.env` vazio. Rode antes de abrir o PR.

O `requirements-dev.txt` existe só por causa do `TestClient` do Starlette, que
não traz cliente HTTP. A partir do Starlette 1.6 ele quer **`httpx2`**, e não o
`httpx` — com o pacote errado instalado, as duas suítes que usam `TestClient`
nem importam e o `discover` roda **67 em vez de 97**. Ele acusa dois erros, mas
a mensagem é de import e passa batido. O que denuncia é o total: confira o
número.

### 5. Conferir contra a produção

```bash
set -a && . ./.env && set +a
python api/auditoria.py https://smartcharge.ia.br        # 91 de 91
python api/conferir_fluxos.py https://smartcharge.ia.br  # 81 de 81
```

Os dois rodam **contra o que está no ar**, não contra um ambiente de teste. O
`conferir_fluxos` cria um motorista de teste e o apaga no fim. Nenhum dos dois
cria cobrança na Asaas, que está em produção.

---

## ⚠️ O banco é compartilhado — cuidado com o seed

`api/seed.py` **apaga todas as tabelas** (`TRUNCATE`) e recria trinta dias de
operação do zero. É o comportamento certo para um seed, e é justamente por
isso que rodá-lo contra o banco compartilhado apaga os dados que todo mundo
está usando.

O script tem duas travas, conforme o alvo:

- **Banco local** — pergunta, e `--sim` dispensa a pergunta. Apagar o próprio
  banco de desenvolvimento é rotina.
- **Banco remoto** (o que está no ar) — **nenhuma flag serve**. É preciso
  digitar o endereço do banco, letra por letra. Sem terminal, ele recusa.

Se você chegou na pergunta que pede o endereço, quase certamente não era o
que você queria: `Ctrl+C`.

Se você precisa de um banco só seu para experimentar à vontade, suba um
Postgres local:

```bash
docker compose -f docker-compose.dev.yml up -d
```

e no seu `.env` troque a linha para:

```
DATABASE_URL=postgresql://smart:smart@localhost:5433/smartcharge
```

Aí pode rodar o seed quantas vezes quiser sem afetar ninguém. Para voltar ao
banco compartilhado, é só devolver a `DATABASE_URL` original.

---

## O que a verificação automática olha no seu PR

Ao abrir um PR, o GitHub roda [`verificar.yml`](.github/workflows/verificar.yml)
sozinho. Ele checa três coisas, todas rápidas:

1. **Sintaxe de Python** — todo `.py` precisa compilar.
2. **Sintaxe de JavaScript** — todo `.js` precisa passar no `node --check`.
3. **Segredo vazado** — chave da OpenRouter, URL do Aiven, chave da CARTO.
   Esta é a que mais importa: chave que entra no histórico do Git **continua
   lá depois de removida**, e o repositório é público. Se esta falhar, não
   corrija com outro commit por cima — fale com o Vitor, porque a chave
   precisa ser trocada no serviço.

Se a verificação falhar, o PR não deve ser mesclado até passar.

---

## Antes de pedir revisão

- [ ] Rodei e vi funcionando no navegador, não só "compilou"
- [ ] Se mexi em `docs/painel/`, subi o `?v=` dos arquivos no HTML
      (sem isso o navegador serve a versão velha do cache e parece que
      nada mudou)
- [ ] Se mexi em `api/`, rodei `python api/auditoria.py`
- [ ] Não tem segredo, senha nem chave no diff

---

## Revisando o PR de alguém

Não precisa ser exaustivo. Três perguntas bastam:

1. Faz o que o título diz?
2. Quebra alguma coisa que já funcionava?
3. Tem segredo no diff?

Aprovar é normal. Pedir mudança também. O que não vale é aprovar sem olhar —
a partir do merge aquilo está no ar.

---

## Quem faz o quê no GitHub

Uma vez só, o Vitor precisa:

1. **Settings → Collaborators** → adicionar cada um
2. **Settings → Rules → Rulesets** (ou Branches → Branch protection) no
   `main`:
   - exigir Pull Request antes do merge
   - exigir 1 aprovação
   - exigir que a verificação automática passe
   - **não** liberar exceção para administrador — a regra só vale se valer
     para quem a criou

Sem esse último passo, tudo aqui é sugestão. Com ele, é o caminho.
