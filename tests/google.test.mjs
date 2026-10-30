// Cliente do Google Agenda com fetch falso: assinatura do JWT, token em cache, eventos e erros.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarAgendaGoogle, ErroGoogle } from "../supabase/functions/telegram-bot/google.ts";

const AGORA = new Date("2026-10-30T13:00:00Z");
const par = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", par.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
const CRED = JSON.stringify({ type: "service_account", client_email: "bot-agenda@proj.iam.gserviceaccount.com", private_key: PEM, private_key_id: "k1" });
const CAL = "fulano@gmail.com";

const resposta = (status, corpo) => new Response(corpo === undefined ? null : JSON.stringify(corpo), { status });
function montar(rotas = {}) {
  const chamadas = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    chamadas.push({ url: u, metodo: init.method ?? "GET", headers: init.headers ?? {}, corpo: init.body });
    if (u === "https://oauth2.googleapis.com/token") return rotas.token?.() ?? resposta(200, { access_token: "tok-1", expires_in: 3600 });
    for (const [chave, fn] of Object.entries(rotas)) if (chave !== "token" && u.includes(chave)) return fn(u, init);
    return resposta(500, { error: { message: "rota não prevista no teste" } });
  };
  let agora = AGORA;
  const g = criarAgendaGoogle({ credencialJson: CRED, calendarioId: ` ${CAL}\r\n`, fetch, agora: () => agora });
  return { g, chamadas, avancar: (ms) => { agora = new Date(agora.getTime() + ms); } };
}
const b64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

test("sem segredos: Google desligado; segredo inválido: erro explicado", async () => {
  assert.equal(criarAgendaGoogle({ credencialJson: "", calendarioId: "" }), null);
  const ruim = criarAgendaGoogle({ credencialJson: "não é json", calendarioId: CAL });
  await assert.rejects(() => ruim.listar(AGORA, AGORA), (e) => e instanceof ErroGoogle && /GOOGLE_SERVICE_ACCOUNT/.test(e.message));
  const semCal = criarAgendaGoogle({ credencialJson: CRED, calendarioId: "" });
  await assert.rejects(() => semCal.criar("x", AGORA, AGORA), /GOOGLE_CALENDAR_ID/);
});

