// Финотчёт ВБ: разрез по артикулам. Статический порт finreport.py — всё считается в браузере.
// Данные живут в памяти вкладки; настройки налогов и фильтра — в localStorage.
"use strict";

const ART = {};    // nm_id -> метрики из детализации
const OTHER = {};  // nm_id -> тип удержания -> сумма
const COST = {};   // nm_id -> себестоимость за штуку
const ADV = {};    // nm_id -> затраты на РК
const STORAGE = {}; // nm_id -> сумма из отчёта платного хранения; если непусто — заменяет хранение из финотчёта
let TAX = { mode: "", choice: "", custom: "" };  // choice: 6/15/25/other/none
let SKIP = false;  // прятать «Оказание услуг WB Продвижение» — фильтр на показе, данные не трогает
let showOther = false, showTax = false;

const INCOME_MODES = ["УСН «Доходы»", "НПД"];  // база — вся выручка; иначе — прибыль до налога
const TAX_DEFAULTS = { "УСН «Доходы»": "6", "УСН «Доходы минус расходы»": "15", "НПД": "other", "ОСН": "25" };

// префикс нормализованного заголовка -> ключ метрики
const HEADERS = {
  "код номенклатуры": "nm",
  "артикул поставщика": "supplier_art",
  "тип документа": "doc",
  "обоснование для оплаты": "oplata",
  "кол-во": "qty",
  "вайлдберриз реализовал товар": "sold",
  "цена розничная с учетом": "retail",  // «Цена розничная с учетом согласованной скидки» — база выручки
  "к перечислению продавцу": "pay",
  "услуги по доставке товара покупателю": "logistics",
  "возмещение издержек по эквайрингу": "acquiring",
  "эквайринг/комиссии за организацию платежей": "acquiring",
  "общая сумма штрафов": "fines",
  "хранение": "storage",
  "операции при приёмке": "acceptance",
  "платная приемка": "acceptance",
  "удержания": "deduction",
  "корректировка вознаграждения": "vv_corr",
  "возмещение издержек": "reimb",
  "стоимость участия в программе лояльности": "loy_cost",
  "сумма, удержанная за начисленные баллы": "loy_points",
  "сумма удержанная за начисленные баллы": "loy_points",
  "компенсация скидки по программе лояльности": "loy_comp",
  "виды логистики": "vid",  // «Виды логистики, штрафов и корректировок ВВ» — расшифровка удержаний
};

function num(v) {
  const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(/,/g, "."));
  return isNaN(n) ? 0 : n;
}

function isPromo(label) {
  return label.toLowerCase().includes("wb продвижение");
}

function taxRate() {
  const c = TAX.choice;
  if (!c || c === "none") return null;
  if (c === "other") return num(TAX.custom) || null;
  return parseFloat(c);
}

function artEntry(nm) {
  if (!ART[nm]) {
    ART[nm] = { supplier_art: "", qty_sold: 0, qty_ret: 0, sold: 0, revenue: 0, pay: 0, acquiring: 0,
                loy_comp: 0, comp: 0, logistics: 0, fines: 0, storage: 0, acceptance: 0, other: 0 };
    OTHER[nm] = {};
  }
  return ART[nm];
}

// Обоснования для оплаты, входящие в выручку
const SALE_OPLATA = new Set(["продажа", "авансовая оплата за товар без движения", "компенсация подмененного товара", "корректная продажа", "частичная компенсация брака"]);
const RET_OPLATA  = new Set(["возврат", "авансовая оплата за товар без движения", "компенсация подмененного товара", "корректный возврат", "частичная компенсация брака"]);

