"use strict";
import { getLeaderboard, initializeCloud, saveScore } from "./firebase.js";
// All settings live in config.json. Words live in words.json.
const $ = id => document.getElementById(id);
const rnd = n => Math.floor(Math.random() * n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
async function getJSON(url) { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(url + " not found"); return r.json(); }

let CFG, bank = {}, allWords = new Set(), nick = "", isCustomNick = false, level = "", boardLevel = "", boardData = [], boardFailed = false, game = null, cloudError = null;
const meaningCache = new Map();
const validNick = value => /^[A-Za-z0-9]{3,24}$/.test(value);
try {
  const savedNick = localStorage.getItem("wg_nick") || "";
  if (validNick(savedNick)) nick = savedNick;
} catch (e) {}

// ---------- guest nickname (suggested by the program, no free typing) ----------
function suggestNames() {
  const { adjectives: A, animals: N, suggestionsShown: k } = CFG.nicknames, s = new Set();
  for (let g = 0; s.size < k && g < 200; g++) s.add(A[rnd(A.length)] + N[rnd(N.length)] + (10 + rnd(90)));
  return [...s];
}
function markNick() {
  for (const b of $("nicks").children) { const on = !isCustomNick && b.textContent === nick; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
  updatePlay();
}
function renderNicks() {
  const box = $("nicks"); box.innerHTML = "";
  [...new Set([...(nick && !isCustomNick ? [nick] : []), ...suggestNames()])].slice(0, CFG.nicknames.suggestionsShown).forEach(n => {
    const b = el("button", "chip", n); b.type = "button";
    b.onclick = () => {
      $("custom-nick").value = "";
      isCustomNick = false;
      nick = n;
      try { localStorage.setItem("wg_nick", n); } catch (e) {}
      markNick();
    };
    box.appendChild(b);
  });
  markNick();
}

// ---------- words ----------
function loadWords(json) {
  bank = {}; allWords = new Set();
  const { min, max } = CFG.wordLength, ok = new RegExp(`^[A-Z]{${min},${max}}$`);
  for (const [d, list] of Object.entries(json)) {
    const seen = new Set(), items = [];
    for (const raw of list || []) {
      const obj = raw && typeof raw === "object";
      const w = String(obj ? raw.word : raw).trim().toUpperCase();
      const hint = obj && raw.hint ? String(raw.hint) : "";
      const meaning = obj && raw.meaning ? String(raw.meaning) : "";
      const meaningSource = obj && raw.meaningSource ? String(raw.meaningSource) : "";
      if (!ok.test(w)) console.warn(`Skipped "${w}" in "${d}": use letters A-Z only, ${min}-${max} letters long.`);
      else if (!seen.has(w)) { seen.add(w); items.push({ w, hint, meaning, meaningSource }); allWords.add(w); }
    }
    if (items.length) bank[d.toLowerCase()] = items;
  }
  if (!allWords.size) throw new Error("words.json has no usable words");
}
// A word is playable at a level only if its first and last letters can stay visible.
function pool(domain, lv) {
  const need = CFG.difficulties[lv].blanks + 2, seen = new Map();
  (domain === "all" ? Object.values(bank).flat() : bank[domain] || []).forEach(x => { if (x.w.length >= need && !seen.has(x.w)) seen.set(x.w, x); });
  return [...seen.values()];
}
function refreshTopics() {
  const s = $("domain"), keep = s.value || "all"; s.innerHTML = "";
  s.add(new Option(`All topics (${pool("all", level).length})`, "all"));
  for (const d of Object.keys(bank)) s.add(new Option(`${d} (${pool(d, level).length})`, d));
  s.value = [...s.options].some(o => o.value === keep) ? keep : "all";
  updatePlay();
}
function updatePlay() {
  const n = pool($("domain").value || "all", level).length;
  $("play").disabled = !nick || n === 0;
  $("playinfo").textContent = n ? `${Math.min(n, CFG.rounds)} words this game` : "No words fit this topic at this level. Add longer words to words.json.";
}

// APPLE with 2 blanks becomes A__LE. The hidden letters are always one block.
function makeQuestion(word, hide) {
  const n = word.length, start = 1 + rnd(n - hide - 1);
  const pre = word.slice(0, start), post = word.slice(start + hide), correct = word.slice(start, start + hide);
  const V = "AEIOU", C = "BCDFGHJKLMNPQRSTVWXYZ", wrong = new Set();
  for (let t = 0; wrong.size < CFG.optionsPerQuestion - 1 && t < 300; t++) {
    const ch = [...correct];
    const swap = i => { const p = V.includes(ch[i]) ? V : C; ch[i] = p[rnd(p.length)]; };
    swap(rnd(ch.length));
    if (ch.length > 1 && Math.random() < 0.4) swap(rnd(ch.length));
    const c = ch.join("");
    if (c !== correct && !allWords.has(pre + c + post)) wrong.add(c);
  }
  return { word, correct, shown: pre + "_".repeat(hide) + post, options: shuffle([correct, ...wrong]) };
}

// ---------- levels ----------
function markLevel() { for (const b of $("levels").children) { const on = b.dataset.k === level; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); } }
function markTab() { for (const b of $("tabs").children) { const on = b.dataset.k === boardLevel; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); } }
function renderLevels() {
  for (const [k, d] of Object.entries(CFG.difficulties)) {
    const b = el("button", "chip seg", `${d.label} ${"_".repeat(d.blanks)}`); b.type = "button"; b.dataset.k = k;
    b.onclick = () => { level = boardLevel = k; markLevel(); markTab(); refreshTopics(); renderBoard(); };
    $("levels").appendChild(b);
    const t = el("button", "chip tab", d.label); t.type = "button"; t.dataset.k = k;
    t.onclick = () => { boardLevel = k; markTab(); renderBoard(); };
    $("tabs").appendChild(t);
  }
  markLevel(); markTab();
}

