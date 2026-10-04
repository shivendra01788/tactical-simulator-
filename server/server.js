const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;
const VALID_ROLES = ['instructor', 'commander', 'unit'];
const ROLE_LABEL = { instructor: 'INSTRUCTOR', commander: 'TEAM LEAD', unit: 'INFORMATION' };

// Scenarios are played in this order. Add a new file here to add another scenario to the sequence.
const SCENARIO_FILES = ['conflicting-picture.json'];
const DECISION_PAUSE_MS = 8000; // after the last decision's outcome has played, wait this long before moving on
const NEXT_DELAY_MS = 5000; // pause between the end of one scenario and the start of the next

// Preset radio messages between the two trainee terminals. They cross the link, so the instructor's
// delay and packet-loss settings can delay or lose them (their wording is never garbled).
const MESSAGES = {
  commander: {
    REQ_ALL: 'Information, send me everything you hold on the situation.',
    REQ_CONTRADICT: 'Information, do you have anything that contradicts the optical feed?',
    REQ_CONFIRM: 'Information, is the last report reliable? Confirm.',
  },
  unit: {
    RESP_STANDBY: 'Team Lead, standby. Checking my sensors.',
    RESP_RELAYING: 'Team Lead, relaying my reports to you now.',
    RESP_NONEW: 'Team Lead, negative. No new information.',
    RESP_CONFLICT: 'Team Lead, my reports conflict with the optical feed. Recommend we verify before committing.',
  },
};

// Maps role names used in the scenario JSON onto the three roles the UI joins with.
// COORDINATION shares the "unit" terminal with INFORMATION (one specialist seat in this prototype).
const ROLE_ALIASES = {
  team_lead: 'commander',
  teamlead: 'commander',
  coordination: 'unit',
  tactical_operations: 'unit',
  information: 'unit',
  information_terminal: 'unit',
  ground_unit: 'unit',
};

