# Clipper

Grabador automático de partidas para Windows con eventos del juego marcados sobre la línea temporal.
Soporta **VALORANT**, **Rainbow Six Siege** y **League of Legends**.

Graba la partida completa y guarda los eventos como metadatos. Al abrir la grabación, la timeline
muestra kills, muertes, headshots y asistencias, y un clic en cualquier marcador salta al instante exacto.

---

## 1. Investigación previa: qué es real y qué no

Antes de escribir código verifiqué la documentación y el **código fuente oficial** de Overwolf
(repositorios `overwolf/ow-electron-packages-types` y `overwolf/ow-electron-packages-sample`).
Estos son los hechos comprobados sobre los que se apoya el proyecto:

### Overwolf GEP no existe como SDK independiente

Es la limitación que condiciona todo lo demás. `overwolf.games.events` solo existe dentro del
ecosistema de Overwolf: o una app Overwolf empaquetada (`.opk`), o **ow-electron**, que es un fork
de Electron mantenido por Overwolf. No hay librería npm que se pueda añadir a un Electron normal.

La vía elegida es **ow-electron**, que expone los paquetes en `app.overwolf.packages`.

### La API real de GEP (verificada en los tipos oficiales)

```ts
app.overwolf.packages.gep.setRequiredFeatures(gameId, features)   // features: string[] | undefined
app.overwolf.packages.gep.getInfo(gameId)
app.overwolf.packages.gep.getFeatures(gameId)

gep.on('game-detected', (event, gameId, name, ...args) => event.enable())
gep.on('new-game-event',  (event, gameId, data) => ...)   // data: { gameId, feature, key, value }
gep.on('new-info-update', (event, gameId, data) => ...)   // + campo `category`
gep.on('elevated-privileges-required', (event, gameId, name, pid) => ...)
gep.on('game-exit', ...)
gep.on('error', ...)
```

Sin llamar a `event.enable()` dentro de `game-detected`, GEP no envía nada para ese juego.

### Game IDs reales

Tomados de `gep-supported-games.d.ts` del paquete oficial:

| Juego | Game ID |
|---|---|
| VALORANT | `21640` |
| Rainbow Six Siege | `10826` |
| League of Legends | `5426` |
| League of Legends PBE | `22848` |

### Los tres juegos NO usan el mismo formato

Esto es lo que más condiciona el diseño de los adaptadores:

| Juego | Feature | Evento | Valor |
|---|---|---|---|
| VALORANT | `kill` | `kill`, `assist`, `headshot` | **contador acumulado** |
| VALORANT | `death` | `death` | **contador acumulado** |
| Rainbow Six | `kill` | `kill`, `headshot` | **`null`** (evento discreto) |
| Rainbow Six | `death` | `death`, `knockedout`, `killer` | **`null`** / UUID |
| League of Legends | `kill` | `kill` | **JSON**: `{label, count, totalKills}` |

Aplicar diferencia de contadores a Rainbow Six perdería todas las kills menos la primera.
Por eso cada juego tiene su propio adaptador y ninguno conoce el formato de los demás.

Detalles adicionales encontrados en la documentación:

- **VALORANT no emite eventos de ronda.** `round_phase` es un *info update*
  (`shopping` → `combat` → `end`). Las rondas se derivan de esas transiciones.
- **`matchEnd` de League of Legends está deprecado.** La documentación remite a la feature
  `announcer` (`victory` / `defeat`), que es lo que usa el adaptador, dejando `matchEnd` como respaldo.
- **El `killer` de Rainbow Six llega en un mensaje aparte** del `death`. Se adjunta a la muerte
  mediante un sistema de parches con ventana temporal, no como marcador propio.

### Requisitos de distribución (importante)

Cita literal del README oficial del sample de Overwolf:

> *"Dev Mode lets you run and test the gaming packages (GEP, Overlay, Recorder) locally, without
> having to sign your app first. **Without valid credentials, the app still runs, but the gaming
> packages stay inactive** and production validation kicks in instead."*

Es decir:

- Para **desarrollar y probar** hacen falta credenciales gratuitas de desarrollador de Overwolf
  (`OW_CLI_EMAIL` + `OW_CLI_API_KEY`, o `OW_DEV_KEY`).
- Para **distribuir** hacen falta dos firmas: la de Overwolf (integridad de los paquetes) y la tuya
  (certificado de firma de código de una CA reconocida: DigiCert, Sectigo…).

Sin credenciales la aplicación arranca igual, pero sin eventos de juego **de VALORANT y
Rainbow Six**. League of Legends sigue funcionando al completo gracias al proveedor nativo que se
describe en el punto siguiente. Clipper **lo dice explícitamente en la interfaz** en lugar de fallar
en silencio.

---

## 1 bis. Independencia de Overwolf

