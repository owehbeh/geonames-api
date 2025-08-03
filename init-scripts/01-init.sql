-- This file runs automatically when PostgreSQL starts
-- It ensures required extensions are available

DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
    WHEN others THEN
        RAISE NOTICE 'Extensions may already exist or require superuser privileges';
END
$$;