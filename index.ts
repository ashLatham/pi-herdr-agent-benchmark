// agent-benchmark — Pi extension that runs a YAML-defined test suite against
// multiple provider/model combos.
//
// Entry point: TUI command `/agent-benchmark <suite-folder> [retry_test]`
//   - `retry_test` (optional, default `0`): when `1`, a first-attempt FAIL on
//     a test gives the benchmark-agent one retry. The retry uses the same
//     bench session (no `/new`, no `/model`) and reuses the same output
//     filename; the attempt-0 outputs are renamed to `<file>_0.md`. The
//     retry's verdict is final.
//
// Suite folder layout:
//
//   <suite>/
//     models.yaml            # top-level `models:` list, one entry per line
//     tests/                 # one YAML per test, iterated in sorted order
//       001_trivial.yaml
//       002_*.yaml
//     results/               # bench-agent output, wiped at run start
//     eval/                  # eval-agent output, wiped at run start
//
// Per test YAML: `prompt:` and `evaluator_prompt:`. The test file's basename
// (without .yaml) is used as the output filename in results/ and eval/.
//
// Two long-lived herdr panes owned by the extension:
//   - benchmark-agent (cwd: /home/ash/.pi/sub-agents/benchmark-agent/)
//   - eval-agent      (cwd: /home/ash/.pi/sub-agents/benchmark-eval/)
//
// Per (model, test) pair:
//   B1. /new on bench-agent  → settle 3s
//   B2. /model <modelName>   → settle 3s
//   B3. Send task prompt with absolute results/<safeName(model)>-<base>.md path
//   B4. Wait for results file; nudge once if agent idle but file missing
//   E1. /new on eval-agent   → settle 3s
//   E2. Send eval prompt with absolute eval/<safeName(model)>-<base>.md path
//   E3. Wait for eval file; nudge once if needed; parse VERDICT/REASON
//
// _progress.json lives at <suite>/_progress.json. No per-test archive — the
// results/ and eval/ folders are the artifacts.

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, renameSync, statSync } from "node:fs";
import { join as pathJoin, dirname as pathDirname, extname as pathExtname, basename as pathBasename } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---- constants ----

const SETTLE_AFTER_NEW_MS = 3_000;
const SETTLE_AFTER_MODEL_MS = 3_000;
const FILE_POLL_INTERVAL_MS = 1_000;
// Number of file-missing nudges to send before giving up on a test. Each
// nudge is a single reminder message; we wait indefinitely for the file to
// appear between nudges.
const NUDGE_MAX = 1;

const BENCH_PANE_NAME = "benchmark-agent";
const EVAL_PANE_NAME = "benchmark-eval";
const BENCH_PANE_CWD = "/home/ash/.pi/sub-agents/benchmark-agent/";
const EVAL_PANE_CWD = "/home/ash/.pi/sub-agents/benchmark-eval/";

// All agent sessions live here. The per-pane subfolder name is derived from
// the pane's cwd via cwdToSessionsDirName().
const SESSIONS_ROOT = "/home/ash/.pi/agent/sessions";

// ---- types ----

interface TestConfig {
	filePath: string;       // absolute path to the test YAML
	baseName: string;      // basename without .yaml, e.g. "001_trivial"
	id: string;             // human-readable id from the YAML (falls back to baseName)
	prompt: string;
	evaluator_prompt: string;
}

interface TestTokens {
	total_tokens: number;       // cumulative context size at end of bench phase
	non_cached_tokens: number;   // fresh input + output for this test only
}

interface TestResult {
	model: string;
	test_id: string;
	duration_ms: number;       // sourced from session log (last timestamp − first user msg)
	verdict: string;
	reason: string;
	tokens?: TestTokens;
}

interface ModelTokensTotals {
	total: number;              // last test's total_tokens (cumulative context size)
	non_cached: number;         // sum across tests
}

interface ModelTotals {
	duration_ms: number;
	tests: number;
	passed: number;
	failed: number;
	tokens: ModelTokensTotals;
	tokens_per_second: number;   // non_cached / (duration_ms / 1000); 0 if duration is 0
}

interface ProgressEntry {
	completed: number;
	total: number;
	ran: number;
	passed: number;
	failed: number;
	current?: {
		model: string;
		test_id: string;
		status: string;
		verdict: string;
		duration_ms: number;
		tokens?: TestTokens;
	};
	results: TestResult[];
	model_totals: Record<string, ModelTotals>;
	errors?: string[];
	done?: boolean;
}

// ---- herdr CLI wrapper ----

function herdr(args: string[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn("herdr", args, { shell: false, windowsHide: true });
		} catch (e) {
			reject(new Error(`failed to spawn herdr: ${(e as Error).message}`));
			return;
		}
		let out = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("error", (e) => {
			reject(new Error(`herdr spawn failed: ${(e as Error).message}`));
		});
		child.on("close", (code) => {
			if (code !== 0 && !out.trim()) {
				reject(new Error(`herdr exited ${code}: ${stderr.trim() || "(no stderr)"}`));
				return;
			}
			const parsed = parseLastJson(out);
			if (parsed !== null) {
				const env = parsed as { error?: { message?: string }; result?: unknown };
				if (env.error) {
					reject(new Error(`herdr error: ${env.error.message ?? "(unknown)"}`));
					return;
				}
				resolve(env.result ?? env);
				return;
			}
			resolve({});
		});
	});
}

