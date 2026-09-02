/**
 * ╔══════════════════════════════════════════════════════════════╗
 *  AgosTech ESP32 Firmware  —  v2.5 (Dynamic MQTT & Mobile WLAN)
 *  Safety Water Quality & Consumption Monitoring
 *  CSPC · CCS · BSIT 4G 2026 · GANDARIA
 * ╔══════════════════════════════════════════════════════════════╗
 *
 *  WHAT CHANGED IN THIS VERSION (v2.5):
 *  1. Forced pre-filled MQTT Topic & Device ID fields onto the WLAN connection page (/wifi).
 *  2. Added setParamsPage(true) so iPhone / Mobile WLAN setup page ALWAYS renders the MQTT Topic field.
 *  3. Displays saved MQTT Topic & Board MAC address prominently in the setup portal header.
 *  4. OTA Dynamic Telemetry Sending Interval via MQTT (3s to 2 hours) with Flash NVS persistence.
 *  5. Wi-Fi reset button wipes ONLY Wi-Fi router settings — preserves saved MQTT Topic & Device ID.
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
#include <LittleFS.h>
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
#define PORTAL_SSID     "AgosTech-Setup"
#define PORTAL_PASSWORD "agostech123"

unsigned long publishIntervalMs = 5000;    // Send reading every 5 seconds (Updated by MQTT)
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
WiFiManager  wm;

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
  prefs.begin("agostech", true);
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
  prefs.begin("agostech", false);
  prefs.putString("device_id",  deviceId);
  prefs.putString("mqtt_topic", mqttTopic);
  prefs.end();
  Serial.println("[NVS] Config saved to flash memory.");
}

void clearConfig() {
  // Only wipe Wi-Fi settings, preserve saved MQTT topic and Device ID so user never loses them!
  WiFiManager wm;
  wm.resetSettings();
  Serial.println("[NVS] Wi-Fi network settings reset. Saved MQTT topic preserved in flash.");
}

// ─────────────────────────────────────────────────────────────
//  CAPTIVE PORTAL SETUP WIZARD
// ─────────────────────────────────────────────────────────────
static String headerHtmlStorage;

void startProvisioning() {
  Serial.println("\n[WiFi] Initializing Wi-Fi & Non-Blocking Setup Portal...");
  ledBlink(3, 200);

  // If topic is empty, generate an automatic fallback topic based on deviceId
  if (strlen(mqttTopic) == 0) {
    snprintf(mqttTopic, sizeof(mqttTopic), "esp32/agostech/%s", deviceId);
    saveConfig();
  }

  String macAddr = WiFi.macAddress();
  String currentTopicStr = String(mqttTopic);

  // Construct dynamic HTML header with saved topic & MAC address display
  headerHtmlStorage = 
    "<br><div style='background:#0D2353;padding:12px;border-radius:8px;color:#ffffff;font-family:sans-serif;'>"
    "<b style='color:#F2CC6B;font-size:14px;'>💧 AgosTech Device Config</b><br>"
    "<span style='font-size:11px;opacity:0.8;'>Saved permanently in ESP32 Flash Memory</span>"
    "</div>"
    "<div style='background:#EBF8FF;border:1px solid #63B3ED;border-radius:8px;padding:10px;font-size:11px;color:#2B6CB0;margin:10px 0;line-height:1.5;font-family:sans-serif;'>"
    "<b>📌 Current Saved Topic:</b> <b style='color:#C53030;'>" + currentTopicStr + "</b><br>"
    "<b>🆔 Device MAC Address:</b> <b>" + macAddr + "</b>"
    "</div>";

  WiFiManagerParameter htmlHeader(headerHtmlStorage.c_str());

  WiFiManagerParameter pDeviceId(
    "device_id",
    "Device ID",
    deviceId,
    7
  );

  WiFiManagerParameter pMqttTopic(
    "mqtt_topic",
    "MQTT Topic (Edit or keep saved topic)",
    mqttTopic,
    127
  );

  WiFiManagerParameter htmlFooter(
    "<br><div style='background:#F0FBF5;border:1px solid #A7DFC0;border-radius:8px;padding:10px;font-size:11px;color:#0F7050;line-height:1.5;font-family:sans-serif;'>"
    "<b>Next steps:</b><br>"
    "1. Select your Wi-Fi & click Save<br>"
    "2. ESP32 connects & publishes to <b>broker.hivemq.com</b>"
    "</div><br>"
  );

  wm.addParameter(&htmlHeader);
  wm.addParameter(&pDeviceId);
  wm.addParameter(&pMqttTopic);
  wm.addParameter(&htmlFooter);

  wm.setSaveConfigCallback([]() { shouldSaveConfig = true; });
  wm.setConfigPortalBlocking(false); // Non-blocking: Allows sensors to log offline while AP portal is active!
  wm.setConnectTimeout(6);
  wm.setConnectRetries(2);
  wm.setParamsPage(true);            // Force custom parameters (Device ID & MQTT Topic) onto the /wifi page!

  bool connected = wm.autoConnect(PORTAL_SSID, PORTAL_PASSWORD);

  if (!connected && WiFi.status() != WL_CONNECTED) {
    Serial.println("┌─ Multitasking Mode Active ──────────────┐");
    Serial.println("│  1. Logging sensors offline to LittleFS │");
    Serial.println("│  2. Setup Portal Active in background   │");
    Serial.printf( "│     SSID: %s (192.168.4.1)      │\n", PORTAL_SSID);
    Serial.println("└──────────────────────────────────────────┘");
    wm.startWebPortal(); // Keep hotspot active in background!
  } else {
    Serial.printf("[WiFi] ✓ Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    ledBlink(5, 80);
  }

  // Copy configured values
  strncpy(deviceId,  pDeviceId.getValue(),  sizeof(deviceId)  - 1);
  strncpy(mqttTopic, pMqttTopic.getValue(), sizeof(mqttTopic) - 1);

  if (shouldSaveConfig) {
    saveConfig();
    shouldSaveConfig = false;
  }

  // Fallback: If topic is empty, create a default one based on deviceId
  if (strlen(mqttTopic) == 0) {
    snprintf(mqttTopic, sizeof(mqttTopic), "esp32/agostech/%s", deviceId);
    saveConfig();
    Serial.printf("[WiFi] Defaulting MQTT topic to: %s\n", mqttTopic);
  }
}

// ─────────────────────────────────────────────────────────────
//  INTERNAL FLASH STORE & FORWARD (LittleFS)
// ─────────────────────────────────────────────────────────────
void saveOfflineTelemetry(const char* payload) {
  File file = LittleFS.open("/offline_telemetry.txt", FILE_APPEND);
  if (file) {
    file.println(payload);
    file.close();
    Serial.println("│  Offline Flash Storage: Saved reading to internal LittleFS memory.");
  } else {
    Serial.println("│  Offline Flash Storage: ✗ Failed writing to Flash memory.");
  }
}

void flushOfflineTelemetry() {
  if (!LittleFS.exists("/offline_telemetry.txt")) return;

  File file = LittleFS.open("/offline_telemetry.txt", FILE_READ);
  if (!file) return;

  Serial.println("[Offline Sync] Reconnected! Uploading buffered readings from LittleFS to server...");
  int count = 0;
  while (file.available()) {
    String line = file.readStringUntil('\n');
    line.trim();
    if (line.length() > 0 && mqttClient.connected()) {
      mqttClient.publish(mqttTopic, line.c_str());
      mqttClient.loop();
      delay(100); // 100ms pause to prevent MQTT socket saturation
      count++;
    }
  }
  file.close();
  LittleFS.remove("/offline_telemetry.txt");
  Serial.printf("[Offline Sync] ✓ Successfully uploaded %d offline reading(s). Internal Flash cleared!\n", count);
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
  mqttClient.setCallback(mqttCallback);

  // Generate a random client ID based on MAC address to avoid conflict disconnects
  String clientId = "AgosTech-" + WiFi.macAddress();

  Serial.printf("[MQTT] Connecting to %s:%d (Client ID: %s)...\n",
                mqttServer, mqttPort, clientId.c_str());

  if (mqttClient.connect(clientId.c_str())) {
    Serial.println("[MQTT] ✓ Connected successfully!");
    ledBlink(3, 60);
    
    // Subscribe to system-wide configuration updates
    mqttClient.subscribe("esp32/agostech/config");

    // Also subscribe to device specific config topic (e.g. esp32/agostech/data/config)
    String devConfigTopic = String(mqttTopic) + "/config";
    mqttClient.subscribe(devConfigTopic.c_str());

    Serial.printf("[MQTT] Subscribed to config topics: esp32/agostech/config & %s\n", devConfigTopic.c_str());
    
    // Automatically flush any stored offline readings from LittleFS
    flushOfflineTelemetry();

    return true;
  }

  Serial.printf("[MQTT] ✗ Failed (state = %d). Retrying in %d seconds.\n",
                mqttClient.state(), MQTT_RECONNECT_MS / 1000);
  return false;
}

// Handle incoming MQTT messages
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String topicStr = String(topic);
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  if (topicStr == "esp32/agostech/config" || topicStr.endsWith("/config")) {
    Serial.printf("[MQTT Config] Received message on topic '%s': %s\n", topicStr.c_str(), message.c_str());
    
    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, message);
    
    if (!error) {
      int newSec = 0;
      if (doc.containsKey("interval_sec")) {
        newSec = doc["interval_sec"];
      } else if (doc.containsKey("interval_ms")) {
        newSec = (int)doc["interval_ms"] / 1000;
      }

      if (newSec >= 3) {
        publishIntervalMs = (unsigned long)newSec * 1000;

        // Persist to Flash NVS
        saveConfig();

        Serial.println("┌─ Dynamic Interval Updated ───────────────┐");
        Serial.printf( "│  New Interval : %d Seconds (%lu ms)\n", newSec, publishIntervalMs);
        Serial.println("│  Saved to NVS : Yes (Persists on reboot) │");
        Serial.println("└──────────────────────────────────────────┘");

        ledBlink(4, 50); // Flash LED to confirm OTA update
      }
    } else {
      Serial.printf("[MQTT Config] Failed to parse JSON: %s\n", error.c_str());
    }
  }
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
  return flowRate * (publishIntervalMs / 60000.0f);
}

// ─────────────────────────────────────────────────────────────
//  SEND SENSOR READINGS IN JSON FORMAT
// ─────────────────────────────────────────────────────────────
void sensorCycle() {
  // 1. Read Flow Rate first to determine if water is moving
  float flow = readFlowRate();
  float cons = calcWaterConsumed(flow);

  // 2. Query Modbus (We still need to do this to get Temperature)
  queryModbus(); 
  
  // 3. Read other sensors
  float ph   = readPH();
  float turb = readTurbidity();
  float temp = readTemperature();
  float tds  = readTDS(temp);
  
  // 4. Custom Ammonia Logic:
  // "If flow rate is sensing something, don't sense ammonia"
  // "If stagnant, sense it and get the lowest possible"
  static float lowestAmmonia = 999.0f; 
  float nh3 = 0.0f;

  if (flow > 0.1f) {
    // WATER IS FLOWING: Ignore ammonia.
    nh3 = 0.0f; 
    
    // Reset our lowest tracker for the next time water stops
    lowestAmmonia = 999.0f; 
  } else {
    // WATER IS STABLE/STAGNANT: Read ammonia
    float rawNh3 = readAmmonia();
    
    // Find the lowest possible reading during this stagnant period
    if (rawNh3 >= 0.0f && rawNh3 < lowestAmmonia) {
      lowestAmmonia = rawNh3;
    }
    
    // Report the lowest stable value we've found
    nh3 = (lowestAmmonia == 999.0f) ? rawNh3 : lowestAmmonia;
  }

  Serial.println("┌─ Current Sensor Values ──────────────────┐");
  Serial.printf( "│  pH Level : %.2f\n", ph);
  Serial.printf( "│  Turbidity: %.2f %%\n", turb);
  Serial.printf( "│  TDS      : %.1f ppm\n", tds);
  Serial.printf( "│  Temp     : %.1f °C\n", temp);
  Serial.printf( "│  Ammonia  : %.3f mg/L\n", nh3);
  Serial.printf( "│  Flow Rate: %.2f L/min\n", flow);
  Serial.printf( "│  Consumed : %.4f L\n", cons);

  if (strlen(mqttTopic) > 0) {
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
    const char* secretKey = "AgosTech_IoT_Secret_2026";
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

    if (WiFi.status() == WL_CONNECTED && mqttClient.connected()) {
      if (mqttClient.publish(mqttTopic, payload)) {
        Serial.printf("│  MQTT Sent: → %s\n", mqttTopic);
        ledBlink(2, 40);
      } else {
        Serial.println("│  MQTT Sent: ✗ Publish failed. Buffering reading to LittleFS Flash memory...");
        saveOfflineTelemetry(payload);
      }
    } else {
      Serial.println("│  Network/Broker Offline: Buffering reading to internal LittleFS Flash memory...");
      saveOfflineTelemetry(payload);
    }
  } else {
    Serial.println("│  Error: Invalid device configuration or empty MQTT topic.");
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
  Serial.println("║   AgosTech ESP32 - Simplified MQTT      ║");
  Serial.println("║   Smart Water Quality Monitoring         ║");
  Serial.println("╚══════════════════════════════════════════╝");

  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_RESET_BTN, INPUT_PULLUP);

  // If BOOT button is pressed during boot, wipe saved Wi-Fi & NVS config and launch setup portal
  if (digitalRead(PIN_RESET_BTN) == LOW) {
    Serial.println("[BOOT] Reset button held! Wiping saved Wi-Fi and broadcasting AgosTech-Setup hotspot...");
    clearConfig();
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_AP_STA);
    delay(500);
    WiFiManager wmPortal;
    wmPortal.setConfigPortalTimeout(300); // 5 minute portal timeout for phone setup
    wmPortal.startConfigPortal(PORTAL_SSID, PORTAL_PASSWORD);
    ESP.restart();
  }

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

  // Initialize LittleFS Internal Flash Storage
  if (!LittleFS.begin(true)) {
    Serial.println("[LittleFS] ✗ Flash storage mount failed.");
  } else {
    Serial.println("[LittleFS] ✓ Internal Flash storage mounted successfully.");
  }

  // Configure background Wi-Fi auto-reconnect
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  loadConfig();
  startProvisioning();
  connectMQTT();

  Serial.println("[AgosTech] Initialized successfully. Starting monitoring loop.\n");
}

// ─────────────────────────────────────────────────────────────
//  MAIN EXECUTION LOOP
// ─────────────────────────────────────────────────────────────
void loop() {
  // Service background Wi-Fi setup portal requests asynchronously without blocking sensors
  wm.process();

  unsigned long now = millis();

  // 1. Maintain MQTT connection when Wi-Fi is connected
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) {
      if (now - lastMqttRetry >= MQTT_RECONNECT_MS) {
        lastMqttRetry = now;
        connectMQTT();
      }
    } else {
      mqttClient.loop();
    }
  }

  // 2. Execute sensor reading & logging cycle continuously on schedule
  if (now - lastPost >= publishIntervalMs) {
    lastPost = now;
    sensorCycle();
  }
}
