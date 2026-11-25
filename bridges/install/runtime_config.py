def read_config(dcc):
    """Private connection parameters shared by the plugins on this machine."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    with open(path, encoding="utf-8") as config_file:
        config = json.load(config_file)
    url = config.get("url", "")
    token = config.get("token", "")
    if not url.startswith("http://127.0.0.1:") or not url.rsplit(":", 1)[1].isdigit():
        raise ValueError("Nexus bridge requires a loopback endpoint")
    if len(token) != 64 or any(ch not in "0123456789abcdef" for ch in token):
        raise ValueError("Nexus bridge configuration is invalid")
    return {"url": url, "token": token, "dcc": dcc}


def connect(dcc, placement=False):
    config = read_config(dcc)
    config["placement"] = bool(placement)
    previous = getattr(builtins, "_nexus_bridge_" + dcc, None)
    if previous and previous.running and previous.config == config:
        return previous
    return start(config)


def placement_context(path, dcc):
    import uuid
    name, suffix = os.path.splitext(os.path.basename(path))
    if suffix.lower() != ".nexusdrop" or str(uuid.UUID(name)) != name:
        raise ValueError("无效的 Nexus 放置请求")
    bridge = getattr(builtins, "_nexus_bridge_" + dcc, None)
    if not bridge or not bridge.running or not bridge.session:
        raise RuntimeError("请先启动 Nexus 并等待桥接连接")
    return bridge, name


def resolve_drag_ticket(path, dcc):
    bridge, ticket = placement_context(path, dcc)
    result = bridge.request("/bridge/placement/resolve",
                            {"sessionId": bridge.session, "ticketId": ticket}, timeout=1)
    return result["files"]


def finish_drag_ticket(path, dcc, status, message=None):
    bridge, ticket = placement_context(path, dcc)
    bridge.report_placement(ticket, status, message)