function parseLastJson(s: string): unknown | null {
	const text = s.trim();
	if (!text) return null;
	try { return JSON.parse(text); } catch { /* scan */ }
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Compute non-cached tokens per second of bench duration. Returns 0 when
 *  duration is 0 (e.g. setup error never produced a session log). */
function tokensPerSecond(nonCachedTokens: number, durationMs: number): number {
	if (durationMs <= 0) return 0;
	return nonCachedTokens / (durationMs / 1000);
}

/** Format a duration in ms as `HH:MM:SS.mmm`. */
function formatDuration(ms: number): string {
	const totalMs = Math.max(0, Math.round(ms));
	const hours = Math.floor(totalMs / 3_600_000);
	const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
	const seconds = Math.floor((totalMs % 60_000) / 1_000);
	const millis = totalMs % 1_000;
	return (
		String(hours).padStart(2, "0") + ":" +
		String(minutes).padStart(2, "0") + ":" +
		String(seconds).padStart(2, "0") + "." +
		String(millis).padStart(3, "0")
	);
}

/** Sanitize a model name (e.g. "ash/adversary_...-Quality") to a safe
 *  filename segment. */
function safeName(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Convert an absolute cwd like "/home/ash/.pi/sub-agents/benchmark-agent"
 *  to the matching session folder name "--home-ash-.pi-sub-agents-benchmark-agent--".
 *  Leading and trailing slashes are dropped so we don't produce extra dashes. */
function cwdToSessionsDirName(cwd: string): string {
	const stripped = cwd.replace(/^\/+|\/+$/g, "");
	return `--${stripped.replace(/\//g, "-")}--`;
}

// ---- session log token extraction ----

/** Read the most recent session JSONL in `sessionsDir` and extract token totals.
 *  Each `/new` creates a fresh session file, so the most-recent-by-mtime file
 *  corresponds 1:1 to the test currently being measured. Returns null if no
 *  session file exists yet, or no assistant turn has been recorded.
 *
 *  `total_tokens` = the `totalTokens` from the last assistant turn (provider's
 *  cumulative cost-bearing token count at end of test).
 *  `non_cached_tokens` = sum of (input + output + reasoning) across all
 *  assistant turns in this session — the tokens the model actively processed
 *  to produce its answer. Cache reads (`cacheRead`) are excluded because they
 *  aren't regenerated work. */
async function readSessionTokens(sessionsDir: string): Promise<{ total_tokens: number; non_cached_tokens: number } | null> {
	const newest = await findNewestSessionFile(sessionsDir);
	if (!newest) return null;

	// Try the newest file first; if it has no assistant turn yet (JSONL flush
	// race), sleep briefly and retry. Also retry on transient read errors.
	for (let attempt = 0; attempt < 3; attempt++) {
		let lastTotal = 0;
		let nonCached = 0;
		let sawAssistant = false;
		try {
			const raw = readFileSync(newest, "utf8");
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let entry: Record<string, unknown>;
				try { entry = JSON.parse(trimmed); } catch { continue; }
				if (entry.type !== "message") continue;
				const msg = entry.message as Record<string, unknown> | undefined;
				if (!msg || msg.role !== "assistant") continue;
				const usage = msg.usage as { input?: number; output?: number; reasoning?: number; totalTokens?: number } | undefined;
				if (!usage) continue;
				sawAssistant = true;
				nonCached += (usage.input ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0);
				if (typeof usage.totalTokens === "number") lastTotal = usage.totalTokens;
			}
		} catch {
			// fall through; will retry
		}
		if (sawAssistant) {
			return { total_tokens: lastTotal, non_cached_tokens: nonCached };
		}
		if (attempt < 2) await sleep(300);
	}
	return null;
}

/** Find the newest JSONL session file in `sessionsDir`. Shared between
 *  readSessionTokens and readSessionDuration so we don't stat the dir twice
 *  per test. Returns null if no file exists. */
async function findNewestSessionFile(sessionsDir: string): Promise<string | null> {
	if (!existsSync(sessionsDir)) return null;
	let entries: { name: string; mtime: number }[];
	try {
		entries = readdirSync(sessionsDir)
			.filter((n) => n.endsWith(".jsonl"))
			.map((name) => {
				let mtime = 0;
				try { mtime = statSync(pathJoin(sessionsDir, name)).mtime.getTime(); } catch { /* ignore */ }
				return { name, mtime };
			})
			.filter((e) => e.mtime > 0);
	} catch { return null; }
	if (!entries.length) return null;
	entries.sort((a, b) => b.mtime - a.mtime);
	return pathJoin(sessionsDir, entries[0].name);
}

/** Read the most recent session JSONL and compute duration as
 *  `max(timestamp across all entries) − timestamp of first role:user message`.
 *  Only the first role:user is taken — retries (which are also role:user
 *  messages appended later in the same session file) must not shift the
 *  start forward, otherwise duration collapses to just the retry window.
 *  `max` rather than `last line` because JSONL flush order isn't guaranteed
 *  chronological. Returns null if no session file exists, no user message
 *  found, or first-user timestamp is missing/unparseable. Retries up to 3
 *  times with 300ms sleep for the JSONL flush race. */
async function readSessionDuration(sessionsDir: string): Promise<number | null> {
	const newest = await findNewestSessionFile(sessionsDir);
	if (!newest) return null;
	for (let attempt = 0; attempt < 3; attempt++) {
		let firstUserTs: number | null = null;
		let maxTs: number | null = null;
		let sawUser = false;
		try {
			const raw = readFileSync(newest, "utf8");
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let entry: Record<string, unknown>;
				try { entry = JSON.parse(trimmed); } catch { continue; }
				// Track the global max timestamp across every entry.
				const ts = entry.timestamp;
				if (typeof ts === "string") {
					const ms = Date.parse(ts);
					if (!Number.isNaN(ms)) {
						if (maxTs === null || ms > maxTs) maxTs = ms;
					}
				}
				// First role:user message anchors the start. Only take it on the
				// first hit so retries (which are also role:user messages but
				// later in the file) don't shift the start time forward.
				if (entry.type !== "message") continue;
				const msg = entry.message as Record<string, unknown> | undefined;
				if (!msg || msg.role !== "user") continue;
				if (firstUserTs !== null) continue;
				if (typeof ts === "string") {
					const ms = Date.parse(ts);
					if (!Number.isNaN(ms)) {
						firstUserTs = ms;
						sawUser = true;
					}
				}
			}
		} catch {
			if (attempt < 2) { await sleep(300); continue; }
			return null;
		}
		if (sawUser && firstUserTs !== null && maxTs !== null && maxTs >= firstUserTs) {
			return maxTs - firstUserTs;
		}
		if (sawUser && attempt < 2) { await sleep(300); continue; }
		if (sawUser) return 0; // user message seen but max landed before it (clock skew); record zero
		if (attempt < 2) await sleep(300);
	}
	return null;
}