const normalizeRole = (r) => {
  const key = String(r || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ROLE_ALIASES[key] || key;
};

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let scenarios = [];
try {
  scenarios = SCENARIO_FILES.map((file) => {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios', file), 'utf8'));
    console.log(`✅ SUCCESS: Loaded Scenario JSON (${data.title})`);
    return data;
  });
} catch (err) {
  console.error('❌ CRITICAL ERROR: Could not load scenario JSON!', err.message);
  process.exit(1);
}

scenarios.forEach((sc) => {
  const used = [
    ...sc.information_sources.flatMap((s) => s.default_assigned_roles || []),
    ...sc.decision_points.flatMap((d) => d.allowed_roles || []),
  ].map(normalizeRole);
  const unknown = [...new Set(used.filter((r) => !VALID_ROLES.includes(r)))];
  if (unknown.length) {
    console.warn(
      `⚠️  Scenario "${sc.scenario_id}" targets unknown roles: ${unknown.join(', ')}. Valid: ${VALID_ROLES.join(', ')}`
    );
  }
});

// ---------------------------------------------------------------- session state

const truthStore = {};

function newSession() {
  return {
    isRunning: false,
    paused: false, // instructor can freeze the exercise clock
    usedInjects: new Set(), // live injects already sent this run
    clock: 0,
    timer: null,
    advanceTimer: null, // fires after all decisions are closed, then ends the scenario
    nextTimer: null, // fires between scenarios, then starts the next one
    runId: 0, // changes every run so delayed transmissions from an old run are discarded
    scenarioIndex: 0,
    reports: [], // one after-action report per scenario played in this sequence
    pendingOutcomes: [], // consequences of decisions waiting for their time to fire
    msgAt: {}, // last radio message time per role (rate limit)
    msgSeq: 0,
    startedAt: null,
    entities: {},
    decisions: [],
    closed: new Set(), // decisions already answered or timed out
    relayed: new Set(), // report ids already relayed to the commander
    inbox: { commander: [], unit: [] }, // what each role actually received
    log: [], // timeline used for the after-action review
    config: { jam: { commander: 0, unit: 0 }, latencyBase: 0, jitterMs: 0, dropRate: 0, audioOnly: false },
    repeatAt: {}, // last 'say again' time per report
    repeats: {},
  };
}

function getSession(id) {
  if (!truthStore[id]) truthStore[id] = newSession();
  return truthStore[id];
}

// The scenario the session is currently on.
const scn = (session) => scenarios[session.scenarioIndex];

function clearTimers(session) {
  clearTimeout(session.advanceTimer);
  clearTimeout(session.nextTimer);
  session.advanceTimer = null;
  session.nextTimer = null;
}

function resetRun(session) {
  session.runId += 1;
  Object.assign(session, {
    clock: 0,
    startedAt: new Date().toISOString(),
    entities: {},
    decisions: [],
    closed: new Set(),
    relayed: new Set(),
    inbox: { commander: [], unit: [] },
    log: [],
    paused: false,
    usedInjects: new Set(),
    pendingOutcomes: [],
    msgAt: {},
    msgSeq: 0,
    repeatAt: {},
    repeats: {},
  });
}

const roomFor = (sessionId, role) => `session:${sessionId}:role:${role}`;
const record = (session, entry) => session.log.push({ t: session.clock, ...entry });

function stateOf(s) {
  return {
    isRunning: s.isRunning,
    paused: s.paused,
    clock: s.clock,
    injects: (scn(s).instructor_injects || []).map((i) => ({ id: i.inject_id, label: i.label })),
    scenarioIndex: s.scenarioIndex,
    scenarioCount: scenarios.length,
    scenarioTitle: scn(s).title,
  };
}

function broadcastState(sessionId) {
  io.to(`session:${sessionId}`).emit('scenario:state', stateOf(getSession(sessionId)));
}

// ---------------------------------------------------------------- degradation (RF jamming)

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const STATIC = '▒▒▒';
const cleanWord = (w) => w.toLowerCase().replace(/[^a-z0-9-]/g, '');

// A message is a list of words plus a mask of which words survived so far.
function makeMessage(text, keyTerms) {
  const words = String(text).split(/\s+/).filter(Boolean);
  return { words, kept: words.map(() => true), keyTerms: (keyTerms || []).map(cleanWord) };
}

// A jammed link loses each surviving word with probability = jam. Deterministic per seed key,
// so the same scenario degrades the same way for every trainee (fair comparison).
function jamMessage(msg, jam, seedKey, seed) {
  const rand = mulberry32(hashStr(`${seed}|${seedKey}`));
  const kept = msg.kept.map((k) => {
    const r = rand();
    return k && r >= jam;
  });
  return { words: msg.words, keyTerms: msg.keyTerms, kept };
}

function describeMessage(msg) {
  const out = [];
  const segments = [];
  let cur = [];
  msg.words.forEach((w, i) => {
    if (msg.kept[i]) {
      cur.push(w);
      out.push(w);
    } else {
      if (cur.length) {
        segments.push(cur.join(' '));
        cur = [];
      }
      if (out[out.length - 1] !== STATIC) out.push(STATIC);
    }
  });
  if (cur.length) segments.push(cur.join(' '));
  const total = msg.words.length || 1;
  const keptCount = msg.kept.filter(Boolean).length;
  const keyHit = msg.keyTerms.filter((t) =>
    msg.words.some((w, i) => msg.kept[i] && cleanWord(w) === t)
  ).length;
  return {
    text: out.join(' '),
    segments,
    clarity: keptCount / total,
    keyRatio: msg.keyTerms.length ? keyHit / msg.keyTerms.length : 1,
  };
}

// Builds the report a recipient actually gets. Metadata (status label, map tracks) is also degraded.
function renderReport(base, msg, config, extra) {
  const m = describeMessage(msg);
  const degraded = m.clarity < 0.999;
  return {
    ...base,
    data: { status: degraded ? '[SIGNAL DEGRADED]' : base.data.status, summary: m.text },
    segments: m.segments,
    clarity: m.clarity,
    voiceOnly: Boolean(config.audioOnly),
    tracks:
      m.clarity < 0.6
        ? (base.tracks || []).map((t) => ({ ...t, kind: 'suspect', label: `${t.label}?` }))
        : base.tracks || [],
    ...extra,
  };
}

// jam >= 95% is a blackout (nothing gets through). Otherwise jam only garbles intel text.
function decide(config, role) {
  const jam = (config.jam && config.jam[role]) || 0;
  if (jam >= 0.95 || Math.random() < config.dropRate) return { action: 'drop', jam };
  const jitter = (Math.random() * 2 - 1) * config.jitterMs;
  const delay = Math.max(0, config.latencyBase + jitter);
  return delay > 0 ? { action: 'delay', delay, jam } : { action: 'now', jam };
}

// Every event goes through here. The instructor always receives the true, undegraded event.
// meta.intel marks an intel report (needs meta.msg, meta.seedKey); meta.exempt skips degradation.
function deliver(sessionId, targetRoles, eventName, payload, meta = {}) {
  const session = getSession(sessionId);
  const runId = session.runId;
  const roles = new Set((targetRoles || []).map(normalizeRole));
  roles.add('instructor');

  roles.forEach((role) => {
    const room = roomFor(sessionId, role);

    if (role === 'instructor') {
      io.to(room).emit(eventName, meta.intel ? renderReport(payload, meta.msg, {}, meta.extra) : payload);
      return;
    }
    if (meta.exempt) {
      io.to(room).emit(eventName, payload);
      return;
    }

    const d = decide(session.config, role);
    if (d.action === 'drop') {
      console.log(`[x] DROPPED ${eventName} -> ${role}`);
      if (meta.intel) record(session, { type: 'intel', role, ...meta.intel, outcome: 'dropped' });
      io.to(roomFor(sessionId, 'instructor')).emit('link:dropped', { role, eventName, at: session.clock });
      return;
    }

    let out = payload;
    let msg = null;
    let quality = null;
    if (meta.intel) {
      msg = jamMessage(meta.msg, d.jam, `${meta.seedKey}|${role}`, scn(session).seed);
      out = renderReport(payload, msg, session.config, meta.extra);
      quality = describeMessage(msg);
    }

    const send = () => {
      // A delayed transmission from a scenario that has already ended is discarded.
      if (session.runId !== runId || !session.isRunning) return;
      io.to(room).emit(eventName, out);
      if (!meta.intel) return;
      record(session, {
        type: 'intel',
        role,
        ...meta.intel,
        outcome: 'delivered',
        clarity: quality.clarity,
        keyRatio: quality.keyRatio,
      });
      if (session.inbox[role]) {
        session.inbox[role].push({ id: payload.id, base: payload, origin: meta.msg, msg, report: out });
      }
      io.to(roomFor(sessionId, 'instructor')).emit('link:delivery', {
        role,
        reportId: payload.id,
        clarity: quality.clarity,
        text: out.data.summary,
        at: session.clock,
      });
    };

    if (d.action === 'delay') setTimeout(send, d.delay);
    else send();
  });
}

// ---------------------------------------------------------------- evaluation

function describe(e) {
  const who = ROLE_LABEL[e.role] || e.role;
  switch (e.type) {
    case 'intel':
      return e.outcome === 'dropped'
        ? `${who}: ${e.source} report LOST in transit`
        : `${who} received ${e.source} at ${Math.round(e.clarity * 100)}% clarity${
            e.relayed ? ' (relayed by team)' : ''
          }${e.repeat ? ` (repeat #${e.repeat})` : ''}`;
    case 'repeat':
      return `${who} asked for a repeat of ${e.source}`;
    case 'condition':
      return `${who} set link conditions: ${e.summary}`;
    case 'relay':
      return `${who} relayed ${e.source} to TEAM LEAD`;
    case 'decision_open':
      return `Decision opened: ${e.decisionId}`;
    case 'decision':
      return `${who} ordered: ${e.label}`;
    case 'decision_timeout':
      return `Decision ${e.decisionId} timed out - no order issued`;
    case 'outcome':
      return `OUTCOME: ${e.title}`;
    case 'inject':
      return `INSTRUCTOR injected: ${e.label}`;
    case 'message':
      return `${who} -> ${ROLE_LABEL[e.to] || e.to}: "${e.text}"`;
    default:
      return e.type;
  }
}

function buildEvaluation(sessionId, reason) {
  const s = getSession(sessionId);
  const sc = scn(s);
  const rules = sc.evaluation_rules || {};
  const decisionRules = rules.decisions || {};
  const weight = Number.isFinite(rules.decision_weight) ? rules.decision_weight : 60;

  const decisions = sc.decision_points.map((dp) => {
    const id = dp.decision_point_id;
    const rec = s.decisions.find((d) => d.decisionId === id && !d.timedOut);
    const timedOut = s.decisions.some((d) => d.decisionId === id && d.timedOut);
    const rule = rec ? (decisionRules[id] || {})[rec.optionId] : null;
    return {
      decisionId: id,
      prompt: dp.prompt,
      openedAt: dp.trigger_time_seconds,
      answered: Boolean(rec),
      timedOut,
      optionId: rec ? rec.optionId : null,
      label: rec ? rec.label : null,
      decidedAt: rec ? rec.t : null,
      responseSeconds: rec ? rec.t - dp.trigger_time_seconds : null,
      rating: rule ? rule.rating : rec ? 'UNRATED' : 'NO DECISION',
      score: rule ? rule.score : 0,
      feedback: rule ? rule.feedback : rec ? '' : 'No order was issued before the decision window closed.',
    };
  });

  const checks = (rules.information_checks || []).map((c) => {
    const dec = decisions.find((d) => d.decisionId === c.before_decision);
    const deadline = dec && dec.decidedAt !== null ? dec.decidedAt : Infinity;
    const role = normalizeRole(c.role);
    const minKey = Number.isFinite(rules.min_key_ratio) ? rules.min_key_ratio : 0.5;
    const mine = (e) =>
      e.type === 'intel' && e.outcome === 'delivered' && e.role === role && e.source_id === c.source_id && !e.injected;
    // A report only counts if enough of its key words actually got through the link.
    const hit = s.log.find((e) => mine(e) && e.t <= deadline && e.keyRatio >= minKey);
    const heard = s.log.some(mine);
    return {
      checkId: c.check_id,
      description: c.description,
      passed: Boolean(hit),
      points: hit ? c.points : 0,
      maxPoints: c.points,
      receivedAt: hit ? hit.t : null,
      via: hit ? (hit.relayed ? 'relayed by team' : hit.repeat ? 'repeat request' : 'direct feed') : null,
      clarity: hit ? Math.round(hit.clarity * 100) : null,
      note: hit ? null : heard ? 'received but too garbled' : 'never received',
    };
  });

  const decisionPct = decisions.length
    ? decisions.reduce((sum, d) => sum + d.score, 0) / decisions.length
    : 0;
  const decisionPoints = Math.round((decisionPct * weight) / 100);
  const infoPoints = checks.reduce((sum, c) => sum + c.points, 0);
  const infoMax = checks.reduce((sum, c) => sum + c.maxPoints, 0);
  const total = decisionPoints + infoPoints;
  const max = weight + infoMax;
  const percent = max ? Math.round((total / max) * 100) : 0;
  const grade = percent >= 85 ? 'EXCELLENT' : percent >= 60 ? 'SATISFACTORY' : 'NEEDS IMPROVEMENT';

  const cmdHeard = s.log.filter((e) => e.type === 'intel' && e.role === 'commander' && e.outcome === 'delivered');
  const comms = {
    commanderAvgClarity: cmdHeard.length
      ? Math.round((cmdHeard.reduce((a, e) => a + e.clarity, 0) / cmdHeard.length) * 100)
      : null,
    repeatRequests: s.log.filter((e) => e.type === 'repeat').length,
    relays: s.log.filter((e) => e.type === 'relay').length,
    messages: s.log.filter((e) => e.type === 'message').length,
    dropped: s.log.filter((e) => e.type === 'intel' && e.outcome === 'dropped').length,
  };

  // Specialist (Information terminal): did they pass the key intel up before the decision, and answer requests?
  const specRules = rules.specialist_rules || {};
  const winSec = Number.isFinite(specRules.response_window_seconds) ? specRules.response_window_seconds : 20;
  const specChecks = (specRules.relay_checks || []).map((c) => {
    const dec = decisions.find((d) => d.decisionId === c.before_decision);
    const deadline = dec && dec.decidedAt !== null ? dec.decidedAt : Infinity;
    const hit = s.log.find((e) => e.type === 'relay' && !e.injected && e.source_id === c.source_id && e.t <= deadline);
    return {
      checkId: c.check_id,
      description: c.description,
      passed: Boolean(hit),
      points: hit ? c.points : 0,
      maxPoints: c.points,
      relayedAt: hit ? hit.t : null,
    };
  });
  const answers = s.log.filter((e) => (e.type === 'message' && e.role === 'unit') || e.type === 'relay');
  const requests = s.log
    .filter((e) => e.type === 'message' && e.role === 'commander')
    .map((req) => {
      const ans = answers.find((a) => a.t >= req.t);
      const secs = ans ? ans.t - req.t : null;
      return { text: req.text, at: req.t, answered: Boolean(ans), responseSeconds: secs, inTime: secs !== null && secs <= winSec };
    });
  const specPoints = specChecks.reduce((a, c) => a + c.points, 0);
  const specMax = specChecks.reduce((a, c) => a + c.maxPoints, 0);
  const specialist = {
    points: specPoints,
    max: specMax,
    percent: specMax ? Math.round((specPoints / specMax) * 100) : null,
    checks: specChecks,
    requests,
    responseWindow: winSec,
  };

  return {
    sessionId,
    scenarioId: sc.scenario_id,
    scenarioIndex: s.scenarioIndex + 1,
    scenarioCount: scenarios.length,
    scenario: sc.title,
    objectives: sc.learning_objectives || [],
    reason,
    final: true, // finishScenario sets this to false when another scenario follows
    startedAt: s.startedAt,
    endedAt: new Date().toISOString(),
    durationSeconds: s.clock,
    score: { total, max, percent, grade, decisionPoints, decisionMax: weight, infoPoints, infoMax },
    decisions,
    checks,
    comms,
    specialist,
    timeline: s.log.map((e) => ({ t: e.t, text: describe(e) })).sort((a, b) => a.t - b.t),
  };
}

function saveReport(report) {
  try {
    const dir = path.join(__dirname, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = report.endedAt.replace(/[:.]/g, '-');
    const file = path.join(dir, `${report.sessionId}-${report.scenarioId}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`💾 AAR saved: ${file}`);
  } catch (err) {
    console.error('Could not save AAR:', err.message);
  }
}

// ---------------------------------------------------------------- simulation loop

// Ends the current scenario and evaluates it. With opts.advance, the next scenario in the
// sequence starts automatically after NEXT_DELAY_MS (if there is one).
function finishScenario(sessionId, reason, opts = {}) {
  const session = getSession(sessionId);
  if (!session.isRunning) return;

  clearTimers(session);
  clearInterval(session.timer);
  session.timer = null;
  session.isRunning = false;
  session.paused = false;
  console.log(`[⏹] ${reason}`);
  broadcastState(sessionId);

  const hasNext = Boolean(opts.advance) && session.scenarioIndex < scenarios.length - 1;

  try {
    const report = buildEvaluation(sessionId, reason);
    report.final = !hasNext;
    session.reports = session.reports.filter((r) => r.scenarioId !== report.scenarioId);
    session.reports.push(report);
    saveReport(report);
    console.log(`📊 AAR: ${report.score.total}/${report.score.max} (${report.score.grade})`);
    io.to(roomFor(sessionId, 'instructor')).emit('evaluation:report', report);
  } catch (err) {
    console.error('❌ Evaluation failed:', err);
  }

  if (hasNext) {
    const next = scenarios[session.scenarioIndex + 1];
    io.to(`session:${sessionId}`).emit('scenario:next', {
      nextIndex: session.scenarioIndex + 1,
      scenarioCount: scenarios.length,
      title: next.title,
      inSeconds: Math.round(NEXT_DELAY_MS / 1000),
    });
    session.nextTimer = setTimeout(() => {
      session.nextTimer = null;
      session.scenarioIndex += 1;
      runScenario(sessionId);
    }, NEXT_DELAY_MS);
  } else {
    io.to(`session:${sessionId}`).emit('scenario:complete', { reason });
  }
}

// Queues the consequence of a decision (or of running out the clock: optionId null = NO_DECISION).
function scheduleOutcome(session, decisionId, optionId) {
  const rules = scn(session).outcome_rules || [];
  const rule = rules.find((r) => r.decision_point_id === decisionId && r.option_id === (optionId || 'NO_DECISION'));
  if (!rule) return;
  session.pendingOutcomes.push({ at: session.clock + Math.max(1, rule.delay_seconds || 1), rule });
}

// Consequences are ground truth, so they reach everyone without radio degradation.
function fireOutcome(sessionId, rule) {
  const session = getSession(sessionId);
  console.log(`[T+${session.clock}s] 💥 OUTCOME: ${rule.title}`);
  record(session, { type: 'outcome', title: rule.title, tone: rule.tone });
  deliver(
    sessionId,
    ['commander', 'unit'],
    'outcome:report',
    {
      id: `${rule.decision_point_id}:${rule.option_id}`,
      decisionId: rule.decision_point_id,
      title: rule.title,
      message: rule.message,
      tone: rule.tone,
      tracks: rule.map_tracks || [],
      timestamp: session.clock,
    },
    { exempt: true }
  );
}

// Once every decision in the current scenario is answered or timed out, move on after a short pause.
function maybeAdvance(sessionId) {
  const session = getSession(sessionId);
  if (!session.isRunning || session.advanceTimer) return;
  const allClosed = scn(session).decision_points.every((d) => session.closed.has(d.decision_point_id));
  if (!allClosed || session.pendingOutcomes.length) return; // wait for the consequences to play out
  session.advanceTimer = setTimeout(() => {
    session.advanceTimer = null;
    if (session.paused) return; // resumed later: maybeAdvance runs again
    finishScenario(sessionId, 'SCENARIO COMPLETE', { advance: true });
  }, DECISION_PAUSE_MS);
}

// The instructor pushes an extra report into the running scenario. It travels over the same
// degraded links as scheduled intel, but never counts toward the Team Lead's or specialist's checks.
function injectIntel(sessionId, inj) {
  const session = getSession(sessionId);
  const sc = scn(session);
  const src = sc.information_sources.find((x) => x.source_id === inj.source_id);
  if (!src) return false;

  const tick = session.clock;
  const audience = [...new Set((src.default_assigned_roles || []).map(normalizeRole))];
  const report = {
    id: `${src.source_id}@${tick}+${inj.inject_id}`,
    source: src.name,
    source_id: src.source_id,
    type: src.type,
    data: inj.payload,
    timestamp: tick,
    tracks: inj.map_tracks || [],
    audience,
    relayed: false,
    injected: true,
  };
  const text = inj.payload.summary || inj.payload.observation || '';
  console.log(`[T+${tick}s] 💉 INJECT: ${inj.inject_id}`);
  record(session, { type: 'inject', role: 'instructor', label: inj.label });
  deliver(sessionId, audience, 'intel:receive', report, {
    intel: { source_id: src.source_id, source: src.name, status: inj.payload.status, relayed: false, injected: true },
    msg: makeMessage(text, inj.key_terms),
    seedKey: `${report.id}|first`,
  });
  return true;
}

// Starts a fresh sequence from the first scenario.
function startSimulation(sessionId) {
  const session = getSession(sessionId);
  console.log(`[!] INSTRUCTOR COMMAND RECEIVED: STARTING SCENARIO SEQUENCE (${sessionId})...`);

  if (session.isRunning) {
    console.log('[-] Ignored: Scenario is already running.');
    return;
  }

  clearTimers(session);
  session.scenarioIndex = 0;
  session.reports = [];
  runScenario(sessionId);
}

// Runs the scenario the session is currently pointing at.
function runScenario(sessionId) {
  const session = getSession(sessionId);
  const sc = scn(session);

  clearTimers(session);
  resetRun(session);
  session.isRunning = true;
  broadcastState(sessionId);
  console.log(`[▶] CLOCK STARTED: 0s (${sc.title})`);

  const start = (sc.world_state || {}).unit_start;
  if (start) {
    session.entities['unit-1'] = { lat: start.lat, lng: start.lng, kind: 'friendly', label: 'UNIT-1' };
    deliver(sessionId, ['commander', 'unit'], 'map:update', { entityId: 'unit-1', ...session.entities['unit-1'] });
  }

  session.timer = setInterval(() => {
    if (session.paused) return; // clock frozen by the instructor
    try {
      const tick = session.clock;

      sc.scheduled_events
        .filter((e) => e.time_seconds === tick)
        .forEach((event) => {
          const src = sc.information_sources.find((s) => s.source_id === event.source_id);
          if (!src) return;
          console.log(`[T+${tick}s] 📡 INTEL INJECT: ${event.source_id}`);

          const audience = [...new Set((src.default_assigned_roles || []).map(normalizeRole))];
          const report = {
            id: `${src.source_id}@${event.time_seconds}`,
            source: src.name,
            source_id: src.source_id,
            type: src.type,
            data: event.payload,
            timestamp: tick,
            tracks: event.map_tracks || [],
            audience,
            relayed: false,
          };
          const text = event.payload.summary || event.payload.observation || '';
          deliver(sessionId, audience, 'intel:receive', report, {
            intel: { source_id: src.source_id, source: src.name, status: event.payload.status, relayed: false },
            msg: makeMessage(text, event.key_terms),
            seedKey: `${report.id}|first`,
          });
        });

      sc.decision_points
        .filter((d) => d.trigger_time_seconds === tick)
        .forEach((dp) => {
          console.log(`[T+${tick}s] ⚠️ DECISION TRIGGERED: ${dp.decision_point_id}`);
          record(session, { type: 'decision_open', decisionId: dp.decision_point_id });
          deliver(sessionId, dp.allowed_roles, 'decision:trigger', dp, { exempt: true });
        });

      sc.decision_points
        .filter(
          (d) =>
            d.timeout_seconds &&
            d.trigger_time_seconds + d.timeout_seconds === tick &&
            !session.closed.has(d.decision_point_id)
        )
        .forEach((dp) => {
          session.closed.add(dp.decision_point_id);
          const rec = {
            decisionId: dp.decision_point_id,
            optionId: null,
            label: 'NO DECISION (timed out)',
            role: normalizeRole((dp.allowed_roles || [])[0]),
            t: tick,
            timedOut: true,
          };
          session.decisions.push(rec);
          record(session, { type: 'decision_timeout', decisionId: rec.decisionId });
          console.log(`[T+${tick}s] ⏱ DECISION TIMED OUT: ${rec.decisionId}`);
          io.to(`session:${sessionId}`).emit('decision:expired', rec);
          scheduleOutcome(session, dp.decision_point_id, null);
          maybeAdvance(sessionId);
        });

      const due = session.pendingOutcomes.filter((o) => o.at <= tick);
      if (due.length) {
        session.pendingOutcomes = session.pendingOutcomes.filter((o) => o.at > tick);
        due.forEach((o) => fireOutcome(sessionId, o.rule));
        maybeAdvance(sessionId);
      }

      io.to(`session:${sessionId}`).emit('clock:tick', tick);

      if (tick >= sc.duration_seconds) {
        finishScenario(sessionId, 'SCENARIO COMPLETE', { advance: true });
      } else {
        session.clock++;
      }
    } catch (error) {
      console.error('❌ ERROR DURING TICK:', error);
      finishScenario(sessionId, 'SCENARIO ABORTED (error)');
    }
  }, 1000);
}

// ---------------------------------------------------------------- sockets

const PAUSE_BLOCKED = new Set(['intel:relay', 'intel:repeat', 'decision:submit', 'comms:send', 'unit:move', 'instructor:inject']);

io.on('connection', (socket) => {
  console.log(`[~] socket ${socket.id} connected`);

  // While the exercise is paused, nobody can act.
  socket.use(([event], next) => {
    const { sessionId } = socket.data;
    if (sessionId && PAUSE_BLOCKED.has(event) && getSession(sessionId).paused) {
      socket.emit('session:error', { message: 'The exercise is paused by the instructor.' });
      return;
    }
    next();
  });

  socket.on('session:join', ({ sessionId, role } = {}) => {
    const r = normalizeRole(role);
    if (!sessionId || !/^[A-Za-z0-9_-]{1,32}$/.test(String(sessionId)) || !VALID_ROLES.includes(r)) {
      socket.emit('session:error', { message: `Invalid join request (role: ${role})` });
      return;
    }

    socket.data.sessionId = sessionId;
    socket.data.role = r;
    socket.join(`session:${sessionId}`);
    socket.join(roomFor(sessionId, r));

    const session = getSession(sessionId);
    console.log(`[+] ${r.toUpperCase()} joined ${sessionId}`);

    socket.emit('session:joined', { status: 'success', sessionId, role: r });
    socket.emit('scenario:state', stateOf(session));
    if (r === 'instructor') socket.emit('conditions:update', session.config);
    if (MESSAGES[r]) {
      socket.emit('comms:presets', Object.entries(MESSAGES[r]).map(([code, text]) => ({ code, text })));
    }
    if (r === 'instructor' && !session.isRunning) {
      session.reports.forEach((rep) => socket.emit('evaluation:report', rep));
    }
  });

  socket.on('instructor:start', () => {
    const { sessionId, role } = socket.data;
    if (!sessionId) return;
    if (role !== 'instructor') {
      socket.emit('session:error', { message: 'Only the instructor can start the exercise.' });
      return;
    }
    startSimulation(sessionId);
  });

  socket.on('instructor:end', () => {
    const { sessionId, role } = socket.data;
    if (!sessionId || role !== 'instructor') return;
    finishScenario(sessionId, 'ENDED BY INSTRUCTOR');
  });

  socket.on('instructor:pause', () => {
    const { sessionId, role } = socket.data;
    if (!sessionId || role !== 'instructor') return;
    const s = getSession(sessionId);
    if (!s.isRunning) return;
    s.paused = !s.paused;
    console.log(`[T+${s.clock}s] ${s.paused ? '⏸ PAUSED' : '▶ RESUMED'}`);
    broadcastState(sessionId);
    if (!s.paused) maybeAdvance(sessionId);
  });

  socket.on('instructor:inject', ({ injectId } = {}) => {
    const { sessionId, role } = socket.data;
    if (!sessionId || role !== 'instructor') return;
    const s = getSession(sessionId);
    const fail = (message) => socket.emit('session:error', { message });
    if (!s.isRunning) return fail('The exercise is not running.');
    const inj = (scn(s).instructor_injects || []).find((i) => i.inject_id === injectId);
    if (!inj) return fail('Unknown inject.');
    if (s.usedInjects.has(injectId)) return fail('That inject was already sent.');
    s.usedInjects.add(injectId);
    injectIntel(sessionId, inj);
  });

  socket.on('instructor:get_report', () => {
    const { sessionId, role } = socket.data;
    if (!sessionId || role !== 'instructor') return;
    const session = getSession(sessionId);
    if (session.reports.length) session.reports.forEach((rep) => socket.emit('evaluation:report', rep));
    else socket.emit('session:error', { message: 'No evaluation available yet. End or finish an exercise first.' });
  });

  socket.on('instructor:set_condition', (cfg = {}) => {
    const { sessionId, role } = socket.data;
    if (!sessionId || role !== 'instructor') return;

    const s = getSession(sessionId);
    const c = s.config;
    const num = (v, f) => (Number.isFinite(v) ? v : f);
    const clamp01 = (v, f) => Math.min(1, Math.max(0, num(v, f)));
    const jam = cfg.jam || {};
    const latencyBase =
      cfg.latencySeconds === undefined ? c.latencyBase : Math.max(0, num(cfg.latencySeconds, 0)) * 1000;

    s.config = {
      jam: { commander: clamp01(jam.commander, c.jam.commander), unit: clamp01(jam.unit, c.jam.unit) },
      latencyBase,
      jitterMs: latencyBase * 0.25,
      dropRate: clamp01(cfg.dropRate, c.dropRate),
      audioOnly: cfg.audioOnly === undefined ? c.audioOnly : Boolean(cfg.audioOnly),
    };

    const pct = (v) => Math.round(v * 100);
    if (s.isRunning) {
      record(s, {
        type: 'condition',
        role: 'instructor',
        summary: `jam TL ${pct(s.config.jam.commander)}% / INFO ${pct(s.config.jam.unit)}%, delay ${Math.round(
          latencyBase / 1000
        )}s, loss ${pct(s.config.dropRate)}%${s.config.audioOnly ? ', voice-only' : ''}`,
      });
    }
    io.to(roomFor(sessionId, 'instructor')).emit('conditions:update', s.config);
  });

  socket.on('unit:move', ({ entityId, lat, lng } = {}) => {
    const { sessionId, role } = socket.data;
    if (!sessionId || role !== 'unit' || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const session = getSession(sessionId);
    const id = entityId || 'unit-1';
    session.entities[id] = { lat, lng, kind: 'friendly', label: 'UNIT-1' };
    deliver(sessionId, ['commander'], 'map:update', { entityId: id, ...session.entities[id] });
  });

  // The specialist forwards what they heard to the team lead. It crosses the team lead's own (possibly jammed) link.
  socket.on('intel:relay', ({ reportId } = {}) => {
    const { sessionId, role } = socket.data;
    if (!sessionId) return;
    const session = getSession(sessionId);

    const fail = (message) => socket.emit('session:error', { message });
    if (role !== 'unit') return fail('Only the information terminal can relay intel.');
    if (!session.isRunning) return fail('The exercise is not running.');

    const item = session.inbox.unit.find((i) => i.id === reportId);
    if (!item) return fail('Unknown report.');
    const hasClear = session.inbox.commander.some(
      (i) => i.id === reportId && describeMessage(i.msg).clarity > 0.99
    );
    if (session.relayed.has(reportId) || hasClear) return fail('Team lead already has a clear copy of this report.');

    session.relayed.add(reportId);
    record(session, {
      type: 'relay',
      role: 'unit',
      source: item.base.source,
      source_id: item.base.source_id,
      injected: Boolean(item.base.injected),
    });
    console.log(`[T+${session.clock}s] ⇢ RELAY: ${item.base.source_id} -> commander`);

    deliver(sessionId, ['commander'], 'intel:receive', item.base, {
      intel: {
        source_id: item.base.source_id,
        source: item.base.source,
        status: item.base.data.status,
        relayed: true,
        injected: Boolean(item.base.injected),
      },
      msg: item.msg,
      seedKey: `${reportId}|relay`,
      extra: { relayed: true, relayedBy: ROLE_LABEL.unit, relayedAt: session.clock },
    });
    socket.emit('intel:relayed', { reportId });
  });

  // "Say again": the team lead asks for another transmission of a report that arrived garbled.
  socket.on('intel:repeat', ({ reportId } = {}) => {
    const { sessionId, role } = socket.data;
    if (!sessionId) return;
    const session = getSession(sessionId);
    const fail = (message) => socket.emit('session:error', { message });

    if (role !== 'commander') return fail('Only the team lead can ask for a repeat.');
    if (!session.isRunning) return fail('The exercise is not running.');

    const copies = session.inbox.commander.filter((i) => i.id === reportId);
    if (!copies.length) return fail('Unknown report.');
    if (copies.some((i) => describeMessage(i.msg).clarity > 0.99)) return fail('That message was received clearly.');
    if (session.clock - (session.repeatAt[reportId] ?? -99) < 8) return fail('Wait a few seconds before asking again.');

    const n = (session.repeats[reportId] || 0) + 1;
    session.repeats[reportId] = n;
    session.repeatAt[reportId] = session.clock;

    const first = copies[0];
    record(session, { type: 'repeat', role: 'commander', source: first.base.source, source_id: first.base.source_id });
    deliver(sessionId, ['commander'], 'intel:receive', first.base, {
      intel: {
        source_id: first.base.source_id,
        source: first.base.source,
        status: first.base.data.status,
        relayed: Boolean(first.report.relayed),
        repeat: n,
        injected: Boolean(first.base.injected),
      },
      msg: first.origin,
      seedKey: `${reportId}|repeat${n}`,
      extra: {
        repeat: n,
        relayed: first.report.relayed,
        relayedBy: first.report.relayedBy,
        relayedAt: first.report.relayedAt,
      },
    });
  });

  // Team Lead <-> Information radio. Only preset messages, sent to the other trainee over their link.
  socket.on('comms:send', ({ code } = {}) => {
    const { sessionId, role } = socket.data;
    if (!sessionId || !MESSAGES[role]) return;
    const session = getSession(sessionId);
    const fail = (message) => socket.emit('session:error', { message });

    if (!session.isRunning) return fail('The exercise is not running.');
    const text = MESSAGES[role][code];
    if (!text) return fail('Unknown message.');
    if (session.clock - (session.msgAt[role] ?? -99) < 3) return fail('Wait a moment before sending another message.');
    session.msgAt[role] = session.clock;

    const to = role === 'commander' ? 'unit' : 'commander';
    const payload = {
      id: `msg-${++session.msgSeq}`,
      from: role,
      fromLabel: ROLE_LABEL[role],
      to,
      toLabel: ROLE_LABEL[to],
      code,
      text,
      at: session.clock,
    };
    record(session, { type: 'message', role, to, text });
    console.log(`[T+${session.clock}s] 📻 ${ROLE_LABEL[role]} -> ${ROLE_LABEL[to]}: ${text}`);
    deliver(sessionId, [to], 'comms:message', payload);
    socket.emit('comms:sent', payload);
  });

  socket.on('decision:submit', ({ decisionId, optionId } = {}) => {
    const { sessionId, role } = socket.data;
    if (!sessionId) return;
    const session = getSession(sessionId);
    const fail = (message) => socket.emit('session:error', { message });

    const dp = scn(session).decision_points.find((d) => d.decision_point_id === decisionId);
    const option = dp && (dp.options || []).find((o) => o.option_id === optionId);

    if (!dp || !option) return fail('Unknown decision or option.');
    if (!(dp.allowed_roles || []).map(normalizeRole).includes(role)) return fail('Your role cannot answer this decision.');
    if (!session.isRunning || session.clock < dp.trigger_time_seconds) return fail('This decision is not open.');
    if (session.closed.has(decisionId)) return fail('This decision is already closed.');

    const rec = { decisionId, optionId, label: option.label, role, t: session.clock };
    session.decisions.push(rec);
    session.closed.add(decisionId);
    record(session, { type: 'decision', role, label: option.label, decisionId });
    console.log(`[T+${session.clock}s] ✅ DECISION: ${role} chose ${optionId} (${decisionId})`);

    socket.emit('decision:ack', { ...rec, responseSeconds: session.clock - dp.trigger_time_seconds });
    io.to(roomFor(sessionId, 'instructor')).emit('decision:made', rec);

    // Queue the consequence of this order, then wrap up once it has played out.
    scheduleOutcome(session, decisionId, optionId);
    maybeAdvance(sessionId);
  });

  socket.on('disconnect', () => {
    console.log(`[-] socket ${socket.id} disconnected (${socket.data.role || 'no role'})`);
  });
});

server.listen(PORT, () => console.log(`🚀 DSSC Scenario Engine listening on port ${PORT}`));