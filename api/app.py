import functools
import os

from flask import Flask, jsonify, request, send_from_directory
import psycopg2.extras

from db import get_connection, init_db  # db importuje dotenv -> .env učitan pre push modula
import push
from plant import (fetch_latest_readings, fetch_active_profile, evaluate_state,
                   STATE_LABEL)

app = Flask(__name__)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Ako API_KEY nije postavljen, zaštita je isključena i sve radi kao ranije.
# Na javnom hostingu je obavezan.
API_KEY = os.getenv("API_KEY")


def require_api_key(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if API_KEY and request.headers.get("X-API-Key") != API_KEY:
            return jsonify({"error": "Neispravan ili nedostajuci API kljuc"}), 401
        return fn(*args, **kwargs)
    return wrapper



@app.route("/api/devices", methods=["GET"])
def get_all_devices():
    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM devices ORDER BY created_at DESC")
    devices = cur.fetchall()
    cur.close()
    conn.close()

    return jsonify({
        "status": "success",
        "count": len(devices),
        "devices": devices
    }), 200


@app.route("/api/devices", methods=["POST"])
@require_api_key
def create_device():
    data = request.get_json()

    if not data:
        return jsonify({"error": "Body mora biti JSON"}), 400
    if "name" not in data or "type" not in data:
        return jsonify({"error": "Obavezna polja: name, type"}), 400

    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        INSERT INTO devices (name, type, location, status)
        VALUES (%s, %s, %s, %s)
        RETURNING *
        """,
        (data["name"], data["type"], data.get("location"), data.get("status", "active"))
    )
    new_device = cur.fetchone()
    conn.commit()
    cur.close()
    conn.close()

    return jsonify(new_device), 201


@app.route("/api/devices/<int:device_id>", methods=["GET"])
def get_device(device_id):
    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM devices WHERE id = %s", (device_id,))
    device = cur.fetchone()
    cur.close()
    conn.close()

    if device is None:
        return jsonify({"error": f"Uredjaj sa ID={device_id} nije pronadjen"}), 404

    return jsonify(device), 200


@app.route("/api/devices/<int:device_id>", methods=["PUT"])
@require_api_key
def update_device(device_id):
    data = request.get_json()

    if not data:
        return jsonify({"error": "Body mora biti JSON"}), 400

    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        UPDATE devices
        SET name     = COALESCE(%s, name),
            type     = COALESCE(%s, type),
            location = COALESCE(%s, location),
            status   = COALESCE(%s, status)
        WHERE id = %s
        RETURNING *
        """,
        (
            data.get("name"),
            data.get("type"),
            data.get("location"),
            data.get("status"),
            device_id
        )
    )
    updated = cur.fetchone()
    conn.commit()
    cur.close()
    conn.close()

    if updated is None:
        return jsonify({"error": f"Uredjaj sa ID={device_id} nije pronadjen"}), 404

    return jsonify(updated), 200


@app.route("/api/devices/<int:device_id>", methods=["DELETE"])
@require_api_key
def delete_device(device_id):
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM devices WHERE id = %s RETURNING id", (device_id,))
    deleted = cur.fetchone()
    conn.commit()
    cur.close()
    conn.close()

    if deleted is None:
        return jsonify({"error": f"Uređaj sa ID={device_id} nije pronađen"}), 404

    return jsonify({"msg": f"Uređaj {device_id} je uspešno obrisan"}), 200


@app.route("/api/readings", methods=["GET"])
def get_readings():
    device_id = request.args.get("device_id")

    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    if device_id:
        cur.execute(
            "SELECT * FROM readings WHERE device_id = %s ORDER BY recorded_at DESC",
            (device_id,)
        )
    else:
        cur.execute("SELECT * FROM readings ORDER BY recorded_at DESC LIMIT 100")

    readings = cur.fetchall()
    cur.close()
    conn.close()

    return jsonify({
        "status": "success",
        "count": len(readings),
        "readings": readings
    }), 200


@app.route("/api/readings", methods=["POST"])
@require_api_key
def create_reading():
    data = request.get_json()

    if not data:
        return jsonify({"error": "Body mora biti JSON"}), 400
    if "device_id" not in data or "value" not in data or "unit" not in data:
        return jsonify({"error": "Obavezna polja: device_id, value, unit"}), 400

    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT id FROM devices WHERE id = %s", (data["device_id"],))
    if cur.fetchone() is None:
        cur.close()
        conn.close()
        return jsonify({"error": f"Uređaj sa ID={data['device_id']} ne postoji"}), 404

    cur.execute(
        "INSERT INTO readings (device_id, value, unit) VALUES (%s, %s, %s) RETURNING *",
        (data["device_id"], data["value"], data["unit"])
    )
    new_reading = cur.fetchone()
    conn.commit()
    cur.close()

    # Posle svakog očitavanja proveri da li se stanje biljke promenilo i pošalji push.
    # Greška ovde ne sme da obori upis očitavanja.
    try:
        _check_state_change_and_notify(conn)
    except Exception as e:
        print(f"[state] greška pri proveri stanja: {e}")

    conn.close()
    return jsonify(new_reading), 201


