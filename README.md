# Ephemeral Chat PWA v4.1 Zero-Knowledge changed-only

這版把邀請碼快取拿掉，改成零知識架構：

- 前端產生 Master Key。
- 連結只用 `#angkey=...` 傳給對方。
- GAS / Cloudflare 收不到 `#angkey`。
- 雙方前端用同一把 key 推導固定雙向 channel。
- GAS 只做瞎子郵筒：`sendSealedMessage`、`unreadCount`、`readAndDeleteSealed`。
- 後端只暫存 `ANG1.xxxxx` 密封包，不存人名、不存明文、不建立邀請紀錄。

## 覆蓋檔案

請覆蓋 GitHub 根目錄：

```text
index.html
app.js
style.css
service-worker.js
README.md
```

請覆蓋 GAS：

```text
gas/Code.gs
```

## 重要

`app.js` 仍然使用 Cloudflare Pages Functions：

```js
fetch('/api/action')
```

不要改成直接打 GAS URL，否則很容易遇到 CORS 或回傳讀不到的問題。

## 更新步驟

1. 覆蓋 GitHub 檔案。
2. GAS 貼上新版 `gas/Code.gs`。
3. GAS 重新部署新版本。
4. Cloudflare Pages 重新部署。
5. 手機如果仍看到舊版，刪除主畫面捷徑後重加，或清除網站資料。

## 限制

對話頻道可長期有效，前提是本機 localStorage 沒被清掉。  
訊息本身不是永久保存，最多依「離線保留」秒數暫存在 GAS CacheService，讀取時同步刪除。

如果要完全不把 key 存在本機，就不能做到永久好友；目前為了像聊天 App 一樣可長期使用，好友與 key 會存在本機 localStorage。
