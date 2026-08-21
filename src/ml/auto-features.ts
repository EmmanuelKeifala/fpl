import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fixture, Player } from '../api/types.js';
import type { MlShadowConfig } from './config.js';
import {
  validateLiveFeatureSidecar,
  type LiveFeaturePredictor,
  type LiveFeatureSidecar,
} from './live-features.js';

const MAX_SIDECAR_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export interface MlFeatureSidecarSource {
  path: string;
  raw: string;
  generated: boolean;
}

export interface MlFeatureExpectation {
  season: string;
  gameweek: number;
  fixtures: readonly Fixture[];
  players: readonly Pick<Player, 'id' | 'team' | 'element_type'>[];
}

type Generator = (options: {
  pythonBinary: string;
  scriptPath: string;
  season: string;
  gameweek: number;
  outputPath: string;
  timeoutMs: number;
}) => Promise<void>;

export async function ensureAutomaticFeatureSidecar(
  config: MlShadowConfig,
  predictor: LiveFeaturePredictor,
  expected: MlFeatureExpectation,
  generate: Generator = runPythonFeatureGenerator
): Promise<MlFeatureSidecarSource> {
  if (!config.enabled || !config.autoGenerateFeatures) {
    throw new Error('Automatic ML feature generation is not enabled');
  }
  if (!config.featureDirectory || !config.pythonBinary || !config.featureScriptPath || !config.generationTimeoutMs) {
    throw new Error('Automatic ML feature generation configuration is incomplete');
  }

  const gameweekDirectory = join(
    config.featureDirectory,
    expected.season,
    `gw-${String(expected.gameweek).padStart(2, '0')}`
  );
  const outputPath = join(gameweekDirectory, 'features.json');
  const existing = await readAndValidate(outputPath, predictor, expected).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[ML SHADOW] Cached feature sidecar is unusable; regenerating: ${errorMessage(error)}`);
    }
    return null;
  });
  if (existing) return { path: outputPath, raw: existing, generated: false };

  await mkdir(gameweekDirectory, { recursive: true });
  const temporaryPath = join(
    gameweekDirectory,
    `features.${process.pid}.${Date.now()}.tmp.json`
  );
  try {
    await generate({
      pythonBinary: config.pythonBinary,
      scriptPath: config.featureScriptPath,
      season: expected.season,
      gameweek: expected.gameweek,
      outputPath: temporaryPath,
      timeoutMs: config.generationTimeoutMs,
    });
    const raw = await readAndValidate(temporaryPath, predictor, expected);
    await rename(temporaryPath, outputPath);
    console.log(`[ML SHADOW] Generated and validated GW${expected.gameweek} feature sidecar.`);
    return { path: outputPath, raw, generated: true };
  } finally {
    await unlink(temporaryPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

async function readAndValidate(
  path: string,
  predictor: LiveFeaturePredictor,
  expected: MlFeatureExpectation
): Promise<string> {
  const size = (await stat(path)).size;
  if (size > MAX_SIDECAR_BYTES) throw new Error(`ML feature sidecar is too large: ${size} bytes`);
  const raw = await readFile(path, 'utf8');
  const sidecar = JSON.parse(raw) as LiveFeatureSidecar;
  validateLiveFeatureSidecar(sidecar, predictor, expected);
  return raw;
}

async function runPythonFeatureGenerator(options: {
  pythonBinary: string;
  scriptPath: string;
  season: string;
  gameweek: number;
  outputPath: string;
  timeoutMs: number;
}): Promise<void> {
  const args = [
    options.scriptPath,
    '--season', options.season,
    '--gameweek', String(options.gameweek),
    '--output', options.outputPath,
    '--overwrite',
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.pythonBinary, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let output = '';
    let outputBytes = 0;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_PROCESS_OUTPUT_BYTES) output += chunk.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ML feature generator: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ML feature generation exceeded ${options.timeoutMs / 1000} seconds`));
        return;
      }
      if (code !== 0) {
        const detail = output.trim().slice(-4000);
        reject(new Error(
          `ML feature generator exited with ${code ?? signal ?? 'unknown status'}${detail ? `: ${detail}` : ''}`
        ));
        return;
      }
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        reject(new Error('ML feature generator produced excessive output'));
        return;
      }
      resolve();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