function parseReport(rows) {
  const head = rows[0] || [];
  const col = {};
  head.forEach((h, i) => {
    // сравнение без пробелов: «Эквайринг / Комиссии…» и «Эквайринг/Комиссии…» — одно и то же
    const hn = String(h ?? "").toLowerCase().replace(/\s+/g, "");
    for (const [prefix, key] of Object.entries(HEADERS))
      if (hn.startsWith(prefix.replace(/\s+/g, "")) && !(key in col)) { col[key] = i; break; }
  });
  if (!("nm" in col) || !("pay" in col))
    throw new Error("не похоже на детализацию ВБ: нет столбцов «Код номенклатуры»/«К перечислению»");
  for (const k of Object.keys(ART)) delete ART[k];
  for (const k of Object.keys(OTHER)) delete OTHER[k];
  for (const r of rows.slice(1)) {
    const g = k => (k in col && col[k] < r.length) ? r[col[k]] : null;
    let nm = String(g("nm") ?? "").trim();
    if (nm === "" || nm === "0" || nm === "None") nm = "— без артикула";
    const a = artEntry(nm);
    if (g("supplier_art")) a.supplier_art = String(g("supplier_art"));
    const oplata = String(g("oplata") ?? "").trim().toLowerCase();
    const docType = String(g("doc") ?? "").trim().toLowerCase();
    const sign = docType === "возврат" ? -1 : 1;
    // Компенсации: «Компенсация ущерба» и «Добровольная компенсация при возврате» (тип документа или обоснование)
    const isComp = ["компенсация ущерба", "добровольная компенсация при возврате"].some(c => docType === c || oplata === c);
    if (oplata === "продажа") a.qty_sold += num(g("qty"));
    else if (oplata === "возврат") a.qty_ret += num(g("qty"));
    a.sold += sign * num(g("sold"));
    a.pay += sign * num(g("pay"));
    // Выручка: «Цена розничная с учетом согласованной скидки», только пары Тип документа × Обоснование как в GSheets
    if (docType === "продажа" && SALE_OPLATA.has(oplata)) a.revenue += num(g("retail"));
    else if (docType === "возврат" && RET_OPLATA.has(oplata)) a.revenue -= num(g("retail"));
    if (isComp) a.comp += sign * num(g("pay"));  // ponytail: компенсации = «К перечислению» этих строк; поменять на Пр, если сверка с GSheets разойдётся
    a.logistics += num(g("logistics"));
    // эквайринг как в GSheets: только (Продажа, Продажа) минус (Возврат, Возврат)
    if (docType === "продажа" && oplata === "продажа") a.acquiring += num(g("acquiring"));
    else if (docType === "возврат" && oplata === "возврат") a.acquiring -= num(g("acquiring"));
    a.loy_comp += num(g("loy_comp"));  // компенсация скидки ПЛ — не продажа, но увеличивает «К перечислению»
    a.fines += num(g("fines"));
    a.storage += num(g("storage"));
    a.acceptance += num(g("acceptance"));
    // всё редкое — в одну корзину «прочие удержания»; знаки по инструкции ВБ (удержание «+», выплата «−»)
    // тип берём из «Виды логистики, штрафов и корректировок ВВ», иначе из обоснования
    const vid = String(g("vid") ?? "").trim();
    const oth = (label, val) => {
      if (val) {
        a.other += val;
        OTHER[nm][label] = (OTHER[nm][label] || 0) + val;
      }
    };
    oth(vid || String(g("oplata") ?? "").trim() || "Удержания", num(g("deduction")));
    oth(vid || "Корректировка ВВ", num(g("vv_corr")));
    oth("Возмещение издержек", num(g("reimb")));
    oth("Участие в программе лояльности", num(g("loy_cost")));
    oth("Баллы программы лояльности", num(g("loy_points")));
    oth("Компенсация скидки ПЛ", -num(g("loy_comp")));
  }
}

// xlsx или csv → список строк-списков (первый лист)
function readRows(file) {
  return file.arrayBuffer().then(buf => {
    const wb = XLSX.read(buf, { type: "array", raw: true, codepage: 65001 });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  });
}

