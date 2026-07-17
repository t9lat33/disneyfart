const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 't9_data.json');
const DEFAULT_ADMIN_PASSWORD_PLACEHOLDER = 'change-this-to-a-long-random-secret';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD_PLACEHOLDER;
const superAdmins = new Set();
const DEFAULT_INVITE_CODE = 'F897JV';

// ---------------------------------------------------------------------------
// USER STATS FILE (server-only, never served to the frontend)
// ---------------------------------------------------------------------------
// Stored in a sibling directory *outside* __dirname (the directory the HTTP
// server serves static files from), so it can never be reached by a browser
// request no matter what path is requested. The static file handler below
// also enforces that requested paths must resolve inside __dirname, which
// blocks "../" traversal from ever reaching this file even if it were placed
// alongside the app.
const STATS_DIR = path.join(__dirname, '..', 't9_private_data');
const STATS_FILE = path.join(STATS_DIR, 'user_stats.json');
try { fs.mkdirSync(STATS_DIR, { recursive: true }); } catch (e) { /* already exists */ }

const userStats = new Map(); // userId -> { id, username, ip, messagesSent, servers: [{id,name}] }

function getClientIp(req) {
  // Respect a proxy header if you're behind one (nginx, a load balancer, etc).
  // Falls back to the raw socket address for direct connections.
  const xf = req.headers['x-forwarded-for'];
  if (xf) return xf.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function computeUserServers(userId) {
  const list = [];
  servers.forEach(srv => { if (srv.members.includes(userId)) list.push({ id: srv.id, name: srv.name }); });
  return list;
}

let statsSaveTimeout = null;
function saveUserStats() {
  if (statsSaveTimeout) clearTimeout(statsSaveTimeout);
  statsSaveTimeout = setTimeout(() => {
    const out = {};
    userStats.forEach((v, id) => {
      out[id] = {
        username: v.username,
        ip: v.ip || null,
        messagesSent: v.messagesSent || 0,
        serverCount: (v.servers || []).length,
        servers: v.servers || []
      };
    });
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(out, null, 2)); }
    catch (e) { console.error('user stats save error:', e); }
    statsSaveTimeout = null;
  }, 500);
}

function loadUserStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      Object.entries(data).forEach(([id, v]) => {
        userStats.set(id, {
          id,
          username: v.username,
          ip: v.ip || null,
          messagesSent: v.messagesSent || 0,
          servers: v.servers || []
        });
      });
      console.log(`Loaded stats for ${userStats.size} users`);
    }
  } catch (e) { console.error('user stats load error:', e); }
}

// Refresh (or create) a user's stat entry using whatever we currently know
// about them - their live client object if connected, otherwise whatever
// was already on file.
function touchUserStatsById(userId) {
  const c = [...clients.values()].find(cl => cl.id === userId);
  const existing = userStats.get(userId);
  const username = c ? c.username : (existing ? existing.username : `User${userId}`);
  const ip = c ? c.ip : (existing ? existing.ip : null);
  const stat = {
    id: userId,
    username,
    ip,
    messagesSent: existing ? (existing.messagesSent || 0) : 0,
    servers: computeUserServers(userId)
  };
  userStats.set(userId, stat);
  saveUserStats();
}

function incrementMessageCount(client) {
  let stat = userStats.get(client.id);
  if (!stat) {
    stat = { id: client.id, username: client.username, ip: client.ip, messagesSent: 0, servers: computeUserServers(client.id) };
    userStats.set(client.id, stat);
  }
  stat.username = client.username;
  stat.ip = client.ip || stat.ip;
  stat.messagesSent = (stat.messagesSent || 0) + 1;
  saveUserStats();
}
// ---------------------------------------------------------------------------

// SECURITY: refuse to grant super-admin at all until a real secret is configured,
// so the feature can't be trivially unlocked using the shipped placeholder value.
if (SUPER_ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD_PLACEHOLDER) {
  console.warn('[SECURITY WARNING] SUPER_ADMIN_PASSWORD is not set (using placeholder). ' +
    'Super-admin login is DISABLED until you set a strong random SUPER_ADMIN_PASSWORD env var.');
}

// SECURITY: identity map so a client can't just "type in" someone else's numeric ID
// and inherit their DM history / server memberships. id -> secret auth token.
const authTokens = new Map();

