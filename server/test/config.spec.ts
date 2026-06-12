import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, parseConfig } from '../src/config/config';

describe('parseConfig', () => {
    it('returns defaults with no input', () => {
        expect(parseConfig([])).toEqual(DEFAULTS);
    });

    it('parses the testing-convenience flags', () => {
        const config = parseConfig(['--betting-s', '3', '--min-x', '2.5', '--max-x', '500']);
        expect(config).toMatchObject({ bettingS: 3, minX: 2.5, maxX: 500 });
    });

    it('flags win over env vars', () => {
        const config = parseConfig(['--seed', '7'], { SEED: '99', BETTING_S: '10' });
        expect(config).toMatchObject({ seed: 7, bettingS: 10 });
    });

    it('returns "help" for --help and tolerates a bare --', () => {
        expect(parseConfig(['--help'])).toBe('help');
        expect(parseConfig(['--', '--seed', '7'])).toMatchObject({ seed: 7 });
    });

    it('fails fast on invalid values', () => {
        expect(() => parseConfig(['--betting-s', '1'])).toThrow(ConfigError);
        expect(() => parseConfig(['--min-x', '0.5'])).toThrow(ConfigError);
        expect(() => parseConfig(['--min-x', '10', '--max-x', '5'])).toThrow(ConfigError);
        expect(() => parseConfig(['--port', 'nope'])).toThrow(ConfigError);
        expect(() => parseConfig(['--dupes', '1.5'])).toThrow(ConfigError);
        expect(() => parseConfig(['--unknown'])).toThrow(ConfigError);
        expect(() => parseConfig(['--chaos', 'maybe'])).toThrow(ConfigError);
    });
});
