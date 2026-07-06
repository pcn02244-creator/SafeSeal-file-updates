-- ═══════════════════════════════════════════════════════
-- SafeSeal 파트 단가 관리 시스템 - Supabase 스키마
-- Supabase 대시보드 → SQL Editor에서 실행
-- ═══════════════════════════════════════════════════════

create table if not exists parts (
  id int primary key,
  type text,
  part_number text unique not null,
  description text,
  mfg text,
  qty_threshold int default 0,
  unit text default 'EA',
  price_as_is float8 default 0,
  price_to_be float8 default 0,
  onhand_qty int default 0,
  iones_code text,
  sajup_received int default 0,
  sajup_used int default 0,
  created_at text
);

create table if not exists usage (
  id int primary key,
  date text,
  part_number text,
  quantity int default 0,
  note text,
  team text,
  source text,
  created_at text
);

create table if not exists lots (
  id int primary key,
  part_number text,
  part_type text,
  po_number text,
  supplier text,
  iones_code text,
  ordered_qty int default 0,
  lot_remaining int default 0,
  purchase_price float8 default 0,
  selling_price float8 default 0,
  lot_status text default 'pending',
  order_date text,
  source text,
  created_at text
);

create table if not exists process_costs (
  key text primary key,
  name text,
  usd float8,
  krw float8
);

create table if not exists master_jobs (
  order_no text primary key,
  pn text,
  sn text,
  po text,
  tkm_no text,
  cln_date text,
  synced_at text
);

create table if not exists shipments (
  id int primary key,
  po text not null,
  ship_date text,
  ptn_no text,
  ptn_filename text,
  ptn_text text,
  ptn_uploaded_at text,
  notes text,
  created_at text
);

-- anon 키로 읽기/쓰기 허용
grant select, insert, update, delete on parts to anon;
grant select, insert, update, delete on usage to anon;
grant select, insert, update, delete on lots to anon;
grant select, insert, update, delete on process_costs to anon;
grant select, insert, update, delete on master_jobs to anon;
grant select, insert, update, delete on shipments to anon;
