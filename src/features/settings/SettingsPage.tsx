import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { Language, ThemeMode } from "../../types";
import type { MockScenario } from "../../domain/contracts";
import { clearFolioHelmStored, readStored, writeStored } from "../../platform/storage";
import { clearEvidence, exportEvidence, importEvidence, verifyEvidence } from "../../domain/evidenceJournal";
import { MOCK_BROKER, MOCK_SCENARIOS } from "../../domain/mockBroker";
import { AUTOMATION_CONTROLLER, DEFAULT_AUTOMATION_STATE } from "../../domain/automation";
import { Modal } from "../../components/Modal";
import "./SettingsPage.css";

export interface SettingsPageProps {
  language: Language;
  onLanguageChange: (language: Language) => void;
  theme?: ThemeMode;
  onThemeChange?: (theme: ThemeMode) => void;
  mockScenario?: MockScenario;
  onMockScenarioChange?: (scenario: MockScenario) => void;
  onModalStateChange?: (open: boolean) => void;
}

type ProtectionKey = "maxOrderValue" | "priceDeviation" | "autoLock" | "accountAllowlist";

interface ProtectionDefinition {
  key: ProtectionKey;
  label: string;
  detail: string;
  highRisk: boolean;
}

const INITIAL_PROTECTIONS: Record<ProtectionKey, boolean> = {
  maxOrderValue: true,
  priceDeviation: true,
  autoLock: true,
  accountAllowlist: true,
};

type EvidenceState =
  | { kind: "idle"; text: string }
  | { kind: "valid"; text: string }
  | { kind: "invalid"; text: string };

