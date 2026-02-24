/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deep clone an object using JSON serialization
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Logger interface for consistent logging
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/**
 * Console logger implementation
 */
export class ConsoleLogger implements Logger {
  constructor(private verbose: boolean = false) {}

  info(message: string): void {
    console.log(message);
  }

  warn(message: string): void {
    console.warn(message);
  }

  error(message: string): void {
    console.error(message);
  }

  debug(message: string): void {
    if (this.verbose) {
      console.log(`[DEBUG] ${message}`);
    }
  }
}

/**
 * Silent logger that suppresses all output
 */
export class SilentLogger implements Logger {
  info(_message: string): void {}
  warn(_message: string): void {}
  error(_message: string): void {}
  debug(_message: string): void {}
}