Overwolf es la vía principal, pero no la única. Estos son los caminos alternativos que investigué,
con su verdad por juego:

| Juego | Alternativa sin Overwolf | Estado |
|---|---|---|
| **League of Legends** | Live Client Data API de Riot | **Implementada** |
| **Rainbow Six Siege** | Parseo de los ficheros de repetición del juego | **Implementada** |
| **VALORANT** | Historial personal de partidas de Riot | **Implementada** (sin headshots) |

### League of Legends: implementado y sin Overwolf

`RiotLiveClientProvider` consulta `https://127.0.0.1:2999/liveclientdata/allgamedata`, el endpoint
que el propio cliente de Riot expone en local. Es exactamente la **misma fuente** que la feature
`live_client_data` de GEP envuelve, así que ir directamente no pierde nada; de hecho gana, porque
entrega el nombre del asesino, de la víctima y de los asistentes, datos que los contadores de GEP
no exponen.

Es HTTP local de solo lectura sobre un endpoint que Riot documenta en su portal. No hay inyección,
ni lectura de memoria, ni contacto con el proceso del juego. Riot lo marca como "no soportado
oficialmente para terceros", que es el mismo estatus bajo el que Overwolf usa esta fuente.

**Precisión superior a GEP.** El sondeo cada segundo introduciría hasta un segundo de imprecisión
si nos limitáramos a la hora de llegada. Se evita usando el reloj de la partida: la respuesta trae
`gameData.gameTime` y cada evento su `EventTime`. La diferencia dice **exactamente** cuánto hace
que ocurrió el evento, y se envía como `latencyHintMs`, que tiene prioridad sobre la compensación
fija estimada. Para League of Legends, la sincronización es mejor sin Overwolf que con él.

**Prioridad entre proveedores.** GEP manda cuando está conectado, porque cubre los tres juegos.
La API de Riot entra cuando GEP no está disponible. Nunca se alimentan los dos a la vez: se
duplicarían las kills.

### Rainbow Six Siege: implementado y sin Overwolf

Siege escribe un fichero de repetición (`.rec`) por ronda mediante la función **Match Replay** que
incluye Ubisoft. `R6ReplayProvider` vigila esa carpeta y, al aparecer la repeticion de una ronda
terminada, la lee y extrae las kills, headshots y muertes del jugador local.

Leer esos ficheros es legítimo: son datos que el propio juego deja en el disco del usuario. No hay
inyección, ni lectura de memoria, ni contacto alguno con el proceso.

**El formato.** Es binario y propietario. La estructura implementada está verificada contra
`r6-dissect` (MIT), que es la referencia del formato:

- Cabecera en texto plano con la firma `dissect`, seguida de pares clave-valor con la marca
  temporal de la ronda, el mapa, el número de ronda y la lista de jugadores.
- Cuerpo comprimido con zstd, en dos variantes: una sola trama (versiones antiguas) o varias
  tramas concatenadas con posibles huecos entre ellas (Y8S4 en adelante).
- Dentro del cuerpo no hay índice: los paquetes se localizan buscando firmas de bytes y leyendo
  los valores que vienen detrás. Los desplazamientos cambian según la versión del juego, así que
  se aplican según el `codeVersion` de la cabecera.

**Un detalle de Node que obligó a leer trama a trama.** `zstdDecompressSync` se detiene al terminar
la primera trama e ignora el resto, a diferencia de la librería que usa la implementación de
referencia. Se resuelve con el descompresor en flujo, cuyo `bytesWritten` indica exactamente cuántos
bytes consumió esa trama y permite localizar la siguiente. Buscar la firma a ciegas no valdría: los
mismos cuatro bytes pueden aparecer por azar dentro de datos comprimidos.

**No es tiempo real.** La repetición de una ronda aparece cuando la ronda acaba, así que los
marcadores se añaden por bloques. Para revisar un vídeo después da igual, pero tiene una
consecuencia práctica: la última ronda se escribe cuando el juego ya se ha cerrado, así que Clipper
espera unos segundos antes de consolidar la grabación para no perderla.

**Precisión temporal: anclaje por el final de la ronda.** Cada evento se sitúa por su instante
real, no por cuándo se leyó el fichero.

La forma intuitiva sería anclar al inicio: la cabecera dice cuándo empezó a grabarse la ronda. El
problema es que el reloj de ronda no arranca en ese momento — antes va la fase de preparación, que
dura distinto según el modo de juego y no se puede deducir del fichero. Eso obligaría a calibrar a
mano.

Anclando por el **final** el problema desaparece. Un evento con el reloj en `C` ocurrió
`C − C_final` segundos antes de acabar la ronda, y la ronda acaba cuando el juego termina de
escribir el fichero, es decir, su fecha de modificación. El único desconocido pasa a ser el retardo
de escritura, de un par de segundos, en vez de los cuarenta y pico de la preparación.

