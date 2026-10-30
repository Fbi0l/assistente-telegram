// Interpretacao das mensagens em portugues: comandos, datas e horarios.
// Funcoes puras (sem rede nem banco), testadas em tests/interpretar.test.mjs.

// America/Fortaleza: UTC-3 o ano todo (o Brasil nao tem horario de verao desde 2019).
export const FUSO_MIN = -180;

export type Comando =
  | { tipo: "ajuda" }
  | { tipo: "lembrar"; quando: Date; texto: string }
  | { tipo: "lembretes" }
  | { tipo: "cancelar"; numero: number }
  | { tipo: "nota"; texto: string }
  | { tipo: "notas" }
  | { tipo: "buscar"; termo: string }
  | { tipo: "apagar"; numero: number }
  | { tipo: "erro"; mensagem: string }
  | { tipo: "desconhecido" };

export const LIMITE_LEMBRETE = 500;
export const LIMITE_NOTA = 4000;
const MAX_FUTURO_MS = 2 * 366 * 24 * 3600 * 1000;

export const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

// Data/hora "de parede" em Fortaleza <-> instante real.
type Local = { ano: number; mes: number; dia: number; hora: number; min: number; semana: number };
export function paraLocal(d: Date): Local {
  const x = new Date(d.getTime() + FUSO_MIN * 60000);
  return { ano: x.getUTCFullYear(), mes: x.getUTCMonth(), dia: x.getUTCDate(),
    hora: x.getUTCHours(), min: x.getUTCMinutes(), semana: x.getUTCDay() };
}
export function deLocal(ano: number, mes: number, dia: number, hora: number, min: number): Date {
  return new Date(Date.UTC(ano, mes, dia, hora, min) - FUSO_MIN * 60000);
}

