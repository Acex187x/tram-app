# Полный технический аудит Tram Spotter

Дата аудита: 2026-07-13  
Область: Expo SDK 57, React Native, Mapbox, live feed, lifecycle, производительность,
физическая модель, calibration pipeline, тесты и release hygiene.

Документ описывает состояние рабочего дерева на момент аудита. Параллельно в нём
находились незакоммиченные изменения `TramLayers`, map sprites, calibration sessions и
локальные build artifacts. Аудит не менял эти файлы.

## Краткий вывод

У проекта хорошая базовая архитектура:

- физический engine не зависит от React;
- map frames отправляются императивно, без React state на каждом кадре;
- есть zoom-adaptive cadence, viewport culling и lifecycle через `AppState`;
- тормозной envelope остаётся жёстким ограничением поверх catch-up/TOD логики;
- команда не включала неподтверждённые TOD-коэффициенты и оставила R8 zonal dwell
  выключенным в release;
- документация честно фиксирует data gaps и эксплуатационные проблемы.

Главные ограничения сейчас находятся не в визуальном качестве моделей, а в четырёх
системных областях:

1. Фоновая ride-симуляция интегрирует только четверть прошедшего времени.
2. Calibration schema и Python replay не воспроизводят настоящий shipped engine.
3. Прямой Golemio feed, geometry cache и whole-fleet render path плохо масштабируются.
4. Часть физических выводов смешивает platform dwell, traffic holds и результат самой
   модели.

До устранения P0/P1 проблем не следует включать новые физические коэффициенты в release:
нет достаточно надёжного измерительного контура, который докажет улучшение.

## Проверки, выполненные во время аудита

- `npx tsc --noEmit` — успешно.
- Expo Doctor — 20/20.
- `npx expo install --check` — зависимости согласованы с Expo SDK 57.
- Основной Jest-прогон — 27 suites / 456 tests, успешно.
- Добавленный позднее sprite suite — 22/22 отдельно, успешно.
- React Compiler healthcheck — 84/84 components скомпилированы.
- `npm run lint` — ошибка: 55 errors и 42 warnings.
- Измеренное покрытие включённых файлов: 87.49% statements, но map/UI lifecycle почти
  не инструментирован; `vehicles.ts` покрыт примерно на 4%, `shapeCache.ts` — на 7%.
- `docs/calibration` занимает около 711 MB; локальный `build/` — около 27 MB.

Точные Expo 57 требования сверялись с
[Expo SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/).

## Приоритеты

| Приоритет | Значение |
| --- | --- |
| P0 | Уже искажает пользовательские/калибровочные данные; исправить первым |
| P1 | Существенный риск correctness, battery, long-session stability или release |
| P2 | Важное улучшение, но допустимо после P0/P1 |
| P3 | Поддерживаемость, документация и дальнейшее развитие |

---

## P0. Фоновая ride-симуляция идёт примерно в четыре раза медленнее

### Где

- `src/hooks/tramData.ts:34-42, 200-224`
- `src/lib/engine/engine.ts:402-447`
- `__tests__/motionlog-ride-background.test.ts:88-107`

### Что происходит

В `rideBackground` runtime вызывает `engine.tick()` раз в 1000 ms. Основной engine
вычисляет elapsed time, но ограничивает `dtS` значением `MAX_ENGINE_DT_S = 0.25`.
Остальные примерно 750 ms отбрасываются.

Например, трамвай с целевой скоростью 8 m/s при одном вызове в секунду интегрирует только
около 2 m. Это систематически искажает:

- `simDist`;
- `lagM` в ride recording;
- deviation относительно пользовательского GPS;
- любые calibration выводы, полученные после lock/background.

Projection sim уже умеет интегрировать большой интервал substep'ами, поэтому внутри
engine существуют оба разных поведения времени.

### Что изменить

1. Разделить понятия «защита от огромного resume gap» и «обычный coarse cadence».
2. Для `rideBackground` интегрировать весь разумный elapsed interval substep'ами не более
   250 ms.
3. Каждый substep должен выполняться для всего флота, после чего должны применяться queue
   constraints. Нельзя сначала полностью продвинуть один tram, затем другой: это меняет
   взаимодействие очередей.
4. При настоящем pause/resume явно сбрасывать engine clock, чтобы не проигрывать минуты
   suspension.
5. Ограничить допустимый catch-up interval, например documented budget 1–2 seconds;
   большие разрывы должны приводить к re-anchor, а не к долгому синхронному циклу.

Возможный API:

```ts
engine.tick(nowMs, {
  elapsedPolicy: 'substep',
  maxCatchUpMs: 1_500,
});
```

Обычный foreground path может сохранить защитное clamp-поведение, если это сознательное
решение, но оно должно быть явно отделено от ride cadence.

### Как проверить

- Один и тот же engine fixture за 10 секунд при cadence 16, 100, 250 и 1000 ms должен
  приходить в почти одинаковые `sM/vMs/phase`.
- Добавить очередь из двух tram и убедиться, что coarse cadence не создаёт overlap.
- Добавить pause gap, который не должен проигрываться после resume.
- Провести device ride с lock screen и сравнить `simDist` до/после фикса.

---

## P1. Calibration schema недостаточна для однозначного анализа

### Где

- `src/lib/feed/calibration.ts:24-45`
- `src/lib/feed/types.ts`
- `src/lib/engine/engine.ts:675-731`
- `docs/calibration/replay.py:62-102`
- `docs/calibration/dwell_v2.py:88, 150-157`

### Проблема

Текущая запись не содержит:

- `tripId`;
- `shapeId`;
- raw observed coordinates;
- источника dwell: scheduled или fallback;
- фактически применённого experiment treatment;
- версии physical profile.

