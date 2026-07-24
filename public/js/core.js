/* ══════════════════════════════════════════════════════
   core.js — 클라이언트 전용 비즈니스 로직
   데이터 저장: Supabase (localStorage는 세션 캐시)
══════════════════════════════════════════════════════ */

const APP_VERSION    = 'v20260707F';
const EXCHANGE_RATE  = 1511.26;
const SB_URL         = 'https://ydekxlonxjwfhdhhbpdc.supabase.co';
const SB_KEY         = 'sb_publishable_aCdcvXkU_hz35DpyrmSCkw_F8TYKZUJ';

let _sb = null;
function getSB() {
  if (!_sb && window.supabase) _sb = window.supabase.createClient(SB_URL, SB_KEY);
  return _sb;
}

// ── 활성 배치 날짜 관리 (날짜별 데이터 선택) ─────────
function getActiveBatch() {
  return localStorage.getItem('active_batch_date') || new Date().toISOString().slice(0, 10);
}
function setActiveBatch(date) {
  localStorage.setItem('active_batch_date', date || new Date().toISOString().slice(0, 10));
}

// ── localStorage 캐시 래퍼 ────────────────────────────
const DB = {
  _g: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  _s: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  parts:        { get: () => DB._g('parts')         || [], set: v => { DB._s('parts', v);        _sbSync('parts', v); } },
  usage:        { get: () => DB._g('usage')         || [], set: v => { DB._s('usage', v);         _sbSync('usage', v); } },
  lots:         { get: () => DB._g('lots')          || [], set: v => { DB._s('lots', v);          _sbSync('lots', v); } },
  processCosts: { get: () => DB._g('process_costs') || {}, set: v => { DB._s('process_costs', v); _sbSync('process_costs', v); } },
};

// Supabase에 백그라운드 동기화 (fire & forget)
async function _sbSync(table, data) {
  const sb = getSB();
  if (!sb) return;
  try {
    if (table === 'process_costs') {
      const rows = Object.entries(data).map(([key, v]) => ({ key, name: v.name, usd: v.usd, krw: v.krw }));
      await sb.from('process_costs').upsert(rows, { onConflict: 'key' });
    } else if (table === 'parts') {
      await sb.from('parts').upsert(data, { onConflict: 'part_number' });
    } else {
      await sb.from(table).upsert(data, { onConflict: 'id' });
    }
  } catch(e) { console.warn('Supabase sync 오류:', e.message); }
}

// ── 초기화: Supabase에서 읽어 로컬 캐시 갱신 ─────────
async function initData() {
  const sb = getSB();
  if (!sb) {
    // Supabase 없을 때 백업 JSON으로 폴백
    if (localStorage.getItem('data_initialized')) return;
    try {
      const base = (() => { const s = location.pathname.split('/'); return s.length > 2 && s[1] ? '/' + s[1] : ''; })();
      const [parts, usage, lots, pc] = await Promise.all([
        fetch(`${base}/data/parts.json`).then(r => r.json()),
        fetch(`${base}/data/usage.json`).then(r => r.json()),
        fetch(`${base}/data/lots.json`).then(r => r.json()),
        fetch(`${base}/data/process_costs.json`).then(r => r.json()),
      ]);
      DB._s('parts', parts); DB._s('usage', usage); DB._s('lots', lots); DB._s('process_costs', pc);
      localStorage.setItem('data_initialized', '1');
    } catch(e) { console.warn('초기 데이터 로드 실패:', e); }
    return;
  }

  // Supabase에서 최신 데이터 로드
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
    const [p, u, l, c] = await Promise.race([
      Promise.all([
        sb.from('parts').select('*').order('id'),
        sb.from('usage').select('*').order('id'),
        sb.from('lots').select('*').order('id'),
        sb.from('process_costs').select('*'),
      ]),
      timeout,
    ]);
    if (p.data) {
      // alt_numbers: Supabase 테이블에 해당 컬럼 없으면 parts.json에서 보강
      let sbParts = p.data;
      try {
        const _base = (() => { const s = location.pathname.split('/'); return s.length > 2 && s[1] ? '/' + s[1] : ''; })();
        const jsonParts = await fetch(`${_base}/data/parts.json`).then(r => r.json());
        const altMap = {};
        jsonParts.forEach(jp => { if (jp.alt_numbers?.length) altMap[jp.part_number] = jp.alt_numbers; });
        sbParts = sbParts.map(sp => sp.alt_numbers ? sp : { ...sp, alt_numbers: altMap[sp.part_number] });
      } catch {}
      DB._s('parts', sbParts);
    }
    if (u.data) DB._s('usage', u.data);
    if (l.data) DB._s('lots', l.data);
    if (c.data) {
      const obj = {};
      c.data.forEach(r => { obj[r.key] = { name: r.name, usd: r.usd, krw: r.krw }; });
      DB._s('process_costs', obj);
    }
    if (!p.data?.length) try { await _uploadBackupData(sb); } catch(e) { console.warn('backup upload 실패:', e.message); }
  } catch(e) { console.warn('initData Supabase 로드 실패:', e.message); }
}

