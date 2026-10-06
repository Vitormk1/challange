# A maquete do Smart Charge

Um Arduino Mega numa protoboard, ligado por USB a um notebook, abrindo sessões
de recarga **de verdade** no banco de produção.

## O que é real e o que é simulado

Importa dizer, porque é a primeira pergunta de uma banca.

| | |
|---|---|
| **real** | as duas vagas. Carro detectado → sessão no banco de produção, pela mesma API que a telinha usa. Aparece no painel do lojista, no histórico e na curva de demanda |
| **real** | o leilão de potência. Quando falta folga, é o **servidor** que diz e manda as ofertas; a maquete só mostra e obedece |
| **simulado** | o sol, a bateria e a rede. O Mega roda a mesma lógica que `ai/demanda.py` roda no servidor, para mostrar o dia inteiro em 20 segundos |

Nenhum sensor de geração alimenta a API — isso seria telemetria, e é o passo
seguinte, não o atual.

## Por que precisa do notebook

O Mega não tem rede, e **mesmo com Ethernet não resolveria**: nossa API é HTTPS
com HSTS, e 8 KB de RAM não sustentam TLS 1.2. Quem fala HTTPS é a `ponte.py`.

Um ESP32 (~R$ 30) faria isso sozinho no futuro — Ethernet shield **não**, porque
o problema é o TLS, não o meio físico.

## A loja

**Pet & Cia Vila Mariana**, vagas `id=1` e `id=2`. 30 kWp de telhado, bateria de
20 kWh / 10 kW, 18 kW de consumo próprio.

As vagas são de **22 kW** (wallbox trifásico, o padrão comercial) e a loja tem
**20 kW contratados** — ajustado em 06/10/2026 para o leilão ser demonstrável.

Por que esses números: com os 75 kW contratados e vagas de 7,4 kW que havia
antes, sobravam 53 kW, os dois carros cabiam folgados e **o leilão nunca
disparava**. Com 20 kW contratados e vagas de 22 kW:

| hora | um carro | dois carros |
|---|---|---|
| 10h e 14h | cabe | **leilão** |
| 19h | **leilão** | **leilão** |

De dia o sol dá espaço para um; o segundo tem de negociar. À noite, sem sol,
até um sozinho negocia. Dá para demonstrar a qualquer hora.

Para voltar ao que era: `demanda_contratada_kw = 75` no estabelecimento 1 e
`potencia_kw = 7.4` nos carregadores 1 e 2.

## Montagem, na ordem

Monte **em quatro etapas e teste cada uma**. Ligar 12 LEDs, um display, três
botões e três sensores de uma vez e só então ligar a USB é a receita para
passar a noite procurando um fio.

### Etapa 1 — a placa viva (5 min)

Só o Mega no USB. Abra a Arduino IDE, escolha *Ferramentas → Placa → Arduino
Mega or Mega 2560* e a porta. Carregue o sketch. Abra o *Monitor Serial* em
**115200** — tem de aparecer `OLA`.

Se não aparecer, o problema é placa/porta/baud, e não vale seguir.

### Etapa 2 — as vagas (20 min)

O que faz a maquete existir. Nesta etapa ela já abre sessão de verdade.

1. **HC-SR04**: VCC→5V, GND→GND, TRIG→D22, ECHO→D23.
2. **Botão da vaga 2**: uma perna no D24, a outra no GND. Sem resistor —
   o sketch usa `INPUT_PULLUP`.
3. **LED verde da vaga 1**: D42 → resistor 220 Ω → perna longa do LED;
   perna curta → GND. Repita o verde da vaga 2 no D44.
4. Rode `python fisico/ponte.py --porta COMx`. Aproxime a mão do HC-SR04:
   o LED acende e o terminal mostra `sessao aberta · token ...`.
5. **Abra o painel do lojista.** A sessão está lá. Esta é a etapa que prova
   que a maquete é real.

### Etapa 3 — a energia (30 min)

1. **LDR**: uma perna no 5V, a outra no A0 **e** num resistor de 10 kΩ que vai
   ao GND. É um divisor de tensão — sem o resistor, o A0 lê lixo.
2. **Potenciômetro**: pernas das pontas no 5V e no GND, perna do meio no A1.
3. **4 LEDs amarelos** nos D30–D33, cada um com resistor.
4. **2 LEDs vermelhos** nos D39–D40 e **1 branco** no D41.
5. **LED vermelho do piso** no D38.
6. Gire o potenciômetro: os amarelos acompanham o dia. Tape o LDR: apagam.

### Etapa 4 — o resto (30 min)

1. **7 segmentos**: catodo comum → GND; os segmentos a,b,c,d,e,f,g nos
   D2–D8, **cada um com seu resistor de 220 Ω**.
