const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const XLSX      = require('xlsx');
const XLSXStyle = require('xlsx-js-style');
const session   = require('express-session');
const multer    = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'hansol2024';
const DATA_DIR    = path.join(__dirname, 'data');
const PARTS_FILE         = path.join(DATA_DIR, 'parts.json');
const USAGE_FILE         = path.join(DATA_DIR, 'usage.json');
const LOTS_FILE          = path.join(DATA_DIR, 'lots.json');
const CONFIG_FILE        = path.join(DATA_DIR, 'config.json');
const PROCESS_COSTS_FILE = path.join(DATA_DIR, 'process_costs.json');
const PARTS_CSV          = path.join(DATA_DIR, 'parts_data.csv');
const LOTS_CSV           = path.join(DATA_DIR, 'lots_data.csv');
const CODES_CSV          = path.join(DATA_DIR, 'iones_codes.csv');

const EXCHANGE_RATE = 1511.26;
const { spawnSync } = require('child_process');
const upload = multer({ storage: multer.memoryStorage() });

function roundKRW(usd) { return Math.round(usd * EXCHANGE_RATE / 100) * 100; }
function readProcessCosts() { return JSON.parse(fs.readFileSync(PROCESS_COSTS_FILE, 'utf8')); }
function normalizeProcessKey(raw) {
  const t = (raw || '').toUpperCase().trim();
  if (t.includes('WIPE')) return 'WIPE DOWN';
  if (t.includes('CHEM')) return 'CHEM SOAK';
  if (t.includes('REFURB')) return 'REFURB';
  return t;
}

/* Fasoo DRM 감지: 첫 2바이트가 0x9B 0x20 이면 DRM 파일 */
function isFasooDRM(filePath) {
  try {
    const buf = Buffer.alloc(2);
    const fd  = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x9B && buf[1] === 0x20;
  } catch { return false; }
}

/* PS1 파일로 저장 후 -File 실행 (Windows 인수 이스케이프 문제 완전 회피) */
function runPsScript(scriptContent, scriptName, timeoutMs = 300000) {
  const scriptPath = path.join(DATA_DIR, scriptName);
  fs.writeFileSync(scriptPath, '﻿' + scriptContent, 'utf8');
  const r = spawnSync('powershell', ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { encoding: 'utf8', timeout: timeoutMs });
  try { fs.unlinkSync(scriptPath); } catch {}
  return r;
}

/* 숨김 Excel 프로세스 정리 */
function killOrphanExcel() {
  runPsScript(
    "Get-Process EXCEL -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process -Force",
    '_kill_excel.ps1', 10000
  );
}

/* Excel COM으로 DRM MES 파일 읽기 → CSV 저장 (Value2 일괄 읽기) */
function convertDrmToCSV(mesPath) {
  killOrphanExcel();
  const outPath = path.join(DATA_DIR, 'mes_converted.csv');
  const script = `
$ErrorActionPreference = 'Stop'
Get-Process EXCEL -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process -Force
Start-Sleep -Seconds 1
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $wb     = $excel.Workbooks.Open('${mesPath.replace(/'/g, "''")}')
  $ws     = $wb.Sheets.Item(1)
  $range  = $ws.UsedRange
  $values = $range.Value2
  $rows   = $range.Rows.Count
  $cols   = $range.Columns.Count

  $lines = [System.Collections.Generic.List[string]]::new()
  for ($r = 1; $r -le $rows; $r++) {
    $cells = for ($c = 1; $c -le $cols; $c++) {
      $v = if ($null -eq $values[$r,$c]) { '' } else { [string]$values[$r,$c] }
      [char]34 + ($v -replace [char]34, ([char]34+[char]34)) + [char]34
    }
    $lines.Add(($cells -join ','))
  }

  $wb.Close($false)
  $excel.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
  [System.IO.File]::WriteAllLines('${outPath.replace(/'/g, "''")}', $lines, [System.Text.Encoding]::UTF8)
  Write-Output "OK:$rows"
} catch {
  try { $wb.Close($false) } catch {}
  try { $excel.Quit() } catch {}
  try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}
  Write-Error "MES 변환 실패: $_"
  exit 1
}
`;
  const r = runPsScript(script, '_mes_convert.ps1');
  if (r.status !== 0 || r.signal) {
    throw new Error('Excel DRM 변환 실패: ' + (r.stderr || r.stdout || `signal=${r.signal}`));
  }
  return outPath;
}

/* 마스터파일을 Excel COM으로 읽어 CSV로 변환 (클라우디움/DRM 우회)
   Value2 일괄 읽기 사용 → 셀 하나씩 읽기 대비 100배 이상 빠름 */
function convertMasterToCSV(masterPath) {
  killOrphanExcel();
  const outPath = path.join(DATA_DIR, 'master_converted.csv');
  const script = `
$ErrorActionPreference = 'Stop'
Get-Process EXCEL -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process -Force
Start-Sleep -Seconds 1
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AskToUpdateLinks = $false
  $wb = $excel.Workbooks.Open('${masterPath.replace(/'/g, "''")}', 0, $true)

  $ws = $null
  foreach ($s in $wb.Sheets) {
    if ($s.Name -match '(?i)safeseal master') { $ws = $s; break }
  }
  if (-not $ws) { $ws = $wb.Sheets.Item(2) }

  $range  = $ws.UsedRange
  $values = $range.Value2
  $rows   = $range.Rows.Count
  $cols   = $range.Columns.Count

  $lines = [System.Collections.Generic.List[string]]::new()
  for ($r = 1; $r -le $rows; $r++) {
    $cells = for ($c = 1; $c -le $cols; $c++) {
      $v = if ($null -eq $values[$r, $c]) { '' } else { [string]$values[$r, $c] }
      [char]34 + ($v -replace [char]34, ([char]34+[char]34)) + [char]34
    }
    $lines.Add(($cells -join ','))
  }

  $wb.Close($false)
  $excel.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
  [System.IO.File]::WriteAllLines('${outPath.replace(/'/g, "''")}', $lines, [System.Text.Encoding]::UTF8)
  Write-Output "OK:$rows"
} catch {
  try { $wb.Close($false) } catch {}
  try { $excel.Quit() } catch {}
  try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}
  Write-Error "마스터 변환 실패: $_"
  exit 1
}
`;
  const r = runPsScript(script, '_master_convert.ps1');
  if (r.status !== 0 || r.signal) {
    throw new Error('마스터파일 Excel 변환 실패: ' + (r.stderr || r.stdout || `signal=${r.signal}`));
  }
  return outPath;
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: 'safeseal-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8시간
}));

// Railway 헬스체크
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/api/version', (req, res) => res.json({ version: 'v20260701-css-fix', platform: process.platform }));

