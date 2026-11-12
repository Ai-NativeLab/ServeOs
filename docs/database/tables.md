# Database Tables Reference

Every table, column and enum in the current schema. **This file is generated** from the latest Drizzle snapshot (`drizzle/meta/<latest>_snapshot.json`, which `drizzle-kit generate` confirms matches the `pgTable`/`pgEnum` definitions under `src/**/schema.ts`) plus the `ENABLE` / `FORCE ROW LEVEL SECURITY` and `CREATE POLICY` statements in `drizzle/*.sql`. Regenerate it after a schema change instead of editing it by hand.

## How tenancy works in the schema

- **RLS:** tenant tables have `ENABLE` **and** `FORCE ROW LEVEL SECURITY` and one `<table>_isolation` policy:
  ```sql
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  ```
- **Setting the tenant:** `withTenant(tenantId, tx => …)` (`src/db/with-tenant.ts`) opens a transaction and runs `SELECT set_config('app.tenant_id', $1, true)` (transaction-local). Outside `withTenant` the setting is empty, so RLS tables return no rows.
- **Tables without RLS** are control-plane or global tables (tenants, auth, plans/billing, POS device/session plumbing, idempotency receipts, email events, enquiries, WhatsApp accounts). Server code reads and writes them directly; several still carry a `tenant_id` column.
- **Conventions visible in the schema:** bilingual fields are separate `*_en` / `*_ar` text columns (not JSON); money is `numeric`; every timestamp is `timestamp with time zone`; there is no soft-delete (`deleted_at`) column anywhere; 65 of 72 tables use a `uuid` primary key defaulting to `gen_random_uuid()`.

