/**
 * [INPUT]: 依賴 express、@hydralerne/youtube-api、youtube-transcript
 * [OUTPUT]: HTTP 伺服器，提供 /api/search、/api/lyrics、/obs、sync（依 sid 隔離）
 * [POS]: singer 專案入口，整合 API、靜態資源、OBS 同步通道
 * [PROTOCOL]: 變更時更新此頭部，然後檢查 CLAUDE.md
 */

import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { youtubeMusicSearch, getSongLyrics, getVideoId } from '@hydralerne/youtube-api';
import { YoutubeTranscript } from 'youtube-transcript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

// -----------------------------------------------------------------------------
// Sync 狀態：以 sid 隔離，多人同時使用互不干擾
// -----------------------------------------------------------------------------
const syncBySid = new Map();
const SID_TTL_MS = 24 * 60 * 60 * 1000; // 24h 未用則清理

function setSync(sid, data) {
  if (!sid) return;
  syncBySid.set(sid, { data, at: Date.now() });
}

function getSync(sid) {
  if (!sid) return null;
  const entry = syncBySid.get(sid);
  return entry ? entry.data : null;
}

// 定期清理過期 session
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of syncBySid.entries()) {
    if (now - entry.at > SID_TTL_MS) syncBySid.delete(sid);
  }
}, 60 * 60 * 1000);

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

/** YouTube 影片 CC 字幕 → [{ text, start, end }] */
async function fetchYtCaptions(videoId) {
  try {
    const items = await YoutubeTranscript.fetchTranscript(videoId);
    if (!Array.isArray(items) || !items.length) return null;
    return items.map(({ text, offset, duration }) => ({
      text: String(text || '').trim(),
      start: Number(offset) || 0,
      end: (Number(offset) || 0) + (Number(duration) || 0)
    })).filter((s) => s.text);
  } catch {
    return null;
  }
}

/** Provider 鏈：YT Music → LRCLIB → YouTube Captions */
app.get('/api/lyrics/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { title, artist, duration } = req.query;
  if (!videoId) return res.status(400).json({ error: '缺少 videoId' });
  try {
    let lyrics = null;
    let synced = null;

    // 1. YT Music
    try {
      lyrics = await getSongLyrics(videoId);
      if (lyrics?.error) lyrics = null;
      synced = Array.isArray(lyrics?.synced) && lyrics.synced.length > 0 ? lyrics.synced : null;
    } catch {
      lyrics = null;
    }

    // 2. LRCLIB（需 title + artist）
    if (!synced && title && artist) {
      const durationSec = duration ? parseInt(duration, 10) : 0;
      const lrc = await fetchLrclib(title, artist, isNaN(durationSec) ? 0 : durationSec);
      synced = lrc ? parseLrcString(lrc) : null;
      if (synced) lyrics = { synced, lines: synced.map((s) => ({ text: s.text })) };
    }

    // 3. YouTube Captions（影片 CC）
    if (!synced) {
      synced = await fetchYtCaptions(videoId);
      if (synced) lyrics = { synced, lines: synced.map((s) => ({ text: s.text })) };
    }

    res.json({ lyrics: lyrics || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function fetchLrclib(title, artist, durationSec) {
  const params = new URLSearchParams({ track_name: title, artist_name: artist });
  const res = await fetch(`https://lrclib.net/api/search?${params}`, {
    headers: { 'User-Agent': 'Singer/1.0 (https://github.com/kiloking/singer)' }
  });
  if (!res.ok) return null;
  const text = await res.text();
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
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

/** 主頁發送播放進度，依 sid 儲存（多人隔離） */
app.post('/api/sync', (req, res) => {
  const { sid, videoId, currentTime, lyrics, title, duration, lyricsColor } = req.body;
  if (!sid) return res.status(400).json({ error: '缺少 sid' });
  setSync(sid, {
    videoId,
    currentTime: Number(currentTime) || 0,
    lyrics,
    title,
    duration: Number(duration) || 0,
    lyricsColor: lyricsColor || '#ffd700'
  });
  res.json({ ok: true });
});

/** OBS 頁面輪詢取得當前狀態（需帶 sid） */
app.get('/api/sync/state', (req, res) => {
  const sid = req.query.sid;
  res.json(getSync(sid) || {});
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
