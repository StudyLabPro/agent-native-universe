# Реестр ключей Live-инфраструктуры

Единый список всех ключей/секретов, задействованных постоянным живым
инстансом ANU (фаза L5a, docs/GENESIS_LIVE.md §7.3) — где каждый живёт,
когда истекает и что делать при ротации. Значений ключей здесь нет и не
должно быть — только имена, места хранения и процедуры.

| Ключ | Где | Срок | Ротация |
|---|---|---|---|
| Ключ инференса сайта Ask Lab | `.env` сайта на его собственном хосте | см. `iam api-key get` | `.env` + перезапуск сайта; к этой VM отношения не имеет |
| `anu-live-inference` | Secret Manager → шлюз | см. `iam api-key get` | новая версия секрета → `systemctl restart anu-secrets` → рестарт `lab-llm-gateway-live` (раннер не трогать) |
| HMAC `anchors` (SA `anu-anchor`) | VM, `anchor.sh` | см. `iam hmac-key get` | новая пара → секрет → рестарт cron-окружения |
| authorized key VM (SA `anu-live`) | VM, профиль `mws` | задать явно при создании (`--expiration-time`) | новая пара → `mws init` |
| токен Observer | Secret Manager + `.env` витрины | ротация на границе эпохи | рестарт только `lab-observer-live` + `.env` витрины; окно STALE помечено |
| токен шлюза | Secret Manager | ротация на границе эпохи | рестарт шлюза и раннера на границе (`upgrade-at-boundary.sh`) |

Конкретные даты истечения намеренно НЕ выписаны в этот файл: он
отслеживается в публичном репозитории, а срок жизни ключа — операционный
факт конкретной установки. Актуальные значения берутся командами чтения
внизу страницы; проверяемый критерий ротации — изменившийся отпечаток
файла секрета (`RUNBOOK.md` §6).

## Что ещё не сделано (не входит в объём L5a)

Grafana-алерт «ключ истекает» по каждой строке этой таблицы (порог — по
`expirationTime` из `mws iam api-key get -f json` / `hmac-key get` /
`authorized-key get`) не настроен этой фазой — это задача фазы L5c
(наблюдаемость). Здесь только зафиксирован сам список ключей, который тот
алерт будет обходить.

## Как проверить срок действия ключа вручную (до появления алерта)

```bash
mws iam api-key get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live/apiKeys/anu-live-inference" -f json
mws iam hmac-key get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-anchor/hmacKeys/anchors" -f json
mws iam authorized-key get "iam/projects/${MWS_PROJECT}/serviceAccounts/anu-live/authorizedKeys/vm-anu-live-1" -f json
```

Все три — команды чтения (`get`), ничего не создают и не изменяют.
