# Agent Company 90 秒 — 配樂與配音規格

對應影片:`agent-company-90s.mp4`(1920×1080 · 24 fps · 正好 90.000 秒)。
目前影片裡的音樂與音效是程式合成的暫代版,本規格用來產出正式版。字幕已燒在畫面上,配音必須對齊字幕的時間碼。

分成三部分:
- **A. 配樂規格**(給 AI 配樂工具)
- **B. 配音規格**(給 TTS 工具,逐段)
- **C. 混音與交付**(給最後合成的人或工具)

---

## A. 配樂規格

### A1. 一句話

> 90 秒的科技產品影片配樂:電子、有推進力、乾淨、不廉價。像一支半導體廠的 AI 產品發表片,不是夜店。全程沒有人聲,為旁白留出中頻空間。

### A2. 固定參數

| 項目 | 規格 |
|---|---|
| 長度 | **正好 90.000 秒**,00:00 起音、01:30 結束(最後 0.7 秒淡出到靜音) |
| 速度 | **124 BPM**,4/4,全程不變速(影片的所有動畫都踩在這個拍子上) |
| 調性 | A 小調為主;45–63 秒與 69–84 秒轉到 C 大調(同一組音,換明亮的和弦);84.2 秒後落在 C 大調 |
| 和弦進行 | 主段:Am → F → C → G(每小節一個和弦,一小節 = 1.935 秒);明亮段:C → F → Am → G;終段:C(加九) 持續 |
| 風格關鍵字 | cinematic tech, synthwave-lite, corporate electronic, clean, driving, confident, modern |
| 不要 | 人聲、歌詞、吉他、真鼓、管弦樂大鋪陳、EDM 式 build-drop、trap hi-hat、變速、任何在旁白時段蓋住 200 Hz–4 kHz 的持續旋律 |
| 交付 | 48 kHz / 24-bit WAV 完整混音 **+ 分軌**(drums、bass、synth/arp、pad、fx/riser 各一軌),整體 −16 LUFS、true peak ≤ −1 dBTP(留空間給旁白) |

### A3. 節奏(全片共用的律動)

- **Kick**:四分音符四拍落地(4-on-the-floor),短而有衝擊,基頻 48–55 Hz,不拖泥帶水。
- **Clap / snare**:第 2、4 拍,乾淨的電子拍手聲,少量房間殘響,不要大 reverb。
- **Hi-hat**:十六分音符,closed;每拍的第 3 個十六分音符用 open hat 點一下;左右輕微擺盪。
- **Ghost note**:每小節第 4 拍後半加一個很輕的 noise tick,製造推進感。
- **Sidechain / pump**:整條 pad 與 bass 跟著 kick 做明顯的壓縮回彈(每拍約 −3 到 −4 dB、150 ms 回復),這是「有律動感」的關鍵。
- 安靜段(0–3 秒、84.0–84.2 秒、89.3 秒後)不要鼓。

### A4. 重低音

- **Sub bass**:正弦波為底,疊一點 saw 做存在感,主要能量在 **40–60 Hz**,在手機喇叭上也要能用泛音「感覺到」(在 80–120 Hz 留一層薄薄的諧波)。
- **音型**:十六分音符,型態 `1 0 1 1 0 1 0 1 | 1 0 1 1 0 1 0 1`(1 = 發聲),每小節最後一個十六分音符跳高八度做「勾」。
- **和 kick 的關係**:kick 打下去時 bass 讓位(sidechain),kick 的尾巴結束 bass 才回來,兩者不要在 50 Hz 打架。
- **安靜段的 bass**:0–3、8–14、34–39 秒改為長音(每小節一個根音),不要十六分音符。
- **84.2 秒的重擊**:一個 110 Hz 掃到 38 Hz 的 sub 下墜音(約 0.5 秒),疊一個短的 noise 衝擊,然後 C 的低音(C2,約 65 Hz)持續 3.8 秒慢慢收掉。這是全片最重的一下。

### A5. 分段結構(對齊影片的 12 個場景)

能量 1–10;「旁白」欄表示那一段有沒有人聲,有人聲時旋律要讓位。

