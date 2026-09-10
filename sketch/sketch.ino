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
#define PUMP_PIN 26

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

enum Mood { MOOD_NONE, MOOD_HAPPY, MOOD_THIRSTY, MOOD_SLEEPY, MOOD_ANGRY, MOOD_NIGHT };

Mood currentMood   = MOOD_NONE;
Mood lastDrawnMood = MOOD_NONE;
bool isBlinking     = false;
bool lastDrawnBlink = false;
unsigned long blinkStart   = 0;
unsigned long lastBlinkEnd = 0;

const unsigned long READ_INTERVAL_MS  = 30000;
const unsigned long WIFI_RETRY_MS     = 10000;
const unsigned long BLINK_INTERVAL_MS = 4000;
const unsigned long BLINK_DURATION_MS = 150;

// Vecina relej modula ukljucuje na nizak nivo, pa je HIGH iskljuceno.
const bool PUMP_ACTIVE_LOW = true;

// Prag zedji stize sa servera uz stanje, iz aktivnog profila biljke, i cuva se
// za slucaj da server prestane da odgovara. Vrednost ispod vazi samo do prvog
// uspesnog odgovora.
float soilThirstyPct = 30.0;

const unsigned long PUMP_BURST_MS    = 5000;
const unsigned long PUMP_COOLDOWN_MS = 30UL * 60UL * 1000UL;
const unsigned long DAY_MS           = 24UL * 60UL * 60UL * 1000UL;
const int PUMP_MAX_PER_DAY = 3;
const int PUMP_DRY_STREAK  = 3;

int  devicePump    = -1;
int  dryStreak     = 0;
int  pumpRunsToday = 0;
bool pumpRunning   = false;
unsigned long pumpStart   = 0;
unsigned long lastPumpEnd = 0;
unsigned long dayStart    = 0;

unsigned long lastReadTime = 0;
unsigned long lastWifiTry  = 0;
bool everRead = false;

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
  // Prvo od svega. digitalWrite pre pinMode postavlja izlazni registar, pa pin
  // ne trepne u nulu u trenutku kad postane izlaz i ne okine relej.
  pumpOff();
  pinMode(PUMP_PIN, OUTPUT);
  pumpOff();

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

// Petlja se vrti stalno, a merenje se zakazuje preko millis(). Bez toga lice
// ne bi moglo da trepce izmedju dva ocitavanja.
void loop() {
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiTry >= WIFI_RETRY_MS) {
      lastWifiTry = now;
      showMessage("Nema WiFi mreze", "Pokusavam ponovo");
      lastDrawnMood = MOOD_NONE;
      ensureWifi();
    }
    delay(20);
    return;
  }

  if (!everRead || now - lastReadTime >= READ_INTERVAL_MS) {
    everRead = true;
    lastReadTime = now;
    readAndSend();
  }

  updatePump(millis());
  updateFace(millis());
  delay(20);
}

void readAndSend() {
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
  bool thirsty;
  if (state == "offline") {
    showMessage("Nema veze sa", "serverom");
    currentMood   = MOOD_NONE;
    lastDrawnMood = MOOD_NONE;
    thirsty = (soilPct < soilThirstyPct);   // bez servera procenjuje sam
  } else {
    currentMood = moodFromState(state);
    thirsty = (state == "thirsty");
  }

  dryStreak = thirsty ? dryStreak + 1 : 0;
  maybeWater(millis());
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
    else if (type == "pump")                 devicePump  = id;
  }
  Serial.println("Uredjaji: tlo=" + String(deviceSoil) +
                 " temp=" + String(deviceTemp) +
                 " svetlost=" + String(deviceLight) +
                 " pumpa=" + String(devicePump));
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

  if (!doc["profile"]["soil_thirsty"].isNull()) {
    soilThirstyPct = doc["profile"]["soil_thirsty"].as<float>();
  }
  Serial.println("Stanje: " + state);
  Serial.println("Razlog: " + reason);
  return state;
}

