/**
 * Ephemeral Chat PWA v3.4 - GAS backend
 *
 * 用途：只使用 CacheService 做短暫訊息轉交，不寫 Google Sheets、不寫資料庫。
 * 注意：這不是絕對無痕或端對端加密系統。Apps Script 執行、瀏覽器、網路環境仍可能留下操作痕跡。
 */

var DEFAULT_MESSAGE_TTL_SECONDS = 20;
var DEFAULT_INVITE_TTL_SECONDS = 30 * 60;
var MAX_INBOX_MESSAGES = 20;
var MAX_TEXT_LENGTH = 1000;

var SETTINGS_LIMITS = {
  displaySeconds: { min: 1, max: 60, fallback: 3 },
  messageTtlSeconds: { min: 5, max: 600, fallback: DEFAULT_MESSAGE_TTL_SECONDS },
  inviteTtlSeconds: { min: 30, max: 86400, fallback: DEFAULT_INVITE_TTL_SECONDS }
};

function doGet() {
  return json_({
    ok: true,
    name: 'Ephemeral Chat GAS API',
    version: 'v3.4',
    message: 'Use POST with JSON body.'
  });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    var action = String(body.action || '').trim();

    if (action === 'health') {
      return json_({ ok: true, version: 'v3.4', time: Date.now() });
    }

    if (action === 'createInvite') {
      return json_(createInvite_(body));
    }

    if (action === 'acceptInvite') {
      return json_(acceptInvite_(body));
    }

    if (action === 'sendMessage') {
      return json_(sendMessage_(body));
    }

    if (action === 'pollMessages') {
      return json_(pollMessages_(body));
    }

    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json_({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
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

function createInvite_(body) {
  var label = cleanLabel_(body.label || '我');
  var settings = sanitizeSettings_(body.settings || {});
  var creatorChannel = makeToken_('c');
  var guestChannel = makeToken_('g');
  var inviteToken = makeToken_('i');

  var inviteData = {
    creatorChannel: creatorChannel,
    guestChannel: guestChannel,
    creatorLabel: label,
    settings: settings,
    createdAt: Date.now()
  };

  var cache = CacheService.getScriptCache();
  cache.put(inviteKey_(inviteToken), JSON.stringify(inviteData), settings.inviteTtlSeconds);

  return {
    ok: true,
    inviteToken: inviteToken,
    inviteTtlSeconds: settings.inviteTtlSeconds,
    session: {
      role: 'creator',
      myChannel: creatorChannel,
      peerChannel: guestChannel,
      label: label,
      settings: settings,
      createdAt: Date.now()
    }
  };
}

function acceptInvite_(body) {
  var inviteToken = cleanToken_(body.inviteToken || body.invite || '');
  var label = cleanLabel_(body.label || '對方');
  var key = inviteKey_(inviteToken);

  var lock = LockService.getScriptLock();
  lock.waitLock(3000);

  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(key);

    if (!cached) {
      return {
        ok: false,
        error: '邀請連結已失效或已被使用。請對方重新建立邀請。'
      };
    }

    cache.remove(key);

    var data = JSON.parse(cached);
    var settings = sanitizeSettings_(data.settings || {});

    addMessageNoLock_(data.creatorChannel, {
      id: makeToken_('m'),
      sender: '系統',
      text: label + ' 已加入這個臨時對話。',
      system: true,
      timestamp: Date.now()
    }, settings.messageTtlSeconds);

    return {
      ok: true,
      session: {
        role: 'guest',
        myChannel: data.guestChannel,
        peerChannel: data.creatorChannel,
        label: label,
        peerLabel: data.creatorLabel || '對方',
        settings: settings,
        createdAt: Date.now()
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function sendMessage_(body) {
  var peerChannel = cleanToken_(body.peerChannel || '');
  var text = cleanText_(body.text || '');
  var sender = cleanLabel_(body.sender || '對方');
  var messageTtlSeconds = clampNumber_(
    body.messageTtlSeconds,
    SETTINGS_LIMITS.messageTtlSeconds.fallback,
    SETTINGS_LIMITS.messageTtlSeconds.min,
    SETTINGS_LIMITS.messageTtlSeconds.max
  );

  var lock = LockService.getScriptLock();
  lock.waitLock(3000);

  try {
    addMessageNoLock_(peerChannel, {
      id: makeToken_('m'),
      sender: sender,
      text: text,
      system: false,
      timestamp: Date.now()
    }, messageTtlSeconds);

    return { ok: true, timestamp: Date.now(), messageTtlSeconds: messageTtlSeconds };
  } finally {
    lock.releaseLock();
  }
}

function pollMessages_(body) {
  var myChannel = cleanToken_(body.myChannel || '');
  var key = inboxKey_(myChannel);

  var lock = LockService.getScriptLock();
  lock.waitLock(3000);

  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(key);

    if (!cached) {
      return { ok: true, messages: [] };
    }

    cache.remove(key);

    var messages = [];
    try {
      messages = JSON.parse(cached);
      if (!Array.isArray(messages)) messages = [];
    } catch (err) {
      messages = [];
    }

    return {
      ok: true,
      messages: messages.map(function (m) {
        return {
          id: String(m.id || ''),
          sender: String(m.sender || '對方').slice(0, 40),
          text: String(m.text || '').slice(0, MAX_TEXT_LENGTH),
          system: Boolean(m.system),
          timestamp: Number(m.timestamp || Date.now())
        };
      })
    };
  } finally {
    lock.releaseLock();
  }
}

function addMessageNoLock_(channel, message, ttlSeconds) {
  var cache = CacheService.getScriptCache();
  var key = inboxKey_(channel);
  var inbox = [];
  var oldValue = cache.get(key);

  if (oldValue) {
    try {
      inbox = JSON.parse(oldValue);
      if (!Array.isArray(inbox)) inbox = [];
    } catch (err) {
      inbox = [];
    }
  }

  inbox.push(message);

  if (inbox.length > MAX_INBOX_MESSAGES) {
    inbox = inbox.slice(inbox.length - MAX_INBOX_MESSAGES);
  }

  var ttl = clampNumber_(
    ttlSeconds,
    SETTINGS_LIMITS.messageTtlSeconds.fallback,
    SETTINGS_LIMITS.messageTtlSeconds.min,
    SETTINGS_LIMITS.messageTtlSeconds.max
  );

  cache.put(key, JSON.stringify(inbox), ttl);
}

function sanitizeSettings_(settings) {
  settings = settings || {};
  return {
    displaySeconds: clampNumber_(settings.displaySeconds, SETTINGS_LIMITS.displaySeconds.fallback, SETTINGS_LIMITS.displaySeconds.min, SETTINGS_LIMITS.displaySeconds.max),
    messageTtlSeconds: clampNumber_(settings.messageTtlSeconds, SETTINGS_LIMITS.messageTtlSeconds.fallback, SETTINGS_LIMITS.messageTtlSeconds.min, SETTINGS_LIMITS.messageTtlSeconds.max),
    inviteTtlSeconds: clampNumber_(settings.inviteTtlSeconds, SETTINGS_LIMITS.inviteTtlSeconds.fallback, SETTINGS_LIMITS.inviteTtlSeconds.min, SETTINGS_LIMITS.inviteTtlSeconds.max)
  };
}

function clampNumber_(value, fallback, min, max) {
  var number = Math.round(Number(value));
  if (!isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function cleanText_(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('訊息不可為空');
  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
  return text;
}

function cleanLabel_(label) {
  label = String(label || '').trim();
  if (!label) label = '我';
  return label.slice(0, 30);
}

function cleanToken_(token) {
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{12,120}$/.test(token)) {
    throw new Error('頻道或邀請碼格式錯誤');
  }
  return token;
}

function makeToken_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function inboxKey_(channel) {
  return 'inbox:' + cleanToken_(channel);
}

function inviteKey_(token) {
  return 'invite:' + cleanToken_(token);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
