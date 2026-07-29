# V13.4 Binance Futures Testnet Bot

Bu servis V13.3 işlem mantığını gerçek Binance USDⓈ-M herkese açık piyasa
akışıyla sunucu tarafında çalıştırır ve **yalnız Binance USDⓈ-M Futures
Testnet** için emir zinciri hazırlar. V13.4 sürüm adı, strateji değişikliğini
değil WebSocket tabanlı tarama altyapısını ifade eder.

Tarama evreni canlı `!ticker@arr` WebSocket akışından oluşturulur: likidite
filtresini geçen **15 en çok yükselen + 10 en çok düşen + 5 en yüksek hacimli**
USDT perpetual sözleşme seçilir. Gruplar arasında çakışan semboller yalnız bir
kez taranır; benzersiz sembol sayısı bu nedenle en fazla 30 olabilir.

## Güvenlik

- Varsayılan `DRY_RUN=true` ve `BOT_ENABLED=false`.
- İlk sürüm `testnet.binancefuture.com` dışındaki API adresini reddeder.
- API anahtarları yalnız ortam değişkenlerinden okunur.
- Girişten sonra gerçek `STOP_MARKET closePosition=true` emri doğrulanamazsa pozisyon acil market emriyle kapatılır.
- Toplam 5 işlem ve aynı anda 1 pozisyon sınırı kalıcı state içinde tutulur.
- Peş peşe 2 zarar veya günlük zarar limiti kill switch'i tetikler.
- **Açık pozisyon izleme**: her 60 saniyede bir sembolün 15D+1S trendi, BTC bağlamı ve OI değişimi yeniden değerlendirilir.
- **Otomatik yönetim aksiyonu** (`MANAGEMENT_ENABLED=true`, varsayılan açık): stop yalnız sıkılaştırılır (breakeven → +1R), asla gevşetilmez; yapı ciddi şekilde bozulursa pozisyon erken kapatılır. Yeni stop emri başarısız olursa mevcut stop yerinde bırakılır. `MANAGEMENT_ENABLED=false` yaparsan bot yalnız izler, hiçbir emri değiştirmez/kapatmaz — sinyaller yine `state.openTrade.managementSignal` altında görünür.
- Stop değişiminde önce yeni `STOP_MARKET` emri gönderilip `NEW` durumu doğrulanır, ardından eski stop iptal edilir; iki yönetim döngüsünün aynı anda emir değiştirmesi kilitle engellenir.
- Gerçek market fill'i aday fiyatından en fazla `0.35R` sapabilir. Kabul edilen fill sonrasında SL ve TP seviyeleri gerçek ortalama fiyata yeniden bazlanır; daha büyük sapmada pozisyon acil kapatılır.
- Açık mumun zamana göre normalize edilmiş canlı hacim temposu izlenir. Güçlü ve hizalı katılımda yalnız %40 runner TP3 `3R`'a uzatılabilir; hacim zayıflarsa `2R`'a çekilebilir. Savunmacı moda geçen runner yeniden genişletilmez.

## Çalıştırma

1. `.env.example` değerlerini barındırma servisinin Environment/Secrets ekranına girin.
2. İlk çalıştırmada `DRY_RUN=true`, `BOT_ENABLED=false` bırakın.
3. `npm start`
4. Telefonda servisin URL'sini açın ve dashboard token ile giriş yapın.

API anahtarlarını kaynak koda, GitHub'a veya sohbet içine yazmayın.

## Kanıt seviyeleri

- `DRY_RUN`: Sinyal ve hesaplanan emir paketi var; Binance'e emir gitmez.
- `TESTNET_READY`: Testnet kimlik doğrulaması ve hesap kontrolleri geçti.
- `ENTRY_FILLED`: Binance Testnet giriş order ID ve FILLED durumu var.
- `PROTECTED`: Stop order ID sorgulanıp `NEW` durumu doğrulandı.

Bot yalnız `PROTECTED` durumunu başarıyla açılmış ve korunmuş işlem kabul eder.

## V13.4 canlı veri mimarisi

- 24 saat ticker, mark/funding, bookTicker ve 15m/1h/4h mum güncellemeleri
  resmi `wss://fstream.binance.com/ws` akışından gelir.
- REST yalnız ilk mum geçmişini yüklemek, 15 dakikada bir OI/taker geçmişini
  yenilemek ve Testnet emirlerini yönetmek için kullanılır.
- Aktif tarama evreni değiştiğinde eski stream abonelikleri kapatılır; bağlantı
  koparsa üstel gecikmeyle yeniden bağlanır ve abonelikler geri yüklenir.
- HTTP 418/429 durumunda REST bekleme süresi korunur; WebSocket akışı çalışmaya
  devam eder fakat eksik/zamanı geçmiş kanıtla yeni işlem açılmaz.
