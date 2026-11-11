// 워드봉사 검수기용 바른(Bareun) 맞춤법 프록시 — Cloudflare Worker
// 바른 API 키는 코드에 쓰지 않고 Worker의 비밀값(BAREUN_KEY)에 넣는다.
//
// 필요한 설정 (Cloudflare 대시보드 → Workers → 이 Worker → Settings → Variables and Secrets)
//   BAREUN_KEY       (Secret) koba-로 시작하는 바른 API 키
//   ALLOWED_ORIGINS  (Text)   요청을 받아 줄 페이지 주소. 쉼표로 여러 개. 예: https://hy.github.io
// 선택 설정
//   MAX_CHARS        (Text)   한 번에 받을 최대 글자 수. 기본 6000
//   PER_MINUTE       (Text)   한 사람(IP)이 1분에 보낼 수 있는 요청 수. 기본 20
//   DAILY_WORDS      (Text)   하루에 쓸 수 있는 전체 어절 수. USAGE(KV)를 연결했을 때만 적용
//   USAGE            (KV namespace binding) 하루 사용량을 세는 저장소

const BAREUN_URL = "https://api.bareun.ai/bareun.RevisionService/CorrectError";
const hits = new Map(); // IP별 최근 요청 시각(같은 Worker 인스턴스 안에서만 셈)

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

function corsHeaders(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok ? origin : (allowed[0] || "null"),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  };
}

function tooMany(ip, perMinute) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > perMinute;
}

export default {
  async fetch(request, env) {
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
    const origin = (request.headers.get("Origin") || "").replace(/\/$/, "");
    const { ok, headers } = corsHeaders(origin, allowed);

    if (request.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers });
    if (!ok) return json({ error: "origin_not_allowed" }, 403, headers);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);
    if (!env.BAREUN_KEY) return json({ error: "server_key_missing" }, 500, headers);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "bad_json" }, 400, headers); }
    const text = String(body && body.text != null ? body.text : "");
    const maxChars = Number(env.MAX_CHARS || 6000);
    if (!text.trim()) return json({ error: "empty" }, 400, headers);
    if (text.length > maxChars) return json({ error: "too_long", max: maxChars }, 413, headers);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (tooMany(ip, Number(env.PER_MINUTE || 20))) return json({ error: "rate_limited" }, 429, headers);

    // 하루 전체 사용량 제한 (KV를 연결했을 때만)
    const words = text.split(/\s+/).filter(Boolean).length;
    let usageKey = null, used = 0;
    if (env.USAGE && env.DAILY_WORDS) {
      usageKey = "words:" + new Date().toISOString().slice(0, 10);
      used = Number(await env.USAGE.get(usageKey)) || 0;
      if (used + words > Number(env.DAILY_WORDS)) return json({ error: "daily_quota", used }, 429, headers);
    }

    const upstream = await fetch(BAREUN_URL, {
      method: "POST",
      headers: { "api-key": env.BAREUN_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ document: { content: text, language: "ko-KR" }, encoding_type: "UTF16" }),
    });
    const out = await upstream.text();

    if (upstream.ok && usageKey) {
      try { await env.USAGE.put(usageKey, String(used + words), { expirationTtl: 60 * 60 * 48 }); } catch (e) {}
    }
    return new Response(out, { status: upstream.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
  },
};
