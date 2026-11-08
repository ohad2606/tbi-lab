/*
 * C-5 capacity workload (Runtime v5): a GPIO edge interrupt. GPIO25 drives GPIO4 through a resistor; every
 * edge runs the ISR. Bounded: 10 edges per second; each one also costs the host a circuit solve, which is
 * what a real interrupt project costs. The loop prints the ISR count once a second.
 */
volatile uint32_t edges = 0;
void IRAM_ATTR onEdge() { edges = edges + 1; }
void setup() {
  Serial.begin(115200);
  pinMode(25, OUTPUT);
  digitalWrite(25, LOW);
  pinMode(4, INPUT);
  attachInterrupt(digitalPinToInterrupt(4), onEdge, CHANGE);
  Serial.println("C5-IRQ-READY");
}
static bool level = false;
static int n = 0;
void loop() {
  level = !level;
  digitalWrite(25, level ? HIGH : LOW);
  delay(100);
  if (++n % 10 == 0) Serial.printf("C5-IRQ-COUNT %u\n", (unsigned)edges);
}
