import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://bingoganga.com",
  "https://www.bingoganga.com",
  "https://bingoganga.github.io",
  "http://127.0.0.1:8765",
  "http://localhost:8765"
]);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SESSION_MS = 30 * 60 * 1000;

function requestHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = origin === "" || ALLOWED_ORIGINS.has(origin);
  return {
    allowed,
    headers: {
      "Access-Control-Allow-Origin": allowed && origin ? origin : "https://www.bingoganga.com",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Vary": "Origin"
    }
  };
}

function json(req: Request, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: requestHeaders(req).headers
  });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  const cors = requestHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: cors.allowed ? 204 : 403, headers: cors.headers });
  }

  if (!cors.allowed) return json(req, { valid: false, sameDevice: false }, 403);
  if (req.method !== "POST") return json(req, { valid: false, sameDevice: false }, 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(req, { valid: false, sameDevice: false }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, { valid: false, sameDevice: false }, 400);
  }

  const sessionToken = String(body.sessionToken || "");
  const deviceId = String(body.deviceId || "").trim();

  if (!sessionToken || deviceId.length < 8 || deviceId.length > 200) {
    return json(req, { valid: false, sameDevice: false }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const tokenHash = await sha256(sessionToken);

  const { data: session, error } = await admin
    .from("admin_sessions")
    .select("user_id, email, device_id, expires_at")
    .eq("session_token_hash", tokenHash)
    .maybeSingle();

  if (error || !session) {
    return json(req, { valid: false, sameDevice: false });
  }

  const sameDevice = session.device_id === deviceId;
  const notExpired = new Date(session.expires_at).getTime() > Date.now();

  if (!sameDevice || !notExpired) {
    if (!notExpired) {
      await admin.from("admin_sessions").delete().eq("user_id", session.user_id);
    }
    return json(req, { valid: false, sameDevice });
  }

  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  await admin
    .from("admin_sessions")
    .update({ expires_at: expiresAt, last_seen_at: new Date().toISOString() })
    .eq("user_id", session.user_id)
    .eq("device_id", deviceId);

  return json(req, {
    valid: true,
    sameDevice: true,
    email: session.email,
    expiresAt
  });
});
