"""LAYA WORKER ADAPTER — evidence narrowing, one bounded request at a time.

Runs under the specialist runtime (see workers/manifest.json), never inside the
LAIN process. Weights come from the local model store (HF_HOME points there);
nothing here downloads unless LAIN_WORKER_ALLOW_DOWNLOAD=1.

Protocol: one JSON object per line on stdin, one per line on stdout.

  {"id": 1, "op": "ping"}
  -> {"id": 1, "ok": true, "model": "convaiinnovations/laya", "ms": 0}

  {"id": 2, "op": "rank", "query": "network mode dropdown",
   "items": [{"id": "n1", "text": "ComboBox 'Network mode' #NetworkMode"}, ...],
   "k": 8}
  -> {"id": 2, "ok": true, "ranked": [{"id": "n1", "p": 0.91, "cos": 0.62}, ...],
      "abstain": false, "ms": 143}

  {"id": 4, "op": "embed", "texts": ["webapp/src/api.ts — search fetch", ...]}
  -> {"id": 4, "ok": true, "dim": 1024, "n": 1, "vectors": "<base64 little-endian float32, unit rows>",
      "model": "...", "schema": "laya-embed-v1|max256|unit", "usage": {...}}
     THE PROJECT-INDEX PRIMITIVE (src/layaindex.js): the worker host embeds a
     project once, in the background, persists the vectors in LAIN's
     machine-local cache, and at task time asks for the QUERY vector only.

  {"id": 3, "op": "clear"}
  -> {"id": 3, "ok": true, "dropped": 451}
     drops the embedding memo (the model stays loaded) — so one benchmark arm
     never inherits the embeddings another arm paid for.

RANK = Laya's own coarse-to-fine path: the checkpoint's encoder embeds the query
and every item (cosine shortlist), then ONE `choice` decision over the top
labels gives calibrated probabilities. One input, one inference, one result.
The worker never calls another worker, never calls itself, never writes files,
and holds no authority: it returns numbers.
"""

import json
import os
import sys
import time

os.environ.setdefault("USE_TF", "0")
if os.environ.get("LAIN_WORKER_ALLOW_DOWNLOAD") != "1":
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

MODEL = os.environ.get("LAIN_LAYA_MODEL", "convaiinnovations/laya")
MAX_CHOICE = 12     # a choice head shares one token budget across labels
MAX_ITEMS = 400
ABSTAIN_BELOW = 0.35
EMBED_MAX = 256
# THE EMBEDDING IDENTITY. Stored project vectors are reused only under the exact
# same string; change it whenever the vectors this adapter produces change.
SCHEMA = f"laya-embed-v1|max{EMBED_MAX}|unit"

_agent = None
_embed = None
_vecs = {}          # text -> unit vector; a project's items repeat across requests
MAX_CACHE = 20000


def load():
    global _agent, _embed
    if _agent is None:
        import laya
        from laya import embed_fn_from_agent
        _agent = laya.load(MODEL)
        _embed = embed_fn_from_agent(_agent, max_length=EMBED_MAX)
    return _agent