| 時間 | 場景 | 能量 | 編曲重點 | 低音 | 過場 | 旁白 |
|---|---|---|---|---|---|---|
| 00:00–00:03 | 開場 | 2 | 只有 pad(Am),輕微空氣感;0.1 秒一個短 whoosh | 長音 | — | 有 |
| 00:03–00:08 | Agent 池 | 4 | 進八分音符琶音、輕 hat;24 位 Agent 每 0.08 秒出現一個,可加極輕的「點」聲節奏 | 長音→八分 | 03.0 一個 whoosh 進入 | 有 |
| 00:08–00:14 | 異常發生 | 5 | 轉暗:Am/E♭ 感的小調(Am → A♭dim 交替),kick 只打 1、3 拍,hat 減半;緊張但不吵 | 半拍脈動 | 08.0 切入,帶一點低頻 rumble | 有 |
| 00:14–00:21 | 挑選 Agent | 6 | **節奏進場**:完整鼓組 + 十六分 bass 開始;14.6–17.6 秒有雷達掃描,可加一個 3 秒緩慢上升的 filter sweep;20.0 秒五位落座,一個明確的下拍 | 十六分 | 14.0 不要黑場式停頓,直接接 | 有 |
| 00:21–00:27 | 拆解分工 | 7 | 主 groove,琶音在上方跑;21.8–22.6 四張卡飛出可配四個短 whoosh | 十六分 | 21.0 一個短 whoosh | 有 |
| 00:27–00:34 | 後台執行 | 7 | 同上,但 27–30 秒加一點「打字 / 數據」感的細碎高頻節奏;30.4 秒右半邊出現時加一層琶音 | 十六分 | 27.0 / 30.4 各一個 whoosh | 有 |
| 00:34–00:39 | 需要你時 | 6 | **拉住**:鼓組維持但 hat 收一半,pad 往前,留空給「問你」;37.2 秒核准 → 一個明亮的上行小和弦 | 長音 | 34.0 whoosh | 有 |
| 00:39–00:45 | 交付驗收 | 8 | 回到主 groove,琶音加密(每 4 個十六分音符跳一次高八度);39.3–41.4 四件成果交回可各配一聲 ding;42.3 全部驗收 → 短 chime | 十六分 | 39.0 whoosh | 有 |
| 00:45–01:03 | 晨會提問 | 7 | **轉明亮**:C → F → Am → G;比主段輕一點、更乾淨;47.3 秒問題送出、48.1 收到各一個輕聲;49.6–51.2 第二次掃描(短);53–56.6 三位同時翻資料可用三層琶音疊進;56.6 回答卡出現 → pad 往前;58.6 「要執行嗎?」前稍微收;60.4 執行 → 上行和弦;60.9–61.6 新團隊成立四個小點 | 十六分(輕) | 45.0 whoosh | 有 |
| 01:03–01:09 | 鏡頭拉遠 | 9 | **Riser**:63.6–68.6 一段 5 秒的上升(filter 打開 + 白噪音上掃 + 弦樂感合成音層層疊上),鼓組不停;68.6 到頂 | 十六分 + 高八度 | 63.4 whoosh;63.6 riser 起 | 有 |
| 01:09–01:15 | Agent Company | 9 | 到頂後維持最飽滿的編曲(所有軌都在),69.0–69.6 四個數字跳出配四個 pop + 一個 ding;70.2–73.8 請求飄進來配極輕的點聲 | 十六分 + 高八度 | 無,延續 | 有 |
| 01:15–01:24 | 調度示意 | 8 | 稍微收一層(拿掉高八度琶音),保持 groove;75.8、78.5、81.2 三次短掃描各 1.1 秒;76.9、79.6、82.3 三次「選定」各一個 pop+ding | 十六分 | 75.0 whoosh | 有 |
| 01:24.0–01:24.2 | 留白 | 0 | **全部停**,0.2 秒純靜音(83.6 秒先一個反向 whoosh 把聲音吸走) | 無 | — | 無 |
| 01:24.2–01:29.3 | 重擊與片名 | 10 | **84.2 秒:重擊**(見 A4)+ C 大調和弦一次打滿 + 短 chime;之後 pad 與琶音持續、鼓組回來打到 89.3;85.3、86.2 兩行字各一個 pop | 下墜音 + C2 長音 | 84.2 硬切 | 有 |
| 01:29.3–01:30.0 | 收尾 | 1 | 鼓停,只留 pad 尾音,0.7 秒淡出至靜音;88.6 可加一個很輕的高音結尾(C5) | 無 | — | 無 |

### A6. 必須對準的時間點(音效 cue 表)

