// trendingtoday.skylinn.in — API Worker (Phase 1)
// Routed at trendingtoday.skylinn.in/api/*  (same origin as the Pages frontend,
// so no CORS/cookie headaches). See ../README.md for deploy + routing steps.

const SESSION_DAYS = 30;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function bad(msg, status = 400) {
  return json({ error: msg }, status);
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const saltHex = [...salt].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const computedHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return computedHex === hashHex;
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

function setSessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return { "set-cookie": `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}` };
}

function clearSessionCookie() {
  return { "set-cookie": "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" };
}

async function getUserFromRequest(request, env) {
  const token = getCookie(request, "session");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.expires_at > ?"
  ).bind(token, Date.now()).first();
  return row || null;
}

// ---------- auth ----------

async function handleSignup(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password || password.length < 8) return bad("Valid email and password (8+ chars) required");
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return bad("Email already registered", 409);
  const id = crypto.randomUUID();
  const password_hash = await hashPassword(password);
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, email, password_hash, Date.now()).run();
  const token = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, id, Date.now() + SESSION_DAYS * 86400000).run();
  return json({ id, email }, 201, setSessionCookie(token));
}

async function handleLogin(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return bad("Email and password required");
  const user = await env.DB.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").bind(email).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) return bad("Invalid credentials", 401);
  const token = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, user.id, Date.now() + SESSION_DAYS * 86400000).run();
  return json({ id: user.id, email: user.email }, 200, setSessionCookie(token));
}

async function handleLogout(request, env) {
  const token = getCookie(request, "session");
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json({ ok: true }, 200, clearSessionCookie());
}

// ---------- preferences ----------

async function handleGetPreferences(request, env, user) {
  const rows = await env.DB.prepare("SELECT source_type, keyword FROM user_preferences WHERE user_id = ?").bind(user.id).all();
  return json(rows.results || []);
}

async function handleAddPreference(request, env, user) {
  const { source_type, keyword } = await request.json().catch(() => ({}));
  const validTypes = ["youtube", "github_trending", "reddit", "rss", "twitter", "bilibili", "xhs"];
  if (!validTypes.includes(source_type) || !keyword) return bad("Valid source_type and keyword required");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO user_preferences (user_id, source_type, keyword, created_at) VALUES (?, ?, ?, ?)"
  ).bind(user.id, source_type, keyword, Date.now()).run();
  return json({ ok: true }, 201);
}

async function handleDeletePreference(request, env, user) {
  const { source_type, keyword } = await request.json().catch(() => ({}));
  await env.DB.prepare("DELETE FROM user_preferences WHERE user_id = ? AND source_type = ? AND keyword = ?")
    .bind(user.id, source_type, keyword).run();
  return json({ ok: true });
}

// ---------- feed ----------

async function handleFeed(request, env, user) {
  const rows = await env.DB.prepare(
    `SELECT fi.id, fi.source_type, fi.source_key, fi.title, fi.url, fi.summary, fi.published_at
     FROM feed_items fi
     JOIN user_preferences up ON up.source_type = fi.source_type AND up.keyword = fi.source_key
     WHERE up.user_id = ?
     ORDER BY fi.published_at DESC LIMIT 100`
  ).bind(user.id).all();
  return json(rows.results || []);
}

// ---------- Phase 2 ingest (Agent-Reach runner pushes here) ----------

async function handleDebugRunFetch(request, env) {
  const key = request.headers.get("x-ingest-key");
  if (!env.INGEST_KEY || key !== env.INGEST_KEY) return bad("Unauthorized", 401);
  await runCron(env);
  return json({ ok: true, ranAt: Date.now() });
}

async function handleIngest(request, env) {
  const key = request.headers.get("x-ingest-key");
  if (!env.INGEST_KEY || key !== env.INGEST_KEY) return bad("Unauthorized", 401);
  const items = await request.json().catch(() => null);
  if (!Array.isArray(items)) return bad("Body must be an array of items");
  await upsertItems(env, items);
  return json({ ingested: items.length });
}

async function upsertItems(env, items) {
  for (const item of items) {
    if (!item.url || !item.title || !item.source_type || !item.source_key) continue;
    const id = await sha256Hex(item.url);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO feed_items (id, source_type, source_key, title, url, summary, published_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, item.source_type, item.source_key, item.title, item.url, item.summary || null, item.published_at || Date.now(), Date.now()).run();
  }
}

// ---------- cron fetchers (open sources only) ----------