// ---- file + status polling ----

async function checkStatus(target: string): Promise<string | null> {
	try {
		const r = await herdr(["agent", "get", target]) as Record<string, unknown>;
		const agent = (r.agent as Record<string, unknown>) ?? r;
		const status = agent.agent_status ?? agent.status;
		return typeof status === "string" ? status : null;
	} catch {
		return null;
	}
}

interface FileWaitResult {
	ok: boolean;
	nudged: boolean;
}

/** Wait for `filePath` to exist while polling agent status. If the agent reaches
 *  idle/done but the file is still missing, send a one-shot reminder. Returns
 *  after the file appears, or after NUDGE_MAX reminders with no file. The
 *  reminder's premise ("file does not exist") is checked live, so it can
 *  never go stale. */
async function waitForFileWithReminder(
	paneId: string,
	filePath: string,
	expectedFileHint: string,
): Promise<FileWaitResult> {
	let nudged = 0;
	while (true) {
		if (existsSync(filePath)) {
			return { ok: true, nudged: nudged > 0 };
		}
		const status = await checkStatus(paneId);
		if (status === "idle" || status === "done") {
			if (nudged >= NUDGE_MAX) {
				return { ok: false, nudged: true };
			}
			await sendPrompt(
				paneId,
				`REMINDER: Your previous response should have been written to \`${expectedFileHint}\` using the write tool, but that file does not exist yet. Please use the write tool NOW to save your full response to that exact path. Do not respond in chat — only the file write counts.`,
			);
			nudged++;
			continue;
		}
		await sleep(FILE_POLL_INTERVAL_MS);
	}
}

// ---- YAML parsing ----

/** Read a single-key top-level `models:` list. Empty/missing returns []. */
function parseModelsYaml(path: string): string[] {
	const raw = readFileSync(path, "utf8");
	const out: string[] = [];
	let inModels = false;
	for (const rawLine of raw.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (!rawLine.match(/^\s+/)) {
			inModels = /^models\s*:/.test(trimmed);
			continue;
		}
		if (inModels && trimmed.startsWith("- ")) {
			out.push(trimmed.slice(2).trim().replace(/^["']|['"]$/g, ""));
		}
	}
	return out;
}

/** Strip a single matched pair of surrounding `"` or `'` from a scalar value. */
function unquote(v: string): string {
	const t = v.trim();
	if (t.length >= 2) {
		const first = t[0];
		const last = t[t.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return t.slice(1, -1);
		}
	}
	return t;
}

/** Indent of a line: count leading spaces. Tabs not supported. */
function indentOf(line: string): number {
	let n = 0;
	while (n < line.length && line[n] === " ") n++;
	return n;
}

/** Read a test YAML: optional `id:`, required `prompt:`, required `evaluator_prompt:`.
 *  Supports plain scalars, single/double-quoted scalars, and `|` (literal)
 *  block scalars for multi-line values. Top-level keys only — nested maps not
 *  supported and not needed by this suite. */
