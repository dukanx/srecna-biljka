import psycopg2
import psycopg2.extras
import os
from dotenv import load_dotenv

load_dotenv()  # čita .env fajl i stavlja vrednosti u os.environ

def get_connection():
    # Hosting daje jedan DATABASE_URL umesto pojedinačnih promenljivih.
    url = os.getenv("DATABASE_URL")
    if url:
        if "sslmode=" in url:
            return psycopg2.connect(url)
        # Postgres na cloudu po pravilu zahteva SSL; lokalno se gasi sa DB_SSLMODE=disable.
        return psycopg2.connect(url, sslmode=os.getenv("DB_SSLMODE", "require"))

    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD")
    )

def init_db():
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS devices (
            id         SERIAL PRIMARY KEY,
            name       VARCHAR(100) NOT NULL,
            type       VARCHAR(50)  NOT NULL,
            location   VARCHAR(100),
            status     VARCHAR(20)  NOT NULL DEFAULT 'active',
            created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS readings (
            id          SERIAL PRIMARY KEY,
            device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            value       FLOAT   NOT NULL,
            unit        VARCHAR(20) NOT NULL,
            recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # Web Push pretplate (jedan red = jedan browser koji je dao dozvolu)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id         SERIAL PRIMARY KEY,
            endpoint   TEXT UNIQUE NOT NULL,
            p256dh     TEXT NOT NULL,
            auth       TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # Istorija stanja biljke, po njoj se prepoznaje promena stanja
    cur.execute("""
        CREATE TABLE IF NOT EXISTS plant_state_log (
            id          SERIAL PRIMARY KEY,
            state       VARCHAR(20) NOT NULL,
            reason      TEXT,
            recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # Pragovi zavise od biljke: anturijum i kaktus nemaju iste potrebe.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS plant_profiles (
            id            SERIAL PRIMARY KEY,
            name          VARCHAR(60) UNIQUE NOT NULL,
            soil_thirsty  INTEGER NOT NULL,
            soil_ideal_lo INTEGER NOT NULL,
            soil_ideal_hi INTEGER NOT NULL,
            light_min     INTEGER NOT NULL,
            light_ideal   INTEGER NOT NULL,
            temp_min      INTEGER NOT NULL,
            temp_max      INTEGER NOT NULL,
            is_active     BOOLEAN NOT NULL DEFAULT FALSE
        );
    """)

    cur.execute("SELECT COUNT(*) FROM plant_profiles")
    if cur.fetchone()[0] == 0:
        cur.executemany(
            """INSERT INTO plant_profiles
               (name, soil_thirsty, soil_ideal_lo, soil_ideal_hi,
                light_min, light_ideal, temp_min, temp_max, is_active)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [
                ("Anturijum (flamingo lily)", 35, 40, 70,  400, 1200, 18, 28, True),
                ("Opšte sobno bilje",         30, 40, 70,  500, 1000, 18, 30, False),
                ("Kaktus i sukulente",        15, 15, 40, 1500, 5000, 10, 35, False),
                ("Paprat i vlagoljubive",     45, 55, 85,  300,  800, 16, 26, False),
            ]
        )

    conn.commit()
    cur.close()
    conn.close()
    print("Tabele kreirane.")


if __name__ == "__main__":
    import sys

    try:
        conn = get_connection()
        print("Konekcija uspešna!")
        conn.close()
        init_db()
    except Exception as e:
        # Dockerfile pokrece "python db.py && gunicorn", pa izlaz != 0
        # sprecava da se server digne sa neispravnom bazom.
        print(f"Greška: {e}")
        sys.exit(1)