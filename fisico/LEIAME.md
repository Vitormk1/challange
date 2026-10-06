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

## Guiado pela protoboard

### Como a protoboard liga, em quatro linhas

- As **colunas** (1 a 63) ligam **cinco furos na vertical**: `a b c d e` é um
  fio só, e `f g h i j` é outro fio só. **O canal do meio separa os dois.**
- As **trilhas das bordas** (`+` vermelha e `−` azul) ligam **na horizontal**,
  ao longo da placa toda.
- **Armadilha das trilhas:** em muitas protoboards grandes a trilha é
  **cortada no meio**. Olhe de perto: se a linha vermelha tem uma falha no
  centro, as duas metades estão separadas e você precisa de um jumper curto
  emendando. Vale ligar por garantia mesmo sem conferir.
- Um LED **tem de ficar em duas colunas diferentes**. Nos cinco furos da mesma
  coluna ele fica em curto e não acende.

### A receita de um LED, que se repete 12 vezes

```
  jumper do pino do Mega  →  coluna N    (perna LONGA, o ânodo)
                             coluna N+1  (perna curta)
                             resistor da coluna N+1 → trilha −
```

Se inverter as pernas, não acende e **não queima nada** — é só virar.

### O mapa das colunas

Decidido de uma vez, para não haver escolha a fazer com as mãos ocupadas:

| colunas | o que vai ali | pino |
|---|---|---|
| 1–5 | display 7 segmentos (atravessa o canal) | D2–D8 |
| 12 / 13 | LED amarelo · sol 1 | D30 |
| 15 / 16 | LED amarelo · sol 2 | D31 |
| 18 / 19 | LED amarelo · sol 3 | D32 |
| 21 / 22 | LED amarelo · sol 4 | D33 |
| 25 / 26 | LED vermelho · rede 1 | D39 |
| 28 / 29 | LED vermelho · rede 2 | D40 |
| 31 / 32 | LED branco · a loja | D41 |
| 34 / 35 | LED vermelho · piso da bateria | D38 |
| 38 / 39 | LED verde · vaga 1 carregando | D42 |
| 41 / 42 | LED amarelo · vaga 1 limitada | D43 |
| 45 / 46 | LED verde · vaga 2 carregando | D44 |
| 48 / 49 | LED amarelo · vaga 2 limitada | D45 |
| 52 | botão · carro na vaga 2 | D24 |
| 54 | botão · leilão potência cheia | D25 |
| 56 | botão · leilão economia | D26 |
| 58 / 59 | LDR + resistor de 10 kΩ | A0 |
| 61–63 | potenciômetro | A1 |

HC-SR04, servo, buzzer e PIR têm pinos próprios e vão por jumpers fêmea-macho
direto do Mega, sem ocupar coluna.

### Passo 0 — energia nas trilhas, antes de tudo

1. Jumper do **5V** do Mega → trilha **+** de cima.
2. Jumper do **GND** do Mega → trilha **−** de cima.
3. Jumper da trilha **+** de cima → trilha **+** de baixo.
4. Jumper da trilha **−** de cima → trilha **−** de baixo.
5. Se a trilha for cortada no meio, mais dois jumpers curtos emendando.

Use **vermelho só para +** e **preto só para −**. Quando algo não funcionar,
você vai agradecer.

### Passo 1 — a vaga 1, e só ela

O mínimo que já abre sessão no banco. **Não monte mais nada antes disto
funcionar.**

1. **HC-SR04**, por jumpers fêmea-macho direto:
   `VCC`→5V · `GND`→GND · `TRIG`→**D22** · `ECHO`→**D23**
2. **LED verde**: perna longa na coluna **38**, curta na **39**.
   Resistor de 220 Ω da **39** até a trilha **−**. Jumper do **D42** à **38**.
3. Suba o sketch, **feche o Monitor Serial**, rode
   `python fisico/ponte.py --porta COMx`.
4. Aproxime a mão a menos de 8 cm. O LED acende e o terminal diz
   `sessao aberta · token ...`.
5. **Abra o painel do lojista.** A sessão está lá.

Se o terminal abriu a sessão mas o LED não acendeu, é a perna invertida ou o
resistor fora da trilha. Se não aconteceu nada, é o sensor.

### Passo 2 — a vaga 2, e o leilão aparece

