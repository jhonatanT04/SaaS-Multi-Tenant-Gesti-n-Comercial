-- 0001_platform: tenants, users, memberships, refresh_tokens, invitations.
--
-- DECISIÓN DE DISEÑO: autenticación sin tenant y sin BYPASSRLS
-- ------------------------------------------------------------
-- Registro, login y aceptación de invitaciones ocurren ANTES de que exista un
-- `app.tenant_id`, y `users` es global (una persona puede pertenecer a varios
-- tenants). `app_user` no tiene BYPASSRLS ni lo va a tener. Se resuelve así:
--
--   1. Todas las tablas llevan ENABLE + FORCE ROW LEVEL SECURITY.
--   2. Las pocas operaciones que cruzan tenants viven en funciones
--      SECURITY DEFINER (propiedad de `migrator`), cada una acotada a un caso:
--        auth_register           crea tenant + usuario owner + membership (atómico)
--        auth_login_lookup       busca por email EXACTO: hash + memberships
--        auth_invitation_lookup  busca por hash EXACTO de token de invitación
--        auth_accept_invitation  crea usuario (si falta) + membership
--      Ninguna permite listar: sin el email o el token exacto no devuelven nada.
--      Todas fijan `search_path` y solo `app_user` tiene EXECUTE.
--   3. Como FORCE también somete al dueño, esas funciones necesitan una política
--      explícita `platform_definer ... TO migrator`. Solo aplica al rol
--      `migrator`, que la API nunca usa para conectarse.
--   4. `app_user` no puede leer `users.password_hash` (grant por columnas), ni
--      escribir en `users`/`tenants`; solo ve los usuarios que son miembros del
--      tenant actual y la fila de su propio tenant.
--
-- `app_tenant_id()` devuelve NULL (=> cero filas) cuando la variable no está
-- fijada o quedó como '' en una conexión reutilizada del pool.

CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- tablas

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 60),
  currency   char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  -- Fracción, no porcentaje: 0.1500 = 15 %.
  tax_rate   numeric(5,4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  password_hash text NOT NULL,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'cashier')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

-- Refresh tokens con rotación. `id` es el `jti` del JWT; `family_id` agrupa la
-- cadena de rotaciones para revocarla entera si se reutiliza un token viejo.
-- Al quitar un miembro, sus tokens se borran por la FK compuesta.
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  family_id  uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX refresh_tokens_tenant_user_idx ON refresh_tokens (tenant_id, user_id);
CREATE INDEX refresh_tokens_tenant_family_idx ON refresh_tokens (tenant_id, family_id);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'cashier')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_tenant_email_pending_idx
  ON invitations (tenant_id, email) WHERE accepted_at IS NULL;

-- ---------------------------------------------------------------- RLS

ALTER TABLE tenants        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants        FORCE  ROW LEVEL SECURITY;
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          FORCE  ROW LEVEL SECURITY;
ALTER TABLE memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships    FORCE  ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE  ROW LEVEL SECURITY;
ALTER TABLE invitations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations    FORCE  ROW LEVEL SECURITY;

-- Aislamiento por tenant (misma forma que el contrato, tolerante a '').
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON refresh_tokens
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON invitations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Un tenant solo ve su propia fila.
CREATE POLICY tenant_self ON tenants FOR SELECT
  USING (id = app_tenant_id());

-- Un usuario solo es visible si es miembro del tenant actual. La subconsulta
-- pasa a su vez por la RLS de memberships, así que no hace falta repetir el filtro.
CREATE POLICY tenant_members_visible ON users FOR SELECT
  USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id));

-- Acceso de las funciones SECURITY DEFINER (ver punto 3 de la cabecera).
CREATE POLICY platform_definer ON tenants     TO migrator USING (true) WITH CHECK (true);
CREATE POLICY platform_definer ON users       TO migrator USING (true) WITH CHECK (true);
CREATE POLICY platform_definer ON memberships TO migrator USING (true) WITH CHECK (true);
CREATE POLICY platform_definer ON invitations TO migrator USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- privilegios
-- Los privilegios por defecto dan SELECT/INSERT/UPDATE/DELETE a app_user; aquí se recortan.

