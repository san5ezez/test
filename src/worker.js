const DEFAULT_RSS = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function envValue(env, key, fallback = "") {
  return env[key] ?? fallback;
}

async function getDashboard(env) {
  if (!env.DATA) {
    return {
      updatedAt: null,
      error: "KV binding DATA is not connected."
    };
  }
  return (await env.DATA.get("dashboard", "json")) || {
    updatedAt: null,
    emails: [],
    news: [],
    summary: "Данных пока нет.",
    telegramReport: "Данных пока нет."
  };
}

async function googleAccessToken(env) {
  const raw = await env.DATA?.get("gmail_tokens", "json");
  if (!raw) return null;

  if (raw.access_token && raw.expires_at && Date.now() < raw.expires_at - 60000) {
    return raw.access_token;
  }

  if (!raw.refresh_token) return null;

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: raw.refresh_token,
    grant_type: "refresh_token"
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!r.ok) throw new Error("Google token refresh failed");
  const token = await r.json();

  await env.DATA.put("gmail_tokens", JSON.stringify({
    ...raw,
    access_token: token.access_token,
    expires_at: Date.now() + (token.expires_in || 3600) * 1000
  }));

  return token.access_token;
}

async function collectGmail(env) {
  if (!env.DATA || !env.GOOGLE_CLIENT_ID) return [];

  const token = await googleAccessToken(env);
  if (!token) return [];

  const list = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=newer_than:7d",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!list.ok) return [];
  const data = await list.json();
  const messages = data.messages || [];

  const result = [];
  for (const item of messages.slice(0, 20)) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) continue;

    const msg = await r.json();
    const headers = Object.fromEntries(
      (msg.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
    );

    result.push({
      id: item.id,
      from: headers.from || "",
      subject: headers.subject || "(без темы)",
      date: headers.date || "",
      snippet: msg.snippet || ""
    });
  }

  return result;
}

function stripXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? stripXml(m[1]) : "";
}

async function collectNews(env) {
  const urls = (env.NEWS_RSS_URLS || DEFAULT_RSS.join(","))
    .split(",").map(x => x.trim()).filter(Boolean);

  const all = [];

  for (const url of urls.slice(0, 10)) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "NewsDashboard/1.0" } });
      if (!r.ok) continue;
      const xml = await r.text();
      const blocks = [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map(x => x[0]);

      for (const block of blocks.slice(0, 20)) {
        const title = tag(block, "title");
        const link = tag(block, "link") || tag(block, "guid");
        const description = tag(block, "description");
        const pubDate = tag(block, "pubDate");
        if (title) all.push({ title, link, description, pubDate });
      }
    } catch {}
  }

  const seen = new Set();
  return all.filter(x => {
    const key = x.link || x.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
}

async function analyzeWithAI(env, emails, news) {
  if (!env.AI) {
    return {
      summary: "Workers AI не подключён.",
      emailImportantIds: [],
      newsImportantIds: [],
      priorities: [],
      telegramReport: "Workers AI не подключён. Проверь binding AI."
    };
  }

  const model = env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";

  const prompt = `Проанализируй входящие письма и новости.
Выдели действительно важное: безопасность, деньги, аккаунты, учёба/работа,
срочные уведомления, крупные события и новости, которые могут быть практически
важны пользователю. Не выдумывай факты.

Верни ТОЛЬКО JSON:
{
 "summary":"краткая сводка на русском",
 "emailImportantIds":[числа],
 "newsImportantIds":[числа],
 "priorities":[{"type":"email|news","id":число,"reason":"причина"}],
 "telegramReport":"короткий отчёт на русском"
}

EMAILS:
${JSON.stringify(emails)}

NEWS:
${JSON.stringify(news)}`;

  const result = await env.AI.run(model, {
    messages: [
      { role: "system", content: "Ты аналитик новостей и входящих сообщений. Отвечай строго JSON." },
      { role: "user", content: prompt }
    ],
    max_tokens: 1800,
    temperature: 0.2
  });

  let raw = result?.response || result?.output_text || "";
  raw = String(raw).replace(/^```json\s*/i, "").replace(/```$/i, "").trim();

  try {
    return JSON.parse(raw);
  } catch {
    return {
      summary: "ИИ вернул ответ в неподходящем формате.",
      emailImportantIds: [],
      newsImportantIds: [],
      priorities: [],
      telegramReport: "Не удалось разобрать ответ Workers AI."
    };
  }
}

async function refreshAll(env) {
  const [emails, news] = await Promise.all([
    collectGmail(env),
    collectNews(env)
  ]);

  const ai = await analyzeWithAI(env, emails, news);
  const emailImportant = new Set(ai.emailImportantIds || []);
  const newsImportant = new Set(ai.newsImportantIds || []);

  emails.forEach((x, i) => x.important = emailImportant.has(i + 1));
  news.forEach((x, i) => x.important = newsImportant.has(i + 1));

  const dashboard = {
    updatedAt: new Date().toISOString(),
    emails,
    news,
    summary: ai.summary || "",
    priorities: ai.priorities || [],
    telegramReport: ai.telegramReport || ""
  };

  if (env.DATA) await env.DATA.put("dashboard", JSON.stringify(dashboard));
  return dashboard;
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const message = String(text || "Нет нового отчёта.").slice(0, 3900);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message
    })
  });
}

