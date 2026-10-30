-- Agendador: chama a funcao do bot a cada minuto para enviar os lembretes vencidos.
-- Executar no SQL Editor DEPOIS de publicar a funcao telegram-bot e configurar seus segredos.
-- Troque __PROJECT_REF__ pelo identificador do projeto (o trecho antes de .supabase.co na URL).
-- Pode ser executado de novo: recria o agendamento e mantem o segredo existente.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Segredo aleatorio gerado aqui mesmo; ninguem precisa copia-lo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'bot_cron_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'bot_cron_secret',
      'Autentica o agendador junto a funcao telegram-bot');
  END IF;
END $$;

-- Chamada da funcao com o segredo; usada pelo agendamento e pelo registro do webhook.
CREATE OR REPLACE FUNCTION public.chamar_bot(p_acao text)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT net.http_post(
    url := 'https://__PROJECT_REF__.supabase.co/functions/v1/telegram-bot',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bot_cron_secret')),
    body := jsonb_build_object('acao', p_acao),
    timeout_milliseconds := 10000);
$$;
REVOKE ALL ON FUNCTION public.chamar_bot(text) FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'bot-disparar-lembretes';
SELECT cron.schedule('bot-disparar-lembretes', '* * * * *', $$SELECT public.chamar_bot('disparar')$$);

-- Limpeza diaria (03h17 em Fortaleza): o historico do agendador cresceria 1.440 linhas por dia.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'bot-limpar-historico';
SELECT cron.schedule('bot-limpar-historico', '17 6 * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$$);

-- Liga o bot ao Telegram (registra o endereco da funcao). Resultado na consulta abaixo.
SELECT public.chamar_bot('registrar_webhook');

-- Conferencia (rode uns segundos depois): status 200 e {"webhook_registrado":true}.
-- SELECT status_code, content FROM net._http_response ORDER BY created DESC LIMIT 3;
