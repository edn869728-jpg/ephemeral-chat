私・話 v4.5｜邀請碼＋QR 配對／訊息收不到修正版

【這次修正】
1. 建立對話後顯示 12 碼邀請碼：XXXX-XXXX-XXXX。
2. 同一組邀請同時顯示 QR Code；對方可直接用手機相機掃描。
3. 邀請碼只使用一次，接受後立即失效。
4. 邀請碼本身不送進 GAS；前端只送 SHA-256 配對識別碼。
5. 雙方用同一組邀請碼在本機推導 ANG 解密金鑰。
6. GAS 發放成對 creator／guest 頻道，修正兩邊頻道不一致、對方收不到訊息。
7. sendSealedMessage 回傳 queuedCount，確認訊息真的進入對方加密郵筒。
8. 保留未讀水滴、聊天室紅綠燈、語音通話與照片加密。

【Cloudflare Pages】
GitHub 已新增／更新：
- pairing-addon.js
- pairing-addon.css
- service-worker.js

Cloudflare Pages 必須部署最新 GitHub commit。
部署後，兩支手機都先開：
https://ephemeral-chat-9lb.pages.dev/refresh.html
清除舊 Service Worker 與快取。

【GAS：這一步一定要做】
1. 打開目前 Cloudflare 環境變數 GAS_WEB_APP_URL 所指向的 Apps Script 專案。
2. 用本包 gas/Code.gs 完整覆蓋目前程式碼。
3. 儲存。
4. 部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署。
5. 網頁按「測試後端」，版本必須顯示：
   v4.5-pair-code-qr-delivery-fix

若還顯示 v4.3 或 v4.4，代表 GAS 仍是舊部署，配對碼與訊息郵筒都不會正常。

【測試順序】
1. A 手機建立專屬對話，取得 12 碼與 QR Code。
2. B 手機掃描 QR 或手動輸入 12 碼。
3. B 按「接受配對並加入」。
4. A 畫面顯示「對方已配對」。
5. A 傳一則新訊息，底部應顯示「訊息已送達加密郵筒」。
6. B 左側出現橘色水滴，點開後看到訊息。

舊的 #angkey 邀請與舊訊息不要拿來測，請建立全新的 v4.5 邀請碼。
