# Praça de Recarga

Challenge FIAP · GoodWe · 2026

Recarga de veículos elétricos **como ativo comercial**. Dois produtos, um sistema:

- **Painel gerencial** — o lojista descobre se o carregador traz cliente e dá retorno
- **Totem do motorista** — tela ao lado da vaga com tempo e custo previstos

> O lojista não quer vender energia. Quer saber se o carregador na frente da loja
> traz cliente. Hoje nenhum painel do mercado responde isso.

**Dossiê:** [`docs/index.html`](docs/index.html) · **Telinha da vaga:** [`docs/vaga/`](docs/vaga/)

Publique com GitHub Pages (Settings → Pages → branch `main`, pasta `/docs`) e
acesse em `vitormk1.github.io/challange/`.

> O GitHub Pages só publica arquivo estático — não executa Python. As telas
> funcionam ali sozinhas, com dado de demonstração. O servidor da API precisa de
> outra hospedagem quando entrar.

---

## Estrutura

```
docs/
  index.html   o dossiê do projeto
  vaga/        a telinha ao lado do carregador  (pronta)
  painel/      o painel do lojista              (a fazer)
api/
  models.py    o contrato de dados — sessão, ponto, loja, venda, agregado
  db.py        conexão com MongoDB, índices e relatório de armazenamento
ai/
  charge_curve.py   previsão de tempo de recarga (o núcleo do produto)
```

---

## Configuração

```bash
pip install -r requirements.txt
cp .env.example .env      # e preencha
python api/db.py          # cria os índices e mostra o uso do banco
```

**Nenhuma credencial vai para o repositório.** Tudo vem de variável de ambiente;
o `.gitignore` bloqueia o `.env`. Uma senha commitada em repositório público é
vazamento permanente, mesmo depois de removida.

### MongoDB

A `MONGODB_URI` sai de **Atlas → Database → Connect → Drivers** e tem esta cara:

```
mongodb+srv://usuario:senha@cluster0.xxxxx.mongodb.net/
```

Um endereço IP **não** funciona: o Atlas responde por nome. O IP que aparece no
painel é o *seu*, o que está liberado em Network Access.

**Plano gratuito são 512 MB**, e a modelagem respeita isso por decisão de projeto:

| Coleção | Retenção | Por quê |
|---|---|---|
| `sessions`, `sales` | para sempre | poucos documentos, e são o produto |
| `telemetry` | **30 dias**, por índice TTL | ninguém precisa da potência instantânea de seis meses atrás |
| `rollups` | para sempre | uma linha por ponto por dia, alimenta o histórico |

Estimativa: **menos de 50 MB por ano** para uma loja com quatro pontos.

---

## O núcleo de IA: previsão de tempo de recarga

```bash
python ai/charge_curve.py
```

```
Carro de 50 kWh em um ponto de 7,4 kW

  SoC    ate 80%   ate cheio   linear diz   erro do linear
  10%       5h26        7h40         6h59            40 min
  50%       2h20        4h33         3h53            40 min
  85%       0h00        1h50         1h10            40 min
```

O mercado inteiro estima tempo de recarga com uma regra de três — energia
dividida por potência. Ela erra em **40 minutos** num caso comum, e erra
justamente no fim, quando o motorista está decidindo se espera ou vai embora.

O modelo trata os dois regimes reais da bateria (corrente constante até o joelho
da curva, tensão constante depois) e **deriva o joelho da taxa C da sessão** —
porque o afunilamento forte é fenômeno de recarga rápida em corrente contínua,
não de um ponto de 7 kW. Tratar os dois casos com a mesma curva inflava o tempo
de recarga lenta em mais de duas horas.

| Cenário | Taxa C | Joelho | 10% → 80% |
|---|---|---|---|
| CA 7,4 kW · bateria 50 kWh | 0,14 | 92% | 5h26 |
| CC 100 kW · bateria 50 kWh | 1,84 | 58% | 25 min |

O baseline linear está implementado no mesmo arquivo, de propósito: **toda
comparação usa o mesmo código**, e o erro contra o realizado aparece no painel.

---

## Modelo de negócio

**Padrão: recarga como isca comercial.** O motorista não paga; a loja absorve o
custo como marketing e ganha no consumo dentro do estabelecimento. Com cortesia
condicionada — grátis até X kWh mediante compra mínima, tarifa de ociosidade
depois de cheio — para a vaga não virar estacionamento.

**Modo alternativo: pagamento por kWh**, com divisão de receita. Fica disponível
como configuração por ponto, para estacionamento pago e posto de estrada.

A justificativa completa está no [dossiê](docs/index.html#modelo). O resumo: no
modelo de isca, **o software é obrigatório** — sem medir o retorno o lojista não
aprova o investimento. É o que faz a GoodWe vender software junto com o
equipamento, em vez de só equipamento.

---

## Método

1. **Nada é treinado em dado que nós mesmos inventamos.** Sintético serve para
   testar o sistema, nunca para afirmar acurácia.
2. **Todo número tem baseline ao lado.** "Melhoramos X" só existe em relação a algo.
3. **O erro do modelo fica visível no produto.** Um sistema que expõe o próprio
   erro é o oposto de uma caixa-preta.
4. **Procedência no código.** Cada constante traz no comentário de onde veio.

---

## Fontes

- Mercado: ABVE, dados de 2026 — 21.061 pontos, 19,6 veículos por ponto
- Tarifa: Resolução Homologatória ANEEL nº 3.596/2026, Enel SP, classe B1 — R$ 0,789/kWh
- Regulação de recarga: REN ANEEL 819/2018 — venda livre, sem concessão
- Medições de campo: LAB FIAP Eco Smart Home, plataforma SEMS+ da GoodWe
