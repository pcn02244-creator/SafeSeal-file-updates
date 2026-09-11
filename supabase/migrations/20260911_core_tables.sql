-- ══════════════════════════════════════════════════════════════
-- 핵심 데이터 테이블 생성 (parts / usage / lots / process_costs)
-- Supabase Dashboard > SQL Editor 에서 실행
-- ══════════════════════════════════════════════════════════════

-- ── parts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parts (
  id               INTEGER PRIMARY KEY,
  type             TEXT,
  part_number      TEXT UNIQUE NOT NULL,
  description      TEXT,
  mfg              TEXT,
  iones_code       TEXT,
  qty_threshold    INTEGER  DEFAULT 0,
  unit             TEXT     DEFAULT 'EA',
  unit_size        NUMERIC  DEFAULT 1,
  price_as_is      NUMERIC  DEFAULT 0,
  price_to_be      NUMERIC  DEFAULT 0,
  onhand_qty       INTEGER  DEFAULT 0,
  sajup_received   INTEGER  DEFAULT 0,
  sajup_used       INTEGER  DEFAULT 0,
  alt_numbers      JSONB,
  created_at       TEXT
);

-- ── usage ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage (
  id           INTEGER PRIMARY KEY,
  date         TEXT,
  part_number  TEXT,
  quantity     INTEGER,
  note         TEXT,
  team         TEXT,
  source       TEXT DEFAULT 'manual',
  created_at   TEXT
);

-- ── lots ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lots (
  id              INTEGER PRIMARY KEY,
  po_number       TEXT,
  supplier        TEXT,
  iones_code      TEXT,
  part_number     TEXT,
  ordered_qty     INTEGER,
  purchase_price  NUMERIC DEFAULT 0,
  selling_price   NUMERIC DEFAULT 0,
  order_date      TEXT,
  source          TEXT DEFAULT 'manual',
  created_at      TEXT
);

-- ── process_costs ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS process_costs (
  key   TEXT PRIMARY KEY,
  name  TEXT,
  usd   NUMERIC,
  krw   INTEGER
);

-- ══════════════════════════════════════════════════════════════
-- RLS (Row Level Security) — 비로그인 사용자도 읽기/쓰기 허용
-- (앱 인증은 Express 세션이 담당, Supabase Auth 미사용)
-- ══════════════════════════════════════════════════════════════

ALTER TABLE parts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_costs ENABLE ROW LEVEL SECURITY;

-- 이미 정책이 있으면 삭제 후 재생성
DROP POLICY IF EXISTS "allow_all" ON parts;
DROP POLICY IF EXISTS "allow_all" ON usage;
DROP POLICY IF EXISTS "allow_all" ON lots;
DROP POLICY IF EXISTS "allow_all" ON process_costs;

CREATE POLICY "allow_all" ON parts         FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON usage         FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON lots          FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON process_costs FOR ALL USING (true) WITH CHECK (true);
