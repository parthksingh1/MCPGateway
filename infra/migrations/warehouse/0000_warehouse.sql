-- Analytics warehouse.
--
-- Deliberately a separate database from the control plane: the warehouse holds
-- customer data that the gateway's own tables have no business being able to
-- read, and separating them makes that structural rather than aspirational.

CREATE TABLE IF NOT EXISTS customers (
  id          bigint PRIMARY KEY,
  tenant_id   text NOT NULL,
  territory   text NOT NULL,
  name        text NOT NULL,
  email       text NOT NULL,
  phone       text,
  city        text NOT NULL,
  country     text NOT NULL,
  segment     text NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id         bigint PRIMARY KEY,
  tenant_id  text NOT NULL,
  sku        text NOT NULL,
  name       text NOT NULL,
  category   text NOT NULL,
  unit_price numeric(10, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id           bigint PRIMARY KEY,
  tenant_id    text NOT NULL,
  territory    text NOT NULL,
  customer_id  bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_date   timestamptz NOT NULL,
  status       text NOT NULL,
  channel      text NOT NULL,
  total_amount numeric(12, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id         bigint PRIMARY KEY,
  order_id   bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id),
  quantity   integer NOT NULL,
  unit_price numeric(10, 2) NOT NULL,
  line_total numeric(12, 2) NOT NULL
);

CREATE INDEX IF NOT EXISTS customers_tenant_idx ON customers (tenant_id, territory);
CREATE INDEX IF NOT EXISTS products_tenant_idx ON products (tenant_id, category);
CREATE INDEX IF NOT EXISTS orders_tenant_date_idx ON orders (tenant_id, order_date DESC);
CREATE INDEX IF NOT EXISTS orders_territory_idx ON orders (tenant_id, territory);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

-- ---------------------------------------------------------------------------
-- Roles mirrored from the application
-- ---------------------------------------------------------------------------
--
-- This is where "no service-account escalation" stops being a claim about the
-- application and becomes a property of the database.
--
-- The warehouse server holds one connection pool, but before running any
-- statement on behalf of a caller it issues, inside the transaction:
--
--     SET LOCAL ROLE app_<role>;
--     SET LOCAL app.tenant_id  = '<tenant from the token>';
--     SET LOCAL app.territory  = '<territory from the token>';
--
-- The row-level security policies below are then evaluated by Postgres against
-- those settings. If the application layer forgets a WHERE clause — or is
-- talked into dropping one — the database still returns only the rows that
-- caller is entitled to. Every value comes from the verified downstream token,
-- never from a tool argument.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_manager') THEN
    CREATE ROLE app_manager NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_analyst') THEN
    CREATE ROLE app_analyst NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_viewer') THEN
    CREATE ROLE app_viewer NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_admin, app_manager, app_analyst, app_viewer;
GRANT SELECT ON customers, products, orders, order_items
  TO app_admin, app_manager, app_analyst, app_viewer;

-- Membership so the pool's login role can assume each application role.
GRANT app_admin, app_manager, app_analyst, app_viewer TO CURRENT_USER;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- FORCE is essential: without it the table owner (the pool's login role)
-- bypasses every policy, and the whole mechanism becomes decorative.

ALTER TABLE customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers   FORCE  ROW LEVEL SECURITY;
ALTER TABLE products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE products    FORCE  ROW LEVEL SECURITY;
ALTER TABLE orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders      FORCE  ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE  ROW LEVEL SECURITY;

-- Admins and managers see their whole tenant.
DROP POLICY IF EXISTS customers_tenant_wide ON customers;
CREATE POLICY customers_tenant_wide ON customers FOR SELECT TO app_admin, app_manager
  USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS orders_tenant_wide ON orders;
CREATE POLICY orders_tenant_wide ON orders FOR SELECT TO app_admin, app_manager
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Analysts and viewers see only their own territory within their tenant. This
-- is what makes the difference between Alice and Bob visible in real data
-- rather than only in the shape of their tokens.
DROP POLICY IF EXISTS customers_own_territory ON customers;
CREATE POLICY customers_own_territory ON customers FOR SELECT TO app_analyst, app_viewer
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND territory = current_setting('app.territory', true)
  );

DROP POLICY IF EXISTS orders_own_territory ON orders;
CREATE POLICY orders_own_territory ON orders FOR SELECT TO app_analyst, app_viewer
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND territory = current_setting('app.territory', true)
  );

-- The product catalogue is tenant-scoped but not territory-scoped: it is
-- reference data, and slicing it by territory would only make joins confusing.
DROP POLICY IF EXISTS products_tenant ON products;
CREATE POLICY products_tenant ON products FOR SELECT
  TO app_admin, app_manager, app_analyst, app_viewer
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Line items inherit visibility from their order, so a row the caller cannot
-- see the order for is not reachable through the join either.
DROP POLICY IF EXISTS order_items_via_order ON order_items;
CREATE POLICY order_items_via_order ON order_items FOR SELECT
  TO app_admin, app_manager, app_analyst, app_viewer
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id));