void pumpOff() { digitalWrite(PUMP_PIN, PUMP_ACTIVE_LOW ? HIGH : LOW); }
void pumpOn()  { digitalWrite(PUMP_PIN, PUMP_ACTIVE_LOW ? LOW  : HIGH); }

// Svi uslovi na jednom mestu, da se vidi zasto zalivanje nije poceo.
void maybeWater(unsigned long now) {
  if (now - dayStart >= DAY_MS) {
    dayStart = now;
    pumpRunsToday = 0;
  }

  if (pumpRunning) return;
  if (dryStreak < PUMP_DRY_STREAK) return;

  if (lastPumpEnd != 0 && now - lastPumpEnd < PUMP_COOLDOWN_MS) {
    Serial.println("Zedna je, ali je pauza posle zalivanja jos u toku.");
    return;
  }
  if (pumpRunsToday >= PUMP_MAX_PER_DAY) {
    Serial.println("Zedna je, ali je dnevni limit zalivanja dostignut.");
    return;
  }

  pumpOn();
  pumpRunning = true;
  pumpStart   = now;
  pumpRunsToday++;
  dryStreak = 0;
  Serial.println("Zalivanje poceto, " + String(PUMP_BURST_MS / 1000) + "s");
}

// Zove se iz petlje na svakih 20 ms, pa impuls traje tacno koliko treba
// bez obzira na to sta se desava sa mrezom.
void updatePump(unsigned long now) {
  if (!pumpRunning) return;
  if (now - pumpStart < PUMP_BURST_MS) return;

  pumpOff();
  pumpRunning = false;
  lastPumpEnd = now;
  Serial.println("Zalivanje zavrseno");
  postReading(devicePump, PUMP_BURST_MS / 1000.0, "s");
}

Mood moodFromState(const String &state) {
  if (state == "happy")   return MOOD_HAPPY;
  if (state == "thirsty") return MOOD_THIRSTY;
  if (state == "sleepy")  return MOOD_SLEEPY;
  if (state == "angry")   return MOOD_ANGRY;
  if (state == "night")   return MOOD_NIGHT;
  return MOOD_NONE;
}

// openness: 0.05 skoro zatvoreno .. 1.0 siroko otvoreno
void drawEye(int cx, int cy, int eyeRadius, float openness) {
  int halfHeight = max(1, (int)(eyeRadius * openness));
  int cornerRadius = min(eyeRadius, halfHeight);
  display.fillRoundRect(cx - eyeRadius, cy - halfHeight,
                        eyeRadius * 2, halfHeight * 2,
                        cornerRadius, SSD1306_WHITE);
}

// innerUp podize kraj obrve blizi sredini lica (zabrinuto), inace ga spusta (ljuto).
// isLeft govori koja je strana unutrasnja, da obrve budu ogledane.
void drawEyebrow(int cx, int cy, int width, bool innerUp, bool isLeft) {
  int outerY = innerUp ? cy + 4 : cy - 2;
  int innerY = innerUp ? cy - 2 : cy + 4;
  int leftY  = isLeft ? outerY : innerY;
  int rightY = isLeft ? innerY : outerY;
  display.drawLine(cx - width / 2, leftY, cx + width / 2, rightY, SSD1306_WHITE);
}

// Parabola: curve > 0 krajevi gore, < 0 krajevi dole. Sluzi i za usta i za
// zatvorene oci. Skala 3 drzi krajeve izmedju ociju i donje ivice; sa vecom
// skalom osmeh ulazi u oci a mrgud ispada sa ekrana.
void drawArc(int cx, int cy, int halfWidth, float curve) {
  int prevX = cx - halfWidth;
  // Prva tacka mora da krene sa same krive. Ako se krene od cy, prvi potez
  // je uspravna crta na levom kraju usta.
  int prevY = cy - (int)(curve * 3);
  for (int x = -halfWidth + 1; x <= halfWidth; x++) {
    float t = (float)x / halfWidth;
    int y = cy - (int)(curve * t * t * 3);
    int screenX = cx + x;
    display.drawLine(prevX, prevY, screenX, y, SSD1306_WHITE);
    prevX = screenX;
    prevY = y;
  }
}

