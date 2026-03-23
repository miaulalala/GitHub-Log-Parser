/**
 * GitHub CI Log Linker
 *
 * Works on:
 *   • PR pages:   github.com/OWNER/REPO/pull/PR_NUMBER
 *   • Run pages:  github.com/OWNER/REPO/actions/runs/RUN_ID[?pr=…]
 *   • Job pages:  github.com/OWNER/REPO/actions/runs/RUN_ID/job/JOB_ID
 *
 * Finds every "Failed scenarios:" entry produced by Behat/Cucumber and turns
 * it into a clickable link that opens the job page at the matching log line
 * (#step:N:L anchor).
 */
(async () => {
  'use strict';

  const actionsMatch = location.href.match(
    /github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/
  );
  const prMatch = !actionsMatch && location.href.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (!actionsMatch && !prMatch) return;

  const owner       = (actionsMatch || prMatch)[1];
  const repo        = (actionsMatch || prMatch)[2];
  const runId       = actionsMatch?.[3] ?? null;
  const directJobId = actionsMatch?.[4] ?? null;

  // GitHub does SPA navigation — the content script is not re-injected on
  // every page transition.  Remove the panel whenever the URL changes so it
  // doesn't linger on unrelated pages.
  const removePanel = () => document.getElementById('ci-log-linker-panel')?.remove();
  history.pushState    = (orig => (...a) => { orig.apply(history, a); removePanel(); })(history.pushState);
  history.replaceState = (orig => (...a) => { orig.apply(history, a); removePanel(); })(history.replaceState);
  window.addEventListener('popstate', removePanel);

  // ── Utilities ────────────────────────────────────────────────────────────────

  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const escapeRe  = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Convert ANSI SGR colour/style codes to inline-styled HTML spans. */
  function ansiToHtml(raw) {
    // Escape HTML entities first
    let s = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Standard 16-colour palette (foreground codes 30-37, 90-97)
    const FG = [
      '#4e4e4e','#cc0000','#4e9a06','#c4a000',
      '#3465a4','#75507b','#06989a','#d3d7cf',
    ];
    const FG_BRIGHT = [
      '#888','#ef2929','#8ae234','#fce94f',
      '#729fcf','#ad7fa8','#34e2e2','#eeeeec',
    ];

    let openSpans = 0;
    s = s.replace(/\x1b\[([0-9;]*)m/g, (_, params) => {
      const codes = params === '' ? [0] : params.split(';').map(Number);
      let out = '';

      // Reset: close whatever is open
      if (codes.includes(0)) {
        out += '</span>'.repeat(openSpans);
        openSpans = 0;
        // Process any non-zero codes that follow in the same sequence
        const rest = codes.filter(c => c !== 0);
        if (!rest.length) return out;
        codes.splice(0, codes.length, ...rest);
      }

      let style = '';
      for (const c of codes) {
        if (c === 1)                          style += 'font-weight:bold;';
        else if (c === 3)                     style += 'font-style:italic;';
        else if (c === 4)                     style += 'text-decoration:underline;';
        else if (c >= 30 && c <= 37)          style += `color:${FG[c - 30]};`;
        else if (c >= 90 && c <= 97)          style += `color:${FG_BRIGHT[c - 90]};`;
        else if (c >= 40 && c <= 47)          style += `background:${FG[c - 40]};`;
      }
      if (style) { out += `<span style="${style}">`; openSpans++; }
      return out;
    });

    // Close any spans still open at end of line
    s += '</span>'.repeat(openSpans);
    return s;
  }

  // Read the stored PAT (set via the extension popup).
  // The session cookie for github.com is NOT sent to api.github.com (different
  // domain), so unauthenticated requests get 403 even for public repos' logs.
  async function getToken() {
    try {
      const { githubToken } = await browser.storage.local.get('githubToken');
      return githubToken || null;
    } catch {
      return null;
    }
  }

  // All fetches go through the background script, which can follow cross-origin
  // redirects freely (the GitHub API redirects log downloads to
  // pipelines.actions.githubusercontent.com which is a different domain).
  async function apiFetch(url, token) {
    let result;
    try {
      result = await browser.runtime.sendMessage({ type: 'fetch', url, token });
    } catch (err) {
      console.warn('[CI Log Linker] sendMessage error:', err);
      return null;
    }
    if (!result || !result.ok) {
      console.warn(`[CI Log Linker] ${url} → HTTP ${result?.status ?? 'error'}`);
      if (result?.status === 401 || result?.status === 403) {
        console.warn(
          '[CI Log Linker] API access denied. ' +
          'Click the extension icon to set a GitHub Personal Access Token.'
        );
      }
      return null;
    }
    return result.text;
  }

  // ── Step 1: find which jobs / runs failed ───────────────────────────────────

  // Returns failed job IDs for a specific run (or [directJobId] on job pages).
  async function getFailedJobsForRun(token, theRunId, theDirectJobId) {
    if (theDirectJobId) return [theDirectJobId];
    const text = await apiFetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${theRunId}/jobs?per_page=100`,
      token
    );
    if (!text) return [];
    const data = JSON.parse(text);
    return (data.jobs || [])
      .filter(j => j.conclusion === 'failure')
      .map(j => String(j.id));
  }

  // On a PR page: fetch the PR head SHA, then all failed workflow runs for it.
  async function getFailedRunIdsForPR(prNumber, token) {
    const prText = await apiFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      token
    );
    if (!prText) return [];
    const sha = JSON.parse(prText).head?.sha;
    if (!sha) return [];

    const runsText = await apiFetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
      token
    );
    if (!runsText) return [];
    return (JSON.parse(runsText).workflow_runs || [])
      .filter(r => r.conclusion === 'failure')
      .map(r => String(r.id));
  }

  // ── Step 2: fetch raw log text for a job ────────────────────────────────────

  async function fetchRawLog(jobId, token) {
    return apiFetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      token
    );
  }

  // ── Step 3: parse log into steps ────────────────────────────────────────────
  //
  // GitHub Actions raw log format (ISO timestamp prefix on every line):
  //
  //   2024-01-01T00:00:00.0000000Z ##[group]Step Name    ← depth 0 → new step
  //   2024-01-01T00:00:00.0000000Z output line
  //   2024-01-01T00:00:00.0000000Z ##[group]Sub-section  ← depth 1 → sub-group
  //   2024-01-01T00:00:00.0000000Z sub-group content
  //   2024-01-01T00:00:00.0000000Z ##[endgroup]
  //   2024-01-01T00:00:00.0000000Z ##[endgroup]
  //
  // #step:N:L URL fragments:
  //   N = 1-based step index (one per top-level ##[group])
  //   L = 1-based line number within the step
  //       (nested ##[group]/##[endgroup] lines count toward L)

  function parseLogIntoSteps(logText) {
    const steps = [];
    let currentStep = null; // step currently inside a ##[group] at depth 1
    let tailStep    = null; // most recently CLOSED top-level step — owns depth-0 orphan lines
    let depth = 0;
    let lineInStep = 0;

    for (const raw of logText.split('\n')) {
      // Strip timestamp prefix; keep two versions:
      //   text — ANSI stripped, used for pattern matching and ##[group] detection
      //   coloured — ANSI intact, used for display in the panel
      const noTs     = raw.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /, '')
                          .replace(/\r$/, '');
      const text     = stripAnsi(noTs);
      const coloured = noTs;

      if (text.startsWith('##[group]')) {
        if (depth === 0) {
          currentStep = { name: text.slice(9), lines: [] };
          lineInStep  = 0;
          tailStep    = null;
          steps.push(currentStep);
        } else if (currentStep) {
          lineInStep++;
          currentStep.lines.push({ num: lineInStep, text, coloured });
        }
        depth++;

      } else if (text.startsWith('##[endgroup]')) {
        depth = Math.max(0, depth - 1);
        if (depth > 0 && currentStep) {
          lineInStep++;
          currentStep.lines.push({ num: lineInStep, text, coloured });
        } else if (depth === 0 && currentStep) {
          tailStep    = currentStep;
          currentStep = null;
        }

      } else if (depth > 0 && currentStep) {
        lineInStep++;
        currentStep.lines.push({ num: lineInStep, text, coloured });

      } else if (depth === 0 && tailStep) {
        lineInStep++;
        tailStep.lines.push({ num: lineInStep, text, coloured });
      }
    }

    return steps;
  }

  // ── Step 4: parse the "Failed scenarios:" summary block ─────────────────────
  //
  // Behat/Cucumber appends this at the end of a test run:
  //
  //   --- Failed scenarios:
  //
  //       /home/runner/work/…/search.feature:36 (on line 43)
  //
  // scenarioLine (36) = line of the Scenario: keyword in the feature file
  // stepLine     (43) = line of the failing step in the feature file

  function parseFailedScenarios(logText) {
    const clean = stripAnsi(logText);
    const scenarios = [];

    const m = clean.match(
      /---\s*Failed scenarios:\s*\n([\s\S]*?)(?=\n{3,}|\n---|\s*$)/
    );
    if (!m) return scenarios;

    for (const line of m[1].split('\n')) {
      const sm = line.match(/(\S+\.feature):(\d+)\s+\(on line (\d+)\)/);
      if (!sm) continue;
      scenarios.push({
        filename:     sm[1].split('/').pop(),  // e.g. "search.feature"
        scenarioLine: parseInt(sm[2], 10),
        stepLine:     parseInt(sm[3], 10),
        rawText:      line.trim(),
      });
    }

    return scenarios;
  }

  // ── Step 4b: parse PHPUnit failure/error blocks ──────────────────────────────
  //
  // PHPUnit emits numbered blocks after the progress line:
  //
  //   There were 15 errors:
  //
  //   1) Namespace\ClassName::methodName
  //   SomeException: message
  //
  //   /path/to/src.php:45
  //   /path/to/test.php:123
  //
  //   ERRORS!

  function parseFailedPhpUnit(logText) {
    const clean = stripAnsi(logText);
    const lines = clean.split('\n');
    const failures = [];

    let inSection = false;
    let currentEntry = null;

    for (const line of lines) {
      // Section header: "There were N errors:" / "There was 1 failure:" etc.
      if (/^There (?:was 1|were \d+) (?:error|failure|warning)s?:/.test(line)) {
        inSection = true;
        continue;
      }

      if (!inSection) continue;

      // Section end
      if (/^(?:ERRORS?|FAILURES?|OK)\b/.test(line) || /^Tests:/.test(line)) {
        if (currentEntry) { failures.push(currentEntry); currentEntry = null; }
        inSection = false;
        continue;
      }

      // Numbered entry header: "N) Full\Class::method [with data set …]"
      const headerMatch = line.match(/^(\d+)\)\s+(.+)/);
      if (headerMatch) {
        if (currentEntry) failures.push(currentEntry);
        const testName = headerMatch[2].trim();
        // Label: strip PHP namespace, shorten data set content to just "#N"
        const label = testName
          .split('\\').pop()
          .replace(/(\s+with data set\s+#\d+).*$/, '$1');
        currentEntry = { testName, label };
        continue;
      }
    }
    if (currentEntry) failures.push(currentEntry);
    return failures;
  }

  // ── Step 5: locate the scenario in the parsed steps ─────────────────────────
  //
  // Behat pretty formatter emits:
  //   Scenario: Some title    # features/…/search.feature:36
  // We search for "filename:scenarioLine" to find it.

  // Returns { stepNum, lineNum, logLines } or null.
  // logLines: the scenario output from the match line until the next Scenario:
  // heading or "--- Failed scenarios:" (capped at 120 lines).
  function locateScenario(steps, filename, scenarioLine) {
    const pattern = new RegExp(`${escapeRe(filename)}:${scenarioLine}(?!\\d)`);

    for (let si = 0; si < steps.length; si++) {
      const lines = steps[si].lines;
      for (let li = 0; li < lines.length; li++) {
        if (!pattern.test(lines[li].text)) continue;

        // Collect lines until next scenario boundary or 120-line cap.
        // Use the `coloured` field so ANSI codes are preserved for display.
        const logLines = [];
        for (let k = li; k < lines.length && logLines.length < 120; k++) {
          const t = lines[k].text; // stripped, for boundary checks
          if (k > li && /^\s*(Scenario|Scenario Outline|Feature):/.test(t)) break;
          if (k > li && t.includes('--- Failed scenarios:')) break;
          logLines.push(lines[k].coloured);
        }

        return { stepNum: si + 1, lineNum: lines[li].num, logLines };
      }
    }

    // Not found — emit diagnostics
    const filenameRe = new RegExp(escapeRe(filename));
    const hits = [];
    for (let si = 0; si < steps.length; si++) {
      for (const line of steps[si].lines) {
        if (filenameRe.test(line.text)) {
          hits.push(`  step ${si + 1} ("${steps[si].name}") line ${line.num}: ${line.text.slice(0, 120)}`);
        }
      }
    }
    if (hits.length) {
      console.warn(`[CI Log Linker] "${filename}:${scenarioLine}" not matched — found "${filename}" at:\n` + hits.join('\n'));
    } else {
      console.warn(
        `[CI Log Linker] "${filename}" not found in log at all.\n` +
        `  Steps: ${steps.length} — ` +
        steps.map((s, i) => `${i + 1}:"${s.name}"(${s.lines.length})`).join(', ')
      );
    }
    return null;
  }

  // ── Step 5b: locate a PHPUnit failure in the parsed steps ───────────────────

  // Returns { stepNum, lineNum, logLines } or null.
  function locatePhpUnitFailure(steps, testName) {
    // Search for the numbered-entry line "N) …ClassName::method…"
    // Use the part after the last backslash as the search key so we don't have
    // to worry about backslash escaping differences across log encodings.
    const key = testName.split('\\').pop();
    const pattern = new RegExp(escapeRe(key));

    for (let si = 0; si < steps.length; si++) {
      const lines = steps[si].lines;
      for (let li = 0; li < lines.length; li++) {
        if (!/^\d+\) /.test(lines[li].text)) continue;
        if (!pattern.test(lines[li].text)) continue;

        // Collect until the next numbered entry or the summary footer
        const logLines = [];
        for (let k = li; k < lines.length && logLines.length < 60; k++) {
          const t = lines[k].text;
          if (k > li && /^\d+\) /.test(t)) break;
          if (/^(?:ERRORS?|FAILURES?|OK)\b/.test(t) || /^Tests:/.test(t)) break;
          logLines.push(lines[k].coloured);
        }
        return { stepNum: si + 1, lineNum: lines[li].num, logLines };
      }
    }

    console.warn(`[CI Log Linker] PHPUnit: could not locate "${key}" in log.`);
    return null;
  }

  // ── Step 6: floating panel ───────────────────────────────────────────────────
  //
  // GitHub's log viewer is React-rendered; injecting into its text nodes gets
  // wiped on reconciliation.  We render a self-contained panel outside that tree.

  function getTheme() {
    const mode = document.documentElement.getAttribute('data-color-mode');
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function buildPanel(entries, spawnPosition = 'bottom-right') {
    // entries: [{ label, url, logLines }]
    const dark = getTheme() === 'dark';
    const c = dark ? {
      bg:        '#161b22',
      bgHeader:  '#21262d',
      bgCode:    '#0d1117',
      border:    '#30363d',
      borderRow: '#21262d',
      text:      '#e6edf3',
      muted:     '#8b949e',
      link:      '#58a6ff',
      shadow:    'rgba(0,0,0,.4)',
    } : {
      bg:        '#ffffff',
      bgHeader:  '#f6f8fa',
      bgCode:    '#f6f8fa',
      border:    '#d0d7de',
      borderRow: '#f0f3f5',
      text:      '#1f2328',
      muted:     '#57606a',
      link:      '#0969da',
      shadow:    'rgba(140,149,159,.2)',
    };

    // ── position state
    // On first load the panel uses CSS anchor props (bottom/right etc.) so its
    // height is natural (fits content).  The first resize/drag call
    // ensureExplicitPos() which snapshots the rendered rect and switches to
    // fully explicit top/left/width/height so every edge can be moved freely.
    const MIN_W = 280, MIN_H = 36, MARGIN = 24;
    const initW       = Math.min(640, window.innerWidth * 0.9);
    const anchorRight  = spawnPosition.endsWith('right');
    const anchorBottom = spawnPosition.startsWith('bottom');

    const pos = { left: 0, top: 0, width: initW, height: 0 };
    let explicitPos = false;

    function applyPos() {
      panel.style.left   = pos.left   + 'px';
      panel.style.top    = pos.top    + 'px';
      panel.style.width  = pos.width  + 'px';
      panel.style.height = pos.height + 'px';
    }

    // Called once before the first drag or resize; converts anchor CSS to
    // explicit pixel values so all four edges become independently movable.
    function ensureExplicitPos() {
      if (explicitPos) return;
      const r = panel.getBoundingClientRect();
      pos.left = r.left; pos.top = r.top;
      pos.width = r.width; pos.height = r.height;
      panel.style.removeProperty('bottom');
      panel.style.removeProperty('right');
      panel.style.removeProperty('max-height');
      applyPos();
      explicitPos = true;
    }

    // Resets the panel to its original spawn-corner anchor (no explicit pos).
    function resetToAnchor() {
      ['top','left','bottom','right','height'].forEach(p => panel.style.removeProperty(p));
      panel.style.width     = initW + 'px';
      panel.style.maxHeight = '70vh';
      if (anchorRight)  panel.style.right  = MARGIN + 'px';
      else              panel.style.left   = MARGIN + 'px';
      if (anchorBottom) panel.style.bottom = MARGIN + 'px';
      else              panel.style.top    = MARGIN + 'px';
      explicitPos = false;
    }

    const panel = document.createElement('div');
    panel.id = 'ci-log-linker-panel';
    panel.style.cssText = [
      'position:fixed',
      'z-index:100000',
      'overflow:visible',
      'display:flex',
      'flex-direction:column',
      `width:${initW}px`,
      'max-height:70vh',
      `background:${c.bg}`,
      `border:1px solid ${c.border}`,
      'border-radius:8px',
      `box-shadow:0 8px 24px ${c.shadow}`,
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:12px',
      `color:${c.text}`,
    ].join(';');

    // Anchor to the chosen corner; no explicit height so the panel fits content
    if (anchorRight)  panel.style.right  = MARGIN + 'px';
    else              panel.style.left   = MARGIN + 'px';
    if (anchorBottom) panel.style.bottom = MARGIN + 'px';
    else              panel.style.top    = MARGIN + 'px';

    // minimised state declared here so the resize/drag handlers below can read it
    let minimised = false;

    // ── resize handles on all 4 corners + 4 edges ───────────────────────────
    // Each handle is a thin invisible strip / corner square. On mousedown it
    // captures the pointer and adjusts whichever edges it owns.
    //
    //  dirX: -1 = moves left edge  0 = no horizontal resize  +1 = moves right edge
    //  dirY: -1 = moves top  edge  0 = no vertical resize    +1 = moves bottom edge
    const HANDLE_DEFS = [
      // corners
      { dirX: -1, dirY: -1, css: 'top:-5px;left:-5px;width:14px;height:14px;cursor:nw-resize' },
      { dirX:  1, dirY: -1, css: 'top:-5px;right:-5px;width:14px;height:14px;cursor:ne-resize' },
      { dirX: -1, dirY:  1, css: 'bottom:-5px;left:-5px;width:14px;height:14px;cursor:sw-resize' },
      { dirX:  1, dirY:  1, css: 'bottom:-5px;right:-5px;width:14px;height:14px;cursor:se-resize' },
      // edges
      { dirX:  0, dirY: -1, css: 'top:-5px;left:14px;right:14px;height:10px;cursor:n-resize' },
      { dirX:  0, dirY:  1, css: 'bottom:-5px;left:14px;right:14px;height:10px;cursor:s-resize' },
      { dirX: -1, dirY:  0, css: 'left:-5px;top:14px;bottom:14px;width:10px;cursor:w-resize' },
      { dirX:  1, dirY:  0, css: 'right:-5px;top:14px;bottom:14px;width:10px;cursor:e-resize' },
    ];

    for (const { dirX, dirY, css } of HANDLE_DEFS) {
      const h = document.createElement('div');
      h.style.cssText = `position:absolute;${css};z-index:1;`;
      h.addEventListener('mousedown', (eDown) => {
        if (minimised) return;
        eDown.preventDefault();
        eDown.stopPropagation();
        ensureExplicitPos();
        const ox = eDown.clientX, oy = eDown.clientY;
        const { left: l0, top: t0, width: w0, height: h0 } = { ...pos };

        function onMove(e) {
          const dx = e.clientX - ox, dy = e.clientY - oy;
          if (dirX === -1) { pos.width = Math.max(MIN_W, w0 - dx); pos.left = l0 + w0 - pos.width; }
          if (dirX ===  1) { pos.width = Math.max(MIN_W, w0 + dx); }
          if (dirY === -1) { pos.height = Math.max(MIN_H, h0 - dy); pos.top = t0 + h0 - pos.height; }
          if (dirY ===  1) { pos.height = Math.max(MIN_H, h0 + dy); }
          applyPos();
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      panel.appendChild(h);
    }

    // ── header
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'padding:8px 12px',
      `background:${c.bgHeader}`,
      `border-bottom:1px solid ${c.border}`,
      'border-radius:8px 8px 0 0',
      'font-weight:600',
      'font-size:12px',
      'flex-shrink:0',
      'user-select:none',
      'cursor:move',
    ].join(';');

    // Drag the panel by its header (only when expanded)
    header.addEventListener('mousedown', (eDown) => {
      if (minimised) return;
      if (eDown.target.tagName === 'BUTTON') return;
      eDown.preventDefault();
      ensureExplicitPos();
      const ox = eDown.clientX - pos.left, oy = eDown.clientY - pos.top;
      function onMove(e) { pos.left = e.clientX - ox; pos.top = e.clientY - oy; applyPos(); }
      function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const title = document.createElement('span');
    title.textContent = `CI Log Linker — ${entries.length} failed scenario${entries.length !== 1 ? 's' : ''}`;
    header.appendChild(title);

    // Button group (minimise + close)
    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;align-items:center;gap:4px;';

    const btnStyle = [
      'background:none',
      'border:none',
      'cursor:pointer',
      'font-size:14px',
      `color:${c.muted}`,
      'padding:0 4px',
      'line-height:1',
    ].join(';');

    const minBtn = document.createElement('button');
    minBtn.textContent = '▼';
    minBtn.title = 'Minimise';
    minBtn.style.cssText = btnStyle;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = btnStyle;
    closeBtn.addEventListener('click', () => panel.remove());

    btnGroup.appendChild(minBtn);
    btnGroup.appendChild(closeBtn);
    header.appendChild(btnGroup);
    panel.appendChild(header);

    // ── scrollable body
    // max-height keeps it within the viewport; once the user resizes the panel
    // (switching to explicit height) this is cleared by ensureExplicitPos.
    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;max-height:calc(70vh - 36px);';

    // Snapshot of state before minimising, so restore puts it back exactly.
    let savedState = null;  // { explicitPos, pos: {...} }

    minBtn.addEventListener('click', () => {
      minimised = !minimised;
      if (minimised) {
        // Save where the panel is right now
        savedState = explicitPos
          ? { wasExplicit: true, pos: { ...pos } }
          : { wasExplicit: false };

        // Snap to the original spawn corner, show only the header
        resetToAnchor();
        panel.style.height    = MIN_H + 'px';
        panel.style.maxHeight = 'none';
        body.style.display    = 'none';
        header.style.borderRadius = '8px';
        header.style.borderBottom = 'none';
        header.style.cursor = 'default';
        minBtn.textContent = '▲';
        minBtn.title = 'Restore';
      } else {
        // Put the panel back where it was before minimising
        if (savedState?.wasExplicit) {
          Object.assign(pos, savedState.pos);
          panel.style.removeProperty('bottom');
          panel.style.removeProperty('right');
          panel.style.maxHeight = 'none';
          explicitPos = true;
          applyPos();
        } else {
          resetToAnchor();
        }
        body.style.display = '';
        header.style.borderRadius = '8px 8px 0 0';
        header.style.borderBottom = `1px solid ${c.border}`;
        header.style.cursor = 'move';
        minBtn.textContent = '▼';
        minBtn.title = 'Minimise';
      }
    });

    // ── one row per scenario
    for (const { label, url, logLines } of entries) {
      const row = document.createElement('div');
      row.style.cssText = [
        'padding:8px 12px',
        `border-bottom:1px solid ${c.borderRow}`,
      ].join(';');

      // The scenario path/line as a link to the job page (no anchor — anchors
      // get destroyed when GitHub re-renders the log viewer)
      const link = document.createElement('a');
      link.href  = url;
      link.textContent = label;
      link.title = 'Open job log page for this run step';
      link.style.cssText = [
        `color:${c.link}`,
        'text-decoration:none',
        'word-break:break-all',
        'display:block',
        'margin-bottom:4px',
      ].join(';');
      link.addEventListener('mouseover', () => link.style.textDecoration = 'underline');
      link.addEventListener('mouseout',  () => link.style.textDecoration = 'none');
      row.appendChild(link);

      // Expandable log context
      if (logLines && logLines.length) {
        const details = document.createElement('details');
        details.style.cssText = 'margin-top:2px';

        const summary = document.createElement('summary');
        summary.textContent = `Show log context (${logLines.length} lines)`;
        summary.style.cssText = [
          'cursor:pointer',
          `color:${c.muted}`,
          'font-size:11px',
          'user-select:none',
          'list-style:none',  // hide default triangle on some browsers
        ].join(';');
        // Custom triangle via ::before isn't easy inline; use a text prefix
        summary.textContent = `▶ Show log context (${logLines.length} lines)`;
        details.addEventListener('toggle', () => {
          summary.textContent = details.open
            ? `▼ Hide log context`
            : `▶ Show log context (${logLines.length} lines)`;
        });
        details.appendChild(summary);

        const pre = document.createElement('pre');
        pre.style.cssText = [
          'margin:6px 0 0',
          'padding:8px',
          `background:${c.bgCode}`,
          `border:1px solid ${c.border}`,
          'border-radius:6px',
          'overflow-x:auto',
          'font-size:11px',
          'line-height:1.45',
          'white-space:pre',
          `color:${c.text}`,
          'font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace',
        ].join(';');
        pre.innerHTML = logLines.map(ansiToHtml).join('\n');
        details.appendChild(pre);
        row.appendChild(details);
      }

      body.appendChild(row);
    }

    panel.appendChild(body);
    return panel;
  }

  // ── Main ─────────────────────────────────────────────────────────────────────

  const [token, { spawnPosition = 'bottom-right' }] = await Promise.all([
    getToken(),
    browser.storage.local.get('spawnPosition'),
  ]);

  // Resolve which (runId, jobId) pairs to process.
  // On a PR page we look up the head SHA first, then find all failed runs.
  let runIds;
  if (runId) {
    runIds = [runId];
  } else {
    const prNumber = prMatch[3];
    runIds = await getFailedRunIdsForPR(prNumber, token);
    if (runIds.length === 0) {
      console.log('[CI Log Linker] No failed workflow runs found for this PR.');
      return;
    }
  }

  const entries = [];

  for (const rId of runIds) {
    const failedJobIds = await getFailedJobsForRun(token, rId, runId ? directJobId : null);
    if (failedJobIds.length === 0) {
      console.log(`[CI Log Linker] No failed jobs in run ${rId}.`);
      continue;
    }

    console.log(`[CI Log Linker] Run ${rId}: processing ${failedJobIds.length} failed job(s):`, failedJobIds);

    for (const jobId of failedJobIds) {
      const logText = await fetchRawLog(jobId, token);
      if (!logText) continue;

      const steps      = parseLogIntoSteps(logText);
      const scenarios  = parseFailedScenarios(logText);
      const phpFailures = parseFailedPhpUnit(logText);

      if (scenarios.length === 0 && phpFailures.length === 0) {
        console.log(`[CI Log Linker] Job ${jobId}: no failed scenarios or PHPUnit tests found.`);
        continue;
      }

      const jobPageBase =
        `https://github.com/${owner}/${repo}/actions/runs/${rId}/job/${jobId}`;

      for (const s of scenarios) {
        const loc = locateScenario(steps, s.filename, s.scenarioLine);
        if (loc) {
          console.log(`[CI Log Linker] ${s.rawText} — ${loc.logLines.length} context lines`);
          entries.push({ label: s.rawText, url: jobPageBase, logLines: loc.logLines });
        } else {
          console.warn(`[CI Log Linker] Job ${jobId}: could not locate "${s.filename}:${s.scenarioLine}" in log.`);
          entries.push({ label: s.rawText, url: jobPageBase, logLines: [] });
        }
      }

      for (const f of phpFailures) {
        const loc = locatePhpUnitFailure(steps, f.testName);
        entries.push({ label: f.label, url: jobPageBase, logLines: loc?.logLines ?? [] });
      }
    }
  }

  if (entries.length === 0) return;

  document.body.appendChild(buildPanel(entries, spawnPosition));
})();