// 로그인 페이지
app.get('/login', (req, res) => {
  if (req.session.auth) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>로그인 - 파트 단가 관리 시스템</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background:#f0f2f5; display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .login-card { background:#fff; border-radius:12px; padding:40px; box-shadow:0 4px 20px rgba(0,0,0,.1); width:100%; max-width:380px; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="text-center mb-4">
      <div style="font-size:2rem">⚙️</div>
      <h5 class="fw-bold mt-2">파트 단가 관리 시스템</h5>
      <div class="text-muted small">한솔아이원스 안성사업장</div>
    </div>
    ${req.query.error ? '<div class="alert alert-danger py-2 small">비밀번호가 올바르지 않습니다.</div>' : ''}
    <form method="POST" action="/login">
      <div class="mb-3">
        <label class="form-label fw-semibold">비밀번호</label>
        <input type="password" name="password" class="form-control" placeholder="비밀번호 입력" autofocus required>
      </div>
      <button type="submit" class="btn btn-primary w-100">로그인</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    req.session.auth = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// 인증 미들웨어
app.use((req, res, next) => {
  if (req.session.auth) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: '로그인이 필요합니다.' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate') }));

if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(PARTS_FILE))  fs.writeFileSync(PARTS_FILE,  '[]');
if (!fs.existsSync(USAGE_FILE))  fs.writeFileSync(USAGE_FILE,  '[]');
if (!fs.existsSync(LOTS_FILE))   fs.writeFileSync(LOTS_FILE,   '[]');
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, '{}');

function readParts()   { return JSON.parse(fs.readFileSync(PARTS_FILE,  'utf8')); }
function writeParts(d) { fs.writeFileSync(PARTS_FILE,  JSON.stringify(d, null, 2)); }
function readUsage()   { return JSON.parse(fs.readFileSync(USAGE_FILE,  'utf8')); }
function writeUsage(d) { fs.writeFileSync(USAGE_FILE,  JSON.stringify(d, null, 2)); }
function readLots()    { return JSON.parse(fs.readFileSync(LOTS_FILE,   'utf8')); }
function writeLots(d)  { fs.writeFileSync(LOTS_FILE,   JSON.stringify(d, null, 2)); }
function readConfig()  { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
function writeConfig(d){ fs.writeFileSync(CONFIG_FILE, JSON.stringify(d, null, 2)); }
function nextId(arr)   { return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1; }
function now()         { return new Date().toLocaleString('ko-KR'); }

// ── CSV 파싱 ───────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur.trim()); cur = '';
    } else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
}

function normalizeType(raw) {
  const t = (raw || '').toLowerCase().trim();
  if (t === 'wafer seal')     return 'Wafer Seal';
  if (t === 'contact pin')    return 'Contact Pin';
  if (t === 'wafer shipping') return 'Wafer Shipping';
  if (t === 'lead in')        return 'Lead In';
  if (t === 'retainer')       return 'Retainer';
  if (t === 'screw')          return 'Screw';
  return (raw || '').trim();
}

function parseQty(val) {
  const n = parseInt((val || '').replace(/[^0-9]/g, ''));
  return isNaN(n) ? 0 : n;
}

function parsePrice(val) {
  const n = parseFloat((val || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

function parsePODate(poNumber) {
  const m = (poNumber || '').match(/PO(\d{2})(\d{2})(\d{2})/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : '';
}

// ── FIFO 계산 ──────────────────────────────────────────
function computeLotFIFO(partNumber) {
  const lots = readLots()
    .filter(l => l.part_number === partNumber)
    .sort((a, b) => {
      if (a.order_date && b.order_date) {
        const cmp = a.order_date.localeCompare(b.order_date);
        return cmp !== 0 ? cmp : a.id - b.id;
      }
      return a.id - b.id;
    });

  const totalUsage = readUsage()
    .filter(u => u.part_number === partNumber)
    .reduce((s, u) => s + u.quantity, 0);

  let remaining = totalUsage;
  const enriched = lots.map(lot => {
    if (remaining <= 0) {
      return { ...lot, consumed: 0, lot_remaining: lot.ordered_qty, lot_status: 'pending' };
    } else if (remaining >= lot.ordered_qty) {
      remaining -= lot.ordered_qty;
      return { ...lot, consumed: lot.ordered_qty, lot_remaining: 0, lot_status: 'consumed' };
    } else {
      const consumed = remaining;
      remaining = 0;
      return { ...lot, consumed, lot_remaining: lot.ordered_qty - consumed, lot_status: 'active' };
    }
  });

  const activeLot = enriched.find(l => l.lot_status === 'active')
                 || enriched.find(l => l.lot_status === 'pending');
  return { lots: enriched, activeLot, totalUsage };
}

// ── PowerShell 추출 스크립트 생성 ─────────────────────
function generateExtractScript(excelPath) {
  const scriptPath   = path.join(DATA_DIR, 'extract.ps1');
  const csvPath      = PARTS_CSV.replace(/\\/g, '\\\\');
  const codesCsvPath = CODES_CSV.replace(/\\/g, '\\\\');
  const lotsCsvPath  = LOTS_CSV.replace(/\\/g, '\\\\');
  const excelPathEsc = excelPath.replace(/\\/g, '\\\\');

  const script = [
    `$ErrorActionPreference = "Stop"`,
    `try {`,
    `$excel = New-Object -ComObject Excel.Application`,
    `$excel.Visible = $false`,
    `$excel.DisplayAlerts = $false`,
    `$excel.AskToUpdateLinks = $false`,
    `$wb = $excel.Workbooks.Open("${excelPathEsc}",0,$true)`,
    ``,
    `# IONES내부용_01 시트 (인덱스 3)`,
    `$ws1 = $wb.Sheets.Item(3)`,
    `$lastRow1 = $ws1.Cells($ws1.Rows.Count, 2).End(-4162).Row`,
    ``,
    `# parts_data.csv: B(PN), D(Type), AB(IONES사용량), AC(Onhand), Z(사급입고), AA(사급사용)`,
    `$lines1 = @()`,
    `for ($r = 14; $r -le $lastRow1; $r++) {`,
    `  $pn   = ($ws1.Cells.Item($r, 2).Text -split [char]10)[0].Trim() -replace '"','""'`,
    `  $type = $ws1.Cells.Item($r, 4).Text.Trim() -replace '"','""'`,
    `  $used = $ws1.Cells.Item($r, 28).Text.Trim() -replace '"','""'`,
    `  $hand = $ws1.Cells.Item($r, 29).Text.Trim() -replace '"','""'`,
    `  $sajupRcv = $ws1.Cells.Item($r, 26).Text.Trim() -replace '"','""'`,
    `  $sajupUsd = $ws1.Cells.Item($r, 27).Text.Trim() -replace '"','""'`,
    `  if ($pn -ne "") { $lines1 += [char]34+$pn+[char]34+","+ [char]34+$type+[char]34+","+ [char]34+$used+[char]34+","+ [char]34+$hand+[char]34+","+ [char]34+$sajupRcv+[char]34+","+ [char]34+$sajupUsd+[char]34 }`,
    `}`,
    `$lines1 | Out-File "${csvPath}" -Encoding UTF8`,
    ``,
    `# iones_codes.csv: B(PN), U(아이원스 품목코드)`,
    `$lines2 = @()`,
    `for ($r = 14; $r -le $lastRow1; $r++) {`,
    `  $pn   = ($ws1.Cells.Item($r, 2).Text -split [char]10)[0].Trim() -replace '"','""'`,
    `  $code = $ws1.Cells.Item($r, 21).Text.Trim() -replace '"','""'`,
    `  if ($pn -ne "" -and $code -ne "") { $lines2 += [char]34+$pn+[char]34+","+ [char]34+$code+[char]34 }`,
    `}`,
    `$lines2 | Out-File "${codesCsvPath}" -Encoding UTF8`,
    ``,
    `# 데린저&GT&SJT 시트 (인덱스 5)`,
    `$ws2 = $wb.Sheets.Item(5)`,
    `$lastRow2 = $ws2.Cells($ws2.Rows.Count, 4).End(-4162).Row`,
    ``,
    `# lots_data.csv: B(PO번호), C(공급처), D(품목코드), G(발주수량), H(견적단가USD)`,
    `$lines3 = @()`,
    `for ($r = 7; $r -le $lastRow2; $r++) {`,
    `  $po       = $ws2.Cells.Item($r, 2).Text.Trim() -replace '"','""'`,
    `  $supplier = $ws2.Cells.Item($r, 3).Text.Trim() -replace '"','""'`,
    `  $code     = $ws2.Cells.Item($r, 4).Text.Trim() -replace '"','""'`,
    `  $qty      = $ws2.Cells.Item($r, 7).Text.Trim() -replace '"','""'`,
    `  $price    = $ws2.Cells.Item($r, 8).Text.Trim() -replace '"','""'`,
    `  if ($code -ne "" -and $po -ne "") { $lines3 += [char]34+$po+[char]34+","+ [char]34+$supplier+[char]34+","+ [char]34+$code+[char]34+","+ [char]34+$qty+[char]34+","+ [char]34+$price+[char]34 }`,
    `}`,
    `$lines3 | Out-File "${lotsCsvPath}" -Encoding UTF8`,
    ``,
    `$wb.Close($false)`,
    `$excel.Quit()`,
    `[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null`,
    `Write-Output "OK"`,
    `} catch {`,
    `  Write-Error "추출 오류: $_"`,
    `  try { $wb.Close($false) } catch {}`,
    `  try { $excel.Quit() } catch {}`,
    `  try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}`,
    `  exit 1`,
    `}`
  ].join('\r\n');

  fs.writeFileSync(scriptPath, '﻿' + script, 'utf8');
}

// ── CSV → DB 동기화 ────────────────────────────────────
function syncFromCSV() {
  const lines = fs.readFileSync(PARTS_CSV, 'utf8').split('\n').filter(l => l.trim());
  const parts = readParts();
  const manualUsage = readUsage().filter(u => u.source !== 'excel_import');
  const newImportUsage = [];
  let addedParts = 0, updatedParts = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const line of lines) {
    const cols = parseCSVLine(line);
    const partNumber = (cols[0] || '').split('\n')[0].trim();
    const type       = normalizeType(cols[1] || '');
    const usedQty    = parseQty(cols[2]);
    const onhandQty  = parseQty(cols[3]);
    if (!partNumber.match(/^[A-Z0-9]{5,}/)) continue;

    const sajupReceived = parseQty(cols[4]);
    const sajupUsed     = parseQty(cols[5]);

    const existing = parts.findIndex(p => p.part_number === partNumber);
    if (existing === -1) {
      parts.push({
        id: nextId(parts), type, part_number: partNumber,
        description: '', mfg: '', iones_code: '',
        qty_threshold: 0, unit: 'EA',
        price_as_is: 0, price_to_be: 0,
        onhand_qty: onhandQty,
        sajup_received: sajupReceived, sajup_used: sajupUsed,
        created_at: now()
      });
      addedParts++;
    } else {
      if (type) parts[existing].type = type;
      parts[existing].onhand_qty    = onhandQty;
      parts[existing].sajup_received = sajupReceived;
      parts[existing].sajup_used     = sajupUsed;
      updatedParts++;
    }

    if (usedQty > 0) {
      newImportUsage.push({
        id: nextId([...manualUsage, ...newImportUsage]),
        date: today, part_number: partNumber, quantity: usedQty,
        note: '엑셀 동기화 - 누적 사용 수량',
        team: '구매팀', source: 'excel_import', created_at: now()
      });
    }
  }
  writeParts(parts);
  writeUsage([...newImportUsage, ...manualUsage]);

  // iones_codes.csv 동기화
  let updatedCodes = 0;
  if (fs.existsSync(CODES_CSV)) {
    const freshParts = readParts();
    const codeLines = fs.readFileSync(CODES_CSV, 'utf8').split('\n').filter(l => l.trim());
    for (const line of codeLines) {
      const cols = parseCSVLine(line);
      const pn   = (cols[0] || '').trim();
      const code = (cols[1] || '').trim();
      if (!pn || !code) continue;
      const idx = freshParts.findIndex(p => p.part_number === pn);
      if (idx !== -1 && freshParts[idx].iones_code !== code) {
        freshParts[idx].iones_code = code;
        updatedCodes++;
      }
    }
    writeParts(freshParts);
  }

  // lots_data.csv 동기화 (기존 판가는 유지)
  let addedLots = 0;
  if (fs.existsSync(LOTS_CSV)) {
    const lots = readLots();
    const latestParts = readParts();
    const lotLines = fs.readFileSync(LOTS_CSV, 'utf8').split('\n').filter(l => l.trim());

    for (const line of lotLines) {
      const cols     = parseCSVLine(line);
      const poNumber = (cols[0] || '').trim();
      const supplier = (cols[1] || '').trim();
      const ioesCode = (cols[2] || '').trim();
      const ordQty   = parseQty(cols[3]);
      const purPrice = parsePrice(cols[4]);
      if (!ioesCode || !poNumber) continue;

      const part = latestParts.find(p => p.iones_code === ioesCode);
      const partNumber = part ? part.part_number : '';
      const exists = lots.find(l => l.po_number === poNumber && l.iones_code === ioesCode);

      if (!exists) {
        lots.push({
          id: nextId(lots), po_number: poNumber, supplier,
          iones_code: ioesCode, part_number: partNumber,
          ordered_qty: ordQty, purchase_price: purPrice,
          selling_price: 0,
          order_date: parsePODate(poNumber),
          source: 'excel_import', created_at: now()
        });
        addedLots++;
      } else if (!exists.part_number && partNumber) {
        exists.part_number = partNumber;
      }
    }
    writeLots(lots);
  }

  return { addedParts, updatedParts, usageRecords: newImportUsage.length, updatedCodes, addedLots };
}

// ── API: 마스터파일 컬럼 진단 ───────────────────────────
app.post('/api/debug/master-columns', (req, res) => {
  try {
    const { master_path } = req.body;
    if (!master_path || !fs.existsSync(master_path)) return res.json({ error: '파일 없음' });
    const wb   = XLSX.readFile(master_path, { cellText: true, raw: false });
    const name = wb.SheetNames.find(n => /safeseal master/i.test(n)) || wb.SheetNames[1];
    const ws   = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const header = rows[1] || [];  // 실제 헤더는 2번째 행(index 1)

    // 필터 통과 레코드 (T 있음 + U 없음) 앞 20개 + raw cell 값도 함께
    const passed = [];
    for (let i = 2; i < rows.length && passed.length < 20; i++) {
      const r        = rows[i];
      const clnDate  = String(r[19] || '').trim();
      const delivery = String(r[20] || '').trim();
      const orderNo  = String(r[10] || '').trim();
      if (!clnDate || delivery || !orderNo) continue;
      // raw cell address 확인
      const cellT = ws['T' + (i + 1)];
      const cellU = ws['U' + (i + 1)];
      passed.push({
        row: i + 1,
        orderNo,
        T_val: clnDate,
        U_val: delivery,
        T_raw: cellT ? JSON.stringify({ t: cellT.t, v: cellT.v, w: cellT.w }) : 'null',
        U_raw: cellU ? JSON.stringify({ t: cellU.t, v: cellU.v, w: cellU.w }) : 'null',
      });
    }
    res.json({ sheetName: name, totalRows: rows.length, headerT: header[19], headerU: header[20], passed });
  } catch(e) { res.json({ error: e.message }); }
});

// ── API: 설정 ──────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const cfg = readConfig();
  // Railway(Linux)에서는 Windows 경로 데이터를 반환하지 않음
  if (process.platform !== 'win32') {
    delete cfg.mes_path;
    delete cfg.master_path;
  }
  res.json(cfg);
});
app.post('/api/config', (req, res) => {
  writeConfig({ ...readConfig(), ...req.body });
  res.json({ ok: true });
});

// ── API: 파트 목록 ─────────────────────────────────────
app.get('/api/parts', (req, res) => {
  res.json(readParts().sort((a, b) => (a.type + a.part_number).localeCompare(b.type + b.part_number)));
});

app.post('/api/parts', (req, res) => {
  const parts = readParts();
  const { type, part_number, description, mfg, qty_threshold, unit, price_as_is, price_to_be } = req.body;
  if (parts.find(p => p.part_number === part_number))
    return res.status(400).json({ error: '이미 등록된 Part Number입니다.' });
  parts.push({ id: nextId(parts), type, part_number, description, mfg, iones_code: '',
    qty_threshold: +qty_threshold, unit: unit || 'EA',
    price_as_is: +price_as_is, price_to_be: +price_to_be, created_at: now() });
  writeParts(parts);
  res.json({ ok: true });
});

app.put('/api/parts/:id', (req, res) => {
  const parts = readParts();
  const idx = parts.findIndex(p => p.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: '파트를 찾을 수 없습니다.' });
  const { type, part_number, description, mfg, qty_threshold, unit, price_as_is, price_to_be } = req.body;
  parts[idx] = { ...parts[idx], type, part_number, description, mfg,
    qty_threshold: +qty_threshold, unit, price_as_is: +price_as_is, price_to_be: +price_to_be };
  writeParts(parts);
  res.json({ ok: true });
});

app.delete('/api/parts/:id', (req, res) => {
  writeParts(readParts().filter(p => p.id !== +req.params.id));
  res.json({ ok: true });
});

// ── API: 배치(Lot) 관리 ───────────────────────────────
app.get('/api/lots', (req, res) => {
  const { part_number } = req.query;
  const parts = readParts().sort((a, b) => (a.type + a.part_number).localeCompare(b.type + b.part_number));
  const result = [];
  const targets = part_number ? parts.filter(p => p.part_number === part_number) : parts;
  for (const part of targets) {
    const { lots } = computeLotFIFO(part.part_number);
    result.push(...lots.map(l => ({ ...l, part_type: part.type })));
  }
  res.json(result);
});

app.post('/api/lots', (req, res) => {
  const { part_number, po_number, supplier, ordered_qty, purchase_price, selling_price, order_date } = req.body;
  if (!part_number || !ordered_qty)
    return res.status(400).json({ error: 'part_number, ordered_qty는 필수입니다.' });
  const part = readParts().find(p => p.part_number === part_number);
  const lots = readLots();
  lots.push({
    id: nextId(lots), po_number: po_number || '',
    supplier: supplier || '', iones_code: part ? (part.iones_code || '') : '',
    part_number, ordered_qty: +ordered_qty,
    purchase_price: +purchase_price || 0,
    selling_price: +selling_price || 0,
    order_date: order_date || parsePODate(po_number || ''),
    source: 'manual', created_at: now()
  });
  writeLots(lots);
  res.json({ ok: true });
});

app.put('/api/lots/:id', (req, res) => {
  const lots = readLots();
  const idx = lots.findIndex(l => l.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: '배치를 찾을 수 없습니다.' });
  const { selling_price, po_number, supplier, ordered_qty, purchase_price, order_date } = req.body;
  if (selling_price   !== undefined) lots[idx].selling_price  = +selling_price;
  if (po_number       !== undefined) lots[idx].po_number      = po_number;
  if (supplier        !== undefined) lots[idx].supplier       = supplier;
  if (ordered_qty     !== undefined) lots[idx].ordered_qty    = +ordered_qty;
  if (purchase_price  !== undefined) lots[idx].purchase_price = +purchase_price;
  if (order_date      !== undefined) lots[idx].order_date     = order_date;
  writeLots(lots);
  res.json({ ok: true });
});

