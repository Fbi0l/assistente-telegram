import { test } from "node:test";
import assert from "node:assert/strict";
import { criarBot } from "../supabase/functions/telegram-bot/bot.ts";
import { criarHandler, segredoWebhook, iguais } from "../supabase/functions/telegram-bot/handler.ts";

const AGORA = new Date("2026-10-30T13:00:00Z"); // sex 30/10 10:00 em Fortaleza

// Banco em memoria com o mesmo comportamento esperado do Supabase.
function bancoFalso() {
  let seq = 0;
  const lembretes = [], notas = [];
  return {
    lembretes, notas,
    async criarLembrete(quando, texto) { lembretes.push({ id: `l${++seq}`, quando, texto, enviado: false, cancelado: false, tentativas: 0 }); },
    async lembretesPendentes(n) { return lembretes.filter((l) => !l.enviado && !l.cancelado).sort((a, b) => a.quando - b.quando).slice(0, n); },
    async cancelarLembrete(id) { const l = lembretes.find((x) => x.id === id && !x.enviado && !x.cancelado); if (l) l.cancelado = true; return !!l; },
    async criarNota(texto) { notas.push({ id: `n${++seq}`, texto, criado_em: new Date(AGORA.getTime() + seq) }); },
    async notasRecentes(n) { return [...notas].sort((a, b) => b.criado_em - a.criado_em).slice(0, n); },
    async buscarNotas(t, n) { return (await this.notasRecentes(1000)).filter((x) => x.texto.toLowerCase().includes(t.toLowerCase())).slice(0, n); },
    async apagarNota(id) { const i = notas.findIndex((x) => x.id === id); if (i >= 0) notas.splice(i, 1); return i >= 0; },
    async reivindicarLembretes(n) {
      const v = lembretes.filter((l) => !l.enviado && !l.cancelado && l.quando <= this.agora && l.tentativas < 5).slice(0, n);
      v.forEach((l) => { l.enviado = true; l.tentativas++; }); return v;
    },
    async liberarLembrete(id) { const l = lembretes.find((x) => x.id === id); if (l) l.enviado = false; },
    agora: AGORA,
  };
}

test("lembretes: criar, listar, cancelar", async () => {
  const b = bancoFalso(), bot = criarBot(b, () => AGORA);
  assert.match(await bot.tratar("lembrar amanhã 8h pagar a conta"), /Vou te lembrar sáb 31\/10 às 08:00:\npagar a conta/);
  await bot.tratar("lembrar em 30 min tirar o bolo");
  const lista = await bot.tratar("/lembretes");
  assert.match(lista, /1\. sex 30\/10 às 10:30 — tirar o bolo\n2\. sáb 31\/10 às 08:00 — pagar a conta/);
  assert.match(await bot.tratar("cancelar 1"), /Cancelado: tirar o bolo/);
  assert.match(await bot.tratar("/lembretes"), /1\. sáb 31\/10 às 08:00 — pagar a conta/);
  assert.match(await bot.tratar("cancelar 5"), /Não há lembrete nº 5/);
  assert.match(await bot.tratar("lembrar xyz"), /Não entendi quando/);
});

test("notas: anotar, listar, buscar, apagar", async () => {
  const b = bancoFalso(), bot = criarBot(b, () => AGORA);
  assert.equal(await bot.tratar("/notas"), "Nenhuma nota ainda. Ex.: nota comprar filtro de café");
  assert.equal(await bot.tratar("nota comprar filtro de café"), "Anotado.");
  await bot.tratar("nota senha do wifi está na geladeira");
  assert.match(await bot.tratar("/notas"), /1\. senha do wifi está na geladeira\n2\. comprar filtro de café/);
  assert.match(await bot.tratar("buscar CAFÉ"), /Notas com "CAFÉ":\n1\. comprar filtro de café/);
  assert.match(await bot.tratar("buscar pizza"), /Nada encontrado/);
  assert.match(await bot.tratar("apagar 2"), /Apagada: comprar filtro de café/);
  assert.equal(b.notas.length, 1);
});

test("disparo: envia vencidos, devolve à fila o que falhou, desiste após 5 tentativas", async () => {
  const b = bancoFalso(), bot = criarBot(b, () => AGORA);
  await bot.tratar("lembrar em 10 min a");
  await bot.tratar("lembrar em 20 min b");
  b.agora = new Date(AGORA.getTime() + 15 * 60000);
  const enviados = [];
  assert.deepEqual(await bot.disparar(async (t) => (enviados.push(t), true)), { enviados: 1, falhas: 0 });
  assert.deepEqual(enviados, ["Lembrete: a"]);
  b.agora = new Date(AGORA.getTime() + 25 * 60000);
  for (let i = 0; i < 5; i++) assert.deepEqual(await bot.disparar(async () => false), { enviados: 0, falhas: 1 });
  assert.deepEqual(await bot.disparar(async () => true), { enviados: 0, falhas: 0 }, "depois de 5 falhas para de tentar");
  await bot.tratar("lembrar em 30 min c");
  b.agora = new Date(AGORA.getTime() + 40 * 60000);
  assert.deepEqual(await bot.disparar(async () => { throw new Error("rede"); }), { enviados: 0, falhas: 1 });
});

