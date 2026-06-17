#!/usr/bin/env python3
"""
viewer_server.py — serves viewer.html plus a tiny JSON API over any index,
for the 3D synapse navigator.

    vindex serve <name>                 # -> http://localhost:7341
    PORT=8080 python viewer_server.py   # standalone, uses $VINDEX_DEFAULT

Endpoints:
    GET /                      the viewer
    GET /api/status            live index status
    GET /api/graph?n=400&k=3   sampled real nodes + knn synapse links
                               (positions = PCA of the actual embeddings)
    GET /api/search?q=...      reranked search; hits carry PCA coords + the
                               nearest sampled neighbours so they splice in
"""

import json
import os
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np  # noqa: E402

import vector_index as vi  # noqa: E402
import zvec  # noqa: E402

PORT = int(os.environ.get("PORT", "7341"))
HTML_PATH = Path(__file__).resolve().parent.parent / "assets" / "viewer.html"

_INDEX: vi.Index | None = None
_state_lock = threading.Lock()
_graph = {"id_to_idx": {}, "vecs": None, "mean": None, "comps": None, "scale": 1.0}


def _sample_docs(n=400, probes=8):
    """Spread sampling across semantic space with random unit-vector probes."""
    coll = _INDEX.open()
    per = max(8, n // probes)
    seen = {}
    rng = np.random.default_rng()
    for _ in range(probes):
        v = rng.normal(size=_INDEX.cfg.embed_dim).astype(np.float32)
        v /= np.linalg.norm(v)
        hits = coll.query(
            vectors=zvec.VectorQuery("embedding", vector=v.tolist()),
            topk=per,
            include_vector=True,
            output_fields=vi._COLL_FIELDS,
        )
        for h in hits:
            seen.setdefault(h.id, h)
        if len(seen) >= n:
            break
    return list(seen.values())[:n]


def build_graph(n=400, k=3):
    docs = _sample_docs(n)
    vecs = np.array([d.vector("embedding") for d in docs], dtype=np.float32)

    mean = vecs.mean(axis=0)
    centered = vecs - mean
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    comps = vt[:3]
    pos = centered @ comps.T
    scale = 6.0 / max(1e-6, float(np.abs(pos).max()))
    pos *= scale

    sims = vecs @ vecs.T
    np.fill_diagonal(sims, -2.0)
    nn = np.argpartition(-sims, kth=min(k, len(docs) - 1), axis=1)[:, :k]
    links, seen = [], set()
    for i in range(len(docs)):
        for j in nn[i]:
            j = int(j)
            key = (min(i, j), max(i, j))
            if key not in seen:
                seen.add(key)
                links.append([key[0], key[1], round(float(sims[i, j]), 4)])

    nodes = []
    for i, d in enumerate(docs):
        nodes.append(
            {
                "id": d.id,
                "title": d.field("title") or d.field("source") or "",
                "source": d.field("source") or "",
                "url": d.field("url") or None,
                "chunk": d.field("chunk") or 0,
                "p": [round(float(x), 4) for x in pos[i]],
            }
        )

    with _state_lock:
        _graph["id_to_idx"] = {d.id: i for i, d in enumerate(docs)}
        _graph["vecs"] = vecs
        _graph["mean"] = mean
        _graph["comps"] = comps
        _graph["scale"] = scale
    return {"nodes": nodes, "links": links, "k": k}


def _project(vec):
    with _state_lock:
        if _graph["mean"] is None:
            return [0.0, 0.0, 0.0]
        p = (np.asarray(vec, dtype=np.float32) - _graph["mean"]) @ _graph["comps"].T
        p = p * _graph["scale"]
    return [round(float(x), 4) for x in p]


def search(q):
    res = _INDEX.search(q, topk=8)
    with _state_lock:
        id_to_idx = dict(_graph["id_to_idx"])
        gvecs = _graph["vecs"]
    out = []
    for it in res["results"]:
        vec = it.pop("_vec", None)
        entry = {k: v for k, v in it.items()}
        if it["id"] in id_to_idx:
            entry["graph_index"] = id_to_idx[it["id"]]
        elif vec is not None:
            entry["p"] = _project(vec)
            if gvecs is not None:
                sims = gvecs @ np.asarray(vec, dtype=np.float32)
                order = np.argsort(-sims)[:3]
                entry["attach"] = [[int(i), round(float(sims[i]), 4)] for i in order]
        out.append(entry)
    return {"query": q, "results": out}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path in ("/", "/index.html"):
                body = HTML_PATH.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif parsed.path == "/api/status":
                self._json(_INDEX.status())
            elif parsed.path == "/api/graph":
                n = min(1200, max(50, int(qs.get("n", ["400"])[0])))
                k = min(6, max(1, int(qs.get("k", ["3"])[0])))
                self._json(build_graph(n=n, k=k))
            elif parsed.path == "/api/search":
                q = (qs.get("q", [""])[0]).strip()
                self._json(search(q) if q else {"error": "empty query"}, 200 if q else 400)
            else:
                self._json({"error": "not found"}, 404)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._json({"error": str(e)}, 500)
            except Exception:
                pass


def main(index_name: str | None = None):
    global _INDEX
    name = index_name or vi.resolve_project_name()
    _INDEX = vi.Index.load(name)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"synapse viewer ({_INDEX.cfg.name})  ->  http://localhost:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