// ---------- game flow ----------
function show(id) { for (const s of ["home", "game", "end"]) $(s).hidden = s !== id; }

function stopQuestionTimer() {
  if (game && game.timerId !== null) { clearInterval(game.timerId); game.timerId = null; }
}

function updateQuestionTimer() {
  const remaining = Math.max(0, Math.ceil((game.deadline - Date.now()) / 1000));
  $("timer").textContent = remaining;
  $("timer-unit").textContent = remaining === 1 ? "second left" : "seconds left";
  $("timer-bar").style.width = `${remaining / CFG.questionTimeSeconds * 100}%`;
  $("timer-wrap").classList.toggle("urgent", remaining <= CFG.timerBlinkLastSeconds);
  if (remaining === 0) answer(null, true);
}

function startQuestionTimer() {
  const timer = $("timer-wrap");
  timer.classList.remove("urgent");
  if (CFG.questionTimeSeconds === 0) { timer.hidden = true; return; }
  timer.hidden = false;
  game.deadline = Date.now() + CFG.questionTimeSeconds * 1000;
  updateQuestionTimer();
  game.timerId = setInterval(updateQuestionTimer, 200);
}

function start() {
  const d = $("domain").value;
  const items = shuffle(pool(d, level)).slice(0, CFG.rounds);
  game = { domain: d, level, items, i: 0, score: 0, right: 0, locked: false, q: null, timerId: null };
  show("game"); ask();
}

function drawTiles(word, shown, state) {
  const box = $("tiles"); box.innerHTML = "";
  [...shown].forEach((c, i) => {
    const blank = c === "_";
    box.appendChild(el("span", "tile" + (blank ? " blank" + (state ? " " + state : "") : ""), blank ? (state ? word[i] : "") : c));
  });
  box.setAttribute("aria-label", shown.replace(/_/g, " blank "));
}