<!-- Generated from drizzle/meta/0045_snapshot.json and the RLS statements in drizzle/*.sql. Do not hand-edit; regenerate. -->

**72 tables, 36 enums** in the latest Drizzle snapshot (`drizzle/meta/0045_snapshot.json`).

- **52 tables have RLS enabled** (every one of them also `FORCE ROW LEVEL SECURITY`: True).
- **20 tables have no RLS** (control-plane / global tables, read and written only through server code): `audit_logs`, `email_events`, `invoices`, `onboarding_applications`, `plan_enquiries`, `plans`, `pos_cashier_sessions`, `pos_devices`, `pos_grants`, `pos_order_receipts`, `pos_pairing_codes`, `pos_sync_event_receipts`, `roles`, `sessions`, `subscriptions`, `tenants`, `usage_counters`, `user_roles`, `users`, `whatsapp_accounts`.

## Enums

| Enum | Values | Defined in |
|---|---|---|
| `application_status` | `pending`, `approved`, `rejected` | `src/server/onboarding/schema.ts` |
| `audit_actor_type` | `user`, `system`, `device`, `customer` | `src/server/audit/schema.ts` |
| `cash_count_kind` | `opening`, `closing`, `mid_shift` | `src/server/pos/shift-schema.ts` |
| `cash_movement_type` | `pay_in`, `pay_out`, `safe_drop`, `no_sale` | `src/server/pos/shift-schema.ts` |
| `customer_status` | `active`, `disabled` | `src/server/customers/schema.ts` |
| `email_event_type` | `delivered`, `bounced`, `complained`, `opened` | `src/server/notifications/schema.ts` |
| `fulfillment_type` | `pickup`, `delivery` | `src/server/ordering/schema.ts` |
| `inventory_item_kind` | `ingredient`, `finished_good`, `raw_material` | `src/server/inventory/schema.ts` |
| `invoice_status` | `open`, `pending_verification`, `paid`, `void` | `src/server/billing/schema.ts` |
| `notification_severity` | `info`, `warning`, `critical` | `src/server/notifications/schema.ts` |
| `notification_type` | `low_stock`, `reorder_suggested`, `po_sent`, `po_received`, `shift_variance`, `reconciliation_exception`, `refund_issued`, `system_alert` | `src/server/notifications/schema.ts` |
| `order_channel` | `web`, `pos`, `whatsapp` | `src/server/ordering/schema.ts` |
| `order_status` | `pending`, `confirmed`, `preparing`, `ready`, `out_for_delivery`, `completed`, `rejected`, `cancelled` | `src/server/ordering/schema.ts` |
| `outbox_status` | `queued`, `sending`, `sent`, `failed` | `src/server/notifications/schema.ts` |
| `payment_method` | `cash`, `instapay`, `vodafone_cash`, `mobile_wallet` | `src/server/ordering/schema.ts` |
| `payment_status` | `unpaid`, `pending_verification`, `partially_paid`, `paid`, `refunded`, `partially_refunded` | `src/server/ordering/schema.ts` |
| `po_status` | `draft`, `sent`, `partially_received`, `received`, `closed`, `cancelled` | `src/server/purchasing/schema.ts` |
| `pos_adjustment_type` | `line_discount`, `order_discount`, `line_void`, `order_void` | `src/server/pos/tender-schema.ts` |
| `pos_shift_status` | `open`, `closed` | `src/server/pos/shift-schema.ts` |
| `pos_tender_method` | `cash`, `card`, `other` | `src/server/pos/tender-schema.ts` |
| `prescription_status` | `pending`, `approved`, `rejected` | `src/server/prescriptions/schema.ts` |
| `product_inventory_link_type` | `recipe`, `finished_good` | `src/server/inventory/schema.ts` |
| `refund_kind` | `full`, `partial` | `src/server/pos/refund-schema.ts` |
| `refund_method` | `cash`, `card`, `store_credit`, `other` | `src/server/pos/refund-schema.ts` |
| `rx_review_status` | `not_required`, `pending`, `approved`, `rejected` | `src/server/ordering/schema.ts` |
| `stock_count_status` | `open`, `committed`, `cancelled` | `src/server/inventory/schema.ts` |
| `stock_ledger_type` | `receive`, `sale_deduction`, `adjustment`, `count`, `transfer`, `waste`, `refund_restock`, `production` | `src/server/inventory/schema.ts` |
| `storage_location_kind` | `kitchen`, `retail`, `back_of_house`, `transit` | `src/server/inventory/schema.ts` |
| `subscription_status` | `trialing`, `active`, `past_due`, `suspended`, `canceled` | `src/server/subscription/schema.ts` |
| `tenant_status` | `onboarding`, `trial`, `active`, `suspended`, `rejected` | `src/server/tenancy/schema.ts` |
| `unit_of_measure` | `each`, `g`, `kg`, `ml`, `l`, `m`, `m2`, `bf` | `src/server/catalog/uom.ts` |
| `vertical` | `restaurant`, `retail`, `pharmacy`, `timber` | `src/server/tenancy/schema.ts` |
| `whatsapp_account_status` | `active`, `disconnected`, `suspended` | `src/server/whatsapp/schema.ts` |
| `whatsapp_conversation_state` | `idle`, `branch`, `categories`, `products`, `variant`, `cart`, `fulfillment`, `contact`, `confirm`, `placed` | `src/server/whatsapp/schema.ts` |
| `whatsapp_direction` | `inbound`, `outbound` | `src/server/whatsapp/schema.ts` |
| `whatsapp_status_queue_status` | `queued`, `sent`, `skipped`, `failed` | `src/server/whatsapp/schema.ts` |

## Tables

Columns are listed as they exist in Postgres (snake_case). `NN` = NOT NULL. FK = foreign key (`→ table.column`, with the ON DELETE action when it is not `no action`).

### `src/server/audit/schema.ts`

#### `audit_chain_heads`

RLS: enabled + forced (policy `audit_chain_heads_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `tenant_id` | uuid | yes |  | PK; FK → `tenants.id` (cascade) |
| `seq` | bigint | yes |  |  |
| `head_hash` | char(64) | yes |  |  |
| `updated_at` | timestamp with time zone | yes | `now()` |  |

#### `audit_events`

RLS: enabled + forced (policy `audit_events_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid |  |  | FK → `branches.id` (set null) |
| `actor_user_id` | uuid |  |  | FK → `users.id` |
| `actor_type` | enum `audit_actor_type` | yes |  |  |
| `action` | text | yes |  |  |
| `entity_type` | text | yes |  |  |
| `entity_id` | text | yes |  |  |
| `summary` | text | yes |  |  |
| `metadata` | jsonb | yes | `'{}'::jsonb` |  |
| `fingerprint` | jsonb | yes | `'{}'::jsonb` |  |
| `seq` | bigint | yes |  |  |
| `prev_hash` | char(64) | yes |  |  |
| `entry_hash` | char(64) | yes |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(tenant_id, seq)`

### `src/server/auth/schema.ts`

#### `roles`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid |  |  | FK → `tenants.id` (cascade) |
| `key` | text | yes |  |  |
| `name` | text | yes |  |  |

Unique: `(tenant_id, key)`; `(key WHERE "roles"."tenant_id" IS NULL)`

#### `sessions`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | text | yes |  | PK |
| `user_id` | uuid | yes |  | FK → `users.id` (cascade) |
| `user_agent` | text |  |  |  |
| `expires_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `user_roles`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `user_id` | uuid | yes |  | FK → `users.id` (cascade) |
| `role_id` | uuid | yes |  | FK → `roles.id` (cascade) |

Unique: `(user_id, role_id)`

#### `users`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid |  |  | FK → `tenants.id` (cascade) |
| `name` | text | yes |  |  |
| `email` | text |  |  |  |
| `phone` | text |  |  |  |
| `password_hash` | text |  |  |  |
| `locale` | text | yes | `'ar'` |  |
| `status` | text | yes | `'active'` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(tenant_id, email)`; `(tenant_id, phone)`; `(email WHERE "users"."tenant_id" IS NULL)`; `(phone WHERE "users"."tenant_id" IS NULL)`

### `src/server/banners/schema.ts`

#### `banners`

RLS: enabled + forced (policy `banners_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `title_en` | text |  |  |  |
| `title_ar` | text |  |  |  |
| `image_url` | text | yes |  |  |
| `link_url` | text |  |  |  |
| `is_active` | boolean | yes | `True` |  |
| `sort_order` | integer | yes | `0` |  |
| `starts_at` | timestamp with time zone |  |  |  |
| `ends_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

### `src/server/billing/schema.ts`

#### `invoices`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `subscription_id` | uuid | yes |  | FK → `subscriptions.id` (cascade) |
| `plan_id` | uuid |  |  | FK → `plans.id` |
| `amount` | numeric | yes |  |  |
| `currency` | text | yes |  |  |
| `status` | enum `invoice_status` | yes | `'open'` |  |
| `method` | text |  |  |  |
| `payment_reference` | text |  |  |  |
| `payment_proof_url` | text |  |  |  |
| `provider_ref` | text |  |  |  |
| `marked_by` | uuid |  |  | FK → `users.id` |
| `paid_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(tenant_id WHERE status in ('open','pending_verification'))`

### `src/server/branches/schema.ts`

#### `branches`

RLS: enabled + forced (policy `branches_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `name` | text | yes |  |  |
| `address` | text |  |  |  |
| `phone` | text |  |  |  |
| `reply_to_email` | text |  |  |  |
| `is_active` | boolean | yes | `True` |  |
| `accepting_orders` | boolean | yes | `True` |  |
| `opening_hours` | jsonb | yes | `'[]'::jsonb` |  |
| `sort_order` | integer | yes | `0` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `delivery_areas`

RLS: enabled + forced (policy `delivery_areas_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (cascade) |
| `name_en` | text | yes |  |  |
| `name_ar` | text | yes |  |  |
| `delivery_fee` | numeric | yes | `'0'` |  |
| `min_order_amount` | numeric | yes | `'0'` |  |
| `eta_minutes` | integer |  |  |  |
| `is_active` | boolean | yes | `True` |  |
| `sort_order` | integer | yes | `0` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

### `src/server/catalog/schema.ts`

#### `branch_product_availability`

RLS: enabled + forced (policy `bpa_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (cascade) |
| `product_id` | uuid | yes |  | FK → `products.id` (cascade) |
| `is_available` | boolean | yes | `True` |  |
| `price_override` | numeric |  |  |  |

Unique: `(branch_id, product_id)`

#### `catalog_versions`

RLS: enabled + forced (policy `catalog_versions_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `tenant_id` | uuid | yes |  | PK; FK → `tenants.id` (cascade) |
| `version` | bigint | yes |  |  |

#### `categories`

RLS: enabled + forced (policy `categories_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `name_en` | text | yes |  |  |
| `name_ar` | text | yes |  |  |
| `description_en` | text |  |  |  |
| `description_ar` | text |  |  |  |
| `image_url` | text |  |  |  |
| `sort_order` | integer | yes | `0` |  |
| `is_active` | boolean | yes | `True` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `modifier_groups`

RLS: enabled + forced (policy `modifier_groups_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `product_id` | uuid | yes |  | FK → `products.id` (cascade) |
| `name_en` | text | yes |  |  |
| `name_ar` | text | yes |  |  |
| `required` | boolean | yes | `False` |  |
| `min_selections` | integer | yes | `0` |  |
| `max_selections` | integer | yes | `1` |  |
| `sort_order` | integer | yes | `0` |  |

#### `modifier_options`

RLS: enabled + forced (policy `modifier_options_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `modifier_group_id` | uuid | yes |  | FK → `modifier_groups.id` (cascade) |
| `name_en` | text | yes |  |  |
| `name_ar` | text | yes |  |  |
| `price_delta` | numeric | yes | `'0'` |  |
| `is_default` | boolean | yes | `False` |  |
| `sort_order` | integer | yes | `0` |  |

#### `product_variants`

RLS: enabled + forced (policy `product_variants_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `product_id` | uuid | yes |  | FK → `products.id` (cascade) |
| `name_en` | text | yes |  |  |
| `name_ar` | text | yes |  |  |
| `sku` | text |  |  |  |
| `price` | numeric | yes |  |  |
| `stock_quantity` | integer |  |  |  |
| `is_active` | boolean | yes | `True` |  |
| `sort_order` | integer | yes | `0` |  |

#### `products`

RLS: enabled + forced (policy `products_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `category_id` | uuid | yes |  | FK → `categories.id` (restrict) |
| `name_en` | text | yes |  |  |
| `name_ar` | text | yes |  |  |
| `description_en` | text |  |  |  |
| `description_ar` | text |  |  |  |
| `unit_of_measure` | enum `unit_of_measure` |  |  |  |
| `base_price` | numeric | yes |  |  |
| `image_url` | text |  |  |  |
| `brand` | text |  |  |  |
| `sku` | text |  |  |  |
| `requires_prescription` | boolean | yes | `False` |  |
| `track_stock` | boolean | yes | `False` |  |
| `stock_quantity` | integer |  |  |  |
| `is_featured` | boolean | yes | `False` |  |
| `is_published` | boolean | yes | `False` |  |
| `sort_order` | integer | yes | `0` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

### `src/server/customers/schema.ts`

#### `customer_sessions`

RLS: enabled + forced (policy `customer_sessions_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `customer_id` | uuid | yes |  | FK → `customers.id` (cascade) |
| `token_hash` | text | yes |  |  |
| `user_agent` | text |  |  |  |
| `expires_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(token_hash)`

#### `customers`

RLS: enabled + forced (policy `customers_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `name` | text | yes |  |  |
| `email` | text | yes |  |  |
| `phone` | text |  |  |  |
| `password_hash` | text | yes |  |  |
| `default_address_text` | text |  |  |  |
| `trade_approved` | boolean | yes | `False` |  |
| `trade_discount_percent` | numeric |  |  |  |
| `status` | enum `customer_status` | yes | `'active'` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(tenant_id, email)`

### `src/server/enquiries/schema.ts`

#### `plan_enquiries`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `plan_key` | text | yes |  |  |
| `name` | text | yes |  |  |
| `business_name` | text | yes |  |  |
| `phone` | text | yes |  |  |
| `email` | text | yes |  |  |
| `locale` | text | yes |  |  |
| `ip` | text |  |  |  |
| `status` | text | yes | `'unsent'` |  |
| `last_error` | text |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |
| `sent_at` | timestamp with time zone |  |  |  |

### `src/server/inventory/schema.ts`

#### `inventory_items`

RLS: enabled + forced (policy `inventory_items_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `name_en` | text | yes |  |  |
| `name_ar` | text | yes |  |  |
| `sku` | text |  |  |  |
| `kind` | enum `inventory_item_kind` | yes |  |  |
| `base_uom` | enum `unit_of_measure` | yes |  |  |
| `stock_uom` | enum `unit_of_measure` | yes |  |  |
| `stock_to_base` | numeric | yes | `'1'` |  |
| `purchase_uom` | enum `unit_of_measure` | yes |  |  |
| `purchase_to_base` | numeric | yes | `'1'` |  |
| `recipe_uom` | enum `unit_of_measure` | yes |  |  |
| `recipe_to_base` | numeric | yes | `'1'` |  |
| `is_perishable` | boolean | yes | `False` |  |
| `default_unit_cost` | numeric |  |  |  |
| `is_active` | boolean | yes | `True` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `inventory_lots`

RLS: enabled + forced (policy `inventory_lots_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `item_id` | uuid | yes |  | FK → `inventory_items.id` (cascade) |
| `location_id` | uuid | yes |  | FK → `storage_locations.id` (restrict) |
| `lot_code` | text |  |  |  |
| `qty_received` | numeric | yes |  |  |
| `qty_remaining` | numeric | yes |  |  |
| `unit_cost` | numeric | yes | `'0'` |  |
| `supplier_id` | uuid |  |  |  |
| `po_receipt_line_id` | uuid |  |  |  |
| `received_at` | timestamp with time zone | yes | `now()` |  |
| `expiry_at` | timestamp with time zone |  |  |  |
| `length_mm` | numeric |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `product_inventory_links`

RLS: enabled + forced (policy `product_inventory_links_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `product_id` | uuid | yes |  | FK → `products.id` (cascade) |
| `variant_id` | uuid |  |  | FK → `product_variants.id` (cascade) |
| `link_type` | enum `product_inventory_link_type` | yes |  |  |
| `recipe_id` | uuid |  |  | FK → `recipes.id` (restrict) |
| `item_id` | uuid |  |  | FK → `inventory_items.id` (restrict) |

#### `recipe_components`

RLS: enabled + forced (policy `recipe_components_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `recipe_id` | uuid | yes |  | FK → `recipes.id` (cascade) |
| `item_id` | uuid | yes |  | FK → `inventory_items.id` (restrict) |
| `qty` | numeric | yes |  |  |
| `uom` | enum `unit_of_measure` | yes |  |  |
| `waste_pct` | numeric | yes | `'0'` |  |

#### `recipes`

RLS: enabled + forced (policy `recipes_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `name_en` | text | yes |  |  |
| `name_ar` | text | yes |  |  |
| `yield_qty` | numeric | yes | `'1'` |  |
| `yield_uom` | enum `unit_of_measure` | yes | `'each'` |  |
| `is_active` | boolean | yes | `True` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `stock_count_lines`

RLS: enabled + forced (policy `stock_count_lines_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `count_id` | uuid | yes |  | FK → `stock_counts.id` (cascade) |
| `item_id` | uuid | yes |  | FK → `inventory_items.id` (restrict) |
| `system_qty` | numeric | yes |  |  |
| `counted_qty` | numeric | yes |  |  |
| `variance_qty` | numeric | yes |  |  |
| `note` | text |  |  |  |

#### `stock_counts`

RLS: enabled + forced (policy `stock_counts_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (cascade) |
| `location_id` | uuid | yes |  | FK → `storage_locations.id` (restrict) |
| `status` | enum `stock_count_status` | yes | `'open'` |  |
| `started_by_user_id` | uuid |  |  | FK → `users.id` |
| `committed_by_user_id` | uuid |  |  | FK → `users.id` |
| `started_at` | timestamp with time zone | yes | `now()` |  |
| `committed_at` | timestamp with time zone |  |  |  |

#### `stock_ledger`

RLS: enabled + forced (policy `stock_ledger_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `item_id` | uuid | yes |  | FK → `inventory_items.id` (restrict) |
| `location_id` | uuid | yes |  | FK → `storage_locations.id` (restrict) |
| `lot_id` | uuid |  |  | FK → `inventory_lots.id` (restrict) |
| `type` | enum `stock_ledger_type` | yes |  |  |
| `qty` | numeric | yes |  |  |
| `uom` | enum `unit_of_measure` | yes |  |  |
| `unit_cost` | numeric |  |  |  |
| `ref_type` | text |  |  |  |
| `ref_id` | text |  |  |  |
| `by_user_id` | uuid |  |  | FK → `users.id` |
| `note` | text |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `storage_locations`

RLS: enabled + forced (policy `storage_locations_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (cascade) |
| `name` | text | yes |  |  |
| `kind` | enum `storage_location_kind` | yes |  |  |
| `is_default` | boolean | yes | `False` |  |
| `is_active` | boolean | yes | `True` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(branch_id, kind WHERE is_default)`

### `src/server/notifications/schema.ts`

#### `email_events`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `provider` | text | yes |  |  |
| `provider_message_id` | text | yes |  |  |
| `provider_event_id` | text | yes |  |  |
| `event_type` | enum `email_event_type` | yes |  |  |
| `raw` | jsonb | yes |  |  |
| `received_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(provider, provider_event_id)`

#### `notification_outbox`

RLS: enabled + forced (policy `notification_outbox_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `to_email` | text | yes |  |  |
| `reply_to` | text |  |  |  |
| `subject` | text | yes |  |  |
| `template` | text | yes |  |  |
| `payload` | jsonb | yes |  |  |
| `status` | enum `outbox_status` | yes | `'queued'` |  |
| `attempts` | integer | yes | `0` |  |
| `next_attempt_at` | timestamp with time zone | yes | `now()` |  |
| `provider_message_id` | text |  |  |  |
| `last_error` | text |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |
| `sent_at` | timestamp with time zone |  |  |  |

#### `notifications`

RLS: enabled + forced (policy `notifications_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `user_id` | uuid |  |  | FK → `users.id` (cascade) |
| `target_role` | text |  |  |  |
| `type` | enum `notification_type` | yes |  |  |
| `severity` | enum `notification_severity` | yes |  |  |
| `title` | text | yes |  |  |
| `body` | text | yes |  |  |
| `entity_type` | text |  |  |  |
| `entity_id` | text |  |  |  |
| `read_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Checks: `notifications_target_present`

### `src/server/onboarding/schema.ts`

#### `onboarding_applications`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `status` | enum `application_status` | yes | `'pending'` |  |
| `submitted_at` | timestamp with time zone | yes | `now()` |  |
| `reviewed_by` | uuid |  |  | FK → `users.id` |
| `review_notes` | text |  |  |  |

### `src/server/ordering/schema.ts`

#### `order_items`

RLS: enabled + forced (policy `order_items_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `order_id` | uuid | yes |  | FK → `orders.id` (cascade) |
| `product_id` | uuid | yes |  |  |
| `variant_id` | uuid |  |  |  |
| `variant_name_en` | text |  |  |  |
| `variant_name_ar` | text |  |  |  |
| `name_en` | text | yes |  |  |
| `name_ar` | text | yes |  |  |
| `unit_base_price` | numeric | yes |  |  |
| `quantity` | integer | yes |  |  |
| `line_total` | numeric | yes |  |  |
| `discount_amount` | numeric | yes | `'0'` |  |
| `selected_modifiers` | jsonb | yes | `'[]'::jsonb` |  |
| `dimensions` | jsonb |  |  |  |

#### `order_status_events`

RLS: enabled + forced (policy `order_status_events_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `order_id` | uuid | yes |  | FK → `orders.id` (cascade) |
| `from_status` | enum `order_status` |  |  |  |
| `to_status` | enum `order_status` | yes |  |  |
| `changed_by_user_id` | uuid |  |  |  |
| `reason` | text |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `orders`

RLS: enabled + forced (policy `orders_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (restrict) |
| `order_number` | integer | yes |  |  |
| `status` | enum `order_status` | yes | `'pending'` |  |
| `fulfillment_type` | enum `fulfillment_type` | yes |  |  |
| `channel` | enum `order_channel` | yes | `'web'` |  |
| `payment_status` | enum `payment_status` | yes | `'unpaid'` |  |
| `payment_method` | enum `payment_method` | yes | `'cash'` |  |
| `payment_reference` | text |  |  |  |
| `payment_proof_url` | text |  |  |  |
| `payment_provider_ref` | text |  |  |  |
| `customer_name` | text | yes |  |  |
| `customer_phone` | text | yes |  |  |
| `notes` | text |  |  |  |
| `cashier_user_id` | uuid |  |  |  |
| `rx_review_status` | enum `rx_review_status` | yes | `'not_required'` |  |
| `customer_id` | uuid |  |  |  |
| `discount_amount` | numeric | yes | `'0'` |  |
| `discount_reason` | text |  |  |  |
| `delivery_area_id` | uuid |  |  |  |
| `delivery_area_name_snapshot` | text |  |  |  |
| `delivery_address_text` | text |  |  |  |
| `subtotal` | numeric | yes |  |  |
| `vat_rate_snapshot` | numeric | yes |  |  |
| `vat_amount` | numeric | yes |  |  |
| `service_charge_amount` | numeric |  |  |  |
| `delivery_fee` | numeric | yes | `'0'` |  |
| `total` | numeric | yes |  |  |
| `status_token` | text | yes |  |  |
| `scheduled_for` | timestamp with time zone |  |  |  |
| `cancel_reason` | text |  |  |  |
| `placed_at` | timestamp with time zone | yes | `now()` |  |
| `updated_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(status_token)`

### `src/server/payments/offline/methods.schema.ts`

#### `tenant_offline_methods`

RLS: enabled + forced (policy `tenant_offline_methods_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `type` | text | yes |  |  |
| `label` | text | yes |  |  |
| `pay_to_detail` | text |  |  |  |
| `enabled` | boolean | yes | `True` |  |
| `sort_order` | integer | yes | `0` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(tenant_id, type)`

### `src/server/platform/audit.schema.ts`

#### `audit_logs`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid |  |  | FK → `tenants.id` (set null) |
| `actor_user_id` | uuid |  |  | FK → `users.id` |
| `action` | text | yes |  |  |
| `target` | text |  |  |  |
| `metadata` | jsonb | yes | `'{}'::jsonb` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

### `src/server/pos/refund-schema.ts`

#### `refund_lines`

RLS: enabled + forced (policy `refund_lines_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `refund_id` | uuid | yes |  | FK → `refunds.id` (cascade) |
| `order_item_id` | uuid | yes |  | FK → `order_items.id` (cascade) |
| `quantity` | integer | yes |  |  |
| `amount` | numeric | yes |  |  |
| `restock` | boolean | yes | `False` |  |

#### `refund_payments`

RLS: enabled + forced (policy `refund_payments_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `refund_id` | uuid | yes |  | FK → `refunds.id` (cascade) |
| `method` | enum `refund_method` | yes |  |  |
| `amount` | numeric | yes |  |  |
| `reference` | text |  |  |  |
| `taken_by_user_id` | uuid | yes |  | FK → `users.id` |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `refunds`

RLS: enabled + forced (policy `refunds_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `order_id` | uuid | yes |  | FK → `orders.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (restrict) |
| `kind` | enum `refund_kind` | yes |  |  |
| `reason_code` | text | yes |  |  |
| `reason_text` | text |  |  |  |
| `total_amount` | numeric | yes |  |  |
| `by_user_id` | uuid | yes |  | FK → `users.id` |
| `authorized_by_user_id` | uuid |  |  | FK → `users.id` |
| `shift_id` | uuid |  |  |  |
| `client_refund_id` | text | yes |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(order_id, client_refund_id)`

### `src/server/pos/schema.ts`

#### `pos_cashier_sessions`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `token_hash` | text | yes |  | PK |
| `user_id` | uuid | yes |  | FK → `users.id` (cascade) |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `name` | text | yes |  |  |
| `permissions` | jsonb | yes |  |  |
| `expires_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `pos_devices`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (cascade) |
| `token` | text | yes |  |  |
| `label` | text | yes |  |  |
| `created_by_user_id` | uuid | yes |  | FK → `users.id` |
| `created_at` | timestamp with time zone | yes | `now()` |  |
| `last_seen_at` | timestamp with time zone |  |  |  |
| `revoked_at` | timestamp with time zone |  |  |  |

Unique: `(token)`

#### `pos_grants`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `token_hash` | text | yes |  | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `permission` | text | yes |  |  |
| `authorized_by_user_id` | uuid | yes |  | FK → `users.id` |
| `expires_at` | timestamp with time zone | yes |  |  |

#### `pos_order_receipts`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `device_id` | uuid | yes |  | FK → `pos_devices.id` (cascade) |
| `client_order_id` | text | yes |  |  |
| `order_id` | uuid | yes |  | FK → `orders.id` (cascade) |
| `order_number` | text | yes |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(device_id, client_order_id)`

#### `pos_pairing_codes`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (cascade) |
| `code` | text | yes |  |  |
| `label` | text | yes |  |  |
| `created_by_user_id` | uuid | yes |  | FK → `users.id` |
| `expires_at` | timestamp with time zone | yes |  |  |
| `used_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(code)`

#### `pos_sync_event_receipts`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `device_id` | uuid | yes |  | FK → `pos_devices.id` (cascade) |
| `event_id` | uuid | yes |  |  |
| `type` | text | yes |  |  |
| `seq` | integer |  |  |  |
| `result_json` | jsonb | yes |  |  |
| `occurred_at` | timestamp with time zone | yes |  |  |
| `received_at` | timestamp with time zone | yes | `now()` |  |
| `clock_skew_flagged` | boolean | yes | `False` |  |

Unique: `(device_id, event_id)`

### `src/server/pos/shift-schema.ts`

#### `cash_counts`

RLS: enabled + forced (policy `cash_counts_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `shift_id` | uuid | yes |  | FK → `pos_shifts.id` (cascade) |
| `kind` | enum `cash_count_kind` | yes |  |  |
| `counted_total` | numeric | yes |  |  |
| `denominations` | jsonb |  |  |  |
| `expected_total` | numeric | yes |  |  |
| `variance` | numeric | yes |  |  |
| `by_user_id` | uuid | yes |  | FK → `users.id` |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `cash_movements`

RLS: enabled + forced (policy `cash_movements_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `shift_id` | uuid | yes |  | FK → `pos_shifts.id` (cascade) |
| `type` | enum `cash_movement_type` | yes |  |  |
| `amount` | numeric | yes |  |  |
| `reason_code` | text | yes |  |  |
| `reason_text` | text |  |  |  |
| `by_user_id` | uuid | yes |  | FK → `users.id` |
| `authorized_by_user_id` | uuid |  |  | FK → `users.id` |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `pos_shifts`

RLS: enabled + forced (policy `pos_shifts_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (cascade) |
| `device_id` | uuid | yes |  | FK → `pos_devices.id` (cascade) |
| `opened_by_user_id` | uuid | yes |  | FK → `users.id` |
| `closed_by_user_id` | uuid |  |  | FK → `users.id` |
| `status` | enum `pos_shift_status` | yes | `'open'` |  |
| `opening_float` | numeric | yes |  |  |
| `opened_at` | timestamp with time zone | yes | `now()` |  |
| `closed_at` | timestamp with time zone |  |  |  |
| `client_shift_id` | uuid |  |  |  |

Unique: `(device_id WHERE status = 'open')`; `(device_id, client_shift_id WHERE client_shift_id IS NOT NULL)`

### `src/server/pos/tender-schema.ts`

#### `order_payments`

RLS: enabled + forced (policy `order_payments_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `order_id` | uuid | yes |  | FK → `orders.id` (cascade) |
| `method` | enum `pos_tender_method` | yes |  |  |
| `amount` | numeric | yes |  |  |
| `tip_amount` | numeric | yes | `'0'` |  |
| `tendered_amount` | numeric |  |  |  |
| `change_amount` | numeric |  |  |  |
| `reference` | text |  |  |  |
| `taken_by_user_id` | uuid | yes |  | FK → `users.id` |
| `shift_id` | uuid |  |  |  |
| `client_payment_id` | text | yes |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(order_id, client_payment_id)`

#### `pos_adjustment_events`

RLS: enabled + forced (policy `pos_adjustment_events_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `order_id` | uuid | yes |  | FK → `orders.id` (cascade) |
| `order_item_id` | uuid |  |  | FK → `order_items.id` (cascade) |
| `type` | enum `pos_adjustment_type` | yes |  |  |
| `amount` | numeric | yes |  |  |
| `reason_code` | text | yes |  |  |
| `reason_text` | text |  |  |  |
| `by_user_id` | uuid | yes |  | FK → `users.id` |
| `authorized_by_user_id` | uuid | yes |  | FK → `users.id` |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `pos_held_tickets`

RLS: enabled + forced (policy `pos_held_tickets_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (cascade) |
| `device_id` | uuid | yes |  | FK → `pos_devices.id` (cascade) |
| `cashier_user_id` | uuid | yes |  | FK → `users.id` |
| `label` | text | yes |  |  |
| `draft_json` | jsonb | yes |  |  |
| `client_ticket_id` | uuid |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |
| `updated_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(device_id, client_ticket_id WHERE client_ticket_id IS NOT NULL)`

### `src/server/prescriptions/schema.ts`

#### `prescriptions`

RLS: enabled + forced (policy `prescriptions_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `customer_id` | uuid | yes |  | FK → `customers.id` (cascade) |
| `order_id` | uuid |  |  | FK → `orders.id` (set null) |
| `image_path` | text | yes |  |  |
| `status` | enum `prescription_status` | yes | `'pending'` |  |
| `reviewed_by_user_id` | uuid |  |  | FK → `users.id` |
| `reviewed_at` | timestamp with time zone |  |  |  |
| `rejection_reason` | text |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

### `src/server/purchasing/reorder-schema.ts`

#### `reorder_rules`

RLS: enabled + forced (policy `reorder_rules_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `item_id` | uuid | yes |  | FK → `inventory_items.id` (cascade) |
| `location_id` | uuid | yes |  | FK → `storage_locations.id` (cascade) |
| `reorder_point` | numeric | yes |  |  |
| `reorder_qty` | numeric | yes |  |  |
| `preferred_supplier_id` | uuid |  |  | FK → `suppliers.id` |
| `last_alerted_at` | timestamp with time zone |  |  |  |
| `is_active` | boolean | yes | `True` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(item_id, location_id)`

### `src/server/purchasing/schema.ts`

#### `po_receipt_lines`

RLS: enabled + forced (policy `po_receipt_lines_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `po_receipt_id` | uuid | yes |  | FK → `po_receipts.id` (cascade) |
| `po_line_id` | uuid | yes |  | FK → `purchase_order_lines.id` |
| `item_id` | uuid | yes |  | FK → `inventory_items.id` |
| `received_qty` | numeric | yes |  |  |
| `uom` | enum `unit_of_measure` | yes |  |  |
| `unit_cost` | numeric | yes |  |  |
| `lot_code` | text |  |  |  |
| `expiry_at` | timestamp with time zone |  |  |  |

#### `po_receipts`

RLS: enabled + forced (policy `po_receipts_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `purchase_order_id` | uuid | yes |  | FK → `purchase_orders.id` (cascade) |
| `received_by_user_id` | uuid |  |  | FK → `users.id` |
| `supplier_delivery_note` | text |  |  |  |
| `note` | text |  |  |  |
| `received_at` | timestamp with time zone | yes | `now()` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `purchase_order_lines`

RLS: enabled + forced (policy `purchase_order_lines_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `po_id` | uuid | yes |  | FK → `purchase_orders.id` (cascade) |
| `item_id` | uuid | yes |  | FK → `inventory_items.id` |
| `qty_ordered` | numeric | yes |  |  |
| `uom` | enum `unit_of_measure` | yes |  |  |
| `unit_cost` | numeric | yes |  |  |
| `tax_rate` | numeric |  |  |  |
| `qty_received` | numeric | yes | `'0'` |  |

#### `purchase_orders`

RLS: enabled + forced (policy `purchase_orders_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `branch_id` | uuid | yes |  | FK → `branches.id` (cascade) |
| `supplier_id` | uuid | yes |  | FK → `suppliers.id` |
| `po_number` | integer | yes |  |  |
| `status` | enum `po_status` | yes | `'draft'` |  |
| `total` | numeric | yes | `'0'` |  |
| `invoice_total` | numeric |  |  |  |
| `currency` | text | yes | `'EGP'` |  |
| `sent_at` | timestamp with time zone |  |  |  |
| `expected_at` | timestamp with time zone |  |  |  |
| `created_by_user_id` | uuid |  |  | FK → `users.id` |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(tenant_id, po_number)`

#### `supplier_items`

RLS: enabled + forced (policy `supplier_items_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `supplier_id` | uuid | yes |  | FK → `suppliers.id` (cascade) |
| `item_id` | uuid | yes |  | FK → `inventory_items.id` (cascade) |
| `supplier_sku` | text |  |  |  |
| `last_unit_cost` | numeric |  |  |  |
| `pack_uom` | enum `unit_of_measure` |  |  |  |

Unique: `(supplier_id, item_id)`

#### `suppliers`

RLS: enabled + forced (policy `suppliers_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `name` | text | yes |  |  |
| `contact_name` | text |  |  |  |
| `email` | text |  |  |  |
| `phone` | text |  |  |  |
| `payment_terms` | text |  |  |  |
| `notes` | text |  |  |  |
| `is_active` | boolean | yes | `True` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

### `src/server/subscription/schema.ts`

#### `plans`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `key` | text | yes |  |  |
| `name` | text | yes |  |  |
| `price_monthly` | numeric | yes | `'0'` |  |
| `currency` | text | yes | `'EGP'` |  |
| `is_active` | text | yes | `'true'` |  |
| `limits` | jsonb | yes |  |  |
| `features` | jsonb | yes |  |  |

Unique: `(key)`

#### `subscriptions`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `plan_id` | uuid | yes |  | FK → `plans.id` |
| `status` | enum `subscription_status` | yes | `'trialing'` |  |
| `trial_ends_at` | timestamp with time zone |  |  |  |
| `current_period_start` | timestamp with time zone |  |  |  |
| `current_period_end` | timestamp with time zone |  |  |  |
| `provider` | text | yes | `'manual'` |  |
| `provider_subscription_id` | text |  |  |  |
| `provider_customer_id` | text |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

#### `usage_counters`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `metric` | text | yes |  |  |
| `period_start` | timestamp with time zone | yes |  |  |
| `count` | integer | yes | `0` |  |

### `src/server/tenancy/schema.ts`

#### `tenant_settings`

RLS: enabled + forced (policy `tenant_settings_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `data` | jsonb | yes | `'{}'::jsonb` |  |

#### `tenants`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `slug` | text | yes |  |  |
| `name` | text | yes |  |  |
| `status` | enum `tenant_status` | yes | `'onboarding'` |  |
| `country` | text | yes |  |  |
| `currency` | text | yes | `'EGP'` |  |
| `default_locale` | text | yes | `'ar'` |  |
| `timezone` | text | yes | `'Africa/Cairo'` |  |
| `contact_email` | text |  |  |  |
| `custom_domain` | text |  |  |  |
| `logo_url` | text |  |  |  |
| `cover_image_url` | text |  |  |  |
| `tagline` | text |  |  |  |
| `cuisine` | text |  |  |  |
| `primary_color` | text | yes | `'#0F172A'` |  |
| `theme` | text | yes | `'default'` |  |
| `vertical` | enum `vertical` | yes | `'restaurant'` |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(slug)`; `(custom_domain)`

### `src/server/whatsapp/schema.ts`

#### `cart_handoff_tokens`

RLS: enabled + forced (policy `cart_handoff_tokens_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `token` | text | yes |  |  |
| `wa_id` | text | yes |  |  |
| `branch_id` | uuid |  |  | FK → `branches.id` (set null) |
| `cart` | jsonb | yes |  |  |
| `expires_at` | timestamp with time zone | yes |  |  |
| `redeemed_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(token)`

#### `whatsapp_accounts`

RLS: **none**

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `waba_id` | text | yes |  |  |
| `phone_number_id` | text | yes |  |  |
| `display_phone_number` | text | yes |  |  |
| `token_ref` | text | yes |  |  |
| `status` | enum `whatsapp_account_status` | yes | `'active'` |  |
| `coexistence` | boolean | yes | `True` |  |
| `linked_at` | timestamp with time zone | yes | `now()` |  |
| `disconnected_at` | timestamp with time zone |  |  |  |

Unique: `(phone_number_id WHERE status = 'active')`

#### `whatsapp_conversations`

RLS: enabled + forced (policy `whatsapp_conversations_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `wa_id` | text | yes |  |  |
| `branch_id` | uuid |  |  | FK → `branches.id` (set null) |
| `state` | enum `whatsapp_conversation_state` | yes | `'idle'` |  |
| `state_version` | integer | yes | `0` |  |
| `cart` | jsonb | yes | `'[]'::jsonb` |  |
| `pending_product_id` | uuid |  |  |  |
| `customer_name` | text |  |  |  |
| `profile_name` | text |  |  |  |
| `last_inbound_at` | timestamp with time zone |  |  |  |
| `updated_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(tenant_id, wa_id)`

#### `whatsapp_messages`

RLS: enabled + forced (policy `whatsapp_messages_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `wa_id` | text | yes |  |  |
| `direction` | enum `whatsapp_direction` | yes |  |  |
| `provider_message_id` | text | yes |  |  |
| `payload` | jsonb |  |  |  |
| `delivery_status` | text |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(provider_message_id)`

#### `whatsapp_order_receipts`

RLS: enabled + forced (policy `whatsapp_order_receipts_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `conversation_id` | uuid | yes |  | FK → `whatsapp_conversations.id` (cascade) |
| `confirm_message_id` | text | yes |  |  |
| `order_id` | uuid |  |  | FK → `orders.id` (cascade) |
| `created_at` | timestamp with time zone | yes | `now()` |  |

Unique: `(conversation_id, confirm_message_id)`

#### `whatsapp_status_queue`

RLS: enabled + forced (policy `whatsapp_status_queue_isolation`)

| Column | Type | NN | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | yes | `gen_random_uuid()` | PK |
| `tenant_id` | uuid | yes |  | FK → `tenants.id` (cascade) |
| `order_id` | uuid | yes |  | FK → `orders.id` (cascade) |
| `wa_id` | text | yes |  |  |
| `body` | text | yes |  |  |
| `status` | enum `whatsapp_status_queue_status` | yes | `'queued'` |  |
| `skip_reason` | text |  |  |  |
| `attempts` | integer | yes | `0` |  |
| `next_attempt_at` | timestamp with time zone | yes | `now()` |  |
| `wamid` | text |  |  |  |
| `created_at` | timestamp with time zone | yes | `now()` |  |
| `sent_at` | timestamp with time zone |  |  |  |

