-- Roles de la plataforma (solo desarrollo; en producción las contraseñas vienen de secretos).
-- migrator: dueño de las tablas, corre migraciones.
-- app_user: rol de la API. NO es dueño ni tiene BYPASSRLS, así que RLS siempre aplica.
-- ai_readonly: rol del asistente text-to-SQL, solo SELECT sobre vistas curadas.
CREATE ROLE migrator LOGIN PASSWORD 'migrator' CREATEDB;
CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE ai_readonly LOGIN PASSWORD 'ai_readonly' NOSUPERUSER NOBYPASSRLS;
GRANT ALL ON DATABASE saas TO migrator;
GRANT ALL ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA public TO app_user, ai_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
