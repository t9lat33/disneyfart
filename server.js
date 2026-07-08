const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 't9_data.json');
const SUPER_OWNER_ID = '4045629866';

const mimeTypes = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.mjs': 'application/javascript'
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  
  if (urlPath === '/' || urlPath === '/chat.html') {
    fs.readFile(path.join(__dirname, 'chat.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  
  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server, path: '/ws' });

let userIdCounter = 1;
const COLORS = ['#7289da','#43b581','#faa61a','#f47fff','#ed4245','#5865f2','#00b0f4','#57f287','#feb132','#eb459e'];
const clients = new Map();
const servers = new Map();
const channelMessages = new Map();
const dmMessages = new Map();

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
    mods: [],
    inviteCode: inviteCode(),
    members: [ownerId],
    channels: [],
    categories: [],
    voiceState: {},
    roles: [],
    messageCooldown: 0,
    memberRoles: {}
  };
  
  // Default channels
  const generalChId = uid();
  const offTopicChId = uid();
  const voiceCh1Id = uid();
  const voiceCh2Id = uid();
  
  srv.channels = [
    { id: generalChId, name: 'general', type: 'text', categoryId: null },
    { id: offTopicChId, name: 'off-topic', type: 'text', categoryId: null },
    { id: voiceCh1Id, name: 'General', type: 'voice', categoryId: null },
    { id: voiceCh2Id, name: 'Gaming', type: 'voice', categoryId: null }
  ];
  
  srv.memberRoles[ownerId] = ['owner'];
  
  servers.set(id, srv);
  saveData();
  return srv;
}

function isServerOwner(srv, userId) {
  return srv.ownerId === userId || userId === SUPER_OWNER_ID;
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
  clients.forEach(c => { 
    out[c.id] = { id: c.id, username: c.username, color: c.color, avatar: c.avatar || null, description: c.description || null }; 
  });
  return out;
}

function serializeServer(srv) {
  return {
    id: srv.id,
    name: srv.name,
    icon: srv.icon,
    ownerId: srv.ownerId,
    mods: srv.mods || [],
    inviteCode: srv.inviteCode,
    members: srv.members,
    memberCount: srv.members.length,
    channels: srv.channels.map(ch => ({
      ...ch,
      users: ch.type === 'voice' ? (srv.voiceState[ch.id] || []).map(uid => {
        const c = [...clients.values()].find(x => x.id === uid);
        return c ? { id: c.id, username: c.username } : { id: uid, username: 'Unknown' };
      }) : undefined
    })),
    categories: srv.categories || [],
    roles: srv.roles || [],
    messageCooldown: srv.messageCooldown || 0,
    memberRoles: srv.memberRoles || {}
  };
}

function getUserServers(userId) {
  const out = {};
  servers.forEach((srv, id) => {
    if (srv.members.includes(userId)) out[id] = serializeServer(srv);
  });
  return out;
}

function getServerMemberDetails(srv) {
  const online = [];
  const offline = [];
  const onlineIds = new Set();
  
  clients.forEach(c => onlineIds.add(c.id));
  
  srv.members.forEach(uid => {
    const memberRoles = srv.memberRoles?.[uid] || [];
    const memberInfo = {
      id: uid,
      roles: memberRoles,
      isOwner: srv.ownerId === uid || uid === SUPER_OWNER_ID,
      isMod: (srv.mods || []).includes(uid)
    };
    
    if (onlineIds.has(uid)) {
      const client = [...clients.values()].find(c => c.id === uid);
      online.push({
        ...memberInfo,
        username: client.username,
        color: client.color,
        avatar: client.avatar || null,
        description: client.description || null
      });
    } else {
      offline.push({
        ...memberInfo,
        username: `User ${uid.slice(0, 6)}`,
        color: '#5865f2',
        avatar: null,
        description: null
      });
    }
  });
  
  return { online, offline };
}