// SECURITY: only accept small, well-formed base64 image data URLs for avatars/icons.
// This blocks (a) HTML/attribute-injection XSS via crafted avatar/icon strings and
// (b) loading of arbitrary external URLs (privacy/IP leak, SSRF-ish pixel tracking).
const MAX_IMAGE_DATA_URL_LENGTH = 2_000_000; // ~1.5MB decoded
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
function sanitizeImage(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
  if (!IMAGE_DATA_URL_RE.test(value)) return null;
  return value;
}

function genNumericId() {
  let id;
  do { id = Math.floor(1000000000 + Math.random() * 9000000000).toString(); }
  while (authTokens.has(id));
  return id;
}
function genAuthToken() { return crypto.randomBytes(24).toString('hex'); }

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

  // SECURITY: make sure the resolved path can never escape __dirname (blocks
  // "../" traversal, e.g. a request for /../t9_private_data/user_stats.json
  // or /../../etc/passwd). This also guarantees the private stats file -
  // which deliberately lives outside __dirname - can never be served, even
  // by accident.
  const rootDir = path.resolve(__dirname) + path.sep;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(rootDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

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

function isOwnerOrAdmin(srv, clientId) { return !!srv && (srv.ownerId === clientId || superAdmins.has(clientId)); }
function isStaff(srv, clientId) { return isOwnerOrAdmin(srv, clientId) || (srv.mods||[]).includes(clientId); }

function ensureDefaultServer() {
  let srv = [...servers.values()].find(s => s.inviteCode === DEFAULT_INVITE_CODE);
  if (!srv) {
    srv = makeServer('T9 Network', null, uid());
    srv.inviteCode = DEFAULT_INVITE_CODE;
    saveData();
  }
  return srv;
}
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
    mods: srv.mods || [],
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
function saveDataNow() {
  const data = { servers: {}, dms: {}, channelMsgs: {}, userIdCounter, authTokens: Object.fromEntries(authTokens) };
  servers.forEach((srv, id) => {
    data.servers[id] = {
      id: srv.id, name: srv.name, icon: srv.icon,
      ownerId: srv.ownerId, mods: srv.mods || [], inviteCode: srv.inviteCode,
      members: srv.members, channels: srv.channels
    };
  });
  dmMessages.forEach((msgs, key) => { data.dms[key] = msgs; });

  // FIX: Actually save the channel messages!
  channelMessages.forEach((msgs, channelId) => { data.channelMsgs[channelId] = msgs; });

  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch(e) { console.error('Save error:', e); }
}

function saveData() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveDataNow();
    saveTimeout = null;
  }, 500);
}

// FIX: Save immediately before PM2 kills the process during a deploy
process.on('SIGINT', () => { saveDataNow(); saveUserStats(); process.exit(0); });
process.on('SIGTERM', () => { saveDataNow(); saveUserStats(); process.exit(0); });

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      userIdCounter = data.userIdCounter || 1;
      if (data.servers) {
        Object.entries(data.servers).forEach(([id, srv]) => {
          srv.voiceState = {};
          if (!srv.mods) srv.mods = [];
          servers.set(id, srv);
        });
      }
      if (data.dms) {
        Object.entries(data.dms).forEach(([key, msgs]) => {
          dmMessages.set(key, msgs);
        });
      }
      // FIX: Actually load the channel messages!
      if (data.channelMsgs) {
        Object.entries(data.channelMsgs).forEach(([channelId, msgs]) => {
          channelMessages.set(channelId, msgs);
        });
      }
      if (data.authTokens) {
        Object.entries(data.authTokens).forEach(([id, token]) => authTokens.set(id, token));
      }
      console.log(`Loaded ${servers.size} servers and ${dmMessages.size} DM histories`);
    }
  } catch(e) { console.error('Load error:', e); }
}

