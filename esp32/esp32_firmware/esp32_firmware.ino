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

// ─────────────────────────────────────────────────────────────
//  PINS & HARDCODED SETTINGS
// ─────────────────────────────────────────────────────────────
#define PIN_RESET_BTN  0   // GPIO0  — BOOT button (hold 3 s to reset)
#define PIN_STATUS_LED 2   // GPIO2  — Built-in LED

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
//  SIMULATED SENSORS
//  (Replace with real analogRead/digitalRead sensor values)
// ─────────────────────────────────────────────────────────────
float readPH() {
  return 7.0f + (random(-100, 101) / 100.0f); // pH 6.0 to 8.0
}

float readTurbidity() {
  return 1.5f + (random(0, 30) / 10.0f); // 1.5 to 4.5 NTU
}

float readTDS() {
  return 150.0f + random(0, 100); // 150 to 250 ppm
}

float readTemperature() {
  return 25.0f + (random(-20, 21) / 10.0f); // 23°C to 27°C
}

float readAmmonia() {
  return 0.02f + (random(0, 10) / 100.0f); // 0.02 to 0.12 mg/L
}

float readFlowRate() {
  return 10.0f + (random(-20, 21) / 10.0f); // 8.0 to 12.0 L/min
}

float calcWaterConsumed(float flowRate) {
  return flowRate * (PUBLISH_INTERVAL_MS / 60000.0f);
}

// ─────────────────────────────────────────────────────────────
//  SEND SENSOR READINGS IN JSON FORMAT
// ─────────────────────────────────────────────────────────────
void sensorCycle() {
  float ph   = readPH();
  float turb = readTurbidity();
  float tds  = readTDS();
  float temp = readTemperature();
  float nh3  = readAmmonia();
  float flow = readFlowRate();
  float cons = calcWaterConsumed(flow);

  Serial.println("┌─ Current Sensor Values ──────────────────┐");
  Serial.printf( "│  pH Level : %.2f\n", ph);
  Serial.printf( "│  Turbidity: %.2f NTU\n", turb);
  Serial.printf( "│  TDS      : %.1f ppm\n", tds);
  Serial.printf( "│  Temp     : %.1f °C\n", temp);
  Serial.printf( "│  Ammonia  : %.3f mg/L\n", nh3);
  Serial.printf( "│  Flow Rate: %.2f L/min\n", flow);
  Serial.printf( "│  Consumed : %.4f L\n", cons);

  if (mqttClient.connected() && strlen(mqttTopic) > 0) {
    // Construct JSON payload
    StaticJsonDocument<256> doc;
    doc["device_id"]      = atoi(deviceId);
    doc["ph_level"]       = round(ph * 100) / 100.0;
    doc["turbidity"]      = round(turb * 100) / 100.0;
    doc["tds"]            = round(tds * 100) / 100.0;
    doc["temperature"]    = round(temp * 100) / 100.0;
    doc["ammonia"]        = round(nh3 * 1000) / 1000.0;
    doc["flow_rate"]      = round(flow * 100) / 100.0;
    doc["water_consumed"] = round(cons * 10000) / 10000.0;

    char payload[256];
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
//  RESET WIPE BUTTON INSTRUCTIONS (BOOT Pin hold 3s)
// ─────────────────────────────────────────────────────────────
void checkResetButton() {
  if (digitalRead(PIN_RESET_BTN) == LOW) {
    Serial.println("[Reset] Button held. Keep pressing for 3s to clear settings...");
    unsigned long t0 = millis();
    while (digitalRead(PIN_RESET_BTN) == LOW) {
      ledBlink(1, 80);
      if (millis() - t0 > 3000) {
        Serial.println("[Reset] Cleaning settings and rebooting...");
        clearConfig();
        ledBlink(10, 60);
        delay(500);
        ESP.restart();
      }
    }
  }
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
  pinMode(PIN_RESET_BTN,  INPUT_PULLUP);
  ledOff();
  randomSeed(analogRead(0));

  loadConfig();
  startProvisioning();
  connectMQTT();

  Serial.println("[AquaSense] Initialized successfully. Starting monitoring loop.\n");
}

// ─────────────────────────────────────────────────────────────
//  MAIN EXECUTION LOOP
// ─────────────────────────────────────────────────────────────
void loop() {
  checkResetButton();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Connection lost. Reconnecting...");
    ledOff();
    WiFi.reconnect();
    delay(5000);
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