app.delete('/api/lots/:id', (req, res) => {
  writeLots(readLots().filter(l => l.id !== +req.params.id));
  res.json({ ok: true });
});

// ── API: 대시보드 ──────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  const parts = readParts().sort((a, b) => (a.type + a.part_number).localeCompare(b.type + b.part_number));
  const usage = readUsage();
  res.json(parts.map(p => {
    const cumulative = usage.filter(u => u.part_number === p.part_number).reduce((s, u) => s + u.quantity, 0);
    const hasThreshold = p.qty_threshold > 0;
    const exceeded = hasThreshold && cumulative > p.qty_threshold;
    const remaining = hasThreshold ? Math.max(0, p.qty_threshold - cumulative) : null;
    const currentPrice = exceeded ? p.price_to_be : p.price_as_is;

    let status;
    if (!hasThreshold)                          status = 'fixed';
    else if (exceeded)                          status = p.price_to_be > 0 ? 'tobe' : 'sajup';
    else if (cumulative === p.qty_threshold)     status = 'switch';
    else if (remaining <= Math.ceil(p.qty_threshold * 0.15)) status = 'near';
    else                                        status = 'asis';

    return {
      ...p, cumulative, remaining,
      current_price: currentPrice,
      price_type: exceeded ? 'To-be' : 'As-is',
      status
    };
  }));
});

