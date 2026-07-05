/* ═══════════════════════════════════════════════════════════
   GUSERA · SATS — Self-Aware Trend System (web port)
   Port dari Pine Script v6 "Self-Aware Trend System [GUSERA]"
   Semua komputasi berjalan client-side di browser.
   ═══════════════════════════════════════════════════════════ */

const CONST = {
  MAX_HISTORY_SIGS: 100,
  BYPASS_SCORE: 12.0, MULT_SMOOTH_ALPHA: 0.15,
  // True max score ceilings for scoreBreakdown(): momScore(17)+erScore(17)+rsiScore(17)
  // +structScore(16)+breakScore(16) = 83, plus vScore which is either up to 17 (real volume)
  // or a fixed 12 (BYPASS_SCORE, no volume data — e.g. most forex/gold pairs), plus
  // patternScore (up to MAX_PATTERN_SCORE) from candlestick/chart-pattern confluence.
  MAX_SCORE_WITH_VOLUME: 110, MAX_SCORE_NO_VOLUME: 105,
  // Confluence weights for chart/candlestick patterns detected around a signal bar.
  // Reversal candles (engulfing/pin bar) count more than plain trend-structure
  // confirmation (higher-low/lower-high), since the former directly contradicts the
  // prior bar while the latter simply restates the existing trend.
  PATTERN_WEIGHTS: {
    'Bullish Engulfing':6, 'Bearish Engulfing':6,
    'Hammer':5, 'Shooting Star':5,
    'Double Bottom':4, 'Double Top':4,
    'Higher Low':2, 'Lower High':2,
  },
  MAX_PATTERN_SCORE: 10,
};

/* ═══════════════════════════════════════════════════════════
   POOL API KEY BAWAAN (auto-switch)
   ─────────────────────────────────────────────────────────
   5 API key Twelve Data ditanam sebagai pool bawaan supaya app langsung bisa
   dipakai tanpa setup. Karena key ini dibagikan lewat kode sumber (terlihat via
   view-source, sama seperti API key client-side manapun), quota-nya dipakai
   bersama oleh semua orang yang menjalankan file ini — cukup untuk pemakaian
   ringan/personal, TAPI auto-switch di bawah ini yang membuatnya tetap jalan
   walau satu-dua key kena rate-limit duluan. Untuk pemakaian rutin/produksi,
   isi API key pribadi Anda sendiri di ⚙ Pengaturan — key pribadi selalu dicoba
   LEBIH DULU sebelum pool bawaan (lihat getApiKeyPool()). */
const API_KEY_POOL = [
  'd8eb085a72984fdfa4effa40746458f5',
  'c6b8d923e13448e2aaa3401fcc57d003',
  '9dc53a7534c94008ab338ca174cec529',
  'aeae5c0d888042b9a374f6cc36334499',
  '17b2bb1a7191434d989bc757ea699f33',
];
const DEFAULT_API_KEY = '';

let state = {
  apiKey:DEFAULT_API_KEY, apiKeyIndex:0, symbol:'XAU/USD', interval:'15min', outputSize:300,
  refreshMs:900000, notif:true, sound:true,
  preset:'Custom', tpMode:'Fixed', qualityStrength:0.4,
  useAsym:true, useCharFlip:true, useEffAtr:true, useBreakeven:false,
  useAdaptiveThreshold:true, useCandleConfirm:true,
  timer:null, candles:[], lastBarTime:null, notifPermission:false,
  csvMode:false,
  currentThreshold:null, // set each cycle by computeAdaptiveThreshold()
};

let lastResult = null; // most recent computeEngine() output, kept for CSV export

/* ═══════════════════════════════════════════════════════════
   RIWAYAT TERSIMPAN (persisted trade history, localStorage)
   ─────────────────────────────────────────────────────────
   computeEngine() melakukan backtest ulang tiap cycle dari jendela candle
   yang sedang di-fetch (default 300 candle) — statistik "all-time" di sana
   sebenarnya terikat pada jendela itu dan otomatis hilang begitu candle lama
   ter-geser keluar. Untuk feedback loop (ambang skor adaptif) yang berguna,
   kita butuh riwayat yang benar-benar bertahan lintas sesi/reload dan lintas
   pergeseran jendela candle — makanya trade yang closed disalin ke sini. */
const LS_HISTORY_KEY = 'gusera_sats_history_v1';
const MAX_PERSISTED = 1000; // cap penyimpanan agar localStorage tidak membengkak
let persistedHistory = [];

/* Migrasi lembut untuk baris riwayat dari versi lama (sebelum field tampilan lengkap
   ditambahkan) — field yang belum ada diisi default aman, supaya tabel Riwayat Sinyal
   & unduhan CSV tidak error/kosong pada baris lama yang sudah tersimpan di localStorage
   pengguna. */
function normalizePersistedItem(h){
  return {
    key:h.key, symbol:h.symbol, interval:h.interval, time:h.time, side:h.side,
    score: h.score!=null ? h.score : 0, tqi: h.tqi!=null ? h.tqi : 0,
    realizedR: h.realizedR!=null ? h.realizedR : null, status: h.status || '—',
    price: h.price!=null ? h.price : NaN, sl: h.sl!=null ? h.sl : NaN,
    tp1: h.tp1!=null ? h.tp1 : NaN, tp2: h.tp2!=null ? h.tp2 : NaN, tp3: h.tp3!=null ? h.tp3 : NaN,
    hit: Array.isArray(h.hit) ? h.hit : [false,false,false],
    pattern: h.pattern || null, patternScore: h.patternScore!=null ? h.patternScore : 0,
    // Baris lama (sebelum field ini ada) otomatis jadi null — dikecualikan dari
    // pembelajaran bobot sampai ada trade baru yang membawa field ini (lihat
    // weightForConfluence: f===null dikecualikan, bukan dihitung sebagai "tidak searah").
    structAligned: h.structAligned!=null ? h.structAligned : null,
    momAligned: h.momAligned!=null ? h.momAligned : null,
    tqiErAtEntry: h.tqiErAtEntry!=null ? h.tqiErAtEntry : null,
    tqiVolAtEntry: h.tqiVolAtEntry!=null ? h.tqiVolAtEntry : null,
    valid: h.valid!=null ? h.valid : true,
  };
}

function loadPersistedHistory(){
  try{
    const raw = localStorage.getItem(LS_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    persistedHistory = Array.isArray(parsed) ? parsed.map(normalizePersistedItem) : [];
  }catch(e){ persistedHistory = []; }
}

function savePersistedHistory(){
  try{
    if(persistedHistory.length>MAX_PERSISTED) persistedHistory = persistedHistory.slice(-MAX_PERSISTED);
    localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(persistedHistory));
  }catch(e){ /* Safari private mode / storage penuh — abaikan, aplikasi tetap jalan */ }
}

function resetPersistedHistory(){
  persistedHistory = [];
  try{ localStorage.removeItem(LS_HISTORY_KEY); }catch(e){}
}

/* Salin sinyal yang sudah closed (SL/TP3/TIMEOUT/BE) dari hasil computeEngine ke
   penyimpanan permanen, dedupe berdasarkan symbol+interval+waktu+sisi supaya cycle
   berikutnya (yang meng-backtest ulang jendela candle yang sama) tidak menduplikasi. */
function syncPersistedHistory(signals){
  const closed = signals.filter(s=>s.status!=='OPEN' && s.realizedR!=null);
  if(!closed.length) return;
  const existingKeys = new Set(persistedHistory.map(h=>h.key));
  let added = false;
  closed.forEach(s=>{
    const key = `${state.symbol}|${state.interval}|${s.time}|${s.side}`;
    if(existingKeys.has(key)) return;
    existingKeys.add(key);
    persistedHistory.push({
      key, symbol:state.symbol, interval:state.interval, time:s.time, side:s.side,
      score:s.score, tqi:s.tqi, realizedR:s.realizedR, status:s.status,
      // Field tampilan lengkap (harga/SL/TP/pola/dll) ikut disimpan permanen supaya
      // tabel Riwayat Sinyal & unduhan CSV bisa 100% bersumber dari sini — tidak lagi
      // dari hasil backtest jendela candle yang sedang aktif (yang otomatis menyusut
      // begitu candle lama ter-geser keluar tiap kali data terbaru di-fetch).
      price:s.price, sl:s.sl, tp1:s.tp1, tp2:s.tp2, tp3:s.tp3, hit:[...s.hit],
      pattern:s.pattern, patternScore:s.patternScore, valid: s.valid!==false,
      structAligned: s.structAligned!=null ? s.structAligned : null,
      momAligned: s.momAligned!=null ? s.momAligned : null,
      tqiErAtEntry: s.tqiErAtEntry!=null ? s.tqiErAtEntry : null,
      tqiVolAtEntry: s.tqiVolAtEntry!=null ? s.tqiVolAtEntry : null,
    });
    added = true;
  });
  if(added) savePersistedHistory();
}

/* Statistik dari riwayat tersimpan, dibatasi ke pair+timeframe yang sedang aktif
   (win rate XAU/USD M15 tidak relevan dicampur dengan EUR/USD H1). winRate/avgR
   di sini memakai recency weighting (lihat weightedTradeStats) — trade terbaru
   lebih berpengaruh daripada trade lama, supaya statistik & ambang adaptif lebih
   cepat menyesuaikan begitu rezim pasar berubah. */
function getPersistedStats(windowN){
  const N = windowN || CONST.MAX_HISTORY_SIGS;
  const rel = persistedHistory.filter(h=>h.symbol===state.symbol && h.interval===state.interval);
  const windowed = rel.slice(-N);
  const w = weightedTradeStats(windowed, 15);
  return {
    total: rel.length,
    windowCount: windowed.length,
    winRate: w.winRate,
    avgR: w.avgR,
  };
}

/* ═══════════════════════════════════════════════════════════
   RIWAYAT SINYAL TERLEWAT (skipped signals, localStorage)
   ─────────────────────────────────────────────────────────
   Sinyal yang trend-flip-nya valid & lolos filter EMA, tapi skornya di bawah
   ambang self-learning, dulunya langsung dibuang tanpa pernah dicek "seandainya
   tetap dieksekusi, hasilnya menang atau kalah?". Sekarang tiap sinyal yang
   terlewat disimulasikan secara sederhana (satu target: SL vs TP1 saja, bukan
   3-leg penuh seperti trade sungguhan — lihat simulateHypotheticalOutcome() di
   computeEngine) dan hasilnya (hypotheticalR) disimpan permanen di sini kalau
   sudah resolve dalam jendela candle yang sama. Data ini dipakai sebagai umpan
   balik: kalau sinyal yang ditolak ternyata rata-rata profitable, berarti
   ambang kelewat ketat (lihat computeAdaptiveThreshold). */
const LS_SKIPPED_KEY = 'gusera_sats_skipped_v1';
const MAX_PERSISTED_SKIPPED = 500;
let persistedSkipped = [];

