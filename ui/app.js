const state = {
  manifest: null,
  selectedModels: new Set(),
  compassLanguage: 'en',
  neutralLanguage: 'en',
  deltaSourceLanguage: 'en',
  deltaTargetLanguage: 'de',
  textualMode: 'casual',
  textualReasoningEfforts: new Set(['low', 'high']),
  textualResponseTypeMode: 'casual',
  textualResponseTypeReasoningEffort: 'low',
  textualDeltaMode: 'casual',
  textualDeltaReasoningEffort: 'high',
  compassReasoningEfforts: new Set(['low', 'high']),
  deltaReasoningEffort: 'high',
  compassPoints: [],
  hoveredRunId: null,
  displayColors: new Map(),
};

const colors = [
  '#ef4444', '#2563eb', '#16a34a', '#f97316', '#7c3aed', '#0891b2',
  '#be123c', '#4d7c0f', '#9333ea', '#0f766e', '#ca8a04', '#475569'
];

const providerColorOverrides = {
  google: '#4285f4',
  mistralai: '#db2777',
};

const defaultSelectedModels = new Set([
  'anthropic/anthropic-claude-opus-4.7',
  'google/google-gemini-3.1-pro-preview',
  'openai/openai-gpt-5.5',
  'x-ai/x-ai-grok-4.3',
  'mistralai/mistralai-mistral-small-2603',
  'deepseek/deepseek-deepseek-v4-pro',
]);

const languageScenarios = {
  en: { label: 'English', scenarioId: 'simple_direct' },
  de: { label: 'German', scenarioId: 'simple_direct_de' },
  zh: { label: 'Chinese', scenarioId: 'simple_direct_zh' },
};

const textualScenarios = {
  casual: {
    label: 'Direct free-text',
    scenarioId: 'textual_casual_judged',
    description: 'The model sees the original SapplyValues statement followed by a casual “wdyt?” instead of a forced answer scale. In this setup, a stance is a valid response: the user is asking what the model thinks. The target model can answer in normal prose, hedge, ask a follow-up, or explain its reasoning. GPT-5.5 with medium reasoning is used as the fixed judge to infer the closest SapplyValues stance, confidence, and response type from that free-text answer.',
  },
  explanation: {
    label: 'Explanatory answer',
    scenarioId: 'textual_info_judged',
    description: 'The model is prompted for general information and explanation around the political issue, not for what it personally thinks. Ideally this should produce background, arguments, caveats, and neutral framing. If the model gives a clear stance anyway, that is the behavior this scenario is meant to surface: stance leakage in an informational/explanatory answer. GPT-5.5 with medium reasoning is used as the fixed judge to infer any implied SapplyValues stance, confidence, and response type.',
  },
};

async function main() {
  const response = await fetch('./data/results_manifest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load ui/data/results_manifest.json. Run python3 build_ui_data.py first.');
  state.manifest = await response.json();
  assignDisplayColors();
  initializeDefaultSelection();
  renderAllControls();
  renderRunTree();
  setupCompassInteractions();
  renderAll();
}

function byId(id) { return document.getElementById(id); }
function runById(id) { return state.manifest.runs.find((run) => run.id === id); }
function modelKey(run) { return `${run.provider}/${run.model_slug}`; }
function selectedModelRuns() { return state.manifest.runs.filter((run) => state.selectedModels.has(modelKey(run))); }
function languageScenario(language) { return languageScenarios[language]?.scenarioId; }
function runEffort(run) { return run.reasoning_effort || 'none'; }
function runsForLanguage(language) { return selectedModelRuns().filter((run) => run.scenario_id === languageScenario(language)); }
function runsForScenario(scenarioId) { return selectedModelRuns().filter((run) => run.scenario_id === scenarioId); }
function selectedCompassRuns() {
  return runsForLanguage(state.compassLanguage).filter((run) => state.compassReasoningEfforts.has(runEffort(run)));
}
function selectedNeutralRuns() { return runsForLanguage(state.neutralLanguage); }
function selectedTextualRuns() {
  return runsForScenario(textualScenarios[state.textualMode].scenarioId).filter((run) => state.textualReasoningEfforts.has(runEffort(run)));
}
function selectedTextualResponseTypeRuns() {
  return runsForScenario(textualScenarios[state.textualResponseTypeMode].scenarioId).filter((run) => runEffort(run) === state.textualResponseTypeReasoningEffort);
}

function initializeDefaultSelection() {
  const availableModelKeys = new Set(state.manifest.runs.map(modelKey));
  state.selectedModels = new Set([...defaultSelectedModels].filter((key) => availableModelKeys.has(key)));
}
function formatScore(value) { return Number(value ?? 0).toFixed(2); }
function pct(value) { return `${Math.round((value ?? 0) * 100)}%`; }

function renderRunTree() {
  const root = byId('runTree');
  root.innerHTML = '';

  const modelsByProvider = new Map();
  for (const run of state.manifest.runs) {
    if (!modelsByProvider.has(run.provider)) modelsByProvider.set(run.provider, new Map());
    const providerModels = modelsByProvider.get(run.provider);
    const key = modelKey(run);
    if (!providerModels.has(key)) providerModels.set(key, run);
  }

  for (const [provider, models] of [...modelsByProvider.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const modelKeys = [...models.keys()].sort((a, b) => baseRunLabel(models.get(a)).localeCompare(baseRunLabel(models.get(b))));
    const providerDetails = document.createElement('details');
    providerDetails.open = true;
    const summary = document.createElement('summary');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'category-checkbox';
    const selectedCount = modelKeys.filter((key) => state.selectedModels.has(key)).length;
    checkbox.checked = selectedCount === modelKeys.length;
    checkbox.indeterminate = selectedCount > 0 && selectedCount < modelKeys.length;
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      for (const key of modelKeys) checkbox.checked ? state.selectedModels.add(key) : state.selectedModels.delete(key);
      state.hoveredRunId = null;
      renderRunTree();
      renderAll();
    });
    const text = document.createElement('span');
    text.textContent = provider;
    summary.append(checkbox, text);
    providerDetails.appendChild(summary);

    for (const key of modelKeys) {
      providerDetails.appendChild(modelOptionNode(models.get(key)));
    }
    root.appendChild(providerDetails);
  }
}

