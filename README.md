# Assistente no Telegram

Bot pessoal para **lembretes** e **anotações**, que só responde ao dono. Roda inteiro no Supabase (plano gratuito): uma Edge Function recebe as mensagens e um agendamento no banco envia os lembretes a cada minuto.

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
| `/agenda` · `agenda amanhã` · `agenda semana` · `agenda sexta` · `agenda 15/11` | Consulta por dia |
| `/compromissos` · `desmarcar 2` | Próximos compromissos · desmarca o nº 2 (e o aviso) |
| `nota comprar filtro de café` | Salva uma anotação |
| `/notas` · `buscar café` · `apagar 3` | Lista · procura · apaga a nº 3 |
| `/ajuda` | Mostra os exemplos |

Horários sempre no fuso de Fortaleza (UTC-3).

## Segurança

- O bot atende **só o seu id** do Telegram, e só em conversa privada. Mensagens de outras pessoas são ignoradas sem resposta.
- Chamadas do Telegram são conferidas por um segredo derivado do token do bot; as do agendador, por um segredo aleatório guardado no Vault do Supabase. Qualquer outra chamada recebe 401.
- As tabelas não são acessíveis pela chave pública: só a função (service_role) lê e grava.
- Segredos configurados por você: apenas o **token do bot** e o **seu id**, ambos como segredos da função. Nada vai para o repositório.

## Instalação (uma vez)

1. **Banco:** no SQL Editor do projeto, execute `supabase/migrations/0001_inicial.sql` e depois `0003_agenda.sql`.
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

Os testes não usam rede nem credenciais. A lógica fica separada em `interpretar.ts` (datas e comandos), `bot.ts` (ações) e `handler.ts` (segurança das chamadas); `index.ts` só liga isso ao Supabase e ao Telegram.

## Próximos passos

- Sincronizar a agenda com o Google Agenda (conta de serviço com acesso à agenda compartilhada).
- Entender frases mais livres e mensagens de áudio.