Hay una segunda ventaja: Siege tiene **dos cuentas atrás**, la de preparación y la de acción, y
ambas aparecen en el mismo flujo. Medir desde el valor más alto observado da por hecho que hay una
sola cuenta monotónica; medir la diferencia entre dos valores del mismo tramo es inmune a eso.

**Cuándo se recurre al inicio.** La fecha de modificación deja de significar nada si las
repeticiones se copian o se mueven, así que se comprueba que sea coherente con la cabecera: el
final tiene que caer después del inicio, dentro de una duración plausible, y el tiempo de reloj
consumido tiene que caber en el tiempo real transcurrido. Si algo no cuadra se vuelve al anclaje
por el inicio, y ahí sí entra en juego **Configuración → Eventos → Desfase de las repeticiones de
Rainbow Six**. En uso normal no hay que tocarlo.

**Requisito:** el usuario debe tener activado Match Replay en el juego. Si no existe la carpeta de
repeticiones, Clipper lo avisa explícitamente en lugar de quedarse callado.

### VALORANT: implementado y sin Overwolf

No hay kills en tiempo real —Riot no las expone y su política rechaza los overlays que dan ventaja
durante la partida— pero sí hay algo mejor de lo que parecía: **el historial personal de partidas**,
que esa misma política acepta de forma explícita.

**Cómo funciona.** El cliente de Riot escribe un `lockfile` con un puerto y una contraseña. Con
ellos se le piden al propio cliente las credenciales de la sesión, y con esas credenciales se
consulta el detalle de tus partidas. Sin inyección, sin lectura de memoria, sin contacto con el
proceso del juego: es leer un fichero que el cliente deja en tu disco y hacer peticiones HTTPS a
los servidores de Riot sobre tus propias partidas.

**Es la mejor sincronización de los tres juegos.** El detalle trae `gameStartMillis` (el instante
absoluto de inicio) y cada kill su `gameTime` en milisegundos desde ese inicio. Sumándolos sale el
momento exacto del evento. Rainbow Six necesita un ajuste manual porque su fichero no dice cuándo
arranca el reloj de ronda; aquí ese problema sencillamente no existe.

**Lo que no da: headshots.** El detalle solo trae disparos a la cabeza agregados por ronda, que no
permiten saber si el disparo mortal lo fue. Deducirlo sería inventarse el dato, así que esta vía no
emite headshots. Es la única diferencia funcional frente a Overwolf.

**Manejo de credenciales.** Los tokens son credenciales de la cuenta. Viven solo en memoria, nunca
se escriben en el registro ni en la base de datos, y solo viajan a `*.a.pvp.net`. Todo el código
que los toca está en `ValorantLocalAuth` y `ValorantMatchApi`.

**Es post-partida**, como Rainbow Six: la partida aparece en el historial cuando termina.

---

## 2. Stack elegido

| Capa | Elección | Motivo |
|---|---|---|
| Runtime | **ow-electron 42.7.1** (Electron 42 / Node 24.18 / Chromium 148) | Única vía para GEP. Fork de Electron, no una plataforma distinta. |
| Lenguaje | **TypeScript** estricto | Modelo de eventos compartido y verificado entre procesos. |
| Interfaz | **React 18 + Vite** | Reproductor `<video>` nativo con aceleración por hardware. |
| Captura | **Paquete `recorder` de ow-electron** (OBS por debajo) | NVENC / AMF / Quick Sync y captura del *proceso* del juego. |
| Captura de respaldo | **FFmpeg** con `ddagrab` (Desktop Duplication por GPU) | Para que siempre se grabe algo, aunque falte el ecosistema Overwolf. |
| Eventos sin Overwolf | **API local de Riot** (LoL), **parser de repeticiones** (R6) e **historial de partidas** (VALORANT) | Fuentes que exponen los propios juegos, sin intermediarios. |
| Base de datos | **`node:sqlite`** | SQLite real integrado en Node 24. Sin módulos nativos ni `electron-rebuild`. |
| Clips y miniaturas | **FFmpeg** | Recorte por copia de flujos, sin recodificar. |
| Tests | **Vitest** | 298 tests, incluidos de integración real con FFmpeg. |

### Por qué `node:sqlite` y no `better-sqlite3`

Verificado empíricamente en este proyecto: ow-electron 42.7.1 incorpora Node 24.18, que trae
`node:sqlite` estable. Un módulo nativo como `better-sqlite3` obligaría a recompilar contra el ABI
del fork de Electron en cada actualización, con cadena de compilación de C++ en la máquina del
usuario. `node:sqlite` da SQLite real (transacciones, índices, WAL) con cero fricción.

