# Як залити проект на Bitbucket

Покрокова інструкція для перенесення репозиторію на Bitbucket.
Зараз `origin` вказує на GitHub — нижче два варіанти: **замінити** origin на Bitbucket або **додати** Bitbucket як другий remote.

---

## 0. Перед початком

Переконайся, що секрети не потраплять у пуш:

```bash
git ls-files | grep -E '\.env$'      # має бути ПОРОЖНЬО
git status                            # .env / server/.env не мають з'являтися
```

> `server/.env` (з реальним `XAI_API_KEY`) у `.gitignore` — у репозиторій іде лише `server/.env.example`.

---

## 1. Створити репозиторій на Bitbucket

1. Bitbucket → **Create repository**.
2. Workspace + назва репо (напр. `offer-tools`).
3. **Access level:** Private.
4. ⚠️ **НЕ** додавай README / .gitignore при створенні (репо має бути порожнім, щоб уникнути конфлікту при push).
5. Скопіюй SSH-URL виду:
   `git@bitbucket.org:<workspace>/<repo>.git`

---

## 2. SSH-ключ (якщо ще не налаштований)

```bash
# перевірити наявні ключі
ls ~/.ssh/id_*.pub

# якщо немає — згенерувати
ssh-keygen -t ed25519 -C "you@example.com"

# скопіювати публічний ключ
cat ~/.ssh/id_ed25519.pub
```

Bitbucket → **Personal settings → SSH keys → Add key** → вставити вміст `.pub`.
Перевірити:

```bash
ssh -T git@bitbucket.org
```

---

## 3А. Варіант: замінити origin на Bitbucket

Якщо проект далі живе тільки на Bitbucket:

```bash
git remote set-url origin git@bitbucket.org:<workspace>/<repo>.git
git remote -v                        # переконатися, що origin → bitbucket

# залити всі гілки і теги
git push -u origin --all
git push origin --tags
```

## 3Б. Варіант: тримати обидва (GitHub + Bitbucket)

Якщо GitHub лишається, а Bitbucket — додатковий:

```bash
git remote add bitbucket git@bitbucket.org:<workspace>/<repo>.git

# залити поточну гілку
git push -u bitbucket OPT-3

# або всі гілки одразу
git push bitbucket --all
git push bitbucket --tags
```

> Далі пуш у Bitbucket: `git push bitbucket <branch>`; у GitHub — `git push origin <branch>`.

---

## 4. Призначити основну гілку

Bitbucket → **Repository settings → Repository details → Main branch** → обрати `main`
(або змерджити OPT-3 у `main` і запушити `main`).

---

## 5. Перевірка після push

- Відкрити репо на Bitbucket — мають бути всі файли, **окрім** `node_modules`, `client/dist`, `server/.env`, `server/sessions`, `.DS_Store`.
- `server/.env.example` присутній, `server/.env` — відсутній.
- Клонувати в чисту папку і пройти кроки з [README](./README.md) — проєкт має піднятися.

---

## Швидкий чек-лист

```bash
git ls-files | grep -E '\.env$'                      # порожньо
git remote add bitbucket git@bitbucket.org:<ws>/<repo>.git
git push -u bitbucket OPT-3
```
