const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: 3001 });

// rooms[roomName] = Map<ws, { id, name }>
const rooms = {};

function broadcast(room, msg, exclude = null) {
  if (!rooms[room]) return;
  const raw = JSON.stringify(msg);
  rooms[room].forEach((info, ws) => {
    if (ws !== exclude && ws.readyState === 1) ws.send(raw);
  });
}

function roomList(room) {
  if (!rooms[room]) return [];
  return [...rooms[room].values()].map(u => ({ id: u.id, name: u.name }));
}

wss.on('connection', ws => {
  let currentRoom = null;
  let myId = null;
  let myName = null;

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'join') {
        currentRoom = msg.room;
        myId = msg.id;
        myName = msg.name;
        if (!rooms[currentRoom]) rooms[currentRoom] = new Map();
        rooms[currentRoom].set(ws, { id: myId, name: myName });
        // tell everyone else someone joined
        broadcast(currentRoom, { type: 'user-joined', id: myId, name: myName }, ws);
        // send the new user the current member list
        ws.send(JSON.stringify({ type: 'room-users', users: roomList(currentRoom) }));
      }

      else if (msg.type === 'leave') {
        if (currentRoom && rooms[currentRoom]) {
          rooms[currentRoom].delete(ws);
          broadcast(currentRoom, { type: 'user-left', id: myId });
          if (rooms[currentRoom].size === 0) delete rooms[currentRoom];
          currentRoom = null;
        }
      }

      // WebRTC signaling — relay to specific peer
      else if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
        if (!currentRoom || !rooms[currentRoom]) return;
        rooms[currentRoom].forEach((info, peer) => {
          if (info.id === msg.to && peer.readyState === 1) peer.send(raw);
        });
      }

      // speaking indicator
      else if (msg.type === 'speaking') {
        broadcast(currentRoom, { type: 'speaking', id: myId, active: msg.active }, ws);
      }

    } catch {}
  });

  ws.on('close', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].delete(ws);
      broadcast(currentRoom, { type: 'user-left', id: myId });
      if (rooms[currentRoom].size === 0) delete rooms[currentRoom];
    }
  });
});

console.log('VC signaling running on :3001');