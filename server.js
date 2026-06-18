const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 't9_data.json');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/chat.html') {
    fs.readFile(path.join(__dirname, 'chat.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server });

let userIdCounter = 1;
const COLORS = ['#7289da','#43b581','#faa61a','#f47fff','#ed4245','#5865f2','#00b0f4','#57f287','#feb132','#eb459e'];
const clients = new Map();
const servers = new Map();
const channelMessages = new Map();
const dmMessages = new Map(); // userId|userId -> [messages]

function uid() { return Math.random().toString(36).slice(2, 10); }
function inviteCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

function dmKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function makeServer(name, icon, ownerId) {
  const id = uid();
  const srv = {
    id, name, icon: icon || null,
    ownerId,
    inviteCode: inviteCode(),
    members: [ownerId],
    channels: [
      { id: uid(), name: 'general', type: 'text' },
      { id: uid(), name: 'off-topic', type: 'text' },
      { id: uid(), name: 'General', type: 'voice' },
      { id: uid(), name: 'Gaming', type: 'voice' },
    ],
    voiceState: {}
  };
  servers.set(id, srv);
  saveData();
  return srv;
}

function getClient(ws) { return clients.get(ws); }

function broadcast(data, filter) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (filter && !filter(getClient(ws))) return;
    ws.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getOnlineUsers() {
  const out = {};
  clients.forEach(c => { out[c.id] = { id: c.id, username: c.username, color: c.color, avatar: c.avatar || null }; });
  return out;
}

function serializeServer(srv) {
  return {
    id: srv.id,
    name: srv.name,
    icon: srv.icon,
    ownerId: srv.ownerId,
    inviteCode: srv.inviteCode,
    members: srv.members,
    channels: srv.channels.map(ch => ({
      ...ch,
      users: ch.type === 'voice' ? (srv.voiceState[ch.id] || []).map(uid => {
        const c = [...clients.values()].find(x => x.id === uid);
        return c ? { id: c.id, username: c.username } : { id: uid, username: 'Unknown' };
      }) : undefined
    }))
  };
}

function getUserServers(userId) {
  const out = {};
  servers.forEach((srv, id) => {
    if (srv.members.includes(userId)) out[id] = serializeServer(srv);
  });
  return out;
}

let saveTimeout = null;
function saveData() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const data = { servers: {}, dms: {}, userIdCounter };
    servers.forEach((srv, id) => {
      data.servers[id] = {
        id: srv.id, name: srv.name, icon: srv.icon,
        ownerId: srv.ownerId, inviteCode: srv.inviteCode,
        members: srv.members, channels: srv.channels
      };
    });
    dmMessages.forEach((msgs, key) => {
      data.dms[key] = msgs;
    });
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch(e) { console.error('Save error:', e); }
    saveTimeout = null;
  }, 500);
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      userIdCounter = data.userIdCounter || 1;
      if (data.servers) {
        Object.entries(data.servers).forEach(([id, srv]) => {
          srv.voiceState = {};
          servers.set(id, srv);
        });
      }
      if (data.dms) {
        Object.entries(data.dms).forEach(([key, msgs]) => {
          dmMessages.set(key, msgs);
        });
      }
      console.log(`Loaded ${servers.size} servers and ${dmMessages.size} DM histories`);
    }
  } catch(e) { console.error('Load error:', e); }
}

wss.on('connection', (ws) => {
  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);
    
    // Handle init separately to establish identity before processing other messages
    if (data.type === 'init' && !client) {
      handleInit(ws, data);
    } else if (client) {
      handleMessage(ws, client, data);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;
    
    if (client.voiceChannel) leaveVoice(client);
    if (client.dmVoicePeer) {
      const peer = [...clients.values()].find(c => c.id === client.dmVoicePeer);
      if (peer) { sendTo(peer.ws, { type: 'dm_voice_end', from: client.id }); peer.dmVoicePeer = null; }
    }
    clients.delete(ws);
    broadcast({ type: 'user_leave', userId: client.id }, c => c.id !== client.id);
  });
});

