/**
 * PTN 일괄 재업로드 스크립트
 * Downloads 폴더의 모든 RepairsLabels PDF를 파싱해 Supabase shipments에 upsert
 * 실행: node reupload-ptn.js
 */

const fs       = require('fs');
const path     = require('path');
const pdfParse = require('./node_modules/pdf-parse');

const SB_URL = 'https://ydekxlonxjwfhdhhbpdc.supabase.co';
const SB_KEY = 'sb_publishable_aCdcvXkU_hz35DpyrmSCkw_F8TYKZUJ';
const HEADERS = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

async function sbPatch(table, match, body) {
  const params = Object.entries(match).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, { method:'PATCH', headers:HEADERS, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${table} ${JSON.stringify(match)}: ${r.status} ${await r.text()}`);
}
async function sbPost(table, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method:'POST', headers:{...HEADERS,'Prefer':'return=minimal'}, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${table}: ${r.status} ${await r.text()}`);
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers:HEADERS });
  return r.json();
}

const PDF_DIR  = 'C:/Users/USER/Downloads';
const TODAY    = new Date().toISOString().slice(0, 10);

/* ── 파서 (shipment.html 동일 로직) ── */
function parsePTNText(fullText) {
  const pkgMatches = [...fullText.matchAll(/\(3S\)\s*PKG ID:\s*([A-Z0-9]+)/gi)].map(m => m[1]);
  const poMatches  = [...fullText.matchAll(/\(K\)\s*AMAT ORDER NO:\s*(\d+)/gi)].map(m => m[1]);
  if (pkgMatches.length !== poMatches.length) {
    console.warn(`  ⚠ PKG ID(${pkgMatches.length}) ≠ PO(${poMatches.length}) — 적은 쪽만 반환`);
  }
  const count = Math.min(pkgMatches.length, poMatches.length);
  return Array.from({ length: count }, (_, i) => ({ po: poMatches[i], pkgId: pkgMatches[i] }));
}

async function run() {
  const files = fs.readdirSync(PDF_DIR)
    .filter(f => f.startsWith('RepairsLabels') && f.endsWith('.pdf'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  console.log(`📂 PDF ${files.length}개 발견\n`);

  /* 전체 파싱 */
  const allPairs = []; // { po, pkgId, filename }
  for (const f of files) {
    const buf  = fs.readFileSync(path.join(PDF_DIR, f));
    const data = await pdfParse(buf);
    const pairs = parsePTNText(data.text);
    console.log(`${f.padEnd(36)} → ${pairs.length}건`);
    pairs.forEach(p => allPairs.push({ ...p, filename: f }));
  }
  console.log(`\n총 추출: ${allPairs.length}건\n`);

  if (!allPairs.length) { console.log('업로드할 데이터 없음'); return; }

  /* 기존 shipments 조회 */
  const pos = [...new Set(allPairs.map(p => p.po))];
  const poFilter = pos.map(p => `po=eq.${encodeURIComponent(p)}`).join(',');
  const existing = await sbGet(`shipments?select=id,po&po=in.(${pos.join(',')})`);
  const existingMap = {};
  (existing || []).forEach(r => { existingMap[r.po] = r.id; });

  const maxRows = await sbGet('shipments?select=id&order=id.desc&limit=1');
  let nextId = ((maxRows?.[0]?.id) || 0) + 1;

  /* upsert */
  let updated = 0, inserted = 0, failed = 0;
  for (const { po, pkgId, filename } of allPairs) {
    const baseData = {
      ptn_no:          pkgId,
      ptn_filename:    filename,
      ptn_text:        '',
      ptn_uploaded_at: TODAY,
    };

    try {
      if (existingMap[po] !== undefined) {
        await sbPatch('shipments', { po }, baseData);
        console.log(`  ✓ UPDATE PO ${po} → PKG ${pkgId}`); updated++;
      } else {
        await sbPost('shipments', { id: nextId++, po, ...baseData, created_at: TODAY });
        console.log(`  + INSERT PO ${po} → PKG ${pkgId}`); inserted++;
      }
    } catch(e) { console.error(`  ✗ PO ${po}: ${e.message}`); failed++; }
  }

  console.log(`\n완료 — UPDATE: ${updated}건 / INSERT: ${inserted}건 / 실패: ${failed}건`);
}

run().catch(console.error);