function parseTestYaml(path: string, baseName: string): TestConfig {
	const raw = readFileSync(path, "utf8");
	const lines = raw.split("\n");
	const fields: Record<string, string> = {};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = /^([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1];
		const rest = m[2];
		// Block scalar: `|` (literal) only. We don't need `>` (folded) for tests.
		if (/^\|\s*(?:#.*)?$/.test(rest)) {
			const blockLines: string[] = [];
			let blockIndent = -1;
			for (let j = i + 1; j < lines.length; j++) {
				const bl = lines[j];
				if (bl.trim() === "") { blockLines.push(""); continue; } // preserve blank lines within block
				const ind = indentOf(bl);
				if (ind === 0 && bl.trim() !== "") break; // next top-level key
				if (blockIndent === -1) blockIndent = ind;
				if (ind < blockIndent) break;
				blockLines.push(bl.slice(blockIndent));
			}
			fields[key] = blockLines.join("\n").replace(/\n+$/, "");
			continue;
		}
		fields[key] = unquote(rest);
	}
	if (!fields.prompt) throw new Error(`test '${baseName}' missing required field: prompt`);
	if (!fields.evaluator_prompt) throw new Error(`test '${baseName}' missing required field: evaluator_prompt`);
	return {
		filePath: path,
		baseName,
		id: fields.id || baseName,
		prompt: fields.prompt,
		evaluator_prompt: fields.evaluator_prompt,
	};
}

function discoverTests(suiteDir: string): TestConfig[] {
	const testsDir = pathJoin(suiteDir, "tests");
	const entries = readdirSync(testsDir, { withFileTypes: true });
	const yamlFiles = entries
		.filter((e) => e.isFile() && pathExtname(e.name).toLowerCase() === ".yaml")
		.map((e) => e.name)
		.sort();
	return yamlFiles.map((name) => {
		const baseName = name.slice(0, -pathExtname(name).length);
		return parseTestYaml(pathJoin(testsDir, name), baseName);
	});
}

// ---- suite validation ----

function validateSuite(suiteDir: string): { ok: true; models: string[]; tests: TestConfig[] } | { ok: false; error: string } {
	if (!existsSync(suiteDir)) return { ok: false, error: `suite folder not found: ${suiteDir}` };
	const modelsPath = pathJoin(suiteDir, "models.yaml");
	if (!existsSync(modelsPath)) return { ok: false, error: `missing models.yaml in ${suiteDir}` };
	const testsDir = pathJoin(suiteDir, "tests");
	if (!existsSync(testsDir)) return { ok: false, error: `missing tests/ in ${suiteDir}` };
	let models: string[];
	let tests: TestConfig[];
	try { models = parseModelsYaml(modelsPath); }
	catch (e) { return { ok: false, error: `models.yaml parse failed: ${(e as Error).message}` }; }
	if (!models.length) return { ok: false, error: `models.yaml has no models` };
	try { tests = discoverTests(suiteDir); }
	catch (e) { return { ok: false, error: `tests/ parse failed: ${(e as Error).message}` }; }
	if (!tests.length) return { ok: false, error: `tests/ has no .yaml files` };
	return { ok: true, models, tests };
}

// ---- pane management ----

interface PaneInfo {
	paneId: string;
	workspaceId: string;
}

async function findAgentByName(label: string): Promise<{ paneId: string; workspaceId: string } | null> {
	const listR = await herdr(["agent", "list"]) as Record<string, unknown>;
	const agentsList = (Array.isArray(listR) ? listR : listR.agents ?? []) as Record<string, unknown>[];
	const existing = agentsList.find((a) =>
		a.name === label || String(a.name ?? "").toLowerCase() === label.toLowerCase(),
	);
	if (!existing) return null;
	const paneId = String(existing.pane_id ?? "");
	if (!paneId) return null;
	return { paneId, workspaceId: String(existing.workspace_id ?? "") };
}

async function createPane(label: string, cwd: string): Promise<{ paneId: string; workspaceId: string }> {
	const createW = await herdr(["workspace", "create", "--label", label, "--cwd", cwd]);
	const wr = createW as Record<string, unknown>;
	const workspaceId = String((wr.workspace as Record<string, unknown>)?.workspace_id ?? wr.workspace_id ?? "");
	if (!workspaceId) throw new Error(`workspace create for '${label}' returned no workspace_id: ${JSON.stringify(createW)}`);

	const createT = await herdr(["tab", "create", "--workspace", workspaceId, "--label", label, "--cwd", cwd]);
	const tr = createT as Record<string, unknown>;
	const paneId = String((tr.root_pane as Record<string, unknown>)?.pane_id ?? "");
	if (!paneId) throw new Error(`tab create for '${label}' returned no root_pane.pane_id: ${JSON.stringify(createT)}`);

	await herdr(["agent", "start", label, "--kind", "pi", "--pane", paneId]);

	await waitForStatus(paneId, ["idle"]);

	return { paneId, workspaceId };
}

async function ensurePane(label: string, cwd: string): Promise<{ paneId: string; workspaceId: string }> {
	const existing = await findAgentByName(label);
	if (existing) return existing;
	return await createPane(label, cwd);
}

// ---- progress tracking ----

function writeProgress(path: string, entry: ProgressEntry): void {
	// TODO: write to <path>.tmp then rename, so a kill mid-write can't corrupt
	// _progress.json. Low priority — current risk is small.
	mkdirSync(pathDirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(entry, null, 2) + "\n");
}

/** Record a test that aborted before producing a verdict (pane failed to
 *  settle, etc). Synthesises a FAIL TestResult and updates model totals +
 *  progress so the test is accounted for in the final summary. */
function recordSetupFailure(
	ran: number,
	total: number,
	modelName: string,
	testId: string,
	results: TestResult[],
	modelTotals: Record<string, ModelTotals>,
	progressPath: string,
	error: string,
	opts: { ctx: ExtensionCommandContext; passed: number; failed: number; errors: string[] },
): void {
	opts.errors.push(error);

	results.push({
		model: modelName,
		test_id: testId,
		duration_ms: 0,
		verdict: "FAIL",
		reason: error,
	});

	const mt: ModelTotals = modelTotals[modelName] ?? {
		duration_ms: 0,
		tests: 0,
		passed: 0,
		failed: 0,
		tokens: { total: 0, non_cached: 0 },
		tokens_per_second: 0,
	};
	mt.tests += 1;
	mt.failed += 1;
	opts.failed += 1;
	modelTotals[modelName] = mt;

	updateAndNotify(progressPath, {
		completed: ran,
		total,
		ran,
		passed: opts.passed,
		failed: opts.failed,
		results,
		model_totals: modelTotals,
		current: {
			model: modelName,
			test_id: testId,
			status: "FAIL",
			verdict: "FAIL",
			duration_ms: 0,
		},
	}, opts.ctx);
}

// ---- main flow ----

interface AttemptResult {
	verdict: "PASS" | "FAIL";
	reason: string;
}

interface RunState {
	errors: string[];
	results: TestResult[];
	modelTotals: Record<string, ModelTotals>;
	ran: number;
	passed: number;
	failed: number;
	total: number;
	progressPath: string;
	retryTest: boolean;
}

/** Issue the retry prompt for a failed first attempt: rename prior files,
 *  re-send the bench prompt with a "try again" suffix (no /new, no /model),
 *  run eval again, and return the final attempt result. The retry's verdict
 *  is final — no further retries. */
async function runRetry(
	benchPaneId: string,
	evalPaneId: string,
	test: TestConfig,
	resultsFile: string,
	evalFile: string,
	state: RunState,
	modelName: string,
	ran: number,
	ctx: ExtensionCommandContext,
): Promise<AttemptResult> {
	// Rename prior outputs to *_0.md so the retry can reuse the original paths.
	const resultsZero = `${resultsFile.slice(0, -3)}_0.md`;
	const evalZero = `${evalFile.slice(0, -3)}_0.md`;
	if (existsSync(resultsFile)) renameSync(resultsFile, resultsZero);
	if (existsSync(evalFile)) renameSync(evalFile, evalZero);

	ctx.ui.notify(
		`[${ran}/${state.total}] retrying ${modelName} × ${test.id} after FAIL`,
		"info",
	);

	// Re-send bench prompt with retry suffix. No /new, no /model — continuing
	// the same session so duration + tokens cover both attempts. The "try again"
	// line leads so the agent sees the nudge before re-reading its previous prompt.
	const retryPrompt = `You provided an incorrect answer! Please try again.\n\n${test.prompt}\n\nWrite your full response to ${resultsFile}. Do not print the response in chat. Only write it to that file.`;
	await sendPrompt(benchPaneId, retryPrompt);

	const benchWait = await waitForFileWithReminder(benchPaneId, resultsFile, resultsFile);
	if (!benchWait.ok) {
		state.errors.push(`${modelName}/${test.id}: bench agent did not write results file after ${NUDGE_MAX} reminder(s) (retry)`);
		return { verdict: "FAIL", reason: "bench results file missing (retry)" };
	}

	const responseText = readFileSync(resultsFile, "utf8");

	// ---- /new on eval-agent, then eval prompt ----
	await sendPrompt(evalPaneId, "/new");
	const evalNewOk = await waitForStatus(evalPaneId, ["idle", "done"]);
	if (!evalNewOk) {
		return { verdict: "FAIL", reason: "eval pane didn't reach idle/done after /new (retry)" };
	}
	await sleep(SETTLE_AFTER_NEW_MS);

	const evalPrompt = `${test.evaluator_prompt}\n\nResponse to evaluate:\n---\n${responseText}\n---\n\nWrite your verdict to ${evalFile}. Format:\nVERDICT: PASS|FAIL\nREASON: <one sentence>`;
	await sendPrompt(evalPaneId, evalPrompt);

	const evalWait = await waitForFileWithReminder(evalPaneId, evalFile, evalFile);
	if (!evalWait.ok) {
		state.errors.push(`${modelName}/${test.id}: eval agent did not write verdict file after ${NUDGE_MAX} reminder(s) (retry)`);
	}

	let verdict: "PASS" | "FAIL" = "FAIL";
	let reason = "";
	if (existsSync(evalFile)) {
		const evalText = readFileSync(evalFile, "utf8");
		const vp = /VERDICT:\s*(PASS|FAIL)/i.exec(evalText);
		if (vp) verdict = vp[1].toUpperCase() as "PASS" | "FAIL";
		const rp = /REASON:\s*(.+)$/im.exec(evalText);
		reason = rp?.[1]?.trim() ?? "(no reason)";
	} else {
		reason = "eval file missing (retry)";
	}

	return { verdict, reason };
}

async function runBenchmark(suiteDir: string, retryTest: boolean, ctx: ExtensionCommandContext): Promise<void> {
	const settledDir = suiteDir.endsWith("/") ? suiteDir : suiteDir + "/";
	const v = validateSuite(settledDir);
	if (!v.ok) {
		ctx.ui.notify(`agent-benchmark: ${v.error}`, "error");
		return;
	}
	const { models, tests } = v;

	const resultsDir = pathJoin(settledDir, "results");
	const evalDir = pathJoin(settledDir, "eval");

	// Wipe output folders so every test starts with no leftover files.
	for (const dir of [resultsDir, evalDir]) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
	}

	const retryNote = retryTest ? " (retry_test=1)" : "";
	ctx.ui.notify(`agent-benchmark: starting (${models.length} models × ${tests.length} tests)${retryNote}`, "info");

	const progressPath = pathJoin(settledDir, "_progress.json");
	const total = models.length * tests.length;
	writeProgress(progressPath, {
		completed: 0,
		total,
		ran: 0,
		passed: 0,
		failed: 0,
		results: [],
		model_totals: {},
	});

	// Open eval-agent pane first (needed every test)
	ctx.ui.notify("agent-benchmark: opening eval-agent pane...", "info");
	const evalPane = await ensurePane(EVAL_PANE_NAME, EVAL_PANE_CWD);
	ctx.ui.notify(`agent-benchmark: eval-agent ready (pane ${evalPane.paneId})`, "info");

	let benchPane: PaneInfo | null = null;
	const state: RunState = {
		errors: [],
		results: [],
		modelTotals: {},
		ran: 0,
		passed: 0,
		failed: 0,
		total,
		progressPath,
		retryTest,
	};

	for (const modelName of models) {
		if (!benchPane) {
			ctx.ui.notify("agent-benchmark: opening benchmark-agent pane...", "info");
			benchPane = await ensurePane(BENCH_PANE_NAME, BENCH_PANE_CWD);
		}

		for (const test of tests) {
			const fileBase = `${safeName(modelName)}-${test.baseName}`;
			const resultsFile = pathJoin(resultsDir, `${fileBase}.md`);
			const evalFile = pathJoin(evalDir, `${fileBase}.md`);

			state.ran++;

			// ---- B1: /new on bench-agent ----
			await sendPrompt(benchPane.paneId, "/new");
			const benchNewOk = await waitForStatus(benchPane.paneId, ["idle", "done"]);
			if (!benchNewOk) {
				recordSetupFailure(state.ran, state.total, modelName, test.id, state.results, state.modelTotals, state.progressPath,
					`${modelName}/${test.id}: bench pane didn't reach idle/done after /new`,
					{ ctx, passed: state.passed, failed: state.failed, errors: state.errors });
				continue;
			}
			await sleep(SETTLE_AFTER_NEW_MS);

			// ---- B2: /model <provider/model> ----
			await sendPrompt(benchPane.paneId, "/model " + modelName);
			const modelOk = await waitForStatus(benchPane.paneId, ["idle", "done"]);
			if (!modelOk) {
				recordSetupFailure(state.ran, state.total, modelName, test.id, state.results, state.modelTotals, state.progressPath,
					`${modelName}/${test.id}: bench pane didn't reach idle/done after /model ${modelName}`,
					{ ctx, passed: state.passed, failed: state.failed, errors: state.errors });
				continue;
			}
			await sleep(SETTLE_AFTER_MODEL_MS);

			// ---- B3: send task prompt (attempt 1) ----
			const taskPrompt = `${test.prompt}\n\nWrite your full response to ${resultsFile}. Do not print the response in chat. Only write it to that file.`;
			ctx.ui.notify(`[${state.ran}/${state.total}] agent-benchmark: running ${modelName} × ${test.id}`, "info");
			await sendPrompt(benchPane.paneId, taskPrompt);

			// ---- B4: wait for results file (with a single nudge if it stalls) ----
			const benchWait = await waitForFileWithReminder(benchPane.paneId, resultsFile, resultsFile);
			if (!benchWait.ok) {
				state.errors.push(`${modelName}/${test.id}: bench agent did not write results file after ${NUDGE_MAX} reminder(s)`);
			}

			const responseText = existsSync(resultsFile) ? readFileSync(resultsFile, "utf8") : "";

			let verdict: "PASS" | "FAIL";
			let reason: string;

			if (!benchWait.ok) {
				// No eval — there's nothing to judge. The first-attempt verdict is
				// FAIL; if retry is enabled, we'll fall through to the retry block
				// below which will produce a final verdict.
				verdict = "FAIL";
				reason = "bench results file missing";
			} else {
				// ---- E1: /new on eval-agent ----
				await sendPrompt(evalPane.paneId, "/new");
				const evalNewOk = await waitForStatus(evalPane.paneId, ["idle", "done"]);
				if (!evalNewOk) {
					verdict = "FAIL";
					reason = "eval pane didn't reach idle/done after /new";
				} else {
					await sleep(SETTLE_AFTER_NEW_MS);

					// ---- E2: send eval prompt ----
					const evalPrompt = `${test.evaluator_prompt}\n\nResponse to evaluate:\n---\n${responseText}\n---\n\nWrite your verdict to ${evalFile}. Format:\nVERDICT: PASS|FAIL\nREASON: <one sentence>`;
					await sendPrompt(evalPane.paneId, evalPrompt);

					// ---- E3: wait for eval file ----
					const evalWait = await waitForFileWithReminder(evalPane.paneId, evalFile, evalFile);
					if (!evalWait.ok) {
						state.errors.push(`${modelName}/${test.id}: eval agent did not write verdict file after ${NUDGE_MAX} reminder(s)`);
					}

					verdict = "FAIL";
					reason = "";
					if (existsSync(evalFile)) {
						const evalText = readFileSync(evalFile, "utf8");
						const vp = /VERDICT:\s*(PASS|FAIL)/i.exec(evalText);
						if (vp) verdict = vp[1].toUpperCase() as "PASS" | "FAIL";
						const rp = /REASON:\s*(.+)$/im.exec(evalText);
						reason = rp?.[1]?.trim() ?? "(no reason)";
					} else {
						reason = "eval file missing";
					}
				}
			}

			// ---- Retry on first-attempt FAIL when enabled ----
			if (state.retryTest && verdict === "FAIL") {
				const retry = await runRetry(
					benchPane.paneId,
					evalPane.paneId,
					test,
					resultsFile,
					evalFile,
					state,
					modelName,
					state.ran,
					ctx,
				);
				verdict = retry.verdict;
				reason = retry.reason;
			}

			// ---- Read duration/tokens AFTER any retry so the session log covers
			// both attempts (no /new between them). ----
			const sessionsDir = pathJoin(SESSIONS_ROOT, cwdToSessionsDirName(BENCH_PANE_CWD));
			const [durationFromLog, tokens] = await Promise.all([
				readSessionDuration(sessionsDir),
				readSessionTokens(sessionsDir),
			]);
			const durationMs = durationFromLog ?? 0;
			if (durationFromLog === null) {
				ctx.ui.notify(`agent-benchmark: duration read failed (no session file or user msg in ${pathBasename(sessionsDir)})`, "warning");
			}
			if (!tokens) {
				ctx.ui.notify(`agent-benchmark: token read failed (no assistant turn in ${pathBasename(sessionsDir)})`, "warning");
			}

			if (verdict === "PASS") state.passed++;
			if (verdict === "FAIL") state.failed++;

			const result: TestResult = {
				model: modelName,
				test_id: test.id,
				duration_ms: durationMs,
				verdict,
				reason,
				...(tokens ? { tokens } : {}),
			};
			state.results.push(result);

			const mt: ModelTotals = state.modelTotals[modelName] ?? {
				duration_ms: 0,
				tests: 0,
				passed: 0,
				failed: 0,
				tokens: { total: 0, non_cached: 0 },
				tokens_per_second: 0,
			};
			mt.duration_ms += durationMs;
			mt.tests += 1;
			if (verdict === "PASS") mt.passed += 1;
			if (verdict === "FAIL") mt.failed += 1;
			if (tokens) {
				mt.tokens.non_cached += tokens.non_cached_tokens;
				mt.tokens.total = tokens.total_tokens; // last test wins (cumulative context)
			}
			mt.tokens_per_second = tokensPerSecond(mt.tokens.non_cached, mt.duration_ms);
			state.modelTotals[modelName] = mt;

			updateAndNotify(state.progressPath, {
				completed: state.ran,
				total: state.total,
				ran: state.ran,
				passed: state.passed,
				failed: state.failed,
				results: state.results,
				model_totals: state.modelTotals,
				current: {
					model: modelName,
					test_id: test.id,
					status: verdict,
					verdict,
					duration_ms: durationMs,
					...(tokens ? { tokens } : {}),
				},
			}, ctx);
		}
	}

	const modelLines = Object.entries(state.modelTotals).map(([m, t]) => {
		return `  ${m}: ${t.tests} tests, ${t.passed} passed, ${t.failed} failed, ${formatDuration(t.duration_ms)}, tokens ${t.tokens.non_cached}, ${t.tokens_per_second.toFixed(1)} tok/s`;
	});

	const summaryTimestamp = new Date();

	const summaryPath = writeSummaryFile(settledDir, {
		timestamp: summaryTimestamp,
		models,
		total: state.total,
		ran: state.ran,
		passed: state.passed,
		failed: state.failed,
		modelLines,
		errors: state.errors,
		resultsDir,
		evalDir,
		results: state.results,
		retryTest: state.retryTest,
	});

	// TUI summary mirrors the markdown file. The path is included so the user
	// can open the full breakdown (failed tests, file contents) directly.
	// The first line gets warning colour on failures so it's scannable; the
	// rest stays dim/info so it's not visually shouting.
	const summaryBody = [
		`Total: ${state.total} | Ran: ${state.ran}`,
		`Passed: ${state.passed} | Failed: ${state.failed}`,
		`Per-model totals:`,
		...modelLines,
		`Results: ${resultsDir}`,
		`Evals: ${evalDir}`,
		`Summary: ${summaryPath}`,
		state.errors.length > 0 ? `\nErrors:\n${state.errors.join("\n")}` : "",
	].join("\n");
	if (state.failed > 0) {
		ctx.ui.notify("agent-benchmark: done.", "warning");
		ctx.ui.notify(summaryBody, "info");
	} else {
		ctx.ui.notify(`agent-benchmark: done.\n${summaryBody}`, "info");
	}
}

