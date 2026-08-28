"use strict";
/* =========================================================================
   成績発表.com ― CSVを読み込んで成績をミニゲームで開封するアプリ
   ========================================================================= */

/* ----------------------------------------------------------------------
   0. 成績メタ情報（色・メッセージ）
---------------------------------------------------------------------- */
const GRADE_META = {
  S:  { label: "S",   color: "#ffb300", colorDark: "#c98600", tier: "great", msg: "最高評価！やりました🎉 このまま突き進もう！" },
  A:  { label: "A",   color: "#e60012", colorDark: "#a8000d", tier: "great", msg: "素晴らしい成績です！自分を褒めてあげよう👏" },
  B:  { label: "B",   color: "#009944", colorDark: "#006d31", tier: "good",  msg: "よくできました！しっかり積み上げてるね💪" },
  C:  { label: "C",   color: "#0068b7", colorDark: "#004a85", tier: "ok",    msg: "ギリギリセーフ…！単位ゲットが一番大事😌" },
  F:  { label: "F",   color: "#666666", colorDark: "#3d3d3d", tier: "bad",   msg: "残念…！でも来学期に切り替えていこう😤" },
  合: { label: "合格", color: "#009944", colorDark: "#006d31", tier: "good",  msg: "合格！おめでとう🎉" },
  否: { label: "不合格", color: "#666666", colorDark: "#3d3d3d", tier: "bad",  msg: "不合格…次はきっと大丈夫、切り替えていこう😤" },
};
const DEFAULT_META = { label: "不明", color: "#999999", colorDark: "#666666", tier: "ok", msg: "結果が届きました。" };
/* 開封済みランキングに常時表示する評語（0件でも行を出す）。
   「合格」「不合格」は単位の強さを表さないランキング対象外なので含めない。 */
const RANKING_ORDER = ["S", "A", "B", "C", "F"];

/* GRADE_METAのキー（S/A/B/C/F/合/否）を返す。統計の集計・並び替えにも使う共通キー。 */
function getGradeKey(course){
  const g = normalizeGradeKey(course.grade);
  if (GRADE_META[g]) return g;
  const pf = normalizeGradeKey(course.passFail);
  if (pf === "合" || pf === "否") return pf;
  return null;
}
function getGradeMeta(course){
  const key = getGradeKey(course);
  return key ? GRADE_META[key] : DEFAULT_META;
}
function isPassed(course){
  const pf = normalizeGradeKey(course.passFail);
  if (pf === "合") return true;
  if (pf === "否") return false;
  const g = normalizeGradeKey(course.grade);
  if (["S","A","B","C"].includes(g)) return true;
  if (g === "F") return false;
  return true; // 不明な場合は好意的に扱う
}

/* 全角英数字→半角、前後空白除去 */
function toHalfWidth(str){
  return String(str ?? "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
}
function normalizeGradeKey(v){
  return toHalfWidth(v).trim().toUpperCase();
}

/* ----------------------------------------------------------------------
   1. CSV読み込み（文字コード自動判定）＋ パース
---------------------------------------------------------------------- */
/* ArrayBuffer → 文字列。UTF-8として厳密デコードを試し、失敗したらShift_JISとして読む。 */
function decodeSmart(buf){
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (e) {
    try {
      return new TextDecoder("shift_jis").decode(buf);
    } catch (e2) {
      throw new Error("文字コードを判定できませんでした。");
    }
  }
}
function readFileSmart(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました。"));
    reader.onload = () => {
      try { resolve(decodeSmart(reader.result)); }
      catch (err) { reject(err); }
    };
    reader.readAsArrayBuffer(file);
  });
}

