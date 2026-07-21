-- 외부 견적 임포트 단가 저장 테이블
-- 외부 앱(Excel)에서 생성된 견적의 PO·PTN·단가·수량을 보관
-- 거래명세서 생성 시 이 테이블을 우선 참조
CREATE TABLE IF NOT EXISTS ext_quote_lines (
  id          BIGSERIAL PRIMARY KEY,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  batch_date  TEXT,
  po          TEXT NOT NULL,
  ptn_no      TEXT,
  sn          TEXT,
  pn          TEXT,
  order_no    TEXT,
  unit_price  FLOAT8 NOT NULL DEFAULT 0,
  qty         INT    NOT NULL DEFAULT 1,
  total_price FLOAT8,
  source_file TEXT
);

CREATE INDEX IF NOT EXISTS idx_eql_po         ON ext_quote_lines(po);
CREATE INDEX IF NOT EXISTS idx_eql_order_no   ON ext_quote_lines(order_no);
CREATE INDEX IF NOT EXISTS idx_eql_imported   ON ext_quote_lines(imported_at DESC);

-- anon 키 (GitHub Pages 프론트엔드) 권한
GRANT SELECT, INSERT, UPDATE, DELETE ON ext_quote_lines TO anon;
GRANT USAGE, SELECT ON SEQUENCE ext_quote_lines_id_seq  TO anon;
