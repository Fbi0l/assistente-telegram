-- Sincronizacao com o Google Agenda: guarda o id do evento criado para cada compromisso.
-- Executar no SQL Editor do projeto do bot. Pode ser reaplicado.
ALTER TABLE public.compromissos
  ADD COLUMN IF NOT EXISTS google_evento_id text CHECK (char_length(google_evento_id) <= 1024);
