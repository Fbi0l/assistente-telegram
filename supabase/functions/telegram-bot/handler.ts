// Recebe as chamadas HTTP da funcao. Tres origens, cada uma com sua prova de identidade:
//  1. Telegram (mensagens): cabecalho X-Telegram-Bot-Api-Secret-Token = segredo derivado do token do bot.
//  2. Agendador do banco (pg_cron, a cada minuto): cabecalho x-cron-secret = segredo guardado no Vault.
//     Corpo {"acao":"disparar"} envia lembretes; {"acao":"registrar_webhook"} liga o bot ao Telegram.
//  3. Qualquer outra coisa: 401.
// So mensagens privadas do dono (TELEGRAM_CHAT_ID) sao atendidas; as demais sao ignoradas em silencio.
import { criarBot, type Banco } from "./bot.ts";

export type Dependencias = {
  banco: Banco;
  tokenBot: string;
  donoId: string;
  urlFuncao: string;
  segredoCron: () => Promise<string | null>;
  telegram: (metodo: string, corpo: Record<string, unknown>) => Promise<boolean>;
  agora?: () => Date;
  log?: (...a: unknown[]) => void;
};

// Segredo do webhook derivado do token: nada a mais para configurar, e muda se o token mudar.
export async function segredoWebhook(tokenBot: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`webhook:${tokenBot}`));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Comparacao em tempo constante (nao revela quantos caracteres acertou).
export function iguais(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let dif = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) dif |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return dif === 0;
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export function criarHandler(dep: Dependencias) {
  const log = dep.log ?? console.error;
  const bot = criarBot(dep.banco, dep.agora);
  const enviarAoDono = (texto: string) => dep.telegram("sendMessage", { chat_id: dep.donoId, text: texto });

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ erro: "Método não permitido." }, 405);
    if (!dep.tokenBot || !/^\d+$/.test(dep.donoId)) return json({ erro: "Bot não configurado." }, 500);

    const tgSegredo = req.headers.get("x-telegram-bot-api-secret-token");
    if (tgSegredo !== null) {
      if (!iguais(tgSegredo, await segredoWebhook(dep.tokenBot))) return json({ erro: "Não autorizado." }, 401);
      const update = await req.json().catch(() => null);
      const msg = update?.message;
      // Ignora sem responder: outra pessoa, grupo, ou mensagem sem texto (foto, figurinha...).
      if (!msg || String(msg.from?.id) !== dep.donoId || msg.chat?.type !== "private") return json({ ok: true });
      if (typeof msg.text !== "string") {
        await enviarAoDono("Por enquanto eu só entendo mensagens de texto. Mande /ajuda.");
        return json({ ok: true });
      }
      try {
        await enviarAoDono(await bot.tratar(msg.text.slice(0, 5000)));
      } catch (e) {
        log("Falha ao tratar mensagem", e instanceof Error ? e.message : String(e));
        await enviarAoDono("Tive um problema para fazer isso agora. Tente de novo em instantes.");
      }
      // Sempre 200 para o Telegram nao reenviar a mesma mensagem.
      return json({ ok: true });
    }

    const cronSegredo = req.headers.get("x-cron-secret");
    if (cronSegredo !== null) {
      const esperado = await dep.segredoCron();
      if (!esperado || !iguais(cronSegredo, esperado)) return json({ erro: "Não autorizado." }, 401);
      const corpo = await req.json().catch(() => ({}));
      if (corpo?.acao === "disparar") return json(await bot.disparar(enviarAoDono));
      if (corpo?.acao === "registrar_webhook") {
        const ok = await dep.telegram("setWebhook", {
          url: dep.urlFuncao,
          secret_token: await segredoWebhook(dep.tokenBot),
          allowed_updates: ["message"],
          drop_pending_updates: true,
        });
        return json({ webhook_registrado: ok }, ok ? 200 : 502);
      }
      return json({ erro: "Ação desconhecida." }, 400);
    }

    return json({ erro: "Não autorizado." }, 401);
  };
}
