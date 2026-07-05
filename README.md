<div align="center">

<img src="logo-header.png" alt="GUSERA" width="140">

# S A T S
### Self-Aware Trend System

**Terminal analisa trend adaptif yang berjalan 100% di browser — tanpa server, tanpa backend, tanpa instalasi.**

[![Status](https://img.shields.io/badge/status-active-2FD9C4?style=for-the-badge)](#)
[![Platform](https://img.shields.io/badge/platform-web-C89B3C?style=for-the-badge)](#)
[![Made with](https://img.shields.io/badge/made%20with-JavaScript-E8C570?style=for-the-badge&logo=javascript&logoColor=black)](#)
[![Data](https://img.shields.io/badge/data-Twelve%20Data-171B21?style=for-the-badge)](https://twelvedata.com)
[![License](https://img.shields.io/badge/license-MIT-232830?style=for-the-badge)](#-lisensi)

<br>

[Fitur](#-fitur-utama) · [Cara Kerja](#-cara-kerja-mesin-analisa) · [Instalasi](#-instalasi--menjalankan) · [Auto-Switch API Key](#-auto-switch-api-key) · [Konfigurasi](#-konfigurasi) · [Struktur](#-struktur-proyek) · [Disclaimer](#️-disclaimer)

</div>

<br>

## Ikhtisar

**GUSERA SATS** adalah web app analisa teknikal real-time yang memadukan **Adaptive SuperTrend** dengan **Trend Quality Index (TQI)** — sebuah lapisan skoring "kesadaran diri" yang mengukur seberapa layak dipercaya sebuah trend sebelum sinyal ditampilkan. Seluruh mesin perhitungan (indikator, deteksi sinyal, manajemen risiko, statistik performa) berjalan sepenuhnya di sisi klien, langsung di browser pengguna — data harga ditarik live dari **Twelve Data API**, tanpa perantara server.

Dibangun untuk trader yang ingin *satu layar penuh konteks*: harga, trend, kualitas sinyal, level eksekusi, dan riwayat performa — sekaligus, tanpa berpindah tab.

<br>

## ✨ Fitur Utama

| | |
|---|---|
| 📈 **Adaptive SuperTrend Engine** | Multiplier band yang menyesuaikan diri secara dinamis terhadap efficiency ratio, volatilitas ATR, dan kualitas trend — bukan multiplier statis. |
| 🎯 **Trend Quality Index (TQI)** | Skor gabungan 0–1 dari 4 faktor (*Efficiency, Volatilitas, Struktur, Momentum*) yang menyaring sinyal palsu di pasar choppy. |
| 🕯️ **Chart Pattern Confluence** | Deteksi otomatis candlestick (Bullish/Bearish Engulfing, Hammer, Shooting Star) & struktur chart (Double Top/Bottom, Higher Low, Lower High) sebagai bukti tambahan di luar indikator numerik — menambah skor sinyal dan ditampilkan live di kartu Status Trend. |
| ⚡ **Live Market Data** | Terintegrasi langsung dengan Twelve Data — Forex, Emas (XAU/USD), hingga Crypto, dengan interval 1 menit s.d. 1 hari. |
| 🔑 **Auto-Switch 5 API Key** | 5 API key Twelve Data bawaan yang berputar otomatis begitu satu kena rate-limit/quota — key pribadi (opsional) selalu dicoba lebih dulu sebelum pool bawaan. Index key yang terakhir terbukti jalan disimpan lintas sesi, jadi reload berikutnya tidak mengulang dari key yang sudah diketahui limit. |
| 🧮 **Skor Sinyal Transparan (dinamis, ±105–110)** | Setiap sinyal BUY/SELL dipecah ke komponen inti (momentum, efficiency, volume, RSI depth, struktur, breakout depth, pattern) — skor maksimum menyesuaikan otomatis sesuai ketersediaan data volume, bukan kotak hitam. |
| 🎚️ **Dynamic Take-Profit** | TP1/TP2/TP3 otomatis menyesuaikan skala terhadap purity trend & volatilitas saat ini, atau bisa dikunci ke rasio-R tetap. |
| 🧾 **Riwayat & Statistik Otomatis** | Win rate, average-R, streak, dan log 100 sinyal terakhir — dihitung ulang otomatis dari data candle, tanpa database eksternal. |
| ⬇️ **Ekspor CSV Sekali Klik** | Unduh riwayat sinyal lengkap dengan status TP/SL & hasil R untuk dianalisa lebih lanjut di Excel/Sheets. |
| 🔔 **Alert Native** | Notifikasi browser + bunyi alert saat trend berbalik arah — tidak perlu refresh manual. |
| 📴 **Mode CSV Offline** | Fallback penuh tanpa API — tempel data candle manual saat rate-limit tercapai atau untuk backtest cepat. |
| 📱 **Responsive & iOS-Ready** | Dioptimalkan untuk desktop, tablet, dan Safari di iPhone — termasuk dukungan safe-area, tanpa auto-zoom input, dan unlock audio policy iOS. |

<br>

## 🧠 Cara Kerja Mesin Analisa

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐     ┌───────────────┐
│  Twelve Data │ ──▶ │  Indicator Layer  │ ──▶ │  Trend Quality Idx │ ──▶ │  Signal Engine │
│  (candles)   │     │  ATR · ER · RSI   │     │  (4-factor score)  │     │  + Risk Model  │
└─────────────┘     └──────────────────┘     └────────────────────┘     └───────────────┘
                                                                                  │
                                                              ┌───────────────────┴───────────────────┐
                                                              ▼                                        ▼
                                                     Entry · SL · TP1-3                        Statistik & Riwayat
                                                     (skor 0–102)                               (win rate, avg-R)
```

1. **Data candle** ditarik langsung dari Twelve Data setiap interval refresh yang dipilih (3 menit / 15 menit / 1 jam).
2. **Indicator layer** menghitung ATR, Efficiency Ratio, RSI, dan struktur pivot high/low dari histori candle.
3. **Trend Quality Index** menggabungkan 4 faktor menjadi satu skor kepercayaan trend, yang lalu memodulasi lebar band SuperTrend secara adaptif dan asimetris.
4. **Signal engine** mendeteksi flip trend, menghitung skor kualitas (maksimum dinamis ±105–110 tergantung ketersediaan data volume), menetapkan SL berbasis struktur pivot + ATR, dan TP dinamis atau tetap.
5. Setiap trade disimulasikan dengan model *exit sepertiga-sepertiga* di TP1/TP2/TP3 untuk menghasilkan statistik performa berjalan (bukan simulasi akun riil).

<br>

## 🚀 Instalasi & Menjalankan

Tidak perlu build step, package manager, atau server — murni HTML/CSS/JS statis.

```bash
git clone https://github.com/<username>/gusera-sats.git
cd gusera-sats
```

**Opsi 1 — buka langsung**
Klik dua kali `index.html`, atau seret ke browser.

**Opsi 2 — local server (disarankan, agar font & ikon termuat sempurna)**
```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```
Lalu buka `http://localhost:8080`.

**Opsi 3 — GitHub Pages**
Aktifkan Pages dari branch `main` (root), akses via `https://<username>.github.io/gusera-sats/`.

> **5 API key Twelve Data auto-switch sudah tertanam** di kode aplikasi agar app langsung bisa dipakai tanpa setup apapun. Lihat [Auto-Switch API Key](#-auto-switch-api-key) untuk cara kerjanya, dan kenapa tetap disarankan mengisi API key pribadi untuk pemakaian rutin.

<br>

## 🔑 Auto-Switch API Key

Twelve Data (plan gratis) membatasi jumlah request per menit/hari. GUSERA SATS menangani ini dengan pool 5 API key bawaan yang berputar otomatis:

1. **Urutan coba**: API key pribadi (kalau diisi di ⚙ Pengaturan) selalu dicoba **pertama**, baru diikuti 5 key bawaan secara berurutan.
2. **Deteksi rate-limit**: setiap respons API dicek — kalau errornya soal limit/quota/HTTP 429, aplikasi otomatis pindah ke key berikutnya di pool dan mengulang request yang sama. Error lain (mis. symbol tidak valid) **tidak** memicu perpindahan key, karena mengganti key tidak akan memperbaiki error jenis itu.
3. **Ingat key yang terakhir jalan**: index key yang terbukti berhasil disimpan di `localStorage`, lintas sesi/reload — jadi aplikasi tidak mengulang dari key pertama yang sudah diketahui kena limit.
4. **Transparan**: status "Key N/5 aktif" ditampilkan di tab **Profil** dan di modal ⚙ Pengaturan, supaya perpindahan key tidak jadi kotak-hitam.
5. **Kalau semua key kena limit** sekaligus, aplikasi menampilkan pesan jelas dan menyarankan mencoba lagi nanti atau memakai Mode CSV — bukan gagal diam-diam.

> ⚠️ Ke-5 key bawaan tertanam langsung di `app.js` dan terlihat oleh siapapun lewat view-source — quota-nya dipakai bersama oleh semua pengguna file ini. Cukup untuk pemakaian ringan/personal, tapi untuk pemakaian rutin/produksi disarankan mengisi API key gratis milik Anda sendiri dari [twelvedata.com](https://twelvedata.com) via menu **⚙ Pengaturan**; key pribadi selalu dicoba lebih dulu dan tetap otomatis fallback ke pool bawaan kalau ikut kena limit.

<br>

## ⚙️ Konfigurasi

Semua pengaturan dapat diubah lewat tombol **⚙ Pengaturan** di header — tersimpan otomatis di `localStorage` browser.

<details>
<summary><strong>Data Live</strong></summary>

| Pengaturan | Deskripsi |
|---|---|
| API Key (opsional) | Key pribadi Twelve Data — dicoba lebih dulu sebelum 5 API key bawaan (auto-switch). Kosongkan untuk langsung memakai pool bawaan. |
| Interval refresh | 3 menit / 15 menit / 1 jam |
| Jumlah candle | 100–500 candle per fetch |

</details>

<details>
<summary><strong>Strategi</strong></summary>

| Pengaturan | Deskripsi |
|---|---|
| Preset | `Auto` / `Scalping` / `Default` / `Swing` — menentukan panjang ATR, ER, RSI, dan SL multiplier |
| Mode TP | `Fixed` (rasio-R tetap) atau `Dynamic` (mengikuti purity & volatilitas) |
| Quality Influence | Seberapa besar TQI memengaruhi lebar band (0–1) |
| Asymmetric Bands | Band aktif/pasif melebar berbeda sesuai arah trend |
| Character-Flip Detection | Deteksi dini pelemahan trend sebelum harga menembus band |
| Efficiency-Weighted ATR | ATR disesuaikan terhadap efficiency ratio |

</details>

<details>
<summary><strong>Alert</strong></summary>

Notifikasi browser dan/atau bunyi beep saat sinyal baru terbentuk.

</details>

<details>
<summary><strong>Mode CSV</strong></summary>

Tempel data candle manual (`time,open,high,low,close,volume`) sebagai fallback saat API tidak tersedia.

</details>

<br>

## 📁 Struktur Proyek

```
gusera-sats/
├── index.html            # Markup & struktur UI
├── style.css              # Seluruh styling, tema gelap + gold, responsive rules
├── app.js                  # Mesin indikator, signal engine, fetch data, rendering
├── logo.png                 # Logo resolusi penuh (banner/README)
├── logo-header.png            # Logo terkompresi untuk header aplikasi
├── favicon-16.png               # Favicon 16×16
├── favicon-32.png                 # Favicon 32×32
├── apple-touch-icon.png             # Ikon home-screen iOS (180×180)
└── README.md                          # Dokumen ini
```

<br>

## 🛠️ Tumpukan Teknologi

- **Vanilla JavaScript (ES6+)** — tanpa framework, tanpa dependency runtime
- **Canvas API** — rendering chart candlestick & gauge kustom
- **Twelve Data API** — sumber data harga real-time
- **Web Notifications & Web Audio API** — sistem alert
- **CSS Grid/Flexbox** — layout responsif desktop → tablet → mobile
- Font: [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) (display) & [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono) (data/UI)

<br>

## ⚠️ Disclaimer

GUSERA SATS adalah **alat bantu analisa teknikal**, bukan nasihat keuangan dan bukan sistem eksekusi order otomatis ke broker manapun. Semua sinyal wajib dikonfirmasi ulang secara mandiri sebelum entry. Data harga bersumber dari API pihak ketiga dan dapat berbeda/terlambat dari harga broker Anda. Trading instrumen seperti XAU/USD, forex, maupun crypto mengandung risiko kerugian modal yang signifikan.

<br>

## 📄 Lisensi

Didistribusikan di bawah lisensi **MIT**. Lihat `LICENSE` untuk detail lengkap.

<br>

<div align="center">

Dibangun dengan presisi untuk trader yang menghargai kejelasan di atas kebisingan.

**GUSERA** · *Self-Aware Trend System*

</div>
