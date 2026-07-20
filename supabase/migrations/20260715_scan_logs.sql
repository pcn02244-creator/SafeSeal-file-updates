-- 바코드 스캔 PASS 이력 테이블
CREATE TABLE IF NOT EXISTS scan_logs (
  id         BIGSERIAL PRIMARY KEY,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  po         TEXT,
  pkg_id     TEXT,
  sn         TEXT,
  order_no   TEXT,
  batch_date TEXT,
  result     TEXT NOT NULL DEFAULT 'PASS'
);

CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_at ON scan_logs(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_logs_po         ON scan_logs(po);

-- anon 키 권한 (GitHub Pages 프론트엔드에서 insert/select 가능)
GRANT SELECT, INSERT ON scan_logs TO anon;
GRANT USAGE, SELECT ON SEQUENCE scan_logs_id_seq TO anon;