async function _uploadBackupData(sb) {
  try {
    const base = (() => { const s = location.pathname.split('/'); return s.length > 2 && s[1] ? '/' + s[1] : ''; })();
    const [parts, usage, lots, pc] = await Promise.all([
      fetch(`${base}/data/parts.json`).then(r => r.json()),
      fetch(`${base}/data/usage.json`).then(r => r.json()),
      fetch(`${base}/data/lots.json`).then(r => r.json()),
      fetch(`${base}/data/process_costs.json`).then(r => r.json()),
    ]);
    const pcRows = Object.entries(pc).map(([key, v]) => ({ key, name: v.name, usd: v.usd, krw: v.krw }));
    await Promise.all([
      sb.from('parts').upsert(parts, { onConflict: 'part_number' }),
      sb.from('usage').upsert(usage, { onConflict: 'id' }),
      sb.from('lots').upsert(lots,  { onConflict: 'id' }),
      sb.from('process_costs').upsert(pcRows, { onConflict: 'key' }),
    ]);
    // 로컬 캐시 갱신
    DB._s('parts', parts); DB._s('usage', usage); DB._s('lots', lots); DB._s('process_costs', pc);
    console.log('✅ Supabase 초기 데이터 업로드 완료');
  } catch(e) { console.warn('초기 데이터 업로드 실패:', e); }
}

// ── 헬퍼 ─────────────────────────────────────────────
function roundKRW(usd) { return Math.round(usd * EXCHANGE_RATE / 100) * 100; }

function normalizeProcessKey(raw) {
  const t = (raw || '').toUpperCase().trim();
  if (t.includes('WIPE'))   return 'WIPE DOWN';
  if (t.includes('CHEM'))   return 'CHEM SOAK';
  if (t.includes('REFURB')) return 'REFURB';
  return t;
}

function readFileAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload  = e => res(e.target.result);
    fr.onerror = rej;
    fr.readAsArrayBuffer(file);
  });
}

