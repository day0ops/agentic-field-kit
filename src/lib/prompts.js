import inquirer from 'inquirer';
import chalk from 'chalk';
import readline from 'readline';
import fs from 'fs';
import tty from 'tty';

export const WINDOW_THRESHOLD = 30;
export const MAX_VIEWPORT_SIZE = 25;

/**
 * How many terminal rows fit on screen at once, leaving room for header/footer
 * chrome. Capped at MAX_VIEWPORT_SIZE even on a tall terminal, so a long list
 * always reads as a scrollable window rather than a wall of text.
 * @param {number} totalLines - total number of rendered lines that could be shown
 * @param {number} terminalRows - process.stdout.rows (may be undefined/0 off-TTY)
 * @param {number} overhead - lines reserved for header/footer/scroll indicators
 * @returns {number}
 */
export function computeViewportSize(totalLines, terminalRows, overhead) {
  const available = Math.max(10, (terminalRows || 24) - overhead);
  return Math.min(totalLines, available, MAX_VIEWPORT_SIZE);
}

/**
 * Edge-scrolled window offset: only moves when the active line would otherwise
 * leave the visible window, rather than recentering on every keystroke.
 * @param {number} scrollTop - current window start (a line offset)
 * @param {number} activeLine - line offset the pointer's item now starts at
 * @param {number} totalLines - total number of rendered lines
 * @param {number} viewportSize - number of lines visible at once
 * @returns {number}
 */
export function computeScrollTop(scrollTop, activeLine, totalLines, viewportSize) {
  if (totalLines <= viewportSize) return 0;
  let next = scrollTop;
  if (activeLine < next) {
    next = activeLine;
  } else if (activeLine > next + viewportSize - 1) {
    next = activeLine - viewportSize + 1;
  }
  return Math.max(0, Math.min(next, totalLines - viewportSize));
}

/**
 * Wait for the user to press Space or Enter before continuing.
 * No-ops when stdin is not a TTY (e.g. CI environments).
 */
