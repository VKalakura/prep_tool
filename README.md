# Offer Tools

Внутрішній веб-інструмент для підготовки HTML-лендінгів (офферів) до деплою на трекінгову систему **Keitaro**.
Два режими: **Standard** (баєри/копірайтери) і **Developer** (розробники).

Повний опис логіки, pipeline та API — у [`ДОКУМЕНТАЦІЯ.md`](./ДОКУМЕНТАЦІЯ.md).

---

## Вимоги

- **Node.js ≥ 20.18.1** (потрібно для cheerio 1.2)
- **nvm** (рекомендовано) — версія зафіксована у `.nvmrc`
- Ключ **xAI (Grok)** — для AI-функції «Paste & place» у Content Editor

---

## Швидкий старт

### 1. Клонувати з Bitbucket

```bash
git clone git@bitbucket.org:<workspace>/<repo>.git offer-tools
cd offer-tools
```

### 2. Встановити версію Node

```bash
nvm use            # підхопить версію з .nvmrc
# якщо немає — nvm install
```

### 3. Встановити залежності

```bash
npm install
npm --prefix server install
npm --prefix client install
```

> Стиснення зображень (опціонально): `npm --prefix server install sharp`

### 4. Налаштувати оточення

```bash
cp server/.env.example server/.env
```

Відредагувати `server/.env` і вписати ключ:

```env
XAI_API_KEY=ваш_реальний_ключ_з_console.x.ai
# XAI_MODEL=grok-4.20-0309-non-reasoning   # опціонально — фіксація моделі
# XAI_API_BASE=https://api.x.ai/v1         # опціонально
```

> ⚠️ `server/.env` **у .gitignore** — реальні ключі ніколи не комітимо. Для нових змінних оновлюй `server/.env.example`.

### 5. Запустити

```bash
npm run dev
```

Скрипт перевірить версію Node, звільнить порти 3001/5173, підніме API і UI.

| Сервіс | URL |
|---|---|
| UI | http://localhost:5173 |
| API | http://localhost:3001 |

---

## Команди

| Команда | Дія |
|---|---|
| `npm run dev` | Dev-режим (API + UI з hot-reload) |
| `npm run build` | Production-збірка клієнта в `client/dist/` |
| `npm start` | Запуск зібраного клієнта + API |

---

## Структура

```
offer-tools/
├── client/        # React 19 + Vite (UI)
│   └── public/    # статика, що віддається як є (logo.svg)
├── server/        # Express 5 (API), сервіси, xAI-інтеграція
│   ├── routes/    # upload, process, content, php, build, dev, widgets, geo
│   └── services/  # нормалізація, html-обробка, xai*, send.php та ін.
├── config/        # geo.json
├── widgets/       # готові віджети
├── logo.svg       # фірмовий логотип (джерело)
└── ДОКУМЕНТАЦІЯ.md # детальна документація
```

Тимчасові робочі сесії (`server/sessions/`) та build (`client/dist/`) **не комітяться** — генеруються локально.