/* シンプルなRFC4180風CSVパーサー（ダブルクォート対応） */
function parseCSV(text){
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // BOM除去

  for (let i = 0; i < src.length; i++){
    const ch = src[i];
    if (inQuotes){
      if (ch === '"'){
        if (src[i + 1] === '"'){ field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"'){
        inQuotes = true;
      } else if (ch === ','){
        row.push(field); field = "";
      } else if (ch === '\r'){
        // 無視（\r\n の \n 側で改行確定）
      } else if (ch === '\n'){
        row.push(field); field = "";
        rows.push(row); row = [];
      } else {
        field += ch;
      }
    }
  }
  // 末尾の残り
  if (field.length > 0 || row.length > 0){
    row.push(field);
    rows.push(row);
  }
  // 完全な空行を除去
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

const COLUMN_ALIASES = {
  affCode:   ["所属コード"],
  studentId: ["学籍番号"],
  dispYear:  ["画面指定年度"],
  dispTerm:  ["画面指定学期"],
  no:        ["No", "Ｎｏ"],
  code:      ["時間割コード"],
  name:      ["開講科目名"],
  reading:   ["リーディングプログラム科目"],
  gym:       ["知のジムナスティックス科目"],
  teacher:   ["教員名"],
  earnYear:  ["修得年度"],
  grade:     ["評語"],
  passFail:  ["合否"],
};
function cleanHeader(h){
  return String(h ?? "").replace(/　/g, "").trim();
}

function buildCourses(rows){
  if (rows.length < 1) throw new Error("CSVにデータがありません。");
  const header = rows[0].map(cleanHeader);
  const idx = {};
  for (const key in COLUMN_ALIASES){
    const aliases = COLUMN_ALIASES[key];
    idx[key] = header.findIndex(h => aliases.includes(h));
  }
  if (idx.name === -1 || idx.grade === -1){
    throw new Error("CSVの形式を認識できませんでした。「開講科目名」「評語」などの列が見つかりません。");
  }

  const courses = [];
  for (let i = 1; i < rows.length; i++){
    const r = rows[i];
    const get = (key) => (idx[key] >= 0 && r[idx[key]] !== undefined) ? String(r[idx[key]]).trim() : "";
    const name = get("name");
    if (!name) continue;
    courses.push({
      key: `c${i}`,
      affCode: get("affCode"),
      studentId: get("studentId"),
      dispYear: get("dispYear"),
      dispTerm: get("dispTerm"),
      no: get("no") || String(i),
      code: get("code"),
      name,
      reading: get("reading"),
      gym: get("gym"),
      teacher: get("teacher") || "担当教員未設定",
      earnYear: get("earnYear"),
      grade: get("grade"),
      passFail: get("passFail"),
    });
  }
  if (courses.length === 0) throw new Error("読み込める科目データがありませんでした。");
  return courses;
}

/* ----------------------------------------------------------------------
   2. サンプルCSV
---------------------------------------------------------------------- */
/* ダミー学生「サンプル 太郎」の架空の成績データ（実在の個人・科目とは無関係） */
const SAMPLE_CSV = `"所属コード","学籍番号 ","画面指定年度","画面指定学期","No","時間割コード","開講科目名 ","リーディングプログラム科目","知のジムナスティックス科目","教員名","修得年度","評語","合否",
"0000","99Z99999","2030","1","1","900001","架空学入門","","","岡本 一郎","2030","Ｓ","合",
"0000","99Z99999","2030","1","2","900002","わかめ学","","","田中スーザンふ美子","2030","Ｂ","合",
"0000","99Z99999","2030","1","3","900003","機工学(最新版) -コピー-確定版 (2)","","","仮名 次郎","2030","Ｓ","合",
"0000","99Z99999","2030","1","4","900004","大部屋序論","","","工学科全教員","2030","Ｓ","合",
"0000","99Z99999","2030","1","5","900005","学問へのとびら","","","見本 一郎","2030","合","合",
"0000","99Z99999","2030","1","6","900006","設計工学","","","富士田 三郎","2030","Ｆ","否",
"0000","99Z99999","2030","1","7","900007","機構学詳論","","","山田 四郎","2030","Ｆ","否",
"0000","99Z99999","2030","1","8","900008","線形代数学VI","","","五町 花子","2030","Ａ","合",
"0000","99Z99999","2030","1","9","900009","基礎解析学・同演義XXI","","","竹田 次郎","2030","Ｃ","合",
"0000","99Z99999","2030","1","10","900010","架空語コミュニケーションMMMCMXCIX","☆","","国際 五郎","2030","Ｂ","合",
`;

/* ----------------------------------------------------------------------
   3. 状態管理
---------------------------------------------------------------------- */
const AppState = {
  courses: [],
  storageKey: null,
  revealed: {}, // { courseKey: true }
};

function computeStorageKey(courses){
  const c0 = courses[0] || {};
  return `seiseki_reveal_v1_${c0.studentId || "unknown"}_${c0.dispYear || ""}_${c0.dispTerm || ""}`;
}
function loadRevealState(){
  try {
    const raw = localStorage.getItem(AppState.storageKey);
    AppState.revealed = raw ? JSON.parse(raw) : {};
  } catch (e){
    AppState.revealed = {};
  }
}
function saveRevealState(){
  try { localStorage.setItem(AppState.storageKey, JSON.stringify(AppState.revealed)); }
  catch (e) { /* ストレージが使えない環境は無視 */ }
}
function markRevealed(courseKey){
  AppState.revealed[courseKey] = true;
  saveRevealState();
}
function isRevealed(courseKey){
  return !!AppState.revealed[courseKey];
}

/* ----------------------------------------------------------------------
   4. 画面遷移ユーティリティ
---------------------------------------------------------------------- */
function showScreen(id){
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

/* ----------------------------------------------------------------------
   5. アップロード画面のイベント
---------------------------------------------------------------------- */
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const uploadError = document.getElementById("uploadError");

document.getElementById("btnChooseFile").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
});
["dragenter","dragover"].forEach(evt => {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
});
["dragleave","drop"].forEach(evt => {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); });
});
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});
document.getElementById("btnSample").addEventListener("click", () => {
  loadCSVText(SAMPLE_CSV);
});

