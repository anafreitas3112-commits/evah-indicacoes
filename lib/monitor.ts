// Evah Monitor: a IA SÓ classifica a conversa e devolve JSON.
// Quem valida e decide é o banco (evah_record_ai_analysis -> apply_ai_analysis).
import { SupabaseClient } from "@supabase/supabase-js";
import { env, errorMessage } from "./core";

type AiItem = {
  lead_id: string; organization_id: string; model: string; status: string;
  appointment_date: string | null; appointment_time: string | null; today: string;
  transcript: string; message_count: number; last_message_id: string; idempotency_key: string;
};

export const SYSTEM_PROMPT = `Você é a Evah Monitor, auditora de conversas de WhatsApp entre uma clínica de estética/emagrecimento (CLÍNICA) e uma pessoa indicada por um cliente (LEAD). Sua única tarefa é classificar o que a conversa CONFIRMA. Você não conversa com ninguém.

Classifique em exatamente um evento:
- APPOINTMENT: existe um agendamento CONFIRMADO pelas duas partes, com data definida (e horário, se houver). Sugestões de horário, perguntas, "vou ver", "talvez", "te aviso" NÃO são confirmação.
- CANCELLATION: um agendamento já confirmado foi cancelado (o lead desistiu/não vai, ou a clínica confirmou o cancelamento).
- RESCHEDULE: um agendamento já existente foi remarcado para uma NOVA data/horário confirmada pelas duas partes.
- NONE: nenhum dos casos acima, ou não há certeza.

Regras:
1. Use o STATUS ATUAL e o AGENDAMENTO ATUAL informados. Se o status for SCHEDULED e a conversa só reconfirma o mesmo dia/horário, responda NONE. Se o status for IN_SERVICE, CANCELLATION e RESCHEDULE normalmente não se aplicam (não havia agendamento): prefira APPOINTMENT ou NONE.
2. Vale o que aconteceu por ÚLTIMO na conversa.
3. Resolva datas relativas ("amanhã", "quinta", "dia 12") a partir da DATA DE HOJE informada, no fuso de São Paulo. Datas no formato YYYY-MM-DD e horário HH:MM (24h). Use null quando não houver data/horário confirmado.
4. Mensagens <AUDIO>, <IMAGE> etc. sem texto: não invente o conteúdo delas.
5. confidence entre 0 e 1, honesta: abaixo de 0.7 se houver qualquer ambiguidade.
6. evidence: citação curta (até 200 caracteres) das mensagens que justificam a decisão.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["detected_event", "confidence", "appointment_date", "appointment_time", "evidence"],
  properties: {
    detected_event: { type: "string", enum: ["NONE", "APPOINTMENT", "CANCELLATION", "RESCHEDULE"] },
    confidence: { type: "number", description: "0 a 1" },
    appointment_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
    appointment_time: { type: ["string", "null"], description: "HH:MM 24h" },
    evidence: { type: "string", description: "trecho curto que justifica" },
  },
};

export function buildUserPrompt(i: Pick<AiItem, "today" | "status" | "appointment_date" | "appointment_time" | "transcript">) {
  const appt = i.appointment_date ? `${i.appointment_date}${i.appointment_time ? " " + i.appointment_time : ""}` : "nenhum";
  return `DATA DE HOJE: ${i.today}\nSTATUS ATUAL: ${i.status}\nAGENDAMENTO ATUAL: ${appt}\n\nCONVERSA (ordem cronológica):\n${i.transcript}`;
}

// Chat Completions + Structured Outputs (json_schema estrito)
export async function classify(model: string, userPrompt: string) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_schema", json_schema: { name: "evah_monitor", strict: true, schema: SCHEMA } },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const body: any = await r.json().catch(() => null);
  if (!r.ok || !body) throw new Error(`OpenAI HTTP ${r.status}: ${body?.error?.message ?? "sem corpo"}`);
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`OpenAI recusou: ${String(choice.message.refusal).slice(0, 200)}`);
  if (choice?.finish_reason !== "stop") throw new Error(`OpenAI resposta incompleta (finish_reason=${choice?.finish_reason})`);
  const output = JSON.parse(choice.message.content);
  return { output: { ...output, _usage: body.usage }, model: body.model ?? model };
}

async function processItem(db: SupabaseClient, item: AiItem) {
  try {
    const { output, model } = await classify(item.model, buildUserPrompt(item));
    const { data, error } = await db.rpc("evah_record_ai_analysis", {
      p_lead_id: item.lead_id, p_idempotency_key: item.idempotency_key, p_last_message_id: item.last_message_id,
      p_message_count: item.message_count, p_model: model, p_output: output,
    });
    if (error) throw new Error(error.message);   // inclui recusa da validação do banco
    return { lead_id: item.lead_id, ok: true, result: data };
  } catch (e) {
    const msg = errorMessage(e);
    await db.rpc("evah_fail_ai_item", { p_lead_id: item.lead_id, p_error: msg });
    return { lead_id: item.lead_id, ok: false, error: msg };
  }
}

export async function runAiQueue(db: SupabaseClient, limit = 3) {
  if (!process.env.OPENAI_API_KEY) return [{ skipped: "OPENAI_API_KEY não configurada na Vercel" }];
  const { data, error } = await db.rpc("evah_claim_ai_queue", { p_limit: limit });
  if (error) throw new Error(`claim IA: ${error.message}`);
  const items = (data ?? []) as AiItem[];
  return Promise.all(items.map((i) => processItem(db, i)));   // em paralelo: cabe no tempo da função
}
