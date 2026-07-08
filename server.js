const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 't9_data.json');

const SUPER_ADMINS = ['4045629866'];
const DEFAULT_SERVER_INVITE = 'F897JV';

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
const userProfiles = new Map();
const messageCooldowns = new Map();

function uid() { return Math.random().toString(36).slice(2, 10); }
function inviteCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function hashString(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; } return h; }
function dmKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function isSuperAdmin(userId) { return SUPER_ADMINS.includes(String(userId)); }
function isServerOwner(srv, userId) { return String(srv.ownerId) === String(userId) || isSuperAdmin(userId); }
function isServerMod(srv, userId) { return isServerOwner(srv, userId) || (srv.mods || []).includes(String(userId)); }

function getUserTags(srv, userId) {
  const tags = [];
  if (isSuperAdmin(userId) || String(srv.ownerId) === String(userId)) {
    tags.push({ type: 'owner', label: 'Owner', color: '#f0b132' });
  } else if ((srv.mods || []).includes(String(userId))) {
    tags.push({ type: 'mod', label: 'Mod', color: '#23a55a' });
  }
  const roleIds = (srv.userRoles || {})[String(userId)] || [];
  roleIds.forEach(rid => {
    const role = (srv.roles || []).find(r => r.id === rid);
    if (role) tags.push({ type: 'role', label: role.name, color: role.color });
  });
  return tags;
}

function makeServer(name, icon, ownerId) {
  const id = uid();
  const members = [String(ownerId)];
  SUPER_ADMINS.forEach(sa => { if (!members.includes(sa)) members.push(sa); });
  const srv = {
    id, name, icon: icon || null,
    ownerId: String(ownerId),
    mods: [],
    inviteCode: inviteCode(),
    members,
    categories: [],
    roles: [],
    userRoles: {},
    messageCooldown: 0,
    channels: [
      { id: uid(), name: 'general', type: 'text', categoryId: null },
      { id: uid(), name: 'off-topic', type: 'text', categoryId: null },
      { id: uid(), name: 'General', type: 'voice', categoryId: null },
      { id: uid(), name: 'Gaming', type: 'voice', categoryId: null },
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
  clients.forEach(c => { out[c.id] = { id: c.id, username: c.username, color: c.color, avatar: c.avatar || null, description: c.description || '' }; });
  return out;
}

function serializeServer(srv) {
  const memberInfo = {};
  srv.members.forEach(uid => {
    const c = [...clients.values()].find(x => String(x.id) === String(uid));
    const p = userProfiles.get(String(uid)) || {};
    memberInfo[uid] = {
      username: c?.username || p.username || `User ${uid}`,
      color: c?.color || p.color || '#5865f2',
      avatar: c?.avatar || p.avatar || null
    };
  });
  return {
    id: srv.id, name: srv.name, icon: srv.icon,
    ownerId: srv.ownerId, mods: srv.mods || [], inviteCode: srv.inviteCode,
    members: srv.members, memberCount: srv.members.length,
    categories: srv.categories || [], roles: srv.roles || [],
    userRoles: srv.userRoles || {}, messageCooldown: srv.messageCooldown || 0,
    memberInfo,
    channels: srv.channels.map(ch => ({
      ...ch,
      users: ch.type === 'voice' ? (srv.voiceState[ch.id] || []).map(uid => {
        const c = [...clients.values()].find(x => String(x.id) === String(uid));
        return c ? { id: c.id, username: c.username } : { id: uid, username: 'Unknown' };
      }) : undefined
    }))
  };
}

function getUserServers(userId) {
  const out = {};
  servers.forEach((srv, id) => {
    if (srv.members.includes(String(userId))) out[id] = serializeServer(srv);
  });
  return out;
}

function ensureDefaultServer() {
  let defaultSrv = [...servers.values()].find(s => s.inviteCode === DEFAULT_SERVER_INVITE);
  if (!defaultSrv) {
    defaultSrv = makeServer('T9 Network', null, SUPER_ADMINS[0]);
    defaultSrv.inviteCode = DEFAULT_SERVER_INVITE;
    if (!defaultSrv.members.includes(SUPER_ADMINS[0])) defaultSrv.members.push(SUPER_ADMINS[0]);
    defaultSrv.ownerId = SUPER_ADMINS[0];
    saveData();
  }
  return defaultSrv;
}

let saveTimeout = null;
function saveData() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const data = { servers: {}, dms: {}, userIdCounter, profiles: {} };
    servers.forEach((srv, id) => {
      data.servers[id] = {
        id: srv.id, name: srv.name, icon: srv.icon,
        ownerId: srv.ownerId, mods: srv.mods || [], inviteCode: srv.inviteCode,
        members: srv.members, channels: srv.channels,
        categories: srv.categories || [], roles: srv.roles || [],
        userRoles: srv.userRoles || {}, messageCooldown: srv.messageCooldown || 0
      };
    });
    dmMessages.forEach((msgs, key) => { data.dms[key] = msgs; });
    userProfiles.forEach((p, id) => { data.profiles[id] = p; });
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
          if (!srv.userRoles) srv.userRoles = {};
          if (srv.messageCooldown === undefined) srv.messageCooldown = 0;
          srv.channels.forEach(ch => { if (!ch.categoryId) ch.categoryId = null; });
          SUPER_ADMINS.forEach(sa => { if (!srv.members.includes(sa)) srv.members.push(sa); });
          servers.set(id, srv);
        });
      }
      if (data.dms) {
        Object.entries(data.dms).forEach(([key, msgs]) => { dmMessages.set(key, msgs); });
      }
      if (data.profiles) {
        Object.entries(data.profiles).forEach(([id, p]) => { userProfiles.set(id, p); });
      }
      console.log(`Loaded ${servers.size} servers, ${dmMessages.size} DMs, ${userProfiles.size} profiles`);
    }
  } catch(e) { console.error('Load error:', e); }
}

