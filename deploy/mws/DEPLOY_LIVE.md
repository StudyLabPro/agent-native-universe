# DEPLOY_LIVE — развёртывание Genesis-Live на `anu-live-1` (фаза L5b)

Пошаговый раннбук первого реального запуска живой вселенной на
существующей VM `anu-live-1`, **в тех ограничениях, которые есть
сейчас**, без новых дисков и без новых машин.

Каждый шаг заканчивается **проверяемым критерием**. Шаг без выполненного
критерия не считается пройденным, и следующий за ним не начинается.
Шаги помечены: **[владелец]** — может выполнить только владелец аккаунта
(секреты, IAM, консоль облака); **[оператор]** — главный агент по этому
раннбуку; **[необратимо]** — отдельно оговорено.

Артефакты этой фазы: `compose.live.yml`, `.env.live.example`,
`deploy/mws/tiers.anu-live-1.json`,
`experiments/genesis-live/config.anu-live-1.json`,
`deploy/mws/bootstrap-anu-live-1.sh`, `deploy/mws/anu-live.service`,
`deploy/mws/anu-secrets.service.d/` (два drop-in),
`deploy/mws/target.env.example`, `scripts/live/build-push.sh`.
Инфраструктурная часть (SA, ключи, сеть, firewall, реестр) — фаза L5a,
`deploy/mws/provision.sh` и `deploy/mws/RUNBOOK.md`.

---

## 0. Ревизия: находка → что сделано

Три ревизора, 38 находок. Ниже — что сделано по каждой; отклонения
помечены явно.

| # | Находка (кратко) | Что сделано |
|---|---|---|
| 1 | `build-push.sh` строит путь образа без имени проекта, реестр отвечает `NAME_INVALID` | **Исправлено.** Путь трёхсегментный: `<host>/<project>/anu/<repo>`; имя проекта приходит из `target.env`. Пометка «непроверенный факт» снята — факт установлен читающим запросом к реестру (Ш6a) |
| 2 | `tiers.json` не сведён с измеренным reasoning-поведением моделей, нет `requestOverrides` | **Исправлено.** `fast` получил `{"reasoning_effort":"low"}`, `standard` 2048→4096, `deliberate` 4096→8192 (выше измеренного потолка reasoning). Инвариант цен и потолков закреплён тестом |
| 3 | Критерии живости Ш9 не отличают думающую вселенную от вселенной, где каждый ответ отвергнут | **Исправлено.** Добавлен критерий 5 на уликах: доля `cognition.recorded` с непустым `actions`, число `rejected` и `finishReason:"length"` |
| 4 | Ш7 стартует раннер до готовности шлюза; identity-запрос без ретрая | **Исправлено.** `up -d --wait` перед `run` |
| 5 | Ш7 — длинная эпоха в переднем плане ssh, без процедуры выхода из зависшей аренды | **Исправлено.** Ш7 идёт через `compose run -d` + `logs -f`; добавлена процедура разбора осиротевшего one-off и удаления `.runner.lock` |
| 6 | Доказательство «протухшей аренды» невалидно между контейнерами | **Исправлено частично (механически).** Предохранитель `ExecStartPre` в `anu-live.service` отказывает при живом one-off-раннере проекта; граница доказательства описана в `compose.live.yml`. `flock` на файле аренды — изменение движка, вынесено в §9 |
| 7 | `--rate-per-minute 240` упирается ровно в измеренную пропускную способность | **Исправлено.** 240 → 900 (выше физического потолка 8 x 60), инвариант записан в §7 и закреплён тестом |
| 8 | Обоснование `llmTokens=400000` измерено на заглушке, всегда просившей fast | **Исправлено измерением.** Проведён второй прогон с заглушкой, всегда просящей `deliberate`: стена приходит на тике 22 против 253. В §5 записана вилка, в Ш7 — обязательный замер распределения ярусов |
| 9 | «Встроенный порог движка 20 GiB» — неверно: страж по умолчанию выключен | **Исправлено** в четырёх местах; в compose форма `:?`, в `anu-live.service` — `ExecStartPre` на непустое значение |
| 10 | Обоснование предохранителя секретов опирается на неверное поведение docker | **Исправлено.** Комментарий переписан по измеренному поведению (`invalid mount config … bind source path does not exist` + бесконечный рестарт) |
| 11 | Выключить грейдера пустым значением, как обещает документ, нельзя | **Исправлено.** Обещание убрано; сказано, что отключение — удаление строки из `environment:` вместе с `--task-inbox` |
| 12 | Потолок аудита шлюза — 640 MiB, а не «~512 MB» | **Исправлено** в §8, в `.env.live.example` и в комментарии compose |
| 13 | Смена `ANU_LIVE_LLM_UPSTREAM` без удаления state-файла не даст шлюзу стартовать | **Исправлено.** Процедура в §7, предупреждение в compose и `.env.live.example` |
| 14 | `anu-secrets.service` под `ProtectSystem=strict` может не иметь права записать кэш CLI | **Исправлено.** Drop-in `20-runtime-environment.conf` открывает на запись только каталоги профиля/кэша CLI |
| 15 | `anchors/` описан в раскладке и в зеркале, но движком не пишется | **Исправлено.** `anchors/` убран из раскладки, из Ш10 и из юнита зеркала; путь зеркала исправлен в самом файле юнита |
| 16 | `build-push.sh` неверно описывает, из чего собирается образ при грязном дереве | **Исправлено.** Отказ (`exit 1`) вместо предупреждения, проверка `git status --porcelain`, опциональный суффикс `-dirty` |
| 17 | Внешний инфраструктурный контекст закоммичен в публичный репозиторий вопреки его AGENTS.md | **Исправлено.** Все адреса, идентификатор проекта и подсети вынесены в `deploy/mws/target.env` (в `.gitignore`); в отслеживаемых файлах — только имена переменных. Ссылка на внутренний документ закрытого проекта удалена. Граница закреплена тестом `test/publication-boundary.test.mjs`. Решение о судьбе `deploy/**` в публичном репозитории остаётся за владельцем — §11 |
| 18 | Ложное утверждение о встроенном пороге диска повторено в четырёх артефактах | **Исправлено** во всех четырёх, включая комментарий теста; добавлен предохранитель в юните |
| 19 | Физика (`llmTokens` 400000) изменена по измерению с зафиксированным ярусом | **Исправлено измерением** — см. находку 8; третья оговорка внесена в §5 и в `.env.live.example` §7 |
| 20 | Стоимость эпохи не сведена с бюджетным окном шлюза | **Исправлено.** Окно поднято выше собственного темпа вселенной; §8 сводит числа; Ш9 отделяет `provider_outage` от `token_window_exhausted` |
| 21 | «Вселенная живёт» и «1700 эпох» не следуют из единственного прогона | **Исправлено измерением.** Прогон двух эпох показал: последняя консультация — тик 253, отставка всех 16 агентов — тик 272, `activeAgents 0`. Записано в §5, добавлен шаг Ш7б |
| 22 | Пустое значение грейдера не отключает его | **Исправлено** — см. находку 11 |
| 23 | `ANU_LIVE_UNIVERSE_ID` подан как настройка, но Observer знает только `U0001` | **Исправлено.** Значение зафиксировано литералом в compose, переменная убрана |
| 24 | «Это тоже видно из прогона» — вывод о поведении со временем по одной эпохе | **Исправлено.** Формулировка заменена; измерением подтверждены две эпохи, свойство приписано правилам архивации |
| 25 | «The image builds» читается как выполненная проверка; стек через compose не запускался ни разу | **Исправлено проверкой, а не формулировкой.** Образ этого коммита собран, стек поднят через `docker compose` на Lab с заглушкой провайдера и отыграл эпоху: `read_only` + file-secrets + `user 1000:1000` + `internal`-сеть подтверждены живым запуском (§5.4). Формулировка статуса в `docs/GENESIS_LIVE.md` приведена к тому, что реально сделано |
| 26 | `anu-secrets.service` не сможет запустить `mws`: нет `HOME` и нужного `PATH` | **Исправлено.** Drop-in `20-runtime-environment.conf` (`HOME`, `PATH`, `EnvironmentFile`), скрипт проверяет наличие CLI и говорит внятно |
| 27 | Вызов `secret-version get-data` не совпадает с интерфейсом CLI; ротация может молча не сработать | **Исправлено.** Скрипт разрешает максимальную АКТИВНУЮ версию через `secret-version list --filter spec.active=true`, вызывает `get-data` с полным id версии и печатает sha256 файла — проверяемый критерий ротации в `RUNBOOK.md` §6 |
| 28 | После неудачного чтения docker подменяет файлы секретов каталогами, повторный запуск кладёт секрет внутрь | **Исправлено.** Строка `d /run/anu/secrets` в `tmpfiles.d`, проверка «не обычный файл → удалить», очистка временных файлов через `find` |
| 29 | У VM нет шага аутентификации в реестре, а обход кладёт credentials владельца на хост улик | **Исправлено.** Ш6 разведён на Ш6a (сборка и push с Lab) и Ш6b (на VM — только сервисный аккаунт), с прямым запретом логина владельца на VM |
| 30 | `docker login` на Lab без ограничения и без шага logout | **Исправлено.** `--password-stdin` в раннбуке, `docker logout` встроен в `build-push.sh` |
| 31 | Токен Observer'а передаётся аргументом командной строки на общем хосте | **Исправлено.** Токен читается из `/etc/anu-live/observer.curlrc` (0600), в раннбуке — прямой запрет вставлять его в командную строку |
| 32 | Процедура разгрузки диска делает Lab архивом без бюджета, пути и удержания | **Исправлено.** §8 называет путь, предусловие по `df`, правило удержания и формулировку «временная станция» |
| 33 | Бюджет Lab на сборку не учтён, хотя для VM аналогичный предохранитель есть | **Исправлено.** `build-push.sh` проверяет диск и память и отказывается собирать; в Ш6a — предусловие |
| 34 | Аудит шлюза посчитан как ~512 MB, фактический потолок ~640 MiB | **Исправлено** — см. находку 12 |
| 35 | О-4 объявлено «отступлением без последствий», хотя egress шлюза не ограничен | **Исправлено.** О-4 переписано честно; в §9 добавлено обратимое правило против адреса метаданных облака |
| 36 | Профиль `edge` публикует 80/443 и полагается на единственный слой защиты | **Исправлено.** Bind вынесен в переменную, в compose и §9 сказано, что host-level firewall при DNAT не работает; профиль не включать до подтверждения адреса клиента по логам Caddy |
| 37 | `PartOf=docker.service` + `TimeoutStopSec=720` делает перезапуск docker похожим на зависание | **Исправлено.** Строка в таблице §10 и комментарий в юните |
| 38 | Порт туннеля не проверяется; зеркало тянет данные в `/root` от root | **Исправлено.** В Ш9/Ш10 — проверка `ss -ltn` перед `enable`; юнит зеркала получил `User=`, `ProtectSystem=strict`, `NoNewPrivileges=`, каталог вне `/root` |

