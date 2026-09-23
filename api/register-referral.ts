// POST /api/register-referral  — usado pela tela.
// 1) Cadastra com o LOGIN do usuário (clínica vem do profile; RLS respeitado).
// 2) Envia as indicações criadas ao GoHighLevel na hora. Se o GHL falhar, o cadastro NÃO se perde:
//    o job fica na fila e o agendador tenta de novo a cada minuto.
import { Req, Res, header, userDb, serviceDb, errorMessage } from "../lib/core";
import { runGhlJobs } from "../lib/ghl";

export default async function handler(req: Req, res: Res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  const auth = header(req, "authorization");
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });

  try {
    const db = userDb(auth);
    const { data: u, error: ue } = await db.auth.getUser(auth.slice(7));
    if (ue || !u?.user) return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });

    const b = req.body ?? {};
    if (!b.referrer || typeof b.referrer !== "object") return res.status(422).json({ ok: false, error: "VALIDATION", field: "referrer", message: "Informe o cliente indicador" });
    if (!Array.isArray(b.leads) || b.leads.length === 0) return res.status(422).json({ ok: false, error: "VALIDATION", field: "leads", message: "Informe ao menos uma indicação" });

    const payload = {
      referrer: { full_name: String(b.referrer.full_name ?? ""), cpf: b.referrer.cpf ? String(b.referrer.cpf) : null, phone: String(b.referrer.phone ?? "") },
      leads: b.leads.map((l: any) => ({ full_name: String(l?.full_name ?? ""), phone: String(l?.phone ?? "") })),
    };
    const { data, error } = await db.rpc("register_referral", { p_payload: payload });
    if (error) return res.status(500).json({ ok: false, error: "DATABASE_ERROR", message: error.message });
    if (!data?.ok) return res.status(422).json(data);

    const created: string[] = (data.leads ?? []).filter((l: any) => l.status === "CREATED").map((l: any) => l.lead_id);
    if (created.length) {
      try {
        const results = await runGhlJobs(serviceDb(), { leadIds: created, limit: 50 });
        data.ghl = { enviados: results.filter((r) => r.ok).length, falhas: results.filter((r) => !r.ok).length };
      } catch (e) {
        console.error("GHL imediato falhou (fica na fila):", errorMessage(e));
        data.ghl = { enviados: 0, falhas: created.length, pendente: true };
      }
    }
    return res.status(200).json(data);
  } catch (e) {
    console.error("register-referral:", errorMessage(e));
    return res.status(500).json({ ok: false, error: "INTERNAL", message: errorMessage(e) });
  }
}
