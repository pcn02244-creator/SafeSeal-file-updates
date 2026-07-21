-- parts 테이블에 price_override 컬럼 추가
-- 설정 시: 임계치(qty_threshold) 로직 무시하고 이 값을 강제 사용
-- 미설정(NULL) 시: 기존 as-is/to-be 로직 유지
ALTER TABLE parts ADD COLUMN IF NOT EXISTS price_override float8 DEFAULT NULL;

-- A0491889: 2025-12 lot 단가 261 확정 반영
UPDATE parts SET price_override = 261, price_as_is = 261, price_to_be = 261
WHERE part_number = 'A0491889';
