#define TURBIDITY_PIN 34

// ===== YOUR CALIBRATION =====
const int ADC_CLEAR = 1710;
const int ADC_DIRTY = 700;
// ============================

// Voltage divider: 22k (top, from sensor) + 33k (bottom, to GND)
// ratio = 33 / (22 + 33) = 0.6
// To reconstruct original sensor voltage: divide by ratio (i.e. multiply by 1/0.6)
#define DIVIDER_MULTIPLIER 1.6667

int readADC() {
  long sum = 0;

  for (int i = 0; i < 100; i++) {
    sum += analogRead(TURBIDITY_PIN);
    delay(2);
  }

  return sum / 100;
}

void setup() {
  Serial.begin(115200);

  analogReadResolution(12);
  analogSetPinAttenuation(TURBIDITY_PIN, ADC_11db);
}

void loop() {

  int adc = readADC();

  float espVoltage = adc * 3.3 / 4095.0;
  float sensorVoltage = espVoltage * DIVIDER_MULTIPLIER;

  // Map your ADC values to 0-100%
  float turbidity = (float)(ADC_CLEAR - adc) * 100.0 /
                    (ADC_CLEAR - ADC_DIRTY);

  turbidity = constrain(turbidity, 0, 100);

  Serial.println("-----------------------------");
  Serial.print("ADC: ");
  Serial.println(adc);

  Serial.print("ESP Voltage: ");
  Serial.print(espVoltage, 3);
  Serial.println(" V");

  Serial.print("Sensor Voltage: ");
  Serial.print(sensorVoltage, 3);
  Serial.println(" V");

  Serial.print("Turbidity: ");
  Serial.print(turbidity, 1);
  Serial.println(" %");

  if (turbidity < 20)
    Serial.println("Water Quality: Clear");
  else if (turbidity < 50)
    Serial.println("Water Quality: Slightly Cloudy");
  else if (turbidity < 80)
    Serial.println("Water Quality: Cloudy");
  else
    Serial.println("Water Quality: Very Muddy");

  delay(500);
}