/**
 * Ephemeral Chat PWA v4.1 - stateless sealed packet GAS backend
 *
 * GAS 只做瞎子郵筒：
 * - 不建立邀請碼
 * - 不保存顯示名稱
 * - 不保存明文訊息
 * - 不寫 Google Sheets / 資料庫
 * - 只暫存 ANG1 密封包，讀取時同步刪除
 */

var CONFIG = {
  DEFAULT_TTL: 3600,
  MAX_TTL: 21600,
  MAX_MESSAGES: 20,
  MAX_PACKET_LEN: 12000
};

function doGet() {
  return json_({
    ok: true,
    name: 'Ephemeral Chat GAS API',
    version: 'v4.1-stateless-zero-knowledge',
    message: 'Use POST with JSON body.'
  });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    var action = String(body.action || '').trim();

    var routes = {
      health: function () {
        return { ok: true, version: 'v4.1-stateless-zero-knowledge', time: Date.now() };
      },
      sendSealedMessage: function () {
        return sendSealedMessage_(body);
      },
      unreadCount: function () {
        return unreadCount_(body);
      },
      readAndDeleteSealed: function () {
        return readAndDeleteSealed_(body);
      },
      pollMessages: function () {
        return readAndDeleteSealed_(body);
      }
    };

    if (!routes[action]) {
      return json_({ ok: false, error: 'Unknown action: ' + action });
    }

    return json_(routes[action]());
  } catch (err) {
    return json_({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

function sendSealedMessage_(body) {
  var peerChannel = cleanToken_(body.peerChannel || '');
  var packet = cleanPacket_(body.packet || '');
  var ttl = clampNumber_(body.messageTtlSeconds, CONFIG.DEFAULT_TTL, 5, CONFIG.MAX_TTL);
  var now = Date.now();

  var lock = LockService.getScriptLock();
  lock.waitLock(3000);

  try {
    var cache = CacheService.getScriptCache();
    var key = inboxKey_(peerChannel);
    var inbox = [];
    var cached = cache.get(key);

    if (cached) {
      try {
        inbox = JSON.parse(cached);
        if (!Array.isArray(inbox)) inbox = [];
      } catch (e) {
        inbox = [];
      }
    }

    inbox = inbox.filter(function (m) {
      return Number(m.expiresAt || 0) > now;
    });

    inbox.push({
      id: generateId_(),
      packet: packet,
      createdAt: now,
      expiresAt: now + ttl * 1000
    });

    if (inbox.length > CONFIG.MAX_MESSAGES) {
      inbox = inbox.slice(inbox.length - CONFIG.MAX_MESSAGES);
    }

    cache.put(key, JSON.stringify(inbox), ttl);

    return { ok: true, timestamp: now, messageTtlSeconds: ttl };
  } finally {
    lock.releaseLock();
  }
}

function unreadCount_(body) {
  var myChannel = cleanToken_(body.myChannel || '');
  var key = inboxKey_(myChannel);
  var cache = CacheService.getScriptCache();
  var cached = cache.get(key);

  if (!cached) return { ok: true, unread: 0 };

  var now = Date.now();
  var packets = [];

  try {
    packets = JSON.parse(cached);
    if (!Array.isArray(packets)) packets = [];
  } catch (e) {
    packets = [];
  }

  packets = packets.filter(function (m) {
    return Number(m.expiresAt || 0) > now;
  });

  if (!packets.length) {
    cache.remove(key);
    return { ok: true, unread: 0 };
  }

  return { ok: true, unread: packets.length };
}

function readAndDeleteSealed_(body) {
  var myChannel = cleanToken_(body.myChannel || '');
  var key = inboxKey_(myChannel);

  var lock = LockService.getScriptLock();
  lock.waitLock(3000);

  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(key);

    if (!cached) return { ok: true, unread: 0, packets: [] };

    cache.remove(key);

    var now = Date.now();
    var packets = [];

    try {
      packets = JSON.parse(cached);
      if (!Array.isArray(packets)) packets = [];
    } catch (e) {
      packets = [];
    }

    packets = packets.filter(function (m) {
      return Number(m.expiresAt || 0) > now;
    });

    return {
      ok: true,
      unread: 0,
      packets: packets.map(function (m) {
        return {
          id: String(m.id || ''),
          packet: String(m.packet || '').slice(0, CONFIG.MAX_PACKET_LEN),
          createdAt: Number(m.createdAt || now)
        };
      })
    };
  } finally {
    lock.releaseLock();
  }
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error('JSON 格式錯誤');
  }
}

function cleanPacket_(packet) {
  packet = String(packet || '').trim();
  if (!packet) throw new Error('密封包不可為空');
  if (packet.length > CONFIG.MAX_PACKET_LEN) throw new Error('密封包太長');
  if (!/^ANG1\.[A-Za-z0-9_-]{20,}$/.test(packet)) {
    throw new Error('密封包格式錯誤');
  }
  return packet;
}

function cleanToken_(token) {
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{12,120}$/.test(token)) {
    throw new Error('頻道 ID 格式錯誤');
  }
  return token;
}

function inboxKey_(channel) {
  return 'inbox:' + cleanToken_(channel);
}

function clampNumber_(value, fallback, min, max) {
  var number = Math.round(Number(value));
  if (!isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function generateId_() {
  return 'm_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
