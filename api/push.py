"""
Web Push (VAPID) slanje notifikacija svim pretplaćenim browserima.

VAPID ključevi se čitaju iz .env (vidi gen_vapid.py za generisanje).
Pretplate se čuvaju u tabeli push_subscriptions.
"""
import os
import json

from pywebpush import webpush, WebPushException

VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY")
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY")
VAPID_CLAIM_EMAIL = os.getenv("VAPID_CLAIM_EMAIL", "mailto:admin@example.com")


def is_configured():
    """True ako su VAPID ključevi postavljeni (inače push tiho preskačemo)."""
    return bool(VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)


def get_subscriptions(conn):
    cur = conn.cursor()
    cur.execute("SELECT id, endpoint, p256dh, auth FROM push_subscriptions")
    rows = cur.fetchall()
    cur.close()
    return rows


def add_subscription(conn, endpoint, p256dh, auth):
    cur = conn.cursor()
    # ON CONFLICT: isti browser koji se ponovo pretplati ne pravi duplikat
    cur.execute(
        """
        INSERT INTO push_subscriptions (endpoint, p256dh, auth)
        VALUES (%s, %s, %s)
        ON CONFLICT (endpoint) DO UPDATE
            SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
        """,
        (endpoint, p256dh, auth),
    )
    conn.commit()
    cur.close()


def remove_subscription(conn, endpoint):
    cur = conn.cursor()
    cur.execute("DELETE FROM push_subscriptions WHERE endpoint = %s", (endpoint,))
    conn.commit()
    cur.close()


def _delete_by_id(conn, sub_id):
    cur = conn.cursor()
    cur.execute("DELETE FROM push_subscriptions WHERE id = %s", (sub_id,))
    conn.commit()
    cur.close()


def send_to_all(conn, payload):
    """Pošalji `payload` (dict) kao push svim pretplatama.

    Vraća broj uspešno poslatih. Mrtve pretplate (410/404) automatski briše.
    """
    if not is_configured():
        return 0

    data = json.dumps(payload)
    sent = 0

    for sub_id, endpoint, p256dh, auth in get_subscriptions(conn):
        subscription_info = {
            "endpoint": endpoint,
            "keys": {"p256dh": p256dh, "auth": auth},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=data,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_CLAIM_EMAIL},
            )
            sent += 1
        except WebPushException as e:
            # 404/410 = pretplata više ne postoji (korisnik odjavio / deinstalirao)
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                _delete_by_id(conn, sub_id)
            else:
                print(f"[push] Greška za {endpoint[:40]}...: {e}")

    return sent
