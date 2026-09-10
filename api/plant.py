import psycopg2.extras


STATE_LABEL = {
    "happy": "Srećna",
    "thirsty": "Žedna",
    "sleepy": "Pospana",
    "angry": "Ljuta",
}

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


def evaluate_state(readings, profile=None):
    """
    Osnovno stanje je happy. Pravila se primenjuju redom, pa poslednje koje se
    poklopi pobeđuje: žeđ nadjačava sve.
    """
    p = profile or DEFAULT_PROFILE
    state = "happy"
    reason = "Sve je u redu, biljka je zadovoljna."

    soil = readings.get("soil_humidity")
    temp = readings.get("temperature_humidity")
    co2 = readings.get("co2")
    light = readings.get("light")

    if light and light["value"] < p["light_min"]:
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
