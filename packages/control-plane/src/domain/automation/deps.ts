/**
 * The automation subsystem's deps contract, declared once so every module in
 * this directory agrees on what the world outside it can provide.
 */
import type { AppDeps } from "../../deps.js";

/** The world this module reaches into — a strict subset of `AppDeps`. */
export type AutomationDeps = Pick<AppDeps, "db" | "clock" | "gitHost">;

/** The sweep needs one more piece of per-process state: the schedule watermark. */
export type AutomationSweepDeps = AutomationDeps & { scheduleWatermark: { minute: string | null } };
