from flask import Flask, jsonify, request
import psycopg2.extras

from db import get_connection, init_db
from plant import fetch_latest_readings, evaluate_state, STATE_LABEL

app = Flask(__name__)


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
    conn.close()

    return jsonify(new_reading), 201


@app.route("/api/plant/state", methods=["GET"])
def get_plant_state():
    conn = get_connection()
    readings = fetch_latest_readings(conn)
    conn.close()

    state, reason = evaluate_state(readings)

    return jsonify({
        "state": state,
        "reason": reason,
        "readings": readings
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


if __name__ == "__main__":
    init_db()
    app.run(debug=True)
