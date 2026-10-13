# 協作軌道星域交付導覽

這套交付供 CouCou Teamwork 的實作 AI 接入「星域」顯示模式。定稿採用有深度的共同宇宙、光環 Agent、持續協作連線，以及緩慢移動的背景。日期為 2026 年 10 月 6 日，版本為 1.0.0。

先讀 [規格書](規格書.md)，再開啟 [互動參考](index.html)，最後依 [驗收清單](verification/驗收清單.md)檢查實作。參考頁可在本機瀏覽器開啟，無須安裝套件，所有內容使用示意資料。

## 交付內容

| 路徑 | 用途 |
| --- | --- |
| `規格書.md` | 視覺、互動、動態、資料接入、效能和驗收要求 |
| `AI-接手指令.txt` | 可直接交給實作 AI 的任務說明 |
| `index.html` | 可操作的完整參考頁，含拖曳旋轉、縮放、選擇和傳送示範 |
| `examples/agent-orbit.fragment.html` | 定稿來源，包含原生 WebGL、Canvas 和介面程式 |
| `data/visual-config.json` | 從定稿程式整理的視覺參數 |
| `data/example-scene.json` | 四團隊、十三 Agent、十二條關係的示意資料 |
| `data/example-events.json` | 有方向的傳送、接收和狀態更新範例 |
| `data/orbit-contracts.ts` | 建議的資料契約，供專案 adapter 對接 |
| `references/` | 本交付參考頁的實際截圖 |
| `verification/驗收清單.md` | 實作 AI 必須逐項確認的條件 |
| `verification/verification.json` | 本交付參考頁的本機瀏覽器驗證結果 |
| `manifest.json` | 內容清單、來源、檔案大小和 SHA256 |

## 參考畫面

| 畫面 | 觀察重點 |
| --- | --- |
| [總覽](references/overview-dark.png) | 同一宇宙內的鬆散團隊群落，沒有團隊卡片邊框 |
| [選擇 Agent](references/selected-links.png) | 直接協作連線加亮，其他團隊退到背景 |
| [傳送資料](references/data-transfer.png) | 有方向的光流沿常駐連線前進 |
| [俯視](references/top-view.png) | 相機改變時，光圈、連線與標籤共同投影 |
| [側視](references/side-view.png) | 深度和前後距離 |
| [手機](references/mobile-320.png) | 團隊直向排開，標籤和操作區維持可讀 |
| [淺色介面](references/light-chrome.png) | 外框跟隨主題，星域本身維持深色 |
| [Canvas 後備](references/canvas-fallback.png) | WebGL 失效後仍可看到光圈、連線和背景 |

## 使用界線

`index.html` 的 Office、中二模式、左側導覽與團隊數量是介面參考。可操作項目為星域內的視角、縮放、節點選擇、暫停、減少動態與資料傳送示範。

本包沒有接上真實 Agent 事件，也沒有修改 `D:/Code/CouCou_Remix`。接手 AI 必須接入專案既有資料來源，並保留目前 Office、中二模式與工作管理功能。

光環、星塵和連線都由程式繪製，這一模式無須新增角色模型或背景貼圖。來源快照和示意資料僅作實作參考；正式版不得持續重播示範訊息來冒充即時協作。
