# V13.2 Tarayıcı → Binance Bot Proje Hafızası

## Mevcut ürün

- Motor: `V13.2_STRUCTURE_EXECUTION`
- Canlı arayüz: https://tarayici-v13.batuhansydm.chatgpt.site
- GitHub Pages: https://batuhansaydamm.github.io/-kripto-futures-tarayici/
- Repo: `batuhansaydamm/-kripto-futures-tarayici`
- Kaynak: tek HTML tarayıcı + Fırsat Radarı

## Korunacak analiz ilkeleri

- LONG / SHORT / NO TRADE kararı.
- Pullback, momentum ve reversal aileleri ayrı izlenir.
- HTF yön, piyasa yapısı, BOS/CHoCH, wick, hacim, OI, funding ve BTC bağlamı birlikte değerlendirilir.
- Momentum girişi mum tepesinden market kovalamaz; starter + EMA7 retest/add yaklaşımı kullanır.
- TP seviyeleri salt sabit R değildir; swing, günlük/haftalık seviyeler ve VWAP bariyerlerini dikkate alır.
- Gösterilen geçmiş erişim yüzdeleri olasılık değildir; OOS tarihsel frekanstır.
- Kanıt yetersizse sistem bunu açıkça belirtir.

## Kilitlenmiş pilot kararları

- Binance USDⓈ-M Futures Testnet.
- Telefon üzerinden yönetim, bulutta 7/24 backend.
- Toplam 5 işlemden sonra kalıcı duruş.
- İşlem başına 50 USDT marjin.
- x10 ISOLATED.
- Aynı anda maksimum 1 pozisyon.
- One-way mode.
- İlk güvenlik fazında doğrulanmış radar sinyali sonrası market entry.
- Stop borsada doğrulanamazsa reduce-only market acil kapatma ve kill switch.
- API key frontend, public HTML, GitHub Pages veya repository içine konulmaz.

## Uygulanan backend güvenlikleri

- Testnet dışındaki base URL uygulama başlangıcında veto edilir.
- `LIVE_TRADING=true` uygulama başlangıcında veto edilir.
- 50 USDT / x10 / isolated / 1 açık / 5 toplam parametreleri kod seviyesinde kilitlidir.
- Sembol `TRADING + PERPETUAL + USDT` ve filtre kontrolünden geçer.
- Quantity ve stop Binance stepSize/tickSize kurallarına yuvarlanır.
- One-way mode doğrulanır.
- Isolated ve x10 Binance üzerinde ayarlanıp doğrulanır.
- Duplicate `signalId` engeli ve benzersiz `clientOrderId` kullanılır.
- Entry sonrası `STOP_MARKET + closePosition=true` gönderilir ve order sorgusuyla doğrulanır.
- Stop doğrulanamazsa pozisyon market ile acil kapatılır.
- Kalıcı JSON durum dosyası toplam işlem sayacını ve sinyal idempotency bilgisini saklar.
- Restart sırasında Binance açık pozisyonlarıyla uzlaştırma yapılır.
- Günlük zarar, peş peşe zarar, API devre kesicisi ve manuel kill switch kapıları vardır.

## Bilinçli olarak sonraki faza bırakılanlar

- V13.2 radarının backend'e güvenli webhook/polling entegrasyonu.
- 30/30/40 TP emirleri ve runner yönetimi.
- Gerçekleşen PnL üzerinden günlük zarar ve consecutive-loss sayaçlarının otomatik güncellenmesi.
- Mobil dashboard'da bot aç/kapat, pozisyon, emir ve olay günlüğü ekranları.
- Cloud provider seçimi, persistent volume, HTTPS domain ve IP whitelist kurulumu.
- Testnet entegrasyon testleri ve kasıtlı stop-rejection senaryosu.

## Değişmez kural

Analiz motorunun karar mantığı emir yürütücüsüne taşınırken sadeleştirilmeyecek veya farklı bir stratejiyle değiştirilmeyecek. Backend yalnız doğrulanmış V13.2 sinyalini güvenli biçimde yürütür.