async function handleFile(file){
  uploadError.hidden = true;
  if (!/\.(csv|txt)$/i.test(file.name)){
    showUploadError("CSVファイル（拡張子 .csv または .txt）を選択してください。");
    return;
  }
  try {
    const text = await readFileSmart(file);
    loadCSVText(text);
  } catch (err){
    showUploadError(err.message || "ファイルの読み込みに失敗しました。");
  }
}
function showUploadError(msg){
  uploadError.textContent = "⚠ " + msg;
  uploadError.hidden = false;
}
function loadCSVText(text){
  try {
    const rows = parseCSV(text);
    const courses = buildCourses(rows);
    AppState.courses = courses;
    AppState.storageKey = computeStorageKey(courses);
    loadRevealState();
    renderListScreen();
    showScreen("screen-list");
  } catch (err){
    showUploadError(err.message || "CSVの解析に失敗しました。");
  }
}

/* ----------------------------------------------------------------------
   6. 一覧画面の描画
---------------------------------------------------------------------- */
function renderListScreen(){
  const courses = AppState.courses;

  const terms = [...new Set(courses.map(c => `${c.dispYear}年度 ${c.dispTerm}学期`))];
  document.getElementById("sumTerm").textContent = terms.join(" / ") || "-";

  renderCourseList();
  renderStats();
}

function renderCourseList(){
  const wrap = document.getElementById("courseList");
  wrap.innerHTML = "";
  AppState.courses.forEach((course, i) => {
    const row = document.createElement("div");
    // 開封済みは合否で色分け（文字を読む前に一目でわかるように）
    const revealedClass = isRevealed(course.key)
      ? ` revealed ${isPassed(course) ? "pass" : "fail"}`
      : "";
    row.className = "course-row" + revealedClass;

    const badges = [];
    if (course.reading) badges.push(`<span class="tag tag-reading">Reading</span>`);
    if (course.gym) badges.push(`<span class="tag tag-gym">知のジム</span>`);

    let actionHtml;
    if (isRevealed(course.key)){
      const meta = getGradeMeta(course);
      row.title = "クリックでもう一度大きく見る";
      actionHtml = `
        <div class="grade-badge" style="background:linear-gradient(160deg, ${meta.color}, ${meta.colorDark})">
          <span class="g-letter">${escapeHtml(meta.label)}</span>
          <span class="g-sub">${isPassed(course) ? "合格" : "不合格"}</span>
        </div>`;
    } else {
      actionHtml = `<button type="button" class="btn btn-primary btn-small btn-reveal">結果を見る</button>`;
    }

    row.innerHTML = `
      <div class="row-rank">${i + 1}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(course.name)}</div>
        <div class="row-meta">
          <span>👤 ${escapeHtml(course.teacher)}</span>
          <span>ID: ${escapeHtml(course.code)}</span>
        </div>
        ${badges.length ? `<div class="row-badges">${badges.join("")}</div>` : ""}
      </div>
      <div class="row-action">${actionHtml}</div>
    `;

    if (isRevealed(course.key)){
      row.addEventListener("click", () => showResultPreview(course));
    } else {
      row.addEventListener("click", () => openGameSelect(course));
    }
    wrap.appendChild(row);
  });
}

function renderStats(){
  const { total, revealedCourses, revealedCount } = getRevealStats();

  document.getElementById("sumOpened").textContent = `${revealedCount} / ${total}`;

  const passCount = revealedCourses.filter(isPassed).length;
  const passRateEl = document.getElementById("sumPassRate");
  if (revealedCount === 0){
    passRateEl.textContent = "-";
    passRateEl.style.color = "";
  } else {
    const passRate = Math.round((passCount / revealedCount) * 100);
    passRateEl.textContent = `${passRate}%`;
    // 数字を読む前に色で良し悪しがわかるように
    passRateEl.style.color = passRate >= 80 ? "var(--green)" : passRate >= 50 ? "var(--orange)" : "var(--red-dark)";
  }

  document.getElementById("sumGpa").textContent = computeGpa(revealedCourses);

  const statsWrap = document.getElementById("gradeStats");
  {
    // 正規キー（S/A/B/C/F/否）で集計。「合格」は対象外、0件でも行は常に出す。
    const counts = {};
    RANKING_ORDER.forEach(key => {
      const meta = GRADE_META[key];
      counts[key] = { count: 0, color: meta.color, label: meta.label };
    });
    revealedCourses.forEach(c => {
      const key = getGradeKey(c);
      if (key && counts[key]) counts[key].count++;
    });
    const maxCount = Math.max(1, ...Object.values(counts).map(v => v.count));
    let html = "";
    RANKING_ORDER.forEach(key => {
      const { count, color, label } = counts[key];
      const pct = Math.round((count / maxCount) * 100);
      html += `
        <div class="grade-stats-row">
          <span class="gs-label">${escapeHtml(label)}</span>
          <span class="gs-bar-wrap"><span class="gs-bar" style="width:${pct}%;background:${color}"></span></span>
          <span class="gs-count">${count}</span>
        </div>`;
    });
    statsWrap.innerHTML = html;
  }

  const btnRandomCourse = document.getElementById("btnRandomCourse");
  if (btnRandomCourse) btnRandomCourse.disabled = (total - revealedCount) === 0;
}

/* 開封状況の集計（一覧描画・お祝い判定などで共用） */
function getRevealStats(){
  const total = AppState.courses.length;
  const revealedCourses = AppState.courses.filter(c => isRevealed(c.key));
  return { total, revealedCourses, revealedCount: revealedCourses.length };
}