def _check_state_change_and_notify(conn):
    """Uporedi trenutno stanje sa poslednjim logovanim; ako se promenilo -> loguj + push."""
    readings = fetch_latest_readings(conn)
    if not readings:
        return

    state, reason = evaluate_state(readings, fetch_active_profile(conn))

    cur = conn.cursor()
    cur.execute("SELECT state FROM plant_state_log ORDER BY recorded_at DESC LIMIT 1")
    row = cur.fetchone()
    last_state = row[0] if row else None

    if state == last_state:
        cur.close()
        return

    cur.execute(
        "INSERT INTO plant_state_log (state, reason) VALUES (%s, %s)",
        (state, reason)
    )
    conn.commit()
    cur.close()

    payload = {
        "title": f"Srećna biljka — {STATE_LABEL.get(state, state)}",
        "body": reason,
        "state": state,
        "url": "/dashboard",
    }
    sent = push.send_to_all(conn, payload)
    print(f"[state] promena stanja -> {state}; push poslat na {sent} uređaja")


@app.route("/api/plant/state", methods=["GET"])
def get_plant_state():
    conn = get_connection()
    readings = fetch_latest_readings(conn)
    profile = fetch_active_profile(conn)
    conn.close()

    state, reason = evaluate_state(readings, profile)

    return jsonify({
        "state": state,
        "reason": reason,
        "readings": readings,
        "profile": profile
    }), 200