function ask() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  $("vocabulary").hidden = true;
  $("pronunciation-info").textContent = "";
  $("player-nick").textContent = nick;
  const item = game.items[game.i];
  const q = game.q = makeQuestion(item.w, CFG.difficulties[game.level].blanks); game.locked = false;
  $("round").textContent = `Word ${game.i + 1} of ${game.items.length}`;
  $("score").textContent = game.score;
  $("hint").textContent = item.hint ? "Hint: " + item.hint : "";
  drawTiles(q.word, q.shown);
  const box = $("opts"); box.innerHTML = "";
  q.options.forEach((o, k) => {
    const b = el("button", "opt", o); b.type = "button"; b.dataset.v = o; b.title = "Key " + (k + 1);
    b.onclick = () => answer(o); box.appendChild(b);
  });
  $("msg").textContent = ""; $("next").hidden = true;
  startQuestionTimer();
}

function answer(o, timedOut = false) {
  if (game.locked) return;
  if (!timedOut && CFG.questionTimeSeconds && Date.now() >= game.deadline) timedOut = true;
  game.locked = true;
  stopQuestionTimer();
  $("timer-wrap").classList.remove("urgent");
  const q = game.q, ok = o === q.correct;
  game.score += ok ? CFG.pointsRight : CFG.pointsWrong; if (ok) game.right++;
  for (const b of $("opts").children) {
    b.disabled = true;
    if (b.dataset.v === q.correct) b.classList.add("good"); else if (b.dataset.v === o) b.classList.add("bad");
  }
  drawTiles(q.word, q.shown, ok ? "good" : "bad");
  $("score").textContent = game.score;
  $("msg").textContent = timedOut ? `Time's up! The word was ${q.word}. ${CFG.pointsWrong} points.` :
    ok ? `Correct! +${CFG.pointsRight}` : `Not quite. ${CFG.pointsWrong}. The word is ${q.word}.`;
  const item = game.items[game.i];
  $("vocab-word").textContent = q.word;
  $("vocab-meaning").textContent = item.meaning || "Looking up a dictionary definition...";
  showMeaningSource(item.meaning ? item.meaningSource || "Saved word list" : "Free Dictionary API (dictionaryapi.dev)", !item.meaning);
  $("vocabulary").hidden = false;
  if (!item.meaning) showDictionaryMeaning(item, game, game.i);
  $("next").textContent = game.i === game.items.length - 1 ? "See my score" : "Next word";
  $("next").hidden = false; $("next").focus();
}

function showMeaningSource(source, linkToDictionary = false) {
  const box = $("meaning-source");
  box.replaceChildren(document.createTextNode("Source: "));
  if (linkToDictionary) {
    const link = el("a", "", source);
    link.href = "https://dictionaryapi.dev/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    box.appendChild(link);
  } else {
    box.appendChild(document.createTextNode(source));
  }
}

async function lookupMeaning(word) {
  if (!meaningCache.has(word)) {
    meaningCache.set(word, (async () => {
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
      if (!response.ok) throw new Error(`Dictionary lookup failed (${response.status}).`);
      const entries = await response.json();
      const definition = entries.flatMap(entry => entry.meanings || [])
        .flatMap(meaning => meaning.definitions || [])
        .map(item => item.definition)
        .find(text => typeof text === "string" && text.trim());
      if (!definition) throw new Error("No dictionary definition was found.");
      return definition.trim();
    })());
  }
  return meaningCache.get(word);
}

async function showDictionaryMeaning(item, currentGame, questionIndex) {
  try {
    const meaning = await lookupMeaning(item.w);
    if (game === currentGame && game.i === questionIndex && game.locked) $("vocab-meaning").textContent = meaning;
  } catch (error) {
    if (game !== currentGame || game.i !== questionIndex || !game.locked) return;
    $("vocab-meaning").textContent = item.hint
      ? `No dictionary definition is available. Clue: ${item.hint}`
      : "No dictionary definition is available for this word.";
    showMeaningSource("Dictionary lookup unavailable");
  }
}