---

## 0.1 Публикационная граница и файл цели

Этот репозиторий публичный, и его `AGENTS.md` запрещает вносить в него
внешний инфраструктурный контекст. Поэтому **ни в одном отслеживаемом
файле нет адресов машин, идентификатора облачного проекта, подсетей и
имён пользователей**. Всё это живёт в одном локальном файле:

```bash
cp deploy/mws/target.env.example deploy/mws/target.env   # файл в .gitignore
$EDITOR deploy/mws/target.env
set -a; . deploy/mws/target.env; set +a
```

Дальше раннбук пользуется только переменными: `$MWS_PROJECT`,
`$ANU_LIVE_VM_IP`, `$ANU_LIVE_VM_USER`, `$ANU_LIVE_LAB_IP`,
`$ANU_LIVE_LLM_UPSTREAM`, `$ANU_LIVE_LAB_ARCHIVE_DIR`.

**Критерий:** `test/publication-boundary.test.mjs` проходит
(`node --test test/publication-boundary.test.mjs`) — в отслеживаемых
файлах нет ни публичных IPv4-литералов, ни идентификаторов проекта.

---

## 1. Что стоит на цели (ФАКТ, проверено 2026-09-08)

| Что | Состояние |
|---|---|
| VM `anu-live-1` | существует, `power: ON`, тип `base-4-8` — 4 vCPU, 8 GB RAM |
| Диск | ОДИН: `anu-live-1-boot`, 50 GB. Отдельного диска улик **нет и создать нельзя** — квота дисков исчерпана |
| ОС | голая Ubuntu 24.04: **cloud-init не применялся**, Docker **не установлен** |
| Сеть | внутренний адрес в приватной подсети; внешний адрес **создан, но НЕ привязан** |
| Firewall сети | ingress закрыт по умолчанию; открыты HTTPS и SSH только с адреса Lab, плюс ACME-HTTP. Конкретные правила создаёт `provision.sh` |
| Реестр образов | репозиторий существует; PUSH разрешён только с адреса Lab (whitelist) |
| Секреты | три контейнера секретов существуют, **значений в них нет** |
| IAM | ключи созданы; **role bindings не назначены** |
| GPU | нет. Модели берутся у провайдера по сети |

Отсюда следуют два жёстких факта, определяющих весь раннбук:
**улики живут на boot-диске**, и **пока внешний адрес не привязан, к
машине нельзя подключиться ниоткуда, кроме консоли облака**.

---

## 2. Отступления от дизайна, принятые сознательно

Дизайн трека описывает четыре хоста. Есть один. Ниже — что именно из-за
этого нарушено, чем это чревато и когда снимается. Ни одно из отступлений
не отменяет инвариантов улик: единый редьюсер, записанные входы,
хэш-цепочка, аттестация каждой эпохи.

| # | Отступление | Чем чревато | Когда снимается |
|---|---|---|---|
| О-1 | **Ключ провайдера лежит на той же машине, что и улики.** Дизайн разносит шлюз когниции и ядро улик; второго хоста нет — квота vCPU не даёт создать VM | Одна успешная компрометация даёт и ключ провайдера, и весь корпус улик. Остаточные меры: ключ читает только контейнер шлюза из tmpfs; раннер физически не имеет маршрута наружу (сеть `internal: true`); у шлюза нет доступа к каталогу улик | Созданием отдельного cog-хоста после увеличения квоты vCPU |
| О-2 | **Нет выделенного диска улик.** Улики, журналы docker и аудит шлюза делят один 50 GB boot-диск | Заполнение диска бьёт одновременно по уликам, по ОС и по docker. Меры — §8 | Подключением диска после освобождения квоты (перенос каталога — обратимая операция при остановленном стеке) |
| О-3 | **Нет ops-хоста.** Нет tick-атомарной реплики, второго Observer, независимой верификации `anu lab replay` + `verify-attestation` на каждую ссылку цепочки, якорения в S3 и сверки аудита шлюза с уликами | Единственная копия улик — на этой машине. Ошибку в цепочке некому обнаружить независимо | Созданием ops-хоста. Частичная компенсация доступна сразу: зеркало `chain/` на Lab (Ш10) |
| О-4 | **Нет `think-fabric`, и egress шлюза не ограничен ничем.** В дизайне это статический Caddy-allowlist | **Отступление С последствиями, вопреки прежней формулировке.** Сеть `llm-egress` — обычный bridge: контейнер шлюза, единственный держатель ключа провайдера, может обратиться куда угодно, а не только к провайдеру моделей. Раннер при этом действительно без маршрута наружу — но защищает это раннера, а не ключ. Компенсация до появления cog-хостов: обратимое правило против адреса метаданных облака (§9) | Вместе с О-1 |
| О-5 | **Сеть Observer'а не `internal`.** ИЗМЕРЕНО (docker 27.3.1, Lab, 2026-09-08): опубликованный порт контейнера в сети с `internal: true` с хоста недоступен (`curl` -> код 000), в обычной bridge — 200 | У контейнера Observer'а есть egress. Он не держит ключа провайдера, монтирует улики `:ro` и никогда ничего не пишет | Снимается переходом на Caddy в той же сети без публикации порта |

---

## 3. Раскладка на диске

Всё на boot-диске, три поддерева с разными правами — это не косметика,
а граница ролей:

