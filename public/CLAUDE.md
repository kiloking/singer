# singer/public/

> L2 | 父級: singer/CLAUDE.md

## 成員清單

- `index.html`: 主頁 UI，搜尋欄、結果列表、播放區、歌詞區、OBS URL 提示
- `app.js`: 搜尋、選曲、YouTube 播放、歌詞渲染、LRC 解析、sync 廣播
- `obs.html`: OBS Browser Source 專用頁，透明背景，輪詢 /api/sync/state，多行歌詞依演唱順序同步呈現（當前高亮、其餘變暗、右下角時間戳），無時間軸時依 duration 估算

法則: 成員完整 · 一行一文件 · 父級鏈接

[PROTOCOL]: 變更時更新此頭部，然後檢查 CLAUDE.md