function normalizeSkippedItem(h){
  return {
    key:h.key, symbol:h.symbol, interval:h.interval, time:h.time, side:h.side,
    score: h.score!=null ? h.score : 0,
    hypotheticalR: h.hypotheticalR!=null ? h.hypotheticalR : null,
  };
}
function loadPersistedSkipped(){
  try{
    const raw = localStorage.getItem(LS_SKIPPED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    persistedSkipped = Array.isArray(parsed) ? parsed.map(normalizeSkippedItem) : [];
  }catch(e){ persistedSkipped = []; }
}
function savePersistedSkipped(){
  try{
    if(persistedSkipped.length>MAX_PERSISTED_SKIPPED) persistedSkipped = persistedSkipped.slice(-MAX_PERSISTED_SKIPPED);
    localStorage.setItem(LS_SKIPPED_KEY, JSON.stringify(persistedSkipped));
  }catch(e){ /* Safari private mode / storage penuh — abaikan */ }
}
function resetPersistedSkipped(){
  persistedSkipped = [];
  try{ localStorage.removeItem(LS_SKIPPED_KEY); }catch(e){}
}
/* Hanya simpan yang sudah RESOLVE (hypotheticalR!=null) — sinyal terlewat yang
   masih "berjalan" (belum sempat kena SL/TP1 di sisa candle jendela saat ini)
   tidak disimpan dulu, supaya tidak dihitung sebagai 0/netral yang keliru. */
function syncPersistedSkipped(skippedSignals){
  const resolved = skippedSignals.filter(s=>s.hypotheticalR!=null);
  if(!resolved.length) return;
  const existingKeys = new Set(persistedSkipped.map(h=>h.key));
  let added = false;
  resolved.forEach(s=>{
    const key = `${state.symbol}|${state.interval}|${s.time}|${s.side}`;
    if(existingKeys.has(key)) return;
    existingKeys.add(key);
    persistedSkipped.push({ key, symbol:state.symbol, interval:state.interval, time:s.time, side:s.side,
      score:s.score, hypotheticalR:s.hypotheticalR });
    added = true;
  });
  if(added) savePersistedSkipped();
}
function getSkippedStats(windowN){
  const N = windowN || 50;
  const rel = persistedSkipped.filter(h=>h.symbol===state.symbol && h.interval===state.interval);
  const windowed = rel.slice(-N);
  const wins = windowed.filter(h=>h.hypotheticalR>0).length;
  return {
    total: rel.length,
    windowCount: windowed.length,
    winRate: windowed.length ? wins/windowed.length*100 : null,
    avgR: windowed.length ? windowed.reduce((a,h)=>a+h.hypotheticalR,0)/windowed.length : null,
  };
}

/* ═══════════════════════════════════════════════════════════
   BOBOT CONFLUENCE YANG DIPELAJARI
   ─────────────────────────────────────────────────────────
   Efektivitas tiap confluence diukur dari riwayat tersimpan: dibandingkan
   avg-R trade yang confluence-nya "hadir/searah" vs yang "tidak" — kalau
   bedanya positif & sampelnya cukup (≥10 di kedua sisi), bobotnya dinaikkan
   (maks 1.5×); kalau bedanya negatif/tidak signifikan, bobotnya diturunkan
   (min 0.5×) supaya tidak terus mendominasi skor padahal terbukti tidak
   informatif untuk pair+timeframe ini. Di bawah 10 sampel per sisi, bobot
   tetap netral (1.0×, identik perilaku lama). */
function weightForConfluence(rel, flagFn){
  const withFlag=[], withoutFlag=[];
  rel.forEach(h=>{
    const f = flagFn(h);
    if(f===true) withFlag.push(h);
    else if(f===false) withoutFlag.push(h);
    // f===null -> confluence tidak tersedia untuk trade ini, dikecualikan dari perbandingan
  });
  const MIN_N = 10;
  if(withFlag.length<MIN_N || withoutFlag.length<MIN_N){
    return { weight:1, sample:withFlag.length, learned:false };
  }
  const avgWith = withFlag.reduce((a,h)=>a+h.realizedR,0)/withFlag.length;
  const avgWithout = withoutFlag.reduce((a,h)=>a+h.realizedR,0)/withoutFlag.length;
  const lift = avgWith-avgWithout;
  const weight = clamp(1+lift*0.8, 0.5, 1.5);
  return { weight, sample:withFlag.length, avgWith, avgWithout, learned:true };
}
/* Versi kontinu dari weightForConfluence — dipakai untuk faktor yang nilainya berupa
   MAGNITUDE 0..1 (bukan flag hadir/tidak-hadir), seperti Efficiency Ratio & Volatilitas
   dari Trend Quality Index. Sampel dibagi jadi separuh-atas/separuh-bawah berdasarkan
   median nilai faktor tsb, lalu avg-R kedua kelompok dibandingkan dengan cara yang sama
   persis seperti weightForConfluence (lift, clamp 0.5×–1.5×, perlu ≥10 sampel per sisi). */
function weightForMagnitude(rel, valueFn){
  const pts = rel.map(h=>({v:valueFn(h), r:h.realizedR})).filter(p=>p.v!=null && p.r!=null);
  const MIN_N = 10;
  if(pts.length < MIN_N*2) return { weight:1, sample:pts.length, learned:false };
  const sorted = [...pts].sort((a,b)=>a.v-b.v);
  const mid = Math.floor(sorted.length/2);
  const lower = sorted.slice(0,mid), upper = sorted.slice(mid);
  if(lower.length<MIN_N || upper.length<MIN_N) return { weight:1, sample:pts.length, learned:false };
  const avgWith = upper.reduce((a,p)=>a+p.r,0)/upper.length; // avg-R saat nilai faktor TINGGI
  const avgWithout = lower.reduce((a,p)=>a+p.r,0)/lower.length; // avg-R saat nilai faktor RENDAH
  const lift = avgWith-avgWithout;
  const weight = clamp(1+lift*0.8, 0.5, 1.5);
  return { weight, sample:pts.length, avgWith, avgWithout, learned:true };
}

/* ═══════════════════════════════════════════════════════════
   BOBOT MODEL STATUS TREND (self-learning, sumber data: riwayat trade tersimpan
   + faktor Trend Quality Index pada tiap entry)
   ─────────────────────────────────────────────────────────
   Menggantikan logic Status Trend yang lama (arah cuma ikut flip SuperTrend, tag
   confirmation cuma pass/fail berdasarkan rule tetap). Di sini SETIAP faktor —
   Struktur harga, Momentum, Pola Chart, plus 2 faktor TQI (Efficiency Ratio &
   Volatilitas) — diberi bobot yang dipelajari
   dari seberapa besar faktor itu terbukti berkorelasi dengan hasil (realized-R) trade
   tersimpan untuk pair+timeframe yang sedang aktif. Faktor yang terbukti prediktif
   dinaikkan bobotnya (maks 1.5×), yang terbukti tidak informatif diturunkan (min 0.5×).
   Di bawah 10 sampel per sisi, bobot tetap netral (1.0×) — lihat weightForConfluence /
   weightForMagnitude. */
function computeTrendWeights(){
  const rel = persistedHistory.filter(h=>h.symbol===state.symbol && h.interval===state.interval);
  const struct_ = weightForConfluence(rel, h=>h.structAligned);
  const mom = weightForConfluence(rel, h=>h.momAligned);
  const pattern = weightForConfluence(rel, h=>h.pattern ? true : (h.pattern===null ? false : null));
  const tqiEff = weightForMagnitude(rel, h=>h.tqiErAtEntry);
  const tqiVolatility = weightForMagnitude(rel, h=>h.tqiVolAtEntry);
  return {
    structWeight:struct_.weight, momWeight:mom.weight, patternWeight:pattern.weight,
    struct:struct_, mom, pattern,
    tqiEffWeight:tqiEff.weight, tqiVolWeight:tqiVolatility.weight, tqiEff, tqiVol:tqiVolatility,
  };
}
// Nama lama dipertahankan sebagai alias supaya tidak ada pemanggil lain yang patah.
const computeConfluenceWeights = computeTrendWeights;

/* Rata-rata & win-rate dengan peluruhan waktu (recency weighting) — trade yang
   lebih baru diberi bobot lebih besar daripada trade lama, supaya statistik
   tidak "diseret" oleh performa lama begitu rezim pasar sudah berubah (mis.
   dari trending ke choppy). Bobot meluruh separuh tiap `halfLife` trade ke
   belakang (default 15 trade) — trade paling baru (index terakhir) bobotnya 1. */
function weightedTradeStats(list, halfLife){
  const hl = halfLife || 15;
  const decay = Math.pow(0.5, 1/hl);
  let wSum=0, wWinSum=0, wRSum=0;
  for(let k=0;k<list.length;k++){
    const distFromEnd = list.length-1-k;
    const w = Math.pow(decay, distFromEnd);
    wSum += w;
    if(list[k].realizedR>0) wWinSum += w;
    wRSum += w*list[k].realizedR;
  }
  return {
    winRate: wSum ? wWinSum/wSum*100 : null,
    avgR: wSum ? wRSum/wSum : null,
  };
}

/* ═══════════════════════════════════════════════════════════
   AMBANG SKOR ADAPTIF (self-learning feedback loop)
   ─────────────────────────────────────────────────────────
   Baseline netral: 45% dari skor maksimum. Begitu ada cukup sampel (≥15 trade
   tersimpan untuk pair+timeframe ini, guna hindari overfit ke sampel kecil),
   ambang disesuaikan mengikuti 3 hal, bukan cuma win rate mentah seperti versi
   sebelumnya:
   1) EXPECTANCY (avg-R, sudah recency-weighted), bukan win rate — supaya
      strategi trend-following WR-rendah/avg-R-tinggi yang sebenarnya sehat
      tidak keliru dianggap "buruk" dan malah diperketat.
   2) Dipetakan KONTINU (linear) dari expectancy ke persentase ambang, bukan
      tangga diskrit 40/50/58% yang menyebabkan lompatan ambang tiba-tiba
      padahal performanya nyaris sama di kedua sisi batas.
   3) CONFIDENCE bertahap dari 15→50 trade tersimpan (blend baseline→hasil
      hitung), bukan on/off keras di sampel ke-15 yang rawan overfit ke sampel
      kecil.
   Ditambah umpan balik dari sinyal yang TERLEWAT (skipped, lihat blok di atas):
   kalau sinyal yang ditolak dulu ternyata rata-rata profitable secara
   hipotetis, ambang dilonggarkan sedikit (maks ±3 poin persentase). */
function computeAdaptiveThreshold(maxScoreRef){
  const BASE_PCT = 0.45;
  if(!state.useAdaptiveThreshold){
    return { pct:BASE_PCT, score:BASE_PCT*maxScoreRef, reason:'Ambang adaptif nonaktif (baseline tetap)' };
  }
  const stats = getPersistedStats(30);
  if(stats.windowCount < 15){
    return { pct:BASE_PCT, score:BASE_PCT*maxScoreRef, reason:`Baseline — sampel tersimpan baru ${stats.windowCount}/15 trade` };
  }
  const expectancy = stats.avgR; // avg-R yang sudah recency-weighted = expectancy per-trade dalam satuan R
  const rawPct = mapClamp(expectancy, -0.2, 0.5, 0.62, 0.32);

  const confidence = mapClamp(stats.windowCount, 15, 50, 0.25, 1.0);
  let pct = BASE_PCT*(1-confidence) + rawPct*confidence;

  const skipped = getSkippedStats(50);
  let skipNote = '';
  if(skipped.windowCount>=10 && skipped.avgR!=null){
    const skipNudge = clamp(mapClamp(skipped.avgR, -0.3,0.3, 0.03,-0.03), -0.03, 0.03);
    pct += skipNudge;
    skipNote = ` · sinyal terlewat (${skipped.windowCount}): ${skipped.avgR>=0?'+':''}${skipped.avgR.toFixed(2)}R`;
  }
  pct = clamp(pct, 0.25, 0.70);

  const reason = `Expectancy ${stats.windowCount} trade terakhir: ${expectancy>=0?'+':''}${expectancy.toFixed(2)}R (WR ${stats.winRate.toFixed(0)}%) · confidence ${(confidence*100).toFixed(0)}%${skipNote}`;
  return { pct, score:pct*maxScoreRef, reason };
}

/* ── small numeric helpers (port of Pine util fns) ─────────── */
const clamp = (x,lo,hi)=>Math.min(hi,Math.max(lo,x));
const safeDiv = (a,b,fb)=> (b===0||!isFinite(b)) ? fb : a/b;
function mapClamp(x, inLo, inHi, outLo, outHi){
  if(inHi===inLo) return outLo;
  let t = (x-inLo)/(inHi-inLo);
  t = clamp(t,0,1);
  return outLo + t*(outHi-outLo);
}
const mapClampInv = mapClamp; // same linear interpolation, direction encoded by outLo/outHi order

function presetParams(preset, tfMinutes){
  let resolved = preset;
  if(preset==='Auto') resolved = tfMinutes<=5 ? 'Scalping' : (tfMinutes<=240 ? 'Default' : 'Swing');
  const table = {
    Scalping:{atrLen:10, baseMult:1.5, erLen:14, rsiLen:9,  slMult:1.0},
    Default: {atrLen:14, baseMult:2.0, erLen:20, rsiLen:14, slMult:1.5},
    Swing:   {atrLen:21, baseMult:2.5, erLen:30, rsiLen:21, slMult:2.0},
    // Trend Quality Index — pengaturan diminta: ATR Length 21, Base Band Width 4×ATR,
    // Source = close (source memang selalu close di port ini, lihat catatan di dekat charFlipCond).
    Custom:  {atrLen:21, baseMult:4.0, erLen:30, rsiLen:21, slMult:2.0},
  };
  return {resolved, ...table[resolved]};
}
function tfToMinutes(iv){
  const map = {'1min':1,'5min':5,'15min':15,'30min':30,'1h':60,'4h':240,'1day':1440};
  return map[iv] || 15;
}
/* ── indicator series builders ──────────────────────────────── */
function trueRangeArr(c){
  const tr=[];
  for(let i=0;i<c.length;i++){
    if(i===0){ tr.push(c[i].high-c[i].low); continue; }
    tr.push(Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)));
  }
  return tr;
}
function rma(arr, len){ // Wilder smoothing
  const out=new Array(arr.length).fill(NaN);
  let sum=0;
  for(let i=0;i<arr.length;i++){
    if(i<len){ sum+=arr[i]; out[i] = i===len-1 ? sum/len : (i===0?arr[0]:out[i-1]); }
    else{ out[i] = (out[i-1]*(len-1) + arr[i]) / len; }
  }
  return out;
}
function smaArr(arr, len){
  const out = new Array(arr.length).fill(NaN);
  let sum=0;
  for(let i=0;i<arr.length;i++){
    sum += arr[i];
    if(i>=len) sum -= arr[i-len];
    out[i] = i>=len-1 ? sum/len : arr.slice(0,i+1).reduce((a,b)=>a+b,0)/(i+1);
  }
  return out;
}
function efficiencyRatioArr(closes, len){
  const out = new Array(closes.length).fill(0.3);
  for(let i=0;i<closes.length;i++){
    if(i<len){ out[i]=0.3; continue; }
    const dir = Math.abs(closes[i]-closes[i-len]);
    let vol=0;
    for(let k=i-len+1;k<=i;k++) vol += Math.abs(closes[k]-closes[k-1]);
    out[i] = clamp(safeDiv(dir,vol,0.3),0,1);
  }
  return out;
}
function rsiArr(closes, len){
  const out = new Array(closes.length).fill(50);
  let avgGain=0, avgLoss=0;
  for(let i=1;i<closes.length;i++){
    const diff = closes[i]-closes[i-1];
    const gain = Math.max(diff,0), loss = Math.max(-diff,0);
    if(i<=len){
      avgGain += gain/len; avgLoss += loss/len;
      out[i] = i===len ? computeRsi(avgGain,avgLoss) : 50;
    } else {
      avgGain = (avgGain*(len-1)+gain)/len;
      avgLoss = (avgLoss*(len-1)+loss)/len;
      out[i] = computeRsi(avgGain,avgLoss);
    }
  }
  function computeRsi(g,l){ if(l===0) return 100; const rs=g/l; return 100-100/(1+rs); }
  return out;
}
function rollingHighest(arr,len){ return arr.map((_,i)=>{ const s=Math.max(0,i-len+1); return Math.max(...arr.slice(s,i+1)); }); }
function rollingLowest(arr,len){ return arr.map((_,i)=>{ const s=Math.max(0,i-len+1); return Math.min(...arr.slice(s,i+1)); }); }

function pivotHighArr(highs, lp){
  const out = new Array(highs.length).fill(null);
  for(let i=lp;i<highs.length-lp;i++){
    let isPivot=true, v=highs[i];
    for(let k=i-lp;k<=i+lp;k++){ if(k!==i && highs[k]>=v){ isPivot=false; break; } }
    if(isPivot) out[i]=v;
  }
  return out;
}
function pivotLowArr(lows, lp){
  const out = new Array(lows.length).fill(null);
  for(let i=lp;i<lows.length-lp;i++){
    let isPivot=true, v=lows[i];
    for(let k=i-lp;k<=i+lp;k++){ if(k!==i && lows[k]<=v){ isPivot=false; break; } }
    if(isPivot) out[i]=v;
  }
  return out;
}

