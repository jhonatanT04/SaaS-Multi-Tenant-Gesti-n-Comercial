-- 0002_plans: catálogo de planes, suscripción por tenant, contadores de uso
-- y super-admin de plataforma.
--
-- DECISIONES
-- ----------
-- * `plans` es un catálogo global (sin tenant_id ni RLS): app_user solo tiene SELECT.
--   Un límite en NULL significa "sin límite".
-- * `subscriptions` tiene una fila por tenant. app_user solo puede LEER la suya:
--   un tenant no puede cambiarse de plan con SQL propio. El alta la hace un
--   trigger sobre `tenants` (así cualquier vía de creación de tenants, no solo
--   `auth_register`, deja al tenant en free) y el cambio de plan solo ocurre en
--   `platform_set_tenant_plan`.
-- * `usage_counters` lleva las emisiones por tenant y mes (UTC). Se incrementa
--   con un upsert condicionado que bloquea la fila, de modo que dos emisiones
--   simultáneas en el límite no pueden pasar ambas (ver PlanService).
-- * SUPER-ADMIN DE PLATAFORMA: es un usuario normal cuyo id está en
--   `platform_admins`. app_user no tiene ningún privilegio sobre esa tabla; solo
--   se escribe con el rol `migrator` (operación manual):
--       INSERT INTO platform_admins (user_id) SELECT id FROM users WHERE email = '...';
--   Ser super-admin NO relaja la RLS: su sesión sigue atada a su propio tenant y
--   no puede leer datos de otros. Lo único que gana es poder ejecutar
--   `platform_set_tenant_plan`, que vuelve a comprobar la pertenencia a
--   `platform_admins` dentro de la base y deja rastro en `plan_changes`.

CREATE TABLE plans (
  code                   text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name                   text NOT NULL,
  max_invoices_per_month integer CHECK (max_invoices_per_month > 0),
  max_users              integer CHECK (max_users > 0),
  ai_assistant           boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON plans FROM app_user;
GRANT SELECT ON plans TO app_user;

INSERT INTO plans (code, name, max_invoices_per_month, max_users, ai_assistant) VALUES
  ('free', 'Free', 50,   1,    false),
  ('pro',  'Pro',  NULL, NULL, true);

CREATE TABLE subscriptions (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code  text NOT NULL DEFAULT 'free' REFERENCES plans(code),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_counters (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Primer día del mes (UTC) al que corresponde el contador.
  period          date NOT NULL CHECK (period = date_trunc('month', period)::date),
  invoices_issued integer NOT NULL DEFAULT 0 CHECK (invoices_issued >= 0),
  PRIMARY KEY (tenant_id, period)
);

CREATE TABLE platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_changes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_plan  text NOT NULL REFERENCES plans(code),
  to_plan    text NOT NULL REFERENCES plans(code),
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_changes_tenant_idx ON plan_changes (tenant_id, created_at DESC);

-- ---------------------------------------------------------------- RLS y privilegios

ALTER TABLE subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions   FORCE  ROW LEVEL SECURITY;
ALTER TABLE usage_counters  ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters  FORCE  ROW LEVEL SECURITY;
ALTER TABLE plan_changes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_changes    FORCE  ROW LEVEL SECURITY;
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriptions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON usage_counters
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON plan_changes
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY platform_definer ON subscriptions   TO migrator USING (true) WITH CHECK (true);
CREATE POLICY platform_definer ON plan_changes    TO migrator USING (true) WITH CHECK (true);
CREATE POLICY platform_definer ON platform_admins TO migrator USING (true) WITH CHECK (true);

REVOKE ALL ON subscriptions FROM app_user;
GRANT SELECT ON subscriptions TO app_user;
REVOKE ALL ON plan_changes FROM app_user;
GRANT SELECT ON plan_changes TO app_user;
REVOKE ALL ON platform_admins FROM app_user;
REVOKE DELETE ON usage_counters FROM app_user;

-- ---------------------------------------------------------------- todo tenant nace en free

CREATE FUNCTION tenants_create_subscription() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO subscriptions (tenant_id, plan_code) VALUES (NEW.id, 'free');
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION tenants_create_subscription() FROM PUBLIC;

CREATE TRIGGER tenants_create_subscription
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_create_subscription();

-- Tenants que ya existían antes de esta migración.
INSERT INTO subscriptions (tenant_id, plan_code)
SELECT id, 'free' FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------- super-admin

CREATE FUNCTION platform_is_admin(p_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM platform_admins a WHERE a.user_id = p_user_id) $$;

-- Cambia el plan de un tenant. Devuelve cero filas si el tenant no existe.
-- Si el plan nuevo tiene límite de usuarios y los miembros más las invitaciones
-- pendientes lo superan, se borran las invitaciones pendientes (los miembros
-- actuales se conservan; simplemente no se podrán añadir más).
CREATE FUNCTION platform_set_tenant_plan(p_admin_user_id uuid, p_tenant_id uuid, p_plan text)
  RETURNS TABLE (tenant_id uuid, plan_code text, previous_plan text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_previous  text;
  v_max_users integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins a WHERE a.user_id = p_admin_user_id) THEN
    RAISE EXCEPTION 'not a platform admin' USING ERRCODE = '42501';
  END IF;

  SELECT s.plan_code INTO v_previous FROM subscriptions s WHERE s.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_previous IS DISTINCT FROM p_plan THEN
    UPDATE subscriptions SET plan_code = p_plan, updated_at = now() WHERE tenant_id = p_tenant_id;
    INSERT INTO plan_changes (tenant_id, from_plan, to_plan, changed_by)
    VALUES (p_tenant_id, v_previous, p_plan, p_admin_user_id);

    SELECT p.max_users INTO v_max_users FROM plans p WHERE p.code = p_plan;
    IF v_max_users IS NOT NULL AND
       (SELECT count(*) FROM memberships m WHERE m.tenant_id = p_tenant_id)
       + (SELECT count(*) FROM invitations i WHERE i.tenant_id = p_tenant_id AND i.accepted_at IS NULL)
       > v_max_users THEN
      DELETE FROM invitations i WHERE i.tenant_id = p_tenant_id AND i.accepted_at IS NULL;
    END IF;
  END IF;

  RETURN QUERY SELECT p_tenant_id, p_plan, v_previous;
END;
$$;

REVOKE ALL ON FUNCTION platform_is_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_set_tenant_plan(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_is_admin(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION platform_set_tenant_plan(uuid, uuid, text) TO app_user;
