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
  const sql = readFileSync(new URL("../supabase/migrations/0001_inicial.sql", import.meta.url), "utf8");
  await db.exec(sql);
  await db.exec(sql); // reaplicar nao quebra
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
