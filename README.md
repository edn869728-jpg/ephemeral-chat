# Ephemeral Chat PWA v3.7 sealed changed-only

這包是「只改檔案版」。用來先測試 iPhone 友善的 ANG 密封包流程。

## 這版重點

```text
前端先把訊息加密成 ANG sealed packet
GAS 只暫存 ANG1.xxxxxx 亂碼密文
GAS 不存顯示名稱
GAS 不存明文訊息
GAS 不存對方是誰
未讀檢查只回未讀數，不回內容
打開聊天室 / 按讀取時才取出密文
取出時後端同步刪除快取
手機本機解密後顯示
畫面幾秒後自動移除
通知不顯示人名或訊息內容
```

## 必須覆蓋的檔案

請把這些檔案覆蓋到 GitHub 根目錄：

```text
index.html
app.js
style.css
service-worker.js
README.md
```

然後把這個檔案貼到 GAS：

```text
gas/Code.gs
```

## 必須重新部署

這版有改 GAS 後端 API，所以一定要：

```text
1. GAS Code.gs 重新貼上
2. GAS 部署新版本
3. Cloudflare Pages 重新部署
4. 手機如果看到舊畫面，清網站資料或刪掉主畫面捷徑後重加
```

## 邀請連結格式

這版邀請連結會長這樣：

```text
https://你的網站.pages.dev/?invite=xxxxx#angkey=yyyyy
```

`?invite=xxxxx` 給後端用來配對。

`#angkey=yyyyy` 是本機解密鑰匙，通常不會送到伺服器；請複製完整連結給對方。

## 測試方式

1. A 開首頁，輸入 Lisa，按「建立專屬對話」。
2. 複製完整邀請連結，確認有 `#angkey=`。
3. B 用另一台手機或無痕視窗打開邀請連結。
4. B 輸入小藍，按「接受密封邀請並加入」。
5. A/B 互傳訊息。
6. 後端只會看到 ANG1 開頭的密封包亂碼。

## 注意

這不是絕對無痕，也不是完整安全通訊產品。它只是把後端暫存的內容改成亂碼密文，降低 GAS / Cloudflare 看到明文的機會。

仍無法防止：

```text
對方截圖
手機通知紀錄
瀏覽器或系統層紀錄
網路服務層的請求紀錄
使用者自行複製文字
```