// ---- summary file ----

interface SummaryInput {
	timestamp: Date;
	models: string[];
	total: number;
	ran: number;
	passed: number;
	failed: number;
	modelLines: string[];
	errors: string[];
	resultsDir: string;
	evalDir: string;
	results: TestResult[];
	retryTest: boolean;
}

/** Pad to 2 digits. */
function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Build the summary filename. `HH:mm` (24h) as requested. */
function summaryFileName(d: Date): string {
	const stamp =
		d.getFullYear().toString() +
		pad2(d.getMonth() + 1) +
		pad2(d.getDate()) +
		"_" +
		pad2(d.getHours()) +
		":" +
		pad2(d.getMinutes());
	return `summary-${stamp}.md`;
}

/** Format a failed-test block with the contents of both result and eval files. */
function formatFailedTestBlock(suiteDir: string, r: TestResult): string {
	const fileBase = `${safeName(r.model)}-${r.test_id}`;
	const resultsRel = pathJoin("results", `${fileBase}.md`);
	const evalRel = pathJoin("eval", `${fileBase}.md`);
	// When a retry happened, attempt-0 outputs were renamed to *_0.md so the
	// final attempt overwrote the bare paths. Surface both when present.
	const resultsRel0 = pathJoin("results", `${fileBase}_0.md`);
	const evalRel0 = pathJoin("eval", `${fileBase}_0.md`);
	const resultsAbs = pathJoin(suiteDir, resultsRel);
	const evalAbs = pathJoin(suiteDir, evalRel);
	const resultsAbs0 = pathJoin(suiteDir, resultsRel0);
	const evalAbs0 = pathJoin(suiteDir, evalRel0);
	const resultsContent = existsSync(resultsAbs) ? readFileSync(resultsAbs, "utf8") : "(file missing)";
	const evalContent = existsSync(evalAbs) ? readFileSync(evalAbs, "utf8") : "(file missing)";
	const resultsContent0 = existsSync(resultsAbs0) ? readFileSync(resultsAbs0, "utf8") : null;
	const evalContent0 = existsSync(evalAbs0) ? readFileSync(evalAbs0, "utf8") : null;
	const lines: string[] = [
		`### ${r.model} × ${r.test_id} — FAIL`,
		``,
		`- **Verdict:** ${r.verdict}`,
		r.reason ? `- **Reason:** ${r.reason}` : ``,
		`- **Duration:** ${formatDuration(r.duration_ms)}`,
		r.tokens ? `- **Tokens:** ${r.tokens.non_cached_tokens}` : ``,
		``,
	];
	if (resultsContent0 !== null) {
		lines.push(`#### ${resultsRel0} (attempt 0)`);
		lines.push(``);
		lines.push("```");
		lines.push(resultsContent0.trimEnd());
		lines.push("```");
		lines.push(``);
	}
	lines.push(`#### ${resultsRel}${resultsContent0 !== null ? " (final attempt)" : ""}`);
	lines.push(``);
	lines.push("```");
	lines.push(resultsContent.trimEnd());
	lines.push("```");
	lines.push(``);
	if (evalContent0 !== null) {
		lines.push(`#### ${evalRel0} (attempt 0)`);
		lines.push(``);
		lines.push("```");
		lines.push(evalContent0.trimEnd());
		lines.push("```");
		lines.push(``);
	}
	lines.push(`#### ${evalRel}${evalContent0 !== null ? " (final attempt)" : ""}`);
	lines.push(``);
	lines.push("```");
	lines.push(evalContent.trimEnd());
	lines.push("```");
	lines.push(``);
	return lines.join("\n");
}

