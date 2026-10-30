-- Tarefas (lista de afazeres) com prazo opcional; espelhadas no Google Tarefas quando configurado.
-- Executar no SQL Editor do projeto do bot. Pode ser reaplicado.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  texto text NOT NULL CHECK (char_length(btrim(texto)) BETWEEN 1 AND 500),
  prazo date,
  google_tarefa_id text CHECK (char_length(google_tarefa_id) <= 1024),
  criado_em timestamptz NOT NULL DEFAULT now(),
  concluida_em timestamptz
);
CREATE INDEX IF NOT EXISTS tarefas_pendentes_idx ON public.tarefas (prazo, criado_em) WHERE concluida_em IS NULL;

ALTER TABLE public.tarefas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tarefas FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tarefas TO service_role;

COMMIT;
