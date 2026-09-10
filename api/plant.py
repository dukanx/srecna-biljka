import os
from datetime import datetime
from zoneinfo import ZoneInfo

import psycopg2.extras


TZ = ZoneInfo(os.getenv("TIMEZONE", "Europe/Belgrade"))
NIGHT_FROM = int(os.getenv("NIGHT_FROM", "19"))
NIGHT_TO = int(os.getenv("NIGHT_TO", "9"))

STATE_LABEL = {
    "happy": "Srećna",
    "thirsty": "Žedna",
    "sleepy": "Pospana",
    "angry": "Ljuta",
    "night": "Spava",
}

# Stanja za koja se ne šalje notifikacija. Noću je mrak očekivan, pa bi push
# stizao svako veče i ne bi značio ništa.
SILENT_STATES = {"night"}

# Noću prolaze samo stvari koje traže da se odmah ustane i nešto uradi. Upaljeno
# svetlo u sobi ne treba da donese "Srećna" u pola jedanaest uveče.
NIGHT_ALERT_STATES = {"thirsty", "angry"}

# Koristi se dok u bazi nema nijednog profila.
DEFAULT_PROFILE = {
    "name": "Opšte sobno bilje",
    "soil_thirsty": 30,
    "soil_ideal_lo": 40,
    "soil_ideal_hi": 70,
    "light_min": 500,
    "light_ideal": 1000,
    "temp_min": 18,
    "temp_max": 30,
}


def is_night(now=None):
    """Noć je od NIGHT_FROM do NIGHT_TO po lokalnom vremenu, preko ponoći."""
    hour = (now or datetime.now(TZ)).hour
    if NIGHT_FROM <= NIGHT_TO:
        return NIGHT_FROM <= hour < NIGHT_TO
    return hour >= NIGHT_FROM or hour < NIGHT_TO


def should_notify(state, now=None):
    """Da li promena u ovo stanje zaslužuje push."""
    if state in SILENT_STATES:
        return False
    if is_night(now):
        return state in NIGHT_ALERT_STATES
    return True


def fetch_latest_readings(conn):
    """Vrati dict {tip_senzora: {value, unit, recorded_at}} sa poslednjim očitavanjem po tipu."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT DISTINCT ON (d.type)
            d.type,
            r.value,
            r.unit,
            r.recorded_at
        FROM readings r
        JOIN devices d ON r.device_id = d.id
        WHERE d.status = 'active'
        ORDER BY d.type, r.recorded_at DESC
    """)
    rows = cur.fetchall()
    cur.close()
    return {row["type"]: dict(row) for row in rows}


def fetch_active_profile(conn):
    """Aktivan profil biljke; DEFAULT_PROFILE ako tabela još nije popunjena."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM plant_profiles WHERE is_active = TRUE LIMIT 1")
    row = cur.fetchone()
    cur.close()
    return dict(row) if row else dict(DEFAULT_PROFILE)


def evaluate_state(readings, profile=None, now=None):
    """
    Osnovno stanje je happy, ili night ako je noć. Pravila se primenjuju redom,
    pa poslednje koje se poklopi pobeđuje: žeđ nadjačava sve.

    Mrak se noću ne prijavljuje jer je očekivan, ali žeđ i vrućina se prijavljuju
    i tada, samo bez notifikacije za samo stanje spavanja.
    """
    p = profile or DEFAULT_PROFILE
    night = is_night(now)

    if night:
        state, reason = "night", "Noć je, biljka spava."
    else:
        state, reason = "happy", "Sve je u redu, biljka je zadovoljna."

    soil = readings.get("soil_humidity")
    temp = readings.get("temperature_humidity")
    co2 = readings.get("co2")
    light = readings.get("light")

    if not night and light and light["value"] < p["light_min"]:
        state = "sleepy"
        reason = f"Premalo svetlosti ({light['value']} lux). Premesti biljku na svetlije mesto."

    if temp and temp["value"] > p["temp_max"]:
        state = "angry"
        reason = f"Temperatura previsoka ({temp['value']}°C). Pomeri biljku dalje od izvora toplote."

    if co2 and co2["value"] > 1000:
        state = "angry"
        reason = f"Nivo CO2 previsok ({co2['value']} ppm). Provetri prostoriju."

    if soil and soil["value"] < p["soil_thirsty"]:
        state = "thirsty"
        reason = f"Vlažnost tla preniska ({soil['value']}%). Biljci je potrebna voda."

    return state, reason
