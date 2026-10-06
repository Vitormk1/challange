/* Smart Charge — a maquete.
 *
 * Roda num Arduino Mega 2560. Duas vagas de recarga, o telhado solar, a
 * bateria da loja e a rede, em LED, numa protoboard.
 *
 * O QUE E REAL E O QUE E SIMULADO. Importa dizer, porque a banca vai
 * perguntar:
 *
 *   REAL      as duas vagas. Carro detectado -> sessao de verdade no banco de
 *             producao, pela mesma API que a telinha usa. Aparece no painel do
 *             lojista, no historico e na curva de demanda.
 *   SIMULADO  o sol, a bateria e a rede. O Mega roda aqui a mesma logica que
 *             `ai/demanda.py` roda no servidor, para a maquete poder mostrar o
 *             dia inteiro em 20 segundos. Nao existe sensor de geracao ligado
 *             na API -- isso seria telemetria, e e passo seguinte.
 *
 * O MEGA NAO FALA COM O SERVIDOR. Ele nao tem rede, e mesmo com Ethernet nao
 * faria TLS: 8 KB de RAM nao sustentam HTTPS. Quem fala e a `ponte.py`, no
 * notebook, ligada por USB. O Mega so escreve e le linhas de texto na serial.
 *
 * Protocolo, uma linha por evento, campos separados por ponto e virgula:
 *
 *   Mega -> ponte                    ponte -> Mega
 *     OLA                              CFG;vaga=1;kw=7.40;preco=1.60;ponta=0
 *     CARRO;vaga=1                     LEILAO;vaga=1;pct=30;fator=2.00
 *     LEITURA;vaga=1;soc=..;kw=..;kwh=..   SEMLEILAO;vaga=1
 *     FIM;vaga=1                       OK;vaga=1
 *     OFERTA;vaga=1;pct=30             ERRO;vaga=1
 *
 * Texto simples, e nao JSON, de proposito: emitir JSON e facil, mas receber
 * exigiria uma biblioteca de parser e a RAM aqui e pouca. `strtok` resolve.
 */

#include <stdarg.h>
#include <Servo.h>

// ---------------------------------------------------------------- pinos ---
//
// Montagem numa protoboard grande. Todo LED leva resistor de 220R a 330R em
// serie -- o pino do Mega entrega 20 mA com folga, mas sem resistor o LED
// morre e o pino pode ir junto.

// display de 7 segmentos, um digito, catodo comum: mostra a carga da bateria
// em dezenas (7 = 70%). Um digito nao mostra "100", entao 100% vira 9.
const uint8_t SEG[7] = {2, 3, 4, 5, 6, 7, 8};   // a b c d e f g

const uint8_t PINO_SERVO = 9;                   // ponteiro do medidor

const uint8_t TRIG = 22, ECHO = 23;             // HC-SR04: carro na vaga 1
const uint8_t BOTAO_VAGA2 = 24;                 // carro plugado na vaga 2
const uint8_t BOTAO_CHEIA = 25;                 // leilao: potencia cheia
const uint8_t BOTAO_ECONOMIA = 26;              // leilao: menos kW, mais credito
const uint8_t PIR = 27;                         // motorista entrando na loja
const uint8_t BUZZER = 28;

const uint8_t LED_SOL[4]  = {30, 31, 32, 33};   // amarelos: geracao solar
const uint8_t LED_PISO    = 38;                 // vermelho: bateria no piso
const uint8_t LED_REDE[2] = {39, 40};           // vermelhos: consumo da rede
const uint8_t LED_LOJA    = 41;                 // branco: a loja consumindo
const uint8_t LED_VAGA[2][2] = {{42, 43},       // {verde carregando, amarelo limitado}
                                {44, 45}};

const uint8_t LDR = A0;                         // luz ambiente -> nuvem
const uint8_t POT = A1;                         // relogio do dia

// ------------------------------------------------------------ constantes ---

// Quanto o dia corre mais rapido que o relogio. O mesmo numero que a telinha
// usa por padrao (ver docs/vaga/vaga.js), para as duas demonstracoes terem o
// mesmo ritmo.
const unsigned long ACELERACAO = 180;

const float BATERIA_CARRO_KWH = 60.0;   // carro tipico de passeio
const float SOC_CHEIO = 0.995;