如果配樂工具不做音效,這張表交給做音效的人;時間以影片為準,誤差 ≤ 50 ms。

| 秒 | 畫面 | 音效 |
|---|---|---|
| 0.2 / 1.3 | 圖騰出現 / 標語 | 兩個 pop |
| 3.4–5.3 | 24 位 Agent 依序出現(每 0.08 秒一位) | 24 個極短的「點」,左右交替 |
| 8.8 / 9.6 | ETCH-12 閃紅 | 兩組三連嗶的告警聲(880 Hz,方波,不刺耳) |
| 8.6–10.4 | SPC 點一顆顆跳出 | 16 個 tick |
| 10.9 | 請求卡飛向 Agent Center | whoosh |
| 12.1 | Agent Center 收到 | 一聲 ding(990 Hz)+ 擴散的環 |
| 14.6–17.6 | 雷達掃描一圈 | 3 秒緩慢上升的 sweep |
| 15.0 / 15.3 / 15.7 / 16.1 / 16.5 | 五位依序亮起 | 五聲 ding,音高逐個上升 |
| 19.4–20.5 | 五位飛到座位 | 一個 whoosh + 五個落地 pop |
| 21.8 / 22.05 / 22.3 / 22.55 | 四張任務卡 | 四個 whoosh |
| 30.7–32.1 | n8n 五個節點逐一點亮 | 五個 pop |
| 32.2 / 32.7 / 33.2 | 三行結果 | ding、ding、chime |
| 34.5 | 問題卡 | 兩聲通知音(1480 Hz) |
| 37.2 | 按下核准 | click + 上行 chime |
| 39.3 / 39.8 / 40.3 / 40.8 | 四件成果飛回 | 各一個 whoosh,0.6 秒後各一個 ding(音高遞增) |
| 42.3 | 全部驗收 | chime |
| 45.6–47.2 | 問題打字 | 打字 tick(每 0.1 秒) |
| 48.1 | Agent Center 收到 | ding |
| 49.6–51.2 | 第二次掃描 | 短 sweep + 三聲 ding |
| 56.6 | 回答卡 | whoosh + ding |
| 60.4 | 按下執行 | click + chime |
| 63.6–68.6 | 鏡頭拉遠 | **5 秒 riser** |
| 69.0–69.6 | 四個數字跳出 | 四個 pop + 一個 ding |
| 76.9 / 79.6 / 82.3 | 三次挑選完成 | pop + ding |
| 83.6 | 留白前 | 反向 whoosh(把聲音吸走) |
| **84.2** | **片名重擊** | **sub 下墜 + 衝擊 + 和弦**(全片最重) |
| 85.3 / 86.2 | 兩行標語 | 兩個 pop |
| 88.6 | 結尾 | 一個輕的高音 |

### A7. 給 AI 配樂工具的提示詞

**一次生成整首(Suno / Udio 類,英文效果較好):**

```
Instrumental only, no vocals. 124 BPM, 4/4, A minor moving to C major, exactly 90 seconds.
Cinematic tech / corporate electronic for a semiconductor-fab AI product film: clean, confident, driving, modern.
Four-on-the-floor punchy kick (48–55 Hz), electronic clap on 2 and 4, tight 16th-note hi-hats with an open hat on the off-beat, subtle ghost notes.
Deep sub bass (40–60 Hz) playing a 16th-note pattern with an octave jump at the end of each bar, sidechained hard to the kick so the whole mix pumps.
Analog-style saw pad on the chords (Am F C G), bright triangle-wave arpeggio in 16ths on top, no lead melody.
Structure: 0–3 s quiet pad intro; 3–8 s arpeggio and light hats enter; 8–14 s darker minor tension, half-time kick; 14 s full groove drops in; 34–39 s pull back (fewer hats, pad forward); 39–45 s full groove with higher arps; 45–63 s brighter chords (C F Am G), lighter and cleaner; 63.6–68.6 s a 5-second riser (filter opening, white-noise sweep) over the groove; 69–84 s the fullest arrangement; 84.0–84.2 s complete silence; 84.2 s a massive sub-bass hit with a C major chord, then the groove returns for 5 seconds; 89.3–90 s drums stop, pad fades to silence.
Leave the 200 Hz–4 kHz range uncluttered for a voice-over. No guitars, no orchestra, no vocal chops, no trap hats, no tempo changes.
```

