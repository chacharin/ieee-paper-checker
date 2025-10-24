// app.js (V2) — IEEE Style Paper Checker
// UI ไทยเต็มรูปแบบ, ซ่อนรายละเอียดระบบภายในจากผู้ใช้

const els = {
  apiKey: document.getElementById('apiKey'),
  file: document.getElementById('pdfFile'),
  btn: document.getElementById('analyzeBtn'),
  log: document.getElementById('log'),

  // loading
  loadingArea: document.getElementById('loadingArea'),
  loadingMsg: document.getElementById('loadingMsg'),

  // result + actions
  resultRender: document.getElementById('resultRender'),
  downloadCsvBtn: document.getElementById('downloadCsvBtn'),
};

let PROMPT_TEXT = "";           // เก็บ prompt จากไฟล์ภายนอก (ซ่อนไม่แสดงต่อผู้ใช้)
let LAST_CSV_BLOB_URL = null;   // object URL สำหรับดาวน์โหลด CSV

// --------------------- Logging (สำหรับผู้ใช้) ---------------------
function log(msg, obj) {
  const now = new Date();
  const thaiTime = now.toLocaleString("th-TH", { 
    timeZone: "Asia/Bangkok", 
    hour12: false 
  });
  const line = obj
    ? `[${thaiTime}] ${msg} ${JSON.stringify(obj)}`
    : `[${thaiTime}] ${msg}`;
  console.log(line);
  els.log.textContent += line + "\n";
  els.log.scrollTop = els.log.scrollHeight;
}

// --------------------- Loading animation ---------------------
function showThinking(text = "กำลังประมวลผลเอกสาร …") {
  if (!els.loadingArea) return;
  if (els.loadingMsg) els.loadingMsg.textContent = text;
  els.loadingArea.hidden = false;
}
function hideThinking() {
  if (!els.loadingArea) return;
  els.loadingArea.hidden = true;
}

// --------------------- Load prompt.txt (ซ่อนรายละเอียด) ---------------------
async function loadPrompt() {
  // ซ่อน URL/ผู้ให้บริการจาก UI: ไม่ log แหล่งที่มา
  const url = "https://raw.githubusercontent.com/chacharin/ieee-paper-checker/refs/heads/main/prompt.txt";
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`โหลดคำสั่งตรวจไม่สำเร็จ: ${res.status}`);
    PROMPT_TEXT = await res.text();
    log("พร้อมสำหรับการตรวจเอกสาร");
  } catch (err) {
    log("❌ ไม่สามารถเตรียมคำสั่งตรวจได้", { message: err.message });
    alert("ไม่สามารถเริ่มต้นระบบได้ กรุณาลองรีเฟรชหน้าอีกครั้ง");
    els.btn.disabled = true;
  }
}

// --------------------- Read PDF as Base64 ---------------------
async function readFileAsBase64(file) {
  log("กำลังอ่านไฟล์เอกสาร", { name: file.name, size: file.size });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      log("แปลงไฟล์เป็นรูปแบบที่เหมาะสมแล้ว", { bytes: bytes.byteLength });
      resolve(b64);
    };
    reader.readAsArrayBuffer(file);
  });
}

// --------------------- Build request payload ---------------------
function buildRequest(base64) {
  log("เตรียมข้อมูลสำหรับการตรวจ");
  return {
    contents: [{
      role: "user",
      parts: [
        { text: PROMPT_TEXT },
        {
          inline_data: {
            mime_type: "application/pdf",
            data: base64
          }
        }
      ]
    }]
  };
}

// --------------------- Call analysis backend ---------------------
// หมายเหตุ: ไม่ log ชื่อผู้ให้บริการ/ปลายทางให้ผู้ใช้เห็น
async function callAnalyzer(apiKey, payload) {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  const url = `${endpoint}?key=${encodeURIComponent(apiKey)}`;

  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const t1 = performance.now();

  log("ได้รับการตอบกลับจากระบบตรวจ", { ms: Math.round(t1 - t0), status: res.status });
  if (!res.ok) {
    const txt = await res.text();
    log("⚠️ ข้อผิดพลาดจากระบบตรวจ", { body: txt.slice(0, 400) });
    throw new Error(`ไม่สามารถตรวจเอกสารได้ (รหัส ${res.status})`);
  }
  return res.json();
}

// --------------------- Parse response to text ---------------------
function parseResponse(json) {
  log("กำลังสรุปผลลัพธ์");
  try {
    const candidates = json?.candidates || [];
    if (!candidates.length) return "ไม่มีผลลัพธ์ที่สามารถแสดงได้";
    const parts = candidates[0]?.content?.parts || [];
    const text = parts.map(p => p.text).filter(Boolean).join("\n");
    return text || "ไม่มีข้อความในผลลัพธ์";
  } catch {
    return "ไม่สามารถอ่านโครงสร้างผลลัพธ์ได้";
  }
}

// --------------------- Markdown renderer (safe) ---------------------
function renderMarkdownToHTML(markdownText) {
  const rawHtml = marked.parse(markdownText ?? "", { breaks: true, gfm: true });
  const safeHtml = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
  return safeHtml;
}

