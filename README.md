# Evah Indicações

Tela de cadastro de indicações + integrações (GoHighLevel, Stevo, Evah Monitor).
**Banco, regras, filas e auditoria:** Supabase. **Chamadas externas e tela:** Vercel.

## Estrutura
| Arquivo | O que faz |
|---|---|
| `index.html` | Tela (login, Nova indicação, Indicações com histórico) |
| `api/register-referral.ts` | Cadastro vindo da tela + envio imediato ao GHL |
| `api/stevo-webhook.ts` | Recebe mensagens da Stevo (`?org=<slug>` + segredo) |
| `api/worker.ts` | Chamado a cada minuto pelo Supabase: GHL (novas tentativas e etapas) + Evah Monitor |
| `lib/ghl.ts` | Contato sem duplicar + oportunidade no pipeline Indicação + mudança de etapa |
| `lib/monitor.ts` | Prompt e chamada à OpenAI (só classifica; o banco decide) |
| `lib/stevo-adapter.ts` | **Único** lugar a ajustar quando tivermos o payload real da Stevo |

## Variáveis de ambiente (Vercel → Settings → Environment Variables)
| Nome | Onde pegar |
|---|---|
| `SUPABASE_URL` | `https://zqdyytelznxaceadtooh.supabase.co` |
| `SUPABASE_ANON_KEY` | Chave publicável (sb_publishable_…) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → chave secreta. **Nunca** colocar na tela |
| `OPENAI_API_KEY` | platform.openai.com → API keys |
| `EVAH_WORKER_SECRET` | SQL Editor do Supabase: `select decrypted_secret from vault.decrypted_secrets where name = 'evah_worker_secret';` |

O token do GoHighLevel **não** vai na Vercel: é lido do banco por clínica.
