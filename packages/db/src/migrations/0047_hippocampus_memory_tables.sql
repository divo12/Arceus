DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Skipping pgvector extension install: %', SQLERRM;
  END;
END $$;

DO $$
DECLARE
  embedding_column_type text;
BEGIN
  embedding_column_type := CASE
    WHEN to_regtype('vector') IS NOT NULL THEN 'vector(384)'
    ELSE 'jsonb'
  END;

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.memory_units (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id),
      agent_id uuid NOT NULL REFERENCES public.agents(id),
      content text NOT NULL,
      embedding %s,
      memory_type text NOT NULL,
      confidence real NOT NULL DEFAULT 0.5,
      relevance_score real,
      container text NOT NULL,
      visibility text NOT NULL DEFAULT ''private'',
      metadata jsonb NOT NULL DEFAULT ''{}''::jsonb,
      source_type text,
      source_id text,
      provenance text,
      version integer NOT NULL DEFAULT 1,
      previous_version_id uuid,
      promotion_status text DEFAULT ''pending'',
      expires_at timestamptz,
      deleted_at timestamptz,
      delete_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )',
    embedding_column_type
  );

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.memory_patterns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id),
      agent_id uuid NOT NULL REFERENCES public.agents(id),
      description text NOT NULL,
      strategy text NOT NULL,
      embedding %s,
      usage_count integer NOT NULL DEFAULT 0,
      success_rate real NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT ''active'',
      domain text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )',
    embedding_column_type
  );

  CREATE TABLE IF NOT EXISTS public.memory_habits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id),
    agent_id uuid NOT NULL REFERENCES public.agents(id),
    trigger_condition text NOT NULL,
    action text NOT NULL,
    confidence real NOT NULL DEFAULT 0.5,
    usage_count integer NOT NULL DEFAULT 0,
    is_active boolean NOT NULL DEFAULT true,
    source_pattern_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.memory_priming_state (
    agent_id uuid PRIMARY KEY REFERENCES public.agents(id),
    company_id uuid NOT NULL REFERENCES public.companies(id),
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.memory_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id),
    provider_key text NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.memory_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id),
    agent_id uuid REFERENCES public.agents(id),
    binding_id uuid,
    operation_type text NOT NULL,
    scope jsonb,
    source_ref jsonb,
    result_count integer,
    latency_ms integer,
    cost_cents real,
    input_tokens integer,
    output_tokens integer,
    embedding_tokens integer,
    success boolean NOT NULL,
    error text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
END $$;

CREATE INDEX IF NOT EXISTS memory_units_agent_type_idx
  ON public.memory_units (agent_id, memory_type);

CREATE INDEX IF NOT EXISTS memory_units_container_idx
  ON public.memory_units (container);

CREATE INDEX IF NOT EXISTS memory_units_expires_idx
  ON public.memory_units (expires_at);

CREATE INDEX IF NOT EXISTS memory_units_company_idx
  ON public.memory_units (company_id);

CREATE INDEX IF NOT EXISTS memory_patterns_agent_idx
  ON public.memory_patterns (agent_id);

CREATE INDEX IF NOT EXISTS memory_ops_company_agent_idx
  ON public.memory_operations (company_id, agent_id);

CREATE INDEX IF NOT EXISTS memory_ops_type_idx
  ON public.memory_operations (operation_type);

DO $$
BEGIN
  IF to_regtype('vector') IS NOT NULL
    AND to_regclass('public.memory_units') IS NOT NULL THEN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS memory_units_embedding_hnsw_idx
      ON public.memory_units USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
    ';
  ELSE
    RAISE NOTICE 'Skipping memory_units HNSW index because pgvector or memory_units is unavailable';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regtype('vector') IS NOT NULL
    AND to_regclass('public.memory_patterns') IS NOT NULL THEN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS memory_patterns_embedding_hnsw_idx
      ON public.memory_patterns USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
    ';
  ELSE
    RAISE NOTICE 'Skipping memory_patterns HNSW index because pgvector or memory_patterns is unavailable';
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE public.memory_units
    ADD CONSTRAINT memory_units_previous_version_fk
    FOREIGN KEY (previous_version_id) REFERENCES public.memory_units(id);
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'memory_units_previous_version_fk already exists';
END $$;