---

## 3. Arquitectura

```
                       ┌──────────────────┐
   GEP (ow-electron) ──│   GepProvider    │──┐
                       └──────────────────┘  │
   Riot Live Client ───│ RiotLiveClient   │──┤   (LoL, sin Overwolf)
                       └──────────────────┘  ▼
   tasklist (respaldo) ─│ ProcessWatcher │─► GameDetectionService ──► RecordingManager
                                             │   (máquina de estados)      │
                                             ▼                             ├─► ScreenRecorder
                                       GameAdapter                         │    ├── OverwolfRecorder
                                       ├── ValorantAdapter                 │    └── FFmpegRecorder
                                       ├── RainbowSixAdapter               │
                                       └── LeagueOfLegendsAdapter          ├─► Database (SQLite)
                                             │                             │
                                             ▼                             └─► SidecarStore
                                        EventManager                            (recording.json)
                                             │
                                        RecordingClock
                                             │
                                             ▼
                                   IPC ──► Timeline UI / PlaybackEngine
```

Cada capa está aislada: el `EventManager` no sabe de bases de datos, los adaptadores no saben de
Electron, y el `RecordingManager` no sabe si graba con OBS o con FFmpeg.

### Estados del detector

```
IDLE ──game-detected──► GAME_DETECTED ──grabación iniciada──► RECORDING
  ▲                           │                                    │
  │                           └────────── fallo ──────► ERROR      │
  └──────────── GAME_ENDED ◄────────── game-exit ◄─────────────────┘
```

---

## 4. Sincronización: el problema y la solución

Es la parte más delicada del proyecto y merece explicación aparte.

### El problema real

El grabador de Overwolf emite `recording-started` con un payload que contiene `filePath` pero
**no contiene `startTimeEpoch`**. Ese campo solo aparece en `RecordStopEventArgs`, es decir, al
*terminar*. Verificado en la especificación de tipos oficial.

Traducido: en el instante en que empezamos a grabar **no sabemos con exactitud cuándo se escribió
el primer frame**. Entre la llamada a `startRecording()` y el primer frame pasan decenas o cientos
de milisegundos (arranque de OBS, negociación del encoder, enganche del proceso del juego).

### La solución: anclaje en dos fases

**Fase 1 — ancla provisional.** Al recibir `recording-started` se guarda el par
(reloj monotónico, reloj de pared). Todos los eventos se posicionan contra ese ancla usando
**solo el reloj monotónico** (`process.hrtime.bigint()`). Suficiente para la interfaz en vivo.

**Fase 2 — re-anclaje autoritativo.** Al recibir `recording-stopped` llega el `startTimeEpoch` real.
Se calcula la desviación y se aplica como corrección constante a **todos** los eventos: en memoria,
en SQLite (`UPDATE` en bloque) y en el `recording.json`.

La corrección es constante porque el desfase es un *offset de arranque*, no una deriva: dentro de una
misma grabación el reloj monotónico y el del encoder avanzan al mismo ritmo.

### Por qué monotónico y no `Date.now()`

Una partida puede durar 40 minutos. Si durante ese tiempo el reloj del sistema salta (sincronización
NTP, cambio horario, ajuste manual), un ancla basada en el reloj de pared desplazaría **todos** los
marcadores posteriores. Hay un test que verifica exactamente esto:

```
tests/synchronization.test.ts › no se ve afectado por un salto del reloj del sistema
```

### Latencia del proveedor

Aparte del offset del vídeo existe la latencia de GEP: detecta la kill un poco *después* de que
ocurra en pantalla, porque lee el estado que el juego expone, no su memoria. Se compensa con
`latencyOffsetMs`, configurable **por juego** desde Configuración → Eventos (valores de partida:
250 ms VALORANT, 300 ms R6, 400 ms LoL). Es calibrable a ojo: si al pulsar una kill el vídeo empieza
después de la acción, se sube el valor.

### Salvaguardas

- Si el backend no devuelve `startTimeEpoch`, se conserva el ancla provisional.
- Si la corrección resultante supera **30 segundos** se descarta por considerarse dato corrupto:
  un ancla imperfecta es preferible a destrozar todos los marcadores.
- Los eventos que llegan **antes** del primer frame se bufferizan con su marca monotónica y se
  vuelcan al anclar, marcados con `beforeRecording`.

---

## 5. Seguridad y anti-cheat

Clipper **no hace** ninguna de estas cosas:

- inyección de DLL
- lectura o escritura de la memoria del juego
- modificación de ficheros, paquetes de red o procesos del juego
- envío de entradas al juego o automatización de gameplay
- hooks de teclado de bajo nivel (`WH_KEYBOARD_LL`)
- offsets, patrones de memoria ni nada dependiente de la versión del juego