2. **LEDs amarelos das vagas** (potência cortada) nos D43 e D45.
3. **Botões do leilão** nos D25 e D26, o outro lado no GND.
4. **Buzzer**: positivo no D28, negativo no GND.
5. **Servo**: laranja/amarelo→D9, vermelho→5V, marrom→GND.
6. **PIR** (opcional): OUT→D27, VCC→5V, GND→GND.

> O servo puxa corrente quando se move. Se a placa reiniciar sozinha ao mexer o
> ponteiro, alimente o servo por fora (as duas pilhas AA + suporte) com o GND
> ligado ao do Mega. Pela USB sozinha costuma funcionar com um SG90 sem carga.

## Ligações

Protoboard grande, Mega 2560. **Todo LED leva resistor de 220 Ω a 330 Ω** em
série — sem ele o LED morre e o pino pode ir junto.

### Saídas

| pino | componente | o que mostra |
|---|---|---|
| D2–D8 | 7 segmentos, 1 dígito (a,b,c,d,e,f,g) | carga da bateria em dezenas (7 = 70%) |
| D9 | micro servo SG90 | ponteiro: potência vinda da rede contra a contratada |
| D28 | buzzer | entrada na ponta · bateria no piso |
| D30–D33 | 4 LEDs **amarelos** | geração solar |
| D38 | LED **vermelho** | bateria no piso de 10% — a rede assumiu |
| D39–D40 | 2 LEDs **vermelhos** | consumo vindo da rede |
| D41 | LED **branco** | a loja consumindo (sempre aceso) |
| D42 / D43 | LED **verde** / **amarelo** | vaga 1: carregando / potência cortada |
| D44 / D45 | LED **verde** / **amarelo** | vaga 2: idem |

São **12 LEDs** mais o display. O 7 segmentos substituiu a barra de bateria —
quatro LEDs e quatro resistores a menos para montar.

### Entradas

| pino | componente | papel |
|---|---|---|
| D22 / D23 | HC-SR04 (TRIG / ECHO) | carro na vaga 1, a 8 cm ou menos |
| D24 | botão | carro plugado na vaga 2 |
| D25 | botão | leilão: **potência cheia** |
| D26 | botão | leilão: **menos kW, mais crédito** |
| D27 | PIR HC-SR501 | motorista entrando na loja (opcional) |
| A0 | LDR (divisor com 10 kΩ para o GND) | **o sol** — tapar com a mão é uma nuvem |
| A1 | potenciômetro | **o relógio do dia** |

Os três botões usam `INPUT_PULLUP`: ligam o pino ao GND e **não precisam de
resistor externo**. Um fio a menos por botão.

O HC-SR04 trabalha em 5 V e o Mega também — não precisa de divisor no ECHO
(isso é exigência de placas de 3,3 V).

## Rodando

```bash
pip install pyserial

python fisico/ponte.py --portas          # descobre onde o Mega está
python fisico/ponte.py --porta COM3      # liga a maquete à produção
python fisico/ponte.py --simular         # testa sem nenhum fio ligado
```

O `--simular` roda um carro inteiro contra a produção e é a primeira coisa a
fazer: se ele funciona e a maquete não, o problema está na fiação, não no
código.

A ponte **acorda o servidor** no arranque. O Render do plano gratuito hiberna
depois de ~15 min sem uso e leva uns 50 s para voltar — sem isso, o primeiro
carro da apresentação falharia, que é justamente o que o jurado veria.

## O roteiro da demonstração

1. **Gire o potenciômetro para o meio-dia.** Os LEDs amarelos acendem, a
   bateria enche, o ponteiro da rede cai.
2. **Tape o LDR com a mão.** A geração despenca e a rede volta a subir — é a
   nuvem passando.
3. **Aproxime o carro da vaga 1.** O HC-SR04 detecta, a ponte abre a sessão
   **no banco de produção**, e o LED verde acende. *Abra o dashboard: a sessão
   está lá.*
4. **Gire o potenciômetro para as 19h.** O buzzer avisa a ponta, a bateria
   começa a entregar, o dígito desce.
5. **Aperte o botão da vaga 2.** Agora faltam kW: o servidor devolve as ofertas
   e o leilão aparece.
6. **Escolha "menos kW, mais crédito".** O LED amarelo da vaga acende — a
   potência foi cortada, e o cashback daquela recarga vale o dobro. *No
   dashboard, a sessão mostra o fator do leilão.*
7. **Deixe a bateria chegar aos 10%.** O LED vermelho acende, o buzzer toca
   grave, e os dois LEDs da rede ficam acesos: a loja passou para a rede.

## Peças que ficaram de fora, e por quê

- **L298N** — é driver de motor. Não há motor na maquete.
- **DHT11** — temperatura afeta o rendimento do painel de verdade, mas numa
  maquete seria penduricalho que rouba atenção do que importa.
- **Arduino Uno** — o Mega tem 54 pinos digitais e sobra espaço. Fica de
  reserva: se um pino queimar na montagem, é mais rápido trocar de placa do que
  depurar.
