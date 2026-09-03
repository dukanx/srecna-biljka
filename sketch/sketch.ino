#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <SimpleDHT.h>
#include "secrets.h"   // WIFI_SSID, WIFI_PASSWORD, API_BASE, API_KEY

// Analogni senzori rade na 3.3V. Na 5V napajanju AO izlaz prelazi 3.3V i
// oštećuje ADC ulaz. SOIL_PIN i LDR_PIN su na ADC1; ADC2 ne radi uz WiFi.

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SOIL_PIN 34
#define LDR_PIN  35
#define DHT_PIN  4

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
SimpleDHT11 dht11(DHT_PIN);

const unsigned long WIFI_TIMEOUT_MS = 20000;

// Izmereno 31.08.2026. preko kalibracija/kalibracija.ino, važi za ove primerke.
const int SOIL_RAW_DRY = 3300;   // senzor na vazduhu, suv
const int SOIL_RAW_WET = 970;    // senzor u čaši vode, do bele linije

// Ovaj LDR daje veću vrednost u mraku, otud DARK > BRIGHT i negativan nagib.
const int   LDR_RAW_DARK   = 3900;     // polumracna soba nocu
const int   LDR_RAW_BRIGHT = 265;      // lampa telefona sa ~20 cm
const float LDR_LUX_DARK   = 0.0;      // koliko lux-a pripisujemo tački "mrak"
const float LDR_LUX_BRIGHT = 2000.0;   // koliko lux-a pripisujemo tački "svetlo"

// Tip senzora -> id u bazi, popunjava se na startu iz GET /api/devices.
// -1 znači da uređaj tog tipa nije pronađen, pa se njegova očitavanja preskaču.
int deviceSoil  = -1;
int deviceTemp  = -1;
int deviceLight = -1;

bool displayReady = false;

// Globalni da se TLS bafer ne alocira iznova pri svakom zahtevu.
WiFiClient       plainClient;
WiFiClientSecure secureClient;

bool beginRequest(HTTPClient &http, const String &path) {
  String url = String(API_BASE) + path;
  http.setConnectTimeout(10000);
  http.setTimeout(10000);
  if (url.startsWith("https://")) {
    // Bez provere sertifikata. Ugrađen root sertifikat ima rok trajanja, posle
    // kog uređaj prestaje da šalje dok se ne reflešuje.
    secureClient.setInsecure();
    return http.begin(secureClient, url);
  }
  return http.begin(plainClient, url);
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  displayReady = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!displayReady) {
    Serial.println("OLED nije pronadjen, nastavljam bez njega...");
  } else {
    showMessage("Srecna biljka", "Pokretanje...");
  }
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  ensureWifi();
  if (displayReady) showMessage("Srecna biljka", "Trazim uredjaje...");
  loadDeviceIds();
}

void loop() {
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) {
    showMessage("Nema WiFi mreze", "Pokusavam ponovo");
    delay(10000);
    return;
  }
  if (deviceSoil < 0 && deviceTemp < 0 && deviceLight < 0) {
    loadDeviceIds();
  }

  int soilRaw   = readAnalogAvg(SOIL_PIN);
  float soilPct = soilRawToPercent(soilRaw);
  Serial.println("Vlaznost tla: " + String(soilPct, 1) + "% (raw " + String(soilRaw) + ")");
  postReading(deviceSoil, soilPct, "%");

  byte temp = 0;
  byte hum  = 0;
  int err   = dht11.read(&temp, &hum, NULL);
  if (err == SimpleDHTErrSuccess) {
    Serial.println("Temp: " + String(temp) + "C");
    postReading(deviceTemp, (float)temp, "C");
  } else {
    Serial.println("DHT greska: " + String(err));
  }

  int lightRaw = readAnalogAvg(LDR_PIN);
  float lux    = ldrRawToLux(lightRaw);
  Serial.println("Svetlost: " + String(lux, 0) + " lux (raw " + String(lightRaw) + ")");
  postReading(deviceLight, lux, "lux");

  String state = getPlantState();
  showState(state);
  delay(30000);
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.print("Konektujem na WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Povezan! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("WiFi nije dostupan, probam u sledecem krugu.");
  }
}

int readAnalogAvg(int pin) {
  long sum = 0;
  for (int i = 0; i < 10; i++) {
    sum += analogRead(pin);
    delay(5);
  }
  return (int)(sum / 10);
}

