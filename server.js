// RCYTrio game server (v1) — Node.js + WebSocket ("ws")
// Everything lives in memory: if the server restarts, rooms/queues are cleared.
// Accounts, leaderboard and cups (database) come in a later step.

const http = require('http');
const { WebSocketServer } = require('ws');

// ---------- settings (change here) ----------
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;        // players per room
const MIN_TO_START = 2;       // minimum players to start a room / online match
const QUEUE_WAIT_MS = 10000;  // online queue: wait this long for a full room, then start with what we have
const MAX_ROOMS = 500;
const MAX_MSG_BYTES = 64 * 1024;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- http (health check for Render) ----------
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RCYTrio server is running');
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

// ---------- state ----------
let nextId = 1;
const clients = new Set();
const byFid = new Map();   // fid -> client (who is online)
const rooms = new Map();   // code -> room
let queue = [];            // clients waiting for an online match
let queueTimer = null;

// ---------- helpers ----------
function send(c, obj) {
  if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
}
function clean(s, max) {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) : '';
}
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}
function roomView(room) {
  return {
    code: room.code,
    mode: room.mode,
    name: room.name,
    started: room.started,
    members: room.members.map((m, i) => ({
      id: m.c.id, fid: m.c.fid, name: m.c.name, av: m.c.av,
      slot: i, ready: m.ready, isHost: m.c.id === room.hostId
    }))
  };
}
function broadcast(room, obj, exceptId) {
  for (const m of room.members) if (m.c.id !== exceptId) send(m.c, obj);
}
function pushRoom(room) {
  broadcast(room, { t: 'room_update', room: roomView(room) });
}

// ---------- rooms ----------
function removeFromRoom(c) {
  const room = c.roomCode && rooms.get(c.roomCode);
  c.roomCode = null;
  if (!room) return;
  room.members = room.members.filter(m => m.c.id !== c.id);
  if (room.members.length === 0) { rooms.delete(room.code); return; }
  if (room.hostId === c.id) room.hostId = room.members[0].c.id;
  broadcast(room, { t: 'player_left', id: c.id });
  pushRoom(room);
}

function createRoom(c, mode, name, isPublic) {
  if (rooms.size >= MAX_ROOMS) return send(c, { t: 'error', msg: 'Server is full, try again later' });
  removeFromRoom(c);
  leaveQueue(c);
  const room = {
    code: makeCode(), mode, name: name || (c.name + "'s Room"),
    hostId: c.id, isPublic: !!isPublic, started: false, seed: 0,
    members: [{ c, ready: true }]
  };
  rooms.set(room.code, room);
  c.roomCode = room.code;
  send(c, { t: 'room_created', room: roomView(room) });
}

function joinRoom(c, code) {
  const room = rooms.get(clean(code, 8).toUpperCase());
  if (!room) return send(c, { t: 'error', msg: 'Room not found' });
  if (room.started) return send(c, { t: 'error', msg: 'Game already started' });
  if (room.members.some(m => m.c.id === c.id)) return send(c, { t: 'room_joined', room: roomView(room) });
  if (room.members.length >= MAX_PLAYERS) return send(c, { t: 'error', msg: 'Room is full' });
  removeFromRoom(c);
  leaveQueue(c);
  room.members.push({ c, ready: false });
  c.roomCode = room.code;
  send(c, { t: 'room_joined', room: roomView(room) });
  pushRoom(room);
}

function startRoom(room) {
  room.started = true;
  room.seed = Math.floor(Math.random() * 2147483647);
  broadcast(room, { t: 'game_start', seed: room.seed, room: roomView(room) });
}