// A loja da maquete e a Pet & Cia Vila Mariana: 30 kWp de telhado, bateria de
// 20 kWh / 10 kW, 18 kW de consumo proprio e 20 kW contratados. Os mesmos
// numeros que estao no cadastro -- se mudarem la, mudar aqui.
const float SOLAR_KWP      = 30.0;
const float BATERIA_KWH    = 20.0;
const float BATERIA_KW     = 10.0;
const float BATERIA_PISO   = 0.10;
const float CARGA_BASE_KW  = 18.0;
const float CONTRATADA_KW  = 20.0;
const uint8_t PONTA_INICIO = 18, PONTA_FIM = 21;

const unsigned long PASSO_MS   = 100;   // quantas vezes por segundo o mundo anda
const unsigned long LEITURA_MS = 2000;  // de quanto em quanto reporta a ponte

// --------------------------------------------------------------- estado ---

struct Vaga {
  bool ocupada;
  bool aberta;            // a ponte confirmou que a sessao existe no banco
  float soc;              // carga do carro, 0 a 1
  float kwh;              // energia entregue nesta sessao
  float kw_max;           // o que a vaga aceita (vem do cadastro)
  float kw_liberado;      // o que o servidor permite AGORA
  bool limitado;          // o servidor cortou a potencia
  bool leilao;            // ha oferta na mesa
  float oferta_pct;       // a oferta de economia
  unsigned long ultimo_envio;
};

Vaga vagas[2];
float bateria_soc = 0.55;
float hora_do_dia = 12.0;
bool em_ponta = false;
float sol_kw = 0.0, rede_kw = 0.0, bateria_kw = 0.0;
bool ponta_avisada = false, piso_avisado = false;

Servo ponteiro;
char linha[96];
uint8_t n_linha = 0;

// ---------------------------------------------------------------- sol -----

/* A geracao, pela mesma forma que `ai/demanda.py` usa: a altura do sol manda,
 * e o resto e proporcional. Aqui sem a equacao de Cooper -- a maquete anda o
 * dia inteiro em 20 segundos, e a declinacao do dia do ano nao muda nada
 * visivel nessa escala. O que muda, e muito, e a nuvem: e o LDR.
 */
float geracao_kw(float hora, float luz) {
  if (hora < 6.0 || hora > 18.0) return 0.0;
  float arco = (hora - 6.0) / 12.0;             // 0 ao nascer, 1 ao por
  float altura = sin(arco * PI);                // meio-dia no topo
  return SOLAR_KWP * altura * 0.80 * luz;       // 0.80 = rendimento do sistema
}

// ------------------------------------------------------------- serial -----

void manda(const char *fmt, ...) {
  char buf[80];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  Serial.println(buf);
}

/* Le `chave=valor` de uma linha ja quebrada por `strtok`. Devolve o padrao
 * quando a chave nao veio -- a ponte pode mandar so o que mudou. */
float campo(char *resto, const char *chave, float padrao) {
  char busca[16];
  snprintf(busca, sizeof(busca), ";%s=", chave);
  char *p = strstr(resto, busca);
  if (!p) return padrao;
  return atof(p + strlen(busca));
}

void processa(char *l) {
  if (strncmp(l, "CFG", 3) == 0) {
    int v = (int)campo(l, "vaga", 1) - 1;
    if (v < 0 || v > 1) return;
    vagas[v].kw_max = campo(l, "kw", 7.4);
    vagas[v].kw_liberado = vagas[v].kw_max;
    em_ponta = campo(l, "ponta", 0) > 0.5;
  } else if (strncmp(l, "LEILAO", 6) == 0) {
    int v = (int)campo(l, "vaga", 1) - 1;
    if (v < 0 || v > 1) return;
    vagas[v].leilao = true;
    vagas[v].oferta_pct = campo(l, "pct", 30);
  } else if (strncmp(l, "SEMLEILAO", 9) == 0) {
    int v = (int)campo(l, "vaga", 1) - 1;
    if (v >= 0 && v <= 1) vagas[v].leilao = false;
  } else if (strncmp(l, "OK", 2) == 0) {
    int v = (int)campo(l, "vaga", 1) - 1;
    if (v >= 0 && v <= 1) vagas[v].aberta = true;
  } else if (strncmp(l, "LIBERA", 6) == 0) {
    // O servidor repartiu a potencia. E este o momento em que a maquete
    // obedece ao sistema em vez de simular sozinha.
    int v = (int)campo(l, "vaga", 1) - 1;
    if (v < 0 || v > 1) return;
    vagas[v].kw_liberado = campo(l, "kw", vagas[v].kw_max);
    vagas[v].limitado = vagas[v].kw_liberado < vagas[v].kw_max - 0.05;
  }
}

