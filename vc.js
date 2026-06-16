const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: 3001 });

// rooms[roomName] = Map<ws, { id, name }>
const rooms = {};

function broadcast(room, msg, exclude = null) {
  if (!rooms[room]) return;
  const raw = JSON.stringify(msg);
  rooms[room].forEach((info, ws) => {
    if (ws !== exclude && ws.readyState === 1) {
      try {
        ws.send(raw);
      } catch(e) {
        console.error('Broadcast send error:', e.message);
      }
    }
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

  console.log('New client connected');

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log('Received:', msg.type, 'from:', msg.id, 'room:', msg.room);

      if (msg.type === 'join') {
        currentRoom = msg.room;
        myId = msg.id;
        myName = msg.name;
        
        if (!rooms[currentRoom]) {
          rooms[currentRoom] = new Map();
          console.log('Created new room:', currentRoom);
        }
        
        // Store user info
        rooms[currentRoom].set(ws, { id: myId, name: myName });
        console.log(`${myName} (${myId}) joined room ${currentRoom}. Total users: ${rooms[currentRoom].size}`);
        
        // Tell everyone else someone joined
        broadcast(currentRoom, { type: 'user-joined', id: myId, name: myName }, ws);
        
        // Send the new user the current member list
        const users = roomList(currentRoom);
        ws.send(JSON.stringify({ type: 'room-users', users: users }));
        console.log('Sent room-users to', myName, ':', users.length, 'users');
      }

      else if (msg.type === 'leave') {
        if (currentRoom && rooms[currentRoom]) {
          rooms[currentRoom].delete(ws);
          console.log(`${myName} (${myId}) left room ${currentRoom}. Remaining: ${rooms[currentRoom].size}`);
          
          broadcast(currentRoom, { type: 'user-left', id: myId });
          
          if (rooms[currentRoom].size === 0) {
            delete rooms[currentRoom];
            console.log('Deleted empty room:', currentRoom);
          }
          
          currentRoom = null;
          myId = null;
          myName = null;
        }
      }

      // WebRTC signaling — relay to specific peer
      else if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
        if (!currentRoom || !rooms[currentRoom]) {
          console.log('Signaling message but no room, ignoring');
          return;
        }
        
        let relayed = false;
        rooms[currentRoom].forEach((info, peer) => {
          if (info.id === msg.to && peer.readyState === 1 && peer !== ws) {
            try {
              // Add sender info
              const relayMsg = { ...msg, id: myId, name: myName };
              peer.send(JSON.stringify(relayMsg));
              relayed = true;
              console.log(`Relayed ${msg.type} from ${myId} to ${msg.to}`);
            } catch(e) {
              console.error('Relay send error:', e.message);
            }
          }
        });
        
        if (!relayed) {
          console.log(`Could not relay ${msg.type} to ${msg.to} - user not found or disconnected`);
        }
      }

      // speaking indicator
      else if (msg.type === 'speaking') {
        broadcast(currentRoom, { type: 'speaking', id: myId, active: msg.active }, ws);
      }

    } catch(e) {
      console.error('Message processing error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected:', myId, myName);
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].delete(ws);
      console.log(`${myName || 'Unknown'} (${myId || 'Unknown'}) disconnected from room ${currentRoom}. Remaining: ${rooms[currentRoom].size}`);
      
      if (myId) {
        broadcast(currentRoom, { type: 'user-left', id: myId });
      }
      
      if (rooms[currentRoom].size === 0) {
        delete rooms[currentRoom];
        console.log('Deleted empty room:', currentRoom);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

wss.on('error', (err) => {
  console.error('Server error:', err);
});

console.log('VC signaling server running on port 3001');