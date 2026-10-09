/*
 * Sprint 12 runtime test firmware (R2, HC-SR04). Not a product artifact.
 * TRIG on GPIO5, ECHO on GPIO18 (through the circuit's divider). Every 100 ms: a 10 us trigger,
 * then pulseIn(HIGH, 30 ms); prints "D <echo us>" (0: no echo within the timeout).
 */
const int TRIG = 5;
const int ECHO = 18;

void setup() {
  Serial.begin(115200);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  digitalWrite(TRIG, LOW);
  Serial.println("TBI-HCSR04-READY");
}

void loop() {
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 30000);
  Serial.printf("D %lu\n", us);
  delay(100);
}
