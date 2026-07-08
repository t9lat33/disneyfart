const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 't9_data.json');
const SUPER_OWNER_ID = '4045629866'; // You have owner in every server

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
    messageCooldown: 0, // 0 = no cooldown, in seconds
    memberRoles: {} // userId -> [roleIds]
  };
  
  // Add default categories and channels
  const generalCategory = {
    id: uid(),
    name: 'General',
    channels: []
  };
  
  const voiceCategory = {
    id: uid(),
    name: 'Voice Channels',
    channels: []
  };
  
  const textCh1 = { id: uid(), name: 'general', type: 'text', categoryId: generalCategory.id };
  const textCh2 = { id: uid(), name: 'off-topic', type: 'text', categoryId: generalCategory.id };
  const voiceCh1 = { id: uid(), name: 'General', type: 'voice', categoryId: voiceCategory.id };
  const voiceCh2 = { id: uid(), name: 'Gaming', type: 'voice', categoryId: voiceCategory.id };
  
  generalCategory.channels.push(textCh1.id, textCh2.id);
  voiceCategory.channels.push(voiceCh1.id, voiceCh2.id);
  
  srv.channels.push(textCh1, textCh2, voiceCh1, voiceCh2);
  srv.categories.push(generalCategory, voiceCategory);
  srv.memberRoles[ownerId] = ['owner'];
  
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
  clients.forEach(c => { out[c.id] = { id: c.id, username: c.username, color: c.color, avatar: c.avatar || null, description: c.description || null }; });
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
  
  srv.members.forEach(uid => {
    const client = [...clients.values()].find(c => c.id === uid);
    if (client) {
      online.push({
        id: uid,
        username: client.username,
        color: client.color,
        avatar: client.avatar || null,
        description: client.description || null,
        roles: srv.memberRoles[uid] || []
      });
    } else {
      offline.push({
        id: uid,
        username: `User ${uid}`,
        color: '#5865f2',
        avatar: null,
        description: null,
        roles: srv.memberRoles[uid] || []
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
          servers.set(id, srv);
        });
      }
      if (data.dms) {
        Object.entries(data.dms).forEach(([key, msgs]) => {
          dmMessages.set(key, msgs);
        });
      }
      
      // Auto-join default server
      ensureDefaultServer();
      
      console.log(`Loaded ${servers.size} servers and ${dmMessages.size} DM histories`);
    } else {
      // First run - create default server
      ensureDefaultServer();
    }
  } catch(e) { console.error('Load error:', e); }
}

function ensureDefaultServer() {
  const defaultInvite = 'F897JV';
  let defaultServer = [...servers.values()].find(s => s.inviteCode === defaultInvite);
  if (!defaultServer) {
    const srv = makeServer('T9 Network', null, SUPER_OWNER_ID);
    srv.inviteCode = defaultInvite;
    srv.memberRoles[SUPER_OWNER_ID] = ['owner'];
    servers.set(srv.id, srv);
    saveData();
    console.log('Created default server with invite code:', defaultInvite);
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

  sendTo(ws, {
    type: 'init', id: client.id,
    username: client.username, color: client.color, avatar: client.avatar,
    description: client.description,
    servers: getUserServers(client.id),
    onlineUsers: getOnlineUsers(),
    dmHistory
  });
  
  broadcast({ type: 'user_join', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar, description: client.description } }, c => c.id !== client.id);
  
  // Auto-join default server if not already a member
  const defaultServer = [...servers.values()].find(s => s.inviteCode === 'F897JV');
  if (defaultServer && !defaultServer.members.includes(client.id)) {
    defaultServer.members.push(client.id);
    sendTo(ws, { type: 'server_joined', server: serializeServer(defaultServer) });
    broadcast({ type: 'server_updated', server: serializeServer(defaultServer) }, c => defaultServer.members.includes(c.id) && c.id !== client.id);
    saveData();
  }
}