@app.route("/api/plant/history", methods=["GET"])
def get_plant_history():
    """Vremenske serije po tipu senzora za grafikone. ?hours=24 (podrazumevano)."""
    hours = request.args.get("hours", 24, type=int)

    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        SELECT d.type, r.value, r.unit, r.recorded_at
        FROM readings r
        JOIN devices d ON r.device_id = d.id
        WHERE d.status = 'active'
          AND r.recorded_at >= NOW() - make_interval(hours => %s)
        ORDER BY r.recorded_at ASC
        """,
        (hours,)
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()

    history = {}
    for row in rows:
        history.setdefault(row["type"], []).append({
            "value": row["value"],
            "unit": row["unit"],
            "recorded_at": row["recorded_at"].isoformat(),
        })

    return jsonify(history), 200


# ── Profili biljke ──────────────────────────────────────────────
@app.route("/api/profiles", methods=["GET"])
def get_profiles():
    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM plant_profiles ORDER BY name")
    profiles = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify({"profiles": profiles}), 200


PROFILE_FIELDS = ("soil_thirsty", "soil_ideal_lo", "soil_ideal_hi",
                  "light_min", "light_ideal", "temp_min", "temp_max")


def _validate_profile(data):
    """Vrati (vrednosti, greska).

    Pragovi koji se ukrste napravili bi profil po kome biljka nikad nije
    zadovoljna, ili po kome pumpa zaliva u pogresnom trenutku, pa se odbijaju
    ovde umesto da se otkriju tek na uredjaju.
    """
    name = (data.get("name") or "").strip()
    if not name:
        return None, "Naziv profila je obavezan"
    if len(name) > 60:
        return None, "Naziv može imati najviše 60 znakova"

    values = {}
    for field in PROFILE_FIELDS:
        if data.get(field) is None:
            return None, f"Obavezno polje: {field}"
        try:
            values[field] = int(data[field])
        except (TypeError, ValueError):
            return None, f"Polje {field} mora biti ceo broj"

    for field in ("soil_thirsty", "soil_ideal_lo", "soil_ideal_hi"):
        if not 0 <= values[field] <= 100:
            return None, "Vlažnost tla se izražava u procentima, od 0 do 100"

    if values["soil_ideal_lo"] >= values["soil_ideal_hi"]:
        return None, "Donja granica idealne vlažnosti mora biti manja od gornje"
    if values["soil_thirsty"] > values["soil_ideal_lo"]:
        return None, "Prag žeđi ne može biti iznad idealnog opsega vlažnosti"
    if values["light_min"] < 0:
        return None, "Minimalna svetlost ne može biti negativna"
    if values["light_ideal"] <= values["light_min"]:
        return None, "Idealna svetlost mora biti veća od minimalne"
    if values["temp_min"] >= values["temp_max"]:
        return None, "Minimalna temperatura mora biti manja od maksimalne"

    values["name"] = name
    return values, None


@app.route("/api/profiles", methods=["POST"])
@require_api_key
def create_profile():
    """Napravi profil od izmerenih vrednosti. Uz activate=true odmah postaje aktivan."""
    data = request.get_json() or {}
    values, error = _validate_profile(data)
    if error:
        return jsonify({"error": error}), 400

    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Naziv je UNIQUE u bazi, ali poređenje bez obzira na velika slova daje
    # jasnu poruku umesto greške iz drajvera.
    cur.execute("SELECT name FROM plant_profiles WHERE lower(name) = lower(%s)", (values["name"],))
    postojeci = cur.fetchone()
    if postojeci is not None:
        cur.close()
        conn.close()
        return jsonify({"error": f"Profil pod nazivom \"{postojeci['name']}\" već postoji"}), 409

    cur.execute(
        """
        INSERT INTO plant_profiles
            (name, soil_thirsty, soil_ideal_lo, soil_ideal_hi,
             light_min, light_ideal, temp_min, temp_max, is_active)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, FALSE)
        RETURNING *
        """,
        (values["name"], values["soil_thirsty"], values["soil_ideal_lo"],
         values["soil_ideal_hi"], values["light_min"], values["light_ideal"],
         values["temp_min"], values["temp_max"])
    )
    profile = cur.fetchone()

    if data.get("activate"):
        cur.execute("UPDATE plant_profiles SET is_active = (id = %s)", (profile["id"],))
        profile["is_active"] = True

    conn.commit()
    cur.close()
    conn.close()
    return jsonify(profile), 201


@app.route("/api/profiles/active", methods=["PUT"])
@require_api_key
def set_active_profile():
    """Menja pragove po kojima se procenjuje stanje, pa i kad pumpa zaliva.
    Zato traži ključ, iako je dashboard inače javan za čitanje."""
    data = request.get_json() or {}
    if "id" not in data:
        return jsonify({"error": "Obavezno polje: id"}), 400

    conn = get_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT id FROM plant_profiles WHERE id = %s", (data["id"],))
    if cur.fetchone() is None:
        cur.close()
        conn.close()
        return jsonify({"error": f"Profil sa ID={data['id']} ne postoji"}), 404

    cur.execute("UPDATE plant_profiles SET is_active = (id = %s)", (data["id"],))
    conn.commit()
    cur.execute("SELECT * FROM plant_profiles WHERE id = %s", (data["id"],))
    active = cur.fetchone()
    cur.close()
    conn.close()
    return jsonify(active), 200


# ── Web Push (VAPID) ────────────────────────────────────────────
@app.route("/api/vapid-public-key", methods=["GET"])
def vapid_public_key():
    return jsonify({"publicKey": push.VAPID_PUBLIC_KEY}), 200


@app.route("/api/push/subscribe", methods=["POST"])
def push_subscribe():
    data = request.get_json()
    if not data or "endpoint" not in data or "keys" not in data:
        return jsonify({"error": "Nevalidna subscription (treba endpoint i keys)"}), 400

    conn = get_connection()
    push.add_subscription(conn, data["endpoint"], data["keys"]["p256dh"], data["keys"]["auth"])
    conn.close()
    return jsonify({"status": "subscribed"}), 201


@app.route("/api/push/unsubscribe", methods=["POST"])
def push_unsubscribe():
    data = request.get_json()
    if not data or "endpoint" not in data:
        return jsonify({"error": "endpoint je obavezan"}), 400

    conn = get_connection()
    push.remove_subscription(conn, data["endpoint"])
    conn.close()
    return jsonify({"status": "unsubscribed"}), 200


@app.route("/api/push/test", methods=["POST"])
@require_api_key
def push_test():
    """Pošalji probnu notifikaciju (za testiranje da push radi bez čekanja promene stanja)."""
    conn = get_connection()
    sent = push.send_to_all(conn, {
        "title": "Srećna biljka",
        "body": "Probna notifikacija — push radi.",
        "state": "happy",
        "url": "/dashboard",
    })
    conn.close()
    return jsonify({"status": "sent", "count": sent}), 200


# ── PWA dashboard (statika) ─────────────────────────────────────
@app.route("/dashboard")
def dashboard():
    return send_from_directory(STATIC_DIR, "dashboard.html")


@app.route("/sw.js")
def service_worker():
    # Service worker mora da se servira sa korena da bi scope bio "/" (kontroliše /dashboard)
    resp = send_from_directory(STATIC_DIR, "sw.js")
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/manifest.json")
def manifest():
    return send_from_directory(STATIC_DIR, "manifest.json")


if __name__ == "__main__":
    init_db()
    app.run(debug=True, host="0.0.0.0")