**分段生成(Stable Audio / MusicGen / 支援時間軸的工具)**:把 A5 表的每一列當一段,各段共用「124 BPM、同一組音色、同一個 sidechain 設定」,再依 A5 的「過場」欄接起來;riser(63.6–68.6)與重擊(84.2)另外生成成 fx 軌疊上。

---

## B. 配音(TTS)規格

### B1. 聲音設定

| 項目 | 規格 |
|---|---|
| 語言 | 台灣華語(zh-TW),字幕用字即讀音依據 |
| 聲線 | 30–40 歲、中性偏沉穩、專業但有溫度的**男聲或女聲皆可**;像科技公司產品影片的旁白,不是新聞主播、不是廣告叫賣 |
| 參考(可選其一) | Azure:`zh-TW-YunJheNeural`(男)/ `zh-TW-HsiaoChenNeural`(女),style 用 `narration-professional` 或 `calm`;ElevenLabs:Multilingual v2,stability 0.55、similarity 0.75、style 0.25;Google:`cmn-TW-Wavenet-B/A` |
| 語速 | 基準 **每秒 4.5–5 個中文字**(約 1.05–1.1 倍速);每段的可用秒數見 B3,超過的段落請加速到 1.15 倍,不要刪字 |
| 音高 | 預設,不升不降;整段內的音高起伏靠語氣,不靠參數 |
| 音量 | 每段正規化到 −16 LUFS,段與段之間響度一致 |
| 停頓 | 逗號 120 ms、頓號 80 ms、句號 250 ms、冒號 200 ms;每段**開頭 0 ms、結尾不要補靜音**(時間由影片控制) |
| 交付 | 24 段獨立 WAV(48 kHz / 24-bit / 單聲道),檔名 `vo-01.wav` … `vo-24.wav`,另附一個全部串好、對齊時間碼的 `vo-full.wav` |

### B2. 專有名詞讀法(所有段落共用)

| 寫法 | 讀法 | 備註 |
|---|---|---|
| Agent Center | 英文「Agent Center」 | 全片最重要的詞,每次出現都要清楚、略慢;不要翻成中文 |
| Agent / AI Agent | 英文「Agent」/「AI Agent」 | 「位」當量詞時讀「二十四位 Agent」 |
| MCP | 英文字母「M-C-P」 | |
| n8n | 英文「n-eight-n」 | 不要讀成「n 八 n」 |
| API | 「A-P-I」 | |
| FDC / SPC / CD / WIP / PM / RF | 逐字母英文 | CD 讀「C-D」,不是光碟 |
| ETCH-12 / ETCH-14 | 「etch 十二」/「etch 十四」 | etch 英文,數字中文 |
| 3 號線 | 「三號線」 | |
| 2:14 | 「兩點十四分」 | 前面有「凌晨」 |
| 8:30 | 「八點半」 | |
| 04:40 | 「四點四十」 | |
| 24 / 五位 / 三位 / 八支 | 中文數字 | 「二十四位」「五位」「八支團隊」 |
| Lot | 英文「lot」 | |

### B3. 逐段規格

每段:時間碼(影片中的字幕起訖)、可用秒數、旁白文字、語氣、重音、給 AI 的導演說明(英文,直接貼進 TTS 的 style / prompt 欄)。

---

**01 · 00:00.8–00:02.8(2.0 秒)**
> 公司裡,已經有幾十位 AI Agent。

- 語氣:平靜、肯定、像在陳述一個大家都知道但沒注意的事實。
- 重音:「已經」。
- 語速:正常。
- Direction: *Calm, matter-of-fact opening. Slight emphasis on "already". No excitement yet; this is the premise.*

**02 · 00:03.4–00:07.7(4.3 秒)**
> 各管一件事,各接自己的後台。Agent Center 認識它們每一位。

- 語氣:介紹性、清楚;後半句「Agent Center 認識它們每一位」稍微放慢、帶一點暖意。
- 重音:「每一位」。
- Direction: *Explanatory and clear. The second sentence slows down slightly and warms up: "Agent Center knows every one of them."*

**03 · 00:08.4–00:13.7(5.3 秒,偏緊,請用 1.15 倍速)**
> 凌晨 2:14,製程監控 Agent 偵測到 ETCH-12 異常,向 Agent Center 提出請求。

