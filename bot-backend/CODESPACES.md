# V13.3 Testnet botunu GitHub Codespaces'te çalıştırma

Bu yöntem bilgisayara kurulum yapmaz. Binance anahtarları repoya veya frontend'e yazılmaz.

## 1. Codespaces secrets

GitHub reposunda **Settings → Secrets and variables → Codespaces → New repository secret** yolundan şu üç secret'ı ekleyin:

- `BINANCE_API_KEY`: Binance Futures Testnet API key
- `BINANCE_API_SECRET`: Binance Futures Testnet secret
- `DASHBOARD_TOKEN`: en az 16 karakterlik panel anahtarı

## 2. Codespace oluşturma

Repo ana sayfasında **Code → Codespaces → Create codespace on main** seçin.

İlk açılışta bağımlılıklar kurulur ve 39 test çalışır. Ardından bot arka planda başlar; port 3000 için **V13.3 Bot Paneli** bağlantısı otomatik açılır. Açılmazsa **Ports** sekmesinden port 3000 yanındaki dünya/bağlantı ikonunu kullanın.

## 3. Güvenli test sırası

1. Panel anahtarını girin.
2. `TESTNET HESABINI DOĞRULA` düğmesine bir kez basın.
3. `TESTNET EMİR`, `BOT KAPALI` ve `KORUMA NORMAL` durumlarını doğrulayın.
4. `BOTU AÇ` düğmesine basın.
5. `ŞİMDİ TARA` düğmesine en fazla bir kez basın; sonraki taramalar 15 dakikada bir otomatik yapılır.

## Sınırlar

- Toplam en fazla 5 Testnet işlemi
- Aynı anda en fazla 1 açık pozisyon
- İşlem başına 50 USDT isolated marjin, x10
- İki ardışık zarar veya 100 USDT günlük zarar sonrası durma
- HTTP 418/429 alınırsa devre kesici botu kapatır
- Codespaces boşta kalma süresi GitHub ayarlarında en fazla 4 saate çıkarılabilir; Codespace durunca bot da durur

Log gerekirse Codespaces terminalinde:

```bash
tail -f /tmp/v13-bot.log
```
