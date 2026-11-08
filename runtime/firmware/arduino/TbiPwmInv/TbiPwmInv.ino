/*
 * Sprint 16A runtime test firmware (R4 review M8, a refusal). Not a product artifact. GPIO-matrix
 * output inversion, which the host does not model, set three ways, each reported by patch 0010:
 *   GPIO18: an LEDC output inverted with the Arduino API (ledcOutputInvert), then restored;
 *   GPIO19: an LEDC output inverted below the Arduino API (esp_rom_gpio_connect_out_signal, the
 *           path the build service cannot see);
 *   GPIO21: a simple GPIO output inverted through the matrix, then restored;
 *   GPIO22: an INPUT pad with the output inversion bit set: it drives nothing, so nothing to refuse.
 * Prints a marker after each step: INV-READY, INV-ATTACHED, INV-API, INV-OFF, INV-MATRIX,
 * INV-GPIO, INV-INPUT, INV-DONE.
 */
#include "esp_rom_gpio.h"
#include "soc/gpio_reg.h"
#include "soc/gpio_sig_map.h"

void setup() {
  Serial.begin(115200);
  Serial.println("INV-READY");
  ledcAttach(18, 1000, 8);
  ledcWrite(18, 64);
  ledcAttach(19, 1000, 8);
  ledcWrite(19, 128);
  delay(20);
  Serial.println("INV-ATTACHED");
  ledcOutputInvert(18, true);
  delay(20);
  Serial.println("INV-API");
  ledcOutputInvert(18, false);
  delay(20);
  Serial.println("INV-OFF");
  // GPIO19's channel is the second high-speed one the core allocated: signal LEDC_HS_SIG_OUT0 + 1.
  esp_rom_gpio_connect_out_signal(19, LEDC_HS_SIG_OUT0_IDX + 1, true, false);
  delay(20);
  Serial.println("INV-MATRIX");
  pinMode(21, OUTPUT);
  digitalWrite(21, HIGH);
  esp_rom_gpio_connect_out_signal(21, SIG_GPIO_OUT_IDX, true, false);
  delay(20);
  Serial.println("INV-GPIO");
  esp_rom_gpio_connect_out_signal(21, SIG_GPIO_OUT_IDX, false, false);
  delay(20);
  Serial.println("INV-INPUT");
  pinMode(22, INPUT);
  esp_rom_gpio_connect_out_signal(22, SIG_GPIO_OUT_IDX, true, false);
  Serial.printf("INV-EN22 %u\n", (unsigned)((REG_READ(GPIO_ENABLE_REG) >> 22) & 1));
  REG_WRITE(GPIO_ENABLE_W1TC_REG, BIT(22)); // an input pad again, OUT_INV still set
  delay(20);
  Serial.println("INV-DONE");
}

void loop() { delay(1000); }