// ---------- online matchmaking queue ----------
function leaveQueue(c) {
  queue = queue.filter(q => q.id !== c.id);
  if (queue.length < MIN_TO_START && queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
}
function makeMatch() {
  if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
  const group = queue.splice(0, MAX_PLAYERS);
  if (group.length < MIN_TO_START) { queue = group.concat(queue); return; }
  const room = {
    code: makeCode(), mode: 'online', name: 'Online Match',
    hostId: group[0].id, isPublic: false, started: false, seed: 0,
    members: group.map(c => ({ c, ready: true }))
  };
  rooms.set(room.code, room);
  group.forEach(c => { c.roomCode = room.code; });
  broadcast(room, { t: 'match_found', room: roomView(room) });
  startRoom(room);
  if (queue.length >= MIN_TO_START) scheduleQueue();
}
function scheduleQueue() {
  if (queue.length >= MAX_PLAYERS) return makeMatch();
  if (queue.length >= MIN_TO_START && !queueTimer) queueTimer = setTimeout(makeMatch, QUEUE_WAIT_MS);
}
function joinQueue(c) {
  if (queue.some(q => q.id === c.id)) return;
  removeFromRoom(c);
  queue.push(c);
  send(c, { t: 'queue_joined' });
  scheduleQueue();
}

// ---------- message handling ----------
function handle(c, msg) {
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'hello') {
    const fid = clean(String(msg.fid || ''), 20);
    if (!/^[0-9]{6,20}$/.test(fid)) return send(c, { t: 'error', msg: 'Bad id' });
    const old = byFid.get(fid);
    if (old && old !== c) { removeFromRoom(old); leaveQueue(old); old.fid = null; old.ws.close(); }
    c.fid = fid;
    c.name = clean(msg.name, 24) || 'Player';
    c.av = typeof msg.av === 'string' && msg.av.length <= 30000 ? msg.av : '';
    byFid.set(fid, c);
    return send(c, { t: 'welcome', id: c.id });
  }

  if (msg.t === 'ping') return send(c, { t: 'pong' });
  if (!c.fid) return send(c, { t: 'error', msg: 'Send hello first' });

  switch (msg.t) {
    case 'friends_status': {
      const list = Array.isArray(msg.fids) ? msg.fids.slice(0, 200) : [];
      const online = list.filter(f => byFid.has(String(f)) && byFid.get(String(f)) !== c).map(String);
      return send(c, { t: 'friends_online', online });
    }
    case 'room_create': {
      const mode = msg.mode === 'bt' ? 'bt' : 'party';
      return createRoom(c, mode, clean(msg.name, 30), msg.public);
    }
    case 'room_join': return joinRoom(c, msg.code);
    case 'room_leave': return removeFromRoom(c);
    case 'room_list': {
      const mode = msg.mode === 'bt' ? 'bt' : 'party';
      const list = [...rooms.values()]
        .filter(r => r.isPublic && r.mode === mode && !r.started && r.members.length < MAX_PLAYERS)
        .map(r => ({ code: r.code, name: r.name, count: r.members.length, max: MAX_PLAYERS }));
      return send(c, { t: 'room_list', rooms: list });
    }
    case 'room_ready': {
      const room = rooms.get(c.roomCode);
      if (!room || room.started) return;
      const m = room.members.find(x => x.c.id === c.id);
      if (m) { m.ready = !!msg.ready; pushRoom(room); }
      return;
    }
    case 'room_start': {
      const room = rooms.get(c.roomCode);
      if (!room || room.started) return;
      if (room.hostId !== c.id) return send(c, { t: 'error', msg: 'Only the host can start' });
      if (room.members.length < MIN_TO_START) return send(c, { t: 'error', msg: 'Need more players' });
      if (!room.members.every(m => m.ready)) return send(c, { t: 'error', msg: 'Not everyone is ready' });
      return startRoom(room);
    }
    case 'party_invite': {
      const room = rooms.get(c.roomCode);
      const target = byFid.get(String(msg.toFid || ''));
      if (!room || !target || target === c) return send(c, { t: 'error', msg: 'Friend is offline' });
      return send(target, { t: 'party_invite', code: room.code, from: { fid: c.fid, name: c.name } });
    }
    case 'game_event': {
      const room = rooms.get(c.roomCode);
      if (!room || !room.started) return;
      return broadcast(room, { t: 'game_event', from: c.id, data: msg.data }, c.id);
    }
    case 'game_over': {
      const room = rooms.get(c.roomCode);
      if (!room || !room.started || room.hostId !== c.id) return;
      broadcast(room, { t: 'game_over', data: msg.data });
      room.started = false;
      room.members.forEach(m => { m.ready = m.c.id === room.hostId; });
      return pushRoom(room);
    }
    case 'queue_join': return joinQueue(c);
    case 'queue_leave': return leaveQueue(c);
  }
}

// ---------- connections ----------
wss.on('connection', ws => {
  const c = { id: nextId++, ws, fid: null, name: 'Player', av: '', roomCode: null, alive: true, msgCount: 0 };
  clients.add(c);

  ws.on('pong', () => { c.alive = true; });
  ws.on('message', data => {
    c.msgCount++;
    if (c.msgCount > 600) return ws.close(); // flood protection (reset every 10 s below)
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    try { handle(c, msg); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => {
    removeFromRoom(c);
    leaveQueue(c);
    if (c.fid && byFid.get(c.fid) === c) byFid.delete(c.fid);
    clients.delete(c);
  });
  ws.on('error', () => {});
});

// heartbeat: keeps the connection alive on Render and drops dead ones
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch (e) {}
  }
}, 30000);
setInterval(() => { for (const c of clients) c.msgCount = 0; }, 10000);

server.listen(PORT, () => console.log('RCYTrio server listening on port ' + PORT));