При этом `lat/lng` берутся из `TramPublicState.position`, то есть из позиции модели, а не
из сырой AVL-позиции. Zone analysis частично классифицирует данные результатом той же
модели, которую пытается проверить.

Python scripts вынуждены определять смену trip эвристикой по большому откату `obsDist`.
Смена маршрута без такого отката может склеить два trip одного вагона. Одинаковое
`shapeDist` на разных shapes также становится неоднозначным.

### Что изменить

Ввести schema v3 с явным `schemaVersion` и как минимум следующими полями:

```ts
interface CalibrationRecordV3 {
  schemaVersion: 3;
  deliveredAtMs: number;
  observedAtMs: number;
  key: string;
  tripId: string;
  shapeId: string | null;
  line: string;
  modelId: TramModelId;

  observedDistM: number | null;
  observedLng: number | null;
  observedLat: number | null;

  simDistM: number | null;
  projectedDistM: number | null;
  simLng: number | null;
  simLat: number | null;
  simSpeedMs: number | null;
  phase: SimPhase | null;

  delaySeconds: number | null;
  statePosition: string | null;
  nextStopSequence: number | null;
  nearestStopSequence: number | null;
  nearestStopDistanceM: number | null;
  dwellSource: 'scheduled' | 'fallback' | null;

  paceBias: number | null;
  profileVersion: string;
  daytime: boolean;
  treatment: string | null;
}
```

Дополнительно:

- сохранить reader для v1/v2, но больше не смешивать schemas без явной нормализации;
- сегментировать анализ строго по `key + tripId + shapeId`;
- логировать raw observation до любой симуляции;
- хранить treatment/exposure непосредственно, а не восстанавливать его по parity;
- добавить build/profile version, чтобы результаты разных engine revisions не попадали в
  одну выборку.

### Как проверить

- Unit-тест должен доказать, что raw coordinates отличаются от simulated coordinates при
  ненулевом deviation.
- Trip change без отката distance обязан создать новый analysis segment.
- Один `shapeDist` на двух shapes не должен конфликтовать.
- v2 fixture должен продолжать читаться в compatibility режиме.

---

## P1. Replay gate не воспроизводит shipped engine

### Где

- `docs/calibration/replay.py:7-23, 62-82, 205-259, 464-468`
- `src/lib/engine/tramSim.ts`
- `src/lib/engine/engine.ts`
- `docs/calibration/analysis-2026-07-13.md:1035-1046`

### Проблема

Текущий replay сознательно является coarse 1D approximation:

- нет настоящей geometry;
- нет stop table и schedule anchor;
- нет реального braking envelope;
- нет stop hold, adaptive dwell, departure burst и queue graph;
- `obsAt` используется как признак нового fix, но время движения считается по poll receipt
  `t`;
- stuck semantics отличаются от engine;
- projection redesign не моделируется.

Поэтому script полезен как exploratory analysis, но недостаточен как обязательный release
gate. Последний R62 также был принят при `|err| p50 +3.6%`, хотя заранее записанный gate
требовал отсутствие роста. Возможно, trade-off был оправдан снижением ahead bias, но тогда
gate должен быть multi-objective и pre-registered.

### Что изменить

1. Создать TypeScript replay runner, импортирующий настоящий `TramEngine`.
2. Подавать реальные `RouteGeometry`, `RouteStop`, schedule и model specs.
3. Использовать два clock:
   - `deliveredAtMs` определяет момент ingest;
   - `observedAtMs` определяет pace learning и свежесть fix.
4. Проигрывать оба публичных режима: smooth и live projection.
5. Подключить реальные queue/cross-shape constraints.
6. Сохранять агрегаты отдельно по trip, route, zone, TOD и state.
7. Оставить Python tools для статистики поверх результатов TS replay, но не дублировать
   физику на Python.

Рекомендуемый gate должен одновременно проверять:

- absolute at-fix error p50/p90;
- signed error и `%ahead`;
- device `lagM` во время ride sessions;
- teleport rate;
- hard-brake/crawl share;
- stop-arrival и departure error;
- overlap/queue violations;
- regression отдельно для centre/outskirts и daytime/night.

Допустимые ухудшения должны быть заранее записаны. Например: рост absolute p50 не более
2%, если signed bias улучшается не менее чем на 20% и не растут p90/teleports.

### Как проверить

- Один synthetic fixture должен давать тот же trace при непосредственном engine run и
  replay.
- Изменение `A_ACC`, dwell или queue logic обязано реально менять replay metrics.
- CI должен падать при нарушении pre-registered thresholds.

---

## P1. Прямой Golemio feed слишком дорог и раскрывает общий credential

### Где

- `src/lib/golemio/client.ts:210-287`
- `src/lib/golemio/vehicles.ts:20-46`
- `src/lib/feed/localGolemioFeed.ts:77-166`

### Наблюдение

Клиент каждые пять секунд загружает весь `/v2/vehiclepositions?limit=10000`, затем
фильтрует трамваи локально. Один контрольный ответ во время аудита составлял около
146 KB gzip и 1.66 MB decoded JSON. При 12 запросах в минуту это примерно:

- 100 MiB/hour сетевого трафика;
- 1.12 GiB/hour распакованного JSON для parsing/allocations.

