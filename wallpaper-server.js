// wallpaper-server.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.WALLPAPER_PORT || 4021;
const API_KEY = process.env.WALLPAPER_API_KEY; // shared secret with the Discord bot

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'wallpapers.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{}');

function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// CORS so t9os.space (served from same or different origin) can fetch this
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/wallpapers/files', express.static(UPLOAD_DIR, { maxAge: '30d' }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${id}${ext}`);
  }
});

const ALLOWED_MIME = ['image/png','image/jpeg','image/gif','image/webp','video/mp4','video/webm'];
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) return cb(new Error('Unsupported file type'));
    cb(null, true);
  }
});

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Public: list wallpapers
app.get('/wallpapers', (req, res) => {
  res.json(readDB());
});

// Protected: add wallpaper (bot only)
// If a wallpaper with the same name already exists, it is overwritten
// (old file deleted, old entry replaced) instead of creating a duplicate.
app.post('/wallpapers', requireApiKey, upload.single('file'), (req, res) => {
  const { name, addedBy, addedById } = req.body;
  if (!name || !req.file) return res.status(400).json({ error: 'Missing name or file' });

  const isVideo = req.file.mimetype.startsWith('video/');
  const db = readDB();

  // Reuse existing entry if a wallpaper with this name already exists
  const existing = Object.entries(db).find(
    ([id, wp]) => wp.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    const [oldId, oldWp] = existing;
    const oldFilePath = path.join(UPLOAD_DIR, path.basename(oldWp.file));
    if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath); // remove old file from disk
    delete db[oldId];
  }

  const id = path.parse(req.file.filename).name;
  db[id] = {
    name,
    file: `/wallpapers/files/${req.file.filename}`,
    video: isVideo,
    addedBy: addedBy || 'unknown',
    addedById: addedById || null,
    timestamp: Date.now()
  };

  writeDB(db);
  res.json({ success: true, id, wallpaper: db[id] });
});

// Protected: remove wallpaper by name (bot only)
app.delete('/wallpapers/:name', requireApiKey, (req, res) => {
  const db = readDB();
  const entry = Object.entries(db).find(([id, wp]) => wp.name.toLowerCase() === req.params.name.toLowerCase());

  if (!entry) return res.status(404).json({ error: 'Not found' });

  const [id, wp] = entry;
  const filePath = path.join(UPLOAD_DIR, path.basename(wp.file));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  delete db[id];
  writeDB(db);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`Wallpaper API running on :${PORT}`));