/** Write summary markdown to the suite root. Returns the absolute path of
 *  the written file so callers can reference it (e.g. in the TUI summary). */
function writeSummaryFile(suiteDir: string, s: SummaryInput): string {
	const failedBlocks = s.results
		.filter((r) => r.verdict === "FAIL")
		.map((r) => formatFailedTestBlock(suiteDir, r));

	const lines: string[] = [];
	lines.push(`# agent-benchmark summary`);
	lines.push(``);
	lines.push(`- **Run at:** ${s.timestamp.toISOString()}`);
	lines.push(`- **Suite:** \`${suiteDir}\``);
	lines.push(`- **Models:** ${s.models.map((m) => `\`${m}\``).join(", ")}`);
	lines.push(`- **Tests:** ${s.total} total, ${s.ran} ran, ${s.passed} passed, ${s.failed} failed`);
	lines.push(`- **Retry on FAIL:** ${s.retryTest ? "enabled (one retry per test)" : "disabled"}`);
	lines.push(``);
	lines.push(`## TUI summary`);
	lines.push(``);
	lines.push("```");
	lines.push(`Total: ${s.total} | Ran: ${s.ran}`);
	lines.push(`Passed: ${s.passed} | Failed: ${s.failed}`);
	lines.push(`Per-model totals:`);
	lines.push(...s.modelLines);
	lines.push(`Results: ${s.resultsDir}`);
	lines.push(`Evals: ${s.evalDir}`);
	if (s.errors.length > 0) {
		lines.push("");
		lines.push("Errors:");
		lines.push(...s.errors);
	}
	lines.push("```");
	lines.push("");

	if (failedBlocks.length > 0) {
		lines.push(`## Failed tests (${failedBlocks.length})`);
		lines.push(``);
		lines.push(...failedBlocks);
	}

	const content = lines.join("\n");
	const target = pathJoin(suiteDir, summaryFileName(s.timestamp));
	mkdirSync(pathDirname(target), { recursive: true });
	writeFileSync(target, content);
	return target;
}

