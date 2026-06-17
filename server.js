const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 't9_data.json');

// ─── HTTP ─────────────────────────────────────────────────────────────────────
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

// ─── State ────────────────────────────────────────────────────────────────────
let userIdCounter = 1;
const COLORS = ['#7289da','#43b581','#faa61a','#f47fff','#ed4245','#5865f2','#00b0f4','#57f287','#feb132','#eb459e'];

const clients = new Map();     // ws -> client obj
const servers = new Map();     // serverId -> server obj
const channelMessages = new Map(); // channelId -> [messages]

function uid() { return Math.random().toString(36).slice(2, 10); }
function inviteCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

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
    voiceState: {}  // channelId -> [userId]
  };
  servers.set(id, srv);
  saveDataDebounced();
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

// Serialize server for client (include voiceState user info)
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

// ─── Persistence ──────────────────────────────────────────────────────────────
function saveData() {
  const data = {
    servers: {},
    userIdCounter
  };
  servers.forEach((srv, id) => {
    data.servers[id] = {
      id: srv.id,
      name: srv.name,
      icon: srv.icon,
      ownerId: srv.ownerId,
      inviteCode: srv.inviteCode,
      members: srv.members,
      channels: srv.channels
    };
  });
  
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save data:', err);
  }
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      userIdCounter = data.userIdCounter || 1;
      
      if (data.servers) {
        Object.entries(data.servers).forEach(([id, srv]) => {
          srv.voiceState = {}; // Reset voice state on load
          servers.set(id, srv);
        });
      }
      
      console.log(`Loaded ${servers.size} servers from disk`);
    } else {
      console.log('No saved data found, starting fresh');
    }
  } catch (err) {
    console.error('Failed to load data:', err);
  }
}

function saveDataDebounced() {
  clearTimeout(saveDataDebounced.timeout);
  saveDataDebounced.timeout = setTimeout(saveData, 1000);
}

// ─── Connection ───────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const id = userIdCounter++;
  const color = COLORS[(id - 1) % COLORS.length];
  const client = {
    id, ws,
    username: `User${id}`,
    color,
    avatar: null,
    currentChannel: null,  // { serverId, channelId }
    voiceChannel: null,    // { serverId, channelId }
    dmVoicePeer: null,     // userId of DM voice call partner
  };
  clients.set(ws, client);

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    handleMessage(ws, client, data);
  });

  ws.on('close', () => {
    // Leave voice
    if (client.voiceChannel) {
      leaveVoice(client);
    }
    // End DM voice call
    if (client.dmVoicePeer) {
      const peer = [...clients.values()].find(c => c.id === client.dmVoicePeer);
      if (peer) {
        sendTo(peer.ws, { type: 'dm_voice_end', from: client.id });
        peer.dmVoicePeer = null;
      }
    }
    clients.delete(ws);
    broadcast({ type: 'user_leave', userId: client.id },
      c => c.id !== client.id);
    console.log(`${client.username} disconnected`);
  });

  ws.on('error', () => { clients.delete(ws); });
});