/* ── full engine: recompute everything from candle history ─── */
function computeEngine(candles, cfg){
  const n = candles.length;
  const closes = candles.map(c=>c.close), highs=candles.map(c=>c.high), lows=candles.map(c=>c.low);
  const hasVolume = candles.some(c=>c.volume>0);
  const momLen=10, structLen=20; // shared lookback lengths, used consistently below

  // ── ambang skor self-learning (dihitung SEBELUM loop bar) ──────────────────
  // maxScoreRef hanya bergantung pada hasVolume (sudah diketahui di titik ini),
  // sehingga entryThreshold bisa dihitung di awal dan dipakai untuk MENGGERBANG
  // entry di loop bar bawah — bukan cuma label "Valid/Lemah" kosmetik setelah
  // trade sudah dibuka seperti sebelumnya. Ini yang membuat entry benar-benar
  // "mengikuti perintah" self-learning.
  const maxScoreRef = hasVolume ? CONST.MAX_SCORE_WITH_VOLUME : CONST.MAX_SCORE_NO_VOLUME;
  const entryThreshold = computeAdaptiveThreshold(maxScoreRef);

  const tr = trueRangeArr(candles);
  const rawAtr = rma(tr, cfg.atrLen);
  const atrBaseline = smaArr(rawAtr, 100);
  const volRatio = rawAtr.map((v,i)=> safeDiv(v, atrBaseline[i]||v, 1));
  const er = efficiencyRatioArr(closes, cfg.erLen);
  const effAtr = rawAtr.map((v,i)=> cfg.useEffAtr ? v*(0.5+0.5*er[i]) : v);

  const structHi = rollingHighest(highs, structLen), structLo = rollingLowest(lows, structLen);
  const rsiVals = rsiArr(closes, cfg.rsiLen);

  // volume z (fallback to volRatio proxy when no real volume)
  const volZ = new Array(n).fill(0);
  if(hasVolume){
    const vols = candles.map(c=>c.volume);
    for(let i=0;i<n;i++){
      const s=Math.max(0,i-structLen+1); const w=vols.slice(s,i+1);
      const mean=w.reduce((a,b)=>a+b,0)/w.length;
      const sd=Math.sqrt(w.reduce((a,b)=>a+(b-mean)*(b-mean),0)/w.length)||1;
      volZ[i]=(vols[i]-mean)/sd;
    }
  }

  const tqi=new Array(n), tqiEr=new Array(n), tqiVol=new Array(n), tqiStruct=new Array(n), tqiMom=new Array(n);
  // ── Arah (bukan cuma magnitude) dari tiap faktor TQI — dipakai sebagai "vote" arah
  // oleh model Status Trend self-learning di bawah (lihat computeTrendWeights &
  // renderAll). tqiStruct/tqiMom sendiri cuma menyimpan MAGNITUDE (0..1, seberapa
  // kuat), jadi arahnya (bullish/bearish) perlu disimpan terpisah di sini.
  const structDirArr=new Array(n), momDirArr=new Array(n);
  for(let i=0;i<n;i++){
    tqiEr[i]=clamp(er[i],0,1);
    tqiVol[i]= hasVolume ? mapClamp(volZ[i],-1,2,0,1) : mapClamp(volRatio[i],0.6,1.8,0,1);
    const range = structHi[i]-structLo[i];
    const pos = safeDiv(closes[i]-structLo[i], range, 0.5);
    tqiStruct[i]=clamp(Math.abs(pos-0.5)*2,0,1);
    structDirArr[i] = range>0 ? (pos>0.5 ? 1 : (pos<0.5 ? -1 : 0)) : null;
    if(i<momLen){ tqiMom[i]=0.5; momDirArr[i]=null; }
    else{
      const windowChange = closes[i]-closes[i-momLen];
      let aligned=0;
      for(let k=0;k<momLen;k++){
        const barChange = closes[i-k]-closes[i-k-1];
        if((windowChange>0&&barChange>0)||(windowChange<0&&barChange<0)) aligned++;
      }
      tqiMom[i]=aligned/momLen;
      momDirArr[i] = windowChange>0 ? 1 : (windowChange<0 ? -1 : 0);
    }
    const wSum = 0.35+0.20+0.25+0.20;
    tqi[i]=clamp((tqiEr[i]*0.35+tqiVol[i]*0.20+tqiStruct[i]*0.25+tqiMom[i]*0.20)/wSum,0,1);
  }

  // adaptive multipliers
  const activeMultSm=new Array(n), passiveMultSm=new Array(n);
  const baseMult=cfg.baseMult, adaptStrength=0.5, qualityStrength=cfg.qualityStrength, qualityCurve=1.5, asymStrength=0.5;
  for(let i=0;i<n;i++){
    const legacyAdaptFactor = 1 + adaptStrength*(0.5-er[i]);
    const qualityDeviation = Math.pow(1-tqi[i], qualityCurve);
    const tqiMult = 1-qualityStrength + qualityStrength*(0.6+0.8*qualityDeviation);
    const symMult = baseMult*legacyAdaptFactor*tqiMult;
    let activeRaw=symMult, passiveRaw=symMult;
    if(cfg.useAsym){
      activeRaw = symMult*(1-asymStrength*tqi[i]*0.3);
      passiveRaw = symMult*(1+asymStrength*tqi[i]*0.4);
    }
    activeMultSm[i] = i===0 ? activeRaw : activeMultSm[i-1]*(1-CONST.MULT_SMOOTH_ALPHA)+activeRaw*CONST.MULT_SMOOTH_ALPHA;
    passiveMultSm[i] = i===0 ? passiveRaw : passiveMultSm[i-1]*(1-CONST.MULT_SMOOTH_ALPHA)+passiveRaw*CONST.MULT_SMOOTH_ALPHA;
  }

  // adaptive supertrend
  const lowerBand=new Array(n), upperBand=new Array(n), stTrend=new Array(n), stLine=new Array(n);
  let trendStartBar=0;
  for(let i=0;i<n;i++){
    const prevTrend = i===0 ? 1 : stTrend[i-1];
    const lowerMult = prevTrend===1?activeMultSm[i]:passiveMultSm[i];
    const upperMult = prevTrend===1?passiveMultSm[i]:activeMultSm[i];
    const lowerRaw = closes[i]-lowerMult*effAtr[i];
    const upperRaw = closes[i]+upperMult*effAtr[i];
    lowerBand[i] = i===0 ? lowerRaw : (closes[i-1]>lowerBand[i-1] ? Math.max(lowerRaw,lowerBand[i-1]) : lowerRaw);
    upperBand[i] = i===0 ? upperRaw : (closes[i-1]<upperBand[i-1] ? Math.min(upperRaw,upperBand[i-1]) : upperRaw);

    const priceFlipUp = i>0 && prevTrend===-1 && closes[i]>upperBand[i-1];
    const priceFlipDown = i>0 && prevTrend===1 && closes[i]<lowerBand[i-1];
    const trendAge = i-trendStartBar;
    const prevTqi = i===0?0.5:tqi[i-1];
    // Character-flip: trend-quality collapse (prevTqi high -> tqi low) after the trend has
    // matured (trendAge>=5). In the original Pine script this was additionally gated by
    // close</>source, which is always false when source==close (as it is in this port) —
    // that made the toggle a no-op. Here we implement the intended behaviour directly:
    // a genuine quality-collapse reverses the trend even before price breaks the ST band.
    const charFlipCond = cfg.useCharFlip && prevTqi>0.55 && tqi[i]<0.25 && trendAge>=5;
    const charFlipDown = charFlipCond && prevTrend===1;
    const charFlipUp = charFlipCond && prevTrend===-1;
    const finalUp = priceFlipUp||charFlipUp, finalDown = priceFlipDown||charFlipDown;
    stTrend[i] = i===0 ? 1 : (finalUp?1:(finalDown?-1:prevTrend));
    if(i>0 && stTrend[i]!==prevTrend) trendStartBar=i;
    stLine[i] = stTrend[i]===1?lowerBand[i]:upperBand[i];
  }

  // dynamic TP scale + score breakdown + trades
  // Risk:Reward diset fixed 1:2 — ketiga leg TP1/TP2/TP3 menyasar level R yang sama persis
  // (2R) sehingga rasio risk:reward keseluruhan trade tetap 1:2, bukan skala bertingkat 1R/2R/3R.
  const fixedTp=[2.0,2.0,2.0];
  const pivHigh = pivotHighArr(highs,3), pivLow = pivotLowArr(lows,3);
  let lastPivH=null, lastPivL=null;
  const pivHighHist=[], pivLowHist=[]; // {idx,val} — riwayat beberapa pivot terakhir, dipakai untuk pola double top/bottom & HL/LH

  /* ── candlestick reversal patterns (2-bar, dicek di bar sinyal & 1 bar sebelumnya) ── */
  function detectCandlePattern(i, isBuy){
    if(i<1) return null;
    const o=candles[i].open, c=candles[i].close, h=candles[i].high, l=candles[i].low;
    const po=candles[i-1].open, pc=candles[i-1].close;
    const body=Math.abs(c-o), range=Math.max(h-l,1e-9);
    const upperWick=h-Math.max(o,c), lowerWick=Math.min(o,c)-l;
    if(isBuy){
      if(pc<po && c>o && o<=pc && c>=po) return 'Bullish Engulfing';
      if(lowerWick>=body*2 && upperWick<=body*0.5 && body/range<0.4) return 'Hammer';
    } else {
      if(pc>po && c<o && o>=pc && c<=po) return 'Bearish Engulfing';
      if(upperWick>=body*2 && lowerWick<=body*0.5 && body/range<0.4) return 'Shooting Star';
    }
    return null;
  }

  /* ── chart-structure patterns dari riwayat pivot: double top/bottom (dua pivot
     berdekatan harganya, dipisah >=5 bar) atau higher-low/lower-high (konfirmasi
     kelanjutan trend) ── */
  function detectStructurePattern(i, isBuy){
    if(isBuy){
      if(pivLowHist.length>=2){
        const p1=pivLowHist[pivLowHist.length-2], p2=pivLowHist[pivLowHist.length-1];
        const tol = effAtr[i]*0.3;
        if(Math.abs(p1.val-p2.val)<=tol && (p2.idx-p1.idx)>=5) return 'Double Bottom';
        if(p2.val>p1.val) return 'Higher Low';
      }
    } else {
      if(pivHighHist.length>=2){
        const p1=pivHighHist[pivHighHist.length-2], p2=pivHighHist[pivHighHist.length-1];
        const tol = effAtr[i]*0.3;
        if(Math.abs(p1.val-p2.val)<=tol && (p2.idx-p1.idx)>=5) return 'Double Top';
        if(p2.val<p1.val) return 'Lower High';
      }
    }
    return null;
  }

  function scoreBreakdown(i,isBuy){
    const dirMove = isBuy ? closes[i-3]-closes[i] : closes[i]-closes[i-3];
    const momScore = mapClamp(safeDiv(dirMove,effAtr[i],0), 0.3,2.0, 0,17);
    const erScore = mapClamp(er[i],0.15,0.7,0,17);
    const vScore = hasVolume ? mapClamp(volZ[i],0,3,0,17) : CONST.BYPASS_SCORE;
    const lb = Math.max(0,i-structLen+1);
    const rsiWindow = rsiVals.slice(lb,i+1);
    const rsiDepth = isBuy ? Math.max(0, 30-Math.min(...rsiWindow)) : Math.max(0, Math.max(...rsiWindow)-70);
    const rsiScore = mapClamp(rsiDepth,0,15,0,17);
    const pivDist = isBuy && lastPivL!=null ? Math.abs(closes[i]-lastPivL) : (!isBuy && lastPivH!=null ? Math.abs(lastPivH-closes[i]) : 0);
    const structScore = mapClampInv(safeDiv(pivDist,effAtr[i],0),0,1.5,16,6);
    const breakDepth = isBuy ? Math.max(0, upperBand[i-1]-closes[i-1]) : Math.max(0, closes[i-1]-lowerBand[i-1]);
    const breakScore = mapClamp(safeDiv(breakDepth,effAtr[i],0),0,1.0,0,16);
    // Chart pattern confluence: candle pattern di bar sinyal (atau 1 bar sebelumnya, untuk
    // menangkap reversal candle yang mendahului flip) + pola struktur dari riwayat pivot.
    // Ini menambah bukti independen di luar indikator numerik (ER/RSI/momentum) di atas,
    // sehingga sinyal yang punya pola pendukung mendapat skor lebih tinggi/lebih akurat.
    const patternNames = [];
    const candlePat = detectCandlePattern(i,isBuy) || detectCandlePattern(i-1,isBuy);
    const structPat = detectStructurePattern(i,isBuy);
    if(candlePat) patternNames.push(candlePat);
    if(structPat) patternNames.push(structPat);
    const patternScore = clamp(patternNames.reduce((sum,name)=> sum+(CONST.PATTERN_WEIGHTS[name]||0), 0), 0, CONST.MAX_PATTERN_SCORE);

    return {momScore,erScore,vScore,rsiScore,structScore,breakScore,patternScore,patternNames,
      total: momScore+erScore+vScore+rsiScore+structScore+breakScore+patternScore};
  }

  /* Simulasi SEDERHANA satu-target (SL vs TP1 saja, bukan 3-leg penuh seperti trade
     sungguhan) untuk sinyal yang TIDAK dieksekusi karena gagal lolos ambang — dipakai
     murni sebagai umpan balik ke self-learning (lihat computeAdaptiveThreshold &
     syncPersistedSkipped): kalau sinyal yang ditolak ternyata rata-rata profitable,
     berarti ambang kelewat ketat. Mengembalikan +1/-1 kalau resolve di dalam jendela
     candle yang sedang di-fetch, atau null kalau belum resolve (belum kena salah satu
     dalam sisa data yang ada) — hasil null TIDAK disimpan permanen (lihat syncPersistedSkipped). */
  function simulateHypotheticalOutcome(i, isBuy, sl, tp1){
    for(let k=i+1;k<n;k++){
      if(isBuy){
        if(lows[k]<=sl) return -1;
        if(highs[k]>=tp1) return 1;
      } else {
        if(highs[k]>=sl) return -1;
        if(lows[k]<=tp1) return 1;
      }
    }
    return null;
  }

  const signals=[];
  // Sinyal yang trend-flip-nya valid & lolos filter EMA, TAPI skornya di bawah
  // entryThreshold self-learning — dicatat terpisah murni untuk transparansi
  // ("terdeteksi tapi tidak dieksekusi"), tidak ikut siklus hidup trade (SL/TP/
  // realizedR) dan tidak memengaruhi statistik win-rate / riwayat tersimpan.
  // hypotheticalR (simulasi sederhana, lihat simulateHypotheticalOutcome) DIPAKAI
  // sebagai umpan balik ke ambang adaptif lewat persistedSkipped — lihat processAndRender.
  const skippedSignals=[];
  let tradeDir=0, tradeEntry=NaN, tradeSl=NaN, tradeTp=[NaN,NaN,NaN], tradeTpR=[NaN,NaN,NaN], hit=[false,false,false], entryBar=0, entryIdx=null;
  const rBuffer=[];
  // ── Validasi konfirmasi candlestick sebelum entry ───────────────────────
  // Syarat: begitu Trend Quality Index (flip trend + skor lolos ambang) memberi sinyal,
  // entry TIDAK langsung dieksekusi di bar sinyal itu sendiri. Engine menunggu SATU bar
  // berikutnya: kalau bar itu ditutup sebagai candle bullish (close>open) untuk sinyal BUY,
  // atau candle bearish (close<open) untuk sinyal SELL, barulah posisi dibuka (di harga close
  // bar konfirmasi tsb). Kalau bar berikutnya tidak sesuai arah (bearish/doji untuk BUY,
  // bullish/doji untuk SELL), sinyal itu dianggap tidak valid dan tidak diambil sama sekali.
  let pendingSignal = null; // {dir:1|-1, flipIdx, sb, tSl}
  function isBullishCandle(i){ return candles[i].close > candles[i].open; }
  function isBearishCandle(i){ return candles[i].close < candles[i].open; }
  let curWinStreak=0, curLossStreak=0, maxWinStreak=0, maxLossStreak=0, allCount=0, allSumR=0;

  for(let i=0;i<n;i++){
    if(pivHigh[i]!=null){ lastPivH=pivHigh[i]; pivHighHist.push({idx:i,val:pivHigh[i]}); }
    if(pivLow[i]!=null){ lastPivL=pivLow[i]; pivLowHist.push({idx:i,val:pivLow[i]}); }

    const flipUp = i>0 && stTrend[i]===1 && stTrend[i-1]===-1;
    const flipDown = i>0 && stTrend[i]===-1 && stTrend[i-1]===1;

    // dynamic TP scale
    let dynScale=1;
    if(cfg.tpMode==='Dynamic'){
      const scaleFromTqi = mapClamp(tqi[i],0,1,0.5,2.0);
      const scaleFromVol = mapClamp(volRatio[i],0.5,1.8,0.5,2.0);
      dynScale = clamp(0.6*scaleFromTqi+0.4*scaleFromVol, 0.5, 2.0);
    }
    const floor1=0.5;
    const floor2 = floor1*(fixedTp[1]/Math.max(fixedTp[0],0.01));
    const floor3 = floor1*(fixedTp[2]/Math.max(fixedTp[0],0.01));
    let eff = fixedTp.map((r,idx)=> cfg.tpMode==='Dynamic' ? clamp(r*dynScale, [floor1,floor2,floor3][idx], 8.0) : r);
    const sorted = [...eff].sort((a,b)=>a-b);
    const liveTpR = sorted;

    // Menutup trade yang sedang OPEN dan mencatat realized-R-nya. Dipakai baik oleh
    // deteksi SL/TP/timeout normal (di bawah) MAUPUN saat trend flip memaksa reversal —
    // sebelum perbaikan ini, flip hanya menimpa tradeDir/entryIdx ke trade baru tanpa
    // pernah menutup sinyal lama, sehingga sinyal lama itu nyangkut selamanya di status
    // 'OPEN' walau harga sudah lama menembus SL/TP-nya. Itulah sebabnya riwayat sinyal
    // sebelumnya (hampir) selalu tampil OPEN dan tidak pernah closing.
    function closeCurrentTrade(exitIdx, statusLabel){
      const sig = signals[entryIdx];
      const useBe = cfg.useBreakeven && hit[0];
      const beExit = statusLabel==='SL' && useBe;
      const missedLegValue = beExit ? 0 : -1;
      let legs=[hit[0]?tradeTpR[0]:missedLegValue, hit[1]?tradeTpR[1]:missedLegValue, hit[2]?tradeTpR[2]:missedLegValue];
      if(statusLabel==='TIMEOUT' || statusLabel==='FLIP'){
        // Belum kena SL/TP3 penuh — pakai R belum-terealisasi di harga saat ini untuk leg yang belum hit.
        const unreal = tradeDir===1 ? (closes[exitIdx]-tradeEntry)/(tradeEntry-tradeSl) : (tradeEntry-closes[exitIdx])/(tradeSl-tradeEntry);
        legs = legs.map((v,idx)=> hit[idx] ? v : clamp(unreal,-1,tradeTpR[2]));
      }
      const realizedR = clamp(legs.reduce((a,b)=>a+b,0)/3, -1, tradeTpR[2]);
      sig.realizedR = realizedR;
      sig.status = beExit ? 'BE' : statusLabel;
      rBuffer.push(realizedR);
      if(rBuffer.length>CONST.MAX_HISTORY_SIGS) rBuffer.shift();
      allCount++; allSumR+=realizedR; // all-time totals, kept separate from the 100-trade window
      if(realizedR>0){ curWinStreak++; curLossStreak=0; maxWinStreak=Math.max(maxWinStreak,curWinStreak); }
      else { curLossStreak++; curWinStreak=0; maxLossStreak=Math.max(maxLossStreak,curLossStreak); }
      tradeDir=0; entryIdx=null;
    }

    // Membuka posisi baru. entryIdxBar = bar tempat entry benar-benar dieksekusi (harga
    // closes[entryIdxBar] dipakai sebagai harga entry — kalau konfirmasi candle aktif, ini
    // adalah bar KONFIRMASI, satu bar setelah bar flip sinyal sigBar). SL yang dipakai tetap
    // SL yang dihitung dari struktur pivot/ATR pada bar sinyal asal (tSl), supaya level stop
    // tidak "mengikuti" pergerakan harga selama menunggu konfirmasi.
    function openTrade(dir, entryIdxBar, sb, tSl, sigBar){
      const entryPrice = closes[entryIdxBar];
      const risk = dir===1 ? entryPrice-tSl : tSl-entryPrice;
      tradeDir=dir; tradeEntry=entryPrice; tradeSl=tSl;
      tradeTp = dir===1
        ? [entryPrice+risk*liveTpR[0], entryPrice+risk*liveTpR[1], entryPrice+risk*liveTpR[2]]
        : [entryPrice-risk*liveTpR[0], entryPrice-risk*liveTpR[1], entryPrice-risk*liveTpR[2]];
      tradeTpR=[...liveTpR]; hit=[false,false,false]; entryBar=entryIdxBar; entryIdx=signals.length;
      signals.push({i:entryIdxBar, time:candles[entryIdxBar].time, side:dir===1?'BUY':'SELL', price:entryPrice, score:sb.total, tqi:tqi[sigBar],
        sl:tSl, tp1:tradeTp[0], tp2:tradeTp[1], tp3:tradeTp[2], tpR:[...tradeTpR], mode:cfg.tpMode,
        pattern: sb.patternNames.join(' + ') || null, patternScore: sb.patternScore,
        // ── Faktor tambahan untuk model Status Trend self-learning (lihat computeTrendWeights
        // & renderAll): true/false kalau faktornya searah/berlawanan dengan sisi trade ini,
        // null kalau faktornya tidak tersedia di bar ini.
        structAligned: structDirArr[sigBar]==null ? null : structDirArr[sigBar]===dir,
        momAligned: momDirArr[sigBar]==null ? null : momDirArr[sigBar]===dir,
        tqiErAtEntry: tqiEr[sigBar], tqiVolAtEntry: tqiVol[sigBar],
        status:'OPEN', hit:[false,false,false], realizedR:null, valid:true,
        confirmedAt: entryIdxBar!==sigBar ? candles[entryIdxBar].time : null});
    }

    // ── Resolusi sinyal yang masih menunggu konfirmasi candlestick dari bar sebelumnya ──
    // Syarat entry: sinyal BUY baru dieksekusi kalau bar TEPAT setelah bar sinyal ditutup
    // sebagai candle bullish (close>open); sinyal SELL baru dieksekusi kalau bar berikutnya
    // ditutup sebagai candle bearish (close<open). Kalau tidak sesuai (termasuk doji), sinyal
    // dibatalkan sepenuhnya — tidak menunggu bar-bar selanjutnya.
    if(pendingSignal && i===pendingSignal.flipIdx+1){
      const dir = pendingSignal.dir;
      const confirmed = dir===1 ? isBullishCandle(i) : isBearishCandle(i);
      const trendStillAligned = stTrend[i]===dir;
      if(confirmed && trendStillAligned && (dir===1 ? tradeDir<=0 : tradeDir>=0)){
        openTrade(dir, i, pendingSignal.sb, pendingSignal.tSl, pendingSignal.flipIdx);
      } else {
        skippedSignals.push({i:pendingSignal.flipIdx, time:candles[pendingSignal.flipIdx].time, side:dir===1?'BUY':'SELL',
          price:closes[pendingSignal.flipIdx], score:pendingSignal.sb.total, tqi:tqi[pendingSignal.flipIdx],
          pattern: pendingSignal.sb.patternNames.join(' + ') || null, status:'SKIPPED', valid:false,
          hypotheticalR:null, reason:'NO_CONFIRMATION'});
      }
      pendingSignal = null;
    }

    if(i>=3 && flipUp && tradeDir<=0){
      // Trend baru saja flip naik. Kalau masih ada posisi SELL terbuka dari trend
      // sebelumnya, tutup dulu sebagai reversal-exit — ini terjadi TERLEPAS dari
      // apakah entry BUY baru lolos ambang self-learning atau tidak.
      if(tradeDir!==0 && i>entryBar) closeCurrentTrade(i, 'FLIP');
      // Trend sudah berbalik naik lagi sebelum sinyal SELL sebelumnya sempat terkonfirmasi
      // candle-nya sendiri — sinyal SELL lama itu otomatis batal (sudah tidak relevan).
      if(pendingSignal && pendingSignal.dir===-1) pendingSignal=null;
      {
        const sb = scoreBreakdown(i,true);
        // SL dihitung terlepas dari lolos-tidaknya ambang, supaya sinyal yang ditolak pun
        // bisa disimulasikan hipotetis (lihat cabang else) dengan SL yang sama persis
        // seandainya dieksekusi — bukan angka yang direka ulang secara terpisah.
        const slBase = lastPivL!=null ? lastPivL : lows[i];
        const rawSl = slBase - cfg.slMult*effAtr[i];
        const minSl = closes[i]-cfg.slMult*effAtr[i];
        const tSl = Math.min(rawSl,minSl);
        const risk = closes[i]-tSl;
        if(sb.total >= entryThreshold.score){
          if(cfg.useCandleConfirm){
            // Jangan entry sekarang — tunggu candle berikutnya tutup bullish sebagai konfirmasi.
            pendingSignal = {dir:1, flipIdx:i, sb, tSl};
          } else {
            openTrade(1, i, sb, tSl, i);
          }
        } else {
          const hypoTp1 = closes[i]+risk*liveTpR[0];
          const hypotheticalR = simulateHypotheticalOutcome(i,true,tSl,hypoTp1);
          skippedSignals.push({i, time:candles[i].time, side:'BUY', price:closes[i], score:sb.total, tqi:tqi[i],
            pattern: sb.patternNames.join(' + ') || null, status:'SKIPPED', valid:false, hypotheticalR});
        }
      }
    } else if(i>=3 && flipDown && tradeDir>=0){
      // Trend baru saja flip turun. Kalau masih ada posisi BUY terbuka dari trend
      // sebelumnya, tutup dulu sebagai reversal-exit — ini terjadi TERLEPAS dari
      // apakah entry SELL baru lolos ambang self-learning atau tidak.
      if(tradeDir!==0 && i>entryBar) closeCurrentTrade(i, 'FLIP');
      if(pendingSignal && pendingSignal.dir===1) pendingSignal=null;
      {
        const sb = scoreBreakdown(i,false);
        const slBase = lastPivH!=null ? lastPivH : highs[i];
        const rawSl = slBase + cfg.slMult*effAtr[i];
        const minSl = closes[i]+cfg.slMult*effAtr[i];
        const tSl = Math.max(rawSl,minSl);
        const risk = tSl-closes[i];
        if(sb.total >= entryThreshold.score){
          if(cfg.useCandleConfirm){
            // Jangan entry sekarang — tunggu candle berikutnya tutup bearish sebagai konfirmasi.
            pendingSignal = {dir:-1, flipIdx:i, sb, tSl};
          } else {
            openTrade(-1, i, sb, tSl, i);
          }
        } else {
          const hypoTp1 = closes[i]-risk*liveTpR[0];
          const hypotheticalR = simulateHypotheticalOutcome(i,false,tSl,hypoTp1);
          skippedSignals.push({i, time:candles[i].time, side:'SELL', price:closes[i], score:sb.total, tqi:tqi[i],
            pattern: sb.patternNames.join(' + ') || null, status:'SKIPPED', valid:false, hypotheticalR});
        }
      }
    }

    // hit detection for the currently open trade
    if(tradeDir!==0 && i>entryBar){
      const sig = signals[entryIdx];
      const tp1r = tradeDir===1?highs[i]>=tradeTp[0]:lows[i]<=tradeTp[0];
      const tp2r = tradeDir===1?highs[i]>=tradeTp[1]:lows[i]<=tradeTp[1];
      const tp3r = tradeDir===1?highs[i]>=tradeTp[2]:lows[i]<=tradeTp[2];
      // Optional breakeven-stop: once TP1 has been hit, move the stop for the remaining
      // position to entry (0R) instead of leaving it at the original stop. Without this,
      // realized-R for a TP1-then-reversal trade always books the full -1R on the untouched
      // legs, which is more pessimistic than how most traders actually manage the position.
      const useBe = cfg.useBreakeven && hit[0];
      const effectiveSl = useBe ? tradeEntry : tradeSl;
      const slHit = tradeDir===1?lows[i]<=effectiveSl:highs[i]>=effectiveSl;
      const age = i-entryBar, timeoutHit = age>=100;
      if(tp1r && !hit[0]){ hit[0]=true; sig.hit[0]=true; }
      if(tp2r && !hit[1]){ hit[1]=true; sig.hit[1]=true; }
      if(tp3r && !hit[2]){ hit[2]=true; sig.hit[2]=true; }
      if(tp3r || slHit || timeoutHit){
        closeCurrentTrade(i, slHit ? 'SL' : (tp3r ? 'TP3' : 'TIMEOUT'));
      }
    }
  }

  const last = n-1;
  // (maxScoreRef & entryThreshold sudah dihitung di awal fungsi, sebelum loop bar,
  // supaya bisa dipakai menggerbang entry — lihat komentar di dekat deklarasinya.)
  // Pola chart/candlestick untuk bar terakhir, searah trend saat ini — ditampilkan live di
  // kartu Status Trend sebagai confluence tambahan, terlepas dari apakah bar ini memicu
  // sinyal entry baru atau tidak (mis. trend sudah berjalan tapi baru saja muncul pola
  // pendukung seperti higher-low, yang memperkuat keyakinan pada trend yang sedang aktif).
  /* ═══════════════════════════════════════════════════════════
     STATUS TREND — MODEL SELF-LEARNING (menggantikan logic lama yang cuma
     mengikuti arah flip SuperTrend)
     ─────────────────────────────────────────────────────────
     Arah BULLISH/BEARISH kartu "Status Trend" sekarang TIDAK lagi diambil
     langsung dari stTrend (itu tetap dipakai terpisah oleh engine entry/SL/TP,
     tidak diubah — lihat komentar di computeEngine). Sebagai gantinya, arah
     dihitung dari GABUNGAN 2 faktor yang bias-arahnya berdiri sendiri (posisi
     struktur harga dlm range & momentum jendela terkini), masing-masing dikali
     BOBOT yang dipelajari dari histori trade tersimpan (lihat computeTrendWeights
     — structWeight/momWeight, berasal dari data Trend Quality Index & realized-R).
     Begitu arah kandidat ini didapat, dipakai sebagai bias untuk mengevaluasi
     confluence Pola Chart/Candlestick — persis seperti sebelumnya, cuma biasnya
     sekarang ikut model self-learning, bukan ikut stTrend. */
  function trendVotes(i){
    const votes = [];
    if(structDirArr[i]) votes.push({ name:'struct', dir: structDirArr[i], weight: cfg.structWeight||1 });
    if(momDirArr[i]) votes.push({ name:'mom', dir: momDirArr[i], weight: cfg.momWeight||1 });
    return votes;
  }
  function composeTrendStatus(i, fallbackDir){
    const votes = trendVotes(i);
    const score = votes.reduce((s,v)=>s+v.dir*v.weight,0);
    const maxScore = votes.reduce((s,v)=>s+v.weight,0);
    const bullDir = votes.length ? (score>=0 ? 1 : -1) : fallbackDir;
    // Confidence 0..1: proporsi bobot maksimum yang benar-benar mendukung arah yang
    // terpilih (voteConfidence), digabung dengan Trend Quality Index yang SUDAH
    // dievaluasi/dipelajari self-learning (tqiQuality).
    // tqiQuality menggabungkan 2 komponen TQI yang bobotnya dipelajari dari histori
    // trade tersimpan (tqiEffWeight utk Efficiency Ratio, tqiVolWeight utk Volatilitas —
    // lihat computeTrendWeights/weightForMagnitude), plus komponen struktur & momentum
    // TQI dengan bobot netral karena arahnya sudah diwakili votes di atas.
    const effW = cfg.tqiEffWeight||1, volW = cfg.tqiVolWeight||1;
    const tqiWSum = effW+volW+2;
    const tqiQuality = clamp((tqiEr[i]*effW + tqiVol[i]*volW + tqiStruct[i] + tqiMom[i]) / tqiWSum, 0, 1);
    const voteConfidence = maxScore>0 ? clamp(Math.abs(score)/maxScore,0,1) : 0.5;
    const confidence = clamp(0.6*voteConfidence + 0.4*tqiQuality, 0, 1);
    return { bullDir, votes, score, maxScore, tqiQuality, effW, volW, confidence };
  }
  const trendStatus = last>=0 ? composeTrendStatus(last, stTrend[last]) : null;
  const lastIsBuy = trendStatus ? trendStatus.bullDir===1 : (last>=0 && stTrend[last]===1);
  return {
    n, closes, highs, lows, hasVolume, maxScoreRef,
    tqi, tqiEr, tqiVol, tqiStruct, tqiMom, er, volRatio, rsiVals, structDirArr, momDirArr,
    stTrend, stLine, lowerBand, upperBand,
    trendStatus, // model self-learning lengkap (arah, votes, tqiQuality, confidence) — lihat renderAll()
    signals, skippedSignals, entryThreshold,
    openTrade: tradeDir!==0 ? {dir:tradeDir, entry:tradeEntry, sl:tradeSl, tp:tradeTp, tpR:tradeTpR, hit, mode:cfg.tpMode, sig:signals[entryIdx]} : null,
    // Sinyal yang trend-flip & skornya sudah valid di bar terakhir, tapi masih menunggu
    // bar berikutnya (yang belum terbentuk) untuk konfirmasi candlestick — dipakai kartu
    // Status Trend untuk menampilkan "Menunggu Konfirmasi" alih-alih diam-diam tidak ada apa-apa.
    pendingConfirmation: (pendingSignal && pendingSignal.flipIdx===n-1) ? {dir:pendingSignal.dir} : null,
    stats:{
      // windowed (last MAX_HISTORY_SIGS trades) — matches what's shown in Riwayat Sinyal / CSV
      count: rBuffer.length,
      sumR: rBuffer.reduce((a,b)=>a+b,0),
      winRate: rBuffer.length? rBuffer.filter(r=>r>0).length/rBuffer.length*100 : null,
      avgR: rBuffer.length? rBuffer.reduce((a,b)=>a+b,0)/rBuffer.length : null,
      // all-time (unbounded) — kept separately, not mixed into the windowed metrics above
      allTimeCount: allCount, allTimeSumR: allSumR,
      allTimeAvgR: allCount? allSumR/allCount : null,
      curWinStreak, curLossStreak, maxWinStreak, maxLossStreak},
    last,
  };
}

