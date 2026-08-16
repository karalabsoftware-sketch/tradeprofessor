# GÖREV: Çok Enstrümanlı Kâğıt-Ticaret Botu + Herkese Açık Dashboard

Bu bir spec'tir. Sıfırdan kurulacak. Tüm maliyet **0 $** — ücretsiz katmanlar dışına çıkma.

---

## 1. AMAÇ

Bir trend takip stratejisini **kâğıt üzerinde** (gerçek emir yok) çalıştıran, her kararını
gerekçesiyle kaydeden ve herkese açık bir dashboard'da gösteren bir sistem.

Amaç para kazanmak değil, **"bu strateji işe yarıyor mu?" sorusunu 0 $ riskle cevaplamak.**
Sonuç "yaramıyor" çıkarsa proje başarılı olmuştur.

---

## 2. TEKNOLOJİ YIĞINI

| Katman | Araç | Not |
|---|---|---|
| Uygulama | Next.js 14+ (App Router, TypeScript) | |
| Hosting | Vercel Hobby | fonksiyon süresi <10 sn |
| Veritabanı | Supabase veya Neon (ücretsiz Postgres) | Supabase'de **transaction pooler** URI'si |
| DB istemcisi | `postgres` (postgres.js) | `prepare: false` (pgbouncer), `max: 3` |
| Test | Vitest | |
| Script çalıştırma | tsx | |
| Zamanlayıcı | **cron-job.org** (ücretsiz) | GitHub Actions cron'u KULLANMA — sebebi §11 |
| Kripto verisi | Binance public REST | anahtarsız, `data-api.binance.vision` |
| Hisse verisi | Yahoo Finance chart API | anahtarsız, `query1.finance.yahoo.com/v8/finance/chart/` |
| Grafikler | Elle yazılmış SVG | grafik kütüphanesi ekleme; sayfa 4 kB'de kalıyor |

---

## 3. MİMARİ

```
cron-job.org (saatlik, :23)
    │  POST /api/cron/evaluate   Authorization: Bearer ${CRON_SECRET}
    ▼
Vercel (Next.js, Node runtime, <10 sn)
    │  1. TÜM enstrümanların barlarını PARALEL çek
    │  2. TÜM enstrümanlarda önce ÇIKIŞLARI işle
    │  3. Risk motoru (hesap düzeyinde)
    │  4. Girişleri değerlendir — bar kapanış sırasına göre
    │  5. Kararları gerekçesiyle logla, equity snapshot al
    ▼
Postgres: candles, signals, trades, equity_snapshots,
          account_state, instrument_state, missed_opportunities
    ▲
    └── herkese açık dashboard (server-rendered, salt okunur)
```

Env değişkenleri: `DATABASE_URL`, `CRON_SECRET`, `ADMIN_SECRET`.
Endpoint geçersiz secret'ta **401** dönmeli.

---

## 4. ENSTRÜMANLAR VE VENUE KURALLARI

| Venue | Bar | Yön | Enstrümanlar |
|---|---|---|---|
| Kripto | 4h | long + short | BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, SUIUSDT, HBARUSDT |
| ABD hisse | **1d** | **sadece long** | AAPL, AMZN, INTC, META, NVDA |

**Enstrüman başına ayrı parametre YOK.** Sadece bu iki venue ayarı farklı ve ikisi de
piyasa yapısından geliyor:

- **Bar:** ABD borsası günde 6,5 saat açık, 4 saatlik ızgara bölmüyor. Ölçümde günlük
  barlar saatliği her konfigürasyonda geçti (sadece-long 3,5×/1:4 → holdout PF 0,64 vs **1,51**).
- **Yön:** Hisse fiyatları uzun vadede yukarı sürüklenir; tek isim açığa satmak buna karşı
  savaşmaktır. Sadece-long, dört karşılaştırmanın dördünde de long+short'u geçti.

---

## 5. STRATEJİ (kesin kurallar)

Her enstrümanda **birebir aynı**. Göstergeler o enstrümanın kendi kapanışlarından:
`EMA21`, `EMA50`, `EMA200`, `RSI14` (Wilder), `ATR14` (Wilder).

