# Singer - 自動歌詞工具

> 搜尋 YT Music 歌詞，KTV 字幕模式，OBS 掛載 | Node.js + Express + WebSocket

<directory>

```
singer/
├── server.js          # 入口：API、WebSocket、靜態服務
├── public/
│   ├── index.html    # 主頁：搜尋、播放、歌詞
│   ├── app.js        # 主頁邏輯
│   └── obs.html      # OBS 掛載頁（透明背景）
├── package.json
├── Dockerfile        # 雲端部署用
├── .dockerignore
└── CLAUDE.md
```

</directory>

<config>

- `package.json` - 依賴 @hydralerne/youtube-api、express、ws
- `PORT` 預設 3847，可設環境變數覆蓋

</config>

## 核心流程

1. **搜尋** `/api/search?q=` → YT Music 歌曲列表
2. **歌詞** `/api/lyrics/:videoId?title=&artist=&duration=` → getSongLyrics，若無 synced 則 LRCLIB 備援
3. **主頁** 選擇歌曲 → YouTube 嵌入播放 → 歌詞 KTV 高亮 → POST `/api/sync`（帶 sid）
4. **OBS** 開啟 `/obs?sid=xxx` → 輪詢 `/api/sync/state?sid=xxx` → 顯示歌詞 overlay
5. **多人隔離**：每人有獨立 sid，sync 狀態以 sid 分開儲存

## Phase 1（已完成）

1. **Provider 鏈**：YT Music → LRCLIB → YouTube Captions（依序 fallback）
2. **YouTube Captions**：youtube-transcript 從影片 CC 取得時間軸
3. **OBS 顯示**：多行歌詞、當前句高亮、其餘變暗、右下角時間戳

## 法則

極簡 · 單一職責 · 文檔與代碼同構