wss.on('connection', (ws) => {
  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);
    if (data.type === 'init' && !client) handleInit(ws, data);
    else if (client) handleMessage(ws, client, data);
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;
    if (client.voiceChannel) leaveVoice(client);
    if (client.dmVoicePeer) {
      const peer = [...clients.values()].find(c => c.id === client.dmVoicePeer);
      if (peer) { sendTo(peer.ws, { type: 'dm_voice_end', from: client.id }); peer.dmVoicePeer = null; }
    }
    const profile = userProfiles.get(client.id);
    if (profile) { profile.username = client.username; profile.avatar = client.avatar; profile.color = client.color; profile.description = client.description || ''; }
    clients.delete(ws);
    broadcast({ type: 'user_leave', userId: client.id }, c => c.id !== client.id);
  });
});

function handleInit(ws, data) {
  let id = data.clientId || uid();
  const existingProfile = userProfiles.get(String(id)) || {};
  const color = existingProfile.color || COLORS[Math.abs(hashString(String(id))) % COLORS.length];
  const client = {
    id: String(id), ws,
    username: data.username ? String(data.username).slice(0, 32) : existingProfile.username || `User${String(id).slice(0,4)}`,
    color, avatar: data.avatar || existingProfile.avatar || null,
    description: existingProfile.description || '',
    currentChannel: null, voiceChannel: null, dmVoicePeer: null,
  };
  clients.set(ws, client);
  userProfiles.set(String(id), {
    username: client.username, color: client.color, avatar: client.avatar, description: client.description
  });

  const defaultSrv = ensureDefaultServer();
  if (!defaultSrv.members.includes(client.id)) { defaultSrv.members.push(client.id); saveData(); }

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
    dmHistory,
    defaultServerId: defaultSrv.id
  });

  broadcast({ type: 'user_join', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar, description: client.description } }, c => c.id !== client.id);
  broadcast({ type: 'server_updated', server: serializeServer(defaultSrv) }, c => defaultSrv.members.includes(c.id));
}