function compute(oFlag, tFlag) {
  // Собранная таблица: {cols, rows, foot, rate}. Значения сырые числа; маржа/итог могут быть null.
  const rate = taxRate();
  const typeTot = {};
  for (const d of Object.values(OTHER))
    for (const [t, v] of Object.entries(d))
      if (!(SKIP && isPromo(t))) typeTot[t] = (typeTot[t] || 0) + v;
  const types = oFlag ? Object.keys(typeTot).sort((a, b) => Math.abs(typeTot[b]) - Math.abs(typeTot[a])) : [];
  let cols = ["Артикул ВБ", "Артикул продавца", "Продаж, шт", "Возвратов, шт", "ВБ реализовал",
              "Выручка", "Ср. цена продажи", "Комиссия WB", "Комиссия WB, %", "К перечислению", "Эквайринг",
              "Логистика", "Логистика, %", "Хранение", "Хранение, %", "Приёмка", "Штрафы",
              "Прочие удержания", ...types.map(t => "↳ " + t), "Реклама", "ДРР, %",
              "Себестоимость", "Себестоимость, %"];
  if (rate !== null) cols = cols.concat(["Налог"], tFlag ? ["↳ Налоговая база", "↳ Ставка, %"] : []);
  cols = cols.concat(["Валовая прибыль", "Прибыль", "Прибыль на ед.", "Маржа, %", "ROI, %"]);

  // относительные метрики: в ИТОГО не суммируются, считаются от итоговых сумм
  const RATIO = new Set(["Ср. цена продажи", "Комиссия WB, %", "Логистика, %", "Хранение, %",
                         "ДРР, %", "Себестоимость, %", "Прибыль на ед.", "Маржа, %", "ROI, %"]);
  const rows = [], total = {};
  const nms = Object.keys(ART).sort((x, y) => ART[y].pay - ART[x].pay);
  for (const nm of nms) {
    const a = ART[nm];
    const cogs = (COST[nm] || 0) * (a.qty_sold - a.qty_ret);
    const adv = ADV[nm] || 0;
    const storage = Object.keys(STORAGE).length ? (STORAGE[nm] || 0) : a.storage;
    let other = a.other;
    if (SKIP)
      for (const [t, v] of Object.entries(OTHER[nm])) if (isPromo(t)) other -= v;
    const pre = a.pay - a.acquiring - a.logistics - storage - a.acceptance - a.fines - other - cogs - adv;
    // налоговая база упрощённо — выручка (УСН Доходы/НПД) либо прибыль до налога (Д−Р/ОСН), без НДС и нюансов
    const base = rate !== null ? Math.max(INCOME_MODES.includes(TAX.mode) ? a.sold : pre, 0) : 0;
    const tax = base * (rate || 0) / 100;
    const profit = pre - tax;
    const qtyNet = a.qty_sold - a.qty_ret;
    const pct = v => a.sold ? v / a.sold * 100 : null;
    const comm = a.revenue - a.pay - a.acquiring + a.comp;
    const commPct = a.revenue ? comm / a.revenue * 100 : null;
    let vals = [a.qty_sold, a.qty_ret, a.sold, a.revenue, qtyNet ? a.sold / qtyNet : null,
                comm, commPct, a.pay, a.acquiring,
                a.logistics, pct(a.logistics), storage, pct(storage), a.acceptance, a.fines, other,
                ...types.map(t => OTHER[nm][t] || 0), adv, pct(adv), cogs, pct(cogs)];
    if (rate !== null) vals = vals.concat([tax], tFlag ? [base, rate] : []);
    vals.push(a.sold - cogs, profit,
              qtyNet ? profit / qtyNet : null,
              pct(profit),
              cogs + adv ? profit / (cogs + adv) * 100 : null);
    cols.slice(2).forEach((c, i) => { if (!RATIO.has(c)) total[c] = (total[c] || 0) + vals[i]; });
    rows.push([nm, a.supplier_art, ...vals]);
  }
  const tQty = (total["Продаж, шт"] || 0) - (total["Возвратов, шт"] || 0);
  const tInvest = (total["Себестоимость"] || 0) + (total["Реклама"] || 0);
  const tSold = total["ВБ реализовал"] || 0;
  const tRevenue = total["Выручка"] || 0;
  const tPct = v => tSold ? (v || 0) / tSold * 100 : null;
  const footVal = c =>
    c.startsWith("↳ Ставка") ? rate :
    c === "Ср. цена продажи" ? (tQty ? tSold / tQty : null) :
    c === "Комиссия WB, %" ? (tRevenue ? (total["Комиссия WB"] || 0) / tRevenue * 100 : null) :
    c === "Логистика, %" ? tPct(total["Логистика"]) :
    c === "Хранение, %" ? tPct(total["Хранение"]) :
    c === "ДРР, %" ? tPct(total["Реклама"]) :
    c === "Себестоимость, %" ? tPct(total["Себестоимость"]) :
    c === "Прибыль на ед." ? (tQty ? (total["Прибыль"] || 0) / tQty : null) :
    c === "Маржа, %" ? tPct(total["Прибыль"]) :
    c === "ROI, %" ? (tInvest ? (total["Прибыль"] || 0) / tInvest * 100 : null) :
    (total[c] || 0);
  const foot = ["ИТОГО", "", ...cols.slice(2).map(footVal)];
  return { cols, rows, foot, rate };
}