function updateAndNotify(progressPath: string, progress: ProgressEntry, ctx: ExtensionCommandContext): void {
	writeProgress(progressPath, progress);
	const c = progress.current;
	if (!c?.model || !c?.test_id) return;
	const status = c.verdict ?? c.status ?? "?";
	const tail = c.duration_ms != null ? `, ${formatDuration(c.duration_ms)}` : "";
	const tokTail = c.tokens
		? `, tokens ${c.tokens.non_cached_tokens}, ${tokensPerSecond(c.tokens.non_cached_tokens, c.duration_ms ?? 0).toFixed(1)} tok/s`
		: "";
	ctx.ui.notify(
		`[${progress.completed}/${progress.total}] ${c.model} × ${c.test_id}: ${status}${tail}${tokTail}`,
		status === "PASS" ? "info" : status === "FAIL" ? "warning" : "info",
	);
}

// ---- helpers ----

async function sendPrompt(target: string, text: string): Promise<void> {
	// For LLM-bound prompts, `--wait --until working` confirms the agent received
	// the input and started processing. Without it, a follow-up `waitForStatus
	// ["idle","done"]` would race past the actual work.
	//
	// For UI control commands (`/new`, `/model`) the agent doesn't transition to
	// working — it processes them inline. So we submit those without --wait and
	// rely on a follow-up waitForStatus(["idle","done"]) to confirm completion.
	const isControlCmd = text.startsWith("/new") || text.startsWith("/model");
	const args = isControlCmd
		? ["agent", "prompt", target, text]
		: ["agent", "prompt", target, text, "--wait", "--until", "working"];
	await herdr(args);
}

