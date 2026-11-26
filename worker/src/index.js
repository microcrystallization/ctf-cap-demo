import { createHash } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
import { generateChallenge, validateChallenge } from "capjs-core";

const SCOPE = "ctf-flag";

/**
 * Atomic single-use store for Cap nonces and redeemed tokens.
 * Uses Durable Object SQLite so concurrent replay attempts cannot both pass.
 */
export class CapStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nonces (
        sig TEXT PRIMARY KEY,
        expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_key TEXT PRIMARY KEY,
        expires INTEGER NOT NULL
      );
    `);
  }

  cleanup(now) {
    this.sql.exec("DELETE FROM nonces WHERE expires <= ?", now);
    this.sql.exec("DELETE FROM tokens WHERE expires <= ?", now);
  }

  consumeNonce(sig, ttlMs) {
    const now = Date.now();
    this.cleanup(now);
    const expires = now + Number(ttlMs || 600_000);
    const rows = this.sql
      .exec(
        "INSERT OR IGNORE INTO nonces (sig, expires) VALUES (?, ?) RETURNING sig",
        sig,
        expires,
      )
      .toArray();
    return rows.length === 1;
  }

  storeToken(tokenKey, expires) {
    const now = Date.now();
    this.cleanup(now);
    this.sql.exec(
      "INSERT OR REPLACE INTO tokens (token_key, expires) VALUES (?, ?)",
      tokenKey,
      Number(expires),
    );
  }

  consumeToken(tokenKey) {
    const now = Date.now();
    this.cleanup(now);
    const rows = this.sql
      .exec(
        "DELETE FROM tokens WHERE token_key = ? AND expires > ? RETURNING token_key",
        tokenKey,
        now,
      )
      .toArray();
    return rows.length === 1;
  }
}

function deriveTokenKey(token) {
  if (typeof token !== "string") return null;
  const idx = token.indexOf(":");
  if (idx <= 0 || idx === token.length - 1) return null;
  const id = token.slice(0, idx);
  const secret = token.slice(idx + 1);
  return `${id}:${createHash("sha256").update(secret).digest("hex")}`;
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isLocalhost =
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const allowOrigin =
    isLocalhost || allowed.includes(origin) || allowed.includes("*")
      ? origin || "*"
      : allowed[0] || "";

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }
  return headers;
}

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function getStore(env) {
  const id = env.CAP_STORE.idFromName("global");
  return env.CAP_STORE.get(id);
}

export default {
  async fetch(request, env) {
    const cors = getCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/api/health") {
      return json({ ok: true, service: "ctf-cap-demo" }, 200, cors);
    }

    const secret = env.CAP_SECRET;
    if (!secret || secret.length < 16) {
      return json(
        { success: false, error: "Server CAP_SECRET is not configured" },
        500,
        cors,
      );
    }

    // 1. Cap challenge endpoint: POST /cap/challenge
    if (request.method === "POST" && path === "/cap/challenge") {
      try {
        const challenge = await generateChallenge(secret, {
          scope: SCOPE,
          format: 2,
          protocols: ["hashwx", "instrumentation"],
        });
        return json(challenge, 200, cors);
      } catch (err) {
        return json(
          { success: false, error: "Failed to generate challenge" },
          500,
          cors,
        );
      }
    }

    // 2. Cap redeem endpoint: POST /cap/redeem
    if (request.method === "POST" && path === "/cap/redeem") {
      try {
        const body = await request.json();
        const store = getStore(env);

        const result = await validateChallenge(secret, body, {
          scope: SCOPE,
          request: {
            method: request.method,
            url: request.url,
            headers: request.headers,
          },
          consumeNonce: async (sigHex, ttlMs) =>
            await store.consumeNonce(sigHex, ttlMs),
        });

        if (!result.success) {
          return json(
            {
              success: false,
              reason: result.reason,
              error: result.reason,
              ...(result.instr_error ? { instr_error: true } : {}),
            },
            400,
            cors,
          );
        }

        await store.storeToken(result.tokenKey, result.expires);
        return json(
          {
            success: true,
            token: result.token,
            expires: result.expires,
          },
          200,
          cors,
        );
      } catch (err) {
        console.error("redeem error:", err);
        return json(
          { success: false, reason: "invalid_request", error: err?.message || "invalid_request" },
          400,
          cors,
        );
      }
    }

    // 3. Protected CTF Flag submission endpoint: POST /api/submit-flag
    if (request.method === "POST" && path === "/api/submit-flag") {
      try {
        const body = await request.json();
        const token = body?.["cap-token"];
        const flag = typeof body?.flag === "string" ? body.flag.trim() : "";

        // Verify Cap token BEFORE doing any flag check or side effects (fail closed)
        const tokenKey = deriveTokenKey(token);
        if (!tokenKey) {
          return json(
            { ok: false, error: "CAPTCHA verification failed" },
            400,
            cors,
          );
        }

        const store = getStore(env);
        const valid = await store.consumeToken(tokenKey);
        if (!valid) {
          return json(
            { ok: false, error: "CAPTCHA verification failed or token reused" },
            403,
            cors,
          );
        }

        if (!flag) {
          return json({ ok: false, error: "Flag cannot be empty" }, 400, cors);
        }

        const expectedFlag = env.CTF_FLAG || "flag{cap_pow_verified_2026}";
        const correct = flag === expectedFlag;

        return json(
          {
            ok: true,
            correct,
            message: correct
              ? "Flag accepted! Challenge solved."
              : "Incorrect flag. Try again.",
          },
          200,
          cors,
        );
      } catch (err) {
        return json({ ok: false, error: "Invalid request" }, 400, cors);
      }
    }

    return json({ error: "Not found" }, 404, cors);
  },
};
