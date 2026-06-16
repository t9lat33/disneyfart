const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: 3001 });

const rooms = {};
const chatHistory = {}; // room -> [{ name, text, time }]

function broadcast(room, msg, exclude = null) {
  if (!rooms[room]) return;
  const raw = JSON.stringify(msg);
  rooms[room].forEach((info, ws) => {
    if (ws !== exclude && ws.readyState === 1) {
      try { ws.send(raw); } catch(e) {}
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

  console.log('New connection');

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      
      if (msg.type === 'join') {
        currentRoom = msg.room;
        myId = msg.id;
        myName = msg.name;
        
        if (!rooms[currentRoom]) {
          rooms[currentRoom] = new Map();
          chatHistory[currentRoom] = chatHistory[currentRoom] || [];
          console.log('Created room:', currentRoom);
        }
        
        rooms[currentRoom].set(ws, { id: myId, name: myName });
        console.log(`${myName} joined ${currentRoom}. Total: ${rooms[currentRoom].size}`);
        
        broadcast(currentRoom, { type: 'user-joined', id: myId, name: myName }, ws);
        ws.send(JSON.stringify({ type: 'room-users', users: roomList(currentRoom) }));
        
        // Send chat history
        if (chatHistory[currentRoom].length) {
          chatHistory[currentRoom].forEach(m => {
            try { ws.send(JSON.stringify({ type: 'chat', ...m })); } catch(e) {}
          });
        }
      }
      
      else if (msg.type === 'leave') {
        if (currentRoom && rooms[currentRoom]) {
          rooms[currentRoom].delete(ws);
          broadcast(currentRoom, { type: 'user-left', id: myId });
          if (rooms[currentRoom].size === 0) {
            delete rooms[currentRoom];
            delete chatHistory[currentRoom];
          }
          currentRoom = null;
        }
      }
      
      else if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
        if (!currentRoom || !rooms[currentRoom]) return;
        rooms[currentRoom].forEach((info, peer) => {
          if (info.id === msg.to && peer.readyState === 1 && peer !== ws) {
            try {
              peer.send(JSON.stringify({ ...msg, id: myId, name: myName }));
            } catch(e) {}
          }
        });
      }
      
      else if (msg.type === 'speaking') {
        broadcast(currentRoom, { type: 'speaking', id: myId, active: msg.active }, ws);
      }
      
      // TEXT CHAT
      else if (msg.type === 'chat') {
        if (!currentRoom || !msg.text) return;
        const chatMsg = { type: 'chat', name: myName, text: msg.text, time: msg.time || Date.now() };
        
        // Store in history (keep last 100)
        if (!chatHistory[currentRoom]) chatHistory[currentRoom] = [];
        chatHistory[currentRoom].push(chatMsg);
        if (chatHistory[currentRoom].length > 100) chatHistory[currentRoom].shift();
        
        // Broadcast to everyone in room
        broadcast(currentRoom, chatMsg);
      }
      
    } catch(e) {
      console.error('Error:', e.message);
    }
  });
  
  ws.on('close', () => {
    console.log(`${myName || 'Unknown'} disconnected`);
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].delete(ws);
      if (myId) broadcast(currentRoom, { type: 'user-left', id: myId });
      if (rooms[currentRoom].size === 0) {
        delete rooms[currentRoom];
        delete chatHistory[currentRoom];
      }
    }
  });
  
  ws.on('error', (e) => console.error('WS error:', e.message));
});

console.log('T9 Voice + Chat server running on port 3001');