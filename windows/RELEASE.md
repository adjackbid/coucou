# Coucou Windows — 發佈與疑難排解

照這份文件做,就能從原始碼走到交給使用者的檔案。所有指令都在 `windows\` 資料夾執行。

## 1. 開發預覽(不用編譯 app)

```
npx vite
```

瀏覽器開 `http://127.0.0.1:1420/team.html?view=office&mode=office`(示範資料)。
常用參數:`&mode=battle`、`&world=lava_crater`、`&battle=play`、`&theme=warm`、`&camera=frontal`。
用 `npx vite` 而不是 `npm run dev`:後者每次會先跑一輪 cargo 編譯。

## 2. 發佈前檢查

1. `npm test` — 前端測試全綠。
2. `cargo test` — Rust 測試全綠。
3. 升版號:`src-tauri\tauri.conf.json` 的 `version`(目前 0.1.1)。
4. 從系統匣結束正在執行的 Coucou,否則編譯無法覆蓋 exe。
5. cargo 卡在下載索引時:`$env:CARGO_HTTP_MULTIPLEXING="false"`。

## 3. 正式編譯與打包

### 免安裝版(建議的使用者交付)

```
npm run pack:portable
```

產出 `windows\release\Coucou-Windows-<版號>-portable.zip`(約 15 MB)。
解壓得到 `Coucou\` 資料夾,裡面就是使用者需要的全部四個檔案:

| 檔案 | 作用 |
|---|---|
| coucou.exe | 主程式;整個前端(UI、圖、音效)都嵌在裡面 |
| coucou-hook.exe | Claude Code / Copilot hook 轉發 |
| coucou-pty.exe | 終端機包裝(ConPTY) |
| coucou-team-mcp.exe | 團隊成員 CLI 的 MCP 中繼 |

點 `coucou.exe` 直接用。啟動時它會自己把三個輔助 exe 複製到
`%LOCALAPPDATA%\Coucou\bin`。需要 WebView2 runtime(Windows 10/11 內建)。

### 安裝包版(要捷徑/解除安裝時)

```
npm run pack
```

產出 `windows\release\Coucou-Windows-<版號>-setup.exe`(NSIS,裝到目前使用者)。
比免安裝版多:開始選單捷徑、解除安裝項、缺 WebView2 時自動安裝。

### 只想自己測

`npm run tauri build` 後直接跑 `windows\target\release\coucou.exe`。

## 4. 磁碟清理

- `target\debug\`:`npm run tauri dev` 的編譯快取,會長到 20 GB 以上,**隨時可整個刪**。
- `target\release\`:release 快取(約 3 GB),留著可以加速下次發佈;刪了也只是重編。
- 兩者都在 .gitignore,不會進版控。

## 5. 疑難排解(別台電腦)

### Windows 10(0.1.2 起同一個 exe 自動處理)

不需要為 Win10 另外出版本。程式啟動時用 `RtlGetVersion` 判斷 build:
- Build < 22000(Win10):不開 acrylic 模糊(Win10 上它會讓拖曳卡死),
  頁面自己畫深色底;圓角改由 CSS 切(視窗透明,四角露出桌面,看起來和
  Win11 的 DWM 圓角一樣)。
- Build ≥ 22000(Win11):照舊 — acrylic 玻璃 + DWM 圓角。

以下兩節是 0.1.1 以前(或仍異常時)的診斷。

### 視窗沒有圓角(四角是直角)

Teamwork 視窗的圓角用的是 Windows 11 的 DWM 圓角
(`DWMWA_WINDOW_CORNER_PREFERENCE`,`src-tauri\src\glass.rs`)。
**Windows 10 沒有這個功能**,圓角會變直角 — 這是系統差異,不是壞掉。
確認方式:在那台電腦按 Win+R 輸入 `winver`;Build 22000 以上才是 Windows 11。
若那台是 Win11 仍沒圓角:檢查「設定 → 個人化 → 色彩 → 透明效果」是否關閉、
顯示卡驅動是否過舊、是否透過遠端桌面(RDP 會停用 DWM 效果)。

### 拖曳視窗時不受控制(亂跳、跟不上)

拖曳走的是原生 `start_dragging`(`lib.rs` 的 "drag"),本身與 DPI 無關;
會亂跳通常是那台機器的合成環境:

1. **Windows 10 + 透明無邊框視窗**:Win10 的 DWM 合成這種視窗時拖曳容易遲滯。
2. 「系統 → 進階系統設定 → 效能 → 拖曳時顯示視窗內容」被關閉。
3. WebView2 runtime 過舊:在那台裝置更新(edge://settings/help 或重跑
   Evergreen WebView2 Runtime 安裝器)。
4. 顯示縮放特殊值(125%/150% 混合多螢幕)加上舊版 WebView2。

0.1.2 起前端在拖曳把手上先 `preventDefault()`,避免網頁自己的選取/拖曳
和原生移動迴圈互搶 — 部分機器的亂跳就是這個原因。先更新到新版再測;
仍會跳的話,回報那台的 winver 與 WebView2 版本。