Lo que sí hace, y por qué es legítimo:

| Mecanismo | Qué es |
|---|---|
| **Overwolf GEP** | Plataforma con acuerdos con los publishers. Es la vía que usan Blitz, Mobalytics, Outplayed. |
| **Captura de vídeo** | OBS por debajo (captura gráfica estándar) o FFmpeg sobre el escritorio. |
| **Detección de proceso** | `tasklist`, herramienta estándar de Windows. Solo lista procesos; no abre handles del juego ni lee su memoria. Equivale a mirar el Administrador de tareas. |
| **Atajos globales** | `RegisterHotKey` de Win32 vía `globalShortcut` de Electron. API pública y pasiva, sin relación con el proceso del juego. |

Un hook global de teclado se descartó a propósito: se parece demasiado a un keylogger y los
anti-cheat lo miran con lupa. `RegisterHotKey` consigue lo mismo sin ese riesgo.

---

## 6. Cómo ejecutarlo en Windows

### Requisitos

- Windows 10/11 x64
- Node.js 20 o superior
- GPU con NVENC, AMF o Quick Sync (recomendado; hay respaldo por software)

### Instalación

```bash
npm install
```

### Ejecución completa (con eventos de juego)

Para que GEP y el grabador de Overwolf funcionen hacen falta credenciales gratuitas de
desarrollador de Overwolf. Se obtienen en <https://console.overwolf.com>.

En PowerShell:

```powershell
$env:OW_CLI_EMAIL = "tu-email@ejemplo.com"
$env:OW_CLI_API_KEY = "tu-api-key-de-la-consola"
npm start
```

O con token de desarrollo:

```powershell
$env:OW_DEV_KEY = "tu-token"
npm start
```

### Ejecución sin credenciales

```bash
npm start
```

Qué funciona en este modo:

- **Grabación de vídeo**: sí, con FFmpeg. Usa `ddagrab` (Desktop Duplication por GPU) cuando está
  disponible, con repliegue automático a `gdigrab` si falla. Codificación por NVENC / AMF /
  Quick Sync igualmente.
- **League of Legends**: marcadores completos vía la API local de Riot.
- **VALORANT y Rainbow Six Siege**: se graban, pero sin marcadores automáticos. La interfaz lo
  avisa con un banner explícito en Inicio. Puedes marcar momentos a mano con F9.

### Otros comandos

```bash
npm test           # 171 tests
npm run typecheck  # comprobación de tipos de ambos procesos
npm run build      # compila proceso principal y renderer
npm run dist       # instalador NSIS (requiere firma de Overwolf y certificado propio)
```

### Si el juego se ejecuta como administrador

VALORANT con Vanguard y Rainbow Six con BattlEye pueden arrancar elevados. En ese caso Windows
aplica aislamiento de privilegios (UIPI) y un proceso sin elevar no recibe sus eventos ni puede
capturar su ventana con game capture.

Clipper detecta la situación (evento `elevated-privileges-required` de GEP) y muestra un aviso
concreto en lugar de fallar en silencio. La solución es abrir Clipper con
**botón derecho → Ejecutar como administrador**. Mientras tanto sigue grabando en modo pantalla.

---

## 7. Cómo probar cada juego

El flujo es el mismo en los tres: arrancar Clipper **antes** que el juego. La documentación de
Overwolf advierte de que cuanto más se tarde en registrar GEP tras arrancar el juego, mayor es la
probabilidad de perder datos.

Durante la prueba, deja abierto **Configuración → Diagnóstico**, que muestra el registro en vivo.
Deberías ver esta secuencia:

```
[GEP] Paquete GEP listo (version X)
[GameDetection] VALORANT detectado
[GEP] Features registradas para el juego 21640: kill, death, match_info, game_info, me
[Recording] Grabacion iniciada: C:\...\valorant_2026-09-02T....mp4
[Sync] Ancla provisional fijada en 2026-09-02T10:32:15.125Z
[EventManager] KILL en 27.605s
```

### VALORANT

1. Arranca Clipper, luego VALORANT.
2. Entra en una partida (vale Deathmatch, es lo más rápido para generar kills).
3. Comprueba en Inicio que el contador en vivo sube con cada kill.
4. Al terminar, abre la grabación desde *Mis partidas*.

Qué debe aparecer: `KILL`, `DEATH`, `HEADSHOT`, `ASSIST`, `MATCH_START`, `MATCH_END` y rondas
derivadas de `round_phase`. Una kill con headshot genera **dos** marcadores (kill + headshot):
es correcto y deliberado.

**Sin Overwolf.** Antes de jugar, abre **Configuración → Diagnóstico** y mira las tres líneas de
VALORANT. Con el juego cerrado verás algo así:

