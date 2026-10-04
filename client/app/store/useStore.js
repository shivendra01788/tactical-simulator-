import { create } from 'zustand';
import { io } from 'socket.io-client';
import { initRadio, playTransmission, setMuted } from './radio';

let condTimer = null;

const applyTracks = (entities, tracks = []) => {
  const next = { ...entities };
  tracks.forEach((t) => {
    next[t.entity_id] = { lat: t.lat, lng: t.lng, kind: t.kind, label: t.label };
  });
  return next;
};

export const useStore = create((set, get) => ({
  socket: null,
  role: null,
  sessionId: 'alpha-1',
  isConnected: false,
  connecting: false,
  connectionError: null,
  notice: null, // { text, tone: 'info' | 'intel' | 'ok' | 'critical' }
  entities: {},
  intelFeed: [],
  relayedIds: {},
  decisionLog: [],
  activeDecision: null,
  scenarioRunning: false,
  scenarioComplete: false,
  scenarioPaused: false,
  injects: [], // live injects the instructor can send in the current scenario
  usedInjects: {},
  scenarioIndex: 0, // which scenario of the sequence is active (0-based)
  scenarioCount: 1,
  scenarioTitle: '',
  simClock: 0,
  evaluation: null, // most recent report
  evaluations: [], // one report per scenario played so far
  showEvaluation: false,
  muted: false,
  outcomes: [], // consequences of the Team Lead's order
  commsPresets: [], // radio messages this role may send
  commsLog: [], // radio messages between Team Lead and Information
  linkLog: [], // instructor only: what each link actually delivered
  conditions: { jam: { commander: 0, unit: 0 }, latencyBase: 0, dropRate: 0, audioOnly: false },

  flash: (text, tone = 'info') => {
    const notice = { text, tone };
    set({ notice });
    setTimeout(() => {
      if (get().notice === notice) set({ notice: null });
    }, 6000);
  },

  connect: (role) => {
    if (get().socket) return;
    initRadio(); // needs this click to unlock browser audio

    const url = process.env.NEXT_PUBLIC_SOCKET_URL || `http://${window.location.hostname}:4000`;
    set({ connecting: true, connectionError: null });
    const socket = io(url);

    socket.on('connect', () => {
      set({ connectionError: null, notice: null });
      socket.emit('session:join', { sessionId: get().sessionId || 'alpha-1', role });
    });

    socket.on('connect_error', (err) => {
      socket.close();
      set({
        socket: null,
        connecting: false,
        connectionError: `Cannot reach backend at ${url} (${err.message})`,
      });
    });

    socket.on('disconnect', () => get().flash('Connection lost - reconnecting...', 'critical'));

    socket.on('session:joined', (data) => {
      set({ isConnected: true, connecting: false, role: data.role });
    });

    socket.on('session:error', (e) => get().flash(e.message, 'critical'));

    socket.on('scenario:state', ({ isRunning, paused = false, injects = [], clock, scenarioIndex = 0, scenarioCount = 1, scenarioTitle = '' }) => {
      set(() => {
        const meta = { scenarioIndex, scenarioCount, scenarioTitle, scenarioPaused: paused, injects };
        if (isRunning && clock === 0) {
          // A scenario just started: clear the per-scenario screen state.
          // Past evaluations are only wiped when a brand-new sequence begins (scenario 1).
          return {
            ...meta,
            scenarioRunning: true,
            scenarioComplete: false,
            simClock: 0,
            intelFeed: [],
            relayedIds: {},
            decisionLog: [],
            activeDecision: null,
            entities: {},
            linkLog: [],
            outcomes: [],
            commsLog: [],
            usedInjects: {},
            showEvaluation: false,
            ...(scenarioIndex === 0 ? { evaluation: null, evaluations: [] } : {}),
          };
        }
        return { ...meta, scenarioRunning: isRunning, simClock: clock };
      });
    });

    socket.on('intel:receive', (report) => {
      set((s) => ({
        intelFeed: [...s.intelFeed, report],
        entities: applyTracks(s.entities, report.tracks),
      }));
      const { role: me, flash } = get();
      if (me !== 'instructor') {
        const pct = Math.round((report.clarity ?? 1) * 100);
        const weak = pct < 100 ? ` - ${pct}% READABLE` : '';
        flash(`${report.relayed ? 'RELAYED' : 'INCOMING'} TRANSMISSION: ${report.source}${weak}`, 'intel');
        playTransmission(report);
      }
    });

    socket.on('intel:relayed', ({ reportId }) => {
      set((s) => ({ relayedIds: { ...s.relayedIds, [reportId]: true } }));
      get().flash('Report relayed to Team Lead', 'ok');
    });

    socket.on('decision:trigger', (dp) => {
      set({ activeDecision: dp });
      if (get().role === 'commander') get().flash('DECISION REQUIRED - see order panel', 'critical');
    });

    socket.on('decision:ack', (rec) => {
      set((s) => ({ activeDecision: null, decisionLog: [...s.decisionLog, rec] }));
      get().flash(`DECISION RECORDED: ${rec.label} (T+${rec.t}s)`, 'ok');
    });

    socket.on('decision:made', (rec) => {
      set((s) => ({ decisionLog: [...s.decisionLog, rec] }));
    });

    socket.on('decision:expired', (rec) => {
      set((s) => ({
        activeDecision:
          s.activeDecision && s.activeDecision.decision_point_id === rec.decisionId ? null : s.activeDecision,
        decisionLog: [...s.decisionLog, rec],
      }));
      get().flash('Decision window closed - no order issued', 'critical');
    });

    socket.on('map:update', (d) => {
      set((s) => ({
        entities: { ...s.entities, [d.entityId]: { lat: d.lat, lng: d.lng, kind: d.kind, label: d.label } },
      }));
    });

    socket.on('clock:tick', (tick) => set({ simClock: tick }));

    socket.on('conditions:update', (c) => set({ conditions: c }));

    socket.on('link:delivery', (d) => set((s) => ({ linkLog: [...s.linkLog, d] })));

    socket.on('link:dropped', (d) => set((s) => ({ linkLog: [...s.linkLog, { ...d, dropped: true }] })));

    // What happened as a result of the Team Lead's order (or lack of one).
    socket.on('outcome:report', (o) => {
      set((s) => ({ outcomes: [...s.outcomes, o], entities: applyTracks(s.entities, o.tracks) }));
      const tone = o.tone === 'success' ? 'ok' : o.tone === 'failure' ? 'critical' : 'info';
      get().flash(`OUTCOME: ${o.title}`, tone);
    });

    // Team Lead <-> Information radio channel.
    socket.on('comms:presets', (list) => set({ commsPresets: list }));

    socket.on('comms:message', (m) => {
      const me = get().role;
      set((s) => ({ commsLog: [...s.commsLog, { ...m, dir: me === 'instructor' ? 'obs' : 'in' }] }));
      if (me !== 'instructor') {
        get().flash(`${m.fromLabel}: ${m.text}`, 'intel');
        playTransmission({ clarity: 1, segments: [m.text] });
      }
    });

    socket.on('comms:sent', (m) => set((s) => ({ commsLog: [...s.commsLog, { ...m, dir: 'out' }] })));

    // One report arrives per finished scenario. The review window only opens on the last one.
    socket.on('evaluation:report', (report) => {
      set((s) => {
        const rest = s.evaluations.filter((e) => e.scenarioId !== report.scenarioId);
        const evaluations = [...rest, report].sort((a, b) => a.scenarioIndex - b.scenarioIndex);
        return {
          evaluations,
          evaluation: report,
          showEvaluation: report.final ? true : s.showEvaluation,
        };
      });
    });

    // The current scenario is finished and another one is about to start.
    socket.on('scenario:next', ({ nextIndex, scenarioCount, inSeconds }) => {
      set({ activeDecision: null });
      get().flash(
        `SCENARIO ${nextIndex} COMPLETE - SCENARIO ${nextIndex + 1}/${scenarioCount} STARTING IN ${inSeconds}s`,
        'info'
      );
    });

    // The whole sequence is finished (or the instructor ended it).
    socket.on('scenario:complete', () => {
      set({ scenarioComplete: true, activeDecision: null });
      if (get().role !== 'instructor') get().flash('EXERCISE COMPLETE - await instructor debrief', 'info');
    });

    set({ socket });
  },

  startScenario: () => {
    const { socket, isConnected, flash } = get();
    if (!socket || !isConnected) return flash('Not connected to backend.', 'critical');
    socket.emit('instructor:start');
  },

  endScenario: () => {
    const { socket } = get();
    if (socket) socket.emit('instructor:end');
  },

  openEvaluation: () => {
    const { socket, evaluations } = get();
    if (evaluations.length) set({ showEvaluation: true });
    else if (socket) socket.emit('instructor:get_report');
  },

  closeEvaluation: () => set({ showEvaluation: false }),

  relayIntel: (reportId) => {
    const { socket } = get();
    if (socket) socket.emit('intel:relay', { reportId });
  },

  toggleMute: () => {
    const m = !get().muted;
    setMuted(m);
    set({ muted: m });
  },

  requestRepeat: (reportId) => {
    const { socket } = get();
    if (socket) socket.emit('intel:repeat', { reportId });
  },

  // Instructor: change the RF environment. Sliders update instantly; the server is told 400ms after the last change.
  setConditions: (patch) => {
    const cur = get().conditions;
    set({ conditions: { ...cur, ...patch, jam: { ...cur.jam, ...(patch.jam || {}) } } });
    clearTimeout(condTimer);
    condTimer = setTimeout(() => {
      const { socket, conditions: c } = get();
      if (socket) {
        socket.emit('instructor:set_condition', {
          jam: c.jam,
          latencySeconds: c.latencyBase / 1000,
          dropRate: c.dropRate,
          audioOnly: c.audioOnly,
        });
      }
    }, 400);
  },

  // Each exercise has its own session ID, so several groups can train on one server at the same time.
  setSessionId: (value) =>
    set({ sessionId: String(value).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) }),

  togglePause: () => {
    const { socket } = get();
    if (socket) socket.emit('instructor:pause');
  },

  injectIntel: (injectId) => {
    const { socket } = get();
    if (!socket) return;
    socket.emit('instructor:inject', { injectId });
    set((s) => ({ usedInjects: { ...s.usedInjects, [injectId]: true } }));
  },

  sendComms: (code) => {
    const { socket } = get();
    if (socket) socket.emit('comms:send', { code });
  },

  submitDecision: (optionId) => {
    const { socket, activeDecision } = get();
    if (!socket || !activeDecision) return;
    socket.emit('decision:submit', { decisionId: activeDecision.decision_point_id, optionId });
  },

  moveUnit: (lat, lng) => {
    const { socket, role } = get();
    if (!socket || role !== 'unit') return;
    socket.emit('unit:move', { entityId: 'unit-1', lat, lng });
    set((s) => ({
      entities: { ...s.entities, 'unit-1': { lat, lng, kind: 'friendly', label: 'UNIT-1' } },
    }));
  },
}));