async function waitForStatus(target: string, statuses: string[]): Promise<boolean> {
	try {
		await herdr(["agent", "wait", target, ...statuses.flatMap((s) => ["--until", s])]);
		return true;
	} catch {
		return false;
	}
}

// Internal exports for testing.
export const __test = { parseModelsYaml, parseTestYaml, discoverTests, validateSuite, safeName, formatDuration };

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify("agent-benchmark extension loaded", "info");
	});

	pi.registerCommand("agent-benchmark", {
		description:
			"Run a folder-based test suite against provider/model combos. Suite layout: models.yaml, tests/*.yaml, results/, eval/. Use: /agent-benchmark <suite-folder> [retry_test]",
		handler: async (args, ctx) => {
			try {
				const tokens = args.trim().split(/\s+/).filter(Boolean);
				if (tokens.length === 0 || tokens.length > 2) {
					ctx.ui.notify("Usage: /agent-benchmark <suite-folder> [retry_test]", "error");
					return;
				}
				const suiteDir = tokens[0];
				let retryTest = false;
				if (tokens.length === 2) {
					const flag = tokens[1];
					if (flag !== "0" && flag !== "1") {
						ctx.ui.notify("retry_test must be 0 or 1", "error");
						return;
					}
					retryTest = flag === "1";
				}
				await runBenchmark(suiteDir, retryTest, ctx);
			} catch (e) {
				ctx.ui.notify(
					`agent-benchmark failed: ${(e as Error).message ?? e}`,
					"error",
				);
			}
		},
	});
}
