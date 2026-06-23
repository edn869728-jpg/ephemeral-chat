/**
 * Cloudflare Pages Function /api/*
 *
 * 設定環境變數：
 * GAS_WEB_APP_URL = 你的 GAS Web App /exec 網址
 *
 * v3.4 已內建使用者提供的 GAS /exec 後端網址作為 fallback。
 * 若 Cloudflare Pages 有設定環境變數 GAS_WEB_APP_URL，會優先使用環境變數。
 */

const DEFAULT_GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbycGjtue6O7XgYrrm2YW2vPB9dmdeymAZgZa2jSl6MZxhIfZNOQ3bUz70DZpCZEuMlr/exec';

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const action = parts[1] || 'health';

  const gasWebAppUrl = env.GAS_WEB_APP_URL || DEFAULT_GAS_WEB_APP_URL;

  if (!gasWebAppUrl) {
    return responseJson({
      ok: false,
      error: 'Cloudflare Pages 尚未設定環境變數 GAS_WEB_APP_URL'
    }, 500);
  }

  let payload = {};

  if (request.method === 'POST') {
    try {
      payload = await request.json();
    } catch (err) {
      payload = {};
    }
  }

  payload.action = action;

  try {
    const gasResponse = await fetch(gasWebAppUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });

    const text = await gasResponse.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = {
        ok: false,
        error: 'GAS 回傳不是 JSON，請檢查 GAS 部署權限與網址。',
        status: gasResponse.status
      };
    }

    return responseJson(data, gasResponse.ok ? 200 : gasResponse.status);
  } catch (err) {
    return responseJson({
      ok: false,
      error: err && err.message ? err.message : String(err)
    }, 500);
  }
}

function responseJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders
  });
}