- 語氣:轉入事件,語調略壓低、節奏加快,像在交代一個夜裡突發的狀況;不要驚慌。
- 重音:「凌晨兩點十四分」「異常」。
- 停頓:「異常,」後面留 150 ms 再接「向 Agent Center 提出請求」。
- Direction: *Shift to incident mode: lower, quicker, controlled urgency, like a calm night-shift report. Not alarmed. Brief pause after "anomaly".*

**04 · 00:14.4–00:18.2(3.8 秒)**
> Agent Center 依需求挑人:根因、機台、排程、量測、良率。

- 語氣:冷靜、有條理;冒號後的五個詞像在點名,節奏均勻、每個詞之間 80 ms。
- 重音:「挑人」。
- Direction: *Composed and methodical. After the colon, list the five items evenly like a roll call, equal spacing, slight downward cadence on the last one.*

**05 · 00:18.2–00:20.8(2.6 秒)**
> 五位,從二十四位裡選出來;其他人不被打擾。

- 語氣:結論式、乾脆;「其他人不被打擾」帶一點輕鬆、像在補一句好處。
- 重音:「五位」「二十四位」(對比)。
- Direction: *Crisp conclusion with a contrast between "five" and "twenty-four". The last clause relaxes, almost a reassuring aside.*

**06 · 00:21.4–00:24.2(2.8 秒)**
> 隊長拆解四個任務,同時派出。

- 語氣:行動開始,節奏明快、有推進力。
- 重音:「同時」。
- Direction: *Action begins. Brisk, forward-moving. Emphasis on "simultaneously".*

**07 · 00:24.2–00:26.8(2.6 秒)**
> 四位 Agent 同時開工,互不等待。

- 語氣:延續上一句的推進,「互不等待」說得俐落、收得乾脆。
- 重音:「互不等待」。
- Direction: *Same momentum as the previous line. "No one waits on anyone" lands clean and short.*

**08 · 00:27.4–00:30.6(3.2 秒)**
> 設備 Agent 用 MCP 讀 FDC、鎖機、開緊急 PM。

- 語氣:說明動作,像在念一份乾淨的操作紀錄;三個動作「讀 FDC、鎖機、開緊急 PM」節奏一致。
- 重音:「MCP」。
- Direction: *Procedural, clean, like reading a tidy action log. Three actions with even rhythm. Letters spelled out clearly.*

**09 · 00:30.6–00:33.8(3.2 秒)**
> 調度 Agent 在 n8n 裡把 WIP 改派到 ETCH-14,交期不變。

- 語氣:同上;「交期不變」是這句的重點,稍慢、肯定、尾音往下。
- 重音:「n8n」「交期不變」。
- Direction: *Same procedural tone. The payoff is "delivery date unchanged": slow slightly, firm, falling intonation.*

**10 · 00:34.4–00:37.0(2.6 秒)**
> 超過授權的決定,才會來問你。

- 語氣:轉向觀眾(管理者),語速放慢、音量略收,像面對面說話;「你」要有對象感。
- 重音:「才」「你」。
- Direction: *Turn to the viewer. Slower, slightly softer, personal, speaking directly to a manager. Emphasis on "only then" and "you".*

**11 · 00:37.0–00:38.8(1.8 秒)**
> 一鍵核准,團隊繼續。

- 語氣:輕快、乾脆,四字一組,中間 120 ms。
- Direction: *Light and snappy, two four-character beats with a short pause between.*

**12 · 00:39.4–00:42.4(3.0 秒)**
> 成果交回,隊長逐一驗收。04:40,ETCH-12 恢復。

- 語氣:有成就感但克制;「四點四十」像報時,「恢復」肯定、尾音落下。
- 停頓:句號後 200 ms。
- Direction: *Quiet satisfaction, restrained. "04:40" read like a timestamp; "recovered" is firm with a falling close.*

**13 · 00:42.4–00:44.8(2.4 秒)**
> CD 回到管制線內,零延誤。

- 語氣:收束第一個案例;「零延誤」是句點,說得清楚、短、有份量。
- 重音:「零延誤」。
- Direction: *Closing the first case. "Zero delay" is the full stop: clear, short, weighty.*

**14 · 00:45.4–00:49.0(3.6 秒)**
> 早上 8:30 晨會。廠長問:昨天 3 號線良率為什麼偏低?

- 語氣:場景轉換,語調回到日常、明亮一點;「廠長問:」之後的問句**不要演廠長**,用旁白的口吻轉述,但保留問句的上揚。
- 停頓:「晨會。」後 250 ms;「廠長問:」後 200 ms。
- Direction: *Scene change to a daytime meeting, brighter and more everyday. Report the manager's question in narrator voice (do not act it out), keep the rising question intonation.*

