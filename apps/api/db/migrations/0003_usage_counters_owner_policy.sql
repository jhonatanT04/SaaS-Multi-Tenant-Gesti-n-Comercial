-- 0003: la 0002 olvidó la política del dueño en `usage_counters`. Con FORCE ROW
-- LEVEL SECURITY el rol `migrator` (soporte, tests, correcciones manuales de
-- uso) no podía escribir en ella. Igual que en el resto de tablas de plataforma,
-- solo aplica al rol `migrator`, que la API nunca usa para conectarse.
CREATE POLICY platform_definer ON usage_counters TO migrator USING (true) WITH CHECK (true);