- **Rejim:** `EMA50 > EMA200` → sadece long; `EMA50 < EMA200` → sadece short.
  Sadece-long bir venue'de ayı rejimi **kenarda durmak** demektir, short demek değil.
- **Giriş LONG:** kapanış EMA21'i **yukarı KESER** (seviye değil, *kesişim anı*)
  **VE** `RSI14 > 52` **VE** boğa rejimi **VE** o enstrümanda açık pozisyon yok.
- **Giriş SHORT:** aynısının aynası — aşağı kesişim **VE** `RSI14 < 48` **VE** ayı rejimi.
- **Ölü bant:** `48 ≤ RSI ≤ 52` iken hiçbir yöne işlem yok.
- **Stop:** giriş ∓ `3.5 × ATR14`
- **Hedef:** stop mesafesinin **4 katı** (1:4)
- **Acil çıkış:** pozisyon açıkken rejim dönerse bir sonraki değerlendirmede kapat.
- **Boyut:** `qty = (equity × 0.015) / (3.5 × ATR14)` → işlem başına sermayenin **%1,5**'i risk.
- Enstrüman başına en fazla **1** pozisyon.

> Stop çarpanı neden 3,5? 2,5 ile başladık; iki bağımsız yöntem (enstrüman bazlı ızgara
> ve paylaşımlı tarama) daha genişini işaret etti. Tek paylaşımlı değişiklik olarak
> uygulandığında holdout toplamı **−3.980 $'dan +653 $'a** döndü. Mekanizma: dar stop
> normal gürültünün içinde kalıp hareket gelişmeden vuruluyor. **Riski artırmaz** —
> boyut stop mesafesinden türediği için geniş stop otomatik olarak daha az alır.

---

## 6. SERMAYE MODELİ — projenin can alıcı kısmı

**TEK paylaşımlı 10.000 $.** Enstrüman başına ayrı hesap YOK.

- Açık her pozisyon **giriş notional'ını bağlar**.
- `kullanılabilir = gerçekleşen_equity − Σ(açık pozisyon notional)`
- Bir sinyal ancak notional'ı kullanılabilir bakiyeye sığıyorsa alınır.
- **Sığmıyorsa işlem AÇILMAZ** ve `missed_opportunities` tablosuna yazılır:
  hangi enstrüman, hangi yön, ne kadar gerekiyordu, elde ne vardı, planlanan giriş/stop/hedef.

Bu bir hata durumu değil, **ölçmek istediğimiz veri.** Sabit bütçenin bize neye mal
olduğunu ancak böyle öğrenebiliriz.

**Sıralama kuralları (önemli):**
- Tüm enstrümanların **çıkışları**, herhangi bir **girişten önce** işlenir — yoksa bu turda
  serbest kalan sermaye kullanılamaz.
- Sermaye kıtken girişler **bar kapanış zamanına göre** sıralanır (en erken sinyal önce).
  Config dosyasındaki sıraya göre gitmek bir enstrümanı sessizce ayrıcalıklı yapar.

---

## 7. KÂĞIT DOLUM SİMÜLASYONU (muhafazakâr ol)

- Giriş: bar kapanışı ± **%0,05 kayma**, hep işlemin aleyhine.
- Her dolumda **%0,1 komisyon** (giriş ve çıkış ayrı).
- Bir bar hem stop'a hem hedefe değdiyse → **stop önce vurdu** varsay (en kötü senaryo).
- **Boşluk (gap) farkındalığı:** bar stop'un ÖTESİNDE açılıyorsa dolum **açılış fiyatından**
  olur, stop fiyatından değil. Hisselerde gece boşlukları gerçek; stop fiyatını iddia etmek
  sonuçları şişirir. Hedeflerde lehe boşlukta bile hedef fiyatı kullan (asimetri muhafazakâr kalsın).
- Başlangıç sermayesi 10.000 $ sanal.

---

## 8. RİSK MOTORU

Yeni **girişleri** durdurur, açık pozisyon yönetimi devam eder. Hesap düzeyinde:
- Günlük gerçekleşen zarar ≥ %4
- 6 ardışık kayıp
- Tepe equity'den ≥ %10 düşüş

Durum `account_state`'te, dashboard'da sebebiyle görünür. Sıfırlama ayrı bir admin
endpoint'inden (`ADMIN_SECRET`) yapılır ve streak/peak/günlük tabanı da yeniden kurar.

