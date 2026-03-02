# Singer - 自動歌詞工具

搜尋 YouTube Music 歌詞，KTV 字幕模式，可導出 URL 供 OBS 掛載。

## 功能

- **搜尋**：輸入歌名或歌手，從 YT Music 搜尋
- **KTV 歌詞**：選擇歌曲後顯示歌詞，播放時高亮當前行
- **OBS 掛載**：複製 `/obs` 頁面 URL，在 OBS 新增 Browser Source 貼上即可

## 使用

```bash
cd singer
npm install
npm start
```

瀏覽器開啟 http://localhost:3847

## OBS 設定

1. 開啟主頁，網址會自動帶上 `?sid=xxx`（每人獨立）
2. OBS → 來源 → 新增 → 瀏覽器
3. URL 填主頁顯示的 OBS 網址（含 `?sid=xxx`，多人使用互不干擾）
4. 寬高建議 1920×1080，背景透明
5. 在主頁選擇歌曲並播放，OBS 畫面會同步顯示歌詞

## 雲端部署

### Render（推薦，免費方案）

1. 推送到 GitHub
2. [render.com](https://render.com) → New → Web Service
3. 連線 repo，若 singer 在子目錄則 Root Directory 填 `singer`
4. Build: `npm install`，Start: `npm start`
5. 部署完成後，OBS URL 改為 `https://你的服務名.onrender.com/obs`

### Railway

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. 選 singer 目錄（若在 monorepo 需設定 Root Directory）
3. 自動偵測 Node.js，部署完成取得 URL

### Docker

```bash
docker build -t singer .
docker run -p 3847:3847 singer
```

## 技術

- Node.js + Express
- @hydralerne/youtube-api（YT Music 搜尋與歌詞）
- youtube-transcript（影片 CC 字幕備援）
- LRCLIB（社群歌詞備援）
- Provider 鏈：YT Music → LRCLIB → YouTube Captions
