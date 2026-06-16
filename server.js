const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/chat.html') {
    fs.readFile(path.join(__dirname, 'chat.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server });

// ── TEXT CHAT state ──
const textClients = new Map();
const MESSAGE_HISTORY_LIMIT = 50;
const messageHistory = [];
let userIdCounter = 1;

const COLORS = [
  '#7289da','#43b581','#faa61a','#f47fff','#ed4245',
  '#5865f2','#00b0f4','#57f287','#feb132','#eb459e'
];

// ── VOICE CHAT state ──
const voiceRooms = {};
const voiceUsers = new Map(); // ws -> { id, name, room }

function getTextUsers() {
  return [...textClients.values()].map(c => ({
    id: c.id,
    username: c.username,
    color: c.color
  }));
}

wss.on('connection', (ws, req) => {
  // ── TEXT CHAT setup ──
  const id = userIdCounter++;
  const color = COLORS[(id - 1) % COLORS.length];
  const textClient = { id, username: `User${id}`, color, ws };
  textClients.set(ws, textClient);

  // Send init data
  ws.send(JSON.stringify({
    type: 'init',
    userId: id,
    color,
    history: messageHistory,
    users: getTextUsers(),
    onlineCount: textClients.size
  }));

  // Broadcast join
  wss.clients.forEach(c => {
    if (c !== ws && c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify({
        type: 'user_join',
        userId: id,
        username: textClient.username,
        color,
        users: getTextUsers(),
        onlineCount: textClients.size
      }));
    }
  });

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    const client = textClients.get(ws);

    // ── TEXT CHAT messages ──
    if (data.type === 'set_username') {
      const newName = String(data.username || '').trim().slice(0, 32);
      if (!newName) return;
      const oldName = client.username;
      client.username = newName;
      
      // Also update voice user if in a room
      const vu = voiceUsers.get(ws);
      if (vu) vu.name = newName;
      
      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({
            type: 'rename',
            userId: client.id,
            oldName,
            newName,
            users: getTextUsers(),
            onlineCount: textClients.size
          }));
        }
      });
    }

    else if (data.type === 'message') {
      const content = String(data.content || '').trim().slice(0, 2000);
      if (!content) return;

      const msg = {
        type: 'message',
        id: Date.now() + '-' + client.id,
        userId: client.id,
        username: client.username,
        color: client.color,
        content,
        timestamp: Date.now()
      };

      messageHistory.push(msg);
      if (messageHistory.length > MESSAGE_HISTORY_LIMIT) messageHistory.shift();

      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify(msg));
        }
      });
    }

    // ── VOICE CHAT messages ──
    else if (data.type === 'voice_join') {
      const room = data.room || 'general';
      const name = client.username;
      const uid = 'v_' + client.id;
      
      if (!voiceRooms[room]) voiceRooms[room] = new Map();
      voiceRooms[room].set(ws, { id: uid, name });
      voiceUsers.set(ws, { id: uid, name, room });
      
      // Send current room users to the joiner
      const roomUsers = [...voiceRooms[room].values()].map(u => ({ id: u.id, name: u.name }));
      ws.send(JSON.stringify({ type: 'voice_users', room, users: roomUsers }));
      
      // Tell others in room
      voiceRooms[room].forEach((info, peer) => {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ type: 'voice_user_joined', id: uid, name, room }));
        }
      });
    }

    else if (data.type === 'voice_leave') {
      const vu = voiceUsers.get(ws);
      if (vu && voiceRooms[vu.room]) {
        voiceRooms[vu.room].delete(ws);
        voiceRooms[vu.room].forEach((info, peer) => {
          if (peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({ type: 'voice_user_left', id: vu.id, room: vu.room }));
          }
        });
        if (voiceRooms[vu.room].size === 0) delete voiceRooms[vu.room];
      }
      voiceUsers.delete(ws);
    }

    // WebRTC signaling relay
    else if (data.type === 'voice_offer' || data.type === 'voice_answer' || data.type === 'voice_ice') {
      const vu = voiceUsers.get(ws);
      if (!vu || !voiceRooms[vu.room]) return;
      
      voiceRooms[vu.room].forEach((info, peer) => {
        if (info.id === data.to && peer.readyState === WebSocket.OPEN && peer !== ws) {
          peer.send(JSON.stringify({
            ...data,
            from: vu.id,
            fromName: vu.name
          }));
        }
      });
    }

    else if (data.type === 'voice_speaking') {
      const vu = voiceUsers.get(ws);
      if (vu && voiceRooms[vu.room]) {
        voiceRooms[vu.room].forEach((info, peer) => {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({
              type: 'voice_speaking',
              id: vu.id,
              active: data.active
            }));
          }
        });
      }
    }
  });

  ws.on('close', () => {
    // Clean up text chat
    textClients.delete(ws);
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) {
        c.send(JSON.stringify({
          type: 'user_leave',
          userId: textClient.id,
          username: textClient.username,
          users: getTextUsers(),
          onlineCount: textClients.size
        }));
      }
    });

    // Clean up voice
    const vu = voiceUsers.get(ws);
    if (vu && voiceRooms[vu.room]) {
      voiceRooms[vu.room].delete(ws);
      voiceRooms[vu.room].forEach((info, peer) => {
        if (peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ type: 'voice_user_left', id: vu.id, room: vu.room }));
        }
      });
      if (voiceRooms[vu.room].size === 0) delete voiceRooms[vu.room];
    }
    voiceUsers.delete(ws);
  });

  ws.on('error', () => {
    textClients.delete(ws);
    voiceUsers.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`T9 Chat + Voice running on port ${PORT}`);
});