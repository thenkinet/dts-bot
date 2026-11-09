"""Independent oracle: hashes built with Paradex's official SDK (paradex-py)
message builders, not with our own reading of the docs.
Usage: python3 test/sdk_oracle.py test/vectors.json > test/sdk_out.json
Needs: pip install paradex-py
"""
import json, sys
from decimal import Decimal
from starknet_py.utils.typed_data import TypedData
from paradex_py.message.auth import build_auth_message
from paradex_py.message.order import build_order_message
from paradex_py.common.order import Order, OrderType, OrderSide

V = json.load(open(sys.argv[1]))
chain = int.from_bytes(V["chain_id_str"].encode(), "big")
addr = int(V["account_address"], 16)
out = {"sdk": "paradex-py", "cases": []}
h = TypedData.from_dict(build_auth_message(chain, V["auth"]["timestamp"], V["auth"]["expiration"])).message_hash(addr)
out["cases"].append({"label": "auth", "hash": hex(h)})
for o in V["orders"]:
    otype = OrderType.Market if o["orderType"] == "MARKET" else OrderType.Limit
    side = OrderSide.Buy if o["side"] == "BUY" else OrderSide.Sell
    order = Order(market=o["market"], order_type=otype, order_side=side, size=Decimal(o["size"]),
                  limit_price=Decimal(o["price"]), signature_timestamp=o["timestamp"])
    h = TypedData.from_dict(build_order_message(chain, order)).message_hash(addr)
    out["cases"].append({"label": "order:" + o["label"], "hash": hex(h)})
print(json.dumps(out, indent=1))