> ⚠ Bu eşikler tek enstrüman için tasarlandı. 11 enstrümanla "6 ardışık kayıp" çok daha
> sık tetiklenir. İlk halt geldiğinde gözden geçir.

---

## 9. DASHBOARD (herkese açık, salt okunur, koyu tema, mobil uyumlu)

1. **Paylaşımlı hesap şeridi:** equity, toplam getiri, dağıtılan, kullanılabilir + kullanım çubuğu.
2. **Venue sekmeleri** (Kripto / ABD) ve enstrüman rozetleri. Seçim URL'de (`?i=BTCUSDT`)
   tutulsun — link paylaşılabilir olur, JavaScript gerekmez.
3. **Seçili enstrüman için "Son karar" kartı:**
   - Mum penceresi **açık yazsın**: `07:00 → 11:00 · karar kapanışta alındı`.
     (Mumu sadece açılış saatiyle etiketlemek okuyucuyu yanıltır.)
   - O anki tüm gösterge değerleri.
   - **Koşul koşul ✓/✗ listesi** — hangi kapı geçti, hangisi eledi.
   - **"Ne değişmeli" bölümü:** işlem açılması için gerekeni SAYIYLA söyle
     ("RSI 52'nin üstüne çıkmalı; 48,7'ydi — 3,3 puan eksik").
4. **Fiyat grafiği:** mumlar + EMA21/50/200 + altta RSI paneli (48-52 ölü bandı taralı),
   giriş/çıkış işaretleri, son kararın alındığı mum vurgulu.
5. **Kaçan fırsatlar tablosu.**
6. **İşlem günlüğü** (her işlem, gizli hiçbir şey yok) ve **equity eğrisi**.
7. **Bot durumu:** son başarılı çalışma + yaşı, bir sonraki kontrol, halt durumu.
   Kalp atışı 2,5 saatten eskiyse **"scheduler down"** bandı çıksın.
8. **Strateji kartı** + `⚠ KÂĞIT ÜZERİNDE — eğitim amaçlı, yatırım tavsiyesi değil`.

Saatler İstanbul saatiyle gösterilsin; saklama UTC'de kalsın. Zaman dilimi **tek yerden**
gelsin ve `Intl`'e açıkça verilsin (runtime saatinden okuma — sunucu/tarayıcı/CI farklı sonuç verir).

---

## 10. ÖLÇÜM ARAÇLARI (asıl kalıcı değer burada)

İki CLI script yaz. İkisi de **salt okunur** — veritabanına dokunmaz, canlı botu etkilemez.

**`npm run backtest`** — varyant karşılaştırma.
- Geçmişi **eğitim / saklı dönem** olarak ikiye böler (70/30) ve İKİ tabloyu da basar.
- Kaç varyant denendiğini yazdırır (seçim yanlılığını görünür kılar).
- **Canlı dolum kodunu paylaşır**, kopyalamaz. Bir test, baseline varyantın motorun
  `decideEntry`'siyle her mumda AYNI kararı verdiğini doğrulasın — yoksa backtest,
  botun çalıştırmadığı bir stratejiyi ölçer.

**`npm run optimize`** — enstrüman bazlı parametre çalışması.
- Izgarayı **sadece eğitim yarısında** tarar, kazananı kilitler, **saklı dönemde** yargılar.
- Cevapladığı soru "en iyi parametre ne?" değil (ızgara her zaman bir cevap üretir),
  **"enstrüman bazlı ayar numune dışında hayatta kalıyor mu?"**

**Lookahead koruması yapısal olsun ve test edilsin:** göstergeler nedensel; günlük rejim
sadece KAPANMIŞ günleri görür; Donchian penceresi mevcut barı dışlar; giriş sinyal barının
kapanışında, çıkışlar bir sonraki bardan itibaren; trailing stop ancak türetildiği bar
kapandıktan sonra hareket eder.

---

## 11. TUZAKLAR — bunları okumadan başlama

Hepsini bizzat yaşadık. Her biri **sessizce** ilerler.

