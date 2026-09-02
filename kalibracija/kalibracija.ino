#include <SimpleDHT.h>

#define SOIL_PIN 34
#define LDR_PIN  35
#define DHT_PIN  4

SimpleDHT11 dht11(DHT_PIN);

const int SAMPLES = 20;

int readAnalogAvg(int pin) {
  long sum = 0;
  for (int i = 0; i < SAMPLES; i++) {
    sum += analogRead(pin);
    delay(5);
  }
  return (int)(sum / SAMPLES);
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("Kalibracija senzora - sirovi ADC (0-4095) + DHT11");
  Serial.println("tlo\tsvetlost\ttemp");
}

void loop() {
  Serial.print(readAnalogAvg(SOIL_PIN));
  Serial.print("\t");
  Serial.print(readAnalogAvg(LDR_PIN));
  Serial.print("\t");

  // DHT11 nije analogni - cita se svojim protokolom. Ovde je samo da se
  // proveri da li modul uopste odgovara; greska 0 znaci da je sve u redu.
  byte temp = 0;
  byte hum  = 0;
  int err   = dht11.read(&temp, &hum, NULL);
  if (err == SimpleDHTErrSuccess) {
    Serial.println(String((int)temp) + "C");
  } else {
    Serial.println("greska " + String(err));
  }
  delay(1500);
}
