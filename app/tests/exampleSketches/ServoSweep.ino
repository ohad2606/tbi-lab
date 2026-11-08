/*
 * TBI Lab example: sweep an SG90 servo with the ESP32's LEDC PWM.
 *
 * A servo reads the width of a pulse repeated every 20 ms (50 Hz): 1.0 ms is one end of its
 * travel (0 degrees), 2.0 ms the other (180 degrees), 1.5 ms the middle. ledcAttach() sets up a
 * 50 Hz signal with 16-bit resolution on GPIO18, so 65536 counts are one 20 ms period.
 * The servo runs from the 5 V bench supply; its ground is shared with the ESP32.
 */
const int SERVO_PIN = 18;

/** Duty counts (16 bit, 20 ms period) for a pulse of `us` microseconds. */
uint32_t dutyFor(uint32_t us) {
  return (uint32_t)((uint64_t)us * 65536 / 20000);
}

void setup() {
  ledcAttach(SERVO_PIN, 50, 16);
  ledcWrite(SERVO_PIN, dutyFor(1500));
}

void loop() {
  ledcWrite(SERVO_PIN, dutyFor(1000));
  delay(1000);
  ledcWrite(SERVO_PIN, dutyFor(2000));
  delay(1000);
  ledcWrite(SERVO_PIN, dutyFor(1500));
  delay(1000);
}