// ---------- вывод ----------

const $ = id => document.getElementById(id);

function fmt(v) {
  if (!v) return "";
  const s = Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return (v < 0 ? "-" : "") + s;
}

const gridApi = agGrid.createGrid($("grid"), {
  columnDefs: [],
  rowData: [],
  defaultColDef: { sortable: true, resizable: true, suppressMovable: true },
  suppressCellFocus: true,
  animateRows: false,
  enableCellTextSelection: true,
});

function colDefs(cols) {
  return cols.map((c, i) => {
    const d = { headerName: c, colId: "c" + i, valueGetter: p => p.data[i] };
    if (i < 2) { d.width = i ? 130 : 120; d.pinned = "left"; return d; }
    d.type = "rightAligned";
    d.width = c.startsWith("↳") ? 130 : 105;
    if (c === "К перечислению") d.sort = "desc";
    if (c.startsWith("↳ Ставка")) d.valueFormatter = p => p.value == null ? "" : String(p.value);
    else if (c.endsWith("%")) d.valueFormatter = p => p.value == null ? "" : p.value.toFixed(1);
    else d.valueFormatter = p => fmt(p.value);
    return d;
  });
}

function render() {
  const has = Object.keys(ART).length > 0;
  $("grid").hidden = !has;
  $("toolbar").hidden = !has;
  $("empty").hidden = has;
  const rate = taxRate();
  $("tax-toggle").hidden = rate === null;
  $("lnk-other").textContent = showOther ? "[свернуть]" : "[раскрыть]";
  $("lnk-tax").textContent = showTax ? "[свернуть]" : "[раскрыть]";
  $("tax-now").textContent = TAX.mode
    ? `Сейчас: ${TAX.mode}, ${rate !== null ? rate + "%" : "не учитывается"}` : "";
  if (!has) return;
  const { cols, rows, foot } = compute(showOther, showTax);
  // мало строк — таблица по содержимому, много — фиксированная высота с виртуализацией
  gridApi.setGridOption("domLayout", rows.length <= 25 ? "autoHeight" : "normal");
  $("grid").style.height = rows.length <= 25 ? "auto" : "65vh";
  gridApi.setGridOption("columnDefs", colDefs(cols));
  gridApi.setGridOption("rowData", rows);
  gridApi.setGridOption("pinnedTopRowData", [foot]);
}

function exportXlsx() {
  const { cols, rows, foot } = compute(showOther, showTax);
  const x = (c, v) => {
    if (v == null || v === "") return "";
    if (c.startsWith("↳ Ставка") || c.endsWith("%")) return Math.round(v * 10) / 10;
    return Math.round(v);
  };
  const aoa = [cols, ...[foot, ...rows].map(r => [r[0], r[1], ...cols.slice(2).map((c, i) => x(c, r[i + 2]))])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "По артикулам");
  XLSX.writeFile(wb, "finreport.xlsx");
}