// ── API: 사용 이력 입력 ────────────────────────────────
app.post('/api/usage', (req, res) => {
  const { date, part_number, quantity, note, team } = req.body;
  if (!readParts().find(p => p.part_number === part_number))
    return res.status(400).json({ error: '등록되지 않은 Part Number입니다.' });
  const usage = readUsage();
  usage.push({ id: nextId(usage), date, part_number, quantity: +quantity,
    note: note || '', team: team || '', source: 'manual', created_at: now() });
  writeUsage(usage);
  res.json({ ok: true });
});

// ── API: 사용 이력 조회 ────────────────────────────────
app.get('/api/usage', (req, res) => {
  const { part_number } = req.query;
  const parts = readParts();
  let usage = readUsage();
  if (part_number) usage = usage.filter(u => u.part_number === part_number);
  usage.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  const enriched = usage.map(u => {
    const part = parts.find(p => p.part_number === u.part_number) || {};
    const allForPart = readUsage()
      .filter(x => x.part_number === u.part_number)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    let cumulative = 0;
    for (const row of allForPart) { cumulative += row.quantity; if (row.id === u.id) break; }
    const isToBeApplied = cumulative > (part.qty_threshold || 0);
    const applied_price = isToBeApplied ? part.price_to_be : part.price_as_is;
    return { ...u, description: part.description || '', type: part.type || '', cumulative,
      qty_threshold: part.qty_threshold || 0, price_as_is: part.price_as_is || 0,
      price_to_be: part.price_to_be || 0, price_type: isToBeApplied ? 'To-be' : 'As-is',
      applied_price: applied_price || 0, total_amount: u.quantity * (applied_price || 0) };
  });
  res.json(enriched);
});

app.delete('/api/usage/:id', (req, res) => {
  writeUsage(readUsage().filter(u => u.id !== +req.params.id));
  res.json({ ok: true });
});

// ── API: 경로 저장 + 스크립트 생성 ───────────────────
app.post('/api/import', (req, res) => {
  const { excel_path } = req.body;
  if (!excel_path) return res.status(400).json({ error: '엑셀 파일 경로를 입력해 주세요.' });
  try {
    generateExtractScript(excel_path);
    writeConfig({ ...readConfig(), excel_path });
    res.json({ ok: true, message: '경로가 저장되었습니다. 이제 데이터추출.bat 파일을 실행하세요.' });
  } catch (e) {
    res.status(500).json({ error: `설정 실패: ${e.message}` });
  }
});

// ── API: CSV → DB 최신화 ───────────────────────────────
app.post('/api/sync', (req, res) => {
  if (!fs.existsSync(PARTS_CSV))
    return res.status(400).json({ error: '추출된 데이터가 없습니다. 먼저 데이터추출.bat을 실행해 주세요.' });
  try {
    const r = syncFromCSV();
    res.json({ ok: true, ...r,
      message: `파트 ${r.addedParts}개 추가, ${r.updatedParts}개 업데이트, 배치 ${r.addedLots}개 추가, 사용 이력 ${r.usageRecords}건 최신화 완료` });
  } catch (e) {
    res.status(500).json({ error: `최신화 실패: ${e.message}` });
  }
});

