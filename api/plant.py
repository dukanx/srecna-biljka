
import psycopg2.extras


STATE_LABEL = {
    "happy": "Srećna",
    "thirsty": "Žedna",
    "sleepy": "Pospana",
    "angry": "Ljuta",
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


def evaluate_state(readings):
    """
    sleepy < angry (temp/CO2) < thirsty
    """
    state = "happy"
    reason = "Sve je u redu, biljka je zadovoljna."

    soil = readings.get("soil_humidity")
    temp = readings.get("temperature_humidity")
    co2 = readings.get("co2")
    light = readings.get("light")

    if light and light["value"] < 500:
        state = "sleepy"
        reason = f"Premalo svetlosti ({light['value']} lux). Premesti biljku na svetlije mesto."

    if temp and temp["value"] > 30:
        state = "angry"
        reason = f"Temperatura previsoka ({temp['value']}°C). Pomeri biljku dalje od izvora toplote."

    if co2 and co2["value"] > 1000:
        state = "angry"
        reason = f"Nivo CO2 previsok ({co2['value']} ppm). Provetri prostoriju."

    if soil and soil["value"] < 30:
        state = "thirsty"
        reason = f"Vlažnost tla preniska ({soil['value']}%). Biljci je potrebna voda."

    return state, reason
