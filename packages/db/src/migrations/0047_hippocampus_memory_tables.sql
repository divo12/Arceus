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
BEGIN
  IF to_regtype('vector') IS NOT NULL
    AND to_regclass('public.memory_units') IS NOT NULL THEN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS memory_units_embedding_hnsw_idx
      ON memory_units USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
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
      ON memory_patterns USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
    ';
  ELSE
    RAISE NOTICE 'Skipping memory_patterns HNSW index because pgvector or memory_patterns is unavailable';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.memory_units') IS NOT NULL THEN
    ALTER TABLE memory_units
      ADD CONSTRAINT memory_units_previous_version_fk
      FOREIGN KEY (previous_version_id) REFERENCES memory_units(id);
  ELSE
    RAISE NOTICE 'Skipping memory_units_previous_version_fk because memory_units is unavailable';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'memory_units_previous_version_fk already exists';
END $$;
