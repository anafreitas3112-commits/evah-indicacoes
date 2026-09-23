// ============================================================================
// ADAPTER STEVO — mapeado a partir de payloads REAIS da instância indaia-recep (23/09/2026)
// Formato (padrão whatsmeow):
//   { event: "Message", instanceName, instanceId, serverUrl, instanceToken(!),
//     data: { Info: { ID, Chat, Sender, SenderAlt, RecipientAlt, IsFromMe, IsGroup, Type, MediaType, Timestamp },
//             text, IsEdit, Message: { conversation | extendedTextMessage | audioMessage | imageMessage | ... } } }
// - Direção: Info.IsFromMe (true = enviada pela clínica).
// - Telefone do contato: o JID "@s.whatsapp.net" entre Chat / RecipientAlt / SenderAlt / Sender.
//   (Quando o WhatsApp usa "@lid", o número real vem no campo *Alt.)
// - Anti-duplicação: Info.ID.
// ============================================================================

export type EvahMessage = {
  external_message_id: string | null;
  phone: string;
  direction: "INBOUND" | "OUTBOUND";
  message_type: "TEXT" | "AUDIO" | "IMAGE" | "VIDEO" | "DOCUMENT" | "STICKER" | "OTHER";
  content: string | null;
  message_timestamp: string | null;
  raw_payload: Record<string, unknown>; // versão MÍNIMA (sem segredos, sem conteúdo criptográfico)
};

export type AdapterResult =
  | { kind: "message"; message: EvahMessage }
  | { kind: "ignored"; reason: string }
  | { kind: "mapping_pending"; reason: string };

// Remove o que nunca deve ser guardado (a Stevo manda a chave da instância em todo evento)
export function sanitizeStevoPayload(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  const { instanceToken, token, apikey, apiKey, ...rest } = raw;
  return rest;
}

function phoneFromJid(jid: unknown): string | null {
  if (typeof jid !== "string" || !jid.endsWith("@s.whatsapp.net")) return null;
  const digits = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}

function detectType(m: any, info: any): EvahMessage["message_type"] {
  if (!m || typeof m !== "object") return "OTHER";
  if (m.conversation || m.extendedTextMessage) return "TEXT";
  if (m.audioMessage || m.pttMessage) return "AUDIO";
  if (m.imageMessage) return "IMAGE";
  if (m.videoMessage || m.ptvMessage) return "VIDEO";
  if (m.documentMessage || m.documentWithCaptionMessage) return "DOCUMENT";
  if (m.stickerMessage) return "STICKER";
  const mt = String(info?.MediaType ?? "").toLowerCase();
  if (mt === "ptt" || mt === "audio") return "AUDIO";
  if (mt === "image") return "IMAGE";
  if (mt === "video") return "VIDEO";
  if (mt === "document") return "DOCUMENT";
  if (mt === "sticker") return "STICKER";
  return "OTHER";
}

function extractText(d: any): string | null {
  const m = d?.Message ?? {};
  const t = d?.text || m.conversation || m.extendedTextMessage?.text
    || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption
    || m.documentWithCaptionMessage?.message?.documentMessage?.caption || null;
  return t ? String(t).slice(0, 4000) : null;
}

export function mapStevoPayload(raw: any): AdapterResult {
  if (!raw || typeof raw !== "object") return { kind: "ignored", reason: "EMPTY" };
  const event = String(raw.event ?? "");
  const d = raw.data;
  const info = d?.Info;
  if (!info || typeof info !== "object") return { kind: "ignored", reason: `EVENT_${event || "UNKNOWN"}_WITHOUT_MESSAGE` };

  const chat = String(info.Chat ?? "");
  if (info.IsGroup || chat.endsWith("@g.us") || chat.endsWith("@broadcast") || chat.endsWith("@newsletter") || info.IsNewsletterStatus) {
    return { kind: "ignored", reason: "GROUP_OR_BROADCAST" };
  }
  const m = d.Message ?? {};
  if (d.IsEdit || info.Edit || m.protocolMessage || m.reactionMessage || m.pollUpdateMessage) {
    return { kind: "ignored", reason: "EDIT_REACTION_OR_PROTOCOL" };
  }

  const fromMe = info.IsFromMe === true;
  const phone = phoneFromJid(info.Chat)
    ?? phoneFromJid(fromMe ? info.RecipientAlt : info.SenderAlt)
    ?? (fromMe ? null : phoneFromJid(info.Sender));
  if (!phone) return { kind: "ignored", reason: "CONTACT_PHONE_NOT_FOUND" };

  const type = detectType(m, info);
  return {
    kind: "message",
    message: {
      external_message_id: info.ID ? String(info.ID) : null,
      phone,
      direction: fromMe ? "OUTBOUND" : "INBOUND",
      message_type: type,
      content: extractText(d),
      message_timestamp: info.Timestamp ? String(info.Timestamp) : null,
      raw_payload: {
        provider: "STEVO", event, instanceName: raw.instanceName ?? null,
        Info: { ID: info.ID, Chat: info.Chat, IsFromMe: info.IsFromMe, Type: info.Type, MediaType: info.MediaType, Timestamp: info.Timestamp },
      },
    },
  };
}
