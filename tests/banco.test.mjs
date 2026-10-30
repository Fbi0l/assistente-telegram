// Aplica supabase/migrations/0001_inicial.sql num PostgreSQL em memoria (PGlite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

async function banco() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets(name text, decrypted_secret text);`);
  for (const f of ["0001_inicial.sql", "0003_agenda.sql", "0004_google.sql", "0005_dia_inteiro.sql", "0006_tarefas.sql"]) {
    const sql = readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8");
    await db.exec(sql);
    await db.exec(sql); // reaplicar nao quebra
  }
  return db;
}
const comoPapel = async (db, papel, fn) => { await db.exec(`SET ROLE ${papel}`); try { return await fn(); } finally { await db.exec("RESET ROLE"); } };
const n = async (db, q, p = []) => Object.values((await db.query(q, p)).rows[0])[0];

test("dados só para o service_role (funcao do bot)", async () => {
  const db = await banco();
  for (const papel of ["anon", "authenticated"]) {
    await comoPapel(db, papel, async () => {
      await assert.rejects(() => db.query("SELECT * FROM public.lembretes"), /permission denied/);
      await assert.rejects(() => db.query("SELECT * FROM public.notas"), /permission denied/);
      await assert.rejects(() => db.query("SELECT public.reivindicar_lembretes(5)"), /permission denied/);
      await assert.rejects(() => db.query("SELECT public.segredo_cron()"), /permission denied/);
    });
  }
  await comoPapel(db, "service_role", async () => {
    await db.query("INSERT INTO public.notas(texto) VALUES ('ok')");
    assert.equal(await n(db, "SELECT count(*)::int FROM public.notas"), 1);
  });
});

test("limites de texto", async () => {
  const db = await banco();
  await assert.rejects(() => db.query("INSERT INTO public.notas(texto) VALUES ('   ')"), /check/);
  await assert.rejects(() => db.query("INSERT INTO public.lembretes(texto,quando) VALUES ($1, now())", ["x".repeat(501)]), /check/);
});

test("reivindicar: só vencidos, não cancelados, até 5 tentativas; liberar devolve à fila", async () => {
  const db = await banco();
  await db.exec(`INSERT INTO public.lembretes(texto,quando) VALUES
    ('vencido', now() - interval '1 min'), ('futuro', now() + interval '1 hour'),
    ('cancelado', now() - interval '1 min'), ('antigo', now() - interval '2 min');
    UPDATE public.lembretes SET cancelado_em = now() WHERE texto = 'cancelado';`);
  const pegar = async () => (await comoPapel(db, "service_role", () => db.query("SELECT texto FROM public.reivindicar_lembretes(10)"))).rows.map((r) => r.texto);
  assert.deepEqual(await pegar(), ["antigo", "vencido"], "ordem por horario, sem futuro nem cancelado");
  assert.deepEqual(await pegar(), [], "não pega de novo o que já saiu");
  const id = await n(db, "SELECT id FROM public.lembretes WHERE texto='vencido'");
  for (let i = 0; i < 4; i++) {
    await comoPapel(db, "service_role", () => db.query("SELECT public.liberar_lembrete($1)", [id]));
    assert.deepEqual(await pegar(), ["vencido"]);
  }
  await comoPapel(db, "service_role", () => db.query("SELECT public.liberar_lembrete($1)", [id]));
  assert.deepEqual(await pegar(), [], "depois de 5 tentativas desiste");
  assert.equal(await n(db, "SELECT tentativas FROM public.lembretes WHERE id=$1", [id]), 5);
  // limite fora da faixa e corrigido
  await db.exec("INSERT INTO public.lembretes(texto,quando) SELECT 'm'||g, now() - interval '1 min' FROM generate_series(1,150) g");
  assert.equal((await comoPapel(db, "service_role", () => db.query("SELECT 1 FROM public.reivindicar_lembretes(999)"))).rows.length, 100);
});

test("segredo do agendador vem do Vault", async () => {
  const db = await banco();
  assert.equal(await comoPapel(db, "service_role", () => n(db, "SELECT public.segredo_cron()")), null);
  await db.query("INSERT INTO vault.decrypted_secrets VALUES ('bot_cron_secret','abc123')");
  assert.equal(await comoPapel(db, "service_role", () => n(db, "SELECT public.segredo_cron()")), "abc123");
});

test("agenda: compromisso e aviso juntos; desmarcar cancela o aviso pendente", async () => {
  const db = await banco();
  const sr = (q, p) => comoPapel(db, "service_role", () => db.query(q, p));
  await comoPapel(db, "anon", () => assert.rejects(() => db.query("SELECT * FROM public.compromissos"), /permission denied/));
  await comoPapel(db, "authenticated", () => assert.rejects(() => db.query("SELECT public.desmarcar_compromisso(gen_random_uuid())"), /permission denied/));
  const id = (await sr("SELECT public.criar_compromisso('dentista', now() + interval '1 day', now() + interval '22 hours', 'aviso') AS id")).rows[0].id;
  const c = (await db.query("SELECT * FROM public.compromissos WHERE id=$1", [id])).rows[0];
  assert.ok(c.aviso_lembrete_id, "aviso criado");
  assert.equal(await n(db, "SELECT texto FROM public.lembretes WHERE id=$1", [c.aviso_lembrete_id]), "aviso");
  // sem aviso
  const id2 = (await sr("SELECT public.criar_compromisso('jantar', now() + interval '2 days', NULL, '') AS id")).rows[0].id;
  assert.equal(await n(db, "SELECT aviso_lembrete_id FROM public.compromissos WHERE id=$1", [id2]), null);
  // aviso depois do inicio e recusado, sem deixar nada pela metade
  await assert.rejects(() => sr("SELECT public.criar_compromisso('x', now() + interval '1 hour', now() + interval '2 hours', 'a')"), /antes do compromisso/);
  assert.equal(await n(db, "SELECT count(*)::int FROM public.compromissos"), 2);
  assert.equal(await n(db, "SELECT count(*)::int FROM public.lembretes"), 1);
  // desmarcar
  assert.equal((await sr("SELECT public.desmarcar_compromisso($1) AS ok", [id])).rows[0].ok, true);
  assert.equal((await sr("SELECT public.desmarcar_compromisso($1) AS ok", [id])).rows[0].ok, false, "segunda vez: já desmarcado");
  assert.ok(await n(db, "SELECT cancelado_em FROM public.lembretes WHERE id=$1", [c.aviso_lembrete_id]), "aviso cancelado");
  // aviso ja enviado nao e alterado
  const id3 = (await sr("SELECT public.criar_compromisso('call', now() + interval '1 hour', now() - interval '1 min', 'a') AS id")).rows[0].id;
  await sr("SELECT * FROM public.reivindicar_lembretes(10)");
  await sr("SELECT public.desmarcar_compromisso($1)", [id3]);
  assert.equal(await n(db, "SELECT count(*)::int FROM public.lembretes WHERE enviado_em IS NOT NULL AND cancelado_em IS NULL"), 1);
});

test("google: id do evento guardado no compromisso", async () => {
  const db = await banco();
  const id = await comoPapel(db, "service_role", () => n(db, "SELECT public.criar_compromisso('x', now() + interval '1 day', NULL, '')"));
  await comoPapel(db, "service_role", () => db.query("UPDATE public.compromissos SET google_evento_id = 'ev123' WHERE id = $1", [id]));
  assert.equal(await n(db, "SELECT google_evento_id FROM public.compromissos WHERE id=$1", [id]), "ev123");
  await assert.rejects(() => db.query("UPDATE public.compromissos SET google_evento_id = $1", ["x".repeat(1025)]), /check/);
});

test("dia inteiro: aviso no próprio dia é aceito; depois do dia, recusado", async () => {
  const db = await banco();
  const sr = (q) => comoPapel(db, "service_role", () => db.query(q));
  const id = (await sr("SELECT public.criar_compromisso('festa', date_trunc('day', now()) + interval '2 days', date_trunc('day', now()) + interval '2 days 8 hours', 'aviso', true) AS id")).rows[0].id;
  assert.equal(await n(db, "SELECT dia_inteiro FROM public.compromissos WHERE id=$1", [id]), true);
  await assert.rejects(() => sr("SELECT public.criar_compromisso('x', date_trunc('day', now()) + interval '2 days', date_trunc('day', now()) + interval '3 days', 'a', true)"), /antes do compromisso/);
  // com horario continua exigindo aviso antes do inicio (parametro novo e opcional)
  await assert.rejects(() => sr("SELECT public.criar_compromisso('y', now() + interval '1 hour', now() + interval '2 hours', 'a')"), /antes do compromisso/);
  await comoPapel(db, "anon", () => assert.rejects(() => db.query("SELECT public.criar_compromisso('z', now(), NULL, '', true)"), /permission denied/));
});

test("tarefas: só para o service_role; texto obrigatório", async () => {
  const db = await banco();
  for (const papel of ["anon", "authenticated"]) await comoPapel(db, papel, () => assert.rejects(() => db.query("SELECT * FROM public.tarefas"), /permission denied/));
  await comoPapel(db, "service_role", async () => {
    await db.query("INSERT INTO public.tarefas(texto, prazo) VALUES ('comprar tinta', '2026-11-12')");
    await assert.rejects(() => db.query("INSERT INTO public.tarefas(texto) VALUES ('  ')"), /check/);
  });
  assert.equal(await n(db, "SELECT prazo::text FROM public.tarefas"), "2026-11-12");
});
