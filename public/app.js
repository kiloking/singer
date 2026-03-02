/**
 * [INPUT]: 依賴 YouTube IFrame API、fetch、DOM
 * [OUTPUT]: 搜尋、播放、歌詞 KTV 顯示、同步廣播至 OBS
 * [POS]: singer 主頁面邏輯，與 server API 及 OBS widget 協同
 * [PROTOCOL]: 變更時更新此頭部，然後檢查 CLAUDE.md
 */

const API = '/api';
let ytPlayer = null;
let currentTrack = null;
let lyricsData = null;
let syncInterval = null;
let lyricsColor = '#ffd700';

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const resultsEl = document.getElementById('results');
const ytEmbed = document.getElementById('ytEmbed');
const lyricsBox = document.getElementById('lyricsBox');
const obsUrlEl = document.getElementById('obsUrl');

// 更新 OBS URL 為當前 host
obsUrlEl.textContent = `${location.origin}/obs`;

// -----------------------------------------------------------------------------
// 搜尋
// -----------------------------------------------------------------------------
async function search() {
  const q = searchInput.value.trim();
  if (!q) return;
  searchBtn.disabled = true;
  resultsEl.innerHTML = '<div class="empty">搜尋中...</div>';
  try {
    const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}`);
    const { items } = await res.json();
    renderResults(items || []);
  } catch (e) {
    resultsEl.innerHTML = `<div class="empty">搜尋失敗: ${e.message}</div>`;
  }
  searchBtn.disabled = false;
}

function renderResults(items) {
  if (!items.length) {
    resultsEl.innerHTML = '<div class="empty">找不到結果</div>';
    return;
  }
  resultsEl.innerHTML = items.map((t) => `
    <div class="result-item" data-id="${t.id}" data-title="${escapeHtml(t.title || '')}" data-artist="${escapeHtml(t.artist || '')}" data-duration="${t.duration || 0}">
      <img src="${t.poster || ''}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22><rect fill=%22%23333%22 width=%2248%22 height=%2248%22/></svg>'">
      <div class="meta">
        <div class="title">${escapeHtml(t.title || '')}</div>
        <div class="artist">${escapeHtml(t.artist || '')}</div>
      </div>
    </div>
  `).join('');
  resultsEl.querySelectorAll('.result-item').forEach((el) => {
    el.addEventListener('click', () => selectTrack(el.dataset));
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// -----------------------------------------------------------------------------
// 選擇歌曲
// -----------------------------------------------------------------------------
async function selectTrack({ id, title, artist, duration }) {
  currentTrack = { videoId: id, title, artist, duration: parseInt(duration, 10) || 0 };
  stopSync();
  loadPlayer(id);
  await loadLyrics(id);
}

function loadPlayer(videoId) {
  if (!ytPlayer) {
    ytEmbed.innerHTML = '<div id="ytPlayer"></div>';
    ytPlayer = new YT.Player('ytPlayer', {
      width: '100%',
      height: '100%',
      videoId,
      playerVars: { autoplay: 0 },
      events: { onStateChange: onPlayerStateChange }
    });
  } else {
    ytPlayer.loadVideoById(videoId);
  }
}

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.PLAYING) startSync();
  if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) stopSync();
}

// -----------------------------------------------------------------------------
// 歌詞
// -----------------------------------------------------------------------------
async function loadLyrics(videoId) {
  lyricsBox.innerHTML = '<div class="empty">載入歌詞中...</div>';
  lyricsData = null;
  const q = new URLSearchParams();
  if (currentTrack?.title) q.set('title', currentTrack.title);
  if (currentTrack?.artist) q.set('artist', currentTrack.artist);
  if (currentTrack?.duration) q.set('duration', Math.round(currentTrack.duration / 1000));
  try {
    const res = await fetch(`${API}/lyrics/${videoId}?${q}`);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const msg = text?.trim() || '';
      if (msg === 'Not Found' || res.status === 404) {
        throw new Error('找不到歌詞，請稍後再試');
      }
      throw new Error(res.ok ? '回應格式錯誤' : `伺服器錯誤 (${res.status})`);
    }
    const { lyrics } = data;
    lyricsData = lyrics;
    renderLyrics(lyrics);
  } catch (e) {
    lyricsBox.innerHTML = `<div class="empty">無法取得歌詞: ${e.message}</div>`;
  }
}

/** 解析 LRC 格式 [mm:ss.xx] 歌詞，回傳 { text, start, end }[] */
function parseLrcLines(lines) {
  const LRC_RE = /^\[(\d{1,2}):(\d{2})\.(\d{2,3})\]\s*(.*)$/;
  const out = [];
  for (const raw of lines) {
    const t = typeof raw === 'object' ? raw.text : raw;
    const m = String(t).match(LRC_RE);
    if (m) {
      const start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + parseInt(m[3].padEnd(3, '0'), 10) / 1000;
      out.push({ text: m[4].trim(), start, end: start + 4 });
    } else if (t && !/^\[[\w:]+\]/.test(t)) {
      out.push({ text: t, start: 0, end: 0 });
    }
  }
  if (out.length && out.some((x) => x.start > 0)) return out;
  return null;
}

function estimateSyncedFromDuration(lines, durationMs) {
  if (!lines.length || !durationMs) return null;
  const sec = durationMs / 1000;
  const span = sec / lines.length;
  return lines.map((l, i) => ({
    text: typeof l === 'object' ? l.text : l,
    start: i * span,
    end: (i + 1) * span
  }));
}

function renderLyrics(lyrics) {
  if (!lyrics) {
    lyricsBox.innerHTML = '<div class="empty">此歌曲無歌詞</div>';
    return;
  }
  const rawLines = (lyrics.lines || []).map((l) => l.text || l);
  const lrcParsed = parseLrcLines(rawLines);
  let synced = (lyrics.synced && lyrics.synced.length > 0) ? lyrics.synced : lrcParsed;
  if (!synced && rawLines.length && currentTrack?.duration) {
    synced = estimateSyncedFromDuration(lyrics.lines || rawLines.map((t) => ({ text: t })), currentTrack.duration);
  }
  if (synced) lyricsData = { ...lyrics, synced };
  const items = synced || rawLines.map((t) => ({ text: t, start: 0, end: 0 }));
  if (!items.length) {
    lyricsBox.innerHTML = '<div class="empty">無歌詞內容</div>';
    return;
  }
  lyricsBox.innerHTML = items.map((_, i) =>
    `<div class="lyrics-line" data-idx="${i}" data-start="${items[i].start}" data-end="${items[i].end}">${escapeHtml(items[i].text)}</div>`
  ).join('');
}

function updateLyricsHighlight(currentTime) {
  if (!lyricsData || !lyricsBox) return;
  const synced = lyricsData.synced && lyricsData.synced.length > 0;
  const lines = lyricsBox.querySelectorAll('.lyrics-line');
  if (!lines.length) return;
  let activeIdx = -1;
  if (synced) {
    for (let i = 0; i < lines.length; i++) {
      const start = parseFloat(lines[i].dataset.start) || 0;
      const end = parseFloat(lines[i].dataset.end) || 0;
      if (currentTime >= start && currentTime < end) {
        activeIdx = i;
        break;
      }
      if (currentTime >= end) activeIdx = i;
    }
  }
  lines.forEach((el, i) => {
    el.classList.remove('active', 'past');
    if (i === activeIdx) el.classList.add('active');
    else if (activeIdx >= 0 && i < activeIdx) el.classList.add('past');
  });
}

// -----------------------------------------------------------------------------
// 同步廣播 (給 OBS widget)
// -----------------------------------------------------------------------------
function startSync() {
  if (syncInterval) return;
  syncInterval = setInterval(() => {
    if (!ytPlayer || !currentTrack) return;
    const t = ytPlayer.getCurrentTime?.();
    if (typeof t !== 'number' || t < 0) return;
    updateLyricsHighlight(t);
    fetch(`${API}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: currentTrack.videoId,
        currentTime: t,
        lyrics: lyricsData,
        title: currentTrack.title,
        duration: currentTrack.duration ? Math.round(currentTrack.duration / 1000) : 0,
        lyricsColor
      })
    }).catch(() => {});
  }, 80);
}

function stopSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// -----------------------------------------------------------------------------
// 歌詞顏色
// -----------------------------------------------------------------------------
function setLyricsColor(color) {
  lyricsColor = color;
  document.documentElement.style.setProperty('--highlight', color);
  document.querySelectorAll('.color-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.color === color));
  document.getElementById('colorInput').value = color;
}

document.querySelectorAll('.color-btn').forEach((btn) => {
  btn.addEventListener('click', () => setLyricsColor(btn.dataset.color));
});
document.getElementById('colorInput').addEventListener('input', (e) => setLyricsColor(e.target.value));

// 預設選中金色
document.querySelector('.color-btn[data-color="#ffd700"]')?.classList.add('active');

// -----------------------------------------------------------------------------
// 初始化
// -----------------------------------------------------------------------------
searchBtn.addEventListener('click', search);
searchInput.addEventListener('keydown', (e) => e.key === 'Enter' && search());

// YouTube API 載入
window.onYouTubeIframeAPIReady = () => {};
