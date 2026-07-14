/**
 * setup-db.mjs — verification_sets 테이블 생성
 *
 * 사용법:
 *   node setup-db.mjs <SUPABASE_ACCESS_TOKEN>
 *
 * SUPABASE_ACCESS_TOKEN 발급 위치:
 *   Supabase 대시보드 → 우측 상단 프로필 → Account → Access Tokens → Generate new token
 */

const PROJECT_REF = 'ydekxlonxjwfhdhhbpdc';
const PAT         = process.argv[2] || process.env.SUPABASE_ACCESS_TOKEN;

if (!PAT) {
  console.error('❌  Access Token이 필요합니다.');
  console.error('   사용법: node setup-db.mjs <token>');
  process.exit(1);
}

const SQL = `
CREATE TABLE IF NOT EXISTS verification_sets (
  order_no   TEXT PRIMARY KEY,
  po         TEXT NOT NULL,
  sn         TEXT NOT NULL DEFAULT '',
  ptn_no     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vsets_po ON verification_sets (po);
`;

console.log('🔄  verification_sets 테이블 생성 중...');

const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
  {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${PAT}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ query: SQL }),
  }
);

const body = await res.json().catch(() => ({}));

if (!res.ok) {
  console.error('❌  API 오류:', res.status, JSON.stringify(body));
  process.exit(1);
}

console.log('✅  테이블 생성 완료!');
console.log('    이제 모바일 스캐너에서 동기화 버튼을 누르면 데이터가 채워집니다.');
