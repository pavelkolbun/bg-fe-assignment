export interface AppConfig {
    port: number;
    seed: number;
    players: number;
    bettingS: number;
    minX: number;
    maxX: number;
    dupes: number;
    shuffle: number;
    dropMinS: number;
    dropMaxS: number;
    clockOffsetMs: number;
    rejectRate: number;
    chaos: boolean;
    verbose: boolean;
}

export const CONFIG = Symbol('CONFIG');
export const CLOCK = Symbol('CLOCK');

/** All timestamps (envelope and payload) come from this one helper so the skew is consistent. */
export type Clock = () => number;

export function makeClock(config: AppConfig): Clock {
    const offset = config.chaos ? config.clockOffsetMs : 0;
    return () => Date.now() + offset;
}

export const DEFAULTS: AppConfig = {
    port: 8080,
    seed: 42,
    players: 5000,
    bettingS: 7,
    minX: 1,
    maxX: 100,
    dupes: 0.02,
    shuffle: 0.02,
    dropMinS: 45,
    dropMaxS: 60,
    clockOffsetMs: 120,
    rejectRate: 0.1,
    chaos: true,
    verbose: false,
};

export class ConfigError extends Error {}

interface FlagSpec {
    flag: string;
    env: string;
    key: keyof AppConfig;
    kind: 'int' | 'num' | 'rate' | 'bool' | 'switch';
    help: string;
}

const FLAGS: FlagSpec[] = [
    {
        flag: '--port',
        env: 'PORT',
        key: 'port',
        kind: 'int',
        help: 'WebSocket port (default 8080)',
    },
    { flag: '--seed', env: 'SEED', key: 'seed', kind: 'int', help: 'master RNG seed (default 42)' },
    {
        flag: '--players',
        env: 'PLAYERS',
        key: 'players',
        kind: 'int',
        help: 'simulated bets per round (default 5000)',
    },
    {
        flag: '--betting-s',
        env: 'BETTING_S',
        key: 'bettingS',
        kind: 'int',
        help: 'betting phase length in seconds (default 7) — testing convenience',
    },
    {
        flag: '--min-x',
        env: 'MIN_X',
        key: 'minX',
        kind: 'num',
        help: 'crash floor; scales the whole distribution, >1 disables instant busts (default 1) — testing convenience',
    },
    {
        flag: '--max-x',
        env: 'MAX_X',
        key: 'maxX',
        kind: 'num',
        help: 'crash cap (default 100) — testing convenience',
    },
    {
        flag: '--dupes',
        env: 'DUPES',
        key: 'dupes',
        kind: 'rate',
        help: 'duplicate delivery rate 0..1 (default 0.02)',
    },
    {
        flag: '--shuffle',
        env: 'SHUFFLE',
        key: 'shuffle',
        kind: 'rate',
        help: 'reorder rate 0..1 (default 0.02)',
    },
    {
        flag: '--drop-min',
        env: 'DROP_MIN',
        key: 'dropMinS',
        kind: 'int',
        help: 'forced disconnect, min seconds (default 45)',
    },
    {
        flag: '--drop-max',
        env: 'DROP_MAX',
        key: 'dropMaxS',
        kind: 'int',
        help: 'forced disconnect, max seconds (default 60)',
    },
    {
        flag: '--clock-offset',
        env: 'CLOCK_OFFSET',
        key: 'clockOffsetMs',
        kind: 'int',
        help: 'constant serverTime skew in ms (default 120)',
    },
    {
        flag: '--reject-rate',
        env: 'REJECT_RATE',
        key: 'rejectRate',
        kind: 'rate',
        help: 'random place_bet rejection rate (default 0.1)',
    },
    {
        flag: '--chaos',
        env: 'CHAOS',
        key: 'chaos',
        kind: 'bool',
        help: 'on|off — off disables dupes/reorder/drops and zeroes clock offset (default on)',
    },
    {
        flag: '--verbose',
        env: 'VERBOSE',
        key: 'verbose',
        kind: 'switch',
        help: 'debug-level logging of client commands and chaos events',
    },
];

export function helpText(): string {
    const lines = FLAGS.map(
        (f) =>
            `  ${(f.flag + (f.kind === 'bool' ? ' on|off' : f.kind === 'switch' ? '' : ' <n>')).padEnd(22)} ${f.help}`,
    );
    return [
        'crash-feed-server — hostile mock WebSocket crash-game feed',
        '',
        'Usage: pnpm start [flags]   (env var fallbacks: PORT, SEED, ... — flag wins)',
        '',
        ...lines,
        '  --help                 print this help and exit',
        '',
        'Examples:',
        '  pnpm start --chaos off          clean feed while developing',
        '  pnpm start --seed 7             reproducible run',
    ].join('\n');
}

