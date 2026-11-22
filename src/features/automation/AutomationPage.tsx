import { useEffect, useMemo, useRef, useState } from "react";
import { appendEvidence } from "../../domain/evidenceJournal";
import {
  AUTOMATION_CONTROLLER,
  DEFAULT_AUTOMATION_STATE,
  normalizeAutomationState,
  type AutomationMode,
  type AutomationSchedule,
  type AutomationState,
} from "../../domain/automation";
import { decimalCompare, money, price, quantity, decimalToNumber, type Money } from "../../domain/decimal";
import { findMockQuote, MOCK_BROKER } from "../../domain/mockBroker";
import { getCurrentLockEpoch, isCurrentLockEpoch } from "../../domain/sessionEpoch";
import { isTauriRuntime } from "../../domain/tauriBridge";
import {
  AUTOMATION_SETTING_KEY,
  loadEncryptedSetting,
  saveEncryptedSetting,
} from "../../domain/vaultStorage";
import { formatCurrency } from "../../formatters";
import type { BrokerSymbol } from "../../domain/contracts";
import type { Language } from "../../types";
import { readStored } from "../../platform/storage";
import "./automation.css";

interface AutomationPageProps {
  language: Language;
}

const DEFAULT_SYMBOLS: readonly BrokerSymbol[] = ["SPY", "AAPL", "MSFT", "NVDA", "AMD", "AMZN", "TSLA"];

const COPY = {
  en: {
    title: "Automation",
    eyebrow: "Mock / Paper / Dry Run only",
    unavailable: "Real Trading unavailable",
    unavailableBody: "Schwab API is not connected. This page cannot send, cancel, replace, or schedule a real broker request.",
    mode: "Execution mode",
    mock: "Mock",
    paper: "Paper Trading",
    dryRun: "Dry Run",
    real: "Real Trading",
    enabled: "Automation enabled",
    enabledBody: "Runs remain local and produce only simulation records.",
    schedule: "Schedule",
    manual: "Manual only",
    five: "Every 5 minutes",
    fifteen: "Every 15 minutes",
    hourly: "Hourly",
    daily: "Daily",
    strategy: "Strategy label",
    strategyPlaceholder: "e.g. Weekly index review",
    guardrails: "Guardrails",
    maxOrder: "Max order value",
    maxDaily: "Max daily value",
    maxTasks: "Max concurrent tasks",
    rate: "Max actions / minute",
    allowlist: "Explicit symbol allowlist",
    session: "Regular session only",
    sessionBody: "This rule is fixed and cannot be disabled.",
    killSwitch: "Kill switch",
    armed: "Armed",
    tripped: "Tripped · automation locked",
    trip: "Trip kill switch",
    rearm: "Re-arm automation",
    runNow: "Run one local simulation",
    selectSymbol: "Simulation symbol",
    result: "Latest run",
    noRuns: "No runs recorded.",
    logs: "Run log",
    reset: "Reset local automation state",
    resetBody: "This clears only Mock/Paper/Dry Run settings and logs. It does not touch credentials or broker data.",
    wouldRun: "Would run",
    blocked: "Blocked",
    duplicate: "Duplicate prevented",
    reserved: "Reserved today",
    noReal: "No real request exists",
    evidenceSaving: "Saving the local evidence record…",
    evidenceSaved: "Local evidence saved",
    evidenceFailed: "This run is visible in memory, but its local evidence could not be saved. Check storage before relying on the record.",
    nonUsdIsolated: (items: string) => `Non-USD holdings isolated (Fail-Safe): ${items}. Automation caps are USD-denominated; non-USD symbols are excluded until verified FX rates exist.`,
  },
  zh: {
    title: "自动化",
    eyebrow: "仅 Mock / Paper / Dry Run",
    unavailable: "真实交易不可用",
    unavailableBody: "嘉信 API 尚未连接。本页面不能发送、撤销、替换或调度真实券商请求。",
    mode: "执行模式",
    mock: "Mock",
    paper: "Paper Trading",
    dryRun: "Dry Run",
    real: "真实交易",
    enabled: "启用自动化",
    enabledBody: "所有运行都留在本地，只产生模拟记录。",
    schedule: "调度",
    manual: "仅手动",
    five: "每 5 分钟",
    fifteen: "每 15 分钟",
    hourly: "每小时",
    daily: "每天",
    strategy: "策略名称",
    strategyPlaceholder: "例如：每周指数复核",
    guardrails: "风险边界",
    maxOrder: "单笔最大金额",
    maxDaily: "每日最大金额",
    maxTasks: "最大并发任务",
    rate: "每分钟最大操作数",
    allowlist: "明确的证券允许列表",
    session: "仅常规交易时段",
    sessionBody: "此规则固定开启，不能关闭。",
    killSwitch: "紧急停止",
    armed: "已布防",
    tripped: "已触发 · 自动化已锁定",
    trip: "触发紧急停止",
    rearm: "重新启用自动化",
    runNow: "运行一次本地模拟",
    selectSymbol: "模拟证券",
    result: "最近一次运行",
    noRuns: "还没有运行记录。",
    logs: "运行日志",
    reset: "重置本地自动化状态",
    resetBody: "只清除 Mock/Paper/Dry Run 设置和日志，不会触碰凭据或券商数据。",
    wouldRun: "将会运行",
    blocked: "已阻止",
    duplicate: "已阻止重复运行",
    reserved: "今日已预留",
    noReal: "不存在真实请求",
    evidenceSaving: "正在保存本地证据记录……",
    evidenceSaved: "本地证据已保存",
    evidenceFailed: "这次运行仅显示在内存中，本地证据没有保存成功。请先检查存储，再依赖这条记录。",
    nonUsdIsolated: (items: string) => `已隔离非美元持仓（Fail-Safe）：${items}。自动化金额上限以美元计价，未接入权威汇率前禁止非美元标的参与自动化模拟。`,
  },
} as const;

