/**
 * 私•話 v4.5｜邀請碼／QR 配對＋Zero-Knowledge 郵筒＋聊天室狀態＋語音通話
 *
 * - 一次性邀請只暫存隨機頻道與時間設定，不保存名稱或 #angkey
 * - 不保存名稱或訊息明文
 * - 不寫入試算表或資料庫
 * - 每則 ANG1 密封包獨立暫存
 * - 未進聊天室：密文最長保留 6 小時
 * - 進入聊天室：該批未開訊息最多保留 5 分鐘
 * - 點開單則：伺服器立即刪除密文，前端顯示 15／20 秒後消失
 * - 支援聊天室紅綠燈、敲一下、同步閱後秒數、任一方結束整段對話
 * - 通話模組只交換 WebRTC signaling，不承載或保存語音內容
 */

var CONFIG = {
  VERSION: 'v4.5-pair-code-qr-delivery-fix',
  DEFAULT_TTL_SECONDS: 21600,
  MAX_TTL_SECONDS: 21600,
  MAX_INBOX_MESSAGES: 12,
  MAX_PACKET_LENGTH: 75000,
  ROOM_WINDOW_SECONDS: 300,
  PRESENCE_TTL_SECONDS: 45,
  PRESENCE_FRESH_MS: 15000,
  ROOM_EVENT_TTL_SECONDS: 21600,
  ROOM_EVENT_LIMIT: 40,
  END_TTL_SECONDS: 21600,
  INVITE_DEFAULT_TTL_SECONDS: 1800,
  INVITE_MIN_TTL_SECONDS: 30,
  INVITE_MAX_TTL_SECONDS: 21600,
  INVITE_STATUS_TTL_SECONDS: 21600,
  PAIRING_DEFAULT_TTL_SECONDS: 1800,
  PAIRING_MIN_TTL_SECONDS: 60,
  PAIRING_MAX_TTL_SECONDS: 21600,
  PAIRING_STATUS_TTL_SECONDS: 21600
};