const DIAS_SEMANA = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const ABREV_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
const EXIBIR_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function formatarQuando(d: Date): string {
  const l = paraLocal(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${EXIBIR_SEMANA[l.semana]} ${p(l.dia)}/${p(l.mes + 1)} às ${p(l.hora)}:${p(l.min)}`;
}

function diaDaSemana(t: string): number {
  const s = t.replace(/-feira$/, "");
  const i = DIAS_SEMANA.indexOf(s);
  return i >= 0 ? i : ABREV_SEMANA.indexOf(s);
}

// Horario: "8h", "8h30", "08:30", "20hs", "meio-dia", "meia-noite"; numero puro so depois de "as".
function lerHora(tokens: string[], i: number, depoisDeAs: boolean): { h: number; m: number; usados: number } | null {
  const t = tokens[i];
  if (t === undefined) return null;
  if (t === "meio-dia" || t === "meiodia") return { h: 12, m: 0, usados: 1 };
  if (t === "meio" && tokens[i + 1] === "dia") return { h: 12, m: 0, usados: 2 };
  if (t === "meia-noite" || t === "meianoite") return { h: 0, m: 0, usados: 1 };
  if (t === "meia" && tokens[i + 1] === "noite") return { h: 0, m: 0, usados: 2 };
  let m = t.match(/^(\d{1,2})(?::|h)(\d{2})$/) || t.match(/^(\d{1,2})(?:h|hs|hrs?)$/);
  if (!m && depoisDeAs) m = t.match(/^(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return { h, m: min, usados: 1 };
}
function lerHoraComAs(tokens: string[], i: number) {
  if (tokens[i] === "as" || tokens[i] === "a") {
    const r = lerHora(tokens, i + 1, true);
    return r ? { ...r, usados: r.usados + 1 } : null;
  }
  return lerHora(tokens, i, false);
}

const UNIDADES: Record<string, number> = {
  m: 1, min: 1, mins: 1, minuto: 1, minutos: 1,
  h: 60, hr: 60, hrs: 60, hora: 60, horas: 60,
  d: 1440, dia: 1440, dias: 1440, semana: 10080, semanas: 10080,
};

// Le a expressao de tempo no inicio dos tokens. Retorna o instante e quantos tokens usou.
export function lerQuando(tokens: string[], agora: Date): { quando: Date; usados: number } | { erro: string } | null {
  let i = 0;
  // "em 10 min", "daqui a 2 horas", "em 10min"
  if (tokens[0] === "em" || (tokens[0] === "daqui" && tokens[1] === "a")) {
    i = tokens[0] === "em" ? 1 : 2;
    let n: number, unidade: string | undefined, usados: number;
    const junto = (tokens[i] ?? "").match(/^(\d+)([a-z]+)$/);
    if (junto) { n = Number(junto[1]); unidade = junto[2]; usados = 1; }
    else if (/^\d+$/.test(tokens[i] ?? "")) { n = Number(tokens[i]); unidade = tokens[i + 1]; usados = 2; }
    else if (tokens[i] === "meia" && tokens[i + 1] === "hora") { n = 30; unidade = "min"; usados = 2; }
    else if ((tokens[i] === "uma" || tokens[i] === "um") && tokens[i + 1]) { n = 1; unidade = tokens[i + 1]; usados = 2; }
    else return null;
    const fator = unidade ? UNIDADES[unidade] : undefined;
    if (!fator || n <= 0) return null;
    return { quando: new Date(agora.getTime() + n * fator * 60000), usados: i + usados };
  }

  const hoje = paraLocal(agora);
  let dia: { ano: number; mes: number; dia: number } | null = null;
  let semanaAlvo: number | null = null;
  let hora: { h: number; m: number } | null = null;

  // Dia: hoje, amanha, depois de amanha, dia da semana, dd/mm[/aaaa]
  const t = tokens[0];
  if (t === "hoje") { dia = { ano: hoje.ano, mes: hoje.mes, dia: hoje.dia }; i = 1; }
  else if (t === "amanha") { dia = { ano: hoje.ano, mes: hoje.mes, dia: hoje.dia + 1 }; i = 1; }
  else if (t === "depois" && tokens[1] === "de" && tokens[2] === "amanha") { dia = { ano: hoje.ano, mes: hoje.mes, dia: hoje.dia + 2 }; i = 3; }
  else if (t !== undefined && diaDaSemana(t) >= 0) { semanaAlvo = diaDaSemana(t); i = 1; }
  else if (t !== undefined && /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(t)) {
    const [d, m, a] = t.split("/").map(Number);
    let ano = a === undefined ? hoje.ano : a < 100 ? 2000 + a : a;
    const teste = new Date(Date.UTC(ano, m - 1, d));
    if (m < 1 || m > 12 || teste.getUTCMonth() !== m - 1) return { erro: "Data inválida." };
    if (a === undefined && deLocal(ano, m - 1, d, 23, 59) < agora) ano++;
    dia = { ano, mes: m - 1, dia: d }; i = 1;
  }
  const h = lerHoraComAs(tokens, i);
  if (h) { hora = { h: h.h, m: h.m }; i += h.usados; }

  if (!dia && semanaAlvo === null && !hora) return null;
  if (!hora) hora = { h: 9, m: 0 }; // so o dia: 9h da manha

  let quando: Date;
  if (semanaAlvo !== null) {
    let delta = (semanaAlvo - hoje.semana + 7) % 7;
    quando = deLocal(hoje.ano, hoje.mes, hoje.dia + delta, hora.h, hora.m);
    if (quando <= agora) { delta += 7; quando = deLocal(hoje.ano, hoje.mes, hoje.dia + delta, hora.h, hora.m); }
  } else if (dia) {
    quando = deLocal(dia.ano, dia.mes, dia.dia, hora.h, hora.m);
  } else {
    // So o horario: hoje, ou amanha se ja passou.
    quando = deLocal(hoje.ano, hoje.mes, hoje.dia, hora.h, hora.m);
    if (quando <= agora) quando = deLocal(hoje.ano, hoje.mes, hoje.dia + 1, hora.h, hora.m);
  }
  if (quando <= agora) return { erro: `Esse horário já passou (${formatarQuando(quando)}).` };
  return { quando, usados: i };
}

const AJUDA_QUANDO =
  "Não entendi quando. Exemplos:\n" +
  "lembrar em 30 min tirar o bolo\n" +
  "lembrar amanhã às 8h pagar a conta\n" +
  "lembrar sexta 14h30 reunião\n" +
  "lembrar 15/11 aniversário da Ana";

export function interpretar(mensagem: string, agora: Date): Comando {
  const original = mensagem.trim().split(/\s+/).filter(Boolean);
  if (!original.length) return { tipo: "desconhecido" };
  // "/notas@meu_bot" -> "/notas"
  const tokens = original.map((t, i) => normalizar(i === 0 ? t.replace(/@\w+$/, "") : t));
  const resto = (n: number) => original.slice(n).join(" ").trim();
  const numero = (n: number) => (/^\d+$/.test(tokens[n] ?? "") ? Number(tokens[n]) : NaN);
  const cmd = tokens[0].replace(/^\//, "").replace(/:$/, "");

  if (["start", "ajuda", "help", "comandos"].includes(cmd)) return { tipo: "ajuda" };
  if (cmd === "lembretes") return { tipo: "lembretes" };
  if (cmd === "notas") return { tipo: "notas" };
  if (cmd === "cancelar") {
    const n = numero(1);
    return Number.isInteger(n) && n > 0 ? { tipo: "cancelar", numero: n } : { tipo: "erro", mensagem: "Use: cancelar 2 (o número aparece em /lembretes)." };
  }
  if (cmd === "apagar") {
    const n = numero(1);
    return Number.isInteger(n) && n > 0 ? { tipo: "apagar", numero: n } : { tipo: "erro", mensagem: "Use: apagar 3 (o número aparece em /notas)." };
  }
  if (cmd === "buscar") {
    const termo = resto(1);
    return termo ? { tipo: "buscar", termo: termo.slice(0, 100) } : { tipo: "erro", mensagem: "Use: buscar palavra" };
  }
  if (["nota", "anota", "anotar", "anote"].includes(cmd)) {
    const texto = resto(1);
    if (!texto) return { tipo: "erro", mensagem: "Use: nota texto da anotação" };
    if (texto.length > LIMITE_NOTA) return { tipo: "erro", mensagem: `A nota pode ter até ${LIMITE_NOTA} caracteres.` };
    return { tipo: "nota", texto };
  }

  // Lembretes: "/lembrar ...", "lembrar ...", "me lembra ...", "me lembre de ..."
  let inicio = -1;
  if (["lembrar", "lembra", "lembre", "lembrete"].includes(cmd)) inicio = 1;
  else if (cmd === "me" && ["lembra", "lembre", "lembrar"].includes(tokens[1] ?? "")) inicio = 2;
  if (inicio < 0) return { tipo: "desconhecido" };
  if (tokens[inicio] === "de" || tokens[inicio] === "que") inicio++;

  const r = lerQuando(tokens.slice(inicio), agora);
  if (r === null) return { tipo: "erro", mensagem: AJUDA_QUANDO };
  if ("erro" in r) return { tipo: "erro", mensagem: r.erro };
  if (r.quando.getTime() - agora.getTime() > MAX_FUTURO_MS) return { tipo: "erro", mensagem: "Lembretes podem ser marcados até 2 anos à frente." };
  let pos = inicio + r.usados;
  if (["de", "que", "para", "pra", "-", ":"].includes(tokens[pos] ?? "")) pos++;
  const texto = resto(pos);
  if (!texto) return { tipo: "erro", mensagem: "Faltou dizer do que lembrar. Ex.: lembrar amanhã 8h pagar a conta" };
  if (texto.length > LIMITE_LEMBRETE) return { tipo: "erro", mensagem: `O lembrete pode ter até ${LIMITE_LEMBRETE} caracteres.` };
  return { tipo: "lembrar", quando: r.quando, texto };
}
