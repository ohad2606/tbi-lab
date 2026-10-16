/*
 * TBI Lab example: fade an LED with PWM.
 *
 * analogWrite() drives GPIO18 with a 1 kHz PWM signal (the ESP32's LEDC peripheral, 8 bit).
 * The duty (0-255) sets how long each 1 ms period is high; the LED's average current, and so
 * its brightness, follows it.
 *
 * The fade runs between 1 and 255, never 0: what a real ESP32 outputs at duty 0 is not verified
 * yet, so the simulator refuses a duty of 0 that drives a load instead of guessing.
 */
const int LED_PIN = 18;

void setup() {
  analogWrite(LED_PIN, 1);
}

void loop() {
  for (int duty = 1; duty <= 255; duty += 2) {
    analogWrite(LED_PIN, duty);
    delay(8);
  }
  for (int duty = 255; duty >= 1; duty -= 2) {
    analogWrite(LED_PIN, duty);
    delay(8);
  }
}
