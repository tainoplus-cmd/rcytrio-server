const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      service: "RCYTrio Multiplayer Server",
      players: wss.clients.size
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

const wss = new WebSocket.Server({ server });

const waiting = new Set();
const rooms = new Map();
const clients = new Map();

function id() {
  return crypto.randomUUID();
}

function send(ws, type, data = {}) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

function removeFromWaiting(ws) {
  waiting.delete(ws);
}

function leaveRoom(ws, notify = true) {
  const roomId = ws.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  ws.roomId = null;

  if (!room) return;

  room.players.delete(ws);

  for (const other of room.players) {
    if (notify) send(other, "opponent_left");
    other.roomId = null;
  }

  if (room.players.size === 0) {
    rooms.delete(roomId);
  }
}

function pairPlayers(a, b) {
  removeFromWaiting(a);
  removeFromWaiting(b);

  const roomId = id();
  const room = { id: roomId, players: new Set([a, b]) };
  rooms.set(roomId, room);

  a.roomId = roomId;
  b.roomId = roomId;

  send(a, "matched", {
    roomId,
    player: 1,
    opponent: { id: b.id, name: b.name }
  });

  send(b, "matched", {
    roomId,
    player: 2,
    opponent: { id: a.id, name: a.name }
  });

  send(a, "match_found", {
    roomId,
    player: 1,
    opponent: { id: b.id, name: b.name }
  });

  send(b, "match_found", {
    roomId,
    player: 2,
    opponent: { id: a.id, name: a.name }
  });
}

function tryMatch() {
  while (waiting.size >= 2) {
    const list = [...waiting];
    const a = list[0];
    const b = list[1];

    if (!a || !b) break;
    pairPlayers(a, b);
  }
}

function relayToOpponent(ws, message) {
  const room = rooms.get(ws.roomId);
  if (!room) {
    send(ws, "error", { message: "You are not in a room." });
    return;
  }

  for (const other of room.players) {
    if (other !== ws) send(other, message);
  }
}

function safeName(value) {
  const name = String(value ?? "").trim().slice(0, 24);
  return name || "Player";
}

wss.on("connection", (ws) => {
  const client = {
    id: id(),
    name: "Player"
  };

  clients.set(ws, client);
  ws.id = client.id;
  ws.name = client.name;
  ws.roomId = null;

  send(ws, "connected", {
    id: ws.id,
    server: "RCYTrio Multiplayer Server"
  });

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, "error", { message: "Invalid JSON message." });
      return;
    }

    const type = String(msg.type || msg.action || "").toLowerCase();

    if (type === "hello" || type === "join") {
      ws.name = safeName(msg.name || msg.playerName);
      client.name = ws.name;

      send(ws, "hello_ok", {
        id: ws.id,
        name: ws.name
      });
      return;
    }

    if (
      type === "matchmake" ||
      type === "find_match" ||
      type === "queue" ||
      type === "start_matchmaking"
    ) {
      leaveRoom(ws, false);
      removeFromWaiting(ws);
      waiting.add(ws);

      send(ws, "queued", {
        position: waiting.size
      });

      tryMatch();
      return;
    }

    if (type === "cancel_matchmaking" || type === "cancel_queue") {
      removeFromWaiting(ws);
      send(ws, "queue_cancelled");
      return;
    }

    if (
      type === "move" ||
      type === "game_move" ||
      type === "state" ||
      type === "game_state"
    ) {
      relayToOpponent(ws, {
        type: type === "move" ? "opponent_move" : "opponent_state",
        from: ws.id,
        payload: msg.payload ?? msg.move ?? msg.state ?? null
      });
      return;
    }

    if (type === "chat" || type === "message") {
      relayToOpponent(ws, {
        type: "chat",
        from: ws.id,
        name: ws.name,
        text: String(msg.text ?? msg.message ?? "").slice(0, 500)
      });
      return;
    }

    if (type === "reaction" || type === "sticker") {
      relayToOpponent(ws, {
        type: "reaction",
        from: ws.id,
        reaction: String(msg.reaction ?? msg.sticker ?? "").slice(0, 40)
      });
      return;
    }

    if (type === "ping") {
      send(ws, "pong", { t: Date.now() });
      return;
    }

    if (type === "leave" || type === "leave_room") {
      leaveRoom(ws, true);
      removeFromWaiting(ws);
      send(ws, "left_room");
      return;
    }

    send(ws, "error", { message: `Unknown message type: ${type || "empty"}` });
  });

  ws.on("close", () => {
    removeFromWaiting(ws);
    leaveRoom(ws, true);
    clients.delete(ws);
  });

  ws.on("error", () => {
    removeFromWaiting(ws);
    leaveRoom(ws, true);
    clients.delete(ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`RCYTrio server listening on ${HOST}:${PORT}`);
});
