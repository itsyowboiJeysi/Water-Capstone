
#define FLOW_SENSOR_PIN 4

volatile uint32_t pulseCount = 0;

float flowRate = 0.0;
float totalLiters = 0.0;

unsigned long previousMillis = 0;

// Calibration factor for YF-S201
// Frequency = 7.5 × Flow(L/min)
const float calibrationFactor = 7.5;

void IRAM_ATTR pulseCounter()
{
  pulseCount++;
}

void setup()
{
  Serial.begin(115200);

  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);

  attachInterrupt(
      digitalPinToInterrupt(FLOW_SENSOR_PIN),
      pulseCounter,
      RISING);

  Serial.println("Water Flow Sensor Started...");
}

void loop()
{
  unsigned long currentMillis = millis();

  if (currentMillis - previousMillis >= 1000)
  {
    noInterrupts();
    uint32_t pulses = pulseCount;
    pulseCount = 0;
    interrupts();

    // Frequency in Hz
    float frequency = pulses;

    // Flow Rate (L/min)
    flowRate = frequency / calibrationFactor;

    // Add to total volume
    totalLiters += flowRate / 60.0;

    Serial.println("----------------------------");
    Serial.print("Flow Rate : ");
    Serial.print(flowRate, 2);
    Serial.println(" L/min");

    Serial.print("Water Used: ");
    Serial.print(totalLiters, 3);
    Serial.println(" L");

    previousMillis = currentMillis;
  }
}