void drawDrop(int cx, int cy) {
  display.fillTriangle(cx, cy - 6, cx - 4, cy + 2, cx + 4, cy + 2, SSD1306_WHITE);
  display.fillCircle(cx, cy + 3, 4, SSD1306_WHITE);
}

// Panel je dvobojan: gornjih 16 redova je zuto, ostalo plavo. Obrve su cele
// u zutom pojasu, kap cela u plavom, da nijedan element ne preseca granicu.
void drawZzz() {
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  const int xs[] = {104, 111, 118};
  const int ys[] = { 40,  31,  22};
  for (int i = 0; i < 3; i++) {
    display.setCursor(xs[i], ys[i]);
    display.print("z");
  }
}

// Zatvorene oci se ne otvaraju zbog trepnuca; spavanje i trepnuce se ne mesaju.
bool moodBlinks(Mood mood) {
  return mood == MOOD_HAPPY || mood == MOOD_THIRSTY || mood == MOOD_ANGRY;
}

void drawFace(Mood mood, bool blinkClosed) {
  const int eyeY = 24, eyeR = 12, leftX = 40, rightX = 88;

  float openness  = 1.0;
  float mouthCurve = 0.0;
  bool brows = false, browsUp = false, drop = false;
  bool closedEyes = false, zzz = false;

  switch (mood) {
    case MOOD_HAPPY:   openness = 1.0; mouthCurve =  3.0; break;
    case MOOD_THIRSTY: openness = 0.7; mouthCurve = -2.5; brows = true; browsUp = true;  drop = true; break;
    case MOOD_SLEEPY:  closedEyes = true; mouthCurve = 0.5; break;
    case MOOD_ANGRY:   openness = 0.6; mouthCurve = -2.5; brows = true; browsUp = false; break;
    case MOOD_NIGHT:   closedEyes = true; mouthCurve = 1.5; zzz = true; break;
    default: return;
  }

  if (blinkClosed) { openness = 0.08; closedEyes = false; }

  display.clearDisplay();
  if (closedEyes) {
    drawArc(leftX,  eyeY, 11, 2.0);
    drawArc(rightX, eyeY, 11, 2.0);
  } else {
    drawEye(leftX,  eyeY, eyeR, openness);
    drawEye(rightX, eyeY, eyeR, openness);
  }

  if (brows && !blinkClosed) {
    int browY = eyeY - eyeR - 6;
    drawEyebrow(leftX,  browY, 16, browsUp, true);
    drawEyebrow(rightX, browY, 16, browsUp, false);
  }

  drawArc(64, 52, 20, mouthCurve);

  if (drop && !blinkClosed) drawDrop(20, 40);
  if (zzz) drawZzz();

  display.display();
}

// Crta samo kad se nesto promeni, da se ekran ne osvezava dvadeset puta u sekundi.
void updateFace(unsigned long now) {
  if (!displayReady || currentMood == MOOD_NONE) return;

  if (!moodBlinks(currentMood)) {
    if (currentMood != lastDrawnMood || lastDrawnBlink) {
      drawFace(currentMood, false);
      lastDrawnMood  = currentMood;
      lastDrawnBlink = false;
    }
    return;
  }

  if (!isBlinking && now - lastBlinkEnd >= BLINK_INTERVAL_MS) {
    isBlinking = true;
    blinkStart = now;
  } else if (isBlinking && now - blinkStart >= BLINK_DURATION_MS) {
    isBlinking = false;
    lastBlinkEnd = now;
  }

  if (currentMood != lastDrawnMood || isBlinking != lastDrawnBlink) {
    drawFace(currentMood, isBlinking);
    lastDrawnMood  = currentMood;
    lastDrawnBlink = isBlinking;
  }
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