```
/var/lib/anu-live/
├── evidence/   улики. Раннеру rw, Observer'у ro. Внутри: genesis-live/U0001/**, chain/
├── inbox/      записанные входы оператора: tasks.jsonl, verdicts.jsonl, physics.jsonl
│               пишет root, раннеру смонтировано ТОЛЬКО НА ЧТЕНИЕ
└── gateway/    аудит и состояние бюджета шлюза. Это НЕ улики; раннер сюда не имеет доступа
/opt/anu-live/     compose.live.yml, .env, tiers.json, anu-secrets.sh, (Caddyfile)
/etc/anu-live/     target.env (MWS_PROJECT), observer.curlrc
/run/anu/secrets/  tmpfs, три файла секретов, 0400, uid 1000
```

Каталога `anchors/` в этой фазе **нет**: движок его только читает,
писателя якорей в коде не существует, якорение в S3 отложено до ops-хоста
(§9). Он появится вместе с якорением, не раньше.

Каталог `inbox/` вынесен из корня улик намеренно: раннер не должен иметь
права записи туда, откуда он читает собственные записанные входы.

`verdicts.jsonl` создаётся, но по умолчанию **не подключён**: внешнюю
работу оценивает модель-грейдер через тот же шлюз (`ANU_LIVE_GRADER_MODEL`),
и это выбор в пользу одного egress, одного бюджета и одного аудита.
Файл существует, чтобы переключение было одной строкой: добавить
`--verdict-inbox /inbox/verdicts.jsonl` в команду раннера. Учтите, что
источник вердиктов **перекрывает** грейдера (в CLI inbox выигрывает), а
`evaluatorId` входит в идентичность эпохи — переключение меняет
идентичность последующих эпох, см. §7.

---

## 4. Фазы и зависимости

```
Ш1 внешний адрес ─► Ш2 доступ ─► Ш3 bootstrap ──┐
                                                 ├─► Ш6a образ (Lab) ─► Ш6b pull (VM)
Ш4 секреты+IAM [владелец] ─► Ш5 anu-secrets ────┘                          │
                                                                            ▼
                                              Ш7 эпоха 0 ─► Ш7б эпоха 1 ─► Ш8 сервис ─► Ш9 проверка
                                                                                          │
                                                                              Ш10 зеркало на Lab
```

Ш1, Ш2 и Ш4 — блокирующие и выполняются владельцем. Ш10 — неблокирующий.
Ш7 обязателен: он делает первую ссылку цепочки и даёт реальные числа по
диску и по распределению ярусов, без которых порог из Ш8 — догадка.
Ш7б обязателен отдельно: измерение (см. §5) показало, что при нулевом
заработке популяция вымирает именно в эпохе 1, и увидеть это можно только
доиграв её.

---

## Ш1. Привязать внешний адрес **[владелец]** *(обратимо)*

Пока внешний адрес не привязан к VM, к машине нет ни одного сетевого
пути: подсеть приватная, а правило SSH разрешает вход только с адреса
Lab — но и оно бесполезно без публичного адреса.

```bash
# Проверить текущее состояние (чтение, безопасно)
mws vpc external-address get "vpc/projects/${MWS_PROJECT}/externalAddresses/anu-live-1-ip" -f json
mws vpc one-to-one-nat list --network anu-live -f json
```

Привязка выполняется в консоли облака либо командой `vpc one-to-one-nat
create` — **точная форма команды не подтверждена реальным запуском**
(в `provision.sh` этот шаг намеренно только печатается: изменение сетевых
интерфейсов работающей VM способно отсоединить её boot-диск или сеть).

**Критерий:** `mws vpc one-to-one-nat list --network anu-live -f json`
показывает связку внешнего адреса с внутренним, и с Lab отвечает порт:
`nc -z -w5 "$ANU_LIVE_VM_IP" 22 && echo reachable`.

## Ш2. Доступ к машине по SSH **[владелец]**

**ОТКРЫТЫЙ ВОПРОС, который надо закрыть до начала работ:** неизвестно,
есть ли на VM хоть один SSH-ключ. Машина создана в обход провижининга,
cloud-init не применялся, а IAM `authorized-key` — это ключ сервисного
аккаунта для CLI `mws`, **не** ключ входа по SSH. Если ключа нет,
единственный путь — консоль облака (serial/VNC): добавить публичный ключ
оператора в `~/.ssh/authorized_keys` пользователя с sudo. Менять
`vm update --network-interfaces` на живой машине не следует (риск
отсоединения диска/сети).

**Критерий:** с Lab отрабатывает
`ssh -o BatchMode=yes "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" 'id && lsblk && df -h /'`
и печатает один диск на 50 GB.

## Ш3. Привести голую Ubuntu в рабочее состояние **[оператор]**

Скопировать и запустить `bootstrap-anu-live-1.sh` — это ровно те
действия, которые описывает `cloud-init.yaml`, выполненные вручную и
идемпотентно, **минус** раздел про отдельный диск улик (его нет):

```bash
scp deploy/mws/bootstrap-anu-live-1.sh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP":/tmp/
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" 'sudo bash /tmp/bootstrap-anu-live-1.sh'
# имя проекта нужно юниту секретов и на самой VM
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" \
  "sudo install -d -m 0750 /etc/anu-live && \
   printf 'MWS_PROJECT=%s\n' '$MWS_PROJECT' | sudo tee /etc/anu-live/target.env >/dev/null && \
   sudo chmod 0640 /etc/anu-live/target.env"
```

Скрипт: проверяет свободное место (< 20 GB — отказ), заводит uid 1000
(или использует занятый), ставит Docker Engine + compose plugin, создаёт
дерево `/var/lib/anu-live` и пустые файлы входов, создаёт `/opt/anu-live`,
создаёт `/run/anu` и `/run/anu/secrets` **и объявляет оба в
`/etc/tmpfiles.d/anu-live.conf`**. Последнее обязательно по двум причинам:
`/run` — tmpfs, после перезагрузки каталог исчезает, а у
`anu-secrets.service` стоит `ConditionPathExists=/run/anu`; и `tmpfiles`
приводит `/run/anu/secrets` к каталогу, если docker когда-то подменил там
файл секрета каталогом.

**Критерий:**
```bash
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" 'docker compose version && \
  test -d /var/lib/anu-live/evidence && test -f /var/lib/anu-live/inbox/tasks.jsonl && \
  test -d /run/anu/secrets && stat -c "%a %U" /run/anu /run/anu/secrets && \
  test -f /etc/anu-live/target.env'
```
печатает версию compose и дважды `700 root`.

## Ш4. Секреты и IAM **[владелец]** *(значения секретов — необратимо в смысле «агент их не видит и не должен видеть»)*

Ни одно значение секрета не проходит через агента, через репозиторий и
через `.env`. Владелец лично:

1. Создаёт версии трёх секретов в Secret Manager (контейнеры уже
   существуют, значений в них нет):
   - `anu-live-provider-key` — ключ к провайдеру моделей;
   - `anu-live-gateway-token` — общий Bearer раннера и шлюза, не короче
     32 символов token68;
   - `anu-live-observer-token` — Bearer читателя улик.
   Точный формат ввода данных версии — **НЕПРОВЕРЕННЫЙ ФАКТ**
   (`docs/GENESIS_LIVE.md` §8): подтвердить при первом запуске и вписать
   результат в `RUNBOOK.md` §3.
2. Назначает IAM role bindings (CLI это не умеет — только консоль/REST),
   по чеклисту `RUNBOOK.md` §2: SA `anu-live` — чтение секретов `anu-live-*`
   и pull из реестра.
3. Устанавливает на VM профиль `mws` (0600, root) — без него
   `anu-secrets.service` не прочитает ничего.

**Критерий (выполняет владелец на VM):**
```bash
mws secretmanager secret-version list --name anu-live-gateway-token \
  --filter 'spec.active=true' -f json >/dev/null && echo listable
```
без ошибки авторизации — и НЕ показывая содержимое в общем канале.

## Ш5. Секреты в tmpfs **[оператор]**

```bash
scp deploy/mws/anu-secrets.sh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP":/tmp/
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" \
  'sudo install -m 0750 -o root -g root /tmp/anu-secrets.sh /opt/anu-live/anu-secrets.sh'
scp deploy/mws/anu-secrets.service deploy/mws/anu-live.service "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP":/tmp/
scp deploy/mws/anu-secrets.service.d/*.conf "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP":/tmp/
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" \
  'sudo install -m 0644 /tmp/anu-secrets.service /tmp/anu-live.service /etc/systemd/system/ && \
   sudo install -d /etc/systemd/system/anu-secrets.service.d && \
   sudo install -m 0644 /tmp/10-before-docker.conf /tmp/20-runtime-environment.conf \
     /etc/systemd/system/anu-secrets.service.d/ && \
   sudo systemctl daemon-reload && sudo systemctl enable --now anu-secrets.service'
```

