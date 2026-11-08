/*
 * TBI Lab example: a potentiometer read as a digital level by the ESP32.
 *
 * A 10 kOhm PTV09A potentiometer sits across the 3.3 V supply (end A to GND, end B to +3.3 V); its
 * wiper goes to GPIO34, an input-only pin. The ESP32 reads the wiper as a DIGITAL level, using the
 * datasheet thresholds: at or below V_IL = 0.825 V it reads LOW, at or above V_IH = 2.475 V it reads
 * HIGH. In between the datasheet guarantees nothing (no hysteresis is specified), so the simulator
 * stops the run at a read there instead of choosing a level.
 * GPIO4 drives a red LED through 220 Ohm and follows the level. Analog input (analogRead) is not
 * supported by the simulator.
 */
const int WIPER_PIN = 34;
const int LED_PIN = 4;

void setup() {
  Serial.begin(115200);
  pinMode(WIPER_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("POT-READY");
}

void loop() {
  static int last = -1;
  int level = digitalRead(WIPER_PIN);
  digitalWrite(LED_PIN, level);
  if (level != last) {
    Serial.printf("LEVEL=%d\n", level);
    last = level;
  }
  delay(5);
}
