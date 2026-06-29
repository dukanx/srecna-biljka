"""
Seed skript za demo "Srećne biljke" bez hardvera.

Šalje lažna očitavanja na pokrenuti API (preko HTTP-a), pa prolazi kroz
celu logiku: računanje stanja, log promene stanja i Web Push notifikacije.
Tako možeš da pokažeš dashboard i notifikacije iako senzori još nisu stigli.

Pokretanje:
    python seed.py            # prođe kroz sva stanja redom (najbolje za demo)
    python seed.py happy      # postavi jedno konkretno stanje
    python seed.py thirsty
    python seed.py sleepy
    python seed.py angry

API adresa se može promeniti preko env promenljive:
    API_BASE=http://localhost:5000 python seed.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

API_BASE = os.getenv("API_BASE", "http://localhost:5000")

# Pauza (sekunde) između stanja kad se prolazi kroz sva — da se na demou
# stigne videti svaka notifikacija. Može se promeniti: SEED_DELAY=10 python seed.py
STEP_DELAY = float(os.getenv("SEED_DELAY", "6"))

# Uređaji koje seed koristi: (tip, naziv, lokacija, jedinica).
# Tip MORA da se poklapa sa ključevima u plant.evaluate_state.
DEVICES = [
    ("soil_humidity",        "Senzor vlažnosti tla",   "saksija", "%"),
    ("temperature_humidity", "DHT11 temp/vlažnost",    "saksija", "C"),
    ("light",                "LDR senzor svetlosti",   "saksija", "lux"),
]

# Vrednosti po stanju. Pragovi (vidi plant.py):
#   tlo < 30 -> žedna, temp > 30 -> ljuta, svetlost < 500 -> pospana.
SCENARIOS = {
    "happy":   {"soil_humidity": 55, "temperature_humidity": 22, "light": 800},
    "thirsty": {"soil_humidity": 18, "temperature_humidity": 22, "light": 800},
    "sleepy":  {"soil_humidity": 55, "temperature_humidity": 22, "light": 150},
    "angry":   {"soil_humidity": 55, "temperature_humidity": 35, "light": 800},
}


def _request(method, path, body=None):
    url = API_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  [greška] {method} {path} -> {e.code} {e.read().decode()[:120]}")
        raise
    except urllib.error.URLError as e:
        print(f"  [greška] Ne mogu da se povežem na {API_BASE} ({e.reason}).")
        print("  Da li je server pokrenut? (python app.py)")
        sys.exit(1)


def get_or_create_devices():
    """Vrati {tip: device_id}, kreirajući uređaje koji još ne postoje."""
    existing = _request("GET", "/api/devices").get("devices", [])
    by_type = {d["type"]: d["id"] for d in existing}

    ids = {}
    for dtype, name, location, _unit in DEVICES:
        if dtype in by_type:
            ids[dtype] = by_type[dtype]
        else:
            created = _request("POST", "/api/devices", {
                "name": name, "type": dtype, "location": location, "status": "active",
            })
            ids[dtype] = created["id"]
            print(f"  + kreiran uređaj '{name}' (id={created['id']}, tip={dtype})")
    return ids


def post_scenario(name, device_ids):
    values = SCENARIOS[name]
    units = {dtype: unit for dtype, _n, _l, unit in DEVICES}
    print(f"\n>> Scenario: {name}")
    for dtype, value in values.items():
        _request("POST", "/api/readings", {
            "device_id": device_ids[dtype],
            "value": value,
            "unit": units[dtype],
        })
        print(f"   {dtype} = {value} {units[dtype]}")

    state = _request("GET", "/api/plant/state")
    print(f"   -> stanje: {state['state']} ({state['reason']})")


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    if arg and arg not in SCENARIOS:
        print(f"Nepoznato stanje '{arg}'. Dostupno: {', '.join(SCENARIOS)}")
        sys.exit(1)

    print(f"API: {API_BASE}")
    device_ids = get_or_create_devices()

    if arg:
        post_scenario(arg, device_ids)
    else:
        # Prođi kroz sva stanja redom da se vide promene + push na svakoj promeni.
        sequence = ["happy", "thirsty", "angry", "sleepy", "happy"]
        for i, name in enumerate(sequence):
            post_scenario(name, device_ids)
            if i < len(sequence) - 1:
                print(f"   ... pauza {STEP_DELAY:.0f}s (gledaj notifikaciju / dashboard)")
                time.sleep(STEP_DELAY)

    print("\nGotovo. Otvori /dashboard da vidiš rezultat.")


if __name__ == "__main__":
    main()
