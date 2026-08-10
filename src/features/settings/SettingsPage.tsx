import { useEffect, useState } from "react";
import type { Language, ThemeMode } from "../../types";
import { readStored, writeStored } from "../../platform/storage";
import "./SettingsPage.css";

export interface SettingsPageProps {
  language: Language;
  onLanguageChange: (language: Language) => void;
  theme?: ThemeMode;
  onThemeChange?: (theme: ThemeMode) => void;
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
    disconnected: "Disconnected",
    noCredentials: "no credentials stored",
    connectionBody: "此工作区刻意保持离线。Connect 只会打开说明，不会联系任何服务商。",
    connect: "Connect",
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

export function SettingsPage({
  language,
  onLanguageChange,
  theme = "dark",
  onThemeChange = () => undefined,
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

  const settingsModalOpen = connectionDialogOpen || pendingKey !== null;

  useEffect(() => {
    writeStored("protections", protections);
  }, [protections]);

  useEffect(() => {
    onModalStateChange(settingsModalOpen);
  }, [onModalStateChange, settingsModalOpen]);

  useEffect(() => {
    if (!settingsModalOpen) return undefined;
    const dialog = document.querySelector<HTMLElement>(".settings-modal[role='dialog']");
    dialog?.focus();
    return undefined;
  }, [settingsModalOpen]);

  useEffect(() => {
    if (!settingsModalOpen) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (pendingKey !== null) {
        handleCancelDisable();
      } else {
        setConnectionDialogOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingKey, settingsModalOpen]);

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

      {connectionDialogOpen && (
        <div className="settings-modal-backdrop" role="presentation" onClick={() => setConnectionDialogOpen(false)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-labelledby="settings-connection-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="settings-badge settings-badge--lime">{copy.demoOnly}</span>
            <h2 id="settings-connection-dialog-title">{copy.connectionDialogTitle}</h2>
            <p>{copy.connectionDialogBody}</p>
            <button className="settings-button settings-button--primary" type="button" onClick={() => setConnectionDialogOpen(false)}>{copy.close}</button>
          </section>
        </div>
      )}

      {pendingKey !== null && pendingDefinition && (
        <div className="settings-modal-backdrop settings-risk-backdrop" role="presentation">
          <section
            className="settings-modal settings-risk-modal"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-labelledby="settings-risk-dialog-title"
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
          </section>
        </div>
      )}
    </main>
  );
}
