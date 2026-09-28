const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";
const SIZES = ["S", "M", "L"];
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const COLORS = ["red", "blue"];

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
const waiting = [];
const rooms = new Map();

function id() { return crypto.randomUUID(); }
function safeName(v) { const n = String(v ?? "").trim().slice(0, 16); return n || "Player"; }
function send(ws, type, data = {}) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function roomFor(ws) { return ws.roomId ? rooms.get(ws.roomId) : null; }
function removeWaiting(ws) {
  const i = waiting.indexOf(ws);
  if (i >= 0) waiting.splice(i, 1);
}
function emptyState() {
  return {
    cells: Array.from({ length: 9 }, () => ({ S: null, M: null, L: null })),
    turn: 0,
    over: false,
    moves: [],
    stocks: [{ S: 3, M: 3, L: 3 }, { S: 3, M: 3, L: 3 }]
  };
}
function checkWin(state, color) {
  for (const line of LINES) {
    for (const size of SIZES) {
      if (line.every(i => state.cells[i][size] === color)) {
        return { type: "same-size", cellsHit: line.map(idx => ({ idx, size })) };
      }
    }
    for (const order of [["S","M","L"],["L","M","S"]]) {
      if (line.every((i,k) => state.cells[i][order[k]] === color)) {
        return { type: "sequence", cellsHit: line.map((idx,k) => ({ idx, size: order[k] })) };
      }
    }
  }
  for (let i = 0; i < 9; i++) {
    const c = state.cells[i];
    if (c.S === color && c.M === color && c.L === color) {
      return { type: "concentric", cellsHit: [{idx:i,size:"S"},{idx:i,size:"M"},{idx:i,size:"L"}] };
    }
  }
  return null;
}
function hasMoves(state, seat) {
  for (const size of SIZES) {
    if (state.stocks[seat][size] <= 0) continue;
    if (state.cells.some(c => !c[size])) return true;
  }
  return false;
}
function nextTurn(state) {
  for (let n = 0; n < 2; n++) {
    state.turn = (state.turn + 1) % 2;
    if (hasMoves(state, state.turn)) return true;
  }
  state.over = true;
  return false;
}
function publicState(state) {
  return JSON.parse(JSON.stringify(state));
}
function publicPlayer(p) { return { seat: p.seat, name: p.name, color: p.color }; }
function broadcastState(room, win = null) {
  room.players.forEach((p) => send(p.ws, "state", { state: publicState(room.state), win }));
}
function closeRoom(ws, notify = true) {
  const room = roomFor(ws);
  if (!room) return;
  ws.roomId = null;
  room.players = room.players.filter(p => p.ws !== ws);
  if (notify) room.players.forEach(p => send(p.ws, "opponent_left"));
  if (!room.players.length) rooms.delete(room.id);
  else rooms.set(room.id, room);
}
function tryMatch() {
  while (waiting.length >= 2) {
    const a = waiting.shift();
    const b = waiting.shift();
    if (!a || !b || a.readyState !== WebSocket.OPEN || b.readyState !== WebSocket.OPEN) continue;
    const room = {
      id: id(),
      players: [
        { ws: a, seat: 0, name: a.name, color: COLORS[0] },
        { ws: b, seat: 1, name: b.name, color: COLORS[1] }
      ],
      state: emptyState()
    };
    rooms.set(room.id, room);
    a.roomId = room.id; b.roomId = room.id;
    send(a, "match", { room: room.id, seat: 0, me: publicPlayer(room.players[0]), opponent: publicPlayer(room.players[1]), state: publicState(room.state) });
    send(b, "match", { room: room.id, seat: 1, me: publicPlayer(room.players[1]), opponent: publicPlayer(room.players[0]), state: publicState(room.state) });
  }
}

wss.on("connection", (ws) => {
  ws.id = id();
  ws.name = "Player";
  ws.roomId = null;

  send(ws, "hello_ack", { id: ws.id, server: "RCYTrio Multiplayer Server" });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, "error", { message: "Invalid JSON message." }); return; }
    const type = String(msg.type || msg.action || "").toLowerCase();

    if (type === "hello" || type === "join") {
      ws.name = safeName(msg.name || msg.playerName);
      send(ws, "hello_ack", { id: ws.id, name: ws.name });
      return;
    }
    if (type === "find" || type === "matchmake" || type === "find_match" || type === "queue" || type === "start_matchmaking") {
      closeRoom(ws, false);
      removeWaiting(ws);
      waiting.push(ws);
      send(ws, "queue", { position: waiting.length });
      tryMatch();
      return;
    }
    if (type === "cancel" || type === "cancel_matchmaking" || type === "cancel_queue") {
      removeWaiting(ws);
      send(ws, "queue_cancelled");
      return;
    }
    if (type === "move") {
      const room = roomFor(ws);
      if (!room || room.state.over) { send(ws, "error", { message: "No active match." }); return; }
      const player = room.players.find(p => p.ws === ws);
      const idx = Number(msg.idx), size = String(msg.size || "");
      if (!player || player.seat !== room.state.turn || !Number.isInteger(idx) || idx < 0 || idx > 8 || !SIZES.includes(size)) {
        send(ws, "error", { message: "Invalid move." }); return;
      }
      if (room.state.cells[idx][size] || room.state.stocks[player.seat][size] <= 0) {
        send(ws, "error", { message: "Move not allowed." }); return;
      }
      room.state.cells[idx][size] = player.color;
      room.state.stocks[player.seat][size]--;
      room.state.moves.push({ i: idx, s: size, c: player.color });
      const win = checkWin(room.state, player.color);
      if (win) {
        room.state.over = true;
        broadcastState(room, { winnerSeat: player.seat, data: win });
        return;
      }
      if (!hasMoves(room.state, 0) && !hasMoves(room.state, 1)) {
        room.state.over = true;
        broadcastState(room, { winnerSeat: -1, data: null });
        return;
      }
      nextTurn(room.state);
      broadcastState(room, null);
      return;
    }
    if (type === "chat" || type === "message") {
      const room = roomFor(ws);
      if (!room) return;
      const player = room.players.find(p => p.ws === ws);
      room.players.forEach(p => { if (p.ws !== ws) send(p.ws, "chat", { seat: player?.seat ?? 1, text: String(msg.text ?? msg.message ?? "").slice(0, 300) }); });
      return;
    }
    if (type === "reaction" || type === "sticker") {
      const room = roomFor(ws);
      if (!room) return;
      const player = room.players.find(p => p.ws === ws);
      room.players.forEach(p => { if (p.ws !== ws) send(p.ws, "reaction", { seat: player?.seat ?? 1, index: Number(msg.index ?? 0) || 0 }); });
      return;
    }
    if (type === "ping") { send(ws, "pong", { t: Date.now() }); return; }
    if (type === "leave" || type === "leave_room") { removeWaiting(ws); closeRoom(ws, true); send(ws, "left_room"); return; }
    send(ws, "error", { message: `Unknown message type: ${type || "empty"}` });
  });

  ws.on("close", () => { removeWaiting(ws); closeRoom(ws, true); });
  ws.on("error", () => { removeWaiting(ws); closeRoom(ws, true); });
});

server.listen(PORT, HOST, () => console.log(`RCYTrio server listening on ${HOST}:${PORT}`));
