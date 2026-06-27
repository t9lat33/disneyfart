const express = require('express');
const { execFile } = require('child_process');
const http = require('http');
const https = require('https');
const app = express();

const PORT = 4501;
const YTDLP = 'yt-dlp';

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });
}

app.get('/api/search', async (req, res) => {
  const q = req.query.query;
  if (!q) return res.json({ results: [] });

  try {
    const raw = await ytdlp([
      `ytsearch15:${q}`,
      '--dump-json',
      '--flat-playlist',
      '--no-warnings',
      '--js-runtimes', 'node',
      '--remote-components', 'ejs:github'
    ]);

    const results = raw.split('\n').filter(Boolean).map(line => {
      try {
        const v = JSON.parse(line);
        return {
          id: v.id,
          title: v.title,
          thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
          duration: v.duration,
          uploader: v.uploader
        };
      } catch { return null; }
    }).filter(Boolean);

    res.json({ results });
  } catch (e) {
    console.error('search error:', e);
    res.status(500).json({ results: [], error: String(e) });
  }
});

app.get('/api/fetch', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'no url' });

  try {
    const raw = await ytdlp([
      url,
      '--dump-json',
      '--no-warnings',
      '--format', 'best[ext=mp4]/best',
      '--js-runtimes', 'node',
      '--remote-components', 'ejs:github'
    ]);

    const info = JSON.parse(raw);
    const mediaUrl = info.url || (info.formats && info.formats.slice(-1)[0].url);

    res.json({ medias: [{ url: mediaUrl, ext: info.ext, title: info.title }] });
  } catch (e) {
    console.error('fetch error:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/encode', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('no url');

  const mod = url.startsWith('https') ? https : http;

  mod.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://www.youtube.com/'
    }
  }, upstream => {
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp4');
    if (upstream.headers['content-length'])
      res.setHeader('Content-Length', upstream.headers['content-length']);
    res.setHeader('Accept-Ranges', 'bytes');
    upstream.pipe(res);
  }).on('error', e => {
    console.error('proxy error:', e);
    res.status(500).send('proxy error');
  });
});

app.listen(PORT, () => console.log(`T9 Tube backend on :${PORT}`));