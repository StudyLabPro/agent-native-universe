# Реестр ключей Live-инфраструктуры

Единый список всех ключей/секретов, задействованных постоянным живым
инстансом ANU (фаза L5a, docs/GENESIS_LIVE.md §7.3) — где каждый живёт,
когда истекает и что делать при ротации. Значений ключей здесь нет и не
должно быть — только имена, места хранения и процедуры.

| Ключ | Где | Истекает | Ротация |
|---|---|---|---|
| `MWS_API_KEY` Ask Lab (SA `xteam-pro`) | `/root/StudyLabPro/.env` | 2026-11-22 — заменить на `anu-site-ask/ask-lab` до срока | `.env` + `docker compose up -d` (сайт) |
| `anu-live-inference` | Secret Manager → шлюз | 2027-03-01 | новая версия секрета → `systemctl restart anu-secrets` → рестарт `lab-llm-gateway-live` (раннер не трогать) |
| HMAC `anchors` (SA `anu-anchor`) | VM, `anchor.sh` | 2027-03-01 | новая пара → секрет → рестарт cron-окружения |
| authorized key VM (SA `anu-live`) | VM, профиль `mws` | задать явно при создании (`--expiration-time`) | новая пара → `mws init` |
| токен Observer | Secret Manager + `.env` сайта | ротация на границе эпохи | рестарт только `lab-observer-live` + `.env` сайта; окно STALE помечено |
| токен шлюза | Secret Manager | ротация на границе эпохи | рестарт шлюза и раннера на границе (`upgrade-at-boundary.sh`) |

## Что ещё не сделано (не входит в объём L5a)

Grafana-алерт «ключ истекает» по каждой строке этой таблицы (порог — по
`expirationTime` из `mws iam api-key get -f json` / `hmac-key get` /
`authorized-key get`) не настроен этой фазой — это задача фазы L5c
(наблюдаемость). Здесь только зафиксирован сам список ключей, который тот
алерт будет обходить.

## Как проверить срок действия ключа вручную (до появления алерта)

```bash
mws iam api-key get "iam/projects/project-vxgxs2/serviceAccounts/anu-live/apiKeys/anu-live-inference" -f json
mws iam hmac-key get "iam/projects/project-vxgxs2/serviceAccounts/anu-anchor/hmacKeys/anchors" -f json
mws iam authorized-key get "iam/projects/project-vxgxs2/serviceAccounts/anu-live/authorizedKeys/vm-anu-live-1" -f json
```

Все три — команды чтения (`get`), ничего не создают и не изменяют.
