# v3.5.1 link-fix changed files

這包只包含需要覆蓋的檔案：`index.html`、`app.js`、`style.css`、`service-worker.js`、`README.md`。

修正：

- 修正 v3.5 changed-only 版本少了 `friendsPanel` / `saveFriendBtn` 導致 JS 啟動中斷。
- 邀請連結改用乾淨首頁網址產生，例如 `https://你的.pages.dev/?invite=xxxxx`。
- 更新 service worker cache name，避免手機/瀏覽器吃到舊首頁。

更新後：

1. 把這幾個檔案覆蓋到 GitHub 根目錄。
2. Cloudflare Pages 重新部署。
3. 手機端重新整理一次；若還吃舊畫面，清除網站資料或按「重置」。

---

# Ephemeral Chat PWA v3.5 configured

本版已調整：

- 顯示名稱填寫建議改為「Lisa、小藍」，不再出現「米」。
- 主題色改為深藍 + 深橘。
- 已移除 `wrangler.toml`，避免 Cloudflare 誤判成 Worker 專案。
- 已內建使用者提供的 GAS `/exec` 後端網址作為 Cloudflare Function fallback。

# Ephemeral Chat PWA CF + GAS v3.5

這版是：

```text
Cloudflare Pages 前端 + Pages Functions API 代理 + GAS CacheService 後端
```

功能：

```text
建立一次性邀請連結
對方點連結自動加入
雙方不用手動輸入頻道
手機可加入主畫面
訊息只放 GAS CacheService
讀取後後端快取刪除
畫面依自訂秒數自動移除
不寫 Google Sheets
不寫資料庫
自訂畫面顯示秒數 / 訊息快取秒數 / 邀請有效秒數
每則訊息可按「立即刪」，也可一鍵清空畫面
常用 / 好友：可把目前專屬對話存到本機，之後從首頁一鍵開啟
```

重要說明：這是「短暫快取傳遞」，不是絕對無痕、不是端對端加密，也不能防止截圖、瀏覽器紀錄、網路紀錄或平台執行紀錄。

---

## 目錄結構

```text
/
  index.html
  app.js
  style.css
  manifest.json
  service-worker.js
  _headers

/functions/api/[[path]]/index.js
  Cloudflare Pages Functions API 代理

/gas/Code.gs
  GAS 後端

/assets/
  icon-192.png
  icon-512.png
```

---

# 一、先部署 GAS 後端

1. 打開 Google Apps Script。
2. 建立新專案。
3. 把 `gas/Code.gs` 的內容貼到 `Code.gs`。
4. 右上角按「部署」。
5. 選「新增部署」。
6. 類型選「網頁應用程式」。
7. 建議設定：

```text
執行身分：我
誰可以存取：所有人
```

8. 部署後複製 Web App URL，格式通常像：

```text
https://script.google.com/macros/s/xxxxxxxxxxxxxxxx/exec
```

這個網址等等要填到 Cloudflare 的環境變數。

---

# 二、部署 Cloudflare Pages

你可以把整個資料夾上傳到 GitHub repo，然後讓 Cloudflare Pages 連 GitHub 自動部署。

Cloudflare Pages 設定建議：

```text
Framework preset：None
Build command：留空
Build output directory：.
Root directory：/
```

---

# 三、設定 Cloudflare 環境變數

到 Cloudflare Pages 專案：

```text
Settings
→ Environment variables
→ Add variable
```

新增：

```text
名稱：GAS_WEB_APP_URL
值：你的 GAS Web App /exec 網址
```

Production 和 Preview 都可以都加。

設定完後要重新部署一次。

---

# 四、使用方式

A 打開 Cloudflare Pages 網址：

```text
https://你的專案.pages.dev
```

A 輸入顯示名稱，按：

```text
建立專屬對話
```

系統會產生一次性邀請連結：

```text
https://你的專案.pages.dev/?invite=xxxxx
```

A 把連結傳給 B。