/* ═══════════════════════════════════════════════════════════
   DATA FETCH
   ═══════════════════════════════════════════════════════════ */
/* A candle row is only usable if OHLC are finite numbers, all positive,
   and high/low actually bound open & close. Volume is optional (defaults
   to 0 for pairs with no volume data) but must be a finite, non-negative
   number when present. Bad rows are dropped rather than silently turned
   into NaN, which would otherwise poison every downstream indicator
   (EMA/ATR/RSI/etc. all propagate NaN forward once it appears). */
function isValidCandleRow(c){
  if(!c || !c.time) return false;
  const ohlc = [c.open, c.high, c.low, c.close];
  if(ohlc.some(v => typeof v!=='number' || !isFinite(v) || v<=0)) return false;
  if(!isFinite(c.volume) || c.volume<0) return false; // already normalized to 0 by caller when unparsable
  if(c.high < c.low) return false;
  if(c.high < c.open || c.high < c.close) return false;
  if(c.low > c.open || c.low > c.close) return false;
  return true;
}

async function fetchCandlesRaw(symbol, interval, outputSize, apiKey){
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputSize}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const json = await res.json();
  if(json.status==='error' || json.code){
    const msg = json.message || 'API error';
    const err = new Error(msg);
    // Ditandai sebagai rate-limit hanya kalau memang soal limit/quota/HTTP 429 — error lain
    // (symbol salah, interval tidak didukung, dll) TIDAK ditandai, supaya fetchWithKeyRotation
    // di bawah tidak buang-buang percobaan pindah key untuk error yang tidak akan pernah
    // hilang dengan key manapun.
    err.isRateLimit = res.status===429 || json.code===429 || /credit|limit|too many request/i.test(msg);
    throw err;
  }
  if(!json.values) throw new Error('Format data tidak dikenal dari API.');
  const rawCount = json.values.length;
  const candles = json.values.map(v=>{
    const vol = parseFloat(v.volume||0);
    return { time: v.datetime, open:parseFloat(v.open), high:parseFloat(v.high), low:parseFloat(v.low),
      close:parseFloat(v.close), volume: isFinite(vol) ? vol : 0 };
  }).filter(isValidCandleRow).reverse();
  const dropped = rawCount - candles.length;
  if(dropped>0) console.warn(`fetchCandlesRaw(${symbol} ${interval}): ${dropped} baris tidak valid dari API dilewati (dari ${rawCount} total).`);
  if(candles.length===0) throw new Error('Semua data dari API tidak valid (OHLC kosong/rusak).');
  return candles;
}

