import psycopg2
import psycopg2.extras
import os
from dotenv import load_dotenv

load_dotenv()  # čita .env fajl i stavlja vrednosti u os.environ

def get_connection():
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

    conn.commit()
    cur.close()
    conn.close()
    print("Tabele kreirane.")


if __name__ == "__main__":
    try:
        conn = get_connection()
        print("Konekcija uspešna!")
        conn.close()
        init_db()
    except Exception as e:
        print(f"Greška: {e}")