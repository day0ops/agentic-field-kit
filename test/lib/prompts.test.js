import { test, expect, describe } from 'bun:test';
import inquirer from 'inquirer';
import { Prompts } from '../../src/lib/prompts.js';

// `_rawMultiSelect` only checks that stdin/stdout look TTY-like, so a non-TTY
// test process can drive its real keypress handler by faking those bits and
// emitting synthetic 'keypress' events.
function buildChoices(count) {
  const choices = [];
  for (let i = 0; i < count; i++) {
    choices.push({ name: `item-${i}`, value: `v${i}` });
  }
  return choices;
}

function typeString(str) {
  for (const ch of str) {
    process.stdin.emit('keypress', ch, { name: ch, sequence: ch });
  }
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex -- intentionally matches ANSI escape sequences
  return str.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Runs `_rawMultiSelect` with stdin/stdout faked as a TTY, capturing every
 * `stdout.write` chunk. Restores the real stdin/stdout methods afterwards
 * even if the body throws, so no state leaks into other tests.
 * @param {Array} choices
 * @param {Function} drive - called once the prompt has rendered; emits keypresses
 * @returns {Promise<{result: *, chunks: string[]}>}
 */
async function runMultiSelect(choices, drive) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  const original = {
    isTTY: stdin.isTTY,
    setRawMode: stdin.setRawMode,
    resume: stdin.resume,
    pause: stdin.pause,
    rows: stdout.rows,
    write: stdout.write,
  };

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdout.rows = 40;

  const chunks = [];
  stdout.write = chunk => {
    chunks.push(chunk.toString());
    return true;
  };

  try {
    const promise = Prompts._rawMultiSelect('Pick stuff', choices);
    setImmediate(() => drive());
    const result = await promise;
    return { result, chunks };
  } finally {
    stdin.isTTY = original.isTTY;
    stdin.setRawMode = original.setRawMode;
    stdin.resume = original.resume;
    stdin.pause = original.pause;
    stdout.rows = original.rows;
    stdout.write = original.write;
    // Belt-and-braces: guarantee no stray keypress listener survives into
    // the next test, regardless of whether _rawMultiSelect's own cleanup ran.
    stdin.removeAllListeners('keypress');
  }
}

describe('_rawMultiSelect basic behavior', () => {
  test('space toggles the highlighted item and enter resolves it', async () => {
    const choices = buildChoices(5);

    const { result } = await runMultiSelect(choices, () => {
      process.stdin.emit('keypress', undefined, { name: 'down' });
      process.stdin.emit('keypress', undefined, { name: 'space' });
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    expect(result).toEqual(['v1']);
  });

  test('renders a separator label in the grouped (unfiltered) view', async () => {
    const choices = [
      new inquirer.Separator('MY CATEGORY'),
      { name: 'item-0', value: 'v0' },
      { name: 'item-1', value: 'v1' },
    ];

    const { chunks } = await runMultiSelect(choices, () => {
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    const plain = chunks.map(stripAnsi).join('');
    expect(plain).toContain('MY CATEGORY');
  });

  test('typing a filter then toggling a match resolves the correct value', async () => {
    const choices = buildChoices(35); // > WINDOW_THRESHOLD, so filtering is active

    const { result } = await runMultiSelect(choices, () => {
      typeString('item-12');
      process.stdin.emit('keypress', undefined, { name: 'space' });
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    expect(result).toEqual(['v12']);
  });
});

describe('_rawMultiSelect keypress filter-leak fix', () => {
  test('space does not leak into the filter when the current filter matches nothing', async () => {
    const choices = buildChoices(35);

    const { result, chunks } = await runMultiSelect(choices, () => {
      typeString('zzz');
      process.stdin.emit('keypress', undefined, { name: 'space' });
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    expect(result).toEqual([]);

    const filterLines = chunks.filter(c => /Filter: zzz/.test(c));
    expect(filterLines.length).toBeGreaterThan(0);
    for (const chunk of filterLines) {
      expect(chunk).not.toMatch(/Filter: zzz /);
    }
  });

  test('backspace does not leak into the filter when the query is already empty', async () => {
    const choices = buildChoices(35);

    const { result, chunks } = await runMultiSelect(choices, () => {
      process.stdin.emit('keypress', '\b', { name: 'backspace' });
      process.stdin.emit('keypress', undefined, { name: 'return' });
    });

    expect(result).toEqual([]);

    for (const chunk of chunks) {
      const plain = stripAnsi(chunk);
      const filterLine = plain.split('\n').find(line => line.includes('Filter:'));
      if (filterLine) {
        expect(filterLine).not.toContain('\b');
      }
    }
  });
});
