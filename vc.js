const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: 3001 });
const rooms = {};

wss.on('connection', ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      const room = msg.room || 'default';
      if (!rooms[room]) rooms[room] = new Set();
      rooms[room].add(ws);
      rooms[room].forEach(peer => {
        if (peer !== ws && peer.readyState === 1) peer.send(raw);
      });
    } catch {}
  });
  ws.on('close', () => {
    for (const r of Object.values(rooms)) r.delete(ws);
  });
});

console.log('VC signaling running on :3001');