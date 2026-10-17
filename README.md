# kwekol — как поднять бесплатный сервер навсегда

Сам сервер уже готов к хостингу: он
- отдаёт сам сайт (`/`) и API с одного адреса,
- умеет хранить данные во внешнем бесплатном хранилище **Upstash** (чтобы аккаунты не терялись),
- умеет слать письма с кодом через бесплатный HTTP-API **Brevo** (или Resend) — работает там, где SMTP закрыт,
- слушает `0.0.0.0` и берёт порт из переменной `PORT`.

Выбери один из трёх вариантов.

---

## Вариант 1. Render + Upstash + Brevo (рекомендую)

Бесплатно, HTTPS выдаётся автоматически, свой компьютер держать включённым не нужно.
Минус: бесплатный хостинг «засыпает» при простое — первый заход после паузы ~30–60 сек.

### Что завести (всё бесплатно, регистрация по email)
1. **GitHub** — https://github.com → аккаунт.
2. **Render** — https://render.com → Sign up через GitHub.
3. **Upstash** — https://upstash.com → **Create Database** (тип Redis, любой регион, free).
   Открой базу → вкладка **REST API** → скопируй `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN`.
4. **Brevo** — https://brevo.com → **Senders** → добавь и подтверди email отправителя (свой обычный, напр. Gmail).
   Затем **SMTP & API → API Keys** → создай ключ → это `BREVO_API_KEY`.

### Шаги
1. На своём ПК запусти сборку:
   ```
   powershell -ExecutionPolicy Bypass -File make-bundle.ps1
   ```
   Появится папка `bundle`.
2. Залей содержимое `bundle` в новый репозиторий GitHub
   (на сайте: **New repository** → **uploading an existing file** → перетащи всё из `bundle` → Commit).
3. В Render: **New +** → **Blueprint** → выбери свой репозиторий → **Apply**.
   Render сам подставит настройки из `render.yaml`.
4. Render попросит значения переменных — вставь:
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — из Upstash;
   - `BREVO_API_KEY` — из Brevo;
   - `MAIL_FROM` — в формате `kwekol <твой@email>` (email **должен совпадать** с подтверждённым Sender в Brevo).
5. Подожди ~2 минуты, пока соберётся. Твой адрес: `https://<имя>.onrender.com`.
6. Открой адрес, зарегистрируйся и войди. **Этот же адрес отправь маме** — она тоже регистрируется на нём.

> Если письмо с кодом не приходит: проверь, что `MAIL_FROM` = подтверждённый Sender в Brevo и что код не в «Спаме».

---

## Вариант 2. Свой ПК + Cloudflare Tunnel (мгновенно, без облака)

Бесплатно и без регистраций в облаке, данные остаются у тебя. Работает, пока включён ПК.
Адрес вида `https://xxxx.trycloudflare.com` (на бесплатном тарифе меняется при перезапуске туннеля).

1. Установи cloudflared:
   ```
   winget install --id Cloudflare.cloudflared
   ```
2. Запусти:
   ```
   powershell -ExecutionPolicy Bypass -File ..\kwekol-tunnel\start-kwekol.ps1
   ```
   Скрипт поднимет сервер и туннель и покажет публичный адрес — отправь его маме.
3. Чтобы работало само при включении ПК:
   ```
   powershell -ExecutionPolicy Bypass -File ..\kwekol-tunnel\install-autostart.ps1
   ```

> Для постоянного адреса (не меняется) нужен бесплатный аккаунт Cloudflare + свой домен и «named tunnel».
> Скажи — настрою.

---

## Вариант 3. Свой бесплатный VPS (Oracle Always Free / GCP e2-micro)

Работает круглосуточно и не засыпает. Нужен домен (можно бесплатный на duckdns.org).

1. Создай бесплатную VM (Ubuntu) в Oracle Cloud **Always Free** или GCP **e2-micro**.
2. Скопируй на неё папку `bundle` (например, через `scp` или drag&drop в файловом менеджере).
3. Домен должен указывать A-записью на IP сервера.
4. На сервере:
   ```
   sudo bash install-vps.sh your.domain.com
   ```
    (при первом запуске создастся `.env` — впиши `BREVO_API_KEY` и `MAIL_FROM` и запусти команду ещё раз.)
5. Открой `https://your.domain.com`. HTTPS Caddy получит автоматически.

---

## Частые вопросы

- **Почему письма через Brevo, а не SMTP?** На хостингах SMTP-порты часто закрыты. HTTP-API Brevo/Resend работает всегда.
- **Аккаунты не пропадут?** С включённым Upstash — нет, они хранятся в облаке. Без него на бесплатных хостингах с временным диском аккаунты стираются при перезапуске.
- **Нужен ли HTTPS?** Да — без него браузер не даст доступ к микрофону/камере (звонки). Render/Caddy дают HTTPS сами, у туннеля он тоже есть.
