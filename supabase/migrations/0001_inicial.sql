-- Assistente no Telegram: lembretes e anotacoes.
-- Executar no SQL Editor do projeto Supabase do bot.
-- Somente a Edge Function (service_role) acessa os dados; o site/anon nao enxerga nada.
BEGIN;

CREATE TABLE IF NOT EXISTS public.lembretes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  texto text NOT NULL CHECK (char_length(btrim(texto)) BETWEEN 1 AND 500),
  quando timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  enviado_em timestamptz,
  cancelado_em timestamptz,
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0)
);
CREATE INDEX IF NOT EXISTS lembretes_pendentes_idx ON public.lembretes (quando)
  WHERE enviado_em IS NULL AND cancelado_em IS NULL;

CREATE TABLE IF NOT EXISTS public.notas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  texto text NOT NULL CHECK (char_length(btrim(texto)) BETWEEN 1 AND 4000),
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notas_recentes_idx ON public.notas (criado_em DESC);

ALTER TABLE public.lembretes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lembretes, public.notas FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lembretes, public.notas TO service_role;

-- Marca como enviados, de forma atomica, os lembretes vencidos (ate 5 tentativas cada).
-- SKIP LOCKED: duas execucoes simultaneas nunca pegam o mesmo lembrete.
CREATE OR REPLACE FUNCTION public.reivindicar_lembretes(p_limite integer DEFAULT 20)
RETURNS SETOF public.lembretes LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  WITH marcados AS (
    UPDATE public.lembretes l
    SET enviado_em = now(), tentativas = l.tentativas + 1
    WHERE l.id IN (
      SELECT id FROM public.lembretes
      WHERE enviado_em IS NULL AND cancelado_em IS NULL AND quando <= now() AND tentativas < 5
      ORDER BY quando
      LIMIT least(greatest(coalesce(p_limite, 20), 1), 100)
      FOR UPDATE SKIP LOCKED)
    RETURNING l.*)
  SELECT * FROM marcados ORDER BY quando, id;
$$;

-- Envio falhou: volta para a fila (a tentativa ja foi contada).
CREATE OR REPLACE FUNCTION public.liberar_lembrete(p_id uuid)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  UPDATE public.lembretes SET enviado_em = NULL WHERE id = p_id AND cancelado_em IS NULL;
$$;

-- Segredo do agendador, guardado no Vault (ver 0002_agendamento.sql). So a funcao o le.
CREATE OR REPLACE FUNCTION public.segredo_cron()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bot_cron_secret' LIMIT 1);
END; $$;

REVOKE ALL ON FUNCTION public.reivindicar_lembretes(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.liberar_lembrete(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.segredo_cron() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reivindicar_lembretes(integer), public.liberar_lembrete(uuid),
  public.segredo_cron() TO service_role;

COMMIT;
