"""Coletor contínuo: busca os giros na fonte e grava no banco."""
import logging
import os
import re
import threading
import time
from datetime import datetime

import requests

from store import connect, store

log = logging.getLogger("coletor")

ABW_URL = ("https://api-cs.casino.org/svc-evolution-game-events/api/abwonderland?page=0&size=24"
           "&sort=data.settledAt,desc&duration=6&wheelResults=ABW_WONDERSPINS_5,ABW_WOLTERSPINS,"
           "ABW_WONDERSPINS_2,ABW_MAGIC_DICE,ABW_10,ABW_5,ABW_2,ABW_1,ABW_CARD_SOLDIERS")
UPSTREAM_URL = os.environ.get("UPSTREAM_URL", "").strip() or ABW_URL
FAST = max(1.0, float(os.environ.get("POLL_FAST_SECONDS", "2")))     # perto do fim do giro
SLOW = max(FAST, float(os.environ.get("POLL_SLOW_SECONDS", "6")))    # logo depois de um giro
ROUND_SECONDS = float(os.environ.get("ROUND_SECONDS", "40"))         # duração típica de um giro
INTERVAL = SLOW
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    "Accept": "application/json",
    "Origin": "https://www.casino.org",
    "Referer": "https://www.casino.org/",
}

status = {"running": False, "ok": None, "error": None, "last_ok": None, "last_new": None,
          "last_round": None, "fails": 0, "total_new": 0, "started": None, "url": UPSTREAM_URL,
          "delay_last": None, "delay_avg": None, "poll_fast": FAST, "poll_slow": SLOW}
_delays = []


def page_url(page, size):
    u = re.sub(r"([?&]page=)\d+", rf"\g<1>{page}", UPSTREAM_URL)
    return re.sub(r"([?&]size=)\d+", rf"\g<1>{size}", u)


def find_code(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            r = find_code(v, f"{path}.{k}")
            if r:
                return r
    elif isinstance(obj, str) and re.fullmatch(r"ABW_[A-Z0-9_]+", obj):
        return obj
    return None


def parse(data):
    items = data if isinstance(data, list) else (data.get("content") or data.get("data") or data.get("items") or [])
    out = []
    for it in items:
        d = it.get("data") or {}
        code = ((d.get("result") or {}).get("wheelSector")) or find_code(it)
        ts = d.get("settledAt") or d.get("startedAt")
        rid = it.get("id") or d.get("id")
        if not (code and ts and rid):
            continue
        t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        out.append((str(rid), t, str(code)))
    return out


def fetch(page=0, size=24):
    r = requests.get(page_url(page, size), headers=HEADERS, timeout=15)
    if r.status_code != 200:
        hint = " (possível bloqueio da Cloudflare ao servidor)" if r.status_code in (403, 429, 503) else ""
        raise RuntimeError(f"a fonte respondeu HTTP {r.status_code}{hint}")
    try:
        data = r.json()
    except ValueError:
        raise RuntimeError("a fonte não devolveu JSON (possível página de verificação da Cloudflare)")
    return parse(data)


def backfill():
    """Busca páginas anteriores até encontrar giros já gravados (a fonte guarda ~6 horas)."""
    total = 0
    for page in range(0, 15):
        items = fetch(page, 100)
        if not items:
            break
        new = store.insert_rounds(items)
        total += new
        if new < len(items):
            break
        time.sleep(1)
    return total


def mark_ok(new, live=False):
    now = time.time()
    status.update(ok=True, error=None, last_ok=now, fails=0)
    if len(store.times):
        status["last_round"] = float(store.times[-1])
    if new:
        status["last_new"] = now
        status["total_new"] += new
        if live and status["last_round"]:
            # atraso entre o fim do giro (horário da fonte) e a gravação aqui
            d = max(0.0, now - status["last_round"])
            if d < 600:
                _delays.append(d)
                del _delays[:-50]
                status["delay_last"] = round(d, 1)
                status["delay_avg"] = round(sum(_delays) / len(_delays), 1)


def next_wait():
    """Consulta rápido quando o próximo giro está para terminar; devagar logo depois de um giro."""
    last = status.get("last_round")
    if not last:
        return FAST
    since = time.time() - last
    return SLOW if since < ROUND_SECONDS - SLOW else FAST


def loop():
    # trava no banco: garante um só coletor, mesmo com mais de uma instância
    lock_conn = None
    while True:
        try:
            if lock_conn is None or lock_conn.closed:
                lock_conn = connect()
            if lock_conn.execute("SELECT pg_try_advisory_lock(424242)").fetchone()[0]:
                break
            status["error"] = "aguardando: outra instância está coletando (normal durante atualização)"
            log.info("outra instância está coletando; tentando de novo em 5s")
        except Exception as e:  # noqa: BLE001
            status["error"] = f"sem acesso ao banco: {e}"
            lock_conn = None
        time.sleep(5)
    status.update(running=True, started=time.time(), error=None)
    log.info("coletor ativo")
    need_backfill = True
    while True:
        try:
            if need_backfill:
                new = backfill()
                need_backfill = False
                log.info("recuperação: %s giros novos", new)
                mark_ok(new)
            else:
                new = store.insert_rounds(fetch(0, 24))
                mark_ok(new, live=True)
            wait = next_wait()
        except Exception as e:  # noqa: BLE001
            status.update(ok=False, error=str(e))
            status["fails"] += 1
            if status["fails"] >= 3:
                need_backfill = True  # quando voltar, recupera o que perdeu
            wait = min(120, SLOW * (2 ** min(status["fails"], 4)))
            log.warning("falha na coleta (%s): %s", status["fails"], e)
        time.sleep(wait)


def start():
    if os.environ.get("COLLECTOR", "on").lower() in ("off", "0", "false"):
        status["error"] = "coletor desligado (COLLECTOR=off)"
        return
    threading.Thread(target=loop, name="coletor", daemon=True).start()
