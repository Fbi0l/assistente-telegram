-- Agenda: compromissos com aviso antes (padrao 2h), reaproveitando a fila de lembretes.
-- Executar no SQL Editor do projeto do bot. Pode ser reaplicado.
BEGIN;

CREATE TABLE IF NOT EXISTS public.compromissos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo text NOT NULL CHECK (char_length(btrim(titulo)) BETWEEN 1 AND 300),
  inicio timestamptz NOT NULL,
  aviso_lembrete_id uuid REFERENCES public.lembretes(id) ON DELETE SET NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  cancelado_em timestamptz
);
CREATE INDEX IF NOT EXISTS compromissos_ativos_idx ON public.compromissos (inicio) WHERE cancelado_em IS NULL;

ALTER TABLE public.compromissos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.compromissos FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.compromissos TO service_role;

-- Cria o compromisso e, se houver, o lembrete de aviso, na mesma transacao.
CREATE OR REPLACE FUNCTION public.criar_compromisso(p_titulo text, p_inicio timestamptz, p_aviso_em timestamptz, p_texto_aviso text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_lembrete uuid; v_id uuid;
BEGIN
  IF p_aviso_em IS NOT NULL THEN
    IF p_aviso_em >= p_inicio THEN RAISE EXCEPTION 'O aviso precisa ser antes do compromisso.'; END IF;
    INSERT INTO public.lembretes(texto, quando) VALUES (left(p_texto_aviso, 500), p_aviso_em) RETURNING id INTO v_lembrete;
  END IF;
  INSERT INTO public.compromissos(titulo, inicio, aviso_lembrete_id) VALUES (p_titulo, p_inicio, v_lembrete) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

-- Desmarca o compromisso e cancela o aviso, se ainda nao foi enviado.
CREATE OR REPLACE FUNCTION public.desmarcar_compromisso(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_lembrete uuid;
BEGIN
  UPDATE public.compromissos SET cancelado_em = now()
  WHERE id = p_id AND cancelado_em IS NULL
  RETURNING aviso_lembrete_id INTO v_lembrete;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.lembretes SET cancelado_em = now()
  WHERE id = v_lembrete AND enviado_em IS NULL AND cancelado_em IS NULL;
  RETURN true;
END; $$;

REVOKE ALL ON FUNCTION public.criar_compromisso(text, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.desmarcar_compromisso(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_compromisso(text, timestamptz, timestamptz, text),
  public.desmarcar_compromisso(uuid) TO service_role;

COMMIT;
