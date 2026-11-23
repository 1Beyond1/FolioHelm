import { useEffect, useState, type FormEvent } from "react";
import type { Language } from "../types";
import { Icon } from "./Icons";

export interface LockScreenProps {
  language: Language;
  trigger: "manual" | "idle";
  hasPassphrase: boolean;
  lockedAtUtc: string | null;
  retryAfterSeconds: number;
  retryNonce?: number;
  errorMessage: string | null;
  locking?: boolean;
  unlocking: boolean;
  onUnlock: (passphrase: string) => Promise<void>;
}

const COPY = {
  en: {
    eyebrow: "Session locked · Keys zeroized",
    title: "FolioHelm is locked",
    manualReason: "Locked manually. In-memory session keys have been wiped and a signed SessionLocked event was recorded.",
    idleReason: "Locked automatically after inactivity. In-memory session keys have been wiped and a signed SessionLocked event was recorded.",
    passphraseLabel: "App Lock passphrase",
    passphrasePlaceholder: "Enter passphrase to unlock",
    noPassphraseHint: "No custom passphrase is set. Click unlock to re-verify your OS Credential Manager key and resume.",
    unlock: "Unlock vault",
    locking: "Locking…",
    unlocking: "Verifying…",
    backoff: (seconds: number) => `Too many failed attempts. Wait ${seconds}s before retrying.`,
    lockedAt: "Locked at",
    securityNote: "Passphrases are verified via Argon2id in constant time and are never written to disk or logs.",
  },
  zh: {
    eyebrow: "会话已锁定 · 内存密钥已擦除",
    title: "FolioHelm 已锁屏",
    manualReason: "已手动锁定。内存中的会话密钥已通过 Zeroizing 擦除，并写入 Ed25519 签名锁屏证据。",
    idleReason: "空闲超时已自动锁定。内存中的会话密钥已通过 Zeroizing 擦除，并写入 Ed25519 签名锁屏证据。",
    passphraseLabel: "锁屏解锁口令",
    passphrasePlaceholder: "请输入解锁口令",
    noPassphraseHint: "尚未配置自定义锁屏口令。点击解锁将重新校验操作系统凭证密钥并恢复会话。",
    unlock: "解锁金库",
    locking: "正在锁定…",
    unlocking: "正在校验…",
    backoff: (seconds: number) => `失败次数过多，请等待 ${seconds} 秒后重试。`,
    lockedAt: "锁定时间",
    securityNote: "口令仅用于 Argon2id 常量时间校验，绝不落盘或写入日志。",
  },
} as const;

export function LockScreen({
  language,
  trigger,
  hasPassphrase,
  lockedAtUtc,
  retryAfterSeconds,
  retryNonce = 0,
  errorMessage,
  locking = false,
  unlocking,
  onUnlock,
}: LockScreenProps) {
  const copy = COPY[language];
  const [passphrase, setPassphrase] = useState("");
  const [countdown, setCountdown] = useState(retryAfterSeconds);

  useEffect(() => {
    setCountdown(retryAfterSeconds);
  }, [retryAfterSeconds, retryNonce]);

  const isCountingDown = countdown > 0;
  useEffect(() => {
    if (!isCountingDown) return undefined;
    const timer = window.setInterval(() => {
      setCountdown((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isCountingDown]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (locking || unlocking || countdown > 0) return;
    const current = passphrase;
    setPassphrase("");
    await onUnlock(current);
  }

  return (
    <div
      className="app-lock-overlay"
      data-testid="app-lock-screen"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-lock-title"
    >
      <div className="app-lock-card">
        <div className="app-lock-icon" aria-hidden="true">
          <Icon name="lock" />
        </div>
        <p className="app-lock-eyebrow">{copy.eyebrow}</p>
        <h1 id="app-lock-title">{copy.title}</h1>
        <p className="app-lock-reason">
          {trigger === "idle" ? copy.idleReason : copy.manualReason}
        </p>
        {lockedAtUtc && (
          <p className="app-lock-meta">
            {copy.lockedAt}: <code>{lockedAtUtc}</code>
          </p>
        )}

        <form className="app-lock-form" onSubmit={(event) => void handleSubmit(event)}>
          {hasPassphrase ? (
            <label className="app-lock-field">
              <span>{copy.passphraseLabel}</span>
              <input
                type="password"
                data-testid="app-lock-passphrase-input"
                aria-label={copy.passphraseLabel}
                placeholder={copy.passphrasePlaceholder}
                autoComplete="current-password"
                autoFocus
                value={passphrase}
                disabled={locking || unlocking || countdown > 0}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
          ) : (
            <p className="app-lock-hint">{copy.noPassphraseHint}</p>
          )}

          {countdown > 0 && (
            <p className="app-lock-error" role="alert" data-testid="app-lock-backoff">
              {copy.backoff(countdown)}
            </p>
          )}

          {errorMessage && countdown === 0 && (
            <p className="app-lock-error" role="alert" data-testid="app-lock-error">
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            className="app-lock-submit"
            data-testid="app-lock-unlock-button"
            disabled={locking || unlocking || countdown > 0 || (hasPassphrase && passphrase.length === 0)}
          >
            {locking ? copy.locking : unlocking ? copy.unlocking : copy.unlock}
          </button>
        </form>

        <small className="app-lock-note">{copy.securityNote}</small>
      </div>
    </div>
  );
}