def rank(req):
    import numpy as np
    agent = load()
    query = str(req.get("query") or "")[:600]
    items = [i for i in (req.get("items") or []) if i and i.get("id") is not None][:MAX_ITEMS]
    k = max(1, min(int(req.get("k") or 8), 40))
    if not query or not items:
        return {"ranked": [], "abstain": True, "why": "nothing to rank"}
    texts = [str(i.get("text") or "")[:300] for i in items]
    missing = [t for t in dict.fromkeys([query] + texts) if t not in _vecs]
    # TOKENS, COUNTED WITH THE MODEL'S OWN TOKENIZER (capped at the encoder's
    # max_length, as the encoder sees them): `tokens_in` is what this call
    # actually ran through the model; `tokens_equiv` is the whole request.
    ntok = lambda t: min(len(_agent.tok(t, add_special_tokens=True)["input_ids"]), EMBED_MAX)
    usage = {"embedded": len(missing), "tokens_in": sum(ntok(t) for t in missing),
             "tokens_equiv": sum(ntok(t) for t in [query] + texts), "input_chars": len(query) + sum(len(t) for t in texts)}
    if missing:
        if len(_vecs) + len(missing) > MAX_CACHE:
            _vecs.clear()
        for t, v in zip(missing, _embed(missing)):
            _vecs[t] = v / (np.linalg.norm(v) + 1e-9)
    q = _vecs[query]
    d = np.stack([_vecs[t] for t in texts])
    cos = d @ q
    order = list(np.argsort(-cos))
    if req.get("mode") == "cos":
        # EMBEDDING ONLY: the checkpoint's encoder, no decision head.
        ranked = [{"id": items[i]["id"], "p": None, "cos": round(float(cos[i]), 4)} for i in order[:k]]
        margin = float(cos[order[0]] - cos[order[1]]) if len(order) > 1 else 1.0
        usage["output_chars"] = len(json.dumps(ranked))
        return {"ranked": ranked, "abstain": False, "margin": round(margin, 4), "n": len(items), "usage": usage}
    top = order[:max(2, min(int(req.get("shortlist") or MAX_CHOICE), 48))]
    criteria = {f"c{n}": texts[i][:160] for n, i in enumerate(top)}
    usage["tokens_in"] += sum(ntok(c) for c in criteria.values()) + ntok(query)
    out = agent.predict(
        {"request": query},
        {"target": {"type": "choice", "instructions": "Which item is the one the request is about?", "criteria": criteria}},
    )
    probs = (out.get("answers", {}).get("target", {}) or {}).get("probabilities", {}) or {}
    ranked = []
    for n, i in enumerate(top):
        ranked.append({"id": items[i]["id"], "p": round(float(probs.get(f"c{n}", 0.0)), 4), "cos": round(float(cos[i]), 4)})
    ranked.sort(key=lambda r: (-r["p"], -r["cos"]))
    best = ranked[0]["p"] if ranked else 0.0
    usage["output_chars"] = len(json.dumps(ranked[:k]))
    return {"ranked": ranked[:k], "abstain": best < ABSTAIN_BELOW, "n": len(items), "usage": usage}


def embed(req):
    import base64
    import numpy as np
    load()
    texts = [str(t or "")[:300] for t in (req.get("texts") or [])][:256]
    if not texts:
        return {"dim": 0, "n": 0, "vectors": "", "model": MODEL, "schema": SCHEMA}
    ntok = lambda t: min(len(_agent.tok(t, add_special_tokens=True)["input_ids"]), EMBED_MAX)
    rows = []
    for v in _embed(texts):
        v = np.asarray(v, dtype=np.float32)
        rows.append(v / (np.linalg.norm(v) + 1e-9))
    arr = np.stack(rows).astype("<f4")
    return {"dim": int(arr.shape[1]), "n": len(texts), "vectors": base64.b64encode(arr.tobytes()).decode("ascii"),
            "model": MODEL, "schema": SCHEMA,
            "usage": {"embedded": len(texts), "tokens_in": sum(ntok(t) for t in texts), "input_chars": sum(len(t) for t in texts)}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        t0 = time.time()
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"bad json: {e}"}), flush=True)
            continue
        rid = req.get("id")
        try:
            if req.get("op") == "ping":
                load()
                res = {"model": MODEL, "schema": SCHEMA}
            elif req.get("op") == "embed":
                res = embed(req)
            elif req.get("op") == "rank":
                res = rank(req)
            elif req.get("op") == "clear":
                res = {"dropped": len(_vecs)}
                _vecs.clear()
            else:
                res = {"error": f"unknown op {req.get('op')!r}"}
            res.update({"id": rid, "ok": "error" not in res, "ms": int((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001
            res = {"id": rid, "ok": False, "error": str(e)[:300], "ms": int((time.time() - t0) * 1000)}
        print(json.dumps(res), flush=True)


if __name__ == "__main__":
    main()