**Оба drop-in обязательны и нетривиальны.**

`10-before-docker.conf`. Контейнеры объявлены с `restart: unless-stopped`,
поэтому после перезагрузки их поднимает сам `dockerd`, не дожидаясь ни
`anu-live.service`, ни `anu-secrets.service`. А `/run` — tmpfs: секретов
там после ребута нет. Drop-in ставит чтение секретов **перед** запуском
`dockerd`. Цикла нет: `anu-secrets.service` зависит только от
`network-online.target`.

`20-runtime-environment.conf`. ИЗМЕРЕНО на Lab: у системного юнита
`HOME` не выставлен вовсе, а `PATH` не содержит `~/.local/bin`, где живёт
CLI. Без этого drop-in шаг падает с «команда mws не найдена», и отказ
выглядит как проблема с секретами, уводя разбор не туда. Тот же drop-in
подаёт юниту `EnvironmentFile=/etc/anu-live/target.env` (имя проекта) и
открывает на запись только каталоги профиля/кэша CLI — `ProtectSystem=strict`
в самом юните делает всё остальное read-only.

Скрипт разрешает **максимальную активную версию** каждого секрета
(`secret-version list --filter spec.active=true`) и читает её по полному
id — иначе после ротации стек мог бы молча остаться на старом ключе. Если
формат ответа окажется другим, скрипт упадёт с внятной ошибкой; поправить
разбор одной строкой и записать факт в `RUNBOOK.md` §3.

**Критерий:**
```bash
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" 'systemctl is-active anu-secrets.service && \
  stat -c "%a %u %n" /run/anu/secrets/*'
```
— три файла, режим `400`, владелец `1000`. **Содержимое не печатать.**
Скрипт при этом печатает первые 16 символов sha256 каждого файла — это
и есть проверяемый след ротации (`RUNBOOK.md` §6).

## Ш6a. Образ движка: сборка и push **с Lab** **[оператор]**

Реестр принимает PUSH только с адреса Lab, поэтому сборка идёт с Lab, а
VM только тянет.

**Предусловия шага** (Lab — общий многоагентный хост):
```bash
df -h / && free -g          # места и памяти должно хватать
docker ps --filter status=running --format '{{.Names}}' | head   # чужие сборки
```
`build-push.sh` сам отказывается собирать при < 15 GB свободного места
или < 2 GiB доступной памяти. Освобождение build cache
(`docker builder prune`, обратимо) — решение главного агента, не скрипта.

```bash
# на Lab, в корне репозитория
set -a; . deploy/mws/target.env; set +a
printf '%s' "$REGISTRY_PASSWORD" | docker login "$MWS_REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin
bash scripts/live/build-push.sh      # собирает, пушит и САМ делает docker logout
```

Пароль подаётся через stdin, а не аргументом: аргументы процесса видны
любому пользователю Lab через `/proc/*/cmdline` и оседают в истории
shell. До `logout` учётные данные лежат в `~/.docker/config.json`
открытым base64 — а именно этот хост единственный имеет право подменить
образ, порождающий цепочку улик.

**ПРОВЕРЕННЫЙ ФАКТ (читающий запрос к реестру, 2026-09-08).** Путь образа
трёхсегментный: `<registry-host>/<project>/anu/agent-native-universe-lab`.
Путь без имени проекта реестр отвергает:
`GET /v2/anu/agent-native-universe-lab/tags/list` → `400 NAME_INVALID`
(«repository name format should be `<project>/<registry>/<repository>`»),
тот же запрос с префиксом проекта → `401 UNAUTHORIZED`, то есть имя
принято. `build-push.sh` строит ровно эту форму, и `ANU_LIVE_IMAGE` в
`.env` обязан ей соответствовать.

`ANU_LIVE_IMAGE` **обязано быть пиннутым тегом** `live-<short-sha>`:
`compose.live.yml` не имеет значения по умолчанию и падает без него
намеренно. `build-push.sh` отказывается собирать из грязного дерева:
`docker build … .` собирает из рабочего дерева, а не из HEAD, поэтому тег
назвал бы коммит, которого в образе нет.

**Критерии:**
1. `docker images --format '{{.Repository}}:{{.Tag}}' | grep live-` показывает
   собранный тег на Lab;
2. `docker logout` выполнен — `python3 -c "import json;print('registry' in
   open('/root/.docker/config.json').read())"` не находит записи реестра
   (или `jq -e '.auths | keys' ~/.docker/config.json` её не содержит).

## Ш6b. Образ на VM: аутентификация сервисным аккаунтом **[оператор]**

**Логиниться на VM учётной записью владельца ЗАПРЕЩЕНО.** Её credentials
легли бы открытым текстом в `/root/.docker/config.json` ровно на машине,
где лежат улики и ключ провайдера, — это прямо усугубляет О-1.

```bash
# на VM, под профилем mws сервисного аккаунта anu-live
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" 'sudo mws registry configure-docker'
```

Скопировать стек на VM:

```bash
scp compose.live.yml .env.live.example deploy/mws/tiers.anu-live-1.json \
  "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP":/tmp/
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" \
  'sudo install -m 0640 -o root -g docker /tmp/compose.live.yml /opt/anu-live/compose.live.yml && \
   sudo install -m 0644 /tmp/tiers.anu-live-1.json /opt/anu-live/tiers.json && \
   sudo cp /tmp/.env.live.example /opt/anu-live/.env && sudo chmod 0640 /opt/anu-live/.env'
# затем вписать в /opt/anu-live/.env реальные ANU_LIVE_IMAGE и ANU_LIVE_LLM_UPSTREAM
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" \
  'cd /opt/anu-live && sudo docker compose -f compose.live.yml config -q && \
   sudo docker compose -f compose.live.yml pull'
```

**Критерий:** `docker images` на VM показывает образ с пиннутым тегом, а
`docker compose config -q` завершается без вывода. Если `config -q`
ругается на `ANU_LIVE_MIN_FREE_BYTES` или `ANU_LIVE_LLM_UPSTREAM` — это
не дефект, а предохранитель: значений по умолчанию у них нет намеренно.

## Ш7. Эпоха 0 — вручную, один раз **[оператор]** *(создаёт цепочку; удаление улик необратимо)*

Первую эпоху запускаем **не сервисом**, а одной командой с `--epochs 1` —
чтобы увидеть её целиком и измерить реальный размер и распределение
ярусов, прежде чем отдавать вселенную в автономный режим.

Шлюз поднимается **с ожиданием готовности**: раннер на старте один раз
тянет `ANU_LLM_IDENTITY_URL` с таймаутом 5 с и без ретрая (по разу на
ярус), поэтому `up -d` без `--wait` даёт гонку, на которой первая же
попытка падает.

Раннер запускается **в фоне** (`run -d`), а не на переднем плане ssh:
обрыв сессии либо оставил бы невидимый одноразовый контейнер, либо убил
бы прогон, оставив `.runner.lock`.

```bash
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" 'cd /opt/anu-live && \
  sudo docker compose -f compose.live.yml up -d --wait lab-llm-gateway-live lab-observer-live'

ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" 'cd /opt/anu-live && \
  sudo docker compose -f compose.live.yml run -d --no-deps --name anu-live-epoch0 lab-runner-live \
    node dist/lab/runner.js live --data-dir /data \
      --config /app/experiments/genesis-live/config.anu-live-1.json \
      --universe-id U0001 --tiers /config/tiers.json \
      --task-inbox /inbox/tasks.jsonl --physics-inbox /inbox/physics.jsonl \
      --outage-ticks 3 --min-free-bytes 8589934592 --epochs 1'

ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" 'sudo docker logs -f anu-live-epoch0'
```

Команда печатает одну строку JSON на эпоху: `{"status":"epoch","epoch":0,
"runId":…,"ticks":250,"events":…,"commitment":"sha256:…"}` и затем
`{"status":"stopped"}`.

