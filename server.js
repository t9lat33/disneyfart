const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

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

const clients = new Map();
const MESSAGE_HISTORY_LIMIT = 50;
const messageHistory = [];

let userIdCounter = 1;

const COLORS = [
  '#7289da','#43b581','#faa61a','#f47fff','#ed4245',
  '#5865f2','#00b0f4','#57f287','#feb132','#eb459e'
];

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function getOnlineCount() {
  return [...wss.clients].filter(ws => ws.readyState === WebSocket.OPEN).length;
}

function getUserList() {
  return [...clients.values()].map(c => ({
    id: c.id,
    username: c.username,
    color: c.color,
    avatar: c.avatar
  }));
}

wss.on('connection', (ws, req) => {
  const id = userIdCounter++;
  const color = COLORS[(id - 1) % COLORS.length];

  const clientData = {
    id,
    username: `User${id}`,
    color,
    avatar: null,
    ws
  };

  clients.set(ws, clientData);

  ws.send(JSON.stringify({
    type: 'init',
    userId: id,
    color,
    history: messageHistory,
    users: getUserList(),
    onlineCount: getOnlineCount()
  }));

  broadcast({
    type: 'user_join',
    userId: id,
    username: clientData.username,
    color,
    users: getUserList(),
    onlineCount: getOnlineCount()
  }, ws);

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    const client = clients.get(ws);
    if (!client) return;

    if (data.type === 'set_username') {
      const newName = String(data.username || '').trim().slice(0, 32);
      if (!newName) return;
      const oldName = client.username;
      client.username = newName;
      broadcastAll({
        type: 'rename',
        userId: client.id,
        oldName,
        newName,
        users: getUserList(),
        onlineCount: getOnlineCount()
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

      broadcastAll(msg);
    }

    else if (data.type === 'typing') {
      broadcast({
        type: 'typing',
        userId: client.id,
        username: client.username,
        isTyping: !!data.isTyping
      }, ws);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;
    clients.delete(ws);
    broadcast({
      type: 'user_leave',
      userId: client.id,
      username: client.username,
      users: getUserList(),
      onlineCount: getOnlineCount()
    });
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`T9 Chat running on port ${PORT}`);
});