function parseBool(raw: string, source: string): boolean {
    if (raw === 'on' || raw === 'true' || raw === '1') {
        return true;
    }
    if (raw === 'off' || raw === 'false' || raw === '0') {
        return false;
    }
    throw new ConfigError(`${source}: expected on|off, got "${raw}"`);
}

function parseNumeric(spec: FlagSpec, raw: string, source: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        throw new ConfigError(`${source}: expected a number, got "${raw}"`);
    }
    if (spec.kind === 'int' && !Number.isInteger(n)) {
        throw new ConfigError(`${source}: expected an integer, got "${raw}"`);
    }
    if (spec.kind === 'num' && n <= 0) {
        throw new ConfigError(`${source}: expected a positive number, got "${raw}"`);
    }
    if (spec.kind === 'rate' && (n < 0 || n > 1)) {
        throw new ConfigError(`${source}: expected a rate in [0, 1], got "${raw}"`);
    }
    return n;
}

function parseValue(spec: FlagSpec, raw: string, source: string): number | boolean {
    if (spec.kind === 'switch') {
        return true;
    }
    if (spec.kind === 'bool') {
        return parseBool(raw, source);
    }
    return parseNumeric(spec, raw, source);
}

function applyEnv(config: AppConfig, env: NodeJS.ProcessEnv): void {
    for (const spec of FLAGS) {
        const raw = env[spec.env];
        if (raw !== undefined) {
            (config[spec.key] as number | boolean) = parseValue(spec, raw, `env ${spec.env}`);
        }
    }
}

/** Returns true if --help was requested. */
function applyArgv(config: AppConfig, argv: string[]): boolean {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') {
            continue; // package managers pass it through inconsistently
        }
        if (arg === '--help' || arg === '-h') {
            return true;
        }
        const spec = FLAGS.find((f) => f.flag === arg);
        if (!spec) {
            throw new ConfigError(`unknown flag "${arg}" — try --help`);
        }
        if (spec.kind === 'switch') {
            config.verbose = true;
            continue;
        }
        const raw = argv[++i];
        if (raw === undefined) {
            throw new ConfigError(`${spec.flag}: missing value`);
        }
        (config[spec.key] as number | boolean) = parseValue(spec, raw, spec.flag);
    }
    return false;
}

function validateRanges(config: AppConfig): void {
    if (config.port < 1 || config.port > 65535) {
        throw new ConfigError('--port: must be in 1..65535');
    }
    if (config.players < 1 || config.players > 50000) {
        throw new ConfigError('--players: must be in 1..50000');
    }
    if (config.bettingS < 2 || config.bettingS > 600) {
        throw new ConfigError('--betting-s: must be in 2..600');
    }
    if (config.minX < 1) {
        throw new ConfigError('--min-x: must be >= 1');
    }
    if (config.maxX < config.minX) {
        throw new ConfigError('--max-x: must be >= --min-x');
    }
    if (config.dropMinS < 1) {
        throw new ConfigError('--drop-min: must be >= 1');
    }
    if (config.dropMaxS < config.dropMinS) {
        throw new ConfigError('--drop-max: must be >= --drop-min');
    }
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv = {}): AppConfig | 'help' {
    const config: AppConfig = { ...DEFAULTS };
    applyEnv(config, env);
    if (applyArgv(config, argv)) {
        return 'help';
    }
    validateRanges(config);
    return config;
}

export function banner(config: AppConfig): string {
    const chaos = config.chaos
        ? `ON   dupes ${pct(config.dupes)} · reorder ${pct(config.shuffle)} · drop every ${config.dropMinS}-${config.dropMaxS}s · clock offset +${config.clockOffsetMs}ms`
        : 'OFF  (clean feed; reply latency 200-800ms still applies)';
    return [
        '┌──────────────────────────────────────────────────────────────────────┐',
        '│ crash-feed-server                                                     ',
        `│   ws://localhost:${config.port}                                       `,
        `│   seed ${config.seed} · players ${config.players}/round · reject rate ${pct(config.rejectRate)}`,
        `│   betting ${config.bettingS}s · crash ${config.minX}-${config.maxX}x`,
        `│   chaos ${chaos}`,
        '└──────────────────────────────────────────────────────────────────────┘',
    ].join('\n');
}

function pct(rate: number): string {
    return `${Math.round(rate * 1000) / 10}%`;
}
