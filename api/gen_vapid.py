"""
Generiše VAPID par ključeva za Web Push notifikacije.

Pokretanje:
    python gen_vapid.py

Ispiše VAPID_PUBLIC_KEY i VAPID_PRIVATE_KEY koje treba prekopirati u .env.
Public ključ ide i u browser (applicationServerKey), private ostaje na serveru.
"""
import base64
from py_vapid import Vapid01
from cryptography.hazmat.primitives import serialization


def main():
    v = Vapid01()
    v.generate_keys()

    # Private ključ kao sirov 32-bajtni skalar -> urlsafe base64 (format koji pywebpush očekuje)
    priv_raw = v.private_key.private_numbers().private_value.to_bytes(32, "big")
    priv_b64 = base64.urlsafe_b64encode(priv_raw).rstrip(b"=").decode()

    # Public ključ kao sirova nekompresovana tačka -> urlsafe base64 (applicationServerKey)
    pub_raw = v.public_key.public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    pub_b64 = base64.urlsafe_b64encode(pub_raw).rstrip(b"=").decode()

    print("# Prekopiraj u .env:")
    print("VAPID_PUBLIC_KEY=" + pub_b64)
    print("VAPID_PRIVATE_KEY=" + priv_b64)
    print("VAPID_CLAIM_EMAIL=mailto:tvoj_email@example.com")


if __name__ == "__main__":
    main()
