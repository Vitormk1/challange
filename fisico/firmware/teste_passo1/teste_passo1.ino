/* Teste do passo 1 — separa o LED do sensor.
 *
 * Sobe este sketch no lugar do `maquete` quando o LED nao acender. Ele faz
 * duas coisas independentes, e e isso que resolve o problema: se o LED pisca
 * mas a distancia nao muda, o problema e o sensor; se a distancia muda mas o
 * LED nao pisca, o problema e o LED. Nunca os dois ao mesmo tempo.
 *
 * Nao precisa da ponte nem do PowerShell. So a Arduino IDE.
 *
 *   1. Ferramentas -> Placa -> Arduino Mega or Mega 2560
 *   2. Carregar
 *   3. Ferramentas -> Monitor Serial, a 115200
 *
 * O que voce deve ver:
 *
 *   - o LED verde da vaga 1 (D42) piscando 1 segundo aceso, 1 apagado
 *   - uma linha por segundo com a distancia medida
 *
 * Depois de achar o problema, suba o `maquete` de volta.
 */

const uint8_t LED = 42;      // verde da vaga 1
const uint8_t TRIG = 22;
const uint8_t ECHO = 23;

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  Serial.println();
  Serial.println(F("== teste do passo 1 =="));
  Serial.println(F("o LED do D42 tem de piscar sozinho, sem voce fazer nada."));
  Serial.println(F("a distancia tem de mudar quando a mao chega perto."));
  Serial.println();
}

void loop() {
  // --- 1. o LED, sem depender de nada ---
  // Pisca independente do sensor. Se nao piscar, o problema esta no LED, no
  // resistor, na trilha ou no jumper -- e nao adianta olhar o sensor.
  digitalWrite(LED, HIGH);
  delay(1000);
  digitalWrite(LED, LOW);
  delay(1000);

  // --- 2. o sensor ---
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 20000UL);

  if (us == 0) {
    Serial.println(F("sem eco  -> o sensor nao respondeu. "
                     "Confira VCC no 5V, GND no GND, TRIG no 22, ECHO no 23."));
  } else {
    long cm = us / 58;
    Serial.print(F("distancia: "));
    Serial.print(cm);
    Serial.print(F(" cm"));
    if (cm <= 8) Serial.print(F("   <= dispara a vaga (8 cm ou menos)"));
    Serial.println();
  }
}