```
VALORANT: registro del juego   si (release-13.00-shipping-32-4990475)
VALORANT: cliente de Riot abierto   si
VALORANT: sesion disponible    no
```

Es normal: la sesión solo aparece al iniciar VALORANT. Con el juego en marcha las tres deben decir
que sí, y la región debe ser la tuya. Si es así, al terminar la partida verás en el registro:

```
[Valorant] Credenciales de la sesion de VALORANT obtenidas del cliente local
[Valorant] Partida leida: 27 eventos del jugador local
```

Dos diferencias respecto a la vía de Overwolf:

1. **Los marcadores aparecen al terminar la partida**, no durante. La partida solo entra en el
   historial cuando ha acabado.
2. **No hay headshots.** El historial no dice si el disparo mortal fue a la cabeza. Kills, muertes
   y asistencias sí, con sincronización exacta.

### Rainbow Six Siege

1. Arranca Clipper, luego Siege.
2. Una partida contra IA (*Entrenamiento con bots*) genera eventos rápido y sin arriesgar rango.
3. Comprueba especialmente los `KNOCKED_OUT`, que son evento propio distinto de la muerte.

Qué debe aparecer: `KILL`, `DEATH`, `HEADSHOT`, `KNOCKED_OUT`, `ROUND_START` / `ROUND_END`,
`MATCH_START` / `MATCH_END`. Al pasar el ratón sobre una muerte debería verse el `killer` en el
tooltip si GEP lo entregó.

**Sin Overwolf: activa antes Match Replay.** En las opciones del juego, busca la función de
repetición de partida y actívala. Sin ella no se generan los ficheros `.rec` y no habrá marcadores;
Clipper te lo avisará con un mensaje explícito. Con ella activada verás en el log:

```
[R6Replay] Vigilando repeticiones en: ...\My Games\Rainbow Six - Siege\<perfil>\MatchReplay
[R6Replay] Ronda 1 leida: 4 eventos de TuNombre
```

Ten en cuenta dos cosas de este modo:

1. **Los marcadores aparecen por rondas, no al instante.** La repetición de una ronda se escribe
   cuando la ronda termina, así que sus kills se añaden entonces, todas juntas. Al revisar el vídeo
   después están todas en su sitio.
2. **No hace falta calibrar.** Los eventos se anclan al final de cada ronda, que sí tiene un
   equivalente exacto en el reloj de pared. En el registro verás, por cada ronda, la duración
   implícita de la fase de preparación: si sale un valor razonable y constante entre rondas, el
   modelo temporal está cuadrando. El ajuste de desfase solo entra si el anclaje por el final se
   descarta, y el registro lo dice cuando pasa.

### League of Legends

1. Arranca Clipper, luego el cliente de LoL.
2. Una partida personalizada contra bots basta.
3. LoL **no tiene headshots**: el resumen muestra Kills / Muertes / **Asistencias** en su lugar.

**Este juego no necesita Overwolf.** Sin credenciales verás en el log:

```
[RiotLive] Sondeo de la Live Client Data API de Riot iniciado
[RiotLive] Partida de League of Legends detectada
[RiotLive] Jugador local identificado: TuNombre#TAG
```

Y en Inicio, el indicador de eventos dirá **"API de Riot conectado"** en lugar de GEP. Al abrir la
grabación, los tooltips de las kills mostrarán a quién mataste y los de las muertes quién te mató:
información que la vía de Overwolf no proporciona.

Qué debe aparecer: `KILL` (con la etiqueta de multikill en el tooltip cuando aplica), `DEATH`,
`ASSIST`, `RESPAWN`, `MATCH_START` y `MATCH_END` derivado del announcer.

### Probar la sincronización

La forma práctica de calibrar: haz una kill y fíjate en la hora del reloj de Windows. Luego abre la
grabación, pulsa el marcador y compara. Si el vídeo arranca sistemáticamente *después* de la acción,
sube `latencyOffsetMs` de ese juego en Configuración → Eventos.

### Probar la recuperación tras cierre inesperado

1. Empieza a grabar.
2. Mata el proceso de Clipper desde el Administrador de tareas.
3. Vuelve a abrir Clipper.

Debe aparecer un aviso de recuperación y la partida en la biblioteca marcada como *recuperada*, con
los eventos que se habían volcado al `recording.json` (que se reescribe cada 15 segundos).

---

## 8. Formato de salida

Cada partida produce dos ficheros junto al vídeo:

```
valorant_2026-09-02T10-32-15.mp4
valorant_2026-09-02T10-32-15.json
```