function formatMoney(value: string, language: Language): string {
  return formatCurrency(decimalToNumber(money(value)), language);
}

function safeMoneyInput(value: string, fallback: Money): Money {
  try {
    const next = money(value.trim() || "0");
    return decimalCompare(next, money("0")) < 0 ? fallback : next;
  } catch {
    return fallback;
  }
}

function persistableState(state: AutomationState): AutomationState {
  return {
    ...state,
    reservedToday: money(state.reservedToday),
    policy: {
      ...state.policy,
      maxOrderValue: money(state.policy.maxOrderValue),
      maxDailyValue: money(state.policy.maxDailyValue),
    },
  };
}

function automationModeLabel(mode: AutomationMode, language: Language): string {
  if (language === "en") return mode === "dry-run" ? "Dry Run" : mode === "paper" ? "Paper Trading" : mode === "real" ? "Real Trading" : "Mock";
  return mode === "dry-run" ? "试运行" : mode === "paper" ? "纸上交易" : mode === "real" ? "真实交易" : "Mock";
}

function automationStatusLabel(status: AutomationState["logs"][number]["status"], language: Language): string {
  if (language === "en") return status === "would-run" ? "Would run" : status === "duplicate" ? "Duplicate prevented" : "Blocked";
  return status === "would-run" ? "将会运行" : status === "duplicate" ? "已阻止重复运行" : "已阻止";
}

function automationReasonLabel(reason: string, language: Language): string {
  if (language === "en") return reason;
  const labels: Record<string, string> = {
    "Recorded locally; no broker write exists in this build": "已在本地记录；此版本不存在券商写入",
    "Idempotency key was already processed; no second action was created": "幂等键已经处理过；没有创建第二次操作",
    "Automation is disabled": "自动化已关闭",
    "Global kill switch is active": "全局紧急停止已触发",
    "Real Trading is unavailable until the Schwab API gate is completed": "完成嘉信 API Gate 前，真实交易不可用",
    "Regular market session is closed; automation is restricted to regular hours": "常规交易时段已关闭；自动化仅限常规交易时段运行",
    "Symbol is not on the explicit automation allowlist": "该证券不在明确的自动化允许列表中",
    "Order value exceeds the configured per-order cap": "订单金额超过单笔上限",
    "Daily value cap would be exceeded; remaining budget is frozen": "将超过每日金额上限；剩余预算已冻结",
    "Maximum actions per minute reached; no new action was created": "已达到每分钟最大操作数；没有创建新操作",
    "Run timestamp is invalid; action was blocked": "运行时间无效；操作已阻止",
    "Quantity and price must be positive decimals": "数量和价格必须是正数",
    "Order input is invalid; action was blocked": "订单输入无效；操作已阻止",
    "Backpressure: maximum concurrent task count reached": "已达到最大并发任务数",
  };
  const nonUsdMatch = /^Non-USD symbol \(([A-Z]+)\) is isolated from USD-denominated automation caps$/.exec(reason);
  if (nonUsdMatch) {
    return `非美元标的 (${nonUsdMatch[1]}) 已从美元上限自动化中隔离`;
  }
  return labels[reason] ?? reason;
}