Все устройства используют `EXPO_PUBLIC_GOLEMIO_KEY`. Локальный scheduler ограничивает
одно устройство, но не общую нагрузку всех установок. Значение `EXPO_PUBLIC_*` неизбежно
попадает в JS bundle и не является секретом — см.
[Expo environment variables](https://docs.expo.dev/guides/environment-variables/).

### Что изменить сейчас

- добавить request timeout через `AbortController`;
- поддержать `Retry-After`;
- exponential backoff + jitter для 429/5xx/network errors;
- отдельная политика для 401, которая не повторяет запрос каждые пять секунд;
- ограничить максимальный response size, если transport позволяет;
- валидировать payload до ingest;
- сделать polling адаптивным: foreground/followed/idle/background;
- использовать отдельный ротируемый application key и мониторинг квоты.

### Целевая архитектура

Реализовать `RemoteFeed`:

1. Backend загружает Golemio один раз для всех пользователей.
2. Фильтрует tram-only fields и нормализует schema.
3. Вычисляет compact diffs относительно предыдущей версии.
4. Публикует WebSocket/SSE stream или короткий versioned poll.
5. Кэширует GTFS geometry и отдаёт её по version/hash.
6. Хранит Golemio credential только на сервере.
7. Применяет общую rate limit/quota policy.

Текущая `TramFeed` абстракция требует доработки: map/planner напрямую читают глобальный
`shapeCache`, поэтому `LocalFeed → RemoteFeed` пока не является настоящей 1:1 заменой.
Geometry repository/snapshot должен войти в feed contract или стать отдельным явно
инъецируемым сервисом.

### Как проверить

- Network budget на клиенте должен измеряться в KB/min, а не десятках MB/min.
- Десять клиентов не должны умножать upstream Golemio polling на десять.
- Credential не должен находиться в IPA/main.jsbundle.
- Offline/reconnect не должен создавать request storm.

---

## P1. Geometry cache не является LRU и не ограничен

### Где

- `src/lib/golemio/shapeCache.ts:30-190`
- `src/components/map/RouteNetwork.tsx:57-209`
- `src/hooks/tramData.ts:418-427`
- `src/app/planner.tsx:145`

### Проблема

`shapeCache` хранит все когда-либо загруженные `tripId` в обычных `Map`. Eviction нет.
Disk TTL проверяется только при новом чтении того же trip, поэтому старые файлы, к которым
больше не обращаются, остаются навсегда.

`getAllLoaded()` создаёт новый массив. `RouteNetwork` раз в две секунды сканирует весь
набор, а при изменении fingerprint полностью строит и сериализует routes/stops/totems.
Planner получает новый array identity на UI update и может перестраивать graph без
изменения geometry.

Это наиболее правдоподобный источник деградации длинной 6–9-часовой сессии.

### Что изменить

Создать `GeometryRepository` со следующими свойствами:

- canonical geometry keyed by `shapeId + serviceVersion`;
- отдельные trip-specific stop-times/mappings;
- LRU limit по реальным байтам/точкам, а не только количеству keys;
- pin активных, selected, followed и planner-used shapes;
- background eviction неприкреплённых entries;
- disk quota и startup/service-day sweep;
- atomic versioned snapshot;
- subscription `onGeometryAdded/Removed`;
- counters: entries, points, estimated bytes, hit/miss, disk bytes, evictions.

`RouteNetwork` должен инкрементально добавлять новые unique shapes/stops либо пересобирать
network только при изменении `geometryVersion`, а не по таймеру. Planner должен получать
stable snapshot identity.

### Как проверить

- После проигрывания полного service day память cache не превышает установленный budget.
- Повторный trip на том же shape не дублирует coordinates.
- Startup sweep удаляет expired files без повторного запроса trip.
- Planner не вызывает `buildNetwork` при обычном 1 Hz UI update.
- 9-hour soak не показывает монотонного роста geometry objects.

---

## P1. Whole-fleet state строится на 60 Hz до viewport culling

### Где

- `src/components/map/TramLayers.tsx:242-325`
- `src/lib/engine/engine.ts:653-731`
- `src/lib/render/featureBuilder.ts:305-391`
- `src/hooks/tramData.ts:140-143`

### Проблема

На close zoom каждый frame начинает с `engine.getStates(nowMs)`. Для каждого tram
создаются public object, coordinate arrays, model data, observed/projected positions и
bearing. Viewport culling выполняется только после этого.

При 500 tram и 60 Hz создаётся примерно 30 000 public-state objects в секунду плюс
вложенные arrays. Затем `coupledPairFn` для видимых tram повторно вызывает `getState()`.

Points FeatureCollection также содержит весь флот и на близком zoom может отправляться в
native Mapbox примерно 15 раз в секунду. Это нарушает собственный performance invariant:
полный флот не должен пересылаться часто.

### Что изменить

1. Добавить компактный render snapshot/iterator без UI-only полей.
2. Хранить в engine cached head world coordinate, обновляемую вместе с sim tick.
3. Сначала выполнять дешёвый viewport/spatial culling с pan margin.
4. Только для оставшихся tram вычислять precise bearing, model scale, section geometry и
   rich properties.
5. Selected/followed tram хранить отдельным обязательным слоем, чтобы его не потерял
   culling.
6. Передавать coupling flag непосредственно из engine entry/model resolution.
7. Использовать reusable/double buffers для features и coordinates там, где RN bridge это
   позволяет.
8. Разделить cadence:
   - полный fleet city view: 0.2–1 Hz;
   - viewport points: до 15 Hz;
   - detailed visible sections: frame cadence;
   - selected/followed tram: frame cadence независимо.

### Метрики

Добавить signposts/counters вокруг:

- `engine.tick`;
- render snapshot;
- viewport culling;
- `buildFrame`;
- JSON/GeoJSON byte size;
- `ShapeSource.setNativeProps`;
- native source parse/update.

### Как проверить

- Synthetic 500/1000 tram benchmark.
- Allocations/sec должны зависеть от visible fleet, а не от total fleet.
- Панорамирование не должно терять tram на границе благодаря margin.
- На stationary close view Mapbox должен иметь возможность перейти в idle.

---

## P1. `feed.stop()` не отменяет всю незавершённую работу

### Где

- `src/lib/feed/types.ts:85-114`
- `src/lib/feed/localGolemioFeed.ts:84-105`
- `src/lib/golemio/shapeCache.ts:131-174`
- `src/lib/golemio/client.ts:154-169, 245-287`
- `src/hooks/tramData.ts:250-330`

### Проблема

Контракт `TramFeed.stop()` обещает отмену всей работы, но фактически abort применяется
только к position poll. Geometry prefetch не принимает lifecycle signal. Запрос в очереди
scheduler замечает abort лишь после получения slot и способен зря потратить будущую quota.

После background/stop приложение может продолжать HTTP, parsing, disk read/write и cache
mutation.

### Что изменить

- создавать session-level `AbortController` при каждом `feed.start()`;
- передавать signal через runtime → feed → geometry repository → GTFS fetch → scheduler;
- немедленно удалять aborted waiter из scheduler queue;
- ставить generation guard перед cache/disk write;
- разделить cancellation пользователя, timeout и lifecycle abort в diagnostics;
- новый `start()` всегда должен использовать новую generation/session.

### Как проверить

- Background во время холодного geometry prefetch оставляет ноль активных requests.
- Aborted queued request не расходует rate slot.
- Late completion старой generation не записывает cache.
- Resume создаёт новую рабочую session без восстановления старых promises.

---

## P1. Production постоянно пишет passive calibration log

### Где

- `src/hooks/tramData.ts:313-321`
- `src/lib/feed/localGolemioFeed.ts:20-47, 118-123`
- `src/lib/motionlog/core.ts:341-470`
- `src/lib/motionlog/fs.ts:19-29`

### Проблема

Каждый snapshot batch повторно материализует состояние всего флота, сериализует записи в
JSONL и выполняет файловую запись. Документированный темп около 400 KB/min означает около
24 MB/hour. Disk retention ограничивает общий размер, но не постоянные allocations, JSON
encoding, flash I/O и battery cost.

### Что изменить

- release default: passive logging off;
- явный diagnostics/calibration toggle или отдельный dev/internal build profile;
- sampling выбранных tram вместо полного флота;
- bounded batch queue и asynchronous writer;
- отдельная retention/quota policy;
- понятная пользовательская формулировка для device ride telemetry;
- агрегировать production health metrics без полного raw JSONL.

### Как проверить

- Release build без opt-in не создаёт calibration files.
- Instruments показывает отсутствие periodic file I/O.
- Calibration build явно отображает active recording и размер данных.

---

## P1. Background location используется вне документированного Expo 57 contract

### Где

- `src/lib/motionlog/location.ts:1-115`
- `app.json:14-20, 56-60`

### Проблема

Код запрашивает только `requestForegroundPermissionsAsync()`, после чего вызывает
`startLocationUpdatesAsync()` и сообщает режим `background`. Точная Expo SDK 57
документация требует background/Always permission для iOS background tracking:
[Expo Location SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/location/).

В native реализации могут существовать частные исключения для user-initiated tracking,
но UI и код не должны полагаться на недокументированный contract. Иначе запись может
незаметно прекратиться после lock/background и создать biased calibration sample.

### Что изменить

1. Запрашивать foreground permission с понятным UX.
2. Перед началом background ride отдельно запрашивать background permission.
3. Проверять реальный permission scope, включая `Allow Once`.
4. Не показывать режим `background`, пока native task действительно не стартовал.
5. Сохранять ride deadline и проверять его в каждом location callback, а не только через
   JS timer: timer ненадёжен при suspension.
6. Документировать fallback foreground-only режим.

### Как проверить

Device matrix:

- fresh install;
- Allow Once;
- While Using;
- Always;
- lock screen на 10–20 минут;
- background → terminate → relaunch;
- permission revoked из Settings;
- 90-minute deadline после suspension.

---

## P1. Входные Golemio данные валидируются слишком мягко

### Где

- `src/lib/golemio/vehicles.ts:49-104`

### Проблема

Некоторые отсутствующие/невалидные значения преобразуются в допустимые, но ложные:

- coordinates → `[0, 0]`;
- неизвестный `shape_dist` → `0`;
- отсутствующий timestamp → `Date.now()`.

Один partial feature может вызвать teleport, неправильный trip segmentation или ложный
pace sample.

### Что изменить

- runtime schema validation;
- finite/range checks для Prague coordinates;
- nullable unknown distance вместо настоящего нуля;
- drop/quarantine records без ключевых полей;
- отдельные counters по причинам rejection;
- observed timestamp не подменять delivery time без явного quality flag;
- не обучать paceBias на low-quality observations.

### Как проверить

- Fuzz/property tests на missing, string, NaN, Infinity и out-of-range значения.
- Невалидная запись не создаёт tram в `[0,0]` и не меняет существующий sim.

---

## P1. R8 zonal dwell пока не готов к release

### Где

- `docs/calibration/dwell_v2.py:194-218, 273-336`
- `docs/calibration/analysis-2026-07-13.md:840-909`
- `src/lib/engine/speedProfile.ts:193-205`
- `src/lib/engine/tramSim.ts:373-405, 657-664`

### Проблема данных

«Uncensored dwell budget» суммирует любое flat `obsDist`, не требуя
`statePosition === at_stop`. В него попадают:

- ожидание на светофоре;
- пробка;
- incident hold;
- terminal layover;
- настоящее platform dwell.

Именно midpoint этого смешанного бюджета использован для centre ×1.30 и outskirts ×0.90.
At-stop estimator существует, но сильно right-censored.

Treatment применяется только к fallback dwell, а исходная популяция смешивает scheduled и
fallback dwells. Кроме того, zonal factor участвует в dwell deduction для `paceBias`, то
есть A/B одновременно меняет stop time и learned cruise pace. Parity-группы не являются
случайной независимой выборкой; несколько окон двух соседних дней нельзя считать 24
независимыми повторениями.

### Что изменить

- оставить release flag выключенным;
- добавить schema v3 поля nearest stop, distance, dwell source и explicit treatment;
- выделить traffic hold в отдельную модель/метрику;
- считать platform dwell как interval-censored event только рядом со stop и с учётом
  `statePosition`;
- проверить pre-treatment balance по line/model/zone;
- использовать stable stratified assignment или crossover;
- считать cluster bootstrap/permutation по vehicle/trip/day;
- собрать несколько независимых weekdays;
- завершить live A/B и TypeScript replay.

### Как проверить

Shipping возможен только если одновременно проходят:

- live A/B primary metrics;
- outskirts non-regression;
- fleet-level neutrality;
- replay gate;
- device ride stop-arrival metrics;
- отсутствие роста teleports, crawl и queue violations.

---

## P1/P2. Smooth target формально остаётся schedule-paced

### Где

- `src/lib/engine/tramSim.ts:325-349, 840-912`

### Проблема

`observedDistAt()` продвигает последнее наблюдение на
`schedule(now) - schedule(obsAt)`. Затем `targetDistAt()` смешивает этот результат с самим
schedule. Производная обоих компонентов между fixes равна скорости расписания.

Следовательно, `OBS_BLEND_WEIGHT = 0.75` регулирует offset, но не темп target. При
расхождении фактического и расписанного движения controller вынужден компенсировать это
через catch-up/crawl. Для live `projSim` R11 уже удалил schedule target chasing; smooth sim
сохранил старый механизм.

### Что изменить

- использовать dead-reckoned observation/`projSim` как основной motion target;
- оценивать velocity по robust trailing observations или alpha-beta filter;
- schedule оставить low-gain reference с bounded residual;
- увеличивать вес schedule только с возрастом observation;
- при свежем moving fix доверять observation velocity больше;
- при stale fix постепенно снижать confidence, а не мгновенно переходить на schedule pace.

### Как проверить

- Synthetic feed с реальной скоростью 50%, 100% и 130% расписания.
- Smooth mode не должен периодически чередовать sprint/crawl.
- Signed/absolute at-fix error сравнить в TypeScript replay и device ride.

---

## P1/P2. `paceBias` использует арифметическое среднее caps вместо travel-time среднего

### Где

- `src/lib/engine/speedProfile.ts:300-337`
- `src/lib/engine/tramSim.ts:647-686`

### Проблема

`meanCruiseCapOver()` считает length-weighted arithmetic mean. Для движения по участкам
правильная средняя скорость определяется временем прохождения:

```text
expectedTime = Σ(distance_i / speed_i)
expectedSpeed = totalDistance / expectedTime
```

Для равных участков 5 и 10 m/s arithmetic mean равно 7.5 m/s, а физическое значение —
6.67 m/s. Идеально следующий caps tram поэтому выучит ложный `paceBias ≈ 0.889`.
Ошибка зависит от количества slow zones/curves и может выглядеть как zonal либо
vehicle-specific эффект.

### Что изменить

- precompute cumulative expected travel time по profile;
- учитывать braking envelope и, при достаточной точности, acceleration/deceleration;
- рассчитывать ожидаемый inter-fix pace как `ds / ΔexpectedTime`;
- отдельно вычитать только доказанный platform dwell;
- version profile cache при изменении алгоритма.

### Как проверить

- Unit-test 5/10 m/s должен давать 6.67 m/s.
- Ideal synthetic tram на неоднородном profile должен сходиться к `paceBias = 1`.
- Route composition не должна систематически менять bias при одинаковой реальной физике.

---

## P1/P2. Центральный speed cap создаёт искусственный переключатель 07:00/19:00

### Где

- `src/lib/engine/speedProfile.ts:41-54, 251-256`
- `src/lib/engine/engine.ts:163-167, 241-250`
- `docs/calibration/analysis-2026-07-12.md:2338-2371`
- `docs/calibration/analysis-2026-07-13.md:578-603`

### Проблема

В 07:00/19:00 engine одномоментно включает/выключает central cap и перестраивает profiles
всего активного флота. Calibration зафиксировала скачки bias при почти плоской feed speed.

Это одновременно:

- меняет physical target без изменения дороги;
- загрязняет TOD inference сменой denominator;
- создаёт single-tick profile rebuild всего флота.

### Что изменить

- если cap является настоящим инфраструктурным ограничением, применять его постоянно;
- если это traffic model, вынести в отдельный плавный zone × TOD multiplier;
- не смешивать legal/comfort caps с traffic priors;
- кэшировать curvature отдельно от TOD/zone factor;
- profile changes выполнять инкрементально или иметь готовые варианты.

### Как проверить

- Нет скачка target speed/bias ровно в 07:00 и 19:00.
- TOD analysis использует стабильный denominator.
- Profile transition не создаёт заметный JS frame spike.

---

## P2. Queue correction нарушает монотонность позиции

### Где

- `src/lib/engine/tramSim.ts:1-4`
- `src/lib/engine/engine.ts:605-648`

### Проблема

При overlap same-shape и cross-shape constraints присваивают follower меньшее `sM`.
Renderer не получает `lastTeleportMs`, поэтому показывает движение назад без fade.

Cross-shape constraints применяются одним проходом. Цепочка из трёх shapes может остаться
неконсистентной в зависимости от порядка pairs. Fixed offset также может на несколько
секунд пережить развилку до следующего ingest.

### Что изменить

- по возможности ограничивать velocity до интеграции, а не исправлять position после;
- unavoidable correction маркировать как teleport/correction event;
- пересчитывать stop state, если correction пересекла stop boundary;
- строить единый constraint graph для mixed-shape queues;
- выполнять bounded fixed-point relaxation;
- переоценивать lateral/bearing validity пары около junction.

### Как проверить

- Monotonicity test для обычного движения.
- Три tram на трёх shapes без overlap после одного engine tick.
- Teleport/reseed leader не создаёт незаметный backward jump follower.
- Pair перестаёт действовать после divergence на junction.

---

## P2. Stuck hold может остановить tram впереди raw fix

### Где

- `src/lib/engine/tramSim.ts:754-779, 916-922`
- `__tests__/engine-realism.test.ts:153-189`

### Проблема

Если к моменту второго same-position fix smooth sim уже проехал `stuckAtM`, logic ставит
target speed в ноль, но не возвращает position. Tram остаётся остановленным впереди
наблюдения. Существующий test проверяет остановку, но не дистанцию до anchor.

### Что изменить

- на втором подтверждающем stuck fix делать bounded correction к raw fix;
- небольшую коррекцию можно сглаживать, крупную маркировать teleport/fade;
- хранить confidence/count последовательных stationary fixes;
- освобождать hold только на fresh moving observation.

### Как проверить

- Sim, находящийся на 30–50 m впереди fix, после подтверждения stuck оказывается в
  допустимом radius от anchor.
- Release движущимся fix не создаёт reverse motion.

---

## P2. Stop hot path повторно сканирует массивы

### Где

- `src/lib/engine/tramSim.ts:527-533`
- `src/lib/engine/speedProfile.ts:350-397`

### Проблема

Каждый physics tick ищет следующий undwelled stop с начала массива. `vAllowedAt()` снова
проходит stops; после `d > horizon` используется `continue`, хотя сортированный список
позволяет `break`.

### Что изменить

- хранить monotonic `nextStopIndex` в `TramSim`;
- сбрасывать/пересчитывать его при teleport, reanchor и trip change;
- использовать binary search для первого stop в horizon;
- precompute braking envelope либо cumulative stop index;
- заменить `continue` на безопасный `break` после подтверждения sorted invariant.

### Как проверить

- Benchmark 300/500/1000 tram × 60 Hz.
- Physics trace должен оставаться bit-identical на существующих fixtures.

---

## P2. Mapbox stop totems оставляют тени включёнными

### Где

- `src/components/map/RouteNetwork.tsx:331-372`
- `src/components/map/TramLayers.tsx:462-463`

### Проблема

У tram models `modelCastShadows` и `modelReceiveShadows` явно выключены, а у stop totems
нет. В Mapbox Style Spec оба свойства по умолчанию `true`:
[Mapbox layer specification](https://docs.mapbox.com/style-spec/reference/layers/).

При большом количестве stop models это возвращает дорогие shadow passes.

### Что изменить

```ts
modelCastShadows: false,
modelReceiveShadows: false,
```

Также при `plannerActive` лучше ставить layer visibility `none` или очищать source, а не
только `modelOpacity: 0`, чтобы невидимые модели не участвовали в обработке.

### Как проверить

- Metal/Energy comparison на z ≥ 16 с большим количеством stops.
- В planner mode невидимые totems не создают draw/shadow workload.

---

## P2. Full-screen 3D viewer работает одновременно со скрытой картой

### Где

- `src/app/_layout.tsx:41-44`
- `src/app/index.tsx:55-56`
- `src/app/model/[id].tsx:322-346`
- `src/components/map/TramLayers.tsx`

### Проблема

`fullScreenModal` сохраняет предыдущий map screen смонтированным. Viewer запускает свой
GL render loop, а `AppState` остаётся `active`, поэтому map runtime, engine tick и GeoJSON
frame listeners продолжают работу под modal.

### Что изменить

- ввести runtime occlusion/suspension token;
- при открытии full-screen viewer останавливать map frame listeners/source pushes;
- переводить engine в idle/coarse cadence, если нет другого видимого consumer;
- восстанавливать состояние при закрытии;
- не применять это автоматически к form sheet, где живая карта является частью дизайна.

### Как проверить

- JS/Metal profiles с закрытым и открытым viewer.
- Под viewer нет map source updates.
- После закрытия карта продолжает движение без большого catch-up jump.

---

## P2. Follow camera не переходит в idle на остановке

### Где

- `src/components/map/TramLayers.tsx:330-371`

### Проблема

`setCamera` вызывается примерно каждые 80 ms даже при неизменной position/bearing, каждый
раз начиная новую animation. Native map не получает спокойного stationary периода.

### Что изменить

- position deadband в метрах;
- bearing deadband в градусах;
- не отправлять target, равный предыдущему;
- на dwell использовать более редкий cadence;
- немедленно обновлять только при user follow recovery/teleport.

### Как проверить

- Во время 30-second dwell число `setCamera` вызовов близко к нулю.
- Начало движения не имеет заметной задержки.

---

## P2. Planner и RouteNetwork зависят от случайно прогретого cache

### Проблема

Network строится из geometry текущих/недавно наблюдавшихся trip. На cold start planner
может иметь неполный graph, а результаты меняются по мере появления fleet geometry.

### Что изменить

- иметь versioned static GTFS graph как отдельный asset/backend dataset;
- live trip geometry использовать для визуализации и version reconciliation, а не как
  единственный источник planner network;
- кэшировать derived indexes по `networkVersion`;
- явно показывать network loading/degraded state.

### Как проверить

- Один planner query даёт одинаковый результат на cold и warm start.
- Отсутствие конкретного live tram не удаляет его линию из planner graph.

---

## P2. Несколько независимых 1 Hz timers

Отдельные timers существуют в planner, tram details, guidance, fleet browser, ride
recorder, stops timeline и RouteNetwork. Часть продолжает просыпаться в background и лишь
проверяет `AppState` внутри callback.

### Что изменить

- общий AppState-aware application clock;
- подписчики с требуемым cadence;
- timer создаётся только при наличии subscribers;
- RouteNetwork перейти на repository events;
- UI countdowns брать immutable `{sampledAtMs, value}` вместо `Date.now()` во время
  render.

### Как проверить

- В background нет JS timer wakeups, кроме явно разрешённого ride path.
- Один shared tick обслуживает все 1 Hz UI consumers.

---

## P2. `useSyncExternalStore` snapshot не полностью консистентен

### Где

- `src/hooks/tramData.ts:400-405`

### Проблема

Hook подписывается на numeric version, но во время render вызывает
`engine.getState(key, Date.now())`. Данные могут измениться при стороннем rerender без
изменения external-store snapshot. Это создаёт tearing и lint purity error.

### Что изменить

Публиковать immutable snapshot:

```ts
{
  version,
  sampledAtMs,
  statesByKey,
}
```

`getSnapshot()` должен возвращать стабильную identity до следующей публикации. Компонент
не должен читать mutable engine и текущее время во время render.

### Как проверить

- Повторный render без version bump возвращает тот же snapshot.
- Concurrent/Strict rendering не меняет отображаемое состояние внутри одного render.

---

## P2. Prague time fallback неверен зимой

### Где

- `src/lib/engine/speedProfile.ts:64-103`
- `src/lib/golemio/gtfs.ts:51-80`
- `docs/calibration/replay.py:109-123`
- Python calibration analyzers, использующие host timezone

### Проблема

Engine fallback и replay фиксируют UTC+2. В CET Prague использует UTC+1. При проблемах с
`Intl` TOD buckets и day/night boundary смещаются на час.

### Что изменить

- один shared Prague-time module;
- IANA `Europe/Prague` в JS и Python;
- reuse уже существующей deterministic offset logic из GTFS;
- никогда не использовать timezone хоста неявно;
- писать timezone/profile timestamp в analysis metadata.

### Как проверить

- Winter/summer dates.
- Обе стороны DST transition.
- Engine, replay и analyzer обязаны возвращать один Prague hour.

---

## P2. Harvester перечитывает всю историю каждые десять минут

### Где

- `scripts/calibration/harvest.sh:11-15`

### Проблема

`awk '!seen[$0]++' "$d" "$f"` читает destination целиком и строит hash всех строк на
каждом drain. При файлах 517 MB и 186 MB это O(total history) time/memory каждые десять
минут. Такой host load способен сам создавать simulator stalls, которые затем выглядят
как physics/performance проблема.

### Что изменить

- append-only drain после успешной ротации source;
- persistent watermark/sequence id;
- chunk rotation по времени/размеру;
- checksum каждого chunk;
- dedupe один раз offline;
- analysis всегда streaming/`--since`, без полного live-file pass.

### Как проверить

- Стоимость одного harvest зависит только от нового chunk.
- 24-hour run не увеличивает время/RAM каждого следующего harvest.

---

## P2. Mapbox attribution/logo могут перекрываться BottomDock

### Где

- `src/app/index.tsx:225-239`
- `src/components/map/MapChrome.tsx:233-285, 590-607`

### Риск

Default ornaments располагаются в нижних углах, а BottomDock занимает ту же safe-area
область. Без device screenshot это вероятный, но не окончательно подтверждённый overlap.
Mapbox attribution должна оставаться видимой и доступной:
[Mapbox attribution requirements](https://docs.mapbox.com/help/dive-deeper/attribution/).

### Что изменить

- явно задать `logoPosition` и `attributionPosition`;
- поднять ornaments над максимальной высотой dock;
- учитывать iPhone/iPad, orientation и safe-area;
- проверить кликабельность attribution action.

---

## P2/P3. Lint и CI

### Состояние

`expo lint` возвращает 55 errors и 42 warnings. Основные группы:

- render-time `Date.now()`;
- ref reads/writes, которые lint считает происходящими во время render;
- `set-state-in-effect`;
- import order;
- asset `require()` warnings.

Часть Gesture API ref errors может быть false positive для imperative callback builders.
Это не повод глобально отключать rules. React Compiler healthcheck проходит 84/84, поэтому
lint failure не означает, что compiler сейчас не работает, но quality gate остаётся
красным.

### Что изменить

- исправить настоящие purity нарушения через immutable external snapshots/shared clock;
- gesture-builder исключения делать локально и документировать;
- вынести asset registration pattern в допустимый lint helper/config;
- добавить `.github/workflows` или эквивалентный CI.

Минимальные CI steps:

1. `npm ci`
2. `npx tsc --noEmit`
3. `npm run lint`
4. `npm test -- --runInBand`
5. Expo config/doctor check
6. TypeScript replay gate
7. Mapbox expression validation
8. GLB/sprite asset validation
9. Performance smoke benchmark

---

## P2/P3. Репозиторий и build context слишком велики

### Состояние

- `docs/calibration` — около 711 MB.
- `sim-2026-07-12.jsonl` — около 517 MB.
- `sim-2026-07-13.jsonl` — около 186 MB на момент аудита.
- `build/` — около 27 MB и не игнорируется.
- Отдельного `.easignore` нет.

### Что изменить

- raw sessions вынести в object storage, DVC или Git LFS;
- в Git оставить sampled fixtures, reproducible analysis scripts и итоговые reports;
- добавить `/build/`, `*.ipa` и raw calibration patterns в ignore policy;
- создать `.easignore`, исключающий reports/raw data/scripts, не нужные приложению;
- если IPA с Golemio credential когда-либо распространялся, ротировать credential;
- документировать artifact retention и release upload process.

### Как проверить

- Fresh clone не загружает сотни MB raw telemetry.
- EAS build context не содержит calibration sessions и локальные IPA.

---

## P3. Физическая модель: дальнейшие улучшения после восстановления measurement loop

Следующие идеи разумны, но пока являются гипотезами и не должны обходить replay/device
gates.

### Jerk-limited acceleration

Текущие `A_ACC = 1.3` и `A_BRK = 1.4` создают мгновенное изменение acceleration. Для
визуального реализма полезнее ограничить jerk и построить S-curve start/braking profile.
Параметры следует извлечь из device ride GPS/IMU, а не подбирать только визуально.

### Per-model constants

Разные Tatra/Škoda действительно могут иметь разные traction/braking profiles, но
текущие AVL fixes редко позволяют отделить vehicle physics от traffic/dwell. Per-model
параметры стоит вводить только после накопления достаточного количества ride sessions на
каждом типе.

### Curvature noise

`curvatureProfile` агрегирует повороты GTFS polyline. Шумные vertices/стрелки могут
создавать ложные caps вплоть до 1.4 m/s. Нужны:

- histogram caps по всей сети;
- map overlay low-cap segments;
- comparison с ride speed;
- geometry smoothing с сохранением реальных кривых.

### Departure burst debt

Burst не хранит явный debt. Controller может погасить его crawl до следующей остановки, а
terminal/skip не гарантируют repayment. Следует логировать интеграл добавленной скорости
и проверять, что burst улучшает форму профиля, не меняя segment travel time.

### Traffic-light/traffic hold model

Вместо смешивания traffic stops с dwell лучше выучить отдельный segment/zone × TOD prior:

- вероятность hold;
- распределение длительности;
- регуляризация к общему network prior;
- отдельные параметры для dedicated track и street-running участков.

---

## Что уже сделано хорошо и должно быть сохранено

- React state не обновляется на каждом map frame.
- `ShapeSource` стабилен и получает данные через imperative updates.
- Есть zoom hysteresis и thermal-aware tick cadence.
- Tram model shadows явно отключены.
- Braking envelope остаётся hard constraint для catch-up, burst и TOD.
- `paceBias` использует настоящий `observedAtMs` и time-based EWMA.
- Stuck samples с малым `Δs` не обучают paceBias.
- Pace memory и engine entries имеют TTL.
- Projection coarse integration уже использует substeps.
- TOD tables остались нейтральными после отрицательных evidence gates.
- R8 release path структурно выключен до окончания эксперимента.
- Core engine хорошо покрыт unit tests.
- Expo SDK 57 dependency alignment корректен.

Эти свойства являются полезными invariants. Оптимизации не должны возвращать React
rerenders на frame cadence, обходить braking envelope или включать коэффициенты без
replay/device evidence.

## Рекомендуемый план работ

### Этап 1 — восстановить корректность данных

1. Исправить background time integration.
2. Добавить documented background location permission flow.
3. Ввести calibration schema v3.
4. Создать TypeScript replay на настоящем engine.
5. Зафиксировать multi-objective replay thresholds.
6. Оставить TOD/R8 release constants нейтральными до повторной валидации.

### Этап 2 — устранить архитектурные источники нагрузки

1. Timeout/backoff/cancellation для всех requests.
2. Bounded `GeometryRepository` и versioned subscriptions.
3. Render snapshot с culling до public-state allocations.
4. Отключить stop-totem shadows.
5. Suspend map под full-screen viewer.
6. Follow-camera deadband.
7. Passive calibration default-off.

### Этап 3 — вынести feed на backend

1. Реализовать `RemoteFeed` и geometry API.
2. Server-side credential/quota/cache.
3. Compact diffs вместо full city JSON.
4. Offline/reconnect/backpressure protocol.
5. Удалить прямые зависимости UI от local `shapeCache`.

### Этап 4 — исправить physics estimators

1. Dead-reckoned smooth target вместо schedule-paced derivative.
2. Travel-time expected pace вместо arithmetic mean caps.
3. Разделить physical caps и traffic priors.
4. Исправить queue correction/stuck anchor semantics.
5. Повторить zonal dwell experiment на schema v3.

### Этап 5 — release и long-session gates

1. Зелёный lint/CI.
2. Synthetic 500/1000 tram benchmarks.
3. 6–9-hour memory/CPU soak.
4. Instruments Time Profiler + Allocations + Energy + Metal.
5. Device matrix для background ride.
6. Replay и device-ride regression report как release artifact.

## Definition of Done для крупного performance/physics изменения

Изменение считается готовым, когда:

- сформулирована проверяемая гипотеза;
- есть baseline на том же dataset/device;
- добавлены unit/integration tests;
- TypeScript replay проходит заранее записанные thresholds;
- нет ухудшения queue/teleport/crawl metrics;
- пройден device scenario, если изменение касается lifecycle/GPS/Mapbox;
- для hot-path изменения есть allocation/time profile;
- документация и constants comments соответствуют коду;
- `tsc`, lint, Jest и CI зелёные;
- raw evidence и итоговый report сохранены отдельно от app build context.

## Итоговый порядок приоритетов

Если выполнять работу последовательно, наибольший эффект дадут:

1. background integration fix;
2. schema v3 + настоящий replay;
3. backend feed и request lifecycle;
4. bounded geometry repository;
5. early viewport culling/render snapshot;
6. smooth target + travel-time pace estimator;
7. повторный zonal dwell/traffic анализ;
8. только затем jerk/per-model physics и дальнейшая визуальная полировка.

Главный принцип: сначала сделать измерение надёжным, затем оптимизировать pipeline, и
только после этого снова обучать физические параметры.