void le_serial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (n_linha) { linha[n_linha] = 0; processa(linha); n_linha = 0; }
    } else if (n_linha < sizeof(linha) - 1) {
      linha[n_linha++] = c;
    }
  }
}

// ------------------------------------------------------------ sensores ----

/* Distancia em cm, ou SEM_LEITURA quando a medida nao vale.
 *
 * "Nao vale" cobre dois casos que sao a MESMA coisa para o sensor e coisas
 * opostas para a maquete:
 *
 *   sem eco      o pulso saiu e nao voltou. Pode ser vaga vazia -- ou um carro
 *                encostado no sensor, porque o HC-SR04 nao mede abaixo de 2 cm.
 *   eco absurdo  abaixo de 2 cm o numero e ruido.
 *
 * A primeira versao devolvia 999 nos dois casos, o que significava "vazio".
 * Com o sensor deitado na bancada apontando para a mesa, a vaga ficava ocupada
 * o tempo todo, e encostar a mao fazia o eco sumir e a vaga "esvaziar": o
 * comportamento saia invertido, sem a fiacao ter nada de errado.
 *
 * O timeout de 20 ms tambem importa: sem ele, um sensor desligado trava o
 * `loop` por 30 ms a cada volta e a maquete inteira engasga.
 */
const long SEM_LEITURA = -1;
const long PERTO_CM = 8;

long distancia_cm() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 20000UL);
  if (!us) return SEM_LEITURA;
  long cm = (long)(us / 58);
  return (cm < 2 || cm > 400) ? SEM_LEITURA : cm;
}

/* A vaga 1 esta ocupada?
 *
 * Nao basta ler uma vez. Ultrassom e ruidoso, e UMA leitura ruim abriria ou
 * fecharia uma sessao -- no banco de producao. Pior: `abrir_sessao` aceita 12
 * aberturas por vaga a cada 10 minutos, e o ruido estouraria esse limite em
 * segundos, deixando a maquete muda bem na hora da demonstracao.
 *
 * Entao o estado so muda depois de LEITURAS_FIRMES leituras seguidas
 * concordando. Leitura invalida nao conta para lado nenhum: nao confirma nem
 * desmente, apenas nao avanca o contador.
 */
const uint8_t LEITURAS_FIRMES = 5;

// A ultima medida boa, para o diagnostico mostrar sem disparar outro ping --
// dois pulsos seguidos se atrapalham, o eco de um chega durante o outro.
long ultima_distancia = SEM_LEITURA;

bool vaga1_ocupada(bool estado_atual) {
  static uint8_t a_favor = 0, contra = 0;
  long cm = distancia_cm();
  ultima_distancia = cm;
  if (cm == SEM_LEITURA) return estado_atual;

  bool perto = cm <= PERTO_CM;
  if (perto == estado_atual) { a_favor = contra = 0; return estado_atual; }

  if (perto) { a_favor++; contra = 0; } else { contra++; a_favor = 0; }
  if (a_favor >= LEITURAS_FIRMES || contra >= LEITURAS_FIRMES) {
    a_favor = contra = 0;
    return perto;
  }
  return estado_atual;
}

// ------------------------------------------------------------- display ---

const uint8_t DIGITO[10] = {
  0b0111111, 0b0000110, 0b1011011, 0b1001111, 0b1100110,
  0b1101101, 0b1111101, 0b0000111, 0b1111111, 0b1101111,
};

void mostra_digito(uint8_t n) {
  if (n > 9) n = 9;
  for (uint8_t i = 0; i < 7; i++)
    digitalWrite(SEG[i], (DIGITO[n] >> i) & 1);
}

