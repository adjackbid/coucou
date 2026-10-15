# Agent Center · 60 秒動畫

對應影片:`docs/media/agent-center-60s.mp4`(1920×1080 · 24 fps · 正好 60.000 秒)。字幕燒在畫面上;音樂與音效是程式合成的暫代版(與 `ai-team-60s_v1.mp4`、`agent-company-90s.mp4` 同一做法)。

- `stage.html`:整支片子。每一幀都是時間的函數(`draw(t)`),用瀏覽器打開會自動播放;`?t=12.3` 看某一瞬間。截圖來自 `docs/team-report/img/`。
- `render.js`:用本機 Chrome 逐幀輸出 JPEG(`node render.js <frames 資料夾>`;`--probe 1.5,7.2` 只輸出幾張 PNG 來看;`--range 912-1080` 只重算一段)。需要 `npm i playwright-core`。
- `music.js`:合成配樂與音效(`node music.js music.wav`)。124 BPM,A 小調 → 45 秒轉 C 大調;57.0–57.3 秒留白,57.3 重擊,59.3 淡出。音效 cue 與 `stage.html` 的時間點一致。

## 重建

```
node music.js music.wav
node render.js frames
ffmpeg -y -framerate 24 -i frames/%04d.jpg -i music.wav -t 60 -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow -c:a aac -b:a 192k -movflags +faststart ../../../docs/media/agent-center-60s.mp4
```

## 分段(秒)

| 時間 | 場景 |
|---|---|
| 0–4 | 片名:四隻 Mochi、Agent Center |
| 4–10 | 人類瓶頸:四個終端機都要經過你,蓋上「人類瓶頸」 |
| 10–17 | 編排中樞:Agent Center、Meta Agent、四位 Member Agent 與基底 Agent、模型 |
| 17–25 | 拆任務與並行:任務卡飛出、時間軸同時推進、相依 |
| 25–32 | 權限閘門與憲法:放行、核准卡、直接擋下 |
| 32–38 | 知識庫:可見性、分發、金鑰攔下 |
| 38–45 | 交付與驗收:退回一次、全部驗收、team_finish |
| 45–52 | 實際畫面:看板、Office、協作關係、秘書、成本 |
| 52–57 | 兩個案例:會議紀錄功能、專案管理平台;riser |
| 57–60 | 留白、重擊、片名、淡出 |
