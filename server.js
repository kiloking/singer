/**
 * [INPUT]: 依賴 express、ws、@hydralerne/youtube-api
 * [OUTPUT]: HTTP 伺服器 + WebSocket 廣播，提供 /api/search、/api/lyrics、/obs、主頁
 * [POS]: singer 專案入口，整合 API、靜態資源、OBS 同步通道
 * [PROTOCOL]: 變更時更新此頭部，然後檢查 CLAUDE.md
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { youtubeMusicSearch, getSongLyrics, getVideoId } from '@hydralerne/youtube-api';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

// -----------------------------------------------------------------------------
// WebSocket: OBS widget 與主頁同步播放進度
// -----------------------------------------------------------------------------
const wss = new WebSocketServer({ server });
const clients = new Set();
let lastSync = null;

wss.on('connection', (ws) => {
  clients.add(ws);
  if (lastSync) ws.send(JSON.stringify(lastSync));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  lastSync = data;
  const msg = JSON.stringify(data);
  clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

// 每秒重推最後狀態，避免 OBS 漏接
setInterval(() => {
  if (lastSync && clients.size > 0) {
    const msg = JSON.stringify(lastSync);
    clients.forEach((c) => {
      if (c.readyState === 1) c.send(msg);
    });
  }
}, 1000);

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

/** 搜尋 YT Music 歌曲 */
app.get('/api/search', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: '缺少 q 參數' });
  try {
    const results = await youtubeMusicSearch(q, 'songs');
    const items = Array.isArray(results) ? results : results?.error ? [] : [];
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 解析 LRC 字串為 [{ text, start, end }]，end 取下一行 start 或 start+5 */
function parseLrcString(lrc) {
  if (!lrc || typeof lrc !== 'string') return null;
  const LRC_RE = /^\[(\d{1,2}):(\d{2})\.(\d{2,3})\]\s*(.*)$/gm;
  const raw = [];
  let m;
  while ((m = LRC_RE.exec(lrc)) !== null) {
    const start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + parseInt(m[3].padEnd(3, '0'), 10) / 1000;
    const text = m[4].trim();
    if (text) raw.push({ text, start });
  }
  if (!raw.length) return null;
  return raw.map((r, i) => ({
    ...r,
    end: raw[i + 1] ? raw[i + 1].start : r.start + 5
  }));
}

/** 取得歌詞，優先 YT Music，無時間軸時用 LRCLIB 備援 */
app.get('/api/lyrics/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { title, artist, duration } = req.query;
  if (!videoId) return res.status(400).json({ error: '缺少 videoId' });
  try {
    let lyrics = await getSongLyrics(videoId);
    if (lyrics?.error) lyrics = null;
    const hasSynced = Array.isArray(lyrics?.synced) && lyrics.synced.length > 0;

    if (!hasSynced && title && artist) {
      const durationSec = duration ? parseInt(duration, 10) : 0;
      const lrc = await fetchLrclib(title, artist, isNaN(durationSec) ? 0 : durationSec);
      if (lrc) {
        const synced = parseLrcString(lrc);
        if (synced) {
          lyrics = lyrics || {};
          lyrics.synced = synced;
          lyrics.lines = synced.map((s) => ({ text: s.text }));
        }
      }
    }
    res.json({ lyrics: lyrics || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function fetchLrclib(title, artist, durationSec) {
  const params = new URLSearchParams({ track_name: title, artist_name: artist });
  const res = await fetch(`https://lrclib.net/api/search?${params}`, {
    headers: { 'User-Agent': 'Singer/1.0 (https://github.com/vibe-app/singer)' }
  });
  if (!res.ok) return null;
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;
  const withSynced = list.filter((r) => r.syncedLyrics);
  if (!withSynced.length) return null;
  if (durationSec && withSynced.length > 1) {
    const best = withSynced.reduce((a, b) =>
      Math.abs((a.duration || 0) - durationSec) <= Math.abs((b.duration || 0) - durationSec) ? a : b
    );
    return best.syncedLyrics;
  }
  return withSynced[0].syncedLyrics;
}

/** 透過歌名取得 videoId（備用） */
app.get('/api/video-id', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: '缺少 q 參數' });
  try {
    const id = await getVideoId(q, false);
    res.json({ videoId: id || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 主頁發送播放進度，廣播給 OBS widget */
app.post('/api/sync', (req, res) => {
  const { videoId, currentTime, lyrics, title, duration, lyricsColor } = req.body;
  broadcast({
    videoId,
    currentTime: Number(currentTime) || 0,
    lyrics,
    title,
    duration: Number(duration) || 0,
    lyricsColor: lyricsColor || '#ffd700'
  });
  res.json({ ok: true });
});

/** OBS 頁面輪詢取得當前狀態（比 WebSocket 更可靠） */
app.get('/api/sync/state', (_, res) => {
  res.json(lastSync || {});
});

// -----------------------------------------------------------------------------
// 路由
// -----------------------------------------------------------------------------
app.get('/', (_, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.get('/obs', (_, res) => res.sendFile(join(__dirname, 'public', 'obs.html')));

// -----------------------------------------------------------------------------
// 啟動
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 3847;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Singer 已啟動: http://localhost:${PORT}`);
  console.log(`OBS 掛載 URL: http://localhost:${PORT}/obs`);
});
