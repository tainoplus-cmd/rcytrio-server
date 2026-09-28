'use strict';
/* RCYTrio server: matchmaking (2/3/4 players), authoritative game rules,
   friend directory (offline search by ID) and LAN rooms. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ORDER = ['red', 'blue', 'green', 'gold'];
const SIZES = ['S', 'M', 'L'];
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const TURN_MS = 65000;

/* ---------- http (health check) ---------- */
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('RCYTrio server OK');
});
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

/* ---------- helpers ---------- */
const send = (ws, o) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} };
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

/* ---------- friend directory (persisted to dir.json) ---------- */
const DIR_FILE = path.join(__dirname, 'dir.json');
let dir = {};
try { dir = JSON.parse(fs.readFileSync(DIR_FILE, 'utf8')); } catch (e) { dir = {}; }
let dirTimer = null;
function saveDir() {
  clearTimeout(dirTimer);
  dirTimer = setTimeout(() => { try { fs.writeFileSync(DIR_FILE, JSON.stringify(dir)); } catch (e) {} }, 1500);
}

/* ---------- game rules ---------- */
function newState(n) {
  return {
    cells: Array.from({ length: 9 }, () => ({ S: null, M: null, L: null })),
    turn: 0, over: false, moves: [],
    stocks: Array.from({ length: n }, () => ({ S: 3, M: 3, L: 3 }))
  };
}
function validMoves(st, seat) {
  const out = [];
  SIZES.forEach(sz => { if (st.stocks[seat][sz] > 0) for (let i = 0; i < 9; i++) if (!st.cells[i][sz]) out.push({ idx: i, size: sz }); });
  return out;
}
function checkWin(cells, color) {
  for (const line of LINES) {
    for (const sz of SIZES) if (line.every(i => cells[i][sz] === color))
      return { type: 'same-size', cellsHit: line.map(i => ({ idx: i, size: sz })) };
    for (const ord of [['S','M','L'], ['L','M','S']])
      if (line.every((i, k) => cells[i][ord[k]] === color))
        return { type: 'sequence', cellsHit: line.map((i, k) => ({ idx: i, size: ord[k] })) };
  }
  for (let i = 0; i < 9; i++) {
    const c = cells[i];
    if (c.S === color && c.M === color && c.L === color)
      return { type: 'concentric', cellsHit: [{ idx: i, size: 'S' }, { idx: i, size: 'M' }, { idx: i, size: 'L' }] };
  }
  return null;
}

/* ---------- matchmaking + rooms ---------- */
const queues = { 2: [], 3: [], 4: [] };
const rooms = new Map();
let roomSeq = 1;