/* ═══════════════════════════════════════════════════════════
   AUTO-SWITCH API KEY (pool bawaan + key pribadi opsional)
   ─────────────────────────────────────────────────────────
   Key pribadi (kalau diisi di ⚙ Pengaturan) selalu jadi kandidat PERTAMA, diikuti
   5 key bawaan (API_KEY_POOL). apiKeyIndex menunjuk key yang TERAKHIR TERBUKTI
   jalan, disimpan lintas sesi (localStorage) supaya reload berikutnya tidak
   mengulang dari key yang sudah diketahui kena limit. */
function getApiKeyPool(){
  const custom = (state.apiKey||'').trim();
  const pool = API_KEY_POOL.slice();
  if(custom && !pool.includes(custom)) pool.unshift(custom);
  return pool;
}
const LS_KEY_INDEX = 'gusera_sats_api_key_index';
function loadApiKeyIndex(){
  let v = 0;
  try{ v = parseInt(localStorage.getItem(LS_KEY_INDEX),10); }catch(e){}
  state.apiKeyIndex = (isFinite(v) && v>=0) ? v : 0;
}
function saveApiKeyIndex(){
  try{ localStorage.setItem(LS_KEY_INDEX, String(state.apiKeyIndex)); }catch(e){}
}

/* Mencoba tiap key di pool secara berurutan, mulai dari apiKeyIndex terakhir yang
   terbukti jalan. HANYA pindah ke key berikutnya kalau errornya isRateLimit===true
   (limit/quota) — error lain langsung dilempar apa adanya (mengganti key tidak akan
   memperbaiki symbol salah atau format tidak dikenal, jadi tidak perlu 5x percobaan
   yang sama-sama pasti gagal). Kalau SEMUA key di pool kena limit, error terakhir
   dilempar dengan pesan gabungan yang jelas. */
async function fetchWithKeyRotation(fetchFn){
  const pool = getApiKeyPool();
  let idx = clamp(state.apiKeyIndex, 0, pool.length-1);
  let lastErr = null;
  for(let attempt=0; attempt<pool.length; attempt++){
    try{
      const result = await fetchFn(pool[idx]);
      if(state.apiKeyIndex !== idx){ state.apiKeyIndex = idx; saveApiKeyIndex(); }
      state.apiKeyPoolSize = pool.length; // dipakai UI untuk menampilkan "N/M"
      return result;
    }catch(e){
      lastErr = e;
      if(!e.isRateLimit) throw e;
      idx = (idx+1) % pool.length;
    }
  }
  state.apiKeyIndex = idx; saveApiKeyIndex();
  state.apiKeyPoolSize = pool.length;
  const err = new Error(`Semua ${pool.length} API key kena limit/quota. Coba lagi nanti, isi key pribadi Anda sendiri, atau pakai Mode CSV. (Pesan terakhir: ${lastErr?lastErr.message:'-'})`);
  err.allKeysExhausted = true;
  throw err;
}

async function fetchCandles(){
  return fetchWithKeyRotation(key => fetchCandlesRaw(state.symbol, state.interval, state.outputSize, key));
}
function parseCsv(text){
  const lines = text.trim().split('\n').map(l=>l.trim()).filter(Boolean);
  const candles = [];
  const badLines = [];
  lines.forEach((line, idx)=>{
    const parts = line.split(',').map(s=>s.trim());
    if(parts.length<5){ badLines.push(idx+1); return; }
    const [time,open,high,low,close,volume] = parts;
    const volParsed = parseFloat(volume||0);
    const c = {time, open:parseFloat(open), high:parseFloat(high), low:parseFloat(low), close:parseFloat(close), volume: isFinite(volParsed) ? volParsed : 0};
    if(isValidCandleRow(c)) candles.push(c); else badLines.push(idx+1);
  });
  if(candles.length===0){
    throw new Error('Tidak ada baris valid. Cek format: time,open,high,low,close,volume — dan pastikan OHLC berupa angka positif dengan high ≥ open/close ≥ low.');
  }
  if(badLines.length>0){
    const shown = badLines.slice(0,10).join(', ') + (badLines.length>10 ? `, +${badLines.length-10} lagi` : '');
    console.warn(`parseCsv: ${badLines.length} baris dilewati (baris ke-${shown}).`);
  }
  return { candles, skipped: badLines.length, skippedLines: badLines };
}



/* ═══════════════════════════════════════════════════════════
   RENDER
   ═══════════════════════════════════════════════════════════ */
function setStatus(msg, kind){
  const el = document.getElementById('statusMsg');
  if(!msg){ el.className='statusMsg'; return; }
  el.textContent = msg; el.className = 'statusMsg show '+(kind||'');
}
function setModalStatus(msg, kind){
  const el = document.getElementById('modalStatus');
  if(!msg){ el.className='statusMsg'; return; }
  el.textContent = msg; el.className='statusMsg show '+(kind||'');
}
function setConn(kind, text){
  const dot = document.getElementById('connDot');
  dot.className = 'dot '+(kind||'');
  document.getElementById('connText').textContent = text;
  const engineTag = document.getElementById('engineTag');
  if(engineTag){
    if(kind==='live'){
      engineTag.textContent = 'Aktif · Algoritma Terhubung';
      engineTag.className = 'trendTag bull';
      engineTag.style.background=''; engineTag.style.color=''; engineTag.style.border='';
    } else if(kind==='err'){
      engineTag.textContent = 'Gangguan Koneksi';
      engineTag.className = 'trendTag bear';
      engineTag.style.background=''; engineTag.style.color=''; engineTag.style.border='';
    } else if(text==='Offline'){
      engineTag.textContent = '—';
      engineTag.className = 'trendTag';
      engineTag.style.background = '#1c2027'; engineTag.style.color = 'var(--text-dim)'; engineTag.style.border = '1px solid var(--border)';
    } else {
      engineTag.textContent = 'Sinkronisasi…';
      engineTag.className = 'trendTag';
      engineTag.style.background=''; engineTag.style.color=''; engineTag.style.border='';
    }
  }
}

function fmtPrice(v){ return isFinite(v) ? v.toFixed(2) : '—'; }

function drawGauge(tqi){
  const cv = document.getElementById('gaugeCanvas');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio||1;
  const cssSize = cv.clientWidth || 170;
  cv.width = cssSize*dpr; cv.height = cssSize*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=cssSize, h=cssSize, cx=w/2, cy=h/2, r=w/2-14;
  ctx.clearRect(0,0,w,h);
  const start=Math.PI*0.75, end=Math.PI*2.25;
  ctx.lineWidth=14; ctx.lineCap='round';
  ctx.strokeStyle='#1a1f28';
  ctx.beginPath(); ctx.arc(cx,cy,r,start,end); ctx.stroke();
  if(tqi!=null){
    const val = clamp(tqi,0,1);
    const lg = ctx.createLinearGradient(0,h,w,0);
    lg.addColorStop(0,'#FF5C7A'); lg.addColorStop(.35,'#FF8A4C'); lg.addColorStop(.65,'#FFB648'); lg.addColorStop(1,'#2FE6B8');
    ctx.strokeStyle=lg;
    ctx.beginPath(); ctx.arc(cx,cy,r,start,start+(end-start)*val); ctx.stroke();
  }
}

function drawSparkline(candles){
  const wrap = document.getElementById('sparkWrap');
  const canvas = document.getElementById('sparkCanvas');
  if(!wrap || !canvas || !candles || !candles.length) return;
  const dpr = window.devicePixelRatio||1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if(W<=0 || H<=0) return;
  canvas.width = W*dpr; canvas.height = H*dpr;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);

  const N = Math.min(60, candles.length);
  const slice = candles.slice(candles.length-N);
  const closes = slice.map(c=>c.close);
  const lo = Math.min(...closes), hi = Math.max(...closes);
  const pad = (hi-lo)*0.1 || 1;
  const yLo = lo-pad, yHi = hi+pad;
  const marginTop=6, marginBottom=6;
  const x = i => (i/(N-1===0?1:N-1))*W;
  const y = v => marginTop + (1-(v-yLo)/(yHi-yLo))*(H-marginTop-marginBottom);

  const up = closes[closes.length-1] >= closes[0];
  const lineColor = up ? '#2FE6B8' : '#FF5C7A';

  // filled area
  const grad = ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0, up ? 'rgba(47,230,184,.35)' : 'rgba(255,92,122,.30)');
  grad.addColorStop(1, 'rgba(47,230,184,0)');
  ctx.beginPath();
  ctx.moveTo(x(0), y(closes[0]));
  closes.forEach((v,i)=> ctx.lineTo(x(i), y(v)));
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // line
  ctx.beginPath();
  closes.forEach((v,i)=>{ i===0 ? ctx.moveTo(x(i),y(v)) : ctx.lineTo(x(i),y(v)); });
  ctx.strokeStyle = lineColor; ctx.lineWidth = 2; ctx.lineJoin='round'; ctx.stroke();

  // dot at last point
  const lastX = x(closes.length-1), lastY = y(closes[closes.length-1]);
  ctx.beginPath(); ctx.arc(lastX,lastY,4,0,Math.PI*2);
  ctx.fillStyle = '#0d0f14'; ctx.fill();
  ctx.lineWidth=2; ctx.strokeStyle = lineColor; ctx.stroke();
}