**Если шаг прервался и надо повторить.** `runId` эпохи 0 детерминирован,
поэтому каталог и файл аренды будут те же, а повтор упрётся в
`Universe U0001 already has an active or stale writer lease`. Разбор:

```bash
# 1. Не жив ли ещё одноразовый раннер (метку oneoff ставит сам compose —
#    проверено на docker 27.3.1 / compose 2.29.7; на неё же смотрит
#    предохранитель anu-live.service)
sudo docker ps -a --filter label=com.docker.compose.project=anu-live \
                  --filter label=com.docker.compose.oneoff=True
sudo docker rm -f anu-live-epoch0     # только если он уже не работает
# 2. Чем закончился незавершённый прогон
sudo tail -3 /var/lib/anu-live/evidence/genesis-live/U0001/run-*/events.jsonl
# 3. Снять аренду ВРУЧНУЮ, убедившись, что писателя нет
sudo rm -f /var/lib/anu-live/evidence/genesis-live/U0001/.runner.lock
```
Флаг `--recover-stale-lease true` в такой ситуации использовать **нельзя**
как замену осмотру: проверка протухания читает `/proc/<pid>` в своём
pid-namespace и живого писателя в другом контейнере не увидит.

**Критерии (все четыре):**
```bash
# 1. Ссылка цепочки эпохи 0 существует
sudo ls /var/lib/anu-live/evidence/genesis-live/U0001/chain/0.json
# 2. Аттестация эпохи существует и её commitment совпадает с напечатанным
sudo cat /var/lib/anu-live/evidence/genesis-live/U0001/run-*/attestations/final.json
# 3. Агенты действительно консультировались (потолок — 4000 = 16 x 250)
sudo grep -c '"type":"cognition.recorded"' \
  /var/lib/anu-live/evidence/genesis-live/U0001/run-*/events.jsonl
# 4. ОБЯЗАТЕЛЬНЫЙ ВЫХОД ШАГА: распределение ярусов и провайдеров
sudo grep -o '"provider":"[a-z-]*"' \
  /var/lib/anu-live/evidence/genesis-live/U0001/run-*/events.jsonl | sort | uniq -c
sudo grep -o '"tier":"[a-z]*"' \
  /var/lib/anu-live/evidence/genesis-live/U0001/run-*/events.jsonl | sort | uniq -c
```

Четвёртый пункт — не диагностика, а **вход в решение по физике**.
Измерение (§5) показало, что срок жизни вселенной при нулевом заработке
отличается в 11 раз в зависимости от того, какой ярус просят модели:
тик 253 при сплошном `fast` и тик 22 при сплошном `deliberate`. Число
`initialResources.llmTokens` пересматривается только через записанное
распределение ярусов реальной эпохи, и такой пересмотр меняет
идентичность всех последующих эпох (§7).

**И сразу же — измерить диск** (это вход в Ш8):
```bash
sudo du -sb /var/lib/anu-live/evidence /var/lib/anu-live/gateway
sudo df -B1 --output=avail /var/lib/anu-live
```

**Убрать за собой.** `run -d` намеренно без `--rm` (иначе логи умерли бы
вместе с контейнером). Завершённый контейнер удаляется вручную — иначе он
будет мешать читать `docker ps -a` при следующем разборе:
```bash
sudo docker rm anu-live-epoch0
```

## Ш7б. Эпоха 1 — проверка на выживание **[оператор]**

Отдельный шаг, а не продолжение Ш7. Измерение (§5) показало, что при
нулевом заработке популяция вымирает **именно в эпохе 1**: последняя
консультация приходится на тик 253, затем 20 тиков грации по
`live.exhaustion`, и на тике 272 все 16 агентов получают
`agent.retired{"reason":"exhausted"}`. Эпоха 0 этого не показывает
вообще — она заканчивается за 3 тика до стены.

```bash
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" 'cd /opt/anu-live && \
  sudo docker compose -f compose.live.yml run -d --no-deps --name anu-live-epoch1 lab-runner-live \
    node dist/lab/runner.js live --data-dir /data \
      --config /app/experiments/genesis-live/config.anu-live-1.json \
      --universe-id U0001 --tiers /config/tiers.json \
      --task-inbox /inbox/tasks.jsonl --physics-inbox /inbox/physics.jsonl \
      --outage-ticks 3 --min-free-bytes 8589934592 --epochs 1'
```

**Критерии:**
```bash
# 1. Заработок начался: задачи выполняются
sudo python3 -c "import json,glob;p=sorted(glob.glob('/var/lib/anu-live/evidence/genesis-live/U0001/run-*/summary.json'))[-1];print(json.load(open(p))['latestMetrics'])"
#    -> tasksCompleted > 0 и activeAgents > 0
# 2. Массовой отставки по истощению нет
sudo grep -c '"reason":"exhausted"' \
  /var/lib/anu-live/evidence/genesis-live/U0001/run-*/events.jsonl
#    -> заметно меньше числа агентов
```

Затем так же убрать за собой: `sudo docker rm anu-live-epoch1`.

`tasksCompleted == 0` и `activeAgents == 0` — **не** повод продолжать в
автономном режиме. Это означает, что модели не берут и не сдают работу, а
значит вселенная доживает ровно до стены по `llmTokens` и дальше стоит
пустой. Рычаг в этом случае — записанные входы: реальные задачи в
`/var/lib/anu-live/inbox/tasks.jsonl` и, при необходимости, изменение
**цен** через `physics.jsonl`. Ни роли, ни задания через физику не
задаются.

## Ш8. Автономный режим **[оператор]**

```bash
ssh "$ANU_LIVE_VM_USER@$ANU_LIVE_VM_IP" \
  'sudo systemctl enable --now anu-live.service && systemctl status anu-live.service --no-pager'
```

`anu-live.service` перед подъёмом проверяет: три секрета на месте и
являются обычными файлами; дерево улик и файлы входов на месте;
`ANU_LIVE_MIN_FREE_BYTES` задан непустым числом (у движка страж диска по
умолчанию **выключен**, поэтому потерянная переменная означала бы не
строгий порог, а его отсутствие); нет живого одноразового раннера этого
проекта; `compose config -q` проходит. Остановка — `stop -t 600`, а не
`down`: раннер должен успеть доиграть текущий тик и записать чекпойнт.

**Критерий:** `systemctl is-active anu-live.service` = `active`, и
`docker compose ps` показывает три сервиса, из них шлюз и Observer —
`healthy`.

## Ш9. Проверка живости **[оператор]**

Внешнего входа на Observer нет и не планируется: он опубликован только на
петле VM. С Lab — SSH-туннель по образцу
`deploy/mws/lab/anu-live-tunnel@.service`.

**Перед `enable` проверить, что локальный порт свободен** (занятость
портов на Lab растёт день ко дню):

```bash
ss -ltn | grep -E ':(13000|13100)\b' && echo "ПОРТ ЗАНЯТ — выбрать другой"
```

```bash
# на Lab: /etc/anu-live-tunnel/observer.env (0600)
#   ANU_LIVE_TUNNEL_HOST=<адрес VM>
#   ANU_LIVE_TUNNEL_USER=<пользователь SSH>
#   ANU_LIVE_TUNNEL_REMOTE_PORT=3000
#   ANU_LIVE_TUNNEL_LOCAL_PORT=13000
systemctl enable --now anu-live-tunnel@observer
```

**Токен Observer'а НИКОГДА не подставляется в командную строку.**
Аргументы процесса видны любому пользователю Lab через `/proc/*/cmdline`
и оседают в истории shell. Он лежит в отдельном файле 0600 root:

```bash
# /etc/anu-live/observer.curlrc  (0600 root:root)
#   header = "Authorization: Bearer <токен>"
sudo curl -sS -K /etc/anu-live/observer.curlrc http://127.0.0.1:13000/api/live | python3 -m json.tool
```

**Критерий «вселенная живёт»** — все пять, подряд:

