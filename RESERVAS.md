# Reservar uma vaga

Quem dirige escolhe uma vaga no mapa, um horário, e paga **R$ 10,00** da carteira.
O valor volta inteiro se a pessoa cancelar a tempo, e vira crédito da recarga se
ela aparecer. A vaga fica dela naquela hora.

O código está em [`api/reservas.py`](api/reservas.py); a tela, em
[`docs/painel/mapa.js`](docs/painel/mapa.js).

## As regras, e por que cada uma existe

| Regra | Valor | Por quê |
|---|---|---|
| Valor | R$ 10,00 | Reserva grátis é reserva que ninguém honra. O valor existe para doer um pouco se a pessoa não aparecer — não para faturar. |
| Duração | 60 min | Uma recarga típica de oportunidade. Mais que isso, a vaga fica parada. |
| Antecedência mínima | 15 min | Reservar para daqui a dois minutos é ocupar a vaga de quem já está lá. |
| Janela máxima | 14 dias | Além disso, a pessoa esquece. |
| Cancelamento com devolução | até 30 min antes | Depois disso a vaga já deixou de ser oferecida a outra pessoa. |
| "Cheguei" | até 15 min antes | Chegar cedo é normal; o depósito vira crédito da recarga. |
| Reservas simultâneas | 3 | Sem teto, uma conta bloqueia um bairro inteiro de graça. |

Duas reservas não podem se sobrepor na mesma vaga, e isso **não** é conferido em
Python: é uma restrição `EXCLUDE USING gist` no banco. Conferir na aplicação
deixaria a janela entre o `SELECT` e o `INSERT` aberta para duas pessoas
reservando ao mesmo tempo. O banco recusa a segunda, sempre.

## Quem chega sem reserva, e a reserva de outra pessoa está perto

> *A reserva das 14h às 15h. B chega às 13h30, sem reserva, e quer carregar 40
> minutos — o que comeria dez minutos do horário de A.*

Nem "quem chegou primeiro leva", senão a reserva não vale nada e ninguém paga
por ela. Nem "a vaga fica bloqueada esperando", senão ela passa metade do dia
vazia. A regra é a do estacionamento de aeroporto: **a vaga fica livre até a
reserva, e não um minuto além.** Isso se sustenta em três camadas.

### 1. Prevenção — o carregador só libera o que cabe

`GET /vagas/{id}/disponibilidade` responde **em minutos**:

```json
{ "pode_iniciar": true, "minutos_disponiveis": 30, "minimo_sessao_min": 10,
  "proxima_reserva": { "inicio": "...", "fim": "..." },
  "recado": "Você tem 30 min até a próxima reserva." }
```

O carregador consulta antes de liberar energia, e mostra o recado **antes** de
começar — é o aviso antes que faz a regra ser justa em vez de surpresa. Abaixo
de `MINIMO_SESSAO_MIN` (10 min) nem começa: melhor mandar para a vaga do lado do
que deixar plugar e desplugar em seguida.

### 2. Dissuasão — a taxa de ociosidade

Já existia antes das reservas, e é o que faz o carro sair depois que a energia
para: `carregadores.carencia_min` (15 min de tolerância) e
`carregadores.taxa_ociosidade_min` (R$ 0,20/min). A prevenção decide **quanto**
B carrega; a ociosidade decide **quanto tempo** ele fica.

### 3. Compensação — PENDENTE

Se B ignorar as duas camadas e o carro continuar lá às 14h, A perde o horário —
e hoje perde os R$ 10 também, porque cancelar em cima da hora não devolve.

**O que falta:** devolver o valor automaticamente quando a vaga estiver ocupada
no início da reserva.

**Por que ainda não foi feito:** depende de um sinal que não existe. O servidor
não sabe se há um carro plugado; ele conhece reservas, não sessões físicas. Um
botão de "não consegui usar" resolveria na tela e seria abusável — qualquer um
clicaria.

**O que destrava:** o carregador (ou a telinha da vaga) reportando ocupação. Com
esse sinal, a regra é curta: se `inicio` chegou e a vaga está ocupada por quem
não é o dono da reserva, lançar `estorno_reserva` e marcar a reserva como
`frustrada`. A máquina de estorno já existe e já é usada no cancelamento — o que
falta é o gatilho, não o dinheiro.

Enquanto isso, o caminho é manual: a pessoa fala com a loja, e a devolução entra
como um lançamento de `estorno_reserva` em `carteira_lancamentos`, com a
`referencia` apontando para a reserva. O saldo é a soma dos lançamentos, então
não há nenhum número a corrigir além disso.

## O que a tela mostra

Uma vaga reservada **não some do mapa** — some seria o oposto do que reservar
deveria fazer. Ela continua lá, e a tela diz *quando*:

- Livre agora, reservada mais tarde → pino normal, com "Reservada hoje ·
  14:00–15:00" ao lado.
- Reservada **neste** momento → pino cinza e "Indisponível".

Reserva vale para um horário, e era justamente o horário que faltava na tela: se
a vaga volta em quinze minutos vale esperar, se é amanhã não vale.
