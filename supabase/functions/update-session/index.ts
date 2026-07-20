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

Deno.serve(async (req: Request) => {
  const cors = requestHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: cors.allowed ? 204 : 403, headers: cors.headers });
  }

  if (!cors.allowed) return json(req, { error: "ORIGEN_NO_PERMITIDO" }, 403);
  if (req.method !== "POST") return json(req, { error: "METODO_NO_PERMITIDO" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "JSON_INVALIDO" }, 400);
  }

  if (String(body.action || "") !== "force_logout_all") {
    return json(req, { error: "ACCION_NO_PERMITIDA" }, 400);
  }

  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!accessToken || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(req, { error: "NO_AUTORIZADO" }, 401);
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);
  const user = userData.user;

  if (userError || !user || user.app_metadata?.role !== "admin") {
    return json(req, { error: "NO_AUTORIZADO" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { error: deleteError } = await admin
    .from("admin_sessions")
    .delete()
    .eq("user_id", user.id);

  if (deleteError) {
    console.error("No se pudo cerrar la sesión", deleteError.message);
    return json(req, { error: "ERROR_DE_SESION" }, 500);
  }

  return json(req, { success: true });
});