async function finish() {
  show("end");
  $("final").textContent = game.score;
  $("summary").textContent = `${game.right} of ${game.items.length} correct. ${CFG.difficulties[game.level].label} level, ${game.domain === "all" ? "all topics" : game.domain + " topic"}.`;
  const p = { nick, score: game.score, rounds: game.items.length, difficulty: game.level, domain: game.domain };
  const msg = $("submitmsg");
  boardLevel = game.level; markTab();
  if (cloudError) {
    msg.textContent = "Score not saved because Firebase is unavailable: " + cloudError.message;
    return;
  }
  try {
    await saveScore(p);
    msg.textContent = "Score saved to the shared leaderboard.";
    await loadBoard();
  } catch (e) {
    msg.textContent = "Could not save your score: " + e.message;
  }
}

// ---------- leaderboard ----------
async function loadBoard() {
  try { boardData = await getLeaderboard(); boardFailed = false; }
  catch (e) { boardData = []; boardFailed = true; }
  renderBoard();
}
function renderBoard() {
  const list = $("rows"); list.innerHTML = "";
  const rows = boardData.filter(e => e.difficulty === boardLevel).slice(0, CFG.leaderboard.showTop);
  rows.forEach(e => {
    const li = el("li", e.nick === nick ? "me" : ""); li.append(el("span", "", String(e.nick)), el("b", "", String(Number(e.best))));
    list.appendChild(li);
  });
  $("boardmsg").textContent = boardFailed ? "Leaderboard not available yet." : rows.length ? "" : "No scores yet at this level. Be the first!";
}

// ---------- start-up ----------
async function init() {
  $("play").onclick = start;
  $("pronounce").onclick = () => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
    const utterance = new SpeechSynthesisUtterance($("vocab-word").textContent);
    utterance.lang = "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    $("pronounce").disabled = true;
    $("pronunciation-info").textContent = "Audio pronunciation is not supported in this browser.";
  }
  $("domain").onchange = updatePlay;
  $("custom-nick").oninput = () => {
    isCustomNick = true;
    nick = validNick($("custom-nick").value) ? $("custom-nick").value : "";
    try {
      if (nick) localStorage.setItem("wg_nick", nick);
      else localStorage.removeItem("wg_nick");
    } catch (e) {}
    markNick();
  };
  $("again").onclick = () => { show("home"); renderNicks(); refreshTopics(); };
  $("reroll").onclick = renderNicks;
  $("next").onclick = () => { if (game.i >= game.items.length - 1) finish(); else { game.i++; ask(); } };
  document.addEventListener("keydown", e => {
    if (!$("game").hidden && game && !game.locked && /^[1-9]$/.test(e.key)) { const b = $("opts").children[+e.key - 1]; if (b) b.click(); }
  });
  try {
    CFG = await getJSON("config.json");
    loadWords(await getJSON("words.json"));
  } catch (e) {
    const box = $("error"); box.hidden = false;
    box.textContent = "Could not load the game files (" + e.message + "). If you opened index.html by double-clicking, start the local server instead: python server.py";
    $("home").hidden = true; return;
  }
  document.title = CFG.title; $("title").textContent = CFG.title;
  const d = CFG.difficulties;
  const timerRule = CFG.questionTimeSeconds ? `${CFG.questionTimeSeconds} seconds per word.` : "No time limit.";
  $("rules").textContent = `Pick the missing letters to finish each word. ${timerRule} Right answer +${CFG.pointsRight}, wrong answer ${CFG.pointsWrong}. ${CFG.rounds} words per game.`;
  level = boardLevel = d[CFG.defaultDifficulty] ? CFG.defaultDifficulty : Object.keys(d)[0];
  try {
    await initializeCloud();
    $("modeinfo").textContent = "Shared leaderboard powered by Firebase.";
  } catch (e) {
    cloudError = e;
    $("modeinfo").textContent = "Firebase setup needed: " + e.message;
  }
  renderLevels(); renderNicks(); refreshTopics(); loadBoard();
}
init();
