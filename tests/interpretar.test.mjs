// node --test tests/  (Node 22.18+ executa os .ts diretamente)
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretar, formatarQuando, paraLocal, deLocal } from "../supabase/functions/telegram-bot/interpretar.ts";

// Quinta-feira, 30/10/2026, 10:00 em Fortaleza (13:00 UTC).
const AGORA = new Date("2026-10-30T13:00:00Z");
const local = (d) => { const l = paraLocal(d); return `${l.ano}-${String(l.mes + 1).padStart(2, "0")}-${String(l.dia).padStart(2, "0")} ${String(l.hora).padStart(2, "0")}:${String(l.min).padStart(2, "0")}`; };
const lembrar = (msg, agora = AGORA) => {
  const c = interpretar(msg, agora);
  assert.equal(c.tipo, "lembrar", `${msg} -> ${JSON.stringify(c)}`);
  return { quando: local(c.quando), texto: c.texto };
};

test("fuso de Fortaleza (UTC-3, sem horario de verao)", () => {
  assert.equal(local(AGORA), "2026-10-30 10:00");
  assert.equal(deLocal(2026, 0, 15, 12, 0).toISOString(), "2026-01-15T15:00:00.000Z");
  assert.equal(formatarQuando(AGORA), "sex 30/10 às 10:00");
});

test("tempo relativo", () => {
  assert.deepEqual(lembrar("lembrar em 30 min tirar o bolo"), { quando: "2026-10-30 10:30", texto: "tirar o bolo" });
  assert.deepEqual(lembrar("lembrar em 2 horas de ligar"), { quando: "2026-10-30 12:00", texto: "ligar" });
  assert.deepEqual(lembrar("me lembra daqui a 3 dias renovar"), { quando: "2026-11-02 10:00", texto: "renovar" });
  assert.deepEqual(lembrar("lembrar em 10min café"), { quando: "2026-10-30 10:10", texto: "café" });
  assert.deepEqual(lembrar("lembrar em meia hora sair"), { quando: "2026-10-30 10:30", texto: "sair" });
  assert.deepEqual(lembrar("lembrar em uma semana revisar"), { quando: "2026-11-06 10:00", texto: "revisar" });
});

test("dias e horarios", () => {
  assert.deepEqual(lembrar("lembrar amanhã às 8h pagar a conta"), { quando: "2026-10-31 08:00", texto: "pagar a conta" });
  assert.deepEqual(lembrar("Lembrar AMANHA 8h30 Pagar"), { quando: "2026-10-31 08:30", texto: "Pagar" });
  assert.deepEqual(lembrar("lembrar hoje 18:45 academia"), { quando: "2026-10-30 18:45", texto: "academia" });
  assert.deepEqual(lembrar("lembrar hoje às 20 jantar"), { quando: "2026-10-30 20:00", texto: "jantar" });
  assert.deepEqual(lembrar("lembrar depois de amanhã meio-dia almoço"), { quando: "2026-11-01 12:00", texto: "almoço" });
  assert.deepEqual(lembrar("me lembre de amanhã levar o carro"), { quando: "2026-10-31 09:00", texto: "levar o carro" });
  assert.deepEqual(lembrar("/lembrar@meu_bot amanhã 7h acordar"), { quando: "2026-10-31 07:00", texto: "acordar" });
});

test("dias da semana", () => {
  assert.deepEqual(lembrar("lembrar segunda 9h reunião"), { quando: "2026-11-02 09:00", texto: "reunião" });
  assert.deepEqual(lembrar("lembrar segunda-feira às 14h30 médico"), { quando: "2026-11-02 14:30", texto: "médico" });
  // Hoje e sexta: mais tarde hoje vale hoje; mais cedo vai para a proxima semana.
  assert.deepEqual(lembrar("lembrar sexta 15h feira"), { quando: "2026-10-30 15:00", texto: "feira" });
  assert.deepEqual(lembrar("lembrar sexta 8h feira"), { quando: "2026-11-06 08:00", texto: "feira" });
  assert.deepEqual(lembrar("lembrar sáb aniversário"), { quando: "2026-10-31 09:00", texto: "aniversário" });
});

test("datas", () => {
  assert.deepEqual(lembrar("lembrar 15/11 aniversário da Ana"), { quando: "2026-11-15 09:00", texto: "aniversário da Ana" });
  assert.deepEqual(lembrar("lembrar 01/02 às 10h IPVA"), { quando: "2027-02-01 10:00", texto: "IPVA" });
  assert.deepEqual(lembrar("lembrar 5/3/2027 16h prova"), { quando: "2027-03-05 16:00", texto: "prova" });
  assert.deepEqual(lembrar("lembrar 30/10 23:00 hoje mesmo"), { quando: "2026-10-30 23:00", texto: "hoje mesmo" });
});

test("so o horario: hoje se ainda vai acontecer, senao amanha", () => {
  assert.deepEqual(lembrar("lembrar às 15h buscar"), { quando: "2026-10-30 15:00", texto: "buscar" });
  assert.deepEqual(lembrar("lembrar 7h correr"), { quando: "2026-10-31 07:00", texto: "correr" });
});

test("erros explicados", () => {
  const erro = (msg) => { const c = interpretar(msg, AGORA); assert.equal(c.tipo, "erro", `${msg} -> ${JSON.stringify(c)}`); return c.mensagem; };
  assert.match(erro("lembrar pagar a conta"), /Não entendi quando/);
  assert.match(erro("lembrar hoje 8h algo"), /já passou/);
  assert.match(erro("lembrar 31/02 algo"), /Data inválida/);
  assert.match(erro("lembrar amanhã 8h"), /Faltou dizer/);
  assert.match(erro("lembrar 01/01/2030 algo"), /2 anos/);
  assert.match(erro("lembrar amanhã " + "x".repeat(501)), /500/);
  assert.match(erro("lembrar em 0 min algo"), /Não entendi quando/);
  assert.match(erro("lembrar hoje 25h algo"), /Faltou dizer|Não entendi|passou/);
});

test("notas e listas", () => {
  assert.deepEqual(interpretar("nota comprar filtro de café", AGORA), { tipo: "nota", texto: "comprar filtro de café" });
  assert.deepEqual(interpretar("Anota: senha do wi-fi da casa", AGORA), { tipo: "nota", texto: "senha do wi-fi da casa" });
  assert.deepEqual(interpretar("/notas", AGORA), { tipo: "notas" });
  assert.deepEqual(interpretar("buscar Café forte", AGORA), { tipo: "buscar", termo: "Café forte" });
  assert.deepEqual(interpretar("apagar 3", AGORA), { tipo: "apagar", numero: 3 });
  assert.deepEqual(interpretar("/lembretes", AGORA), { tipo: "lembretes" });
  assert.deepEqual(interpretar("cancelar 2", AGORA), { tipo: "cancelar", numero: 2 });
  assert.equal(interpretar("cancelar dois", AGORA).tipo, "erro");
  assert.equal(interpretar("nota", AGORA).tipo, "erro");
  assert.deepEqual(interpretar("/start", AGORA), { tipo: "ajuda" });
  assert.deepEqual(interpretar("bom dia", AGORA), { tipo: "desconhecido" });
});
