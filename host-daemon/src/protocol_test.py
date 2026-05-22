from src.protocol import Request, Response


def test_request_parse():
    r = Request.parse('{"id":"a","op":"x","payload":{"k":1}}')
    assert r.id == "a" and r.op == "x" and r.payload == {"k": 1}


def test_response_serialize():
    r = Response(id="a", type="result", data={"v": 2})
    assert r.serialize() == '{"id":"a","type":"result","data":{"v":2}}\n'


def test_response_event_serialize():
    r = Response(id="a", type="event", data={"chunk": "hello"})
    assert "event" in r.serialize()
