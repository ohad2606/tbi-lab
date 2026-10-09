/*
 * TBI Lab example: ESP32 distance alarm with an HC-SR04 ultrasonic module.
 *
 * Every 100 ms a 10 us HIGH pulse on TRIG (GPIO5) starts a measurement (HC-SR04 datasheet:
 * "10 us TTL pulse"). The module answers with a HIGH pulse on ECHO whose width is the sound's
 * round trip. ECHO reaches GPIO18 through a 1 kOhm / 2 kOhm divider: the module runs from 5 V,
 * the ESP32 pad must stay within its 3.3 V supply range.
 * Distance in cm = pulse width in us / 58 (datasheet). No echo within 30 ms: nothing in range.
 * The red LED on GPIO2 lights when something is closer than 20 cm.
 */
const int TRIG = 5;
const int ECHO = 18;
const int LED = 2;
const float ALARM_CM = 20.0;

void setup() {
  Serial.begin(115200);
  pinMode(TRIG, OUTPUT);
  digitalWrite(TRIG, LOW);
  pinMode(ECHO, INPUT);
  pinMode(LED, OUTPUT);
  digitalWrite(LED, LOW);
}

void loop() {
  // The trigger pulse.
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  // The echo pulse width in microseconds; 0 when no echo starts and ends within 30 ms.
  unsigned long us = pulseIn(18, HIGH, 30000);
  if (us == 0) {
    Serial.println("No echo");
    digitalWrite(LED, LOW);
  } else {
    float cm = us / 58.0;
    Serial.printf("Distance: %.1f cm\n", cm);
    digitalWrite(LED, cm < ALARM_CM ? HIGH : LOW);
  }
  delay(100);
}
