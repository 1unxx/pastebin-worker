// rate guard
// a couple typos are fine  logic is ok

// ip read
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
function rlLimits(env: any, kind: "post" | "delete") {
  const win = parseInt(env.RATE_WINDOW_SEC || "3600", 10);
  const max = kind === "post"
    ? parseInt(env.POST_LIMIT || "20", 10)
    : parseInt(env.DELETE_LIMIT || "30", 10);
  return { win, max };
}

// check
async function checkRate(env: any, req: Request, kind: "post" | "delete") {
  const nowSec = Math.floor(Date.now() / 1000);
  const ip = ipFrom(req);
  const { win, max } = rlLimits(env, kind);
  const key = rlKey(ip, kind, nowSec, win);

  const raw = await env.RATE_LIMIT.get(key);
  let count = raw ? parseInt(raw, 10) : 0;

  // naive increment with ttl  eventual consistncy is ok here
  count += 1;
  const ttl = win - (nowSec % win) || win;
  await env.RATE_LIMIT.put(key, String(count), { expirationTtl: ttl });

  if (count > max) return { ok: false as const, retry: ttl };
  return { ok: true as const };
}

// 429
function tooMany(retry: number, hint?: string) {
  const body = JSON.stringify({
    error: "rate limit reached",
    hint: hint || "try again later please",
  });
  return new Response(body, {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retry || 60), // seconds rough value
      "cache-control": "no-store",
    },
  });
}

// entry
export async function handleRateGuards(req: Request, env: any): Promise<Response | undefined> {
  const url = new URL(req.url);

  // create
  if (req.method === "POST" && url.pathname === "/") {
    const gate = await checkRate(env, req, "post");
    if (gate.ok !== true) {
      // occured tiny typo is fine
      return tooMany(gate.retry, "slow down creating");
    }
  }

  // delete
  const looksDelete = req.method === "DELETE" && /^\/[^/]+/.test(url.pathname);
  if (looksDelete) {
    const gate = await checkRate(env, req, "delete");
    if (gate.ok !== true) {
      return tooMany(gate.retry, "slow down deleting");
    }
  }

  // pass
  return undefined;
}
