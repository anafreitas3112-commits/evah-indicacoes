// Integração GoHighLevel (API LeadConnector, Version 2021-07-28 — mesmo padrão das funções ghl-* em produção).
// Regras: NUNCA duplicar contato (sempre busca antes de criar, com e sem o 9º dígito) e
// NUNCA recriar oportunidade (reaproveita a do pipeline Indicação se já existir).
import { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage } from "./core";

const BASE = "https://services.leadconnectorhq.com";

type GhlJob = {
  job_id: string;
  action: "CREATE_CONTACT_AND_OPPORTUNITY" | "UPDATE_OPPORTUNITY_STAGE";
  created_at: string;
  lead: { id: string; full_name: string; phone: string; status: string; ghl_contact_id: string | null; ghl_opportunity_id: string | null };
  referrer_name: string | null;
  ghl: { location_id: string; pipeline_id: string; stage_id_for_status: string | null; new_lead_stage_id: string } | null;
  token: string | null;
};

async function call(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let data: any = {};
  try { data = await r.json(); } catch { /* corpo vazio */ }
  return { status: r.status, data };
}

function fail(what: string, r: { status: number; data: any }): never {
  throw new Error(`GHL ${what} falhou (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
}

async function findContact(token: string, locationId: string, phone55: string): Promise<string | null> {
  const candidates = ["+" + phone55];
  if (phone55.length === 13 && phone55[4] === "9") candidates.push("+" + phone55.slice(0, 4) + phone55.slice(5)); // sem o 9
  for (const number of candidates) {
    const r = await call(token, "GET", `/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(number)}`);
    if (r.status !== 200) fail("busca de contato", r);
    const id = r.data?.contact?.id ?? r.data?.contacts?.[0]?.id ?? null;
    if (id) return id;
  }
  return null;
}

async function createContact(token: string, locationId: string, fullName: string, phone55: string) {
  const [firstName, ...rest] = fullName.split(" ");
  const r = await call(token, "POST", "/contacts/", {
    locationId, firstName, lastName: rest.join(" ") || undefined, name: fullName, phone: "+" + phone55, source: "Evah Indicações",
  });
  const created = r.data?.contact?.id ?? null;
  const existing = r.data?.meta?.contactId ?? null; // GHL recusou por duplicidade e informou o contato existente
  if (!created && !existing) fail("criação de contato", r);
  return { id: (created ?? existing) as string, created: !!created };
}

async function findOpportunity(token: string, locationId: string, pipelineId: string, contactId: string) {
  const r = await call(token, "GET", `/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&contact_id=${contactId}`);
  if (r.status !== 200) fail("busca de oportunidade", r);
  const o = (r.data?.opportunities ?? []).find((x: any) => x.contactId === contactId && x.pipelineId === pipelineId);
  return (o?.id as string) ?? null;
}

async function createOpportunity(token: string, g: NonNullable<GhlJob["ghl"]>, stageId: string, contactId: string, name: string) {
  const r = await call(token, "POST", "/opportunities/", {
    pipelineId: g.pipeline_id, locationId: g.location_id, pipelineStageId: stageId, status: "open", contactId, name,
  });
  const id = r.data?.opportunity?.id;
  if (!id) fail("criação de oportunidade", r);
  return id as string;
}

async function updateStage(token: string, opportunityId: string, pipelineId: string, stageId: string) {
  const r = await call(token, "PUT", `/opportunities/${opportunityId}`, { pipelineId, pipelineStageId: stageId });
  if (r.status < 200 || r.status > 299) fail("atualização de etapa", r);
}

async function processJob(job: GhlJob, memo: Map<string, { contact_id: string; opportunity_id: string }>) {
  if (!job.ghl?.location_id || !job.ghl.pipeline_id || !job.ghl.new_lead_stage_id) throw new Error("GHL não configurado para esta clínica (ghl_settings)");
  if (!job.token) throw new Error(`Token GHL não encontrado para a location ${job.ghl.location_id}`);
  const g = job.ghl, t = job.token, lead = job.lead;
  const known = memo.get(lead.id);

  if (job.action === "CREATE_CONTACT_AND_OPPORTUNITY") {
    let contactId = lead.ghl_contact_id ?? known?.contact_id ?? null;
    let contactCreated = false;
    if (!contactId) contactId = await findContact(t, g.location_id, lead.phone);
    if (!contactId) {
      const c = await createContact(t, g.location_id, lead.full_name, lead.phone);
      contactId = c.id; contactCreated = c.created;
    }
    let opportunityId = lead.ghl_opportunity_id ?? known?.opportunity_id ?? null;
    let opportunityCreated = false;
    if (!opportunityId) opportunityId = await findOpportunity(t, g.location_id, g.pipeline_id, contactId);
    const stageId = g.stage_id_for_status ?? g.new_lead_stage_id;
    if (!opportunityId) {
      const name = lead.full_name + (job.referrer_name ? ` (indicação de ${job.referrer_name})` : "");
      opportunityId = await createOpportunity(t, g, stageId, contactId, name);
      opportunityCreated = true;
    }
    memo.set(lead.id, { contact_id: contactId, opportunity_id: opportunityId });
    return { lead_id: lead.id, contact_id: contactId, contact_created: contactCreated, opportunity_id: opportunityId,
             opportunity_created: opportunityCreated, pipeline_id: g.pipeline_id, stage_id: stageId };
  }

  // UPDATE_OPPORTUNITY_STAGE: aplica a etapa do status ATUAL (nunca "volta" por tentativa antiga)
  const opportunityId = lead.ghl_opportunity_id ?? known?.opportunity_id;
  if (!opportunityId) throw new Error("Oportunidade ainda não criada no GHL (aguardando envio inicial)");
  if (!g.stage_id_for_status) throw new Error(`Etapa do GHL não configurada para o status ${lead.status}`);
  await updateStage(t, opportunityId, g.pipeline_id, g.stage_id_for_status);
  return { lead_id: lead.id, opportunity_id: opportunityId, status: lead.status, stage_id: g.stage_id_for_status };
}

// Pega jobs no banco (com trava), executa em ordem e devolve cada resultado ao banco.
export async function runGhlJobs(db: SupabaseClient, opts: { limit?: number; leadIds?: string[] } = {}) {
  const { data, error } = await db.rpc("evah_claim_ghl_jobs", { p_limit: opts.limit ?? 20, p_lead_ids: opts.leadIds ?? null });
  if (error) throw new Error(`claim GHL: ${error.message}`);
  const jobs = ((data ?? []) as GhlJob[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const memo = new Map<string, { contact_id: string; opportunity_id: string }>();
  const results: any[] = [];
  for (const job of jobs) {
    try {
      const result = await processJob(job, memo);
      await db.rpc("evah_complete_ghl_job", { p_job_id: job.job_id, p_ok: true, p_result: result, p_error: null });
      results.push({ job_id: job.job_id, ok: true, ...result });
    } catch (e) {
      const msg = errorMessage(e);
      await db.rpc("evah_complete_ghl_job", { p_job_id: job.job_id, p_ok: false, p_result: {}, p_error: msg });
      results.push({ job_id: job.job_id, lead_id: job.lead.id, ok: false, error: msg });
    }
  }
  return results;
}