1. `head.lastTick` в `/api/live` растёт между двумя вызовами;
2. `cognitionHealth.consulted > cognitionHealth.unavailable + cognitionHealth.starved`;
3. `chain` содержит записи, и их число не уменьшается;
4. в логе раннера нет `"status":"paused"` — либо есть с явной причиной, и
   тогда причину надо **разделить на три разных факта**:
   - `low_disk` — инцидент, разбирается по §8;
   - `provider_outage` **при исчерпании собственного окна шлюза** — не
     инцидент, а норма настройки: проверить журнал шлюза на
     `token_window_exhausted`
     (`sudo grep -c token_window_exhausted /var/lib/anu-live/gateway/audit/gateway.jsonl`);
   - `provider_outage` **при обеднённой популяции** — не сбой провайдера:
     когда всем агентам не хватает даже на самый дешёвый ярус,
     консультаций нет вовсе, и супервизор читает это как отсутствие
     ответов. ИЗМЕРЕНО (§5): именно так выглядит вселенная после стены по
     `llmTokens`. Отличать по уликам — есть ли в этих тиках вообще записи
     `cognition.recorded`, и не идут ли подряд `agent.retired{exhausted}`;
5. **вселенная думает, а не отвергает.** Критерий 2 сам по себе этого не
   показывает: `consulted` считается как «всё, что не `unavailable` и не
   `starved`», поэтому запись с обрезанным или неразобранным ответом —
   тоже `consulted`, хотя действий в ней ноль. Проверять на уликах:

```bash
R=$(sudo ls -d /var/lib/anu-live/evidence/genesis-live/U0001/run-* | tail -1)
sudo python3 - "$R/events.jsonl" <<'PY'
import json,sys
total=empty=rejected=length=0
for line in open(sys.argv[1]):
    e=json.loads(line)
    if e.get("type")!="cognition.recorded": continue
    d=e["data"]; total+=1
    if not d.get("actions"): empty+=1
    if d.get("rejected"): rejected+=1
    if d.get("finishReason")=="length": length+=1
print(f"консультаций {total}, пустых actions {empty}, rejected {rejected}, обрезано по длине {length}")
PY
```
Норма — `empty`, `rejected` и `length` близки к нулю (в измеренной эпохе 0
все три равны нулю на 4000 консультаций). Массовое `length` означает, что
`maxTokens` яруса ниже реального объёма reasoning выбранной модели —
чинится в `tiers.json` и меняет идентичность последующих эпох (§7).

## Ш10. Зеркало цепочки на Lab **[оператор]** *(неблокирующий)*

Единственная доступная сейчас компенсация отсутствия ops-хоста (О-3):
`chain/` копируется на Lab по образцу
`deploy/mws/lab/anu-live-mirror.service`. Путь на источнике —
`/var/lib/anu-live/evidence/genesis-live/U0001/chain/` (сегмент
`evidence/` обязателен; в самом юните он уже исправлен). Зеркало
намеренно без `--delete`. `anchors/` **не зеркалится**: движок его не
пишет (§3).

Юнит работает **не от root** и пишет не в `/root`: он принимает файлы с
машины, которую этот же документ считает наименее защищённой (О-1).
Подготовка на Lab:

```bash
sudo useradd --system --shell /usr/sbin/nologin anu-mirror
sudo install -d -m 0750 -o anu-mirror -g anu-mirror /var/lib/anu-live-mirror
sudo install -d -m 0700 -o anu-mirror -g anu-mirror /var/lib/anu-live-mirror/.ssh
```

**Критерий:** на Lab число файлов в зеркале `chain/` равно числу на VM, и
`systemctl show anu-live-mirror.service -p User` показывает `anu-mirror`.

---

## 5. Что показали реальные прогоны (Lab, 2026-09-08)

Физика этой вселенной прогнана целиком **дважды**, с настоящим шлюзом и
заглушкой провайдера, дающей реалистичный по размеру ответ агента и
реалистичный `usage`. Это не оценки, а измерения; ими заданы пороги §8 и
числа бюджета шлюза.

Оба прогона воспроизводятся: заглушка и харнесс — в рабочем каталоге
фазы, конфигурация — `experiments/genesis-live/config.anu-live-1.json` и
`deploy/mws/tiers.anu-live-1.json` этого коммита.

### 5.1 Прогон A: две эпохи подряд, ярус `fast`

| Величина | Измерено |
|---|---|
| Тиков в эпохе / агентов | 250 / 16 |
| Эпоха 0: событий | 23 547 |
| Эпоха 0: `cognition.recorded` | 4 000 = 16 x 250 — **каждый агент консультировался каждый тик**, ни один не отсечён по бедности |
| Эпоха 0: из них `rejected` / `finishReason:"length"` / с пустыми `actions` | 0 / 0 / 0 |
| Эпоха 0: улики | 16 606 610 B (~15.8 MiB), из них `events.jsonl` 15 235 740 B и 10 чекпойнтов 1 355 228 B |
| Аудит + состояние шлюза за эпоху 0 | ~1.72 MB |
| **Итого на эпоху 0** | **~18.3 MB** |
| Эпоха 0: `violation.recorded{cognition overdraft}` | 1 712, начиная с тика 144 |
| **Эпоха 1: `cognition.recorded`** | **48** — последняя консультация на тике **253** |
| **Эпоха 1: `agent.retired{exhausted}`** | **16 из 16, все на тике 272** |
| Эпоха 1: событий / улик | 2 885 / 3 742 257 B |
| Метрика конца эпохи 1 | `activeAgents 0`, `tasksCompleted 0`, `activeLinks 0`, `tasksCreated` 1 632 |
| Токенов у шлюза за обе эпохи | 6 395 840 при 4 048 запросах (эпоха 0 — 6 320 000 при 4 000) |

### 5.2 Прогон B: одна эпоха, ярус `deliberate` (худший случай)

Та же физика, та же заглушка, но `nextTier` в каждом ответе —
`deliberate`. Списание идёт по цене яруса (`deliberate` ввосьмеро дороже
`fast`), поэтому запас `llmTokens` кончается на порядок раньше:

| Величина | Измерено |
|---|---|
| Консультаций | 352: `deliberate` на тиках 2–14, затем автоматическое понижение до `standard` (15–19) и `fast` (20–22) |
| Последняя консультация | тик **22** |
| `agent.retired{exhausted}` | 16 из 16, все на тике **40** |
| Событий / улик за эпоху | 4 909 / 4 469 549 B |
| Токенов у шлюза | 1 059 520 при 352 запросах |

### 5.3 Что из этого следует — и чего из этого НЕ следует

**Стена по `llmTokens` при нулевом заработке лежит между тиком 22 и тиком
253**, в 11 раз, и определяется она не развёртыванием, а тем, какой ярус
просят сами модели. Прежнее обоснование числа 400 000 («стена примерно на
тике 253») верно только для мира, который никогда не думает дороже
`fast`. Поэтому распределение ярусов — обязательный выход шага Ш7.

**Популяция при нулевом заработке вымирает.** Пополнение `llmTokens` идёт
только через `acceptedTaskReward`, плановых вливаний в конфиге нет, а
правило `live.exhaustion` (`minThinkTokens` 1500, `graceTicks` 20)
отправляет неспособного думать агента в окончательную отставку. Оба
прогона дошли до `activeAgents 0`.

**Чего это НЕ доказывает.** Заглушка возвращала фиксированный
идентификатор задачи, которого в мире нет, поэтому ни одна задача не была
взята и заработка не было **вообще** (`tasksCompleted 0`, `activeLinks 0`,
все 816 созданных задач эпохи истекли). Это измерение **худшего случая**,
а не приговор физике: выживание вселенной целиком зависит от того,
начнут ли модели брать и сдавать работу. Ровно это и проверяет Ш7б.

**Ещё один операционный факт, который виден только в прогоне двух эпох.**
После стены по `llmTokens` консультаций нет вовсе — и страж
`--outage-ticks` читает это как `provider_outage`: в логе идут парные
`paused`/`resumed` каждые три тика, хотя провайдер здоров. Отличать
обеднение от сбоя провайдера надо по уликам (Ш9, критерий 4).

**Размер эпохи не растёт со временем** — это следует из правил архивации и
компактизации на границе эпохи (окна 100/100/200 меньше эпохи в 250
тиков, поэтому архивация работает и внутри неё). Измерением подтверждены
две эпохи; проверить на эпохе 2 и записать сюда.

### 5.4 Проверка стека живым запуском (Lab, 2026-09-08)

Раньше `compose.live.yml` был проверен только `config -q`. Теперь —
запуском: образ этого коммита собран из `Dockerfile.lab`, стек поднят
через `docker compose` в отдельном проекте с заглушкой провайдера вместо
реальных моделей, отыграна короткая эпоха, всё убрано за собой.

