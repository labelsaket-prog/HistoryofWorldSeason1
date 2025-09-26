
// server.js - Node.js + Express + Socket.IO game server (simple, in-memory + users file persistence)
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = {};
if (fs.existsSync(USERS_FILE)) {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE)); } catch(e){ users = {}; }
}

function saveUsers(){ fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));
app.use(express.json());

// Simple in-memory rooms and gameState per room
let rooms = {}; // roomId -> {id, owner, players: {username->info}, factions:{...}, state, settings}

// helper: create room id
function makeRoomId(){ return Math.random().toString(36).substr(2,6).toUpperCase(); }

// API: register/login via REST for convenience
app.post('/api/register', (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({error:'username/password required'});
  if(users[username]) return res.status(409).json({error:'exists'});
  const hash = bcrypt.hashSync(password, 10);
  users[username] = { username, hash };
  saveUsers();
  return res.json({ok:true});
});

app.post('/api/login', (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({error:'username/password required'});
  const u = users[username];
  if(!u) return res.status(404).json({error:'notfound'});
  if(!bcrypt.compareSync(password, u.hash)) return res.status(401).json({error:'badpass'});
  return res.json({ok:true});
});

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  socket.on('createRoom', ({username}) => {
    const roomId = makeRoomId();
    rooms[roomId] = {
      id: roomId,
      owner: username,
      players: {}, // map username->info {username, socketId, role, seat}
      factions: { 'عیلام':[], 'کاسپی':[], 'کاسی':[], 'پارس':[], 'پارت':[], 'ماد':[] },
      state: 'waiting', // waiting|running|stopped
      settings: { maxPerFaction:3, minToStart:6 }
    };
    socket.join(roomId);
    rooms[roomId].players[username] = { username, socketId: socket.id, role:null, seat:null };
    socket.emit('roomCreated', { roomId });
    io.to(roomId).emit('roomUpdate', rooms[roomId]);
    console.log('room created', roomId, 'by', username);
  });

  socket.on('joinRoom', ({username, roomId}) => {
    const room = rooms[roomId];
    if(!room) { socket.emit('joinResult', { error: 'Room not found' }); return; }
    const totalPlayers = Object.keys(room.players).length;
    if(totalPlayers >= 12) { socket.emit('joinResult', { error:'room full' }); return; }
    room.players[username] = { username, socketId: socket.id, role:null, seat:null };
    socket.join(roomId);
    socket.emit('joinResult', { ok:true, roomId });
    io.to(roomId).emit('roomUpdate', room);
    console.log(username, 'joined', roomId);
  });

  socket.on('requestAssignRole', ({roomId, adminUsername, targetUsername, faction, positionIndex}) => {
    const room = rooms[roomId];
    if(!room) return;
    if(room.owner !== adminUsername) { socket.emit('msg', 'not owner'); return; }
    const factionPlayers = room.factions[faction] || [];
    if(factionPlayers.length >= room.settings.maxPerFaction) { socket.emit('msg','faction full'); return; }
    room.factions[faction].push(targetUsername);
    if(room.players[targetUsername]) {
      room.players[targetUsername].role = faction; room.players[targetUsername].seat = factionPlayers.length; 
      const s = io.sockets.sockets.get(room.players[targetUsername].socketId);
      if(s) s.emit('roleAssigned', { faction, seat: room.players[targetUsername].seat });
    }
    io.to(roomId).emit('roomUpdate', room);
  });

  socket.on('startGame', ({roomId, username})=>{
    const room = rooms[roomId]; if(!room) return;
    if(room.owner !== username) { socket.emit('msg','only owner can start'); return; }
    if(Object.keys(room.players).length < room.settings.minToStart){ socket.emit('msg','not enough players to start'); return; }
    room.state = 'running';
    room.gameState = { playersData: {}, nodes: generateNodes(), movements: [], alliances: {}, timestamps: Date.now() };
    Object.keys(room.players).forEach(un=>{
      room.gameState.playersData[un] = {
        username: un, role: room.players[un].role || null, pop: 10, food: 20, soldiers: 4, cavalry:1, archers:2,
        spies:4, guards: (room.players[un].role && isCivil(room.players[un].role))?8:0, dogs: (room.players[un].role && isTribe(room.players[un].role))?30:0,
        resources: { زره:2,شمشیر:3,کمان:2,تیر:10,نقره:2,سنگ:10,آهن:3,طلا:1,چوب:15,گندم:20,گوشت:10,برنج:5,پارچه:2,گوسفند:5,گاو:2},
        level:1, progress:0, academy:false, growthModifier:1.0, lastGrowthChange: null
      };
    });
    io.to(roomId).emit('gameStarted', room.gameState);
    io.to(roomId).emit('roomUpdate', room);
    console.log('game started in room', roomId);
  });

  socket.on('stopGame', ({roomId, username})=>{
    const room = rooms[roomId]; if(!room) return;
    if(room.owner !== username) { socket.emit('msg','only owner'); return; }
    room.state = 'stopped';
    io.to(roomId).emit('roomUpdate', room);
  });

  socket.on('action', ({roomId, username, action, params})=>{
    const room = rooms[roomId]; if(!room || room.state!=='running') return;
    const gs = room.gameState;
    if(action==='gather'){
      const {nodeId, units} = params;
      const node = gs.nodes.find(n=>n.id===nodeId);
      if(!node) return;
      const from = gs.playersData[username];
      if(!from) return;
      if(from.soldiers < units) { io.to(room.players[username].socketId).emit('msg','not enough soldiers'); return; }
      const travelMs = Math.max(2000, Math.floor(node.dist * 80));
      const arrive = Date.now() + travelMs*2;
      gs.movements.push({id: uuidv4(), type:'gather', from:username, nodeId, units, arriveAt: arrive});
      from.soldiers -= units;
      io.to(roomId).emit('state', gs);
    } else if(action==='march'){
      const {targetUsername, units} = params;
      const from = gs.playersData[username]; const target = gs.playersData[targetUsername];
      if(!from||!target) return;
      const travelMs = Math.max(2000, Math.floor(200 * 100));
      gs.movements.push({id: uuidv4(), type:'march', from:username, to:targetUsername, units, arriveAt: Date.now()+travelMs});
      from.soldiers = Math.max(0, from.soldiers - units);
      io.to(roomId).emit('state', gs);
    } else if(action==='spy'){
      const {targetUsername} = params;
      const from = gs.playersData[username]; const target = gs.playersData[targetUsername];
      if(!from||!target) return;
      if(from.spies <=0) { io.to(room.players[username].socketId).emit('msg','no spies'); return; }
      from.spies -=1;
      const caught = Math.random() < 0.2;
      setTimeout(()=>{
        if(caught){ io.to(room.players[username].socketId).emit('spyResult',{ok:false,reason:'caught'}); }
        else {
          const info = {pop: target.pop, soldiers: target.soldiers};
          io.to(room.players[username].socketId).emit('spyResult',{ok:true,info});
        }
      }, 2000);
    } else if(action==='upgrade'){
      const {username: u, unit} = params;
      const p = gs.playersData[u];
      if(!p) return;
      if(p.food < 10) { io.to(room.players[u].socketId).emit('msg','not enough food'); return; }
      p.food -= 10;
      if(unit==='soldier') p.soldiers +=1;
      if(unit==='cavalry') p.cavalry = (p.cavalry||0)+1;
      if(unit==='archer') p.archers = (p.archers||0)+1;
      io.to(roomId).emit('state', gs);
    }
  });

  socket.on('chat', ({roomId, username, channel, to, text})=>{
    const room = rooms[roomId]; if(!room) return;
    const msg = {ts: Date.now(), from: username, channel, to, text};
    if(channel==='global') io.to(roomId).emit('chat', msg);
    else if(channel==='alliance') io.to(roomId).emit('chat', msg);
    else if(channel==='private'){
      const dest = room.players[to];
      if(dest && dest.socketId) io.to(dest.socketId).emit('chat', msg);
      io.to(room.players[username].socketId).emit('chat', msg);
    }
  });

  socket.on('disconnect', ()=>{ console.log('disconnect', socket.id); });
});

function isCivil(role){ return ['عیلام','کاسپی','کاسی'].includes(role); }
function isTribe(role){ return ['پارس','پارت','ماد'].includes(role); }

function generateNodes(){
  return [
    {id:'node1', type:'معدن سنگ', dist:120, rate:5},
    {id:'node2', type:'معدن آهن', dist:200, rate:4},
    {id:'node3', type:'جنگل', dist:300, rate:6},
    {id:'node4', type:'مزرعه', dist:260, rate:7},
    {id:'node5', type:'معدن طلا', dist:180, rate:2}
  ];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('Server listening on', PORT));
