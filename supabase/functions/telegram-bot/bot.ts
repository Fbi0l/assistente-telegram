// Logica do assistente: transforma comandos em acoes e respostas.
// Nao conhece o Telegram nem o Supabase diretamente (recebe "banco" e "enviar"), para ser testavel.
import { formatarDia, formatarDiaInteiro, formatarDuracao, formatarHora, formatarQuando, interpretar, normalizar, type Comando } from "./interpretar.ts";
import { ErroGoogle, type AgendaExterna } from "./google.ts";
import type { TarefasExternas } from "./tarefas_google.ts";

export type Lembrete = { id: string; texto: string; quando: Date };
export type Nota = { id: string; texto: string; criado_em: Date };
export type Compromisso = { id: string; titulo: string; inicio: Date; googleId?: string | null; diaInteiro?: boolean };
export type Tarefa = { id: string; texto: string; prazo: Date | null; googleId?: string | null };

export interface Banco {
  criarLembrete(quando: Date, texto: string): Promise<void>;
  lembretesPendentes(limite: number): Promise<Lembrete[]>; // ordem: quando crescente
  cancelarLembrete(id: string): Promise<boolean>;
  criarNota(texto: string): Promise<void>;
  notasRecentes(limite: number): Promise<Nota[]>; // ordem: mais recente primeiro
  buscarNotas(termo: string, limite: number): Promise<Nota[]>;
  apagarNota(id: string): Promise<boolean>;
  reivindicarLembretes(limite: number): Promise<Lembrete[]>; // marca como enviados (atomico)
  liberarLembrete(id: string): Promise<void>; // envio falhou: tenta de novo no proximo minuto
  // Agenda: o aviso do compromisso e um lembrete criado na mesma transacao.
  criarCompromisso(inicio: Date, titulo: string, avisoEm: Date | null, textoAviso: string, diaInteiro: boolean): Promise<string>; // devolve o id
  definirEventoGoogle(id: string, eventoId: string): Promise<void>;
  compromissosEntre(de: Date, ate: Date): Promise<Compromisso[]>; // ordem: inicio crescente
  proximosCompromissos(desde: Date, limite: number): Promise<Compromisso[]>; // inclui os de dia inteiro de hoje
  desmarcarCompromisso(id: string): Promise<boolean>; // tambem cancela o aviso ainda nao enviado
  // Tarefas: sem horario, com prazo opcional.
  criarTarefa(texto: string, prazo: Date | null): Promise<string>; // devolve o id
  definirTarefaGoogle(id: string, googleId: string): Promise<void>;
  tarefasPendentes(limite: number): Promise<Tarefa[]>; // ordem: prazo (sem prazo por ultimo), depois criacao
  concluirTarefa(id: string): Promise<boolean>;
}

export const LISTA_MAX = 20;
export const LOTE_MAX = 20; // comandos por mensagem (um por linha)
const TELEGRAM_MAX = 4000;
// Na mensagem com varias linhas, estes ficam de fora: os numeros da lista mudam a cada um.
const SO_UM_POR_VEZ = new Set(["cancelar", "apagar", "desmarcar", "feito"]);
const NOTA = /^\/?(nota|anota|anotar|anote):?$/;

export const AJUDA = [
  "Sou seu assistente. O que eu entendo:",
  "",
  "LEMBRETES",
  "lembrar em 30 min tirar o bolo",
  "lembrar amanhã às 8h pagar a conta",
  "lembrar sexta 14h30 reunião",
  "lembrar 15/11 aniversário da Ana (sem hora = 9h)",
  "/lembretes — lista os próximos",
  "cancelar 2 — cancela o nº 2 da lista",
  "",
  "AGENDA (aviso 2h antes)",
  "agendar sexta 14h reunião com João",
  "agendar amanhã 10h dentista avisar 30 min antes",
  "agendar 20/11 19h jantar sem aviso",
  "agendar 12/11 festa (sem hora = dia todo, aviso às 8h)",
  "/agenda — hoje · agenda amanhã · agenda semana",
  "/compromissos — próximos · desmarcar 2",
  "/google — confere a ligação com o Google Agenda e Tarefas",
  "",
  "TAREFAS",
  "tarefa comprar tinta",
  "tarefa sexta pagar boleto (com prazo)",
  "/tarefas — lista · feito 2 — conclui a nº 2",
  "",
  "ANOTAÇÕES",
  "nota comprar filtro de café",
  "/notas — últimas notas",
  "buscar café — procura nas notas",
  "apagar 3 — apaga a nº 3 de /notas",
  "",
  "Vários de uma vez: um comando por linha na mesma mensagem.",
].join("\n");