async function fetchYouTube(keyword, apiKey) {
  if (!apiKey) return [];
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=10&q=${encodeURIComponent(keyword)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map((v) => ({
    source_type: "youtube",
    source_key: keyword,
    title: v.snippet.title,
    url: `https://www.youtube.com/watch?v=${v.id.videoId}`,
    summary: v.snippet.description,
    published_at: new Date(v.snippet.publishedAt).getTime(),
  }));
}

async function fetchGithubTrending(language) {
  const url = language ? `https://github.com/trending/${language}?since=daily` : `https://github.com/trending?since=daily`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; trendingtoday-bot/1.0)" } });
  if (!res.ok) return [];
  const items = [];
  const rewriter = new HTMLRewriter().on("article.Box-row h2 a", {
    element(el) {
      const href = el.getAttribute("href");
      if (href) items.push({ href, title: "" });
    },
    text(t) {
      if (items.length) items[items.length - 1].title += t.text;
    },
  });
  await rewriter.transform(res).text();
  return items
    .filter((i) => i.href)
    .map((i) => ({
      source_type: "github_trending",
      source_key: language || "",
      title: i.title.replace(/\s+/g, " ").trim(),
      url: `https://github.com${i.href}`,
      summary: null,
      published_at: Date.now(),
    }));
}

async function fetchReddit(subreddit) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/hot.json?limit=10`;
  const res = await fetch(url, { headers: { "user-agent": "trendingtoday-bot/1.0 (by /u/trendingtoday)" } });
  if (!res.ok) return []; // Reddit sometimes rate-limits cloud IPs — see README caveats
  const data = await res.json();
  return (data.data?.children || []).map((c) => ({
    source_type: "reddit",
    source_key: subreddit,
    title: c.data.title,
    url: `https://www.reddit.com${c.data.permalink}`,
    summary: null,
    published_at: c.data.created_utc * 1000,
  }));
}

async function fetchRSS(feedUrl) {
  const res = await fetch(feedUrl, { headers: { "user-agent": "trendingtoday-bot/1.0" } });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of itemBlocks.slice(0, 15)) {
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || block.match(/<link[^>]*href="([^"]+)"/i);
    const link = linkMatch ? (linkMatch[1] || "").trim() : null;
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || block.match(/<published>([\s\S]*?)<\/published>/i) || [])[1];
    if (title && link) {
      items.push({
        source_type: "rss",
        source_key: feedUrl,
        title,
        url: link,
        summary: null,
        published_at: pubDate ? new Date(pubDate).getTime() : Date.now(),
      });
    }
  }
  return items;
}

async function runCron(env) {
  const prefs = await env.DB.prepare("SELECT DISTINCT source_type, keyword FROM user_preferences").all();
  const openTypes = ["youtube", "github_trending", "reddit", "rss"];
  for (const pref of prefs.results || []) {
    if (!openTypes.includes(pref.source_type)) continue;
    let items = [];
    try {
      if (pref.source_type === "youtube") items = await fetchYouTube(pref.keyword, env.YOUTUBE_API_KEY);
      else if (pref.source_type === "github_trending") items = await fetchGithubTrending(pref.keyword);
      else if (pref.source_type === "reddit") items = await fetchReddit(pref.keyword);
      else if (pref.source_type === "rss") items = await fetchRSS(pref.keyword);
    } catch (err) {
      console.error(`fetch failed for ${pref.source_type}:${pref.keyword}`, err);
      continue;
    }
    await upsertItems(env, items);
  }
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/auth/signup" && method === "POST") return await handleSignup(request, env);
      if (path === "/api/auth/login" && method === "POST") return await handleLogin(request, env);
      if (path === "/api/auth/logout" && method === "POST") return await handleLogout(request, env);
      if (path === "/api/ingest" && method === "POST") return await handleIngest(request, env);
      if (path === "/api/debug/run-fetch" && method === "POST") return await handleDebugRunFetch(request, env);

      // everything below requires a session
      const user = await getUserFromRequest(request, env);
      if (path === "/api/me" && method === "GET") return user ? json(user) : bad("Not authenticated", 401);
      if (!user) return bad("Not authenticated", 401);

      if (path === "/api/preferences" && method === "GET") return await handleGetPreferences(request, env, user);
      if (path === "/api/preferences" && method === "POST") return await handleAddPreference(request, env, user);
      if (path === "/api/preferences" && method === "DELETE") return await handleDeletePreference(request, env, user);
      if (path === "/api/feed" && method === "GET") return await handleFeed(request, env, user);

      return bad("Not found", 404);
    } catch (err) {
      console.error(err);
      return bad("Internal error", 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};