function handleMessage(ws, client, data) {
  switch (data.type) {
    case 'update_profile':
      if (data.username) client.username = String(data.username).slice(0, 32);
      if (data.avatar !== undefined) client.avatar = data.avatar;
      if (data.description !== undefined) client.description = String(data.description).slice(0, 500);
      userProfiles.set(client.id, { username: client.username, color: client.color, avatar: client.avatar, description: client.description });
      saveData();
      broadcast({ type: 'user_updated', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar, description: client.description } });
      servers.forEach(srv => {
        if (srv.members.includes(client.id)) {
          broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
        }
      });
      break;

    case 'get_user_profile': {
      const target = [...clients.values()].find(c => String(c.id) === String(data.userId));
      const profile = userProfiles.get(String(data.userId)) || {};
      let tags = [];
      servers.forEach(srv => {
        if (srv.members.includes(String(data.userId))) {
          tags = getUserTags(srv, String(data.userId));
        }
      });
      const profileData = {
        id: String(data.userId),
        username: target?.username || profile.username || `User ${data.userId}`,
        color: target?.color || profile.color || '#5865f2',
        avatar: target?.avatar || profile.avatar || null,
        description: target?.description || profile.description || '',
        online: !!target,
        tags
      };
      sendTo(ws, { type: 'user_profile', profile: profileData });
      break;
    }

    case 'chat': {
      const { serverId, channelId, content } = data;
      if (!serverId || !channelId || !content) return;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      const ch = srv.channels.find(c => c.id === channelId);
      if (!ch || ch.type !== 'text') return;

      if (srv.messageCooldown > 0 && !isServerMod(srv, client.id)) {
        const key = `${client.id}|${channelId}`;
        const lastTime = messageCooldowns.get(key) || 0;
        const elapsed = Date.now() - lastTime;
        if (elapsed < srv.messageCooldown * 1000) {
          sendTo(ws, { type: 'error', message: `Slow mode: wait ${Math.ceil((srv.messageCooldown * 1000 - elapsed) / 1000)}s.` });
          return;
        }
        messageCooldowns.set(key, Date.now());
      }

      const msg = {
        type: 'chat', id: uid(),
        userId: client.id, username: client.username, color: client.color, avatar: client.avatar,
        serverId, channelId,
        content: String(content).slice(0, 2000), timestamp: Date.now(),
        tags: getUserTags(srv, client.id)
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

    case 'create_server': {
      const { name, icon } = data;
      if (!name?.trim()) return;
      const srv = makeServer(name.trim().slice(0, 100), icon || null, client.id);
      sendTo(ws, { type: 'server_created', server: serializeServer(srv) });
      break;
    }

    case 'update_server': {
      const { serverId, name, icon, messageCooldown } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (name) srv.name = name.slice(0, 100);
      if (icon !== undefined) srv.icon = icon;
      if (messageCooldown !== undefined) srv.messageCooldown = Math.max(0, Math.min(60, parseInt(messageCooldown) || 0));
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
      if (isServerOwner(srv, client.id) && !isSuperAdmin(client.id)) { sendTo(ws, { type: 'error', message: 'Owners cannot leave.' }); return; }
      if (isSuperAdmin(client.id)) { sendTo(ws, { type: 'error', message: 'Cannot leave.' }); return; }
      srv.members = srv.members.filter(id => id !== client.id);
      srv.mods = (srv.mods || []).filter(id => id !== client.id);
      sendTo(ws, { type: 'server_left', serverId });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'kick_member': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (isSuperAdmin(userId)) return;
      if (String(userId) === String(client.id)) return;
      srv.members = srv.members.filter(id => id !== String(userId));
      srv.mods = (srv.mods || []).filter(id => id !== String(userId));
      if (srv.userRoles) delete srv.userRoles[userId];
      const target = [...clients.values()].find(c => c.id === String(userId));
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
      if (!srv.mods.includes(String(userId))) srv.mods.push(String(userId));
      if (!srv.members.includes(String(userId))) srv.members.push(String(userId));
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_mod': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      srv.mods = (srv.mods || []).filter(id => id !== String(userId));
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_channel': {
      const { serverId, channelType, name, categoryId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (!['text','voice'].includes(channelType)) return;
      const ch = { id: uid(), name: name.slice(0, 50), type: channelType, categoryId: categoryId || null };
      srv.channels.push(ch);
      if (categoryId) {
        const cat = (srv.categories || []).find(c => c.id === categoryId);
        if (cat) { if (!cat.channelIds) cat.channelIds = []; cat.channelIds.push(ch.id); }
      }
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_channel': {
      const { serverId, channelId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      srv.channels = srv.channels.filter(c => c.id !== channelId);
      (srv.categories || []).forEach(cat => { if (cat.channelIds) cat.channelIds = cat.channelIds.filter(id => id !== channelId); });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'regenerate_invite': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (srv.inviteCode === DEFAULT_SERVER_INVITE) return;
      srv.inviteCode = inviteCode();
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_category': {
      const { serverId, name } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (!name?.trim()) return;
      if (!srv.categories) srv.categories = [];
      const cat = { id: uid(), name: name.trim().slice(0, 50), channelIds: [] };
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
      srv.channels.forEach(ch => { if (ch.categoryId === categoryId) ch.categoryId = null; });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'rename_category': {
      const { serverId, categoryId, name } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      const cat = (srv.categories || []).find(c => c.id === categoryId);
      if (cat && name?.trim()) cat.name = name.trim().slice(0, 50);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'move_channel_to_category': {
      const { serverId, channelId, categoryId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      const ch = srv.channels.find(c => c.id === channelId);
      if (ch) {
        ch.categoryId = categoryId || null;
        (srv.categories || []).forEach(cat => {
          if (cat.id === categoryId) {
            if (!cat.channelIds) cat.channelIds = [];
            if (!cat.channelIds.includes(channelId)) cat.channelIds.push(channelId);
          } else {
            if (cat.channelIds) cat.channelIds = cat.channelIds.filter(id => id !== channelId);
          }
        });
      }
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'add_role': {
      const { serverId, name, color } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (!name?.trim()) return;
      if (!srv.roles) srv.roles = [];
      const role = { id: uid(), name: name.trim().slice(0, 50), color: color || '#5865f2' };
      srv.roles.push(role);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'update_role': {
      const { serverId, roleId, name, color } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      const role = (srv.roles || []).find(r => r.id === roleId);
      if (role) {
        if (name) role.name = name.slice(0, 50);
        if (color) role.color = color;
      }
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_role': {
      const { serverId, roleId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      srv.roles = (srv.roles || []).filter(r => r.id !== roleId);
      if (srv.userRoles) Object.keys(srv.userRoles).forEach(uid => { srv.userRoles[uid] = srv.userRoles[uid].filter(id => id !== roleId); });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'assign_role': {
      const { serverId, userId, roleId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (!srv.userRoles) srv.userRoles = {};
      if (!srv.userRoles[userId]) srv.userRoles[userId] = [];
      if (!srv.userRoles[userId].includes(roleId)) srv.userRoles[userId].push(roleId);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_user_role': {
      const { serverId, userId, roleId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isServerOwner(srv, client.id)) return;
      if (srv.userRoles?.[userId]) srv.userRoles[userId] = srv.userRoles[userId].filter(id => id !== roleId);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
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

    case 'voice_leave': leaveVoice(client); break;

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
ensureDefaultServer();
server.listen(PORT, () => console.log(`T9 Network running on port ${PORT}`));