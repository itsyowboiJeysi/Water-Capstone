/**
 * ╔══════════════════════════════════════════════════════════════╗
 *  AquaSense ESP32 Firmware  —  Simple MQTT Configuration
 *  Safety Water Quality & Consumption Monitoring
 *  CSPC · CCS · BSIT 4G 2026 · GANDARIA
 * ╔══════════════════════════════════════════════════════════════╗
 *
 *  HOW IT WORKS:
 *  1. On first boot, ESP32 opens a WiFi hotspot.
 *  2. User connects and fills a simple web form with:
 *       • WiFi credentials
 *       • Device ID (e.g. 1, 2)
 *       • MQTT Topic (matches the topic registered in the dashboard)
 *  3. Settings saved to flash. ESP32 reboots and starts publishing.
 *
 *  REQUIRED LIBRARIES (Arduino Library Manager):
 *  • WiFiManager   by tzapu           v2.0.16+
 *  • ArduinoJson   by Benoit Blanchon v6.x
 *  • PubSubClient  by Nick O'Leary    v2.8+
 *
 *  BOARD: ESP32 Dev Module  |  Baud: 115200
 * ══════════════════════════════════════════════════════════════
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <mbedtls/md.h>
#include <ModbusMaster.h>

// ─────────────────────────────────────────────────────────────
//  PINS & HARDCODED SETTINGS
// ─────────────────────────────────────────────────────────────
#define PIN_RESET_BTN  0   // GPIO0  — BOOT button (hold 3 s to reset)
#define PIN_STATUS_LED 2   // GPIO2  — Built-in LED

// Analog/Digital Sensor Pins
#define PIN_TDS_SENSOR 34  // GPIO34 — TDS Analog Sensor
#define PIN_PH_SENSOR  35  // GPIO35 — pH Analog Sensor
#define PIN_TURB_SENSOR 32 // GPIO32 — Turbidity Analog Sensor
#define PIN_FLOW_SENSOR 27 // GPIO27 — Flow Rate Digital Sensor (Interrupt)

// RS485 Modbus Pins (NHN-106 Ammonia & Temp)
#define RS485_RX 16
#define RS485_TX 17
#define MAX485_DE_RE 4 // Drive DE & RE tied together

ModbusMaster node;

void preTransmission() {
  digitalWrite(MAX485_DE_RE, HIGH);
}

void postTransmission() {
  digitalWrite(MAX485_DE_RE, LOW);
}

// Flow Sensor Globals
volatile int pulseCount = 0;
unsigned long lastFlowTime = 0;
float calibrationFactor = 5.0; // YF-S201C specifies 5Hz per L/min

void IRAM_ATTR flowInterrupt() {
  pulseCount++;
}

// Hardcoded MQTT Settings
const char* mqttServer = "broker.hivemq.com";
const int mqttPort     = 1883;

// Hotspot Setup Details
#define PORTAL_SSID     "AquaSense-Setup"
#define PORTAL_PASSWORD "aquasense123"

#define PUBLISH_INTERVAL_MS   5000    // Send reading every 5 seconds
#define MQTT_RECONNECT_MS     5000    // Retry MQTT every 5 seconds

// ─────────────────────────────────────────────────────────────
//  RUNTIME CONFIG (Saved to Flash NVS)
// ─────────────────────────────────────────────────────────────
char deviceId[8]       = "1";
char mqttTopic[128]    = ""; // Single topic configured by user

bool shouldSaveConfig  = false;
unsigned long lastPost = 0;
unsigned long lastMqttRetry = 0;

Preferences  prefs;
WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

// ─────────────────────────────────────────────────────────────
//  LED HELPERS
// ─────────────────────────────────────────────────────────────
void ledOn()  { digitalWrite(PIN_STATUS_LED, HIGH); }
void ledOff() { digitalWrite(PIN_STATUS_LED, LOW);  }
void ledBlink(int n, int ms = 120) {
  for (int i = 0; i < n; i++) {
    digitalWrite(PIN_STATUS_LED, HIGH); delay(ms);
    digitalWrite(PIN_STATUS_LED, LOW);  delay(ms);
  }
}

// ─────────────────────────────────────────────────────────────
//  NVS FLASH MEMORY STORAGE
// ─────────────────────────────────────────────────────────────
void loadConfig() {
  prefs.begin("aquasense", true);
  prefs.getString("device_id", "1").toCharArray(deviceId, sizeof(deviceId));
  prefs.getString("mqtt_topic", "").toCharArray(mqttTopic, sizeof(mqttTopic));
  prefs.end();

  Serial.println("┌─ Config Loaded ──────────────────────────┐");
  Serial.printf( "│  Device ID    : %s\n", deviceId);
  Serial.printf( "│  MQTT Topic   : %s\n", mqttTopic);
  Serial.printf( "│  Broker Host  : %s\n", mqttServer);
  Serial.printf( "│  Broker Port  : %d\n", mqttPort);
  Serial.println("└──────────────────────────────────────────┘");
}

void saveConfig() {
  prefs.begin("aquasense", false);
  prefs.putString("device_id",  deviceId);
  prefs.putString("mqtt_topic", mqttTopic);
  prefs.end();
  Serial.println("[NVS] Config saved to flash memory.");
}

void clearConfig() {
  prefs.begin("aquasense", false);
  prefs.clear();
  prefs.end();
  WiFiManager wm;
  wm.resetSettings();
  Serial.println("[NVS] Wi-Fi settings and config wiped.");
}

// ─────────────────────────────────────────────────────────────
//  CAPTIVE PORTAL SETUP WIZARD
// ─────────────────────────────────────────────────────────────
void startProvisioning() {
  Serial.println("\n[WiFi] Starting setup portal...");
  ledBlink(3, 200);

  WiFiManager wm;

  // Header branding
  WiFiManagerParameter htmlHeader(
    "<hr>"
    "<div style='background:#0D2353;padding:14px 16px;border-radius:10px;margin:10px 0 18px'>"
    "<p style='color:#F2CC6B;font-weight:700;font-size:15px;margin:0'>💧 AquaSense Device Config</p>"
    "<p style='color:rgba(255,255,255,0.75);font-size:12px;margin:6px 0 0;line-height:1.5'>"
    "Configure device connection settings. These settings will be saved permanently to your device's flash memory.</p></div>"
  );

  WiFiManagerParameter pDeviceId(
    "device_id", "Device ID (Auto-assigned ID from dashboard)",
    deviceId, 7,
    " placeholder='e.g. 1'"
  );

  WiFiManagerParameter pMqttTopic(
    "mqtt_topic", "MQTT Topic (Matches topic in web dashboard)",
    mqttTopic, 127,
    " placeholder='e.g. esp32/aquasense/data'"
  );

  WiFiManagerParameter htmlFooter(
    "<div style='background:#F0FBF5;border:1px solid #A7DFC0;border-radius:8px;"
    "padding:12px 14px;font-size:11px;color:#0F7050;margin-top:16px;line-height:1.8'>"
    "<b>After saving:</b><br>"
    "✓ ESP32 reboots and connects to your Wi-Fi<br>"
    "✓ Connects automatically to <b>broker.hivemq.com</b><br>"
    "✓ Starts publishing water sensor readings to your configured topic"
    "</div><br>"
  );

  wm.addParameter(&htmlHeader);
  wm.addParameter(&pDeviceId);
  wm.addParameter(&pMqttTopic);
  wm.addParameter(&htmlFooter);

  wm.setSaveConfigCallback([]() { shouldSaveConfig = true; });
  wm.setConfigPortalTimeout(300); // 5 minute portal timeout

  wm.setAPCallback([](WiFiManager*) {
    Serial.println("┌─ Setup Portal Active ────────────────────┐");
    Serial.printf( "│  Connect SSID: %s\n", PORTAL_SSID);
    Serial.printf( "│  Password    : %s\n", PORTAL_PASSWORD);
    Serial.println("│  Then browse : http://192.168.4.1        │");
    Serial.println("└──────────────────────────────────────────┘");
  });

  bool connected = wm.autoConnect(PORTAL_SSID, PORTAL_PASSWORD);

  if (!connected) {
    Serial.println("[WiFi] Portal timeout. Restarting...");
    ledBlink(10, 60);
    delay(1000);
    ESP.restart();
  }

  // Copy configured values
  strncpy(deviceId,  pDeviceId.getValue(),  sizeof(deviceId)  - 1);
  strncpy(mqttTopic, pMqttTopic.getValue(), sizeof(mqttTopic) - 1);

  if (shouldSaveConfig) {
    saveConfig();
    shouldSaveConfig = false;
  }

  // Fallback: If topic is empty, create a default one
  if (strlen(mqttTopic) == 0) {
    snprintf(mqttTopic, sizeof(mqttTopic), "esp32/aquasense/%s", deviceId);
    saveConfig(); // Save the new default topic to memory
    Serial.printf("[WiFi] No MQTT topic provided. Defaulting to: %s\n", mqttTopic);
  }

  Serial.printf("[WiFi] ✓ Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  ledBlink(5, 80);
}

// ─────────────────────────────────────────────────────────────
//  MQTT CONNECTION MANAGEMENT
// ─────────────────────────────────────────────────────────────
bool connectMQTT() {
  if (mqttClient.connected()) return true;
  if (strlen(mqttTopic) == 0) {
    Serial.println("[MQTT] MQTT Topic is empty — cannot connect.");
    return false;
  }

  mqttClient.setServer(mqttServer, mqttPort);

  // Generate a random client ID based on MAC address to avoid conflict disconnects
  String clientId = "AquaSense-" + WiFi.macAddress();

  Serial.printf("[MQTT] Connecting to %s:%d (Client ID: %s)...\n",
                mqttServer, mqttPort, clientId.c_str());

  if (mqttClient.connect(clientId.c_str())) {
    Serial.println("[MQTT] ✓ Connected successfully!");
    ledBlink(3, 60);
    return true;
  }

  Serial.printf("[MQTT] ✗ Failed (state = %d). Retrying in %d seconds.\n",
                mqttClient.state(), MQTT_RECONNECT_MS / 1000);
  return false;
}

// ─────────────────────────────────────────────────────────────
//  ACTUAL SENSOR READINGS
// ─────────────────────────────────────────────────────────────

float currentAmmonia = 0.0;
float currentTemp = 25.0;

// Poll the RS485 Modbus Sensor (NHN-106) using ModbusMaster library
void queryModbus() {
  uint8_t result;
  
  // Read 4 Holding Registers starting at address 0x0000 based on your working config
  // Reg 0 = Ammonia, Reg 2 = Temperature
  result = node.readHoldingRegisters(0x0000, 4);
  
  if (result == node.ku8MBSuccess) {
    int nh3Reg  = node.getResponseBuffer(0);
    int tempReg = node.getResponseBuffer(2);
    
    // Divide by 10 based on the 00 5A (90 -> 9.0) and 00 F7 (247 -> 24.7) values
    currentAmmonia = nh3Reg / 10.0f;
    currentTemp = tempReg / 10.0f;
  } else {
    Serial.printf("[Modbus] Failed to read sensor. Error Code: 0x%02X\n", result);
  }
}

// Helper function to average analog readings for stability
int getAverageAnalogRead(int pin, int numSamples = 10) {
  long sum = 0;
  for (int i = 0; i < numSamples; i++) {
    sum += analogRead(pin);
    delay(10);
  }
  return sum / numSamples;
}

float readPH() {
  int buffer_arr[10];
  
  // Read 10 samples with 30ms delay
  for (int i = 0; i < 10; i++) {
    buffer_arr[i] = analogRead(PIN_PH_SENSOR);
    delay(30);
  }

  // Sort samples (Bubble Sort) to drop extremes
  for (int i = 0; i < 9; i++) {
    for (int j = i + 1; j < 10; j++) {
      if (buffer_arr[i] > buffer_arr[j]) {
        int temp = buffer_arr[i];
        buffer_arr[i] = buffer_arr[j];
        buffer_arr[j] = temp;
      }
    }
  }

  // Average the middle 6 values (drops 2 highest and 2 lowest for high stability)
  long avgval = 0;
  for (int i = 2; i < 8; i++) {
    avgval += buffer_arr[i];
  }
  float adcAverage = avgval / 6.0f;

  // Convert ADC to voltage (Direct connection, no voltage divider multiplier)
  float voltage = adcAverage * (3.3f / 4095.0f);

  // Calculate pH using user calibration value
  float calibration_value = 22.84f;
  float ph = -5.70f * voltage + calibration_value;

  if (ph > 14.0f) ph = 14.0f;
  if (ph < 0.0f) ph = 0.0f;
  return ph;
}

float readTurbidity() {
  // User Calibration Values
  const int ADC_CLEAR = 1710;
  const int ADC_DIRTY = 700;

  // Take 100 samples to match the calibration code
  long sum = 0;
  for (int i = 0; i < 100; i++) {
    sum += analogRead(PIN_TURB_SENSOR);
    delay(2);
  }
  int adc = sum / 100;
  
  // Map ADC values to 0-100% turbidity
  float turbidity = (float)(ADC_CLEAR - adc) * 100.0f / (ADC_CLEAR - ADC_DIRTY);
  
  // Constrain between 0 and 100%
  if (turbidity < 0.0f) turbidity = 0.0f;
  if (turbidity > 100.0f) turbidity = 100.0f;
  
  return turbidity;
}

float readTemperature() {
  return currentTemp;
}

float readTDS(float temperature) {
  int analogValue = getAverageAnalogRead(PIN_TDS_SENSOR);
  float voltage = analogValue * (3.3f / 4095.0f); // TDS outputs 0-2.3V natively, no divider needed
  
  // Temperature compensation formula
  float compensationCoefficient = 1.0f + 0.02f * (temperature - 25.0f);
  float compensationVoltage = voltage / compensationCoefficient;
  
  // Convert voltage to TDS value
  float tdsValue = (133.42f * pow(compensationVoltage, 3) - 255.86f * pow(compensationVoltage, 2) + 857.39f * compensationVoltage) * 0.5f;
  if (tdsValue < 0) return 0;
  return tdsValue;
}

float readAmmonia() {
  return currentAmmonia;
}

float readFlowRate() {
  // Disable interrupts to safely read and reset the pulse count
  noInterrupts();
  int currentPulses = pulseCount;
  pulseCount = 0;
  interrupts();

  unsigned long now = millis();
  unsigned long timeElapsed = now - lastFlowTime;
  lastFlowTime = now;

  if (timeElapsed == 0) return 0;

  // L/min = (pulses / calibrationFactor) / (timeElapsed in minutes)
  float flowRate = (currentPulses / calibrationFactor) / (timeElapsed / 60000.0f);
  return flowRate;
}

float calcWaterConsumed(float flowRate) {
  return flowRate * (PUBLISH_INTERVAL_MS / 60000.0f);
}

// ─────────────────────────────────────────────────────────────
//  SEND SENSOR READINGS IN JSON FORMAT
// ─────────────────────────────────────────────────────────────
void sensorCycle() {
  queryModbus(); // Update Modbus sensor values first
  
  float ph   = readPH();
  float turb = readTurbidity();
  float temp = readTemperature();
  float tds  = readTDS(temp);
  float nh3  = readAmmonia();
  float flow = readFlowRate();
  float cons = calcWaterConsumed(flow);

  Serial.println("┌─ Current Sensor Values ──────────────────┐");
  Serial.printf( "│  pH Level : %.2f\n", ph);
  Serial.printf( "│  Turbidity: %.2f %%\n", turb);
  Serial.printf( "│  TDS      : %.1f ppm\n", tds);
  Serial.printf( "│  Temp     : %.1f °C\n", temp);
  Serial.printf( "│  Ammonia  : %.3f mg/L\n", nh3);
  Serial.printf( "│  Flow Rate: %.2f L/min\n", flow);
  Serial.printf( "│  Consumed : %.4f L\n", cons);

  if (mqttClient.connected() && strlen(mqttTopic) > 0) {
    // Format values exactly as backend expects to prevent hashing mismatches
    char phStr[16], turbStr[16], tdsStr[16], tempStr[16], nh3Str[16], flowStr[16], consStr[16];
    snprintf(phStr, sizeof(phStr), "%.2f", round(ph * 100) / 100.0);
    snprintf(turbStr, sizeof(turbStr), "%.2f", round(turb * 100) / 100.0);
    snprintf(tdsStr, sizeof(tdsStr), "%.2f", round(tds * 100) / 100.0);
    snprintf(tempStr, sizeof(tempStr), "%.2f", round(temp * 100) / 100.0);
    snprintf(nh3Str, sizeof(nh3Str), "%.3f", round(nh3 * 1000) / 1000.0);
    snprintf(flowStr, sizeof(flowStr), "%.2f", round(flow * 100) / 100.0);
    snprintf(consStr, sizeof(consStr), "%.4f", round(cons * 10000) / 10000.0);

    // Construct raw payload for hashing
    // Format: "device_id|ph_level|turbidity|tds|temperature|ammonia|flow_rate|water_consumed"
    String rawPayload = String(atoi(deviceId)) + "|" + phStr + "|" + turbStr + "|" + tdsStr + "|" + tempStr + "|" + nh3Str + "|" + flowStr + "|" + consStr;
    
    // Generate HMAC-SHA256
    const char* secretKey = "AquaSense_IoT_Secret_2026";
    byte hmacResult[32];
    mbedtls_md_context_t ctx;
    mbedtls_md_type_t md_type = MBEDTLS_MD_SHA256;
    mbedtls_md_init(&ctx);
    mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(md_type), 1);
    mbedtls_md_hmac_starts(&ctx, (const unsigned char*)secretKey, strlen(secretKey));
    mbedtls_md_hmac_update(&ctx, (const unsigned char*)rawPayload.c_str(), rawPayload.length());
    mbedtls_md_hmac_finish(&ctx, hmacResult);
    mbedtls_md_free(&ctx);

    String signature = "";
    for(int i = 0; i < 32; i++){
      char str[3];
      sprintf(str, "%02x", (int)hmacResult[i]);
      signature += str;
    }

    // Construct JSON payload
    StaticJsonDocument<512> doc;
    doc["device_id"]      = atoi(deviceId);
    doc["ph_level"]       = phStr;
    doc["turbidity"]      = turbStr;
    doc["tds"]            = tdsStr;
    doc["temperature"]    = tempStr;
    doc["ammonia"]        = nh3Str;
    doc["flow_rate"]      = flowStr;
    doc["water_consumed"] = consStr;
    doc["signature"]      = signature;

    char payload[512];
    serializeJson(doc, payload);

    if (mqttClient.publish(mqttTopic, payload)) {
      Serial.printf("│  MQTT Sent: → %s\n", mqttTopic);
      ledBlink(2, 40);
    } else {
      Serial.println("│  MQTT Sent: ✗ Failed to send");
    }
  } else {
    Serial.println("│  MQTT Sent: ✗ Not connected to broker");
  }
  Serial.println("└──────────────────────────────────────────┘");
}

// ─────────────────────────────────────────────────────────────
//  INITIALIZATION
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("╔══════════════════════════════════════════╗");
  Serial.println("║   AquaSense ESP32 - Simplified MQTT      ║");
  Serial.println("║   Smart Water Quality Monitoring         ║");
  Serial.println("╚══════════════════════════════════════════╝");

  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_TDS_SENSOR, INPUT);
  pinMode(PIN_PH_SENSOR, INPUT);
  pinMode(PIN_TURB_SENSOR, INPUT);
  
  pinMode(PIN_FLOW_SENSOR, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_FLOW_SENSOR), flowInterrupt, FALLING);
  
  ledOff();
  randomSeed(analogRead(0));

  pinMode(MAX485_DE_RE, OUTPUT);
  digitalWrite(MAX485_DE_RE, LOW); // Start in receive mode

  // Initialize RS485 Serial (Serial2) for Ammonia/Temp sensor
  Serial2.begin(9600, SERIAL_8N1, RS485_RX, RS485_TX);
  
  // Initialize ModbusMaster to communicate with Slave ID 6 over Serial2
  node.begin(6, Serial2);
  node.preTransmission(preTransmission);
  node.postTransmission(postTransmission);

  lastFlowTime = millis();

  loadConfig();
  startProvisioning();
  connectMQTT();

  Serial.println("[AquaSense] Initialized successfully. Starting monitoring loop.\n");
}

// ─────────────────────────────────────────────────────────────
//  MAIN EXECUTION LOOP
// ─────────────────────────────────────────────────────────────
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Connection lost. Attempting to reconnect for 5 seconds...");
    ledOff();
    WiFi.reconnect();
    
    unsigned long startWait = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startWait < 5000) {
      delay(100);
    }
    
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WiFi] AP not responding for 5 seconds. Wiping saved AP and restarting...");
      clearConfig(); // Deletes saved Wi-Fi and NVS settings
      ESP.restart();
    }
    
    Serial.println("[WiFi] Reconnected successfully.");
    return;
  }

  unsigned long now = millis();

  // Handle MQTT connection retries
  if (!mqttClient.connected()) {
    if (now - lastMqttRetry >= MQTT_RECONNECT_MS) {
      lastMqttRetry = now;
      connectMQTT();
    }
  } else {
    mqttClient.loop();
  }

  // Publish sensor data cycle
  if (now - lastPost >= PUBLISH_INTERVAL_MS) {
    lastPost = now;
    sensorCycle();
  }
}