**15 · 00:49.0–00:52.6(3.6 秒)**
> Agent Center 挑了三位:良率、量測、設備。

- 語氣:和第 04 段同一種「點名」節奏,但更輕、更快一點,因為觀眾已經看過一次。
- Direction: *Same roll-call cadence as line 04, slightly lighter and quicker since the viewer has seen this before.*

**16 · 00:52.6–00:56.6(4.0 秒)**
> 三位同時翻資料。三十秒後,答案和對策一起回來。

- 語氣:前半句平鋪,後半句「答案和對策一起回來」帶一點揭曉的意味,音調略升再落。
- 重音:「三十秒」「一起」。
- Direction: *First sentence flat and factual. Second sentence has a small reveal: slight lift on "thirty seconds later", then land on "come back together".*

**17 · 00:56.6–01:00.4(3.8 秒)**
> 根因、影響、建議對策,最後一句:要執行嗎?

- 語氣:三個名詞均速;「最後一句:」放慢、留 200 ms;「要執行嗎?」用旁白轉述的問句,輕、上揚、不逼迫。
- Direction: *Three nouns evenly. Slow down on "and the last line:", pause, then a light rising question "shall I execute?" reported in narrator voice, inviting, not pushy.*

**18 · 01:00.4–01:02.8(2.4 秒)**
> 一個「執行」,新的團隊就成立了。

- 語氣:滿足、俐落;「執行」兩個字略強調,像按下按鈕;「就成立了」輕快收尾。
- Direction: *Satisfying and brisk. Slight punch on "Execute" like pressing a button; the rest is a quick, light close.*

**19 · 01:03.4–01:06.6(3.2 秒)**
> 而這,只是今天其中一支團隊。

- 語氣:**轉折句,全片語氣的轉捩點**。放慢、音量略降、留白;「而這,」後面停 250 ms;「只是」帶一點意味深長。鏡頭正在拉遠。
- Direction: *The pivot line of the whole film. Slow down, lower the volume a touch, let it breathe. Pause after "And this," — "only one of today's teams" should feel like a curtain being pulled back.*

**20 · 01:06.6–01:10.4(3.8 秒)**
> 每一支團隊,都由 Agent Center 從同一群 Agent 裡組成。

- 語氣:從轉折句慢慢把能量帶回來,語速恢復正常,語調穩定、有說服力。
- 重音:「每一支」「同一群」。
- Direction: *Bring the energy back up from the pivot. Steady, persuasive. Emphasis on "every team" and "the same pool".*

**21 · 01:10.4–01:14.7(4.3 秒)**
> 八支團隊、二十四位 Agent,同時處理不同的業務。

- 語氣:氣勢打開,數字說得清楚、有份量;「同時處理不同的業務」是這段的高點,音量比前面高一階。
- 重音:「八支」「二十四位」「同時」。
- Direction: *Open up. Numbers delivered clearly and with weight. "Handling different business at the same time" is the peak of this section, one notch louder.*

**22 · 01:15.4–01:19.4(4.0 秒)**
> 需求不同,挑的人就不同:異常、提問、客訴。

- 語氣:回到說明、清楚、有節奏;冒號後三個詞均速點名。
- Direction: *Back to clear explanation with rhythm. Roll-call cadence on the three items after the colon.*

**23 · 01:19.4–01:23.7(4.3 秒)**
> 同一群 Agent,無限種組合;現有的 Agent 不必重寫。

- 語氣:前半句有一點讚嘆感(「無限種組合」略拉長),分號後「現有的 Agent 不必重寫」是對管理者最實際的承諾,說得平實、肯定。**這是重擊前最後一句,結尾要收乾淨,之後是 1.7 秒留白。**
- 重音:「無限種」「不必重寫」。
- Direction: *Slight wonder on "endless combinations" (stretch it a touch). After the semicolon, the practical promise "your existing agents need no rewriting" is plain and firm. This is the last line before the hit: end cleanly, no trailing breath.*

**24 · 01:25.4–01:29.4(4.0 秒)**
> 一個 Agent Center,調度全公司的 Agent,完成每一件事。