let saveTimeout = null;
function saveData() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const data = { servers: {}, dms: {}, userIdCounter };
    servers.forEach((srv, id) => {
      data.servers[id] = {
        id: srv.id, name: srv.name, icon: srv.icon,
        ownerId: srv.ownerId, mods: srv.mods || [], inviteCode: srv.inviteCode,
        members: srv.members, channels: srv.channels,
        categories: srv.categories || [],
        roles: srv.roles || [],
        messageCooldown: srv.messageCooldown || 0,
        memberRoles: srv.memberRoles || {}
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
          if (!srv.mods) srv.mods = [];
          if (!srv.categories) srv.categories = [];
          if (!srv.roles) srv.roles = [];
          if (!srv.messageCooldown) srv.messageCooldown = 0;
          if (!srv.memberRoles) srv.memberRoles = {};
          if (!srv.memberRoles[SUPER_OWNER_ID]) srv.memberRoles[SUPER_OWNER_ID] = ['owner'];
          if (!srv.members.includes(SUPER_OWNER_ID)) srv.members.push(SUPER_OWNER_ID);
          servers.set(id, srv);
        });
      }
      if (data.dms) {
        Object.entries(data.dms).forEach(([key, msgs]) => {
          dmMessages.set(key, msgs);
        });
      }
      
      ensureDefaultServer();
      
      console.log(`Loaded ${servers.size} servers and ${dmMessages.size} DM histories`);
    } else {
      ensureDefaultServer();
    }
  } catch(e) { 
    console.error('Load error:', e);
    ensureDefaultServer();
  }
}

function ensureDefaultServer() {
  const defaultInvite = 'F897JV';
  let defaultServer = [...servers.values()].find(s => s.inviteCode === defaultInvite);
  if (!defaultServer) {
    const srv = makeServer('T9 Network', null, SUPER_OWNER_ID);
    srv.inviteCode = defaultInvite;
    srv.members.push(SUPER_OWNER_ID);
    srv.memberRoles[SUPER_OWNER_ID] = ['owner'];
    servers.set(srv.id, srv);
    saveData();
    console.log('Created default server with invite code:', defaultInvite);
  } else {
    if (!defaultServer.members.includes(SUPER_OWNER_ID)) {
      defaultServer.members.push(SUPER_OWNER_ID);
    }
    if (!defaultServer.memberRoles) defaultServer.memberRoles = {};
    defaultServer.memberRoles[SUPER_OWNER_ID] = ['owner'];
    saveData();
  }
}

// Cooldown tracking
const userLastMessageTime = new Map();

function isOnCooldown(userId, serverId) {
  const srv = servers.get(serverId);
  if (!srv || !srv.messageCooldown || srv.messageCooldown <= 0) return false;
  
  const key = `${userId}|${serverId}`;
  const lastTime = userLastMessageTime.get(key) || 0;
  const now = Date.now();
  
  if (now - lastTime < srv.messageCooldown * 1000) {
    return Math.ceil((srv.messageCooldown * 1000 - (now - lastTime)) / 1000);
  }
  
  userLastMessageTime.set(key, now);
  return false;
}

wss.on('connection', (ws) => {
  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);
    
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
    description: data.description || null,
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

  // Auto-join default server
  const defaultServer = [...servers.values()].find(s => s.inviteCode === 'F897JV');
  if (defaultServer && !defaultServer.members.includes(client.id)) {
    defaultServer.members.push(client.id);
    saveData();
  }
  
  // Make sure super owner is in all servers
  servers.forEach(srv => {
    if (!srv.members.includes(SUPER_OWNER_ID)) {
      srv.members.push(SUPER_OWNER_ID);
    }
    if (!srv.memberRoles) srv.memberRoles = {};
    if (!srv.memberRoles[SUPER_OWNER_ID] || !srv.memberRoles[SUPER_OWNER_ID].includes('owner')) {
      srv.memberRoles[SUPER_OWNER_ID] = ['owner'];
    }
  });
  
  saveData();

  sendTo(ws, {
    type: 'init', id: client.id,
    username: client.username, color: client.color, avatar: client.avatar,
    description: client.description,
    servers: getUserServers(client.id),
    onlineUsers: getOnlineUsers(),
    dmHistory,
    superOwnerId: SUPER_OWNER_ID
  });
  
  broadcast({ type: 'user_join', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar, description: client.description } }, c => c.id !== client.id);
}