test("token: JWT assinado com a chave da conta de serviço e reaproveitado até expirar", async () => {
  const { g, chamadas, avancar } = montar({ "/events?": () => resposta(200, { items: [] }) });
  await g.listar(AGORA, new Date(AGORA.getTime() + 86400000));
  await g.listar(AGORA, new Date(AGORA.getTime() + 86400000));
  const tokens = chamadas.filter((c) => c.url.includes("oauth2"));
  assert.equal(tokens.length, 1, "token em cache");
  const corpo = new URLSearchParams(String(tokens[0].corpo));
  assert.equal(corpo.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [h, p, s] = corpo.get("assertion").split(".");
  assert.deepEqual(JSON.parse(b64(h)), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(b64(p));
  assert.equal(claims.iss, "bot-agenda@proj.iam.gserviceaccount.com");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/calendar.events");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(claims.iat, AGORA.getTime() / 1000);
  assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", par.publicKey, b64(s), new TextEncoder().encode(`${h}.${p}`)), "assinatura válida");
  assert.equal(chamadas[1].headers.Authorization, "Bearer tok-1");
  avancar(3550 * 1000); // a menos de 1 min de expirar: renova
  await g.listar(AGORA, new Date(AGORA.getTime() + 86400000));
  assert.equal(chamadas.filter((c) => c.url.includes("oauth2")).length, 2);
});

test("criar: evento com fuso de Fortaleza e marca do bot, na agenda certa", async () => {
  const { g, chamadas } = montar({ "/events": () => resposta(200, { id: "abc123" }) });
  const inicio = new Date("2026-10-31T13:00:00Z");
  assert.equal(await g.criar("dentista", inicio, new Date(inicio.getTime() + 3600000)), "abc123");
  const c = chamadas.at(-1);
  assert.equal(c.url, "https://www.googleapis.com/calendar/v3/calendars/fulano%40gmail.com/events");
  assert.equal(c.metodo, "POST");
  const ev = JSON.parse(c.corpo);
  assert.equal(ev.summary, "dentista");
  assert.deepEqual(ev.start, { dateTime: "2026-10-31T13:00:00.000Z", timeZone: "America/Fortaleza" });
  assert.deepEqual(ev.end, { dateTime: "2026-10-31T14:00:00.000Z", timeZone: "America/Fortaleza" });
  assert.deepEqual(ev.extendedProperties, { private: { assistenteTelegram: "1" } });
});

test("criar dia inteiro: datas de Fortaleza, fim no dia seguinte", async () => {
  const { g, chamadas } = montar({ "/events": () => resposta(200, { id: "x" }) });
  await g.criar("festa", new Date("2026-11-12T03:00:00Z"), new Date("2026-11-13T03:00:00Z"), true);
  const ev = JSON.parse(chamadas.at(-1).corpo);
  assert.deepEqual(ev.start, { date: "2026-11-12" });
  assert.deepEqual(ev.end, { date: "2026-11-13" });
});

test("listar: horário e dia inteiro, sem cancelados nem os criados pelo bot", async () => {
  const { g, chamadas } = montar({
    "/events?": () => resposta(200, { items: [
      { id: "a", summary: "Aniversário", start: { date: "2026-10-31" } },
      { id: "b", summary: " Academia ", start: { dateTime: "2026-10-31T18:00:00-03:00" } },
      { id: "c", summary: "dentista", start: { dateTime: "2026-10-31T10:00:00-03:00" }, extendedProperties: { private: { assistenteTelegram: "1" } } },
      { id: "d", status: "cancelled" },
      { id: "e", start: { dateTime: "2026-10-31T20:00:00-03:00" } },
    ] }),
  });
  const ev = await g.listar(new Date("2026-10-31T03:00:00Z"), new Date("2026-11-01T03:00:00Z"));
  assert.deepEqual(ev.map((e) => [e.id, e.titulo, e.inicio.toISOString(), e.diaInteiro]), [
    ["a", "Aniversário", "2026-10-31T03:00:00.000Z", true],
    ["b", "Academia", "2026-10-31T21:00:00.000Z", false],
    ["e", "(sem título)", "2026-10-31T23:00:00.000Z", false],
  ]);
  const q = new URL(chamadas.at(-1).url).searchParams;
  assert.equal(q.get("singleEvents"), "true");
  assert.equal(q.get("timeMin"), "2026-10-31T03:00:00.000Z");
});

test("apagar: evento já apagado no Google não é erro", async () => {
  for (const status of [204, 404, 410]) {
    const { g, chamadas } = montar({ "/events/": () => resposta(status, status === 204 ? undefined : { error: { message: "x" } }) });
    await g.apagar("abc/1");
    assert.equal(chamadas.at(-1).metodo, "DELETE");
    assert.match(chamadas.at(-1).url, /\/events\/abc%2F1$/);
  }
});

test("erros: mensagens que dizem o que conferir, sem expor a chave", async () => {
  const casos = [
    [404, /agenda não encontrada.*compartilhada/],
    [403, /sem permissão \(Calendar API disabled\).*Google Calendar API/],
    [500, /respondeu 500/],
  ];
  for (const [status, esperado] of casos) {
    const { g } = montar({ "/events": () => resposta(status, { error: { message: "Calendar API disabled" } }) });
    await assert.rejects(() => g.criar("x", AGORA, AGORA), (e) => e instanceof ErroGoogle && esperado.test(e.message));
  }
  const { g } = montar({ token: () => resposta(400, { error: "invalid_grant" }) });
  await assert.rejects(() => g.listar(AGORA, AGORA), (e) => e instanceof ErroGoogle && /recusada \(invalid_grant\)/.test(e.message) && !e.message.includes("PRIVATE"));
});
