// Skrypt webview panelu Workery. Zero kodu inline (CSP), zero innerHTML na
// danych z dysku - kazda wartosc z transkryptow/heartbeatow idzie przez
// textContent albo przypisanie do wlasciwosci .title (bezpieczny atrybut
// tekstowy, nie znacznik).
//
// Grupowanie po ZADANIACH, nie po silnikach: korzen drzewa to zawsze sesja
// Claude, dziecmi sa jej subagenci ORAZ workery Spark/Codex, ktorych
// sessionId wskazuje na ta sesje - niezaleznie od silnika. Workery bez
// dopasowania trafiaja do grupy zapasowej "BEZ PRZYPISANIA" na koncu.
// Rozszerzenie filtruje migawke do Running/WaitingForUser (z dodatkowa
// regula widocznosci sesji przez dzieci) przed wyslaniem - patrz scanner.ts.
// Wiersz, nie karta: brak obrysu/tla poza hover, kolor tylko na plakietce
// statusu.
(function () {
  const vscode = acquireVsCodeApi();

  const TaskStatus = {
    Running: 'running',
    WaitingForUser: 'waiting_for_user',
    Idle: 'idle',
    Done: 'done',
    Failed: 'failed',
    Killed: 'killed',
    Stale: 'stale'
  };
  const TaskKind = { Session: 'session', Subagent: 'subagent', Worker: 'worker' };
  const WebviewMessageType = {
    OpenLog: 'openLog',
    OpenTranscript: 'openTranscript',
    Kill: 'kill',
    Ready: 'ready'
  };

  const NESTING_STEP_PX = 16;
  const CONTEXT_WARNING_RATIO = 0.8;
  const CONTEXT_DANGER_RATIO = 0.95;

  const root = document.getElementById('root');
  let latestTasks = [];

  // Licznik tyka wylacznie, gdy jest przynajmniej jedna karta Running I
  // widok jest widoczny - zatrzymywany calkowicie w przeciwnym razie, a nie
  // tykajacy bez sensu na pustej liscie albo w tle po ukryciu panelu.
  // WaitingForUser NIGDY nie dostaje klasy card-timer--live (patrz
  // buildTimerElement) - jego licznik jest zawsze zamrozony, bez wyjatkow.
  let tickInterval;
  let viewVisible = true;

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) {
      return;
    }
    if (message.type === 'snapshot') {
      latestTasks = Array.isArray(message.tasks) ? message.tasks : [];
      render();
      return;
    }
    if (message.type === 'visibility') {
      viewVisible = Boolean(message.visible);
      refreshTickInterval();
      return;
    }
  });

  vscode.postMessage({ type: WebviewMessageType.Ready });

  function refreshTickInterval() {
    const shouldRun = viewVisible && root.querySelectorAll('.card-timer--live').length > 0;
    if (shouldRun && !tickInterval) {
      tickInterval = setInterval(updateTimers, 1000);
    } else if (!shouldRun && tickInterval) {
      clearInterval(tickInterval);
      tickInterval = undefined;
    }
  }

  function render() {
    root.textContent = '';

    if (latestTasks.length === 0) {
      root.appendChild(buildEmptyState());
      refreshTickInterval();
      return;
    }

    const sessions = latestTasks.filter((task) => task.kind === TaskKind.Session);
    const subagents = latestTasks.filter((task) => task.kind === TaskKind.Subagent);
    const workers = latestTasks.filter((task) => task.kind === TaskKind.Worker);

    const sessionIds = new Set(sessions.map((task) => task.id));
    const attachedWorkers = workers.filter((task) => task.sessionId && sessionIds.has(task.sessionId));
    const unassignedWorkers = workers.filter((task) => !task.sessionId || !sessionIds.has(task.sessionId));

    root.appendChild(buildOverallHeader(latestTasks.length));

    const list = document.createElement('div');
    list.className = 'card-list';

    // Subagenci pogrupowani po parentId - dla depth1 to zawsze id sesji, dla
    // glebszych poziomow to id ich bezposredniego rodzica-subagenta.
    const subagentsByParent = new Map();
    for (const task of subagents) {
      if (!subagentsByParent.has(task.parentId)) {
        subagentsByParent.set(task.parentId, []);
      }
      subagentsByParent.get(task.parentId).push(task);
    }
    const attachedWorkersBySession = new Map();
    for (const task of attachedWorkers) {
      if (!attachedWorkersBySession.has(task.sessionId)) {
        attachedWorkersBySession.set(task.sessionId, []);
      }
      attachedWorkersBySession.get(task.sessionId).push(task);
    }

    for (const session of sortByStartedAtDesc(sessions)) {
      const directChildren = [
        ...(subagentsByParent.get(session.id) ?? []),
        ...(attachedWorkersBySession.get(session.id) ?? [])
      ];
      // Status/licznik rodzica to WYLACZNIE prezentacja - TaskStatus w
      // migawce zostaje nietkniety. Liczone na dowolnej glebokosci (wszyscy
      // potomkowie sesji: subagenci zagniezdzeni dowolnie gleboko + workery
      // dopiete przez sessionId), nigdy dla workerow "bez przypisania".
      const runningDescendants = collectRunningDescendants(session.id, subagentsByParent, attachedWorkersBySession.get(session.id) ?? []);
      list.appendChild(buildCard(session, 0, runningDescendants));
      appendChildrenRecursive(list, directChildren, subagentsByParent, 1);
    }
    root.appendChild(list);

    if (unassignedWorkers.length > 0) {
      root.appendChild(buildUnassignedSection(unassignedWorkers));
    }

    refreshTickInterval();
  }

  // Zbiera WSZYSTKICH potomkow o statusie Running na dowolnej glebokosci pod
  // danym korzeniem (id sesji) - subagenci przez subagentsByParent
  // (rekurencyjnie), workery tylko jako bezposrednie dzieci sesji (workery
  // sa zawsze lisciem, nigdy nie maja wlasnych dalszych dzieci).
  function collectRunningDescendants(rootId, subagentsByParent, directWorkerChildren) {
    const result = [];
    const stack = [...(subagentsByParent.get(rootId) ?? []), ...directWorkerChildren];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.status === TaskStatus.Running) {
        result.push(node);
      }
      const grandchildren = subagentsByParent.get(node.id);
      if (grandchildren) {
        stack.push(...grandchildren);
      }
    }
    return result;
  }

  // Blok dzieci jednego rodzica dostaje wlasny wrapper z odstepem 6px nad
  // pierwszym i pod ostatnim wierszem - czyta sie jako calosc przynalezna
  // do rodzica, nie jako ciag rownorzednych wierszy. Rekurencyjnie: kazdy
  // subagent z wlasnymi dziecmi dostaje analogiczny wrapper na swoim
  // poziomie.
  function appendChildrenRecursive(list, children, subagentsByParent, depth) {
    const ordered = sortByStartedAtDesc(children);
    if (ordered.length === 0) {
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'card-children';
    for (const task of ordered) {
      wrapper.appendChild(buildCard(task, depth));
      // Tylko subagenci moga miec dalsze dzieci (workery sa zawsze lisciem).
      const grandchildren = subagentsByParent.get(task.id);
      if (grandchildren) {
        appendChildrenRecursive(wrapper, grandchildren, subagentsByParent, depth + 1);
      }
    }
    list.appendChild(wrapper);
  }

  function buildOverallHeader(totalCount) {
    const header = document.createElement('div');
    header.className = 'section-header overall-header';
    const count = document.createElement('span');
    count.className = 'section-count';
    count.textContent = String(totalCount);
    header.appendChild(count);
    return header;
  }

  function buildUnassignedSection(orderedTasks) {
    const section = document.createElement('div');
    section.className = 'section';

    const header = document.createElement('div');
    header.className = 'section-header';
    const name = document.createElement('span');
    name.textContent = 'Bez przypisania';
    header.appendChild(name);
    const count = document.createElement('span');
    count.className = 'section-count';
    count.textContent = String(orderedTasks.length);
    header.appendChild(count);
    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'card-list';
    for (const task of sortByStartedAtDesc(orderedTasks)) {
      list.appendChild(buildCard(task, 0));
    }
    section.appendChild(list);

    return section;
  }

  function buildEmptyState() {
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';

    const title = document.createElement('div');
    title.className = 'empty-state-title';
    title.textContent = 'Nic nie jest w toku';
    wrapper.appendChild(title);

    const hint = document.createElement('div');
    hint.className = 'empty-state-hint';
    hint.textContent =
      'Panel pokazuje wyłącznie zadania aktualnie wykonywane oraz sesje czekające na Twoją odpowiedź.';
    wrapper.appendChild(hint);

    return wrapper;
  }

  function sortByStartedAtDesc(tasks) {
    // Malejaco po startedAt - od najdluzej dzialajacego do najswiezszego.
    // Uzywane zarowno dla korzeni (sesje), jak i dzieci na kazdym poziomie
    // drzewa oraz dla plaskiej listy "Bez przypisania".
    return [...tasks].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  function buildCard(task, depth, runningDescendants) {
    // Potomkowie Running sa liczone WYLACZNIE dla sesji (patrz render()) -
    // dla subagentow/workerow ten parametr zawsze przychodzi jako undefined.
    // To jest czysto prezentacyjne nadpisanie: TaskStatus w migawce zostaje
    // nietkniety, zmienia sie tylko to, co rysujemy.
    const hasRunningDescendant = Boolean(runningDescendants && runningDescendants.length > 0);

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = task.id;
    // Rodzic z pracujacym potomkiem nigdy nie jest wygaszony, nawet gdy
    // jego WLASNY status to WaitingForUser - etykieta "bezczynna"/"czeka"
    // nie ma prawa pojawic sie nad pracujacym dzieckiem.
    const isWaitingRow = task.status === TaskStatus.WaitingForUser && !hasRunningDescendant;
    if (isWaitingRow) {
      // Wygaszone, wracaja do pelnej widocznosci na hover/focus (patrz CSS).
      card.classList.add('card-waiting');
    }

    const content = document.createElement('div');
    content.className = 'card-content';

    // Glebokosc renderowania jest POZYCJA W DRZEWIE (parametr depth), nie
    // polem task.depth (spawnDepth istnieje tylko dla subagentow - workery
    // dopiete przez sessionId nigdy go nie maja, mimo ze sa faktycznymi
    // dziecmi sesji o glebokosci 1).
    if (depth > 0) {
      // Wciecie lewym paddingiem na WEWNETRZNYM wrapperze (nie na .card) -
      // .card sam manipuluje marginesem/paddingiem przy hover-bleed (patrz
      // CSS), wiec inline-style depth na tym samym elemencie kolidowalby z
      // tamta regula (inline zawsze wygrywa nad :hover w zewnetrznym CSS).
      card.classList.add('card-nested');
      content.style.paddingLeft = `${depth * NESTING_STEP_PX}px`;
    }

    content.appendChild(buildLine1(task, isWaitingRow, hasRunningDescendant ? runningDescendants : null));
    content.appendChild(buildLine2(task));

    const contextBar = buildContextBar(task);
    if (contextBar) {
      content.appendChild(contextBar);
    }

    card.appendChild(content);
    return card;
  }

  function buildLine1(task, isWaitingRow, runningDescendants) {
    const row = document.createElement('div');
    row.className = 'card-line1';

    row.appendChild(buildStatusBadge(task, runningDescendants));

    const title = document.createElement('span');
    title.className = 'card-title';
    if (task.kind === TaskKind.Session) {
      // Jedyna roznica typograficzna miedzy rodzicem a dziecmi - reszta
      // (rozmiar, odstepy) zostaje bez zmian.
      title.classList.add('card-title--session');
    }
    title.textContent = task.title;
    title.title = task.title;
    row.appendChild(title);

    const right = document.createElement('span');
    right.className = 'card-line1-right';
    right.appendChild(buildTimerElement(task, isWaitingRow, runningDescendants));
    right.appendChild(buildInlineActions(task));
    row.appendChild(right);

    return row;
  }

  function buildStatusBadge(task, runningDescendants) {
    // Sesja z co najmniej jednym pracujacym potomkiem reprezentuje ZADANIE
    // w toku, niezaleznie od tego, czy sama sesja jest Running, WaitingForUser
    // czy Idle - grupujemy po zadaniach, wiec status wiersza rodzica ma to
    // odzwierciedlac.
    const info = runningDescendants ? { text: 'w toku', tone: 'green' } : statusBadgeInfo(task);
    const badge = document.createElement('span');
    badge.className = info.tone ? `status-badge status-badge--tone-${info.tone}` : 'status-badge';
    badge.textContent = info.text;
    return badge;
  }

  // Status jest wspolny miedzy Claude i workerami zewnetrznymi, ale etykieta
  // i znaczenie roznia sie per TaskKind - Killed/Stale dla subagenta Claude
  // to zawsze wniosek z metadanych/wieku pliku (nie ma PID), dla workera to
  // realna weryfikacja procesu. WaitingForUser dotyczy wylacznie sesji i
  // nigdy nie dostaje koloru akcentu - to stan neutralny, nie alarm. Galezie
  // dla statusow, ktore dzis nigdy nie docieraja do webview (Done/Failed/
  // Killed/Stale/Idle) zostaja kompletne i poprawne, nie martwe.
  function statusBadgeInfo(task) {
    switch (task.status) {
      case TaskStatus.Running:
        return { text: task.kind === TaskKind.Session ? 'aktywna' : 'w toku', tone: 'green' };
      case TaskStatus.WaitingForUser:
        return { text: 'czeka', tone: null };
      case TaskStatus.Failed:
        return { text: 'błąd', tone: 'red' };
      case TaskStatus.Killed:
        return { text: task.kind === TaskKind.Subagent ? 'przerwany' : 'zabity', tone: 'red' };
      case TaskStatus.Stale:
        return { text: task.kind === TaskKind.Subagent ? 'porzucony' : 'przerwany', tone: 'yellow' };
      case TaskStatus.Done:
        return { text: 'gotowe', tone: null };
      case TaskStatus.Idle:
        return { text: 'bezczynna', tone: null };
      default:
        return { text: task.status, tone: null };
    }
  }

  function buildTimerElement(task, isWaitingRow, runningDescendants) {
    const timer = document.createElement('span');
    timer.className = 'card-timer';
    if (runningDescendants) {
      // "Jak dlugo to zadanie leci" = od startu NAJDLUZEJ dzialajacego
      // potomka, czyli tego z NAJWCZESNIEJSZYM startedAt - nie od wieku
      // wlasnej tury sesji. Tyka jak zwykly Running (card-timer--live).
      const earliestStartedAt = Math.min(...runningDescendants.map((descendant) => descendant.startedAt ?? Date.now()));
      timer.classList.add('card-timer--live');
      timer.dataset.startedAt = earliestStartedAt;
      timer.textContent = formatElapsed(earliestStartedAt, Date.now());
      return timer;
    }
    if (isWaitingRow) {
      // Zamrozony format "od X" liczony od mtime (lastActivityAt), nigdy
      // nie tyka - brak klasy card-timer--live, reguly "interwal tylko dla
      // Running" nie trzeba tu pilnowac osobno, bo ten wezel nigdy nie
      // wejdzie do zbioru elementow aktualizowanych przez updateTimers.
      const sinceMs = Math.max(0, Date.now() - (task.lastActivityAt ?? Date.now()));
      timer.textContent = formatWaitingSince(sinceMs);
      return timer;
    }
    if (task.status === TaskStatus.Running) {
      // Tyka tylko dla Running - patrz refreshTickInterval/updateTimers,
      // ktore dzialaja wylacznie na elementach z ta klasa.
      timer.classList.add('card-timer--live');
      timer.dataset.startedAt = task.startedAt ?? '';
      timer.textContent = formatElapsed(task.startedAt, Date.now());
    } else {
      // Kazdy inny status ma zamrozony czas trwania, wyliczony raz - bez
      // interwalu, bez klasy card-timer--live.
      const endMoment = task.finishedAt ?? task.lastActivityAt ?? Date.now();
      timer.textContent = formatElapsed(task.startedAt, endMoment);
    }
    return timer;
  }

  function buildInlineActions(task) {
    const actions = document.createElement('span');
    actions.className = 'card-actions-inline';

    if (task.logPath) {
      actions.appendChild(buildIconButton('log', 'Otwórz plik logu', () => {
        vscode.postMessage({ type: WebviewMessageType.OpenLog, id: task.id });
      }));
    }
    if (task.transcriptPath) {
      actions.appendChild(buildIconButton('txt', 'Otwórz transkrypt', () => {
        vscode.postMessage({ type: WebviewMessageType.OpenTranscript, id: task.id });
      }));
    }
    if (task.pid) {
      actions.appendChild(buildIconButton('×', 'Zabij zadanie', () => {
        vscode.postMessage({ type: WebviewMessageType.Kill, id: task.id });
      }));
    }

    return actions;
  }

  function buildIconButton(label, titleText, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn';
    button.textContent = label;
    button.title = titleText;
    button.addEventListener('click', onClick);
    return button;
  }

  // Jeden akcent chromatyczny na wiersz - tylko plakietka statusu niesie
  // kolor. agentType/model/effort/meta to teraz zwykly tekst w linii 2, z
  // jednym stopniem hierarchii: agentType+model w --vscode-foreground,
  // reszta w --vscode-descriptionForeground (patrz CSS .card-line2-primary
  // / .card-line2-secondary). Zero plakietek z tlem poza statusem.
  // Bez naglowkow sekcji per silnik kazdy wiersz musi sam mowic, na czym
  // leci - linia meta zaczyna sie od nazwy silnika (malymi literami).
  // Deduplikacja: gdy skrocona nazwa modelu juz zaczyna sie od nazwy
  // silnika (np. "spark-1.3" przy silniku "spark"), nazwa silnika sama w
  // sobie jest pomijana - bylaby czystym powtorzeniem.
  function buildLine2(task) {
    const line = document.createElement('div');
    line.className = 'card-line2';
    const titleParts = [];

    const modelAbbrev = abbreviateModel(task.model);
    const showEngineLabel = !(modelAbbrev && modelAbbrev.toLowerCase().startsWith(task.engine.toLowerCase()));

    if (showEngineLabel) {
      const prefixSpan = document.createElement('span');
      prefixSpan.className = 'card-line2-secondary';
      prefixSpan.textContent = task.engine;
      line.appendChild(prefixSpan);
      titleParts.push(task.engine);
    }

    const primaryParts = [];
    if (task.kind === TaskKind.Subagent && task.subtitle) {
      primaryParts.push(task.subtitle);
      titleParts.push(task.subtitle);
    }
    if (modelAbbrev) {
      primaryParts.push(modelAbbrev);
      titleParts.push(task.model);
    }
    if (primaryParts.length > 0) {
      const primarySpan = document.createElement('span');
      primarySpan.className = 'card-line2-primary';
      primarySpan.textContent = (showEngineLabel ? ' · ' : '') + primaryParts.join(' · ');
      line.appendChild(primarySpan);
    }

    const hasContext = isFiniteNumber(task.contextTokens) && isFiniteNumber(task.contextWindow) && task.contextWindow > 0;
    const hasTokens = isFiniteNumber(task.tokensUsed);

    const secondaryParts = [];
    if (task.effort) {
      secondaryParts.push(task.effort);
      titleParts.push(task.effort);
    }
    if (task.repo) {
      secondaryParts.push(basename(task.repo));
      titleParts.push(task.repo);
    }
    if (task.branch) {
      secondaryParts.push(task.branch);
      titleParts.push(task.branch);
    }
    if (task.pid) {
      secondaryParts.push(`PID ${task.pid}`);
      titleParts.push(`PID ${task.pid}`);
    }
    if (task.currentActivity) {
      secondaryParts.push(task.currentActivity);
      titleParts.push(task.currentActivity);
    }
    if (hasContext) {
      secondaryParts.push(`${formatTokenCount(task.contextTokens)}/${formatTokenCount(task.contextWindow)}`);
      titleParts.push(`kontekst ${formatWithThousandsSeparator(task.contextTokens)} / ${formatWithThousandsSeparator(task.contextWindow)}`);
    }
    if (hasTokens) {
      secondaryParts.push(formatTokenCount(task.tokensUsed));
      titleParts.push(`tokeny ${formatWithThousandsSeparator(task.tokensUsed)}`);
    }

    if (secondaryParts.length > 0) {
      const secondarySuffixSpan = document.createElement('span');
      secondarySuffixSpan.className = 'card-line2-secondary';
      secondarySuffixSpan.textContent = (showEngineLabel || primaryParts.length > 0 ? ' · ' : '') + secondaryParts.join(' · ');
      line.appendChild(secondarySuffixSpan);
    }

    if (titleParts.length > 0) {
      line.title = titleParts.join(' · ');
    }

    return line;
  }

  function buildContextBar(task) {
    const hasContext = isFiniteNumber(task.contextTokens) && isFiniteNumber(task.contextWindow) && task.contextWindow > 0;
    if (!hasContext) {
      // Brak danych - karta konczy sie na dwoch liniach, bez pustego paska.
      return null;
    }

    const track = document.createElement('span');
    track.className = 'card-context-bar-track';
    const fill = document.createElement('span');
    fill.className = 'card-context-bar-fill';
    const ratio = clamp(task.contextTokens / task.contextWindow, 0, 1);
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    // Kolor to SYGNAL, nie dekoracja - neutralny ponizej 80%, zolty od 80%,
    // czerwony od 95% (progi wlacznie, ">=").
    if (ratio >= CONTEXT_DANGER_RATIO) {
      fill.classList.add('card-context-bar-fill--danger');
    } else if (ratio >= CONTEXT_WARNING_RATIO) {
      fill.classList.add('card-context-bar-fill--warning');
    }
    track.appendChild(fill);
    return track;
  }

  function abbreviateModel(model) {
    if (!model) {
      return undefined;
    }
    const claudeMatch = /claude-(opus|sonnet|haiku|fable)/i.exec(model);
    if (claudeMatch) {
      return claudeMatch[1].toLowerCase();
    }
    const sparkMatch = /muse-spark-([0-9.]+)/i.exec(model);
    if (sparkMatch) {
      return `spark-${sparkMatch[1]}`;
    }
    const gptMatch = /gpt-[\d.]+-(luna|terra|sol|astra)/i.exec(model);
    if (gptMatch) {
      return gptMatch[1].toLowerCase();
    }
    return model.length > 14 ? `${model.slice(0, 14)}…` : model;
  }

  function formatElapsed(startedAt, endMoment) {
    if (!startedAt) {
      return '';
    }
    return formatDuration(Math.max(0, endMoment - startedAt));
  }

  function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value) => String(value).padStart(2, '0');
    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${minutes}:${pad(seconds)}`;
  }

  function formatWaitingSince(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) {
      return `od ${totalSeconds} s`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) {
      return `od ${totalMinutes} min`;
    }
    const hours = Math.floor(totalMinutes / 60);
    return `od ${hours} godz`;
  }

  function updateTimers() {
    const timers = root.querySelectorAll('.card-timer--live');
    const now = Date.now();
    timers.forEach((timer) => {
      const startedAt = Number(timer.dataset.startedAt) || undefined;
      timer.textContent = formatElapsed(startedAt, now);
    });
  }

  function formatTokenCount(n) {
    if (!isFiniteNumber(n)) {
      return '—';
    }
    if (n < 1000) {
      return String(n);
    }
    if (n < 1000000) {
      return `${Math.round(n / 1000)}k`;
    }
    let text = (n / 1000000).toFixed(1);
    if (text.endsWith('.0')) {
      text = text.slice(0, -2);
    }
    return `${text}M`;
  }

  function formatWithThousandsSeparator(n) {
    return n.toLocaleString('pl-PL');
  }

  function basename(value) {
    const parts = value.split(/[\\/]/).filter((part) => part.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : value;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }
})();
