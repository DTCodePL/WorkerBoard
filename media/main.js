// Skrypt webview panelu Workery. Zero kodu inline (CSP), zero innerHTML na
// danych z dysku - kazda wartosc z transkryptow/heartbeatow idzie przez
// textContent albo przypisanie do wlasciwosci .title (bezpieczny atrybut
// tekstowy, nie znacznik).
//
// Panel pokazuje zadania w toku (Running) i sesje czekajace na uzytkownika
// (WaitingForUser) - rozszerzenie filtruje migawke do tych dwoch statusow
// przed wyslaniem (patrz scanner.ts). Wiersz, nie karta: brak obrysu/tla poza
// hover, kolor tylko na plakietce statusu.
(function () {
  const vscode = acquireVsCodeApi();

  const TaskEngine = { Claude: 'claude', Spark: 'spark', Codex: 'codex' };
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

  const ENGINE_LABELS = { claude: 'Claude', spark: 'Spark', codex: 'Codex' };
  const ENGINE_ORDER = [TaskEngine.Claude, TaskEngine.Spark, TaskEngine.Codex];
  const NESTING_STEP_PX = 8;
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

    const waitingTasks = latestTasks.filter((task) => task.status === TaskStatus.WaitingForUser);
    const activeTasks = latestTasks.filter((task) => task.status !== TaskStatus.WaitingForUser);

    if (activeTasks.length === 0 && waitingTasks.length === 0) {
      root.appendChild(buildEmptyState());
      refreshTickInterval();
      return;
    }

    for (const engine of ENGINE_ORDER) {
      const engineTasks = activeTasks.filter((task) => task.engine === engine);
      if (engineTasks.length === 0) {
        // Sekcja bez zadan znika calkowicie - nie ma nagłowka z zerem.
        continue;
      }
      root.appendChild(buildSection(ENGINE_LABELS[engine], orderTasksAsTree(engineTasks), false));
    }

    if (waitingTasks.length > 0) {
      // Malejaco po mtime (lastActivityAt) - najnowsze oczekujace na gorze.
      // Zawsze plaska lista (tylko TaskKind.Session), bez drzewa subagentow.
      const sorted = [...waitingTasks].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
      root.appendChild(buildSection('Czekają na Ciebie', sorted, true));
    }

    refreshTickInterval();
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

  function buildSection(headerText, orderedTasks, isWaitingSection) {
    const section = document.createElement('div');
    section.className = 'section';

    const header = document.createElement('div');
    header.className = 'section-header';

    const name = document.createElement('span');
    name.textContent = headerText;
    header.appendChild(name);

    const count = document.createElement('span');
    count.className = 'section-count';
    count.textContent = String(orderedTasks.length);
    header.appendChild(count);

    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'card-list';
    for (const task of orderedTasks) {
      list.appendChild(buildCard(task, isWaitingSection));
    }
    section.appendChild(list);

    return section;
  }

  function orderTasksAsTree(tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const childrenByParent = new Map();
    const topLevel = [];

    for (const task of tasks) {
      if (task.parentId && byId.has(task.parentId)) {
        if (!childrenByParent.has(task.parentId)) {
          childrenByParent.set(task.parentId, []);
        }
        childrenByParent.get(task.parentId).push(task);
      } else {
        topLevel.push(task);
      }
    }

    const result = [];
    const appendWithChildren = (list) => {
      for (const task of sortByStartedAtDesc(list)) {
        result.push(task);
        const children = childrenByParent.get(task.id);
        if (children) {
          appendWithChildren(children);
        }
      }
    };
    appendWithChildren(topLevel);
    return result;
  }

  function sortByStartedAtDesc(tasks) {
    // Kazde zadanie tutaj jest w toku (filtr Running), wiec jedyny sensowny
    // porzadek to od najdluzej dzialajacego do najswiezszego.
    return [...tasks].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  function buildCard(task, isWaitingRow) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = task.id;
    if (isWaitingRow) {
      // Wygaszone, wracaja do pelnej widocznosci na hover/focus (patrz CSS).
      card.classList.add('card-waiting');
    }

    const content = document.createElement('div');
    content.className = 'card-content';

    const depth = task.depth ?? 0;
    if (depth > 0) {
      // Wciecie lewym paddingiem na WEWNETRZNYM wrapperze (nie na .card) -
      // .card sam manipuluje marginesem/paddingiem przy hover-bleed (patrz
      // CSS), wiec inline-style depth na tym samym elemencie kolidowalby z
      // tamta regula (inline zawsze wygrywa nad :hover w zewnetrznym CSS).
      card.classList.add('card-nested');
      content.style.paddingLeft = `${depth * NESTING_STEP_PX}px`;
    }

    content.appendChild(buildLine1(task, isWaitingRow));
    content.appendChild(buildLine2(task));

    const contextBar = buildContextBar(task);
    if (contextBar) {
      content.appendChild(contextBar);
    }

    card.appendChild(content);
    return card;
  }

  function buildLine1(task, isWaitingRow) {
    const row = document.createElement('div');
    row.className = 'card-line1';

    row.appendChild(buildStatusBadge(task));

    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = task.title;
    title.title = task.title;
    row.appendChild(title);

    const right = document.createElement('span');
    right.className = 'card-line1-right';
    right.appendChild(buildTimerElement(task, isWaitingRow));
    right.appendChild(buildInlineActions(task));
    row.appendChild(right);

    return row;
  }

  function buildStatusBadge(task) {
    const info = statusBadgeInfo(task);
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

  function buildTimerElement(task, isWaitingRow) {
    const timer = document.createElement('span');
    timer.className = 'card-timer';
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
  function buildLine2(task) {
    const line = document.createElement('div');
    line.className = 'card-line2';
    const titleParts = [];

    const primaryParts = [];
    if (task.kind === TaskKind.Subagent && task.subtitle) {
      primaryParts.push(task.subtitle);
      titleParts.push(task.subtitle);
    }
    if (task.model) {
      primaryParts.push(abbreviateModel(task.model) ?? task.model);
      titleParts.push(task.model);
    }
    if (primaryParts.length > 0) {
      const primarySpan = document.createElement('span');
      primarySpan.className = 'card-line2-primary';
      primarySpan.textContent = primaryParts.join(' · ');
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
      secondaryParts.push(`${formatTokenCount(task.tokensUsed)} tok`);
      titleParts.push(`tokeny ${formatWithThousandsSeparator(task.tokensUsed)}`);
    }

    if (secondaryParts.length > 0) {
      const secondarySpan = document.createElement('span');
      secondarySpan.className = 'card-line2-secondary';
      secondarySpan.textContent = (primaryParts.length > 0 ? ' · ' : '') + secondaryParts.join(' · ');
      line.appendChild(secondarySpan);
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
