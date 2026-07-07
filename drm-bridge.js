/**
 * DRM Bridge - GitHub Pages 앱에서 DRM 파일을 처리하기 위한 로컬 서버
 * 포트 3001에서 실행. DRM 파일을 Excel COM으로 열어 CSV로 반환.
 * 실행: node drm-bridge.js (또는 start-drm-bridge.bat 더블클릭)
 */
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawnSync } = require('child_process');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT   = 3001;
const TMP    = os.tmpdir();

// CORS - GitHub Pages + localhost 허용
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function runPs(script, name) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, '﻿' + script, 'utf8');
  const r = spawnSync('powershell', ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p],
    { encoding: 'utf8', timeout: 120000 });
  try { fs.unlinkSync(p); } catch {}
  return r;
}

function killExcel() {
  runPs("Get-Process EXCEL -EA SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process -Force",
    '_drm_kill.ps1');
}

function excelToCsv(srcPath, sheetSelector) {
  killExcel();
  const outPath = path.join(TMP, 'drm_out_' + Date.now() + '.csv');
  const sheetCode = sheetSelector === 'master'
    ? `$ws = $null
  foreach ($s in $wb.Sheets) { if ($s.Name -match '(?i)safeseal master') { $ws = $s; break } }
  if (-not $ws) { $ws = $wb.Sheets.Item(2) }`
    : `$ws = $wb.Sheets.Item(1)`;

  const script = `
$ErrorActionPreference = 'Stop'
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AskToUpdateLinks = $false
  $wb = $excel.Workbooks.Open('${srcPath.replace(/'/g, "''")}', 0, $true)
  ${sheetCode}
  $range  = $ws.UsedRange
  $values = $range.Value2
  $rows   = $range.Rows.Count
  $cols   = $range.Columns.Count
  $lines  = [System.Collections.Generic.List[string]]::new()
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
  try { $excel.Quit() }     catch {}
  Write-Error "변환 실패: $_"; exit 1
}`;

  const r = runPs(script, '_drm_convert.ps1');
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'Excel 변환 실패');
  const csv = fs.readFileSync(outPath, 'utf8');
  try { fs.unlinkSync(outPath); } catch {}
  return csv;
}

// 헬스체크
app.get('/ping', (req, res) => res.json({ ok: true, version: '2.0' }));

