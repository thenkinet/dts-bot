"""Signing oracle: computes Paradex typed-data hashes and signatures with the
Starknet libraries used in the Python stack, so the JS implementation can be
checked against them. Typed-data layouts follow Paradex's public API docs.

Usage: python3 oracle.py vectors.json > oracle_out.json
Needs: pip install starknet-py starknet-crypto-py
"""
import json, sys
from starknet_py.utils.typed_data import TypedData
from starknet_crypto_py import sign, verify, get_public_key

VEC = json.load(open(sys.argv[1]))
priv = int(VEC["private_key"], 16)
addr = int(VEC["account_address"], 16)
chain_hex = hex(int.from_bytes(VEC["chain_id_str"].encode(), "big"))

def domain():
    return {"name": "Paradex", "chainId": chain_hex, "version": "1"}

DOMAIN_T = [{"name": "name", "type": "felt"}, {"name": "chainId", "type": "felt"},
            {"name": "version", "type": "felt"}]

def auth_td(ts, exp):
    return {"domain": domain(), "primaryType": "Request",
            "types": {"StarkNetDomain": DOMAIN_T,
                      "Request": [{"name": n, "type": "felt"} for n in
                                  ["method", "path", "body", "timestamp", "expiration"]]},
            "message": {"method": "POST", "path": "/v1/auth", "body": "",
                        "timestamp": ts, "expiration": exp}}

def order_td(o):
    return {"domain": domain(), "primaryType": "Order",
            "types": {"StarkNetDomain": DOMAIN_T,
                      "Order": [{"name": n, "type": "felt"} for n in
                                ["timestamp", "market", "side", "orderType", "size", "price"]]},
            "message": {"timestamp": str(o["timestamp"]), "market": o["market"],
                        "side": "1" if o["side"] == "BUY" else "2",
                        "orderType": o["orderType"], "size": o["size_q"],
                        "price": o["price_q"]}}

pub = get_public_key(priv)
out = {"public_key": hex(pub), "cases": []}
cases = [("auth", auth_td(VEC["auth"]["timestamp"], VEC["auth"]["expiration"]))]
cases += [("order:" + o["label"], order_td(o)) for o in VEC["orders"]]
for label, td in cases:
    h = TypedData.from_dict(td).message_hash(addr)
    r, s = sign(private_key=priv, msg_hash=h, seed=32)
    out["cases"].append({"label": label, "hash": hex(h), "r": hex(r), "s": hex(s)})
print(json.dumps(out, indent=1))