### 11.1 EMA200 ısınması (en pahalısı)
EMA, ilk `period` değerin SMA'sıyla tohumlanır ve tohumun etkisi `(1−2/(period+1))^n` ile
söner. 320 mum çekmek EMA200'e tohumdan sonra sadece 120 adım bırakır → **değerin ~%30'u
hâlâ keyfi tohum.** Canlı veride gerçek EMA200'den **318 puan (%0,5)** sapıyordu ve
**son 121 mumun 44'ünde (%36) rejimi TERS gösteriyordu.**

→ `fetchLimit = 1000` (Binance tek istek maksimumu). `minCandles` de aynı seviyede olsun.
→ **Kural:** ısınma penceresi en yavaş EMA periyodunun **en az 4 katı** olmalı. Bunu bir
   testle sabitle — şartname "≥300 mum" diyordu ve biz ona uyduk, yine de yanlıştı.

### 11.2 GitHub Actions cron'u ateşlemiyor
İki farklı cron ifadesiyle saatlerce **sıfır** zamanlanmış çalışma oldu; her
`workflow_dispatch` başarılıydı. Actions etkin, workflow `active`, YAML geçerli, dosya
varsayılan branch'te, repo public. Sorun tamamen GitHub tarafında.
→ **cron-job.org** kullan (ücretsiz, özel başlık destekler). Metot POST, başlık
   `Authorization: Bearer <CRON_SECRET>`, saatlik. Workflow'u yedek olarak bırakabilirsin.
→ Saat başını (`:00`) seçme — mum tam o saniye kapanıyor, yarış durumu oluşur. `:23` gibi bir dakika seç.

### 11.3 Bağlantı havuzu tükenmesi
Dashboard 9 ayrı sorgu açıyordu. Supabase ücretsiz pooler'ıyla, saatlik değerlendirme de
bağlantı tutarken, sayfa yüklemelerinin **yaklaşık yarısı 40 saniyede zaman aşımına**
uğradı. Tükenmiş havuz **hata vermez, bekler** — bu yüzden 500 değil takılma görürsün.
Üstelik enstrümana özgü görünür (bazıları açılır, bazıları açılmaz) ama rastgeledir.
→ Sayfanın ihtiyacı olan her şeyi **tek `json_build_object`** ile çek. Havuz `max: 3`.

### 11.4 Motorun 10 saniyeyi aşması
12 enstrüman × 4 gidiş-dönüş = ~50 sorgu → **22-32 saniye.**
→ Ağ çağrılarını `Promise.allSettled` ile paralelleştir; okumaları 3 sorguya indir;
   yazmaları tablo başına tek ifadeye topla. Sonuç: **1,1 saniye.**
→ jsonb'yi toplu insert ederken `jsonb_to_recordset` kullan.
→ Her turda 120 mum yazma — sadece YENİ mumları yaz.

### 11.5 Zaman dilimi değişimi saklı veriyi bozar
Bir venue'nün barını 1h'ten 1d'ye çevirdiğinde iki şey birden bozulur:
mum tablosunda **iki bar uzunluğu karışır** (o tablodan okunan her gösterge yanlış olur),
ve eski `last_candle_time` yeni barların açılışının **İLERİSİNDE** kalıp enstrümanı
**sonsuza kadar dondurur** ("bu mumu zaten değerlendirdim").
→ Seed, saklı mumların **gerçek aralığını** ölçüp beklenenle karşılaştırsın ve
   uyuşmazsa o enstrümanın mumlarını silip yeniden kursun. Kaydedilmiş bir etikete güvenme —
   etiket eklenmeden önce yazılmış satırları kaçırır.

### 11.6 Vercel deploy'u push'ları görmüyor
Vercel'in GitHub uygulaması "Only select repositories" iznindeyse repoyu **göremez** ve
push'lar deploy tetiklemez. Ayrıca Vercel'deki **proje adı** repo adı değildir — karıştırma.
→ `github.com/settings/installations` → Vercel → repo erişimini ver.

### 11.7 JSON'da tarih tipi yok
Her şeyi tek JSON sorgusuna taşıyınca zaman damgaları **string** gelir. `getTime()` çağıran
kod sessizce `NaN` üretir.  → Parse ederken açıkça `Date`'e çevir.

### 11.8 `as const` literal tipleri
`CONFIG.account.startingEquity` `as const` altında `10000` literal tipindedir; `let equity =
...` genişlemez ve `+=` derlenmez. → Açıkça `: number` yaz.

