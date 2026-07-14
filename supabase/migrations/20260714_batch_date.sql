-- 날짜별 배치 관리: master_jobs + verification_sets에 batch_date 추가

-- master_jobs: 배치 날짜 컬럼
ALTER TABLE master_jobs ADD COLUMN IF NOT EXISTS batch_date TEXT;
CREATE INDEX IF NOT EXISTS idx_master_jobs_batch ON master_jobs(batch_date);
UPDATE master_jobs SET batch_date = LEFT(synced_at, 10) WHERE batch_date IS NULL;

-- verification_sets: batch_date 추가 + PK → (order_no, batch_date) 복합키로 변경
ALTER TABLE verification_sets
  ADD COLUMN IF NOT EXISTS batch_date TEXT NOT NULL DEFAULT '2026-07-14';
UPDATE verification_sets SET batch_date = LEFT(created_at::text, 10) WHERE batch_date = '2026-07-14';
ALTER TABLE verification_sets DROP CONSTRAINT IF EXISTS verification_sets_pkey;
ALTER TABLE verification_sets ADD PRIMARY KEY (order_no, batch_date);
CREATE INDEX IF NOT EXISTS idx_vsets_po_batch ON verification_sets(po, batch_date);
CREATE INDEX IF NOT EXISTS idx_vsets_batch    ON verification_sets(batch_date);
