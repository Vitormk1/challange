# Praça de Recarga

Challenge FIAP · GoodWe · 2026

Recarga de veículos elétricos **como ativo comercial**. Dois produtos, um sistema:

- **Painel gerencial** — o lojista descobre se o carregador traz cliente e dá retorno
- **Totem do motorista** — tela ao lado da vaga com tempo e custo previstos

> O lojista não quer vender energia. Quer saber se o carregador na frente da loja
> traz cliente. Hoje nenhum painel do mercado responde isso.

**Dossiê:** [`docs/index.html`](docs/index.html) · **Telinha da vaga:** [`docs/vaga/`](docs/vaga/) · **Painel do lojista:** [`docs/painel/`](docs/painel/)

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
  vaga/        a telinha da vaga · serve tambem o celular pelo QR  (pronta)
  painel/      o painel do lojista              (pronto)
api/
  schema.sql   as dez tabelas e as duas visões — o contrato de dados
  db.py        conexão com o PostgreSQL e aplicação do esquema
  seed.py      trinta dias de operação de três lojas, para demonstração
  exportar.py  despeja o banco em docs/painel/dados.json
ai/
  charge_curve.py   previsão de tempo de recarga (o núcleo do produto)
```

---

## Configuração

```bash
pip install -r requirements.txt
cp .env.example .env      # e preencha
python api/db.py          # cria tabelas, índices e visões
python api/seed.py        # popula com dados de demonstração
python api/exportar.py    # gera docs/painel/dados.json para o painel
```

**Nenhuma credencial vai para o repositório.** Tudo vem de variável de ambiente;
o `.gitignore` bloqueia o `.env`. Uma senha commitada em repositório público é
vazamento permanente, mesmo depois de removida.

### PostgreSQL

A `DATABASE_URL` sai do painel do Aiven e tem esta cara:

```
postgres://usuario:senha@host:porta/banco?sslmode=require
```

O `sslmode=require` não é opcional: o Aiven recusa conexão em texto puro.

**As dez tabelas**, e a seção do painel que corresponde a cada uma:

| Tabela | Seção | O que guarda |
|---|---|---|
| `estabelecimentos` | Estabelecimentos | margem, ticket e tarifa — é daqui que sai o teto de cortesia |
| `carregadores` | Carregadores | um modelo comercial por ponto: cortesia ou por kWh |
| `sessoes` | Sessões | cada recarga, com a previsão que foi mostrada ao motorista |
| `leituras` | Leituras | potência e carga de 5 em 5 minutos |
| `clientes` | Clientes | apelido e veículo; a identidade fica só como hash |
| `cupons` | Cupons | o código que liga a recarga à venda |
| `vendas` | Vendas atribuídas | o que a pessoa gastou na loja depois de carregar |
| `paineis` | Painéis salvos | a disposição dos cards, privada ou compartilhada |
| `usuarios`, `usuarios_estabelecimentos` | — | contas e acesso; o lojista não vê nem edita |

Mais as visões `vw_sessoes_detalhe` e `vw_resumo_diario`, que o painel consome
direto sem precisar de junção no cliente.

`sessoes` guarda `previsao_fim` e `previsao_custo_brl` ao lado do resultado
real. É de propósito: sem isso o painel não teria como mostrar o próprio erro,
e uma previsão que ninguém audita não vale nada.

---|---|---|
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
