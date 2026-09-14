// trendingtoday.skylinn.in — API Worker (Phase 1, topic-based model)
// Routed at trendingtoday.skylinn.in/api/*  (same origin as the Pages frontend,
// so no CORS/cookie headaches). See ../README.md for deploy + routing steps.
//
// Model: a user adds a TOPIC (a single keyword). The cron fetches that
// keyword across every open category (YouTube, GitHub, News) automatically —
// no per-source setup. Phase 2 (Twitter/X, Reddit, Bilibili, XHS) pushes
// into the same feed_items table via /api/ingest, keyed by the same keyword.

const SESSION_DAYS = 30;
const OPEN_CATEGORIES = ["youtube", "github", "rss"];
const ITEMS_PER_CATEGORY = 10; // fetched+stored; frontend shows 5, can expand to this many

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

// ---------- topics ----------

async function handleGetTopics(request, env, user) {
  const rows = await env.DB.prepare("SELECT keyword, created_at FROM user_topics WHERE user_id = ? ORDER BY created_at DESC")
    .bind(user.id).all();
  return json(rows.results || []);
}

async function handleAddTopic(request, env, user) {
  const { keyword } = await request.json().catch(() => ({}));
  const clean = (keyword || "").trim();
  if (!clean) return bad("A keyword is required");
  await env.DB.prepare("INSERT OR IGNORE INTO user_topics (user_id, keyword, created_at) VALUES (?, ?, ?)")
    .bind(user.id, clean, Date.now()).run();
  await fetchAndStoreTopic(env, clean); // immediate first fetch — no waiting for the daily cron or a manual curl
  return json({ ok: true }, 201);
}

async function handleDeleteTopic(request, env, user) {
  const { keyword } = await request.json().catch(() => ({}));
  await env.DB.prepare("DELETE FROM user_topics WHERE user_id = ? AND keyword = ?").bind(user.id, keyword).run();
  return json({ ok: true });
}

// ---------- feed ----------
// Returns: [{ keyword, categories: { youtube: [...items], github: [...], rss: [...], twitter: [...] } }, ...]
// Each category array holds up to ITEMS_PER_CATEGORY items, newest first.

async function handleFeed(request, env, user) {
  const topicsRes = await env.DB.prepare("SELECT keyword FROM user_topics WHERE user_id = ? ORDER BY created_at DESC")
    .bind(user.id).all();
  const keywords = (topicsRes.results || []).map((t) => t.keyword);
  if (!keywords.length) return json([]);

  const placeholders = keywords.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT source_type, source_key, title, url, summary, published_at
     FROM feed_items WHERE source_key IN (${placeholders})
     ORDER BY published_at DESC LIMIT 2000`
  ).bind(...keywords).all();

  const byKeyword = {};
  for (const kw of keywords) byKeyword[kw] = {};
  for (const item of rows.results || []) {
    const bucket = byKeyword[item.source_key];
    if (!bucket) continue;
    bucket[item.source_type] = bucket[item.source_type] || [];
    if (bucket[item.source_type].length < ITEMS_PER_CATEGORY) bucket[item.source_type].push(item);
  }

  return json(keywords.map((kw) => ({ keyword: kw, categories: byKeyword[kw] })));
}

// ---------- Phase 2 ingest (Agent-Reach runner pushes here) ----------

async function handleIngest(request, env) {
  const key = request.headers.get("x-ingest-key");
  if (!env.INGEST_KEY || key !== env.INGEST_KEY) return bad("Unauthorized", 401);
  const items = await request.json().catch(() => null);
  if (!Array.isArray(items)) return bad("Body must be an array of items");
  await upsertItems(env, items);
  return json({ ingested: items.length });
}

async function handleDebugRunFetch(request, env) {
  const key = request.headers.get("x-ingest-key");
  if (!env.INGEST_KEY || key !== env.INGEST_KEY) return bad("Unauthorized", 401);
  await runCron(env);
  return json({ ok: true, ranAt: Date.now() });
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

// ---------- cron fetchers (open categories, all keyword-driven) ----------

async function fetchYouTube(keyword, apiKey) {
  if (!apiKey) return [];
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=${ITEMS_PER_CATEGORY}&q=${encodeURIComponent(keyword)}&key=${apiKey}`;
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

async function fetchGithubSearch(keyword) {
  // Unauthenticated GitHub search API: 10 requests/min — plenty for a
  // personal daily cron across a handful of topics.
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(keyword)}&sort=stars&order=desc&per_page=${ITEMS_PER_CATEGORY}`;
  const res = await fetch(url, { headers: { "user-agent": "trendingtoday-bot/1.0", accept: "application/vnd.github+json" } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map((r) => ({
    source_type: "github",
    source_key: keyword,
    title: `${r.full_name} — ★${r.stargazers_count}`,
    url: r.html_url,
    summary: r.description,
    published_at: new Date(r.pushed_at || r.updated_at).getTime(),
  }));
}

async function fetchRSS(keyword) {
  // Google News' public search RSS aggregates many outlets for a keyword,
  // which fits an aggregator better than a single fixed feed URL would.
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, { headers: { "user-agent": "trendingtoday-bot/1.0" } });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks.slice(0, ITEMS_PER_CATEGORY)) {
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]?.trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1];
    if (title && link) {
      items.push({
        source_type: "rss",
        source_key: keyword,
        title,
        url: link,
        summary: null,
        published_at: pubDate ? new Date(pubDate).getTime() : Date.now(),
      });
    }
  }
  return items;
}

async function fetchAndStoreTopic(env, keyword) {
  for (const category of OPEN_CATEGORIES) {
    let items = [];
    try {
      if (category === "youtube") items = await fetchYouTube(keyword, env.YOUTUBE_API_KEY);
      else if (category === "github") items = await fetchGithubSearch(keyword);
      else if (category === "rss") items = await fetchRSS(keyword);
    } catch (err) {
      console.error(`fetch failed for ${category}:${keyword}`, err);
      continue;
    }
    await upsertItems(env, items);
  }
}

async function runCron(env) {
  const topics = await env.DB.prepare("SELECT DISTINCT keyword FROM user_topics").all();
  for (const { keyword } of topics.results || []) {
    await fetchAndStoreTopic(env, keyword);
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

      if (path === "/api/topics" && method === "GET") return await handleGetTopics(request, env, user);
      if (path === "/api/topics" && method === "POST") return await handleAddTopic(request, env, user);
      if (path === "/api/topics" && method === "DELETE") return await handleDeleteTopic(request, env, user);
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