function createRunIdempotencyKey(symbol: BrokerSymbol): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `manual-${symbol}-${suffix}`;
}

type EvidenceSaveStatus = "idle" | "saving" | "saved" | "failed";

function hydrateAutomationStateSync(): AutomationState {
  if (!isTauriRuntime()) {
    const stored = readStored<unknown>("automation", null);
    if (stored !== null) {
      AUTOMATION_CONTROLLER.replaceState(normalizeAutomationState(stored));
    }
  }
  return AUTOMATION_CONTROLLER.getState();
}

export function AutomationPage({ language }: AutomationPageProps) {
  const copy = COPY[language];
  const [state, setState] = useState<AutomationState>(hydrateAutomationStateSync);
  const [selectedSymbol, setSelectedSymbol] = useState<BrokerSymbol>(() => state.policy.allowedSymbols[0] ?? "SPY");
  const [lastResult, setLastResult] = useState<AutomationState["logs"][number] | null>(null);
  const [evidenceStatus, setEvidenceStatus] = useState<EvidenceSaveStatus>("idle");
  const [brokerTick, setBrokerTick] = useState(0);
  const hydratedRef = useRef(!isTauriRuntime());
  const evidenceAttemptRef = useRef(0);
  const selectedMode = state.mode;

  useEffect(() => MOCK_BROKER.subscribe(() => setBrokerTick((v) => v + 1)), []);

  const { availableSymbols, excludedNonUsdHoldings } = useMemo(() => {
    void brokerTick;
    const snap = MOCK_BROKER.getSnapshot();
    const nonUsdSet = new Map<string, string>();
    const usdSet = new Set<string>(DEFAULT_SYMBOLS);

    for (const h of snap.holdings) {
      const curr = (h.currency ?? "USD").toUpperCase();
      if (curr !== "USD") {
        nonUsdSet.set(h.symbol, curr);
      } else {
        usdSet.add(h.symbol);
      }
    }
    for (const q of snap.quotes) {
      const curr = (q.currency ?? "USD").toUpperCase();
      if (curr !== "USD" && !usdSet.has(q.symbol)) {
        nonUsdSet.set(q.symbol, curr);
      }
    }
    for (const s of state.policy.allowedSymbols) {
      if (!nonUsdSet.has(s)) {
        usdSet.add(s);
      }
    }
    for (const nonUsdSym of nonUsdSet.keys()) {
      usdSet.delete(nonUsdSym);
    }

    return {
      availableSymbols: [...usdSet] as readonly BrokerSymbol[],
      excludedNonUsdHoldings: [...nonUsdSet.entries()].map(([symbol, currency]) => ({ symbol, currency })),
    };
  }, [brokerTick, state.policy.allowedSymbols]);

  useEffect(() => {
    return AUTOMATION_CONTROLLER.subscribe(() => {
      setState(AUTOMATION_CONTROLLER.getState());
    });
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let active = true;
    const epoch = getCurrentLockEpoch();
    void loadEncryptedSetting<unknown>(AUTOMATION_SETTING_KEY, null, "automation")
      .then((loaded) => {
        if (!active || !isCurrentLockEpoch(epoch)) return;
        if (loaded !== null) {
          AUTOMATION_CONTROLLER.replaceState(normalizeAutomationState(loaded));
        }
        hydratedRef.current = true;
      })
      .catch(() => {
        if (active && isCurrentLockEpoch(epoch)) hydratedRef.current = true;
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    void saveEncryptedSetting(AUTOMATION_SETTING_KEY, persistableState(state), "automation");
  }, [state]);

  const dailyPercent = useMemo(() => {
    const cap = decimalToNumber(state.policy.maxDailyValue);
    return cap <= 0 ? 0 : Math.min(100, (decimalToNumber(state.reservedToday) / cap) * 100);
  }, [state.policy.maxDailyValue, state.reservedToday]);

  function updateState(patch: Partial<AutomationState>): void {
    AUTOMATION_CONTROLLER.updateState(patch);
  }

  function updatePolicy(patch: Partial<AutomationState["policy"]>): void {
    AUTOMATION_CONTROLLER.updatePolicy(patch);
  }

  function toggleSymbol(symbol: BrokerSymbol): void {
    const allowed = state.policy.allowedSymbols.includes(symbol);
    const next = allowed
      ? state.policy.allowedSymbols.filter((item) => item !== symbol)
      : [...state.policy.allowedSymbols, symbol];
    updatePolicy({ allowedSymbols: next });
    if (allowed && selectedSymbol === symbol) setSelectedSymbol(next[0] ?? "SPY");
  }

  async function runNow(): Promise<void> {
    const quote = findMockQuote(selectedSymbol);
    const marketSession = MOCK_BROKER.getScenario() === "market-closed" ? "closed" : "regular";
    const result = AUTOMATION_CONTROLLER.run({
      symbol: selectedSymbol,
      side: "buy",
      quantity: quantity("1"),
      price: quote?.price ?? price("0"),
      currency: quote?.currency ?? "USD",
      idempotencyKey: createRunIdempotencyKey(selectedSymbol),
      marketSession,
    });
    if (result.log.status === "would-run") {
      AUTOMATION_CONTROLLER.completeTask();
    }
    setLastResult(result.log);
    const attempt = evidenceAttemptRef.current + 1;
    evidenceAttemptRef.current = attempt;
    setEvidenceStatus("saving");
    try {
      await appendEvidence("automation_run", {
        mode: result.log.mode,
        symbol: result.log.symbol,
        status: result.log.status,
        amount: result.log.amount,
        reason: result.log.reason,
      });
      if (evidenceAttemptRef.current === attempt) setEvidenceStatus("saved");
    } catch {
      if (evidenceAttemptRef.current === attempt) setEvidenceStatus("failed");
    }
  }

  function reset(): void {
    AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
    setSelectedSymbol(DEFAULT_AUTOMATION_STATE.policy.allowedSymbols[0] ?? "SPY");
    setLastResult(null);
    evidenceAttemptRef.current += 1;
    setEvidenceStatus("idle");
  }

  return (
    <main className="automation-page" data-testid="automation-page">
      <header className="automation-header">
        <div>
          <p className="automation-eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
        </div>
        <span className="automation-badge automation-badge--warning">{copy.unavailable}</span>
      </header>

      <section className="automation-callout" role="note">
        <strong>{copy.unavailable}</strong>
        <p>{copy.unavailableBody}</p>
        <span>{copy.noReal}</span>
      </section>

      <div className="automation-grid">
        <section className="automation-card">
          <div className="automation-card-heading"><div><span>01</span><h2>{copy.mode}</h2></div></div>
          <div className="automation-mode-grid" role="group" aria-label={copy.mode}>
            {(["mock", "paper", "dry-run"] as const).map((mode) => (
              <button key={mode} type="button" className={selectedMode === mode ? "is-selected" : ""} aria-pressed={selectedMode === mode} onClick={() => updateState({ mode })}>
                {mode === "mock" ? copy.mock : mode === "paper" ? copy.paper : copy.dryRun}
              </button>
            ))}
            <button type="button" className="is-disabled" disabled title={copy.unavailableBody}>{copy.real}</button>
          </div>
          <div className="automation-setting-row">
            <div><strong>{copy.enabled}</strong><span>{copy.enabledBody}</span></div>
            <button type="button" role="switch" aria-checked={state.enabled} className={`automation-switch ${state.enabled ? "is-on" : ""}`} disabled={state.killSwitchTripped || selectedMode === "real"} onClick={() => updateState({ enabled: !state.enabled })}>{state.enabled ? "ON" : "OFF"}</button>
          </div>
          <label className="automation-field"><span>{copy.strategy}</span><input value={state.strategyName} placeholder={copy.strategyPlaceholder} onChange={(event) => updateState({ strategyName: event.target.value })} /></label>
          <label className="automation-field"><span>{copy.schedule}</span><select value={state.schedule} onChange={(event) => updateState({ schedule: event.target.value as AutomationSchedule })}><option value="manual">{copy.manual}</option><option value="5m">{copy.five}</option><option value="15m">{copy.fifteen}</option><option value="hourly">{copy.hourly}</option><option value="daily">{copy.daily}</option></select></label>
        </section>

        <section className="automation-card">
          <div className="automation-card-heading"><div><span>02</span><h2>{copy.guardrails}</h2></div></div>
          <label className="automation-field"><span>{copy.maxOrder}</span><input inputMode="decimal" value={state.policy.maxOrderValue} onChange={(event) => updatePolicy({ maxOrderValue: safeMoneyInput(event.target.value, state.policy.maxOrderValue) })} /></label>
          <label className="automation-field"><span>{copy.maxDaily}</span><input inputMode="decimal" value={state.policy.maxDailyValue} onChange={(event) => updatePolicy({ maxDailyValue: safeMoneyInput(event.target.value, state.policy.maxDailyValue) })} /></label>
          <label className="automation-field"><span>{copy.maxTasks}</span><input type="number" min="1" step="1" value={state.policy.maxOpenTasks} onChange={(event) => updatePolicy({ maxOpenTasks: Math.max(1, Number(event.target.value) || 1) })} /></label>
          <label className="automation-field"><span>{copy.rate}</span><input type="number" min="1" step="1" value={state.policy.maxActionsPerMinute} onChange={(event) => updatePolicy({ maxActionsPerMinute: Math.max(1, Number(event.target.value) || 1) })} /></label>
          <div className="automation-budget"><div><span>{copy.reserved}</span><strong>{formatMoney(state.reservedToday, language)} / {formatMoney(state.policy.maxDailyValue, language)}</strong></div><div className="automation-progress"><i style={{ width: `${dailyPercent}%` }} /></div></div>
        </section>
      </div>

      <section className="automation-card automation-card--wide">
        <div className="automation-card-heading"><div><span>03</span><h2>{copy.allowlist}</h2></div><span className="automation-fixed">{copy.session}</span></div>
        <p className="automation-muted">{copy.sessionBody}</p>
        {excludedNonUsdHoldings.length > 0 && (
          <p className="automation-muted" role="status" data-testid="automation-non-usd-notice">
            {copy.nonUsdIsolated(excludedNonUsdHoldings.map((item) => `${item.symbol} (${item.currency})`).join(", "))}
          </p>
        )}
        <div className="automation-symbols">{availableSymbols.map((symbol) => <label key={symbol}><input type="checkbox" checked={state.policy.allowedSymbols.includes(symbol)} onChange={() => toggleSymbol(symbol)} /><span>{symbol}</span></label>)}</div>
        <div className="automation-run-row"><label className="automation-field"><span>{copy.selectSymbol}</span><select value={selectedSymbol} onChange={(event) => setSelectedSymbol(event.target.value as BrokerSymbol)}>{availableSymbols.map((symbol) => <option key={symbol} value={symbol} disabled={!state.policy.allowedSymbols.includes(symbol)}>{symbol}</option>)}</select></label><button className="automation-primary" type="button" onClick={runNow}>{copy.runNow}</button></div>
      </section>

      <section className={`automation-kill ${state.killSwitchTripped ? "is-tripped" : ""}`}>
        <div><span className="automation-kill-label">{copy.killSwitch}</span><strong>{state.killSwitchTripped ? copy.tripped : copy.armed}</strong></div>
        {state.killSwitchTripped ? <button type="button" className="automation-secondary" onClick={() => AUTOMATION_CONTROLLER.resetKillSwitch()}>{copy.rearm}</button> : <button type="button" className="automation-danger" onClick={() => AUTOMATION_CONTROLLER.tripKillSwitch()}>{copy.trip}</button>}
      </section>

      <section className="automation-card automation-card--wide">
        <div className="automation-card-heading"><div><span>04</span><h2>{copy.logs}</h2></div><button type="button" className="automation-link" onClick={reset}>{copy.reset}</button></div>
        <p className="automation-muted">{copy.resetBody}</p>
        {lastResult && <div className={`automation-result automation-result--${lastResult.status}`}><strong>{automationStatusLabel(lastResult.status, language)}</strong><span>{automationReasonLabel(lastResult.reason, language)}</span></div>}
        {evidenceStatus !== "idle" && (
          <p
            className={`automation-evidence-status automation-evidence-status--${evidenceStatus}`}
            data-testid="automation-evidence-status"
            role={evidenceStatus === "failed" ? "alert" : "status"}
            aria-live={evidenceStatus === "failed" ? "assertive" : "polite"}
          >
            {evidenceStatus === "saving" ? copy.evidenceSaving : evidenceStatus === "saved" ? copy.evidenceSaved : copy.evidenceFailed}
          </p>
        )}
        <div className="automation-log-list">{state.logs.length === 0 ? <p className="automation-muted">{copy.noRuns}</p> : state.logs.map((log) => <div className="automation-log" key={log.id}><strong>{log.id} · {log.symbol}</strong><span>{automationModeLabel(log.mode, language)} · {automationStatusLabel(log.status, language)} · {formatMoney(log.amount, language)}</span><small>{automationReasonLabel(log.reason, language)}</small></div>)}</div>
      </section>
    </main>
  );
}