function doGet() {
  return json_({
    ok: true,
    name: '私•話 GAS API',
    version: CONFIG.VERSION,
    message: 'Use POST with JSON body.'
  });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    var action = String(body.action || '').trim();

    var routes = {
      health: function () { return { ok: true, version: CONFIG.VERSION, time: Date.now() }; },
      createInvite: function () { return createInvite_(body); },
      acceptInvite: function () { return acceptInvite_(body); },
      inviteStatus: function () { return inviteStatus_(body); },
      cancelInvite: function () { return cancelInvite_(body); },
      createPairing: function () { return createPairing_(body); },
      acceptPairing: function () { return acceptPairing_(body); },
      pairingStatus: function () { return pairingStatus_(body); },
      cancelPairing: function () { return cancelPairing_(body); },
      sendSealedMessage: function () { return sendSealedMessage_(body); },
      unreadCount: function () { return unreadCount_(body); },
      listSealedMessages: function () { return listSealedMessages_(body); },
      openSealedMessage: function () { return openSealedMessage_(body); },
      readAndDeleteSealed: function () { return readAndDeleteSealed_(body); },
      pollMessages: function () { return readAndDeleteSealed_(body); },
      roomSync: function () { return roomSync_(body); },
      roomLeave: function () { return roomLeave_(body); },
      roomPush: function () { return roomPush_(body); },
      endConversation: function () { return endConversation_(body); }
    };

    if (routes[action]) return json_(routes[action]());

    var callResult = handleCallAction_(action, body);
    if (callResult !== null) return json_(callResult);

    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json_({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

/* ========================================================================== */
/* 一次性邀請：只暫存隨機頻道與時間設定，不保存名稱或解密鑰匙                 */
/* ========================================================================== */

function createInvite_(body) {
  var settings = sanitizeInviteSettings_(body && body.settings);
  var ttl = clampNumber_(
    settings.inviteTtlSeconds,
    CONFIG.INVITE_DEFAULT_TTL_SECONDS,
    CONFIG.INVITE_MIN_TTL_SECONDS,
    CONFIG.INVITE_MAX_TTL_SECONDS
  );
  settings.inviteTtlSeconds = ttl;

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var now = Date.now();
    var token = makeInviteToken_();
    var creatorChannel = makeChannelToken_();
    var guestChannel = makeChannelToken_();
    var record = {
      creatorChannel: creatorChannel,
      guestChannel: guestChannel,
      settings: settings,
      createdAt: now,
      expiresAt: now + ttl * 1000
    };

    cache.put(inviteKey_(token), JSON.stringify(record), ttl);
    writeInviteStatus_(cache, token, {
      state: 'waiting',
      createdAt: now,
      expiresAt: record.expiresAt
    }, ttl);

    return {
      ok: true,
      inviteToken: token,
      inviteTtlSeconds: ttl,
      expiresAt: record.expiresAt,
      session: {
        role: 'creator',
        myChannel: creatorChannel,
        peerChannel: guestChannel,
        settings: settings
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function acceptInvite_(body) {
  var token = cleanInviteToken_(body && body.inviteToken);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var raw = cache.get(inviteKey_(token));

    if (!raw) {
      var oldStatus = readInviteStatus_(cache, token);
      if (oldStatus && oldStatus.state === 'accepted') {
        throw new Error('這條邀請已經被使用。');
      }
      if (oldStatus && oldStatus.state === 'canceled') {
        throw new Error('這條邀請已被取消。');
      }
      throw new Error('邀請已失效，請對方重新建立。');
    }

    var record;
    try {
      record = JSON.parse(raw);
    } catch (err) {
      cache.remove(inviteKey_(token));
      throw new Error('邀請資料損壞，請重新建立。');
    }

    var now = Date.now();
    if (!record || Number(record.expiresAt || 0) <= now) {
      cache.remove(inviteKey_(token));
      writeInviteStatus_(cache, token, { state: 'expired', expiredAt: now }, CONFIG.INVITE_STATUS_TTL_SECONDS);
      throw new Error('邀請已過期，請對方重新建立。');
    }

    var creatorChannel = cleanToken_(record.creatorChannel);
    var guestChannel = cleanToken_(record.guestChannel);
    var settings = sanitizeInviteSettings_(record.settings);

    // 一次性：接受成功時立即刪除邀請本體。
    cache.remove(inviteKey_(token));
    writeInviteStatus_(cache, token, {
      state: 'accepted',
      acceptedAt: now,
      expiresAt: Number(record.expiresAt || now)
    }, CONFIG.INVITE_STATUS_TTL_SECONDS);

    return {
      ok: true,
      acceptedAt: now,
      session: {
        role: 'guest',
        myChannel: guestChannel,
        peerChannel: creatorChannel,
        settings: settings
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function inviteStatus_(body) {
  var token = cleanInviteToken_(body && body.inviteToken);
  var cache = CacheService.getScriptCache();
  var status = readInviteStatus_(cache, token);
  var raw = cache.get(inviteKey_(token));
  var now = Date.now();

  if (status && status.state && status.state !== 'waiting') {
    return {
      ok: true,
      state: String(status.state),
      acceptedAt: Number(status.acceptedAt || 0),
      canceledAt: Number(status.canceledAt || 0),
      expiresAt: Number(status.expiresAt || 0)
    };
  }

  if (raw) {
    try {
      var record = JSON.parse(raw);
      if (record && Number(record.expiresAt || 0) > now) {
        return {
          ok: true,
          state: 'waiting',
          createdAt: Number(record.createdAt || 0),
          expiresAt: Number(record.expiresAt || 0)
        };
      }
    } catch (err) {}
  }

  return { ok: true, state: 'expired', expiresAt: status ? Number(status.expiresAt || 0) : 0 };
}

function cancelInvite_(body) {
  var token = cleanInviteToken_(body && body.inviteToken);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var oldStatus = readInviteStatus_(cache, token);
    if (oldStatus && oldStatus.state === 'accepted') {
      throw new Error('對方已經接受，不能再取消這條邀請。');
    }

    cache.remove(inviteKey_(token));
    var now = Date.now();
    writeInviteStatus_(cache, token, {
      state: 'canceled',
      canceledAt: now
    }, CONFIG.INVITE_STATUS_TTL_SECONDS);

    return { ok: true, state: 'canceled', canceledAt: now };
  } finally {
    lock.releaseLock();
  }
}

function sanitizeInviteSettings_(value) {
  value = value || {};
  return {
    displaySeconds: clampNumber_(value.displaySeconds, 20, 15, 60),
    sealedBubbleSeconds: 300,
    messageTtlSeconds: clampNumber_(value.messageTtlSeconds, 21600, 60, 21600),
    inviteTtlSeconds: clampNumber_(
      value.inviteTtlSeconds,
      CONFIG.INVITE_DEFAULT_TTL_SECONDS,
      CONFIG.INVITE_MIN_TTL_SECONDS,
      CONFIG.INVITE_MAX_TTL_SECONDS
    )
  };
}

function writeInviteStatus_(cache, token, value, ttl) {
  cache.put(
    inviteStatusKey_(token),
    JSON.stringify(value || {}),
    Math.max(1, Math.min(CONFIG.INVITE_STATUS_TTL_SECONDS, Number(ttl || CONFIG.INVITE_STATUS_TTL_SECONDS)))
  );
}

function readInviteStatus_(cache, token) {
  var raw = cache.get(inviteStatusKey_(token));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function cleanInviteToken_(token) {
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{24,180}$/.test(token)) {
    throw new Error('邀請碼格式錯誤。');
  }
  return token;
}

function makeInviteToken_() {
  return 'iv_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function makeChannelToken_() {
  return 'ch_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function inviteKey_(token) {
  return 'invite:' + hashKeyPart_(cleanInviteToken_(token));
}

function inviteStatusKey_(token) {
  return 'invite-status:' + hashKeyPart_(cleanInviteToken_(token));
}

function hashKeyPart_(value) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '');
}


/* ========================================================================== */
/* v4.5 邀請碼／QR Code 一次性配對                                            */
/*                                                                            */
/* 前端以 12 碼本機推導：                                                     */
/* 1) pairingId（SHA-256 摘要）交給 GAS 找配對記錄                            */
/* 2) sealedKey（另一組 SHA-256）只留在兩台裝置                               */
/* GAS 不取得邀請碼，也不取得訊息解密金鑰。                                   */
/* ========================================================================== */

function createPairing_(body) {
  var pairingId = cleanPairingId_(body && body.pairingId);
  var settings = sanitizeInviteSettings_(body && body.settings);
  var ttl = clampNumber_(
    settings.inviteTtlSeconds,
    CONFIG.PAIRING_DEFAULT_TTL_SECONDS,
    CONFIG.PAIRING_MIN_TTL_SECONDS,
    CONFIG.PAIRING_MAX_TTL_SECONDS
  );
  settings.inviteTtlSeconds = ttl;

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var cache = CacheService.getScriptCache();
    var now = Date.now();
    var oldRaw = cache.get(pairingKey_(pairingId));
    var oldStatus = readPairingStatus_(cache, pairingId);
    if (oldRaw || (oldStatus && oldStatus.state === 'waiting')) {
      throw new Error('這個邀請碼已經存在，請重新建立。');
    }

    var record = {
      creatorChannel: makeChannelToken_(),
      guestChannel: makeChannelToken_(),
      settings: settings,
      createdAt: now,
      expiresAt: now + ttl * 1000
    };
    cache.put(pairingKey_(pairingId), JSON.stringify(record), ttl);
    writePairingStatus_(cache, pairingId, {
      state: 'waiting',
      createdAt: now,
      expiresAt: record.expiresAt
    }, ttl);

    return {
      ok: true,
      pairingId: pairingId,
      expiresAt: record.expiresAt,
      session: {
        role: 'creator',
        myChannel: record.creatorChannel,
        peerChannel: record.guestChannel,
        settings: settings
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function acceptPairing_(body) {
  var pairingId = cleanPairingId_(body && body.pairingId);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var cache = CacheService.getScriptCache();
    var raw = cache.get(pairingKey_(pairingId));
    if (!raw) {
      var oldStatus = readPairingStatus_(cache, pairingId);
      if (oldStatus && oldStatus.state === 'accepted') throw new Error('這組邀請碼已經被使用。');
      if (oldStatus && oldStatus.state === 'canceled') throw new Error('這組邀請碼已被取消。');
      throw new Error('邀請碼錯誤或已過期。');
    }

    var record;
    try { record = JSON.parse(raw); }
    catch (err) {
      cache.remove(pairingKey_(pairingId));
      throw new Error('配對資料損壞，請重新建立邀請碼。');
    }

    var now = Date.now();
    if (!record || Number(record.expiresAt || 0) <= now) {
      cache.remove(pairingKey_(pairingId));
      writePairingStatus_(cache, pairingId, { state: 'expired', expiredAt: now }, CONFIG.PAIRING_STATUS_TTL_SECONDS);
      throw new Error('邀請碼已過期。');
    }

    var creatorChannel = cleanToken_(record.creatorChannel);
    var guestChannel = cleanToken_(record.guestChannel);
    var settings = sanitizeInviteSettings_(record.settings);

    // 一次性：成功取得頻道時立刻銷毀配對本體。
    cache.remove(pairingKey_(pairingId));
    writePairingStatus_(cache, pairingId, {
      state: 'accepted',
      acceptedAt: now,
      expiresAt: Number(record.expiresAt || now)
    }, CONFIG.PAIRING_STATUS_TTL_SECONDS);

    return {
      ok: true,
      acceptedAt: now,
      session: {
        role: 'guest',
        myChannel: guestChannel,
        peerChannel: creatorChannel,
        settings: settings
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function pairingStatus_(body) {
  var pairingId = cleanPairingId_(body && body.pairingId);
  var cache = CacheService.getScriptCache();
  var status = readPairingStatus_(cache, pairingId);
  var raw = cache.get(pairingKey_(pairingId));
  var now = Date.now();

  if (status && status.state && status.state !== 'waiting') {
    return {
      ok: true,
      state: String(status.state),
      acceptedAt: Number(status.acceptedAt || 0),
      canceledAt: Number(status.canceledAt || 0),
      expiresAt: Number(status.expiresAt || 0)
    };
  }
  if (raw) {
    try {
      var record = JSON.parse(raw);
      if (record && Number(record.expiresAt || 0) > now) {
        return { ok: true, state: 'waiting', createdAt: Number(record.createdAt || 0), expiresAt: Number(record.expiresAt || 0) };
      }
    } catch (err) {}
  }
  return { ok: true, state: 'expired', expiresAt: status ? Number(status.expiresAt || 0) : 0 };
}

function cancelPairing_(body) {
  var pairingId = cleanPairingId_(body && body.pairingId);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var cache = CacheService.getScriptCache();
    var oldStatus = readPairingStatus_(cache, pairingId);
    if (oldStatus && oldStatus.state === 'accepted') throw new Error('對方已完成配對，不能取消。');
    cache.remove(pairingKey_(pairingId));
    var now = Date.now();
    writePairingStatus_(cache, pairingId, { state: 'canceled', canceledAt: now }, CONFIG.PAIRING_STATUS_TTL_SECONDS);
    return { ok: true, state: 'canceled', canceledAt: now };
  } finally {
    lock.releaseLock();
  }
}

function cleanPairingId_(value) {
  value = String(value || '').trim().toLowerCase();
  if (!/^p_[a-f0-9]{40}$/.test(value)) throw new Error('配對識別碼格式錯誤。');
  return value;
}

function pairingKey_(pairingId) {
  return 'pairing:' + hashKeyPart_(cleanPairingId_(pairingId));
}

function pairingStatusKey_(pairingId) {
  return 'pairing-status:' + hashKeyPart_(cleanPairingId_(pairingId));
}

function writePairingStatus_(cache, pairingId, value, ttl) {
  cache.put(
    pairingStatusKey_(pairingId),
    JSON.stringify(value || {}),
    Math.max(1, Math.min(CONFIG.PAIRING_STATUS_TTL_SECONDS, Number(ttl || CONFIG.PAIRING_STATUS_TTL_SECONDS)))
  );
}

function readPairingStatus_(cache, pairingId) {
  var raw = cache.get(pairingStatusKey_(pairingId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

/* ========================================================================== */
/* 密封訊息郵筒                                                               */
/* ========================================================================== */

function sendSealedMessage_(body) {
  var peerChannel = cleanToken_(body.peerChannel);
  var packet = cleanPacket_(body.packet);
  var ttl = clampNumber_(
    body.messageTtlSeconds,
    CONFIG.DEFAULT_TTL_SECONDS,
    60,
    CONFIG.MAX_TTL_SECONDS
  );

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var now = Date.now();
    var index = pruneIndex_(cache, peerChannel, readIndex_(cache, peerChannel));
    var id = makeMessageId_();
    var hardExpiresAt = now + ttl * 1000;
    var roomExpiresAt = 0;

    var peerPresence = readPresence_(cache, peerChannel);
    if (isPresenceInRoom_(peerPresence, now)) {
      peerPresence = ensurePresenceWindow_(cache, peerChannel, peerPresence, now);
      roomExpiresAt = Number(peerPresence.windowExpiresAt || 0);
    }

    while (index.length >= CONFIG.MAX_INBOX_MESSAGES) {
      var oldest = index.shift();
      if (oldest && oldest.id) cache.remove(messageKey_(peerChannel, oldest.id));
    }

    var effectiveExpiresAt = roomExpiresAt
      ? Math.min(hardExpiresAt, roomExpiresAt)
      : hardExpiresAt;

    cache.put(
      messageKey_(peerChannel, id),
      packet,
      ttlSecondsUntil_(effectiveExpiresAt)
    );

    index.push({
      id: id,
      createdAt: now,
      hardExpiresAt: hardExpiresAt,
      roomExpiresAt: roomExpiresAt
    });
    writeIndex_(cache, peerChannel, index);

    return {
      ok: true,
      id: id,
      timestamp: now,
      messageTtlSeconds: ttl,
      recipientInRoom: Boolean(roomExpiresAt),
      roomExpiresAt: roomExpiresAt,
      queuedCount: index.length,
      deliveryState: 'queued'
    };
  } finally {
    lock.releaseLock();
  }
}

function unreadCount_(body) {
  var myChannel = cleanToken_(body.myChannel);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var index = pruneIndex_(cache, myChannel, readIndex_(cache, myChannel));
    writeIndex_(cache, myChannel, index);
    return { ok: true, unread: index.length };
  } finally {
    lock.releaseLock();
  }
}

function listSealedMessages_(body) {
  var myChannel = cleanToken_(body.myChannel);
  var inRoom = Boolean(body.inRoom);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var now = Date.now();
    var index = pruneIndex_(cache, myChannel, readIndex_(cache, myChannel));
    var ownPresence = null;

    if (inRoom) {
      ownPresence = upsertPresence_(cache, myChannel, true, now);
      var windowExpiresAt = Number(ownPresence.windowExpiresAt || 0);
      var kept = [];

      index.forEach(function (item) {
        if (!item || !item.id) return;
        var packetKey = messageKey_(myChannel, item.id);
        var packet = cache.get(packetKey);
        if (!packet) return;

        if (!Number(item.roomExpiresAt || 0)) {
          item.roomExpiresAt = windowExpiresAt;
          var effectiveExpiresAt = Math.min(
            Number(item.hardExpiresAt || now + CONFIG.MAX_TTL_SECONDS * 1000),
            windowExpiresAt
          );
          if (effectiveExpiresAt <= now) {
            cache.remove(packetKey);
            return;
          }
          cache.put(packetKey, packet, ttlSecondsUntil_(effectiveExpiresAt));
        }

        if (Number(item.roomExpiresAt || 0) <= now) {
          cache.remove(packetKey);
          return;
        }
        kept.push(item);
      });
      index = kept;
    }

    writeIndex_(cache, myChannel, index);

    return {
      ok: true,
      unread: index.length,
      roomWindowExpiresAt: ownPresence ? Number(ownPresence.windowExpiresAt || 0) : 0,
      messages: index.map(function (item) {
        return {
          id: String(item.id),
          createdAt: Number(item.createdAt || now),
          roomExpiresAt: Number(item.roomExpiresAt || 0)
        };
      })
    };
  } finally {
    lock.releaseLock();
  }
}

function openSealedMessage_(body) {
  var myChannel = cleanToken_(body.myChannel);
  var id = cleanMessageId_(body.id);
  var displaySeconds = clampNumber_(body.displaySeconds, 20, 5, 60);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var now = Date.now();
    var index = pruneIndex_(cache, myChannel, readIndex_(cache, myChannel));
    var target = null;
    var next = [];

    index.forEach(function (item) {
      if (item && String(item.id) === id && !target) target = item;
      else next.push(item);
    });

    if (!target) throw new Error('這則訊息已消失或已被開啟。');

    if (!Number(target.roomExpiresAt || 0)) {
      var presence = upsertPresence_(cache, myChannel, true, now);
      target.roomExpiresAt = Number(presence.windowExpiresAt || now + CONFIG.ROOM_WINDOW_SECONDS * 1000);
    }

    if (Number(target.roomExpiresAt || 0) <= now) {
      cache.remove(messageKey_(myChannel, id));
      writeIndex_(cache, myChannel, next);
      throw new Error('這一輪閱讀時間已結束。');
    }

    var packetKey = messageKey_(myChannel, id);
    var packet = cache.get(packetKey);
    if (!packet) {
      writeIndex_(cache, myChannel, next);
      throw new Error('這則訊息已過期。');
    }

    // 一旦點開，伺服器立即刪除密文；前端只在記憶體顯示指定秒數。
    cache.remove(packetKey);
    writeIndex_(cache, myChannel, next);

    return {
      ok: true,
      id: id,
      packet: String(packet).slice(0, CONFIG.MAX_PACKET_LENGTH),
      createdAt: Number(target.createdAt || now),
      openedAt: now,
      displaySeconds: displaySeconds,
      deleteAt: Math.min(now + displaySeconds * 1000, Number(target.roomExpiresAt || 0))
    };
  } finally {
    lock.releaseLock();
  }
}

function readAndDeleteSealed_(body) {
  var myChannel = cleanToken_(body.myChannel);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var index = pruneIndex_(cache, myChannel, readIndex_(cache, myChannel));
    var packets = [];

    index.forEach(function (item) {
      if (!item || !item.id) return;
      var key = messageKey_(myChannel, item.id);
      var packet = cache.get(key);
      cache.remove(key);
      if (packet) {
        packets.push({
          id: String(item.id),
          packet: String(packet).slice(0, CONFIG.MAX_PACKET_LENGTH),
          createdAt: Number(item.createdAt || Date.now())
        });
      }
    });

    cache.remove(indexKey_(myChannel));
    return { ok: true, unread: 0, packets: packets };
  } finally {
    lock.releaseLock();
  }
}

function readIndex_(cache, channel) {
  var raw = cache.get(indexKey_(channel));
  if (!raw) return [];
  try {
    var value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch (err) {
    return [];
  }
}

function writeIndex_(cache, channel, index) {
  if (!index.length) {
    cache.remove(indexKey_(channel));
    return;
  }
  cache.put(
    indexKey_(channel),
    JSON.stringify(index.slice(-CONFIG.MAX_INBOX_MESSAGES)),
    CONFIG.MAX_TTL_SECONDS
  );
}

function pruneIndex_(cache, channel, index) {
  var now = Date.now();
  var kept = [];
  (index || []).forEach(function (item) {
    if (!item || !item.id) return;
    var hardExpiresAt = Number(item.hardExpiresAt || 0);
    var roomExpiresAt = Number(item.roomExpiresAt || 0);
    var expired = (hardExpiresAt && hardExpiresAt <= now) || (roomExpiresAt && roomExpiresAt <= now);
    var key = messageKey_(channel, item.id);
    if (expired || !cache.get(key)) {
      cache.remove(key);
      return;
    }
    kept.push(item);
  });
  return kept;
}

function clearInbox_(cache, channel) {
  var index = readIndex_(cache, channel);
  index.forEach(function (item) {
    if (item && item.id) cache.remove(messageKey_(channel, item.id));
  });
  cache.remove(indexKey_(channel));
}

/* ========================================================================== */
/* 聊天室在線狀態、事件、同步設定                                             */
/* ========================================================================== */

function roomSync_(body) {
  var myChannel = cleanToken_(body.myChannel);
  var peerChannel = cleanToken_(body.peerChannel);
  var inRoom = Boolean(body.inRoom);
  var now = Date.now();
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var mine = upsertPresence_(cache, myChannel, inRoom, now);
    var peer = readPresence_(cache, peerChannel);
    var peerFresh = Boolean(peer && now - Number(peer.lastSeen || 0) <= 60000);
    var peerInRoom = isPresenceInRoom_(peer, now);
    var ended = readEnd_(cache, myChannel);
    var events = pullRoomEvents_(cache, myChannel, now);

    return {
      ok: true,
      now: now,
      ended: ended,
      ownRoomWindowExpiresAt: inRoom ? Number(mine.windowExpiresAt || 0) : 0,
      peer: {
        inRoom: peerInRoom,
        recentlySeen: peerFresh,
        lastSeen: peer ? Number(peer.lastSeen || 0) : 0
      },
      events: events
    };
  } finally {
    lock.releaseLock();
  }
}

function roomLeave_(body) {
  var myChannel = cleanToken_(body.myChannel);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var cache = CacheService.getScriptCache();
    var presence = upsertPresence_(cache, myChannel, false, Date.now());
    return { ok: true, presence: presence };
  } finally {
    lock.releaseLock();
  }
}

function roomPush_(body) {
  var myChannel = cleanToken_(body.myChannel);
  var peerChannel = cleanToken_(body.peerChannel);
  var event = sanitizeRoomEvent_(body.event);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var envelope = {
      id: Utilities.getUuid(),
      fromChannel: myChannel,
      event: event,
      createdAt: Date.now()
    };
    pushRoomEvent_(cache, peerChannel, envelope);
    return { ok: true, eventId: envelope.id };
  } finally {
    lock.releaseLock();
  }
}

function endConversation_(body) {
  var myChannel = cleanToken_(body.myChannel);
  var peerChannel = cleanToken_(body.peerChannel);
  var now = Date.now();
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    var cache = CacheService.getScriptCache();
    var endState = { ended: true, endedAt: now };
    cache.put(endKey_(myChannel), JSON.stringify(endState), CONFIG.END_TTL_SECONDS);
    cache.put(endKey_(peerChannel), JSON.stringify(endState), CONFIG.END_TTL_SECONDS);

    clearInbox_(cache, myChannel);
    clearInbox_(cache, peerChannel);
    upsertPresence_(cache, myChannel, false, now);

    pushRoomEvent_(cache, peerChannel, {
      id: Utilities.getUuid(),
      fromChannel: myChannel,
      event: { type: 'end', payload: {}, at: now },
      createdAt: now
    });

    return { ok: true, endedAt: now };
  } finally {
    lock.releaseLock();
  }
}

function upsertPresence_(cache, channel, inRoom, now) {
  var current = readPresence_(cache, channel) || {};
  var wasActive = isPresenceInRoom_(current, now);

  current.inRoom = Boolean(inRoom);
  current.lastSeen = now;

  if (inRoom) {
    if (!wasActive || !Number(current.windowExpiresAt || 0) || Number(current.windowExpiresAt) <= now) {
      current.enteredAt = now;
      current.windowExpiresAt = now + CONFIG.ROOM_WINDOW_SECONDS * 1000;
    }
  }

  cache.put(presenceKey_(channel), JSON.stringify(current), CONFIG.PRESENCE_TTL_SECONDS);
  return current;
}

function ensurePresenceWindow_(cache, channel, presence, now) {
  presence = presence || {};
  if (!Number(presence.windowExpiresAt || 0) || Number(presence.windowExpiresAt) <= now) {
    presence.enteredAt = now;
    presence.windowExpiresAt = now + CONFIG.ROOM_WINDOW_SECONDS * 1000;
  }
  cache.put(presenceKey_(channel), JSON.stringify(presence), CONFIG.PRESENCE_TTL_SECONDS);
  return presence;
}

function readPresence_(cache, channel) {
  var raw = cache.get(presenceKey_(channel));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function isPresenceInRoom_(presence, now) {
  return Boolean(
    presence &&
    presence.inRoom &&
    now - Number(presence.lastSeen || 0) <= CONFIG.PRESENCE_FRESH_MS
  );
}

function sanitizeRoomEvent_(value) {
  if (!value || typeof value !== 'object') throw new Error('缺少聊天室事件。');
  var type = String(value.type || '').trim();
  if (type !== 'knock' && type !== 'settings') throw new Error('不支援的聊天室事件。');

  var payload = {};
  if (type === 'settings') {
    payload.displaySeconds = clampNumber_(
      value.payload && value.payload.displaySeconds,
      20,
      5,
      60
    );
  }

  return {
    type: type,
    payload: payload,
    at: Number(value.at || Date.now())
  };
}

function pushRoomEvent_(cache, channel, envelope) {
  var key = roomEventKey_(channel);
  var queue = parseJsonArray_(cache.get(key));
  queue.push(envelope);
  if (queue.length > CONFIG.ROOM_EVENT_LIMIT) {
    queue = queue.slice(queue.length - CONFIG.ROOM_EVENT_LIMIT);
  }
  cache.put(key, JSON.stringify(queue), CONFIG.ROOM_EVENT_TTL_SECONDS);
}

function pullRoomEvents_(cache, channel, now) {
  var key = roomEventKey_(channel);
  var queue = parseJsonArray_(cache.get(key));
  cache.remove(key);
  var cutoff = now - CONFIG.ROOM_EVENT_TTL_SECONDS * 1000;
  return queue.filter(function (item) {
    return item && Number(item.createdAt || 0) >= cutoff;
  });
}

function readEnd_(cache, channel) {
  var raw = cache.get(endKey_(channel));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return { ended: true }; }
}

/* ========================================================================== */
/* 共用工具                                                                   */
/* ========================================================================== */

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try { return JSON.parse(e.postData.contents); }
  catch (err) { throw new Error('JSON 格式錯誤'); }
}

function cleanPacket_(packet) {
  packet = String(packet || '').trim();
  if (!packet) throw new Error('密封包不可為空');
  if (packet.length > CONFIG.MAX_PACKET_LENGTH) throw new Error('照片或密封包太大');
  if (!/^ANG1\.[A-Za-z0-9_-]{20,}$/.test(packet)) throw new Error('密封包格式錯誤');
  return packet;
}

function cleanToken_(token) {
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{12,120}$/.test(token)) throw new Error('頻道 ID 格式錯誤');
  return token;
}

function cleanMessageId_(id) {
  id = String(id || '').trim();
  if (!/^m_[A-Za-z0-9]{8,40}$/.test(id)) throw new Error('訊息 ID 格式錯誤');
  return id;
}

function indexKey_(channel) { return 'inbox-index:' + cleanToken_(channel); }
function messageKey_(channel, id) { return 'inbox-message:' + cleanToken_(channel) + ':' + String(id || ''); }
function presenceKey_(channel) { return 'room-presence:' + cleanToken_(channel); }
function roomEventKey_(channel) { return 'room-events:' + cleanToken_(channel); }
function endKey_(channel) { return 'room-ended:' + cleanToken_(channel); }

function makeMessageId_() {
  return 'm_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function clampNumber_(value, fallback, min, max) {
  var number = Math.round(Number(value));
  if (!isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function ttlSecondsUntil_(timestamp) {
  return Math.max(1, Math.min(CONFIG.MAX_TTL_SECONDS, Math.ceil((Number(timestamp) - Date.now()) / 1000)));
}

function parseJsonArray_(raw) {
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ========================================================================== */
/* 語音通話 WebRTC signaling                                                 */
/* ========================================================================== */

var CALL_SIGNAL_TTL_SECONDS_ = 180;
var CALL_SIGNAL_QUEUE_LIMIT_ = 80;
var CALL_SIGNAL_MAX_JSON_LENGTH_ = 24000;
var CALL_SIGNAL_TYPES_ = {
  ring: true,
  offer: true,
  answer: true,
  ice: true,
  reject: true,
  busy: true,
  cancel: true,
  end: true
};

function handleCallAction_(action, data) {
  action = String(action || '');
  data = data || {};
  if (action === 'callPush') return callPush_(data);
  if (action === 'callPull') return callPull_(data);
  return null;
}

function callPush_(data) {
  var myChannel = validateCallChannel_(data.myChannel, 'myChannel');
  var peerChannel = validateCallChannel_(data.peerChannel, 'peerChannel');
  var event = sanitizeCallEvent_(data.event);
  var envelope = {
    id: Utilities.getUuid(),
    fromChannel: myChannel,
    event: event,
    createdAt: Date.now()
  };

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var cache = CacheService.getScriptCache();
    var key = callQueueKey_(peerChannel);
    var queue = parseCallQueue_(cache.get(key));
    var cutoff = Date.now() - CALL_SIGNAL_TTL_SECONDS_ * 1000;
    queue = queue.filter(function (item) {
      return item && Number(item.createdAt || 0) >= cutoff;
    });
    queue.push(envelope);
    if (queue.length > CALL_SIGNAL_QUEUE_LIMIT_) {
      queue = queue.slice(queue.length - CALL_SIGNAL_QUEUE_LIMIT_);
    }
    cache.put(key, JSON.stringify(queue), CALL_SIGNAL_TTL_SECONDS_);
  } finally {
    lock.releaseLock();
  }

  return { ok: true, signalId: envelope.id };
}

function callPull_(data) {
  var myChannel = validateCallChannel_(data.myChannel, 'myChannel');
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var cache = CacheService.getScriptCache();
    var key = callQueueKey_(myChannel);
    var queue = parseCallQueue_(cache.get(key));
    cache.remove(key);

    var cutoff = Date.now() - CALL_SIGNAL_TTL_SECONDS_ * 1000;
    queue = queue.filter(function (item) {
      return item && Number(item.createdAt || 0) >= cutoff;
    });
    return { ok: true, events: queue };
  } finally {
    lock.releaseLock();
  }
}

function sanitizeCallEvent_(value) {
  if (!value || typeof value !== 'object') throw new Error('缺少通話事件。');
  var type = String(value.type || '').trim();
  if (!CALL_SIGNAL_TYPES_[type]) throw new Error('不支援的通話事件：' + type);

  var callId = String(value.callId || '').trim();
  if (!callId || callId.length > 120) throw new Error('通話識別碼不正確。');

  var clean = {
    type: type,
    callId: callId,
    fromLabel: String(value.fromLabel || '').slice(0, 60),
    payload: value.payload && typeof value.payload === 'object' ? value.payload : {},
    at: Number(value.at || Date.now()),
    version: String(value.version || '').slice(0, 60)
  };

  var json = JSON.stringify(clean);
  if (json.length > CALL_SIGNAL_MAX_JSON_LENGTH_) throw new Error('通話連線資料過大。');
  return clean;
}

function validateCallChannel_(value, name) {
  var text = String(value || '').trim();
  if (text.length < 8 || text.length > 180) throw new Error(name + ' 不正確。');
  return text;
}

function callQueueKey_(channel) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(channel),
    Utilities.Charset.UTF_8
  );
  return 'ephemeral_call_' + Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '');
}

function parseCallQueue_(raw) {
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}
