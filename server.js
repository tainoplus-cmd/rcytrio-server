const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const COLORS = ['red', 'blue', 'green', 'yellow'];
const SIZES = ['S', 'M', 'L'];
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const queues = new Map([[2,[]],[3,[]],[4,[]]]);
const rooms = new Map();
const directory = new Map();

const id = () => crypto.randomUUID();
const safeName = v => String(v ?? '').trim().slice(0, 20) || 'Player';
const modeOf = v => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2 && n <= 4 ? n : 2;
};
function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function broadcast(room, type, data = {}) { room.players.forEach(p => send(p.ws, type, data)); }
function roomOf(ws) { return ws.roomId ? rooms.get(ws.roomId) : null; }
function removeFromQueue(ws) {
  for (const q of queues.values()) {
    const i = q.indexOf(ws);
    if (i >= 0) q.splice(i, 1);
  }
}
function emptyState(n) {
  return {
    cells: Array.from({length:9}, () => ({S:null,M:null,L:null})),
    turn: 0,
    over: false,
    moves: [],
    stocks: Array.from({length:n}, () => ({S:3,M:3,L:3}))
  };
}
function publicPlayer(p) { return { seat:p.seat, name:p.name, color:p.color, av:p.av || null }; }
function hasMoves(state, seat) {
  return SIZES.some(size => state.stocks[seat][size] > 0 && state.cells.some(c => !c[size]));
}
function nextTurn(state) {
  const n = state.stocks.length;
  for (let step=1; step<=n; step++) {
    const next = (state.turn + step) % n;
    if (hasMoves(state,next)) { state.turn = next; return true; }
  }
  state.over = true;
  return false;
}
function checkWin(state, color) {
  for (const line of LINES) {
    for (const size of SIZES) if (line.every(i => state.cells[i][size] === color))
      return { type:'same-size', cellsHit:line.map(idx=>({idx,size})) };
    for (const order of [['S','M','L'],['L','M','S']])
      if (line.every((i,k) => state.cells[i][order[k]] === color))
        return { type:'sequence', cellsHit:line.map((idx,k)=>({idx,size:order[k]})) };
  }
  for (let i=0;i<9;i++) if (SIZES.every(size => state.cells[i][size] === color))
    return { type:'concentric', cellsHit:SIZES.map(size=>({idx:i,size})) };
  return null;
}
function publicState(state) { return JSON.parse(JSON.stringify(state)); }
function roomState(room, win=null) {
  room.players.forEach(p => send(p.ws,'state',{state:publicState(room.state),win}));
}
function leaveRoom(ws, notify=true) {
  const room=roomOf(ws); if(!room)return;
  ws.roomId=null;
  room.players=room.players.filter(p=>p.ws!==ws);
  if(notify) room.players.forEach(p=>send(p.ws,'opponent_left'));
  if(room.players.length===0) rooms.delete(room.id);
}
function makeRoom(players, mode) {
  const room={id:id(), mode, players:players.map((ws,seat)=>({ws,seat,name:ws.name,color:COLORS[seat],av:ws.av||null})), state:emptyState(players.length)};
  rooms.set(room.id,room);
  players.forEach((ws,seat)=>{
    ws.roomId=room.id;
    const me=room.players[seat];
    const others=room.players.filter(p=>p.seat!==seat);
    send(ws,'match',{
      room:room.id, seat, mySeat:seat, n:room.players.length,
      me:publicPlayer(me), opponent:others[0] ? publicPlayer(others[0]) : null,
      players:room.players.map(publicPlayer), state:publicState(room.state)
    });
  });
}
function tryMatch(mode) {
  const q=queues.get(mode); if(!q)return;
  while(q.length >= mode) {
    const group=q.splice(0,mode).filter(ws=>ws && ws.readyState===WebSocket.OPEN && !ws.roomId);
    if(group.length===mode) makeRoom(group,mode);
    else group.forEach(ws=>{ if(ws.readyState===WebSocket.OPEN&&!ws.roomId) q.push(ws); });
  }
  q.forEach((ws,i)=>send(ws,'queue',{position:i+1,players:mode}));
}
function joinQueue(ws, mode) {
  removeFromQueue(ws);
  if(roomOf(ws)) leaveRoom(ws,false);
  ws.queueMode=mode;
  const q=queues.get(mode);
  if(!q.includes(ws)) q.push(ws);
  send(ws,'queue',{position:q.indexOf(ws)+1,players:mode});
  tryMatch(mode);
}
function dirRegister(ws,msg) {
  const fid=String(msg.fid||'').slice(0,32); if(!fid)return;
  directory.set(fid,{fid,name:safeName(msg.name),av:typeof msg.av==='string'&&msg.av.length<60000?msg.av:null,cc:String(msg.cc||'').slice(0,8),lastSeen:Date.now()});
  send(ws,'dir_ok');
}
const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.url==='/'||req.url==='/health') {
    let queued=0; queues.forEach(q=>queued+=q.length);
    res.end(JSON.stringify({ok:true,service:'RCYTrio Multiplayer Server',players:wss.clients.size,queued,rooms:rooms.size})); return;
  }
  res.statusCode=404; res.end(JSON.stringify({ok:false,error:'Not found'}));
});
const wss=new WebSocket.Server({server});