async function _drmBridgeParse(file, type) {
  const form = new FormData();
  form.append('file', file);
  form.append('type', type || 'mes');
  const res = await fetch('http://localhost:3001/drm-convert', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('DRM 브리지 오류 ' + res.status);
  const csv = await res.text();
  return XLSX.read(csv, { type: 'string' });
}

function _isDrmWorkbook(wb) {
  try {
    const sh = wb.Sheets[wb.SheetNames[0]];
    const a1 = sh && sh['A1'];
    const v  = a1 ? String(a1.v || a1.w || '') : '';
    return /drm|fasoo|encrypt/i.test(v);
  } catch { return false; }
}

async function parseExcel(file, drmType) {
  const buf = await readFileAsArrayBuffer(file);
  let wb;
  try {
    wb = XLSX.read(buf, { cellText: true, raw: false });
  } catch (e) {
    if (drmType) return await _drmBridgeParse(file, drmType);
    throw new Error('파일을 읽을 수 없습니다: ' + e.message);
  }
  if (drmType && _isDrmWorkbook(wb)) return await _drmBridgeParse(file, drmType);
  return wb;
}

// ── 견적 생성 ─────────────────────────────────────────
async function generateQuotation(mesFile, masterFile) {
  // SheetJS가 XLS 특정 컬럼을 바이너리로 오독하는 문제 → drm-bridge(Excel COM) 우선 사용
  let mesWb;
  try {
    mesWb = await _drmBridgeParse(mesFile, 'mes');
  } catch(e) {
    mesWb = await parseExcel(mesFile);
    if (_isDrmWorkbook(mesWb)) throw new Error('DRM 변환 실패 (' + e.message + '). drm-bridge가 실행 중인지 확인하세요.');
  }
  const mesAllRows  = XLSX.utils.sheet_to_json(mesWb.Sheets[mesWb.SheetNames[0]], { header: 1, defval: '' });

  // 헤더 탐색 (trim 비교)
  let mesHeaderRow = 0, mesOrderCol = 3;
  const ORDER_COL_NAMES = ['반입번호', '반출번호', '수주번호'];
  outer: for (let ri = 0; ri < Math.min(10, mesAllRows.length); ri++) {
    const row = mesAllRows[ri];
    for (let ci = 0; ci < row.length; ci++) {
      if (ORDER_COL_NAMES.includes(String(row[ci] || '').trim())) {
        mesHeaderRow = ri; mesOrderCol = ci; break outer;
      }
    }
  }
  const hdr = mesAllRows[mesHeaderRow];
  function _findMesCol(name, def) {
    for (let ci = 0; ci < hdr.length; ci++) {
      if (String(hdr[ci]||'').trim() === name) return ci;
    }
    return def;
  }
  const COL_ORDER   = mesOrderCol;
  const COL_SN      = _findMesCol('SN', 5);
  const COL_PROCESS = _findMesCol('SafeSeal타입', 2);
  const COL_MATPN   = _findMesCol('사용자재목록', 8);
  const COL_MATQTY  = _findMesCol('사용수량목록', 9);

  const mesGroups = {};
  for (let i = mesHeaderRow + 1; i < mesAllRows.length; i++) {
    const r = mesAllRows[i];
    const orderNo = String(r[COL_ORDER] || '').trim();
    if (!orderNo) continue;
    const snField  = String(r[COL_SN] || '').trim();
    const spaceIdx = snField.indexOf(' ');
    const pn = spaceIdx > 0 ? snField.slice(0, spaceIdx) : snField;
    const sn = spaceIdx > 0 ? snField.slice(spaceIdx + 1) : '';
    const processType = normalizeProcessKey(String(r[COL_PROCESS] || ''));
    const matPN  = String(r[COL_MATPN] || '').trim();
    const matQty = parseInt(String(r[COL_MATQTY] || '').replace(/[^0-9]/g, '')) || 0;
    if (!mesGroups[orderNo]) mesGroups[orderNo] = { processType, pn, sn, materials: [] };
    if (matPN) mesGroups[orderNo].materials.push({ pn: matPN, qty: matQty || 1 });
  }
  // MES 캐시 저장
  try { localStorage.setItem('mes_rows_cache', JSON.stringify(mesAllRows)); } catch {}
  try { localStorage.setItem('mes_order_nos_cache', JSON.stringify(Object.keys(mesGroups))); } catch {}

  let masterTargets = [];
  let msRows = [];
  if (masterFile) {
    // 마스터파일 업로드됨 → 파싱 후 Supabase 동기화
    const masterWb = await parseExcel(masterFile, 'master');
    const msName   = masterWb.SheetNames.find(n => /safeseal master/i.test(n))
                     || masterWb.SheetNames[1] || masterWb.SheetNames[0];
    msRows = XLSX.utils.sheet_to_json(masterWb.Sheets[msName], { header: 1, defval: '' });
    try { localStorage.setItem('master_rows_cache', JSON.stringify(msRows)); } catch {}
    const now      = new Date().toISOString();
    for (let i = 2; i < msRows.length; i++) {
      const r        = msRows[i];
      const clnDate  = String(r[19] || '').trim();
      const delivery = String(r[20] || '').trim();
      const orderNo  = String(r[10] || '').trim();
      if (!clnDate || delivery || !orderNo) continue;
      if (!mesGroups[orderNo]) continue;
      masterTargets.push({
        orderNo, pn: String(r[6]||'').trim(), sn: String(r[7]||'').trim(),
        po: String(r[8]||'').trim(), tkmNo: String(r[9]||'').trim(),
        clnDate,
      });
    }
    // Supabase에 동기화 (백그라운드)
    (async () => {
      const sb = getSB();
      if (!sb || !masterTargets.length) return;
      try {
        const batchDate = now.slice(0, 10);
        const rows = masterTargets.map(t => ({
          order_no: t.orderNo, pn: t.pn, sn: t.sn,
          po: t.po, tkm_no: t.tkmNo, cln_date: now, synced_at: now,
          batch_date: batchDate,
        }));
        await sb.from('master_jobs').upsert(rows, { onConflict: 'order_no' });
        setActiveBatch(batchDate);
        console.log(`✅ master_jobs 동기화 완료: ${rows.length}건 (배치: ${batchDate})`);
      } catch(e) { console.warn('master_jobs 동기화 오류:', e.message); }
    })();
  } else {
    // 마스터파일 없음 → Supabase에서 자동 로드
    const sb = getSB();
    if (sb) {
      const { data, error } = await sb.from('master_jobs').select('*');
      if (!error && data && data.length > 0) {
        masterTargets = data.map(r => ({
          orderNo: r.order_no, pn: r.pn || '', sn: r.sn || '',
          po: r.po || '', tkmNo: r.tkm_no || '',
        }));
      }
    }
    if (!masterTargets.length) throw new Error('마스터 데이터가 없습니다. 관리자가 마스터파일을 한 번 업로드해야 합니다.');
  }

  const parts = DB.parts.get();
  const usage = DB.usage.get();
  const partPriceMap = {};
  for (const p of parts) {
    const cum      = usage.filter(u => u.part_number === p.part_number).reduce((s, u) => s + u.quantity, 0);
    const exceeded = p.qty_threshold > 0 && cum >= p.qty_threshold;
    // price_override가 설정된 경우 임계치 로직 무시하고 그 값을 강제 사용
    const hasOverride = p.price_override != null && Number(p.price_override) > 0;
    const unitPrice   = hasOverride
      ? Number(p.price_override)
      : (exceeded ? Number(p.price_to_be) : Number(p.price_as_is));
    const priceStatus = hasOverride ? 'Fixed' : (exceeded ? 'To-be' : 'As-is');
    const info = {
      unitPrice,
      unit: p.unit, unitSize: p.unit_size || 1,
      description: p.description, partType: p.type,
      priceStatus, canonicalPN: p.part_number,
    };
    partPriceMap[p.part_number] = info;
    if (Array.isArray(p.alt_numbers)) p.alt_numbers.forEach(alt => { partPriceMap[alt] = info; });
  }

  const processCosts = DB.processCosts.get();
  const quotation = [], issues = [];
  const REFURB_ONLY_TYPES = ['Retainer', 'Lead In', 'Screw'];

  for (const target of masterTargets) {
    const { orderNo, pn, sn, po, tkmNo } = target;
    const mes = mesGroups[orderNo];
    if (!mes) {
      issues.push({ 수주번호: orderNo, po, pn, sn, issue: 'MES 데이터 없음',
        detail: `마스터에 있으나 MES 파일에 "${orderNo}" 없음`, action: 'MES 파일 기간 확인 또는 수주번호 재확인' });
      continue;
    }
    if (mes.pn && mes.pn !== pn) {
      issues.push({ 수주번호: orderNo, po, pn, sn, issue: 'PN 불일치',
        detail: `마스터 PN: ${pn} / MES PN: ${mes.pn}`, action: 'PN 확인 필요 — 마스터 기준으로 견적 생성됨' });
    } else if (mes.sn && mes.sn !== sn) {
      issues.push({ 수주번호: orderNo, po, pn, sn, issue: 'SN 불일치',
        detail: `마스터 SN: ${sn} / MES SN: ${mes.sn}`, action: 'SN 확인 필요 — 마스터 기준으로 견적 생성됨' });
    }
    const procCost = processCosts[mes.processType];
    if (!procCost) {
      issues.push({ 수주번호: orderNo, po, pn, sn, issue: 'Process 단가 누락',
        detail: `공정 타입 "${mes.processType}" 단가 없음`, action: '공정 단가 설정 확인' });
      continue;
    }
    const isWipeDown = mes.processType === 'WIPE DOWN';
    let hasBlockingIssue = false;
    const replParts = [];
    for (const mat of mes.materials) {
      const pi = partPriceMap[mat.pn];
      if (!pi || pi.unitPrice <= 0) {
        issues.push({ 수주번호: orderNo, po, pn, sn, issue: 'Replacement Part 단가 누락',
          detail: `파트 "${mat.pn}" 단가 정보 없음`, action: '파트 단가 시스템에서 해당 파트 등록/단가 입력' });
        hasBlockingIssue = true; continue;
      }
      // A0405465(기본 Screw): 15개 = 1 SET → set 단위로 청구
      const _calcBillingQty = (pn, mesQty) => {
        if (pn === BASIC_SCREW_PN) return Math.max(1, Math.round(mesQty / BASIC_SCREW_UNIT));
        const us = pi.unitSize > 1 ? pi.unitSize : 1;
        return us > 1 ? Math.round(mesQty / us) : mesQty;
      };
      if (isWipeDown && REFURB_ONLY_TYPES.includes(pi.partType)) {
        const billingQty  = _calcBillingQty(mat.pn, mat.qty);
        issues.push({ 수주번호: orderNo, po, pn, sn, issue: '공정-파트 불일치',
          detail: `${mes.processType} 공정에 ${pi.partType}(${mat.pn}) 발생 — MES 입력 오류 가능성. 해당 파트는 견적에서 제외됨.`,
          action: 'MES 확인 후 이상 없으면 [수동 포함] 클릭', canManualInclude: true,
          manualData: { 수주번호: orderNo, po, pn, sn, tkmNo, process: mes.processType,
            processName: procCost.name, processUSD: procCost.usd, processKRW: procCost.krw,
            excludedPart: { pn: pi.canonicalPN||mat.pn, description: pi.description, partType: pi.partType,
              unit: pi.unit, unitSize: pi.unitSize, mesQty: mat.qty, qty: billingQty,
              unitPriceUSD: pi.unitPrice, unitPriceKRW: roundKRW(pi.unitPrice),
              totalUSD: pi.unitPrice*billingQty, totalKRW: roundKRW(pi.unitPrice*billingQty),
              priceStatus: pi.priceStatus } } });
        continue;
      }
      const billingQty = _calcBillingQty(mat.pn, mat.qty);
      const totalUSD   = pi.unitPrice * billingQty;
      replParts.push({
        pn: pi.canonicalPN||mat.pn, description: pi.description, partType: pi.partType,
        unit: pi.unit, unitSize: pi.unitSize, mesQty: mat.qty, qty: billingQty,
        unitPriceUSD: pi.unitPrice, unitPriceKRW: roundKRW(pi.unitPrice),
        totalUSD, totalKRW: roundKRW(totalUSD), priceStatus: pi.priceStatus,
      });
    }
    if (hasBlockingIssue) continue;
    const replTotalUSD = replParts.reduce((s, p) => s + p.totalUSD, 0);
    const replTotalKRW = replParts.reduce((s, p) => s + p.totalKRW, 0);
    quotation.push({
      수주번호: orderNo, po, pn, sn, tkmNo, process: mes.processType,
      processName: procCost.name, processUSD: procCost.usd, processKRW: procCost.krw,
      replParts, replTotalUSD, replTotalKRW,
      totalUSD: procCost.usd + replTotalUSD, totalKRW: procCost.krw + replTotalKRW,
    });
  }

  // quotation_amounts_cache save for shipment auto-load (기존 캐시에 병합)
  try {
    const amtCache = JSON.parse(localStorage.getItem('quotation_amounts_cache') || '{}');
    for (const q of quotation) {
      const entry = { usd: q.totalUSD, krw: q.totalKRW, source: 'auto' };
      amtCache[q.sn] = entry;
      if (q.po) amtCache[q.po] = entry;
    }
    localStorage.setItem('quotation_amounts_cache', JSON.stringify(amtCache));
  } catch (e) {}

  // 왜 필터에서 걸리는지 분석
  let dbgSkipNoClnDate = 0, dbgSkipDelivery = 0, dbgSkipNoOrder = 0;
  for (let i = 2; i < msRows.length; i++) {
    const r = msRows[i];
    const _ord = String(r[10]||'').trim();
    const _cln = String(r[19]||'').trim();
    const _del = String(r[20]||'').trim();
    if (!_ord) dbgSkipNoOrder++;
    if (!_cln) dbgSkipNoClnDate++;
    if (_del)  dbgSkipDelivery++;
  }
  const dbgSampleRow = msRows[2] || [];
  const debug = {
    masterTotalRows: msRows.length,
    masterFiltered: masterTargets.length,
    mesGroupCount: Object.keys(mesGroups).length,
    partsCount: parts.length,
    processCostKeys: Object.keys(processCosts),
    skipNoOrder: dbgSkipNoOrder,
    skipNoClnDate: dbgSkipNoClnDate,
    skipHasDelivery: dbgSkipDelivery,
    masterHeader1: (msRows[0]||[]).slice(0,22).map((v,i)=>`[${i}]${v||'빈칸'}`).join(' | '),
    masterHeader2: (msRows[1]||[]).slice(0,22).map((v,i)=>`[${i}]${v||'빈칸'}`).join(' | '),
    sampleDataRow: dbgSampleRow.slice(0,22).map((v,i)=>`[${i}]${v||'빈칸'}`).join(' | '),
    mesHeaderRow,
    mesOrderCol,
    mesHeader: (mesAllRows[mesHeaderRow]||[]).slice(0,15).map((v,i)=>`[${i}]${String(v||'').slice(0,20)}`).join(' | '),
    sampleMasterOrders: masterTargets.slice(0,3).map(t=>t.orderNo),
    sampleMesOrders: Object.keys(mesGroups).slice(0,3).map(v=>v.slice(0,30)),
    issueBreakdown: issues.reduce((acc, i) => { acc[i.issue] = (acc[i.issue]||0)+1; return acc; }, {}),
  };
  console.log('[DEBUG]', JSON.stringify(debug, null, 2));

  return {
    summary: {
      totalMES: masterTargets.length, quotationCount: quotation.length, issueCount: issues.length,
      totalProcessUSD: quotation.reduce((s,q)=>s+q.processUSD,0),
      totalProcessKRW: quotation.reduce((s,q)=>s+q.processKRW,0),
      totalReplUSD:    quotation.reduce((s,q)=>s+q.replTotalUSD,0),
      totalReplKRW:    quotation.reduce((s,q)=>s+q.replTotalKRW,0),
      totalUSD:        quotation.reduce((s,q)=>s+q.totalUSD,0),
      totalKRW:        quotation.reduce((s,q)=>s+q.totalKRW,0),
    },
    quotation, issues, debug,
  };
}

// ── 검증 세트 동기화 ──
// master_jobs(order_no, po, sn) + shipments(ptn_no = PKG ID) 조인
// → verification_sets에 upsert
//
// 날짜 필드 정의:
//   master_jobs.batch_date  = 마스터 동기화 실행 날짜 (PC에서 견적/마스터 채울 때 기록)
//   master_jobs.cln_date    = 세정 완료/승인 날짜 (마스터 Excel 원본값)
//   shipments.ship_date     = 출하(선적) 날짜 (출하 등록 시 입력)
//   verification_sets.batch_date = 각 master_jobs row의 동기화 날짜 (batch_date 그대로)
async function syncVerificationSets() {
  const sb = getSB();
  if (!sb) throw new Error('Supabase 미연결');

  // 1. master_jobs 전체 조회 (배치 필터 없음 — 모든 PO 검증 가능)
  const { data: jobs, error: e1 } = await sb
    .from('master_jobs').select('order_no, po, sn, batch_date');
  if (e1) throw new Error('master_jobs 조회 오류: ' + e1.message);

  // DB의 최신 batch_date를 활성 배치 날짜로 채택 (stale localStorage 덮어쓰기)
  const today = new Date().toISOString().slice(0, 10);
  const latestBatchDate = (jobs || [])
    .map(j => j.batch_date).filter(Boolean)
    .sort().reverse()[0] || today;

  const filtered = (jobs || []).filter(j => j.order_no && j.po);
  if (!filtered.length) return { synced: 0, latestBatchDate };

  // 2. shipments에서 PKG ID(ptn_no) 조회 — PO → ptn_no 매핑
  const poList = [...new Set(filtered.map(j => j.po.trim().toUpperCase()))];
  const { data: shipRows, error: e2 } = await sb
    .from('shipments').select('po, ptn_no').in('po', poList);
  if (e2) throw new Error('shipments 조회 오류: ' + e2.message);

  const pkgByPO = {};
  (shipRows || []).forEach(s => {
    if (s.ptn_no) pkgByPO[s.po.trim().toUpperCase()] = s.ptn_no.trim().toUpperCase();
  });

  // 3. verification_sets rows 생성
  //    batch_date: 각 master_jobs row의 동기화 날짜를 그대로 사용 (없으면 today 폴백)
  const rows = filtered.map(j => {
    const poKey = j.po.trim().toUpperCase();
    return {
      order_no:   j.order_no.trim(),
      batch_date: j.batch_date || today,
      po:         poKey,
      sn:         (j.sn || '').trim().replace(/\s/g, '').toUpperCase(),
      ptn_no:     pkgByPO[poKey] || null,
      created_at: new Date().toISOString(),
    };
  });

  const { error: upsertErr } = await sb
    .from('verification_sets')
    .upsert(rows, { onConflict: 'order_no,batch_date' });

  if (upsertErr) throw new Error('verification_sets upsert 오류: ' + upsertErr.message);
  setActiveBatch(latestBatchDate);
  return { synced: rows.length, latestBatchDate };
}

// ── 바코드 3종 검증 ──────────────────────────────────────────────────
// input : { po, sn, ptn_no }  (각각 스캔된 원시값 — 정규화는 내부에서 처리)
// output: { pass, order_no, batch_date, mismatch_field?, error? }
async function verifyBarcodeSet({ po, sn, ptn_no }) {
  const sb = getSB();
  if (!sb) return { pass: false, order_no: null, error: 'Supabase 미연결' };

  const poKey     = (po     || '').trim().toUpperCase();
  const snKey     = (sn     || '').trim().replace(/\s/g, '').toUpperCase();
  const ptnKey    = (ptn_no || '').trim().toUpperCase();
  const batchDate = getActiveBatch();

  if (!poKey) return { pass: false, order_no: null, mismatch_field: 'po', error: 'PO 값 없음' };

  // 1차: 활성 배치 기준 검색
  let data = null;
  {
    let q = sb.from('verification_sets').select('order_no, batch_date, po, sn, ptn_no').eq('po', poKey);
    if (batchDate) q = q.eq('batch_date', batchDate);
    const { data: d, error } = await q.maybeSingle();
    if (error) return { pass: false, order_no: null, error: error.message };
    data = d;
  }

  // 2차: 활성 배치에 없으면 전체 배치에서 폴백 검색
  if (!data && batchDate) {
    const { data: d2, error: e2 } = await sb
      .from('verification_sets')
      .select('order_no, batch_date, po, sn, ptn_no')
      .eq('po', poKey)
      .order('batch_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (e2) return { pass: false, order_no: null, error: e2.message };
    data = d2;
  }

  if (!data) return { pass: false, order_no: null, mismatch_field: 'po', error: `PO "${poKey}" 미등록 — 재동기화(↻) 후 재시도` };

  if (snKey  && data.sn     && data.sn     !== snKey)  return { pass: false, order_no: data.order_no, batch_date: data.batch_date, mismatch_field: 'sn' };
  if (ptnKey && data.ptn_no && data.ptn_no !== ptnKey) return { pass: false, order_no: data.order_no, batch_date: data.batch_date, mismatch_field: 'ptn_no' };

  return { pass: true, order_no: data.order_no, batch_date: data.batch_date };
}

// ── 마스터 업데이트 ────────────────────────────────────
const BASIC_SCREW_PN   = 'A0405465';
const BASIC_SCREW_UNIT = 15;

function calcMasterFillData(mesData, partsMap) {
  let waferSealPN = '', contactPN = '', contactQty = 0;
  let basicScrewPN = '', basicScrewSetQty = 0;
  let otherScrewPN = '', otherScrewQty = 0;
  let retainerPN = '', leadInPN = '', leadInQty = 0;
  const typeQtys = {};

  for (const mat of mesData.materials) {
    if (!mat.pn) continue;
    const part = partsMap[mat.pn];
    const pt   = part ? part.partType : null;
    if (pt === 'Wafer Seal') {
      waferSealPN = waferSealPN ? waferSealPN + ',' + mat.pn : mat.pn;
      typeQtys[pt] = (typeQtys[pt]||0) + mat.qty;
    } else if (pt === 'Contact Pin') {
      if (!contactPN) contactPN = mat.pn;
      contactQty += mat.qty;
      typeQtys[pt] = (typeQtys[pt]||0) + mat.qty;
    } else if (pt === 'Screw') {
      if (mat.pn === BASIC_SCREW_PN) {
        basicScrewPN = mat.pn;
        const sets = Math.max(1, Math.round(mat.qty / BASIC_SCREW_UNIT));
        basicScrewSetQty += sets;
        typeQtys['Screw'] = (typeQtys['Screw']||0) + sets;
      } else {
        if (!otherScrewPN) otherScrewPN = mat.pn;
        otherScrewQty += mat.qty;
        typeQtys['Screw'] = (typeQtys['Screw']||0) + mat.qty;
      }
    } else if (pt === 'Retainer') {
      retainerPN = mat.pn;
      typeQtys[pt] = (typeQtys[pt]||0) + mat.qty;
    } else if (pt === 'Lead In') {
      if (!leadInPN) leadInPN = mat.pn;
      leadInQty += mat.qty;
      typeQtys[pt] = (typeQtys[pt]||0) + mat.qty;
    }
  }

  const pMap = { 'CHEM SOAK': 'Chem Soak', 'REFURB': 'Refurb', 'WIPE DOWN': 'Wipe Down' };
  const AU   = ['Wafer Seal','Contact Pin','Retainer','Lead In','Screw']
    .filter(t => typeQtys[t] > 0).map(t => `${t}*${typeQtys[t]}`).join('\n');

  return {
    AT: pMap[mesData.processType] || mesData.processType, AU, AV: '',
    AW: waferSealPN,
    AX: contactPN,     AY: contactQty     > 0 ? String(contactQty)      : '',
    AZ: basicScrewPN,  BA: basicScrewSetQty > 0 ? String(basicScrewSetQty) : '',
    BB: otherScrewPN,  BC: otherScrewQty  > 0 ? String(otherScrewQty)   : '',
    BD: retainerPN,
    BE: leadInPN,      BF: leadInQty      > 0 ? String(leadInQty)       : '',
  };
}

async function buildMasterFillResult(mesFile, masterFile) {
  let mesRows;
  if (mesFile) {
    let mesWb;
    try { mesWb = await _drmBridgeParse(mesFile, 'mes'); } catch { mesWb = await parseExcel(mesFile); }
    const allRows = XLSX.utils.sheet_to_json(mesWb.Sheets[mesWb.SheetNames[0]], { header: 1, defval: '' });
    localStorage.setItem('mes_rows_cache', JSON.stringify(allRows));
    mesRows = allRows;
  } else {
    const cached = localStorage.getItem('mes_rows_cache');
    if (!cached) throw new Error('MES 파일을 업로드해 주세요.');
    mesRows = JSON.parse(cached);
  }

  let masterRows;
  if (masterFile) {
    const masterWb = await parseExcel(masterFile, 'master');
    const msName   = masterWb.SheetNames.find(n => /safeseal master/i.test(n))
                     || masterWb.SheetNames[1] || masterWb.SheetNames[0];
    masterRows = XLSX.utils.sheet_to_json(masterWb.Sheets[msName], { header: 1, defval: '' });
    try { localStorage.setItem('master_rows_cache', JSON.stringify(masterRows)); } catch {}
  } else {
    const cached = localStorage.getItem('master_rows_cache');
    if (!cached) throw new Error('마스터파일을 업로드해 주세요.');
    masterRows = JSON.parse(cached);
  }

  const mesByOrder = {};
  for (let i = 1; i < mesRows.length; i++) {
    const r       = mesRows[i];
    const orderNo = String(r[3] || '').trim();
    if (!orderNo || orderNo === '반입번호') continue;
    const process = String(r[2] || '').trim();
    const matPN   = String(r[8] || '').trim();
    const matQty  = parseInt(String(r[9] || '').replace(/[^0-9]/g, '')) || 1;
    if (!mesByOrder[orderNo]) mesByOrder[orderNo] = { processType: normalizeProcessKey(process), materials: [] };
    if (matPN) mesByOrder[orderNo].materials.push({ pn: matPN, qty: matQty });
  }
  try { localStorage.setItem('mes_order_nos_cache', JSON.stringify(Object.keys(mesByOrder))); } catch {}

  const parts = DB.parts.get();
  const partsMap = {};
  for (const p of parts) {
    partsMap[p.part_number] = { partType: p.type };
    if (p.alt_numbers) p.alt_numbers.forEach(a => { partsMap[a] = { partType: p.type }; });
  }

  const COL = { AT:45,AU:46,AV:47,AW:48,AX:49,AY:50,AZ:51,BA:52,BB:53,BC:54,BD:55,BE:56,BF:57 };
  const updates=[], alreadyFilled=[], noMesMatch=[], wipeShtSkipped=[];

  for (let i = 2; i < masterRows.length; i++) {
    const r       = masterRows[i];
    const orderNo = String(r[10] || '').trim();
    if (!orderNo) continue;
    const clnDate  = String(r[19] || '').trim();
    const delivery = String(r[20] || '').trim();
    if (!clnDate || delivery) continue;
    const rowInfo = { excelRow: i+1, orderNo, pn: String(r[6]||'').trim(), sn: String(r[7]||'').trim(), po: String(r[8]||'').trim(), tkmNo: String(r[9]||'').trim(), clnDate };

    const mesData = mesByOrder[orderNo];
    if (!mesData) { noMesMatch.push(rowInfo); continue; }
    if (mesData.processType === 'WIPE DOWN' && String(r[15]||'').trim().toUpperCase() === 'SHT') {
      wipeShtSkipped.push({ ...rowInfo, process: mesData.processType }); continue;
    }
    const currentAT = String(r[COL.AT] || '').trim();
    if (currentAT) { alreadyFilled.push({ ...rowInfo, existingProcess: currentAT }); continue; }

    const toWrite = calcMasterFillData(mesData, partsMap);
    for (const [col, idx] of Object.entries(COL)) {
      if (String(r[idx]||'').trim()) toWrite[col] = null;
    }
    updates.push({ ...rowInfo, toWrite });
  }

  // master_jobs sync: updates + alreadyFilled + noMesMatch (PO/SN 있는 마스터 전체)
  (async () => {
    const sb = getSB();
    if (!sb) return;
    const now = new Date().toISOString();
    const syncRows = [...updates, ...alreadyFilled, ...noMesMatch]
      .filter(u => u.orderNo && u.po)
      .map(u => ({
        order_no: u.orderNo, pn: u.pn, sn: u.sn,
        po: u.po, tkm_no: u.tkmNo, cln_date: u.clnDate, synced_at: now,
      }));
    if (!syncRows.length) return;
    const batchDate = now.slice(0, 10);
    const rowsWithBatch = syncRows.map(r => ({ ...r, batch_date: batchDate }));
    try {
      await sb.from('master_jobs').upsert(rowsWithBatch, { onConflict: 'order_no' });
      setActiveBatch(batchDate);
      console.log('master_jobs sync:', rowsWithBatch.length, '배치:', batchDate);
    } catch(e) { console.warn('master_jobs sync error:', e.message); }
  })();

  return {
    stats: {
      totalMesCompleted: Object.keys(mesByOrder).length,
      toUpdate: updates.length, alreadyFilled: alreadyFilled.length,
      noMesMatch: noMesMatch.length, wipeShtSkipped: wipeShtSkipped.length,
    },
    updates, alreadyFilled, noMesMatch, wipeShtSkipped,
  };
}

// ── 클라이언트 Excel 다운로드 (견적) ─────────────────
async function downloadQuotationExcel(quotation) {
  const PART_ORDER = [
    { type: 'Wafer Seal',  label: 'Wafer Seal'   },
    { type: 'Contact Pin', label: 'Contact Pin'   },
    { type: 'Retainer',    label: 'Retainer ring' },
    { type: 'Screw',       label: 'Screw'         },
    { type: 'Lead In',     label: 'Lead In'       },
  ];
  const usedTypes = new Set(
    quotation.flatMap(q => q.replParts)
      .filter(p => p.totalUSD > 0)
      .map(p => p.partType)
  );
  const activeParts = PART_ORDER.filter(p => usedTypes.has(p.type));
  const headers = [
    'SS P/N', 'SS S/N', 'PO', '0247#', 'Process',
    'Cleaning price\n(USD)', 'Cleaning price\n(KRW)',
    ...activeParts.flatMap(p => [`${p.label}\n(USD)`, `${p.label}\n(KRW)`]),
    'Total\n(USD)', 'Total\n(KRW)', 'Remark',
  ];

  if (typeof ExcelJS !== 'undefined') {
    // ── ExcelJS 서식 적용 ─────────────────────────────
    const HDR_BG   = 'FFD9E1F2'; // 헤더 배경 (연파랑)
    const HDR_FONT = 'FF1F3864'; // 헤더 글자 (진남색)
    const BRD_BLUE = 'FF8DB4E2'; // 파랑 테두리
    const BRD_GRAY = 'FFD9D9D9'; // 회색 테두리
    const SUM_BG   = 'FFFFF2CC'; // 합계 행 배경 (연노랑)
    const colWidths = [12, 14, 13, 12, 13, 13, 15,
      ...activeParts.flatMap(() => [12, 15]),
      12, 15, 26];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('견적');
    ws.columns = colWidths.map(w => ({ width: w }));

    // 컬럼 인덱스 상수 (1-based)
    const NUM_START   = 6;                    // Cleaning USD 컬럼
    const REMARK_COL  = headers.length;       // Remark 컬럼
    const TOTAL_USD   = REMARK_COL - 2;       // Total USD 컬럼
    const TOTAL_KRW   = REMARK_COL - 1;       // Total KRW 컬럼

    // 숫자→엑셀 컬럼 문자 변환 (A, B, ..., Z, AA, ...)
    const col = n => { let s=''; while(n>0){s=String.fromCharCode(64+(n-1)%26+1)+s;n=Math.floor((n-1)/26);} return s; };

    // USD 컬럼 목록: NUM_START, NUM_START+2, ... TOTAL_USD-1
    const usdCols = [];
    for (let c = NUM_START; c < TOTAL_USD; c += 2) usdCols.push(c);
    // KRW 컬럼 목록: NUM_START+1, NUM_START+3, ... TOTAL_KRW-1
    const krwCols = [];
    for (let c = NUM_START + 1; c < TOTAL_KRW; c += 2) krwCols.push(c);

    // Row 1: 빈 구분행 — 하단 테두리만
    const row1 = ws.addRow(new Array(headers.length).fill(null));
    row1.height = 8;
    for (let c = 1; c <= headers.length; c++) {
      row1.getCell(c).border = { bottom: { style: 'thin', color: { argb: BRD_BLUE } } };
    }

    // Row 2: 헤더행
    const row2 = ws.addRow(headers);
    row2.height = 36;
    row2.eachCell(cell => {
      cell.font      = { name: 'Calibri', size: 10, bold: true, color: { argb: HDR_FONT } };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: HDR_BG } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border    = {
        top:    { style: 'thin', color: { argb: BRD_BLUE } },
        bottom: { style: 'thin', color: { argb: BRD_BLUE } },
        left:   { style: 'thin', color: { argb: BRD_BLUE } },
        right:  { style: 'thin', color: { argb: BRD_BLUE } },
      };
    });

    // 데이터 행 (3행부터 시작)
    const DATA_START_ROW = 3;
    const applyDataStyle = (row, rowIdx) => {
      row.height = 18;
      row.eachCell((cell, c) => {
        cell.font   = { name: 'Calibri', size: 10 };
        cell.border = {
          top:    { style: 'thin', color: { argb: BRD_BLUE } },
          bottom: { style: 'thin', color: { argb: BRD_GRAY } },
          left:   { style: 'thin', color: { argb: BRD_GRAY } },
          right:  { style: 'thin', color: { argb: BRD_GRAY } },
        };
        if (c === REMARK_COL) {
          cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        } else if (c >= NUM_START && c < REMARK_COL) {
          cell.numFmt    = (c - NUM_START) % 2 === 0 ? '"$"#,##0.00' : '[$₩-412]#,##0';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else {
          cell.alignment = { vertical: 'middle' };
        }
      });
    };

    let currentRow = DATA_START_ROW;
    for (const q of quotation) {
      const partCols = activeParts.flatMap(fp => {
        const p = q.replParts.find(r => r.partType === fp.type);
        return p ? [p.totalUSD, p.totalKRW] : [0, 0];
      });
      const remark = q.replParts.map(p => `${p.pn} ×${p.qty}`).join('\n');

      // Total USD/KRW를 수식으로 — 단가·수량 셀을 직접 수정해도 자동 재계산
      const usdFormula = usdCols.map(c => `${col(c)}${currentRow}`).join('+');
      const krwFormula = krwCols.map(c => `${col(c)}${currentRow}`).join('+');

      const row = ws.addRow([
        q.pn, q.sn, q.po, q.tkmNo, q.processName || q.process,
        q.processUSD, q.processKRW, ...partCols,
        { formula: usdFormula, result: q.totalUSD },
        { formula: krwFormula, result: q.totalKRW },
        remark,
      ]);
      applyDataStyle(row, currentRow);
      currentRow++;
    }

    // 합계 행 — 모든 숫자 컬럼에 SUM 수식
    const lastDataRow = currentRow - 1;
    const sumValues = new Array(headers.length).fill(null);
    sumValues[0] = '합계';
    for (let c = NUM_START; c < REMARK_COL; c++) {
      sumValues[c - 1] = {
        formula: `SUM(${col(c)}${DATA_START_ROW}:${col(c)}${lastDataRow})`,
        result: 0,
      };
    }
    const sumRow = ws.addRow(sumValues);
    sumRow.height = 20;
    sumRow.eachCell((cell, c) => {
      cell.font = { name: 'Calibri', size: 10, bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUM_BG } };
      cell.border = {
        top:    { style: 'medium', color: { argb: BRD_BLUE } },
        bottom: { style: 'medium', color: { argb: BRD_BLUE } },
        left:   { style: 'thin',   color: { argb: BRD_GRAY } },
        right:  { style: 'thin',   color: { argb: BRD_GRAY } },
      };
      if (c >= NUM_START && c < REMARK_COL) {
        cell.numFmt    = (c - NUM_START) % 2 === 0 ? '"$"#,##0.00' : '[$₩-412]#,##0';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else {
        cell.alignment = { vertical: 'middle' };
      }
    });

    const buffer = await wb.xlsx.writeBuffer();
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url; a.download = `견적_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    return;
  }

  // ExcelJS 미로드 시 SheetJS 폴백
  const rows = [new Array(headers.length).fill(''), headers];
  for (const q of quotation) {
    const pc = activeParts.flatMap(fp => { const p = q.replParts.find(r=>r.partType===fp.type); return p?[p.totalUSD,p.totalKRW]:[0,0]; });
    const rm = q.replParts.map(p=>`${p.pn} ×${p.qty}`).join('\n');
    rows.push([q.pn,q.sn,q.po,q.tkmNo,q.processName||q.process,q.processUSD,q.processKRW,...pc,q.totalUSD,q.totalKRW,rm]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!rows'] = [{ hpt: 15 }, { hpt: 32 }];
  const wbk = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbk, ws, '견적');
  XLSX.writeFile(wbk, `견적_${new Date().toISOString().slice(0,10)}.xlsx`);
}