// 경로로 직접 파일 읽기 (공유폴더 자동 로드용)
app.get('/read-file', (req, res) => {
  const filePath = decodeURIComponent(req.query.path || '');
  const type     = req.query.type || 'master';
  if (!filePath) return res.status(400).json({ error: 'path required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일 없음: ' + filePath });
  try {
    console.log(`[DRM] 경로 읽기: ${filePath} (${type})`);
    const csv = excelToCsv(filePath, type);
    console.log(`[DRM] 완료: ${csv.split('\n').length}행`);
    res.type('text/plain; charset=utf-8').send(csv);
  } catch(e) {
    console.error('[DRM] 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DRM 파일 변환 (MES 또는 마스터)
app.post('/drm-convert', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

  const type    = req.body.type || 'mes'; // 'mes' | 'master'
  const origExt = path.extname(req.file.originalname || '').toLowerCase() || '.xlsx';
  const tmpPath = path.join(TMP, 'drm_input_' + Date.now() + origExt);

  try {
    fs.writeFileSync(tmpPath, req.file.buffer);
    console.log(`[DRM] 변환 시작: ${req.file.originalname} (${type})`);
    const csv = excelToCsv(tmpPath, type);
    console.log(`[DRM] 변환 완료: ${csv.split('\n').length}행`);
    res.type('text/plain; charset=utf-8').send(csv);
  } catch (e) {
    console.error('[DRM] 오류:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
});

// YJLEE 시트 채우기 + 매크로 실행
app.post('/fill-statement', express.json({ limit: '10mb' }), (req, res) => {
  const {
    template_path, output_path, rows,
    run_macro = true, macro_name = 'YJLEE', data_row_start = 4,
  } = req.body;

  if (!template_path) return res.status(400).json({ error: 'template_path required' });
  if (!output_path)   return res.status(400).json({ error: 'output_path required' });
  if (!rows || !rows.length) return res.status(400).json({ error: 'rows required' });

  if (!fs.existsSync(template_path))
    return res.status(404).json({ error: '템플릿 파일 없음: ' + template_path });

  const dataFile  = path.join(TMP, 'yjlee_data_' + Date.now() + '.json');
  const startRow  = parseInt(data_row_start) || 4;
  const macroCode = run_macro
    ? `$excel.Application.Run("${macro_name}"); Write-Output "MACRO_RUN"`
    : '# macro skipped';

  try {
    fs.writeFileSync(dataFile, JSON.stringify(rows), 'utf8');
  } catch (e) {
    return res.status(500).json({ error: '임시파일 쓰기 실패: ' + e.message });
  }

  const outDir = path.dirname(output_path);
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $dataJson = [System.IO.File]::ReadAllText('${dataFile.replace(/\\/g, '\\\\')}')
  $data = $dataJson | ConvertFrom-Json

  $outDir = '${outDir.replace(/\\/g, '\\\\')}'
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AskToUpdateLinks = $false

  $wb = $excel.Workbooks.Open('${template_path.replace(/\\/g, '\\\\').replace(/'/g, "''")}', 0, $false)

  $ws = $null
  foreach ($s in $wb.Sheets) { if ($s.Name -eq 'YJLEE') { $ws = $s; break } }
  if (-not $ws) { throw 'YJLEE 시트를 찾을 수 없습니다.' }

  # 기존 데이터 행 지우기
  $lastRow = $ws.UsedRange.Row + $ws.UsedRange.Rows.Count - 1
  if ($lastRow -ge ${startRow}) {
    $ws.Range($ws.Cells(${startRow}, 1), $ws.Cells($lastRow, 35)).ClearContents()
  }

  # 데이터 쓰기
  $r = ${startRow}
  foreach ($row in $data) {
    $ws.Cells($r,  1).Value2 = "$($row.no)"
    $ws.Cells($r,  2).Value2 = "$($row.customer)"
    $ws.Cells($r,  3).Value2 = "$($row.fab)"
    $ws.Cells($r,  4).Value2 = "$($row.tool)"
    $ws.Cells($r,  5).Value2 = "$($row.pn)"
    $ws.Cells($r,  6).Value2 = "$($row.sn)"
    $ws.Cells($r,  7).Value2 = "$($row.po)"
    $ws.Cells($r,  8).Value2 = "$($row.tkm_no)"
    if ($null -ne $row.usd -and "$($row.usd)" -ne '') { $ws.Cells($r,  9).Value2 = [double]$row.usd }
    if ($null -ne $row.krw -and "$($row.krw)" -ne '') { $ws.Cells($r, 30).Value2 = [double]$row.krw }
    $r++
  }

  # 저장 (xlOpenXMLWorkbookMacroEnabled = 52)
  $wb.SaveAs('${output_path.replace(/\\/g, '\\\\').replace(/'/g, "''")}', 52)
  Write-Output "SAVED"

  # 매크로 실행
  ${macroCode}

  $wb.Close($false)
  $excel.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null

  Write-Output "OK:$($data.Count)"
} catch {
  try { $wb.Close($false) } catch {}
  try { $excel.Quit() }     catch {}
  Write-Error "실패: $_"; exit 1
}`;

  killExcel();
  const r = runPs(script, '_fill_statement.ps1');
  try { fs.unlinkSync(dataFile); } catch {}

  if (r.status !== 0) {
    console.error('[fill-statement] 오류:', r.stderr || r.stdout);
    return res.status(500).json({ error: r.stderr || r.stdout || 'Excel 처리 실패' });
  }
  console.log('[fill-statement] 완료:', r.stdout?.trim());
  res.json({ ok: true, output_path, rows_written: rows.length, log: r.stdout?.trim() });
});

app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips  = [];
  for (const iface of Object.values(nets)) {
    for (const n of iface) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('');
  console.log('====================================');
  console.log(' DRM Bridge 서버 실행 중');
  console.log(` localhost:    http://localhost:${PORT}`);
  ips.forEach(ip => console.log(` 네트워크IP:  http://${ip}:${PORT}  ← 다른 사람에게 이 주소 알려주세요`));
  console.log(' 종료: Ctrl+C');
  console.log('====================================');
  console.log('');
});
