import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { Language, ThemeMode } from "../../types";
import type { MockScenario } from "../../domain/contracts";
import { detectInitialLanguage } from "../../i18n";
import { clearFolioHelmStored, readStored } from "../../platform/storage";
import {
  appendEvidence,
  clearEvidence,
  exportEvidence,
  importEvidence,
  MAX_EVIDENCE_IMPORT_BYTES,
  verifyEvidence,
} from "../../domain/evidenceJournal";
import { clearPersistedLocalPortfolio } from "../../domain/csvImport";
import {
  refreshPublicQuotes,
  saveFhvaultWithDialogOrBlob,
  saveJsonWithDialogOrBlob,
  type PublicQuoteProviderChoice,
} from "../../domain/publicQuotes";
import {
  invokeDialogOpenFhvaultFile,
  invokeVaultClearAll,
  invokeVaultExportBackup,
  invokeVaultRestoreBackup,
  invokeVaultSetLockPassphrase,
  invokeVaultStatus,
  isTauriRuntime,
  type TauriVaultStatus,
} from "../../domain/tauriBridge";
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  hydrateWorkspaceFromVault,
  loadEncryptedSetting,
  loadWorkspacePreferences,
  normalizeWorkspacePreferences,
  PROTECTIONS_SETTING_KEY,
  saveEncryptedSetting,
  saveWorkspacePreferences,
  VAULT_HYDRATED_EVENT,
  WORKSPACE_PREFS_KEY,
  type VaultHydrationResult,
} from "../../domain/vaultStorage";
import { MOCK_BROKER, MOCK_SCENARIOS } from "../../domain/mockBroker";
import { getCurrentLockEpoch, isCurrentLockEpoch } from "../../domain/sessionEpoch";
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
  idleLockMinutes?: number;
  onIdleLockMinutesChange?: (minutes: number) => void;
  onLockSession?: (trigger: "manual" | "idle") => void;
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
  | { kind: "idle" }
  | { kind: "valid"; count: number }
  | { kind: "invalid"; reason?: string; clearFailed?: boolean };

function evidenceStatusText(state: EvidenceState, copy: typeof COPY[Language]): string {
  if (state.kind === "idle") return copy.evidenceEmpty;
  if (state.kind === "valid") return state.count === 0 ? copy.evidenceEmpty : copy.evidenceValid(state.count);
  if (state.clearFailed) return copy.clearDataFailed;
  return state.reason ? copy.evidenceInvalid(state.reason) : copy.evidenceUnavailable;
}

function storedBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

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
    safetyBody: "These preferences are on by default and are recorded locally. In this Mock build, only the core rules below are enforced; optional switches do not connect to a broker or change real orders.",
    on: "On",
    off: "Off",
    maxOrderValue: "Max order value",
    maxOrderValueDetail: "Mock preference only; no live order or configurable value cap is active in this build.",
    priceDeviation: "Price deviation",
    priceDeviationDetail: "Mock preference only; no live quote comparison is performed in this build.",
    autoLock: "Auto lock",
    autoLockDetail: "Locks the session on idle timeout, zeroizing in-memory vault keys and writing signed SessionLocked evidence.",
    accountAllowlist: "Account allowlist",
    accountAllowlistDetail: "Mock preference only; this build has no broker account access or account selection.",
    coreRules: "Core rules cannot be disabled",
    previewFreshness: "Preview freshness",
    noWriteRetry: "No write retry",
    unknownReconciliation: "Unknown reconciliation",
    localData: "Local workspace data",
    localDataBody: "Preferences, Mock automation state, imported CSV portfolios and the tamper-evident local journal stay encrypted on this device. No brokerage credentials are stored.",
    vaultStatusTitle: "Encrypted local vault",
    vaultUnlocked: (cipher: string, provider: string) => `Unlocked · ${cipher} · ${provider}`,
    vaultLocked: (reason: string) => `Locked (Fail-Closed) · ${reason}`,
    vaultBrowserMode: "Browser preview mode · Desktop builds use OS Credential Manager + AES-256-GCM SQLite",
    publicQuotesTitle: "Public delayed quotes (read-only)",
    publicQuotesNotice: "Delayed read-only public quotes · Not for live order execution",
    publicQuotesBody: "Off by default. When enabled, the Rust backend fetches unauthenticated delayed prices exclusively from HTTPS allowlisted public hosts (stooq.com / query1.finance.yahoo.com) with automatic offline cache fallback.",
    publicQuotesSwitch: "Enable public delayed quotes (read-only, non-execution)",
    publicQuotesProvider: "Public quote source",
    publicQuotesRefresh: "Refresh quotes",
    publicQuotesRefreshing: "Refreshing...",
    publicQuotesUpdated: (count: number, provider: string, asOf: string) => `Updated ${count} delayed quotes via ${provider} (${asOf})`,
    publicQuotesFallback: (reason: string) => `Using local cache / CSV baseline · ${reason}`,
    evidence: "Evidence journal",
    verify: "Verify",
    export: "Export",
    exportDiagnostics: "Export diagnostics",
    import: "Import",
    savedToPath: (path: string) => `Saved to ${path}`,
    evidenceEmpty: "No local evidence yet",
    evidenceValid: (count: number) => `Verified · ${count} local events`,
    evidenceInvalid: (reason: string) => `Verification failed · ${reason}`,
    evidenceUnavailable: "Verification unavailable in this environment",
    clearDataFailed: "Local demo data could not be fully cleared. Check storage permissions and try again.",
    clearData: "Clear local demo data",
    clearDataTitle: "Clear local demo data?",
    clearDataBody: "This removes local Mock/Paper/Dry Run settings, evidence and safety preferences from this device. It cannot be undone. No brokerage credentials are present in this build.",
    confirmClear: "Clear data",
    about: "About",
    version: "Version",
    apiGate: "Schwab API gate",
    apiGateValue: "Pending official portal access",
    disableWarning: "Warning: this optional protection preference is disabled. Core Mock safety rules remain enforced; future live adapters must enforce their own guards.",
    enableAgain: "Enable again to restore this guard.",
    riskDialogTitle: "Disable optional protection?",
    riskDialogIntro: "Risk acknowledgement required",
    riskDialogBody: "Turning off this protection increases the chance that a simulated order crosses a safety boundary. This is still a mock: no order, request, credential, or account action will occur.",
    readDetails: "I have read the risk details to the bottom.",
    scrollToBottomHint: "Scroll the risk details to the bottom to enable this confirmation.",
    wait: (seconds: number) => `Wait ${seconds} seconds before confirming.`,
    ready: "The waiting period is complete.",
    typeDisable: "Type DISABLE to continue",
    confirmIntent: "I understand the risk and want to disable this protection.",
    confirmDisable: "Confirm disable",
    cancel: "Cancel",
    riskDetails: "Risk details",
    riskDetailOne: "These optional switches are recorded preferences in the current Mock build, not live execution guards. Core rules remain enforced.",
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
    safetyBody: "这些偏好默认开启，并会保存在本地。本 Mock 版本只强制执行下方核心规则；可选开关不会连接券商，也不会改变真实订单。",
    on: "开启",
    off: "关闭",
    maxOrderValue: "最大订单金额",
    maxOrderValueDetail: "仅是 Mock 偏好；本版本没有真实订单，也没有启用可配置的金额上限。",
    priceDeviation: "价格偏差",
    priceDeviationDetail: "仅是 Mock 偏好；本版本不会执行实时报价偏差比较。",
    autoLock: "自动锁定",
    autoLockDetail: "空闲超时自动锁屏，立即擦除内存会话密钥并写入 Ed25519 签名锁屏证据。",
    accountAllowlist: "账户允许列表",
    accountAllowlistDetail: "仅是 Mock 偏好；本版本没有券商账户访问或账户选择。",
    coreRules: "核心规则不可关闭",
    previewFreshness: "预览新鲜度",
    noWriteRetry: "不重试写入",
    unknownReconciliation: "未知状态对账",
    localData: "本地工作区数据",
    localDataBody: "偏好设置、模拟自动化状态、本地 CSV 持仓与防篡改证据链均加密保存在本机。本版本不保存任何券商凭据。",
    vaultStatusTitle: "本地加密金库",
    vaultUnlocked: (cipher: string, provider: string) => `已解锁 · ${cipher} · ${provider}`,
    vaultLocked: (reason: string) => `已锁定（Fail-Closed 保护原密文）· ${reason}`,
    vaultBrowserMode: "浏览器预览模式 · 桌面端默认使用操作系统凭证管理器 + AES-256-GCM 加密 SQLite",
    publicQuotesTitle: "公开延迟行情（只读）",
    publicQuotesNotice: "延迟只读公开行情 · 不可用于真实下单",
    publicQuotesBody: "默认关闭。显式开启后，仅由 Rust 后端经严格 HTTPS 白名单域名（stooq.com / query1.finance.yahoo.com）无凭证只读拉取；离线或限流时自动降级至本地缓存或 CSV 导入价。",
    publicQuotesSwitch: "启用公开延迟行情（只读，非券商成交价）",
    publicQuotesProvider: "公开行情源",
    publicQuotesRefresh: "刷新行情",
    publicQuotesRefreshing: "刷新中...",
    publicQuotesUpdated: (count: number, provider: string, asOf: string) => `已通过 ${provider} 更新 ${count} 条延迟行情（${asOf}）`,
    publicQuotesFallback: (reason: string) => `已自动降级至本地缓存或 CSV 基准价 · ${reason}`,
    evidence: "证据日志",
    verify: "验证",
    export: "导出",
    exportDiagnostics: "导出安全诊断",
    import: "导入",
    savedToPath: (path: string) => `已保存至 ${path}`,
    evidenceEmpty: "还没有本地证据",
    evidenceValid: (count: number) => `验证通过 · ${count} 条本地事件`,
    evidenceInvalid: (reason: string) => `验证失败 · ${reason}`,
    evidenceUnavailable: "当前环境无法验证",
    clearDataFailed: "无法完整清理本地演示数据。请检查存储权限后重试。",
    clearData: "清理本地演示数据",
    clearDataTitle: "清理本地演示数据？",
    clearDataBody: "这会删除本机的 Mock/Paper/Dry Run 设置、证据日志和安全偏好，且无法撤销。本版本不存在券商凭据。",
    confirmClear: "确认清理",
    about: "关于",
    version: "版本",
    apiGate: "嘉信 API 状态",
    apiGateValue: "等待官方门户访问",
    disableWarning: "警告：此可选保护偏好已关闭。核心 Mock 安全规则仍会执行；未来的真实适配器必须自行强制安全门槛。",
    enableAgain: "重新开启即可恢复此保护。",
    riskDialogTitle: "关闭可选保护？",
    riskDialogIntro: "需要风险确认",
    riskDialogBody: "关闭此保护会增加模拟订单跨过安全边界的风险。这仍然是 Mock：不会发生订单、请求、凭证或账户操作。",
    readDetails: "我已阅读风险说明到底部。",
    scrollToBottomHint: "请先将风险说明滚动到底部再勾选确认。",
    wait: (seconds: number) => `确认前请等待 ${seconds} 秒。`,
    ready: "等待时间已结束。",
    typeDisable: "输入 DISABLE 继续",
    confirmIntent: "我了解风险，并希望关闭此保护。",
    confirmDisable: "确认关闭",
    cancel: "取消",
    riskDetails: "风险说明",
    riskDetailOne: "这些可选开关在当前 Mock 版本中只是记录偏好，不是实时执行门槛；核心规则仍会执行。",
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
  idleLockMinutes = 15,
  onIdleLockMinutesChange,
  onLockSession,
}: SettingsPageProps) {
  const copy = COPY[language];
  const chinese = language === "zh";
  const definitions = getProtectionDefinitions(language);
  const [localIdleMinutes, setLocalIdleMinutes] = useState<number>(() =>
    !isTauriRuntime() && !onIdleLockMinutesChange
      ? normalizeWorkspacePreferences(readStored(WORKSPACE_PREFS_KEY, DEFAULT_WORKSPACE_PREFERENCES)).idleLockMinutes
      : idleLockMinutes,
  );
  const [protections, setProtections] = useState<Record<ProtectionKey, boolean>>(() => {
    const rawStored = !isTauriRuntime() ? readStored<unknown>("protections", {}) : {};
    const stored = rawStored && typeof rawStored === "object" && !Array.isArray(rawStored)
      ? rawStored as Partial<Record<ProtectionKey, boolean>>
      : {};
    const effectiveIdle = !isTauriRuntime() && !onIdleLockMinutesChange
      ? normalizeWorkspacePreferences(readStored(WORKSPACE_PREFS_KEY, DEFAULT_WORKSPACE_PREFERENCES)).idleLockMinutes
      : idleLockMinutes;
    return {
      maxOrderValue: storedBoolean(stored.maxOrderValue, INITIAL_PROTECTIONS.maxOrderValue),
      priceDeviation: storedBoolean(stored.priceDeviation, INITIAL_PROTECTIONS.priceDeviation),
      autoLock: effectiveIdle > 0 && storedBoolean(stored.autoLock, INITIAL_PROTECTIONS.autoLock),
      accountAllowlist: storedBoolean(stored.accountAllowlist, INITIAL_PROTECTIONS.accountAllowlist),
    };
  });
  const [warningKey, setWarningKey] = useState<ProtectionKey | null>(null);
  const [pendingKey, setPendingKey] = useState<ProtectionKey | null>(null);
  const [countdown, setCountdown] = useState(8);
  const [readToBottom, setReadToBottom] = useState(false);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState(false);
  const [disablePhrase, setDisablePhrase] = useState("");
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [clearDataDialogOpen, setClearDataDialogOpen] = useState(false);
  const [evidenceStatus, setEvidenceStatus] = useState<EvidenceState>({ kind: "idle" });
  const [exportPathNote, setExportPathNote] = useState<string | null>(null);
  const [vaultStatus, setVaultStatus] = useState<TauriVaultStatus | null>(null);
  const [publicQuotesEnabled, setPublicQuotesEnabled] = useState<boolean>(() => MOCK_BROKER.isPublicQuotesEnabled());
  const [quoteProvider, setQuoteProvider] = useState<PublicQuoteProviderChoice>(() =>
    !isTauriRuntime()
      ? normalizeWorkspacePreferences(readStored(WORKSPACE_PREFS_KEY, DEFAULT_WORKSPACE_PREFERENCES)).quoteProvider
      : "stooq",
  );
  const [quoteRefreshing, setQuoteRefreshing] = useState(false);
  const [quoteStatusMessage, setQuoteStatusMessage] = useState<string | null>(null);

  // C2: .fhvault encrypted backup & restore modal state
  const [backupModalMode, setBackupModalMode] = useState<"export" | "restore" | null>(null);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupPassphraseConfirm, setBackupPassphraseConfirm] = useState("");
  const [backupRawContent, setBackupRawContent] = useState("");
  const [backupFileName, setBackupFileName] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatusMessage, setBackupStatusMessage] = useState<string | null>(null);
  const [backupModalError, setBackupModalError] = useState<string | null>(null);

  // C2: App Lock passphrase modal state
  const [lockPassModalOpen, setLockPassModalOpen] = useState(false);
  const [currentLockPass, setCurrentLockPass] = useState("");
  const [newLockPass, setNewLockPass] = useState("");
  const [confirmLockPass, setConfirmLockPass] = useState("");
  const [lockPassBusy, setLockPassBusy] = useState(false);
  const [lockPassMessage, setLockPassMessage] = useState<string | null>(null);
  const [lockPassError, setLockPassError] = useState<string | null>(null);

  const lastNonZeroIdleMinutesRef = useRef<number>(localIdleMinutes > 0 ? localIdleMinutes : 15);
  const importInputRef = useRef<HTMLInputElement>(null);
  const fhvaultInputRef = useRef<HTMLInputElement>(null);
  const riskScrollRef = useRef<HTMLDivElement>(null);

  const settingsModalOpen =
    connectionDialogOpen
    || pendingKey !== null
    || clearDataDialogOpen
    || backupModalMode !== null
    || lockPassModalOpen;

  function persistProtections(next: Record<ProtectionKey, boolean>): void {
    void saveEncryptedSetting(PROTECTIONS_SETTING_KEY, next, "protections");
  }

  useEffect(() => {
    setLocalIdleMinutes(idleLockMinutes);
    if (idleLockMinutes > 0) {
      lastNonZeroIdleMinutesRef.current = idleLockMinutes;
    }
    setProtections((current) => {
      const nextAutoLock = idleLockMinutes > 0;
      return current.autoLock === nextAutoLock ? current : { ...current, autoLock: nextAutoLock };
    });
  }, [idleLockMinutes]);

  useEffect(() => {
    let active = true;

    const loadVaultProtections = async (idleMinutesOverride?: number) => {
      try {
        const rawStored = await loadEncryptedSetting<unknown>(PROTECTIONS_SETTING_KEY, {}, "protections");
        if (!active) return;
        const stored = rawStored && typeof rawStored === "object" && !Array.isArray(rawStored)
          ? rawStored as Partial<Record<ProtectionKey, boolean>>
          : {};
        const effectiveAutoLock = idleMinutesOverride !== undefined
          ? idleMinutesOverride > 0
          : storedBoolean(stored.autoLock, INITIAL_PROTECTIONS.autoLock);
        setProtections({
          maxOrderValue: storedBoolean(stored.maxOrderValue, INITIAL_PROTECTIONS.maxOrderValue),
          priceDeviation: storedBoolean(stored.priceDeviation, INITIAL_PROTECTIONS.priceDeviation),
          autoLock: effectiveAutoLock,
          accountAllowlist: storedBoolean(stored.accountAllowlist, INITIAL_PROTECTIONS.accountAllowlist),
        });
      } catch {
        // Keep current state cleanly if vault is locked or unavailable.
      }
    };

    if (isTauriRuntime()) {
      void loadWorkspacePreferences()
        .then((prefs) => {
          if (!active) return;
          setQuoteProvider(prefs.quoteProvider);
          setPublicQuotesEnabled(MOCK_BROKER.isPublicQuotesEnabled());
          if (prefs.idleLockMinutes > 0) {
            lastNonZeroIdleMinutesRef.current = prefs.idleLockMinutes;
          }
          if (!onIdleLockMinutesChange) setLocalIdleMinutes(prefs.idleLockMinutes);
          void loadVaultProtections(prefs.idleLockMinutes);
        })
        .catch(() => {
          void loadVaultProtections();
        });

      void invokeVaultStatus()
        .then((status) => {
          if (active) setVaultStatus(status);
        })
        .catch(() => undefined);
    }

    const onVaultHydrated = (event: Event) => {
      const detail = (event as CustomEvent<VaultHydrationResult>).detail;
      if (!active || !detail) return;
      if (detail.status) setVaultStatus(detail.status);
      setPublicQuotesEnabled(MOCK_BROKER.isPublicQuotesEnabled());
      if (detail.preferences) {
        setQuoteProvider(detail.preferences.quoteProvider);
        if (detail.preferences.idleLockMinutes > 0) {
          lastNonZeroIdleMinutesRef.current = detail.preferences.idleLockMinutes;
        }
        setLocalIdleMinutes(detail.preferences.idleLockMinutes);
        void loadVaultProtections(detail.preferences.idleLockMinutes);
      } else {
        void loadVaultProtections();
      }
    };

    window.addEventListener(VAULT_HYDRATED_EVENT, onVaultHydrated);
    return () => {
      active = false;
      window.removeEventListener(VAULT_HYDRATED_EVENT, onVaultHydrated);
    };
  }, [onIdleLockMinutesChange]);

  useEffect(() => {
    onModalStateChange(settingsModalOpen);
    return () => onModalStateChange(false);
  }, [onModalStateChange, settingsModalOpen]);

  async function handleVerifyEvidence(): Promise<void> {
    try {
      const result = await verifyEvidence();
      setEvidenceStatus(result.valid
        ? { kind: "valid", count: result.sequence }
        : { kind: "invalid", reason: result.reason });
    } catch {
      setEvidenceStatus({ kind: "invalid" });
    }
  }

  async function handleExportEvidence(): Promise<void> {
    try {
      const serialized = await exportEvidence();
      const outcome = await saveJsonWithDialogOrBlob("foliohelm-evidence-mock.json", serialized);
      if (outcome.kind === "native-saved") {
        setExportPathNote(copy.savedToPath(outcome.path));
      } else {
        setExportPathNote(null);
      }
      await handleVerifyEvidence();
    } catch {
      setEvidenceStatus({ kind: "invalid" });
    }
  }

  async function handleExportDiagnostics(): Promise<void> {
    try {
      const verification = await verifyEvidence();
      const diagnostics = {
        format: "foliohelm-safety-diagnostics",
        schemaVersion: 1,
        exportedAtUtc: new Date().toISOString(),
        runtime: isTauriRuntime() ? "tauri-desktop" : "browser-preview",
        workspaceMode: MOCK_BROKER.getWorkspaceMode(),
        publicQuotes: MOCK_BROKER.getPublicQuoteStatus(),
        vault: vaultStatus
          ? {
              unlocked: vaultStatus.unlocked,
              cipher: vaultStatus.cipher,
              schemaVersion: vaultStatus.schemaVersion,
              keyProvider: vaultStatus.keyProvider,
              evidenceCount: vaultStatus.evidenceCount,
              hasLocalPortfolio: vaultStatus.hasLocalPortfolio,
            }
          : null,
        evidenceVerification: verification,
        protections,
      };
      const outcome = await saveJsonWithDialogOrBlob(
        "foliohelm-safety-diagnostics.json",
        JSON.stringify(diagnostics, null, 2),
      );
      if (outcome.kind === "native-saved") {
        setExportPathNote(copy.savedToPath(outcome.path));
      }
    } catch {
      setEvidenceStatus({ kind: "invalid" });
    }
  }

  function handleTogglePublicQuotes(): void {
    const next = !publicQuotesEnabled;
    setPublicQuotesEnabled(next);
    MOCK_BROKER.setPublicQuotesEnabled(next);
    setQuoteStatusMessage(null);
    void saveWorkspacePreferences({ publicQuotesEnabled: next, quoteProvider });
    void appendEvidence("safety_setting_changed", {
      mode: MOCK_BROKER.getWorkspaceMode(),
      setting: "publicDelayedQuotes",
      enabled: String(next),
      provider: quoteProvider,
    }).catch(() => undefined);
  }

  function handleQuoteProviderChange(nextProvider: PublicQuoteProviderChoice): void {
    setQuoteProvider(nextProvider);
    void saveWorkspacePreferences({ quoteProvider: nextProvider });
  }

  function handleIdleLockChange(minutes: number): void {
    setLocalIdleMinutes(minutes);
    if (minutes > 0) {
      lastNonZeroIdleMinutesRef.current = minutes;
    }
    const nextAutoLock = minutes > 0;
    setProtections((current) => {
      if (current.autoLock === nextAutoLock) return current;
      const updated = { ...current, autoLock: nextAutoLock };
      persistProtections(updated);
      return updated;
    });
    onIdleLockMinutesChange?.(minutes);
    void saveWorkspacePreferences({ idleLockMinutes: minutes });
    void appendEvidence("safety_setting_changed", {
      mode: MOCK_BROKER.getWorkspaceMode(),
      setting: "idleAutoLockMinutes",
      minutes: String(minutes),
    }).catch(() => undefined);
  }

  async function handleRefreshPublicQuotes(): Promise<void> {
    if (!publicQuotesEnabled || quoteRefreshing) return;
    const epoch = getCurrentLockEpoch();
    setQuoteRefreshing(true);
    try {
      const result = await refreshPublicQuotes(quoteProvider);
      if (!isCurrentLockEpoch(epoch)) return;
      if (result.fromCache) {
        setQuoteStatusMessage(copy.publicQuotesFallback(result.degradedReason ?? result.provider));
      } else {
        const base = copy.publicQuotesUpdated(
          result.updatedCount,
          result.provider,
          result.asOfUtc ?? new Date().toISOString(),
        );
        setQuoteStatusMessage(result.degradedReason ? `${base} · ${result.degradedReason}` : base);
      }
    } catch (error) {
      if (!isCurrentLockEpoch(epoch)) return;
      setQuoteStatusMessage(copy.publicQuotesFallback(error instanceof Error ? error.message : String(error)));
    } finally {
      if (isCurrentLockEpoch(epoch)) {
        setQuoteRefreshing(false);
      }
    }
  }

  async function handleImportEvidence(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_EVIDENCE_IMPORT_BYTES) {
      setEvidenceStatus({
        kind: "invalid",
        reason: chinese
          ? "导入的证据文件超过 20 MB 安全上限"
          : "Evidence import file exceeds the 20 MB safety limit",
      });
      return;
    }
    try {
      const result = await importEvidence(await file.text());
      setEvidenceStatus({ kind: "valid", count: result.sequence });
    } catch (error) {
      setEvidenceStatus({ kind: "invalid", reason: error instanceof Error ? error.message : undefined });
    }
  }

  function closeBackupModal(): void {
    setBackupModalMode(null);
    setBackupPassphrase("");
    setBackupPassphraseConfirm("");
    setBackupRawContent("");
    setBackupFileName("");
    setBackupModalError(null);
    setBackupBusy(false);
  }

  async function handlePickFhvaultFile(): Promise<void> {
    setBackupModalError(null);
    if (isTauriRuntime()) {
      try {
        const opened = await invokeDialogOpenFhvaultFile();
        if (!opened) return;
        setBackupFileName(opened.fileName);
        setBackupRawContent(opened.content);
        return;
      } catch (error) {
        setBackupModalError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    fhvaultInputRef.current?.click();
  }

  async function handleFhvaultFileInputChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_EVIDENCE_IMPORT_BYTES) {
      setBackupModalError(
        chinese ? "所选 .fhvault 备份文件超过 20 MB 安全上限。" : "Selected .fhvault backup exceeds the 20 MB safety limit.",
      );
      return;
    }
    setBackupFileName(file.name);
    setBackupRawContent(await file.text());
  }

  async function handleExportFhvaultSubmit(): Promise<void> {
    setBackupModalError(null);
    if (backupPassphrase.length < 10) {
      setBackupModalError(
        chinese ? "迁移备份口令长度至少需要 10 位字符。" : "Backup passphrase must be at least 10 characters long.",
      );
      return;
    }
    if (backupPassphrase !== backupPassphraseConfirm) {
      setBackupModalError(
        chinese ? "两次输入的口令不一致。" : "Passphrases do not match.",
      );
      return;
    }
    if (!isTauriRuntime()) {
      setBackupModalError(
        chinese ? "浏览器预览模式不含加密 SQLite 金库，请在桌面端导出 .fhvault 备份。" : "Encrypted .fhvault export requires the desktop SQLite vault runtime.",
      );
      return;
    }
    setBackupBusy(true);
    const pass = backupPassphrase;
    setBackupPassphrase("");
    setBackupPassphraseConfirm("");
    try {
      const encryptedJson = await invokeVaultExportBackup(pass);
      const outcome = await saveFhvaultWithDialogOrBlob("foliohelm-vault-backup.fhvault", encryptedJson);
      if (outcome.kind === "native-saved") {
        setBackupStatusMessage(
          chinese ? `已使用 Argon2id + AES-256-GCM 加密导出至 ${outcome.path}` : `Encrypted backup saved to ${outcome.path}`,
        );
      } else if (outcome.kind === "browser-download") {
        setBackupStatusMessage(
          chinese ? "已生成加密 .fhvault 备份文件。" : "Encrypted .fhvault backup generated.",
        );
      }
      closeBackupModal();
    } catch (error) {
      setBackupModalError(error instanceof Error ? error.message : String(error));
      setBackupBusy(false);
    }
  }

  async function handleRestoreFhvaultSubmit(): Promise<void> {
    setBackupModalError(null);
    if (!backupRawContent) {
      setBackupModalError(
        chinese ? "请先选择一个 .fhvault 备份文件。" : "Please select a .fhvault backup file first.",
      );
      return;
    }
    if (!backupPassphrase) {
      setBackupModalError(
        chinese ? "请输入解密口令。" : "Please enter the backup passphrase.",
      );
      return;
    }
    if (!isTauriRuntime()) {
      setBackupModalError(
        chinese ? "浏览器预览模式不支持 .fhvault 金库恢复，请在桌面端执行。" : "Encrypted .fhvault restore requires the desktop SQLite vault runtime.",
      );
      return;
    }
    const epoch = getCurrentLockEpoch();
    setBackupBusy(true);
    const pass = backupPassphrase;
    setBackupPassphrase("");
    try {
      const summary = await invokeVaultRestoreBackup(backupRawContent, pass);
      if (!isCurrentLockEpoch(epoch)) {
        closeBackupModal();
        return;
      }
      const hydrated = await hydrateWorkspaceFromVault();
      if (!isCurrentLockEpoch(epoch)) {
        closeBackupModal();
        return;
      }
      if (hydrated.status) setVaultStatus(hydrated.status);
      setBackupStatusMessage(
        chinese
          ? `已验签并原子恢复金库（${summary.portfolioCount} 份持仓快照、${summary.paperOrderCount} 笔纸上订单、${summary.evidenceCount} 条签名证据）。`
          : `Verified and restored vault atomically (${summary.portfolioCount} snapshots, ${summary.paperOrderCount} paper orders, ${summary.evidenceCount} signed evidence entries).`,
      );
      closeBackupModal();
    } catch (error) {
      if (!isCurrentLockEpoch(epoch)) {
        closeBackupModal();
        return;
      }
      setBackupModalError(
        chinese
          ? `恢复失败（Fail-Closed，原加密库未被修改）：${error instanceof Error ? error.message : String(error)}`
          : `Restore failed (Fail-Closed; existing vault untouched): ${error instanceof Error ? error.message : String(error)}`,
      );
      setBackupBusy(false);
    }
  }

  function closeLockPassModal(): void {
    setLockPassModalOpen(false);
    setCurrentLockPass("");
    setNewLockPass("");
    setConfirmLockPass("");
    setLockPassError(null);
    setLockPassBusy(false);
  }

  async function handleSaveLockPassphrase(removeExisting = false): Promise<void> {
    setLockPassError(null);
    if (!isTauriRuntime()) {
      setLockPassError(
        chinese ? "桌面端才支持 Argon2id 锁屏口令保护。" : "Argon2id App Lock passphrases require the desktop runtime.",
      );
      return;
    }
    if (!removeExisting) {
      if (newLockPass.length < 10) {
        setLockPassError(
          chinese ? "锁屏口令长度至少需要 10 位字符。" : "Lock passphrase must be at least 10 characters.",
        );
        return;
      }
      if (newLockPass !== confirmLockPass) {
        setLockPassError(
          chinese ? "两次输入的新口令不一致。" : "New passphrases do not match.",
        );
        return;
      }
    }
    setLockPassBusy(true);
    const cur = currentLockPass || null;
    const next = removeExisting ? null : newLockPass;
    setCurrentLockPass("");
    setNewLockPass("");
    setConfirmLockPass("");
    try {
      const updated = await invokeVaultSetLockPassphrase(cur, next);
      setVaultStatus(updated);
      setLockPassMessage(
        removeExisting
          ? (chinese ? "已清除自定义锁屏口令（锁屏仍会擦除内存密钥）。" : "Custom lock passphrase removed (locking still wipes in-memory keys).")
          : (chinese ? "已通过 Argon2id 配置锁屏口令（明文绝不落盘）。" : "App Lock passphrase configured via Argon2id (never stored in plaintext)."),
      );
      closeLockPassModal();
    } catch (error) {
      setLockPassError(error instanceof Error ? error.message : String(error));
      setLockPassBusy(false);
    }
  }

  async function clearLocalData(): Promise<void> {
    const mode = MOCK_BROKER.getWorkspaceMode();
    await appendEvidence("state_changed", {
      mode,
      action: "local_data_reset_requested",
    }).catch(() => undefined);
    let preferencesCleared = false;
    const cleared = await clearEvidence(() => {
      preferencesCleared = clearFolioHelmStored();
      return preferencesCleared;
    });
    if (!cleared || !preferencesCleared) {
      setEvidenceStatus({ kind: "invalid", clearFailed: true });
      return;
    }
    if (isTauriRuntime()) {
      await invokeVaultClearAll().catch(() => undefined);
    }
    await clearPersistedLocalPortfolio().catch(() => undefined);
    MOCK_BROKER.reset();
    AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
    onLanguageChange(detectInitialLanguage());
    onThemeChange("system");
    onMockScenarioChange?.("healthy");
    setProtections({ ...INITIAL_PROTECTIONS });
    setLocalIdleMinutes(DEFAULT_WORKSPACE_PREFERENCES.idleLockMinutes);
    lastNonZeroIdleMinutesRef.current = DEFAULT_WORKSPACE_PREFERENCES.idleLockMinutes;
    setPublicQuotesEnabled(false);
    setQuoteStatusMessage(null);
    setExportPathNote(null);
    setEvidenceStatus({ kind: "valid", count: 0 });
    setClearDataDialogOpen(false);
  }

  const pendingDefinition = pendingKey === null
    ? undefined
    : definitions.find((definition) => definition.key === pendingKey);
  const needsDisablePhrase = pendingDefinition?.highRisk === true;
  const canConfirm = pendingKey !== null
    && countdown === 0
    && hasScrolledToBottom
    && readToBottom
    && confirmIntent
    && (!needsDisablePhrase || disablePhrase === "DISABLE");

  useEffect(() => {
    if (pendingKey === null) return undefined;

    const scrollBox = riskScrollRef.current;
    setHasScrolledToBottom(!scrollBox || scrollBox.scrollHeight <= scrollBox.clientHeight + 1);

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

  function handleRiskScroll(): void {
    const scrollBox = riskScrollRef.current;
    if (!scrollBox) return;
    if (scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 4) {
      setHasScrolledToBottom(true);
    }
  }

  function openDisableDialog(key: ProtectionKey): void {
    setPendingKey(key);
    setCountdown(8);
    setReadToBottom(false);
    setHasScrolledToBottom(false);
    setConfirmIntent(false);
    setDisablePhrase("");
  }

  function handleProtectionSwitch(key: ProtectionKey): void {
    if (protections[key]) {
      openDisableDialog(key);
      return;
    }

    const updated = { ...protections, [key]: true };
    setProtections(updated);
    persistProtections(updated);
    setWarningKey(null);
    if (key === "autoLock") {
      const restoredMinutes = lastNonZeroIdleMinutesRef.current > 0
        ? lastNonZeroIdleMinutesRef.current
        : DEFAULT_WORKSPACE_PREFERENCES.idleLockMinutes;
      setLocalIdleMinutes(restoredMinutes);
      onIdleLockMinutesChange?.(restoredMinutes);
      void saveWorkspacePreferences({ idleLockMinutes: restoredMinutes });
    }
    void appendEvidence("safety_setting_changed", {
      mode: MOCK_BROKER.getWorkspaceMode(),
      setting: key,
      enabled: "true",
      action: "enabled",
    }).catch(() => undefined);
  }

  function handleCancelDisable(): void {
    setPendingKey(null);
    setCountdown(8);
    setReadToBottom(false);
    setHasScrolledToBottom(false);
    setConfirmIntent(false);
    setDisablePhrase("");
  }

  function handleConfirmDisable(): void {
    if (!pendingKey || !canConfirm) return;

    const confirmedKey = pendingKey;
    const updated = { ...protections, [confirmedKey]: false };
    setProtections(updated);
    persistProtections(updated);
    setWarningKey(confirmedKey);
    if (confirmedKey === "autoLock") {
      if (localIdleMinutes > 0) {
        lastNonZeroIdleMinutesRef.current = localIdleMinutes;
      }
      setLocalIdleMinutes(0);
      onIdleLockMinutesChange?.(0);
      void saveWorkspacePreferences({ idleLockMinutes: 0 });
    }
    handleCancelDisable();
    void appendEvidence("safety_setting_changed", {
      mode: MOCK_BROKER.getWorkspaceMode(),
      setting: confirmedKey,
      enabled: "false",
      action: "disabled",
    }).catch(() => undefined);
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
        <div className="settings-vault-row" data-testid="vault-status-row">
          <strong>{copy.vaultStatusTitle}</strong>
          <span>
            {vaultStatus
              ? vaultStatus.unlocked
                ? copy.vaultUnlocked(vaultStatus.cipher, vaultStatus.keyProvider)
                : copy.vaultLocked(vaultStatus.lockedReason ?? "locked")
              : copy.vaultBrowserMode}
          </span>
        </div>

        <div className="settings-quotes-panel" data-testid="public-quotes-panel">
          <div className="settings-protection">
            <div className="settings-protection__copy">
              <div className="settings-protection__title-line">
                <strong>{copy.publicQuotesTitle}</strong>
                <span className="settings-badge settings-badge--warning">{copy.publicQuotesNotice}</span>
              </div>
              <span>{copy.publicQuotesBody}</span>
            </div>
            <button
              className={`settings-switch ${publicQuotesEnabled ? "is-on" : "is-off"}`}
              type="button"
              role="switch"
              data-testid="public-quotes-switch"
              aria-checked={publicQuotesEnabled}
              aria-label={copy.publicQuotesSwitch}
              onClick={handleTogglePublicQuotes}
            >
              <span className="settings-switch__thumb" aria-hidden="true" />
              <span>{publicQuotesEnabled ? copy.on : copy.off}</span>
            </button>
          </div>
          <div className="settings-quotes-controls">
            <label>
              <span>{copy.publicQuotesProvider}</span>
              <select
                className="settings-scenario-select"
                aria-label={copy.publicQuotesProvider}
                value={quoteProvider}
                onChange={(event) => handleQuoteProviderChange(event.target.value as PublicQuoteProviderChoice)}
              >
                <option value="stooq">Stooq (stooq.com)</option>
                <option value="yahoo">Yahoo Finance (query1.finance.yahoo.com)</option>
              </select>
            </label>
            <button
              className="settings-button settings-button--secondary"
              type="button"
              data-testid="refresh-public-quotes"
              disabled={!publicQuotesEnabled || quoteRefreshing}
              onClick={() => void handleRefreshPublicQuotes()}
            >
              {quoteRefreshing ? copy.publicQuotesRefreshing : copy.publicQuotesRefresh}
            </button>
          </div>
          {quoteStatusMessage && (
            <p className="settings-quote-status" role="status" data-testid="public-quotes-status">{quoteStatusMessage}</p>
          )}
        </div>

        <div className="settings-quotes-panel" data-testid="app-lock-panel">
          <div className="settings-protection">
            <div className="settings-protection__copy">
              <div className="settings-protection__title-line">
                <strong>{chinese ? "会话锁屏与自动锁定 (App Lock)" : "Session & idle App Lock"}</strong>
                <span className="settings-badge settings-badge--lime">
                  {vaultStatus?.hasLockPassphrase
                    ? (chinese ? "Argon2id 口令已启用" : "Argon2id passphrase active")
                    : (chinese ? "OS 密钥重校验" : "OS key re-verify")}
                </span>
              </div>
              <span>
                {chinese
                  ? "锁定后立即释放并 Zeroizing 擦除内存会话密钥、写入 Ed25519 签名锁屏证据并遮罩界面；解锁失败自动启用指数退避防爆破。"
                  : "Locking immediately wipes in-memory session keys via Zeroizing, writes an Ed25519 SessionLocked record, and enforces exponential backoff on failed unlocks."}
              </span>
            </div>
          </div>
          <div className="settings-quotes-controls">
            <label>
              <span>{chinese ? "空闲自动锁屏" : "Idle auto-lock"}</span>
              <select
                className="settings-scenario-select"
                data-testid="idle-lock-select"
                aria-label={chinese ? "空闲自动锁屏" : "Idle auto-lock"}
                value={String(localIdleMinutes)}
                onChange={(event) => handleIdleLockChange(Number(event.target.value))}
              >
                <option value="0">{chinese ? "关闭" : "Off"}</option>
                <option value="5">{chinese ? "5 分钟" : "5 minutes"}</option>
                <option value="15">{chinese ? "15 分钟" : "15 minutes"}</option>
                <option value="30">{chinese ? "30 分钟" : "30 minutes"}</option>
                <option value="60">{chinese ? "60 分钟" : "60 minutes"}</option>
              </select>
            </label>
            <button
              className="settings-button settings-button--secondary"
              type="button"
              data-testid="settings-lock-now"
              onClick={() => onLockSession?.("manual")}
            >
              {chinese ? "立即锁屏" : "Lock now"}
            </button>
            <button
              className="settings-button settings-button--secondary"
              type="button"
              data-testid="settings-configure-lock-passphrase"
              onClick={() => {
                setLockPassError(null);
                setLockPassModalOpen(true);
              }}
            >
              {vaultStatus?.hasLockPassphrase
                ? (chinese ? "修改/移除锁屏口令" : "Change / remove passphrase")
                : (chinese ? "设置锁屏口令" : "Set lock passphrase")}
            </button>
          </div>
          {lockPassMessage && (
            <p className="settings-quote-status" role="status" data-testid="lock-passphrase-status">{lockPassMessage}</p>
          )}
        </div>

        <div className="settings-quotes-panel" data-testid="fhvault-backup-panel">
          <div className="settings-protection">
            <div className="settings-protection__copy">
              <div className="settings-protection__title-line">
                <strong>{chinese ? ".fhvault 口令加密离线迁移备份" : ".fhvault passphrase-encrypted offline backup"}</strong>
                <span className="settings-badge settings-badge--lime">Argon2id + AES-256-GCM</span>
              </div>
              <span>
                {chinese
                  ? "使用 Argon2id + 随机 128-bit 盐 + AES-256-GCM + 格式版本 AAD 导出全库加密快照；恢复时先验签后原子替换，失败绝不破坏现有金库（≤ 20 MB）。"
                  : "Exports the entire vault encrypted with Argon2id + random 128-bit salt + AES-256-GCM + version AAD. Restore verifies signatures before atomic replacement; failure never harms your existing vault (max 20 MB)."}
              </span>
            </div>
          </div>
          <div className="settings-evidence-actions">
            <button
              className="settings-button settings-button--secondary"
              type="button"
              data-testid="fhvault-export-open"
              onClick={() => {
                setBackupModalError(null);
                setBackupModalMode("export");
              }}
            >
              {chinese ? "导出 .fhvault 备份" : "Export .fhvault backup"}
            </button>
            <button
              className="settings-button settings-button--secondary"
              type="button"
              data-testid="fhvault-restore-open"
              onClick={() => {
                setBackupModalError(null);
                setBackupModalMode("restore");
              }}
            >
              {chinese ? "验签并恢复 .fhvault" : "Verify & restore .fhvault"}
            </button>
            <input
              ref={fhvaultInputRef}
              className="settings-hidden-file"
              data-testid="fhvault-file-input"
              type="file"
              accept=".fhvault,application/json,.json"
              onChange={(event) => void handleFhvaultFileInputChange(event)}
            />
          </div>
          {backupStatusMessage && (
            <p className="settings-quote-status" role="status" data-testid="fhvault-backup-status">{backupStatusMessage}</p>
          )}
        </div>

        <div className="settings-evidence-row">
          <div>
            <strong>{copy.evidence}</strong>
            <span className={`settings-evidence-status settings-evidence-status--${evidenceStatus.kind}`} role="status">{evidenceStatusText(evidenceStatus, copy)}</span>
            {exportPathNote && (
              <span className="settings-export-path" data-testid="export-path-note">{exportPathNote}</span>
            )}
          </div>
          <div className="settings-evidence-actions">
            <button className="settings-button settings-button--secondary" type="button" onClick={() => void handleVerifyEvidence()}>{copy.verify}</button>
            <button className="settings-button settings-button--secondary" type="button" onClick={() => void handleExportEvidence()}>{copy.export}</button>
            <button className="settings-button settings-button--secondary" type="button" data-testid="export-diagnostics" onClick={() => void handleExportDiagnostics()}>{copy.exportDiagnostics}</button>
            <button className="settings-button settings-button--secondary" type="button" onClick={() => importInputRef.current?.click()}>{copy.import}</button>
            <input ref={importInputRef} className="settings-hidden-file" data-testid="evidence-import-input" type="file" accept="application/json,.json" onChange={(event) => void handleImportEvidence(event)} />
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

          <div
            ref={riskScrollRef}
            className="settings-risk-scroll"
            data-testid="risk-details-scroll"
            role="region"
            aria-label={copy.riskDetails}
            tabIndex={0}
            onScroll={handleRiskScroll}
          >
            <h3>{copy.riskDetails}</h3>
            <p>{copy.riskDetailOne}</p>
            <p>{copy.riskDetailTwo}</p>
            <p>{copy.riskDetailThree}</p>
          </div>

          <label className="settings-check-line">
            <input
              type="checkbox"
              checked={readToBottom}
              disabled={!hasScrolledToBottom}
              onChange={(event) => setReadToBottom(event.target.checked)}
            />
            <span>{copy.readDetails}</span>
          </label>
          {!hasScrolledToBottom && (
            <p className="settings-scroll-hint" data-testid="risk-scroll-hint">{copy.scrollToBottomHint}</p>
          )}

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
            <button className="settings-button settings-button--danger" type="button" onClick={() => void clearLocalData()}>{copy.confirmClear}</button>
          </div>
        </Modal>
      )}

      {backupModalMode !== null && (
        <Modal
          className="settings-modal"
          backdropClassName="settings-modal-backdrop"
          labelledBy="settings-fhvault-modal-title"
          testId={backupModalMode === "export" ? "fhvault-export-modal" : "fhvault-restore-modal"}
          onClose={closeBackupModal}
        >
          <span className="settings-badge settings-badge--lime">Argon2id + AES-256-GCM</span>
          <h2 id="settings-fhvault-modal-title">
            {backupModalMode === "export"
              ? (chinese ? "导出加密 .fhvault 迁移备份" : "Export encrypted .fhvault backup")
              : (chinese ? "验签并恢复 .fhvault 迁移备份" : "Verify & restore .fhvault backup")}
          </h2>
          <p>
            {backupModalMode === "export"
              ? (chinese
                ? "请设置至少 10 位强口令。口令绝不落盘或写入日志，请务必妥善离线保管。"
                : "Choose a strong passphrase (at least 10 characters). It is never written to disk or logs.")
              : (chinese
                ? "恢复前会校验 Argon2id + AES-256-GCM 认证标签与整条 Ed25519 证据链签名；任何校验失败都会 Fail-Closed 终止且不改动现有金库。"
                : "AES-256-GCM authentication and full Ed25519 evidence verification run before any replacement; failures leave your current vault untouched.")}
          </p>

          {backupModalMode === "restore" && (
            <div className="settings-quotes-controls">
              <button
                type="button"
                className="settings-button settings-button--secondary"
                data-testid="fhvault-choose-file"
                onClick={() => void handlePickFhvaultFile()}
              >
                {chinese ? "选择 .fhvault 文件" : "Choose .fhvault file"}
              </button>
              {backupFileName && <span data-testid="fhvault-selected-name">{backupFileName}</span>}
            </div>
          )}

          <label className="settings-field">
            <span>{chinese ? "加密/解密口令（≥ 10 位）" : "Passphrase (min 10 chars)"}</span>
            <input
              type="password"
              data-testid="fhvault-passphrase-input"
              autoComplete="new-password"
              value={backupPassphrase}
              onChange={(event) => setBackupPassphrase(event.target.value)}
            />
          </label>

          {backupModalMode === "export" && (
            <label className="settings-field">
              <span>{chinese ? "确认口令" : "Confirm passphrase"}</span>
              <input
                type="password"
                data-testid="fhvault-passphrase-confirm"
                autoComplete="new-password"
                value={backupPassphraseConfirm}
                onChange={(event) => setBackupPassphraseConfirm(event.target.value)}
              />
            </label>
          )}

          {backupModalError && (
            <p className="settings-warning" role="alert" data-testid="fhvault-modal-error">
              {backupModalError}
            </p>
          )}

          <div className="settings-modal__actions">
            <button className="settings-button settings-button--secondary" type="button" onClick={closeBackupModal}>
              {copy.cancel}
            </button>
            <button
              className="settings-button settings-button--primary"
              type="button"
              data-testid="fhvault-modal-submit"
              disabled={backupBusy}
              onClick={() =>
                void (backupModalMode === "export" ? handleExportFhvaultSubmit() : handleRestoreFhvaultSubmit())
              }
            >
              {backupBusy
                ? (chinese ? "处理中…" : "Processing…")
                : backupModalMode === "export"
                  ? (chinese ? "加密并导出" : "Encrypt & export")
                  : (chinese ? "验签并恢复" : "Verify & restore")}
            </button>
          </div>
        </Modal>
      )}

      {lockPassModalOpen && (
        <Modal
          className="settings-modal"
          backdropClassName="settings-modal-backdrop"
          labelledBy="settings-lock-pass-title"
          testId="lock-passphrase-modal"
          onClose={closeLockPassModal}
        >
          <span className="settings-badge settings-badge--lime">App Lock · Argon2id</span>
          <h2 id="settings-lock-pass-title">
            {chinese ? "配置会话锁屏口令" : "Configure App Lock passphrase"}
          </h2>
          <p>
            {chinese
              ? "系统仅保存 Argon2id 盐与哈希校验器，绝不明文保存口令。"
              : "Only an Argon2id salt + verifier hash is stored; plaintext passphrases are never persisted or logged."}
          </p>

          {vaultStatus?.hasLockPassphrase && (
            <label className="settings-field">
              <span>{chinese ? "当前锁屏口令" : "Current passphrase"}</span>
              <input
                type="password"
                data-testid="lock-pass-current"
                autoComplete="current-password"
                value={currentLockPass}
                onChange={(event) => setCurrentLockPass(event.target.value)}
              />
            </label>
          )}

          <label className="settings-field">
            <span>{chinese ? "新锁屏口令（≥ 10 位）" : "New passphrase (min 10 chars)"}</span>
            <input
              type="password"
              data-testid="lock-pass-new"
              autoComplete="new-password"
              value={newLockPass}
              onChange={(event) => setNewLockPass(event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>{chinese ? "确认新口令" : "Confirm new passphrase"}</span>
            <input
              type="password"
              data-testid="lock-pass-confirm"
              autoComplete="new-password"
              value={confirmLockPass}
              onChange={(event) => setConfirmLockPass(event.target.value)}
            />
          </label>

          {lockPassError && (
            <p className="settings-warning" role="alert" data-testid="lock-pass-error">
              {lockPassError}
            </p>
          )}

          <div className="settings-modal__actions">
            <button className="settings-button settings-button--secondary" type="button" onClick={closeLockPassModal}>
              {copy.cancel}
            </button>
            {vaultStatus?.hasLockPassphrase && (
              <button
                className="settings-button settings-button--danger"
                type="button"
                data-testid="lock-pass-remove"
                disabled={lockPassBusy}
                onClick={() => void handleSaveLockPassphrase(true)}
              >
                {chinese ? "移除口令" : "Remove passphrase"}
              </button>
            )}
            <button
              className="settings-button settings-button--primary"
              type="button"
              data-testid="lock-pass-save"
              disabled={lockPassBusy}
              onClick={() => void handleSaveLockPassphrase(false)}
            >
              {lockPassBusy ? (chinese ? "保存中…" : "Saving…") : (chinese ? "保存锁屏口令" : "Save passphrase")}
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