// ── API: 공정 단가 조회/수정 ───────────────────────────
app.get('/api/process-costs', (req, res) => res.json(readProcessCosts()));
app.put('/api/process-costs', (req, res) => {
  fs.writeFileSync(PROCESS_COSTS_FILE, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// ── API: 견적 생성 ─────────────────────────────────────
app.post('/api/quotation/generate', (req, res) => {
  const { mes_path, master_path } = req.body;
  if (!mes_path)    return res.status(400).json({ error: 'MES 파일 경로를 입력해 주세요.' });
  if (!master_path) return res.status(400).json({ error: '마스터파일 경로를 입력해 주세요.' });
  if (!fs.existsSync(mes_path))    return res.status(400).json({ error: `MES 파일을 찾을 수 없습니다: ${mes_path}` });
  // 마스터파일은 클라우디움 경로인 경우 직접 접근 불가일 수 있으므로 존재 여부 체크 생략하고 Excel COM으로 시도

  try {
    writeConfig({ ...readConfig(), mes_path, master_path });

    // ── 1. MES 파싱 (DRM이거나 파일이 잠겨있으면 Excel COM으로 변환) ──
    let actualMesPath = mes_path;
    let mesNeedsConversion = false;
    try {
      const buf = Buffer.alloc(2);
      const fd  = fs.openSync(mes_path, 'r');
      fs.readSync(fd, buf, 0, 2, 0);
      fs.closeSync(fd);
      if (buf[0] === 0x9B && buf[1] === 0x20) mesNeedsConversion = true; // Fasoo DRM
    } catch {
      mesNeedsConversion = true; // 파일 잠김(DRM 에이전트 등) → Excel COM으로 시도
    }
    if (mesNeedsConversion) {
      actualMesPath = convertDrmToCSV(mes_path);
    }
    const mesWb   = XLSX.readFile(actualMesPath, { cellText: true, raw: false });
    const mesRows = XLSX.utils.sheet_to_json(mesWb.Sheets[mesWb.SheetNames[0]], { header: 1, defval: '' });

    const mesGroups = {};
    for (let i = 1; i < mesRows.length; i++) {
      const r = mesRows[i];
      const orderNo = String(r[3] || '').trim();
      if (!orderNo) continue;

      const snField  = String(r[5] || '').trim();
      const spaceIdx = snField.indexOf(' ');
      const pn = spaceIdx > 0 ? snField.slice(0, spaceIdx) : snField;
      const sn = spaceIdx > 0 ? snField.slice(spaceIdx + 1) : '';
      const processType = normalizeProcessKey(String(r[2] || ''));
      const matPN  = String(r[8] || '').trim();
      const matQty = parseInt(String(r[9] || '').replace(/[^0-9]/g, '')) || 0;

      if (!mesGroups[orderNo]) mesGroups[orderNo] = { processType, pn, sn, materials: [] };
      if (matPN) mesGroups[orderNo].materials.push({ pn: matPN, qty: matQty || 1 });
    }

    // ── 2. 마스터파일 파싱 (T열=CLN 완료, U열=Delivery 공란인 것만) ──
    // 클라우디움/DRM 파일은 Excel COM 변환 사용, 일반 파일은 XLSX 직접 읽기
    let msRows;
    let masterReadViaExcel = false;
    try {
      if (!fs.existsSync(master_path)) throw new Error('direct_read_fail');
      const masterWb = XLSX.readFile(master_path, { cellText: true, raw: false });
      const msName   = masterWb.SheetNames.find(n => /safeseal master/i.test(n)) || masterWb.SheetNames[1];
      msRows = XLSX.utils.sheet_to_json(masterWb.Sheets[msName], { header: 1, defval: '' });
    } catch {
      // 직접 읽기 실패 → Excel COM으로 시도 (클라우디움, DRM 등)
      masterReadViaExcel = true;
      const masterCsvPath = convertMasterToCSV(master_path);
      const masterWb2 = XLSX.readFile(masterCsvPath, { cellText: true, raw: false });
      msRows = XLSX.utils.sheet_to_json(masterWb2.Sheets[masterWb2.SheetNames[0]], { header: 1, defval: '' });
    }

    const masterTargets = [];   // 견적 대상 (모수)
    for (let i = 2; i < msRows.length; i++) {
      const r        = msRows[i];
      const clnDate  = String(r[19] || '').trim();  // T열: CLN Finsh date
      const delivery = String(r[20] || '').trim();  // U열: Delivery date
      const orderNo  = String(r[10] || '').trim();  // K열: 수주번호
      if (!clnDate || delivery || !orderNo) continue;  // T 비어있거나 U 채워져있으면 제외
      masterTargets.push({
        orderNo,
        pn:    String(r[6]  || '').trim(),
        sn:    String(r[7]  || '').trim(),
        po:    String(r[8]  || '').trim(),
        tkmNo: String(r[9]  || '').trim(),
      });
    }

    // ── 3. 파트 현재 단가 맵 ───────────────────────────
    const parts = readParts();
    const usage = readUsage();
    const partPriceMap = {};
    for (const p of parts) {
      const cum = usage.filter(u => u.part_number === p.part_number).reduce((s, u) => s + u.quantity, 0);
      const exceeded = p.qty_threshold > 0 && cum > p.qty_threshold;
      const info = {
        unitPrice:   exceeded ? p.price_to_be : p.price_as_is,
        unit:        p.unit,
        unitSize:    p.unit_size || 1,
        description: p.description,
        partType:    p.type,
        priceStatus: exceeded ? 'To-be' : 'As-is',
        canonicalPN: p.part_number,
      };
      partPriceMap[p.part_number] = info;
      if (Array.isArray(p.alt_numbers)) {
        p.alt_numbers.forEach(alt => { partPriceMap[alt] = info; });
      }
    }

    // ── 4. 마스터 모수 기준 매칭 + 견적 생성 ──────────
    const quotation = [];
    const issues    = [];
    const processCosts = readProcessCosts();

    for (const target of masterTargets) {
      const { orderNo, pn, sn, po, tkmNo } = target;
      const mes = mesGroups[orderNo];

      if (!mes) {
        issues.push({ 수주번호: orderNo, po, pn, sn,
          issue: 'MES 데이터 없음',
          detail: `마스터에 있으나 MES 파일에 "${orderNo}" 없음`,
          action: 'MES 파일 기간 확인 또는 수주번호 재확인' });
        continue;
      }

      // PN/SN 불일치 이슈 등록 (단, 견적 생성은 마스터 기준으로 계속 진행)
      if (mes.pn && mes.pn !== pn) {
        issues.push({ 수주번호: orderNo, po, pn, sn,
          issue: 'PN 불일치',
          detail: `마스터 PN: ${pn} / MES PN: ${mes.pn}`,
          action: 'PN 확인 필요 — 마스터 기준으로 견적 생성됨' });
      } else if (mes.sn && mes.sn !== sn) {
        issues.push({ 수주번호: orderNo, po, pn, sn,
          issue: 'SN 불일치',
          detail: `마스터 SN: ${sn} / MES SN: ${mes.sn}`,
          action: 'SN 확인 필요 — 마스터 기준으로 견적 생성됨' });
      }

      const procCost = processCosts[mes.processType];
      if (!procCost) {
        issues.push({ 수주번호: orderNo, po, pn, sn,
          issue: 'Process 단가 누락',
          detail: `공정 타입 "${mes.processType}" 단가 없음`,
          action: '공정 단가 설정 확인' });
        continue;
      }

      // WIPE DOWN에서만 Retainer·Lead In·Screw 제외 (CHEM SOAK·REFURB은 모두 허용)
      const REFURB_ONLY_TYPES = ['Retainer', 'Lead In', 'Screw'];
      const isWipeDown = mes.processType === 'WIPE DOWN';

      let hasBlockingIssue = false;
      const replParts = [];
      const excludedParts = [];   // 공정-파트 불일치로 제외된 파트 (수동 포함 가능)

      for (const mat of mes.materials) {
        const pi = partPriceMap[mat.pn];
        if (!pi || pi.unitPrice <= 0) {
          issues.push({ 수주번호: orderNo, po, pn, sn,
            issue: 'Replacement Part 단가 누락',
            detail: `파트 "${mat.pn}" 단가 정보 없음`,
            action: '파트 단가 시스템에서 해당 파트 등록/단가 입력' });
          hasBlockingIssue = true;
          continue;
        }

        // 공정-파트 타입 불일치: WIPE DOWN에서 Retainer/Lead In/Screw만 제외
        if (isWipeDown && REFURB_ONLY_TYPES.includes(pi.partType)) {
          const billingQty  = pi.unitSize > 1 ? Math.round(mat.qty / pi.unitSize) : mat.qty;
          const exTotalUSD  = pi.unitPrice * billingQty;
          const excludedPart = {
            pn: pi.canonicalPN || mat.pn, description: pi.description, partType: pi.partType,
            unit: pi.unit, unitSize: pi.unitSize,
            mesQty: mat.qty, qty: billingQty,
            unitPriceUSD: pi.unitPrice, unitPriceKRW: roundKRW(pi.unitPrice),
            totalUSD: exTotalUSD, totalKRW: roundKRW(exTotalUSD),
            priceStatus: pi.priceStatus,
          };
          excludedParts.push(excludedPart);
          issues.push({
            수주번호: orderNo, po, pn, sn,
            issue: '공정-파트 불일치',
            detail: `${mes.processType} 공정에 ${pi.partType}(${mat.pn}) 발생 — MES 입력 오류 가능성. 해당 파트는 견적에서 제외됨.`,
            action: 'MES 확인 후 이상 없으면 [수동 포함] 클릭',
            canManualInclude: true,
            manualData: {
              수주번호: orderNo, po, pn, sn, tkmNo,
              process: mes.processType, processName: procCost.name,
              processUSD: procCost.usd, processKRW: procCost.krw,
              excludedPart,
            },
          });
          continue;
        }

        const billingQty = pi.unitSize > 1 ? Math.round(mat.qty / pi.unitSize) : mat.qty;
        const totalUSD   = pi.unitPrice * billingQty;
        const totalKRW   = roundKRW(totalUSD);          // 합계 USD → KRW 변환 (단가 먼저 반올림 시 누적오차 방지)
        replParts.push({
          pn: pi.canonicalPN || mat.pn, description: pi.description, partType: pi.partType,
          unit: pi.unit, unitSize: pi.unitSize,
          mesQty: mat.qty, qty: billingQty,
          unitPriceUSD: pi.unitPrice, unitPriceKRW: roundKRW(pi.unitPrice),
          totalUSD, totalKRW,
          priceStatus: pi.priceStatus,
        });
      }
      if (hasBlockingIssue) continue;

      const replTotalUSD = replParts.reduce((s, p) => s + p.totalUSD, 0);
      const replTotalKRW = replParts.reduce((s, p) => s + p.totalKRW, 0);

      quotation.push({
        수주번호: orderNo, po, pn, sn, tkmNo,
        process: mes.processType, processName: procCost.name,
        processUSD: procCost.usd, processKRW: procCost.krw,
        replParts, replTotalUSD, replTotalKRW,
        totalUSD: procCost.usd + replTotalUSD,
        totalKRW: procCost.krw + replTotalKRW,
      });
    }

    const summary = {
      totalMES:        masterTargets.length,   // 마스터 기준 모수
      quotationCount:  quotation.length,
      issueCount:      issues.length,
      totalProcessUSD: quotation.reduce((s, q) => s + q.processUSD, 0),
      totalProcessKRW: quotation.reduce((s, q) => s + q.processKRW, 0),
      totalReplUSD:    quotation.reduce((s, q) => s + q.replTotalUSD, 0),
      totalReplKRW:    quotation.reduce((s, q) => s + q.replTotalKRW, 0),
      totalUSD:        quotation.reduce((s, q) => s + q.totalUSD, 0),
      totalKRW:        quotation.reduce((s, q) => s + q.totalKRW, 0),
    };

    res.json({ summary, quotation, issues });

  } catch (e) {
    res.status(500).json({ error: `견적 생성 실패: ${e.message}` });
  }
});

// ── API: 파일 업로드로 견적 생성 (Railway 클라우드용) ──
app.post('/api/quotation/generate-upload', upload.fields([
  { name: 'mes_file', maxCount: 1 },
  { name: 'master_file', maxCount: 1 }
]), (req, res) => {
  const mesFile    = req.files?.mes_file?.[0];
  const masterFile = req.files?.master_file?.[0];
  if (!mesFile)    return res.status(400).json({ error: 'MES 파일을 업로드해 주세요.' });
  if (!masterFile) return res.status(400).json({ error: '마스터파일을 업로드해 주세요.' });

  try {
    const mesWb   = XLSX.read(mesFile.buffer, { cellText: true, raw: false });
    const mesRows = XLSX.utils.sheet_to_json(mesWb.Sheets[mesWb.SheetNames[0]], { header: 1, defval: '' });
    fs.writeFileSync(path.join(DATA_DIR, 'mes_converted.csv'),
      XLSX.utils.sheet_to_csv(mesWb.Sheets[mesWb.SheetNames[0]]), 'utf8');

    const masterWb = XLSX.read(masterFile.buffer, { cellText: true, raw: false });
    const msName   = masterWb.SheetNames.find(n => /safeseal master/i.test(n)) || masterWb.SheetNames[1];
    const msRows   = XLSX.utils.sheet_to_json(masterWb.Sheets[msName], { header: 1, defval: '' });
    fs.writeFileSync(path.join(DATA_DIR, 'master_converted.csv'),
      XLSX.utils.sheet_to_csv(masterWb.Sheets[msName]), 'utf8');

    const mesGroups = {};
    for (let i = 1; i < mesRows.length; i++) {
      const r = mesRows[i];
      const orderNo = String(r[3] || '').trim();
      if (!orderNo) continue;
      const snField  = String(r[5] || '').trim();
      const spaceIdx = snField.indexOf(' ');
      const pn = spaceIdx > 0 ? snField.slice(0, spaceIdx) : snField;
      const sn = spaceIdx > 0 ? snField.slice(spaceIdx + 1) : '';
      const processType = normalizeProcessKey(String(r[2] || ''));
      const matPN  = String(r[8] || '').trim();
      const matQty = parseInt(String(r[9] || '').replace(/[^0-9]/g, '')) || 0;
      if (!mesGroups[orderNo]) mesGroups[orderNo] = { processType, pn, sn, materials: [] };
      if (matPN) mesGroups[orderNo].materials.push({ pn: matPN, qty: matQty || 1 });
    }

    const masterTargets = [];
    for (let i = 2; i < msRows.length; i++) {
      const r = msRows[i];
      const clnDate  = String(r[19] || '').trim();
      const delivery = String(r[20] || '').trim();
      const orderNo  = String(r[10] || '').trim();
      if (!clnDate || delivery || !orderNo) continue;
      masterTargets.push({
        orderNo, pn: String(r[6]||'').trim(), sn: String(r[7]||'').trim(),
        po: String(r[8]||'').trim(), tkmNo: String(r[9]||'').trim(),
      });
    }

    const parts = readParts(), usage = readUsage(), partPriceMap = {};
    for (const p of parts) {
      const cum = usage.filter(u => u.part_number === p.part_number).reduce((s, u) => s + u.quantity, 0);
      const exceeded = p.qty_threshold > 0 && cum > p.qty_threshold;
      const info = {
        unitPrice: exceeded ? p.price_to_be : p.price_as_is, unit: p.unit, unitSize: p.unit_size || 1,
        description: p.description, partType: p.type, priceStatus: exceeded ? 'To-be' : 'As-is',
        canonicalPN: p.part_number,
      };
      partPriceMap[p.part_number] = info;
      if (Array.isArray(p.alt_numbers)) p.alt_numbers.forEach(alt => { partPriceMap[alt] = info; });
    }

    const quotation = [], issues = [], processCosts = readProcessCosts();
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
      const replParts = [], excludedParts = [];
      for (const mat of mes.materials) {
        const pi = partPriceMap[mat.pn];
        if (!pi || pi.unitPrice <= 0) {
          issues.push({ 수주번호: orderNo, po, pn, sn, issue: 'Replacement Part 단가 누락',
            detail: `파트 "${mat.pn}" 단가 정보 없음`, action: '파트 단가 시스템에서 해당 파트 등록/단가 입력' });
          hasBlockingIssue = true; continue;
        }
        if (isWipeDown && REFURB_ONLY_TYPES.includes(pi.partType)) {
          const billingQty = pi.unitSize > 1 ? Math.round(mat.qty / pi.unitSize) : mat.qty;
          const exTotalUSD = pi.unitPrice * billingQty;
          const excludedPart = {
            pn: pi.canonicalPN || mat.pn, description: pi.description, partType: pi.partType,
            unit: pi.unit, unitSize: pi.unitSize, mesQty: mat.qty, qty: billingQty,
            unitPriceUSD: pi.unitPrice, unitPriceKRW: roundKRW(pi.unitPrice),
            totalUSD: exTotalUSD, totalKRW: roundKRW(exTotalUSD), priceStatus: pi.priceStatus,
          };
          excludedParts.push(excludedPart);
          issues.push({ 수주번호: orderNo, po, pn, sn, issue: '공정-파트 불일치',
            detail: `${mes.processType} 공정에 ${pi.partType}(${mat.pn}) 발생 — MES 입력 오류 가능성. 해당 파트는 견적에서 제외됨.`,
            action: 'MES 확인 후 이상 없으면 [수동 포함] 클릭', canManualInclude: true,
            manualData: { 수주번호: orderNo, po, pn, sn, tkmNo, process: mes.processType,
              processName: procCost.name, processUSD: procCost.usd, processKRW: procCost.krw, excludedPart } });
          continue;
        }
        const billingQty = pi.unitSize > 1 ? Math.round(mat.qty / pi.unitSize) : mat.qty;
        const totalUSD = pi.unitPrice * billingQty;
        replParts.push({
          pn: pi.canonicalPN || mat.pn, description: pi.description, partType: pi.partType,
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

    const summary = {
      totalMES: masterTargets.length, quotationCount: quotation.length, issueCount: issues.length,
      totalProcessUSD: quotation.reduce((s, q) => s + q.processUSD, 0),
      totalProcessKRW: quotation.reduce((s, q) => s + q.processKRW, 0),
      totalReplUSD: quotation.reduce((s, q) => s + q.replTotalUSD, 0),
      totalReplKRW: quotation.reduce((s, q) => s + q.replTotalKRW, 0),
      totalUSD: quotation.reduce((s, q) => s + q.totalUSD, 0),
      totalKRW: quotation.reduce((s, q) => s + q.totalKRW, 0),
    };
    res.json({ summary, quotation, issues });
  } catch(e) {
    res.status(500).json({ error: `견적 생성 실패: ${e.message}` });
  }
});

// ── API: 견적 엑셀 다운로드 ────────────────────────────
app.post('/api/quotation/excel', (req, res) => {
  const { quotation } = req.body;
  if (!quotation || !quotation.length)
    return res.status(400).json({ error: '견적 데이터가 없습니다.' });

  const PART_TYPE_ORDER = ['Wafer Seal', 'Contact Pin', 'Lead In', 'Screw', 'Retainer'];
  const usedTypes = PART_TYPE_ORDER.filter(pt =>
    quotation.some(q => q.replParts.some(p => p.partType === pt))
  );

  // ── 컬럼 정의 ──
  const headers = [
    'SS P/N', 'SS S/N', 'PO', '0247#', 'Process',
    'Cleaning price\n(USD)', 'Cleaning price\n(KRW)',
    ...usedTypes.flatMap(pt => [`${pt}\n(USD)`, `${pt}\n(KRW)`]),
    'Total\n(USD)', 'Total\n(KRW)', 'Remark'
  ];
  const FIXED  = 5;   // SS P/N ~ Process
  const numEnd = headers.length - 1;  // Remark 직전까지 숫자 열

  // ── 스타일 정의 ──
  const BORDER_HDR  = { style: 'thin', color: { rgb: '8DB4E2' } };
  const BORDER_DATA = { style: 'thin', color: { rgb: 'D9D9D9' } };
  const mkBorder = b => ({ top: b, bottom: b, left: b, right: b });

  const S_HDR = {
    fill: { fgColor: { rgb: 'D9E1F2' } },
    font: { bold: true, sz: 10, color: { rgb: '1F3864' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: mkBorder(BORDER_HDR),
  };
  const S_TEXT = {
    font: { sz: 10 },
    alignment: { vertical: 'center' },
    border: mkBorder(BORDER_DATA),
  };
  const S_USD = {
    font: { sz: 10 },
    numFmt: '"$"#,##0.00',
    alignment: { horizontal: 'right', vertical: 'center' },
    border: mkBorder(BORDER_DATA),
  };
  const S_KRW = {
    font: { sz: 10 },
    numFmt: '"₩"#,##0',
    alignment: { horizontal: 'right', vertical: 'center' },
    border: mkBorder(BORDER_DATA),
  };
  const S_PROC = {  // Process 열: 중앙 정렬
    font: { sz: 10 },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: mkBorder(BORDER_DATA),
  };
  const S_REMARK = {
    font: { sz: 10 },
    alignment: { vertical: 'center', wrapText: true },
    border: mkBorder(BORDER_DATA),
  };

  // 컬럼 인덱스 → 스타일 결정
  function cellStyle(ci) {
    if (ci < FIXED) return ci === 4 ? S_PROC : S_TEXT;
    if (ci === headers.length - 1) return S_REMARK;
    return (ci - FIXED) % 2 === 0 ? S_USD : S_KRW;
  }

  // ── 엑셀 컬럼 주소 변환 (0-based) ──
  function colAddr(n) {
    let s = '';
    for (n++; n > 0; n = Math.floor((n - 1) / 26))
      s = String.fromCharCode(((n - 1) % 26) + 65) + s;
    return s;
  }

  // ── 데이터 행 생성 ──
  const dataRows = quotation.map(q => {
    const byType = {};
    usedTypes.forEach(pt => { byType[pt] = { usd: 0, krw: 0 }; });
    q.replParts.forEach(p => {
      if (byType[p.partType]) {
        byType[p.partType].usd += p.totalUSD;
        byType[p.partType].krw += p.totalKRW;
      }
    });
    return [
      q.pn, q.sn, q.po || '', q.tkmNo || '', q.processName || q.process,
      q.processUSD, q.processKRW,
      ...usedTypes.flatMap(pt => [byType[pt].usd, byType[pt].krw]),
      q.totalUSD, q.totalKRW,
      [...q.replParts]
        .sort((a, b) => {
          const ORDER = ['Wafer Seal', 'Contact Pin', 'Retainer', 'Lead In', 'Screw'];
          return (ORDER.indexOf(a.partType) ?? 99) - (ORDER.indexOf(b.partType) ?? 99);
        })
        .map(p => `${p.pn}*${p.qty}`).join('\n'),
    ];
  });

  // ── 워크시트 조립 ──
  const ws = {};
  const totalRows = dataRows.length + 2;  // 행1(빈행) + 행2(헤더) + 데이터

  // 행 1: 빈 행 (참조 양식과 동일)
  // 행 2: 헤더
  headers.forEach((h, ci) => {
    ws[colAddr(ci) + '2'] = { v: h, t: 's', s: S_HDR };
  });

  // 행 3+: 데이터
  dataRows.forEach((row, ri) => {
    row.forEach((v, ci) => {
      const s = cellStyle(ci);
      const isNum = ci >= FIXED && ci < headers.length - 1;
      ws[colAddr(ci) + (ri + 3)] = {
        v: v ?? (isNum ? 0 : ''),
        t: isNum ? 'n' : 's',
        s,
      };
    });
  });

  ws['!ref'] = `A1:${colAddr(headers.length - 1)}${totalRows}`;

  // 열 너비
  ws['!cols'] = [
    { wch: 12 }, { wch: 14 }, { wch: 13 }, { wch: 12 }, { wch: 13 },
    { wch: 13 }, { wch: 15 },
    ...usedTypes.flatMap(() => [{ wch: 12 }, { wch: 15 }]),
    { wch: 12 }, { wch: 15 },
    { wch: 26 },
  ];

  // 행 높이
  ws['!rows'] = [
    { hpt: 8 },
    { hpt: 36 },
    ...dataRows.map(row => {
      const remark = row[row.length - 1] || '';
      const lines  = String(remark).split('\n').length;
      return { hpt: Math.max(18, lines * 16) };
    }),
  ];

  // 헤더 고정 (2행 고정)
  ws['!freeze'] = { xSplit: 0, ySplit: 2 };

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, '견적');
  const buf = XLSXStyle.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''%EA%B2%AC%EC%A0%81_${dateStr}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── API: 마스터 업데이트 프리뷰 (읽기 전용) ──────────────
const BASIC_SCREW_PN = 'A0405465';

const BASIC_SCREW_UNIT = 15;  // A0405465: 15ea = 1 set

function calcMasterFillData(mesData, partsMap) {
  let waferSealPN = '', contactPN = '', contactQty = 0;
  let basicScrewPN = '', basicScrewSetQty = 0;
  let otherScrewPN = '', otherScrewQty = 0;
  let retainerPN = '', leadInPN = '', leadInQty = 0;
  const typeQtys = {};  // AU용: { 'Wafer Seal': 1, 'Contact Pin': 2, ... }
  const allPNs = [];

  for (const mat of mesData.materials) {
    if (!mat.pn) continue;
    allPNs.push(mat.pn);
    const part = partsMap[mat.pn];
    const pt = part ? part.partType : null;

    if (pt === 'Wafer Seal') {
      waferSealPN = waferSealPN ? waferSealPN + ',' + mat.pn : mat.pn;
      typeQtys[pt] = (typeQtys[pt] || 0) + mat.qty;

    } else if (pt === 'Contact Pin') {
      if (!contactPN) contactPN = mat.pn;
      contactQty += mat.qty;
      typeQtys[pt] = (typeQtys[pt] || 0) + mat.qty;

    } else if (pt === 'Screw') {
      if (mat.pn === BASIC_SCREW_PN) {
        basicScrewPN = mat.pn;
        const sets = Math.max(1, Math.round(mat.qty / BASIC_SCREW_UNIT));
        basicScrewSetQty += sets;
        typeQtys['Screw'] = (typeQtys['Screw'] || 0) + sets;
      } else {
        if (!otherScrewPN) otherScrewPN = mat.pn;
        otherScrewQty += mat.qty;
        typeQtys['Screw'] = (typeQtys['Screw'] || 0) + mat.qty;
      }

    } else if (pt === 'Retainer') {
      retainerPN = mat.pn;
      typeQtys[pt] = (typeQtys[pt] || 0) + mat.qty;

    } else if (pt === 'Lead In') {
      if (!leadInPN) leadInPN = mat.pn;
      leadInQty += mat.qty;
      typeQtys[pt] = (typeQtys[pt] || 0) + mat.qty;
    }
  }

  // AT: 타이틀케이스로 변환
  const processDisplayMap = { 'CHEM SOAK': 'Chem Soak', 'REFURB': 'Refurb', 'WIPE DOWN': 'Wipe Down' };
  const ATdisplay = processDisplayMap[mesData.processType] || mesData.processType;

  // AU: 고정 순서 Wafer Seal → Contact Pin → Retainer → Lead In → Screw
  const AU_ORDER = ['Wafer Seal', 'Contact Pin', 'Retainer', 'Lead In', 'Screw'];
  const AU = AU_ORDER
    .filter(t => typeQtys[t] > 0)
    .map(t => `${t}*${typeQtys[t]}`)
    .join('\n');

  return {
    AT: ATdisplay,
    AU,
    AV: '',  // 공란
    AW: waferSealPN,
    AX: contactPN,
    AY: contactQty > 0 ? String(contactQty) : '',
    AZ: basicScrewPN,                                          // PN
    BA: basicScrewSetQty > 0 ? String(basicScrewSetQty) : '', // set 수량 (15ea→1)
    BB: otherScrewPN,
    BC: otherScrewQty > 0 ? String(otherScrewQty) : '',
    BD: retainerPN,
    BE: leadInPN,
    BF: leadInQty > 0 ? String(leadInQty) : '',
  };
}

// 공통 계산 함수 (preview·excel 공유)
function buildMasterFillResult() {
  const mesCsvPath    = path.join(DATA_DIR, 'mes_converted.csv');
  const masterCsvPath = path.join(DATA_DIR, 'master_converted.csv');
  if (!fs.existsSync(mesCsvPath))    throw new Error('먼저 견적 생성을 실행해 MES 파일을 변환하세요.');
  if (!fs.existsSync(masterCsvPath)) throw new Error('먼저 견적 생성을 실행해 마스터파일을 변환하세요.');

  // ── MES: 작업완료만 수집 ──
  const mesWb   = XLSX.readFile(mesCsvPath, { cellText: true, raw: false });
  const mesRows = XLSX.utils.sheet_to_json(mesWb.Sheets[mesWb.SheetNames[0]], { header: 1, defval: '' });
  const mesByOrder = {};
  for (let i = 1; i < mesRows.length; i++) {
    const r = mesRows[i];
    if (String(r[11] || '').trim() !== '작업완료') continue;
    const orderNo = String(r[3] || '').trim();
    if (!orderNo) continue;
    const process = String(r[2] || '').trim();
    const matPN   = String(r[8] || '').trim();
    const matQty  = parseInt(String(r[9] || '').replace(/[^0-9]/g, '')) || 1;
    if (!mesByOrder[orderNo]) mesByOrder[orderNo] = { processType: process, materials: [] };
    if (matPN) mesByOrder[orderNo].materials.push({ pn: matPN, qty: matQty });
  }

  // ── 파트맵 ──
  const partsMap = {};
  for (const p of readParts()) {
    partsMap[p.part_number] = { partType: p.type };
    if (p.alt_numbers) p.alt_numbers.forEach(a => { partsMap[a] = { partType: p.type }; });
  }

  // ── 마스터 매칭 ──
  const masterWb   = XLSX.readFile(masterCsvPath, { cellText: true, raw: false });
  const masterRows = XLSX.utils.sheet_to_json(masterWb.Sheets[masterWb.SheetNames[0]], { header: 1, defval: '' });
  const COL = { AT:45, AU:46, AV:47, AW:48, AX:49, AY:50, AZ:51, BA:52, BB:53, BC:54, BD:55, BE:56, BF:57 };

  const updates = [], alreadyFilled = [], noMesMatch = [], wipeShtSkipped = [];

  for (let i = 2; i < masterRows.length; i++) {
    const r       = masterRows[i];
    const orderNo = String(r[10] || '').trim();
    if (!orderNo) continue;
    const rowInfo = { excelRow: i+1, orderNo,
      pn: String(r[6]||'').trim(), sn: String(r[7]||'').trim(), po: String(r[8]||'').trim() };

    // 견적 대상 범위: T열(CLN date) 채워짐 + U열(Delivery date) 공란
    const clnDate  = String(r[19] || '').trim();
    const delivery = String(r[20] || '').trim();
    if (!clnDate || delivery) continue;  // 범위 밖 (CLN 미완료 또는 이미 납품)

    const mesData = mesByOrder[orderNo];
    if (!mesData) { noMesMatch.push(rowInfo); continue; }

    // WIPE DOWN + P열 SHT → 건너뜀
    if (mesData.processType === 'WIPE DOWN' && String(r[15] || '').trim().toUpperCase() === 'SHT') {
      wipeShtSkipped.push({ ...rowInfo, process: mesData.processType }); continue;
    }

    const currentAT = String(r[COL.AT] || '').trim();
    if (currentAT) { alreadyFilled.push({ ...rowInfo, existingProcess: currentAT }); continue; }

    const toWrite = calcMasterFillData(mesData, partsMap);
    for (const [col, idx] of Object.entries(COL)) {
      if (String(r[idx] || '').trim()) toWrite[col] = null;
    }
    updates.push({ ...rowInfo, toWrite });
  }

  return {
    stats: {
      totalMesCompleted: Object.keys(mesByOrder).length,
      toUpdate:       updates.length,
      alreadyFilled:  alreadyFilled.length,
      noMesMatch:     noMesMatch.length,
      wipeShtSkipped: wipeShtSkipped.length,
    },
    updates, alreadyFilled, noMesMatch, wipeShtSkipped,
  };
}

app.post('/api/master/fill-preview', (req, res) => {
  try { res.json(buildMasterFillResult()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: 마스터 업데이트 프리뷰 엑셀 다운로드 ────────────
app.post('/api/master/fill-excel', (req, res) => {
  try {
    const { stats, updates } = buildMasterFillResult();
    const COLS = ['AT','AU','AV','AW','AX','AY','AZ','BA','BB','BC','BD','BE','BF'];
    const COL_LABELS = {
      AT:'공정(AT)', AU:'교체여부(AU)', AV:'교체PN(AV)',
      AW:'Wafer Seal(AW)', AX:'Contact Pin PN(AX)', AY:'Contact Pin Q\'ty(AY)',
      AZ:'기본Screw qty(AZ)', BA:'Screw Q\'ty(BA)',
      BB:'Screw Other PN(BB)', BC:'Screw Other Q\'ty(BC)',
      BD:'Retainer(BD)', BE:'Lead In PN(BE)', BF:'Lead In Q\'ty(BF)',
    };

    const hdrStyle = {
      fill: { fgColor: { rgb: 'D9E1F2' } },
      font: { bold: true, sz: 10 },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: { top:{style:'thin',color:{rgb:'8DB4E2'}}, bottom:{style:'thin',color:{rgb:'8DB4E2'}},
                left:{style:'thin',color:{rgb:'8DB4E2'}}, right:{style:'thin',color:{rgb:'8DB4E2'}} },
    };
    const writeStyle = {
      font: { sz: 10, color: { rgb: '1A6E2E' } },
      border: { top:{style:'thin',color:{rgb:'D9D9D9'}}, bottom:{style:'thin',color:{rgb:'D9D9D9'}},
                left:{style:'thin',color:{rgb:'D9D9D9'}}, right:{style:'thin',color:{rgb:'D9D9D9'}} },
    };
    const skipStyle = {
      font: { sz: 10, color: { rgb: 'AAAAAA' }, italic: true },
      border: writeStyle.border,
    };
    const baseStyle = { font: { sz: 10 }, border: writeStyle.border };

    const colAddr = n => { let s=''; for(n++;n>0;n=Math.floor((n-1)/26)) s=String.fromCharCode(((n-1)%26)+65)+s; return s; };
    const headers = ['Excel행','수주번호','PN','SN', ...COLS.map(c => COL_LABELS[c])];
    const ws = {};

    // 헤더
    headers.forEach((h, ci) => { ws[colAddr(ci)+'1'] = { v: h, t:'s', s: hdrStyle }; });

    // 데이터
    updates.forEach((u, ri) => {
      const row = ri + 2;
      const fixed = [u.excelRow, u.orderNo, u.pn, u.sn];
      fixed.forEach((v, ci) => { ws[colAddr(ci)+row] = { v: v||'', t:'s', s: baseStyle }; });
      COLS.forEach((col, ci) => {
        const v = u.toWrite[col];
        const addr = colAddr(ci + 4) + row;
        if (v === null) { ws[addr] = { v: '(기존값 유지)', t:'s', s: skipStyle }; }
        else { ws[addr] = { v: v||'', t:'s', s: writeStyle }; }
      });
    });

    ws['!ref'] = `A1:${colAddr(headers.length-1)}${updates.length+1}`;
    ws['!cols'] = [
      {wch:8},{wch:16},{wch:12},{wch:12},
      {wch:12},{wch:10},{wch:20},{wch:16},{wch:16},{wch:14},{wch:14},{wch:12},{wch:14},{wch:14},{wch:10},{wch:14},{wch:14}
    ];
    ws['!rows'] = [{hpt:36}, ...updates.map(()=>({hpt:18}))];

    const wb = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(wb, ws, '마스터업데이트');
    const buf = XLSXStyle.write(wb, { type:'buffer', bookType:'xlsx' });
    const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''%EB%A7%88%EC%8A%A4%ED%84%B0%EC%97%85%EB%8D%B0%EC%9D%B4%ED%8A%B8_${dateStr}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 서버 시작 ──────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const ifaces of Object.values(interfaces))
    for (const iface of ifaces)
      if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
  console.log('\n✅ 서버 시작!');
  console.log(`   내 PC:     http://localhost:${PORT}`);
  console.log(`   팀원 접속:  http://${localIP}:${PORT}`);
  console.log('\n종료하려면 Ctrl+C를 누르세요.\n');
});