### 11.9 Ayrı ayrı çalışan araçlar ayrışır
Backtest kendi simülasyonunu kopyalarsa zamanla motordan sapar ve **botun çalıştırmadığı
bir stratejiyi** ölçmeye başlar. → Dolum kodunu paylaş; denklik testi yaz.

---

## 12. TESTLER (~80 adet)

- Gösterge matematiği **bilinen değerlere** karşı: RSI'ı Wilder'ın yayınlanmış örneğiyle
  doğrula; EMA/ATR için elle hesaplanmış vakalar.
- Kesişimin **olay** olduğunu doğrula (üstünde olmak yetmez).
- Dolum: aynı barda stop+hedef → stop; gap'te açılıştan dolum; ücret/kayma yönü.
- **Boyut invaryantı:** stop genişlerse miktar küçülür, dolar riski sabit kalır.
- Isınma koruması (§11.1) — eski pencerenin hatalı olduğunu da göstersin.
- Backtest ↔ motor denkliği. **Sentetik seriye tohumlu gürültü ekle** — pürüzsüz seri
  EMA21'i hiç kesmez, test boş yere geçer.
- Lookahead korumaları.
- Zaman dilimi formatlaması makinenin yerel saatinden bağımsız olmalı.

---

## 13. TESLİMATLAR

1. Repo + README (kurulum, env değişkenleri, deploy, zamanlayıcı, tuzaklar).
2. Seed script: tüm enstrümanları geriye doldur, hesabı **flat 10.000 $** başlat,
   zaman dilimi değişimi geçişini yönet.
3. Sade, mobil uyumlu koyu tema dashboard.
4. `npm run backtest` ve `npm run optimize`.
5. Zamanlayıcı kurulumu README'de adım adım.

---

## 14. YAPILMAYACAKLAR

- Canlı emir kod yolu, borsa/broker anahtarı, emir imzalama — **hiçbiri**.
- Versiyon yükseltmeden strateji parametresi değiştirme. Her işlem/sinyal
  `strategy_version` taşısın; farklı versiyonların sonuçları **asla** karıştırılmasın.
- Ücretli servis.
- **Enstrüman başına parametre uydurma.** Denedik: eğitimde seçilenler saklı dönemde
  11'de 8 kez baseline'ı geçti ama binom testi **p ≈ 0,11** verdi (anlamlı değil) ve
  ayarlanmış portföy hâlâ zarardaydı. Izgaranın bulduğu şey enstrüma özgü ayar değil,
  ortak bir yöndü.
- Backtest sonucuna bakıp strateji seçme. Bizim ilk turumuzda `donchian 20` eğitim
  yarısının **en iyisi** (+6.814 $), saklı dönemin **en kötüsüydü** (−1.166 $).

---

## 15. GERÇEKÇİ BEKLENTİ

Dürüst olmak gerekirse: bu kural setinin dayanıklı bir edge'i olduğuna dair kanıtımız yok.
10 kripto sembolünde birleşik profit factor **1,03** çıktı (maliyetlerden sonra sıfır).
Örneklem büyüdükçe sonuç 1,00'e yakınsıyor — gerçek bir edge'in değil, gürültünün imzası.

Ayrıca kâğıt üzerindeki test bu işlem sıklığında edge'i **asla istatistiksel olarak
kanıtlayamaz**: enstrüman başına yılda ~27 işlemde, 30 işlemde bile kazanma oranının güven
aralığı zararlıdan kârlıya kadar her şeyi kapsar.

**O yüzden iki soruyu ayır:**
- *"Edge var mı?"* → backtest cevaplar (uzun geçmiş, saklı dönem disipliniyle).
- *"Canlı sistem stratejiyi doğru uyguluyor mu?"* → kâğıt testi bunun içindir ve
  ~10-15 işlem yeter. Bizde bir hafta içinde EMA200 hatasını yakaladı — herhangi bir
  istatistiksel sonuçtan kıymetliydi.

Kalıcı değer stratejide değil, **ölçüm çerçevesinde.** Bir fikri dakikalar içinde,
kendini kandırmadan eleyebilmek — asıl teslim edilen şey bu.
