#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SimpleDHT.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SOIL_PIN 34
#define DHT_PIN  4

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
SimpleDHT11 dht11(DHT_PIN);

const char* WIFI_SSID     = "naziv_mreze";
const char* WIFI_PASSWORD = "lozinka";
const char* API_BASE      = "http://IP_LAPTOPA:5000";

const int DEVICE_SOIL  = 4;
const int DEVICE_TEMP  = 1;
const int DEVICE_LIGHT = 5;

void setup() {
  Serial.begin(115200);
  delay(2000);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED nije pronađen, nastavljam bez njega...");
  } else {
    showMessage("Srecna biljka", "Pokretanje...");
  }
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Konektujem na WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nPovezan! IP: " + WiFi.localIP().toString());
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi izgubljen!");
    return;
  }
  int soilRaw   = analogRead(SOIL_PIN);
  float soilPct = map(soilRaw, 0, 4095, 100, 0);
  Serial.println("Vlaznost tla: " + String(soilPct) + "%");
  postReading(DEVICE_SOIL, soilPct, "%");
  byte temp = 0;
  byte hum  = 0;
  int err   = dht11.read(&temp, &hum, NULL);
  if (err == SimpleDHTErrSuccess) {
    Serial.println("Temp: " + String(temp) + "C");
    Serial.println("Vlaznost vazduha: " + String(hum) + "%");
    postReading(DEVICE_TEMP, (float)temp, "C");
  } else {
    Serial.println("DHT greška: " + String(err));
  }
  postReading(DEVICE_LIGHT, 150.0, "lux");
  String state = getPlantState();
  showState(state);
  delay(30000);
}

void postReading(int deviceId, float value, String unit) {
  HTTPClient http;
  http.begin(String(API_BASE) + "/api/readings");
  http.addHeader("Content-Type", "application/json");
  String body = "{\"device_id\":" + String(deviceId) +
                ",\"value\":"     + String(value) +
                ",\"unit\":\""    + unit + "\"}";
  int code = http.POST(body);
  Serial.println("POST /api/readings → " + String(code));
  http.end();
}

String getPlantState() {
  HTTPClient http;
  http.begin(String(API_BASE) + "/api/plant/state");
  int code = http.GET();
  Serial.println("GET /api/plant/state → " + String(code));
  if (code != 200) {
    Serial.println("Error: " + http.errorToString(code));
    http.end();
    return "happy";
  }
  String payload = http.getString();
  http.end();
  StaticJsonDocument<1024> doc;
  deserializeJson(doc, payload);
  String state  = doc["state"].as<String>();
  String reason = doc["reason"].as<String>();
  Serial.println("Stanje: " + state);
  Serial.println("Razlog: " + reason);
  return state;
}

void showState(String state) {
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) return;
  display.clearDisplay();
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
    display.println("Prevuce/CO2!");
  } else if (state == "sleepy") {
    display.println("-_-");
    display.setTextSize(1);
    display.println("Premalo svetla");
  }
  display.display();
}

void showMessage(const char* line1, const char* line2) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(line1);
  display.println(line2);
  display.display();
}