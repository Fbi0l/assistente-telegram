// Cliente do Google Tarefas com fetch falso: refresh token, criar, concluir, listar e erros.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarTarefasGoogle } from "../supabase/functions/telegram-bot/tarefas_google.ts";
import { ErroGoogle } from "../supabase/functions/telegram-bot/google.ts";

const AGORA = new Date("2026-10-30T13:00:00Z");
const resposta = (status, corpo) => new Response(corpo === undefined ? null : JSON.stringify(corpo), { status });
function montar(rotas = {}) {
  const chamadas = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    chamadas.push({ url: u, metodo: init.method ?? "GET", headers: init.headers ?? {}, corpo: init.body });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return rotas.token?.() ?? resposta(200, { access_token: "tok-t", expires_in: 3600 });
    return rotas.api?.(u, init) ?? resposta(500, {});
  };
  const g = criarTarefasGoogle({ clientId: "cid", clientSecret: "csec\n", refreshToken: " rtok ", fetch, agora: () => AGORA });
  return { g, chamadas };
}

test("sem segredos: desligado; incompleto: erro explicado", async () => {
  assert.equal(criarTarefasGoogle({ clientId: "", clientSecret: "", refreshToken: "" }), null);
  const meia = criarTarefasGoogle({ clientId: "x", clientSecret: "", refreshToken: "" });
  await assert.rejects(() => meia.listar(), (e) => e instanceof ErroGoogle && /GOOGLE_TASKS_REFRESH_TOKEN/.test(e.message));
});

test("criar: refresh token trocado por acesso (em cache), prazo como data, marca do bot", async () => {
  const { g, chamadas } = montar({ api: () => resposta(200, { id: "T1" }) });
  assert.equal(await g.criar("entregar relatório", new Date("2026-11-15T03:00:00Z")), "T1");
  await g.criar("comprar tinta", null);
  const tokens = chamadas.filter((c) => c.url.includes("oauth2"));
  assert.equal(tokens.length, 1);
  const corpo = new URLSearchParams(String(tokens[0].corpo));
  assert.deepEqual(Object.fromEntries(corpo), { grant_type: "refresh_token", client_id: "cid", client_secret: "csec", refresh_token: "rtok" });
  const c1 = chamadas[1];
  assert.equal(c1.url, "https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks");
  assert.equal(c1.headers.Authorization, "Bearer tok-t");
  assert.deepEqual(JSON.parse(c1.corpo), { title: "entregar relatório", notes: "Criada pelo assistente do Telegram.", due: "2026-11-15T00:00:00.000Z" });
  assert.equal(JSON.parse(chamadas[2].corpo).due, undefined);
});

test("listar: só pendentes de fora do bot; concluir: tarefa sumida não é erro", async () => {
  const { g, chamadas } = montar({ api: (u, init) => {
    if ((init.method ?? "GET") === "PATCH") return resposta(404, { error: { message: "x" } });
    return resposta(200, { items: [
      { id: "a", title: "Renovar CNH", status: "needsAction" },
      { id: "b", title: "Pagar IPTU", due: "2026-11-20T00:00:00.000Z", status: "needsAction" },
      { id: "c", title: "do bot", notes: "Criada pelo assistente do Telegram.", status: "needsAction" },
      { id: "d", title: "feita", status: "completed" },
    ] });
  } });
  const l = await g.listar();
  assert.deepEqual(l.map((t) => [t.id, t.titulo, t.prazo && t.prazo.toISOString()]), [["a", "Renovar CNH", null], ["b", "Pagar IPTU", "2026-11-20T03:00:00.000Z"]]);
  assert.match(chamadas.at(-1).url, /showCompleted=false/);
  await g.concluir("a/1");
  assert.equal(chamadas.at(-1).metodo, "PATCH");
  assert.match(chamadas.at(-1).url, /\/tasks\/a%2F1$/);
  assert.deepEqual(JSON.parse(chamadas.at(-1).corpo), { status: "completed" });
});

test("erros: autorização revogada e API desativada", async () => {
  let { g } = montar({ token: () => resposta(400, { error: "invalid_grant" }) });
  await assert.rejects(() => g.listar(), (e) => e instanceof ErroGoogle && /expirou ou foi revogada/.test(e.message));
  ({ g } = montar({ api: () => resposta(403, { error: { message: "Tasks API has not been used" } }) }));
  await assert.rejects(() => g.listar(), /Google Tasks API está ativada/);
});