B 點連結後：

```text
輸入顯示名稱
→ 接受邀請並加入
→ 自動儲存專屬對話到 localStorage
→ 進入聊天
```

之後雙方打開同一個主網址，會用本機 localStorage 自動回到對話。

---

# 五、加入手機主畫面

## iPhone

```text
用 Safari 打開網址
→ 分享
→ 加入主畫面
```

## Android Chrome

```text
用 Chrome 打開網址
→ 右上角 ⋮
→ 加到主畫面 / 安裝應用程式
```

Android 若符合條件，頁面會自動顯示安裝提示。

iPhone 不能由網頁強制自動加入主畫面，只能顯示教學讓使用者自己按。

---

# 六、常見問題

## 1. 按「測試後端」失敗

檢查：

```text
Cloudflare Pages 是否有設定 GAS_WEB_APP_URL
GAS 是否部署成 Web App
GAS 存取權是否為「所有人」
GAS URL 是否用 /exec，不是 /dev
Cloudflare 設定完環境變數後是否重新部署
```

## 2. 對方點邀請連結顯示失效

這版邀請連結是一次性，且依你建立邀請時設定的秒數過期。請 A 重新建立一個邀請。

## 3. 訊息收不到

檢查：

```text
兩邊是不是同一個 Cloudflare Pages 網址
邀請是否真的被 B 接受成功
GAS 配額是否超過
瀏覽器是否阻擋網路請求
```

也可以先按「測試後端」。

## 4. 為什麼重新整理後訊息不見？

正常。訊息沒有歷史紀錄，只是短暫快取傳遞。

## 5. 換手機後對話不見？

正常。專屬對話身分存在該裝置的 `localStorage`，不是存在資料庫。

---

# 七、秒數設定與立即刪

建立邀請前可在首頁設定：

```text
畫面顯示：1～60 秒
訊息快取：5～600 秒
邀請有效：30～86400 秒
```

這組設定會跟著邀請連結帶給對方。已建立的對話如果要改秒數，建議按「重置」後重新建立邀請。

聊天畫面新增兩種立即刪：

```text
每則訊息右上角「立即刪」：只刪那一則畫面訊息，不管原本設定幾秒。
聊天右上角「立即刪」：立刻清空目前畫面上的所有訊息。
```

注意：訊息被對方讀取時，後端快取本來就已經刪除；「立即刪」主要是清除本機畫面上仍在倒數顯示的訊息。

仍可在程式碼調整固定限制：

`gas/Code.gs`

```javascript
var MAX_INBOX_MESSAGES = 20;        // 同一頻道最多暫存幾則
var MAX_TEXT_LENGTH = 1000;         // 單則訊息最大字數
```

`app.js`

```javascript
const POLL_INTERVAL_MS = 1400;      // 幾毫秒輪詢一次
```

---

# 八、版本備註

v3.5 新增：

```text
首頁可自訂畫面顯示秒數、訊息快取秒數、邀請有效秒數
每則訊息右上角新增「立即刪」
聊天右上角新增「立即刪」可清空目前畫面
GAS 後端會依前端送出的訊息快取秒數與邀請有效秒數處理
```

v3 和前一版最大差異：

```text
不再手動填自己的接收頻道
不再手動填對方接收頻道
改成一次性邀請連結自動配對
Cloudflare Pages 當公開入口
Cloudflare Pages Functions 當 API 代理
GAS 只做短暫快取後端
```


---

# 九、常用 / 好友

這版新增「常用 / 好友」功能：

```text
進入聊天後按「加常用」
→ 輸入名稱，例如 Lisa、小藍
→ 回到首頁時會出現在「常用 / 好友」清單
→ 點一下即可開啟該專屬對話
```

注意：

```text
常用只存在本機 localStorage
不寫 Google Sheets
不寫資料庫
不會同步到其他手機
不會保存聊天紀錄
刪除常用只會刪除本機捷徑，不會影響對方
```