```json
{
  "version": 1,
  "recordingId": "…",
  "game": "valorant",
  "startTime": "2026-09-02T10:32:15.125Z",
  "startTimeEpochMs": 1756809135125,
  "duration": 1961.4,
  "resolution": "1920x1080",
  "fps": 60,
  "encoder": "jim_nvenc",
  "video": "valorant_2026-09-02T10-32-15.mp4",
  "status": "completed",
  "events": [
    { "id": "…", "type": "KILL",     "timestamp": 1756809162730, "videoTime": 27.605 },
    { "id": "…", "type": "HEADSHOT", "timestamp": 1756809192035, "videoTime": 156.91 },
    { "id": "…", "type": "DEATH",    "timestamp": 1756809236445, "videoTime": 201.32 }
  ]
}
```

El JSON cumple dos funciones: formato de intercambio legible sin la aplicación, y **diario de
recuperación** (se reescribe cada 15 s de forma atómica, mediante fichero temporal y renombrado).

La base de datos SQLite vive en `%APPDATA%\clipper\clipper.db` con las tablas `recordings`,
`events`, `clips` y `games`, e índices sobre `recording_id`, `video_time` y `type`.

---

## 9. Tests

298 tests en 14 ficheros. Los 15 escenarios que pediste, con su ubicación:

| # | Escenario | Fichero |
|---|---|---|
| 1 | Evento kill individual | `counters.test.ts`, `adapters.test.ts` |
| 2 | Contador kill 1 → 2 | `counters.test.ts` |
| 3 | Contador repetido 2 → 2 sin evento | `counters.test.ts` |
| 4 | Death | `adapters.test.ts` |
| 5 | Headshot | `adapters.test.ts` |
| 6 | Sincronización de timestamp | `synchronization.test.ts` |
| 7 | Conversión timestamp → videoTime | `synchronization.test.ts` |
| 8 | Timeline (agrupación, zoom, cientos de eventos) | `timeline.test.ts` |
| 9 | Cargar `recording.json` | `recovery.test.ts` |
| 10 | Generar clip alrededor de un evento (**FFmpeg real**) | `clips.test.ts` |
| 11 | Partida sin eventos | `eventManager.test.ts`, `database.test.ts`, `recordingManager.test.ts` |
| 12 | Juego cerrado inesperadamente | `recordingManager.test.ts`, `recovery.test.ts` |
| 13 | Grabación corrupta | `recovery.test.ts`, `recordingManager.test.ts` |
| 14 | GEP desconectado | `gepResilience.test.ts` |
| 15 | Reconexión de GEP | `gepResilience.test.ts` |

Ficheros adicionales:

| Fichero | Qué cubre |
|---|---|
| `riotLiveClient.test.ts` | Proveedor nativo de LoL: detección, deduplicado por `EventID`, traducción de kill/muerte/asistencia, precisión temporal, fin de partida y cadena completa hasta el marcador |
| `ffmpegArgs.test.ts` | Argumentos de `ddagrab` y `gdigrab`, intervalo de keyframes y flags de resistencia a cortes |
| `r6Replay.test.ts` | Parser de repeticiones de R6: cabecera, descompresión por tramas con huecos, extracción de kills/headshots/muertes, deduplicado, ficheros corruptos y cadena completa hasta el marcador |
| `valorantMatchApi.test.ts` | Vía nativa de VALORANT: lectura del lockfile y del registro del juego, extracción de kills/muertes/asistencias con instante absoluto, deduplicado, renovación de credenciales y cadena completa hasta el marcador |

`clips.test.ts` es una prueba de integración real: genera un vídeo con FFmpeg, recorta un clip y
verifica que el fichero resultante existe y es válido.

---

## 10. Estructura del proyecto

```
src/
  core/
    synchronization/   MonotonicClock, RecordingClock (anclaje en dos fases)
    events/            GameEvent, EventManager, CounterTracker
    games/             GameAdapter + Valorant / RainbowSix / LeagueOfLegends + registry
    gep/               GepProvider (envoltura de app.overwolf.packages.gep)
    providers/         RiotLiveClientProvider (LoL sin Overwolf)
                       r6/ DissectReader, ReplayParser, R6ReplayProvider (R6 sin Overwolf)
                       valorant/ ValorantLocalAuth, ValorantMatchApi,
                                 ValorantMatchProvider (VALORANT sin Overwolf)
    detection/         GameDetectionService (máquina de estados), ProcessWatcher
    recording/         RecordingManager, ScreenRecorder, OverwolfRecorder,
                       FFmpegRecorder, RecorderProxy, DiskSpaceGuard, SidecarStore
    database/          Database (node:sqlite)
    services/          Settings, Thumbnail, Clip, Hotkey, Recovery
    logging/           Logger estructurado por subsistema
  main/                Entrada de Electron, AppContext (raíz de composición), IPC
  preload/             Puente con contextIsolation
  renderer/            React: páginas, componentes (Timeline, VideoPlayer), estilos
  shared/              Tipos, canales IPC, contrato de API, lógica de timeline
tests/                 298 tests
  helpers/             Generador de repeticiones .rec sintéticas
```