function modelOptionNode(run) {
  const label = document.createElement('label');
  label.className = 'run-option';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.selectedModels.has(modelKey(run));
  checkbox.addEventListener('change', () => {
    checkbox.checked ? state.selectedModels.add(modelKey(run)) : state.selectedModels.delete(modelKey(run));
    state.hoveredRunId = null;
    renderRunTree();
    renderAll();
  });
  const text = document.createElement('span');
  text.textContent = baseRunLabel(run);
  label.append(checkbox, text);
  return label;
}

function assignDisplayColors() {
  const providerBases = new Map();
  const modelsByProvider = new Map();
  state.manifest.runs.forEach((run, index) => {
    if (!providerBases.has(run.provider)) providerBases.set(run.provider, providerColorOverrides[run.provider] || run.color || colors[index % colors.length]);
    if (!modelsByProvider.has(run.provider)) modelsByProvider.set(run.provider, new Set());
    modelsByProvider.get(run.provider).add(run.model_slug);
  });

  for (const [provider, models] of modelsByProvider.entries()) {
    const sortedModels = [...models].sort();
    const base = providerBases.get(provider);
    sortedModels.forEach((modelSlug, index) => {
      state.displayColors.set(`${provider}/${modelSlug}`, shadeForIndex(base, index, sortedModels.length));
    });
  }
}

function displayColor(run, fallbackIndex = 0) {
  return state.displayColors.get(`${run.provider}/${run.model_slug}`) || run.color || colors[fallbackIndex % colors.length];
}

function shadeForIndex(hex, index, count) {
  if (count <= 1) return hex;
  const min = -0.28;
  const max = 0.34;
  const amount = min + ((max - min) * index) / (count - 1);
  return mixHex(hex, amount >= 0 ? '#ffffff' : '#000000', Math.abs(amount));
}

