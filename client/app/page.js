'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './store/useStore'; // must match the real filename casing exactly
import { playTransmission } from './store/radio';

const TacticalMap = dynamic(() => import('../components/Map'), { ssr: false });

// True on phone-sized screens, so the layout can switch to tabs.
function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return mobile;
}

function SysClock() {
  const [time, setTime] = useState('00:00:00Z');
  useEffect(() => {
    const tick = () => setTime(new Date().toISOString().substring(11, 19) + 'Z');
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return <span>SYS_T: {time}</span>;
}

function ExerciseStatus() {
  const running = useStore((s) => s.scenarioRunning);
  const complete = useStore((s) => s.scenarioComplete);
  const clock = useStore((s) => s.simClock);
  const index = useStore((s) => s.scenarioIndex);
  const count = useStore((s) => s.scenarioCount);
  const paused = useStore((s) => s.scenarioPaused);
  const label = running
    ? `EXERCISE ${paused ? 'PAUSED' : 'RUNNING'} T+${clock}s`
    : complete
    ? 'EXERCISE COMPLETE'
    : 'STANDBY';
  const prefix = count > 1 && (running || complete) ? `SCENARIO ${index + 1}/${count} // ` : '';
  return <span className="font-bold tracking-wide md:tracking-widest text-white">{prefix + label}</span>;
}

function RecordingBadge() {
  const running = useStore((s) => s.scenarioRunning);
  if (!running) return <span className="text-green-800">AAR IDLE</span>;
  return <span className="animate-pulse text-red-500">RECORDING AAR</span>;
}

function InstructorControls() {
  const running = useStore((s) => s.scenarioRunning);
  const hasReport = useStore((s) => s.evaluations.length > 0);
  const complete = useStore((s) => s.scenarioComplete);
  const start = useStore((s) => s.startScenario);
  const end = useStore((s) => s.endScenario);
  const open = useStore((s) => s.openEvaluation);
  const paused = useStore((s) => s.scenarioPaused);
  const togglePause = useStore((s) => s.togglePause);

  if (running) {
    return (
      <div className="flex gap-3">
        <button
          onClick={togglePause}
          className={`border px-4 py-1 font-bold ${
            paused
              ? 'bg-amber-600 text-black border-amber-600 animate-pulse hover:bg-amber-500'
              : 'border-amber-600 text-amber-500 hover:bg-amber-900/30'
          }`}
        >
          {paused ? '▶ RESUME' : '❚❚ PAUSE'}
        </button>
        <button onClick={end} className="border border-red-600 text-red-500 px-4 py-1 font-bold hover:bg-red-900/30">
          ■ END &amp; EVALUATE
        </button>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <button onClick={start} className="bg-amber-600 text-black px-4 py-1 font-bold animate-pulse hover:bg-amber-500">
        ▶ START EXERCISE
      </button>
      {(hasReport || complete) && (
        <button onClick={open} className="border border-amber-600 text-amber-500 px-4 py-1 font-bold hover:bg-amber-900/30">
          VIEW AAR
        </button>
      )}
    </div>
  );
}

const TONES = {
  info: 'border-amber-600 text-amber-500',
  intel: 'border-green-500 text-green-400',
  ok: 'border-green-400 bg-green-950 text-green-300',
  critical: 'border-red-600 text-red-400 animate-pulse',
};

function Notice() {
  const notice = useStore((s) => s.notice);
  if (!notice) return null;
  return (
    <div
      className={`absolute top-2 left-1/2 -translate-x-1/2 z-[1100] w-max max-w-[92%] text-center border bg-black px-4 py-2 text-xs tracking-widest ${
        TONES[notice.tone] || TONES.info
      }`}
    >
      {notice.text}
    </div>
  );
}

function MuteButton() {
  const role = useStore((s) => s.role);
  const muted = useStore((s) => s.muted);
  const toggle = useStore((s) => s.toggleMute);
  if (role === 'instructor') return null;
  return (
    <button onClick={toggle} className="border border-green-800 px-2 py-0.5 hover:bg-green-900/30">
      {muted ? 'RADIO: MUTED' : 'RADIO: ON'}
    </button>
  );
}

function Slider({ label, value, min, max, step, unit, onChange }) {
  return (
    <label className="block text-[10px] text-green-600 tracking-widest">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="text-amber-500">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-amber-500"
      />
    </label>
  );
}

// Instructor only: degrade the radio environment while the exercise runs.
function ConditionsPanel() {
  const c = useStore((s) => s.conditions);
  const set = useStore((s) => s.setConditions);
  const linkLog = useStore((s) => s.linkLog);
  const preset = (cmd, unit) => set({ jam: { commander: cmd, unit } });

  return (
    <div className="border border-amber-900 bg-amber-950/10 p-3 flex flex-col gap-3">
      <div className="text-[10px] text-amber-500 tracking-widest">RF ENVIRONMENT CONTROL</div>
      <div className="flex gap-2 text-[10px]">
        <button onClick={() => preset(0, 0)} className="flex-1 border border-green-700 py-1 hover:bg-green-900/30">
          CLEAR
        </button>
        <button onClick={() => preset(0.5, 0)} className="flex-1 border border-amber-600 text-amber-500 py-1 hover:bg-amber-900/30">
          DEGRADED
        </button>
        <button onClick={() => preset(0.8, 0.3)} className="flex-1 border border-red-600 text-red-500 py-1 hover:bg-red-900/30">
          HEAVY JAM
        </button>
      </div>
      <Slider label="TEAM LEAD LINK JAM" value={Math.round(c.jam.commander * 100)} min={0} max={100} step={5} unit="%" onChange={(v) => set({ jam: { commander: v / 100 } })} />
      <Slider label="INFO LINK JAM" value={Math.round(c.jam.unit * 100)} min={0} max={100} step={5} unit="%" onChange={(v) => set({ jam: { unit: v / 100 } })} />
      <Slider label="DELAY" value={Math.round(c.latencyBase / 1000)} min={0} max={20} step={1} unit="s" onChange={(v) => set({ latencyBase: v * 1000 })} />
      <Slider label="PACKET LOSS" value={Math.round(c.dropRate * 100)} min={0} max={50} step={5} unit="%" onChange={(v) => set({ dropRate: v / 100 })} />
      <label className="flex items-center gap-2 text-[10px] text-green-600 tracking-widest">
        <input type="checkbox" checked={c.audioOnly} onChange={(e) => set({ audioOnly: e.target.checked })} />
        VOICE ONLY (HIDE TEXT FROM TRAINEES)
      </label>

      {linkLog.length > 0 && (
        <div className="border-t border-amber-900 pt-2 text-[10px] flex flex-col gap-1">
          <div className="text-green-700 tracking-widest">LINK LOG (WHAT TRAINEES RECEIVED)</div>
          {linkLog.slice(-6).reverse().map((l, i) => (
            <div key={i} className={l.dropped ? 'text-red-400' : 'text-green-500'}>
              T+{l.at}s {l.role.toUpperCase()} {l.dropped ? 'LOST' : `${Math.round(l.clarity * 100)}%: ${l.text}`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Instructor only: push an extra report into the running scenario.
function InjectPanel() {
  const injects = useStore((s) => s.injects);
  const used = useStore((s) => s.usedInjects);
  const running = useStore((s) => s.scenarioRunning);
  const paused = useStore((s) => s.scenarioPaused);
  const inject = useStore((s) => s.injectIntel);
  if (!injects.length) return null;

  return (
    <div className="border border-amber-900 bg-amber-950/10 p-3 flex flex-col gap-2">
      <div className="text-[10px] text-amber-500 tracking-widest">LIVE INJECTS</div>
      {injects.map((i) => (
        <button
          key={i.id}
          disabled={!running || paused || used[i.id]}
          onClick={() => inject(i.id)}
          className="border border-amber-600 text-amber-500 py-1 px-2 text-left text-[11px] hover:bg-amber-900/30 disabled:opacity-40"
        >
          {used[i.id] ? 'SENT: ' : ''}
          {i.label}
        </button>
      ))}
    </div>
  );
}

const OUTCOME_TONES = {
  success: 'border-green-500 bg-green-950/30 text-green-300',
  warning: 'border-amber-500 bg-amber-950/30 text-amber-300',
  failure: 'border-red-600 bg-red-950/30 text-red-300',
};

// Short radio channel between the Team Lead and the Information terminal. The instructor sees all traffic.
function CommsPanel() {
  const role = useStore((s) => s.role);
  const presets = useStore((s) => s.commsPresets);
  const log = useStore((s) => s.commsLog);
  const send = useStore((s) => s.sendComms);
  const running = useStore((s) => s.scenarioRunning);
  const isInstructor = role === 'instructor';

  if (isInstructor && log.length === 0) return null;
  const peer = role === 'commander' ? 'INFORMATION' : 'TEAM LEAD';
  const who = (m) =>
    m.dir === 'out' ? `YOU -> ${m.toLabel}` : m.dir === 'obs' ? `${m.fromLabel} -> ${m.toLabel}` : m.fromLabel;

  return (
    <div className="border border-cyan-900 bg-cyan-950/10 p-3 flex flex-col gap-2">
      <div className="text-[10px] text-cyan-500 tracking-widest">
        {isInstructor ? 'RADIO TRAFFIC (TEAM LEAD / INFORMATION)' : `RADIO CHANNEL TO ${peer}`}
      </div>
      {!isInstructor &&
        presets.map((p) => (
          <button
            key={p.code}
            disabled={!running}
            onClick={() => send(p.code)}
            className="border border-cyan-700 text-cyan-400 py-1 px-2 text-left text-[11px] hover:bg-cyan-900/30 disabled:opacity-40"
          >
            {p.text}
          </button>
        ))}
      {log.length > 0 && (
        <div className="border-t border-cyan-900 pt-2 text-[10px] flex flex-col gap-1">
          {log.slice(-6).map((m) => (
            <div key={`${m.id}-${m.dir}`} className={m.dir === 'out' ? 'text-green-500' : 'text-cyan-300'}>
              T+{m.at}s {who(m)}: {m.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IntelFeed({ show = 'all' }) {
  const showTools = show !== 'feed';
  const showFeed = show !== 'tools';
  const intelFeed = useStore((s) => s.intelFeed);
  const decisionLog = useStore((s) => s.decisionLog);
  const relayedIds = useStore((s) => s.relayedIds);
  const relayIntel = useStore((s) => s.relayIntel);
  const requestRepeat = useStore((s) => s.requestRepeat);
  const outcomes = useStore((s) => s.outcomes);
  const role = useStore((s) => s.role);

  // Scroll to the newest report whenever one arrives (older ones stay scrollable).
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [intelFeed.length, outcomes.length]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 md:flex-none w-full md:w-96 md:shrink-0 min-h-0 h-full md:border-r border-green-900 bg-black/90 p-3 md:p-4 flex flex-col gap-4 overflow-y-auto"
    >
      {showTools && (
        <>
          {role === 'instructor' && <ConditionsPanel />}
          {role === 'instructor' && <InjectPanel />}
          <CommsPanel />
        </>
      )}
      {showFeed && (
        <>
      <h2 className="text-[10px] text-green-700 tracking-widest border-b border-green-900 pb-2">
        {role === 'instructor' ? 'ALL INTEL (INSTRUCTOR VIEW)' : 'ACTIVE INTELLIGENCE FEED'}
      </h2>

      {intelFeed.length === 0 ? (
        <div className="text-xs text-green-800 italic mt-4 text-center">Awaiting sensor telemetry...</div>
      ) : (
        intelFeed.map((report, idx) => {
          const isNewest = idx === intelFeed.length - 1;
          const canRelay = role === 'unit' && !report.relayed;
          const voiceHidden = report.voiceOnly && role !== 'instructor';
          return (
            <div
              key={idx}
              className={`border p-3 text-xs ${
                isNewest ? 'border-amber-500 bg-amber-950/20' : 'border-green-900 bg-green-950/20'
              }`}
            >
              <div className="flex justify-between text-[10px] text-amber-500 mb-2">
                <span>
                  {report.source}
                  {isNewest && <span className="ml-2 bg-amber-500 text-black px-1 font-bold">NEW</span>}
                </span>
                <span>T+{report.timestamp}s</span>
              </div>
              {report.clarity < 0.999 && (
                <div className="text-[10px] text-red-400 mb-1">
                  SIGNAL {Math.round(report.clarity * 100)}% READABLE
                  {report.repeat ? ` // REPEAT #${report.repeat}` : ''}
                </div>
              )}
              {voiceHidden ? (
                <div className="text-cyan-400 italic">VOICE TRANSMISSION - press LISTEN</div>
              ) : (
                <>
                  <div className="font-bold text-white mb-1">[{report.data.status}]</div>
                  <div className="text-green-400">{report.data.summary || report.data.observation}</div>
                </>
              )}
              {role !== 'instructor' && (
                <div className="mt-3 flex gap-2">
                  <button onClick={() => playTransmission(report)} className="flex-1 border border-green-700 py-1 tracking-widest hover:bg-green-900/30">
                    LISTEN
                  </button>
                  {role === 'commander' && report.clarity < 0.999 && (
                    <button onClick={() => requestRepeat(report.id)} className="flex-1 border border-amber-600 text-amber-500 py-1 tracking-widest hover:bg-amber-900/30">
                      SAY AGAIN
                    </button>
                  )}
                </div>
              )}

              {report.relayed && (
                <div className="mt-2 text-[10px] text-cyan-400">
                  RELAYED BY {report.relayedBy} AT T+{report.relayedAt}s
                </div>
              )}
              {canRelay && !relayedIds[report.id] && (
                <button
                  onClick={() => relayIntel(report.id)}
                  className="mt-3 w-full border border-cyan-600 text-cyan-400 py-1 tracking-widest hover:bg-cyan-900/30"
                >
                  RELAY TO TEAM LEAD
                </button>
              )}
              {canRelay && relayedIds[report.id] && (
                <div className="mt-2 text-[10px] text-green-500">RELAYED TO TEAM LEAD</div>
              )}
            </div>
          );
        })
      )}

      {outcomes.length > 0 && (
        <>
          <h2 className="text-[10px] text-amber-600 tracking-widest border-b border-green-900 pb-2 mt-2">OUTCOME</h2>
          {outcomes.map((o, idx) => (
            <div key={idx} className={`border p-3 text-xs ${OUTCOME_TONES[o.tone] || OUTCOME_TONES.warning}`}>
              <div className="text-[10px] mb-1">T+{o.timestamp}s</div>
              <div className="font-bold text-white mb-1">{o.title}</div>
              <div>{o.message}</div>
            </div>
          ))}
        </>
      )}

      {(role === 'commander' || role === 'instructor') && decisionLog.length > 0 && (
        <>
          <h2 className="text-[10px] text-amber-600 tracking-widest border-b border-green-900 pb-2 mt-2">
            ORDERS ISSUED
          </h2>
          {decisionLog.map((d, idx) => (
            <div key={idx} className="border border-amber-900 bg-amber-950/20 p-3 text-xs">
              <div className="text-[10px] text-amber-500 mb-1">
                T+{d.t}s // {String(d.role || '').toUpperCase()}
              </div>
              <div className={d.timedOut ? 'text-red-400' : 'text-white'}>{d.label}</div>
            </div>
          ))}
        </>
      )}
        </>
      )}
    </div>
  );
}

// Docked panel (not a blocking modal) so the commander can still read the feed and map while deciding.
function DecisionPanel() {
  const role = useStore((s) => s.role);
  const dp = useStore((s) => s.activeDecision);
  const clock = useStore((s) => s.simClock);
  const submitDecision = useStore((s) => s.submitDecision);
  const [open, setOpen] = useState(true);
  const dpId = dp ? dp.decision_point_id : null;
  useEffect(() => {
    setOpen(true); // a new decision always opens expanded
  }, [dpId]);

  if (!dp || role !== 'commander') return null;
  const remaining = dp.timeout_seconds
    ? Math.max(0, dp.trigger_time_seconds + dp.timeout_seconds - clock)
    : null;

  // Phones: the panel can be tucked away to a bar so the feed and map stay readable.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-2 left-2 right-2 md:hidden z-[1000] border-2 border-red-600 bg-black text-red-500 font-bold tracking-widest text-xs py-3 animate-pulse"
      >
        !! DECISION REQUIRED !! {remaining !== null && `${remaining}s LEFT `}- TAP TO OPEN
      </button>
    );
  }

  return (
    <div className="absolute inset-x-2 bottom-2 md:inset-x-auto md:bottom-4 md:right-4 z-[1000] md:w-[28rem] max-h-[calc(100%-1rem)] md:max-h-[calc(100%-2rem)] overflow-y-auto border-2 border-red-600 bg-black p-4 md:p-5 shadow-[0_0_40px_rgba(255,0,0,0.25)]">
      <div className="flex justify-between items-center text-red-500 font-bold tracking-widest text-xs mb-3">
        <span className="animate-pulse">!! DECISION REQUIRED !!</span>
        <span className="flex items-center gap-3">
          {remaining !== null && <span>{remaining}s LEFT</span>}
          <button onClick={() => setOpen(false)} className="md:hidden border border-red-600 px-3 py-1 text-[10px]">
            HIDE
          </button>
        </span>
      </div>
      <p className="text-white text-xs mb-4">{dp.prompt}</p>
      <div className="flex flex-col gap-2">
        {dp.options.map((opt) => (
          <button
            key={opt.option_id}
            onClick={() => submitDecision(opt.option_id)}
            className="border border-green-700 p-3 text-left hover:bg-green-900/40 transition-colors group"
          >
            <div className="font-bold text-amber-500 group-hover:text-amber-400 text-xs">{opt.label}</div>
            <div className="text-[11px] text-green-500 mt-1">{opt.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function EvaluationModal() {
  const evaluations = useStore((s) => s.evaluations);
  const show = useStore((s) => s.showEvaluation);
  const close = useStore((s) => s.closeEvaluation);
  const role = useStore((s) => s.role);
  const [selected, setSelected] = useState(null);

  if (!show || evaluations.length === 0 || role !== 'instructor') return null;

  const evaluation = evaluations.find((e) => e.scenarioId === selected) || evaluations[evaluations.length - 1];
  const { score } = evaluation;

  const seqTotal = evaluations.reduce((a, e) => a + e.score.total, 0);
  const seqMax = evaluations.reduce((a, e) => a + e.score.max, 0);
  const seqPercent = seqMax ? Math.round((seqTotal / seqMax) * 100) : 0;

  const download = () => {
    const data = evaluations.length > 1 ? evaluations : evaluation;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `aar-${evaluation.sessionId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="absolute inset-0 z-[1200] bg-black/95 overflow-y-auto p-2 md:p-6">
      <div className="max-w-3xl mx-auto border-2 border-amber-600 bg-black p-3 md:p-6 text-xs">
        <div className="flex flex-col md:flex-row md:justify-between items-start gap-3 mb-4">
          <div>
            <div className="text-amber-500 font-bold tracking-widest text-sm">AFTER ACTION REVIEW</div>
            <div className="text-green-700 mt-1">{evaluation.scenario}</div>
            <div className="text-green-800">
              Session {evaluation.sessionId} // {evaluation.durationSeconds}s // {evaluation.reason}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={download} className="border border-green-700 px-3 py-1 hover:bg-green-900/30">
              DOWNLOAD JSON
            </button>
            <button onClick={close} className="border border-amber-600 text-amber-500 px-3 py-1 hover:bg-amber-900/30">
              CLOSE
            </button>
          </div>
        </div>

        {evaluations.length > 1 && (
          <>
            <div className="flex gap-2 mb-3 flex-wrap">
              {evaluations.map((e) => (
                <button
                  key={e.scenarioId}
                  onClick={() => setSelected(e.scenarioId)}
                  className={`border px-3 py-1 tracking-widest ${
                    e.scenarioId === evaluation.scenarioId
                      ? 'border-amber-500 bg-amber-900/30 text-amber-400'
                      : 'border-green-800 text-green-600 hover:bg-green-900/30'
                  }`}
                >
                  SCENARIO {e.scenarioIndex} ({e.score.percent}%)
                </button>
              ))}
            </div>
            <div className="border border-green-900 p-3 mb-4 text-green-500">
              SEQUENCE TOTAL // {seqTotal}/{seqMax} pts ({seqPercent}%) across {evaluations.length} scenarios
            </div>
          </>
        )}

        <div className="border border-green-900 p-4 mb-4 flex items-center gap-6">
          <div className="text-4xl md:text-5xl font-bold text-white">{score.percent}%</div>
          <div>
            <div className="text-amber-500 font-bold tracking-widest">{score.grade}</div>
            <div className="text-green-600 mt-1">
              {score.total}/{score.max} pts: decision {score.decisionPoints}/{score.decisionMax}, information{' '}
              {score.infoPoints}/{score.infoMax}
            </div>
          </div>
        </div>

        {evaluation.comms && (
          <div className="border border-green-900 p-3 mb-4 text-green-500">
            COMMS // Team Lead average clarity {evaluation.comms.commanderAvgClarity ?? 'n/a'}% // repeat requests{' '}
            {evaluation.comms.repeatRequests} // relays {evaluation.comms.relays} // radio messages{' '}
            {evaluation.comms.messages ?? 0} // lost {evaluation.comms.dropped}
          </div>
        )}

        <h3 className="text-[10px] text-green-700 tracking-widest mb-2">DECISIONS</h3>
        {evaluation.decisions.map((d) => (
          <div key={d.decisionId} className="border border-green-900 p-3 mb-3">
            <div className="text-amber-500 mb-1">
              {d.decisionId} // opened T+{d.openedAt}s
            </div>
            <div className="text-white">{d.label || 'NO DECISION'}</div>
            <div className="text-green-600 mt-1">
              Rating: {d.rating} ({d.score}/100)
              {d.responseSeconds !== null && ` // response time ${d.responseSeconds}s`}
            </div>
            {d.feedback && <div className="text-green-400 mt-2">{d.feedback}</div>}
          </div>
        ))}

        <h3 className="text-[10px] text-green-700 tracking-widest mb-2 mt-4">INFORMATION USE</h3>
        {evaluation.checks.map((c) => (
          <div key={c.checkId} className="border border-green-900 p-3 mb-2 flex flex-col md:flex-row md:justify-between gap-1 md:gap-4">
            <span className={c.passed ? 'text-green-400' : 'text-red-400'}>
              {c.passed ? 'PASS' : 'FAIL'} - {c.description}
            </span>
            <span className="text-green-600 md:whitespace-nowrap">
              {c.passed ? `T+${c.receivedAt}s, ${c.via}, ${c.clarity}% clear, ` : `${c.note}, `}
              {c.points}/{c.maxPoints}
            </span>
          </div>
        ))}

        {evaluation.specialist && (
          <>
            <h3 className="text-[10px] text-green-700 tracking-widest mb-2 mt-4">INFORMATION TERMINAL (SPECIALIST)</h3>
            <div className="border border-green-900 p-3 mb-2 text-green-500">
              Relay score {evaluation.specialist.points}/{evaluation.specialist.max}
              {evaluation.specialist.percent !== null && ` (${evaluation.specialist.percent}%)`}
            </div>
            {evaluation.specialist.checks.map((c) => (
              <div key={c.checkId} className="border border-green-900 p-3 mb-2 flex flex-col md:flex-row md:justify-between gap-1 md:gap-4">
                <span className={c.passed ? 'text-green-400' : 'text-red-400'}>
                  {c.passed ? 'PASS' : 'FAIL'} - {c.description}
                </span>
                <span className="text-green-600 md:whitespace-nowrap">
                  {c.passed ? `relayed T+${c.relayedAt}s, ` : 'never relayed in time, '}
                  {c.points}/{c.maxPoints}
                </span>
              </div>
            ))}
            {evaluation.specialist.requests.map((r, i) => (
              <div key={i} className="border border-green-900 p-3 mb-2 text-green-500">
                {`Team Lead asked at T+${r.at}s: "${r.text}" - `}
                <span className={r.inTime ? 'text-green-400' : 'text-red-400'}>
                  {r.answered
                    ? `answered in ${r.responseSeconds}s${r.inTime ? '' : ` (over the ${evaluation.specialist.responseWindow}s window)`}`
                    : 'no answer'}
                </span>
              </div>
            ))}
          </>
        )}

        <h3 className="text-[10px] text-green-700 tracking-widest mb-2 mt-4">TIMELINE</h3>
        <div className="border border-green-900 p-3">
          {evaluation.timeline.map((e, i) => (
            <div key={i} className="flex gap-3 py-1">
              <span className="text-amber-500 w-14 shrink-0">T+{e.t}s</span>
              <span className="text-green-400">{e.text}</span>
            </div>
          ))}
        </div>

        {evaluation.objectives.length > 0 && (
          <>
            <h3 className="text-[10px] text-green-700 tracking-widest mb-2 mt-4">LEARNING OBJECTIVES</h3>
            <ul className="list-disc pl-5 text-green-500">
              {evaluation.objectives.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function Login() {
  const connect = useStore((s) => s.connect);
  const connecting = useStore((s) => s.connecting);
  const connectionError = useStore((s) => s.connectionError);
  const sessionId = useStore((s) => s.sessionId);
  const setSessionId = useStore((s) => s.setSessionId);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-green-500 font-mono p-4 selection:bg-green-900">
      <div className="w-full max-w-sm md:max-w-none md:w-auto border border-green-800 p-6 md:p-12 bg-green-950/10 shadow-[0_0_30px_rgba(0,255,0,0.1)]">
        <h1 className="text-2xl md:text-3xl font-bold mb-2 tracking-widest text-center">TACTICAL EXERCISE</h1>
        <p className="text-xs text-green-700 text-center mb-8 uppercase tracking-widest">
          {connecting ? 'Connecting to simulation core...' : 'Simulation Core Active'}
        </p>

        <label className="block w-full md:w-72 mb-4 text-[10px] text-green-700 tracking-widest">
          SESSION ID (SAME ON EVERY TERMINAL IN ONE EXERCISE)
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            disabled={connecting}
            maxLength={32}
            className="mt-1 w-full bg-black border border-green-800 px-3 py-2 text-sm text-green-400 tracking-widest outline-none focus:border-amber-600"
          />
        </label>

        <div className="flex flex-col gap-4 w-full md:w-72">
          <button
            disabled={connecting}
            onClick={() => connect('instructor')}
            className="border border-amber-600 text-amber-500 hover:bg-amber-900/30 px-4 py-3 text-sm tracking-widest transition-colors disabled:opacity-40"
          >
            LAUNCH INSTRUCTOR CONTROL
          </button>
          <button
            disabled={connecting}
            onClick={() => connect('commander')}
            className="border border-green-700 hover:bg-green-900/30 px-4 py-3 text-sm tracking-widest transition-colors disabled:opacity-40"
          >
            TEAM_LEAD TERMINAL
          </button>
          <button
            disabled={connecting}
            onClick={() => connect('unit')}
            className="border border-green-700 hover:bg-green-900/30 px-4 py-3 text-sm tracking-widest transition-colors disabled:opacity-40"
          >
            INFORMATION TERMINAL
          </button>
        </div>

        {connectionError && <p className="mt-6 text-xs text-red-500 text-center max-w-72">{connectionError}</p>}
      </div>
    </div>
  );
}

export default function Home() {
  const isConnected = useStore((s) => s.isConnected);
  const role = useStore((s) => s.role);
  const sessionId = useStore((s) => s.sessionId);
  const hasDecision = useStore((s) => Boolean(s.activeDecision));
  const intelCount = useStore((s) => s.intelFeed.length);
  const isMobile = useIsMobile();

  // Phones show one panel at a time: the feed, the map, or the radio/controls.
  const [tab, setTab] = useState('feed');
  const [seen, setSeen] = useState(0);

  // Count reports that arrived while the trainee was looking at another tab.
  useEffect(() => {
    setSeen((prev) => (tab === 'feed' || !isMobile ? intelCount : Math.min(prev, intelCount)));
  }, [tab, isMobile, intelCount]);

  // The map was hidden, so Leaflet needs a nudge to redraw when it comes back.
  useEffect(() => {
    if (tab !== 'map') return;
    const id = setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    return () => clearTimeout(id);
  }, [tab, isMobile]);

  if (!isConnected) return <Login />;

  const unseen = Math.max(0, intelCount - seen);
  const tabs = [
    ['feed', 'INTEL'],
    ['map', 'MAP'],
    ['tools', role === 'instructor' ? 'CONTROLS' : 'RADIO'],
  ];
  const showMap = !isMobile || tab === 'map';
  const showFeed = !isMobile || tab !== 'map';
  const feedShow = !isMobile ? 'all' : tab === 'tools' ? 'tools' : 'feed';

  return (
    <div
      className="relative flex flex-col h-screen bg-black text-green-500 font-mono overflow-hidden max-md:[&_button]:min-h-10"
      style={{ height: '100dvh' }}
    >
      <header className="shrink-0 border-b border-green-900 bg-black/90 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 md:px-4 py-1 md:py-0 md:h-12 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 md:gap-x-6 min-w-0">
          <ExerciseStatus />
          <span className="text-amber-500">ROLE: [ {role.toUpperCase()} ]</span>
          <span className="text-green-700">SESSION: {sessionId || 'alpha-1'}</span>
        </div>

        {role === 'instructor' && <InstructorControls />}

        <div className="flex items-center gap-3 md:gap-6">
          <MuteButton />
          <span className="hidden md:inline">
            <RecordingBadge />
          </span>
          <span className="hidden md:inline">
            <SysClock />
          </span>
        </div>
      </header>

      <main className="flex-1 min-h-0 flex flex-col md:flex-row relative">
        <Notice />

        {showFeed && <IntelFeed show={feedShow} />}

        <div className={`${showMap ? 'block' : 'hidden'} flex-1 min-w-0 min-h-0 relative`}>
          <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_4px,3px_100%] z-[400] opacity-30"></div>
          <TacticalMap />
        </div>

        <DecisionPanel />
      </main>

      {isMobile && (
        <nav className="shrink-0 grid grid-cols-3 border-t border-green-900 bg-black">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`py-3 text-xs tracking-widest border-t-2 ${
                tab === id
                  ? 'text-amber-400 border-amber-500 bg-amber-950/20'
                  : 'text-green-600 border-transparent'
              }`}
            >
              {label}
              {id === 'feed' && tab !== 'feed' && unseen > 0 && (
                <span className="ml-2 bg-amber-500 text-black px-1 font-bold">{unseen}</span>
              )}
              {id === 'feed' && tab !== 'feed' && role === 'commander' && hasDecision && (
                <span className="ml-1 text-red-500 animate-pulse">●</span>
              )}
            </button>
          ))}
        </nav>
      )}

      <EvaluationModal />
    </div>
  );
}