/* GPA参考値：S/A/B/C/Fに加えて、合否のみの科目も計算に含める。
   「合」は満点（4）扱い、「否」は0扱い。
   開封済み分だけで随時計算するので、全部開けなくても現在地がわかる。 */
const GPA_POINT_MAP = { S: 4, A: 3, B: 2, C: 1, F: 0, 合: 4, 否: 0 };
function computeGpa(revealedCourses){
  let sum = 0, n = 0;
  revealedCourses.forEach(c => {
    const key = normalizeGradeKey(c.grade);
    if (key in GPA_POINT_MAP){ sum += GPA_POINT_MAP[key]; n++; }
  });
  return n > 0 ? (sum / n).toFixed(2) : "-";
}

/* 「今まさに最後の1科目を開封した」ときだけお祝いを出す。
   CSV読み込み直後（前回の開封状況をlocalStorageから復元しただけ）では出さない。 */
function checkAllRevealedAndCelebrate(){
  const { total, revealedCourses, revealedCount } = getRevealStats();
  if (total > 0 && revealedCount === total){
    setTimeout(() => showCelebration(revealedCourses), 400);
  }
}

function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[ch]));
}

/* 最初からやり直す */
document.getElementById("btnResetAll").addEventListener("click", () => {
  if (!confirm("開封状況をリセットして、もう一度最初から遊びますか？（CSVの再読み込みは不要です）")) return;
  AppState.revealed = {};
  saveRevealState();
  celebrated = false;
  renderCourseList();
  renderStats();
});

/* 科目をランダムに選ぶ（未開封の中から1つ） */
document.getElementById("btnRandomCourse").addEventListener("click", () => {
  const unrevealed = AppState.courses.filter(c => !isRevealed(c.key));
  if (unrevealed.length === 0){
    alert("未開封の科目はもうありません！すべて開封済みです🎉");
    return;
  }
  const pick = unrevealed[Math.floor(Math.random() * unrevealed.length)];
  openGameSelect(pick);
});

/* ----------------------------------------------------------------------
   7. モーダル制御
---------------------------------------------------------------------- */
const modalOverlay = document.getElementById("modalOverlay");
const modalContent = document.getElementById("modalContent");
document.getElementById("modalClose").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

/* 結果画面を表示中に、「一覧にもどる」を押さず×やモーダル外クリックで
   閉じた場合でも開封状態が一覧に反映されるようにするためのフラグ。
   showResult()で開封待ちの科目をセットし、closeModal()で必ず処理する。 */
let pendingRevealCourse = null;

function openModal(html){
  modalContent.innerHTML = html;
  modalOverlay.hidden = false;
  modalOverlay.style.display = "flex"; // CSS読み込み順やキャッシュに依存せず確実に表示する
}
function closeModal(){
  modalOverlay.hidden = true;
  modalOverlay.style.display = "none"; // hidden属性だけに頼らず確実に隠す
  modalContent.innerHTML = "";

  if (pendingRevealCourse){
    const course = pendingRevealCourse;
    pendingRevealCourse = null;
    markRevealed(course.key);
    renderCourseList();
    renderStats();
    checkAllRevealedAndCelebrate();
  }
}

/* ----------------------------------------------------------------------
   8. ゲーム選択
---------------------------------------------------------------------- */
const GAMES = [
  { id: "scratch", icon: "🪙", name: "スクラッチ削り", desc: "コインで削って結果を確認" },
  { id: "drawer",  icon: "🗄️", name: "引き出しオープン", desc: "取っ手を引いて開けよう" },
  { id: "shoot",   icon: "🎯", name: "射的で穴あけ", desc: "撃ち抜いて結果を暴こう" },
  { id: "gacha",   icon: "🎰", name: "ガチャガチャ", desc: "レバーを回してカプセルGET" },
  { id: "kuji",    icon: "🎋", name: "くじ引き", desc: "気になる一枚を選んでね" },
];

function openGameSelect(course){
  pendingRevealCourse = null; // 念のため、前の開封待ち状態を持ち越さない
  openModal(`
    <p class="modal-title">「${escapeHtml(course.name)}」の結果を開封！</p>
    <p class="modal-sub">どうやって開封する？お好きな方法を選んでください</p>
    <button type="button" class="btn btn-primary game-select-random" id="btnRandomGame">🎲 ランダムに方法を選ぶ</button>
    <div class="game-grid">
      ${GAMES.map(g => `
        <div class="game-card" data-game="${g.id}">
          <div class="gc-icon">${g.icon}</div>
          <div class="gc-name">${g.name}</div>
          <div class="gc-desc">${g.desc}</div>
        </div>
      `).join("")}
    </div>
  `);
  modalContent.querySelectorAll(".game-card").forEach(card => {
    card.addEventListener("click", () => startGame(card.dataset.game, course));
  });
  document.getElementById("btnRandomGame").addEventListener("click", () => {
    const pick = GAMES[Math.floor(Math.random() * GAMES.length)];
    startGame(pick.id, course);
  });
}