function handleMessage(ws, client, data) {
  switch (data.type) {
    case 'update_profile':
      if (data.username !== undefined) client.username = String(data.username).slice(0, 32);
      if (data.avatar !== undefined) client.avatar = data.avatar || null;
      if (data.description !== undefined) client.description = data.description || null;
      broadcast({ type: 'user_updated', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar, description: client.description } });
      break;

    case 'get_user_profile': {
      const targetId = data.userId;
      const targetClient = [...clients.values()].find(c => c.id === targetId);
      const profile = targetClient ? {
        id: targetClient.id,
        username: targetClient.username,
        color: targetClient.color,
        avatar: targetClient.avatar,
        description: targetClient.description
      } : {
        id: targetId,
        username: `User ${targetId.slice(0, 6)}`,
        color: '#5865f2',
        avatar: null,
        description: null
      };
      
      // Get server-specific roles if in a server
      if (data.serverId) {
        const srv = servers.get(data.serverId);
        if (srv) {
          profile.isOwner = srv.ownerId === targetId || targetId === SUPER_OWNER_ID;
          profile.isMod = (srv.mods || []).includes(targetId);
          profile.memberRoles = srv.memberRoles?.[targetId] || [];
        }
      }
      
      sendTo(ws, { type: 'user_profile', user: profile });
      break;
    }

    case 'chat': {
      const { serverId, channelId, content } = data;
      if (!serverId || !channelId || !content) return;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      
      const cooldownRemaining = isOnCooldown(client.id, serverId);
      if (cooldownRemaining) {
        sendTo(ws, { type: 'error', message: `Slow mode: wait ${cooldownRemaining}s before sending.` });
        return;
      }
      
      const ch = srv.channels.find(c => c.id === channelId);
      if (!ch || ch.type !== 'text') return;
      
      const isOwner = isServerOwner(srv, client.id);
      const isMod = (srv.mods || []).includes(client.id);
      
      const tags = [];
      if (isOwner) tags.push({ type: 'owner', label: 'Owner', color: '#f0b132' });
      else if (isMod) tags.push({ type: 'mod', label: 'Mod', color: '#23a55a' });
      
      // Add custom role tags
      const memberRoles = srv.memberRoles?.[client.id] || [];
      (srv.roles || []).forEach(role => {
        if (memberRoles.includes(role.id)) {
          tags.push({ type: 'role', label: role.name, color: role.color });
        }
      });
      
      const msg = {
        type: 'chat', id: uid(),
        userId: client.id, username: client.username, color: client.color, avatar: client.avatar,
        serverId, channelId,
        content: String(content).slice(0, 2000), timestamp: Date.now(),
        tags
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
      saveData();
      
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

    case 'get_server_members': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      const details = getServerMemberDetails(srv);
      sendTo(ws, { type: 'server_members', serverId, ...details });
      break;
    }

    case 'create_server': {
      const { name, icon } = data;
      if (!name?.trim()) return;
      const srv = makeServer(name.trim().slice(0, 100), icon || null, client.id);
      if (client.id !== SUPER_OWNER_ID) {
        srv.members.push(SUPER_OWNER_ID);
        if (!srv.memberRoles) srv.memberRoles = {};
        srv.memberRoles[SUPER_OWNER_ID] = ['owner'];
      }
      sendTo(ws, { type: 'server_created', server: serializeServer(srv) });
      saveData();
      break;
    }

    case 'update_server': {
      const { serverId, name, icon, messageCooldown } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (name !== undefined) srv.name = String(name).slice(0, 100);
      if (icon !== undefined) srv.icon = icon || null;
      if (messageCooldown !== undefined) srv.messageCooldown = Math.max(0, Math.min(300, parseInt(messageCooldown) || 0));
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'delete_server': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
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
      if (isServerOwner(srv, client.id)) { sendTo(ws, { type: 'error', message: 'Owners cannot leave.' }); return; }
      srv.members = srv.members.filter(id => id !== client.id);
      srv.mods = (srv.mods || []).filter(id => id !== client.id);
      if (srv.memberRoles) delete srv.memberRoles[client.id];
      sendTo(ws, { type: 'server_left', serverId });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'kick_member': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (userId === client.id || isServerOwner(srv, userId)) return;
      srv.members = srv.members.filter(id => id !== userId);
      srv.mods = (srv.mods || []).filter(id => id !== userId);
      if (srv.memberRoles) delete srv.memberRoles[userId];
      const target = [...clients.values()].find(c => c.id === userId);
      if (target) sendTo(target.ws, { type: 'kicked', serverId });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_mod': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (!srv.mods) srv.mods = [];
      if (!srv.mods.includes(userId)) srv.mods.push(userId);
      if (!srv.members.includes(userId)) srv.members.push(userId);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_mod': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      srv.mods = (srv.mods || []).filter(id => id !== userId);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_role': {
      const { serverId, roleName, roleColor } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (!srv.roles) srv.roles = [];
      const role = {
        id: uid(),
        name: String(roleName).slice(0, 50),
        color: roleColor || '#5865f2'
      };
      srv.roles.push(role);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_role': {
      const { serverId, roleId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      srv.roles = (srv.roles || []).filter(r => r.id !== roleId);
      if (srv.memberRoles) {
        Object.keys(srv.memberRoles).forEach(uid => {
          srv.memberRoles[uid] = srv.memberRoles[uid].filter(r => r !== roleId);
          if (srv.memberRoles[uid].length === 0) delete srv.memberRoles[uid];
        });
      }
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'assign_role': {
      const { serverId, userId, roleId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (!srv.memberRoles) srv.memberRoles = {};
      if (!srv.memberRoles[userId]) srv.memberRoles[userId] = [];
      if (!srv.memberRoles[userId].includes(roleId)) {
        srv.memberRoles[userId].push(roleId);
      }
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_member_role': {
      const { serverId, userId, roleId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (srv.memberRoles && srv.memberRoles[userId]) {
        srv.memberRoles[userId] = srv.memberRoles[userId].filter(r => r !== roleId);
        if (srv.memberRoles[userId].length === 0) delete srv.memberRoles[userId];
      }
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_channel': {
      const { serverId, channelType, name, categoryId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (!['text','voice'].includes(channelType)) return;
      const ch = { id: uid(), name: String(name).slice(0, 50), type: channelType, categoryId: categoryId || null };
      srv.channels.push(ch);
      broadcast({ type: 'channel_added', serverId, channel: ch }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_channel': {
      const { serverId, channelId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      srv.channels = srv.channels.filter(c => c.id !== channelId);
      if (channelMessages.has(channelId)) channelMessages.delete(channelId);
      broadcast({ type: 'channel_removed', serverId, channelId }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_category': {
      const { serverId, name } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (!srv.categories) srv.categories = [];
      const cat = { id: uid(), name: String(name).slice(0, 50) };
      srv.categories.push(cat);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_category': {
      const { serverId, categoryId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      srv.categories = (srv.categories || []).filter(c => c.id !== categoryId);
      // Unset category from channels
      srv.channels.forEach(ch => {
        if (ch.categoryId === categoryId) ch.categoryId = null;
      });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'rename_category': {
      const { serverId, categoryId, name } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      const cat = (srv.categories || []).find(c => c.id === categoryId);
      if (cat) cat.name = String(name).slice(0, 50);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'move_channel_category': {
      const { serverId, channelId, categoryId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      const ch = srv.channels.find(c => c.id === channelId);
      if (ch) ch.categoryId = categoryId || null;
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'regenerate_invite': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
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

    case 'voice_video_state': {
      if (!client.voiceChannel) return;
      const { serverId, channelId } = client.voiceChannel;
      const srv = servers.get(serverId);
      if (!srv) return;
      broadcast({ type: 'voice_video_state', userId: client.id, video: !!data.video }, c => srv.members.includes(c.id) && c.id !== client.id);
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

    case 'dm_voice_start': {
      const targets = [...clients.values()].filter(c => c.id === data.to);
      if (!targets.length || targets.some(t => t.dmVoicePeer || t.voiceChannel)) {
        sendTo(ws, { type: 'dm_voice_decline', from: data.to });
        return;
      }
      client.dmVoicePeer = data.to;
      targets.forEach(target => {
        target.dmVoicePeer = client.id;
        sendTo(target.ws, { type: 'dm_voice_start', from: client.id, caller: { id: client.id, username: client.username, color: client.color, avatar: client.avatar }, video: !!data.video });
      });
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

    case 'dm_voice_video_state': {
      if (!client.dmVoicePeer) return;
      const target = [...clients.values()].find(c => c.id === client.dmVoicePeer);
      if (target) sendTo(target.ws, { type: 'dm_voice_video_state', from: client.id, video: !!data.video });
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
    broadcast({ type: 'voice_video_state', userId: client.id, video: false }, c => srv.members.includes(c.id));
    broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
  }
  client.voiceChannel = null;
}

loadData();
server.listen(PORT, () => console.log(`T9 Network running on port ${PORT}`));