- 語氣:**全片結語**。慢、穩、有力量但不喊;三個逗號分出三個節拍,每拍之間 200 ms;「完成每一件事」逐字清楚、尾音落下、收得乾淨。比其他段落慢 10%。
- 重音:「一個」「全公司」「每一件事」。
- Direction: *The closing statement. Slow, grounded, powerful without shouting. Three beats separated by 200 ms pauses. "Gets every single thing done" word by word, falling cadence, clean stop. 10% slower than the rest of the film.*

---

### B4. SSML 範例(Azure 格式,第 19 段)

```xml
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
       xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW">
  <voice name="zh-TW-YunJheNeural">
    <mstts:express-as style="narration-professional">
      <prosody rate="-8%" volume="-2dB">
        而這,<break time="250ms"/>只是今天<emphasis level="moderate">其中一支</emphasis>團隊。
      </prosody>
    </mstts:express-as>
  </voice>
</speak>
```

其他段落依 B3 的語速與停頓換掉 `rate`、`break`、`emphasis` 即可;專有名詞用 `<sub alias="n eight n">n8n</sub>`、`<say-as interpret-as="characters">MCP</say-as>` 固定讀法。

### B5. 一次貼給 TTS 的簡版(每段一行,給不支援逐段設定的工具)

```
[01|calm, factual] 公司裡,已經有幾十位 AI Agent。
[02|clear, warm at the end] 各管一件事,各接自己的後台。Agent Center 認識它們每一位。
[03|controlled urgency, 1.15x] 凌晨兩點十四分,製程監控 Agent 偵測到 etch 十二 異常,向 Agent Center 提出請求。
[04|methodical roll-call] Agent Center 依需求挑人:根因、機台、排程、量測、良率。
[05|crisp, contrast five vs twenty-four] 五位,從二十四位裡選出來;其他人不被打擾。
[06|brisk] 隊長拆解四個任務,同時派出。
[07|brisk, clean ending] 四位 Agent 同時開工,互不等待。
[08|procedural] 設備 Agent 用 M-C-P 讀 F-D-C、鎖機、開緊急 P-M。
[09|procedural, firm ending] 調度 Agent 在 n-eight-n 裡把 W-I-P 改派到 etch 十四,交期不變。
[10|to the viewer, slower, softer] 超過授權的決定,才會來問你。
[11|light, snappy] 一鍵核准,團隊繼續。
[12|quiet satisfaction] 成果交回,隊長逐一驗收。四點四十,etch 十二 恢復。
[13|closing, weighty] C-D 回到管制線內,零延誤。
[14|scene change, brighter; report the question] 早上八點半晨會。廠長問:昨天三號線良率為什麼偏低?
[15|roll-call, lighter] Agent Center 挑了三位:良率、量測、設備。
[16|small reveal] 三位同時翻資料。三十秒後,答案和對策一起回來。
[17|inviting question] 根因、影響、建議對策,最後一句:要執行嗎?
[18|satisfying, punch on 執行] 一個「執行」,新的團隊就成立了。
[19|PIVOT: slow, breathe, lower] 而這,只是今天其中一支團隊。
[20|steady, persuasive] 每一支團隊,都由 Agent Center 從同一群 Agent 裡組成。
[21|open up, louder] 八支團隊、二十四位 Agent,同時處理不同的業務。
[22|clear, roll-call] 需求不同,挑的人就不同:異常、提問、客訴。
[23|wonder then plain promise, clean stop] 同一群 Agent,無限種組合;現有的 Agent 不必重寫。
[24|CLOSING: slow, grounded, 3 beats] 一個 Agent Center,調度全公司的 Agent,完成每一件事。
```

---

## C. 混音與交付

1. **旁白最大**:旁白 −16 LUFS;旁白出現時音樂 duck −7 dB(attack 80 ms、release 400 ms),音效不 duck。
2. **重擊段(84.2 秒)**:這 0.5 秒內旁白是空的,音樂可以到 −10 LUFS 短時峰值,true peak 仍 ≤ −1 dBTP。
3. **留白(84.0–84.2)與結尾(89.3 之後)**:真的靜音,不要底噪。
4. 最終輸出:AAC 192 kbps 立體聲回填到 `agent-company-90s.mp4`;另交一份 48 kHz WAV 完整混音與分軌,方便日後換字幕或改旁白時重混。
5. 配音交回後,我可以依實際每段長度微調影片字幕時間碼(影片本身是逐格由時間產生的,重算約 9 分鐘)。