const numerada = (itens: string[]) => itens.map((t, i) => `${i + 1}. ${t}`).join("\n");

// Compromissos agrupados por dia; o numero e a posicao em /compromissos (usado por "desmarcar N").
// Itens do Google Agenda (criados direto la) aparecem com "•" e nao podem ser desmarcados pelo bot.
type ItemAgenda = { id: string; titulo: string; inicio: Date; diaInteiro?: boolean };
const DURACAO_PADRAO_MIN = 60;
const AVISO_DIA_INTEIRO_MIN = 8 * 60; // compromisso de dia inteiro: aviso as 8h
const paraDia = (d: Date) => formatarDia(d);
const JANELA_GOOGLE_DIAS = 30;
const NOTA_GOOGLE = "• = do Google Agenda (altere por lá)";

function listarAgenda(itens: ItemAgenda[], numeroDe: Map<string, number>): string {
  const linhas: string[] = [];
  let diaAtual = "";
  for (const c of itens) {
    const dia = formatarDia(c.inicio);
    if (dia !== diaAtual) { if (linhas.length) linhas.push(""); linhas.push(dia); diaAtual = dia; }
    const n = numeroDe.get(c.id);
    linhas.push(`${n ? `${n}.` : "•"} ${c.diaInteiro ? "dia todo" : formatarHora(c.inicio)} — ${c.titulo}`);
  }
  return linhas.join("\n");
}

const porInicio = (a: ItemAgenda, b: ItemAgenda) => a.inicio.getTime() - b.inicio.getTime();