// --------------------- Extract first Markdown table → CSV (UTF-8 BOM) ---------------------
function extractFirstMarkdownTable(md) {
  if (!md) return null;
  const lines = md.split(/\r?\n/);

  let start = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    const L1 = lines[i].trim();
    const L2 = lines[i + 1]?.trim() ?? "";
    const looksLikeHeader = /^\|.+\|$/.test(L1);
    const looksLikeSep = /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|$/.test(L2);
    if (looksLikeHeader && looksLikeSep) { start = i; break; }
  }
  if (start === -1) return null;

  const tableLines = [];
  for (let i = start; i < lines.length; i++) {
    const s = lines[i].trim();
    if (/^\|.+\|$/.test(s)) tableLines.push(s);
    else break;
  }
  if (tableLines.length < 2) return null;

  const headerLine = tableLines[0];
  const bodyLines = tableLines.slice(2); // ข้ามเส้นคั่น
  const headers = headerLine.split("|").slice(1, -1).map(x => x.trim());
  const rows = bodyLines.map(l => l.split("|").slice(1, -1).map(x => x.trim()));

  // CSV (escape) + UTF-8 with BOM
  const esc = (s) => {
    if (s == null) return "";
    const hasSpecial = /[",\n]/.test(s);
    const cleaned = String(s).replace(/"/g, '""');
    return hasSpecial ? `"${cleaned}"` : cleaned;
  };
  const csvCore = [headers.map(esc).join(","), ...rows.map(r => r.map(esc).join(","))].join("\n");
  const csvWithBOM = "\uFEFF" + csvCore; // UTF-8 BOM เพื่อให้ Excel/Sheets รับภาษาไทยถูกต้อง

  return { headers, rows, markdown: tableLines.join("\n"), csv: csvWithBOM };
}

// เติมคลาสให้ตารางแรกเพื่อให้ได้สไตล์จาก CSS
function decorateFirstTableIn(element) {
  const table = element.querySelector("table");
  if (table) table.classList.add("ieee-table"); // ใช้ style .result table ใน CSS
}

// --------------------- CSV download ---------------------
function enableCsvDownload(csvText, filename = "ieee_mapping_utf8.csv") {
  if (LAST_CSV_BLOB_URL) URL.revokeObjectURL(LAST_CSV_BLOB_URL);
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  LAST_CSV_BLOB_URL = URL.createObjectURL(blob);

  els.downloadCsvBtn.disabled = false;
  els.downloadCsvBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = LAST_CSV_BLOB_URL;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    log("ดาวน์โหลดตาราง Mapping (CSV, UTF-8) เรียบร้อย");
  };
}

// --------------------- Main flow ---------------------
els.btn.addEventListener("click", async () => {
  try {
    // แจ้งเวลาโดยประมาณก่อนเริ่ม
    alert("ระบบกำลังตรวจเอกสาร ซึ่งอาจใช้เวลาประมวลผลประมาณ 2 นาทีต่อหน้า กรุณารอจนกว่าผลลัพธ์จะปรากฏ");

    // reset UI
    els.resultRender.innerHTML = "";
    els.downloadCsvBtn.disabled = true;
    els.log.textContent = "";
    if (LAST_CSV_BLOB_URL) { URL.revokeObjectURL(LAST_CSV_BLOB_URL); LAST_CSV_BLOB_URL = null; }

    const apiKey = els.apiKey.value.trim();
    const file = els.file.files?.[0];
    if (!apiKey) { alert("กรุณากรอกรหัสการเข้าถึง"); return; }
    if (!file) { alert("กรุณาเลือกไฟล์ PDF"); return; }

    els.btn.disabled = true;
    log("เริ่มกระบวนการตรวจเอกสาร");

    // 1) อ่านไฟล์ + เตรียม payload (ยังไม่แสดงแอนิเมชัน)
    const base64 = await readFileAsBase64(file);
    const payload = buildRequest(base64);

    // 2) ช่วงรอวิเคราะห์ — แสดงเฉพาะตอนนี้
    showThinking("กำลังประมวลผลเอกสาร …");
    const json = await callAnalyzer(apiKey, payload);
    hideThinking();

    // 3) แสดงผล
    const text = parseResponse(json);
    const html = renderMarkdownToHTML(text);
    els.resultRender.innerHTML = html;
    decorateFirstTableIn(els.resultRender);

    // 4) ตรวจหาตาราง Mapping เพื่อเปิดดาวน์โหลด CSV (UTF-8 BOM)
    const tableInfo = extractFirstMarkdownTable(text);
    if (tableInfo && tableInfo.csv && tableInfo.rows?.length) {
      enableCsvDownload(tableInfo.csv, "ieee_mapping_utf8.csv");
      log("ตรวจพบตาราง Mapping", { rows: tableInfo.rows.length, cols: tableInfo.headers.length });
    } else {
      log("ไม่พบทดลอง Mapping ในรายงาน");
    }

    log("เสร็จสิ้นการตรวจเอกสาร ✓");
  } catch (err) {
    console.error(err);
    hideThinking();
    log("❌ เกิดข้อผิดพลาด", { message: err?.message || String(err) });
    els.resultRender.innerHTML = `<div style="color:#C62828;font-weight:700">เกิดข้อผิดพลาด: ${DOMPurify.sanitize(err?.message || String(err))}</div>`;
  } finally {
    els.btn.disabled = false;
  }
});

// --------------------- Init ---------------------
document.addEventListener("DOMContentLoaded", async () => {
  log("กำลังเตรียมระบบ…");
  await loadPrompt();
  log("ระบบพร้อมใช้งาน ✓");
});