const COPY = {
  en: {
    title: "Settings",
    eyebrow: "Workspace controls",
    demoOnly: "Demo only",
    connection: "Connection",
    disconnected: "Disconnected",
    noCredentials: "no credentials stored",
    connectionBody: "This workspace is intentionally offline. Connect opens an explanation only; it never contacts a provider.",
    connect: "Connect",
    close: "Close",
    connectionDialogTitle: "Demo connection",
    connectionDialogBody: "FolioHelm is not connected to a brokerage. No credentials are stored, no provider was contacted, and no connection can be established from this mock.",
    appearance: "Appearance",
    language: "Language",
    english: "English",
    chinese: "简体中文",
    theme: "Theme",
    system: "System",
    dark: "Dark",
    light: "Light",
    mockScenario: "Mock scenario",
    mockScenarioBody: "Choose a deterministic fixture to exercise empty, stale, offline, timeout and Unknown states.",
    scenarioHealthy: "Healthy snapshot",
    scenarioEmpty: "Empty account",
    scenarioLoss: "Loss account",
    scenarioNoBuyingPower: "No buying power",
    scenarioInsufficientQuantity: "Insufficient quantity",
    scenarioMarketClosed: "Market closed",
    scenarioStaleQuote: "Stale quote",
    scenarioOffline: "Offline",
    scenarioReauth: "Reauthorization required",
    scenarioRequestFailed: "Request failed",
    scenarioRateLimited: "Rate limited",
    scenarioTimeout: "Timeout",
    scenarioUnknown: "Unknown outcome",
    scenarioReconciliationFailed: "Reconciliation failed",
    tradingSafety: "Trading Safety",
    safetyBody: "Optional guards are on by default. Turning one off requires a deliberate, time-gated risk acknowledgement.",
    on: "On",
    off: "Off",
    maxOrderValue: "Max order value",
    maxOrderValueDetail: "Stops a simulated order above the demo value cap.",
    priceDeviation: "Price deviation",
    priceDeviationDetail: "Flags a simulated price too far from the fictional quote.",
    autoLock: "Auto lock",
    autoLockDetail: "Locks this demo workspace after an idle period.",
    accountAllowlist: "Account allowlist",
    accountAllowlistDetail: "Keeps simulated actions scoped to the demo account.",
    coreRules: "Core rules cannot be disabled",
    previewFreshness: "Preview freshness",
    noWriteRetry: "No write retry",
    unknownReconciliation: "Unknown reconciliation",
    localData: "Local workspace data",
    localDataBody: "Preferences, Mock automation state and the tamper-evident local journal stay on this device. No credentials are stored by this build.",
    evidence: "Evidence journal",
    verify: "Verify",
    export: "Export",
    import: "Import",
    evidenceEmpty: "No local evidence yet",
    evidenceValid: (count: number) => `Verified · ${count} local events`,
    evidenceInvalid: (reason: string) => `Verification failed · ${reason}`,
    evidenceUnavailable: "Verification unavailable in this environment",
    clearData: "Clear local demo data",
    clearDataTitle: "Clear local demo data?",
    clearDataBody: "This removes local Mock/Paper/Dry Run settings, evidence and safety preferences from this device. It cannot be undone. No brokerage credentials are present in this build.",
    confirmClear: "Clear data",
    about: "About",
    version: "Version",
    apiGate: "Schwab API gate",
    apiGateValue: "Pending official portal access",
    disableWarning: "Warning: this optional protection is disabled. The demo will show the risk beside this setting.",
    enableAgain: "Enable again to restore this guard.",
    riskDialogTitle: "Disable optional protection?",
    riskDialogIntro: "Risk acknowledgement required",
    riskDialogBody: "Turning off this protection increases the chance that a simulated order crosses a safety boundary. This is still a mock: no order, request, credential, or account action will occur.",
    readDetails: "I have read the risk details to the bottom.",
    wait: (seconds: number) => `Wait ${seconds} seconds before confirming.`,
    ready: "The waiting period is complete.",
    typeDisable: "Type DISABLE to continue",
    confirmIntent: "I understand the risk and want to disable this protection.",
    confirmDisable: "Confirm disable",
    cancel: "Cancel",
    riskDetails: "Risk details",
    riskDetailOne: "A disabled guard will not be evaluated by this mock UI until you turn it on again.",
    riskDetailTwo: "Review the selected setting, the demo account scope, and the fact that this screen cannot send a real order.",
    riskDetailThree: "The confirmation is intentionally delayed so the choice is observable and reversible.",
  },
  zh: {
    title: "设置",
    eyebrow: "工作区控制",
    demoOnly: "仅演示",
    connection: "连接",
    disconnected: "未连接",
    noCredentials: "未保存凭证",
    connectionBody: "此工作区刻意保持离线。“连接”只会打开说明，不会联系任何服务商。",
    connect: "连接说明",
    close: "关闭",
    connectionDialogTitle: "演示连接",
    connectionDialogBody: "FolioHelm 未连接券商。没有保存凭证，也没有联系服务商；此 Mock 不能建立连接。",
    appearance: "外观",
    language: "语言",
    english: "English",
    chinese: "简体中文",
    theme: "主题",
    system: "跟随系统",
    dark: "深色",
    light: "明亮",
    mockScenario: "Mock 场景",
    mockScenarioBody: "选择确定性的 Fixture，用来体验空账户、过期、断网、超时和 Unknown 状态。",
    scenarioHealthy: "正常快照",
    scenarioEmpty: "空账户",
    scenarioLoss: "亏损账户",
    scenarioNoBuyingPower: "无购买力",
    scenarioInsufficientQuantity: "数量不足",
    scenarioMarketClosed: "市场关闭",
    scenarioStaleQuote: "报价过期",
    scenarioOffline: "断网",
    scenarioReauth: "需要重新授权",
    scenarioRequestFailed: "请求失败",
    scenarioRateLimited: "触发限流",
    scenarioTimeout: "请求超时",
    scenarioUnknown: "未知结果",
    scenarioReconciliationFailed: "对账失败",
    tradingSafety: "交易安全",
    safetyBody: "可选保护默认开启。关闭任意保护都需要经过有意的、带倒计时的风险确认。",
    on: "开启",
    off: "关闭",
    maxOrderValue: "最大订单金额",
    maxOrderValueDetail: "阻止超过演示金额上限的模拟订单。",
    priceDeviation: "价格偏差",
    priceDeviationDetail: "标记偏离虚构报价过大的模拟价格。",
    autoLock: "自动锁定",
    autoLockDetail: "空闲一段时间后锁定演示工作区。",
    accountAllowlist: "账户允许列表",
    accountAllowlistDetail: "将模拟操作限定在演示账户内。",
    coreRules: "核心规则不可关闭",
    previewFreshness: "预览新鲜度",
    noWriteRetry: "不重试写入",
    unknownReconciliation: "未知状态对账",
    localData: "本地工作区数据",
    localDataBody: "偏好、Mock 自动化状态和防篡改本地日志都保存在本机。本版本不会保存凭据。",
    evidence: "证据日志",
    verify: "验证",
    export: "导出",
    import: "导入",
    evidenceEmpty: "还没有本地证据",
    evidenceValid: (count: number) => `验证通过 · ${count} 条本地事件`,
    evidenceInvalid: (reason: string) => `验证失败 · ${reason}`,
    evidenceUnavailable: "当前环境无法验证",
    clearData: "清理本地演示数据",
    clearDataTitle: "清理本地演示数据？",
    clearDataBody: "这会删除本机的 Mock/Paper/Dry Run 设置、证据日志和安全偏好，且无法撤销。本版本不存在券商凭据。",
    confirmClear: "确认清理",
    about: "关于",
    version: "版本",
    apiGate: "嘉信 API 状态",
    apiGateValue: "等待官方门户访问",
    disableWarning: "警告：此可选保护已关闭。演示会在此设置旁显示风险。",
    enableAgain: "重新开启即可恢复此保护。",
    riskDialogTitle: "关闭可选保护？",
    riskDialogIntro: "需要风险确认",
    riskDialogBody: "关闭此保护会增加模拟订单跨过安全边界的风险。这仍然是 Mock：不会发生订单、请求、凭证或账户操作。",
    readDetails: "我已阅读风险说明到底部。",
    wait: (seconds: number) => `确认前请等待 ${seconds} 秒。`,
    ready: "等待时间已结束。",
    typeDisable: "输入 DISABLE 继续",
    confirmIntent: "我了解风险，并希望关闭此保护。",
    confirmDisable: "确认关闭",
    cancel: "取消",
    riskDetails: "风险说明",
    riskDetailOne: "保护关闭后，此 Mock 界面不会评估该保护，直到你重新开启。",
    riskDetailTwo: "请确认选中的设置、演示账户范围，以及此页面无法发送真实订单这一事实。",
    riskDetailThree: "确认被刻意延迟，让这个选择可观察且可逆。",
  },
} as const;

