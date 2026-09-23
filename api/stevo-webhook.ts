// POST /api/stevo-webhook?org=<slug-da-clinica>
// Autenticação: segredo por clínica no header `x-evah-webhook-secret` (ou ?token= se a Stevo não aceitar header).
// Fluxo: valida -> guarda o payload bruto (webhook_inbox, anti-duplicação por hash) -> adapter Stevo ->
//        ingest_whatsapp_message (vincula ao lead, eventos, NEW_LEAD -> IN_SERVICE, fila da IA).
import { createHash } from "crypto";
import { Req, Res, header, queryParam, serviceDb, errorMessage } from "../lib/core";
import { mapStevoPayload, sanitizeStevoPayload } from "../lib/stevo-adapter";

export default async function handler(req: Req, res: Res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  const slug = queryParam(req, "org");
  const secret = header(req, "x-evah-webhook-secret") || queryParam(req, "token");
  if (!slug || !secret) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

  const db = serviceDb();
  try {
    const { data: orgId, error: authErr } = await db.rpc("evah_resolve_webhook", { p_org_slug: slug, p_provider: "STEVO", p_secret: secret });
    if (authErr) throw new Error(authErr.message);
    if (!orgId) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

    const raw = sanitizeStevoPayload(req.body);   // nunca guardar a chave da instância
    if (!raw || typeof raw !== "object") return res.status(400).json({ ok: false, error: "INVALID_JSON" });
    const payloadHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");

    const { data: rows, error: inboxErr } = await db.from("webhook_inbox")
      .upsert({ organization_id: orgId, provider: "STEVO", payload_hash: payloadHash, raw_payload: raw },
              { onConflict: "organization_id,provider,payload_hash", ignoreDuplicates: true })
      .select("id");
    if (inboxErr) throw new Error(inboxErr.message);
    if (!rows || rows.length === 0) return res.status(200).json({ ok: true, duplicate: true });
    const inboxId = rows[0].id;

    const mapped = mapStevoPayload(raw);
    if (mapped.kind !== "message") {
      await db.from("webhook_inbox").update({
        status: mapped.kind === "ignored" ? "IGNORED" : "MAPPING_PENDING", error: mapped.reason, processed_at: new Date().toISOString(),
        ...(mapped.kind === "ignored" ? { raw_payload: {} } : {}),
      }).eq("id", inboxId);
      return res.status(202).json({ ok: true, stored: true, status: mapped.kind, reason: mapped.reason });
    }

    const { data: result, error: ingErr } = await db.rpc("ingest_whatsapp_message", {
      p_organization_id: orgId, p_message: mapped.message,
    });
    if (ingErr || !result?.ok) {
      const msg = ingErr?.message ?? result?.error ?? "UNKNOWN";
      await db.from("webhook_inbox").update({ status: "ERROR", error: msg, processed_at: new Date().toISOString() }).eq("id", inboxId);
      await db.from("system_logs").insert({ organization_id: orgId, level: "ERROR", source: "stevo-webhook", message: msg, context: { inbox_id: inboxId } });
      return res.status(ingErr ? 500 : 422).json({ ok: false, error: msg });
    }
    // Privacidade: depois de processado, o payload bruto é descartado (a mensagem já está em whatsapp_messages).
    // Conversas que não são de indicação: nada é guardado.
    await db.from("webhook_inbox").update({
      status: result.ignored ? "IGNORED" : result.duplicate ? "DUPLICATE" : "PROCESSED",
      error: result.ignored ?? null, message_id: result.message_id ?? null,
      raw_payload: {}, processed_at: new Date().toISOString(),
    }).eq("id", inboxId);
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error("stevo-webhook:", errorMessage(e));
    return res.status(500).json({ ok: false, error: "INTERNAL" });   // Stevo pode reenviar; anti-duplicação protege
  }
}