void barra(const uint8_t *pinos, uint8_t quantos, float fracao) {
  uint8_t acesos = (uint8_t)(fracao * quantos + 0.5);
  for (uint8_t i = 0; i < quantos; i++)
    digitalWrite(pinos[i], i < acesos ? HIGH : LOW);
}

// ---------------------------------------------------------------- setup ---

void setup() {
  Serial.begin(115200);

  for (uint8_t i = 0; i < 7; i++) pinMode(SEG[i], OUTPUT);
  for (uint8_t i = 0; i < 4; i++) pinMode(LED_SOL[i], OUTPUT);
  for (uint8_t i = 0; i < 2; i++) pinMode(LED_REDE[i], OUTPUT);
  for (uint8_t v = 0; v < 2; v++)
    for (uint8_t i = 0; i < 2; i++) pinMode(LED_VAGA[v][i], OUTPUT);
  pinMode(LED_PISO, OUTPUT);
  pinMode(LED_LOJA, OUTPUT);
  pinMode(BUZZER, OUTPUT);

  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  pinMode(PIR, INPUT);
  // Com INPUT_PULLUP o botao liga o pino ao GND e nao precisa de resistor
  // externo -- um fio a menos por botao, e sao tres.
  pinMode(BOTAO_VAGA2, INPUT_PULLUP);
  pinMode(BOTAO_CHEIA, INPUT_PULLUP);
  pinMode(BOTAO_ECONOMIA, INPUT_PULLUP);

  ponteiro.attach(PINO_SERVO);
  ponteiro.write(0);

  for (uint8_t v = 0; v < 2; v++) {
    vagas[v] = {false, false, 0.0, 0.0, 22.0, 22.0, false, false, 0.0, 0};
  }

  digitalWrite(LED_LOJA, HIGH);   // a loja consome o tempo todo
  manda("OLA");
}

// ----------------------------------------------------------------- loop ---

unsigned long t_anterior = 0;