function getProtectionDefinitions(language: Language): ProtectionDefinition[] {
  const copy = COPY[language];
  return [
    { key: "maxOrderValue", label: copy.maxOrderValue, detail: copy.maxOrderValueDetail, highRisk: true },
    { key: "priceDeviation", label: copy.priceDeviation, detail: copy.priceDeviationDetail, highRisk: false },
    { key: "autoLock", label: copy.autoLock, detail: copy.autoLockDetail, highRisk: false },
    { key: "accountAllowlist", label: copy.accountAllowlist, detail: copy.accountAllowlistDetail, highRisk: true },
  ];
}

function scenarioLabel(scenario: MockScenario, language: Language): string {
  const labels: Record<MockScenario, [string, string]> = {
    healthy: ["Healthy snapshot", "正常快照"],
    "empty-account": ["Empty account", "空账户"],
    loss: ["Loss account", "亏损账户"],
    "no-buying-power": ["No buying power", "无购买力"],
    "insufficient-quantity": ["Insufficient quantity", "数量不足"],
    "market-closed": ["Market closed", "市场关闭"],
    "stale-quote": ["Stale quote", "报价过期"],
    offline: ["Offline", "断网"],
    "reauth-required": ["Reauthorization required", "需要重新授权"],
    "request-failed": ["Request failed", "请求失败"],
    "rate-limited": ["Rate limited", "触发限流"],
    timeout: ["Timeout", "请求超时"],
    unknown: ["Unknown outcome", "未知结果"],
    "reconciliation-failed": ["Reconciliation failed", "对账失败"],
  };
  return labels[scenario][language === "zh" ? 1 : 0];
}

