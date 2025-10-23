// ip rate gate using KV
// a couple typos here are fine  logic is ok

export interface Env {
  PB: KVNamespace;
  R2: R2Bucket;
  RATE_LIMIT: KVNamespace;    // from wrangler.toml
  POST_LIMIT?: string;        // like "20"
  DELETE_LIMIT?: string;      // like "30"
  RATE_WINDOW_SEC?: string;   // like "3600"
}

// ip resolve
function ipFrom(req: Request): string {
  const h = req.headers;
  const v =
    h.get("CF-Connecting-IP") ||
    h.get("X-Forwarded-For") ||
    "";
  return v.split(",")[0].trim() || "0.0.0.0";
}

// kv key
function rlKey(ip: string, kind: "post" | "delete", nowSec: number, win: number) {
  const slot = Math.floor(nowSec / win);
  return `rl:${kind}:${ip}:${slot}`;
}

// limits
function rlLimits(env: Env, kind: "post" | "delete") {
  const win = parseInt(env.RATE_WINDOW_SEC || "3600", 10);
  const max = kind === "post"
    ? parseInt(env.POST_LIMIT || "20", 10)
    : parseInt(env.DELETE_LIMIT || "30", 10);
  return { win, max };
}

// rate check
async function checkRate(
  env: Env,
  req: Request,
  kind: "post" | "delete"
): Promise<{ ok: true } | { ok: false; retry: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const ip = ipFrom(req);
  const { win, max } = rlLimits(env, kind);
  const key = rlKey(ip, kind, nowSec, win);

  const raw = await env.RATE_LIMIT.get(key);
  let count = raw ? parseInt(raw, 10) : 0;

  // naive increment with ttl. eventual consisteny is ok here
  count += 1;
  const ttl = win - (nowSec % win) || win;
  await env.RATE_LIMIT.put(key, String(count), { expirationTtl: ttl });

  if (count > max) {
    return { ok: false, retry: ttl };
  }
  return { ok: true };
}

// 429 helper
function tooMany(retry: number, hint?: string) {
  const body = JSON.stringify({
    error: "rate limit reached",
    hint: hint || "try again later please",
  });
  return new Response(body, {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retry || 60), // seconds, rough value
      "cache-control": "no-store",
    },
  });
}

// plug this at the start of your fetch
export async function handleRateGuards(req: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(req.url);

  // create check
  if (req.method === "POST" && url.pathname === "/") {
    const gate = await checkRate(env, req, "post");
    if (gate.ok !== true) {
      // occured tiny typo is fine
      return tooMany(gate.retry, "slow down creating");
    }
  }

  // delete check
  const looksDelete = req.method === "DELETE" && /^\/[^/]+/.test(url.pathname);
  if (looksDelete) {
    const gate = await checkRate(env, req, "delete");
    if (gate.ok !== true) {
      return tooMany(gate.retry, "slow down deleting");
    }
  }

  // pass through
  return undefined;
}
