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

> ⚠️ **Antes de montar, baixe a demanda contratada de 75 kW para 20 kW** no
> painel: *Perfil e configurações → A sua loja → Energia da rede*. Com 75 kW
> sobram 53 kW e os dois carros cabem folgados — **o leilão nunca dispara**.
> Com 20 kW: às 19h sobram 11 kW, um carro cabe e dois disputam. De dia o sol
> levanta o teto e os dois cabem. É a história inteira numa frase.

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