float soilRawToPercent(int raw) {
  // Kapacitivni senzor: što je vlažnije, to je sirova vrednost manja.
  float pct = (float)(SOIL_RAW_DRY - raw) * 100.0 / (float)(SOIL_RAW_DRY - SOIL_RAW_WET);
  return constrain(pct, 0.0, 100.0);
}

float ldrRawToLux(int raw) {
  // Linearna interpolacija između dve izmerene tačke, nagib je negativan.
  float span = (float)(LDR_RAW_BRIGHT - LDR_RAW_DARK);
  if (span == 0) return LDR_LUX_DARK;
  float lux = LDR_LUX_DARK + (float)(raw - LDR_RAW_DARK) * (LDR_LUX_BRIGHT - LDR_LUX_DARK) / span;
  return constrain(lux, LDR_LUX_DARK, LDR_LUX_BRIGHT);
}

void loadDeviceIds() {
  HTTPClient http;
  beginRequest(http, "/api/devices");
  int code = http.GET();
  Serial.println("GET /api/devices -> " + String(code));
  if (code != 200) {
    Serial.println("Ne mogu da ucitam uredjaje, pokusavam ponovo u sledecem krugu.");
    http.end();
    return;
  }
  String payload = http.getString();
  http.end();

  // Filter zadržava samo id i type, da JSON dokument ostane mali.
  JsonDocument filter;
  filter["devices"][0]["id"]   = true;
  filter["devices"][0]["type"] = true;

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, DeserializationOption::Filter(filter));
  if (err) {
    Serial.println("JSON greska: " + String(err.c_str()));
    return;
  }

  for (JsonObject d : doc["devices"].as<JsonArray>()) {
    String type = d["type"].as<String>();
    int id      = d["id"].as<int>();
    if (type == "soil_humidity")             deviceSoil  = id;
    else if (type == "temperature_humidity") deviceTemp  = id;
    else if (type == "light")                deviceLight = id;
  }
  Serial.println("Uredjaji: tlo=" + String(deviceSoil) +
                 " temp=" + String(deviceTemp) +
                 " svetlost=" + String(deviceLight));
}

void postReading(int deviceId, float value, String unit) {
  if (deviceId < 0) {
    Serial.println("Preskacem slanje - uredjaj za '" + unit + "' nije pronadjen u bazi.");
    return;
  }
  HTTPClient http;
  beginRequest(http, "/api/readings");
  http.addHeader("Content-Type", "application/json");
  if (strlen(API_KEY) > 0) {
    http.addHeader("X-API-Key", API_KEY);
  }
  String body = "{\"device_id\":" + String(deviceId) +
                ",\"value\":"     + String(value, 1) +
                ",\"unit\":\""    + unit + "\"}";
  int code = http.POST(body);
  Serial.println("POST /api/readings -> " + String(code));
  http.end();
}

String getPlantState() {
  HTTPClient http;
  beginRequest(http, "/api/plant/state");
  int code = http.GET();
  Serial.println("GET /api/plant/state -> " + String(code));
  if (code != 200) {
    Serial.println("Error: " + http.errorToString(code));
    http.end();
    return "offline";
  }
  String payload = http.getString();
  http.end();
  JsonDocument doc;
  deserializeJson(doc, payload);
  String state  = doc["state"].as<String>();
  String reason = doc["reason"].as<String>();
  Serial.println("Stanje: " + state);
  Serial.println("Razlog: " + reason);
  return state;
}

void showState(String state) {
  if (!displayReady) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(0, 0);
  if (state == "happy") {
    display.println(":)");
    display.setTextSize(1);
    display.println("Sve je OK!");
  } else if (state == "thirsty") {
    display.println(":(");
    display.setTextSize(1);
    display.println("Zedna sam!");
    display.println("Zalij me!");
  } else if (state == "angry") {
    display.println(">:(");
    display.setTextSize(1);
    display.println("Prevruce!");
  } else if (state == "sleepy") {
    display.println("-_-");
    display.setTextSize(1);
    display.println("Premalo svetla");
  } else {
    display.println("...");
    display.setTextSize(1);
    display.println("Nema veze sa");
    display.println("serverom");
  }
  display.display();
}

void showMessage(const char* line1, const char* line2) {
  if (!displayReady) return;
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(line1);
  display.println(line2);
  display.display();
}