function startGame(gameId, course){
  const stageHtml = `
    <p class="modal-title">${GAMES.find(g => g.id === gameId).icon} ${GAMES.find(g => g.id === gameId).name}</p>
    <p class="stage-course-name">${escapeHtml(course.name)}</p>
    <div id="gameArea" class="game-stage"></div>
  `;
  openModal(stageHtml);
  const area = document.getElementById("gameArea");
  const onComplete = () => showResult(course);

  switch (gameId){
    case "scratch": renderScratchGame(area, course, onComplete); break;
    case "drawer":  renderDrawerGame(area, course, onComplete); break;
    case "shoot":   renderShootGame(area, course, onComplete); break;
    case "gacha":   renderGachaGame(area, course, onComplete); break;
    case "kuji":    renderKujiGame(area, course, onComplete); break;
  }
}

/* 各ゲーム共通：結果の下地（reveal-box + reveal-underlay）を作る。
   スクラッチ／射的／引き出しは「少しずつ」見えていくゲームなので、
   評語の色をそのまま敷くと、文字を読む前に色だけで結果がバレてしまう。
   文字（評語そのもの）は削って読めてこそのゲームなので隠さない。
   隠すのは色だけ：背景は評語に関係ない中立色にし、文字は本物を表示する。 */
function buildMysteryUnderlay(course){
  const meta = getGradeMeta(course);
  const div = document.createElement("div");
  div.className = "reveal-underlay reveal-underlay-mystery";
  div.innerHTML = `
    <div class="ru-letter">${escapeHtml(meta.label)}</div>
    <div class="ru-caption">${escapeHtml(course.name)}</div>
  `;
  return div;
}

/* ----------------------------------------------------------------------
   9. ミニゲーム 1: スクラッチ削り
---------------------------------------------------------------------- */
function renderScratchGame(area, course, onComplete){
  area.innerHTML = `<p class="stage-instruction">コインの代わりに、マウス／指でこすって削ってみよう！</p>`;
  const box = document.createElement("div");
  box.className = "reveal-box";
  box.appendChild(buildMysteryUnderlay(course));

  const canvas = document.createElement("canvas");
  canvas.className = "game-canvas";
  canvas.width = 300; canvas.height = 180;
  box.appendChild(canvas);
  area.appendChild(box);

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#c9ccd1";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // ストライプ模様
  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.lineWidth = 6;
  for (let x = -canvas.height; x < canvas.width; x += 16){
    ctx.beginPath();
    ctx.moveTo(x, canvas.height);
    ctx.lineTo(x + canvas.height, 0);
    ctx.stroke();
  }
  ctx.fillStyle = "#5a5f66";
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("ここを削ってね ✏️", canvas.width / 2, canvas.height / 2);

  let done = false;
  let drawing = false;

  function erase(x, y){
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
  function getPos(e){
    const rect = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    return { x: cx * (canvas.width / rect.width), y: cy * (canvas.height / rect.height) };
  }
  function checkProgress(){
    if (done) return;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = 0;
    const step = 4 * 8; // サンプリングして軽量化
    let total = 0;
    for (let i = 3; i < data.length; i += step){
      total++;
      if (data[i] === 0) transparent++;
    }
    if (transparent / total > 0.68){
      finish();
    }
  }
  function finish(){
    if (done) return;
    done = true;
    canvas.style.transition = "opacity .4s";
    canvas.style.opacity = "0";
    setTimeout(() => { canvas.remove(); playRevealFx(course); onComplete(); }, 350);
  }

  function pointerDown(e){ drawing = true; const p = getPos(e); erase(p.x, p.y); }
  function pointerMove(e){
    if (!drawing) return;
    e.preventDefault();
    const p = getPos(e); erase(p.x, p.y); checkProgress();
  }
  function pointerUp(){ drawing = false; checkProgress(); }

  canvas.addEventListener("mousedown", pointerDown);
  canvas.addEventListener("mousemove", pointerMove);
  window.addEventListener("mouseup", pointerUp);
  canvas.addEventListener("touchstart", pointerDown, { passive: true });
  canvas.addEventListener("touchmove", pointerMove, { passive: false });
  canvas.addEventListener("touchend", pointerUp);
}

/* ----------------------------------------------------------------------
   10. ミニゲーム 2: 引き出しオープン
---------------------------------------------------------------------- */
function renderDrawerGame(area, course, onComplete){
  area.innerHTML = `<p class="stage-instruction">取っ手を右へドラッグして引き出しを開けよう！</p>`;
  const outer = document.createElement("div");
  outer.className = "drawer-outer";
  outer.appendChild(buildMysteryUnderlay(course));

  const front = document.createElement("div");
  front.className = "drawer-front";
  front.innerHTML = `<span class="drawer-hint-arrow">➜</span><div class="drawer-handle"></div>`;
  outer.appendChild(front);
  area.appendChild(outer);

  const maxX = 260;
  let startX = null, curX = 0, dragging = false, done = false;

  function toX(clientX){
    const rect = outer.getBoundingClientRect();
    return clientX - rect.left;
  }
  function onDown(e){
    if (done) return;
    dragging = true;
    startX = (e.touches ? e.touches[0].clientX : e.clientX);
    front.style.transition = "none";
  }
  function onMove(e){
    if (!dragging || done) return;
    const clientX = (e.touches ? e.touches[0].clientX : e.clientX);
    let dx = clientX - startX;
    dx = Math.max(0, Math.min(maxX, dx));
    curX = dx;
    front.style.transform = `translateX(${dx}px)`;
  }
  function onUp(){
    if (!dragging || done) return;
    dragging = false;
    if (curX > maxX * 0.6){
      done = true;
      front.style.transition = "transform .3s ease";
      front.style.transform = `translateX(${maxX + 40}px)`;
      setTimeout(() => { playRevealFx(course); onComplete(); }, 320);
    } else {
      front.style.transition = "transform .25s ease";
      front.style.transform = "translateX(0)";
      curX = 0;
    }
  }

  front.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  front.addEventListener("touchstart", onDown, { passive: true });
  front.addEventListener("touchmove", onMove, { passive: true });
  front.addEventListener("touchend", onUp);
}

/* ----------------------------------------------------------------------
   11. ミニゲーム 3: 射的で穴あけ
---------------------------------------------------------------------- */
function renderShootGame(area, course, onComplete){
  area.innerHTML = `<p class="stage-instruction">クリックして撃ち抜こう！何発か撃てば見えてくるよ🔫</p>`;
  const box = document.createElement("div");
  box.className = "reveal-box";
  box.appendChild(buildMysteryUnderlay(course));

  const canvas = document.createElement("canvas");
  canvas.className = "game-canvas";
  canvas.style.cursor = "crosshair";
  canvas.width = 300; canvas.height = 180;
  box.appendChild(canvas);
  area.appendChild(box);

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#8a7256";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f2e6cf";
  for (let i = 0; i < 400; i++){
    ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 1, 1);
  }
  ctx.strokeStyle = "#5c4a30";
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx.fillStyle = "#5c4a30";
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("的紙をねらって撃て！", canvas.width / 2, canvas.height / 2);

  let shots = 0;
  let done = false;
  const NEEDED_SHOTS = 11;

  function shoot(clientX, clientY){
    if (done) return;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);

    // 穴（ギザギザの円）を開ける
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    const spikes = 10, rOuter = 16, rInner = 9;
    for (let i = 0; i < spikes * 2; i++){
      const r = i % 2 === 0 ? rOuter : rInner;
      const ang = (Math.PI / spikes) * i;
      const px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    playPopSfx();
    spawnMuzzleFlash(box, x, y, rect);

    shots++;
    if (shots >= NEEDED_SHOTS) finish();
  }
  function finish(){
    if (done) return;
    done = true;
    canvas.style.transition = "opacity .4s";
    canvas.style.opacity = "0";
    setTimeout(() => { canvas.remove(); playRevealFx(course); onComplete(); }, 350);
  }
  canvas.addEventListener("click", (e) => shoot(e.clientX, e.clientY));
  canvas.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    shoot(t.clientX, t.clientY);
  }, { passive: true });
}

