import fs from 'fs';
import path from 'path';

export class Logger {
  private static logFilePath: string | null = null;
  private static fileLoggingEnabled: boolean = true;

  private static initialize(): void {
    // Проверяем, отключено ли логирование в файл
    if (process.env.DISABLE_FILE_LOGGING === 'true') {
      this.fileLoggingEnabled = false;
      return;
    }

    // Определяем путь к лог-файлу
    const logFileEnv = process.env.LOG_FILE;
    if (logFileEnv) {
      this.logFilePath = logFileEnv;
    } else {
      // По умолчанию: папка logs в корне проекта
      const logsDir = path.resolve(process.cwd(), 'logs');
      this.logFilePath = path.join(logsDir, 'combined.log');
    }

    // Создаём папку для логов, если её нет
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.error('Failed to create log directory:', err);
        this.fileLoggingEnabled = false;
      }
    }
  }

  private static writeToFile(level: string, message: string, ...args: unknown[]): void {
    if (!this.fileLoggingEnabled || !this.logFilePath) return;

    // Формируем строку лога
    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] [${level}] ${message}`;

    if (args.length > 0) {
      // Добавляем аргументы (если есть)
      const extra = args
        .map(arg => {
          if (arg instanceof Error) {
            return arg.stack || arg.message;
          }
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        })
        .join(' ');
      logLine += ` ${extra}`;
    }

    // Добавляем перевод строки
    logLine += '\n';

    try {
      fs.appendFileSync(this.logFilePath, logLine, 'utf8');
    } catch (err) {
      // Если запись в файл не удалась, выводим ошибку в консоль (но она может зациклиться, поэтому ограничим)
      console.error('Failed to write log to file:', err);
    }
  }

  private static formatTimestamp(): string {
    return new Date().toISOString();
  }

  static info(message: string, ...args: unknown[]): void {
    // Логируем в консоль
    console.log(`[${this.formatTimestamp()}] [INFO] ${message}`, ...args);
    // Логируем в файл
    this.writeToFile('INFO', message, ...args);
  }

  static error(message: string, error?: Error | unknown): void {
    // Логируем в консоль
    console.error(
      `[${this.formatTimestamp()}] [ERROR] ${message}`,
      error instanceof Error ? error.stack : error
    );
    // Логируем в файл
    this.writeToFile('ERROR', message, error);
  }

  static success(message: string, ...args: unknown[]): void {
    console.log(`[${this.formatTimestamp()}] [SUCCESS] ${message}`, ...args);
    this.writeToFile('SUCCESS', message, ...args);
  }

  static warn(message: string, ...args: unknown[]): void {
    console.warn(`[${this.formatTimestamp()}] [WARN] ${message}`, ...args);
    this.writeToFile('WARN', message, ...args);
  }
}

// Инициализация при первом импорте (чтобы создать папку для логов)
Logger['initialize']();