export function criarBot(
  banco: Banco,
  agora: () => Date = () => new Date(),
  google: AgendaExterna | null = null,
  log: (...a: unknown[]) => void = console.error,
  tarefasGoogle: TarefasExternas | null = null,
) {
  const motivo = (e: unknown) => (e instanceof ErroGoogle ? e.message : "o Google Agenda não respondeu.");

  // Eventos do Google no intervalo; falha vira aviso no rodape, sem derrubar a resposta.
  async function doGoogle(de: Date, ate: Date): Promise<{ itens: ItemAgenda[]; aviso: string }> {
    if (!google) return { itens: [], aviso: "" };
    try {
      return { itens: (await google.listar(de, ate)).map((e) => ({ ...e, id: `google:${e.id}` })), aviso: "" };
    } catch (e) {
      log("Google Agenda (listar)", e instanceof Error ? e.message : String(e));
      return { itens: [], aviso: `(Não consegui ler o Google Agenda: ${motivo(e)})` };
    }
  }
  async function doGoogleTarefas(): Promise<{ itens: Awaited<ReturnType<TarefasExternas["listar"]>>; aviso: string }> {
    if (!tarefasGoogle) return { itens: [], aviso: "" };
    try { return { itens: (await tarefasGoogle.listar()).slice(0, LISTA_MAX), aviso: "" }; }
    catch (e) {
      log("Google Tarefas (listar)", e instanceof Error ? e.message : String(e));
      return { itens: [], aviso: `(Não consegui ler o Google Tarefas: ${motivo(e)})` };
    }
  }
  const rodape = (itens: ItemAgenda[], aviso: string) =>
    [itens.some((x) => x.id.startsWith("google:")) ? NOTA_GOOGLE : "", aviso].filter(Boolean).map((t) => `\n\n${t}`).join("");

  // Varias linhas com comandos: executa um por linha, na ordem. Nota com varias linhas continua sendo uma nota so.
  async function tratar(mensagem: string): Promise<string> {
    const momento = agora();
    const linhas = mensagem.split(/\r?\n/).map((l) => l.trim().replace(/^[-•]\s+/, "").replace(/^\*+|\*+$/g, "").trim()).filter(Boolean);
    const primeira = normalizar(linhas[0]?.split(/\s+/)[0] ?? "");
    if (linhas.length < 2 || NOTA.test(primeira)) return executar(interpretar(mensagem, momento), momento);
    const comandos = linhas.map((l) => ({ linha: l, c: interpretar(l, momento) }));
    if (comandos.filter((x) => x.c.tipo !== "desconhecido").length < 2) return executar(interpretar(mensagem, momento), momento);
    if (linhas.length > LOTE_MAX) return `Mande até ${LOTE_MAX} comandos por mensagem (um por linha).`;
    const respostas: string[] = [];
    for (const { linha, c } of comandos) {
      if (c.tipo === "desconhecido") { respostas.push(`Não entendi: "${linha.slice(0, 80)}"`); continue; }
      if (c.tipo === "erro") { respostas.push(`"${linha.slice(0, 80)}": ${c.mensagem}`); continue; }
      if (SO_UM_POR_VEZ.has(c.tipo)) { respostas.push(`"${linha.slice(0, 80)}": mande este sozinho (os números da lista mudam a cada um).`); continue; }
      try { respostas.push(await executar(c, momento)); }
      catch (e) {
        log("Falha em comando do lote", e instanceof Error ? e.message : String(e));
        respostas.push(`Tive um problema com: "${linha.slice(0, 80)}". Tente de novo.`);
      }
    }
    const texto = respostas.join("\n\n");
    return texto.length > TELEGRAM_MAX ? texto.slice(0, TELEGRAM_MAX - 20) + "\n\n(resposta cortada)" : texto;
  }

  async function executar(c: Comando, momento: Date): Promise<string> {
    switch (c.tipo) {
      case "ajuda":
        return AJUDA;
      case "erro":
        return c.mensagem;
      case "desconhecido":
        return "Não entendi. Mande /ajuda para ver o que eu faço.";
      case "lembrar":
        await banco.criarLembrete(c.quando, c.texto);
        return `Combinado! Vou te lembrar ${formatarQuando(c.quando)}:\n${c.texto}`;
      case "lembretes": {
        const l = await banco.lembretesPendentes(LISTA_MAX);
        if (!l.length) return "Nenhum lembrete marcado.";
        return "Próximos lembretes:\n" + numerada(l.map((x) => `${formatarQuando(x.quando)} — ${x.texto}`));
      }
      case "cancelar": {
        const l = await banco.lembretesPendentes(LISTA_MAX);
        const alvo = l[c.numero - 1];
        if (!alvo) return `Não há lembrete nº ${c.numero}. Veja a lista em /lembretes.`;
        return (await banco.cancelarLembrete(alvo.id))
          ? `Cancelado: ${alvo.texto} (${formatarQuando(alvo.quando)})`
          : "Esse lembrete já foi enviado ou cancelado.";
      }
      case "nota":
        await banco.criarNota(c.texto);
        return "Anotado.";
      case "notas": {
        const n = await banco.notasRecentes(LISTA_MAX);
        if (!n.length) return "Nenhuma nota ainda. Ex.: nota comprar filtro de café";
        return "Suas notas (mais recentes primeiro):\n" + numerada(n.map((x) => x.texto));
      }
      case "buscar": {
        const n = await banco.buscarNotas(c.termo, LISTA_MAX);
        if (!n.length) return `Nada encontrado para "${c.termo}".`;
        return `Notas com "${c.termo}":\n` + numerada(n.map((x) => x.texto));
      }
      case "apagar": {
        const n = await banco.notasRecentes(LISTA_MAX);
        const alvo = n[c.numero - 1];
        if (!alvo) return `Não há nota nº ${c.numero}. Veja a lista em /notas.`;
        return (await banco.apagarNota(alvo.id)) ? `Apagada: ${alvo.texto}` : "Essa nota já tinha sido apagada.";
      }
      case "agendar": {
        // Dia inteiro: o aviso conta a partir das 8h do dia (padrao: no proprio dia, as 8h).
        const base = c.diaInteiro ? c.inicio.getTime() + AVISO_DIA_INTEIRO_MIN * 60000 : c.inicio.getTime();
        const quandoTexto = c.diaInteiro ? formatarDiaInteiro(c.inicio) : formatarQuando(c.inicio);
        let avisoEm: Date | null = null, sobreAviso = "Sem aviso.";
        if (c.avisoMin !== null) {
          const quando = new Date(base - c.avisoMin * 60000);
          if (quando > momento) {
            avisoEm = quando;
            sobreAviso = c.diaInteiro ? `Aviso ${formatarQuando(quando)}.` : `Aviso ${formatarDuracao(c.avisoMin)} antes.`;
          } else sobreAviso = c.diaInteiro ? "Sem aviso: o horário do aviso já passou." : `Sem aviso: faltam menos de ${formatarDuracao(c.avisoMin)}.`;
        }
        const textoAviso = c.diaInteiro
          ? `${avisoEm && paraDia(avisoEm) === paraDia(c.inicio) ? "hoje" : formatarDia(c.inicio)}: ${c.titulo} (dia todo)`
          : `daqui a ${c.avisoMin === null ? "" : formatarDuracao(c.avisoMin)}: ${c.titulo} (${formatarQuando(c.inicio)})`;
        const id = await banco.criarCompromisso(c.inicio, c.titulo, avisoEm, textoAviso, c.diaInteiro);
        let sobreGoogle = "";
        if (google) {
          try {
            const evento = c.diaInteiro
              ? await google.criar(c.titulo, c.inicio, new Date(c.inicio.getTime() + 86400000), true)
              : await google.criar(c.titulo, c.inicio, new Date(c.inicio.getTime() + DURACAO_PADRAO_MIN * 60000));
            await banco.definirEventoGoogle(id, evento);
            sobreGoogle = "\nNo Google Agenda também.";
          } catch (e) {
            log("Google Agenda (criar)", e instanceof Error ? e.message : String(e));
            sobreGoogle = `\nFicou só aqui: não consegui pôr no Google Agenda (${motivo(e)})`;
          }
        }
        return `Agendado: ${c.titulo}\n${quandoTexto}. ${sobreAviso}${sobreGoogle}`;
      }
      case "compromissos": {
        const [p, g] = await Promise.all([
          banco.proximosCompromissos(momento, LISTA_MAX),
          doGoogle(momento, new Date(momento.getTime() + JANELA_GOOGLE_DIAS * 86400000)),
        ]);
        const itens = [...p, ...g.itens].sort(porInicio).slice(0, LISTA_MAX + 10);
        if (!itens.length) return "Nenhum compromisso marcado." + rodape(itens, g.aviso);
        return "Próximos compromissos:\n" + listarAgenda(itens, new Map(p.map((x, i) => [x.id, i + 1]))) + rodape(itens, g.aviso);
      }
      case "agenda": {
        const [doBanco, proximos, g] = await Promise.all([
          banco.compromissosEntre(c.de, c.ate),
          banco.proximosCompromissos(momento, LISTA_MAX),
          doGoogle(c.de, c.ate),
        ]);
        const itens = [...doBanco, ...g.itens].sort(porInicio);
        if (!itens.length) return `${c.rotulo}: nenhum compromisso.` + rodape(itens, g.aviso);
        return `${c.rotulo}:\n` + listarAgenda(itens, new Map(proximos.map((x, i) => [x.id, i + 1]))) + rodape(itens, g.aviso);
      }
      case "desmarcar": {
        const p = await banco.proximosCompromissos(momento, LISTA_MAX);
        const alvo = p[c.numero - 1];
        if (!alvo) return `Não há compromisso nº ${c.numero}. Veja a lista em /compromissos.`;
        if (!(await banco.desmarcarCompromisso(alvo.id))) return "Esse compromisso já tinha sido desmarcado.";
        let sobreGoogle = "";
        if (google && alvo.googleId) {
          try { await google.apagar(alvo.googleId); sobreGoogle = "\nTirei do Google Agenda também."; }
          catch (e) {
            log("Google Agenda (apagar)", e instanceof Error ? e.message : String(e));
            sobreGoogle = `\nNão consegui tirar do Google Agenda (${motivo(e)}) Apague por lá.`;
          }
        }
        return `Desmarcado: ${alvo.titulo} (${alvo.diaInteiro ? formatarDiaInteiro(alvo.inicio) : formatarQuando(alvo.inicio)})${sobreGoogle}`;
      }
      case "tarefa": {
        const id = await banco.criarTarefa(c.texto, c.prazo);
        let sobreGoogle = "";
        if (tarefasGoogle) {
          try { await banco.definirTarefaGoogle(id, await tarefasGoogle.criar(c.texto, c.prazo)); sobreGoogle = "\nNo Google Tarefas também."; }
          catch (e) {
            log("Google Tarefas (criar)", e instanceof Error ? e.message : String(e));
            sobreGoogle = `\nFicou só aqui: não consegui pôr no Google Tarefas (${motivo(e)})`;
          }
        }
        return `Tarefa anotada: ${c.texto}${c.prazo ? `\nPrazo: ${formatarDia(c.prazo)}.` : ""}${sobreGoogle}`;
      }
      case "tarefas": {
        const [doBanco, g] = await Promise.all([banco.tarefasPendentes(LISTA_MAX), doGoogleTarefas()]);
        const linha = (t: { texto: string; prazo: Date | null }) => `${t.texto}${t.prazo ? ` — até ${formatarDia(t.prazo)}` : ""}`;
        const linhas = doBanco.map((t, i) => `${i + 1}. ${linha(t)}`).concat(g.itens.map((t) => `• ${linha({ texto: t.titulo, prazo: t.prazo })}`));
        const rodapeT = [g.itens.length ? "• = do Google Tarefas (conclua por lá)" : "", g.aviso].filter(Boolean).map((t) => `\n\n${t}`).join("");
        if (!linhas.length) return "Nenhuma tarefa pendente. Ex.: tarefa comprar tinta" + rodapeT;
        return "Tarefas:\n" + linhas.join("\n") + rodapeT;
      }
      case "feito": {
        const p = await banco.tarefasPendentes(LISTA_MAX);
        const alvo = p[c.numero - 1];
        if (!alvo) return `Não há tarefa nº ${c.numero}. Veja a lista em /tarefas.`;
        if (!(await banco.concluirTarefa(alvo.id))) return "Essa tarefa já estava concluída.";
        let sobreGoogle = "";
        if (tarefasGoogle && alvo.googleId) {
          try { await tarefasGoogle.concluir(alvo.googleId); sobreGoogle = "\nConcluída no Google Tarefas também."; }
          catch (e) {
            log("Google Tarefas (concluir)", e instanceof Error ? e.message : String(e));
            sobreGoogle = `\nNão consegui concluir no Google Tarefas (${motivo(e)}) Marque por lá.`;
          }
        }
        return `Feita: ${alvo.texto}${sobreGoogle}`;
      }
      case "google": {
        let agenda: string, tarefas: string;
        if (!google) agenda = "Google Agenda não configurado. Crie os segredos GOOGLE_SERVICE_ACCOUNT e GOOGLE_CALENDAR_ID na função do Supabase.";
        else try {
          const n = (await google.listar(momento, new Date(momento.getTime() + 7 * 86400000))).length;
          agenda = `Google Agenda conectado. ${n === 1 ? "1 evento" : `${n} eventos`} nos próximos 7 dias (sem contar os marcados por mim).`;
        } catch (e) {
          log("Google Agenda (teste)", e instanceof Error ? e.message : String(e));
          agenda = `Não consegui acessar o Google Agenda: ${motivo(e)}`;
        }
        if (!tarefasGoogle) tarefas = "Google Tarefas ainda não ligado (opcional).";
        else try {
          const n = (await tarefasGoogle.listar()).length;
          tarefas = `Google Tarefas conectado. ${n === 1 ? "1 tarefa pendente" : `${n} tarefas pendentes`} criadas por lá.`;
        } catch (e) {
          log("Google Tarefas (teste)", e instanceof Error ? e.message : String(e));
          tarefas = `Não consegui acessar o Google Tarefas: ${motivo(e)}`;
        }
        return `${agenda}\n${tarefas}`;
      }
    }
  }

  // Chamado a cada minuto: envia os lembretes vencidos.
  async function disparar(enviar: (texto: string) => Promise<boolean>): Promise<{ enviados: number; falhas: number }> {
    const vencidos = await banco.reivindicarLembretes(20);
    let enviados = 0, falhas = 0;
    for (const l of vencidos) {
      let ok = false;
      try { ok = await enviar(`Lembrete: ${l.texto}`); } catch { ok = false; }
      if (ok) enviados++;
      else { falhas++; await banco.liberarLembrete(l.id); }
    }
    return { enviados, falhas };
  }

  return { tratar, disparar };
}