function spawnMuzzleFlash(container, x, y, rect){
  const scaleX = rect.width / 300, scaleY = rect.height / 180;
  const flash = document.createElement("div");
  flash.style.position = "absolute";
  flash.style.left = `${x * scaleX - 20}px`;
  flash.style.top = `${y * scaleY - 20}px`;
  flash.style.width = "40px";
  flash.style.height = "40px";
  flash.style.borderRadius = "50%";
  flash.style.background = "radial-gradient(circle, rgba(255,240,200,.95), rgba(255,150,0,.4) 60%, transparent 75%)";
  flash.style.pointerEvents = "none";
  flash.style.zIndex = "5";
  flash.style.animation = "popIn .3s ease-out forwards";
  flash.style.opacity = "1";
  container.appendChild(flash);
  requestAnimationFrame(() => {
    flash.style.transition = "opacity .25s, transform .25s";
    flash.style.transform = "scale(1.6)";
    flash.style.opacity = "0";
  });
  setTimeout(() => flash.remove(), 300);
}

/* 簡易な「ポン」効果音（WebAudioで合成、外部音源不要） */
let sharedAudioCtx = null;
function playPopSfx(){
  try {
    sharedAudioCtx = sharedAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctxA = sharedAudioCtx;
    const now = ctxA.currentTime;
    const osc = ctxA.createOscillator();
    const gain = ctxA.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.12);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(gain); gain.connect(ctxA.destination);
    osc.start(now); osc.stop(now + 0.16);
  } catch (e){ /* オーディオ非対応環境は無視 */ }
}

