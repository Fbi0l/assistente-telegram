// Ponto de entrada da Edge Function: liga o handler ao Supabase e a API do Telegram.
// Publicar SEM verificacao de JWT (o Telegram nao envia JWT; a autenticacao e feita no handler):
//   npx.cmd supabase@latest functions deploy telegram-bot --no-verify-jwt
// Segredos da funcao (painel do Supabase > Edge Functions > Secrets):
//   TELEGRAM_BOT_TOKEN  token dado pelo @BotFather
//   TELEGRAM_CHAT_ID    seu id numerico do Telegram (o bot so atende esse id)
//   GOOGLE_SERVICE_ACCOUNT, GOOGLE_CALENDAR_ID  (opcionais) sincronizacao com o Google Agenda
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";
import type { Banco } from "./bot.ts";
import { criarHandler } from "./handler.ts";
import { criarAgendaGoogle } from "./google.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});
const tokenBot = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

const falhou = (o: string, e: { message: string } | null) => {
  if (e) throw new Error(`${o}: ${e.message}`);
};
const lembrete = (r: { id: string; texto: string; quando: string }) => ({ id: r.id, texto: r.texto, quando: new Date(r.quando) });
const nota = (r: { id: string; texto: string; criado_em: string }) => ({ id: r.id, texto: r.texto, criado_em: new Date(r.criado_em) });
const compromisso = (r: { id: string; titulo: string; inicio: string; google_evento_id: string | null; dia_inteiro: boolean }) =>
  ({ id: r.id, titulo: r.titulo, inicio: new Date(r.inicio), googleId: r.google_evento_id, diaInteiro: r.dia_inteiro === true });
const COLUNAS_COMPROMISSO = "id,titulo,inicio,google_evento_id,dia_inteiro";

const banco: Banco = {
  async criarLembrete(quando, texto) {
    const { error } = await db.from("lembretes").insert({ quando: quando.toISOString(), texto });
    falhou("criar lembrete", error);
  },
  async lembretesPendentes(limite) {
    const { data, error } = await db.from("lembretes").select("id,texto,quando")
      .is("enviado_em", null).is("cancelado_em", null).order("quando").limit(limite);
    falhou("listar lembretes", error);
    return (data ?? []).map(lembrete);
  },
  async cancelarLembrete(id) {
    const { data, error } = await db.from("lembretes").update({ cancelado_em: new Date().toISOString() })
      .eq("id", id).is("enviado_em", null).is("cancelado_em", null).select("id");
    falhou("cancelar lembrete", error);
    return (data ?? []).length === 1;
  },
  async criarNota(texto) {
    const { error } = await db.from("notas").insert({ texto });
    falhou("criar nota", error);
  },
  async notasRecentes(limite) {
    const { data, error } = await db.from("notas").select("id,texto,criado_em")
      .order("criado_em", { ascending: false }).order("id").limit(limite);
    falhou("listar notas", error);
    return (data ?? []).map(nota);
  },
  async buscarNotas(termo, limite) {
    const padrao = `%${termo.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const { data, error } = await db.from("notas").select("id,texto,criado_em")
      .ilike("texto", padrao).order("criado_em", { ascending: false }).limit(limite);
    falhou("buscar notas", error);
    return (data ?? []).map(nota);
  },
  async apagarNota(id) {
    const { data, error } = await db.from("notas").delete().eq("id", id).select("id");
    falhou("apagar nota", error);
    return (data ?? []).length === 1;
  },
  async reivindicarLembretes(limite) {
    const { data, error } = await db.rpc("reivindicar_lembretes", { p_limite: limite });
    falhou("reivindicar lembretes", error);
    return (data ?? []).map(lembrete);
  },
  async liberarLembrete(id) {
    const { error } = await db.rpc("liberar_lembrete", { p_id: id });
    falhou("liberar lembrete", error);
  },
  async criarCompromisso(inicio, titulo, avisoEm, textoAviso, diaInteiro) {
    const { data, error } = await db.rpc("criar_compromisso", {
      p_titulo: titulo, p_inicio: inicio.toISOString(), p_aviso_em: avisoEm ? avisoEm.toISOString() : null, p_texto_aviso: textoAviso,
      p_dia_inteiro: diaInteiro,
    });
    falhou("criar compromisso", error);
    return String(data);
  },
  async definirEventoGoogle(id, eventoId) {
    const { error } = await db.from("compromissos").update({ google_evento_id: eventoId }).eq("id", id);
    falhou("guardar evento do Google", error);
  },
  async compromissosEntre(de, ate) {
    const { data, error } = await db.from("compromissos").select(COLUNAS_COMPROMISSO).is("cancelado_em", null)
      .gte("inicio", de.toISOString()).lt("inicio", ate.toISOString()).order("inicio").order("id").limit(100);
    falhou("listar agenda", error);
    return (data ?? []).map(compromisso);
  },
  async proximosCompromissos(desde, limite) {
    // Os de dia inteiro comecam a meia-noite: os de hoje continuam na lista.
    const ontem = new Date(desde.getTime() - 86400000).toISOString();
    const { data, error } = await db.from("compromissos").select(COLUNAS_COMPROMISSO).is("cancelado_em", null)
      .or(`inicio.gte.${desde.toISOString()},and(dia_inteiro.is.true,inicio.gt.${ontem})`)
      .order("inicio").order("id").limit(limite);
    falhou("listar compromissos", error);
    return (data ?? []).map(compromisso);
  },
  async desmarcarCompromisso(id) {
    const { data, error } = await db.rpc("desmarcar_compromisso", { p_id: id });
    falhou("desmarcar compromisso", error);
    return data === true;
  },
};

async function telegram(metodo: string, corpo: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${tokenBot}/${metodo}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(8000),
    });
    const res = await r.json().catch(() => ({}));
    if (!res.ok) console.error("Telegram recusou", metodo, r.status, res.description ?? "");
    return res.ok === true;
  } catch (e) {
    console.error("Telegram indisponível", metodo, e instanceof Error ? e.message : String(e));
    return false;
  }
}

Deno.serve(criarHandler({
  banco,
  tokenBot,
  donoId: Deno.env.get("TELEGRAM_CHAT_ID") ?? "",
  urlFuncao: `${url}/functions/v1/telegram-bot`,
  segredoCron: async () => {
    const { data, error } = await db.rpc("segredo_cron");
    if (error) console.error("Segredo do agendador indisponível", error.message);
    return typeof data === "string" ? data : null;
  },
  telegram,
  google: criarAgendaGoogle({
    credencialJson: Deno.env.get("GOOGLE_SERVICE_ACCOUNT") ?? "",
    calendarioId: Deno.env.get("GOOGLE_CALENDAR_ID") ?? "",
  }),
}));