// сводная карточка «Маржинальность»: итог в деньгах и %, топ-5 артикулов по прибыли
function buildPngCanvas() {
  const { cols, rows, foot } = compute(false, false);
  const iP = cols.indexOf("Прибыль");
  const profit = foot[iP] || 0;
  const margin = foot[cols.indexOf("Маржа, %")];
  const top = rows.slice().sort((a, b) => b[iP] - a[iP]).slice(0, 5);
  const up = profit >= 0;
  const accent = up ? "#1d7a1d" : "#b00020";

  const W = 800, H = 450, P = 40;
  const cv = document.createElement("canvas");
  cv.width = W * 2; cv.height = H * 2;
  const c = cv.getContext("2d");
  c.scale(2, 2);

  c.fillStyle = "#fff";
  c.fillRect(0, 0, W, H);
  c.strokeStyle = "#000"; c.lineWidth = 2;
  c.strokeRect(4, 4, W - 8, H - 8);
  c.strokeStyle = "#999"; c.lineWidth = 1;
  c.strokeRect(9.5, 9.5, W - 19, H - 19);

  c.fillStyle = "#000";
  c.font = "bold 24px Verdana";
  c.fillText("Маржинальность", P, P + 26);
  c.font = "11px Verdana";
  c.fillStyle = "#555";
  c.fillText("Финотчёт ВБ · " + new Date().toLocaleDateString("ru-RU"), P, P + 46);

  // справа: прибыль в деньгах, ниже маржа в %, стрелка по знаку
  const money = (fmt(profit) || "0") + " ₽";
  c.font = "bold 32px Verdana";
  c.fillStyle = "#000";
  const mw = c.measureText(money).width;
  c.fillText(money, W - P - mw, P + 30);
  const ax = W - P - mw - 30;  // стрелка слева от суммы
  c.fillStyle = accent;
  c.beginPath();
  if (up) { c.moveTo(ax, P + 28); c.lineTo(ax + 18, P + 28); c.lineTo(ax + 9, P + 6); }
  else { c.moveTo(ax, P + 6); c.lineTo(ax + 18, P + 6); c.lineTo(ax + 9, P + 28); }
  c.closePath(); c.fill();
  if (margin != null) {
    c.font = "bold 16px Verdana";
    const pct = "маржа " + margin.toFixed(1) + "%";
    c.fillText(pct, W - P - c.measureText(pct).width, P + 56);
  }

  c.strokeStyle = "#999";
  c.beginPath(); c.moveTo(P, 118); c.lineTo(W - P, 118); c.stroke();
  c.fillStyle = "#555";
  c.font = "12px Verdana";
  c.fillText("Топ-5 артикулов по прибыли", P, 140);

  const maxP = Math.max(...top.map(r => r[iP]), 1);
  const barX = 330, barW = W - P - barX - 110;
  top.forEach((r, i) => {
    const y = 170 + i * 50;
    let label = r[0] + (r[1] ? " · " + r[1] : "");
    c.font = "13px Verdana";
    while (c.measureText(label).width > barX - P - 40 && label.length > 3) label = label.slice(0, -2) + "…";
    c.fillStyle = "#000";
    c.fillText((i + 1) + ".", P, y + 5);
    c.fillText(label, P + 26, y + 5);
    const w = Math.max(Math.round(barW * Math.max(r[iP], 0) / maxP), 2);
    c.fillStyle = r[iP] >= 0 ? "#cfe6cf" : "#f3d2d6";
    c.fillRect(barX, y - 9, w, 18);
    c.strokeStyle = r[iP] >= 0 ? "#1d7a1d" : "#b00020";
    c.strokeRect(barX + .5, y - 8.5, w - 1, 17);
    const v = (fmt(r[iP]) || "0") + " ₽";
    c.font = "bold 13px Verdana";
    c.fillStyle = "#000";
    c.fillText(v, W - P - c.measureText(v).width, y + 5);
  });
  return cv;
}