function removeFromQueues(ws) {
  for (const k of Object.keys(queues)) queues[k] = queues[k].filter(x => x !== ws);
  broadcastQueuePositions();
}
function broadcastQueuePositions() {
  for (const k of Object.keys(queues)) queues[k].forEach((w, i) => send(w, { type: 'queue', position: i + 1, players: Number(k) }));
}
function tryMatch(n) {
  const q = queues[n];
  while (q.length >= n) {
    const group = q.splice(0, n);
    if (group.some(w => w.readyState !== 1)) {
      group.filter(w => w.readyState === 1).forEach(w => q.unshift(w));
      continue;
    }
    startRoom(group);
  }
  broadcastQueuePositions();
}
function startRoom(group) {
  const n = group.length;
  const room = { id: roomSeq++, n, seats: group, st: newState(n), timer: null, ended: false };
  rooms.set(room.id, room);
  const players = group.map((w, i) => ({ seat: i, name: w.pname, av: w.pav || null, color: ORDER[i] }));
  group.forEach((w, i) => { w.room = room; w.seat = i; });
  group.forEach((w, i) => send(w, { type: 'match', seat: i, players, me: players[i], opponent: players[(i + 1) % n], state: room.st }));
  armTurnTimer(room);
}
function armTurnTimer(room) {
  clearTimeout(room.timer);
  if (room.ended || room.st.over) return;
  room.timer = setTimeout(() => {
    if (room.ended || room.st.over) return;
    const mv = validMoves(room.st, room.st.turn);
    if (mv.length) { const m = mv[Math.floor(Math.random() * mv.length)]; applyMove(room, room.st.turn, m.idx, m.size); }
  }, TURN_MS);
}
function applyMove(room, seat, idx, size) {
  const st = room.st;
  if (room.ended || st.over || st.turn !== seat) return 'Not your turn';
  if (!Number.isInteger(idx) || idx < 0 || idx > 8 || !SIZES.includes(size)) return 'Invalid move';
  if (st.cells[idx][size] || !(st.stocks[seat][size] > 0)) return 'Invalid move';
  const color = ORDER[seat];
  st.cells[idx][size] = color;
  st.stocks[seat][size]--;
  st.moves.push({ i: idx, s: size, c: color });
  let win = null;
  const w = checkWin(st.cells, color);
  if (w) { st.over = true; win = { winnerSeat: seat, data: w }; }
  else {
    const n = room.n;
    let next = (seat + 1) % n, found = false;
    for (let t = 0; t < n; t++) {
      if (validMoves(st, next).length > 0) { found = true; break; }
      next = (next + 1) % n;
    }
    if (!found) { st.over = true; win = { winnerSeat: -1 }; }
    else st.turn = next;
  }
  room.seats.forEach(x => send(x, { type: 'state', state: st, win }));
  if (st.over) { clearTimeout(room.timer); room.ended = true; }
  else armTurnTimer(room);
  return null;
}
function leaveRoom(ws, notify) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  if (!room.ended) {
    room.ended = true;
    clearTimeout(room.timer);
    room.seats.forEach(x => { if (x !== ws && x.room === room) { x.room = null; send(x, { type: 'opponent_left' }); } });
  } else {
    room.seats.forEach(x => { if (x.room === room && x !== ws) { /* others keep viewing result */ } });
  }
  rooms.delete(room.id);
  if (notify) send(ws, { type: 'left_room' });
}

/* ---------- LAN rooms ---------- */
const lanRooms = new Map();
function lanCode() {
  let c; do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (lanRooms.has(c));
  return c;
}
function lanBroadcast(r) {
  const members = r.members.map(m => ({ seat: m.seat, name: m.name, av: m.av, host: m.host }));
  r.members.forEach(m => send(m.ws, { type: 'lan_members', members, you: m.seat, room: r.name, code: r.code }));
}
function lanRemove(ws, reason) {
  const r = ws.lan;
  if (!r) return;
  ws.lan = null;
  if (r.hostWs === ws) {
    r.members.forEach(m => { if (m.ws !== ws) { m.ws.lan = null; send(m.ws, { type: 'lan_closed' }); } });
    lanRooms.delete(r.code);
  } else {
    r.members = r.members.filter(m => m.ws !== ws);
    lanBroadcast(r);
  }
}