// ─── Message handler ──────────────────────────────────────────────────────────
function handleMessage(ws, client, data) {
  switch (data.type) {

    case 'init': {
      if (data.username) client.username = String(data.username).slice(0, 32);
      if (data.avatar) client.avatar = data.avatar;
      if (data.color) client.color = data.color;
      console.log(`${client.username} connected`);
      sendTo(ws, {
        type: 'init',
        id: client.id,
        username: client.username,
        color: client.color,
        avatar: client.avatar,
        servers: getUserServers(client.id),
        onlineUsers: getOnlineUsers()
      });
      broadcast({ type: 'user_join', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar } },
        c => c.id !== client.id);
      break;
    }

    case 'update_profile': {
      if (data.username) client.username = String(data.username).slice(0, 32);
      if (data.avatar !== undefined) client.avatar = data.avatar;
      broadcast({ type: 'user_updated', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar } });
      break;
    }

    case 'chat': {
      const { serverId, channelId, content } = data;
      if (!serverId || !channelId || !content) return;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      const ch = srv.channels.find(c => c.id === channelId);
      if (!ch || ch.type !== 'text') return;
      const msg = {
        type: 'chat',
        id: uid(),
        userId: client.id,
        username: client.username,
        color: client.color,
        avatar: client.avatar,
        serverId, channelId,
        content: String(content).slice(0, 2000),
        timestamp: Date.now()
      };
      if (!channelMessages.has(channelId)) channelMessages.set(channelId, []);
      const hist = channelMessages.get(channelId);
      hist.push(msg);
      if (hist.length > 100) hist.shift();
      // send to all members of server who are in that channel
      clients.forEach(c => {
        if (srv.members.includes(c.id) && c.currentChannel?.channelId === channelId) {
          sendTo(c.ws, msg);
        }
      });
      break;
    }

    case 'dm': {
      const { to, content } = data;
      if (!to || !content) return;
      const toClient = [...clients.values()].find(c => c.id === to);
      const msg = {
        type: 'dm',
        id: uid(),
        from: client.id,
        to,
        userId: client.id,
        username: client.username,
        color: client.color,
        avatar: client.avatar,
        content: String(content).slice(0, 2000),
        timestamp: Date.now()
      };
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
      // Send history
      const hist = channelMessages.get(channelId) || [];
      hist.forEach(msg => sendTo(ws, msg));
      break;
    }

    case 'create_server': {
      const { name, icon } = data;
      if (!name?.trim()) return;
      const srv = makeServer(name.trim().slice(0, 100), icon || null, client.id);
      sendTo(ws, { type: 'server_created', server: serializeServer(srv) });
      console.log(`Server created: ${srv.name} by ${client.username}`);
      saveDataDebounced();
      break;
    }

    case 'update_server': {
      const { serverId, name, icon } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      if (name) srv.name = name.slice(0, 100);
      if (icon !== undefined) srv.icon = icon;
      broadcast(
        { type: 'server_updated', server: serializeServer(srv) },
        c => srv.members.includes(c.id)
      );
      saveDataDebounced();
      break;
    }

    case 'delete_server': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      servers.delete(serverId);
      broadcast(
        { type: 'server_deleted', serverId },
        c => srv.members.includes(c.id)
      );
      console.log(`Server deleted: ${serverId}`);
      saveDataDebounced();
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
      // notify existing members
      broadcast(
        { type: 'server_updated', server: serializeServer(srv) },
        c => srv.members.includes(c.id) && c.id !== client.id
      );
      console.log(`${client.username} joined server ${srv.name}`);
      saveDataDebounced();
      break;
    }

    case 'leave_server': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      if (srv.ownerId === client.id) { sendTo(ws, { type: 'error', message: 'Owners cannot leave. Delete the server instead.' }); return; }
      srv.members = srv.members.filter(id => id !== client.id);
      sendTo(ws, { type: 'server_left', serverId });
      broadcast(
        { type: 'server_updated', server: serializeServer(srv) },
        c => srv.members.includes(c.id)
      );
      saveDataDebounced();
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
      broadcast(
        { type: 'server_updated', server: serializeServer(srv) },
        c => srv.members.includes(c.id)
      );
      saveDataDebounced();
      break;
    }

    case 'add_channel': {
      const { serverId, channelType, name } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      if (!['text','voice'].includes(channelType)) return;
      const ch = { id: uid(), name: name.slice(0, 50), type: channelType };
      srv.channels.push(ch);
      broadcast(
        { type: 'channel_added', serverId, channel: ch },
        c => srv.members.includes(c.id)
      );
      saveDataDebounced();
      break;
    }

    case 'remove_channel': {
      const { serverId, channelId } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      srv.channels = srv.channels.filter(c => c.id !== channelId);
      broadcast(
        { type: 'channel_removed', serverId, channelId },
        c => srv.members.includes(c.id)
      );
      saveDataDebounced();
      break;
    }

    case 'regenerate_invite': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || srv.ownerId !== client.id) return;
      srv.inviteCode = inviteCode();
      broadcast(
        { type: 'invite_regenerated', serverId, inviteCode: srv.inviteCode },
        c => srv.members.includes(c.id)
      );
      saveDataDebounced();
      break;
    }

    // ── Voice ──────────────────────────────────────────────────────────────────
    case 'voice_join': {
      const { serverId, channelId } = data;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      const ch = srv.channels.find(c => c.id === channelId && c.type === 'voice');
      if (!ch) return;

      if (client.voiceChannel) leaveVoice(client);
      if (client.dmVoicePeer) {
        const peer = [...clients.values()].find(c => c.id === client.dmVoicePeer);
        if (peer) {
          sendTo(peer.ws, { type: 'dm_voice_end', from: client.id });
          peer.dmVoicePeer = null;
        }
        client.dmVoicePeer = null;
      }

      if (!srv.voiceState[channelId]) srv.voiceState[channelId] = [];
      srv.voiceState[channelId].push(client.id);
      client.voiceChannel = { serverId, channelId };

      // Send existing users to joiner
      const users = srv.voiceState[channelId]
        .filter(id => id !== client.id)
        .map(id => ({ id }));
      sendTo(ws, { type: 'voice_users', users });

      // Notify others
      broadcast(
        { type: 'voice_user_joined', userId: client.id, serverId, channelId },
        c => srv.members.includes(c.id) && c.id !== client.id
      );

      // Broadcast updated server so sidebar updates
      broadcast(
        { type: 'server_updated', server: serializeServer(srv) },
        c => srv.members.includes(c.id)
      );
      console.log(`${client.username} joined voice ${ch.name}`);
      break;
    }

    case 'voice_leave': {
      leaveVoice(client);
      break;
    }

    case 'voice_offer':
    case 'voice_answer':
    case 'voice_ice': {
      const target = [...clients.values()].find(c => c.id === data.to);
      if (target) sendTo(target.ws, { ...data, from: client.id });
      break;
    }

    case 'voice_speaking': {
      if (!client.voiceChannel) return;
      const { serverId, channelId } = client.voiceChannel;
      const srv = servers.get(serverId);
      if (!srv) return;
      broadcast(
        { type: 'voice_speaking', userId: client.id, active: data.active },
        c => srv.members.includes(c.id) && c.id !== client.id
      );
      break;
    }

    // ── DM Voice ───────────────────────────────────────────────────────────────
    case 'dm_voice_start': {
      const target = [...clients.values()].find(c => c.id === data.to);
      if (!target) {
        sendTo(ws, { type: 'dm_voice_decline', from: data.to });
        return;
      }
      if (target.dmVoicePeer || target.voiceChannel) {
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
        if (peer) {
          sendTo(peer.ws, { type: 'dm_voice_end', from: client.id });
          peer.dmVoicePeer = null;
        }
        client.dmVoicePeer = null;
      }
      break;
    }

    case 'dm_voice_decline': {
      if (client.dmVoicePeer) {
        const peer = [...clients.values()].find(c => c.id === client.dmVoicePeer);
        if (peer) {
          sendTo(peer.ws, { type: 'dm_voice_decline', from: client.id });
          peer.dmVoicePeer = null;
        }
        client.dmVoicePeer = null;
      }
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
    broadcast(
      { type: 'voice_user_left', userId: client.id, serverId, channelId },
      c => srv.members.includes(c.id)
    );
    broadcast(
      { type: 'server_updated', server: serializeServer(srv) },
      c => srv.members.includes(c.id)
    );
  }
  client.voiceChannel = null;
}

// Load saved data on startup
loadData();

server.listen(PORT, () => console.log(`T9 Network running on port ${PORT}`));