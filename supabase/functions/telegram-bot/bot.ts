// Logica do assistente: transforma comandos em acoes e respostas.
// Nao conhece o Telegram nem o Supabase diretamente (recebe "banco" e "enviar"), para ser testavel.
import { formatarQuando, interpretar } from "./interpretar.ts";

export type Lembrete = { id: string; texto: string; quando: Date };
export type Nota = { id: string; texto: string; criado_em: Date };

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
}

export const LISTA_MAX = 20;

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
  "ANOTAÇÕES",
  "nota comprar filtro de café",
  "/notas — últimas notas",
  "buscar café — procura nas notas",
  "apagar 3 — apaga a nº 3 de /notas",
].join("\n");

const numerada = (itens: string[]) => itens.map((t, i) => `${i + 1}. ${t}`).join("\n");

export function criarBot(banco: Banco, agora: () => Date = () => new Date()) {
  async function tratar(mensagem: string): Promise<string> {
    const c = interpretar(mensagem, agora());
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
