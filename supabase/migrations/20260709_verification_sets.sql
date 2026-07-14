-- verification_sets: 바코드 3종 검증 세트
-- master_jobs + shipments 조인 결과를 사전 구성해 모바일 스캐너에서 빠르게 조회

CREATE TABLE IF NOT EXISTS verification_sets (
  order_no   TEXT PRIMARY KEY,
  po         TEXT NOT NULL,
  sn         TEXT NOT NULL DEFAULT '',
  ptn_no     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vsets_po ON verification_sets (po);