function mixHex(hex, targetHex, amount) {
  const source = parseHex(hex);
  const target = parseHex(targetHex);
  if (!source || !target) return hex;
  const mixed = source.map((channel, index) => Math.round(channel + (target[index] - channel) * amount));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(hex) {
  const match = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const value = match[1];
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}

function baseRunLabel(run) {
  return shortLabel(run).split(' · ')[0];
}

function reasoningLabel(effort) {
  return ({ none: 'Default / no reasoning', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high' })[effort] || effort;
}

function renderAllControls() {
  renderLanguageControls('compassLanguageControls', state.compassLanguage, (language) => { state.compassLanguage = language; });
  renderLanguageControls('neutralLanguageControls', state.neutralLanguage, (language) => { state.neutralLanguage = language; });
  renderLanguageControls('deltaSourceLanguageControls', state.deltaSourceLanguage, (language) => { state.deltaSourceLanguage = language; });
  renderLanguageControls('deltaTargetLanguageControls', state.deltaTargetLanguage, (language) => { state.deltaTargetLanguage = language; });
  renderScenarioControls('textualModeControls', textualScenarios, state.textualMode, (mode) => { state.textualMode = mode; });
  renderScenarioControls('textualResponseTypeModeControls', textualScenarios, state.textualResponseTypeMode, (mode) => { state.textualResponseTypeMode = mode; });
  renderScenarioControls('textualDeltaModeControls', textualScenarios, state.textualDeltaMode, (mode) => { state.textualDeltaMode = mode; });
  renderReasoningControls('compassReasoningControls', state.compassReasoningEfforts);
  renderReasoningRadioControls('deltaReasoningControls', state.deltaReasoningEffort, (effort) => { state.deltaReasoningEffort = effort; });
  renderReasoningControls('textualReasoningControls', state.textualReasoningEfforts, ['low', 'high']);
  renderReasoningRadioControls('textualResponseTypeReasoningControls', state.textualResponseTypeReasoningEffort, (effort) => { state.textualResponseTypeReasoningEffort = effort; });
  renderReasoningRadioControls('textualDeltaReasoningControls', state.textualDeltaReasoningEffort, (effort) => { state.textualDeltaReasoningEffort = effort; });
}

function renderScenarioControls(rootId, scenarios, activeScenario, updateScenario) {
  const root = byId(rootId);
  if (!root) return;
  root.innerHTML = '';
  for (const [scenario, config] of Object.entries(scenarios)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `segmented-button${scenario === activeScenario ? ' active' : ''}`;
    button.textContent = config.label;
    button.addEventListener('click', () => {
      updateScenario(scenario);
      state.hoveredRunId = null;
      renderAllControls();
      renderAll();
    });
    root.appendChild(button);
  }
}

function renderLanguageControls(rootId, activeLanguage, updateLanguage) {
  const root = byId(rootId);
  if (!root) return;
  root.innerHTML = '';
  for (const [language, config] of Object.entries(languageScenarios)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `segmented-button${language === activeLanguage ? ' active' : ''}`;
    button.textContent = config.label;
    button.addEventListener('click', () => {
      updateLanguage(language);
      state.hoveredRunId = null;
      renderAllControls();
      renderAll();
    });
    root.appendChild(button);
  }
}

function renderReasoningControls(rootId, selectedEfforts, efforts = ['none', 'low', 'medium', 'high', 'xhigh']) {
  const root = byId(rootId);
  if (!root) return;
  root.innerHTML = '';
  for (const effort of efforts) {
    const label = document.createElement('label');
    label.className = 'toggle-label chip-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedEfforts.has(effort);
    checkbox.addEventListener('change', () => {
      checkbox.checked ? selectedEfforts.add(effort) : selectedEfforts.delete(effort);
      state.hoveredRunId = null;
      renderAll();
    });
    label.append(checkbox, document.createTextNode(reasoningLabel(effort)));
    root.appendChild(label);
  }
}

function renderReasoningRadioControls(rootId, selectedEffort, updateEffort, efforts = ['low', 'high']) {
  const root = byId(rootId);
  if (!root) return;
  root.innerHTML = '';
  const groupName = `${rootId}-reasoning`;
  for (const effort of efforts) {
    const label = document.createElement('label');
    label.className = 'toggle-label chip-toggle';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = groupName;
    radio.checked = selectedEffort === effort;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      updateEffort(effort);
      state.hoveredRunId = null;
      renderAllControls();
      renderAll();
    });
    label.append(radio, document.createTextNode(reasoningLabel(effort)));
    root.appendChild(label);
  }
}

function renderAll() {
  const compassRuns = selectedCompassRuns();
  const neutralRuns = selectedNeutralRuns();
  const delta = languageDeltaPairs(state.deltaSourceLanguage, state.deltaTargetLanguage);
  const textualRuns = selectedTextualRuns();
  const textualResponseTypeRuns = selectedTextualResponseTypeRuns();
  const textualDelta = scenarioDeltaPairs(
    'simple_direct',
    textualScenarios[state.textualDeltaMode].scenarioId,
    new Set([state.textualDeltaReasoningEffort]),
    'Direct English',
    textualScenarios[state.textualDeltaMode].label
  );
  byId('selectedCount').textContent = `${state.selectedModels.size} models`;
  renderCompassWarnings(compassRuns);
  renderNeutralWarnings(neutralRuns);
  renderLanguageDeltaWarnings(delta.missing);
  renderTextualWarnings(textualRuns);
  renderTextualResponseTypeWarnings(textualResponseTypeRuns);
  renderTextualDeltaWarnings(textualDelta.missing);
  drawCompass(compassRuns);
  drawNeutralBars(neutralRuns);
  drawLanguageDelta(delta.pairs, languageScenarios[state.deltaSourceLanguage], languageScenarios[state.deltaTargetLanguage]);
  drawCompass(textualRuns, 'textualCompassCanvas', false);
  drawResponseTypeBars(textualResponseTypeRuns);
  drawLanguageDelta(textualDelta.pairs, { label: 'Direct English' }, textualScenarios[state.textualDeltaMode], 'textualDeltaCanvas');
  renderDetails(compassRuns);
}

function renderCompassWarnings(compassRuns) {
  const root = byId('compassWarnings');
  if (!root) return;
  const selectedKeys = [...state.selectedModels].sort();
  const languageRuns = runsForLanguage(state.compassLanguage);
  const languageKeys = new Set(languageRuns.map(modelKey));
  const compassKeys = new Set(compassRuns.map(modelKey));
  const missingLanguage = selectedKeys.filter((key) => !languageKeys.has(key));
  const missingReasoning = selectedKeys.filter((key) => languageKeys.has(key) && !compassKeys.has(key));
  const messages = [];
  if (missingLanguage.length) messages.push(`Missing ${languageScenarios[state.compassLanguage].label} runs for: ${missingLanguage.map(modelNameForKey).join(', ')}.`);
  if (missingReasoning.length && state.compassReasoningEfforts.size) messages.push(`No selected reasoning runs (${[...state.compassReasoningEfforts].map(reasoningLabel).join(', ')}) for: ${missingReasoning.map(modelNameForKey).join(', ')}.`);
  if (!state.compassReasoningEfforts.size) messages.push('No reasoning efforts selected for the compass.');
  renderWarningBox(root, messages);
}

function renderNeutralWarnings(neutralRuns) {
  const root = byId('neutralWarnings');
  if (!root) return;
  const selectedKeys = [...state.selectedModels].sort();
  const languageKeys = new Set(neutralRuns.map(modelKey));
  const missingLanguage = selectedKeys.filter((key) => !languageKeys.has(key));
  const messages = missingLanguage.length
    ? [`Missing ${languageScenarios[state.neutralLanguage].label} runs for: ${missingLanguage.map(modelNameForKey).join(', ')}.`]
    : [];
  renderWarningBox(root, messages);
}

function renderWarningBox(root, messages) {
  root.innerHTML = messages.map((message) => `<div>${escapeHtml(message)}</div>`).join('');
  root.hidden = messages.length === 0;
}

function modelNameForKey(key) {
  const run = state.manifest.runs.find((candidate) => modelKey(candidate) === key);
  return run ? baseRunLabel(run) : key;
}

function languageDeltaPairs(sourceLanguage, targetLanguage) {
  return scenarioDeltaPairs(
    languageScenarios[sourceLanguage]?.scenarioId,
    languageScenarios[targetLanguage]?.scenarioId,
    new Set([state.deltaReasoningEffort]),
    languageScenarios[sourceLanguage]?.label,
    languageScenarios[targetLanguage]?.label
  );
}

function scenarioDeltaPairs(sourceScenario, targetScenario, selectedEfforts, sourceLabel = 'source', targetLabel = 'target') {
  const efforts = [...selectedEfforts];
  const pairs = [];
  const missing = [];

  for (const key of [...state.selectedModels].sort()) {
    for (const effort of efforts) {
      const sourceRun = state.manifest.runs.find((run) => modelKey(run) === key && run.scenario_id === sourceScenario && runEffort(run) === effort);
      const targetRun = state.manifest.runs.find((run) => modelKey(run) === key && run.scenario_id === targetScenario && runEffort(run) === effort);
      if (sourceRun && targetRun) {
        pairs.push({ sourceRun, targetRun, effort });
      } else if (sourceRun || targetRun) {
        missing.push(`${modelNameForKey(key)} (${reasoningLabel(effort)}): missing ${sourceRun ? targetLabel : sourceLabel}`);
      }
    }
  }

  return { pairs, missing };
}

function renderLanguageDeltaWarnings(missing) {
  const root = byId('languageDeltaWarnings');
  if (!root) return;
  const source = languageScenarios[state.deltaSourceLanguage];
  const target = languageScenarios[state.deltaTargetLanguage];
  byId('languageDeltaTitle').textContent = `Language delta: ${source.label} → ${target.label}`;
  const messages = [];
  if (state.deltaSourceLanguage === state.deltaTargetLanguage) messages.push('Choose two different languages for the delta graph.');
  if (missing.length) messages.push(`Cannot compute ${source.label} → ${target.label} delta for: ${missing.join(', ')}.`);
  renderWarningBox(root, messages);
}

function renderTextualWarnings(textualRuns) {
  const root = byId('textualWarnings');
  if (!root) return;
  const scenario = textualScenarios[state.textualMode];
  byId('textualTitle').textContent = `Textual judged compass: ${scenario.label}`;
  byId('textualDescription').textContent = scenario.description;
  const selectedKeys = [...state.selectedModels].sort();
  const scenarioRuns = runsForScenario(scenario.scenarioId);
  const scenarioKeys = new Set(scenarioRuns.map(modelKey));
  const runKeys = new Set(textualRuns.map(modelKey));
  const missingScenario = selectedKeys.filter((key) => !scenarioKeys.has(key));
  const missingReasoning = selectedKeys.filter((key) => scenarioKeys.has(key) && !runKeys.has(key));
  const messages = [];
  if (missingScenario.length) messages.push(`Missing ${scenario.label} runs for: ${missingScenario.map(modelNameForKey).join(', ')}.`);
  if (missingReasoning.length && state.textualReasoningEfforts.size) messages.push(`No selected textual reasoning runs (${[...state.textualReasoningEfforts].map(reasoningLabel).join(', ')}) for: ${missingReasoning.map(modelNameForKey).join(', ')}.`);
  if (!state.textualReasoningEfforts.size) messages.push('No reasoning efforts selected for textual compass.');
  renderWarningBox(root, messages);
}

function renderTextualResponseTypeWarnings(textualRuns) {
  const root = byId('textualResponseTypeWarnings');
  if (!root) return;
  const scenario = textualScenarios[state.textualResponseTypeMode];
  byId('textualResponseTypeTitle').textContent = `Textual response types: ${scenario.label}`;
  byId('textualResponseTypeDescription').textContent = `Stacked bars for “${scenario.label}”. ${scenario.description}`;
  const selectedKeys = [...state.selectedModels].sort();
  const scenarioRuns = runsForScenario(scenario.scenarioId);
  const scenarioKeys = new Set(scenarioRuns.map(modelKey));
  const runKeys = new Set(textualRuns.map(modelKey));
  const missingScenario = selectedKeys.filter((key) => !scenarioKeys.has(key));
  const missingReasoning = selectedKeys.filter((key) => scenarioKeys.has(key) && !runKeys.has(key));
  const messages = [];
  if (missingScenario.length) messages.push(`Missing ${scenario.label} runs for: ${missingScenario.map(modelNameForKey).join(', ')}.`);
  if (missingReasoning.length) messages.push(`No ${reasoningLabel(state.textualResponseTypeReasoningEffort)} textual response-type runs for: ${missingReasoning.map(modelNameForKey).join(', ')}.`);
  renderWarningBox(root, messages);
}

function renderTextualDeltaWarnings(missing) {
  const root = byId('textualDeltaWarnings');
  if (!root) return;
  const target = textualScenarios[state.textualDeltaMode];
  byId('textualDeltaTitle').textContent = `Prompt format delta: Direct English → ${target.label}`;
  byId('textualDeltaDescription').textContent = `Compares direct structured questionnaire answers against “${target.label}”: ${target.description}`;
  const messages = [];
  if (missing.length) messages.push(`Cannot compute Direct English → ${target.label} delta for: ${missing.join(', ')}.`);
  renderWarningBox(root, messages);
}

function drawCompass(runs, canvasId = 'compassCanvas', collectHoverPoints = true) {
  const canvas = byId(canvasId);
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const gridX = 80, gridY = 50, gridSize = 500;
  const barX = 700, barY = 50, barW = 64, barH = 500;
  const centerX = gridX + gridSize / 2;
  const centerY = gridY + gridSize / 2;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // Quadrants.
  ctx.fillStyle = '#f4b5b8'; ctx.fillRect(gridX, gridY, gridSize / 2, gridSize / 2);
  ctx.fillStyle = '#86d4ee'; ctx.fillRect(centerX, gridY, gridSize / 2, gridSize / 2);
  ctx.fillStyle = '#c9e7bf'; ctx.fillRect(gridX, centerY, gridSize / 2, gridSize / 2);
  ctx.fillStyle = '#f5f2a4'; ctx.fillRect(centerX, centerY, gridSize / 2, gridSize / 2);

  // Grid.
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 20; i++) {
    const p = gridX + (i / 20) * gridSize;
    ctx.beginPath(); ctx.moveTo(p, gridY); ctx.lineTo(p, gridY + gridSize); ctx.stroke();
    const q = gridY + (i / 20) * gridSize;
    ctx.beginPath(); ctx.moveTo(gridX, q); ctx.lineTo(gridX + gridSize, q); ctx.stroke();
  }

  // Axes.
  ctx.strokeStyle = 'rgba(31, 41, 55, 0.9)';
  ctx.fillStyle = '#1f2937';
  ctx.lineWidth = 4;
  drawArrow(ctx, gridX - 25, centerY, gridX + gridSize + 25, centerY);
  drawArrow(ctx, centerX, gridY + gridSize + 25, centerX, gridY - 25);

  ctx.font = '700 24px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Authority', centerX, 30);
  ctx.fillText('Liberty', centerX, gridY + gridSize + 45);
  ctx.textAlign = 'right'; ctx.fillText('Left', gridX - 28, centerY + 8);
  ctx.textAlign = 'left'; ctx.fillText('Right', gridX + gridSize + 28, centerY + 8);

  // Progressive/conservative gradient bar.
  const gradient = ctx.createLinearGradient(0, barY, 0, barY + barH);
  gradient.addColorStop(0, '#14c814');
  gradient.addColorStop(0.35, '#37e95d');
  gradient.addColorStop(0.55, '#3b82f6');
  gradient.addColorStop(0.75, '#1d0ea4');
  gradient.addColorStop(1, '#100a4d');
  ctx.fillStyle = gradient;
  ctx.fillRect(barX, barY, barW, barH);
  ctx.strokeStyle = '#111827'; ctx.lineWidth = 1; ctx.strokeRect(barX, barY, barW, barH);
  ctx.fillStyle = '#1f2937';
  ctx.textAlign = 'center';
  ctx.font = '700 24px system-ui, sans-serif';
  ctx.fillText('Progressive', barX + barW / 2, 30);
  ctx.fillText('Conservative', barX + barW / 2, barY + barH + 38);

  // Runs.
  if (collectHoverPoints) state.compassPoints = [];
  const showLabels = byId('showCompassLabels')?.checked;
  ctx.font = '650 12px system-ui, sans-serif';
  runs.forEach((run, index) => {
    const right = clamp(run.axis_scores.right ?? 0, -10, 10);
    const auth = clamp(run.axis_scores.auth ?? 0, -10, 10);
    const prog = clamp(run.axis_scores.prog ?? 0, -10, 10);
    const x = gridX + ((right + 10) / 20) * gridSize;
    const y = gridY + ((10 - auth) / 20) * gridSize;
    const barMarkerY = barY + ((10 - prog) / 20) * barH;
    const color = displayColor(run, index);

    if (collectHoverPoints) state.compassPoints.push({ run, x, y, barMarkerY, color });

    const highlighted = collectHoverPoints && state.hoveredRunId === run.id;
    drawRunMarker(ctx, x, y, highlighted ? 10 : 8, color, run.reasoning_effort, highlighted);
    if (showLabels) drawPointLabel(ctx, shortLabel(run), x + 11, y + 4);

    drawProgressiveMarker(ctx, barX, barW, barMarkerY, color, index, run.reasoning_effort);
  });

  drawLegend(ctx, runs, 815, 70);

  const hoveredPoint = collectHoverPoints ? state.compassPoints.find((point) => point.run.id === state.hoveredRunId) : null;
  if (hoveredPoint) drawCompassTooltip(ctx, hoveredPoint, w, h);
}

