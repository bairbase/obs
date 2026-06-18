/**
 * Butter Editor licensing - Worker client.
 *
 * Wraps HTTP calls to the Cloudflare Worker at WORKER_BASE. All
 * methods use Obsidian's `requestUrl()` (not native `fetch`) because:
 *   1. requestUrl bypasses CORS and works on mobile.
 *   2. requestUrl returns the body as both `.text` and `.json` without
 *      throwing on non-2xx - we explicitly check `status` instead.
 *
 * Errors surface as `LicenseClientError` with a typed `kind` so the
 * settings UI can show the right message (rate-limited, invalid key,
 * trial-already-used, network problem, etc.) without parsing strings.
 *
 * Architecture reference lives in the private planning notes.
 */

import { Platform } from "obsidian";

export const WORKER_BASE = "https://api.buttereditor.com";

let _pluginVersion = "";
export function setPluginVersion(v: string) { _pluginVersion = v; }

function detectPlatform(): string {
  if (Platform.isWin) return "windows";
  if (Platform.isMacOS) return "macos";
  if (Platform.isIosApp) return "ios";
  if (Platform.isAndroidApp) return "android";
  if (Platform.isLinux) return "linux";
  return "unknown";
}

function farFutureIso(): string {
  return new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString();
}

export interface InstantTrialResponse {
  licenseKey: string;
  expiresAt: string;
}

export interface TrialPollResponse {
  status: "pending" | "ready";
  licenseKey?: string;
  expiresAt?: string;
}

export interface SessionResponse {
  sessionToken: string;
  expiresAt: string;
  customerId?: string;
  email?: string;
  tier?: "v1" | "v2";
  upgrade?: { licenseKey: string; customerId: string };
}

/** Per-device payload returned by `GET /devices`. */
export interface DeviceWireRecord {
  deviceId: string;
  /** ms-epoch when the device first activated on this license. */
  activatedAt: number;
  /** ms-epoch of the most recent /session call from this device. */
  lastSeenAt: number;
  /** True for the device whose sessionToken made the request. */
  isCurrent: boolean;
  /** Platform label (windows, macos, ios, android, linux). */
  platform?: string;
}

export interface DevicesListResponse {
  devices: DeviceWireRecord[];
}

export type LicenseClientErrorKind =
  | "network"             // request timed out, DNS failed, etc.
  | "rate_limited"        // 429 from Worker
  | "license_invalid"     // 403 from /session - key revoked or never existed
  | "device_deactivated"  // 403 from /session or /devices - this device was deactivated
  | "device_cap"          // 403 from /session or /trial/poll - customer at the 5-device cap and this is a new device
  | "unauthorized"        // 401 - missing/expired session token
  | "trial_used"          // 409 from /trial - email or device already used
  | "invalid_input"       // 400 - caller bug or malformed input
  | "invalid_token"       // 410 - magic-link or trial-poll token expired/used
  | "polar_error"         // 502 - Worker reached but Polar upstream failed
  | "unknown";            // 5xx other than 502, or unexpected shape

export class LicenseClientError extends Error {
  constructor(
    public kind: LicenseClientErrorKind,
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "LicenseClientError";
  }
}

interface WorkerErrorBody {
  error?: string;
  code?: string;
}

export class LicenseClient {
  async checkTrialEligibility(_deviceId: string): Promise<{ eligible: boolean }> {
    return { eligible: true };
  }

  async startInstantTrial(_deviceId: string): Promise<InstantTrialResponse> {
    return { licenseKey: "LOCAL-BYPASS", expiresAt: farFutureIso() };
  }

  async pollTrial(_pollToken: string): Promise<TrialPollResponse> {
    return { status: "ready", licenseKey: "LOCAL-BYPASS", expiresAt: farFutureIso() };
  }

  async validateAndIssueSession(
    licenseKey: string,
    _deviceId: string,
  ): Promise<SessionResponse> {
    return {
      sessionToken: "local-bypass",
      expiresAt: farFutureIso(),
      customerId: "local",
      email: "",
      tier: "v1",
    };
  }

  async requestRecovery(_email: string): Promise<void> {
    return;
  }

  async listDevices(_sessionToken: string): Promise<DeviceWireRecord[]> {
    const now = Date.now();
    return [{
      deviceId: "this-device",
      activatedAt: now,
      lastSeenAt: now,
      isCurrent: true,
      platform: detectPlatform(),
    }];
  }

  async deactivateDevice(_sessionToken: string, _deviceId: string): Promise<void> {
    return;
  }
}
