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
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
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
  const cors = requestHeaders(req);
  return new Response(JSON.stringify(body), { status, headers: cors.headers });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

  if (!cors.allowed) return json(req, { error: "ORIGEN_NO_PERMITIDO" }, 403);
  if (req.method !== "POST") return json(req, { error: "METODO_NO_PERMITIDO" }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(req, { error: "CONFIGURACION_INCOMPLETA" }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "JSON_INVALIDO" }, 400);
  }

  const action = String(body.action || "");
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  if (action === "logout") {
    const email = String(body.email || "").trim().toLowerCase();
    const deviceId = String(body.deviceId || "").trim();
    const sessionToken = String(body.sessionToken || "");

    if (email && deviceId && sessionToken) {
      const tokenHash = await sha256(sessionToken);
      await admin
        .from("admin_sessions")
        .delete()
        .eq("email", email)
        .eq("device_id", deviceId)
        .eq("session_token_hash", tokenHash);
    }

    return json(req, { success: true });
  }

  if (action !== "verify_credentials") {
    return json(req, { error: "ACCION_NO_PERMITIDA" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const deviceId = String(body.deviceId || "").trim();

  if (!email || email.length > 254 || !password || password.length > 256) {
    return json(req, { error: "Correo o contraseña incorrectos" }, 401);
  }

  if (deviceId.length < 8 || deviceId.length > 200) {
    return json(req, { error: "DISPOSITIVO_INVALIDO" }, 400);
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
    email,
    password
  });

  if (authError || !authData.user || !authData.session) {
    return json(req, { error: "Correo o contraseña incorrectos" }, 401);
  }

  if (authData.user.app_metadata?.role !== "admin") {
    return json(req, { error: "ACCESO_NO_AUTORIZADO" }, 403);
  }

  const { data: existing, error: existingError } = await admin
    .from("admin_sessions")
    .select("device_id, expires_at")
    .eq("user_id", authData.user.id)
    .maybeSingle();

  if (existingError) {
    console.error("No se pudo revisar la sesión administrativa", existingError.message);
    return json(req, { error: "ERROR_DE_SESION" }, 500);
  }

  const existingIsActive =
    existing &&
    new Date(existing.expires_at).getTime() > Date.now();

  if (existingIsActive && existing.device_id !== deviceId) {
    return json(req, { error: "SESION_ACTIVA_OTRO_DISPOSITIVO" }, 409);
  }

  const sessionToken = randomToken();
  const sessionTokenHash = await sha256(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();

  const { error: saveError } = await admin
    .from("admin_sessions")
    .upsert({
      user_id: authData.user.id,
      email,
      device_id: deviceId,
      session_token_hash: sessionTokenHash,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString()
    }, { onConflict: "user_id" });

  if (saveError) {
    console.error("No se pudo crear la sesión administrativa", saveError.message);
    return json(req, { error: "ERROR_DE_SESION" }, 500);
  }

  return json(req, {
    success: true,
    sessionToken,
    email,
    deviceId,
    expiresAt,
    accessToken: authData.session.access_token,
    refreshToken: authData.session.refresh_token
  });
});
