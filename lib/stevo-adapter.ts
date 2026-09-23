// ============================================================================
// ADAPTER STEVO — PENDENTE DE DOCUMENTAÇÃO EXTERNA
// ----------------------------------------------------------------------------
// ÚNICO lugar onde o formato do webhook da Stevo é interpretado. Nenhum campo foi inventado:
// enquanto o payload real não for mapeado, tudo fica guardado em webhook_inbox como
// MAPPING_PENDING (nada se perde; dá para reprocessar depois).
//
// Para implementar, com um payload real em mãos, preencha mapStevoPayload:
//  - phone: número do CONTATO (lead), nunca o da clínica. Ignorar grupos/status/broadcast.
//  - direction: OUTBOUND quando enviada pela clínica (equipe), INBOUND quando veio do contato.
//  - external_message_id: ID único da mensagem (base da anti-duplicação).
//  - message_type: TEXT | AUDIO | IMAGE | VIDEO | DOCUMENT | STICKER | OTHER.
//  - Eventos que não são mensagem (entrega, leitura, presença) => { kind: "ignored" }.
// ============================================================================

export type EvahMessage = {
  external_message_id: string | null;
  phone: string;
  direction: "INBOUND" | "OUTBOUND";
  message_type: "TEXT" | "AUDIO" | "IMAGE" | "VIDEO" | "DOCUMENT" | "STICKER" | "OTHER";
  content: string | null;
  message_timestamp: string | null; // ISO 8601
};

export type AdapterResult =
  | { kind: "message"; message: EvahMessage }
  | { kind: "ignored"; reason: string }
  | { kind: "mapping_pending"; reason: string };

export function mapStevoPayload(_raw: unknown): AdapterResult {
  // TODO(Stevo): implementar com o payload real.
  return { kind: "mapping_pending", reason: "STEVO_MAPPING_NOT_IMPLEMENTED" };
}
