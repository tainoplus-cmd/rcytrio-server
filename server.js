'use strict';
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const MAX_PLAYERS = 4;
const COLORS = ['red','blue','green','gold'];
const SIZES = ['S','M','L'];
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

const httpServer = http.createServer((req,res)=>{
  if(req.url === '/' || req.url === '/health' || req.url === '/status'){
    res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    res.end(JSON.stringify({ok:true,service:'RCYTrio Multiplayer Server',players:clients.size,rooms:rooms.size,queues:queueCount()}));
    return;
  }
  res.writeHead(404, {'content-type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Not found'}));
});

const wss = new WebSocketServer({server:httpServer});
const clients = new Set();
const queues = new Map(); // desired player count -> Set<Client>
const rooms = new Map();
const directory = new Map(); // fid -> {fid,name,av,cc,lastSeen}
const lanRooms = new Map();

function send(ws,msg){ if(ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room,msg){ for(const p of room.players) send(p.ws,msg); }
function queueCount(){ let n=0; for(const q of queues.values()) n+=q.size; return n; }
function makeId(){ return crypto.randomBytes(5).toString('hex'); }
function makeCode(){ let c; do c=String(Math.floor(100000+Math.random()*900000)); while(lanRooms.has(c)); return c; }
function cleanName(v){ return String(v||'Player').replace(/[<>]/g,'').slice(0,20) || 'Player'; }
function cleanAv(v){ const s=typeof v==='string'?v:''; return s.length<60000?s:null; }

function initialState(n){
  return {cells:Array.from({length:9},()=>({S:null,M:null,L:null})),turn:0,over:false,moves:[],stocks:Array.from({length:n},()=>({S:3,M:3,L:3}))};
}
function checkWin(cells,color){
  for(const line of LINES){
    for(const sz of SIZES){
      if(line.every(i=>cells[i][sz]===color)) return {type:'same-size',cellsHit:line.map(i=>({idx:i,size:sz}))};
    }
    for(const order of [['S','M','L'],['L','M','S']]){
      if(line.every((i,k)=>cells[i][order[k]]===color)) return {type:'sequence',cellsHit:line.map((i,k)=>({idx:i,size:order[k]}))};
    }
  }
  for(let i=0;i<9;i++){
    const c=cells[i];
    if(c.S===color&&c.M===color&&c.L===color) return {type:'concentric',cellsHit:[{idx:i,size:'S'},{idx:i,size:'M'},{idx:i,size:'L'}]};
  }
  return null;
}
function legalMoves(st,seat){
  const out=[]; const stock=st.stocks[seat];
  for(const sz of SIZES){ if(!(stock[sz]>0)) continue; for(let i=0;i<9;i++) if(!st.cells[i][sz]) out.push({idx:i,size:sz}); }
  return out;
}
function advanceTurn(room){
  const st=room.state, n=room.players.length;
  if(st.cells.every(c=>c.S&&c.M&&c.L) || st.stocks.every(x=>x.S+x.M+x.L===0)){ st.over=true; return; }
  for(let step=1;step<=n;step++){
    const s=(st.turn+step)%n;
    if(legalMoves(st,s).length){ st.turn=s; return; }
  }
  st.over=true;
}
function roomMatchPayload(room, me){
  return {
    type:'match', roomId:room.id, seat:me.seat,
    n:room.players.length,
    players:room.players.map(p=>({seat:p.seat,name:p.name,av:p.av,color:COLORS[p.seat]})),
    me:{seat:me.seat,name:me.name,av:me.av,color:COLORS[me.seat]},
    opponent:room.players.find(p=>p.seat!==me.seat)?{seat:room.players.find(p=>p.seat!==me.seat).seat,name:room.players.find(p=>p.seat!==me.seat).name,av:room.players.find(p=>p.seat!==me.seat).av,color:COLORS[room.players.find(p=>p.seat!==me.seat).seat]}:null,
    state:room.state
  };
}
function removeFromQueue(c){
  for(const q of queues.values()) q.delete(c);
  c.queue=null;
}
function tryMatch(n){
  const q=queues.get(n); if(!q || q.size<n) return;
  const chosen=[];
  for(const c of q){ if(c.ws.readyState===1 && !c.room) chosen.push(c); if(chosen.length===n) break; }
  if(chosen.length<n) return;
  chosen.forEach(c=>q.delete(c));
  const room={id:makeId(),players:[],state:initialState(n)};
  chosen.forEach((c,seat)=>{ c.room=room; c.queue=null; room.players.push({ws:c.ws,client:c,seat,name:c.name,av:c.av}); });
  rooms.set(room.id,room);
  for(const p of room.players) send(p.ws,roomMatchPayload(room,p));
  broadcast(room,{type:'state',state:room.state});
}
function handleMatchmake(c,msg){
  if(c.room) return send(c.ws,{type:'error',message:'Already in a match.'});
  removeFromQueue(c);
  let n=Number(msg.players||msg.mode||2); if(![2,3,4].includes(n)) n=2;
  if(!queues.has(n)) queues.set(n,new Set());
  c.queue=n; queues.get(n).add(c);
  send(c.ws,{type:'queue',position:queues.get(n).size,players:n});
  tryMatch(n);
}
function leaveRoom(c,notify=true){
  removeFromQueue(c);
  const room=c.room; if(!room) return;
  const p=room.players.find(x=>x.client===c); room.players=room.players.filter(x=>x.client!==c); c.room=null;
  if(notify) for(const x of room.players) send(x.ws,{type:'opponent_left'});
  if(room.players.length===0) rooms.delete(room.id);
}
function handleMove(c,m){
  const room=c.room; if(!room) return send(c.ws,{type:'error',message:'You are not in a match.'});
  const p=room.players.find(x=>x.client===c); const st=room.state;
  if(st.over) return;
  if(!p || st.turn!==p.seat) return send(c.ws,{type:'error',message:'Not your turn.'});
  const idx=Number(m.idx), size=String(m.size||'');
  if(!Number.isInteger(idx)||idx<0||idx>8||!SIZES.includes(size)) return send(c.ws,{type:'error',message:'Invalid move.'});
  if(st.cells[idx][size]) return send(c.ws,{type:'error',message:'That space is occupied.'});
  if(!(st.stocks[p.seat][size]>0)) return send(c.ws,{type:'error',message:'No pieces of that size left.'});
  st.cells[idx][size]=COLORS[p.seat]; st.stocks[p.seat][size]--; st.moves.push({i:idx,s:size,c:COLORS[p.seat],seat:p.seat});
  const win=checkWin(st.cells,COLORS[p.seat]);
  if(win){ st.over=true; broadcast(room,{type:'state',state:st,win:{winnerSeat:p.seat,data:win}}); return; }
  if(st.cells.every(x=>x.S&&x.M&&x.L)||st.stocks.every(x=>x.S+x.M+x.L===0)){ st.over=true; broadcast(room,{type:'state',state:st,win:{winnerSeat:-1}}); return; }
  advanceTurn(room);
  broadcast(room,{type:'state',state:st});
}
function handleChat(c,m,type){
  if(!c.room) return; const text=String(m.text||'').trim().slice(0,60); if(!text)return;
  const p=c.room.players.find(x=>x.client===c); broadcast(c.room,{type,seat:p?p.seat:0,[type==='chat'?'text':'index']:type==='chat'?text:Number(m.index)||0});
}

function registerDirectory(m){
  const fid=String(m.fid||'').slice(0,32); if(!fid)return null;
  const item={fid,name:cleanName(m.name),av:cleanAv(m.av),cc:String(m.cc||'').slice(0,8),lastSeen:Date.now()}; directory.set(fid,item); return item;
}
function dirFind(m){ const fid=String(m.fid||''); const u=directory.get(fid); return u?{...u}:null; }

function lanMembers(room){ return room.members.map((m,i)=>({seat:i,name:m.name,av:m.av,host:i===0})); }
function lanSendMembers(room){ for(let i=0;i<room.members.length;i++) send(room.members[i].ws,{type:'lan_members',members:lanMembers(room),you:i,room:room.name,code:room.code}); }
function lanRemove(c){
  const room=c.lanRoom; if(!room)return;
  room.members=room.members.filter(m=>m.ws!==c.ws); c.lanRoom=null;
  if(room.members.length===0){lanRooms.delete(room.code);return;}
  if(room.members[0].ws===c.ws) lanRooms.delete(room.code);
  else lanSendMembers(room);
}
function lanList(){ return [...lanRooms.values()].map(r=>({code:r.code,name:r.name,host:r.members[0]?.name||'Host',count:r.members.length})); }
function lanRelay(c,data){ const r=c.lanRoom; if(!r)return; for(const m of r.members) if(m.ws!==c.ws) send(m.ws,{type:'lan_data',data}); }

wss.on('connection',(ws,req)=>{
  const c={ws,name:'Player',av:null,queue:null,room:null,lanRoom:null}; clients.add(c);
  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw.toString())}catch(_){return send(ws,{type:'error',message:'Invalid JSON.'});}
    switch(m.type){
      case 'hello': c.name=cleanName(m.name); c.av=cleanAv(m.av); break;
      case 'matchmake': handleMatchmake(c,m); break;
      case 'cancel_matchmaking': removeFromQueue(c); send(ws,{type:'queue_cancelled'}); break;
      case 'move': handleMove(c,m); break;
      case 'chat': handleChat(c,m,'chat'); break;
      case 'reaction': handleChat(c,m,'reaction'); break;
      case 'leave_room': leaveRoom(c,true); break;
      case 'dir_register': {const u=registerDirectory(m); send(ws,{type:'dir_registered',user:u});break;}
      case 'dir_find': {const u=dirFind(m); send(ws,u?{type:'dir_found',user:u}:{type:'dir_not_found'});break;}
      case 'lan_create': {
        if(c.lanRoom) lanRemove(c); const room={code:makeCode(),name:cleanName(m.room),members:[]}; lanRooms.set(room.code,room); room.members.push({ws,name:cleanName(m.name||c.name),av:cleanAv(m.av)}); c.lanRoom=room; send(ws,{type:'lan_created',code:room.code,room:room.name}); lanSendMembers(room); break;
      }
      case 'lan_list': send(ws,{type:'lan_rooms',rooms:lanList()}); break;
      case 'lan_join': {
        const room=lanRooms.get(String(m.code||'')); if(!room)return send(ws,{type:'lan_error',message:'Room not found.'}); if(room.members.length>=MAX_PLAYERS)return send(ws,{type:'lan_error',message:'Room is full.'});
        if(c.lanRoom) lanRemove(c); room.members.push({ws,name:cleanName(m.name||c.name),av:cleanAv(m.av)}); c.lanRoom=room; send(ws,{type:'lan_joined',code:room.code,room:room.name}); lanSendMembers(room); break;
      }
      case 'lan_leave': lanRemove(c); break;
      case 'lan_kick': {
        const r=c.lanRoom; if(!r||r.members[0]?.ws!==ws)break; const seat=Number(m.seat); const victim=r.members[seat]; if(victim){victim.ws.send(JSON.stringify({type:'lan_kicked'})); victim.lanRoom=null; r.members.splice(seat,1); lanSendMembers(r);} break;
      }
      case 'lan_relay': lanRelay(c,m.data); break;
      default: send(ws,{type:'error',message:'Unknown message type: '+m.type});
    }
  });
  ws.on('close',()=>{ leaveRoom(c,true); lanRemove(c); clients.delete(c); });
  ws.on('error',()=>{});
});

setInterval(()=>{
  const now=Date.now(); for(const [fid,u] of directory) if(now-u.lastSeen>120000) directory.delete(fid);
  for(const [n,q] of queues) { for(const c of q) if(c.ws.readyState!==1) q.delete(c); tryMatch(n); }
},5000);

httpServer.listen(PORT,'0.0.0.0',()=>console.log(`RCYTrio server listening on 0.0.0.0:${PORT}`));
