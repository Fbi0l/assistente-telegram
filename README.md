# Assistente no Telegram

Bot pessoal para **lembretes**, **agenda** (ligada ao Google Agenda) e **anotações**, que só responde ao dono. Roda inteiro no Supabase (plano gratuito): uma Edge Function recebe as mensagens e um agendamento no banco envia os lembretes a cada minuto.

## O que ele entende

| Mensagem | O que faz |
| --- | --- |
| `lembrar em 30 min tirar o bolo` | Lembrete daqui a 30 minutos |
| `lembrar amanhã às 8h pagar a conta` | Lembrete em dia e hora |
| `lembrar sexta 14h30 reunião` | Próxima sexta (ou hoje, se ainda não passou) |
| `lembrar 15/11 aniversário da Ana` | Data sem hora = 9h |
| `/lembretes` · `cancelar 2` | Lista os próximos · cancela o nº 2 |
| `agendar sexta 14h reunião com João` | Compromisso, com aviso **2h antes** |
| `agendar amanhã 10h dentista avisar 30 min antes` | Aviso com antecedência escolhida (até 7 dias) |
| `agendar 20/11 19h jantar sem aviso` | Compromisso sem aviso |
| `agendar 12/11 festa` | Sem horário: dia todo, aviso no dia às 8h (ou `avisar 1 dia antes`) |
| `/agenda` · `agenda amanhã` · `agenda semana` · `agenda sexta` · `agenda 15/11` | Consulta por dia |
| `/compromissos` · `desmarcar 2` | Próximos compromissos · desmarca o nº 2 (e o aviso) |
| `/google` | Confere a ligação com o Google Agenda |
| `tarefa comprar tinta` · `tarefa sexta pagar boleto` | Tarefa, com prazo opcional |
| `/tarefas` · `feito 2` | Lista as pendentes · conclui a nº 2 |
| `nota comprar filtro de café` | Salva uma anotação |
| `/notas` · `buscar café` · `apagar 3` | Lista · procura · apaga a nº 3 |
| `/ajuda` | Mostra os exemplos |

Vários comandos de uma vez: um por linha na mesma mensagem (até 20). `cancelar`, `apagar` e `desmarcar` vão sozinhos, porque os números da lista mudam a cada um.

Horários sempre no fuso de Fortaleza (UTC-3).

## Google Agenda (opcional)

- O que você marca com `agendar` vira um evento de 1h no Google Agenda; `desmarcar` apaga o evento.
- `/agenda` e `/compromissos` mostram também os eventos criados direto no Google (com `•`, sem número: altere por lá).
- O aviso pelo Telegram vale para os compromissos marcados pelo bot. Se o Google estiver fora do ar, o compromisso fica salvo no bot e a resposta avisa.
- Mudanças feitas no Google em eventos criados pelo bot (horário, exclusão) não voltam para o bot.

Configuração: no Google Cloud, crie um projeto, ative a *Google Calendar API* e crie uma conta de serviço com uma chave JSON. No Google Agenda, compartilhe sua agenda com o e-mail da conta de serviço ("Fazer alterações nos eventos"). No Supabase, crie os segredos da função `GOOGLE_SERVICE_ACCOUNT` (conteúdo do .json) e `GOOGLE_CALENDAR_ID` (ID da agenda; na principal, seu Gmail). Execute `0004_google.sql` e mande `/google` para conferir.

## Google Tarefas (opcional)

As tarefas do bot vão para "Minhas tarefas" no Google Tarefas, e `/tarefas` mostra também as pendentes criadas lá (com `•`). Como o Google não deixa compartilhar tarefas com a conta de serviço, aqui o bot usa o seu login: crie um cliente OAuth (tipo *Aplicativo da Web*, com `https://developers.google.com/oauthplayground` como URI de redirecionamento), ative a *Google Tasks API*, publique a tela de consentimento (senão a autorização expira em 7 dias) e gere um *refresh token* no OAuth Playground com o escopo `https://www.googleapis.com/auth/tasks`. Guarde como segredos da função: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` e `GOOGLE_TASKS_REFRESH_TOKEN`. Mande `/google` para conferir.

## Segurança

- O bot atende **só o seu id** do Telegram, e só em conversa privada. Mensagens de outras pessoas são ignoradas sem resposta.
- Chamadas do Telegram são conferidas por um segredo derivado do token do bot; as do agendador, por um segredo aleatório guardado no Vault do Supabase. Qualquer outra chamada recebe 401.
- As tabelas não são acessíveis pela chave pública: só a função (service_role) lê e grava.
- Segredos configurados por você: apenas o **token do bot** e o **seu id**, ambos como segredos da função. Nada vai para o repositório.

## Instalação (uma vez)

1. **Banco:** no SQL Editor do projeto, execute `supabase/migrations/0001_inicial.sql`, `0003_agenda.sql`, `0004_google.sql`, `0005_dia_inteiro.sql` e `0006_tarefas.sql`.
2. **Segredos da função:** no painel, *Edge Functions → Secrets*, crie `TELEGRAM_BOT_TOKEN` (token do @BotFather) e `TELEGRAM_CHAT_ID` (seu id, do @userinfobot).
3. **Publicar a função** (PowerShell, na pasta do repositório):
   ```powershell
   npx.cmd supabase@latest functions deploy telegram-bot --no-verify-jwt --project-ref SEU_PROJECT_REF
   ```
   O `--no-verify-jwt` é necessário: o Telegram não envia login do Supabase; a função faz a própria verificação.
4. **Agendamento e ligação com o Telegram:** abra `supabase/migrations/0002_agendamento.sql`, troque `__PROJECT_REF__` pelo identificador do projeto e execute no SQL Editor. Ele cria o agendamento de 1 em 1 minuto, a limpeza diária do histórico e registra o bot no Telegram.
5. **Teste:** mande `/ajuda` para o bot.

## Desenvolvimento

```bash
npm ci
npm test   # interpretação de datas, lógica do bot, segurança das chamadas e banco (PostgreSQL em memória)
```

Os testes não usam rede nem credenciais. A lógica fica separada em `interpretar.ts` (datas e comandos), `bot.ts` (ações), `google.ts` (Google Agenda) e `handler.ts` (segurança das chamadas); `index.ts` só liga isso ao Supabase e ao Telegram.

## Próximos passos

- Avisos também para eventos criados direto no Google Agenda.
- Entender frases mais livres e mensagens de áudio.
