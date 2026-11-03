#!/usr/bin/env python3
"""fetch URL DESTINAZIONE SHA256 — scarica un file per l'immagine Docker e ne verifica l'impronta.

Si usa al posto di `ADD <url>`: riusando la cache, BuildKit ricontrolla gli URL degli ADD e da
GitHub Actions raw.githubusercontent.com a volte risponde 501, facendo fallire la build. Con un RUN
il passo resta in cache finché non cambia il comando; in caso di errore di rete si riprova.
"""
import hashlib
import os
import sys
import time
import urllib.request

url, dest, want = sys.argv[1:4]
for attempt in range(1, 7):
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read()
        break
    except OSError as e:
        print(f"{url}: tentativo {attempt} fallito ({e})", file=sys.stderr)
        if attempt == 6:
            raise
        time.sleep(5 * attempt)
got = hashlib.sha256(data).hexdigest()
if got != want:
    sys.exit(f"{url}: impronta {got}, attesa {want}")
os.makedirs(os.path.dirname(dest), exist_ok=True)
with open(dest, "wb") as f:
    f.write(data)
os.chmod(dest, 0o644)