export function waitForKey() {
  return new Promise(resolve => {
    let stdin = process.stdin;
    let ttyStream = null;

    if (!stdin.isTTY) {
      try {
        const fd = fs.openSync('/dev/tty', 'r');
        ttyStream = new tty.ReadStream(fd);
        stdin = ttyStream;
      } catch {
        return resolve();
      }
    }

    const close = () => {
      process.stdout.write('\x1B[?25h');
      stdin.removeListener('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      if (ttyStream) {
        try {
          ttyStream.close();
        } catch {
          /* best effort */
        }
      }
      resolve();
    };

    const onKey = (_ch, key) => {
      if (!key) return;
      if (key.name === 'space' || key.name === 'return') {
        close();
      } else if (key.name === 'c' && key.ctrl) {
        close();
        process.exit(0);
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write('\x1B[?25l');
    stdin.on('keypress', onKey);
  });
}

/**
 * Prompt utilities for interactive CLI
 */
export class Prompts {
  /**
   * Raw-mode list selector.
   * ↑/↓ to navigate, Enter to select, Esc/Backspace to go back (when allowBack is true).
   * @param {string} message - The prompt message
   * @param {Array} choices - List of choices (may include inquirer.Separator instances)
   * @param {object} opts
   * @param {boolean} opts.allowBack - Enable Esc/Backspace to trigger a "back" action
   * @param {number} opts.defaultIndex - Initial pointer position (index into selectable items)
   * @returns {Promise<{value: *, back: boolean}>}
   */
  static _rawSelect(message, choices, { allowBack = false, defaultIndex = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const stdout = process.stdout;
      let stdin = process.stdin;
      let ttyStream = null;

      if (!stdin.isTTY) {
        try {
          const fd = fs.openSync('/dev/tty', 'r');
          ttyStream = new tty.ReadStream(fd);
          stdin = ttyStream;
        } catch {
          const selectable = choices.filter(
            c => !(c instanceof inquirer.Separator) && c.type !== 'separator'
          );
          const listing = selectable.map(c => `  - ${c.value}`).join('\n');
          reject(
            new Error(
              `Interactive prompt requires a TTY.\n` +
                `Available options:\n${listing}\n` +
                `Specify explicitly with -p <name> or PROFILE=<name>`
            )
          );
          return;
        }
      }

      const selectable = [];
      choices.forEach(c => {
        if (!(c instanceof inquirer.Separator) && c.type !== 'separator') {
          selectable.push(c);
        }
      });

      // Maps a selectable-array index to its position within `choices`, so the
      // window can be computed over the full list (keeping separators attached
      // to their group) while the pointer still only ever indexes `selectable`.
      const choiceIndexOf = [];
      {
        let si = 0;
        choices.forEach((c, i) => {
          if (!(c instanceof inquirer.Separator) && c.type !== 'separator') {
            choiceIndexOf[si] = i;
            si++;
          }
        });
      }

      let pointer = Math.min(defaultIndex, selectable.length - 1);
      let linesRendered = 0;
      let scrollTop = 0;
      const windowed = selectable.length > WINDOW_THRESHOLD;

      const cols = stdout.columns || 80;
      const maxLabel = cols - 4;
      // prefixLen accounts for characters rendered before the text itself (e.g. the "    • "
      // bullet prefix on description lines) so the full rendered line — prefix included — never
      // exceeds one terminal row. A line that wraps would desync `linesRendered` from the actual
      // number of visual rows on screen, corrupting every redraw's cursor-up escape sequence.
      const fit = (text, prefixLen = 0) => {
        const clean = text.replace(/[\r\n]+/g, ' ').trim();
        const budget = Math.max(1, maxLabel - prefixLen);
        if (clean.length <= budget) return clean;
        return clean.slice(0, budget - 1) + '…';
      };

      const render = () => {
        if (linesRendered > 0) {
          stdout.write(`\x1B[${linesRendered}A\x1B[0J`);
        }

        // Each choice can render as more than one terminal row (a name line
        // plus any description bullet lines), so windowing has to operate on
        // actual rendered rows, not on the `choices` array index. Otherwise a
        // window of N choices with long descriptions could still overflow the
        // terminal. Build the plain (uncolored) row content once per choice
        // before deciding which rows fall inside the viewport.
        const rowsFor = choices.map(choice => {
          if (choice instanceof inquirer.Separator || choice.type === 'separator') {
            return [{ kind: 'sep' }];
          }
          const rows = [{ kind: 'name', text: fit(choice.name) }];
          if (choice.description) {
            const descLines = choice.description.trim().split('\n');
            for (const dl of descLines) {
              const descText = fit(dl.trim(), 6); // 6 = '    • '.length
              if (descText) rows.push({ kind: 'desc', text: descText });
            }
          }
          return rows;
        });

        const rowOffsetOf = []; // choices-index -> starting row offset
        let totalRows = 0;
        rowsFor.forEach((rows, i) => {
          rowOffsetOf[i] = totalRows;
          totalRows += rows.length;
        });

        const lines = [];
        lines.push(
          chalk.green('?') +
            ' ' +
            chalk.bold(message) +
            chalk.yellow('  (enter/space to select' + (allowBack ? ', esc to go back' : '') + ')')
        );

        let viewStart = 0;
        let viewEnd = totalRows;
        if (windowed) {
          const viewportSize = computeViewportSize(totalRows, stdout.rows, 4);
          const activeLine = rowOffsetOf[choiceIndexOf[pointer]];
          scrollTop = computeScrollTop(scrollTop, activeLine, totalRows, viewportSize);
          viewStart = scrollTop;
          viewEnd = Math.min(totalRows, scrollTop + viewportSize);
          if (viewStart > 0) lines.push(chalk.dim(`  ↑ ${viewStart} more above`));
        }

        let itemIdx = 0;
        for (let i = 0; i < choices.length; i++) {
          const rows = rowsFor[i];
          const start = rowOffsetOf[i];
          const isSeparator = rows[0].kind === 'sep';
          const active = itemIdx === pointer;
          for (let ri = 0; ri < rows.length; ri++) {
            const rowNo = start + ri;
            if (rowNo < viewStart || rowNo >= viewEnd) continue;
            const row = rows[ri];
            if (row.kind === 'sep') {
              lines.push(chalk.dim(' ────────────────'));
            } else if (row.kind === 'name') {
              const prefix = active ? chalk.cyan('❯') : ' ';
              const label = active ? chalk.cyan(row.text) : row.text;
              lines.push(`${prefix} ${label}`);
            } else {
              lines.push(
                active ? chalk.dim.cyan(`    • ${row.text}`) : chalk.dim(`    • ${row.text}`)
              );
            }
          }
          if (!isSeparator) itemIdx++;
        }

        if (windowed && viewEnd < totalRows) {
          lines.push(chalk.dim(`  ↓ ${totalRows - viewEnd} more below`));
        }

        stdout.write(lines.join('\n') + '\n');
        linesRendered = lines.length;
      };

      const closeTty = () => {
        if (ttyStream) {
          try {
            ttyStream.close();
          } catch {
            /* best effort */
          }
        }
      };

      const finish = (value, back) => {
        if (linesRendered > 0) {
          stdout.write(`\x1B[${linesRendered}A\x1B[0J`);
        }
        if (!back) {
          const item = selectable[pointer];
          const confirmText = fit(item?.short || item?.name || '');
          stdout.write(
            chalk.green('✔') + ' ' + chalk.bold(message) + ' ' + chalk.cyan(confirmText) + '\n'
          );
        }
        stdout.write('\x1B[?25h');
        stdin.removeListener('keypress', onKeypress);
        stdin.setRawMode(false);
        stdin.pause();
        closeTty();
        resolve({ value, back });
      };

      const onKeypress = (_ch, key) => {
        if (!key) return;

        if (key.name === 'up') {
          pointer = (pointer - 1 + selectable.length) % selectable.length;
          render();
        } else if (key.name === 'down') {
          pointer = (pointer + 1) % selectable.length;
          render();
        } else if (key.name === 'return' || key.name === 'space') {
          finish(selectable[pointer].value, false);
        } else if (allowBack && (key.name === 'escape' || key.name === 'backspace')) {
          finish(null, true);
        } else if (key.name === 'c' && key.ctrl) {
          stdout.write('\x1B[?25h');
          stdin.removeListener('keypress', onKeypress);
          stdin.setRawMode(false);
          stdin.pause();
          closeTty();
          process.exit(0);
        }
      };

      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdout.write('\x1B[?25l');
      stdin.on('keypress', onKeypress);
      render();
    });
  }

  /**
   * Prompt user to select from a list of options
   * @param {string} message - The prompt message
   * @param {Array<{name: string, value: string, description?: string}>} choices - List of choices
   * @param {string} defaultValue - Default selection
   * @returns {Promise<string>} Selected value
   */
  static async select(message, choices, defaultValue = null) {
    const selectable = choices.filter(
      c => !(c instanceof inquirer.Separator) && c.type !== 'separator'
    );
    let defaultIndex = 0;
    if (defaultValue != null) {
      const idx = selectable.findIndex(c => c.value === defaultValue);
      if (idx >= 0) defaultIndex = idx;
    }
    const { value } = await this._rawSelect(message, choices, { defaultIndex });
    return value;
  }

  /**
   * Confirm an action with the user
   * @param {string} message - The confirmation message
   * @param {boolean} defaultValue - Default answer (true/false)
   * @returns {Promise<boolean>} User's confirmation
   */
  static async confirm(message, defaultValue = false) {
    const answer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message,
        default: defaultValue,
      },
    ]);

    return answer.confirmed;
  }

  /**
   * Prompt for text input
   * @param {string} message - The prompt message
   * @param {string} defaultValue - Default value
   * @param {Function} validate - Validation function
   * @returns {Promise<string>} User's input
   */
  static async input(message, defaultValue = '', validate = null) {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'value',
        message,
        default: defaultValue,
        validate: validate || (() => true),
      },
    ]);

    return answer.value;
  }

  /**
   * Prompt user to select multiple items from a list
   * @param {string} message - The prompt message
   * @param {Array<{name: string, value: string, checked?: boolean}>} choices - List of choices
   * @returns {Promise<Array<string>>} Selected values
   */
  static async multiSelect(message, choices) {
    const answer = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selections',
        message,
        choices,
        pageSize: 10,
      },
    ]);

    return answer.selections;
  }

  /**
   * Prompt for password input (hidden)
   * @param {string} message - The prompt message
   * @returns {Promise<string>} User's password
   */
  static async password(message) {
    const answer = await inquirer.prompt([
      {
        type: 'password',
        name: 'value',
        message,
      },
    ]);

    return answer.value;
  }

  /**
   * Recursive tree selector: navigate through nested categories to pick a leaf item.
   * Esc/Backspace returns to the parent level.
   *
   * Tree nodes can be branches or leaves:
   *   Branch: { label: string, value?: string, children: Array<branch|leaf> }
   *   Leaf:   { name: string, value: string }
   *
   * @param {string} message - Prompt shown at the top level
   * @param {Array} tree - Array of branch/leaf nodes
   * @returns {Promise<string>} The selected leaf value
   */
  static async selectTree(message, tree) {
    const BACK = Symbol('back');

    const isBranch = node => Array.isArray(node.children);

    const countLeaves = nodes => {
      let total = 0;
      for (const n of nodes) {
        total += isBranch(n) ? countLeaves(n.children) : 1;
      }
      return total;
    };

    const navigate = async (nodes, prompt, allowBack) => {
      while (true) {
        const choices = nodes.map(node => {
          if (isBranch(node)) {
            const count = countLeaves(node.children);
            return {
              name: `${node.label} ${chalk.dim(`(${count})`)}`,
              value: node.value ?? node.label,
              short: node.label,
            };
          }
          return { name: node.name, value: node.value, short: node.value };
        });

        if (allowBack) {
          choices.push(new inquirer.Separator());
          choices.push({ name: chalk.dim('← Back'), value: BACK });
        }

        const { value: selected, back } = await this._rawSelect(prompt, choices, { allowBack });

        if (back || selected === BACK) return null;

        const selectedNode = nodes.find(n => (n.value ?? n.label) === selected);

        if (selectedNode && isBranch(selectedNode)) {
          const result = await navigate(
            selectedNode.children,
            `Select from ${chalk.cyan(selectedNode.label)}:`,
            true
          );
          if (result !== null) return result;
          continue;
        }

        return selected;
      }
    };

    return navigate(tree, message, false);
  }
}