function handleInit(ws, data) {
  let id = data.clientId || uid();
  const color = COLORS[Math.abs(hashString(id)) % COLORS.length];
  const client = {
    id, ws, 
    username: data.username ? String(data.username).slice(0, 32) : `User${id.slice(0,4)}`,
    color, avatar: data.avatar || null,
    currentChannel: null, voiceChannel: null, dmVoicePeer: null,
  };
  clients.set(ws, client);

  const dmHistory = {};
  dmMessages.forEach((msgs, key) => {
    const [a, b] = key.split('|');
    if (a == client.id || b == client.id) {
      const otherId = a == client.id ? b : a;
      dmHistory[otherId] = msgs;
    }
  });

  sendTo(ws, {
    type: 'init', id: client.id,
    username: client.username, color: client.color, avatar: client.avatar,
    servers: getUserServers(client.id),
    onlineUsers: getOnlineUsers(),
    dmHistory
  });
  
  broadcast({ type: 'user_join', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar } }, c => c.id !== client.id);
}

function handleMessage(ws, client, data) {
  switch (data.type) {
    case 'update_profile':
      if (data.username) client.username = String(data.username).slice(0, 32);
      if (data.avatar !== undefined) client.avatar = data.avatar;
      broadcast({ type: 'user_updated', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar } });
      break;

    case 'chat': {
      const { serverId, channelId, content } = data;
      if (!serverId || !channelId || !content) return;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      const ch = srv.channels.find(c => c.id === channelId);
      if (!ch || ch.type !== 'text') return;
      const msg = {
        type: 'chat', id: uid(),
        userId: client.id, username: client.username, color: client.color, avatar: client.avatar,
        serverId, channelId,
        content: String(content).slice(0, 2000), timestamp: Date.now()
      };
      if (!channelMessages.has(channelId)) channelMessages.set(channelId, []);
      const hist = channelMessages.get(channelId);
      hist.push(msg); if (hist.length > 100) hist.shift();
      clients.forEach(c => {
        if (srv.members.includes(c.id) && c.currentChannel?.channelId === channelId) sendTo(c.ws, msg);
      });
      break;
    }

    case 'dm': {
      const { to, content } = data;
      if (!to || !content) return;
      const toClient = [...clients.values()].find(c => c.id === to);
      const msg = {
        type: 'dm', id: uid(), from: client.id, to,
        userId: client.id, username: client.username, color: client.color, avatar: client.avatar,
        content: String(content).slice(0, 2000), timestamp: Date.now()
      };
      const key = dmKey(client.id, to);
      if (!dmMessages.has(key)) dmMessages.set(key, []);
      dmMessages.get(key).push(msg);
      saveData(); // Save DMs to disk
      
      sendTo(ws, msg);
      if (toClient) sendTo(toClient.ws, msg);
      break;
    }

    case 'join_channel': {
      const { serverId, channelId } = data;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      const ch = srv.channels.find(c => c.id === channelId);
      if (!ch) return;
      client.currentChannel = { serverId, channelId };
      const hist = channelMessages.get(channelId) || [];
      hist.forEach(msg => sendTo(ws, msg));
      break;
    }

    case 'create_server': {
      const { name, icon } = data;
      if (!name?.trim()) return;
      const srv = makeServer(name.trim().slice(0, 100), icon || null, client.id);
      sendTo(ws, { type: 'server_created', server: serializeServer(srv) });
      break;
    }

    case 'update_server': {
      const { serverId, name, icon } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      if (name) srv.name = name.slice(0, 100);
      if (icon !== undefined) srv.icon = icon;
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'delete_server': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      servers.delete(serverId);
      broadcast({ type: 'server_deleted', serverId }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'join_server': {
      const { inviteCode: code } = data;
      if (!code) return;
      const srv = [...servers.values()].find(s => s.inviteCode === code.toUpperCase());
      if (!srv) { sendTo(ws, { type: 'error', message: 'Invalid invite code.' }); return; }
      if (srv.members.includes(client.id)) { sendTo(ws, { type: 'error', message: 'Already in that server.' }); return; }
      srv.members.push(client.id);
      sendTo(ws, { type: 'server_joined', server: serializeServer(srv) });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id) && c.id !== client.id);
      saveData();
      break;
    }

    case 'leave_server': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      if (srv.ownerId === client.id) { sendTo(ws, { type: 'error', message: 'Owners cannot leave.' }); return; }
      srv.members = srv.members.filter(id => id !== client.id);
      sendTo(ws, { type: 'server_left', serverId });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'kick_member': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      if (userId === client.id) return;
      srv.members = srv.members.filter(id => id !== userId);
      const target = [...clients.values()].find(c => c.id === userId);
      if (target) sendTo(target.ws, { type: 'kicked', serverId });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_channel': {
      const { serverId, channelType, name } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      if (!['text','voice'].includes(channelType)) return;
      const ch = { id: uid(), name: name.slice(0, 50), type: channelType };
      srv.channels.push(ch);
      broadcast({ type: 'channel_added', serverId, channel: ch }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_channel': {
      const { serverId, channelId } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      srv.channels = srv.channels.filter(c => c.id !== channelId);
      broadcast({ type: 'channel_removed', serverId, channelId }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'regenerate_invite': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      srv.inviteCode = inviteCode();
      broadcast({ type: 'invite_regenerated', serverId, inviteCode: srv.inviteCode }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'voice_join': {
      const { serverId, channelId } = data;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      const ch = srv.channels.find(c => c.id === channelId && c.type === 'voice');
      if (!ch) return;
      if (client.voiceChannel) leaveVoice(client);
      if (!srv.voiceState[channelId]) srv.voiceState[channelId] = [];
      srv.voiceState[channelId].push(client.id);
      client.voiceChannel = { serverId, channelId };
      const users = srv.voiceState[channelId].filter(id => id !== client.id).map(id => ({ id }));
      sendTo(ws, { type: 'voice_users', users });
      broadcast({ type: 'voice_user_joined', userId: client.id, serverId, channelId }, c => srv.members.includes(c.id) && c.id !== client.id);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      break;
    }

    case 'voice_leave':
      leaveVoice(client);
      break;

    case 'voice_offer':
    case 'voice_answer':
    case 'voice_ice': {
      const target = [...clients.values()].find(c => c.id === data.to);
      if (target) sendTo(target.ws, { ...data, from: client.id });
      break;
    }

    case 'voice_speaking': {
      if (!client.voiceChannel && !client.dmVoicePeer) return;
      if (client.voiceChannel) {
        const { serverId, channelId } = client.voiceChannel;
        const srv = servers.get(serverId);
        if (!srv) return;
        broadcast({ type: 'voice_speaking', userId: client.id, active: data.active }, c => srv.members.includes(c.id) && c.id !== client.id);
      } else if (client.dmVoicePeer) {
        const target = [...clients.values()].find(c => c.id === client.dmVoicePeer);
        if (target) sendTo(target.ws, { type: 'voice_speaking', userId: client.id, active: data.active });
      }
      break;
    }

    // DM Voice
    case 'dm_voice_start': {
      const target = [...clients.values()].find(c => c.id === data.to);
      if (!target || target.dmVoicePeer || target.voiceChannel) {
        sendTo(ws, { type: 'dm_voice_decline', from: data.to });
        return;
      }
      client.dmVoicePeer = data.to;
      target.dmVoicePeer = client.id;
      sendTo(target.ws, { type: 'dm_voice_start', from: client.id });
      break;
    }

    case 'dm_voice_end': {
      if (client.dmVoicePeer) {
        const peer = [...clients.values()].find(c => c.id === client.dmVoicePeer);
        if (peer) { sendTo(peer.ws, { type: 'dm_voice_end', from: client.id }); peer.dmVoicePeer = null; }
        client.dmVoicePeer = null;
      }
      break;
    }

    case 'dm_voice_decline': {
      const target = [...clients.values()].find(c => c.id === data.to);
      if (target) { target.dmVoicePeer = null; sendTo(target.ws, { type: 'dm_voice_decline', from: client.id }); }
      client.dmVoicePeer = null;
      break;
    }

    case 'dm_voice_accept': {
      const target = [...clients.values()].find(c => c.id === data.to);
      if (target) sendTo(target.ws, { type: 'dm_voice_accept', from: client.id });
      break;
    }

    case 'dm_voice_offer':
    case 'dm_voice_answer':
    case 'dm_voice_ice': {
      const target = [...clients.values()].find(c => c.id === data.to);
      if (target) sendTo(target.ws, { ...data, from: client.id });
      break;
    }
  }
}

function leaveVoice(client) {
  if (!client.voiceChannel) return;
  const { serverId, channelId } = client.voiceChannel;
  const srv = servers.get(serverId);
  if (srv && srv.voiceState[channelId]) {
    srv.voiceState[channelId] = srv.voiceState[channelId].filter(id => id !== client.id);
    if (srv.voiceState[channelId].length === 0) delete srv.voiceState[channelId];
    broadcast({ type: 'voice_user_left', userId: client.id, serverId, channelId }, c => srv.members.includes(c.id));
    broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
  }
  client.voiceChannel = null;
}

loadData();
server.listen(PORT, () => console.log(`T9 Network running on port ${PORT}`));