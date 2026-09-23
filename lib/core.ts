// Utilidades comuns: variáveis de ambiente, clientes Supabase, resposta HTTP e comparação segura de segredos.
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "crypto";

export type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body?: any;
};
export type Res = {
  status: (code: number) => Res;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ausente na Vercel: ${name}`);
  return v;
}

export function header(req: Req, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

export function queryParam(req: Req, name: string): string {
  const v = req.query?.[name];
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

// Service role: SOMENTE no servidor (nunca vai para a tela).
export function serviceDb(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Cliente com o login do usuário: o banco aplica RLS e descobre a clínica pelo profile.
export function userDb(authorization: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a ?? "");
  const y = Buffer.from(b ?? "");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as any).message);
  return String(e);
}
