# V13.2 Binance Futures Bot Backend

Bu klasör mevcut `index.html` analiz motorundan ayrıdır. Frontend yalnızca dashboard/sinyal kaynağıdır; Binance API secret hiçbir zaman tarayıcıya gönderilmez.

## Pilot kilitleri

- Binance USDⓈ-M Futures Testnet
- Toplam 5 işlem
- İşlem başına 50 USDT marjin
- x10 isolated
- Aynı anda maksimum 1 açık pozisyon
- One-way mode zorunlu
- Market entry (yalnız V13.2 tarafından doğrulanmış sinyal geldikten sonra)
- Pozisyonun hemen ardından borsada `STOP_MARKET + closePosition=true`
- Stop sorgulanıp doğrulanamazsa reduce-only market acil kapatma ve kill switch
- `LIVE_TRADING=true` bu fazda uygulamayı başlatmaz

## Kurulum

```bash
cd backend
cp .env.example .env
# .env içine yalnız Binance Futures Testnet anahtarlarını yazın.
node src/server.mjs
```

Node.js 20+ gereklidir. Harici npm paketi kullanılmaz.

## Mobil dashboard API

`DASHBOARD_TOKEN` tanımlandıysa aşağıdaki korumalı endpoint'lerde `Authorization: Bearer <token>` gönderilmelidir.

- `GET /health` — secretsiz sağlık kontrolü
- `GET /api/status` — yerel durum + Binance pozisyon uzlaştırması
- `POST /api/signals/execute` — doğrulanmış sinyali yürütür
- `POST /api/kill-switch` — yeni girişleri kalıcı olarak durdurur

Örnek Testnet sinyali:

```json
{
  "signalId": "radar-BTCUSDT-20260728T110000Z",
  "symbol": "BTCUSDT",
  "side": "LONG",
  "referencePrice": 118000,
  "stopPrice": 116900
}
```

`referencePrice`, quantity hesabında kullanılan radar anlık fiyatıdır. Emir market gönderildiği için gerçek fill farklı olabilir. TP emirleri bu ilk güvenlik PR'ına bilerek eklenmedi; önce entry → stop → doğrulama → acil kapatma zinciri Testnet'te kanıtlanacaktır.

## Bulut dağıtımı

Backend secret destekleyen bir container/VPS servisine kurulmalıdır. `STATE_FILE` kalıcı diske bağlanmalıdır; aksi halde restart sonrası 5 işlem sayacı kaybolur ve bot güvenlik amacıyla yeniden devreye alınmamalıdır.

GitHub Pages yalnız mevcut statik arayüzü barındırır; bu backend GitHub Pages üzerinde çalışmaz.

## Test kapıları

1. Testnet hesabı One-way mode olmalı.
2. API key yalnız Futures Testnet trade yetkisine sahip olmalı; withdrawal/transfer yetkisi bulunmamalı.
3. `/api/status` açık pozisyonları doğru göstermeli.
4. Bir Testnet sinyalinde entry ve stop order Binance tarafında görünmeli.
5. Geçersiz stop senaryosunda pozisyon acil kapanmalı ve kill switch açılmalı.
6. Aynı `signalId` ikinci kez reddedilmeli.
7. Açık pozisyon varken ikinci sinyal reddedilmeli.
8. Beşinci entry sonrası altıncı sinyal kalıcı olarak reddedilmeli.