/* ---------- connections ---------- */
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.pname = 'Player'; ws.pav = null; ws.room = null; ws.seat = -1; ws.lan = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.type !== 'string') return;
    ws.isAlive = true;

    switch (m.type) {
      case 'ping': send(ws, { type: 'pong' }); break;

      case 'hello':
        ws.pname = str(m.name, 16) || 'Player';
        ws.pav = (typeof m.av === 'string' && m.av.length < 60000) ? m.av : null;
        break;

      case 'matchmake': {
        if (ws.room) return send(ws, { type: 'error', message: 'Already in a match' });
        let n = Number(m.players || m.mode) || 2;
        if (![2, 3, 4].includes(n)) n = 2;
        removeFromQueues(ws);
        queues[n].push(ws);
        broadcastQueuePositions();
        tryMatch(n);
        break;
      }
      case 'cancel_matchmaking':
        removeFromQueues(ws);
        send(ws, { type: 'queue_cancelled' });
        break;

      case 'move': {
        if (!ws.room) return send(ws, { type: 'error', message: 'Not in a match' });
        const err = applyMove(ws.room, ws.seat, Number(m.idx), m.size);
        if (err) send(ws, { type: 'error', message: err });
        break;
      }
      case 'chat': {
        if (!ws.room) return;
        const text = str(m.text, 60); if (!text) return;
        ws.room.seats.forEach(x => { if (x !== ws) send(x, { type: 'chat', seat: ws.seat, text }); });
        break;
      }
      case 'reaction':
        if (!ws.room) return;
        ws.room.seats.forEach(x => { if (x !== ws) send(x, { type: 'reaction', seat: ws.seat, index: Number(m.index) || 0 }); });
        break;

      case 'leave_room':
        removeFromQueues(ws);
        leaveRoom(ws, true);
        break;

      /* ----- friend directory ----- */
      case 'dir_register': {
        const fid = str(m.fid, 10);
        if (!/^\d{10}$/.test(fid)) return send(ws, { type: 'dir_error' });
        dir[fid] = { fid, name: str(m.name, 16) || 'Player', av: (typeof m.av === 'string' && m.av.length < 60000) ? m.av : null, cc: str(m.cc, 4), lastSeen: Date.now() };
        saveDir();
        send(ws, { type: 'dir_ok' });
        break;
      }
      case 'dir_find': {
        const u = dir[str(m.fid, 10)];
        if (u) send(ws, { type: 'dir_found', user: u });
        else send(ws, { type: 'dir_notfound' });
        break;
      }

      /* ----- LAN ----- */
      case 'lan_create': {
        lanRemove(ws);
        const code = lanCode();
        const name = str(m.room, 20) || (str(m.name, 16) + "'s Room");
        const r = { code, name, hostWs: ws, members: [] };
        r.members.push({ ws, seat: 0, name: str(m.name, 16) || 'Player', av: (typeof m.av === 'string' && m.av.length < 60000) ? m.av : null, host: true });
        ws.lan = r; lanRooms.set(code, r);
        send(ws, { type: 'lan_created', code, room: name });
        lanBroadcast(r);
        break;
      }
      case 'lan_list':
        send(ws, { type: 'lan_rooms', rooms: [...lanRooms.values()].map(r => ({ code: r.code, name: r.name, host: r.members[0] ? r.members[0].name : '', count: r.members.length })) });
        break;
      case 'lan_join': {
        const r = lanRooms.get(str(m.code, 8));
        if (!r) return send(ws, { type: 'lan_error', message: 'Room not found' });
        if (r.members.length >= 4) return send(ws, { type: 'lan_error', message: 'Room is full' });
        lanRemove(ws);
        let seat = 0; while (r.members.some(x => x.seat === seat)) seat++;
        r.members.push({ ws, seat, name: str(m.name, 16) || 'Player', av: (typeof m.av === 'string' && m.av.length < 60000) ? m.av : null, host: false });
        ws.lan = r;
        send(ws, { type: 'lan_joined', code: r.code, room: r.name });
        lanBroadcast(r);
        break;
      }
      case 'lan_kick': {
        const r = ws.lan; if (!r || r.hostWs !== ws) return;
        const t = r.members.find(x => x.seat === Number(m.seat) && x.ws !== ws);
        if (!t) return;
        r.members = r.members.filter(x => x !== t); t.ws.lan = null;
        send(t.ws, { type: 'lan_kicked' });
        lanBroadcast(r);
        break;
      }
      case 'lan_leave': lanRemove(ws); break;
      case 'lan_relay': {
        const r = ws.lan; if (!r) return;
        r.members.forEach(x => { if (x.ws !== ws) send(x.ws, { type: 'lan_data', data: m.data }); });
        break;
      }
    }
  });

  ws.on('close', () => { removeFromQueues(ws); leaveRoom(ws, false); lanRemove(ws); });
  ws.on('error', () => {});
});

/* drop dead connections so nobody sits in a queue as a ghost */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 20000);

server.listen(PORT, () => console.log('RCYTrio server listening on ' + PORT));