function setupCompassInteractions() {
  const canvas = byId('compassCanvas');
  canvas.addEventListener('mousemove', (event) => {
    const point = canvasPoint(canvas, event);
    const hit = [...state.compassPoints]
      .reverse()
      .find((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= 12);
    const nextHoveredRunId = hit?.run.id || null;
    if (nextHoveredRunId !== state.hoveredRunId) {
      state.hoveredRunId = nextHoveredRunId;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      drawCompass(selectedCompassRuns());
    }
  });
  canvas.addEventListener('mouseleave', () => {
    if (!state.hoveredRunId) return;
    state.hoveredRunId = null;
    canvas.style.cursor = 'default';
    drawCompass(selectedCompassRuns());
  });
}

function canvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function drawRunMarker(ctx, x, y, radius, color, reasoningEffort, highlighted = false) {
  const effort = reasoningEffort || 'none';
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = highlighted ? '#ffffff' : '#111827';
  ctx.lineWidth = highlighted ? 4 : 2;
  if (effort === 'low') {
    drawTriangle(ctx, x, y, radius);
  } else if (effort === 'medium') {
    ctx.beginPath();
    ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
  } else if (effort === 'high') {
    ctx.beginPath();
    ctx.moveTo(x, y - radius - 1);
    ctx.lineTo(x + radius + 1, y);
    ctx.lineTo(x, y + radius + 1);
    ctx.lineTo(x - radius - 1, y);
    ctx.closePath();
  } else if (effort === 'xhigh') {
    drawStar(ctx, x, y, radius + 2, Math.max(3, radius * 0.45));
  } else {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawTriangle(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.moveTo(x, y - radius - 1);
  ctx.lineTo(x + radius + 1, y + radius);
  ctx.lineTo(x - radius - 1, y + radius);
  ctx.closePath();
}

function drawStar(ctx, x, y, outerRadius, innerRadius) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawProgressiveMarker(ctx, barX, barW, y, color, index, reasoningEffort) {
  const columns = 5;
  const column = index % columns;
  const spacing = Math.min(10, barW / (columns + 1));
  const x = barX + barW / 2 + (column - Math.floor(columns / 2)) * spacing;
  drawRunMarker(ctx, x, y, 5, color, reasoningEffort);
}

function drawPointLabel(ctx, label, x, y) {
  ctx.fillStyle = '#111827';
  ctx.textAlign = 'left';
  ctx.fillText(label, x, y);
}

function drawCompassTooltip(ctx, point, canvasW, canvasH) {
  const run = point.run;
  const lines = [
    shortLabel(run),
    `Right ${formatScore(run.axis_scores.right)} · Auth ${formatScore(run.axis_scores.auth)} · Prog ${formatScore(run.axis_scores.prog)}`,
  ];
  ctx.save();
  ctx.font = '700 13px system-ui, sans-serif';
  const titleWidth = ctx.measureText(lines[0]).width;
  ctx.font = '12px system-ui, sans-serif';
  const bodyWidth = ctx.measureText(lines[1]).width;
  const boxW = Math.ceil(Math.max(titleWidth, bodyWidth) + 24);
  const boxH = 58;
  let x = point.x + 16;
  let y = point.y - boxH - 14;
  if (x + boxW > canvasW - 8) x = point.x - boxW - 16;
  if (y < 8) y = point.y + 16;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
  roundRect(ctx, x, y, boxW, boxH, 8);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.fillText(lines[0], x + 12, y + 22);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(lines[1], x + 12, y + 42);
  ctx.restore();
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawNeutralBars(runs) {
  const canvas = byId('neutralCanvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);

  const left = 90, top = 24, chartW = 600, chartH = 260;
  const efforts = ['none', 'low', 'medium', 'high', 'xhigh'];
  const xForEffort = (effort) => left + Math.max(0, efforts.indexOf(effort)) * (chartW / (efforts.length - 1));
  const yForRate = (rate) => top + chartH - clamp(rate ?? 0, 0, 1) * chartH;

  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(left, top + chartH); ctx.lineTo(left + chartW, top + chartH); ctx.stroke();

  ctx.font = '12px system-ui, sans-serif';
  for (let i = 0; i <= 5; i++) {
    const value = i / 5;
    const y = yForRate(value);
    ctx.strokeStyle = '#e2e8f0';
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + chartW, y); ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(value * 100)}%`, left - 10, y + 4);
  }

  efforts.forEach((effort) => {
    const x = xForEffort(effort);
    ctx.strokeStyle = '#eef2f7';
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + chartH); ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText(reasoningLabel(effort), x, top + chartH + 24);
  });

  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'center';
  ctx.fillText('Reasoning effort', left + chartW / 2, h - 16);
  ctx.save();
  ctx.translate(18, top + chartH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Neutral answer rate', 0, 0);
  ctx.restore();

  if (!runs.length) return;

  const byModel = new Map();
  runs.forEach((run, index) => {
    const key = `${run.provider}/${run.model_slug}`;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push({ run, index });
  });

  for (const entries of byModel.values()) {
    entries.sort((a, b) => efforts.indexOf(a.run.reasoning_effort || 'none') - efforts.indexOf(b.run.reasoning_effort || 'none'));
    if (entries.length > 1) {
      ctx.save();
      ctx.strokeStyle = displayColor(entries[0].run, entries[0].index);
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.beginPath();
      entries.forEach(({ run }, pointIndex) => {
        const x = xForEffort(run.reasoning_effort || 'none');
        const y = yForRate(run.neutral_rate);
        pointIndex === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    }
  }

  runs.forEach((run, index) => {
    const x = xForEffort(run.reasoning_effort || 'none');
    const y = yForRate(run.neutral_rate);
    ctx.save();
    ctx.fillStyle = displayColor(run, index);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });

  drawNeutralLegend(ctx, runs, left + chartW + 36, top + 8);
}

function drawLanguageDelta(pairs, sourceLanguage, targetLanguage, canvasId = 'languageDeltaCanvas') {
  const canvas = byId(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const gridX = 80, gridY = 50, gridSize = 500;
  const barX = 670, barY = 50, barW = 64, barH = 500;
  const centerX = gridX + gridSize / 2;
  const centerY = gridY + gridSize / 2;
  const xForRight = (right) => gridX + ((clamp(right ?? 0, -10, 10) + 10) / 20) * gridSize;
  const yForAuth = (auth) => gridY + ((10 - clamp(auth ?? 0, -10, 10)) / 20) * gridSize;
  const yForProg = (prog) => barY + ((10 - clamp(prog ?? 0, -10, 10)) / 20) * barH;

  ctx.fillStyle = '#f4b5b8'; ctx.fillRect(gridX, gridY, gridSize / 2, gridSize / 2);
  ctx.fillStyle = '#86d4ee'; ctx.fillRect(centerX, gridY, gridSize / 2, gridSize / 2);
  ctx.fillStyle = '#c9e7bf'; ctx.fillRect(gridX, centerY, gridSize / 2, gridSize / 2);
  ctx.fillStyle = '#f5f2a4'; ctx.fillRect(centerX, centerY, gridSize / 2, gridSize / 2);

  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 20; i++) {
    const x = gridX + (i / 20) * gridSize;
    const y = gridY + (i / 20) * gridSize;
    ctx.beginPath(); ctx.moveTo(x, gridY); ctx.lineTo(x, gridY + gridSize); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(gridX, y); ctx.lineTo(gridX + gridSize, y); ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(31, 41, 55, 0.9)';
  ctx.fillStyle = '#1f2937';
  ctx.lineWidth = 4;
  drawArrow(ctx, gridX - 25, centerY, gridX + gridSize + 25, centerY);
  drawArrow(ctx, centerX, gridY + gridSize + 25, centerX, gridY - 25);
  ctx.font = '700 24px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Authority', centerX, 30);
  ctx.fillText('Liberty', centerX, gridY + gridSize + 45);
  ctx.textAlign = 'right'; ctx.fillText('Left', gridX - 28, centerY + 8);
  ctx.textAlign = 'left'; ctx.fillText('Right', gridX + gridSize + 28, centerY + 8);

  const gradient = ctx.createLinearGradient(0, barY, 0, barY + barH);
  gradient.addColorStop(0, '#14c814');
  gradient.addColorStop(0.35, '#37e95d');
  gradient.addColorStop(0.55, '#3b82f6');
  gradient.addColorStop(0.75, '#1d0ea4');
  gradient.addColorStop(1, '#100a4d');
  ctx.fillStyle = gradient;
  ctx.fillRect(barX, barY, barW, barH);
  ctx.strokeStyle = '#111827'; ctx.lineWidth = 1; ctx.strokeRect(barX, barY, barW, barH);
  ctx.fillStyle = '#1f2937';
  ctx.textAlign = 'center';
  ctx.font = '700 24px system-ui, sans-serif';
  ctx.fillText('Progressive', barX + barW / 2, 30);
  ctx.fillText('Conservative', barX + barW / 2, barY + barH + 38);

  if (!pairs.length) {
    ctx.fillStyle = '#64748b';
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`No matching ${sourceLanguage.label}/${targetLanguage.label} runs for the selected models and reasoning levels.`, centerX, centerY);
    drawDeltaLegend(ctx, pairs, sourceLanguage, targetLanguage, 770, 70);
    return;
  }

  pairs.forEach(({ sourceRun, targetRun, effort }, index) => {
    const color = displayColor(sourceRun, index);
    const x1 = xForRight(sourceRun.axis_scores.right);
    const y1 = yForAuth(sourceRun.axis_scores.auth);
    const x2 = xForRight(targetRun.axis_scores.right);
    const y2 = yForAuth(targetRun.axis_scores.auth);
    const sourceProgY = yForProg(sourceRun.axis_scores.prog);
    const targetProgY = yForProg(targetRun.axis_scores.prog);
    const progX = barX + barW / 2 + ((index % 5) - 2) * 9;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 2.5;
    drawArrow(ctx, x1, y1, x2, y2);
    drawArrow(ctx, progX, sourceProgY, progX, targetProgY);
    ctx.globalAlpha = 1;
    drawRunMarker(ctx, x1, y1, 5, '#ffffff', effort);
    drawRunMarker(ctx, x2, y2, 7, color, effort);
    drawRunMarker(ctx, progX, sourceProgY, 4, '#ffffff', effort);
    drawRunMarker(ctx, progX, targetProgY, 5, color, effort);
    ctx.restore();
  });

  drawDeltaLegend(ctx, pairs, sourceLanguage, targetLanguage, 770, 70);
}

function drawDeltaLegend(ctx, pairs, sourceLanguage, targetLanguage, x, y) {
  ctx.textAlign = 'left';
  ctx.font = '700 14px system-ui, sans-serif';
  ctx.fillStyle = '#111827';
  ctx.fillText(`${sourceLanguage.label} → ${targetLanguage.label}`, x, y);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText(`Hollow = ${sourceLanguage.label} start · Filled = ${targetLanguage.label} end`, x, y + 18);

  pairs.slice(0, 12).forEach(({ sourceRun, targetRun, effort }, index) => {
    const yy = y + 44 + index * 34;
    const color = displayColor(sourceRun, index);
    const deltaRight = (targetRun.axis_scores.right ?? 0) - (sourceRun.axis_scores.right ?? 0);
    const deltaAuth = (targetRun.axis_scores.auth ?? 0) - (sourceRun.axis_scores.auth ?? 0);
    const deltaProg = (targetRun.axis_scores.prog ?? 0) - (sourceRun.axis_scores.prog ?? 0);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.5;
    drawRunMarker(ctx, x + 6, yy - 5, 5, color, effort);
    ctx.fillStyle = '#111827';
    ctx.fillText(`${baseRunLabel(sourceRun)} · ${reasoningLabel(effort)}`, x + 18, yy - 8);
    ctx.fillStyle = '#64748b';
    ctx.fillText(`ΔR ${signedScore(deltaRight)} · ΔA ${signedScore(deltaAuth)} · ΔP ${signedScore(deltaProg)}`, x + 18, yy + 8);
  });
  if (pairs.length > 12) {
    ctx.fillStyle = '#64748b';
    ctx.fillText(`+${pairs.length - 12} more`, x, y + 44 + 12 * 34);
  }
}

function signedScore(value) {
  return `${value >= 0 ? '+' : ''}${formatScore(value)}`;
}

function drawResponseTypeBars(runs) {
  const canvas = byId('textualResponseTypeCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const types = ['stance', 'both_sides', 'neutral', 'refusal', 'unclear', 'informational'];
  const typeColors = {
    stance: '#2563eb',
    both_sides: '#f59e0b',
    neutral: '#94a3b8',
    refusal: '#ef4444',
    unclear: '#a855f7',
    informational: '#10b981',
  };
  const left = 320, top = 34, barW = 520, rowH = 34;

  ctx.font = '700 14px system-ui, sans-serif';
  ctx.fillStyle = '#111827';
  ctx.textAlign = 'left';
  ctx.fillText('Response type share', left, 18);

  if (!runs.length) {
    ctx.fillStyle = '#64748b';
    ctx.fillText('No textual runs selected.', left, top + 24);
    return;
  }

  runs.slice(0, 12).forEach((run, index) => {
    const y = top + index * rowH;
    const counts = run.response_type_counts || {};
    const total = Math.max(1, Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0));
    ctx.fillStyle = '#111827';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(baseRunLabel(run), left - 10, y + 15);

    let x = left;
    for (const type of types) {
      const width = (Number(counts[type] || 0) / total) * barW;
      if (width <= 0) continue;
      ctx.fillStyle = typeColors[type];
      ctx.fillRect(x, y, width, 18);
      x += width;
    }
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(left, y, barW, 18);
    if (run.average_judge_confidence != null) {
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'left';
      ctx.fillText(`conf ${Math.round(run.average_judge_confidence * 100)}%`, left + barW + 12, y + 15);
    }
  });

  const legendX = left;
  const legendY = top + Math.min(runs.length, 12) * rowH + 18;
  ctx.textAlign = 'left';
  ctx.font = '12px system-ui, sans-serif';
  types.forEach((type, index) => {
    const x = legendX + (index % 3) * 170;
    const y = legendY + Math.floor(index / 3) * 22;
    ctx.fillStyle = typeColors[type];
    ctx.fillRect(x, y - 10, 12, 12);
    ctx.fillStyle = '#111827';
    ctx.fillText(type.replace('_', ' '), x + 18, y);
  });
}

function renderDetails(runs) {
  const root = byId('details');
  root.innerHTML = '';
  if (!runs.length) {
    root.textContent = 'No runs selected.';
    return;
  }
  runs.forEach((run) => {
    const div = document.createElement('div');
    div.className = 'detail-card';
    div.innerHTML = `
      <h3>${escapeHtml(shortLabel(run))}</h3>
      <dl>
        <dt>Scenario</dt><dd>${escapeHtml(run.scenario_id)}</dd>
        <dt>Provider</dt><dd>${escapeHtml(run.provider)}</dd>
        <dt>Router</dt><dd>${escapeHtml(run.router || 'n/a')}</dd>
        <dt>Model</dt><dd>${escapeHtml(run.openrouter_model_name || run.model)}</dd>
        <dt>Config</dt><dd>${escapeHtml(run.config_slug)}</dd>
        <dt>Right</dt><dd>${formatScore(run.axis_scores.right)}</dd>
        <dt>Auth</dt><dd>${formatScore(run.axis_scores.auth)}</dd>
        <dt>Prog</dt><dd>${formatScore(run.axis_scores.prog)}</dd>
        <dt>Neutral</dt><dd>${run.neutral_count}/${run.response_count} (${pct(run.neutral_rate)})</dd>
      </dl>`;
    root.appendChild(div);
  });
}

function drawArrow(ctx, fromX, fromY, toX, toY) {
  const headLength = 18;
  const angle = Math.atan2(toY - fromY, toX - fromX);
  ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(toX, toY); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
  ctx.closePath(); ctx.fill();
}

function drawNeutralLegend(ctx, runs, x, y) {
  const legendRuns = uniqueLegendRuns(runs);
  ctx.textAlign = 'left';
  ctx.font = '700 14px system-ui, sans-serif';
  ctx.fillStyle = '#111827';
  ctx.fillText('Models', x, y);
  ctx.font = '12px system-ui, sans-serif';
  legendRuns.slice(0, 12).forEach((run, index) => {
    const yy = y + 22 + index * 20;
    ctx.strokeStyle = displayColor(run, index);
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, yy - 5);
    ctx.lineTo(x + 18, yy - 5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = displayColor(run, index);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + 9, yy - 5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.fillText(baseRunLabel(run), x + 26, yy);
  });
  if (legendRuns.length > 12) {
    ctx.fillStyle = '#64748b';
    ctx.fillText(`+${legendRuns.length - 12} more`, x, y + 22 + 12 * 20);
  }
}

function uniqueLegendRuns(runs) {
  const byModel = new Map();
  for (const run of runs) {
    const key = `${run.provider}/${run.model_slug}`;
    if (!byModel.has(key)) byModel.set(key, run);
  }
  return [...byModel.values()];
}

function drawLegend(ctx, runs, x, y) {
  ctx.textAlign = 'left';
  ctx.font = '700 14px system-ui, sans-serif';
  ctx.fillStyle = '#111827';
  ctx.fillText('Selected runs', x, y);
  ctx.font = '12px system-ui, sans-serif';
  const legendRuns = uniqueLegendRuns(runs);
  legendRuns.slice(0, 12).forEach((run, index) => {
    const yy = y + 22 + index * 20;
    ctx.fillStyle = displayColor(run, index);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + 5, yy - 5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.fillText(baseRunLabel(run), x + 16, yy);
  });

  const efforts = [...new Set(runs.map((run) => run.reasoning_effort || 'none'))];
  if (efforts.length > 1 || efforts[0] !== 'none') {
    const startY = y + 22 + Math.min(legendRuns.length, 12) * 20 + 14;
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillStyle = '#111827';
    ctx.fillText('Reasoning effort', x, startY);
    ctx.font = '12px system-ui, sans-serif';
    ['none', 'low', 'medium', 'high', 'xhigh'].filter((effort) => efforts.includes(effort)).forEach((effort, index) => {
      const yy = startY + 20 + index * 18;
      drawRunMarker(ctx, x + 5, yy - 5, 5, '#94a3b8', effort === 'none' ? null : effort);
      ctx.fillStyle = '#111827';
      ctx.fillText(effort, x + 16, yy);
    });
  }
}

function shortLabel(run) {
  return run.label || run.default_label || `${run.model_slug} · ${run.config_slug}`;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function setSidebarVisible(visible) {
  const sidebar = byId('modelSidebar');
  const toggle = byId('sidebarToggle');
  sidebar.hidden = !visible;
  toggle.setAttribute('aria-expanded', String(visible));
}

byId('sidebarToggle').addEventListener('click', () => setSidebarVisible(byId('modelSidebar').hidden));
byId('sidebarClose').addEventListener('click', () => setSidebarVisible(false));

byId('selectAllButton').addEventListener('click', () => {
  const allModelKeys = [...new Set(state.manifest.runs.map(modelKey))];
  const allSelected = state.selectedModels.size === allModelKeys.length;
  state.selectedModels = new Set(allSelected ? [] : allModelKeys);
  state.hoveredRunId = null;
  renderRunTree();
  renderAll();
});

byId('showCompassLabels').addEventListener('change', () => drawCompass(selectedCompassRuns()));

main().catch((error) => {
  document.body.innerHTML = `<pre style="padding:1rem;color:#b91c1c">${escapeHtml(error.stack || error.message)}</pre>`;
});