Что этим подтверждено (класс отказов, который иначе всплыл бы уже на VM):

| Проверено живым запуском | Результат |
|---|---|
| `read_only: true` + `tmpfs /tmp` + `cap_drop: ALL` + `user: 1000:1000` | все три сервиса поднимаются и работают |
| File-secrets из каталога 0400/uid 1000 | шлюз читает ключ провайдера и Bearer, Observer — свой токен |
| `up -d --wait` | шлюз и Observer доходят до `healthy` |
| Раннер в сети `internal: true` | `fetch('https://example.com')` из контейнера раннера **падает** — маршрута наружу нет |
| Монтирование `/inbox:ro` и `/config/tiers.json:ro` | раннер читает входы и ярусы, эпоха идёт |
| Запись улик и цепочки | `chain/0.json` создан, аттестация записана |
| Observer поверх улик `:ro` с Bearer | `/api/live` отдаёт `universeId U0001`, `epoch 0`, `cognitionHealth.consulted` = число агентов x тиков |
| Аудит и state шлюза вне корня улик | пишутся в отдельный каталог, раннеру недоступный |

**Побочно обнаруженный операционный факт.** Шлюз намеренно отказывается
работать с upstream, который не HTTPS и не петлевой адрес
(`Gateway upstream must use HTTPS unless it is a loopback address`). При
`restart: unless-stopped` это выглядит как **бесконечный цикл падений**, а
не как внятный отказ — ровно то же поведение, что и при несовпадении
`gateway-state.json` (§7). Первый разбор нездорового шлюза начинать с
`docker logs`, а не с сети.

---

## 6. Что значит «эта вселенная меньше канонической»

`experiments/genesis-live/config.anu-live-1.json` отличается от
канонической физики ровно пятью значениями (`agents`, `ticks`,
`live.epochTicks`, `initialResources.llmTokens`, `seed`), и каждое —
следствие машины, а не вкуса. Последняя строка таблицы — то, что
осознанно НЕ менялось, но требует объяснения. Полное обоснование каждого
числа — в `.env.live.example` §7; инвариант «остальное байт в байт
каноническое» проверяется тестом
`test/lab-live-deployment-anu-live-1.test.mjs`.

| Значение | Канон | Здесь | Коротко почему |
|---|---|---|---|
| `agents` | 32 | 16 | одна консультация на агента на тик — число агентов и есть нагрузка на шлюз и на 4 vCPU |
| `ticks` / `live.epochTicks` | 500 | 250 | граница эпохи — единственная точка реплея, аттестации и компактизации; реплей однопоточный |
| `initialResources.llmTokens` | 200 000 | 400 000 | при измеренных 1580 единицах на консультацию `fast` канонический запас упирал бы вселенную в стену уже около тика 126. Оговорка: при дорогих ярусах стена всё равно приходит много раньше (§5) |
| `seed` | `genesis-live-u0001` | `genesis-live-anu-live-1-u0001` | чтобы вселенную с другой физикой нельзя было спутать с канонической |
| `checkpointEvery` | 25 | 25 | **не менялось** — названо явно: падение стоит до 25 x 16 = 400 реальных консультаций |

Всё остальное — цены действий, поток задач, окна архивации, цены ярусов,
истощение, казна — каноническое. Инварианты сохранены полностью: единый
редьюсер, записанные входы, хэш-цепочка, аттестация каждой эпохи.

---

## 7. Личность цепочки: что нельзя менять на ходу

В манифест каждой эпохи и, значит, в её `runId` входят: физика вселенной
(`configHash`), идентичность когниции (`cognitionId` — ярусы, их модели,
`maxTokens`, цены и `requestOverrides`, хэш идентичности шлюза, бюджет
содержимого) и идентичность грейдера (`evaluatorId`). Практические выводы:

- **`ANU_LIVE_IMAGE` пиннится поимённо.** Плавающий тег означает, что код
  и физика, породившие цепочку, невосстановимы.
- Смена модели или `maxTokens` в `tiers.json`, смена `ANU_LIVE_GRADER_MODEL`
  или смена `ANU_LIVE_LLM_UPSTREAM` — это смена технического лечения.
  Цепочка останется валидной, но следующие эпохи будут иметь другую
  идентичность. Делать это можно только осознанно и записывать факт.
- **Смена `ANU_LIVE_LLM_UPSTREAM` требует отдельной процедуры.**
  Идентичность шлюза — это хэш upstream, и `gateway-state.json` к ней
  привязан: при несовпадении шлюз отказывает стартовать («Gateway state
  file belongs to another gateway configuration»), а с
  `restart: unless-stopped` это выглядит как цикл падений, а не как
  внятный отказ. Порядок:
  ```bash
  sudo systemctl stop anu-live.service
  sudo mv /var/lib/anu-live/gateway/state/gateway-state.json \
          /var/lib/anu-live/gateway/state/gateway-state.$(date +%Y%m%d-%H%M).json
  # правка ANU_LIVE_LLM_UPSTREAM в /opt/anu-live/.env, затем
  sudo systemctl start anu-live.service
  ```
  Факт смены записать: новая идентичность шлюза меняет `cognitionId`.
- **Инвариант цен**: `pricePpm` каждого яруса в `tiers.json` обязан
  совпадать с `live.tiers.<ярус>.pricePpm` в конфиге вселенной. По
  первому предсказывается платёжеспособность агента, по второму редьюсер
  списывает токены; расхождение делает экономику мышления враньём.
  Проверяется тестом.
- **Инвариант потолков**: `maxTokens` яруса обязан быть выше измеренного
  объёма reasoning его модели, иначе ответ обрезается по длине, не
  разбирается, и запись получает `rejected` с пустыми `actions` —
  консультация оплачена, действий нет. Измеренные объёмы: `gpt-oss-120b`
  с `reasoning_effort:"low"` — порядка сотни токенов; `qwen3-6-35b-a3b` —
  1.6–2.1k reasoning, отключить thinking нельзя; `kimi-k2-6` — 0.9–2.6k.
  Отсюда потолки 1024 / 4096 / 8192. Проверяется тестом.
- **Инвариант параллельности**: `ANU_LIVE_GATEWAY_MAX_IN_FLIGHT` не
  меньше суммы `concurrency` ярусов (4+2+1) плюс грейдер.
- **Инвариант темпа**: `ANU_LIVE_GATEWAY_RATE_PER_MINUTE` **выше**
  физического потолка стека (8 одновременных запросов при минимальной
  измеренной латентности ~1 с — до 480 запросов в минуту). Значение,
  равное потолку, превращает нормальную работу в поток 429, а три подряд
  отказа открывают circuit breaker на `ANU_LLM_COOLDOWN_MS` и через
  `--outage-ticks` ставят вселенную на паузу — автоколебание, вызванное
  настройкой. Проверяется тестом.

---

## 8. Диск: порог и поведение при заполнении

Это главный операционный риск отступления О-2.

**Порог.** `ANU_LIVE_MIN_FREE_BYTES=8589934592` (8 GiB). **У движка страж
диска по умолчанию ВЫКЛЮЧЕН**: CLI берёт `0` («default: 0, the guard is
off»), супервизор — `options.minFreeBytes ?? 0`, и при нуле проверка не
выполняется вовсе; экспортируемая константа `LIVE_DEFAULT_MIN_FREE_BYTES`
(20 GiB) в коде не используется нигде. Поэтому значение **обязано быть
задано явно**, и потерянная переменная означает не «более строгий порог
по умолчанию», а отсутствие защиты — вселенная забьёт boot-диск вместе с
ОС и docker. Защита от этого поставлена дважды: форма `:?` в
`compose.live.yml` и `ExecStartPre` в `anu-live.service`.

8 GiB оставляют место на: чекпойнт текущего тика, полный реплей и
аттестацию текущей эпохи (они пишут `summary.json` и `attestations/`
**после** того, как страж мог сработать), журналы docker (3 x 10 MB на
сервис), аудит шлюза (**до 640 MiB**: активный файл плюс 4 ротированных
по 128 MiB) — и запас, чтобы оператор успел выгрузить улики.