---

## 11. Estado y siguientes pasos

**Fase 1 y 2 completas:** detección, grabación, integración GEP, kill/death/headshot/assist,
almacenamiento, reproductor, timeline con marcadores, biblioteca, miniaturas, clips, filtros,
resumen de partida, configuración, atajos globales, recuperación tras cierre y logging.

**Fase 3, pendiente de pulir sobre uso real:**

- Calibración de `latencyOffsetMs` para VALORANT, solo si se usa la vía de Overwolf. Las tres vías
  nativas calculan el instante de cada evento por su cuenta y no necesitan ajuste.
- El parser de repeticiones de R6 extrae kills, headshots y muertes. Los eventos de ronda
  (`ROUND_START` / `ROUND_END`) y los plants/defuses están en el formato pero aún no se leen.
- En VALORANT se podrían derivar los inicios de ronda restando `roundTime` de `gameTime` en
  cualquier kill de esa ronda. Es exacto donde hay kills, pero deja fuera las rondas sin ninguna.
- Estadísticas agregadas entre partidas (K/D por mapa, evolución temporal).
- Buffer de repetición para clips retroactivos (`startReplays` del paquete recorder, ya disponible
  en la API pero no cableado).
- El atajo F8 marca el momento y el clip se extrae al terminar la partida, porque el MP4 aún se
  está escribiendo. Con el buffer de repetición podría extraerse en el acto.

## 12. Limitaciones conocidas, sin adornos

- **Overwolf ya no es necesario para ningún juego.** Los tres tienen vía nativa. Overwolf sigue
  aportando dos cosas: eventos en tiempo real (las vías nativas de R6 y VALORANT son post-partida)
  y headshots en VALORANT.
- **La vía nativa de VALORANT no da headshots.** El historial solo trae disparos a la cabeza
  agregados por ronda, insuficiente para saber si el disparo mortal lo fue. Inventarlo sería peor
  que no darlo.
- **La vía nativa de VALORANT está verificada a medias contra el entorno real.** Se comprobó
  sobre esta máquina la lectura del lockfile, del registro del juego, de la versión del cliente y
  de la región. El intercambio de credenciales no se pudo verificar porque requiere VALORANT en
  marcha: con solo el cliente de Riot en segundo plano, su API expone siete funciones y ninguna
  ruta de sesión. Por eso existe la comprobación en Configuración → Diagnóstico.
- **El parser de repeticiones de Rainbow Six está verificado contra ficheros sintéticos, no contra
  partidas reales.** No había repeticiones disponibles en el equipo de desarrollo, así que los 38
  tests construyen ficheros `.rec` con el formato exacto y comprueban el parser de forma
  determinista. La estructura está tomada de la implementación de referencia, pero la primera
  partida real es la que confirmará que los desplazamientos coinciden con tu versión del juego.
  Si algo no cuadra, el registro de Diagnóstico lo dirá.
- **Ubisoft puede cambiar el formato de las repeticiones en cualquier parche.** Es un formato
  interno sin compromiso de estabilidad. El parser aplica desplazamientos según la versión del
  juego, así que un cambio se arregla añadiendo un caso más, pero hasta entonces esa versión se
  queda sin marcadores (nunca con marcadores erróneos: si el paquete no valida, se descarta).
- **El proveedor de Riot sondea una vez por segundo.** El coste es despreciable (una conexión local
  que falla al instante cuando no hay partida), pero la detección de fin de partida tarda unos
  3 segundos en confirmarse.
- **La distribución exige doble firma** (Overwolf + certificado de código propio).
- **Un juego elevado sin Clipper elevado** deja sin eventos, sin game capture y sin atajos globales
  mientras el juego tenga el foco. Se avisa y se degrada a captura de pantalla.
- **El modo FFmpeg captura el escritorio**, no el proceso del juego. Con `ddagrab` la captura ocurre
  en la GPU y se comporta bien a pantalla completa, pero sigue sin poder aislar la ventana del juego:
  para eso hace falta ow-electron. Si `ddagrab` falla en tu equipo (multi-GPU, sesión remota,
  drivers antiguos) se repliega solo a `gdigrab`, que consume más CPU.
- **Los clips por copia de flujos se alinean al keyframe anterior** (máximo 2 s antes, nunca después).
  Es un compromiso deliberado: recorte instantáneo y sin pérdida de calidad, a cambio de un poco más
  de contexto previo. Si la copia falla, se recodifica con corte exacto.
- **GEP depende de que Overwolf mantenga sus integraciones.** Una actualización de un juego puede
  romper temporalmente algún evento. Es un riesgo del proveedor, no del diseño.