export function SettingsPage({
  language,
  onLanguageChange,
  theme = "dark",
  onThemeChange = () => undefined,
  mockScenario = "healthy",
  onMockScenarioChange = () => undefined,
  onModalStateChange = () => undefined,
}: SettingsPageProps) {
  const copy = COPY[language];
  const definitions = getProtectionDefinitions(language);
  const [protections, setProtections] = useState<Record<ProtectionKey, boolean>>(() => {
    const stored = readStored<Partial<Record<ProtectionKey, boolean>>>("protections", {});
    return {
      maxOrderValue: stored.maxOrderValue ?? INITIAL_PROTECTIONS.maxOrderValue,
      priceDeviation: stored.priceDeviation ?? INITIAL_PROTECTIONS.priceDeviation,
      autoLock: stored.autoLock ?? INITIAL_PROTECTIONS.autoLock,
      accountAllowlist: stored.accountAllowlist ?? INITIAL_PROTECTIONS.accountAllowlist,
    };
  });
  const [warningKey, setWarningKey] = useState<ProtectionKey | null>(null);
  const [pendingKey, setPendingKey] = useState<ProtectionKey | null>(null);
  const [countdown, setCountdown] = useState(8);
  const [readToBottom, setReadToBottom] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState(false);
  const [disablePhrase, setDisablePhrase] = useState("");
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [clearDataDialogOpen, setClearDataDialogOpen] = useState(false);
  const [evidenceStatus, setEvidenceStatus] = useState<EvidenceState>({ kind: "idle", text: copy.evidenceEmpty });
  const importInputRef = useRef<HTMLInputElement>(null);

  const settingsModalOpen = connectionDialogOpen || pendingKey !== null || clearDataDialogOpen;

  useEffect(() => {
    writeStored("protections", protections);
  }, [protections]);

  useEffect(() => {
    onModalStateChange(settingsModalOpen);
  }, [onModalStateChange, settingsModalOpen]);

  function downloadEvidence(serialized: string): void {
    const blob = new Blob([serialized], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "foliohelm-evidence-mock.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleVerifyEvidence(): Promise<void> {
    try {
      const result = await verifyEvidence();
      setEvidenceStatus(result.valid
        ? { kind: "valid", text: result.sequence === 0 ? copy.evidenceEmpty : copy.evidenceValid(result.sequence) }
        : { kind: "invalid", text: copy.evidenceInvalid(result.reason ?? copy.evidenceUnavailable) });
    } catch {
      setEvidenceStatus({ kind: "invalid", text: copy.evidenceUnavailable });
    }
  }

  async function handleExportEvidence(): Promise<void> {
    try {
      downloadEvidence(await exportEvidence());
      await handleVerifyEvidence();
    } catch {
      setEvidenceStatus({ kind: "invalid", text: copy.evidenceUnavailable });
    }
  }

  async function handleImportEvidence(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const result = await importEvidence(await file.text());
      setEvidenceStatus({ kind: "valid", text: result.sequence === 0 ? copy.evidenceEmpty : copy.evidenceValid(result.sequence) });
    } catch (error) {
      setEvidenceStatus({ kind: "invalid", text: copy.evidenceInvalid(error instanceof Error ? error.message : copy.evidenceUnavailable) });
    }
  }

  function clearLocalData(): void {
    clearFolioHelmStored();
    clearEvidence();
    MOCK_BROKER.reset();
    AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
    onMockScenarioChange?.("healthy");
    setProtections({ ...INITIAL_PROTECTIONS });
    setEvidenceStatus({ kind: "valid", text: copy.evidenceEmpty });
    setClearDataDialogOpen(false);
  }

  const pendingDefinition = pendingKey === null
    ? undefined
    : definitions.find((definition) => definition.key === pendingKey);
  const needsDisablePhrase = pendingDefinition?.highRisk === true;
  const canConfirm = pendingKey !== null
    && countdown === 0
    && readToBottom
    && confirmIntent
    && (!needsDisablePhrase || disablePhrase === "DISABLE");

  useEffect(() => {
    if (pendingKey === null) return undefined;

    const timer = window.setInterval(() => {
      setCountdown((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [pendingKey]);

  function openDisableDialog(key: ProtectionKey): void {
    setPendingKey(key);
    setCountdown(8);
    setReadToBottom(false);
    setConfirmIntent(false);
    setDisablePhrase("");
  }

  function handleProtectionSwitch(key: ProtectionKey): void {
    if (protections[key]) {
      openDisableDialog(key);
      return;
    }

    setProtections((current) => ({ ...current, [key]: true }));
    setWarningKey(null);
  }

  function handleCancelDisable(): void {
    setPendingKey(null);
    setCountdown(8);
    setReadToBottom(false);
    setConfirmIntent(false);
    setDisablePhrase("");
  }

  function handleConfirmDisable(): void {
    if (!pendingKey || !canConfirm) return;

    const confirmedKey = pendingKey;
    setProtections((current) => ({ ...current, [confirmedKey]: false }));
    setWarningKey(confirmedKey);
    handleCancelDisable();
  }

  const countdownText = countdown === 0 ? copy.ready : copy.wait(countdown);

  return (
    <main className="settings-page" data-testid="settings-page">
      <header className="settings-page__header">
        <div>
          <p className="settings-page__eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
        </div>
        <span className="settings-badge">{copy.demoOnly}</span>
      </header>

      <div className="settings-grid">
        <section className="settings-card settings-connection" aria-labelledby="settings-connection-title">
          <div className="settings-card__heading">
            <div>
              <p className="settings-card__kicker">01</p>
              <h2 id="settings-connection-title">{copy.connection}</h2>
            </div>
            <span className="settings-status-dot" aria-hidden="true" />
          </div>
          <div className="settings-connection__status">
            <strong>{copy.disconnected}</strong>
            <span>{copy.noCredentials}</span>
          </div>
          <p className="settings-card__body">{copy.connectionBody}</p>
          <button className="settings-button settings-button--secondary" type="button" onClick={() => setConnectionDialogOpen(true)}>{copy.connect}</button>
        </section>

        <section className="settings-card settings-appearance" aria-labelledby="settings-appearance-title">
          <div className="settings-card__heading">
            <div>
              <p className="settings-card__kicker">02</p>
              <h2 id="settings-appearance-title">{copy.appearance}</h2>
            </div>
          </div>
          <div className="settings-setting-line">
            <div>
              <strong>{copy.language}</strong>
              <span>{language === "zh" ? copy.chinese : copy.english}</span>
            </div>
            <div className="settings-language-choice" role="group" aria-label={copy.language}>
              <button
                className={language === "en" ? "is-selected" : ""}
                type="button"
                aria-pressed={language === "en"}
                onClick={() => onLanguageChange("en")}
              >
                {copy.english}
              </button>
              <button
                className={language === "zh" ? "is-selected" : ""}
                type="button"
                aria-pressed={language === "zh"}
                onClick={() => onLanguageChange("zh")}
              >
                {copy.chinese}
              </button>
            </div>
          </div>
          <div className="settings-setting-line settings-setting-line--theme">
            <div>
              <strong>{copy.theme}</strong>
              <span>{theme === "system" ? copy.system : theme === "dark" ? copy.dark : copy.light}</span>
            </div>
            <div className="settings-language-choice" role="group" aria-label={copy.theme}>
              {(["system", "dark", "light"] as const).map((mode) => (
                <button
                  className={theme === mode ? "is-selected" : ""}
                  type="button"
                  aria-pressed={theme === mode}
                  key={mode}
                  onClick={() => onThemeChange(mode)}
                >
                  {mode === "system" ? copy.system : mode === "dark" ? copy.dark : copy.light}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-setting-line settings-setting-line--theme settings-setting-line--scenario">
            <div>
              <strong>{copy.mockScenario}</strong>
              <span>{copy.mockScenarioBody}</span>
            </div>
            <select
              className="settings-scenario-select"
              aria-label={copy.mockScenario}
              value={mockScenario}
              onChange={(event) => onMockScenarioChange(event.target.value as MockScenario)}
            >
              {MOCK_SCENARIOS.map((scenario) => <option key={scenario} value={scenario}>{scenarioLabel(scenario, language)}</option>)}
            </select>
          </div>
        </section>
      </div>

      <section className="settings-card settings-safety" aria-labelledby="settings-safety-title">
        <div className="settings-card__heading settings-safety__heading">
          <div>
            <p className="settings-card__kicker">03</p>
            <h2 id="settings-safety-title">{copy.tradingSafety}</h2>
          </div>
          <span className="settings-badge settings-badge--lime">{copy.demoOnly}</span>
        </div>
        <p className="settings-card__body settings-safety__body">{copy.safetyBody}</p>

        <div className="settings-protection-list">
          {definitions.map((definition) => {
            const enabled = protections[definition.key];
            const warningVisible = warningKey === definition.key && !enabled;
            return (
              <div className="settings-protection" key={definition.key} data-testid={`protection-${definition.key}`}>
                <div className="settings-protection__copy">
                  <div className="settings-protection__title-line">
                    <strong>{definition.label}</strong>
                    {definition.highRisk && <span className="settings-high-risk">{language === "zh" ? "高风险" : "High risk"}</span>}
                  </div>
                  <span>{definition.detail}</span>
                  {warningVisible && <p className="settings-warning" role="status">{copy.disableWarning} {copy.enableAgain}</p>}
                </div>
                <button
                  className={`settings-switch ${enabled ? "is-on" : "is-off"}`}
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`${definition.label}: ${enabled ? copy.on : copy.off}`}
                  onClick={() => handleProtectionSwitch(definition.key)}
                >
                  <span className="settings-switch__thumb" aria-hidden="true" />
                  <span>{enabled ? copy.on : copy.off}</span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="settings-core-rules">
          <h3>{copy.coreRules}</h3>
          <ul>
            <li>{copy.previewFreshness}</li>
            <li>{copy.noWriteRetry}</li>
            <li>{copy.unknownReconciliation}</li>
          </ul>
        </div>
      </section>

      <section className="settings-card settings-local-data" aria-labelledby="settings-local-data-title">
        <div className="settings-card__heading">
          <div>
            <p className="settings-card__kicker">04</p>
            <h2 id="settings-local-data-title">{copy.localData}</h2>
          </div>
          <span className="settings-badge settings-badge--lime">{language === "zh" ? "本地" : "Local"}</span>
        </div>
        <p className="settings-card__body">{copy.localDataBody}</p>
        <div className="settings-evidence-row">
          <div>
            <strong>{copy.evidence}</strong>
            <span className={`settings-evidence-status settings-evidence-status--${evidenceStatus.kind}`} role="status">{evidenceStatus.text}</span>
          </div>
          <div className="settings-evidence-actions">
            <button className="settings-button settings-button--secondary" type="button" onClick={() => void handleVerifyEvidence()}>{copy.verify}</button>
            <button className="settings-button settings-button--secondary" type="button" onClick={() => void handleExportEvidence()}>{copy.export}</button>
            <button className="settings-button settings-button--secondary" type="button" onClick={() => importInputRef.current?.click()}>{copy.import}</button>
            <input ref={importInputRef} className="settings-hidden-file" type="file" accept="application/json,.json" onChange={(event) => void handleImportEvidence(event)} />
          </div>
        </div>
        <button className="settings-button settings-button--danger" type="button" onClick={() => setClearDataDialogOpen(true)}>{copy.clearData}</button>
      </section>

      <section className="settings-card settings-about" aria-labelledby="settings-about-title">
        <div className="settings-card__heading">
          <div>
            <p className="settings-card__kicker">05</p>
            <h2 id="settings-about-title">{copy.about}</h2>
          </div>
          <span className="settings-badge">Apache-2.0</span>
        </div>
        <dl className="settings-about-list">
          <div><dt>{copy.version}</dt><dd>0.1.0</dd></div>
          <div><dt>{copy.connection}</dt><dd>{language === "zh" ? "未连接券商" : "No brokerage connection"}</dd></div>
          <div><dt>{copy.apiGate}</dt><dd>{copy.apiGateValue}</dd></div>
        </dl>
      </section>

      {connectionDialogOpen && (
        <Modal
          className="settings-modal"
          backdropClassName="settings-modal-backdrop"
          labelledBy="settings-connection-dialog-title"
          onClose={() => setConnectionDialogOpen(false)}
        >
          <span className="settings-badge settings-badge--lime">{copy.demoOnly}</span>
          <h2 id="settings-connection-dialog-title">{copy.connectionDialogTitle}</h2>
          <p>{copy.connectionDialogBody}</p>
          <button className="settings-button settings-button--primary" type="button" onClick={() => setConnectionDialogOpen(false)}>{copy.close}</button>
        </Modal>
      )}

      {pendingKey !== null && pendingDefinition && (
        <Modal
          className="settings-modal settings-risk-modal"
          backdropClassName="settings-modal-backdrop settings-risk-backdrop"
          labelledBy="settings-risk-dialog-title"
          closeOnBackdrop={false}
          onClose={handleCancelDisable}
        >
          <span className="settings-badge settings-badge--warning">{copy.riskDialogIntro}</span>
          <h2 id="settings-risk-dialog-title">{copy.riskDialogTitle}</h2>
          <p>{copy.riskDialogBody}</p>
          <p className="settings-risk-modal__target"><strong>{pendingDefinition.label}</strong></p>

          <div className="settings-risk-scroll" role="region" aria-label={copy.riskDetails} tabIndex={0}>
            <h3>{copy.riskDetails}</h3>
            <p>{copy.riskDetailOne}</p>
            <p>{copy.riskDetailTwo}</p>
            <p>{copy.riskDetailThree}</p>
          </div>

          <label className="settings-check-line">
            <input
              type="checkbox"
              checked={readToBottom}
              onChange={(event) => setReadToBottom(event.target.checked)}
            />
            <span>{copy.readDetails}</span>
          </label>

          <p className="settings-countdown" aria-live="polite" data-testid="disable-countdown">{countdownText}</p>

          {needsDisablePhrase && (
            <label className="settings-field">
              <span>{copy.typeDisable}</span>
              <input
                type="text"
                value={disablePhrase}
                aria-label={copy.typeDisable}
                autoComplete="off"
                onChange={(event) => setDisablePhrase(event.target.value)}
              />
            </label>
          )}

          <label className="settings-check-line">
            <input
              type="checkbox"
              data-testid="confirm-disable-intent"
              checked={confirmIntent}
              onChange={(event) => setConfirmIntent(event.target.checked)}
            />
            <span>{copy.confirmIntent}</span>
          </label>

          <div className="settings-modal__actions">
            <button className="settings-button settings-button--secondary" type="button" onClick={handleCancelDisable}>{copy.cancel}</button>
            <button className="settings-button settings-button--primary" type="button" disabled={!canConfirm} onClick={handleConfirmDisable}>{copy.confirmDisable}</button>
          </div>
        </Modal>
      )}

      {clearDataDialogOpen && (
        <Modal
          className="settings-modal"
          backdropClassName="settings-modal-backdrop"
          labelledBy="settings-clear-data-title"
          onClose={() => setClearDataDialogOpen(false)}
        >
          <span className="settings-badge settings-badge--warning">{copy.clearData}</span>
          <h2 id="settings-clear-data-title">{copy.clearDataTitle}</h2>
          <p>{copy.clearDataBody}</p>
          <div className="settings-modal__actions">
            <button className="settings-button settings-button--secondary" type="button" onClick={() => setClearDataDialogOpen(false)}>{copy.cancel}</button>
            <button className="settings-button settings-button--danger" type="button" onClick={clearLocalData}>{copy.confirmClear}</button>
          </div>
        </Modal>
      )}
    </main>
  );
}