void loop() {
  le_serial();

  unsigned long agora = millis();
  if (agora - t_anterior < PASSO_MS) return;
  float dt_s = (agora - t_anterior) / 1000.0;
  t_anterior = agora;

  // ---- o relogio do dia, na mao de quem apresenta ----
  // O potenciometro escolhe a hora. E isso que deixa mostrar o dia inteiro --
  // sol subindo, bateria enchendo, ponta chegando, bateria entregando, piso --
  // sem esperar ate as sete da noite.
  hora_do_dia = analogRead(POT) * 24.0 / 1023.0;
  bool ponta_agora = (hora_do_dia >= PONTA_INICIO && hora_do_dia < PONTA_FIM);

  // ---- o sol, de verdade ----
  // O LDR nao e enfeite: tapar com a mao e uma nuvem, e a geracao cai na hora.
  float luz = constrain(analogRead(LDR) / 700.0, 0.0, 1.0);
  sol_kw = geracao_kw(hora_do_dia, luz);

  // ---- as vagas ----
  bool carro1 = vaga1_ocupada(vagas[0].ocupada);
  bool carro2 = digitalRead(BOTAO_VAGA2) == LOW;
  bool chegou[2] = {carro1, carro2};

  /* Uma linha de diagnostico por segundo, para quem esta na bancada com o
     Monitor Serial aberto e sem a ponte rodando. Comeca com '#', e a ponte
     ignora linhas assim -- do contrario o log dela viraria ruido. */
  static unsigned long t_diag = 0;
  if (agora - t_diag >= 1000) {
    t_diag = agora;
    long cm = ultima_distancia;
    char buf[16];
    dtostrf(hora_do_dia, 0, 1, buf);
    manda("# dist=%ld vaga1=%d vaga2=%d hora=%s luz=%d",
          cm, carro1 ? 1 : 0, carro2 ? 1 : 0, buf, (int)(luz * 100));
  }

  float carregando_kw = 0.0;
  for (uint8_t v = 0; v < 2; v++) {
    Vaga &x = vagas[v];

    if (chegou[v] && !x.ocupada) {
      x = {true, false, 0.25, 0.0, x.kw_max, x.kw_max, false, false, 0.0, agora};
      manda("CARRO;vaga=%d", v + 1);
    } else if (!chegou[v] && x.ocupada) {
      manda("FIM;vaga=%d", v + 1);
      x.ocupada = false; x.aberta = false; x.leilao = false;
      digitalWrite(LED_VAGA[v][0], LOW);
      digitalWrite(LED_VAGA[v][1], LOW);
    }

    if (!x.ocupada) continue;

    // Carrega no ritmo que o SERVIDOR liberou, nao no que a vaga aguenta.
    float kw = x.kw_liberado;
    if (x.soc >= SOC_CHEIO) kw = 0.0;
    float entregue = kw * (dt_s * ACELERACAO) / 3600.0;
    x.kwh += entregue;
    x.soc = min(1.0, x.soc + entregue / BATERIA_CARRO_KWH);
    carregando_kw += kw;

    digitalWrite(LED_VAGA[v][0], kw > 0.1 ? HIGH : LOW);
    digitalWrite(LED_VAGA[v][1], x.limitado ? HIGH : LOW);

    if (agora - x.ultimo_envio >= LEITURA_MS) {
      x.ultimo_envio = agora;
      char s[12], k[12], e[12];
      dtostrf(x.soc, 0, 3, s);
      dtostrf(kw, 0, 2, k);
      dtostrf(x.kwh, 0, 3, e);
      manda("LEITURA;vaga=%d;soc=%s;kw=%s;kwh=%s", v + 1, s, k, e);
    }
  }

  // ---- o leilao, decidido no botao ----
  // Os dois botoes valem para a vaga que tiver oferta na mesa. Numa maquete
  // com duas vagas nao vale um par de botoes por vaga: sao quatro fios a mais
  // para uma escolha que acontece uma vez por carro.
  for (uint8_t v = 0; v < 2; v++) {
    if (!vagas[v].leilao) continue;
    if (digitalRead(BOTAO_CHEIA) == LOW) {
      manda("OFERTA;vaga=%d;pct=100", v + 1);
      vagas[v].leilao = false;
      tone(BUZZER, 880, 60);
    } else if (digitalRead(BOTAO_ECONOMIA) == LOW) {
      char p[10]; dtostrf(vagas[v].oferta_pct, 0, 0, p);
      manda("OFERTA;vaga=%d;pct=%s", v + 1, p);
      vagas[v].leilao = false;
      tone(BUZZER, 1320, 60);
    }
  }

  // ---- a bateria da loja, pela mesma politica do servidor ----
  // Ordem igual a de `plano_do_dia`: sobra de sol enche; na ponta entrega.
  float consumo = CARGA_BASE_KW + carregando_kw;
  float sobra = sol_kw - consumo;
  bateria_kw = 0.0;
  if (sobra > 0 && bateria_soc < 1.0) {
    bateria_kw = -min(sobra, BATERIA_KW);
  } else if (ponta_agora && bateria_soc > BATERIA_PISO) {
    bateria_kw = min(consumo - sol_kw, BATERIA_KW);
  }
  bateria_soc = constrain(
      bateria_soc - bateria_kw * (dt_s * ACELERACAO) / 3600.0 / BATERIA_KWH,
      0.0, 1.0);

  rede_kw = max(0.0, consumo - sol_kw - bateria_kw);

  // ---- o que a maquete mostra ----
  barra(LED_SOL, 4, sol_kw / (SOLAR_KWP * 0.8));
  barra(LED_REDE, 2, rede_kw / CONTRATADA_KW);
  mostra_digito((uint8_t)(bateria_soc * 10));
  bool no_piso = bateria_soc <= BATERIA_PISO + 0.005;
  digitalWrite(LED_PISO, no_piso ? HIGH : LOW);

  // O ponteiro mede a potencia que vem da REDE contra a contratada. E o numero
  // que vira multa na fatura, e o unico que o lojista nao pode ignorar.
  ponteiro.write((int)constrain(rede_kw / CONTRATADA_KW * 180.0, 0, 180));

  // ---- os avisos ----
  if (ponta_agora && !ponta_avisada) { tone(BUZZER, 440, 300); ponta_avisada = true; }
  if (!ponta_agora) ponta_avisada = false;
  if (no_piso && !piso_avisado) { tone(BUZZER, 220, 600); piso_avisado = true; }
  if (!no_piso) piso_avisado = false;

  em_ponta = ponta_agora;
}
