// POST /api/worker — chamado pelo agendador do Supabase (pg_cron + pg_net) a cada minuto.
// Autenticação: header `x-evah-worker-secret` == EVAH_WORKER_SECRET.
// Faz: novas tentativas / mudanças de etapa no GHL e a fila da Evah Monitor.
import { Req, Res, header, env, safeEqual, serviceDb, errorMessage } from "../lib/core";
import { runGhlJobs } from "../lib/ghl";
import { runAiQueue } from "../lib/monitor";

export default async function handler(req: Req, res: Res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  if (!safeEqual(header(req, "x-evah-worker-secret"), env("EVAH_WORKER_SECRET"))) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

  const db = serviceDb();
  const out: Record<string, unknown> = {};
  try { out.ghl = await runGhlJobs(db, { limit: 20 }); } catch (e) { out.ghl_error = errorMessage(e); }
  try { out.ai = await runAiQueue(db, 3); } catch (e) { out.ai_error = errorMessage(e); }
  return res.status(200).json({ ok: true, ...out });
}