**Поведение.** Страж диска проверяет `statfs` корня улик перед каждой
эпохой и на каждом тике. При падении ниже порога вселенная **встаёт на
паузу на границе тика**: текущий тик доигрывается, чекпойнт ложится на
диск, и дальше не коммитится ничего. Пауза не оставляет следа в уликах; в
логе раннера появляется `{"status":"paused","reason":"low_disk"}`.
Восстановление — проба каждые `probeIntervalMs`; как только места стало
больше, эпоха продолжается с той же границы и завершается **байт в байт**
так же, как если бы паузы не было.

**Ёмкость.** По измерению §5: ~18.3 MB на эпоху 0. При ~10 GB на ОС,
docker и образы и 8 GiB резерва остаётся ~31 GB, то есть **порядка 1700
эпох (~425 000 тиков) при сохранении плотности эпохи 0**. Это верхняя
оценка: эпоха, в которой популяция обеднела, весит в 4–5 раз меньше
(измерено: 3.7 MB), а эпоха с втрое более длинными ответами модели — во
столько же раз больше (порядка 570 эпох).

**Сведение с бюджетом шлюза.** Одна эпоха `fast` — 4 000 запросов и
6 320 000 токенов. При латентности `fast` ~1 с и восьми одновременных
запросах эпоха идёт порядка 10–17 минут, то есть темп до ~22 млн токенов
в час. Именно поэтому окно поднято до 36 млн токенов и 30 тыс. запросов в
час, а `rate-per-minute` — до 900: окно должно быть предохранителем от
разгона, а не потолком нормальной работы. Если окно всё же исчерпано,
это видно в журнале шлюза (`token_window_exhausted`) и **не** является
инцидентом провайдера (Ш9, критерий 4).

**Что делать при приближении к порогу** (ручная, обратимая процедура —
автоматической выгрузки нет, §9):

1. убедиться, что эпоха завершена (есть `summary.json`,
   `attestations/final.json` и ссылка `chain/<k>.json`);
2. **проверить, что архиву есть куда лечь**:
   `df -B1 --output=avail "$ANU_LIVE_LAB_ARCHIVE_DIR"` — свободного места
   должно быть не меньше удвоенного размера переносимой эпохи;
3. скопировать каталог эпохи в `$ANU_LIVE_LAB_ARCHIVE_DIR/U0001/<runId>/`
   и проверить копию (`sha256sum` по `events.jsonl` и аттестации);
4. удалить с VM **только** каталоги полностью завершённых, скопированных
   и подтверждённых эпох. **`chain/` не удалять никогда** — это индекс
   всей жизни вселенной; и не удалять эпоху, которая является родителем
   текущей.

**Архив на Lab — временная станция, а не хранилище.** Lab несёт витрины
всей экосистемы на том же диске, и полный корпус улик («порядка 1700
эпох», ~31 GB) съел бы почти всё его свободное место. Правило удержания:
на Lab держатся только эпохи, ещё не перенесённые на постоянный носитель
или в объектное хранилище; как только эпоха уехала дальше, её копия с
Lab удаляется. Постоянное хранилище улик появляется вместе с ops-хостом
(§9).

---

## 9. Отложено до увеличения квот

Ничего из перечисленного не является дефектом этой фазы: это работа,
которую физически некуда поставить на одной машине.

| Отложено | Разблокируется |
|---|---|
| Вынос когниции и ключа провайдера с хоста улик (О-1) | квота vCPU |
| Выделенный диск улик, tick-атомарная реплика, автоматическая выгрузка завершённых эпох, постоянное хранилище архива (О-2) | квота дисков |
| Ops-хост: второй Observer, независимая верификация каждой ссылки цепочки (`replay` + `verify-attestation`), якорение в S3 (и только вместе с ним — каталог `anchors/`), сверка аудита шлюза с уликами (О-3) | квота vCPU + дисков |
| Правила firewall для отдельных подсетей когниции и ops | вместе с подсетями |
| `think-fabric` — статический allowlist egress шлюза (О-4) | вместе с cog-хостами |
| **`flock` на файле аренды писателя** — блокировка, валидная между pid-namespace'ами. Сейчас доказательство протухшей аренды читает `/proc/<pid>` в своём namespace и живого писателя в другом контейнере не видит; до появления `flock` от двух писателей защищает только предохранитель `ExecStartPre` в `anu-live.service` | изменение движка, не квоты |
| Профиль `edge` (Caddy, TLS, публичный адрес витрины) | привязанный внешний адрес + DNS-запись **[владелец]**. При включении проверить отдельно: публикация портов ставит DNAT в `nat/PREROUTING`, который **обходит правила уровня хоста** — host-level firewall на VM здесь не работает и рассчитывать на него нельзя. Матчер `remote_ip` в `caddy/Caddyfile` работает только если Docker сохраняет исходный адрес клиента; убедиться по логам Caddy, что он видит настоящий адрес, а не адрес docker-моста |
| Prometheus/Loki/Grafana поверх этой вселенной, алерт «ключ истекает» | ops-хост |

**Компенсация к О-4, которую надо поставить сразу и на самой VM.** Egress
шлюза не ограничен ничем, а шлюз — единственный держатель ключа
провайдера. До появления `think-fabric` закрыть контейнерам доступ к
link-local адресу метаданных облака, через который можно попытаться
получить инстанс-креды VM. Правило обратимо:

```bash
# ПРЕДПОЛОЖЕНИЕ, требующее проверки: доступен ли 169.254.169.254 из контейнеров.
sudo docker run --rm --network anu-live_llm-egress curlimages/curl:latest \
  -s -m 3 -o /dev/null -w '%{http_code}\n' http://169.254.169.254/ || true
# Если доступен — закрыть (проверив, что агент облака от этого не страдает):
sudo iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
```

---

## 10. Остановка, пауза, аварийная остановка

| Что нужно | Как | Что происходит с вселенной |
|---|---|---|
| Штатная остановка | `systemctl stop anu-live.service` | SIGTERM -> пауза на границе тика, чекпойнт на диске, контейнеры остановлены. Возобновление продолжает ту же эпоху |
| **Перезапуск docker** | `systemctl restart docker` | **Наследует остановку вселенной: до 12 минут** (`PartOf=docker.service` + `TimeoutStopSec=720`, раннер доигрывает тик и пишет чекпойнт). Это не зависание; **прерывать нельзя** |
| Остановить только мышление | деактивировать ключ SA у провайдера **[владелец]** | шлюз перестаёт давать ответы; через `--outage-ticks` подряд идущих тиков без ответа страж ставит вселенную на паузу на границе тика |
| Пауза по диску | автоматически | см. §8 |
| После `kill -9` / OOM | автоматически | `restart: unless-stopped` поднимает раннер; `--recover-stale-lease true` перехватывает аренду, которую процесс **доказательно** признал протухшей (сменился `boot_id` хоста либо pid держит процесс с другим временем старта). Граница доказательства — между контейнерами оно не работает, см. §9 |
| Полная остановка стека | `systemctl disable --now anu-live.service` | контейнеры остановлены; улики, тома и сети на месте |

Ротация секретов, восстановление из резервной копии и учёт ключей —
`deploy/mws/RUNBOOK.md` §5–6 и `deploy/mws/KEYS.md`.

---

## 11. Открытый вопрос владельцу: судьба `deploy/**` в публичном репозитории

Ветка `feat/genesis-live` не запушена, раскрытия ещё не произошло. Всё
измеримое из находки 17 исправлено: адресов, идентификатора проекта,
подсетей, имён пользователей и ссылок на внутренние документы закрытых
проектов в отслеживаемых файлах больше нет, а граница закреплена тестом.

Остаётся решение, которое агент принять не может: **должен ли каталог
`deploy/**` вообще существовать в публичном репозитории.** Даже
обезличенный, он описывает топологию боевого развёртывания. Два варианта:

- **A.** Оставить как есть — обезличенные артефакты в публичном репо,
  реальные значения только в `deploy/mws/target.env` на машине оператора.
  Это текущее состояние ветки.
- **B.** Вынести `deploy/mws/**`, `compose.live.yml` и `.env.live.example`
  в закрытый репозиторий, оставив в публичном только ссылку.

Вопрос зарегистрирован в `docs/ROADMAP_AMENDMENTS.md` (раздел «Open, awaiting
the owner»). Ответ владельца записывается туда же, в Decision log, его
собственными словами — **до push**.