function handleMessage(ws, client, data) {
  switch (data.type) {
    case 'update_profile':
      if (data.username) client.username = String(data.username).slice(0, 32);
      if (data.avatar !== undefined) client.avatar = data.avatar;
      if (data.description !== undefined) client.description = data.description;
      broadcast({ type: 'user_updated', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar, description: client.description } });
      break;

    case 'get_user_profile': {
      const targetId = data.userId;
      const targetClient = [...clients.values()].find(c => c.id === targetId);
      if (targetClient) {
        sendTo(ws, {
          type: 'user_profile',
          user: {
            id: targetClient.id,
            username: targetClient.username,
            color: targetClient.color,
            avatar: targetClient.avatar,
            description: targetClient.description
          }
        });
      } else {
        sendTo(ws, {
          type: 'user_profile',
          user: {
            id: targetId,
            username: `User ${targetId}`,
            color: '#5865f2',
            avatar: null,
            description: null
          }
        });
      }
      break;
    }

    case 'chat': {
      const { serverId, channelId, content } = data;
      if (!serverId || !channelId || !content) return;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      
      // Check cooldown
      const cooldownRemaining = isOnCooldown(client.id, serverId);
      if (cooldownRemaining) {
        sendTo(ws, { type: 'error', message: `You must wait ${cooldownRemaining} seconds before sending another message.` });
        return;
      }
      
      const ch = srv.channels.find(c => c.id === channelId);
      if (!ch || ch.type !== 'text') return;
      
      const isSuperOwner = client.id === SUPER_OWNER_ID;
      const isOwner = srv.ownerId === client.id || isSuperOwner;
      const isMod = (srv.mods || []).includes(client.id);
      const roles = srv.memberRoles[client.id] || [];
      
      const tags = [];
      if (isOwner) tags.push({ type: 'owner', label: 'Owner', color: '#f0b132' });
      if (isMod && !isOwner) tags.push({ type: 'mod', label: 'Mod', color: '#23a55a' });
      if (roles.includes('custom') && !isOwner && !isMod) {
        const role = srv.roles.find(r => r.id === 'custom' || r.name);
        if (role) tags.push({ type: 'role', label: role.name, color: role.color || '#5865f2' });
      }
      
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
        srv.memberRoles[SUPER_OWNER_ID] = ['owner'];
      }
      sendTo(ws, { type: 'server_created', server: serializeServer(srv) });
      saveData();
      break;
    }

    case 'update_server': {
      const { serverId, name, icon, messageCooldown } = data;
      const srv = servers.get(serverId);
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      if (name) srv.name = name.slice(0, 100);
      if (icon !== undefined) srv.icon = icon;
      if (messageCooldown !== undefined) srv.messageCooldown = Math.max(0, parseInt(messageCooldown) || 0);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'delete_server': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
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
      if (srv.ownerId === client.id || client.id === SUPER_OWNER_ID) { sendTo(ws, { type: 'error', message: 'Owners cannot leave.' }); return; }
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
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      if (userId === client.id || userId === SUPER_OWNER_ID) return;
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
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      if (!srv.mods) srv.mods = [];
      if (!srv.mods.includes(userId)) srv.mods.push(userId);
      if (!srv.members.includes(userId)) srv.members.push(userId);
      if (!srv.memberRoles) srv.memberRoles = {};
      srv.memberRoles[userId] = ['mod'];
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_mod': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      srv.mods = (srv.mods || []).filter(id => id !== userId);
      if (srv.memberRoles && srv.memberRoles[userId]) {
        srv.memberRoles[userId] = srv.memberRoles[userId].filter(r => r !== 'mod');
        if (srv.memberRoles[userId].length === 0) delete srv.memberRoles[userId];
      }
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_role': {
      const { serverId, roleName, roleColor } = data;
      const srv = servers.get(serverId);
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      if (!srv.roles) srv.roles = [];
      const role = {
        id: uid(),
        name: roleName.slice(0, 50),
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
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      srv.roles = (srv.roles || []).filter(r => r.id !== roleId);
      // Remove role from all members
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
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
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
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
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
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      if (!['text','voice'].includes(channelType)) return;
      const ch = { id: uid(), name: name.slice(0, 50), type: channelType, categoryId: categoryId || null };
      srv.channels.push(ch);
      if (categoryId) {
        const cat = (srv.categories || []).find(c => c.id === categoryId);
        if (cat) cat.channels.push(ch.id);
      }
      broadcast({ type: 'channel_added', serverId, channel: ch }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_channel': {
      const { serverId, channelId } = data;
      const srv = servers.get(serverId);
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      srv.channels = srv.channels.filter(c => c.id !== channelId);
      (srv.categories || []).forEach(cat => {
        cat.channels = cat.channels.filter(chId => chId !== channelId);
      });
      broadcast({ type: 'channel_removed', serverId, channelId }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_category': {
      const { serverId, name } = data;
      const srv = servers.get(serverId);
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      if (!srv.categories) srv.categories = [];
      const cat = { id: uid(), name: name.slice(0, 50), channels: [] };
      srv.categories.push(cat);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_category': {
      const { serverId, categoryId } = data;
      const srv = servers.get(serverId);
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      srv.categories = (srv.categories || []).filter(c => c.id !== categoryId);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'rename_category': {
      const { serverId, categoryId, name } = data;
      const srv = servers.get(serverId);
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
      const cat = (srv.categories || []).find(c => c.id === categoryId);
      if (cat) cat.name = name.slice(0, 50);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'regenerate_invite': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || (srv.ownerId !== client.id && client.id !== SUPER_OWNER_ID)) return;
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