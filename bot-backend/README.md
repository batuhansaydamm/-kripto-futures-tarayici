# V13.2 Binance Futures Testnet Bot

Bu servis V13.2 Fırsat Radarı kurallarını gerçek Binance USDⓈ-M herkese açık piyasa verisiyle sunucu tarafında çalıştırır ve **yalnız Binance USDⓈ-M Futures Testnet** için emir zinciri hazırlar.

## Güvenlik

- Varsayılan `DRY_RUN=true` ve `BOT_ENABLED=false`.
- İlk sürüm `testnet.binancefuture.com` dışındaki API adresini reddeder.
- API anahtarları yalnız ortam değişkenlerinden okunur.
- Girişten sonra gerçek `STOP_MARKET closePosition=true` emri doğrulanamazsa pozisyon acil market emriyle kapatılır.
- Toplam 5 işlem ve aynı anda 1 pozisyon sınırı kalıcı state içinde tutulur.
- Peş peşe 2 zarar veya günlük zarar limiti kill switch'i tetikler.
- **Açık pozisyon izleme**: her 60 saniyede bir sembolün 15D+1S trendi, BTC bağlamı ve OI değişimi yeniden değerlendirilir.
- **Otomatik yönetim aksiyonu** (`MANAGEMENT_ENABLED=true`, varsayılan açık): stop yalnız sıkılaştırılır (breakeven → +1R), asla gevşetilmez; yapı ciddi şekilde bozulursa pozisyon erken kapatılır. Stop güncellemesi sırasında yeni emir başarısız olursa pozisyon korumasız kalmaz, otomatik acil kapatılır. `MANAGEMENT_ENABLED=false` yaparsan bot yalnız izler, hiçbir emri değiştirmez/kapatmaz — sinyaller yine `state.openTrade.managementSignal` altında görünür.

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
