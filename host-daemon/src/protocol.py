"""JSON-line RPC envelope. One JSON object per line, '\n' terminator."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any, Literal

MessageType = Literal["event", "result", "error"]


@dataclass
class Request:
    id: str
    op: str
    payload: dict[str, Any]

    @staticmethod
    def parse(line: str) -> "Request":
        d = json.loads(line)
        return Request(id=d["id"], op=d["op"], payload=d.get("payload", {}))


@dataclass
class Response:
    id: str
    type: MessageType
    data: dict[str, Any]

    def serialize(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":")) + "\n"
