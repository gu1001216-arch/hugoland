"""Banco de dados, cache em memória e cálculo das sequências do Hugoland."""
import json
import os
import re
import threading
import time
import unicodedata
import uuid

import numpy as np
import psycopg
from psycopg.types.json import Jsonb

DATABASE_URL = os.environ.get("DATABASE_URL", "")

DEFAULT_SEGMENTS = [
    {"id": "s1", "label": "1", "color": "#F5C542", "aliases": "ABW_1"},
    {"id": "s2", "label": "2", "color": "#5AA9F0", "aliases": "ABW_2"},
    {"id": "s5", "label": "5", "color": "#D07BE8", "aliases": "ABW_5"},
    {"id": "s10", "label": "10", "color": "#35D69B", "aliases": "ABW_10"},
    {"id": "b2w", "label": "2 Wonder Spins", "color": "#FF9F43", "aliases": "ABW_WONDERSPINS_2"},
    {"id": "b5w", "label": "5 Wonder Spins", "color": "#FF6B81", "aliases": "ABW_WONDERSPINS_5"},
    {"id": "bwolter", "label": "Wolter Spins", "color": "#9B7BFF", "aliases": "ABW_WOLTERSPINS"},
    {"id": "bdice", "label": "Magic Dice", "color": "#4FD1C5", "aliases": "ABW_MAGIC_DICE"},
    {"id": "bcard", "label": "Card Soldiers", "color": "#C9C3DE", "aliases": "ABW_CARD_SOLDIERS"},
]
DEFAULT_MONITORS = [
    {"name": "1 e 2", "values": ["s1", "s2"], "mode": "any", "alert": 0},
    {"name": "10", "values": ["s10"], "mode": "any", "alert": 25},
    {"name": "Bônus", "values": ["b2w", "b5w", "bwolter", "bdice"], "mode": "any", "alert": 30},
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS rounds (
    id          TEXT PRIMARY KEY,
    t           TIMESTAMPTZ NOT NULL,
    code        TEXT NOT NULL,
    src         TEXT NOT NULL DEFAULT 'api',
    seq         BIGSERIAL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rounds_t_idx ON rounds (t);
CREATE TABLE IF NOT EXISTS monitors (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    vals  JSONB NOT NULL,
    mode  TEXT NOT NULL DEFAULT 'any',
    alert INTEGER NOT NULL DEFAULT 0,
    pos   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);
"""


def connect():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL não configurada")
    return psycopg.connect(DATABASE_URL, autocommit=True)


def norm(s):
    s = unicodedata.normalize("NFD", str(s).lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "", s)


class Store:
    """Mantém as rodadas em memória (ordenadas por horário) e calcula as sequências."""

    def __init__(self):
        self.lock = threading.RLock()
        self.changed = threading.Condition()
        self.event_id = 0
        self.times = np.zeros(0, dtype=np.float64)   # segundos epoch
        self.codes = np.zeros(0, dtype=np.int32)     # índice em self.code_list
        self.srcs = np.zeros(0, dtype=np.int8)       # 0 = api, 1 = manual
        self.code_list = []
        self.code_idx = {}
        self.version = 0
        self.last_seq = 0
        self._cache = {}
        self.segments = []
        self.monitors = []

    # ---------- inicialização ----------
    def init(self):
        with connect() as c:
            c.execute(SCHEMA)
            row = c.execute("SELECT value FROM settings WHERE key='segments'").fetchone()
            if not row:
                c.execute("INSERT INTO settings(key, value) VALUES ('segments', %s)", (Jsonb(DEFAULT_SEGMENTS),))
            if not c.execute("SELECT 1 FROM settings WHERE key='seeded'").fetchone():
                for i, m in enumerate(DEFAULT_MONITORS):
                    c.execute("INSERT INTO monitors(id,name,vals,mode,alert,pos) VALUES (%s,%s,%s,%s,%s,%s)",
                              (uuid.uuid4().hex[:10], m["name"], Jsonb(m["values"]), m["mode"], m["alert"], i))
                c.execute("INSERT INTO settings(key, value) VALUES ('seeded', 'true')")
        self.reload_config()
        self.full_reload()

    def reload_config(self):
        with connect() as c:
            self.segments = c.execute("SELECT value FROM settings WHERE key='segments'").fetchone()[0]
            rows = c.execute("SELECT id,name,vals,mode,alert FROM monitors ORDER BY pos, name").fetchall()
        self.monitors = [{"id": r[0], "name": r[1], "values": r[2], "mode": r[3], "alert": r[4]} for r in rows]
        self._cache.clear()
        self.notify()

    def _cidx(self, code):
        i = self.code_idx.get(code)
        if i is None:
            i = len(self.code_list)
            self.code_list.append(code)
            self.code_idx[code] = i
        return i

    def full_reload(self):
        with connect() as c:
            rows = c.execute("SELECT extract(epoch FROM t), code, src, seq FROM rounds ORDER BY t, id").fetchall()
        with self.lock:
            self.times = np.array([float(r[0]) for r in rows], dtype=np.float64)
            self.codes = np.array([self._cidx(r[1]) for r in rows], dtype=np.int32)
            self.srcs = np.array([1 if r[2] == "manual" else 0 for r in rows], dtype=np.int8)
            self.last_seq = max((r[3] for r in rows), default=0)
            self.version += 1
            self._cache.clear()
        self.ensure_segments()
        self.notify()

    def sync(self):
        """Carrega rodadas gravadas desde a última leitura."""
        with connect() as c:
            rows = c.execute("SELECT extract(epoch FROM t), code, src, seq FROM rounds WHERE seq > %s ORDER BY t, id",
                             (self.last_seq,)).fetchall()
        if not rows:
            return 0
        with self.lock:
            if len(self.times) and float(rows[0][0]) < self.times[-1]:
                older = True  # rodada mais antiga que a última (recuperação de lacuna)
            else:
                older = False
                self.times = np.concatenate([self.times, np.array([float(r[0]) for r in rows], dtype=np.float64)])
                self.codes = np.concatenate([self.codes, np.array([self._cidx(r[1]) for r in rows], dtype=np.int32)])
                self.srcs = np.concatenate([self.srcs, np.array([1 if r[2] == "manual" else 0 for r in rows], dtype=np.int8)])
                self.last_seq = max(self.last_seq, max(r[3] for r in rows))
                self.version += 1
                self._cache.clear()
        if older:
            self.full_reload()
        else:
            self.ensure_segments()
            self.notify()
        return len(rows)

    # ---------- resultados (botões) ----------
    def notify(self):
        with self.changed:
            self.event_id += 1
            self.changed.notify_all()

    def wait_change(self, last_id, timeout):
        with self.changed:
            self.changed.wait_for(lambda: self.event_id != last_id, timeout=timeout)
            return self.event_id

    def seg_codes(self, seg):
        keys = {norm(seg["label"])} | {norm(a) for a in str(seg.get("aliases", "")).split(",") if a.strip()}
        return {i for i, code in enumerate(self.code_list) if norm(code) in keys}

    def seg_for_code(self, code):
        k = norm(code)
        for s in self.segments:
            if k == norm(s["label"]) or any(a.strip() and k == norm(a) for a in str(s.get("aliases", "")).split(",")):
                return s
        return None

    def ensure_segments(self):
        """Cria botão para qualquer código novo que a fonte passar a enviar."""
        missing = [c for c in self.code_list if self.seg_for_code(c) is None]
        if not missing:
            return
        segs = list(self.segments)
        for code in missing:
            segs.append({"id": "c" + uuid.uuid4().hex[:8], "label": re.sub(r"^ABW_", "", code)[:20],
                         "color": "#8FA8FF", "aliases": code})
        self.save_segments(segs)

    def save_segments(self, segs):
        with connect() as c:
            c.execute("UPDATE settings SET value=%s WHERE key='segments'", (Jsonb(segs),))
        self.segments = segs
        self._cache.clear()
        self.notify()

    def code_for_seg(self, seg_id):
        s = next((x for x in self.segments if x["id"] == seg_id), None)
        if not s:
            return None
        first = next((a.strip() for a in str(s.get("aliases", "")).split(",") if a.strip()), "")
        return first or "SEG_" + s["id"]

    # ---------- cálculo ----------
    def hits(self, m):
        key = (self.version, m["mode"], tuple(m["values"]), tuple(self.segments_sig()))
        if key in self._cache:
            return self._cache[key]
        segmap = {s["id"]: s for s in self.segments}
        sets = [np.array(sorted(self.seg_codes(segmap[v])), dtype=np.int32) for v in m["values"] if v in segmap]
        codes, n = self.codes, len(self.codes)
        if not sets or n == 0:
            h = np.zeros(0, dtype=np.int64)
        elif m["mode"] == "seq":
            k = len(sets)
            if n < k:
                h = np.zeros(0, dtype=np.int64)
            else:
                mask = np.ones(n - k + 1, dtype=bool)
                for j, st in enumerate(sets):
                    mask &= np.isin(codes[j:n - k + 1 + j], st)
                h = np.flatnonzero(mask) + (k - 1)
        else:
            allc = np.unique(np.concatenate(sets))
            h = np.flatnonzero(np.isin(codes, allc))
        self._cache[key] = h
        return h

    def segments_sig(self):
        return [(s["id"], s["label"], s.get("aliases", "")) for s in self.segments]

    def stats(self, m):
        with self.lock:
            n = len(self.codes)
            h = self.hits(m)
            times = self.times
        hits = len(h)
        current = n if hits == 0 else int(n - 1 - h[-1])
        gaps = np.diff(h) - 1 if hits > 1 else np.zeros(0)
        record = max([current] + ([int(h[0])] if hits else []) + ([int(gaps.max())] if len(gaps) else []))
        return {
            "n": n, "current": current, "record": record, "hits": hits,
            "avg": float(gaps.mean()) if len(gaps) else None,
            "lastT": float(times[h[-1]]) * 1000 if hits else None,
            "firstT": float(times[0]) * 1000 if n else None,
        }

    def running(self, m, idx):
        """Sequência logo após cada rodada de índice em idx (0 = saiu)."""
        h = self.hits(m)
        idx = np.asarray(idx, dtype=np.int64)
        p = np.searchsorted(h, idx, side="right") - 1
        return np.where(p >= 0, idx - h[np.clip(p, 0, None)] if len(h) else idx + 1, idx + 1)

    def summary(self, last=40):
        with self.lock:
            n = len(self.codes)
            lastc = [(float(self.times[i]) * 1000, self.code_list[self.codes[i]], int(self.srcs[i])) for i in range(max(0, n - last), n)][::-1]
            counts = np.bincount(self.codes, minlength=len(self.code_list)) if n else np.zeros(len(self.code_list), dtype=int)
            dist = []
            for s in self.segments:
                cs = self.seg_codes(s)
                cnt = int(sum(counts[i] for i in cs)) if cs else 0
                since = None
                if cs and n:
                    w = np.flatnonzero(np.isin(self.codes, np.array(sorted(cs), dtype=np.int32)))
                    since = int(n - 1 - w[-1]) if len(w) else None
                dist.append({"seg": s["id"], "count": cnt, "since": since})
        rounds = []
        for t, code, src in lastc:
            s = self.seg_for_code(code)
            rounds.append({"t": t, "seg": s["id"] if s else None, "code": code, "manual": bool(src)})
        mons = [{**m, "st": self.stats(m)} for m in self.monitors]
        return {"n": n, "segments": self.segments, "monitors": mons, "last": rounds, "dist": dist}

    def history(self, offset, limit):
        with self.lock:
            n = len(self.codes)
            hi = n - offset
            lo = max(0, hi - limit)
            idx = np.arange(hi - 1, lo - 1, -1)
            seqs = [self.running(m, idx).tolist() for m in self.monitors] if len(idx) else []
        with connect() as c:
            rows = c.execute("SELECT id, extract(epoch FROM t), code, src FROM rounds ORDER BY t DESC, id DESC OFFSET %s LIMIT %s",
                             (offset, limit)).fetchall()
        out = []
        for k, r in enumerate(rows):
            s = self.seg_for_code(r[2])
            out.append({"n": int(idx[k]) + 1 if k < len(idx) else None, "id": r[0], "t": float(r[1]) * 1000,
                        "seg": s["id"] if s else None, "code": r[2], "manual": r[3] == "manual",
                        "seqs": [sq[k] if k < len(sq) else None for sq in seqs]})
        return {"total": n, "rows": out, "monitors": [{"id": m["id"], "name": m["name"]} for m in self.monitors]}

    # ---------- escrita ----------
    def insert_rounds(self, items, src="api"):
        """items: [(id, datetime|epoch_s, code)]. Retorna quantas eram novas."""
        if not items:
            return 0
        new = 0
        with connect() as c:
            with c.cursor() as cur:
                for rid, t, code in items:
                    cur.execute("INSERT INTO rounds(id, t, code, src) VALUES (%s, to_timestamp(%s), %s, %s) ON CONFLICT (id) DO NOTHING",
                                (rid, t, code, src))
                    new += cur.rowcount
        if new:
            self.sync()
        return new

    def delete_last_manual(self):
        with connect() as c:
            r = c.execute("DELETE FROM rounds WHERE id = (SELECT id FROM rounds WHERE src='manual' ORDER BY created_at DESC LIMIT 1) RETURNING id").fetchone()
        if r:
            self.full_reload()
        return bool(r)

    def delete_round(self, rid):
        with connect() as c:
            r = c.execute("DELETE FROM rounds WHERE id=%s RETURNING id", (rid,)).fetchone()
        if r:
            self.full_reload()
        return bool(r)

    def clear_rounds(self):
        with connect() as c:
            c.execute("DELETE FROM rounds")
        self.full_reload()

    def upsert_monitor(self, m):
        with connect() as c:
            if m.get("id") and c.execute("SELECT 1 FROM monitors WHERE id=%s", (m["id"],)).fetchone():
                c.execute("UPDATE monitors SET name=%s, vals=%s, mode=%s, alert=%s WHERE id=%s",
                          (m["name"], Jsonb(m["values"]), m["mode"], m["alert"], m["id"]))
            else:
                pos = c.execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM monitors").fetchone()[0]
                m["id"] = uuid.uuid4().hex[:10]
                c.execute("INSERT INTO monitors(id,name,vals,mode,alert,pos) VALUES (%s,%s,%s,%s,%s,%s)",
                          (m["id"], m["name"], Jsonb(m["values"]), m["mode"], m["alert"], pos))
        self.reload_config()
        return m["id"]

    def delete_monitor(self, mid):
        with connect() as c:
            c.execute("DELETE FROM monitors WHERE id=%s", (mid,))
        self.reload_config()

    def replace_monitors(self, monitors):
        with connect() as c:
            c.execute("DELETE FROM monitors")
            for i, m in enumerate(monitors):
                c.execute("INSERT INTO monitors(id,name,vals,mode,alert,pos) VALUES (%s,%s,%s,%s,%s,%s)",
                          (m.get("id") or uuid.uuid4().hex[:10], m["name"], Jsonb(m["values"]),
                           "seq" if m.get("mode") == "seq" else "any", int(m.get("alert") or 0), i))
        self.reload_config()

    def iter_rounds(self, since_epoch=None):
        with connect() as c:
            q = "SELECT id, extract(epoch FROM t), code, src FROM rounds"
            args = ()
            if since_epoch:
                q += " WHERE t >= to_timestamp(%s)"
                args = (since_epoch,)
            q += " ORDER BY t, id"
            with c.cursor() as cur:
                cur.execute(q, args)
                for r in cur:
                    yield r


store = Store()