function drawChart(res, candles){
  const canvas = document.getElementById('chartCanvas');
  const wrap = document.getElementById('chartWrap');
  if(wrap.clientWidth<=0 || wrap.clientHeight<=0) return; // tab currently hidden — skip, will redraw when shown
  const dpr = window.devicePixelRatio||1;
  canvas.width = wrap.clientWidth*dpr; canvas.height = wrap.clientHeight*dpr;
  canvas.style.width = wrap.clientWidth+'px'; canvas.style.height = wrap.clientHeight+'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr,dpr);
  const W = wrap.clientWidth, H = wrap.clientHeight;
  ctx.clearRect(0,0,W,H);

  const N = Math.min(140, candles.length);
  const startIdx = candles.length-N;
  const slice = candles.slice(startIdx);
  const stLineSlice = res.stLine.slice(startIdx);
  const stTrendSlice = res.stTrend.slice(startIdx);

  let lo=Infinity, hi=-Infinity;
  slice.forEach((c,idx)=>{
    lo=Math.min(lo,c.low,stLineSlice[idx]); hi=Math.max(hi,c.high,stLineSlice[idx]);
  });
  if(res.openTrade){ [res.openTrade.sl, ...res.openTrade.tp].forEach(v=>{ lo=Math.min(lo,v); hi=Math.max(hi,v); }); }
  const pad=(hi-lo)*0.08 || 1; lo-=pad; hi+=pad;

  const marginL=6, marginR=54, marginTop=8, marginBottom=20;
  const plotW = W-marginL-marginR, plotH = H-marginTop-marginBottom;
  const x = i => marginL + (i/(N-1===0?1:N-1))*plotW;
  const y = v => marginTop + (1-(v-lo)/(hi-lo))*plotH;

  // grid + axis labels
  ctx.strokeStyle = '#1a1e24'; ctx.fillStyle='#565C64'; ctx.font='10px IBM Plex Mono'; ctx.lineWidth=1;
  for(let g=0; g<=4; g++){
    const v = lo + (hi-lo)*g/4;
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(marginL,yy); ctx.lineTo(W-marginR,yy); ctx.stroke();
    ctx.fillText(v.toFixed(2), W-marginR+6, yy+3);
  }

  // candles
  const cw = Math.max(2, plotW/N*0.6);
  slice.forEach((c,i)=>{
    const xi = x(i);
    const up = c.close>=c.open;
    ctx.strokeStyle = up?'#2FD9C4':'#FF5C5C';
    ctx.fillStyle = up?'#2FD9C4':'#FF5C5C';
    ctx.beginPath(); ctx.moveTo(xi,y(c.high)); ctx.lineTo(xi,y(c.low)); ctx.stroke();
    const oy=y(c.open), cy2=y(c.close);
    ctx.fillRect(xi-cw/2, Math.min(oy,cy2), cw, Math.max(1,Math.abs(cy2-oy)));
  });

  // supertrend line, colored by trend + tqi brightness
  for(let i=1;i<slice.length;i++){
    const bull = stTrendSlice[i]===1;
    ctx.strokeStyle = bull ? '#2FD9C4' : '#FF5C5C';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(x(i-1), y(stLineSlice[i-1])); ctx.lineTo(x(i), y(stLineSlice[i])); ctx.stroke();
  }
  ctx.globalAlpha=1;

  // active trade levels
  if(res.openTrade){
    const ot = res.openTrade;
    const lines = [[ot.sl,'#FF1744','SL'], [ot.tp[0],'#00E676','TP1'], [ot.tp[1],'#00E676','TP2'], [ot.tp[2],'#00E676','TP3'], [ot.entry,'#8b9098','ENTRY']];
    lines.forEach(([v,color,label])=>{
      const yy=y(v);
      ctx.strokeStyle=color; ctx.setLineDash([4,3]); ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(marginL,yy); ctx.lineTo(W-marginR,yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=color; ctx.font='9px IBM Plex Mono';
      ctx.fillText(label, marginL+2, yy-2);
    });
  }

  // buy/sell markers
  res.signals.forEach(sig=>{
    if(sig.i<startIdx) return;
    const idx = sig.i-startIdx;
    const xi=x(idx);
    ctx.fillStyle = sig.side==='BUY' ? '#2FD9C4' : '#FF5C5C';
    ctx.beginPath();
    if(sig.side==='BUY'){ ctx.moveTo(xi-5,y(slice[idx].low)+14); ctx.lineTo(xi+5,y(slice[idx].low)+14); ctx.lineTo(xi,y(slice[idx].low)+4); }
    else{ ctx.moveTo(xi-5,y(slice[idx].high)-14); ctx.lineTo(xi+5,y(slice[idx].high)-14); ctx.lineTo(xi,y(slice[idx].high)-4); }
    ctx.closePath(); ctx.fill();
  });
}

function renderAll(res, candles){
  const last = res.last;
  const lastClose = res.closes[last];
  const prevClose = res.closes[last-1] ?? lastClose;
  const priceEl = document.getElementById('priceNow');
  priceEl.textContent = fmtPrice(lastClose);
  const priceUp = lastClose>=prevClose;
  priceEl.className = 'priceNow '+(priceUp?'up':'down');
  const delta = lastClose-prevClose;
  const deltaPct = prevClose ? (delta/prevClose*100) : 0;
  const changeEl = document.getElementById('priceChange');
  if(changeEl){
    changeEl.textContent = `${delta>=0?'+':''}${delta.toFixed(2)} (${delta>=0?'+':''}${deltaPct.toFixed(2)}%)`;
    changeEl.className = 'price-change '+(priceUp?'':'down');
  }
  document.getElementById('priceSub').textContent = `${state.symbol} · ${state.interval} · update ${new Date().toLocaleTimeString('id-ID')}`;
  drawSparkline(candles);

  const trendTag = document.getElementById('trendTag');
  // Arah Status Trend sekarang berasal dari model self-learning (res.trendStatus),
  // bukan langsung dari flip SuperTrend — lihat composeTrendStatus() di computeEngine.
  // SuperTrend (res.stTrend) tetap dipakai apa adanya oleh engine entry/SL/TP di kartu
  // Posisi Terbuka; kedua hal ini sengaja dipisah, jadi sesekali arahnya bisa berbeda
  // kalau self-learning menilai konfirmasi lain (struktur/momentum) lebih kuat.
  const bull = res.trendStatus ? res.trendStatus.bullDir===1 : res.stTrend[last]===1;
  trendTag.textContent = bull ? '▲ BULLISH' : '▼ BEARISH';
  trendTag.className = 'trendTag '+(bull?'bull':'bear');

  // ── Confidence Self-Learning (visible di kartu, bukan cuma tooltip) ──
  const slConfTag = document.getElementById('slConfTag');
  const slConfFill = document.getElementById('slConfFill');
  const slVotesMsg = document.getElementById('slVotesMsg');
  if(res.trendStatus){
    const ts = res.trendStatus;
    const pct = Math.round(clamp(ts.confidence,0,1)*100);
    if(slConfTag){
      slConfTag.textContent = pct+'%';
      slConfTag.className = 'trendTag '+(bull?'bull':'bear');
    }
    if(slConfFill){
      slConfFill.style.width = pct+'%';
      slConfFill.className = 'factor-fill '+(pct>=60?'fill-green':pct>=35?'fill-yellow':'fill-orange');
    }
    const nameMap = {struct:'Struktur Harga', mom:'Momentum'};
    const voteParts = ts.votes.map(v=>`${nameMap[v.name]||v.name} ${v.dir>0?'bullish':'bearish'} (${v.weight.toFixed(2)}×)`);
    const tqiPct = Math.round(clamp(ts.tqiQuality,0,1)*100);
    if(slVotesMsg){
      let msg = voteParts.length ? `Voting self-learning: ${voteParts.join(', ')}.` : 'Belum cukup faktor untuk voting arah pada bar ini.';
      msg += ` Dikonfirmasi oleh Trend Quality Index self-learning (${tqiPct}%).`;
      slVotesMsg.textContent = msg;
      slVotesMsg.className = 'statusMsg show';
    }
    const voteTxt = ts.votes.map(v=>`${v.name}:${v.dir>0?'+':''}${(v.dir*v.weight).toFixed(2)}`).join(' · ');
    trendTag.title = `Self-learning confidence ${pct}% (skor arah ${ts.score.toFixed(2)}/${ts.maxScore.toFixed(2)})${voteTxt?' — '+voteTxt:''}`;
  } else {
    if(slConfTag){ slConfTag.textContent='—'; slConfTag.className='trendTag'; }
    if(slConfFill){ slConfFill.style.width='0%'; slConfFill.className='factor-fill fill-green'; }
    if(slVotesMsg){ slVotesMsg.textContent=''; slVotesMsg.className='statusMsg'; }
  }

  // ── Trend Quality Index (Self-Learning) ──
  // Nilainya (trendStatus.tqiQuality) adalah Trend Quality Index yang
  // sudah dievaluasi/dipelajari self-learning — komponen Efficiency Ratio & Volatilitas
  // dibobot pakai tqiEffWeight/tqiVolWeight hasil belajar dari realized-R histori trade
  // tersimpan (lihat computeTrendWeights/weightForMagnitude), jadi angkanya sudah
  // dioptimalkan untuk pair+timeframe yang sedang aktif, bukan angka rule tetap.
  const tqiSlTag = document.getElementById('tqiSlTag');
  const tqiSlFill = document.getElementById('tqiSlFill');
  const tqiSlMsg = document.getElementById('tqiSlMsg');
  if(res.trendStatus){
    const ts = res.trendStatus;
    const q = Math.round(clamp(ts.tqiQuality,0,1)*100);
    const qualityLabel = q>=60 ? 'Trend Kuat' : q>=35 ? 'Netral' : 'Kurang Jelas';
    if(tqiSlTag){
      tqiSlTag.textContent = q+'% · '+qualityLabel;
      tqiSlTag.className = 'trendTag '+(bull?'bull':'bear');
    }
    if(tqiSlFill){
      tqiSlFill.style.width = q+'%';
      tqiSlFill.className = 'factor-fill '+(q>=60?'fill-green':q>=35?'fill-yellow':'fill-orange');
    }
    const cwTqi = res.confluenceWeights;
    const effLabel = cwTqi && cwTqi.tqiEff && cwTqi.tqiEff.learned
      ? `Efisiensi Trend ${ts.effW.toFixed(2)}× (dipelajari dari ${cwTqi.tqiEff.sample} trade)`
      : 'Efisiensi Trend 1.00× (default, belum cukup sampel)';
    const volLabel = cwTqi && cwTqi.tqiVol && cwTqi.tqiVol.learned
      ? `Volatilitas ${ts.volW.toFixed(2)}× (dipelajari dari ${cwTqi.tqiVol.sample} trade)`
      : 'Volatilitas 1.00× (default, belum cukup sampel)';
    if(tqiSlMsg){
      tqiSlMsg.textContent = `Trend Quality Index tervalidasi self-learning: ${effLabel}, ${volLabel}.`;
      tqiSlMsg.className = 'statusMsg show';
    }
    tqiSlTag.title = `tqiQuality ${q}% — dari Efficiency Ratio, Volatilitas, Struktur & Momentum TQI (bobot ER/Vol dipelajari dari histori trade)`;
  } else {
    if(tqiSlTag){ tqiSlTag.textContent='—'; tqiSlTag.className='trendTag'; }
    if(tqiSlFill){ tqiSlFill.style.width='0%'; tqiSlFill.className='factor-fill fill-green'; }
    if(tqiSlMsg){ tqiSlMsg.textContent=''; tqiSlMsg.className='statusMsg'; }
  }

  // ── Konfirmasi Candlestick sebelum entry ──
  const confirmTag = document.getElementById('confirmTag');
  if(confirmTag){
    if(!state.useCandleConfirm){
      confirmTag.textContent = 'Nonaktif'; confirmTag.className = 'trendTag';
      confirmTag.style.background = '#1c2027'; confirmTag.style.color = 'var(--text-dim)'; confirmTag.style.border = '1px solid var(--border)';
    } else if(res.pendingConfirmation){
      const dirTxt = res.pendingConfirmation.dir===1 ? 'BUY' : 'SELL';
      const needTxt = res.pendingConfirmation.dir===1 ? 'candle bullish' : 'candle bearish';
      confirmTag.textContent = `Menunggu ${needTxt} untuk ${dirTxt}`;
      confirmTag.className = 'trendTag';
      confirmTag.style.background = ''; confirmTag.style.color = '#C89B3C'; confirmTag.style.border = '1px solid #C89B3C';
    } else {
      confirmTag.textContent = 'Tidak Ada Sinyal Menunggu';
      confirmTag.className = 'trendTag';
      confirmTag.style.background = '#1c2027'; confirmTag.style.color = 'var(--text-dim)'; confirmTag.style.border = '1px solid var(--border)';
    }
  }

  // gauge
  const tqiNow = res.tqi[last];
  document.getElementById('tqiVal').textContent = Math.round(clamp(tqiNow,0,1)*100);
  const tqiRegimeText = tqiNow>0.6?'Trend Kuat':tqiNow>0.35?'Netral':'Kurang Jelas';
  document.getElementById('tqiRegime').textContent = tqiRegimeText;
  drawGauge(tqiNow);
  const factors = [['fEr','fErV',res.tqiEr[last]],['fVol','fVolV',res.tqiVol[last]],['fStruct','fStructV',res.tqiStruct[last]],['fMom','fMomV',res.tqiMom[last]]];
  factors.forEach(([barId,valId,v])=>{
    document.getElementById(barId).style.width = (clamp(v,0,1)*100).toFixed(0)+'%';
    document.getElementById(valId).textContent = Math.round(clamp(v,0,1)*100)+'/100';
  });
  const tqiDescEl = document.getElementById('tqiDesc');
  if(tqiDescEl){
    if(tqiRegimeText==='Trend Kuat'){
      tqiDescEl.textContent = `Trend kuat dengan struktur harga yang solid dan momentum yang jelas.`;
    } else if(tqiRegimeText==='Netral'){
      tqiDescEl.textContent = `Trend cukup kuat dengan konfirmasi dari struktur harga dan momentum.`;
    } else {
      tqiDescEl.textContent = `Kondisi pasar konsolidasi; momentum dan struktur belum cukup jelas untuk entry.`;
    }
  }

  // trade card
  const ot = res.openTrade;
  const posStatus = document.getElementById('posStatus');
  if(ot){
    posStatus.textContent = ot.dir===1?'BUY':'SELL';
    posStatus.className = 'statusPill '+(ot.dir===1?'buy':'sell');
    document.getElementById('tEntry').textContent = fmtPrice(ot.entry);
    document.getElementById('tSl').textContent = fmtPrice(ot.sl);
    document.getElementById('tTp1').textContent = fmtPrice(ot.tp[0]);
    document.getElementById('tTp2').textContent = fmtPrice(ot.tp[1]);
    document.getElementById('tTp3').textContent = fmtPrice(ot.tp[2]);
    document.getElementById('tTp1').className = 'v'+(ot.hit[0]?' hit':'');
    document.getElementById('tTp2').className = 'v'+(ot.hit[1]?' hit':'');
    document.getElementById('tTp3').className = 'v'+(ot.hit[2]?' hit':'');
    document.getElementById('tMode').textContent = ot.mode;
    const scoreVal = ot.sig ? ot.sig.score : null;
    document.getElementById('tScore').textContent = scoreVal!=null ? scoreVal.toFixed(1) : '—';
    document.getElementById('tScoreMax').textContent = scoreVal!=null ? '/'+res.maxScoreRef : '';
    document.getElementById('tScoreFill').style.width = scoreVal!=null ? (clamp(scoreVal/res.maxScoreRef,0,1)*100).toFixed(0)+'%' : '0%';
  } else {
    posStatus.textContent='FLAT'; posStatus.className='statusPill flat';
    ['tEntry','tSl','tTp1','tTp2','tTp3','tMode'].forEach(id=>{ document.getElementById(id).textContent='—'; });
    ['tTp1','tTp2','tTp3'].forEach(id=>{ document.getElementById(id).className='v'; });
    document.getElementById('tScore').textContent='—';
    document.getElementById('tScoreMax').textContent='';
    document.getElementById('tScoreFill').style.width='0%';
  }

  // stats
  const st = res.stats;
  // Win rate & Avg R both use the same windowed sample (last MAX_HISTORY_SIGS trades) as
  // the Riwayat Sinyal table/CSV, so the numerator/denominator always agree.
  document.getElementById('sWinRate').textContent = st.winRate!=null ? st.winRate.toFixed(0)+'%' : '—';
  document.getElementById('sWinRate').className = 'v '+(st.winRate>50?'pos':st.winRate!=null&&st.winRate<=50?'neg':'');
  document.getElementById('sWinRate').title = `Berdasarkan ${st.count} trade terakhir (maks ${CONST.MAX_HISTORY_SIGS}). All-time: ${st.allTimeCount} trade.`;
  document.getElementById('sAvgR').textContent = st.avgR!=null ? st.avgR.toFixed(2)+'R' : '—';
  document.getElementById('sAvgR').className = 'v '+(st.avgR>0?'pos':st.avgR!=null&&st.avgR<=0?'neg':'');
  document.getElementById('sAvgR').title = st.allTimeAvgR!=null ? `All-time avg R (${st.allTimeCount} trade): ${st.allTimeAvgR.toFixed(2)}R` : '';
  document.getElementById('sCount').textContent = st.count;
  document.getElementById('sCount').title = `Jendela statistik: ${st.count} trade terakhir · All-time: ${st.allTimeCount} trade`;
  document.getElementById('sStreak').textContent = st.curWinStreak>0 ? st.curWinStreak+'W' : (st.curLossStreak>0? st.curLossStreak+'L':'—');
  document.getElementById('sStreak').title = `Rekor: ${st.maxWinStreak}W beruntun / ${st.maxLossStreak}L beruntun`;

  // persisted win rate — cross-session, khusus pair+timeframe aktif (bukan jendela candle sekarang)
  // winRate/avgR sudah recency-weighted (trade terbaru lebih berpengaruh — lihat weightedTradeStats)
  const pStats = getPersistedStats(30);
  document.getElementById('sPersistedWR').textContent = pStats.winRate!=null ? pStats.winRate.toFixed(0)+'%' : '—';
  document.getElementById('sPersistedWR').className = 'v '+(pStats.winRate>50?'pos':pStats.winRate!=null&&pStats.winRate<=50?'neg':'');
  document.getElementById('sPersistedWR').title = `${pStats.windowCount} trade tersimpan terakhir (dari total ${pStats.total} tersimpan) untuk ${state.symbol} ${state.interval}, dibobot recency (trade terbaru lebih berpengaruh).`;

  // ambang skor adaptif yang sedang aktif cycle ini
  const th = state.currentThreshold;
  if(th){
    document.getElementById('sThreshold').textContent = th.score.toFixed(0)+'/'+res.maxScoreRef;
    document.getElementById('sThreshold').title = th.reason;
  }

  // sinyal terlewat (skipped) — hasil simulasi hipotetis satu-target (SL vs TP1), dipakai
  // sebagai umpan balik ke ambang adaptif di atas (lihat computeAdaptiveThreshold). Kalau
  // Avg-R Terlewat positif & jumlahnya cukup, artinya ambang sempat kelewat ketat.
  const skStats = getSkippedStats(50);
  document.getElementById('sSkippedCount').textContent = skStats.windowCount || '—';
  document.getElementById('sSkippedCount').title = `${skStats.total} sinyal terlewat tersimpan (semua sudah resolve) untuk ${state.symbol} ${state.interval}.`;
  document.getElementById('sSkippedAvgR').textContent = skStats.avgR!=null ? (skStats.avgR>=0?'+':'')+skStats.avgR.toFixed(2)+'R' : '—';
  document.getElementById('sSkippedAvgR').className = 'v '+(skStats.avgR>0?'pos':skStats.avgR!=null&&skStats.avgR<=0?'neg':'');
  document.getElementById('sSkippedAvgR').title = 'Simulasi sederhana satu-target (SL vs TP1) seandainya sinyal yang ditolak ambang tetap dieksekusi — bukan simulasi 3-leg penuh seperti trade sungguhan.';

  // log
  renderLog(res);
  drawChart(res, candles);

  // AI insight card (lightweight heuristic read of trend/momentum/volatility)
  updateAIInsightCard(res, candles);

  // Profil: ringkasan performa & preferensi aktif
  updateProfilePanel(res);
}

function updateAIInsightCard(res, candles){
  const last = res.last;
  const atrArr = rma(trueRangeArr(candles), 14);
  const atrOk = isFinite(atrArr[last]) && candles.length>1;
  if(!atrOk){
    document.getElementById('aiConfidence').textContent = '—';
    document.getElementById('aiConfidenceFill').style.width = '0%';
    document.getElementById('aiInsightHeadline').textContent = 'Menunggu Data yang Cukup…';
    document.getElementById('aiInsightText').textContent = 'Butuh lebih banyak bar candle sebelum AI dapat menganalisis.';
    document.getElementById('aiBias').textContent = '—';
    document.getElementById('aiRisk').textContent = '—';
    document.getElementById('aiRegime').textContent = '—';
    document.getElementById('aiBiasCaptionText').textContent = '—';
    document.getElementById('aiRiskCaptionText').textContent = '—';
    document.getElementById('aiRegimeCaptionText').textContent = '—';
    document.getElementById('aiSummaryText').textContent = 'Menunggu cukup data untuk menghasilkan ringkasan insight.';
    return;
  }
  const data = [
    { close: res.closes[last-1] ?? res.closes[last], trendUp: res.stTrend[last-1]===1, atr: atrArr[last-1] ?? atrArr[last] },
    { close: res.closes[last], trendUp: res.stTrend[last]===1, atr: atrArr[last] },
  ];
  const ai = calculateAIInsight(data);
  updateAIUI(ai);
}

/* Baris "OPEN" (posisi masih berjalan) selalu live dari cycle sekarang; baris yang
   sudah closed diambil dari riwayat TERSIMPAN PERMANEN (persistedHistory), bukan dari
   hasil backtest jendela candle yang sedang di-fetch (res.signals) — jendela itu otomatis
   menyusut/bergeser tiap kali data terbaru masuk, jadi kalau tabel sumbernya dari situ,
   baris lama akan "hilang" walau tradenya belum di-reset. Dengan sumber dari
   persistedHistory, riwayat hanya hilang lewat tombol "Reset Riwayat" (self-learning). */
function historyRows(res){
  const open = res.signals.filter(s=>s.status==='OPEN');
  const closedAll = persistedHistory.filter(h=>h.symbol===state.symbol && h.interval===state.interval);
  const closed = closedAll.slice(-CONST.MAX_HISTORY_SIGS).slice().reverse();
  return { rows: [...open.slice().reverse(), ...closed], openCount: open.length, closedAllCount: closedAll.length };
}

function renderLog(res){
  const body = document.getElementById('logBody');
  const { rows, openCount, closedAllCount } = historyRows(res);
  document.getElementById('logCount').textContent = rows.length+' / '+(openCount+closedAllCount)+' sinyal';
  document.getElementById('logEmpty').style.display = rows.length? 'none':'block';
  body.innerHTML = rows.map(s=>{
    const rTxt = s.realizedR!=null ? (s.realizedR>=0?'+':'')+s.realizedR.toFixed(2)+'R' : '—';
    const rCls = s.realizedR!=null ? (s.realizedR>=0?'pos':'neg') : '';
    const validTxt = s.valid===false ? 'Lemah' : 'Valid';
    const validCls = s.valid===false ? 'neg' : 'pos';
    return `
<tr>

    <td data-label="Waktu">
        ${s.time}
    </td>

    <td data-label="Sisi">
        <span class="sideBadge ${s.side === 'BUY' ? 'buy' : 'sell'}">
            ${s.side}
        </span>
    </td>

    <td data-label="Kualitas" class="${validCls}">
        ${validTxt}
    </td>

    <td data-label="Harga">
        ${fmtPrice(s.price)}
    </td>

    <td data-label="Skor">
        ${s.score.toFixed(1)}
    </td>

    <td data-label="Purity">
        ${s.tqi.toFixed(2)}
    </td>

    <td data-label="Pola">
        ${s.pattern ? s.pattern : '—'}
    </td>

    <td data-label="SL">
        ${fmtPrice(s.sl)}
    </td>

    <td data-label="TP1">
        ${fmtPrice(s.tp1)}
        ${s.hit[0] ? ' ✓' : ''}
    </td>

    <td data-label="TP2">
        ${fmtPrice(s.tp2)}
        ${s.hit[1] ? ' ✓' : ''}
    </td>

    <td data-label="TP3">
        ${fmtPrice(s.tp3)}
        ${s.hit[2] ? ' ✓' : ''}
    </td>

    <td data-label="Status">
        ${s.status}
    </td>

    <td
        data-label="R:R"
        class="rval ${rCls}">

        ${rTxt}

    </td>

</tr>
`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════
   ALERTS
   ═══════════════════════════════════════════════════════════ */
function beep(){
  try{
    const ctxA = new (window.AudioContext||window.webkitAudioContext)();
    const o = ctxA.createOscillator(), g = ctxA.createGain();
    o.type='sine'; o.frequency.value=880; g.gain.value=0.08;
    o.connect(g); g.connect(ctxA.destination);
    o.start(); o.stop(ctxA.currentTime+0.18);
  }catch(e){}
}
function notify(sig){
  if(state.sound) beep();
  if(state.notif && state.notifPermission){
    try{
      new Notification(`GUSERA SATS — ${sig.side} ${state.symbol}`, {
        body: `Harga ${fmtPrice(sig.price)} · Skor ${sig.score.toFixed(0)}/${lastResult?lastResult.maxScoreRef:CONST.MAX_SCORE_WITH_VOLUME} · SL ${fmtPrice(sig.sl)} · TP1 ${fmtPrice(sig.tp1)}`,
      });
    }catch(e){}
  }
}

/* ═══════════════════════════════════════════════════════════
   MAIN LOOP
   ═══════════════════════════════════════════════════════════ */
let prevSignalCount = 0;

async function runCycle(){
  try{
    setConn('', 'Sinkron');
    const candles = await fetchCandles();
    state.candles = candles;
    processAndRender(candles);
    setConn('live','Live');
    setStatus('');
  }catch(err){
    setConn('err','Error');
    const hint = err.allKeysExhausted ? '' : ' — cek API key, atau pakai mode CSV di Pengaturan.';
    setStatus('Fetch gagal: '+err.message+hint, 'err');
  }
  updateApiKeyStatusUI(); // refresh tampilan index/pool — auto-switch mungkin baru saja pindah key
}

function processAndRender(candles){
  if(candles.length<60){ setStatus('Data terlalu sedikit ('+candles.length+' candle). Perbesar outputsize atau cek symbol/interval.', 'err'); return; }
  const tfMinutes = tfToMinutes(state.interval);
  const pp = presetParams(state.preset, tfMinutes);
  // Bobot confluence dipelajari dari riwayat SEBELUM cycle ini (persistedHistory belum
  // di-sync dengan sinyal cycle ini di titik ini) — supaya sinyal baru tidak "mempengaruhi
  // diri sendiri" secara sirkular. Lihat computeConfluenceWeights().
  const weights = computeTrendWeights();
  const cfg = {
    atrLen: pp.atrLen, baseMult: pp.baseMult, erLen: pp.erLen, rsiLen: pp.rsiLen, slMult: pp.slMult,
    tpMode: state.tpMode, qualityStrength: state.qualityStrength,
    useAsym: state.useAsym, useCharFlip: state.useCharFlip, useEffAtr: state.useEffAtr,
    useBreakeven: state.useBreakeven,
    useCandleConfirm: state.useCandleConfirm,
    structWeight: weights.structWeight, momWeight: weights.momWeight,
    patternWeight: weights.patternWeight,
    tqiEffWeight: weights.tqiEffWeight, tqiVolWeight: weights.tqiVolWeight,
  };
  const res = computeEngine(candles, cfg);
  res.confluenceWeights = weights; // dipakai renderAll() untuk tooltip transparansi bobot yang dipelajari
  syncPersistedHistory(res.signals); // simpan trade yang closed cycle ini ke riwayat permanen
  syncPersistedSkipped(res.skippedSignals); // simpan hasil simulasi sinyal terlewat yang sudah resolve
  // Ambang self-learning yang dipakai di atas untuk menggerbang entry cycle ini (lihat
  // computeEngine) — dipakai lagi di sini murni untuk ditampilkan di UI, jadi angka yang
  // ditampilkan (kartu "Ambang Skor") DIJAMIN sama dengan yang benar-benar menentukan
  // entry mana yang dieksekusi, bukan dihitung ulang terpisah dan berpotensi berbeda.
  state.currentThreshold = res.entryThreshold;
  lastResult = res; // set before notify() so it always reflects the current cycle's maxScoreRef
  if(res.signals.length>prevSignalCount){
    const newSigs = res.signals.slice(prevSignalCount);
    newSigs.forEach(s=>notify(s)); // semua signals di sini sudah lolos ambang self-learning (lihat computeEngine)
  }
  prevSignalCount = res.signals.length;
  renderAll(res, candles);
}

function startLoop(){
  if(state.timer) clearInterval(state.timer);
  runCycle();
  state.timer = setInterval(runCycle, state.refreshMs);
}
function stopLoop(){ if(state.timer){ clearInterval(state.timer); state.timer=null; } }

/* ═══════════════════════════════════════════════════════════
   UI WIRING
   ═══════════════════════════════════════════════════════════ */
const overlay = document.getElementById('overlay');
document.getElementById('settingsBtn').onclick = ()=> overlay.classList.add('open');
document.getElementById('closeModalBtn').onclick = ()=> overlay.classList.remove('open');

document.querySelectorAll('.tabBtn').forEach(btn=>{
  btn.onclick = ()=>{
    document.querySelectorAll('.tabBtn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tabPane').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.querySelector(`.tabPane[data-pane="${btn.dataset.tab}"]`).classList.add('active');
  };
});

function collectSettingsFromForm(){
  state.apiKey = document.getElementById('apiKeyInput').value.trim();
  state.refreshMs = parseInt(document.getElementById('refreshSel').value,10);
  state.outputSize = clamp(parseInt(document.getElementById('outputSizeInput').value,10)||300,100,500);
  state.preset = document.getElementById('presetSel').value;
  state.tpMode = document.getElementById('tpModeSel').value;
  state.qualityStrength = clamp(parseFloat(document.getElementById('qualityStrengthInput').value)||0.4,0,1);
  state.useAsym = document.getElementById('asymToggle').checked;
  state.useCharFlip = document.getElementById('charFlipToggle').checked;
  state.useEffAtr = document.getElementById('effAtrToggle').checked;
  state.useBreakeven = document.getElementById('breakevenToggle').checked;
  state.useAdaptiveThreshold = document.getElementById('adaptiveThresholdToggle').checked;
  state.useCandleConfirm = document.getElementById('candleConfirmToggle').checked;
  state.notif = document.getElementById('notifToggle').checked;
  state.sound = document.getElementById('soundToggle').checked;
  state.symbol = document.getElementById('symbolSel').value;
  state.interval = document.getElementById('tfSel').value;
  updatePriceCardTitle();
}

const LS_KEY = 'gusera_sats_api_key';
function persistApiKey(){
  try{
    if(state.apiKey) localStorage.setItem(LS_KEY, state.apiKey);
    else localStorage.removeItem(LS_KEY); // key pribadi dikosongkan -> kembali murni ke pool bawaan
  }catch(e){ /* Safari private mode / storage disabled — ignore */ }
}
function restoreApiKey(){
  let saved = null;
  try{ saved = localStorage.getItem(LS_KEY); }catch(e){}
  const key = saved || DEFAULT_API_KEY;
  document.getElementById('apiKeyInput').value = key;
  state.apiKey = key;
  loadApiKeyIndex();
  updateApiKeyStatusUI();
}

/* Menampilkan key mana yang sedang aktif (index/ukuran pool) di modal Pengaturan
   & tab Profil, supaya auto-switch tidak jadi kotak-hitam — pengguna bisa lihat
   kalau, misal, key ke-3 dari 5 yang sedang dipakai karena 2 sebelumnya kena limit. */
function updateApiKeyStatusUI(){
  const pool = getApiKeyPool();
  const idx = clamp(state.apiKeyIndex, 0, pool.length-1);
  const hasCustom = pool.length > API_KEY_POOL.length;
  const label = hasCustom
    ? `Key ${idx+1}/${pool.length} aktif (${idx===0?'pribadi':'bawaan #'+idx} · auto-switch)`
    : `Key ${idx+1}/${pool.length} aktif (bawaan · auto-switch)`;
  const modalEl = document.getElementById('apiKeyPoolStatus');
  if(modalEl) modalEl.textContent = label;
  const profEl = document.getElementById('profApiKeyStatus');
  if(profEl) profEl.textContent = `${idx+1}/${pool.length}`;
}

document.getElementById('saveStartBtn').onclick = async ()=>{
  collectSettingsFromForm();
  // Tidak lagi memblokir kalau apiKeyInput kosong — pool 5 key bawaan (API_KEY_POOL)
  // selalu tersedia sebagai fallback auto-switch, jadi key pribadi kini benar-benar opsional.
  persistApiKey();
  updateApiKeyStatusUI();
  setModalStatus('Pengaturan disimpan.', 'ok');
  overlay.classList.remove('open');
  prevSignalCount = 0;
  startLoop();
};

document.getElementById('csvLoadBtn').onclick = ()=>{
  const text = document.getElementById('csvInput').value;
  if(!text.trim()){ setModalStatus('Tempel data CSV dulu.', 'err'); return; }
  try{
    const { candles, skipped } = parseCsv(text);
    stopLoop();
    state.csvMode = true;
    collectSettingsFromForm();
    prevSignalCount = 0;
    processAndRender(candles);
    setConn('', 'Mode CSV');
    const skipMsg = skipped>0 ? ` (${skipped} baris rusak/tidak valid dilewati)` : '';
    setModalStatus('Data CSV dimuat: '+candles.length+' candle.'+skipMsg, skipped>0?'warn':'ok');
    overlay.classList.remove('open');
  }catch(e){ setModalStatus('Gagal parse CSV: '+e.message, 'err'); }
};

document.getElementById('startBtn').onclick = async ()=>{
  collectSettingsFromForm();
  // Tidak lagi memblokir kalau apiKeyInput kosong — pool 5 key bawaan (API_KEY_POOL)
  // selalu tersedia sebagai fallback auto-switch (lihat fetchWithKeyRotation).
  if(state.notif && 'Notification' in window){
    try{ const p = await Notification.requestPermission(); state.notifPermission = p==='granted'; }catch(e){}
  }
  prevSignalCount = 0;
  startLoop();
};

document.getElementById('symbolSel').onchange = ()=>{ state.symbol = document.getElementById('symbolSel').value; updatePriceCardTitle(); if(state.timer) startLoop(); };
document.getElementById('tfSel').onchange = ()=>{ state.interval = document.getElementById('tfSel').value; if(state.timer) startLoop(); };

function updatePriceCardTitle(){
  const el = document.getElementById('priceCardTitle');
  if(el) el.textContent = 'Harga '+state.symbol;
}

let resizeT=null;
window.addEventListener('resize', ()=>{
  clearTimeout(resizeT);
  resizeT = setTimeout(()=>{
    if(lastResult && state.candles.length) drawChart(lastResult, state.candles);
  }, 120);
});
// iOS Safari fires orientationchange separately/earlier than resize in some versions
window.addEventListener('orientationchange', ()=>{
  setTimeout(()=>{ if(lastResult && state.candles.length) drawChart(lastResult, state.candles); }, 250);
});
function currentCfg(){
  const tfMinutes = tfToMinutes(state.interval);
  const pp = presetParams(state.preset, tfMinutes);
  const weights = computeTrendWeights();
  return { atrLen: pp.atrLen, baseMult: pp.baseMult, erLen: pp.erLen, rsiLen: pp.rsiLen, slMult: pp.slMult,
    tpMode: state.tpMode, qualityStrength: state.qualityStrength, useAsym: state.useAsym, useCharFlip: state.useCharFlip, useEffAtr: state.useEffAtr,
    useBreakeven: state.useBreakeven,
    useCandleConfirm: state.useCandleConfirm,
    structWeight: weights.structWeight, momWeight: weights.momWeight,
    patternWeight: weights.patternWeight,
    tqiEffWeight: weights.tqiEffWeight, tqiVolWeight: weights.tqiVolWeight };
}

/* ═══════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════ */
let toastT=null;
function toast(msg){
  const el = document.getElementById('toast');
  if(!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(()=> el.classList.remove('show'), 2600);
}

/* ═══════════════════════════════════════════════════════════
   DOWNLOAD RIWAYAT (CSV, maks 100 baris)
   ═══════════════════════════════════════════════════════════ */
function csvEscape(v){
  const s = String(v);
  return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
function downloadHistoryCsv(){
  if(!lastResult){
    toast('Belum ada riwayat sinyal untuk diunduh.');
    return;
  }
  const { rows: rowsDesc } = historyRows(lastResult);
  if(!rowsDesc.length){
    toast('Belum ada riwayat sinyal untuk diunduh.');
    return;
  }
  const rows = rowsDesc.slice().reverse(); // chronological, oldest→newest
  const header = ['Waktu','Simbol','Timeframe','Sisi','Kualitas','Harga','Skor','Purity','Pola','PatternScore','SL','TP1','TP1_Hit','TP2','TP2_Hit','TP3','TP3_Hit','Status','RealizedR'];
  const lines = [header.join(',')];
  rows.forEach(s=>{
    lines.push([
      s.time, state.symbol, state.interval, s.side, s.valid===false?'Lemah':'Valid', fmtPrice(s.price), s.score.toFixed(1), s.tqi.toFixed(2),
      s.pattern || '', s.patternScore!=null?s.patternScore.toFixed(1):'0',
      fmtPrice(s.sl), fmtPrice(s.tp1), s.hit[0]?'YES':'NO', fmtPrice(s.tp2), s.hit[1]?'YES':'NO',
      fmtPrice(s.tp3), s.hit[2]?'YES':'NO', s.status, s.realizedR!=null?s.realizedR.toFixed(2):''
    ].map(csvEscape).join(','));
  });
  const csv = '\uFEFF'+lines.join('\r\n'); // BOM so Excel/Numbers on iOS read it correctly
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  a.href = url;
  a.download = `gusera-sats-riwayat_${state.symbol.replace('/','')}_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
  toast('Riwayat diunduh ('+rows.length+' baris).');
}

/* ═══════════════════════════════════════════════════════════
   RESET
   ═══════════════════════════════════════════════════════════ */
function resetUI(){
  document.getElementById('priceNow').textContent = '—';
  document.getElementById('priceNow').className = 'priceNow';
  document.getElementById('priceSub').textContent = 'Klik Mulai untuk memuat data';
  const priceChangeEl = document.getElementById('priceChange');
  if(priceChangeEl){ priceChangeEl.textContent=''; priceChangeEl.className='price-change'; }
  const sparkCanvas = document.getElementById('sparkCanvas');
  if(sparkCanvas){ const c=sparkCanvas.getContext('2d'); c.clearRect(0,0,sparkCanvas.width,sparkCanvas.height); }
  const engineTag = document.getElementById('engineTag');
  if(engineTag){
    engineTag.textContent='—'; engineTag.className='trendTag';
    engineTag.style.background = '#1c2027'; engineTag.style.color = 'var(--text-dim)'; engineTag.style.border = '1px solid var(--border)';
  }
  const tqiDescEl = document.getElementById('tqiDesc');
  if(tqiDescEl){ tqiDescEl.textContent = 'Menunggu Analisis Trend…'; }
  const trendTag = document.getElementById('trendTag');
  trendTag.textContent = '—';
  trendTag.className = 'trendTag';
  trendTag.style.background = '#1c2027'; trendTag.style.color = 'var(--text-dim)'; trendTag.style.border = '1px solid var(--border)';
  trendTag.title = '';
  const slConfTag = document.getElementById('slConfTag');
  if(slConfTag){
    slConfTag.textContent='—'; slConfTag.className='trendTag';
    slConfTag.style.background = '#1c2027'; slConfTag.style.color = 'var(--text-dim)'; slConfTag.style.border = '1px solid var(--border)';
  }
  const slConfFill = document.getElementById('slConfFill');
  if(slConfFill){ slConfFill.style.width='0%'; slConfFill.className='factor-fill fill-green'; }
  const slVotesMsg = document.getElementById('slVotesMsg');
  if(slVotesMsg){ slVotesMsg.textContent=''; slVotesMsg.className='statusMsg'; }
  const tqiSlTag = document.getElementById('tqiSlTag');
  if(tqiSlTag){
    tqiSlTag.textContent='—'; tqiSlTag.className='trendTag';
    tqiSlTag.style.background = '#1c2027'; tqiSlTag.style.color = 'var(--text-dim)'; tqiSlTag.style.border = '1px solid var(--border)';
    tqiSlTag.title = '';
  }
  const tqiSlFill = document.getElementById('tqiSlFill');
  if(tqiSlFill){ tqiSlFill.style.width='0%'; tqiSlFill.className='factor-fill fill-green'; }
  const tqiSlMsg = document.getElementById('tqiSlMsg');
  if(tqiSlMsg){ tqiSlMsg.textContent=''; tqiSlMsg.className='statusMsg'; }
  setStatus('');
  document.getElementById('tqiVal').textContent = '—';
  document.getElementById('tqiRegime').textContent = '—';
  drawGauge(null);
  ['fEr','fVol','fStruct','fMom'].forEach(id=> document.getElementById(id).style.width='0%');
  ['fErV','fVolV','fStructV','fMomV'].forEach(id=> document.getElementById(id).textContent='—');
  document.getElementById('posStatus').textContent='FLAT';
  document.getElementById('posStatus').className='statusPill flat';
  ['tEntry','tSl','tTp1','tTp2','tTp3','tMode'].forEach(id=>{ document.getElementById(id).textContent='—'; });
  ['tTp1','tTp2','tTp3'].forEach(id=>{ document.getElementById(id).className='v'; });
  document.getElementById('tScore').textContent='—';
  document.getElementById('tScoreMax').textContent='';
  document.getElementById('tScoreFill').style.width='0%';
  document.getElementById('sWinRate').textContent='—'; document.getElementById('sWinRate').className='v';
  document.getElementById('sAvgR').textContent='—'; document.getElementById('sAvgR').className='v';
  document.getElementById('sCount').textContent='—';
  document.getElementById('sStreak').textContent='—';
  document.getElementById('sPersistedWR').textContent='—'; document.getElementById('sPersistedWR').className='v';
  document.getElementById('sThreshold').textContent='—';
  document.getElementById('sSkippedCount').textContent='—';
  document.getElementById('sSkippedAvgR').textContent='—'; document.getElementById('sSkippedAvgR').className='v';
  document.getElementById('logBody').innerHTML='';
  document.getElementById('logCount').textContent='0 sinyal';
  document.getElementById('logEmpty').style.display='block';
  document.getElementById('aiConfidence').textContent='—';
  document.getElementById('aiConfidenceFill').style.width='0%';
  document.getElementById('aiInsightHeadline').textContent='Menunggu Analisis AI…';
  document.getElementById('aiInsightText').textContent='';
  document.getElementById('aiBias').textContent='—';
  document.getElementById('aiRisk').textContent='—';
  document.getElementById('aiRegime').textContent='—';
  document.getElementById('aiBiasCaptionText').textContent='—';
  document.getElementById('aiRiskCaptionText').textContent='—';
  document.getElementById('aiRegimeCaptionText').textContent='—';
  document.getElementById('aiSummaryText').textContent='Menunggu cukup data untuk menghasilkan ringkasan insight.';
  const canvas = document.getElementById('chartCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  setConn('', 'Offline');
  updateProfilePanel(null);
}

function resetApp(){
  stopLoop();
  state.candles = [];
  state.csvMode = false;
  prevSignalCount = 0;
  lastResult = null;
  resetUI();
  toast('Data & chart direset. Riwayat sinyal tersimpan tetap ada.');
}

document.getElementById('downloadHistoryBtn').onclick = downloadHistoryCsv;
document.getElementById('resetBtn').onclick = ()=>{
  // Reset ini hanya menghentikan live update & membersihkan tampilan chart/data candle
  // sesi saat ini. Riwayat sinyal (Riwayat Sinyal + statistik self-learning) TIDAK ikut
  // terhapus di sini — itu tersimpan permanen dan hanya hilang lewat tombol "Reset
  // Riwayat" khusus di tab Self-Learning, sesuai desain: data tidak boleh hilang cuma
  // karena data terbaru di-update / live di-restart.
  const ok = window.confirm('Reset akan menghentikan live update dan menghapus chart & data candle saat ini. Riwayat sinyal tersimpan serta pengaturan & API key tetap tersimpan. Lanjutkan?');
  if(ok) resetApp();
};

/* ═══════════════════════════════════════════════════════════
   iOS SAFARI: unlock AudioContext on first user gesture
   (autoplay/audio policies block sound until a tap happens)
   ═══════════════════════════════════════════════════════════ */
let audioUnlocked = false;
function unlockAudioOnce(){
  if(audioUnlocked) return;
  audioUnlocked = true;
  try{
    const ctxA = new (window.AudioContext||window.webkitAudioContext)();
    if(ctxA.state === 'suspended') ctxA.resume();
    ctxA.close();
  }catch(e){}
  window.removeEventListener('touchend', unlockAudioOnce);
  window.removeEventListener('click', unlockAudioOnce);
}
window.addEventListener('touchend', unlockAudioOnce, {once:true});
window.addEventListener('click', unlockAudioOnce, {once:true});

// init
drawGauge(null);
restoreApiKey();
loadPersistedHistory();
loadPersistedSkipped();
updatePriceCardTitle();

document.getElementById('resetHistoryBtn').onclick = ()=>{
  if(!confirm(`Hapus semua riwayat tersimpan (${persistedHistory.length} trade, + ${persistedSkipped.length} sinyal terlewat)? Ini akan mengembalikan ambang skor adaptif & bobot confluence ke baseline.`)) return;
  resetPersistedHistory();
  resetPersistedSkipped(); // ikut direset — keduanya sama-sama memori self-learning
  toast('Riwayat tersimpan dihapus.');
  // Ini SATU-SATUNYA aksi yang boleh menghapus Riwayat Sinyal (sesuai desain: riwayat
  // tidak boleh hilang karena data terbaru di-update, hanya lewat tombol reset ini).
  if(lastResult) renderAll(lastResult, state.candles);
  else { document.getElementById('logBody').innerHTML=''; document.getElementById('logCount').textContent='0 sinyal'; document.getElementById('logEmpty').style.display='block'; }
};

// Profil: tombol shortcut (memakai ulang fungsi & alur konfirmasi yang sama seperti di
// tab Riwayat/Alert, supaya tidak ada dua sumber kebenaran untuk aksi yang sama)
document.getElementById('profOpenSettingsBtn').onclick = ()=> overlay.classList.add('open');
document.getElementById('profExportBtn').onclick = downloadHistoryCsv;
document.getElementById('profResetHistoryBtn').onclick = ()=> document.getElementById('resetHistoryBtn').click();
updateProfilePanel(null);

function calculateAIInsight(data) {

    const last = data[data.length - 1];
    const prev = data[data.length - 2];

    let bias = "NEUTRAL";
    let risk = "LOW";
    let regime = "SIDEWAYS";

    let confidence = 50;
    let headline = "";
    let detail = "";

    // --- Trend direction
    if (last.trendUp) {
        bias = "BULLISH";
        confidence += 20;
    } else {
        bias = "BEARISH";
        confidence += 20;
    }

    // --- Momentum check
    const momentum = last.close - prev.close;

    if (Math.abs(momentum) > last.atr * 0.5) {
        confidence += 15;
        regime = "TRENDING";
    } else {
        risk = "MEDIUM";
    }

    // --- Volatility filter
    if (last.atr > last.close * 0.01) {
        risk = "HIGH";
        confidence -= 10;
    }

    // --- Clamp
    confidence = Math.max(0, Math.min(100, confidence));

    // --- Generate explanation
    if (bias === "BULLISH") {
        headline = "Trend saat ini bullish dengan momentum positif.";
        detail = "Potensi kelanjutan trend naik.";
    } else {
        headline = "Trend saat ini bearish dengan tekanan turun dominan.";
        detail = "Waspadai potensi kelanjutan trend turun.";
    }

    // --- Captions
    const biasCaption = bias === "BULLISH" ? "Outlook Positif" : "Outlook Negatif";
    const riskCaption = risk === "HIGH" ? "Volatilitas Tinggi" : (risk === "MEDIUM" ? "Sinyal Kurang Jelas" : "Volatilitas Terkendali");
    const regimeCaption = regime === "TRENDING" ? "Momentum Searah" : "Pasar Konsolidasi";

    // --- Summary
    const summary = bias === "BULLISH"
        ? "Trend jangka pendek masih didukung oleh momentum harga yang bullish. Waspadai noise pasar dan konfirmasi break struktur untuk validasi arah trend."
        : "Trend jangka pendek masih tertekan oleh momentum harga yang bearish. Waspadai noise pasar dan konfirmasi break struktur sebelum mengambil posisi.";

    return {
        bias,
        risk,
        regime,
        confidence,
        headline,
        detail,
        biasCaption,
        riskCaption,
        regimeCaption,
        summary
    };
}

function updateAIUI(ai) {

    document.getElementById("aiConfidence").innerText = ai.confidence + "%";
    document.getElementById("aiConfidenceFill").style.width = ai.confidence + "%";

    document.getElementById("aiInsightHeadline").innerText = ai.headline;
    document.getElementById("aiInsightText").innerText = ai.detail;

    document.getElementById("aiBias").innerText = ai.bias;
    document.getElementById("aiRisk").innerText = ai.risk;
    document.getElementById("aiRegime").innerText = ai.regime;

    document.getElementById("aiBiasCaptionText").innerText = ai.biasCaption;
    document.getElementById("aiRiskCaptionText").innerText = ai.riskCaption;
    document.getElementById("aiRegimeCaptionText").innerText = ai.regimeCaption;

    document.getElementById("aiSummaryText").innerText = ai.summary;

    // trend icon direction
    const trendIcon = document.getElementById("aiTrendIcon");
    trendIcon.classList.remove("down", "flat");
    if (ai.bias === "BEARISH") trendIcon.classList.add("down");

    // bias card color state
    const biasCard = document.getElementById("aiBiasCard");
    biasCard.classList.toggle("bearish", ai.bias === "BEARISH");

    // risk card color state (low risk = teal, high/noise = amber)
    const riskCard = document.getElementById("aiRiskCard");
    riskCard.classList.toggle("low", ai.risk === "LOW");
}

/* ═══════════════════════════════════════════════════════════
   PROFIL: ringkasan performa lintas sesi & preferensi aktif
   ═══════════════════════════════════════════════════════════ */
function updateProfilePanel(res){
  const pairLabelEl = document.getElementById('profPairLabel');
  if(pairLabelEl) pairLabelEl.textContent = state.symbol+' · '+state.interval;

  const pStats = getPersistedStats(30);
  const winRateEl = document.getElementById('profWinRate');
  if(winRateEl){
    winRateEl.textContent = pStats.winRate!=null ? pStats.winRate.toFixed(0)+'%' : '—';
    winRateEl.className = 'v '+(pStats.winRate>50?'pos':pStats.winRate!=null&&pStats.winRate<=50?'neg':'');
  }
  const avgREl = document.getElementById('profAvgR');
  if(avgREl){
    avgREl.textContent = pStats.avgR!=null ? pStats.avgR.toFixed(2)+'R' : '—';
    avgREl.className = 'v '+(pStats.avgR>0?'pos':pStats.avgR!=null&&pStats.avgR<=0?'neg':'');
  }
  const totalEl = document.getElementById('profTotalTrades');
  if(totalEl) totalEl.textContent = pStats.total || '—';
  const streakEl = document.getElementById('profBestStreak');
  if(streakEl && res && res.stats){
    streakEl.textContent = res.stats.maxWinStreak>0 ? res.stats.maxWinStreak+'W' : '—';
  }

  const symTfEl = document.getElementById('profSymbolTf');
  if(symTfEl) symTfEl.textContent = state.symbol+' · '+state.interval;
  const presetEl = document.getElementById('profPreset');
  if(presetEl) presetEl.textContent = state.preset;
  const tpModeEl = document.getElementById('profTpMode');
  if(tpModeEl) tpModeEl.textContent = state.tpMode;
  const sourceEl = document.getElementById('profDataSource');
  if(sourceEl) sourceEl.textContent = state.csvMode ? 'Mode CSV (Offline)' : 'Twelve Data (Live)';
}

/* ═══════════════════════════════════════════════════════════
   BOTTOM NAV
   ═══════════════════════════════════════════════════════════ */
(function initBottomNav(){
  function setView(view){
    document.querySelectorAll('.app-main > section[data-view]').forEach(sec=>{
      sec.classList.toggle('view-active', sec.dataset.view === view);
    });
    // Canvases (chart/gauge) can't size themselves correctly while their tab is
    // display:none, so force a full re-render right after the switch — this keeps
    // every tab in sync with the latest engine data instead of showing a stale/blank canvas.
    if(lastResult && state.candles.length){
      requestAnimationFrame(()=> renderAll(lastResult, state.candles));
    }
  }

  document.querySelectorAll('.nav-item').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const key = btn.dataset.nav;

      document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      setView(key);
      window.scrollTo({top:0, behavior:'smooth'});
    });
  });

  setView('dashboard');
})();


