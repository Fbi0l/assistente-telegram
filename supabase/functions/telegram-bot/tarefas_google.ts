// Google Tarefas (Tasks) com o login do dono: OAuth com refresh token (a conta de servico nao enxerga as tarefas).
// Segredos da funcao: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET e GOOGLE_TASKS_REFRESH_TOKEN.
// Usa a lista padrao ("Minhas tarefas"). Nenhum token e registrado em log.
import { ErroGoogle } from "./google.ts";
import { dataLocal, deDataLocal } from "./interpretar.ts";

export type TarefaExterna = { id: string; titulo: string; prazo: Date | null };

export interface TarefasExternas {
  criar(titulo: string, prazo: Date | null): Promise<string>; // devolve o id da tarefa no Google
  concluir(id: string): Promise<void>; // tarefa ja apagada no Google conta como sucesso
  listar(): Promise<TarefaExterna[]>; // pendentes, sem as criadas pelo proprio bot
}

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const API = "https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks";
const MARCA = "Criada pelo assistente do Telegram.";

type Opcoes = { clientId: string; clientSecret: string; refreshToken: string; fetch?: typeof fetch; agora?: () => Date };

// null = Google Tarefas nao configurado (a lista do bot funciona sem ele).
export function criarTarefasGoogle(op: Opcoes): TarefasExternas | null {
  const id = op.clientId.trim(), segredo = op.clientSecret.trim(), refresh = op.refreshToken.trim();
  if (!id && !segredo && !refresh) return null;
  if (!id || !segredo || !refresh) {
    const falha = () => Promise.reject(new ErroGoogle("faltam segredos: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET e GOOGLE_TASKS_REFRESH_TOKEN."));
    return { criar: falha, concluir: falha, listar: falha };
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
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: id, client_secret: segredo, refresh_token: refresh }),
      signal: AbortSignal.timeout(8000),
    });
    const res = await r.json().catch(() => ({}));
    if (!r.ok || typeof res.access_token !== "string") {
      throw new ErroGoogle(res.error === "invalid_grant"
        ? "a autorização do Google Tarefas expirou ou foi revogada. Gere um novo refresh token e atualize o GOOGLE_TASKS_REFRESH_TOKEN."
        : `o Google recusou o login das tarefas (${res.error ?? r.status}). Confira o client ID e o client secret.`);
    }
    token = { valor: res.access_token, expira: t + (Number(res.expires_in) || 3600) * 1000 };
    return token.valor;
  }

  async function chamar(metodo: string, caminho: string, corpo?: unknown, aceitar: number[] = []): Promise<any> {
    const r = await buscar(`${API}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${await obterToken()}`, ...(corpo ? { "Content-Type": "application/json" } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (aceitar.includes(r.status)) return null;
    const res = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) {
      const motivo = String(res?.error?.message ?? "").slice(0, 200);
      if (r.status === 403) throw new ErroGoogle(`sem permissão (${motivo}). Confira se a Google Tasks API está ativada no projeto.`);
      throw new ErroGoogle(`o Google Tarefas respondeu ${r.status}${motivo ? ` (${motivo})` : ""}.`);
    }
    return res;
  }

  return {
    async criar(titulo, prazo) {
      const t = await chamar("POST", "", { title: titulo, notes: MARCA, ...(prazo ? { due: `${dataLocal(prazo)}T00:00:00.000Z` } : {}) });
      if (typeof t?.id !== "string") throw new ErroGoogle("o Google não devolveu a tarefa criada.");
      return t.id;
    },
    async concluir(idTarefa) {
      await chamar("PATCH", `/${encodeURIComponent(idTarefa)}`, { status: "completed" }, [404, 410]);
    },
    async listar() {
      const res = await chamar("GET", "?showCompleted=false&showHidden=false&maxResults=100");
      const tarefas: TarefaExterna[] = [];
      for (const t of res?.items ?? []) {
        if (t?.status === "completed" || t?.deleted || t?.notes === MARCA) continue;
        const titulo = typeof t.title === "string" && t.title.trim() ? t.title.trim() : "(sem título)";
        const prazo = typeof t.due === "string" && /^\d{4}-\d{2}-\d{2}/.test(t.due) ? deDataLocal(t.due.slice(0, 10)) : null;
        tarefas.push({ id: String(t.id), titulo, prazo });
      }
      return tarefas;
    },
  };
}