async function telegramWebhook(request, env) {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (got !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
  }

  const update = await request.json();
  const text = update?.message?.text?.trim();

  if (text === "/report") {
    const data = await getDashboard(env);
    await sendTelegram(env, data.telegramReport || data.summary);
  }

  return new Response("OK");
}

async function gmailStart(env) {
  const state = crypto.randomUUID();
  if (env.DATA) await env.DATA.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

  const redirect = env.GOOGLE_REDIRECT_URI;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirect,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    state
  });

  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    302
  );
}

async function gmailCallback(url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state || !env.DATA) return new Response("OAuth data missing", { status: 400 });

  const valid = await env.DATA.get(`oauth_state:${state}`);
  if (!valid) return new Response("Invalid or expired OAuth state", { status: 400 });
  await env.DATA.delete(`oauth_state:${state}`);

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code"
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!r.ok) return new Response("Google OAuth token exchange failed", { status: 500 });

  const token = await r.json();
  await env.DATA.put("gmail_tokens", JSON.stringify({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + (token.expires_in || 3600) * 1000
  }));

  return new Response(
    "Gmail подключён. Теперь можно открыть главную страницу Dashboard.",
    { headers: { "content-type": "text/plain; charset=utf-8" } }
  );
}

async function serveAsset(request, env) {
  if (!env.ASSETS) return new Response("Dashboard asset binding ASSETS is missing.", { status: 500 });
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        kv: !!env.DATA,
        ai: !!env.AI,
        telegram: !!env.TELEGRAM_BOT_TOKEN,
        gmail: !!env.GOOGLE_CLIENT_ID
      });
    }

    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      return json(await getDashboard(env));
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      return json(await refreshAll(env));
    }

    if (url.pathname === "/api/gmail/start") {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
        return new Response("Google OAuth variables are not configured.", { status: 500 });
      }
      return gmailStart(env);
    }

    if (url.pathname === "/api/gmail/callback") {
      return gmailCallback(url, env);
    }

    if (url.pathname === "/api/telegram/webhook" && request.method === "POST") {
      return telegramWebhook(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return serveAsset(request, env);
  },

  async scheduled(event, env, ctx) {
    const data = await refreshAll(env);

    // Cloudflare Cron uses UTC. Report every 3 hours at UTC 00,03,06...
    if (event.cron === "0 */3 * * *") {
      await sendTelegram(env, data.telegramReport || data.summary);
    }
  }
};
