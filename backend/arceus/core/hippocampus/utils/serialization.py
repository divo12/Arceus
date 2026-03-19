from __future__ import annotations

import json


def serialize(data: object) -> str:
    return json.dumps(data, default=str)


def deserialize(payload: str) -> object:
    return json.loads(payload)