wss.on('connection',ws=>{
  ws.id=id(); ws.name='Player'; ws.av=null; ws.roomId=null; ws.queueMode=null;
  send(ws,'hello_ack',{id:ws.id,server:'RCYTrio Multiplayer Server',version:'27-fixed'});
  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw.toString())}catch{send(ws,'error',{message:'Invalid JSON'});return;}
    const type=String(m.type||m.action||'').toLowerCase();
    if(type==='hello'||type==='join') { ws.name=safeName(m.name||m.playerName); ws.av=typeof m.av==='string'&&m.av.length<60000?m.av:null; send(ws,'hello_ack',{id:ws.id,name:ws.name}); return; }
    if(type==='matchmake'||type==='find'||type==='find_match'||type==='queue'||type==='start_matchmaking') { joinQueue(ws,modeOf(m.players||m.mode)); return; }
    if(type==='cancel'||type==='cancel_matchmaking'||type==='cancel_queue') { removeFromQueue(ws); ws.queueMode=null; send(ws,'queue_cancelled'); return; }
    if(type==='leave'||type==='leave_room') { removeFromQueue(ws); leaveRoom(ws,true); send(ws,'left_room'); return; }
    if(type==='move') {
      const room=roomOf(ws); if(!room||room.state.over){send(ws,'error',{message:'No active match'});return;}
      const p=room.players.find(x=>x.ws===ws), idx=Number(m.idx), size=String(m.size||'');
      if(!p||p.seat!==room.state.turn||!Number.isInteger(idx)||idx<0||idx>8||!SIZES.includes(size)){send(ws,'error',{message:'Invalid move'});return;}
      if(room.state.cells[idx][size]||room.state.stocks[p.seat][size]<=0){send(ws,'error',{message:'Move not allowed'});return;}
      room.state.cells[idx][size]=p.color; room.state.stocks[p.seat][size]--; room.state.moves.push({i:idx,s:size,c:p.color});
      const win=checkWin(room.state,p.color);
      if(win){room.state.over=true;roomState(room,{winnerSeat:p.seat,data:win});return;}
      nextTurn(room.state); roomState(room,null); return;
    }
    if(type==='chat'||type==='message') { const r=roomOf(ws),p=r&&r.players.find(x=>x.ws===ws); if(r&&p)r.players.forEach(x=>{if(x.ws!==ws)send(x,'chat',{seat:p.seat,text:String(m.text??m.message??'').slice(0,300)})}); return; }
    if(type==='reaction'||type==='sticker') { const r=roomOf(ws),p=r&&r.players.find(x=>x.ws===ws); if(r&&p)r.players.forEach(x=>{if(x.ws!==ws)send(x,'reaction',{seat:p.seat,index:Number(m.index)||0})}); return; }
    if(type==='dir_register'){dirRegister(ws,m);return;}
    if(type==='dir_find'){const fid=String(m.fid||'');const u=directory.get(fid);send(ws,u&&Date.now()-u.lastSeen<120000?'dir_found':'dir_not_found',u?{user:u}:{});return;}
    if(type==='ping'){send(ws,'pong',{t:Date.now()});return;}
    send(ws,'error',{message:`Unknown message type: ${type||'empty'}`});
  });
  ws.on('close',()=>{removeFromQueue(ws);leaveRoom(ws,true);});
  ws.on('error',()=>{removeFromQueue(ws);leaveRoom(ws,true);});
});

server.listen(PORT,HOST,()=>console.log(`RCYTrio v27-fixed listening on ${HOST}:${PORT}`));
