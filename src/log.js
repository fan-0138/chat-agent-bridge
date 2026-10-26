/** 极简分级日志：带时间戳，写 stdout/stderr，便于 launchd 收集。 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (stream, name, args) => {
    if (LEVELS[name] < threshold) return;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    stream.write(`${stamp} ${name.toUpperCase().padEnd(5)} ${format(args)}\n`);
  };
  return {
    debug: (...args) => emit(process.stdout, 'debug', args),
    info: (...args) => emit(process.stdout, 'info', args),
    warn: (...args) => emit(process.stderr, 'warn', args),
    error: (...args) => emit(process.stderr, 'error', args),
    level,
  };
}

function format(args) {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}
