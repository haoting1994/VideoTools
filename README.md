# 簡易剪輯

不用開 Premiere 的簡易剪輯軟體，打開網址就能用。**影片不會上傳，全部在你的電腦上處理。**

## 功能

- **多軌時間軸**：標題、影片、字幕、音樂四軌
- **剪輯**：在播放頭分割（S）、刪除段落（Delete，後面自動接上）、拖曳調整順序、拉片段邊緣修剪長度
- **自動字幕**：用 Whisper 辨識剪好的影片，自動切成短句、轉台灣繁體；可在「字幕清單」直接改字、拖曳調整時間；可匯入／下載 SRT
- **文字標題**：可調大小、顏色、位置與出現時間
- **配樂**：音量、淡入淡出
- **LOGO**：位置、大小、透明度
- **聲音**：降噪、音量標準化（匯出時套用）
- **匯出**：MP4（H.264），可選解析度與畫質；字幕可燒進畫面，同時另存 SRT
- 復原／重做（Ctrl+Z／Ctrl+Shift+Z）
- 可以安裝成 App（PWA）

剪輯時，字幕和標題會跟著所在的片段一起移動；刪掉某一段時，該段的字幕也會一起刪掉。建議**先剪好再產生字幕**。

## 快捷鍵

| 按鍵 | 功能 |
|---|---|
| 空白鍵 | 播放／暫停 |
| S | 在播放頭分割 |
| Delete | 刪除選取的項目 |
| T | 加標題 |
| ← → | 上一格／下一格（Shift：跳 1 秒） |
| Home／End | 回到開頭／跳到結尾 |
| Ctrl+Z／Ctrl+Shift+Z | 復原／重做 |
| Ctrl+滾輪 | 縮放時間軸 |

## 開發時預覽（VS Code）

1. 安裝 **Live Server** 擴充套件（作者 Ritwick Dey）
2. 用 VS Code 開啟整個資料夾
3. 在 `index.html` 按右鍵 → **Open with Live Server**

改完存檔會自動重新整理。不能直接雙擊 `index.html`，瀏覽器的安全限制不允許從本機檔案載入剪輯引擎。

不用 VS Code 的話：Windows 先「全部解壓縮」，再雙擊 **啟動工具.bat**。

## 放上 GitHub Pages

1. 建立 repository，**設為 Public**（免費帳號的 Pages 只支援公開 repository）
2. 打開 `simple-editor` 資料夾，把**裡面的所有檔案和資料夾**（`index.html`、`js`、`vendor`、`icons` 等）拖進 GitHub 的上傳頁面。不要拖整個 `simple-editor` 資料夾，否則 `index.html` 不會在根目錄
3. **Settings → Pages** → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾選 `/ (root)` → Save
4. 約 1～2 分鐘後，Pages 頁面上方會出現網址 `https://你的帳號.github.io/repository名稱/`

檢查方式：repository 首頁的檔案清單第一層要直接看到 `index.html`。

剪輯引擎核心（約 32MB）會在使用者開啟網頁時從 jsDelivr CDN 載入，因為 GitHub 網頁上傳的單檔上限是 25MB。

更新程式後，使用者重新整理頁面就會拿到新版。若修改了 `vendor/` 裡的檔案，請把 `sw.js` 的 `VERSION` 改成新值。

## 字幕模型

| 選項 | 首次下載 | 說明 |
|---|---|---|
| 快速（base） | 約 80MB | 速度快 |
| 標準（small） | 約 250MB | |
| **medium（預設）** | 約 700MB～1GB | 與電腦版 `ggml-medium.bin` 相同的模型 |
| 最準確（large-v3-turbo） | 約 760MB | 需要 WebGPU |

模型從 huggingface.co 下載後存在瀏覽器裡。公司網路如果封鎖 huggingface.co，自動字幕會無法使用，但仍然可以匯入 SRT。

## 建議與限制

- 使用最新版 **Chrome 或 Edge**。剪輯和匯出靠瀏覽器的 WebCodecs 硬體加速；Safari、Firefox 可能無法匯出
- 瀏覽器不能直接剪的格式（例如 AVI、部分 MKV），匯入時會先自動轉成 MP4，速度較慢
- 匯出的影片暫存在記憶體中，太長的影片（例如超過 1 小時的 1080P）可能因記憶體不足而失敗
- 專案不會自動儲存，關掉頁面前請先匯出

## 檔案結構

```
index.html / style.css     介面
js/app.js                  介面操作、屬性面板、快捷鍵
js/state.js                專案資料、復原重做、剪輯邏輯
js/timeline.js             時間軸
js/preview.js              預覽播放
js/compose.js              畫面合成（標題、字幕、LOGO）
js/export.js               匯出
js/media.js                素材匯入、聲音混音（ffmpeg）
js/subtitles.js            自動字幕、SRT
whisper-worker.js          語音辨識
sw.js / manifest.webmanifest  安裝成 App
vendor/                    ffmpeg.wasm 介面、mediabunny、OpenCC（引擎核心從 CDN 載入）
```