function exportPng() {
  buildPngCanvas().toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "marginality.png";
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ---------- обработчики ----------

function onFile(id, handler) {
  $(id).addEventListener("change", e => {
    const f = e.target.files[0];
    if (!f) return;
    readRows(f).then(handler).catch(err => alert("Ошибка: " + err.message))
      .finally(() => { e.target.value = ""; render(); });
  });
}

onFile("f-report", rows => {
  parseReport(rows);
  $("s-report").textContent = `Загружено: ${Object.keys(ART).length} артикулов`;
});

onFile("f-cost", rows => {
  for (const r of rows)
    if (r && r.length >= 2 && num(r[1])) COST[String(r[0] ?? "").trim()] = num(r[1]);
  $("s-cost").textContent = `Загружено: ${Object.keys(COST).length} артикулов`;
});

// Отчёт платного хранения: 2-й лист, заголовки во 2-й строке, сумма — «Сумма хранения, руб» по «Артикул WB»
$("f-storage").addEventListener("change", e => {
  const f = e.target.files[0];
  if (!f) return;
  f.arrayBuffer().then(buf => {
    const wb = XLSX.read(buf, { type: "array", raw: true, codepage: 65001 });
    const ws = wb.Sheets[wb.SheetNames[1] || wb.SheetNames[0]];  // ponytail: 2-й лист «Детальная информация»
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    const head = (rows[1] || []).map(h => String(h ?? "").toLowerCase().replace(/\s+/g, ""));
    const iNm = head.findIndex(h => h.startsWith("артикулwb"));
    const iSum = head.findIndex(h => h.startsWith("суммахранения"));
    if (iNm < 0 || iSum < 0) throw new Error("не похоже на отчёт платного хранения: нет «Артикул WB»/«Сумма хранения»");
    for (const k of Object.keys(STORAGE)) delete STORAGE[k];
    for (const r of rows.slice(2)) {
      const nm = String(r[iNm] ?? "").trim();
      if (nm) STORAGE[nm] = (STORAGE[nm] || 0) + num(r[iSum]);
    }
    $("s-storage").textContent = `Загружено: ${Object.keys(STORAGE).length} артикулов`;
  }).catch(err => alert("Ошибка: " + err.message)).finally(() => { e.target.value = ""; render(); });
});

onFile("f-adv", rows => {
  for (const k of Object.keys(ADV)) delete ADV[k];
  for (const r of rows)
    if (r && r.length >= 3 && num(r[2])) {
      const nm = String(r[1] ?? "").trim();
      ADV[nm] = (ADV[nm] || 0) + num(r[2]);
    }
  $("s-adv").textContent = `Загружено: ${Object.keys(ADV).length} артикулов`;
});

$("skip-promo").addEventListener("change", e => {
  SKIP = e.target.checked;
  localStorage.setItem("skip_promo", SKIP ? "1" : "");
  render();
});

$("lnk-other").addEventListener("click", e => { e.preventDefault(); showOther = !showOther; render(); });
$("lnk-tax").addEventListener("click", e => { e.preventDefault(); showTax = !showTax; render(); });
$("lnk-export").addEventListener("click", e => { e.preventDefault(); exportXlsx(); });
$("lnk-png").addEventListener("click", e => { e.preventDefault(); exportPng(); });

// модалка налогов
$("btn-tax").addEventListener("click", () => {
  const f = $("taxform");
  f.mode.value = TAX.mode || "УСН «Доходы»";
  f.rate.value = TAX.choice || "6";
  f.custom.value = TAX.custom;
  $("taxdlg").showModal();
});
$("btn-tax-cancel").addEventListener("click", () => $("taxdlg").close());
$("taxmode").addEventListener("change", e => {
  $("taxform").rate.value = TAX_DEFAULTS[e.target.value];
});
$("taxform").addEventListener("submit", () => {
  const f = $("taxform");
  TAX = { mode: f.mode.value, choice: f.rate.value, custom: f.custom.value };
  localStorage.setItem("tax", JSON.stringify(TAX));
  render();
});

// восстановить настройки
try { TAX = { ...TAX, ...JSON.parse(localStorage.getItem("tax") || "{}") }; } catch (e) { /* пустые настройки */ }
SKIP = !!localStorage.getItem("skip_promo");
$("skip-promo").checked = SKIP;
render();
