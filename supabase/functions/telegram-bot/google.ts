// Google Agenda por conta de servico: JWT assinado (RS256) -> token OAuth -> API de eventos.
// Sem bibliotecas: so fetch e WebCrypto. A chave nunca e registrada em log.
// Segredos da funcao: GOOGLE_SERVICE_ACCOUNT (conteudo do .json) e GOOGLE_CALENDAR_ID.
import { deLocal, paraLocal } from "./interpretar.ts";

export type EventoExterno = { id: string; titulo: string; inicio: Date; diaInteiro: boolean };

export interface AgendaExterna {
  criar(titulo: string, inicio: Date, fim: Date, diaInteiro?: boolean): Promise<string>; // devolve o id do evento
  apagar(id: string): Promise<void>; // evento ja apagado conta como sucesso
  listar(de: Date, ate: Date): Promise<EventoExterno[]>; // sem os eventos criados pelo proprio bot
}

// Erro com mensagem que pode ser mostrada ao dono (sem dados secretos).
export class ErroGoogle extends Error {}

const ESCOPO = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3/calendars";
const MARCA = "assistenteTelegram"; // propriedade privada que identifica eventos criados pelo bot
const FUSO = "America/Fortaleza";

type Credencial = { client_email: string; private_key: string };

// "2026-11-12" no fuso de Fortaleza (eventos de dia inteiro).
const dataLocal = (d: Date) => { const l = paraLocal(d); return `${l.ano}-${String(l.mes + 1).padStart(2, "0")}-${String(l.dia).padStart(2, "0")}`; };

export function lerCredencial(json: string): Credencial | null {
  try {
    const c = JSON.parse(json.trim());
    if (typeof c?.client_email !== "string" || typeof c?.private_key !== "string") return null;
    if (!c.private_key.includes("PRIVATE KEY")) return null;
    return { client_email: c.client_email, private_key: c.private_key };
  } catch {
    return null;
  }
}

const b64url = (dados: Uint8Array | string) => {
  const bytes = typeof dados === "string" ? new TextEncoder().encode(dados) : dados;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function assinarJwt(cred: Credencial, agoraSeg: number): Promise<string> {
  const der = Uint8Array.from(atob(cred.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const cabecalho = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = b64url(JSON.stringify({ iss: cred.client_email, scope: ESCOPO, aud: TOKEN_URI, iat: agoraSeg, exp: agoraSeg + 3600 }));
  const assinatura = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(`${cabecalho}.${corpo}`));
  return `${cabecalho}.${corpo}.${b64url(new Uint8Array(assinatura))}`;
}

// Traduz as falhas mais comuns da configuracao para algo que o dono consiga resolver.
function explicar(status: number, motivo: string): ErroGoogle {
  if (status === 404) return new ErroGoogle("agenda não encontrada. Confira o GOOGLE_CALENDAR_ID e se a agenda foi compartilhada com o e-mail da conta de serviço.");
  if (status === 403) return new ErroGoogle(`sem permissão (${motivo}). Confira se a Google Calendar API está ativada e se a agenda foi compartilhada com "Fazer alterações nos eventos".`);
  if (status === 401) return new ErroGoogle("credencial recusada. Gere uma nova chave JSON e atualize o GOOGLE_SERVICE_ACCOUNT.");
  return new ErroGoogle(`o Google respondeu ${status}${motivo ? ` (${motivo})` : ""}.`);
}

type Opcoes = {
  credencialJson: string;
  calendarioId: string;
  fetch?: typeof fetch;
  agora?: () => Date;
};

// null = Google Agenda nao configurado (o bot funciona sem ele).
export function criarAgendaGoogle(op: Opcoes): AgendaExterna | null {
  const json = op.credencialJson.trim(), calendario = op.calendarioId.trim();
  if (!json && !calendario) return null;
  const cred = lerCredencial(json);
  const problema = !cred
    ? "o segredo GOOGLE_SERVICE_ACCOUNT não é o conteúdo de uma chave JSON de conta de serviço."
    : !calendario ? "falta o segredo GOOGLE_CALENDAR_ID." : null;
  if (problema) {
    const falha = () => Promise.reject(new ErroGoogle(problema));
    return { criar: falha, apagar: falha, listar: falha };
  }

  const buscar = op.fetch ?? fetch;
  const agora = op.agora ?? (() => new Date());
  let token: { valor: string; expira: number } | null = null;

  async function obterToken(): Promise<string> {
    const t = agora().getTime();
    if (token && token.expira - 60000 > t) return token.valor;
    const r = await buscar(TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: await assinarJwt(cred!, Math.floor(t / 1000)),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const res = await r.json().catch(() => ({}));
    if (!r.ok || typeof res.access_token !== "string") {
      throw new ErroGoogle(`a chave da conta de serviço foi recusada (${res.error ?? r.status}). Gere uma nova chave JSON e atualize o GOOGLE_SERVICE_ACCOUNT.`);
    }
    token = { valor: res.access_token, expira: t + (Number(res.expires_in) || 3600) * 1000 };
    return token.valor;
  }

  async function chamar(metodo: string, caminho: string, corpo?: unknown, aceitar: number[] = []): Promise<any> {
    const r = await buscar(`${API}/${encodeURIComponent(calendario)}/events${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${await obterToken()}`, ...(corpo ? { "Content-Type": "application/json" } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (aceitar.includes(r.status)) return null;
    const res = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw explicar(r.status, String(res?.error?.message ?? "").slice(0, 200));
    return res;
  }

  return {
    async criar(titulo, inicio, fim, diaInteiro = false) {
      const ev = await chamar("POST", "", {
        summary: titulo,
        description: "Marcado pelo assistente do Telegram.",
        start: diaInteiro ? { date: dataLocal(inicio) } : { dateTime: inicio.toISOString(), timeZone: FUSO },
        end: diaInteiro ? { date: dataLocal(fim) } : { dateTime: fim.toISOString(), timeZone: FUSO },
        extendedProperties: { private: { [MARCA]: "1" } },
      });
      if (typeof ev?.id !== "string") throw new ErroGoogle("o Google não devolveu o evento criado.");
      return ev.id;
    },
    async apagar(id) {
      // 404/410: ja nao existe (apagado direto no Google) -> nada a fazer.
      await chamar("DELETE", `/${encodeURIComponent(id)}`, undefined, [404, 410]);
    },
    async listar(de, ate) {
      const q = new URLSearchParams({
        timeMin: de.toISOString(), timeMax: ate.toISOString(), singleEvents: "true", orderBy: "startTime",
        maxResults: "100", timeZone: FUSO,
      });
      const res = await chamar("GET", `?${q}`);
      const eventos: EventoExterno[] = [];
      for (const e of res?.items ?? []) {
        if (e?.status === "cancelled" || e?.extendedProperties?.private?.[MARCA]) continue;
        const titulo = typeof e.summary === "string" && e.summary.trim() ? e.summary.trim() : "(sem título)";
        if (typeof e.start?.dateTime === "string") {
          eventos.push({ id: String(e.id), titulo, inicio: new Date(e.start.dateTime), diaInteiro: false });
        } else if (typeof e.start?.date === "string") {
          const [a, m, d] = e.start.date.split("-").map(Number);
          eventos.push({ id: String(e.id), titulo, inicio: deLocal(a, m - 1, d, 0, 0), diaInteiro: true });
        }
      }
      return eventos;
    },
  };
}