/* ----------------------------------------------------------------------
   12. ミニゲーム 4: ガチャガチャ
---------------------------------------------------------------------- */
function renderGachaGame(area, course, onComplete){
  area.innerHTML = `<p class="stage-instruction">レバーを引いてカプセルを出そう！</p>`;
  const stage = document.createElement("div");
  stage.className = "gacha-stage";

  const machine = document.createElement("div");
  machine.className = "gacha-machine";
  machine.innerHTML = `
    <div class="gacha-globe"></div>
    <div class="gacha-base">
      <div class="gacha-lever" id="gachaLever" title="レバーを引く"></div>
    </div>
    <div class="gacha-tray"></div>
    <div class="gacha-capsule" id="gachaCapsule">
      <div class="cap-top"></div><div class="cap-bottom"></div>
    </div>
  `;
  stage.appendChild(machine);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-primary";
  btn.textContent = "レバーを回す！";
  stage.appendChild(btn);

  const resultHolder = document.createElement("div");
  resultHolder.style.display = "none";
  area.appendChild(stage);
  area.appendChild(resultHolder);

  const lever = machine.querySelector("#gachaLever");
  const capsule = machine.querySelector("#gachaCapsule");
  let done = false;

  function pull(){
    if (done) return;
    done = true;
    btn.disabled = true;
    lever.style.transform = "translateY(10px) rotate(20deg)";
    capsule.classList.add("drop");

    setTimeout(() => {
      capsule.classList.add("crack");
      playPopSfx();
    }, 950);

    setTimeout(() => {
      playRevealFx(course);
      onComplete();
    }, 1500);
  }
  lever.addEventListener("click", pull);
  btn.addEventListener("click", pull);
}

/* ----------------------------------------------------------------------
   13. ミニゲーム 5: くじ引き
---------------------------------------------------------------------- */
function renderKujiGame(area, course, onComplete){
  area.innerHTML = `<p class="stage-instruction">気になる一枚を選んでください🎋</p>`;
  const stage = document.createElement("div");
  stage.className = "kuji-stage";
  const N = 5;
  const slips = [];
  for (let i = 0; i < N; i++){
    const slip = document.createElement("div");
    slip.className = "kuji-slip";
    stage.appendChild(slip);
    slips.push(slip);
  }
  area.appendChild(stage);

  let done = false;
  slips.forEach((slip) => {
    slip.addEventListener("click", () => {
      if (done) return;
      done = true;
      slips.forEach(s => { if (s !== slip) s.classList.add("faded"); });
      slip.classList.add("chosen");
      playPopSfx();
      setTimeout(() => { playRevealFx(course); onComplete(); }, 550);
    });
  });
}

/* ----------------------------------------------------------------------
   14. 結果表示
---------------------------------------------------------------------- */
function showResult(course){
  const meta = getGradeMeta(course);
  const passed = isPassed(course);
  pendingRevealCourse = course; // ×やモーダル外クリックで閉じても一覧に反映されるように
  openModal(`
    <div class="result-stage">
      <div class="result-badge" style="background:linear-gradient(150deg, ${meta.color}, ${meta.colorDark})">
        <div class="rb-letter">${escapeHtml(meta.label)}</div>
        <div class="rb-sub">${passed ? "合格" : "不合格"}</div>
      </div>
      <div class="result-course">${escapeHtml(course.name)}</div>
      <div class="result-teacher">👤 ${escapeHtml(course.teacher)}</div>
      <div class="result-message">${escapeHtml(meta.msg)}</div>
      <div><button type="button" class="btn btn-primary" id="btnCloseResult">一覧にもどる</button></div>
    </div>
  `);
  // 開封の確定処理はcloseModal()に集約してあるので、ここではただ閉じるだけでいい
  document.getElementById("btnCloseResult").addEventListener("click", closeModal);
}

/* 開封済み科目をもう一度クリック → 結果だけを大きく再プレビュー
   （開封状態やlocalStorageには一切書き込まない） */
function showResultPreview(course){
  pendingRevealCourse = null; // プレビューは開封処理を伴わない
  const meta = getGradeMeta(course);
  const passed = isPassed(course);
  openModal(`
    <div class="result-stage">
      <div class="result-badge" style="background:linear-gradient(150deg, ${meta.color}, ${meta.colorDark})">
        <div class="rb-letter">${escapeHtml(meta.label)}</div>
        <div class="rb-sub">${passed ? "合格" : "不合格"}</div>
      </div>
      <div class="result-course">${escapeHtml(course.name)}</div>
      <div class="result-teacher">👤 ${escapeHtml(course.teacher)}</div>
      <div class="result-message">${escapeHtml(meta.msg)}</div>
      <div><button type="button" class="btn btn-primary" id="btnClosePreview">閉じる</button></div>
    </div>
  `);
  document.getElementById("btnClosePreview").addEventListener("click", closeModal);
}

function playRevealFx(course){
  maybeShowSConfirmEffect(course);
  if (isPassed(course)) launchConfetti(); else launchSadFx();
}

/* Sランクのときは必ず画面いっぱいのお祝い演出を出す。 */
function maybeShowSConfirmEffect(course){
  if (normalizeGradeKey(course.grade) !== "S") return;

  const overlay = document.createElement("div");
  overlay.className = "s-confirm-overlay";
  overlay.innerHTML = `<div class="s-confirm-text">Sおめでとう‼</div>`;
  document.body.appendChild(overlay);
  playPopSfx();
  setTimeout(() => overlay.remove(), 1600);
}