wss.on('connection', (ws, req) => {
  // Capture the connecting IP up front so it's available once 'init' arrives.
  ws._ip = getClientIp(req);

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
  // SECURITY: verify the client actually owns the id it's claiming via a secret
  // auth token minted by us on first connect. If the id is unknown, or the token
  // doesn't match, issue a brand new identity instead of trusting the client's claim.
  // This is what stops "type in someone else's numeric ID" account takeover.
  let id = typeof data.clientId === 'string' ? data.clientId.slice(0, 32) : null;
  let token = typeof data.authToken === 'string' ? data.authToken.slice(0, 128) : null;
  let issuedNewIdentity = false;

  if (!id || !authTokens.has(id) || authTokens.get(id) !== token) {
    id = genNumericId();
    token = genAuthToken();
    authTokens.set(id, token);
    issuedNewIdentity = true;
    saveData();
  }

  const color = COLORS[Math.abs(hashString(id)) % COLORS.length];
  const client = {
    id, ws,
    username: data.username ? String(data.username).slice(0, 32) : `User${id.slice(0,4)}`,
    color, avatar: sanitizeImage(data.avatar),
    ip: ws._ip || null,
    currentChannel: null, voiceChannel: null, dmVoicePeer: null,
    msgTimestamps: [],
  };
clients.set(ws, client);
  if (data.adminKey && SUPER_ADMIN_PASSWORD !== DEFAULT_ADMIN_PASSWORD_PLACEHOLDER && data.adminKey === SUPER_ADMIN_PASSWORD) {
    superAdmins.add(id);
  }

  const defaultSrv = ensureDefaultServer();
  if (!defaultSrv.members.includes(client.id)) {
    defaultSrv.members.push(client.id);
    saveData();
  }

  // Record/refresh this user's entry in the private stats file (username,
  // IP, current server list). Message counts are untouched here.
  touchUserStatsById(client.id);

  const dmHistory = {};
  dmMessages.forEach((msgs, key) => {
    const [a, b] = key.split('|');
    if (a == client.id || b == client.id) {
      const otherId = a == client.id ? b : a;
      dmHistory[otherId] = msgs;
    }
  });

sendTo(ws, {
    type: 'init', id: client.id, authToken: token, identityReset: issuedNewIdentity,
    username: client.username, color: client.color, avatar: client.avatar,
    servers: getUserServers(client.id),
    onlineUsers: getOnlineUsers(),
    dmHistory,
    isSuperAdmin: superAdmins.has(id)
  });

  broadcast({ type: 'user_join', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar } }, c => c.id !== client.id);
}

// SECURITY: crude flood/spam guard - max 8 chat/DM sends per 5s per connection.
function isRateLimited(client) {
  const now = Date.now();
  client.msgTimestamps = client.msgTimestamps.filter(t => now - t < 5000);
  if (client.msgTimestamps.length >= 8) return true;
  client.msgTimestamps.push(now);
  return false;
}