1. **Botão**: encaixe **atravessando o canal do meio**, na coluna **52**.
2. Jumper do **D24** à coluna **52**, lado de cima (`a`–`e`).
3. Jumper da coluna **52**, lado de baixo (`f`–`j`), até a trilha **−**.
4. **LED verde**: longa na **45**, curta na **46**, resistor da **46** até
   **−**, jumper do **D44** à **45**.

> Botão tem quatro pernas e **duas já vêm ligadas de fábrica**. Atravessando o
> canal você garante lados opostos. Se disparar sozinho, gire 90°.

Com um carro na vaga 1, aperte o botão: **o leilão aparece no terminal**.

### Passo 3 — o sol e o relógio

1. **LDR**: uma perna na coluna **58**, outra na **59**.
   - Jumper da **58** → trilha **+**
   - Resistor de **10 kΩ** da **59** → trilha **−**
   - Jumper da **59** → **A0**
   - Esse resistor **não é opcional**: sem ele o A0 fica solto e lê lixo.
2. **Potenciômetro**: três pernas nas colunas **61, 62, 63**.
   **61**→ **+** · **63**→ **−** · **62**→ **A1**.
   Se o dia andar ao contrário, troque 61 com 63.
3. **4 LEDs amarelos**, pela receita: 12/13, 15/16, 18/19, 21/22, vindo de
   D30, D31, D32 e D33.

Gire o potenciômetro devagar: os amarelos acompanham o dia. Tape o LDR: apagam.

### Passo 4 — rede, loja e piso

| LED | colunas | resistor | jumper |
|---|---|---|---|
| vermelho rede 1 | 25 / 26 | 26 → − | D39 → 25 |
| vermelho rede 2 | 28 / 29 | 29 → − | D40 → 28 |
| branco loja | 31 / 32 | 32 → − | D41 → 31 |
| vermelho piso | 34 / 35 | 35 → − | D38 → 34 |

O branco acende assim que a placa liga e **fica aceso** — é a loja consumindo.
Ele é o seu teste de trilha: se não acendeu, o problema é a energia, não o
sketch.

### Passo 5 — o resto

1. **LEDs amarelos das vagas**: 41/42 vindo do **D43**, 48/49 do **D45**.
2. **Botões do leilão**: colunas **54** (D25) e **56** (D26), como no passo 2.
3. **Buzzer**: perna longa (ou a marcada `+`) numa coluna livre, com jumper até
   o **D28**; a outra perna na trilha **−**.
4. **Servo**: laranja ou amarelo → **D9** · vermelho → **5V** · marrom → **GND**.

### Passo 6 — o display de 7 segmentos

Por último porque é o único cuja pinagem **não dá para afirmar daqui**: muda de
peça para peça. Encaixe atravessando o canal, colunas 1 a 5.

Para descobrir, com a placa ligada:

1. Jumper da trilha **−** até um pino. Esse é o candidato a comum.
2. Com um resistor de 220 Ω, encoste uma ponta na trilha **+** e a outra, um
   por vez, nos demais pinos.
3. Acendeu um risquinho? Você achou o comum, e aquele pino é um segmento. Se
   nenhum acender, tente outro pino como comum.
4. Anote qual pino acende qual risco:

```
     aaa          a = risco de cima        d = risco de baixo
    f   b         b = direito de cima      e = esquerdo de baixo
     ggg          c = direito de baixo     f = esquerdo de cima
    e   c                                  g = risco do meio
     ddd
```

5. Ligue **a→D2 · b→D3 · c→D4 · d→D5 · e→D6 · f→D7 · g→D8**, cada um com seu
   resistor de 220 Ω, e o comum na trilha **−**.

> Se acender **invertido** (apaga o que deveria acender), seu display é
> **ânodo comum**: ligue o comum na trilha **+** e me avise — é uma linha no
> sketch para inverter.

### Quando não funcionar

| sintoma | quase sempre é |
|---|---|
| nenhum LED acende, nem o branco | trilha sem energia, ou cortada no meio |
| um LED só não acende | perna invertida, ou resistor fora da trilha − |
| LED aceso o tempo todo | pernas trocadas de coluna |
| botão dispara sozinho | pernas no mesmo lado do canal — gire 90° |
| o dia anda ao contrário | potenciômetro com + e − trocados |
| a placa reinicia ao mexer o servo | alimente o servo pelas pilhas, GND junto |
| `OLA` sai embaralhado | Monitor Serial fora de 115200 |
| a ponte diz acesso negado | o Monitor Serial da IDE está aberto |

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