/* ----------------------------------------------------------------------
   15. お祝いオーバーレイ（全開封）
---------------------------------------------------------------------- */
const celebrateOverlay = document.getElementById("celebrateOverlay");
function openCelebrateOverlay(){
  celebrateOverlay.hidden = false;
  celebrateOverlay.style.display = "flex"; // CSS読み込み順やキャッシュに依存せず確実に表示する
}
function closeCelebrateOverlay(){
  celebrateOverlay.hidden = true;
  celebrateOverlay.style.display = "none"; // hidden属性だけに頼らず確実に隠す
}
document.getElementById("celebrateClose").addEventListener("click", closeCelebrateOverlay);
celebrateOverlay.addEventListener("click", (e) => { if (e.target === celebrateOverlay) closeCelebrateOverlay(); });

let celebrated = false;
function showCelebration(revealedCourses){
  if (celebrated) return;
  celebrated = true;
  const total = revealedCourses.length;
  const passCount = revealedCourses.filter(isPassed).length;
  const gpa = computeGpa(revealedCourses);

  document.getElementById("celebrateContent").innerHTML = `
    <div class="celebrate-emoji">🎉</div>
    <div class="celebrate-title">全科目、開封コンプリート！</div>
    <p class="hint">今学期もお疲れさまでした。結果を胸に、次の学期へGO！</p>
    <div class="celebrate-stats">
      <div class="celebrate-stat"><div class="cs-num">${total}</div><div class="cs-label">開封科目数</div></div>
      <div class="celebrate-stat"><div class="cs-num">${Math.round((passCount / total) * 100)}%</div><div class="cs-label">合格率</div></div>
      <div class="celebrate-stat"><div class="cs-num">${gpa}</div><div class="cs-label">参考GPA</div></div>
    </div>
    <button type="button" class="btn btn-primary" id="btnCelebrateOk">閉じる</button>
  `;
  openCelebrateOverlay();
  launchConfetti(2200);
  document.getElementById("btnCelebrateOk").addEventListener("click", closeCelebrateOverlay);
}

/* ----------------------------------------------------------------------
   16. FX: 紙吹雪 / しょんぼりエフェクト
---------------------------------------------------------------------- */
const fxCanvas = document.getElementById("fxCanvas");
const fxCtx = fxCanvas.getContext("2d");
let fxParticles = [];
let fxRunning = false;

function resizeFxCanvas(){
  fxCanvas.width = window.innerWidth;
  fxCanvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeFxCanvas);
resizeFxCanvas();

const CONFETTI_COLORS = ["#e60012", "#ff6600", "#ffb300", "#0068b7", "#009944", "#7a5cff"];

function launchConfetti(durationMs = 1400){
  const count = 90;
  for (let i = 0; i < count; i++){
    fxParticles.push({
      type: "confetti",
      x: Math.random() * fxCanvas.width,
      y: -20 - Math.random() * fxCanvas.height * 0.3,
      vx: (Math.random() - 0.5) * 3,
      vy: 2 + Math.random() * 3,
      size: 5 + Math.random() * 5,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.3,
      life: 0,
      maxLife: durationMs,
    });
  }
  startFxLoop();
}
function launchSadFx(){
  const count = 26;
  for (let i = 0; i < count; i++){
    fxParticles.push({
      type: "drop",
      x: Math.random() * fxCanvas.width,
      y: -20 - Math.random() * 200,
      vx: 0,
      vy: 3 + Math.random() * 2,
      size: 3 + Math.random() * 3,
      color: "#8899aa",
      life: 0,
      maxLife: 1200,
    });
  }
  startFxLoop();
}
function startFxLoop(){
  fxCanvas.style.display = "block";
  if (fxRunning) return;
  fxRunning = true;
  requestAnimationFrame(fxLoop);
}
function fxLoop(){
  fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  fxParticles.forEach(p => {
    p.x += p.vx; p.y += p.vy; p.life += 16;
    if (p.type === "confetti"){
      p.rot += p.vr;
      fxCtx.save();
      fxCtx.translate(p.x, p.y);
      fxCtx.rotate(p.rot);
      fxCtx.fillStyle = p.color;
      fxCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      fxCtx.restore();
    } else {
      fxCtx.fillStyle = p.color;
      fxCtx.beginPath();
      fxCtx.ellipse(p.x, p.y, p.size * 0.6, p.size, 0, 0, Math.PI * 2);
      fxCtx.fill();
    }
  });
  fxParticles = fxParticles.filter(p => p.life < p.maxLife && p.y < fxCanvas.height + 30);
  if (fxParticles.length > 0){
    requestAnimationFrame(fxLoop);
  } else {
    fxRunning = false;
    fxCanvas.style.display = "none";
  }
}

/* ----------------------------------------------------------------------
   17. 表示のたびにポップアップを強制的に閉じる（保険）
   ブラウザの「戻る」でbfcache（前回のページ状態そのまま）から復元された
   場合や、古いCSSがキャッシュされたままの場合でも、開いた直後に
   空っぽのモーダルが出ないようにする。
---------------------------------------------------------------------- */
window.addEventListener("pageshow", () => {
  closeModal();
  closeCelebrateOverlay();
});