// ---------- Seguranca das chamadas HTTP ----------
const TOKEN = "123456:ABC-token-de-teste", DONO = "987654321";
async function montar(extra = {}) {
  const enviadas = [];
  const dep = {
    banco: bancoFalso(), tokenBot: TOKEN, donoId: DONO, urlFuncao: "https://x.supabase.co/functions/v1/telegram-bot",
    segredoCron: async () => "segredo-cron-teste",
    telegram: async (metodo, corpo) => (enviadas.push({ metodo, corpo }), true),
    agora: () => AGORA, log: () => {}, ...extra,
  };
  return { h: criarHandler(dep), enviadas, dep };
}
const req = (headers, body, method = "POST") =>
  new Request("https://x/", { method, headers: { "Content-Type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined });
const msg = (texto, de = DONO, tipo = "private") => ({ message: { text: texto, from: { id: Number(de) }, chat: { id: Number(de), type: tipo } } });

test("Telegram: só o dono, em conversa privada, com o segredo certo", async () => {
  const { h, enviadas } = await montar();
  const s = await segredoWebhook(TOKEN);
  assert.equal(s.length, 64);
  let r = await h(req({ "x-telegram-bot-api-secret-token": s }, msg("/ajuda")));
  assert.equal(r.status, 200); assert.match(enviadas[0].corpo.text, /Sou seu assistente/); assert.equal(enviadas[0].corpo.chat_id, DONO);
  // Segredo errado ou ausente
  assert.equal((await h(req({ "x-telegram-bot-api-secret-token": "errado" }, msg("/ajuda")))).status, 401);
  assert.equal((await h(req({}, msg("/ajuda")))).status, 401);
  // Outra pessoa ou grupo: ignora em silencio (200 sem resposta)
  enviadas.length = 0;
  assert.equal((await h(req({ "x-telegram-bot-api-secret-token": s }, msg("/notas", "111")))).status, 200);
  assert.equal((await h(req({ "x-telegram-bot-api-secret-token": s }, msg("/notas", DONO, "group")))).status, 200);
  assert.equal(enviadas.length, 0);
  // Sem texto (foto): avisa
  await h(req({ "x-telegram-bot-api-secret-token": s }, { message: { photo: [], from: { id: Number(DONO) }, chat: { type: "private" } } }));
  assert.match(enviadas[0].corpo.text, /só entendo mensagens de texto/);
  // GET recusado
  assert.equal((await h(req({}, null, "GET"))).status, 405);
});

test("Telegram: erro interno vira aviso amigável e 200 (sem reenvio)", async () => {
  const { h, enviadas, dep } = await montar();
  dep.banco.criarNota = async () => { throw new Error("banco fora"); };
  const r = await h(req({ "x-telegram-bot-api-secret-token": await segredoWebhook(TOKEN) }, msg("nota algo")));
  assert.equal(r.status, 200); assert.match(enviadas[0].corpo.text, /Tive um problema/);
});

test("Agendador: segredo do Vault, disparo e registro do webhook", async () => {
  const { h, enviadas } = await montar();
  assert.equal((await h(req({ "x-cron-secret": "errado" }, { acao: "disparar" }))).status, 401);
  let r = await h(req({ "x-cron-secret": "segredo-cron-teste" }, { acao: "disparar" }));
  assert.deepEqual(await r.json(), { enviados: 0, falhas: 0 });
  r = await h(req({ "x-cron-secret": "segredo-cron-teste" }, { acao: "registrar_webhook" }));
  assert.equal(r.status, 200);
  const wh = enviadas.find((e) => e.metodo === "setWebhook").corpo;
  assert.equal(wh.secret_token, await segredoWebhook(TOKEN));
  assert.deepEqual(wh.allowed_updates, ["message"]);
  assert.equal((await h(req({ "x-cron-secret": "segredo-cron-teste" }, { acao: "outra" }))).status, 400);
  // Vault sem segredo: recusa mesmo com cabecalho vazio
  const sem = await montar({ segredoCron: async () => null });
  assert.equal((await sem.h(req({ "x-cron-secret": "" }, { acao: "disparar" }))).status, 401);
});

test("Configuração incompleta não responde a ninguém", async () => {
  const { h } = await montar({ donoId: "" });
  assert.equal((await h(req({ "x-telegram-bot-api-secret-token": "x" }, msg("/ajuda")))).status, 500);
  assert.ok(iguais("abc", "abc") && !iguais("abc", "abd") && !iguais("abc", "abcd"));
});