function handleMessage(ws, client, data) {
  switch (data.type) {
    case 'update_profile':
      if (data.username) client.username = String(data.username).slice(0, 32);
      if (data.avatar !== undefined) client.avatar = sanitizeImage(data.avatar);
      touchUserStatsById(client.id);
      broadcast({ type: 'user_updated', user: { id: client.id, username: client.username, color: client.color, avatar: client.avatar } });
      break;

    case 'chat': {
      const { serverId, channelId, content } = data;
      if (!serverId || !channelId || !content) return;
      if (isRateLimited(client)) { sendTo(ws, { type: 'error', message: 'Sending too fast, slow down.' }); return; }
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
      incrementMessageCount(client);
      clients.forEach(c => {
        if (srv.members.includes(c.id) && c.currentChannel?.channelId === channelId) sendTo(c.ws, msg);
      });
      break;
    }

    case 'dm': {
      const { to, content } = data;
      if (!to || !content) return;
      if (isRateLimited(client)) { sendTo(ws, { type: 'error', message: 'Sending too fast, slow down.' }); return; }
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
      incrementMessageCount(client);

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
      if (typeof name !== 'string' || !name.trim()) return;
      const srv = makeServer(name.trim().slice(0, 100), sanitizeImage(icon), client.id);
      touchUserStatsById(client.id);
      sendTo(ws, { type: 'server_created', server: serializeServer(srv) });
      break;
    }

    case 'update_server': {
      const { serverId, name, icon } = data;
      const srv = servers.get(serverId);
      if (!srv || !isOwnerOrAdmin(srv, client.id)) return;
      if (typeof name === 'string' && name.trim()) srv.name = name.slice(0, 100);
      if (icon !== undefined) srv.icon = sanitizeImage(icon);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      srv.members.forEach(touchUserStatsById);
      break;
    }

   case 'delete_server': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isOwnerOrAdmin(srv, client.id)) return;
      const affectedMembers = [...srv.members];
      servers.delete(serverId);
      broadcast({ type: 'server_deleted', serverId }, c => affectedMembers.includes(c.id));
      saveData();
      affectedMembers.forEach(touchUserStatsById);
      break;
    }

   case 'join_server': {
      const { inviteCode: code } = data;
      if (typeof code !== 'string' || !code.trim()) return;
      const srv = [...servers.values()].find(s => s.inviteCode === code.toUpperCase());
      if (!srv) { sendTo(ws, { type: 'error', message: 'Invalid invite code.' }); return; }
      if (srv.members.includes(client.id)) { sendTo(ws, { type: 'error', message: 'Already in that server.' }); return; }
      srv.members.push(client.id);
      sendTo(ws, { type: 'server_joined', server: serializeServer(srv) });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id) && c.id !== client.id);
      saveData();
      touchUserStatsById(client.id);
      break;
    }

    case 'list_servers': {
      const list = [...servers.values()].map(s => ({ id: s.id, name: s.name, icon: s.icon, memberCount: s.members.length }));
      sendTo(ws, { type: 'server_list', servers: list });
      break;
    }

    case 'join_server_by_id': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv) { sendTo(ws, { type: 'error', message: 'Server not found.' }); return; }
      if (srv.members.includes(client.id)) { sendTo(ws, { type: 'error', message: 'Already in that server.' }); return; }
      srv.members.push(client.id);
      sendTo(ws, { type: 'server_joined', server: serializeServer(srv) });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id) && c.id !== client.id);
      saveData();
      touchUserStatsById(client.id);
      break;
    }

    case 'leave_server': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || !srv.members.includes(client.id)) return;
      if (srv.ownerId === client.id) { sendTo(ws, { type: 'error', message: 'Owners cannot leave.' }); return; }
      srv.members = srv.members.filter(id => id !== client.id);
      srv.mods = (srv.mods || []).filter(id => id !== client.id);
      sendTo(ws, { type: 'server_left', serverId });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      touchUserStatsById(client.id);
      break;
    }

    case 'kick_member': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isStaff(srv, client.id)) return;
      if (userId === client.id) return;
      if (userId === srv.ownerId || superAdmins.has(userId)) return;
      srv.members = srv.members.filter(id => id !== userId);
      srv.mods = (srv.mods || []).filter(id => id !== userId);
      const target = [...clients.values()].find(c => c.id === userId);
      if (target) sendTo(target.ws, { type: 'kicked', serverId });
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      touchUserStatsById(userId);
      break;
    }

 case 'add_mod': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isOwnerOrAdmin(srv, client.id)) return;
      if (!srv.mods) srv.mods = [];
      if (!srv.mods.includes(userId)) srv.mods.push(userId);
      if (!srv.members.includes(userId)) srv.members.push(userId);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      touchUserStatsById(userId);
      break;
    }

    case 'remove_mod': {
      const { serverId, userId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isOwnerOrAdmin(srv, client.id)) return;
      srv.mods = (srv.mods || []).filter(id => id !== userId);
      broadcast({ type: 'server_updated', server: serializeServer(srv) }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

   case 'add_channel': {
      const { serverId, channelType, name } = data;
      const srv = servers.get(serverId);
      if (!srv || !isStaff(srv, client.id)) return;
      if (!['text','voice'].includes(channelType)) return;
      if (typeof name !== 'string' || !name.trim()) return;
      const ch = { id: uid(), name: name.trim().slice(0, 50), type: channelType };
      srv.channels.push(ch);
      broadcast({ type: 'channel_added', serverId, channel: ch }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

    case 'remove_channel': {
      const { serverId, channelId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isStaff(srv, client.id)) return;
      srv.channels = srv.channels.filter(c => c.id !== channelId);
      broadcast({ type: 'channel_removed', serverId, channelId }, c => srv.members.includes(c.id));
      saveData();
      break;
    }

   case 'regenerate_invite': {
      const { serverId } = data;
      const srv = servers.get(serverId);
      if (!srv || !isOwnerOrAdmin(srv, client.id)) return;
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
loadUserStats();
ensureDefaultServer();
server.listen(PORT, () => console.log(`T9 Network running on port ${PORT}`));