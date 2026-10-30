-- Compromissos de dia inteiro (agendar sem horario). O aviso pode cair no proprio dia.
-- Executar no SQL Editor do projeto do bot. Pode ser reaplicado.
BEGIN;

ALTER TABLE public.compromissos ADD COLUMN IF NOT EXISTS dia_inteiro boolean NOT NULL DEFAULT false;

DROP FUNCTION IF EXISTS public.criar_compromisso(text, timestamptz, timestamptz, text);
CREATE OR REPLACE FUNCTION public.criar_compromisso(p_titulo text, p_inicio timestamptz, p_aviso_em timestamptz, p_texto_aviso text, p_dia_inteiro boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_lembrete uuid; v_id uuid; v_limite timestamptz;
BEGIN
  IF p_aviso_em IS NOT NULL THEN
    -- Com horario: aviso antes do inicio. Dia inteiro: aviso ate o fim do dia.
    v_limite := p_inicio;
    IF coalesce(p_dia_inteiro, false) THEN v_limite := p_inicio + interval '1 day'; END IF;
    IF p_aviso_em >= v_limite THEN
      RAISE EXCEPTION 'O aviso precisa ser antes do compromisso.';
    END IF;
    INSERT INTO public.lembretes(texto, quando) VALUES (left(p_texto_aviso, 500), p_aviso_em) RETURNING id INTO v_lembrete;
  END IF;
  INSERT INTO public.compromissos(titulo, inicio, aviso_lembrete_id, dia_inteiro)
  VALUES (p_titulo, p_inicio, v_lembrete, coalesce(p_dia_inteiro, false)) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

REVOKE ALL ON FUNCTION public.criar_compromisso(text, timestamptz, timestamptz, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_compromisso(text, timestamptz, timestamptz, text, boolean) TO service_role;

COMMIT;
