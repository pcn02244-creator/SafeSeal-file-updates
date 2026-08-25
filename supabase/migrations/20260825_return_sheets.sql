-- ============================================================
-- Return Sheet Upload 기능 — 신규 테이블
-- 생성일: 2026-08-25
-- ============================================================

-- 테이블 1: 이미지 메타데이터 (Storage 경로)
CREATE TABLE IF NOT EXISTS return_sheet_images (
  id           SERIAL PRIMARY KEY,
  storage_path TEXT    NOT NULL,          -- Supabase Storage 경로
  filename     TEXT    NOT NULL,          -- 원본 파일명
  file_size    INTEGER,                   -- bytes
  uploaded_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 테이블 2: OCR 결과 + 매칭 결과 + 상태
CREATE TABLE IF NOT EXISTS return_sheets (
  id              SERIAL PRIMARY KEY,
  image_id        INTEGER REFERENCES return_sheet_images(id) ON DELETE SET NULL,

  -- [A] OCR 원본 추출값 (Claude 반환값 그대로, 수정 전)
  ocr_po          TEXT,
  ocr_sn          TEXT,
  ocr_tkm_no      TEXT,
  ocr_raw         JSONB,

  -- [B] 사용자 확정값 (수정 없으면 ocr_* 와 동일)
  po              TEXT,
  sn              TEXT,
  tkm_no          TEXT,

  -- [C] 매칭 결과
  matched_order_no   TEXT,
  matched_pn         TEXT,
  matched_batch_date TEXT,
  match_candidates   JSONB,              -- ambiguous 시 전체 후보 목록
  master_tkm_was_empty BOOLEAN DEFAULT FALSE, -- 매칭 시 DB tkm_no가 비어있었는지

  -- [D] Master 반영 전후 스냅샷 (감사 추적)
  master_before   JSONB,                 -- {"po":"..","sn":"..","tkm_no":".."}
  master_after    JSONB,                 -- {"po":"..","sn":"..","tkm_no":".."}

  -- [E] 상태 (전체 생명주기)
  -- 'ocr_pending'|'ocr_failed'|'not_found'|'mismatch_sn'|'mismatch_tkm'
  -- |'ambiguous'|'matched'|'duplicate'|'review_required'|'applied'
  match_status    TEXT NOT NULL DEFAULT 'ocr_pending',

  -- [F] 적용 상태
  applied         BOOLEAN DEFAULT FALSE,
  applied_at      TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스 (조회 성능)
CREATE INDEX IF NOT EXISTS idx_return_sheets_po      ON return_sheets(po);
CREATE INDEX IF NOT EXISTS idx_return_sheets_sn      ON return_sheets(sn);
CREATE INDEX IF NOT EXISTS idx_return_sheets_status  ON return_sheets(match_status, applied);
CREATE INDEX IF NOT EXISTS idx_return_sheets_created ON return_sheets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rsi_uploaded          ON return_sheet_images(uploaded_at DESC);

-- ============================================================
-- Storage 버킷: return-sheets
-- ▸ Supabase Dashboard > Storage > New Bucket
--   버킷명: return-sheets
--   Public: OFF (Private)
-- ▸ RLS 정책: authenticated 사용자 업로드/다운로드 허용
--   또는 anon key로 접근 허용 (내부 도구이므로 anon 허용 가능)
-- ============================================================