REVOKE ALL ON tenants FROM app_user;
GRANT SELECT ON tenants TO app_user;

REVOKE ALL ON users FROM app_user;
GRANT SELECT (id, email, name, created_at) ON users TO app_user;

-- ---------------------------------------------------------------- funciones SECURITY DEFINER

CREATE FUNCTION auth_register(
  p_tenant_name text, p_slug text, p_currency text, p_tax_rate numeric,
  p_email text, p_password_hash text, p_user_name text
) RETURNS TABLE (tenant_id uuid, user_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH t AS (
    INSERT INTO tenants (name, slug, currency, tax_rate)
    VALUES (p_tenant_name, p_slug, p_currency, p_tax_rate)
    RETURNING id
  ), u AS (
    INSERT INTO users (email, password_hash, name)
    VALUES (lower(p_email), p_password_hash, p_user_name)
    RETURNING id
  ), m AS (
    INSERT INTO memberships (tenant_id, user_id, role)
    SELECT t.id, u.id, 'owner' FROM t, u
    RETURNING memberships.tenant_id, memberships.user_id
  )
  SELECT m.tenant_id, m.user_id FROM m;
$$;

-- Una fila por membership; si el usuario existe pero no tiene memberships,
-- una fila con los campos de tenant en NULL.
CREATE FUNCTION auth_login_lookup(p_email text)
  RETURNS TABLE (user_id uuid, password_hash text, tenant_id uuid, tenant_slug text, tenant_name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT u.id, u.password_hash, t.id, t.slug, t.name, m.role
  FROM users u
  LEFT JOIN memberships m ON m.user_id = u.id
  LEFT JOIN tenants t ON t.id = m.tenant_id
  WHERE u.email = lower(p_email)
  ORDER BY m.created_at;
$$;

CREATE FUNCTION auth_invitation_lookup(p_token_hash text)
  RETURNS TABLE (email text, existing_user_id uuid, existing_password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT i.email, u.id, u.password_hash
  FROM invitations i
  LEFT JOIN users u ON u.email = i.email
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.expires_at > now();
$$;

-- Acepta una invitación vigente. Si el email aún no tiene usuario lo crea con
-- p_password_hash/p_name; si ya existe, se ignoran (la API verifica antes su
-- contraseña actual). Devuelve cero filas si el token no es válido.
CREATE FUNCTION auth_accept_invitation(p_token_hash text, p_password_hash text, p_name text)
  RETURNS TABLE (tenant_id uuid, user_id uuid, role text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_inv  invitations%ROWTYPE;
  v_user uuid;
BEGIN
  SELECT * INTO v_inv FROM invitations i
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT u.id INTO v_user FROM users u WHERE u.email = v_inv.email;
  IF v_user IS NULL THEN
    IF p_password_hash IS NULL OR p_name IS NULL THEN
      RAISE EXCEPTION 'password and name are required for a new user' USING ERRCODE = '22023';
    END IF;
    INSERT INTO users (email, password_hash, name)
    VALUES (v_inv.email, p_password_hash, p_name)
    RETURNING id INTO v_user;
  END IF;

  INSERT INTO memberships (tenant_id, user_id, role)
  VALUES (v_inv.tenant_id, v_user, v_inv.role)
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id;

  RETURN QUERY
    SELECT m.tenant_id, m.user_id, m.role FROM memberships m
    WHERE m.tenant_id = v_inv.tenant_id AND m.user_id = v_user;
END;
$$;

REVOKE ALL ON FUNCTION auth_register(text, text, text, numeric, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_login_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_invitation_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_accept_invitation(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_register(text, text, text, numeric, text, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_login_lookup(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_invitation_lookup(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_accept_invitation(text, text, text) TO app_user;
